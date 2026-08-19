use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, Weak},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const STANDARD_TOR_PORTS: [u16; 4] = [9050, 9051, 9150, 9151];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorSettings {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub bridge_lines: String,
}

fn default_enabled() -> bool {
    true
}

fn default_transport() -> String {
    "none".to_string()
}

impl Default for TorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            transport: default_transport(),
            bridge_lines: String::new(),
        }
    }
}

impl TorSettings {
    fn validate(&self) -> Result<(), String> {
        match self.transport.as_str() {
            "none" | "snowflake" | "obfs4" | "custom" => {}
            _ => return Err("Неизвестный режим транспорта Tor".to_string()),
        }
        if self.transport == "custom"
            && self
                .bridge_lines
                .lines()
                .all(|line| line.trim().is_empty() || line.trim_start().starts_with('#'))
        {
            return Err(
                "Для пользовательского режима укажите хотя бы одну строку Bridge".to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorStatus {
    pub state: String,
    pub progress: u8,
    pub message: Option<String>,
    pub socks_port: Option<u16>,
    pub control_port: Option<u16>,
    pub transport: String,
}

impl TorStatus {
    fn disabled(transport: String) -> Self {
        Self {
            state: "disabled".to_string(),
            progress: 0,
            message: None,
            socks_port: None,
            control_port: None,
            transport,
        }
    }
}

#[derive(Clone)]
pub struct TorManager {
    shared: Arc<TorShared>,
}

struct TorShared {
    inner: Mutex<TorInner>,
    root_dir: PathBuf,
    tor_data_dir: PathBuf,
    settings_path: PathBuf,
    log_path: PathBuf,
    process_job: TorProcessJob,
}

struct TorInner {
    settings: TorSettings,
    status: TorStatus,
    child: Option<Child>,
    generation: u64,
}

#[cfg(target_os = "windows")]
struct TorProcessJob {
    handle: usize,
}

#[cfg(target_os = "windows")]
unsafe impl Send for TorProcessJob {}
#[cfg(target_os = "windows")]
unsafe impl Sync for TorProcessJob {}

#[cfg(target_os = "windows")]
impl TorProcessJob {
    fn new() -> Result<Self, String> {
        use std::{mem, ptr};
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "Не удалось создать группу процессов Tor: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("Не удалось настроить завершение Tor: {error}"));
        }
        Ok(Self {
            handle: handle as usize,
        })
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::HANDLE, System::JobObjects::AssignProcessToJobObject,
        };

        let assigned = unsafe {
            AssignProcessToJobObject(self.handle as HANDLE, child.as_raw_handle() as HANDLE)
        };
        if assigned == 0 {
            return Err(format!(
                "Не удалось привязать Tor к жизненному циклу Kaigen: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Drop for TorProcessJob {
    fn drop(&mut self) {
        use windows_sys::Win32::{Foundation::CloseHandle, Foundation::HANDLE};
        unsafe {
            CloseHandle(self.handle as HANDLE);
        }
    }
}

#[cfg(not(target_os = "windows"))]
struct TorProcessJob;

#[cfg(not(target_os = "windows"))]
impl TorProcessJob {
    fn new() -> Result<Self, String> {
        Ok(Self)
    }

    fn assign(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn terminate_tor_process(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(target_os = "windows"))]
fn wait_for_tor_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25))
            }
            Ok(None) | Err(_) => return false,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn signal_tor_process_group(child: &Child, signal: i32) -> std::io::Result<()> {
    let pid = i32::try_from(child.id())
        .map_err(|_| std::io::Error::other("Tor process id does not fit into pid_t"))?;
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_tor_process(child: &mut Child) {
    if child.try_wait().is_ok_and(|status| status.is_some()) {
        return;
    }

    // Tor maps SIGINT to a controlled SHUTDOWN. Its pluggable transports share
    // the dedicated process group and normally leave with Tor. Escalate only
    // when the owned tree does not finish within a bounded interval.
    let _ = signal_tor_process_group(child, libc::SIGINT);
    if wait_for_tor_exit(child, Duration::from_secs(2)) {
        return;
    }
    let _ = signal_tor_process_group(child, libc::SIGTERM);
    if wait_for_tor_exit(child, Duration::from_secs(1)) {
        return;
    }
    if signal_tor_process_group(child, libc::SIGKILL).is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
}

impl Drop for TorShared {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut() {
            if let Some(child) = inner.child.as_mut() {
                terminate_tor_process(child);
            }
        }
    }
}

impl TorManager {
    pub fn new(root_dir: PathBuf, data_dir: PathBuf, logs_dir: PathBuf) -> Result<Self, String> {
        let tor_data_dir = data_dir.join("tor");
        fs::create_dir_all(&tor_data_dir)
            .map_err(|error| format!("Не удалось создать каталог данных Tor: {error}"))?;
        let settings_path = data_dir.join("tor-settings.json");
        let settings = fs::read(&settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<TorSettings>(&contents).ok())
            .unwrap_or_default();
        let status = TorStatus::disabled(settings.transport.clone());
        let process_job = TorProcessJob::new()?;
        let manager = Self {
            shared: Arc::new(TorShared {
                inner: Mutex::new(TorInner {
                    settings,
                    status,
                    child: None,
                    generation: 0,
                }),
                root_dir,
                tor_data_dir,
                settings_path,
                log_path: logs_dir.join("tor.log"),
                process_job,
            }),
        };
        manager.persist_settings()?;
        if manager.settings().enabled {
            if let Err(error) = manager.restart() {
                manager.set_start_error(error);
            }
        }
        Ok(manager)
    }

    pub fn settings(&self) -> TorSettings {
        self.shared
            .inner
            .lock()
            .map(|inner| inner.settings.clone())
            .unwrap_or_default()
    }

    pub fn status(&self) -> TorStatus {
        self.shared
            .inner
            .lock()
            .map(|inner| inner.status.clone())
            .unwrap_or_else(|_| TorStatus {
                state: "error".to_string(),
                progress: 0,
                message: Some("Состояние Tor недоступно".to_string()),
                socks_port: None,
                control_port: None,
                transport: "none".to_string(),
            })
    }

    pub fn enabled(&self) -> bool {
        self.settings().enabled
    }

    pub fn is_ready(&self) -> bool {
        let status = self.status();
        !self.enabled() || status.state == "connected"
    }

    pub fn proxy_port(&self) -> Option<u16> {
        if !self.enabled() {
            return None;
        }
        self.status().socks_port
    }

    pub fn apply_settings(&self, settings: TorSettings) -> Result<TorStatus, String> {
        settings.validate()?;
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| "Не удалось изменить настройки Tor".to_string())?;
            inner.settings = settings;
        }
        self.persist_settings()?;
        if self.enabled() {
            if let Err(error) = self.restart() {
                self.set_start_error(error.clone());
                return Err(error);
            }
        } else {
            self.stop();
        }
        Ok(self.status())
    }

    pub fn restart(&self) -> Result<TorStatus, String> {
        let settings = self.settings();
        settings.validate()?;
        if !settings.enabled {
            self.stop();
            return Ok(self.status());
        }

        let (socks_listener, socks_port) = reserve_nonstandard_port()?;
        let (control_listener, control_port) = loop {
            let reserved = reserve_nonstandard_port()?;
            if reserved.1 != socks_port {
                break reserved;
            }
        };

        let bundle_dir = locate_bundle(&self.shared.root_dir).ok_or_else(|| {
            "Компоненты TorExpertBundle не найдены рядом с программой".to_string()
        })?;
        let tor_executable = bundled_tor_executable(&bundle_dir);
        let torrc = self.render_torrc(&bundle_dir, socks_port, control_port, &settings)?;
        let torrc_path = self.shared.tor_data_dir.join("torrc");
        fs::write(&torrc_path, torrc)
            .map_err(|error| format!("Не удалось записать конфигурацию Tor: {error}"))?;

        let (generation, previous_child) = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| "Не удалось перезапустить Tor".to_string())?;
            inner.generation = inner.generation.wrapping_add(1);
            let previous_child = inner.child.take();
            inner.status = TorStatus {
                state: "starting".to_string(),
                progress: 0,
                message: Some("Запуск встроенного Tor".to_string()),
                socks_port: Some(socks_port),
                control_port: Some(control_port),
                transport: settings.transport.clone(),
            };
            (inner.generation, previous_child)
        };

        if let Some(mut child) = previous_child {
            terminate_tor_process(&mut child);
        }

        // Keep both sockets reserved until the old process is gone and the new
        // command is ready to spawn. Tor then binds two fresh, nonstandard ports.
        drop(socks_listener);
        drop(control_listener);

        let mut command = Command::new(&tor_executable);
        command
            .arg("-f")
            // Tor's Windows build does not reliably accept non-ASCII paths in
            // values parsed from torrc. Keep its command/config paths relative
            // to the portable application root. The data itself still lives
            // beside Kaigen and remains isolated from every other copy.
            .arg(config_path(&torrc_path, &self.shared.root_dir))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        command.current_dir(&self.shared.root_dir);
        #[cfg(not(target_os = "windows"))]
        // Tor treats quotes around a ClientTransportPlugin executable as
        // literal path characters. Run from the bundle on Unix so the
        // transport can use a stable relative path even when the portable
        // installation itself contains spaces.
        command.current_dir(&bundle_dir);
        #[cfg(target_os = "linux")]
        {
            let bundled_library_dir = bundle_dir.join("tor");
            let inherited = std::env::var_os("LD_LIBRARY_PATH").unwrap_or_default();
            let mut paths = vec![bundled_library_dir];
            paths.extend(std::env::split_paths(&inherited));
            if let Ok(value) = std::env::join_paths(paths) {
                command.env("LD_LIBRARY_PATH", value);
            }
        }
        #[cfg(target_os = "macos")]
        {
            let bundled_library_dir = bundle_dir.join("tor");
            let inherited = std::env::var_os("DYLD_LIBRARY_PATH").unwrap_or_default();
            let mut paths = vec![bundled_library_dir];
            paths.extend(std::env::split_paths(&inherited));
            if let Ok(value) = std::env::join_paths(paths) {
                command.env("DYLD_LIBRARY_PATH", value);
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::process::CommandExt;
            // A private process group lets shutdown clean up only this Kaigen
            // instance's Tor and pluggable transports, never a system Tor.
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Не удалось запустить встроенный Tor: {error}"))?;
        if let Err(error) = self.shared.process_job.assign(&child) {
            terminate_tor_process(&mut child);
            return Err(error);
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| "Не удалось сохранить процесс Tor".to_string())?;
            if inner.generation != generation {
                terminate_tor_process(&mut child);
                return Err("Запуск Tor был отменён новой конфигурацией".to_string());
            }
            inner.child = Some(child);
        }

        if let Some(stdout) = stdout {
            spawn_log_reader(
                Arc::downgrade(&self.shared),
                generation,
                BufReader::new(stdout),
                false,
            );
        }
        if let Some(stderr) = stderr {
            spawn_log_reader(
                Arc::downgrade(&self.shared),
                generation,
                BufReader::new(stderr),
                true,
            );
        }
        spawn_process_monitor(Arc::downgrade(&self.shared), generation);
        Ok(self.status())
    }

    pub fn stop(&self) {
        let child = if let Ok(mut inner) = self.shared.inner.lock() {
            inner.generation = inner.generation.wrapping_add(1);
            inner.status = TorStatus::disabled(inner.settings.transport.clone());
            inner.child.take()
        } else {
            None
        };
        if let Some(mut child) = child {
            terminate_tor_process(&mut child);
        }
    }

    fn persist_settings(&self) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(&self.settings())
            .map_err(|error| format!("Не удалось сериализовать настройки Tor: {error}"))?;
        fs::write(&self.shared.settings_path, json)
            .map_err(|error| format!("Не удалось сохранить настройки Tor: {error}"))
    }

