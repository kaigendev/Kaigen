//! RFC 8291/8292 Web Push. Only generic encrypted notices leave the daemon.
use crate::{
    config::Config,
    state::{now_seconds, AppState, StoredWorkspace},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    aead, agreement, digest, hkdf,
    rand::{SecureRandom, SystemRandom},
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const FILE: &str = ".web-push.json";
const MAX_SUBSCRIPTIONS: usize = 8;
const MAX_VIEW_TABS_PER_DEVICE: usize = 8;
const VIEW_TTL: Duration = Duration::from_secs(30);
const MAX_FILE_BYTES: u64 = 48 * 1024;
const MAX_VAPID_AUDIENCES: usize = 128;
const VAPID_LIFETIME_SECONDS: u64 = 12 * 3600;
const NOTIFICATION_TTL_SECONDS: u64 = 24 * 3600;
const NOTIFICATION_TOKEN_LIMIT: usize = 512;
const DIAGNOSTIC_TTL: Duration = Duration::from_secs(600);
static MANAGER: OnceLock<Mutex<Manager>> = OnceLock::new();

// Volatile, fixed-size metadata only. Never serialize the map key or generation.
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DecisionReason {
    BaselineOnly, WorkspaceNotLive, ProfileUnloaded, UnreadReadFailed,
    SettingsReadFailed, IneligibleNow, MatchingForegroundView, Queued,
    PendingMissing, SequenceSuperseded, QueueExpired, AttemptBudgetExhausted,
    TokenPreparationFailed,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum AttemptError { PreparationError, SendError, WorkerJoinError }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticDecision { at: u64, reason: DecisionReason }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticAttempt { at: u64, attempt: u8, http_status: Option<u16>, error: Option<AttemptError> }
struct PushDiagnostic {
    generation: u64,
    expires: Instant,
    coverage_since: u64,
    last_decision: Option<DiagnosticDecision>,
    last_attempt: Option<DiagnosticAttempt>,
}
fn diagnostic_entry<'a>(map: &'a mut HashMap<[u8; 32], PushDiagnostic>, sub: &Subscription) -> Option<&'a mut PushDiagnostic> {
    let now = Instant::now();
    map.retain(|_, value| value.expires > now);
    if map.get(&sub.device).is_some_and(|value| value.generation != sub.generation) {
        map.remove(&sub.device);
    }
    if !map.contains_key(&sub.device) {
        if map.len() >= MAX_SUBSCRIPTIONS { return None; }
        map.insert(sub.device, PushDiagnostic { generation: sub.generation,
            expires: now + DIAGNOSTIC_TTL, coverage_since: now_seconds() / 10 * 10,
            last_decision: None, last_attempt: None });
    }
    map.get_mut(&sub.device)
}
fn diagnostic_decision(map: &mut HashMap<[u8; 32], PushDiagnostic>, sub: &Subscription, reason: DecisionReason) {
    let Some(value) = diagnostic_entry(map, sub) else { return };
    if matches!(reason, DecisionReason::BaselineOnly | DecisionReason::ProfileUnloaded)
        && value.last_decision.as_ref().is_some_and(|old| !matches!(old.reason, DecisionReason::BaselineOnly | DecisionReason::ProfileUnloaded)) {
        return;
    }
    // Repeated maintenance snapshots must not refresh a stale decision's TTL.
    if value.last_decision.as_ref().is_some_and(|old| old.reason == reason) { return; }
    value.last_decision = Some(DiagnosticDecision { at: now_seconds() / 10 * 10, reason });
    value.expires = Instant::now() + DIAGNOSTIC_TTL;
}
fn diagnostic_all(workspace: &mut Workspace, stored: &StoredWorkspace, reason: DecisionReason) {
    for sub in workspace.disk.subscriptions.iter().filter(|sub| stored.domain.devices.contains_token_hash(&sub.device)) {
        diagnostic_decision(&mut workspace.diagnostics, sub, reason);
    }
}
fn diagnostic_prune(workspace: &mut Workspace, stored: &StoredWorkspace) {
    let now = Instant::now();
    let subscriptions = &workspace.disk.subscriptions;
    workspace.diagnostics.retain(|device, value| value.expires > now
        && stored.domain.devices.contains_token_hash(device)
        && subscriptions.iter().any(|sub| sub.device == *device && sub.generation == value.generation));
    let cutoff = now_seconds().saturating_sub(DIAGNOSTIC_TTL.as_secs());
    for value in workspace.diagnostics.values_mut() {
        if value.last_decision.as_ref().is_some_and(|last| last.at <= cutoff) { value.last_decision = None; }
        if value.last_attempt.as_ref().is_some_and(|last| last.at <= cutoff) { value.last_attempt = None; }
    }
}
fn diagnostic_job(job: &Job, reason: Option<DecisionReason>, attempt: Option<(Option<u16>, Option<AttemptError>)>) {
    let Some(manager) = MANAGER.get() else { return };
    let Ok(mut manager) = manager.try_lock() else { return };
    let Some(workspace) = manager.workspaces.get_mut(&job.root) else { return };
    if !workspace.disk.subscriptions.iter().any(|sub| sub.device == job.subscription.device
        && sub.endpoint == job.subscription.endpoint && sub.generation == job.subscription.generation) { return; }
    if let Some(reason) = reason { diagnostic_decision(&mut workspace.diagnostics, &job.subscription, reason); }
    if let Some((http_status, error)) = attempt {
        let number = workspace.pending.get(&job.subscription.endpoint)
            .filter(|pending| pending.sequence == job.sequence).map(|pending| pending.attempt);
        if let Some(number) = number {
            if let Some(value) = diagnostic_entry(&mut workspace.diagnostics, &job.subscription) {
                value.last_attempt = Some(DiagnosticAttempt { at: now_seconds() / 10 * 10, attempt: number, http_status, error });
                value.expires = Instant::now() + DIAGNOSTIC_TTL;
            }
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Keys {
    p256dh: String,
    auth: String,
}
#[derive(Clone, Deserialize, Serialize)]
struct Subscription {
    endpoint: String,
    keys: Keys,
    device: [u8; 32],
    language: String,
    generation: u64,
}
#[derive(Clone, Deserialize, Serialize)]
struct IntentRevision {
    device: [u8; 32],
    revision: u64,
}
#[derive(Clone, Deserialize, Serialize)]
struct RejectedEndpoint {
    device: [u8; 32],
    endpoint_hash: [u8; 32],
}
#[derive(Clone, Deserialize, Serialize)]
struct DiskState {
    subscriptions: Vec<Subscription>,
    routing_hint: String,
    opted_in_devices: Vec<[u8; 32]>,
    intent_revisions: Vec<IntentRevision>,
    rejected_endpoints: Vec<RejectedEndpoint>,
}
impl DiskState {
    fn endpoint_rejected(&self, device: &[u8; 32], endpoint: &str) -> bool {
        let hash = digest::digest(&digest::SHA256, endpoint.as_bytes());
        self.rejected_endpoints
            .iter()
            .any(|entry| entry.device == *device && entry.endpoint_hash.as_slice() == hash.as_ref())
    }

    fn reject_endpoint(&mut self, sub: &Subscription) {
        let hash = digest::digest(&digest::SHA256, sub.endpoint.as_bytes());
        let mut endpoint_hash = [0; 32];
        endpoint_hash.copy_from_slice(hash.as_ref());
        self.rejected_endpoints
            .retain(|entry| entry.device != sub.device);
        if self.rejected_endpoints.len() == MAX_SUBSCRIPTIONS {
            self.rejected_endpoints.remove(0);
        }
        self.rejected_endpoints.push(RejectedEndpoint {
            device: sub.device,
            endpoint_hash,
        });
    }

    fn intent_revision(&self, device: &[u8; 32]) -> u64 {
        self.intent_revisions
            .iter()
            .find(|entry| entry.device == *device)
            .map_or(0, |entry| entry.revision)
    }

    fn advance_intent_revision(&mut self, device: &[u8; 32]) -> Result<(), String> {
        let revision = self
            .intent_revision(device)
            .checked_add(1)
            .ok_or_else(fault)?;
        if let Some(entry) = self
            .intent_revisions
            .iter_mut()
            .find(|entry| entry.device == *device)
        {
            entry.revision = revision;
        } else {
            self.intent_revisions.push(IntentRevision {
                device: *device,
                revision,
            });
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Pending {
    silent: bool,
    volume: f64,
    attempt: u8,
    due: u64,
    expires: u64,
    sequence: u64,
    in_flight: bool,
    targets: Vec<(String, String)>,
}
struct Workspace {
    disk: DiskState,
    watermarks: HashMap<String, HashMap<String, u64>>,
    pending: HashMap<String, Pending>,
    next_sequence: u64,
    views: HashMap<([u8; 32], String), ForegroundView>,
    diagnostics: HashMap<[u8; 32], PushDiagnostic>,
}
struct ForegroundView {
    revision: u64,
    expires: Instant,
    target: Option<(String, String)>,
}
struct CachedVapid {
    authorization: String,
    expires_at: u64,
    created: Instant,
}
struct Manager {
    key: Arc<EcdsaKeyPair>,
    notification_key: Arc<aead::LessSafeKey>,
    public_key: String,
    subject: String,
    agent: ureq::Agent,
    vapid: Arc<Mutex<HashMap<String, CachedVapid>>>,
    workspaces: HashMap<PathBuf, Workspace>,
    in_flight: usize,
}
#[derive(Clone)]
struct Job {
    root: PathBuf,
    subscription: Subscription,
    sequence: u64,
    silent: bool,
    volume: f64,
    routing_hint: String,
    targets: Vec<(String, String)>,
    key: Arc<EcdsaKeyPair>,
    public_key: String,
    subject: String,
    agent: ureq::Agent,
    vapid: Arc<Mutex<HashMap<String, CachedVapid>>>,
}

fn fault() -> String {
    "WEB_PUSH_UNAVAILABLE".to_string()
}

fn workspace_live(stored: &StoredWorkspace) -> bool {
    let Some(runtime) = &stored.runtime else {
        return false;
    };
    if stored.domain.close_transaction.is_some() {
        return false;
    }
    let transferring = stored.domain.transfers.active().is_some() || runtime.web_transfer_active();
    stored
        .domain
        .data_lease
        .clone()
        .status(now_seconds(), transferring)
        .new_transfers_allowed
}

pub fn initialize(config: &Config) -> Result<(), String> {
    if MANAGER.get().is_some() {
        return Ok(());
    }
    let path = config.disk_root.join(".web-push-vapid.pk8");
    let rng = SystemRandom::new();
    let key_bytes = if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| fault())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 {
            return Err(fault());
        }
        fs::read(&path).map_err(|_| fault())?
    } else {
        let document = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
            .map_err(|_| fault())?;
        secure_write_new(&path, document.as_ref())?;
        document.as_ref().to_vec()
    };
    let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &key_bytes, &rng)
        .map_err(|_| fault())?;
    let token_key = hkdf::Salt::new(hkdf::HKDF_SHA256, b"kaigen-web-push-v1").extract(&key_bytes);
    let token_key = expand(&token_key, &[b"notification click target"], 32)?;
    let notification_key = aead::UnboundKey::new(&aead::CHACHA20_POLY1305, &token_key)
        .map(aead::LessSafeKey::new)
        .map_err(|_| fault())?;
    let public_key = URL_SAFE_NO_PAD.encode(key.public_key().as_ref());
    let subject = config.public_origin.clone();
    let agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .https_only(true)
        .proxy(None)
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_send_request(Some(Duration::from_secs(3)))
        .timeout_send_body(Some(Duration::from_secs(3)))
        .timeout_recv_response(Some(Duration::from_secs(3)))
        .timeout_recv_body(Some(Duration::from_secs(3)))
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .new_agent();
    MANAGER
        .set(Mutex::new(Manager {
            key: Arc::new(key),
            notification_key: Arc::new(notification_key),
            public_key,
            subject,
            agent,
            vapid: Arc::new(Mutex::new(HashMap::new())),
            workspaces: HashMap::new(),
            in_flight: 0,
        }))
        .map_err(|_| fault())
}

fn secure_write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| fault())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| fault())
}

