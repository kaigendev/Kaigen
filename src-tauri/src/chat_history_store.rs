use crate::{profiles, ToxMessage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const STORE_VERSION: u32 = 1;
const CHUNK_ROWS: usize = 256;
const DEFAULT_WINDOW_ROWS: usize = 500;
const MAX_WINDOW_ROWS: usize = 1_000;
const MAX_PAGE_ROWS: usize = 256;
const MAX_SEARCH_ROWS: usize = 100;
const MAX_WINDOW_COST: usize = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const WORKING_USER_TAIL: usize = 50;
const WORKING_SPECIAL_TAIL: usize = 32;
const ID_BLOOM_BYTES: usize = 256;
const ID_BLOOM_HASHES: usize = 6;
const MAX_ACTIVE_READERS_PER_STORE: usize = 16;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreManifest {
    version: u32,
    generation: u64,
    chunk_rows: usize,
    contacts: Vec<ContactManifest>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContactManifest {
    friend_number: u32,
    #[serde(default)]
    friend_public_key: String,
    #[serde(default = "initial_revision")]
    revision: u64,
    #[serde(default = "initial_revision")]
    search_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_event: Option<u64>,
    total: usize,
    chunks: Vec<ChunkManifest>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkManifest {
    file: String,
    rows: usize,
    user_rows: usize,
    special_rows: usize,
    id_bloom: String,
    sha256: String,
}

#[derive(Clone)]
struct RegisteredStore {
    root: PathBuf,
    manifest: StoreManifest,
    reclamation: Arc<Mutex<ReaderReclamation>>,
}

#[derive(Default)]
struct ReaderReclamation {
    active_readers: usize,
    file_readers: HashMap<String, usize>,
    retired_files: HashSet<String>,
}

struct RegisteredStoreReader {
    store: RegisteredStore,
    files: Vec<String>,
}

impl Deref for RegisteredStoreReader {
    type Target = RegisteredStore;

    fn deref(&self) -> &Self::Target {
        &self.store
    }
}

impl Drop for RegisteredStoreReader {
    fn drop(&mut self) {
        let cleanup = {
            let Ok(mut reclamation) = self.store.reclamation.lock() else {
                return;
            };
            reclamation.active_readers = reclamation.active_readers.saturating_sub(1);
            let mut cleanup = Vec::new();
            for file in &self.files {
                if let Some(readers) = reclamation.file_readers.get_mut(file) {
                    *readers = readers.saturating_sub(1);
                    if *readers == 0 {
                        reclamation.file_readers.remove(file);
                        if reclamation.retired_files.remove(file) {
                            cleanup.push(file.clone());
                        }
                    }
                }
            }
            cleanup
        };
        cleanup_files(&self.store.root, cleanup);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryWindow {
    pub(super) messages: Vec<ToxMessage>,
    pub(super) total: usize,
    pub(super) window_start: usize,
    pub(super) target_index: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryPage {
    pub(super) messages: Vec<ToxMessage>,
    pub(super) total: usize,
    pub(super) offset: usize,
    pub(super) next_offset: usize,
    pub(super) has_more: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistorySearchResult {
    pub(super) message_id: String,
    pub(super) index: usize,
    pub(super) field: String,
    pub(super) start: u32,
    pub(super) end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) snippet: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistorySearchPage {
    pub(super) matches: Vec<HistorySearchResult>,
    pub(super) next_cursor: Option<String>,
    pub(super) revision: u64,
}

#[derive(Default)]
struct IncomingGroup {
    existing_index: Option<usize>,
    friend_number: u32,
    friend_public_key: String,
    messages: Vec<ToxMessage>,
    positions: HashMap<String, usize>,
}

#[derive(Default)]
struct ContactRows {
    friend_number: u32,
    friend_public_key: String,
    messages: Vec<ToxMessage>,
}

#[derive(Clone, Copy)]
struct SearchCursor {
    search_epoch: u64,
    snapshot_end: usize,
    index: usize,
    skip: usize,
}

const fn initial_revision() -> u64 {
    1
}

static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, RegisteredStore>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<PathBuf, RegisteredStore>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn registered_reader(history_path: &Path) -> Result<RegisteredStoreReader, String> {
    let stores = registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?;
    let store = stores
        .get(history_path)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())?;
    let files = referenced_files(&store.manifest)
        .into_iter()
        .collect::<Vec<_>>();
    {
        let mut reclamation = store
            .reclamation
            .lock()
            .map_err(|_| "CHAT_HISTORY_READER_LOCK_POISONED".to_string())?;
        if reclamation.active_readers >= MAX_ACTIVE_READERS_PER_STORE {
            return Err("CHAT_HISTORY_READER_CAPACITY".to_string());
        }
        reclamation.active_readers = reclamation.active_readers.saturating_add(1);
        for file in &files {
            *reclamation.file_readers.entry(file.clone()).or_default() += 1;
        }
    }
    Ok(RegisteredStoreReader {
        store: store.clone(),
        files,
    })
}

fn retire_files(store: &RegisteredStore, files: impl IntoIterator<Item = String>) {
    let mut immediate = Vec::new();
    let Ok(mut reclamation) = store.reclamation.lock() else {
        return;
    };
    for file in files {
        if reclamation.file_readers.contains_key(&file) {
            reclamation.retired_files.insert(file);
        } else {
            immediate.push(file);
        }
    }
    drop(reclamation);
    cleanup_files(&store.root, immediate);
}

fn store_root(history_path: &Path) -> Result<PathBuf, String> {
    let parent = history_path
        .parent()
        .ok_or_else(|| "CHAT_HISTORY_PATH_INVALID".to_string())?;
    let stem = history_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("chat-history");
    Ok(parent.join(format!("{stem}.chunks")))
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.json")
}

fn identity_matches(
    record_number: u32,
    record_key: &str,
    friend_number: u32,
    friend_public_key: &str,
) -> bool {
    if !record_key.is_empty() && !friend_public_key.is_empty() {
        record_key.eq_ignore_ascii_case(friend_public_key)
    } else {
        record_number == friend_number
    }
}

fn identity_token(friend_number: u32, friend_public_key: &str) -> String {
    if friend_public_key.is_empty() {
        format!("number:{friend_number}")
    } else {
        format!("key:{}", friend_public_key.to_ascii_uppercase())
    }
}

fn contact_slug(friend_number: u32, friend_public_key: &str) -> String {
    sha256_hex(identity_token(friend_number, friend_public_key).as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn safe_chunk_path(root: &Path, file: &str) -> Result<PathBuf, String> {
    let path = Path::new(file);
    if file.is_empty()
        || path.is_absolute()
        || path
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty())
        || !file.starts_with("chunk-")
        || !file.ends_with(".json")
        || !file
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("CHAT_HISTORY_CHUNK_PATH_INVALID".to_string());
    }
    Ok(root.join(file))
}

fn validate_manifest(manifest: &StoreManifest) -> Result<(), String> {
    if manifest.version != STORE_VERSION || manifest.chunk_rows != CHUNK_ROWS {
        return Err("CHAT_HISTORY_MANIFEST_VERSION_UNSUPPORTED".to_string());
    }
    if manifest.generation == 0 {
        return Err("CHAT_HISTORY_MANIFEST_INVALID".to_string());
    }
    let mut identities = HashSet::new();
    let mut files = HashSet::new();
    for contact in &manifest.contacts {
        if !identities.insert(identity_token(
            contact.friend_number,
            &contact.friend_public_key,
        )) {
            return Err("CHAT_HISTORY_MANIFEST_DUPLICATE_CONTACT".to_string());
        }
        if contact.revision == 0 || contact.search_epoch == 0 {
            return Err("CHAT_HISTORY_MANIFEST_INVALID_CONTACT_REVISION".to_string());
        }
        let mut total = 0usize;
        for chunk in &contact.chunks {
            if chunk.rows == 0
                || chunk.rows > CHUNK_ROWS
                || chunk.user_rows > chunk.rows
                || chunk.special_rows > chunk.rows
                || chunk.id_bloom.len() != ID_BLOOM_BYTES * 2
                || !chunk.id_bloom.bytes().all(|byte| byte.is_ascii_hexdigit())
                || chunk.sha256.len() != 64
                || !chunk.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("CHAT_HISTORY_MANIFEST_INVALID_CHUNK".to_string());
            }
            safe_chunk_path(Path::new("."), &chunk.file)?;
            if !files.insert(chunk.file.clone()) {
                return Err("CHAT_HISTORY_MANIFEST_DUPLICATE_CHUNK".to_string());
            }
            total = total
                .checked_add(chunk.rows)
                .ok_or_else(|| "CHAT_HISTORY_MANIFEST_OVERFLOW".to_string())?;
        }
        if total != contact.total || (contact.total == 0 && !contact.chunks.is_empty()) {
            return Err("CHAT_HISTORY_MANIFEST_COUNT_MISMATCH".to_string());
        }
    }
    Ok(())
}

fn load_manifest(root: &Path) -> Result<StoreManifest, String> {
    let bytes = profiles::read_file(&manifest_path(root))
        .map_err(|_| "CHAT_HISTORY_MANIFEST_READ_FAILED".to_string())?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("CHAT_HISTORY_MANIFEST_TOO_LARGE".to_string());
    }
    let manifest = serde_json::from_slice::<StoreManifest>(&bytes)
        .map_err(|_| "CHAT_HISTORY_MANIFEST_DECODE_FAILED".to_string())?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn write_manifest(root: &Path, manifest: &StoreManifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    profiles::create_dir_all(root).map_err(|_| "CHAT_HISTORY_STORE_CREATE_FAILED".to_string())?;
    let bytes = serde_json::to_vec(manifest)
        .map_err(|_| "CHAT_HISTORY_MANIFEST_ENCODE_FAILED".to_string())?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("CHAT_HISTORY_MANIFEST_TOO_LARGE".to_string());
    }
    profiles::atomic_write(&manifest_path(root), &bytes)
        .map_err(|_| "CHAT_HISTORY_MANIFEST_WRITE_FAILED".to_string())
}

fn read_chunk(
    root: &Path,
    contact: &ContactManifest,
    chunk: &ChunkManifest,
) -> Result<Vec<ToxMessage>, String> {
    let path = safe_chunk_path(root, &chunk.file)?;
    let bytes =
        profiles::read_file(&path).map_err(|_| "CHAT_HISTORY_CHUNK_READ_FAILED".to_string())?;
    if sha256_hex(&bytes) != chunk.sha256 {
        return Err("CHAT_HISTORY_CHUNK_DIGEST_MISMATCH".to_string());
    }
    let rows = serde_json::from_slice::<Vec<ToxMessage>>(&bytes)
        .map_err(|_| "CHAT_HISTORY_CHUNK_DECODE_FAILED".to_string())?;
    if rows.len() != chunk.rows
        || rows
            .iter()
            .filter(|message| message.event.is_none())
            .count()
            != chunk.user_rows
        || rows
            .iter()
            .filter(|message| message.event.is_some() || message.attachment.is_some())
            .count()
            != chunk.special_rows
        || id_bloom(&rows) != chunk.id_bloom
        || rows.iter().any(|message| {
            message.id.is_empty()
                || !identity_matches(
                    contact.friend_number,
                    &contact.friend_public_key,
                    message.friend_number,
                    &message.friend_public_key,
                )
        })
    {
        return Err("CHAT_HISTORY_CHUNK_CONTENT_INVALID".to_string());
    }
    Ok(rows)
}

fn write_chunk(
    root: &Path,
    contact: &ContactManifest,
    generation: u64,
    index: usize,
    rows: &[ToxMessage],
) -> Result<ChunkManifest, String> {
    if rows.is_empty() || rows.len() > CHUNK_ROWS {
        return Err("CHAT_HISTORY_CHUNK_ROW_COUNT_INVALID".to_string());
    }
    let bytes =
        serde_json::to_vec(rows).map_err(|_| "CHAT_HISTORY_CHUNK_ENCODE_FAILED".to_string())?;
    let digest = sha256_hex(&bytes);
    let slug = contact_slug(contact.friend_number, &contact.friend_public_key);
    let file = format!(
        "chunk-{slug}-{generation:016x}-{index:08x}-{}.json",
        &digest[..16]
    );
    let path = safe_chunk_path(root, &file)?;
    profiles::atomic_write(&path, &bytes)
        .map_err(|_| "CHAT_HISTORY_CHUNK_WRITE_FAILED".to_string())?;
    Ok(ChunkManifest {
        file,
        rows: rows.len(),
        user_rows: rows
            .iter()
            .filter(|message| message.event.is_none())
            .count(),
        special_rows: rows
            .iter()
            .filter(|message| message.event.is_some() || message.attachment.is_some())
            .count(),
        id_bloom: id_bloom(rows),
        sha256: digest,
    })
}

fn id_bloom(rows: &[ToxMessage]) -> String {
    let mut bloom = [0u8; ID_BLOOM_BYTES];
    for message in rows {
        let digest = Sha256::digest(message.id.as_bytes());
        for pair in digest[..ID_BLOOM_HASHES * 2].chunks_exact(2) {
            let bit = u16::from_be_bytes([pair[0], pair[1]]) as usize % (bloom.len() * 8);
            bloom[bit / 8] |= 1 << (bit % 8);
        }
    }
    let mut encoded = String::with_capacity(bloom.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bloom {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn bloom_may_contain(encoded: &str, message_id: &str) -> bool {
    if encoded.len() != ID_BLOOM_BYTES * 2 {
        return true;
    }
    let mut bloom = [0u8; ID_BLOOM_BYTES];
    for (index, slot) in bloom.iter_mut().enumerate() {
        let start = index * 2;
        let Ok(byte) = u8::from_str_radix(&encoded[start..start + 2], 16) else {
            return true;
        };
        *slot = byte;
    }
    let digest = Sha256::digest(message_id.as_bytes());
    digest[..ID_BLOOM_HASHES * 2].chunks_exact(2).all(|pair| {
        let bit = u16::from_be_bytes([pair[0], pair[1]]) as usize % (bloom.len() * 8);
        bloom[bit / 8] & (1 << (bit % 8)) != 0
    })
}

fn chunk_may_contain_any<'a>(chunk: &ChunkManifest, ids: impl Iterator<Item = &'a String>) -> bool {
    ids.into_iter()
        .any(|message_id| bloom_may_contain(&chunk.id_bloom, message_id))
}

fn verify_store(root: &Path, manifest: &StoreManifest) -> Result<Vec<Option<u64>>, String> {
    validate_manifest(manifest)?;
    let mut last_events = Vec::with_capacity(manifest.contacts.len());
    for contact in &manifest.contacts {
        let mut total = 0usize;
        let mut ids = HashSet::new();
        let mut last_event = None::<u64>;
        for chunk in &contact.chunks {
            let rows = read_chunk(root, contact, chunk)?;
            for row in &rows {
                if !ids.insert(row.id.clone()) {
                    return Err("CHAT_HISTORY_DUPLICATE_MESSAGE_ID".to_string());
                }
                last_event = Some(last_event.unwrap_or(0).max(row.timestamp));
            }
            total = total.saturating_add(rows.len());
        }
        if total != contact.total {
            return Err("CHAT_HISTORY_MANIFEST_COUNT_MISMATCH".to_string());
        }
        last_events.push(last_event);
    }
    Ok(last_events)
}

fn load_verified_manifest(root: &Path) -> Result<StoreManifest, String> {
    let mut manifest = load_manifest(root)?;
    let last_events = verify_store(root, &manifest)?;
    let mut summary_changed = false;
    for (contact, last_event) in manifest.contacts.iter_mut().zip(last_events) {
        if contact.last_event != last_event {
            contact.last_event = last_event;
            summary_changed = true;
        }
    }
    if summary_changed {
        // Version-1 manifests predate the compact activity summary. Verification
        // already streams one bounded chunk at a time, so reuse those maxima and
        // repair the manifest atomically without materializing full histories.
        write_manifest(root, &manifest)?;
    }
    Ok(manifest)
}

fn read_legacy_history(history_path: &Path) -> Result<Vec<ToxMessage>, String> {
    let bytes = profiles::read_file(history_path)
        .map_err(|_| "CHAT_HISTORY_LEGACY_READ_FAILED".to_string())?;
    serde_json::from_slice::<Vec<ToxMessage>>(&bytes)
        .map_err(|_| "CHAT_HISTORY_LEGACY_DECODE_FAILED".to_string())
}

fn referenced_files(manifest: &StoreManifest) -> HashSet<String> {
    manifest
        .contacts
        .iter()
        .flat_map(|contact| contact.chunks.iter().map(|chunk| chunk.file.clone()))
        .collect()
}

fn cleanup_files(root: &Path, files: impl IntoIterator<Item = String>) {
    for file in files {
        if let Ok(path) = safe_chunk_path(root, &file) {
            let _ = profiles::remove_file(&path);
        }
    }
}

fn cleanup_orphan_chunks(root: &Path, manifest: &StoreManifest) {
    let keep = referenced_files(manifest);
    let Ok(entries) = profiles::list(root) else {
        return;
    };
    cleanup_files(
        root,
        entries.into_iter().filter_map(|entry| {
            let file = entry.path.file_name()?.to_str()?.to_string();
            (entry.is_file
                && file.starts_with("chunk-")
                && file.ends_with(".json")
                && !keep.contains(&file))
            .then_some(file)
        }),
    );
}

fn normalized_legacy_messages(mut messages: Vec<ToxMessage>) -> Vec<ToxMessage> {
    let reserved = messages
        .iter()
        .filter(|message| !message.id.is_empty())
        .map(|message| message.id.clone())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    for (ordinal, message) in messages.iter_mut().enumerate() {
        if message.id.is_empty() || !seen.insert(message.id.clone()) {
            let base = format!("legacy-{ordinal:016x}");
            let mut candidate = base.clone();
            let mut suffix = 0usize;
            while reserved.contains(&candidate) || seen.contains(&candidate) {
                suffix = suffix.saturating_add(1);
                candidate = format!("{base}-{suffix}");
            }
            message.id = candidate.clone();
            message.protocol_version = None;
            seen.insert(candidate);
        }
    }
    messages
}

fn group_all(messages: Vec<ToxMessage>) -> Vec<ContactRows> {
    let mut groups = Vec::<ContactRows>::new();
    for message in messages {
        let index = groups.iter().position(|group| {
            identity_matches(
                group.friend_number,
                &group.friend_public_key,
                message.friend_number,
                &message.friend_public_key,
            )
        });
        let group = match index {
            Some(index) => &mut groups[index],
            None => {
                groups.push(ContactRows {
                    friend_number: message.friend_number,
                    friend_public_key: message.friend_public_key.clone(),
                    messages: Vec::new(),
                });
                groups
                    .last_mut()
                    .expect("a contact group was just inserted")
            }
        };
        if group.friend_public_key.is_empty() && !message.friend_public_key.is_empty() {
            group.friend_public_key = message.friend_public_key.clone();
        }
        group.messages.push(message);
    }
    groups
}

fn build_fresh_manifest(
    root: &Path,
    generation: u64,
    messages: Vec<ToxMessage>,
) -> Result<StoreManifest, String> {
    profiles::create_dir_all(root).map_err(|_| "CHAT_HISTORY_STORE_CREATE_FAILED".to_string())?;
    let mut contacts = Vec::new();
    for group in group_all(messages) {
        let last_event = group.messages.iter().map(|message| message.timestamp).max();
        let mut contact = ContactManifest {
            friend_number: group.friend_number,
            friend_public_key: group.friend_public_key,
            revision: generation.max(1),
            search_epoch: generation.max(1),
            last_event,
            total: group.messages.len(),
            chunks: Vec::new(),
        };
        for (index, rows) in group.messages.chunks(CHUNK_ROWS).enumerate() {
            contact
                .chunks
                .push(write_chunk(root, &contact, generation, index, rows)?);
        }
        contacts.push(contact);
    }
    contacts
        .sort_by_key(|contact| identity_token(contact.friend_number, &contact.friend_public_key));
    let manifest = StoreManifest {
        version: STORE_VERSION,
        generation: generation.max(1),
        chunk_rows: CHUNK_ROWS,
        contacts,
    };
    Ok(manifest)
}

fn find_contact<'a>(
    manifest: &'a StoreManifest,
    friend_number: u32,
    friend_public_key: &str,
) -> Option<&'a ContactManifest> {
    manifest.contacts.iter().find(|contact| {
        identity_matches(
            contact.friend_number,
            &contact.friend_public_key,
            friend_number,
            friend_public_key,
        )
    })
}

fn read_contact_range(
    store: &RegisteredStore,
    contact: &ContactManifest,
    start: usize,
    end: usize,
) -> Result<Vec<ToxMessage>, String> {
    let start = start.min(contact.total);
    let end = end.min(contact.total).max(start);
    let mut result = Vec::with_capacity(end.saturating_sub(start));
    let mut chunk_start = 0usize;
    for chunk in &contact.chunks {
        let chunk_end = chunk_start.saturating_add(chunk.rows);
        if chunk_end > start && chunk_start < end {
            let rows = read_chunk(&store.root, contact, chunk)?;
            let local_start = start.saturating_sub(chunk_start).min(rows.len());
            let local_end = end.saturating_sub(chunk_start).min(rows.len());
            result.extend(rows[local_start..local_end].iter().cloned());
        }
        chunk_start = chunk_end;
        if chunk_start >= end {
            break;
        }
    }
    Ok(result)
}

fn contact_last_event_from_chunks(
    root: &Path,
    contact: &ContactManifest,
) -> Result<Option<u64>, String> {
    let mut last_event = None::<u64>;
    for chunk in &contact.chunks {
        for message in read_chunk(root, contact, chunk)? {
            last_event = Some(last_event.unwrap_or(0).max(message.timestamp));
        }
    }
    Ok(last_event)
}

fn locate_message(
    store: &RegisteredStore,
    contact: &ContactManifest,
    message_id: &str,
) -> Result<Option<(usize, ToxMessage)>, String> {
    if message_id.is_empty() {
        return Ok(None);
    }
    let mut chunk_start = 0usize;
    for chunk in &contact.chunks {
        if !bloom_may_contain(&chunk.id_bloom, message_id) {
            chunk_start = chunk_start.saturating_add(chunk.rows);
            continue;
        }
        let rows = read_chunk(&store.root, contact, chunk)?;
        if let Some(index) = rows.iter().position(|message| message.id == message_id) {
            return Ok(Some((
                chunk_start.saturating_add(index),
                rows[index].clone(),
            )));
        }
        chunk_start = chunk_start.saturating_add(chunk.rows);
    }
    Ok(None)
}

fn message_cost(message: &ToxMessage) -> usize {
    let encoded = serde_json::to_vec(message).map_or(MAX_WINDOW_COST, |bytes| bytes.len());
    let text = message.text.encode_utf16().count().saturating_mul(2);
    let attachment = message
        .attachment
        .as_ref()
        .map(|value| value.name.encode_utf16().count().saturating_mul(2))
        .unwrap_or(0);
    encoded.saturating_add(text).saturating_add(attachment)
}

fn apply_window_budget(
    messages: Vec<ToxMessage>,
    window_start: usize,
    protected_target: Option<usize>,
    preserve_end: bool,
) -> (Vec<ToxMessage>, usize) {
    if messages.is_empty() {
        return (messages, window_start);
    }
    let protected = protected_target.and_then(|absolute| {
        absolute
            .checked_sub(window_start)
            .filter(|relative| *relative < messages.len())
    });
    let costs = messages.iter().map(message_cost).collect::<Vec<_>>();
    if protected.is_none() {
        if preserve_end {
            let mut total = 0usize;
            let mut keep = 0usize;
            for cost in costs.into_iter().rev() {
                if keep > 0 && total.saturating_add(cost) > MAX_WINDOW_COST {
                    break;
                }
                total = total.saturating_add(cost);
                keep = keep.saturating_add(1);
            }
            let skip = messages.len().saturating_sub(keep.max(1));
            return (
                messages.into_iter().skip(skip).collect(),
                window_start.saturating_add(skip),
            );
        }
        let mut total = 0usize;
        let mut keep = 0usize;
        for cost in costs {
            if keep > 0 && total.saturating_add(cost) > MAX_WINDOW_COST {
                break;
            }
            total = total.saturating_add(cost);
            keep = keep.saturating_add(1);
        }
        return (
            messages.into_iter().take(keep.max(1)).collect(),
            window_start,
        );
    }

    let target = protected.expect("checked above");
    let mut left = 0usize;
    let mut right = messages.len();
    let mut total = costs
        .iter()
        .fold(0usize, |sum, cost| sum.saturating_add(*cost));
    while total > MAX_WINDOW_COST && right.saturating_sub(left) > 1 {
        let left_distance = target.saturating_sub(left);
        let right_distance = right.saturating_sub(1).saturating_sub(target);
        if right_distance >= left_distance && right.saturating_sub(1) != target {
            right = right.saturating_sub(1);
            total = total.saturating_sub(costs[right]);
        } else if left != target {
            total = total.saturating_sub(costs[left]);
            left = left.saturating_add(1);
        } else {
            break;
        }
    }
    (
        messages.into_iter().skip(left).take(right - left).collect(),
        window_start.saturating_add(left),
    )
}

fn bounded_contact_working_set(
    store: &RegisteredStore,
    contact: &ContactManifest,
) -> Result<Vec<ToxMessage>, String> {
    let desired_user = contact
        .chunks
        .iter()
        .map(|chunk| chunk.user_rows)
        .sum::<usize>()
        .min(WORKING_USER_TAIL);
    let desired_special = contact
        .chunks
        .iter()
        .map(|chunk| chunk.special_rows)
        .sum::<usize>()
        .min(WORKING_SPECIAL_TAIL);
    let mut user_count = 0usize;
    let mut special_count = 0usize;
    let mut selected = Vec::<(usize, ToxMessage)>::new();
    let mut chunk_end = contact.total;
    for chunk in contact.chunks.iter().rev() {
        if user_count >= desired_user && special_count >= desired_special {
            break;
        }
        let chunk_start = chunk_end.saturating_sub(chunk.rows);
        let rows = read_chunk(&store.root, contact, chunk)?;
        for (local_index, message) in rows.into_iter().enumerate().rev() {
            let user_message = message.event.is_none();
            let special = message.event.is_some() || message.attachment.is_some();
            let include_user = user_message && user_count < WORKING_USER_TAIL;
            let include_special = special && special_count < WORKING_SPECIAL_TAIL;
            if include_user {
                user_count = user_count.saturating_add(1);
            }
            if include_special {
                special_count = special_count.saturating_add(1);
            }
            if include_user || include_special {
                selected.push((chunk_start.saturating_add(local_index), message));
            }
        }
        chunk_end = chunk_start;
    }
    selected.sort_by_key(|(index, _)| *index);
    Ok(selected.into_iter().map(|(_, message)| message).collect())
}

fn bounded_working_set(store: &RegisteredStore) -> Result<Vec<ToxMessage>, String> {
    let mut result = Vec::<(u64, usize, ToxMessage)>::new();
    let mut sequence = 0usize;
    for contact in &store.manifest.contacts {
        for message in bounded_contact_working_set(store, contact)? {
            result.push((message.timestamp, sequence, message));
            sequence = sequence.saturating_add(1);
        }
    }
    result.sort_by_key(|(timestamp, sequence, _)| (*timestamp, *sequence));
    Ok(result.into_iter().map(|(_, _, message)| message).collect())
}

pub(super) fn open_and_register(
    history_path: &Path,
    legacy: Vec<ToxMessage>,
) -> Result<Vec<ToxMessage>, String> {
    let root = store_root(history_path)?;
    let manifest_file = manifest_path(&root);
    let original_exists = profiles::file_exists(history_path);
    let mut supplied_legacy = Some(legacy);
    let (candidate, needs_manifest_write) = if profiles::file_exists(&manifest_file) {
        match load_manifest(&root) {
            Ok(manifest) => (manifest, false),
            Err(_) if original_exists => {
                let messages = supplied_legacy
                    .take()
                    .filter(|messages| !messages.is_empty())
                    .map(Ok)
                    .unwrap_or_else(|| read_legacy_history(history_path))?;
                (
                    build_fresh_manifest(&root, 1, normalized_legacy_messages(messages))?,
                    true,
                )
            }
            Err(error) => return Err(error),
        }
    } else {
        let messages = if original_exists {
            supplied_legacy
                .take()
                .filter(|messages| !messages.is_empty())
                .map(Ok)
                .unwrap_or_else(|| read_legacy_history(history_path))?
        } else {
            supplied_legacy.take().unwrap_or_default()
        };
        (
            build_fresh_manifest(&root, 1, normalized_legacy_messages(messages))?,
            true,
        )
    };
    if needs_manifest_write {
        write_manifest(&root, &candidate)?;
    }
    let reloaded = match load_verified_manifest(&root) {
        Ok(manifest) => manifest,
        Err(_) if original_exists => {
            let messages = read_legacy_history(history_path)?;
            let recovery = build_fresh_manifest(
                &root,
                candidate.generation.saturating_add(1).max(1),
                normalized_legacy_messages(messages),
            )?;
            verify_store(&root, &recovery)?;
            write_manifest(&root, &recovery)?;
            load_verified_manifest(&root)?
        }
        Err(error) => return Err(error),
    };
    cleanup_orphan_chunks(&root, &reloaded);
    let store = RegisteredStore {
        root: root.clone(),
        manifest: reloaded,
        reclamation: Arc::new(Mutex::new(ReaderReclamation::default())),
    };
    let working = bounded_working_set(&store)?;
    if original_exists {
        profiles::remove_file(history_path)
            .map_err(|_| "CHAT_HISTORY_LEGACY_REMOVE_FAILED".to_string())?;
    }
    registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?
        .insert(history_path.to_path_buf(), store);
    Ok(working)
}

pub(super) fn contains_registered(history_path: &Path) -> bool {
    registry()
        .lock()
        .ok()
        .is_some_and(|stores| stores.contains_key(history_path))
}

pub(super) fn unregister(history_path: &Path) -> bool {
    registry()
        .lock()
        .ok()
        .and_then(|mut stores| stores.remove(history_path))
        .is_some()
}

pub(super) fn generation_registered(history_path: &Path) -> Result<u64, String> {
    registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?
        .get(history_path)
        .map(|store| store.manifest.generation)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())
}

pub(super) fn contact_revision_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
) -> Result<u64, String> {
    let stores = registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?;
    let store = stores
        .get(history_path)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())?;
    Ok(
        find_contact(&store.manifest, friend_number, friend_public_key)
            .map(|contact| contact.revision)
            .unwrap_or(0),
    )
}

pub(super) fn last_events_registered(
    history_path: &Path,
) -> Result<(HashMap<String, u64>, HashMap<u32, u64>), String> {
    let stores = registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?;
    let store = stores
        .get(history_path)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())?;
    let mut by_key = HashMap::<String, u64>::new();
    let mut by_number = HashMap::<u32, u64>::new();
    for contact in &store.manifest.contacts {
        let Some(last_event) = contact.last_event else {
            continue;
        };
        if contact.friend_public_key.is_empty() {
            let entry = by_number.entry(contact.friend_number).or_default();
            *entry = (*entry).max(last_event);
        } else {
            let entry = by_key
                .entry(contact.friend_public_key.to_ascii_uppercase())
                .or_default();
            *entry = (*entry).max(last_event);
        }
    }
    Ok((by_key, by_number))
}

