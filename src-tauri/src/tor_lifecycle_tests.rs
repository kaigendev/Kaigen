// Real child/pipes/loopback lifecycle; executable, clock and barriers are local
// to each controller. No Tor binary, bridge connection or external network runs.
use super::*;
use std::{
    io,
    sync::{
        atomic::{AtomicU64, Ordering},
        Condvar,
    },
};

const CHILD_TEST: &str = "tor::lifecycle_tests::fake_process_driver";
const CHILD_ROOT: &str = "KAIGEN_TOR_FIXTURE_CHILD_ROOT";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct GateState {
    entered: usize,
    finished: usize,
    released: bool,
}
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}
impl Gate {
    fn enter(&self) {
        let mut state = self.state.lock().unwrap();
        state.entered += 1;
        self.changed.notify_all();
        while !state.released {
            let result = self
                .changed
                .wait_timeout(state, Duration::from_secs(15))
                .unwrap();
            state = result.0;
            assert!(!result.1.timed_out(), "fixture barrier was not released");
        }
    }
    fn release(&self) {
        self.state.lock().unwrap().released = true;
        self.changed.notify_all();
    }
    fn entered(&self) -> usize {
        self.state.lock().unwrap().entered
    }
    fn finished(&self) -> usize {
        self.state.lock().unwrap().finished
    }
}
pub(super) struct LogReceipt(Arc<Gate>);
impl Drop for LogReceipt {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().finished += 1;
        self.0.changed.notify_all();
    }
}
#[derive(Clone)]
struct Launch {
    generation: u64,
    transport: String,
    ports: TorPorts,
    pid: u32,
    input: Arc<Mutex<std::process::ChildStdin>>,
}
#[derive(Default)]
struct Hooks {
    logs: Vec<(u64, bool, String, Arc<Gate>)>,
    fallback: Option<(u64, Arc<Gate>)>,
    launch: Option<(String, Arc<Gate>)>,
}
pub(super) struct TestRuntime {
    root: PathBuf,
    clock: Mutex<Instant>,
    launches: Mutex<Vec<Launch>>,
    hooks: Mutex<Hooks>,
}
impl TestRuntime {
    pub(super) fn now(&self) -> Instant {
        *self.clock.lock().unwrap()
    }
    fn advance(&self, seconds: u64) {
        *self.clock.lock().unwrap() += Duration::from_secs(seconds);
    }
    pub(super) fn command(&self, generation: u64, torrc: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
            .env(CHILD_ROOT, &self.root)
            .env("KAIGEN_TOR_FIXTURE_TORRC", torrc)
            .env("KAIGEN_TOR_FIXTURE_GENERATION", generation.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    pub(super) fn register(
        &self,
        generation: u64,
        transport: &str,
        ports: TorPorts,
        child: &mut Child,
    ) {
        self.launches.lock().unwrap().push(Launch {
            generation,
            transport: transport.into(),
            ports,
            pid: child.id(),
            input: Arc::new(Mutex::new(child.stdin.take().expect("fake process stdin"))),
        });
    }
    pub(super) fn before_log(
        &self,
        generation: u64,
        stderr: bool,
        line: &str,
    ) -> Option<LogReceipt> {
        let gate = self
            .hooks
            .lock()
            .unwrap()
            .logs
            .iter()
            .find(|(owner, stream, marker, _)| {
                *owner == generation && *stream == stderr && line.contains(marker)
            })
            .map(|(_, _, _, gate)| gate.clone());
        gate.map(|gate| {
            gate.enter();
            LogReceipt(gate)
        })
    }
    pub(super) fn before_fallback(&self, generation: u64) {
        let gate = self
            .hooks
            .lock()
            .unwrap()
            .fallback
            .as_ref()
            .filter(|(owner, _)| *owner == generation)
            .map(|(_, gate)| gate.clone());
        if let Some(gate) = gate {
            gate.enter();
        }
    }
    pub(super) fn before_launch(&self, transport: &str) {
        let gate = self
            .hooks
            .lock()
            .unwrap()
            .launch
            .as_ref()
            .filter(|(owner, _)| owner == transport)
            .map(|(_, gate)| gate.clone());
        if let Some(gate) = gate {
            gate.enter();
        }
    }
    fn log_gate(&self, generation: u64, stderr: bool, marker: &str) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        self.hooks
            .lock()
            .unwrap()
            .logs
            .push((generation, stderr, marker.into(), gate.clone()));
        gate
    }
    fn fallback_gate(&self, generation: u64) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        self.hooks.lock().unwrap().fallback = Some((generation, gate.clone()));
        gate
    }
    fn launch_gate(&self, transport: &str) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        self.hooks.lock().unwrap().launch = Some((transport.into(), gate.clone()));
        gate
    }
    fn release_all(&self) {
        let hooks = self.hooks.lock().unwrap();
        for (_, _, _, gate) in &hooks.logs {
            gate.release();
        }
        if let Some((_, gate)) = &hooks.fallback {
            gate.release();
        }
        if let Some((_, gate)) = &hooks.launch {
            gate.release();
        }
    }
    fn launches(&self) -> Vec<Launch> {
        self.launches.lock().unwrap().clone()
    }
    fn latest(&self) -> Launch {
        self.launches().last().unwrap().clone()
    }
    fn write(&self, launch: &Launch, command: Value) {
        let mut input = launch.input.lock().unwrap();
        writeln!(input, "{}", command).unwrap();
        input.flush().unwrap();
    }
    fn line(&self, launch: &Launch, stderr: bool, text: &str) {
        self.write(launch, serde_json::json!({"stderr":stderr,"line":text}));
    }
    fn exit(&self, launch: &Launch) {
        self.write(launch, serde_json::json!({"exit":0}));
    }
    fn ready(&self, launch: &Launch) {
        wait_until("fake child bound both exact ports", || {
            self.root
                .join(format!("ready-{}", launch.generation))
                .is_file()
        });
        assert!(TcpListener::bind(("127.0.0.1", launch.ports.socks)).is_err());
        assert!(TcpListener::bind(("127.0.0.1", launch.ports.control)).is_err());
        assert!(process_alive(launch.pid));
    }
}

