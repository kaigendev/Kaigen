mod auth;
mod avatars;
mod history;
use super::{
    cache::EphemeralCache,
    new_operation_id,
    transport::{bounded_line, io_code, HttpBody, Transport},
    validate_trace, wipe_string, CommandRequest, ConnectionCard, HopIdentity, OpenSessionRequest,
    OpenSessionResponse, SecretBytes, StreamEvent, TransportPolicy, MAX_EVENT_BYTES,
    MAX_JSON_BYTES,
};
use auth::{snapshot, Credentials};
use avatars::FriendAvatars;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::BufReader,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Lifecycle {
    closed: AtomicBool,
    connected: AtomicBool,
    started: AtomicBool,
    wait: Mutex<()>,
    wake: Condvar,
    handler: Mutex<Option<Arc<dyn Fn(StreamEvent) + Send + Sync>>>,
    avatar_revision: Mutex<String>,
}

static CLOSE_WORKERS: AtomicUsize = AtomicUsize::new(0);

struct ClosingSlot;
impl Drop for ClosingSlot {
    fn drop(&mut self) {
        CLOSE_WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Lifecycle {
    fn wait(&self, duration: Duration) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        if let Ok(guard) = self.wait.lock() {
            let _ = self
                .wake
                .wait_timeout_while(guard, duration, |_| !self.closed.load(Ordering::Acquire));
        }
        !self.closed.load(Ordering::Acquire)
    }
}

/// A live remote backend. The host owns its local alias and UI cache policy.
/// Worker threads own lifecycle pieces, never an Arc<RemoteProfile>, so Drop
/// can cancel streams and erase the key even if the server remains connected.
pub struct RemoteProfile {
    card: ConnectionCard,
    session: Arc<Mutex<OpenSessionResponse>>,
    transport: Arc<Transport>,
    lifecycle: Arc<Lifecycle>,
    cache: EphemeralCache,
    credentials: Arc<Credentials>,
    friend_avatars: Mutex<FriendAvatars>,
    history: Mutex<history::HistoryCache>,
}

impl RemoteProfile {
    pub fn connect(
        card: ConnectionCard,
        password: &str,
        policy: TransportPolicy,
        cache_root: &Path,
    ) -> Result<Arc<Self>, String> {
        Self::connect_with_trace(card, password, policy, cache_root, Vec::new())
    }

    pub fn connect_with_trace(
        mut card: ConnectionCard,
        password: &str,
        policy: TransportPolicy,
        cache_root: &Path,
        trace: Vec<HopIdentity>,
    ) -> Result<Arc<Self>, String> {
        let endpoint = card.validate()?;
        validate_trace(&trace)?;
        let transport = Transport::new(endpoint, card.certificate_sha256.as_deref(), policy)?;
        let input = OpenSessionRequest {
            password: password.to_string(),
            profile_name: card.profile_name.clone(),
            profile_id: card.profile_id.clone(),
            client_id: new_operation_id()?,
            trace: trace.clone(),
            proof: None,
        };
        let session = password_login(&transport, input, || false)?;
        validate_session(&session, &trace, card.identity.as_ref())?;
        if card
            .profile_id
            .as_ref()
            .is_some_and(|id| id != &session.profile_id)
        {
            return Err("WEBGATE_ACCOUNT_IDENTITY_CHANGED".into());
        }
        let binding = format!(
            "{}\0{}\0{}",
            session.session_id, session.profile_id, session.tox_id
        );
        let cache = EphemeralCache::new(cache_root, binding.as_bytes())?;
        if let Some(password) = card.password.take() {
            wipe_string(password);
        }
        card.certificate_sha256 = transport.fingerprint();
        // A later import must not silently bind a reused display name to a
        // different underlying account, including through another relay.
        card.identity = session.trace.first().cloned();
        card.profile_id = Some(session.profile_id.clone());
        let credentials = Arc::new(Credentials::new(password, card.profile_name.clone(), trace));
        let avatar_revision = avatar_revision(&session.profile);
        Ok(Arc::new(Self {
            card,
            session: Arc::new(Mutex::new(session)),
            transport,
            cache,
            credentials,
            friend_avatars: Mutex::new(FriendAvatars::default()),
            history: Mutex::new(history::HistoryCache::default()),
            lifecycle: Arc::new(Lifecycle {
                closed: AtomicBool::new(false),
                // Only an established event stream proves relay connectivity.
                connected: AtomicBool::new(false),
                started: AtomicBool::new(false),
                wait: Mutex::new(()),
                wake: Condvar::new(),
                handler: Mutex::new(None),
                avatar_revision: Mutex::new(avatar_revision),
            }),
        }))
    }

