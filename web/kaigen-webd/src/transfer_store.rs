//! Incremental transfer objects in the existing encrypted workspace store.
//! Only the worker performs filesystem or cipher operations. The public facade
//! uses bounded queues and published memory; native callbacks never wait on I/O.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri_app_lib::{
    web_core::WorkspacePayloadCipher,
    web_transfer_store::{
        StoreDirection, StoreError, StoreObjectStatus, StoreOperation, StorePhase, StoreReply,
        StoreSpec, StoreTicket, WebTransferStore,
    },
};

use crate::state::{
    payload_directory_bytes, prepare_root, read_blob_file, sync_directory, write_blob_file,
};

pub const DIRECTORY: &str = "transfer-payload";
const CHUNK_BYTES: usize = 1024 * 1024;
const FILE_LIMIT: u64 = 25 * 1024 * 1024;
const QUEUE_LIMIT: usize = 8;
const RESULT_LIMIT: usize = 128;
const OPERATION_CACHE_BYTES: usize = 2 * CHUNK_BYTES;

/// Shared with the ordinary payload checkpoint. Reservations are changed under
/// this small mutex, but no lock is retained while writing a file.
pub(crate) struct TransferQuota {
    limit: u64,
    inner: Mutex<QuotaState>,
    transfer_bytes: AtomicU64,
    payload_bytes: AtomicU64,
}

struct QuotaState {
    payload: u64,
    payload_reserved: u64,
    transfer: u64,
    payload_revision: u64,
}

pub(crate) struct PayloadReservation {
    quota: Arc<TransferQuota>,
    committed: bool,
}

impl TransferQuota {
    pub fn new(limit: u64, previous_total: u64) -> Arc<Self> {
        Arc::new(Self {
            limit,
            inner: Mutex::new(QuotaState {
                payload: previous_total,
                payload_reserved: 0,
                transfer: 0,
                payload_revision: 0,
            }),
            transfer_bytes: AtomicU64::new(0),
            payload_bytes: AtomicU64::new(previous_total),
        })
    }

    pub fn transfer_bytes(&self) -> u64 {
        self.transfer_bytes.load(Ordering::Acquire)
    }
    pub fn payload_bytes(&self) -> u64 {
        self.payload_bytes.load(Ordering::Acquire)
    }

    pub fn reserve_payload(self: &Arc<Self>, maximum: u64) -> Result<PayloadReservation, String> {
        let mut usage = self
            .inner
            .lock()
            .map_err(|_| "WORKSPACE_QUOTA_UNAVAILABLE")?;
        if usage.payload_reserved != 0
            || maximum.max(usage.payload).saturating_add(usage.transfer) > self.limit
        {
            return Err("WORKSPACE_QUOTA_FULL".to_string());
        }
        usage.payload_reserved = maximum.max(1);
        Ok(PayloadReservation {
            quota: Arc::clone(self),
            committed: false,
        })
    }

    fn replace_transfer(&self, previous: u64, next: u64) -> Result<(), StoreError> {
        let mut usage = self.inner.lock().map_err(|_| StoreError::Unavailable)?;
        let transfer = usage
            .transfer
            .checked_sub(previous)
            .and_then(|v| v.checked_add(next))
            .ok_or(StoreError::Quota)?;
        if next > previous
            && transfer.saturating_add(usage.payload.max(usage.payload_reserved)) > self.limit
        {
            return Err(StoreError::Quota);
        }
        usage.transfer = transfer;
        self.transfer_bytes.store(transfer, Ordering::Release);
        Ok(())
    }

    fn reserve_legacy_browser_receipt(
        &self,
        previous: u64,
        next: u64,
        exact_extra: u64,
    ) -> Result<(), StoreError> {
        // Only the validated legacy Incoming receipt upgrade calls this path.
        // Keep usage accurate above the limit until actual payload deletion;
        // ordinary allocations still use replace_transfer and remain denied.
        if exact_extra == 0
            || exact_extra > 128
            || next
                .checked_sub(previous)
                .is_none_or(|delta| delta != 0 && delta != exact_extra)
        {
            return Err(StoreError::Quota);
        }
        let mut usage = self.inner.lock().map_err(|_| StoreError::Unavailable)?;
        usage.transfer = usage
            .transfer
            .checked_sub(previous)
            .and_then(|value| value.checked_add(next))
            .ok_or(StoreError::Quota)?;
        self.transfer_bytes.store(usage.transfer, Ordering::Release);
        Ok(())
    }

    fn restore_transfer(
        &self,
        bytes: u64,
        payload_bytes: u64,
        receipt_extra: u64,
    ) -> Result<(), StoreError> {
        let mut usage = self.inner.lock().map_err(|_| StoreError::Unavailable)?;
        // Persisted quota is the combined counter. A concurrent new payload
        // checkpoint already knows its own actual byte count.
        if usage.payload_revision == 0 {
            usage.payload = payload_bytes;
        }
        if bytes.saturating_add(usage.payload.max(usage.payload_reserved))
            > self.limit.saturating_add(receipt_extra)
        {
            return Err(StoreError::Quota);
        }
        usage.transfer = bytes;
        self.payload_bytes.store(usage.payload, Ordering::Release);
        self.transfer_bytes.store(bytes, Ordering::Release);
        Ok(())
    }
}

impl PayloadReservation {
    pub fn commit(mut self, actual: u64) {
        if let Ok(mut usage) = self.quota.inner.lock() {
            usage.payload = actual;
            usage.payload_reserved = 0;
            usage.payload_revision = usage.payload_revision.saturating_add(1);
            self.quota.payload_bytes.store(actual, Ordering::Release);
            self.committed = true;
        }
    }
}

impl Drop for PayloadReservation {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut usage) = self.quota.inner.lock() {
                usage.payload_reserved = 0;
            }
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    offset: u64,
    length: usize,
    sha256: [u8; 32],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    status: StoreObjectStatus,
    chunks: Vec<Chunk>,
    /// Exact additional reservation for a legacy Incoming browser receipt.
    /// It is authenticated, verified on recovery and removed only with payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    browser_receipt_extra_bytes: Option<u64>,
}

impl Manifest {
    fn charge(&self) -> Result<u64, StoreError> {
        let encoded = serde_json::to_vec(self).map_err(|_| StoreError::Unavailable)?;
        if encoded.len() > CHUNK_BYTES {
            return Err(StoreError::Quota);
        }
        if self.status.phase == StorePhase::Removed || self.status.payload_released {
            return Ok(encoded.len() as u64 + 36);
        }
        // Storage frames are independent of native/browser Append boundaries.
        // Reserve the largest index, including its terminal digest, at Begin.
        // Otherwise an accepted file could run out of quota merely because a
        // slow peer delivered smaller chunks or Finalize added the digest.
        let mut maximum = self.clone();
        maximum.status.durable_bytes = self.status.spec.size_bytes;
        maximum.status.phase = StorePhase::Committed;
        maximum.status.committed_sha256 = Some([255; 32]);
        // `false` is longer than `true`. Keep this reservation after delivery;
        // an already accepted modern object never needs more terminal quota.
        // Legacy None keeps its original accounting until explicitly upgraded.
        maximum.status.native_delivery_confirmed =
            self.status.native_delivery_confirmed.map(|_| false);
        maximum.status.browser_download_confirmed =
            self.status.browser_download_confirmed.map(|_| false);
        maximum.chunks.clear();
        let mut offset = 0;
        while offset < self.status.spec.size_bytes {
            let length = (self.status.spec.size_bytes - offset).min(CHUNK_BYTES as u64) as usize;
            maximum.chunks.push(Chunk {
                offset,
                length,
                sha256: [255; 32],
            });
            offset += length as u64;
        }
        let maximum_index = serde_json::to_vec(&maximum).map_err(|_| StoreError::Unavailable)?;
        Ok(self.status.spec.size_bytes
            + maximum.chunks.len() as u64 * 36
            + maximum_index.len().max(encoded.len()) as u64
            + 36)
    }
}

struct TicketEntry {
    key: String,
    pending: Option<StoreOperation>,
    completed_operation: Option<StoreOperation>,
    result: Option<Result<StoreReply, StoreError>>,
    observed: bool,
}

struct ProfileRemovalEntry {
    result: Option<Result<(), StoreError>>,
    observed: bool,
}

enum WorkerRequest {
    Store(StoreTicket, StoreOperation),
    RemoveProfile(String),
}

#[derive(Default)]
struct Published {
    next_ticket: StoreTicket,
    tickets: HashMap<StoreTicket, TicketEntry>,
    order: VecDeque<StoreTicket>,
    operation_keys: HashMap<String, StoreTicket>,
    objects: Vec<StoreObjectStatus>,
    ready: bool,
    failure: Option<StoreError>,
    profile_removals: HashMap<String, ProfileRemovalEntry>,
}

pub(crate) struct TransferStore {
    sender: SyncSender<WorkerRequest>,
    published: Arc<Mutex<Published>>,
    stopping: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    suspended: AtomicBool,
}

impl TransferStore {
    pub fn start(
        root: PathBuf,
        cipher: WorkspacePayloadCipher,
        quota: Arc<TransferQuota>,
        profile_ids: HashSet<String>,
    ) -> Result<Arc<Self>, String> {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_LIMIT);
        let published = Arc::new(Mutex::new(Published::default()));
        let stopping = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(Self {
            sender,
            published: Arc::clone(&published),
            stopping: Arc::clone(&stopping),
            stopped: Arc::clone(&stopped),
            suspended: AtomicBool::new(false),
        });
        thread::Builder::new()
            .name("web-transfer-store".into())
            .spawn(move || {
                let loaded = Worker::load(root, cipher, quota).and_then(|mut worker| {
                    // A successfully persisted profile removal is also the
                    // durable cleanup receipt. Finish any interrupted sweep
                    // before exposing objects after a daemon restart.
                    worker.retain_profiles(&profile_ids)?;
                    Ok(worker)
                });
                let mut worker = match loaded {
                    Ok(worker) => worker,
                    Err(error) => {
                        if let Ok(mut state) = published.lock() {
                            state.failure = Some(error);
                        }
                        stopped.store(true, Ordering::Release);
                        return;
                    }
                };
                worker.publish(&published);
                loop {
                    let request = match receiver.recv_timeout(Duration::from_millis(25)) {
                        Ok(value) => value,
                        Err(mpsc::RecvTimeoutError::Timeout)
                            if stopping.load(Ordering::Acquire) =>
                        {
                            break
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    if let WorkerRequest::RemoveProfile(profile_id) = request {
                        let result = worker.remove_profile(&profile_id);
                        if let Ok(mut state) = published.lock() {
                            if let Some(entry) = state.profile_removals.get_mut(&profile_id) {
                                entry.result = Some(result);
                            }
                            state.objects = worker
                                .objects
                                .values()
                                .map(|entry| entry.status.clone())
                                .collect();
                            invalidate_removed_ranges(&mut state);
                        }
                        continue;
                    }
                    let WorkerRequest::Store(ticket, operation) = request else {
                        unreachable!()
                    };
                    let result = worker.apply(operation);
                    if let Ok(mut state) = published.lock() {
                        if let Some(entry) = state.tickets.get_mut(&ticket) {
                            // Operation polls do not retain tickets. Keep the
                            // exact operation until its completion is observed.
                            entry.completed_operation = entry.pending.take();
                            entry.result = Some(result);
                        }
                        state.objects = worker
                            .objects
                            .values()
                            .map(|value| value.status.clone())
                            .collect();
                        invalidate_removed_ranges(&mut state);
                    }
                }
                // The cipher and all file handles are dropped before the stop ACK.
                drop(worker);
                if let Ok(mut state) = published.lock() {
                    state.tickets.clear();
                    state.operation_keys.clear();
                    state.profile_removals.clear();
                }
                stopped.store(true, Ordering::Release);
            })
            .map_err(|_| "TRANSFER_STORAGE_UNAVAILABLE".to_string())?;
        Ok(handle)
    }

    pub fn request_stop(&self) {
        self.stopping.store(true, Ordering::Release);
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    pub fn try_suspend(&self) -> Result<(), StoreError> {
        self.suspended
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| StoreError::Busy)
    }

    pub fn resume(&self) {
        self.suspended.store(false, Ordering::Release);
    }

    pub fn is_quiesced(&self) -> bool {
        self.is_stopped()
            || (self.suspended.load(Ordering::Acquire)
                && self.published.try_lock().is_ok_and(|state| {
                    state.ready
                        && state.tickets.values().all(|entry| entry.pending.is_none())
                        && state
                            .profile_removals
                            .values()
                            .all(|entry| entry.result.is_some())
                }))
    }

    pub fn try_snapshot(&self) -> Result<Vec<StoreObjectStatus>, StoreError> {
        let state = self.published.try_lock().map_err(|_| StoreError::Busy)?;
        if let Some(error) = state.failure {
            return Err(error);
        }
        if !state.ready {
            return Err(StoreError::Busy);
        }
        Ok(state.objects.clone())
    }

    pub fn try_remove_profile(&self, profile_id: &str) -> Result<(), StoreError> {
        if !valid_id(profile_id) {
            return Err(StoreError::Range);
        }
        let mut state = self.published.try_lock().map_err(|_| StoreError::Busy)?;
        if self.is_stopping() || self.suspended.load(Ordering::Acquire) || !state.ready {
            return Err(StoreError::Busy);
        }
        if let Some(error) = state.failure {
            return Err(error);
        }
        if state
            .profile_removals
            .get(profile_id)
            .is_some_and(|entry| !matches!(entry.result, Some(Err(_))))
        {
            return Ok(());
        }
        if state.profile_removals.len() >= RESULT_LIMIT {
            state.profile_removals.retain(|_, entry| !entry.observed);
            if state.profile_removals.len() >= RESULT_LIMIT {
                return Err(StoreError::Busy);
            }
        }
        self.sender
            .try_send(WorkerRequest::RemoveProfile(profile_id.to_string()))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => StoreError::Busy,
                mpsc::TrySendError::Disconnected(_) => StoreError::Unavailable,
            })?;
        state.profile_removals.insert(
            profile_id.to_string(),
            ProfileRemovalEntry {
                result: None,
                observed: false,
            },
        );
        Ok(())
    }

    pub fn try_profile_removal_result(&self, profile_id: &str) -> Option<Result<(), StoreError>> {
        let mut state = self.published.try_lock().ok()?;
        let entry = state.profile_removals.get_mut(profile_id)?;
        if entry.result.is_some() {
            entry.observed = true;
        }
        entry.result
    }
}

impl Drop for TransferStore {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
    }
}

impl WebTransferStore for TransferStore {
    fn is_ready(&self) -> bool {
        !self.is_stopping()
            && self
                .published
                .try_lock()
                .is_ok_and(|state| state.ready && state.failure.is_none())
    }