struct Rig {
    manager: TorManager,
    runtime: Arc<TestRuntime>,
    root: PathBuf,
}
impl Rig {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "kaigen-tor-lifecycle-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let bundle = root.join("TorExpertBundle");
        fs::create_dir_all(bundle.join("tor/pluggable_transports")).unwrap();
        fs::create_dir_all(bundle.join("data")).unwrap();
        fs::write(
            bundled_tor_executable(&bundle),
            b"INERT FIXTURE - COMMAND IS INJECTED",
        )
        .unwrap();
        fs::write(bundle.join("data/geoip"), b"disposable").unwrap();
        fs::write(bundle.join("data/geoip6"), b"disposable").unwrap();
        let placeholder = "$".to_string() + "{pt_path}";
        let config = serde_json::json!({
            "pluggableTransports":{
                "lyrebird":format!("ClientTransportPlugin obfs4 exec {placeholder}lyrebird"),
                "snowflake":format!("ClientTransportPlugin snowflake exec {placeholder}snowflake"),
                "conjure":format!("ClientTransportPlugin conjure exec {placeholder}conjure")
            },
            "bridges":{"obfs4":["obfs4 127.0.0.1:1 FAKE cert=fixture iat-mode=0"],"snowflake":["snowflake 127.0.0.1:2 FAKE"]}
        });
        fs::write(
            bundle.join("tor/pluggable_transports/pt_config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let manager = TorManager::new(root.clone(), root.join("data"), root.join("logs")).unwrap();
        fs::create_dir_all(root.join("logs")).unwrap();
        let runtime = Arc::new(TestRuntime {
            root: root.clone(),
            clock: Mutex::new(Instant::now()),
            launches: Mutex::new(Vec::new()),
            hooks: Mutex::new(Hooks::default()),
        });
        *manager.shared.test_runtime.lock().unwrap() = Some(runtime.clone());
        Self {
            manager,
            runtime,
            root,
        }
    }
    fn settings(transport: &str, enabled: bool) -> TorSettings {
        TorSettings {
            enabled,
            transport: transport.into(),
            bridge_lines: if transport == "custom" {
                "obfs4 127.0.0.1:3 FAKE cert=customfixture iat-mode=0".into()
            } else {
                String::new()
            },
        }
    }
    fn start(&self, transport: &str) -> Launch {
        self.manager
            .apply_settings(Self::settings(transport, true))
            .unwrap();
        let launch = self.runtime.latest();
        self.runtime.ready(&launch);
        launch
    }
    fn connected(&self, launch: &Launch, marker: &str) {
        self.runtime.line(
            launch,
            false,
            &format!("[notice] Bootstrapped 100% (done): {marker}"),
        );
        wait_until("live bootstrap committed", || {
            self.manager.status().state == "connected"
        });
        assert_eq!(
            self.manager.shared.inner.lock().unwrap().generation,
            launch.generation
        );
        assert_eq!(self.manager.status().transport, launch.transport);
        assert!(self.manager.is_ready());
    }
    fn saved(&self) -> TorSettings {
        serde_json::from_slice(&fs::read(self.root.join("data/tor-settings.json")).unwrap())
            .unwrap()
    }
    fn torrc(&self) -> String {
        fs::read_to_string(self.root.join("data/tor/torrc")).unwrap()
    }
    fn assert_stopped(&self) {
        self.manager.stop();
        for launch in self.runtime.launches() {
            wait_until("exact child PID exited", || !process_alive(launch.pid));
            assert_ports_free(launch.ports);
        }
        assert_eq!(self.manager.status().state, "disabled");
        assert_eq!(self.manager.status().socks_port, None);
        assert_eq!(self.manager.status().control_port, None);
    }
    fn report(&self, case: &str) {
        println!(
            "TOR_LIFECYCLE {}",
            serde_json::json!({
                "case":case,"state":self.manager.status().state,"generation":self.manager.shared.inner.lock().unwrap().generation,
                "launches":self.runtime.launches().iter().map(|entry| serde_json::json!({"generation":entry.generation,"transport":entry.transport,"pid":entry.pid,"socks":entry.ports.socks,"control":entry.ports.control})).collect::<Vec<_>>(),
                "clock":"injected monotonic time; polling and child IO are real","externalNetwork":false
            })
        );
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.runtime.release_all();
        self.manager.stop();
        // Run on assertion failure too: a failed race must not leave children
        // or bound loopback ports behind. Preserve the original panic.
        let lifecycle_cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for launch in self.runtime.launches() {
                wait_until("cleanup exact child PID exited", || {
                    !process_alive(launch.pid)
                });
                assert_ports_free(launch.ports);
            }
        }));
        println!(
            "TOR_FIXTURE_PROCESS_CLEANUP {}",
            serde_json::json!({
                "passed": lifecycle_cleanup.is_ok(), "assertionUnwind": thread::panicking(),
                "children": self.runtime.launches().len(), "portsReleased": lifecycle_cleanup.is_ok()
            })
        );
        let mut cleanup_error = None;
        let root = self.root.canonicalize().unwrap();
        let temporary = std::env::temp_dir().canonicalize().unwrap();
        assert!(
            root.starts_with(&temporary)
                && root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("kaigen-tor-lifecycle-")
        );
        for _ in 0..100 {
            match fs::remove_dir_all(&root) {
                Ok(()) => {
                    cleanup_error = None;
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    cleanup_error = None;
                    break;
                }
                Err(error) => {
                    cleanup_error = Some(error);
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
        if let Some(error) = cleanup_error {
            if thread::panicking() {
                eprintln!("TOR_FIXTURE_CLEANUP_FAILED: {error}");
            } else {
                panic!("Tor fixture cleanup failed: {error}");
            }
        }
        if let Err(error) = lifecycle_cleanup {
            if thread::panicking() {
                eprintln!("TOR_FIXTURE_PROCESS_CLEANUP_FAILED");
            } else {
                std::panic::resume_unwind(error);
            }
        }
    }
}
fn wait_until(label: &str, mut read: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if read() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("{label} timed out");
}
fn assert_ports_free(ports: TorPorts) {
    let socks = TcpListener::bind(("127.0.0.1", ports.socks)).expect("exact SOCKS port released");
    let control =
        TcpListener::bind(("127.0.0.1", ports.control)).expect("exact Control port released");
    drop((socks, control));
}
#[cfg(target_os = "windows")]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            assert_eq!(GetLastError(), ERROR_INVALID_PARAMETER);
            return false;
        }
        let mut code = 0;
        let result = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        assert_ne!(result, 0);
        code == 259
    }
}
#[cfg(not(target_os = "windows"))]
fn process_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        true
    } else {
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        false
    }
}

