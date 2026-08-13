use std::{
    collections::{HashMap, HashSet},
    ffi::c_void,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use blake2::{
    digest::{consts::U32, KeyInit, Mac},
    Blake2bMac,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

mod instance;
mod pq;
mod profiles;
mod qtox_history;
mod tor;
use instance::{InstanceGuard, InstanceOutcome};
use pq::{PqEngine, PqSessionEvent, PqStatus};
use profiles::{atomic_write, ProfileCipher, ProfileRecord, ProfileRegistry};
use tor::{TorManager, TorSettings, TorStatus};

#[derive(Clone)]
struct PortablePaths {
    root_dir: PathBuf,
    data_dir: PathBuf,
    downloads_dir: PathBuf,
    logs_dir: PathBuf,
}

#[derive(Clone)]
struct ProfilePaths {
    data_dir: PathBuf,
    downloads_dir: PathBuf,
    outgoing_files_dir: PathBuf,
    avatars_dir: PathBuf,
    logs_dir: PathBuf,
    profile_path: PathBuf,
}

impl PortablePaths {
    fn discover() -> Result<Self, String> {
        let root_dir = instance::portable_root_for_current_executable()?;
        Self::from_root(root_dir)
    }

    fn from_root(root_dir: PathBuf) -> Result<Self, String> {
        let data_dir = root_dir.join("data");
        let downloads_dir = root_dir.join("downloads");
        let logs_dir = data_dir.join("logs");
        for directory in [&data_dir, &downloads_dir, &logs_dir] {
            fs::create_dir_all(directory).map_err(|error| {
                format!(
                    "Could not create portable data directory {}: {error}",
                    directory.display()
                )
            })?;
        }
        Ok(Self {
            root_dir,
            data_dir,
            downloads_dir,
            logs_dir,
        })
    }
}

impl ProfilePaths {
    fn new(root_dir: PathBuf, data_dir: PathBuf, profile_path: PathBuf) -> Result<Self, String> {
        let downloads_dir = root_dir.join("downloads");
        let outgoing_files_dir = data_dir.join("outgoing-files");
        let avatars_dir = data_dir.join("avatars");
        let logs_dir = data_dir.join("logs");
        for directory in [
            &data_dir,
            &downloads_dir,
            &outgoing_files_dir,
            &avatars_dir,
            &logs_dir,
        ] {
            fs::create_dir_all(directory).map_err(|error| {
                format!(
                    "Could not create portable profile directory {}: {error}",
                    directory.display()
                )
            })?;
        }
        Ok(Self {
            data_dir,
            downloads_dir,
            outgoing_files_dir,
            avatars_dir,
            logs_dir,
            profile_path,
        })
    }
}

#[cfg(target_os = "windows")]
fn grant_webview2_runtime_access(runtime_dir: &Path) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("icacls.exe")
        .arg(runtime_dir)
        .args([
            "/grant",
            "*S-1-15-2-2:(OI)(CI)(RX)",
            "*S-1-15-2-1:(OI)(CI)(RX)",
            "/Q",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(target_os = "windows")]
fn configure_portable_webview() -> Result<(), String> {
    let paths = PortablePaths::discover()?;
    let runtime_root = paths.root_dir.join("WebView2Runtime");
    let runtime_dir = if runtime_root.join("msedgewebview2.exe").is_file() {
        Some(runtime_root.clone())
    } else {
        fs::read_dir(&runtime_root).ok().and_then(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| path.is_dir() && path.join("msedgewebview2.exe").is_file())
        })
    };
    if let Some(runtime_dir) = runtime_dir {
        #[cfg(target_os = "windows")]
        grant_webview2_runtime_access(&runtime_dir);
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &runtime_dir);
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn configure_portable_webview() -> Result<(), String> {
    // Linux uses the WebKitGTK runtime bundled by AppImage and macOS uses the
    // system WebKit framework. Neither platform must inherit Windows WebView2
    // environment variables from a launcher or parent process.
    std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
    Ok(())
}

fn rebase_portable_file(stored_path: &str, directory: &Path) -> String {
    // A portable history can be moved between Windows and Unix. Path::file_name
    // only understands separators from the current OS, so split both forms.
    let filename = stored_path
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("file");
    directory.join(filename).to_string_lossy().into_owned()
}

fn unique_download_path(directory: &Path, filename: &str) -> PathBuf {
    let filename = safe_file_name(filename);
    let direct = directory.join(&filename);
    if !direct.exists() {
        return direct;
    }
    let path = Path::new(&filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1_u32.. {
        let candidate = match extension {
            Some(extension) if !extension.is_empty() => {
                directory.join(format!("{stem} ({index}).{extension}"))
            }
            _ => directory.join(format!("{stem} ({index})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn is_complete_avatar(path: &Path, expected_size: Option<u64>) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if metadata.len() == 0 || expected_size.is_some_and(|size| metadata.len() != size) {
        return false;
    }
    let mut header = [0_u8; 12];
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(read) = file.read(&mut header) else {
        return false;
    };
    (read >= 8 && header[..8] == [137, 80, 78, 71, 13, 10, 26, 10])
        || (read >= 3 && header[..3] == [0xff, 0xd8, 0xff])
        || (read >= 6 && (&header[..6] == b"GIF87a" || &header[..6] == b"GIF89a"))
        || (read >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP")
}

fn remove_friend_avatars(directory: &Path, friend_number: u32, except: Option<&Path>) {
    let prefix = format!("{friend_number}-");
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with(&prefix)
            && except.is_none_or(|kept| kept != path)
        {
            let _ = fs::remove_file(path);
        }
    }
}

struct ToxHandle {
    instance: NonNull<c_void>,
    profile_path: PathBuf,
    cipher: Option<ProfileCipher>,
}

#[derive(Clone)]
struct ProxyRoute {
    proxy_type: i32,
    host: String,
    port: u16,
    label: String,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxySettings {
    mode: String,
    host: String,
    port: u16,
    username: String,
    password: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkSettings {
    #[serde(default)]
    udp_enabled: bool,
    #[serde(default)]
    ipv6_enabled: bool,
    #[serde(default)]
    local_discovery_enabled: bool,
}

impl NetworkSettings {
    fn normalized(mut self) -> Self {
        // LAN discovery is implemented by toxcore through its UDP transport.
        // Enabling it must therefore enable UDP as well.
        if self.local_discovery_enabled {
            self.udp_enabled = true;
        }
        self
    }

    fn effective_for_route(&self, proxied: bool) -> Self {
        let udp_enabled = self.udp_enabled && !proxied;
        Self {
            udp_enabled,
            ipv6_enabled: self.ipv6_enabled,
            local_discovery_enabled: self.local_discovery_enabled && udp_enabled,
        }
    }
}

fn apply_network_options(
    options: *mut c_void,
    settings: &NetworkSettings,
    proxied: bool,
) -> NetworkSettings {
    let effective = settings.effective_for_route(proxied);
    unsafe {
        tox_options_set_ipv6_enabled(options, effective.ipv6_enabled);
        tox_options_set_udp_enabled(options, effective.udp_enabled);
        tox_options_set_local_discovery_enabled(options, effective.local_discovery_enabled);
    }
    effective
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            mode: "none".to_string(),
            host: "127.0.0.1".to_string(),
            port: 9050,
            username: String::new(),
            password: String::new(),
        }
    }
}

impl ProxySettings {
    fn route(&self) -> Option<ProxyRoute> {
        let proxy_type = match self.mode.as_str() {
            "http" => 1,
            "socks5" => 2,
            _ => return None,
        };
        Some(ProxyRoute {
            proxy_type,
            host: self.host.clone(),
            port: self.port,
            label: self.mode.clone(),
        })
    }
}

#[derive(Clone)]
struct ProxyBridge {
    port: u16,
    running: Arc<AtomicBool>,
}

impl ProxyBridge {
    fn start(settings: ProxySettings) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Could not start the authenticated proxy adapter: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let running = Arc::new(AtomicBool::new(true));
        let worker_running = Arc::clone(&running);
        thread::spawn(move || {
            while worker_running.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((client, _)) => {
                        let settings = settings.clone();
                        thread::spawn(move || {
                            let _ = if settings.mode == "socks5" {
                                bridge_socks5(client, &settings)
                            } else {
                                bridge_http(client, &settings)
                            };
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50))
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            }
        });
        Ok(Self { port, running })
    }

    fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

fn relay_streams(client: TcpStream, upstream: TcpStream) -> Result<(), String> {
    let mut client_read = client.try_clone().map_err(|error| error.to_string())?;
    let mut upstream_write = upstream.try_clone().map_err(|error| error.to_string())?;
    let forward = thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut upstream_write);
        let _ = upstream_write.shutdown(Shutdown::Write);
    });
    let mut upstream_read = upstream;
    let mut client_write = client;
    let _ = std::io::copy(&mut upstream_read, &mut client_write);
    let _ = client_write.shutdown(Shutdown::Write);
    let _ = forward.join();
    Ok(())
}

fn read_socks_address(stream: &mut TcpStream, atyp: u8) -> Result<Vec<u8>, String> {
    let address_length = match atyp {
        1 => 4,
        4 => 16,
        3 => {
            let mut size = [0_u8; 1];
            stream
                .read_exact(&mut size)
                .map_err(|error| error.to_string())?;
            return {
                let mut bytes = vec![size[0]];
                let mut rest = vec![0_u8; size[0] as usize + 2];
                stream
                    .read_exact(&mut rest)
                    .map_err(|error| error.to_string())?;
                bytes.extend(rest);
                Ok(bytes)
            };
        }
        _ => return Err("Unsupported SOCKS5 address type".to_string()),
    };
    let mut bytes = vec![0_u8; address_length + 2];
    stream
        .read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn bridge_socks5(mut client: TcpStream, settings: &ProxySettings) -> Result<(), String> {
    client.set_read_timeout(Some(Duration::from_secs(15))).ok();
    let mut greeting = [0_u8; 2];
    client
        .read_exact(&mut greeting)
        .map_err(|error| error.to_string())?;
    if greeting[0] != 5 {
        return Err("Invalid local SOCKS5 greeting".to_string());
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    client
        .read_exact(&mut methods)
        .map_err(|error| error.to_string())?;
    let mut upstream = TcpStream::connect_timeout(
        &(settings.host.as_str(), settings.port)
            .to_socket_addrs()
            .map_err(|error| error.to_string())?
            .next()
            .ok_or_else(|| "Proxy address did not resolve".to_string())?,
        Duration::from_secs(10),
    )
    .map_err(|error| error.to_string())?;
    let authenticated = !settings.username.is_empty() || !settings.password.is_empty();
    upstream
        .write_all(if authenticated {
            &[5, 2, 0, 2]
        } else {
            &[5, 1, 0]
        })
        .map_err(|error| error.to_string())?;
    let mut selection = [0_u8; 2];
    upstream
        .read_exact(&mut selection)
        .map_err(|error| error.to_string())?;
    if selection[0] != 5 || selection[1] == 0xff {
        return Err("Upstream SOCKS5 proxy rejected authentication methods".to_string());
    }
    if selection[1] == 2 {
        let username = settings.username.as_bytes();
        let password = settings.password.as_bytes();
        if username.len() > 255 || password.len() > 255 {
            return Err("SOCKS5 credentials are too long".to_string());
        }
        let mut auth = vec![1, username.len() as u8];
        auth.extend(username);
        auth.push(password.len() as u8);
        auth.extend(password);
        upstream
            .write_all(&auth)
            .map_err(|error| error.to_string())?;
        let mut response = [0_u8; 2];
        upstream
            .read_exact(&mut response)
            .map_err(|error| error.to_string())?;
        if response[1] != 0 {
            return Err("SOCKS5 username or password was rejected".to_string());
        }
    }
    client
        .write_all(&[5, 0])
        .map_err(|error| error.to_string())?;
    let mut request = [0_u8; 4];
    client
        .read_exact(&mut request)
        .map_err(|error| error.to_string())?;
    let address = read_socks_address(&mut client, request[3])?;
    upstream
        .write_all(&request)
        .and_then(|_| upstream.write_all(&address))
        .map_err(|error| error.to_string())?;
    let mut response = [0_u8; 4];
    upstream
        .read_exact(&mut response)
        .map_err(|error| error.to_string())?;
    let bound = read_socks_address(&mut upstream, response[3])?;
    client
        .write_all(&response)
        .and_then(|_| client.write_all(&bound))
        .map_err(|error| error.to_string())?;
    if response[1] != 0 {
        return Err(format!(
            "SOCKS5 proxy connection failed with code {}",
            response[1]
        ));
    }
    client.set_read_timeout(None).ok();
    upstream.set_read_timeout(None).ok();
    relay_streams(client, upstream)
}

fn base64_basic(value: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in value.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn bridge_http(mut client: TcpStream, settings: &ProxySettings) -> Result<(), String> {
    client.set_read_timeout(Some(Duration::from_secs(15))).ok();
    let mut request = Vec::new();
    let mut byte = [0_u8; 1];
    while request.len() < 64 * 1024 && !request.ends_with(b"\r\n\r\n") {
        client
            .read_exact(&mut byte)
            .map_err(|error| error.to_string())?;
        request.push(byte[0]);
    }
    if !request.ends_with(b"\r\n\r\n") {
        return Err("HTTP proxy request headers are too large".to_string());
    }
    let mut upstream = TcpStream::connect_timeout(
        &(settings.host.as_str(), settings.port)
            .to_socket_addrs()
            .map_err(|error| error.to_string())?
            .next()
            .ok_or_else(|| "Proxy address did not resolve".to_string())?,
        Duration::from_secs(10),
    )
    .map_err(|error| error.to_string())?;
    if !settings.username.is_empty() || !settings.password.is_empty() {
        request.truncate(request.len() - 2);
        let credentials =
            base64_basic(format!("{}:{}", settings.username, settings.password).as_bytes());
        request.extend(format!("Proxy-Authorization: Basic {credentials}\r\n\r\n").as_bytes());
    }
    upstream
        .write_all(&request)
        .map_err(|error| error.to_string())?;
    client.set_read_timeout(None).ok();
    relay_streams(client, upstream)
}

fn prepare_proxy_route(
    settings: &ProxySettings,
) -> Result<(Option<ProxyRoute>, Option<ProxyBridge>), String> {
    let Some(route) = settings.route() else {
        return Ok((None, None));
    };
    if settings.username.is_empty() && settings.password.is_empty() {
        return Ok((Some(route), None));
    }
    let bridge = ProxyBridge::start(settings.clone())?;
    let local_route = ProxyRoute {
        proxy_type: route.proxy_type,
        host: "127.0.0.1".to_string(),
        port: bridge.port,
        label: format!("{}-authenticated-adapter", route.label),
    };
    Ok((Some(local_route), Some(bridge)))
}

fn create_tox_handle(
    profile_path: PathBuf,
    savedata: Option<&[u8]>,
    proxy_route: Option<&ProxyRoute>,
    network_settings: &NetworkSettings,
    cipher: Option<ProfileCipher>,
) -> Result<ToxHandle, String> {
    let mut options_error = 0_i32;
    let options = unsafe { tox_options_new(&mut options_error) };
    let options = NonNull::new(options).ok_or_else(|| {
        format!("Не удалось подготовить параметры Tox (код ошибки {options_error})")
    })?;

    // c-toxcore cannot carry UDP or LAN discovery through a TCP proxy. Keep
    // the user's shared choices for direct mode, while enforcing a strict
    // proxy/Tor route whenever one is configured.
    apply_network_options(options.as_ptr(), network_settings, proxy_route.is_some());

    if let Some(data) = savedata {
        unsafe {
            tox_options_set_savedata_type(options.as_ptr(), 1);
            if !tox_options_set_savedata_data(options.as_ptr(), data.as_ptr(), data.len()) {
                tox_options_free(options.as_ptr());
                return Err("Не удалось загрузить сохранённый профиль Tox".to_string());
            }
        }
    }

    let proxy_host = proxy_route
        .map(|route| {
            CString::new(route.host.as_str())
                .map_err(|_| "Proxy host contains an invalid zero byte".to_string())
        })
        .transpose()?;
    if let (Some(route), Some(host)) = (proxy_route, proxy_host.as_ref()) {
        unsafe {
            // Strict proxy mode: toxcore cannot silently fall back to a direct
            // route. UDP, IPv6 and local discovery are disabled above.
            tox_options_set_proxy_type(options.as_ptr(), route.proxy_type);
            if !tox_options_set_proxy_host(options.as_ptr(), host.as_ptr()) {
                tox_options_free(options.as_ptr());
                return Err("Не удалось установить локальный SOCKS5-прокси Tor".to_string());
            }
            tox_options_set_proxy_port(options.as_ptr(), route.port);
            tox_options_set_experimental_disable_dns(options.as_ptr(), true);
        }
    }

    let mut error = 0_i32;
    let instance = unsafe { tox_new(options.as_ptr(), &mut error) };
    unsafe { tox_options_free(options.as_ptr()) };
    let instance = NonNull::new(instance)
        .ok_or_else(|| format!("Не удалось создать профиль Tox (код ошибки {error})"))?;
    Ok(ToxHandle {
        instance,
        profile_path,
        cipher,
    })
}

#[derive(Clone, Deserialize, Serialize)]
struct IncomingFriendRequest {
    public_key: String,
    message: String,
}

#[derive(Serialize)]
struct ToxFriend {
    number: u32,
    public_key: String,
    tox_id: String,
    authorized: bool,
    connection: String,
    name: String,
    status: String,
    status_message: String,
    avatar_path: Option<String>,
    last_online: Option<u64>,
    last_event: Option<u64>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct CachedFriendProfile {
    name: String,
    #[serde(default)]
    authorized: bool,
    #[serde(default)]
    tox_id: String,
    #[serde(default)]
    status_message: String,
    #[serde(default)]
    last_online: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ToxAttachment {
    name: String,
    size: u64,
    mime: String,
    path: String,
    #[serde(default)]
    image: bool,
    #[serde(default)]
    transferred: u64,
    #[serde(default)]
    speed_bytes_per_sec: u64,
    #[serde(default)]
    eta_seconds: Option<u64>,
    #[serde(default = "default_attachment_state")]
    transfer_state: String,
    #[serde(default = "default_attachment_complete")]
    completed: bool,
    #[serde(default)]
    completed_at: Option<u64>,
    #[serde(default)]
    transfer_error: Option<String>,
    #[serde(default)]
    retry_count: u8,
}

#[derive(Serialize)]
struct NativeFileMetadata {
    size: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct ToxMessage {
    #[serde(default)]
    id: String,
    friend_number: u32,
    text: String,
    mine: bool,
    timestamp: u64,
    #[serde(default = "default_message_delivery")]
    delivery: String,
    #[serde(default)]
    delivered_at: Option<u64>,
    #[serde(default)]
    attachment: Option<ToxAttachment>,
    #[serde(default)]
    event: Option<PqHistoryEvent>,
}

#[derive(Clone, Deserialize, Serialize)]
struct PqHistoryEvent {
    kind: String,
    status: String,
    role: String,
    local_fingerprint: String,
    peer_fingerprint: Option<String>,
    fingerprint_changed: bool,
    error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct PendingToxMessage {
    id: String,
    friend_number: u32,
    text: String,
    timestamp: u64,
    #[serde(default)]
    next_offset: usize,
}

// toxcore cannot start a normal file transfer until the recipient is online.
// Keep a durable copy and retry it from the network loop, just like text.
#[derive(Clone, Deserialize, Serialize)]
struct PendingToxFile {
    id: String,
    friend_number: u32,
    filename: String,
    mime: String,
    path: String,
    size: u64,
    timestamp: u64,
    #[serde(default)]
    retry_count: u8,
}

fn default_message_delivery() -> String {
    "sent".to_string()
}
fn default_attachment_state() -> String {
    "complete".to_string()
}
fn default_attachment_complete() -> bool {
    true
}

// Tor and pluggable transports may pause for quite a while without the
// transfer being dead.  A successful chunk always refreshes last_activity_at;
// after the first byte we therefore allow a substantially longer idle window.
const FILE_TRANSFER_INITIAL_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const FILE_TRANSFER_ACTIVE_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_FILE_TRANSFER_RETRIES: u8 = 2;
const TOX_TEXT_CHUNK_BYTES: usize = 1200;

#[derive(Default)]
struct ReceiptProgress {
    remaining: usize,
    all_sent: bool,
}

fn text_chunk_end(text: &str, start: usize) -> usize {
    let hard_end = start.saturating_add(TOX_TEXT_CHUNK_BYTES).min(text.len());
    if hard_end == text.len() {
        return hard_end;
    }
    let mut end = hard_end;
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    // Prefer a natural boundary, but never turn a healthy large chunk into a
    // tiny one just because no whitespace occurred near its end.
    let floor = start + (end - start) / 2;
    if let Some(relative) = text[start..end]
        .char_indices()
        .rev()
        .find_map(|(index, ch)| ch.is_whitespace().then_some(index + ch.len_utf8()))
    {
        let candidate = start + relative;
        if candidate >= floor {
            return candidate;
        }
    }
    end
}

fn transfer_idle_timeout(meter: &TransferMeter) -> Duration {
    if meter.last_transferred > 0 {
        FILE_TRANSFER_ACTIVE_IDLE_TIMEOUT
    } else {
        FILE_TRANSFER_INITIAL_IDLE_TIMEOUT
    }
}

#[derive(Clone)]
struct TransferMeter {
    last_at: Instant,
    last_transferred: u64,
    speed_bytes_per_sec: u64,
}

impl TransferMeter {
    fn new() -> Self {
        Self {
            last_at: Instant::now(),
            last_transferred: 0,
            speed_bytes_per_sec: 0,
        }
    }

    fn update(&mut self, transferred: u64) -> u64 {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_at);
        if elapsed >= Duration::from_millis(150) || transferred < self.last_transferred {
            let bytes = transferred.saturating_sub(self.last_transferred);
            self.speed_bytes_per_sec = if elapsed.as_nanos() > 0 {
                (bytes as f64 / elapsed.as_secs_f64()).round() as u64
            } else {
                0
            };
            self.last_at = now;
            self.last_transferred = transferred;
        }
        self.speed_bytes_per_sec
    }
}

fn update_attachment_progress(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    message_id: &str,
    transferred: u64,
    speed_bytes_per_sec: u64,
    total_size: u64,
    transfer_state: &str,
    completed: bool,
    completed_at: Option<u64>,
) {
    let Ok(mut messages) = messages.lock() else {
        return;
    };
    let Some(message) = messages.iter_mut().find(|message| message.id == message_id) else {
        return;
    };
    let Some(attachment) = message.attachment.as_mut() else {
        return;
    };
    attachment.transferred = transferred.min(total_size);
    attachment.speed_bytes_per_sec = speed_bytes_per_sec;
    attachment.eta_seconds = if completed || speed_bytes_per_sec == 0 {
        None
    } else {
        Some(
            total_size
                .saturating_sub(attachment.transferred)
                .div_ceil(speed_bytes_per_sec),
        )
    };
    attachment.transfer_state = transfer_state.to_string();
    attachment.completed = completed;
    attachment.completed_at = completed_at;
    attachment.transfer_error = None;
}

fn set_attachment_transfer_state(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    message_id: &str,
    transfer_state: &str,
) {
    let Ok(mut messages) = messages.lock() else {
        return;
    };
    let Some(message) = messages.iter_mut().find(|message| message.id == message_id) else {
        return;
    };
    let Some(attachment) = message.attachment.as_mut() else {
        return;
    };
    attachment.transfer_state = transfer_state.to_string();
    attachment.speed_bytes_per_sec = 0;
    attachment.eta_seconds = None;
    attachment.completed = false;
    attachment.completed_at = None;
}

fn set_attachment_transfer_error(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    message_id: &str,
    error: impl Into<String>,
) {
    let Ok(mut messages) = messages.lock() else {
        return;
    };
    let Some(message) = messages.iter_mut().find(|message| message.id == message_id) else {
        return;
    };
    let Some(attachment) = message.attachment.as_mut() else {
        return;
    };
    attachment.transfer_state = "failed".to_string();
    attachment.speed_bytes_per_sec = 0;
    attachment.eta_seconds = None;
    attachment.completed = false;
    attachment.completed_at = None;
    attachment.transfer_error = Some(error.into());
}

fn set_attachment_retrying(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    message_id: &str,
    retry_count: u8,
) {
    let Ok(mut messages) = messages.lock() else {
        return;
    };
    let Some(message) = messages.iter_mut().find(|message| message.id == message_id) else {
        return;
    };
    let Some(attachment) = message.attachment.as_mut() else {
        return;
    };
    attachment.transfer_state = "queued".to_string();
    attachment.speed_bytes_per_sec = 0;
    attachment.eta_seconds = None;
    attachment.completed = false;
    attachment.completed_at = None;
    attachment.transfer_error = None;
    attachment.retry_count = retry_count;
}

#[derive(Clone)]
struct IncomingFile {
    path: PathBuf,
    final_path: Option<PathBuf>,
    size: u64,
    kind: u32,
    message_id: Option<String>,
    meter: TransferMeter,
    last_activity_at: Instant,
    active: bool,
    auto_queued: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReceiveSettings {
    deny_all: bool,
    auto_accept_images: bool,
    show_images: bool,
    auto_accept_any: bool,
    max_auto_bytes: u64,
    max_concurrent: usize,
}

impl Default for FileReceiveSettings {
    fn default() -> Self {
        Self {
            deny_all: false,
            auto_accept_images: true,
            show_images: true,
            auto_accept_any: false,
            max_auto_bytes: 10 * 1024 * 1024,
            max_concurrent: 1,
        }
    }
}

#[derive(Clone)]
struct OutgoingFile {
    path: PathBuf,
    size: u64,
    message_id: Option<String>,
    meter: TransferMeter,
    last_activity_at: Instant,
    fully_sent: bool,
    retry_count: u8,
}

struct CallbackContext {
    updates: Option<ProfileUpdateEmitter>,
    incoming_requests: Arc<Mutex<Vec<IncomingFriendRequest>>>,
    incoming_requests_path: PathBuf,
    messages: Arc<Mutex<Vec<ToxMessage>>>,
    delivery_receipts: Arc<Mutex<HashMap<(u32, u32), String>>>,
    receipt_progress: Arc<Mutex<HashMap<String, ReceiptProgress>>>,
    history_path: PathBuf,
    history_enabled: Arc<AtomicBool>,
    incoming_files: Arc<Mutex<HashMap<(u32, u32), IncomingFile>>>,
    outgoing_files: Arc<Mutex<HashMap<(u32, u32), OutgoingFile>>>,
    downloads_dir: PathBuf,
    avatars_dir: PathBuf,
    transfer_log_path: PathBuf,
    network_log_path: PathBuf,
    friend_cache: Arc<Mutex<HashMap<String, CachedFriendProfile>>>,
    friend_cache_path: PathBuf,
    pq: Arc<PqEngine>,
    pq_receipts: Arc<Mutex<HashMap<(u32, u64), String>>>,
    file_receive_settings: Arc<Mutex<FileReceiveSettings>>,
    unread_state: Arc<Mutex<UnreadState>>,
    unread_state_path: PathBuf,
}

#[derive(Clone)]
struct ProfileUpdateEmitter(Arc<dyn Fn() + Send + Sync>);

impl ProfileUpdateEmitter {
    fn changed(&self) {
        (self.0)();
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnreadState {
    #[serde(default)]
    friends: HashMap<String, u32>,
    #[serde(default)]
    requests: HashSet<String>,
}

impl UnreadState {
    fn total(&self) -> u32 {
        self.friends
            .values()
            .copied()
            .sum::<u32>()
            .saturating_add(self.requests.len().min(u32::MAX as usize) as u32)
    }
}

fn persist_unread_state(state: &Arc<Mutex<UnreadState>>, path: &Path) {
    let Ok(state) = state.lock() else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&*state) {
        let _ = atomic_write_sender().try_send(AtomicWriteRequest {
            path: path.to_path_buf(),
            bytes,
        });
    }
}

fn persist_unread_state_now(state: &Arc<Mutex<UnreadState>>, path: &Path) {
    let Ok(state) = state.lock() else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&*state) {
        let _ = atomic_write(path, &bytes);
    }
}

struct AtomicWriteRequest {
    path: PathBuf,
    bytes: Vec<u8>,
}

static ATOMIC_WRITE_SENDER: OnceLock<SyncSender<AtomicWriteRequest>> = OnceLock::new();

fn atomic_write_sender() -> &'static SyncSender<AtomicWriteRequest> {
    ATOMIC_WRITE_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<AtomicWriteRequest>(256);
        thread::spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut pending = HashMap::from([(first.path, first.bytes)]);
                let deadline = Instant::now() + Duration::from_millis(250);
                loop {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match receiver.recv_timeout(remaining) {
                        Ok(request) => {
                            pending.insert(request.path, request.bytes);
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                for (path, bytes) in pending {
                    with_active_batched_path(&path, || {
                        let _ = atomic_write(&path, &bytes);
                    });
                }
            }
        });
        sender
    })
}

fn increment_unread_friend(context: &CallbackContext, friend_number: u32) {
    if let Ok(mut state) = context.unread_state.lock() {
        let count = state.friends.entry(friend_number.to_string()).or_default();
        *count = count.saturating_add(1);
    }
    persist_unread_state(&context.unread_state, &context.unread_state_path);
    if let Some(updates) = &context.updates {
        updates.changed();
    }
}

fn mark_friend_authorized(context: &CallbackContext, tox: *mut c_void, friend_number: u32) -> bool {
    if tox.is_null() {
        return false;
    }
    let mut key = [0_u8; 32];
    let mut error = 0_i32;
    if !unsafe { tox_friend_get_public_key(tox, friend_number, key.as_mut_ptr(), &mut error) } {
        return false;
    }
    let public_key = hex_upper(&key);
    let mut changed = false;
    if let Ok(mut cache) = context.friend_cache.lock() {
        let entry = cache.entry(public_key).or_default();
        if !entry.authorized {
            entry.authorized = true;
            changed = true;
            if let Ok(serialized) = serde_json::to_vec(&*cache) {
                let _ = atomic_write_sender().try_send(AtomicWriteRequest {
                    path: context.friend_cache_path.clone(),
                    bytes: serialized,
                });
            }
        }
    }
    if changed {
        if let Some(updates) = &context.updates {
            updates.changed();
        }
    }
    changed
}

unsafe impl Send for ToxHandle {}

#[derive(Clone)]
struct ToxState {
    handle: Arc<Mutex<Option<ToxHandle>>>,
    handle_generation: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
    tor: TorManager,
    proxy_settings: Arc<Mutex<ProxySettings>>,
    network_settings: Arc<Mutex<NetworkSettings>>,
    proxy_bridge: Arc<Mutex<Option<ProxyBridge>>>,
    connection: Arc<AtomicU8>,
    network_enabled: Arc<AtomicBool>,
    network_state_path: PathBuf,
    incoming_requests: Arc<Mutex<Vec<IncomingFriendRequest>>>,
    incoming_requests_path: PathBuf,
    messages: Arc<Mutex<Vec<ToxMessage>>>,
    delivery_receipts: Arc<Mutex<HashMap<(u32, u32), String>>>,
    receipt_progress: Arc<Mutex<HashMap<String, ReceiptProgress>>>,
    history_path: PathBuf,
    history_enabled: Arc<AtomicBool>,
    pending_messages: Arc<Mutex<Vec<PendingToxMessage>>>,
    pending_messages_path: PathBuf,
    pending_pq_messages: Arc<Mutex<Vec<PendingToxMessage>>>,
    pending_pq_messages_path: PathBuf,
    pending_files: Arc<Mutex<Vec<PendingToxFile>>>,
    pending_files_path: PathBuf,
    incoming_files: Arc<Mutex<HashMap<(u32, u32), IncomingFile>>>,
    outgoing_files: Arc<Mutex<HashMap<(u32, u32), OutgoingFile>>>,
    downloads_dir: PathBuf,
    outgoing_files_dir: PathBuf,
    avatars_dir: PathBuf,
    transfer_log_path: PathBuf,
    network_log_path: PathBuf,
    friend_cache: Arc<Mutex<HashMap<String, CachedFriendProfile>>>,
    friend_cache_path: PathBuf,
    pq: Arc<PqEngine>,
    pq_receipts: Arc<Mutex<HashMap<(u32, u64), String>>>,
    file_receive_settings: Arc<Mutex<FileReceiveSettings>>,
    file_receive_settings_path: PathBuf,
    unread_state: Arc<Mutex<UnreadState>>,
    unread_state_path: PathBuf,
    updates: Option<ProfileUpdateEmitter>,
    #[cfg(test)]
    iterations: Arc<AtomicU64>,
}

impl ToxState {
    fn new_for_profile(
        paths: ProfilePaths,
        tor: TorManager,
        proxy_settings: Arc<Mutex<ProxySettings>>,
        network_settings: Arc<Mutex<NetworkSettings>>,
        updates: Option<ProfileUpdateEmitter>,
        savedata: Option<Vec<u8>>,
        cipher: Option<ProfileCipher>,
        new_profile_name: Option<&str>,
    ) -> Result<Self, String> {
        let profile_path = paths.profile_path.clone();
        let profile_exists = savedata.is_some();
        let network_state_path = paths.data_dir.join("network-state.json");
        // Tox saves Online/Busy in its profile.  The separate flag persists
        // the user's explicit "disconnect" choice, so we do not bootstrap on
        // the next application start until they choose an online status again.
        let network_enabled = fs::read_to_string(&network_state_path)
            .map(|value| value.trim() != "offline")
            .unwrap_or(true);
        let proxy_settings_value = proxy_settings
            .lock()
            .map_err(|_| "Could not read the shared proxy settings".to_string())?
            .clone();
        let network_settings_value = network_settings
            .lock()
            .map_err(|_| "Could not read the shared Tox network settings".to_string())?
            .clone();
        let (route, proxy_bridge) = if tor.enabled() {
            (
                Some(ProxyRoute {
                    proxy_type: 2,
                    host: "127.0.0.1".to_string(),
                    port: tor.proxy_port().ok_or_else(|| {
                        tor.status()
                            .message
                            .unwrap_or_else(|| "Tor не выделил SOCKS5-порт".to_string())
                    })?,
                    label: "tor-socks5".to_string(),
                }),
                None,
            )
        } else {
            prepare_proxy_route(&proxy_settings_value)?
        };
        let handle = create_tox_handle(
            profile_path,
            savedata.as_deref(),
            route.as_ref(),
            &network_settings_value,
            cipher,
        )?;
        if !profile_exists {
            let default_nickname = new_profile_name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Tox User")
                .as_bytes();
            let mut name_error = 0_i32;
            if !unsafe {
                tox_self_set_name(
                    handle.instance.as_ptr(),
                    default_nickname.as_ptr(),
                    default_nickname.len(),
                    &mut name_error,
                )
            } {
                unsafe { tox_kill(handle.instance.as_ptr()) };
                return Err(format!(
                    "Не удалось установить ник нового профиля Tox (код {name_error})"
                ));
            }
            if let Err(error) = Self::save(&handle) {
                unsafe { tox_kill(handle.instance.as_ptr()) };
                return Err(error);
            }
        }

        let history_path = paths.data_dir.join("chat-history.json");
        let pending_messages_path = paths.data_dir.join("pending-messages.json");
        let pending_pq_messages_path = paths.data_dir.join("pending-pq-messages.json");
        let pending_files_path = paths.data_dir.join("pending-files.json");
        let incoming_requests_path = paths.data_dir.join("incoming-friend-requests.json");
        let friend_cache_path = paths.data_dir.join("friend-profiles.json");
        let file_receive_settings_path = paths.data_dir.join("file-settings.json");
        let file_receive_settings = fs::read(&file_receive_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        let unread_state_path = paths.data_dir.join("unread-events.json");
        allow_batched_write(&history_path);
        allow_batched_write(&unread_state_path);
        allow_batched_write(&friend_cache_path);
        allow_batched_write(&pending_messages_path);
        allow_batched_write(&pending_pq_messages_path);
        let unread_state = fs::read(&unread_state_path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        let friend_cache = fs::read(&friend_cache_path)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let transfer_log_path = paths.logs_dir.join("file-transfer.log");
        let network_log_path = paths.logs_dir.join("tox-network.log");
        let mut messages = fs::read(&history_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<ToxMessage>>(&contents).ok())
            .unwrap_or_default();
        for message in &mut messages {
            if let Some(attachment) = message.attachment.as_mut() {
                let directory = if message.mine {
                    &paths.outgoing_files_dir
                } else {
                    &paths.downloads_dir
                };
                attachment.path = rebase_portable_file(&attachment.path, directory);
            }
        }
        let pending_messages = fs::read(&pending_messages_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<PendingToxMessage>>(&contents).ok())
            .unwrap_or_default();
        let pending_pq_messages = fs::read(&pending_pq_messages_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<PendingToxMessage>>(&contents).ok())
            .unwrap_or_default();
        let mut pending_files = fs::read(&pending_files_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<PendingToxFile>>(&contents).ok())
            .unwrap_or_default();
        for file in &mut pending_files {
            file.path = rebase_portable_file(&file.path, &paths.outgoing_files_dir);
        }
        let incoming_requests = fs::read(&incoming_requests_path)
            .ok()
            .and_then(|contents| {
                serde_json::from_slice::<Vec<IncomingFriendRequest>>(&contents).ok()
            })
            .unwrap_or_default();

        let pq = Arc::new(PqEngine::new(&paths.data_dir)?);
        let state = Self {
            handle: Arc::new(Mutex::new(Some(handle))),
            handle_generation: Arc::new(AtomicU64::new(1)),
            running: Arc::new(AtomicBool::new(true)),
            tor,
            proxy_settings,
            network_settings,
            proxy_bridge: Arc::new(Mutex::new(proxy_bridge)),
            connection: Arc::new(AtomicU8::new(0)),
            network_enabled: Arc::new(AtomicBool::new(network_enabled)),
            network_state_path,
            incoming_requests: Arc::new(Mutex::new(incoming_requests)),
            incoming_requests_path,
            messages: Arc::new(Mutex::new(messages)),
            delivery_receipts: Arc::new(Mutex::new(HashMap::new())),
            receipt_progress: Arc::new(Mutex::new(HashMap::new())),
            history_path,
            history_enabled: Arc::new(AtomicBool::new(true)),
            pending_messages: Arc::new(Mutex::new(pending_messages)),
            pending_messages_path,
            pending_pq_messages: Arc::new(Mutex::new(pending_pq_messages)),
            pending_pq_messages_path,
            pending_files: Arc::new(Mutex::new(pending_files)),
            pending_files_path,
            incoming_files: Arc::new(Mutex::new(HashMap::new())),
            outgoing_files: Arc::new(Mutex::new(HashMap::new())),
            downloads_dir: paths.downloads_dir,
            outgoing_files_dir: paths.outgoing_files_dir,
            avatars_dir: paths.avatars_dir,
            transfer_log_path,
            network_log_path,
            friend_cache: Arc::new(Mutex::new(friend_cache)),
            friend_cache_path,
            pq,
            pq_receipts: Arc::new(Mutex::new(HashMap::new())),
            file_receive_settings: Arc::new(Mutex::new(file_receive_settings)),
            file_receive_settings_path,
            unread_state: Arc::new(Mutex::new(unread_state)),
            unread_state_path,
            updates,
            #[cfg(test)]
            iterations: Arc::new(AtomicU64::new(0)),
        };
        persist_pending_files(&state.pending_files, &state.pending_files_path);
        persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
        Ok(state)
    }

    fn save(handle: &ToxHandle) -> Result<(), String> {
        let length = unsafe { tox_get_savedata_size(handle.instance.as_ptr()) };
        let mut savedata = vec![0_u8; length];
        unsafe { tox_get_savedata(handle.instance.as_ptr(), savedata.as_mut_ptr()) };
        let disk_data = match handle.cipher.as_ref() {
            Some(cipher) => cipher.encrypt(&savedata)?,
            None => savedata,
        };
        atomic_write(&handle.profile_path, &disk_data)
            .map_err(|error| format!("Не удалось атомарно сохранить профиль Tox: {error}"))
    }

    fn save_network_enabled(&self, enabled: bool) -> Result<(), String> {
        fs::write(
            &self.network_state_path,
            if enabled { "online" } else { "offline" },
        )
        .map_err(|error| format!("Не удалось сохранить режим подключения Tox: {error}"))
    }

    fn rebuild_network_route(&self) -> Result<(), String> {
        let (route, next_bridge) = if self.tor.enabled() {
            (
                Some(ProxyRoute {
                    proxy_type: 2,
                    host: "127.0.0.1".to_string(),
                    port: self
                        .tor
                        .proxy_port()
                        .ok_or_else(|| "Tor не выделил SOCKS5-порт".to_string())?,
                    label: "tor-socks5".to_string(),
                }),
                None,
            )
        } else {
            let settings = self
                .proxy_settings
                .lock()
                .map_err(|_| "Could not read proxy settings".to_string())?
                .clone();
            prepare_proxy_route(&settings)?
        };
        let mut guard = self
            .handle
            .lock()
            .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
        let current = guard
            .as_ref()
            .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
        Self::save(current)?;
        let profile_path = current.profile_path.clone();
        let disk_data = fs::read(&profile_path)
            .map_err(|error| format!("Не удалось перечитать профиль Tox: {error}"))?;
        let cipher = current.cipher.clone();
        let savedata = match cipher.as_ref() {
            Some(cipher) => cipher.decrypt(&disk_data)?,
            None => disk_data,
        };
        let network_settings = self
            .network_settings
            .lock()
            .map_err(|_| "Could not read the shared Tox network settings".to_string())?
            .clone();
        let replacement = create_tox_handle(
            profile_path,
            Some(&savedata),
            route.as_ref(),
            &network_settings,
            cipher,
        )?;
        let previous = guard.replace(replacement);
        self.handle_generation.fetch_add(1, Ordering::SeqCst);
        self.connection.store(0, Ordering::Relaxed);
        if let Some(updates) = &self.updates {
            updates.changed();
        }
        if let Some(previous) = previous {
            unsafe { tox_kill(previous.instance.as_ptr()) };
        }
        if let Ok(mut bridge) = self.proxy_bridge.lock() {
            if let Some(previous) = bridge.take() {
                previous.stop();
            }
            *bridge = next_bridge;
        }
        log_network(
            &self.network_log_path,
            format!(
                "TOX_RECREATED route={}",
                route
                    .as_ref()
                    .map(|route| route.label.as_str())
                    .unwrap_or("direct-user-choice")
            ),
        );
        Ok(())
    }

    fn start_network_loop(&self) {
        let state = self.clone();
        thread::spawn(move || {
            let mut last_bootstrap = Instant::now() - Duration::from_secs(60);
            let callback_store = Arc::into_raw(Arc::new(CallbackContext {
                updates: state.updates.clone(),
                incoming_requests: Arc::clone(&state.incoming_requests),
                incoming_requests_path: state.incoming_requests_path.clone(),
                messages: Arc::clone(&state.messages),
                delivery_receipts: Arc::clone(&state.delivery_receipts),
                receipt_progress: Arc::clone(&state.receipt_progress),
                history_path: state.history_path.clone(),
                history_enabled: Arc::clone(&state.history_enabled),
                incoming_files: Arc::clone(&state.incoming_files),
                outgoing_files: Arc::clone(&state.outgoing_files),
                downloads_dir: state.downloads_dir.clone(),
                avatars_dir: state.avatars_dir.clone(),
                transfer_log_path: state.transfer_log_path.clone(),
                network_log_path: state.network_log_path.clone(),
                friend_cache: Arc::clone(&state.friend_cache),
                friend_cache_path: state.friend_cache_path.clone(),
                pq: Arc::clone(&state.pq),
                pq_receipts: Arc::clone(&state.pq_receipts),
                file_receive_settings: Arc::clone(&state.file_receive_settings),
                unread_state: Arc::clone(&state.unread_state),
                unread_state_path: state.unread_state_path.clone(),
            })) as *mut c_void;
            let mut callback_generation = 0_u64;
            let mut last_connection = u8::MAX;
            while state.running.load(Ordering::Relaxed) {
                if !state.network_enabled.load(Ordering::Relaxed) || !state.tor.is_ready() {
                    let previous = state.connection.swap(0, Ordering::Relaxed);
                    if previous != 0 {
                        if let Some(updates) = &state.updates {
                            updates.changed();
                        }
                    }
                    last_connection = 0;
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
                // Resolving bootstrap hostnames can block for several seconds on
                // restricted networks. It must happen before the Tox handle is
                // locked; otherwise a synchronous UI query waiting for that lock
                // also blocks Tauri's window thread.
                let observed_generation = state.handle_generation.load(Ordering::SeqCst);
                let bootstrap_due = callback_generation != observed_generation
                    || last_bootstrap.elapsed() >= Duration::from_secs(20);
                let bootstrap_plan = bootstrap_due.then(|| {
                    let allow_local_dns = !state.tor.enabled()
                        && state
                            .proxy_settings
                            .lock()
                            .map(|settings| settings.mode == "none")
                            .unwrap_or(false);
                    (
                        observed_generation,
                        resolved_bootstrap_nodes(allow_local_dns),
                    )
                });
                let interval = {
                    let state_guard = match state.handle.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    let Some(handle) = state_guard.as_ref() else {
                        return;
                    };

                    let current_generation = state.handle_generation.load(Ordering::SeqCst);
                    if callback_generation != current_generation {
                        unsafe {
                            tox_callback_friend_request(
                                handle.instance.as_ptr(),
                                Some(on_friend_request),
                            );
                            tox_callback_friend_message(
                                handle.instance.as_ptr(),
                                Some(on_friend_message),
                            );
                            tox_callback_friend_read_receipt(
                                handle.instance.as_ptr(),
                                Some(on_friend_read_receipt),
                            );
                            tox_callback_friend_lossless_packet(
                                handle.instance.as_ptr(),
                                Some(on_friend_lossless_packet),
                            );
                            tox_callback_file_chunk_request(
                                handle.instance.as_ptr(),
                                Some(on_file_chunk_request),
                            );
                            tox_callback_file_recv(handle.instance.as_ptr(), Some(on_file_recv));
                            tox_callback_file_recv_chunk(
                                handle.instance.as_ptr(),
                                Some(on_file_recv_chunk),
                            );
                            tox_callback_friend_connection_status(
                                handle.instance.as_ptr(),
                                Some(on_friend_connection_status),
                            );
                            tox_callback_friend_name(
                                handle.instance.as_ptr(),
                                Some(on_friend_name),
                            );
                            tox_callback_friend_status(
                                handle.instance.as_ptr(),
                                Some(on_friend_status),
                            );
                            tox_callback_friend_status_message(
                                handle.instance.as_ptr(),
                                Some(on_friend_status_message),
                            );
                        }
                        callback_generation = current_generation;
                        last_bootstrap = Instant::now() - Duration::from_secs(60);
                        last_connection = u8::MAX;
                    }

                    if last_bootstrap.elapsed() >= Duration::from_secs(20) {
                        if let Some((planned_generation, nodes)) = bootstrap_plan.as_ref() {
                            // A route rebuild may finish while DNS is being
                            // resolved. Discard that stale plan and resolve for
                            // the new generation during the next iteration.
                            if *planned_generation == current_generation {
                                bootstrap_tox(handle.instance.as_ptr(), nodes);
                                last_bootstrap = Instant::now();
                            }
                        }
                    }

                    unsafe {
                        tox_iterate(handle.instance.as_ptr(), callback_store);
                        #[cfg(test)]
                        state.iterations.fetch_add(1, Ordering::Relaxed);
                        flush_pending_pq_messages(&state, handle.instance.as_ptr());
                        drive_pq_shutdowns(&state);
                        flush_pending_messages(&state, handle.instance.as_ptr());
                        flush_pq_outbox(&state, handle.instance.as_ptr());
                        check_file_transfer_timeouts(&state, handle.instance.as_ptr());
                        flush_pending_files(&state, handle.instance.as_ptr());
                        let connection = tox_self_get_connection_status(handle.instance.as_ptr());
                        if connection != last_connection {
                            log_network(
                                &state.network_log_path,
                                format!("SELF_CONNECTION status={connection}"),
                            );
                            last_connection = connection;
                            state.connection.store(connection, Ordering::Relaxed);
                            if let Some(updates) = &state.updates {
                                updates.changed();
                            }
                        } else {
                            state.connection.store(connection, Ordering::Relaxed);
                        }
                        tox_iteration_interval(handle.instance.as_ptr())
                    }
                };

                thread::sleep(Duration::from_millis(u64::from(interval.clamp(5, 1000))));
            }
            unsafe {
                drop(Arc::from_raw(callback_store.cast::<CallbackContext>()));
            }
        });
    }

    fn stop(&self) -> bool {
        let was_running = self.running.swap(false, Ordering::Relaxed);
        self.network_enabled.store(false, Ordering::Relaxed);
        if let Ok(mut bridge) = self.proxy_bridge.lock() {
            if let Some(bridge) = bridge.take() {
                bridge.stop();
            }
        }
        was_running
    }

    fn stop_without_save(&self) -> Result<(), String> {
        self.history_enabled.store(false, Ordering::Relaxed);
        cancel_batched_write(&self.history_path);
        cancel_batched_write(&self.unread_state_path);
        cancel_batched_write(&self.friend_cache_path);
        cancel_batched_write(&self.pending_messages_path);
        cancel_batched_write(&self.pending_pq_messages_path);
        self.stop();

        // The network worker owns a clone of this state.  Removing the profile
        // directory before that clone is gone lets ToxState::drop recreate the
        // .tox file with its normal final save.  Wait for the worker to release
        // its clone, then take and kill the native handle ourselves so Drop has
        // nothing left to persist.
        let deadline = Instant::now() + Duration::from_secs(3);
        while Arc::strong_count(&self.handle) > 1 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if Arc::strong_count(&self.handle) > 1 {
            return Err("Could not stop the profile background worker".to_string());
        }

        let mut state = self
            .handle
            .lock()
            .map_err(|_| "Could not close the profile before deletion".to_string())?;
        if let Some(instance) = state.take() {
            unsafe { tox_kill(instance.instance.as_ptr()) };
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default = "default_language")]
    language: String,
    #[serde(default = "default_true")]
    close_to_tray: bool,
}

fn default_language() -> String {
    "ru".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: default_language(),
            close_to_tray: true,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSummary {
    id: String,
    name: String,
    file_name: String,
    encrypted: bool,
    loaded: bool,
    active: bool,
    connection: String,
    user_status: String,
    unread: u32,
    avatar: Option<String>,
    notifications_enabled: bool,
    unread_target: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupState {
    first_run: bool,
    language: String,
    close_to_tray: bool,
    profiles: Vec<ProfileSummary>,
}

fn local_notifications_enabled(local_state: Option<&Value>) -> bool {
    local_state.is_some_and(|value| {
        value
            .get("notifyMessages")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || value
                .get("notifyRequests")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    })
}

#[derive(Clone)]
struct AppState {
    app: tauri::AppHandle,
    root_dir: PathBuf,
    data_dir: PathBuf,
    tor: TorManager,
    proxy_settings: Arc<Mutex<ProxySettings>>,
    proxy_settings_path: PathBuf,
    network_settings: Arc<Mutex<NetworkSettings>>,
    network_settings_path: PathBuf,
    registry: Arc<Mutex<ProfileRegistry>>,
    profiles: Arc<Mutex<HashMap<String, Arc<ToxState>>>>,
    load_errors: Arc<Mutex<HashMap<String, String>>>,
    settings: Arc<Mutex<AppSettings>>,
    settings_path: PathBuf,
    exit_requested: Arc<AtomicBool>,
}

impl AppState {
    fn new(app: tauri::AppHandle) -> Result<Self, String> {
        let portable = PortablePaths::discover()?;
        let registry = ProfileRegistry::load_or_discover(&portable.root_dir, &portable.data_dir)?;
        let settings_path = portable.data_dir.join("app-settings.json");
        let settings = fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<AppSettings>(&bytes).ok())
            .unwrap_or_default();
        let tor = TorManager::new(
            portable.root_dir.clone(),
            portable.data_dir.clone(),
            portable.logs_dir.clone(),
        )?;
        // Network routing is application-wide. Keep exactly one persisted proxy
        // configuration and share it with every loaded toxcore instance.
        let proxy_settings_path = portable.data_dir.join("proxy-settings.json");
        let proxy_settings = fs::read(&proxy_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<ProxySettings>(&contents).ok())
            .unwrap_or_default();
        atomic_write(
            &proxy_settings_path,
            &serde_json::to_vec_pretty(&proxy_settings)
                .map_err(|error| format!("Could not encode the shared proxy settings: {error}"))?,
        )?;
        let network_settings_path = portable.data_dir.join("network-settings.json");
        let network_settings = fs::read(&network_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<NetworkSettings>(&contents).ok())
            .unwrap_or_default()
            .normalized();
        atomic_write(
            &network_settings_path,
            &serde_json::to_vec_pretty(&network_settings).map_err(|error| {
                format!("Could not encode the shared Tox network settings: {error}")
            })?,
        )?;
        let state = Self {
            app,
            root_dir: portable.root_dir,
            data_dir: portable.data_dir,
            tor,
            proxy_settings: Arc::new(Mutex::new(proxy_settings)),
            proxy_settings_path,
            network_settings: Arc::new(Mutex::new(network_settings)),
            network_settings_path,
            registry: Arc::new(Mutex::new(registry)),
            profiles: Arc::new(Mutex::new(HashMap::new())),
            load_errors: Arc::new(Mutex::new(HashMap::new())),
            settings: Arc::new(Mutex::new(settings)),
            settings_path,
            exit_requested: Arc::new(AtomicBool::new(false)),
        };

        let records = state
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?
            .profiles
            .clone();
        for record in records
            .into_iter()
            .filter(|record| record.enabled && !record.encrypted)
        {
            if let Err(error) = state.load_record(&record, None) {
                if let Ok(mut errors) = state.load_errors.lock() {
                    errors.insert(record.id, error);
                }
            }
        }
        Ok(state)
    }

    fn updates_for(&self, profile_id: &str) -> Option<ProfileUpdateEmitter> {
        let app = self.app.clone();
        let profile_id = profile_id.to_string();
        Some(ProfileUpdateEmitter(Arc::new(move || {
            let _ = app.emit("profiles-changed", &profile_id);
        })))
    }

    fn allow_profile_media(&self, state: &ToxState) -> Result<(), String> {
        let scope = self.app.asset_protocol_scope();
        for directory in [
            &state.downloads_dir,
            &state.outgoing_files_dir,
            &state.avatars_dir,
        ] {
            scope
                .allow_directory(directory, true)
                .map_err(|error| format!("Could not allow portable media directory: {error}"))?;
        }
        Ok(())
    }

    fn active(&self) -> Result<Arc<ToxState>, String> {
        let active = self
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?
            .active_profile_id
            .clone()
            .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
        self.profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .get(&active)
            .cloned()
            .ok_or_else(|| "ACTIVE_PROFILE_LOCKED".to_string())
    }

    fn record(&self, id: &str) -> Result<ProfileRecord, String> {
        self.registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
            .ok_or_else(|| "PROFILE_NOT_FOUND".to_string())
    }

    fn paths_for(&self, record: &ProfileRecord) -> Result<ProfilePaths, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?;
        ProfilePaths::new(
            self.root_dir.clone(),
            registry.data_path(&self.root_dir, record)?,
            registry.profile_path(&self.root_dir, record)?,
        )
    }

    fn load_record(&self, record: &ProfileRecord, password: Option<&str>) -> Result<(), String> {
        if self
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .contains_key(&record.id)
        {
            return Ok(());
        }
        let paths = self.paths_for(record)?;
        let (savedata, cipher) = profiles::read_profile(&paths.profile_path, password)?;
        let tox = Arc::new(ToxState::new_for_profile(
            paths,
            self.tor.clone(),
            Arc::clone(&self.proxy_settings),
            Arc::clone(&self.network_settings),
            self.updates_for(&record.id),
            Some(savedata),
            cipher,
            None,
        )?);
        self.allow_profile_media(&tox)?;
        tox.start_network_loop();
        self.profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .insert(record.id.clone(), tox);
        if let Ok(mut errors) = self.load_errors.lock() {
            errors.remove(&record.id);
        }
        Ok(())
    }

    fn summaries(&self) -> Result<Vec<ProfileSummary>, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?
            .clone();
        let loaded = self
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?;
        let errors = self
            .load_errors
            .lock()
            .map_err(|_| "Could not access profile errors".to_string())?;
        Ok(registry
            .profiles
            .iter()
            .filter(|record| {
                record.enabled
                    && registry
                        .profile_path(&self.root_dir, record)
                        .is_ok_and(|path| path.is_file())
            })
            .map(|record| {
                let state = loaded.get(&record.id);
                let local_state = registry
                    .data_path(&self.root_dir, record)
                    .ok()
                    .and_then(|directory| fs::read(directory.join("local-state.json")).ok())
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                let connection = state
                    .map(|state| match state.connection.load(Ordering::Relaxed) {
                        0 => "offline",
                        1 => "tcp",
                        2 => "udp",
                        _ => "offline",
                    })
                    .unwrap_or(if record.encrypted {
                        "locked"
                    } else {
                        "offline"
                    })
                    .to_string();
                ProfileSummary {
                    id: record.id.clone(),
                    name: record.name.clone(),
                    file_name: Path::new(&record.file)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(&record.file)
                        .to_string(),
                    encrypted: record.encrypted,
                    loaded: state.is_some(),
                    active: registry.active_profile_id.as_deref() == Some(&record.id),
                    connection,
                    user_status: state
                        .map(|state| profile_user_status(state))
                        .unwrap_or_else(|| "offline".to_string()),
                    unread: state
                        .and_then(|state| {
                            state.unread_state.lock().ok().map(|unread| unread.total())
                        })
                        .unwrap_or(0),
                    avatar: local_state.as_ref().and_then(|value| {
                        value
                            .get("profileAvatar")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    }),
                    notifications_enabled: local_notifications_enabled(local_state.as_ref()),
                    unread_target: state.and_then(|state| {
                        state.unread_state.lock().ok().and_then(|unread| {
                            if !unread.requests.is_empty() {
                                Some("requests".to_string())
                            } else {
                                unread
                                    .friends
                                    .iter()
                                    .max_by_key(|(_, count)| *count)
                                    .map(|(friend, _)| format!("friend:{friend}"))
                            }
                        })
                    }),
                    error: errors.get(&record.id).cloned(),
                }
            })
            .collect())
    }

    fn save_settings(&self) -> Result<(), String> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| "Could not access application settings".to_string())?;
        atomic_write(
            &self.settings_path,
            &serde_json::to_vec_pretty(&*settings)
                .map_err(|error| format!("Could not encode application settings: {error}"))?,
        )
    }
}

#[derive(Clone)]
struct TrayMenuItems {
    full_menu: tauri::menu::Menu<tauri::Wry>,
    empty_menu: tauri::menu::Menu<tauri::Wry>,
    full_menu_active: Arc<AtomicBool>,
    profile: tauri::menu::MenuItem<tauri::Wry>,
    empty_profile: tauri::menu::MenuItem<tauri::Wry>,
    online: tauri::menu::MenuItem<tauri::Wry>,
    away: tauri::menu::MenuItem<tauri::Wry>,
    busy: tauri::menu::MenuItem<tauri::Wry>,
    offline: tauri::menu::MenuItem<tauri::Wry>,
    exit: tauri::menu::MenuItem<tauri::Wry>,
    empty_exit: tauri::menu::MenuItem<tauri::Wry>,
}

impl TrayMenuItems {
    fn apply_language(&self, language: &str) {
        let english = language == "en";
        let _ = self
            .online
            .set_text(if english { "Online" } else { "Онлайн" });
        let _ = self.away.set_text(if english { "Away" } else { "Отошёл" });
        let _ = self.busy.set_text(if english { "Busy" } else { "Занят" });
        let _ = self.offline.set_text(if english {
            "Offline"
        } else {
            "Не в сети"
        });
        let _ = self.exit.set_text(if english { "Exit" } else { "Выход" });
        let _ = self.empty_profile.set_text(if english {
            "Profile: N/A"
        } else {
            "Профиль: N/A"
        });
        let _ = self
            .empty_exit
            .set_text(if english { "Exit" } else { "Выход" });
    }
}

fn active_profile_name(app_state: &AppState) -> Option<String> {
    app_state.active().ok()?;
    let registry = app_state.registry.lock().ok()?;
    let active_id = registry.active_profile_id.as_ref()?;
    registry
        .profiles
        .iter()
        .find(|profile| profile.id == *active_id)
        .map(|profile| profile.name.clone())
}

fn profile_user_status(tox_state: &ToxState) -> String {
    if !tox_state.network_enabled.load(Ordering::Relaxed) {
        return "offline".to_string();
    }
    let Ok(handle) = tox_state.handle.lock() else {
        return "online".to_string();
    };
    let Some(handle) = handle.as_ref() else {
        return "online".to_string();
    };
    match unsafe { tox_self_get_status(handle.instance.as_ptr()) } {
        1 => "away",
        2 => "busy",
        _ => "online",
    }
    .to_string()
}

fn set_user_status_inner(tox_state: &ToxState, status: &str) -> Result<String, String> {
    let (enabled, tox_status) = match status {
        "online" => (true, 0_u8),
        "away" => (true, 1_u8),
        "busy" => (true, 2_u8),
        "offline" => {
            tox_state.save_network_enabled(false)?;
            tox_state.network_enabled.store(false, Ordering::Relaxed);
            tox_state.connection.store(0, Ordering::Relaxed);
            if let Some(updates) = &tox_state.updates {
                updates.changed();
            }
            return Ok("offline".to_string());
        }
        _ => return Err("Unknown status".to_string()),
    };
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Could not access the Tox profile".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "The Tox profile is not initialised".to_string())?;
    unsafe { tox_self_set_status(instance.instance.as_ptr(), tox_status) };
    log_network(
        &tox_state.network_log_path,
        format!("SELF_STATUS status={status} raw={tox_status}"),
    );
    ToxState::save(instance)?;
    tox_state.save_network_enabled(enabled)?;
    tox_state.network_enabled.store(enabled, Ordering::Relaxed);
    if let Some(updates) = &tox_state.updates {
        updates.changed();
    }
    Ok(status.to_string())
}

fn tray_status(app_state: &AppState) -> String {
    let Ok(active) = app_state.active() else {
        return "offline".to_string();
    };
    if !active.network_enabled.load(Ordering::Relaxed) {
        return "offline".to_string();
    }
    if active.connection.load(Ordering::Relaxed) == 0 {
        return "connecting".to_string();
    }
    let Ok(handle) = active.handle.lock() else {
        return "offline".to_string();
    };
    let Some(handle) = handle.as_ref() else {
        return "offline".to_string();
    };
    match unsafe { tox_self_get_status(handle.instance.as_ptr()) } {
        1 => "away",
        2 => "busy",
        _ => "online",
    }
    .to_string()
}

fn paint_pixel(rgba: &mut [u8], width: u32, height: u32, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let index = ((y as u32 * width + x as u32) * 4) as usize;
    rgba[index..index + 4].copy_from_slice(&color);
}

fn paint_circle(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: i32,
    center_y: i32,
    radius: i32,
    color: [u8; 4],
) {
    for y in -radius..=radius {
        for x in -radius..=radius {
            if x * x + y * y <= radius * radius {
                paint_pixel(rgba, width, height, center_x + x, center_y + y, color);
            }
        }
    }
}

const TRAY_UNREAD_SCALE_PERCENT: u32 = 85;

fn composite_scaled_overlay(
    destination: &mut [u8],
    overlay: &[u8],
    width: u32,
    height: u32,
    percent: u32,
) {
    let scaled_width = (width.saturating_mul(percent).saturating_add(50) / 100).max(1);
    let scaled_height = (height.saturating_mul(percent).saturating_add(50) / 100).max(1);
    let left = (width - scaled_width) / 2;
    let top = (height - scaled_height) / 2;
    for y in 0..scaled_height {
        let source_y = (y * height / scaled_height).min(height - 1);
        for x in 0..scaled_width {
            let source_x = (x * width / scaled_width).min(width - 1);
            let source_index = ((source_y * width + source_x) * 4) as usize;
            if overlay[source_index + 3] == 0 {
                continue;
            }
            let destination_index = (((top + y) * width + left + x) * 4) as usize;
            destination[destination_index..destination_index + 4]
                .copy_from_slice(&overlay[source_index..source_index + 4]);
        }
    }
}

const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

fn tray_image(
    base: &tauri::image::Image<'_>,
    status: &str,
    unread: u32,
) -> tauri::image::Image<'static> {
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();
    let unit = ((width.min(height) / 32).max(1)) as i32;
    let status_color = match status {
        "online" => [72, 222, 131, 255],
        "away" => [239, 190, 76, 255],
        "busy" => [226, 91, 99, 255],
        "connecting" => [81, 157, 216, 255],
        _ => [135, 145, 154, 255],
    };
    paint_circle(
        &mut rgba,
        width,
        height,
        unit * 6,
        height as i32 - unit * 6,
        unit * 4,
        [8, 16, 24, 255],
    );
    paint_circle(
        &mut rgba,
        width,
        height,
        unit * 6,
        height as i32 - unit * 6,
        unit * 3,
        status_color,
    );
    if unread > 0 {
        let mut glyph_overlay = vec![0_u8; rgba.len()];
        let text = unread.min(99).to_string();
        let digits = text
            .bytes()
            .filter_map(|byte| byte.checked_sub(b'0'))
            .filter(|digit| *digit < 10)
            .collect::<Vec<_>>();
        let glyph_units = digits.len() as i32 * 3 + digits.len().saturating_sub(1) as i32;
        let margin = unit.max(1);
        let scale = ((width as i32 - margin * 2) / glyph_units)
            .min((height as i32 - margin * 2) / 5)
            .max(1);
        let glyph_width = 3 * scale;
        let gap = scale;
        let total = digits.len() as i32 * glyph_width + digits.len().saturating_sub(1) as i32 * gap;
        let start_x = (width as i32 - total) / 2;
        let start_y = (height as i32 - 5 * scale) / 2;
        let outline = (scale / 3).max(1);
        // Paint the outline first, then the white glyph. The application icon
        // remains visible as the background while the unread number occupies
        // almost the entire tray surface and stays legible at 16-32 px.
        for pass in 0..2 {
            let edge = if pass == 0 { outline } else { 0 };
            let color = if pass == 0 {
                [5, 12, 18, 255]
            } else {
                [255, 255, 255, 255]
            };
            let mut x0 = start_x;
            for digit in &digits {
                for (row, bits) in DIGITS[*digit as usize].iter().enumerate() {
                    for column in 0..3 {
                        if bits & (1 << (2 - column)) != 0 {
                            for dy in -edge..scale + edge {
                                for dx in -edge..scale + edge {
                                    paint_pixel(
                                        &mut glyph_overlay,
                                        width,
                                        height,
                                        x0 + column * scale + dx,
                                        start_y + row as i32 * scale + dy,
                                        color,
                                    );
                                }
                            }
                        }
                    }
                }
                x0 += glyph_width + gap;
            }
        }
        composite_scaled_overlay(
            &mut rgba,
            &glyph_overlay,
            width,
            height,
            TRAY_UNREAD_SCALE_PERCENT,
        );
    }
    tauri::image::Image::new_owned(rgba, width, height)
}

fn update_tray(app: &tauri::AppHandle, app_state: &AppState) {
    let unread: u32 = app_state
        .profiles
        .lock()
        .map(|profiles| {
            profiles
                .values()
                .filter_map(|profile| profile.unread_state.lock().ok().map(|state| state.total()))
                .sum()
        })
        .unwrap_or(0);
    let status = tray_status(app_state);
    if let (Some(tray), Some(base)) = (app.tray_by_id("kaigen-tray"), app.default_window_icon()) {
        let _ = tray.set_icon(Some(tray_image(base, &status, unread)));
        let profile = active_profile_name(app_state);
        let has_profile = profile.is_some();
        let english = app_state
            .settings
            .lock()
            .map(|settings| settings.language == "en")
            .unwrap_or(false);
        let status_label = match (english, status.as_str()) {
            (true, "online") => "online",
            (true, "away") => "away",
            (true, "busy") => "busy",
            (true, "connecting") => "connecting",
            (true, _) => "offline",
            (false, "online") => "в сети",
            (false, "away") => "отошёл",
            (false, "busy") => "занят",
            (false, "connecting") => "подключение",
            (false, _) => "не в сети",
        };
        let suffix = if unread > 0 {
            if english {
                format!(" · {unread} unread")
            } else {
                format!(" · непрочитано: {unread}")
            }
        } else {
            String::new()
        };
        if let Some(items) = app.try_state::<TrayMenuItems>() {
            if let Some(profile) = profile.as_deref() {
                let title = if english {
                    format!("Profile: {profile}")
                } else {
                    format!("Профиль: {profile}")
                };
                let _ = items.profile.set_text(title);
            }
            if items.full_menu_active.swap(has_profile, Ordering::Relaxed) != has_profile {
                let menu = if has_profile {
                    items.full_menu.clone()
                } else {
                    items.empty_menu.clone()
                };
                let _ = tray.set_menu(Some(menu));
            }
        }
        let tooltip = if let Some(profile) = profile {
            format!("Kaigen — {profile} · {status_label}{suffix}")
        } else if english {
            "Kaigen — Profile: N/A".to_string()
        } else {
            "Kaigen — Профиль: N/A".to_string()
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn create_tray(
    app: &tauri::App,
    language: &str,
) -> Result<TrayMenuItems, Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let initial_profile = active_profile_name(&app.state::<AppState>());
    let has_profile = initial_profile.is_some();
    let profile_title = match (language == "en", initial_profile.as_deref()) {
        (true, Some(name)) => format!("Profile: {name}"),
        (false, Some(name)) => format!("Профиль: {name}"),
        (true, None) => "Profile: N/A".to_string(),
        (false, None) => "Профиль: N/A".to_string(),
    };
    let profile = MenuItem::with_id(app, "tray-profile", profile_title, false, None::<&str>)?;
    let profile_separator = PredefinedMenuItem::separator(app)?;
    let online = MenuItem::with_id(app, "tray-online", "Онлайн", true, None::<&str>)?;
    let away = MenuItem::with_id(app, "tray-away", "Отошёл", true, None::<&str>)?;
    let busy = MenuItem::with_id(app, "tray-busy", "Занят", true, None::<&str>)?;
    let offline = MenuItem::with_id(app, "tray-offline", "Не в сети", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit_item = MenuItem::with_id(app, "tray-exit", "Выход", true, None::<&str>)?;
    let full_menu = Menu::with_items(
        app,
        &[
            &profile,
            &profile_separator,
            &online,
            &away,
            &busy,
            &offline,
            &separator,
            &exit_item,
        ],
    )?;
    let empty_profile = MenuItem::with_id(
        app,
        "tray-empty-profile",
        "Профиль: N/A",
        false,
        None::<&str>,
    )?;
    let empty_separator = PredefinedMenuItem::separator(app)?;
    let empty_exit = MenuItem::with_id(app, "tray-empty-exit", "Выход", true, None::<&str>)?;
    let empty_menu = Menu::with_items(app, &[&empty_profile, &empty_separator, &empty_exit])?;
    let icon = app.default_window_icon().cloned();
    let initial_menu = if has_profile { &full_menu } else { &empty_menu };
    let mut builder = TrayIconBuilder::with_id("kaigen-tray")
        .menu(initial_menu)
        .show_menu_on_left_click(false)
        .tooltip("Kaigen")
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "tray-exit" || id == "tray-empty-exit" {
                let state = app.state::<AppState>();
                state.exit_requested.store(true, Ordering::Relaxed);
                state.tor.stop();
                if let Ok(profiles) = state.profiles.lock() {
                    for profile in profiles.values() {
                        profile.stop();
                    }
                }
                app.exit(0);
                return;
            }
            let status = match id {
                "tray-online" => Some("online"),
                "tray-away" => Some("away"),
                "tray-busy" => Some("busy"),
                "tray-offline" => Some("offline"),
                _ => None,
            };
            if let Some(status) = status {
                let state = app.state::<AppState>();
                if let Ok(profile) = state.active() {
                    let _ = set_user_status_inner(&profile, status);
                    update_tray(app, &state);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Down,
                    ..
                }
            ) {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        });
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    let _tray = builder.build(app)?;
    let items = TrayMenuItems {
        full_menu,
        empty_menu,
        full_menu_active: Arc::new(AtomicBool::new(has_profile)),
        profile,
        empty_profile,
        online,
        away,
        busy,
        offline,
        exit: exit_item,
        empty_exit,
    };
    items.apply_language(language);
    Ok(items)
}

unsafe extern "C" fn on_friend_request(
    _tox: *mut c_void,
    public_key: *const u8,
    message: *const u8,
    length: usize,
    user_data: *mut c_void,
) {
    if public_key.is_null() || user_data.is_null() {
        return;
    }
    let key = unsafe { std::slice::from_raw_parts(public_key, 32) };
    let public_key = key
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    let message = if message.is_null() {
        String::new()
    } else {
        sanitize_untrusted_text(&String::from_utf8_lossy(unsafe {
            std::slice::from_raw_parts(message, length)
        }))
    };
    let context = unsafe { &*(user_data as *const CallbackContext) };
    log_network(
        &context.network_log_path,
        format!(
            "FRIEND_REQUEST key={} message_len={} fingerprint={}",
            public_key,
            message.len(),
            event_fingerprint(message.as_bytes())
        ),
    );
    let requests = &context.incoming_requests;
    let mut changed = false;
    if let Ok(mut requests) = requests.lock() {
        if !requests
            .iter()
            .any(|request| request.public_key == public_key)
        {
            requests.push(IncomingFriendRequest {
                public_key: public_key.clone(),
                message,
            });
            changed = true;
        }
    }
    if changed {
        persist_incoming_friend_requests(requests, &context.incoming_requests_path);
        if let Ok(mut state) = context.unread_state.lock() {
            state.requests.insert(public_key);
        }
        persist_unread_state(&context.unread_state, &context.unread_state_path);
        if let Some(updates) = &context.updates {
            updates.changed();
        }
    }
}

unsafe extern "C" fn on_friend_message(
    tox: *mut c_void,
    friend_number: u32,
    _message_type: i32,
    message: *const u8,
    length: usize,
    user_data: *mut c_void,
) {
    if message.is_null() || user_data.is_null() {
        return;
    }
    let text = sanitize_untrusted_text(&String::from_utf8_lossy(unsafe {
        std::slice::from_raw_parts(message, length)
    }));
    let context = unsafe { &*(user_data as *const CallbackContext) };
    mark_friend_authorized(context, tox, friend_number);
    log_network(
        &context.network_log_path,
        format!(
            "FRIEND_MESSAGE friend={friend_number} bytes={length} fingerprint={}",
            event_fingerprint(text.as_bytes())
        ),
    );
    if let Ok(mut messages) = context.messages.lock() {
        messages.push(ToxMessage {
            id: new_message_id(friend_number),
            friend_number,
            text,
            mine: false,
            timestamp: unix_timestamp(),
            delivery: default_message_delivery(),
            delivered_at: None,
            attachment: None,
            event: None,
        });
    }
    persist_tox_history(
        &context.messages,
        &context.history_path,
        &context.history_enabled,
    );
    increment_unread_friend(context, friend_number);
}

unsafe extern "C" fn on_friend_lossless_packet(
    tox: *mut c_void,
    friend_number: u32,
    data: *const u8,
    length: usize,
    user_data: *mut c_void,
) {
    if data.is_null() || user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };
    let bytes = unsafe { std::slice::from_raw_parts(data, length) };
    let result = match context.pq.handle_packet(friend_number, bytes) {
        Ok(result) => result,
        Err(error) => {
            log_network(
                &context.network_log_path,
                format!("PQ_PACKET_REJECTED friend={friend_number} bytes={length} error={error}"),
            );
            return;
        }
    };
    mark_friend_authorized(context, tox, friend_number);
    if !result.outgoing.is_empty() {
        context.pq.queue(friend_number, result.outgoing);
    }
    if let Some(session_event) = result.session_event {
        let status = context.pq.status(friend_number);
        match session_event {
            PqSessionEvent::OfferReceived => {
                append_pq_history(
                    &context.messages,
                    friend_number,
                    &status,
                    "responder",
                    "incoming_offer",
                    false,
                );
                persist_tox_history(
                    &context.messages,
                    &context.history_path,
                    &context.history_enabled,
                );
                increment_unread_friend(context, friend_number);
            }
            PqSessionEvent::OfferCollisionYielded => {
                update_latest_pq_history(&context.messages, friend_number, &status, "superseded");
                append_pq_history(
                    &context.messages,
                    friend_number,
                    &status,
                    "responder",
                    "incoming_offer",
                    false,
                );
                persist_tox_history(
                    &context.messages,
                    &context.history_path,
                    &context.history_enabled,
                );
                increment_unread_friend(context, friend_number);
            }
            PqSessionEvent::Active => {
                if update_latest_pq_history(&context.messages, friend_number, &status, "active") {
                    persist_tox_history(
                        &context.messages,
                        &context.history_path,
                        &context.history_enabled,
                    );
                }
            }
            PqSessionEvent::Rejected => {
                if update_latest_pq_history(&context.messages, friend_number, &status, "rejected") {
                    persist_tox_history(
                        &context.messages,
                        &context.history_path,
                        &context.history_enabled,
                    );
                }
                increment_unread_friend(context, friend_number);
            }
            PqSessionEvent::Withdrawn => {
                if update_latest_pq_history(&context.messages, friend_number, &status, "withdrawn")
                {
                    persist_tox_history(
                        &context.messages,
                        &context.history_path,
                        &context.history_enabled,
                    );
                }
                increment_unread_friend(context, friend_number);
            }
            PqSessionEvent::CloseRequested => {
                append_pq_history(
                    &context.messages,
                    friend_number,
                    &status,
                    "responder",
                    "close_pending",
                    false,
                );
                persist_tox_history(
                    &context.messages,
                    &context.history_path,
                    &context.history_enabled,
                );
                increment_unread_friend(context, friend_number);
            }
            PqSessionEvent::Closed => {
                let updated =
                    update_latest_pq_history(&context.messages, friend_number, &status, "closed");
                if !updated {
                    append_pq_history(
                        &context.messages,
                        friend_number,
                        &status,
                        "responder",
                        "closed",
                        false,
                    );
                }
                persist_tox_history(
                    &context.messages,
                    &context.history_path,
                    &context.history_enabled,
                );
            }
        }
    }
    if let Some(text) = result.received_text {
        if let Ok(mut messages) = context.messages.lock() {
            messages.push(ToxMessage {
                id: new_message_id(friend_number),
                friend_number,
                text,
                mine: false,
                timestamp: unix_timestamp(),
                delivery: default_message_delivery(),
                delivered_at: None,
                attachment: None,
                event: None,
            });
        }
        persist_tox_history(
            &context.messages,
            &context.history_path,
            &context.history_enabled,
        );
        increment_unread_friend(context, friend_number);
    }
    if let Some(wire_id) = result.acknowledged_wire_id {
        let local_id = context
            .pq_receipts
            .lock()
            .ok()
            .and_then(|mut receipts| receipts.remove(&(friend_number, wire_id)));
        if let Some(local_id) = local_id {
            if let Ok(mut messages) = context.messages.lock() {
                if let Some(message) = messages.iter_mut().find(|message| message.id == local_id) {
                    message.delivery = "delivered".to_string();
                    message.delivered_at = Some(unix_timestamp());
                }
            }
            persist_tox_history(
                &context.messages,
                &context.history_path,
                &context.history_enabled,
            );
        }
    }
    log_network(
        &context.network_log_path,
        format!("PQ_PACKET friend={friend_number} bytes={length}"),
    );
}

unsafe extern "C" fn on_friend_read_receipt(
    _tox: *mut c_void,
    friend_number: u32,
    message_id: u32,
    user_data: *mut c_void,
) {
    if user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };
    let local_id = context
        .delivery_receipts
        .lock()
        .ok()
        .and_then(|mut receipts| receipts.remove(&(friend_number, message_id)));
    let Some(local_id) = local_id else {
        log_network(
            &context.network_log_path,
            format!("READ_RECEIPT_UNMATCHED friend={friend_number} tox_message_id={message_id}"),
        );
        return;
    };
    let delivered_at = unix_timestamp();
    let fully_delivered = context
        .receipt_progress
        .lock()
        .ok()
        .map(|mut progress_by_id| {
            let Some(progress) = progress_by_id.get_mut(&local_id) else {
                // Backwards compatibility for a receipt created before the
                // multi-fragment accounting was introduced.
                return true;
            };
            progress.remaining = progress.remaining.saturating_sub(1);
            let complete = progress.all_sent && progress.remaining == 0;
            if complete {
                progress_by_id.remove(&local_id);
            }
            complete
        })
        .unwrap_or(false);
    if fully_delivered {
        if let Ok(mut messages) = context.messages.lock() {
            if let Some(message) = messages.iter_mut().find(|message| message.id == local_id) {
                message.delivery = "delivered".to_string();
                message.delivered_at = Some(delivered_at);
            }
        }
    }
    log_network(&context.network_log_path, format!("READ_RECEIPT friend={friend_number} tox_message_id={message_id} local_id={local_id} delivered_at={delivered_at}"));
    if fully_delivered {
        persist_tox_history(
            &context.messages,
            &context.history_path,
            &context.history_enabled,
        );
    }
}

unsafe extern "C" fn on_friend_name(
    _tox: *mut c_void,
    friend_number: u32,
    name: *const u8,
    length: usize,
    user_data: *mut c_void,
) {
    if name.is_null() || user_data.is_null() {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(name, length) };
    let context = unsafe { &*(user_data as *const CallbackContext) };
    log_network(
        &context.network_log_path,
        format!(
            "FRIEND_NAME friend={friend_number} bytes={length} fingerprint={}",
            event_fingerprint(bytes)
        ),
    );
}

unsafe extern "C" fn on_friend_status(
    _tox: *mut c_void,
    friend_number: u32,
    status: u8,
    user_data: *mut c_void,
) {
    if user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };
    log_network(
        &context.network_log_path,
        format!("FRIEND_STATUS friend={friend_number} status={status}"),
    );
}

unsafe extern "C" fn on_friend_status_message(
    _tox: *mut c_void,
    friend_number: u32,
    message: *const u8,
    length: usize,
    user_data: *mut c_void,
) {
    if message.is_null() || user_data.is_null() {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(message, length) };
    let context = unsafe { &*(user_data as *const CallbackContext) };
    log_network(
        &context.network_log_path,
        format!(
            "FRIEND_STATUS_MESSAGE friend={friend_number} bytes={length} fingerprint={}",
            event_fingerprint(bytes)
        ),
    );
}

fn safe_file_name(value: &str) -> String {
    let input_path = PathBuf::from(value);
    let name = input_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let cleaned: String = name
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect();
    if cleaned.trim().is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

fn sanitize_untrusted_text(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| match character {
            '\r' => None,
            '\n' | '\t' => Some(character),
            character if character.is_control() => None,
            character => Some(character),
        })
        .collect()
}

fn is_image_name(name: &str) -> bool {
    matches!(
        name.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp"
    )
}

fn is_auto_accepted_image_name(name: &str) -> bool {
    matches!(
        name.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg"
    )
}

fn current_self_avatar_path(avatars_dir: &PathBuf) -> Option<PathBuf> {
    fs::read_dir(avatars_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("self-"))
        .filter_map(|entry| {
            entry.metadata().ok().and_then(|metadata| {
                metadata
                    .modified()
                    .ok()
                    .map(|modified| (modified, entry.path()))
            })
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn current_self_avatar_matches(avatars_dir: &PathBuf, bytes: &[u8]) -> bool {
    current_self_avatar_path(avatars_dir)
        .and_then(|path| fs::read(path).ok())
        .map(|current| current == bytes)
        .unwrap_or(false)
}

fn log_transfer(path: &PathBuf, event: impl AsRef<str>) {
    let line = format!("{} {}\n", unix_timestamp(), event.as_ref());
    queue_log_write(path, line.into_bytes(), false);
}

fn log_network(path: &PathBuf, event: impl AsRef<str>) {
    let line = format!("{} {}\n", unix_timestamp(), event.as_ref());
    queue_log_write(path, line.into_bytes(), true);
}

struct LogWriteRequest {
    path: PathBuf,
    bytes: Vec<u8>,
    rotate: bool,
}

static LOG_WRITE_SENDER: OnceLock<SyncSender<LogWriteRequest>> = OnceLock::new();

fn queue_log_write(path: &Path, bytes: Vec<u8>, rotate: bool) {
    let _ = log_write_sender().try_send(LogWriteRequest {
        path: path.to_path_buf(),
        bytes,
        rotate,
    });
}

fn log_write_sender() -> &'static SyncSender<LogWriteRequest> {
    LOG_WRITE_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<LogWriteRequest>(2048);
        thread::spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut pending = HashMap::<PathBuf, (Vec<u8>, bool)>::new();
                pending.insert(first.path, (first.bytes, first.rotate));
                let deadline = Instant::now() + Duration::from_millis(500);
                loop {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match receiver.recv_timeout(remaining) {
                        Ok(request) => {
                            let entry = pending.entry(request.path).or_default();
                            entry.0.extend_from_slice(&request.bytes);
                            entry.1 |= request.rotate;
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                for (path, (bytes, rotate)) in pending {
                    const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;
                    if rotate
                        && fs::metadata(&path)
                            .map(|metadata| {
                                metadata.len().saturating_add(bytes.len() as u64) > MAX_LOG_SIZE
                            })
                            .unwrap_or(false)
                    {
                        let previous = path.with_extension("log.1");
                        let _ = fs::remove_file(&previous);
                        let _ = fs::rename(&path, previous);
                    }
                    let _ = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                        .and_then(|mut file| file.write_all(&bytes));
                }
            }
        });
        sender
    })
}

fn event_fingerprint(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016X}")
}

unsafe extern "C" fn on_file_chunk_request(
    tox: *mut c_void,
    friend_number: u32,
    file_number: u32,
    position: u64,
    length: usize,
    user_data: *mut c_void,
) {
    if tox.is_null() || user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };
    let transfer = context
        .outgoing_files
        .lock()
        .ok()
        .and_then(|files| files.get(&(friend_number, file_number)).cloned());
    let Some(transfer) = transfer else {
        log_transfer(
            &context.transfer_log_path,
            format!("SEND_CHUNK missing-source friend={friend_number} file={file_number}"),
        );
        return;
    };
    if position == 0 || length == 0 {
        log_transfer(&context.transfer_log_path, format!("SEND_CHUNK_REQUEST friend={friend_number} file={file_number} pos={position} len={length}"));
    }
    // A zero-length request is toxcore's final acknowledgement: the peer has
    // consumed the complete stream. It is not a request to send an empty
    // chunk. Sending one here made toxcore return an error, so the transfer
    // was never marked complete and the timeout worker offered it again.
    if length == 0 {
        log_transfer(
            &context.transfer_log_path,
            format!("SEND_COMPLETE friend={friend_number} file={file_number}"),
        );
        let completed = context
            .outgoing_files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(&(friend_number, file_number)));
        if let Some(transfer) = completed {
            if let Some(message_id) = transfer.message_id {
                let completed_at = unix_timestamp();
                update_attachment_progress(
                    &context.messages,
                    &message_id,
                    transfer.size,
                    transfer.meter.speed_bytes_per_sec,
                    transfer.size,
                    "complete",
                    true,
                    Some(completed_at),
                );
                if let Ok(mut messages) = context.messages.lock() {
                    if let Some(message) =
                        messages.iter_mut().find(|message| message.id == message_id)
                    {
                        message.delivery = "delivered".to_string();
                        message.delivered_at = Some(completed_at);
                    }
                }
                persist_tox_history(
                    &context.messages,
                    &context.history_path,
                    &context.history_enabled,
                );
            }
        }
        return;
    }

    let mut data = vec![0_u8; length];
    if length > 0 {
        let Ok(mut file) = File::open(&transfer.path) else {
            return;
        };
        if file.seek(SeekFrom::Start(position)).is_err() || file.read_exact(&mut data).is_err() {
            return;
        }
    }
    let mut error = 0_i32;
    unsafe {
        let _ = tox_file_send_chunk(
            tox,
            friend_number,
            file_number,
            position,
            if data.is_empty() {
                std::ptr::null()
            } else {
                data.as_ptr()
            },
            data.len(),
            &mut error,
        );
    }
    if error != 0 {
        log_transfer(&context.transfer_log_path, format!("SEND_CHUNK error={error} friend={friend_number} file={file_number} pos={position} len={length}"));
        return;
    }
    if length > 0 {
        let transferred = position.saturating_add(length as u64).min(transfer.size);
        if let Ok(mut files) = context.outgoing_files.lock() {
            if let Some(active) = files.get_mut(&(friend_number, file_number)) {
                active.last_activity_at = Instant::now();
                let speed = active.meter.update(transferred);
                if transferred >= active.size {
                    active.fully_sent = true;
                }
                if let Some(message_id) = &active.message_id {
                    let state = if active.fully_sent {
                        "awaiting_confirmation"
                    } else {
                        "sending"
                    };
                    update_attachment_progress(
                        &context.messages,
                        message_id,
                        transferred,
                        speed,
                        active.size,
                        state,
                        false,
                        None,
                    );
                }
            }
        }
    }
}

unsafe extern "C" fn on_file_recv(
    tox: *mut c_void,
    friend_number: u32,
    file_number: u32,
    kind: u32,
    file_size: u64,
    filename: *const u8,
    filename_length: usize,
    user_data: *mut c_void,
) {
    if tox.is_null() || user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };
    let is_avatar = kind == 1;
    // qTox uses the raw 32-byte avatar hash as the filename.  It is binary
    // data, not a Windows-safe UTF-8 path, so never use it as a local name.
    // This also makes our avatar offers recognizable by qTox.
    let name = if is_avatar {
        "avatar.png".to_string()
    } else {
        let received_name = if filename.is_null() {
            "file".to_string()
        } else {
            String::from_utf8_lossy(unsafe {
                std::slice::from_raw_parts(filename, filename_length)
            })
            .into_owned()
        };
        safe_file_name(&received_name)
    };
    let image = is_image_name(&name);
    let settings = context
        .file_receive_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default();
    if !is_avatar && settings.deny_all {
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
        }
        log_transfer(&context.transfer_log_path, format!("RECV_REJECTED_BY_POLICY friend={friend_number} file={file_number} size={file_size} name={name} error={error}"));
        return;
    }
    let active_receives = context
        .incoming_files
        .lock()
        .map(|files| {
            files
                .values()
                .filter(|file| file.kind != 1 && file.active)
                .count()
        })
        .unwrap_or(0);
    let automatically_allowed = is_avatar
        || ((settings.auto_accept_any
            || (settings.auto_accept_images && is_auto_accepted_image_name(&name)))
            && file_size <= settings.max_auto_bytes);
    let start_now =
        automatically_allowed && (is_avatar || active_receives < settings.max_concurrent.max(1));
    let auto_queued = automatically_allowed && !start_now;
    let base = if is_avatar {
        &context.avatars_dir
    } else {
        &context.downloads_dir
    };
    if is_avatar && file_size == 0 {
        remove_friend_avatars(base, friend_number, None);
        log_transfer(
            &context.transfer_log_path,
            format!("RECV_AVATAR_REMOVED friend={friend_number} file={file_number}"),
        );
        return;
    }
    let final_path = if is_avatar {
        Some(base.join(format!(
            "{friend_number}-{file_number}-{}-{name}",
            unix_timestamp()
        )))
    } else {
        None
    };
    let path = if let Some(final_path) = &final_path {
        final_path.with_extension("png.part")
    } else {
        unique_download_path(base, &name)
    };
    if let Err(error) = fs::create_dir_all(base) {
        log_transfer(&context.transfer_log_path, format!("RECV_DIRECTORY_FAILED friend={friend_number} file={file_number} kind={kind} path={} error={error}", base.display()));
        return;
    }
    if let Err(error) = File::create(&path) {
        log_transfer(&context.transfer_log_path, format!("RECV_CREATE_FAILED friend={friend_number} file={file_number} kind={kind} path={} error={error}", path.display()));
        return;
    }
    log_transfer(&context.transfer_log_path, format!("RECV_OFFER friend={friend_number} file={file_number} kind={kind} size={file_size} name={name}"));
    let message_id = if is_avatar {
        None
    } else {
        Some(new_message_id(friend_number))
    };
    if let Some(message_id) = &message_id {
        if let Ok(mut messages) = context.messages.lock() {
            messages.push(ToxMessage {
                id: message_id.clone(),
                friend_number,
                text: String::new(),
                mine: false,
                timestamp: unix_timestamp(),
                delivery: default_message_delivery(),
                delivered_at: None,
                attachment: Some(ToxAttachment {
                    name: name.clone(),
                    size: file_size,
                    mime: if image {
                        "image/*".to_string()
                    } else {
                        "application/octet-stream".to_string()
                    },
                    path: path.to_string_lossy().into_owned(),
                    image,
                    transferred: 0,
                    speed_bytes_per_sec: 0,
                    eta_seconds: None,
                    transfer_state: if start_now {
                        "receiving"
                    } else if auto_queued {
                        "queued"
                    } else {
                        "awaiting_confirmation"
                    }
                    .to_string(),
                    completed: false,
                    completed_at: None,
                    transfer_error: None,
                    retry_count: 0,
                }),
                event: None,
            });
        }
        persist_tox_history(
            &context.messages,
            &context.history_path,
            &context.history_enabled,
        );
        increment_unread_friend(context, friend_number);
    }
    if let Ok(mut files) = context.incoming_files.lock() {
        files.insert(
            (friend_number, file_number),
            IncomingFile {
                path,
                final_path,
                size: file_size,
                kind: if is_avatar { 1 } else { kind },
                message_id,
                meter: TransferMeter::new(),
                last_activity_at: Instant::now(),
                active: start_now,
                auto_queued,
            },
        );
    }
    if start_now {
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 0, &mut error);
        }
        log_transfer(
            &context.transfer_log_path,
            format!("RECV_RESUME friend={friend_number} file={file_number} error={error}"),
        );
    } else {
        log_transfer(&context.transfer_log_path, format!("RECV_WAITING friend={friend_number} file={file_number} automatic_queue={auto_queued}"));
    }
}

