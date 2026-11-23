//! Profile-scoped mirror principals. Browser device/UI leases are deliberately
//! not used here. All credentials, replay records and subscribers live in RAM.
use super::*;
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, sync::Mutex};
use tauri_app_lib::webgate::{CommandRequest, HopIdentity, OpenSessionRequest, StreamEvent};
use tokio::sync::watch;
#[path = "webgate_history.rs"]
mod history;

const SESSION_TTL: u64 = 90;
const MAX_SESSIONS: usize = 32;
const MAX_EVENTS: usize = 1024;
const MAX_OPERATION_RESULTS: usize = 2048;
const MAX_JOURNAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_OPERATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHUNK: usize = 256 * 1024;

#[derive(Clone)]
pub(crate) struct MirrorBinding {
    pub profile_id: String,
    pub tox_id: String,
    pub session_id: String,
    pub link_revision: u32,
    pub rooted_trace: Vec<HopIdentity>,
    last_seen: u64,
    replication: Arc<Mutex<MirrorReplication>>,
    history: Arc<Mutex<history::HistoryBases>>,
}

#[derive(Default)]
struct MirrorReplication {
    initialized: bool,
    overflow: bool,
    pending: HashMap<String, Value>,
    ranges: HashMap<String, Vec<(u64, u64)>>,
    durable: std::collections::HashSet<String>,
}

impl MirrorBinding {
    fn offer_replica(&self, mut transfer: Value) -> Result<(), String> {
        let id = transfer
            .get("id")
            .and_then(Value::as_str)
            .ok_or("TRANSFER_ID_INVALID")?
            .to_string();
        let mut replication = self.replication.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if transfer
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| matches!(state, "cancelled" | "failed"))
        {
            replication.pending.remove(&id);
            replication.ranges.remove(&id);
            return Ok(());
        }
        if replication.durable.contains(&id) {
            return Ok(());
        }
        if replication.pending.len() >= 4096 && !replication.pending.contains_key(&id) {
            replication.overflow = true;
            return Err("WEBGATE_REPLICATION_LIMIT".into());
        }
        if let Some(object) = transfer.as_object_mut() {
            object.insert("profileId".into(), json!(self.profile_id));
        }
        replication.pending.insert(id, transfer);
        Ok(())
    }

    fn record_replica_range(&self, result: &Value) -> Result<(), String> {
        let Some(transfer) = result.get("transfer") else {
            return Ok(());
        };
        let Some(data) = result.get("data").and_then(Value::as_str) else {
            return Ok(());
        };
        self.offer_replica(transfer.clone())?;
        let id = transfer
            .get("id")
            .and_then(Value::as_str)
            .ok_or("TRANSFER_ID_INVALID")?;
        let size = transfer
            .get("sizeBytes")
            .and_then(Value::as_u64)
            .ok_or("TRANSFER_SIZE_INVALID")?;
        let start = result
            .get("position")
            .and_then(Value::as_u64)
            .ok_or("TRANSFER_POSITION_INVALID")?;
        let len = STANDARD
            .decode(data)
            .map_err(|_| "TRANSFER_CHUNK_INVALID")?
            .len() as u64;
        let end = start
            .checked_add(len)
            .filter(|end| *end <= size)
            .ok_or("TRANSFER_CHUNK_RANGE_INVALID")?;
        let mut state = self.replication.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let ranges = state.ranges.entry(id.into()).or_default();
        ranges.push((start, end));
        ranges.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for (start, end) in ranges.drain(..) {
            if let Some(last) = merged.last_mut() {
                if start <= last.1 {
                    last.1 = last.1.max(end);
                    continue;
                }
            }
            merged.push((start, end));
        }
        if merged.len() > 4096 {
            return Err("TRANSFER_CHUNK_RANGE_INVALID".into());
        }
        *ranges = merged;
        Ok(())
    }

    fn verify_replica_receipt(&self, args: &Value, transfer: &Value) -> Result<(), String> {
        if args.get("durable").and_then(Value::as_bool) != Some(true) {
            return Err("TRANSFER_DURABLE_RECEIPT_REQUIRED".into());
        }
        let id = string_arg(args, "transferId")?;
        let size = args
            .get("sizeBytes")
            .and_then(Value::as_u64)
            .ok_or("TRANSFER_SIZE_INVALID")?;
        if transfer.get("sizeBytes").and_then(Value::as_u64) != Some(size)
            || transfer.get("payloadSha256").and_then(Value::as_str)
                != Some(string_arg(args, "sha256")?)
        {
            return Err("TRANSFER_HASH_MISMATCH".into());
        }
        let state = self.replication.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if state.durable.contains(id) {
            return Ok(());
        }
        if size > 0
            && state
                .ranges
                .get(id)
                .is_none_or(|ranges| ranges.as_slice() != [(0, size)])
        {
            return Err("TRANSFER_REPLICATION_RANGE_INCOMPLETE".into());
        }
        Ok(())
    }
    fn confirm_replica(&self, id: &str) -> Result<(), String> {
        let mut state = self.replication.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        state.pending.remove(id);
        state.ranges.remove(id);
        state.durable.insert(id.into());
        Ok(())
    }
}

struct OperationRecord {
    fingerprint: [u8; 32],
    result: Option<Result<Value, String>>,
    bytes: usize,
    retryable: bool,
}

struct HubInner {
    epoch: String,
    cursor: u64,
    events: VecDeque<(StreamEvent, usize)>,
    event_bytes: usize,
    sessions: HashMap<[u8; 32], MirrorBinding>,
    expired_tokens: VecDeque<[u8; 32]>,
    streams: HashMap<[u8; 32], usize>,
    operations: HashMap<(String, String), OperationRecord>,
    operation_bytes: usize,
}

pub(crate) struct WebgateHub {
    inner: Mutex<HubInner>,
    changed: watch::Sender<u64>,
}

impl Default for WebgateHub {
    fn default() -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Mutex::new(HubInner {
                // An unavailable RNG disables session creation; it never produces
                // a predictable bearer credential or reuses a previous epoch.
                epoch: random_token(24).unwrap_or_default(),
                cursor: 0,
                events: VecDeque::new(),
                event_bytes: 0,
                sessions: HashMap::new(),
                expired_tokens: VecDeque::new(),
                streams: HashMap::new(),
                operations: HashMap::new(),
                operation_bytes: 0,
            }),
            changed,
        }
    }
}

impl WebgateHub {
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn open_stream(self: &Arc<Self>, token: &str) -> Result<MirrorStreamGuard, String> {
        self.authenticate(token)?;
        let key = token_hash(token);
        let mut inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let count = inner.streams.entry(key).or_default();
        // One stream plus one reconnect overlap per authenticated principal.
        if *count >= 2 {
            return Err("WEBGATE_STREAM_LIMIT".into());
        }
        *count += 1;
        Ok(MirrorStreamGuard {
            hub: Arc::clone(self),
            key,
        })
    }

    pub fn barrier(&self) -> Result<(String, u64), String> {
        let inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if inner.epoch.is_empty() {
            return Err("STATE_UNAVAILABLE".into());
        }
        Ok((inner.epoch.clone(), inner.cursor))
    }

    pub fn publish(&self, profile_id: String, payload: Value) {
        self.publish_event(profile_id, "profile-changed", payload);
    }