fn child_process(root: PathBuf) {
    let temporary = std::env::temp_dir().canonicalize().unwrap();
    let root = root.canonicalize().unwrap();
    assert!(
        root.starts_with(temporary)
            && root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("kaigen-tor-lifecycle-")
    );
    let torrc = PathBuf::from(std::env::var_os("KAIGEN_TOR_FIXTURE_TORRC").unwrap())
        .canonicalize()
        .unwrap();
    assert!(torrc.starts_with(&root));
    let configuration = fs::read_to_string(torrc).unwrap();
    let port = |name: &str| {
        configuration
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .unwrap()
            .trim()
            .strip_prefix("127.0.0.1:")
            .unwrap()
            .parse::<u16>()
            .unwrap()
    };
    let _socks = TcpListener::bind(("127.0.0.1", port("SocksPort "))).unwrap();
    let _control = TcpListener::bind(("127.0.0.1", port("ControlPort "))).unwrap();
    let generation = std::env::var("KAIGEN_TOR_FIXTURE_GENERATION").unwrap();
    fs::write(
        root.join(format!("ready-{generation}")),
        b"both loopback listeners bound",
    )
    .unwrap();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if let Some(code) = request["exit"].as_i64() {
            std::process::exit(code as i32);
        }
        if request["stderr"].as_bool().unwrap_or(false) {
            writeln!(io::stderr(), "{}", request["line"].as_str().unwrap()).unwrap();
            io::stderr().flush().unwrap();
        } else {
            writeln!(io::stdout(), "{}", request["line"].as_str().unwrap()).unwrap();
            io::stdout().flush().unwrap();
        }
    }
}

