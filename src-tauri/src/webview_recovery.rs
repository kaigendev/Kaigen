use tauri::Manager;

#[cfg(target_os = "windows")]
use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
const WATCHDOG_POLL_INTERVAL: Duration = Duration::from_secs(15);
#[cfg(target_os = "windows")]
const FOCUSED_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(target_os = "windows")]
const BACKGROUND_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(target_os = "windows")]
const RECOVERY_LOG_MAX_BYTES: u64 = 64 * 1024;

#[cfg(target_os = "windows")]
const PROCESS_FAILED_BROWSER: i32 = 0;
#[cfg(target_os = "windows")]
const PROCESS_FAILED_RENDERER: i32 = 1;
#[cfg(target_os = "windows")]
const PROCESS_FAILED_RENDERER_UNRESPONSIVE: i32 = 2;
#[cfg(target_os = "windows")]
const PROCESS_FAILED_FRAME_RENDERER: i32 = 3;
#[cfg(target_os = "windows")]
const PROCESS_FAILED_UNKNOWN: i32 = 9;

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryAction {
    Ignore,
    Reload,
    Rebuild,
}

#[cfg(target_os = "windows")]
fn recovery_action_for_process_failure(kind: i32) -> RecoveryAction {
    match kind {
        PROCESS_FAILED_BROWSER => RecoveryAction::Rebuild,
        PROCESS_FAILED_RENDERER
        | PROCESS_FAILED_RENDERER_UNRESPONSIVE
        | PROCESS_FAILED_FRAME_RENDERER
        | PROCESS_FAILED_UNKNOWN => RecoveryAction::Reload,
        // WebView2 restarts GPU, utility, sandbox and plug-in processes itself.
        // The heartbeat below remains a fallback if that automatic recovery
        // does not restore a responsive renderer.
        _ => RecoveryAction::Ignore,
    }
}

#[cfg(target_os = "windows")]
fn record_recovery_event(event: &str) {
    static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let Ok(_guard) = LOG_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let Ok(root) = crate::instance::portable_root_for_current_executable() else {
        return;
    };
    let directory = root.join("data").join("logs");
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join("webview-recovery.log");
    let truncate = fs::metadata(&path)
        .map(|metadata| metadata.len() >= RECOVERY_LOG_MAX_BYTES)
        .unwrap_or(false);
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if truncate {
        options.truncate(true);
    } else {
        options.append(true);
    }
    let Ok(mut file) = options.open(path) else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "{timestamp} {event}");
}

#[cfg(target_os = "windows")]
struct WebviewRecoveryState {
    started_at: Instant,
    last_heartbeat_ms: AtomicU64,
    recovery_in_progress: AtomicBool,
    stopped: AtomicBool,
}

