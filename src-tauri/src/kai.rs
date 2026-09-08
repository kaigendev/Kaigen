use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CONTAINER_MAGIC: &[u8; 8] = b"KAI\0PRF1";
const SNAPSHOT_MAGIC: &[u8; 8] = b"KAIRAM01";
const FORMAT_VERSION: u32 = 1;
const MIN_VOLUME_BYTES: u64 = 50 * 1024 * 1024;
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_CONTAINER_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyEnvelope {
    password_protected: bool,
    kdf_salt: [u8; 32],
    nonce: [u8; 12],
    wrapped_dek: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContainerHeader {
    version: u32,
    container_id: [u8; 32],
    envelope: KeyEnvelope,
    payload_nonce: [u8; 12],
    payload_bytes: u64,
    logical_bytes: u64,
    volume_bytes: u64,
    checkpointed_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeySidecar {
    format: String,
    version: u32,
    container_id: [u8; 32],
    envelope: KeyEnvelope,
    critical_nonce: [u8; 12],
    critical_bytes: u64,
    critical_ciphertext: Vec<u8>,
    checkpointed_at: u64,
}

#[derive(Clone)]
struct EncryptedFile {
    nonce: [u8; 12],
    logical_bytes: u64,
    ciphertext: Vec<u8>,
}

struct CheckpointFailure {
    container_committed: bool,
    durability_committed: bool,
    message: String,
}

impl From<String> for CheckpointFailure {
    fn from(message: String) -> Self {
        Self {
            container_committed: false,
            durability_committed: false,
            message,
        }
    }
}

type DurabilityCallback = dyn Fn() -> Result<(), String> + Send + Sync;

struct KaiDurabilityHookInner {
    gate: Mutex<()>,
    callback: Box<DurabilityCallback>,
    poisoned: AtomicBool,
}

/// Optional outer durability boundary used by the Web runtime. Every profile
/// volume in one workspace shares the same hook, so an inner `.kai` replacement
/// and the encrypted persistent workspace generation are serialized as one
/// publication transaction without taking the Web workspace registry lock.
#[derive(Clone)]
pub(crate) struct KaiDurabilityHook(Arc<KaiDurabilityHookInner>);

impl KaiDurabilityHook {
    pub(crate) fn new(callback: impl Fn() -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(KaiDurabilityHookInner {
            gate: Mutex::new(()),
            callback: Box::new(callback),
            poisoned: AtomicBool::new(false),
        }))
    }

    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        let _gate = self
            .0
            .gate
            .lock()
            .map_err(|_| "WEB_DURABILITY_GATE_UNAVAILABLE".to_string())?;
        self.checkpoint_while_locked()
    }

    fn checkpoint_while_locked(&self) -> Result<(), String> {
        if self.0.poisoned.load(Ordering::Acquire) {
            return Err("WEB_DURABILITY_POISONED".to_string());
        }
        (self.0.callback)()
    }

    fn poison(&self) {
        self.0.poisoned.store(true, Ordering::Release);
    }
}

struct LockedKey {
    bytes: Box<[u8; 32]>,
    locked: bool,
}

impl LockedKey {
    fn new(bytes: [u8; 32]) -> Result<Self, String> {
        let mut value = Self {
            bytes: Box::new(bytes),
            locked: false,
        };
        value.locked = lock_memory(value.bytes.as_mut_ptr(), value.bytes.len())?;
        if !value.locked {
            return Err("KAI_SECURE_MEMORY_LOCK_FAILED".to_string());
        }
        Ok(value)
    }

    fn expose(&self) -> &[u8; 32] {
        &self.bytes
    }
}

impl Drop for LockedKey {
    fn drop(&mut self) {
        wipe(self.bytes.as_mut_slice());
        if self.locked {
            unlock_memory(self.bytes.as_mut_ptr(), self.bytes.len());
        }
    }
}

pub struct KaiProfileVolume {
    namespace_root: PathBuf,
    container_path: PathBuf,
    key_path: PathBuf,
    container_id: [u8; 32],
    envelope: Mutex<KeyEnvelope>,
    dek: LockedKey,
    files: Mutex<BTreeMap<String, EncryptedFile>>,
    directories: Mutex<BTreeSet<String>>,
    logical_bytes: AtomicU64,
    volume_bytes: AtomicU64,
    dirty: AtomicBool,
    discarded: AtomicBool,
    revision: AtomicU64,
    checkpoint_generation: AtomicU64,
    last_checkpoint: Mutex<Instant>,
    durability_hook: Mutex<Option<KaiDurabilityHook>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KaiContainerInfo {
    pub password_protected: bool,
    pub logical_bytes: u64,
    pub volume_bytes: u64,
}

impl std::fmt::Debug for KaiProfileVolume {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KaiProfileVolume")
            .field("namespace_root", &self.namespace_root)
            .field("container_path", &self.container_path)
            .field("logical_bytes", &self.logical_bytes.load(Ordering::Relaxed))
            .field("volume_bytes", &self.volume_bytes.load(Ordering::Relaxed))
            .field("dirty", &self.dirty.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

static VOLUMES: OnceLock<Mutex<Vec<Weak<KaiProfileVolume>>>> = OnceLock::new();

fn volumes() -> &'static Mutex<Vec<Weak<KaiProfileVolume>>> {
    VOLUMES.get_or_init(|| Mutex::new(Vec::new()))
}

impl KaiProfileVolume {
    pub fn inspect(container_path: &Path) -> Result<KaiContainerInfo, String> {
        let bytes = fs::read(container_path)
            .map_err(|error| format!("Could not read .kai profile: {error}"))?;
        let (header, _) = parse_container(&bytes)?;
        let envelope = read_key_sidecar(&key_path_for(container_path), &header.container_id)?
            .filter(|sidecar| sidecar.checkpointed_at >= header.checkpointed_at)
            .map(|sidecar| sidecar.envelope)
            .unwrap_or(header.envelope);
        Ok(KaiContainerInfo {
            password_protected: envelope.password_protected,
            logical_bytes: header.logical_bytes,
            volume_bytes: header.volume_bytes,
        })
    }

    pub fn create(container_path: PathBuf, password: Option<&str>) -> Result<Arc<Self>, String> {
        if container_path.extension().and_then(|value| value.to_str()) != Some("kai") {
            return Err("KAI_CONTAINER_EXTENSION_INVALID".to_string());
        }
        let container_id = random_array::<32>()?;
        let dek = random_array::<32>()?;
        let envelope = wrap_dek(&container_id, &dek, password)?;
        let namespace_root = namespace_for(&container_path, &container_id)?;
        let key_path = key_path_for(&container_path);
        let mut directories = BTreeSet::new();
        directories.insert(String::new());
        directories.insert("data".to_string());
        let volume = Arc::new(Self {
            namespace_root,
            container_path,
            key_path,
            container_id,
            envelope: Mutex::new(envelope),
            dek: LockedKey::new(dek)?,
            files: Mutex::new(BTreeMap::new()),
            directories: Mutex::new(directories),
            logical_bytes: AtomicU64::new(0),
            volume_bytes: AtomicU64::new(MIN_VOLUME_BYTES),
            dirty: AtomicBool::new(true),
            discarded: AtomicBool::new(false),
            revision: AtomicU64::new(1),
            checkpoint_generation: AtomicU64::new(0),
            last_checkpoint: Mutex::new(Instant::now() - CHECKPOINT_INTERVAL),
            durability_hook: Mutex::new(None),
        });
        register(&volume)?;
        Ok(volume)
    }

