//! Incoming events, independent of WebView visibility and the selected profile.
//! Native callbacks enqueue bounded identities only; one worker reads the exact
//! message and preferences after the chat transaction has released its locks.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex, OnceLock, Weak,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::webgate::{HopIdentity, RemoteProfile, StreamEvent};
use crate::webgate_notifications::{NotificationKind, NotificationProjection};
use crate::{AppState, ProfileNotification};

const QUEUE_LIMIT: usize = 64;
static QUEUE: OnceLock<SyncSender<Pending>> = OnceLock::new();
static FOREGROUND: AtomicBool = AtomicBool::new(true);

struct Pending {
    profile_id: String,
    event: PendingEvent,
    received: Instant,
}

enum PendingEvent {
    Native(ProfileNotification),
    Remote {
        projection: NotificationProjection,
        binding: String,
    },
}

#[derive(Clone)]
struct RemoteBinding {
    token: String,
    profile: Weak<RemoteProfile>,
    root: HopIdentity,
}

#[derive(Default)]
struct RemoteNotices {
    bindings: HashMap<String, RemoteBinding>,
    seen: HashSet<(String, String)>,
    order: VecDeque<(String, String)>,
}

static REMOTE_NOTICES: OnceLock<Mutex<RemoteNotices>> = OnceLock::new();

fn remote_notices() -> &'static Mutex<RemoteNotices> {
    REMOTE_NOTICES.get_or_init(|| Mutex::new(RemoteNotices::default()))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    profile_id: String,
    target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_binding: Option<String>,
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
            event: PendingEvent::Native(event),
            received: Instant::now(),
        });
    }
}

/// The callback receives an already authenticated, cursor-checked event.
/// Record receipt before focus suppression; replay must never create a late popup.
pub(super) fn notify_webgate_event(app: &tauri::AppHandle, profile_id: &str, event: &StreamEvent) {
    if event.event != "profile-changed" {
        return;
    }
    let Some(projection) = NotificationProjection::from_payload(&event.payload) else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(profile) = state.remote_profiles.get(profile_id) else {
        return;
    };
    if !profile.is_connected() {
        return;
    }
    let Some(root) = profile.cached_root_identity() else {
        return;
    };
    let Ok(root_key) = serde_json::to_string(&root) else {
        return;
    };
    let Ok(mut notices) = remote_notices().lock() else {
        return;
    };
    let weak = Arc::downgrade(&profile);
    let existing = notices.bindings.get(profile_id);
    let token = if let Some(binding) =
        existing.filter(|binding| binding.profile.ptr_eq(&weak) && binding.root == root)
    {
        binding.token.clone()
    } else {
        if notices.bindings.len() >= 1024 && existing.is_none() {
            return;
        }
        let Ok(token) = crate::webgate::new_operation_id() else {
            return;
        };
        notices.bindings.insert(
            profile_id.to_string(),
            RemoteBinding {
                token: token.clone(),
                profile: weak,
                root,
            },
        );
        token
    };
    let identity = (root_key, projection.event_id.clone());
    if !notices.seen.insert(identity.clone()) {
        return;
    }
    notices.order.push_back(identity);
    while notices.order.len() > 8192 {
        if let Some(old) = notices.order.pop_front() {
            notices.seen.remove(&old);
        }
    }
    drop(notices);
    if FOREGROUND.load(Ordering::Acquire) {
        return;
    }
    if let Some(queue) = QUEUE.get() {
        let _ = queue.try_send(Pending {
            profile_id: profile_id.to_string(),
            event: PendingEvent::Remote {
                projection,
                binding: token,
            },
            received: Instant::now(),
        });
    }
}

pub(super) fn forget_webgate_profile(profile_id: &str) {
    if let Ok(mut notices) = remote_notices().lock() {
        notices.bindings.remove(profile_id);
        let roots: HashSet<String> = notices
            .bindings
            .values()
            .filter_map(|binding| serde_json::to_string(&binding.root).ok())
            .collect();
        notices.seen.retain(|(root, _)| roots.contains(root));
        notices.order.retain(|(root, _)| roots.contains(root));
    }
}

fn available(app: &AppState, target: &Target) -> bool {
    let Some(token) = target.remote_binding.as_deref() else {
        return app.loaded_profile(&target.profile_id).is_ok();
    };
    // Do not hold the notification registry while taking host/session locks.
    let binding = remote_notices()
        .lock()
        .ok()
        .and_then(|notices| notices.bindings.get(&target.profile_id).cloned());
    let Some(binding) = binding.filter(|binding| binding.token == token) else {
        return false;
    };
    let Some(expected) = binding.profile.upgrade() else {
        return false;
    };
    let Some(current) = app.remote_profiles.get(&target.profile_id) else {
        return false;
    };
    Arc::ptr_eq(&expected, &current)
        && current.is_connected()
        && current.cached_root_identity().as_ref() == Some(&binding.root)
}