#[cfg(target_os = "windows")]
impl WebviewRecoveryState {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            last_heartbeat_ms: AtomicU64::new(0),
            recovery_in_progress: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
    }

    fn heartbeat(&self) {
        self.last_heartbeat_ms
            .store(self.elapsed_ms(), Ordering::Release);
    }

    fn heartbeat_age(&self) -> Duration {
        Duration::from_millis(
            self.elapsed_ms()
                .saturating_sub(self.last_heartbeat_ms.load(Ordering::Acquire)),
        )
    }

    fn begin_recovery(&self) -> bool {
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        if self
            .recovery_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        self.heartbeat();
        true
    }

    fn finish_recovery(&self) {
        self.recovery_in_progress.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowSnapshot {
    position: Option<tauri::PhysicalPosition<i32>>,
    size: Option<tauri::PhysicalSize<u32>>,
    maximized: bool,
    fullscreen: bool,
    visible: bool,
    focused: bool,
}

#[cfg(target_os = "windows")]
impl WindowSnapshot {
    fn capture(window: &tauri::WebviewWindow) -> Self {
        Self {
            position: window.outer_position().ok(),
            size: window.outer_size().ok(),
            maximized: window.is_maximized().unwrap_or(false),
            fullscreen: window.is_fullscreen().unwrap_or(false),
            visible: window.is_visible().unwrap_or(true),
            focused: window.is_focused().unwrap_or(false),
        }
    }

    fn default_visible() -> Self {
        Self {
            position: None,
            size: None,
            maximized: false,
            fullscreen: false,
            visible: true,
            focused: true,
        }
    }
}

#[cfg(target_os = "windows")]
fn install_process_failure_handler(
    window: &tauri::WebviewWindow,
    state: Arc<WebviewRecoveryState>,
) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
        ProcessFailedEventHandler,
    };

    let app = window.app_handle().clone();
    window
        .with_webview(move |platform_webview| {
            let controller = platform_webview.controller();
            let Ok(core_webview) = (unsafe { controller.CoreWebView2() }) else {
                return;
            };
            let callback_app = app.clone();
            let callback_state = state.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                unsafe { args.ProcessFailedKind(&mut kind)? };
                let action = recovery_action_for_process_failure(kind.0);
                record_recovery_event(&format!("process-failed kind={} action={action:?}", kind.0));
                if action != RecoveryAction::Ignore {
                    request_recovery(&callback_app, callback_state.clone(), action);
                }
                Ok(())
            }));
            let mut token = 0_i64;
            let _ = unsafe { core_webview.add_ProcessFailed(&handler, &mut token) };
        })
        .map_err(|error| format!("Could not attach the WebView2 failure handler: {error}"))
}

#[cfg(target_os = "windows")]
fn request_recovery(
    app: &tauri::AppHandle,
    state: Arc<WebviewRecoveryState>,
    action: RecoveryAction,
) {
    if !state.begin_recovery() {
        return;
    }

    let dispatcher = app.clone();
    let operation_app = app.clone();
    let operation_state = state.clone();
    if dispatcher
        .run_on_main_thread(move || match action {
            RecoveryAction::Ignore => operation_state.finish_recovery(),
            RecoveryAction::Reload => {
                let reloaded = operation_app
                    .get_webview_window("main")
                    .is_some_and(|window| window.reload().is_ok());
                if reloaded {
                    record_recovery_event("renderer-reload-requested");
                    operation_state.finish_recovery();
                } else {
                    rebuild_main_window(&operation_app, operation_state, None, 0);
                }
            }
            RecoveryAction::Rebuild => {
                rebuild_main_window(&operation_app, operation_state, None, 0);
            }
        })
        .is_err()
    {
        state.finish_recovery();
    }
}

#[cfg(target_os = "windows")]
fn rebuild_main_window(
    app: &tauri::AppHandle,
    state: Arc<WebviewRecoveryState>,
    retained_snapshot: Option<WindowSnapshot>,
    attempt: u8,
) {
    if state.stopped.load(Ordering::Acquire) {
        state.finish_recovery();
        return;
    }

    let current = app.get_webview_window("main");
    let snapshot = retained_snapshot.unwrap_or_else(|| {
        current
            .as_ref()
            .map(WindowSnapshot::capture)
            .unwrap_or_else(WindowSnapshot::default_visible)
    });
    if let Some(window) = current {
        let _ = window.destroy();
    }

    let Some(mut config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .cloned()
    else {
        state.finish_recovery();
        return;
    };
    config.center = false;
    config.x = None;
    config.y = None;
    config.visible = false;
    config.focus = false;
    config.maximized = false;
    config.fullscreen = false;

    match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build())
    {
        Ok(window) => {
            if let Some(size) = snapshot.size {
                let _ = window.set_size(size);
            }
            if let Some(position) = snapshot.position {
                let _ = window.set_position(position);
            }
            if snapshot.maximized {
                let _ = window.maximize();
            }
            if snapshot.fullscreen {
                let _ = window.set_fullscreen(true);
            }
            let _ = install_process_failure_handler(&window, state.clone());
            if snapshot.visible {
                let _ = window.show();
            }
            if snapshot.focused {
                let _ = window.set_focus();
            }
            record_recovery_event("window-rebuilt");
            state.finish_recovery();
        }
        Err(_) if attempt < 2 => {
            schedule_rebuild_retry(app.clone(), state, snapshot, attempt + 1);
        }
        Err(_) => state.finish_recovery(),
    }
}

