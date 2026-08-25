use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::fs::File;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri_app_lib::web_core::{
    source_fingerprint, AuthBackoff, EncryptedBlob, ResourceAdmission, ResourceSnapshot,
    StorageMode, WebWorkspaceRuntime, WorkspaceDomain, WorkspaceVault,
};

use crate::{
    config::{Config, DeploymentMode},
    proof::ProofRegistry,
};

const DOMAIN_FILE: &str = "domain.json";
const PAYLOAD_DIRECTORY: &str = "payload";
const PAYLOAD_PREVIOUS_DIRECTORY: &str = "payload.previous";
const PAYLOAD_STAGING_DIRECTORY: &str = "payload.staging";
const CRITICAL_PAYLOAD_DIRECTORY: &str = "payload-critical";
const CRITICAL_PAYLOAD_PREVIOUS_DIRECTORY: &str = "payload-critical.previous";
const CRITICAL_PAYLOAD_STAGING_DIRECTORY: &str = "payload-critical.staging";
const PAYLOAD_INDEX_FILE: &str = "index.enc";
const PAYLOAD_CHUNK_BYTES: usize = 1024 * 1024;
const PAYLOAD_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(5 * 60);
const CSRF_ROTATION_GRACE_SECONDS: u64 = 30;
pub const PROFILE_IMPORT_TTL_SECONDS: u64 = 10 * 60;

pub struct AppState {
    pub config: Config,
    pub inner: Mutex<InnerState>,
}

pub struct InnerState {
    pub workspaces: HashMap<[u8; 32], StoredWorkspace>,
    pub pending_workspace_imports: HashMap<String, PendingWorkspaceImport>,
    pub restoring_workspaces: HashSet<[u8; 32]>,
    pub proofs: ProofRegistry,
    pub auth_backoff: AuthBackoff,
    pub admission: ResourceAdmission,
    pub sessions: HashMap<[u8; 32], Session>,
    pub server_secret: [u8; 32],
    pub dummy_vault: WorkspaceVault,
    pub maintenance: bool,
}

pub struct StoredWorkspace {
    pub root: PathBuf,
    pub active_root: PathBuf,
    pub domain: WorkspaceDomain,
    pub runtime: Option<WebWorkspaceRuntime>,
    pub pending_profile_import: Option<PendingProfileImport>,
    pub last_payload_checkpoint: Instant,
}

pub struct PendingProfileImport {
    pub id: String,
    pub kind: String,
    pub path: PathBuf,
    pub expected_bytes: u64,
    pub received_bytes: u64,
    pub created_at: u64,
    pub finalizing: bool,
}

pub struct PendingWorkspaceImport {
    pub id: String,
    pub source_hash: [u8; 32],
    pub storage_mode: StorageMode,
    pub path: PathBuf,
    pub expected_bytes: u64,
    pub received_bytes: u64,
    pub created_at: u64,
    pub finalizing: bool,
}

