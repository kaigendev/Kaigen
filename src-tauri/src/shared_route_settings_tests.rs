use super::*;
use crate::desktop_adapter::{apply_shared_network_settings, apply_shared_proxy_settings};
use std::cell::RefCell;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq)]
struct Options {
    udp: bool,
    ipv6: bool,
    discovery: bool,
    proxy_type: i32,
    proxy_port: u16,
}

thread_local! {
    static OPTIONS: RefCell<HashMap<PathBuf, Options>> = RefCell::new(HashMap::new());
    static REBUILD_FAULTS: RefCell<HashMap<PathBuf, (usize, usize)>> = RefCell::new(HashMap::new());
    static REBUILD_PAUSE: RefCell<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> = RefCell::new(None);
}

pub(super) fn record_options(path: &Path, options: *mut c_void) {
    let value = Options {
        udp: unsafe { tox_options_get_udp_enabled(options) },
        ipv6: unsafe { tox_options_get_ipv6_enabled(options) },
        discovery: unsafe { tox_options_get_local_discovery_enabled(options) },
        proxy_type: unsafe { tox_options_get_proxy_type(options) },
        proxy_port: unsafe { tox_options_get_proxy_port(options) },
    };
    OPTIONS.with(|values| values.borrow_mut().insert(path.to_path_buf(), value));
}

fn writing(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap().to_os_string();
    name.push(".writing");
    path.with_file_name(name)
}

// The hook creates a real IO refusal on the selected rollback save, scoped
// to this test thread and exact disposable profile; no native call is mocked.
pub(super) fn before_rebuild(state: &ToxState) -> Result<(), String> {
    let path = state
        .handle
        .lock()
        .map_err(|_| "TEST_HANDLE_UNAVAILABLE")?
        .as_ref()
        .ok_or("TEST_HANDLE_MISSING")?
        .profile_path
        .clone();
    if let Some((entered, resume)) = REBUILD_PAUSE.with(|value| value.borrow_mut().take()) {
        entered.send(()).map_err(|error| error.to_string())?;
        resume
            .recv_timeout(Duration::from_secs(3))
            .map_err(|error| error.to_string())?;
    }
    let refuse = REBUILD_FAULTS.with(|faults| {
        let mut faults = faults.borrow_mut();
        match faults.get_mut(&path) {
            Some((call, at)) => {
                *call += 1;
                *call == *at
            }
            None => false,
        }
    });
    if refuse {
        fs::create_dir(writing(&path)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn record_native_runtime() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetModuleHandleW(name: *const u16) -> *mut c_void;
            fn GetModuleFileNameW(module: *mut c_void, path: *mut u16, size: u32) -> u32;
        }
        let name = "toxcore.dll\0".encode_utf16().collect::<Vec<_>>();
        let module = unsafe { GetModuleHandleW(name.as_ptr()) };
        assert!(!module.is_null(), "actual toxcore module must be loaded");
        let mut path = vec![0u16; 32768];
        let length =
            unsafe { GetModuleFileNameW(module, path.as_mut_ptr(), path.len() as u32) } as usize;
        assert!(length > 0 && length < path.len());
        let path = String::from_utf16(&path[..length]).unwrap();
        println!("SHARED_ROUTE_NATIVE_RUNTIME_PATH={path}");
    });
}

struct Fixture {
    root: PathBuf,
    managed: bool,
    gate: Arc<Mutex<bool>>,
    tor: TorManager,
    proxy: Arc<Mutex<ProxySettings>>,
    network: Arc<Mutex<NetworkSettings>>,
    states: Vec<Arc<ToxState>>,
    identities: Vec<String>,
    queues: Vec<serde_json::Value>,
}

impl Fixture {
    fn new(label: &str) -> Self {
        Self::with_storage(label, false)
    }

