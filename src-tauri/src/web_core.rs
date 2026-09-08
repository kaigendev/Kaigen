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
        Arc, Mutex,
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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundTransferWorkEntry {
    profile_id: String,
    friend_number: u32,
    message_id: String,
    transfer_id: String,
    path: String,
    name: String,
    size: u64,
    image: bool,
    transfer_state: String,
    completed: bool,
    auto_accept: bool,
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
    requested_position: Option<u64>,
    requested_length: Option<usize>,
    requested_through: u64,
    native_chunk_bytes: Option<usize>,
    outgoing_chunks: VecDeque<BufferedOutgoingChunk>,
    incoming_chunks: VecDeque<(u64, Vec<u8>)>,
    incoming_remote_complete: bool,
}

struct BufferedOutgoingChunk {
    position: u64,
    data: Vec<u8>,
    consumed: usize,
}

fn ensure_transfer_profile(actual: &str, requested: &str) -> Result<(), String> {
    if actual == requested {
        Ok(())
    } else {
        Err("TRANSFER_PROFILE_MISMATCH".to_string())
    }
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
            transfer.state = "failed".to_string();
            buffered
        })
        .unwrap_or(0);
    inner.buffered_bytes = inner.buffered_bytes.saturating_sub(buffered_removed);
    // Keep a failed active transfer in the slot until the authenticated HTTP
    // path applies the same terminal state to WorkspaceDomain. Starting the
    // next bridge entry before that reconciliation can make its first progress
    // update target the previous domain transfer.
}

/// Bounded, workspace-wide bridge between toxcore callbacks and browser
/// streaming endpoints.  It is deliberately shared by every active profile,
/// which makes the one-transfer, 25 MiB and 1 MiB/s policies impossible to
/// bypass through another profile or endpoint.
#[derive(Default)]
pub(crate) struct WebFileBridge {
    inner: Mutex<WebFileBridgeState>,
}