unsafe extern "C" fn on_file_recv_chunk(
    tox: *mut c_void,
    friend_number: u32,
    file_number: u32,
    position: u64,
    data: *const u8,
    length: usize,
    user_data: *mut c_void,
) {
    if user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };
    if length == 0 {
        let transfer = context
            .incoming_files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(&(friend_number, file_number)));
        if let Some(transfer) = transfer {
            let mut published_path = transfer.path.clone();
            let valid = if let Some(final_path) = &transfer.final_path {
                if is_complete_avatar(&transfer.path, Some(transfer.size)) {
                    match fs::rename(&transfer.path, final_path) {
                        Ok(()) => {
                            published_path = final_path.clone();
                            remove_friend_avatars(
                                &context.avatars_dir,
                                friend_number,
                                Some(final_path),
                            );
                            true
                        }
                        Err(error) => {
                            log_transfer(
                                &context.transfer_log_path,
                                format!("RECV_AVATAR_PUBLISH_FAILED friend={friend_number} file={file_number} error={error}"),
                            );
                            false
                        }
                    }
                } else {
                    false
                }
            } else {
                true
            };
            if !valid {
                let _ = fs::remove_file(&transfer.path);
                log_transfer(
                    &context.transfer_log_path,
                    format!(
                        "RECV_AVATAR_INVALID friend={friend_number} file={file_number} expected={}",
                        transfer.size
                    ),
                );
                return;
            }
            log_transfer(
                &context.transfer_log_path,
                format!(
                    "RECV_COMPLETE friend={friend_number} file={file_number} kind={} path={}",
                    transfer.kind,
                    published_path.display()
                ),
            );
            if let Some(message_id) = transfer.message_id {
                update_attachment_progress(
                    &context.messages,
                    &message_id,
                    transfer.size,
                    transfer.meter.speed_bytes_per_sec,
                    transfer.size,
                    "complete",
                    true,
                    Some(unix_timestamp()),
                );
            }
            persist_tox_history(
                &context.messages,
                &context.history_path,
                &context.history_enabled,
            );
            if transfer.kind != 1 && !tox.is_null() {
                let next = context.incoming_files.lock().ok().and_then(|mut files| {
                    files.iter_mut().find_map(|(key, file)| {
                        if file.auto_queued && !file.active {
                            file.active = true;
                            file.auto_queued = false;
                            file.message_id.clone().map(|message_id| (*key, message_id))
                        } else {
                            None
                        }
                    })
                });
                if let Some(((next_friend, next_file), message_id)) = next {
                    let mut error = 0_i32;
                    unsafe {
                        let _ = tox_file_control(tox, next_friend, next_file, 0, &mut error);
                    }
                    if error == 0 {
                        set_attachment_transfer_state(&context.messages, &message_id, "receiving");
                    }
                    log_transfer(
                        &context.transfer_log_path,
                        format!(
                            "RECV_QUEUE_RESUME friend={next_friend} file={next_file} error={error}"
                        ),
                    );
                }
            }
        }
        return;
    }
    if data.is_null() {
        return;
    }
    let mut update = None;
    if let Ok(mut files) = context.incoming_files.lock() {
        if let Some(transfer) = files.get_mut(&(friend_number, file_number)) {
            transfer.last_activity_at = Instant::now();
            if let Ok(mut file) = File::options().write(true).open(&transfer.path) {
                if file.seek(SeekFrom::Start(position)).is_ok()
                    && file
                        .write_all(unsafe { std::slice::from_raw_parts(data, length) })
                        .is_ok()
                {
                    let transferred = position.saturating_add(length as u64).min(transfer.size);
                    let speed = transfer.meter.update(transferred);
                    update = transfer
                        .message_id
                        .clone()
                        .map(|id| (id, transferred, speed, transfer.size));
                }
            }
        }
    }
    if let Some((message_id, transferred, speed, size)) = update {
        update_attachment_progress(
            &context.messages,
            &message_id,
            transferred,
            speed,
            size,
            "receiving",
            false,
            None,
        );
    }
}