    pub fn publish_event(&self, profile_id: String, event: &str, payload: Value) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let Some(cursor) = inner.cursor.checked_add(1) else {
            return;
        };
        inner.cursor = cursor;
        if let Some(transfer) = payload.get("transfer") {
            for binding in inner
                .sessions
                .values()
                .filter(|binding| binding.profile_id == profile_id)
            {
                let _ = binding.offer_replica(transfer.clone());
            }
        }
        let payload = if serde_json::to_vec(&payload).map_or(true, |bytes| bytes.len() > 64 * 1024)
        {
            json!({"kind":"profile","resyncRequired":true})
        } else {
            payload
        };
        let event = StreamEvent {
            epoch: inner.epoch.clone(),
            cursor,
            event: event.to_string(),
            profile_id,
            payload,
            revision: None,
        };
        let bytes = serde_json::to_vec(&event).map_or(1024, |bytes| bytes.len());
        inner.event_bytes = inner.event_bytes.saturating_add(bytes);
        inner.events.push_back((event, bytes));
        while inner.events.len() > MAX_EVENTS || inner.event_bytes > MAX_JOURNAL_BYTES {
            if let Some((_, bytes)) = inner.events.pop_front() {
                inner.event_bytes = inner.event_bytes.saturating_sub(bytes);
            } else {
                break;
            }
        }
        self.changed.send_replace(cursor);
    }

    pub fn live_profiles(&self, now: u64) -> Vec<String> {
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        inner
            .sessions
            .values()
            .filter(|binding| now.saturating_sub(binding.last_seen) < SESSION_TTL)
            .map(|binding| binding.profile_id.clone())
            .collect()
    }

    pub fn revoke_all(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.sessions.clear();
            inner.expired_tokens.clear();
        }
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    fn issue(&self, binding: MirrorBinding) -> Result<String, String> {
        let token = random_token(32)?;
        let mut inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let now = now_seconds();
        let expired = inner
            .sessions
            .iter()
            .filter_map(|(key, old)| {
                (now.saturating_sub(old.last_seen) >= SESSION_TTL).then_some(*key)
            })
            .collect::<Vec<_>>();
        for key in expired {
            inner.sessions.remove(&key);
            inner.expired_tokens.push_back(key);
        }
        while inner.expired_tokens.len() > 128 {
            inner.expired_tokens.pop_front();
        }
        if inner.epoch.is_empty() || inner.sessions.len() >= MAX_SESSIONS {
            return Err("WEBGATE_SESSION_LIMIT".into());
        }
        inner.sessions.insert(token_hash(&token), binding);
        Ok(token)
    }

    fn authenticate(&self, token: &str) -> Result<MirrorBinding, String> {
        let inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let hash = token_hash(token);
        let binding = inner.sessions.get(&hash).cloned().ok_or_else(|| {
            if inner.expired_tokens.contains(&hash) {
                "SESSION_EXPIRED"
            } else {
                "AUTH_INVALID"
            }
        })?;
        if now_seconds().saturating_sub(binding.last_seen) >= SESSION_TTL {
            return Err("SESSION_EXPIRED".into());
        }
        Ok(binding)
    }

    fn heartbeat(&self, token: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let binding = inner
            .sessions
            .get_mut(&token_hash(token))
            .ok_or("AUTH_INVALID")?;
        if now_seconds().saturating_sub(binding.last_seen) >= SESSION_TTL {
            return Err("SESSION_EXPIRED".into());
        }
        binding.last_seen = now_seconds();
        Ok(())
    }

    fn close(&self, token: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.sessions.remove(&token_hash(token));
        }
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    pub fn replay(
        &self,
        profile_id: Option<&str>,
        epoch: &str,
        after: u64,
    ) -> Result<Vec<StreamEvent>, String> {
        self.replay_window(profile_id, epoch, after)
            .map(|(events, _)| events)
    }

    fn replay_window(
        &self,
        profile_id: Option<&str>,
        epoch: &str,
        after: u64,
    ) -> Result<(Vec<StreamEvent>, u64), String> {
        let inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if inner.epoch != epoch
            || after > inner.cursor
            || inner
                .events
                .front()
                .is_some_and(|first| after.saturating_add(1) < first.0.cursor)
        {
            return Err("RESYNC_REQUIRED".into());
        }
        let events = inner
            .events
            .iter()
            .filter(|(event, _)| {
                event.cursor > after && profile_id.is_none_or(|id| event.profile_id == id)
            })
            .map(|(event, _)| event.clone())
            .collect();
        Ok((events, inner.cursor))
    }

    fn begin_operation(
        &self,
        profile_id: &str,
        id: &str,
        fingerprint: [u8; 32],
    ) -> Result<Option<Result<Value, String>>, String> {
        let mut inner = self.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let key = (profile_id.to_string(), id.to_string());
        if let Some(record) = inner.operations.get_mut(&key) {
            if record.fingerprint != fingerprint {
                return Err("OPERATION_ID_CONFLICT".into());
            }
            if record.retryable {
                let previous = record.bytes;
                record.bytes = 0;
                record.retryable = false;
                record.result = None;
                inner.operation_bytes = inner.operation_bytes.saturating_sub(previous);
                return Ok(None);
            }
            return record
                .result
                .clone()
                .map(Some)
                .ok_or_else(|| "OPERATION_PENDING".into());
        }
        // Never silently forget an accepted mutation inside the same replay
        // epoch. Rotate only after all accepted work has completed. Clients
        // reauthenticate and resync explicitly; message/file operation ids
        // still reach the native durable idempotency implementation unchanged.
        if inner.operations.len() >= MAX_OPERATION_RESULTS
            || inner.operation_bytes >= MAX_OPERATION_BYTES
        {
            if inner
                .operations
                .values()
                .any(|record| record.result.is_none())
            {
                return Err("OPERATION_PENDING".into());
            }
            let retained_count = inner
                .operations
                .values()
                .filter(|record| record.retryable)
                .count();
            let retained_bytes: usize = inner
                .operations
                .values()
                .filter(|record| record.retryable)
                .map(|record| record.bytes)
                .sum();
            if retained_count >= MAX_OPERATION_RESULTS || retained_bytes >= MAX_OPERATION_BYTES {
                return Err("OPERATION_PENDING".into());
            }
            inner.epoch = random_token(24)?;
            inner.cursor = 0;
            inner.events.clear();
            inner.event_bytes = 0;
            // An uncertain upstream outcome is never forgotten on rollover.
            // Its fingerprint and same-id retry survive the new replay epoch.
            inner.operations.retain(|_, record| record.retryable);
            inner.operation_bytes = inner.operations.values().map(|record| record.bytes).sum();
            inner.sessions.clear();
            inner.expired_tokens.clear();
            self.changed
                .send_modify(|version| *version = version.wrapping_add(1));
            return Err("SESSION_RESTARTED".into());
        }
        inner.operations.insert(
            key,
            OperationRecord {
                fingerprint,
                result: None,
                bytes: 0,
                retryable: false,
            },
        );
        Ok(None)
    }

    fn finish_operation(&self, profile_id: &str, id: &str, result: Result<Value, String>) {
        if let Ok(mut inner) = self.inner.lock() {
            let size = serde_json::to_vec(&result).map_or(usize::MAX, |bytes| bytes.len());
            let (result, size) = if size > 64 * 1024 {
                (Err("OPERATION_RESULT_REQUIRES_RESYNC".into()), 64)
            } else {
                (result, size)
            };
            if let Some(record) = inner
                .operations
                .get_mut(&(profile_id.to_string(), id.to_string()))
            {
                record.retryable = result
                    .as_ref()
                    .err()
                    .is_some_and(|code| retryable_transport_error(code));
                record.result = Some(result);
                let previous = record.bytes;
                record.bytes = size;
                inner.operation_bytes = inner
                    .operation_bytes
                    .saturating_sub(previous)
                    .saturating_add(size);
            }
        }
    }
}

struct MirrorStreamGuard {
    hub: Arc<WebgateHub>,
    key: [u8; 32],
}
impl Drop for MirrorStreamGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.hub.inner.lock() {
            if let Some(count) = inner.streams.get_mut(&self.key) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    inner.streams.remove(&self.key);
                }
            }
        }
    }
}

fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

/// Return the access-link identifier and a fixed operation, never a path chosen
/// by the client. Percent-encoded and additional path segments are not aliases.
pub(super) fn reserved_path(path: &str) -> bool {
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path
        .strip_prefix("space/")
        .or_else(|| path.strip_prefix("w/"))
        .unwrap_or(path);
    let Some((identifier, suffix)) = path.split_once('/') else {
        return false;
    };
    WorkspaceIdentifier::parse(identifier).is_ok()
        && (suffix == "api" || suffix.starts_with("api/"))
}

pub(super) fn scoped_path(path: &str) -> Option<(&str, &str)> {
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path
        .strip_prefix("space/")
        .or_else(|| path.strip_prefix("w/"))
        .unwrap_or(path);
    let (identifier, operation) = path.split_once("/api/v1/")?;
    WorkspaceIdentifier::parse(identifier).ok()?;
    (!identifier.contains('/')).then_some((identifier, operation))
}