impl WebFileBridge {
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
                let image = transfer.mime.starts_with("image/")
                    || crate::is_auto_accepted_image_name(&transfer.name);
                let auto_accept = !transfer.outgoing
                    && !settings.deny_all
                    && transfer.size_bytes <= settings.max_auto_bytes
                    && (settings.auto_accept_any || (settings.auto_accept_images && image));
                Some(BackgroundTransferWorkEntry {
                    profile_id: transfer.profile_id.clone(),
                    friend_number: transfer.friend_number,
                    message_id: transfer.message_id.clone(),
                    transfer_id: transfer.id.clone(),
                    path: format!("browser-stream://{}", transfer.id),
                    name: transfer.name.clone(),
                    size: transfer.size_bytes,
                    image,
                    transfer_state: transfer.state.clone(),
                    completed: transfer.state == "complete",
                    auto_accept,
                })
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
                requested_position: None,
                requested_length: None,
                requested_through: 0,
                native_chunk_bytes: None,
                outgoing_chunks: VecDeque::new(),
                incoming_chunks: VecDeque::new(),
                incoming_remote_complete: false,
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
                requested_position: None,
                requested_length: None,
                requested_through: 0,
                native_chunk_bytes: None,
                outgoing_chunks: VecDeque::new(),
                incoming_chunks: VecDeque::new(),
                incoming_remote_complete: false,
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
                if transfer.state != "queued" {
                    continue;
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
        let released = {
            let Some(transfer) = inner.transfers.get_mut(id) else {
                return false;
            };
            if !transfer.outgoing {
                return false;
            }
            if length == 0 {
                let released = outgoing_buffered_bytes(transfer);
                transfer.outgoing_chunks.clear();
                transfer.transferred_bytes = transfer.size_bytes;
                transfer.requested_through = transfer.size_bytes;
                transfer.requested_position = None;
                transfer.requested_length = None;
                transfer.state = "complete".to_string();
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
                data: data.to_vec(),
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
                && matches!(transfer.state.as_str(), "receiving" | "backpressure")
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
        let (outgoing, state, transferred_bytes, size_bytes) = {
            let transfer = inner.transfers.get(id).ok_or("TRANSFER_NOT_FOUND")?;
            (
                transfer.outgoing,
                transfer.state.clone(),
                transfer.transferred_bytes,
                transfer.size_bytes,
            )
        };
        if outgoing || !matches!(state.as_str(), "receiving" | "backpressure") {
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
            return Ok(state != "backpressure");
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
            .push_back((transferred_bytes, fresh.to_vec()));
        transfer.transferred_bytes = end;
        record_transfer_speed(transfer, now_ms);
        inner.buffered_bytes = next_buffered;
        // Pause well before the hard ceiling so the chunk currently being
        // delivered is always retained. This avoids a corrupt gap while still
        // keeping aggregate workspace buffering strictly below 25 MiB.
        let keep_running = next_buffered
            < TRANSFER_BUFFER_LIMIT_BYTES.saturating_sub(FRAME_STREAM_CHUNK_BYTES as u64);
        if !keep_running {
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

    pub(crate) fn control(
        &self,
        message_id: &str,
        action: &str,
    ) -> Result<WebTransferRouting, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?;
        let id = inner
            .transfers
            .values()
            .find(|transfer| transfer.message_id == message_id)
            .map(|transfer| transfer.id.clone())
            .ok_or("TRANSFER_NOT_FOUND")?;
        let is_active = inner.active_id.as_deref() == Some(id.as_str());
        let (profile_id, friend_number, file_number, outgoing, buffered_removed, queue, deactivate) = {
            let transfer = inner.transfers.get_mut(&id).ok_or("TRANSFER_NOT_FOUND")?;
            let file_number = transfer.file_number.unwrap_or(u32::MAX);
            let mut buffered_removed = 0_u64;
            let mut queue = false;
            let mut deactivate = false;
            match action {
                "resume" => {
                    if transfer.state == "complete" || transfer.state == "cancelled" {
                        return Err("TRANSFER_NOT_RESUMABLE".to_string());
                    }
                    if is_active
                        && matches!(
                            transfer.state.as_str(),
                            "sending" | "receiving" | "starting"
                        )
                    {
                        return Err("TRANSFER_ALREADY_ACTIVE".to_string());
                    }
                    transfer.state = "queued".to_string();
                    queue = true;
                }
                "pause" => {
                    transfer.state = "paused".to_string();
                    deactivate = is_active;
                }
                "cancel" => {
                    transfer.state = "cancelled".to_string();
                    buffered_removed = transfer_buffered_bytes(transfer);
                    transfer.outgoing_chunks.clear();
                    transfer.incoming_chunks.clear();
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
        if action != "resume" {
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
            let mut buffered_removed = 0_u64;
            match control {
                0 => {
                    transfer.state = if transfer.outgoing {
                        "sending"
                    } else {
                        "receiving"
                    }
                    .to_string();
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
                // slot until the authenticated status path has also cancelled
                // the matching WorkspaceDomain entry. Releasing it here lets
                // the next browser pump start against the previous domain slot
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
        let id = inner.active_id.take()?;
        let transfer = inner.transfers.get_mut(&id)?;
        transfer.state = "paused".to_string();
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
        })
    }

    pub(crate) fn id_for_message(&self, message_id: &str) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        inner
            .transfers
            .values()
            .find(|transfer| transfer.message_id == message_id)
            .map(|transfer| transfer.id.clone())
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
        if terminal && inner.active_id.as_deref() == Some(id) {
            let released = inner
                .transfers
                .get_mut(id)
                .map(|transfer| {
                    let released = transfer_buffered_bytes(transfer);
                    transfer.outgoing_chunks.clear();
                    transfer.incoming_chunks.clear();
                    released
                })
                .unwrap_or(0);
            inner.buffered_bytes = inner.buffered_bytes.saturating_sub(released);
            inner.active_id = None;
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
        if blob.version != VAULT_VERSION {
            return Err("WORKSPACE_DATA_VERSION_UNSUPPORTED".to_string());
        }
        let dek = self
            .unlocked_dek
            .as_ref()
            .ok_or_else(|| "WORKSPACE_LOCKED".to_string())?;
        let aad = blob_aad(&self.workspace_hash, logical_path);
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
        Ok(())
    }

    pub fn remove_profile_data(&mut self, profile_id: &str) -> Result<(), String> {
        self.stop_profile(profile_id)?;
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
        now: u64,
        now_ms: u64,
    ) -> Result<WebTransferView, String> {
        let lease = domain.data_lease.status(now, self.file_bridge.has_active());
        if !lease.new_transfers_allowed {
            return Err("WORKSPACE_LEASE_EXPIRED".to_string());
        }
        let profile = self
            .profiles
            .get(profile_id)
            .cloned()
            .ok_or("PROFILE_NOT_ACTIVE")?;
        let (friend_public_key, transaction) =
            crate::lock_chat_transaction_for_friend(&profile, friend_number)?;
        let name = crate::safe_file_name(filename);
        let mime = sanitize_untrusted_text(mime)
            .chars()
            .take(128)
            .collect::<String>();
        let negotiated = profile.chat_protocol.supports(friend_number);
        let message_id = if negotiated {
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
        profile.chat_transport_ready.store(false, Ordering::Release);
        if negotiated {
            if let Err(error) = profile.file_card_protocol.offer_for_send(
                friend_number,
                &friend_public_key,
                &message_id,
                &name,
                size_bytes,
            ) {
                let _ = self.file_bridge.control(&message_id, "cancel");
                return Err(error);
            }
        }
        domain.transfers.offer(TransferOffer {
            id: transfer_id.clone(),
            profile_id: profile_id.to_string(),
            direction: TransferDirection::Outgoing,
            size_bytes,
            state: TransferState::Queued,
            transferred_bytes: 0,
            last_progress_at: None,
        })?;
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
                self.file_bridge.scheduled_start_failed(&transfer_id);
                return Err(error);
            }
        }
        crate::commit_chat_transaction_with_barrier(
            &profile.history_path,
            &profile.chat_transport_ready,
        )?;
        crate::bump_chat_view_revision(&profile.history_path, friend_number, &friend_public_key);
        drop(transaction);
        self.start_next_web_transfer()?;
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
            let mut error = 0_i32;
            {
                let handle = profile.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
                let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
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
            if error != 0 {
                self.file_bridge.scheduled_start_failed(&route.id);
                return Ok(());
            }
            if let Some((message_id, _, _)) = self.file_bridge.progress(&route.id) {
                crate::set_attachment_transfer_state(
                    &profile.messages,
                    &message_id,
                    if route.outgoing {
                        "sending"
                    } else {
                        "receiving"
                    },
                );
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
                    let _ = self.file_bridge.control(&message_id, "cancel");
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
        let mut error = 0_i32;
        let file_number = {
            let handle = profile.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
            let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
            unsafe {
                crate::tox_file_send(
                    handle.instance.as_ptr(),
                    route.friend_number,
                    0,
                    size_bytes,
                    file_id.as_ptr(),
                    name.as_bytes().as_ptr(),
                    name.len(),
                    &mut error,
                )
            }
        };
        if error != 0 {
            self.file_bridge.outgoing_start_failed(&route.id);
            return Ok(());
        }
        self.file_bridge.outgoing_started(&route.id, file_number)?;
        profile
            .outgoing_files
            .lock()
            .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?
            .insert(
                (route.friend_number, file_number),
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
                    fully_sent: false,
                    retry_count: 0,
                    web_transfer_id: Some(route.id),
                },
            );
        crate::set_attachment_transfer_state(&profile.messages, &message_id, "sending");
        Ok(())
    }

    fn finalize_web_transfer_terminal(
        &mut self,
        domain: &mut WorkspaceDomain,
        view: &WebTransferView,
        completed_at: u64,
    ) -> Result<(), String> {
        if !matches!(view.state.as_str(), "complete" | "cancelled" | "failed") {
            return Ok(());
        }
        if domain.transfers.contains(&view.id) {
            if view.state == "complete" {
                let _ = domain.transfers.complete_stream(&view.id);
            } else {
                let _ = domain.transfers.cancel(&view.id);
            }
        }
        if view.state == "complete" && view.direction == "incoming" {
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
                    crate::persist_tox_history(
                        &profile.messages,
                        &profile.history_path,
                        &profile.history_enabled,
                    );
                }
            }
        }
        if matches!(view.state.as_str(), "complete" | "cancelled") {
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
        self.file_bridge.acknowledge_terminal(&view.id);
        self.start_next_web_transfer()
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
            // A browser upload is staged once in the bounded bridge buffer.
            // Holding the tox handle while draining keeps the native requests
            // ordered, while SENDQ leaves the unsent suffix in that buffer
            // instead of forcing the browser to upload it again.
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
                crate::update_attachment_progress(
                    &profile.messages,
                    &message_id,
                    transferred,
                    speed,
                    size,
                    "sending",
                    false,
                    None,
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
        self.start_next_web_transfer()?;
        let before = self.file_bridge.view(transfer_id, now_ms)?;
        if before.direction == "outgoing" && before.state == "sending" && before.buffered_bytes > 0
        {
            let _ = self.drain_web_outgoing_transfer(domain, transfer_id, now, now_ms)?;
        }
        let view = self.file_bridge.view(transfer_id, now_ms)?;
        self.finalize_web_transfer_terminal(domain, &view, now)?;
        Ok(view)
    }

    pub fn reconcile_web_transfer_terminal(
        &mut self,
        domain: &mut WorkspaceDomain,
        now: u64,
        now_ms: u64,
    ) -> Result<bool, String> {
        if let Some(transfer_id) = self.file_bridge.active_outgoing_id() {
            let _ = self.drain_web_outgoing_transfer(domain, &transfer_id, now, now_ms)?;
        }
        let Some(transfer_id) = self.file_bridge.active_terminal_id() else {
            return Ok(false);
        };
        let view = self.file_bridge.view(&transfer_id, now_ms)?;
        self.finalize_web_transfer_terminal(domain, &view, now)?;
        Ok(true)
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
        let route = self
            .file_bridge
            .stage_outgoing_upload(transfer_id, position, data)?;
        if route.profile_id != profile_id {
            return Err("TRANSFER_WORKSPACE_BOUNDARY".to_string());
        }
        let retry_after_ms = self.drain_web_outgoing_transfer(domain, transfer_id, now, now_ms)?;
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
            .id_for_message(message_id)
            .ok_or("TRANSFER_NOT_FOUND")?;
        let before = self.file_bridge.view(&transfer_id, now_ms)?;
        ensure_transfer_profile(&before.profile_id, profile_id)?;
        if !domain.transfers.contains(&transfer_id) {
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
        let route = self.file_bridge.control(message_id, action)?;
        if action != "resume" {
            let profile = self
                .profiles
                .get(&route.profile_id)
                .cloned()
                .ok_or("PROFILE_NOT_ACTIVE")?;
            if route.file_number != u32::MAX {
                let control = match action {
                    "pause" => 1,
                    "cancel" => 2,
                    _ => unreachable!(),
                };
                let mut error = 0_i32;
                let handle = profile.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
                let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
                unsafe {
                    let _ = crate::tox_file_control(
                        handle.instance.as_ptr(),
                        route.friend_number,
                        route.file_number,
                        control,
                        &mut error,
                    );
                }
                if error != 0 && action != "cancel" {
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
        now: u64,
        now_ms: u64,
    ) -> Result<Option<WebIncomingChunk>, String> {
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
        now: u64,
        now_ms: u64,
    ) -> Result<WebTransferView, String> {
        let before = self.file_bridge.view(transfer_id, now_ms)?;
        ensure_transfer_profile(&before.profile_id, profile_id)?;
        if before.direction != "incoming" {
            return Err("TRANSFER_DIRECTION_INVALID".to_string());
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
            "get_tox_friends" => self.friends(profile),
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
        let mut settings: FileReceiveSettings = serde_json::from_value(
            args.get("settings")
                .cloned()
                .ok_or("COMMAND_ARGUMENT_INVALID")?,
        )
        .map_err(|_| "FILE_SETTINGS_INVALID".to_string())?;
        settings.max_auto_bytes = settings.max_auto_bytes.min(crate::MAX_CHAT_FILE_BYTES);
        settings.max_concurrent = settings.max_concurrent.clamp(1, 2);
        let encoded = serde_json::to_vec(&settings).map_err(|error| error.to_string())?;
        profiles::atomic_write(&profile.file_receive_settings_path, &encoded)?;
        *profile
            .file_receive_settings
            .lock()
            .map_err(|_| "FILE_SETTINGS_UNAVAILABLE".to_string())? = settings.clone();
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
        let retained_file_cards = crate::active_file_card_message_ids(profile);
        if let Some(friend) = friend {
            crate::chat_history_store::clear_registered(
                &profile.history_path,
                Some((friend, &friend_key)),
            )?;
            profile
                .chat_protocol
                .clear_friend_history_state(friend, &friend_key)?;
            profile.file_card_protocol.retain_friend_messages(
                friend,
                &friend_key,
                &retained_file_cards,
            )?;
        } else {
            crate::chat_history_store::clear_registered(&profile.history_path, None)?;
            profile.chat_protocol.clear_history_state()?;
            profile
                .file_card_protocol
                .retain_messages(|binding| retained_file_cards.contains(&binding.message_id))?;
        }
        let mut messages = profile
            .messages
            .lock()
            .map_err(|_| "HISTORY_UNAVAILABLE".to_string())?;
        if let Some(friend) = friend {
            messages.retain(|message| !crate::message_matches_friend(message, friend, &friend_key));
        } else {
            messages.clear();
        }
        drop(messages);
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

    fn friends(&self, profile: &ToxState) -> Result<Value, String> {
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
        let guard = profile
            .handle
            .try_lock()
            .map_err(|_| "TOX_BUSY".to_string())?;
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
        let page = crate::chat_history_store::page_registered(
            &profile.history_path,
            friend,
            &public_key,
            offset,
            limit,
        )?;
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
                let messages = window.messages;
                crate::replace_cached_contact_window(profile, friend, &public_key, &messages)?;
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
        if let Ok(mut cache) = profile.friend_cache.lock() {
            let entry = cache.entry(public_key).or_default();
            entry.tox_id = normalized_tox_id;
            entry.friend_number = Some(friend);
            entry.pending_authorization = true;
            entry.authorization_message = message;
            entry.authorization_last_refreshed_at = added_at;
            entry.added_at = Some(added_at);
            entry.added_event_sequence = added_event_sequence;
            if let Ok(encoded) = serde_json::to_vec(&*cache) {
                profiles::atomic_write(&profile.friend_cache_path, &encoded)?;
            }
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
        crate::chat_history_store::clear_registered(
            &profile.history_path,
            Some((friend, &friend_key)),
        )?;
        if let Ok(mut messages) = profile.messages.lock() {
            messages.retain(|message| !crate::message_matches_friend(message, friend, &friend_key));
        }
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
        if let Ok(mut cache) = profile.friend_cache.lock() {
            let entry = cache.entry(public_key_hex.clone()).or_default();
            entry.authorized = true;
            entry.friend_number = Some(number);
            entry.pending_authorization = false;
            entry.authorization_message.clear();
            entry.added_at.get_or_insert_with(crate::unix_timestamp);
            entry.added_event_sequence = crate::next_chat_event_sequence();
            if let Ok(bytes) = serde_json::to_vec(&*cache) {
                profiles::atomic_write(&profile.friend_cache_path, &bytes)?;
            }
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
    use std::sync::atomic::AtomicUsize;

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
}