    fn set_start_error(&self, message: String) {
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.status.state = "error".to_string();
            inner.status.progress = 0;
            inner.status.message = Some(message);
        }
    }

    fn render_torrc(
        &self,
        bundle_dir: &Path,
        socks_port: u16,
        control_port: u16,
        settings: &TorSettings,
    ) -> Result<String, String> {
        let data_dir = config_path(&self.shared.tor_data_dir, &self.shared.root_dir);
        let cookie = config_path(
            &self.shared.tor_data_dir.join("control_auth_cookie"),
            &self.shared.root_dir,
        );
        let geoip = config_path(
            &bundle_dir.join("data").join("geoip"),
            &self.shared.root_dir,
        );
        let geoip6 = config_path(
            &bundle_dir.join("data").join("geoip6"),
            &self.shared.root_dir,
        );
        let mut lines = vec![
            format!("DataDirectory \"{data_dir}\""),
            format!("SocksPort 127.0.0.1:{socks_port}"),
            format!("ControlPort 127.0.0.1:{control_port}"),
            "CookieAuthentication 1".to_string(),
            format!("CookieAuthFile \"{cookie}\""),
            "ClientOnly 1".to_string(),
            "AvoidDiskWrites 1".to_string(),
            "SafeLogging 1".to_string(),
            "Log notice stdout".to_string(),
            format!("GeoIPFile \"{geoip}\""),
            format!("GeoIPv6File \"{geoip6}\""),
        ];

        if settings.transport != "none" {
            let transport_dir = bundle_dir.join("tor").join("pluggable_transports");
            let pt_config_path = transport_dir.join("pt_config.json");
            let config: Value = serde_json::from_slice(
                &fs::read(&pt_config_path)
                    .map_err(|error| format!("Не удалось прочитать pt_config.json: {error}"))?,
            )
            .map_err(|error| format!("Некорректный pt_config.json: {error}"))?;
            let pt_path = if cfg!(target_os = "windows") {
                format!("{}/", config_path(&transport_dir, &self.shared.root_dir))
            } else {
                "tor/pluggable_transports/".to_string()
            };
            lines.push("UseBridges 1".to_string());
            match settings.transport.as_str() {
                "snowflake" => {
                    lines.push(plugin_line(&config, "snowflake", &pt_path)?);
                    append_bundled_bridges(&mut lines, &config, "snowflake")?;
                }
                "obfs4" => {
                    lines.push(plugin_line(&config, "lyrebird", &pt_path)?);
                    append_bundled_bridges(&mut lines, &config, "obfs4")?;
                }
                "custom" => {
                    lines.push(plugin_line(&config, "lyrebird", &pt_path)?);
                    lines.push(plugin_line(&config, "snowflake", &pt_path)?);
                    lines.push(plugin_line(&config, "conjure", &pt_path)?);
                    for bridge in settings.bridge_lines.lines().map(str::trim) {
                        if bridge.is_empty() || bridge.starts_with('#') {
                            continue;
                        }
                        lines.push(
                            if bridge
                                .get(..7)
                                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bridge "))
                            {
                                bridge.to_string()
                            } else {
                                format!("Bridge {bridge}")
                            },
                        );
                    }
                }
                _ => {}
            }
        }
        lines.push(String::new());
        Ok(lines.join("\n"))
    }
}

