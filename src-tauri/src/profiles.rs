use std::{
    collections::HashSet,
    ffi::c_void,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    ptr::NonNull,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

const ENCRYPTION_OVERHEAD: usize = 80;
const SALT_LENGTH: usize = 32;
const REGISTRY_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRecord {
    pub id: String,
    pub name: String,
    pub file: String,
    pub data_directory: String,
    pub encrypted: bool,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default)]
    pub imported_from: Option<String>,
    pub created_at: u64,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRegistry {
    pub version: u32,
    #[serde(default)]
    pub active_profile_id: Option<String>,
    #[serde(default)]
    pub profiles: Vec<ProfileRecord>,
}

impl Default for ProfileRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            active_profile_id: None,
            profiles: Vec::new(),
        }
    }
}

impl ProfileRegistry {
    pub fn load_or_discover(root: &Path, data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join("profiles.json");
        recover_interrupted_write(&path)?;
        if path.is_file() {
            let mut registry: Self = serde_json::from_slice(&fs::read(&path).map_err(|error| {
                format!("Could not read the portable profile registry: {error}")
            })?)
            .map_err(|error| format!("The portable profile registry is invalid: {error}"))?;
            registry.version = REGISTRY_VERSION;
            let previous_len = registry.profiles.len();
            registry.retain_safe_records(root);
            registry.ensure_active();
            if registry.profiles.len() != previous_len {
                registry.save(data_dir)?;
            }
            return Ok(registry);
        }

        let mut registry = Self::default();
        let profiles_root = root.join("profiles");
        if let Ok(entries) = fs::read_dir(&profiles_root) {
            for entry in entries.filter_map(Result::ok) {
                let directory = entry.path();
                if !directory.is_dir() {
                    continue;
                }
                let Some(id) = entry.file_name().to_str().map(safe_component) else {
                    continue;
                };
                let Ok(files) = fs::read_dir(&directory) else {
                    continue;
                };
                let Some(profile) =
                    files
                        .filter_map(Result::ok)
                        .map(|file| file.path())
                        .find(|file| {
                            file.extension()
                                .and_then(|extension| extension.to_str())
                                .is_some_and(|extension| extension.eq_ignore_ascii_case("tox"))
                        })
                else {
                    continue;
                };
                let name = profile
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&id)
                    .to_string();
                registry.profiles.push(ProfileRecord {
                    id: unique_id(&registry, &id),
                    name,
                    file: relative_slash(root, &profile)?,
                    data_directory: relative_slash(root, &directory.join("data"))?,
                    encrypted: file_is_encrypted(&profile)?,
                    enabled: true,
                    imported_from: None,
                    created_at: modified_or_now(&profile),
                });
            }
        }
        registry.ensure_active();
        registry.save(data_dir)?;
        Ok(registry)
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("Could not encode the portable profile registry: {error}"))?;
        atomic_write(&data_dir.join("profiles.json"), &bytes)
    }

    pub fn ensure_active(&mut self) {
        let active_exists = self.active_profile_id.as_ref().is_some_and(|active| {
            self.profiles
                .iter()
                .any(|profile| profile.id == *active && profile.enabled)
        });
        if !active_exists {
            self.active_profile_id = self
                .profiles
                .iter()
                .find(|profile| profile.enabled)
                .map(|profile| profile.id.clone());
        }
    }

    pub fn prefer_loaded_active(&mut self, loaded_ids: &HashSet<String>) {
        if loaded_ids.is_empty() {
            return;
        }
        let active_is_loaded = self.active_profile_id.as_ref().is_some_and(|active| {
            loaded_ids.contains(active)
                && self
                    .profiles
                    .iter()
                    .any(|record| record.id == *active && record.enabled)
        });
        if !active_is_loaded {
            self.active_profile_id = self
                .profiles
                .iter()
                .find(|record| record.enabled && loaded_ids.contains(&record.id))
                .map(|record| record.id.clone());
        }
    }

    pub fn disable_profile(&mut self, profile_id: &str, loaded_ids: &HashSet<String>) -> bool {
        let Some(profile) = self
            .profiles
            .iter_mut()
            .find(|profile| profile.id == profile_id && profile.enabled)
        else {
            return false;
        };
        profile.enabled = false;

        let active_is_available = self.active_profile_id.as_ref().is_some_and(|active| {
            self.profiles
                .iter()
                .any(|profile| profile.id == *active && profile.enabled)
        });
        if !active_is_available {
            self.active_profile_id = self
                .profiles
                .iter()
                .find(|profile| profile.enabled && loaded_ids.contains(&profile.id))
                .or_else(|| self.profiles.iter().find(|profile| profile.enabled))
                .map(|profile| profile.id.clone());
        }
        true
    }

    pub fn profile_path(&self, root: &Path, record: &ProfileRecord) -> Result<PathBuf, String> {
        safe_join(root, &record.file)
    }

    pub fn data_path(&self, root: &Path, record: &ProfileRecord) -> Result<PathBuf, String> {
        safe_join(root, &record.data_directory)
    }

    fn retain_safe_records(&mut self, root: &Path) {
        let mut ids = HashSet::new();
        let mut files = HashSet::new();
        self.profiles.retain(|profile| {
            let expected_directory = root.join("profiles").join(&profile.id);
            let profile_path = safe_join(root, &profile.file).ok();
            let data_path = safe_join(root, &profile.data_directory).ok();
            let safe = profile.id == safe_component(&profile.id).to_lowercase()
                && profile_path
                    .as_ref()
                    .and_then(|path| path.parent().map(|parent| parent == expected_directory))
                    .unwrap_or(false)
                && data_path
                    .as_ref()
                    .is_some_and(|path| path == &expected_directory.join("data"))
                && profile_path.as_ref().is_some_and(|path| path.is_file())
                && data_path.as_ref().is_some_and(|path| path.is_dir());
            safe && ids.insert(profile.id.clone()) && files.insert(profile.file.clone())
        });
    }
}