    pub fn profile_id(&self) -> String {
        self.session
            .lock()
            .map(|session| session.profile_id.clone())
            .unwrap_or_default()
    }

    pub fn tox_id(&self) -> String {
        self.session
            .lock()
            .map(|session| session.tox_id.clone())
            .unwrap_or_default()
    }

    /// Small RAM snapshot only; notification workers never clone avatars or perform IO.
    pub fn cached_notification_preferences(&self) -> Option<Value> {
        let session = self.session.lock().ok()?;
        session.profile.get("notificationPreferences").map(|value| {
            crate::webgate_notifications::NotificationPreferences::from_local_state(value).value()
        })
    }

    pub fn cached_root_identity(&self) -> Option<HopIdentity> {
        self.session.lock().ok()?.trace.first().cloned()
    }

    pub fn summary(&self) -> Value {
        self.session
            .lock()
            .map(|session| {
                let mut result = session.profile.clone();
                if !result.is_object() {
                    result = json!({});
                }
                result["profileId"] = json!(session.profile_id);
                result["toxId"] = json!(session.tox_id);
                result["capabilities"] = json!(session.capabilities);
                result["trace"] = json!(session.trace);
                result
            })
            .unwrap_or(Value::Null)
    }

    pub fn metadata(&self) -> Value {
        self.session
            .lock()
            .map(|session| {
                json!({
                    "profileId": session.profile_id, "toxId": session.tox_id,
                    "capabilities": session.capabilities, "trace": session.trace,
                    "epoch": session.epoch, "cursor": session.cursor,
                })
            })
            .unwrap_or(Value::Null)
    }

    pub fn card(&self) -> ConnectionCard {
        let mut card = self.card.clone();
        card.password = None;
        card.certificate_sha256 = self.transport.fingerprint();
        if let Ok(session) = self.session.lock() {
            card.profile_id = Some(session.profile_id.clone());
            if let Some(name) = session
                .profile
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty() && name.len() <= 256)
            {
                card.profile_name = name.to_string();
            }
        }
        card
    }

    pub fn cache(&self) -> &EphemeralCache {
        &self.cache
    }

    pub fn is_connected(&self) -> bool {
        !self.lifecycle.closed.load(Ordering::Acquire)
            && self.lifecycle.connected.load(Ordering::Acquire)
    }