impl PendingWorkspaceImport {
    pub fn remove_file(&self, active_root: &Path) -> Result<(), String> {
        let expected_name = format!(".workspace-import-{}.upload", self.id);
        if self.path.parent() != Some(active_root)
            || self.path.file_name().and_then(|value| value.to_str())
                != Some(expected_name.as_str())
        {
            return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
        }
        if self.path.exists() {
            let metadata = fs::symlink_metadata(&self.path)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
            }
            fs::remove_file(&self.path)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PayloadIndex {
    version: u32,
    entries: Vec<PayloadEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PayloadEntry {
    path: String,
    size: u64,
    chunks: u32,
    sha256: [u8; 32],
    security_critical: bool,
}

impl StoredWorkspace {
    pub fn ensure_runtime(
        &mut self,
        resource_root: &Path,
    ) -> Result<&mut WebWorkspaceRuntime, String> {
        if self.runtime.is_none() {
            self.restore_payload()?;
            self.runtime = Some(WebWorkspaceRuntime::start(
                resource_root.to_path_buf(),
                self.active_root.clone(),
            )?);
        }
        let runtime = self.runtime.as_mut().ok_or("RUNTIME_UNAVAILABLE")?;
        runtime.synchronize_profiles(&self.domain)?;
        Ok(runtime)
    }

    pub fn synchronize_runtime(&mut self) -> Result<(), String> {
        let runtime = self.runtime.as_mut().ok_or("RUNTIME_LOCKED")?;
        runtime.synchronize_profiles(&self.domain)
    }

    pub fn refresh_effective_presence(&self, now: u64) -> Result<(), String> {
        let runtime = self.runtime.as_ref().ok_or("RUNTIME_LOCKED")?;
        runtime.apply_effective_presence(&self.domain, self.domain.ui_lease.has_fresh_holder(now))
    }

    pub fn stop_runtime(&mut self) -> Result<(), String> {
        if let Some(mut runtime) = self.runtime.take() {
            runtime.stop()?;
        }
        Ok(())
    }

    pub fn checkpoint(&mut self, force: bool) -> Result<(), String> {
        if self.runtime.is_none() {
            return Ok(());
        }
        self.runtime
            .as_ref()
            .ok_or("RUNTIME_UNAVAILABLE")?
            .checkpoint_profiles(force)?;
        if !force && self.last_payload_checkpoint.elapsed() < PAYLOAD_CHECKPOINT_INTERVAL {
            return Ok(());
        }
        self.checkpoint_payload()?;
        self.last_payload_checkpoint = Instant::now();
        Ok(())
    }

    pub fn checkpoint_profiles(&self, force: bool) -> Result<(), String> {
        self.runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .checkpoint_profiles(force)
    }

    /// Captures files flushed by toxcore while the native runtime was being
    /// stopped.  The active directory is an isolated tmpfs tree and must be
    /// sealed before an archive is assembled from persistent ciphertext.
    pub fn checkpoint_after_stop(&mut self) -> Result<(), String> {
        if !self.active_root.exists() {
            return Ok(());
        }
        self.checkpoint_payload()?;
        self.last_payload_checkpoint = Instant::now();
        Ok(())
    }

    fn checkpoint_payload(&mut self) -> Result<(), String> {
        let files = collect_payload_files(&self.active_root)?;
        let mut user_bytes = 0_u64;
        let mut security_bytes = 0_u64;
        for (path, size) in &files {
            if security_critical_path(path) {
                security_bytes = security_bytes.saturating_add(*size);
            } else {
                user_bytes = user_bytes.saturating_add(*size);
            }
        }
        if security_bytes > self.domain.quota.reserve_limit_bytes {
            self.domain.quota.reserve_used_bytes = self.domain.quota.reserve_limit_bytes;
            return Err("WORKSPACE_SECURITY_RESERVE_FULL".to_string());
        }
        let critical_files = files
            .iter()
            .filter(|(path, _)| security_critical_path(path))
            .cloned()
            .collect::<Vec<_>>();
        let user_files = files
            .into_iter()
            .filter(|(path, _)| !security_critical_path(path))
            .collect::<Vec<_>>();
        self.checkpoint_payload_group(
            &critical_files,
            CRITICAL_PAYLOAD_DIRECTORY,
            CRITICAL_PAYLOAD_PREVIOUS_DIRECTORY,
            CRITICAL_PAYLOAD_STAGING_DIRECTORY,
            "payload-critical",
        )?;
        self.domain.quota.reserve_used_bytes = security_bytes;
        if user_bytes > self.domain.quota.user_limit_bytes {
            // Keep the last valid optional-data snapshot but always commit the
            // security-critical savedata snapshot above.
            self.domain.quota.user_used_bytes = self.domain.quota.user_limit_bytes;
            return Err("WORKSPACE_QUOTA_FULL".to_string());
        }
        self.checkpoint_payload_group(
            &user_files,
            PAYLOAD_DIRECTORY,
            PAYLOAD_PREVIOUS_DIRECTORY,
            PAYLOAD_STAGING_DIRECTORY,
            "payload",
        )?;
        self.domain.quota.user_used_bytes = user_bytes;
        Ok(())
    }

    fn checkpoint_payload_group(
        &self,
        files: &[(String, u64)],
        current_name: &str,
        previous_name: &str,
        staging_name: &str,
        namespace: &str,
    ) -> Result<(), String> {
        let vault = self
            .domain
            .vault
            .as_ref()
            .ok_or("WORKSPACE_NOT_INITIALIZED")?;
        let staging = self.root.join(staging_name);
        remove_internal_directory(&self.root, &staging)?;
        fs::create_dir_all(&staging)
            .map_err(|error| format!("Could not create payload staging directory: {error}"))?;
        protect_directory(&staging)?;
        let mut entries = Vec::with_capacity(files.len());
        for (relative, size) in files {
            entries.push(seal_payload_file(
                vault,
                &self.active_root,
                &staging,
                namespace,
                &relative,
                *size,
            )?);
        }
        let index = PayloadIndex {
            version: 1,
            entries,
        };
        let index_plain = serde_json::to_vec(&index)
            .map_err(|error| format!("Could not encode payload index: {error}"))?;
        let index_blob = vault.seal(&format!("{namespace}/index"), &index_plain)?;
        write_blob_file(&staging.join(PAYLOAD_INDEX_FILE), &index_blob)?;
        let current = self.root.join(current_name);
        let previous = self.root.join(previous_name);
        remove_internal_directory(&self.root, &previous)?;
        if current.exists() {
            fs::rename(&current, &previous)
                .map_err(|error| format!("Could not rotate encrypted payload: {error}"))?;
        }
        if let Err(error) = fs::rename(&staging, &current) {
            if previous.exists() && !current.exists() {
                let _ = fs::rename(&previous, &current);
            }
            return Err(format!("Could not activate encrypted payload: {error}"));
        }
        remove_internal_directory(&self.root, &previous)?;
        Ok(())
    }

    fn restore_payload(&self) -> Result<(), String> {
        if self.active_root.exists() {
            remove_internal_directory(active_base(&self.active_root)?, &self.active_root)?;
        }
        fs::create_dir_all(&self.active_root)
            .map_err(|error| format!("Could not create active workspace: {error}"))?;
        protect_directory(&self.active_root)?;
        let vault = self
            .domain
            .vault
            .as_ref()
            .ok_or("WORKSPACE_NOT_INITIALIZED")?;
        self.restore_payload_group(
            vault,
            PAYLOAD_DIRECTORY,
            PAYLOAD_PREVIOUS_DIRECTORY,
            PAYLOAD_STAGING_DIRECTORY,
            "payload",
        )?;
        self.restore_payload_group(
            vault,
            CRITICAL_PAYLOAD_DIRECTORY,
            CRITICAL_PAYLOAD_PREVIOUS_DIRECTORY,
            CRITICAL_PAYLOAD_STAGING_DIRECTORY,
            "payload-critical",
        )
    }

    fn restore_payload_group(
        &self,
        vault: &WorkspaceVault,
        current_name: &str,
        previous_name: &str,
        staging_name: &str,
        namespace: &str,
    ) -> Result<(), String> {
        let payload =
            recover_payload_directory(&self.root, current_name, previous_name, staging_name)?;
        if !payload.exists() {
            return Ok(());
        }
        let index_blob = read_blob_file(&payload.join(PAYLOAD_INDEX_FILE))?;
        let index_plain = vault.open(&format!("{namespace}/index"), &index_blob)?;
        let index: PayloadIndex = serde_json::from_slice(&index_plain)
            .map_err(|_| "WORKSPACE_PAYLOAD_INDEX_INVALID".to_string())?;
        if index.version != 1 {
            return Err("WORKSPACE_PAYLOAD_VERSION_UNSUPPORTED".to_string());
        }
        for entry in index.entries {
            restore_payload_file(vault, &payload, &self.active_root, namespace, &entry)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Session {
    pub workspace_hash: [u8; 32],
    pub device_hash: [u8; 32],
    pub csrf_hash: [u8; 32],
    pub previous_csrf_hash: Option<[u8; 32]>,
    pub previous_csrf_expires_at: u64,
}

impl Session {
    fn accepts_csrf_hash(&self, supplied: &[u8; 32], now: u64) -> bool {
        let current_matches = bool::from(self.csrf_hash.ct_eq(supplied));
        let previous_hash = self.previous_csrf_hash.unwrap_or([0_u8; 32]);
        let previous_matches = bool::from(previous_hash.ct_eq(supplied))
            && self.previous_csrf_hash.is_some()
            && now <= self.previous_csrf_expires_at;
        current_matches || previous_matches
    }
}

#[derive(Clone, Copy)]
pub struct SessionContext {
    pub workspace_hash: [u8; 32],
    pub device_hash: [u8; 32],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub storage_mode: StorageMode,
    pub expires_at: Option<u64>,
    pub lease_seconds: Option<u64>,
    pub ui_lease: &'static str,
    pub maintenance: bool,
    pub quota_bytes: Option<u64>,
    pub used_bytes: u64,
}

impl AppState {
    pub fn load(config: Config) -> Result<Self, String> {
        prepare_clean_active_root(&config.active_root)?;
        prepare_root(&config.disk_root)?;
        prepare_root(&config.ram_root)?;
        require_noswap_tmpfs(&config.active_root)?;
        require_noswap_tmpfs(&config.ram_root)?;
        let mut workspaces = HashMap::new();
        load_root(
            &config.disk_root,
            &config.active_root,
            StorageMode::Disk,
            &mut workspaces,
        )?;
        load_root(
            &config.ram_root,
            &config.active_root,
            StorageMode::Ram,
            &mut workspaces,
        )?;
        if config.deployment_mode == DeploymentMode::Personal && workspaces.len() > 1 {
            return Err("PERSONAL_MODE_REQUIRES_AT_MOST_ONE_WORKSPACE".to_string());
        }
        let server_secret = random_array::<32>()?;
        let dummy_hash = random_array::<32>()?;
        let dummy_password = URL_SAFE_NO_PAD.encode(random_array::<32>()?);
        let mut dummy_vault = WorkspaceVault::create(dummy_hash, "dummy", &dummy_password)?;
        dummy_vault.lock();
        Ok(Self {
            config: config.clone(),
            inner: Mutex::new(InnerState {
                workspaces,
                pending_workspace_imports: HashMap::new(),
                restoring_workspaces: HashSet::new(),
                proofs: ProofRegistry::default(),
                auth_backoff: AuthBackoff::default(),
                admission: ResourceAdmission::new(config.max_instances)?,
                sessions: HashMap::new(),
                server_secret,
                dummy_vault,
                maintenance: false,
            }),
        })
    }

    pub fn source_fingerprint(&self, source_address: &[u8]) -> Result<[u8; 32], String> {
        let inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        Ok(source_fingerprint(&inner.server_secret, source_address))
    }

    pub fn resource_snapshot(&self) -> ResourceSnapshot {
        resource_snapshot(&self.config.disk_root, self.active_instances())
    }

    pub fn active_instances(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .workspaces
                    .len()
                    .saturating_add(inner.restoring_workspaces.len())
            })
            .unwrap_or(self.config.max_instances)
    }

    pub fn maintenance_tick(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let now = now_seconds();
        let stale_workspace_imports = inner
            .pending_workspace_imports
            .iter()
            .filter_map(|(id, pending)| {
                (!pending.finalizing
                    && now.saturating_sub(pending.created_at) >= PROFILE_IMPORT_TTL_SECONDS)
                    .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        for id in stale_workspace_imports {
            if let Some(stale) = inner.pending_workspace_imports.remove(&id) {
                if stale.remove_file(&self.config.active_root).is_err() {
                    inner.pending_workspace_imports.insert(id, stale);
                }
            }
        }
        let mut expired = Vec::new();
        for (workspace_hash, stored) in &mut inner.workspaces {
            if stored
                .pending_profile_import
                .as_ref()
                .is_some_and(|pending| {
                    !pending.finalizing
                        && now.saturating_sub(pending.created_at) >= PROFILE_IMPORT_TTL_SECONDS
                })
            {
                if let Some(stale) = stored.pending_profile_import.take() {
                    if remove_pending_profile_import_file(&stored.active_root, &stale).is_err() {
                        stored.pending_profile_import = Some(stale);
                    }
                }
            }
            if stored.runtime.is_some() {
                let ui_active = stored.domain.ui_lease.has_fresh_holder(now);
                if !ui_active {
                    if let Some(runtime) = stored.runtime.as_ref() {
                        runtime.pause_web_transfer(&mut stored.domain);
                    }
                }
                let _ = stored.refresh_effective_presence(now);
            }
            let transfer_active = stored.domain.transfers.active().is_some()
                || stored
                    .runtime
                    .as_ref()
                    .is_some_and(WebWorkspaceRuntime::web_transfer_active);
            let lease = stored.domain.data_lease.status(now, transfer_active);
            if lease.erase_now {
                if stored.stop_runtime().is_err() {
                    continue;
                }
                stored.domain.cryptographic_erase_after_expiry();
                if Self::persist(stored).is_ok() {
                    expired.push((
                        *workspace_hash,
                        stored.root.clone(),
                        stored.active_root.clone(),
                    ));
                }
                continue;
            }
            if stored.runtime.is_some() {
                let _ = stored.checkpoint(false);
                let _ = Self::persist(stored);
            }
        }
        for (workspace_hash, _, _) in &expired {
            inner.workspaces.remove(workspace_hash);
            inner
                .sessions
                .retain(|_, session| session.workspace_hash != *workspace_hash);
        }
        drop(inner);
        for (_, root, active_root) in expired {
            let _ = self.remove_active_workspace_directory(&active_root);
            let _ = self.remove_workspace_directory(&root);
        }
    }

    pub fn issue_session(
        inner: &mut InnerState,
        workspace_hash: [u8; 32],
        device_hash: [u8; 32],
    ) -> Result<String, String> {
        let csrf = URL_SAFE_NO_PAD.encode(random_array::<32>()?);
        let now = now_seconds();
        let previous_csrf_hash = inner
            .sessions
            .get(&device_hash)
            .filter(|session| session.workspace_hash == workspace_hash)
            .map(|session| session.csrf_hash);
        inner.sessions.insert(
            device_hash,
            Session {
                workspace_hash,
                device_hash,
                csrf_hash: hash_csrf(&csrf),
                previous_csrf_hash,
                previous_csrf_expires_at: now.saturating_add(CSRF_ROTATION_GRACE_SECONDS),
            },
        );
        Ok(csrf)
    }

    pub fn authenticate(
        inner: &InnerState,
        device_token: &str,
        csrf: Option<&str>,
    ) -> Result<SessionContext, String> {
        let mut matched = None;
        for (workspace_hash, workspace) in &inner.workspaces {
            if let Ok(device_hash) = workspace.domain.devices.token_hash(device_token) {
                matched = Some((*workspace_hash, device_hash));
            }
        }
        let (workspace_hash, device_hash) = matched.ok_or("AUTH_INVALID")?;
        let session = inner.sessions.get(&device_hash).ok_or("AUTH_INVALID")?;
        if !bool::from(session.workspace_hash.ct_eq(&workspace_hash))
            || !bool::from(session.device_hash.ct_eq(&device_hash))
        {
            return Err("AUTH_INVALID".to_string());
        }
        if let Some(csrf) = csrf {
            if !session.accepts_csrf_hash(&hash_csrf(csrf), now_seconds()) {
                return Err("CSRF_INVALID".to_string());
            }
        }
        Ok(SessionContext {
            workspace_hash,
            device_hash,
        })
    }

    pub fn view(
        &self,
        workspace: &mut WorkspaceDomain,
        device_hash: Option<&[u8; 32]>,
        maintenance: bool,
        now: u64,
    ) -> WorkspaceView {
        let transfer_active = workspace.transfers.active().is_some();
        let status = workspace.data_lease.status(now, transfer_active);
        let expires_at = status
            .remaining_seconds
            .map(|remaining| now.saturating_add(remaining).saturating_mul(1000));
        let unlimited =
            workspace.data_lease.configured_seconds() == 0 && workspace.profiles.stored_count() > 0;
        let ui_lease = match device_hash {
            Some(hash) if workspace.ui_lease.owned_by(hash) => "owned",
            _ if workspace.ui_lease.is_stale(now) => "stale",
            _ if workspace.ui_lease.has_holder() => "occupied",
            _ => "stale",
        };
        WorkspaceView {
            storage_mode: workspace.storage_mode,
            expires_at: if unlimited { None } else { expires_at },
            lease_seconds: if unlimited {
                None
            } else {
                Some(workspace.data_lease.configured_seconds())
            },
            ui_lease,
            maintenance,
            quota_bytes: self.config.public_quota_for(workspace.storage_mode),
            used_bytes: workspace.quota.user_used_bytes,
        }
    }

    pub fn persist(stored: &StoredWorkspace) -> Result<(), String> {
        let encoded = serde_json::to_vec(&stored.domain)
            .map_err(|error| format!("Could not encode workspace metadata: {error}"))?;
        atomic_write(&stored.root.join(DOMAIN_FILE), &encoded)
    }

    pub fn workspace_root(&self, mode: StorageMode, hash: &[u8; 32]) -> PathBuf {
        let root = match mode {
            StorageMode::Disk => &self.config.disk_root,
            StorageMode::Ram => &self.config.ram_root,
        };
        root.join(hex(hash))
    }

    pub fn workspace_active_root(&self, hash: &[u8; 32]) -> PathBuf {
        self.config.active_root.join(hex(hash))
    }

    pub fn remove_workspace_directory(&self, path: &Path) -> Result<(), String> {
        let disk = canonical_or_self(&self.config.disk_root);
        let ram = canonical_or_self(&self.config.ram_root);
        let target = canonical_or_self(path);
        if target == disk
            || target == ram
            || (!target.starts_with(&disk) && !target.starts_with(&ram))
        {
            return Err("WORKSPACE_PATH_INVALID".to_string());
        }
        if path.exists() {
            fs::remove_dir_all(path)
                .map_err(|error| format!("Could not remove erased workspace: {error}"))?;
        }
        Ok(())
    }

    pub fn remove_active_workspace_directory(&self, path: &Path) -> Result<(), String> {
        remove_internal_directory(&self.config.active_root, path)
    }
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn load_root(
    root: &Path,
    active_root: &Path,
    expected_mode: StorageMode,
    workspaces: &mut HashMap<[u8; 32], StoredWorkspace>,
) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|error| {
        format!(
            "Could not inspect workspace root {}: {error}",
            root.display()
        )
    })?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if let Some(import_id) = name.strip_prefix(".workspace-activate-") {
            if import_id.len() == 32
                && import_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                let metadata = fs::symlink_metadata(&path).map_err(|error| {
                    format!("Could not inspect interrupted workspace import: {error}")
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
                }
                remove_internal_directory(root, &path)?;
                continue;
            }
        }
        let Some(hash) = parse_hex_hash(name) else {
            continue;
        };
        let bytes = match fs::read(path.join(DOMAIN_FILE)) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let mut domain: WorkspaceDomain = serde_json::from_slice(&bytes)
            .map_err(|_| "A workspace metadata file is invalid".to_string())?;
        if domain.storage_mode != expected_mode || !bool::from(domain.workspace_hash.ct_eq(&hash)) {
            return Err("A workspace crossed its storage boundary".to_string());
        }
        domain.lock_after_restart();
        if workspaces
            .insert(
                hash,
                StoredWorkspace {
                    root: path,
                    active_root: active_root.join(hex(&hash)),
                    domain,
                    runtime: None,
                    pending_profile_import: None,
                    last_payload_checkpoint: Instant::now(),
                },
            )
            .is_some()
        {
            return Err("Duplicate workspace hash across storage modes".to_string());
        }
    }
    Ok(())
}

fn prepare_root(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| {
        format!(
            "Could not create workspace root {}: {error}",
            root.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect {}: {error}", root.display()))?;
    }
    Ok(())
}

fn prepare_clean_active_root(root: &Path) -> Result<(), String> {
    if root.parent().is_none() || root.file_name().is_none() {
        return Err("KAIGEN_WEB_ACTIVE_ROOT is too broad".to_string());
    }
    if root.exists() {
        let resolved = canonical_or_self(root);
        if resolved.parent().is_none() || resolved.file_name().is_none() {
            return Err("KAIGEN_WEB_ACTIVE_ROOT is too broad".to_string());
        }
        fs::remove_dir_all(root)
            .map_err(|error| format!("Could not clear active workspace root: {error}"))?;
    }
    prepare_root(root)
}

#[cfg(target_os = "linux")]
fn require_noswap_tmpfs(path: &Path) -> Result<(), String> {
    let target = fs::canonicalize(path)
        .map_err(|error| format!("Could not verify secure memory root: {error}"))?;
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|error| format!("Could not inspect secure memory mounts: {error}"))?;
    let mut selected: Option<(PathBuf, String, String)> = None;
    for line in mountinfo.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let fields = left.split_whitespace().collect::<Vec<_>>();
        let filesystem = right.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 6 || filesystem.len() < 3 {
            continue;
        }
        let mount_point = PathBuf::from(unescape_mountinfo_path(fields[4]));
        if !target.starts_with(&mount_point)
            || selected.as_ref().is_some_and(|(current, _, _)| {
                current.as_os_str().len() >= mount_point.as_os_str().len()
            })
        {
            continue;
        }
        selected = Some((
            mount_point,
            filesystem[0].to_string(),
            format!("{},{}", fields[5], filesystem[2]),
        ));
    }
    let Some((_, filesystem, options)) = selected else {
        return Err("KAIGEN_WEB_SECURE_MEMORY_MOUNT_NOT_FOUND".to_string());
    };
    if filesystem != "tmpfs" || !options.split(',').any(|option| option == "noswap") {
        return Err("KAIGEN_WEB_SECURE_MEMORY_REQUIRES_NOSWAP_TMPFS".to_string());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn unescape_mountinfo_path(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(not(target_os = "linux"))]
fn require_noswap_tmpfs(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn protect_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect {}: {error}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn active_base(active_root: &Path) -> Result<&Path, String> {
    active_root
        .parent()
        .ok_or("WORKSPACE_ACTIVE_PATH_INVALID".to_string())
}

fn remove_internal_directory(base: &Path, target: &Path) -> Result<(), String> {
    if target.parent() != Some(base) {
        let base_resolved = canonical_or_self(base);
        let target_resolved = canonical_or_self(target);
        if target_resolved == base_resolved || !target_resolved.starts_with(&base_resolved) {
            return Err("WORKSPACE_INTERNAL_PATH_INVALID".to_string());
        }
    }
    if target.exists() {
        fs::remove_dir_all(target)
            .map_err(|error| format!("Could not remove internal workspace data: {error}"))?;
    }
    Ok(())
}

fn recover_payload_directory(
    workspace_root: &Path,
    current_name: &str,
    previous_name: &str,
    staging_name: &str,
) -> Result<PathBuf, String> {
    let current = workspace_root.join(current_name);
    let previous = workspace_root.join(previous_name);
    let staging = workspace_root.join(staging_name);
    remove_internal_directory(workspace_root, &staging)?;
    if !current.exists() && previous.exists() {
        fs::rename(&previous, &current)
            .map_err(|error| format!("Could not recover encrypted payload: {error}"))?;
    } else {
        remove_internal_directory(workspace_root, &previous)?;
    }
    Ok(current)
}

fn collect_payload_files(root: &Path) -> Result<Vec<(String, u64)>, String> {
    fn visit(root: &Path, directory: &Path, output: &mut Vec<(String, u64)>) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("Could not inspect active workspace: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("Could not inspect active workspace: {error}"))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Could not inspect active workspace entry: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("WORKSPACE_PAYLOAD_SYMLINK_FORBIDDEN".to_string());
            }
            if metadata.is_dir() {
                visit(root, &path, output)?;
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "WORKSPACE_PAYLOAD_PATH_INVALID")?;
                let relative = relative
                    .components()
                    .map(|component| {
                        component
                            .as_os_str()
                            .to_str()
                            .ok_or("WORKSPACE_PAYLOAD_PATH_INVALID")
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join("/");
                if payload_path_allowed(&relative) {
                    output.push((relative, metadata.len()));
                }
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    if root.exists() {
        visit(root, root, &mut output)?;
    }
    output.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(output)
}

fn payload_path_allowed(relative: &str) -> bool {
    let components = relative.split('/').collect::<Vec<_>>();
    let transient_profile_import = components.first().is_some_and(|component| {
        component.starts_with(".profile-import-") || component.starts_with(".profile-restore-")
    });
    !transient_profile_import
        && !components
            .iter()
            .any(|component| matches!(*component, "logs" | "downloads" | "outgoing-files"))
        && !relative.starts_with("runtime/tor/")
        && !relative.starts_with("runtime/operational/")
}

fn remove_pending_profile_import_file(
    active_root: &Path,
    pending: &PendingProfileImport,
) -> Result<(), String> {
    let expected_name = format!(".profile-import-{}.upload", pending.id);
    if pending.path.parent() != Some(active_root)
        || pending.path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str())
    {
        return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
    }
    if pending.path.exists() {
        let metadata = fs::symlink_metadata(&pending.path)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
        }
        fs::remove_file(&pending.path)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    }
    Ok(())
}

fn security_critical_path(relative: &str) -> bool {
    relative.ends_with(".kai.keys")
}

fn payload_file_name(relative: &str) -> String {
    format!("{}.enc", hex(&Sha256::digest(relative.as_bytes())))
}

fn seal_payload_file(
    vault: &WorkspaceVault,
    active_root: &Path,
    staging: &Path,
    namespace: &str,
    relative: &str,
    size: u64,
) -> Result<PayloadEntry, String> {
    let source = safe_payload_join(active_root, relative)?;
    let destination = staging.join(payload_file_name(relative));
    let mut input = fs::File::open(&source)
        .map_err(|error| format!("Could not read active workspace payload: {error}"))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&destination)
        .map_err(|error| format!("Could not create encrypted payload file: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; PAYLOAD_CHUNK_BYTES];
    let mut chunks = 0_u32;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("Could not read active workspace payload: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        let logical = format!("{namespace}/file/{relative}/{chunks}");
        let blob = vault.seal(&logical, &buffer[..read])?;
        write_blob(&mut output, &blob)?;
        chunks = chunks.checked_add(1).ok_or("WORKSPACE_PAYLOAD_TOO_LARGE")?;
    }
    output
        .sync_all()
        .map_err(|error| format!("Could not sync encrypted payload file: {error}"))?;
    Ok(PayloadEntry {
        path: relative.to_string(),
        size,
        chunks,
        sha256: digest.finalize().into(),
        security_critical: security_critical_path(relative),
    })
}

fn restore_payload_file(
    vault: &WorkspaceVault,
    payload: &Path,
    active_root: &Path,
    namespace: &str,
    entry: &PayloadEntry,
) -> Result<(), String> {
    let destination = safe_payload_join(active_root, &entry.path)?;
    let parent = destination
        .parent()
        .ok_or("WORKSPACE_PAYLOAD_PATH_INVALID")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create active payload directory: {error}"))?;
    protect_directory(parent)?;
    let temporary = destination.with_extension("restore-new");
    let mut output = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not restore active payload: {error}"))?;
    let mut input = fs::File::open(payload.join(payload_file_name(&entry.path)))
        .map_err(|_| "WORKSPACE_PAYLOAD_FILE_MISSING".to_string())?;
    let mut digest = Sha256::new();
    let mut restored = 0_u64;
    for chunk in 0..entry.chunks {
        let blob = read_blob(&mut input)?;
        let logical = format!("{namespace}/file/{}/{chunk}", entry.path);
        let plaintext = vault.open(&logical, &blob)?;
        restored = restored.saturating_add(plaintext.len() as u64);
        digest.update(&plaintext);
        output
            .write_all(&plaintext)
            .map_err(|error| format!("Could not restore active payload: {error}"))?;
    }
    if restored != entry.size
        || !bool::from(<[u8; 32]>::from(digest.finalize()).ct_eq(&entry.sha256))
    {
        let _ = fs::remove_file(&temporary);
        return Err("WORKSPACE_PAYLOAD_INTEGRITY_FAILED".to_string());
    }
    output
        .sync_all()
        .map_err(|error| format!("Could not sync restored payload: {error}"))?;
    drop(output);
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Could not activate restored payload: {error}"))?;
    Ok(())
}

fn safe_payload_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':', '\0'])
        })
    {
        return Err("WORKSPACE_PAYLOAD_PATH_INVALID".to_string());
    }
    Ok(relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part)))
}