    fn try_submit(&self, operation: StoreOperation) -> Result<StoreTicket, StoreError> {
        if self.is_stopping() {
            return Err(StoreError::Unavailable);
        }
        validate_operation(&operation)?;
        let mut state = self.published.try_lock().map_err(|_| StoreError::Busy)?;
        // Recheck under the publication lock: a suspend must also cover a
        // submitter that passed the first check just before suspension.
        if self.is_stopping() {
            return Err(StoreError::Unavailable);
        }
        if self.suspended.load(Ordering::Acquire) {
            return Err(StoreError::Busy);
        }
        if let Some(error) = state.failure {
            return Err(error);
        }
        if !state.ready {
            return Err(StoreError::Busy);
        }
        let key = operation_key(&operation);
        if let Some(ticket) = state.operation_keys.get(&key) {
            let old = state
                .tickets
                .get(ticket)
                .and_then(|entry| {
                    entry
                        .pending
                        .as_ref()
                        .or(entry.completed_operation.as_ref())
                })
                .ok_or(StoreError::Unavailable)?;
            return if same_operation(old, &operation) {
                Ok(*ticket)
            } else {
                Err(StoreError::Conflict)
            };
        }
        // The same bound covers pending reads, cached ranges and Append data
        // retained for exact replay checks. Snapshot-driven writers may never
        // observe successful Append tickets, so those must remain evictable.
        let new_bytes = match &operation {
            StoreOperation::ReadRange { length, .. } => *length,
            StoreOperation::Append { bytes, .. } => bytes.len(),
            _ => 0,
        };
        while state.tickets.len() >= RESULT_LIMIT
            || operation_cache_bytes(&state).saturating_add(new_bytes) > OPERATION_CACHE_BYTES
        {
            let count_full = state.tickets.len() >= RESULT_LIMIT;
            let eligible = |entry: &TicketEntry| {
                entry.result.is_some() && (count_full || entry_cache_bytes(entry) != 0)
            };
            // Preserve unobserved errors under ordinary successful traffic.
            // If all slots contain abandoned errors, recycle the oldest one
            // instead of permanently denying new work. Pending I/O is never
            // evicted, and zero-byte errors cannot help a bytes-only shortage.
            let removable = (0..4).find_map(|tier| {
                state.order.iter().position(|id| {
                    state.tickets.get(id).is_some_and(|entry| {
                        let priority = if entry.observed {
                            0
                        } else if matches!(&entry.result, Some(Ok(StoreReply::Status(_)))) {
                            1
                        } else if matches!(&entry.result, Some(Ok(StoreReply::Range { .. }))) {
                            2
                        } else {
                            3
                        };
                        eligible(entry) && priority == tier
                    })
                })
            });
            let Some(index) = removable else {
                return Err(StoreError::Busy);
            };
            let ticket = state.order[index];
            let entry = state
                .tickets
                .get_mut(&ticket)
                .ok_or(StoreError::Unavailable)?;
            if !count_full
                && !entry.observed
                && matches!(&entry.result, Some(Ok(StoreReply::Range { .. })))
            {
                // Preserve a small retry handoff after releasing plaintext.
                // Otherwise three stateless 1 MiB readers could evict each
                // other's completed bytes forever from the 2 MiB cache.
                entry.result = Some(Err(StoreError::Busy));
            } else {
                evict_ticket(&mut state, ticket);
            }
        }
        let ticket = state
            .next_ticket
            .checked_add(1)
            .ok_or(StoreError::Unavailable)?;
        self.sender
            .try_send(WorkerRequest::Store(ticket, operation.clone()))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => StoreError::Busy,
                mpsc::TrySendError::Disconnected(_) => StoreError::Unavailable,
            })?;
        state.next_ticket = ticket;
        state.operation_keys.insert(key.clone(), ticket);
        state.tickets.insert(
            ticket,
            TicketEntry {
                key,
                pending: Some(operation),
                completed_operation: None,
                result: None,
                observed: false,
            },
        );
        state.order.push_back(ticket);
        Ok(ticket)
    }

    fn try_result(&self, ticket: StoreTicket) -> Option<Result<StoreReply, StoreError>> {
        let mut state = self.published.try_lock().ok()?;
        let (result, released_key) = {
            let entry = state.tickets.get_mut(&ticket)?;
            let result = entry.result.clone()?;
            entry.observed = true;
            // Only a committed range is immutable across subsequent polls.
            // Mutations and errors get a single operation-key handoff, then
            // retry against current worker state (not a sticky Busy/Quota).
            let released_key = if matches!(result, Ok(StoreReply::Range { .. })) {
                None
            } else {
                entry.completed_operation = None;
                Some(entry.key.clone())
            };
            (result, released_key)
        };
        if let Some(key) = released_key {
            unlink_operation(&mut state, &key, ticket);
        }
        Some(match result {
            // A delayed Begin/Append ACK must not roll published progress back
            // after later Append, Finalize or Remove operations have finished.
            Ok(StoreReply::Status(status)) => state
                .objects
                .iter()
                .find(|current| current.spec.object_id == status.spec.object_id)
                .cloned()
                .map(StoreReply::Status)
                .ok_or(StoreError::Unavailable),
            Ok(StoreReply::Range {
                status,
                offset,
                bytes,
            }) => state
                .objects
                .iter()
                .find(|current| {
                    current.spec.object_id == status.spec.object_id && current.payload_available()
                })
                .cloned()
                .map(|status| StoreReply::Range {
                    status,
                    offset,
                    bytes,
                })
                .ok_or(StoreError::Unavailable),
            result => result,
        })
    }

    fn snapshot(&self) -> Vec<StoreObjectStatus> {
        self.try_snapshot().unwrap_or_default()
    }
}

fn entry_cache_bytes(entry: &TicketEntry) -> usize {
    if let Some(Ok(StoreReply::Range { bytes, .. })) = &entry.result {
        return bytes.len();
    }
    match entry
        .pending
        .as_ref()
        .or(entry.completed_operation.as_ref())
    {
        Some(StoreOperation::Append { bytes, .. }) => bytes.len(),
        Some(StoreOperation::ReadRange { length, .. }) if entry.result.is_none() => *length,
        _ => 0,
    }
}

fn operation_cache_bytes(state: &Published) -> usize {
    state.tickets.values().map(entry_cache_bytes).sum()
}

fn unlink_operation(state: &mut Published, key: &str, ticket: StoreTicket) {
    if state.operation_keys.get(key) == Some(&ticket) {
        state.operation_keys.remove(key);
    }
}

fn evict_ticket(state: &mut Published, ticket: StoreTicket) {
    if let Some(entry) = state.tickets.remove(&ticket) {
        unlink_operation(state, &entry.key, ticket);
    }
    state.order.retain(|id| *id != ticket);
}

fn invalidate_removed_ranges(state: &mut Published) {
    let invalid = state
        .tickets
        .iter()
        .filter_map(|(ticket, entry)| {
            let Some(Ok(StoreReply::Range { status, .. })) = &entry.result else {
                return None;
            };
            (!state.objects.iter().any(|current| {
                current.spec.object_id == status.spec.object_id && current.payload_available()
            }))
            .then_some(*ticket)
        })
        .collect::<Vec<_>>();
    for ticket in invalid {
        evict_ticket(state, ticket);
    }
}

fn operation_key(operation: &StoreOperation) -> String {
    match operation {
        StoreOperation::Begin(spec) => format!("begin/{}", spec.object_id),
        StoreOperation::Append {
            object_id,
            offset,
            bytes,
        } => format!("append/{object_id}/{offset}/{}", bytes.len()),
        StoreOperation::Finalize { object_id } => format!("final/{object_id}"),
        StoreOperation::MarkDelivered { object_id } => format!("delivered/{object_id}"),
        StoreOperation::MarkDownloaded { object_id, .. } => format!("downloaded/{object_id}"),
        StoreOperation::ReleaseDelivered { object_id } => format!("release-delivered/{object_id}"),
        StoreOperation::ReadRange {
            object_id,
            offset,
            length,
        } => format!("read/{object_id}/{offset}/{length}"),
        StoreOperation::Remove { object_id } => format!("remove/{object_id}"),
    }
}