pub(super) fn window_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    limit: Option<usize>,
    range_offset: Option<usize>,
    target_id: Option<&str>,
) -> Result<HistoryWindow, String> {
    let store = registered_reader(history_path)?;
    let Some(contact) = find_contact(&store.manifest, friend_number, friend_public_key) else {
        return Ok(HistoryWindow {
            messages: Vec::new(),
            total: 0,
            window_start: 0,
            target_index: None,
        });
    };
    let cap = match limit {
        Some(0) => MAX_WINDOW_ROWS,
        Some(value) => value.clamp(1, MAX_WINDOW_ROWS),
        None => DEFAULT_WINDOW_ROWS,
    };
    let target_index = match target_id {
        Some(target) => locate_message(&store, contact, target)?.map(|(index, _)| index),
        None => None,
    };
    let max_start = contact.total.saturating_sub(cap.min(contact.total));
    let start = range_offset
        .unwrap_or_else(|| {
            target_index
                .map(|index| index.saturating_sub(cap / 2))
                .unwrap_or_else(|| contact.total.saturating_sub(cap))
        })
        .min(max_start);
    let messages = read_contact_range(&store, contact, start, start.saturating_add(cap))?;
    let protected = range_offset.is_none().then_some(target_index).flatten();
    let preserve_end = range_offset.is_none() && target_index.is_none();
    let (messages, window_start) = apply_window_budget(messages, start, protected, preserve_end);
    Ok(HistoryWindow {
        messages,
        total: contact.total,
        window_start,
        target_index,
    })
}