unsafe extern "C" fn on_friend_connection_status(
    tox: *mut c_void,
    friend_number: u32,
    connection: u8,
    user_data: *mut c_void,
) {
    if tox.is_null() || user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };
    log_network(
        &context.network_log_path,
        format!("FRIEND_CONNECTION friend={friend_number} status={connection}"),
    );
    if connection != 0 {
        context
            .pq
            .queue(friend_number, [context.pq.capability_packet()]);
    }
    let mut key = [0_u8; 32];
    let mut key_error = 0_i32;
    if unsafe { tox_friend_get_public_key(tox, friend_number, key.as_mut_ptr(), &mut key_error) } {
        let public_key = key
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        if let Ok(mut cache) = context.friend_cache.lock() {
            let entry = cache.entry(public_key).or_default();
            if connection != 0 {
                entry.authorized = true;
            }
            if connection != 0 || entry.last_online.is_some() {
                entry.last_online = Some(unix_timestamp());
                if let Ok(serialized) = serde_json::to_vec(&*cache) {
                    let _ = atomic_write_sender().try_send(AtomicWriteRequest {
                        path: context.friend_cache_path.clone(),
                        bytes: serialized,
                    });
                }
            }
        }
    }
    if let Some(updates) = &context.updates {
        updates.changed();
    }
    if connection == 0 {
        return;
    }

    let Some(path) = current_self_avatar_path(&context.avatars_dir) else {
        log_transfer(
            &context.transfer_log_path,
            format!("AVATAR_CONNECT no-self-avatar friend={friend_number}"),
        );
        return;
    };
    let Ok(bytes) = fs::read(&path) else {
        log_transfer(
            &context.transfer_log_path,
            format!(
                "AVATAR_CONNECT unreadable-self-avatar friend={friend_number} path={}",
                path.display()
            ),
        );
        return;
    };
    if bytes.is_empty() {
        return;
    }
    if bytes.len() > 64 * 1024 {
        log_transfer(
            &context.transfer_log_path,
            format!(
                "AVATAR_CONNECT_SKIP_TOO_LARGE friend={friend_number} bytes={}",
                bytes.len()
            ),
        );
        return;
    }
    let mut hash = [0_u8; 32];
    unsafe {
        let _ = tox_hash(hash.as_mut_ptr(), bytes.as_ptr(), bytes.len());
    }
    let mut error = 0_i32;
    let number = unsafe {
        tox_file_send(
            tox,
            friend_number,
            1,
            bytes.len() as u64,
            hash.as_ptr(),
            hash.as_ptr(),
            hash.len(),
            &mut error,
        )
    };
    log_transfer(
        &context.transfer_log_path,
        format!(
            "AVATAR_CONNECT_SEND friend={friend_number} file={number} bytes={} error={error}",
            bytes.len()
        ),
    );
    if error == 0 {
        if let Ok(mut outgoing) = context.outgoing_files.lock() {
            outgoing.insert(
                (friend_number, number),
                OutgoingFile {
                    path,
                    size: bytes.len() as u64,
                    message_id: None,
                    meter: TransferMeter::new(),
                    last_activity_at: Instant::now(),
                    fully_sent: false,
                    retry_count: 0,
                },
            );
        }
    }
}