fn endpoint(value: &str) -> Result<url::Url, String> {
    if value.len() > 4096 {
        return Err(fault());
    }
    let parsed = url::Url::parse(value).map_err(|_| fault())?;
    let host = parsed.host_str().ok_or_else(fault)?;
    let allowed = matches!(
        host,
        "fcm.googleapis.com" | "updates.push.services.mozilla.com" | "web.push.apple.com"
    ) || host.ends_with(".push.apple.com")
        || host.ends_with(".notify.windows.com");
    if !allowed
        || parsed.scheme() != "https"
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(fault());
    }
    Ok(parsed)
}

impl Manager {
    /// Loads explicit workspace consent from disk or initializes a new workspace.
    /// Browser permission and a stored endpoint cannot grant consent on their own.
    fn workspace(&mut self, root: &Path) -> Result<&mut Workspace, String> {
        if !self.workspaces.contains_key(root) {
            let path = root.join(FILE);
            let disk = match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if !metadata.is_file()
                        || metadata.file_type().is_symlink()
                        || metadata.len() > MAX_FILE_BYTES
                    {
                        return Err(fault());
                    }
                    let disk: DiskState =
                        serde_json::from_slice(&fs::read(path).map_err(|_| fault())?)
                            .map_err(|_| fault())?;
                    if disk.routing_hint.is_empty()
                        || disk.subscriptions.len() > MAX_SUBSCRIPTIONS
                        || disk.opted_in_devices.len() > MAX_SUBSCRIPTIONS
                        || disk.rejected_endpoints.len() > MAX_SUBSCRIPTIONS
                    {
                        return Err(fault());
                    }
                    for sub in &disk.subscriptions {
                        validate_subscription(sub)?;
                        if !disk.opted_in_devices.contains(&sub.device) {
                            return Err(fault());
                        }
                    }
                    disk
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let mut random = [0; 16];
                    SystemRandom::new().fill(&mut random).map_err(|_| fault())?;
                    DiskState {
                        subscriptions: Vec::new(),
                        routing_hint: URL_SAFE_NO_PAD.encode(random),
                        opted_in_devices: Vec::new(),
                        intent_revisions: Vec::new(),
                        rejected_endpoints: Vec::new(),
                    }
                }
                Err(_) => return Err(fault()),
            };
            self.workspaces.insert(
                root.to_path_buf(),
                Workspace {
                    disk,
                    watermarks: HashMap::new(),
                    pending: HashMap::new(),
                    next_sequence: 0,
                    views: HashMap::new(),
                    diagnostics: HashMap::new(),
                },
            );
        }
        self.workspaces.get_mut(root).ok_or_else(fault)
    }
}