pub fn create_record(
    root: &Path,
    registry: &ProfileRegistry,
    name: &str,
) -> Result<ProfileRecord, String> {
    let display_name = if name.trim().is_empty() {
        "Tox User"
    } else {
        name.trim()
    };
    let base = safe_component(display_name);
    let id = unique_id(registry, &base);
    let directory = root.join("profiles").join(&id);
    let profile_path = directory.join(format!("{base}.tox"));
    let data_path = directory.join("data");
    fs::create_dir_all(&data_path)
        .map_err(|error| format!("Could not create the profile directory: {error}"))?;
    Ok(ProfileRecord {
        id,
        name: display_name.to_string(),
        file: relative_slash(root, &profile_path)?,
        data_directory: relative_slash(root, &data_path)?,
        encrypted: false,
        enabled: true,
        imported_from: None,
        created_at: now(),
    })
}

pub fn read_profile(
    path: &Path,
    password: Option<&str>,
) -> Result<(Vec<u8>, Option<ProfileCipher>), String> {
    recover_interrupted_write(path)?;
    let bytes = fs::read(path)
        .map_err(|error| format!("Could not read Tox profile {}: {error}", path.display()))?;
    if !is_encrypted(&bytes) {
        return Ok((bytes, None));
    }
    let password = password.ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?;
    let cipher = ProfileCipher::unlock(&bytes, password)?;
    let plain = cipher.decrypt(&bytes)?;
    Ok((plain, Some(cipher)))
}

pub fn file_is_encrypted(path: &Path) -> Result<bool, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("Could not inspect Tox profile {}: {error}", path.display()))?;
    Ok(is_encrypted(&bytes))
}

pub fn is_encrypted(bytes: &[u8]) -> bool {
    bytes.len() >= ENCRYPTION_OVERHEAD && unsafe { tox_is_data_encrypted(bytes.as_ptr()) }
}

struct PassKey(NonNull<c_void>);

unsafe impl Send for PassKey {}
unsafe impl Sync for PassKey {}

impl Drop for PassKey {
    fn drop(&mut self) {
        unsafe { tox_pass_key_free(self.0.as_ptr()) };
    }
}

#[derive(Clone)]
pub struct ProfileCipher(Arc<PassKey>);

impl ProfileCipher {
    pub fn new(password: &str) -> Result<Self, String> {
        let mut error = 0_i32;
        let key = unsafe {
            tox_pass_key_derive(password.as_bytes().as_ptr(), password.len(), &mut error)
        };
        NonNull::new(key)
            .map(|key| Self(Arc::new(PassKey(key))))
            .ok_or_else(|| format!("Could not derive the profile encryption key (code {error})"))
    }