    pub fn invoke(
        &self,
        command: &str,
        args: Value,
        operation_id: Option<&str>,
    ) -> Result<Value, String> {
        if command.is_empty()
            || command.len() > 128
            || !command
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err("WEBGATE_COMMAND_INVALID".into());
        }
        let operation_id = operation_id
            .or_else(|| args.get("operationId").and_then(Value::as_str))
            .map(str::to_string)
            .map(Ok)
            .unwrap_or_else(new_operation_id)?;
        if operation_id.is_empty()
            || operation_id.len() > 128
            || !operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("WEBGATE_OPERATION_ID_INVALID".into());
        }
        let request = CommandRequest {
            command: command.into(),
            args,
            operation_id,
        };
        if command == "get_tox_friends" {
            // Serialize only this account's avatar delta negotiation. Neither
            // host registry nor event/cache invalidation locks cross network IO.
            return self
                .friend_avatars
                .lock()
                .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?
                .fetch(self, request);
        }
        if matches!(
            command,
            "get_tox_messages" | "get_tox_messages_snapshot" | "get_tox_messages_page"
        ) {
            return self
                .history
                .lock()
                .map_err(|_| "WEBGATE_CACHE_UNAVAILABLE")?
                .fetch(self, request);
        }
        self.json_operation(
            "command",
            &serde_json::to_value(request).map_err(|_| "WEBGATE_REQUEST_INVALID")?,
        )
    }

    pub fn file_operation(&self, operation: &str, args: Value) -> Result<Value, String> {
        let route = match operation {
            "start" => "files/start",
            "chunk" => "files/chunk",
            "finish" => "files/finish",
            "status" => "files/status",
            "cancel" => "files/cancel",
            "snapshot" => "files/snapshot",
            _ => return Err("WEBGATE_OPERATION_INVALID".into()),
        };
        self.json_operation(route, &args)
    }

    fn json_operation(&self, route: &str, value: &Value) -> Result<Value, String> {
        if self.lifecycle.closed.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        let result = self.credentials.request(
            &self.session,
            &self.transport,
            &self.lifecycle,
            route,
            value,
        );
        if self.lifecycle.closed.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        result
    }

    pub fn heartbeat(&self) -> Result<Value, String> {
        self.json_operation("session/heartbeat", &json!({}))
    }

    /// The host calls this synchronously when built-in Tor is disabled/restarted.
    pub fn interrupt_transport(&self) {
        self.lifecycle.connected.store(false, Ordering::Release);
        self.transport.interrupt();
        self.lifecycle.wake.notify_all();
    }

    pub fn close(&self) -> Result<(), String> {
        if self.lifecycle.closed.swap(true, Ordering::AcqRel) {
            self.credentials.clear();
            self.cache.clear();
            self.transport.interrupt();
            return Ok(());
        }
        self.lifecycle.connected.store(false, Ordering::Release);
        self.lifecycle.wake.notify_all();
        self.transport.interrupt();
        let auth = snapshot(&self.session);
        self.credentials.clear();
        erase_session(&self.session);
        self.cache.clear();
        // Teardown is local and bounded. A best-effort revocation must not hold
        // registry locks or serialize application shutdown behind N timeouts.
        // When all four slots are busy, the server presence lease expires.
        if let Ok(auth) = auth {
            if CLOSE_WORKERS
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                    (active < 4).then_some(active + 1)
                })
                .is_ok()
            {
                let transport = Arc::clone(&self.transport);
                if thread::Builder::new()
                    .name("webgate-close".into())
                    .spawn(move || {
                        let _slot = ClosingSlot;
                        if let Ok(token) = secret_text(&auth.token) {
                            let _ = transport
                                .request(
                                    "POST",
                                    "session/close",
                                    None,
                                    Some(token),
                                    Some(&auth.epoch),
                                    b"{}",
                                    false,
                                )
                                .and_then(response_json);
                        }
                        transport.interrupt();
                    })
                    .is_err()
                {
                    CLOSE_WORKERS.fetch_sub(1, Ordering::AcqRel);
                }
            }
        }
        Ok(())
    }

    pub fn start_events(
        self: &Arc<Self>,
        handler: Arc<dyn Fn(StreamEvent) + Send + Sync>,
    ) -> Result<(), String> {
        if self.lifecycle.closed.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        if self.lifecycle.started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        *self
            .lifecycle
            .handler
            .lock()
            .map_err(|_| "WEBGATE_SESSION_INVALID")? = Some(Arc::clone(&handler));
        let credentials = Arc::clone(&self.credentials);
        let (session, transport, lifecycle) = (
            Arc::clone(&self.session),
            Arc::clone(&self.transport),
            Arc::clone(&self.lifecycle),
        );
        thread::Builder::new()
            .name("webgate-events".into())
            .spawn(move || {
                event_loop(session, transport, lifecycle, credentials, handler);
            })
            .map_err(|_| {
                self.lifecycle.started.store(false, Ordering::Release);
                "WEBGATE_WORKER_UNAVAILABLE"
            })?;
        let (session, transport, lifecycle) = (
            Arc::clone(&self.session),
            Arc::clone(&self.transport),
            Arc::clone(&self.lifecycle),
        );
        let credentials = Arc::clone(&self.credentials);
        let heartbeat = thread::Builder::new()
            .name("webgate-presence".into())
            .spawn(move || {
                heartbeat_loop(session, transport, lifecycle, credentials);
            });
        if heartbeat.is_err() {
            self.lifecycle.closed.store(true, Ordering::Release);
            self.transport.interrupt();
            return Err("WEBGATE_WORKER_UNAVAILABLE".into());
        }
        Ok(())
    }
}