    pub fn open(container_path: PathBuf, password: Option<&str>) -> Result<Arc<Self>, String> {
        let bytes = fs::read(&container_path)
            .map_err(|error| format!("Could not read .kai profile: {error}"))?;
        let (header, encrypted_payload) = parse_container(&bytes)?;
        let sidecar = read_key_sidecar(&key_path_for(&container_path), &header.container_id)?;
        let current_sidecar = sidecar
            .as_ref()
            .filter(|value| value.checkpointed_at >= header.checkpointed_at);
        let envelope = current_sidecar
            .map(|value| &value.envelope)
            .unwrap_or(&header.envelope);
        let dek = unwrap_dek(&header.container_id, envelope, password)?;
        let payload_key = derive_key(
            b"kaigen-kai-container-payload-v1",
            &dek,
            &header.container_id,
        );
        let aad = payload_aad(
            &header.container_id,
            header.logical_bytes,
            header.volume_bytes,
        );
        let mut payload = Aes256Gcm::new_from_slice(&payload_key)
            .map_err(|_| "KAI_CONTAINER_KEY_INVALID".to_string())?
            .decrypt(
                &Nonce::from(header.payload_nonce),
                Payload {
                    msg: encrypted_payload,
                    aad: &aad,
                },
            )
            .map_err(|_| "KAI_CONTAINER_AUTHENTICATION_FAILED".to_string())?;
        let (directories, mut files, mut logical_bytes) = parse_snapshot(&payload)?;
        wipe(&mut payload);
        let repair_authenticated_logical_overcount = header.logical_bytes > logical_bytes;
        if header.logical_bytes < logical_bytes
            || header.volume_bytes < MIN_VOLUME_BYTES
            || header.volume_bytes < logical_bytes.saturating_mul(2)
        {
            return Err("KAI_CONTAINER_CAPACITY_INVALID".to_string());
        }
        if let Some(sidecar) = current_sidecar.filter(|value| value.critical_bytes > 0) {
            if sidecar.critical_bytes > MAX_CONTAINER_BYTES {
                return Err("KAI_KEY_SIDECAR_INVALID".to_string());
            }
            let critical_key = derive_key(
                b"kaigen-kai-critical-savedata-v1",
                &dek,
                &header.container_id,
            );
            let aad = critical_aad(
                &header.container_id,
                sidecar.critical_bytes,
                sidecar.checkpointed_at,
            );
            let mut savedata = Aes256Gcm::new_from_slice(&critical_key)
                .map_err(|_| "KAI_KEY_SIDECAR_INVALID".to_string())?
                .decrypt(
                    &Nonce::from(sidecar.critical_nonce),
                    Payload {
                        msg: &sidecar.critical_ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| "KAI_KEY_SIDECAR_AUTHENTICATION_FAILED".to_string())?;
            if savedata.len() as u64 != sidecar.critical_bytes {
                wipe(&mut savedata);
                return Err("KAI_KEY_SIDECAR_INVALID".to_string());
            }
            let replacement =
                encrypt_memory_file(&dek, &header.container_id, "profile.tox", &savedata)?;
            wipe(&mut savedata);
            let previous = files
                .insert("profile.tox".to_string(), replacement)
                .map(|value| value.logical_bytes)
                .unwrap_or(0);
            logical_bytes = logical_bytes
                .saturating_sub(previous)
                .saturating_add(sidecar.critical_bytes);
        }
        let namespace_root = namespace_for(&container_path, &header.container_id)?;
        let volume_bytes = MIN_VOLUME_BYTES.max(logical_bytes.saturating_mul(2));
        if volume_bytes > MAX_CONTAINER_BYTES {
            return Err("KAI_CONTAINER_CAPACITY_INVALID".to_string());
        }
        let volume = Arc::new(Self {
            namespace_root,
            key_path: key_path_for(&container_path),
            container_path,
            container_id: header.container_id,
            envelope: Mutex::new(envelope.clone()),
            dek: LockedKey::new(dek)?,
            files: Mutex::new(files),
            directories: Mutex::new(directories),
            logical_bytes: AtomicU64::new(logical_bytes),
            volume_bytes: AtomicU64::new(volume_bytes),
            dirty: AtomicBool::new(repair_authenticated_logical_overcount),
            discarded: AtomicBool::new(false),
            revision: AtomicU64::new(1),
            checkpoint_generation: AtomicU64::new(
                current_sidecar
                    .map(|value| value.checkpointed_at)
                    .unwrap_or(header.checkpointed_at)
                    .max(header.checkpointed_at),
            ),
            last_checkpoint: Mutex::new(Instant::now()),
            durability_hook: Mutex::new(None),
        });
        if repair_authenticated_logical_overcount {
            volume.checkpoint(true)?;
        }
        register(&volume)?;
        Ok(volume)
    }

    pub fn namespace_root(&self) -> &Path {
        &self.namespace_root
    }

    pub fn container_path(&self) -> &Path {
        &self.container_path
    }

    pub fn key_path(&self) -> &Path {
        &self.key_path
    }

    pub(crate) fn set_durability_hook(&self, hook: KaiDurabilityHook) -> Result<(), String> {
        let mut current = self
            .durability_hook
            .lock()
            .map_err(|_| "WEB_DURABILITY_HOOK_UNAVAILABLE".to_string())?;
        *current = Some(hook);
        Ok(())
    }

    pub fn password_protected(&self) -> bool {
        self.envelope
            .lock()
            .map(|value| value.password_protected)
            .unwrap_or(true)
    }

    pub fn logical_bytes(&self) -> u64 {
        self.logical_bytes.load(Ordering::Relaxed)
    }

    pub fn volume_bytes(&self) -> u64 {
        self.volume_bytes.load(Ordering::Relaxed)
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Relaxed)
    }

    pub fn contains(&self, path: &Path) -> bool {
        path == self.namespace_root || path.starts_with(&self.namespace_root)
    }

    pub fn is_file(&self, path: &Path) -> Result<bool, String> {
        let relative = self.relative(path)?;
        Ok(self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?
            .contains_key(&relative))
    }

    pub fn is_dir(&self, path: &Path) -> Result<bool, String> {
        let relative = self.relative(path)?;
        Ok(self
            .directories
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?
            .contains(&relative))
    }

    pub fn create_dir_all(&self, path: &Path) -> Result<(), String> {
        let relative = self.relative(path)?;
        let mut directories = self
            .directories
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let mut current = PathBuf::new();
        let mut changed = directories.insert(String::new());
        for component in Path::new(&relative).components() {
            if let Component::Normal(value) = component {
                current.push(value);
                changed |= directories.insert(relative_string(&current)?);
            }
        }
        if changed {
            self.mark_dirty();
        }
        Ok(())
    }

    pub fn write(&self, path: &Path, plaintext: &[u8]) -> Result<(), String> {
        let relative = self.relative(path)?;
        if relative.is_empty() {
            return Err("KAI_VOLUME_PATH_INVALID".to_string());
        }
        if let Some(parent) = Path::new(&relative).parent() {
            self.create_dir_all(&self.namespace_root.join(parent))?;
        }
        let nonce = random_array::<12>()?;
        let key = derive_key(
            b"kaigen-kai-volume-file-v1",
            self.dek.expose(),
            &self.container_id,
        );
        let aad = file_aad(&self.container_id, &relative, plaintext.len() as u64);
        let ciphertext = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "KAI_VOLUME_KEY_INVALID".to_string())?
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| "KAI_VOLUME_ENCRYPTION_FAILED".to_string())?;
        let mut files = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let previous = files
            .get(&relative)
            .map(|value| value.logical_bytes)
            .unwrap_or(0);
        let next_logical = self
            .logical_bytes
            .load(Ordering::Relaxed)
            .saturating_sub(previous)
            .saturating_add(plaintext.len() as u64);
        let next_capacity = MIN_VOLUME_BYTES.max(next_logical.saturating_mul(2));
        if next_capacity > MAX_CONTAINER_BYTES {
            return Err("KAI_VOLUME_CAPACITY_EXCEEDED".to_string());
        }
        if let Some(mut replaced) = files.insert(
            relative,
            EncryptedFile {
                nonce,
                logical_bytes: plaintext.len() as u64,
                ciphertext,
            },
        ) {
            // Replaced PQ ratchet state must not remain recoverable in an
            // allocator buffer under this mounted volume's still-live DEK.
            wipe(&mut replaced.ciphertext);
            wipe(&mut replaced.nonce);
        }
        self.logical_bytes.store(next_logical, Ordering::Relaxed);
        self.volume_bytes.store(next_capacity, Ordering::Relaxed);
        self.mark_dirty();
        Ok(())
    }

    /// Replaces one logical file and does not report failure after its new
    /// value has crossed the durable container-commit boundary. A failure
    /// before that boundary restores only this file; concurrent dirty writes
    /// to other logical files remain staged for their next checkpoint.
    pub fn write_checkpointed(&self, path: &Path, plaintext: &[u8]) -> Result<(), String> {
        self.write_checkpointed_inner(path, plaintext, || {})
    }