fn bearer(request: &HttpRequest) -> Result<&str, String> {
    request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| {
            token.len() == 43
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or_else(|| "AUTH_INVALID".into())
}

fn workspace_hash(state: &AppState, identifier: &str) -> Result<[u8; 32], String> {
    let access = WorkspaceIdentifier::parse(identifier)
        .map_err(|_| "AUTH_INVALID")?
        .hash();
    let inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
    resolve_workspace_hash(&inner.workspaces, &access).ok_or_else(|| "AUTH_INVALID".into())
}

pub(super) fn configure_relay_identity(
    stored: &StoredWorkspace,
    origin: &str,
    hash: &[u8; 32],
) -> Result<(), String> {
    stored.remote_profiles.set_relay_identity(
        Sha256::digest(origin.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        hash.iter().map(|byte| format!("{byte:02x}")).collect(),
    )
}

fn validate_binding(stored: &StoredWorkspace, binding: &MirrorBinding) -> Result<(), String> {
    if stored.domain.access_link_revision != binding.link_revision
        || stored.domain.close_transaction.is_some()
    {
        return Err("AUTH_INVALID".into());
    }
    let identity = if stored.remote_profiles.contains(&binding.profile_id) {
        let metadata = stored
            .remote_profiles
            .profile_metadata(&binding.profile_id)?;
        validate_rooted_trace(binding, &metadata)?;
        metadata
            .get("toxId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or("PROFILE_IDENTITY_CHANGED")?
    } else {
        if binding.rooted_trace.len() != 1 {
            return Err("PROFILE_IDENTITY_CHANGED".into());
        }
        stored
            .runtime
            .as_ref()
            .ok_or("AUTH_INVALID")?
            .dispatch(&binding.profile_id, "get_tox_id", &json!({}))?
            .as_str()
            .map(str::to_string)
            .ok_or("PROFILE_IDENTITY_CHANGED")?
    };
    if identity != binding.tox_id {
        return Err("PROFILE_IDENTITY_CHANGED".into());
    }
    Ok(())
}

fn validate_rooted_trace(binding: &MirrorBinding, metadata: &Value) -> Result<(), String> {
    let actual: Vec<HopIdentity> = serde_json::from_value(
        metadata
            .get("trace")
            .cloned()
            .ok_or("PROFILE_IDENTITY_CHANGED")?,
    )
    .map_err(|_| "PROFILE_IDENTITY_CHANGED")?;
    let expected = binding
        .rooted_trace
        .get(..binding.rooted_trace.len().saturating_sub(1))
        .ok_or("PROFILE_IDENTITY_CHANGED")?;
    if actual.as_slice() != expected
        || metadata.get("toxId").and_then(Value::as_str) != Some(binding.tox_id.as_str())
    {
        return Err("PROFILE_IDENTITY_CHANGED".into());
    }
    Ok(())
}

fn bound_upstream_trace(binding: &MirrorBinding) -> Result<&[HopIdentity], String> {
    binding
        .rooted_trace
        .split_last()
        .map(|(_, trace)| trace)
        .ok_or_else(|| "PROFILE_IDENTITY_CHANGED".into())
}

fn friends_avatar_delta(mut value: Value, known: Option<Value>) -> Value {
    let Some(known) = known.as_ref().and_then(Value::as_object) else {
        return value;
    };
    if let Some(friends) = value.as_array_mut() {
        for friend in friends {
            let Some(object) = friend.as_object_mut() else {
                continue;
            };
            let key = object
                .get("public_key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let digest: String = Sha256::digest(
                object
                    .get("avatar_path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .as_bytes(),
            )
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
            if known.get(&key).and_then(Value::as_str) == Some(digest.as_str()) {
                object.remove("avatar_path");
            }
            object.insert("avatarSha256".into(), json!(digest));
        }
    }
    value
}

fn retryable_transport_error(code: &str) -> bool {
    matches!(
        code,
        "WEBGATE_CONNECTION_LOST"
            | "WEBGATE_TRANSPORT_CHANGED"
            | "WEBGATE_TIMEOUT"
            | "WEBGATE_CONNECT_FAILED"
            | "WEBGATE_DNS_FAILED"
            | "WEBGATE_TLS_FAILED"
            | "WEBGATE_TOR_REQUIRED"
            | "WEBGATE_TOR_FAILED"
            | "WEBGATE_PROXY_CONNECT_FAILED"
            | "WEBGATE_PROXY_RESPONSE_INVALID"
            | "WEBGATE_PROXY_AUTH_FAILED"
            | "WEBGATE_PROXY_INVALID"
            | "WEBGATE_PROXY_UNSUPPORTED"
            | "WEBGATE_CERTIFICATE_CHANGED"
    )
}

fn authorize(
    request: &HttpRequest,
    state: &AppState,
    hash: &[u8; 32],
) -> Result<(MirrorBinding, Arc<WebgateHub>), String> {
    // Check token presence and syntax before exposing session protocol state.
    // Unknown old tokens still reach the epoch check for safe restart recovery.
    let token = bearer(request)?;
    let inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
    let stored = inner.workspaces.get(hash).ok_or("AUTH_INVALID")?;
    let epoch = stored.mirror.barrier()?.0;
    match request.headers.get("x-kaigen-webgate-epoch") {
        Some(expected) if expected == &epoch => {}
        Some(_) => return Err("SESSION_RESTARTED".into()),
        None => return Err("WEBGATE_PROTOCOL_REQUIRED".into()),
    }
    let binding = stored.mirror.authenticate(token)?;
    validate_binding(stored, &binding)?;
    Ok((binding, Arc::clone(&stored.mirror)))
}

pub(super) async fn route(
    request: HttpRequest,
    remote: SocketAddr,
    state: Arc<AppState>,
    identifier: String,
    operation: String,
) -> HttpResponse {
    if request.method != "POST" {
        return error_response(405, "METHOD_NOT_ALLOWED");
    }
    if request.headers.get("origin").is_some()
        && !valid_origin(&request, &state.config.public_origin)
    {
        return error_response(403, "ORIGIN_INVALID");
    }
    if !request.headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return error_response(415, "CONTENT_TYPE_INVALID");
    }
    if operation == "session/challenge" {
        let source = match state.source_fingerprint(&source_address(
            remote,
            request.headers.get("x-real-ip").map(String::as_str),
        )) {
            Ok(value) => value,
            Err(_) => return error_response(503, "STATE_UNAVAILABLE"),
        };
        return initializer_challenge(state, source);
    }
    if operation == "session/open" {
        return open_session(request, remote, state, identifier).await;
    }
    let hash = match workspace_hash(&state, &identifier) {
        Ok(hash) => hash,
        Err(code) => return mirror_error(&code),
    };
    let (binding, hub) = match authorize(&request, &state, &hash) {
        Ok(value) => value,
        Err(code) => return mirror_error(&code),
    };
    if operation == "session/close" {
        hub.close(bearer(&request).unwrap_or_default());
        if let Ok(inner) = state.inner.lock() {
            if let Some(stored) = inner.workspaces.get(&hash) {
                let _ = stored.refresh_effective_presence(now_seconds());
            }
        }
        return json_response(200, &json!({"closed":true}));
    }
    if operation == "session/heartbeat" {
        return heartbeat_session(&request, &state, &hash, &binding, &hub);
    }
    let mut args: Value = match parse_json(&request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if operation == "command" {
        let input: CommandRequest = match serde_json::from_value(args) {
            Ok(value) => value,
            Err(_) => return error_response(400, "COMMAND_ARGUMENT_INVALID"),
        };
        if !allowed_command(&input.command) {
            return error_response(403, "COMMAND_NOT_AVAILABLE");
        }
        if input.operation_id.is_empty()
            || input.operation_id.len() > 128
            || !input
                .operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return error_response(400, "OPERATION_ID_INVALID");
        }
        let mut command_args = input.args;
        if !command_args.is_object() {
            return error_response(400, "COMMAND_ARGUMENT_INVALID");
        }
        // The caller's profile handle is a local alias. It never chooses or
        // changes the upstream principal established by session/open.
        if let Some(object) = command_args.as_object_mut() {
            object.insert("profileId".into(), json!(binding.profile_id));
            object.insert("operationId".into(), json!(input.operation_id));
        }
        let fingerprint: [u8; 32] = Sha256::digest(
            serde_json::to_vec(&(input.command.as_str(), &command_args)).unwrap_or_default(),
        )
        .into();
        let mutation = mutation_command(&input.command);
        if mutation {
            match hub.begin_operation(&binding.profile_id, &input.operation_id, fingerprint) {
                Ok(Some(result)) => return result_response(result),
                Ok(None) => {}
                Err(code) => return mirror_error(&code),
            }
        }
        let task_state = Arc::clone(&state);
        let task_binding = binding.clone();
        let task_command = input.command.clone();
        let operation_id = input.operation_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            execute_command(
                &task_state,
                &hash,
                &task_binding,
                &task_command,
                command_args,
                &operation_id,
            )
        })
        .await
        .unwrap_or_else(|_| Err("RUNTIME_UNAVAILABLE".into()));
        if mutation {
            hub.finish_operation(&binding.profile_id, &input.operation_id, result.clone());
        }
        if result.is_ok() && mutation {
            hub.publish(
                binding.profile_id,
                json!({"kind":"command","command":input.command}),
            );
        }
        return result_response(result);
    }
    if !matches!(
        operation.as_str(),
        "files/start"
            | "files/chunk"
            | "files/finish"
            | "files/status"
            | "files/cancel"
            | "files/snapshot"
    ) {
        return error_response(404, "NOT_FOUND");
    }
    if !args.is_object() {
        return error_response(400, "COMMAND_ARGUMENT_INVALID");
    }
    if let Some(object) = args.as_object_mut() {
        object.insert("profileId".into(), json!(binding.profile_id));
    }
    let event_operation = operation.clone();
    let publishes_change = !matches!(event_operation.as_str(), "files/status" | "files/snapshot")
        && (event_operation != "files/chunk" || args.get("data").is_some());
    // A submitted disk read is request work, not an idle file-status poll.
    // Await that one range without holding the workspace lock across waits.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut delay = Duration::from_millis(5);
    let result = loop {
        let task_state = Arc::clone(&state);
        let task_binding = binding.clone();
        let task_operation = operation.clone();
        let task_args = args.clone();
        let result = tokio::task::spawn_blocking(move || {
            execute_file(
                &task_state,
                &hash,
                &task_binding,
                &task_operation,
                task_args,
            )
        })
        .await
        .unwrap_or_else(|_| Err("RUNTIME_UNAVAILABLE".into()));
        if result
            .as_ref()
            .err()
            .is_some_and(|code| code == "TRANSFER_READ_PENDING")
            && Instant::now() < deadline
        {
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_millis(100));
            continue;
        }
        break result;
    };
    let result = result.and_then(|value| {
        if event_operation == "files/chunk" && args.get("data").is_none() {
            binding.record_replica_range(&value)?;
        }
        if event_operation == "files/finish"
            && args.get("replicated").and_then(Value::as_bool) == Some(true)
        {
            binding.confirm_replica(string_arg(&args, "transferId")?)?;
        }
        Ok(value)
    });
    if result.is_ok() && publishes_change {
        hub.publish(binding.profile_id, json!({"kind":"transfer"}));
    }
    result_response(result)
}