fn reserve_nonstandard_port() -> Result<(TcpListener, u16), String> {
    for _ in 0..32 {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Не удалось выделить локальный порт Tor: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Не удалось определить локальный порт Tor: {error}"))?
            .port();
        if !STANDARD_TOR_PORTS.contains(&port) {
            return Ok((listener, port));
        }
    }
    Err("Не удалось выделить нестандартный локальный порт Tor".to_string())
}

fn bundled_tor_executable(bundle_dir: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    let name = "tor.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "tor";
    let executable = bundle_dir.join("tor").join(name);
    #[cfg(target_os = "macos")]
    {
        // The signed Mach-O lives in Contents/Helpers and the resource path is
        // a compatibility symlink. Launching the resolved helper also makes
        // its @loader_path unambiguous for the Frameworks libevent dependency.
        return executable.canonicalize().unwrap_or(executable);
    }
    #[cfg(not(target_os = "macos"))]
    executable
}

fn valid_bundle(path: &Path) -> bool {
    bundled_tor_executable(path).is_file()
        && path.join("data").join("geoip").is_file()
        && path.join("data").join("geoip6").is_file()
}

fn locate_bundle(root_dir: &Path) -> Option<PathBuf> {
    let adjacent = root_dir.join("TorExpertBundle");
    if valid_bundle(&adjacent) {
        return Some(adjacent);
    }

    if let Some(resource_root) = std::env::var_os("KAIGEN_RESOURCE_ROOT") {
        let bundled = PathBuf::from(resource_root).join("TorExpertBundle");
        if valid_bundle(&bundled) {
            return Some(bundled);
        }
    }

    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var_os("APPDIR") {
        let bundled = PathBuf::from(appdir)
            .join("usr")
            .join("lib")
            .join("Kaigen")
            .join("TorExpertBundle");
        if valid_bundle(&bundled) {
            return Some(bundled);
        }
    }

    #[cfg(target_os = "macos")]
    if let Ok(executable) = std::env::current_exe() {
        if let Some(bundle) = executable.ancestors().find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        }) {
            let bundled = bundle
                .join("Contents")
                .join("Resources")
                .join("TorExpertBundle");
            if valid_bundle(&bundled) {
                return Some(bundled);
            }
        }
    }

    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let project = manifest_dir.parent()?;
        for development in [
            project.join("work").join("deps").join("TorExpertBundle"),
            project
                .join("work")
                .join("platform")
                .join(std::env::consts::OS)
                .join("TorExpertBundle"),
        ] {
            if valid_bundle(&development) {
                return Some(development);
            }
        }
    }
    None
}