    fn write_checkpointed_inner<F>(
        &self,
        path: &Path,
        plaintext: &[u8],
        before_rollback: F,
    ) -> Result<(), String>
    where
        F: FnOnce(),
    {
        let relative = self.relative(path)?;
        if relative.is_empty() {
            return Err("KAI_VOLUME_PATH_INVALID".to_string());
        }
        // This mutex already serializes every checkpoint. Holding it across
        // the staged write prevents another checkpoint from publishing this
        // file before we can classify a failure as pre- or post-commit.
        let mut last = self
            .last_checkpoint
            .lock()
            .map_err(|_| "KAI_CHECKPOINT_UNAVAILABLE".to_string())?;
        let durability_hook = self
            .durability_hook
            .lock()
            .map_err(|_| "WEB_DURABILITY_HOOK_UNAVAILABLE".to_string())?
            .clone();
        // Keep this exact guard through both the attempted publication and a
        // possible rollback publication. No other profile or workspace-level
        // checkpoint may seal the rejected inner generation between them.
        let _durability_gate = match durability_hook.as_ref() {
            Some(hook) => {
                let gate = hook
                    .0
                    .gate
                    .lock()
                    .map_err(|_| "WEB_DURABILITY_GATE_UNAVAILABLE".to_string())?;
                if hook.0.poisoned.load(Ordering::Acquire) {
                    return Err("WEB_DURABILITY_POISONED".to_string());
                }
                Some(gate)
            }
            None => None,
        };
        let mut previous = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?
            .get(&relative)
            .cloned();
        if let Err(error) = self.write(path, plaintext) {
            if let Some(previous) = previous.as_mut() {
                wipe(&mut previous.ciphertext);
                wipe(&mut previous.nonce);
            }
            return Err(error);
        }
        let installed_nonce = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?
            .get(&relative)
            .map(|file| file.nonce)
            .ok_or_else(|| "KAI_TRANSACTION_FILE_MISSING".to_string())?;

        match self.checkpoint_locked_inner(true, &mut last, durability_hook.as_ref()) {
            Ok(_) => {
                if let Some(previous) = previous.as_mut() {
                    wipe(&mut previous.ciphertext);
                    wipe(&mut previous.nonce);
                }
                Ok(())
            }
            // The protocol state is replayable from every configured durable
            // layer. Treat the redundant sidecar failure as committed;
            // `dirty` remains set so a later checkpoint retries the sidecar.
            Err(failure) if failure.durability_committed => {
                if let Some(previous) = previous.as_mut() {
                    wipe(&mut previous.ciphertext);
                    wipe(&mut previous.nonce);
                }
                Ok(())
            }
            Err(failure) => {
                let container_committed = failure.container_committed;
                let failure_message = failure.message;
                let mut files = self
                    .files
                    .lock()
                    .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
                let current_matches = files
                    .get(&relative)
                    .is_some_and(|file| file.nonce == installed_nonce);
                if !current_matches {
                    if let Some(previous) = previous.as_mut() {
                        wipe(&mut previous.ciphertext);
                        wipe(&mut previous.nonce);
                    }
                    return Err("KAI_TRANSACTION_FILE_CHANGED".to_string());
                }
                let mut installed = files
                    .remove(&relative)
                    .ok_or_else(|| "KAI_TRANSACTION_FILE_MISSING".to_string())?;
                let installed_bytes = installed.logical_bytes;
                wipe(&mut installed.ciphertext);
                wipe(&mut installed.nonce);
                let restored_bytes = previous
                    .as_ref()
                    .map(|file| file.logical_bytes)
                    .unwrap_or(0);
                if let Some(previous) = previous.take() {
                    files.insert(relative, previous);
                }
                let next_logical = self
                    .logical_bytes
                    .load(Ordering::Relaxed)
                    .saturating_sub(installed_bytes)
                    .saturating_add(restored_bytes);
                self.logical_bytes.store(next_logical, Ordering::Relaxed);
                self.volume_bytes.store(
                    MIN_VOLUME_BYTES.max(next_logical.saturating_mul(2)),
                    Ordering::Relaxed,
                );
                self.mark_dirty();
                drop(files);

                // The inner tmpfs container crossed its rename boundary, but
                // its Web workspace generation did not. Restore the previous
                // logical value through the same full outer barrier before
                // reporting failure, so callers which roll back their memory
                // state cannot later have that rejected generation published
                // by an unrelated workspace checkpoint.
                if container_committed {
                    before_rollback();
                    let rollback_durable = match self.checkpoint_locked_inner(
                        true,
                        &mut last,
                        durability_hook.as_ref(),
                    ) {
                        Ok(_) => true,
                        Err(rollback) => rollback.durability_committed,
                    };
                    if !rollback_durable {
                        if let Ok(hook) = self.durability_hook.lock() {
                            if let Some(hook) = hook.as_ref() {
                                hook.poison();
                            }
                        }
                        return Err("WEB_DURABILITY_ROLLBACK_FAILED".to_string());
                    }
                }
                Err(failure_message)
            }
        }
    }

    pub fn read(&self, path: &Path) -> Result<Vec<u8>, String> {
        let relative = self.relative(path)?;
        let file = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?
            .get(&relative)
            .cloned()
            .ok_or_else(|| "KAI_VOLUME_FILE_NOT_FOUND".to_string())?;
        let key = derive_key(
            b"kaigen-kai-volume-file-v1",
            self.dek.expose(),
            &self.container_id,
        );
        let aad = file_aad(&self.container_id, &relative, file.logical_bytes);
        let plaintext = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "KAI_VOLUME_KEY_INVALID".to_string())?
            .decrypt(
                &Nonce::from(file.nonce),
                Payload {
                    msg: &file.ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "KAI_VOLUME_AUTHENTICATION_FAILED".to_string())?;
        if plaintext.len() as u64 != file.logical_bytes {
            return Err("KAI_VOLUME_FILE_TRUNCATED".to_string());
        }
        Ok(plaintext)
    }

    pub fn remove_file(&self, path: &Path) -> Result<(), String> {
        let relative = self.relative(path)?;
        let mut files = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        if let Some(mut removed) = files.remove(&relative) {
            let next = self
                .logical_bytes
                .load(Ordering::Relaxed)
                .saturating_sub(removed.logical_bytes);
            wipe(&mut removed.ciphertext);
            self.logical_bytes.store(next, Ordering::Relaxed);
            self.volume_bytes.store(
                MIN_VOLUME_BYTES.max(next.saturating_mul(2)),
                Ordering::Relaxed,
            );
            self.mark_dirty();
        }
        Ok(())
    }