impl Drop for RemoteProfile {
    fn drop(&mut self) {
        self.lifecycle.closed.store(true, Ordering::Release);
        self.lifecycle.wake.notify_all();
        self.transport.interrupt();
        self.credentials.clear();
        erase_session(&self.session);
        self.cache.clear();
    }
}

fn validate_session(
    session: &OpenSessionResponse,
    trace: &[HopIdentity],
    identity: Option<&HopIdentity>,
) -> Result<(), String> {
    if session.session_token.len() < 24
        || session.session_token.len() > 1024
        || !session
            .session_token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || session.session_id.is_empty()
        || session.profile_id.is_empty()
        || session.epoch.is_empty()
        || session.tox_id.is_empty()
    {
        return Err("WEBGATE_SESSION_INVALID".into());
    }
    validate_trace(&session.trace)?;
    for value in [
        &session.session_id,
        &session.profile_id,
        &session.epoch,
        &session.tox_id,
    ] {
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err("WEBGATE_SESSION_INVALID".into());
        }
    }
    if session.trace.is_empty() || session.trace.iter().any(|hop| trace.contains(hop)) {
        return Err("WEBGATE_CYCLE".into());
    }
    if session
        .trace
        .last()
        .is_some_and(|hop| hop.profile_id != session.profile_id)
    {
        return Err("WEBGATE_SESSION_INVALID".into());
    }
    if identity.is_some_and(|identity| !session.trace.contains(identity)) {
        return Err("WEBGATE_ACCOUNT_IDENTITY_CHANGED".into());
    }
    Ok(())
}

fn secret_text(secret: &SecretBytes) -> Result<&str, String> {
    std::str::from_utf8(&secret.0).map_err(|_| "WEBGATE_SESSION_INVALID".into())
}

fn erase_session(session: &Mutex<OpenSessionResponse>) {
    if let Ok(mut session) = session.lock() {
        wipe_string(std::mem::take(&mut session.session_token));
    }
}

