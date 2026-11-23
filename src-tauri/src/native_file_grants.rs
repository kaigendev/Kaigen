use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

use serde::Serialize;

const DEFAULT_GRANT_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_MAX_GRANTS: usize = 8;
const DEFAULT_MAX_AGGREGATE_BYTES: u64 = 5 * 25 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeFileSelection {
    pub(crate) grant_token: String,
    pub(crate) name: String,
    pub(crate) mime: String,
    pub(crate) size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeFileCandidate {
    pub(crate) name: String,
    pub(crate) size: u64,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct NativeFileRejection {
    pub(crate) file: NativeFileCandidate,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeFileBatchSelection {
    pub(crate) accepted: Vec<NativeFileSelection>,
    pub(crate) rejected: Vec<NativeFileRejection>,
    pub(crate) selected_count: usize,
    pub(crate) too_many: bool,
}

#[derive(Debug)]
pub(crate) struct ConsumedNativeFile {
    pub(crate) name: String,
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
}

struct NativeFileGrant {
    profile_id: String,
    recipient_public_key: String,
    contact_incarnation: u64,
    name: String,
    mime: String,
    path: std::path::PathBuf,
    size: u64,
    issued_at: Instant,
    owned_temporary_file: bool,
    read_context: Option<String>,
    reader: Option<File>,
    read_position: u64,
}

pub(crate) struct NativeFileGrantStore {
    grants: HashMap<String, NativeFileGrant>,
    ttl: Duration,
    max_grants: usize,
    max_aggregate_bytes: u64,
    aggregate_bytes: u64,
}

impl Default for NativeFileGrantStore {
    fn default() -> Self {
        Self {
            grants: HashMap::new(),
            ttl: DEFAULT_GRANT_TTL,
            max_grants: DEFAULT_MAX_GRANTS,
            max_aggregate_bytes: DEFAULT_MAX_AGGREGATE_BYTES,
            aggregate_bytes: 0,
        }
    }
}

impl NativeFileGrantStore {
    pub(crate) fn issue(
        &mut self,
        path: &Path,
        profile_id: String,
        recipient_public_key: String,
        max_bytes: u64,
    ) -> Result<NativeFileSelection, String> {
        self.issue_at(
            path,
            profile_id,
            recipient_public_key,
            max_bytes,
            Instant::now(),
        )
    }

    /// Issues a grant for a temporary file created by Kaigen itself (for
    /// example, a native clipboard image). The file is deleted when the grant
    /// is consumed, discarded, expires, or the profile is closed.
    pub(crate) fn issue_owned(
        &mut self,
        path: &Path,
        profile_id: String,
        recipient_public_key: String,
        max_bytes: u64,
    ) -> Result<NativeFileSelection, String> {
        self.issue_at_with_ownership(
            path,
            profile_id,
            recipient_public_key,
            max_bytes,
            Instant::now(),
            true,
        )
    }

    fn issue_at(
        &mut self,
        path: &Path,
        profile_id: String,
        recipient_public_key: String,
        max_bytes: u64,
        now: Instant,
    ) -> Result<NativeFileSelection, String> {
        self.issue_at_with_ownership(
            path,
            profile_id,
            recipient_public_key,
            max_bytes,
            now,
            false,
        )
    }

    fn issue_at_with_ownership(
        &mut self,
        path: &Path,
        profile_id: String,
        recipient_public_key: String,
        max_bytes: u64,
        now: Instant,
        owned_temporary_file: bool,
    ) -> Result<NativeFileSelection, String> {
        self.prune_expired(now);

        let canonical =
            fs::canonicalize(path).map_err(|error| format!("Не удалось открыть файл: {error}"))?;
        let file =
            File::open(&canonical).map_err(|error| format!("Не удалось открыть файл: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("Не удалось проверить файл: {error}"))?;
        validate_metadata(&metadata, max_bytes)?;

        let name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .map(safe_display_name)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "Не удалось определить имя файла".to_string())?;
        let mime = mime_for_name(&name);
        let token = unique_token(&self.grants)?;
        let size = metadata.len();
        if size > self.max_aggregate_bytes {
            return Err("NATIVE_FILE_GRANT_BUDGET_EXCEEDED".to_string());
        }

        while self.grants.len() >= self.max_grants
            || self.aggregate_bytes.saturating_add(size) > self.max_aggregate_bytes
        {
            let Some(oldest) = self
                .grants
                .iter()
                .min_by_key(|(_, grant)| grant.issued_at)
                .map(|(token, _)| token.clone())
            else {
                break;
            };
            self.discard(&oldest);
        }

        self.aggregate_bytes = self.aggregate_bytes.saturating_add(size);
        self.grants.insert(
            token.clone(),
            NativeFileGrant {
                profile_id,
                recipient_public_key,
                contact_incarnation: 0,
                name: name.clone(),
                mime: mime.clone(),
                path: canonical,
                size,
                issued_at: now,
                owned_temporary_file,
                read_context: None,
                reader: None,
                read_position: 0,
            },
        );

        Ok(NativeFileSelection {
            grant_token: token,
            name,
            mime,
            size,
        })
    }

    pub(crate) fn issue_with_incarnation(
        &mut self, path: &Path, profile_id: String, recipient_public_key: String,
        max_bytes: u64, contact_incarnation: u64,
    ) -> Result<NativeFileSelection, String> {
        let selection = self.issue(path, profile_id, recipient_public_key, max_bytes)?;
        self.bind_incarnation(&selection.grant_token, contact_incarnation)?;
        Ok(selection)
    }

    pub(crate) fn issue_owned_with_incarnation(
        &mut self, path: &Path, profile_id: String, recipient_public_key: String,
        max_bytes: u64, contact_incarnation: u64,
    ) -> Result<NativeFileSelection, String> {
        let selection = self.issue_owned(path, profile_id, recipient_public_key, max_bytes)?;
        self.bind_incarnation(&selection.grant_token, contact_incarnation)?;
        Ok(selection)
    }

    fn bind_incarnation(&mut self, token: &str, contact_incarnation: u64) -> Result<(), String> {
        let grant = self.grants.get_mut(token).ok_or("NATIVE_FILE_GRANT_INVALID")?;
        grant.contact_incarnation = contact_incarnation;
        Ok(())
    }

    pub(crate) fn consume_with_incarnation(
        &mut self, token: &str, profile_id: &str, recipient_public_key: &str,
        contact_incarnation: u64,
    ) -> Result<ConsumedNativeFile, String> {
        self.consume_at_with_incarnation(token, profile_id, recipient_public_key,
            contact_incarnation, Instant::now())
    }

    #[cfg(test)]
    pub(crate) fn consume(
        &mut self,
        token: &str,
        profile_id: &str,
        recipient_public_key: &str,
    ) -> Result<ConsumedNativeFile, String> {
        self.consume_at(token, profile_id, recipient_public_key, Instant::now())
    }

    /// Bind this existing OS-selected grant to one remote chat view before exposure.
    pub(crate) fn bind_read_context(&mut self, token: &str, context: &str) -> Result<(), String> {
        let grant = self.grants.get_mut(token).ok_or("NATIVE_FILE_GRANT_INVALID")?;
        if grant.read_context.is_some() || grant.reader.is_some() {
            return Err("NATIVE_FILE_GRANT_INVALID".into());
        }
        grant.read_context = Some(context.to_string());
        Ok(())
    }

    /// Sequential, bounded reads from the same opaque grant; EOF/errors consume it.
    pub(crate) fn read_chunk(
        &mut self, token: &str, profile_id: &str, recipient_public_key: &str,
        contact_incarnation: u64, context: &str, position: u64, length: usize,
    ) -> Result<(Vec<u8>, bool), String> {
        let mut grant = self.remove_grant(token).ok_or("NATIVE_FILE_GRANT_INVALID")?;
        let result = (|| {
            if grant.issued_at.elapsed() > self.ttl { return Err("NATIVE_FILE_GRANT_EXPIRED".into()); }
            if grant.profile_id != profile_id { return Err("NATIVE_FILE_GRANT_PROFILE_MISMATCH".into()); }
            if grant.recipient_public_key != recipient_public_key { return Err("NATIVE_FILE_GRANT_RECIPIENT_MISMATCH".into()); }
            if grant.contact_incarnation != contact_incarnation { return Err("CHAT_CONTACT_INCARNATION_CHANGED".into()); }
            if grant.read_context.as_deref() != Some(context) || grant.read_position != position
                || length == 0 || length > 256 * 1024 || position >= grant.size {
                return Err("NATIVE_FILE_GRANT_RANGE_INVALID".into());
            }
            if grant.reader.is_none() {
                let canonical = fs::canonicalize(&grant.path).map_err(|_| "NATIVE_FILE_GRANT_FILE_CHANGED")?;
                if canonical != grant.path { return Err("NATIVE_FILE_GRANT_FILE_CHANGED".into()); }
                grant.reader = Some(File::open(canonical).map_err(|_| "NATIVE_FILE_GRANT_FILE_CHANGED")?);
            }
            let reader = grant.reader.as_mut().ok_or("NATIVE_FILE_GRANT_INVALID")?;
            let metadata = reader.metadata().map_err(|_| "NATIVE_FILE_GRANT_FILE_CHANGED")?;
            if !metadata.is_file() || metadata.len() != grant.size { return Err("NATIVE_FILE_GRANT_FILE_CHANGED".into()); }
            let count = length.min((grant.size - position) as usize);
            let mut bytes = vec![0; count];
            if reader.read_exact(&mut bytes).is_err() {
                bytes.fill(0);
                return Err("NATIVE_FILE_GRANT_FILE_CHANGED".into());
            }
            grant.read_position += count as u64;
            Ok((bytes, grant.read_position == grant.size))
        })();
        if matches!(&result, Ok((_, false))) {
            self.aggregate_bytes = self.aggregate_bytes.saturating_add(grant.size);
            self.grants.insert(token.to_string(), grant);
        } else {
            let owned_path = grant.owned_temporary_file.then(|| grant.path.clone());
            drop(grant);
            if let Some(path) = owned_path { let _ = fs::remove_file(path); }
        }
        result
    }

    pub(crate) fn discard(&mut self, token: &str) {
        if let Some(grant) = self.remove_grant(token) {
            let owned_path = grant.owned_temporary_file.then(|| grant.path.clone());
            drop(grant);
            if let Some(path) = owned_path { let _ = fs::remove_file(path); }
        }
    }

    pub(crate) fn clear_for_profile(&mut self, profile_id: &str) {
        let tokens = self
            .grants
            .iter()
            .filter(|(_, grant)| grant.profile_id == profile_id)
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        for token in tokens {
            self.discard(&token);
        }
    }

    pub(crate) fn clear_all(&mut self) {
        let tokens = self.grants.keys().cloned().collect::<Vec<_>>();
        for token in tokens {
            self.discard(&token);
        }
    }

    #[cfg(test)]
    fn consume_at(
        &mut self,
        token: &str,
        profile_id: &str,
        recipient_public_key: &str,
        now: Instant,
    ) -> Result<ConsumedNativeFile, String> {
        self.consume_at_with_incarnation(token, profile_id, recipient_public_key, 0, now)
    }

    fn consume_at_with_incarnation(
        &mut self, token: &str, profile_id: &str, recipient_public_key: &str,
        contact_incarnation: u64, now: Instant,
    ) -> Result<ConsumedNativeFile, String> {
        // Removal happens before every validation. A failed, expired, replayed,
        // or cross-profile token therefore never becomes usable later.
        let grant = self
            .remove_grant(token)
            .ok_or_else(|| "NATIVE_FILE_GRANT_INVALID".to_string())?;
        let owned_path = grant.owned_temporary_file.then(|| grant.path.clone());
        let result = (|| {
            if now
                .checked_duration_since(grant.issued_at)
                .map_or(true, |age| age > self.ttl)
            {
                return Err("NATIVE_FILE_GRANT_EXPIRED".to_string());
            }
            if grant.read_context.is_some() || grant.reader.is_some() {
                return Err("NATIVE_FILE_GRANT_INVALID".to_string());
            }
            if grant.profile_id != profile_id {
                return Err("NATIVE_FILE_GRANT_PROFILE_MISMATCH".to_string());
            }
            if grant.recipient_public_key != recipient_public_key {
                return Err("NATIVE_FILE_GRANT_RECIPIENT_MISMATCH".to_string());
            }
            if grant.contact_incarnation != contact_incarnation {
                return Err("CHAT_CONTACT_INCARNATION_CHANGED".to_string());
            }

            let canonical = fs::canonicalize(&grant.path)
                .map_err(|_| "NATIVE_FILE_GRANT_FILE_CHANGED".to_string())?;
            if canonical != grant.path {
                return Err("NATIVE_FILE_GRANT_FILE_CHANGED".to_string());
            }
            let file =
                File::open(&canonical).map_err(|_| "NATIVE_FILE_GRANT_FILE_CHANGED".to_string())?;
            let metadata = file
                .metadata()
                .map_err(|_| "NATIVE_FILE_GRANT_FILE_CHANGED".to_string())?;
            if !metadata.is_file() || metadata.len() != grant.size {
                return Err("NATIVE_FILE_GRANT_FILE_CHANGED".to_string());
            }
            let mut bytes = Vec::with_capacity(grant.size as usize);
            file.take(grant.size.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| "NATIVE_FILE_GRANT_FILE_CHANGED".to_string())?;
            if bytes.len() as u64 != grant.size {
                bytes.fill(0);
                return Err("NATIVE_FILE_GRANT_FILE_CHANGED".to_string());
            }

            Ok(ConsumedNativeFile {
                name: grant.name,
                mime: grant.mime,
                bytes,
            })
        })();
        if let Some(path) = owned_path {
            let _ = fs::remove_file(path);
        }
        result
    }

    fn prune_expired(&mut self, now: Instant) {
        let ttl = self.ttl;
        let expired = self
            .grants
            .iter()
            .filter(|(_, grant)| {
                now.checked_duration_since(grant.issued_at)
                    .map_or(true, |age| age > ttl)
            })
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        for token in expired {
            self.discard(&token);
        }
    }

    fn remove_grant(&mut self, token: &str) -> Option<NativeFileGrant> {
        let grant = self.grants.remove(token)?;
        self.aggregate_bytes = self.aggregate_bytes.saturating_sub(grant.size);
        Some(grant)
    }
}

fn validate_metadata(metadata: &fs::Metadata, max_bytes: u64) -> Result<(), String> {
    if !metadata.is_file() {
        return Err("Можно отправлять только файлы".to_string());
    }
    if metadata.len() == 0 {
        return Err("Нельзя отправить пустой файл".to_string());
    }
    if metadata.len() > max_bytes {
        return Err("Для первой версии лимит передачи — 25 МБ".to_string());
    }
    Ok(())
}

fn safe_display_name(name: &str) -> String {
    name.chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn mime_for_name(name: &str) -> String {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn unique_token(grants: &HashMap<String, NativeFileGrant>) -> Result<String, String> {
    for _ in 0..4 {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| "NATIVE_FILE_GRANT_RANDOM_SOURCE_FAILED".to_string())?;
        let token: String = bytes.iter().map(|byte| format!("{byte:02X}")).collect();
        if !grants.contains_key(&token) {
            return Ok(token);
        }
    }
    Err("NATIVE_FILE_GRANT_RANDOM_COLLISION".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    fn temporary_file(label: &str, bytes: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!(
            "kaigen-native-grant-{label}-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect::<String>()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("payload.png");
        fs::write(&path, bytes).unwrap();
        (root, path)
    }

    #[test]
    fn grant_is_profile_bound_and_single_use() {
        let (root, path) = temporary_file("single-use", b"payload");
        let mut store = NativeFileGrantStore::default();
        let selection = store
            .issue(&path, "profile-a".to_string(), "FRIEND-A".to_string(), 1024)
            .unwrap();
        assert_eq!(selection.name, "payload.png");
        assert_eq!(selection.mime, "image/png");
        assert_eq!(selection.size, 7);

        let consumed = store
            .consume(&selection.grant_token, "profile-a", "FRIEND-A")
            .unwrap();
        assert_eq!(consumed.bytes, b"payload");
        assert!(store
            .consume(&selection.grant_token, "profile-a", "FRIEND-A")
            .is_err());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn wrong_profile_consumes_the_grant_fail_closed() {
        let (root, path) = temporary_file("profile", b"payload");
        let mut store = NativeFileGrantStore::default();
        let selection = store
            .issue(&path, "profile-a".to_string(), "FRIEND-A".to_string(), 1024)
            .unwrap();
        assert_eq!(
            store
                .consume(&selection.grant_token, "profile-b", "FRIEND-A")
                .unwrap_err(),
            "NATIVE_FILE_GRANT_PROFILE_MISMATCH"
        );
        assert!(store
            .consume(&selection.grant_token, "profile-a", "FRIEND-A")
            .is_err());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readded_contact_cannot_consume_an_old_grant() {
        let (root, path) = temporary_file("incarnation", b"payload");
        let mut store = NativeFileGrantStore::default();
        let old = store.issue_with_incarnation(
            &path, "profile-a".into(), "FRIEND-A".into(), 1024, 1,
        ).unwrap();
        assert_eq!(store.consume_with_incarnation(
            &old.grant_token, "profile-a", "FRIEND-A", 2,
        ).unwrap_err(), "CHAT_CONTACT_INCARNATION_CHANGED");
        assert_eq!(fs::read(&path).unwrap(), b"payload");
        assert!(store.consume_with_incarnation(
            &old.grant_token, "profile-a", "FRIEND-A", 1,
        ).is_err());
        let current = store.issue_with_incarnation(
            &path, "profile-a".into(), "FRIEND-A".into(), 1024, 2,
        ).unwrap();
        assert_eq!(store.consume_with_incarnation(
            &current.grant_token, "profile-a", "FRIEND-A", 2,
        ).unwrap().bytes, b"payload");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incarnation_change_during_read_removes_only_the_owned_copy() {
        let (root, original) = temporary_file("read-incarnation", b"payload");
        let owned = root.join("managed-copy.png");
        fs::copy(&original, &owned).unwrap();
        let mut store = NativeFileGrantStore::default();
        let selected = store.issue_owned_with_incarnation(
            &owned, "profile-a".into(), "FRIEND-A".into(), 1024, 1,
        ).unwrap();
        store.bind_read_context(&selected.grant_token, "view-a").unwrap();
        assert_eq!(store.read_chunk(
            &selected.grant_token, "profile-a", "FRIEND-A", 1, "view-a", 0, 2,
        ).unwrap(), (b"pa".to_vec(), false));
        assert_eq!(store.read_chunk(
            &selected.grant_token, "profile-a", "FRIEND-A", 2, "view-a", 2, 2,
        ).unwrap_err(), "CHAT_CONTACT_INCARNATION_CHANGED");
        assert!(!owned.exists());
        assert_eq!(fs::read(&original).unwrap(), b"payload");
        assert_eq!(store.aggregate_bytes, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_and_changed_files_are_rejected() {
        let (root, path) = temporary_file("expiry", b"payload");
        let start = Instant::now();
        let mut store = NativeFileGrantStore {
            grants: HashMap::new(),
            ttl: Duration::from_secs(1),
            max_grants: 8,
            max_aggregate_bytes: 1024,
            aggregate_bytes: 0,
        };
        let expired = store
            .issue_at(
                &path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                1024,
                start,
            )
            .unwrap();
        assert_eq!(
            store
                .consume_at(
                    &expired.grant_token,
                    "profile-a",
                    "FRIEND-A",
                    start + Duration::from_secs(2)
                )
                .unwrap_err(),
            "NATIVE_FILE_GRANT_EXPIRED"
        );

        let retargeted = store
            .issue_at(
                &path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                1024,
                start,
            )
            .unwrap();
        assert_eq!(
            store
                .consume_at(&retargeted.grant_token, "profile-a", "FRIEND-B", start)
                .unwrap_err(),
            "NATIVE_FILE_GRANT_RECIPIENT_MISMATCH"
        );

        let changed = store
            .issue_at(
                &path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                1024,
                start,
            )
            .unwrap();
        fs::write(&path, b"payload changed").unwrap();
        assert_eq!(
            store
                .consume_at(&changed.grant_token, "profile-a", "FRIEND-A", start)
                .unwrap_err(),
            "NATIVE_FILE_GRANT_FILE_CHANGED"
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn grant_count_is_bounded_and_oldest_entry_is_evicted() {
        let (root, path) = temporary_file("bound", b"payload");
        let start = Instant::now();
        let mut store = NativeFileGrantStore {
            grants: HashMap::new(),
            ttl: Duration::from_secs(60),
            max_grants: 2,
            max_aggregate_bytes: 1024,
            aggregate_bytes: 0,
        };
        let first = store
            .issue_at(
                &path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                1024,
                start,
            )
            .unwrap();
        let second = store
            .issue_at(
                &path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                1024,
                start + Duration::from_millis(1),
            )
            .unwrap();
        let third = store
            .issue_at(
                &path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                1024,
                start + Duration::from_millis(2),
            )
            .unwrap();
        assert!(store
            .consume_at(
                &first.grant_token,
                "profile-a",
                "FRIEND-A",
                start + Duration::from_millis(3),
            )
            .is_err());
        assert!(store
            .consume_at(
                &second.grant_token,
                "profile-a",
                "FRIEND-A",
                start + Duration::from_millis(3),
            )
            .is_ok());
        assert!(store
            .consume_at(
                &third.grant_token,
                "profile-a",
                "FRIEND-A",
                start + Duration::from_millis(3),
            )
            .is_ok());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selection_serialization_never_exposes_path_or_bytes() {
        let selection = NativeFileSelection {
            grant_token: "A".repeat(64),
            name: "payload.txt".to_string(),
            mime: "application/octet-stream".to_string(),
            size: 7,
        };
        let serialized = serde_json::to_value(selection).unwrap();
        assert_eq!(serialized["grantToken"], "A".repeat(64));
        assert_eq!(serialized["name"], "payload.txt");
        assert_eq!(serialized["size"], 7);
        assert!(serialized.get("path").is_none());
        assert!(serialized.get("bytes").is_none());
    }

    #[test]
    fn empty_oversized_and_aggregate_budget_files_are_rejected() {
        let (empty_root, empty_path) = temporary_file("empty", b"");
        let mut store = NativeFileGrantStore::default();
        assert!(store
            .issue(
                &empty_path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                1024,
            )
            .is_err());
        fs::remove_dir_all(empty_root).unwrap();

        let (large_root, large_path) = temporary_file("large", b"12345678");
        assert!(store
            .issue(
                &large_path,
                "profile-a".to_string(),
                "FRIEND-A".to_string(),
                7,
            )
            .is_err());

        let mut budgeted = NativeFileGrantStore {
            grants: HashMap::new(),
            ttl: Duration::from_secs(60),
            max_grants: 8,
            max_aggregate_bytes: 7,
            aggregate_bytes: 0,
        };
        assert_eq!(
            budgeted
                .issue(
                    &large_path,
                    "profile-a".to_string(),
                    "FRIEND-A".to_string(),
                    1024,
                )
                .unwrap_err(),
            "NATIVE_FILE_GRANT_BUDGET_EXCEEDED"
        );
        fs::remove_dir_all(large_root).unwrap();
    }

    #[test]
    fn discard_and_profile_clear_release_grants() {
        let (root, path) = temporary_file("clear", b"payload");
        let mut store = NativeFileGrantStore::default();
        let discarded = store
            .issue(&path, "profile-a".to_string(), "FRIEND-A".to_string(), 1024)
            .unwrap();
        store.discard(&discarded.grant_token);
        assert!(store
            .consume(&discarded.grant_token, "profile-a", "FRIEND-A")
            .is_err());

        let profile_a = store
            .issue(&path, "profile-a".to_string(), "FRIEND-A".to_string(), 1024)
            .unwrap();
        let profile_b = store
            .issue(&path, "profile-b".to_string(), "FRIEND-B".to_string(), 1024)
            .unwrap();
        store.clear_for_profile("profile-a");
        assert!(store
            .consume(&profile_a.grant_token, "profile-a", "FRIEND-A")
            .is_err());
        assert!(store
            .consume(&profile_b.grant_token, "profile-b", "FRIEND-B")
            .is_ok());
        store.clear_all();
        assert_eq!(store.aggregate_bytes, 0);
        assert!(store.grants.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_double_consume_has_exactly_one_winner() {
        let (root, path) = temporary_file("concurrent", b"payload");
        let mut initial = NativeFileGrantStore::default();
        let selection = initial
            .issue(&path, "profile-a".to_string(), "FRIEND-A".to_string(), 1024)
            .unwrap();
        let token = Arc::new(selection.grant_token);
        let store = Arc::new(Mutex::new(initial));
        let workers = (0..2)
            .map(|_| {
                let token = Arc::clone(&token);
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    store
                        .lock()
                        .unwrap()
                        .consume(&token, "profile-a", "FRIEND-A")
                        .is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .filter(|success| *success)
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
}