    pub fn remove_dir_all(&self, path: &Path) -> Result<(), String> {
        let relative = self.relative(path)?;
        let prefix = if relative.is_empty() {
            String::new()
        } else {
            format!("{relative}/")
        };
        let mut removed_bytes = 0_u64;
        let mut files = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let targets = files
            .keys()
            .filter(|name| *name == &relative || name.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for target in targets {
            if let Some(mut removed) = files.remove(&target) {
                removed_bytes = removed_bytes.saturating_add(removed.logical_bytes);
                wipe(&mut removed.ciphertext);
            }
        }
        drop(files);
        let mut directories = self
            .directories
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        directories
            .retain(|name| name.is_empty() || (name != &relative && !name.starts_with(&prefix)));
        let next = self
            .logical_bytes
            .load(Ordering::Relaxed)
            .saturating_sub(removed_bytes);
        self.logical_bytes.store(next, Ordering::Relaxed);
        self.volume_bytes.store(
            MIN_VOLUME_BYTES.max(next.saturating_mul(2)),
            Ordering::Relaxed,
        );
        self.mark_dirty();
        Ok(())
    }

    pub fn rename(&self, source: &Path, destination: &Path) -> Result<(), String> {
        let source = self.relative(source)?;
        let destination = self.relative(destination)?;
        let mut files = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let mut file = files
            .remove(&source)
            .ok_or_else(|| "KAI_VOLUME_FILE_NOT_FOUND".to_string())?;
        let key = derive_key(
            b"kaigen-kai-volume-file-v1",
            self.dek.expose(),
            &self.container_id,
        );
        let old_aad = file_aad(&self.container_id, &source, file.logical_bytes);
        let mut plaintext = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "KAI_VOLUME_KEY_INVALID".to_string())?
            .decrypt(
                &Nonce::from(file.nonce),
                Payload {
                    msg: &file.ciphertext,
                    aad: &old_aad,
                },
            )
            .map_err(|_| "KAI_VOLUME_AUTHENTICATION_FAILED".to_string())?;
        wipe(&mut file.ciphertext);
        let nonce = random_array::<12>()?;
        let new_aad = file_aad(&self.container_id, &destination, file.logical_bytes);
        let ciphertext = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "KAI_VOLUME_KEY_INVALID".to_string())?
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &plaintext,
                    aad: &new_aad,
                },
            )
            .map_err(|_| "KAI_VOLUME_ENCRYPTION_FAILED".to_string())?;
        wipe(&mut plaintext);
        file.nonce = nonce;
        file.ciphertext = ciphertext;
        let replaced = files.insert(destination, file);
        if let Some(mut replaced) = replaced {
            let next = self
                .logical_bytes
                .load(Ordering::Relaxed)
                .saturating_sub(replaced.logical_bytes);
            wipe(&mut replaced.ciphertext);
            self.logical_bytes.store(next, Ordering::Relaxed);
            self.volume_bytes.store(
                MIN_VOLUME_BYTES.max(next.saturating_mul(2)),
                Ordering::Relaxed,
            );
        }
        self.mark_dirty();
        Ok(())
    }

    pub fn list(&self, directory: &Path) -> Result<Vec<MemoryEntry>, String> {
        let relative = self.relative(directory)?;
        let prefix = if relative.is_empty() {
            String::new()
        } else {
            format!("{relative}/")
        };
        let files = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let directories = self
            .directories
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let mut names = BTreeMap::<String, MemoryEntry>::new();
        for (path, file) in files.iter() {
            if let Some(child) = direct_child(&prefix, path) {
                let is_direct = !child.contains('/');
                let name = child.split('/').next().unwrap_or_default();
                let child_path = directory.join(name);
                names.entry(name.to_string()).or_insert(MemoryEntry {
                    path: child_path,
                    is_file: is_direct,
                    is_dir: !is_direct,
                    len: is_direct.then_some(file.logical_bytes).unwrap_or(0),
                });
            }
        }
        for path in directories.iter() {
            if let Some(child) = direct_child(&prefix, path) {
                let name = child.split('/').next().unwrap_or_default();
                if !name.is_empty() {
                    names.entry(name.to_string()).or_insert(MemoryEntry {
                        path: directory.join(name),
                        is_file: false,
                        is_dir: true,
                        len: 0,
                    });
                }
            }
        }
        Ok(names.into_values().collect())
    }

    pub fn snapshot_plain_files(&self, root: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
        let relative = self.relative(root)?;
        let prefix = if relative.is_empty() {
            String::new()
        } else {
            format!("{relative}/")
        };
        let paths = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?
            .keys()
            .filter(|path| relative.is_empty() || *path == &relative || path.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        paths
            .into_iter()
            .map(|relative| {
                let path = self.namespace_root.join(&relative);
                self.read(&path).map(|bytes| (path, bytes))
            })
            .collect()
    }

    pub fn checkpoint(&self, force: bool) -> Result<bool, String> {
        let mut last = self
            .last_checkpoint
            .lock()
            .map_err(|_| "KAI_CHECKPOINT_UNAVAILABLE".to_string())?;
        self.checkpoint_locked(force, &mut last)
            .map_err(|failure| failure.message)
    }

    fn checkpoint_locked(
        &self,
        force: bool,
        last: &mut Instant,
    ) -> Result<bool, CheckpointFailure> {
        let hook = self
            .durability_hook
            .lock()
            .map_err(|_| "WEB_DURABILITY_HOOK_UNAVAILABLE".to_string())?
            .clone();
        let Some(hook) = hook else {
            return self.checkpoint_locked_inner(force, last, None);
        };
        let _gate = hook
            .0
            .gate
            .lock()
            .map_err(|_| "WEB_DURABILITY_GATE_UNAVAILABLE".to_string())?;
        if hook.0.poisoned.load(Ordering::Acquire) {
            return Err("WEB_DURABILITY_POISONED".to_string().into());
        }
        self.checkpoint_locked_inner(force, last, Some(&hook))
    }

    fn checkpoint_locked_inner(
        &self,
        force: bool,
        last: &mut Instant,
        durability_hook: Option<&KaiDurabilityHook>,
    ) -> Result<bool, CheckpointFailure> {
        if self.discarded.load(Ordering::Acquire) {
            return Ok(false);
        }
        if !self.dirty.load(Ordering::Acquire) {
            return Ok(false);
        }
        if !force && last.elapsed() < CHECKPOINT_INTERVAL {
            return Ok(false);
        }
        let files = self
            .files
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let directories = self
            .directories
            .lock()
            .map_err(|_| "KAI_VOLUME_UNAVAILABLE".to_string())?;
        let logical_bytes = self.logical_bytes.load(Ordering::Relaxed);
        let volume_bytes = MIN_VOLUME_BYTES.max(logical_bytes.saturating_mul(2));
        let mut snapshot = encode_snapshot(&directories, &files)?;
        let snapshot_revision = self.revision.load(Ordering::Acquire);
        drop(directories);
        drop(files);
        let payload_key = derive_key(
            b"kaigen-kai-container-payload-v1",
            self.dek.expose(),
            &self.container_id,
        );
        let payload_nonce = random_array::<12>()?;
        let aad = payload_aad(&self.container_id, logical_bytes, volume_bytes);
        let payload = Aes256Gcm::new_from_slice(&payload_key)
            .map_err(|_| "KAI_CONTAINER_KEY_INVALID".to_string())?
            .encrypt(
                &Nonce::from(payload_nonce),
                Payload {
                    msg: &snapshot,
                    aad: &aad,
                },
            )
            .map_err(|_| "KAI_CONTAINER_ENCRYPTION_FAILED".to_string())?;
        wipe(&mut snapshot);
        let envelope = self
            .envelope
            .lock()
            .map_err(|_| "KAI_KEY_ENVELOPE_UNAVAILABLE".to_string())?
            .clone();
        let checkpointed_at =
            next_checkpoint_generation(self.checkpoint_generation.load(Ordering::Relaxed));
        let header = ContainerHeader {
            version: FORMAT_VERSION,
            container_id: self.container_id,
            envelope,
            payload_nonce,
            payload_bytes: payload.len() as u64,
            logical_bytes,
            volume_bytes,
            checkpointed_at,
        };
        let encoded_header =
            serde_json::to_vec(&header).map_err(|_| "KAI_CONTAINER_HEADER_INVALID".to_string())?;
        if encoded_header.len() > MAX_HEADER_BYTES {
            return Err("KAI_CONTAINER_HEADER_TOO_LARGE".to_string().into());
        }
        let encoded_header_bytes = (encoded_header.len() as u32).to_le_bytes();
        atomic_write_disk_parts(
            &self.container_path,
            &[
                CONTAINER_MAGIC,
                &encoded_header_bytes,
                &encoded_header,
                &payload,
            ],
        )?;
        let sidecar_error = self.write_key_sidecar(&header).err();
        if let Some(hook) = durability_hook {
            if let Err(message) = hook.checkpoint_while_locked() {
                return Err(CheckpointFailure {
                    container_committed: true,
                    durability_committed: false,
                    message,
                });
            }
        }
        if let Some(message) = sidecar_error {
            return Err(CheckpointFailure {
                container_committed: true,
                durability_committed: true,
                message,
            });
        }
        self.volume_bytes.store(volume_bytes, Ordering::Relaxed);
        self.checkpoint_generation
            .store(checkpointed_at, Ordering::Relaxed);
        if self.revision.load(Ordering::Acquire) == snapshot_revision {
            self.dirty.store(false, Ordering::Release);
        }
        *last = Instant::now();
        Ok(true)
    }

    pub fn discard(&self) {
        self.discarded.store(true, Ordering::Release);
        self.dirty.store(false, Ordering::Release);
    }

    pub fn change_password(
        &self,
        current_password: Option<&str>,
        new_password: Option<&str>,
    ) -> Result<(), String> {
        let current = self
            .envelope
            .lock()
            .map_err(|_| "KAI_KEY_ENVELOPE_UNAVAILABLE".to_string())?
            .clone();
        let verified = unwrap_dek(&self.container_id, &current, current_password)?;
        if !constant_time_eq_32(&verified, self.dek.expose()) {
            return Err("PROFILE_PASSWORD_INVALID".to_string());
        }
        let replacement = wrap_dek(&self.container_id, self.dek.expose(), new_password)?;
        *self
            .envelope
            .lock()
            .map_err(|_| "KAI_KEY_ENVELOPE_UNAVAILABLE".to_string())? = replacement;
        self.mark_dirty();
        self.checkpoint(true)?;
        Ok(())
    }

    pub fn verify_password(&self, password: Option<&str>) -> Result<(), String> {
        let envelope = self
            .envelope
            .lock()
            .map_err(|_| "KAI_KEY_ENVELOPE_UNAVAILABLE".to_string())?
            .clone();
        let verified = unwrap_dek(&self.container_id, &envelope, password)?;
        if constant_time_eq_32(&verified, self.dek.expose()) {
            Ok(())
        } else {
            Err("PROFILE_PASSWORD_INVALID".to_string())
        }
    }

    fn relative(&self, path: &Path) -> Result<String, String> {
        let relative = path
            .strip_prefix(&self.namespace_root)
            .map_err(|_| "KAI_VOLUME_PATH_INVALID".to_string())?;
        relative_string(relative)
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.revision.fetch_add(1, Ordering::Relaxed);
    }

    fn write_key_sidecar(&self, header: &ContainerHeader) -> Result<(), String> {
        let checkpointed_at = header.checkpointed_at;
        let profile_path = self.namespace_root.join("profile.tox");
        let (critical_nonce, critical_bytes, critical_ciphertext) =
            if self.is_file(&profile_path)? {
                let mut savedata = self.read(&profile_path)?;
                let nonce = random_array::<12>()?;
                let size = savedata.len() as u64;
                let key = derive_key(
                    b"kaigen-kai-critical-savedata-v1",
                    self.dek.expose(),
                    &self.container_id,
                );
                let aad = critical_aad(&self.container_id, size, checkpointed_at);
                let encrypted = Aes256Gcm::new_from_slice(&key)
                    .map_err(|_| "KAI_KEY_SIDECAR_INVALID".to_string())?
                    .encrypt(
                        &Nonce::from(nonce),
                        Payload {
                            msg: &savedata,
                            aad: &aad,
                        },
                    )
                    .map_err(|_| "KAI_KEY_SIDECAR_ENCRYPTION_FAILED".to_string())?;
                wipe(&mut savedata);
                (nonce, size, encrypted)
            } else {
                ([0; 12], 0, Vec::new())
            };
        let sidecar = KeySidecar {
            format: "kaigen-profile-key-envelope".to_string(),
            version: header.version,
            container_id: header.container_id,
            envelope: header.envelope.clone(),
            critical_nonce,
            critical_bytes,
            critical_ciphertext,
            checkpointed_at,
        };
        let encoded = serde_json::to_vec_pretty(&sidecar)
            .map_err(|_| "KAI_KEY_ENVELOPE_INVALID".to_string())?;
        atomic_write_disk(&self.key_path, &encoded)
    }
}

impl Drop for KaiProfileVolume {
    fn drop(&mut self) {
        if !self.discarded.load(Ordering::Acquire) {
            let _ = self.checkpoint(true);
        }
        if let Ok(mut files) = self.files.lock() {
            for file in files.values_mut() {
                wipe(&mut file.ciphertext);
                wipe(&mut file.nonce);
            }
            files.clear();
        }
    }
}