fn tor_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
fn config_path(path: &Path, root_dir: &Path) -> String {
    // Fixed portable subdirectories are ASCII-only. Stripping a potentially
    // Unicode application root prevents Tor from reparsing that root through
    // its narrow Windows configuration-path API.
    tor_path(path.strip_prefix(root_dir).unwrap_or(path))
}

#[cfg(not(target_os = "windows"))]
fn config_path(path: &Path, _root_dir: &Path) -> String {
    tor_path(path)
}

fn plugin_line(config: &Value, name: &str, pt_path: &str) -> Result<String, String> {
    let template = config["pluggableTransports"][name]
        .as_str()
        .ok_or_else(|| format!("В Tor Expert Bundle отсутствует транспорт {name}"))?;
    let (prefix, executable_and_arguments) = template
        .split_once("${pt_path}")
        .ok_or_else(|| format!("Транспорт {name} не содержит portable-путь"))?;
    let executable_end = executable_and_arguments
        .find(char::is_whitespace)
        .unwrap_or(executable_and_arguments.len());
    if executable_end == 0 {
        return Err(format!("Транспорт {name} не содержит исполняемый файл"));
    }
    let executable = format!("{pt_path}{}", &executable_and_arguments[..executable_end]);
    if executable.chars().any(char::is_whitespace) {
        return Err(format!(
            "Portable-путь транспорта {name} содержит пробельный символ"
        ));
    }
    let arguments = &executable_and_arguments[executable_end..];
    Ok(format!("{prefix}{executable}{arguments}"))
}