fn unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn new_message_id(friend_number: u32) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{friend_number}-{nanos}")
}

fn pq_history_text(status: &str, mine: bool) -> String {
    match status {
        "offered" => "Запрос на постквантовое шифрование отправлен".to_string(),
        "incoming_offer" => "Получен запрос на постквантовое шифрование".to_string(),
        "accepting" => "Запрос принят, выполняется постквантовое согласование".to_string(),
        "active" => "Постквантовое шифрование успешно включено".to_string(),
        "rejected" if mine => "Контакт отклонил запрос на постквантовое шифрование".to_string(),
        "rejected" => "Запрос на постквантовое шифрование отклонён".to_string(),
        "withdrawn" if mine => "Предложение постквантового шифрования отозвано".to_string(),
        "withdrawn" => "Контакт отозвал предложение постквантового шифрования".to_string(),
        "superseded" => "Одновременные PQ-предложения объединены".to_string(),
        "close_pending" if mine => {
            "Запланировано согласованное отключение постквантового слоя".to_string()
        }
        "close_pending" => {
            "Контакт запросил согласованное отключение постквантового слоя".to_string()
        }
        "closed" => "Постквантовый слой отключён по взаимному согласованию".to_string(),
        _ => "Ошибка постквантового согласования".to_string(),
    }
}

fn pq_history_event(status: &PqStatus, role: &str, event_status: &str) -> PqHistoryEvent {
    PqHistoryEvent {
        kind: "pq".to_string(),
        status: event_status.to_string(),
        role: role.to_string(),
        local_fingerprint: status.local_fingerprint.clone(),
        peer_fingerprint: status.peer_fingerprint.clone(),
        fingerprint_changed: status.fingerprint_changed,
        error: status.error.clone(),
    }
}

fn append_pq_history(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    friend_number: u32,
    status: &PqStatus,
    role: &str,
    event_status: &str,
    mine: bool,
) {
    if let Ok(mut messages) = messages.lock() {
        messages.push(ToxMessage {
            id: new_message_id(friend_number),
            friend_number,
            text: pq_history_text(event_status, mine),
            mine,
            timestamp: unix_timestamp(),
            delivery: if mine {
                "delivered".to_string()
            } else {
                default_message_delivery()
            },
            delivered_at: None,
            attachment: None,
            event: Some(pq_history_event(status, role, event_status)),
        });
    }
}

fn update_latest_pq_history(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    friend_number: u32,
    status: &PqStatus,
    event_status: &str,
) -> bool {
    let Ok(mut messages) = messages.lock() else {
        return false;
    };
    let Some(message) = messages.iter_mut().rev().find(|message| {
        message.friend_number == friend_number
            && message.event.as_ref().is_some_and(|event| {
                if event.kind != "pq" {
                    return false;
                }
                match event_status {
                    "active" | "rejected" | "withdrawn" | "superseded" => matches!(
                        event.status.as_str(),
                        "offered" | "incoming_offer" | "accepting"
                    ),
                    "closed" => event.status == "close_pending",
                    _ => !matches!(
                        event.status.as_str(),
                        "active" | "rejected" | "withdrawn" | "closed"
                    ),
                }
            })
    }) else {
        return false;
    };
    let role = message
        .event
        .as_ref()
        .map(|event| event.role.clone())
        .unwrap_or_else(|| {
            if message.mine {
                "initiator"
            } else {
                "responder"
            }
            .to_string()
        });
    message.text = pq_history_text(event_status, message.mine);
    message.event = Some(pq_history_event(status, &role, event_status));
    true
}

fn persist_tox_history(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    path: &PathBuf,
    enabled: &Arc<AtomicBool>,
) {
    bump_history_revision(path);
    if !enabled.load(Ordering::Relaxed) {
        return;
    }
    let _ = history_persist_sender().try_send(HistoryPersistRequest {
        messages: Arc::clone(messages),
        path: path.clone(),
        enabled: Arc::clone(enabled),
    });
}

#[derive(Clone)]
struct HistoryPersistRequest {
    messages: Arc<Mutex<Vec<ToxMessage>>>,
    path: PathBuf,
    enabled: Arc<AtomicBool>,
}

static HISTORY_REVISIONS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
static HISTORY_PERSIST_SENDER: OnceLock<SyncSender<HistoryPersistRequest>> = OnceLock::new();
static CANCELLED_BATCH_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn cancel_batched_write(path: &Path) {
    if let Ok(mut paths) = CANCELLED_BATCH_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        paths.insert(path.to_path_buf());
    }
}

fn allow_batched_write(path: &Path) {
    if let Ok(mut paths) = CANCELLED_BATCH_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        paths.remove(path);
    }
}

fn with_active_batched_path(path: &Path, write: impl FnOnce()) {
    let Ok(paths) = CANCELLED_BATCH_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    else {
        return;
    };
    if !paths.contains(path) {
        write();
    }
}

fn bump_history_revision(path: &Path) -> u64 {
    let revisions = HISTORY_REVISIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut revisions) = revisions.lock() else {
        return 0;
    };
    let revision = revisions.entry(path.to_path_buf()).or_default();
    *revision = revision.saturating_add(1);
    *revision
}

fn history_revision(path: &Path) -> u64 {
    HISTORY_REVISIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|revisions| revisions.get(path).copied())
        .unwrap_or(0)
}

fn persist_tox_history_now(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    path: &Path,
    enabled: &AtomicBool,
) {
    if !enabled.load(Ordering::Relaxed) {
        return;
    }
    let Ok(messages) = messages.lock() else {
        return;
    };
    let Ok(serialized) = serde_json::to_vec(&*messages) else {
        return;
    };
    let _ = atomic_write(path, &serialized);
}

fn history_persist_sender() -> &'static SyncSender<HistoryPersistRequest> {
    HISTORY_PERSIST_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<HistoryPersistRequest>(128);
        thread::spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut pending = HashMap::from([(first.path.clone(), first)]);
                let deadline = Instant::now() + Duration::from_millis(350);
                loop {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match receiver.recv_timeout(remaining) {
                        Ok(request) => {
                            pending.insert(request.path.clone(), request);
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                for request in pending.into_values() {
                    with_active_batched_path(&request.path, || {
                        persist_tox_history_now(&request.messages, &request.path, &request.enabled);
                    });
                }
            }
        });
        sender
    })
}

fn persist_pending_messages(messages: &Arc<Mutex<Vec<PendingToxMessage>>>, path: &PathBuf) {
    let Ok(messages) = messages.lock() else {
        return;
    };
    let Ok(serialized) = serde_json::to_vec(&*messages) else {
        return;
    };
    let _ = atomic_write_sender().try_send(AtomicWriteRequest {
        path: path.clone(),
        bytes: serialized,
    });
}

fn persist_pending_messages_now(messages: &Arc<Mutex<Vec<PendingToxMessage>>>, path: &Path) {
    let Ok(messages) = messages.lock() else {
        return;
    };
    let Ok(serialized) = serde_json::to_vec(&*messages) else {
        return;
    };
    let _ = atomic_write(path, &serialized);
}

fn persist_pending_files(files: &Arc<Mutex<Vec<PendingToxFile>>>, path: &PathBuf) {
    let Ok(files) = files.lock() else { return };
    let Ok(serialized) = serde_json::to_vec(&*files) else {
        return;
    };
    let _ = fs::write(path, serialized);
}

fn persist_incoming_friend_requests(
    requests: &Arc<Mutex<Vec<IncomingFriendRequest>>>,
    path: &PathBuf,
) {
    let Ok(requests) = requests.lock() else {
        return;
    };
    let Ok(serialized) = serde_json::to_vec(&*requests) else {
        return;
    };
    let _ = fs::write(path, serialized);
}

// toxcore does not retain text messages for an offline peer.  Keep the queue
// in our profile and only pass an item to toxcore once the friend is online.
fn flush_pending_messages(state: &ToxState, tox: *mut c_void) {
    let pending = match state.pending_messages.lock() {
        Ok(items) => items.clone(),
        Err(_) => return,
    };
    if pending.is_empty() {
        return;
    }

    let mut sent_receipts = Vec::new();
    let mut offsets = Vec::new();
    for item in pending {
        if state.pq.holds_plaintext_messages(item.friend_number) {
            continue;
        }
        let mut connection_error = 0_i32;
        let connection = unsafe {
            tox_friend_get_connection_status(tox, item.friend_number, &mut connection_error)
        };
        if connection_error != 0 || connection == 0 {
            continue;
        }
        let mut offset = item.next_offset.min(item.text.len());
        while offset < item.text.len() {
            let end = text_chunk_end(&item.text, offset);
            let chunk = &item.text.as_bytes()[offset..end];
            let mut error = 0_i32;
            let tox_message_id = unsafe {
                tox_friend_send_message(
                    tox,
                    item.friend_number,
                    0,
                    chunk.as_ptr(),
                    chunk.len(),
                    &mut error,
                )
            };
            if error != 0 {
                log_network(
                    &state.network_log_path,
                    format!(
                        "QUEUE_SEND_FAILED friend={} local_id={} offset={} error={error}",
                        item.friend_number, item.id, offset
                    ),
                );
                break;
            }
            log_network(
                &state.network_log_path,
                format!(
                    "QUEUE_FRAGMENT_SENT friend={} local_id={} tox_message_id={} offset={} bytes={} fingerprint={}",
                    item.friend_number,
                    item.id,
                    tox_message_id,
                    offset,
                    chunk.len(),
                    event_fingerprint(chunk)
                ),
            );
            sent_receipts.push((item.id.clone(), item.friend_number, tox_message_id));
            offset = end;
        }
        offsets.push((item.id, offset, offset == item.text.len()));
    }
    if sent_receipts.is_empty() {
        return;
    }
    if let Ok(mut items) = state.pending_messages.lock() {
        for item in items.iter_mut() {
            if let Some((_, offset, _)) = offsets.iter().find(|(id, _, _)| id == &item.id) {
                item.next_offset = *offset;
            }
        }
        items.retain(|item| {
            !offsets
                .iter()
                .any(|(id, _, complete)| id == &item.id && *complete)
        });
    }
    if let Ok(mut receipts) = state.delivery_receipts.lock() {
        for (id, friend_number, tox_message_id) in &sent_receipts {
            receipts.insert((*friend_number, *tox_message_id), id.clone());
        }
    }
    if let Ok(mut progress_by_id) = state.receipt_progress.lock() {
        for (id, _, _) in &sent_receipts {
            progress_by_id.entry(id.clone()).or_default().remaining += 1;
        }
        for (id, _, complete) in &offsets {
            if *complete {
                progress_by_id.entry(id.clone()).or_default().all_sent = true;
            }
        }
    }
    if let Ok(mut messages) = state.messages.lock() {
        for message in messages.iter_mut() {
            if offsets
                .iter()
                .any(|(id, _, complete)| id == &message.id && *complete)
            {
                message.delivery = "awaiting_receipt".to_string();
                message.delivered_at = None;
            }
        }
    }
    persist_pending_messages(&state.pending_messages, &state.pending_messages_path);
    persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
}

fn flush_pending_pq_messages(state: &ToxState, tox: *mut c_void) {
    let pending = match state.pending_pq_messages.lock() {
        Ok(items) => items.clone(),
        Err(_) => return,
    };
    if pending.is_empty() {
        return;
    }

    let mut sent = Vec::new();
    for item in pending {
        if !friend_is_connected(tox, item.friend_number)
            || !state.pq.queues_encrypted_messages(item.friend_number)
        {
            continue;
        }
        let encrypted = match state.pq.encrypt(item.friend_number, &item.text) {
            Ok(encrypted) => encrypted,
            Err(error) => {
                log_network(
                    &state.network_log_path,
                    format!(
                        "PQ_QUEUE_ENCRYPT_WAIT friend={} local_id={} error={error}",
                        item.friend_number, item.id
                    ),
                );
                continue;
            }
        };
        if let Ok(mut receipts) = state.pq_receipts.lock() {
            receipts.insert((item.friend_number, encrypted.wire_id), item.id.clone());
        } else {
            continue;
        }
        state.pq.queue(item.friend_number, encrypted.packets);
        sent.push(item.id);
    }
    if sent.is_empty() {
        return;
    }
    if let Ok(mut pending) = state.pending_pq_messages.lock() {
        pending.retain(|item| !sent.iter().any(|id| id == &item.id));
    }
    if let Ok(mut messages) = state.messages.lock() {
        for message in messages.iter_mut() {
            if sent.iter().any(|id| id == &message.id) {
                message.delivery = "awaiting_receipt".to_string();
                message.delivered_at = None;
            }
        }
    }
    persist_pending_messages(&state.pending_pq_messages, &state.pending_pq_messages_path);
    persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
}

fn drive_pq_shutdowns(state: &ToxState) {
    for friend_number in state.pq.shutdown_friends() {
        let pending_drained = state
            .pending_pq_messages
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .all(|message| message.friend_number != friend_number)
            })
            .unwrap_or(false);
        let receipts_drained = state
            .pq_receipts
            .lock()
            .map(|receipts| {
                receipts
                    .keys()
                    .all(|(receipt_friend, _)| *receipt_friend != friend_number)
            })
            .unwrap_or(false);
        let (packets, closed) = state
            .pq
            .drive_shutdown(friend_number, pending_drained && receipts_drained);
        if !packets.is_empty() {
            state.pq.queue(friend_number, packets);
        }
        if closed {
            let status = state.pq.status(friend_number);
            if update_latest_pq_history(&state.messages, friend_number, &status, "closed") {
                persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
            }
        }
    }
}

fn flush_pq_outbox(state: &ToxState, tox: *mut c_void) {
    let mut outbox = state.pq.take_outbox();
    let mut retry = std::collections::VecDeque::new();
    while let Some((friend_number, bytes)) = outbox.pop_front() {
        if !friend_is_connected(tox, friend_number) {
            retry.push_back((friend_number, bytes));
            continue;
        }
        let mut error = 0_i32;
        let sent = unsafe {
            tox_friend_send_lossless_packet(
                tox,
                friend_number,
                bytes.as_ptr(),
                bytes.len(),
                &mut error,
            )
        };
        if !sent || error != 0 {
            retry.push_back((friend_number, bytes));
            // A full toxcore send queue usually drains on the next iterate.
            // Preserve order for every remaining lossless packet.
            retry.append(&mut outbox);
            break;
        }
    }
    if !retry.is_empty() {
        state.pq.requeue_front(retry);
    }
}

fn flush_pending_files(state: &ToxState, tox: *mut c_void) {
    let pending = match state.pending_files.lock() {
        Ok(items) => items.clone(),
        Err(_) => return,
    };
    if pending.is_empty() {
        return;
    }

    let mut started = Vec::new();
    let mut failed = Vec::new();
    for item in pending {
        let path = PathBuf::from(&item.path);
        if !path.is_file() {
            log_transfer(
                &state.transfer_log_path,
                format!(
                    "FILE_QUEUE_MISSING friend={} local_id={} path={}",
                    item.friend_number, item.id, item.path
                ),
            );
            set_attachment_transfer_error(
                &state.messages,
                &item.id,
                "Файл для передачи не найден.",
            );
            failed.push(item.id);
            continue;
        }
        let mut connection_error = 0_i32;
        let connection = unsafe {
            tox_friend_get_connection_status(tox, item.friend_number, &mut connection_error)
        };
        if connection_error != 0 || connection == 0 {
            continue;
        }

        // toxcore expects every outgoing file to have a stable 32-byte ID.
        // A null ID happened to work for some transfers, but qTox can leave
        // such offers paused and never request the first chunk.
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                log_transfer(
                    &state.transfer_log_path,
                    format!(
                        "FILE_QUEUE_READ_FAILED friend={} local_id={} error={error}",
                        item.friend_number, item.id
                    ),
                );
                set_attachment_transfer_error(
                    &state.messages,
                    &item.id,
                    "Не удалось прочитать файл для передачи.",
                );
                failed.push(item.id);
                continue;
            }
        };
        if bytes.len() as u64 != item.size {
            log_transfer(
                &state.transfer_log_path,
                format!(
                    "FILE_QUEUE_SIZE_CHANGED friend={} local_id={} expected={} actual={}",
                    item.friend_number,
                    item.id,
                    item.size,
                    bytes.len()
                ),
            );
            set_attachment_transfer_error(
                &state.messages,
                &item.id,
                "Файл изменился после добавления в очередь.",
            );
            failed.push(item.id);
            continue;
        }
        let mut file_id = [0_u8; 32];
        unsafe {
            let _ = tox_hash(file_id.as_mut_ptr(), bytes.as_ptr(), bytes.len());
        }

        let mut error = 0_i32;
        let file_number = unsafe {
            tox_file_send(
                tox,
                item.friend_number,
                0,
                item.size,
                file_id.as_ptr(),
                item.filename.as_bytes().as_ptr(),
                item.filename.len(),
                &mut error,
            )
        };
        if error == 0 {
            if let Ok(mut outgoing) = state.outgoing_files.lock() {
                outgoing.insert(
                    (item.friend_number, file_number),
                    OutgoingFile {
                        path,
                        size: item.size,
                        message_id: Some(item.id.clone()),
                        meter: TransferMeter::new(),
                        last_activity_at: Instant::now(),
                        fully_sent: false,
                        retry_count: item.retry_count,
                    },
                );
            }
            log_transfer(
                &state.transfer_log_path,
                format!(
                    "FILE_QUEUE_STARTED friend={} local_id={} file={} bytes={} file_id={:02X?}",
                    item.friend_number, item.id, file_number, item.size, file_id
                ),
            );
            started.push(item.id);
        } else {
            // A temporary transport failure is not an error to the user: the
            // durable entry remains in the queue and will be retried later.
            log_transfer(
                &state.transfer_log_path,
                format!(
                    "FILE_QUEUE_RETRY friend={} local_id={} error={error}",
                    item.friend_number, item.id
                ),
            );
        }
    }
    if started.is_empty() && failed.is_empty() {
        return;
    }
    if let Ok(mut items) = state.pending_files.lock() {
        items.retain(|item| {
            !started.iter().any(|id| id == &item.id) && !failed.iter().any(|id| id == &item.id)
        });
    }
    if let Ok(mut messages) = state.messages.lock() {
        for message in messages.iter_mut() {
            if started.iter().any(|id| id == &message.id) {
                message.delivery = "awaiting_receipt".to_string();
                if let Some(attachment) = message.attachment.as_mut() {
                    attachment.transfer_state = "sending".to_string();
                    attachment.completed = false;
                    attachment.transferred = 0;
                    attachment.speed_bytes_per_sec = 0;
                    attachment.eta_seconds = None;
                }
            }
        }
    }
    persist_pending_files(&state.pending_files, &state.pending_files_path);
    persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
}

// toxcore transfers are stream based: there is no protocol-level resume after a
// cancellation.  A retry therefore creates a fresh Tox file offer from the
// locally cached source file.  This is safer than leaving a dead offer forever.
fn friend_is_connected(tox: *mut c_void, friend_number: u32) -> bool {
    let mut error = 0_i32;
    unsafe { tox_friend_get_connection_status(tox, friend_number, &mut error) != 0 && error == 0 }
}