fn pending_target(event: &PendingEvent) -> Option<String> {
    match event {
        PendingEvent::Native(event) => target_key(event),
        PendingEvent::Remote { projection, .. } => projection.target_key(),
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
    if let Some(target) = pending_target(&item.event) {
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
                    if !background(&app) || !available(&state, &notice.target) {
                        continue;
                    }
                    if let Some(volume) = notice.volume.filter(|_| {
                        last_sound.is_none_or(|last| last.elapsed() >= Duration::from_millis(750))
                    }) {
                        let _ = app.emit_to("main", "kaigen-message-sound", volume);
                        last_sound = Some(Instant::now());
                    }
                    if notice.popup && background(&app) && available(&state, &notice.target) {
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
    let event = match &pending.event {
        PendingEvent::Native(event) => event,
        PendingEvent::Remote {
            projection,
            binding,
        } => {
            let target = Target {
                profile_id: pending.profile_id.clone(),
                target: projection.target_key()?,
                remote_binding: Some(binding.clone()),
            };
            if !available(app, &target) {
                return None;
            }
            let profile = app.remote_profiles.get(&pending.profile_id)?;
            let local = profile.cached_notification_preferences()?;
            let preferences = Preferences::from_local_state(&local);
            let ru = app.settings.lock().ok()?.language != "en";
            return match projection.kind {
                NotificationKind::Message => {
                    if !preferences.messages && (!preferences.sound || preferences.volume == 0.0) {
                        return None;
                    }
                    Some(Notice {
                        target,
                        title: if projection.title.is_empty() {
                            if ru { "Контакт" } else { "Contact" }.to_string()
                        } else {
                            excerpt(&projection.title)
                        },
                        body: excerpt(&projection.body),
                        popup: preferences.messages,
                        volume: (preferences.sound && preferences.volume > 0.0)
                            .then_some(preferences.volume),
                    })
                }
                NotificationKind::Request => preferences.requests.then(|| Notice {
                    target,
                    title: if ru {
                        "Запрос в контакты"
                    } else {
                        "Contact request"
                    }
                    .to_string(),
                    body: excerpt(&projection.body),
                    popup: true,
                    volume: None,
                }),
            };
        }
    };
    let state = app.loaded_profile(&pending.profile_id).ok()?;
    let local_path = state.history_path.parent()?.join("local-state.json");
    let bytes = crate::profiles::read_file(&local_path).ok()?;
    let local: Value = serde_json::from_slice(&bytes).ok()?;
    let preferences = Preferences::from_local_state(&local);
    let ru = app.settings.lock().ok()?.language != "en";
    let target = Target {
        profile_id: pending.profile_id.clone(),
        target: target_key(event)?,
        remote_binding: None,
    };
    match event {
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
    if !available(&state, target) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if available(&state, target) {
            let _ = window.emit("kaigen-notification-activate", target);
        }
    }
}

#[cfg(target_os = "windows")]
fn show(app: &tauri::AppHandle, notice: Notice) -> Result<(), ()> {
    use tauri_winrt_notification::{Duration as ToastDuration, Toast};
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
    use std::{marker::PhantomData, mem::ManuallyDrop, path::PathBuf, rc::Rc, sync::OnceLock};
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

    struct Apartment(PhantomData<Rc<()>>);
    impl Apartment {
        fn new() -> Option<Self> {
            // SAFETY: Both success statuses require one balanced uninitialize
            // on the same thread. The marker prevents moving the guard.
            unsafe {
                RoInitialize(RO_INIT_MULTITHREADED)
                    .ok()
                    .map(|_| Self(PhantomData))
            }
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: Only successful initialization constructs this guard.
            unsafe {
                RoUninitialize();
            }
        }
    }
    thread_local! { static APARTMENT: Option<Apartment> = Apartment::new(); }
    pub(super) fn register(identifier: &str) -> Result<String, ()> {
        APARTMENT.with(|apartment| register_initialized(apartment.as_ref().ok_or(())?, identifier))
    }

    struct ShellPath(PWSTR);
    impl Drop for ShellPath {
        fn drop(&mut self) {
            // SAFETY: SHGetKnownFolderPath transfers one COM allocation.
            unsafe {
                CoTaskMemFree(Some(self.0.as_ptr().cast()));
            }
        }
    }

    fn register_initialized(_apartment: &Apartment, identifier: &str) -> Result<String, ()> {
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
        // SAFETY: This runs in the initialized notification apartment.
        // COM interfaces and all borrowed string buffers remain live until use.
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
        struct RegistryKey(HKEY);
        impl Drop for RegistryKey {
            fn drop(&mut self) {
                // SAFETY: This guard owns a successful RegCreateKeyExW result.
                unsafe { RegCloseKey(self.0) };
            }
        }
        let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let path = wide(&format!("Software\\Classes\\AppUserModelId\\{app_id}"));
        let mut key = std::ptr::null_mut();
        // SAFETY: The path is NUL-terminated and the output is a live HKEY slot.
        if unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        } != 0
        {
            return Err(());
        }
        let key = RegistryKey(key);
        let name = wide("DisplayName");
        let value = wide("Kaigen");
        // SAFETY: The key is owned and both UTF-16 buffers stay live.
        let result = unsafe {
            RegSetValueExW(
                key.0,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        if result != 0 {
            return Err(());
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
    macos::show(app, notice)
}

#[cfg(target_os = "macos")]
mod macos {
    // The cached notify-rust NSUserNotification backend waits synchronously and
    // ignores timeout. Use the same system API's asynchronous delegate instead;
    // one retained delegate replaces an unbounded set of waiting threads.
    use super::*;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        marker::PhantomData,
        rc::Rc,
        sync::Mutex,
    };

    struct MainThread(PhantomData<Rc<()>>);

    impl MainThread {
        fn current() -> Option<Self> {
            // SAFETY: pthread_main_np reads the identity of the calling thread.
            (unsafe { libc::pthread_main_np() } != 0).then_some(Self(PhantomData))
        }
    }

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

    /// Registers a NUL-terminated Objective-C selector.
    fn selector(name: &'static CStr) -> Sel {
        // SAFETY: The runtime receives a live, NUL-terminated selector name.
        unsafe { sel_registerName(name.as_ptr()) }
    }
    /// # Safety
    ///
    /// The receiver must be valid for this selector, and R must match the
    /// Objective-C method's ABI result type.
    unsafe fn send0<R>(receiver: Id, name: &'static CStr) -> R {
        let send: unsafe extern "C" fn(Id, Sel) -> R =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { send(receiver, selector(name)) }
    }
    /// # Safety
    ///
    /// The receiver must be valid for this selector, and A and R must match
    /// the Objective-C method's ABI argument and result types.
    unsafe fn send1<A, R>(receiver: Id, name: &'static CStr, argument: A) -> R {
        let send: unsafe extern "C" fn(Id, Sel, A) -> R =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { send(receiver, selector(name), argument) }
    }
    /// Creates an autoreleased NSString inside the active pool or callback.
    fn string(value: &str) -> Option<Id> {
        let value = CString::new(value).ok()?;
        // SAFETY: The Foundation class method copies this valid UTF-8 C string.
        let result: Id = unsafe {
            let class = objc_getClass(c"NSString".as_ptr());
            send1(class, c"stringWithUTF8String:", value.as_ptr())
        };
        (!result.is_null()).then_some(result)
    }
    struct Pool(Id);
    impl Drop for Pool {
        fn drop(&mut self) {
            // SAFETY: Only a main-thread pool constructed with +new is stored here.
            unsafe {
                send0::<()>(self.0, c"drain");
            }
        }
    }
    struct Owned(Id);
    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: The stored notification is +1 retained, or nil (a no-op).
            unsafe {
                send0::<()>(self.0, c"release");
            }
        }
    }
    extern "C" fn should_present(_: Id, _: Sel, _: Id, _: Id) -> bool {
        !FOREGROUND.load(Ordering::Acquire)
    }

    /// Reads an owned Rust target while Foundation still owns its callback objects.
    ///
    /// # Safety
    ///
    /// notification must be the live NSUserNotification supplied to the delegate.
    unsafe fn read_target(notification: Id) -> Option<Target> {
        let key = string("kaigen-target")?;
        // SAFETY: Foundation provides a typed notification and its dictionary.
        // Check the value's class before calling NSString's UTF8String method.
        // The callback keeps the string and its UTF-8 buffer live until decoding.
        unsafe {
            let info: Id = send0(notification, c"userInfo");
            let value: Id = send1(info, c"objectForKey:", key);
            if value.is_null() {
                return None;
            }
            let string_class = objc_getClass(c"NSString".as_ptr());
            // Read the one-byte BOOL as a byte on both Apple architectures.
            if string_class.is_null() || send1::<_, u8>(value, c"isKindOfClass:", string_class) == 0
            {
                return None;
            }
            let bytes: *const c_char = send0(value, c"UTF8String");
            if bytes.is_null() {
                return None;
            }
            serde_json::from_slice(CStr::from_ptr(bytes).to_bytes()).ok()
        }
    }

    unsafe extern "C" fn activated(_: Id, _: Sel, center: Id, notification: Id) {
        // Never unwind through an Objective-C callback boundary.
        let _ = std::panic::catch_unwind(|| {
            // SAFETY: Foundation supplies the live callback notification.
            let Some(target) = (unsafe { read_target(notification) }) else {
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
            // SAFETY: Both callback objects are still live.
            unsafe { send1::<_, ()>(center, c"removeDeliveredNotification:", notification) };
        });
    }

    pub(super) fn show(app: &tauri::AppHandle, notice: Notice) -> Result<(), ()> {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            if background(&handle) {
                if let Some(thread) = MainThread::current() {
                    deliver(&thread, &handle, notice);
                }
            }
        })
        .map_err(|_| ())
    }

    fn deliver(_thread: &MainThread, app: &tauri::AppHandle, notice: Notice) {
        // SAFETY: The thread-bound proof restricts the notification center to
        // its main thread. The selected Objective-C classes and signatures match
        // Foundation, and the pool and owned notification cover their lifetimes.
        unsafe {
            let pool_class = objc_getClass(c"NSAutoreleasePool".as_ptr());
            let _pool = Pool(send0(pool_class, c"new"));
            let center_class = objc_getClass(c"NSUserNotificationCenter".as_ptr());
            let center: Id = send0(center_class, c"defaultUserNotificationCenter");
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
                            selector(c"userNotificationCenter:didActivateNotification:"),
                            activated as *const c_void,
                            c"v@:@@".as_ptr(),
                        );
                        class_addMethod(
                            class,
                            selector(c"userNotificationCenter:shouldPresentNotification:"),
                            should_present as *const c_void,
                            c"B@:@@".as_ptr(),
                        );
                        objc_registerClassPair(class);
                    }
                    let delegate: Id = send0(class, c"new");
                    if delegate.is_null() {
                        return;
                    }
                    send1::<_, ()>(center, c"setDelegate:", delegate);
                    *runtime = Some(Runtime {
                        app: app.clone(),
                        delegate: delegate.expose_provenance(),
                    });
                }
            }
            let notification_class = objc_getClass(c"NSUserNotification".as_ptr());
            let notification = Owned(send0(notification_class, c"new"));
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
            // SAFETY: NSDictionary's class method takes two objects and returns one.
            let dictionary: unsafe extern "C" fn(Id, Sel, Id, Id) -> Id =
                std::mem::transmute(objc_msgSend as *const ());
            let info = dictionary(
                dictionary_class,
                selector(c"dictionaryWithObject:forKey:"),
                target,
                key,
            );
            send1::<_, ()>(notification.0, c"setTitle:", title);
            send1::<_, ()>(notification.0, c"setInformativeText:", body);
            send1::<_, ()>(notification.0, c"setUserInfo:", info);
            send1::<_, ()>(
                notification.0,
                c"setSoundName:",
                std::ptr::null_mut::<c_void>(),
            );
            if let Some(identifier) = string(&format!(
                "kaigen-{}",
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            )) {
                send1::<_, ()>(notification.0, c"setIdentifier:", identifier);
            }
            let delivered: Id = send0(center, c"deliveredNotifications");
            let count: usize = send0(delivered, c"count");
            if count >= QUEUE_LIMIT {
                send0::<()>(center, c"removeAllDeliveredNotifications");
            }
            if !FOREGROUND.load(Ordering::Acquire) {
                send1::<_, ()>(center, c"deliverNotification:", notification.0);
            }
        }
    }

    pub(super) fn shutdown(app: &tauri::AppHandle) {
        let _ = app.run_on_main_thread(|| {
            if let Some(thread) = MainThread::current() {
                release_delegate(&thread);
            }
        });
    }

    fn release_delegate(_thread: &MainThread) {
        let runtime = RUNTIME.lock().ok().and_then(|mut runtime| runtime.take());
        if let Some(runtime) = runtime {
            // SAFETY: The delegate is retained by Runtime. Detach it on the
            // same main thread before relinquishing that ownership.
            unsafe {
                let center: Id = send0(
                    objc_getClass(c"NSUserNotificationCenter".as_ptr()),
                    c"defaultUserNotificationCenter",
                );
                send1::<_, ()>(center, c"setDelegate:", std::ptr::null_mut::<c_void>());
                send0::<()>(
                    std::ptr::with_exposed_provenance_mut::<c_void>(runtime.delegate),
                    c"release",
                );
            }
        }
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
            event: PendingEvent::Native(ProfileNotification::Message {
                friend_number: index as u32,
                friend_public_key: format!("{index:064X}"),
                message_id: message_id.to_string(),
            }),
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
        assert!(staged.values().any(|item| matches!(&item.event, PendingEvent::Native(ProfileNotification::Message { message_id, .. }) if message_id == "latest")));
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
