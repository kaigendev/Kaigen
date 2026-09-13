//! Incoming events, independent of WebView visibility and the selected profile.
//! Native callbacks enqueue bounded identities only; one worker reads the exact
//! message and preferences after the chat transaction has released its locks.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::{AppState, ProfileNotification};

const QUEUE_LIMIT: usize = 64;
static QUEUE: OnceLock<SyncSender<Pending>> = OnceLock::new();
static FOREGROUND: AtomicBool = AtomicBool::new(true);

struct Pending {
    profile_id: String,
    event: ProfileNotification,
    received: Instant,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    profile_id: String,
    target: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Preferences {
    messages: bool,
    requests: bool,
    sound: bool,
    volume: f64,
}

impl Preferences {
    fn from_local_state(value: &Value) -> Self {
        let enabled = |key| value.get(key).and_then(Value::as_bool).unwrap_or(false);
        Self {
            messages: enabled("notifyMessages"),
            requests: enabled("notifyRequests"),
            sound: enabled("notifySound"),
            volume: value
                .get("notificationVolume")
                .and_then(Value::as_f64)
                .filter(|volume| volume.is_finite())
                .unwrap_or(0.7)
                .clamp(0.0, 1.0),
        }
    }
}

struct Notice {
    target: Target,
    title: String,
    body: String,
    popup: bool,
    volume: Option<f64>,
}

pub(super) fn set_focused(focused: bool) {
    FOREGROUND.store(focused, Ordering::Release);
}

pub(super) fn enqueue(profile_id: &str, event: ProfileNotification) {
    // Never delay a foreground event and then show it after the user leaves.
    if FOREGROUND.load(Ordering::Acquire) {
        return;
    }
    if let Some(queue) = QUEUE.get() {
        let _ = queue.try_send(Pending {
            profile_id: profile_id.to_string(),
            event,
            received: Instant::now(),
        });
    }
}

fn target_key(event: &ProfileNotification) -> Option<String> {
    match event {
        ProfileNotification::Message {
            friend_public_key, ..
        } => {
            if friend_public_key.len() != 64
                || !friend_public_key
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return None;
            }
            Some(format!(
                "friend-key:{}",
                friend_public_key.to_ascii_uppercase()
            ))
        }
        ProfileNotification::Request { .. } => Some("requests".to_string()),
    }
}

fn background(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    window.is_minimized().unwrap_or(false)
        || !window.is_visible().unwrap_or(true)
        || !window.is_focused().unwrap_or(true)
}

fn stage_pending(pending: &mut HashMap<(String, String), Pending>, item: Pending) {
    if let Some(target) = target_key(&item.event) {
        let key = (item.profile_id.clone(), target);
        if pending.len() < QUEUE_LIMIT || pending.contains_key(&key) {
            pending.insert(key, item);
        }
    }
}

fn drain_pending(
    receiver: &mpsc::Receiver<Pending>,
    pending: &mut HashMap<(String, String), Pending>,
    already_received: usize,
) -> usize {
    let mut received = already_received;
    for _ in already_received..QUEUE_LIMIT {
        let Ok(item) = receiver.try_recv() else {
            break;
        };
        stage_pending(pending, item);
        received += 1;
    }
    received
}