#[cfg(target_os = "windows")]
fn schedule_rebuild_retry(
    app: tauri::AppHandle,
    state: Arc<WebviewRecoveryState>,
    snapshot: WindowSnapshot,
    attempt: u8,
) {
    let retry_state = state.clone();
    if thread::Builder::new()
        .name("kaigen-webview-rebuild".to_string())
        .stack_size(256 * 1024)
        .spawn(move || {
            thread::sleep(Duration::from_millis(200 * u64::from(attempt)));
            let dispatcher = app.clone();
            let operation_app = app;
            let operation_state = state.clone();
            if dispatcher
                .run_on_main_thread(move || {
                    rebuild_main_window(&operation_app, operation_state, Some(snapshot), attempt);
                })
                .is_err()
            {
                state.finish_recovery();
            }
        })
        .is_err()
    {
        retry_state.finish_recovery();
    }
}

#[cfg(target_os = "windows")]
fn start_watchdog(app: tauri::AppHandle, state: Arc<WebviewRecoveryState>) -> Result<(), String> {
    thread::Builder::new()
        .name("kaigen-webview-watchdog".to_string())
        .stack_size(256 * 1024)
        .spawn(move || loop {
            thread::sleep(WATCHDOG_POLL_INTERVAL);
            if state.stopped.load(Ordering::Acquire) {
                break;
            }
            if state.recovery_in_progress.load(Ordering::Acquire) {
                continue;
            }

            let age = state.heartbeat_age();
            let Some(window) = app.get_webview_window("main") else {
                if age >= FOCUSED_HEARTBEAT_TIMEOUT {
                    record_recovery_event("watchdog-main-window-missing");
                    request_recovery(&app, state.clone(), RecoveryAction::Rebuild);
                }
                continue;
            };
            if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                continue;
            }
            let timeout = if window.is_focused().unwrap_or(false) {
                FOCUSED_HEARTBEAT_TIMEOUT
            } else {
                BACKGROUND_HEARTBEAT_TIMEOUT
            };
            if age >= timeout {
                record_recovery_event(if window.is_focused().unwrap_or(false) {
                    "watchdog-focused-heartbeat-timeout"
                } else {
                    "watchdog-background-heartbeat-timeout"
                });
                request_recovery(&app, state.clone(), RecoveryAction::Rebuild);
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Could not start the WebView watchdog: {error}"))
}

pub(crate) fn setup(app: &tauri::App) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let state = Arc::new(WebviewRecoveryState::new());
        state.heartbeat();
        app.manage(state.clone());
        if let Some(window) = app.get_webview_window("main") {
            let _ = install_process_failure_handler(&window, state.clone());
        }
        start_watchdog(app.handle().clone(), state)?;
    }
    Ok(())
}

pub(crate) fn heartbeat(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    if let Some(state) = app.try_state::<Arc<WebviewRecoveryState>>() {
        state.heartbeat();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    if let Some(state) = app.try_state::<Arc<WebviewRecoveryState>>() {
        state.stopped.store(true, Ordering::Release);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn browser_exit_rebuilds_the_webview_window() {
        assert_eq!(
            recovery_action_for_process_failure(PROCESS_FAILED_BROWSER),
            RecoveryAction::Rebuild
        );
    }

    #[test]
    fn renderer_failures_reload_without_restarting_native_services() {
        for kind in [
            PROCESS_FAILED_RENDERER,
            PROCESS_FAILED_RENDERER_UNRESPONSIVE,
            PROCESS_FAILED_FRAME_RENDERER,
            PROCESS_FAILED_UNKNOWN,
        ] {
            assert_eq!(
                recovery_action_for_process_failure(kind),
                RecoveryAction::Reload
            );
        }
    }

    #[test]
    fn auxiliary_process_failure_uses_webview2_automatic_recovery() {
        for kind in 4..=8 {
            assert_eq!(
                recovery_action_for_process_failure(kind),
                RecoveryAction::Ignore
            );
        }
    }
}