async fn open_session(
    request: HttpRequest,
    remote: SocketAddr,
    state: Arc<AppState>,
    identifier: String,
) -> HttpResponse {
    let mut input: OpenSessionRequest = match parse_json(&request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if input.password.len() > 4096
        || input.profile_name.is_empty()
        || input.profile_name.len() > 256
        || input.client_id.is_empty()
        || input.client_id.len() > 128
    {
        wipe_string(&mut input.password);
        return error_response(400, "COMMAND_ARGUMENT_INVALID");
    }
    let source = match state.source_fingerprint(&source_address(
        remote,
        request.headers.get("x-real-ip").map(String::as_str),
    )) {
        Ok(value) => value,
        Err(_) => return error_response(503, "STATE_UNAVAILABLE"),
    };
    let result = tokio::task::spawn_blocking(move || {
        let result = open_session_inner(&state, &identifier, &input, source);
        wipe_string(&mut input.password);
        result
    })
    .await
    .unwrap_or_else(|_| Err("RUNTIME_UNAVAILABLE".into()));
    result_response(result)
}

fn open_session_inner(
    state: &AppState,
    identifier: &str,
    input: &OpenSessionRequest,
    source: [u8; 32],
) -> Result<Value, String> {
    let now = now_seconds();
    let access = WorkspaceIdentifier::parse(identifier)
        .map_err(|_| "AUTH_INVALID")?
        .hash();
    let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
    let policy = inner.auth_backoff.policy(&source, now);
    if policy.allowed_at > now {
        return Err("AUTH_DELAYED".into());
    }
    if policy.captcha_required {
        let proof = input
            .proof
            .as_ref()
            .and_then(|proof| serde_json::to_value(proof).ok())
            .and_then(|value| serde_json::from_value::<crate::proof::ProofSolution>(value).ok());
        if !proof
            .as_ref()
            .is_some_and(|proof| inner.proofs.consume(&source, proof, now))
        {
            return Err("CAPTCHA_REQUIRED".into());
        }
    }
    let hash = resolve_workspace_hash(&inner.workspaces, &access);
    let authenticated = hash
        .and_then(|hash| inner.workspaces.get_mut(&hash))
        .is_some_and(|stored| stored.domain.unlock(&input.password).is_ok());
    if !authenticated {
        if hash.is_none() {
            let _ = inner.dummy_vault.unlock(&input.password);
            inner.dummy_vault.lock();
        }
        inner.auth_backoff.record_failure(source, now);
        return Err("AUTH_INVALID".into());
    }
    inner.auth_backoff.record_success(&source);
    let hash = hash.ok_or("AUTH_INVALID")?;
    let stored = inner.workspaces.get_mut(&hash).ok_or("AUTH_INVALID")?;
    if stored.domain.close_transaction.is_some() {
        return Err("WORKSPACE_FROZEN".into());
    }
    configure_relay_identity(stored, &state.config.public_origin, &hash)?;
    stored.ensure_runtime(&state.config.resource_root)?;
    // Barrier precedes the snapshot. An event racing with a snapshot is replayed
    // as an invalidation; it cannot disappear between snapshot and subscription.
    let (epoch, cursor) = stored.mirror.barrier()?;
    let matches = profile_summaries(stored)
        .into_iter()
        .filter(|profile| {
            if let Some(id) = input.profile_id.as_deref() {
                profile.get("id").and_then(Value::as_str) == Some(id)
            } else {
                profile.get("name").and_then(Value::as_str) == Some(input.profile_name.as_str())
            }
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(if matches.is_empty() {
            "PROFILE_NOT_FOUND"
        } else {
            "PROFILE_NAME_AMBIGUOUS"
        }
        .into());
    }
    let mut profile = matches.into_iter().next().ok_or("PROFILE_NOT_FOUND")?;
    let profile_id = profile
        .get("id")
        .and_then(Value::as_str)
        .ok_or("PROFILE_NOT_FOUND")?
        .to_string();
    // This backend comes from the server-owned catalog, not request input.
    // An upstream restore may still be pending after ensure_runtime returns.
    let remote_metadata = if profile.get("backend").and_then(Value::as_str) == Some("webgate") {
        Some(stored.remote_profiles.open_session_metadata(&profile_id)?)
    } else {
        None
    };
    if remote_metadata.is_none()
        && !stored
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.profile_loaded(&profile_id))
    {
        if profile.get("encrypted").and_then(Value::as_bool) == Some(true) {
            return Err("REMOTE_PROFILE_LOCKED".into());
        }
        let previous = stored.domain.profiles.clone();
        stored.domain.profiles.activate_for_mirror(&profile_id)?;
        if let Err(code) = stored.synchronize_runtime() {
            stored.domain.profiles = previous;
            return Err(code);
        }
        profile = profile_summaries(stored)
            .into_iter()
            .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id.as_str()))
            .ok_or("PROFILE_NOT_FOUND")?;
    }
    let metadata = if let Some(metadata) = remote_metadata {
        metadata
    } else {
        json!({"toxId":stored.runtime.as_ref().ok_or("RUNTIME_LOCKED")?.dispatch(&profile_id,"get_tox_id",&json!({}))?,
            "trace":[],"capabilities":native_capabilities()})
    };
    let tox_id = metadata
        .get("toxId")
        .and_then(Value::as_str)
        .ok_or("PROFILE_IDENTITY_CHANGED")?
        .to_string();
    let own = HopIdentity {
        server_id: Sha256::digest(state.config.public_origin.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        workspace_id: hash.iter().map(|byte| format!("{byte:02x}")).collect(),
        profile_id: profile_id.clone(),
    };
    let mut trace: Vec<HopIdentity> =
        serde_json::from_value(metadata.get("trace").cloned().unwrap_or(json!([])))
            .map_err(|_| "WEBGATE_TRACE_INVALID")?;
    if trace.iter().any(|hop| hop == &own)
        || input
            .trace
            .iter()
            .any(|hop| hop == &own || trace.iter().any(|upstream| upstream == hop))
    {
        return Err("WEBGATE_CYCLE".into());
    }
    trace.push(own);
    let binding = MirrorBinding {
        profile_id: profile_id.clone(),
        tox_id: tox_id.clone(),
        session_id: random_token(18)?,
        link_revision: stored.domain.access_link_revision,
        rooted_trace: trace.clone(),
        last_seen: now,
        replication: Arc::new(Mutex::new(MirrorReplication::default())),
        history: Arc::new(Mutex::new(history::HistoryBases::default())),
    };
    let session_id = binding.session_id.clone();
    let token = stored.mirror.issue(binding)?;
    stored.refresh_effective_presence(now)?;
    Ok(
        json!({"sessionToken":token,"sessionId":session_id,"epoch":epoch,"cursor":cursor,"profileId":profile_id,
        "profile":profile,"toxId":tox_id,"capabilities":metadata.get("capabilities").cloned().unwrap_or(json!(profile_commands())),
        "trace":trace,"heartbeatSeconds":20}),
    )
}

