use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

use sha2::{Digest, Sha256};

static ACTIVE_PROFILE_IDENTITIES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn profile_identity_key(public_key: &str) -> Result<String, String> {
    let public_key = public_key.trim().to_ascii_uppercase();
    if public_key.len() != 64 || !public_key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("TOX_PROFILE_IDENTITY_INVALID".to_string());
    }
    Ok(public_key)
}

fn profile_identity_lock_name(public_key: &str) -> String {
    let digest = Sha256::digest(public_key.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Keeps one Tox identity exclusive across every product target, workspace,
/// and process on this machine. Two toxcore instances must never load the same
/// savedata concurrently.
pub(crate) struct ProfileIdentityGuard {
    public_key: String,
    platform: Option<profile_identity_platform::Guard>,
}

impl ProfileIdentityGuard {
    pub(crate) fn acquire(public_key: &str) -> Result<Self, String> {
        let public_key = profile_identity_key(public_key)?;
        let identities = ACTIVE_PROFILE_IDENTITIES.get_or_init(|| Mutex::new(HashSet::new()));
        {
            let mut identities = identities
                .lock()
                .map_err(|_| "Could not reserve the Tox profile identity".to_string())?;
            if !identities.insert(public_key.clone()) {
                return Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string());
            }
        }

        match profile_identity_platform::Guard::acquire(&public_key) {
            Ok(platform) => Ok(Self {
                public_key,
                platform: Some(platform),
            }),
            Err(error) => {
                if let Ok(mut identities) = identities.lock() {
                    identities.remove(&public_key);
                }
                Err(error)
            }
        }
    }
}

impl Drop for ProfileIdentityGuard {
    fn drop(&mut self) {
        drop(self.platform.take());
        if let Some(identities) = ACTIVE_PROFILE_IDENTITIES.get() {
            match identities.lock() {
                Ok(mut identities) => {
                    identities.remove(&self.public_key);
                }
                Err(poisoned) => {
                    poisoned.into_inner().remove(&self.public_key);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
#[path = "windows_named_mutex.rs"]
mod windows_named_mutex;

#[cfg(target_os = "windows")]
mod profile_identity_platform {
    use std::os::windows::io::OwnedHandle;

    use super::{profile_identity_lock_name, windows_named_mutex};

    pub(super) struct Guard {
        _mutex: OwnedHandle,
    }

    impl Guard {
        pub(super) fn acquire(public_key: &str) -> Result<Self, String> {
            let name = format!(
                "Local\\Kaigen.ToxProfileIdentity.{}",
                profile_identity_lock_name(public_key)
            );
            let (mutex, already_exists) = windows_named_mutex::create(&name)
                .map_err(|error| format!("Could not create the Tox profile identity mutex: {error}"))?;
            if already_exists {
                return Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string());
            }
            Ok(Self { _mutex: mutex })
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod profile_identity_platform {
    use std::{
        fs::{File, OpenOptions, TryLockError},
        path::PathBuf,
    };

    use super::profile_identity_lock_name;

    pub(super) struct Guard {
        _lock: File,
    }

    impl Guard {
        pub(super) fn acquire(public_key: &str) -> Result<Self, String> {
            let directory: PathBuf = std::env::temp_dir().join("kaigen-profile-identities");
            std::fs::create_dir_all(&directory).map_err(|error| {
                format!("Could not create the Tox identity lock directory: {error}")
            })?;
            let path = directory.join(format!("{}.lock", profile_identity_lock_name(public_key)));
            let lock = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| format!("Could not open the Tox identity lock: {error}"))?;
            match lock.try_lock() {
                Ok(()) => Ok(Self { _lock: lock }),
                Err(TryLockError::WouldBlock) => {
                    Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string())
                }
                Err(TryLockError::Error(error)) => {
                    Err(format!("Could not lock the Tox profile identity: {error}"))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_identity_is_rejected_and_released() {
        let alice = "A".repeat(64);
        let first = ProfileIdentityGuard::acquire(&alice).unwrap();
        assert_eq!(
            ProfileIdentityGuard::acquire(&alice).err().as_deref(),
            Some("TOX_PROFILE_IDENTITY_ALREADY_LOADED")
        );
        drop(first);
        ProfileIdentityGuard::acquire(&alice).unwrap();
    }

    #[test]
    fn invalid_identity_is_rejected() {
        assert_eq!(
            ProfileIdentityGuard::acquire("not-a-public-key")
                .err()
                .as_deref(),
            Some("TOX_PROFILE_IDENTITY_INVALID")
        );
    }
}