fn validate_subscription(sub: &Subscription) -> Result<(), String> {
    endpoint(&sub.endpoint)?;
    let public = URL_SAFE_NO_PAD
        .decode(&sub.keys.p256dh)
        .map_err(|_| fault())?;
    let auth = URL_SAFE_NO_PAD
        .decode(&sub.keys.auth)
        .map_err(|_| fault())?;
    if public.len() != 65
        || public[0] != 4
        || auth.len() != 16
        || !matches!(sub.language.as_str(), "ru" | "en")
    {
        return Err(fault());
    }
    Ok(())
}

fn persist(root: &Path, disk: &DiskState) -> Result<(), String> {
    let bytes = serde_json::to_vec(disk).map_err(|_| fault())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(fault());
    }
    let path = root.join(FILE);
    if path.exists()
        && fs::symlink_metadata(&path)
            .map_err(|_| fault())?
            .file_type()
            .is_symlink()
    {
        return Err(fault());
    }
    let staging = root.join(format!(".web-push-{}.tmp", now_seconds()));
    secure_write_new(&staging, &bytes)?;
    // On Windows rename cannot replace a destination. Push service deployments
    // run on Unix; avoid destroying the old state if replacement fails.
    fs::rename(&staging, &path).map_err(|_| fault())
}

pub fn dispatch(
    stored: &mut StoredWorkspace,
    device: &[u8; 32],
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    // Revalidate a captured request after enrollment/password revocation.
    if !stored.domain.devices.contains_token_hash(device) {
        return Err("DEVICE_AUTH_INVALID".to_string());
    }
    let mut manager = MANAGER
        .get()
        .ok_or_else(fault)?
        .lock()
        .map_err(|_| fault())?;
    if command == "web_push_view" {
        return update_foreground_view(manager.workspace(&stored.active_root)?, stored, device, args);
    }
    if command == "web_push_target" {
        let notification_key = Arc::clone(&manager.notification_key);
        let workspace = manager.workspace(&stored.active_root)?;
        let matched = args.get("routingHint").and_then(Value::as_str)
            == Some(workspace.disk.routing_hint.as_str());
        let target = args
            .get("eventToken")
            .and_then(Value::as_str)
            .filter(|_| matched)
            .and_then(|token| {
                open_notification_token(
                    &notification_key,
                    device,
                    &workspace.disk.routing_hint,
                    token,
                )
            });
        return Ok(json!({ "matched": matched, "target": target }));
    }
    let public_key = manager.public_key.clone();
    let workspace = manager.workspace(&stored.active_root)?;
    let old = workspace.disk.clone();
    let old_pending = workspace.pending.clone();
    workspace
        .disk
        .subscriptions
        .retain(|sub| stored.domain.devices.contains_token_hash(&sub.device));
    workspace
        .disk
        .opted_in_devices
        .retain(|device| stored.domain.devices.contains_token_hash(device));
    workspace
        .disk
        .intent_revisions
        .retain(|entry| stored.domain.devices.contains_token_hash(&entry.device));
    workspace
        .disk
        .rejected_endpoints
        .retain(|entry| stored.domain.devices.contains_token_hash(&entry.device));
    workspace.pending.retain(|endpoint, _| {
        workspace
            .disk
            .subscriptions
            .iter()
            .any(|sub| &sub.endpoint == endpoint)
    });
    if command == "web_push_config" {
        diagnostic_prune(workspace, stored);
        let requested = args.get("endpoint").and_then(Value::as_str);
        let enabled = workspace
            .disk
            .subscriptions
            .iter()
            .any(|sub| sub.device == *device && Some(sub.endpoint.as_str()) == requested);
        let intent_enabled = workspace.disk.opted_in_devices.contains(device);
        let mut response = json!({
            "publicKey": public_key,
            "routingHint": workspace.disk.routing_hint,
            "enabled": enabled,
            "intentEnabled": intent_enabled,
            "needsRebind": intent_enabled && !enabled,
            "endpointRejected": requested.is_some_and(|value| workspace.disk.endpoint_rejected(device, value)),
            "intentRevision": workspace.disk.intent_revision(device).to_string(),
        });
        if args.get("diagnostics").and_then(Value::as_bool) == Some(true) {
            response["diagnostics"] = match workspace.diagnostics.get(device) {
                Some(value) => json!({ "retained": true, "coverageSince": value.coverage_since,
                    "lastDecision": value.last_decision, "lastAttempt": value.last_attempt }),
                None => json!({ "retained": false, "coverageSince": null, "lastDecision": null, "lastAttempt": null }),
            };
        }
        return Ok(response);
    }
    if command != "web_push_subscribe" && command != "web_push_unsubscribe" {
        return Err("COMMAND_NOT_AVAILABLE".to_string());
    }
    // Every control mutation consumes a revision. Aborted HTTP requests cannot
    // later overwrite a newer successful bind/opt-out on this device.
    let expected_revision = args
        .get("intentRevision")
        .map(|value| value.as_str().ok_or_else(fault))
        .transpose()?
        .unwrap_or("0");
    if expected_revision != workspace.disk.intent_revision(device).to_string() {
        return Err("WEB_PUSH_INTENT_CHANGED".to_string());
    }
    match command {
        "web_push_subscribe" => {
            let raw = args.get("subscription").ok_or_else(fault)?;
            let endpoint = raw
                .get("endpoint")
                .and_then(Value::as_str)
                .ok_or_else(fault)?
                .to_string();
            let keys: Keys = serde_json::from_value(raw.get("keys").cloned().ok_or_else(fault)?)
                .map_err(|_| fault())?;
            let generation = workspace
                .disk
                .subscriptions
                .iter()
                .find(|sub| sub.endpoint == endpoint)
                .map_or(1, |sub| sub.generation.saturating_add(1));
            let sub = Subscription {
                endpoint: endpoint.clone(),
                keys,
                device: *device,
                language: args
                    .get("language")
                    .and_then(Value::as_str)
                    .unwrap_or("ru")
                    .to_string(),
                generation,
            };
            validate_subscription(&sub)?;
            if workspace.disk.endpoint_rejected(device, &endpoint) {
                return Err("WEB_PUSH_ENDPOINT_EXPIRED".to_string());
            }
            if workspace
                .disk
                .subscriptions
                .iter()
                .any(|existing| existing.endpoint == endpoint && existing.device != *device)
            {
                return Err("WEB_PUSH_DEVICE_CONFLICT".to_string());
            }
            if !workspace.disk.opted_in_devices.contains(device)
                && workspace.disk.opted_in_devices.len() >= MAX_SUBSCRIPTIONS
            {
                workspace.disk = old;
                workspace.pending = old_pending;
                return Err("WEB_PUSH_SUBSCRIPTION_LIMIT".to_string());
            }
            // One workspace binding belongs to this enrolled browser device.
            // A refreshed endpoint must not leave its previous endpoint active.
            let previous_endpoints: HashSet<String> = workspace
                .disk
                .subscriptions
                .iter()
                .filter(|existing| existing.device == *device && existing.endpoint != endpoint)
                .map(|existing| existing.endpoint.clone())
                .collect();
            workspace
                .disk
                .subscriptions
                .retain(|existing| existing.device != *device);
            workspace
                .pending
                .retain(|endpoint, _| !previous_endpoints.contains(endpoint));
            if workspace.disk.subscriptions.len() >= MAX_SUBSCRIPTIONS {
                workspace.disk = old;
                workspace.pending = old_pending;
                return Err("WEB_PUSH_SUBSCRIPTION_LIMIT".to_string());
            }
            if let Err(error) = workspace.disk.advance_intent_revision(device) {
                workspace.disk = old;
                workspace.pending = old_pending;
                return Err(error);
            }
            if !workspace.disk.opted_in_devices.contains(device) {
                workspace.disk.opted_in_devices.push(*device);
            }
            workspace.disk.subscriptions.push(sub);
        }
        "web_push_unsubscribe" => {
            // Workspace opt-out applies to this authenticated device even if
            // the browser endpoint was renewed or has already disappeared.
            workspace.disk.advance_intent_revision(device)?;
            let previous_endpoints: HashSet<String> = workspace
                .disk
                .subscriptions
                .iter()
                .filter(|sub| sub.device == *device)
                .map(|sub| sub.endpoint.clone())
                .collect();
            workspace
                .disk
                .subscriptions
                .retain(|sub| sub.device != *device);
            workspace
                .disk
                .opted_in_devices
                .retain(|known| known != device);
            workspace
                .pending
                .retain(|endpoint, _| !previous_endpoints.contains(endpoint));
        }
        _ => return Err("COMMAND_NOT_AVAILABLE".to_string()),
    }
    if let Err(error) =
        persist(&stored.active_root, &workspace.disk).and_then(|_| stored.checkpoint(true))
    {
        workspace.disk = old;
        workspace.pending = old_pending;
        let _ = persist(&stored.active_root, &workspace.disk);
        return Err(error);
    }
    if command == "web_push_unsubscribe" {
        workspace.views.retain(|(owner, _), _| owner != device);
    }
    // Only a successful control transaction clears this device's old generation.
    workspace.diagnostics.remove(device);
    Ok(json!({
        "enabled": command == "web_push_subscribe",
        "intentEnabled": workspace.disk.opted_in_devices.contains(device),
        "intentRevision": workspace.disk.intent_revision(device).to_string(),
    }))
}