fn write_blob_file(path: &Path, blob: &EncryptedBlob) -> Result<(), String> {
    let mut encoded = Vec::with_capacity(blob.ciphertext.len() + 20);
    write_blob(&mut encoded, blob)?;
    atomic_write(path, &encoded)
}

fn read_blob_file(path: &Path) -> Result<EncryptedBlob, String> {
    let mut file =
        fs::File::open(path).map_err(|_| "WORKSPACE_PAYLOAD_INDEX_MISSING".to_string())?;
    let blob = read_blob(&mut file)?;
    let mut trailing = [0_u8; 1];
    if file.read(&mut trailing).unwrap_or(1) != 0 {
        return Err("WORKSPACE_PAYLOAD_BLOB_INVALID".to_string());
    }
    Ok(blob)
}

fn write_blob(writer: &mut impl Write, blob: &EncryptedBlob) -> Result<(), String> {
    let length = u32::try_from(blob.ciphertext.len()).map_err(|_| "WORKSPACE_PAYLOAD_TOO_LARGE")?;
    writer
        .write_all(&blob.version.to_le_bytes())
        .and_then(|_| writer.write_all(&blob.nonce))
        .and_then(|_| writer.write_all(&length.to_le_bytes()))
        .and_then(|_| writer.write_all(&blob.ciphertext))
        .map_err(|error| format!("Could not write encrypted payload: {error}"))
}