pub(super) fn start(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        set_focused(window.is_focused().unwrap_or(true));
    }
    let (sender, receiver) = mpsc::sync_channel::<Pending>(QUEUE_LIMIT);
    QUEUE
        .set(sender)
        .map_err(|_| "Notification worker already running")?;
    thread::Builder::new()
        .name("kaigen-notifications".to_string())
        .spawn(move || {
            let mut pending = HashMap::new();
            let mut last_sound = None::<Instant>;
            loop {
                let received = match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(item) => {
                        stage_pending(&mut pending, item);
                        // One popup for a burst in one chat, retaining its last snippet.
                        thread::sleep(Duration::from_millis(120));
                        1
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => 0,
                };
                // Producers cannot keep the worker draining forever.
                drain_pending(&receiver, &mut pending, received);
                let Some(state) = app.try_state::<AppState>() else {
                    continue;
                };
                if state.exit_requested.load(Ordering::Acquire) {
                    break;
                }
                for (_, item) in pending.drain() {
                    if item.received.elapsed() > Duration::from_secs(10) || !background(&app) {
                        continue;
                    }
                    let Some(notice) = prepare(&state, &item) else {
                        continue;
                    };
                    if !background(&app) || state.loaded_profile(&notice.target.profile_id).is_err()
                    {
                        continue;
                    }
                    if let Some(volume) = notice.volume.filter(|_| {
                        last_sound.is_none_or(|last| last.elapsed() >= Duration::from_millis(750))
                    }) {
                        let _ = app.emit_to("main", "kaigen-message-sound", volume);
                        last_sound = Some(Instant::now());
                    }
                    if notice.popup {
                        // Errors carry no message text, and never create an in-app fallback.
                        let _ = show(&app, notice);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            macos::shutdown(&app);
        })
        .map(|_| ())
        .map_err(|_| "Could not start the notification worker".to_string())
}

fn excerpt(text: &str) -> String {
    crate::sanitize_untrusted_text(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}

fn prepare(app: &AppState, pending: &Pending) -> Option<Notice> {
    let state = app.loaded_profile(&pending.profile_id).ok()?;
    let local_path = state.history_path.parent()?.join("local-state.json");
    let bytes = crate::profiles::read_file(&local_path).ok()?;
    let local: Value = serde_json::from_slice(&bytes).ok()?;
    let preferences = Preferences::from_local_state(&local);
    let ru = app.settings.lock().ok()?.language != "en";
    let target = Target {
        profile_id: pending.profile_id.clone(),
        target: target_key(&pending.event)?,
    };
    match &pending.event {
        ProfileNotification::Message {
            friend_number,
            friend_public_key,
            message_id,
        } => {
            if !preferences.messages && (!preferences.sound || preferences.volume == 0.0) {
                return None;
            }
            let _transaction = state.chat_transaction_gate.lock().ok()?;
            let resident = {
                let messages = state.messages.lock().ok()?;
                messages
                    .iter()
                    .find(|message| {
                        message.id == *message_id
                            && crate::message_matches_friend(
                                message,
                                *friend_number,
                                friend_public_key,
                            )
                    })
                    .cloned()
            };
            let message = resident.or_else(|| {
                if !state.history_enabled.load(Ordering::Acquire) {
                    return None;
                }
                crate::chat_history_store::find_message_registered(
                    &state.history_path,
                    *friend_number,
                    friend_public_key,
                    message_id,
                )
                .ok()
                .flatten()
            })?;
            if message.mine || message.event.is_some() {
                return None;
            }
            let title = state
                .friend_cache
                .lock()
                .ok()?
                .get(friend_public_key)
                .map(|friend| friend.name.trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| if ru { "Контакт" } else { "Contact" }.to_string());
            let body = if message.text.trim().is_empty() {
                message
                    .attachment
                    .as_ref()
                    .map(|file| excerpt(&file.name))
                    .unwrap_or_default()
            } else {
                excerpt(&message.text)
            };
            Some(Notice {
                target,
                title: excerpt(&title),
                body,
                popup: preferences.messages,
                volume: (preferences.sound && preferences.volume > 0.0)
                    .then_some(preferences.volume),
            })
        }
        ProfileNotification::Request { public_key } => {
            if !preferences.requests {
                return None;
            }
            let request = state
                .incoming_requests
                .lock()
                .ok()?
                .iter()
                .find(|request| request.public_key == *public_key)
                .cloned()?;
            let title = if ru {
                "Запрос в контакты"
            } else {
                "Contact request"
            }
            .to_string();
            Some(Notice {
                target,
                title,
                body: excerpt(&request.message),
                popup: true,
                volume: None,
            })
        }
    }
}

fn activate(app: &tauri::AppHandle, target: &Target) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.loaded_profile(&target.profile_id).is_err() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("kaigen-notification-activate", target);
    }
}

#[cfg(target_os = "windows")]
fn show(app: &tauri::AppHandle, notice: Notice) -> Result<(), ()> {
    use tauri_winrt_notification::{Duration as ToastDuration, Toast};
    if !windows_identity::initialize_apartment() {
        return Err(());
    }
    let app_id = windows_identity::register(&app.config().identifier)?;
    if !background(app) {
        return Ok(());
    }
    let app = app.clone();
    Toast::new(&app_id)
        .title(&notice.title)
        .text1(&notice.body)
        .sound(None)
        .duration(ToastDuration::Short)
        .on_activated(move |_| {
            activate(&app, &notice.target);
            Ok(())
        })
        .show()
        .map_err(|_| ())
}

#[cfg(target_os = "windows")]
mod windows_identity {
    use sha2::{Digest, Sha256};
    use std::{mem::ManuallyDrop, path::PathBuf, sync::OnceLock};
    use windows::{
        core::{Interface, GUID, HSTRING, PWSTR},
        Win32::{
            Foundation::PROPERTYKEY,
            System::{
                Com::{
                    CoCreateInstance, CoTaskMemFree, IPersistFile,
                    StructuredStorage::{
                        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                    },
                    CLSCTX_INPROC_SERVER,
                },
                Variant::VT_LPWSTR,
                WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
            },
            UI::Shell::{
                FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore,
                SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
            },
        },
    };

    struct Apartment;
    impl Apartment {
        fn new() -> Option<Self> {
            // Both S_OK and S_FALSE require one balanced RoUninitialize; a
            // failed initialization must never decrement another COM owner.
            unsafe { RoInitialize(RO_INIT_MULTITHREADED).ok().map(|_| Self) }
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    thread_local! { static APARTMENT: Option<Apartment> = Apartment::new(); }
    pub(super) fn initialize_apartment() -> bool {
        APARTMENT.with(Option::is_some)
    }

    struct ShellPath(PWSTR);
    impl Drop for ShellPath {
        fn drop(&mut self) {
            unsafe {
                CoTaskMemFree(Some(self.0.as_ptr().cast()));
            }
        }
    }

    pub(super) fn register(identifier: &str) -> Result<String, ()> {
        static REGISTERED: OnceLock<String> = OnceLock::new();
        if let Some(app_id) = REGISTERED.get() {
            return Ok(app_id.clone());
        }
        let executable = std::env::current_exe().map_err(|_| ())?;
        let executable_text = executable.to_string_lossy();
        // Independent portable folders must not replace each other's identity
        // or shortcut. Neither profile files nor user preferences are moved.
        let digest = Sha256::digest(executable_text.to_lowercase().as_bytes());
        let suffix = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let app_id = format!(
            "{}.portable.{suffix}",
            identifier.chars().take(96).collect::<String>()
        );
        let app_id_wide = HSTRING::from(app_id.as_str());
        unsafe {
            let programs = ShellPath(
                SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None).map_err(|_| ())?,
            );
            let shortcut = PathBuf::from(programs.0.to_string().map_err(|_| ())?)
                .join(format!("Kaigen ({suffix}).lnk"));
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|_| ())?;
            link.SetPath(&HSTRING::from(executable_text.as_ref()))
                .map_err(|_| ())?;
            link.SetDescription(windows::core::w!("Kaigen"))
                .map_err(|_| ())?;
            link.SetIconLocation(&HSTRING::from(executable_text.as_ref()), 0)
                .map_err(|_| ())?;
            if let Some(directory) = executable.parent() {
                link.SetWorkingDirectory(&HSTRING::from(directory.to_string_lossy().as_ref()))
                    .map_err(|_| ())?;
            }
            let properties: IPropertyStore = link.cast().map_err(|_| ())?;
            let property = PROPERTYKEY {
                fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
                pid: 5,
            };
            // SetValue copies this borrowed LPWSTR. Suppress the outer
            // PROPVARIANT destructor too: PropVariantClear must not free
            // HSTRING-owned memory. app_id_wide stays alive through SetValue.
            let value = ManuallyDrop::new(PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_LPWSTR,
                        Anonymous: PROPVARIANT_0_0_0 {
                            pwszVal: PWSTR(app_id_wide.as_ptr().cast_mut()),
                        },
                        ..Default::default()
                    }),
                },
            });
            properties.SetValue(&property, &*value).map_err(|_| ())?;
            properties.Commit().map_err(|_| ())?;
            let file: IPersistFile = link.cast().map_err(|_| ())?;
            file.Save(&HSTRING::from(shortcut.to_string_lossy().as_ref()), true)
                .map_err(|_| ())?;
        }
        // The shortcut supplies the required AUMID-to-EXE binding. The display
        // name keeps Windows notification settings independent of its unique
        // per-folder shortcut filename.
        register_display_name(&app_id)?;
        let _ = REGISTERED.set(app_id.clone());
        Ok(app_id)
    }

    fn register_display_name(app_id: &str) -> Result<(), ()> {
        use windows_sys::Win32::System::Registry::*;
        let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let path = wide(&format!("Software\\Classes\\AppUserModelId\\{app_id}"));
        let mut key = std::ptr::null_mut();
        unsafe {
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            ) != 0
            {
                return Err(());
            }
            let name = wide("DisplayName");
            let value = wide("Kaigen");
            let result = RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            );
            RegCloseKey(key);
            if result != 0 {
                return Err(());
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn show(app: &tauri::AppHandle, notice: Notice) -> Result<(), ()> {
    use notify_rust::{Notification, NotificationResponse};
    use std::sync::atomic::AtomicUsize;
    static WAITERS: AtomicUsize = AtomicUsize::new(0);
    let slot = WorkerSlot::acquire(&WAITERS, 16).ok_or(())?;
    let app = app.clone();
    let started = thread::Builder::new().name("kaigen-notification-action".to_string()).spawn(move || {
        let _slot = slot;
        if !background(&app) { return; }
        let mut notification = Notification::new();
        let ru = app.try_state::<AppState>().and_then(|state| state.settings.lock().ok().map(|settings| settings.language != "en")).unwrap_or(true);
        notification.summary(&notice.title).body(&escape_markup(&notice.body)).appname("Kaigen")
            .action("default", if ru { "Открыть" } else { "Open" }).timeout(4000)
            .hint(notify_rust::Hint::SuppressSound(true));
        if let Some(Ok(handle)) = block_until(notification.show_async(), Instant::now() + Duration::from_secs(5)) {
            if background(&app) {
                let _ = block_until(handle.wait_for_action_async(|response: &NotificationResponse| {
                    if response.is_default_action() || matches!(response, NotificationResponse::Action(action) if action == "default") {
                        activate(&app, &notice.target);
                    }
                }), Instant::now() + Duration::from_secs(300));
            }
            // The server's timeout is only a hint. Bound our listener lifetime
            // and explicitly withdraw an expired or now-foreground notice.
            let _ = block_until(handle.close_async(), Instant::now() + Duration::from_secs(2));
        }
    });
    // A failed spawn drops its captured slot too.
    started.map(|_| ()).map_err(|_| ())
}

#[cfg(any(target_os = "linux", test))]
fn escape_markup(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(any(target_os = "linux", test))]
struct WorkerSlot<'a>(&'a std::sync::atomic::AtomicUsize);

