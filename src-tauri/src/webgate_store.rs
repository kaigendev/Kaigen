//! Protection for saved connection credentials, separate from ephemeral cache
//! keys. Windows uses current-user DPAPI. Unix uses an account-private key in
//! OS user state, never beside the portable connection records.

const MAX_STORE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn protect_webgate_store(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if plaintext.is_empty() || plaintext.len() > MAX_STORE_BYTES {
        return Err("WEBGATE_STORE_SIZE_INVALID".into());
    }
    platform::protect(plaintext)
}

pub(crate) fn unprotect_webgate_store(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if ciphertext.is_empty() || ciphertext.len() > MAX_STORE_BYTES + 64 * 1024 {
        return Err("WEBGATE_STORE_SIZE_INVALID".into());
    }
    let mut plaintext = platform::unprotect(ciphertext)?;
    if plaintext.is_empty() || plaintext.len() > MAX_STORE_BYTES {
        crate::wipe_secret_bytes(&mut plaintext);
        return Err("WEBGATE_STORE_SIZE_INVALID".into());
    }
    Ok(plaintext)
}

#[cfg(windows)]
mod platform {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    const PREFIX: &[u8] = b"KWGS1W";
    const ENTROPY: &[u8] = b"Kaigen.Webgate.Connections.v1";

    struct OwnedBlob(CRYPT_INTEGER_BLOB);
    impl Drop for OwnedBlob {
        fn drop(&mut self) {
            if !self.0.pbData.is_null() {
                // DPAPI owns this allocation and documents its exact byte
                // length and LocalFree lifetime. Erase it before releasing it.
                unsafe {
                    crate::wipe_secret_bytes(std::slice::from_raw_parts_mut(
                        self.0.pbData,
                        self.0.cbData as usize,
                    ));
                    LocalFree(self.0.pbData.cast());
                }
            }
        }
    }

    fn transform(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr().cast_mut(),
        };
        let mut output = OwnedBlob(CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        });
        // Both input slices remain alive throughout the synchronous call.
        // No machine-wide flag or interactive prompt is permitted.
        let success = unsafe {
            if encrypt {
                CryptProtectData(
                    &input,
                    ptr::null(),
                    &entropy,
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output.0,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    ptr::null_mut(),
                    &entropy,
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output.0,
                )
            }
        };
        if success == 0
            || output.0.pbData.is_null()
            || output.0.cbData == 0
            || output.0.cbData as usize > super::MAX_STORE_BYTES + 64 * 1024
        {
            return Err("WEBGATE_STORE_PROTECTION_FAILED".into());
        }
        // Successful DPAPI produced cbData readable bytes; OwnedBlob releases
        // the OS allocation after this bounded copy on every return path.
        Ok(
            unsafe { std::slice::from_raw_parts(output.0.pbData, output.0.cbData as usize) }
                .to_vec(),
        )
    }

    pub(super) fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = PREFIX.to_vec();
        out.extend(transform(data, true)?);
        Ok(out)
    }
    pub(super) fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        transform(
            data.strip_prefix(PREFIX)
                .ok_or("WEBGATE_STORE_FORMAT_INVALID")?,
            false,
        )
    }
}

#[cfg(unix)]
mod platform {
    use aes_gcm::{
        aead::{Aead, Payload},
        Aes256Gcm, KeyInit, Nonce,
    };
    use std::{
        fs,
        io::{Read, Write},
        os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        path::{Path, PathBuf},
    };

    const PREFIX: &[u8] = b"KWGS1U";
    const AAD: &[u8] = b"Kaigen.Webgate.Connections.v1.unix-account";
    struct Key([u8; 32]);
    impl Drop for Key {
        fn drop(&mut self) {
            crate::wipe_secret_bytes(&mut self.0);
        }
    }

    fn user_id() -> u32 {
        // geteuid takes no pointers and has no failure or ownership contract.
        unsafe { libc::geteuid() }
    }