fn read_blob(reader: &mut impl Read) -> Result<EncryptedBlob, String> {
    let mut version = [0_u8; 4];
    let mut nonce = [0_u8; 12];
    let mut length = [0_u8; 4];
    reader
        .read_exact(&mut version)
        .and_then(|_| reader.read_exact(&mut nonce))
        .and_then(|_| reader.read_exact(&mut length))
        .map_err(|_| "WORKSPACE_PAYLOAD_BLOB_TRUNCATED".to_string())?;
    let length = u32::from_le_bytes(length) as usize;
    if length > PAYLOAD_CHUNK_BYTES + 64 {
        return Err("WORKSPACE_PAYLOAD_BLOB_INVALID".to_string());
    }
    let mut ciphertext = vec![0_u8; length];
    reader
        .read_exact(&mut ciphertext)
        .map_err(|_| "WORKSPACE_PAYLOAD_BLOB_TRUNCATED".to_string())?;
    Ok(EncryptedBlob {
        version: u32::from_le_bytes(version),
        nonce,
        ciphertext,
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("WORKSPACE_PATH_INVALID")?;
    prepare_root(parent)?;
    let temporary = path.with_extension("json.new");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create workspace metadata: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write workspace metadata: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync workspace metadata: {error}"))?;
    drop(file);
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not commit workspace metadata: {error}"))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync workspace directory: {error}"))?;
    Ok(())
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut value = [0_u8; N];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut value)
        .map_err(|_| "Secure random source failed".to_string())?;
    Ok(value)
}