fn update_foreground_view(
    workspace: &mut Workspace,
    stored: &StoredWorkspace,
    device: &[u8; 32],
    args: &Value,
) -> Result<Value, String> {
    let invalid = || "WEB_PUSH_VIEW_INVALID".to_string();
    let tab = args.get("tabId").and_then(Value::as_str).ok_or_else(invalid)?;
    if tab.len() != 36 || !tab.bytes().enumerate().all(|(index, value)| {
        if matches!(index, 8 | 13 | 18 | 23) { value == b'-' } else { value.is_ascii_hexdigit() }
    }) {
        return Err(invalid());
    }
    let revision = args.get("revision").and_then(Value::as_u64)
        .filter(|value| (1..=9_007_199_254_740_991).contains(value)).ok_or_else(invalid)?;
    let target = match args.get("view") {
        Some(Value::Null) => None,
        Some(value) => {
            let profile = value.get("profileId").and_then(Value::as_str).ok_or_else(invalid)?;
            if profile.len() > 128 || !stored.domain.profiles.profiles().iter().any(|item| item.id == profile)
                || !stored.runtime.as_ref().is_some_and(|runtime| runtime.profile_loaded(profile)) {
                return Err(invalid());
            }
            let raw_target = value.get("target").and_then(Value::as_str).ok_or_else(invalid)?;
            let target = if raw_target == "requests" { "requests".to_string() }
                else { canonical_friend_target(raw_target).ok_or_else(invalid)? };
            Some((profile.to_string(), target))
        }
        None => return Err(invalid()),
    };
    let now = Instant::now();
    workspace.views.retain(|(owner, _), view| view.expires > now && stored.domain.devices.contains_token_hash(owner));
    let key = (*device, tab.to_string());
    if workspace.views.get(&key).is_some_and(|view| view.revision >= revision) {
        return Ok(json!({ "accepted": false }));
    }
    // No view state is needed for an unsubscribed device. This command cannot
    // create consent, modify a profile, or reveal another device's view.
    if !workspace.disk.opted_in_devices.contains(device) {
        workspace.views.retain(|(owner, _), _| owner != device);
        return Ok(json!({ "accepted": false }));
    }
    if !workspace.views.contains_key(&key)
        && (workspace.views.keys().filter(|(owner, _)| owner == device).count() >= MAX_VIEW_TABS_PER_DEVICE
            || workspace.views.len() >= MAX_SUBSCRIPTIONS * MAX_VIEW_TABS_PER_DEVICE) {
        return Err("WEB_PUSH_VIEW_LIMIT".to_string());
    }
    // A null target is a short-lived revision tombstone: a reordered focus
    // request cannot undo a later blur/close within the live lease.
    workspace.views.insert(key, ForegroundView { revision, expires: now + VIEW_TTL, target });
    Ok(json!({ "accepted": true }))
}