#[test]
fn fake_process_driver() {
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        child_process(root.into());
        return;
    }
    let rig = Rig::new();
    let launch = rig.start("obfs4");
    rig.connected(&launch, "live positive");
    rig.assert_stopped();
    rig.report("real child live100 and normal stop release PID/ports");
}

#[test]
fn reaped_child_cannot_be_resurrected_by_buffered_bootstrap() {
    let rig = Rig::new();
    let launch = rig.start("obfs4");
    let gate = rig
        .runtime
        .log_gate(launch.generation, false, "late dead100");
    rig.runtime.line(
        &launch,
        false,
        "[notice] Bootstrapped 100% (done): late dead100",
    );
    wait_until("buffered100 reader held before status lock", || {
        gate.entered() == 1
    });
    rig.runtime.exit(&launch);
    wait_until("monitor reaped exact child", || {
        rig.manager.shared.inner.lock().unwrap().child.is_none()
    });
    assert_eq!(rig.manager.status().state, "error");
    gate.release();
    wait_until("delayed100 processed", || gate.finished() == 1);
    assert_eq!(
        rig.manager.status().state,
        "error",
        "late buffered100 must not resurrect a reaped child"
    );
    assert!(!rig.manager.is_ready());
    assert_eq!(
        rig.runtime.launches().len(),
        1,
        "explicit route never falls back"
    );
    rig.assert_stopped();
    rig.report("exit before buffered100");
}