    fn with_storage(label: &str, managed: bool) -> Self {
        #[cfg(target_os = "windows")]
        record_native_runtime();
        OPTIONS.with(|values| values.borrow_mut().clear());
        REBUILD_FAULTS.with(|values| values.borrow_mut().clear());
        let root = std::env::temp_dir().join(format!(
            "kaigen-shared-route-{label}-{}-{}",
            std::process::id(),
            unix_timestamp_nanos()
        ));
        let data = root.join("data");
        fs::create_dir_all(data.join("logs")).unwrap();
        atomic_write(
            &data.join("tor-settings.json"),
            br#"{"enabled":false,"transport":"none","bridgeLines":""}"#,
        )
        .unwrap();
        let tor = TorManager::new(root.clone(), data.clone(), data.join("logs")).unwrap();
        let proxy = Arc::new(Mutex::new(ProxySettings::default()));
        let network = Arc::new(Mutex::new(NetworkSettings::default()));
        atomic_write(
            &data.join("proxy-settings.json"),
            &serde_json::to_vec_pretty(&*proxy.lock().unwrap()).unwrap(),
        )
        .unwrap();
        atomic_write(
            &data.join("network-settings.json"),
            &serde_json::to_vec_pretty(&*network.lock().unwrap()).unwrap(),
        )
        .unwrap();
        let mut fixture = Self {
            root,
            managed,
            gate: Arc::new(Mutex::new(false)),
            tor,
            proxy,
            network,
            states: Vec::new(),
            identities: Vec::new(),
            queues: Vec::new(),
        };
        fixture.open_states();
        initialize_created_profile_offline(&fixture.states[0]).unwrap();
        fixture.states[1].save_network_enabled(true).unwrap();
        for (index, state) in fixture.states.iter().enumerate() {
            let handle_guard = state.handle.lock().unwrap();
            let handle = handle_guard.as_ref().unwrap();
            let key = [0x55 + index as u8; 32];
            let mut error = 0;
            let friend = unsafe {
                tox_friend_add_norequest(handle.instance.as_ptr(), key.as_ptr(), &mut error)
            };
            assert_eq!(error, 0);
            ToxState::save(handle).unwrap();
            drop(handle_guard);
            let public_key = hex_upper(&key);
            let pending: PendingToxMessage = serde_json::from_value(serde_json::json!({
                "id": format!("text-{index}"), "friend_number": friend,
                "friend_public_key": public_key, "text": "synthetic pending", "timestamp": 1
            }))
            .unwrap();
            let file_path = state.outgoing_files_dir.join("canary.txt");
            atomic_write(&file_path, b"queue-canary").unwrap();
            let file: PendingToxFile = serde_json::from_value(serde_json::json!({
                "id": format!("file-{index}"), "friend_number": friend, "friend_public_key": public_key,
                "filename":"canary.txt", "mime":"text/plain", "path":file_path.to_string_lossy(), "size":12,"timestamp":1
            })).unwrap();
            state.pending_messages.lock().unwrap().push(pending.clone());
            state.pending_pq_messages.lock().unwrap().push(pending);
            state.pending_files.lock().unwrap().push(file);
            for (path, contents) in [
                (
                    &state.pending_messages_path,
                    serde_json::to_vec(&*state.pending_messages.lock().unwrap()).unwrap(),
                ),
                (
                    &state.pending_pq_messages_path,
                    serde_json::to_vec(&*state.pending_pq_messages.lock().unwrap()).unwrap(),
                ),
                (
                    &state.pending_files_path,
                    serde_json::to_vec(&*state.pending_files.lock().unwrap()).unwrap(),
                ),
            ] {
                atomic_write(path, &contents).unwrap();
            }
        }
        fixture.identities = fixture.states.iter().map(|state| identity(state)).collect();
        fixture.queues = fixture.states.iter().map(|state| queues(state)).collect();
        for state in &fixture.states {
            state.checkpoint_profile(true).unwrap();
        }
        fixture
    }

    fn open_states(&mut self) {
        for name in ["first", "second"] {
            let volume = if self.managed {
                let container = self.root.join(format!("profiles/{name}/{name}.kai"));
                Some(if container.exists() {
                    KaiProfileVolume::open(container, None).unwrap()
                } else {
                    KaiProfileVolume::create(container, None).unwrap()
                })
            } else {
                None
            };
            let (profile_path, data_dir) = match &volume {
                Some(volume) => (
                    volume.namespace_root().join("profile.tox"),
                    volume.namespace_root().join("data"),
                ),
                None => (
                    self.root.join(format!("profiles/{name}/{name}.tox")),
                    self.root.join(format!("profiles/{name}/data")),
                ),
            };
            let savedata = profiles::read_file(&profile_path).ok();
            self.states.push(Arc::new(
                ToxState::new_for_profile(
                    ProfilePaths::new_with_volume(
                        self.root.clone(),
                        data_dir,
                        profile_path,
                        volume,
                    )
                    .unwrap(),
                    self.tor.clone(),
                    Arc::clone(&self.proxy),
                    Arc::clone(&self.network),
                    None,
                    savedata,
                    None,
                    Some(name),
                )
                .unwrap()
                .with_shared_route_gate(Arc::clone(&self.gate)),
            ));
        }
    }