fn hash_csrf(value: &str) -> [u8; 32] {
    Sha256::digest([b"kaigen-web-csrf-v1".as_slice(), value.as_bytes()].concat()).into()
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn parse_hex_hash(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut result = [0_u8; 32];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn resource_snapshot(path: &Path, active_instances: usize) -> ResourceSnapshot {
    #[cfg(target_os = "linux")]
    {
        let memory_available_percent = fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|contents| {
                let mut total = None;
                let mut available = None;
                for line in contents.lines() {
                    let mut parts = line.split_whitespace();
                    match parts.next() {
                        Some("MemTotal:") => total = parts.next()?.parse::<f64>().ok(),
                        Some("MemAvailable:") => available = parts.next()?.parse::<f64>().ok(),
                        _ => {}
                    }
                }
                Some(available? * 100.0 / total?)
            })
            .unwrap_or(0.0);
        let cpu_five_minute_percent = fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|contents| contents.split_whitespace().nth(1)?.parse::<f64>().ok())
            .map(|load| {
                let cpus = std::thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(1) as f64;
                load * 100.0 / cpus
            })
            .unwrap_or(100.0);
        let disk_available_percent = unix_disk_available_percent(path).unwrap_or(0.0);
        return ResourceSnapshot {
            memory_available_percent,
            disk_available_percent,
            cpu_five_minute_percent,
            projected_runtime_reserve_available: memory_available_percent > 20.0
                && disk_available_percent > 20.0,
            active_instances,
        };
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        ResourceSnapshot {
            memory_available_percent: 100.0,
            disk_available_percent: 100.0,
            cpu_five_minute_percent: 0.0,
            projected_runtime_reserve_available: true,
            active_instances,
        }
    }
}