    pub fn unlock(ciphertext: &[u8], password: &str) -> Result<Self, String> {
        if !is_encrypted(ciphertext) {
            return Err("The selected profile is not password protected".to_string());
        }
        let mut salt = [0_u8; SALT_LENGTH];
        let mut salt_error = 0_i32;
        if !unsafe { tox_get_salt(ciphertext.as_ptr(), salt.as_mut_ptr(), &mut salt_error) } {
            return Err(format!(
                "The encrypted profile header is invalid (code {salt_error})"
            ));
        }
        let mut error = 0_i32;
        let key = unsafe {
            tox_pass_key_derive_with_salt(
                password.as_bytes().as_ptr(),
                password.len(),
                salt.as_ptr(),
                &mut error,
            )
        };
        let cipher = NonNull::new(key)
            .map(|key| Self(Arc::new(PassKey(key))))
            .ok_or_else(|| format!("Could not derive the profile decryption key (code {error})"))?;
        // Authentication is checked now, so a bad password never reaches tox_new.
        let _ = cipher.decrypt(ciphertext)?;
        Ok(cipher)
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        if plaintext.is_empty() {
            return Err("A zero-length Tox profile cannot be encrypted".to_string());
        }
        let mut ciphertext = vec![0_u8; plaintext.len() + ENCRYPTION_OVERHEAD];
        let mut error = 0_i32;
        if !unsafe {
            tox_pass_key_encrypt(
                self.0 .0.as_ptr(),
                plaintext.as_ptr(),
                plaintext.len(),
                ciphertext.as_mut_ptr(),
                &mut error,
            )
        } {
            return Err(format!("Could not encrypt the Tox profile (code {error})"));
        }
        Ok(ciphertext)
    }

    pub fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        if ciphertext.len() < ENCRYPTION_OVERHEAD {
            return Err("The encrypted Tox profile is truncated".to_string());
        }
        let mut plaintext = vec![0_u8; ciphertext.len() - ENCRYPTION_OVERHEAD];
        let mut error = 0_i32;
        if !unsafe {
            tox_pass_key_decrypt(
                self.0 .0.as_ptr(),
                ciphertext.as_ptr(),
                ciphertext.len(),
                plaintext.as_mut_ptr(),
                &mut error,
            )
        } {
            return Err(if error == 5 {
                "PROFILE_PASSWORD_INVALID".to_string()
            } else {
                format!("Could not decrypt the Tox profile (code {error})")
            });
        }
        Ok(plaintext)
    }
}

pub fn derive_qtox_database_key(
    password: &str,
    salt: &[u8; SALT_LENGTH],
) -> Result<[u8; 32], String> {
    if password.is_empty() {
        return Ok([0_u8; 32]);
    }
    let mut error = 0_i32;
    let key = unsafe {
        tox_pass_key_derive_with_salt(
            password.as_bytes().as_ptr(),
            password.len(),
            salt.as_ptr(),
            &mut error,
        )
    };
    let key = NonNull::new(key)
        .ok_or_else(|| format!("Could not derive the qTox history key (code {error})"))?;
    let owned = PassKey(key);
    let mut result = [0_u8; 32];
    // Tox_Pass_Key stores the 32-byte salt first and the 32-byte symmetric
    // key second. qTox uses that second half verbatim as SQLCipher's raw key.
    unsafe {
        std::ptr::copy_nonoverlapping(
            (owned.0.as_ptr() as *const u8).add(SALT_LENGTH),
            result.as_mut_ptr(),
            result.len(),
        );
    }
    Ok(result)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The profile path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temp = temporary_path(path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .or_else(|_| {
            let _ = fs::remove_file(&temp);
            OpenOptions::new().write(true).create_new(true).open(&temp)
        })
        .map_err(|error| format!("Could not create temporary profile file: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not flush temporary profile file: {error}"))?;
    drop(file);
    replace_file(&temp, path).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

fn recover_interrupted_write(path: &Path) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    let temp = temporary_path(path);
    if temp.is_file() {
        replace_file(&temp, path)?;
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".writing");
    path.with_file_name(name)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let destination_display = destination.display().to_string();
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let success = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        return Err(format!(
            "Could not atomically replace {}: {}",
            destination_display,
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| {
        format!(
            "Could not atomically replace {}: {error}",
            destination.display()
        )
    })
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("Unsafe path in the portable profile registry".to_string());
    }
    Ok(root.join(relative))
}

fn relative_slash(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        "Profile data must stay inside the portable application directory".to_string()
    })?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