fn same_operation(left: &StoreOperation, right: &StoreOperation) -> bool {
    match (left, right) {
        (StoreOperation::Begin(a), StoreOperation::Begin(b)) => a == b,
        (
            StoreOperation::Append {
                object_id: a,
                offset: ap,
                bytes: ab,
            },
            StoreOperation::Append {
                object_id: b,
                offset: bp,
                bytes: bb,
            },
        ) => a == b && ap == bp && ab == bb,
        (
            StoreOperation::MarkDownloaded {
                object_id: a,
                size_bytes: ab,
                sha256: ah,
            },
            StoreOperation::MarkDownloaded {
                object_id: b,
                size_bytes: bb,
                sha256: bh,
            },
        ) => a == b && ab == bb && ah == bh,
        _ => operation_key(left) == operation_key(right),
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_spec(spec: &StoreSpec) -> Result<(), StoreError> {
    if !valid_id(&spec.object_id)
        || !valid_id(&spec.profile_id)
        || !valid_id(&spec.message_id)
        || spec.friend_public_key.len() != 64
        || !spec
            .friend_public_key
            .bytes()
            .all(|v| v.is_ascii_hexdigit())
        || spec.name.len() > 4096
        || spec.mime.len() > 256
        || spec.size_bytes > FILE_LIMIT
        || spec
            .operation_id
            .as_ref()
            .is_some_and(|value| !valid_id(value))
        || (spec.direction == StoreDirection::Outgoing
            && (spec.operation_id.is_none() || spec.expected_sha256.is_none()))
    {
        return Err(StoreError::Range);
    }
    Ok(())
}

fn validate_operation(operation: &StoreOperation) -> Result<(), StoreError> {
    let id = match operation {
        StoreOperation::Begin(spec) => return validate_spec(spec),
        StoreOperation::Append {
            object_id,
            offset,
            bytes,
        } => {
            if bytes.is_empty()
                || bytes.len() > CHUNK_BYTES
                || offset.checked_add(bytes.len() as u64).is_none()
            {
                return Err(StoreError::Range);
            }
            object_id
        }
        StoreOperation::ReadRange {
            object_id,
            offset,
            length,
        } => {
            if *length == 0 || *length > CHUNK_BYTES || offset.checked_add(*length as u64).is_none()
            {
                return Err(StoreError::Range);
            }
            object_id
        }
        StoreOperation::Finalize { object_id }
        | StoreOperation::MarkDelivered { object_id }
        | StoreOperation::MarkDownloaded { object_id, .. }
        | StoreOperation::ReleaseDelivered { object_id }
        | StoreOperation::Remove { object_id } => object_id,
    };
    if !valid_id(id) {
        return Err(StoreError::Range);
    }
    Ok(())
}

struct Worker {
    root: PathBuf,
    cipher: WorkspacePayloadCipher,
    quota: Arc<TransferQuota>,
    objects: HashMap<String, Manifest>,
    charges: HashMap<String, u64>,
    write_failed: bool,
    removed_profiles: HashSet<String>,
}

impl Worker {
    fn load(
        workspace_root: PathBuf,
        cipher: WorkspacePayloadCipher,
        quota: Arc<TransferQuota>,
    ) -> Result<Self, StoreError> {
        let root = workspace_root.join(DIRECTORY);
        secure_directory(&workspace_root)?;
        secure_directory(&root)?;
        let mut worker = Self {
            root,
            cipher,
            quota,
            objects: HashMap::new(),
            charges: HashMap::new(),
            write_failed: false,
            removed_profiles: HashSet::new(),
        };
        for entry in fs::read_dir(&worker.root).map_err(|_| StoreError::Unavailable)? {
            let entry = entry.map_err(|_| StoreError::Unavailable)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| StoreError::Unavailable)?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| StoreError::Unavailable)?;
            if !valid_id(&name) || metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StoreError::Unavailable);
            }
            let index = entry.path().join("index.enc");
            if !index.is_file() {
                // Interrupted Begin can leave only its exact temporary index.
                for item in fs::read_dir(entry.path()).map_err(|_| StoreError::Unavailable)? {
                    let item = item.map_err(|_| StoreError::Unavailable)?;
                    if item.file_name() != "index.json.new"
                        || item
                            .file_type()
                            .map_err(|_| StoreError::Unavailable)?
                            .is_symlink()
                    {
                        return Err(StoreError::Unavailable);
                    }
                    fs::remove_file(item.path()).map_err(|_| StoreError::Unavailable)?;
                }
                fs::remove_dir(entry.path()).map_err(|_| StoreError::Unavailable)?;
                sync_directory(&worker.root).map_err(|_| StoreError::Unavailable)?;
                continue;
            }
            if fs::symlink_metadata(&index)
                .map_err(|_| StoreError::Unavailable)?
                .file_type()
                .is_symlink()
            {
                return Err(StoreError::Unavailable);
            }
            let blob = read_blob_file(&index).map_err(|_| StoreError::Unavailable)?;
            let mut plain = worker
                .cipher
                .open(&format!("{DIRECTORY}/{name}/index"), &blob)
                .map_err(|_| StoreError::Hash)?;
            let parsed =
                serde_json::from_slice::<Manifest>(&plain).map_err(|_| StoreError::Unavailable);
            plain.fill(0);
            let manifest = parsed?;
            validate_spec(&manifest.status.spec)?;
            if manifest.version != 1 || manifest.status.spec.object_id != name {
                return Err(StoreError::Conflict);
            }
            worker.validate_manifest(&manifest)?;
            worker.clean_uncommitted(&manifest)?;
            worker.charges.insert(name.clone(), manifest.charge()?);
            worker.objects.insert(name, manifest);
        }
        let total = worker.objects.values().try_fold(0_u64, |sum, manifest| {
            sum.checked_add(manifest.charge()?).ok_or(StoreError::Quota)
        })?;
        let payload = workspace_root.join("payload");
        let payload_bytes = if payload.exists() {
            payload_directory_bytes(&payload).map_err(|_| StoreError::Unavailable)?
        } else {
            0
        };
        let receipt_extra = worker.objects.values().try_fold(0_u64, |sum, manifest| {
            sum.checked_add(manifest.browser_receipt_extra_bytes.unwrap_or(0))
                .ok_or(StoreError::Quota)
        })?;
        worker
            .quota
            .restore_transfer(total, payload_bytes, receipt_extra)?;
        Ok(worker)
    }

    fn publish(&self, published: &Mutex<Published>) {
        if let Ok(mut state) = published.lock() {
            state.objects = self
                .objects
                .values()
                .map(|entry| entry.status.clone())
                .collect();
            state.ready = true;
        }
    }

    fn apply(&mut self, operation: StoreOperation) -> Result<StoreReply, StoreError> {
        if self.write_failed {
            return Err(StoreError::Unavailable);
        }
        match operation {
            StoreOperation::Begin(spec) => self.begin(spec),
            StoreOperation::Append {
                object_id,
                offset,
                bytes,
            } => self.append(&object_id, offset, &bytes),
            StoreOperation::Finalize { object_id } => self.finalize(&object_id),
            StoreOperation::MarkDelivered { object_id } => self.mark_delivered(&object_id),
            StoreOperation::MarkDownloaded {
                object_id,
                size_bytes,
                sha256,
            } => self.mark_downloaded(&object_id, size_bytes, sha256),
            StoreOperation::ReleaseDelivered { object_id } => self.release_delivered(&object_id),
            StoreOperation::ReadRange {
                object_id,
                offset,
                length,
            } => {
                let manifest = self
                    .objects
                    .get(&object_id)
                    .ok_or(StoreError::Unavailable)?;
                if manifest.status.phase != StorePhase::Committed {
                    return Err(StoreError::Busy);
                }
                if !manifest.status.payload_available() {
                    return Err(StoreError::Unavailable);
                }
                let bytes = self.read_range(manifest, offset, length)?;
                Ok(StoreReply::Range {
                    status: manifest.status.clone(),
                    offset,
                    bytes: bytes.into(),
                })
            }
            StoreOperation::Remove { object_id } => self.remove(&object_id),
        }
    }

    fn begin(&mut self, spec: StoreSpec) -> Result<StoreReply, StoreError> {
        validate_spec(&spec)?;
        if self.removed_profiles.contains(&spec.profile_id) {
            return Err(StoreError::Conflict);
        }
        if let Some(previous) = self.objects.get(&spec.object_id) {
            return if previous.status.spec == spec {
                Ok(StoreReply::Status(previous.status.clone()))
            } else {
                Err(StoreError::Conflict)
            };
        }
        if let Some(operation) = &spec.operation_id {
            if self.objects.values().any(|value| {
                value.status.spec.profile_id == spec.profile_id
                    && value.status.spec.operation_id.as_ref() == Some(operation)
            }) {
                return Err(StoreError::Conflict);
            }
        }
        let manifest = Manifest {
            version: 1,
            browser_receipt_extra_bytes: None,
            status: StoreObjectStatus {
                native_delivery_confirmed: (spec.direction == StoreDirection::Outgoing)
                    .then_some(false),
                browser_download_confirmed: (spec.direction == StoreDirection::Incoming)
                    .then_some(false),
                spec,
                durable_bytes: 0,
                phase: StorePhase::Staging,
                committed_sha256: None,
                payload_released: false,
            },
            chunks: vec![],
        };
        let charge = manifest.charge()?;
        self.quota.replace_transfer(0, charge)?;
        if let Err(error) = self.commit_manifest(&manifest) {
            // A directory-sync error can follow rename. Do not undo its charge
            // or discard bytes that the canonical index may already reference.
            self.write_failed = true;
            return Err(error);
        }
        let status = manifest.status.clone();
        self.objects.insert(status.spec.object_id.clone(), manifest);
        self.charges.insert(status.spec.object_id.clone(), charge);
        Ok(StoreReply::Status(status))
    }

    fn append(&mut self, id: &str, offset: u64, bytes: &[u8]) -> Result<StoreReply, StoreError> {
        let previous = self.objects.get(id).ok_or(StoreError::Unavailable)?.clone();
        if previous.status.delivery_confirmed() || previous.status.payload_released {
            return Err(StoreError::Unavailable);
        }
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or(StoreError::Range)?;
        if end <= previous.status.durable_bytes {
            let mut retained = self.read_range(&previous, offset, bytes.len())?;
            let matches = bool::from(retained.as_slice().ct_eq(bytes));
            retained.fill(0);
            return if matches {
                Ok(StoreReply::Status(previous.status))
            } else {
                Err(StoreError::Conflict)
            };
        }
        if previous.status.phase != StorePhase::Staging
            || offset != previous.status.durable_bytes
            || end > previous.status.spec.size_bytes
        {
            return Err(StoreError::Range);
        }
        let mut next = previous.clone();
        let mut tail = Vec::new();
        let mut frame_offset = offset;
        if let Some(chunk) = previous
            .chunks
            .last()
            .filter(|chunk| chunk.length < CHUNK_BYTES)
        {
            tail = self.read_chunk(&previous, chunk)?;
            frame_offset = chunk.offset;
            next.chunks.pop();
        }
        let mut changed_frames = Vec::new();
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let length = remaining.len().min(CHUNK_BYTES - tail.len());
            tail.extend_from_slice(&remaining[..length]);
            remaining = &remaining[length..];
            let chunk = Chunk {
                offset: frame_offset,
                length: tail.len(),
                sha256: Sha256::digest(&tail).into(),
            };
            let sealed = self
                .cipher
                .seal(&chunk_aad(&next.status.spec, &chunk), &tail);
            tail.fill(0);
            tail.clear();
            changed_frames.push((chunk.clone(), sealed.map_err(|_| StoreError::Unavailable)?));
            frame_offset += chunk.length as u64;
            next.chunks.push(chunk);
        }
        next.status.durable_bytes = end;
        let old_charge = self
            .charges
            .get(id)
            .copied()
            .ok_or(StoreError::Unavailable)?;
        let new_charge = next.charge()?;
        self.quota.replace_transfer(old_charge, new_charge)?;
        let written = (|| {
            for (chunk, blob) in changed_frames {
                write_blob_file(&self.chunk_path(id, &chunk), &blob)
                    .map_err(|_| StoreError::Unavailable)?;
            }
            self.commit_manifest(&next)
        })();
        if let Err(error) = written {
            // Keep both possible generations after an uncertain rename/fsync.
            // Recovery authenticates the index and removes only its orphan tail.
            self.write_failed = true;
            self.charges.insert(id.to_string(), new_charge);
            return Err(error);
        }
        let status = next.status.clone();
        self.objects.insert(id.to_string(), next);
        self.charges.insert(id.to_string(), new_charge);
        // Old partial frames remain valid until the new index is durable.
        // Remove only files excluded by that committed generation.
        if let Err(error) = self.clean_uncommitted(&self.objects[id]) {
            self.write_failed = true;
            return Err(error);
        }
        Ok(StoreReply::Status(status))
    }

    fn finalize(&mut self, id: &str) -> Result<StoreReply, StoreError> {
        let previous = self.objects.get(id).ok_or(StoreError::Unavailable)?.clone();
        if previous.status.phase == StorePhase::Committed {
            return Ok(StoreReply::Status(previous.status));
        }
        if previous.status.phase == StorePhase::Removed {
            return Err(StoreError::Range);
        }
        if previous.status.durable_bytes != previous.status.spec.size_bytes {
            return Err(StoreError::Range);
        }
        let digest = self.validate_manifest(&previous)?;
        if previous
            .status
            .spec
            .expected_sha256
            .is_some_and(|expected| !bool::from(expected.ct_eq(&digest)))
        {
            return Err(StoreError::Hash);
        }
        let mut next = previous.clone();
        next.status.phase = StorePhase::Committed;
        next.status.committed_sha256 = Some(digest);
        let old_charge = self
            .charges
            .get(id)
            .copied()
            .ok_or(StoreError::Unavailable)?;
        let new_charge = next.charge()?;
        self.quota.replace_transfer(old_charge, new_charge)?;
        if let Err(error) = self.commit_manifest(&next) {
            self.write_failed = true;
            return Err(error);
        }
        let status = next.status.clone();
        self.objects.insert(id.to_string(), next);
        self.charges.insert(id.to_string(), new_charge);
        Ok(StoreReply::Status(status))
    }

    fn mark_delivered(&mut self, id: &str) -> Result<StoreReply, StoreError> {
        let previous = self.objects.get(id).ok_or(StoreError::Unavailable)?.clone();
        if previous.status.spec.direction != StoreDirection::Outgoing
            || previous.status.phase != StorePhase::Committed
            || previous.status.durable_bytes != previous.status.spec.size_bytes
            || previous.status.committed_sha256.is_none()
        {
            return Err(StoreError::Conflict);
        }
        if previous.status.native_delivery_confirmed == Some(true) {
            return Ok(StoreReply::Status(previous.status));
        }
        let mut next = previous;
        next.status.native_delivery_confirmed = Some(true);
        let old_charge = self
            .charges
            .get(id)
            .copied()
            .ok_or(StoreError::Unavailable)?;
        let next_charge = next.charge()?;
        self.quota.replace_transfer(old_charge, next_charge)?;
        // New objects reserved this marker at Begin. A legacy upgrade may add
        // a small index charge; retain it after an ambiguous rename/fsync error.
        self.charges.insert(id.to_string(), next_charge);
        // Only metadata changes. A failed attempt keeps the last published
        // status and can safely rewrite the same monotonic marker on retry,
        // even if rename succeeded before directory sync failed.
        self.commit_manifest(&next)?;
        let status = next.status.clone();
        self.objects.insert(id.to_string(), next);
        Ok(StoreReply::Status(status))
    }

    fn mark_downloaded(
        &mut self,
        id: &str,
        size_bytes: u64,
        sha256: [u8; 32],
    ) -> Result<StoreReply, StoreError> {
        let previous = self.objects.get(id).ok_or(StoreError::Unavailable)?.clone();
        if previous.status.spec.direction != StoreDirection::Incoming
            || previous.status.phase != StorePhase::Committed
            || !previous.status.delivery_receipts_valid()
            || previous.status.durable_bytes != previous.status.spec.size_bytes
            || size_bytes != previous.status.spec.size_bytes
        {
            return Err(StoreError::Conflict);
        }
        if previous
            .status
            .committed_sha256
            .is_none_or(|hash| !bool::from(hash.ct_eq(&sha256)))
        {
            return Err(StoreError::Hash);
        }
        if previous.status.browser_download_confirmed == Some(true) {
            return Ok(StoreReply::Status(previous.status));
        }
        let legacy_charge = previous
            .status
            .browser_download_confirmed
            .is_none()
            .then(|| previous.charge())
            .transpose()?;
        let mut next = previous;
        next.status.browser_download_confirmed = Some(true);
        let old_charge = self
            .charges
            .get(id)
            .copied()
            .ok_or(StoreError::Unavailable)?;
        if let Some(legacy_charge) = legacy_charge {
            // The receipt also records its exact allowance, so recovery never
            // grants headroom to a modern/pre-reserved or fabricated receipt.
            next.browser_receipt_extra_bytes = Some(0);
            for _ in 0..3 {
                next.browser_receipt_extra_bytes = Some(
                    next.charge()?
                        .checked_sub(legacy_charge)
                        .ok_or(StoreError::Quota)?,
                );
            }
            let next_charge = next.charge()?;
            let extra = next.browser_receipt_extra_bytes.ok_or(StoreError::Quota)?;
            if next_charge.checked_sub(legacy_charge) != Some(extra)
                || (old_charge != legacy_charge && old_charge != next_charge)
            {
                return Err(StoreError::Quota);
            }
            self.quota
                .reserve_legacy_browser_receipt(old_charge, next_charge, extra)?;
        } else {
            self.quota.replace_transfer(old_charge, next.charge()?)?;
        }
        let next_charge = next.charge()?;
        self.charges.insert(id.to_string(), next_charge);
        // Publish success only after the exact browser receipt is durable.
        // An uncertain index write is safe to retry without deleting payload.
        self.commit_manifest(&next)?;
        let status = next.status.clone();
        self.objects.insert(id.to_string(), next);
        Ok(StoreReply::Status(status))
    }

    fn read_range(
        &self,
        manifest: &Manifest,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, StoreError> {
        if manifest.status.delivery_confirmed() || manifest.status.payload_released {
            return Err(StoreError::Unavailable);
        }
        let end = offset
            .checked_add(length as u64)
            .filter(|end| *end <= manifest.status.durable_bytes)
            .ok_or(StoreError::Range)?;
        let mut result = Vec::with_capacity(length);
        for chunk in &manifest.chunks {
            let chunk_end = chunk.offset + chunk.length as u64;
            if chunk_end <= offset || chunk.offset >= end {
                continue;
            }
            let mut bytes = self.read_chunk(manifest, chunk)?;
            let start = offset.saturating_sub(chunk.offset) as usize;
            let finish = (end.min(chunk_end) - chunk.offset) as usize;
            result.extend_from_slice(&bytes[start..finish]);
            bytes.fill(0);
        }
        if result.len() != length {
            result.fill(0);
            return Err(StoreError::Hash);
        }
        Ok(result)
    }

    fn read_chunk(&self, manifest: &Manifest, chunk: &Chunk) -> Result<Vec<u8>, StoreError> {
        let path = self.chunk_path(&manifest.status.spec.object_id, chunk);
        let metadata = fs::symlink_metadata(&path).map_err(|_| StoreError::Unavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StoreError::Unavailable);
        }
        let blob = read_blob_file(&path).map_err(|_| StoreError::Hash)?;
        let mut bytes = self
            .cipher
            .open(&chunk_aad(&manifest.status.spec, chunk), &blob)
            .map_err(|_| StoreError::Hash)?;
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        if bytes.len() != chunk.length || !bool::from(chunk.sha256.ct_eq(&digest)) {
            bytes.fill(0);
            return Err(StoreError::Hash);
        }
        Ok(bytes)
    }

    fn validate_manifest(&self, manifest: &Manifest) -> Result<[u8; 32], StoreError> {
        if !manifest.status.delivery_receipts_valid()
            || (manifest.status.payload_released && !manifest.chunks.is_empty())
        {
            return Err(StoreError::Conflict);
        }
        if let Some(extra) = manifest.browser_receipt_extra_bytes {
            if extra == 0
                || extra > 128
                || manifest.status.payload_released
                || manifest.status.spec.direction != StoreDirection::Incoming
                || manifest.status.browser_download_confirmed != Some(true)
            {
                return Err(StoreError::Conflict);
            }
            let mut legacy = manifest.clone();
            legacy.status.browser_download_confirmed = None;
            legacy.browser_receipt_extra_bytes = None;
            if manifest.charge()?.checked_sub(legacy.charge()?) != Some(extra) {
                return Err(StoreError::Conflict);
            }
        }
        let delivered = manifest.status.delivery_confirmed();
        if manifest.status.phase == StorePhase::Committed
            && (manifest.status.durable_bytes != manifest.status.spec.size_bytes
                || manifest.status.committed_sha256.is_none()
                || manifest
                    .status
                    .spec
                    .expected_sha256
                    .is_some_and(|hash| Some(hash) != manifest.status.committed_sha256))
        {
            return Err(StoreError::Hash);
        }
        let mut position = 0_u64;
        let mut digest = Sha256::new();
        for chunk in &manifest.chunks {
            if chunk.offset != position || chunk.length == 0 || chunk.length > CHUNK_BYTES {
                return Err(StoreError::Range);
            }
            position = position
                .checked_add(chunk.length as u64)
                .ok_or(StoreError::Range)?;
            if position > manifest.status.spec.size_bytes {
                return Err(StoreError::Range);
            }
            if !delivered {
                let mut bytes = self.read_chunk(manifest, chunk)?;
                digest.update(&bytes);
                bytes.fill(0);
            }
        }
        if !manifest.status.payload_released && position != manifest.status.durable_bytes {
            return Err(StoreError::Range);
        }
        // Only an authenticated committed endpoint receipt authorizes payload
        // removal. Its manifest still has to prove the exact size/hash/chunk
        // structure, but a crash may have removed any subset of those chunks.
        // Other objects continue to authenticate every byte before recovery.
        if delivered {
            return manifest.status.committed_sha256.ok_or(StoreError::Hash);
        }
        let hash: [u8; 32] = digest.finalize().into();
        if manifest.status.phase == StorePhase::Committed
            && (position != manifest.status.spec.size_bytes
                || manifest
                    .status
                    .committed_sha256
                    .is_none_or(|expected| !bool::from(expected.ct_eq(&hash))))
        {
            return Err(StoreError::Hash);
        }
        Ok(hash)
    }

    fn commit_manifest(&self, manifest: &Manifest) -> Result<(), StoreError> {
        let root = self.root.join(&manifest.status.spec.object_id);
        secure_directory(&root)?;
        let mut plain = serde_json::to_vec(manifest).map_err(|_| StoreError::Unavailable)?;
        if plain.len() > CHUNK_BYTES {
            plain.fill(0);
            return Err(StoreError::Quota);
        }
        let sealed = self.cipher.seal(
            &format!("{DIRECTORY}/{}/index", manifest.status.spec.object_id),
            &plain,
        );
        plain.fill(0);
        write_blob_file(
            &root.join("index.enc"),
            &sealed.map_err(|_| StoreError::Unavailable)?,
        )
        .map_err(|_| StoreError::Unavailable)
    }

    fn chunk_path(&self, id: &str, chunk: &Chunk) -> PathBuf {
        self.root
            .join(id)
            .join(format!("{:016x}-{:08x}.enc", chunk.offset, chunk.length))
    }

    fn remove(&mut self, id: &str) -> Result<StoreReply, StoreError> {
        let previous = self.objects.get(id).ok_or(StoreError::Unavailable)?.clone();
        let mut next = previous.clone();
        next.status.phase = StorePhase::Removed;
        next.status.durable_bytes = 0;
        next.status.committed_sha256 = None;
        next.status.native_delivery_confirmed =
            next.status.native_delivery_confirmed.map(|_| false);
        next.status.browser_download_confirmed =
            next.status.browser_download_confirmed.map(|_| false);
        next.status.payload_released = false;
        next.browser_receipt_extra_bytes = None;
        next.chunks.clear();
        if let Err(error) = self.commit_manifest(&next) {
            self.write_failed = true;
            return Err(error);
        }
        // Durable tombstone precedes deletion: replaying a cancelled operation
        // cannot resurrect a second outgoing offer after a crash.
        self.objects.insert(id.to_string(), next.clone());
        self.clean_uncommitted(&next)?;
        let old_charge = self
            .charges
            .get(id)
            .copied()
            .ok_or(StoreError::Unavailable)?;
        let next_charge = next.charge()?;
        self.quota.replace_transfer(old_charge, next_charge)?;
        self.charges.insert(id.to_string(), next_charge);
        Ok(StoreReply::Status(next.status))
    }

    fn release_delivered(&mut self, id: &str) -> Result<StoreReply, StoreError> {
        let previous = self.objects.get(id).ok_or(StoreError::Unavailable)?.clone();
        if !previous.status.delivery_confirmed()
            || !previous.status.delivery_receipts_valid()
            || previous.status.durable_bytes != previous.status.spec.size_bytes
            || previous.status.committed_sha256.is_none()
        {
            return Err(StoreError::Conflict);
        }
        if previous.status.payload_released {
            return Ok(StoreReply::Status(previous.status));
        }
        let mut next = previous;
        next.status.payload_released = true;
        next.browser_receipt_extra_bytes = None;
        next.chunks.clear();
        // The already durable delivery receipt permits an interrupted deletion.
        // Do not release quota until every payload file is actually gone and
        // the small retained receipt has crossed its own durable boundary.
        self.clean_uncommitted(&next)?;
        self.commit_manifest(&next)?;
        let old_charge = self
            .charges
            .get(id)
            .copied()
            .ok_or(StoreError::Unavailable)?;
        let next_charge = next.charge()?;
        self.quota.replace_transfer(old_charge, next_charge)?;
        self.charges.insert(id.to_string(), next_charge);
        self.objects.insert(id.to_string(), next.clone());
        Ok(StoreReply::Status(next.status))
    }

    fn retain_profiles(&mut self, profiles: &HashSet<String>) -> Result<(), StoreError> {
        let removed = self
            .objects
            .values()
            .filter(|entry| !profiles.contains(&entry.status.spec.profile_id))
            .map(|entry| entry.status.spec.profile_id.clone())
            .collect::<HashSet<_>>();
        for profile in removed {
            self.remove_profile(&profile)?;
        }
        Ok(())
    }

    fn remove_profile(&mut self, profile_id: &str) -> Result<(), StoreError> {
        if self.write_failed {
            return Err(StoreError::Unavailable);
        }
        self.removed_profiles.insert(profile_id.to_string());
        let objects = self
            .objects
            .values()
            .filter(|entry| {
                entry.status.spec.profile_id == profile_id
                    && entry.status.phase != StorePhase::Removed
            })
            .map(|entry| entry.status.spec.object_id.clone())
            .collect::<Vec<_>>();
        for object in objects {
            self.remove(&object)?;
        }
        Ok(())
    }

    fn clean_uncommitted(&self, manifest: &Manifest) -> Result<(), StoreError> {
        let root = self.root.join(&manifest.status.spec.object_id);
        let retained = manifest
            .chunks
            .iter()
            .map(|chunk| self.chunk_path(&manifest.status.spec.object_id, chunk))
            .collect::<Vec<_>>();
        for entry in fs::read_dir(&root).map_err(|_| StoreError::Unavailable)? {
            let entry = entry.map_err(|_| StoreError::Unavailable)?;
            let metadata = entry.file_type().map_err(|_| StoreError::Unavailable)?;
            if metadata.is_symlink() || !metadata.is_file() {
                return Err(StoreError::Unavailable);
            }
            if entry.file_name() == "index.enc" || retained.contains(&entry.path()) {
                continue;
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| StoreError::Unavailable)?;
            let generated = name == "index.json.new"
                || name
                    .strip_suffix(".enc")
                    .or_else(|| name.strip_suffix(".json.new"))
                    .is_some_and(|stem| {
                        stem.len() == 25
                            && stem.as_bytes()[16] == b'-'
                            && stem
                                .bytes()
                                .enumerate()
                                .all(|(index, value)| index == 16 || value.is_ascii_hexdigit())
                    });
            if !generated {
                return Err(StoreError::Unavailable);
            }
            fs::remove_file(entry.path()).map_err(|_| StoreError::Unavailable)?;
        }
        sync_directory(&root).map_err(|_| StoreError::Unavailable)
    }
}