    fn path(&self, index: usize) -> PathBuf {
        self.states[index]
            .handle
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .profile_path
            .clone()
    }

    fn network_path(&self) -> PathBuf {
        self.root.join("data/network-settings.json")
    }
    fn proxy_path(&self) -> PathBuf {
        self.root.join("data/proxy-settings.json")
    }

    fn change(&self, proxy: bool) -> Result<(), String> {
        if proxy {
            apply_shared_proxy_settings(
                &self.gate,
                &self.proxy,
                &self.proxy_path(),
                &self.states,
                false,
                requested_proxy(),
            )
            .map(|_| ())
        } else {
            apply_shared_network_settings(
                &self.gate,
                &self.network,
                &self.network_path(),
                &self.states,
                requested_network(),
            )
            .map(|_| ())
        }
    }

    fn stable(&self, changed: bool, proxy_change: bool) {
        let network = if changed && !proxy_change {
            requested_network()
        } else {
            NetworkSettings::default()
        };
        let proxy = if changed && proxy_change {
            requested_proxy()
        } else {
            ProxySettings::default()
        };
        self.stable_values(network, proxy);
    }

    fn stable_values(&self, network: NetworkSettings, proxy: ProxySettings) {
        assert_eq!(*self.network.lock().unwrap(), network);
        assert!(*self.proxy.lock().unwrap() == proxy);
        assert_eq!(
            serde_json::from_slice::<NetworkSettings>(&fs::read(self.network_path()).unwrap())
                .unwrap(),
            network
        );
        assert!(
            serde_json::from_slice::<ProxySettings>(&fs::read(self.proxy_path()).unwrap()).unwrap()
                == proxy
        );
        for (index, state) in self.states.iter().enumerate() {
            assert_eq!(
                identity(state),
                self.identities[index],
                "native identity/friend list"
            );
            assert_eq!(
                queues(state),
                self.queues[index],
                "text/PQ/file memory queues"
            );
            for (path, value) in [
                (&state.pending_messages_path, &self.queues[index]["text"]),
                (&state.pending_pq_messages_path, &self.queues[index]["pq"]),
                (&state.pending_files_path, &self.queues[index]["files"]),
            ] {
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(
                        &profiles::read_file(path).unwrap()
                    )
                    .unwrap(),
                    *value
                );
            }
            assert_eq!(
                state.network_enabled.load(Ordering::Acquire),
                index == 1,
                "explicit offline remains offline"
            );
            let actual = OPTIONS.with(|values| values.borrow()[&self.path(index)].clone());
            assert_eq!(
                actual,
                Options {
                    udp: network.udp_enabled && proxy.mode == "none",
                    ipv6: network.ipv6_enabled,
                    discovery: network.local_discovery_enabled
                        && network.udp_enabled
                        && proxy.mode == "none",
                    proxy_type: if proxy.mode == "none" { 0 } else { 2 },
                    proxy_port: if proxy.mode == "none" { 0 } else { proxy.port },
                },
                "actual native creation options"
            );
        }
    }

    fn restart(&mut self) {
        self.gate = Arc::new(Mutex::new(false));
        for state in &self.states {
            state.stop();
            chat_history_store::unregister(&state.history_path);
        }
        self.states.clear();
        flush_deferred_profile_writes().unwrap();
        self.proxy = Arc::new(Mutex::new(
            serde_json::from_slice(&fs::read(self.proxy_path()).unwrap()).unwrap(),
        ));
        self.network = Arc::new(Mutex::new(
            serde_json::from_slice(&fs::read(self.network_path()).unwrap()).unwrap(),
        ));
        self.open_states();
    }

    fn cold_restart(&mut self) {
        assert!(self.managed);
        for state in &self.states {
            state.profile_volume.as_ref().unwrap().discard();
        }
        self.restart();
    }
}