#[test]
fn live_bootstrap_then_exit_closes_route_without_fallback() {
    let rig = Rig::new();
    let launch = rig.start("none");
    rig.connected(&launch, "connected before exit");
    rig.runtime.exit(&launch);
    wait_until("connected process exit closes route", || {
        rig.manager.status().state == "error"
    });
    assert!(!rig.manager.is_ready());
    assert_eq!(rig.runtime.launches().len(), 1);
    rig.assert_stopped();
    rig.report("live100 before exit");
}

#[test]
fn buffered_bootstrap_after_exit_cannot_cancel_automatic_fallback() {
    let rig = Rig::new();
    let initial = rig.start("none");
    let reader = rig
        .runtime
        .log_gate(initial.generation, false, "dead automatic100");
    let election = rig.runtime.fallback_gate(initial.generation);
    rig.runtime.line(
        &initial,
        false,
        "[notice] Bootstrapped 100% (done): dead automatic100",
    );
    wait_until("automatic buffered100 held", || reader.entered() == 1);
    rig.runtime.exit(&initial);
    wait_until("monitor reaped child before fallback guard", || {
        election.entered() == 1
    });
    assert!(rig.manager.shared.inner.lock().unwrap().child.is_none());
    reader.release();
    wait_until("automatic dead100 discarded", || reader.finished() == 1);
    assert_ne!(rig.manager.status().state, "connected");
    assert!(!rig.manager.is_ready());
    assert!(rig
        .manager
        .shared
        .inner
        .lock()
        .unwrap()
        .attempt_started_at
        .is_some());
    election.release();
    wait_until("automatic exit launches successor", || {
        rig.runtime.launches().len() == 2
    });
    let current = rig.runtime.latest();
    rig.runtime.ready(&current);
    assert_eq!(current.transport, "obfs4");
    assert_eq!(current.ports, initial.ports);
    assert_eq!(rig.saved().transport, "none");
    rig.connected(&current, "live automatic successor");
    rig.assert_stopped();
    rig.report("dead100 cannot cancel actual automatic fallback");
}

#[test]
fn old_stdout_stderr_cannot_mutate_restart_or_disabled_generation() {
    let rig = Rig::new();
    let old = rig.start("obfs4");
    let stdout = rig.runtime.log_gate(old.generation, false, "old stdout");
    let stderr = rig.runtime.log_gate(old.generation, true, "old stderr");
    rig.runtime
        .line(&old, false, "[notice] Bootstrapped 100% (done): old stdout");
    rig.runtime.line(&old, true, "[err] old stderr");
    wait_until("both old actual pipes held", || {
        stdout.entered() == 1 && stderr.entered() == 1
    });
    rig.manager.restart().unwrap();
    let new = rig.runtime.latest();
    rig.runtime.ready(&new);
    assert_ne!(old.generation, new.generation);
    assert_ne!(old.pid, new.pid);
    assert_ne!(old.ports, new.ports);
    rig.connected(&new, "new live owner");
    let snapshot = serde_json::to_value(rig.manager.status()).unwrap();
    stdout.release();
    wait_until("old stdout discarded", || stdout.finished() == 1);
    assert_eq!(
        serde_json::to_value(rig.manager.status()).unwrap(),
        snapshot
    );
    rig.manager
        .apply_settings(Rig::settings("obfs4", false))
        .unwrap();
    stderr.release();
    wait_until("old stderr discarded after disable", || {
        stderr.finished() == 1
    });
    assert_eq!(rig.manager.status().state, "disabled");
    assert_eq!(rig.manager.status().progress, 0);
    assert!(!rig.saved().enabled);
    rig.assert_stopped();
    rig.report("generation stdout/restart and stderr/disable");
}