pub(super) fn page_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    offset: usize,
    limit: usize,
) -> Result<HistoryPage, String> {
    let store = registered_reader(history_path)?;
    let Some(contact) = find_contact(&store.manifest, friend_number, friend_public_key) else {
        return Ok(HistoryPage {
            messages: Vec::new(),
            total: 0,
            offset: 0,
            next_offset: 0,
            has_more: false,
        });
    };
    let offset = offset.min(contact.total);
    let cap = limit.clamp(1, MAX_PAGE_ROWS);
    let messages = read_contact_range(&store, contact, offset, offset.saturating_add(cap))?;
    let (messages, actual_offset) = apply_window_budget(messages, offset, None, false);
    let next_offset = actual_offset.saturating_add(messages.len());
    Ok(HistoryPage {
        messages,
        total: contact.total,
        offset: actual_offset,
        next_offset,
        has_more: next_offset < contact.total,
    })
}

pub(super) fn latest_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    count: usize,
) -> Result<Vec<ToxMessage>, String> {
    Ok(window_registered(
        history_path,
        friend_number,
        friend_public_key,
        Some(count.clamp(1, MAX_WINDOW_ROWS)),
        None,
        None,
    )?
    .messages)
}

pub(super) fn latest_user_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    count: usize,
) -> Result<Vec<ToxMessage>, String> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let store = registered_reader(history_path)?;
    let Some(contact) = find_contact(&store.manifest, friend_number, friend_public_key) else {
        return Ok(Vec::new());
    };
    let cap = count.min(MAX_WINDOW_ROWS);
    let mut messages = Vec::with_capacity(cap);
    for chunk in contact.chunks.iter().rev() {
        if messages.len() >= cap {
            break;
        }
        if chunk.user_rows == 0 {
            continue;
        }
        for message in read_chunk(&store.root, contact, chunk)?.into_iter().rev() {
            if message.event.is_none() {
                messages.push(message);
                if messages.len() == cap {
                    break;
                }
            }
        }
    }
    messages.reverse();
    Ok(messages)
}