fn check_file_transfer_timeouts(state: &ToxState, tox: *mut c_void) {
    let expired_outgoing = state
        .outgoing_files
        .lock()
        .ok()
        .map(|files| {
            files
                .iter()
                .filter(|(_, transfer)| {
                    !transfer.fully_sent
                        && transfer.last_activity_at.elapsed()
                            >= transfer_idle_timeout(&transfer.meter)
                })
                .filter(|((friend_number, _), _)| friend_is_connected(tox, *friend_number))
                .map(|(key, transfer)| (*key, transfer.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for ((friend_number, file_number), transfer) in expired_outgoing {
        if let Ok(mut files) = state.outgoing_files.lock() {
            files.remove(&(friend_number, file_number));
        }
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
        }
        if let Some(message_id) = transfer.message_id {
            if transfer.retry_count < MAX_FILE_TRANSFER_RETRIES && transfer.path.is_file() {
                let already_queued = state
                    .pending_files
                    .lock()
                    .ok()
                    .map(|items| items.iter().any(|item| item.id == message_id))
                    .unwrap_or(true);
                if !already_queued {
                    let name = transfer
                        .path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("file")
                        .to_string();
                    if let Ok(mut pending) = state.pending_files.lock() {
                        pending.push(PendingToxFile {
                            id: message_id.clone(),
                            friend_number,
                            filename: name,
                            mime: "application/octet-stream".to_string(),
                            path: transfer.path.to_string_lossy().to_string(),
                            size: transfer.size,
                            timestamp: unix_timestamp(),
                            retry_count: transfer.retry_count + 1,
                        });
                    }
                    set_attachment_retrying(&state.messages, &message_id, transfer.retry_count + 1);
                    log_transfer(&state.transfer_log_path, format!("FILE_TIMEOUT_RETRY friend={friend_number} file={file_number} message={message_id} retry={}", transfer.retry_count + 1));
                }
            } else {
                set_attachment_transfer_error(
                    &state.messages,
                    &message_id,
                    "Тайм-аут передачи. Можно отправить файл заново.",
                );
                log_transfer(&state.transfer_log_path, format!("FILE_TIMEOUT_FAILED friend={friend_number} file={file_number} message={message_id}"));
            }
        }
    }

    let expired_incoming = state
        .incoming_files
        .lock()
        .ok()
        .map(|files| {
            files
                .iter()
                .filter(|(_, transfer)| {
                    transfer.last_activity_at.elapsed() >= transfer_idle_timeout(&transfer.meter)
                })
                .filter(|((friend_number, _), _)| friend_is_connected(tox, *friend_number))
                .map(|(key, transfer)| (*key, transfer.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for ((friend_number, file_number), transfer) in expired_incoming {
        if let Ok(mut files) = state.incoming_files.lock() {
            files.remove(&(friend_number, file_number));
        }
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
        }
        let _ = fs::remove_file(&transfer.path);
        if let Some(message_id) = transfer.message_id {
            set_attachment_transfer_error(
                &state.messages,
                &message_id,
                "Тайм-аут получения файла. Попросите отправить его заново.",
            );
            log_transfer(&state.transfer_log_path, format!("FILE_TIMEOUT_RECEIVE friend={friend_number} file={file_number} message={message_id}"));
        } else {
            log_transfer(
                &state.transfer_log_path,
                format!("AVATAR_TIMEOUT_RECEIVE friend={friend_number} file={file_number}"),
            );
        }
    }
    persist_pending_files(&state.pending_files, &state.pending_files_path);
    persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
}

const BOOTSTRAP_NODES: [(&str, u16, &str); 4] = [
    (
        "144.217.167.73",
        33445,
        "7E5668E0EE09E19F320AD47902419331FFEE147BB3606769CFBE921A2A2FD34C",
    ),
    (
        "172.104.215.182",
        33445,
        "DA2BD927E01CD05EBCC2574EBE5BEBB10FF59AE0B2105A7D1E2B40E49BB20239",
    ),
    (
        "tox.initramfs.io",
        33445,
        "3F0A45A268367C1BEA652F258C85F4A66DA76BCAA667A49E770BCC4917AB6A25",
    ),
    (
        "tox1.mf-net.eu",
        33445,
        "B3E5FA80DC8EBD1149AD2AB35ED8B85BD546DEDE261CA593234C619249419506",
    ),
];

#[derive(Clone)]
struct ResolvedBootstrapNode {
    address: String,
    port: u16,
    key: [u8; 32],
}

struct BootstrapNodeCache {
    refreshed_at: Option<Instant>,
    nodes: Vec<ResolvedBootstrapNode>,
    refreshing: bool,
}

static DIRECT_BOOTSTRAP_CACHE: OnceLock<Mutex<BootstrapNodeCache>> = OnceLock::new();

fn decode_bootstrap_key(key_hex: &str) -> Option<[u8; 32]> {
    let mut key = [0_u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        let offset = index * 2;
        *byte = u8::from_str_radix(key_hex.get(offset..offset + 2)?, 16).ok()?;
    }
    Some(key)
}

fn literal_bootstrap_nodes() -> Vec<ResolvedBootstrapNode> {
    BOOTSTRAP_NODES
        .iter()
        .filter(|(host, _, _)| host.parse::<std::net::IpAddr>().is_ok())
        .filter_map(|(host, port, key_hex)| {
            Some(ResolvedBootstrapNode {
                address: (*host).to_string(),
                port: *port,
                key: decode_bootstrap_key(key_hex)?,
            })
        })
        .collect()
}

fn resolved_bootstrap_nodes(allow_local_dns: bool) -> Vec<ResolvedBootstrapNode> {
    if !allow_local_dns {
        // Tor and explicit proxy routes must never leak bootstrap DNS queries.
        return literal_bootstrap_nodes();
    }

    let cache = DIRECT_BOOTSTRAP_CACHE.get_or_init(|| {
        Mutex::new(BootstrapNodeCache {
            refreshed_at: None,
            nodes: literal_bootstrap_nodes(),
            refreshing: false,
        })
    });
    let Ok(mut cache) = cache.lock() else {
        return literal_bootstrap_nodes();
    };
    if cache
        .refreshed_at
        .is_some_and(|refreshed_at| refreshed_at.elapsed() < Duration::from_secs(300))
    {
        return cache.nodes.clone();
    }
    let available = cache.nodes.clone();
    if cache.refreshing {
        return available;
    }
    cache.refreshing = true;
    drop(cache);

    // Never make a profile's network loop, its Tox handle, or a Tauri command
    // wait for Windows DNS. One resolver refresh is shared by every profile.
    thread::spawn(refresh_direct_bootstrap_nodes);
    available
}

fn refresh_direct_bootstrap_nodes() {
    let mut nodes = literal_bootstrap_nodes();
    let mut addresses = nodes
        .iter()
        .map(|node| (node.address.clone(), node.port, node.key))
        .collect::<HashSet<_>>();
    for (host, port, key_hex) in BOOTSTRAP_NODES {
        if host.parse::<std::net::IpAddr>().is_ok() {
            continue;
        }
        let Some(key) = decode_bootstrap_key(key_hex) else {
            continue;
        };
        let Ok(resolved) = (host, port).to_socket_addrs() else {
            continue;
        };
        for address in resolved.filter(|address| address.is_ipv4()) {
            let entry = (address.ip().to_string(), port, key);
            if addresses.insert(entry.clone()) {
                nodes.push(ResolvedBootstrapNode {
                    address: entry.0,
                    port: entry.1,
                    key: entry.2,
                });
            }
        }
    }
    let Some(cache) = DIRECT_BOOTSTRAP_CACHE.get() else {
        return;
    };
    if let Ok(mut cache) = cache.lock() {
        cache.refreshed_at = Some(Instant::now());
        cache.nodes = nodes;
        cache.refreshing = false;
    }
}

fn bootstrap_tox(tox: *mut c_void, nodes: &[ResolvedBootstrapNode]) {
    // The connection state below is the source of truth; accepting a bootstrap
    // packet only means it was queued, not that the DHT connection succeeded.
    for node in nodes {
        let Ok(host) = CString::new(node.address.as_str()) else {
            continue;
        };
        let mut error = 0_i32;
        unsafe {
            let _ = tox_bootstrap(tox, host.as_ptr(), node.port, node.key.as_ptr(), &mut error);
            // The same verified nodes expose TCP relay ports. Adding them lets
            // toxcore establish a route even when local UDP is filtered.
            let _ = tox_add_tcp_relay(tox, host.as_ptr(), node.port, node.key.as_ptr(), &mut error);
        }
    }
}

impl Drop for ToxState {
    fn drop(&mut self) {
        if Arc::strong_count(&self.handle) != 1 {
            return;
        }
        self.running.store(false, Ordering::Relaxed);
        persist_tox_history_now(&self.messages, &self.history_path, &self.history_enabled);
        with_active_batched_path(&self.pending_messages_path, || {
            persist_pending_messages_now(&self.pending_messages, &self.pending_messages_path);
        });
        with_active_batched_path(&self.pending_pq_messages_path, || {
            persist_pending_messages_now(&self.pending_pq_messages, &self.pending_pq_messages_path);
        });
        with_active_batched_path(&self.unread_state_path, || {
            persist_unread_state_now(&self.unread_state, &self.unread_state_path);
        });
        if let Ok(mut state) = self.handle.lock() {
            if let Some(instance) = state.take() {
                let _ = Self::save(&instance);
                unsafe { tox_kill(instance.instance.as_ptr()) };
            }
        }
    }
}

unsafe extern "C" {
    fn tox_options_new(error: *mut i32) -> *mut c_void;
    fn tox_options_free(options: *mut c_void);
    fn tox_options_set_ipv6_enabled(options: *mut c_void, enabled: bool);
    fn tox_options_set_udp_enabled(options: *mut c_void, enabled: bool);
    fn tox_options_set_local_discovery_enabled(options: *mut c_void, enabled: bool);
    #[cfg(test)]
    fn tox_options_get_ipv6_enabled(options: *const c_void) -> bool;
    #[cfg(test)]
    fn tox_options_get_udp_enabled(options: *const c_void) -> bool;
    #[cfg(test)]
    fn tox_options_get_local_discovery_enabled(options: *const c_void) -> bool;
    fn tox_options_set_proxy_type(options: *mut c_void, proxy_type: i32);
    fn tox_options_set_proxy_host(options: *mut c_void, host: *const i8) -> bool;
    fn tox_options_set_proxy_port(options: *mut c_void, port: u16);
    fn tox_options_set_experimental_disable_dns(options: *mut c_void, enabled: bool);
    fn tox_options_set_savedata_type(options: *mut c_void, savedata_type: i32);
    fn tox_options_set_savedata_data(options: *mut c_void, data: *const u8, length: usize) -> bool;
    fn tox_new(options: *const c_void, error: *mut i32) -> *mut c_void;
    fn tox_kill(tox: *mut c_void);
    fn tox_get_savedata_size(tox: *const c_void) -> usize;
    fn tox_get_savedata(tox: *const c_void, savedata: *mut u8);
    fn tox_self_get_address(tox: *const c_void, address: *mut u8);
    fn tox_bootstrap(
        tox: *mut c_void,
        host: *const i8,
        port: u16,
        public_key: *const u8,
        error: *mut i32,
    ) -> bool;
    fn tox_add_tcp_relay(
        tox: *mut c_void,
        host: *const i8,
        port: u16,
        public_key: *const u8,
        error: *mut i32,
    ) -> bool;
    fn tox_self_get_connection_status(tox: *const c_void) -> u8;
    fn tox_iteration_interval(tox: *const c_void) -> u32;
    fn tox_iterate(tox: *mut c_void, user_data: *mut c_void);
    fn tox_friend_add(
        tox: *mut c_void,
        address: *const u8,
        message: *const u8,
        length: usize,
        error: *mut i32,
    ) -> u32;
    fn tox_friend_add_norequest(tox: *mut c_void, public_key: *const u8, error: *mut i32) -> u32;
    fn tox_friend_delete(tox: *mut c_void, friend_number: u32, error: *mut i32) -> bool;
    fn tox_self_get_friend_list_size(tox: *const c_void) -> usize;
    fn tox_self_get_friend_list(tox: *const c_void, friend_list: *mut u32);
    fn tox_friend_get_public_key(
        tox: *const c_void,
        friend_number: u32,
        public_key: *mut u8,
        error: *mut i32,
    ) -> bool;
    fn tox_friend_get_connection_status(
        tox: *const c_void,
        friend_number: u32,
        error: *mut i32,
    ) -> u8;
    fn tox_friend_get_status(tox: *const c_void, friend_number: u32, error: *mut i32) -> u8;
    fn tox_friend_get_status_message_size(
        tox: *const c_void,
        friend_number: u32,
        error: *mut i32,
    ) -> usize;
    fn tox_friend_get_status_message(
        tox: *const c_void,
        friend_number: u32,
        message: *mut u8,
        error: *mut i32,
    ) -> bool;
    fn tox_self_get_status(tox: *const c_void) -> u8;
    fn tox_self_set_status(tox: *mut c_void, status: u8);
    fn tox_self_get_status_message_size(tox: *const c_void, error: *mut i32) -> usize;
    fn tox_self_get_status_message(tox: *const c_void, message: *mut u8, error: *mut i32) -> bool;
    fn tox_self_set_status_message(
        tox: *mut c_void,
        message: *const u8,
        length: usize,
        error: *mut i32,
    ) -> bool;
    fn tox_self_set_name(tox: *mut c_void, name: *const u8, length: usize, error: *mut i32)
        -> bool;
    fn tox_friend_get_name_size(tox: *const c_void, friend_number: u32, error: *mut i32) -> usize;
    fn tox_friend_get_name(
        tox: *const c_void,
        friend_number: u32,
        name: *mut u8,
        error: *mut i32,
    ) -> bool;
    fn tox_friend_send_message(
        tox: *mut c_void,
        friend_number: u32,
        message_type: i32,
        message: *const u8,
        length: usize,
        error: *mut i32,
    ) -> u32;
    fn tox_friend_send_lossless_packet(
        tox: *mut c_void,
        friend_number: u32,
        data: *const u8,
        length: usize,
        error: *mut i32,
    ) -> bool;
    fn tox_hash(hash: *mut u8, data: *const u8, length: usize) -> bool;
    fn tox_file_send(
        tox: *mut c_void,
        friend_number: u32,
        kind: u32,
        file_size: u64,
        file_id: *const u8,
        filename: *const u8,
        filename_length: usize,
        error: *mut i32,
    ) -> u32;
    fn tox_file_send_chunk(
        tox: *mut c_void,
        friend_number: u32,
        file_number: u32,
        position: u64,
        data: *const u8,
        length: usize,
        error: *mut i32,
    ) -> bool;
    fn tox_file_control(
        tox: *mut c_void,
        friend_number: u32,
        file_number: u32,
        control: i32,
        error: *mut i32,
    ) -> bool;
    fn tox_callback_file_chunk_request(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, u32, u64, usize, *mut c_void)>,
    );
    fn tox_callback_file_recv(
        tox: *mut c_void,
        callback: Option<
            unsafe extern "C" fn(*mut c_void, u32, u32, u32, u64, *const u8, usize, *mut c_void),
        >,
    );
    fn tox_callback_file_recv_chunk(
        tox: *mut c_void,
        callback: Option<
            unsafe extern "C" fn(*mut c_void, u32, u32, u64, *const u8, usize, *mut c_void),
        >,
    );
    fn tox_callback_friend_connection_status(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, u8, *mut c_void)>,
    );
    fn tox_callback_friend_name(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, *const u8, usize, *mut c_void)>,
    );
    fn tox_callback_friend_status(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, u8, *mut c_void)>,
    );
    fn tox_callback_friend_status_message(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, *const u8, usize, *mut c_void)>,
    );
    fn tox_callback_friend_request(
        tox: *mut c_void,
        callback: Option<
            unsafe extern "C" fn(*mut c_void, *const u8, *const u8, usize, *mut c_void),
        >,
    );
    fn tox_callback_friend_message(
        tox: *mut c_void,
        callback: Option<
            unsafe extern "C" fn(*mut c_void, u32, i32, *const u8, usize, *mut c_void),
        >,
    );
    fn tox_callback_friend_read_receipt(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, u32, *mut c_void)>,
    );
    fn tox_callback_friend_lossless_packet(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, *const u8, usize, *mut c_void)>,
    );
}