#[test]
fn monitor_and_watchdog_elect_one_fallback_and_reuse_exact_ports() {
    let rig = Rig::new();
    let initial = rig.start("none");
    let gate = rig.runtime.fallback_gate(initial.generation);
    rig.runtime.advance(60);
    wait_until("watchdog selected fallback before lifecycle", || {
        gate.entered() == 1
    });
    rig.runtime.exit(&initial);
    wait_until("monitor independently selected same fallback", || {
        gate.entered() == 2
    });
    gate.release();
    wait_until("one successor actually launched", || {
        rig.runtime.launches().len() == 2
    });
    let next = rig.runtime.latest();
    rig.runtime.ready(&next);
    assert_eq!(next.transport, "obfs4");
    assert_eq!(next.ports, initial.ports);
    assert_ne!(next.pid, initial.pid);
    thread::sleep(Duration::from_millis(30));
    assert_eq!(rig.runtime.launches().len(), 2);
    assert_eq!(rig.saved().transport, "none");
    rig.assert_stopped();
    rig.report("monitor/watchdog single election with exact port reuse");
}

#[test]
fn actual_process_exits_exhaust_bounded_automatic_chain() {
    let rig = Rig::new();
    let initial = rig.start("none");
    let mut current = initial.clone();
    for (count, transport) in [(2, "obfs4"), (3, "snowflake")] {
        rig.runtime.exit(&current);
        wait_until("process exit launched bounded successor", || {
            rig.runtime.launches().len() == count
        });
        current = rig.runtime.latest();
        rig.runtime.ready(&current);
        assert_eq!(current.transport, transport);
        assert_eq!(current.ports, initial.ports);
        assert_eq!(rig.saved().transport, "none");
    }
    rig.runtime.exit(&current);
    wait_until("final automatic child exit closes exhausted route", || {
        rig.manager.status().state == "error"
    });
    rig.runtime.advance(120);
    thread::sleep(Duration::from_millis(30));
    assert_eq!(rig.runtime.launches().len(), 3);
    assert!(!rig.manager.is_ready());
    rig.assert_stopped();
    rig.report("actual none/obfs4/snowflake exits exhaust bounded chain");
}

#[test]
fn manual_transport_cancels_fallback_before_guard_commit() {
    for transport in ["obfs4", "snowflake", "custom"] {
        let rig = Rig::new();
        let initial = rig.start("none");
        let gate = rig.runtime.fallback_gate(initial.generation);
        rig.runtime.advance(60);
        wait_until("fallback held before lifecycle", || gate.entered() == 1);
        rig.manager
            .apply_settings(Rig::settings(transport, true))
            .unwrap();
        let current = rig.runtime.latest();
        rig.runtime.ready(&current);
        let torrc = rig.torrc();
        gate.release();
        thread::sleep(Duration::from_millis(30));
        assert_eq!(rig.runtime.launches().len(), 2);
        assert_eq!(rig.manager.status().transport, transport);
        assert_eq!(rig.saved().transport, transport);
        assert_eq!(rig.torrc(), torrc);
        assert!(torrc.contains("UseBridges 1"));
        if transport == "custom" {
            assert!(torrc.contains("customfixture"));
            assert_eq!(
                rig.saved().bridge_lines,
                Rig::settings(transport, true).bridge_lines
            );
        }
        rig.connected(&current, "explicit live route");
        rig.assert_stopped();
        rig.report("manual explicit transport cancels stale fallback");
    }
}