fn heartbeat_session(
    request: &HttpRequest,
    state: &AppState,
    hash: &[u8; 32],
    binding: &MirrorBinding,
    hub: &WebgateHub,
) -> HttpResponse {
    let result = (|| -> Result<Value, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let stored = inner.workspaces.get_mut(hash).ok_or("AUTH_INVALID")?;
        validate_binding(stored, binding)?;
        hub.heartbeat(bearer(request)?)?;
        let now = now_seconds();
        stored.refresh_effective_presence(now)?;
        let online = if stored.remote_profiles.contains(&binding.profile_id) {
            stored
                .remote_profiles
                .get(&binding.profile_id)
                .is_some_and(|remote| {
                    remote.is_connected()
                        && matches!(
                            remote.summary().get("connection").and_then(Value::as_str),
                            Some("tcp" | "udp" | "online")
                        )
                })
        } else {
            stored.runtime.as_ref().is_some_and(|runtime| {
                matches!(
                    runtime.profile_connection(&binding.profile_id),
                    "tcp" | "udp"
                )
            })
        };
        if online
            && stored.domain.auto_renew_on_heartbeat
            && stored.domain.close_transaction.is_none()
        {
            let previous = stored.domain.data_lease.clone();
            if stored.domain.data_lease.renew_from_heartbeat(now) {
                if let Err(code) = AppState::persist_retention(stored) {
                    stored.domain.data_lease = previous;
                    return Err(code);
                }
            }
        }
        Ok(json!({"online":online,"at":now.saturating_mul(1000)}))
    })();
    result_response(result)
}

fn profile_commands() -> Vec<&'static str> {
    vec![
        "get_profile_summary",
        "get_tox_id",
        "get_tox_friends",
        "get_tox_messages",
        "get_tox_messages_page",
        "get_tox_messages_snapshot",
        "search_tox_messages",
        "get_chat_capabilities",
        "send_tox_message",
        "cancel_tox_message",
        "delete_tox_message",
        "set_message_reactions",
        "acknowledge_local_messages",
        "release_chat_history",
        "refresh_chat_history_lease",
        "add_tox_friend",
        "delete_tox_friend",
        "get_incoming_friend_requests",
        "accept_incoming_friend_request",
        "reject_incoming_friend_request",
        "get_tox_network_status",
        "get_tox_user_status",
        "set_tox_user_status",
        "set_profile_user_status",
        "get_tox_status_message",
        "set_tox_status_message",
        "get_tox_nickname",
        "set_tox_nickname",
        "get_pq_status",
        "begin_pq_entropy",
        "complete_pq_identity",
        "skip_pq_auto",
        "request_pq_session",
        "withdraw_pq_session",
        "accept_pq_session",
        "reject_pq_session",
        "request_pq_shutdown",
        "cancel_pq_shutdown",
        "get_unread_state",
        "mark_friend_read",
        "mark_requests_read",
        "get_file_receive_settings",
        "set_file_receive_settings",
        "set_chat_history_enabled",
        "clear_tox_history",
        "load_local_state",
        "save_local_state",
        "load_layout_state",
        "save_layout_state",
        "set_profile_avatar",
        "send_tox_avatar",
        "get_background_transfer_work",
        "get_webgate_replication_snapshot",
        "control_tox_file_transfer",
        "complete_web_incoming_transfer",
    ]
}
fn native_capabilities() -> Vec<String> {
    let mut capabilities: Vec<String> =
        profile_commands().into_iter().map(str::to_owned).collect();
    capabilities.push("notification-preview-v1".to_string());
    capabilities
}

fn allowed_command(command: &str) -> bool {
    profile_commands().contains(&command)
}
fn mutation_command(command: &str) -> bool {
    matches!(
        command,
        "send_tox_message"
            | "cancel_tox_message"
            | "delete_tox_message"
            | "set_message_reactions"
            | "add_tox_friend"
            | "delete_tox_friend"
            | "accept_incoming_friend_request"
            | "reject_incoming_friend_request"
            | "set_tox_user_status"
            | "set_profile_user_status"
            | "set_tox_status_message"
            | "set_tox_nickname"
            | "set_profile_avatar"
            | "send_tox_avatar"
            | "clear_tox_history"
            | "set_file_receive_settings"
            | "set_chat_history_enabled"
            | "save_local_state"
            | "save_layout_state"
            | "control_tox_file_transfer"
            | "complete_web_incoming_transfer"
            | "complete_pq_identity"
            | "skip_pq_auto"
            | "request_pq_session"
            | "withdraw_pq_session"
            | "accept_pq_session"
            | "reject_pq_session"
            | "request_pq_shutdown"
            | "cancel_pq_shutdown"
    )
}

fn execute_command(
    state: &AppState,
    hash: &[u8; 32],
    binding: &MirrorBinding,
    command: &str,
    mut args: Value,
    operation_id: &str,
) -> Result<Value, String> {
    if command == "get_webgate_replication_snapshot" {
        return execute_file(state, hash, binding, "files/snapshot", json!({}));
    }
    let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
    let stored = inner.workspaces.get_mut(hash).ok_or("AUTH_INVALID")?;
    validate_binding(stored, binding)?;
    let history_claim = args
        .as_object_mut()
        .and_then(|args| args.remove(history::FIELD));
    let history_args = args.clone();
    let known_avatars = if command == "get_tox_friends" {
        args.as_object_mut()
            .and_then(|args| args.remove("_webgateKnownAvatars"))
    } else {
        None
    };
    if stored.remote_profiles.contains(&binding.profile_id) {
        let host = Arc::clone(&stored.remote_profiles);
        let id = binding.profile_id.clone();
        drop(inner);
        return host
            .invoke_bound(
                &id,
                &binding.tox_id,
                bound_upstream_trace(binding)?,
                command,
                args,
                Some(operation_id),
            )
            .and_then(|value| {
                binding
                    .history
                    .lock()
                    .map_err(|_| "STATE_UNAVAILABLE".to_string())?
                    .encode(
                        command,
                        &history_args,
                        history_claim,
                        friends_avatar_delta(value, known_avatars),
                    )
            });
    }
    let result = match command {
        "get_profile_summary" => profile_summaries(stored)
            .into_iter()
            .find(|profile| {
                profile.get("id").and_then(Value::as_str) == Some(binding.profile_id.as_str())
            })
            .ok_or("PROFILE_NOT_FOUND")?,
        "set_tox_user_status" | "set_profile_user_status" => {
            set_stored_profile_status(stored, &binding.profile_id, &args)?
        }
        "set_profile_avatar" => {
            let runtime = stored.runtime.as_ref().ok_or("RUNTIME_LOCKED")?;
            json!(runtime.set_profile_avatar(
                &binding.profile_id,
                nullable_string_arg(&args, "dataUrl")?.map(str::to_string),
                nullable_string_arg(&args, "filename")?.map(str::to_string),
                optional_bytes_arg(&args, "bytes")?
            )?)
        }
        "send_tox_avatar" => json!(stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .send_profile_avatar(
                &binding.profile_id,
                string_arg(&args, "filename")?,
                bytes_arg(&args, "bytes")?
            )?),
        "control_tox_file_transfer" => file_control(stored, &binding.profile_id, &args)?,
        "complete_web_incoming_transfer" => file_complete(stored, &binding.profile_id, &args)?,
        "get_background_transfer_work" => {
            let mut value = dispatch_profile_runtime(stored, &binding.profile_id, command, &args)?;
            if let Some(entries) = value.get_mut("entries").and_then(Value::as_array_mut) {
                entries.retain(|entry| {
                    entry.get("profileId").and_then(Value::as_str)
                        == Some(binding.profile_id.as_str())
                });
            }
            value
        }
        _ => dispatch_profile_runtime(stored, &binding.profile_id, command, &args)?,
    };
    if mutation_command(command) || command_mutates_runtime(command) {
        stored.checkpoint(command_requires_immediate_checkpoint(command))?;
        AppState::persist(stored)?;
    }
    binding
        .history
        .lock()
        .map_err(|_| "STATE_UNAVAILABLE".to_string())?
        .encode(
            command,
            &history_args,
            history_claim,
            friends_avatar_delta(result, known_avatars),
        )
}