/// Called only in the existing blocking import preparation, after the archived
/// identifier and vault identity have been checked. No ciphertext is relabelled.
pub(crate) fn validate_restored(
    workspace_root: &Path,
    cipher: WorkspacePayloadCipher,
    user_limit: u64,
) -> Result<u64, String> {
    if !workspace_root.join(DIRECTORY).exists() {
        return Ok(0);
    }
    let quota = TransferQuota::new(user_limit, 0);
    let worker = Worker::load(workspace_root.to_path_buf(), cipher, Arc::clone(&quota))
        .map_err(|error| error.code().to_string())?;
    let charge = quota.transfer_bytes();
    drop(worker);
    Ok(charge)
}

fn secure_directory(path: &Path) -> Result<(), StoreError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(StoreError::Unavailable);
        }
    }
    prepare_root(path).map_err(|_| StoreError::Unavailable)
}

fn chunk_aad(spec: &StoreSpec, chunk: &Chunk) -> String {
    format!(
        "{DIRECTORY}/{}/{}/{}/{}/{}/{}/{}",
        spec.profile_id,
        spec.object_id,
        spec.message_id,
        spec.friend_public_key,
        match spec.direction {
            StoreDirection::Incoming => "incoming",
            StoreDirection::Outgoing => "outgoing",
        },
        chunk.offset,
        chunk.length
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_app_lib::web_core::WorkspaceVault;

    fn fixture(label: &str, bytes: &[u8]) -> (PathBuf, WorkspaceVault, StoreSpec) {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "kaigen-transfer-store-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let vault = WorkspaceVault::create([0x35; 32], "disposable store password").unwrap();
        let spec = StoreSpec {
            object_id: "transferA".into(),
            operation_id: Some("operationA".into()),
            profile_id: "profileA".into(),
            message_id: "messageA".into(),
            friend_public_key: "AB".repeat(32),
            direction: StoreDirection::Outgoing,
            name: "private-attachment.bin".into(),
            mime: "application/octet-stream".into(),
            size_bytes: bytes.len() as u64,
            expected_sha256: Some(Sha256::digest(bytes).into()),
        };
        (root, vault, spec)
    }

    fn worker(root: &Path, vault: &WorkspaceVault) -> Worker {
        Worker::load(
            root.to_path_buf(),
            vault.payload_cipher().unwrap(),
            TransferQuota::new(64 * 1024 * 1024, 0),
        )
        .unwrap()
    }

    fn with_delivery_fixture(
        label: &str,
        bytes: &[u8],
        exercise: impl FnOnce(&Path, &WorkspaceVault, &StoreSpec),
    ) {
        let (root, vault, spec) = fixture(label, bytes);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            exercise(&root, &vault, &spec);
        }));
        fs::remove_dir_all(root).unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    fn endpoint_spec(spec: &StoreSpec, direction: StoreDirection) -> StoreSpec {
        let mut spec = spec.clone();
        spec.direction = direction;
        if direction == StoreDirection::Incoming {
            spec.operation_id = None;
            spec.expected_sha256 = None;
        }
        spec
    }

    fn endpoint_receipt(spec: &StoreSpec, bytes: &[u8]) -> StoreOperation {
        match spec.direction {
            StoreDirection::Outgoing => StoreOperation::MarkDelivered {
                object_id: spec.object_id.clone(),
            },
            StoreDirection::Incoming => StoreOperation::MarkDownloaded {
                object_id: spec.object_id.clone(),
                size_bytes: bytes.len() as u64,
                sha256: Sha256::digest(bytes).into(),
            },
        }
    }

    #[test]
    fn native_delivery_committed_marker_survives_reload_without_history() {
        let bytes = b"synthetic retained native delivery payload";
        with_delivery_fixture("native-delivery-reload", bytes, |root, vault, spec| {
            let mut store = worker(root, vault);
            store.begin(spec.clone()).unwrap();
            assert_eq!(
                store.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                Some(false)
            );
            store.append(&spec.object_id, 0, bytes).unwrap();
            store.finalize(&spec.object_id).unwrap();
            assert_eq!(
                store.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                Some(false)
            );
            let confirmed = store.mark_delivered(&spec.object_id).unwrap();
            assert!(matches!(confirmed, StoreReply::Status(status)
                if status.native_delivery_confirmed == Some(true)));
            let index = root.join(DIRECTORY).join(&spec.object_id).join("index.enc");
            let committed = fs::read(&index).unwrap();
            store.mark_delivered(&spec.object_id).unwrap();
            assert_eq!(
                fs::read(&index).unwrap(),
                committed,
                "duplicate ACK rewrote ciphertext"
            );
            for private in [
                bytes.as_slice(),
                spec.name.as_bytes(),
                b"nativeDeliveryConfirmed".as_slice(),
            ] {
                assert!(!committed
                    .windows(private.len())
                    .any(|window| window == private));
            }
            assert!(
                !root.join("profiles").exists(),
                "delivery must not create chat history"
            );
            drop(store);
            let restored = worker(root, vault);
            let object = &restored.objects[&spec.object_id];
            assert_eq!(object.status.native_delivery_confirmed, Some(true));
            assert_eq!(object.status.phase, StorePhase::Committed);
            assert_eq!(
                restored.read_range(object, 0, bytes.len()).unwrap_err(),
                StoreError::Unavailable
            );
            assert!(!object.status.payload_released);
        });
    }

    #[test]
    fn native_delivery_legacy_absence_keeps_existing_quota_and_roundtrips() {
        let bytes = b"legacy retained payload";
        with_delivery_fixture("native-delivery-legacy", bytes, |root, vault, spec| {
            let mut store = worker(root, vault);
            store.begin(spec.clone()).unwrap();
            store.append(&spec.object_id, 0, bytes).unwrap();
            store.finalize(&spec.object_id).unwrap();
            let mut legacy = store.objects[&spec.object_id].clone();
            legacy.status.native_delivery_confirmed = None;
            let encoded = serde_json::to_vec(&legacy).unwrap();
            assert!(!String::from_utf8_lossy(&encoded).contains("nativeDeliveryConfirmed"));
            let decoded: Manifest = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(decoded.status.native_delivery_confirmed, None);
            assert_eq!(serde_json::to_vec(&decoded).unwrap(), encoded);
            store.commit_manifest(&legacy).unwrap();
            let legacy_charge = legacy.charge().unwrap();
            drop(store);
            let quota = TransferQuota::new(legacy_charge, 0);
            let mut restored = Worker::load(
                root.to_path_buf(),
                vault.payload_cipher().unwrap(),
                Arc::clone(&quota),
            )
            .unwrap();
            assert_eq!(
                restored.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                None
            );
            assert_eq!(quota.transfer_bytes(), legacy_charge);
            assert!(matches!(
                restored.mark_delivered(&spec.object_id),
                Err(StoreError::Quota)
            ));
            assert_eq!(
                restored.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                None
            );
            assert_eq!(
                restored
                    .read_range(&restored.objects[&spec.object_id], 0, bytes.len())
                    .unwrap(),
                bytes
            );
            drop(restored);
            let mut upgraded = worker(root, vault);
            upgraded.mark_delivered(&spec.object_id).unwrap();
            assert_eq!(
                upgraded.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                Some(true)
            );
        });
    }

    #[test]
    fn native_delivery_initial_reservation_covers_terminal_index_at_full_quota() {
        let bytes = vec![0x4d; CHUNK_BYTES + 1373];
        with_delivery_fixture("native-delivery-quota", &bytes, |root, vault, spec| {
            let initial = Manifest {
                version: 1,
                browser_receipt_extra_bytes: None,
                status: StoreObjectStatus {
                    spec: spec.clone(),
                    durable_bytes: 0,
                    phase: StorePhase::Staging,
                    committed_sha256: None,
                    native_delivery_confirmed: Some(false),
                    browser_download_confirmed: None,
                    payload_released: false,
                },
                chunks: Vec::new(),
            };
            let reserved = initial.charge().unwrap();
            let quota = TransferQuota::new(reserved, 0);
            let mut store = Worker::load(
                root.to_path_buf(),
                vault.payload_cipher().unwrap(),
                Arc::clone(&quota),
            )
            .unwrap();
            store.begin(spec.clone()).unwrap();
            for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
                store
                    .append(&spec.object_id, (index * CHUNK_BYTES) as u64, chunk)
                    .unwrap();
            }
            store.finalize(&spec.object_id).unwrap();
            assert!(quota.reserve_payload(1).is_err());
            store.mark_delivered(&spec.object_id).unwrap();
            assert_eq!(quota.transfer_bytes(), reserved);
            assert_eq!(store.objects[&spec.object_id].charge().unwrap(), reserved);
            assert_eq!(
                store.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                Some(true)
            );
            drop(store);
            let restored = Worker::load(
                root.to_path_buf(),
                vault.payload_cipher().unwrap(),
                TransferQuota::new(reserved, 0),
            )
            .unwrap();
            assert_eq!(
                restored.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                Some(true)
            );
        });
    }

    #[test]
    fn native_delivery_failed_index_write_retries_and_invalidates_cached_range() {
        let bytes = b"payload remains readable across failed native ACK commit";
        for direction in [StoreDirection::Outgoing, StoreDirection::Incoming] {
            let (root, vault, spec) = fixture("native-delivery-retry", bytes);
            let spec = endpoint_spec(&spec, direction);
            let object_root = root.join(DIRECTORY).join(&spec.object_id);
            with_test_store(
                root,
                &vault,
                TransferQuota::new(64 * 1024 * 1024, 0),
                HashSet::from([spec.profile_id.clone()]),
                |store| {
                    publish_operation(store, StoreOperation::Begin(spec.clone()));
                    publish_operation(
                        store,
                        StoreOperation::Append {
                            object_id: spec.object_id.clone(),
                            offset: 0,
                            bytes: Arc::from(bytes.as_slice()),
                        },
                    );
                    publish_operation(
                        store,
                        StoreOperation::Finalize {
                            object_id: spec.object_id.clone(),
                        },
                    );
                    let range = StoreOperation::ReadRange {
                        object_id: spec.object_id.clone(),
                        offset: 0,
                        length: bytes.len(),
                    };
                    let read = publish_operation(store, range.clone());
                    assert!(
                        matches!(store.try_result(read), Some(Ok(StoreReply::Range { status, .. })) if !status.delivery_confirmed())
                    );
                    let index_before = fs::read(object_root.join("index.enc")).unwrap();
                    let blocked = object_root.join("index.json.new");
                    fs::create_dir(&blocked).unwrap();
                    let operation = endpoint_receipt(&spec, bytes);
                    let failed = publish_operation(store, operation.clone());
                    assert_eq!(
                        store.try_result(failed).unwrap().unwrap_err(),
                        StoreError::Unavailable
                    );
                    assert_eq!(
                        fs::read(object_root.join("index.enc")).unwrap(),
                        index_before
                    );
                    assert!(!store.try_snapshot().unwrap()[0].delivery_confirmed());
                    assert!(
                        matches!(store.try_result(read), Some(Ok(StoreReply::Range { bytes: retained, .. })) if retained.as_ref() == bytes)
                    );
                    fs::remove_dir(&blocked).unwrap();
                    let retried = publish_operation(store, operation.clone());
                    assert_ne!(failed, retried);
                    assert_eq!(
                        store.try_submit(operation).unwrap(),
                        retried,
                        "completed marker lost its delayed-poll handoff"
                    );
                    assert!(
                        matches!(store.try_result(retried), Some(Ok(StoreReply::Status(status))) if status.delivery_confirmed())
                    );
                    assert!(
                        store.try_result(read).is_none(),
                        "a cached range survived durable delivery"
                    );
                    let unavailable = publish_operation(store, range.clone());
                    assert_eq!(
                        store.try_result(unavailable).unwrap().unwrap_err(),
                        StoreError::Unavailable
                    );
                    let released = publish_operation(
                        store,
                        StoreOperation::ReleaseDelivered {
                            object_id: spec.object_id.clone(),
                        },
                    );
                    assert!(
                        matches!(store.try_result(released), Some(Ok(StoreReply::Status(status)))
                    if status.payload_released && status.delivery_confirmed())
                    );
                    assert_eq!(fs::read_dir(&object_root).unwrap().count(), 1);
                    let unavailable = publish_operation(store, range);
                    assert_eq!(
                        store.try_result(unavailable).unwrap().unwrap_err(),
                        StoreError::Unavailable
                    );
                },
            );
        }
    }

    #[test]
    fn native_delivery_rejects_staging_incoming_and_removed_objects() {
        let bytes = b"only native delivered outgoing objects may be confirmed";
        with_delivery_fixture("native-delivery-guards", bytes, |root, vault, spec| {
            let mut store = worker(root, vault);
            assert!(matches!(
                store.mark_delivered("missing"),
                Err(StoreError::Unavailable)
            ));
            store.begin(spec.clone()).unwrap();
            assert!(matches!(
                store.mark_delivered(&spec.object_id),
                Err(StoreError::Conflict)
            ));
            store.append(&spec.object_id, 0, bytes).unwrap();
            store.finalize(&spec.object_id).unwrap();
            let mut incoming = spec.clone();
            incoming.object_id = "incoming".into();
            incoming.message_id = "incomingMessage".into();
            incoming.operation_id = None;
            incoming.direction = StoreDirection::Incoming;
            store.begin(incoming.clone()).unwrap();
            store.append(&incoming.object_id, 0, bytes).unwrap();
            store.finalize(&incoming.object_id).unwrap();
            assert_eq!(
                store.objects[&incoming.object_id]
                    .status
                    .native_delivery_confirmed,
                None
            );
            assert!(matches!(
                store.mark_delivered(&incoming.object_id),
                Err(StoreError::Conflict)
            ));
            store.mark_delivered(&spec.object_id).unwrap();
            store.remove(&spec.object_id).unwrap();
            assert!(matches!(
                store.mark_delivered(&spec.object_id),
                Err(StoreError::Conflict)
            ));
            assert_eq!(
                store.objects[&spec.object_id]
                    .status
                    .native_delivery_confirmed,
                Some(false)
            );
            drop(store);
            let restored = worker(root, vault);
            assert_eq!(
                restored.objects[&spec.object_id].status.phase,
                StorePhase::Removed
            );
            assert_eq!(
                restored
                    .read_range(&restored.objects[&incoming.object_id], 0, bytes.len())
                    .unwrap(),
                bytes
            );
        });
    }

    #[test]
    fn native_delivery_profile_removal_dominates_delayed_ack_and_preserves_neighbour() {
        let bytes = b"retained neighbour profile payload";
        let (root, vault, spec) = fixture("native-delivery-remove", bytes);
        let mut neighbour = spec.clone();
        neighbour.object_id = "neighbour".into();
        neighbour.profile_id = "profileB".into();
        neighbour.message_id = "messageB".into();
        with_test_store(
            root,
            &vault,
            TransferQuota::new(64 * 1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone(), neighbour.profile_id.clone()]),
            |store| {
                for object in [&spec, &neighbour] {
                    publish_operation(store, StoreOperation::Begin(object.clone()));
                    publish_operation(
                        store,
                        StoreOperation::Append {
                            object_id: object.object_id.clone(),
                            offset: 0,
                            bytes: Arc::from(bytes.as_slice()),
                        },
                    );
                    publish_operation(
                        store,
                        StoreOperation::Finalize {
                            object_id: object.object_id.clone(),
                        },
                    );
                }
                let operation = StoreOperation::MarkDelivered {
                    object_id: spec.object_id.clone(),
                };
                let completed = store.try_submit(operation.clone()).unwrap();
                store.try_remove_profile(&spec.profile_id).unwrap();
                wait_for_published(store, |state| {
                    state
                        .profile_removals
                        .get(&spec.profile_id)
                        .is_some_and(|entry| matches!(entry.result, Some(Ok(()))))
                });
                assert!(
                    matches!(store.try_result(completed), Some(Ok(StoreReply::Status(status))) if status.phase == StorePhase::Removed && status.native_delivery_confirmed == Some(false))
                );
                let late = publish_operation(store, operation);
                assert_eq!(
                    store.try_result(late).unwrap().unwrap_err(),
                    StoreError::Conflict
                );
                let read = publish_operation(
                    store,
                    StoreOperation::ReadRange {
                        object_id: neighbour.object_id.clone(),
                        offset: 0,
                        length: bytes.len(),
                    },
                );
                assert!(
                    matches!(store.try_result(read), Some(Ok(StoreReply::Range { status, bytes: retained, .. })) if status.phase == StorePhase::Committed && status.native_delivery_confirmed == Some(false) && retained.as_ref() == bytes)
                );
            },
        );
    }

    #[test]
    fn native_delivery_recovery_rejects_inconsistent_authenticated_metadata() {
        let bytes = b"authenticated delivery metadata must obey lifecycle";
        with_delivery_fixture("native-delivery-invalid", bytes, |root, vault, spec| {
            let mut store = worker(root, vault);
            store.begin(spec.clone()).unwrap();
            store.append(&spec.object_id, 0, bytes).unwrap();
            store.finalize(&spec.object_id).unwrap();
            let valid = store.objects[&spec.object_id].clone();
            for (direction, phase, marker) in [
                (StoreDirection::Outgoing, StorePhase::Staging, Some(true)),
                (StoreDirection::Outgoing, StorePhase::Removed, Some(true)),
                (StoreDirection::Incoming, StorePhase::Committed, Some(false)),
                (StoreDirection::Incoming, StorePhase::Committed, Some(true)),
            ] {
                let mut invalid = valid.clone();
                invalid.status.spec.direction = direction;
                invalid.status.phase = phase;
                invalid.status.native_delivery_confirmed = marker;
                store.commit_manifest(&invalid).unwrap();
                assert!(matches!(
                    Worker::load(
                        root.to_path_buf(),
                        vault.payload_cipher().unwrap(),
                        TransferQuota::new(64 * 1024 * 1024, 0)
                    ),
                    Err(StoreError::Conflict)
                ));
            }
        });
    }

    #[test]
    fn delivered_payload_release_retries_partial_deletion_and_frees_only_removed_bytes() {
        let bytes = vec![0x6d; CHUNK_BYTES * 2 + 19];
        for direction in [StoreDirection::Outgoing, StoreDirection::Incoming] {
            with_delivery_fixture("delivered-release-retry", &bytes, |root, vault, spec| {
                let spec = endpoint_spec(spec, direction);
                let mut store = worker(root, vault);
                store.begin(spec.clone()).unwrap();
                for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
                    store
                        .append(&spec.object_id, (index * CHUNK_BYTES) as u64, chunk)
                        .unwrap();
                }
                store.finalize(&spec.object_id).unwrap();
                assert!(matches!(
                    store.release_delivered(&spec.object_id),
                    Err(StoreError::Conflict)
                ));
                store.apply(endpoint_receipt(&spec, &bytes)).unwrap();
                let before = store.objects[&spec.object_id].clone();
                let charged = store.quota.transfer_bytes();
                let index = root.join(DIRECTORY).join(&spec.object_id).join("index.enc");
                let receipt = fs::read(&index).unwrap();
                // Model an interrupted sweep, then an actual filesystem deletion
                // failure on the next generated chunk path.
                fs::remove_file(store.chunk_path(&spec.object_id, &before.chunks[0])).unwrap();
                let blocked = store.chunk_path(&spec.object_id, &before.chunks[1]);
                fs::remove_file(&blocked).unwrap();
                fs::create_dir(&blocked).unwrap();
                assert!(matches!(
                    store.release_delivered(&spec.object_id),
                    Err(StoreError::Unavailable)
                ));
                assert_eq!(store.quota.transfer_bytes(), charged);
                assert_eq!(fs::read(&index).unwrap(), receipt);
                assert_eq!(store.objects[&spec.object_id].status, before.status);
                assert!(
                    !store.write_failed,
                    "a retryable cleanup failure stopped the worker"
                );
                fs::remove_dir(&blocked).unwrap();
                let released = store.release_delivered(&spec.object_id).unwrap();
                let StoreReply::Status(status) = released else {
                    panic!("missing release status")
                };
                assert!(status.payload_released && !status.payload_available());
                assert_eq!(status.spec, before.status.spec);
                assert!(status.delivery_confirmed() && status.delivery_receipts_valid());
                assert_eq!(status.phase, StorePhase::Committed);
                assert_eq!(status.durable_bytes, bytes.len() as u64);
                assert_eq!(status.committed_sha256, before.status.committed_sha256);
                assert_eq!(
                    store.quota.transfer_bytes(),
                    store.objects[&spec.object_id].charge().unwrap()
                );
                assert!(charged - store.quota.transfer_bytes() >= bytes.len() as u64);
                assert_eq!(fs::read_dir(index.parent().unwrap()).unwrap().count(), 1);
                let final_receipt = fs::read(&index).unwrap();
                for operation in [
                    StoreOperation::Begin(spec.clone()),
                    StoreOperation::Finalize {
                        object_id: spec.object_id.clone(),
                    },
                    endpoint_receipt(&spec, &bytes),
                    StoreOperation::ReleaseDelivered {
                        object_id: spec.object_id.clone(),
                    },
                ] {
                    assert!(
                        matches!(store.apply(operation), Ok(StoreReply::Status(current)) if current == status)
                    );
                    assert_eq!(
                        fs::read(&index).unwrap(),
                        final_receipt,
                        "replay rewrote or resurrected the payload"
                    );
                }
                let charge = store.quota.transfer_bytes();
                drop(store);
                let restored = worker(root, vault);
                assert_eq!(restored.objects[&spec.object_id].status, status);
                assert_eq!(restored.quota.transfer_bytes(), charge);
            });
        }
    }

    #[test]
    fn delivered_payload_release_recovers_each_deletion_crash_boundary() {
        let bytes = vec![0x5b; CHUNK_BYTES + 27];
        for direction in [StoreDirection::Outgoing, StoreDirection::Incoming] {
            for removed in [0, 1, 2] {
                with_delivery_fixture("delivered-release-crash", &bytes, |root, vault, spec| {
                    let spec = endpoint_spec(spec, direction);
                    let mut store = worker(root, vault);
                    store.begin(spec.clone()).unwrap();
                    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
                        store
                            .append(&spec.object_id, (index * CHUNK_BYTES) as u64, chunk)
                            .unwrap();
                    }
                    store.finalize(&spec.object_id).unwrap();
                    store.apply(endpoint_receipt(&spec, &bytes)).unwrap();
                    let manifest = store.objects[&spec.object_id].clone();
                    let charged = store.quota.transfer_bytes();
                    for chunk in manifest.chunks.iter().take(removed) {
                        fs::remove_file(store.chunk_path(&spec.object_id, chunk)).unwrap();
                    }
                    // No final release index, no orderly stop or cleanup. Reopen
                    // the actual encrypted receipt with some/all payload absent.
                    drop(store);
                    let mut restored = worker(root, vault);
                    assert_eq!(restored.objects[&spec.object_id].status, manifest.status);
                    assert_eq!(restored.quota.transfer_bytes(), charged);
                    assert!(matches!(
                        restored.apply(StoreOperation::ReadRange {
                            object_id: spec.object_id.clone(),
                            offset: 0,
                            length: 1,
                        }),
                        Err(StoreError::Unavailable)
                    ));
                    restored.release_delivered(&spec.object_id).unwrap();
                    assert!(restored.objects[&spec.object_id].status.payload_released);
                    assert!(charged - restored.quota.transfer_bytes() >= bytes.len() as u64);
                    assert_eq!(
                        fs::read_dir(root.join(DIRECTORY).join(&spec.object_id))
                            .unwrap()
                            .count(),
                        1
                    );
                });
            }
        }
    }

    #[test]
    fn browser_download_receipt_validates_exact_copy_and_retries_a_failed_index() {
        let bytes = b"browser copy must be verified and durably retained";
        with_delivery_fixture("browser-receipt-index", bytes, |root, vault, spec| {
            let spec = endpoint_spec(spec, StoreDirection::Incoming);
            let mut store = worker(root, vault);
            store.begin(spec.clone()).unwrap();
            assert!(matches!(
                store.apply(endpoint_receipt(&spec, bytes)),
                Err(StoreError::Conflict)
            ));
            store.append(&spec.object_id, 0, bytes).unwrap();
            store.finalize(&spec.object_id).unwrap();
            let before = store.objects[&spec.object_id].clone();
            let charged = store.quota.transfer_bytes();
            // Already-full modern reservations include the terminal marker.
            store.quota = TransferQuota::new(charged, 0);
            store.quota.replace_transfer(0, charged).unwrap();
            assert_eq!(before.status.browser_download_confirmed, Some(false));
            assert_eq!(before.status.native_delivery_confirmed, None);
            assert!(matches!(
                store.mark_downloaded(
                    &spec.object_id,
                    bytes.len() as u64 - 1,
                    Sha256::digest(bytes).into()
                ),
                Err(StoreError::Conflict)
            ));
            assert!(matches!(
                store.mark_downloaded(&spec.object_id, bytes.len() as u64, [0; 32]),
                Err(StoreError::Hash)
            ));
            assert!(matches!(
                store.mark_delivered(&spec.object_id),
                Err(StoreError::Conflict)
            ));
            assert!(matches!(
                store.release_delivered(&spec.object_id),
                Err(StoreError::Conflict)
            ));
            let index = root.join(DIRECTORY).join(&spec.object_id).join("index.enc");
            let original = fs::read(&index).unwrap();
            fs::remove_file(&index).unwrap();
            fs::create_dir(&index).unwrap();
            assert!(matches!(
                store.apply(endpoint_receipt(&spec, bytes)),
                Err(StoreError::Unavailable)
            ));
            assert_eq!(store.objects[&spec.object_id].status, before.status);
            assert_eq!(store.quota.transfer_bytes(), charged);
            assert_eq!(store.read_range(&before, 0, bytes.len()).unwrap(), bytes);
            assert!(!store.write_failed);
            fs::remove_dir(&index).unwrap();
            fs::write(&index, original).unwrap();
            store.apply(endpoint_receipt(&spec, bytes)).unwrap();
            assert_eq!(store.quota.transfer_bytes(), charged);
            let confirmed = store.objects[&spec.object_id].clone();
            assert_eq!(confirmed.status.browser_download_confirmed, Some(true));
            assert!(confirmed.browser_receipt_extra_bytes.is_none());
            assert!(matches!(
                store.read_range(&confirmed, 0, bytes.len()),
                Err(StoreError::Unavailable)
            ));
            let receipt = fs::read(&index).unwrap();
            store.apply(endpoint_receipt(&spec, bytes)).unwrap();
            assert_eq!(fs::read(&index).unwrap(), receipt);
            store.release_delivered(&spec.object_id).unwrap();
            assert!(store.quota.transfer_bytes() < charged);
        });
    }

    #[test]
    fn browser_download_legacy_full_quota_receipt_survives_restart_then_frees_actual_payload() {
        let bytes = vec![0x6b; CHUNK_BYTES + 19];
        with_delivery_fixture("browser-legacy-full-quota", &bytes, |root, vault, spec| {
            let spec = endpoint_spec(spec, StoreDirection::Incoming);
            let mut store = worker(root, vault);
            store.begin(spec.clone()).unwrap();
            for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
                store
                    .append(&spec.object_id, (index * CHUNK_BYTES) as u64, chunk)
                    .unwrap();
            }
            store.finalize(&spec.object_id).unwrap();
            let mut legacy = store.objects[&spec.object_id].clone();
            legacy.status.browser_download_confirmed = None;
            store.commit_manifest(&legacy).unwrap();
            let charge = legacy.charge().unwrap();
            store.charges.insert(spec.object_id.clone(), charge);
            store.objects.insert(spec.object_id.clone(), legacy.clone());
            store.quota = TransferQuota::new(charge, 0);
            store.quota.replace_transfer(0, charge).unwrap();
            store.apply(endpoint_receipt(&spec, &bytes)).unwrap();
            let confirmed = store.objects[&spec.object_id].clone();
            let extra = confirmed.browser_receipt_extra_bytes.unwrap();
            assert_eq!(store.quota.transfer_bytes(), charge + extra);
            assert!(extra > 0 && extra <= 128);
            assert!(legacy
                .chunks
                .iter()
                .all(|chunk| store.chunk_path(&spec.object_id, chunk).is_file()));
            let mut another = spec.clone();
            another.object_id = "must-stay-full".into();
            assert!(matches!(store.begin(another), Err(StoreError::Quota)));
            drop(store);
            let mut restored = Worker::load(
                root.to_path_buf(),
                vault.payload_cipher().unwrap(),
                TransferQuota::new(charge, 0),
            )
            .unwrap();
            assert_eq!(restored.quota.transfer_bytes(), charge + extra);
            assert_eq!(restored.objects[&spec.object_id].status, confirmed.status);
            let mut forged = confirmed.clone();
            forged.browser_receipt_extra_bytes = Some(extra + 1);
            assert!(matches!(
                restored.validate_manifest(&forged),
                Err(StoreError::Conflict)
            ));
            forged = confirmed.clone();
            forged.status.browser_download_confirmed = Some(false);
            assert!(matches!(
                restored.validate_manifest(&forged),
                Err(StoreError::Conflict)
            ));
            restored.release_delivered(&spec.object_id).unwrap();
            let released = &restored.objects[&spec.object_id];
            assert!(released.status.payload_released && released.status.delivery_confirmed());
            assert!(released.browser_receipt_extra_bytes.is_none());
            assert_eq!(restored.quota.transfer_bytes(), released.charge().unwrap());
            assert!(charge - restored.quota.transfer_bytes() >= bytes.len() as u64);
            assert_eq!(
                fs::read_dir(root.join(DIRECTORY).join(&spec.object_id))
                    .unwrap()
                    .count(),
                1
            );
            let final_charge = restored.quota.transfer_bytes();
            drop(restored);
            let final_store = Worker::load(
                root.to_path_buf(),
                vault.payload_cipher().unwrap(),
                TransferQuota::new(charge, 0),
            )
            .unwrap();
            assert_eq!(final_store.quota.transfer_bytes(), final_charge);
        });
    }

    #[test]
    fn delivered_payload_release_rejects_unconfirmed_incoming_and_malformed_receipts() {
        let bytes = b"delivery is required before payload disposal";
        with_delivery_fixture("delivered-release-guards", bytes, |root, vault, spec| {
            let mut store = worker(root, vault);
            store.begin(spec.clone()).unwrap();
            assert!(matches!(
                store.release_delivered(&spec.object_id),
                Err(StoreError::Conflict)
            ));
            store.append(&spec.object_id, 0, bytes).unwrap();
            store.finalize(&spec.object_id).unwrap();
            let valid = store.objects[&spec.object_id].clone();
            assert!(matches!(
                store.release_delivered(&spec.object_id),
                Err(StoreError::Conflict)
            ));
            let mut incoming = spec.clone();
            incoming.object_id = "incoming-retained".into();
            incoming.direction = StoreDirection::Incoming;
            incoming.operation_id = None;
            incoming.expected_sha256 = None;
            store.begin(incoming.clone()).unwrap();
            store.append(&incoming.object_id, 0, bytes).unwrap();
            store.finalize(&incoming.object_id).unwrap();
            assert!(matches!(
                store.release_delivered(&incoming.object_id),
                Err(StoreError::Conflict)
            ));
            assert_eq!(
                store
                    .read_range(&store.objects[&incoming.object_id], 0, bytes.len())
                    .unwrap(),
                bytes
            );
            for flaw in [
                "no-receipt",
                "retained-chunks",
                "wrong-size",
                "wrong-hash",
                "chunk-gap",
            ] {
                let mut invalid = valid.clone();
                invalid.status.native_delivery_confirmed = Some(true);
                match flaw {
                    "no-receipt" => {
                        invalid.status.payload_released = true;
                        invalid.status.native_delivery_confirmed = Some(false);
                        invalid.chunks.clear();
                    }
                    "retained-chunks" => invalid.status.payload_released = true,
                    "wrong-size" => invalid.status.durable_bytes -= 1,
                    "wrong-hash" => invalid.status.committed_sha256 = Some([0; 32]),
                    "chunk-gap" => invalid.chunks[0].offset = 1,
                    _ => unreachable!(),
                }
                store.commit_manifest(&invalid).unwrap();
                assert!(
                    Worker::load(
                        root.to_path_buf(),
                        vault.payload_cipher().unwrap(),
                        TransferQuota::new(64 * 1024 * 1024, 0)
                    )
                    .is_err(),
                    "accepted {flaw}"
                );
            }
            store.commit_manifest(&valid).unwrap();
            // Missing bytes in a source without a durable native receipt remain
            // a hard recovery failure, never a cleanup authorization.
            fs::remove_file(store.chunk_path(&spec.object_id, &valid.chunks[0])).unwrap();
            assert!(Worker::load(
                root.to_path_buf(),
                vault.payload_cipher().unwrap(),
                TransferQuota::new(64 * 1024 * 1024, 0)
            )
            .is_err());
        });
    }

    fn wait_for_published(store: &TransferStore, ready: impl Fn(&Published) -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if ready(&store.published.lock().unwrap()) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "store worker timed out"
            );
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn stop_test_store(store: &TransferStore) {
        store.request_stop();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !store.is_stopped() {
            assert!(std::time::Instant::now() < deadline, "store stop timed out");
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn with_test_store(
        root: PathBuf,
        vault: &WorkspaceVault,
        quota: Arc<TransferQuota>,
        profiles: HashSet<String>,
        exercise: impl FnOnce(&TransferStore),
    ) {
        let mut running = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let store = TransferStore::start(
                root.clone(),
                vault.payload_cipher().unwrap(),
                quota,
                profiles,
            )
            .unwrap();
            running = Some(Arc::clone(&store));
            wait_for_published(&store, |state| state.ready);
            exercise(&store);
        }));
        // Assertion failures must still drop the real worker's cipher/handles
        // before removing its exact disposable directory.
        if let Some(store) = running {
            stop_test_store(&store);
        }
        fs::remove_dir_all(root).unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    fn publish_operation(store: &TransferStore, operation: StoreOperation) -> StoreTicket {
        publish_operation_with_timeout(store, operation, Duration::from_secs(5))
    }

    fn publish_operation_with_timeout(
        store: &TransferStore,
        operation: StoreOperation,
        timeout: Duration,
    ) -> StoreTicket {
        let key = operation_key(&operation);
        let started = std::time::Instant::now();
        let ticket = store.try_submit(operation).unwrap();
        loop {
            let (present, ready, pending, cache_bytes) = {
                let state = store.published.lock().unwrap();
                let entry = state.tickets.get(&ticket);
                (
                    entry.is_some(),
                    entry.is_some_and(|entry| entry.result.is_some()),
                    entry.is_some_and(|entry| entry.pending.is_some()),
                    operation_cache_bytes(&state),
                )
            };
            let elapsed = started.elapsed();
            assert!(
                present,
                "store operation {key}, ticket {ticket}, disappeared after {elapsed:?}"
            );
            if ready {
                return ticket;
            }
            assert!(elapsed < timeout,
                "store operation {key}, ticket {ticket}, timed out after {elapsed:?}; pending={pending}, cache_bytes={cache_bytes}");
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn delayed_worker_range_completion_is_replayed_by_the_next_operation_poll() {
        let bytes = vec![0x73; 64 * 1024];
        let (root, vault, spec) = fixture("delayed-range", &bytes);
        let mut disk = worker(&root, &vault);
        disk.begin(spec.clone()).unwrap();
        disk.append(&spec.object_id, 0, &bytes).unwrap();
        disk.finalize(&spec.object_id).unwrap();
        drop(disk);
        let store = TransferStore::start(
            root.clone(),
            vault.payload_cipher().unwrap(),
            TransferQuota::new(64 * 1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone()]),
        )
        .unwrap();
        wait_for_published(&store, |state| state.ready);
        let operation = StoreOperation::ReadRange {
            object_id: spec.object_id,
            offset: 0,
            length: bytes.len(),
        };
        let first = store.try_submit(operation.clone()).unwrap();
        // Publish on the real disk worker between HTTP-style operation polls.
        // Inspecting readiness here must not consume/observe the first reply.
        wait_for_published(&store, |state| state.tickets[&first].result.is_some());
        let replay = store.try_submit(operation).unwrap();
        let reply = store.try_result(replay);
        stop_test_store(&store);
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            replay, first,
            "a completed read must not start a new ticket"
        );
        let Some(Ok(StoreReply::Range {
            offset,
            bytes: read,
            ..
        })) = reply
        else {
            panic!("the next operation poll must receive the completed range")
        };
        assert_eq!(offset, 0);
        assert_eq!(read.as_ref(), bytes);
    }

    #[test]
    fn delayed_worker_begin_quota_error_reaches_the_next_operation_poll() {
        let (root, vault, spec) = fixture("delayed-quota", b"quota reservation");
        let store = TransferStore::start(
            root.clone(),
            vault.payload_cipher().unwrap(),
            TransferQuota::new(1, 0),
            HashSet::from([spec.profile_id.clone()]),
        )
        .unwrap();
        wait_for_published(&store, |state| state.ready);
        let operation = StoreOperation::Begin(spec);
        let first = store.try_submit(operation.clone()).unwrap();
        wait_for_published(&store, |state| state.tickets[&first].result.is_some());
        let replay = store.try_submit(operation).unwrap();
        let reply = store.try_result(replay);
        stop_test_store(&store);
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            replay, first,
            "an unobserved rejection must retain its ticket"
        );
        assert!(matches!(reply, Some(Err(StoreError::Quota))));
    }

    #[test]
    fn delayed_worker_unobserved_quota_survives_full_file_append_pressure() {
        let bytes = vec![0x49; FILE_LIMIT as usize];
        let (root, vault, spec) = fixture("handoff-pressure", &bytes);
        with_test_store(
            root,
            &vault,
            TransferQuota::new(32 * 1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone()]),
            |store| {
                publish_operation(store, StoreOperation::Begin(spec.clone()));
                let mut rejected = spec.clone();
                rejected.object_id = "rejectedTransfer".into();
                rejected.operation_id = Some("rejectedOperation".into());
                let rejection = StoreOperation::Begin(rejected);
                let denied = publish_operation(store, rejection.clone());
                for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
                    let ticket = publish_operation(
                        store,
                        StoreOperation::Append {
                            object_id: spec.object_id.clone(),
                            offset: (index * CHUNK_BYTES) as u64,
                            bytes: Arc::from(chunk),
                        },
                    );
                    // Core can advance from a snapshot without observing this
                    // success ticket. Its retained Arc must not fill the cache.
                    let state = store.published.lock().unwrap();
                    assert!(matches!(state.tickets[&ticket].result, Some(Ok(_))));
                    assert!(!state.tickets[&ticket].observed);
                    assert!(operation_cache_bytes(&state) <= OPERATION_CACHE_BYTES);
                    assert!(state.tickets.len() <= RESULT_LIMIT);
                    assert!(matches!(
                        state.tickets[&denied].result,
                        Some(Err(StoreError::Quota))
                    ));
                }
                // Finalize authenticates/decrypts all 25 MiB in one request.
                // Debug crypto exceeded the ordinary per-1-MiB 5 s deadline;
                // keep this larger bound local to the full-file operation.
                let finalized = publish_operation_with_timeout(
                    store,
                    StoreOperation::Finalize {
                        object_id: spec.object_id.clone(),
                    },
                    Duration::from_secs(30),
                );
                assert!(
                    matches!(store.try_result(finalized), Some(Ok(StoreReply::Status(status)))
                    if status.phase == StorePhase::Committed)
                );
                // Abandoned full-size ranges must also release their bounded
                // cache ownership without making subsequent reads stay Busy.
                for index in 0..bytes.len() / CHUNK_BYTES {
                    publish_operation(
                        store,
                        StoreOperation::ReadRange {
                            object_id: spec.object_id.clone(),
                            offset: (index * CHUNK_BYTES) as u64,
                            length: CHUNK_BYTES,
                        },
                    );
                    let state = store.published.lock().unwrap();
                    assert!(operation_cache_bytes(&state) <= OPERATION_CACHE_BYTES);
                    assert!(state.tickets.contains_key(&denied));
                }
                // Add metadata-count pressure as well as the Append byte bound.
                for index in 0..RESULT_LIMIT {
                    publish_operation(
                        store,
                        StoreOperation::ReadRange {
                            object_id: spec.object_id.clone(),
                            offset: index as u64,
                            length: 1,
                        },
                    );
                }
                assert_eq!(store.try_submit(rejection).unwrap(), denied);
                assert!(matches!(
                    store.try_result(denied),
                    Some(Err(StoreError::Quota))
                ));
                let operation = StoreOperation::ReadRange {
                    object_id: spec.object_id.clone(),
                    offset: 0,
                    length: CHUNK_BYTES,
                };
                // The first abandoned range retained a Busy handoff when its
                // bytes were displaced. Match the real caller: observe that
                // retry, then submit the same operation on the next poll.
                let displaced = publish_operation(store, operation.clone());
                assert!(matches!(
                    store.try_result(displaced),
                    Some(Err(StoreError::Busy))
                ));
                let read = publish_operation(store, operation);
                assert_ne!(read, displaced);
                assert!(
                    matches!(store.try_result(read), Some(Ok(StoreReply::Range { bytes: read, .. }))
                    if read.as_ref() == &bytes[..CHUNK_BYTES])
                );
            },
        );
    }

    #[test]
    fn delayed_worker_range_handoff_survives_snapshot_only_append_pressure() {
        let retained = vec![0x61; 64 * 1024];
        let uploading = vec![0x62; 2 * CHUNK_BYTES];
        let (root, vault, spec) = fixture("handoff-mixed-pressure", &retained);
        let mut upload = spec.clone();
        upload.object_id = "uploadB".into();
        upload.operation_id = Some("operationB".into());
        upload.size_bytes = uploading.len() as u64;
        upload.expected_sha256 = Some(Sha256::digest(&uploading).into());
        with_test_store(
            root,
            &vault,
            TransferQuota::new(8 * 1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone()]),
            |store| {
                publish_operation(store, StoreOperation::Begin(spec.clone()));
                let saved = publish_operation(
                    store,
                    StoreOperation::Append {
                        object_id: spec.object_id.clone(),
                        offset: 0,
                        bytes: Arc::from(retained.as_slice()),
                    },
                );
                assert!(matches!(store.try_result(saved), Some(Ok(_))));
                publish_operation(
                    store,
                    StoreOperation::Finalize {
                        object_id: spec.object_id.clone(),
                    },
                );
                let read = StoreOperation::ReadRange {
                    object_id: spec.object_id.clone(),
                    offset: 0,
                    length: retained.len(),
                };
                let first_read = publish_operation(store, read.clone());
                publish_operation(store, StoreOperation::Begin(upload.clone()));
                let mut append_tickets = Vec::new();
                for (index, chunk) in uploading.chunks(CHUNK_BYTES).enumerate() {
                    append_tickets.push(publish_operation(
                        store,
                        StoreOperation::Append {
                            object_id: upload.object_id.clone(),
                            offset: (index * CHUNK_BYTES) as u64,
                            bytes: Arc::from(chunk),
                        },
                    ));
                }
                {
                    let state = store.published.lock().unwrap();
                    assert!(operation_cache_bytes(&state) <= OPERATION_CACHE_BYTES);
                    assert!(!state.tickets.contains_key(&append_tickets[0]));
                    assert!(state.tickets.contains_key(&first_read));
                }
                assert_eq!(store.try_submit(read).unwrap(), first_read);
                assert!(
                    matches!(store.try_result(first_read), Some(Ok(StoreReply::Range { bytes, .. }))
                    if bytes.as_ref() == retained.as_slice())
                );
            },
        );
    }

    #[test]
    fn delayed_worker_three_range_pollers_make_progress_with_two_ranges_of_cache() {
        let bytes = (0..3)
            .flat_map(|index| vec![index as u8; CHUNK_BYTES])
            .collect::<Vec<_>>();
        let (root, vault, spec) = fixture("handoff-read-pressure", &bytes);
        with_test_store(
            root,
            &vault,
            TransferQuota::new(8 * 1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone()]),
            |store| {
                publish_operation(store, StoreOperation::Begin(spec.clone()));
                for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
                    let written = publish_operation(
                        store,
                        StoreOperation::Append {
                            object_id: spec.object_id.clone(),
                            offset: (index * CHUNK_BYTES) as u64,
                            bytes: Arc::from(chunk),
                        },
                    );
                    assert!(matches!(store.try_result(written), Some(Ok(_))));
                }
                publish_operation(
                    store,
                    StoreOperation::Finalize {
                        object_id: spec.object_id.clone(),
                    },
                );
                let reads = (0..3)
                    .map(|index| StoreOperation::ReadRange {
                        object_id: spec.object_id.clone(),
                        offset: (index * CHUNK_BYTES) as u64,
                        length: CHUNK_BYTES,
                    })
                    .collect::<Vec<_>>();
                let initial = reads
                    .iter()
                    .map(|read| publish_operation(store, read.clone()))
                    .collect::<Vec<_>>();
                assert_eq!(store.try_submit(reads[0].clone()).unwrap(), initial[0]);
                let mut received = [false; 3];
                let mut busy_handoffs = 0;
                for _ in 0..6 {
                    for (index, read) in reads.iter().enumerate() {
                        if received[index] {
                            continue;
                        }
                        // This is the production stateless operation poll:
                        // no ticket survives to the next poll.
                        let ticket = store.try_submit(read.clone()).unwrap();
                        match store.try_result(ticket) {
                            Some(Ok(StoreReply::Range {
                                offset,
                                bytes: actual,
                                ..
                            })) => {
                                assert_eq!(offset, (index * CHUNK_BYTES) as u64);
                                assert_eq!(
                                    actual.as_ref(),
                                    &bytes[index * CHUNK_BYTES..(index + 1) * CHUNK_BYTES]
                                );
                                received[index] = true;
                            }
                            Some(Err(StoreError::Busy)) => busy_handoffs += 1,
                            None => wait_for_published(store, |state| {
                                state.tickets[&ticket].result.is_some()
                            }),
                            other => panic!("unexpected range poll reply: {other:?}"),
                        }
                        assert!(
                            operation_cache_bytes(&store.published.lock().unwrap())
                                <= OPERATION_CACHE_BYTES
                        );
                    }
                    if received.iter().all(|value| *value) {
                        break;
                    }
                }
                assert!(busy_handoffs > 0, "a displaced range must hand off a retry");
                assert!(
                    received.iter().all(|value| *value),
                    "range pollers must not evict each other forever"
                );
            },
        );
    }

    #[test]
    fn delayed_worker_mutation_handoff_checks_exact_bytes_and_current_status() {
        let bytes = b"abc";
        let (root, vault, spec) = fixture("handoff-status", bytes);
        with_test_store(
            root,
            &vault,
            TransferQuota::new(1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone()]),
            |store| {
                let begin = publish_operation(store, StoreOperation::Begin(spec.clone()));
                let append = StoreOperation::Append {
                    object_id: spec.object_id.clone(),
                    offset: 0,
                    bytes: Arc::from(&bytes[..]),
                };
                let written = publish_operation(store, append.clone());
                assert_eq!(store.try_submit(append.clone()).unwrap(), written);
                assert_eq!(
                    store
                        .try_submit(StoreOperation::Append {
                            object_id: spec.object_id.clone(),
                            offset: 0,
                            bytes: Arc::from(&b"xyz"[..]),
                        })
                        .unwrap_err(),
                    StoreError::Conflict
                );
                publish_operation(
                    store,
                    StoreOperation::Finalize {
                        object_id: spec.object_id.clone(),
                    },
                );
                for ticket in [begin, written, written] {
                    assert!(
                        matches!(store.try_result(ticket), Some(Ok(StoreReply::Status(status)))
                        if status.phase == StorePhase::Committed && status.durable_bytes == 3)
                    );
                }
                {
                    let state = store.published.lock().unwrap();
                    assert_eq!(operation_cache_bytes(&state), 0);
                    assert!(!state.operation_keys.contains_key(&operation_key(&append)));
                }
                let removed = publish_operation(
                    store,
                    StoreOperation::Remove {
                        object_id: spec.object_id.clone(),
                    },
                );
                assert!(
                    matches!(store.try_result(removed), Some(Ok(StoreReply::Status(status)))
                    if status.phase == StorePhase::Removed)
                );
                assert!(
                    matches!(store.try_result(begin), Some(Ok(StoreReply::Status(status)))
                    if status.phase == StorePhase::Removed && status.durable_bytes == 0)
                );
            },
        );
    }

    #[test]
    fn delayed_worker_busy_read_is_observed_then_retried_after_commit() {
        let bytes = b"retry a staging read";
        let (root, vault, spec) = fixture("handoff-busy", bytes);
        with_test_store(
            root,
            &vault,
            TransferQuota::new(1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone()]),
            |store| {
                publish_operation(store, StoreOperation::Begin(spec.clone()));
                let read = StoreOperation::ReadRange {
                    object_id: spec.object_id.clone(),
                    offset: 0,
                    length: bytes.len(),
                };
                let busy = publish_operation(store, read.clone());
                assert_eq!(store.try_submit(read.clone()).unwrap(), busy);
                assert!(matches!(
                    store.try_result(busy),
                    Some(Err(StoreError::Busy))
                ));
                publish_operation(
                    store,
                    StoreOperation::Append {
                        object_id: spec.object_id.clone(),
                        offset: 0,
                        bytes: Arc::from(&bytes[..]),
                    },
                );
                publish_operation(
                    store,
                    StoreOperation::Finalize {
                        object_id: spec.object_id.clone(),
                    },
                );
                let ready = publish_operation(store, read.clone());
                assert_ne!(ready, busy);
                for _ in 0..3 {
                    assert_eq!(store.try_submit(read.clone()).unwrap(), ready);
                    assert!(
                        matches!(store.try_result(ready), Some(Ok(StoreReply::Range { bytes: actual, .. }))
                        if actual.as_ref() == bytes)
                    );
                }
                assert!(matches!(
                    store.try_result(busy),
                    Some(Err(StoreError::Busy))
                ));
            },
        );
    }

    #[test]
    fn delayed_worker_remove_and_profile_cleanup_invalidate_only_owned_ranges() {
        for remove_profile in [false, true] {
            let bytes = b"retained bytes for two profiles";
            let (root, vault, spec) = fixture("handoff-remove", bytes);
            let mut other = spec.clone();
            other.object_id = "transferB".into();
            other.operation_id = Some("operationB".into());
            other.profile_id = "profileB".into();
            with_test_store(
                root,
                &vault,
                TransferQuota::new(1024 * 1024, 0),
                HashSet::from([spec.profile_id.clone(), other.profile_id.clone()]),
                |store| {
                    let mut reads = Vec::new();
                    for file in [&spec, &other] {
                        publish_operation(store, StoreOperation::Begin(file.clone()));
                        publish_operation(
                            store,
                            StoreOperation::Append {
                                object_id: file.object_id.clone(),
                                offset: 0,
                                bytes: Arc::from(&bytes[..]),
                            },
                        );
                        publish_operation(
                            store,
                            StoreOperation::Finalize {
                                object_id: file.object_id.clone(),
                            },
                        );
                        let read = StoreOperation::ReadRange {
                            object_id: file.object_id.clone(),
                            offset: 0,
                            length: bytes.len(),
                        };
                        let ticket = publish_operation(store, read.clone());
                        assert!(matches!(
                            store.try_result(ticket),
                            Some(Ok(StoreReply::Range { .. }))
                        ));
                        reads.push((read, ticket));
                    }
                    if remove_profile {
                        store.try_remove_profile(&spec.profile_id).unwrap();
                        wait_for_published(store, |state| {
                            state.profile_removals[&spec.profile_id].result.is_some()
                        });
                        assert_eq!(
                            store.try_profile_removal_result(&spec.profile_id),
                            Some(Ok(()))
                        );
                    } else {
                        let removed = publish_operation(
                            store,
                            StoreOperation::Remove {
                                object_id: spec.object_id.clone(),
                            },
                        );
                        assert!(matches!(store.try_result(removed), Some(Ok(_))));
                    }
                    assert!(store.try_result(reads[0].1).is_none());
                    {
                        let state = store.published.lock().unwrap();
                        assert!(!state
                            .operation_keys
                            .contains_key(&operation_key(&reads[0].0)));
                        assert!(!state.order.contains(&reads[0].1));
                    }
                    let removed_read = publish_operation(store, reads[0].0.clone());
                    assert_ne!(removed_read, reads[0].1);
                    assert!(matches!(store.try_result(removed_read), Some(Err(_))));
                    assert_eq!(store.try_submit(reads[1].0.clone()).unwrap(), reads[1].1);
                    assert!(
                        matches!(store.try_result(reads[1].1), Some(Ok(StoreReply::Range { bytes: actual, .. }))
                        if actual.as_ref() == bytes)
                    );
                },
            );
        }
    }

    #[test]
    fn delayed_worker_abandoned_errors_are_bounded_without_blocking_new_work() {
        let (root, vault, spec) = fixture("handoff-abandoned", b"new work");
        with_test_store(
            root,
            &vault,
            TransferQuota::new(1024 * 1024, 0),
            HashSet::from([spec.profile_id.clone()]),
            |store| {
                let mut staging = spec.clone();
                staging.object_id = "stagingTransfer".into();
                staging.operation_id = Some("stagingOperation".into());
                let begun = publish_operation(store, StoreOperation::Begin(staging.clone()));
                assert!(matches!(store.try_result(begun), Some(Ok(_))));
                for index in 0..RESULT_LIMIT + 2 {
                    let ticket = publish_operation(
                        store,
                        StoreOperation::ReadRange {
                            object_id: staging.object_id.clone(),
                            offset: index as u64,
                            length: 1,
                        },
                    );
                    let state = store.published.lock().unwrap();
                    assert_eq!(state.tickets.len(), (index + 2).min(RESULT_LIMIT));
                    assert!(state.operation_keys.len() <= RESULT_LIMIT);
                    assert!(matches!(
                        state.tickets[&ticket].result,
                        Some(Err(StoreError::Busy))
                    ));
                }
                let begun = publish_operation(store, StoreOperation::Begin(spec));
                assert!(matches!(
                    store.try_result(begun),
                    Some(Ok(StoreReply::Status(_)))
                ));
            },
        );
    }

    #[test]
    fn encrypted_complete_payload_is_retained_across_reopen_and_replayed_reads() {
        let bytes = b"private attachment bytes that must survive a browser close";
        let (root, vault, spec) = fixture("retained", bytes);
        let mut store = worker(&root, &vault);
        store.begin(spec.clone()).unwrap();
        store.append(&spec.object_id, 0, bytes).unwrap();
        store.finalize(&spec.object_id).unwrap();
        let index = fs::read(root.join(DIRECTORY).join(&spec.object_id).join("index.enc")).unwrap();
        assert!(!index
            .windows(spec.name.len())
            .any(|window| window == spec.name.as_bytes()));
        drop(store);
        let store = worker(&root, &vault);
        let manifest = store.objects.get(&spec.object_id).unwrap();
        assert_eq!(manifest.status.phase, StorePhase::Committed);
        assert_eq!(store.read_range(manifest, 0, bytes.len()).unwrap(), bytes);
        assert_eq!(store.read_range(manifest, 3, 11).unwrap(), &bytes[3..14]);
        assert_eq!(store.read_range(manifest, 0, bytes.len()).unwrap(), bytes);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replay_conflicts_and_incomplete_hash_do_not_commit() {
        let bytes = b"abcdef";
        let (root, vault, spec) = fixture("replay", bytes);
        let mut store = worker(&root, &vault);
        store.begin(spec.clone()).unwrap();
        store.begin(spec.clone()).unwrap();
        store.append(&spec.object_id, 0, b"abc").unwrap();
        store.append(&spec.object_id, 0, b"abc").unwrap();
        assert!(matches!(
            store.append(&spec.object_id, 0, b"xyz"),
            Err(StoreError::Conflict)
        ));
        assert!(matches!(
            store.finalize(&spec.object_id),
            Err(StoreError::Range)
        ));
        let mut other = spec.clone();
        other.profile_id = "anotherProfile".into();
        assert!(matches!(store.begin(other), Err(StoreError::Conflict)));
        store.append(&spec.object_id, 3, b"xyz").unwrap();
        assert!(matches!(
            store.finalize(&spec.object_id),
            Err(StoreError::Hash)
        ));
        assert_eq!(
            store.objects[&spec.object_id].status.phase,
            StorePhase::Staging
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uncommitted_tail_is_ignored_after_crash_and_can_be_retried() {
        let bytes = b"abcdef";
        let (root, vault, spec) = fixture("tail", bytes);
        let mut store = worker(&root, &vault);
        store.begin(spec.clone()).unwrap();
        store.append(&spec.object_id, 0, b"abc").unwrap();
        let tail = Chunk {
            offset: 3,
            length: 3,
            sha256: Sha256::digest(b"def").into(),
        };
        let blob = store.cipher.seal(&chunk_aad(&spec, &tail), b"def").unwrap();
        let tail_path = store.chunk_path(&spec.object_id, &tail);
        write_blob_file(&tail_path, &blob).unwrap();
        drop(store);
        let mut store = worker(&root, &vault);
        assert_eq!(store.objects[&spec.object_id].status.durable_bytes, 3);
        assert!(!tail_path.exists());
        store.append(&spec.object_id, 3, b"def").unwrap();
        store.finalize(&spec.object_id).unwrap();
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_partial_frame_replacement_keeps_the_previous_durable_prefix() {
        let bytes = b"abcdef";
        let (root, vault, spec) = fixture("partial-replacement", bytes);
        let mut store = worker(&root, &vault);
        store.begin(spec.clone()).unwrap();
        store.append(&spec.object_id, 0, b"abc").unwrap();
        let replacement = Chunk {
            offset: 0,
            length: bytes.len(),
            sha256: Sha256::digest(bytes).into(),
        };
        let blob = store
            .cipher
            .seal(&chunk_aad(&spec, &replacement), bytes)
            .unwrap();
        let replacement_path = store.chunk_path(&spec.object_id, &replacement);
        write_blob_file(&replacement_path, &blob).unwrap();
        // Crash before index replacement: the old length-specific file still
        // backs its durable ACK and the new full frame is merely an orphan.
        drop(store);
        let mut store = worker(&root, &vault);
        let retained = &store.objects[&spec.object_id];
        assert_eq!(retained.status.durable_bytes, 3);
        assert_eq!(store.read_range(retained, 0, 3).unwrap(), b"abc");
        assert!(!replacement_path.exists());
        store.append(&spec.object_id, 3, b"def").unwrap();
        store.finalize(&spec.object_id).unwrap();
        assert_eq!(store.objects[&spec.object_id].chunks.len(), 1);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn another_workspace_key_and_corrupt_chunks_fail_closed() {
        let bytes = b"workspace-isolated bytes";
        let (root, vault, spec) = fixture("identity", bytes);
        let mut store = worker(&root, &vault);
        store.begin(spec.clone()).unwrap();
        store.append(&spec.object_id, 0, bytes).unwrap();
        store.finalize(&spec.object_id).unwrap();
        let chunk_path =
            store.chunk_path(&spec.object_id, &store.objects[&spec.object_id].chunks[0]);
        drop(store);
        let other = WorkspaceVault::create([0x73; 32], "another disposable password").unwrap();
        assert!(matches!(
            Worker::load(
                root.clone(),
                other.payload_cipher().unwrap(),
                TransferQuota::new(64 * 1024 * 1024, 0)
            ),
            Err(StoreError::Hash)
        ));
        let mut ciphertext = fs::read(&chunk_path).unwrap();
        *ciphertext.last_mut().unwrap() ^= 1;
        fs::write(chunk_path, ciphertext).unwrap();
        assert!(matches!(
            Worker::load(
                root.clone(),
                vault.payload_cipher().unwrap(),
                TransferQuota::new(64 * 1024 * 1024, 0)
            ),
            Err(StoreError::Hash)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_is_durable_and_does_not_resurrect_a_cancelled_operation() {
        let bytes = b"cancelled source";
        let (root, vault, spec) = fixture("remove", bytes);
        let mut store = worker(&root, &vault);
        store.begin(spec.clone()).unwrap();
        store.append(&spec.object_id, 0, bytes).unwrap();
        store.finalize(&spec.object_id).unwrap();
        store.remove(&spec.object_id).unwrap();
        store.remove(&spec.object_id).unwrap();
        drop(store);
        let mut store = worker(&root, &vault);
        let StoreReply::Status(status) = store.begin(spec.clone()).unwrap() else {
            panic!("status expected")
        };
        assert_eq!(status.phase, StorePhase::Removed);
        assert!(matches!(
            store.apply(StoreOperation::ReadRange {
                object_id: spec.object_id,
                offset: 0,
                length: 1
            }),
            Err(StoreError::Busy)
        ));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removed_empty_file_cannot_be_finalized_again() {
        let (root, vault, spec) = fixture("empty-tombstone", b"");
        let mut store = worker(&root, &vault);
        store.begin(spec.clone()).unwrap();
        store.remove(&spec.object_id).unwrap();
        assert_eq!(
            store.finalize(&spec.object_id).unwrap_err(),
            StoreError::Range
        );
        assert_eq!(
            store.objects[&spec.object_id].status.phase,
            StorePhase::Removed
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removed_profile_receipt_recovers_cleanup_without_touching_another_owner() {
        let bytes = b"profile-isolated retained bytes";
        let (root, vault, first) = fixture("profile-cleanup", bytes);
        let mut second = first.clone();
        second.object_id = "second-object".into();
        second.profile_id = "second-profile".into();
        let mut store = worker(&root, &vault);
        for spec in [&first, &second] {
            store.begin(spec.clone()).unwrap();
            store.append(&spec.object_id, 0, bytes).unwrap();
            store.finalize(&spec.object_id).unwrap();
        }
        // Canonical profile removal was persisted, then the daemon died before
        // its asynchronous cleanup request was accepted by the worker.
        drop(store);
        let mut store = worker(&root, &vault);
        store
            .retain_profiles(&HashSet::from([second.profile_id.clone()]))
            .unwrap();
        assert_eq!(
            store.objects[&first.object_id].status.phase,
            StorePhase::Removed
        );
        assert_eq!(
            store
                .read_range(&store.objects[&second.object_id], 0, bytes.len())
                .unwrap(),
            bytes
        );
        let mut late = first.clone();
        late.object_id = "late-native-begin".into();
        assert!(matches!(store.begin(late), Err(StoreError::Conflict)));
        store.remove_profile(&first.profile_id).unwrap();
        assert_eq!(
            store.objects[&second.object_id].status.phase,
            StorePhase::Committed
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_size_file_with_fragmented_appends_fits_its_initial_reservation() {
        let bytes = vec![0x63_u8; FILE_LIMIT as usize];
        let (root, vault, spec) = fixture("fixed-frames", &bytes);
        let manifest = Manifest {
            version: 1,
            browser_receipt_extra_bytes: None,
            status: StoreObjectStatus {
                spec: spec.clone(),
                durable_bytes: 0,
                phase: StorePhase::Staging,
                committed_sha256: None,
                native_delivery_confirmed: Some(false),
                browser_download_confirmed: None,
                payload_released: false,
            },
            chunks: Vec::new(),
        };
        let reservation = manifest.charge().unwrap();
        let quota = TransferQuota::new(reservation, 0);
        let mut store = Worker::load(
            root.clone(),
            vault.payload_cipher().unwrap(),
            Arc::clone(&quota),
        )
        .unwrap();
        store.begin(spec.clone()).unwrap();
        // Include tiny native-sized writes, a frame-crossing write, and a
        // restart with an incomplete frame. The reservation must never grow.
        let mut position = 0;
        for length in [1, 1023, CHUNK_BYTES] {
            store
                .append(
                    &spec.object_id,
                    position as u64,
                    &bytes[position..position + length],
                )
                .unwrap();
            position += length;
            assert_eq!(quota.transfer_bytes(), reservation);
        }
        drop(store);
        let mut store = Worker::load(
            root.clone(),
            vault.payload_cipher().unwrap(),
            Arc::clone(&quota),
        )
        .unwrap();
        while position < bytes.len() {
            let length = CHUNK_BYTES.min(bytes.len() - position);
            store
                .append(
                    &spec.object_id,
                    position as u64,
                    &bytes[position..position + length],
                )
                .unwrap();
            position += length;
            assert_eq!(quota.transfer_bytes(), reservation);
        }
        store.finalize(&spec.object_id).unwrap();
        assert_eq!(quota.transfer_bytes(), reservation);
        let retained = &store.objects[&spec.object_id];
        assert_eq!(retained.chunks.len(), 25);
        assert!(retained
            .chunks
            .iter()
            .all(|chunk| chunk.length == CHUNK_BYTES));
        assert_eq!(retained.status.committed_sha256, spec.expected_sha256);
        assert_eq!(
            fs::read_dir(root.join(DIRECTORY).join(&spec.object_id))
                .unwrap()
                .count(),
            26
        );
        drop(store);
        let store = worker(&root, &vault);
        let retained = &store.objects[&spec.object_id];
        assert_eq!(
            store
                .read_range(retained, CHUNK_BYTES as u64 - 7, 31)
                .unwrap(),
            bytes[CHUNK_BYTES - 7..CHUNK_BYTES + 24]
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transfer_reservations_and_payload_checkpoint_share_one_quota() {
        let bytes = vec![4_u8; 4096];
        let (root, vault, spec) = fixture("quota", &bytes);
        let quota = TransferQuota::new(8192, 0);
        let mut store = Worker::load(
            root.clone(),
            vault.payload_cipher().unwrap(),
            Arc::clone(&quota),
        )
        .unwrap();
        quota.reserve_payload(6000).unwrap().commit(6000);
        assert!(matches!(store.begin(spec.clone()), Err(StoreError::Quota)));
        quota.reserve_payload(1000).unwrap().commit(1000);
        store.begin(spec).unwrap();
        let transfer_charge = quota.transfer_bytes();
        assert!(transfer_charge > bytes.len() as u64);
        assert!(quota.reserve_payload(8192 - transfer_charge + 1).is_err());
        quota.reserve_payload(1000).unwrap().commit(900);
        assert_eq!(quota.transfer_bytes(), transfer_charge);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retained_incoming_file_survives_rejection_of_a_new_profile_offer_at_quota() {
        let bytes = vec![0x42; 4096];
        let (root, vault, mut retained) = fixture("retained-quota", &bytes);
        retained.direction = StoreDirection::Incoming;
        retained.operation_id = None;
        retained.expected_sha256 = None;
        let mut store = worker(&root, &vault);
        store.begin(retained.clone()).unwrap();
        let initial_charge = store.quota.transfer_bytes();
        store.append(&retained.object_id, 0, &bytes[..17]).unwrap();
        store.append(&retained.object_id, 17, &bytes[17..]).unwrap();
        store.finalize(&retained.object_id).unwrap();
        assert_eq!(store.quota.transfer_bytes(), initial_charge);
        let before_index = fs::read(
            root.join(DIRECTORY)
                .join(&retained.object_id)
                .join("index.enc"),
        )
        .unwrap();
        drop(store);
        // Browser has not consumed its local copy. Reopening must keep the
        // retained payload charged, even when another unlocked profile offers
        // another otherwise valid file.
        let quota = TransferQuota::new(initial_charge + 1024, 0);
        let mut store = Worker::load(
            root.clone(),
            vault.payload_cipher().unwrap(),
            Arc::clone(&quota),
        )
        .unwrap();
        let mut next = retained.clone();
        next.object_id = "new-incoming".into();
        next.profile_id = "another-unlocked-profile".into();
        assert!(matches!(store.begin(next.clone()), Err(StoreError::Quota)));
        assert_eq!(quota.transfer_bytes(), initial_charge);
        assert!(!root.join(DIRECTORY).join(&next.object_id).exists());
        assert_eq!(
            store
                .read_range(&store.objects[&retained.object_id], 0, bytes.len())
                .unwrap(),
            bytes
        );
        assert_eq!(
            fs::read(
                root.join(DIRECTORY)
                    .join(&retained.object_id)
                    .join("index.enc")
            )
            .unwrap(),
            before_index
        );
        let checkpoint = quota.reserve_payload(1024).unwrap();
        assert!(matches!(store.begin(next), Err(StoreError::Quota)));
        drop(checkpoint);
        assert_eq!(
            store.objects[&retained.object_id].status.phase,
            StorePhase::Committed
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_payload_checkpoint_and_transfer_cannot_both_spend_the_same_quota() {
        let quota = TransferQuota::new(8192, 0);
        let barrier = std::sync::Barrier::new(2);
        let (transfer_accepted, checkpoint_accepted) = thread::scope(|scope| {
            let transfer = scope.spawn(|| {
                barrier.wait();
                quota.replace_transfer(0, 7000).is_ok()
            });
            let checkpoint = scope.spawn(|| {
                barrier.wait();
                match quota.reserve_payload(7000) {
                    Ok(reservation) => {
                        reservation.commit(7000);
                        true
                    }
                    Err(_) => false,
                }
            });
            (transfer.join().unwrap(), checkpoint.join().unwrap())
        });
        assert_ne!(transfer_accepted, checkpoint_accepted);
        assert_eq!(quota.transfer_bytes() + quota.payload_bytes(), 7000);
    }

    #[test]
    fn facade_is_bounded_and_duplicate_pending_append_keeps_one_ticket() {
        let (sender, _receiver) = mpsc::sync_channel(QUEUE_LIMIT);
        let mut published = Published::default();
        published.ready = true;
        let store = TransferStore {
            sender,
            published: Arc::new(Mutex::new(published)),
            stopping: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            suspended: AtomicBool::new(false),
        };
        let first = StoreOperation::Append {
            object_id: "transferA".into(),
            offset: 0,
            bytes: Arc::from(&b"abc"[..]),
        };
        let ticket = store.try_submit(first.clone()).unwrap();
        assert_eq!(store.try_submit(first).unwrap(), ticket);
        for offset in 1..QUEUE_LIMIT {
            store
                .try_submit(StoreOperation::Append {
                    object_id: "transferA".into(),
                    offset: offset as u64,
                    bytes: Arc::from(&b"abc"[..]),
                })
                .unwrap();
        }
        assert_eq!(
            store
                .try_submit(StoreOperation::Finalize {
                    object_id: "transferA".into()
                })
                .unwrap_err(),
            StoreError::Busy
        );
        let _held = store.published.lock().unwrap();
        assert!(!store.is_ready());
        assert_eq!(store.try_snapshot().unwrap_err(), StoreError::Busy);
        assert_eq!(
            store
                .try_submit(StoreOperation::Finalize {
                    object_id: "transferA".into()
                })
                .unwrap_err(),
            StoreError::Busy
        );
    }
}