#[derive(Clone, Debug)]
pub struct MemoryEntry {
    pub path: PathBuf,
    pub is_file: bool,
    pub is_dir: bool,
    pub len: u64,
}

pub fn managed_volume(path: &Path) -> Option<Arc<KaiProfileVolume>> {
    let mut registry = volumes().lock().ok()?;
    let mut matched = None;
    registry.retain(|weak| {
        let Some(volume) = weak.upgrade() else {
            return false;
        };
        if matched.is_none() && volume.contains(path) {
            matched = Some(volume);
        }
        true
    });
    matched
}

/// Commits the mounted container containing `path`, if any, and reports
/// whether a dirty checkpoint was written. Registry and checkpoint failures
/// remain errors so callers cannot acknowledge an uncommitted transaction.
pub fn checkpoint_managed_volume(path: &Path) -> Result<bool, String> {
    let volume = {
        let mut registry = volumes()
            .lock()
            .map_err(|_| "KAI_VOLUME_REGISTRY_UNAVAILABLE".to_string())?;
        let mut matched = None;
        registry.retain(|weak| {
            let Some(volume) = weak.upgrade() else {
                return false;
            };
            if matched.is_none() && volume.contains(path) {
                matched = Some(volume);
            }
            true
        });
        matched
    };
    match volume {
        Some(volume) => volume.checkpoint(true),
        None => Ok(false),
    }
}

fn register(volume: &Arc<KaiProfileVolume>) -> Result<(), String> {
    let mut registry = volumes()
        .lock()
        .map_err(|_| "KAI_VOLUME_REGISTRY_UNAVAILABLE".to_string())?;
    registry.retain(|weak| weak.strong_count() > 0);
    if registry
        .iter()
        .filter_map(Weak::upgrade)
        .any(|current| current.namespace_root == volume.namespace_root)
    {
        return Err("KAI_VOLUME_ALREADY_OPEN".to_string());
    }
    registry.push(Arc::downgrade(volume));
    Ok(())
}

fn wrap_dek(
    container_id: &[u8; 32],
    dek: &[u8; 32],
    password: Option<&str>,
) -> Result<KeyEnvelope, String> {
    let password = password.filter(|value| !value.is_empty());
    let kdf_salt = random_array::<32>()?;
    if let Some(password) = password {
        let mut password_key = crate::profiles::derive_password_key(password, &kdf_salt)?;
        let wrapping_key = derive_key(
            b"kaigen-kai-password-wrapper-v1",
            &password_key,
            container_id,
        );
        wipe(&mut password_key);
        let nonce = random_array::<12>()?;
        let mut plaintext = Vec::with_capacity(64);
        plaintext.extend_from_slice(dek);
        plaintext.extend_from_slice(container_id);
        let ciphertext = Aes256Gcm::new_from_slice(&wrapping_key)
            .map_err(|_| "KAI_KEY_WRAP_FAILED".to_string())?
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &plaintext,
                    aad: CONTAINER_MAGIC,
                },
            )
            .map_err(|_| "KAI_KEY_WRAP_FAILED".to_string())?;
        wipe(&mut plaintext);
        Ok(KeyEnvelope {
            password_protected: true,
            kdf_salt,
            nonce,
            wrapped_dek: ciphertext,
        })
    } else {
        Ok(KeyEnvelope {
            password_protected: false,
            kdf_salt,
            nonce: [0; 12],
            wrapped_dek: dek.to_vec(),
        })
    }
}

fn unwrap_dek(
    container_id: &[u8; 32],
    envelope: &KeyEnvelope,
    password: Option<&str>,
) -> Result<[u8; 32], String> {
    if !envelope.password_protected {
        return envelope
            .wrapped_dek
            .as_slice()
            .try_into()
            .map_err(|_| "KAI_KEY_ENVELOPE_INVALID".to_string());
    }
    let password = password
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?;
    let mut password_key = crate::profiles::derive_password_key(password, &envelope.kdf_salt)
        .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?;
    let wrapping_key = derive_key(
        b"kaigen-kai-password-wrapper-v1",
        &password_key,
        container_id,
    );
    wipe(&mut password_key);
    let mut plaintext = Aes256Gcm::new_from_slice(&wrapping_key)
        .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?
        .decrypt(
            &Nonce::from(envelope.nonce),
            Payload {
                msg: &envelope.wrapped_dek,
                aad: CONTAINER_MAGIC,
            },
        )
        .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?;
    if plaintext.len() != 64 || plaintext[32..] != container_id[..] {
        wipe(&mut plaintext);
        return Err("PROFILE_PASSWORD_INVALID".to_string());
    }
    let mut dek = [0_u8; 32];
    dek.copy_from_slice(&plaintext[..32]);
    wipe(&mut plaintext);
    Ok(dek)
}

fn parse_container(bytes: &[u8]) -> Result<(ContainerHeader, &[u8]), String> {
    if bytes.len() < CONTAINER_MAGIC.len() + 4 || &bytes[..8] != CONTAINER_MAGIC {
        return Err("KAI_CONTAINER_FORMAT_INVALID".to_string());
    }
    let header_length = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if header_length == 0 || header_length > MAX_HEADER_BYTES || 12 + header_length > bytes.len() {
        return Err("KAI_CONTAINER_HEADER_INVALID".to_string());
    }
    let header: ContainerHeader = serde_json::from_slice(&bytes[12..12 + header_length])
        .map_err(|_| "KAI_CONTAINER_HEADER_INVALID".to_string())?;
    if header.version != FORMAT_VERSION
        || header.payload_bytes > MAX_CONTAINER_BYTES
        || header.payload_bytes as usize != bytes.len() - 12 - header_length
    {
        return Err("KAI_CONTAINER_VERSION_UNSUPPORTED".to_string());
    }
    Ok((header, &bytes[12 + header_length..]))
}

fn read_key_sidecar(path: &Path, container_id: &[u8; 32]) -> Result<Option<KeySidecar>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("KAI_KEY_SIDECAR_UNAVAILABLE".to_string()),
    };
    let sidecar: KeySidecar =
        serde_json::from_slice(&bytes).map_err(|_| "KAI_KEY_SIDECAR_INVALID".to_string())?;
    if sidecar.format != "kaigen-profile-key-envelope"
        || sidecar.version != FORMAT_VERSION
        || sidecar.container_id != *container_id
        || sidecar.critical_bytes > MAX_CONTAINER_BYTES
        || (sidecar.critical_bytes == 0) != sidecar.critical_ciphertext.is_empty()
    {
        return Err("KAI_KEY_SIDECAR_INVALID".to_string());
    }
    Ok(Some(sidecar))
}

fn encrypt_memory_file(
    dek: &[u8; 32],
    container_id: &[u8; 32],
    path: &str,
    plaintext: &[u8],
) -> Result<EncryptedFile, String> {
    let nonce = random_array::<12>()?;
    let key = derive_key(b"kaigen-kai-volume-file-v1", dek, container_id);
    let aad = file_aad(container_id, path, plaintext.len() as u64);
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "KAI_VOLUME_KEY_INVALID".to_string())?
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "KAI_VOLUME_ENCRYPTION_FAILED".to_string())?;
    Ok(EncryptedFile {
        nonce,
        logical_bytes: plaintext.len() as u64,
        ciphertext,
    })
}

