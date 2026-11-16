use super::{digest_hex, new_operation_id};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Only ciphertext reaches disk. The random namespace and key are never reopened.
pub struct EphemeralCache {
    directory: PathBuf,
    binding: Vec<u8>,
    key: Mutex<Option<[u8; 32]>>,
    objects: Mutex<HashSet<String>>,
}

impl EphemeralCache {
    pub fn new(root: &Path, binding: &[u8]) -> Result<Self, String> {
        let directory = root.join(format!("webgate-{}", new_operation_id()?));
        fs::create_dir_all(&directory).map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?;
        }
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|_| "WEBGATE_ENTROPY_UNAVAILABLE")?;
        Ok(Self {
            directory,
            binding: binding.to_vec(),
            key: Mutex::new(Some(key)),
            objects: Mutex::new(HashSet::new()),
        })
    }

    fn aad(&self, object: &str) -> Vec<u8> {
        let mut aad = b"kaigen-webgate-cache-v1\0".to_vec();
        aad.extend_from_slice(&self.binding);
        aad.push(0);
        aad.extend_from_slice(object.as_bytes());
        aad
    }

    pub fn put(&self, object: &str, plaintext: &[u8]) -> Result<(), String> {
        let key = self.key.lock().map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?;
        let cipher = Aes256Gcm::new_from_slice(key.as_ref().ok_or("WEBGATE_CLOSED")?)
            .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?;
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).map_err(|_| "WEBGATE_ENTROPY_UNAVAILABLE")?;
        let ciphertext = cipher
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: plaintext,
                    aad: &self.aad(object),
                },
            )
            .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?;
        let target = self.directory.join(digest_hex(object.as_bytes()));
        let pending = self.directory.join(format!("{}.new", new_operation_id()?));
        let write = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&pending)?;
            file.write_all(b"KWG1")?;
            file.write_all(&nonce)?;
            file.write_all(&ciphertext)?;
            file.sync_all()?;
            // Cache loss is harmless; Windows rename cannot replace an existing file.
            if target.exists() {
                fs::remove_file(&target)?;
            }
            fs::rename(&pending, &target)
        })();
        if write.is_err() {
            let _ = fs::remove_file(pending);
        }
        write.map_err(|_| "WEBGATE_CACHE_UNAVAILABLE".to_string())?;
        self.objects
            .lock()
            .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?
            .insert(object.to_string());
        Ok(())
    }

    pub fn get(&self, object: &str) -> Result<Option<Vec<u8>>, String> {
        let key = self.key.lock().map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?;
        let key = key.as_ref().ok_or("WEBGATE_CLOSED")?;
        let data = match fs::read(self.directory.join(digest_hex(object.as_bytes()))) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("WEBGATE_CACHE_UNAVAILABLE".into()),
        };
        if data.len() < 32 || &data[..4] != b"KWG1" {
            return Err("WEBGATE_CACHE_INVALID".into());
        }
        let nonce: [u8; 12] = data[4..16]
            .try_into()
            .map_err(|_| "WEBGATE_CACHE_INVALID")?;
        Aes256Gcm::new_from_slice(key)
            .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &data[16..],
                    aad: &self.aad(object),
                },
            )
            .map(Some)
            .map_err(|_| "WEBGATE_CACHE_INVALID".into())
    }

    pub fn invalidate(&self, object: &str) -> Result<(), String> {
        let _key = self.key.lock().map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?;
        self.objects
            .lock()
            .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?
            .remove(object);
        match fs::remove_file(self.directory.join(digest_hex(object.as_bytes()))) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("WEBGATE_CACHE_UNAVAILABLE".into()),
        }
    }

    pub fn invalidate_prefix(&self, prefix: &str) -> Result<(), String> {
        let objects: Vec<String> = self
            .objects
            .lock()
            .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?
            .iter()
            .filter(|object| object.starts_with(prefix))
            .cloned()
            .collect();
        for object in objects {
            self.invalidate(&object)?;
        }
        Ok(())
    }

    /// Keep the RAM key/session while discarding every cached object.
    pub fn invalidate_all(&self) -> Result<(), String> {
        self.invalidate_prefix("")
    }

    pub fn clear(&self) {
        if let Ok(mut key) = self.key.lock() {
            if let Some(bytes) = key.as_mut() {
                crate::wipe_secret_bytes(bytes);
            }
            *key = None;
            if let Ok(mut objects) = self.objects.lock() {
                objects.clear();
            }
            // The path is an opaque namespace created by this object, never caller input.
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

impl Drop for EphemeralCache {
    fn drop(&mut self) {
        self.clear();
    }
}