#[cfg(test)]
mod tox_tests {
    use super::{
        append_pq_history, apply_network_options, create_tox_handle, current_self_avatar_matches,
        get_tox_friends_snapshot, hex_upper, import_qtox_avatars, local_notifications_enabled,
        profiles, qtox_history, rebase_portable_file, resolved_bootstrap_nodes, safe_file_name,
        sanitize_untrusted_text, text_chunk_end, tox_friend_get_public_key, tox_options_free,
        tox_options_get_ipv6_enabled, tox_options_get_local_discovery_enabled,
        tox_options_get_udp_enabled, tox_options_new, tox_self_get_address,
        tox_self_get_friend_list, tox_self_get_friend_list_size, tray_image, unique_download_path,
        update_latest_pq_history, validated_download_file, CachedFriendProfile, NetworkSettings,
        PortablePaths, PqStatus, ProfilePaths, ProxySettings, TorManager, ToxMessage, ToxState,
        UnreadState, TOX_TEXT_CHUNK_BYTES, TRAY_UNREAD_SCALE_PERCENT,
    };
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Mutex},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    fn temporary_root(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kaigen-{label}-{suffix}"))
    }

    #[test]
    fn portable_paths_stay_beside_the_executable() {
        let root = temporary_root("portable-paths");
        let paths = PortablePaths::from_root(root.clone()).unwrap();
        assert_eq!(paths.downloads_dir, root.join("downloads"));
        assert!(paths.data_dir.is_dir());
        assert!(paths.downloads_dir.is_dir());
        assert!(paths.logs_dir.is_dir());
        assert!(!paths.data_dir.join("avatars").exists());
        assert!(!paths.data_dir.join("outgoing-files").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reveal_in_folder_accepts_only_portable_downloads() {
        let root = temporary_root("reveal-download");
        let paths = PortablePaths::from_root(root.clone()).unwrap();
        let received = paths.downloads_dir.join("received.txt");
        let outgoing_dir = root
            .join("data")
            .join("profiles")
            .join("test")
            .join("outgoing-files");
        fs::create_dir_all(&outgoing_dir).unwrap();
        let outgoing = outgoing_dir.join("sent.txt");
        fs::write(&received, b"received").unwrap();
        fs::write(&outgoing, b"sent").unwrap();
        assert!(validated_download_file(&paths, received.to_string_lossy().as_ref()).is_ok());
        assert!(validated_download_file(&paths, outgoing.to_string_lossy().as_ref()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn untrusted_chat_text_keeps_markup_literal_and_removes_control_bytes() {
        assert_eq!(
            sanitize_untrusted_text("<script>alert('x')</script>\0\r\nnext\u{7}"),
            "<script>alert('x')</script>\nnext"
        );
    }

    #[test]
    fn untrusted_file_names_cannot_carry_markup_paths_or_control_bytes() {
        assert_eq!(safe_file_name("../<script>alert.js\0"), "scriptalert.js");
        assert_eq!(safe_file_name("<>:\"/\\|?*\0"), "file");
    }

    #[test]
    fn profile_notifications_are_disabled_until_explicitly_enabled() {
        assert!(!local_notifications_enabled(None));
        let empty = serde_json::json!({});
        assert!(!local_notifications_enabled(Some(&empty)));
        let messages = serde_json::json!({ "notifyMessages": true });
        assert!(local_notifications_enabled(Some(&messages)));
        let requests = serde_json::json!({ "notifyRequests": true });
        assert!(local_notifications_enabled(Some(&requests)));
    }

    #[test]
    fn friend_authorization_is_persisted_in_the_contact_cache() {
        let profile = CachedFriendProfile {
            name: "Alice".to_string(),
            authorized: true,
            tox_id: "A".repeat(76),
            status_message: "Online".to_string(),
            last_online: Some(42),
        };
        let encoded = serde_json::to_vec(&profile).unwrap();
        let restored: CachedFriendProfile = serde_json::from_slice(&encoded).unwrap();
        assert!(restored.authorized);
        assert_eq!(restored.name, "Alice");
    }

    #[test]
    fn pq_history_card_keeps_one_entry_and_reaches_terminal_state() {
        let messages = Arc::new(Mutex::new(Vec::<ToxMessage>::new()));
        let offered = PqStatus {
            supported: true,
            state: "offered".to_string(),
            local_fingerprint: "LOCAL".to_string(),
            peer_fingerprint: Some("PEER".to_string()),
            fingerprint_changed: false,
            error: None,
        };
        append_pq_history(&messages, 7, &offered, "initiator", "offered", true);
        let original_id = messages.lock().unwrap()[0].id.clone();
        let active = PqStatus {
            state: "active".to_string(),
            ..offered
        };
        assert!(update_latest_pq_history(&messages, 7, &active, "active"));
        {
            let messages = messages.lock().unwrap();
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0].id, original_id);
            assert_eq!(messages[0].event.as_ref().unwrap().status, "active");
            assert!(messages[0].text.contains("успешно"));
        }
        append_pq_history(&messages, 7, &active, "initiator", "close_pending", true);
        let available = PqStatus {
            state: "available".to_string(),
            ..active
        };
        assert!(update_latest_pq_history(&messages, 7, &available, "closed"));
        let messages = messages.lock().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].event.as_ref().unwrap().status, "active");
        assert_eq!(messages[1].event.as_ref().unwrap().status, "closed");
        assert!(messages[1].text.contains("взаимному согласованию"));
    }

    #[test]
    fn shared_network_switches_reach_real_tox_options() {
        let mut error = 0_i32;
        let options = unsafe { tox_options_new(&mut error) };
        assert!(!options.is_null());
        assert_eq!(error, 0);
        let requested = NetworkSettings {
            udp_enabled: true,
            ipv6_enabled: true,
            local_discovery_enabled: true,
        };
        assert_eq!(apply_network_options(options, &requested, false), requested);
        assert!(unsafe { tox_options_get_udp_enabled(options) });
        assert!(unsafe { tox_options_get_ipv6_enabled(options) });
        assert!(unsafe { tox_options_get_local_discovery_enabled(options) });

        let proxied = apply_network_options(options, &requested, true);
        assert!(!proxied.udp_enabled);
        assert!(proxied.ipv6_enabled);
        assert!(!proxied.local_discovery_enabled);
        assert!(!unsafe { tox_options_get_udp_enabled(options) });
        assert!(unsafe { tox_options_get_ipv6_enabled(options) });
        assert!(!unsafe { tox_options_get_local_discovery_enabled(options) });
        unsafe { tox_options_free(options) };
    }

    #[test]
    fn tray_unread_digit_is_large_but_scaled_to_eighty_five_percent() {
        let base = tauri::image::Image::new_owned(vec![40_u8; 32 * 32 * 4], 32, 32);
        let rendered = tray_image(&base, "online", 1);
        let white_coordinates = rendered
            .rgba()
            .chunks_exact(4)
            .enumerate()
            .filter_map(|(index, pixel)| {
                (pixel == [255, 255, 255, 255]).then_some((index % 32, index / 32))
            })
            .collect::<Vec<_>>();
        let white_pixels = white_coordinates.len();
        assert!(
            white_pixels > 200,
            "unread digit is too small: {white_pixels} pixels"
        );
        let min_y = white_coordinates.iter().map(|(_, y)| *y).min().unwrap();
        let max_y = white_coordinates.iter().map(|(_, y)| *y).max().unwrap();
        assert_eq!(TRAY_UNREAD_SCALE_PERCENT, 85);
        assert_eq!(
            max_y - min_y + 1,
            26,
            "unread digit height must be 15% smaller"
        );
    }

    #[test]
    fn profile_unread_total_sums_every_contact() {
        let mut unread = UnreadState::default();
        unread.friends.insert("3".to_string(), 2);
        unread.friends.insert("9".to_string(), 4);
        assert_eq!(unread.total(), 6);
        assert_eq!(unread.friends.get("3"), Some(&2));
        assert_eq!(unread.friends.get("9"), Some(&4));
    }

    #[test]
    fn persisted_attachment_paths_rebase_after_a_move() {
        let portable_downloads = std::path::Path::new("portable").join("downloads");
        let rebased = rebase_portable_file(
            r#"C:\old\location\downloads\photo.png"#,
            &portable_downloads,
        );
        assert_eq!(
            std::path::PathBuf::from(rebased),
            portable_downloads.join("photo.png")
        );
    }

    #[test]
    fn duplicate_downloads_get_a_unique_name() {
        let directory = temporary_root("downloads");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("photo.png"), b"first").unwrap();
        assert_eq!(
            unique_download_path(&directory, "photo.png"),
            directory.join("photo (1).png")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unchanged_self_avatar_is_detected_before_resending() {
        let directory = temporary_root("avatar-deduplication");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("self-avatar.png"), b"same avatar").unwrap();
        assert!(current_self_avatar_matches(&directory, b"same avatar"));
        assert!(!current_self_avatar_matches(&directory, b"new avatar"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn qtox_self_avatar_is_copied_into_the_portable_profile() {
        let root = temporary_root("qtox-avatar-import");
        let qtox = root.join("qtox");
        let source_avatars = qtox.join("avatars");
        let profile_data = root.join("profile-data");
        let destination_avatars = profile_data.join("avatars");
        fs::create_dir_all(&source_avatars).unwrap();
        fs::create_dir_all(&destination_avatars).unwrap();
        let self_key = [0x2a_u8; 32];
        let bytes = b"\x89PNG\r\n\x1a\nportable-avatar";
        fs::write(
            source_avatars.join(format!("{}.png", hex_upper(&self_key))),
            bytes,
        )
        .unwrap();
        import_qtox_avatars(
            &qtox.join("Profile.tox"),
            &profile_data,
            &destination_avatars,
            &self_key,
            &HashMap::new(),
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read(destination_avatars.join("self-qtox.png")).unwrap(),
            bytes
        );
        let local_state = fs::read_to_string(profile_data.join("local-state.json")).unwrap();
        assert!(local_state.contains("data:image/png;base64,"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn long_utf8_text_is_split_without_loss() {
        let original = format!("{} {}", "Длинное сообщение 🔐 ".repeat(160), "конец");
        let mut offset = 0;
        let mut chunks = Vec::new();
        while offset < original.len() {
            let end = text_chunk_end(&original, offset);
            assert!(end > offset);
            assert!(end - offset <= TOX_TEXT_CHUNK_BYTES);
            assert!(original.is_char_boundary(end));
            chunks.push(&original[offset..end]);
            offset = end;
        }
        assert!(chunks.len() > 2);
        assert_eq!(chunks.concat(), original);
    }

    #[test]
    fn two_profiles_iterate_concurrently_with_one_network_manager() {
        let root = temporary_root("multi-profile-network");
        let global_data = root.join("data");
        let logs = global_data.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            global_data.join("tor-settings.json"),
            br#"{"enabled":false,"transport":"none","bridgeLines":""}"#,
        )
        .unwrap();
        let tor = TorManager::new(root.clone(), global_data, logs).unwrap();
        // A closed loopback SOCKS port keeps the regression test completely
        // offline and makes hostname bootstrap attempts fail immediately.
        let proxy = Arc::new(Mutex::new(ProxySettings {
            mode: "socks5".to_string(),
            host: "127.0.0.1".to_string(),
            port: 9,
            username: String::new(),
            password: String::new(),
        }));
        let network = Arc::new(Mutex::new(NetworkSettings::default()));

        let first = ToxState::new_for_profile(
            ProfilePaths::new(
                root.clone(),
                root.join("profiles/first/data"),
                root.join("profiles/first/first.tox"),
            )
            .unwrap(),
            tor.clone(),
            Arc::clone(&proxy),
            Arc::clone(&network),
            None,
            None,
            None,
            Some("First"),
        )
        .unwrap();
        let second = ToxState::new_for_profile(
            ProfilePaths::new(
                root.clone(),
                root.join("profiles/second/data"),
                root.join("profiles/second/second.tox"),
            )
            .unwrap(),
            tor,
            Arc::clone(&proxy),
            Arc::clone(&network),
            None,
            None,
            None,
            Some("Second"),
        )
        .unwrap();

        assert!(Arc::ptr_eq(&first.proxy_settings, &second.proxy_settings));
        assert!(Arc::ptr_eq(
            &first.network_settings,
            &second.network_settings
        ));
        let handle_guard = first.handle.lock().unwrap();
        let snapshot_started = Instant::now();
        let snapshot_error = match get_tox_friends_snapshot(&first) {
            Ok(_) => panic!("contact refresh unexpectedly acquired the busy Tox handle"),
            Err(error) => error,
        };
        assert_eq!(snapshot_error, "Tox profile is busy");
        assert!(
            snapshot_started.elapsed() < Duration::from_millis(50),
            "periodic contact refresh waited behind the network handle"
        );
        drop(handle_guard);

        first.start_network_loop();
        second.start_network_loop();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && (first.iterations.load(std::sync::atomic::Ordering::Relaxed) == 0
                || second.iterations.load(std::sync::atomic::Ordering::Relaxed) == 0)
        {
            thread::sleep(Duration::from_millis(20));
        }
        let first_iterations = first.iterations.load(std::sync::atomic::Ordering::Relaxed);
        let second_iterations = second.iterations.load(std::sync::atomic::Ordering::Relaxed);
        assert!(first_iterations > 0, "first profile did not iterate");
        assert!(second_iterations > 0, "second profile did not iterate");

        *proxy.lock().unwrap() = ProxySettings::default();
        let first_generation = first
            .handle_generation
            .load(std::sync::atomic::Ordering::SeqCst);
        let second_generation = second
            .handle_generation
            .load(std::sync::atomic::Ordering::SeqCst);
        let route_change_started = Instant::now();
        first.rebuild_network_route().unwrap();
        second.rebuild_network_route().unwrap();
        assert!(
            route_change_started.elapsed() < Duration::from_secs(2),
            "route rebuild waited for a network connection"
        );
        assert!(
            first
                .handle_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                > first_generation,
            "first profile did not receive the new network route"
        );
        assert!(
            second
                .handle_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                > second_generation,
            "second profile did not receive the new network route"
        );
        assert!(first.running.load(std::sync::atomic::Ordering::Relaxed));
        assert!(second.running.load(std::sync::atomic::Ordering::Relaxed));

        first.stop();
        second.stop();
        thread::sleep(Duration::from_millis(300));
        drop(first);
        drop(second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn destroyed_profile_is_not_recreated_by_the_network_worker() {
        let root = temporary_root("destroy-profile-after-network-stop");
        let global_data = root.join("data");
        let logs = global_data.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            global_data.join("tor-settings.json"),
            br#"{"enabled":false,"transport":"none","bridgeLines":""}"#,
        )
        .unwrap();
        let tor = TorManager::new(root.clone(), global_data, logs).unwrap();
        let profile_dir = root.join("profiles/doomed");
        let profile_path = profile_dir.join("Doomed.tox");
        let profile = ToxState::new_for_profile(
            ProfilePaths::new(root.clone(), profile_dir.join("data"), profile_path.clone())
                .unwrap(),
            tor,
            Arc::new(Mutex::new(ProxySettings::default())),
            Arc::new(Mutex::new(NetworkSettings::default())),
            None,
            None,
            None,
            Some("Doomed"),
        )
        .unwrap();

        profile.start_network_loop();
        profile.stop_without_save().unwrap();
        fs::remove_dir_all(&profile_dir).unwrap();
        drop(profile);
        thread::sleep(Duration::from_millis(100));

        assert!(!profile_dir.exists());
        assert!(!profile_path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bootstrap_dns_never_delays_a_profile_network_loop() {
        let started = Instant::now();
        let nodes = resolved_bootstrap_nodes(true);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "bootstrap resolution blocked the profile network loop"
        );
        assert!(nodes.len() >= 2);
        assert!(
            nodes
                .iter()
                .all(|node| node.address.parse::<std::net::IpAddr>().is_ok()),
            "toxcore received a hostname that could perform blocking DNS while its handle was locked"
        );
    }

    #[test]
    fn qtox_history_fixture_imports_when_configured() {
        let Some(directory) =
            std::env::var_os("KAIGEN_QTOX_TEST_DIR").map(std::path::PathBuf::from)
        else {
            return;
        };
        let portable_root = std::env::var_os("KAIGEN_QTOX_TEST_PORTABLE_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| directory.clone());
        let password = std::env::var("KAIGEN_QTOX_TEST_PASSWORD").unwrap_or_default();
        let profile = directory.join("Synthesis.tox");
        let history = directory.join("Synthesis.db");
        let (savedata, cipher) = profiles::read_profile(&profile, Some(&password)).unwrap();
        let temporary = std::env::temp_dir().join("kaigen-qtox-import-test.tox");
        let handle = create_tox_handle(
            temporary,
            Some(&savedata),
            None,
            &NetworkSettings::default(),
            None,
        )
        .unwrap();
        let mut address = [0_u8; 38];
        unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
        let mut public_key = [0_u8; 32];
        public_key.copy_from_slice(&address[..32]);
        let friend_count = unsafe { tox_self_get_friend_list_size(handle.instance.as_ptr()) };
        let mut friend_numbers = vec![0_u32; friend_count];
        unsafe { tox_self_get_friend_list(handle.instance.as_ptr(), friend_numbers.as_mut_ptr()) };
        let mut friends = HashMap::new();
        for friend_number in friend_numbers {
            let mut friend_key = [0_u8; 32];
            let mut error = 0_i32;
            if unsafe {
                tox_friend_get_public_key(
                    handle.instance.as_ptr(),
                    friend_number,
                    friend_key.as_mut_ptr(),
                    &mut error,
                )
            } {
                friends.insert(friend_key.to_vec(), friend_number);
            }
        }
        let rows =
            qtox_history::read_qtox_history(&history, &portable_root, Some(&password), &public_key)
                .unwrap();
        assert!(
            !rows.is_empty(),
            "the supplied qTox history contains no importable rows"
        );
        assert!(rows.iter().all(|row| !row.text.contains('\0')));
        let avatar_root = temporary_root("qtox-fixture-avatars");
        let profile_data = avatar_root.join("data");
        let avatar_output = profile_data.join("avatars");
        fs::create_dir_all(&avatar_output).unwrap();
        import_qtox_avatars(
            &profile,
            &profile_data,
            &avatar_output,
            &public_key,
            &friends,
            profiles::is_encrypted(&fs::read(&profile).unwrap()),
            cipher.as_ref(),
        )
        .unwrap();
        let local_state = fs::read(profile_data.join("local-state.json")).unwrap();
        let local_state: serde_json::Value = serde_json::from_slice(&local_state).unwrap();
        assert!(local_state
            .get("profileAvatar")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|avatar| avatar.starts_with("data:image/")));
        fs::remove_dir_all(avatar_root).unwrap();
    }
}

fn state_path(app_state: &AppState) -> Result<PathBuf, String> {
    let active_id = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?
        .active_profile_id
        .clone()
        .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
    let record = app_state.record(&active_id)?;
    Ok(app_state
        .paths_for(&record)?
        .data_dir
        .join("local-state.json"))
}

fn layout_state_path(app_state: &AppState) -> PathBuf {
    app_state.data_dir.join("layout-state.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QtoxProfileCandidate {
    name: String,
    profile_path: String,
    history_path: Option<String>,
    settings_path: Option<String>,
    encrypted: bool,
}

fn import_source_key(value: &str) -> String {
    fs::canonicalize(value)
        .unwrap_or_else(|_| PathBuf::from(value))
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

#[tauri::command]
fn get_startup_state(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
) -> Result<StartupState, String> {
    let settings = app_state
        .settings
        .lock()
        .map_err(|_| "Could not access application settings".to_string())?
        .clone();
    let profiles = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(StartupState {
        first_run: profiles.is_empty(),
        language: settings.language,
        close_to_tray: settings.close_to_tray,
        profiles,
    })
}

#[tauri::command]
fn set_app_language(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    tray_items: tauri::State<'_, TrayMenuItems>,
    language: String,
) -> Result<String, String> {
    if language != "ru" && language != "en" {
        return Err("UNSUPPORTED_LANGUAGE".to_string());
    }
    app_state
        .settings
        .lock()
        .map_err(|_| "Could not access application settings".to_string())?
        .language = language.clone();
    app_state.save_settings()?;
    tray_items.apply_language(&language);
    update_tray(&app, &app_state);
    Ok(language)
}

#[tauri::command]
fn set_close_to_tray(app_state: tauri::State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    app_state
        .settings
        .lock()
        .map_err(|_| "Could not access application settings".to_string())?
        .close_to_tray = enabled;
    app_state.save_settings()?;
    Ok(enabled)
}

#[tauri::command]
fn unlock_profile(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    profile_id: String,
    password: String,
) -> Result<Vec<ProfileSummary>, String> {
    let record = app_state.record(&profile_id)?;
    if !record.enabled {
        return Err("PROFILE_DISABLED_REIMPORT_REQUIRED".to_string());
    }
    app_state.load_record(&record, Some(&password))?;
    let summaries = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(summaries)
}

#[tauri::command]
fn continue_with_loaded_profiles(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
) -> Result<Vec<ProfileSummary>, String> {
    let loaded_ids: HashSet<String> = app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .keys()
        .cloned()
        .collect();
    let mut registry = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?;
    registry.prefer_loaded_active(&loaded_ids);
    registry.save(&app_state.data_dir)?;
    drop(registry);
    let summaries = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(summaries)
}

#[tauri::command]
fn disable_profile(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<ProfileSummary>, String> {
    let record = app_state.record(&profile_id)?;
    if !record.enabled {
        return Err("PROFILE_ALREADY_DISABLED".to_string());
    }

    let remaining_loaded_ids = app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .keys()
        .filter(|loaded_id| *loaded_id != &profile_id)
        .cloned()
        .collect::<HashSet<_>>();

    let mut stored_registry = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?;
    let mut registry = stored_registry.clone();
    if !registry.disable_profile(&profile_id, &remaining_loaded_ids) {
        return Err("PROFILE_ALREADY_DISABLED".to_string());
    }
    registry.save(&app_state.data_dir)?;
    *stored_registry = registry;
    drop(stored_registry);

    if let Some(profile) = app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .remove(&profile_id)
    {
        profile.stop();
    }
    if let Ok(mut errors) = app_state.load_errors.lock() {
        errors.remove(&profile_id);
    }
    let summaries = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(summaries)
}

#[tauri::command]
fn switch_profile(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<ProfileSummary>, String> {
    if !app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .contains_key(&profile_id)
    {
        return Err("PROFILE_LOCKED".to_string());
    }
    let mut registry = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?;
    if !registry
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err("PROFILE_NOT_FOUND".to_string());
    }
    registry.active_profile_id = Some(profile_id);
    registry.save(&app_state.data_dir)?;
    drop(registry);
    update_tray(&app, &app_state);
    app_state.summaries()
}

#[tauri::command]
fn get_unread_state(app_state: tauri::State<'_, AppState>) -> Result<UnreadState, String> {
    let active = app_state.active()?;
    let state = active
        .unread_state
        .lock()
        .map_err(|_| "Could not access unread events".to_string())?
        .clone();
    Ok(state)
}

#[tauri::command]
fn mark_friend_read(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<(), String> {
    let active = app_state.active()?;
    active
        .unread_state
        .lock()
        .map_err(|_| "Could not access unread events".to_string())?
        .friends
        .remove(&friend_number.to_string());
    persist_unread_state(&active.unread_state, &active.unread_state_path);
    update_tray(&app, &app_state);
    Ok(())
}

#[tauri::command]
fn mark_requests_read(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let active = app_state.active()?;
    active
        .unread_state
        .lock()
        .map_err(|_| "Could not access unread events".to_string())?
        .requests
        .clear();
    persist_unread_state(&active.unread_state, &active.unread_state_path);
    update_tray(&app, &app_state);
    Ok(())
}

#[tauri::command]
fn create_profile(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    name: String,
    password: Option<String>,
) -> Result<Vec<ProfileSummary>, String> {
    let mut registry = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?
        .clone();
    let mut record = profiles::create_record(&app_state.root_dir, &registry, &name)?;
    let cipher = password
        .as_deref()
        .filter(|password| !password.is_empty())
        .map(ProfileCipher::new)
        .transpose()?;
    record.encrypted = cipher.is_some();
    let paths = ProfilePaths::new(
        app_state.root_dir.clone(),
        app_state.root_dir.join(&record.data_directory),
        app_state.root_dir.join(&record.file),
    )?;
    let tox = Arc::new(ToxState::new_for_profile(
        paths,
        app_state.tor.clone(),
        Arc::clone(&app_state.proxy_settings),
        Arc::clone(&app_state.network_settings),
        app_state.updates_for(&record.id),
        None,
        cipher,
        Some(&name),
    )?);
    app_state.allow_profile_media(&tox)?;
    tox.start_network_loop();
    app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .insert(record.id.clone(), tox);
    registry.active_profile_id = Some(record.id.clone());
    registry.profiles.push(record);
    registry.save(&app_state.data_dir)?;
    *app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())? = registry;
    let summaries = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(summaries)
}

fn collect_qtox_candidates(directory: &Path, candidates: &mut Vec<QtoxProfileCandidate>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect_qtox_candidates(&path, candidates);
            continue;
        }
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("tox"))
        {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("qTox profile");
        let sibling = |extension: &str| {
            let candidate = path.with_extension(extension);
            candidate
                .is_file()
                .then(|| candidate.to_string_lossy().into_owned())
        };
        #[cfg(target_os = "windows")]
        let history_path = sibling("db");
        #[cfg(not(target_os = "windows"))]
        let history_path = None;
        candidates.push(QtoxProfileCandidate {
            name: stem.to_string(),
            profile_path: path.to_string_lossy().into_owned(),
            history_path,
            settings_path: sibling("ini"),
            encrypted: profiles::file_is_encrypted(&path).unwrap_or(false),
        });
    }
}

#[tauri::command]
fn discover_qtox_profiles(location: Option<String>) -> Vec<QtoxProfileCandidate> {
    let mut directories = Vec::new();
    if let Some(location) = location.filter(|value| !value.trim().is_empty()) {
        directories.push(PathBuf::from(location));
    } else {
        #[cfg(target_os = "windows")]
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let appdata = PathBuf::from(appdata);
            directories.push(appdata.join("tox"));
            directories.push(appdata.join("qTox"));
        }
        #[cfg(target_os = "linux")]
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            directories.push(home.join(".config/tox"));
            directories.push(home.join(".config/qTox"));
            directories.push(home.join(".local/share/qTox"));
        }
        #[cfg(target_os = "macos")]
        if let Some(home) = std::env::var_os("HOME") {
            let application_support = PathBuf::from(home).join("Library/Application Support");
            directories.push(application_support.join("tox"));
            directories.push(application_support.join("qTox"));
        }
    }
    let mut candidates = Vec::new();
    for directory in directories {
        collect_qtox_candidates(&directory, &mut candidates);
    }
    candidates.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    candidates.dedup_by(|left, right| left.profile_path.eq_ignore_ascii_case(&right.profile_path));
    candidates
}

fn hex_upper(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn qtox_avatar_name(owner_key: &[u8], self_key: &[u8], encrypted: bool) -> Option<String> {
    let owner_hex = hex_upper(owner_key);
    if !encrypted {
        return Some(format!("{owner_hex}.png"));
    }
    let mut mac = <Blake2bMac<U32> as KeyInit>::new_from_slice(self_key).ok()?;
    Mac::update(&mut mac, owner_hex.as_bytes());
    Some(format!("{}.png", hex_upper(&mac.finalize().into_bytes())))
}

fn imported_avatar_bytes(
    avatar_directory: &Path,
    owner_key: &[u8],
    self_key: &[u8],
    encrypted_profile: bool,
    cipher: Option<&ProfileCipher>,
) -> Option<Vec<u8>> {
    let mut names = Vec::new();
    if let Some(name) = qtox_avatar_name(owner_key, self_key, encrypted_profile) {
        names.push(name);
    }
    let plain_name = qtox_avatar_name(owner_key, self_key, false)?;
    if !names.contains(&plain_name) {
        names.push(plain_name);
    }
    names.into_iter().find_map(|name| {
        let bytes = fs::read(avatar_directory.join(name)).ok()?;
        let decoded = if profiles::is_encrypted(&bytes) {
            cipher?.decrypt(&bytes).ok()?
        } else {
            bytes
        };
        let image = decoded.starts_with(b"\x89PNG\r\n\x1a\n")
            || decoded.starts_with(b"\xff\xd8\xff")
            || decoded.starts_with(b"RIFF") && decoded.get(8..12) == Some(b"WEBP");
        image.then_some(decoded)
    })
}

fn import_qtox_avatars(
    source_profile: &Path,
    profile_data_dir: &Path,
    avatars_dir: &Path,
    self_key: &[u8; 32],
    friends: &HashMap<Vec<u8>, u32>,
    encrypted_profile: bool,
    cipher: Option<&ProfileCipher>,
) -> Result<(), String> {
    let Some(source_directory) = source_profile.parent().map(|path| path.join("avatars")) else {
        return Ok(());
    };
    if !source_directory.is_dir() {
        return Ok(());
    }
    if let Some(bytes) = imported_avatar_bytes(
        &source_directory,
        self_key,
        self_key,
        encrypted_profile,
        cipher,
    ) {
        for entry in fs::read_dir(avatars_dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            if entry.file_name().to_string_lossy().starts_with("self-") {
                let _ = fs::remove_file(entry.path());
            }
        }
        atomic_write(&avatars_dir.join("self-qtox.png"), &bytes)?;
        let mime = if bytes.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else if bytes.starts_with(b"RIFF") {
            "image/webp"
        } else {
            "image/png"
        };
        let local_state_path = profile_data_dir.join("local-state.json");
        let mut local_state = fs::read(&local_state_path)
            .ok()
            .and_then(|value| serde_json::from_slice::<Value>(&value).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Default::default()));
        if let Some(object) = local_state.as_object_mut() {
            object.insert(
                "profileAvatar".to_string(),
                Value::String(format!("data:{mime};base64,{}", base64_basic(&bytes))),
            );
        }
        atomic_write(
            &local_state_path,
            &serde_json::to_vec_pretty(&local_state)
                .map_err(|error| format!("Could not encode the imported avatar: {error}"))?,
        )?;
    }
    for (owner_key, friend_number) in friends {
        let Some(bytes) = imported_avatar_bytes(
            &source_directory,
            owner_key,
            self_key,
            encrypted_profile,
            cipher,
        ) else {
            continue;
        };
        remove_friend_avatars(avatars_dir, *friend_number, None);
        atomic_write(
            &avatars_dir.join(format!("{friend_number}-qtox-avatar.png")),
            &bytes,
        )?;
    }
    Ok(())
}

fn import_qtox_profile_blocking(
    app: tauri::AppHandle,
    app_state: AppState,
    profile_path: String,
    history_path: Option<String>,
    password: Option<String>,
) -> Result<Vec<ProfileSummary>, String> {
    let source = PathBuf::from(&profile_path);
    let history_source = history_path
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    if !source.is_file() {
        return Err("QTOX_PROFILE_NOT_FOUND".to_string());
    }
    let disk_data =
        fs::read(&source).map_err(|error| format!("Could not read the qTox profile: {error}"))?;
    let encrypted = profiles::is_encrypted(&disk_data);
    let (savedata, cipher) = if encrypted {
        let password = password
            .as_deref()
            .ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?;
        let cipher = ProfileCipher::unlock(&disk_data, password)?;
        (cipher.decrypt(&disk_data)?, Some(cipher))
    } else {
        (disk_data.clone(), None)
    };
    let name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported qTox profile")
        .to_string();
    let mut registry = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?
        .clone();
    let source_key = import_source_key(&profile_path);
    if registry.profiles.iter().any(|record| {
        record.enabled
            && record
                .imported_from
                .as_deref()
                .is_some_and(|value| import_source_key(value) == source_key)
    }) {
        return Err("QTOX_PROFILE_ALREADY_IMPORTED".to_string());
    }
    let replaced_records = registry
        .profiles
        .iter()
        .filter(|record| {
            !record.enabled
                && record
                    .imported_from
                    .as_deref()
                    .is_some_and(|value| import_source_key(value) == source_key)
        })
        .cloned()
        .collect::<Vec<_>>();
    let replaced_ids = replaced_records
        .iter()
        .map(|record| record.id.clone())
        .collect::<HashSet<_>>();
    let mut record = profiles::create_record(&app_state.root_dir, &registry, &name)?;
    record.encrypted = encrypted;
    record.imported_from = Some(profile_path);
    let paths = ProfilePaths::new(
        app_state.root_dir.clone(),
        app_state.root_dir.join(&record.data_directory),
        app_state.root_dir.join(&record.file),
    )?;
    let profile_data_dir = paths.data_dir.clone();
    let avatar_cipher = cipher.clone();
    atomic_write(&paths.profile_path, &disk_data)?;
    let import_directory = paths.data_dir.join("qtox-import");
    fs::create_dir_all(&import_directory)
        .map_err(|error| format!("Could not create qTox import directory: {error}"))?;
    if let Some(history) = history_source.as_ref() {
        fs::copy(&history, import_directory.join("history.db"))
            .map_err(|error| format!("Could not copy qTox history: {error}"))?;
    }
    let settings_source = source.with_extension("ini");
    if settings_source.is_file() {
        let _ = fs::copy(settings_source, import_directory.join("profile.ini"));
    }
    let tox = Arc::new(ToxState::new_for_profile(
        paths,
        app_state.tor.clone(),
        Arc::clone(&app_state.proxy_settings),
        Arc::clone(&app_state.network_settings),
        app_state.updates_for(&record.id),
        Some(savedata),
        cipher,
        None,
    )?);
    let (self_key, friends) = {
        let state = tox
            .handle
            .lock()
            .map_err(|_| "Could not access the imported Tox profile".to_string())?;
        let instance = state
            .as_ref()
            .ok_or_else(|| "The imported Tox profile was not initialized".to_string())?;
        let mut address = [0_u8; 38];
        unsafe { tox_self_get_address(instance.instance.as_ptr(), address.as_mut_ptr()) };
        let mut self_key = [0_u8; 32];
        self_key.copy_from_slice(&address[..32]);
        let count = unsafe { tox_self_get_friend_list_size(instance.instance.as_ptr()) };
        let mut numbers = vec![0_u32; count];
        unsafe { tox_self_get_friend_list(instance.instance.as_ptr(), numbers.as_mut_ptr()) };
        let mut friends = HashMap::<Vec<u8>, u32>::new();
        for number in numbers {
            let mut key = [0_u8; 32];
            let mut error = 0_i32;
            if unsafe {
                tox_friend_get_public_key(
                    instance.instance.as_ptr(),
                    number,
                    key.as_mut_ptr(),
                    &mut error,
                )
            } {
                friends.insert(key.to_vec(), number);
            }
        }
        (self_key, friends)
    };
    import_qtox_avatars(
        &source,
        &profile_data_dir,
        &tox.avatars_dir,
        &self_key,
        &friends,
        encrypted,
        avatar_cipher.as_ref(),
    )?;
    if let Some(history) = history_source.as_ref() {
        let imported = qtox_history::read_qtox_history(
            history,
            &app_state.root_dir,
            password.as_deref(),
            &self_key,
        )?;
        let mut converted = Vec::new();
        for row in imported {
            let Some(friend_number) = friends.get(&row.chat_key).copied() else {
                continue;
            };
            let attachment = row.file_name.as_ref().map(|file_name| {
                let file_name = safe_file_name(file_name);
                let source_path = row.file_path.as_ref().map(PathBuf::from);
                let portable_path =
                    source_path
                        .as_ref()
                        .filter(|path| path.is_file())
                        .and_then(|path| {
                            let destination = unique_download_path(&tox.downloads_dir, &file_name);
                            fs::copy(path, &destination).ok().map(|_| destination)
                        });
                ToxAttachment {
                    name: file_name.clone(),
                    size: row.file_size,
                    mime: "application/octet-stream".to_string(),
                    path: portable_path
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    image: is_image_name(&file_name),
                    transferred: row.file_size,
                    speed_bytes_per_sec: 0,
                    eta_seconds: None,
                    transfer_state: "complete".to_string(),
                    completed: true,
                    completed_at: Some((row.timestamp_ms.max(0) as u64) / 1000),
                    transfer_error: None,
                    retry_count: 0,
                }
            });
            converted.push(ToxMessage {
                id: format!("qtox-{}", row.source_id),
                friend_number,
                text: sanitize_untrusted_text(&row.text),
                mine: row.sender_key == self_key,
                timestamp: (row.timestamp_ms.max(0) as u64) / 1000,
                delivery: "delivered".to_string(),
                delivered_at: Some((row.timestamp_ms.max(0) as u64) / 1000),
                attachment,
                event: None,
            });
        }
        if !converted.is_empty() {
            let mut messages = tox
                .messages
                .lock()
                .map_err(|_| "Could not import qTox messages".to_string())?;
            messages.extend(converted);
            messages.sort_by_key(|message| message.timestamp);
            let serialized = serde_json::to_vec(&*messages)
                .map_err(|error| format!("Could not encode imported qTox history: {error}"))?;
            atomic_write(&tox.history_path, &serialized)?;
            bump_history_revision(&tox.history_path);
        }
    }
    app_state.allow_profile_media(&tox)?;
    tox.start_network_loop();
    app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .insert(record.id.clone(), tox);
    registry
        .profiles
        .retain(|existing| !replaced_ids.contains(&existing.id));
    registry.active_profile_id = Some(record.id.clone());
    registry.profiles.push(record);
    registry.save(&app_state.data_dir)?;
    *app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())? = registry;
    for replaced in replaced_records {
        if let Ok(paths) = app_state.paths_for(&replaced) {
            if let Some(directory) = paths.profile_path.parent() {
                let profiles_root = app_state.root_dir.join("profiles");
                if directory.starts_with(&profiles_root)
                    && directory != profiles_root
                    && directory.is_dir()
                {
                    let _ = fs::remove_dir_all(directory);
                }
            }
        }
    }
    let summaries = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(summaries)
}

#[tauri::command]
async fn import_qtox_profile(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    profile_path: String,
    history_path: Option<String>,
    password: Option<String>,
) -> Result<Vec<ProfileSummary>, String> {
    let owned_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_qtox_profile_blocking(app, owned_state, profile_path, history_path, password)
    })
    .await
    .map_err(|error| format!("The qTox import worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn change_profile_password(
    app_state: tauri::State<'_, AppState>,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<Vec<ProfileSummary>, String> {
    let owned_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        change_profile_password_blocking(owned_state, current_password, new_password)
    })
    .await
    .map_err(|error| format!("The profile password worker stopped unexpectedly: {error}"))?
}

fn change_profile_password_blocking(
    app_state: AppState,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<Vec<ProfileSummary>, String> {
    let active_id = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?
        .active_profile_id
        .clone()
        .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
    let record = app_state.record(&active_id)?;
    let paths = app_state.paths_for(&record)?;
    if record.encrypted {
        let bytes = fs::read(&paths.profile_path)
            .map_err(|error| format!("Could not read the encrypted profile: {error}"))?;
        ProfileCipher::unlock(
            &bytes,
            current_password
                .as_deref()
                .ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?,
        )?;
    }
    let cipher = new_password
        .as_deref()
        .filter(|password| !password.is_empty())
        .map(ProfileCipher::new)
        .transpose()?;
    let state = app_state.active()?;
    let mut handle_guard = state
        .handle
        .lock()
        .map_err(|_| "Could not access the active Tox profile".to_string())?;
    let handle = handle_guard
        .as_mut()
        .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
    let previous_cipher = std::mem::replace(&mut handle.cipher, cipher);
    if let Err(error) = ToxState::save(handle) {
        handle.cipher = previous_cipher;
        return Err(error);
    }
    let mut registry = match app_state.registry.lock() {
        Ok(registry) => registry,
        Err(_) => {
            handle.cipher = previous_cipher;
            let rollback = ToxState::save(handle);
            return Err(match rollback {
                Ok(()) => "Could not access the profile registry".to_string(),
                Err(error) => format!(
                    "Could not access the profile registry; profile rollback also failed: {error}"
                ),
            });
        }
    };
    let previous_encrypted = match registry
        .profiles
        .iter_mut()
        .find(|record| record.id == active_id)
    {
        Some(record) => {
            let previous = record.encrypted;
            record.encrypted = handle.cipher.is_some();
            previous
        }
        None => {
            drop(registry);
            handle.cipher = previous_cipher;
            let rollback = ToxState::save(handle);
            return Err(match rollback {
                Ok(()) => "ACTIVE_PROFILE_NOT_REGISTERED".to_string(),
                Err(error) => {
                    format!("ACTIVE_PROFILE_NOT_REGISTERED; profile rollback also failed: {error}")
                }
            });
        }
    };
    if let Err(error) = registry.save(&app_state.data_dir) {
        if let Some(record) = registry
            .profiles
            .iter_mut()
            .find(|record| record.id == active_id)
        {
            record.encrypted = previous_encrypted;
        }
        drop(registry);
        handle.cipher = previous_cipher;
        let rollback = ToxState::save(handle);
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; profile rollback also failed: {rollback_error}")
            }
        });
    }
    drop(registry);
    drop(handle_guard);
    app_state.summaries()
}

#[tauri::command]
fn destroy_active_profile(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
) -> Result<Vec<ProfileSummary>, String> {
    let active_id = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?
        .active_profile_id
        .clone()
        .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
    let record = app_state.record(&active_id)?;
    let imported_source = record.imported_from.as_deref().map(import_source_key);
    let records_to_destroy = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?
        .profiles
        .iter()
        .filter(|candidate| {
            candidate.id == active_id
                || imported_source.as_ref().is_some_and(|source| {
                    candidate
                        .imported_from
                        .as_deref()
                        .is_some_and(|value| import_source_key(value) == *source)
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    let destroyed_ids = records_to_destroy
        .iter()
        .map(|record| record.id.clone())
        .collect::<HashSet<_>>();
    {
        let mut loaded = app_state
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?;
        for profile_id in &destroyed_ids {
            if let Some(state) = loaded.remove(profile_id) {
                state.stop_without_save()?;
            }
        }
    }
    let profiles_root = app_state.root_dir.join("profiles");
    for doomed in &records_to_destroy {
        let profile_path = app_state.paths_for(doomed)?.profile_path;
        let profile_parent = profile_path.parent().unwrap_or(&app_state.root_dir);
        if profile_parent.starts_with(&profiles_root)
            && profile_parent != profiles_root
            && profile_parent.is_dir()
        {
            fs::remove_dir_all(profile_parent)
                .map_err(|error| format!("Could not remove active profile data: {error}"))?;
        }
    }
    let loaded_ids: HashSet<String> = app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .keys()
        .cloned()
        .collect();
    let mut registry = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?;
    registry
        .profiles
        .retain(|profile| !destroyed_ids.contains(&profile.id));
    registry.active_profile_id = registry
        .profiles
        .iter()
        .find(|profile| profile.enabled && loaded_ids.contains(&profile.id))
        .or_else(|| registry.profiles.iter().find(|profile| profile.enabled))
        .map(|profile| profile.id.clone());
    registry.save(&app_state.data_dir)?;
    drop(registry);
    if let Ok(mut errors) = app_state.load_errors.lock() {
        errors.retain(|profile_id, _| !destroyed_ids.contains(profile_id));
    }
    let summaries = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(summaries)
}

#[tauri::command]
fn load_local_state(app_state: tauri::State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = state_path(&app_state)?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Не удалось прочитать локальные данные: {error}"))?;
    let state = serde_json::from_str(&contents)
        .map_err(|error| format!("Локальные данные повреждены: {error}"))?;

    Ok(Some(state))
}

#[tauri::command]
fn save_local_state(app_state: tauri::State<'_, AppState>, state: Value) -> Result<(), String> {
    let path = state_path(&app_state)?;
    let serialized = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("Не удалось подготовить локальные данные: {error}"))?;

    atomic_write(&path, serialized.as_bytes())
        .map_err(|error| format!("Не удалось сохранить локальные данные: {error}"))
}

#[tauri::command]
fn set_profile_avatar(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    profile_id: String,
    data_url: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<Vec<ProfileSummary>, String> {
    if !data_url.starts_with("data:image/") {
        return Err("Выбранный файл не является изображением".to_string());
    }
    let record = app_state.record(&profile_id)?;
    let tox_state = app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| "PROFILE_LOCKED".to_string())?;
    let path = app_state
        .paths_for(&record)?
        .data_dir
        .join("local-state.json");
    let mut local_state = fs::read(&path)
        .ok()
        .and_then(|contents| serde_json::from_slice::<Value>(&contents).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    let object = local_state
        .as_object_mut()
        .ok_or_else(|| "Локальные данные профиля повреждены".to_string())?;
    object.insert("profileAvatar".to_string(), Value::String(data_url));
    let serialized = serde_json::to_vec_pretty(&local_state)
        .map_err(|error| format!("Не удалось подготовить локальные данные: {error}"))?;
    atomic_write(&path, &serialized)
        .map_err(|error| format!("Не удалось сохранить локальные данные: {error}"))?;
    send_tox_avatar_for_state(&tox_state, filename, bytes)?;
    if let Some(updates) = &tox_state.updates {
        updates.changed();
    }
    let summaries = app_state.summaries()?;
    update_tray(&app, &app_state);
    Ok(summaries)
}

#[tauri::command]
fn load_layout_state(app_state: tauri::State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = layout_state_path(&app_state);
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read the shared interface layout: {error}"))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("The shared interface layout is invalid: {error}"))
}

#[tauri::command]
fn save_layout_state(app_state: tauri::State<'_, AppState>, state: Value) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("Could not encode the shared interface layout: {error}"))?;
    atomic_write(&layout_state_path(&app_state), &serialized)
        .map_err(|error| format!("Could not save the shared interface layout: {error}"))
}

#[tauri::command]
fn get_tox_id(app_state: tauri::State<'_, AppState>) -> Result<String, String> {
    let tox_state = app_state.active()?;
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;

    let mut address = [0_u8; 38];
    unsafe { tox_self_get_address(instance.instance.as_ptr(), address.as_mut_ptr()) };
    ToxState::save(instance)?;
    Ok(address.iter().map(|byte| format!("{byte:02X}")).collect())
}

fn parse_tox_id(value: &str) -> Result<[u8; 38], String> {
    let compact: String = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if compact.len() != 76 || !compact.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Tox ID должен содержать 76 шестнадцатеричных символов".to_string());
    }

    let mut address = [0_u8; 38];
    for (index, byte) in address.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&compact[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Некорректный Tox ID".to_string())?;
    }
    Ok(address)
}

#[tauri::command]
fn add_tox_friend(
    app_state: tauri::State<'_, AppState>,
    tox_id: String,
    message: String,
) -> Result<u32, String> {
    let tox_state = app_state.active()?;
    let address = parse_tox_id(&tox_id)?;
    let message = if message.trim().is_empty() {
        "Привет! Добавь меня, пожалуйста."
    } else {
        message.trim()
    };

    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
    let mut error = 0_i32;
    let friend_number = unsafe {
        tox_friend_add(
            instance.instance.as_ptr(),
            address.as_ptr(),
            message.as_bytes().as_ptr(),
            message.len(),
            &mut error,
        )
    };
    log_network(&tox_state.network_log_path, format!("FRIEND_ADD_REQUEST result_friend={friend_number} error={error} message_bytes={} fingerprint={}", message.len(), event_fingerprint(message.as_bytes())));
    if error != 0 {
        let message = match error {
            2 => "Сообщение для авторизации слишком длинное",
            3 => "Нужно указать сообщение для авторизации",
            4 => "Нельзя добавить собственный Tox ID",
            5 => "Запрос уже был отправлен или контакт уже добавлен",
            6 => "Tox ID не прошёл проверку контрольной суммы",
            7 => "У этого контакта изменился no-spam идентификатор; обновите Tox ID",
            8 => "Не удалось выделить память для нового контакта",
            _ => "Не удалось отправить запрос авторизации Tox",
        };
        return Err(message.to_string());
    }
    let public_key = address[..32]
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    if let Ok(mut cache) = tox_state.friend_cache.lock() {
        cache.entry(public_key).or_default().tox_id = tox_id
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
            .to_uppercase();
        if let Ok(serialized) = serde_json::to_vec(&*cache) {
            let _ = atomic_write(&tox_state.friend_cache_path, &serialized);
        }
    }
    ToxState::save(instance)?;
    Ok(friend_number)
}

#[tauri::command]
async fn get_tox_friends(app_state: tauri::State<'_, AppState>) -> Result<Vec<ToxFriend>, String> {
    let app_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_tox_friends_blocking(&app_state))
        .await
        .map_err(|error| format!("Tox contact refresh task failed: {error}"))?
}

fn get_tox_friends_blocking(app_state: &AppState) -> Result<Vec<ToxFriend>, String> {
    let tox_state = app_state.active()?;
    get_tox_friends_snapshot(&tox_state)
}

fn get_tox_friends_snapshot(tox_state: &ToxState) -> Result<Vec<ToxFriend>, String> {
    let last_events = tox_state
        .messages
        .lock()
        .map_err(|_| "Не удалось прочитать историю событий".to_string())?
        .iter()
        .fold(HashMap::<u32, u64>::new(), |mut events, message| {
            let entry = events.entry(message.friend_number).or_default();
            *entry = (*entry).max(message.timestamp);
            events
        });
    // When deliberately disconnected, toxcore can still hold an old connection
    // value. Never expose that stale value as a live contact presence.
    let network_enabled =
        tox_state.network_enabled.load(Ordering::Relaxed) && tox_state.tor.is_ready();
    // This is a periodic UI snapshot. If toxcore is in the middle of an
    // iteration or a route replacement, keep the previous frontend snapshot
    // and retry on the next tick instead of waiting behind the network.
    let state = tox_state.handle.try_lock().map_err(|error| match error {
        std::sync::TryLockError::WouldBlock => "Tox profile is busy".to_string(),
        std::sync::TryLockError::Poisoned(_) => {
            "Не удалось получить доступ к профилю Tox".to_string()
        }
    })?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
    let count = unsafe { tox_self_get_friend_list_size(instance.instance.as_ptr()) };
    let mut numbers = vec![0_u32; count];
    unsafe { tox_self_get_friend_list(instance.instance.as_ptr(), numbers.as_mut_ptr()) };

    let mut friends = Vec::with_capacity(count);
    for number in numbers {
        let mut key = [0_u8; 32];
        let mut error = 0_i32;
        if !unsafe {
            tox_friend_get_public_key(
                instance.instance.as_ptr(),
                number,
                key.as_mut_ptr(),
                &mut error,
            )
        } {
            continue;
        }
        let connection = if network_enabled {
            match unsafe {
                tox_friend_get_connection_status(instance.instance.as_ptr(), number, &mut error)
            } {
                1 | 2 => "online",
                _ => "offline",
            }
            .to_string()
        } else {
            "offline".to_string()
        };
        error = 0;
        let raw_status =
            unsafe { tox_friend_get_status(instance.instance.as_ptr(), number, &mut error) };
        let status = if connection == "offline" {
            "offline"
        } else if raw_status == 0 {
            "online"
        } else if raw_status == 1 {
            "away"
        } else {
            "busy"
        }
        .to_string();
        let name_size =
            unsafe { tox_friend_get_name_size(instance.instance.as_ptr(), number, &mut error) };
        let received_name = if error == 0 && name_size > 0 {
            let mut bytes = vec![0_u8; name_size];
            error = 0;
            if unsafe {
                tox_friend_get_name(
                    instance.instance.as_ptr(),
                    number,
                    bytes.as_mut_ptr(),
                    &mut error,
                )
            } {
                sanitize_untrusted_text(&String::from_utf8_lossy(&bytes))
                    .trim()
                    .to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let public_key = key
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        let name = if received_name.trim().is_empty() {
            tox_state
                .friend_cache
                .lock()
                .ok()
                .and_then(|cache| cache.get(&public_key).map(|profile| profile.name.clone()))
                .unwrap_or_default()
        } else {
            if let Ok(mut cache) = tox_state.friend_cache.lock() {
                let entry = cache.entry(public_key.clone()).or_default();
                if entry.name != received_name {
                    entry.name = received_name.clone();
                    if let Ok(serialized) = serde_json::to_vec(&*cache) {
                        let _ = atomic_write_sender().try_send(AtomicWriteRequest {
                            path: tox_state.friend_cache_path.clone(),
                            bytes: serialized,
                        });
                    }
                }
            }
            received_name
        };
        let name = sanitize_untrusted_text(&name);
        error = 0;
        let status_size = unsafe {
            tox_friend_get_status_message_size(instance.instance.as_ptr(), number, &mut error)
        };
        let received_status_message = if error == 0 && status_size > 0 {
            let mut bytes = vec![0_u8; status_size];
            error = 0;
            if unsafe {
                tox_friend_get_status_message(
                    instance.instance.as_ptr(),
                    number,
                    bytes.as_mut_ptr(),
                    &mut error,
                )
            } {
                sanitize_untrusted_text(&String::from_utf8_lossy(&bytes))
                    .trim()
                    .to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let status_message = if !received_status_message.is_empty() || connection == "online" {
            if let Ok(mut cache) = tox_state.friend_cache.lock() {
                let entry = cache.entry(public_key.clone()).or_default();
                let mut changed = false;
                if !name.trim().is_empty() && entry.name != name {
                    entry.name = name.clone();
                    changed = true;
                }
                if entry.status_message != received_status_message {
                    entry.status_message = received_status_message.clone();
                    changed = true;
                }
                if changed {
                    if let Ok(serialized) = serde_json::to_vec(&*cache) {
                        let _ = atomic_write_sender().try_send(AtomicWriteRequest {
                            path: tox_state.friend_cache_path.clone(),
                            bytes: serialized,
                        });
                    }
                }
            }
            received_status_message
        } else {
            tox_state
                .friend_cache
                .lock()
                .ok()
                .and_then(|cache| {
                    cache
                        .get(&public_key)
                        .map(|profile| profile.status_message.clone())
                })
                .unwrap_or_default()
        };
        let status_message = sanitize_untrusted_text(&status_message);
        let avatar_prefix = format!("{number}-");
        let avatar_path = fs::read_dir(&tox_state.avatars_dir)
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(&avatar_prefix)
                            && !entry.file_name().to_string_lossy().ends_with(".part")
                            && is_complete_avatar(&entry.path(), None)
                    })
                    .filter_map(|entry| {
                        entry.metadata().ok().and_then(|metadata| {
                            metadata
                                .modified()
                                .ok()
                                .map(|modified| (modified, entry.path()))
                        })
                    })
                    .max_by_key(|(modified, _)| *modified)
                    .map(|(_, path)| path.to_string_lossy().into_owned())
            });
        let last_online = tox_state.friend_cache.lock().ok().and_then(|cache| {
            cache
                .get(&public_key)
                .and_then(|profile| profile.last_online)
        });
        let cached_tox_id = tox_state
            .friend_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&public_key).map(|profile| profile.tox_id.clone()))
            .filter(|tox_id| !tox_id.is_empty())
            .unwrap_or_else(|| public_key.clone());
        let authorized = tox_state
            .friend_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&public_key).map(|profile| profile.authorized))
            .unwrap_or(false);
        let last_event = last_events.get(&number).copied();
        friends.push(ToxFriend {
            number,
            public_key,
            tox_id: cached_tox_id,
            authorized,
            connection,
            name,
            status,
            status_message,
            avatar_path,
            last_online,
            last_event,
        });
    }
    Ok(friends)
}

