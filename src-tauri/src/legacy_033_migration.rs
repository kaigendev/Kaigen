//! One-time 0.3.3 conversion; remove this module and its call in 0.3.4.
//! Numeric transport slots never establish a persisted peer's identity.
use super::*;
use crate::kai::KaiProfileVolume;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
const MARKER: &str = "migration-0.3.3.json";
pub(crate) fn public_key(v: &str) -> Option<String> {
    (v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())).then(|| v.to_ascii_uppercase())
}
fn read(volume: &KaiProfileVolume, path: &Path) -> Result<Option<Vec<u8>>, String> {
    match volume.read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e == "KAI_VOLUME_FILE_NOT_FOUND" => Ok(None),
        Err(e) => Err(e),
    }
}
fn value(bytes: &[u8], dropped: &mut u64) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|_| {
        *dropped += 1;
        Value::Null
    })
}
fn version(v: &Value, supported: u64) -> Result<(), String> {
    if v.get("version")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > supported)
    {
        return Err("MIGRATION_033_NEWER_SCHEMA".into());
    }
    Ok(())
}
fn encode(v: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_json::to_vec(v).map_err(|_| "MIGRATION_033_ENCODE_FAILED".into())
}
struct Batch<'a> {
    volume: &'a KaiProfileVolume,
    updates: BTreeMap<PathBuf, Option<Vec<u8>>>,
    dropped: BTreeMap<String, u64>,
    pq_required: BTreeSet<String>,
    blocked_ids: BTreeSet<String>,
    deleted_ids: BTreeSet<String>,
    blocked_operations: BTreeSet<String>,
    opaque_protection: bool,
    cache_candidates: BTreeSet<PathBuf>,
    cache_retained: BTreeSet<PathBuf>,
}
impl Drop for Batch<'_> {
    fn drop(&mut self) {
        for b in self.updates.values_mut().flatten() {
            crate::wipe_sensitive_bytes(b);
        }
    }
}
impl Batch<'_> {
    fn filter_actions(&mut self, value: &mut Value, file_cards: bool) {
        if file_cards {
            if let Some(rows) = value.get_mut("bindings").and_then(Value::as_object_mut) {
                rows.retain(|_, row| {
                    let keep = !row
                        .get("messageId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| self.deleted_ids.contains(id));
                    if !keep {
                        *self.dropped.entry("fileCards".into()).or_default() += 1;
                    }
                    keep
                });
            }
            if let Some(rows) = value.get_mut("outgoing").and_then(Value::as_object_mut) {
                rows.retain(|_, row| {
                    let pending = row.get("acknowledgement").is_none_or(Value::is_null);
                    let id = row
                        .get("offer")
                        .and_then(|v| v.get("messageId"))
                        .and_then(Value::as_str);
                    let keep = !(pending
                        && (self.opaque_protection
                            || id.is_some_and(|id| self.blocked_ids.contains(id))));
                    if !keep {
                        *self.dropped.entry("fileCards".into()).or_default() += 1;
                    }
                    keep
                });
            }
        } else {
            if let Some(rows) = value
                .get_mut("message_operations")
                .and_then(Value::as_object_mut)
            {
                rows.retain(|_, row| {
                    let pending = row.get("delivery").and_then(Value::as_str) == Some("pending");
                    let blocked = row
                        .get("messageId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| self.blocked_ids.contains(id))
                        || row
                            .get("operationId")
                            .and_then(Value::as_str)
                            .is_some_and(|id| self.blocked_operations.contains(id));
                    let keep = !(pending && (self.opaque_protection || blocked));
                    if !keep {
                        *self.dropped.entry("chatProtocol".into()).or_default() += 1;
                    }
                    keep
                });
            }
            if let Some(rows) = value
                .get_mut("reaction_outbox")
                .and_then(Value::as_array_mut)
            {
                rows.retain(|row| {
                    let keep = !self.opaque_protection
                        && !row
                            .get("target_id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| self.blocked_ids.contains(id));
                    if !keep {
                        *self.dropped.entry("chatProtocol".into()).or_default() += 1;
                    }
                    keep
                });
            }
        }
    }

    fn inspect_fences(&mut self, input: &Value) {
        let Some(root) = input.as_object() else {
            self.opaque_protection = true;
            return;
        };
        for field in [
            "cancelled_messages",
            "deleted_messages",
            "deletion_intents",
            "transmission_started",
            "blocked_send_operations",
        ] {
            let Some(values) = root.get(field) else {
                continue;
            };
            let Some(values) = values.as_array() else {
                self.opaque_protection = true;
                continue;
            };
            for value in values {
                let Some((owner, tail)) = value.as_str().and_then(|s| s.split_once(':')) else {
                    self.opaque_protection = true;
                    continue;
                };
                if public_key(owner).is_some() {
                    continue;
                }
                if field == "blocked_send_operations" {
                    if let Some(id) = tail
                        .strip_prefix("message-operation:")
                        .filter(|s| !s.is_empty())
                    {
                        self.blocked_operations.insert(id.to_string());
                    } else {
                        self.opaque_protection = true;
                    }
                } else if !tail.is_empty() {
                    self.blocked_ids.insert(tail.to_string());
                    if matches!(field, "deleted_messages" | "deletion_intents") {
                        self.deleted_ids.insert(tail.to_string());
                    }
                } else {
                    self.opaque_protection = true;
                }
            }
        }
        if let Some(rows) = root.get("message_operations").and_then(Value::as_object) {
            for row in rows.values() {
                if row
                    .get("operationId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| self.blocked_operations.contains(id))
                {
                    if let Some(id) = row
                        .get("messageId")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                    {
                        self.blocked_ids.insert(id.to_string());
                    }
                }
            }
        }
    }
    fn cache_reference(&mut self, directory: &Path, row: &Value, history: bool, retained: bool) {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            return;
        };
        let name = if history {
            if row.get("mine").and_then(Value::as_bool) != Some(true) {
                return;
            }
            row.get("attachment")
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
        } else {
            row.get("filename").and_then(Value::as_str)
        };
        let Some(name) = name else { return };
        let root = directory.join("outgoing-files");
        let path = crate::outgoing_file_cache_path(&root, id, name);
        if path.parent() != Some(root.as_path()) {
            return;
        }
        self.cache_candidates.insert(path.clone());
        if retained {
            self.cache_retained.insert(path);
        }
    }
    fn purge_unreferenced_cache(&mut self, directory: &Path) -> Result<(), String> {
        let root = directory.join("outgoing-files");
        for entry in self.volume.list(&root)? {
            if entry.is_file
                && entry.path.parent() == Some(root.as_path())
                && self.cache_candidates.contains(&entry.path)
                && !self.cache_retained.contains(&entry.path)
            {
                let mut bytes = self.volume.read(&entry.path)?;
                crate::wipe_sensitive_bytes(&mut bytes);
                self.stage(entry.path, None);
                *self.dropped.entry("ownedOutgoingBlobs".into()).or_default() += 1;
            }
        }
        Ok(())
    }

    fn stage(&mut self, p: PathBuf, b: Option<Vec<u8>>) {
        if let Some(Some(mut old)) = self.updates.insert(p, b) {
            crate::wipe_sensitive_bytes(&mut old);
        }
    }
    fn json(&mut self, p: &Path, category: &str) -> Result<Option<Value>, String> {
        let Some(mut b) = read(self.volume, p)? else {
            return Ok(None);
        };
        let v = value(&b, self.dropped.entry(category.into()).or_default());
        crate::wipe_sensitive_bytes(&mut b);
        Ok(Some(v))
    }
    fn array<T: DeserializeOwned + Serialize>(
        &mut self,
        d: &Path,
        name: &str,
        pq: bool,
    ) -> Result<(), String> {
        let p = d.join(name);
        let Some(input) = self.json(&p, name)? else {
            return Ok(());
        };
        version(&input, 1)?;
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        if let Some(rows) = input.as_array() {
            for row in rows {
                self.cache_reference(d, row, false, false);
                let pk = row
                    .get("friend_public_key")
                    .and_then(Value::as_str)
                    .and_then(public_key);
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let (Some(pk), Some(id)) = (pk, id) else {
                    *self.dropped.entry(name.into()).or_default() += 1;
                    continue;
                };
                if self.opaque_protection
                    || self.blocked_ids.contains(&id)
                    || row
                        .get("operation_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| self.blocked_operations.contains(id))
                {
                    *self.dropped.entry(name.into()).or_default() += 1;
                    continue;
                }
                let mut row = row.clone();
                row["friend_public_key"] = Value::String(pk.clone());
                if serde_json::from_value::<T>(row.clone()).is_err()
                    || !seen.insert((pk.clone(), id))
                {
                    *self.dropped.entry(name.into()).or_default() += 1;
                    continue;
                }
                if pq {
                    self.pq_required.insert(pk);
                }
                self.cache_reference(d, &row, false, true);
                out.push(row);
            }
        } else if !input.is_null() {
            *self.dropped.entry(name.into()).or_default() += 1;
        }
        self.stage(p, Some(encode(&out)?));
        Ok(())
    }
    fn history(&mut self, d: &Path) -> Result<(), String> {
        let legacy = d.join("chat-history.json");
        let root = store_root(&legacy)?;
        let mf = manifest_path(&root);
        let mut rows = Vec::<Value>::new();
        let mut generation = 1;
        let mut fences = HashMap::<String, HashSet<String>>::new();
        let mut old = BTreeSet::new();
        // Orphan chunks are owned by this store too; authenticate them before
        // retiring them in the same generation as the replacement manifest.
        for entry in self.volume.list(&root)? {
            let name = entry
                .path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("");
            if entry.is_file && name.starts_with("chunk-") && name.ends_with(".json") {
                let mut bytes = self.volume.read(&entry.path)?;
                crate::wipe_sensitive_bytes(&mut bytes);
                old.insert(entry.path);
            }
        }
        if let Some(input) = self.json(&mf, "history")? {
            version(&input, STORE_VERSION as u64)?;
            let manifest = serde_json::from_value::<StoreManifest>(input)
                .ok()
                .filter(|manifest| validate_manifest(manifest).is_ok());
            if let Some(m) = manifest {
                generation = m
                    .generation
                    .checked_add(1)
                    .ok_or("MIGRATION_033_GENERATION_OVERFLOW")?;
                for c in m.contacts {
                    for chunk in c.chunks {
                        let p = safe_chunk_path(&root, &chunk.file)?;
                        let mut b = read(self.volume, &p)?.ok_or("CHAT_HISTORY_CHUNK_MISSING")?;
                        if !sha256_hex(&b).eq_ignore_ascii_case(&chunk.sha256) {
                            crate::wipe_sensitive_bytes(&mut b);
                            return Err("CHAT_HISTORY_CHUNK_INTEGRITY_FAILED".into());
                        }
                        let parsed = value(&b, self.dropped.entry("history".into()).or_default());
                        crate::wipe_sensitive_bytes(&mut b);
                        if let Value::Array(r) = parsed {
                            if r.len() != chunk.rows {
                                return Err("CHAT_HISTORY_CHUNK_COUNT_MISMATCH".into());
                            }
                            for row in r {
                                self.cache_reference(d, &row, true, false);
                                let own = row
                                    .get("friend_public_key")
                                    .and_then(Value::as_str)
                                    .and_then(public_key);
                                let manifest_owner = public_key(&c.friend_public_key);
                                if own
                                    .as_ref()
                                    .zip(manifest_owner.as_ref())
                                    .is_some_and(|(a, b)| a != b)
                                {
                                    *self.dropped.entry("history".into()).or_default() += 1;
                                } else {
                                    rows.push(row);
                                }
                            }
                        }
                        old.insert(p);
                    }
                }
                for (k, ids) in m.deleted_messages {
                    if let Some(pk) = public_key(&k) {
                        fences
                            .entry(pk)
                            .or_default()
                            .extend(ids.into_iter().filter(|id| !id.is_empty()));
                    } else {
                        *self.dropped.entry("historyFences".into()).or_default() +=
                            ids.len() as u64;
                    }
                }
            } else {
                *self.dropped.entry("history".into()).or_default() += 1;
                for e in self.volume.list(&root)? {
                    let n = e.path.file_name().and_then(|v| v.to_str()).unwrap_or("");
                    if e.is_file && n.starts_with("chunk-") && n.ends_with(".json") {
                        let mut b = self.volume.read(&e.path)?;
                        crate::wipe_sensitive_bytes(&mut b);
                        old.insert(e.path);
                    }
                }
            }
        } else if let Some(input) = self.json(&legacy, "history")? {
            version(&input, 1)?;
            if let Value::Array(r) = input {
                rows = r;
            }
        }
        let mut groups = BTreeMap::<String, Vec<ToxMessage>>::new();
        let mut seen = BTreeSet::new();
        for r in rows {
            self.cache_reference(d, &r, true, false);
            let id = r.get("id").and_then(Value::as_str).unwrap_or("");
            if self.deleted_ids.contains(id)
                || (r.get("mine").and_then(Value::as_bool) == Some(true)
                    && r.get("delivery").and_then(Value::as_str) == Some("pending")
                    && (self.opaque_protection || self.blocked_ids.contains(id)))
            {
                *self.dropped.entry("history".into()).or_default() += 1;
                continue;
            }
            let raw = r.clone();
            let Ok(mut r) = serde_json::from_value::<ToxMessage>(r) else {
                *self.dropped.entry("history".into()).or_default() += 1;
                continue;
            };
            let Some(pk) = public_key(&r.friend_public_key) else {
                *self.dropped.entry("history".into()).or_default() += 1;
                continue;
            };
            if r.id.is_empty() || !seen.insert((pk.clone(), r.id.clone())) {
                *self.dropped.entry("history".into()).or_default() += 1;
                continue;
            }
            self.cache_reference(d, &raw, true, true);
            r.friend_public_key = pk.clone();
            groups.entry(pk).or_default().push(r);
        }
        let mut m = StoreManifest {
            version: STORE_VERSION,
            generation,
            chunk_rows: CHUNK_ROWS,
            contacts: Vec::new(),
            deleted_messages: fences,
        };
        for (pk, mut rows) in groups {
            rows.sort_by_key(|r| r.timestamp);
            let mut c = ContactManifest {
                friend_number: rows[0].friend_number,
                friend_public_key: pk,
                revision: generation,
                search_epoch: generation,
                last_event: rows.iter().map(|r| r.timestamp).max(),
                total: rows.len(),
                chunks: Vec::new(),
            };
            for (i, r) in rows.chunks(CHUNK_ROWS).enumerate() {
                let b = encode(&r)?;
                let digest = sha256_hex(&b);
                let slug = contact_slug(c.friend_number, &c.friend_public_key);
                let file = format!(
                    "chunk-{slug}-{generation:016x}-{i:08x}-{}.json",
                    &digest[..16]
                );
                let p = safe_chunk_path(&root, &file)?;
                old.remove(&p);
                self.stage(p, Some(b));
                c.chunks.push(ChunkManifest {
                    file,
                    rows: r.len(),
                    user_rows: r.iter().filter(|r| r.event.is_none()).count(),
                    special_rows: r
                        .iter()
                        .filter(|r| r.event.is_some() || r.attachment.is_some())
                        .count(),
                    id_bloom: id_bloom(r),
                    sha256: digest,
                });
            }
            m.contacts.push(c);
        }
        validate_manifest(&m)?;
        for p in old {
            self.stage(p, None);
        }
        self.stage(legacy, None);
        self.stage(mf, Some(encode(&m)?));
        Ok(())
    }
}
/// Runs under the actual self-Tox identity lease, before any store reader exists.
pub(crate) fn run(
    volume: &KaiProfileVolume,
    d: &Path,
    profile_id: Option<&str>,
    self_key: &str,
) -> Result<(), String> {
    let self_key = public_key(self_key).ok_or("MIGRATION_033_OWNER_INVALID")?;
    let marker = d.join(MARKER);
    if let Some(b) = read(volume, &marker)? {
        let v: Value = serde_json::from_slice(&b).map_err(|_| "MIGRATION_033_MARKER_INVALID")?;
        if v.get("version").and_then(Value::as_u64) != Some(1)
            || v.get("release").and_then(Value::as_str) != Some("0.3.3")
            || v.get("complete").and_then(Value::as_bool) != Some(true)
        {
            return Err("MIGRATION_033_MARKER_UNSUPPORTED".into());
        }
        if v.get("owner").and_then(Value::as_str) != Some(self_key.as_str()) {
            return Err("MIGRATION_033_OWNER_MISMATCH".into());
        }
        return Ok(());
    }
    let mut batch = Batch {
        volume,
        updates: BTreeMap::new(),
        dropped: BTreeMap::new(),
        pq_required: BTreeSet::new(),
        blocked_ids: BTreeSet::new(),
        deleted_ids: BTreeSet::new(),
        blocked_operations: BTreeSet::new(),
        opaque_protection: false,
        cache_candidates: BTreeSet::new(),
        cache_retained: BTreeSet::new(),
    };
    let chat_path = d.join("chat-protocol-v1.json");
    let chat_input = batch.json(&chat_path, "chatProtocol")?;
    if let Some(input) = &chat_input {
        version(input, 1)?;
        batch.inspect_fences(input);
    }
    batch.history(d)?;
    batch.array::<crate::PendingToxMessage>(d, "pending-messages.json", false)?;
    batch.array::<crate::PendingToxMessage>(d, "pending-pq-messages.json", true)?;
    batch.array::<crate::PendingToxFile>(d, "pending-files.json", false)?;
    let p = d.join("local-state.json");
    if let Some(v) = batch.json(&p, "localState")? {
        let v = convert_local_state(
            v,
            profile_id,
            batch.dropped.entry("localState".into()).or_default(),
        )?;
        let mut v = v;
        if let Some(ops) = v
            .get_mut("pendingSendOperations")
            .and_then(Value::as_object_mut)
        {
            ops.retain(|id, _| {
                let keep = !batch.opaque_protection && !batch.blocked_operations.contains(id);
                if !keep {
                    *batch.dropped.entry("localState".into()).or_default() += 1;
                }
                keep
            });
        }
        batch.stage(p, Some(encode(&v)?));
    }
    let p = chat_path;
    if let Some(mut v) = chat_input {
        batch.filter_actions(&mut v, false);
        let v = crate::chat_protocol::migrate_legacy_033(
            v,
            batch.dropped.entry("chatProtocol".into()).or_default(),
            &mut batch.pq_required,
        )?;
        batch.stage(p, Some(encode(&v)?));
    }
    let p = d.join("file-card-protocol-v1.json");
    if let Some(mut v) = batch.json(&p, "fileCards")? {
        batch.filter_actions(&mut v, true);
        let v = crate::file_card_protocol::migrate_legacy_033(
            v,
            batch.dropped.entry("fileCards".into()).or_default(),
            &mut batch.pq_required,
        )?;
        batch.stage(p, Some(encode(&v)?));
    }
    if let Some(Some(bytes)) = batch.updates.get(&d.join("file-card-protocol-v1.json")) {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| "MIGRATION_033_ENCODE_FAILED")?;
        if let Some(rows) = value.get("bindings").and_then(Value::as_object) {
            for row in rows.values() {
                let synthetic = json!({"id":row.get("messageId"),"filename":row.get("filename")});
                batch.cache_reference(d, &synthetic, false, true);
            }
        }
    }
    migrate_auxiliary(&mut batch, d)?;
    batch.purge_unreferenced_cache(d)?;
    let ip = d.join("pq-identity.json");
    let sp = d.join("pq-sessions-v2.json");
    let mut identity = read(volume, &ip)?;
    let mut sessions = read(volume, &sp)?;
    let converted = crate::pq::migrate_legacy_033(
        identity.as_deref(),
        sessions.as_deref(),
        &self_key,
        &batch.pq_required,
        &batch.blocked_ids,
        batch.opaque_protection,
    );
    if let Some(b) = identity.as_mut() {
        crate::wipe_sensitive_bytes(b);
    }
    if let Some(b) = sessions.as_mut() {
        crate::wipe_sensitive_bytes(b);
    }
    let (keep, sessions, dropped, reset) = converted?;
    if !keep {
        batch.stage(ip, None);
    }
    batch.stage(sp, Some(sessions));
    batch.dropped.insert("pqMaterial".into(), dropped);
    batch.dropped.insert("pqRegeneration".into(), reset);
    let trust = d.join("pq-contacts.json");
    if let Some(mut b) = read(volume, &trust)? {
        let v = value(&b, batch.dropped.entry("legacyPqTrust".into()).or_default());
        crate::wipe_sensitive_bytes(&mut b);
        version(&v, 1)?;
        let count = v
            .get("fingerprints")
            .and_then(Value::as_object)
            .map_or(0, |v| v.len())
            + v.get("quarantined_fingerprints")
                .and_then(Value::as_array)
                .map_or(0, |v| v.len());
        *batch.dropped.entry("legacyPqTrust".into()).or_default() += count as u64;
        batch.stage(trust, None);
    }
    let report = encode(
        &json!({"version":1,"release":"0.3.3","owner":self_key,"complete":true,"dropped":batch.dropped,"pqRegenerationRequiredPeerCount":reset}),
    )?;
    batch.stage(marker, Some(report));
    let updates = std::mem::take(&mut batch.updates)
        .into_iter()
        .collect::<Vec<_>>();
    let result = volume.write_files_checkpointed(&updates);
    for (_, b) in updates {
        if let Some(mut b) = b {
            crate::wipe_sensitive_bytes(&mut b);
        }
    }
    result
}
fn migrate_auxiliary(batch: &mut Batch<'_>, d: &Path) -> Result<(), String> {
    let path = d.join("friend-profiles.json");
    if let Some(input) = batch.json(&path, "friendProfiles")? {
        version(&input, 1)?;
        let mut out = serde_json::Map::new();
        let mut collisions = BTreeSet::new();
        if let Some(rows) = input.as_object() {
            for (key, row) in rows {
                let Some(key) = public_key(key) else {
                    *batch.dropped.entry("friendProfiles".into()).or_default() += 1;
                    continue;
                };
                let Ok(profile) = serde_json::from_value::<crate::CachedFriendProfile>(row.clone())
                else {
                    *batch.dropped.entry("friendProfiles".into()).or_default() += 1;
                    continue;
                };
                if !profile.tox_id.is_empty()
                    && (!profile.tox_id.is_ascii()
                        || !profile
                            .tox_id
                            .get(..64)
                            .is_some_and(|id| id.eq_ignore_ascii_case(&key)))
                {
                    *batch.dropped.entry("friendProfiles".into()).or_default() += 1;
                    continue;
                }
                if out.contains_key(&key) {
                    collisions.insert(key.clone());
                }
                out.insert(key, row.clone());
            }
        }
        for key in collisions {
            out.remove(&key);
            *batch.dropped.entry("friendProfiles".into()).or_default() += 2;
        }
        batch.stage(path, Some(encode(&out)?));
    }
    let path = d.join("incoming-friend-requests.json");
    if let Some(input) = batch.json(&path, "friendRequests")? {
        version(&input, 1)?;
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        if let Some(rows) = input.as_array() {
            for row in rows {
                let Ok(mut row) =
                    serde_json::from_value::<crate::IncomingFriendRequest>(row.clone())
                else {
                    *batch.dropped.entry("friendRequests".into()).or_default() += 1;
                    continue;
                };
                let Some(key) = public_key(&row.public_key) else {
                    *batch.dropped.entry("friendRequests".into()).or_default() += 1;
                    continue;
                };
                if !seen.insert(key.clone()) {
                    *batch.dropped.entry("friendRequests".into()).or_default() += 1;
                    continue;
                }
                row.public_key = key;
                out.push(row);
            }
        }
        batch.stage(path, Some(encode(&out)?));
    }
    let path = d.join("unread-events.json");
    if let Some(input) = batch.json(&path, "unread")? {
        version(&input, 1)?;
        let mut unread = serde_json::from_value::<crate::UnreadState>(input).unwrap_or_else(|_| {
            *batch.dropped.entry("unread".into()).or_default() += 1;
            crate::UnreadState::default()
        });
        unread.friends.retain(|key, _| {
            let keep = key
                .strip_prefix("friend-key:")
                .and_then(public_key)
                .is_some();
            if !keep {
                *batch.dropped.entry("unread".into()).or_default() += 1;
            }
            keep
        });
        unread.requests.retain(|key| {
            let keep = public_key(key).is_some();
            if !keep {
                *batch.dropped.entry("unread".into()).or_default() += 1;
            }
            keep
        });
        unread.unseen_messages.retain(|key, ids| {
            let keep = key
                .strip_prefix("friend-key:")
                .and_then(public_key)
                .is_some();
            if !keep {
                *batch.dropped.entry("unread".into()).or_default() += 1;
            }
            ids.retain(|id| !id.is_empty());
            keep
        });
        for (key, ids) in &unread.unseen_messages {
            unread
                .friends
                .insert(key.clone(), ids.len().min(u32::MAX as usize) as u32);
        }
        unread.incoming_event_revision_by_target.retain(|key, _| {
            let keep = key == "requests"
                || key
                    .strip_prefix("friend-key:")
                    .and_then(public_key)
                    .is_some();
            if !keep {
                *batch.dropped.entry("unread".into()).or_default() += 1;
            }
            keep
        });
        batch.stage(path, Some(encode(&unread)?));
    }
    let avatars = d.join("avatars");
    for entry in batch.volume.list(&avatars)? {
        let name = entry
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if entry.is_file
            && (name
                .split_once('-')
                .is_some_and(|(n, _)| n.parse::<u32>().is_ok())
                || name.starts_with(".kaigen-avatar-remap-"))
        {
            let mut bytes = batch.volume.read(&entry.path)?;
            crate::wipe_sensitive_bytes(&mut bytes);
            batch.stage(entry.path, None);
            *batch.dropped.entry("avatars".into()).or_default() += 1;
        } else if !entry.is_file && name == ".kaigen-avatar-orphans" {
            // This fixed core-owned directory contains only retired peer avatars.
            let mut pending = vec![entry.path];
            while let Some(directory) = pending.pop() {
                for entry in batch.volume.list(&directory)? {
                    if entry.is_file {
                        let mut bytes = batch.volume.read(&entry.path)?;
                        crate::wipe_sensitive_bytes(&mut bytes);
                        batch.stage(entry.path, None);
                        *batch.dropped.entry("avatars".into()).or_default() += 1;
                    } else {
                        pending.push(entry.path);
                    }
                }
            }
        }
    }
    Ok(())
}

// Candidate only. The caller must already own/authenticate this profile and must
// commit this result with the 0.3.3 marker and all other stores atomically.
// This cannot recover provenance already lost by an older numeric backfill.
pub(crate) fn convert_local_state(
    value: serde_json::Value,
    profile_id: Option<&str>,
    dropped: &mut u64,
) -> Result<serde_json::Value, String> {
    use serde_json::{Map, Value};
    use std::collections::BTreeMap;

    fn count(dropped: &mut u64, amount: usize) {
        *dropped = dropped.saturating_add(amount as u64);
    }
    fn public_key(value: &str) -> Option<String> {
        (value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| value.to_ascii_uppercase())
    }
    fn tox_suffix(value: &str) -> Option<&str> {
        value
            .get(..4)
            .filter(|prefix| prefix.eq_ignore_ascii_case("tox-"))?;
        value.get(4..)
    }
    fn canonical_chat(value: &str) -> Option<String> {
        public_key(tox_suffix(value)?).map(|key| format!("tox-{key}"))
    }
    fn legacy_numeric_chat(value: &str) -> bool {
        // A 64-digit public key is stable, even when every digit is numeric.
        canonical_chat(value).is_none()
            && tox_suffix(value).is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
            })
    }
    fn check_version(object: &Map<String, Value>) -> Result<(), String> {
        if object
            .get("version")
            .and_then(Value::as_f64)
            .is_some_and(|n| n > 1.0)
        {
            return Err("LOCAL_STATE_VERSION_UNSUPPORTED".into());
        }
        Ok(())
    }
    fn safe_revision(value: &Value) -> bool {
        value.as_f64().is_some_and(|n| {
            n.is_finite() && n >= 0.0 && n <= 9_007_199_254_740_991.0 && n.fract() == 0.0
        })
    }
    fn formatting(value: &Value) -> bool {
        value.as_array().is_some_and(|spans| {
            spans.iter().all(|span| {
                matches!(
                    span.get("kind").and_then(Value::as_str),
                    Some("bold" | "underline" | "italic" | "strikethrough")
                ) && span
                    .get("offsetUtf16")
                    .and_then(Value::as_f64)
                    .is_some_and(f64::is_finite)
                    && span
                        .get("lengthUtf16")
                        .and_then(Value::as_f64)
                        .is_some_and(f64::is_finite)
            })
        })
    }
    fn quote(value: &Value) -> bool {
        value.is_object()
            && value.get("author").is_some_and(Value::is_string)
            && value.get("text").is_some_and(Value::is_string)
            && value.get("messageId").is_none_or(Value::is_string)
            && value.get("legacy").is_none_or(Value::is_boolean)
    }
    fn map_value_valid(field: &str, value: &Value) -> bool {
        match field {
            "contactNames" | "drafts" => value.is_string(),
            "draftFormatting" => formatting(value),
            "draftQuotes" => quote(value),
            "scrollAnchors" => {
                value.is_object()
                    && value.get("messageKey").is_some_and(Value::is_string)
                    && value
                        .get("offset")
                        .and_then(Value::as_f64)
                        .is_some_and(f64::is_finite)
                    && value.get("atBottom").is_some_and(Value::is_boolean)
            }
            "peerReactionNotices" => {
                value.get("through").is_some_and(safe_revision)
                    && value
                        .get("notices")
                        .and_then(Value::as_array)
                        .is_some_and(|rows| {
                            rows.iter().all(|row| {
                                row.get("messageKey")
                                    .and_then(Value::as_str)
                                    .is_some_and(|id| {
                                        id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
                                    })
                                    && row.get("revision").is_some_and(safe_revision)
                                    && matches!(
                                        row.get("reaction").and_then(Value::as_str),
                                        Some(
                                            "thumbs_up"
                                                | "thumbs_down"
                                                | "grin"
                                                | "sad"
                                                | "heart"
                                                | "rocket"
                                        )
                                    )
                                    && row.get("removed").is_some_and(Value::is_boolean)
                            })
                        })
            }
            _ => true,
        }
    }
    fn convert_map(input: Value, bare_keys: bool, field: &str, dropped: &mut u64) -> Value {
        let Value::Object(entries) = input else {
            count(dropped, 1);
            return Value::Object(Map::new());
        };
        let mut groups = BTreeMap::<String, Vec<(String, Value)>>::new();
        for (old, value) in entries {
            if (bare_keys && !value.is_string()) || (!bare_keys && !map_value_valid(field, &value))
            {
                count(dropped, 1);
                continue;
            }
            let stable = if bare_keys {
                public_key(&old).or_else(|| canonical_chat(&old).map(|chat| chat[4..].to_owned()))
            } else if tox_suffix(&old).is_some() {
                canonical_chat(&old)
            } else if !old.is_empty() {
                // Unrelated scopes, such as local notes, have no Tox inference.
                Some(old.clone())
            } else {
                None
            };
            if let Some(stable) = stable {
                groups.entry(stable).or_default().push((old, value));
            } else {
                count(dropped, 1);
            }
        }
        let mut output = Map::new();
        for (stable, mut rows) in groups {
            let preferred = rows.iter().position(|(old, _)| old == &stable);
            if rows.len() == 1
                || preferred.is_some()
                || rows.iter().all(|(_, value)| value == &rows[0].1)
            {
                let index = preferred.unwrap_or(0);
                let (_, value) = rows.swap_remove(index);
                count(dropped, rows.len());
                output.insert(stable, value);
            } else {
                // Conflicting case aliases have no reliable winning draft.
                count(dropped, rows.len());
            }
        }
        Value::Object(output)
    }

    let Value::Object(mut state) = value else {
        count(dropped, 1);
        return Ok(Value::Object(Map::new()));
    };
    check_version(&state)?;
    if let Some(groups) = state.get("contactGroups").and_then(Value::as_object) {
        check_version(groups)?;
    }
    if let Some(active) = state.get_mut("activeChat") {
        let replacement = match active.as_str() {
            Some(chat) if tox_suffix(chat).is_some() => canonical_chat(chat),
            Some(chat) => Some(chat.to_owned()),
            None => None,
        };
        if let Some(stable) = replacement {
            *active = Value::String(stable);
        } else {
            *active = Value::String(String::new());
            count(dropped, 1);
        }
    }
    for field in [
        "contactNames",
        "drafts",
        "draftFormatting",
        "draftQuotes",
        "scrollAnchors",
        "peerReactionNotices",
    ] {
        if let Some(entries) = state.remove(field) {
            state.insert(field.into(), convert_map(entries, false, field, dropped));
        }
    }
    if let Some(groups) = state.get_mut("contactGroups") {
        if let Some(groups) = groups.as_object_mut() {
            check_version(groups)?;
            if let Some(assignments) = groups.remove("assignments") {
                groups.insert(
                    "assignments".into(),
                    convert_map(assignments, true, "assignments", dropped),
                );
            }
            // `order` and `collapsed` contain group IDs, not peer chat IDs.
            // Keep group definitions, names, IDs and preferences unchanged.
        } else {
            *groups = Value::Null;
            count(dropped, 1);
        }
    }
    if let Some(operations) = state.remove("pendingSendOperations") {
        let mut output = Map::new();
        if let Value::Object(entries) = operations {
            for (id, operation) in entries {
                let Some(mut operation) = operation.as_object().cloned() else {
                    count(dropped, 1);
                    continue;
                };
                let own_profile = operation.get("profileId").and_then(Value::as_str);
                let own_key = operation
                    .get("expectedPublicKey")
                    .and_then(Value::as_str)
                    .and_then(public_key);
                let chat = operation.get("chatId").and_then(Value::as_str);
                let owner_matches = profile_id
                    .filter(|p| !p.is_empty())
                    .is_some_and(|p| own_profile == Some(p));
                let own_id = operation.get("operationId").and_then(Value::as_str);
                let route_valid = operation
                    .get("friendNumber")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n <= u32::MAX as u64);
                let shape_valid = operation.get("text").is_some_and(Value::is_string)
                    && operation.get("formatting").is_none_or(formatting)
                    && operation.get("quote").is_none_or(quote);
                let stable = own_key.as_ref().map(|key| format!("tox-{key}"));
                let chat_matches = chat.is_some_and(|chat| {
                    canonical_chat(chat).as_ref() == stable.as_ref() || legacy_numeric_chat(chat)
                });
                let id_valid = !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'));
                if !owner_matches
                    || own_key.is_none()
                    || stable.is_none()
                    || !chat_matches
                    || !id_valid
                    || own_id != Some(id.as_str())
                    || !route_valid
                    || !shape_valid
                {
                    count(dropped, 1);
                    continue;
                }
                operation.insert("expectedPublicKey".into(), Value::String(own_key.unwrap()));
                operation.insert("chatId".into(), Value::String(stable.unwrap()));
                output.insert(id, Value::Object(operation));
            }
        } else {
            count(dropped, 1);
        }
        state.insert("pendingSendOperations".into(), Value::Object(output));
    }
    if let Some(requests) = state.remove("outgoingFriendRequests") {
        let mut output = Vec::new();
        if let Value::Array(requests) = requests {
            for request in requests {
                let Some(mut request) = request.as_object().cloned() else {
                    count(dropped, 1);
                    continue;
                };
                // Current OutgoingFriendRequest is exactly { toxId, message }.
                // This retains its own complete address, never a current slot.
                let address = request
                    .get("toxId")
                    .and_then(Value::as_str)
                    .filter(|id| id.len() == 76 && id.bytes().all(|b| b.is_ascii_hexdigit()));
                if let Some(address) =
                    address.filter(|_| request.get("message").is_some_and(Value::is_string))
                {
                    let address = address.to_ascii_uppercase();
                    request.insert("toxId".into(), Value::String(address));
                    output.push(Value::Object(request));
                } else {
                    count(dropped, 1);
                }
            }
        } else {
            count(dropped, 1);
        }
        state.insert("outgoingFriendRequests".into(), Value::Array(output));
    }
    Ok(Value::Object(state))
}