#[test]
fn disable_cancels_fallback_before_guard_commit() {
    let rig = Rig::new();
    let initial = rig.start("none");
    let gate = rig.runtime.fallback_gate(initial.generation);
    rig.runtime.advance(60);
    wait_until("fallback held before lifecycle", || gate.entered() == 1);
    rig.manager
        .apply_settings(Rig::settings("none", false))
        .unwrap();
    gate.release();
    thread::sleep(Duration::from_millis(30));
    assert_eq!(rig.runtime.launches().len(), 1);
    assert_eq!(rig.manager.status().state, "disabled");
    assert!(!rig.saved().enabled);
    rig.assert_stopped();
    rig.report("disable before fallback commit");
}

#[test]
fn restart_or_disable_during_fallback_launch_has_final_lifecycle_ownership() {
    for disable in [false, true] {
        let rig = Rig::new();
        let initial = rig.start("none");
        let gate = rig.runtime.launch_gate("obfs4");
        rig.runtime.advance(60);
        wait_until("fallback committed but held before child launch", || {
            gate.entered() == 1
        });
        assert_eq!(
            rig.manager.shared.inner.lock().unwrap().generation,
            initial.generation + 1
        );
        assert_eq!(rig.runtime.launches().len(), 1);
        let manager = rig.manager.clone();
        let transition =
            thread::spawn(move || manager.apply_settings(Rig::settings("snowflake", !disable)));
        thread::sleep(Duration::from_millis(20));
        assert_eq!(rig.runtime.launches().len(), 1);
        gate.release();
        transition.join().unwrap().unwrap();
        assert_eq!(rig.saved().transport, "snowflake");
        assert_eq!(rig.saved().enabled, !disable);
        if disable {
            assert_eq!(rig.runtime.launches().len(), 2);
            assert_eq!(rig.manager.status().state, "disabled");
        } else {
            assert_eq!(rig.runtime.launches().len(), 3);
            let current = rig.runtime.latest();
            rig.runtime.ready(&current);
            assert_eq!(current.transport, "snowflake");
            assert_ne!(current.ports, initial.ports);
            rig.connected(&current, "manual route after held fallback");
        }
        rig.assert_stopped();
        rig.report("manual lifecycle during committed fallback launch");
    }
}

#[test]
fn injected_clock_stall_and_hard_deadline_use_real_watchdog() {
    let rig = Rig::new();
    let initial = rig.start("none");
    rig.runtime.advance(10);
    rig.runtime.line(
        &initial,
        false,
        "[notice] Bootstrapped 10% (conn): first progress",
    );
    wait_until("real pipe high-water mark", || {
        rig.manager.status().progress == 10
    });
    rig.runtime.advance(59);
    for progress in [10, 4, 10] {
        rig.runtime.line(
            &initial,
            false,
            &format!("[notice] Bootstrapped {progress}% (conn): repeated/regressed"),
        );
    }
    thread::sleep(Duration::from_millis(30));
    assert_eq!(rig.runtime.launches().len(), 1);
    rig.runtime.advance(1);
    wait_until("stall elected actual fallback", || {
        rig.runtime.launches().len() == 2
    });
    rig.runtime.ready(&rig.runtime.latest());
    rig.assert_stopped();
    rig.report("repeated/regressed progress does not renew stall clock");

    let rig = Rig::new();
    let initial = rig.start("none");
    for progress in [10, 20, 30] {
        rig.runtime.advance(39);
        rig.runtime.line(
            &initial,
            false,
            &format!("[notice] Bootstrapped {progress}% (conn): new progress"),
        );
        wait_until("new high-water mark", || {
            rig.manager.status().progress == progress
        });
        assert_eq!(rig.runtime.launches().len(), 1);
    }
    rig.runtime.advance(2);
    thread::sleep(Duration::from_millis(20));
    assert_eq!(rig.runtime.launches().len(), 1);
    rig.runtime.advance(1);
    wait_until("hard deadline elected actual fallback", || {
        rig.runtime.launches().len() == 2
    });
    rig.runtime.ready(&rig.runtime.latest());
    rig.assert_stopped();
    rig.report("new progress cannot renew120s hard deadline");
}