fn target_is_foreground(
    views: &HashMap<([u8; 32], String), ForegroundView>,
    device: &[u8; 32],
    target: &(String, String),
) -> bool {
    let now = Instant::now();
    views.iter().any(|((owner, _), view)| owner == device && view.expires > now
        && view.target.as_ref().is_some_and(|current| current.0 == target.0 && current.1.eq_ignore_ascii_case(&target.1)))
}

// Unread events and notification navigation share the stable contact identity contract.
// Never resolve a queued numeric slot against a possibly replaced current contact.
pub(crate) fn canonical_friend_target(target: &str) -> Option<String> {
    let key = target.strip_prefix("friend-key:")?;
    (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("friend-key:{}", key.to_ascii_uppercase()))
}

fn friend_notice(unread: &Value, target: &str) -> bool {
    let Some(target) = canonical_friend_target(target) else {
        return false;
    };
    ["friends", "pendingPeerReactionRevisionByTarget"]
        .into_iter()
        .any(|field| {
            unread
                .get(field)
                .and_then(|values| values.get(&target))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0
        })
}

fn notification_aad(device: &[u8; 32], routing_hint: &str) -> Vec<u8> {
    let mut data = device.to_vec();
    data.extend_from_slice(routing_hint.as_bytes());
    data
}

fn seal_notification_token(
    key: &aead::LessSafeKey,
    device: &[u8; 32],
    routing_hint: &str,
    target: &(String, String),
) -> Result<String, String> {
    let mut nonce = [0; aead::NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| fault())?;
    let expires = now_seconds().saturating_add(NOTIFICATION_TTL_SECONDS);
    let mut payload = serde_json::to_vec(&(expires, &target.0, &target.1)).map_err(|_| fault())?;
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(notification_aad(device, routing_hint)),
        &mut payload,
    )
    .map_err(|_| fault())?;
    let mut token = nonce.to_vec();
    token.extend(payload);
    let token = URL_SAFE_NO_PAD.encode(token);
    if token.len() > NOTIFICATION_TOKEN_LIMIT {
        return Err(fault());
    }
    Ok(token)
}

fn open_notification_token(
    key: &aead::LessSafeKey,
    device: &[u8; 32],
    routing_hint: &str,
    token: &str,
) -> Option<Value> {
    if token.len() > NOTIFICATION_TOKEN_LIMIT {
        return None;
    }
    let mut bytes = URL_SAFE_NO_PAD.decode(token).ok()?;
    let nonce = aead::Nonce::try_assume_unique_for_key(bytes.get(..aead::NONCE_LEN)?).ok()?;
    let payload = key
        .open_in_place(
            nonce,
            aead::Aad::from(notification_aad(device, routing_hint)),
            bytes.get_mut(aead::NONCE_LEN..)?,
        )
        .ok()?;
    let (expires, profile, target): (u64, String, String) = serde_json::from_slice(payload).ok()?;
    (expires > now_seconds()).then(|| json!({ "profileId": profile, "target": target }))
}

fn observe(workspace: &mut Workspace, stored: &StoredWorkspace) {
    let Some(runtime) = &stored.runtime else {
        diagnostic_all(workspace, stored, DecisionReason::WorkspaceNotLive);
        workspace.pending.clear();
        workspace.watermarks.clear();
        return;
    };
    let mut sound: Option<f64> = None;
    let mut changed = false;
    let mut targets = Vec::new();
    let mut profiles = HashSet::new();
    for profile in stored.domain.profiles.profiles() {
        if !runtime.profile_loaded(&profile.id) {
            diagnostic_all(workspace, stored, DecisionReason::ProfileUnloaded);
            continue;
        }
        profiles.insert(profile.id.clone());
        let Ok(unread) = runtime.dispatch(&profile.id, "get_unread_state", &json!({})) else {
            diagnostic_all(workspace, stored, DecisionReason::UnreadReadFailed);
            continue;
        };
        let Some(revisions) = unread
            .get("incomingEventRevisionByTarget")
            .and_then(Value::as_object)
        else {
            diagnostic_all(workspace, stored, DecisionReason::UnreadReadFailed);
            continue;
        };
        let Ok(settings) = runtime.dispatch(&profile.id, "load_local_state", &json!({})) else {
            // A failed preferences read is not an opt-out. Preserve the event
            // watermark so the next successful snapshot can notify this event.
            diagnostic_all(workspace, stored, DecisionReason::SettingsReadFailed);
            continue;
        };
        let enabled_messages = settings
            .get("notifyMessages")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let enabled_requests = settings
            .get("notifyRequests")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next: HashMap<String, u64> = revisions
            .iter()
            .filter_map(|(target, revision)| {
                revision.as_u64().map(|revision| (target.clone(), revision))
            })
            .collect();
        let previous = workspace
            .watermarks
            .insert(profile.id.clone(), next.clone());
        let Some(previous) = previous else {
            diagnostic_all(workspace, stored, DecisionReason::BaselineOnly);
            continue;
        }; // baseline, never replay backlog
        for (target, revision) in next {
            if revision <= previous.get(&target).copied().unwrap_or(0) {
                continue;
            }
            let eligible = if target == "requests" {
                enabled_requests
                    && unread
                        .get("requests")
                        .and_then(Value::as_array)
                        .is_some_and(|items| !items.is_empty())
            } else {
                enabled_messages && friend_notice(&unread, &target)
            };
            if !eligible {
                diagnostic_all(workspace, stored, DecisionReason::IneligibleNow);
                continue;
            }
            changed = true;
            if targets.len() < 256 {
                targets.push((profile.id.clone(), target.clone()));
            }
            if settings.get("notifySound").and_then(Value::as_bool) == Some(true) {
                let volume = settings
                    .get("notificationVolume")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.7)
                    .clamp(0.0, 1.0);
                if volume > 0.0 {
                    sound = Some(sound.unwrap_or(0.0).max(volume));
                }
            }
        }
    }
    workspace
        .watermarks
        .retain(|profile, _| profiles.contains(profile));
    if changed {
        workspace.next_sequence = workspace.next_sequence.saturating_add(1);
        for sub in &workspace.disk.subscriptions {
            let targets: Vec<_> = targets.iter()
                .filter(|target| !target_is_foreground(&workspace.views, &sub.device, target))
                .cloned().collect();
            // A viewed event is consumed for this device, never delayed until blur.
            // Other devices and other targets retain their notification.
            if targets.is_empty() {
                diagnostic_decision(&mut workspace.diagnostics, sub, DecisionReason::MatchingForegroundView);
                continue;
            }
            diagnostic_decision(&mut workspace.diagnostics, sub, DecisionReason::Queued);
            workspace.pending.insert(
                sub.endpoint.clone(),
                Pending {
                    silent: sound.is_none(),
                    volume: sound.unwrap_or(0.0),
                    attempt: 0,
                    due: now_seconds(),
                    expires: now_seconds() + 120,
                    sequence: workspace.next_sequence,
                    in_flight: false,
                    targets,
                },
            );
        }
    }
}