fn unix_timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
fn identity(state: &ToxState) -> String {
    let guard = state.handle.lock().unwrap();
    let handle = guard.as_ref().unwrap();
    let mut address = [0u8; 38];
    unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
    format!(
        "{}:{:?}",
        hex_upper(&address),
        tox_friend_numbers_by_public_key(handle.instance.as_ptr())
    )
}
fn queues(state: &ToxState) -> serde_json::Value {
    serde_json::json!({
        "text": &*state.pending_messages.lock().unwrap(),
        "pq": &*state.pending_pq_messages.lock().unwrap(),
        "files": &*state.pending_files.lock().unwrap()
    })
}
fn requested_network() -> NetworkSettings {
    NetworkSettings {
        udp_enabled: false,
        ipv6_enabled: false,
        local_discovery_enabled: false,
    }
}
fn requested_proxy() -> ProxySettings {
    ProxySettings {
        mode: "socks5".to_string(),
        host: "127.0.0.1".to_string(),
        port: 9,
        username: String::new(),
        password: String::new(),
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        REBUILD_FAULTS.with(|values| values.borrow_mut().clear());
        for state in &self.states {
            state.stop();
            chat_history_store::unregister(&state.history_path);
        }
        self.states.clear();
        let _ = flush_deferred_profile_writes();
        assert!(
            self.root.starts_with(std::env::temp_dir())
                && self
                    .root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("kaigen-shared-route-")
        );
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn refusal_matrix(proxy: bool) {
    for fault in ["success", "second-profile", "settings-file"] {
        let mut fixture = Fixture::new(&format!("matrix-{proxy}-{fault}"));
        fixture.stable(false, proxy);
        let refused = match fault {
            "second-profile" => Some(writing(&fixture.path(1))),
            "settings-file" => Some(writing(&if proxy {
                fixture.proxy_path()
            } else {
                fixture.network_path()
            })),
            _ => None,
        };
        if let Some(path) = &refused {
            fs::create_dir(path).unwrap();
        }
        let result = fixture.change(proxy);
        if fault == "success" {
            result.unwrap();
        } else {
            assert!(result.is_err());
        }
        fixture.stable(fault == "success", proxy);
        if let Some(path) = &refused {
            fs::remove_dir(path).unwrap();
            fixture.change(proxy).unwrap();
            fixture.stable(true, proxy);
        }
        fixture.restart();
        fixture.stable(true, proxy);
    }
}

fn rollback_refusal(proxy: bool) {
    let mut fixture = Fixture::new(&format!("rollback-{proxy}"));
    fs::create_dir(writing(&fixture.path(1))).unwrap();
    REBUILD_FAULTS.with(|values| values.borrow_mut().insert(fixture.path(0), (0, 2)));
    let error = fixture.change(proxy).unwrap_err();
    assert!(error.contains("SHARED_ROUTE_ROLLBACK_FAILED"), "{error}");
    for state in &fixture.states {
        assert!(
            !state.running.load(Ordering::Acquire),
            "incoherent route must stop"
        );
        assert!(
            !state.network_enabled.load(Ordering::Acquire),
            "no active mixed route/fallback"
        );
    }
    assert_eq!(
        fixture.change(proxy).unwrap_err(),
        "SHARED_ROUTE_RESTART_REQUIRED"
    );
    for state in &fixture.states {
        let generation = state.handle_generation.load(Ordering::SeqCst);
        assert_eq!(
            state.rebuild_network_route().unwrap_err(),
            "SHARED_ROUTE_RESTART_REQUIRED"
        );
        assert_eq!(
            state
                .rebuild_network_route_if_stalled(Some(generation))
                .unwrap_err(),
            "SHARED_ROUTE_RESTART_REQUIRED"
        );
        assert_eq!(
            state.handle_generation.load(Ordering::SeqCst),
            generation,
            "manual/watchdog cannot bypass failed transaction"
        );
    }
    REBUILD_FAULTS.with(|values| values.borrow_mut().clear());
    fs::remove_dir(writing(&fixture.path(0))).unwrap();
    fs::remove_dir(writing(&fixture.path(1))).unwrap();
    fixture.restart();
    fixture.stable(false, proxy);
    fixture.change(proxy).unwrap();
    fixture.stable(true, proxy);
}

#[test]
fn shared_network_proxy_mounted_kai_checkpoint_refusal_and_cold_restart_preserve_both_profiles() {
    for proxy in [false, true] {
        let mut fixture = Fixture::with_storage(&format!("kai-{proxy}"), true);
        fixture.stable(false, proxy);
        let container = fixture.root.join("profiles/second/second.kai");
        let previous = fs::read(&container).unwrap();
        let blocked = writing(&container);
        fs::create_dir(&blocked).unwrap();
        let result = fixture.change(proxy);
        assert!(
            result.is_err(),
            "mounted KAI checkpoint refusal must reject shared change"
        );
        assert_eq!(
            fs::read(&container).unwrap(),
            previous,
            "refused container remains durable old generation"
        );
        fixture.stable(false, proxy);
        fs::remove_dir(&blocked).unwrap();
        fixture.cold_restart();
        fixture.stable(false, proxy);
        fixture.change(proxy).unwrap();
        fixture.stable(true, proxy);
        fixture.cold_restart();
        fixture.stable(true, proxy);
    }
}

#[test]
fn shared_network_two_profile_settings_and_save_refusal_matrix() {
    refusal_matrix(false);
}
fn seed_settings_history_canary(state: &ToxState, index: usize) -> ToxMessage {
    let row: ToxMessage = serde_json::from_value(serde_json::json!({
        "id": format!("settings-history-canary-{index}"), "friend_number": 0,
        "friend_public_key": hex_upper(&[0x55 + index as u8; 32]),
        "text": format!("synthetic delivered history {index}"), "mine":false,
        "timestamp":42,"delivery":"delivered","delivered_at":43,
        "attachment":null,"event":null,"protocol_version":null,"operation_id":null,
        "quote":null,"formatting":[],"pq_protected":false,"reactions":null
    }))
    .unwrap();
    state.messages.lock().unwrap().push(row.clone());
    write_registered_history_rows_required(std::slice::from_ref(&row), &state.history_path)
        .unwrap();
    state.checkpoint_profile(true).unwrap();
    row
}

fn stored_settings_history_canary(state: &ToxState, row: &ToxMessage) -> bool {
    chat_history_store::find_message_registered(
        &state.history_path,
        row.friend_number,
        &row.friend_public_key,
        &row.id,
    )
    .unwrap()
    .is_some()
}

#[test]
fn settings_history_full_clear_epoch_rejects_stale_owner_state_and_cold_restores_neighbor_canaries()
{
    for managed in [false, true] {
        let mut fixture = Fixture::with_storage(&format!("history-epoch-{managed}"), managed);
        let values = [0, 1].map(|index| serde_json::json!({
            "activeChat": format!("tox-{}", "5".repeat(64)), "historyClearEpoch": 0,
            "drafts": {"chat": format!("plain-draft-{index}")}, "draftFormatting": {"chat": [{"kind":"bold","offsetUtf16":0,"lengthUtf16":5}]},
            "draftQuotes": {"chat": {"author":"peer","text":format!("legacy-history-{index}"),"legacy":true}, "current":{"messageId":"0123456789abcdef","author":"peer","text":"old quote"}},
            "peerReactionNotices": {"chat": {"through":4,"notices":[{"messageId":"0123456789abcdef"}]}},
            "scrollAnchors": {"chat":{"messageKey":"0123456789abcdef"}},
            "notifyMessages":false, "saveChatHistory":true, "pendingSendOperations":{}
        }));
        for (state, value) in fixture.states.iter().zip(values.iter()) {
            write_profile_local_state_for_profile(state, value).unwrap();
            state.checkpoint_profile(true).unwrap();
        }
        let canaries = fixture
            .states
            .iter()
            .enumerate()
            .map(|(index, state)| seed_settings_history_canary(state, index))
            .collect::<Vec<_>>();
        let previous = fixture
            .states
            .iter()
            .map(|state| {
                read_profile_local_state(&profile_local_state_path(state).unwrap())
                    .unwrap()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        clear_tox_history_for_state(&fixture.states[0], None).unwrap();
        assert!(!stored_settings_history_canary(
            &fixture.states[0],
            &canaries[0]
        ));
        assert!(stored_settings_history_canary(
            &fixture.states[1],
            &canaries[1]
        ));
        let cleared =
            read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
                .unwrap()
                .unwrap();
        assert_eq!(
            cleared["draftQuotes"],
            serde_json::json!({}),
            "full clear removes persisted legacy and current quotes"
        );
        assert_eq!(cleared["peerReactionNotices"], serde_json::json!({}));
        assert_eq!(cleared["scrollAnchors"], serde_json::json!({}));
        assert_eq!(cleared["historyClearEpoch"], 1);
        for field in [
            "drafts",
            "draftFormatting",
            "notifyMessages",
            "saveChatHistory",
            "avatarUrl",
            "pendingSendOperations",
        ] {
            assert_eq!(
                cleared[field], previous[0][field],
                "history clear preserves {field}"
            );
        }
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[1]).unwrap())
                .unwrap()
                .unwrap(),
            previous[1],
            "B local state unchanged"
        );
        write_profile_local_state_for_profile(&fixture.states[0], &previous[0]).unwrap();
        let late = read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
            .unwrap()
            .unwrap();
        for field in ["draftQuotes", "peerReactionNotices", "scrollAnchors"] {
            assert_eq!(
                late[field],
                serde_json::json!({}),
                "stale save cannot resurrect {field}"
            );
        }
        assert_eq!(late["historyClearEpoch"], 1);
        fixture.stable(false, false);
        if managed {
            fixture.cold_restart();
        } else {
            fixture.restart();
        }
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
                .unwrap()
                .unwrap()["draftQuotes"],
            serde_json::json!({}),
            "cold open has no removed quotes"
        );
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[1]).unwrap())
                .unwrap()
                .unwrap(),
            previous[1]
        );
        fixture.stable(false, false);
        assert!(!stored_settings_history_canary(
            &fixture.states[0],
            &canaries[0]
        ));
        assert!(stored_settings_history_canary(
            &fixture.states[1],
            &canaries[1]
        ));
        let mut fresh = late;
        fresh["draftQuotes"] = serde_json::json!({"new-chat":{"author":"peer","text":"fresh legacy quote","legacy":true}});
        write_profile_local_state_for_profile(&fixture.states[0], &fresh).unwrap();
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
                .unwrap()
                .unwrap()["draftQuotes"],
            fresh["draftQuotes"],
            "new epoch permits fresh legacy quote"
        );
        clear_tox_history_for_state(&fixture.states[0], None).unwrap();
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
                .unwrap()
                .unwrap()["historyClearEpoch"],
            2,
            "repeated full clear advances durable epoch"
        );
    }
}
#[test]
fn settings_history_fs_write_and_mounted_kai_checkpoint_refusals_are_reported_and_cold_retry_completes(
) {
    for managed in [false, true] {
        let mut fixture = Fixture::with_storage(&format!("history-refusal-{managed}"), managed);
        let values = [0, 1].map(|index| serde_json::json!({
            "historyClearEpoch":0,"drafts":{"chat":format!("plain refusal canary {index}")},
            "draftQuotes":{"chat":{"author":"peer","text":format!("old quote {index}"),"legacy":true}},
            "peerReactionNotices":{"chat":{"through":1,"notices":[]}},"scrollAnchors":{"chat":{"messageKey":"old"}},
            "notifyMessages":false,"pendingSendOperations":{}
        }));
        for (state, value) in fixture.states.iter().zip(values.iter()) {
            write_profile_local_state_for_profile(state, value).unwrap();
        }
        let canaries = fixture
            .states
            .iter()
            .enumerate()
            .map(|(index, state)| seed_settings_history_canary(state, index))
            .collect::<Vec<_>>();
        let previous = fixture
            .states
            .iter()
            .map(|state| {
                read_profile_local_state(&profile_local_state_path(state).unwrap())
                    .unwrap()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let container = fixture.root.join("profiles/first/first.kai");
        let container_before = managed.then(|| fs::read(&container).unwrap());
        let blocked = writing(&if managed {
            container.clone()
        } else {
            profile_local_state_path(&fixture.states[0]).unwrap()
        });
        fs::create_dir(&blocked).unwrap();
        let error = clear_tox_history_for_state(&fixture.states[0], None).unwrap_err();
        assert!(
            !error.is_empty(),
            "actual durability refusal must return an error"
        );
        assert!(
            !stored_settings_history_canary(&fixture.states[0], &canaries[0]),
            "history commit precedes the refused final checkpoint"
        );
        assert!(stored_settings_history_canary(
            &fixture.states[1],
            &canaries[1]
        ));
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[1]).unwrap())
                .unwrap()
                .unwrap(),
            previous[1]
        );
        if let Some(bytes) = container_before {
            assert_eq!(
                fs::read(&container).unwrap(),
                bytes,
                "refused KAI commit preserves the old durable container"
            );
        } else {
            assert_eq!(
                read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
                    .unwrap()
                    .unwrap(),
                previous[0],
                "FS refusal leaves old local state; error must not acknowledge completion"
            );
        }
        fs::remove_dir(&blocked).unwrap();
        if managed {
            fixture.cold_restart();
        } else {
            fixture.restart();
        }
        assert_eq!(
            stored_settings_history_canary(&fixture.states[0], &canaries[0]),
            managed,
            "cold KAI returns its old coherent generation; FS exposes partial clear until retry"
        );
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
                .unwrap()
                .unwrap()["draftQuotes"],
            previous[0]["draftQuotes"]
        );
        fixture.stable(false, false);
        assert_eq!(
            clear_tox_history_for_state(&fixture.states[0], None).unwrap(),
            Some(1)
        );
        if managed {
            fixture.cold_restart();
        } else {
            fixture.restart();
        }
        let repaired =
            read_profile_local_state(&profile_local_state_path(&fixture.states[0]).unwrap())
                .unwrap()
                .unwrap();
        assert_eq!(repaired["historyClearEpoch"], 1);
        assert_eq!(repaired["draftQuotes"], serde_json::json!({}));
        assert_eq!(repaired["peerReactionNotices"], serde_json::json!({}));
        assert_eq!(repaired["scrollAnchors"], serde_json::json!({}));
        assert_eq!(repaired["drafts"], previous[0]["drafts"]);
        assert!(!stored_settings_history_canary(
            &fixture.states[0],
            &canaries[0]
        ));
        assert!(stored_settings_history_canary(
            &fixture.states[1],
            &canaries[1]
        ));
        assert_eq!(
            read_profile_local_state(&profile_local_state_path(&fixture.states[1]).unwrap())
                .unwrap()
                .unwrap(),
            previous[1]
        );
        fixture.stable(false, false);
        println!("SETTINGS_CLEAR_REFUSAL_COLD_RETRY storage={} error={} acknowledged=false retry=durable-clear", if managed { "KAI" } else { "FS" }, error);
    }
}