#[cfg(any(target_os = "linux", test))]
impl<'a> WorkerSlot<'a> {
    fn acquire(counter: &'a std::sync::atomic::AtomicUsize, limit: usize) -> Option<Self> {
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < limit).then_some(count + 1)
            })
            .ok()
            .map(|_| Self(counter))
    }
}

#[cfg(any(target_os = "linux", test))]
impl Drop for WorkerSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(any(target_os = "linux", test))]
fn block_until<F: std::future::Future>(future: F, deadline: Instant) -> Option<F::Output> {
    use std::{
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };
    struct ThreadWake(thread::Thread);
    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return Some(value);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        thread::park_timeout(remaining);
    }
}

#[cfg(target_os = "macos")]
fn show(app: &tauri::AppHandle, notice: Notice) -> Result<(), ()> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if background(&handle) {
            unsafe {
                macos::show(&handle, notice);
            }
        }
    })
    .map_err(|_| ())
}

#[cfg(target_os = "macos")]
mod macos {
    // The cached notify-rust NSUserNotification backend waits synchronously and
    // ignores timeout. Use the same system API's asynchronous delegate instead;
    // one retained delegate replaces an unbounded set of waiting threads.
    use super::*;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        sync::Mutex,
    };

    type Id = *mut c_void;
    type Sel = *const c_void;
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_allocateClassPair(superclass: Id, name: *const c_char, extra: usize) -> Id;
        fn objc_registerClassPair(class: Id);
        fn class_addMethod(
            class: Id,
            selector: Sel,
            implementation: *const c_void,
            types: *const c_char,
        ) -> bool;
        fn objc_msgSend();
    }
    #[link(name = "Foundation", kind = "framework")]
    unsafe extern "C" {}

    struct Runtime {
        app: tauri::AppHandle,
        delegate: usize,
    }
    static RUNTIME: Mutex<Option<Runtime>> = Mutex::new(None);
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    unsafe fn selector(name: &'static [u8]) -> Sel {
        sel_registerName(name.as_ptr().cast())
    }
    unsafe fn send0<R>(receiver: Id, name: &'static [u8]) -> R {
        let send: unsafe extern "C" fn(Id, Sel) -> R =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector(name))
    }
    unsafe fn send1<A, R>(receiver: Id, name: &'static [u8], argument: A) -> R {
        let send: unsafe extern "C" fn(Id, Sel, A) -> R =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector(name), argument)
    }
    unsafe fn string(value: &str) -> Option<Id> {
        let value = CString::new(value).ok()?;
        let class = objc_getClass(c"NSString".as_ptr());
        let result: Id = send1(class, b"stringWithUTF8String:\0", value.as_ptr());
        (!result.is_null()).then_some(result)
    }
    struct Pool(Id);
    impl Drop for Pool {
        fn drop(&mut self) {
            unsafe {
                send0::<()>(self.0, b"drain\0");
            }
        }
    }
    struct Owned(Id);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                send0::<()>(self.0, b"release\0");
            }
        }
    }
    unsafe extern "C" fn should_present(_: Id, _: Sel, _: Id, _: Id) -> bool {
        !FOREGROUND.load(Ordering::Acquire)
    }
    unsafe extern "C" fn activated(_: Id, _: Sel, center: Id, notification: Id) {
        // Never unwind through an Objective-C callback boundary.
        let _ = std::panic::catch_unwind(|| {
            let info: Id = send0(notification, b"userInfo\0");
            let Some(key) = string("kaigen-target") else {
                return;
            };
            let json: Id = send1(info, b"objectForKey:\0", key);
            if json.is_null() {
                return;
            }
            let bytes: *const c_char = send0(json, b"UTF8String\0");
            if bytes.is_null() {
                return;
            }
            let Ok(target) = serde_json::from_slice::<Target>(CStr::from_ptr(bytes).to_bytes())
            else {
                return;
            };
            let valid = target.target == "requests"
                || target
                    .target
                    .strip_prefix("friend-key:")
                    .is_some_and(|key| {
                        key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
                    });
            if !valid {
                return;
            }
            let app = RUNTIME
                .lock()
                .ok()
                .and_then(|runtime| runtime.as_ref().map(|runtime| runtime.app.clone()));
            if let Some(app) = app {
                activate(&app, &target);
            }
            send1::<_, ()>(center, b"removeDeliveredNotification:\0", notification);
        });
    }

    pub(super) unsafe fn show(app: &tauri::AppHandle, notice: Notice) {
        let pool_class = objc_getClass(c"NSAutoreleasePool".as_ptr());
        let _pool = Pool(send0(pool_class, b"new\0"));
        let center_class = objc_getClass(c"NSUserNotificationCenter".as_ptr());
        let center: Id = send0(center_class, b"defaultUserNotificationCenter\0");
        if center.is_null() {
            return;
        }
        {
            let Ok(mut runtime) = RUNTIME.lock() else {
                return;
            };
            if runtime.is_none() {
                let name = c"KaigenMessageNotificationDelegate";
                let mut class = objc_getClass(name.as_ptr());
                if class.is_null() {
                    class = objc_allocateClassPair(
                        objc_getClass(c"NSObject".as_ptr()),
                        name.as_ptr(),
                        0,
                    );
                    if class.is_null() {
                        return;
                    }
                    class_addMethod(
                        class,
                        selector(b"userNotificationCenter:didActivateNotification:\0"),
                        activated as *const c_void,
                        c"v@:@@".as_ptr(),
                    );
                    class_addMethod(
                        class,
                        selector(b"userNotificationCenter:shouldPresentNotification:\0"),
                        should_present as *const c_void,
                        c"B@:@@".as_ptr(),
                    );
                    objc_registerClassPair(class);
                }
                let delegate: Id = send0(class, b"new\0");
                if delegate.is_null() {
                    return;
                }
                send1::<_, ()>(center, b"setDelegate:\0", delegate);
                *runtime = Some(Runtime {
                    app: app.clone(),
                    delegate: delegate as usize,
                });
            }
        }
        let notification_class = objc_getClass(c"NSUserNotification".as_ptr());
        let notification = Owned(send0(notification_class, b"new\0"));
        if notification.0.is_null() {
            return;
        }
        let (Some(title), Some(body), Ok(target)) = (
            string(&notice.title),
            string(&notice.body),
            serde_json::to_string(&notice.target),
        ) else {
            return;
        };
        let (Some(key), Some(target)) = (string("kaigen-target"), string(&target)) else {
            return;
        };
        let dictionary_class = objc_getClass(c"NSDictionary".as_ptr());
        let dictionary: unsafe extern "C" fn(Id, Sel, Id, Id) -> Id =
            std::mem::transmute(objc_msgSend as *const ());
        let info = dictionary(
            dictionary_class,
            selector(b"dictionaryWithObject:forKey:\0"),
            target,
            key,
        );
        send1::<_, ()>(notification.0, b"setTitle:\0", title);
        send1::<_, ()>(notification.0, b"setInformativeText:\0", body);
        send1::<_, ()>(notification.0, b"setUserInfo:\0", info);
        send1::<_, ()>(
            notification.0,
            b"setSoundName:\0",
            std::ptr::null_mut::<c_void>(),
        );
        if let Some(identifier) = string(&format!(
            "kaigen-{}",
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )) {
            send1::<_, ()>(notification.0, b"setIdentifier:\0", identifier);
        }
        let delivered: Id = send0(center, b"deliveredNotifications\0");
        let count: usize = send0(delivered, b"count\0");
        if count >= QUEUE_LIMIT {
            send0::<()>(center, b"removeAllDeliveredNotifications\0");
        }
        if !FOREGROUND.load(Ordering::Acquire) {
            send1::<_, ()>(center, b"deliverNotification:\0", notification.0);
        }
    }

    pub(super) fn shutdown(app: &tauri::AppHandle) {
        let _ = app.run_on_main_thread(|| unsafe {
            let runtime = RUNTIME.lock().ok().and_then(|mut runtime| runtime.take());
            if let Some(runtime) = runtime {
                let center: Id = send0(
                    objc_getClass(c"NSUserNotificationCenter".as_ptr()),
                    b"defaultUserNotificationCenter\0",
                );
                send1::<_, ()>(center, b"setDelegate:\0", std::ptr::null_mut::<c_void>());
                send0::<()>(runtime.delegate as Id, b"release\0");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_and_sound_require_explicit_per_profile_opt_in() {
        let defaults = Preferences::from_local_state(&serde_json::json!({}));
        assert!(!defaults.messages && !defaults.requests && !defaults.sound);
        let sound = Preferences::from_local_state(
            &serde_json::json!({"notifySound": true, "notificationVolume": 0.25}),
        );
        assert!(sound.sound && !sound.messages && !sound.requests);
        assert_eq!(sound.volume, 0.25);
        assert_eq!(
            Preferences::from_local_state(&serde_json::json!({"notificationVolume": 9})).volume,
            1.0
        );
        assert_eq!(
            Preferences::from_local_state(&serde_json::json!({"notificationVolume": -2})).volume,
            0.0
        );
    }

    #[test]
    fn click_targets_require_stable_contact_keys_and_excerpts_are_bounded_text() {
        let event = |key: &str| ProfileNotification::Message {
            friend_number: 7,
            friend_public_key: key.to_string(),
            message_id: "id".to_string(),
        };
        assert!(target_key(&event("")).is_none());
        assert!(target_key(&event("7")).is_none());
        assert_eq!(
            target_key(&event(&"ab".repeat(32))),
            Some(format!("friend-key:{}", "AB".repeat(32)))
        );
        assert_eq!(excerpt("  <script>\n hello  "), "<script> hello");
        assert_eq!(excerpt(&"Я".repeat(500)).chars().count(), 160);
    }

    fn pending(index: usize, message_id: &str) -> Pending {
        Pending {
            profile_id: "profile".to_string(),
            event: ProfileNotification::Message {
                friend_number: index as u32,
                friend_public_key: format!("{index:064X}"),
                message_id: message_id.to_string(),
            },
            received: Instant::now(),
        }
    }

    #[test]
    fn both_first_insert_and_continuous_drain_keep_the_queue_bounded() {
        let mut staged = HashMap::new();
        for index in 0..QUEUE_LIMIT * 2 {
            stage_pending(&mut staged, pending(index, "first"));
        }
        assert_eq!(staged.len(), QUEUE_LIMIT);
        stage_pending(&mut staged, pending(0, "latest"));
        assert!(staged.values().any(|item| matches!(&item.event, ProfileNotification::Message { message_id, .. } if message_id == "latest")));
        let (sender, receiver) = mpsc::channel();
        for index in 0..QUEUE_LIMIT * 2 {
            sender.send(pending(index, "queued")).unwrap();
        }
        staged.clear();
        assert_eq!(drain_pending(&receiver, &mut staged, 1), QUEUE_LIMIT);
        assert_eq!(staged.len(), QUEUE_LIMIT - 1);
        assert!(
            receiver.try_recv().is_ok(),
            "a busy producer leaves work for the next bounded iteration"
        );
    }

    #[test]
    fn action_wait_slots_are_released_on_normal_exit_and_panic() {
        use std::sync::atomic::AtomicUsize;
        let count = AtomicUsize::new(0);
        let slot = WorkerSlot::acquire(&count, 1).unwrap();
        assert!(WorkerSlot::acquire(&count, 1).is_none());
        drop(slot);
        assert_eq!(count.load(Ordering::Acquire), 0);
        let _ = std::panic::catch_unwind(|| {
            let _slot = WorkerSlot::acquire(&count, 1).unwrap();
            panic!("synthetic action-worker failure");
        });
        assert_eq!(count.load(Ordering::Acquire), 0);
    }

    #[test]
    fn action_wait_has_its_own_deadline_and_linux_body_remains_plain_text() {
        assert_eq!(block_until(std::future::ready(7), Instant::now()), Some(7));
        assert_eq!(
            block_until(
                std::future::pending::<()>(),
                Instant::now() + Duration::from_millis(10)
            ),
            None
        );
        assert_eq!(escape_markup("<b>A&B</b>"), "&lt;b&gt;A&amp;B&lt;/b&gt;");
    }
}