fn file_control(
    stored: &mut StoredWorkspace,
    profile_id: &str,
    args: &Value,
) -> Result<Value, String> {
    let message_id = if let Some(id) = args.get("transferId").and_then(Value::as_str) {
        check_transfer_scope(stored, profile_id, id)?;
        stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .web_transfer_view(id, now_millis())?
            .message_id
    } else {
        string_arg(args, "messageId")?.to_string()
    };
    let result = stored
        .runtime
        .as_mut()
        .ok_or("RUNTIME_LOCKED")?
        .control_web_transfer(
            &mut stored.domain,
            profile_id,
            &message_id,
            string_arg(args, "action")?,
            now_millis(),
        )?;
    serde_json::to_value(result).map_err(|_| "TRANSFER_STATE_INVALID".into())
}
fn file_complete(
    stored: &mut StoredWorkspace,
    profile_id: &str,
    args: &Value,
) -> Result<Value, String> {
    let transfer_id = string_arg(args, "transferId")?;
    check_transfer_scope(stored, profile_id, transfer_id)?;
    let before = stored
        .runtime
        .as_ref()
        .ok_or("RUNTIME_LOCKED")?
        .web_transfer_view(transfer_id, now_millis())?;
    if before.direction == "outgoing" {
        if before.uploaded_bytes != before.size_bytes {
            return Err("TRANSFER_UPLOAD_INCOMPLETE".into());
        }
        return serde_json::to_value(
            stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .web_transfer_status(
                    &mut stored.domain,
                    transfer_id,
                    now_seconds(),
                    now_millis(),
                )?,
        )
        .map_err(|_| "TRANSFER_STATE_INVALID".into());
    }
    let bytes = args
        .get("sizeBytes")
        .and_then(Value::as_u64)
        .ok_or("TRANSFER_SIZE_INVALID")?;
    let digest = decode_transfer_hash(string_arg(args, "sha256")?).map_err(str::to_string)?;
    let result = stored
        .runtime
        .as_mut()
        .ok_or("RUNTIME_LOCKED")?
        .complete_web_incoming_transfer(
            &mut stored.domain,
            profile_id,
            transfer_id,
            bytes,
            digest,
            now_seconds(),
            now_millis(),
        )?;
    serde_json::to_value(result).map_err(|_| "TRANSFER_STATE_INVALID".into())
}
fn check_transfer_scope(
    stored: &StoredWorkspace,
    profile_id: &str,
    transfer_id: &str,
) -> Result<(), String> {
    if !valid_transfer_id(transfer_id) {
        return Err("TRANSFER_ID_INVALID".into());
    }
    let value = stored
        .runtime
        .as_ref()
        .ok_or("RUNTIME_LOCKED")?
        .web_transfer_view(transfer_id, now_millis())?;
    let value = serde_json::to_value(value).map_err(|_| "TRANSFER_STATE_INVALID")?;
    if value.get("profileId").and_then(Value::as_str) != Some(profile_id) {
        return Err("TRANSFER_PROFILE_MISMATCH".into());
    }
    Ok(())
}

fn project_file_transfer(
    transfer: &mut Value,
    expected_upstream: &str,
    relay_profile: &str,
) -> Result<(), String> {
    let object = transfer.as_object_mut().ok_or("TRANSFER_STATE_INVALID")?;
    if expected_upstream.is_empty()
        || relay_profile.is_empty()
        || object.get("profileId").and_then(Value::as_str) != Some(expected_upstream)
    {
        return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
    }
    for field in ["id", "messageId"] {
        if object
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err("TRANSFER_STATE_INVALID".into());
        }
    }
    object.insert("profileId".into(), json!(relay_profile));
    Ok(())
}

fn project_file_response(
    operation: &str,
    upload_chunk: bool,
    expected_upstream: &str,
    relay_profile: &str,
    mut result: Value,
) -> Result<Value, String> {
    if expected_upstream.is_empty() || relay_profile.is_empty() {
        return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
    }
    match operation {
        "files/start" | "files/status" => {
            project_file_transfer(&mut result, expected_upstream, relay_profile)?;
        }
        "files/cancel" | "files/finish" if result.is_null() => {}
        "files/finish"
            if result.as_object().is_some_and(|object| {
                object.len() == 2
                    && object.get("completion").and_then(Value::as_str) == Some("pending")
                    && object.get("retryAfterMs").and_then(Value::as_u64) == Some(100)
            }) => {}
        "files/cancel" | "files/finish" => {
            project_file_transfer(&mut result, expected_upstream, relay_profile)?;
        }
        "files/chunk" if upload_chunk => {
            project_file_transfer(&mut result, expected_upstream, relay_profile)?;
        }
        "files/chunk" if result.is_null() => {}
        "files/chunk" => {
            let object = result.as_object_mut().ok_or("TRANSFER_STATE_INVALID")?;
            if object.get("position").and_then(Value::as_u64).is_none()
                || object.get("data").and_then(Value::as_str).is_none()
            {
                return Err("TRANSFER_STATE_INVALID".into());
            }
            project_file_transfer(
                object.get_mut("transfer").ok_or("TRANSFER_STATE_INVALID")?,
                expected_upstream,
                relay_profile,
            )?;
        }
        "files/snapshot" => {
            let entries = result
                .get_mut("entries")
                .and_then(Value::as_array_mut)
                .ok_or("TRANSFER_STATE_INVALID")?;
            for transfer in entries {
                project_file_transfer(transfer, expected_upstream, relay_profile)?;
            }
        }
        _ => return Err("COMMAND_NOT_AVAILABLE".into()),
    }
    Ok(result)
}