pub async fn tick(state: &Arc<AppState>) {
    let (jobs, notification_key) = {
        let Ok(inner) = state.inner.lock() else {
            return;
        };
        let Some(manager) = MANAGER.get() else { return };
        let Ok(mut manager) = manager.lock() else {
            return;
        };
        let roots: HashSet<PathBuf> = inner
            .workspaces
            .values()
            .map(|stored| stored.active_root.clone())
            .collect();
        manager.workspaces.retain(|root, _| roots.contains(root));
        let key = Arc::clone(&manager.key);
        let public_key = manager.public_key.clone();
        let subject = manager.subject.clone();
        let agent = manager.agent.clone();
        let vapid = Arc::clone(&manager.vapid);
        let slots = 4_usize.saturating_sub(manager.in_flight);
        let mut jobs = Vec::new();
        for stored in inner.workspaces.values() {
            if !workspace_live(stored) {
                if let Some(workspace) = manager.workspaces.get_mut(&stored.active_root) {
                    diagnostic_prune(workspace, stored);
                    diagnostic_all(workspace, stored, DecisionReason::WorkspaceNotLive);
                    workspace.pending.clear();
                    workspace.views.clear();
                }
                continue;
            }
            let Ok(workspace) = manager.workspace(&stored.active_root) else {
                continue;
            };
            diagnostic_prune(workspace, stored);
            let now = Instant::now();
            workspace.views.retain(|(device, _), view| view.expires > now && stored.domain.devices.contains_token_hash(device));
            workspace
                .disk
                .subscriptions
                .retain(|sub| stored.domain.devices.contains_token_hash(&sub.device));
            workspace
                .disk
                .opted_in_devices
                .retain(|device| stored.domain.devices.contains_token_hash(device));
            workspace
                .disk
                .intent_revisions
                .retain(|entry| stored.domain.devices.contains_token_hash(&entry.device));
            workspace.pending.retain(|endpoint, _| {
                workspace
                    .disk
                    .subscriptions
                    .iter()
                    .any(|sub| &sub.endpoint == endpoint)
            });
            observe(workspace, stored);
            for sub in &workspace.disk.subscriptions {
                if let Some(pending) = workspace.pending.get(&sub.endpoint) {
                    if pending.expires <= now_seconds() {
                        diagnostic_decision(&mut workspace.diagnostics, sub, DecisionReason::QueueExpired);
                    } else if pending.attempt >= 4 {
                        diagnostic_decision(&mut workspace.diagnostics, sub, DecisionReason::AttemptBudgetExhausted);
                    }
                }
            }
            workspace
                .pending
                .retain(|_, pending| pending.expires > now_seconds() && pending.attempt < 4);
            for sub in &workspace.disk.subscriptions {
                let Some(pending) = workspace.pending.get_mut(&sub.endpoint) else {
                    continue;
                };
                pending.targets.retain(|target| !target_is_foreground(&workspace.views, &sub.device, target));
                if pending.targets.is_empty() {
                    diagnostic_decision(&mut workspace.diagnostics, sub, DecisionReason::MatchingForegroundView);
                    continue;
                }
                if pending.in_flight || pending.due > now_seconds() || jobs.len() >= slots {
                    continue;
                }
                pending.in_flight = true;
                pending.attempt += 1;
                pending.due = now_seconds() + 5 * (1_u64 << pending.attempt);
                jobs.push(Job {
                    root: stored.active_root.clone(),
                    subscription: sub.clone(),
                    sequence: pending.sequence,
                    silent: pending.silent,
                    volume: pending.volume,
                    routing_hint: workspace.disk.routing_hint.clone(),
                    targets: pending.targets.clone(),
                    key: Arc::clone(&key),
                    public_key: public_key.clone(),
                    subject: subject.clone(),
                    agent: agent.clone(),
                    vapid: Arc::clone(&vapid),
                });
            }
            workspace.pending.retain(|_, pending| !pending.targets.is_empty());
        }
        manager.in_flight += jobs.len();
        (jobs, Arc::clone(&manager.notification_key))
    };
    // No network operation runs while the workspace/state mutex is held.
    for mut job in jobs {
        let state = Arc::clone(state);
        let notification_key = Arc::clone(&notification_key);
        tokio::spawn(async move {
            let _slot = SendSlot {
                root: job.root.clone(),
                endpoint: job.subscription.endpoint.clone(),
                sequence: job.sequence,
            };
            let current = state.inner.lock().ok().and_then(|inner| {
                let Some(stored) = inner
                    .workspaces
                    .values()
                    .find(|stored| stored.active_root == job.root && workspace_live(stored))
                else {
                    diagnostic_job(&job, Some(DecisionReason::WorkspaceNotLive), None);
                    return None;
                };
                if !stored
                        .domain
                        .devices
                        .contains_token_hash(&job.subscription.device)
                {
                    return None;
                }
                let mut manager = MANAGER.get()?.lock().ok()?;
                let workspace = manager.workspaces.get_mut(&job.root)?;
                if !workspace.disk.subscriptions.iter().any(|sub| {
                    sub.endpoint == job.subscription.endpoint && sub.device == job.subscription.device
                        && sub.generation == job.subscription.generation
                }) { return None; }
                let Some(pending) = workspace.pending.get_mut(&job.subscription.endpoint) else {
                    diagnostic_decision(&mut workspace.diagnostics, &job.subscription, DecisionReason::PendingMissing);
                    return None;
                };
                if pending.sequence != job.sequence {
                    diagnostic_decision(&mut workspace.diagnostics, &job.subscription, DecisionReason::SequenceSuperseded);
                    return None;
                }
                if pending.expires <= now_seconds() {
                    diagnostic_decision(&mut workspace.diagnostics, &job.subscription, DecisionReason::QueueExpired);
                    return None;
                }
                // Focus may change after scheduling. Remove viewed targets from
                // retry state as well, so leaving the chat cannot replay them.
                pending.targets.retain(|target| !target_is_foreground(&workspace.views, &job.subscription.device, target));
                let targets: Vec<_> = job.targets.iter().filter(|target| pending.targets.contains(target)).cloned().collect();
                let current = current_notification(stored, &targets);
                if current.is_none() {
                    diagnostic_decision(&mut workspace.diagnostics, &job.subscription,
                        if targets.is_empty() { DecisionReason::MatchingForegroundView } else { DecisionReason::IneligibleNow });
                }
                current
            });
            let Some((volume, target)) = current else {
                return;
            };
            let Ok(event_token) = seal_notification_token(
                &notification_key,
                &job.subscription.device,
                &job.routing_hint,
                &target,
            ) else {
                diagnostic_job(&job, Some(DecisionReason::TokenPreparationFailed), Some((None, Some(AttemptError::PreparationError))));
                return;
            };
            job.volume = volume;
            job.silent = volume <= 0.0;
            let outgoing = job.clone();
            let outcome = tokio::task::spawn_blocking(move || send(&outgoing, &event_token)).await;
            match &outcome {
                Ok(Ok(status)) => diagnostic_job(&job, None, Some((Some(*status), None))),
                // send() deliberately retains its original opaque error contract.
                Ok(Err(_)) => diagnostic_job(&job, None, Some((None, Some(AttemptError::SendError)))),
                Err(_) => diagnostic_job(&job, None, Some((None, Some(AttemptError::WorkerJoinError)))),
            }
            let status = outcome.ok().and_then(Result::ok);
            if !status
                .is_some_and(|status| (200..300).contains(&status) || matches!(status, 404 | 410))
            {
                return;
            }
            let Ok(mut inner) = state.inner.lock() else {
                return;
            };
            let Some(stored) = inner
                .workspaces
                .values_mut()
                .find(|stored| stored.active_root == job.root)
            else {
                return;
            };
            let Some(manager) = MANAGER.get() else { return };
            let Ok(mut manager) = manager.lock() else {
                return;
            };
            let Ok(workspace) = manager.workspace(&job.root) else {
                return;
            };
            if !workspace.disk.subscriptions.iter().any(|sub| {
                sub.endpoint == job.subscription.endpoint
                    && sub.device == job.subscription.device
                    && sub.generation == job.subscription.generation
            }) {
                return;
            }
            if workspace
                .pending
                .get(&job.subscription.endpoint)
                .is_some_and(|pending| pending.sequence == job.sequence)
            {
                workspace.pending.remove(&job.subscription.endpoint);
            }
            if matches!(status, Some(404 | 410)) {
                let mut next = workspace.disk.clone();
                next.subscriptions
                    .retain(|sub| sub.endpoint != job.subscription.endpoint);
                next.reject_endpoint(&job.subscription);
                if persist(&job.root, &next).is_ok() {
                    workspace.disk = next;
                    workspace.pending.remove(&job.subscription.endpoint);
                    let _ = stored.checkpoint(true);
                }
            }
        });
    }
}

