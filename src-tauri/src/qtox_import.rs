use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{
    chat_history_store, profiles, qtox_history, qtox_settings, ToxAttachment, ToxMessage, ToxState,
};

const IMPORT_BATCH_ROWS: usize = 1_024;
// c-toxcore's stable Saved_Friend wire record, including its explicit padding.
const SAVED_FRIEND_BYTES: usize = 2_216;

pub(crate) struct ImportedContacts {
    relationships: HashMap<Vec<u8>, (bool, String)>,
    aliases: HashMap<Vec<u8>, String>,
}

#[derive(Default, Debug, Serialize)]
pub(crate) struct ImportReport {
    pub contacts: usize,
    pub aliases: usize,
    pub history_rows: usize,
    pub imported_rows: usize,
    pub unmatched_rows: usize,
    pub unmatched_chats: usize,
}

pub(crate) fn read_contacts(
    profile_path: &Path,
    password: Option<&str>,
    savedata: &[u8],
) -> Result<ImportedContacts, String> {
    Ok(ImportedContacts {
        relationships: saved_friend_relationships(savedata)?,
        aliases: qtox_settings::read_friend_aliases(profile_path, password)?,
    })
}

fn saved_friend_relationships(savedata: &[u8]) -> Result<HashMap<Vec<u8>, (bool, String)>, String> {
    let invalid = || "QTOX_CONTACT_DATA_INVALID".to_string();
    if savedata.get(..8) != Some(&[0, 0, 0, 0, 0x1f, 0x1b, 0xed, 0x15]) {
        return Err(invalid());
    }
    let mut remaining = &savedata[8..];
    let mut friends = HashMap::new();
    while !remaining.is_empty() {
        if remaining.len() < 8 {
            return Err(invalid());
        }
        let length = u32::from_le_bytes(remaining[..4].try_into().unwrap()) as usize;
        let kind = u16::from_le_bytes(remaining[4..6].try_into().unwrap());
        if remaining[6..8] != [0xce, 0x01] || length > remaining.len() - 8 {
            return Err(invalid());
        }
        let bytes = &remaining[8..8 + length];
        remaining = &remaining[8 + length..];
        // tox_get_savedata_size may reserve padding after the end section.
        // Match toxcore's loader: END terminates the stream, not its buffer.
        if kind == 255 {
            if length != 0 {
                return Err(invalid());
            }
            break;
        }
        if kind != 3 {
            continue;
        }
        if bytes.len() % SAVED_FRIEND_BYTES != 0 {
            return Err(invalid());
        }
        for friend in bytes.chunks_exact(SAVED_FRIEND_BYTES) {
            let status = friend[0];
            if status == 0 {
                continue;
            }
            let confirmed = status >= 3;
            let message = if confirmed {
                String::new()
            } else {
                let length = u16::from_be_bytes(friend[1058..1060].try_into().unwrap()) as usize;
                if length > 1024 {
                    return Err(invalid());
                }
                crate::sanitize_untrusted_text(&String::from_utf8_lossy(&friend[33..33 + length]))
            };
            if friends
                .insert(friend[1..33].to_vec(), (confirmed, message))
                .is_some()
            {
                return Err(invalid());
            }
        }
    }
    Ok(friends)
}