pub(super) fn working_set_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
) -> Result<Vec<ToxMessage>, String> {
    let store = registered_reader(history_path)?;
    let Some(contact) = find_contact(&store.manifest, friend_number, friend_public_key) else {
        return Ok(Vec::new());
    };
    bounded_contact_working_set(&store, contact)
}

pub(super) fn find_message_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    message_id: &str,
) -> Result<Option<ToxMessage>, String> {
    let store = registered_reader(history_path)?;
    let Some(contact) = find_contact(&store.manifest, friend_number, friend_public_key) else {
        return Ok(None);
    };
    Ok(locate_message(&store, contact, message_id)?.map(|(_, message)| message))
}

pub(super) fn find_operation_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    operation_id: &str,
) -> Result<Option<ToxMessage>, String> {
    if operation_id.is_empty() {
        return Ok(None);
    }
    let store = registered_reader(history_path)?;
    let Some(contact) = find_contact(&store.manifest, friend_number, friend_public_key) else {
        return Ok(None);
    };
    for chunk in contact.chunks.iter().rev() {
        let rows = read_chunk(&store.root, contact, chunk)?;
        if let Some(message) = rows
            .into_iter()
            .rev()
            .find(|message| message.operation_id.as_deref() == Some(operation_id))
        {
            return Ok(Some(message));
        }
    }
    Ok(None)
}

pub(super) fn remove_message_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    message_id: &str,
) -> Result<bool, String> {
    if message_id.is_empty() {
        return Ok(false);
    }
    let mut stores = registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?;
    let store = stores
        .get_mut(history_path)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())?;
    let Some(contact_index) = store.manifest.contacts.iter().position(|contact| {
        identity_matches(
            contact.friend_number,
            &contact.friend_public_key,
            friend_number,
            friend_public_key,
        )
    }) else {
        return Ok(false);
    };
    let original = store.manifest.contacts[contact_index].clone();
    for (chunk_index, chunk) in original.chunks.iter().enumerate() {
        if !bloom_may_contain(&chunk.id_bloom, message_id) {
            continue;
        }
        let mut rows = read_chunk(&store.root, &original, chunk)?;
        let Some(row_index) = rows.iter().position(|message| message.id == message_id) else {
            continue;
        };
        let removed = rows.remove(row_index);
        let generation = store.manifest.generation.saturating_add(1).max(1);
        let mut next = store.manifest.clone();
        let mut updated = original.clone();
        updated.total = updated.total.saturating_sub(1);
        updated.revision = updated.revision.saturating_add(1).max(1);
        updated.search_epoch = updated.search_epoch.saturating_add(1).max(1);
        let stale = vec![chunk.file.clone()];
        if rows.is_empty() {
            updated.chunks.remove(chunk_index);
        } else {
            updated.chunks[chunk_index] =
                write_chunk(&store.root, &updated, generation, chunk_index, &rows)?;
        }
        if original.last_event == Some(removed.timestamp) {
            updated.last_event = contact_last_event_from_chunks(&store.root, &updated)?;
        }
        if updated.total == 0 {
            next.contacts.remove(contact_index);
        } else {
            next.contacts[contact_index] = updated;
        }
        next.generation = generation;
        commit_manifest(store, next, stale)?;
        return Ok(true);
    }
    Ok(false)
}