struct SendSlot {
    root: PathBuf,
    endpoint: String,
    sequence: u64,
}
impl Drop for SendSlot {
    fn drop(&mut self) {
        let Some(manager) = MANAGER.get() else { return };
        let Ok(mut manager) = manager.lock() else {
            return;
        };
        manager.in_flight = manager.in_flight.saturating_sub(1);
        if let Some(workspace) = manager.workspaces.get_mut(&self.root) {
            if let Some(pending) = workspace
                .pending
                .get_mut(&self.endpoint)
                .filter(|pending| pending.sequence == self.sequence)
            {
                pending.in_flight = false;
            }
        }
    }
}

fn current_notification(
    stored: &StoredWorkspace,
    targets: &[(String, String)],
) -> Option<(f64, (String, String))> {
    let runtime = stored.runtime.as_ref()?;
    let mut volume: Option<f64> = None;
    let mut selected = None;
    for (profile, target) in targets {
        if !runtime.profile_loaded(profile) {
            continue;
        }
        let Ok(unread) = runtime.dispatch(profile, "get_unread_state", &json!({})) else {
            continue;
        };
        let Ok(settings) = runtime.dispatch(profile, "load_local_state", &json!({})) else {
            continue;
        };
        let eligible = if target == "requests" {
            settings.get("notifyRequests").and_then(Value::as_bool) == Some(true)
                && unread
                    .get("requests")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
        } else {
            settings.get("notifyMessages").and_then(Value::as_bool) == Some(true)
                && friend_notice(&unread, target)
        };
        if !eligible {
            continue;
        }
        selected.get_or_insert_with(|| (profile.clone(), target.clone()));
        let current = if settings.get("notifySound").and_then(Value::as_bool) == Some(true) {
            settings
                .get("notificationVolume")
                .and_then(Value::as_f64)
                .unwrap_or(0.7)
                .clamp(0.0, 1.0)
        } else {
            0.0
        };
        volume = Some(volume.unwrap_or(0.0).max(current));
    }
    volume.zip(selected)
}

fn vapid_authorization(job: &Job, url: &url::Url) -> Result<String, String> {
    let audience = url.origin().ascii_serialization();
    let now = now_seconds();
    // This cache belongs to one immutable manager key/subject. Reuse VAPID
    // credentials per push service instead of refreshing on every message.
    // The lock covers signing only, never a workspace lock or HTTP request.
    let mut cache = job.vapid.lock().map_err(|_| fault())?;
    cache.retain(|_, entry| {
        entry.expires_at > now.saturating_add(300)
            && entry.expires_at <= now.saturating_add(24 * 3600)
    });
    if let Some(entry) = cache.get(&audience) {
        return Ok(entry.authorization.clone());
    }
    let expires_at = now.saturating_add(VAPID_LIFETIME_SECONDS);
    let claims = json!({ "aud": audience, "exp": expires_at, "sub": job.subject });
    let token = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(b"{\"typ\":\"JWT\",\"alg\":\"ES256\"}"),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| fault())?)
    );
    let signature = job
        .key
        .sign(&SystemRandom::new(), token.as_bytes())
        .map_err(|_| fault())?;
    let authorization = format!(
        "vapid t={token}.{}, k={}",
        URL_SAFE_NO_PAD.encode(signature.as_ref()),
        job.public_key
    );
    if cache.len() >= MAX_VAPID_AUDIENCES {
        let oldest = cache
            .iter()
            .filter(|(_, entry)| entry.created.elapsed() >= Duration::from_secs(3600))
            .min_by_key(|(_, entry)| entry.expires_at)
            .map(|(audience, _)| audience.clone())
            .ok_or_else(fault)?;
        cache.remove(&oldest);
    }
    cache.insert(
        audience,
        CachedVapid {
            authorization: authorization.clone(),
            expires_at,
            created: Instant::now(),
        },
    );
    Ok(authorization)
}