fn encode_snapshot(
    directories: &BTreeSet<String>,
    files: &BTreeMap<String, EncryptedFile>,
) -> Result<Vec<u8>, String> {
    let encoded_bytes =
        directories
            .iter()
            .try_fold(SNAPSHOT_MAGIC.len() + 4, |total, directory| {
                total
                    .checked_add(4)
                    .and_then(|value| value.checked_add(directory.len()))
                    .ok_or_else(|| "KAI_SNAPSHOT_SIZE_INVALID".to_string())
            })?;
    let encoded_bytes = files.iter().try_fold(
        encoded_bytes
            .checked_add(4)
            .ok_or_else(|| "KAI_SNAPSHOT_SIZE_INVALID".to_string())?,
        |total, (path, file)| {
            total
                .checked_add(4)
                .and_then(|value| value.checked_add(path.len()))
                .and_then(|value| value.checked_add(8 + 12 + 8))
                .and_then(|value| value.checked_add(file.ciphertext.len()))
                .ok_or_else(|| "KAI_SNAPSHOT_SIZE_INVALID".to_string())
        },
    )?;
    if encoded_bytes as u64 > MAX_CONTAINER_BYTES {
        return Err("KAI_SNAPSHOT_SIZE_INVALID".to_string());
    }
    let mut bytes = Vec::with_capacity(encoded_bytes);
    bytes.extend_from_slice(SNAPSHOT_MAGIC);
    bytes.extend_from_slice(&(directories.len() as u32).to_le_bytes());
    for directory in directories {
        write_path(&mut bytes, directory)?;
    }
    bytes.extend_from_slice(&(files.len() as u32).to_le_bytes());
    for (path, file) in files {
        write_path(&mut bytes, path)?;
        bytes.extend_from_slice(&file.logical_bytes.to_le_bytes());
        bytes.extend_from_slice(&file.nonce);
        bytes.extend_from_slice(&(file.ciphertext.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&file.ciphertext);
    }
    Ok(bytes)
}

fn parse_snapshot(
    bytes: &[u8],
) -> Result<(BTreeSet<String>, BTreeMap<String, EncryptedFile>, u64), String> {
    if bytes.len() < 12 || &bytes[..8] != SNAPSHOT_MAGIC {
        return Err("KAI_SNAPSHOT_FORMAT_INVALID".to_string());
    }
    let mut cursor = 8_usize;
    let directory_count = read_u32(bytes, &mut cursor)? as usize;
    if directory_count > 1_000_000 {
        return Err("KAI_SNAPSHOT_DIRECTORY_LIMIT".to_string());
    }
    let mut directories = BTreeSet::new();
    for _ in 0..directory_count {
        directories.insert(read_path(bytes, &mut cursor)?);
    }
    directories.insert(String::new());
    let file_count = read_u32(bytes, &mut cursor)? as usize;
    if file_count > 1_000_000 {
        return Err("KAI_SNAPSHOT_FILE_LIMIT".to_string());
    }
    let mut files = BTreeMap::new();
    let mut logical_bytes = 0_u64;
    for _ in 0..file_count {
        let path = read_path(bytes, &mut cursor)?;
        let size = read_u64(bytes, &mut cursor)?;
        if size > MAX_CONTAINER_BYTES || cursor + 12 > bytes.len() {
            return Err("KAI_SNAPSHOT_FILE_INVALID".to_string());
        }
        let nonce = bytes[cursor..cursor + 12].try_into().unwrap();
        cursor += 12;
        let ciphertext_bytes = read_u64(bytes, &mut cursor)?;
        if ciphertext_bytes > MAX_CONTAINER_BYTES
            || cursor.saturating_add(ciphertext_bytes as usize) > bytes.len()
        {
            return Err("KAI_SNAPSHOT_FILE_INVALID".to_string());
        }
        let ciphertext = bytes[cursor..cursor + ciphertext_bytes as usize].to_vec();
        cursor += ciphertext_bytes as usize;
        logical_bytes = logical_bytes
            .checked_add(size)
            .ok_or_else(|| "KAI_SNAPSHOT_SIZE_INVALID".to_string())?;
        if files
            .insert(
                path,
                EncryptedFile {
                    nonce,
                    logical_bytes: size,
                    ciphertext,
                },
            )
            .is_some()
        {
            return Err("KAI_SNAPSHOT_DUPLICATE_PATH".to_string());
        }
    }
    if cursor != bytes.len() {
        return Err("KAI_SNAPSHOT_TRAILING_DATA".to_string());
    }
    Ok((directories, files, logical_bytes))
}

fn write_path(output: &mut Vec<u8>, value: &str) -> Result<(), String> {
    validate_relative(value)?;
    if value.len() > MAX_PATH_BYTES {
        return Err("KAI_VOLUME_PATH_TOO_LONG".to_string());
    }
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn read_path(bytes: &[u8], cursor: &mut usize) -> Result<String, String> {
    let length = read_u32(bytes, cursor)? as usize;
    if length > MAX_PATH_BYTES || cursor.saturating_add(length) > bytes.len() {
        return Err("KAI_SNAPSHOT_PATH_INVALID".to_string());
    }
    let value = std::str::from_utf8(&bytes[*cursor..*cursor + length])
        .map_err(|_| "KAI_SNAPSHOT_PATH_INVALID".to_string())?
        .to_string();
    *cursor += length;
    validate_relative(&value)?;
    Ok(value)
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, String> {
    if cursor.saturating_add(4) > bytes.len() {
        return Err("KAI_SNAPSHOT_TRUNCATED".to_string());
    }
    let value = u32::from_le_bytes(bytes[*cursor..*cursor + 4].try_into().unwrap());
    *cursor += 4;
    Ok(value)
}

fn read_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64, String> {
    if cursor.saturating_add(8) > bytes.len() {
        return Err("KAI_SNAPSHOT_TRUNCATED".to_string());
    }
    let value = u64::from_le_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
    *cursor += 8;
    Ok(value)
}

fn validate_relative(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
        || value.contains('\\')
        || value.as_bytes().contains(&0)
    {
        return Err("KAI_VOLUME_PATH_INVALID".to_string());
    }
    Ok(())
}

fn relative_string(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| "KAI_VOLUME_PATH_INVALID".to_string())?,
            ),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("KAI_VOLUME_PATH_INVALID".to_string())
            }
        }
    }
    let value = parts.join("/");
    validate_relative(&value)?;
    Ok(value)
}

fn direct_child<'a>(prefix: &str, path: &'a str) -> Option<&'a str> {
    if prefix.is_empty() {
        (!path.is_empty()).then_some(path)
    } else {
        path.strip_prefix(prefix).filter(|value| !value.is_empty())
    }
}

fn namespace_for(container_path: &Path, container_id: &[u8; 32]) -> Result<PathBuf, String> {
    let parent = container_path
        .parent()
        .ok_or_else(|| "KAI_CONTAINER_PATH_INVALID".to_string())?;
    Ok(parent.join(format!(
        ".kai-ram-{}-{}",
        std::process::id(),
        hex(&container_id[..8])
    )))
}

fn key_path_for(container_path: &Path) -> PathBuf {
    let mut name = container_path
        .file_name()
        .unwrap_or_default()
        .to_os_string();
    name.push(".keys");
    container_path.with_file_name(name)
}

fn payload_aad(container_id: &[u8; 32], logical: u64, capacity: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(CONTAINER_MAGIC.len() + 32 + 16);
    aad.extend_from_slice(CONTAINER_MAGIC);
    aad.extend_from_slice(container_id);
    aad.extend_from_slice(&logical.to_le_bytes());
    aad.extend_from_slice(&capacity.to_le_bytes());
    aad
}

fn file_aad(container_id: &[u8; 32], path: &str, logical: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(64 + path.len());
    aad.extend_from_slice(b"kaigen-kai-volume-file-aad-v1\0");
    aad.extend_from_slice(container_id);
    aad.extend_from_slice(&logical.to_le_bytes());
    aad.extend_from_slice(path.as_bytes());
    aad
}

fn critical_aad(container_id: &[u8; 32], logical: u64, checkpointed_at: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(64);
    aad.extend_from_slice(b"kaigen-kai-critical-savedata-aad-v1\0");
    aad.extend_from_slice(container_id);
    aad.extend_from_slice(&logical.to_le_bytes());
    aad.extend_from_slice(&checkpointed_at.to_le_bytes());
    aad
}