fn execute_file(
    state: &AppState,
    hash: &[u8; 32],
    binding: &MirrorBinding,
    operation: &str,
    args: Value,
) -> Result<Value, String> {
    let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
    let stored = inner.workspaces.get_mut(hash).ok_or("AUTH_INVALID")?;
    validate_binding(stored, binding)?;
    if stored.remote_profiles.contains(&binding.profile_id) {
        let host = Arc::clone(&stored.remote_profiles);
        let id = binding.profile_id.clone();
        drop(inner);
        let upstream_trace = bound_upstream_trace(binding)?;
        let expected_upstream = upstream_trace
            .last()
            .map(|hop| hop.profile_id.as_str())
            .filter(|profile| !profile.is_empty())
            .ok_or("PROFILE_IDENTITY_CHANGED")?;
        let upload_chunk = args.get("data").is_some();
        if operation == "files/finish"
            && args.get("replicated").and_then(Value::as_bool) == Some(true)
        {
            let view = host.file_operation_bound(
                &id,
                &binding.tox_id,
                upstream_trace,
                "status",
                json!({"transferId":string_arg(&args,"transferId")?}),
            )?;
            let view = project_file_response("files/status", false, expected_upstream, &id, view)?;
            binding.verify_replica_receipt(&args, &view)?;
        }
        let result = host.file_operation_bound(
            &id,
            &binding.tox_id,
            upstream_trace,
            operation.trim_start_matches("files/"),
            args,
        )?;
        let result =
            project_file_response(operation, upload_chunk, expected_upstream, &id, result)?;
        if operation == "files/snapshot" {
            return replica_snapshot(
                binding,
                result
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        return Ok(result);
    }
    if operation == "files/snapshot" {
        let initialized = binding
            .replication
            .lock()
            .map_err(|_| "STATE_UNAVAILABLE")?
            .initialized;
        let entries = if initialized {
            Vec::new()
        } else {
            stored
                .runtime
                .as_ref()
                .ok_or("RUNTIME_LOCKED")?
                .web_replication_snapshot(&binding.profile_id, now_millis())?
                .into_iter()
                .map(|view| {
                    serde_json::to_value(view).map_err(|_| "TRANSFER_STATE_INVALID".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        return replica_snapshot(binding, entries);
    }
    if operation == "files/start" {
        let id = string_arg(&args, "operationId")?;
        if !valid_transfer_id(id) {
            return Err("TRANSFER_OPERATION_ID_INVALID".into());
        }
        let expected =
            decode_transfer_hash(string_arg(&args, "sha256")?).map_err(str::to_string)?;
        let value = stored
            .runtime
            .as_mut()
            .ok_or("RUNTIME_LOCKED")?
            .begin_web_outgoing_transfer(
                &mut stored.domain,
                &binding.profile_id,
                args.get("friendNumber")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or("COMMAND_ARGUMENT_INVALID")?,
                string_arg(&args, "expectedPublicKey")?,
                args.get("expectedContactIncarnation").and_then(Value::as_u64),
                string_arg(&args, "filename")?,
                args.get("mime")
                    .and_then(Value::as_str)
                    .unwrap_or("application/octet-stream"),
                args.get("sizeBytes")
                    .and_then(Value::as_u64)
                    .ok_or("COMMAND_ARGUMENT_INVALID")?,
                id,
                expected,
                now_seconds(),
                now_millis(),
            )?;
        stored.sync_transfer_quota();
        return serde_json::to_value(value).map_err(|_| "TRANSFER_STATE_INVALID".into());
    }
    let id = string_arg(&args, "transferId")?;
    check_transfer_scope(stored, &binding.profile_id, id)?;
    if operation == "files/finish" && args.get("replicated").and_then(Value::as_bool) == Some(true)
    {
        let view = serde_json::to_value(
            stored
                .runtime
                .as_ref()
                .ok_or("RUNTIME_LOCKED")?
                .web_transfer_view(id, now_millis())?,
        )
        .map_err(|_| "TRANSFER_STATE_INVALID")?;
        binding.verify_replica_receipt(&args, &view)?;
    }
    let now = now_seconds();
    let now_ms = now_millis();
    match operation {
        "files/status" => serde_json::to_value(
            stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .web_transfer_status(&mut stored.domain, id, now, now_ms)?,
        )
        .map_err(|_| "TRANSFER_STATE_INVALID".into()),
        "files/cancel" => file_control(
            stored,
            &binding.profile_id,
            &json!({"transferId":id,"action":"cancel"}),
        ),
        "files/finish" => file_complete(stored, &binding.profile_id, &args),
        "files/chunk" => {
            let position = args
                .get("position")
                .and_then(Value::as_u64)
                .ok_or("TRANSFER_POSITION_INVALID")?;
            if let Some(encoded) = args.get("data").and_then(Value::as_str) {
                if encoded.len() > MAX_CHUNK.div_ceil(3) * 4 {
                    return Err("TRANSFER_CHUNK_TOO_LARGE".into());
                }
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| "TRANSFER_CHUNK_INVALID")?;
                if bytes.len() > MAX_CHUNK {
                    return Err("TRANSFER_CHUNK_TOO_LARGE".into());
                }
                let mut value = stored
                    .runtime
                    .as_mut()
                    .ok_or("RUNTIME_LOCKED")?
                    .upload_web_transfer_chunk(
                        &mut stored.domain,
                        &binding.profile_id,
                        id,
                        position,
                        &bytes,
                        now,
                        now_ms,
                    )?;
                value.transfer.retry_after_ms =
                    value.transfer.retry_after_ms.max(value.retry_after_ms);
                serde_json::to_value(value.transfer).map_err(|_| "TRANSFER_STATE_INVALID".into())
            } else {
                let length = args
                    .get("length")
                    .and_then(Value::as_u64)
                    .unwrap_or(MAX_CHUNK as u64)
                    .min(MAX_CHUNK as u64) as usize;
                let value = stored
                    .runtime
                    .as_mut()
                    .ok_or("RUNTIME_LOCKED")?
                    .take_web_incoming_chunk(
                        &mut stored.domain,
                        id,
                        position,
                        length,
                        now,
                        now_ms,
                    )?;
                Ok(match value {
                    Some(chunk) => {
                        json!({"position":chunk.position,"data":STANDARD.encode(chunk.data),"transfer":chunk.transfer})
                    }
                    None => {
                        if stored
                            .runtime
                            .as_ref()
                            .ok_or("RUNTIME_LOCKED")?
                            .web_transfer_view(id, now_ms)?
                            .download_available
                        {
                            return Err("TRANSFER_READ_PENDING".into());
                        }
                        Value::Null
                    }
                })
            }
        }
        _ => Err("COMMAND_NOT_AVAILABLE".into()),
    }
}

fn replica_snapshot(binding: &MirrorBinding, entries: Vec<Value>) -> Result<Value, String> {
    for transfer in entries {
        binding.offer_replica(transfer)?;
    }
    let mut state = binding
        .replication
        .lock()
        .map_err(|_| "STATE_UNAVAILABLE")?;
    if state.overflow {
        return Err("WEBGATE_REPLICATION_LIMIT".into());
    }
    state.initialized = true;
    Ok(json!({"entries":state.pending.values().cloned().collect::<Vec<_>>()}))
}

pub(super) async fn stream(
    mut stream: TcpStream,
    request: HttpRequest,
    state: Arc<AppState>,
    identifier: String,
) -> Result<(), String> {
    if request.method != "GET"
        || (request.headers.get("origin").is_some()
            && !valid_origin(&request, &state.config.public_origin))
    {
        return write_response(&mut stream, error_response(403, "ORIGIN_INVALID")).await;
    }
    let hash = match workspace_hash(&state, &identifier) {
        Ok(value) => value,
        Err(code) => return write_response(&mut stream, mirror_error(&code)).await,
    };
    let (binding, hub) = match authorize(&request, &state, &hash) {
        Ok(value) => value,
        Err(code) => return write_response(&mut stream, mirror_error(&code)).await,
    };
    let _stream_guard = match hub.open_stream(bearer(&request).unwrap_or_default()) {
        Ok(guard) => guard,
        Err(code) => return write_response(&mut stream, mirror_error(&code)).await,
    };
    let params = url::form_urlencoded::parse(request.query.as_bytes()).collect::<HashMap<_, _>>();
    let epoch = params
        .get("epoch")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let mut cursor = params
        .get("after")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\nX-Accel-Buffering: no\r\nX-Content-Type-Options: nosniff\r\n\r\n").await.map_err(|_|"STREAM_WRITE_FAILED")?;
    let mut changed = hub.subscribe();
    loop {
        if let Err(code) = authorize(&request, &state, &hash) {
            if matches!(code.as_str(), "SESSION_RESTARTED" | "SESSION_EXPIRED") {
                return Ok(());
            }
            let event = json!({"event":"session-revoked","epoch":epoch,"cursor":cursor.saturating_add(1),"profileId":binding.profile_id,"payload":{}});
            let _ = write_sse(&mut stream, &event).await;
            return Ok(());
        }
        let (events, observed_cursor) = match hub.replay_window(
            Some(&binding.profile_id),
            &epoch,
            cursor,
        ) {
            Ok(window) => window,
            Err(_) => {
                let (current_epoch, current_cursor) = hub.barrier()?;
                let event = json!({"event":"resync-required","epoch":current_epoch,"cursor":current_cursor,"profileId":binding.profile_id,"payload":{}});
                let _ = write_sse(&mut stream, &event).await;
                return Ok(());
            }
        };
        for mut event in events {
            if let Ok(inner) = state.inner.lock() {
                if let Some(stored) = inner.workspaces.get(&hash) {
                    if let Some(mut profile) =
                        profile_summaries(stored).into_iter().find(|profile| {
                            profile.get("id").and_then(Value::as_str)
                                == Some(binding.profile_id.as_str())
                        })
                    {
                        let revision: String = Sha256::digest(
                            profile
                                .get("avatar")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .as_bytes(),
                        )
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect();
                        if let Some(object) = profile.as_object_mut() {
                            object.remove("avatar");
                        }
                        if let Some(payload) = event.payload.as_object_mut() {
                            payload.insert("profile".into(), profile);
                            payload.insert("avatarRevision".into(), json!(revision));
                        }
                    }
                }
            }
            // Capture only the selected native account under the dispatcher.
            // Disk/history preview work happens on a worker after releasing it.
            let prepared = if event.event == "profile-changed"
                && event.payload.get("notification").is_none()
            {
                state.inner.lock().ok().and_then(|inner| {
                    inner
                        .workspaces
                        .get(&hash)
                        .and_then(|stored| stored.runtime.as_ref())
                        .and_then(|runtime| {
                            runtime.prepare_notification(&binding.profile_id, &event.payload)
                        })
                })
            } else {
                None
            };
            if let Some(prepared) = prepared {
                if let Ok((prepared, Some(projection))) = tokio::task::spawn_blocking(move || {
                    let projection = prepared.execute();
                    (prepared, projection)
                })
                .await
                {
                    let current = state.inner.lock().ok().is_some_and(|inner| {
                        inner
                            .workspaces
                            .get(&hash)
                            .and_then(|stored| stored.runtime.as_ref())
                            .is_some_and(|runtime| {
                                runtime.notification_request_is_current(&prepared)
                            })
                    });
                    if current {
                        if let Some(payload) = event.payload.as_object_mut() {
                            if let Ok(projection) = serde_json::to_value(projection) {
                                payload.insert("notification".into(), projection);
                            }
                        }
                    }
                }
            }
            // A lock/replacement during the prepared read must not release
            // an old account's notification on this long-lived connection.
            if let Err(code) = authorize(&request, &state, &hash) {
                if !matches!(code.as_str(), "SESSION_RESTARTED" | "SESSION_EXPIRED") {
                    let revoked = json!({"event":"session-revoked","epoch":epoch,
                        "cursor":event.cursor,"profileId":binding.profile_id,"payload":{}});
                    let _ = write_sse(&mut stream, &revoked).await;
                }
                return Ok(());
            }
            cursor = event.cursor;
            let value = serde_json::to_value(event).map_err(|_| "STREAM_EVENT_INVALID")?;
            if write_sse(&mut stream, &value).await.is_err() {
                return Ok(());
            }
        }
        // Other profiles' traffic advances only this stream's server barrier;
        // it sends no empty business event and cannot force repeated snapshots
        // while the authenticated connection remains established.
        cursor = cursor.max(observed_cursor);
        let wait = async {
            tokio::time::timeout(Duration::from_secs(20), changed.changed())
                .await
                .is_ok()
        };
        let Some(signalled) = until_shutdown(wait).await else {
            return Ok(());
        };
        if !signalled && stream.write_all(b": keepalive\n\n").await.is_err() {
            return Ok(());
        }
    }
}

async fn write_sse(stream: &mut TcpStream, event: &Value) -> Result<(), String> {
    let frame = format!("data: {}\n\n", event);
    tokio::time::timeout(Duration::from_secs(15), stream.write_all(frame.as_bytes()))
        .await
        .map_err(|_| "STREAM_WRITE_TIMEOUT")?
        .map_err(|_| "STREAM_WRITE_FAILED".into())
}

/// Browser administration of its own relay handles uses the normal UI lease.
/// Only the captured host handle crosses into blocking network work: the
/// global workspace mutex is released before connect/invoke/file/close.
pub(super) async fn browser_command(
    request: &HttpRequest,
    state: Arc<AppState>,
    command: &str,
    args: Value,
) -> HttpResponse {
    if command == "get_webgate_profile_identity" {
        return browser_profile_identity(request, &state, &args);
    }
    let captured = (|| -> Result<_, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
        let (session, _) = authenticate_request(&inner, request, csrf)?;
        let stored = inner
            .workspaces
            .get_mut(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        require_workspace_control(stored, session)?;
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".into());
        }
        configure_relay_identity(stored, &state.config.public_origin, &session.workspace_hash)?;
        stored.ensure_runtime(&state.config.resource_root)?;
        let allow_private = std::env::var("KAIGEN_WEBGATE_ALLOW_PRIVATE_NETWORKS")
            .ok()
            .is_some_and(|value| matches!(value.as_str(), "1" | "true"));
        let policy = stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .webgate_transport_policy(allow_private);
        Ok((
            session.workspace_hash,
            Arc::clone(&stored.remote_profiles),
            stored.active_root.join("cache/webgate"),
            policy,
        ))
    })();
    let (hash, host, cache, policy) = match captured {
        Ok(value) => value,
        Err(code) => return mirror_error(&code),
    };
    let command = command.to_string();
    let result_command = command.clone();
    let task_host = Arc::clone(&host);
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        match command.as_str() {
            "connect_webgate_profile" | "update_webgate_profile" => {
                let mut card: tauri_app_lib::webgate::ConnectionCard = serde_json::from_value(
                    args.get("card")
                        .cloned()
                        .ok_or("COMMAND_ARGUMENT_INVALID")?,
                )
                .map_err(|_| "WEBGATE_CARD_INVALID")?;
                let mut password = args
                    .get("password")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if let Some(mut embedded) = card.password.take() {
                    if password.is_empty() {
                        password = embedded.clone();
                    }
                    wipe_string(&mut embedded);
                }
                let result = if command == "update_webgate_profile" {
                    task_host.reconnect(
                        string_arg(&args, "profileId")?,
                        card,
                        &password,
                        policy,
                        &cache,
                    )
                } else {
                    task_host.connect(card, &password, policy, &cache)
                };
                wipe_string(&mut password);
                result
            }
            "webgate_profiles" => Ok(Value::Null),
            "webgate_select_profile" => {
                if let Some(id) = args.get("profileId").and_then(Value::as_str) {
                    task_host.set_active(id)?;
                } else {
                    task_host.clear_active()?;
                }
                Ok(Value::Null)
            }
            "webgate_disconnect_profile" => {
                task_host.disconnect(string_arg(&args, "profileId")?)?;
                Ok(Value::Null)
            }
            "webgate_restore_profile" => {
                task_host.restore_profile(string_arg(&args, "profileId")?, policy, &cache)
            }
            "webgate_forget_profile" => {
                task_host.forget(string_arg(&args, "profileId")?)?;
                Ok(Value::Null)
            }
            "get_webgate_connection_card" => {
                serde_json::to_value(task_host.connection_card(string_arg(&args, "profileId")?)?)
                    .map_err(|_| "WEBGATE_CARD_INVALID".into())
            }
            "webgate_invoke" => task_host.invoke(
                string_arg(&args, "profileId")?,
                string_arg(&args, "command")?,
                args.get("args").cloned().unwrap_or(json!({})),
                args.get("operationId").and_then(Value::as_str),
            ),
            "webgate_file_operation" => task_host.file_operation(
                string_arg(&args, "profileId")?,
                string_arg(&args, "operation")?,
                args.get("args").cloned().unwrap_or(json!({})),
            ),
            _ => Err("COMMAND_NOT_AVAILABLE".into()),
        }
    })
    .await
    .unwrap_or_else(|_| Err("RUNTIME_UNAVAILABLE".into()));
    if result.is_err() {
        return result_response(result);
    }
    if matches!(
        result_command.as_str(),
        "webgate_invoke" | "webgate_file_operation" | "get_webgate_connection_card"
    ) {
        return result_response(result);
    }
    let view = (|| -> Result<Value, String> {
        let inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let stored = inner.workspaces.get(&hash).ok_or("AUTH_INVALID")?;
        if result_command != "webgate_profiles" {
            stored.mirror.publish_event(
                host.active_id().unwrap_or_default(),
                "profiles-changed",
                json!({"kind":"profiles"}),
            );
        }
        Ok(
            json!({"profiles":profile_summaries(stored),"activeProfileId":host.active_id().or_else(||selected_profile_id(&stored.domain).ok()),"initialConnectionPresetRequired":false}),
        )
    })();
    result_response(view)
}

fn browser_profile_identity(request: &HttpRequest, state: &AppState, args: &Value) -> HttpResponse {
    let result = (|| -> Result<Value, String> {
        let inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
        let (session, _) = authenticate_request(&inner, request, csrf)?;
        let stored = inner
            .workspaces
            .get(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        require_workspace_control(stored, session)?;
        let id = string_arg(args, "profileId")?;
        let identity = if stored.remote_profiles.contains(id) {
            let metadata = stored.remote_profiles.profile_metadata(id)?;
            let trace: Vec<HopIdentity> = serde_json::from_value(
                metadata
                    .get("trace")
                    .cloned()
                    .ok_or("PROFILE_IDENTITY_CHANGED")?,
            )
            .map_err(|_| "PROFILE_IDENTITY_CHANGED")?;
            trace.into_iter().next().ok_or("PROFILE_IDENTITY_CHANGED")?
        } else {
            if !stored
                .domain
                .profiles
                .profiles()
                .iter()
                .any(|profile| profile.id == id)
            {
                return Err("PROFILE_NOT_FOUND".into());
            }
            HopIdentity {
                server_id: Sha256::digest(state.config.public_origin.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                workspace_id: session
                    .workspace_hash
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                profile_id: id.to_string(),
            }
        };
        Ok(json!({"profileId":id,"identity":identity}))
    })();
    result_response(result)
}
fn result_response(result: Result<Value, String>) -> HttpResponse {
    match result {
        Ok(value) => json_response(200, &value),
        Err(code) => mirror_error(&code),
    }
}
fn mirror_error(code: &str) -> HttpResponse {
    let status = match code {
        "AUTH_INVALID" | "SESSION_EXPIRED" => 401,
        "SESSION_RESTARTED" => 409,
        "WEBGATE_PROTOCOL_REQUIRED" => 426,
        "AUTH_DELAYED" => 429,
        "PROFILE_IDENTITY_CHANGED"
        | "WEBGATE_ROUTE_CHANGED"
        | "RESYNC_REQUIRED"
        | "WEBGATE_CYCLE"
        | "OPERATION_ID_CONFLICT"
        | "OPERATION_PENDING"
        | "OPERATION_WINDOW_FULL" => 409,
        "COMMAND_NOT_AVAILABLE" | "TRANSFER_PROFILE_MISMATCH" => 403,
        "STATE_UNAVAILABLE" | "RUNTIME_UNAVAILABLE" => 503,
        _ => 400,
    };
    // Dispatcher diagnostics can contain paths. The wire error is a fixed code.
    let code = if code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
        code
    } else {
        "OPERATION_FAILED"
    };
    error_response(status, code)
}