fn notification_payload(
    public_origin: &str,
    language: &str,
    silent: bool,
    volume: f64,
    routing_hint: &str,
    event_token: &str,
) -> Result<Vec<u8>, String> {
    let mut navigate = url::Url::parse(public_origin).map_err(|_| fault())?;
    if navigate.scheme() != "https"
        || navigate.host_str().is_none()
        || !navigate.username().is_empty()
        || navigate.password().is_some()
        || navigate.path() != "/"
        || navigate.query().is_some()
        || navigate.fragment().is_some()
    {
        return Err(fault());
    }
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("kaigen-notification", routing_hint)
        .append_pair("kaigen-notification-event", event_token)
        .finish();
    // The public marker makes a warm same-origin activation load a document.
    // Only the fragment carries the routing data, outside the HTTP request.
    navigate.set_query(Some("kaigen-notification=1"));
    navigate.set_fragment(Some(&fragment));
    let body = if language == "en" {
        "New events in a connected profile"
    } else {
        "В подключённом профиле новые события"
    };
    // Older engines still hand this same encrypted payload to the push worker.
    serde_json::to_vec(&json!({
        "language": language,
        "silent": silent,
        "volume": volume,
        "routingHint": routing_hint,
        "eventToken": event_token,
        "web_push": 8030,
        "notification": {
            "title": "Kaigen",
            "body": body,
            "silent": silent,
            "tag": format!("kaigen-events-{routing_hint}"),
            "navigate": navigate.as_str(),
        },
    }))
    .map_err(|_| fault())
}

fn send(job: &Job, event_token: &str) -> Result<u16, String> {
    let url = endpoint(&job.subscription.endpoint)?;
    let authorization = vapid_authorization(job, &url)?;
    let payload = notification_payload(
        &job.subject,
        &job.subscription.language,
        job.silent,
        job.volume,
        &job.routing_hint,
        event_token,
    )?;
    let body = encrypt(&job.subscription.keys, &payload)?;
    // Coalesce offline alerts for the same opaque workspace target. Do not
    // expose profile names, message contents or local paths to the provider.
    let topic = URL_SAFE_NO_PAD
        .encode(digest::digest(&digest::SHA256, job.routing_hint.as_bytes()).as_ref());
    let request = job
        .agent
        .post(url.as_str())
        .header("Authorization", &authorization)
        // Visible incoming messages should wake a dormant device. Keep a
        // bounded offline delivery window; this is not a session lifetime.
        .header("TTL", &NOTIFICATION_TTL_SECONDS.to_string())
        .header("Urgency", "high")
        .header("Topic", &topic[..32])
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream");
    let request = if url
        .host_str()
        .is_some_and(|host| host.ends_with(".notify.windows.com"))
    {
        request.header("X-WNS-Type", "wns/raw")
    } else {
        request
    };
    match request.send(body.as_slice()) {
        Ok(response) => Ok(response.status().as_u16()),
        Err(ureq::Error::StatusCode(status)) => Ok(status),
        Err(_) => Err(fault()),
    }
}

#[cfg(test)]
mod local_apple_web_push;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declarative_notification_keeps_legacy_fields_and_routes_same_origin() {
        let payload = notification_payload(
            "https://kaigen.test:8443",
            "en",
            true,
            0.25,
            "fixture-hint",
            "fixture-token",
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["language"], "en");
        assert_eq!(value["silent"], true);
        assert_eq!(value["volume"], 0.25);
        assert_eq!(value["routingHint"], "fixture-hint");
        assert_eq!(value["eventToken"], "fixture-token");
        assert_eq!(value["web_push"], 8030);
        assert!(value.get("mutable").is_none());
        assert_eq!(value["notification"], json!({
            "title": "Kaigen",
            "body": "New events in a connected profile",
            "silent": true,
            "tag": "kaigen-events-fixture-hint",
            "navigate": "https://kaigen.test:8443/?kaigen-notification=1#kaigen-notification=fixture-hint&kaigen-notification-event=fixture-token",
        }));
        for invalid in [
            "http://kaigen.test",
            "https://kaigen.test/path",
            "https://user@kaigen.test",
            "https://kaigen.test/?q=1",
        ] {
            assert!(
                notification_payload(invalid, "en", false, 0.0, "fixture-hint", "fixture-token")
                    .is_err()
            );
        }
    }
}

struct Length(usize);
impl hkdf::KeyType for Length {
    fn len(&self) -> usize {
        self.0
    }
}
fn expand(prk: &hkdf::Prk, info: &[&[u8]], length: usize) -> Result<Vec<u8>, String> {
    let mut output = vec![0; length];
    prk.expand(info, Length(length))
        .map_err(|_| fault())?
        .fill(&mut output)
        .map_err(|_| fault())?;
    Ok(output)
}
fn encrypt(keys: &Keys, payload: &[u8]) -> Result<Vec<u8>, String> {
    let rng = SystemRandom::new();
    let public = URL_SAFE_NO_PAD.decode(&keys.p256dh).map_err(|_| fault())?;
    let auth = URL_SAFE_NO_PAD.decode(&keys.auth).map_err(|_| fault())?;
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| fault())?;
    let sender = private.compute_public_key().map_err(|_| fault())?;
    let secret = agreement::agree_ephemeral(
        private,
        &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &public),
        |shared| {
            let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &auth).extract(shared);
            expand(&prk, &[b"WebPush: info\0", &public, sender.as_ref()], 32)
        },
    )
    .map_err(|_| fault())??;
    let mut salt = [0; 16];
    rng.fill(&mut salt).map_err(|_| fault())?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(&secret);
    let cek = expand(&prk, &[b"Content-Encoding: aes128gcm\0"], 16)?;
    let nonce = expand(&prk, &[b"Content-Encoding: nonce\0"], 12)?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_128_GCM, &cek).map_err(|_| fault())?,
    );
    let mut ciphertext = payload.to_vec();
    ciphertext.push(2); // final record delimiter, RFC 8188
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| fault())?;
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::empty(),
        &mut ciphertext,
    )
    .map_err(|_| fault())?;
    let mut output = Vec::with_capacity(86 + ciphertext.len());
    output.extend_from_slice(&salt);
    output.extend_from_slice(&4096_u32.to_be_bytes());
    output.push(65);
    output.extend_from_slice(sender.as_ref());
    output.extend_from_slice(&ciphertext);
    Ok(output)
}