fn password_login(
    transport: &Arc<Transport>,
    mut input: OpenSessionRequest,
    cancelled: impl Fn() -> bool,
) -> Result<OpenSessionResponse, String> {
    let generation = transport.generation();
    for attempt in 0..2 {
        if cancelled() {
            return Err("WEBGATE_CLOSED".into());
        }
        transport.assert_generation(generation)?;
        let body = SecretBytes(serde_json::to_vec(&input).map_err(|_| "WEBGATE_REQUEST_INVALID")?);
        let result = transport
            .request("POST", "session/open", None, None, None, &body.0, false)
            .and_then(response_json);
        transport.assert_generation(generation)?;
        if attempt == 0
            && result
                .as_ref()
                .is_err_and(|code| code == "CAPTCHA_REQUIRED")
        {
            let response =
                transport.request("POST", "session/challenge", None, None, None, b"{}", false)?;
            let challenge: LoginChallenge = serde_json::from_value(response_json(response)?)
                .map_err(|_| "WEBGATE_PROOF_INVALID")?;
            input.proof = Some(solve_proof(transport, generation, challenge, &cancelled)?);
            continue;
        }
        return serde_json::from_value(result?).map_err(|_| "WEBGATE_SESSION_INVALID".into());
    }
    Err("WEBGATE_AUTH_INVALID".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginChallenge {
    challenge_id: String,
    salt: String,
    difficulty: u8,
    expires_at: u64,
}

fn solve_proof(
    transport: &Transport,
    generation: u64,
    challenge: LoginChallenge,
    cancelled: &impl Fn() -> bool,
) -> Result<super::ProofSolution, String> {
    if challenge.challenge_id.is_empty()
        || challenge.challenge_id.len() > 128
        || challenge.salt.len() > 128
        || challenge.difficulty > 32
    {
        return Err("WEBGATE_PROOF_INVALID".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "WEBGATE_CLOCK_INVALID")?
        .as_millis() as u64;
    let remaining = challenge.expires_at.saturating_sub(now).min(300_000);
    if remaining == 0 {
        return Err("WEBGATE_PROOF_EXPIRED".into());
    }
    let deadline = Instant::now() + Duration::from_millis(remaining);
    let mut prefix = Sha256::new();
    prefix.update(challenge.salt.as_bytes());
    prefix.update(b":");
    for nonce in 0..=u32::MAX {
        if nonce % 1024 == 0 {
            if cancelled() {
                return Err("WEBGATE_CLOSED".into());
            }
            transport.assert_generation(generation)?;
            if Instant::now() >= deadline {
                return Err("WEBGATE_PROOF_EXPIRED".into());
            }
            thread::yield_now();
        }
        let mut hash = prefix.clone();
        hash.update(nonce.to_string().as_bytes());
        let digest = hash.finalize();
        let mut zeros = 0u32;
        for byte in digest {
            zeros += byte.leading_zeros();
            if byte != 0 {
                break;
            }
        }
        if zeros >= u32::from(challenge.difficulty) {
            return Ok(super::ProofSolution {
                challenge_id: challenge.challenge_id,
                nonce: u64::from(nonce),
            });
        }
    }
    Err("WEBGATE_PROOF_NOT_SOLVED".into())
}

fn response_json(response: HttpBody) -> Result<Value, String> {
    let status = response.status;
    let bytes = response.bytes(MAX_JSON_BYTES)?;
    let value: Value = serde_json::from_slice(&bytes.0).map_err(|_| "WEBGATE_RESPONSE_INVALID")?;
    if !(200..300).contains(&status) {
        let code = value.get("code").and_then(Value::as_str).filter(|code| {
            !code.is_empty()
                && code.len() <= 96
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        });
        return Err(code
            .unwrap_or(match status {
                401 => "WEBGATE_AUTH_INVALID",
                426 => "WEBGATE_UPGRADE_REQUIRED",
                _ => "WEBGATE_REQUEST_FAILED",
            })
            .into());
    }
    Ok(value)
}

fn event_loop(
    session: Arc<Mutex<OpenSessionResponse>>,
    transport: Arc<Transport>,
    lifecycle: Arc<Lifecycle>,
    credentials: Arc<Credentials>,
    handler: Arc<dyn Fn(StreamEvent) + Send + Sync>,
) {
    let mut backoff = 250u64;
    while !lifecycle.closed.load(Ordering::Acquire) {
        let auth = snapshot(&session);
        let mut result = match &auth {
            Ok(auth) => stream_once(
                &session,
                &transport,
                &lifecycle,
                &credentials,
                &handler,
                auth,
            ),
            Err(code) => Err(code.clone()),
        };
        lifecycle.connected.store(false, Ordering::Release);
        if lifecycle.closed.load(Ordering::Acquire) {
            break;
        }
        if result.as_ref().is_err_and(|code| auth::renewable(code)) {
            if let Ok(auth) = &auth {
                match credentials.renew(&session, &transport, &lifecycle, auth) {
                    Ok(()) => {
                        backoff = 250;
                        continue;
                    }
                    Err(code) => result = Err(code),
                }
            }
        }
        if let Err(code) = &result {
            emit_state(&session, &handler, "connection-lost", json!({"code": code}));
            if matches!(
                code.as_str(),
                "AUTH_INVALID"
                    | "WEBGATE_AUTH_INVALID"
                    | "SESSION_REVOKED"
                    | "WEBGATE_SESSION_REVOKED"
                    | "WEBGATE_ACCOUNT_IDENTITY_CHANGED"
                    | "PASSWORD_REAUTH_REQUIRED"
                    | "WORKSPACE_LOCKED"
                    | "WORKSPACE_CLOSED"
            ) {
                lifecycle.closed.store(true, Ordering::Release);
                credentials.clear();
                erase_session(&session);
                lifecycle.wake.notify_all();
                break;
            }
        }
        let mut jitter = [0u8; 2];
        let _ = getrandom::fill(&mut jitter);
        let delay = Duration::from_millis(
            backoff + u64::from(u16::from_le_bytes(jitter)) % (backoff / 2 + 1),
        );
        if !lifecycle.wait(delay) {
            break;
        }
        backoff = (backoff * 2).min(30_000);
    }
}

fn stream_once(
    session: &Mutex<OpenSessionResponse>,
    transport: &Arc<Transport>,
    lifecycle: &Lifecycle,
    credentials: &Credentials,
    handler: &Arc<dyn Fn(StreamEvent) + Send + Sync>,
    auth: &auth::AuthSnapshot,
) -> Result<(), String> {
    let (epoch, after) = session
        .lock()
        .map(|session| (session.epoch.clone(), session.cursor))
        .map_err(|_| "WEBGATE_SESSION_INVALID")?;
    let generation = transport.generation();
    let response = transport.request(
        "GET",
        "stream",
        Some((&epoch, after)),
        Some(secret_text(&auth.token)?),
        Some(&auth.epoch),
        b"",
        true,
    )?;
    if response.status != 200 {
        return response_json(response).map(|_| ());
    }
    lifecycle.connected.store(true, Ordering::Release);
    emit_state(session, handler, "connection-ready", json!({}));
    let mut reader = BufReader::new(response);
    let mut data = Vec::new();
    while !lifecycle.closed.load(Ordering::Acquire) {
        transport.assert_generation(generation)?;
        let line = bounded_line(&mut reader, MAX_EVENT_BYTES).map_err(io_code)?;
        if line.is_empty() {
            return Err("WEBGATE_CONNECTION_LOST".into());
        }
        if line == b"\r\n" || line == b"\n" {
            if data.is_empty() {
                continue;
            }
            let mut event: StreamEvent =
                serde_json::from_slice(&data).map_err(|_| "WEBGATE_EVENT_INVALID")?;
            transport.assert_generation(generation)?;
            data.clear();
            let current = session.lock().map_err(|_| "WEBGATE_SESSION_INVALID")?;
            if event.profile_id != current.profile_id {
                return Err("WEBGATE_EVENT_SCOPE_INVALID".into());
            }
            let resync = event.event == "resync-required" || event.epoch != current.epoch;
            if !resync && event.cursor <= current.cursor && event.event != "session-revoked" {
                continue;
            }
            drop(current);
            let full_profile = refresh_profile_if_needed(
                session,
                transport,
                lifecycle,
                credentials,
                &event,
                resync,
            )?;
            transport.assert_generation(generation)?;
            let mut current = session.lock().map_err(|_| "WEBGATE_SESSION_INVALID")?;
            // Cursors are workspace-global, while this stream is profile-scoped.
            // Missing numeric values belong to other profiles; the server emits
            // resync-required when retained replay coverage is actually missing.
            current.cursor = event.cursor;
            if resync {
                current.epoch = event.epoch.clone();
                event.event = "resync-required".into();
            }
            if let Some(profile) = event
                .payload
                .get("profile")
                .filter(|profile| profile.is_object())
            {
                merge_profile(&mut current.profile, profile);
            } else if event.event == "profile-updated" && event.payload.is_object() {
                merge_profile(&mut current.profile, &event.payload);
            }
            if let Some(profile) = full_profile {
                *lifecycle
                    .avatar_revision
                    .lock()
                    .map_err(|_| "WEBGATE_SESSION_INVALID")? = avatar_revision(&profile);
                merge_profile(&mut current.profile, &profile);
            }
            drop(current);
            let revoked = event.event == "session-revoked";
            handler(event);
            if revoked {
                return Err("WEBGATE_SESSION_REVOKED".into());
            }
        } else if let Some(payload) = line.strip_prefix(b"data:") {
            let payload = payload.strip_prefix(b" ").unwrap_or(payload);
            let payload = payload.strip_suffix(b"\n").unwrap_or(payload);
            let payload = payload.strip_suffix(b"\r").unwrap_or(payload);
            if data.len().saturating_add(payload.len()).saturating_add(1) > MAX_EVENT_BYTES {
                return Err("WEBGATE_EVENT_TOO_LARGE".into());
            }
            if !data.is_empty() {
                data.push(b'\n');
            }
            data.extend_from_slice(payload);
        }
    }
    Ok(())
}

fn avatar_revision(profile: &Value) -> String {
    super::digest_hex(
        profile
            .get("avatar")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .as_bytes(),
    )
}

fn merge_profile(current: &mut Value, update: &Value) {
    let Some(update) = update.as_object() else {
        return;
    };
    if !current.is_object() {
        *current = json!({});
    }
    if let Some(current) = current.as_object_mut() {
        for (key, value) in update {
            current.insert(key.clone(), value.clone());
        }
    }
}

fn refresh_profile_if_needed(
    session: &Mutex<OpenSessionResponse>,
    transport: &Arc<Transport>,
    lifecycle: &Lifecycle,
    credentials: &Credentials,
    event: &StreamEvent,
    resync: bool,
) -> Result<Option<Value>, String> {
    if event.event == "session-revoked" {
        return Ok(None);
    }
    if !resync {
        let Some(revision) = event.payload.get("avatarRevision").and_then(Value::as_str) else {
            return Ok(None);
        };
        super::parse_fingerprint(revision).map_err(|_| "WEBGATE_EVENT_INVALID")?;
        if lifecycle
            .avatar_revision
            .lock()
            .map_err(|_| "WEBGATE_SESSION_INVALID")?
            .as_str()
            == revision
        {
            return Ok(None);
        }
    }
    // Resync carries the server's actual barrier, captured before this snapshot.
    // A failed fetch leaves it uncommitted. Later events remain replayable, and
    // a retained-journal gap cannot leave cached metadata or avatars stale.
    let profile = credentials.request(
        session,
        transport,
        lifecycle,
        "command",
        &json!({
            "operationId": new_operation_id()?, "command": "get_profile_summary", "args": {}
        }),
    )?;
    if !profile.is_object() {
        return Err("WEBGATE_RESPONSE_INVALID".into());
    }
    Ok(Some(profile))
}

fn emit_state(
    session: &Mutex<OpenSessionResponse>,
    handler: &Arc<dyn Fn(StreamEvent) + Send + Sync>,
    event: &str,
    payload: Value,
) {
    let metadata = session.lock().ok().map(|session| {
        (
            session.epoch.clone(),
            session.cursor,
            session.profile_id.clone(),
        )
    });
    if let Some((epoch, cursor, profile_id)) = metadata {
        handler(StreamEvent {
            epoch,
            cursor,
            event: event.into(),
            profile_id,
            payload,
            revision: None,
        });
    }
}

fn heartbeat_loop(
    session: Arc<Mutex<OpenSessionResponse>>,
    transport: Arc<Transport>,
    lifecycle: Arc<Lifecycle>,
    credentials: Arc<Credentials>,
) {
    while !lifecycle.closed.load(Ordering::Acquire) {
        let delay = session
            .lock()
            .map(|session| session.heartbeat_seconds.clamp(5, 120))
            .unwrap_or(20);
        if !lifecycle.wait(Duration::from_secs(delay)) {
            break;
        }
        // Presence is protocol liveness, not a polling route for application data.
        // Request failures do not change the independently owned stream state.
        // Authenticated renewal already interrupts the stream when needed.
        let _ = credentials.request(
            &session,
            &transport,
            &lifecycle,
            "session/heartbeat",
            &json!({}),
        );
    }
}