fn append_bundled_bridges(
    lines: &mut Vec<String>,
    config: &Value,
    name: &str,
) -> Result<(), String> {
    let bridges = config["bridges"][name]
        .as_array()
        .ok_or_else(|| format!("В Tor Expert Bundle отсутствуют мосты {name}"))?;
    for bridge in bridges.iter().filter_map(Value::as_str) {
        lines.push(format!("Bridge {bridge}"));
    }
    Ok(())
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    shared: Weak<TorShared>,
    generation: u64,
    reader: BufReader<R>,
    is_stderr: bool,
) {
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => return,
                Ok(_) => {}
                Err(error) => {
                    if let Some(shared) = shared.upgrade() {
                        if let Ok(mut inner) = shared.inner.lock() {
                            if inner.generation == generation && inner.settings.enabled {
                                inner.status.state = "error".to_string();
                                inner.status.message =
                                    Some(format!("Не удалось прочитать вывод Tor: {error}"));
                            }
                        }
                    }
                    return;
                }
            }
            while buffer
                .last()
                .is_some_and(|byte| matches!(*byte, b'\r' | b'\n'))
            {
                buffer.pop();
            }
            let line = String::from_utf8_lossy(&buffer).into_owned();
            let Some(shared) = shared.upgrade() else {
                return;
            };
            if let Ok(mut log) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&shared.log_path)
            {
                let _ = writeln!(log, "{line}");
            }
            let mut inner = match shared.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return,
            };
            if inner.generation != generation || !inner.settings.enabled {
                return;
            }
            if let Some(progress) = bootstrap_progress(&line) {
                inner.status.progress = progress;
                inner.status.state = if progress >= 100 {
                    "connected".to_string()
                } else {
                    "connecting".to_string()
                };
                inner.status.message = Some(bootstrap_message(&line));
            } else if is_stderr || line.contains("[err]") {
                inner.status.state = "error".to_string();
                inner.status.message = Some(line);
            }
        }
    });
}