fn messages_equal(left: &ToxMessage, right: &ToxMessage) -> bool {
    match (serde_json::to_vec(left), serde_json::to_vec(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn searchable_fields_equal(left: &ToxMessage, right: &ToxMessage) -> bool {
    normalize_qtox_body(left) == normalize_qtox_body(right)
        && left.attachment.as_ref().map(|value| value.name.as_str())
            == right.attachment.as_ref().map(|value| value.name.as_str())
}

fn group_incoming(
    manifest: &StoreManifest,
    messages: &[ToxMessage],
) -> Result<Vec<IncomingGroup>, String> {
    let mut groups = Vec::<IncomingGroup>::new();
    let mut message_identities = HashMap::<String, String>::new();
    for message in messages {
        if message.id.is_empty() {
            return Err("CHAT_HISTORY_MESSAGE_ID_REQUIRED".to_string());
        }
        let token = identity_token(message.friend_number, &message.friend_public_key);
        if message_identities
            .insert(message.id.clone(), token.clone())
            .is_some_and(|previous| previous != token)
        {
            return Err("CHAT_HISTORY_INPUT_IDENTITY_CONFLICT".to_string());
        }
        let existing_index = manifest.contacts.iter().position(|contact| {
            identity_matches(
                contact.friend_number,
                &contact.friend_public_key,
                message.friend_number,
                &message.friend_public_key,
            )
        });
        let group_index = groups.iter().position(|group| {
            if existing_index.is_some() || group.existing_index.is_some() {
                group.existing_index == existing_index
            } else {
                identity_matches(
                    group.friend_number,
                    &group.friend_public_key,
                    message.friend_number,
                    &message.friend_public_key,
                )
            }
        });
        let group = match group_index {
            Some(index) => &mut groups[index],
            None => {
                groups.push(IncomingGroup {
                    existing_index,
                    friend_number: message.friend_number,
                    friend_public_key: message.friend_public_key.clone(),
                    messages: Vec::new(),
                    positions: HashMap::new(),
                });
                groups
                    .last_mut()
                    .expect("an incoming group was just inserted")
            }
        };
        if group.friend_public_key.is_empty() && !message.friend_public_key.is_empty() {
            group.friend_public_key = message.friend_public_key.clone();
        }
        if let Some(position) = group.positions.get(&message.id).copied() {
            group.messages[position] = message.clone();
        } else {
            group
                .positions
                .insert(message.id.clone(), group.messages.len());
            group.messages.push(message.clone());
        }
    }
    Ok(groups)
}

fn apply_incoming_rows(
    rows: &mut [ToxMessage],
    pending: &mut HashMap<String, ToxMessage>,
    searchable_changed: &mut bool,
    last_event_invalidated: &mut bool,
    current_last_event: Option<u64>,
) -> bool {
    let mut changed = false;
    for row in rows {
        let Some(replacement) = pending.remove(&row.id) else {
            continue;
        };
        if !messages_equal(row, &replacement) {
            *searchable_changed |= !searchable_fields_equal(row, &replacement);
            if current_last_event == Some(row.timestamp) && replacement.timestamp < row.timestamp {
                *last_event_invalidated = true;
            }
            *row = replacement;
            changed = true;
        }
    }
    changed
}

fn upsert_contact(
    root: &Path,
    original: &ContactManifest,
    group: IncomingGroup,
    generation: u64,
) -> Result<(ContactManifest, Vec<String>, bool), String> {
    let mut updated = original.clone();
    let mut changed = false;
    let mut searchable_changed = false;
    let mut last_event_invalidated = false;
    if updated.friend_public_key.is_empty() && !group.friend_public_key.is_empty() {
        updated.friend_public_key = group.friend_public_key;
        changed = true;
    }

    let incoming_last_event = group.messages.iter().map(|message| message.timestamp).max();

    let order = group
        .messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();
    let mut pending = group
        .messages
        .into_iter()
        .map(|message| (message.id.clone(), message))
        .collect::<HashMap<_, _>>();
    let mut chunks = Vec::<ChunkManifest>::new();
    let mut stale = Vec::<String>::new();
    let last_index = original.chunks.len().checked_sub(1);
    let mut deferred_last = None::<(ChunkManifest, Vec<ToxMessage>, bool)>;

    for (index, chunk) in original.chunks.iter().enumerate() {
        let is_last = Some(index) == last_index;
        let may_update = chunk_may_contain_any(chunk, pending.keys());
        if !may_update && (!is_last || chunk.rows == CHUNK_ROWS || pending.is_empty()) {
            chunks.push(chunk.clone());
            continue;
        }
        let mut rows = read_chunk(root, original, chunk)?;
        let rows_changed = apply_incoming_rows(
            &mut rows,
            &mut pending,
            &mut searchable_changed,
            &mut last_event_invalidated,
            original.last_event,
        );
        if is_last {
            deferred_last = Some((chunk.clone(), rows, rows_changed));
        } else if rows_changed {
            chunks.push(write_chunk(root, &updated, generation, index, &rows)?);
            stale.push(chunk.file.clone());
            changed = true;
        } else {
            chunks.push(chunk.clone());
        }
    }

    let mut appended = order
        .into_iter()
        .filter_map(|id| pending.remove(&id))
        .collect::<Vec<_>>();
    if let Some((last_chunk, mut rows, rows_changed)) = deferred_last {
        let index = chunks.len();
        if !rows_changed && rows.len() == CHUNK_ROWS {
            chunks.push(last_chunk);
        } else if rows_changed || !appended.is_empty() {
            rows.append(&mut appended);
            for (part, slice) in rows.chunks(CHUNK_ROWS).enumerate() {
                chunks.push(write_chunk(
                    root,
                    &updated,
                    generation,
                    index.saturating_add(part),
                    slice,
                )?);
            }
            stale.push(last_chunk.file);
            changed = true;
        } else {
            chunks.push(last_chunk);
        }
    }

    if !appended.is_empty() {
        let start = chunks.len();
        for (part, slice) in appended.chunks(CHUNK_ROWS).enumerate() {
            chunks.push(write_chunk(
                root,
                &updated,
                generation,
                start.saturating_add(part),
                slice,
            )?);
        }
        changed = true;
    }
    updated.total = chunks.iter().map(|chunk| chunk.rows).sum();
    updated.chunks = chunks;
    updated.last_event = match (original.last_event, incoming_last_event) {
        (Some(current), Some(incoming)) => Some(current.max(incoming)),
        (current, incoming) => current.or(incoming),
    };
    if last_event_invalidated {
        updated.last_event = contact_last_event_from_chunks(root, &updated)?;
    }
    if changed {
        updated.revision = if original.revision == 0 {
            generation.max(1)
        } else {
            original.revision.saturating_add(1)
        };
        if original.total == 0 {
            updated.search_epoch = generation.max(1);
        } else if searchable_changed {
            updated.search_epoch = original.search_epoch.saturating_add(1).max(1);
        }
    }
    Ok((updated, stale, changed))
}

fn commit_manifest(
    store: &mut RegisteredStore,
    next: StoreManifest,
    stale_files: Vec<String>,
) -> Result<(), String> {
    write_manifest(&store.root, &next)?;
    let reloaded = load_manifest(&store.root)?;
    if reloaded.generation != next.generation {
        return Err("CHAT_HISTORY_MANIFEST_GENERATION_MISMATCH".to_string());
    }
    let keep = referenced_files(&reloaded);
    let retired = stale_files
        .into_iter()
        .filter(|file| !keep.contains(file))
        .collect::<Vec<_>>();
    store.manifest = reloaded;
    retire_files(store, retired);
    Ok(())
}

pub(super) fn upsert_registered(
    history_path: &Path,
    messages: &[ToxMessage],
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    let mut stores = registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?;
    let store = stores
        .get_mut(history_path)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())?;
    let groups = group_incoming(&store.manifest, messages)?;
    let generation = store.manifest.generation.saturating_add(1).max(1);
    let mut next = store.manifest.clone();
    let mut stale = Vec::new();
    let mut any_changed = false;
    for group in groups {
        let existing_index = group.existing_index;
        let original = existing_index
            .and_then(|index| next.contacts.get(index).cloned())
            .unwrap_or_else(|| ContactManifest {
                friend_number: group.friend_number,
                friend_public_key: group.friend_public_key.clone(),
                revision: 0,
                search_epoch: 0,
                last_event: None,
                total: 0,
                chunks: Vec::new(),
            });
        let (updated, replaced, changed) =
            upsert_contact(&store.root, &original, group, generation)?;
        stale.extend(replaced);
        any_changed |= changed;
        if let Some(index) = existing_index {
            next.contacts[index] = updated;
        } else {
            next.contacts.push(updated);
        }
    }
    if !any_changed {
        return Ok(());
    }
    next.generation = generation;
    next.contacts
        .sort_by_key(|contact| identity_token(contact.friend_number, &contact.friend_public_key));
    commit_manifest(store, next, stale)
}

pub(super) fn replace_all_registered(
    history_path: &Path,
    messages: &[ToxMessage],
) -> Result<Vec<ToxMessage>, String> {
    let mut stores = registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?;
    let store = stores
        .get_mut(history_path)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())?;
    let previous = referenced_files(&store.manifest);
    let generation = store.manifest.generation.saturating_add(1).max(1);
    let mut next = build_fresh_manifest(
        &store.root,
        generation,
        normalized_legacy_messages(messages.to_vec()),
    )?;
    for contact in &mut next.contacts {
        if let Some(previous) = store.manifest.contacts.iter().find(|previous| {
            identity_matches(
                previous.friend_number,
                &previous.friend_public_key,
                contact.friend_number,
                &contact.friend_public_key,
            )
        }) {
            contact.revision = generation.max(previous.revision.saturating_add(1));
            contact.search_epoch = generation.max(previous.search_epoch.saturating_add(1));
        }
    }
    verify_store(&store.root, &next)?;
    write_manifest(&store.root, &next)?;
    let reloaded = load_verified_manifest(&store.root)?;
    if reloaded.generation != generation {
        return Err("CHAT_HISTORY_MANIFEST_GENERATION_MISMATCH".to_string());
    }
    let keep = referenced_files(&reloaded);
    let retired = previous
        .into_iter()
        .filter(|file| !keep.contains(file))
        .collect::<Vec<_>>();
    store.manifest = reloaded;
    retire_files(store, retired);
    bounded_working_set(store)
}

pub(super) fn clear_registered(
    history_path: &Path,
    friend: Option<(u32, &str)>,
) -> Result<(), String> {
    let mut stores = registry()
        .lock()
        .map_err(|_| "CHAT_HISTORY_REGISTRY_LOCK_POISONED".to_string())?;
    let store = stores
        .get_mut(history_path)
        .ok_or_else(|| "CHAT_HISTORY_STORE_NOT_REGISTERED".to_string())?;
    let mut next = store.manifest.clone();
    let mut stale = Vec::new();
    match friend {
        Some((friend_number, friend_public_key)) => {
            next.contacts.retain(|contact| {
                let remove = identity_matches(
                    contact.friend_number,
                    &contact.friend_public_key,
                    friend_number,
                    friend_public_key,
                );
                if remove {
                    stale.extend(contact.chunks.iter().map(|chunk| chunk.file.clone()));
                }
                !remove
            });
        }
        None => {
            stale.extend(
                next.contacts
                    .iter()
                    .flat_map(|contact| contact.chunks.iter().map(|chunk| chunk.file.clone())),
            );
            next.contacts.clear();
        }
    }
    if stale.is_empty() {
        return Ok(());
    }
    next.generation = next.generation.saturating_add(1).max(1);
    commit_manifest(store, next, stale)
}

pub(super) fn prune_working_set(
    messages: &mut Vec<ToxMessage>,
    expired: &[(u32, String)],
) -> usize {
    let before = messages.len();
    let mut keep = HashSet::<usize>::new();
    for (friend_number, friend_public_key) in expired {
        let mut user_count = 0usize;
        let mut special_count = 0usize;
        for (index, message) in messages.iter().enumerate().rev().filter(|(_, message)| {
            identity_matches(
                message.friend_number,
                &message.friend_public_key,
                *friend_number,
                friend_public_key,
            )
        }) {
            let user_message = message.event.is_none();
            let special = message.event.is_some() || message.attachment.is_some();
            let include_user = user_message && user_count < WORKING_USER_TAIL;
            let include_special = special && special_count < WORKING_SPECIAL_TAIL;
            if include_user {
                user_count = user_count.saturating_add(1);
            }
            if include_special {
                special_count = special_count.saturating_add(1);
            }
            if include_user || include_special {
                keep.insert(index);
            }
            if user_count >= WORKING_USER_TAIL && special_count >= WORKING_SPECIAL_TAIL {
                break;
            }
        }
    }
    let mut index = 0usize;
    messages.retain(|message| {
        let expired_message = expired.iter().any(|(friend_number, friend_public_key)| {
            identity_matches(
                message.friend_number,
                &message.friend_public_key,
                *friend_number,
                friend_public_key,
            )
        });
        let retain = !expired_message || keep.contains(&index);
        index = index.saturating_add(1);
        retain
    });
    before.saturating_sub(messages.len())
}

fn normalize_qtox_body(message: &ToxMessage) -> String {
    if message.protocol_version.is_some() || !message.text.starts_with("> ") {
        return message.text.clone();
    }
    let normalized = message
        .text
        .replace("\r\n", "\n")
        .replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let mut index = 0usize;
    while index < lines.len() && lines[index].starts_with("> ") {
        index = index.saturating_add(1);
    }
    lines[index..].join("\n")
}

#[derive(Clone, Copy)]
struct FoldedUnit {
    folded_byte_start: usize,
    original_byte_start: usize,
    original_byte_end: usize,
    original_utf16_start: u32,
    original_utf16_end: u32,
}

struct FoldedField {
    text: String,
    units: Vec<FoldedUnit>,
}

fn lowercase(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
}

fn fold_field(value: &str) -> FoldedField {
    let mut text = String::with_capacity(value.len());
    let mut units = Vec::with_capacity(value.chars().count());
    let mut utf16_start = 0usize;
    for (original_byte_start, character) in value.char_indices() {
        let original_byte_end = original_byte_start.saturating_add(character.len_utf8());
        let utf16_end = utf16_start.saturating_add(character.len_utf16());
        for folded in character.to_lowercase() {
            units.push(FoldedUnit {
                folded_byte_start: text.len(),
                original_byte_start,
                original_byte_end,
                original_utf16_start: u32::try_from(utf16_start).unwrap_or(u32::MAX),
                original_utf16_end: u32::try_from(utf16_end).unwrap_or(u32::MAX),
            });
            text.push(folded);
        }
        utf16_start = utf16_end;
    }
    FoldedField { text, units }
}

fn original_occurrence(
    folded: &FoldedField,
    folded_start: usize,
    folded_end: usize,
) -> Option<(u32, u32, usize, usize)> {
    let first = folded
        .units
        .binary_search_by_key(&folded_start, |unit| unit.folded_byte_start)
        .ok()?;
    let after_last = folded
        .units
        .partition_point(|unit| unit.folded_byte_start < folded_end);
    let last = after_last.checked_sub(1)?;
    Some((
        folded.units[first].original_utf16_start,
        folded.units[last].original_utf16_end,
        folded.units[first].original_byte_start,
        folded.units[last].original_byte_end,
    ))
}

fn search_snippet(value: &str, byte_start: usize, byte_end: usize) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let snippet_start = value[..byte_start]
        .char_indices()
        .rev()
        .nth(39)
        .map(|(index, _)| index)
        .unwrap_or(0);
    let snippet_end = value[byte_end..]
        .char_indices()
        .nth(40)
        .map(|(index, _)| byte_end.saturating_add(index))
        .unwrap_or(value.len());
    let mut snippet = String::new();
    if snippet_start > 0 {
        snippet.push('…');
    }
    snippet.push_str(&value[snippet_start..snippet_end]);
    if snippet_end < value.len() {
        snippet.push('…');
    }
    Some(snippet)
}

fn append_field_matches(
    message: &ToxMessage,
    absolute_index: usize,
    field: &str,
    value: &str,
    folded_query: &str,
    skip: usize,
    ordinal: &mut usize,
    cap: usize,
    results: &mut Vec<HistorySearchResult>,
) -> Option<usize> {
    let folded = fold_field(value);
    for (folded_start, _) in folded.text.match_indices(folded_query) {
        let current = *ordinal;
        *ordinal = ordinal.saturating_add(1);
        if current < skip {
            continue;
        }
        if results.len() >= cap {
            return Some(current);
        }
        let folded_end = folded_start.saturating_add(folded_query.len());
        if let Some((start, end, byte_start, byte_end)) =
            original_occurrence(&folded, folded_start, folded_end)
        {
            results.push(HistorySearchResult {
                message_id: message.id.clone(),
                index: absolute_index,
                field: field.to_string(),
                start,
                end,
                snippet: search_snippet(value, byte_start, byte_end),
            });
        }
    }
    None
}

