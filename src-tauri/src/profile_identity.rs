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
mod profile_identity_platform {
    use std::{ffi::OsStr, iter, os::windows::ffi::OsStrExt, ptr};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
        System::Threading::CreateMutexW,
    };

    use super::profile_identity_lock_name;

    pub(super) struct Guard {
        mutex: usize,
    }

    unsafe impl Send for Guard {}
    unsafe impl Sync for Guard {}

    impl Guard {
        pub(super) fn acquire(public_key: &str) -> Result<Self, String> {
            let name = format!(
                "Local\\Kaigen.ToxProfileIdentity.{}",
                profile_identity_lock_name(public_key)
            );
            let wide = OsStr::new(&name)
                .encode_wide()
                .chain(iter::once(0))
                .collect::<Vec<_>>();
            let mutex = unsafe { CreateMutexW(ptr::null(), 0, wide.as_ptr()) };
            if mutex.is_null() {
                return Err(format!(
                    "Could not create the Tox profile identity mutex: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                unsafe { CloseHandle(mutex) };
                return Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string());
            }
            Ok(Self {
                mutex: mutex as usize,
            })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.mutex as HANDLE) };
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod profile_identity_platform {
    use std::{fs::OpenOptions, io::ErrorKind, os::fd::AsRawFd, path::PathBuf};

    use super::profile_identity_lock_name;

    pub(super) struct Guard {
        lock: std::fs::File,
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
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| format!("Could not open the Tox identity lock: {error}"))?;
            let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(Self { lock });
            }
            let error = std::io::Error::last_os_error();
            match error.kind() {
                ErrorKind::WouldBlock => Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string()),
                _ => Err(format!("Could not lock the Tox profile identity: {error}")),
            }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe { libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN) };
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