#[tauri::command]
fn set_tox_nickname(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    nickname: String,
) -> Result<(), String> {
    let tox_state = app_state.active()?;
    let nickname = nickname.trim();
    if nickname.len() > 128 {
        return Err("Ник Tox не может быть длиннее 128 байт".to_string());
    }
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
    let mut error = 0_i32;
    let bytes = nickname.as_bytes();
    if !unsafe {
        tox_self_set_name(
            instance.instance.as_ptr(),
            bytes.as_ptr(),
            bytes.len(),
            &mut error,
        )
    } {
        return Err(format!("Не удалось установить ник Tox (код {error})"));
    }
    ToxState::save(instance)?;
    drop(state);
    let active_id = app_state
        .registry
        .lock()
        .map_err(|_| "Could not access the profile registry".to_string())?
        .active_profile_id
        .clone();
    if let Some(active_id) = active_id {
        let mut registry = app_state
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?;
        if let Some(record) = registry
            .profiles
            .iter_mut()
            .find(|record| record.id == active_id)
        {
            record.name = nickname.to_string();
        }
        registry.save(&app_state.data_dir)?;
    }
    update_tray(&app, &app_state);
    Ok(())
}

#[tauri::command]
fn get_tox_messages(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    limit: Option<usize>,
) -> Result<Vec<ToxMessage>, String> {
    let tox_state = app_state.active()?;
    tox_state
        .messages
        .lock()
        .map(|messages| {
            let matching = messages
                .iter()
                .filter(|message| message.friend_number == friend_number)
                .cloned()
                .collect::<Vec<_>>();
            match limit.filter(|value| *value > 0) {
                Some(limit) if matching.len() > limit => {
                    matching[matching.len() - limit..].to_vec()
                }
                _ => matching,
            }
        })
        .map_err(|_| "Не удалось прочитать сообщения Tox".to_string())
}

#[derive(Serialize)]
struct ToxMessagesSnapshot {
    revision: u64,
    messages: Option<Vec<ToxMessage>>,
}

#[tauri::command]
fn get_tox_messages_snapshot(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    limit: Option<usize>,
    known_revision: Option<u64>,
) -> Result<ToxMessagesSnapshot, String> {
    let tox_state = app_state.active()?;
    let revision = history_revision(&tox_state.history_path);
    if known_revision == Some(revision) {
        return Ok(ToxMessagesSnapshot {
            revision,
            messages: None,
        });
    }
    let messages = get_tox_messages(app_state, friend_number, limit)?;
    Ok(ToxMessagesSnapshot {
        revision,
        messages: Some(messages),
    })
}

#[tauri::command]
fn send_tox_message(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    text: String,
) -> Result<u32, String> {
    let tox_state = app_state.active()?;
    let text = sanitize_untrusted_text(&text).trim().to_string();
    if text.is_empty() {
        return Err("Нельзя отправить пустое сообщение".to_string());
    }
    let timestamp = unix_timestamp();
    let id = new_message_id(friend_number);
    if tox_state.pq.queues_encrypted_messages(friend_number) {
        tox_state
            .pending_pq_messages
            .lock()
            .map_err(|_| "Не удалось сохранить очередь PQ-сообщений".to_string())?
            .push(PendingToxMessage {
                id: id.clone(),
                friend_number,
                text: text.to_string(),
                timestamp,
                next_offset: 0,
            });
        tox_state
            .messages
            .lock()
            .map_err(|_| "Не удалось сохранить PQ-сообщение".to_string())?
            .push(ToxMessage {
                id,
                friend_number,
                text: text.to_string(),
                mine: true,
                timestamp,
                delivery: "pending".to_string(),
                delivered_at: None,
                attachment: None,
                event: None,
            });
        persist_pending_messages(
            &tox_state.pending_pq_messages,
            &tox_state.pending_pq_messages_path,
        );
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
        return Ok(0);
    }
    tox_state
        .pending_messages
        .lock()
        .map_err(|_| "Не удалось сохранить очередь сообщений".to_string())?
        .push(PendingToxMessage {
            id: id.clone(),
            friend_number,
            text: text.to_string(),
            timestamp,
            next_offset: 0,
        });
    tox_state
        .messages
        .lock()
        .map_err(|_| "Не удалось сохранить сообщение".to_string())?
        .push(ToxMessage {
            id: id.clone(),
            friend_number,
            text: text.to_string(),
            mine: true,
            timestamp,
            delivery: "pending".to_string(),
            delivered_at: None,
            attachment: None,
            event: None,
        });
    log_network(
        &tox_state.network_log_path,
        format!(
            "QUEUE_MESSAGE friend={friend_number} local_id={id} bytes={} fingerprint={}",
            text.len(),
            event_fingerprint(text.as_bytes())
        ),
    );
    persist_pending_messages(
        &tox_state.pending_messages,
        &tox_state.pending_messages_path,
    );
    persist_tox_history(
        &tox_state.messages,
        &tox_state.history_path,
        &tox_state.history_enabled,
    );
    Ok(0)
}

#[tauri::command]
fn get_pq_status(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<PqStatus, String> {
    Ok(app_state.active()?.pq.status(friend_number))
}

#[tauri::command]
fn request_pq_session(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<PqStatus, String> {
    let tox_state = app_state.active()?;
    let packets = tox_state.pq.request(friend_number)?;
    tox_state.pq.queue(friend_number, packets);
    let status = tox_state.pq.status(friend_number);
    append_pq_history(
        &tox_state.messages,
        friend_number,
        &status,
        "initiator",
        "offered",
        true,
    );
    persist_tox_history(
        &tox_state.messages,
        &tox_state.history_path,
        &tox_state.history_enabled,
    );
    Ok(status)
}

#[tauri::command]
fn withdraw_pq_session(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<PqStatus, String> {
    let tox_state = app_state.active()?;
    let packets = tox_state.pq.withdraw(friend_number)?;
    tox_state.pq.queue(friend_number, packets);
    let status = tox_state.pq.status(friend_number);
    if update_latest_pq_history(&tox_state.messages, friend_number, &status, "withdrawn") {
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
    }
    Ok(status)
}

#[tauri::command]
fn accept_pq_session(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<PqStatus, String> {
    let tox_state = app_state.active()?;
    let packets = tox_state.pq.accept(friend_number)?;
    tox_state.pq.queue(friend_number, packets);
    let status = tox_state.pq.status(friend_number);
    if update_latest_pq_history(&tox_state.messages, friend_number, &status, "accepting") {
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
    }
    Ok(status)
}

#[tauri::command]
fn reject_pq_session(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<PqStatus, String> {
    let tox_state = app_state.active()?;
    let packets = tox_state.pq.reject(friend_number)?;
    tox_state.pq.queue(friend_number, packets);
    let status = tox_state.pq.status(friend_number);
    if update_latest_pq_history(&tox_state.messages, friend_number, &status, "rejected") {
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
    }
    Ok(status)
}

#[tauri::command]
fn request_pq_shutdown(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<PqStatus, String> {
    let tox_state = app_state.active()?;
    let packets = tox_state.pq.request_shutdown(friend_number)?;
    tox_state.pq.queue(friend_number, packets);
    let status = tox_state.pq.status(friend_number);
    append_pq_history(
        &tox_state.messages,
        friend_number,
        &status,
        "initiator",
        "close_pending",
        true,
    );
    persist_tox_history(
        &tox_state.messages,
        &tox_state.history_path,
        &tox_state.history_enabled,
    );
    Ok(status)
}

#[tauri::command]
fn send_tox_file(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    filename: String,
    mime: String,
    bytes: Vec<u8>,
) -> Result<u32, String> {
    let tox_state = app_state.active()?;
    if bytes.is_empty() {
        return Err("Нельзя отправить пустой файл".to_string());
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Для первой версии лимит передачи — 25 МБ".to_string());
    }
    if current_self_avatar_matches(&tox_state.avatars_dir, &bytes) {
        log_transfer(
            &tox_state.transfer_log_path,
            format!("AVATAR_COMMAND_SKIP_UNCHANGED bytes={}", bytes.len()),
        );
        return Ok(0);
    }
    let filename = safe_file_name(&filename);
    let source_path =
        tox_state
            .outgoing_files_dir
            .join(format!("out-{}-{}", unix_timestamp(), filename));
    fs::write(&source_path, &bytes)
        .map_err(|error| format!("Не удалось подготовить файл: {error}"))?;
    let timestamp = unix_timestamp();
    let id = new_message_id(friend_number);
    let size = bytes.len() as u64;
    let path = source_path.to_string_lossy().into_owned();
    tox_state
        .pending_files
        .lock()
        .map_err(|_| "Не удалось сохранить очередь файлов".to_string())?
        .push(PendingToxFile {
            id: id.clone(),
            friend_number,
            filename: filename.clone(),
            mime: mime.clone(),
            path: path.clone(),
            size,
            timestamp,
            retry_count: 0,
        });
    tox_state
        .messages
        .lock()
        .map_err(|_| "Не удалось сохранить сообщение с файлом".to_string())?
        .push(ToxMessage {
            id: id.clone(),
            friend_number,
            text: String::new(),
            mine: true,
            timestamp,
            delivery: "pending".to_string(),
            delivered_at: None,
            attachment: Some(ToxAttachment {
                name: filename.clone(),
                size,
                mime,
                path,
                image: is_image_name(&filename),
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
        });
    log_transfer(
        &tox_state.transfer_log_path,
        format!("FILE_QUEUE_ADD friend={friend_number} local_id={id} bytes={size} name={filename}"),
    );
    persist_pending_files(&tox_state.pending_files, &tox_state.pending_files_path);
    persist_tox_history(
        &tox_state.messages,
        &tox_state.history_path,
        &tox_state.history_enabled,
    );
    Ok(0)
}

#[tauri::command]
fn get_native_file_metadata(path: String) -> Result<NativeFileMetadata, String> {
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Не удалось открыть файл: {error}"))?;
    if !metadata.is_file() {
        return Err("Можно отправлять только файлы".to_string());
    }
    if metadata.len() == 0 {
        return Err("Нельзя отправить пустой файл".to_string());
    }
    if metadata.len() > 25 * 1024 * 1024 {
        return Err("Для первой версии лимит передачи — 25 МБ".to_string());
    }
    Ok(NativeFileMetadata {
        size: metadata.len(),
    })
}

fn validated_portable_file(paths: &PortablePaths, path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(path);
    let source = if source.is_absolute() {
        source
    } else {
        paths.root_dir.join(source)
    };
    let source = fs::canonicalize(&source)
        .map_err(|error| format!("Could not locate attachment {}: {error}", source.display()))?;
    let portable_root = fs::canonicalize(&paths.root_dir)
        .map_err(|error| format!("Could not verify portable directory: {error}"))?;
    if !source.starts_with(&portable_root) || !source.is_file() {
        return Err("Attachment is outside the portable application directory".to_string());
    }
    Ok(source)
}

fn validated_download_file(paths: &PortablePaths, path: &str) -> Result<PathBuf, String> {
    let source = validated_portable_file(paths, path)?;
    let downloads = fs::canonicalize(&paths.downloads_dir)
        .map_err(|error| format!("Could not verify downloads directory: {error}"))?;
    if !source.starts_with(&downloads) {
        return Err(
            "Only received files in the portable downloads directory can be shown".to_string(),
        );
    }
    Ok(source)
}

#[tauri::command]
fn show_attachment_in_folder(path: String) -> Result<(), String> {
    let paths = PortablePaths::discover()?;
    let source = validated_download_file(&paths, &path)?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", source.display()))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("Could not show {} in Explorer: {error}", source.display()))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", source.to_string_lossy().as_ref()])
            .spawn()
            .map_err(|error| format!("Could not reveal {} in Finder: {error}", source.display()))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let uri = file_uri(&source);
        let status = std::process::Command::new("dbus-send")
            .args([
                "--session",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:{uri}"),
                "string:",
            ])
            .status();
        if matches!(status, Ok(status) if status.success()) {
            return Ok(());
        }
        let parent = source
            .parent()
            .ok_or_else(|| "Attachment directory is unavailable".to_string())?;
        return open_with_system(parent);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    Err("Showing files is not supported on this platform".to_string())
}

#[tauri::command]
async fn copy_attachment_to_clipboard(path: String, image: bool) -> Result<(), String> {
    let paths = PortablePaths::discover()?;
    let source = validated_portable_file(&paths, &path)?;
    tauri::async_runtime::spawn_blocking(move || copy_file_to_native_clipboard(&source, image))
        .await
        .map_err(|error| format!("Clipboard task failed: {error}"))?
}

#[cfg(target_os = "windows")]
fn copy_file_to_native_clipboard(path: &Path, image: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = r#"& { param([string]$path, [string]$kind)
Add-Type -AssemblyName System.Windows.Forms
if ($kind -eq 'image') {
  Add-Type -AssemblyName System.Drawing
  $stream = [System.IO.File]::OpenRead($path)
  try {
    $source = [System.Drawing.Image]::FromStream($stream)
    try {
      $copy = [System.Drawing.Bitmap]::new($source)
      try { [System.Windows.Forms.Clipboard]::SetImage($copy) } finally { $copy.Dispose() }
    } finally { $source.Dispose() }
  } finally { $stream.Dispose() }
} else {
  $files = [System.Collections.Specialized.StringCollection]::new()
  [void]$files.Add($path)
  [System.Windows.Forms.Clipboard]::SetFileDropList($files)
}
}"#;
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            script,
        ])
        .arg(path)
        .arg(if image { "image" } else { "file" })
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Could not start the Windows clipboard service: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn copy_file_to_native_clipboard(path: &Path, image: bool) -> Result<(), String> {
    let script = r#"ObjC.import('AppKit');
function run(argv) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  const value = argv[1] === 'image'
    ? $.NSImage.alloc.initWithContentsOfFile(argv[0])
    : $.NSURL.fileURLWithPath(argv[0]);
  if (!value) throw new Error('Could not read the selected file');
  if (!pasteboard.writeObjects([value])) throw new Error('Could not write to the clipboard');
}"#;
    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script, "--"])
        .arg(path)
        .arg(if image { "image" } else { "file" })
        .output()
        .map_err(|error| format!("Could not start the macOS clipboard service: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn copy_file_to_native_clipboard(path: &Path, image: bool) -> Result<(), String> {
    let (mime, payload) = if image {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match extension.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/png",
        };
        let bytes = fs::read(path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        (mime, bytes)
    } else {
        (
            "text/uri-list",
            format!("{}\r\n", file_uri(path)).into_bytes(),
        )
    };
    for (program, arguments) in [
        ("wl-copy", vec!["--type", mime]),
        ("xclip", vec!["-selection", "clipboard", "-t", mime, "-i"]),
    ] {
        let mut child = match std::process::Command::new(program)
            .args(arguments)
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not start {program}: {error}")),
        };
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&payload)
                .map_err(|error| format!("Could not write clipboard data: {error}"))?;
        }
        let status = child
            .wait()
            .map_err(|error| format!("Could not wait for {program}: {error}"))?;
        if status.success() {
            return Ok(());
        }
    }
    Err("Install wl-clipboard or xclip to copy files to the clipboard".to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut encoded = String::with_capacity(raw.len() + 8);
    for byte in raw.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("file://{encoded}")
}

fn open_with_system(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    return Err("Opening paths is not supported on this platform".to_string());

    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    Ok(())
}

#[tauri::command]
fn open_downloads_directory() -> Result<(), String> {
    let downloads_dir = PortablePaths::discover()?.downloads_dir;
    open_with_system(&downloads_dir)
}

#[tauri::command]
fn open_logs_directory(app_state: tauri::State<'_, AppState>) -> Result<(), String> {
    let active = app_state.active()?;
    let logs = active
        .network_log_path
        .parent()
        .ok_or_else(|| "Logs directory is unavailable".to_string())?;
    fs::create_dir_all(logs)
        .map_err(|error| format!("Could not create logs directory: {error}"))?;
    open_with_system(logs)
}

#[tauri::command]
fn open_license_information(app_state: tauri::State<'_, AppState>) -> Result<(), String> {
    let candidates = vec![
        app_state.root_dir.join("THIRD-PARTY-NOTICES.txt"),
        app_state.root_dir.join("THIRD_PARTY_NOTICES.md"),
        app_state.root_dir.join("LICENSES.txt"),
        app_state.root_dir.join("README.md"),
    ];
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let mut candidates = candidates;
    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var_os("APPDIR") {
        let appdir = PathBuf::from(appdir);
        for docs in [
            appdir.join("usr/lib/Kaigen"),
            appdir.join("usr/share/doc/Kaigen"),
        ] {
            candidates.extend([docs.join("THIRD_PARTY_NOTICES.md"), docs.join("README.md")]);
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(executable) = std::env::current_exe() {
        if let Some(bundle) = executable.ancestors().find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        }) {
            let resources = bundle.join("Contents/Resources");
            candidates.extend([
                resources.join("THIRD_PARTY_NOTICES.md"),
                resources.join("README.md"),
            ]);
        }
    }
    let path = candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "License information file was not found".to_string())?;
    open_with_system(&path)
}

#[tauri::command]
fn send_tox_file_from_path(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    path: String,
    mime: String,
) -> Result<u32, String> {
    let metadata = get_native_file_metadata(path.clone())?;
    let filename = PathBuf::from(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Не удалось определить имя файла".to_string())?
        .to_string();
    let bytes = fs::read(&path).map_err(|error| format!("Не удалось прочитать файл: {error}"))?;
    if bytes.len() as u64 != metadata.size {
        return Err("Файл изменился во время подготовки к отправке".to_string());
    }
    send_tox_file(app_state, friend_number, filename, mime, bytes)
}

#[tauri::command]
fn control_tox_file_transfer(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    message_id: String,
    action: String,
) -> Result<(), String> {
    let tox_state = app_state.active()?;
    let control = match action.as_str() {
        "resume" => 0_i32,
        "pause" => 1_i32,
        "cancel" => 2_i32,
        _ => return Err("Unknown file transfer action".to_string()),
    };

    if action == "cancel" {
        let removed_from_queue = {
            let mut pending = tox_state
                .pending_files
                .lock()
                .map_err(|_| "Unable to access pending files".to_string())?;
            let before = pending.len();
            pending.retain(|file| !(file.friend_number == friend_number && file.id == message_id));
            before != pending.len()
        };
        let outgoing_key = tox_state.outgoing_files.lock().ok().and_then(|files| {
            files.iter().find_map(|(key, file)| {
                (key.0 == friend_number && file.message_id.as_deref() == Some(message_id.as_str()))
                    .then_some(*key)
            })
        });
        let incoming_key = tox_state.incoming_files.lock().ok().and_then(|files| {
            files.iter().find_map(|(key, file)| {
                (key.0 == friend_number && file.message_id.as_deref() == Some(message_id.as_str()))
                    .then_some(*key)
            })
        });

        // A protocol cancel is best-effort: local cancellation must never be blocked
        // by a stale Tox file number or by a peer that is currently offline.
        if let Some((friend, file_number)) = outgoing_key.or(incoming_key) {
            if let Ok(state) = tox_state.handle.lock() {
                if let Some(instance) = state.as_ref() {
                    let mut error = 0_i32;
                    let ok = unsafe {
                        tox_file_control(
                            instance.instance.as_ptr(),
                            friend,
                            file_number,
                            2,
                            &mut error,
                        )
                    };
                    if !ok || error != 0 {
                        log_transfer(&tox_state.transfer_log_path, format!("FILE_CONTROL_CANCEL_NOTIFY_FAILED friend={friend} file={file_number} message={message_id} code={error}"));
                    }
                }
            }
            if let Ok(mut files) = tox_state.outgoing_files.lock() {
                files.remove(&(friend, file_number));
            }
            if let Ok(mut files) = tox_state.incoming_files.lock() {
                files.remove(&(friend, file_number));
            }
        }

        // Keep the history card: cancellation is a durable terminal state, not deletion.
        set_attachment_transfer_state(&tox_state.messages, &message_id, "cancelled");
        persist_pending_files(&tox_state.pending_files, &tox_state.pending_files_path);
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
        log_transfer(&tox_state.transfer_log_path, format!("FILE_CONTROL_CANCELLED_LOCAL friend={friend_number} message={message_id} queued={removed_from_queue}"));
        return Ok(());
    }

    let outgoing_key = tox_state.outgoing_files.lock().ok().and_then(|files| {
        files.iter().find_map(|(key, file)| {
            if key.0 == friend_number && file.message_id.as_deref() == Some(message_id.as_str()) {
                Some(*key)
            } else {
                None
            }
        })
    });
    let incoming_key = tox_state.incoming_files.lock().ok().and_then(|files| {
        files.iter().find_map(|(key, file)| {
            if key.0 == friend_number && file.message_id.as_deref() == Some(message_id.as_str()) {
                Some(*key)
            } else {
                None
            }
        })
    });
    let (friend, file_number, outgoing) = if let Some((friend, file_number)) = outgoing_key {
        (friend, file_number, true)
    } else if let Some((friend, file_number)) = incoming_key {
        (friend, file_number, false)
    } else {
        set_attachment_transfer_error(
            &tox_state.messages,
            &message_id,
            "Передача больше не активна. Можно отправить файл заново.",
        );
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
        return Err("Active transfer was not found".to_string());
    };

    if !outgoing && action == "resume" {
        let maximum = tox_state
            .file_receive_settings
            .lock()
            .map(|settings| settings.max_concurrent.max(1))
            .unwrap_or(1);
        let at_capacity = tox_state
            .incoming_files
            .lock()
            .map(|files| {
                files
                    .iter()
                    .filter(|(key, file)| {
                        **key != (friend, file_number) && file.kind != 1 && file.active
                    })
                    .count()
                    >= maximum
            })
            .unwrap_or(false);
        if at_capacity {
            if let Ok(mut files) = tox_state.incoming_files.lock() {
                if let Some(file) = files.get_mut(&(friend, file_number)) {
                    file.auto_queued = true;
                }
            }
            set_attachment_transfer_state(&tox_state.messages, &message_id, "queued");
            persist_tox_history(
                &tox_state.messages,
                &tox_state.history_path,
                &tox_state.history_enabled,
            );
            return Ok(());
        }
    }

    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Unable to access Tox profile".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Tox profile is not initialised".to_string())?;
    let mut error = 0_i32;
    let ok = unsafe {
        tox_file_control(
            instance.instance.as_ptr(),
            friend,
            file_number,
            control,
            &mut error,
        )
    };
    drop(state);
    // toxcore reports a state that is already reached as an error.  A repeated
    // pause (6 = already paused) or resume (4 = not paused) is still the
    // requested end state, so accept it instead of leaving the UI stale.
    let already_in_requested_state =
        (action == "pause" && error == 6) || (action == "resume" && error == 4);
    if (!ok || error != 0) && !already_in_requested_state {
        set_attachment_transfer_error(
            &tox_state.messages,
            &message_id,
            format!("Не удалось изменить передачу (код Tox {error})"),
        );
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
        return Err(format!("Tox file control failed (code {error})"));
    }

    if action == "cancel" {
        if outgoing {
            if let Ok(mut files) = tox_state.outgoing_files.lock() {
                files.remove(&(friend, file_number));
            }
        } else if let Ok(mut files) = tox_state.incoming_files.lock() {
            files.remove(&(friend, file_number));
        }
    }
    if !outgoing {
        if let Ok(mut files) = tox_state.incoming_files.lock() {
            if let Some(file) = files.get_mut(&(friend, file_number)) {
                file.active = action == "resume";
                if action != "resume" {
                    file.auto_queued = false;
                }
            }
        }
    }
    let transfer_state = match action.as_str() {
        "pause" => "paused",
        "resume" if outgoing => "sending",
        "resume" => "receiving",
        "cancel" => "cancelled",
        _ => unreachable!(),
    };
    set_attachment_transfer_state(&tox_state.messages, &message_id, transfer_state);
    persist_tox_history(
        &tox_state.messages,
        &tox_state.history_path,
        &tox_state.history_enabled,
    );
    log_transfer(&tox_state.transfer_log_path, format!("FILE_CONTROL action={action} friend={friend} file={file_number} message={message_id} idempotent={already_in_requested_state}"));
    Ok(())
}