/// Called before the new profile is published in the registry or connected.
/// Only existing profile-store APIs write history, preserving its encryption,
/// chunk checksums, stable public-key identity, and bounded working set.
pub(crate) fn import_profile_data(
    tox: &ToxState,
    contacts: &ImportedContacts,
    history_source: Option<&Path>,
    portable_root: &Path,
    password: Option<&str>,
    self_key: &[u8; 32],
    friends: &HashMap<Vec<u8>, u32>,
) -> Result<ImportReport, String> {
    if contacts.relationships.len() != friends.len()
        || contacts
            .relationships
            .keys()
            .any(|key| !friends.contains_key(key))
    {
        return Err("QTOX_CONTACT_COUNT_MISMATCH".to_string());
    }
    let mut report = ImportReport {
        contacts: friends.len(),
        ..ImportReport::default()
    };
    let cache_write = {
        let mut cache = tox
            .friend_cache
            .lock()
            .map_err(|_| "Could not import qTox contact names".to_string())?;
        for (key, number) in friends {
            let entry = cache.entry(crate::hex_upper(key)).or_default();
            entry.friend_number = Some(*number);
            let (authorized, message) = &contacts.relationships[key];
            entry.authorized = *authorized;
            entry.pending_authorization = !*authorized;
            entry.authorization_message = message.clone();
            if let Some(alias) = contacts.aliases.get(key) {
                entry.local_alias = alias.clone();
                report.aliases += 1;
            }
        }
        crate::enqueue_friend_cache_write_required(&cache, &tox.friend_cache_path)?
    };
    crate::wait_for_atomic_write(cache_write)?;
    if let Some(history) = history_source {
        let mut batch = Vec::with_capacity(IMPORT_BATCH_ROWS);
        let mut unmatched_chats = HashSet::new();
        report.history_rows =
            qtox_history::visit_qtox_history(history, portable_root, password, self_key, |row| {
                let Some(friend_number) = friends.get(&row.chat_key).copied() else {
                    // A qTox database can retain chats for deleted contacts. Do not
                    // silently turn them into new network contacts; retain source
                    // DB in the container and record exact unmatched counts.
                    report.unmatched_rows += 1;
                    unmatched_chats.insert(row.chat_key);
                    return Ok(());
                };
                batch.push(convert_row(
                    row,
                    friend_number,
                    self_key,
                    &tox.downloads_dir,
                ));
                report.imported_rows += 1;
                if batch.len() == IMPORT_BATCH_ROWS {
                    chat_history_store::upsert_registered(&tox.history_path, &batch)?;
                    batch.clear();
                }
                Ok(())
            })?;
        chat_history_store::upsert_registered(&tox.history_path, &batch)?;
        report.unmatched_chats = unmatched_chats.len();
        // Imported rows are complete historical events, with no live delivery
        // work. Chat windows read them from the store on demand, just as after
        // a cold profile open; do not retain tails for every imported contact.
        crate::bump_history_revision(&tox.history_path);
    }
    profiles::write_file(
        &tox.friend_cache_path
            .with_file_name("qtox-import-report.json"),
        &serde_json::to_vec(&report).map_err(|error| error.to_string())?,
    )?;
    Ok(report)
}

fn convert_row(
    row: qtox_history::ImportedHistoryRow,
    friend_number: u32,
    self_key: &[u8; 32],
    downloads_dir: &Path,
) -> ToxMessage {
    let timestamp = (row.timestamp_ms.max(0) as u64) / 1000;
    let attachment = row.file_name.as_ref().map(|file_name| {
        let file_name = crate::safe_file_name(file_name);
        let source_path = row.file_path.as_ref().map(PathBuf::from);
        let portable_path = source_path
            .as_ref()
            .filter(|path| path.is_file())
            .and_then(|path| {
                let destination = crate::unique_download_path(downloads_dir, &file_name);
                fs::copy(path, &destination).ok().map(|_| destination)
            });
        ToxAttachment {
            name: file_name.clone(),
            size: row.file_size,
            mime: "application/octet-stream".to_string(),
            path: portable_path
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            preview_source: None,
            image: crate::is_image_name(&file_name),
            transferred: row.file_size,
            speed_bytes_per_sec: 0,
            eta_seconds: None,
            transfer_state: "complete".to_string(),
            completed: true,
            completed_at: Some(timestamp),
            transfer_error: None,
            retry_count: 0,
        }
    });
    ToxMessage {
        id: format!("qtox-{}", row.source_id),
        friend_number,
        friend_public_key: crate::hex_upper(&row.chat_key),
        text: crate::sanitize_untrusted_text(&row.text),
        mine: row.sender_key == self_key,
        timestamp,
        delivery: "delivered".to_string(),
        delivered_at: Some(timestamp),
        attachment,
        event: None,
        protocol_version: None,
        operation_id: None,
        quote: None,
        formatting: Vec::new(),
        pq_protected: false,
        reactions: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_friend_relationships_keep_confirmed_and_pending_separate() {
        let mut bytes = vec![0, 0, 0, 0, 0x1f, 0x1b, 0xed, 0x15];
        bytes.extend_from_slice(&(2 * SAVED_FRIEND_BYTES as u32).to_le_bytes());
        bytes.extend_from_slice(&[3, 0, 0xce, 0x01]);
        let mut friend = vec![0; SAVED_FRIEND_BYTES];
        friend[0] = 3;
        friend[1..33].fill(0xAB);
        bytes.extend_from_slice(&friend);
        friend[0] = 1;
        friend[1..33].fill(0xCD);
        friend[33..38].copy_from_slice(b"hello");
        friend[1058..1060].copy_from_slice(&5u16.to_be_bytes());
        bytes.extend_from_slice(&friend);
        let relationships = saved_friend_relationships(&bytes).unwrap();
        assert_eq!(relationships[&vec![0xAB; 32]], (true, String::new()));
        assert_eq!(relationships[&vec![0xCD; 32]], (false, "hello".to_string()));
        let mut padded = bytes.clone();
        padded.extend_from_slice(&[0, 0, 0, 0, 255, 0, 0xce, 0x01]);
        padded.resize(padded.len() + 824, 0);
        assert_eq!(saved_friend_relationships(&padded).unwrap(), relationships);
        bytes.pop();
        assert!(saved_friend_relationships(&bytes).is_err());
    }
}