#[test]
fn shared_proxy_two_profile_settings_and_save_refusal_matrix() {
    refusal_matrix(true);
}
#[test]
fn shared_network_rollback_refusal_stops_mixed_routes_until_restart_and_retry() {
    rollback_refusal(false);
}
#[test]
fn shared_proxy_rollback_refusal_stops_mixed_routes_until_restart_and_retry() {
    rollback_refusal(true);
}

#[test]
fn shared_network_proxy_writers_and_watchdog_share_one_transaction_boundary() {
    let fixture = Fixture::new("concurrent");
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::scope(|scope| {
        let first = scope.spawn(|| {
            REBUILD_PAUSE.with(|value| *value.borrow_mut() = Some((entered_tx, resume_rx)));
            fixture.change(false)
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let second = scope.spawn(|| {
            started_tx.send(()).unwrap();
            let result = fixture.change(true);
            done_tx.send(()).unwrap();
            (result, OPTIONS.with(|value| value.borrow().clone()))
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        let generation = fixture.states[1].handle_generation.load(Ordering::SeqCst);
        let started = Instant::now();
        assert!(!fixture.states[1]
            .rebuild_network_route_if_stalled(Some(generation))
            .unwrap());
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "watchdog must not block behind the shared writer"
        );
        assert_eq!(
            fixture.states[1].handle_generation.load(Ordering::SeqCst),
            generation
        );
        resume_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        let (result, options) = second.join().unwrap();
        result.unwrap();
        OPTIONS.with(|value| *value.borrow_mut() = options);
    });
    fixture.stable_values(requested_network(), requested_proxy());
    for state in &fixture.states {
        assert_eq!(state.handle_generation.load(Ordering::SeqCst), 3);
    }
}