    fn key_directory() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .ok_or("WEBGATE_STORE_HOME_UNAVAILABLE")?;
        let home =
            fs::canonicalize(PathBuf::from(home)).map_err(|_| "WEBGATE_STORE_HOME_UNAVAILABLE")?;
        if !home.is_absolute() {
            return Err("WEBGATE_STORE_HOME_UNAVAILABLE".into());
        }
        #[cfg(target_os = "macos")]
        let directory = home.join("Library/Application Support/Kaigen/Protected");
        #[cfg(not(target_os = "macos"))]
        let directory = home.join(".local/state/kaigen/protected");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)
            .map_err(|_| "WEBGATE_STORE_KEY_UNAVAILABLE")?;
        // Refuse replacement via writable or foreign-owned path components.
        // Existing directories are never chmod'ed or silently taken over.
        for part in directory.ancestors() {
            let meta = fs::symlink_metadata(part).map_err(|_| "WEBGATE_STORE_KEY_UNAVAILABLE")?;
            if !meta.is_dir()
                || meta.file_type().is_symlink()
                || (meta.uid() != user_id() && meta.uid() != 0)
                || meta.mode() & 0o022 != 0
            {
                return Err("WEBGATE_STORE_KEY_PERMISSIONS".into());
            }
        }
        let meta = fs::symlink_metadata(&directory).map_err(|_| "WEBGATE_STORE_KEY_UNAVAILABLE")?;
        if meta.uid() != user_id() || meta.mode() & 0o077 != 0 {
            return Err("WEBGATE_STORE_KEY_PERMISSIONS".into());
        }
        Ok(directory)
    }

    fn read_key(path: &Path) -> Result<Key, String> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| "WEBGATE_STORE_KEY_UNAVAILABLE")?;
        let meta = file
            .metadata()
            .map_err(|_| "WEBGATE_STORE_KEY_UNAVAILABLE")?;
        if !meta.is_file()
            || meta.uid() != user_id()
            || meta.mode() & 0o077 != 0
            || meta.len() != 32
        {
            return Err("WEBGATE_STORE_KEY_PERMISSIONS".into());
        }
        let mut key = Key([0; 32]);
        file.read_exact(&mut key.0)
            .map_err(|_| "WEBGATE_STORE_KEY_UNAVAILABLE")?;
        Ok(key)
    }

    fn account_key(create: bool) -> Result<Key, String> {
        let directory = key_directory()?;
        let target = directory.join("webgate-v1.key");
        match fs::symlink_metadata(&target) {
            Ok(_) => return read_key(&target),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {}
            Err(_) => return Err("WEBGATE_STORE_KEY_UNAVAILABLE".into()),
        }
        let mut key = Key([0; 32]);
        getrandom::fill(&mut key.0).map_err(|_| "WEBGATE_STORE_RANDOM_FAILED")?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "WEBGATE_STORE_RANDOM_FAILED")?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let pending = directory.join(format!(".webgate-{suffix}.key.new"));
        let publish = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&pending)?;
            file.write_all(&key.0)?;
            file.sync_all()?;
            // A fully synced key becomes visible atomically. A racing instance
            // may win, but can never have its established key overwritten.
            match fs::hard_link(&pending, &target) {
                Ok(()) => {
                    fs::File::open(&directory)?.sync_all()?;
                    Ok(())
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                Err(error) => Err(error),
            }
        })();
        let _ = fs::remove_file(&pending);
        publish.map_err(|_| "WEBGATE_STORE_KEY_UNAVAILABLE")?;
        read_key(&target)
    }

    pub(super) fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let key = account_key(true)?;
        let cipher =
            Aes256Gcm::new_from_slice(&key.0).map_err(|_| "WEBGATE_STORE_PROTECTION_FAILED")?;
        let mut nonce = [0_u8; 12];
        getrandom::fill(&mut nonce).map_err(|_| "WEBGATE_STORE_RANDOM_FAILED")?;
        let encrypted = cipher
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: data,
                    aad: AAD,
                },
            )
            .map_err(|_| "WEBGATE_STORE_PROTECTION_FAILED")?;
        let mut out = PREFIX.to_vec();
        out.extend(nonce);
        out.extend(encrypted);
        Ok(out)
    }
    pub(super) fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let body = data
            .strip_prefix(PREFIX)
            .filter(|body| body.len() >= 28)
            .ok_or("WEBGATE_STORE_FORMAT_INVALID")?;
        let key = account_key(false)?;
        let nonce: [u8; 12] = body[..12]
            .try_into()
            .map_err(|_| "WEBGATE_STORE_FORMAT_INVALID")?;
        Aes256Gcm::new_from_slice(&key.0)
            .map_err(|_| "WEBGATE_STORE_PROTECTION_FAILED")?
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &body[12..],
                    aad: AAD,
                },
            )
            .map_err(|_| "WEBGATE_STORE_PROTECTION_FAILED".into())
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    pub(super) fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("WEBGATE_STORE_PLATFORM_UNSUPPORTED".into())
    }
    pub(super) fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("WEBGATE_STORE_PLATFORM_UNSUPPORTED".into())
    }
}