fn spawn_process_monitor(shared: Weak<TorShared>, generation: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let Some(shared) = shared.upgrade() else {
            return;
        };
        let mut inner = match shared.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        if inner.generation != generation || !inner.settings.enabled {
            return;
        }
        let exit = match inner.child.as_mut() {
            Some(child) => child.try_wait(),
            None => return,
        };
        match exit {
            Ok(Some(status)) => {
                inner.child = None;
                inner.status.state = "error".to_string();
                inner.status.message = Some(format!("Tor завершился: {status}"));
                return;
            }
            Ok(None) => {}
            Err(error) => {
                inner.status.state = "error".to_string();
                inner.status.message = Some(format!("Не удалось проверить процесс Tor: {error}"));
                return;
            }
        }
    });
}

fn bootstrap_progress(line: &str) -> Option<u8> {
    let rest = line.split_once("Bootstrapped ")?.1;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u8>().ok().map(|value| value.min(100))
}

fn bootstrap_message(line: &str) -> String {
    line.split_once("Bootstrapped ")
        .map(|(_, message)| format!("Bootstrapped {message}"))
        .unwrap_or_else(|| line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_ports_are_distinct_and_not_standard_tor_ports() {
        let (_socks_listener, socks_port) = reserve_nonstandard_port().unwrap();
        let (_control_listener, control_port) = reserve_nonstandard_port().unwrap();
        assert_ne!(socks_port, control_port);
        assert!(!STANDARD_TOR_PORTS.contains(&socks_port));
        assert!(!STANDARD_TOR_PORTS.contains(&control_port));
    }

    #[test]
    fn bootstrap_percent_is_read_from_real_tor_log_line() {
        assert_eq!(
            bootstrap_progress("Aug 07 12:00:00 [notice] Bootstrapped 75% (enough_dirinfo): Loaded enough directory info"),
            Some(75)
        );
        assert_eq!(bootstrap_progress("unrelated"), None);
    }

    #[test]
    fn pluggable_transport_executable_rejects_whitespace_instead_of_quoting_it() {
        let config = serde_json::json!({
            "pluggableTransports": {
                "lyrebird": "ClientTransportPlugin obfs4 exec ${pt_path}lyrebird --managed"
            }
        });
        let error = plugin_line(
            &config,
            "lyrebird",
            "/Users/kaigen/Applications/Kaigen Portable/Tor/",
        )
        .unwrap_err();
        assert!(error.contains("пробельный символ"));
    }

    #[test]
    fn unix_pluggable_transport_executable_is_relative_and_unquoted() {
        let config = serde_json::json!({
            "pluggableTransports": {
                "lyrebird": "ClientTransportPlugin obfs4 exec ${pt_path}lyrebird"
            }
        });
        assert_eq!(
            plugin_line(&config, "lyrebird", "tor/pluggable_transports/").unwrap(),
            "ClientTransportPlugin obfs4 exec tor/pluggable_transports/lyrebird"
        );
    }

    #[test]
    fn windows_relative_transport_executable_is_unquoted() {
        let config = serde_json::json!({
            "pluggableTransports": {
                "lyrebird": "ClientTransportPlugin obfs4 exec ${pt_path}lyrebird.exe"
            }
        });
        assert_eq!(
            plugin_line(
                &config,
                "lyrebird",
                "TorExpertBundle/tor/pluggable_transports/",
            )
            .unwrap(),
            "ClientTransportPlugin obfs4 exec TorExpertBundle/tor/pluggable_transports/lyrebird.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tor_config_paths_do_not_embed_unicode_portable_root() {
        let root = PathBuf::from(r"C:\Desktop\Kaigen-portable — копия");
        assert_eq!(
            config_path(&root.join("data").join("tor"), &root),
            "data/tor"
        );
        assert_eq!(
            config_path(
                &root
                    .join("TorExpertBundle")
                    .join("tor")
                    .join("pluggable_transports"),
                &root,
            ),
            "TorExpertBundle/tor/pluggable_transports"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn tor_config_paths_remain_absolute_on_unix() {
        let root = PathBuf::from("/tmp/Kaigen portable");
        assert_eq!(
            config_path(&root.join("data").join("tor"), &root),
            "/tmp/Kaigen portable/data/tor"
        );
    }
}