#[cfg(target_os = "linux")]
fn unix_disk_available_percent(path: &Path) -> Option<f64> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    let stats = unsafe { stats.assume_init() };
    if stats.f_blocks == 0 {
        return None;
    }
    Some(stats.f_bavail as f64 * 100.0 / stats.f_blocks as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_app_lib::web_core::WorkspaceConfig;

    #[test]
    fn payload_snapshot_excludes_profile_import_transients() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-webd-transient-{}-{}",
            std::process::id(),
            hex(&random_array::<8>().unwrap())
        ));
        fs::create_dir_all(root.join(".profile-restore-test/data")).unwrap();
        fs::write(
            root.join(".profile-import-test.upload"),
            b"encrypted upload",
        )
        .unwrap();
        fs::write(
            root.join(".profile-restore-test/data/history.json"),
            b"restored plaintext",
        )
        .unwrap();
        fs::create_dir_all(root.join("profiles/profile/data")).unwrap();
        fs::write(
            root.join("profiles/profile/data/history.json"),
            b"canonical",
        )
        .unwrap();

        let files = collect_payload_files(&root).unwrap();
        assert_eq!(
            files,
            vec![(
                "profiles/profile/data/history.json".to_string(),
                b"canonical".len() as u64,
            )]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn payload_snapshot_is_encrypted_and_round_trips() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-webd-state-{}-{}",
            std::process::id(),
            hex(&random_array::<8>().unwrap())
        ));
        let persistent = root.join("disk").join("workspace");
        let active = root.join("active").join("workspace");
        fs::create_dir_all(active.join("profiles/profile/data")).unwrap();
        fs::write(
            active.join("profiles/profile/data/chat-history.json"),
            b"private-message-marker",
        )
        .unwrap();
        fs::write(active.join("profiles/profile/profile.tox"), b"savedata").unwrap();
        let mut domain = WorkspaceDomain::provisional(
            [7_u8; 32],
            WorkspaceConfig {
                storage_mode: StorageMode::Disk,
                quota_bytes: 1024 * 1024,
                security_reserve_bytes: 1024 * 1024,
                lease_hours: 24,
            },
            now_seconds(),
        )
        .unwrap();
        domain
            .create_first_profile(
                "profile".to_string(),
                "Profile".to_string(),
                "password",
                now_seconds(),
            )
            .unwrap();
        let mut stored = StoredWorkspace {
            root: persistent.clone(),
            active_root: active.clone(),
            domain,
            runtime: None,
            pending_profile_import: None,
            last_payload_checkpoint: Instant::now(),
        };
        stored.checkpoint_payload().unwrap();
        let encrypted = fs::read_dir(persistent.join(PAYLOAD_DIRECTORY))
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read(entry.path()).ok())
            .flatten()
            .collect::<Vec<_>>();
        assert!(!encrypted
            .windows(b"private-message-marker".len())
            .any(|window| window == b"private-message-marker"));
        fs::remove_dir_all(&active).unwrap();
        stored.restore_payload().unwrap();
        assert_eq!(
            fs::read(active.join("profiles/profile/data/chat-history.json")).unwrap(),
            b"private-message-marker"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn quota_full_keeps_previous_user_data_but_commits_latest_savedata() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-webd-reserve-test-{}-{}",
            std::process::id(),
            hex(&random_array::<8>().unwrap())
        ));
        let persistent = root.join("disk/workspace");
        let active = root.join("active/workspace");
        let container = active.join("profiles/profile/profile.kai");
        let key_sidecar = active.join("profiles/profile/profile.kai.keys");
        fs::create_dir_all(container.parent().unwrap()).unwrap();
        fs::write(&container, b"old").unwrap();
        fs::write(&key_sidecar, b"savedata-v1").unwrap();
        let mut domain = WorkspaceDomain::provisional(
            [9_u8; 32],
            WorkspaceConfig {
                storage_mode: StorageMode::Disk,
                quota_bytes: 8,
                security_reserve_bytes: 1024 * 1024,
                lease_hours: 24,
            },
            now_seconds(),
        )
        .unwrap();
        domain
            .create_first_profile(
                "profile".to_string(),
                "Profile".to_string(),
                "password",
                now_seconds(),
            )
            .unwrap();
        let mut stored = StoredWorkspace {
            root: persistent,
            active_root: active.clone(),
            domain,
            runtime: None,
            pending_profile_import: None,
            last_payload_checkpoint: Instant::now(),
        };
        stored.checkpoint_payload().unwrap();
        fs::write(&container, b"optional-data-over-quota").unwrap();
        fs::write(&key_sidecar, b"savedata-v2").unwrap();
        assert_eq!(
            stored.checkpoint_payload().unwrap_err(),
            "WORKSPACE_QUOTA_FULL"
        );
        fs::remove_dir_all(&active).unwrap();
        stored.restore_payload().unwrap();
        assert_eq!(fs::read(&container).unwrap(), b"old");
        assert_eq!(fs::read(&key_sidecar).unwrap(), b"savedata-v2");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn csrf_rotation_keeps_only_a_bounded_in_flight_grace_token() {
        let current = hash_csrf("current-token");
        let previous = hash_csrf("previous-token");
        let session = Session {
            workspace_hash: [1_u8; 32],
            device_hash: [2_u8; 32],
            csrf_hash: current,
            previous_csrf_hash: Some(previous),
            previous_csrf_expires_at: 130,
        };

        assert!(session.accepts_csrf_hash(&current, 1_000));
        assert!(session.accepts_csrf_hash(&previous, 130));
        assert!(!session.accepts_csrf_hash(&previous, 131));
        assert!(!session.accepts_csrf_hash(&hash_csrf("unknown-token"), 100));
    }
}