pub fn safe_component(value: &str) -> String {
    let mut result: String = value
        .trim()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect();
    result = result.trim_matches([' ', '.']).to_string();
    if result.is_empty() {
        result = "profile".to_string();
    }
    result.chars().take(64).collect()
}

fn unique_id(registry: &ProfileRegistry, proposed: &str) -> String {
    let base = safe_component(proposed).to_lowercase();
    if !registry.profiles.iter().any(|profile| profile.id == base) {
        return base;
    }
    for number in 2_u32.. {
        let candidate = format!("{base}-{number}");
        if !registry
            .profiles
            .iter()
            .any(|profile| profile.id == candidate)
        {
            return candidate;
        }
    }
    unreachable!()
}

fn modified_or_now(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or_else(now)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn MoveFileExW(existing_file_name: *const u16, new_file_name: *const u16, flags: u32) -> i32;
}

unsafe extern "C" {
    fn tox_is_data_encrypted(data: *const u8) -> bool;
    fn tox_get_salt(ciphertext: *const u8, salt: *mut u8, error: *mut i32) -> bool;
    fn tox_pass_key_derive(
        passphrase: *const u8,
        passphrase_len: usize,
        error: *mut i32,
    ) -> *mut c_void;
    fn tox_pass_key_derive_with_salt(
        passphrase: *const u8,
        passphrase_len: usize,
        salt: *const u8,
        error: *mut i32,
    ) -> *mut c_void;
    fn tox_pass_key_encrypt(
        key: *const c_void,
        plaintext: *const u8,
        plaintext_len: usize,
        ciphertext: *mut u8,
        error: *mut i32,
    ) -> bool;
    fn tox_pass_key_decrypt(
        key: *const c_void,
        ciphertext: *const u8,
        ciphertext_len: usize,
        plaintext: *mut u8,
        error: *mut i32,
    ) -> bool;
    fn tox_pass_key_free(key: *mut c_void);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toxencryptsave_round_trip_and_wrong_password() {
        let profile = b"portable tox profile test";
        let cipher = ProfileCipher::new("correct horse battery staple").unwrap();
        let encrypted = cipher.encrypt(profile).unwrap();
        assert!(is_encrypted(&encrypted));
        let unlocked = ProfileCipher::unlock(&encrypted, "correct horse battery staple").unwrap();
        assert_eq!(unlocked.decrypt(&encrypted).unwrap(), profile);
        assert_eq!(
            ProfileCipher::unlock(&encrypted, "wrong").err().unwrap(),
            "PROFILE_PASSWORD_INVALID"
        );
    }

    #[test]
    fn every_profile_uses_the_same_isolated_directory_layout() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-layout-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let mut registry = ProfileRegistry::default();
        let first = create_record(&root, &registry, "Tox User").unwrap();
        assert_eq!(first.id, "tox user");
        assert_eq!(
            first.file.replace('\\', "/"),
            "profiles/tox user/Tox User.tox"
        );
        assert_eq!(
            first.data_directory.replace('\\', "/"),
            "profiles/tox user/data"
        );
        registry.profiles.push(first);
        let second = create_record(&root, &registry, "Work").unwrap();
        assert_eq!(second.file.replace('\\', "/"), "profiles/work/Work.tox");
        assert_eq!(
            second.data_directory.replace('\\', "/"),
            "profiles/work/data"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_rejects_root_level_profile_layout() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-registry-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let valid = create_record(&root, &ProfileRegistry::default(), "Valid").unwrap();
        fs::write(root.join(&valid.file), b"profile").unwrap();
        let mut registry = ProfileRegistry {
            version: REGISTRY_VERSION,
            active_profile_id: Some("old".to_string()),
            profiles: vec![
                ProfileRecord {
                    id: "old".to_string(),
                    name: "Old".to_string(),
                    file: "outside-profiles.tox".to_string(),
                    data_directory: "data".to_string(),
                    encrypted: false,
                    enabled: true,
                    imported_from: None,
                    created_at: now(),
                },
                valid,
            ],
        };
        registry.retain_safe_records(&root);
        registry.ensure_active();
        assert_eq!(registry.profiles.len(), 1);
        assert_eq!(registry.profiles[0].id, "valid");
        assert_eq!(registry.active_profile_id.as_deref(), Some("valid"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_removes_duplicate_profile_records() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-dedup-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let record = create_record(&root, &ProfileRegistry::default(), "Duplicate").unwrap();
        fs::write(root.join(&record.file), b"profile").unwrap();
        let mut registry = ProfileRegistry {
            version: REGISTRY_VERSION,
            active_profile_id: Some(record.id.clone()),
            profiles: vec![record.clone(), record],
        };
        registry.retain_safe_records(&root);
        assert_eq!(registry.profiles.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_removes_records_whose_profile_file_was_destroyed() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-missing-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let record = create_record(&root, &ProfileRegistry::default(), "Destroyed").unwrap();
        let mut registry = ProfileRegistry {
            version: REGISTRY_VERSION,
            active_profile_id: Some(record.id.clone()),
            profiles: vec![record],
        };
        registry.retain_safe_records(&root);
        registry.ensure_active();
        assert!(registry.profiles.is_empty());
        assert!(registry.active_profile_id.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn continuing_with_loaded_profile_preserves_locked_profiles() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-skip-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let mut registry = ProfileRegistry::default();
        let loaded = create_record(&root, &registry, "Loaded").unwrap();
        registry.profiles.push(loaded.clone());
        let locked = create_record(&root, &registry, "Locked").unwrap();
        registry.profiles.push(locked.clone());
        registry.active_profile_id = Some(locked.id.clone());
        registry.prefer_loaded_active(&HashSet::from([loaded.id.clone()]));
        assert!(registry.profiles[0].enabled);
        assert!(registry.profiles[1].enabled);
        assert_eq!(
            registry.active_profile_id.as_deref(),
            Some(loaded.id.as_str())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn continuing_without_loaded_profiles_keeps_locked_profile_active() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-skip-empty-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let mut registry = ProfileRegistry::default();
        let locked = create_record(&root, &registry, "Locked").unwrap();
        registry.active_profile_id = Some(locked.id.clone());
        registry.profiles.push(locked.clone());
        registry.prefer_loaded_active(&HashSet::new());
        assert!(registry.profiles[0].enabled);
        assert_eq!(
            registry.active_profile_id.as_deref(),
            Some(locked.id.as_str())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disabling_profile_hides_only_that_profile_and_selects_loaded_active() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-disable-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let mut registry = ProfileRegistry::default();
        let loaded = create_record(&root, &registry, "Loaded").unwrap();
        registry.profiles.push(loaded.clone());
        let disabled = create_record(&root, &registry, "Disabled").unwrap();
        fs::write(root.join(&disabled.file), b"profile").unwrap();
        registry.profiles.push(disabled.clone());
        registry.active_profile_id = Some(disabled.id.clone());

        assert!(registry.disable_profile(&disabled.id, &HashSet::from([loaded.id.clone()])));
        assert!(registry.profiles[0].enabled);
        assert!(!registry.profiles[1].enabled);
        assert_eq!(
            registry.active_profile_id.as_deref(),
            Some(loaded.id.as_str())
        );
        assert!(root.join(&disabled.file).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disabling_last_profile_keeps_record_for_reimport() {
        let root = std::env::temp_dir().join(format!("kaigen-profile-disable-last-{}", now()));
        fs::create_dir_all(&root).unwrap();
        let mut registry = ProfileRegistry::default();
        let profile = create_record(&root, &registry, "Disabled").unwrap();
        fs::write(root.join(&profile.file), b"profile").unwrap();
        registry.active_profile_id = Some(profile.id.clone());
        registry.profiles.push(profile.clone());

        assert!(registry.disable_profile(&profile.id, &HashSet::new()));
        assert_eq!(registry.profiles.len(), 1);
        assert!(!registry.profiles[0].enabled);
        assert!(registry.active_profile_id.is_none());
        assert!(root.join(&profile.file).is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