fn derive_key(domain: &[u8], key: &[u8; 32], container_id: &[u8; 32]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update(key);
    digest.update(container_id);
    digest.finalize().into()
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut value = [0_u8; N];
    getrandom::fill(&mut value).map_err(|_| "KAI_RANDOM_SOURCE_FAILED".to_string())?;
    Ok(value)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn next_checkpoint_generation(previous: u64) -> u64 {
    let wall_clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64;
    wall_clock.max(previous.saturating_add(1))
}

fn atomic_write_disk(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_disk_parts(path, &[bytes])
}

fn atomic_write_disk_parts(path: &Path, parts: &[&[u8]]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "KAI_CONTAINER_PATH_INVALID".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create .kai profile directory: {error}"))?;
    let temporary = path.with_extension(format!(
        "{}.writing",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("kai")
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create .kai checkpoint: {error}"))?;
    if let Err(error) = parts
        .iter()
        .try_for_each(|bytes| file.write_all(bytes))
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not flush .kai checkpoint: {error}"));
    }
    drop(file);
    #[cfg(target_os = "windows")]
    if let Err(error) = replace_file_windows(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    #[cfg(not(target_os = "windows"))]
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not commit .kai checkpoint: {error}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_file_windows(source: &Path, destination: &Path) -> Result<(), String> {
    let source = extended_windows_path(source)?;
    let destination_wide = extended_windows_path(destination)?;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let success = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        return Err(format!(
            "Could not atomically commit {}: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn extended_windows_path(path: &Path) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;

    let absolute = std::path::absolute(path).map_err(|error| {
        format!(
            "Could not resolve the .kai checkpoint path {}: {error}",
            path.display()
        )
    })?;
    let wide = absolute.as_os_str().encode_wide().collect::<Vec<_>>();
    let verbatim_prefix = r"\\?\".encode_utf16().collect::<Vec<_>>();
    let unc_prefix = r"\\?\UNC\".encode_utf16().collect::<Vec<_>>();
    let mut extended = Vec::with_capacity(wide.len() + unc_prefix.len() + 1);
    if wide.starts_with(&verbatim_prefix) {
        extended.extend_from_slice(&wide);
    } else if wide.starts_with(&['\\' as u16, '\\' as u16]) {
        extended.extend_from_slice(&unc_prefix);
        extended.extend_from_slice(&wide[2..]);
    } else {
        extended.extend_from_slice(&verbatim_prefix);
        extended.extend_from_slice(&wide);
    }
    extended.push(0);
    Ok(extended)
}

fn wipe(value: &mut [u8]) {
    for byte in value {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

fn constant_time_eq_32(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(target_os = "linux")]
const PROCESS_MEMORY_LOCK_FLAGS: libc::c_int = libc::MCL_CURRENT;

#[cfg(target_os = "linux")]
pub fn lock_process_memory() -> Result<(), String> {
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(format!(
            "KAI_PROCESS_DUMP_PROTECTION_FAILED: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Future allocations include thread stacks. MCL_FUTURE makes pthread
    // creation fail with EAGAIN under the ordinary RLIMIT_MEMLOCK used by
    // desktop sessions and service accounts. Sensitive buffers are locked
    // individually by LockedBuffer, so keep the process-wide lock bounded to
    // mappings that already exist at hardening time.
    if unsafe { libc::mlockall(PROCESS_MEMORY_LOCK_FLAGS) } != 0 {
        return Err(format!(
            "KAI_PROCESS_MEMORY_LOCK_FAILED: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn lock_process_memory() -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn lock_memory(pointer: *mut u8, length: usize) -> Result<bool, String> {
    if unsafe { libc::mlock(pointer.cast(), length) } != 0 {
        return Err(format!(
            "KAI_SECURE_MEMORY_LOCK_FAILED: {}",
            std::io::Error::last_os_error()
        ));
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let _ = libc::madvise(pointer.cast(), length, libc::MADV_DONTDUMP);
    }
    Ok(true)
}

#[cfg(unix)]
fn unlock_memory(pointer: *mut u8, length: usize) {
    #[cfg(target_os = "linux")]
    unsafe {
        let _ = libc::madvise(pointer.cast(), length, libc::MADV_DODUMP);
    }
    unsafe {
        let _ = libc::munlock(pointer.cast(), length);
    }
}

#[cfg(target_os = "windows")]
fn lock_memory(pointer: *mut u8, length: usize) -> Result<bool, String> {
    if unsafe { VirtualLock(pointer.cast(), length) } == 0 {
        return Err(format!(
            "KAI_SECURE_MEMORY_LOCK_FAILED: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(true)
}

#[cfg(target_os = "windows")]
fn unlock_memory(pointer: *mut u8, length: usize) {
    unsafe {
        let _ = VirtualUnlock(pointer.cast(), length);
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn lock_memory(_pointer: *mut u8, _length: usize) -> Result<bool, String> {
    Err("KAI_SECURE_MEMORY_UNSUPPORTED".to_string())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn unlock_memory(_pointer: *mut u8, _length: usize) {}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn VirtualLock(address: *mut std::ffi::c_void, size: usize) -> i32;
    fn VirtualUnlock(address: *mut std::ffi::c_void, size: usize) -> i32;
    fn MoveFileExW(existing: *const u16, destination: *const u16, flags: u32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kaigen-kai-{label}-{}-{}",
            std::process::id(),
            now_seconds()
        ))
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_memory_lock_does_not_cover_future_thread_stacks() {
        assert_eq!(PROCESS_MEMORY_LOCK_FLAGS & libc::MCL_FUTURE, 0);
        assert_ne!(PROCESS_MEMORY_LOCK_FLAGS & libc::MCL_CURRENT, 0);
    }

    #[test]
    fn password_protected_container_round_trip_and_capacity() {
        let root = test_root("round-trip");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), Some("correct password")).unwrap();
        let profile = volume.namespace_root().join("profile.tox");
        let history = volume.namespace_root().join("data/chat-history.json");
        volume.write(&profile, b"tox savedata").unwrap();
        volume
            .write(&history, b"[{\"message\":\"private\"}]")
            .unwrap();
        assert_eq!(volume.volume_bytes(), MIN_VOLUME_BYTES);
        volume.checkpoint(true).unwrap();
        assert!(container.is_file());
        assert!(volume.key_path().is_file());
        for bytes in [
            fs::read(&container).unwrap(),
            fs::read(volume.key_path()).unwrap(),
        ] {
            assert!(!bytes
                .windows(b"tox savedata".len())
                .any(|window| window == b"tox savedata"));
            assert!(!bytes
                .windows(b"private".len())
                .any(|window| window == b"private"));
        }
        drop(volume);

        assert_eq!(
            KaiProfileVolume::open(container.clone(), Some("wrong password")).unwrap_err(),
            "PROFILE_PASSWORD_INVALID"
        );
        let reopened = KaiProfileVolume::open(container, Some("correct password")).unwrap();
        assert_eq!(
            reopened
                .read(&reopened.namespace_root().join("profile.tox"))
                .unwrap(),
            b"tox savedata"
        );
        assert_eq!(
            reopened
                .read(&reopened.namespace_root().join("data/chat-history.json"))
                .unwrap(),
            b"[{\"message\":\"private\"}]"
        );
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_overwrite_updates_accounting_and_reopens() {
        let root = test_root("rename-overwrite");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
        let source = volume.namespace_root().join("data/avatar.pending");
        let destination = volume.namespace_root().join("data/avatar.png");
        let replacement = b"new avatar";
        let previous = b"old avatar bytes that must leave the quota";

        volume.write(&source, replacement).unwrap();
        volume.write(&destination, previous).unwrap();
        assert_eq!(
            volume.logical_bytes(),
            (replacement.len() + previous.len()) as u64
        );

        volume.rename(&source, &destination).unwrap();
        assert_eq!(volume.logical_bytes(), replacement.len() as u64);
        assert_eq!(volume.read(&destination).unwrap(), replacement);
        assert!(!volume.is_file(&source).unwrap());
        volume.checkpoint(true).unwrap();
        drop(volume);

        let reopened = KaiProfileVolume::open(container, None).unwrap();
        assert_eq!(reopened.logical_bytes(), replacement.len() as u64);
        assert_eq!(
            reopened
                .read(&reopened.namespace_root().join("data/avatar.png"))
                .unwrap(),
            replacement
        );
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authenticated_historical_rename_overcount_is_repaired_on_open() {
        let root = test_root("repair-rename-overcount");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
        let source = volume.namespace_root().join("data/avatar.pending");
        let destination = volume.namespace_root().join("data/avatar.png");
        let replacement = b"replacement";
        let overwritten = b"historically overcounted destination";

        volume.write(&source, replacement).unwrap();
        volume.write(&destination, overwritten).unwrap();
        volume.rename(&source, &destination).unwrap();

        // Reproduce the authenticated metadata written by the historical bug:
        // the map contains only the replacement, while logical_bytes still
        // includes the overwritten destination.
        volume
            .logical_bytes
            .fetch_add(overwritten.len() as u64, Ordering::Relaxed);
        volume.mark_dirty();
        volume.checkpoint(true).unwrap();
        let (historical_header, _) = parse_container(&fs::read(&container).unwrap()).unwrap();
        assert_eq!(
            historical_header.logical_bytes,
            (replacement.len() + overwritten.len()) as u64
        );
        drop(volume);

        let repaired = KaiProfileVolume::open(container.clone(), None).unwrap();
        assert_eq!(repaired.logical_bytes(), replacement.len() as u64);
        assert_eq!(
            repaired
                .read(&repaired.namespace_root().join("data/avatar.png"))
                .unwrap(),
            replacement
        );
        drop(repaired);

        let (normalized_header, _) = parse_container(&fs::read(&container).unwrap()).unwrap();
        assert_eq!(normalized_header.logical_bytes, replacement.len() as u64);
        let reopened = KaiProfileVolume::open(container, None).unwrap();
        assert_eq!(reopened.logical_bytes(), replacement.len() as u64);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authenticated_logical_undercount_remains_rejected() {
        let root = test_root("reject-logical-undercount");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
        let path = volume.namespace_root().join("data/history.json");
        let contents = b"authenticated payload";
        volume.write(&path, contents).unwrap();
        volume
            .logical_bytes
            .store(contents.len() as u64 - 1, Ordering::Relaxed);
        volume.mark_dirty();
        volume.checkpoint(true).unwrap();
        drop(volume);

        assert_eq!(
            KaiProfileVolume::open(container, None).unwrap_err(),
            "KAI_CONTAINER_CAPACITY_INVALID"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn passwordless_container_is_encrypted_but_key_is_unwrapped() {
        let root = test_root("passwordless");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
        volume
            .write(
                &volume.namespace_root().join("profile.tox"),
                b"plain tox secret",
            )
            .unwrap();
        volume.checkpoint(true).unwrap();
        let bytes = fs::read(&container).unwrap();
        assert!(!bytes
            .windows(b"plain tox secret".len())
            .any(|item| item == b"plain tox secret"));
        let sidecar = fs::read(volume.key_path()).unwrap();
        assert!(!sidecar
            .windows(b"plain tox secret".len())
            .any(|item| item == b"plain tox secret"));
        drop(volume);
        let reopened = KaiProfileVolume::open(container, None).unwrap();
        assert!(!reopened.password_protected());
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_directory_does_not_create_checkpoint_churn() {
        let root = test_root("directory-churn");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container, Some("password")).unwrap();
        let directory = volume.namespace_root().join("data/avatars");
        volume.create_dir_all(&directory).unwrap();
        let revision = volume.revision.load(Ordering::Acquire);
        volume.create_dir_all(&directory).unwrap();
        assert_eq!(volume.revision.load(Ordering::Acquire), revision);
        drop(volume);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tampered_container_is_rejected() {
        let root = test_root("tamper");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), Some("password")).unwrap();
        volume
            .write(&volume.namespace_root().join("profile.tox"), b"savedata")
            .unwrap();
        volume.checkpoint(true).unwrap();
        drop(volume);
        let mut bytes = fs::read(&container).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x80;
        fs::write(&container, bytes).unwrap();
        assert_eq!(
            KaiProfileVolume::open(container, Some("password")).unwrap_err(),
            "KAI_CONTAINER_AUTHENTICATION_FAILED"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn newest_checkpoint_half_recovers_without_rolling_back_savedata() {
        let root = test_root("checkpoint-halves");
        let container = root.join("profiles/test/test.kai");
        let key_path = key_path_for(&container);
        let volume = KaiProfileVolume::create(container.clone(), Some("password")).unwrap();
        let savedata = volume.namespace_root().join("profile.tox");
        let history = volume.namespace_root().join("data/chat-history.json");

        volume.write(&savedata, b"savedata-v1").unwrap();
        volume.write(&history, b"history-v1").unwrap();
        volume.checkpoint(true).unwrap();
        let old_container = fs::read(&container).unwrap();
        let old_sidecar = fs::read(&key_path).unwrap();

        volume.write(&savedata, b"savedata-v2").unwrap();
        volume.write(&history, b"history-v2").unwrap();
        volume.checkpoint(true).unwrap();
        let new_container = fs::read(&container).unwrap();
        let new_sidecar = fs::read(&key_path).unwrap();
        let (old_header, _) = parse_container(&old_container).unwrap();
        let (new_header, _) = parse_container(&new_container).unwrap();
        assert!(new_header.checkpointed_at > old_header.checkpointed_at);
        assert!(!new_sidecar
            .windows(b"savedata-v2".len())
            .any(|window| window == b"savedata-v2"));
        drop(volume);

        // User-data quota may preserve the previous .kai while security reserve
        // commits the latest encrypted tox savedata in .kai.keys.
        fs::write(&container, &old_container).unwrap();
        fs::write(&key_path, &new_sidecar).unwrap();
        let recovered = KaiProfileVolume::open(container.clone(), Some("password")).unwrap();
        assert_eq!(
            recovered
                .read(&recovered.namespace_root().join("profile.tox"))
                .unwrap(),
            b"savedata-v2"
        );
        assert_eq!(
            recovered
                .read(&recovered.namespace_root().join("data/chat-history.json"))
                .unwrap(),
            b"history-v1"
        );
        drop(recovered);

        // A crash between the two atomic writes must not let an older sidecar
        // overwrite a newer complete container.
        fs::write(&container, &new_container).unwrap();
        fs::write(&key_path, &old_sidecar).unwrap();
        let recovered = KaiProfileVolume::open(container, Some("password")).unwrap();
        assert_eq!(
            recovered
                .read(&recovered.namespace_root().join("profile.tox"))
                .unwrap(),
            b"savedata-v2"
        );
        assert_eq!(
            recovered
                .read(&recovered.namespace_root().join("data/chat-history.json"))
                .unwrap(),
            b"history-v2"
        );
        drop(recovered);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn outer_checkpoint_failure_rolls_back_the_inner_container_before_returning() {
        let root = test_root("outer-rollback");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
        let journal = volume.namespace_root().join("data/pq-journal.json");
        volume
            .write_checkpointed(&journal, b"accepted-generation")
            .unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let callback_calls = Arc::clone(&calls);
        volume
            .set_durability_hook(KaiDurabilityHook::new(move || {
                if callback_calls.fetch_add(1, Ordering::AcqRel) == 0 {
                    Err("SYNTHETIC_OUTER_WRITE_FAILED".to_string())
                } else {
                    Ok(())
                }
            }))
            .unwrap();

        assert_eq!(
            volume
                .write_checkpointed(&journal, b"rejected-generation")
                .unwrap_err(),
            "SYNTHETIC_OUTER_WRITE_FAILED"
        );
        assert_eq!(calls.load(Ordering::Acquire), 2);
        assert_eq!(volume.read(&journal).unwrap(), b"accepted-generation");
        drop(volume);

        let reopened = KaiProfileVolume::open(container, None).unwrap();
        assert_eq!(
            reopened
                .read(&reopened.namespace_root().join("data/pq-journal.json"))
                .unwrap(),
            b"accepted-generation"
        );
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_outer_rollback_poison_closes_later_publication_attempts() {
        let root = test_root("outer-rollback-poison");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
        let journal = volume.namespace_root().join("data/pq-journal.json");
        volume
            .write_checkpointed(&journal, b"accepted-generation")
            .unwrap();
        volume
            .set_durability_hook(KaiDurabilityHook::new(|| {
                Err("SYNTHETIC_OUTER_WRITE_FAILED".to_string())
            }))
            .unwrap();

        assert_eq!(
            volume
                .write_checkpointed(&journal, b"rejected-generation")
                .unwrap_err(),
            "WEB_DURABILITY_ROLLBACK_FAILED"
        );
        assert_eq!(volume.read(&journal).unwrap(), b"accepted-generation");
        assert_eq!(
            volume.checkpoint(true).unwrap_err(),
            "WEB_DURABILITY_POISONED"
        );
        drop(volume);

        let reopened = KaiProfileVolume::open(container, None).unwrap();
        assert_eq!(
            reopened
                .read(&reopened.namespace_root().join("data/pq-journal.json"))
                .unwrap(),
            b"accepted-generation"
        );
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_profile_does_not_invoke_the_outer_seal() {
        let root = test_root("outer-idle");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container, None).unwrap();
        volume.checkpoint(true).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let callback_calls = Arc::clone(&calls);
        volume
            .set_durability_hook(KaiDurabilityHook::new(move || {
                callback_calls.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }))
            .unwrap();

        assert!(!volume.checkpoint(true).unwrap());
        assert_eq!(calls.load(Ordering::Acquire), 0);
        let journal = volume.namespace_root().join("data/pq-journal.json");
        volume
            .write_checkpointed(&journal, b"new-generation")
            .unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 1);
        assert!(!volume.checkpoint(true).unwrap());
        assert_eq!(calls.load(Ordering::Acquire), 1);

        drop(volume);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn competing_outer_checkpoint_cannot_observe_a_failed_inner_generation() {
        let root = test_root("outer-rollback-race");
        let container = root.join("profiles/test/test.kai");
        let volume = KaiProfileVolume::create(container, None).unwrap();
        let journal = volume.namespace_root().join("data/pq-journal.json");
        volume
            .write_checkpointed(&journal, b"accepted-generation")
            .unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let callback_calls = Arc::clone(&calls);
        let hook = KaiDurabilityHook::new(move || {
            if callback_calls.fetch_add(1, Ordering::AcqRel) == 0 {
                Err("SYNTHETIC_OUTER_WRITE_FAILED".to_string())
            } else {
                Ok(())
            }
        });
        volume.set_durability_hook(hook.clone()).unwrap();

        let (rollback_reached_tx, rollback_reached_rx) = std::sync::mpsc::channel();
        let (resume_rollback_tx, resume_rollback_rx) = std::sync::mpsc::channel();
        let writer_volume = Arc::clone(&volume);
        let writer = std::thread::spawn(move || {
            writer_volume.write_checkpointed_inner(&journal, b"rejected-generation", move || {
                rollback_reached_tx.send(()).unwrap();
                resume_rollback_rx.recv().unwrap();
            })
        });
        rollback_reached_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();

        let (competitor_done_tx, competitor_done_rx) = std::sync::mpsc::channel();
        let competitor = std::thread::spawn(move || {
            competitor_done_tx.send(hook.checkpoint()).unwrap();
        });
        assert!(matches!(
            competitor_done_rx.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(calls.load(Ordering::Acquire), 1);

        resume_rollback_tx.send(()).unwrap();
        assert_eq!(
            writer.join().unwrap().unwrap_err(),
            "SYNTHETIC_OUTER_WRITE_FAILED"
        );
        competitor_done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        competitor.join().unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 3);
        assert_eq!(
            volume
                .read(&volume.namespace_root().join("data/pq-journal.json"))
                .unwrap(),
            b"accepted-generation"
        );

        drop(volume);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn atomic_checkpoint_supports_extended_length_windows_paths() {
        use std::os::windows::ffi::OsStrExt;

        let root = test_root("long-path");
        let mut directory = root.clone();
        while directory.as_os_str().encode_wide().count() < 280 {
            directory = directory.join("0123456789abcdef0123456789abcdef");
        }
        let checkpoint = directory.join("profile.kai");
        assert!(checkpoint.as_os_str().encode_wide().count() > 260);
        atomic_write_disk(&checkpoint, b"long-path-checkpoint").unwrap();
        assert_eq!(fs::read(&checkpoint).unwrap(), b"long-path-checkpoint");
        fs::remove_dir_all(root).unwrap();
    }
}
