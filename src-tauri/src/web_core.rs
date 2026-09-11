//! Transport-neutral domain state for the Kaigen web product.
//!
//! This module deliberately knows nothing about HTTP, WebSocket, Nginx or
//! Tauri.  The web daemon and its tests use these state machines directly.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::kai::KaiProfileVolume;
use crate::profiles;
use crate::web_transfer_store::{
    StoreDirection, StoreError, StoreObjectStatus, StoreOperation, StorePhase, StoreReply,
    StoreSpec, WebTransferStore,
};
use crate::{
    sanitize_untrusted_text, FileReceiveSettings, NetworkSettings, PendingToxMessage,
    ProfileCipher, ProfilePaths, ProxySettings, TorManager, ToxState,
};

pub const IDENTIFIER_CORE_BYTES: usize = 32;
pub const PROVISIONAL_TTL_SECONDS: u64 = 30 * 60;
pub const UI_HEARTBEAT_SECONDS: u64 = 20;
pub const UI_LEASE_STALE_SECONDS: u64 = 90;
pub const DEVICE_REAUTH_SECONDS: u64 = 2 * 60 * 60;
pub const DEVICE_VERIFY_SECONDS: u64 = 5 * 60;
pub const TRANSFER_RATE_BYTES_PER_SECOND: u64 = 1024 * 1024;
pub const TRANSFER_BUFFER_LIMIT_BYTES: u64 = 25 * 1024 * 1024;
pub const EXPIRY_TRANSFER_CAP_SECONDS: u64 = 60 * 60;
pub const EXPIRY_GRACE_SECONDS: u64 = 15 * 60;
pub const TEST_DISK_QUOTA_BYTES: u64 = 256 * 1024 * 1024;
pub const TEST_RAM_QUOTA_BYTES: u64 = 128 * 1024 * 1024;
pub const TEST_MAX_INSTANCES: usize = 8;

// Values from the pinned c-toxcore Tox_Err_File_Send_Chunk enum. Keeping the
// recoverable cases named here makes the FFI boundary explicit without
// exposing the C enum throughout the application core.
const TOX_FILE_SEND_CHUNK_NOT_TRANSFERRING: i32 = 5;
const TOX_FILE_SEND_CHUNK_INVALID_LENGTH: i32 = 6;
const TOX_FILE_SEND_CHUNK_SENDQ: i32 = 7;
const TOX_FILE_SEND_CHUNK_WRONG_POSITION: i32 = 8;
const TOX_FILE_CONTROL_ALREADY_PAUSED: i32 = 6;

#[cfg(test)]
std::thread_local! {
    static WEB_USER_FILE_CONTROL_REPLY: std::cell::RefCell<Option<(u32, u32, i32, i32)>> =
        const { std::cell::RefCell::new(None) };
}

fn web_user_file_control(
    tox: *mut std::ffi::c_void,
    friend_number: u32,
    file_number: u32,
    control: i32,
) -> i32 {
    #[cfg(test)]
    if let Some((expected_friend, expected_file, expected_control, error)) =
        WEB_USER_FILE_CONTROL_REPLY.with(|reply| reply.borrow_mut().take())
    {
        assert!(!tox.is_null());
        assert_eq!(
            (friend_number, file_number, control),
            (expected_friend, expected_file, expected_control)
        );
        return error;
    }
    let mut error = 0_i32;
    unsafe {
        let _ = crate::tox_file_control(tox, friend_number, file_number, control, &mut error);
    }
    error
}

const VAULT_VERSION: u32 = 1;
const ARCHIVE_VERSION: u32 = 1;
const ENVELOPE_AAD_DOMAIN: &[u8] = b"kaigen-web-workspace-envelope-v1";
const BLOB_AAD_DOMAIN: &[u8] = b"kaigen-web-workspace-blob-v1";
const WORKSPACE_ACCESS_SCOPE: &str = "__workspace_access__";

/// Synchronous publication boundary shared by every mounted `.kai` volume in
/// one Web workspace. The callback owns only the outer encrypted payload sink;
/// it never re-enters the Web workspace registry.
#[derive(Clone)]
pub struct WebProfileDurability {
    hook: crate::kai::KaiDurabilityHook,
    generation: Arc<AtomicU64>,
}

impl fmt::Debug for WebProfileDurability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebProfileDurability")
            .field("generation", &self.generation())
            .finish()
    }
}

impl WebProfileDurability {
    pub fn new(callback: impl Fn() -> Result<(), String> + Send + Sync + 'static) -> Self {
        let generation = Arc::new(AtomicU64::new(0));
        let completed = Arc::clone(&generation);
        let hook = crate::kai::KaiDurabilityHook::new(move || {
            callback()?;
            completed.fetch_add(1, Ordering::AcqRel);
            Ok(())
        });
        Self { hook, generation }
    }

    pub fn checkpoint(&self) -> Result<(), String> {
        self.hook.checkpoint()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct WebTransferRouting {
    pub id: String,
    pub profile_id: String,
    pub friend_number: u32,
    pub file_number: u32,
    pub outgoing: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct WebOutgoingChunk {
    pub routing: WebTransferRouting,
    pub position: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) struct WebNativeControlUpdate {
    pub message_id: String,
    pub outgoing: bool,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebTransferView {
    pub id: String,
    pub operation_id: Option<String>,
    pub message_id: String,
    pub profile_id: String,
    pub direction: &'static str,
    pub name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub transferred_bytes: u64,
    pub acknowledged_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub eta_seconds: Option<u64>,
    pub state: String,
    pub requested_position: Option<u64>,
    pub requested_length: Option<usize>,
    pub buffered_bytes: u64,
    pub retry_after_ms: u64,
    pub uploaded_bytes: u64,
    pub persisted_bytes: u64,
    pub payload_committed: bool,
    pub payload_sha256: Option<String>,
    pub download_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundTransferWorkEntry {
    profile_id: String,
    friend_number: u32,
    message_id: String,
    transfer_id: String,
    direction: TransferDirection,
    path: String,
    name: String,
    size: u64,
    image: bool,
    state: String,
    completed: bool,
    auto_accept: bool,
    operation_id: Option<String>,
    uploaded_bytes: u64,
    persisted_bytes: u64,
    payload_committed: bool,
    payload_sha256: Option<String>,
    download_available: bool,
}

impl BackgroundTransferWorkEntry {
    fn from_transfer(transfer: &WebTransfer, settings: &FileReceiveSettings) -> Self {
        let image = transfer.mime.starts_with("image/")
            || crate::is_auto_accepted_image_name(&transfer.name);
        let auto_accept =
            !transfer.outgoing && settings.auto_accepts(&transfer.name, transfer.size_bytes);
        Self {
            profile_id: transfer.profile_id.clone(),
            friend_number: transfer.friend_number,
            message_id: transfer.message_id.clone(),
            transfer_id: transfer.id.clone(),
            direction: if transfer.outgoing {
                TransferDirection::Outgoing
            } else {
                TransferDirection::Incoming
            },
            path: format!("browser-stream://{}", transfer.id),
            name: transfer.name.clone(),
            size: transfer.size_bytes,
            image,
            state: transfer.state.clone(),
            completed: transfer.state == "complete",
            auto_accept,
            operation_id: transfer
                .storage
                .as_ref()
                .and_then(|stored| stored.spec.operation_id.clone()),
            uploaded_bytes: transfer
                .storage
                .as_ref()
                .filter(|_| transfer.outgoing)
                .map_or(0, |stored| stored.durable_bytes),
            persisted_bytes: transfer
                .storage
                .as_ref()
                .filter(|_| !transfer.outgoing)
                .map_or(0, |stored| stored.durable_bytes),
            payload_committed: transfer
                .storage
                .as_ref()
                .is_some_and(|stored| stored.phase == StorePhase::Committed),
            payload_sha256: transfer.storage.as_ref().and_then(|stored| {
                stored
                    .committed_sha256
                    .map(|hash| URL_SAFE_NO_PAD.encode(hash))
            }),
            download_available: transfer.state != "cancelled"
                && transfer
                    .storage
                    .as_ref()
                    .is_some_and(|stored| stored.phase == StorePhase::Committed),
        }
    }
}

pub struct WebIncomingChunk {
    pub position: u64,
    pub data: Vec<u8>,
    pub transfer: WebTransferView,
}

/// Consistent, privacy-sensitive input for a profile export. Callers must
/// encrypt it before it leaves the native process and wipe `savedata` after
/// use. No `Debug` implementation is provided intentionally.
pub struct WebProfileExportMaterial {
    pub profile_files: Vec<WebProfileExportFile>,
    pub savedata: Vec<u8>,
    pub metadata_json: Vec<u8>,
    pub settings_json: Vec<u8>,
}

pub struct WebProfileExportFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

pub struct WebKaiImportMaterial {
    pub savedata: Vec<u8>,
    pub data_files: Vec<(String, Vec<u8>)>,
}

pub fn read_kai_profile_import(
    container_path: &Path,
    password: Option<&str>,
) -> Result<WebKaiImportMaterial, String> {
    let volume = KaiProfileVolume::open(container_path.to_path_buf(), password)?;
    let namespace = volume.namespace_root();
    let mut savedata = volume.read(&namespace.join("profile.tox"))?;
    if profiles::is_encrypted(&savedata) {
        let cipher = ProfileCipher::unlock(
            &savedata,
            password.ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?,
        )?;
        let decrypted = cipher.decrypt(&savedata)?;
        crate::wipe_sensitive_bytes(&mut savedata);
        savedata = decrypted;
    }
    let data_root = namespace.join("data");
    let data_files = volume
        .snapshot_plain_files(&data_root)?
        .into_iter()
        .map(|(path, bytes)| {
            let relative = path
                .strip_prefix(&data_root)
                .map_err(|_| "KAI_VOLUME_PATH_INVALID".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if relative.is_empty() {
                return Err("KAI_VOLUME_PATH_INVALID".to_string());
            }
            Ok((relative, bytes))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(WebKaiImportMaterial {
        savedata,
        data_files,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebUploadOutcome {
    pub retry_after_ms: u64,
    pub transfer: WebTransferView,
}

struct WebTransfer {
    id: String,
    message_id: String,
    profile_id: String,
    friend_number: u32,
    file_number: Option<u32>,
    outgoing: bool,
    name: String,
    mime: String,
    size_bytes: u64,
    transferred_bytes: u64,
    acknowledged_bytes: u64,
    meter_at_ms: Option<u64>,
    meter_bytes: u64,
    speed_bytes_per_sec: u64,
    state: String,
    locally_paused: bool,
    incoming_accepted: bool,
    requested_position: Option<u64>,
    requested_length: Option<usize>,
    requested_through: u64,
    native_chunk_bytes: Option<usize>,
    outgoing_chunks: VecDeque<BufferedOutgoingChunk>,
    incoming_chunks: VecDeque<(u64, Arc<[u8]>)>,
    incoming_remote_complete: bool,
    outgoing_remote_complete: bool,
    outgoing_delivery_retry_at: Option<Instant>,
    terminal_reconciled: bool,
    storage: Option<StoreObjectStatus>,
    storage_ready: bool,
    pending_store_append: Option<(u64, Arc<[u8]>)>,
}

struct BufferedOutgoingChunk {
    position: u64,
    data: Arc<[u8]>,
    consumed: usize,
}

type TransferHistoryResult = Arc<Mutex<Option<Result<bool, String>>>>;

struct TransferHistoryProbe {
    revision: u64,
    result: TransferHistoryResult,
}

struct TransferHistoryRequest {
    history_path: PathBuf,
    friend_number: u32,
    spec: StoreSpec,
    result: TransferHistoryResult,
}

fn transfer_history_completed(
    message: &crate::ToxMessage,
    spec: &StoreSpec,
) -> Result<bool, String> {
    if message.friend_public_key != spec.friend_public_key
        || message.mine != (spec.direction == StoreDirection::Outgoing)
    {
        return Err("TRANSFER_STORAGE_CONFLICT".to_string());
    }
    Ok(message
        .attachment
        .as_ref()
        .is_some_and(|attachment| attachment.completed))
}

fn publish_web_outgoing_progress(
    messages: &Arc<Mutex<Vec<crate::ToxMessage>>>,
    message_id: &str,
    transferred: u64,
    speed: u64,
    size: u64,
) {
    let Ok(mut messages) = messages.lock() else {
        return;
    };
    let Some(attachment) = messages
        .iter_mut()
        .find(|message| message.id == message_id)
        .and_then(|message| message.attachment.as_mut())
    else {
        return;
    };
    // Native completion and control callbacks use this same lock. A drain that
    // released its native handle must not overwrite their later row state.
    // An explicit resume or retry publishes sending before fresh progress.
    if attachment.completed || attachment.transfer_state != "sending" {
        return;
    }
    attachment.transferred = transferred.min(size);
    attachment.speed_bytes_per_sec = speed;
    attachment.eta_seconds = if speed == 0 {
        None
    } else {
        Some(size.saturating_sub(attachment.transferred).div_ceil(speed))
    };
    attachment.transfer_state = "sending".to_string();
    attachment.completed = false;
    attachment.completed_at = None;
    attachment.transfer_error = None;
}

fn ensure_transfer_profile(actual: &str, requested: &str) -> Result<(), String> {
    if actual == requested {
        Ok(())
    } else {
        Err("TRANSFER_PROFILE_MISMATCH".to_string())
    }
}

fn resume_web_transfer_with_native_control(
    native_handle: &Mutex<Option<crate::ToxHandle>>,
    receive_settings: &Mutex<FileReceiveSettings>,
    bridge: &WebFileBridge,
    messages: &Arc<Mutex<Vec<crate::ToxMessage>>>,
    route: &WebTransferRouting,
    native_control: impl FnOnce(*mut std::ffi::c_void) -> i32,
    #[cfg(test)] before_publish: impl FnOnce(),
) -> Result<bool, String> {
    // Publish the resumed row before the native worker can deliver a callback.
    let handle_guard = native_handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
    if !route.outgoing && crate::incoming_files_denied(receive_settings) {
        return Err("FILE_RECEIVE_DENIED".to_string());
    }
    if matches!(
        bridge.view(&route.id, 0)?.state.as_str(),
        "complete" | "cancelled" | "failed"
    ) {
        return Err("TRANSFER_NOT_RESUMABLE".to_string());
    }
    let handle = handle_guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
    let error = native_control(handle.instance.as_ptr());
    if error != 0 {
        bridge.scheduled_start_failed(&route.id);
        return Ok(false);
    }
    #[cfg(test)]
    before_publish();
    let published = if let Some((message_id, _, _)) = bridge.progress(&route.id) {
        crate::set_attachment_transfer_state(
            messages,
            &message_id,
            if route.outgoing {
                "sending"
            } else {
                "receiving"
            },
        );
        true
    } else {
        false
    };
    drop(handle_guard);
    Ok(published)
}

fn offer_web_transfer_with_native_send(
    native_handle: &Mutex<Option<crate::ToxHandle>>,
    bridge: &WebFileBridge,
    messages: &Arc<Mutex<Vec<crate::ToxMessage>>>,
    outgoing_files: &Mutex<HashMap<(u32, u32), crate::OutgoingFile>>,
    route: &WebTransferRouting,
    message_id: &str,
    mut transfer: crate::OutgoingFile,
    native_send: impl FnOnce(*mut std::ffi::c_void, &crate::OutgoingFile) -> (u32, i32),
    #[cfg(test)] before_publish: impl FnOnce(),
) -> Result<(), String> {
    // Native callbacks must see all bindings for a successfully offered file.
    let handle_guard = native_handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
    let handle = handle_guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
    let (file_number, error) = native_send(handle.instance.as_ptr(), &transfer);
    if error != 0 {
        bridge.outgoing_start_failed(&route.id);
        return Ok(());
    }
    #[cfg(test)]
    before_publish();
    bridge.outgoing_started(&route.id, file_number)?;
    {
        let mut outgoing = outgoing_files
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?;
        transfer.meter = crate::TransferMeter::new();
        transfer.last_activity_at = Instant::now();
        outgoing.insert((route.friend_number, file_number), transfer);
    }
    crate::set_attachment_transfer_state(messages, message_id, "sending");
    drop(handle_guard);
    Ok(())
}

#[derive(Default)]
struct WebFileBridgeState {
    transfers: HashMap<String, WebTransfer>,
    queue: VecDeque<String>,
    active_id: Option<String>,
    buffered_bytes: u64,
    token_bytes: u64,
    token_updated_at_ms: u64,
}

fn fail_incoming_transfer(inner: &mut WebFileBridgeState, id: &str) {
    let buffered_removed = inner
        .transfers
        .get_mut(id)
        .map(|transfer| {
            let buffered = transfer
                .incoming_chunks
                .iter()
                .map(|(_, bytes)| bytes.len() as u64)
                .sum::<u64>();
            transfer.incoming_chunks.clear();
            transfer.pending_store_append = None;
            transfer.state = "failed".to_string();
            buffered
        })
        .unwrap_or(0);
    inner.buffered_bytes = inner.buffered_bytes.saturating_sub(buffered_removed);
    // Keep a failed active transfer in the slot until the backend transfer
    // tick applies the same terminal state to WorkspaceDomain. Starting the
    // next bridge entry before that reconciliation can make its first progress
    // update target the previous domain transfer.
}

/// Bounded, workspace-wide bridge between toxcore callbacks and the workspace
/// transfer store. It is deliberately shared by every active profile,
/// which makes the one-transfer, 25 MiB and 1 MiB/s policies impossible to
/// bypass through another profile or endpoint.
#[derive(Default)]
pub(crate) struct WebFileBridge {
    inner: Mutex<WebFileBridgeState>,
    store: OnceLock<Arc<dyn WebTransferStore>>,
    history_worker: OnceLock<Option<SyncSender<TransferHistoryRequest>>>,
    history_probes: Mutex<HashMap<String, TransferHistoryProbe>>,
}

impl WebFileBridge {
    pub(crate) fn uses_durable_storage(&self) -> bool {
        self.store.get().is_some()
    }

    fn ensure_delivery_control_allowed(&self, id: &str) -> Result<(), String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        if inner
            .transfers
            .get(id)
            .ok_or("TRANSFER_NOT_FOUND")?
            .outgoing_remote_complete
        {
            return Err("TRANSFER_ALREADY_COMPLETE".to_string());
        }
        Ok(())
    }

    fn history_target(&self, id: &str) -> Option<(u32, String)> {
        let inner = self.inner.lock().ok()?;
        let transfer = inner.transfers.get(id)?;
        Some((
            transfer.friend_number,
            transfer.storage.as_ref()?.spec.friend_public_key.clone(),
        ))
    }

    fn decorate_retained_transfer_messages(
        &self,
        profile: &ToxState,
        messages: &mut [crate::ToxMessage],
    ) -> Result<(), String> {
        let Some(profile_id) = profile.web_profile_id.as_deref() else {
            return Ok(());
        };
        let inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        for message in messages {
            let Some(attachment) = message.attachment.as_mut() else {
                continue;
            };
            let id = if let Some(id) = attachment.path.strip_prefix("browser-stream://") {
                id
            } else {
                // Older profile loads could incorrectly rebase this URI as a
                // portable path. Recover only the exact retained object name
                // beneath the corresponding managed attachment directory.
                let mut parts = attachment.path.rsplit(['/', '\\']);
                let Some(id) = parts.next() else { continue };
                let directory = if message.mine {
                    "outgoing-files"
                } else {
                    "downloads"
                };
                if parts.next() != Some(directory) {
                    continue;
                }
                id
            };
            let Some(transfer) = inner.transfers.get(id) else {
                continue;
            };
            let Some(stored) = transfer.storage.as_ref() else {
                continue;
            };
            if transfer.profile_id != profile_id
                || stored.spec.profile_id != profile_id
                || stored.spec.object_id != id
                || stored.spec.message_id != message.id
                || stored.spec.friend_public_key != message.friend_public_key
                || message.mine != (stored.spec.direction == StoreDirection::Outgoing)
                || stored.phase == StorePhase::Removed
                || attachment.size != stored.spec.size_bytes
                || attachment.name != stored.spec.name
                || attachment.mime != stored.spec.mime
            {
                continue;
            }
            attachment.path = format!("browser-stream://{}", stored.spec.object_id);
            if stored.spec.direction == StoreDirection::Outgoing && transfer.state == "failed" {
                // A restored terminal outcome can predate loading this history
                // row into RAM. Project the actual bridge state, never infer
                // failure merely from an unconfirmed native delivery marker.
                attachment.completed = false;
                attachment.completed_at = None;
                attachment.transfer_state = "failed".to_string();
                attachment.transferred = transfer.transferred_bytes;
                attachment.speed_bytes_per_sec = 0;
                attachment.eta_seconds = None;
                attachment.transfer_error = None;
                if message.delivery == "delivered" {
                    message.delivery = "unknown_recovered".to_string();
                    message.delivered_at = None;
                }
                continue;
            }
            if stored.spec.direction != StoreDirection::Outgoing
                || stored.native_delivery_confirmed != Some(true)
                || stored.phase != StorePhase::Committed
            {
                continue;
            }
            // Retained transfer metadata owns the delivery outcome. A restored
            // history window can be older, or absent when history was disabled.
            // Only decorate an existing exact row; never recreate cleared history.
            attachment.completed = true;
            attachment.transfer_state = "complete".to_string();
            attachment.transferred = stored.spec.size_bytes;
            attachment.speed_bytes_per_sec = 0;
            attachment.eta_seconds = None;
            attachment.transfer_error = None;
            message.delivery = "delivered".to_string();
        }
        Ok(())
    }

    // Completed history rows are normally absent from the resident message set.
    // Resolve one exact row on a bounded worker, never under a native handle or
    // the caller's workspace-registry lock. The result retains metadata only.
    fn historical_completion(
        &self,
        history_path: &Path,
        friend_number: u32,
        spec: &StoreSpec,
    ) -> Result<Option<bool>, String> {
        let worker = self.history_worker.get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel::<TransferHistoryRequest>(16);
            thread::Builder::new()
                .name("kaigen-web-transfer-history".to_string())
                .spawn(move || {
                    while let Ok(request) = receiver.recv() {
                        let result = crate::chat_history_store::find_message_registered(
                            &request.history_path,
                            request.friend_number,
                            &request.spec.friend_public_key,
                            &request.spec.message_id,
                        )
                        .and_then(|message| {
                            message.as_ref().map_or(Ok(false), |message| {
                                transfer_history_completed(message, &request.spec)
                            })
                        });
                        if let Ok(mut published) = request.result.lock() {
                            *published = Some(result);
                        };
                    }
                })
                .ok()
                .map(|_| sender)
        });
        let worker = worker.as_ref().ok_or("TRANSFER_HISTORY_UNAVAILABLE")?;
        let revision = crate::history_revision(history_path);
        let mut probes = self
            .history_probes
            .lock()
            .map_err(|_| "TRANSFER_HISTORY_UNAVAILABLE")?;
        if let Some(probe) = probes
            .get(&spec.object_id)
            .filter(|probe| probe.revision == revision)
        {
            return probe
                .result
                .lock()
                .map_err(|_| "TRANSFER_HISTORY_UNAVAILABLE")?
                .clone()
                .transpose();
        }
        let result = Arc::new(Mutex::new(None));
        let request = TransferHistoryRequest {
            history_path: history_path.to_path_buf(),
            friend_number,
            spec: spec.clone(),
            result: Arc::clone(&result),
        };
        match worker.try_send(request) {
            Ok(()) => {
                probes.insert(
                    spec.object_id.clone(),
                    TransferHistoryProbe { revision, result },
                );
                Ok(None)
            }
            Err(TrySendError::Full(_)) => Ok(None),
            Err(TrySendError::Disconnected(_)) => Err("TRANSFER_HISTORY_UNAVAILABLE".to_string()),
        }
    }

    fn install_store(&self, store: Arc<dyn WebTransferStore>) -> Result<(), String> {
        self.store
            .set(store)
            .map_err(|_| "TRANSFER_STORAGE_ALREADY_INSTALLED".to_string())
    }

    fn storage_operation(&self, operation: StoreOperation) -> Result<Option<StoreReply>, String> {
        let store = self.store.get().ok_or("TRANSFER_STORAGE_UNAVAILABLE")?;
        let ticket = match store.try_submit(operation) {
            Ok(ticket) => ticket,
            Err(StoreError::Busy) => return Ok(None),
            Err(error) => return Err(error.code().to_string()),
        };
        match store.try_result(ticket) {
            None | Some(Err(StoreError::Busy)) => Ok(None),
            Some(Ok(reply)) => Ok(Some(reply)),
            Some(Err(error)) => Err(error.code().to_string()),
        }
    }

    fn bind_storage(&self, id: &str, spec: StoreSpec) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        if transfer.id != spec.object_id
            || transfer.message_id != spec.message_id
            || transfer.profile_id != spec.profile_id
            || transfer.size_bytes != spec.size_bytes
            || transfer.outgoing != (spec.direction == StoreDirection::Outgoing)
        {
            return Err("TRANSFER_STORAGE_CONFLICT".to_string());
        }
        if let Some(current) = &transfer.storage {
            if current.spec != spec {
                return Err("TRANSFER_STORAGE_CONFLICT".to_string());
            }
            return Ok(());
        }
        transfer.storage = Some(StoreObjectStatus {
            native_delivery_confirmed: (spec.direction == StoreDirection::Outgoing)
                .then_some(false),
            spec,
            durable_bytes: 0,
            phase: StorePhase::Staging,
            committed_sha256: None,
        });
        if transfer.outgoing {
            transfer.state = "uploading".to_string();
        }
        Ok(())
    }

    fn register_queued_outgoing(
        &self,
        coordinator: &mut TransferCoordinator,
    ) -> Result<bool, String> {
        let offers = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
            inner
                .queue
                .iter()
                .filter_map(|id| {
                    let transfer = inner.transfers.get(id)?;
                    (transfer.outgoing && matches!(transfer.state.as_str(), "uploading" | "queued"))
                        .then(|| TransferOffer {
                            id: id.clone(),
                            profile_id: transfer.profile_id.clone(),
                            direction: TransferDirection::Outgoing,
                            size_bytes: transfer.size_bytes,
                            state: TransferState::Queued,
                            transferred_bytes: 0,
                            last_progress_at: None,
                        })
                })
                .collect::<Vec<_>>()
        };
        let mut changed = false;
        for offer in offers {
            if !coordinator.contains(&offer.id) {
                coordinator.offer(offer)?;
                changed = true;
            }
        }
        Ok(changed)
    }

    fn operation_transfer(&self, profile_id: &str, operation_id: &str) -> Option<StoreSpec> {
        let inner = self.inner.lock().ok()?;
        inner
            .transfers
            .values()
            .filter_map(|transfer| transfer.storage.as_ref())
            .find(|stored| {
                stored.spec.profile_id == profile_id
                    && stored.spec.operation_id.as_deref() == Some(operation_id)
            })
            .map(|stored| stored.spec.clone())
    }

    fn storage_spec(&self, id: &str) -> Option<StoreSpec> {
        self.inner
            .lock()
            .ok()?
            .transfers
            .get(id)?
            .storage
            .as_ref()
            .map(|stored| stored.spec.clone())
    }

    #[cfg(test)]
    fn routing(&self, id: &str) -> Result<WebTransferRouting, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
        Ok(WebTransferRouting {
            id: id.to_string(),
            profile_id: transfer.profile_id.clone(),
            friend_number: transfer.friend_number,
            file_number: transfer.file_number.unwrap_or(u32::MAX),
            outgoing: transfer.outgoing,
        })
    }

    fn terminal_reconciled(&self, id: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| {
                inner
                    .transfers
                    .get(id)
                    .map(|transfer| transfer.terminal_reconciled)
            })
            .unwrap_or(false)
    }

    fn failed_native_control(&self, id: &str) -> Option<(WebTransferRouting, i32)> {
        let inner = self.inner.lock().ok()?;
        let transfer = inner.transfers.get(id)?;
        if transfer.state != "failed" || transfer.terminal_reconciled {
            return None;
        }
        Some((
            WebTransferRouting {
                id: id.to_string(),
                profile_id: transfer.profile_id.clone(),
                friend_number: transfer.friend_number,
                file_number: transfer.file_number?,
                outgoing: transfer.outgoing,
            },
            2,
        ))
    }

    fn forget_profile(&self, profile_id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let removed = inner
            .transfers
            .values()
            .filter(|transfer| transfer.profile_id == profile_id)
            .map(|transfer| (transfer.id.clone(), transfer_buffered_bytes(transfer)))
            .collect::<Vec<_>>();
        for (id, buffered) in removed {
            inner.transfers.remove(&id);
            inner.queue.retain(|queued| queued != &id);
            inner.buffered_bytes = inner.buffered_bytes.saturating_sub(buffered);
            if inner.active_id.as_deref() == Some(id.as_str()) {
                inner.active_id = None;
            }
        }
        // Pending worker results own their own Arc, so a late read from the old
        // native generation cannot overwrite a new probe after profile unlock.
        self.history_probes
            .lock()
            .map_err(|_| "TRANSFER_HISTORY_UNAVAILABLE")?
            .clear();
        Ok(())
    }

    fn restore_storage(
        &self,
        status: StoreObjectStatus,
        friend_number: u32,
        sent_complete: bool,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        if let Some(existing) = inner.transfers.get(&status.spec.object_id) {
            return if existing
                .storage
                .as_ref()
                .is_some_and(|stored| stored.spec == status.spec)
            {
                Ok(())
            } else {
                Err("TRANSFER_STORAGE_CONFLICT".to_string())
            };
        }
        let spec = &status.spec;
        if spec.size_bytes == 0
            || spec.size_bytes > crate::MAX_CHAT_FILE_BYTES
            || status.durable_bytes > spec.size_bytes
            || (status.native_delivery_confirmed.is_some()
                && spec.direction != StoreDirection::Outgoing)
            || (status.native_delivery_confirmed == Some(true)
                && status.phase != StorePhase::Committed)
            || (status.phase == StorePhase::Committed
                && (status.durable_bytes != spec.size_bytes
                    || status.committed_sha256.is_none()
                    || spec
                        .expected_sha256
                        .is_some_and(|hash| Some(hash) != status.committed_sha256)))
        {
            return Err("TRANSFER_STORAGE_CONFLICT".to_string());
        }
        if inner.transfers.values().any(|transfer| {
            transfer.profile_id == spec.profile_id
                && (transfer.message_id == spec.message_id
                    || (spec.operation_id.is_some()
                        && transfer
                            .storage
                            .as_ref()
                            .is_some_and(|stored| stored.spec.operation_id == spec.operation_id)))
        }) {
            return Err("TRANSFER_STORAGE_CONFLICT".to_string());
        }
        let outgoing = spec.direction == StoreDirection::Outgoing;
        let sent_complete = status.native_delivery_confirmed.unwrap_or(sent_complete);
        // A native file number cannot survive a process restart. A committed
        // outgoing payload is retained, but never silently sent a second time
        // when the old native delivery outcome is unknown.
        let state = match status.phase {
            StorePhase::Removed => "cancelled",
            StorePhase::Committed if !outgoing || sent_complete => "complete",
            StorePhase::Staging if outgoing => "uploading",
            _ => "failed",
        };
        let restored_id = spec.object_id.clone();
        inner.transfers.insert(
            spec.object_id.clone(),
            WebTransfer {
                id: spec.object_id.clone(),
                message_id: spec.message_id.clone(),
                profile_id: spec.profile_id.clone(),
                friend_number,
                file_number: None,
                outgoing,
                name: spec.name.clone(),
                mime: spec.mime.clone(),
                size_bytes: spec.size_bytes,
                transferred_bytes: if state == "complete" {
                    spec.size_bytes
                } else if outgoing {
                    0
                } else {
                    status.durable_bytes
                },
                acknowledged_bytes: if outgoing { 0 } else { status.durable_bytes },
                meter_at_ms: None,
                meter_bytes: 0,
                speed_bytes_per_sec: 0,
                state: state.to_string(),
                locally_paused: false,
                incoming_accepted: false,
                requested_position: None,
                requested_length: None,
                requested_through: 0,
                native_chunk_bytes: None,
                outgoing_chunks: VecDeque::new(),
                incoming_chunks: VecDeque::new(),
                incoming_remote_complete: false,
                outgoing_remote_complete: false,
                outgoing_delivery_retry_at: None,
                terminal_reconciled: false,
                storage: Some(status),
                storage_ready: true,
                pending_store_append: None,
            },
        );
        if state == "uploading" {
            inner.queue.push_back(restored_id);
        }
        Ok(())
    }

    // Copies only metadata/Arc handles while locked. All store calls happen
    // after releasing the bridge lock; the store never performs I/O inline.
    fn drive_storage(&self) -> Result<Vec<(String, Option<WebTransferRouting>, u64)>, String> {
        let Some(store) = self.store.get() else {
            return Ok(Vec::new());
        };
        if !store.is_ready() {
            return Ok(Vec::new());
        }
        let published = store.snapshot();
        let mut progress = Vec::new();
        for status in published {
            let (incoming, through, previous, should_ack, newly_committed, newly_delivered) = {
                let mut inner = self
                    .inner
                    .lock()
                    .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
                let Some(transfer) = inner.transfers.get_mut(&status.spec.object_id) else {
                    continue;
                };
                let Some(old) = &transfer.storage else {
                    continue;
                };
                if old.spec != status.spec
                    || (old.native_delivery_confirmed == Some(true)
                        && status.native_delivery_confirmed != Some(true)
                        && status.phase != StorePhase::Removed)
                    || (status.phase != StorePhase::Removed
                        && status.durable_bytes < old.durable_bytes)
                    || status.durable_bytes > transfer.size_bytes
                {
                    return Err("TRANSFER_STORAGE_CONFLICT".to_string());
                }
                if status.phase == StorePhase::Committed
                    && (status.durable_bytes != transfer.size_bytes
                        || status.committed_sha256.is_none()
                        || status
                            .spec
                            .expected_sha256
                            .is_some_and(|hash| Some(hash) != status.committed_sha256))
                {
                    return Err("TRANSFER_HASH_MISMATCH".to_string());
                }
                let previous = old.durable_bytes;
                let newly_committed =
                    old.phase != StorePhase::Committed && status.phase == StorePhase::Committed;
                let newly_delivered = old.native_delivery_confirmed != Some(true)
                    && status.native_delivery_confirmed == Some(true);
                if (status.native_delivery_confirmed.is_some() && !transfer.outgoing)
                    || (status.native_delivery_confirmed == Some(true)
                        && status.phase != StorePhase::Committed)
                {
                    return Err("TRANSFER_STORAGE_CONFLICT".to_string());
                }
                transfer.storage_ready = true;
                transfer.storage = Some(status.clone());
                if transfer.outgoing
                    && status.native_delivery_confirmed == Some(true)
                    && !matches!(transfer.state.as_str(), "cancelled" | "failed")
                {
                    transfer.state = "complete".to_string();
                    transfer.transferred_bytes = transfer.size_bytes;
                    transfer.speed_bytes_per_sec = 0;
                }
                if transfer
                    .pending_store_append
                    .as_ref()
                    .is_some_and(|(offset, bytes)| {
                        offset.saturating_add(bytes.len() as u64) <= status.durable_bytes
                    })
                {
                    transfer.pending_store_append = None;
                }
                let incoming = !transfer.outgoing;
                let live = !matches!(transfer.state.as_str(), "cancelled" | "failed");
                let should_ack =
                    incoming && live && status.durable_bytes > transfer.acknowledged_bytes;
                if transfer.outgoing
                    && transfer.state == "uploading"
                    && status.phase == StorePhase::Committed
                {
                    transfer.state = "queued".to_string();
                    if !inner.queue.contains(&status.spec.object_id) {
                        inner.queue.push_back(status.spec.object_id.clone());
                    }
                }
                (
                    incoming,
                    status.durable_bytes,
                    previous,
                    should_ack,
                    newly_committed,
                    newly_delivered,
                )
            };
            let mut resume = None;
            let mut released = 0;
            if should_ack {
                (resume, released) =
                    self.acknowledge_incoming_chunk(&status.spec.object_id, through)?;
            }
            if incoming && status.phase == StorePhase::Committed {
                let mut inner = self
                    .inner
                    .lock()
                    .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
                if let Some(transfer) = inner.transfers.get_mut(&status.spec.object_id) {
                    if !matches!(
                        transfer.state.as_str(),
                        "cancelled" | "failed" | "offered" | "paused"
                    ) {
                        transfer.state = "complete".to_string();
                    }
                }
            }
            if through != previous || newly_committed || newly_delivered {
                progress.push((status.spec.object_id, resume, released));
            }
        }
        let work = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
            inner
                .transfers
                .values_mut()
                .filter_map(|transfer| {
                    let stored = transfer.storage.as_ref()?.clone();
                    let operation = if transfer.state == "failed" {
                        None
                    } else if transfer.state == "cancelled" {
                        (stored.phase != StorePhase::Removed).then(|| StoreOperation::Remove {
                            object_id: transfer.id.clone(),
                        })
                    } else if !transfer.storage_ready {
                        Some(StoreOperation::Begin(stored.spec.clone()))
                    } else if stored.phase == StorePhase::Staging
                        && stored.durable_bytes == transfer.size_bytes
                    {
                        Some(StoreOperation::Finalize {
                            object_id: transfer.id.clone(),
                        })
                    } else if transfer.outgoing
                        && transfer.outgoing_remote_complete
                        && stored.phase == StorePhase::Committed
                        && stored.native_delivery_confirmed != Some(true)
                        && transfer
                            .outgoing_delivery_retry_at
                            .is_none_or(|at| Instant::now() >= at)
                    {
                        Some(StoreOperation::MarkDelivered {
                            object_id: transfer.id.clone(),
                        })
                    } else if !transfer.outgoing && transfer.state != "offered" {
                        let buffered = transfer_buffered_bytes(transfer);
                        let flush_tail = transfer.transferred_bytes == transfer.size_bytes
                            || transfer.incoming_remote_complete
                            || transfer.state == "paused";
                        if transfer.pending_store_append.is_none()
                            && (buffered >= FRAME_STREAM_CHUNK_BYTES as u64 || flush_tail)
                        {
                            transfer.pending_store_append =
                                transfer.incoming_chunks.front().map(|(offset, _)| {
                                    let mut bytes = Vec::new();
                                    for (_, chunk) in &transfer.incoming_chunks {
                                        if bytes.len() + chunk.len() > FRAME_STREAM_CHUNK_BYTES {
                                            break;
                                        }
                                        bytes.extend_from_slice(chunk);
                                    }
                                    (*offset, Arc::from(bytes))
                                });
                        }
                        transfer
                            .pending_store_append
                            .as_ref()
                            .map(|(offset, bytes)| StoreOperation::Append {
                                object_id: transfer.id.clone(),
                                offset: *offset,
                                bytes: Arc::clone(bytes),
                            })
                    } else if transfer.outgoing
                        && stored.phase == StorePhase::Committed
                        && transfer.state == "sending"
                        && transfer.outgoing_chunks.is_empty()
                    {
                        transfer
                            .requested_length
                            .filter(|length| *length > 0)
                            .map(|length| StoreOperation::ReadRange {
                                object_id: transfer.id.clone(),
                                offset: transfer.transferred_bytes,
                                length,
                            })
                    } else {
                        None
                    };
                    operation.map(|operation| (transfer.id.clone(), operation))
                })
                .collect::<Vec<_>>()
        };
        for (id, operation) in work {
            let delivery_receipt = matches!(operation, StoreOperation::MarkDelivered { .. });
            match self.storage_operation(operation) {
                Ok(Some(StoreReply::Range { offset, bytes, .. })) => {
                    // Native demand can change while a bounded read is pending.
                    // The stale reply is harmless; request the current range next tick.
                    if let Err(error) = self.stage_outgoing_upload(&id, offset, &bytes) {
                        if !matches!(
                            error.as_str(),
                            "TRANSFER_CHUNK_STALE" | "TRANSFER_CHUNK_NOT_REQUESTED"
                        ) {
                            return Err(error);
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let mut inner = self
                        .inner
                        .lock()
                        .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
                    if let Some(transfer) = inner.transfers.get_mut(&id) {
                        if delivery_receipt
                            && matches!(
                                error.as_str(),
                                "TRANSFER_STORAGE_UNAVAILABLE" | "WORKSPACE_QUOTA_FULL"
                            )
                        {
                            // An uncertain metadata write can be retried safely.
                            // Keep ownership and the native ACK without busy polling.
                            transfer.outgoing_delivery_retry_at =
                                Some(Instant::now() + Duration::from_secs(1));
                            continue;
                        }
                        transfer.state = "failed".to_string();
                        transfer.terminal_reconciled = false;
                    }
                    return Err(error);
                }
            }
        }
        Ok(progress)
    }

    fn background_entries(
        &self,
        profiles: &HashMap<String, Arc<ToxState>>,
    ) -> Result<Vec<BackgroundTransferWorkEntry>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?;
        let mut entries = inner
            .transfers
            .values()
            .filter_map(|transfer| {
                let profile = profiles.get(&transfer.profile_id)?;
                let settings = profile.file_receive_settings.lock().ok()?.clone();
                Some(BackgroundTransferWorkEntry::from_transfer(
                    transfer, &settings,
                ))
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            left.profile_id
                .cmp(&right.profile_id)
                .then_with(|| left.transfer_id.cmp(&right.transfer_id))
        });
        Ok(entries)
    }

    pub(crate) fn enqueue_outgoing(
        &self,
        profile_id: &str,
        friend_number: u32,
        message_id: String,
        name: String,
        mime: String,
        size_bytes: u64,
    ) -> Result<String, String> {
        if size_bytes == 0 {
            return Err("TRANSFER_EMPTY_FILE".to_string());
        }
        if size_bytes > crate::MAX_CHAT_FILE_BYTES {
            return Err("TRANSFER_FILE_TOO_LARGE".to_string());
        }
        let id = URL_SAFE_NO_PAD.encode(random_array::<24>()?);
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let outstanding = inner
            .transfers
            .values()
            .filter(|transfer| {
                transfer.outgoing
                    && !matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed")
            })
            .count();
        if outstanding >= crate::MAX_CHAT_FILE_QUEUE {
            return Err("TRANSFER_QUEUE_LIMIT".to_string());
        }
        inner.queue.push_back(id.clone());
        inner.transfers.insert(
            id.clone(),
            WebTransfer {
                id: id.clone(),
                message_id,
                profile_id: profile_id.to_string(),
                friend_number,
                file_number: None,
                outgoing: true,
                name,
                mime,
                size_bytes,
                transferred_bytes: 0,
                acknowledged_bytes: 0,
                meter_at_ms: None,
                meter_bytes: 0,
                speed_bytes_per_sec: 0,
                state: "queued".to_string(),
                locally_paused: false,
                incoming_accepted: false,
                requested_position: None,
                requested_length: None,
                requested_through: 0,
                native_chunk_bytes: None,
                outgoing_chunks: VecDeque::new(),
                incoming_chunks: VecDeque::new(),
                incoming_remote_complete: false,
                outgoing_remote_complete: false,
                outgoing_delivery_retry_at: None,
                terminal_reconciled: false,
                storage: None,
                storage_ready: false,
                pending_store_append: None,
            },
        );
        Ok(id)
    }

    pub(crate) fn offer_incoming(
        &self,
        profile_id: &str,
        friend_number: u32,
        file_number: u32,
        message_id: String,
        name: String,
        mime: String,
        size_bytes: u64,
    ) -> Result<String, String> {
        let id = URL_SAFE_NO_PAD.encode(random_array::<24>()?);
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        if let Some(existing) = inner
            .transfers
            .values()
            .find(|transfer| transfer.profile_id == profile_id && transfer.message_id == message_id)
        {
            if !existing.outgoing
                && existing.friend_number == friend_number
                && existing.file_number == Some(file_number)
                && existing.name == name
                && existing.mime == mime
                && existing.size_bytes == size_bytes
            {
                return Ok(existing.id.clone());
            }
            return Err("TRANSFER_ALREADY_BOUND".to_string());
        }
        inner.transfers.insert(
            id.clone(),
            WebTransfer {
                id: id.clone(),
                message_id,
                profile_id: profile_id.to_string(),
                friend_number,
                file_number: Some(file_number),
                outgoing: false,
                name,
                mime,
                size_bytes,
                transferred_bytes: 0,
                acknowledged_bytes: 0,
                meter_at_ms: None,
                meter_bytes: 0,
                speed_bytes_per_sec: 0,
                state: "offered".to_string(),
                locally_paused: false,
                incoming_accepted: false,
                requested_position: None,
                requested_length: None,
                requested_through: 0,
                native_chunk_bytes: None,
                outgoing_chunks: VecDeque::new(),
                incoming_chunks: VecDeque::new(),
                incoming_remote_complete: false,
                outgoing_remote_complete: false,
                outgoing_delivery_retry_at: None,
                terminal_reconciled: false,
                storage: None,
                storage_ready: false,
                pending_store_append: None,
            },
        );
        Ok(id)
    }

    pub(crate) fn next_to_start(&self) -> Option<WebTransferRouting> {
        let mut inner = self.inner.lock().ok()?;
        if inner.active_id.is_some() {
            return None;
        }
        while let Some(id) = inner.queue.pop_front() {
            let (profile_id, friend_number, file_number, outgoing) = {
                let Some(transfer) = inner.transfers.get_mut(&id) else {
                    continue;
                };
                if transfer.state == "uploading" {
                    // Fully uploaded later files wait behind this accepted
                    // operation even when their storage commits arrive first.
                    inner.queue.push_front(id);
                    break;
                }
                if transfer.state != "queued" {
                    continue;
                }
                if transfer.storage.is_some()
                    && (!transfer.storage_ready
                        || (transfer.outgoing
                            && !transfer
                                .storage
                                .as_ref()
                                .is_some_and(|stored| stored.phase == StorePhase::Committed)))
                {
                    inner.queue.push_front(id);
                    break;
                }
                transfer.state = if transfer.outgoing && transfer.file_number.is_none() {
                    "starting"
                } else if transfer.outgoing {
                    "sending"
                } else {
                    "receiving"
                }
                .to_string();
                refresh_outgoing_request(transfer);
                (
                    transfer.profile_id.clone(),
                    transfer.friend_number,
                    transfer.file_number.unwrap_or(u32::MAX),
                    transfer.outgoing,
                )
            };
            inner.active_id = Some(id.clone());
            return Some(WebTransferRouting {
                id,
                profile_id,
                friend_number,
                file_number,
                outgoing,
            });
        }
        None
    }

    pub(crate) fn outgoing_metadata(&self, id: &str) -> Option<(String, String, u64, String)> {
        let inner = self.inner.lock().ok()?;
        let transfer = inner.transfers.get(id)?;
        Some((
            transfer.name.clone(),
            transfer.mime.clone(),
            transfer.size_bytes,
            transfer.message_id.clone(),
        ))
    }

    pub(crate) fn outgoing_profile_id(&self, id: &str) -> Result<String, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
        if !transfer.outgoing {
            return Err("TRANSFER_DIRECTION_INVALID".to_string());
        }
        Ok(transfer.profile_id.clone())
    }

    pub(crate) fn outgoing_started(&self, id: &str, file_number: u32) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        if transfer.state != "starting" || !transfer.outgoing {
            return Err("TRANSFER_STATE_INVALID".to_string());
        }
        transfer.file_number = Some(file_number);
        transfer.state = "sending".to_string();
        refresh_outgoing_request(transfer);
        Ok(())
    }

    pub(crate) fn outgoing_start_failed(&self, id: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if let Some(transfer) = inner.transfers.get_mut(id) {
            transfer.state = "queued".to_string();
            transfer.file_number = None;
            transfer.transferred_bytes = 0;
            transfer.requested_through = 0;
            transfer.native_chunk_bytes = None;
            refresh_outgoing_request(transfer);
            inner.queue.push_front(id.to_string());
        }
        if inner.active_id.as_deref() == Some(id) {
            inner.active_id = None;
        }
    }

    pub(crate) fn scheduled_start_failed(&self, id: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if let Some(transfer) = inner.transfers.get_mut(id) {
            transfer.state = "queued".to_string();
            refresh_outgoing_request(transfer);
            if !inner.queue.iter().any(|queued| queued == id) {
                inner.queue.push_front(id.to_string());
            }
        }
        if inner.active_id.as_deref() == Some(id) {
            inner.active_id = None;
        }
    }

    pub(crate) fn on_outgoing_request(&self, id: &str, position: u64, length: usize) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let is_active = inner.active_id.as_deref() == Some(id);
        let released = {
            let Some(transfer) = inner.transfers.get_mut(id) else {
                return false;
            };
            if !transfer.outgoing {
                return false;
            }
            if matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed") {
                return false;
            }
            if transfer.outgoing_remote_complete {
                return true;
            }
            if length > 0 && (transfer.locally_paused || !is_active) {
                // An already queued native callback cannot undo a local pause
                // or make this transfer overtake the workspace's current slot.
                return true;
            }
            if length == 0 {
                let released = outgoing_buffered_bytes(transfer);
                transfer.outgoing_chunks.clear();
                let valid_completion = position == transfer.size_bytes
                    && transfer.transferred_bytes == transfer.size_bytes;
                transfer.requested_through = transfer.size_bytes;
                transfer.requested_position = None;
                transfer.requested_length = None;
                if self.uses_durable_storage() {
                    // The native ACK is not a durable delivery receipt yet. The
                    // existing store worker seals it before complete becomes public.
                    transfer.outgoing_remote_complete = valid_completion;
                    transfer.state = if valid_completion {
                        "sending"
                    } else {
                        "failed"
                    }
                    .to_string();
                    transfer.speed_bytes_per_sec = 0;
                } else {
                    transfer.transferred_bytes = transfer.size_bytes;
                    transfer.state = "complete".to_string();
                }
                released
            } else if length <= FRAME_STREAM_CHUNK_BYTES
                && position <= transfer.size_bytes
                && position.saturating_add(length as u64) <= transfer.size_bytes
            {
                transfer.native_chunk_bytes =
                    Some(transfer.native_chunk_bytes.unwrap_or(0).max(length));
                transfer.requested_through = transfer
                    .requested_through
                    .max(position.saturating_add(length as u64));
                transfer.state = "sending".to_string();
                refresh_outgoing_request(transfer);
                0
            } else {
                let released = outgoing_buffered_bytes(transfer);
                transfer.outgoing_chunks.clear();
                transfer.state = "failed".to_string();
                refresh_outgoing_request(transfer);
                released
            }
        };
        inner.buffered_bytes = inner.buffered_bytes.saturating_sub(released);
        true
    }

    pub(crate) fn stage_outgoing_upload(
        &self,
        id: &str,
        position: u64,
        data: &[u8],
    ) -> Result<WebTransferRouting, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let bytes = data.len();
        let (routing, next_buffered) = {
            let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
            let native_chunk_bytes = transfer
                .native_chunk_bytes
                .ok_or("TRANSFER_CHUNK_NOT_REQUESTED")?;
            let upload_end = position.saturating_add(bytes as u64);
            let ends_at_file = upload_end == transfer.size_bytes;
            if transfer.state != "sending"
                || transfer.requested_position != Some(position)
                || transfer
                    .requested_length
                    .is_none_or(|length| bytes > length)
                || bytes == 0
                || bytes > FRAME_STREAM_CHUNK_BYTES
                || (bytes % native_chunk_bytes != 0 && !ends_at_file)
            {
                return Err("TRANSFER_CHUNK_STALE".to_string());
            }
            let routing = WebTransferRouting {
                id: id.to_string(),
                profile_id: transfer.profile_id.clone(),
                friend_number: transfer.friend_number,
                file_number: transfer.file_number.ok_or("TRANSFER_NOT_STARTED")?,
                outgoing: true,
            };
            let next_buffered = inner.buffered_bytes.saturating_add(bytes as u64);
            if next_buffered > TRANSFER_BUFFER_LIMIT_BYTES {
                return Err("TRANSFER_BUFFER_OVERFLOW".to_string());
            }
            (routing, next_buffered)
        };
        {
            let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
            transfer.outgoing_chunks.push_back(BufferedOutgoingChunk {
                position,
                data: Arc::from(data),
                consumed: 0,
            });
            refresh_outgoing_request(transfer);
        }
        inner.buffered_bytes = next_buffered;
        Ok(routing)
    }

    pub(crate) fn next_outgoing_chunk(
        &self,
        id: &str,
        now_ms: u64,
    ) -> Result<(Option<WebOutgoingChunk>, u64), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        refill_tokens(&mut inner, now_ms);
        let available = inner.token_bytes;
        let (routing, position, data, required) = {
            let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
            if !transfer.outgoing || transfer.state != "sending" {
                return Ok((None, 0));
            }
            let Some(front) = transfer.outgoing_chunks.front() else {
                return Ok((None, 0));
            };
            let native_chunk_bytes = transfer
                .native_chunk_bytes
                .ok_or("TRANSFER_CHUNK_NOT_REQUESTED")?;
            let position = front.position.saturating_add(front.consumed as u64);
            if position != transfer.transferred_bytes || front.consumed >= front.data.len() {
                return Err("TRANSFER_CHUNK_STALE".to_string());
            }
            let required = native_chunk_bytes.min(front.data.len() - front.consumed);
            let data = front.data[front.consumed..front.consumed + required].to_vec();
            (
                WebTransferRouting {
                    id: id.to_string(),
                    profile_id: transfer.profile_id.clone(),
                    friend_number: transfer.friend_number,
                    file_number: transfer.file_number.ok_or("TRANSFER_NOT_STARTED")?,
                    outgoing: true,
                },
                position,
                data,
                required,
            )
        };
        if available < required as u64 {
            let missing = required as u64 - available;
            return Ok((
                None,
                missing
                    .saturating_mul(1000)
                    .div_ceil(TRANSFER_RATE_BYTES_PER_SECOND),
            ));
        }
        inner.token_bytes -= required as u64;
        Ok((
            Some(WebOutgoingChunk {
                routing,
                position,
                data,
            }),
            0,
        ))
    }

    pub(crate) fn outgoing_chunk_rejected(&self, bytes: usize) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.token_bytes = inner
            .token_bytes
            .saturating_add(bytes as u64)
            .min(TRANSFER_RATE_BYTES_PER_SECOND);
    }

    pub(crate) fn outgoing_chunk_sent(
        &self,
        id: &str,
        position: u64,
        bytes: usize,
        now_ms: u64,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        {
            let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
            let end = position.saturating_add(bytes as u64);
            let Some(front) = transfer.outgoing_chunks.front_mut() else {
                return Err("TRANSFER_CHUNK_STALE".to_string());
            };
            let front_position = front.position.saturating_add(front.consumed as u64);
            if position != transfer.transferred_bytes
                || position != front_position
                || bytes == 0
                || front.consumed.saturating_add(bytes) > front.data.len()
                || end > transfer.requested_through
                || end > transfer.size_bytes
            {
                return Err("TRANSFER_CHUNK_STALE".to_string());
            }
            front.consumed += bytes;
            if front.consumed == front.data.len() {
                transfer.outgoing_chunks.pop_front();
            }
            transfer.transferred_bytes = end;
            record_transfer_speed(transfer, now_ms);
            refresh_outgoing_request(transfer);
        }
        inner.buffered_bytes = inner.buffered_bytes.saturating_sub(bytes as u64);
        Ok(())
    }

    pub(crate) fn incoming_by_native(
        &self,
        profile_id: &str,
        friend_number: u32,
        file_number: u32,
    ) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        inner.transfers.values().find_map(|transfer| {
            (!transfer.outgoing
                && (matches!(transfer.state.as_str(), "receiving" | "backpressure")
                    || (transfer.state == "paused" && transfer.incoming_accepted))
                && transfer.profile_id == profile_id
                && transfer.friend_number == friend_number
                && transfer.file_number == Some(file_number))
            .then(|| transfer.id.clone())
        })
    }

    pub(crate) fn incoming_terminal_by_native(
        &self,
        profile_id: &str,
        friend_number: u32,
        file_number: u32,
    ) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        let active = inner.active_id.as_deref()?;
        let transfer = inner.transfers.get(active)?;
        (!transfer.outgoing
            && transfer.profile_id == profile_id
            && transfer.friend_number == friend_number
            && transfer.file_number == Some(file_number)
            && !matches!(transfer.state.as_str(), "cancelled" | "failed"))
        .then(|| transfer.id.clone())
    }

    pub(crate) fn push_incoming_chunk(
        &self,
        id: &str,
        position: u64,
        data: &[u8],
    ) -> Result<bool, String> {
        self.push_incoming_chunk_at(id, position, data, transfer_clock_ms())
    }

    fn push_incoming_chunk_at(
        &self,
        id: &str,
        position: u64,
        data: &[u8],
        now_ms: u64,
    ) -> Result<bool, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        if data.is_empty() || data.len() > FRAME_STREAM_CHUNK_BYTES {
            return Err("TRANSFER_CHUNK_INVALID".to_string());
        }
        let (outgoing, state, incoming_accepted, transferred_bytes, size_bytes) = {
            let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
            (
                transfer.outgoing,
                transfer.state.clone(),
                transfer.incoming_accepted,
                transfer.transferred_bytes,
                transfer.size_bytes,
            )
        };
        if outgoing
            || !(matches!(state.as_str(), "receiving" | "backpressure")
                || (state == "paused" && incoming_accepted))
        {
            return Err("TRANSFER_NOT_ACTIVE".to_string());
        }
        let Some(end) = position.checked_add(data.len() as u64) else {
            fail_incoming_transfer(&mut inner, id);
            return Err("TRANSFER_CHUNK_RANGE_INVALID".to_string());
        };
        if end > size_bytes {
            fail_incoming_transfer(&mut inner, id);
            return Err("TRANSFER_CHUNK_RANGE_INVALID".to_string());
        }
        if position > transferred_bytes {
            fail_incoming_transfer(&mut inner, id);
            return Err("TRANSFER_CHUNK_GAP".to_string());
        }
        if end <= transferred_bytes {
            return Ok(state == "receiving");
        }
        let overlap = usize::try_from(transferred_bytes.saturating_sub(position))
            .map_err(|_| "TRANSFER_CHUNK_RANGE_INVALID".to_string())?;
        let fresh = &data[overlap..];
        let next_buffered = inner.buffered_bytes.saturating_add(fresh.len() as u64);
        if next_buffered > TRANSFER_BUFFER_LIMIT_BYTES {
            fail_incoming_transfer(&mut inner, id);
            return Err("TRANSFER_BUFFER_OVERFLOW".to_string());
        }
        let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        transfer
            .incoming_chunks
            .push_back((transferred_bytes, Arc::from(fresh)));
        transfer.transferred_bytes = end;
        record_transfer_speed(transfer, now_ms);
        inner.buffered_bytes = next_buffered;
        // Pause well before the hard ceiling so the chunk currently being
        // delivered is always retained. This avoids a corrupt gap while still
        // keeping aggregate workspace buffering strictly below 25 MiB.
        let keep_running = state != "paused"
            && next_buffered
                < TRANSFER_BUFFER_LIMIT_BYTES.saturating_sub(FRAME_STREAM_CHUNK_BYTES as u64);
        if !keep_running && state != "paused" {
            if let Some(transfer) = inner.transfers.get_mut(id) {
                transfer.state = "backpressure".to_string();
            }
        }
        Ok(keep_running)
    }

    pub(crate) fn incoming_remote_complete(&self, id: &str) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let mut buffered_removed = 0_u64;
        if let Some(transfer) = inner.transfers.get_mut(id) {
            transfer.incoming_remote_complete = true;
            if transfer.transferred_bytes != transfer.size_bytes {
                buffered_removed = transfer
                    .incoming_chunks
                    .iter()
                    .map(|(_, bytes)| bytes.len() as u64)
                    .sum();
                transfer.incoming_chunks.clear();
                transfer.state = "failed".to_string();
            }
        }
        inner.buffered_bytes = inner.buffered_bytes.saturating_sub(buffered_removed);
        // Both successful and failed remote completion keep ownership of the
        // executable slot until WorkspaceDomain and the card are finalized.
        false
    }

    pub(crate) fn take_incoming_chunk(&self, id: &str) -> Result<Option<(u64, Vec<u8>)>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
        if transfer.outgoing {
            return Err("TRANSFER_DIRECTION_INVALID".to_string());
        }
        let Some((start, _)) = transfer.incoming_chunks.front() else {
            return Ok(None);
        };
        let start = *start;
        let mut expected = start;
        let mut data = Vec::new();
        for (position, bytes) in &transfer.incoming_chunks {
            if *position != expected
                || data.len().saturating_add(bytes.len()) > FRAME_STREAM_CHUNK_BYTES
            {
                break;
            }
            data.extend_from_slice(bytes);
            expected = expected.saturating_add(bytes.len() as u64);
        }
        Ok(Some((start, data)))
    }

    pub(crate) fn acknowledge_incoming_chunk(
        &self,
        id: &str,
        through: u64,
    ) -> Result<(Option<WebTransferRouting>, u64), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let (released, should_resume) = {
            let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
            if transfer.outgoing {
                return Err("TRANSFER_DIRECTION_INVALID".to_string());
            }
            if through < transfer.acknowledged_bytes || through > transfer.transferred_bytes {
                return Err("TRANSFER_ACK_RANGE_INVALID".to_string());
            }
            let mut released = 0_u64;
            while let Some((position, bytes)) = transfer.incoming_chunks.front() {
                let end = position.saturating_add(bytes.len() as u64);
                if end > through {
                    break;
                }
                released = released.saturating_add(bytes.len() as u64);
                transfer.incoming_chunks.pop_front();
            }
            if through > transfer.acknowledged_bytes && released == 0 {
                return Err("TRANSFER_ACK_RANGE_INVALID".to_string());
            }
            transfer.acknowledged_bytes = through;
            (released, transfer.state == "backpressure")
        };
        inner.buffered_bytes = inner.buffered_bytes.saturating_sub(released);
        if should_resume && inner.buffered_bytes <= TRANSFER_BUFFER_LIMIT_BYTES / 2 {
            let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
            transfer.state = "receiving".to_string();
            return Ok((
                Some(WebTransferRouting {
                    id: id.to_string(),
                    profile_id: transfer.profile_id.clone(),
                    friend_number: transfer.friend_number,
                    file_number: transfer.file_number.ok_or("TRANSFER_NOT_STARTED")?,
                    outgoing: false,
                }),
                released,
            ));
        }
        Ok((None, released))
    }

    pub(crate) fn confirm_incoming_complete(&self, id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let transfer = inner.transfers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        if transfer.outgoing {
            return Err("TRANSFER_DIRECTION_INVALID".to_string());
        }
        // Receiving and acknowledging every byte is the browser-side commit
        // point. Tox may deliver its trailing zero-length callback before or
        // after this HTTP confirmation (and a temporary browser pause can
        // delay it), so waiting for that advisory callback can strand a valid
        // file forever at 100 percent.
        if transfer.transferred_bytes != transfer.size_bytes
            || transfer.acknowledged_bytes != transfer.size_bytes
            || !transfer.incoming_chunks.is_empty()
        {
            return Err("TRANSFER_BROWSER_NOT_COMPLETE".to_string());
        }
        transfer.state = "complete".to_string();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn control(
        &self,
        message_id: &str,
        action: &str,
    ) -> Result<WebTransferRouting, String> {
        let id = self
            .id_for_message(message_id)
            .ok_or("TRANSFER_NOT_FOUND")?;
        self.control_id(&id, action)
    }

    fn control_id(&self, id: &str, action: &str) -> Result<WebTransferRouting, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let id = id.to_string();
        let is_active = inner.active_id.as_deref() == Some(id.as_str());
        let (profile_id, friend_number, file_number, outgoing, buffered_removed, queue, deactivate) = {
            let transfer = inner.transfers.get_mut(&id).ok_or("TRANSFER_NOT_FOUND")?;
            if transfer.outgoing_remote_complete {
                // The recipient has acknowledged all bytes. Local controls
                // cannot erase that outcome while its receipt is being sealed.
                return Err("TRANSFER_ALREADY_COMPLETE".to_string());
            }
            let file_number = transfer.file_number.unwrap_or(u32::MAX);
            let mut buffered_removed = 0_u64;
            let mut queue = false;
            let deactivate;
            match action {
                "resume" => {
                    if matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed") {
                        return Err("TRANSFER_NOT_RESUMABLE".to_string());
                    }
                    if is_active
                        && matches!(
                            transfer.state.as_str(),
                            "sending" | "receiving" | "starting" | "backpressure"
                        )
                    {
                        return Err("TRANSFER_ALREADY_ACTIVE".to_string());
                    }
                    let uploading = transfer.outgoing
                        && transfer
                            .storage
                            .as_ref()
                            .is_some_and(|stored| stored.phase != StorePhase::Committed);
                    transfer.state = if uploading { "uploading" } else { "queued" }.to_string();
                    transfer.locally_paused = false;
                    transfer.incoming_accepted = !transfer.outgoing;
                    queue = true;
                    deactivate = is_active;
                    transfer.terminal_reconciled = false;
                }
                "pause" => {
                    if matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed") {
                        return Err("TRANSFER_NOT_PAUSABLE".to_string());
                    }
                    transfer.state = "paused".to_string();
                    transfer.locally_paused = true;
                    deactivate = is_active;
                }
                "cancel" => {
                    if transfer.state == "complete" {
                        return Err("TRANSFER_ALREADY_COMPLETE".to_string());
                    }
                    transfer.state = "cancelled".to_string();
                    transfer.terminal_reconciled = false;
                    buffered_removed = transfer_buffered_bytes(transfer);
                    transfer.outgoing_chunks.clear();
                    transfer.incoming_chunks.clear();
                    transfer.pending_store_append = None;
                    deactivate = is_active;
                }
                _ => return Err("TRANSFER_ACTION_INVALID".to_string()),
            }
            refresh_outgoing_request(transfer);
            (
                transfer.profile_id.clone(),
                transfer.friend_number,
                file_number,
                transfer.outgoing,
                buffered_removed,
                queue,
                deactivate,
            )
        };
        inner.buffered_bytes = inner.buffered_bytes.saturating_sub(buffered_removed);
        if action != "resume" || !queue {
            inner.queue.retain(|queued| queued != &id);
        } else if queue && !inner.queue.iter().any(|queued| queued == &id) {
            inner.queue.push_back(id.clone());
        }
        if deactivate {
            inner.active_id = None;
        }
        Ok(WebTransferRouting {
            id,
            profile_id,
            friend_number,
            file_number,
            outgoing,
        })
    }

    pub(crate) fn cancel_incoming_for_policy(
        &self,
        profile_id: &str,
        tox: *mut std::ffi::c_void,
    ) -> Result<bool, String> {
        let ids = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?
            .transfers
            .values()
            .filter(|transfer| {
                transfer.profile_id == profile_id
                    && !transfer.outgoing
                    && !matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed")
            })
            .map(|transfer| transfer.id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            let route = self.control_id(id, "cancel")?;
            if !tox.is_null() && route.file_number != u32::MAX {
                let mut error = 0_i32;
                unsafe {
                    crate::tox_file_control(
                        tox,
                        route.friend_number,
                        route.file_number,
                        2,
                        &mut error,
                    )
                };
            }
        }
        Ok(!ids.is_empty())
    }

    pub(crate) fn on_native_control(
        &self,
        profile_id: &str,
        friend_number: u32,
        file_number: u32,
        control: u32,
    ) -> Option<WebNativeControlUpdate> {
        let mut inner = self.inner.lock().ok()?;
        let active_match = inner.active_id.as_ref().and_then(|id| {
            inner.transfers.get(id).filter(|transfer| {
                transfer.profile_id == profile_id
                    && transfer.friend_number == friend_number
                    && transfer.file_number == Some(file_number)
                    && !matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed")
            })?;
            Some(id.clone())
        });
        let id = active_match.or_else(|| {
            inner.transfers.values().find_map(|transfer| {
                (transfer.profile_id == profile_id
                    && transfer.friend_number == friend_number
                    && transfer.file_number == Some(file_number)
                    && !matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed"))
                .then(|| transfer.id.clone())
            })
        })?;
        let is_active = inner.active_id.as_deref() == Some(id.as_str());
        let (message_id, outgoing, state, buffered_removed) = {
            let transfer = inner.transfers.get_mut(&id)?;
            if transfer.outgoing_remote_complete {
                return None;
            }
            let mut buffered_removed = 0_u64;
            match control {
                0 => {
                    if !transfer.locally_paused && is_active {
                        transfer.state = if transfer.outgoing {
                            "sending"
                        } else {
                            "receiving"
                        }
                        .to_string();
                    }
                }
                1 => {
                    // A peer pause is intentional and continues to own the slot.
                    // Releasing it here would let another native file number overtake
                    // the paused stream before the peer resumes it.
                    transfer.state = "paused".to_string();
                }
                2 => {
                    transfer.state = "cancelled".to_string();
                    buffered_removed = transfer_buffered_bytes(transfer);
                    transfer.outgoing_chunks.clear();
                    transfer.incoming_chunks.clear();
                    transfer.pending_store_append = None;
                }
                _ => return None,
            }
            transfer.speed_bytes_per_sec = 0;
            transfer.meter_at_ms = None;
            refresh_outgoing_request(transfer);
            (
                transfer.message_id.clone(),
                transfer.outgoing,
                transfer.state.clone(),
                buffered_removed,
            )
        };
        inner.buffered_bytes = inner.buffered_bytes.saturating_sub(buffered_removed);
        if control == 2 {
            inner.queue.retain(|queued| queued != &id);
            if is_active {
                // A remote terminal control must keep ownership of the bridge
                // slot until the backend tick has also cancelled the matching
                // WorkspaceDomain entry. Releasing it here lets the next
                // native transfer start against the previous domain slot
                // and fail with NO_ACTIVE_TRANSFER.
                debug_assert_eq!(inner.active_id.as_deref(), Some(id.as_str()));
            }
        }
        Some(WebNativeControlUpdate {
            message_id,
            outgoing,
            state,
        })
    }

    pub(crate) fn pause_active(&self) -> Option<WebTransferRouting> {
        let mut inner = self.inner.lock().ok()?;
        if inner
            .active_id
            .as_ref()
            .and_then(|id| inner.transfers.get(id))
            .is_some_and(|transfer| transfer.outgoing_remote_complete)
        {
            return None;
        }
        let id = inner.active_id.take()?;
        let transfer = inner.transfers.get_mut(&id)?;
        transfer.state = "paused".to_string();
        transfer.locally_paused = true;
        refresh_outgoing_request(transfer);
        Some(WebTransferRouting {
            id,
            profile_id: transfer.profile_id.clone(),
            friend_number: transfer.friend_number,
            file_number: transfer.file_number?,
            outgoing: transfer.outgoing,
        })
    }

    pub(crate) fn view(&self, id: &str, now_ms: u64) -> Result<WebTransferView, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        refill_tokens(&mut inner, now_ms);
        let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
        let next_send_bytes = transfer
            .outgoing_chunks
            .front()
            .and_then(|chunk| {
                transfer.native_chunk_bytes.map(|native| {
                    native.min(chunk.data.len().saturating_sub(chunk.consumed)) as u64
                })
            })
            .unwrap_or(0);
        let retry_after_ms = next_send_bytes
            .saturating_sub(inner.token_bytes)
            .saturating_mul(1000)
            .div_ceil(TRANSFER_RATE_BYTES_PER_SECOND);
        let buffered_bytes = if transfer.outgoing {
            outgoing_buffered_bytes(transfer)
        } else {
            transfer
                .incoming_chunks
                .iter()
                .map(|(_, bytes)| bytes.len() as u64)
                .sum()
        };
        Ok(WebTransferView {
            id: transfer.id.clone(),
            operation_id: transfer
                .storage
                .as_ref()
                .and_then(|stored| stored.spec.operation_id.clone()),
            message_id: transfer.message_id.clone(),
            profile_id: transfer.profile_id.clone(),
            direction: if transfer.outgoing {
                "outgoing"
            } else {
                "incoming"
            },
            name: transfer.name.clone(),
            mime: transfer.mime.clone(),
            size_bytes: transfer.size_bytes,
            transferred_bytes: transfer.transferred_bytes,
            acknowledged_bytes: transfer.acknowledged_bytes,
            speed_bytes_per_sec: transfer.speed_bytes_per_sec,
            eta_seconds: (transfer.speed_bytes_per_sec > 0
                && transfer.transferred_bytes < transfer.size_bytes)
                .then(|| {
                    transfer
                        .size_bytes
                        .saturating_sub(transfer.transferred_bytes)
                        .div_ceil(transfer.speed_bytes_per_sec)
                }),
            state: transfer.state.clone(),
            requested_position: transfer.requested_position,
            requested_length: transfer.requested_length,
            buffered_bytes,
            retry_after_ms,
            uploaded_bytes: transfer
                .storage
                .as_ref()
                .filter(|_| transfer.outgoing)
                .map_or(0, |stored| stored.durable_bytes),
            persisted_bytes: transfer
                .storage
                .as_ref()
                .filter(|_| !transfer.outgoing)
                .map_or(0, |stored| stored.durable_bytes),
            payload_committed: transfer
                .storage
                .as_ref()
                .is_some_and(|stored| stored.phase == StorePhase::Committed),
            payload_sha256: transfer.storage.as_ref().and_then(|stored| {
                stored
                    .committed_sha256
                    .map(|hash| URL_SAFE_NO_PAD.encode(hash))
            }),
            download_available: transfer.state != "cancelled"
                && transfer
                    .storage
                    .as_ref()
                    .is_some_and(|stored| stored.phase == StorePhase::Committed),
        })
    }

    #[cfg(test)]
    pub(crate) fn id_for_message(&self, message_id: &str) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        inner
            .transfers
            .values()
            .find(|transfer| transfer.message_id == message_id)
            .map(|transfer| transfer.id.clone())
    }

    fn id_for_profile_message(&self, profile_id: &str, message_id: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .transfers
            .values()
            .find(|transfer| transfer.profile_id == profile_id && transfer.message_id == message_id)
            .map(|transfer| transfer.id.clone())
    }

    fn unreconciled_terminal_ids(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .transfers
                    .values()
                    .filter(|transfer| {
                        !transfer.terminal_reconciled
                            && matches!(
                                transfer.state.as_str(),
                                "complete" | "cancelled" | "failed"
                            )
                    })
                    .map(|transfer| transfer.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn has_active(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.active_id.is_some())
            .unwrap_or(true)
    }

    pub(crate) fn active_terminal_id(&self) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        let id = inner.active_id.as_ref()?;
        inner
            .transfers
            .get(id)
            .is_some_and(|transfer| {
                matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed")
            })
            .then(|| id.clone())
    }

    #[cfg(test)]
    pub(crate) fn acknowledge_complete(&self, id: &str) -> bool {
        let complete = self
            .inner
            .lock()
            .map(|inner| {
                inner.active_id.as_deref() == Some(id)
                    && inner
                        .transfers
                        .get(id)
                        .is_some_and(|transfer| transfer.state == "complete")
            })
            .unwrap_or(false);
        complete && self.acknowledge_terminal(id)
    }

    pub(crate) fn acknowledge_terminal(&self, id: &str) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let terminal = inner.transfers.get(id).is_some_and(|transfer| {
            matches!(transfer.state.as_str(), "complete" | "cancelled" | "failed")
        });
        if terminal {
            let released = inner
                .transfers
                .get_mut(id)
                .map(|transfer| {
                    let released = transfer_buffered_bytes(transfer);
                    transfer.outgoing_chunks.clear();
                    transfer.incoming_chunks.clear();
                    transfer.pending_store_append = None;
                    transfer.terminal_reconciled = true;
                    released
                })
                .unwrap_or(0);
            inner.buffered_bytes = inner.buffered_bytes.saturating_sub(released);
            if inner.active_id.as_deref() == Some(id) {
                inner.active_id = None;
            }
            inner.queue.retain(|queued| queued != id);
            return true;
        }
        false
    }

    pub(crate) fn progress(&self, id: &str) -> Option<(String, u64, u64)> {
        let inner = self.inner.lock().ok()?;
        let transfer = inner.transfers.get(id)?;
        Some((
            transfer.message_id.clone(),
            transfer.transferred_bytes,
            transfer.size_bytes,
        ))
    }

    pub(crate) fn progress_with_speed(&self, id: &str) -> Option<(String, u64, u64, u64)> {
        let inner = self.inner.lock().ok()?;
        let transfer = inner.transfers.get(id)?;
        Some((
            transfer.message_id.clone(),
            transfer.transferred_bytes,
            transfer.size_bytes,
            transfer.speed_bytes_per_sec,
        ))
    }

    pub(crate) fn active_outgoing_id(&self) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        let id = inner.active_id.as_ref()?;
        inner
            .transfers
            .get(id)
            .is_some_and(|transfer| {
                transfer.outgoing
                    && transfer.state == "sending"
                    && !transfer.outgoing_chunks.is_empty()
            })
            .then(|| id.clone())
    }
}

const FRAME_STREAM_CHUNK_BYTES: usize = 1024 * 1024;

fn outgoing_buffered_bytes(transfer: &WebTransfer) -> u64 {
    transfer
        .outgoing_chunks
        .iter()
        .map(|chunk| chunk.data.len().saturating_sub(chunk.consumed) as u64)
        .sum()
}

fn transfer_buffered_bytes(transfer: &WebTransfer) -> u64 {
    outgoing_buffered_bytes(transfer).saturating_add(
        transfer
            .incoming_chunks
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum(),
    )
}

fn refresh_outgoing_request(transfer: &mut WebTransfer) {
    let buffered_bytes = outgoing_buffered_bytes(transfer);
    let staged_through = transfer.transferred_bytes.saturating_add(buffered_bytes);
    if !transfer.outgoing
        || transfer.state != "sending"
        || staged_through >= transfer.requested_through
    {
        transfer.requested_position = None;
        transfer.requested_length = None;
        return;
    }
    let Some(native_chunk_bytes) = transfer.native_chunk_bytes.filter(|bytes| *bytes > 0) else {
        transfer.requested_position = None;
        transfer.requested_length = None;
        return;
    };
    let available = transfer
        .requested_through
        .saturating_sub(staged_through)
        .min(transfer.size_bytes.saturating_sub(staged_through));
    let buffer_capacity = (FRAME_STREAM_CHUNK_BYTES as u64).saturating_sub(buffered_bytes);
    let mut browser_bytes = available.min(buffer_capacity);
    if available > browser_bytes {
        browser_bytes = browser_bytes
            .saturating_div(native_chunk_bytes as u64)
            .saturating_mul(native_chunk_bytes as u64);
    }
    if browser_bytes == 0 {
        transfer.requested_position = None;
        transfer.requested_length = None;
        return;
    }
    transfer.requested_position = Some(staged_through);
    transfer.requested_length = usize::try_from(browser_bytes).ok();
}

fn record_transfer_speed(transfer: &mut WebTransfer, now_ms: u64) {
    let Some(previous_at) = transfer.meter_at_ms else {
        transfer.meter_at_ms = Some(now_ms);
        transfer.meter_bytes = transfer.transferred_bytes;
        return;
    };
    let elapsed_ms = now_ms.saturating_sub(previous_at);
    if elapsed_ms < 150 {
        return;
    }
    let bytes = transfer
        .transferred_bytes
        .saturating_sub(transfer.meter_bytes);
    transfer.speed_bytes_per_sec = bytes.saturating_mul(1000).div_ceil(elapsed_ms.max(1));
    transfer.meter_at_ms = Some(now_ms);
    transfer.meter_bytes = transfer.transferred_bytes;
}

fn transfer_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn refill_tokens(state: &mut WebFileBridgeState, now_ms: u64) {
    if state.token_updated_at_ms == 0 {
        state.token_updated_at_ms = now_ms;
        return;
    }
    let elapsed = now_ms.saturating_sub(state.token_updated_at_ms);
    let refill = TRANSFER_RATE_BYTES_PER_SECOND
        .saturating_mul(elapsed)
        .saturating_div(1000);
    state.token_bytes = state
        .token_bytes
        .saturating_add(refill)
        .min(TRANSFER_RATE_BYTES_PER_SECOND);
    state.token_updated_at_ms = now_ms;
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut value = [0_u8; N];
    getrandom::fill(&mut value).map_err(|error| format!("Secure random source failed: {error}"))?;
    Ok(value)
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part);
    }
    digest.finalize().into()
}

fn wipe(value: &mut [u8]) {
    for byte in value {
        // Volatile writes make the erasure intent observable to the compiler.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

/// Derives an archive-only key from the user supplied export password.
///
/// The profile KDF is deliberately reused so export passwords receive the
/// same memory-hard treatment as profile passwords.  Domain separation keeps
/// this key unusable as a workspace envelope key.
pub fn derive_export_key(password: &str, salt: &[u8; 32]) -> Result<[u8; 32], String> {
    if password.is_empty() {
        return Err("ARCHIVE_PASSWORD_REQUIRED".to_string());
    }
    let mut base = profiles::derive_password_key(password, salt)
        .map_err(|_| "ARCHIVE_KEY_DERIVATION_FAILED".to_string())?;
    let derived = sha256(&[b"kaigen-web-workspace-export-key-v1", &base, salt]);
    wipe(&mut base);
    Ok(derived)
}

/// Produces a standard password-protected toxencryptsave payload suitable for
/// import by Kaigen and other compatible Tox clients.
pub fn encrypt_tox_profile_export(
    mut savedata: Vec<u8>,
    mut password: String,
) -> Result<Vec<u8>, String> {
    if password.is_empty() {
        wipe(&mut savedata);
        return Err("PROFILE_EXPORT_PASSWORD_REQUIRED".to_string());
    }
    let result = ProfileCipher::new(&password)
        .and_then(|cipher| cipher.encrypt(&savedata))
        .map_err(|_| "PROFILE_EXPORT_ENCRYPTION_FAILED".to_string());
    wipe(&mut savedata);
    unsafe { wipe(password.as_bytes_mut()) };
    password.clear();
    result
}

/// Opens a qTox savedata payload for a web import. Protected sources require
/// their profile password; unprotected sources remain valid import material
/// and are sealed into the destination `.kai` container by the caller.
pub fn decrypt_tox_profile_import(
    mut encrypted: Vec<u8>,
    password: &str,
) -> Result<Vec<u8>, String> {
    if !profiles::is_encrypted(&encrypted) {
        return Ok(encrypted);
    }
    if password.is_empty() {
        wipe(&mut encrypted);
        return Err("PROFILE_PASSWORD_REQUIRED".to_string());
    }
    let result = ProfileCipher::unlock(&encrypted, password)
        .and_then(|cipher| cipher.decrypt(&encrypted))
        .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string());
    wipe(&mut encrypted);
    result
}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkspaceIdentifier(String);

impl fmt::Debug for WorkspaceIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WorkspaceIdentifier([redacted])")
    }
}

impl WorkspaceIdentifier {
    pub fn generate() -> Result<Self, String> {
        // 32 core bytes always provide at least 256 bits.  Zero to nine cover
        // bytes vary the base64url representation from 43 through 55 chars.
        let selector = random_array::<1>()?[0] as usize % 10;
        let mut bytes = vec![0_u8; IDENTIFIER_CORE_BYTES + selector];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("Secure random source failed: {error}"))?;
        Ok(Self(URL_SAFE_NO_PAD.encode(bytes)))
    }

    pub fn expose_once(&self) -> &str {
        &self.0
    }

    pub fn hash(&self) -> [u8; 32] {
        sha256(&[b"kaigen-workspace-identifier-v1", self.0.as_bytes()])
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        if !(43..=55).contains(&value.len()) {
            return Err("WORKSPACE_NOT_FOUND".to_string());
        }
        let decoded = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| "WORKSPACE_NOT_FOUND".to_string())?;
        if !(IDENTIFIER_CORE_BYTES..=IDENTIFIER_CORE_BYTES + 9).contains(&decoded.len()) {
            return Err("WORKSPACE_NOT_FOUND".to_string());
        }
        Ok(Self(value.to_string()))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordEnvelope {
    profile_id: String,
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceVault {
    version: u32,
    workspace_hash: [u8; 32],
    kdf_salt: [u8; 32],
    wrappers: Vec<PasswordEnvelope>,
    /// Kept in the live metadata store and explicitly excluded from backup.
    erasure_secret: Option<[u8; 32]>,
    erased: bool,
    #[serde(skip)]
    unlocked_dek: Option<[u8; 32]>,
}

/// A zeroizing, in-memory view of an already unlocked workspace key. Webd uses
/// it from the native Tox worker to seal the canonical payload generation
/// without borrowing or locking the serializable workspace registry.
pub struct WorkspacePayloadCipher {
    workspace_hash: [u8; 32],
    dek: [u8; 32],
}

impl fmt::Debug for WorkspacePayloadCipher {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspacePayloadCipher")
            .finish_non_exhaustive()
    }
}

impl Drop for WorkspacePayloadCipher {
    fn drop(&mut self) {
        wipe(&mut self.dek);
        wipe(&mut self.workspace_hash);
    }
}

impl WorkspacePayloadCipher {
    pub fn seal(&self, logical_path: &str, plaintext: &[u8]) -> Result<EncryptedBlob, String> {
        seal_workspace_blob(&self.workspace_hash, &self.dek, logical_path, plaintext)
    }

    pub fn open(&self, logical_path: &str, blob: &EncryptedBlob) -> Result<Vec<u8>, String> {
        open_workspace_blob(&self.workspace_hash, &self.dek, logical_path, blob)
    }
}

fn open_workspace_blob(
    workspace_hash: &[u8; 32],
    dek: &[u8; 32],
    logical_path: &str,
    blob: &EncryptedBlob,
) -> Result<Vec<u8>, String> {
    if blob.version != VAULT_VERSION {
        return Err("WORKSPACE_DATA_VERSION_UNSUPPORTED".to_string());
    }
    let aad = blob_aad(workspace_hash, logical_path);
    let cipher = Aes256Gcm::new_from_slice(dek)
        .map_err(|_| "Could not initialize workspace decryption".to_string())?;
    let nonce = Nonce::from(blob.nonce);
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &blob.ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| "WORKSPACE_DATA_UNAVAILABLE".to_string())
}

impl fmt::Debug for WorkspaceVault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceVault")
            .field("version", &self.version)
            .field("wrapper_count", &self.wrappers.len())
            .field("erased", &self.erased)
            .field("unlocked", &self.unlocked_dek.is_some())
            .finish()
    }
}

impl Drop for WorkspaceVault {
    fn drop(&mut self) {
        if let Some(dek) = self.unlocked_dek.as_mut() {
            wipe(dek);
        }
        if let Some(secret) = self.erasure_secret.as_mut() {
            wipe(secret);
        }
        wipe(&mut self.kdf_salt);
        for wrapper in &mut self.wrappers {
            wipe(&mut wrapper.ciphertext);
            wipe(&mut wrapper.nonce);
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedBlob {
    pub version: u32,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

impl WorkspaceVault {
    pub fn create(workspace_hash: [u8; 32], password: &str) -> Result<Self, String> {
        if password.is_empty() {
            return Err("WORKSPACE_PASSWORD_REQUIRED".to_string());
        }
        let kdf_salt = random_array::<32>()?;
        let erasure_secret = random_array::<32>()?;
        let dek = random_array::<32>()?;
        let wrapper = Self::wrap(
            &workspace_hash,
            &kdf_salt,
            &erasure_secret,
            &dek,
            WORKSPACE_ACCESS_SCOPE,
            password,
        )?;
        Ok(Self {
            version: VAULT_VERSION,
            workspace_hash,
            kdf_salt,
            wrappers: vec![wrapper],
            erasure_secret: Some(erasure_secret),
            erased: false,
            unlocked_dek: Some(dek),
        })
    }

    fn wrap(
        workspace_hash: &[u8; 32],
        kdf_salt: &[u8; 32],
        erasure_secret: &[u8; 32],
        dek: &[u8; 32],
        profile_id: &str,
        password: &str,
    ) -> Result<PasswordEnvelope, String> {
        let mut password_key = profiles::derive_password_key(password, kdf_salt)?;
        let wrapper_key = sha256(&[
            b"kaigen-web-wrapper-key-v1",
            &password_key,
            erasure_secret,
            profile_id.as_bytes(),
        ]);
        wipe(&mut password_key);
        let mut plaintext = Vec::with_capacity(64);
        plaintext.extend_from_slice(dek);
        plaintext.extend_from_slice(workspace_hash);
        let nonce = random_array::<12>()?;
        let mut aad = Vec::new();
        aad.extend_from_slice(ENVELOPE_AAD_DOMAIN);
        aad.extend_from_slice(workspace_hash);
        aad.extend_from_slice(profile_id.as_bytes());
        let cipher = Aes256Gcm::new_from_slice(&wrapper_key)
            .map_err(|_| "Could not initialize the workspace envelope".to_string())?;
        let nonce_value = Nonce::from(nonce);
        let ciphertext = cipher
            .encrypt(
                &nonce_value,
                Payload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| "Could not protect the workspace key".to_string())?;
        wipe(&mut plaintext);
        Ok(PasswordEnvelope {
            profile_id: profile_id.to_string(),
            nonce,
            ciphertext,
        })
    }

    pub fn unlock(&mut self, password: &str) -> Result<(), String> {
        if self.erased || password.is_empty() {
            return Err("WORKSPACE_PASSWORD_INVALID".to_string());
        }
        // A workspace has exactly one independent access credential. Older
        // preview vaults used profile ids as workspace wrappers; accepting
        // those here would keep profile passwords capable of unlocking the
        // workspace and violate the current product contract.
        if self.wrappers.len() != 1 || self.wrappers[0].profile_id != WORKSPACE_ACCESS_SCOPE {
            return Err("WORKSPACE_PASSWORD_INVALID".to_string());
        }
        let erasure_secret = self
            .erasure_secret
            .as_ref()
            .ok_or_else(|| "WORKSPACE_PASSWORD_INVALID".to_string())?;
        // Exactly one memory-hard derivation per attempt.  Every bounded
        // wrapper is then checked with a cheap independent AEAD operation.
        let mut password_key = profiles::derive_password_key(password, &self.kdf_salt)
            .map_err(|_| "WORKSPACE_PASSWORD_INVALID".to_string())?;
        let mut match_dek = None;
        for wrapper in &self.wrappers {
            let wrapper_key = sha256(&[
                b"kaigen-web-wrapper-key-v1",
                &password_key,
                erasure_secret,
                wrapper.profile_id.as_bytes(),
            ]);
            let mut aad = Vec::new();
            aad.extend_from_slice(ENVELOPE_AAD_DOMAIN);
            aad.extend_from_slice(&self.workspace_hash);
            aad.extend_from_slice(wrapper.profile_id.as_bytes());
            let nonce = Nonce::from(wrapper.nonce);
            let candidate = Aes256Gcm::new_from_slice(&wrapper_key)
                .ok()
                .and_then(|cipher| {
                    cipher
                        .decrypt(
                            &nonce,
                            Payload {
                                msg: &wrapper.ciphertext,
                                aad: &aad,
                            },
                        )
                        .ok()
                });
            if let Some(mut candidate) = candidate {
                let valid = candidate.len() == 64
                    && candidate[32..].ct_eq(self.workspace_hash.as_slice()).into();
                if valid && match_dek.is_none() {
                    let mut dek = [0_u8; 32];
                    dek.copy_from_slice(&candidate[..32]);
                    match_dek = Some(dek);
                }
                wipe(&mut candidate);
            }
        }
        wipe(&mut password_key);
        let dek = match_dek.ok_or_else(|| "WORKSPACE_PASSWORD_INVALID".to_string())?;
        if let Some(previous) = self.unlocked_dek.as_mut() {
            wipe(previous);
        }
        self.unlocked_dek = Some(dek);
        Ok(())
    }

    pub fn lock(&mut self) {
        if let Some(mut dek) = self.unlocked_dek.take() {
            wipe(&mut dek);
        }
    }

    pub fn add_profile_password(&mut self, profile_id: &str, password: &str) -> Result<(), String> {
        if self
            .wrappers
            .iter()
            .any(|item| item.profile_id == profile_id)
        {
            return Err("PROFILE_ALREADY_EXISTS".to_string());
        }
        let dek = self
            .unlocked_dek
            .as_ref()
            .ok_or_else(|| "WORKSPACE_LOCKED".to_string())?;
        let erasure = self
            .erasure_secret
            .as_ref()
            .ok_or_else(|| "WORKSPACE_ERASED".to_string())?;
        let wrapper = Self::wrap(
            &self.workspace_hash,
            &self.kdf_salt,
            erasure,
            dek,
            profile_id,
            password,
        )?;
        self.wrappers.push(wrapper);
        Ok(())
    }

    pub fn change_profile_password(
        &mut self,
        profile_id: &str,
        old_password: &str,
        new_password: &str,
    ) -> Result<(), String> {
        let position = self
            .wrappers
            .iter()
            .position(|item| item.profile_id == profile_id)
            .ok_or_else(|| "PROFILE_NOT_FOUND".to_string())?;
        let mut password_key = profiles::derive_password_key(old_password, &self.kdf_salt)
            .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?;
        let erasure = self.erasure_secret.as_ref().ok_or("WORKSPACE_ERASED")?;
        let wrapper = &self.wrappers[position];
        let wrapper_key = sha256(&[
            b"kaigen-web-wrapper-key-v1",
            &password_key,
            erasure,
            profile_id.as_bytes(),
        ]);
        wipe(&mut password_key);
        let mut aad = Vec::new();
        aad.extend_from_slice(ENVELOPE_AAD_DOMAIN);
        aad.extend_from_slice(&self.workspace_hash);
        aad.extend_from_slice(profile_id.as_bytes());
        let nonce = Nonce::from(wrapper.nonce);
        let mut plaintext = Aes256Gcm::new_from_slice(&wrapper_key)
            .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?
            .decrypt(
                &nonce,
                Payload {
                    msg: &wrapper.ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?;
        if plaintext.len() != 64
            || !bool::from(plaintext[32..].ct_eq(self.workspace_hash.as_slice()))
        {
            wipe(&mut plaintext);
            return Err("PROFILE_PASSWORD_INVALID".to_string());
        }
        let mut verified_dek = [0_u8; 32];
        verified_dek.copy_from_slice(&plaintext[..32]);
        wipe(&mut plaintext);
        if let Some(previous) = self.unlocked_dek.as_mut() {
            wipe(previous);
        }
        self.unlocked_dek = Some(verified_dek);
        let dek = self.unlocked_dek.as_ref().ok_or("WORKSPACE_LOCKED")?;
        let erasure = self.erasure_secret.as_ref().ok_or("WORKSPACE_ERASED")?;
        let replacement = Self::wrap(
            &self.workspace_hash,
            &self.kdf_salt,
            erasure,
            dek,
            profile_id,
            new_password,
        )?;
        let mut previous = std::mem::replace(&mut self.wrappers[position], replacement);
        wipe(&mut previous.ciphertext);
        wipe(&mut previous.nonce);
        Ok(())
    }

    pub fn verify_profile_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
        let wrapper = self
            .wrappers
            .iter()
            .find(|item| item.profile_id == profile_id)
            .ok_or_else(|| "PROFILE_NOT_FOUND".to_string())?;
        let mut password_key = profiles::derive_password_key(password, &self.kdf_salt)
            .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?;
        let erasure = self.erasure_secret.as_ref().ok_or("WORKSPACE_ERASED")?;
        let wrapper_key = sha256(&[
            b"kaigen-web-wrapper-key-v1",
            &password_key,
            erasure,
            profile_id.as_bytes(),
        ]);
        wipe(&mut password_key);
        let mut aad = Vec::new();
        aad.extend_from_slice(ENVELOPE_AAD_DOMAIN);
        aad.extend_from_slice(&self.workspace_hash);
        aad.extend_from_slice(profile_id.as_bytes());
        let mut plaintext = Aes256Gcm::new_from_slice(&wrapper_key)
            .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?
            .decrypt(
                &Nonce::from(wrapper.nonce),
                Payload {
                    msg: &wrapper.ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "PROFILE_PASSWORD_INVALID".to_string())?;
        let valid = plaintext.len() == 64
            && bool::from(plaintext[32..].ct_eq(self.workspace_hash.as_slice()))
            && self
                .unlocked_dek
                .as_ref()
                .is_some_and(|dek| bool::from(plaintext[..32].ct_eq(dek.as_slice())));
        wipe(&mut plaintext);
        valid
            .then_some(())
            .ok_or_else(|| "PROFILE_PASSWORD_INVALID".to_string())
    }

    pub fn seal(&self, logical_path: &str, plaintext: &[u8]) -> Result<EncryptedBlob, String> {
        let dek = self
            .unlocked_dek
            .as_ref()
            .ok_or_else(|| "WORKSPACE_LOCKED".to_string())?;
        seal_workspace_blob(&self.workspace_hash, dek, logical_path, plaintext)
    }

    pub fn open(&self, logical_path: &str, blob: &EncryptedBlob) -> Result<Vec<u8>, String> {
        let dek = self
            .unlocked_dek
            .as_ref()
            .ok_or_else(|| "WORKSPACE_LOCKED".to_string())?;
        open_workspace_blob(&self.workspace_hash, dek, logical_path, blob)
    }

    pub fn cryptographic_erase(&mut self) {
        if let Some(mut dek) = self.unlocked_dek.take() {
            wipe(&mut dek);
        }
        if let Some(mut erasure) = self.erasure_secret.take() {
            wipe(&mut erasure);
        }
        for wrapper in &mut self.wrappers {
            wipe(&mut wrapper.ciphertext);
            wipe(&mut wrapper.nonce);
        }
        self.wrappers.clear();
        self.erased = true;
    }

    pub fn is_erased(&self) -> bool {
        self.erased
    }

    pub fn profile_count(&self) -> usize {
        self.wrappers.len()
    }

    pub fn payload_cipher(&self) -> Result<WorkspacePayloadCipher, String> {
        let dek = self
            .unlocked_dek
            .as_ref()
            .ok_or_else(|| "WORKSPACE_LOCKED".to_string())?;
        Ok(WorkspacePayloadCipher {
            workspace_hash: self.workspace_hash,
            dek: *dek,
        })
    }

    pub fn profile_storage_password(&self, profile_id: &str) -> Result<String, String> {
        let dek = self
            .unlocked_dek
            .as_ref()
            .ok_or_else(|| "WORKSPACE_LOCKED".to_string())?;
        let erasure = self
            .erasure_secret
            .as_ref()
            .ok_or_else(|| "WORKSPACE_ERASED".to_string())?;
        Ok(URL_SAFE_NO_PAD.encode(sha256(&[
            b"kaigen-web-profile-storage-v1",
            dek,
            erasure,
            profile_id.as_bytes(),
        ])))
    }
}

fn seal_workspace_blob(
    workspace_hash: &[u8; 32],
    dek: &[u8; 32],
    logical_path: &str,
    plaintext: &[u8],
) -> Result<EncryptedBlob, String> {
    let nonce = random_array::<12>()?;
    let aad = blob_aad(workspace_hash, logical_path);
    let cipher = Aes256Gcm::new_from_slice(dek)
        .map_err(|_| "Could not initialize workspace encryption".to_string())?;
    let nonce_value = Nonce::from(nonce);
    let ciphertext = cipher
        .encrypt(
            &nonce_value,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "Could not encrypt workspace data".to_string())?;
    Ok(EncryptedBlob {
        version: VAULT_VERSION,
        nonce,
        ciphertext,
    })
}

fn blob_aad(workspace_hash: &[u8; 32], logical_path: &str) -> Vec<u8> {
    let mut aad = Vec::new();
    aad.extend_from_slice(BLOB_AAD_DOMAIN);
    aad.extend_from_slice(workspace_hash);
    aad.extend_from_slice(logical_path.as_bytes());
    aad
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEnrollment {
    pub device_token: String,
    pub revoked_devices: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChallenge {
    pub challenge: String,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRecord {
    token_hash: [u8; 32],
    public_key_spki: Vec<u8>,
    last_verified_at: u64,
    last_heartbeat_at: u64,
    challenge: Option<[u8; 32]>,
    challenge_expires_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistry {
    devices: Vec<DeviceRecord>,
}

impl fmt::Debug for DeviceRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceRegistry")
            .field("device_count", &self.devices.len())
            .finish()
    }
}

impl DeviceRegistry {
    /// Password login from a browser transfers ownership and revokes every
    /// previously enrolled browser key.
    pub fn enroll_after_password(
        &mut self,
        public_key_spki: Vec<u8>,
        now: u64,
    ) -> Result<DeviceEnrollment, String> {
        validate_p256_spki(&public_key_spki)?;
        let token = random_array::<32>()?;
        let device_token = URL_SAFE_NO_PAD.encode(token);
        let token_hash = hash_device_token(&device_token);
        let revoked_devices = self.devices.len();
        self.devices.clear();
        self.devices.push(DeviceRecord {
            token_hash,
            public_key_spki,
            last_verified_at: now,
            last_heartbeat_at: now,
            challenge: None,
            challenge_expires_at: 0,
        });
        Ok(DeviceEnrollment {
            device_token,
            revoked_devices,
        })
    }

    pub fn issue_challenge(
        &mut self,
        device_token: &str,
        now: u64,
    ) -> Result<DeviceChallenge, String> {
        let record = self.find_mut(device_token)?;
        if now.saturating_sub(record.last_heartbeat_at) >= DEVICE_REAUTH_SECONDS {
            return Err("PASSWORD_REAUTH_REQUIRED".to_string());
        }
        let challenge = random_array::<32>()?;
        record.challenge = Some(challenge);
        record.challenge_expires_at = now.saturating_add(5 * 60);
        Ok(DeviceChallenge {
            challenge: URL_SAFE_NO_PAD.encode(challenge),
            expires_at: record.challenge_expires_at,
        })
    }

    pub fn verify_challenge_with<F>(
        &mut self,
        device_token: &str,
        encoded_challenge: &str,
        signature_bytes: &[u8],
        now: u64,
        verifier: F,
    ) -> Result<(), String>
    where
        F: FnOnce(&[u8], &[u8], &[u8]) -> bool,
    {
        let record = self.find_mut(device_token)?;
        let supplied = URL_SAFE_NO_PAD
            .decode(encoded_challenge)
            .map_err(|_| "DEVICE_AUTH_INVALID".to_string())?;
        let expected = record.challenge.take().ok_or("DEVICE_AUTH_INVALID")?;
        if now > record.challenge_expires_at
            || supplied.len() != expected.len()
            || !bool::from(supplied.ct_eq(&expected))
            || !verifier(&record.public_key_spki, &expected, signature_bytes)
        {
            return Err("DEVICE_AUTH_INVALID".to_string());
        }
        record.last_verified_at = now;
        record.last_heartbeat_at = now;
        Ok(())
    }

    pub fn heartbeat(&mut self, device_token: &str, now: u64) -> Result<[u8; 32], String> {
        let record = self.find_mut(device_token)?;
        if now.saturating_sub(record.last_heartbeat_at) >= DEVICE_REAUTH_SECONDS {
            return Err("PASSWORD_REAUTH_REQUIRED".to_string());
        }
        record.last_heartbeat_at = now;
        Ok(record.token_hash)
    }

    pub fn needs_periodic_verification(
        &self,
        device_token: &str,
        now: u64,
    ) -> Result<bool, String> {
        let record = self.find(device_token)?;
        Ok(now.saturating_sub(record.last_verified_at) >= DEVICE_VERIFY_SECONDS)
    }

    pub fn token_hash(&self, device_token: &str) -> Result<[u8; 32], String> {
        Ok(self.find(device_token)?.token_hash)
    }

    fn find(&self, device_token: &str) -> Result<&DeviceRecord, String> {
        let hash = hash_device_token(device_token);
        self.devices
            .iter()
            .find(|record| bool::from(record.token_hash.ct_eq(&hash)))
            .ok_or_else(|| "DEVICE_AUTH_INVALID".to_string())
    }

    fn find_mut(&mut self, device_token: &str) -> Result<&mut DeviceRecord, String> {
        let hash = hash_device_token(device_token);
        self.devices
            .iter_mut()
            .find(|record| bool::from(record.token_hash.ct_eq(&hash)))
            .ok_or_else(|| "DEVICE_AUTH_INVALID".to_string())
    }
}

fn hash_device_token(token: &str) -> [u8; 32] {
    sha256(&[b"kaigen-web-device-token-v1", token.as_bytes()])
}

fn validate_p256_spki(spki: &[u8]) -> Result<(), String> {
    const P256_SPKI_PREFIX: [u8; 26] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ];
    if spki.len() != 91
        || !bool::from(spki[..P256_SPKI_PREFIX.len()].ct_eq(&P256_SPKI_PREFIX))
        || spki[P256_SPKI_PREFIX.len()] != 0x04
    {
        return Err("DEVICE_KEY_INVALID".to_string());
    }
    Ok(())
}

pub fn source_fingerprint(server_secret: &[u8], source_address: &[u8]) -> [u8; 32] {
    // RFC 2104 HMAC-SHA-256, implemented from the already pinned SHA-256
    // primitive so the shared core does not pull a web-transport dependency.
    let mut key_block = [0_u8; 64];
    if server_secret.len() > key_block.len() {
        key_block[..32].copy_from_slice(&sha256(&[server_secret]));
    } else {
        key_block[..server_secret.len()].copy_from_slice(server_secret);
    }
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..64 {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }
    let inner = sha256(&[&inner_pad, source_address]);
    let result = sha256(&[&outer_pad, &inner]);
    wipe(&mut key_block);
    wipe(&mut inner_pad);
    wipe(&mut outer_pad);
    result
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPolicy {
    pub allowed_at: u64,
    pub delay_seconds: u64,
    pub captcha_required: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceFailures {
    consecutive_failures: u32,
    allowed_at: u64,
    last_failure_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthBackoff {
    sources: HashMap<[u8; 32], SourceFailures>,
}

impl AuthBackoff {
    pub fn policy(&self, source: &[u8; 32], now: u64) -> AuthPolicy {
        let failures = self.sources.get(source);
        AuthPolicy {
            allowed_at: failures.map(|item| item.allowed_at).unwrap_or(now),
            delay_seconds: failures
                .map(|item| item.allowed_at.saturating_sub(now))
                .unwrap_or(0),
            captcha_required: failures
                .map(|item| item.consecutive_failures >= 3)
                .unwrap_or(false),
        }
    }

    pub fn record_failure(&mut self, source: [u8; 32], now: u64) -> AuthPolicy {
        let state = self.sources.entry(source).or_default();
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        let shift = state.consecutive_failures.saturating_sub(1).min(5);
        let delay = (2_u64 << shift).min(60);
        state.allowed_at = now.saturating_add(delay);
        state.last_failure_at = now;
        AuthPolicy {
            allowed_at: state.allowed_at,
            delay_seconds: delay,
            captcha_required: state.consecutive_failures >= 3,
        }
    }

    pub fn record_success(&mut self, source: &[u8; 32]) {
        self.sources.remove(source);
    }

    pub fn prune(&mut self, now: u64) {
        self.sources
            .retain(|_, state| now.saturating_sub(state.last_failure_at) < 24 * 60 * 60);
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeaseDecision {
    Acquired,
    Refreshed,
    StaleTakenOver,
    TransferredAfterPassword,
    Occupied,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLease {
    holder_device_hash: Option<[u8; 32]>,
    last_heartbeat_at: u64,
    acquired_at: u64,
}

impl UiLease {
    pub fn acquire(
        &mut self,
        device_hash: [u8; 32],
        now: u64,
        password_authenticated: bool,
    ) -> LeaseDecision {
        match self.holder_device_hash {
            None => {
                self.set_holder(device_hash, now);
                LeaseDecision::Acquired
            }
            Some(current) if bool::from(current.ct_eq(&device_hash)) => {
                let stale = now.saturating_sub(self.last_heartbeat_at) >= UI_LEASE_STALE_SECONDS;
                self.last_heartbeat_at = now;
                if stale {
                    LeaseDecision::StaleTakenOver
                } else {
                    LeaseDecision::Refreshed
                }
            }
            Some(_) if password_authenticated => {
                self.set_holder(device_hash, now);
                LeaseDecision::TransferredAfterPassword
            }
            Some(_) => LeaseDecision::Occupied,
        }
    }

    pub fn heartbeat(&mut self, device_hash: &[u8; 32], now: u64) -> Result<(), String> {
        let holder = self
            .holder_device_hash
            .as_ref()
            .ok_or_else(|| "UI_LEASE_REQUIRED".to_string())?;
        if !bool::from(holder.ct_eq(device_hash)) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        self.last_heartbeat_at = now;
        Ok(())
    }

    pub fn release(&mut self, device_hash: &[u8; 32]) {
        if self
            .holder_device_hash
            .as_ref()
            .is_some_and(|holder| bool::from(holder.ct_eq(device_hash)))
        {
            self.holder_device_hash = None;
            self.last_heartbeat_at = 0;
            self.acquired_at = 0;
        }
    }

    pub fn is_stale(&self, now: u64) -> bool {
        self.holder_device_hash.is_some()
            && now.saturating_sub(self.last_heartbeat_at) >= UI_LEASE_STALE_SECONDS
    }

    pub fn has_holder(&self) -> bool {
        self.holder_device_hash.is_some()
    }

    pub fn has_fresh_holder(&self, now: u64) -> bool {
        self.has_holder() && !self.is_stale(now)
    }

    pub fn owned_by(&self, device_hash: &[u8; 32]) -> bool {
        self.holder_device_hash
            .as_ref()
            .is_some_and(|holder| bool::from(holder.ct_eq(device_hash)))
    }

    fn set_holder(&mut self, device_hash: [u8; 32], now: u64) {
        self.holder_device_hash = Some(device_hash);
        self.last_heartbeat_at = now;
        self.acquired_at = now;
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub memory_available_percent: f64,
    pub disk_available_percent: f64,
    /// Normalized five-minute host load, where 100 means all logical CPUs busy.
    pub cpu_five_minute_percent: f64,
    pub projected_runtime_reserve_available: bool,
    pub active_instances: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdmissionBlock {
    Memory,
    Disk,
    Cpu,
    RuntimeReserve,
    MaxInstances,
    RecoveryWindow,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionDecision {
    pub allowed: bool,
    pub reason: Option<AdmissionBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAdmission {
    max_instances: usize,
    closed_reason: Option<AdmissionBlock>,
    healthy_since: Option<u64>,
}

impl ResourceAdmission {
    pub fn new(max_instances: usize) -> Result<Self, String> {
        if max_instances == 0 {
            return Err("max_instances must be finite and greater than zero".to_string());
        }
        Ok(Self {
            max_instances,
            closed_reason: None,
            healthy_since: None,
        })
    }

    pub fn evaluate(&mut self, snapshot: ResourceSnapshot, now: u64) -> AdmissionDecision {
        let immediate_reason = if snapshot.active_instances >= self.max_instances {
            Some(AdmissionBlock::MaxInstances)
        } else if !snapshot.projected_runtime_reserve_available {
            Some(AdmissionBlock::RuntimeReserve)
        } else if snapshot.memory_available_percent < 20.0 {
            Some(AdmissionBlock::Memory)
        } else if snapshot.disk_available_percent < 20.0 {
            Some(AdmissionBlock::Disk)
        } else if snapshot.cpu_five_minute_percent > 70.0 {
            Some(AdmissionBlock::Cpu)
        } else {
            None
        };
        if let Some(reason) = immediate_reason {
            self.closed_reason = Some(reason.clone());
            self.healthy_since = None;
            return AdmissionDecision {
                allowed: false,
                reason: Some(reason),
            };
        }
        if self.closed_reason.is_none() {
            return AdmissionDecision {
                allowed: true,
                reason: None,
            };
        }
        let recovered = snapshot.memory_available_percent > 25.0
            && snapshot.disk_available_percent > 25.0
            && snapshot.cpu_five_minute_percent < 60.0
            && snapshot.projected_runtime_reserve_available
            && snapshot.active_instances < self.max_instances;
        if !recovered {
            self.healthy_since = None;
            return AdmissionDecision {
                allowed: false,
                reason: self.closed_reason.clone(),
            };
        }
        let healthy_since = *self.healthy_since.get_or_insert(now);
        if now.saturating_sub(healthy_since) < 5 * 60 {
            return AdmissionDecision {
                allowed: false,
                reason: Some(AdmissionBlock::RecoveryWindow),
            };
        }
        self.closed_reason = None;
        self.healthy_since = None;
        AdmissionDecision {
            allowed: true,
            reason: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StorageMode {
    Disk,
    Ram,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaLedger {
    pub user_limit_bytes: u64,
    pub user_used_bytes: u64,
    pub reserve_limit_bytes: u64,
    pub reserve_used_bytes: u64,
}

impl QuotaLedger {
    pub fn new(user_limit_bytes: u64, reserve_limit_bytes: u64) -> Result<Self, String> {
        if user_limit_bytes == 0 || reserve_limit_bytes == 0 {
            return Err("Workspace and security reserve quotas must be non-zero".to_string());
        }
        Ok(Self {
            user_limit_bytes,
            user_used_bytes: 0,
            reserve_limit_bytes,
            reserve_used_bytes: 0,
        })
    }

    pub fn reserve_user(&mut self, bytes: u64) -> Result<(), String> {
        let next = self.user_used_bytes.saturating_add(bytes);
        if next > self.user_limit_bytes {
            return Err("WORKSPACE_QUOTA_FULL".to_string());
        }
        self.user_used_bytes = next;
        Ok(())
    }

    pub fn reserve_security(&mut self, bytes: u64) -> Result<(), String> {
        let next = self.reserve_used_bytes.saturating_add(bytes);
        if next > self.reserve_limit_bytes {
            return Err("WORKSPACE_SECURITY_RESERVE_FULL".to_string());
        }
        self.reserve_used_bytes = next;
        Ok(())
    }

    pub fn release_user(&mut self, bytes: u64) {
        self.user_used_bytes = self.user_used_bytes.saturating_sub(bytes);
    }

    pub fn release_security(&mut self, bytes: u64) {
        self.reserve_used_bytes = self.reserve_used_bytes.saturating_sub(bytes);
    }

    pub fn optional_writes_allowed(&self) -> bool {
        self.user_used_bytes < self.user_limit_bytes
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeasePhase {
    Provisional,
    Active,
    TransferExtension,
    RenewalGrace,
    Expired,
    Unlimited,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLeaseStatus {
    pub phase: LeasePhase,
    pub remaining_seconds: Option<u64>,
    pub new_transfers_allowed: bool,
    pub erase_now: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLease {
    configured_seconds: u64,
    created_at: u64,
    expires_at: Option<u64>,
    first_profile_created: bool,
    transfer_extension_started_at: Option<u64>,
    transfer_last_progress_at: Option<u64>,
    grace_started_at: Option<u64>,
}

impl DataLease {
    pub fn provisional(configured_hours: u64, now: u64) -> Self {
        Self {
            configured_seconds: configured_hours.saturating_mul(60 * 60),
            created_at: now,
            expires_at: Some(now.saturating_add(PROVISIONAL_TTL_SECONDS)),
            first_profile_created: false,
            transfer_extension_started_at: None,
            transfer_last_progress_at: None,
            grace_started_at: None,
        }
    }

    pub fn activate_after_first_profile(&mut self, now: u64) {
        self.first_profile_created = true;
        self.expires_at = if self.configured_seconds == 0 {
            None
        } else {
            Some(now.saturating_add(self.configured_seconds))
        };
        self.transfer_extension_started_at = None;
        self.transfer_last_progress_at = None;
        self.grace_started_at = None;
    }

    pub fn renew(&mut self, now: u64) -> Result<(), String> {
        if !self.first_profile_created {
            return Err("WORKSPACE_PROVISIONAL".to_string());
        }
        self.expires_at = if self.configured_seconds == 0 {
            None
        } else {
            Some(now.saturating_add(self.configured_seconds))
        };
        self.transfer_extension_started_at = None;
        self.transfer_last_progress_at = None;
        self.grace_started_at = None;
        Ok(())
    }

    pub fn record_transfer_progress(&mut self, now: u64) {
        self.transfer_last_progress_at = Some(now);
    }

    pub fn configured_seconds(&self) -> u64 {
        self.configured_seconds
    }

    pub fn status(&mut self, now: u64, transfer_active: bool) -> DataLeaseStatus {
        if self.first_profile_created && self.configured_seconds == 0 {
            return DataLeaseStatus {
                phase: LeasePhase::Unlimited,
                remaining_seconds: None,
                new_transfers_allowed: true,
                erase_now: false,
            };
        }
        let expiry = self
            .expires_at
            .unwrap_or_else(|| self.created_at.saturating_add(PROVISIONAL_TTL_SECONDS));
        if now < expiry {
            return DataLeaseStatus {
                phase: if self.first_profile_created {
                    LeasePhase::Active
                } else {
                    LeasePhase::Provisional
                },
                remaining_seconds: Some(expiry - now),
                new_transfers_allowed: true,
                erase_now: false,
            };
        }
        if !self.first_profile_created {
            return DataLeaseStatus {
                phase: LeasePhase::Expired,
                remaining_seconds: Some(0),
                new_transfers_allowed: false,
                erase_now: true,
            };
        }
        if transfer_active {
            let extension_start = *self.transfer_extension_started_at.get_or_insert(expiry);
            let cap_at = extension_start.saturating_add(EXPIRY_TRANSFER_CAP_SECONDS);
            let making_progress = self
                .transfer_last_progress_at
                .is_some_and(|last| now.saturating_sub(last) <= UI_LEASE_STALE_SECONDS);
            if now < cap_at && making_progress {
                return DataLeaseStatus {
                    phase: LeasePhase::TransferExtension,
                    remaining_seconds: Some(cap_at - now),
                    new_transfers_allowed: false,
                    erase_now: false,
                };
            }
        }
        let grace_start = *self.grace_started_at.get_or_insert(now);
        let grace_end = grace_start.saturating_add(EXPIRY_GRACE_SECONDS);
        if now < grace_end {
            return DataLeaseStatus {
                phase: LeasePhase::RenewalGrace,
                remaining_seconds: Some(grace_end - now),
                new_transfers_allowed: false,
                erase_now: false,
            };
        }
        DataLeaseStatus {
            phase: LeasePhase::Expired,
            remaining_seconds: Some(0),
            new_transfers_allowed: false,
            erase_now: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferDirection {
    Incoming,
    Outgoing,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferState {
    Offered,
    Queued,
    Active,
    Paused,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOffer {
    pub id: String,
    pub profile_id: String,
    pub direction: TransferDirection,
    pub size_bytes: u64,
    pub state: TransferState,
    pub transferred_bytes: u64,
    pub last_progress_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCoordinator {
    offers: HashMap<String, TransferOffer>,
    queue: VecDeque<String>,
    active_id: Option<String>,
    buffered_bytes: u64,
    token_bytes: u64,
    token_updated_at_ms: u64,
}

impl Default for TransferCoordinator {
    fn default() -> Self {
        Self {
            offers: HashMap::new(),
            queue: VecDeque::new(),
            active_id: None,
            buffered_bytes: 0,
            token_bytes: TRANSFER_RATE_BYTES_PER_SECOND,
            token_updated_at_ms: 0,
        }
    }
}

impl TransferCoordinator {
    fn forget(&mut self, id: &str) {
        self.offers.remove(id);
        self.queue.retain(|queued| queued != id);
        if self.active_id.as_deref() == Some(id) {
            self.active_id = None;
            self.start_next();
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.offers.contains_key(id)
    }

    pub fn offer(&mut self, mut offer: TransferOffer) -> Result<(), String> {
        if self.offers.contains_key(&offer.id) || offer.id.trim().is_empty() {
            return Err("TRANSFER_INVALID".to_string());
        }
        // An incoming proposal does not consume the executable slot until the
        // user explicitly accepts it.
        offer.state = if offer.direction == TransferDirection::Incoming {
            TransferState::Offered
        } else {
            TransferState::Queued
        };
        if offer.direction == TransferDirection::Outgoing {
            self.queue.push_back(offer.id.clone());
        }
        self.offers.insert(offer.id.clone(), offer);
        self.start_next();
        Ok(())
    }

    pub fn accept(&mut self, id: &str) -> Result<(), String> {
        let offer = self.offers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        if offer.direction != TransferDirection::Incoming || offer.state != TransferState::Offered {
            return Err("TRANSFER_NOT_ACCEPTABLE".to_string());
        }
        offer.state = TransferState::Queued;
        self.queue.push_back(id.to_string());
        self.start_next();
        Ok(())
    }

    pub fn pause(&mut self, id: &str) -> Result<(), String> {
        let offer = self.offers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        if !matches!(offer.state, TransferState::Active | TransferState::Queued) {
            return Err("TRANSFER_NOT_PAUSABLE".to_string());
        }
        offer.state = TransferState::Paused;
        self.queue.retain(|queued| queued != id);
        if self.active_id.as_deref() == Some(id) {
            self.active_id = None;
            self.start_next();
        }
        Ok(())
    }

    pub fn resume(&mut self, id: &str) -> Result<(), String> {
        let offer = self.offers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        if offer.state != TransferState::Paused {
            return Err("TRANSFER_NOT_RESUMABLE".to_string());
        }
        offer.state = TransferState::Queued;
        self.queue.push_back(id.to_string());
        self.start_next();
        Ok(())
    }

    pub fn cancel(&mut self, id: &str) -> Result<(), String> {
        let offer = self.offers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        offer.state = TransferState::Cancelled;
        self.queue.retain(|queued| queued != id);
        if self.active_id.as_deref() == Some(id) {
            self.active_id = None;
            self.start_next();
        }
        Ok(())
    }

    pub fn reorder(&mut self, id: &str, index: usize) -> Result<(), String> {
        let position = self
            .queue
            .iter()
            .position(|queued| queued == id)
            .ok_or("TRANSFER_NOT_QUEUED")?;
        let value = self.queue.remove(position).ok_or("TRANSFER_NOT_QUEUED")?;
        let target = index.min(self.queue.len());
        self.queue.insert(target, value);
        Ok(())
    }

    pub fn reserve_buffer(&mut self, bytes: u64) -> Result<(), String> {
        let next = self.buffered_bytes.saturating_add(bytes);
        if next > TRANSFER_BUFFER_LIMIT_BYTES {
            return Err("TRANSFER_BACKPRESSURE".to_string());
        }
        self.buffered_bytes = next;
        Ok(())
    }

    pub fn release_buffer(&mut self, bytes: u64) {
        self.buffered_bytes = self.buffered_bytes.saturating_sub(bytes);
    }

    pub fn allowed_chunk(&mut self, requested: u64, now_ms: u64) -> u64 {
        let elapsed_ms = now_ms.saturating_sub(self.token_updated_at_ms);
        let refill = TRANSFER_RATE_BYTES_PER_SECOND
            .saturating_mul(elapsed_ms)
            .saturating_div(1000);
        self.token_bytes = self
            .token_bytes
            .saturating_add(refill)
            .min(TRANSFER_RATE_BYTES_PER_SECOND);
        self.token_updated_at_ms = now_ms;
        let allowed = requested.min(self.token_bytes);
        self.token_bytes -= allowed;
        allowed
    }

    pub fn record_progress(&mut self, bytes: u64, now: u64) -> Result<(), String> {
        let id = self.active_id.as_ref().ok_or("NO_ACTIVE_TRANSFER")?;
        let offer = self.offers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        offer.transferred_bytes = offer.transferred_bytes.saturating_add(bytes);
        offer.last_progress_at = Some(now);
        if offer.transferred_bytes >= offer.size_bytes {
            offer.state = TransferState::Completed;
            self.active_id = None;
            self.start_next();
        }
        Ok(())
    }

    pub fn record_stream_progress(&mut self, id: &str, bytes: u64, now: u64) -> Result<(), String> {
        if self.active_id.as_deref() != Some(id) {
            return Err("NO_ACTIVE_TRANSFER".to_string());
        }
        let offer = self.offers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        offer.transferred_bytes = offer
            .transferred_bytes
            .saturating_add(bytes)
            .min(offer.size_bytes);
        offer.last_progress_at = Some(now);
        Ok(())
    }

    pub fn complete_stream(&mut self, id: &str) -> Result<(), String> {
        let offer = self.offers.get_mut(id).ok_or("TRANSFER_NOT_FOUND")?;
        offer.transferred_bytes = offer.size_bytes;
        offer.state = TransferState::Completed;
        if self.active_id.as_deref() == Some(id) {
            self.active_id = None;
            self.start_next();
        }
        Ok(())
    }

    pub fn on_ui_lost(&mut self) {
        if let Some(id) = self.active_id.take() {
            if let Some(offer) = self.offers.get_mut(&id) {
                offer.state = TransferState::Paused;
            }
        }
        self.buffered_bytes = 0;
    }

    pub fn active(&self) -> Option<&TransferOffer> {
        self.active_id.as_ref().and_then(|id| self.offers.get(id))
    }

    pub fn offers(&self) -> impl Iterator<Item = &TransferOffer> {
        self.offers.values()
    }

    fn start_next(&mut self) {
        if self.active_id.is_some() {
            return;
        }
        while let Some(id) = self.queue.pop_front() {
            if let Some(offer) = self.offers.get_mut(&id) {
                if offer.state == TransferState::Queued {
                    offer.state = TransferState::Active;
                    self.active_id = Some(id);
                    return;
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClosePhase {
    Open,
    Frozen,
    ArchiveReady,
    Erased,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseTransaction {
    pub id: String,
    pub phase: ClosePhase,
    pub archive_sha256: Option<[u8; 32]>,
    pub archive_bytes: Option<u64>,
}

impl CloseTransaction {
    pub fn begin() -> Result<Self, String> {
        Ok(Self {
            id: URL_SAFE_NO_PAD.encode(random_array::<24>()?),
            phase: ClosePhase::Frozen,
            archive_sha256: None,
            archive_bytes: None,
        })
    }

    pub fn archive_complete(&mut self, sha256: [u8; 32], bytes: u64) -> Result<(), String> {
        if self.phase != ClosePhase::Frozen || bytes == 0 {
            return Err("CLOSE_TRANSACTION_INVALID".to_string());
        }
        self.archive_sha256 = Some(sha256);
        self.archive_bytes = Some(bytes);
        self.phase = ClosePhase::ArchiveReady;
        Ok(())
    }

    pub fn confirm_received(
        &mut self,
        browser_sha256: &[u8; 32],
        browser_bytes: u64,
        explicit_confirmation: bool,
    ) -> Result<(), String> {
        let expected = self.archive_sha256.ok_or("ARCHIVE_NOT_READY")?;
        if self.phase != ClosePhase::ArchiveReady
            || !explicit_confirmation
            || self.archive_bytes != Some(browser_bytes)
            || !bool::from(expected.ct_eq(browser_sha256))
        {
            return Err("ARCHIVE_CONFIRMATION_INVALID".to_string());
        }
        self.phase = ClosePhase::Erased;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveManifest {
    pub version: u32,
    pub workspace_export: bool,
    pub profile_count: usize,
    pub created_at: u64,
}

impl ArchiveManifest {
    pub fn workspace(profile_count: usize, created_at: u64) -> Self {
        Self {
            version: ARCHIVE_VERSION,
            workspace_export: true,
            profile_count,
            created_at,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Presence {
    Online,
    Away,
    Busy,
    Offline,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebProfile {
    pub id: String,
    #[serde(skip, default)]
    pub display_name: String,
    #[serde(default)]
    pub password_protected: bool,
    pub explicitly_selected_presence: Presence,
    pub active: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCatalog {
    profiles: Vec<WebProfile>,
    selected_profile_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileMetadata {
    names: HashMap<String, String>,
}

impl ProfileCatalog {
    pub fn add(
        &mut self,
        id: String,
        display_name: String,
        password_protected: bool,
    ) -> Result<(), String> {
        if id.trim().is_empty()
            || display_name.trim().is_empty()
            || self.profiles.iter().any(|profile| profile.id == id)
        {
            return Err("PROFILE_INVALID".to_string());
        }
        self.profiles.push(WebProfile {
            id: id.clone(),
            display_name,
            password_protected,
            explicitly_selected_presence: Presence::Online,
            active: false,
        });
        if self.selected_profile_id.is_none() {
            self.selected_profile_id = Some(id);
        }
        Ok(())
    }

    pub fn activate(&mut self, id: &str) -> Result<(), String> {
        if self.active_count() >= 3
            && !self
                .profiles
                .iter()
                .any(|profile| profile.id == id && profile.active)
        {
            return Err("ACTIVE_PROFILE_LIMIT".to_string());
        }
        let profile = self
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or("PROFILE_NOT_FOUND")?;
        profile.active = true;
        let selection_is_active = self
            .selected_profile_id
            .as_deref()
            .is_some_and(|selected_id| {
                self.profiles
                    .iter()
                    .any(|profile| profile.id == selected_id && profile.active)
            });
        if !selection_is_active {
            self.selected_profile_id = Some(id.to_string());
        }
        Ok(())
    }

    pub fn deactivate(&mut self, id: &str) -> Result<(), String> {
        let profile = self
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or("PROFILE_NOT_FOUND")?;
        profile.active = false;
        if self.selected_profile_id.as_deref() == Some(id) {
            self.selected_profile_id = self
                .profiles
                .iter()
                .find(|profile| profile.active)
                .map(|profile| profile.id.clone());
        }
        Ok(())
    }

    pub fn select(&mut self, id: &str) -> Result<(), String> {
        if !self.profiles.iter().any(|profile| profile.id == id) {
            return Err("PROFILE_NOT_FOUND".to_string());
        }
        self.selected_profile_id = Some(id.to_string());
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let position = self
            .profiles
            .iter()
            .position(|profile| profile.id == id)
            .ok_or("PROFILE_NOT_FOUND")?;
        self.profiles.remove(position);
        if self.selected_profile_id.as_deref() == Some(id) {
            self.selected_profile_id = self
                .profiles
                .iter()
                .find(|profile| profile.active)
                .or_else(|| self.profiles.first())
                .map(|profile| profile.id.clone());
        }
        Ok(())
    }

    pub fn set_presence(&mut self, id: &str, presence: Presence) -> Result<(), String> {
        let profile = self
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or("PROFILE_NOT_FOUND")?;
        profile.explicitly_selected_presence = presence;
        Ok(())
    }

    pub fn set_password_protected(
        &mut self,
        id: &str,
        password_protected: bool,
    ) -> Result<(), String> {
        let profile = self
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or("PROFILE_NOT_FOUND")?;
        profile.password_protected = password_protected;
        Ok(())
    }

    pub fn effective_presence(&self, id: &str, ui_has_heartbeat: bool) -> Result<Presence, String> {
        let profile = self
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .ok_or("PROFILE_NOT_FOUND")?;
        Ok(
            match (profile.explicitly_selected_presence, ui_has_heartbeat) {
                (Presence::Online, false) => Presence::Away,
                (selected, _) => selected,
            },
        )
    }

    pub fn active_count(&self) -> usize {
        self.profiles
            .iter()
            .filter(|profile| profile.active)
            .count()
    }

    pub fn stored_count(&self) -> usize {
        self.profiles.len()
    }

    pub fn lock_all_after_restart(&mut self) {
        for profile in &mut self.profiles {
            profile.active = false;
        }
    }

    pub fn profiles(&self) -> &[WebProfile] {
        &self.profiles
    }

    pub fn selected_profile_id(&self) -> Option<&str> {
        self.selected_profile_id.as_deref()
    }

    fn encrypted_metadata(&self) -> ProfileMetadata {
        ProfileMetadata {
            names: self
                .profiles
                .iter()
                .map(|profile| (profile.id.clone(), profile.display_name.clone()))
                .collect(),
        }
    }

    fn hydrate_metadata(&mut self, metadata: ProfileMetadata) -> Result<(), String> {
        for profile in &mut self.profiles {
            let name = metadata
                .names
                .get(&profile.id)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .ok_or("PROFILE_METADATA_INVALID")?;
            profile.display_name = name.to_string();
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub storage_mode: StorageMode,
    pub quota_bytes: u64,
    pub security_reserve_bytes: u64,
    pub lease_hours: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDomain {
    pub workspace_hash: [u8; 32],
    pub storage_mode: StorageMode,
    #[serde(default = "default_workspace_language")]
    pub language: String,
    pub created_at: u64,
    pub quota: QuotaLedger,
    pub data_lease: DataLease,
    pub devices: DeviceRegistry,
    pub ui_lease: UiLease,
    pub profiles: ProfileCatalog,
    pub transfers: TransferCoordinator,
    pub vault: Option<WorkspaceVault>,
    #[serde(default)]
    encrypted_profile_metadata: Option<EncryptedBlob>,
    pub close_transaction: Option<CloseTransaction>,
    #[serde(default)]
    resume_profile_ids: Vec<String>,
}

impl WorkspaceDomain {
    pub fn provisional(
        workspace_hash: [u8; 32],
        config: WorkspaceConfig,
        now: u64,
    ) -> Result<Self, String> {
        Ok(Self {
            workspace_hash,
            storage_mode: config.storage_mode,
            language: default_workspace_language(),
            created_at: now,
            quota: QuotaLedger::new(config.quota_bytes, config.security_reserve_bytes)?,
            data_lease: DataLease::provisional(config.lease_hours, now),
            devices: DeviceRegistry::default(),
            ui_lease: UiLease::default(),
            profiles: ProfileCatalog::default(),
            transfers: TransferCoordinator::default(),
            vault: None,
            encrypted_profile_metadata: None,
            close_transaction: None,
            resume_profile_ids: Vec::new(),
        })
    }

    pub fn initialize_workspace(&mut self, access_password: &str, now: u64) -> Result<(), String> {
        if self.vault.is_some() || self.profiles.stored_count() != 0 {
            return Err("WORKSPACE_ALREADY_INITIALIZED".to_string());
        }
        let vault = WorkspaceVault::create(self.workspace_hash, access_password)?;
        self.data_lease.activate_after_first_profile(now);
        self.vault = Some(vault);
        self.refresh_profile_metadata()?;
        Ok(())
    }

    pub fn set_language(&mut self, language: &str) -> Result<(), String> {
        if !matches!(language, "ru" | "en") {
            return Err("LANGUAGE_INVALID".to_string());
        }
        self.language = language.to_string();
        Ok(())
    }

    pub fn add_profile(
        &mut self,
        id: String,
        display_name: String,
        password_protected: bool,
    ) -> Result<(), String> {
        self.vault.as_ref().ok_or("WORKSPACE_NOT_INITIALIZED")?;
        self.profiles.add(id, display_name, password_protected)?;
        self.refresh_profile_metadata()?;
        Ok(())
    }

    pub fn set_profile_password_protected(
        &mut self,
        profile_id: &str,
        password_protected: bool,
    ) -> Result<(), String> {
        self.profiles
            .set_password_protected(profile_id, password_protected)?;
        self.refresh_profile_metadata()
    }

    pub fn remove_profile(&mut self, profile_id: &str) -> Result<(), String> {
        self.vault.as_ref().ok_or("WORKSPACE_NOT_INITIALIZED")?;
        self.profiles.remove(profile_id)?;
        self.resume_profile_ids.retain(|id| id != profile_id);
        self.refresh_profile_metadata()?;
        Ok(())
    }

    pub fn unlock(&mut self, password: &str) -> Result<(), String> {
        self.vault
            .as_mut()
            .ok_or("WORKSPACE_NOT_INITIALIZED")?
            .unlock(password)?;
        self.hydrate_profile_metadata()?;
        for id in std::mem::take(&mut self.resume_profile_ids) {
            let can_resume = self
                .profiles
                .profiles()
                .iter()
                .any(|profile| profile.id == id && !profile.password_protected);
            if can_resume {
                let _ = self.profiles.activate(&id);
            }
        }
        Ok(())
    }

    fn refresh_profile_metadata(&mut self) -> Result<(), String> {
        let encoded = serde_json::to_vec(&self.profiles.encrypted_metadata())
            .map_err(|_| "PROFILE_METADATA_INVALID".to_string())?;
        self.encrypted_profile_metadata = Some(
            self.vault
                .as_ref()
                .ok_or("WORKSPACE_NOT_INITIALIZED")?
                .seal("workspace/profile-metadata", &encoded)?,
        );
        Ok(())
    }

    fn hydrate_profile_metadata(&mut self) -> Result<(), String> {
        let blob = self
            .encrypted_profile_metadata
            .as_ref()
            .ok_or("PROFILE_METADATA_UNAVAILABLE")?;
        let encoded = self
            .vault
            .as_ref()
            .ok_or("WORKSPACE_NOT_INITIALIZED")?
            .open("workspace/profile-metadata", blob)?;
        let metadata =
            serde_json::from_slice(&encoded).map_err(|_| "PROFILE_METADATA_INVALID".to_string())?;
        self.profiles.hydrate_metadata(metadata)
    }

    pub fn lock_after_restart(&mut self) {
        if self.resume_profile_ids.is_empty() {
            self.resume_profile_ids = self
                .profiles
                .profiles()
                .iter()
                .filter(|profile| profile.active)
                .map(|profile| profile.id.clone())
                .take(3)
                .collect();
        }
        if let Some(vault) = self.vault.as_mut() {
            vault.lock();
        }
        self.profiles.lock_all_after_restart();
        self.ui_lease = UiLease::default();
    }

    pub fn close_without_export(&mut self) -> Result<(), String> {
        if self.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        self.transfers.on_ui_lost();
        self.devices.devices.clear();
        self.lock_after_restart();
        Ok(())
    }

    pub fn begin_close(&mut self) -> Result<&CloseTransaction, String> {
        if self.close_transaction.is_some() {
            return Err("CLOSE_ALREADY_IN_PROGRESS".to_string());
        }
        self.transfers.on_ui_lost();
        self.close_transaction = Some(CloseTransaction::begin()?);
        Ok(self.close_transaction.as_ref().expect("close transaction"))
    }

    pub fn cancel_close(&mut self) -> Result<String, String> {
        let transaction = self
            .close_transaction
            .take()
            .ok_or("CLOSE_TRANSACTION_NOT_FOUND")?;
        if transaction.phase == ClosePhase::Erased {
            self.close_transaction = Some(transaction);
            return Err("WORKSPACE_ERASED".to_string());
        }
        Ok(transaction.id)
    }

    pub fn erase_after_archive_confirmation(
        &mut self,
        transaction_id: &str,
        browser_sha256: [u8; 32],
        browser_bytes: u64,
        explicit_confirmation: bool,
    ) -> Result<(), String> {
        let transaction = self
            .close_transaction
            .as_mut()
            .ok_or("CLOSE_TRANSACTION_NOT_FOUND")?;
        if transaction.id != transaction_id {
            return Err("CLOSE_TRANSACTION_INVALID".to_string());
        }
        transaction.confirm_received(&browser_sha256, browser_bytes, explicit_confirmation)?;
        if let Some(vault) = self.vault.as_mut() {
            vault.cryptographic_erase();
        }
        self.devices.devices.clear();
        self.ui_lease = UiLease::default();
        self.profiles.lock_all_after_restart();
        Ok(())
    }

    pub fn cryptographic_erase_after_expiry(&mut self) {
        self.destroy_without_export();
    }

    pub fn destroy_without_export(&mut self) {
        self.transfers.on_ui_lost();
        if let Some(vault) = self.vault.as_mut() {
            vault.cryptographic_erase();
        }
        self.devices.devices.clear();
        self.ui_lease = UiLease::default();
        self.profiles.lock_all_after_restart();
    }
}

fn default_workspace_language() -> String {
    "ru".to_string()
}

fn presence_name(presence: Presence) -> &'static str {
    match presence {
        Presence::Online => "online",
        Presence::Away => "away",
        Presence::Busy => "busy",
        Presence::Offline => "offline",
    }
}

/// Owns the native processes and toxcore handles for exactly one workspace.
/// It is intentionally not serializable: disk metadata survives a restart,
/// while Tor/toxcore are recreated only after a valid workspace password.
pub struct WebWorkspaceRuntime {
    workspace_root: PathBuf,
    profile_durability: Option<WebProfileDurability>,
    tor: TorManager,
    proxy_settings: Arc<Mutex<ProxySettings>>,
    proxy_settings_path: PathBuf,
    network_settings: Arc<Mutex<NetworkSettings>>,
    network_settings_path: PathBuf,
    profiles: HashMap<String, Arc<ToxState>>,
    file_bridge: Arc<WebFileBridge>,
}

/// A contact snapshot bound to one loaded profile. Native iteration can finish
/// on a blocking worker without retaining the workspace registry mutex.
pub struct WebFriendsRequest {
    profile_id: String,
    profile: Arc<ToxState>,
}

impl WebFriendsRequest {
    pub fn execute(&self) -> Result<Value, String> {
        WebWorkspaceRuntime::friends_snapshot(&self.profile)
    }
}

/// An exact-owner, read-only history search that can safely outlive the short
/// workspace-registry lock used to authenticate and prepare a Web command.
/// The profile handle and stable friend identity are captured together, so a
/// later active-profile switch or tox friend-number reuse cannot redirect it.
pub struct WebMessageSearchRequest {
    profile_id: String,
    profile: Arc<ToxState>,
    friend_number: u32,
    friend_public_key: String,
    query: String,
    cursor: Option<String>,
    limit: usize,
}

impl WebMessageSearchRequest {
    pub fn execute(&self) -> Result<Value, String> {
        let page = crate::chat_history_store::search_registered(
            &self.profile.history_path,
            self.friend_number,
            &self.friend_public_key,
            &self.query,
            self.cursor.as_deref(),
            self.limit,
        )?;
        serde_json::to_value(page).map_err(|error| error.to_string())
    }
}

impl fmt::Debug for WebWorkspaceRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebWorkspaceRuntime")
            .field("active_profiles", &self.profiles.len())
            .field("tor_state", &self.tor.status().state)
            .finish()
    }
}

impl WebWorkspaceRuntime {
    pub fn install_transfer_store(
        &mut self,
        store: Arc<dyn WebTransferStore>,
    ) -> Result<(), String> {
        if !self.profiles.is_empty() {
            return Err("TRANSFER_STORAGE_INSTALL_TOO_LATE".to_string());
        }
        self.file_bridge.install_store(store)
    }

    pub fn start(resource_root: PathBuf, workspace_root: PathBuf) -> Result<Self, String> {
        Self::start_inner(resource_root, workspace_root, None)
    }

    pub fn start_with_profile_durability(
        resource_root: PathBuf,
        workspace_root: PathBuf,
        durability: WebProfileDurability,
    ) -> Result<Self, String> {
        Self::start_inner(resource_root, workspace_root, Some(durability))
    }

    fn start_inner(
        resource_root: PathBuf,
        workspace_root: PathBuf,
        profile_durability: Option<WebProfileDurability>,
    ) -> Result<Self, String> {
        let runtime_root = workspace_root.join("runtime");
        let logs = runtime_root.join("operational");
        fs::create_dir_all(&logs)
            .map_err(|error| format!("Could not create workspace runtime directories: {error}"))?;
        let proxy_settings_path = runtime_root.join("proxy-settings.json");
        let proxy_settings = fs::read(&proxy_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        let network_settings_path = runtime_root.join("network-settings.json");
        let network_settings = fs::read(&network_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        let tor = TorManager::new_privacy_preserving(resource_root, runtime_root)?;
        Ok(Self {
            workspace_root,
            profile_durability,
            tor,
            proxy_settings: Arc::new(Mutex::new(proxy_settings)),
            proxy_settings_path,
            network_settings: Arc::new(Mutex::new(network_settings)),
            network_settings_path,
            profiles: HashMap::new(),
            file_bridge: Arc::new(WebFileBridge::default()),
        })
    }

    pub fn prepare_friends(&self, profile_id: &str) -> Result<WebFriendsRequest, String> {
        Ok(WebFriendsRequest {
            profile_id: profile_id.to_string(),
            profile: self
                .profiles
                .get(profile_id)
                .cloned()
                .ok_or_else(|| "ACTIVE_PROFILE_LOCKED".to_string())?,
        })
    }

    pub fn friends_request_is_current(&self, request: &WebFriendsRequest) -> bool {
        self.profiles
            .get(&request.profile_id)
            .is_some_and(|profile| Arc::ptr_eq(profile, &request.profile))
    }

    pub fn prepare_message_search(
        &self,
        profile_id: &str,
        args: &Value,
    ) -> Result<WebMessageSearchRequest, String> {
        let profile = self
            .profiles
            .get(profile_id)
            .cloned()
            .ok_or_else(|| "ACTIVE_PROFILE_LOCKED".to_string())?;
        let friend_number = u32_value(args, "friendNumber")?;
        let friend_public_key = profile.stable_friend_public_key(friend_number);
        let query = sanitize_untrusted_text(string_value(args, "query")?)
            .trim()
            .to_string();
        if query.is_empty() || query.chars().count() > 256 {
            return Err("CHAT_SEARCH_QUERY_INVALID".to_string());
        }
        let cursor = args
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
        Ok(WebMessageSearchRequest {
            profile_id: profile_id.to_string(),
            profile,
            friend_number,
            friend_public_key,
            query,
            cursor,
            limit,
        })
    }

    pub fn message_search_is_current(&self, request: &WebMessageSearchRequest) -> bool {
        self.profiles
            .get(&request.profile_id)
            .is_some_and(|profile| Arc::ptr_eq(profile, &request.profile))
    }

    pub fn create_profile(
        &mut self,
        profile_id: &str,
        display_name: &str,
        profile_password: Option<&str>,
    ) -> Result<(), String> {
        if self.profiles.len() >= 3 {
            return Err("ACTIVE_PROFILE_LIMIT".to_string());
        }
        if self.profiles.contains_key(profile_id) {
            return Ok(());
        }
        let container_path = self.profile_container_path(profile_id)?;
        if container_path.is_file() {
            return self.load_profile(profile_id, profile_password);
        }
        let volume = KaiProfileVolume::create(container_path, profile_password)?;
        let paths = self.profile_paths_for_volume(Arc::clone(&volume))?;
        let mut state = ToxState::new_for_profile(
            paths,
            self.tor.clone(),
            Arc::clone(&self.proxy_settings),
            Arc::clone(&self.network_settings),
            None,
            None,
            None,
            Some(display_name),
        )?;
        state.transfer_log_path = PathBuf::new();
        state.network_log_path = PathBuf::new();
        state.web_profile_id = Some(profile_id.to_string());
        state.web_file_bridge = Some(Arc::clone(&self.file_bridge));
        let state = Arc::new(state);
        state.checkpoint_profile(true)?;
        Self::normalize_web_file_settings(&state)?;
        self.profiles
            .insert(profile_id.to_string(), Arc::clone(&state));
        state.start_network_loop();
        Ok(())
    }

    pub fn load_profile(
        &mut self,
        profile_id: &str,
        profile_password: Option<&str>,
    ) -> Result<(), String> {
        if self.profiles.contains_key(profile_id) {
            return Ok(());
        }
        if self.profiles.len() >= 3 {
            return Err("ACTIVE_PROFILE_LIMIT".to_string());
        }
        let container_path = self.profile_container_path(profile_id)?;
        let volume = KaiProfileVolume::open(container_path, profile_password)?;
        let paths = self.profile_paths_for_volume(volume)?;
        let (savedata, cipher) = profiles::read_profile(&paths.profile_path, profile_password)?;
        let mut state = ToxState::new_for_profile(
            paths,
            self.tor.clone(),
            Arc::clone(&self.proxy_settings),
            Arc::clone(&self.network_settings),
            None,
            Some(savedata),
            cipher,
            None,
        )?;
        state.transfer_log_path = PathBuf::new();
        state.network_log_path = PathBuf::new();
        state.web_profile_id = Some(profile_id.to_string());
        state.web_file_bridge = Some(Arc::clone(&self.file_bridge));
        let state = Arc::new(state);
        Self::normalize_web_file_settings(&state)?;
        self.profiles
            .insert(profile_id.to_string(), Arc::clone(&state));
        state.start_network_loop();
        Ok(())
    }

    pub fn import_profile(
        &mut self,
        profile_id: &str,
        profile_password: Option<&str>,
        savedata: Vec<u8>,
        activate: bool,
        restored_data_root: Option<&Path>,
        mut restored_data_files: Vec<(String, Vec<u8>)>,
    ) -> Result<(), String> {
        if activate && self.profiles.len() >= 3 {
            return Err("ACTIVE_PROFILE_LIMIT".to_string());
        }
        if self.profiles.contains_key(profile_id) {
            return Err("PROFILE_ALREADY_EXISTS".to_string());
        }
        let container_path = self.profile_container_path(profile_id)?;
        if container_path.exists() {
            return Err("PROFILE_ALREADY_EXISTS".to_string());
        }
        let volume = KaiProfileVolume::create(container_path, profile_password)?;
        let paths = self.profile_paths_for_volume(Arc::clone(&volume))?;
        if let Some(source) = restored_data_root {
            restore_profile_data(&self.workspace_root, source, &paths.data_dir)?;
        }
        for (relative, bytes) in &mut restored_data_files {
            let relative_path = Path::new(relative);
            if relative_path.is_absolute()
                || relative_path.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                crate::wipe_sensitive_bytes(bytes);
                return Err("KAI_VOLUME_PATH_INVALID".to_string());
            }
            let destination = paths.data_dir.join(relative_path);
            let result = profiles::write_file(&destination, bytes);
            crate::wipe_sensitive_bytes(bytes);
            result?;
        }
        profiles::write_file(&paths.profile_path, &savedata)?;
        let mut state = ToxState::new_for_profile(
            paths,
            self.tor.clone(),
            Arc::clone(&self.proxy_settings),
            Arc::clone(&self.network_settings),
            None,
            Some(savedata),
            None,
            None,
        )?;
        state.transfer_log_path = PathBuf::new();
        state.network_log_path = PathBuf::new();
        state.web_profile_id = Some(profile_id.to_string());
        state.web_file_bridge = Some(Arc::clone(&self.file_bridge));
        let state = Arc::new(state);
        Self::normalize_web_file_settings(&state)?;
        {
            let handle = state.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
            let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
            ToxState::save(handle)?;
        }
        state.checkpoint_profile(true)?;
        if activate {
            self.profiles
                .insert(profile_id.to_string(), Arc::clone(&state));
            state.start_network_loop();
        } else {
            state.stop();
        }
        Ok(())
    }

    pub fn synchronize_profiles(&mut self, domain: &WorkspaceDomain) -> Result<(), String> {
        let active = domain
            .profiles
            .profiles()
            .iter()
            .filter(|profile| profile.active)
            .take(3)
            .map(|profile| {
                (
                    profile.id.clone(),
                    profile.display_name.clone(),
                    profile.password_protected,
                )
            })
            .collect::<Vec<_>>();
        let active_ids = active
            .iter()
            .map(|(id, _, _)| id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let stale = self
            .profiles
            .keys()
            .filter(|id| !active_ids.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        for id in stale {
            self.stop_profile(&id)?;
        }
        domain.vault.as_ref().ok_or("WORKSPACE_NOT_INITIALIZED")?;
        for (id, name, password_protected) in active {
            if self.profiles.contains_key(&id) {
                continue;
            }
            if password_protected {
                return Err("PROFILE_PASSWORD_REQUIRED".to_string());
            }
            let path = self.profile_container_path(&id)?;
            if path.is_file() {
                self.load_profile(&id, None)?;
            } else {
                self.create_profile(&id, &name, None)?;
            }
        }
        Ok(())
    }

    pub fn change_profile_password(
        &self,
        profile_id: &str,
        current_password: Option<&str>,
        new_password: Option<&str>,
    ) -> Result<(), String> {
        let profile = self
            .profiles
            .get(profile_id)
            .ok_or("ACTIVE_PROFILE_LOCKED")?;
        profile
            .profile_volume
            .as_ref()
            .ok_or("PROFILE_STORAGE_UNAVAILABLE")?
            .change_password(current_password, new_password)
    }

    pub fn verify_profile_password(
        &self,
        profile_id: &str,
        password: Option<&str>,
    ) -> Result<(), String> {
        let profile = self
            .profiles
            .get(profile_id)
            .ok_or("ACTIVE_PROFILE_LOCKED")?;
        profile
            .profile_volume
            .as_ref()
            .ok_or("PROFILE_STORAGE_UNAVAILABLE")?
            .verify_password(password)
    }

    pub fn stop_profile(&mut self, profile_id: &str) -> Result<(), String> {
        if let Some(profile) = self.profiles.remove(profile_id) {
            profile.stop();
            let deadline = Instant::now() + Duration::from_secs(3);
            // The network worker owns a cloned `ToxState` value rather than an
            // `Arc<ToxState>`, so the outer Arc count can already be one while
            // that clone still holds the profile identity guard and native
            // handle. Wait on the shared handle instead before a lifecycle
            // restart attempts to reserve the same identity again.
            while Arc::strong_count(&profile.handle) > 1 && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if Arc::strong_count(&profile.handle) > 1 {
                return Err("PROFILE_RUNTIME_STOP_TIMEOUT".to_string());
            }
            // Dropping the last Arc now performs the final encrypted savedata
            // write and tox_kill before lifecycle code touches the directory.
            drop(profile);
            // The history and compact state writers intentionally batch for a
            // few hundred milliseconds.  A workspace close/archive can remove
            // its tmpfs tree immediately after this method returns, so wait for
            // every write queued before the stopped network worker to finish.
            // Otherwise a late history write recreates the erased directory.
            crate::flush_deferred_profile_writes()?;
        }
        // Native file numbers belong to the stopped toxcore instance. Storage
        // is retained and is rebound from durable metadata after authorization.
        self.file_bridge.forget_profile(profile_id)?;
        Ok(())
    }

    pub fn remove_profile_data(&mut self, profile_id: &str) -> Result<(), String> {
        self.stop_profile(profile_id)?;
        self.file_bridge.forget_profile(profile_id)?;
        let container_path = self.profile_container_path(profile_id)?;
        let directory = container_path.parent().ok_or("PROFILE_PATH_INVALID")?;
        let profiles_root = self.workspace_root.join("profiles");
        if directory.parent() != Some(profiles_root.as_path()) {
            return Err("PROFILE_PATH_INVALID".to_string());
        }
        if directory.exists() {
            fs::remove_dir_all(directory)
                .map_err(|error| format!("Could not remove profile data: {error}"))?;
        }
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        let profile_ids = self.profiles.keys().cloned().collect::<Vec<_>>();
        let mut first_error = None;
        for profile_id in profile_ids {
            if let Err(error) = self.stop_profile(&profile_id) {
                first_error.get_or_insert(error);
            }
        }
        self.tor.stop();
        first_error.map_or(Ok(()), Err)
    }

    pub fn checkpoint_profiles(&self, force: bool) -> Result<(), String> {
        for profile in self.profiles.values() {
            profile.checkpoint_profile(force)?;
        }
        Ok(())
    }

    pub fn export_qtox_profile(
        &self,
        profile_id: &str,
        display_name: &str,
        password: &str,
    ) -> Result<Value, String> {
        if password.is_empty() {
            return Err("PROFILE_PASSWORD_REQUIRED".to_string());
        }
        let profile = self
            .profiles
            .get(profile_id)
            .ok_or_else(|| "ACTIVE_PROFILE_LOCKED".to_string())?;
        let cipher = ProfileCipher::new(password)?;
        let (mut savedata, self_key, friends) = {
            let handle = profile.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
            let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
            let length = unsafe { crate::tox_get_savedata_size(handle.instance.as_ptr()) };
            let mut savedata = vec![0_u8; length];
            unsafe { crate::tox_get_savedata(handle.instance.as_ptr(), savedata.as_mut_ptr()) };
            let mut address = [0_u8; 38];
            unsafe { crate::tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
            let mut self_key = [0_u8; 32];
            self_key.copy_from_slice(&address[..32]);
            let count = unsafe { crate::tox_self_get_friend_list_size(handle.instance.as_ptr()) };
            let mut numbers = vec![0_u32; count];
            unsafe {
                crate::tox_self_get_friend_list(handle.instance.as_ptr(), numbers.as_mut_ptr())
            };
            let friends = numbers
                .into_iter()
                .filter_map(|number| {
                    let mut key = [0_u8; 32];
                    let mut error = 0_i32;
                    unsafe {
                        crate::tox_friend_get_public_key(
                            handle.instance.as_ptr(),
                            number,
                            key.as_mut_ptr(),
                            &mut error,
                        )
                    }
                    .then_some((number, key))
                })
                .collect::<Vec<_>>();
            (savedata, self_key, friends)
        };
        let tox_bytes = cipher.encrypt(&savedata)?;
        crate::wipe_sensitive_bytes(&mut savedata);
        let profile_name = profiles::safe_component(display_name);
        let mut entries = vec![crate::qtox_zip::ZipEntry {
            name: format!("{profile_name}.tox"),
            bytes: tox_bytes,
        }];
        let mut add_avatar = |owner_key: &[u8], path: PathBuf| -> Result<(), String> {
            let Some(name) = crate::qtox_avatar_name(owner_key, &self_key, true) else {
                return Ok(());
            };
            let mut bytes = profiles::read_file(&path)?;
            let encrypted = cipher.encrypt(&bytes)?;
            crate::wipe_sensitive_bytes(&mut bytes);
            entries.push(crate::qtox_zip::ZipEntry {
                name: format!("avatars/{name}"),
                bytes: encrypted,
            });
            Ok(())
        };
        if let Some(path) = crate::current_self_avatar_path(&profile.avatars_dir) {
            add_avatar(&self_key, path)?;
        }
        let avatar_entries = profiles::list(&profile.avatars_dir).unwrap_or_default();
        for (friend_number, key) in friends {
            let prefix = format!("{friend_number}-");
            if let Some(path) = avatar_entries
                .iter()
                .filter(|entry| {
                    entry.is_file
                        && entry.path.file_name().is_some_and(|name| {
                            let name = name.to_string_lossy();
                            name.starts_with(&prefix) && !name.ends_with(".part")
                        })
                        && crate::is_complete_avatar(&entry.path, None)
                })
                .max_by(|left, right| left.path.file_name().cmp(&right.path.file_name()))
                .map(|entry| entry.path.clone())
            {
                add_avatar(&key, path)?;
            }
        }
        entries.push(crate::qtox_zip::ZipEntry {
            name: "README.txt".to_string(),
            bytes: b"qTox-compatible Tox profile exported by Kaigen. Extract the archive before importing the .tox file.\r\n".to_vec(),
        });
        Ok(serde_json::json!({
            "fileName": format!("{profile_name}-qtox.zip"),
            "bytes": crate::qtox_zip::encode(entries)?,
        }))
    }

    pub fn begin_web_outgoing_transfer(
        &mut self,
        domain: &mut WorkspaceDomain,
        profile_id: &str,
        friend_number: u32,
        filename: &str,
        mime: &str,
        size_bytes: u64,
        operation_id: &str,
        expected_sha256: [u8; 32],
        now: u64,
        now_ms: u64,
    ) -> Result<WebTransferView, String> {
        if operation_id.len() != 32
            || !operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err("TRANSFER_OPERATION_INVALID".to_string());
        }
        let store = self
            .file_bridge
            .store
            .get()
            .ok_or("TRANSFER_STORAGE_UNAVAILABLE")?;
        if !store.is_ready() {
            return Err("TRANSFER_STORAGE_BUSY".to_string());
        }
        self.restore_published_web_transfers()?;
        let lease = domain.data_lease.status(now, self.file_bridge.has_active());
        if !lease.new_transfers_allowed {
            return Err("WORKSPACE_LEASE_EXPIRED".to_string());
        }
        let profile = self
            .profiles
            .get(profile_id)
            .cloned()
            .ok_or("PROFILE_NOT_ACTIVE")?;
        let (peer_online, connection_revision) =
            crate::observe_chat_peer_connection(&profile, friend_number)?;
        let (friend_public_key, transaction) =
            crate::lock_chat_transaction_for_friend(&profile, friend_number)?;
        let name = crate::safe_file_name(filename);
        let mime = sanitize_untrusted_text(mime)
            .chars()
            .take(128)
            .collect::<String>();
        if let Some(existing) = self
            .file_bridge
            .operation_transfer(profile_id, operation_id)
        {
            if existing.friend_public_key != friend_public_key
                || existing.name != name
                || existing.mime != mime
                || existing.size_bytes != size_bytes
                || existing.expected_sha256 != Some(expected_sha256)
            {
                return Err("TRANSFER_STORAGE_CONFLICT".to_string());
            }
            return self.file_bridge.view(&existing.object_id, now_ms);
        }
        // Recovery may have published this operation while the native handle
        // was busy. Wait for the existing binding instead of creating a second
        // message for a replay whose first HTTP response was lost.
        if self.file_bridge.store.get().is_some_and(|store| {
            store.snapshot().iter().any(|stored| {
                stored.spec.profile_id == profile_id
                    && stored.spec.operation_id.as_deref() == Some(operation_id)
            })
        }) {
            return Err("TRANSFER_STORAGE_BUSY".to_string());
        }
        if size_bytes == 0 {
            return Err("TRANSFER_EMPTY_FILE".to_string());
        }
        if size_bytes > crate::MAX_CHAT_FILE_BYTES {
            return Err("TRANSFER_FILE_TOO_LARGE".to_string());
        }
        let message_id =
            if profile.chat_protocol.supports(friend_number) || profile.pq.is_v2(friend_number) {
                crate::chat_protocol::new_common_message_id()?
            } else {
                crate::new_message_id(friend_number)
            };
        let transfer_id = self.file_bridge.enqueue_outgoing(
            profile_id,
            friend_number,
            message_id.clone(),
            name.clone(),
            mime.clone(),
            size_bytes,
        )?;
        self.file_bridge.bind_storage(
            &transfer_id,
            StoreSpec {
                object_id: transfer_id.clone(),
                operation_id: Some(operation_id.to_string()),
                profile_id: profile_id.to_string(),
                message_id: message_id.clone(),
                friend_public_key: friend_public_key.clone(),
                direction: StoreDirection::Outgoing,
                name: name.clone(),
                mime: mime.clone(),
                size_bytes,
                expected_sha256: Some(expected_sha256),
            },
        )?;
        self.file_bridge
            .register_queued_outgoing(&mut domain.transfers)?;
        profile.chat_transport_ready.store(false, Ordering::Release);
        let pq_pending = match crate::begin_chat_pq_for_send(
            &profile,
            friend_number,
            &friend_public_key,
            peer_online,
            Some(connection_revision),
            None,
        ) {
            Ok(protected) => protected,
            Err(error) => {
                let _ = self.file_bridge.control_id(&transfer_id, "cancel");
                return Err(error);
            }
        };
        let negotiated = profile.chat_protocol.supports(friend_number)
            || pq_pending && profile.pq.is_v2(friend_number);
        let message = crate::ToxMessage {
            id: message_id.clone(),
            friend_number,
            friend_public_key: friend_public_key.clone(),
            text: String::new(),
            mine: true,
            timestamp: now,
            delivery: "pending".to_string(),
            delivered_at: None,
            attachment: Some(crate::ToxAttachment {
                name,
                size: size_bytes,
                mime,
                path: format!("browser-stream://{transfer_id}"),
                preview_source: None,
                image: crate::is_image_name(filename),
                transferred: 0,
                speed_bytes_per_sec: 0,
                eta_seconds: None,
                transfer_state: "queued".to_string(),
                completed: false,
                completed_at: None,
                transfer_error: None,
                retry_count: 0,
            }),
            event: None,
            protocol_version: negotiated.then_some(crate::chat_protocol::VERSION),
            operation_id: None,
            quote: None,
            formatting: Vec::new(),
            pq_protected: false,
            reactions: None,
        };
        profile
            .messages
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?
            .push(message.clone());
        if profile.history_enabled.load(Ordering::Relaxed) {
            if let Err(error) = crate::write_tox_history_rows_required(
                &[message],
                &profile.history_path,
                &profile.history_enabled,
            ) {
                if let Ok(mut messages) = profile.messages.lock() {
                    messages.retain(|item| item.id != message_id);
                }
                let _ = self.file_bridge.control_id(&transfer_id, "cancel");
                return Err(error);
            }
        }
        crate::commit_chat_transaction_with_barrier(
            &profile.history_path,
            &profile.chat_transport_ready,
        )?;
        crate::bump_chat_view_revision(&profile.history_path, friend_number, &friend_public_key);
        drop(transaction);
        let _ = self.file_bridge.drive_storage()?;
        self.file_bridge.view(&transfer_id, now_ms)
    }

    fn start_next_web_transfer(&mut self) -> Result<(), String> {
        let Some(route) = self.file_bridge.next_to_start() else {
            return Ok(());
        };
        let Some(profile) = self.profiles.get(&route.profile_id).cloned() else {
            self.file_bridge.scheduled_start_failed(&route.id);
            return Err("PROFILE_NOT_ACTIVE".to_string());
        };
        if route.file_number != u32::MAX {
            if resume_web_transfer_with_native_control(
                &profile.handle,
                &profile.file_receive_settings,
                &self.file_bridge,
                &profile.messages,
                &route,
                |tox| {
                    let mut error = 0_i32;
                    unsafe {
                        let _ = crate::tox_file_control(
                            tox,
                            route.friend_number,
                            route.file_number,
                            0,
                            &mut error,
                        );
                    }
                    error
                },
                #[cfg(test)]
                || {},
            )? {
                crate::persist_tox_history(
                    &profile.messages,
                    &profile.history_path,
                    &profile.history_enabled,
                );
            }
            return Ok(());
        }
        if !route.outgoing {
            self.file_bridge.scheduled_start_failed(&route.id);
            return Err("TRANSFER_NOT_STARTED".to_string());
        }
        let Some((name, mime, size_bytes, message_id)) =
            self.file_bridge.outgoing_metadata(&route.id)
        else {
            self.file_bridge.outgoing_start_failed(&route.id);
            return Err("TRANSFER_NOT_FOUND".to_string());
        };
        let friend_public_key = profile.stable_friend_public_key(route.friend_number);
        if !profile.chat_transport_ready.load(Ordering::Acquire)
            || crate::file_chat_transport_waits_for_pq(&profile, route.friend_number)
        {
            self.file_bridge.scheduled_start_failed(&route.id);
            return Ok(());
        }
        let uses_card_protocol = profile.messages.lock().ok().is_some_and(|messages| {
            messages.iter().any(|message| {
                message.id == message_id
                    && message.protocol_version == Some(crate::chat_protocol::VERSION)
            })
        });
        if uses_card_protocol
            && profile
                .file_card_protocol
                .outgoing_offer(route.friend_number, &friend_public_key, &message_id)
                .is_none()
        {
            let (_, _transaction) =
                crate::lock_chat_transaction_for_friend(&profile, route.friend_number)?;
            profile.chat_transport_ready.store(false, Ordering::Release);
            profile.file_card_protocol.offer_for_send(
                route.friend_number,
                &friend_public_key,
                &message_id,
                &name,
                size_bytes,
            )?;
            crate::commit_chat_transaction_with_barrier(
                &profile.history_path,
                &profile.chat_transport_ready,
            )?;
        }
        let protocol_offer = profile.file_card_protocol.outgoing_offer(
            route.friend_number,
            &friend_public_key,
            &message_id,
        );
        if protocol_offer.is_some() {
            if !profile.chat_protocol.supports(route.friend_number) {
                self.file_bridge.scheduled_start_failed(&route.id);
                return Ok(());
            }
            match profile.file_card_protocol.outgoing_acknowledgement(
                route.friend_number,
                &friend_public_key,
                &message_id,
            ) {
                Some(
                    crate::file_card_protocol::FileCardAckStatus::Applied
                    | crate::file_card_protocol::FileCardAckStatus::Duplicate,
                ) => {}
                Some(crate::file_card_protocol::FileCardAckStatus::Rejected) => {
                    let _ = self.file_bridge.control_id(&route.id, "cancel");
                    crate::set_attachment_transfer_error(
                        &profile.messages,
                        &message_id,
                        "Получатель отклонил служебную карточку файла.",
                    );
                    crate::persist_tox_history(
                        &profile.messages,
                        &profile.history_path,
                        &profile.history_enabled,
                    );
                    return Ok(());
                }
                None => {
                    self.file_bridge.scheduled_start_failed(&route.id);
                    return Ok(());
                }
            }
        }
        let file_id = protocol_offer
            .as_ref()
            .map(|offer| offer.transfer_id)
            .unwrap_or(random_array::<32>()?);
        offer_web_transfer_with_native_send(
            &profile.handle,
            &self.file_bridge,
            &profile.messages,
            &profile.outgoing_files,
            &route,
            &message_id,
            crate::OutgoingFile {
                path: PathBuf::new(),
                filename: name,
                mime,
                size: size_bytes,
                source_bytes: None,
                message_id: Some(message_id.clone()),
                protocol_transfer_id: protocol_offer.map(|offer| offer.transfer_id),
                meter: crate::TransferMeter::new(),
                last_activity_at: std::time::Instant::now(),
                active: true,
                locally_paused: false,
                phase: crate::OutgoingFilePhase::WaitingForAcceptance,
                fully_sent: false,
                retry_count: 0,
                web_transfer_id: Some(route.id.clone()),
            },
            |tox, transfer| {
                // The scheduler may have waited for the native handle while a
                // callback started negotiation or closing. Match the network
                // worker's handle -> transaction lock order and recheck here.
                let Ok(_transaction) = profile.chat_transaction_gate.lock() else {
                    return (0, -1);
                };
                if !profile.chat_transport_ready.load(Ordering::Acquire)
                    || crate::file_chat_transport_waits_for_pq(&profile, route.friend_number)
                {
                    return (0, -1);
                }
                let mut error = 0_i32;
                let file_number = unsafe {
                    crate::tox_file_send(
                        tox,
                        route.friend_number,
                        0,
                        transfer.size,
                        file_id.as_ptr(),
                        transfer.filename.as_bytes().as_ptr(),
                        transfer.filename.len(),
                        &mut error,
                    )
                };
                (file_number, error)
            },
            #[cfg(test)]
            || {},
        )
    }

    fn finalize_web_transfer_terminal(
        &mut self,
        domain: &mut WorkspaceDomain,
        view: &WebTransferView,
        completed_at: u64,
    ) -> Result<(), String> {
        if !matches!(view.state.as_str(), "complete" | "cancelled" | "failed")
            || self.file_bridge.terminal_reconciled(&view.id)
        {
            return Ok(());
        }
        if view.state == "failed" {
            if let Some(profile) = self.profiles.get(&view.profile_id) {
                // Stop a native stream whose storage failed before releasing
                // its slot. The retained committed source remains downloadable.
                if let Some((route, control)) = self.file_bridge.failed_native_control(&view.id) {
                    let handle = profile.handle.lock().map_err(|_| "TOX_BUSY")?;
                    if let Some(handle) = handle.as_ref() {
                        let mut error = 0;
                        unsafe {
                            let _ = crate::tox_file_control(
                                handle.instance.as_ptr(),
                                route.friend_number,
                                route.file_number,
                                control,
                                &mut error,
                            );
                        }
                    }
                }
                crate::set_attachment_transfer_state(&profile.messages, &view.message_id, "failed");
                crate::persist_tox_history(
                    &profile.messages,
                    &profile.history_path,
                    &profile.history_enabled,
                );
            }
        }
        if domain.transfers.contains(&view.id) {
            if view.state == "complete" {
                let _ = domain.transfers.complete_stream(&view.id);
            } else {
                let _ = domain.transfers.cancel(&view.id);
            }
        }
        if view.state == "complete" {
            if let Some(profile) = self.profiles.get(&view.profile_id) {
                let needs_message_update = profile
                    .messages
                    .lock()
                    .ok()
                    .and_then(|messages| {
                        messages
                            .iter()
                            .find(|message| message.id == view.message_id)
                            .and_then(|message| message.attachment.as_ref())
                            .map(|attachment| {
                                !attachment.completed || attachment.transfer_state != "complete"
                            })
                    })
                    .unwrap_or(false);
                if needs_message_update {
                    crate::update_attachment_progress(
                        &profile.messages,
                        &view.message_id,
                        view.size_bytes,
                        0,
                        view.size_bytes,
                        "complete",
                        true,
                        Some(completed_at),
                    );
                    if view.direction == "outgoing" {
                        if let Ok(mut messages) = profile.messages.lock() {
                            if let Some(message) = messages
                                .iter_mut()
                                .find(|message| message.id == view.message_id)
                            {
                                message.delivery = "delivered".to_string();
                                message.delivered_at = Some(completed_at);
                            }
                        }
                    }
                    crate::persist_tox_history(
                        &profile.messages,
                        &profile.history_path,
                        &profile.history_enabled,
                    );
                }
            }
        }
        if matches!(view.state.as_str(), "complete" | "cancelled" | "failed") {
            if let Some(profile) = self.profiles.get(&view.profile_id) {
                let friend_number = profile.messages.lock().ok().and_then(|messages| {
                    messages
                        .iter()
                        .find(|message| message.id == view.message_id)
                        .map(|message| message.friend_number)
                });
                if let Some(friend_number) = friend_number {
                    crate::finish_file_card_runtime_state(
                        &profile.messages,
                        &profile.history_residency,
                        &profile.file_card_protocol,
                        friend_number,
                        &view.message_id,
                    );
                }
            }
        }
        if let Some(profile) = self.profiles.get(&view.profile_id) {
            // A restored receipt may complete an evicted history row. Force
            // snapshots to apply the same durable outcome even with history off.
            if let Some((friend_number, public_key)) = self.file_bridge.history_target(&view.id) {
                crate::bump_chat_view_revision(&profile.history_path, friend_number, &public_key);
            }
        }
        self.file_bridge.acknowledge_terminal(&view.id);
        Ok(())
    }

    fn drain_web_outgoing_transfer(
        &mut self,
        domain: &mut WorkspaceDomain,
        transfer_id: &str,
        now: u64,
        now_ms: u64,
    ) -> Result<u64, String> {
        let profile_id = self.file_bridge.outgoing_profile_id(transfer_id)?;
        let profile = self
            .profiles
            .get(&profile_id)
            .cloned()
            .ok_or("PROFILE_NOT_ACTIVE")?;
        let mut accepted_bytes = 0_usize;
        let mut retry_after_ms = 0_u64;
        let mut send_error = 0_i32;
        {
            // A committed source range is staged in the bounded bridge buffer.
            // Holding the tox handle while draining keeps the native requests
            // ordered, while SENDQ leaves the unsent suffix in that buffer
            // instead of rereading an already buffered range.
            let handle = profile.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
            let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
            loop {
                let (chunk, wait_ms) = self.file_bridge.next_outgoing_chunk(transfer_id, now_ms)?;
                retry_after_ms = retry_after_ms.max(wait_ms);
                let Some(chunk) = chunk else {
                    break;
                };
                if chunk.routing.profile_id != profile_id {
                    self.file_bridge.outgoing_chunk_rejected(chunk.data.len());
                    return Err("TRANSFER_WORKSPACE_BOUNDARY".to_string());
                }
                let mut error = 0_i32;
                let sent = unsafe {
                    crate::tox_file_send_chunk(
                        handle.instance.as_ptr(),
                        chunk.routing.friend_number,
                        chunk.routing.file_number,
                        chunk.position,
                        chunk.data.as_ptr(),
                        chunk.data.len(),
                        &mut error,
                    )
                };
                if !sent || error != 0 {
                    self.file_bridge.outgoing_chunk_rejected(chunk.data.len());
                    send_error = if error == 0 { -1 } else { error };
                    break;
                }
                self.file_bridge.outgoing_chunk_sent(
                    transfer_id,
                    chunk.position,
                    chunk.data.len(),
                    now_ms,
                )?;
                accepted_bytes = accepted_bytes.saturating_add(chunk.data.len());
            }
        }
        if accepted_bytes > 0 {
            if let Some((message_id, transferred, size, speed)) =
                self.file_bridge.progress_with_speed(transfer_id)
            {
                publish_web_outgoing_progress(
                    &profile.messages,
                    &message_id,
                    transferred,
                    speed,
                    size,
                );
                crate::bump_history_revision(&profile.history_path);
            }
            domain
                .transfers
                .record_stream_progress(transfer_id, accepted_bytes as u64, now)?;
            domain.data_lease.record_transfer_progress(now);
        }
        if send_error == TOX_FILE_SEND_CHUNK_SENDQ {
            retry_after_ms = retry_after_ms.max(50);
        } else if matches!(
            send_error,
            TOX_FILE_SEND_CHUNK_NOT_TRANSFERRING
                | TOX_FILE_SEND_CHUNK_INVALID_LENGTH
                | TOX_FILE_SEND_CHUNK_WRONG_POSITION
        ) {
            return Err("TRANSFER_CHUNK_STALE".to_string());
        } else if send_error != 0 {
            return Err("TRANSFER_CHUNK_REJECTED".to_string());
        }
        Ok(retry_after_ms)
    }

    pub fn web_transfer_status(
        &mut self,
        domain: &mut WorkspaceDomain,
        transfer_id: &str,
        now: u64,
        now_ms: u64,
    ) -> Result<WebTransferView, String> {
        self.reconcile_web_transfer_terminal(domain, now, now_ms)?;
        let before = self.file_bridge.view(transfer_id, now_ms)?;
        if before.direction == "outgoing" && before.state == "sending" && before.buffered_bytes > 0
        {
            let _ = self.drain_web_outgoing_transfer(domain, transfer_id, now, now_ms)?;
        }
        let view = self.file_bridge.view(transfer_id, now_ms)?;
        self.finalize_web_transfer_terminal(domain, &view, now)?;
        Ok(view)
    }

    fn restore_published_web_transfers(&self) -> Result<(), String> {
        let Some(store) = self.file_bridge.store.get() else {
            return Ok(());
        };
        if !store.is_ready() {
            return Ok(());
        }
        for status in store.snapshot() {
            if self
                .file_bridge
                .storage_spec(&status.spec.object_id)
                .is_some()
            {
                continue;
            }
            let Some(profile) = self.profiles.get(&status.spec.profile_id) else {
                continue;
            };
            let friend_number = {
                let handle = match profile.handle.try_lock() {
                    Ok(handle) => handle,
                    Err(_) => continue,
                };
                let Some(handle) = handle.as_ref() else {
                    continue;
                };
                let Some(friend_number) = crate::resolve_current_friend_number(
                    handle.instance.as_ptr(),
                    &status.spec.friend_public_key,
                ) else {
                    continue;
                };
                friend_number
            };
            let resident_completion = {
                let messages = profile
                    .messages
                    .lock()
                    .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
                messages
                    .iter()
                    .find(|message| message.id == status.spec.message_id)
                    .map(|message| transfer_history_completed(message, &status.spec))
                    .transpose()?
            };
            let sent_complete = match (status.native_delivery_confirmed, resident_completion) {
                (Some(confirmed), _) => confirmed,
                (None, Some(completed)) => completed,
                (None, None) if status.spec.direction == StoreDirection::Outgoing => {
                    let Some(completed) = self.file_bridge.historical_completion(
                        &profile.history_path,
                        friend_number,
                        &status.spec,
                    )?
                    else {
                        continue;
                    };
                    completed
                }
                (None, None) => false,
            };
            let object_id = status.spec.object_id.clone();
            self.file_bridge
                .restore_storage(status, friend_number, sent_complete)?;
            self.file_bridge
                .history_probes
                .lock()
                .map_err(|_| "TRANSFER_HISTORY_UNAVAILABLE")?
                .remove(&object_id);
        }
        Ok(())
    }

    pub fn reconcile_web_transfer_terminal(
        &mut self,
        domain: &mut WorkspaceDomain,
        now: u64,
        now_ms: u64,
    ) -> Result<bool, String> {
        let mut changed = false;
        let detached = domain
            .transfers
            .offers()
            .filter(|offer| !self.profiles.contains_key(&offer.profile_id))
            .map(|offer| offer.id.clone())
            .collect::<Vec<_>>();
        for id in detached {
            domain.transfers.forget(&id);
            changed = true;
        }
        self.restore_published_web_transfers()?;
        for profile in self.profiles.values() {
            if crate::incoming_files_denied(&profile.file_receive_settings) {
                let handle = profile.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
                if !crate::incoming_files_denied(&profile.file_receive_settings) {
                    continue;
                }
                let tox = handle
                    .as_ref()
                    .map(|handle| handle.instance.as_ptr())
                    .unwrap_or(std::ptr::null_mut());
                changed |= crate::cancel_incoming_receives_for_policy(profile, tox)?;
            }
        }
        changed |= self
            .file_bridge
            .register_queued_outgoing(&mut domain.transfers)?;
        let storage_result = self.file_bridge.drive_storage();
        // A queued upload can fail before it ever owns the native slot.
        // Reconcile every newly terminal object once, including that case.
        if storage_result.is_err() {
            for id in self.file_bridge.unreconciled_terminal_ids() {
                let view = self.file_bridge.view(&id, now_ms)?;
                self.finalize_web_transfer_terminal(domain, &view, now)?;
            }
        }
        let progress = storage_result?;
        for (id, resume, released) in progress {
            if let Some(route) = resume {
                if let Some(profile) = self.profiles.get(&route.profile_id) {
                    let handle = profile.handle.lock().map_err(|_| "TOX_BUSY")?;
                    if let Some(handle) = handle.as_ref() {
                        let mut error = 0;
                        unsafe {
                            let _ = crate::tox_file_control(
                                handle.instance.as_ptr(),
                                route.friend_number,
                                route.file_number,
                                0,
                                &mut error,
                            );
                        }
                    }
                }
            }
            let view = self.file_bridge.view(&id, now_ms)?;
            if matches!(view.state.as_str(), "cancelled" | "failed") {
                continue;
            }
            if view.direction == "incoming" {
                if let Some(profile) = self.profiles.get(&view.profile_id) {
                    if view.state != "complete" {
                        crate::update_attachment_progress(
                            &profile.messages,
                            &view.message_id,
                            view.persisted_bytes,
                            view.speed_bytes_per_sec,
                            view.size_bytes,
                            &view.state,
                            false,
                            None,
                        );
                        // Progress is intentionally not persisted to chat history.
                        // Invalidate the contact snapshot so knownRevision cannot
                        // hide these durable bytes until the terminal history write.
                        if let Some((friend_number, public_key)) =
                            self.file_bridge.history_target(&id)
                        {
                            crate::bump_chat_view_revision(
                                &profile.history_path,
                                friend_number,
                                &public_key,
                            );
                        }
                    }
                    crate::bump_history_revision(&profile.history_path);
                }
                if domain.transfers.contains(&id) {
                    let _ = domain.transfers.record_stream_progress(&id, released, now);
                }
                domain.data_lease.record_transfer_progress(now);
            } else if view.payload_committed
                && matches!(view.state.as_str(), "queued" | "starting" | "sending")
                && !domain.transfers.contains(&id)
            {
                domain.transfers.offer(TransferOffer {
                    id: id.clone(),
                    profile_id: view.profile_id,
                    direction: TransferDirection::Outgoing,
                    size_bytes: view.size_bytes,
                    state: TransferState::Queued,
                    transferred_bytes: 0,
                    last_progress_at: None,
                })?;
                changed = true;
            }
        }
        if self.file_bridge.store.get().is_some() {
            let offers = self.file_bridge.background_entries(&self.profiles)?;
            for offer in offers
                .into_iter()
                .filter(|offer| offer.state == "offered" && offer.auto_accept)
            {
                if domain
                    .data_lease
                    .status(now, self.file_bridge.has_active())
                    .new_transfers_allowed
                {
                    self.control_web_transfer(
                        domain,
                        &offer.profile_id,
                        &offer.message_id,
                        "resume",
                        now_ms,
                    )?;
                    changed = true;
                }
            }
        }
        for id in self.file_bridge.unreconciled_terminal_ids() {
            let view = self.file_bridge.view(&id, now_ms)?;
            self.finalize_web_transfer_terminal(domain, &view, now)?;
            changed = true;
        }
        self.start_next_web_transfer()?;
        if let Some(transfer_id) = self.file_bridge.active_outgoing_id() {
            let _ = self.drain_web_outgoing_transfer(domain, &transfer_id, now, now_ms)?;
        }
        Ok(changed)
    }

    pub fn upload_web_transfer_chunk(
        &mut self,
        domain: &mut WorkspaceDomain,
        profile_id: &str,
        transfer_id: &str,
        position: u64,
        data: &[u8],
        now: u64,
        now_ms: u64,
    ) -> Result<WebUploadOutcome, String> {
        let transfer_profile_id = self.file_bridge.outgoing_profile_id(transfer_id)?;
        ensure_transfer_profile(&transfer_profile_id, profile_id)?;
        if !self.profiles.contains_key(profile_id) {
            return Err("PROFILE_NOT_ACTIVE".to_string());
        }
        let view = self.file_bridge.view(transfer_id, now_ms)?;
        if data.is_empty()
            || data.len() > FRAME_STREAM_CHUNK_BYTES
            || position
                .checked_add(data.len() as u64)
                .is_none_or(|end| end > view.size_bytes)
        {
            return Err("TRANSFER_CHUNK_RANGE_INVALID".to_string());
        }
        if matches!(view.state.as_str(), "cancelled" | "failed" | "paused") {
            return Err("TRANSFER_NOT_RESUMABLE".to_string());
        }
        let reply = self.file_bridge.storage_operation(StoreOperation::Append {
            object_id: transfer_id.to_string(),
            offset: position,
            bytes: Arc::from(data),
        })?;
        self.reconcile_web_transfer_terminal(domain, now, now_ms)?;
        let retry_after_ms = if reply.is_none() { 100 } else { 0 };
        Ok(WebUploadOutcome {
            retry_after_ms,
            transfer: self.file_bridge.view(transfer_id, now_ms)?,
        })
    }

    pub fn control_web_transfer(
        &mut self,
        domain: &mut WorkspaceDomain,
        profile_id: &str,
        message_id: &str,
        action: &str,
        now_ms: u64,
    ) -> Result<WebTransferView, String> {
        let transfer_id = self
            .file_bridge
            .id_for_profile_message(profile_id, message_id)
            .ok_or("TRANSFER_NOT_FOUND")?;
        let before = self.file_bridge.view(&transfer_id, now_ms)?;
        ensure_transfer_profile(&before.profile_id, profile_id)?;
        match action {
            "resume" if matches!(before.state.as_str(), "complete" | "cancelled" | "failed") => {
                return Err("TRANSFER_NOT_RESUMABLE".to_string())
            }
            "pause" if matches!(before.state.as_str(), "complete" | "cancelled" | "failed") => {
                return Err("TRANSFER_NOT_PAUSABLE".to_string())
            }
            "cancel" if before.state == "complete" => {
                return Err("TRANSFER_ALREADY_COMPLETE".to_string())
            }
            "resume" | "pause" | "cancel" => {}
            _ => return Err("TRANSFER_ACTION_INVALID".to_string()),
        }
        let profile = self
            .profiles
            .get(profile_id)
            .cloned()
            .ok_or("PROFILE_NOT_ACTIVE")?;
        // Policy changes, EOF and user control share this callback boundary.
        let native_handle = profile.handle.lock().map_err(|_| "TOX_BUSY")?;
        if action == "resume"
            && before.direction == "incoming"
            && crate::incoming_files_denied(&profile.file_receive_settings)
        {
            return Err("FILE_RECEIVE_DENIED".to_string());
        }
        if action == "resume"
            && before.direction == "incoming"
            && self.file_bridge.store.get().is_some()
            && self.file_bridge.storage_spec(&transfer_id).is_none()
        {
            let profile = self.profiles.get(profile_id).ok_or("PROFILE_NOT_ACTIVE")?;
            let friend_number = profile
                .messages
                .lock()
                .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?
                .iter()
                .find(|message| message.id == message_id)
                .map(|message| message.friend_number)
                .ok_or("TRANSFER_NOT_FOUND")?;
            // This control boundary already owns the native handle. Resolving
            // through stable_friend_public_key would lock the same mutex again.
            let friend_public_key = native_handle
                .as_ref()
                .and_then(|handle| {
                    crate::tox_friend_public_key(handle.instance.as_ptr(), friend_number)
                })
                .unwrap_or_default();
            self.file_bridge.bind_storage(
                &transfer_id,
                StoreSpec {
                    object_id: transfer_id.clone(),
                    operation_id: None,
                    profile_id: profile_id.to_string(),
                    message_id: message_id.to_string(),
                    friend_public_key,
                    direction: StoreDirection::Incoming,
                    name: before.name.clone(),
                    mime: before.mime.clone(),
                    size_bytes: before.size_bytes,
                    expected_sha256: None,
                },
            )?;
        }
        self.file_bridge
            .ensure_delivery_control_allowed(&transfer_id)?;
        if action == "resume" && !domain.transfers.contains(&transfer_id) {
            domain.transfers.offer(TransferOffer {
                id: transfer_id.clone(),
                profile_id: before.profile_id.clone(),
                direction: if before.direction == "outgoing" {
                    TransferDirection::Outgoing
                } else {
                    TransferDirection::Incoming
                },
                size_bytes: before.size_bytes,
                state: TransferState::Offered,
                transferred_bytes: 0,
                last_progress_at: None,
            })?;
        }
        match action {
            "resume" if before.direction == "incoming" && before.state == "offered" => {
                domain.transfers.accept(&transfer_id)?;
            }
            "resume" => {
                let _ = domain.transfers.resume(&transfer_id);
            }
            "pause" => {
                let _ = domain.transfers.pause(&transfer_id);
            }
            "cancel" => {
                let _ = domain.transfers.cancel(&transfer_id);
            }
            _ => return Err("TRANSFER_ACTION_INVALID".to_string()),
        }
        let route = self.file_bridge.control_id(&transfer_id, action)?;
        if action != "resume" {
            if route.file_number != u32::MAX {
                let control = match action {
                    "pause" => 1,
                    "cancel" => 2,
                    _ => unreachable!(),
                };
                let handle = native_handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
                let error = web_user_file_control(
                    handle.instance.as_ptr(),
                    route.friend_number,
                    route.file_number,
                    control,
                );
                // Before peer acceptance toxcore is already paused. The local
                // pause still owns the bridge/card latch and must succeed.
                if error != 0
                    && !(action == "pause" && error == TOX_FILE_CONTROL_ALREADY_PAUSED)
                    && action != "cancel"
                {
                    return Err("TRANSFER_CONTROL_REJECTED".to_string());
                }
            }
            // A queued transfer has no native file number yet, but its card is
            // still terminal immediately when the user cancels it. Keeping the
            // message update outside the native-control branch prevents a
            // permanently spinning "queued" card for cancelled middle/last
            // items in a batch.
            crate::set_attachment_transfer_state(
                &profile.messages,
                message_id,
                match action {
                    "pause" => "paused",
                    "cancel" => "cancelled",
                    _ => unreachable!(),
                },
            );
        }
        drop(native_handle);
        if action != "resume" {
            crate::persist_tox_history(
                &profile.messages,
                &profile.history_path,
                &profile.history_enabled,
            );
        }
        self.start_next_web_transfer()?;
        self.file_bridge.view(&transfer_id, now_ms)
    }

    pub fn take_web_incoming_chunk(
        &mut self,
        domain: &mut WorkspaceDomain,
        transfer_id: &str,
        position: u64,
        length: usize,
        now: u64,
        now_ms: u64,
    ) -> Result<Option<WebIncomingChunk>, String> {
        if self.file_bridge.store.get().is_some() {
            let view = self.file_bridge.view(transfer_id, now_ms)?;
            if length == 0
                || length > FRAME_STREAM_CHUNK_BYTES
                || position
                    .checked_add(length as u64)
                    .is_none_or(|end| end > view.size_bytes)
            {
                return Err("TRANSFER_CHUNK_RANGE_INVALID".to_string());
            }
            if !view.payload_committed || !view.download_available {
                return Ok(None);
            }
            let reply = self
                .file_bridge
                .storage_operation(StoreOperation::ReadRange {
                    object_id: transfer_id.to_string(),
                    offset: position,
                    length,
                })?;
            return match reply {
                Some(StoreReply::Range {
                    status,
                    offset,
                    bytes,
                }) if status.spec.object_id == transfer_id
                    && status.phase == StorePhase::Committed
                    && offset == position
                    && bytes.len() == length =>
                {
                    Ok(Some(WebIncomingChunk {
                        position,
                        data: bytes.to_vec(),
                        transfer: view,
                    }))
                }
                Some(_) => Err("TRANSFER_STORAGE_CONFLICT".to_string()),
                None => Ok(None),
            };
        }
        let chunk = self.file_bridge.take_incoming_chunk(transfer_id)?;
        let view = self.file_bridge.view(transfer_id, now_ms)?;
        self.finalize_web_transfer_terminal(domain, &view, now)?;
        let Some((position, data)) = chunk else {
            return Ok(None);
        };
        Ok(Some(WebIncomingChunk {
            position,
            data,
            transfer: view,
        }))
    }

    pub fn acknowledge_web_incoming_chunk(
        &mut self,
        domain: &mut WorkspaceDomain,
        profile_id: &str,
        transfer_id: &str,
        through: u64,
        now: u64,
        now_ms: u64,
    ) -> Result<WebTransferView, String> {
        let before = self.file_bridge.view(transfer_id, now_ms)?;
        ensure_transfer_profile(&before.profile_id, profile_id)?;
        if before.direction != "incoming" {
            return Err("TRANSFER_DIRECTION_INVALID".to_string());
        }
        if self.file_bridge.store.get().is_some() {
            if through > before.persisted_bytes {
                return Err("TRANSFER_ACK_RANGE_INVALID".to_string());
            }
            // Legacy endpoint is a consumer observation only. It cannot release
            // native buffers, advance native completion or remove retained data.
            return Ok(before);
        }
        let (resume_route, acknowledged) = self
            .file_bridge
            .acknowledge_incoming_chunk(transfer_id, through)?;
        if let Some(route) = resume_route {
            if let Some(profile) = self.profiles.get(&route.profile_id) {
                if let Ok(handle) = profile.handle.lock() {
                    if let Some(handle) = handle.as_ref() {
                        let mut error = 0_i32;
                        unsafe {
                            let _ = crate::tox_file_control(
                                handle.instance.as_ptr(),
                                route.friend_number,
                                route.file_number,
                                0,
                                &mut error,
                            );
                        }
                    }
                }
            }
        }
        let view = self.file_bridge.view(transfer_id, now_ms)?;
        if let Some(profile) = self.profiles.get(profile_id) {
            crate::update_attachment_progress(
                &profile.messages,
                &view.message_id,
                view.acknowledged_bytes,
                view.speed_bytes_per_sec,
                view.size_bytes,
                "receiving",
                false,
                None,
            );
            crate::bump_history_revision(&profile.history_path);
        }
        self.finalize_web_transfer_terminal(domain, &view, now)?;
        if domain.transfers.contains(transfer_id) {
            let _ = domain
                .transfers
                .record_stream_progress(transfer_id, acknowledged, now);
        }
        domain.data_lease.record_transfer_progress(now);
        Ok(view)
    }

    pub fn complete_web_incoming_transfer(
        &mut self,
        domain: &mut WorkspaceDomain,
        profile_id: &str,
        transfer_id: &str,
        browser_bytes: u64,
        browser_sha256: [u8; 32],
        now: u64,
        now_ms: u64,
    ) -> Result<WebTransferView, String> {
        let before = self.file_bridge.view(transfer_id, now_ms)?;
        ensure_transfer_profile(&before.profile_id, profile_id)?;
        if before.direction != "incoming" {
            return Err("TRANSFER_DIRECTION_INVALID".to_string());
        }
        if self.file_bridge.store.get().is_some() {
            if !before.payload_committed
                || browser_bytes != before.size_bytes
                || before.payload_sha256.as_deref()
                    != Some(URL_SAFE_NO_PAD.encode(browser_sha256).as_str())
            {
                return Err("TRANSFER_BROWSER_NOT_COMPLETE".to_string());
            }
            return Ok(before);
        }
        self.file_bridge.confirm_incoming_complete(transfer_id)?;
        let view = self.file_bridge.view(transfer_id, now_ms)?;
        self.finalize_web_transfer_terminal(domain, &view, now)?;
        Ok(view)
    }

    pub fn pause_web_transfer(&self, domain: &mut WorkspaceDomain) {
        domain.transfers.on_ui_lost();
        let Some(route) = self.file_bridge.pause_active() else {
            return;
        };
        if let Some(profile) = self.profiles.get(&route.profile_id) {
            if let Ok(handle) = profile.handle.lock() {
                if let Some(handle) = handle.as_ref() {
                    let mut error = 0_i32;
                    unsafe {
                        let _ = crate::tox_file_control(
                            handle.instance.as_ptr(),
                            route.friend_number,
                            route.file_number,
                            1,
                            &mut error,
                        );
                    }
                }
            }
        }
    }

    pub fn web_transfer_active(&self) -> bool {
        self.file_bridge.has_active()
    }

    pub fn selected_profile_export_material(
        &self,
        domain: &WorkspaceDomain,
    ) -> Result<WebProfileExportMaterial, String> {
        let profile_id = domain
            .profiles
            .selected_profile_id()
            .ok_or("PROFILE_NOT_SELECTED")?;
        let profile_record = domain
            .profiles
            .profiles()
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or("PROFILE_NOT_FOUND")?;
        let profile = self.profiles.get(profile_id).ok_or("PROFILE_NOT_ACTIVE")?;
        let savedata = {
            let handle = profile.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
            let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
            let size = unsafe { crate::tox_get_savedata_size(handle.instance.as_ptr()) };
            if size == 0 {
                return Err("PROFILE_EXPORT_EMPTY".to_string());
            }
            let mut savedata = vec![0_u8; size];
            unsafe {
                crate::tox_get_savedata(handle.instance.as_ptr(), savedata.as_mut_ptr());
            }
            savedata
        };
        let volume = profile
            .profile_volume
            .as_ref()
            .ok_or("KAI_PROFILE_VOLUME_REQUIRED")?;
        let mut profile_files = Vec::new();
        for (path, bytes) in volume.snapshot_plain_files(volume.namespace_root())? {
            let relative = path
                .strip_prefix(volume.namespace_root())
                .map_err(|_| "PROFILE_EXPORT_PATH_INVALID")?;
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative == "profile.tox"
                || relative == "data/logs"
                || relative.starts_with("data/logs/")
            {
                continue;
            }
            if relative.is_empty()
                || relative
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err("PROFILE_EXPORT_PATH_INVALID".to_string());
            }
            profile_files.push(WebProfileExportFile {
                path: relative,
                bytes,
            });
        }
        profile_files.sort_by(|left, right| left.path.cmp(&right.path));
        let metadata_json = serde_json::to_vec(&serde_json::json!({
            "formatVersion": 1,
            "profileId": profile_id,
            "displayName": profile_record.display_name,
        }))
        .map_err(|_| "PROFILE_EXPORT_METADATA_INVALID".to_string())?;
        let proxy = self
            .proxy_settings
            .lock()
            .map_err(|_| "PROXY_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        let network = self
            .network_settings
            .lock()
            .map_err(|_| "NETWORK_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        let settings_json = serde_json::to_vec(&serde_json::json!({
            "formatVersion": 1,
            "language": domain.language,
            "tor": self.tor.settings(),
            "proxy": proxy,
            "network": network,
        }))
        .map_err(|_| "PROFILE_EXPORT_SETTINGS_INVALID".to_string())?;
        Ok(WebProfileExportMaterial {
            profile_files,
            savedata,
            metadata_json,
            settings_json,
        })
    }

    pub fn profile_loaded(&self, profile_id: &str) -> bool {
        self.profiles.contains_key(profile_id)
    }

    pub fn profile_avatar(&self, profile_id: &str) -> Option<String> {
        let profile = self.profiles.get(profile_id)?;
        let path = profile.history_path.parent()?.join("local-state.json");
        let local_state = profiles::read_file(&path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Value>(&contents).ok());
        crate::preferred_profile_avatar(Some(profile), local_state.as_ref())
    }

    pub fn set_profile_avatar(
        &self,
        profile_id: &str,
        data_url: Option<String>,
        filename: Option<String>,
        bytes: Option<Vec<u8>>,
    ) -> Result<usize, String> {
        let update = crate::validate_profile_avatar_update(data_url, filename, bytes)?;
        let profile = self.profiles.get(profile_id).ok_or("PROFILE_NOT_LOADED")?;
        let path = crate::profile_local_state_path(profile)?;
        let started = match update {
            crate::ProfileAvatarUpdate::Set {
                data_url,
                filename,
                bytes,
            } => {
                let started = crate::send_tox_avatar_for_shared_state(profile, filename, bytes);
                crate::write_profile_avatar_local_state(
                    &profile.local_state_lock,
                    &path,
                    Some(&data_url),
                )?;
                started?
            }
            crate::ProfileAvatarUpdate::Clear => {
                crate::remove_self_avatar_files(&profile.avatars_dir)?;
                let started = crate::send_tox_avatar_removal_for_shared_state(profile);
                crate::write_profile_avatar_local_state(&profile.local_state_lock, &path, None)?;
                started?
            }
        };
        if let Some(updates) = &profile.updates {
            updates.changed();
        }
        Ok(started)
    }

    pub fn send_profile_avatar(
        &self,
        profile_id: &str,
        filename: &str,
        bytes: Vec<u8>,
    ) -> Result<usize, String> {
        let profile = self.profiles.get(profile_id).ok_or("PROFILE_LOCKED")?;
        crate::send_tox_avatar_for_shared_state(profile, filename.to_string(), bytes)
    }

    pub fn profile_connection(&self, profile_id: &str) -> &'static str {
        self.profiles
            .get(profile_id)
            .map(|profile| match profile.connection.load(Ordering::Relaxed) {
                1 => "tcp",
                2 => "udp",
                _ => "offline",
            })
            .unwrap_or("locked")
    }

    pub fn apply_effective_presence(
        &self,
        domain: &WorkspaceDomain,
        ui_has_heartbeat: bool,
    ) -> Result<(), String> {
        for web_profile in domain
            .profiles
            .profiles()
            .iter()
            .filter(|profile| profile.active)
        {
            let Some(profile) = self.profiles.get(&web_profile.id) else {
                continue;
            };
            let effective = domain
                .profiles
                .effective_presence(&web_profile.id, ui_has_heartbeat)?;
            crate::set_user_status_inner(profile, presence_name(effective))?;
        }
        Ok(())
    }

    fn normalize_web_file_settings(profile: &ToxState) -> Result<(), String> {
        let mut settings = profile
            .file_receive_settings
            .lock()
            .map_err(|_| "FILE_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        settings.max_auto_bytes = settings.max_auto_bytes.min(crate::MAX_CHAT_FILE_BYTES);
        settings.max_concurrent = settings.max_concurrent.clamp(1, 2);
        let encoded = serde_json::to_vec(&settings)
            .map_err(|error| format!("Could not encode web file policy: {error}"))?;
        profiles::atomic_write(&profile.file_receive_settings_path, &encoded)?;
        *profile
            .file_receive_settings
            .lock()
            .map_err(|_| "FILE_SETTINGS_UNAVAILABLE".to_string())? = settings;
        Ok(())
    }

    pub fn tor_status(&self) -> Result<Value, String> {
        serde_json::to_value(self.tor.status())
            .map_err(|error| format!("Could not encode Tor status: {error}"))
    }

    pub fn tor_settings(&self) -> Result<Value, String> {
        serde_json::to_value(self.tor.settings())
            .map_err(|error| format!("Could not encode Tor settings: {error}"))
    }

    pub fn apply_tor_settings(&self, value: Value) -> Result<Value, String> {
        let settings =
            serde_json::from_value(value).map_err(|_| "TOR_SETTINGS_INVALID".to_string())?;
        let status = self.tor.apply_settings(settings)?;
        for profile in self.profiles.values() {
            profile.rebuild_network_route()?;
        }
        serde_json::to_value(status).map_err(|error| error.to_string())
    }

    pub fn restart_tor(&self) -> Result<Value, String> {
        let status = self.tor.restart()?;
        for profile in self.profiles.values() {
            profile.rebuild_network_route()?;
        }
        serde_json::to_value(status).map_err(|error| error.to_string())
    }

    pub fn proxy_settings(&self) -> Result<Value, String> {
        let settings = self
            .proxy_settings
            .lock()
            .map_err(|_| "PROXY_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        serde_json::to_value(settings).map_err(|error| error.to_string())
    }

    pub fn apply_proxy_settings(&self, value: Value) -> Result<Value, String> {
        let mut settings: ProxySettings =
            serde_json::from_value(value).map_err(|_| "PROXY_SETTINGS_INVALID".to_string())?;
        settings.host = settings.host.trim().to_string();
        if !matches!(settings.mode.as_str(), "none" | "socks5" | "http")
            || (settings.mode != "none" && (settings.host.is_empty() || settings.port == 0))
            || settings.username.len() > 255
            || settings.password.len() > 255
        {
            return Err("PROXY_SETTINGS_INVALID".to_string());
        }
        let previous = self
            .proxy_settings
            .lock()
            .map_err(|_| "PROXY_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        if previous == settings {
            return serde_json::to_value(settings).map_err(|error| error.to_string());
        }
        *self
            .proxy_settings
            .lock()
            .map_err(|_| "PROXY_SETTINGS_UNAVAILABLE".to_string())? = settings.clone();
        if !self.tor.enabled() {
            if let Err(error) = self.rebuild_profiles() {
                if let Ok(mut current) = self.proxy_settings.lock() {
                    *current = previous;
                }
                let _ = self.rebuild_profiles();
                return Err(error);
            }
        }
        let encoded = serde_json::to_vec(&settings)
            .map_err(|error| format!("Could not encode proxy settings: {error}"))?;
        if let Err(error) = profiles::atomic_write(&self.proxy_settings_path, &encoded) {
            if let Ok(mut current) = self.proxy_settings.lock() {
                *current = previous;
            }
            if !self.tor.enabled() {
                let _ = self.rebuild_profiles();
            }
            return Err(error);
        }
        serde_json::to_value(settings).map_err(|error| error.to_string())
    }

    pub fn network_settings(&self) -> Result<Value, String> {
        let settings = self
            .network_settings
            .lock()
            .map_err(|_| "NETWORK_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        serde_json::to_value(settings).map_err(|error| error.to_string())
    }

    pub fn apply_network_settings(&self, value: Value) -> Result<Value, String> {
        let settings: NetworkSettings =
            serde_json::from_value(value).map_err(|_| "NETWORK_SETTINGS_INVALID".to_string())?;
        let settings = settings.normalized();
        let previous = self
            .network_settings
            .lock()
            .map_err(|_| "NETWORK_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        if previous == settings {
            return serde_json::to_value(settings).map_err(|error| error.to_string());
        }
        *self
            .network_settings
            .lock()
            .map_err(|_| "NETWORK_SETTINGS_UNAVAILABLE".to_string())? = settings.clone();
        if let Err(error) = self.rebuild_profiles() {
            if let Ok(mut current) = self.network_settings.lock() {
                *current = previous;
            }
            let _ = self.rebuild_profiles();
            return Err(error);
        }
        let encoded = serde_json::to_vec(&settings)
            .map_err(|error| format!("Could not encode network settings: {error}"))?;
        if let Err(error) = profiles::atomic_write(&self.network_settings_path, &encoded) {
            if let Ok(mut current) = self.network_settings.lock() {
                *current = previous;
            }
            let _ = self.rebuild_profiles();
            return Err(error);
        }
        serde_json::to_value(settings).map_err(|error| error.to_string())
    }

    fn rebuild_profiles(&self) -> Result<(), String> {
        for profile in self.profiles.values() {
            profile.rebuild_network_route()?;
        }
        Ok(())
    }

    pub fn dispatch(&self, profile_id: &str, command: &str, args: &Value) -> Result<Value, String> {
        if command == "get_background_transfer_work" {
            return Ok(serde_json::json!({
                "entries": self.file_bridge.background_entries(&self.profiles)?,
                // The Web bridge deliberately owns one workspace-wide slot;
                // opening another profile cannot bypass that bound.
                "maxConcurrent": 1
            }));
        }
        if command == "search_tox_messages" {
            return self.prepare_message_search(profile_id, args)?.execute();
        }
        let profile = self
            .profiles
            .get(profile_id)
            .ok_or_else(|| "ACTIVE_PROFILE_LOCKED".to_string())?;
        match command {
            "get_tox_id" => Ok(json_value(self.tox_id(profile)?)?),
            "get_tox_friends" => Self::friends_snapshot(profile),
            "get_tox_messages" => self.messages(profile, args),
            "get_tox_messages_page" => self.messages_page(profile, args),
            "get_tox_messages_snapshot" => self.messages_snapshot(profile, args),
            "get_chat_capabilities" => serde_json::to_value(crate::chat_capabilities(
                profile,
                u32_value(args, "friendNumber")?,
            ))
            .map_err(|error| error.to_string()),
            "send_tox_message" => self.send_message(profile, args),
            "set_message_reactions" => self.set_message_reactions(profile, args),
            "acknowledge_local_messages" => self.acknowledge_local_messages(profile, args),
            "release_chat_history" => {
                crate::release_chat_history_for_state(
                    profile,
                    u32_value(args, "friendNumber")?,
                    args.get("viewLeaseId").and_then(Value::as_str),
                )?;
                Ok(Value::Null)
            }
            "refresh_chat_history_lease" => {
                crate::refresh_chat_history_lease_for_state(
                    profile,
                    u32_value(args, "friendNumber")?,
                    string_value(args, "viewLeaseId")?,
                )?;
                Ok(Value::Null)
            }
            "add_tox_friend" => self.add_friend(profile, args),
            "delete_tox_friend" => self.delete_friend(profile, args),
            "get_incoming_friend_requests" => serde_json::to_value(
                profile
                    .incoming_requests
                    .lock()
                    .map_err(|_| "Could not read friend requests".to_string())?
                    .clone(),
            )
            .map_err(|error| error.to_string()),
            "accept_incoming_friend_request" => self.accept_friend(profile, args),
            "get_tox_network_status" => Ok(json_value(self.network_status(profile))?),
            "get_tox_user_status" => Ok(json_value(crate::profile_user_status(profile))?),
            "set_tox_user_status" => Ok(json_value(crate::set_user_status_inner(
                profile,
                string_value(args, "status")?,
            )?)?),
            "get_tox_status_message" => Ok(json_value(self.status_message(profile)?)?),
            "set_tox_status_message" => self.set_status_message(profile, args),
            "set_tox_nickname" => self.set_nickname(profile, args),
            "get_pq_status" => {
                let friend = u32_value(args, "friendNumber")?;
                serde_json::to_value(profile.pq.status(friend)).map_err(|error| error.to_string())
            }
            "begin_pq_entropy" => {
                let remaining = profile
                    .pq
                    .begin_identity_entropy(u32_value(args, "friendNumber")?)?;
                serde_json::to_value(remaining).map_err(|error| error.to_string())
            }
            "complete_pq_identity" => {
                let friend = u32_value(args, "friendNumber")?;
                let mut noise: Vec<u8> = serde_json::from_value(
                    args.get("extraNoise")
                        .cloned()
                        .ok_or("COMMAND_ARGUMENT_INVALID")?,
                )
                .map_err(|_| "PQ_NOISE_DIGEST_INVALID")?;
                if !noise.is_empty() && noise.len() != 32 {
                    return Err("PQ_NOISE_DIGEST_INVALID".into());
                }
                let (_, _transaction) = crate::lock_chat_transaction_for_friend(profile, friend)?;
                let result = profile.pq.complete_identity(&noise);
                noise.fill(0);
                result?;
                serde_json::to_value(profile.pq.status(friend)).map_err(|e| e.to_string())
            }
            "skip_pq_auto" => serde_json::to_value(crate::skip_pq_auto_for_state(
                profile,
                u32_value(args, "friendNumber")?,
            )?)
            .map_err(|e| e.to_string()),
            "request_pq_session"
            | "withdraw_pq_session"
            | "accept_pq_session"
            | "reject_pq_session"
            | "request_pq_shutdown" => self.pq_action(profile, command, args),
            "get_unread_state" => serde_json::to_value(crate::unread_state_view(profile)?)
                .map_err(|error| error.to_string()),
            "mark_friend_read" => self.mark_friend_read(profile, args),
            "mark_requests_read" => self.mark_requests_read(profile),
            "get_file_receive_settings" => self.file_receive_settings(profile),
            "set_file_receive_settings" => self.set_file_receive_settings(profile, args),
            "set_chat_history_enabled" => self.set_chat_history_enabled(profile, args),
            "clear_tox_history" => self.clear_history(profile, args),
            "load_local_state" => self.load_profile_json(profile, "local-state.json"),
            "save_local_state" => {
                self.save_profile_json(profile, "local-state.json", args, "state")
            }
            "load_layout_state" => self.load_workspace_json("layout-state.json"),
            "save_layout_state" => self.save_workspace_json("layout-state.json", args, "state"),
            _ => Err("COMMAND_NOT_AVAILABLE".to_string()),
        }
    }

    fn pq_action(&self, profile: &ToxState, command: &str, args: &Value) -> Result<Value, String> {
        let friend = u32_value(args, "friendNumber")?;
        let (_, _transaction) = crate::lock_chat_transaction_for_friend(profile, friend)?;
        let packets = match command {
            "request_pq_session" => profile.pq.request(friend)?,
            "withdraw_pq_session" => profile.pq.withdraw(friend)?,
            "accept_pq_session" => profile.pq.accept(friend)?,
            "reject_pq_session" => profile.pq.reject(friend)?,
            "request_pq_shutdown" => profile.pq.request_shutdown(friend)?,
            _ => return Err("COMMAND_NOT_AVAILABLE".to_string()),
        };
        profile.pq.queue(friend, packets);
        let status = profile.pq.status(friend);
        match command {
            "request_pq_session" => crate::append_pq_history(
                &profile.messages,
                friend,
                &status,
                "initiator",
                "offered",
                true,
            ),
            "request_pq_shutdown" => crate::append_pq_history(
                &profile.messages,
                friend,
                &status,
                "initiator",
                "close_pending",
                true,
            ),
            "withdraw_pq_session" => {
                crate::update_latest_pq_history(&profile.messages, friend, &status, "withdrawn");
            }
            "accept_pq_session" => {
                crate::update_latest_pq_history(&profile.messages, friend, &status, "accepting");
            }
            "reject_pq_session" => {
                crate::update_latest_pq_history(&profile.messages, friend, &status, "rejected");
            }
            _ => {}
        }
        crate::persist_tox_history(
            &profile.messages,
            &profile.history_path,
            &profile.history_enabled,
        );
        serde_json::to_value(status).map_err(|error| error.to_string())
    }

    fn mark_friend_read(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        profile
            .unread_state
            .lock()
            .map_err(|_| "UNREAD_STATE_UNAVAILABLE".to_string())?
            .friends
            .remove(&u32_value(args, "friendNumber")?.to_string());
        crate::persist_unread_state(&profile.unread_state, &profile.unread_state_path);
        Ok(Value::Null)
    }

    fn mark_requests_read(&self, profile: &ToxState) -> Result<Value, String> {
        profile
            .unread_state
            .lock()
            .map_err(|_| "UNREAD_STATE_UNAVAILABLE".to_string())?
            .requests
            .clear();
        crate::persist_unread_state(&profile.unread_state, &profile.unread_state_path);
        Ok(Value::Null)
    }

    fn file_receive_settings(&self, profile: &ToxState) -> Result<Value, String> {
        let settings = profile
            .file_receive_settings
            .lock()
            .map_err(|_| "FILE_SETTINGS_UNAVAILABLE".to_string())?
            .clone();
        serde_json::to_value(settings).map_err(|error| error.to_string())
    }

    fn set_file_receive_settings(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let settings: FileReceiveSettings = serde_json::from_value(
            args.get("settings")
                .cloned()
                .ok_or("COMMAND_ARGUMENT_INVALID")?,
        )
        .map_err(|_| "FILE_SETTINGS_INVALID".to_string())?;
        let settings = crate::set_file_receive_settings_for_state(profile, settings)?;
        serde_json::to_value(settings).map_err(|error| error.to_string())
    }

    fn set_chat_history_enabled(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let enabled = args
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or("COMMAND_ARGUMENT_INVALID")?;
        profile.history_enabled.store(enabled, Ordering::Relaxed);
        if enabled {
            crate::persist_tox_history(
                &profile.messages,
                &profile.history_path,
                &profile.history_enabled,
            );
        } else if let Ok(mut messages) = profile.messages.lock() {
            messages.retain(crate::message_requires_runtime_residency);
        }
        crate::invalidate_chat_view_revisions(&profile.history_path);
        Ok(Value::Null)
    }

    fn clear_history(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend = args
            .get("friendNumber")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok());
        let friend_key = friend
            .map(|number| profile.stable_friend_public_key(number))
            .unwrap_or_default();
        let _transaction = profile
            .chat_transaction_gate
            .lock()
            .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
        let retained_file_cards = crate::active_file_card_message_ids(profile);
        let mut messages = profile
            .messages
            .lock()
            .map_err(|_| "HISTORY_UNAVAILABLE".to_string())?;
        if let Some(friend) = friend {
            messages.retain(|message| !crate::message_matches_friend(message, friend, &friend_key));
        } else {
            messages.clear();
        }
        let history_clear = crate::enqueue_registered_history_clear_required(
            &profile.history_path,
            friend.map(|friend| (friend, friend_key.as_str())),
        );
        drop(messages);
        crate::wait_for_registered_history_write(history_clear?)?;
        if let Some(friend) = friend {
            profile
                .chat_protocol
                .clear_friend_history_state(friend, &friend_key)?;
            profile.file_card_protocol.retain_friend_messages(
                friend,
                &friend_key,
                &retained_file_cards,
            )?;
        } else {
            profile.chat_protocol.clear_history_state()?;
            profile
                .file_card_protocol
                .retain_messages(|binding| retained_file_cards.contains(&binding.message_id))?;
        }
        crate::bump_history_revision(&profile.history_path);
        if let Ok(mut unread) = profile.unread_state.lock() {
            if let Some(friend) = friend {
                unread.friends.remove(&friend.to_string());
                unread
                    .unseen_messages
                    .remove(&crate::unread_target_key(friend, &friend_key));
            } else {
                unread.friends.clear();
                unread.unseen_messages.clear();
            }
        }
        crate::persist_unread_state(&profile.unread_state, &profile.unread_state_path);
        Ok(Value::Null)
    }

    fn load_profile_json(&self, profile: &ToxState, name: &str) -> Result<Value, String> {
        let path = profile
            .history_path
            .parent()
            .ok_or("PROFILE_PATH_INVALID")?
            .join(name);
        load_optional_json(&path)
    }

    fn save_profile_json(
        &self,
        profile: &ToxState,
        name: &str,
        args: &Value,
        field: &str,
    ) -> Result<Value, String> {
        let path = profile
            .history_path
            .parent()
            .ok_or("PROFILE_PATH_INVALID")?
            .join(name);
        crate::write_profile_local_state_preserving_avatar(
            &profile.local_state_lock,
            &path,
            &profile.avatars_dir,
            args.get(field).ok_or("COMMAND_ARGUMENT_INVALID")?,
        )?;
        Ok(Value::Null)
    }

    fn load_workspace_json(&self, name: &str) -> Result<Value, String> {
        load_optional_json(&self.workspace_root.join(name))
    }

    fn save_workspace_json(&self, name: &str, args: &Value, field: &str) -> Result<Value, String> {
        save_json_value(
            &self.workspace_root.join(name),
            args.get(field).ok_or("COMMAND_ARGUMENT_INVALID")?,
        )?;
        Ok(Value::Null)
    }

    fn profile_container_path(&self, profile_id: &str) -> Result<PathBuf, String> {
        if profile_id.is_empty()
            || !profile_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("PROFILE_ID_INVALID".to_string());
        }
        let root = self.workspace_root.join("profiles").join(profile_id);
        Ok(root.join(format!("{profile_id}.kai")))
    }

    fn profile_paths_for_volume(
        &self,
        volume: Arc<KaiProfileVolume>,
    ) -> Result<ProfilePaths, String> {
        if let Some(durability) = &self.profile_durability {
            volume.set_durability_hook(durability.hook.clone())?;
        }
        let namespace = volume.namespace_root().to_path_buf();
        ProfilePaths::new_with_volume(
            self.workspace_root.clone(),
            namespace.join("data"),
            namespace.join("profile.tox"),
            Some(volume),
        )
    }

    fn tox_id(&self, profile: &ToxState) -> Result<String, String> {
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let mut address = [0_u8; 38];
        unsafe { crate::tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
        ToxState::save(handle)?;
        Ok(crate::hex_upper(&address))
    }

    fn network_status(&self, profile: &ToxState) -> String {
        if !profile.network_enabled.load(Ordering::Relaxed) {
            "offline".to_string()
        } else if !self.tor.is_ready() {
            "connecting-tor".to_string()
        } else if profile.connection.load(Ordering::Relaxed) == 0 {
            "connecting".to_string()
        } else {
            "online".to_string()
        }
    }

    fn friends_snapshot(profile: &ToxState) -> Result<Value, String> {
        let (last_events_by_key, last_events_by_number) = profile
            .messages
            .lock()
            .map_err(|_| "Could not read messages".to_string())?
            .iter()
            .fold(
                (HashMap::<String, u64>::new(), HashMap::<u32, u64>::new()),
                |(mut by_key, mut by_number), message| {
                    if message.friend_public_key.is_empty() {
                        let entry = by_number.entry(message.friend_number).or_default();
                        *entry = (*entry).max(message.timestamp);
                    } else {
                        let entry = by_key.entry(message.friend_public_key.clone()).or_default();
                        *entry = (*entry).max(message.timestamp);
                    }
                    (by_key, by_number)
                },
            );
        let avatar_sources = crate::latest_friend_avatar_sources(&profile.avatars_dir);
        let cached_profiles = profile
            .friend_cache
            .lock()
            .map_err(|_| "Could not read friend cache".to_string())?
            .clone();
        // HTTP snapshots run on an owned blocking worker. Brief native
        // iteration contention is normal and must not become an HTTP error.
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let count = unsafe { crate::tox_self_get_friend_list_size(handle.instance.as_ptr()) };
        let mut numbers = vec![0_u32; count];
        unsafe { crate::tox_self_get_friend_list(handle.instance.as_ptr(), numbers.as_mut_ptr()) };
        let mut result = Vec::with_capacity(count);
        for number in numbers {
            let mut error = 0_i32;
            let mut key = [0_u8; 32];
            if !unsafe {
                crate::tox_friend_get_public_key(
                    handle.instance.as_ptr(),
                    number,
                    key.as_mut_ptr(),
                    &mut error,
                )
            } {
                continue;
            }
            let connection = if unsafe {
                crate::tox_friend_get_connection_status(
                    handle.instance.as_ptr(),
                    number,
                    &mut error,
                )
            } == 0
            {
                "offline"
            } else {
                "online"
            };
            let public_key = crate::hex_upper(&key);
            let cached = cached_profiles
                .get(&public_key)
                .cloned()
                .unwrap_or_default();
            let received_name = read_friend_text(
                handle.instance.as_ptr(),
                number,
                crate::tox_friend_get_name_size,
                crate::tox_friend_get_name,
            );
            let received_status_message = read_friend_text(
                handle.instance.as_ptr(),
                number,
                crate::tox_friend_get_status_message_size,
                crate::tox_friend_get_status_message,
            );
            let raw_status = unsafe {
                crate::tox_friend_get_status(handle.instance.as_ptr(), number, &mut error)
            };
            let status = if connection == "offline" {
                "offline"
            } else {
                match raw_status {
                    1 => "away",
                    2 => "busy",
                    _ => "online",
                }
            };
            let name = if received_name.is_empty() {
                if cached.name.is_empty() {
                    crate::hex_upper(&key[..4])
                } else {
                    cached.name.clone()
                }
            } else {
                received_name
            };
            let status_message = if received_status_message.is_empty() {
                cached.status_message.clone()
            } else {
                received_status_message
            };
            let avatar_path = avatar_sources.get(&number).cloned();
            let tox_id = (!cached.tox_id.is_empty())
                .then_some(cached.tox_id.clone())
                .unwrap_or_else(|| public_key.clone());
            let authorized =
                cached.authorized || (connection == "online" && !cached.pending_authorization);
            let last_event = last_events_by_key
                .get(&public_key)
                .copied()
                .or_else(|| last_events_by_number.get(&number).copied());
            result.push(serde_json::json!({
                "number": number,
                "public_key": public_key,
                "tox_id": tox_id,
                "authorized": authorized,
                "connection": connection,
                "name": name,
                "status": status,
                "status_message": status_message,
                "avatar_path": avatar_path,
                "last_online": cached.last_online,
                "last_event": last_event,
                "addedAt": cached.added_at,
                "lastEventSequence": cached.added_event_sequence
            }));
        }
        Ok(Value::Array(result))
    }

    fn messages(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend = u32_value(args, "friendNumber")?;
        let public_key = profile.stable_friend_public_key(friend);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize);
        let cap = match limit {
            Some(0) => 1_000,
            Some(value) => value.clamp(1, 1_000),
            None => crate::DEFAULT_MESSAGE_SNAPSHOT,
        };
        let mut messages = crate::chat_history_store::latest_registered(
            &profile.history_path,
            friend,
            &public_key,
            cap,
        )?;
        crate::decorate_message_reactions(profile, &mut messages);
        self.file_bridge
            .decorate_retained_transfer_messages(profile, &mut messages)?;
        crate::hydrate_attachment_preview_sources(&mut messages);
        serde_json::to_value(messages).map_err(|error| error.to_string())
    }

    fn messages_page(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend = u32_value(args, "friendNumber")?;
        let public_key = profile.stable_friend_public_key(friend);
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(crate::MAX_MESSAGE_EXPORT_PAGE as u64) as usize;
        let mut page = crate::chat_history_store::page_registered(
            &profile.history_path,
            friend,
            &public_key,
            offset,
            limit,
        )?;
        self.file_bridge
            .decorate_retained_transfer_messages(profile, &mut page.messages)?;
        Ok(serde_json::json!({
            "messages": page.messages,
            "nextOffset": page.next_offset,
            "done": !page.has_more,
            "total": page.total,
        }))
    }

    fn messages_snapshot(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend = u32_value(args, "friendNumber")?;
        let public_key = profile.stable_friend_public_key(friend);
        crate::mark_chat_history_active(
            profile,
            friend,
            &public_key,
            args.get("viewLeaseId").and_then(Value::as_str),
        );
        if let Some(through) = args
            .get("ackPeerReactionThrough")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            profile
                .chat_protocol
                .acknowledge_peer_reaction_events(friend, &public_key, through)?;
        }
        let (peer_reaction_events, peer_reaction_latest_revision) =
            profile.chat_protocol.peer_reaction_events(
                friend,
                &public_key,
                args.get("peerReactionAfter")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                crate::chat_protocol::MAX_PEER_REACTION_EVENT_PAGE,
            )?;
        let revision = crate::chat_snapshot_revision(&profile.history_path, friend, &public_key);
        if args.get("knownRevision").and_then(Value::as_u64) == Some(revision) {
            return Ok(serde_json::json!({
                "revision": revision,
                "messages": null,
                "peerReactionEvents": peer_reaction_events,
                "peerReactionLatestRevision": peer_reaction_latest_revision,
            }));
        }
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize);
        let range_offset = args
            .get("rangeOffset")
            .and_then(Value::as_u64)
            .map(|value| value as usize);
        let target_id = args.get("targetMessageId").and_then(Value::as_str);
        let (mut messages, total, window_start, target_index) =
            if profile.history_enabled.load(Ordering::Relaxed) {
                let window = crate::chat_history_store::window_registered(
                    &profile.history_path,
                    friend,
                    &public_key,
                    limit,
                    range_offset,
                    target_id,
                )?;
                let mut messages = window.messages;
                crate::replace_cached_contact_window(profile, friend, &public_key, &mut messages)?;
                (
                    messages,
                    window.total,
                    window.window_start,
                    window.target_index,
                )
            } else {
                let messages = profile
                    .messages
                    .lock()
                    .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
                crate::session_history_window(
                    &messages,
                    friend,
                    &public_key,
                    limit,
                    range_offset,
                    target_id,
                )
            };
        crate::decorate_message_reactions(profile, &mut messages);
        self.file_bridge
            .decorate_retained_transfer_messages(profile, &mut messages)?;
        crate::hydrate_attachment_preview_sources(&mut messages);
        let (eligible, latest, first_unseen, unseen, peer_reactions) =
            crate::chat_window_metadata(profile, friend, &public_key, &messages)?;
        let has_more_before = window_start > 0;
        let has_more_after = window_start.saturating_add(messages.len()) < total;
        Ok(serde_json::json!({
            "revision": revision,
            "messages": messages,
            "total": total,
            "windowStart": window_start,
            "hasMore": has_more_before,
            "hasMoreBefore": has_more_before,
            "hasMoreAfter": has_more_after,
            "targetIndex": target_index,
            "reactionEligibleIds": eligible,
            "latestMessageId": latest,
            "firstUnseenMessageId": first_unseen,
            "unseenMessageIds": unseen,
            "peerReactions": peer_reactions,
            "peerReactionEvents": peer_reaction_events,
            "peerReactionLatestRevision": peer_reaction_latest_revision,
        }))
    }

    fn search_messages(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend = u32_value(args, "friendNumber")?;
        let public_key = profile.stable_friend_public_key(friend);
        let query = sanitize_untrusted_text(string_value(args, "query")?)
            .trim()
            .to_string();
        if query.is_empty() || query.chars().count() > 256 {
            return Err("CHAT_SEARCH_QUERY_INVALID".to_string());
        }
        let cursor = args.get("cursor").and_then(Value::as_str);
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
        let page = crate::chat_history_store::search_registered(
            &profile.history_path,
            friend,
            &public_key,
            &query,
            cursor,
            limit,
        )?;
        serde_json::to_value(page).map_err(|error| error.to_string())
    }

    fn send_message(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend_number = u32_value(args, "friendNumber")?;
        let quote = args
            .get("quote")
            .filter(|value| !value.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| "CHAT_QUOTE_INVALID".to_string())?;
        let formatting = args
            .get("formatting")
            .filter(|value| !value.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| "CHAT_FORMAT_INVALID".to_string())?
            .unwrap_or_default();
        let result = crate::send_chat_message_for_state(
            profile,
            friend_number,
            string_value(args, "text")?.to_string(),
            args.get("operationId")
                .and_then(Value::as_str)
                .map(str::to_string),
            quote,
            formatting,
        )?;
        serde_json::to_value(result).map_err(|error| error.to_string())
    }

    fn set_message_reactions(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend_number = u32_value(args, "friendNumber")?;
        let message_id = string_value(args, "messageId")?.to_string();
        let operation_id = args
            .get("operationId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let reactions = serde_json::from_value(
            args.get("reactions")
                .cloned()
                .ok_or("COMMAND_ARGUMENT_INVALID")?,
        )
        .map_err(|_| "CHAT_REACTION_CODE_INVALID".to_string())?;
        let view = crate::set_message_reactions_for_state(
            profile,
            friend_number,
            message_id,
            reactions,
            operation_id,
        )?;
        serde_json::to_value(view).map_err(|error| error.to_string())
    }

    fn acknowledge_local_messages(
        &self,
        profile: &ToxState,
        args: &Value,
    ) -> Result<Value, String> {
        let friend_number = u32_value(args, "friendNumber")?;
        let public_key = profile.stable_friend_public_key(friend_number);
        let target = crate::unread_target_key(friend_number, &public_key);
        let requested = args
            .get("messageIds")
            .and_then(Value::as_array)
            .ok_or("COMMAND_ARGUMENT_INVALID")?
            .iter()
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>();
        {
            let mut state = profile
                .unread_state
                .lock()
                .map_err(|_| "UNREAD_STATE_UNAVAILABLE".to_string())?;
            let removed = state
                .unseen_messages
                .get_mut(&target)
                .map(|ids| {
                    let before = ids.len();
                    ids.retain(|id| !requested.contains(id.as_str()));
                    before.saturating_sub(ids.len())
                })
                .unwrap_or(0);
            if state
                .unseen_messages
                .get(&target)
                .is_some_and(Vec::is_empty)
            {
                state.unseen_messages.remove(&target);
            }
            if removed > 0 {
                let key = friend_number.to_string();
                if let Some(count) = state.friends.get_mut(&key) {
                    *count = count.saturating_sub(removed.min(u32::MAX as usize) as u32);
                    if *count == 0 {
                        state.friends.remove(&key);
                    }
                }
            }
        }
        crate::persist_unread_state_required(&profile.unread_state, &profile.unread_state_path)?;
        crate::bump_chat_view_revision(&profile.history_path, friend_number, &public_key);
        serde_json::to_value(crate::unread_state_view(profile)?).map_err(|error| error.to_string())
    }

    fn add_friend(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let tox_id = string_value(args, "toxId")?;
        let address = parse_tox_id(tox_id)?;
        let normalized_tox_id = tox_id
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
            .to_uppercase();
        let message = sanitize_untrusted_text(string_value(args, "message")?)
            .trim()
            .to_string();
        let message = if message.is_empty() {
            "Hello! Please add me.".to_string()
        } else {
            message
        };
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let mut error = 0_i32;
        let friend = unsafe {
            crate::tox_friend_add(
                handle.instance.as_ptr(),
                address.as_ptr(),
                message.as_bytes().as_ptr(),
                message.len(),
                &mut error,
            )
        };
        if error != 0 {
            return Err(match error {
                1 => "TOX_FRIEND_ADD_ARGUMENT_INVALID",
                2 => "TOX_FRIEND_REQUEST_TOO_LONG",
                3 => "TOX_FRIEND_REQUEST_EMPTY",
                4 => "TOX_FRIEND_ADD_OWN_ID",
                5 => "TOX_FRIEND_ALREADY_ADDED",
                6 => "TOX_ID_CHECKSUM_INVALID",
                7 => "TOX_ID_NOSPAM_CHANGED",
                8 => "TOX_FRIEND_ADD_OUT_OF_MEMORY",
                _ => "TOX_FRIEND_ADD_FAILED",
            }
            .to_string());
        }
        let public_key = crate::hex_upper(&address[..32]);
        let added_at = crate::unix_timestamp();
        let added_event_sequence = crate::next_chat_event_sequence();
        let friend_cache_write = if let Ok(mut cache) = profile.friend_cache.lock() {
            let entry = cache.entry(public_key).or_default();
            entry.tox_id = normalized_tox_id;
            entry.friend_number = Some(friend);
            entry.pending_authorization = true;
            entry.authorization_message = message;
            entry.authorization_last_refreshed_at = added_at;
            entry.added_at = Some(added_at);
            entry.added_event_sequence = added_event_sequence;
            let completed =
                crate::enqueue_friend_cache_write_required(&*cache, &profile.friend_cache_path)?;
            drop(cache);
            Some(completed)
        } else {
            None
        };
        if let Some(completed) = friend_cache_write {
            crate::wait_for_atomic_write(completed)?;
        }
        ToxState::save(handle)?;
        Ok(serde_json::json!(friend))
    }

    fn delete_friend(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let friend = u32_value(args, "friendNumber")?;
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let friend_key = crate::tox_friend_public_key(handle.instance.as_ptr(), friend)
            .ok_or("CHAT_CONTACT_NOT_FOUND")?;
        // Match the native callback's handle -> transaction lock order and
        // bind the numeric slot to both stable identities before detaching it.
        let _transaction = profile
            .chat_transaction_gate
            .lock()
            .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
        crate::bind_pq_contact(
            &profile.pq,
            &profile.messages,
            &profile.history_path,
            friend,
            &friend_key,
            &crate::pq_tox_owner(handle.instance.as_ptr()),
        )?;
        profile.chat_transport_ready.store(false, Ordering::Release);
        profile.pq.remove_friend(friend, Some(&friend_key))?;
        let mut error = 0_i32;
        if !unsafe { crate::tox_friend_delete(handle.instance.as_ptr(), friend, &mut error) } {
            return Err(format!("TOX_FRIEND_DELETE_FAILED_{error}"));
        }
        ToxState::save(handle)?;
        drop(guard);
        profile.chat_protocol.remove_friend(friend, &friend_key)?;
        profile
            .file_card_protocol
            .remove_friend(friend, &friend_key)?;
        let mut messages = profile
            .messages
            .lock()
            .map_err(|_| "HISTORY_UNAVAILABLE".to_string())?;
        messages.retain(|message| !crate::message_matches_friend(message, friend, &friend_key));
        let history_clear = crate::enqueue_registered_history_clear_required(
            &profile.history_path,
            Some((friend, &friend_key)),
        );
        drop(messages);
        crate::wait_for_registered_history_write(history_clear?)?;
        for queue in [&profile.pending_messages, &profile.pending_pq_messages] {
            if let Ok(mut pending) = queue.lock() {
                pending.retain(|item| {
                    !crate::friend_identity_matches(
                        item.friend_number,
                        &item.friend_public_key,
                        friend,
                        &friend_key,
                    )
                });
            }
        }
        crate::persist_pending_messages_required(
            &profile.pending_messages,
            &profile.pending_messages_path,
        )?;
        crate::persist_pending_messages_required(
            &profile.pending_pq_messages,
            &profile.pending_pq_messages_path,
        )?;
        if let Ok(mut pending) = profile.pending_files.lock() {
            pending.retain(|item| {
                !crate::friend_identity_matches(
                    item.friend_number,
                    &item.friend_public_key,
                    friend,
                    &friend_key,
                )
            });
        }
        crate::persist_pending_files_required(&profile.pending_files, &profile.pending_files_path)?;
        if let Ok(mut unread) = profile.unread_state.lock() {
            unread.friends.remove(&friend.to_string());
            unread
                .unseen_messages
                .remove(&crate::unread_target_key(friend, &friend_key));
        }
        crate::persist_unread_state_required(&profile.unread_state, &profile.unread_state_path)?;
        crate::bump_history_revision(&profile.history_path);
        crate::commit_chat_transaction_with_barrier(
            &profile.history_path,
            &profile.chat_transport_ready,
        )?;
        Ok(Value::Null)
    }

    fn accept_friend(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let public_key = parse_public_key(string_value(args, "publicKey")?)?;
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let mut error = 0_i32;
        let number = unsafe {
            crate::tox_friend_add_norequest(
                handle.instance.as_ptr(),
                public_key.as_ptr(),
                &mut error,
            )
        };
        if error != 0 {
            return Err(format!("TOX_FRIEND_ACCEPT_FAILED_{error}"));
        }
        let public_key_hex = crate::hex_upper(&public_key);
        let friend_cache_write = if let Ok(mut cache) = profile.friend_cache.lock() {
            let entry = cache.entry(public_key_hex.clone()).or_default();
            entry.authorized = true;
            entry.friend_number = Some(number);
            entry.pending_authorization = false;
            entry.authorization_message.clear();
            entry.added_at.get_or_insert_with(crate::unix_timestamp);
            entry.added_event_sequence = crate::next_chat_event_sequence();
            let completed =
                crate::enqueue_friend_cache_write_required(&*cache, &profile.friend_cache_path)?;
            drop(cache);
            Some(completed)
        } else {
            None
        };
        if let Some(completed) = friend_cache_write {
            crate::wait_for_atomic_write(completed)?;
        }
        if let Ok(mut requests) = profile.incoming_requests.lock() {
            requests.retain(|request| !request.public_key.eq_ignore_ascii_case(&public_key_hex));
            if let Ok(bytes) = serde_json::to_vec(&*requests) {
                let _ = profiles::atomic_write(&profile.incoming_requests_path, &bytes);
            }
        }
        ToxState::save(handle)?;
        Ok(serde_json::json!(number))
    }

    fn status_message(&self, profile: &ToxState) -> Result<String, String> {
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let mut error = 0_i32;
        let size = unsafe {
            crate::tox_self_get_status_message_size(handle.instance.as_ptr(), &mut error)
        };
        let mut bytes = vec![0_u8; size];
        if error != 0
            || (size > 0
                && !unsafe {
                    crate::tox_self_get_status_message(
                        handle.instance.as_ptr(),
                        bytes.as_mut_ptr(),
                        &mut error,
                    )
                })
        {
            return Err("TOX_STATUS_MESSAGE_READ_FAILED".to_string());
        }
        Ok(crate::normalize_status_message(&String::from_utf8_lossy(
            &bytes,
        )))
    }

    fn set_status_message(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let message = crate::normalize_status_message(string_value(args, "message")?);
        if message.len() > 1007 {
            return Err("TOX_STATUS_MESSAGE_TOO_LONG".to_string());
        }
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let mut error = 0_i32;
        if !unsafe {
            crate::tox_self_set_status_message(
                handle.instance.as_ptr(),
                message.as_bytes().as_ptr(),
                message.len(),
                &mut error,
            )
        } {
            return Err(format!("TOX_STATUS_MESSAGE_WRITE_FAILED_{error}"));
        }
        ToxState::save(handle)?;
        Ok(serde_json::json!(message))
    }

    fn set_nickname(&self, profile: &ToxState, args: &Value) -> Result<Value, String> {
        let name = sanitize_untrusted_text(string_value(args, "nickname")?)
            .trim()
            .to_string();
        if name.len() > 128 {
            return Err("TOX_NICKNAME_TOO_LONG".to_string());
        }
        let guard = profile
            .handle
            .lock()
            .map_err(|_| "Could not access the Tox profile".to_string())?;
        let handle = guard.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
        let mut error = 0_i32;
        if !unsafe {
            crate::tox_self_set_name(
                handle.instance.as_ptr(),
                name.as_bytes().as_ptr(),
                name.len(),
                &mut error,
            )
        } {
            return Err(format!("TOX_NICKNAME_WRITE_FAILED_{error}"));
        }
        ToxState::save(handle)?;
        Ok(Value::Null)
    }
}

fn restore_profile_data(
    workspace_root: &Path,
    source_root: &Path,
    destination_root: &Path,
) -> Result<(), String> {
    let staging_root = source_root.parent().ok_or("PROFILE_PACKAGE_PATH_INVALID")?;
    let staging_name = staging_root
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("PROFILE_PACKAGE_PATH_INVALID")?;
    if source_root.file_name().and_then(|value| value.to_str()) != Some("data")
        || staging_root.parent() != Some(workspace_root)
        || !staging_name.starts_with(".profile-restore-")
    {
        return Err("PROFILE_PACKAGE_PATH_INVALID".to_string());
    }
    let metadata = fs::symlink_metadata(source_root)
        .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("PROFILE_PACKAGE_PATH_INVALID".to_string());
    }

    fn copy_tree(source_root: &Path, source: &Path, destination_root: &Path) -> Result<(), String> {
        for entry in
            fs::read_dir(source).map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?
        {
            let entry = entry.map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("PROFILE_PACKAGE_PATH_INVALID".to_string());
            }
            let relative = path
                .strip_prefix(source_root)
                .map_err(|_| "PROFILE_PACKAGE_PATH_INVALID")?;
            if relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            }) {
                return Err("PROFILE_PACKAGE_PATH_INVALID".to_string());
            }
            let destination = destination_root.join(relative);
            if metadata.is_dir() {
                profiles::create_dir_all(&destination)
                    .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
                copy_tree(source_root, &path, destination_root)?;
            } else if metadata.is_file() {
                if let Some(parent) = destination.parent() {
                    profiles::create_dir_all(parent)
                        .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
                }
                let mut bytes = fs::read(&path)
                    .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
                let result = profiles::write_file(&destination, &bytes)
                    .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string());
                crate::wipe_sensitive_bytes(&mut bytes);
                result?;
            }
        }
        Ok(())
    }

    copy_tree(source_root, source_root, destination_root)
}

impl Drop for WebWorkspaceRuntime {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

type FriendTextSize = unsafe extern "C" fn(*const std::ffi::c_void, u32, *mut i32) -> usize;
type FriendTextGet = unsafe extern "C" fn(*const std::ffi::c_void, u32, *mut u8, *mut i32) -> bool;

fn load_optional_json(path: &Path) -> Result<Value, String> {
    if !profiles::file_exists(path) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&profiles::read_file(path).map_err(|_| "STATE_READ_FAILED".to_string())?)
        .map_err(|_| "STATE_DATA_INVALID".to_string())
}

fn save_json_value(path: &Path, value: &Value) -> Result<(), String> {
    let encoded = serde_json::to_vec(value).map_err(|_| "STATE_DATA_INVALID".to_string())?;
    profiles::atomic_write(path, &encoded)
}

fn read_friend_text(
    tox: *const std::ffi::c_void,
    friend: u32,
    size_fn: FriendTextSize,
    get_fn: FriendTextGet,
) -> String {
    let mut error = 0_i32;
    let size = unsafe { size_fn(tox, friend, &mut error) };
    if error != 0 || size == 0 {
        return String::new();
    }
    let mut bytes = vec![0_u8; size];
    if !unsafe { get_fn(tox, friend, bytes.as_mut_ptr(), &mut error) } || error != 0 {
        return String::new();
    }
    sanitize_untrusted_text(&String::from_utf8_lossy(&bytes))
        .trim()
        .to_string()
}

fn parse_tox_id(value: &str) -> Result<[u8; 38], String> {
    let compact = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    if compact.len() != 76 || !compact.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("TOX_ID_INVALID".to_string());
    }
    let mut address = [0_u8; 38];
    for (index, byte) in address.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&compact[index * 2..index * 2 + 2], 16)
            .map_err(|_| "TOX_ID_INVALID".to_string())?;
    }
    Ok(address)
}

fn parse_public_key(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("TOX_PUBLIC_KEY_INVALID".to_string());
    }
    let mut key = [0_u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "TOX_PUBLIC_KEY_INVALID".to_string())?;
    }
    Ok(key)
}

fn string_value<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| "COMMAND_ARGUMENT_INVALID".to_string())
}

fn u32_value(value: &Value, name: &str) -> Result<u32, String> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "COMMAND_ARGUMENT_INVALID".to_string())
}

fn json_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    #[derive(Default)]
    struct DeferredTransferStore {
        ready: AtomicBool,
        published: Mutex<Vec<StoreObjectStatus>>,
        operations: Mutex<Vec<StoreOperation>>,
        reply: Mutex<Option<Result<StoreReply, StoreError>>>,
    }

    impl WebTransferStore for DeferredTransferStore {
        fn is_ready(&self) -> bool {
            self.ready.load(Ordering::Acquire)
        }
        fn try_submit(&self, operation: StoreOperation) -> Result<u64, StoreError> {
            if !self.is_ready() {
                return Err(StoreError::Busy);
            }
            self.operations.lock().unwrap().push(operation);
            Ok(1)
        }
        fn try_result(&self, _ticket: u64) -> Option<Result<StoreReply, StoreError>> {
            self.reply.lock().unwrap().clone()
        }
        fn snapshot(&self) -> Vec<StoreObjectStatus> {
            self.published.lock().unwrap().clone()
        }
    }

    fn test_store_status(
        id: &str,
        direction: StoreDirection,
        size_bytes: u64,
    ) -> StoreObjectStatus {
        StoreObjectStatus {
            spec: StoreSpec {
                object_id: id.into(),
                operation_id: (direction == StoreDirection::Outgoing)
                    .then(|| "operation00000000000000000000000".into()),
                profile_id: "profile".into(),
                message_id: "message".into(),
                friend_public_key: "AB".repeat(32),
                direction,
                name: "test.bin".into(),
                mime: "application/octet-stream".into(),
                size_bytes,
                expected_sha256: (direction == StoreDirection::Outgoing).then_some([7; 32]),
            },
            durable_bytes: 0,
            phase: StorePhase::Staging,
            committed_sha256: None,
            native_delivery_confirmed: None,
        }
    }

    #[test]
    fn web_store_outgoing_waits_for_durable_commit_then_serves_native_demand_once() {
        let bridge = WebFileBridge::default();
        let store = Arc::new(DeferredTransferStore::default());
        bridge.install_store(store.clone()).unwrap();
        let id = bridge
            .enqueue_outgoing(
                "profile",
                1,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let mut status = test_store_status(&id, StoreDirection::Outgoing, 4);
        bridge.bind_storage(&id, status.spec.clone()).unwrap();
        bridge.drive_storage().unwrap();
        assert!(store.operations.lock().unwrap().is_empty());
        assert!(bridge.next_to_start().is_none());
        store.ready.store(true, Ordering::Release);
        bridge.drive_storage().unwrap();
        assert!(matches!(
            store.operations.lock().unwrap().last(),
            Some(StoreOperation::Begin(_))
        ));
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.drive_storage().unwrap();
        bridge.control_id(&id, "pause").unwrap();
        bridge.control_id(&id, "resume").unwrap();
        assert_eq!(bridge.view(&id, 0).unwrap().state, "uploading");
        status.durable_bytes = 4;
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.drive_storage().unwrap();
        assert!(matches!(
            store.operations.lock().unwrap().last(),
            Some(StoreOperation::Finalize { .. })
        ));
        assert!(bridge.next_to_start().is_none());
        status.phase = StorePhase::Committed;
        status.committed_sha256 = Some([6; 32]);
        *store.published.lock().unwrap() = vec![status.clone()];
        assert_eq!(
            bridge.drive_storage().unwrap_err(),
            "TRANSFER_HASH_MISMATCH"
        );
        assert!(bridge.next_to_start().is_none());
        status.committed_sha256 = Some([7; 32]);
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.drive_storage().unwrap();
        bridge.drive_storage().unwrap();
        assert_eq!(bridge.inner.lock().unwrap().queue.len(), 1);
        assert_eq!(bridge.next_to_start().unwrap().id, id);
        bridge.outgoing_started(&id, 9).unwrap();
        assert!(bridge.on_outgoing_request(&id, 0, 4));
        *store.reply.lock().unwrap() = Some(Ok(StoreReply::Range {
            status,
            offset: 0,
            bytes: Arc::from([1_u8, 2, 3, 4]),
        }));
        bridge.drive_storage().unwrap();
        let (chunk, retry_after_ms) = bridge.next_outgoing_chunk(&id, 1_000).unwrap();
        assert!(chunk.is_none());
        assert_eq!(retry_after_ms, 1);
        assert_eq!(bridge.view(&id, 1_000).unwrap().buffered_bytes, 4);
        let (chunk, _) = bridge.next_outgoing_chunk(&id, 1_001).unwrap();
        assert_eq!(chunk.unwrap().data, vec![1, 2, 3, 4]);
        bridge.outgoing_chunk_sent(&id, 0, 4, 1_001).unwrap();
        let reads_before = store.operations.lock().unwrap().len();
        bridge.drive_storage().unwrap();
        assert_eq!(store.operations.lock().unwrap().len(), reads_before);
        assert!(bridge.next_outgoing_chunk(&id, 1_002).unwrap().0.is_none());
        assert_eq!(
            bridge
                .operation_transfer("profile", "operation00000000000000000000000")
                .unwrap()
                .object_id,
            id
        );
        assert!(bridge
            .operation_transfer("another-profile", "operation00000000000000000000000")
            .is_none());
    }

    #[test]
    fn deny_all_cancels_web_incoming_queue_and_late_callbacks_without_touching_other_profiles() {
        let bridge = WebFileBridge::default();
        let mut incoming = Vec::new();
        for (file_number, state) in [(1, "active"), (2, "queued"), (3, "paused"), (4, "offered")] {
            let id = bridge
                .offer_incoming(
                    "profile",
                    1,
                    file_number,
                    state.into(),
                    "test.bin".into(),
                    "application/octet-stream".into(),
                    4,
                )
                .unwrap();
            if matches!(state, "active" | "queued") {
                bridge.control_id(&id, "resume").unwrap();
            } else if state == "paused" {
                bridge.control_id(&id, "pause").unwrap();
            }
            incoming.push(id);
        }
        assert_eq!(bridge.next_to_start().unwrap().id, incoming[0]);
        bridge
            .push_incoming_chunk(&incoming[0], 0, &[1, 2])
            .unwrap();
        let other = bridge
            .offer_incoming(
                "other-profile",
                1,
                1,
                "other".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let outgoing = bridge
            .enqueue_outgoing(
                "profile",
                1,
                "outgoing".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let mut retained = test_store_status("retained", StoreDirection::Incoming, 4);
        retained.spec.message_id = "retained-message".into();
        retained.phase = StorePhase::Committed;
        retained.durable_bytes = 4;
        retained.committed_sha256 = Some([4; 32]);
        bridge.restore_storage(retained, 1, false).unwrap();

        assert!(bridge
            .cancel_incoming_for_policy("profile", std::ptr::null_mut())
            .unwrap());
        assert!(!bridge
            .cancel_incoming_for_policy("profile", std::ptr::null_mut())
            .unwrap());
        for (index, id) in incoming.iter().enumerate() {
            assert_eq!(bridge.view(id, 0).unwrap().state, "cancelled");
            assert_eq!(bridge.view(id, 0).unwrap().buffered_bytes, 0);
            assert!(bridge
                .on_native_control("profile", 1, index as u32 + 1, 0)
                .is_none());
            assert!(bridge.push_incoming_chunk(id, 0, &[1]).is_err());
            assert_eq!(
                bridge.control_id(id, "resume").unwrap_err(),
                "TRANSFER_NOT_RESUMABLE"
            );
        }
        assert_eq!(bridge.view(&other, 0).unwrap().state, "offered");
        assert_eq!(bridge.view("retained", 0).unwrap().state, "complete");
        assert_eq!(bridge.next_to_start().unwrap().id, outgoing);
    }

    #[test]
    fn deny_all_web_native_resume_checks_policy_and_cancelled_snapshot_before_native_control() {
        let bridge = WebFileBridge::default();
        let id = bridge
            .offer_incoming(
                "profile",
                1,
                1,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        bridge.control_id(&id, "resume").unwrap();
        let route = bridge.next_to_start().unwrap();
        let handle = Mutex::new(None);
        let messages = Arc::default();
        assert_eq!(
            resume_web_transfer_with_native_control(
                &handle,
                &Mutex::new(FileReceiveSettings::blocked()),
                &bridge,
                &messages,
                &route,
                |_| panic!("denied receive reached native RESUME"),
                || {},
            )
            .unwrap_err(),
            "FILE_RECEIVE_DENIED"
        );
        bridge
            .cancel_incoming_for_policy("profile", std::ptr::null_mut())
            .unwrap();
        assert_eq!(
            resume_web_transfer_with_native_control(
                &handle,
                &Mutex::new(FileReceiveSettings::default()),
                &bridge,
                &messages,
                &route,
                |_| panic!("cancelled snapshot reached native RESUME"),
                || {},
            )
            .unwrap_err(),
            "TRANSFER_NOT_RESUMABLE"
        );
    }

    #[test]
    fn deny_all_web_late_storage_commit_keeps_cancelled_transfer_terminal() {
        let bridge = WebFileBridge::default();
        let store = Arc::new(DeferredTransferStore::default());
        store.ready.store(true, Ordering::Release);
        bridge.install_store(store.clone()).unwrap();
        let id = bridge
            .offer_incoming(
                "profile",
                1,
                1,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let mut status = test_store_status(&id, StoreDirection::Incoming, 4);
        bridge.bind_storage(&id, status.spec.clone()).unwrap();
        bridge.control_id(&id, "resume").unwrap();
        bridge
            .cancel_incoming_for_policy("profile", std::ptr::null_mut())
            .unwrap();
        status.phase = StorePhase::Committed;
        status.durable_bytes = 4;
        status.committed_sha256 = Some([4; 32]);
        *store.published.lock().unwrap() = vec![status];
        let progress = bridge.drive_storage().unwrap();
        assert!(progress
            .iter()
            .all(|(_, resume, released)| resume.is_none() && *released == 0));
        assert_eq!(bridge.view(&id, 0).unwrap().state, "cancelled");
        assert!(bridge.next_to_start().is_none());
    }

    #[test]
    fn web_store_incoming_retains_pending_bytes_and_completes_without_browser_ack() {
        let bridge = WebFileBridge::default();
        let store = Arc::new(DeferredTransferStore::default());
        store.ready.store(true, Ordering::Release);
        bridge.install_store(store.clone()).unwrap();
        let id = bridge
            .offer_incoming(
                "profile",
                1,
                9,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                8,
            )
            .unwrap();
        let mut status = test_store_status(&id, StoreDirection::Incoming, 8);
        bridge.bind_storage(&id, status.spec.clone()).unwrap();
        bridge.control_id(&id, "resume").unwrap();
        assert!(bridge.next_to_start().is_none());
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.drive_storage().unwrap();
        bridge.next_to_start().unwrap();
        bridge
            .push_incoming_chunk_at(&id, 0, &[1, 2, 3, 4], 0)
            .unwrap();
        bridge.drive_storage().unwrap();
        assert!(!store
            .operations
            .lock()
            .unwrap()
            .iter()
            .any(|operation| matches!(operation, StoreOperation::Append { .. })));
        bridge.control_id(&id, "pause").unwrap();
        bridge.drive_storage().unwrap();
        bridge.control_id(&id, "resume").unwrap();
        assert_eq!(bridge.next_to_start().unwrap().id, id);
        bridge
            .push_incoming_chunk_at(&id, 4, &[5, 6, 7, 8], 1)
            .unwrap();
        bridge.drive_storage().unwrap();
        let operations = store.operations.lock().unwrap();
        let appends = operations
            .iter()
            .filter_map(|operation| match operation {
                StoreOperation::Append { offset, bytes, .. } => Some((*offset, bytes.to_vec())),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(appends, vec![(0, vec![1, 2, 3, 4]), (0, vec![1, 2, 3, 4])]);
        drop(operations);
        assert_eq!(bridge.view(&id, 1).unwrap().buffered_bytes, 8);
        status.durable_bytes = 4;
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.drive_storage().unwrap();
        assert_eq!(bridge.view(&id, 1).unwrap().buffered_bytes, 4);
        status.durable_bytes = 8;
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.drive_storage().unwrap();
        assert_eq!(bridge.view(&id, 1).unwrap().buffered_bytes, 0);
        assert_ne!(bridge.view(&id, 1).unwrap().state, "complete");
        status.phase = StorePhase::Committed;
        status.committed_sha256 = Some([8; 32]);
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.drive_storage().unwrap();
        let view = bridge.view(&id, 1).unwrap();
        assert_eq!(view.state, "complete");
        assert!(view.download_available);
        assert_eq!(bridge.unreconciled_terminal_ids(), vec![id.clone()]);
        assert!(bridge.acknowledge_terminal(&id));
        assert!(bridge.unreconciled_terminal_ids().is_empty());
        *store.reply.lock().unwrap() = Some(Ok(StoreReply::Range {
            status,
            offset: 2,
            bytes: Arc::from([3_u8, 4]),
        }));
        for _ in 0..2 {
            assert!(matches!(
                bridge
                    .storage_operation(StoreOperation::ReadRange {
                        object_id: id.clone(),
                        offset: 2,
                        length: 2
                    })
                    .unwrap(),
                Some(StoreReply::Range { offset: 2, .. })
            ));
        }
        assert_eq!(bridge.view(&id, 1).unwrap().persisted_bytes, 8);
        assert_eq!(bridge.view(&id, 1).unwrap().buffered_bytes, 0);
    }

    #[test]
    fn web_store_restore_preserves_ids_without_reoffering_unknown_native_delivery() {
        let bridge = WebFileBridge::default();
        let mut status = test_store_status("retained", StoreDirection::Outgoing, 4);
        status.durable_bytes = 4;
        status.phase = StorePhase::Committed;
        status.committed_sha256 = Some([7; 32]);
        bridge.restore_storage(status.clone(), 4, false).unwrap();
        bridge.restore_storage(status.clone(), 4, false).unwrap();
        assert_eq!(bridge.view("retained", 0).unwrap().state, "failed");
        assert!(bridge.view("retained", 0).unwrap().download_available);
        assert!(bridge.next_to_start().is_none());
        assert!(bridge.control_id("retained", "resume").is_err());
        status.spec.object_id = "conflicting-object".into();
        assert_eq!(
            bridge.restore_storage(status, 4, false).unwrap_err(),
            "TRANSFER_STORAGE_CONFLICT"
        );
        let mut staging = test_store_status("partial", StoreDirection::Outgoing, 8);
        staging.spec.message_id = "another-message".into();
        staging.spec.operation_id = Some("another-operation".into());
        staging.durable_bytes = 3;
        bridge.restore_storage(staging, 4, false).unwrap();
        assert_eq!(bridge.view("partial", 0).unwrap().state, "uploading");
        assert_eq!(bridge.view("partial", 0).unwrap().uploaded_bytes, 3);
    }

    #[test]
    fn web_store_failed_queued_source_reconciles_once_and_cancel_hides_retained_payload() {
        let bridge = WebFileBridge::default();
        let store = Arc::new(DeferredTransferStore::default());
        store.ready.store(true, Ordering::Release);
        bridge.install_store(store.clone()).unwrap();
        let id = bridge
            .enqueue_outgoing(
                "profile",
                1,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let mut status = test_store_status(&id, StoreDirection::Outgoing, 4);
        bridge.bind_storage(&id, status.spec.clone()).unwrap();
        *store.reply.lock().unwrap() = Some(Err(StoreError::Quota));
        assert_eq!(bridge.drive_storage().unwrap_err(), "WORKSPACE_QUOTA_FULL");
        assert_eq!(bridge.unreconciled_terminal_ids(), vec![id.clone()]);
        assert!(bridge.acknowledge_terminal(&id));
        assert!(bridge.unreconciled_terminal_ids().is_empty());
        assert!(bridge.next_to_start().is_none());
        status.phase = StorePhase::Committed;
        status.durable_bytes = 4;
        status.committed_sha256 = Some([7; 32]);
        *store.published.lock().unwrap() = vec![status];
        *store.reply.lock().unwrap() = None;
        bridge.drive_storage().unwrap();
        bridge.control_id(&id, "cancel").unwrap();
        assert!(!bridge.view(&id, 0).unwrap().download_available);
        bridge.drive_storage().unwrap();
        assert!(matches!(
            store.operations.lock().unwrap().last(),
            Some(StoreOperation::Remove { .. })
        ));
    }

    #[test]
    fn web_store_fragmented_maximum_incoming_uses_bounded_batches_and_exact_durable_bytes() {
        let bridge = WebFileBridge::default();
        let store = Arc::new(DeferredTransferStore::default());
        store.ready.store(true, Ordering::Release);
        bridge.install_store(store.clone()).unwrap();
        let size = crate::MAX_CHAT_FILE_BYTES;
        let id = bridge
            .offer_incoming(
                "profile",
                1,
                9,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                size,
            )
            .unwrap();
        let mut status = test_store_status(&id, StoreDirection::Incoming, size);
        bridge.bind_storage(&id, status.spec.clone()).unwrap();
        *store.published.lock().unwrap() = vec![status.clone()];
        bridge.control_id(&id, "resume").unwrap();
        bridge.drive_storage().unwrap();
        bridge.next_to_start().unwrap();
        let mut native_hash = Sha256::new();
        let mut stored_hash = Sha256::new();
        let mut batch_lengths = Vec::new();
        let mut position = 0_u64;
        while position < size {
            let length = 1_373_usize.min((size - position) as usize);
            let bytes = (position..position + length as u64)
                .map(|value| (value % 251) as u8)
                .collect::<Vec<_>>();
            native_hash.update(&bytes);
            assert!(bridge
                .push_incoming_chunk_at(&id, position, &bytes, position)
                .unwrap());
            position += length as u64;
            bridge.drive_storage().unwrap();
            let operations = std::mem::take(&mut *store.operations.lock().unwrap());
            for operation in operations {
                if let StoreOperation::Append { offset, bytes, .. } = operation {
                    assert_eq!(offset, status.durable_bytes);
                    assert!(!bytes.is_empty() && bytes.len() <= FRAME_STREAM_CHUNK_BYTES);
                    stored_hash.update(&bytes);
                    status.durable_bytes += bytes.len() as u64;
                    batch_lengths.push(bytes.len());
                    *store.published.lock().unwrap() = vec![status.clone()];
                }
            }
            assert!(
                bridge.view(&id, position).unwrap().buffered_bytes
                    <= FRAME_STREAM_CHUNK_BYTES as u64 + 1_373
            );
        }
        // Publish the final durable suffix, then commit it independently of any
        // browser request or the optional trailing native zero-length callback.
        bridge.drive_storage().unwrap();
        assert_eq!(status.durable_bytes, size);
        assert_eq!(
            native_hash.finalize().as_slice(),
            stored_hash.finalize().as_slice()
        );
        assert!(
            batch_lengths.len() <= 26,
            "native fragments became individual disk writes: {}",
            batch_lengths.len()
        );
        assert!(batch_lengths[..batch_lengths.len() - 1]
            .iter()
            .all(|length| *length > FRAME_STREAM_CHUNK_BYTES - 1_373));
        assert!(matches!(
            store.operations.lock().unwrap().last(),
            Some(StoreOperation::Finalize { .. })
        ));
        status.phase = StorePhase::Committed;
        status.committed_sha256 = Some([4; 32]);
        *store.published.lock().unwrap() = vec![status];
        bridge.drive_storage().unwrap();
        let view = bridge.view(&id, position).unwrap();
        assert_eq!(view.state, "complete");
        assert_eq!(view.persisted_bytes, size);
        assert_eq!(view.buffered_bytes, 0);
    }

    #[test]
    fn web_store_local_pause_survives_peer_resume_and_late_native_demand() {
        let bridge = WebFileBridge::default();
        let outgoing = bridge
            .enqueue_outgoing(
                "profile",
                1,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                8,
            )
            .unwrap();
        bridge.next_to_start().unwrap();
        bridge.outgoing_started(&outgoing, 9).unwrap();
        bridge.on_outgoing_request(&outgoing, 0, 4);
        bridge
            .stage_outgoing_upload(&outgoing, 0, &[1, 2, 3, 4])
            .unwrap();
        bridge.control_id(&outgoing, "pause").unwrap();
        let other = bridge
            .enqueue_outgoing(
                "another-profile",
                2,
                "other-message".into(),
                "other.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        assert_eq!(bridge.next_to_start().unwrap().id, other);
        bridge.outgoing_started(&other, 10).unwrap();
        assert_eq!(
            bridge.on_native_control("profile", 1, 9, 0).unwrap().state,
            "paused"
        );
        assert!(bridge.on_outgoing_request(&outgoing, 4, 4));
        assert_eq!(bridge.view(&outgoing, 0).unwrap().state, "paused");
        assert!(bridge
            .next_outgoing_chunk(&outgoing, 1_000)
            .unwrap()
            .0
            .is_none());
        assert_eq!(
            bridge.inner.lock().unwrap().active_id.as_deref(),
            Some(other.as_str())
        );
        bridge.control_id(&outgoing, "resume").unwrap();
        assert_eq!(
            bridge.on_native_control("profile", 1, 9, 0).unwrap().state,
            "queued"
        );
        assert!(bridge.on_outgoing_request(&outgoing, 4, 4));
        assert_eq!(bridge.view(&outgoing, 0).unwrap().state, "queued");

        let incoming = bridge
            .offer_incoming(
                "profile",
                1,
                11,
                "incoming".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                8,
            )
            .unwrap();
        bridge.control_id(&incoming, "resume").unwrap();
        bridge.control_id(&incoming, "pause").unwrap();
        assert_eq!(
            bridge.incoming_by_native("profile", 1, 11).as_deref(),
            Some(incoming.as_str())
        );
        assert!(!bridge
            .push_incoming_chunk_at(&incoming, 0, &[5, 6, 7, 8], 1)
            .unwrap());
        assert_eq!(
            bridge.on_native_control("profile", 1, 11, 0).unwrap().state,
            "paused"
        );
        assert_eq!(bridge.view(&incoming, 1).unwrap().buffered_bytes, 4);
        assert_eq!(bridge.view(&incoming, 1).unwrap().state, "paused");
    }

    #[test]
    fn web_store_queue_keeps_begin_order_across_reverse_commits_and_releases_terminal_head() {
        for disposition in ["complete", "cancel", "fail"] {
            let bridge = WebFileBridge::default();
            let store = Arc::new(DeferredTransferStore::default());
            store.ready.store(true, Ordering::Release);
            bridge.install_store(store.clone()).unwrap();
            let mut coordinator = TransferCoordinator::default();
            let first = bridge
                .enqueue_outgoing(
                    "profile",
                    1,
                    "message".into(),
                    "test.bin".into(),
                    "application/octet-stream".into(),
                    4,
                )
                .unwrap();
            let mut first_status = test_store_status(&first, StoreDirection::Outgoing, 4);
            bridge
                .bind_storage(&first, first_status.spec.clone())
                .unwrap();
            bridge.register_queued_outgoing(&mut coordinator).unwrap();
            let later = bridge
                .enqueue_outgoing(
                    "other-profile",
                    2,
                    "image-message".into(),
                    "later.png".into(),
                    "image/png".into(),
                    4,
                )
                .unwrap();
            let mut later_status = test_store_status(&later, StoreDirection::Outgoing, 4);
            later_status.spec.profile_id = "other-profile".into();
            later_status.spec.message_id = "image-message".into();
            later_status.spec.name = "later.png".into();
            later_status.spec.mime = "image/png".into();
            bridge
                .bind_storage(&later, later_status.spec.clone())
                .unwrap();
            bridge.register_queued_outgoing(&mut coordinator).unwrap();
            let unaccepted = bridge
                .offer_incoming(
                    "other-profile",
                    2,
                    11,
                    "unaccepted".into(),
                    "proposal.bin".into(),
                    "application/octet-stream".into(),
                    4,
                )
                .unwrap();
            later_status.phase = StorePhase::Committed;
            later_status.durable_bytes = 4;
            later_status.committed_sha256 = Some([7; 32]);
            *store.published.lock().unwrap() = vec![later_status.clone(), first_status.clone()];
            bridge.drive_storage().unwrap();
            bridge.register_queued_outgoing(&mut coordinator).unwrap();
            assert!(
                bridge.next_to_start().is_none(),
                "later committed payload overtook the uploading head"
            );
            assert_eq!(coordinator.active().unwrap().id, first);
            assert_eq!(bridge.view(&later, 0).unwrap().state, "queued");
            assert_eq!(bridge.view(&unaccepted, 0).unwrap().state, "offered");
            assert!(!coordinator.contains(&unaccepted));
            match disposition {
                "complete" => {
                    first_status.phase = StorePhase::Committed;
                    first_status.durable_bytes = 4;
                    first_status.committed_sha256 = Some([7; 32]);
                    *store.published.lock().unwrap() =
                        vec![later_status.clone(), first_status.clone()];
                    bridge.drive_storage().unwrap();
                    assert_eq!(bridge.next_to_start().unwrap().id, first);
                    assert_eq!(coordinator.active().unwrap().id, first);
                    bridge.outgoing_started(&first, 9).unwrap();
                    assert!(bridge.on_outgoing_request(&first, 4, 0));
                    coordinator.complete_stream(&first).unwrap();
                }
                "cancel" => {
                    bridge.control_id(&first, "cancel").unwrap();
                    coordinator.cancel(&first).unwrap();
                }
                "fail" => {
                    first_status.durable_bytes = 4;
                    *store.published.lock().unwrap() =
                        vec![later_status.clone(), first_status.clone()];
                    *store.reply.lock().unwrap() = Some(Err(StoreError::Hash));
                    assert_eq!(
                        bridge.drive_storage().unwrap_err(),
                        "TRANSFER_HASH_MISMATCH"
                    );
                    assert_eq!(bridge.view(&first, 0).unwrap().state, "failed");
                    coordinator.cancel(&first).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(bridge.acknowledge_terminal(&first));
            assert_eq!(
                bridge.next_to_start().unwrap().id,
                later,
                "head {disposition}"
            );
            assert_eq!(
                coordinator.active().unwrap().id,
                later,
                "head {disposition}"
            );
            assert_eq!(bridge.view(&unaccepted, 0).unwrap().state, "offered");
            assert!(!coordinator.contains(&unaccepted));
        }
    }

    fn assert_web_outgoing_callback_publication(boundary: &str) {
        struct Fixture {
            root: PathBuf,
            history_path: PathBuf,
            handle: Mutex<Option<crate::ToxHandle>>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Some(handle) = self.handle.get_mut().unwrap().take() {
                    unsafe { crate::tox_kill(handle.instance.as_ptr()) };
                }
                let _ = crate::flush_deferred_profile_writes();
                crate::chat_history_store::unregister(&self.history_path);
                let _ = fs::remove_dir_all(&self.root);
            }
        }
        let root = std::env::temp_dir().join(format!(
            "kaigen-web-outgoing-completion-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let fixture = Fixture {
            history_path: root.join("chat-history.json"),
            handle: Mutex::new(Some(
                crate::create_tox_handle(
                    root.join("unused.tox"),
                    None,
                    None,
                    &NetworkSettings {
                        udp_enabled: false,
                        ipv6_enabled: false,
                        local_discovery_enabled: false,
                    },
                    None,
                )
                .unwrap(),
            )),
            root,
        };
        let bridge = Arc::new(WebFileBridge::default());
        let id = bridge
            .enqueue_outgoing(
                "profile",
                1,
                "message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let mut route = bridge.next_to_start().unwrap();
        assert_eq!(route.id, id);
        if boundary != "offer" {
            bridge.outgoing_started(&id, 7).unwrap();
            route = bridge.routing(&id).unwrap();
        }
        let mut status = test_store_status(&id, StoreDirection::Outgoing, 4);
        status.phase = StorePhase::Committed;
        status.durable_bytes = 4;
        status.committed_sha256 = Some([7; 32]);
        let message: crate::ToxMessage = serde_json::from_value(serde_json::json!({
            "id": "message", "friend_number": 1, "friend_public_key": status.spec.friend_public_key,
            "text": "", "mine": true, "timestamp": 1, "delivery": "pending",
            "attachment": { "name": "test.bin", "size": 4, "mime": "application/octet-stream", "path": format!("browser-stream://{id}"), "image": false, "transfer_state": "sending", "completed": false }
        })).unwrap();
        crate::chat_history_store::open_and_register(&fixture.history_path, vec![message.clone()])
            .unwrap();
        let messages = Arc::new(Mutex::new(vec![message]));
        let enabled = Arc::new(AtomicBool::new(true));
        let outgoing = crate::OutgoingFile {
            path: PathBuf::new(),
            filename: "test.bin".into(),
            mime: "application/octet-stream".into(),
            size: 4,
            source_bytes: None,
            message_id: Some("message".into()),
            protocol_transfer_id: None,
            meter: crate::TransferMeter::new(),
            last_activity_at: Instant::now(),
            active: true,
            locally_paused: false,
            phase: crate::OutgoingFilePhase::Transferring,
            fully_sent: true,
            retry_count: 0,
            web_transfer_id: Some(id.clone()),
        };
        let mut context = crate::CallbackContext {
            updates: None,
            incoming_requests: Arc::default(),
            incoming_requests_path: fixture.root.join("requests.json"),
            messages: Arc::clone(&messages),
            history_residency: Arc::default(),
            delivery_receipts: Arc::default(),
            receipt_progress: Arc::default(),
            history_path: fixture.history_path.clone(),
            history_enabled: Arc::clone(&enabled),
            pending_files: Arc::default(),
            pending_files_path: fixture.root.join("pending.json"),
            incoming_files: Arc::default(),
            outgoing_files: Arc::new(Mutex::new(if boundary == "offer" {
                HashMap::new()
            } else {
                HashMap::from([((1, 7), outgoing.clone())])
            })),
            downloads_dir: fixture.root.join("downloads"),
            avatars_dir: fixture.root.join("avatars"),
            transfer_log_path: fixture.root.join("transfer.log"),
            network_log_path: fixture.root.join("network.log"),
            friend_cache: Arc::default(),
            friend_cache_path: fixture.root.join("friends.json"),
            pq: Arc::new(crate::PqEngine::new(&fixture.root).unwrap()),
            chat_protocol: Arc::new(crate::ChatProtocolEngine::new(&fixture.root).unwrap()),
            file_card_protocol: Arc::new(crate::FileCardEngine::new(&fixture.root).unwrap()),
            pq_receipts: Arc::default(),
            file_receive_settings: Arc::default(),
            unread_state: Arc::default(),
            unread_state_path: fixture.root.join("unread.json"),
            friend_message_ready_at: Arc::default(),
            network_enabled: Arc::new(AtomicBool::new(false)),
            chat_transaction_gate: Arc::default(),
            chat_transport_ready: Arc::new(AtomicBool::new(false)),
            web_profile_id: Some("profile".into()),
            web_file_bridge: Some(Arc::clone(&bridge)),
        };
        let callback_ran = std::cell::Cell::new(false);
        let native_send_returned = std::cell::Cell::new(None);
        let outgoing_files = Arc::clone(&context.outgoing_files);
        let mut callback = |tox| {
            let user_data = (&mut context as *mut crate::CallbackContext).cast();
            unsafe {
                if boundary == "offer" {
                    crate::on_file_recv_control(tox, 1, 7, 2, user_data);
                } else {
                    crate::on_file_chunk_request(tox, 1, 7, 4, 0, user_data);
                }
            }
            callback_ran.set(true);
        };
        if boundary == "progress" {
            // Preserve the original regression: a real terminal callback, then
            // the same late accepted-progress publisher used by drain.
            {
                let handle = fixture.handle.lock().unwrap();
                callback(handle.as_ref().unwrap().instance.as_ptr());
            }
            assert!(outgoing_files.lock().unwrap().is_empty());
            assert_eq!(bridge.view(&id, 0).unwrap().state, "complete");
            assert!(
                messages.lock().unwrap()[0]
                    .attachment
                    .as_ref()
                    .unwrap()
                    .completed
            );
            let (message_id, transferred, size, speed) = bridge.progress_with_speed(&id).unwrap();
            publish_web_outgoing_progress(&messages, &message_id, transferred, speed, size);
        } else {
            // Deterministically take the native callback's lock if the start
            // path exposes it before publishing its row/binding. A held lock
            // defers the real callback until the production helper returns.
            let mut before_publish = || {
                if let Ok(handle) = fixture.handle.try_lock() {
                    callback(handle.as_ref().unwrap().instance.as_ptr());
                }
            };
            match boundary {
                "resume" => {
                    crate::set_attachment_transfer_state(&messages, "message", "paused");
                    assert!(resume_web_transfer_with_native_control(
                        &fixture.handle,
                        &Mutex::new(FileReceiveSettings::default()),
                        &bridge,
                        &messages,
                        &route,
                        |_| 0,
                        &mut before_publish,
                    )
                    .unwrap());
                }
                "offer" => offer_web_transfer_with_native_send(
                    &fixture.handle,
                    &bridge,
                    &messages,
                    &outgoing_files,
                    &route,
                    "message",
                    outgoing,
                    |_, _| {
                        native_send_returned.set(Some(Instant::now()));
                        (7, 0)
                    },
                    &mut before_publish,
                )
                .unwrap(),
                _ => unreachable!(),
            }
        }
        if boundary == "offer" {
            let outgoing = outgoing_files.lock().unwrap();
            let transfer = outgoing.get(&(1, 7)).unwrap();
            let sent_at = native_send_returned.get().unwrap();
            assert!(transfer.last_activity_at >= sent_at);
            assert!(transfer.meter.last_at >= sent_at);
        }
        if !callback_ran.get() {
            let handle = fixture.handle.lock().unwrap();
            callback(handle.as_ref().unwrap().instance.as_ptr());
        }
        if boundary == "offer" {
            assert_eq!(
                bridge.view(&id, 0).unwrap().state,
                "cancelled",
                "native cancellation arrived before the new offer binding was published"
            );
            assert!(outgoing_files.lock().unwrap().is_empty());
            let rows = messages.lock().unwrap();
            let attachment = rows[0].attachment.as_ref().unwrap();
            assert_eq!(attachment.transfer_state, "cancelled");
            assert_eq!(
                attachment.transfer_error.as_deref(),
                Some("TRANSFER_REJECTED_BY_RECIPIENT")
            );
            assert!(!attachment.completed);
            assert!(bridge.next_to_start().is_none());
            return;
        }
        // This ordered snapshot also models persistence at profile stop.
        crate::persist_tox_history_required(&messages, &fixture.history_path, &enabled).unwrap();
        crate::flush_deferred_profile_writes().unwrap();
        crate::chat_history_store::unregister(&fixture.history_path);
        crate::chat_history_store::open_and_register(&fixture.history_path, Vec::new()).unwrap();
        let restored = WebFileBridge::default();
        let deadline = Instant::now() + Duration::from_secs(3);
        let completed = loop {
            if let Some(completed) = restored
                .historical_completion(&fixture.history_path, 1, &status.spec)
                .unwrap()
            {
                break completed;
            }
            assert!(
                Instant::now() < deadline,
                "history completion probe timed out"
            );
            thread::sleep(Duration::from_millis(5));
        };
        restored.restore_storage(status, 1, completed).unwrap();
        let view = restored.view(&id, 0).unwrap();
        assert_eq!(
            view.state, "complete",
            "stale drain progress erased the native completion from durable history"
        );
        assert_eq!(view.transferred_bytes, 4);
        assert_eq!(view.uploaded_bytes, 4);
        assert!(view.payload_committed && view.download_available);
        assert_eq!(restored.routing(&id).unwrap().file_number, u32::MAX);
        assert!(restored.next_to_start().is_none());
    }

    #[test]
    fn web_outgoing_progress_after_native_completion_preserves_durable_restore() {
        assert_web_outgoing_callback_publication("progress");
    }

    #[test]
    fn web_transfer_start_resume_preserves_native_completion_in_durable_history() {
        assert_web_outgoing_callback_publication("resume");
    }

    #[test]
    fn web_transfer_start_offer_binds_before_native_cancellation() {
        assert_web_outgoing_callback_publication("offer");
    }

    #[test]
    fn web_outgoing_progress_preserves_active_and_explicit_retry_updates() {
        let message: crate::ToxMessage = serde_json::from_value(serde_json::json!({
            "id": "message", "friend_number": 1, "friend_public_key": "AB".repeat(32),
            "text": "", "mine": true, "timestamp": 1, "delivery": "pending",
            "attachment": { "name": "test.bin", "size": 4, "mime": "application/octet-stream", "path": "browser-stream://active", "transfer_state": "sending", "completed": false }
        })).unwrap();
        let messages = Arc::new(Mutex::new(vec![message]));
        for retry in [false, true] {
            if retry {
                crate::set_attachment_transfer_error(&messages, "message", "fixture failure");
                crate::set_attachment_retrying(&messages, "message", 1);
                crate::set_attachment_transfer_state(&messages, "message", "sending");
            }
            publish_web_outgoing_progress(&messages, "message", 3, 2, 4);
            let rows = messages.lock().unwrap();
            let attachment = rows[0].attachment.as_ref().unwrap();
            assert_eq!(attachment.transfer_state, "sending");
            assert_eq!(attachment.transferred, 3);
            assert_eq!(attachment.speed_bytes_per_sec, 2);
            assert_eq!(attachment.eta_seconds, Some(1));
            assert!(!attachment.completed && attachment.completed_at.is_none());
            assert!(attachment.transfer_error.is_none());
            assert_eq!(attachment.retry_count, u8::from(retry));
        }
    }

    fn assert_web_outgoing_progress_preserves_control(action: &str) {
        let message: crate::ToxMessage = serde_json::from_value(serde_json::json!({
            "id": "message", "friend_number": 1, "friend_public_key": "AB".repeat(32),
            "text": "", "mine": true, "timestamp": 1, "delivery": "pending",
            "attachment": { "name": "test.bin", "size": 8, "mime": "application/octet-stream", "path": "browser-stream://active", "transferred": 1, "transfer_state": "sending", "completed": false }
        })).unwrap();
        let messages = Arc::new(Mutex::new(vec![message]));
        // These are the authoritative row mutations used by native peer-control
        // callbacks after they acquire the handle released by the drain.
        match action {
            "pause" => crate::set_attachment_transfer_state(&messages, "message", "paused"),
            "cancel" => crate::set_attachment_transfer_cancelled(
                &messages,
                "message",
                "TRANSFER_REJECTED_BY_RECIPIENT",
            ),
            _ => unreachable!(),
        }
        let before = serde_json::to_value(&messages.lock().unwrap()[0].attachment).unwrap();
        publish_web_outgoing_progress(&messages, "message", 7, 4, 8);
        let after = serde_json::to_value(&messages.lock().unwrap()[0].attachment).unwrap();
        assert_eq!(
            after, before,
            "stale drain progress overwrote the authoritative {action} state"
        );

        // Resume publishes sending before another drain; a deliberate retry
        // first resets its row through the existing retry transition.
        if action == "cancel" {
            crate::set_attachment_retrying(&messages, "message", 1);
        }
        crate::set_attachment_transfer_state(&messages, "message", "sending");
        publish_web_outgoing_progress(&messages, "message", 7, 4, 8);
        let rows = messages.lock().unwrap();
        let attachment = rows[0].attachment.as_ref().unwrap();
        assert_eq!(attachment.transfer_state, "sending");
        assert_eq!(attachment.transferred, 7);
        assert_eq!(attachment.speed_bytes_per_sec, 4);
        assert_eq!(attachment.eta_seconds, Some(1));
        assert!(!attachment.completed && attachment.completed_at.is_none());
        assert!(attachment.transfer_error.is_none());
    }

    #[test]
    fn web_outgoing_progress_preserves_pause_until_explicit_resume() {
        assert_web_outgoing_progress_preserves_control("pause");
    }

    #[test]
    fn web_outgoing_progress_preserves_cancel_until_explicit_retry() {
        assert_web_outgoing_progress_preserves_control("cancel");
    }

    #[test]
    fn web_store_history_recovery_reads_evicted_completion_without_native_binding() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-web-transfer-history-{}-{}",
            std::process::id(),
            transfer_clock_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let history_path = root.join("chat-history.json");
        let mut status = test_store_status("restored", StoreDirection::Outgoing, 4);
        status.phase = StorePhase::Committed;
        status.durable_bytes = 4;
        status.committed_sha256 = Some([7; 32]);
        let message: crate::ToxMessage = serde_json::from_value(serde_json::json!({
            "id": "message", "friend_number": 1, "friend_public_key": status.spec.friend_public_key,
            "text": "", "mine": true, "timestamp": 1, "delivery": "delivered", "delivered_at": 2,
            "attachment": { "name": "test.bin", "size": 4, "mime": "application/octet-stream", "path": "browser-stream://restored", "image": false, "transfer_state": "complete", "completed": true }
        })).unwrap();
        assert!(!crate::message_requires_runtime_residency(&message));
        crate::chat_history_store::open_and_register(&history_path, vec![message]).unwrap();
        let bridge = WebFileBridge::default();
        assert_eq!(
            bridge
                .historical_completion(&history_path, 1, &status.spec)
                .unwrap(),
            None
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        let completed = loop {
            if let Some(completed) = bridge
                .historical_completion(&history_path, 1, &status.spec)
                .unwrap()
            {
                break completed;
            }
            assert!(
                Instant::now() < deadline,
                "history worker did not publish completion"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(completed);
        bridge
            .restore_storage(status.clone(), 1, completed)
            .unwrap();
        assert_eq!(bridge.view("restored", 0).unwrap().state, "complete");
        assert_eq!(bridge.routing("restored").unwrap().file_number, u32::MAX);
        assert!(bridge.next_to_start().is_none());
        bridge.forget_profile("profile").unwrap();
        assert!(bridge.view("restored", 0).is_err());
        assert!(bridge.history_probes.lock().unwrap().is_empty());
        bridge.restore_storage(status, 1, false).unwrap();
        assert_eq!(bridge.view("restored", 0).unwrap().state, "failed");
        assert_eq!(bridge.routing("restored").unwrap().file_number, u32::MAX);
        assert!(bridge.next_to_start().is_none());
        crate::chat_history_store::unregister(&history_path);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn web_store_quota_denial_precedes_native_resume_and_rejects_once_without_dropping_retained_data(
    ) {
        let bridge = WebFileBridge::default();
        let store = Arc::new(DeferredTransferStore::default());
        store.ready.store(true, Ordering::Release);
        bridge.install_store(store.clone()).unwrap();
        let mut coordinator = TransferCoordinator::default();
        let mut retained = test_store_status("retained", StoreDirection::Incoming, 4);
        retained.phase = StorePhase::Committed;
        retained.durable_bytes = 4;
        retained.committed_sha256 = Some([4; 32]);
        bridge.restore_storage(retained.clone(), 1, false).unwrap();
        bridge.acknowledge_terminal("retained");

        let incoming = bridge
            .offer_incoming(
                "profile",
                1,
                27,
                "new-proposal".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let mut incoming_status = test_store_status(&incoming, StoreDirection::Incoming, 4);
        incoming_status.spec.message_id = "new-proposal".into();
        bridge
            .bind_storage(&incoming, incoming_status.spec.clone())
            .unwrap();
        coordinator
            .offer(TransferOffer {
                id: incoming.clone(),
                profile_id: "profile".into(),
                direction: TransferDirection::Incoming,
                size_bytes: 4,
                state: TransferState::Offered,
                transferred_bytes: 0,
                last_progress_at: None,
            })
            .unwrap();
        coordinator.accept(&incoming).unwrap();
        bridge.control_id(&incoming, "resume").unwrap();

        let outgoing = bridge
            .enqueue_outgoing(
                "other-profile",
                2,
                "source-message".into(),
                "test.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let mut source = test_store_status(&outgoing, StoreDirection::Outgoing, 4);
        source.spec.profile_id = "other-profile".into();
        source.spec.message_id = "source-message".into();
        source.phase = StorePhase::Committed;
        source.durable_bytes = 4;
        source.committed_sha256 = Some([7; 32]);
        bridge.bind_storage(&outgoing, source.spec.clone()).unwrap();
        bridge.register_queued_outgoing(&mut coordinator).unwrap();
        *store.published.lock().unwrap() = vec![retained.clone(), source];
        bridge.drive_storage().unwrap();
        assert!(
            matches!(store.operations.lock().unwrap().last(), Some(StoreOperation::Begin(spec)) if spec.object_id == incoming)
        );
        assert!(
            bridge.next_to_start().is_none(),
            "native resumed before the store reserved the full incoming payload"
        );
        assert!(bridge.failed_native_control(&incoming).is_none());
        assert_eq!(coordinator.active().unwrap().id, incoming);

        *store.reply.lock().unwrap() = Some(Err(StoreError::Quota));
        assert_eq!(bridge.drive_storage().unwrap_err(), "WORKSPACE_QUOTA_FULL");
        let (route, control) = bridge.failed_native_control(&incoming).unwrap();
        assert_eq!(route.profile_id, "profile");
        assert_eq!(route.friend_number, 1);
        assert_eq!(route.file_number, 27);
        assert_eq!(control, 2);
        assert!(!route.outgoing);
        assert_eq!(bridge.view(&incoming, 0).unwrap().state, "failed");
        coordinator.cancel(&incoming).unwrap();
        assert!(bridge.acknowledge_terminal(&incoming));
        assert!(bridge.failed_native_control(&incoming).is_none());
        assert!(bridge.unreconciled_terminal_ids().is_empty());
        assert_eq!(bridge.next_to_start().unwrap().id, outgoing);
        assert_eq!(coordinator.active().unwrap().id, outgoing);
        let old = bridge.view("retained", 0).unwrap();
        assert!(old.download_available && old.payload_committed);
        assert_eq!(old.persisted_bytes, 4);
        assert_eq!(old.payload_sha256, Some(URL_SAFE_NO_PAD.encode([4; 32])));
        assert!(!store
            .operations
            .lock()
            .unwrap()
            .iter()
            .any(|operation| matches!(operation, StoreOperation::Remove { .. })));
        assert_eq!(store.published.lock().unwrap()[0], retained);
    }

    #[test]
    fn web_runtime_attaches_profile_durability_before_initial_profile_checkpoint() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-web-runtime-durability-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let active = root.join("active");
        let checkpoints = Arc::new(AtomicUsize::new(0));
        let callback_checkpoints = Arc::clone(&checkpoints);
        let durability = WebProfileDurability::new(move || {
            callback_checkpoints.fetch_add(1, Ordering::AcqRel);
            Ok(())
        });
        let mut runtime = WebWorkspaceRuntime::start_with_profile_durability(
            root.clone(),
            active.clone(),
            durability,
        )
        .unwrap();

        runtime
            .create_profile("disposable", "Disposable", None)
            .unwrap();
        assert!(checkpoints.load(Ordering::Acquire) >= 1);

        runtime.stop().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_stop_drains_deferred_writes_before_active_tree_removal() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-web-runtime-stop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let active = root.join("active");
        let mut runtime = WebWorkspaceRuntime::start(root.clone(), active.clone()).unwrap();
        runtime
            .create_profile("disposable", "Disposable", None)
            .unwrap();
        {
            let profile = runtime.profiles.get("disposable").unwrap();
            crate::persist_tox_history(
                &profile.messages,
                &profile.history_path,
                &profile.history_enabled,
            );
            crate::persist_unread_state(&profile.unread_state, &profile.unread_state_path);
        }

        runtime.stop().unwrap();
        fs::remove_dir_all(&active).unwrap();
        thread::sleep(Duration::from_millis(500));

        assert!(
            !active.exists(),
            "a deferred profile write recreated the active tree"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transfer_operations_reject_a_different_captured_profile() {
        ensure_transfer_profile("captured-profile", "captured-profile").unwrap();
        assert_eq!(
            ensure_transfer_profile("captured-profile", "adjacent-profile").unwrap_err(),
            "TRANSFER_PROFILE_MISMATCH"
        );
    }

    #[test]
    fn identifiers_have_256_bit_minimum_and_variable_safe_length() {
        for _ in 0..64 {
            let id = WorkspaceIdentifier::generate().unwrap();
            assert!((43..=55).contains(&id.expose_once().len()));
            assert_eq!(WorkspaceIdentifier::parse(id.expose_once()).unwrap(), id);
        }
    }

    #[test]
    fn compatible_tox_export_is_password_protected_and_round_trips() {
        let savedata = b"disposable tox savedata".to_vec();
        let encrypted = encrypt_tox_profile_export(savedata.clone(), "export password".into())
            .expect("profile export must encrypt");
        assert!(profiles::is_encrypted(&encrypted));
        assert!(!encrypted
            .windows(savedata.len())
            .any(|window| window == savedata));
        let cipher = ProfileCipher::unlock(&encrypted, "export password")
            .expect("export password must unlock");
        assert_eq!(cipher.decrypt(&encrypted).unwrap(), savedata);
        assert!(ProfileCipher::unlock(&encrypted, "wrong password").is_err());
        assert_eq!(
            decrypt_tox_profile_import(encrypted.clone(), "export password").unwrap(),
            savedata
        );
        assert_eq!(
            decrypt_tox_profile_import(encrypted, "wrong password").unwrap_err(),
            "PROFILE_PASSWORD_INVALID"
        );
        assert_eq!(
            decrypt_tox_profile_import(b"unprotected".to_vec(), "").unwrap(),
            b"unprotected"
        );
    }

    #[test]
    fn portable_kai_import_uses_profile_password_and_restores_encrypted_data() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-web-kai-import-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let container = root.join("portable-profile.kai");
        let volume = KaiProfileVolume::create(container.clone(), Some("profile password")).unwrap();
        let namespace = volume.namespace_root().to_path_buf();
        volume
            .write(&namespace.join("profile.tox"), b"portable tox savedata")
            .unwrap();
        volume
            .write(
                &namespace.join("data/chat-history.json"),
                b"encrypted chat history",
            )
            .unwrap();
        volume.checkpoint(true).unwrap();
        let sidecar = volume.key_path().to_path_buf();
        drop(volume);

        let container_bytes = fs::read(&container).unwrap();
        assert!(!container_bytes
            .windows(b"portable tox savedata".len())
            .any(|window| window == b"portable tox savedata"));
        assert!(!container_bytes
            .windows(b"encrypted chat history".len())
            .any(|window| window == b"encrypted chat history"));

        // Browser upload transfers the selected .kai itself.  The envelope in
        // its authenticated header therefore remains sufficient even when the
        // adjacent crash-recovery sidecar is not part of the upload.
        fs::remove_file(sidecar).unwrap();
        assert_eq!(
            read_kai_profile_import(&container, Some("wrong password"))
                .err()
                .unwrap(),
            "PROFILE_PASSWORD_INVALID"
        );
        let imported = read_kai_profile_import(&container, Some("profile password")).unwrap();
        assert_eq!(imported.savedata, b"portable tox savedata");
        assert_eq!(
            imported.data_files,
            vec![(
                "chat-history.json".to_string(),
                b"encrypted chat history".to_vec()
            )]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_access_password_is_independent_from_profile_passwords() {
        let mut vault = WorkspaceVault::create([9_u8; 32], "workspace access").unwrap();
        vault.lock();
        assert_eq!(
            vault.unlock("profile password").unwrap_err(),
            "WORKSPACE_PASSWORD_INVALID"
        );
        vault.unlock("workspace access").unwrap();
        assert_eq!(vault.profile_count(), 1);
    }

    #[test]
    fn empty_workspace_round_trip_requires_only_its_access_password() {
        let mut domain = WorkspaceDomain::provisional(
            [8_u8; 32],
            WorkspaceConfig {
                storage_mode: StorageMode::Disk,
                quota_bytes: 1024,
                security_reserve_bytes: 1024,
                lease_hours: 24,
            },
            1,
        )
        .unwrap();
        domain.initialize_workspace("workspace access", 1).unwrap();
        assert_eq!(domain.profiles.stored_count(), 0);

        let encoded = serde_json::to_vec(&domain).unwrap();
        let mut restored: WorkspaceDomain = serde_json::from_slice(&encoded).unwrap();
        restored.lock_after_restart();
        assert_eq!(
            restored.unlock("profile password").unwrap_err(),
            "WORKSPACE_PASSWORD_INVALID"
        );
        restored.unlock("workspace access").unwrap();
        assert_eq!(restored.profiles.stored_count(), 0);
    }

    #[test]
    fn removing_the_last_profile_keeps_the_workspace_configuration_and_lease() {
        let mut domain = WorkspaceDomain::provisional(
            [6_u8; 32],
            WorkspaceConfig {
                storage_mode: StorageMode::Ram,
                quota_bytes: 4096,
                security_reserve_bytes: 2048,
                lease_hours: 24,
            },
            100,
        )
        .unwrap();
        domain.set_language("en").unwrap();
        domain
            .initialize_workspace("workspace access", 100)
            .unwrap();
        domain.quota.reserve_user(17).unwrap();
        domain.quota.reserve_security(19).unwrap();
        domain
            .add_profile(
                "only-profile".to_string(),
                "Only Profile".to_string(),
                false,
            )
            .unwrap();
        domain.profiles.activate("only-profile").unwrap();

        let lease_before = serde_json::to_vec(&domain.data_lease).unwrap();
        let quota_before = domain.quota.clone();
        let created_at_before = domain.created_at;

        domain.remove_profile("only-profile").unwrap();

        assert_eq!(domain.profiles.stored_count(), 0);
        assert_eq!(domain.profiles.active_count(), 0);
        assert_eq!(domain.storage_mode, StorageMode::Ram);
        assert_eq!(domain.language, "en");
        assert_eq!(domain.created_at, created_at_before);
        assert_eq!(domain.quota, quota_before);
        assert_eq!(
            serde_json::to_vec(&domain.data_lease).unwrap(),
            lease_before
        );
        assert!(domain.vault.as_ref().is_some_and(|vault| !vault.erased));

        domain.lock_after_restart();
        domain.unlock("workspace access").unwrap();
        assert_eq!(domain.profiles.stored_count(), 0);
    }

    #[test]
    fn close_without_export_revokes_browser_and_preserves_workspace() {
        let mut domain = WorkspaceDomain::provisional(
            [7_u8; 32],
            WorkspaceConfig {
                storage_mode: StorageMode::Disk,
                quota_bytes: 1024,
                security_reserve_bytes: 1024,
                lease_hours: 24,
            },
            1,
        )
        .unwrap();
        domain
            .initialize_workspace("workspace password", 1)
            .unwrap();
        domain
            .add_profile(
                "profile-id".to_string(),
                "Disposable Profile".to_string(),
                false,
            )
            .unwrap();
        domain.profiles.activate("profile-id").unwrap();
        let mut public_key = vec![0_u8; 91];
        public_key[..26].copy_from_slice(&[
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
            0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
        ]);
        public_key[26] = 0x04;
        let enrollment = domain.devices.enroll_after_password(public_key, 2).unwrap();
        let device_hash = domain.devices.token_hash(&enrollment.device_token).unwrap();
        assert_eq!(
            domain.ui_lease.acquire(device_hash, 2, true),
            LeaseDecision::Acquired
        );

        domain.close_without_export().unwrap();
        assert_eq!(domain.profiles.stored_count(), 1);
        assert_eq!(domain.profiles.active_count(), 0);
        assert!(!domain.ui_lease.has_holder());
        assert!(domain.devices.token_hash(&enrollment.device_token).is_err());

        assert_eq!(
            domain.unlock("profile password").unwrap_err(),
            "WORKSPACE_PASSWORD_INVALID"
        );
        domain.unlock("workspace password").unwrap();
        assert_eq!(domain.profiles.stored_count(), 1);
        assert_eq!(domain.profiles.active_count(), 1);
    }

    #[test]
    fn close_restart_unlock_restores_only_the_exact_active_profiles_and_selection() {
        let mut domain = WorkspaceDomain::provisional(
            [8_u8; 32],
            WorkspaceConfig {
                storage_mode: StorageMode::Disk,
                quota_bytes: 1024,
                security_reserve_bytes: 1024,
                lease_hours: 24,
            },
            1,
        )
        .unwrap();
        domain
            .initialize_workspace("workspace password", 1)
            .unwrap();
        domain
            .add_profile("disabled".to_string(), "Disabled".to_string(), false)
            .unwrap();
        domain
            .add_profile("replacement".to_string(), "Replacement".to_string(), false)
            .unwrap();
        domain.profiles.activate("disabled").unwrap();
        domain.profiles.activate("replacement").unwrap();
        domain.profiles.deactivate("disabled").unwrap();
        assert_eq!(domain.profiles.selected_profile_id(), Some("replacement"));

        domain.close_without_export().unwrap();
        assert_eq!(domain.profiles.active_count(), 0);
        let encoded = serde_json::to_vec(&domain).unwrap();
        let mut restored: WorkspaceDomain = serde_json::from_slice(&encoded).unwrap();
        restored.lock_after_restart();
        restored.unlock("workspace password").unwrap();

        assert_eq!(restored.profiles.active_count(), 1);
        assert!(
            !restored
                .profiles
                .profiles()
                .iter()
                .find(|profile| profile.id == "disabled")
                .unwrap()
                .active
        );
        assert!(
            restored
                .profiles
                .profiles()
                .iter()
                .find(|profile| profile.id == "replacement")
                .unwrap()
                .active
        );
        assert_eq!(restored.profiles.selected_profile_id(), Some("replacement"));
    }

    #[test]
    fn persisted_workspace_hides_profile_names_and_hydrates_after_unlock() {
        let mut domain = WorkspaceDomain::provisional(
            [4_u8; 32],
            WorkspaceConfig {
                storage_mode: StorageMode::Disk,
                quota_bytes: 1024,
                security_reserve_bytes: 1024,
                lease_hours: 24,
            },
            1,
        )
        .unwrap();
        domain
            .initialize_workspace("workspace password", 1)
            .unwrap();
        domain
            .add_profile(
                "profile-id".to_string(),
                "Secret Profile Name".to_string(),
                true,
            )
            .unwrap();
        let encoded = serde_json::to_vec(&domain).unwrap();
        assert!(!encoded
            .windows(b"Secret Profile Name".len())
            .any(|window| window == b"Secret Profile Name"));
        assert!(!encoded
            .windows(b"workspace password".len())
            .any(|window| window == b"workspace password"));
        let mut restored: WorkspaceDomain = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(restored.profiles.profiles()[0].display_name, "");
        restored.unlock("workspace password").unwrap();
        assert_eq!(
            restored.profiles.profiles()[0].display_name,
            "Secret Profile Name"
        );
    }

    #[test]
    fn resource_admission_uses_close_and_reopen_hysteresis() {
        let mut admission = ResourceAdmission::new(8).unwrap();
        let healthy = ResourceSnapshot {
            memory_available_percent: 50.0,
            disk_available_percent: 50.0,
            cpu_five_minute_percent: 20.0,
            projected_runtime_reserve_available: true,
            active_instances: 0,
        };
        assert!(admission.evaluate(healthy, 0).allowed);
        assert_eq!(
            admission
                .evaluate(
                    ResourceSnapshot {
                        memory_available_percent: 19.0,
                        ..healthy
                    },
                    10,
                )
                .reason,
            Some(AdmissionBlock::Memory)
        );
        assert_eq!(
            admission.evaluate(healthy, 20).reason,
            Some(AdmissionBlock::RecoveryWindow)
        );
        assert!(admission.evaluate(healthy, 320).allowed);
    }

    #[test]
    fn quota_full_does_not_consume_security_reserve() {
        let mut quota = QuotaLedger::new(100, 20).unwrap();
        quota.reserve_user(100).unwrap();
        assert_eq!(quota.reserve_user(1).unwrap_err(), "WORKSPACE_QUOTA_FULL");
        quota.reserve_security(20).unwrap();
        assert_eq!(quota.reserve_used_bytes, 20);
    }

    #[test]
    fn only_one_transfer_runs_and_ui_loss_releases_slot() {
        let mut transfers = TransferCoordinator::default();
        transfers
            .offer(TransferOffer {
                id: "a".into(),
                profile_id: "one".into(),
                direction: TransferDirection::Incoming,
                size_bytes: 10,
                state: TransferState::Offered,
                transferred_bytes: 0,
                last_progress_at: None,
            })
            .unwrap();
        transfers
            .offer(TransferOffer {
                id: "b".into(),
                profile_id: "two".into(),
                direction: TransferDirection::Outgoing,
                size_bytes: 10,
                state: TransferState::Queued,
                transferred_bytes: 0,
                last_progress_at: None,
            })
            .unwrap();
        assert_eq!(transfers.active().unwrap().id, "b");
        transfers.accept("a").unwrap();
        assert_eq!(transfers.active().unwrap().id, "b");
        transfers.on_ui_lost();
        assert!(transfers.active().is_none());
    }

    #[test]
    fn web_background_transfer_wire_matches_browser_contract() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/web-background-transfer-contract.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let expected = &case["work"];
            let bridge = WebFileBridge::default();
            let profile_id = expected["profileId"].as_str().unwrap();
            let friend_number = expected["friendNumber"].as_u64().unwrap() as u32;
            let message_id = expected["messageId"].as_str().unwrap();
            let name = expected["name"].as_str().unwrap();
            let mime = case["mime"].as_str().unwrap();
            let size = expected["size"].as_u64().unwrap();
            let id = if expected["direction"] == "outgoing" {
                bridge.enqueue_outgoing(
                    profile_id,
                    friend_number,
                    message_id.into(),
                    name.into(),
                    mime.into(),
                    size,
                )
            } else {
                bridge.offer_incoming(
                    profile_id,
                    friend_number,
                    9,
                    message_id.into(),
                    name.into(),
                    mime.into(),
                    size,
                )
            }
            .unwrap();
            let settings: FileReceiveSettings =
                serde_json::from_value(case["settings"].clone()).unwrap();
            let mut inner = bridge.inner.lock().unwrap();
            let transfer = inner.transfers.get_mut(&id).unwrap();
            transfer.id = expected["transferId"].as_str().unwrap().to_string();
            transfer.state = expected["state"].as_str().unwrap().to_string();
            let operation_id = expected["operationId"].as_str().map(str::to_string);
            let committed = expected["payloadCommitted"].as_bool().unwrap();
            let durable_bytes = expected[if transfer.outgoing {
                "uploadedBytes"
            } else {
                "persistedBytes"
            }]
            .as_u64()
            .unwrap();
            if operation_id.is_some() || committed || durable_bytes > 0 {
                let committed_sha256: Option<[u8; 32]> = expected["payloadSha256"]
                    .as_str()
                    .map(|hash| URL_SAFE_NO_PAD.decode(hash).unwrap().try_into().unwrap());
                transfer.storage = Some(StoreObjectStatus {
                    spec: StoreSpec {
                        object_id: transfer.id.clone(),
                        operation_id,
                        profile_id: profile_id.to_string(),
                        message_id: message_id.to_string(),
                        friend_public_key: "AB".repeat(32),
                        direction: if transfer.outgoing {
                            StoreDirection::Outgoing
                        } else {
                            StoreDirection::Incoming
                        },
                        name: name.to_string(),
                        mime: mime.to_string(),
                        size_bytes: size,
                        expected_sha256: if transfer.outgoing {
                            Some(committed_sha256.unwrap_or([0; 32]))
                        } else {
                            None
                        },
                    },
                    durable_bytes,
                    phase: if committed {
                        StorePhase::Committed
                    } else {
                        StorePhase::Staging
                    },
                    committed_sha256,
                    native_delivery_confirmed: None,
                });
                transfer.storage_ready = true;
            }
            let actual = serde_json::to_value(BackgroundTransferWorkEntry::from_transfer(
                transfer, &settings,
            ))
            .unwrap();
            assert_eq!(actual, *expected, "{}", case["id"]);
        }
    }

    #[test]
    fn web_file_bridge_has_one_workspace_slot_across_profiles_and_directions() {
        let bridge = WebFileBridge::default();
        let outgoing = bridge
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-out".into(),
                "out.bin".into(),
                "application/octet-stream".into(),
                1024,
            )
            .unwrap();
        let queued = bridge
            .enqueue_outgoing(
                "profile-two",
                2,
                "message-queued".into(),
                "queued.bin".into(),
                "application/octet-stream".into(),
                1024,
            )
            .unwrap();
        let incoming = bridge
            .offer_incoming(
                "profile-two",
                2,
                9,
                "message-in".into(),
                "in.bin".into(),
                "application/octet-stream".into(),
                1024,
            )
            .unwrap();

        let first = bridge.next_to_start().unwrap();
        assert_eq!(first.id, outgoing);
        assert!(first.outgoing);
        bridge.outgoing_started(&outgoing, 7).unwrap();
        assert!(bridge.next_to_start().is_none());

        // Explicitly accepting an incoming offer while another profile owns
        // the slot queues it without interrupting the active transfer.
        let accepted = bridge.control("message-in", "resume").unwrap();
        assert!(!accepted.outgoing);
        assert_eq!(bridge.view(&incoming, 1_000).unwrap().state, "queued");
        assert!(bridge.next_to_start().is_none());

        bridge.on_outgoing_request(&outgoing, 1024, 0);
        assert!(bridge.acknowledge_complete(&outgoing));
        let second = bridge.next_to_start().unwrap();
        assert_eq!(second.id, queued);
        assert!(second.outgoing);
        bridge.outgoing_started(&queued, 8).unwrap();
        bridge.on_outgoing_request(&queued, 1024, 0);
        assert!(bridge.acknowledge_complete(&queued));

        let third = bridge.next_to_start().unwrap();
        assert_eq!(third.id, incoming);
        assert!(!third.outgoing);
        assert_eq!(third.file_number, 9);
    }

    #[test]
    fn web_file_bridge_rate_bucket_is_shared_without_initial_burst() {
        let bridge = WebFileBridge::default();
        let chunk = (TRANSFER_RATE_BYTES_PER_SECOND / 2) as usize;
        let first = bridge
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-one".into(),
                "one.bin".into(),
                "application/octet-stream".into(),
                chunk as u64,
            )
            .unwrap();
        let second = bridge
            .enqueue_outgoing(
                "profile-two",
                2,
                "message-two".into(),
                "two.bin".into(),
                "application/octet-stream".into(),
                chunk as u64,
            )
            .unwrap();
        bridge.next_to_start().unwrap();
        bridge.outgoing_started(&first, 3).unwrap();
        assert!(bridge.on_outgoing_request(&first, 0, chunk));
        bridge
            .stage_outgoing_upload(&first, 0, &vec![1_u8; chunk])
            .unwrap();

        // Browser bytes are accepted once, but the first native send starts
        // with an empty shared bucket rather than a free one-megabyte burst.
        let (pending, wait_ms) = bridge.next_outgoing_chunk(&first, 1_000).unwrap();
        assert!(pending.is_none());
        assert_eq!(wait_ms, 500);
        let (pending, wait_ms) = bridge.next_outgoing_chunk(&first, 1_500).unwrap();
        let pending = pending.unwrap();
        assert_eq!(wait_ms, 0);
        assert_eq!(pending.position, 0);
        assert_eq!(pending.data.len(), chunk);

        // SENDQ refunds only the rate token. The staged browser body remains
        // available at the same position and is not requested over HTTP again.
        bridge.outgoing_chunk_rejected(pending.data.len());
        let retry = bridge
            .next_outgoing_chunk(&first, 1_500)
            .unwrap()
            .0
            .unwrap();
        assert_eq!(retry.position, 0);
        assert_eq!(retry.data, pending.data);
        bridge
            .outgoing_chunk_sent(&first, retry.position, retry.data.len(), 1_500)
            .unwrap();
        bridge.on_outgoing_request(&first, chunk as u64, 0);
        assert!(bridge.acknowledge_complete(&first));

        bridge.next_to_start().unwrap();
        bridge.outgoing_started(&second, 4).unwrap();
        assert!(bridge.on_outgoing_request(&second, 0, chunk));
        bridge
            .stage_outgoing_upload(&second, 0, &vec![2_u8; chunk])
            .unwrap();
        // A second profile cannot acquire a fresh per-profile bucket.
        assert_eq!(bridge.next_outgoing_chunk(&second, 1_500).unwrap().1, 500);
    }

    #[test]
    fn web_file_bridge_reports_measured_speed_and_live_eta() {
        let bridge = WebFileBridge::default();
        let native_chunk = 1024_usize;
        let transfer = bridge
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-one".into(),
                "one.bin".into(),
                "application/octet-stream".into(),
                3 * native_chunk as u64,
            )
            .unwrap();
        bridge.next_to_start().unwrap();
        bridge.outgoing_started(&transfer, 3).unwrap();
        for index in 0..3_u64 {
            assert!(bridge.on_outgoing_request(
                &transfer,
                index * native_chunk as u64,
                native_chunk,
            ));
        }
        bridge
            .stage_outgoing_upload(&transfer, 0, &vec![3_u8; 3 * native_chunk])
            .unwrap();
        let _ = bridge.view(&transfer, 1_000).unwrap();
        let first = bridge
            .next_outgoing_chunk(&transfer, 2_000)
            .unwrap()
            .0
            .unwrap();
        bridge
            .outgoing_chunk_sent(&transfer, first.position, first.data.len(), 2_000)
            .unwrap();
        let second = bridge
            .next_outgoing_chunk(&transfer, 3_000)
            .unwrap()
            .0
            .unwrap();
        bridge
            .outgoing_chunk_sent(&transfer, second.position, second.data.len(), 3_000)
            .unwrap();

        let view = bridge.view(&transfer, 3_000).unwrap();
        assert_eq!(view.transferred_bytes, 2 * native_chunk as u64);
        assert_eq!(view.speed_bytes_per_sec, native_chunk as u64);
        assert_eq!(view.eta_seconds, Some(1));
    }

    #[test]
    fn web_file_bridge_stages_each_browser_range_once_across_native_sendq() {
        let bridge = WebFileBridge::default();
        let native_chunk = 64 * 1024;
        let transfer = bridge
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-one".into(),
                "one.bin".into(),
                "application/octet-stream".into(),
                2 * FRAME_STREAM_CHUNK_BYTES as u64,
            )
            .unwrap();
        bridge.next_to_start().unwrap();
        bridge.outgoing_started(&transfer, 3).unwrap();
        for index in 0..32_u64 {
            assert!(bridge.on_outgoing_request(
                &transfer,
                index * native_chunk as u64,
                native_chunk,
            ));
        }
        let first_batch = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(first_batch.requested_position, Some(0));
        assert_eq!(first_batch.requested_length, Some(FRAME_STREAM_CHUNK_BYTES));
        let browser_frame = vec![9_u8; FRAME_STREAM_CHUNK_BYTES];
        bridge
            .stage_outgoing_upload(&transfer, 0, &browser_frame)
            .unwrap();
        let staged = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(staged.buffered_bytes, FRAME_STREAM_CHUNK_BYTES as u64);
        assert_eq!(staged.requested_position, None);
        assert_eq!(staged.requested_length, None);

        let (pending, wait_ms) = bridge.next_outgoing_chunk(&transfer, 1_000).unwrap();
        assert!(pending.is_none());
        assert_eq!(
            wait_ms,
            (native_chunk as u64 * 1000).div_ceil(TRANSFER_RATE_BYTES_PER_SECOND)
        );
        let pending = bridge
            .next_outgoing_chunk(&transfer, 2_000)
            .unwrap()
            .0
            .unwrap();
        bridge.outgoing_chunk_rejected(pending.data.len());
        let retry = bridge
            .next_outgoing_chunk(&transfer, 2_000)
            .unwrap()
            .0
            .unwrap();
        assert_eq!(retry.position, pending.position);
        assert_eq!(retry.data, pending.data);
        bridge
            .outgoing_chunk_sent(&transfer, retry.position, retry.data.len(), 2_000)
            .unwrap();

        for index in 1..16_u64 {
            let chunk = bridge
                .next_outgoing_chunk(&transfer, 2_000)
                .unwrap()
                .0
                .unwrap();
            bridge
                .outgoing_chunk_sent(
                    &transfer,
                    chunk.position,
                    chunk.data.len(),
                    2_000 + index * 200,
                )
                .unwrap();
        }
        assert_eq!(
            bridge
                .stage_outgoing_upload(&transfer, 0, &browser_frame)
                .unwrap_err(),
            "TRANSFER_CHUNK_STALE"
        );
        let current = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(
            current.requested_position,
            Some(FRAME_STREAM_CHUNK_BYTES as u64)
        );
        assert_eq!(current.requested_length, Some(FRAME_STREAM_CHUNK_BYTES));
    }

    #[test]
    fn web_file_bridge_pauses_before_25_mib_and_resumes_after_drain() {
        let bridge = WebFileBridge::default();
        let transfer = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-in".into(),
                "large.bin".into(),
                "application/octet-stream".into(),
                64 * 1024 * 1024,
            )
            .unwrap();
        bridge.control("message-in", "resume").unwrap();
        let route = bridge.next_to_start().unwrap();
        assert_eq!(route.id, transfer);
        assert!(!route.outgoing);

        let chunk = vec![7_u8; FRAME_STREAM_CHUNK_BYTES];
        let mut keep_running = true;
        for index in 0..24_u64 {
            keep_running = bridge
                .push_incoming_chunk(&transfer, index * FRAME_STREAM_CHUNK_BYTES as u64, &chunk)
                .unwrap();
        }
        assert!(!keep_running);
        let paused = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(paused.state, "backpressure");
        assert_eq!(paused.buffered_bytes, 24 * 1024 * 1024);
        assert!(paused.buffered_bytes <= TRANSFER_BUFFER_LIMIT_BYTES);

        for index in 0..11_u64 {
            bridge.take_incoming_chunk(&transfer).unwrap().unwrap();
            let (resumed, released) = bridge
                .acknowledge_incoming_chunk(
                    &transfer,
                    (index + 1) * FRAME_STREAM_CHUNK_BYTES as u64,
                )
                .unwrap();
            assert!(resumed.is_none());
            assert_eq!(released, FRAME_STREAM_CHUNK_BYTES as u64);
        }
        bridge.take_incoming_chunk(&transfer).unwrap().unwrap();
        let (resumed, released) = bridge
            .acknowledge_incoming_chunk(&transfer, 12 * FRAME_STREAM_CHUNK_BYTES as u64)
            .unwrap();
        let resumed = resumed.unwrap();
        assert_eq!(released, FRAME_STREAM_CHUNK_BYTES as u64);
        assert_eq!(resumed.id, transfer);
        assert_eq!(bridge.view(&transfer, 2_000).unwrap().state, "receiving");
    }

    #[test]
    fn web_file_bridge_deduplicates_replayed_incoming_ranges_without_progress_rollback() {
        let bridge = WebFileBridge::default();
        let transfer = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-in".into(),
                "image.png".into(),
                "image/png".into(),
                12,
            )
            .unwrap();
        bridge.control("message-in", "resume").unwrap();
        bridge.next_to_start().unwrap();

        assert!(bridge
            .push_incoming_chunk(&transfer, 0, &[0, 1, 2, 3, 4, 5, 6, 7])
            .unwrap());
        assert!(bridge
            .push_incoming_chunk(&transfer, 0, &[0, 1, 2, 3])
            .unwrap());
        let replayed = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(replayed.transferred_bytes, 8);
        assert_eq!(replayed.acknowledged_bytes, 0);
        assert_eq!(replayed.buffered_bytes, 8);

        assert!(bridge
            .push_incoming_chunk(&transfer, 4, &[4, 5, 6, 7, 8, 9, 10, 11])
            .unwrap());
        let completed_range = bridge.view(&transfer, 1_001).unwrap();
        assert_eq!(completed_range.transferred_bytes, 12);
        assert_eq!(completed_range.acknowledged_bytes, 0);
        assert_eq!(completed_range.buffered_bytes, 12);
        assert!(!bridge.incoming_remote_complete(&transfer));
        assert_eq!(bridge.view(&transfer, 1_002).unwrap().state, "receiving");

        let first = bridge.take_incoming_chunk(&transfer).unwrap().unwrap();
        assert_eq!(first, (0, vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
        assert_eq!(
            bridge.take_incoming_chunk(&transfer).unwrap().unwrap(),
            first,
            "a browser reload before acknowledgement must replay the same aggregate"
        );
        assert_eq!(bridge.view(&transfer, 1_002).unwrap().buffered_bytes, 12);
        bridge.acknowledge_incoming_chunk(&transfer, 12).unwrap();
        let acknowledged = bridge.view(&transfer, 1_002).unwrap();
        assert_eq!(acknowledged.acknowledged_bytes, 12);
        assert_eq!(acknowledged.buffered_bytes, 0);
        assert!(bridge.take_incoming_chunk(&transfer).unwrap().is_none());
        bridge.confirm_incoming_complete(&transfer).unwrap();
        assert_eq!(bridge.view(&transfer, 1_003).unwrap().state, "complete");
    }

    #[test]
    fn web_file_bridge_commits_verified_browser_bytes_before_trailing_native_callback() {
        let bridge = WebFileBridge::default();
        let transfer = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-in".into(),
                "recording.aup3".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        bridge.control("message-in", "resume").unwrap();
        bridge.next_to_start().unwrap();
        bridge
            .push_incoming_chunk(&transfer, 0, &[0, 1, 2, 3])
            .unwrap();
        bridge.take_incoming_chunk(&transfer).unwrap().unwrap();
        bridge.acknowledge_incoming_chunk(&transfer, 4).unwrap();

        bridge.confirm_incoming_complete(&transfer).unwrap();
        assert_eq!(bridge.view(&transfer, 1_000).unwrap().state, "complete");
        assert_eq!(bridge.active_terminal_id(), Some(transfer.clone()));
        assert!(bridge.acknowledge_terminal(&transfer));
    }

    #[test]
    fn web_file_bridge_routes_trailing_native_callback_while_incoming_is_paused() {
        let bridge = WebFileBridge::default();
        let transfer = bridge
            .offer_incoming(
                "profile-one",
                1,
                7,
                "message-in".into(),
                "file.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        bridge.control("message-in", "resume").unwrap();
        bridge.next_to_start().unwrap();
        bridge
            .push_incoming_chunk(&transfer, 0, &[0, 1, 2, 3])
            .unwrap();
        assert_eq!(
            bridge
                .on_native_control("profile-one", 1, 7, 1)
                .unwrap()
                .state,
            "paused"
        );
        assert_eq!(
            bridge.incoming_terminal_by_native("profile-one", 1, 7),
            Some(transfer.clone())
        );
        assert!(!bridge.incoming_remote_complete(&transfer));
        bridge.take_incoming_chunk(&transfer).unwrap().unwrap();
        bridge.acknowledge_incoming_chunk(&transfer, 4).unwrap();
        bridge.confirm_incoming_complete(&transfer).unwrap();
        assert_eq!(bridge.view(&transfer, 1_000).unwrap().state, "complete");
    }

    #[test]
    fn web_file_bridge_holds_queued_outgoing_until_incoming_completion_is_acknowledged() {
        let bridge = WebFileBridge::default();
        let transfer = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-in".into(),
                "file.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        bridge.control("message-in", "resume").unwrap();
        bridge.next_to_start().unwrap();
        let mut coordinator = TransferCoordinator::default();
        coordinator
            .offer(TransferOffer {
                id: transfer.clone(),
                profile_id: "profile-one".into(),
                direction: TransferDirection::Incoming,
                size_bytes: 4,
                state: TransferState::Offered,
                transferred_bytes: 0,
                last_progress_at: None,
            })
            .unwrap();
        coordinator.accept(&transfer).unwrap();
        assert_eq!(coordinator.active().unwrap().id, transfer);
        bridge
            .push_incoming_chunk(&transfer, 0, &[0, 1, 2, 3])
            .unwrap();

        assert_eq!(
            bridge.take_incoming_chunk(&transfer).unwrap().unwrap(),
            (0, vec![0, 1, 2, 3])
        );
        bridge.acknowledge_incoming_chunk(&transfer, 4).unwrap();
        let drained = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(drained.transferred_bytes, drained.size_bytes);
        assert_eq!(drained.buffered_bytes, 0);
        assert_eq!(drained.state, "receiving");

        let outgoing = bridge
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-out".into(),
                "reply.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        coordinator
            .offer(TransferOffer {
                id: outgoing.clone(),
                profile_id: "profile-one".into(),
                direction: TransferDirection::Outgoing,
                size_bytes: 4,
                state: TransferState::Queued,
                transferred_bytes: 0,
                last_progress_at: None,
            })
            .unwrap();
        assert_eq!(bridge.view(&outgoing, 1_000).unwrap().state, "queued");
        assert_eq!(coordinator.active().unwrap().id, transfer);
        assert!(bridge.next_to_start().is_none());

        assert!(!bridge.incoming_remote_complete(&transfer));
        assert_eq!(bridge.view(&transfer, 1_001).unwrap().state, "receiving");
        assert!(bridge.has_active());
        assert!(bridge.next_to_start().is_none());

        bridge.confirm_incoming_complete(&transfer).unwrap();
        assert_eq!(bridge.view(&transfer, 1_002).unwrap().state, "complete");
        coordinator.complete_stream(&transfer).unwrap();
        assert!(bridge.acknowledge_complete(&transfer));
        let next = bridge.next_to_start().unwrap();
        assert_eq!(next.id, outgoing);
        assert!(next.outgoing);
        assert_eq!(coordinator.active().unwrap().id, outgoing);
    }

    #[test]
    fn web_file_bridge_preserves_mixed_file_type_order_in_both_directions() {
        let bridge = WebFileBridge::default();
        let generic = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-generic".into(),
                "recording.aup3".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        let image = bridge
            .offer_incoming(
                "profile-one",
                1,
                6,
                "message-image".into(),
                "photo.jpg".into(),
                "image/jpeg".into(),
                4,
            )
            .unwrap();
        bridge.control("message-generic", "resume").unwrap();
        bridge.control("message-image", "resume").unwrap();
        assert_eq!(bridge.next_to_start().unwrap().id, generic);
        assert!(
            bridge.next_to_start().is_none(),
            "an image cannot overtake an active generic file"
        );
        bridge.push_incoming_chunk(&generic, 0, b"data").unwrap();
        assert!(!bridge.incoming_remote_complete(&generic));
        bridge.take_incoming_chunk(&generic).unwrap().unwrap();
        bridge.acknowledge_incoming_chunk(&generic, 4).unwrap();
        bridge.confirm_incoming_complete(&generic).unwrap();
        assert_eq!(bridge.view(&generic, 1_000).unwrap().state, "complete");
        assert!(bridge.acknowledge_complete(&generic));
        assert_eq!(bridge.next_to_start().unwrap().id, image);

        let outgoing = WebFileBridge::default();
        let image_first = outgoing
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-image-out".into(),
                "photo.png".into(),
                "image/png".into(),
                4,
            )
            .unwrap();
        let generic_second = outgoing
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-generic-out".into(),
                "archive.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        assert_eq!(outgoing.next_to_start().unwrap().id, image_first);
        assert!(
            outgoing.next_to_start().is_none(),
            "a generic upload cannot overtake an active image"
        );
        assert!(outgoing.on_outgoing_request(&image_first, 0, 0));
        assert!(outgoing.acknowledge_complete(&image_first));
        assert_eq!(outgoing.next_to_start().unwrap().id, generic_second);
    }

    #[test]
    fn web_file_bridge_rejects_oversize_before_offer_and_caps_outgoing_queue() {
        let bridge = WebFileBridge::default();
        assert_eq!(
            bridge
                .enqueue_outgoing(
                    "profile-one",
                    1,
                    "oversize-message".into(),
                    "2.aup3".into(),
                    "application/octet-stream".into(),
                    crate::MAX_CHAT_FILE_BYTES + 1,
                )
                .unwrap_err(),
            "TRANSFER_FILE_TOO_LARGE"
        );

        let names = ["one.png", "two.aup3", "three.zip", "four.txt", "five.bin"];
        for (index, name) in names.into_iter().enumerate() {
            bridge
                .enqueue_outgoing(
                    "profile-one",
                    1,
                    format!("message-{index}"),
                    name.into(),
                    "application/octet-stream".into(),
                    1024,
                )
                .unwrap();
        }
        assert_eq!(
            bridge
                .enqueue_outgoing(
                    "profile-one",
                    1,
                    "message-six".into(),
                    "six.jpg".into(),
                    "image/jpeg".into(),
                    1024,
                )
                .unwrap_err(),
            "TRANSFER_QUEUE_LIMIT"
        );
    }

    #[test]
    fn web_file_bridge_cancels_first_middle_and_last_without_blocking_order() {
        let bridge = WebFileBridge::default();
        let mut ids = Vec::new();
        for index in 0..5 {
            ids.push(
                bridge
                    .enqueue_outgoing(
                        "profile-one",
                        1,
                        format!("message-{index}"),
                        format!("file-{index}.bin"),
                        "application/octet-stream".into(),
                        1024,
                    )
                    .unwrap(),
            );
        }

        let first = bridge.next_to_start().unwrap();
        assert_eq!(first.id, ids[0]);
        bridge.outgoing_started(&first.id, 41).unwrap();
        assert!(bridge.on_outgoing_request(&first.id, 0, 1024));
        bridge
            .stage_outgoing_upload(&first.id, 0, &vec![7_u8; 1024])
            .unwrap();
        assert_eq!(bridge.view(&ids[0], 999).unwrap().buffered_bytes, 1024);
        let remote = bridge.on_native_control("profile-one", 1, 41, 2).unwrap();
        assert_eq!(remote.message_id, "message-0");
        assert!(remote.outgoing);
        assert_eq!(remote.state, "cancelled");
        let cancelled = bridge.view(&ids[0], 1_000).unwrap();
        assert_eq!(cancelled.state, "cancelled");
        assert_eq!(cancelled.buffered_bytes, 0);
        assert!(
            bridge.has_active(),
            "remote cancellation keeps the slot until domain reconciliation"
        );

        bridge.control("message-2", "cancel").unwrap();
        bridge.control("message-4", "cancel").unwrap();
        assert!(bridge.acknowledge_terminal(&ids[0]));
        assert_eq!(bridge.next_to_start().unwrap().id, ids[1]);
        bridge.outgoing_started(&ids[1], 42).unwrap();
        assert!(bridge.on_outgoing_request(&ids[1], 0, 0));
        assert!(bridge.acknowledge_complete(&ids[1]));
        assert_eq!(bridge.next_to_start().unwrap().id, ids[3]);
        assert_eq!(bridge.view(&ids[2], 1_001).unwrap().state, "cancelled");
        assert_eq!(bridge.view(&ids[4], 1_001).unwrap().state, "cancelled");
    }

    #[test]
    fn web_file_bridge_remote_cancel_clears_receiver_buffer_and_slot() {
        let bridge = WebFileBridge::default();
        let incoming = bridge
            .offer_incoming(
                "profile-one",
                1,
                7,
                "incoming-message".into(),
                "recording.aup3".into(),
                "application/octet-stream".into(),
                8,
            )
            .unwrap();
        bridge.control("incoming-message", "resume").unwrap();
        assert_eq!(bridge.next_to_start().unwrap().id, incoming);
        bridge.push_incoming_chunk(&incoming, 0, b"data").unwrap();
        assert_eq!(bridge.view(&incoming, 1_000).unwrap().buffered_bytes, 4);
        let update = bridge.on_native_control("profile-one", 1, 7, 2).unwrap();
        assert!(!update.outgoing);
        assert_eq!(update.state, "cancelled");
        let view = bridge.view(&incoming, 1_001).unwrap();
        assert_eq!(view.state, "cancelled");
        assert_eq!(view.buffered_bytes, 0);
        assert!(
            bridge.has_active(),
            "remote cancellation is still awaiting domain reconciliation"
        );
        assert!(bridge.acknowledge_terminal(&incoming));
        assert!(!bridge.has_active());
    }

    #[test]
    fn web_file_bridge_remote_pause_and_resume_preserve_the_same_slot() {
        let bridge = WebFileBridge::default();
        let outgoing = bridge
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-one".into(),
                "recording.aup3".into(),
                "application/octet-stream".into(),
                1024,
            )
            .unwrap();
        let queued = bridge
            .enqueue_outgoing(
                "profile-one",
                1,
                "message-two".into(),
                "photo.png".into(),
                "image/png".into(),
                1024,
            )
            .unwrap();
        bridge.next_to_start().unwrap();
        bridge.outgoing_started(&outgoing, 19).unwrap();
        assert!(bridge.on_outgoing_request(&outgoing, 0, 1024));
        bridge
            .stage_outgoing_upload(&outgoing, 0, &vec![4_u8; 1024])
            .unwrap();

        let paused = bridge.on_native_control("profile-one", 1, 19, 1).unwrap();
        assert_eq!(paused.state, "paused");
        assert_eq!(bridge.view(&outgoing, 999).unwrap().buffered_bytes, 1024);
        assert!(bridge.has_active());
        assert!(
            bridge.next_to_start().is_none(),
            "queued files cannot overtake a remotely paused transfer"
        );

        let resumed = bridge.on_native_control("profile-one", 1, 19, 0).unwrap();
        assert_eq!(resumed.state, "sending");
        assert_eq!(bridge.view(&outgoing, 1_000).unwrap().buffered_bytes, 1024);
        assert!(bridge.has_active());
        assert_eq!(bridge.view(&queued, 1_000).unwrap().state, "queued");
    }

    #[test]
    fn web_file_bridge_routes_reused_native_number_only_to_active_incoming_transfer() {
        let bridge = WebFileBridge::default();
        let completed = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-old".into(),
                "old.png".into(),
                "image/png".into(),
                4,
            )
            .unwrap();
        bridge.control("message-old", "resume").unwrap();
        bridge.next_to_start().unwrap();
        assert!(bridge
            .push_incoming_chunk(&completed, 0, &[0, 1, 2, 3])
            .unwrap());
        assert!(!bridge.incoming_remote_complete(&completed));
        bridge.take_incoming_chunk(&completed).unwrap().unwrap();
        bridge.acknowledge_incoming_chunk(&completed, 4).unwrap();
        bridge.confirm_incoming_complete(&completed).unwrap();
        assert_eq!(bridge.view(&completed, 1_000).unwrap().state, "complete");
        assert!(bridge.acknowledge_complete(&completed));

        // toxcore may reuse a completed transfer's native file number. The
        // callback must resolve the new active record rather than whichever
        // historical HashMap entry happens to be visited first.
        let active = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-new".into(),
                "new.bin".into(),
                "application/octet-stream".into(),
                4,
            )
            .unwrap();
        bridge.control("message-new", "resume").unwrap();
        bridge.next_to_start().unwrap();

        assert_eq!(
            bridge.incoming_by_native("profile-one", 1, 5),
            Some(active.clone())
        );
        assert!(bridge
            .push_incoming_chunk(&active, 0, &[4, 5, 6, 7])
            .unwrap());
        assert_eq!(bridge.view(&completed, 1_001).unwrap().state, "complete");
        assert_eq!(bridge.view(&active, 1_001).unwrap().transferred_bytes, 4);
    }

    #[test]
    fn web_file_bridge_rejects_incoming_gaps_and_releases_after_reconciliation() {
        let bridge = WebFileBridge::default();
        let transfer = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-in".into(),
                "file.bin".into(),
                "application/octet-stream".into(),
                8,
            )
            .unwrap();
        bridge.control("message-in", "resume").unwrap();
        bridge.next_to_start().unwrap();

        assert_eq!(
            bridge
                .push_incoming_chunk(&transfer, 4, &[4, 5, 6, 7])
                .unwrap_err(),
            "TRANSFER_CHUNK_GAP"
        );
        let failed = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.transferred_bytes, 0);
        assert_eq!(failed.buffered_bytes, 0);
        let queued = bridge
            .enqueue_outgoing(
                "profile-two",
                2,
                "message-next".into(),
                "next.bin".into(),
                "application/octet-stream".into(),
                1,
            )
            .unwrap();
        assert!(bridge.next_to_start().is_none());
        assert!(bridge.acknowledge_terminal(&transfer));
        assert_eq!(bridge.next_to_start().unwrap().id, queued);
    }

    #[test]
    fn web_file_bridge_never_completes_an_incoming_transfer_before_exact_size() {
        let bridge = WebFileBridge::default();
        let transfer = bridge
            .offer_incoming(
                "profile-one",
                1,
                5,
                "message-in".into(),
                "file.bin".into(),
                "application/octet-stream".into(),
                8,
            )
            .unwrap();
        bridge.control("message-in", "resume").unwrap();
        bridge.next_to_start().unwrap();
        bridge
            .push_incoming_chunk(&transfer, 0, &[0, 1, 2, 3])
            .unwrap();

        assert!(!bridge.incoming_remote_complete(&transfer));
        let failed = bridge.view(&transfer, 1_000).unwrap();
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.transferred_bytes, 4);
        assert_eq!(failed.buffered_bytes, 0);
        assert!(bridge.take_incoming_chunk(&transfer).unwrap().is_none());
        assert!(bridge.has_active());
        assert!(bridge.acknowledge_terminal(&transfer));
        assert!(!bridge.has_active());
    }

    #[test]
    fn profile_limit_allows_storage_beyond_three_but_not_four_active() {
        let mut catalog = ProfileCatalog::default();
        for index in 0..4 {
            catalog
                .add(format!("p{index}"), format!("Profile {index}"), false)
                .unwrap();
        }
        for index in 0..3 {
            catalog.activate(&format!("p{index}")).unwrap();
        }
        assert_eq!(catalog.stored_count(), 4);
        assert_eq!(catalog.activate("p3").unwrap_err(), "ACTIVE_PROFILE_LIMIT");
        assert_eq!(
            catalog.effective_presence("p0", false).unwrap(),
            Presence::Away
        );
        catalog.set_presence("p0", Presence::Busy).unwrap();
        assert_eq!(
            catalog.effective_presence("p0", false).unwrap(),
            Presence::Busy
        );
        catalog.set_presence("p1", Presence::Away).unwrap();
        assert_eq!(
            catalog.effective_presence("p1", true).unwrap(),
            Presence::Away
        );
        assert_eq!(
            catalog.effective_presence("p0", true).unwrap(),
            Presence::Busy
        );
        assert_eq!(
            catalog
                .set_presence("missing", Presence::Offline)
                .unwrap_err(),
            "PROFILE_NOT_FOUND"
        );
        assert_eq!(catalog.selected_profile_id(), Some("p0"));
    }

    #[test]
    fn profile_selection_follows_active_profiles_without_overriding_a_valid_selection() {
        let mut catalog = ProfileCatalog::default();
        catalog
            .add("first".to_string(), "First".to_string(), false)
            .unwrap();
        catalog
            .add("second".to_string(), "Second".to_string(), false)
            .unwrap();

        catalog.activate("first").unwrap();
        catalog.activate("second").unwrap();
        assert_eq!(catalog.selected_profile_id(), Some("first"));

        catalog.deactivate("first").unwrap();
        assert_eq!(catalog.selected_profile_id(), Some("second"));

        catalog.deactivate("second").unwrap();
        assert_eq!(catalog.selected_profile_id(), None);
    }

    #[test]
    fn sole_disabled_profile_can_be_reconnected_or_replaced_by_a_selected_new_profile() {
        let mut catalog = ProfileCatalog::default();
        catalog
            .add("disabled".to_string(), "Disabled".to_string(), false)
            .unwrap();
        catalog.activate("disabled").unwrap();
        catalog.deactivate("disabled").unwrap();
        assert_eq!(catalog.selected_profile_id(), None);

        catalog.activate("disabled").unwrap();
        assert_eq!(catalog.selected_profile_id(), Some("disabled"));
        catalog.deactivate("disabled").unwrap();

        catalog
            .add("new".to_string(), "New".to_string(), false)
            .unwrap();
        catalog.activate("new").unwrap();
        assert_eq!(catalog.selected_profile_id(), Some("new"));
    }

    #[test]
    fn lease_transfer_requires_password_except_same_stale_device() {
        let first = [1_u8; 32];
        let second = [2_u8; 32];
        let mut lease = UiLease::default();
        assert_eq!(lease.acquire(first, 0, false), LeaseDecision::Acquired);
        assert_eq!(lease.acquire(second, 10, false), LeaseDecision::Occupied);
        assert_eq!(
            lease.acquire(first, UI_LEASE_STALE_SECONDS, false),
            LeaseDecision::StaleTakenOver
        );
        assert_eq!(
            lease.acquire(second, UI_LEASE_STALE_SECONDS + 1, true),
            LeaseDecision::TransferredAfterPassword
        );
        assert_eq!(
            lease
                .heartbeat(&first, UI_LEASE_STALE_SECONDS + 2)
                .unwrap_err(),
            "UI_LEASE_TRANSFERRED"
        );
    }

    #[test]
    fn auth_delay_grows_without_hard_lockout() {
        let mut backoff = AuthBackoff::default();
        let source = [3_u8; 32];
        assert_eq!(backoff.record_failure(source, 0).delay_seconds, 2);
        assert_eq!(backoff.record_failure(source, 2).delay_seconds, 4);
        let third = backoff.record_failure(source, 6);
        assert_eq!(third.delay_seconds, 8);
        assert!(third.captcha_required);
        for index in 0..8 {
            assert!(backoff.record_failure(source, 20 + index).delay_seconds <= 60);
        }
        backoff.record_success(&source);
        assert!(!backoff.policy(&source, 100).captcha_required);
    }

    #[test]
    fn finite_lease_allows_progress_bounded_extension_then_grace() {
        let mut lease = DataLease::provisional(1, 0);
        lease.activate_after_first_profile(100);
        let expiry = 100 + 60 * 60;
        lease.record_transfer_progress(expiry);
        assert_eq!(
            lease.status(expiry, true).phase,
            LeasePhase::TransferExtension
        );
        assert_eq!(
            lease
                .status(expiry + EXPIRY_TRANSFER_CAP_SECONDS, true)
                .phase,
            LeasePhase::RenewalGrace
        );
        assert!(
            lease
                .status(
                    expiry + EXPIRY_TRANSFER_CAP_SECONDS + EXPIRY_GRACE_SECONDS,
                    false
                )
                .erase_now
        );
    }

    #[test]
    fn web_friends_snapshot_waits_for_native_iteration() {
        native_delivery_commit_regressions::friends_snapshot_waits_for_native_iteration();
    }

    #[test]
    fn web_file_bridge_incoming_storage_resume_releases_profile() {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            native_delivery_commit_regressions::incoming_storage_resume_releases_profile();
            tx.send(()).unwrap();
        });
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(()) => worker.join().unwrap(),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                panic!("incoming transfer control did not finish")
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                worker.join().expect("incoming transfer fixture panicked");
                panic!("incoming transfer fixture returned without completion");
            }
        }
    }

    mod native_delivery_commit_regressions {
        use super::*;

        const PROFILE: &str = "delivery_profile";
        const BYTES: &[u8] = &[1, 2, 3, 4];

        struct OwnedRoot(PathBuf);
        impl OwnedRoot {
            fn new(label: &str) -> Self {
                let root = std::env::temp_dir().join(format!(
                    "kaigen-delivery-{label}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                fs::create_dir_all(&root).unwrap();
                Self(root)
            }
        }
        impl Drop for OwnedRoot {
            fn drop(&mut self) {
                let _ = crate::flush_deferred_profile_writes();
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        fn new_domain() -> WorkspaceDomain {
            let mut domain = WorkspaceDomain::provisional(
                [0x42; 32],
                WorkspaceConfig {
                    storage_mode: StorageMode::Disk,
                    quota_bytes: 64 * 1024 * 1024,
                    security_reserve_bytes: 8 * 1024 * 1024,
                    lease_hours: 1,
                },
                1,
            )
            .unwrap();
            domain.data_lease.activate_after_first_profile(1);
            domain
        }

        fn runtime(root: &Path, store: Arc<DeferredTransferStore>) -> WebWorkspaceRuntime {
            let mut runtime =
                WebWorkspaceRuntime::start(root.to_path_buf(), root.to_path_buf()).unwrap();
            runtime.install_transfer_store(store).unwrap();
            *runtime.network_settings.lock().unwrap() = NetworkSettings {
                udp_enabled: false,
                ipv6_enabled: false,
                local_discovery_enabled: false,
            };
            runtime
        }

        // Same constructors/paths as create_profile/load_profile, without starting
        // the network loop. No new production seam and no remote transport fixture.
        fn mount_profile(
            runtime: &mut WebWorkspaceRuntime,
            volume: Arc<KaiProfileVolume>,
            fresh: bool,
            history_enabled: bool,
        ) -> Arc<ToxState> {
            let paths = runtime.profile_paths_for_volume(volume).unwrap();
            let (savedata, cipher) = if fresh {
                (None, None)
            } else {
                let (savedata, cipher) = profiles::read_profile(&paths.profile_path, None).unwrap();
                (Some(savedata), cipher)
            };
            let mut profile = ToxState::new_for_profile(
                paths,
                runtime.tor.clone(),
                Arc::clone(&runtime.proxy_settings),
                Arc::clone(&runtime.network_settings),
                None,
                savedata,
                cipher,
                fresh.then_some("Disposable delivery fixture"),
            )
            .unwrap();
            profile.transfer_log_path = PathBuf::new();
            profile.network_log_path = PathBuf::new();
            profile.web_profile_id = Some(PROFILE.into());
            profile.web_file_bridge = Some(Arc::clone(&runtime.file_bridge));
            profile
                .history_enabled
                .store(history_enabled, Ordering::Release);
            profile.network_enabled.store(false, Ordering::Release);
            let profile = Arc::new(profile);
            runtime
                .profiles
                .insert(PROFILE.into(), Arc::clone(&profile));
            profile
        }

        // The ordinary native callback receives these exact shared state objects.
        // Keep this one constructor for all cases, matching lib's callback setup.
        fn callback_context(profile: &ToxState) -> crate::CallbackContext {
            crate::CallbackContext {
                updates: None,
                incoming_requests: Arc::clone(&profile.incoming_requests),
                incoming_requests_path: profile.incoming_requests_path.clone(),
                messages: Arc::clone(&profile.messages),
                history_residency: Arc::clone(&profile.history_residency),
                delivery_receipts: Arc::clone(&profile.delivery_receipts),
                receipt_progress: Arc::clone(&profile.receipt_progress),
                history_path: profile.history_path.clone(),
                history_enabled: Arc::clone(&profile.history_enabled),
                pending_files: Arc::clone(&profile.pending_files),
                pending_files_path: profile.pending_files_path.clone(),
                incoming_files: Arc::clone(&profile.incoming_files),
                outgoing_files: Arc::clone(&profile.outgoing_files),
                downloads_dir: profile.downloads_dir.clone(),
                avatars_dir: profile.avatars_dir.clone(),
                transfer_log_path: PathBuf::new(),
                network_log_path: PathBuf::new(),
                friend_cache: Arc::clone(&profile.friend_cache),
                friend_cache_path: profile.friend_cache_path.clone(),
                pq: Arc::clone(&profile.pq),
                chat_protocol: Arc::clone(&profile.chat_protocol),
                file_card_protocol: Arc::clone(&profile.file_card_protocol),
                pq_receipts: Arc::clone(&profile.pq_receipts),
                file_receive_settings: Arc::clone(&profile.file_receive_settings),
                unread_state: Arc::clone(&profile.unread_state),
                unread_state_path: profile.unread_state_path.clone(),
                friend_message_ready_at: Arc::clone(&profile.friend_message_ready_at),
                network_enabled: Arc::clone(&profile.network_enabled),
                chat_transaction_gate: Arc::clone(&profile.chat_transaction_gate),
                chat_transport_ready: Arc::clone(&profile.chat_transport_ready),
                web_profile_id: profile.web_profile_id.clone(),
                web_file_bridge: profile.web_file_bridge.clone(),
            }
        }

        fn eof(profile: &ToxState, friend: u32) {
            let mut context = callback_context(profile);
            let guard = profile.handle.lock().unwrap();
            unsafe {
                crate::on_file_chunk_request(
                    guard.as_ref().unwrap().instance.as_ptr(),
                    friend,
                    7,
                    BYTES.len() as u64,
                    0,
                    (&mut context as *mut crate::CallbackContext).cast(),
                );
            }
        }

        fn assert_pending(runtime: &WebWorkspaceRuntime, profile: &ToxState, id: &str) {
            let view = runtime.file_bridge.view(id, 1_000).unwrap();
            assert!(!matches!(
                view.state.as_str(),
                "complete" | "failed" | "cancelled"
            ));
            assert!(!runtime.file_bridge.terminal_reconciled(id));
            let rows = profile.messages.lock().unwrap();
            let row = rows.iter().find(|row| row.id == view.message_id).unwrap();
            assert!(!row.attachment.as_ref().unwrap().completed);
            assert_ne!(row.delivery, "delivered");
        }

        struct WebControlReplyGuard;

        impl WebControlReplyGuard {
            fn install(friend: u32, error: i32) -> Self {
                WEB_USER_FILE_CONTROL_REPLY.with(|reply| {
                    let mut reply = reply.borrow_mut();
                    assert!(reply.is_none(), "nested Web control reply");
                    *reply = Some((friend, 7, 1, error));
                });
                Self
            }

            fn assert_consumed(&self) {
                WEB_USER_FILE_CONTROL_REPLY.with(|reply| {
                    assert!(
                        reply.borrow().is_none(),
                        "actual native-control boundary was not reached"
                    );
                });
            }
        }

        impl Drop for WebControlReplyGuard {
            fn drop(&mut self) {
                WEB_USER_FILE_CONTROL_REPLY.with(|reply| {
                    *reply.borrow_mut() = None;
                });
            }
        }

        fn exercise_pause_before_peer_acceptance(
            live: &mut WebWorkspaceRuntime,
            domain: &mut WorkspaceDomain,
            profile: &ToxState,
            view: &WebTransferView,
            status: &StoreObjectStatus,
            friend: u32,
            native_error: i32,
        ) {
            let before = live.file_bridge.view(&view.id, 1_000).unwrap();
            assert_eq!(before.state, "sending");
            assert_eq!(before.transferred_bytes, 0);
            let reply = WebControlReplyGuard::install(friend, native_error);
            let result =
                live.control_web_transfer(domain, PROFILE, &view.message_id, "pause", 1_000);
            reply.assert_consumed();
            drop(reply); // The peer callback below cannot consume a command test reply.
            assert!(
                profile.handle.try_lock().is_ok(),
                "control retained the native handle"
            );

            if native_error != TOX_FILE_CONTROL_ALREADY_PAUSED {
                assert_eq!(result.unwrap_err(), "TRANSFER_CONTROL_REJECTED");
                return;
            }
            let paused =
                result.expect("ALREADY_PAUSED before peer acceptance must retain local pause");
            assert_eq!(paused.state, "paused");
            assert_eq!(paused.transferred_bytes, 0);
            let assert_paused_zero = || {
                let paused = live.file_bridge.view(&view.id, 1_000).unwrap();
                assert_eq!(paused.profile_id, PROFILE);
                assert_eq!(paused.message_id, view.message_id);
                assert_eq!(paused.state, "paused");
                assert_eq!(paused.transferred_bytes, 0);
                let rows = profile.messages.lock().unwrap();
                let row = rows.iter().find(|row| row.id == view.message_id).unwrap();
                assert_eq!(row.friend_number, friend);
                let attachment = row.attachment.as_ref().unwrap();
                assert_eq!(attachment.transfer_state, "paused");
                assert_eq!(attachment.transferred, 0);
                assert!(!attachment.completed);
            };
            assert_paused_zero();

            // Observe the ordinary asynchronous history writer, without manually
            // persisting, flushing, checkpointing or stopping the mounted profile.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let rows = crate::chat_history_store::latest_registered(
                    &profile.history_path,
                    friend,
                    &status.spec.friend_public_key,
                    10,
                )
                .unwrap();
                if rows.iter().any(|row| {
                    row.id == view.message_id
                        && row.friend_number == friend
                        && row.attachment.as_ref().is_some_and(|attachment| {
                            attachment.transfer_state == "paused"
                                && attachment.transferred == 0
                                && !attachment.completed
                        })
                }) {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "ordinary history worker did not publish pause"
                );
                thread::sleep(Duration::from_millis(5));
            }

            // Actual native peer-RESUME callback, sharing the real profile/bridge/card.
            // This checks the local state latch, not successful live transport delivery.
            let mut context = callback_context(profile);
            {
                let handle = profile.handle.lock().unwrap();
                unsafe {
                    crate::on_file_recv_control(
                        handle.as_ref().unwrap().instance.as_ptr(),
                        friend,
                        7,
                        0,
                        (&mut context as *mut crate::CallbackContext).cast(),
                    );
                }
            }
            assert_paused_zero();
            assert!(
                !profile
                    .outgoing_files
                    .lock()
                    .unwrap()
                    .get(&(friend, 7))
                    .unwrap()
                    .active
            );
            assert!(live.file_bridge.next_to_start().is_none());
        }

        fn native_peer_public_key(root: &Path) -> [u8; 32] {
            let peer = crate::create_tox_handle(
                root.join("unused-peer.tox"),
                None,
                None,
                &NetworkSettings {
                    udp_enabled: false,
                    ipv6_enabled: false,
                    local_discovery_enabled: false,
                },
                None,
            )
            .unwrap();
            let mut address = [0_u8; 38];
            unsafe {
                crate::tox_self_get_address(peer.instance.as_ptr(), address.as_mut_ptr());
                crate::tox_kill(peer.instance.as_ptr());
            }
            let mut public_key = [0_u8; 32];
            public_key.copy_from_slice(&address[..32]);
            assert!(public_key[31] < 128);
            public_key
        }

        pub(super) fn friends_snapshot_waits_for_native_iteration() {
            let root = OwnedRoot::new("friends-snapshot");
            let store = Arc::new(DeferredTransferStore::default());
            let mut live = runtime(&root.0.join("live"), store);
            let volume =
                KaiProfileVolume::create(live.profile_container_path(PROFILE).unwrap(), None)
                    .unwrap();
            let profile = mount_profile(&mut live, volume, true, true);
            let peer_public_key = native_peer_public_key(&root.0);
            let guard = profile.handle.lock().unwrap();
            let mut error = 0;
            let friend = unsafe {
                crate::tox_friend_add_norequest(
                    guard.as_ref().unwrap().instance.as_ptr(),
                    peer_public_key.as_ptr(),
                    &mut error,
                )
            };
            assert_eq!(error, 0);

            // Preparation must not acquire the native handle: the request is
            // captured under the global registry while iteration owns it.
            let request = live.prepare_friends(PROFILE).unwrap();
            assert!(live.friends_request_is_current(&request));
            assert!(matches!(
                live.prepare_friends("absent"),
                Err(code) if code == "ACTIVE_PROFILE_LOCKED"
            ));
            let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
            let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
            let worker = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                let result = request.execute();
                assert!(result_tx.send((request, result)).is_ok());
            });
            started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            let blocked = result_rx.recv_timeout(Duration::from_millis(50));
            // Always release/join, including the old immediate TOX_BUSY path.
            drop(guard);
            let (request, result) = match blocked {
                Ok(completed) => completed,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    result_rx.recv_timeout(Duration::from_secs(2)).unwrap()
                }
                Err(error) => panic!("friends worker disconnected: {error}"),
            };
            worker.join().unwrap();
            let snapshot = match result {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    live.stop().unwrap();
                    panic!("contact refresh must wait for native iteration: {error}");
                }
            };
            let rows = snapshot.as_array().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["number"], friend);
            assert_eq!(rows[0]["public_key"], crate::hex_upper(&peer_public_key));
            assert_eq!(rows[0]["connection"], "offline");
            assert!(live.friends_request_is_current(&request));

            // Removing or replacing the same profile ID invalidates an in-flight
            // snapshot even though its Arc keeps the original profile alive.
            live.profiles.remove(PROFILE).unwrap();
            assert!(!live.friends_request_is_current(&request));
            let replacement_root = root.0.join("replacement");
            let mut replacement = runtime(
                &replacement_root,
                Arc::new(DeferredTransferStore::default()),
            );
            let volume = KaiProfileVolume::create(
                replacement.profile_container_path(PROFILE).unwrap(),
                None,
            )
            .unwrap();
            let replacement_profile = mount_profile(&mut replacement, volume, true, true);
            live.profiles.insert(PROFILE.into(), replacement_profile);
            assert!(!live.friends_request_is_current(&request));
            live.profiles.remove(PROFILE);
            live.profiles.insert(PROFILE.into(), profile);
            live.stop().unwrap();
            replacement.stop().unwrap();
        }

        pub(super) fn incoming_storage_resume_releases_profile() {
            let root = OwnedRoot::new("incoming-storage-resume");
            eprintln!("KAIGEN_OWNED_REGRESSION_ROOT={}", root.0.display());
            let store = Arc::new(DeferredTransferStore::default());
            store.ready.store(true, Ordering::Release);
            let mut live = runtime(&root.0.join("live"), Arc::clone(&store));
            let volume =
                KaiProfileVolume::create(live.profile_container_path(PROFILE).unwrap(), None)
                    .unwrap();
            let profile = mount_profile(&mut live, volume, true, true);
            let peer_public_key = native_peer_public_key(&root.0);
            let expected_key = crate::hex_upper(&peer_public_key);
            let friend = {
                let guard = profile.handle.lock().unwrap();
                let handle = guard.as_ref().unwrap();
                let mut error = 0;
                let friend = unsafe {
                    crate::tox_friend_add_norequest(
                        handle.instance.as_ptr(),
                        peer_public_key.as_ptr(),
                        &mut error,
                    )
                };
                assert_eq!(error, 0);
                friend
            };
            // Produce the real incoming card and initially unbound bridge route through
            // the same native callback used when an offline sender reconnects.
            let mut context = callback_context(&profile);
            let name = b"incoming.png";
            {
                let guard = profile.handle.lock().unwrap();
                unsafe {
                    crate::on_file_recv(
                        guard.as_ref().unwrap().instance.as_ptr(),
                        friend,
                        7,
                        0,
                        BYTES.len() as u64,
                        name.as_ptr(),
                        name.len(),
                        (&mut context as *mut crate::CallbackContext).cast(),
                    );
                }
            }
            let message_id = {
                let rows = profile.messages.lock().unwrap();
                let row = rows
                    .iter()
                    .find(|row| row.friend_number == friend && !row.mine)
                    .unwrap();
                assert_eq!(row.friend_public_key, expected_key);
                assert!(row.attachment.as_ref().unwrap().image);
                row.id.clone()
            };
            let transfer_id = live
                .file_bridge
                .id_for_profile_message(PROFILE, &message_id)
                .unwrap();
            assert!(live.file_bridge.storage_spec(&transfer_id).is_none());
            assert_eq!(
                live.file_bridge.view(&transfer_id, 1_000).unwrap().state,
                "offered"
            );

            let mut domain = new_domain();
            eprintln!("KAIGEN_INCOMING_RESUME_ENTERED");
            live.control_web_transfer(&mut domain, PROFILE, &message_id, "resume", 1_000)
                .unwrap();
            let spec = live.file_bridge.storage_spec(&transfer_id).unwrap();
            assert_eq!(spec.friend_public_key, expected_key);
            assert_eq!(spec.profile_id, PROFILE);
            assert_eq!(spec.message_id, message_id);
            assert_eq!(spec.direction, StoreDirection::Incoming);
            assert!(
                profile.handle.try_lock().is_ok(),
                "incoming resume retained the profile lock"
            );
            // The actual history command takes the same handle again. Its completion
            // is inside the same parent timeout, covering the observed follow-up hang.
            let history = live
                .dispatch(
                    PROFILE,
                    "get_tox_messages",
                    &serde_json::json!({ "friendNumber": friend, "limit": 10 }),
                )
                .unwrap();
            assert!(history.is_array());
            live.stop().unwrap();
        }

        #[test]
        fn web_incoming_file_progress_invalidates_only_changed_snapshots() {
            for history_enabled in [true, false] {
                let root = OwnedRoot::new("incoming-file-progress");
                let store = Arc::new(DeferredTransferStore::default());
                store.ready.store(true, Ordering::Release);
                let mut live = runtime(&root.0.join("live"), Arc::clone(&store));
                let volume =
                    KaiProfileVolume::create(live.profile_container_path(PROFILE).unwrap(), None)
                        .unwrap();
                let profile = mount_profile(&mut live, volume, true, history_enabled);
                let peer_public_key = native_peer_public_key(&root.0);
                let friend = {
                    let handle = profile.handle.lock().unwrap();
                    let mut error = 0;
                    let friend = unsafe {
                        crate::tox_friend_add_norequest(
                            handle.as_ref().unwrap().instance.as_ptr(),
                            peer_public_key.as_ptr(),
                            &mut error,
                        )
                    };
                    assert_eq!(error, 0);
                    friend
                };
                let chunk = vec![0x6B; FRAME_STREAM_CHUNK_BYTES];
                let size = (chunk.len() * 2) as u64;
                let name = b"incoming.bin";
                let mut context = callback_context(&profile);
                {
                    let handle = profile.handle.lock().unwrap();
                    unsafe {
                        crate::on_file_recv(
                            handle.as_ref().unwrap().instance.as_ptr(),
                            friend,
                            7,
                            0,
                            size,
                            name.as_ptr(),
                            name.len(),
                            (&mut context as *mut crate::CallbackContext).cast(),
                        );
                    }
                }
                let message_id = profile.messages.lock().unwrap()[0].id.clone();
                let transfer_id = live
                    .file_bridge
                    .id_for_profile_message(PROFILE, &message_id)
                    .unwrap();
                let mut domain = new_domain();
                live.control_web_transfer(&mut domain, PROFILE, &message_id, "resume", 1_000)
                    .unwrap();
                let mut stored = StoreObjectStatus {
                    spec: live.file_bridge.storage_spec(&transfer_id).unwrap(),
                    durable_bytes: 0,
                    phase: StorePhase::Staging,
                    committed_sha256: None,
                    native_delivery_confirmed: None,
                };
                *store.published.lock().unwrap() = vec![stored.clone()];
                live.file_bridge.drive_storage().unwrap();
                let route = live.file_bridge.next_to_start().unwrap();
                // Only transport acceptance and durable store publications are
                // controlled here; the callbacks, tick and snapshot are real.
                assert!(resume_web_transfer_with_native_control(
                    &profile.handle,
                    &profile.file_receive_settings,
                    &live.file_bridge,
                    &profile.messages,
                    &route,
                    |_| 0,
                    || {},
                )
                .unwrap());
                crate::persist_tox_history_now(
                    &profile.messages,
                    &profile.history_path,
                    &profile.history_enabled,
                );
                let snapshot = |runtime: &WebWorkspaceRuntime, known_revision: Option<u64>| {
                    runtime
                        .dispatch(
                            PROFILE,
                            "get_tox_messages_snapshot",
                            &serde_json::json!({
                                "friendNumber": friend, "limit": 10,
                                "knownRevision": known_revision,
                            }),
                        )
                        .unwrap()
                };
                let initial = snapshot(&live, None);
                let initial_revision = initial["revision"].as_u64().unwrap();
                assert_eq!(initial["messages"][0]["id"], message_id);
                assert_eq!(initial["messages"][0]["attachment"]["image"], false);
                assert_eq!(initial["messages"][0]["attachment"]["transferred"], 0);

                let receive = |position: u64, bytes: &[u8]| {
                    let mut context = callback_context(&profile);
                    let handle = profile.handle.lock().unwrap();
                    unsafe {
                        crate::on_file_recv_chunk(
                            handle.as_ref().unwrap().instance.as_ptr(),
                            friend,
                            7,
                            position,
                            bytes.as_ptr(),
                            bytes.len(),
                            (&mut context as *mut crate::CallbackContext).cast(),
                        );
                    }
                };
                receive(0, &chunk);
                stored.durable_bytes = chunk.len() as u64;
                *store.published.lock().unwrap() = vec![stored.clone()];
                live.reconcile_web_transfer_terminal(&mut domain, 1, 1_100)
                    .unwrap();
                let halfway = snapshot(&live, Some(initial_revision));
                let halfway_revision = halfway["revision"].as_u64().unwrap();
                let row = &halfway["messages"][0];
                assert_eq!(row["id"], message_id, "progress must return the same card");
                assert_eq!(row["attachment"]["transferred"], size / 2);
                assert_eq!(row["attachment"]["transfer_state"], "receiving");
                assert_eq!(row["attachment"]["completed"], false);
                assert!(halfway_revision > initial_revision);
                live.reconcile_web_transfer_terminal(&mut domain, 1, 1_101)
                    .unwrap();
                let unchanged = snapshot(&live, Some(halfway_revision));
                assert_eq!(unchanged["revision"], halfway_revision);
                assert!(unchanged["messages"].is_null());

                receive(chunk.len() as u64, &chunk);
                receive(size, &[]);
                stored.durable_bytes = size;
                stored.phase = StorePhase::Committed;
                stored.committed_sha256 =
                    Some(Sha256::digest([&chunk[..], &chunk[..]].concat()).into());
                *store.published.lock().unwrap() = vec![stored];
                live.reconcile_web_transfer_terminal(&mut domain, 1, 1_200)
                    .unwrap();
                // A client carrying either older revision must see terminal
                // bytes, even while the disk history window is still older.
                for revision in [initial_revision, halfway_revision] {
                    let complete = snapshot(&live, Some(revision));
                    let row = &complete["messages"][0];
                    assert_eq!(row["id"], message_id);
                    assert_eq!(row["attachment"]["transferred"], size);
                    assert_eq!(row["attachment"]["transfer_state"], "complete");
                    assert_eq!(row["attachment"]["completed"], true);
                }
                live.stop().unwrap();
            }
        }

        fn exercise_case(history_enabled: bool, acknowledge: bool, pause_case: Option<i32>) {
            let root = OwnedRoot::new(if history_enabled {
                "history"
            } else {
                "history-off"
            });
            let store = Arc::new(DeferredTransferStore::default());
            store.ready.store(true, Ordering::Release);
            let mut live = runtime(&root.0.join("live"), Arc::clone(&store));
            let volume =
                KaiProfileVolume::create(live.profile_container_path(PROFILE).unwrap(), None)
                    .unwrap();
            let profile = mount_profile(&mut live, Arc::clone(&volume), true, history_enabled);
            let peer_public_key = native_peer_public_key(&root.0);
            let friend = {
                let guard = profile.handle.lock().unwrap();
                let handle = guard.as_ref().unwrap();
                let mut error = 0;
                let friend = unsafe {
                    crate::tox_friend_add_norequest(
                        handle.instance.as_ptr(),
                        peer_public_key.as_ptr(),
                        &mut error,
                    )
                };
                assert_eq!(error, 0);
                ToxState::save(handle).unwrap();
                friend
            };
            let mut domain = new_domain();
            let view = live
                .begin_web_outgoing_transfer(
                    &mut domain,
                    PROFILE,
                    friend,
                    "test.bin",
                    "application/octet-stream",
                    BYTES.len() as u64,
                    "operation00000000000000000000000",
                    sha256(&[BYTES]),
                    1,
                    1_000,
                )
                .unwrap();
            let mut status = StoreObjectStatus {
                spec: live.file_bridge.storage_spec(&view.id).unwrap(),
                durable_bytes: BYTES.len() as u64,
                phase: StorePhase::Committed,
                committed_sha256: Some(sha256(&[BYTES])),
                native_delivery_confirmed: Some(false),
            };
            *store.published.lock().unwrap() = vec![status.clone()];
            live.file_bridge.drive_storage().unwrap();
            let route = live.file_bridge.next_to_start().unwrap();
            assert_eq!(route.id, view.id);
            let outgoing = crate::OutgoingFile {
                path: PathBuf::new(),
                filename: "test.bin".into(),
                mime: "application/octet-stream".into(),
                size: BYTES.len() as u64,
                source_bytes: None,
                message_id: Some(view.message_id.clone()),
                protocol_transfer_id: None,
                meter: crate::TransferMeter::new(),
                last_activity_at: Instant::now(),
                active: true,
                locally_paused: false,
                phase: crate::OutgoingFilePhase::Transferring,
                fully_sent: pause_case.is_none(),
                retry_count: 0,
                web_transfer_id: Some(view.id.clone()),
            };
            offer_web_transfer_with_native_send(
                &profile.handle,
                &live.file_bridge,
                &profile.messages,
                &profile.outgoing_files,
                &route,
                &view.message_id,
                outgoing,
                |_, _| (7, 0),
                || {},
            )
            .unwrap();

            if let Some(native_error) = pause_case {
                assert!(history_enabled);
                exercise_pause_before_peer_acceptance(
                    &mut live,
                    &mut domain,
                    &profile,
                    &view,
                    &status,
                    friend,
                    native_error,
                );
                return;
            }

            // Exercise the native request -> retained range -> accepted-byte
            // accounting before EOF. A zero ACK with position=size alone must not
            // pretend that an unserved stream reached the peer.
            {
                let mut context = callback_context(&profile);
                let guard = profile.handle.lock().unwrap();
                unsafe {
                    crate::on_file_chunk_request(
                        guard.as_ref().unwrap().instance.as_ptr(),
                        friend,
                        7,
                        0,
                        BYTES.len(),
                        (&mut context as *mut crate::CallbackContext).cast(),
                    );
                }
            }
            *store.reply.lock().unwrap() = Some(Ok(StoreReply::Range {
                status: status.clone(),
                offset: 0,
                bytes: Arc::from(BYTES),
            }));
            live.file_bridge.drive_storage().unwrap();
            let mut now_ms = 1_000;
            let chunk = loop {
                let (chunk, retry_after_ms) = live
                    .file_bridge
                    .next_outgoing_chunk(&view.id, now_ms)
                    .unwrap();
                if let Some(chunk) = chunk {
                    break chunk;
                }
                assert!(now_ms < 2_000, "served native range stayed blocked");
                now_ms += retry_after_ms.max(1);
            };
            assert_eq!(chunk.data, BYTES);
            live.file_bridge
                .outgoing_chunk_sent(&view.id, 0, BYTES.len(), now_ms)
                .unwrap();
            publish_web_outgoing_progress(
                &profile.messages,
                &view.message_id,
                BYTES.len() as u64,
                0,
                BYTES.len() as u64,
            );
            *store.reply.lock().unwrap() = None;

            if acknowledge {
                eof(&profile, friend); // Actual zero-length native callback, no direct persistence call.
                assert_pending(&live, &profile, &view.id);
                live.reconcile_web_transfer_terminal(&mut domain, 1, 1_000)
                    .unwrap();
                assert!(store.operations.lock().unwrap().iter().any(|operation| {
                matches!(operation, StoreOperation::MarkDelivered { object_id } if object_id == &view.id)
            }));
                assert_pending(&live, &profile, &view.id);

                let pending_domain = serde_json::to_value(&domain.transfers).unwrap();
                for action in ["pause", "resume", "cancel"] {
                    assert!(live
                        .control_web_transfer(&mut domain, PROFILE, &view.message_id, action, 1_000)
                        .is_err());
                    assert_eq!(
                        serde_json::to_value(&domain.transfers).unwrap(),
                        pending_domain,
                        "rejected {action} changed the pending delivery slot"
                    );
                    assert_pending(&live, &profile, &view.id);
                }

                // An unavailable worker must retain the same pending terminal
                // decision, not publish completion or reoffer the native stream.
                *store.reply.lock().unwrap() = Some(Err(StoreError::Unavailable));
                let _ = live.reconcile_web_transfer_terminal(&mut domain, 1, 1_001);
                assert_pending(&live, &profile, &view.id);
                assert!(live.file_bridge.next_to_start().is_none());
                *store.reply.lock().unwrap() = None;
                let attempts = store.operations.lock().unwrap().len();
                live.file_bridge
                    .inner
                    .lock()
                    .unwrap()
                    .transfers
                    .get_mut(&view.id)
                    .unwrap()
                    .outgoing_delivery_retry_at = None; // Advance only this test-owned retry deadline.
                live.reconcile_web_transfer_terminal(&mut domain, 1, 1_002)
                    .unwrap();
                assert!(
                    store.operations.lock().unwrap().len() > attempts,
                    "pending durable ACK was not retried"
                );
                eof(&profile, friend); // Duplicate EOF is harmless while commit is pending.
                assert_pending(&live, &profile, &view.id);

                let pending_snapshot_revision = if !history_enabled {
                    let snapshot = live
                        .dispatch(
                            PROFILE,
                            "get_tox_messages_snapshot",
                            &serde_json::json!({ "friendNumber": friend, "limit": 10 }),
                        )
                        .unwrap();
                    let row = snapshot["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|row| row["id"] == view.message_id)
                        .unwrap();
                    assert_eq!(row["attachment"]["completed"], false);
                    Some(snapshot["revision"].as_u64().unwrap())
                } else {
                    None
                };
                status.native_delivery_confirmed = Some(true);
                *store.published.lock().unwrap() = vec![status.clone()];
                *store.reply.lock().unwrap() = Some(Ok(StoreReply::Status(status.clone())));
                live.reconcile_web_transfer_terminal(&mut domain, 1, 1_002)
                    .unwrap();
                assert_eq!(
                    live.file_bridge.view(&view.id, 1_002).unwrap().state,
                    "complete"
                );
                let rows = profile.messages.lock().unwrap();
                let row = rows.iter().find(|row| row.id == view.message_id).unwrap();
                assert!(row.attachment.as_ref().unwrap().completed);
                assert_eq!(row.delivery, "delivered");
                drop(rows);
                if let Some(known_revision) = pending_snapshot_revision {
                    let snapshot = live.dispatch(
        PROFILE,
        "get_tox_messages_snapshot",
        &serde_json::json!({
            "friendNumber": friend, "limit": 10, "knownRevision": known_revision,
        }),
    ).unwrap();
                    let rows = snapshot["messages"].as_array().expect(
                        "durable completion must invalidate the history-disabled UI revision",
                    );
                    let row = rows
                        .iter()
                        .find(|row| row["id"] == view.message_id)
                        .unwrap();
                    assert_eq!(row["attachment"]["completed"], true);
                    assert_eq!(row["attachment"]["transfer_state"], "complete");
                    assert_eq!(row["delivery"], "delivered");
                }

                if history_enabled {
                    // Observe the normal 350ms history worker, without Flush,
                    // required-persist, checkpoint, runtime.stop or Drop.
                    let deadline = Instant::now() + Duration::from_secs(5);
                    loop {
                        let rows = crate::chat_history_store::latest_registered(
                            &profile.history_path,
                            friend,
                            &status.spec.friend_public_key,
                            10,
                        )
                        .unwrap();
                        if rows.iter().any(|row| {
                            row.id == view.message_id
                                && row.attachment.as_ref().is_some_and(|a| a.completed)
                        }) {
                            break;
                        }
                        assert!(
                            Instant::now() < deadline,
                            "ordinary history worker did not publish completion"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                }
            }

            // Crash boundary: copy the actual already-published encrypted files
            // BEFORE any Drop/stop can force the dirty live volume to disk.
            let restart_root = root.0.join("restart");
            let restart_container = restart_root
                .join("profiles")
                .join(PROFILE)
                .join(format!("{PROFILE}.kai"));
            fs::create_dir_all(restart_container.parent().unwrap()).unwrap();
            fs::copy(volume.container_path(), &restart_container).unwrap();
            let mut key_name = restart_container.as_os_str().to_os_string();
            key_name.push(".keys");
            fs::copy(volume.key_path(), PathBuf::from(key_name)).unwrap();
            drop(profile);
            drop(volume);
            drop(live); // Cleanup can now write only the original, not the copied files.

            let restored_store = Arc::new(DeferredTransferStore::default());
            restored_store.ready.store(true, Ordering::Release);
            *restored_store.published.lock().unwrap() = vec![status.clone()];
            let mut restored = runtime(&restart_root, restored_store);
            let restored_volume = KaiProfileVolume::open(restart_container, None).unwrap();
            let restored_profile =
                mount_profile(&mut restored, restored_volume, false, history_enabled);
            let raw_rows = crate::chat_history_store::latest_registered(
                &restored_profile.history_path,
                friend,
                &status.spec.friend_public_key,
                10,
            )
            .unwrap();
            if history_enabled {
                let row = raw_rows
                    .iter()
                    .find(|row| row.id == view.message_id)
                    .unwrap();
                assert_eq!(
                    row.attachment.as_ref().unwrap().transfer_state,
                    "queued",
                    "fixture did not preserve the initial disk boundary"
                );
                assert!(!row.attachment.as_ref().unwrap().completed);
            } else {
                assert!(
                    raw_rows.is_empty(),
                    "history disabled must not create a persisted chat row"
                );
            }
            let mut restored_domain = new_domain();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                restored
                    .reconcile_web_transfer_terminal(&mut restored_domain, 2, 2_000)
                    .unwrap();
                if restored.file_bridge.view(&view.id, 2_000).is_ok() {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "retained object restoration timed out"
                );
                thread::sleep(Duration::from_millis(5));
            }
            let after = restored.file_bridge.view(&view.id, 2_000).unwrap();
            assert_eq!(after.state, if acknowledge { "complete" } else { "failed" });
            assert_eq!(
                after.transferred_bytes,
                if acknowledge { BYTES.len() as u64 } else { 0 }
            );
            assert_eq!(after.uploaded_bytes, BYTES.len() as u64);
            assert!(after.payload_committed && after.download_available);
            assert_eq!(
                restored.file_bridge.routing(&view.id).unwrap().file_number,
                u32::MAX
            );
            assert!(restored.file_bridge.next_to_start().is_none());

            for command in [
                "get_tox_messages",
                "get_tox_messages_page",
                "get_tox_messages_snapshot",
            ] {
                let value = restored
                    .dispatch(
                        PROFILE,
                        command,
                        &serde_json::json!({ "friendNumber": friend, "limit": 10 }),
                    )
                    .unwrap();
                let rows = if command == "get_tox_messages" {
                    value.as_array().unwrap()
                } else {
                    value["messages"].as_array().unwrap()
                };
                if !history_enabled {
                    assert!(
                        rows.is_empty(),
                        "{command} synthesized a disabled history row"
                    );
                    continue;
                }
                let row = rows
                    .iter()
                    .find(|row| row["id"] == view.message_id)
                    .unwrap();
                assert_eq!(
                    row["attachment"]["path"],
                    format!("browser-stream://{}", view.id)
                );
                assert_eq!(row["attachment"]["completed"], acknowledge, "{command}");
                if acknowledge {
                    assert_eq!(row["attachment"]["transfer_state"], "complete", "{command}");
                    assert_eq!(row["attachment"]["transferred"], BYTES.len(), "{command}");
                    assert_eq!(row["delivery"], "delivered", "{command}");
                } else {
                    assert_eq!(row["attachment"]["transfer_state"], "failed", "{command}");
                    assert_eq!(row["attachment"]["transferred"], 0, "{command}");
                }
            }
            drop(restored_profile);
            drop(restored);
        }

        fn exercise(history_enabled: bool, acknowledge: bool) {
            exercise_case(history_enabled, acknowledge, None);
        }

        #[test]
        fn native_web_control_accepts_already_paused_before_peer_acceptance() {
            exercise_case(true, false, Some(6));
        }

        #[test]
        fn native_web_control_rejects_non_idempotent_pause_error() {
            exercise_case(true, false, Some(2));
        }

        fn legacy_retained_row(status: &StoreObjectStatus, path: String) -> crate::ToxMessage {
            serde_json::from_value(serde_json::json!({
                "id": status.spec.message_id,
                "friend_number": 1,
                "friend_public_key": status.spec.friend_public_key,
                "text": "", "mine": status.spec.direction == StoreDirection::Outgoing,
                "timestamp": 1, "delivery": "pending",
                "attachment": {
                    "name": status.spec.name, "size": status.spec.size_bytes,
                    "mime": status.spec.mime, "path": path, "image": false,
                    "transfer_state": "queued", "completed": false, "transferred": 0,
                    "speed_bytes_per_sec": 2, "eta_seconds": 2,
                    "transfer_error": "FILE_TRANSFER_INTERRUPTED"
                }
            }))
            .unwrap()
        }

        #[test]
        fn retained_legacy_paths_relink_both_directions_without_inventing_delivery() {
            let root = OwnedRoot::new("legacy-paths");
            let store = Arc::new(DeferredTransferStore::default());
            store.ready.store(true, Ordering::Release);
            let mut live = runtime(&root.0, Arc::clone(&store));
            let volume =
                KaiProfileVolume::create(live.profile_container_path(PROFILE).unwrap(), None)
                    .unwrap();
            let profile = mount_profile(&mut live, volume, true, false);
            let resident_before = serde_json::to_value(&*profile.messages.lock().unwrap()).unwrap();
            for direction in [StoreDirection::Incoming, StoreDirection::Outgoing] {
                let directory = if direction == StoreDirection::Outgoing {
                    "outgoing-files"
                } else {
                    "downloads"
                };
                for marker in [None, Some(false), Some(true)] {
                    if direction == StoreDirection::Incoming && marker.is_some() {
                        continue;
                    }
                    let mut status = test_store_status("retained", direction, 4);
                    status.spec.profile_id = PROFILE.into();
                    status.phase = StorePhase::Committed;
                    status.durable_bytes = 4;
                    status.committed_sha256 = Some([7; 32]);
                    status.native_delivery_confirmed = marker;
                    let bridge = WebFileBridge::default();
                    bridge.restore_storage(status.clone(), 1, false).unwrap();
                    for path in [
                        format!("{directory}/retained"),
                        format!(r"{directory}\retained"),
                        format!("/owned/profile/{directory}/retained"),
                        format!(r"C:\owned\profile\{directory}\retained"),
                        "browser-stream://retained".into(),
                    ] {
                        let mut rows = vec![legacy_retained_row(&status, path)];
                        let mut expected = rows[0].clone();
                        let attachment = expected.attachment.as_mut().unwrap();
                        attachment.path = "browser-stream://retained".into();
                        if direction == StoreDirection::Outgoing && marker == Some(true) {
                            attachment.completed = true;
                            attachment.transfer_state = "complete".into();
                            attachment.transferred = 4;
                            attachment.speed_bytes_per_sec = 0;
                            attachment.eta_seconds = None;
                            attachment.transfer_error = None;
                            expected.delivery = "delivered".into();
                        } else if direction == StoreDirection::Outgoing {
                            attachment.transfer_state = "failed".into();
                            attachment.speed_bytes_per_sec = 0;
                            attachment.eta_seconds = None;
                            attachment.transfer_error = None;
                        }
                        bridge
                            .decorate_retained_transfer_messages(&profile, &mut rows)
                            .unwrap();
                        assert_eq!(
                            serde_json::to_value(&rows).unwrap(),
                            serde_json::to_value(vec![expected]).unwrap(),
                            "{direction:?}, marker {marker:?}"
                        );
                    }
                    let mut empty = Vec::new();
                    bridge
                        .decorate_retained_transfer_messages(&profile, &mut empty)
                        .unwrap();
                    assert!(
                        empty.is_empty(),
                        "retained metadata recreated cleared history"
                    );
                    assert_eq!(bridge.storage_spec("retained").unwrap(), status.spec);
                }
            }
            assert_eq!(
                serde_json::to_value(&*profile.messages.lock().unwrap()).unwrap(),
                resident_before,
                "decoration wrote the profile's resident history"
            );
            assert!(store.operations.lock().unwrap().is_empty());
        }

        #[test]
        fn retained_failure_projection_preserves_live_states_and_legacy_completion() {
            let root = OwnedRoot::new("retained-state-projection");
            let store = Arc::new(DeferredTransferStore::default());
            store.ready.store(true, Ordering::Release);
            let mut live = runtime(&root.0, Arc::clone(&store));
            let volume =
                KaiProfileVolume::create(live.profile_container_path(PROFILE).unwrap(), None)
                    .unwrap();
            let profile = mount_profile(&mut live, volume, true, false);
            let mut status = test_store_status("retained", StoreDirection::Outgoing, 4);
            status.spec.profile_id = PROFILE.into();
            status.phase = StorePhase::Committed;
            status.durable_bytes = 4;
            status.committed_sha256 = Some([7; 32]);
            status.native_delivery_confirmed = Some(false);
            for (state, row_state) in [
                ("queued", "queued"),
                ("queued", "sending"),
                ("starting", "queued"),
                ("sending", "sending"),
                ("paused", "paused"),
                ("cancelled", "cancelled"),
            ] {
                let bridge = WebFileBridge::default();
                bridge.restore_storage(status.clone(), 1, false).unwrap();
                {
                    let mut inner = bridge.inner.lock().unwrap();
                    let transfer = inner.transfers.get_mut("retained").unwrap();
                    transfer.state = state.into();
                    transfer.locally_paused = state == "paused";
                }
                let mut row = legacy_retained_row(&status, "browser-stream://retained".into());
                row.attachment.as_mut().unwrap().transfer_state = row_state.into();
                let before = serde_json::to_value(&row).unwrap();
                let mut rows = vec![row];
                bridge
                    .decorate_retained_transfer_messages(&profile, &mut rows)
                    .unwrap();
                assert_eq!(serde_json::to_value(&rows[0]).unwrap(), before, "{state}");
            }
            status.native_delivery_confirmed = None;
            let bridge = WebFileBridge::default();
            bridge.restore_storage(status.clone(), 1, true).unwrap();
            assert_eq!(bridge.view("retained", 1).unwrap().state, "complete");
            let mut row = legacy_retained_row(&status, "browser-stream://retained".into());
            let attachment = row.attachment.as_mut().unwrap();
            attachment.transfer_state = "complete".into();
            attachment.completed = true;
            attachment.transferred = 4;
            row.delivery = "delivered".into();
            let before = serde_json::to_value(&row).unwrap();
            let mut rows = vec![row];
            bridge
                .decorate_retained_transfer_messages(&profile, &mut rows)
                .unwrap();
            assert_eq!(serde_json::to_value(&rows[0]).unwrap(), before);
            // A modern explicitly unknown transfer may also outlive stale
            // history that claimed delivery. The actual failed bridge wins.
            status.native_delivery_confirmed = Some(false);
            let failed = WebFileBridge::default();
            failed.restore_storage(status.clone(), 1, true).unwrap();
            assert_eq!(failed.view("retained", 1).unwrap().state, "failed");
            rows[0].delivered_at = Some(2);
            rows[0].attachment.as_mut().unwrap().completed_at = Some(2);
            failed
                .decorate_retained_transfer_messages(&profile, &mut rows)
                .unwrap();
            let attachment = rows[0].attachment.as_ref().unwrap();
            assert_eq!(attachment.transfer_state, "failed");
            assert!(!attachment.completed);
            assert_eq!(attachment.completed_at, None);
            assert_eq!(attachment.transferred, 0);
            assert_eq!(rows[0].delivery, "unknown_recovered");
            assert_eq!(rows[0].delivered_at, None);
            assert!(store.operations.lock().unwrap().is_empty());
        }

        #[test]
        fn retained_legacy_paths_reject_mismatched_bindings_and_lookalike_paths() {
            let root = OwnedRoot::new("legacy-path-rejection");
            let store = Arc::new(DeferredTransferStore::default());
            store.ready.store(true, Ordering::Release);
            let mut live = runtime(&root.0, Arc::clone(&store));
            let volume =
                KaiProfileVolume::create(live.profile_container_path(PROFILE).unwrap(), None)
                    .unwrap();
            let profile = mount_profile(&mut live, volume, true, false);
            for (direction, marker) in [
                (StoreDirection::Incoming, None),
                (StoreDirection::Outgoing, Some(false)),
                (StoreDirection::Outgoing, Some(true)),
            ] {
                let directory = if direction == StoreDirection::Outgoing {
                    "outgoing-files"
                } else {
                    "downloads"
                };
                for mismatch in [
                    "transfer-profile",
                    "store-profile",
                    "object-id",
                    "message-id",
                    "friend",
                    "name",
                    "mime",
                    "size",
                    "direction",
                    "removed",
                    "parent",
                    "other-parent",
                    "nested-parent",
                    "basename",
                    "empty-basename",
                    "extended-basename",
                    "canonical-id",
                    "canonical-child",
                ] {
                    let mut status = test_store_status("retained", direction, 4);
                    status.spec.profile_id = PROFILE.into();
                    status.phase = StorePhase::Committed;
                    status.durable_bytes = 4;
                    status.committed_sha256 = Some([7; 32]);
                    status.native_delivery_confirmed = marker;
                    let bridge = WebFileBridge::default();
                    bridge.restore_storage(status.clone(), 1, false).unwrap();
                    let mut rows = vec![legacy_retained_row(
                        &status,
                        format!("/owned/profile/{directory}/retained"),
                    )];
                    let attachment = rows[0].attachment.as_mut().unwrap();
                    match mismatch {
                        "message-id" => rows[0].id = "other-message".into(),
                        "friend" => rows[0].friend_public_key = "CD".repeat(32),
                        "name" => attachment.name = "other.bin".into(),
                        "mime" => attachment.mime = "image/*".into(),
                        "size" => attachment.size = 5,
                        "parent" => attachment.path = "/owned/arbitrary/retained".into(),
                        "other-parent" => {
                            attachment.path = format!(
                                "/owned/{}/retained",
                                if direction == StoreDirection::Outgoing {
                                    "downloads"
                                } else {
                                    "outgoing-files"
                                }
                            )
                        }
                        "nested-parent" => attachment.path = format!("{directory}/nested/retained"),
                        "basename" => attachment.path = format!("{directory}/other"),
                        "empty-basename" => attachment.path = format!("{directory}/"),
                        "extended-basename" => {
                            attachment.path = format!("{directory}/retained.bin")
                        }
                        "canonical-id" => attachment.path = "browser-stream://other".into(),
                        "canonical-child" => {
                            attachment.path = "browser-stream://retained/child".into()
                        }
                        _ => {
                            let mut inner = bridge.inner.lock().unwrap();
                            let transfer = inner.transfers.get_mut("retained").unwrap();
                            let stored = transfer.storage.as_mut().unwrap();
                            match mismatch {
                                "transfer-profile" => transfer.profile_id = "other-profile".into(),
                                "store-profile" => stored.spec.profile_id = "other-profile".into(),
                                "object-id" => stored.spec.object_id = "other".into(),
                                "direction" => {
                                    stored.spec.direction = if direction == StoreDirection::Outgoing
                                    {
                                        StoreDirection::Incoming
                                    } else {
                                        StoreDirection::Outgoing
                                    }
                                }
                                "removed" => stored.phase = StorePhase::Removed,
                                _ => unreachable!(),
                            }
                        }
                    }
                    let before = serde_json::to_value(&rows).unwrap();
                    bridge
                        .decorate_retained_transfer_messages(&profile, &mut rows)
                        .unwrap();
                    assert_eq!(
                        serde_json::to_value(&rows).unwrap(),
                        before,
                        "{direction:?}, marker {marker:?}: {mismatch} changed the row"
                    );
                }
            }
            assert!(store.operations.lock().unwrap().is_empty());
        }

        #[test]
        fn native_delivery_commit_defers_callback_and_restores_stale_mounted_history() {
            exercise(true, true);
        }

        #[test]
        fn native_delivery_commit_works_with_history_disabled_without_creating_rows() {
            exercise(false, true);
        }

        #[test]
        fn native_delivery_commit_unknown_committed_outgoing_remains_failed_after_restart() {
            exercise(true, false);
        }
    }
}
