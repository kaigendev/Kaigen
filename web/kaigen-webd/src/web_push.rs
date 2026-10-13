//! RFC 8291/8292 Web Push. Only generic encrypted notices leave the daemon.
use crate::{
    config::Config,
    state::{now_seconds, AppState, StoredWorkspace},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    aead, agreement, hkdf,
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
    time::Duration,
};

const FILE: &str = ".web-push.json";
const MAX_SUBSCRIPTIONS: usize = 8;
const MAX_FILE_BYTES: u64 = 48 * 1024;
static MANAGER: OnceLock<Mutex<Manager>> = OnceLock::new();

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
#[derive(Default, Deserialize, Serialize)]
struct DiskState {
    subscriptions: Vec<Subscription>,
    #[serde(default)]
    routing_hint: String,
}
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
}
struct Manager {
    key: Arc<EcdsaKeyPair>,
    public_key: String,
    subject: String,
    agent: ureq::Agent,
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
    let public_key = URL_SAFE_NO_PAD.encode(key.public_key().as_ref());
    let subject = if config.public_origin.starts_with("https://") {
        config.public_origin.clone()
    } else {
        "https://kaigen.one".to_string()
    };
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .https_only(true)
        .try_proxy_from_env(false)
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(3))
        .timeout_write(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build();
    MANAGER
        .set(Mutex::new(Manager {
            key: Arc::new(key),
            public_key,
            subject,
            agent,
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
    fn workspace(&mut self, root: &Path) -> Result<&mut Workspace, String> {
        if !self.workspaces.contains_key(root) {
            let path = root.join(FILE);
            let mut disk = if path.exists() {
                let metadata = fs::symlink_metadata(&path).map_err(|_| fault())?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > MAX_FILE_BYTES
                {
                    return Err(fault());
                }
                let disk: DiskState = serde_json::from_slice(&fs::read(path).map_err(|_| fault())?)
                    .map_err(|_| fault())?;
                if disk.subscriptions.len() > MAX_SUBSCRIPTIONS {
                    return Err(fault());
                }
                for sub in &disk.subscriptions {
                    validate_subscription(sub)?;
                }
                disk
            } else {
                DiskState::default()
            };
            if disk.routing_hint.is_empty() {
                let mut random = [0; 16];
                SystemRandom::new().fill(&mut random).map_err(|_| fault())?;
                disk.routing_hint = URL_SAFE_NO_PAD.encode(random);
            }
            self.workspaces.insert(
                root.to_path_buf(),
                Workspace {
                    disk,
                    watermarks: HashMap::new(),
                    pending: HashMap::new(),
                    next_sequence: 0,
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
    let mut manager = MANAGER
        .get()
        .ok_or_else(fault)?
        .lock()
        .map_err(|_| fault())?;
    if command == "web_push_target" {
        let workspace = manager.workspace(&stored.active_root)?;
        let matched = args.get("routingHint").and_then(Value::as_str)
            == Some(workspace.disk.routing_hint.as_str());
        return Ok(
            json!({ "matched": matched, "target": if matched { notification_target(stored)? } else { Value::Null } }),
        );
    }
    if command == "web_push_config" {
        let public_key = manager.public_key.clone();
        let workspace = manager.workspace(&stored.active_root)?;
        let requested = args.get("endpoint").and_then(Value::as_str);
        let enabled = workspace
            .disk
            .subscriptions
            .iter()
            .any(|sub| sub.device == *device && Some(sub.endpoint.as_str()) == requested);
        return Ok(json!({ "publicKey": public_key, "enabled": enabled }));
    }
    let workspace = manager.workspace(&stored.active_root)?;
    let old = workspace.disk.subscriptions.clone();
    workspace
        .disk
        .subscriptions
        .retain(|sub| stored.domain.devices.contains_token_hash(&sub.device));
    workspace.pending.retain(|endpoint, _| {
        workspace
            .disk
            .subscriptions
            .iter()
            .any(|sub| &sub.endpoint == endpoint)
    });
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
            if workspace
                .disk
                .subscriptions
                .iter()
                .any(|existing| existing.endpoint == endpoint && existing.device != *device)
            {
                return Err("WEB_PUSH_DEVICE_CONFLICT".to_string());
            }
            workspace
                .disk
                .subscriptions
                .retain(|existing| existing.endpoint != endpoint);
            if workspace.disk.subscriptions.len() >= MAX_SUBSCRIPTIONS {
                workspace.disk.subscriptions = old;
                return Err("WEB_PUSH_SUBSCRIPTION_LIMIT".to_string());
            }
            workspace.disk.subscriptions.push(sub);
        }
        "web_push_unsubscribe" => {
            let value = args
                .get("endpoint")
                .and_then(Value::as_str)
                .ok_or_else(fault)?;
            if !workspace
                .disk
                .subscriptions
                .iter()
                .any(|sub| sub.endpoint == value && sub.device == *device)
            {
                return Ok(json!({ "enabled": false }));
            }
            workspace
                .disk
                .subscriptions
                .retain(|sub| !(sub.endpoint == value && sub.device == *device));
            workspace.pending.remove(value);
        }
        _ => return Err("COMMAND_NOT_AVAILABLE".to_string()),
    }
    if let Err(error) =
        persist(&stored.active_root, &workspace.disk).and_then(|_| stored.checkpoint(true))
    {
        workspace.disk.subscriptions = old;
        let _ = persist(&stored.active_root, &workspace.disk);
        return Err(error);
    }
    Ok(json!({ "enabled": command == "web_push_subscribe" }))
}

fn notification_target(stored: &StoredWorkspace) -> Result<Value, String> {
    let Some(runtime) = &stored.runtime else {
        return Ok(Value::Null);
    };
    for profile in stored.domain.profiles.profiles() {
        if !runtime.profile_loaded(&profile.id) {
            continue;
        }
        let state = runtime.dispatch(&profile.id, "get_unread_state", &json!({}))?;
        if state
            .get("requests")
            .and_then(Value::as_array)
            .is_some_and(|requests| !requests.is_empty())
        {
            return Ok(json!({ "profileId": profile.id, "target": "requests" }));
        }
        let Some(friends) = state.get("friends").and_then(Value::as_object) else {
            continue;
        };
        let snapshot = runtime.dispatch(&profile.id, "get_tox_friends", &json!({}))?;
        for friend in snapshot.as_array().into_iter().flatten() {
            let number = friend
                .get("number")
                .and_then(Value::as_u64)
                .map(|value| value.to_string())
                .unwrap_or_default();
            if let Some(key) = friend
                .get("public_key")
                .and_then(Value::as_str)
                .filter(|key| key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
            {
                let reaction = state
                    .get("pendingPeerReactionRevisionByTarget")
                    .and_then(|values| {
                        values.get(format!("friend-key:{}", key.to_ascii_uppercase()))
                    })
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > 0;
                if friends.get(&number).and_then(Value::as_u64).unwrap_or(0) == 0 && !reaction {
                    continue;
                }
                return Ok(
                    json!({ "profileId": profile.id, "target": format!("friend-key:{key}") }),
                );
            }
        }
    }
    Ok(Value::Null)
}

fn friend_notice(stored: &StoredWorkspace, profile: &str, unread: &Value, number: &str) -> bool {
    if unread
        .get("friends")
        .and_then(|friends| friends.get(number))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        return true;
    }
    let Some(reactions) = unread
        .get("pendingPeerReactionRevisionByTarget")
        .and_then(Value::as_object)
        .filter(|values| !values.is_empty())
    else {
        return false;
    };
    if reactions
        .get(&format!("friend-number:{number}"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        return true;
    }
    let Some(runtime) = &stored.runtime else {
        return false;
    };
    let Ok(friends) = runtime.dispatch(profile, "get_tox_friends", &json!({})) else {
        return false;
    };
    friends.as_array().into_iter().flatten().any(|friend| {
        if friend
            .get("number")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .as_deref()
            != Some(number)
        {
            return false;
        }
        friend
            .get("public_key")
            .and_then(Value::as_str)
            .is_some_and(|key| {
                reactions
                    .get(&format!("friend-key:{}", key.to_ascii_uppercase()))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > 0
            })
    })
}

fn observe(workspace: &mut Workspace, stored: &StoredWorkspace) {
    let Some(runtime) = &stored.runtime else {
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
            continue;
        }
        profiles.insert(profile.id.clone());
        let Ok(unread) = runtime.dispatch(&profile.id, "get_unread_state", &json!({})) else {
            continue;
        };
        let Some(revisions) = unread
            .get("incomingEventRevisionByTarget")
            .and_then(Value::as_object)
        else {
            continue;
        };
        let settings = runtime
            .dispatch(&profile.id, "load_local_state", &json!({}))
            .unwrap_or(Value::Null);
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
        let Some(previous) = previous else { continue }; // baseline, never replay backlog
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
            } else if let Some(number) = target.strip_prefix("friend-number:") {
                enabled_messages && friend_notice(stored, &profile.id, &unread, number)
            } else {
                false
            };
            if !eligible {
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
                    targets: targets.clone(),
                },
            );
        }
    }
}

pub async fn tick(state: &Arc<AppState>) {
    let jobs = {
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
        let slots = 4_usize.saturating_sub(manager.in_flight);
        let mut jobs = Vec::new();
        for stored in inner.workspaces.values() {
            if !workspace_live(stored) {
                if let Some(workspace) = manager.workspaces.get_mut(&stored.active_root) {
                    workspace.pending.clear();
                }
                continue;
            }
            let Ok(workspace) = manager.workspace(&stored.active_root) else {
                continue;
            };
            workspace
                .disk
                .subscriptions
                .retain(|sub| stored.domain.devices.contains_token_hash(&sub.device));
            workspace.pending.retain(|endpoint, _| {
                workspace
                    .disk
                    .subscriptions
                    .iter()
                    .any(|sub| &sub.endpoint == endpoint)
            });
            observe(workspace, stored);
            workspace
                .pending
                .retain(|_, pending| pending.expires > now_seconds() && pending.attempt < 4);
            for sub in &workspace.disk.subscriptions {
                let Some(pending) = workspace.pending.get_mut(&sub.endpoint) else {
                    continue;
                };
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
                });
            }
        }
        manager.in_flight += jobs.len();
        jobs
    };
    // No network operation runs while the workspace/state mutex is held.
    for mut job in jobs {
        let state = Arc::clone(state);
        tokio::spawn(async move {
            let _slot = SendSlot {
                root: job.root.clone(),
                endpoint: job.subscription.endpoint.clone(),
                sequence: job.sequence,
            };
            let current_volume = state.inner.lock().ok().and_then(|inner| {
                let Some(stored) = inner
                    .workspaces
                    .values()
                    .find(|stored| stored.active_root == job.root && workspace_live(stored))
                else {
                    return None;
                };
                let bound = MANAGER
                    .get()
                    .and_then(|manager| manager.lock().ok())
                    .is_some_and(|manager| {
                        manager.workspaces.get(&job.root).is_some_and(|workspace| {
                            workspace.disk.subscriptions.iter().any(|sub| {
                                sub.endpoint == job.subscription.endpoint
                                    && sub.device == job.subscription.device
                                    && sub.generation == job.subscription.generation
                            }) && workspace
                                .pending
                                .get(&job.subscription.endpoint)
                                .is_some_and(|pending| {
                                    pending.sequence == job.sequence
                                        && pending.expires > now_seconds()
                                })
                        })
                    });
                if !bound
                    || !stored
                        .domain
                        .devices
                        .contains_token_hash(&job.subscription.device)
                {
                    return None;
                }
                current_sound(stored, &job.targets)
            });
            let Some(volume) = current_volume else { return };
            job.volume = volume;
            job.silent = volume <= 0.0;
            let outgoing = job.clone();
            let status = tokio::task::spawn_blocking(move || send(&outgoing))
                .await
                .ok()
                .and_then(Result::ok);
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
                workspace
                    .disk
                    .subscriptions
                    .retain(|sub| sub.endpoint != job.subscription.endpoint);
                let _ = persist(&job.root, &workspace.disk).and_then(|_| stored.checkpoint(true));
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

fn current_sound(stored: &StoredWorkspace, targets: &[(String, String)]) -> Option<f64> {
    let runtime = stored.runtime.as_ref()?;
    let mut volume: Option<f64> = None;
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
        } else if let Some(number) = target.strip_prefix("friend-number:") {
            settings.get("notifyMessages").and_then(Value::as_bool) == Some(true)
                && friend_notice(stored, profile, &unread, number)
        } else {
            false
        };
        if !eligible {
            continue;
        }
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
    volume
}

fn send(job: &Job) -> Result<u16, String> {
    let url = endpoint(&job.subscription.endpoint)?;
    let claims = json!({ "aud": url.origin().ascii_serialization(), "exp": now_seconds() + 3600, "sub": job.subject });
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
    let payload = serde_json::to_vec(&json!({ "language": job.subscription.language, "silent": job.silent, "volume": job.volume, "routingHint": job.routing_hint })).map_err(|_| fault())?;
    let body = encrypt(&job.subscription.keys, &payload)?;
    let request = job
        .agent
        .post(url.as_str())
        .set("Authorization", &authorization)
        .set("TTL", "120")
        .set("Urgency", "normal")
        .set("Content-Encoding", "aes128gcm")
        .set("Content-Type", "application/octet-stream");
    let request = if url
        .host_str()
        .is_some_and(|host| host.ends_with(".notify.windows.com"))
    {
        request.set("X-WNS-Type", "wns/raw")
    } else {
        request
    };
    match request.send_bytes(&body) {
        Ok(response) => Ok(response.status()),
        Err(ureq::Error::Status(status, _)) => Ok(status),
        Err(_) => Err(fault()),
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