#[tauri::command]
fn get_file_receive_settings(
    app_state: tauri::State<'_, AppState>,
) -> Result<FileReceiveSettings, String> {
    app_state
        .active()?
        .file_receive_settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Could not read file receive settings".to_string())
}

#[tauri::command]
fn set_file_receive_settings(
    app_state: tauri::State<'_, AppState>,
    mut settings: FileReceiveSettings,
) -> Result<FileReceiveSettings, String> {
    settings.max_concurrent = settings.max_concurrent.clamp(1, 5);
    let tox_state = app_state.active()?;
    let serialized = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Could not encode file receive settings: {error}"))?;
    atomic_write(&tox_state.file_receive_settings_path, &serialized)?;
    *tox_state
        .file_receive_settings
        .lock()
        .map_err(|_| "Could not update file receive settings".to_string())? = settings.clone();
    Ok(settings)
}

fn validate_proxy_settings(settings: &ProxySettings) -> Result<(), String> {
    if !matches!(settings.mode.as_str(), "none" | "socks5" | "http") {
        return Err("Unsupported proxy type".to_string());
    }
    if settings.mode != "none" && (settings.host.trim().is_empty() || settings.port == 0) {
        return Err("Proxy address and port are required".to_string());
    }
    if settings.username.as_bytes().len() > 255 || settings.password.as_bytes().len() > 255 {
        return Err("Proxy username and password must be no longer than 255 bytes".to_string());
    }
    Ok(())
}

#[tauri::command]
fn get_proxy_settings(app_state: tauri::State<'_, AppState>) -> Result<ProxySettings, String> {
    app_state
        .proxy_settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Could not read the shared proxy settings".to_string())
}

fn loaded_profiles(app_state: &AppState) -> Result<Vec<Arc<ToxState>>, String> {
    Ok(app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .values()
        .cloned()
        .collect())
}

fn rebuild_profiles(profiles: &[Arc<ToxState>]) -> Result<(), String> {
    for profile in profiles {
        profile.rebuild_network_route()?;
    }
    Ok(())
}

#[tauri::command]
async fn set_proxy_settings(
    app_state: tauri::State<'_, AppState>,
    settings: ProxySettings,
) -> Result<ProxySettings, String> {
    let app_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_proxy_settings_blocking(&app_state, settings))
        .await
        .map_err(|error| format!("Proxy route update task failed: {error}"))?
}

fn set_proxy_settings_blocking(
    app_state: &AppState,
    mut settings: ProxySettings,
) -> Result<ProxySettings, String> {
    settings.host = settings.host.trim().to_string();
    validate_proxy_settings(&settings)?;
    let previous = app_state
        .proxy_settings
        .lock()
        .map_err(|_| "Could not read the shared proxy settings".to_string())?
        .clone();
    // Reapplying an unchanged "none" route used to tear down every live Tox
    // handle for no reason. It looked like the connection had been broken.
    if settings == previous {
        return Ok(settings);
    }
    let profiles = loaded_profiles(app_state)?;
    let serialized = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Could not encode proxy settings: {error}"))?;
    *app_state
        .proxy_settings
        .lock()
        .map_err(|_| "Could not update the shared proxy settings".to_string())? = settings.clone();
    if !app_state.tor.enabled() {
        if let Err(error) = rebuild_profiles(&profiles) {
            if let Ok(mut current) = app_state.proxy_settings.lock() {
                *current = previous;
            }
            let _ = rebuild_profiles(&profiles);
            return Err(format!(
                "Could not apply the proxy route; the previous route was restored: {error}"
            ));
        }
    }
    if let Err(error) = atomic_write(&app_state.proxy_settings_path, &serialized) {
        if let Ok(mut current) = app_state.proxy_settings.lock() {
            *current = previous;
        }
        if !app_state.tor.enabled() {
            let _ = rebuild_profiles(&profiles);
        }
        return Err(error);
    }
    Ok(settings)
}

#[tauri::command]
fn get_network_settings(app_state: tauri::State<'_, AppState>) -> Result<NetworkSettings, String> {
    app_state
        .network_settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Could not read the shared Tox network settings".to_string())
}

#[tauri::command]
async fn set_network_settings(
    app_state: tauri::State<'_, AppState>,
    settings: NetworkSettings,
) -> Result<NetworkSettings, String> {
    let app_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        set_network_settings_blocking(&app_state, settings)
    })
    .await
    .map_err(|error| format!("Tox network update task failed: {error}"))?
}

fn set_network_settings_blocking(
    app_state: &AppState,
    settings: NetworkSettings,
) -> Result<NetworkSettings, String> {
    let settings = settings.normalized();
    let previous = app_state
        .network_settings
        .lock()
        .map_err(|_| "Could not read the shared Tox network settings".to_string())?
        .clone();
    if settings == previous {
        return Ok(settings);
    }
    let profiles = loaded_profiles(app_state)?;
    let serialized = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Could not encode Tox network settings: {error}"))?;
    *app_state
        .network_settings
        .lock()
        .map_err(|_| "Could not update the shared Tox network settings".to_string())? =
        settings.clone();
    if let Err(error) = rebuild_profiles(&profiles) {
        if let Ok(mut current) = app_state.network_settings.lock() {
            *current = previous;
        }
        let _ = rebuild_profiles(&profiles);
        return Err(format!(
            "Could not apply Tox network settings; the previous settings were restored: {error}"
        ));
    }
    if let Err(error) = atomic_write(&app_state.network_settings_path, &serialized) {
        if let Ok(mut current) = app_state.network_settings.lock() {
            *current = previous;
        }
        let _ = rebuild_profiles(&profiles);
        return Err(error);
    }
    Ok(settings)
}

#[tauri::command]
fn test_proxy_connection(settings: ProxySettings) -> Result<String, String> {
    validate_proxy_settings(&settings)?;
    if settings.mode == "none" {
        return Ok(
            "Прокси отключён. Используются общие параметры прямого подключения Tox".to_string(),
        );
    }
    let address = (settings.host.as_str(), settings.port)
        .to_socket_addrs()
        .map_err(|error| format!("Не удалось разрешить адрес прокси: {error}"))?
        .next()
        .ok_or_else(|| "Адрес прокси не разрешился".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(10))
        .map_err(|error| format!("Прокси недоступен: {error}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
    if settings.mode == "socks5" {
        let authenticated = !settings.username.is_empty() || !settings.password.is_empty();
        stream
            .write_all(if authenticated {
                &[5, 2, 0, 2]
            } else {
                &[5, 1, 0]
            })
            .map_err(|error| error.to_string())?;
        let mut response = [0_u8; 2];
        stream
            .read_exact(&mut response)
            .map_err(|error| format!("Прокси не ответил как SOCKS5: {error}"))?;
        if response[0] != 5 || response[1] == 0xff {
            return Err("SOCKS5-прокси отклонил доступные способы авторизации".to_string());
        }
        if response[1] == 2 {
            let username = settings.username.as_bytes();
            let password = settings.password.as_bytes();
            let mut auth = vec![1, username.len() as u8];
            auth.extend(username);
            auth.push(password.len() as u8);
            auth.extend(password);
            stream.write_all(&auth).map_err(|error| error.to_string())?;
            let mut auth_response = [0_u8; 2];
            stream
                .read_exact(&mut auth_response)
                .map_err(|error| error.to_string())?;
            if auth_response[1] != 0 {
                return Err("SOCKS5-прокси отклонил логин или пароль".to_string());
            }
        }
        Ok("SOCKS5-прокси доступен, согласование авторизации успешно".to_string())
    } else {
        let credentials =
            (!settings.username.is_empty() || !settings.password.is_empty()).then(|| {
                base64_basic(format!("{}:{}", settings.username, settings.password).as_bytes())
            });
        let auth = credentials
            .map(|value| format!("Proxy-Authorization: Basic {value}\r\n"))
            .unwrap_or_default();
        stream
            .write_all(
                format!(
                    "OPTIONS * HTTP/1.1\r\nHost: {}:{}\r\n{auth}Connection: close\r\n\r\n",
                    settings.host, settings.port
                )
                .as_bytes(),
            )
            .map_err(|error| error.to_string())?;
        let mut response = [0_u8; 512];
        let length = stream
            .read(&mut response)
            .map_err(|error| format!("HTTP-прокси не ответил: {error}"))?;
        let first_line = String::from_utf8_lossy(&response[..length])
            .lines()
            .next()
            .unwrap_or_default()
            .to_string();
        if first_line.contains(" 407 ") {
            return Err("HTTP-прокси отклонил логин или пароль".to_string());
        }
        if !first_line.starts_with("HTTP/") {
            return Err("Сервер не ответил как HTTP-прокси".to_string());
        }
        Ok(format!("HTTP-прокси доступен: {first_line}"))
    }
}

#[tauri::command]
fn retry_tox_file_transfer(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    message_id: String,
) -> Result<(), String> {
    let tox_state = app_state.active()?;
    let attachment = tox_state
        .messages
        .lock()
        .map_err(|_| "Unable to access message history".to_string())?
        .iter()
        .find(|message| message.id == message_id && message.friend_number == friend_number)
        .and_then(|message| message.attachment.clone())
        .ok_or_else(|| "File transfer card was not found".to_string())?;
    let path = PathBuf::from(&attachment.path);
    let metadata = fs::metadata(&path)
        .map_err(|_| "Исходный файл больше недоступен для повторной отправки".to_string())?;
    if metadata.len() == 0 {
        return Err("Нельзя отправить пустой файл".to_string());
    }
    if metadata.len() != attachment.size {
        return Err("Исходный файл изменился. Выберите его заново.".to_string());
    }

    {
        let mut pending = tox_state
            .pending_files
            .lock()
            .map_err(|_| "Unable to access pending files".to_string())?;
        pending.retain(|file| !(file.friend_number == friend_number && file.id == message_id));
        pending.push(PendingToxFile {
            id: message_id.clone(),
            friend_number,
            filename: attachment.name,
            mime: attachment.mime,
            path: attachment.path,
            size: metadata.len(),
            timestamp: unix_timestamp(),
            retry_count: 0,
        });
    }
    set_attachment_retrying(&tox_state.messages, &message_id, 0);
    persist_pending_files(&tox_state.pending_files, &tox_state.pending_files_path);
    persist_tox_history(
        &tox_state.messages,
        &tox_state.history_path,
        &tox_state.history_enabled,
    );
    log_transfer(
        &tox_state.transfer_log_path,
        format!("FILE_RETRY_QUEUED friend={friend_number} message={message_id}"),
    );
    Ok(())
}

#[tauri::command]
fn send_tox_avatar(
    app_state: tauri::State<'_, AppState>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<usize, String> {
    let tox_state = app_state.active()?;
    send_tox_avatar_for_state(&tox_state, filename, bytes)
}

fn send_tox_avatar_for_state(
    tox_state: &ToxState,
    filename: String,
    bytes: Vec<u8>,
) -> Result<usize, String> {
    if bytes.is_empty() {
        return Err("Аватар пуст".to_string());
    }
    if bytes.len() > 64 * 1024 {
        return Err("Аватар для Tox не должен превышать 64 КиБ".to_string());
    }
    let filename = safe_file_name(&filename);
    let avatar_path = tox_state.avatars_dir.join(format!("self-{filename}"));
    fs::write(&avatar_path, &bytes)
        .map_err(|error| format!("Не удалось сохранить аватар: {error}"))?;
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не ициализирован".to_string())?;
    let count = unsafe { tox_self_get_friend_list_size(instance.instance.as_ptr()) };
    let mut numbers = vec![0_u32; count];
    unsafe { tox_self_get_friend_list(instance.instance.as_ptr(), numbers.as_mut_ptr()) };
    let mut hash = [0_u8; 32];
    unsafe {
        let _ = tox_hash(hash.as_mut_ptr(), bytes.as_ptr(), bytes.len());
    }
    let mut started = Vec::new();
    for friend_number in numbers {
        let mut connection_error = 0_i32;
        if unsafe {
            tox_friend_get_connection_status(
                instance.instance.as_ptr(),
                friend_number,
                &mut connection_error,
            )
        } == 0
        {
            log_transfer(&tox_state.transfer_log_path, format!("AVATAR_SKIP_OFFLINE friend={friend_number} connection_error={connection_error}"));
            continue;
        }
        let mut error = 0_i32;
        let number = unsafe {
            tox_file_send(
                instance.instance.as_ptr(),
                friend_number,
                1,
                bytes.len() as u64,
                hash.as_ptr(),
                hash.as_ptr(),
                hash.len(),
                &mut error,
            )
        };
        log_transfer(
            &tox_state.transfer_log_path,
            format!(
                "AVATAR_COMMAND_SEND friend={friend_number} file={number} bytes={} error={error}",
                bytes.len()
            ),
        );
        if error == 0 {
            started.push((friend_number, number));
        }
    }
    ToxState::save(instance)?;
    drop(state);
    let mut outgoing = tox_state
        .outgoing_files
        .lock()
        .map_err(|_| "Не удалось подготовить аватар".to_string())?;
    for pair in &started {
        outgoing.insert(
            *pair,
            OutgoingFile {
                path: avatar_path.clone(),
                size: bytes.len() as u64,
                message_id: None,
                meter: TransferMeter::new(),
                last_activity_at: Instant::now(),
                fully_sent: false,
                retry_count: 0,
            },
        );
    }
    Ok(started.len())
}

#[tauri::command]
fn set_chat_history_enabled(
    app_state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let tox_state = app_state.active()?;
    tox_state.history_enabled.store(enabled, Ordering::Relaxed);
    if enabled {
        persist_tox_history(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        );
    }
    Ok(())
}

#[tauri::command]
fn clear_tox_history(
    app_state: tauri::State<'_, AppState>,
    friend_number: Option<u32>,
) -> Result<(), String> {
    let tox_state = app_state.active()?;
    let mut messages = tox_state
        .messages
        .lock()
        .map_err(|_| "Unable to clear chat history".to_string())?;
    if let Some(friend_number) = friend_number {
        messages.retain(|message| message.friend_number != friend_number);
    } else {
        messages.clear();
    }
    let serialized = serde_json::to_vec(&*messages)
        .map_err(|error| format!("Unable to save cleared chat history: {error}"))?;
    drop(messages);
    fs::write(&tox_state.history_path, serialized)
        .map_err(|error| format!("Unable to save cleared chat history: {error}"))?;
    bump_history_revision(&tox_state.history_path);
    if let Ok(mut unread) = tox_state.unread_state.lock() {
        if let Some(friend_number) = friend_number {
            unread.friends.remove(&friend_number.to_string());
        } else {
            unread.friends.clear();
        }
    }
    persist_unread_state(&tox_state.unread_state, &tox_state.unread_state_path);
    Ok(())
}

#[cfg(target_os = "windows")]
fn local_history_timestamp(timestamp: u64) -> String {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn FileTimeToSystemTime(file_time: *const FileTime, system_time: *mut SystemTime) -> i32;
        fn SystemTimeToTzSpecificLocalTime(
            time_zone: *const c_void,
            universal: *const SystemTime,
            local: *mut SystemTime,
        ) -> i32;
    }
    let ticks = timestamp
        .saturating_add(11_644_473_600)
        .saturating_mul(10_000_000);
    let file_time = FileTime {
        low: ticks as u32,
        high: (ticks >> 32) as u32,
    };
    let mut utc = SystemTime::default();
    let mut local = SystemTime::default();
    let ok = unsafe {
        FileTimeToSystemTime(&file_time, &mut utc) != 0
            && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) != 0
    };
    if !ok {
        return timestamp.to_string();
    }
    format!(
        "{:02}.{:02}.{:02} {:02}:{:02}",
        local.month,
        local.day,
        local.year % 100,
        local.hour,
        local.minute
    )
}

#[cfg(not(target_os = "windows"))]
fn local_history_timestamp(timestamp: u64) -> String {
    let raw = match libc::time_t::try_from(timestamp) {
        Ok(raw) => raw,
        Err(_) => return timestamp.to_string(),
    };
    let mut local = unsafe { std::mem::zeroed::<libc::tm>() };
    if unsafe { libc::localtime_r(&raw, &mut local) }.is_null() {
        return timestamp.to_string();
    }
    format!(
        "{:02}.{:02}.{:02} {:02}:{:02}",
        local.tm_mon + 1,
        local.tm_mday,
        (local.tm_year + 1900) % 100,
        local.tm_hour,
        local.tm_min
    )
}

#[tauri::command]
fn export_tox_history(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
    contact_name: String,
    contact_id: String,
) -> Result<String, String> {
    let tox_state = app_state.active()?;
    let mut messages = tox_state
        .messages
        .lock()
        .map_err(|_| "Could not access the complete chat history".to_string())?
        .iter()
        .filter(|message| message.friend_number == friend_number)
        .cloned()
        .collect::<Vec<_>>();
    messages.sort_by_key(|message| message.timestamp);
    let mut text = String::new();
    for message in messages {
        let stamp = local_history_timestamp(message.timestamp);
        let author = if message.mine {
            "Я"
        } else {
            contact_name.trim()
        };
        let body = if let Some(attachment) = message.attachment {
            let full_name = Path::new(&attachment.path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&attachment.name);
            format!("Вложение: {full_name} — {stamp}")
        } else {
            sanitize_untrusted_text(&message.text)
        };
        text.push_str(&format!("{stamp}\r\n{author}: {body}\r\n\r\n"));
    }
    let directory = app_state.root_dir.join("chat export");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create chat export directory: {error}"))?;
    let identity = if contact_name.trim().is_empty() {
        contact_id.trim()
    } else {
        contact_name.trim()
    };
    let export_date = local_history_timestamp(unix_timestamp())
        .split_whitespace()
        .next()
        .unwrap_or("export")
        .replace('.', "-");
    let filename = format!(
        "{}-{}.txt",
        safe_file_name(if identity.is_empty() {
            "contact"
        } else {
            identity
        }),
        export_date,
    );
    let destination = unique_download_path(&directory, &filename);
    atomic_write(&destination, text.as_bytes())?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_tox_friend(
    app_state: tauri::State<'_, AppState>,
    friend_number: u32,
) -> Result<(), String> {
    let tox_state = app_state.active()?;
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Unable to access Tox profile".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Tox profile is not initialised".to_string())?;
    let mut error = 0_i32;
    if !unsafe { tox_friend_delete(instance.instance.as_ptr(), friend_number, &mut error) } {
        return Err(format!("Unable to delete Tox contact (code {error})"));
    }
    ToxState::save(instance)?;
    drop(state);

    let mut messages = tox_state
        .messages
        .lock()
        .map_err(|_| "Unable to clear chat history".to_string())?;
    messages.retain(|message| message.friend_number != friend_number);
    let serialized = serde_json::to_vec(&*messages)
        .map_err(|error| format!("Unable to save cleared chat history: {error}"))?;
    drop(messages);
    fs::write(&tox_state.history_path, serialized)
        .map_err(|error| format!("Unable to save cleared chat history: {error}"))?;
    bump_history_revision(&tox_state.history_path);
    if let Ok(mut unread) = tox_state.unread_state.lock() {
        unread.friends.remove(&friend_number.to_string());
    }
    persist_unread_state(&tox_state.unread_state, &tox_state.unread_state_path);
    Ok(())
}

#[tauri::command]
fn get_incoming_friend_requests(
    app_state: tauri::State<'_, AppState>,
) -> Result<Vec<IncomingFriendRequest>, String> {
    let tox_state = app_state.active()?;
    tox_state
        .incoming_requests
        .lock()
        .map(|requests| requests.clone())
        .map_err(|_| "Не удалось прочитать входящие запросы".to_string())
}

fn parse_public_key(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Некорректный публичный ключ Tox".to_string());
    }
    let mut key = [0_u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Некорректный публичный ключ Tox".to_string())?;
    }
    Ok(key)
}

#[tauri::command]
fn accept_incoming_friend_request(
    app_state: tauri::State<'_, AppState>,
    public_key: String,
) -> Result<u32, String> {
    let tox_state = app_state.active()?;
    let key = parse_public_key(&public_key)?;
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
    let mut error = 0_i32;
    let number =
        unsafe { tox_friend_add_norequest(instance.instance.as_ptr(), key.as_ptr(), &mut error) };
    if error != 0 {
        return Err(format!("Не удалось принять запрос Tox (код {error})"));
    }
    ToxState::save(instance)?;
    drop(state);
    if let Ok(mut cache) = tox_state.friend_cache.lock() {
        let entry = cache.entry(public_key.clone()).or_default();
        entry.authorized = true;
        if let Ok(serialized) = serde_json::to_vec(&*cache) {
            let _ = atomic_write_sender().try_send(AtomicWriteRequest {
                path: tox_state.friend_cache_path.clone(),
                bytes: serialized,
            });
        }
    }
    if let Ok(mut requests) = tox_state.incoming_requests.lock() {
        requests.retain(|request| request.public_key != public_key);
    }
    persist_incoming_friend_requests(
        &tox_state.incoming_requests,
        &tox_state.incoming_requests_path,
    );
    if let Ok(mut unread) = tox_state.unread_state.lock() {
        unread.requests.remove(&public_key);
    }
    persist_unread_state(&tox_state.unread_state, &tox_state.unread_state_path);
    if let Some(updates) = &tox_state.updates {
        updates.changed();
    }
    Ok(number)
}

#[tauri::command]
async fn get_tox_network_status(app_state: tauri::State<'_, AppState>) -> Result<String, String> {
    let tox_state = app_state.active()?;
    if !tox_state.network_enabled.load(Ordering::Relaxed) {
        return Ok("offline".to_string());
    }
    if tox_state.tor.enabled() {
        let tor_status = tox_state.tor.status();
        if tor_status.state == "error" {
            return Ok("offline".to_string());
        }
        if tor_status.state != "connected" {
            return Ok("connecting-tor".to_string());
        }
    }
    Ok(match tox_state.connection.load(Ordering::Relaxed) {
        1 | 2 => "online".to_string(),
        _ => "connecting".to_string(),
    })
}

#[tauri::command]
async fn get_tor_settings(app_state: tauri::State<'_, AppState>) -> Result<TorSettings, String> {
    Ok(app_state.tor.settings())
}

#[tauri::command]
async fn get_tor_status(app_state: tauri::State<'_, AppState>) -> Result<TorStatus, String> {
    Ok(app_state.tor.status())
}

#[tauri::command]
async fn set_tor_settings(
    app_state: tauri::State<'_, AppState>,
    settings: TorSettings,
) -> Result<TorStatus, String> {
    let app_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_tor_settings_blocking(&app_state, settings))
        .await
        .map_err(|error| format!("Tor route update task failed: {error}"))?
}

fn set_tor_settings_blocking(
    app_state: &AppState,
    settings: TorSettings,
) -> Result<TorStatus, String> {
    let status = app_state.tor.apply_settings(settings)?;
    let profiles: Vec<Arc<ToxState>> = app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .values()
        .cloned()
        .collect();
    for profile in profiles {
        profile.rebuild_network_route()?;
    }
    Ok(status)
}

#[tauri::command]
async fn restart_tor(app_state: tauri::State<'_, AppState>) -> Result<TorStatus, String> {
    let app_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || restart_tor_blocking(&app_state))
        .await
        .map_err(|error| format!("Tor restart task failed: {error}"))?
}

fn restart_tor_blocking(app_state: &AppState) -> Result<TorStatus, String> {
    let status = app_state.tor.restart()?;
    let profiles: Vec<Arc<ToxState>> = app_state
        .profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .values()
        .cloned()
        .collect();
    for profile in profiles {
        profile.rebuild_network_route()?;
    }
    Ok(status)
}

#[tauri::command]
fn set_tox_user_status(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    status: String,
) -> Result<String, String> {
    let tox_state = app_state.active()?;
    let result = set_user_status_inner(&tox_state, &status)?;
    update_tray(&app, &app_state);
    Ok(result)
}

#[tauri::command]
fn get_tox_user_status(app_state: tauri::State<'_, AppState>) -> Result<String, String> {
    let tox_state = app_state.active()?;
    if !tox_state.network_enabled.load(Ordering::Relaxed) {
        return Ok("offline".to_string());
    }
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
    Ok(
        match unsafe { tox_self_get_status(instance.instance.as_ptr()) } {
            0 => "online",
            1 => "away",
            _ => "busy",
        }
        .to_string(),
    )
}

fn default_status_message(app_state: &AppState) -> &'static str {
    if app_state
        .settings
        .lock()
        .map(|settings| settings.language == "en")
        .unwrap_or(false)
    {
        "Ready to chat"
    } else {
        "Готов к общению"
    }
}

#[tauri::command]
fn get_tox_status_message(app_state: tauri::State<'_, AppState>) -> Result<String, String> {
    let tox_state = app_state.active()?;
    let default_status = default_status_message(&app_state);
    let mut state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_mut()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
    let mut error = 0;
    let length =
        unsafe { tox_self_get_status_message_size(instance.instance.as_ptr(), &mut error) };
    if error != 0 || length == 0 {
        let mut set_error = 0;
        if !unsafe {
            tox_self_set_status_message(
                instance.instance.as_ptr(),
                default_status.as_bytes().as_ptr(),
                default_status.len(),
                &mut set_error,
            )
        } {
            return Err(format!(
                "Не удалось установить статус Tox (код {set_error})"
            ));
        }
        ToxState::save(instance)?;
        return Ok(default_status.to_string());
    }
    let mut bytes = vec![0_u8; length];
    error = 0;
    if !unsafe {
        tox_self_get_status_message(instance.instance.as_ptr(), bytes.as_mut_ptr(), &mut error)
    } {
        return Err(format!("Не удалось прочитать статус Tox (код {error})"));
    }
    Ok(sanitize_untrusted_text(&String::from_utf8_lossy(&bytes))
        .trim()
        .to_string())
}

#[tauri::command]
fn set_tox_status_message(
    app_state: tauri::State<'_, AppState>,
    message: String,
) -> Result<String, String> {
    let tox_state = app_state.active()?;
    let default_status = default_status_message(&app_state);
    let sanitized = sanitize_untrusted_text(&message);
    let value = if sanitized.trim().is_empty() {
        default_status.to_string()
    } else {
        sanitized.trim().to_string()
    };
    let state = tox_state
        .handle
        .lock()
        .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
    let instance = state
        .as_ref()
        .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
    let mut error = 0;
    if !unsafe {
        tox_self_set_status_message(
            instance.instance.as_ptr(),
            value.as_bytes().as_ptr(),
            value.len(),
            &mut error,
        )
    } {
        return Err(format!("Не удалось обновить статус Tox (код {error})"));
    }
    log_network(
        &tox_state.network_log_path,
        format!(
            "SELF_STATUS_MESSAGE bytes={} fingerprint={}",
            value.len(),
            event_fingerprint(value.as_bytes())
        ),
    );
    ToxState::save(instance)?;
    Ok(value)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let instance_guard = match InstanceGuard::acquire_for_current_executable()
        .expect("could not initialise per-directory single-instance handling")
    {
        InstanceOutcome::Primary(guard) => guard,
        InstanceOutcome::SecondaryActivated => return,
    };
    configure_portable_webview().expect("portable WebView2 setup failed");
    let app = tauri::Builder::default()
        .setup(move |app| {
            instance_guard.start_activation_listener(app.handle().clone());
            app.manage(instance_guard);
            let app_state = AppState::new(app.handle().clone())
                .map_err(|error| format!("Toxcore could not initialise: {error}"))?;
            let language = app_state
                .settings
                .lock()
                .map(|settings| settings.language.clone())
                .unwrap_or_else(|_| "ru".to_string());
            app.manage(app_state);
            let tray_items = create_tray(app, &language)
                .map_err(|error| format!("Could not create the Kaigen tray icon: {error}"))?;
            app.manage(tray_items);
            update_tray(app.handle(), &app.state::<AppState>());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let close_to_tray = state
                    .settings
                    .lock()
                    .map(|settings| settings.close_to_tray)
                    .unwrap_or(true);
                if close_to_tray && !state.exit_requested.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    stop_owned_services(&state);
                }
            }
        })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_startup_state,
            set_app_language,
            set_close_to_tray,
            get_unread_state,
            mark_friend_read,
            mark_requests_read,
            unlock_profile,
            continue_with_loaded_profiles,
            disable_profile,
            switch_profile,
            create_profile,
            discover_qtox_profiles,
            import_qtox_profile,
            change_profile_password,
            destroy_active_profile,
            load_local_state,
            save_local_state,
            load_layout_state,
            save_layout_state,
            get_tox_id,
            add_tox_friend,
            get_tox_friends,
            get_tox_messages,
            get_tox_messages_snapshot,
            send_tox_message,
            get_pq_status,
            request_pq_session,
            withdraw_pq_session,
            accept_pq_session,
            reject_pq_session,
            request_pq_shutdown,
            send_tox_file,
            get_native_file_metadata,
            show_attachment_in_folder,
            copy_attachment_to_clipboard,
            open_downloads_directory,
            open_logs_directory,
            open_license_information,
            send_tox_file_from_path,
            control_tox_file_transfer,
            get_file_receive_settings,
            set_file_receive_settings,
            get_proxy_settings,
            set_proxy_settings,
            test_proxy_connection,
            get_network_settings,
            set_network_settings,
            retry_tox_file_transfer,
            send_tox_avatar,
            set_profile_avatar,
            get_incoming_friend_requests,
            accept_incoming_friend_request,
            get_tor_settings,
            get_tor_status,
            set_tor_settings,
            restart_tor,
            get_tox_network_status,
            get_tox_user_status,
            set_tox_user_status,
            get_tox_status_message,
            set_tox_status_message,
            set_tox_nickname,
            set_chat_history_enabled,
            clear_tox_history,
            export_tox_history,
            delete_tox_friend
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(state) = app_handle.try_state::<AppState>() {
                stop_owned_services(&state);
            }
        }
    });
}

fn stop_owned_services(state: &AppState) {
    state.tor.stop();
    if let Ok(profiles) = state.profiles.lock() {
        for profile in profiles.values() {
            if !profile.stop() {
                continue;
            }
            persist_tox_history_now(
                &profile.messages,
                &profile.history_path,
                &profile.history_enabled,
            );
            persist_unread_state_now(&profile.unread_state, &profile.unread_state_path);
            persist_pending_messages_now(&profile.pending_messages, &profile.pending_messages_path);
            persist_pending_messages_now(
                &profile.pending_pq_messages,
                &profile.pending_pq_messages_path,
            );
            if let Ok(cache) = profile.friend_cache.lock() {
                if let Ok(bytes) = serde_json::to_vec(&*cache) {
                    let _ = atomic_write(&profile.friend_cache_path, &bytes);
                }
            }
        }
    }
}