fn append_message_search_results(
    message: &ToxMessage,
    absolute_index: usize,
    folded_query: &str,
    skip: usize,
    cap: usize,
    results: &mut Vec<HistorySearchResult>,
) -> Result<Option<usize>, String> {
    let mut ordinal = 0usize;
    let text = normalize_qtox_body(message);
    if let Some(next) = append_field_matches(
        message,
        absolute_index,
        "text",
        &text,
        folded_query,
        skip,
        &mut ordinal,
        cap,
        results,
    ) {
        return Ok(Some(next));
    }
    if let Some(attachment) = message.attachment.as_ref() {
        if let Some(next) = append_field_matches(
            message,
            absolute_index,
            "attachment",
            &attachment.name,
            folded_query,
            skip,
            &mut ordinal,
            cap,
            results,
        ) {
            return Ok(Some(next));
        }
    }
    if skip > ordinal {
        return Err("CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string());
    }
    Ok(None)
}

fn query_cursor_hash(query: &str) -> String {
    sha256_hex(lowercase(query).as_bytes())[..16].to_string()
}

fn contact_cursor_hash(contact: &ContactManifest) -> String {
    sha256_hex(identity_token(contact.friend_number, &contact.friend_public_key).as_bytes())[..16]
        .to_string()
}

fn encode_search_cursor(cursor: SearchCursor, contact: &ContactManifest, query: &str) -> String {
    format!(
        "v3:{}:{}:{}:{}:{}:{}",
        cursor.search_epoch,
        contact_cursor_hash(contact),
        cursor.snapshot_end,
        cursor.index,
        cursor.skip,
        query_cursor_hash(query)
    )
}

fn decode_search_cursor(
    value: &str,
    contact: &ContactManifest,
    query: &str,
) -> Result<SearchCursor, String> {
    let parts = value.split(':').collect::<Vec<_>>();
    if parts.len() != 7 || parts[0] != "v3" || parts[6] != query_cursor_hash(query) {
        return Err("CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string());
    }
    let cursor = SearchCursor {
        search_epoch: parts[1]
            .parse()
            .map_err(|_| "CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string())?,
        snapshot_end: parts[3]
            .parse()
            .map_err(|_| "CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string())?,
        index: parts[4]
            .parse()
            .map_err(|_| "CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string())?,
        skip: parts[5]
            .parse()
            .map_err(|_| "CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string())?,
    };
    if cursor.search_epoch != contact.search_epoch
        || parts[2] != contact_cursor_hash(contact)
        || cursor.snapshot_end > contact.total
    {
        return Err("CHAT_HISTORY_SEARCH_CURSOR_STALE".to_string());
    }
    if cursor.snapshot_end == 0 || cursor.index >= cursor.snapshot_end {
        return Err("CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string());
    }
    Ok(cursor)
}

pub(super) fn search_registered(
    history_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
    query: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<HistorySearchPage, String> {
    let store = registered_reader(history_path)?;
    let Some(contact) = find_contact(&store.manifest, friend_number, friend_public_key) else {
        if cursor.is_some() {
            return Err("CHAT_HISTORY_SEARCH_CURSOR_STALE".to_string());
        }
        return Ok(HistorySearchPage {
            matches: Vec::new(),
            next_cursor: None,
            revision: 0,
        });
    };
    let revision = contact.revision;
    if query.is_empty() || contact.total == 0 {
        return Ok(HistorySearchPage {
            matches: Vec::new(),
            next_cursor: None,
            revision,
        });
    }
    let folded_query = lowercase(query);
    if folded_query.is_empty() {
        return Ok(HistorySearchPage {
            matches: Vec::new(),
            next_cursor: None,
            revision,
        });
    }
    let initial = match cursor {
        Some(value) => decode_search_cursor(value, contact, query)?,
        None => SearchCursor {
            search_epoch: contact.search_epoch,
            snapshot_end: contact.total,
            index: contact.total.saturating_sub(1),
            skip: 0,
        },
    };
    if initial.index >= contact.total {
        return Err("CHAT_HISTORY_SEARCH_CURSOR_INVALID".to_string());
    }
    let cap = limit.clamp(1, MAX_SEARCH_ROWS);
    let mut results = Vec::with_capacity(cap);
    let mut chunk_end = contact.total;
    for chunk in contact.chunks.iter().rev() {
        let chunk_start = chunk_end.saturating_sub(chunk.rows);
        if initial.index < chunk_start {
            chunk_end = chunk_start;
            continue;
        }
        let rows = read_chunk(&store.root, contact, chunk)?;
        let local_max = initial
            .index
            .saturating_sub(chunk_start)
            .min(rows.len().saturating_sub(1));
        for local_index in (0..=local_max).rev() {
            let absolute_index = chunk_start.saturating_add(local_index);
            let skip = if absolute_index == initial.index {
                initial.skip
            } else {
                0
            };
            let next_same_message = append_message_search_results(
                &rows[local_index],
                absolute_index,
                &folded_query,
                skip,
                cap,
                &mut results,
            )?;
            if results.len() == cap {
                let next = next_same_message
                    .map(|next_skip| SearchCursor {
                        search_epoch: initial.search_epoch,
                        snapshot_end: initial.snapshot_end,
                        index: absolute_index,
                        skip: next_skip,
                    })
                    .or_else(|| {
                        (absolute_index > 0).then_some(SearchCursor {
                            search_epoch: initial.search_epoch,
                            snapshot_end: initial.snapshot_end,
                            index: absolute_index.saturating_sub(1),
                            skip: 0,
                        })
                    });
                return Ok(HistorySearchPage {
                    matches: results,
                    next_cursor: next.map(|value| encode_search_cursor(value, contact, query)),
                    revision,
                });
            }
        }
        chunk_end = chunk_start;
    }
    Ok(HistorySearchPage {
        matches: results,
        next_cursor: None,
        revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_history_path(label: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "kaigen-history-store-{label}-{}-{now}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create isolated history test directory");
        directory.join("chat-history.json")
    }

    fn remove_test_history(path: &Path) {
        unregister(path);
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    fn message(
        id: impl Into<String>,
        friend_number: u32,
        friend_public_key: &str,
        text: impl Into<String>,
        timestamp: u64,
    ) -> ToxMessage {
        ToxMessage {
            id: id.into(),
            friend_number,
            friend_public_key: friend_public_key.to_string(),
            text: text.into(),
            mine: false,
            timestamp,
            delivery: "delivered".to_string(),
            delivered_at: Some(timestamp),
            attachment: None,
            event: None,
            protocol_version: Some(1),
            operation_id: None,
            quote: None,
            formatting: Vec::new(),
            pq_protected: false,
            reactions: None,
        }
    }

    #[test]
    fn migrates_duplicate_legacy_rows_once_and_reopens_idempotently() {
        let path = test_history_path("migration");
        let mut first = message("", 7, "KEY-7", "same", 42);
        let mut second = message("", 7, "KEY-7", "same", 42);
        first.protocol_version = None;
        second.protocol_version = None;
        let legacy = vec![first, second];
        profiles::atomic_write(&path, &serde_json::to_vec(&legacy).unwrap()).unwrap();

        let opened = open_and_register(&path, Vec::new()).unwrap();
        assert_eq!(opened.len(), 2);
        assert_ne!(opened[0].id, opened[1].id);
        assert!(opened.iter().all(|row| row.id.starts_with("legacy-")));
        assert!(opened.iter().all(|row| row.protocol_version.is_none()));
        assert!(!profiles::file_exists(&path));
        let ids = opened.iter().map(|row| row.id.clone()).collect::<Vec<_>>();

        assert!(unregister(&path));
        let reopened = open_and_register(&path, Vec::new()).unwrap();
        assert_eq!(
            reopened
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<_>>(),
            ids
        );
        remove_test_history(&path);
    }

    #[test]
    fn migration_consumes_the_already_parsed_legacy_rows() {
        let path = test_history_path("migration-supplied");
        let on_disk = vec![message("disk", 4, "KEY-4", "disk copy", 1)];
        profiles::atomic_write(&path, &serde_json::to_vec(&on_disk).unwrap()).unwrap();
        let supplied = vec![message("supplied", 4, "KEY-4", "already parsed", 1)];

        let opened = open_and_register(&path, supplied).unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].id, "supplied");
        assert_eq!(opened[0].text, "already parsed");

        remove_test_history(&path);
    }

    #[test]
    fn legacy_manifest_backfills_last_events_once_without_version_bump() {
        let path = test_history_path("last-event-legacy");
        open_and_register(
            &path,
            vec![
                message("a-newer", 7, "KEY-A", "newer timestamp", 90),
                message("a-last-row", 7, "KEY-A", "later row", 40),
                message("b-only", 8, "KEY-B", "other contact", 70),
            ],
        )
        .unwrap();
        assert!(unregister(&path));

        let root = store_root(&path).unwrap();
        let manifest_file = manifest_path(&root);
        let mut legacy: serde_json::Value = serde_json::from_slice(
            &profiles::read_file(&manifest_file).expect("read generated manifest"),
        )
        .unwrap();
        assert_eq!(legacy["version"], STORE_VERSION);
        for contact in legacy["contacts"].as_array_mut().unwrap() {
            contact.as_object_mut().unwrap().remove("lastEvent");
        }
        profiles::atomic_write(&manifest_file, &serde_json::to_vec(&legacy).unwrap()).unwrap();

        open_and_register(&path, Vec::new()).unwrap();
        let (by_key, by_number) = last_events_registered(&path).unwrap();
        assert_eq!(by_key.get("KEY-A"), Some(&90));
        assert_eq!(by_key.get("KEY-B"), Some(&70));
        assert!(by_number.is_empty());
        let repaired = profiles::read_file(&manifest_file).unwrap();
        let repaired_json: serde_json::Value = serde_json::from_slice(&repaired).unwrap();
        assert_eq!(repaired_json["version"], STORE_VERSION);
        assert!(repaired_json["contacts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|contact| contact.get("lastEvent").is_some()));

        assert!(unregister(&path));
        open_and_register(&path, Vec::new()).unwrap();
        assert_eq!(profiles::read_file(&manifest_file).unwrap(), repaired);
        remove_test_history(&path);
    }

    #[test]
    fn last_event_summary_tracks_one_contact_and_survives_empty_resident_reopen() {
        let path = test_history_path("last-event-upsert");
        open_and_register(
            &path,
            vec![
                message("a-old", 1, "KEY-A", "old", 10),
                message("a-latest", 1, "KEY-A", "latest", 30),
                message("b-only", 2, "KEY-B", "other", 20),
            ],
        )
        .unwrap();

        let lowered = message("a-latest", 1, "KEY-A", "corrected timestamp", 5);
        upsert_registered(&path, &[lowered]).unwrap();
        let (by_key, _) = last_events_registered(&path).unwrap();
        assert_eq!(by_key.get("KEY-A"), Some(&10));
        assert_eq!(by_key.get("KEY-B"), Some(&20));

        upsert_registered(&path, &[message("a-next", 1, "KEY-A", "next", 40)]).unwrap();
        let (by_key, _) = last_events_registered(&path).unwrap();
        assert_eq!(by_key.get("KEY-A"), Some(&40));
        assert_eq!(by_key.get("KEY-B"), Some(&20));

        assert!(unregister(&path));
        let mut resident = open_and_register(&path, Vec::new()).unwrap();
        resident.retain(crate::message_requires_runtime_residency);
        assert!(resident.is_empty());
        let (by_key, _) = last_events_registered(&path).unwrap();
        assert_eq!(by_key.get("KEY-A"), Some(&40));
        assert_eq!(by_key.get("KEY-B"), Some(&20));
        remove_test_history(&path);
    }

    #[test]
    fn last_event_summary_recalculates_latest_remove_and_clear() {
        let path = test_history_path("last-event-remove-clear");
        open_and_register(
            &path,
            vec![
                message("a-old", 1, "KEY-A", "old", 10),
                message("a-latest", 1, "KEY-A", "latest", 30),
                message("b-only", 2, "KEY-B", "other", 20),
            ],
        )
        .unwrap();

        assert!(remove_message_registered(&path, 11, "key-a", "a-latest").unwrap());
        let (by_key, _) = last_events_registered(&path).unwrap();
        assert_eq!(by_key.get("KEY-A"), Some(&10));
        assert_eq!(by_key.get("KEY-B"), Some(&20));

        clear_registered(&path, Some((1, "key-a"))).unwrap();
        let (by_key, _) = last_events_registered(&path).unwrap();
        assert!(!by_key.contains_key("KEY-A"));
        assert_eq!(by_key.get("KEY-B"), Some(&20));

        clear_registered(&path, None).unwrap();
        let (by_key, by_number) = last_events_registered(&path).unwrap();
        assert!(by_key.is_empty());
        assert!(by_number.is_empty());
        remove_test_history(&path);
    }

    #[test]
    fn incomplete_migration_recovers_from_the_retained_monolith() {
        let path = test_history_path("migration-recovery");
        let legacy = vec![message("", 3, "KEY-3", "recover me", 1)];
        profiles::atomic_write(&path, &serde_json::to_vec(&legacy).unwrap()).unwrap();
        let root = store_root(&path).unwrap();
        let candidate =
            build_fresh_manifest(&root, 1, normalized_legacy_messages(legacy.clone())).unwrap();
        write_manifest(&root, &candidate).unwrap();
        let corrupt = safe_chunk_path(&root, &candidate.contacts[0].chunks[0].file).unwrap();
        profiles::atomic_write(&corrupt, b"[]").unwrap();

        let recovered = open_and_register(&path, Vec::new()).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].text, "recover me");
        assert!(recovered[0].id.starts_with("legacy-"));
        assert!(!profiles::file_exists(&path));
        remove_test_history(&path);
    }

    #[test]
    fn windows_are_bounded_and_center_an_exact_target() {
        let path = test_history_path("windows");
        let rows = (0..700)
            .map(|index| message(format!("m-{index:04}"), 9, "KEY-9", "body", index))
            .collect::<Vec<_>>();
        open_and_register(&path, rows).unwrap();

        let centered =
            window_registered(&path, 99, "key-9", Some(100), None, Some("m-0321")).unwrap();
        assert_eq!(centered.total, 700);
        assert_eq!(centered.target_index, Some(321));
        assert!(centered.window_start <= 321);
        assert!(centered.messages.len() <= 100);
        assert!(centered.messages.iter().any(|row| row.id == "m-0321"));

        let access = window_registered(&path, 9, "KEY-9", Some(0), None, None).unwrap();
        assert_eq!(access.total, 700);
        assert_eq!(access.messages.len(), 700);
        assert_eq!(access.window_start, 0);

        let page = page_registered(&path, 9, "KEY-9", 256, 1_000).unwrap();
        assert_eq!(page.offset, 256);
        assert_eq!(page.messages.len(), CHUNK_ROWS);
        assert_eq!(page.next_offset, 512);
        assert!(page.has_more);
        let latest_users = latest_user_registered(&path, 9, "KEY-9", 50).unwrap();
        assert_eq!(latest_users.len(), 50);
        assert_eq!(latest_users.first().unwrap().id, "m-0650");
        assert_eq!(latest_users.last().unwrap().id, "m-0699");
        remove_test_history(&path);
    }

    #[test]
    fn payload_budget_keeps_the_newest_tail_and_never_drops_a_jump_target() {
        let path = test_history_path("payload-budget");
        let rows = (0..6)
            .map(|index| {
                message(
                    format!("large-{index}"),
                    12,
                    "KEY-12",
                    format!("{index}{}", "x".repeat(600_000)),
                    index,
                )
            })
            .collect::<Vec<_>>();
        open_and_register(&path, rows).unwrap();

        let tail = window_registered(&path, 12, "KEY-12", Some(0), None, None).unwrap();
        assert!(tail.messages.len() < 6);
        assert_eq!(tail.messages.last().unwrap().id, "large-5");
        assert!(tail.window_start > 0);

        let target =
            window_registered(&path, 12, "KEY-12", Some(0), None, Some("large-1")).unwrap();
        assert_eq!(target.target_index, Some(1));
        assert!(target.messages.iter().any(|row| row.id == "large-1"));
        remove_test_history(&path);
    }

    #[test]
    fn sparse_upsert_preserves_rows_missing_from_the_working_set() {
        let path = test_history_path("upsert");
        let rows = (0..600)
            .map(|index| message(format!("m-{index:04}"), 2, "KEY-2", "old", index))
            .collect::<Vec<_>>();
        open_and_register(&path, rows).unwrap();
        let before = registry()
            .lock()
            .unwrap()
            .get(&path)
            .unwrap()
            .manifest
            .contacts[0]
            .chunks
            .iter()
            .map(|chunk| chunk.file.clone())
            .collect::<Vec<_>>();

        let mut changed = message("m-0599", 2, "KEY-2", "changed", 599);
        changed.operation_id = Some("operation-599".to_string());
        upsert_registered(&path, &[changed]).unwrap();

        let all = window_registered(&path, 2, "KEY-2", Some(0), None, None).unwrap();
        assert_eq!(all.total, 600);
        assert_eq!(all.messages.first().unwrap().id, "m-0000");
        assert_eq!(all.messages.last().unwrap().text, "changed");
        assert_eq!(
            find_operation_registered(&path, 2, "KEY-2", "operation-599")
                .unwrap()
                .unwrap()
                .id,
            "m-0599"
        );
        let after = registry()
            .lock()
            .unwrap()
            .get(&path)
            .unwrap()
            .manifest
            .contacts[0]
            .chunks
            .iter()
            .map(|chunk| chunk.file.clone())
            .collect::<Vec<_>>();
        assert_eq!(&before[..2], &after[..2]);
        assert_ne!(before[2], after[2]);
        remove_test_history(&path);
    }

    #[test]
    fn paused_reader_keeps_replaced_chunks_until_its_search_snapshot_finishes() {
        let path = test_history_path("reader-reclamation");
        let rows = (0..600)
            .map(|index| {
                message(
                    format!("m-{index:04}"),
                    7,
                    "KEY-7",
                    if index == 1 { "old needle" } else { "body" },
                    index,
                )
            })
            .collect::<Vec<_>>();
        open_and_register(&path, rows).unwrap();

        // Capture the same immutable manifest/chunk lease used by a search,
        // then let a writer replace one of those chunks before the reader resumes.
        let paused_search = registered_reader(&path).unwrap();
        let old_contact = find_contact(&paused_search.manifest, 7, "KEY-7")
            .unwrap()
            .clone();
        let retired_file = old_contact.chunks[0].file.clone();
        let retired_path = safe_chunk_path(&paused_search.root, &retired_file).unwrap();
        let writer_path = path.clone();
        std::thread::spawn(move || {
            upsert_registered(
                &writer_path,
                &[message("m-0001", 7, "KEY-7", "new body", 1)],
            )
            .unwrap();
        })
        .join()
        .unwrap();

        assert!(profiles::file_exists(&retired_path));
        let old_snapshot =
            read_contact_range(&paused_search, &old_contact, 0, old_contact.total).unwrap();
        assert!(old_snapshot
            .iter()
            .any(|row| row.id == "m-0001" && row.text == "old needle"));
        drop(paused_search);
        assert!(!profiles::file_exists(&retired_path));

        let current = search_registered(&path, 7, "KEY-7", "old needle", None, 100).unwrap();
        assert!(current.matches.is_empty());
        remove_test_history(&path);
    }

    #[test]
    fn search_reports_each_utf16_occurrence_and_skips_qtox_quote_prefix() {
        let path = test_history_path("search");
        let normal = message("normal", 4, "KEY-4", "A😀A😀", 1);
        let mut legacy = message("legacy", 4, "KEY-4", "> hidden 😀\nbody 😀", 2);
        legacy.protocol_version = None;
        let folded = message("folded", 4, "KEY-4", "ПрИвет HELLO İ", 3);
        open_and_register(&path, vec![normal, legacy, folded]).unwrap();

        let first = search_registered(&path, 4, "KEY-4", "😀", None, 1).unwrap();
        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].message_id, "legacy");
        assert_eq!(first.matches[0].field, "text");
        assert_eq!((first.matches[0].start, first.matches[0].end), (5, 7));
        let cursor = first.next_cursor.clone().expect("more exact occurrences");

        let rest = search_registered(&path, 4, "KEY-4", "😀", Some(&cursor), 100).unwrap();
        assert_eq!(rest.matches.len(), 2);
        assert!(rest
            .matches
            .iter()
            .all(|result| result.message_id == "normal"));
        assert_eq!(
            rest.matches
                .iter()
                .map(|result| (result.start, result.end))
                .collect::<Vec<_>>(),
            vec![(1, 3), (4, 6)]
        );

        let russian = search_registered(&path, 4, "KEY-4", "привет", None, 100).unwrap();
        assert_eq!(russian.matches.len(), 1);
        assert_eq!((russian.matches[0].start, russian.matches[0].end), (0, 6));
        let english = search_registered(&path, 4, "KEY-4", "hello", None, 100).unwrap();
        assert_eq!(english.matches.len(), 1);
        assert_eq!((english.matches[0].start, english.matches[0].end), (7, 12));
        let expansion = search_registered(&path, 4, "KEY-4", "i\u{307}", None, 100).unwrap();
        assert_eq!(expansion.matches.len(), 1);
        assert_eq!(
            (expansion.matches[0].start, expansion.matches[0].end),
            (13, 14)
        );

        upsert_registered(&path, &[message("other-chat", 8, "KEY-8", "😀", 4)]).unwrap();
        assert!(search_registered(&path, 4, "KEY-4", "😀", Some(&cursor), 100).is_ok());
        let wrong_contact = match search_registered(&path, 8, "KEY-8", "😀", Some(&cursor), 100) {
            Ok(_) => panic!("a cursor must be bound to its contact identity"),
            Err(error) => error,
        };
        assert_eq!(wrong_contact, "CHAT_HISTORY_SEARCH_CURSOR_STALE");

        let revision_before_append = contact_revision_registered(&path, 4, "KEY-4").unwrap();
        upsert_registered(&path, &[message("later", 4, "KEY-4", "😀", 5)]).unwrap();
        assert!(contact_revision_registered(&path, 4, "KEY-4").unwrap() > revision_before_append);
        let snapshot = search_registered(&path, 4, "KEY-4", "😀", Some(&cursor), 100).unwrap();
        assert!(snapshot
            .matches
            .iter()
            .all(|matched| matched.message_id != "later"));

        let mut metadata = find_message_registered(&path, 4, "KEY-4", "normal")
            .unwrap()
            .unwrap();
        metadata.delivery = "pending".to_string();
        upsert_registered(&path, &[metadata.clone()]).unwrap();
        assert!(search_registered(&path, 4, "KEY-4", "😀", Some(&cursor), 100).is_ok());

        metadata.text = "searchable replacement".to_string();
        upsert_registered(&path, &[metadata]).unwrap();
        let stale = match search_registered(&path, 4, "KEY-4", "😀", Some(&cursor), 100) {
            Ok(_) => panic!("a searchable replacement must invalidate its search cursor"),
            Err(error) => error,
        };
        assert_eq!(stale, "CHAT_HISTORY_SEARCH_CURSOR_STALE");
        remove_test_history(&path);
    }

    #[test]
    fn removing_one_message_is_targeted_durable_and_invalidates_search() {
        let path = test_history_path("remove-message");
        open_and_register(
            &path,
            vec![
                message("first", 6, "KEY-6", "needle", 1),
                message("middle", 6, "KEY-6", "needle", 2),
                message("last", 6, "KEY-6", "needle", 3),
            ],
        )
        .unwrap();
        assert_eq!(contact_revision_registered(&path, 7, "KEY-7").unwrap(), 0);
        let page = search_registered(&path, 6, "KEY-6", "needle", None, 1).unwrap();
        let cursor = page.next_cursor.unwrap();
        let revision = contact_revision_registered(&path, 6, "KEY-6").unwrap();

        assert!(!remove_message_registered(&path, 6, "KEY-6", "missing").unwrap());
        assert!(remove_message_registered(&path, 66, "key-6", "middle").unwrap());
        assert!(contact_revision_registered(&path, 6, "KEY-6").unwrap() > revision);
        assert!(find_message_registered(&path, 6, "KEY-6", "middle")
            .unwrap()
            .is_none());
        let window = window_registered(&path, 6, "KEY-6", Some(20), None, None).unwrap();
        assert_eq!(window.total, 2);
        assert_eq!(
            window
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "last"]
        );
        let stale = match search_registered(&path, 6, "KEY-6", "needle", Some(&cursor), 100) {
            Ok(_) => panic!("removing a row must invalidate the search snapshot"),
            Err(error) => error,
        };
        assert_eq!(stale, "CHAT_HISTORY_SEARCH_CURSOR_STALE");

        unregister(&path);
        open_and_register(&path, Vec::new()).unwrap();
        assert!(find_message_registered(&path, 6, "KEY-6", "middle")
            .unwrap()
            .is_none());
        remove_test_history(&path);
    }

    #[test]
    fn clear_removes_only_the_requested_contact_or_the_complete_store() {
        let path = test_history_path("clear");
        open_and_register(
            &path,
            vec![
                message("a-1", 1, "KEY-A", "a", 1),
                message("a-2", 1, "KEY-A", "a", 2),
                message("b-1", 2, "KEY-B", "b", 3),
            ],
        )
        .unwrap();

        clear_registered(&path, Some((101, "key-a"))).unwrap();
        assert_eq!(
            window_registered(&path, 1, "KEY-A", None, None, None)
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            window_registered(&path, 2, "KEY-B", None, None, None)
                .unwrap()
                .total,
            1
        );

        clear_registered(&path, None).unwrap();
        assert_eq!(
            window_registered(&path, 2, "KEY-B", None, None, None)
                .unwrap()
                .total,
            0
        );
        remove_test_history(&path);
    }

    #[test]
    fn disk_store_scales_to_one_hundred_thousand_rows_with_bounded_access() {
        const ROWS: usize = 100_000;
        const FRIEND_NUMBER: u32 = 73;
        const FRIEND_KEY: &str = "KEY-SCALE-100K";
        const QUERY: &str = "😀rare100k";
        let path = test_history_path("scale-100k");
        let rows = (0..ROWS)
            .map(|index| {
                let text = match index {
                    0 => "head α😀RARE100K end".to_string(),
                    50_000 => "middle-prefix 😀RARE100K end".to_string(),
                    99_999 => "tail 😀RARE100K end".to_string(),
                    _ => format!("ordinary persisted history row {index}"),
                };
                message(
                    format!("scale-{index:06}"),
                    FRIEND_NUMBER,
                    FRIEND_KEY,
                    text,
                    index as u64,
                )
            })
            .collect::<Vec<_>>();

        let write_started = Instant::now();
        let working = open_and_register(&path, rows).unwrap();
        let write_elapsed = write_started.elapsed();
        assert_eq!(working.len(), WORKING_USER_TAIL);
        assert!(working.iter().all(|row| row.id.as_str() >= "scale-099950"));

        let root = store_root(&path).unwrap();
        let (chunk_count, disk_bytes) = {
            let stores = registry().lock().unwrap();
            let store = stores.get(&path).unwrap();
            let contact = find_contact(&store.manifest, FRIEND_NUMBER, FRIEND_KEY).unwrap();
            let mut bytes = profiles::metadata_len(&manifest_path(&root)).unwrap();
            for chunk in &contact.chunks {
                bytes = bytes.saturating_add(
                    profiles::metadata_len(&safe_chunk_path(&root, &chunk.file).unwrap()).unwrap(),
                );
            }
            (contact.chunks.len(), bytes)
        };
        assert_eq!(chunk_count, ROWS.div_ceil(CHUNK_ROWS));
        assert!(disk_bytes > 0, "the scale fixture must exist as real files");

        assert!(unregister(&path));
        let reopen_started = Instant::now();
        let reopened_working = open_and_register(&path, Vec::new()).unwrap();
        let reopen_elapsed = reopen_started.elapsed();
        assert_eq!(reopened_working.len(), WORKING_USER_TAIL);

        let target_started = Instant::now();
        let target = window_registered(
            &path,
            FRIEND_NUMBER,
            FRIEND_KEY,
            Some(1_000),
            None,
            Some("scale-000123"),
        )
        .unwrap();
        let target_elapsed = target_started.elapsed();
        assert_eq!(target.total, ROWS);
        assert_eq!(target.target_index, Some(123));
        assert!(target.messages.len() <= MAX_WINDOW_ROWS);
        assert!(target.messages.iter().any(|row| row.id == "scale-000123"));
        let target_payload_bytes = serde_json::to_vec(&target.messages).unwrap().len();
        assert!(target_payload_bytes <= MAX_WINDOW_COST);

        let tail =
            window_registered(&path, FRIEND_NUMBER, FRIEND_KEY, Some(0), None, None).unwrap();
        assert_eq!(tail.total, ROWS);
        assert!(tail.messages.len() <= MAX_WINDOW_ROWS);
        assert_eq!(tail.messages.last().unwrap().id, "scale-099999");
        assert!(serde_json::to_vec(&tail.messages).unwrap().len() <= MAX_WINDOW_COST);

        let search_started = Instant::now();
        let newest = search_registered(&path, FRIEND_NUMBER, FRIEND_KEY, QUERY, None, 1).unwrap();
        let first_search_elapsed = search_started.elapsed();
        assert_eq!(newest.matches.len(), 1);
        assert_eq!(newest.matches[0].message_id, "scale-099999");
        assert_eq!(newest.matches[0].index, 99_999);
        assert_eq!((newest.matches[0].start, newest.matches[0].end), (5, 15));
        let cursor = newest.next_cursor.clone().expect("older rare matches");
        let appended = message(
            "scale-100000",
            FRIEND_NUMBER,
            FRIEND_KEY,
            "append 😀RARE100K end",
            ROWS as u64,
        );
        upsert_registered(&path, &[appended]).unwrap();
        let older_search_started = Instant::now();
        let older = search_registered(
            &path,
            FRIEND_NUMBER,
            FRIEND_KEY,
            QUERY,
            Some(&cursor),
            MAX_SEARCH_ROWS,
        )
        .unwrap();
        let search_elapsed = first_search_elapsed.saturating_add(older_search_started.elapsed());
        assert_eq!(
            older
                .matches
                .iter()
                .map(|matched| (
                    matched.message_id.as_str(),
                    matched.index,
                    matched.start,
                    matched.end
                ))
                .collect::<Vec<_>>(),
            vec![("scale-050000", 50_000, 14, 24), ("scale-000000", 0, 6, 16),]
        );
        assert!(older.next_cursor.is_none());
        assert!(
            older
                .matches
                .iter()
                .all(|matched| matched.message_id != "scale-100000"),
            "an append after the search snapshot must not enter its cursor"
        );

        let mut dirty = find_message_registered(&path, FRIEND_NUMBER, FRIEND_KEY, "scale-050000")
            .unwrap()
            .unwrap();
        dirty.text = "searchable text changed".to_string();
        upsert_registered(&path, &[dirty]).unwrap();
        let dirty_cursor_error = match search_registered(
            &path,
            FRIEND_NUMBER,
            FRIEND_KEY,
            QUERY,
            Some(&cursor),
            MAX_SEARCH_ROWS,
        ) {
            Ok(_) => panic!("a searchable edit must invalidate the scale cursor"),
            Err(error) => error,
        };
        assert_eq!(dirty_cursor_error, "CHAT_HISTORY_SEARCH_CURSOR_STALE");

        let before_remove = search_registered(&path, FRIEND_NUMBER, FRIEND_KEY, QUERY, None, 1)
            .unwrap()
            .next_cursor
            .expect("search remains pageable before removal");
        assert!(
            remove_message_registered(&path, FRIEND_NUMBER, FRIEND_KEY, "scale-000010").unwrap()
        );
        let removed_cursor_error = match search_registered(
            &path,
            FRIEND_NUMBER,
            FRIEND_KEY,
            QUERY,
            Some(&before_remove),
            MAX_SEARCH_ROWS,
        ) {
            Ok(_) => panic!("a removal must invalidate the scale cursor"),
            Err(error) => error,
        };
        assert_eq!(removed_cursor_error, "CHAT_HISTORY_SEARCH_CURSOR_STALE");

        eprintln!(
            "CHAT_HISTORY_SCALE_100K rows={ROWS} chunks={chunk_count} disk_bytes={disk_bytes} working_rows={} target_rows={} target_payload_bytes={target_payload_bytes} write_ms={} reopen_ms={} target_ms={} full_search_ms={}",
            working.len(),
            target.messages.len(),
            write_elapsed.as_millis(),
            reopen_elapsed.as_millis(),
            target_elapsed.as_millis(),
            search_elapsed.as_millis(),
        );
        remove_test_history(&path);
    }

    #[test]
    fn expired_memory_is_compacted_to_the_protocol_tail() {
        let mut rows = (0..100)
            .map(|index| message(format!("user-{index}"), 5, "KEY-5", "user", index))
            .collect::<Vec<_>>();
        rows.extend((0..40).map(|index| {
            let mut row = message(
                format!("service-{index}"),
                5,
                "KEY-5",
                "service",
                100 + index,
            );
            row.event = Some(crate::PqHistoryEvent {
                kind: "pq".to_string(),
                status: "active".to_string(),
                role: "initiator".to_string(),
                local_fingerprint: String::new(),
                peer_fingerprint: None,
                fingerprint_changed: false,
                error: None,
            });
            row
        }));

        let removed = prune_working_set(&mut rows, &[(55, "key-5".to_string())]);
        assert_eq!(removed, 58);
        assert_eq!(rows.len(), WORKING_USER_TAIL + WORKING_SPECIAL_TAIL);
        assert_eq!(
            rows.iter().filter(|row| row.event.is_none()).count(),
            WORKING_USER_TAIL
        );
        assert_eq!(
            rows.iter().filter(|row| row.event.is_some()).count(),
            WORKING_SPECIAL_TAIL
        );
    }
}
