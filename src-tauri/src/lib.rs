#![cfg_attr(
    all(feature = "web-core", not(feature = "desktop")),
    allow(dead_code, unused_imports)
)]

use std::{
    collections::{HashMap, HashSet},
    ffi::c_void,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc::{self, RecvTimeoutError, Sender, SyncSender},
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
use sha2::{Digest, Sha256};
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

mod chat_history_store;
mod chat_protocol;
#[cfg(all(test, feature = "desktop"))]
mod chat_transport_loopback;
mod file_card_protocol;
#[cfg(feature = "desktop")]
mod instance;
mod kai;
#[cfg(feature = "desktop")]
mod native_file_grants;
mod pq;
pub mod product;
#[cfg(all(feature = "web-core", not(feature = "desktop")))]
mod profile_identity;
mod profiles;
mod qtox_history;
mod qtox_zip;
#[cfg(any(feature = "desktop", feature = "web-core"))]
mod qtox_zip_import;
mod tor;
#[cfg(feature = "web-core")]
pub mod web_core;
#[cfg(feature = "web-core")]
pub mod web_transfer_store;
#[cfg(feature = "desktop")]
mod webview_recovery;
use chat_protocol::{
    ChatProtocolEngine, ChatQuote, IncomingPacket as IncomingChatPacket, MessageEnvelope,
    PeerReactionEvent, ReactionAckStatus, ReactionCode, ReactionView, TextFormatSpan,
};
use file_card_protocol::{
    FileCardAckStatus, FileCardDirection, FileCardEngine, IncomingFileCardPacket,
};
#[cfg(feature = "desktop")]
use instance::{InstanceGuard, InstanceOutcome, ProfileIdentityGuard};
use kai::KaiProfileVolume;
#[cfg(feature = "desktop")]
use native_file_grants::{
    NativeFileBatchSelection, NativeFileCandidate, NativeFileGrantStore, NativeFileRejection,
};
use pq::{PqEngine, PqSessionEvent, PqStatus};
#[cfg(all(feature = "web-core", not(feature = "desktop")))]
use profile_identity::ProfileIdentityGuard;
use profiles::{atomic_write, ProfileCipher, ProfileRecord, ProfileRegistry};
use tor::{TorManager, TorSettings, TorStatus};

pub fn lock_sensitive_process_memory() -> Result<(), String> {
    kai::lock_process_memory()
}

pub(crate) fn commit_chat_transaction(path: &Path) -> Result<(), String> {
    profiles::checkpoint_managed_volume(path).map_err(|_| "CHAT_DURABLE_COMMIT_FAILED".to_string())
}

fn commit_chat_transaction_with_barrier(
    path: &Path,
    transport_ready: &AtomicBool,
) -> Result<(), String> {
    finish_chat_transaction_with(transport_ready, || commit_chat_transaction(path))
}

fn finish_chat_transaction_with<F>(transport_ready: &AtomicBool, commit: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    match commit() {
        Ok(()) => {
            transport_ready.store(true, Ordering::Release);
            Ok(())
        }
        Err(error) => {
            transport_ready.store(false, Ordering::Release);
            Err(error)
        }
    }
}

/// An engine call may reject after durably rebasing its rollback-safe clock.
/// Commit that possible maintenance mutation before returning the semantic
/// error; a successful value remains unpublished until the caller writes the
/// rest of the logical transaction and invokes the final commit boundary.
fn stage_chat_mutation_result<T>(
    path: &Path,
    transport_ready: &AtomicBool,
    result: Result<T, String>,
) -> Result<T, String> {
    stage_chat_mutation_result_with(transport_ready, result, || commit_chat_transaction(path))
}

fn stage_chat_mutation_result_with<T, F>(
    transport_ready: &AtomicBool,
    result: Result<T, String>,
    commit: F,
) -> Result<T, String>
where
    F: FnOnce() -> Result<(), String>,
{
    match result {
        Ok(value) => {
            transport_ready.store(false, Ordering::Release);
            Ok(value)
        }
        Err(error) => {
            finish_chat_transaction_with(transport_ready, commit)?;
            Err(error)
        }
    }
}

/// Resolve every handle-backed recipient identity before taking the durable
/// chat transaction gate. The network loop uses the opposite side of this
/// boundary while it already owns the tox handle, so keeping this order
/// explicit prevents handle/gate inversion in command paths.
fn resolve_then_lock_chat_transaction<'a, T, F>(
    gate: &'a Mutex<()>,
    resolve: F,
) -> Result<(T, std::sync::MutexGuard<'a, ()>), String>
where
    F: FnOnce() -> Result<T, String>,
{
    let resolved = resolve()?;
    let transaction = gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    Ok((resolved, transaction))
}

fn lock_chat_transaction_for_friend(
    state: &ToxState,
    friend_number: u32,
) -> Result<(String, std::sync::MutexGuard<'_, ()>), String> {
    let ((friend_public_key, owner), transaction) =
        resolve_then_lock_chat_transaction(&state.chat_transaction_gate, || {
            let friend_public_key = state.stable_friend_public_key(friend_number);
            if friend_public_key.is_empty() {
                Err("FRIEND_NOT_FOUND".to_string())
            } else {
                Ok((
                    friend_public_key,
                    state
                        .self_public_key()
                        .ok_or("PROFILE_IDENTITY_UNAVAILABLE")?,
                ))
            }
        })?;
    bind_pq_contact(
        &state.pq,
        &state.messages,
        &state.history_path,
        friend_number,
        &friend_public_key,
        &owner,
    )?;
    Ok((friend_public_key, transaction))
}

#[cfg(test)]
fn change_protocol_connection_under_chat_gate(
    pq: &PqEngine,
    chat_protocol: &ChatProtocolEngine,
    gate: &Mutex<()>,
    friend_number: u32,
    online: bool,
) -> Result<(), String> {
    let _transaction = gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    change_protocol_connection_locked(pq, chat_protocol, friend_number, online)
}

fn change_callback_protocol_connection_under_chat_gate(
    pq: &PqEngine,
    chat_protocol: &ChatProtocolEngine,
    gate: &Mutex<()>,
    network_enabled: &AtomicBool,
    friend_number: u32,
    raw_online: bool,
) -> Result<(), String> {
    let _transaction = gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    let online = raw_online && network_enabled.load(Ordering::Acquire);
    change_protocol_connection_locked(pq, chat_protocol, friend_number, online)
}

fn change_protocol_connection_locked(
    pq: &PqEngine,
    chat_protocol: &ChatProtocolEngine,
    friend_number: u32,
    online: bool,
) -> Result<(), String> {
    pq.connection_changed(friend_number, online)?;
    if online {
        pq.queue(friend_number, [pq.capability_packet()]);
        chat_protocol.queue_packet(friend_number, chat_protocol.capability_packet());
    } else {
        chat_protocol.disconnected(friend_number);
    }
    Ok(())
}

#[inline]
fn local_transport_ready(state: &ToxState) -> bool {
    state.network_enabled.load(Ordering::Acquire) && state.tor.is_ready()
}

fn change_local_transport_under_chat_gate(
    state: &ToxState,
    friend_numbers: &[u32],
    enabled: bool,
) -> Result<(), String> {
    let _transaction = state
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    state.network_enabled.store(enabled, Ordering::Release);
    if !enabled {
        state.connection.store(0, Ordering::Release);
    }
    for friend_number in friend_numbers {
        change_protocol_connection_locked(
            &state.pq,
            &state.chat_protocol,
            *friend_number,
            enabled,
        )?;
    }
    Ok(())
}

#[cfg(test)]
std::thread_local! {
    static SEND_AFTER_PQ_DECISION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn set_send_after_pq_decision_hook(hook: impl FnOnce() + 'static) {
    SEND_AFTER_PQ_DECISION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[inline]
fn run_send_after_pq_decision_hook() {
    #[cfg(test)]
    SEND_AFTER_PQ_DECISION_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

fn bind_pq_contact(
    pq: &PqEngine,
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    history: &Path,
    friend: u32,
    public_key: &str,
    owner: &str,
) -> Result<(), String> {
    if pq.contact_bound(friend, public_key) {
        return Ok(());
    }
    let existing = if chat_history_store::contains_registered(history) {
        !chat_history_store::latest_user_registered(history, friend, public_key, 1)?.is_empty()
    } else {
        messages
            .lock()
            .map_err(|_| "CHAT_HISTORY_LOCK_POISONED")?
            .iter()
            .any(|m| m.event.is_none() && message_matches_friend(m, friend, public_key))
    };
    pq.bind_contact(friend, public_key, owner, existing)
}

fn pq_tox_owner(tox: *const c_void) -> String {
    let mut address = [0u8; 38];
    unsafe { tox_self_get_address(tox, address.as_mut_ptr()) };
    hex_upper(&address[..32])
}

#[cfg(test)]
mod chat_transaction_barrier_tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn rejection_failure_and_retry_keep_transport_publication_ordered() {
        let ready = Arc::new(AtomicBool::new(true));

        let clean = stage_chat_mutation_result_with::<(), _>(
            &ready,
            Err("CLEAN_REJECT".to_string()),
            || Ok(()),
        );
        assert_eq!(clean.unwrap_err(), "CLEAN_REJECT");
        assert!(ready.load(Ordering::Acquire));

        let maintenance_was_committed = Arc::new(AtomicBool::new(false));
        let committed = Arc::clone(&maintenance_was_committed);
        let dirty = stage_chat_mutation_result_with::<(), _>(
            &ready,
            Err("DIRTY_REJECT".to_string()),
            move || {
                committed.store(true, Ordering::Release);
                Ok(())
            },
        );
        assert_eq!(dirty.unwrap_err(), "DIRTY_REJECT");
        assert!(maintenance_was_committed.load(Ordering::Acquire));
        assert!(ready.load(Ordering::Acquire));

        let gate = Arc::new(Mutex::new(()));
        let transaction = gate.lock().unwrap();
        assert_eq!(
            stage_chat_mutation_result_with(&ready, Ok(7_u8), || Ok(())).unwrap(),
            7
        );
        let (observed_sender, observed_receiver) = mpsc::sync_channel(1);
        let flush_gate = Arc::clone(&gate);
        let flush_ready = Arc::clone(&ready);
        let flush = thread::spawn(move || {
            let _flush_guard = flush_gate.lock().unwrap();
            observed_sender
                .send(flush_ready.load(Ordering::Acquire))
                .unwrap();
        });
        assert!(observed_receiver
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        assert_eq!(
            finish_chat_transaction_with(&ready, || Err("CHECKPOINT_FAILED".to_string()))
                .unwrap_err(),
            "CHECKPOINT_FAILED"
        );
        drop(transaction);
        assert!(!observed_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap());
        flush.join().unwrap();

        let retry = gate.lock().unwrap();
        finish_chat_transaction_with(&ready, || Ok(())).unwrap();
        drop(retry);
        let publish = gate.lock().unwrap();
        assert!(ready.load(Ordering::Acquire));
        drop(publish);

        // The network side owns the simulated tox handle before waiting for
        // the publication gate. A command must resolve through that handle
        // before it can own the gate, otherwise these two threads deadlock.
        let handle = Arc::new(Mutex::new(()));
        let gate = Arc::new(Mutex::new(()));
        let handle_guard = handle.lock().unwrap();
        let (resolver_entered_tx, resolver_entered_rx) = mpsc::sync_channel(1);
        let (command_done_tx, command_done_rx) = mpsc::sync_channel(1);
        let command_handle = Arc::clone(&handle);
        let command_gate = Arc::clone(&gate);
        let command = thread::spawn(move || {
            let (_resolved, _gate) = resolve_then_lock_chat_transaction(&command_gate, || {
                resolver_entered_tx.send(()).unwrap();
                let _handle = command_handle.lock().unwrap();
                Ok::<_, String>("friend-key")
            })
            .unwrap();
            command_done_tx.send(()).unwrap();
        });
        resolver_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let network_gate = gate.try_lock().expect(
            "the command must not own the transaction gate while recipient resolution waits",
        );
        assert!(command_done_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        drop(network_gate);
        drop(handle_guard);
        command_done_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        command.join().unwrap();
    }
}

#[cfg(test)]
mod deferred_persistence_tests;
#[cfg(test)]
mod pq_delivery_tests;

pub fn encode_qtox_profile_archive(protected_savedata: Vec<u8>) -> Result<Vec<u8>, String> {
    qtox_zip::encode(vec![
        qtox_zip::ZipEntry {
            name: "kaigen-profile.tox".to_string(),
            bytes: protected_savedata,
        },
        qtox_zip::ZipEntry {
            name: "README.txt".to_string(),
            bytes: b"qTox-compatible password-protected Tox profile exported by Kaigen. Extract the archive before importing the .tox file.\r\n".to_vec(),
        },
    ])
}

#[cfg(any(feature = "desktop", feature = "web-core"))]
pub use qtox_zip_import::QtoxZipImportMaterial;

#[cfg(any(feature = "desktop", feature = "web-core"))]
pub fn read_qtox_zip_import(
    archive_path: &Path,
    password: Option<&str>,
) -> Result<QtoxZipImportMaterial, String> {
    qtox_zip_import::read_material(archive_path, password)
}

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
    volume: Option<Arc<KaiProfileVolume>>,
}

fn is_kai_profile_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("kai"))
}

fn copy_directory_into_volume(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Ok(());
    }
    profiles::create_dir_all(destination)?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read legacy profile data: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not read legacy profile data: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect legacy profile data: {error}"))?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err("LEGACY_PROFILE_SYMLINK_FORBIDDEN".to_string());
        }
        if file_type.is_dir() {
            copy_directory_into_volume(&entry.path(), &target)?;
        } else if file_type.is_file() {
            let mut bytes = fs::read(entry.path())
                .map_err(|error| format!("Could not read legacy profile data: {error}"))?;
            let result = profiles::write_file(&target, &bytes);
            wipe_sensitive_bytes(&mut bytes);
            result?;
        }
    }
    Ok(())
}

impl PortablePaths {
    #[cfg(feature = "desktop")]
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
        Self::new_with_volume(root_dir, data_dir, profile_path, None)
    }

    fn new_with_volume(
        root_dir: PathBuf,
        data_dir: PathBuf,
        profile_path: PathBuf,
        volume: Option<Arc<KaiProfileVolume>>,
    ) -> Result<Self, String> {
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
            profiles::create_dir_all(directory).map_err(|error| {
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
            volume,
        })
    }
}

#[cfg(all(feature = "desktop", target_os = "windows"))]
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

#[cfg(feature = "desktop")]
fn portable_webview_data_dir(paths: &PortablePaths) -> PathBuf {
    paths.data_dir.join("webview2")
}

#[cfg(any(all(feature = "desktop", target_os = "windows"), test))]
const WEBVIEW2_RUNTIME_PATH_LIMIT_UTF16_UNITS: usize = 260;

#[cfg(any(all(feature = "desktop", target_os = "windows"), test))]
const WEBVIEW2_RUNTIME_PATH_MARKER: &str = "KAIGEN_MAX_RELATIVE_PATH_UTF16.txt";

#[cfg(any(all(feature = "desktop", target_os = "windows"), test))]
fn parse_webview2_runtime_max_relative_path(value: &str) -> Result<usize, String> {
    value
        .trim()
        .parse::<usize>()
        .map_err(|_| "The packaged WebView2 runtime path marker is invalid.".to_string())
}

#[cfg(any(all(feature = "desktop", target_os = "windows"), test))]
fn webview2_runtime_paths_fit(runtime_dir_utf16_units: usize, max_relative_path: usize) -> bool {
    runtime_dir_utf16_units
        .checked_add(1)
        .and_then(|length| length.checked_add(max_relative_path))
        .is_some_and(|length| length < WEBVIEW2_RUNTIME_PATH_LIMIT_UTF16_UNITS)
}

#[cfg(all(feature = "desktop", target_os = "windows"))]
fn configure_portable_webview() -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    let paths = PortablePaths::discover()?;
    let runtime_root = paths.root_dir.join("WebView2Runtime");
    let runtime_executable = runtime_root.join("msedgewebview2.exe");
    if !runtime_executable.is_file() {
        let nested_runtime = fs::read_dir(&runtime_root).ok().and_then(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| path.is_dir() && path.join("msedgewebview2.exe").is_file())
        });
        if nested_runtime.is_some() {
            return Err(
                "This Kaigen package has an obsolete nested WebView2 runtime layout that can crash into a blank window on long paths. Replace the complete portable folder with the current package."
                    .to_string(),
            );
        }
        if runtime_root.exists() {
            return Err(format!(
                "The portable WebView2 runtime is incomplete: {} is missing.",
                runtime_executable.display()
            ));
        }
        std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
    } else {
        let marker_path = runtime_root.join(WEBVIEW2_RUNTIME_PATH_MARKER);
        let max_relative_path = parse_webview2_runtime_max_relative_path(
            &fs::read_to_string(&marker_path).map_err(|error| {
                format!(
                    "Could not read the portable WebView2 runtime path marker {}: {error}",
                    marker_path.display()
                )
            })?,
        )?;
        let runtime_dir_utf16_units = runtime_root.as_os_str().encode_wide().count();
        if !webview2_runtime_paths_fit(runtime_dir_utf16_units, max_relative_path) {
            let maximum_path_length = runtime_dir_utf16_units
                .saturating_add(1)
                .saturating_add(max_relative_path);
            return Err(format!(
                "The portable WebView2 runtime path is too long ({maximum_path_length} UTF-16 units; maximum 259). Move the complete Kaigen folder to a shorter local path."
            ));
        }
        grant_webview2_runtime_access(&runtime_root);
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &runtime_root);
    }

    let user_data_dir = portable_webview_data_dir(&paths);
    fs::create_dir_all(&user_data_dir).map_err(|error| {
        format!(
            "Could not create portable WebView2 data directory {}: {error}",
            user_data_dir.display()
        )
    })?;
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &user_data_dir);

    Ok(())
}

#[cfg(all(feature = "desktop", not(target_os = "windows")))]
fn configure_portable_webview() -> Result<(), String> {
    // Linux uses the WebKitGTK runtime bundled by AppImage and macOS uses the
    // system WebKit framework. Neither platform must inherit Windows WebView2
    // environment variables from a launcher or parent process.
    std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
    std::env::remove_var("WEBVIEW2_USER_DATA_FOLDER");
    #[cfg(target_os = "linux")]
    if should_default_linux_dmabuf_renderer(
        std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").as_deref(),
    ) {
        // WebKitGTK's DMA-BUF renderer can create a fully interactive but
        // invisible WebView on otherwise supported Linux GPU/session pairs.
        // Apply the safe AppImage default before Tauri creates WebKit, while
        // preserving an explicit user/launcher override (including `0`).
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    Ok(())
}

#[cfg(any(all(feature = "desktop", target_os = "linux"), test))]
fn should_default_linux_dmabuf_renderer(explicit: Option<&std::ffi::OsStr>) -> bool {
    explicit.is_none()
}

fn rebase_portable_file(stored_path: &str, directory: &Path) -> String {
    // Web attachments name retained storage objects, not portable disk files.
    if stored_path.starts_with("browser-stream://") {
        return stored_path.to_string();
    }
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
    if !profiles::file_exists(&direct) {
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
        if !profiles::file_exists(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn is_complete_avatar(path: &Path, expected_size: Option<u64>) -> bool {
    let Ok(length) = profiles::metadata_len(path) else {
        return false;
    };
    if length == 0 || expected_size.is_some_and(|size| length != size) {
        return false;
    }
    let Ok(bytes) = profiles::read_file(path) else {
        return false;
    };
    let mut header = [0_u8; 12];
    let read = bytes.len().min(header.len());
    header[..read].copy_from_slice(&bytes[..read]);
    (read >= 8 && header[..8] == [137, 80, 78, 71, 13, 10, 26, 10])
        || (read >= 3 && header[..3] == [0xff, 0xd8, 0xff])
        || (read >= 6 && (&header[..6] == b"GIF87a" || &header[..6] == b"GIF89a"))
        || (read >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP")
}

fn create_transfer_file(path: &Path) -> Result<(), String> {
    if kai::managed_volume(path).is_some() {
        return profiles::write_file(path, &[]);
    }
    File::create(path)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn write_transfer_chunk(
    path: &Path,
    buffered_target: Option<&Arc<Mutex<Vec<u8>>>>,
    expected_size: u64,
    position: u64,
    bytes: &[u8],
) -> Result<(), String> {
    let start = usize::try_from(position).map_err(|_| "FILE_OFFSET_INVALID".to_string())?;
    let end = start
        .checked_add(bytes.len())
        .ok_or_else(|| "FILE_OFFSET_INVALID".to_string())?;
    if end as u64 > expected_size {
        return Err("FILE_RANGE_INVALID".to_string());
    }
    if let Some(target) = buffered_target {
        let mut contents = target
            .lock()
            .map_err(|_| "FILE_TRANSFER_BUFFER_UNAVAILABLE".to_string())?;
        if contents.len() < end {
            let additional = end - contents.len();
            contents
                .try_reserve_exact(additional)
                .map_err(|_| "FILE_TRANSFER_BUFFER_EXHAUSTED".to_string())?;
            contents.resize(end, 0);
        }
        contents[start..end].copy_from_slice(bytes);
        return Ok(());
    }
    let mut file = File::options()
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(position))
        .and_then(|_| file.write_all(bytes))
        .map_err(|error| error.to_string())
}

fn read_file_range(path: &Path, position: u64, length: usize) -> Result<Vec<u8>, String> {
    if kai::managed_volume(path).is_some() {
        let contents = profiles::read_file(path)?;
        let start = usize::try_from(position).map_err(|_| "FILE_OFFSET_INVALID".to_string())?;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= contents.len())
            .ok_or_else(|| "FILE_RANGE_INVALID".to_string())?;
        return Ok(contents[start..end].to_vec());
    }
    let mut data = vec![0_u8; length];
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(position))
        .and_then(|_| file.read_exact(&mut data))
        .map_err(|error| error.to_string())?;
    Ok(data)
}

fn prepare_outgoing_source(
    path: &Path,
    expected_size: u64,
) -> Result<([u8; 32], Option<Arc<Vec<u8>>>), String> {
    if kai::managed_volume(path).is_some() {
        let bytes = profiles::read_file(path)?;
        if bytes.len() as u64 != expected_size {
            return Err(format!(
                "FILE_SIZE_CHANGED expected={expected_size} actual={}",
                bytes.len()
            ));
        }
        let digest = Sha256::digest(&bytes);
        let mut file_id = [0_u8; 32];
        file_id.copy_from_slice(&digest);
        return Ok((file_id, Some(Arc::new(bytes))));
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() != expected_size {
        return Err(format!(
            "FILE_SIZE_CHANGED expected={expected_size} actual={}",
            metadata.len()
        ));
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut file_id = [0_u8; 32];
    file_id.copy_from_slice(&digest);
    Ok((file_id, None))
}

fn remove_friend_avatars(directory: &Path, friend_number: u32, except: Option<&Path>) {
    let prefix = format!("{friend_number}-");
    let Ok(entries) = profiles::list(directory) else {
        return;
    };
    for entry in entries {
        let path = entry.path;
        if entry.is_file
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
            && except.is_none_or(|kept| kept != path)
        {
            let _ = profiles::remove_file(&path);
        }
    }
}

fn friend_number_for_public_key(friends: &HashMap<String, u32>, public_key: &str) -> Option<u32> {
    friends.get(public_key).copied().or_else(|| {
        friends
            .iter()
            .find_map(|(key, number)| key.eq_ignore_ascii_case(public_key).then_some(*number))
    })
}

fn unique_public_keys_by_friend_number(
    friends: &HashMap<String, u32>,
) -> (HashMap<u32, String>, HashSet<u32>) {
    let mut by_number = HashMap::<u32, String>::new();
    let mut ambiguous = HashSet::new();
    for (public_key, friend_number) in friends {
        if ambiguous.contains(friend_number) {
            continue;
        }
        match by_number.get(friend_number) {
            Some(existing) if !existing.eq_ignore_ascii_case(public_key) => {
                by_number.remove(friend_number);
                ambiguous.insert(*friend_number);
            }
            Some(_) => {}
            None => {
                by_number.insert(*friend_number, public_key.clone());
            }
        }
    }
    (by_number, ambiguous)
}

fn affected_friend_avatar_numbers(
    previous: &HashMap<String, u32>,
    current: &HashMap<String, u32>,
) -> HashSet<u32> {
    let (previous_by_number, ambiguous_previous_numbers) =
        unique_public_keys_by_friend_number(previous);
    let changed_sources = previous_by_number
        .iter()
        .filter_map(|(previous_number, public_key)| {
            (friend_number_for_public_key(current, public_key) != Some(*previous_number))
                .then_some(*previous_number)
        })
        .chain(ambiguous_previous_numbers.iter().copied())
        .collect::<HashSet<_>>();
    let destination_numbers = changed_sources
        .iter()
        .filter_map(|previous_number| previous_by_number.get(previous_number))
        .filter_map(|public_key| friend_number_for_public_key(current, public_key))
        .collect::<HashSet<_>>();
    changed_sources
        .into_iter()
        .chain(destination_numbers)
        .collect()
}

fn reconcile_friend_avatar_files(
    directory: &Path,
    previous: &HashMap<String, u32>,
    current: &HashMap<String, u32>,
) {
    let affected_numbers = affected_friend_avatar_numbers(previous, current);
    if affected_numbers.is_empty() {
        return;
    }
    let Ok(entries) = profiles::list(directory) else {
        return;
    };
    let (previous_by_number, _) = unique_public_keys_by_friend_number(previous);

    // Move every affected source aside first so swaps never overwrite the
    // other contact. Files whose previous owner disappeared are moved into a
    // recoverable orphan directory instead of being shown for a reused slot.
    let mut staged = Vec::new();
    for (index, entry) in entries
        .into_iter()
        .filter(|entry| entry.is_file)
        .enumerate()
    {
        let filename = entry
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Some((prefix, suffix)) = filename.split_once('-') else {
            continue;
        };
        let Ok(previous) = prefix.parse::<u32>() else {
            continue;
        };
        if !affected_numbers.contains(&previous) {
            continue;
        }
        let owner = previous_by_number.get(&previous).cloned();
        let current = owner
            .as_deref()
            .and_then(|public_key| friend_number_for_public_key(current, public_key));
        let source = entry.path;
        let temporary = directory.join(format!(
            ".kaigen-avatar-remap-{}-{index}.tmp",
            std::process::id()
        ));
        if profiles::rename(&source, &temporary).is_ok() {
            staged.push((
                source,
                temporary,
                current,
                owner,
                suffix.to_string(),
                filename,
            ));
        }
    }
    for (source, temporary, current, owner, suffix, filename) in staged {
        let destination = if let Some(current) = current {
            directory.join(format!("{current}-{suffix}"))
        } else {
            let orphan_directory = directory.join(".kaigen-avatar-orphans");
            if profiles::create_dir_all(&orphan_directory).is_err() {
                let _ = profiles::rename(&temporary, &source);
                continue;
            }
            let owner = owner.unwrap_or_else(|| "unknown".to_string());
            unique_download_path(&orphan_directory, &format!("{owner}-{filename}"))
        };
        if profiles::rename(&temporary, &destination).is_err() {
            let _ = profiles::rename(&temporary, &source);
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkSettings {
    #[serde(default = "default_true")]
    udp_enabled: bool,
    #[serde(default = "default_true")]
    ipv6_enabled: bool,
    #[serde(default = "default_true")]
    local_discovery_enabled: bool,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            udp_enabled: true,
            ipv6_enabled: true,
            local_discovery_enabled: true,
        }
    }
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

const MAX_PROFILE_AVATAR_BYTES: u64 = 8 * 1024 * 1024;

fn avatar_data_url_from_path(path: &Path) -> Result<String, String> {
    let length = profiles::metadata_len(path)
        .map_err(|_| "Не удалось прочитать выбранный файл".to_string())?;
    if length == 0 || length > MAX_PROFILE_AVATAR_BYTES {
        return Err("Размер выбранного аватара недопустим".to_string());
    }
    let mut bytes =
        profiles::read_file(path).map_err(|_| "Не удалось прочитать выбранный файл".to_string())?;
    let mime = if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        wipe_sensitive_bytes(&mut bytes);
        return Err("Выбранный файл не является поддерживаемым изображением".to_string());
    };
    let encoded = base64_basic(&bytes);
    wipe_sensitive_bytes(&mut bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
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

fn wipe_sensitive_bytes(value: &mut [u8]) {
    for byte in value {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
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

fn tox_savedata_public_key(savedata: &[u8]) -> Result<String, String> {
    let handle = create_tox_handle(
        PathBuf::new(),
        Some(savedata),
        None,
        &NetworkSettings::default(),
        None,
    )?;
    let mut address = [0_u8; 38];
    unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
    unsafe { tox_kill(handle.instance.as_ptr()) };
    Ok(hex_upper(&address[..32]))
}

#[derive(Clone, Deserialize, Serialize)]
struct IncomingFriendRequest {
    public_key: String,
    message: String,
}

#[derive(Clone, Serialize)]
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
    #[serde(rename = "addedAt")]
    added_at: Option<u64>,
    #[serde(rename = "lastEventSequence")]
    last_event_sequence: Option<u64>,
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
    // A c-toxcore friend number belongs to one in-memory Tox instance.  Keep
    // the last observed value only as a migration hint; the public key remains
    // the durable contact identity.
    #[serde(default)]
    friend_number: Option<u32>,
    #[serde(default)]
    pending_authorization: bool,
    #[serde(default)]
    authorization_message: String,
    #[serde(default)]
    authorization_last_refreshed_at: u64,
    #[serde(default)]
    added_at: Option<u64>,
    #[serde(default)]
    added_event_sequence: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct ToxAttachment {
    name: String,
    size: u64,
    mime: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview_source: Option<String>,
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

#[derive(Clone, Deserialize, Serialize)]
struct ToxMessage {
    #[serde(default)]
    id: String,
    friend_number: u32,
    #[serde(default)]
    friend_public_key: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protocol_version: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quote: Option<ChatQuote>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    formatting: Vec<TextFormatSpan>,
    #[serde(default)]
    pq_protected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reactions: Option<ReactionView>,
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
    #[serde(default)]
    friend_public_key: String,
    text: String,
    timestamp: u64,
    #[serde(default)]
    next_offset: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    wire_fragments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wire_text: Option<String>,
}

// toxcore cannot start a normal file transfer until the recipient is online.
// Keep a durable copy and retry it from the network loop, just like text.
#[derive(Clone, Deserialize, Serialize)]
struct PendingToxFile {
    id: String,
    friend_number: u32,
    #[serde(default)]
    friend_public_key: String,
    filename: String,
    mime: String,
    path: String,
    size: u64,
    timestamp: u64,
    #[serde(default)]
    retry_count: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transfer_id: Option<String>,
    #[serde(default)]
    announcement_acked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protocol_version: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletedContactQueueRecovery {
    version: u8,
    quarantined_at: u64,
    friend_number: u32,
    friend_public_key: String,
    pending_messages: Vec<PendingToxMessage>,
    pending_pq_messages: Vec<PendingToxMessage>,
    pending_files: Vec<PendingToxFile>,
}

fn message_matches_friend(
    message: &ToxMessage,
    friend_number: u32,
    friend_public_key: &str,
) -> bool {
    friend_identity_matches(
        message.friend_number,
        &message.friend_public_key,
        friend_number,
        friend_public_key,
    )
}

const DEFAULT_MESSAGE_SNAPSHOT: usize = 500;
#[cfg(feature = "web-core")]
const MAX_MESSAGE_EXPORT_PAGE: usize = 256;

fn friend_message_snapshot(
    messages: &[ToxMessage],
    friend_number: u32,
    friend_public_key: &str,
    requested_limit: Option<usize>,
) -> Vec<ToxMessage> {
    let limit = match requested_limit {
        Some(0) => usize::MAX,
        Some(value) => value,
        None => DEFAULT_MESSAGE_SNAPSHOT,
    };
    let mut result = messages
        .iter()
        .rev()
        .filter(|message| message_matches_friend(message, friend_number, friend_public_key))
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    result.reverse();
    result
}

fn session_history_window(
    messages: &[ToxMessage],
    friend_number: u32,
    friend_public_key: &str,
    requested_limit: Option<usize>,
    range_offset: Option<usize>,
    target_id: Option<&str>,
) -> (Vec<ToxMessage>, usize, usize, Option<usize>) {
    const MAX_ROWS: usize = 1_000;
    const MAX_COST: usize = 2 * 1024 * 1024;
    let rows = messages
        .iter()
        .filter(|message| message_matches_friend(message, friend_number, friend_public_key))
        .cloned()
        .collect::<Vec<_>>();
    let total = rows.len();
    let limit = match requested_limit {
        Some(0) => MAX_ROWS,
        Some(value) => value.clamp(1, MAX_ROWS),
        None => DEFAULT_MESSAGE_SNAPSHOT,
    };
    let target_index = target_id.and_then(|target| rows.iter().position(|row| row.id == target));
    let max_start = total.saturating_sub(limit.min(total));
    let start = range_offset
        .unwrap_or_else(|| {
            target_index
                .map(|index| index.saturating_sub(limit / 2))
                .unwrap_or_else(|| total.saturating_sub(limit))
        })
        .min(max_start);
    let mut window = Vec::new();
    let mut cost = 0_usize;
    for row in rows.into_iter().skip(start).take(limit) {
        let row_cost = row.text.encode_utf16().count().saturating_mul(2)
            + row
                .attachment
                .as_ref()
                .map(|attachment| attachment.name.encode_utf16().count().saturating_mul(2))
                .unwrap_or(0)
            + 512;
        if !window.is_empty() && cost.saturating_add(row_cost) > MAX_COST {
            break;
        }
        cost = cost.saturating_add(row_cost);
        window.push(row);
    }
    (window, total, start, target_index)
}

#[cfg(feature = "web-core")]
fn friend_message_page(
    messages: &[ToxMessage],
    friend_number: u32,
    friend_public_key: &str,
    offset: usize,
    requested_limit: usize,
) -> (Vec<ToxMessage>, usize, bool) {
    let limit = requested_limit.clamp(1, MAX_MESSAGE_EXPORT_PAGE);
    let mut cursor = offset.min(messages.len());
    let mut page = Vec::with_capacity(limit);
    while cursor < messages.len() && page.len() < limit {
        let message = &messages[cursor];
        cursor += 1;
        if message_matches_friend(message, friend_number, friend_public_key) {
            page.push(message.clone());
        }
    }
    (page, cursor, cursor >= messages.len())
}

fn friend_identity_matches(
    record_friend_number: u32,
    record_public_key: &str,
    friend_number: u32,
    friend_public_key: &str,
) -> bool {
    if !friend_public_key.is_empty() && !record_public_key.is_empty() {
        record_public_key.eq_ignore_ascii_case(friend_public_key)
    } else {
        record_friend_number == friend_number
    }
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
const FILE_TRANSFER_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_FILE_TRANSFER_RETRIES: u8 = 2;
const MAX_CHAT_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_CHAT_FILE_QUEUE: usize = 5;
const MAX_CONCURRENT_OUTGOING_FILES: usize = 1;
const TOX_TEXT_CHUNK_BYTES: usize = 1200;
const FRIEND_MESSAGE_CONNECTION_SETTLE: Duration = Duration::from_millis(750);

fn note_friend_message_connection(
    ready_at: &Mutex<HashMap<u32, Instant>>,
    friend_number: u32,
    connection: u8,
    now: Instant,
) {
    let Ok(mut ready_at) = ready_at.lock() else {
        return;
    };
    if connection == 0 {
        ready_at.remove(&friend_number);
    } else {
        ready_at.insert(friend_number, now + FRIEND_MESSAGE_CONNECTION_SETTLE);
    }
}

fn friend_message_connection_is_settled(
    ready_at: &Mutex<HashMap<u32, Instant>>,
    friend_number: u32,
    now: Instant,
) -> bool {
    ready_at
        .lock()
        .ok()
        .and_then(|ready_at| ready_at.get(&friend_number).copied())
        .is_some_and(|ready| now >= ready)
}

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
    attachment.transfer_error = None;
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

fn set_attachment_transfer_cancelled(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    message_id: &str,
    reason: impl Into<String>,
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
    attachment.transfer_state = "cancelled".to_string();
    attachment.speed_bytes_per_sec = 0;
    attachment.eta_seconds = None;
    attachment.completed = false;
    attachment.completed_at = None;
    attachment.transfer_error = Some(reason.into());
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
    // .kai files use whole-file authenticated encryption. Buffer the active
    // receive once and publish it atomically on completion instead of reading,
    // decrypting, growing, and re-encrypting the complete file for every chunk.
    buffered_target: Option<Arc<Mutex<Vec<u8>>>>,
    kind: u32,
    message_id: Option<String>,
    protocol_transfer_id: Option<[u8; 32]>,
    meter: TransferMeter,
    last_activity_at: Instant,
    active: bool,
    locally_paused: bool,
    auto_queued: bool,
    queue_order: u64,
}

impl IncomingFile {
    fn set_local_paused(&mut self, paused: bool, now: Instant) {
        self.locally_paused = paused;
        self.active = !paused;
        if !paused {
            self.last_activity_at = now;
        }
    }

    fn apply_peer_control(&mut self, control: i32, blocked_resume: bool, now: Instant) {
        self.active = control == 0 && !self.locally_paused && !blocked_resume;
        if control == 0 {
            self.last_activity_at = now;
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
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
            auto_accept_any: true,
            max_auto_bytes: 24 * 1024 * 1024,
            max_concurrent: 2,
        }
    }
}

impl FileReceiveSettings {
    fn blocked() -> Self {
        Self {
            deny_all: true,
            ..Self::default()
        }
    }

    fn auto_accepts(&self, name: &str, size: u64) -> bool {
        !self.deny_all
            && size <= MAX_CHAT_FILE_BYTES
            && size <= self.max_auto_bytes
            && (self.auto_accept_any
                || (self.auto_accept_images && is_auto_accepted_image_name(name)))
    }
}

const FILE_RECEIVE_DENIED_REASON: &str = "Приём файлов запрещён настройками.";

fn incoming_files_denied(settings: &Mutex<FileReceiveSettings>) -> bool {
    settings
        .lock()
        .map(|settings| settings.deny_all)
        .unwrap_or(true)
}

#[cfg(test)]
mod file_receive_policy_tests {
    use super::*;

    fn card(id: &str, mine: bool, state: &str, completed: bool) -> ToxMessage {
        serde_json::from_value(serde_json::json!({
            "id": id, "friend_number": 7, "friend_public_key": "AA".repeat(32),
            "text": "", "mine": mine, "timestamp": 1,
            "attachment": { "name": "test.bin", "size": 8, "mime": "application/octet-stream",
                "path": format!("pending-file-card://{id}"), "image": false,
                "transfer_state": state, "completed": completed,
                "speed_bytes_per_sec": 8, "eta_seconds": 1 }
        }))
        .unwrap()
    }

    #[test]
    fn deny_all_overrides_every_auto_accept_mode_and_missing_old_fields_keep_denial() {
        for auto_accept_any in [false, true] {
            for auto_accept_images in [false, true] {
                let settings = FileReceiveSettings {
                    auto_accept_any,
                    auto_accept_images,
                    ..FileReceiveSettings::blocked()
                };
                for name in ["test.bin", "test.png", "test.JPG"] {
                    for size in [0, 1, settings.max_auto_bytes, MAX_CHAT_FILE_BYTES, u64::MAX] {
                        assert!(!settings.auto_accepts(name, size));
                    }
                }
            }
        }
        let old: FileReceiveSettings = serde_json::from_str(r#"{"denyAll":true}"#).unwrap();
        assert!(old.deny_all);
        assert!(!old.auto_accepts("test.png", 8));
        let image_only = FileReceiveSettings {
            auto_accept_any: false,
            ..FileReceiveSettings::default()
        };
        assert!(image_only.auto_accepts("test.JPG", image_only.max_auto_bytes));
        assert!(!image_only.auto_accepts("test.bin", 8));
        assert!(!image_only.auto_accepts("test.png", image_only.max_auto_bytes + 1));
    }

    #[test]
    fn policy_cancels_all_unfinished_incoming_cards_once_and_preserves_other_directions() {
        let states = ["awaiting_confirmation", "queued", "paused", "receiving"];
        let mut rows = states
            .into_iter()
            .map(|state| card(state, false, state, false))
            .collect::<Vec<_>>();
        rows.extend([
            card("outgoing", true, "sending", false),
            card("completed", false, "complete", true),
            card("cancelled", false, "cancelled", false),
            card("failed", false, "failed", false),
        ]);
        let retained = rows[4..]
            .iter()
            .map(|row| serde_json::to_value(row).unwrap())
            .collect::<Vec<_>>();
        let messages = Mutex::new(rows);
        assert_eq!(cancel_incoming_file_cards(&messages).len(), states.len());
        assert!(cancel_incoming_file_cards(&messages).is_empty());
        let rows = messages.lock().unwrap();
        for row in &rows[..4] {
            let attachment = row.attachment.as_ref().unwrap();
            assert_eq!(attachment.transfer_state, "cancelled");
            assert!(!attachment.completed);
            assert_eq!(attachment.speed_bytes_per_sec, 0);
            assert_eq!(attachment.eta_seconds, None);
            assert_eq!(
                attachment.transfer_error.as_deref(),
                Some(FILE_RECEIVE_DENIED_REASON)
            );
        }
        assert_eq!(
            rows[4..]
                .iter()
                .map(|row| serde_json::to_value(row).unwrap())
                .collect::<Vec<_>>(),
            retained
        );
    }

    #[test]
    fn unavailable_file_policy_never_permits_a_receive() {
        let settings = Arc::new(Mutex::new(FileReceiveSettings::default()));
        let locked = Arc::clone(&settings);
        let _ = std::thread::spawn(move || {
            let _guard = locked.lock().unwrap();
            panic!("synthetic poisoned policy");
        })
        .join();
        assert!(incoming_files_denied(&settings));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutgoingFilePhase {
    WaitingForAcceptance,
    Transferring,
    TransportLost,
}

#[derive(Clone)]
struct OutgoingFile {
    path: PathBuf,
    filename: String,
    mime: String,
    size: u64,
    // .kai files use whole-file authenticated encryption. Keeping one bounded
    // plaintext snapshot for an active transfer avoids decrypting and copying
    // the complete attachment for every small toxcore chunk request.
    source_bytes: Option<Arc<Vec<u8>>>,
    message_id: Option<String>,
    protocol_transfer_id: Option<[u8; 32]>,
    meter: TransferMeter,
    last_activity_at: Instant,
    active: bool,
    locally_paused: bool,
    phase: OutgoingFilePhase,
    fully_sent: bool,
    retry_count: u8,
    #[cfg(feature = "web-core")]
    web_transfer_id: Option<String>,
}

impl OutgoingFile {
    fn set_local_paused(&mut self, paused: bool, now: Instant) {
        self.locally_paused = paused;
        self.active = !paused;
        if !paused {
            self.last_activity_at = now;
        }
    }

    fn apply_peer_control(&mut self, control: i32, blocked_resume: bool, now: Instant) {
        self.active = control == 0 && !self.locally_paused && !blocked_resume;
        if control == 0 {
            self.note_peer_activity(now);
        }
    }

    fn note_peer_activity(&mut self, now: Instant) {
        self.phase = OutgoingFilePhase::Transferring;
        self.last_activity_at = now;
    }
}

fn note_outgoing_transport_loss(
    files: &Arc<Mutex<HashMap<(u32, u32), OutgoingFile>>>,
    friend_number: Option<u32>,
) {
    if let Ok(mut files) = files.lock() {
        for ((friend, _), transfer) in files.iter_mut() {
            if friend_number.is_none_or(|number| number == *friend) {
                // toxcore destroys its streams on disconnect or handle replacement.
                // Keep pause and retry state; the connected watchdog can recover
                // the old offer without mistaking a live consent wait for a stall.
                transfer.phase = OutgoingFilePhase::TransportLost;
            }
        }
    }
}

static NEXT_INCOMING_FILE_QUEUE_ORDER: AtomicU64 = AtomicU64::new(1);

struct CallbackContext {
    updates: Option<ProfileUpdateEmitter>,
    incoming_requests: Arc<Mutex<Vec<IncomingFriendRequest>>>,
    incoming_requests_path: PathBuf,
    messages: Arc<Mutex<Vec<ToxMessage>>>,
    history_residency: Arc<Mutex<HashMap<String, HistoryResidence>>>,
    delivery_receipts: Arc<Mutex<HashMap<(u32, u32), String>>>,
    receipt_progress: Arc<Mutex<HashMap<String, ReceiptProgress>>>,
    history_path: PathBuf,
    history_enabled: Arc<AtomicBool>,
    pending_files: Arc<Mutex<Vec<PendingToxFile>>>,
    pending_files_path: PathBuf,
    incoming_files: Arc<Mutex<HashMap<(u32, u32), IncomingFile>>>,
    outgoing_files: Arc<Mutex<HashMap<(u32, u32), OutgoingFile>>>,
    downloads_dir: PathBuf,
    avatars_dir: PathBuf,
    transfer_log_path: PathBuf,
    network_log_path: PathBuf,
    friend_cache: Arc<Mutex<HashMap<String, CachedFriendProfile>>>,
    friend_cache_path: PathBuf,
    pq: Arc<PqEngine>,
    chat_protocol: Arc<ChatProtocolEngine>,
    file_card_protocol: Arc<FileCardEngine>,
    pq_receipts: Arc<Mutex<HashMap<(u32, u64), String>>>,
    file_receive_settings: Arc<Mutex<FileReceiveSettings>>,
    unread_state: Arc<Mutex<UnreadState>>,
    unread_state_path: PathBuf,
    friend_message_ready_at: Arc<Mutex<HashMap<u32, Instant>>>,
    network_enabled: Arc<AtomicBool>,
    chat_transaction_gate: Arc<Mutex<()>>,
    chat_transport_ready: Arc<AtomicBool>,
    #[cfg(feature = "web-core")]
    web_profile_id: Option<String>,
    #[cfg(feature = "web-core")]
    web_file_bridge: Option<Arc<web_core::WebFileBridge>>,
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
    /// Durable message identities used only for local view bookkeeping. These
    /// are never sent to the peer and never represent human-read receipts.
    #[serde(default)]
    unseen_messages: HashMap<String, Vec<String>>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnreadStateView {
    friends: HashMap<String, u32>,
    requests: HashSet<String>,
    pending_peer_reaction_revision_by_target: HashMap<String, u64>,
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

fn unread_state_view(state: &ToxState) -> Result<UnreadStateView, String> {
    let unread = state
        .unread_state
        .lock()
        .map_err(|_| "UNREAD_STATE_UNAVAILABLE".to_string())?;
    let mut view = UnreadStateView {
        friends: unread.friends.clone(),
        requests: unread.requests.clone(),
        pending_peer_reaction_revision_by_target: HashMap::new(),
    };
    drop(unread);
    for (friend_number, friend_public_key, revision) in
        state.chat_protocol.pending_peer_reaction_revisions()
    {
        let target = unread_target_key(friend_number, &friend_public_key);
        view.pending_peer_reaction_revision_by_target
            .entry(target)
            .and_modify(|current| *current = (*current).max(revision))
            .or_insert(revision);
    }
    Ok(view)
}

fn persist_unread_state(state: &Arc<Mutex<UnreadState>>, path: &Path) {
    let Ok(state) = state.lock() else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&*state) {
        let _ = atomic_write_sender().try_send(AtomicWriteRequest::Write {
            path: path.to_path_buf(),
            bytes,
        });
    }
}

fn persist_unread_state_now(state: &Arc<Mutex<UnreadState>>, path: &Path) {
    let _ = persist_unread_state_required(state, path);
}

fn persist_unread_state_required(
    state: &Arc<Mutex<UnreadState>>,
    path: &Path,
) -> Result<(), String> {
    let state = state
        .lock()
        .map_err(|_| "UNREAD_STATE_UNAVAILABLE".to_string())?;
    let bytes =
        serde_json::to_vec_pretty(&*state).map_err(|_| "UNREAD_STATE_ENCODE_FAILED".to_string())?;
    let completed = enqueue_atomic_write_required(path, bytes);
    drop(state);
    let completed = completed.map_err(|_| "UNREAD_STATE_WRITE_FAILED".to_string())?;
    wait_for_atomic_write(completed).map_err(|_| "UNREAD_STATE_WRITE_FAILED".to_string())
}

enum AtomicWriteRequest {
    Write {
        path: PathBuf,
        bytes: Vec<u8>,
    },
    RequiredWrite {
        path: PathBuf,
        bytes: Vec<u8>,
        completed: SyncSender<Result<(), String>>,
    },
    Flush(SyncSender<()>),
    #[cfg(test)]
    PauseBeforeCommit {
        entered: SyncSender<bool>,
        release: mpsc::Receiver<()>,
    },
}

static ATOMIC_WRITE_SENDER: OnceLock<SyncSender<AtomicWriteRequest>> = OnceLock::new();

fn atomic_write_sender() -> &'static SyncSender<AtomicWriteRequest> {
    ATOMIC_WRITE_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<AtomicWriteRequest>(256);
        thread::spawn(move || {
            while let Ok(first) = receiver.recv() {
                let (path, bytes) = match first {
                    AtomicWriteRequest::Write { path, bytes } => (path, bytes),
                    AtomicWriteRequest::RequiredWrite {
                        path,
                        bytes,
                        completed,
                    } => {
                        let result = atomic_write_active_path(&path, &bytes);
                        let _ = completed.send(result);
                        continue;
                    }
                    AtomicWriteRequest::Flush(completed) => {
                        let _ = completed.send(());
                        continue;
                    }
                    #[cfg(test)]
                    AtomicWriteRequest::PauseBeforeCommit { entered, release } => {
                        let _ = entered.send(false);
                        let _ = release.recv_timeout(Duration::from_secs(5));
                        continue;
                    }
                };
                let mut pending = HashMap::from([(path, bytes)]);
                let mut flush = None;
                let mut required = None;
                let deadline = Instant::now() + Duration::from_millis(250);
                loop {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match receiver.recv_timeout(remaining) {
                        Ok(AtomicWriteRequest::Write { path, bytes }) => {
                            pending.insert(path, bytes);
                        }
                        Ok(AtomicWriteRequest::RequiredWrite {
                            path,
                            bytes,
                            completed,
                        }) => {
                            required = Some((path, bytes, completed));
                            break;
                        }
                        Ok(AtomicWriteRequest::Flush(completed)) => {
                            flush = Some(completed);
                            break;
                        }
                        #[cfg(test)]
                        Ok(AtomicWriteRequest::PauseBeforeCommit { entered, release }) => {
                            let _ = entered.send(true);
                            let _ = release.recv_timeout(Duration::from_secs(5));
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                for (path, bytes) in pending {
                    let _ = atomic_write_active_path(&path, &bytes);
                }
                if let Some((path, bytes, completed)) = required {
                    let result = atomic_write_active_path(&path, &bytes);
                    let _ = completed.send(result);
                }
                if let Some(completed) = flush {
                    let _ = completed.send(());
                }
            }
        });
        sender
    })
}

fn enqueue_atomic_write_required(
    path: &Path,
    bytes: Vec<u8>,
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    let (completed, result) = mpsc::sync_channel(0);
    atomic_write_sender()
        .send(AtomicWriteRequest::RequiredWrite {
            path: path.to_path_buf(),
            bytes,
            completed,
        })
        .map_err(|_| "PROFILE_WRITE_QUEUE_UNAVAILABLE".to_string())?;
    Ok(result)
}

pub(crate) fn wait_for_atomic_write(
    completed: mpsc::Receiver<Result<(), String>>,
) -> Result<(), String> {
    completed
        .recv()
        .map_err(|_| "PROFILE_WRITE_QUEUE_UNAVAILABLE".to_string())?
}

pub(crate) fn enqueue_friend_cache_write_required(
    cache: &HashMap<String, CachedFriendProfile>,
    path: &Path,
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    let bytes =
        serde_json::to_vec(cache).map_err(|_| "CHAT_CONTACT_CACHE_ENCODE_FAILED".to_string())?;
    enqueue_atomic_write_required(path, bytes)
}

fn unread_target_key(friend_number: u32, friend_public_key: &str) -> String {
    if friend_public_key.len() == 64
        && friend_public_key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        format!("friend-key:{}", friend_public_key.to_ascii_uppercase())
    } else {
        format!("friend-number:{friend_number}")
    }
}

fn increment_unread_friend_message(
    context: &CallbackContext,
    friend_number: u32,
    friend_public_key: &str,
    message_id: &str,
) {
    if let Ok(mut state) = context.unread_state.lock() {
        let target = unread_target_key(friend_number, friend_public_key);
        let ids = state.unseen_messages.entry(target).or_default();
        if ids.iter().any(|id| id == message_id) {
            return;
        }
        ids.push(message_id.to_string());
        let count = state.friends.entry(friend_number.to_string()).or_default();
        *count = count.saturating_add(1);
    }
    persist_unread_state(&context.unread_state, &context.unread_state_path);
    if let Some(updates) = &context.updates {
        updates.changed();
    }
}

fn increment_unread_friend(context: &CallbackContext, friend_number: u32) {
    let friend_public_key = context
        .friend_cache
        .lock()
        .ok()
        .and_then(|cache| {
            cache.iter().find_map(|(key, profile)| {
                (profile.friend_number == Some(friend_number)).then_some(key.clone())
            })
        })
        .unwrap_or_default();
    let latest_id = context.messages.lock().ok().and_then(|messages| {
        messages.iter().rev().find_map(|message| {
            (!message.mine
                && message_matches_friend(message, friend_number, &friend_public_key)
                && !message.id.is_empty())
            .then(|| message.id.clone())
        })
    });
    if let Some(message_id) = latest_id {
        increment_unread_friend_message(context, friend_number, &friend_public_key, &message_id);
    }
}

fn tox_friend_public_key(tox: *const c_void, friend_number: u32) -> Option<String> {
    if tox.is_null() {
        return None;
    }
    let mut key = [0_u8; 32];
    let mut error = 0_i32;
    unsafe { tox_friend_get_public_key(tox, friend_number, key.as_mut_ptr(), &mut error) }
        .then(|| hex_upper(&key))
}

fn resolve_current_friend_number(tox: *const c_void, expected_public_key: &str) -> Option<u32> {
    if expected_public_key.is_empty() {
        return None;
    }
    tox_friend_numbers_by_public_key(tox)
        .into_iter()
        .find_map(|(public_key, friend_number)| {
            public_key
                .eq_ignore_ascii_case(expected_public_key)
                .then_some(friend_number)
        })
}

fn tox_friend_numbers_by_public_key(tox: *const c_void) -> HashMap<String, u32> {
    if tox.is_null() {
        return HashMap::new();
    }
    let count = unsafe { tox_self_get_friend_list_size(tox) };
    let mut numbers = vec![0_u32; count];
    unsafe { tox_self_get_friend_list(tox, numbers.as_mut_ptr()) };
    numbers
        .into_iter()
        .filter_map(|friend_number| {
            tox_friend_public_key(tox, friend_number).map(|public_key| (public_key, friend_number))
        })
        .collect()
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
        if entry.friend_number != Some(friend_number) {
            entry.friend_number = Some(friend_number);
            changed = true;
        }
        if !entry.authorized {
            entry.authorized = true;
            changed = true;
        }
        if entry.pending_authorization {
            entry.pending_authorization = false;
            entry.authorization_message.clear();
            changed = true;
        }
        if changed {
            if let Ok(serialized) = serde_json::to_vec(&*cache) {
                let _ = atomic_write_sender().try_send(AtomicWriteRequest::Write {
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
    _identity_guard: Arc<ProfileIdentityGuard>,
    local_state_lock: Arc<Mutex<()>>,
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
    history_residency: Arc<Mutex<HashMap<String, HistoryResidence>>>,
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
    chat_protocol: Arc<ChatProtocolEngine>,
    file_card_protocol: Arc<FileCardEngine>,
    pq_receipts: Arc<Mutex<HashMap<(u32, u64), String>>>,
    file_receive_settings: Arc<Mutex<FileReceiveSettings>>,
    file_receive_settings_path: PathBuf,
    unread_state: Arc<Mutex<UnreadState>>,
    unread_state_path: PathBuf,
    friend_message_ready_at: Arc<Mutex<HashMap<u32, Instant>>>,
    /// Publication barrier for durable chat mutations. Network flushers take
    /// the same gate, so a queue/outbox entry cannot reach toxcore before the
    /// complete managed-profile transaction has been checkpointed.
    chat_transaction_gate: Arc<Mutex<()>>,
    chat_transport_ready: Arc<AtomicBool>,
    updates: Option<ProfileUpdateEmitter>,
    profile_volume: Option<Arc<KaiProfileVolume>>,
    #[cfg(feature = "web-core")]
    web_profile_id: Option<String>,
    #[cfg(feature = "web-core")]
    web_file_bridge: Option<Arc<web_core::WebFileBridge>>,
    #[cfg(test)]
    iterations: Arc<AtomicU64>,
}

#[derive(Clone, Debug)]
struct HistoryResidence {
    friend_number: u32,
    friend_public_key: String,
    active: bool,
    left_at: Option<Instant>,
    last_access: Instant,
    evicted: bool,
    lease_sessions: HashMap<String, HistoryLeaseSession>,
}

#[derive(Clone, Debug, Default)]
struct HistoryLeaseSession {
    active_generations: HashSet<u64>,
    released_through: u64,
    last_seen: Option<Instant>,
}

const CHAT_HISTORY_RELEASE_AFTER: Duration = Duration::from_secs(2 * 60 * 60);
const CHAT_HISTORY_LEASE_STALE_AFTER: Duration = Duration::from_secs(30);
const MAX_INACTIVE_CHAT_HISTORY_WINDOWS: usize = 3;
const MAX_INACTIVE_CHAT_HISTORY_COST: usize = 2 * 1024 * 1024;

impl ToxState {
    fn new_for_profile(
        paths: ProfilePaths,
        tor: TorManager,
        proxy_settings: Arc<Mutex<ProxySettings>>,
        network_settings: Arc<Mutex<NetworkSettings>>,
        updates: Option<ProfileUpdateEmitter>,
        mut savedata: Option<Vec<u8>>,
        cipher: Option<ProfileCipher>,
        new_profile_name: Option<&str>,
    ) -> Result<Self, String> {
        let profile_volume = paths.volume.clone();
        let profile_path = paths.profile_path.clone();
        let profile_exists = savedata.is_some();
        let network_state_path = paths.data_dir.join("network-state.json");
        // Tox saves Online/Busy in its profile.  The separate flag persists
        // the user's explicit "disconnect" choice, so we do not bootstrap on
        // the next application start until they choose an online status again.
        let network_enabled = profiles::read_text(&network_state_path)
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
        let handle_result = create_tox_handle(
            profile_path,
            savedata.as_deref(),
            route.as_ref(),
            &network_settings_value,
            cipher,
        );
        if let Some(savedata) = savedata.as_mut() {
            wipe_sensitive_bytes(savedata);
        }
        let handle = handle_result?;
        let identity_guard = {
            let mut address = [0_u8; 38];
            unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
            match ProfileIdentityGuard::acquire(&hex_upper(&address[..32])) {
                Ok(guard) => Arc::new(guard),
                Err(error) => {
                    unsafe { tox_kill(handle.instance.as_ptr()) };
                    return Err(error);
                }
            }
        };
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
        let file_receive_settings = profiles::read_file(&file_receive_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        let unread_state_path = paths.data_dir.join("unread-events.json");
        allow_batched_write(&history_path);
        allow_batched_write(&unread_state_path);
        allow_batched_write(&friend_cache_path);
        allow_batched_write(&pending_messages_path);
        allow_batched_write(&pending_pq_messages_path);
        let unread_state = profiles::read_file(&unread_state_path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        let friend_cache = profiles::read_file(&friend_cache_path)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let transfer_log_path = paths.logs_dir.join("file-transfer.log");
        let network_log_path = paths.logs_dir.join("tox-network.log");
        let mut legacy_messages = profiles::read_file(&history_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<ToxMessage>>(&contents).ok())
            .unwrap_or_default();
        let current_friend_numbers = tox_friend_numbers_by_public_key(handle.instance.as_ptr());
        let public_keys_by_number = unique_public_keys_by_friend_number(&current_friend_numbers).0;
        for message in &mut legacy_messages {
            if message.friend_public_key.is_empty() {
                if let Some(public_key) = public_keys_by_number.get(&message.friend_number) {
                    message.friend_public_key = public_key.clone();
                }
            }
        }
        let pq = Arc::new(PqEngine::new(&paths.data_dir)?);
        let mut messages = chat_history_store::open_and_register(&history_path, legacy_messages)?;
        let mut recovered_rows = Vec::new();
        for message in &mut messages {
            if let Some(attachment) = message.attachment.as_mut() {
                let directory = if message.mine {
                    &paths.outgoing_files_dir
                } else {
                    &paths.downloads_dir
                };
                let rebased = rebase_portable_file(&attachment.path, directory);
                if attachment.path != rebased {
                    attachment.path = rebased;
                    recovered_rows.push(message.clone());
                }
            }
            // A toxcore receipt is process-local. After restart an outgoing
            // item which had left the durable queue can no longer be matched
            // to a future callback, so expose that uncertainty instead of
            // claiming either delivery or failure.
            if message.mine
                && message.delivery == "awaiting_receipt"
                && !pq.has_durable_message(&message.id)
            {
                message.delivery = "unknown_recovered".to_string();
                message.delivered_at = None;
                recovered_rows.push(message.clone());
            }
        }
        if !recovered_rows.is_empty() {
            chat_history_store::upsert_registered(&history_path, &recovered_rows)?;
        }
        // Durable history lives in bounded chunks. At startup only rows needed
        // by an active delivery/transfer stay resident until a chat is opened.
        messages.retain(message_requires_runtime_residency);
        let pending_messages = profiles::read_file(&pending_messages_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<PendingToxMessage>>(&contents).ok())
            .unwrap_or_default();
        let pending_pq_messages = profiles::read_file(&pending_pq_messages_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<PendingToxMessage>>(&contents).ok())
            .unwrap_or_default();
        let mut pending_files = profiles::read_file(&pending_files_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<Vec<PendingToxFile>>(&contents).ok())
            .unwrap_or_default();
        for file in &mut pending_files {
            file.path = rebase_portable_file(&file.path, &paths.outgoing_files_dir);
        }
        let incoming_requests = profiles::read_file(&incoming_requests_path)
            .ok()
            .and_then(|contents| {
                serde_json::from_slice::<Vec<IncomingFriendRequest>>(&contents).ok()
            })
            .unwrap_or_default();

        let chat_protocol = Arc::new(ChatProtocolEngine::new(&paths.data_dir)?);
        let file_card_protocol = Arc::new(FileCardEngine::new(&paths.data_dir)?);
        let state = Self {
            handle: Arc::new(Mutex::new(Some(handle))),
            _identity_guard: identity_guard,
            local_state_lock: Arc::new(Mutex::new(())),
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
            history_residency: Arc::new(Mutex::new(HashMap::new())),
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
            chat_protocol,
            file_card_protocol,
            pq_receipts: Arc::new(Mutex::new(HashMap::new())),
            file_receive_settings: Arc::new(Mutex::new(file_receive_settings)),
            file_receive_settings_path,
            unread_state: Arc::new(Mutex::new(unread_state)),
            unread_state_path,
            friend_message_ready_at: Arc::new(Mutex::new(HashMap::new())),
            chat_transaction_gate: Arc::new(Mutex::new(())),
            chat_transport_ready: Arc::new(AtomicBool::new(true)),
            updates,
            profile_volume,
            #[cfg(feature = "web-core")]
            web_profile_id: None,
            #[cfg(feature = "web-core")]
            web_file_bridge: None,
            #[cfg(test)]
            iterations: Arc::new(AtomicU64::new(0)),
        };
        // Reconciliation persists only stores whose friend-number mapping was
        // actually migrated. Rewriting every store here used to dirty an
        // otherwise unchanged encrypted .kai volume on every application
        // launch and could force a full container checkpoint.
        state.reconcile_loaded_friend_numbers()?;
        Ok(state)
    }

    fn save(handle: &ToxHandle) -> Result<(), String> {
        let length = unsafe { tox_get_savedata_size(handle.instance.as_ptr()) };
        let mut savedata = vec![0_u8; length];
        unsafe { tox_get_savedata(handle.instance.as_ptr(), savedata.as_mut_ptr()) };
        let mut disk_data = match handle.cipher.as_ref() {
            Some(cipher) => {
                let result = cipher.encrypt(&savedata);
                wipe_sensitive_bytes(&mut savedata);
                result?
            }
            None => savedata,
        };
        let result = atomic_write(&handle.profile_path, &disk_data)
            .map_err(|error| format!("Не удалось атомарно сохранить профиль Tox: {error}"));
        wipe_sensitive_bytes(&mut disk_data);
        result
    }

    fn checkpoint_profile(&self, force: bool) -> Result<bool, String> {
        self.profile_volume
            .as_ref()
            .map(|volume| volume.checkpoint(force))
            .unwrap_or(Ok(false))
    }

    fn save_network_enabled(&self, enabled: bool) -> Result<(), String> {
        profiles::write_file(
            &self.network_state_path,
            if enabled { b"online" } else { b"offline" },
        )
        .map_err(|error| format!("Не удалось сохранить режим подключения Tox: {error}"))
    }

    fn reconcile_loaded_friend_numbers(&self) -> Result<(), String> {
        let current = {
            let guard = self
                .handle
                .lock()
                .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
            let handle = guard
                .as_ref()
                .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
            tox_friend_numbers_by_public_key(handle.instance.as_ptr())
        };
        let previous = self
            .friend_cache
            .lock()
            .map_err(|_| "Не удалось прочитать кэш контактов".to_string())?
            .iter()
            .filter_map(|(public_key, profile)| {
                profile
                    .friend_number
                    .map(|friend_number| (public_key.clone(), friend_number))
            })
            .collect::<HashMap<_, _>>();
        self.reconcile_friend_number_maps(&previous, &current);
        Ok(())
    }

    fn stable_friend_public_key(&self, friend_number: u32) -> String {
        self.handle
            .lock()
            .ok()
            .and_then(|guard| {
                guard.as_ref().and_then(|handle| {
                    tox_friend_public_key(handle.instance.as_ptr(), friend_number)
                })
            })
            .unwrap_or_default()
    }

    fn self_public_key(&self) -> Option<String> {
        self.handle.lock().ok().and_then(|guard| {
            guard.as_ref().map(|handle| {
                let mut address = [0_u8; 38];
                unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
                hex_upper(&address[..32])
            })
        })
    }

    fn reconcile_friend_number_maps(
        &self,
        previous: &HashMap<String, u32>,
        current: &HashMap<String, u32>,
    ) {
        let (mut public_keys_by_number, ambiguous_previous_numbers) =
            unique_public_keys_by_friend_number(previous);
        for (public_key, friend_number) in current {
            if !ambiguous_previous_numbers.contains(friend_number) {
                public_keys_by_number
                    .entry(*friend_number)
                    .or_insert_with(|| public_key.clone());
            }
        }
        let durable_changed = self.attach_stable_friend_keys(&public_keys_by_number)
            | self.reconcile_durable_friend_numbers(current);

        // Ephemeral protocol state has only a toxcore number. Resolve that
        // number through its previous public-key owner and discard any entry
        // whose owner no longer exists. This avoids HashMap collision loss and
        // prevents a deleted contact's slot from being inherited by a new key.
        let previous_by_number = unique_public_keys_by_friend_number(previous).0;
        let resolved_numbers = previous_by_number
            .iter()
            .filter_map(|(previous_number, public_key)| {
                friend_number_for_public_key(current, public_key)
                    .map(|current_number| (*previous_number, current_number))
            })
            .collect::<HashMap<_, _>>();
        let unread_changed =
            self.reconcile_ephemeral_friend_numbers(&resolved_numbers, &previous_by_number);
        reconcile_friend_avatar_files(&self.avatars_dir, previous, current);

        for (public_key, previous_number) in previous {
            if let Some(current_number) = friend_number_for_public_key(current, public_key) {
                if current_number == *previous_number {
                    continue;
                }
                log_network(
                    &self.network_log_path,
                    format!(
                        "FRIEND_NUMBER_REMAP previous={previous_number} current={current_number}"
                    ),
                );
            }
        }
        let mut cache_changed = false;
        let cache_write = if let Ok(mut cache) = self.friend_cache.lock() {
            for (public_key, profile) in cache.iter_mut() {
                let next = friend_number_for_public_key(current, public_key);
                if profile.friend_number != next {
                    profile.friend_number = next;
                    cache_changed = true;
                }
            }
            for (public_key, friend_number) in current {
                let profile = cache.entry(public_key.clone()).or_default();
                if profile.friend_number != Some(*friend_number) {
                    profile.friend_number = Some(*friend_number);
                    cache_changed = true;
                }
            }
            if cache_changed {
                enqueue_friend_cache_write_required(&cache, &self.friend_cache_path).ok()
            } else {
                None
            }
        } else {
            None
        };
        if let Some(completed) = cache_write {
            let _ = wait_for_atomic_write(completed);
        }
        if durable_changed {
            persist_tox_history_now(&self.messages, &self.history_path, &self.history_enabled);
            persist_pending_messages_now(&self.pending_messages, &self.pending_messages_path);
            persist_pending_messages_now(&self.pending_pq_messages, &self.pending_pq_messages_path);
            persist_pending_files(&self.pending_files, &self.pending_files_path);
            bump_history_revision(&self.history_path);
        }
        if unread_changed {
            persist_unread_state_now(&self.unread_state, &self.unread_state_path);
        }
        if durable_changed || unread_changed || cache_changed {
            if let Some(updates) = &self.updates {
                updates.changed();
            }
        }
    }

    fn attach_stable_friend_keys(&self, public_keys_by_number: &HashMap<u32, String>) -> bool {
        let mut changed = false;
        if let Ok(mut messages) = self.messages.lock() {
            for message in messages.iter_mut() {
                if message.friend_public_key.is_empty() {
                    if let Some(public_key) = public_keys_by_number.get(&message.friend_number) {
                        message.friend_public_key = public_key.clone();
                        changed = true;
                    }
                }
            }
        }
        for queue in [&self.pending_messages, &self.pending_pq_messages] {
            if let Ok(mut messages) = queue.lock() {
                for message in messages.iter_mut() {
                    if message.friend_public_key.is_empty() {
                        if let Some(public_key) = public_keys_by_number.get(&message.friend_number)
                        {
                            message.friend_public_key = public_key.clone();
                            changed = true;
                        }
                    }
                }
            }
        }
        if let Ok(mut files) = self.pending_files.lock() {
            for file in files.iter_mut() {
                if file.friend_public_key.is_empty() {
                    if let Some(public_key) = public_keys_by_number.get(&file.friend_number) {
                        file.friend_public_key = public_key.clone();
                        changed = true;
                    }
                }
            }
        }
        changed
    }

    fn reconcile_durable_friend_numbers(&self, current: &HashMap<String, u32>) -> bool {
        let mut changed = false;
        let mut reconcile = |friend_number: &mut u32, public_key: &str| {
            if !public_key.is_empty() {
                if let Some(current_number) = friend_number_for_public_key(current, public_key) {
                    if *friend_number != current_number {
                        *friend_number = current_number;
                        changed = true;
                    }
                }
            }
        };
        if let Ok(mut messages) = self.messages.lock() {
            for message in messages.iter_mut() {
                reconcile(&mut message.friend_number, &message.friend_public_key);
            }
        }
        for queue in [&self.pending_messages, &self.pending_pq_messages] {
            if let Ok(mut messages) = queue.lock() {
                for message in messages.iter_mut() {
                    reconcile(&mut message.friend_number, &message.friend_public_key);
                }
            }
        }
        if let Ok(mut files) = self.pending_files.lock() {
            for file in files.iter_mut() {
                reconcile(&mut file.friend_number, &file.friend_public_key);
            }
        }
        changed
    }

    fn reconcile_ephemeral_friend_numbers(
        &self,
        resolved: &HashMap<u32, u32>,
        previous_public_keys: &HashMap<u32, String>,
    ) -> bool {
        let remap = |friend_number: u32| resolved.get(&friend_number).copied();
        if let Ok(mut receipts) = self.delivery_receipts.lock() {
            *receipts = std::mem::take(&mut *receipts)
                .into_iter()
                .filter_map(|((friend_number, message_id), value)| {
                    remap(friend_number).map(|number| ((number, message_id), value))
                })
                .collect();
        }
        if let Ok(mut receipts) = self.pq_receipts.lock() {
            *receipts = std::mem::take(&mut *receipts)
                .into_iter()
                .filter_map(|((friend_number, wire_id), value)| {
                    remap(friend_number).map(|number| ((number, wire_id), value))
                })
                .collect();
        }
        if let Ok(mut files) = self.incoming_files.lock() {
            *files = std::mem::take(&mut *files)
                .into_iter()
                .filter_map(|((friend_number, file_number), value)| {
                    remap(friend_number).map(|number| ((number, file_number), value))
                })
                .collect();
        }
        if let Ok(mut files) = self.outgoing_files.lock() {
            *files = std::mem::take(&mut *files)
                .into_iter()
                .filter_map(|((friend_number, file_number), value)| {
                    remap(friend_number).map(|number| ((number, file_number), value))
                })
                .collect();
        }
        let mut unread_changed = false;
        if let Ok(mut unread) = self.unread_state.lock() {
            let next = unread
                .friends
                .iter()
                .filter_map(|(friend_number, count)| {
                    let number = friend_number.parse::<u32>().ok()?;
                    remap(number).map(|current| (current.to_string(), *count))
                })
                .collect::<HashMap<_, _>>();
            unread_changed = unread.friends != next;
            unread.friends = next;
        }
        self.pq
            .reconcile_friend_numbers(resolved, previous_public_keys);
        unread_changed
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
        let previous_friend_numbers = tox_friend_numbers_by_public_key(current.instance.as_ptr());
        Self::save(current)?;
        let profile_path = current.profile_path.clone();
        let disk_data = profiles::read_file(&profile_path)
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
        let current_friend_numbers =
            tox_friend_numbers_by_public_key(replacement.instance.as_ptr());
        let previous = guard.replace(replacement);
        self.reconcile_friend_number_maps(&previous_friend_numbers, &current_friend_numbers);
        note_outgoing_transport_loss(&self.outgoing_files, None);
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
            let mut last_checkpoint_probe = Instant::now() - Duration::from_secs(1);
            let mut last_queue_flush = Instant::now() - Duration::from_millis(100);
            let mut last_transfer_housekeeping = Instant::now() - Duration::from_secs(1);
            let mut last_history_eviction = Instant::now() - Duration::from_secs(60);
            let callback_store = Arc::into_raw(Arc::new(CallbackContext {
                updates: state.updates.clone(),
                incoming_requests: Arc::clone(&state.incoming_requests),
                incoming_requests_path: state.incoming_requests_path.clone(),
                messages: Arc::clone(&state.messages),
                history_residency: Arc::clone(&state.history_residency),
                delivery_receipts: Arc::clone(&state.delivery_receipts),
                receipt_progress: Arc::clone(&state.receipt_progress),
                history_path: state.history_path.clone(),
                history_enabled: Arc::clone(&state.history_enabled),
                pending_files: Arc::clone(&state.pending_files),
                pending_files_path: state.pending_files_path.clone(),
                incoming_files: Arc::clone(&state.incoming_files),
                outgoing_files: Arc::clone(&state.outgoing_files),
                downloads_dir: state.downloads_dir.clone(),
                avatars_dir: state.avatars_dir.clone(),
                transfer_log_path: state.transfer_log_path.clone(),
                network_log_path: state.network_log_path.clone(),
                friend_cache: Arc::clone(&state.friend_cache),
                friend_cache_path: state.friend_cache_path.clone(),
                pq: Arc::clone(&state.pq),
                chat_protocol: Arc::clone(&state.chat_protocol),
                file_card_protocol: Arc::clone(&state.file_card_protocol),
                pq_receipts: Arc::clone(&state.pq_receipts),
                file_receive_settings: Arc::clone(&state.file_receive_settings),
                unread_state: Arc::clone(&state.unread_state),
                unread_state_path: state.unread_state_path.clone(),
                friend_message_ready_at: Arc::clone(&state.friend_message_ready_at),
                network_enabled: Arc::clone(&state.network_enabled),
                chat_transaction_gate: Arc::clone(&state.chat_transaction_gate),
                chat_transport_ready: Arc::clone(&state.chat_transport_ready),
                #[cfg(feature = "web-core")]
                web_profile_id: state.web_profile_id.clone(),
                #[cfg(feature = "web-core")]
                web_file_bridge: state.web_file_bridge.clone(),
            })) as *mut c_void;
            let mut callback_generation = 0_u64;
            let mut last_connection = u8::MAX;
            while state.running.load(Ordering::Relaxed) {
                if last_history_eviction.elapsed() >= Duration::from_secs(60) {
                    evict_inactive_chat_history(&state, Instant::now());
                    last_history_eviction = Instant::now();
                }
                if last_checkpoint_probe.elapsed() >= Duration::from_secs(1) {
                    let _ = state.checkpoint_profile(false);
                    last_checkpoint_probe = Instant::now();
                }
                if !local_transport_ready(&state) {
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
                    // The offline command stores the local transport fence
                    // before waiting for this handle. Recheck after acquiring
                    // it so an iteration that observed the old value but lost
                    // the handle race cannot start after the command's barrier.
                    if !local_transport_ready(&state) {
                        drop(state_guard);
                        thread::sleep(Duration::from_millis(250));
                        continue;
                    }

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
                                // c-toxcore keeps the historical API name, but
                                // this callback proves delivery to the peer
                                // client only. Kaigen never exposes it as a
                                // human-read state.
                                Some(on_friend_delivery_receipt),
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
                            tox_callback_file_recv_control(
                                handle.instance.as_ptr(),
                                Some(on_file_recv_control),
                            );
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
                        let transport_ready = local_transport_ready(&state);
                        if transport_ready {
                            drive_pq_shutdowns(&state);
                            if last_queue_flush.elapsed() >= Duration::from_millis(100) {
                                drive_pq_sessions(&state, handle.instance.as_ptr());
                                flush_pending_pq_messages(&state, handle.instance.as_ptr());
                                flush_pending_messages(&state, handle.instance.as_ptr());
                                flush_chat_protocol_outbox(&state, handle.instance.as_ptr());
                                flush_file_card_outbox(&state, handle.instance.as_ptr());
                                flush_pq_outbox(&state, handle.instance.as_ptr());
                                flush_pending_files(&state, handle.instance.as_ptr());
                                last_queue_flush = Instant::now();
                            }
                            if last_transfer_housekeeping.elapsed() >= Duration::from_secs(1) {
                                check_file_transfer_timeouts(&state, handle.instance.as_ptr());
                                last_transfer_housekeeping = Instant::now();
                            }
                        }
                        let connection = if transport_ready {
                            tox_self_get_connection_status(handle.instance.as_ptr())
                        } else {
                            0
                        };
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
        if let Some(volume) = &self.profile_volume {
            volume.discard();
        }
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
        drop(state);
        flush_deferred_profile_writes()
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

fn exact_loaded_profile<T: Clone>(
    profiles: &Mutex<HashMap<String, T>>,
    profile_id: &str,
) -> Result<T, String> {
    profiles
        .lock()
        .map_err(|_| "Could not access loaded profiles".to_string())?
        .get(profile_id)
        .cloned()
        .ok_or_else(|| "PROFILE_NOT_LOADED".to_string())
}

#[cfg(feature = "desktop")]
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
    native_file_grants: Arc<Mutex<NativeFileGrantStore>>,
    native_file_drop_target: Arc<Mutex<Option<NativeFileDropTarget>>>,
    native_dialog_open: Arc<AtomicBool>,
    exit_requested: Arc<AtomicBool>,
    shutdown_started: Arc<AtomicBool>,
}

#[cfg(feature = "desktop")]
#[derive(Clone)]
struct NativeFileDropTarget {
    profile_id: String,
    friend_number: u32,
    recipient_public_key: String,
}

#[cfg(feature = "desktop")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileDropBatch {
    profile_id: String,
    friend_number: u32,
    batch: NativeFileBatchSelection,
}

#[cfg(feature = "desktop")]
struct NativeDialogGuard(Arc<AtomicBool>);

#[cfg(feature = "desktop")]
impl Drop for NativeDialogGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(feature = "desktop")]
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
        let proxy_settings_on_disk = fs::read(&proxy_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<ProxySettings>(&contents).ok());
        let proxy_settings = proxy_settings_on_disk.clone().unwrap_or_default();
        if proxy_settings_on_disk.is_none() {
            atomic_write(
                &proxy_settings_path,
                &serde_json::to_vec_pretty(&proxy_settings).map_err(|error| {
                    format!("Could not encode the shared proxy settings: {error}")
                })?,
            )?;
        }
        let network_settings_path = portable.data_dir.join("network-settings.json");
        let network_settings_on_disk = fs::read(&network_settings_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<NetworkSettings>(&contents).ok());
        let network_settings = network_settings_on_disk
            .clone()
            .unwrap_or_default()
            .normalized();
        if network_settings_on_disk.as_ref() != Some(&network_settings) {
            atomic_write(
                &network_settings_path,
                &serde_json::to_vec_pretty(&network_settings).map_err(|error| {
                    format!("Could not encode the shared Tox network settings: {error}")
                })?,
            )?;
        }
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
            native_file_grants: Arc::new(Mutex::new(NativeFileGrantStore::default())),
            native_file_drop_target: Arc::new(Mutex::new(None)),
            native_dialog_open: Arc::new(AtomicBool::new(false)),
            exit_requested: Arc::new(AtomicBool::new(false)),
            shutdown_started: Arc::new(AtomicBool::new(false)),
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

    fn begin_native_dialog(&self) -> Result<NativeDialogGuard, String> {
        self.native_dialog_open
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "NATIVE_DIALOG_ALREADY_OPEN".to_string())?;
        Ok(NativeDialogGuard(self.native_dialog_open.clone()))
    }

    fn allow_profile_media(&self, state: &ToxState) -> Result<(), String> {
        let scope = self.app.asset_protocol_scope();
        for directory in [
            &state.downloads_dir,
            &state.outgoing_files_dir,
            &state.avatars_dir,
        ] {
            if kai::managed_volume(directory).is_some() {
                continue;
            }
            scope
                .allow_directory(directory, true)
                .map_err(|error| format!("Could not allow portable media directory: {error}"))?;
        }
        Ok(())
    }

    fn active_snapshot(&self) -> Result<(String, Arc<ToxState>), String> {
        // Never hold registry and profiles together: shutdown and password
        // changes also touch per-profile state, so nested guards could form a
        // three-lock cycle. Instead, take a fail-closed double snapshot and
        // retain the exact Arc only when both the id and map entry are stable.
        let active = self
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?
            .active_profile_id
            .clone()
            .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
        let state = self
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .get(&active)
            .cloned()
            .ok_or_else(|| "ACTIVE_PROFILE_LOCKED".to_string())?;
        let confirmed_active = self
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?
            .active_profile_id
            .clone()
            .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
        if confirmed_active != active {
            return Err("ACTIVE_PROFILE_CHANGED".to_string());
        }
        let confirmed_state = self
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .get(&active)
            .cloned()
            .ok_or_else(|| "ACTIVE_PROFILE_LOCKED".to_string())?;
        if !Arc::ptr_eq(&state, &confirmed_state) {
            return Err("ACTIVE_PROFILE_CHANGED".to_string());
        }
        Ok((active, state))
    }

    fn active(&self) -> Result<Arc<ToxState>, String> {
        self.active_snapshot().map(|(_, state)| state)
    }

    fn loaded_profile(&self, profile_id: &str) -> Result<Arc<ToxState>, String> {
        exact_loaded_profile(&self.profiles, profile_id)
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

    fn persistent_profile_path(&self, record: &ProfileRecord) -> Result<PathBuf, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?;
        registry.profile_path(&self.root_dir, record)
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

    fn open_profile_paths(
        &self,
        record: &ProfileRecord,
        password: Option<&str>,
    ) -> Result<ProfilePaths, String> {
        let container_path = self.persistent_profile_path(record)?;
        if !is_kai_profile_path(&container_path) {
            return self.paths_for(record);
        }
        let volume = KaiProfileVolume::open(container_path, password)?;
        let namespace = volume.namespace_root().to_path_buf();
        ProfilePaths::new_with_volume(
            self.root_dir.clone(),
            namespace.join("data"),
            namespace.join("profile.tox"),
            Some(volume),
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
        let persistent_path = self.persistent_profile_path(record)?;
        let legacy_migration = !is_kai_profile_path(&persistent_path);
        let (paths, savedata, cipher, legacy_data_path, legacy_profile_path) = if legacy_migration {
            let (savedata, _) = profiles::read_profile(&persistent_path, password)?;
            let container_path = persistent_path
                .parent()
                .ok_or_else(|| "PROFILE_PATH_INVALID".to_string())?
                .join(format!("{}.kai", record.id));
            let volume = KaiProfileVolume::create(
                container_path,
                record.encrypted.then_some(password).flatten(),
            )?;
            let namespace = volume.namespace_root().to_path_buf();
            let data_path = self.root_dir.join(&record.data_directory);
            copy_directory_into_volume(&data_path, &namespace.join("data"))?;
            let paths = ProfilePaths::new_with_volume(
                self.root_dir.clone(),
                namespace.join("data"),
                namespace.join("profile.tox"),
                Some(Arc::clone(&volume)),
            )?;
            profiles::write_file(&paths.profile_path, &savedata)?;
            (
                paths,
                savedata,
                None,
                Some(data_path),
                Some(persistent_path),
            )
        } else {
            let paths = self.open_profile_paths(record, password)?;
            let (savedata, cipher) = profiles::read_profile(&paths.profile_path, password)?;
            (paths, savedata, cipher, None, None)
        };
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
        if legacy_migration {
            tox.checkpoint_profile(true)?;
            let mut registry = self
                .registry
                .lock()
                .map_err(|_| "Could not access the profile registry".to_string())?;
            let migrated = registry
                .profiles
                .iter_mut()
                .find(|candidate| candidate.id == record.id)
                .ok_or_else(|| "PROFILE_NOT_FOUND".to_string())?;
            migrated.file = format!("profiles/{}/{}.kai", record.id, record.id);
            registry.save(&self.data_dir)?;
            drop(registry);
            if let Some(path) = legacy_profile_path {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = legacy_data_path {
                let _ = fs::remove_dir_all(path);
            }
        }
        self.allow_profile_media(&tox)?;
        self.profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .insert(record.id.clone(), Arc::clone(&tox));
        // The loaded-profile map owns the state before its worker starts, so
        // a later bookkeeping error cannot leave an orphan network loop.
        tox.start_network_loop();
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
                let local_state = state
                    .and_then(|profile| profile.history_path.parent())
                    .map(|directory| directory.join("local-state.json"))
                    .and_then(|path| profiles::read_file(&path).ok())
                    .or_else(|| {
                        registry
                            .data_path(&self.root_dir, record)
                            .ok()
                            .and_then(|directory| fs::read(directory.join("local-state.json")).ok())
                    })
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
                    avatar: preferred_profile_avatar(state.map(Arc::as_ref), local_state.as_ref()),
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
                                    .and_then(|(friend, _)| friend.parse::<u32>().ok())
                                    .map(|friend| {
                                        let public_key = state.stable_friend_public_key(friend);
                                        unread_target_key(friend, &public_key)
                                    })
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
#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
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
    let was_enabled = tox_state.network_enabled.load(Ordering::Acquire);
    let (enabled, tox_status) = match status {
        "online" => (true, 0_u8),
        "away" => (true, 1_u8),
        "busy" => (true, 2_u8),
        "offline" => {
            // Publish the local fence before waiting for the Tox handle. An
            // iteration already holding it must finish before this command can
            // return; one waiting behind us rechecks the fence after it locks.
            tox_state.network_enabled.store(false, Ordering::Release);
            let friend_numbers = {
                let state = match tox_state.handle.lock() {
                    Ok(state) => state,
                    Err(_) => {
                        tox_state
                            .network_enabled
                            .store(was_enabled, Ordering::Release);
                        return Err("Could not access the Tox profile".to_string());
                    }
                };
                state
                    .as_ref()
                    .map(|handle| {
                        tox_friend_numbers_by_public_key(handle.instance.as_ptr())
                            .into_values()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            };
            if let Err(error) = tox_state.save_network_enabled(false) {
                if was_enabled {
                    change_local_transport_under_chat_gate(tox_state, &friend_numbers, true)
                        .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
                }
                return Err(error);
            }
            change_local_transport_under_chat_gate(tox_state, &friend_numbers, false)?;
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
    let friend_numbers = (!was_enabled)
        .then(|| {
            tox_friend_numbers_by_public_key(instance.instance.as_ptr())
                .into_values()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    drop(state);
    tox_state.save_network_enabled(enabled)?;
    if was_enabled {
        tox_state.network_enabled.store(enabled, Ordering::Release);
    } else {
        // toxcore can retain a connected friend status while iteration is
        // suspended. Start a fresh capability interval and enqueue discovery
        // explicitly instead of relying on another status callback.
        change_local_transport_under_chat_gate(tox_state, &friend_numbers, true)?;
    }
    if let Some(updates) = &tox_state.updates {
        updates.changed();
    }
    Ok(status.to_string())
}

#[cfg(feature = "desktop")]
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
const TRAY_ICON_SIZE: u32 = 32;

#[cfg(feature = "desktop")]
fn tray_base_image() -> tauri::image::Image<'static> {
    // Share a transparent, high-contrast base between the window and tray.
    // Dark opaque backgrounds disappear on dark themes. macOS treats the tray
    // icon's alpha channel as a template so the system can adapt it to light/dark UI.
    let mut rgba = vec![0_u8; (TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4) as usize];
    let center = (TRAY_ICON_SIZE / 2) as i32;
    paint_circle(
        &mut rgba,
        TRAY_ICON_SIZE,
        TRAY_ICON_SIZE,
        center,
        center,
        12,
        [61, 167, 255, 255],
    );
    paint_circle(
        &mut rgba,
        TRAY_ICON_SIZE,
        TRAY_ICON_SIZE,
        center,
        center,
        8,
        [0, 0, 0, 0],
    );
    tauri::image::Image::new_owned(rgba, TRAY_ICON_SIZE, TRAY_ICON_SIZE)
}

#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
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
    if let Some(tray) = app.tray_by_id("kaigen-tray") {
        let base = tray_base_image();
        let _ = tray.set_icon_with_as_template(
            Some(tray_image(&base, &status, unread)),
            cfg!(target_os = "macos"),
        );
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

#[cfg(feature = "desktop")]
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
    let initial_menu = if has_profile { &full_menu } else { &empty_menu };
    let builder = TrayIconBuilder::with_id("kaigen-tray")
        .menu(initial_menu)
        .show_menu_on_left_click(false)
        .tooltip("Kaigen")
        .icon(tray_base_image())
        .icon_as_template(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "tray-exit" || id == "tray-empty-exit" {
                let state = app.state::<AppState>();
                request_application_exit(app, state.inner());
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

fn store_incoming_chat_message(
    context: &CallbackContext,
    tox: *mut c_void,
    friend_number: u32,
    envelope: Option<MessageEnvelope>,
    legacy_text: Option<String>,
    pq_protected: bool,
) -> Result<bool, String> {
    let _transaction = context
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    let friend_public_key = tox_friend_public_key(tox, friend_number).unwrap_or_default();
    let (id, text, protocol_version, quote, formatting, envelope_pq) =
        if let Some(mut envelope) = envelope {
            if envelope.pq_protected != pq_protected {
                return Err("CHAT_MESSAGE_PQ_POLICY_MISMATCH".to_string());
            }
            let sanitized = sanitize_untrusted_text(&envelope.text);
            if sanitized != envelope.text {
                return Err("CHAT_MESSAGE_TEXT_INVALID".to_string());
            }
            if let Some(quote) = envelope.quote.as_mut() {
                quote.author = sanitize_untrusted_text(&quote.author);
                quote.text = sanitize_untrusted_text(&quote.text);
            }
            (
                envelope.id,
                envelope.text,
                Some(chat_protocol::VERSION),
                envelope.quote,
                envelope.formatting,
                envelope.pq_protected,
            )
        } else {
            let text = sanitize_untrusted_text(&legacy_text.unwrap_or_default());
            let (quote, body) = chat_protocol::parse_qtox_quote(&text)
                .map(|(quote, body)| (Some(quote), body))
                .unwrap_or((None, text));
            (
                new_message_id(friend_number),
                body,
                None,
                quote,
                Vec::new(),
                pq_protected,
            )
        };
    if text.trim().is_empty() {
        return Err("CHAT_MESSAGE_EMPTY".to_string());
    }
    if protocol_version.is_some()
        && context.chat_protocol.accepted_incoming_message(
            friend_number,
            &friend_public_key,
            &id,
            envelope_pq,
        )?
    {
        context.chat_transport_ready.store(false, Ordering::Release);
        context
            .chat_protocol
            .finish_message(friend_number, &friend_public_key, &id)?;
        commit_chat_transaction_with_barrier(&context.history_path, &context.chat_transport_ready)?;
        return Ok(false);
    }
    let mut quote = quote;
    if protocol_version.is_some()
        && context.history_enabled.load(Ordering::Relaxed)
        && chat_history_store::contains_registered(&context.history_path)
        && chat_history_store::find_message_registered(
            &context.history_path,
            friend_number,
            &friend_public_key,
            &id,
        )?
        .is_some()
    {
        context.chat_transport_ready.store(false, Ordering::Release);
        context
            .chat_protocol
            .finish_message(friend_number, &friend_public_key, &id)?;
        commit_chat_transaction_with_barrier(&context.history_path, &context.chat_transport_ready)?;
        return Ok(false);
    }
    if protocol_version.is_some() {
        if let Some(structured_quote) = quote.as_mut() {
            if structured_quote.legacy {
                structured_quote.author.clear();
            } else {
                let target_id = structured_quote
                    .message_id
                    .as_deref()
                    .ok_or_else(|| "CHAT_QUOTE_TARGET_REQUIRED".to_string())?;
                let target = if context.history_enabled.load(Ordering::Relaxed)
                    && chat_history_store::contains_registered(&context.history_path)
                {
                    chat_history_store::find_message_registered(
                        &context.history_path,
                        friend_number,
                        &friend_public_key,
                        target_id,
                    )?
                    .filter(|message| message.protocol_version == Some(chat_protocol::VERSION))
                } else {
                    context.messages.lock().ok().and_then(|messages| {
                        messages
                            .iter()
                            .find(|message| {
                                message.id == target_id
                                    && message.protocol_version == Some(chat_protocol::VERSION)
                                    && message_matches_friend(
                                        message,
                                        friend_number,
                                        &friend_public_key,
                                    )
                            })
                            .cloned()
                    })
                };
                if let Some(target) = target {
                    structured_quote.author = if target.mine { "self" } else { "peer" }.to_string();
                    structured_quote.text = quote_text_for_message(&target);
                    structured_quote.legacy = false;
                } else {
                    structured_quote.message_id = None;
                    structured_quote.author.clear();
                    structured_quote.text = sanitize_untrusted_text(&structured_quote.text);
                    structured_quote.legacy = true;
                }
            }
        }
    }
    let mut messages = context
        .messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
    if protocol_version.is_some()
        && messages.iter().any(|message| {
            message.id == id && message_matches_friend(message, friend_number, &friend_public_key)
        })
    {
        return Ok(false);
    }
    let stored_id = id.clone();
    if protocol_version.is_some() || pq_protected {
        context.chat_transport_ready.store(false, Ordering::Release);
    }
    let stored_message = ToxMessage {
        id,
        friend_number,
        friend_public_key: friend_public_key.clone(),
        text,
        mine: false,
        timestamp: unix_timestamp(),
        delivery: default_message_delivery(),
        delivered_at: None,
        attachment: None,
        event: None,
        protocol_version,
        operation_id: None,
        quote,
        formatting,
        pq_protected: envelope_pq,
        reactions: None,
    };
    messages.push(stored_message.clone());
    drop(messages);
    let persistence = if context.history_enabled.load(Ordering::Relaxed) {
        write_registered_history_rows_required(
            std::slice::from_ref(&stored_message),
            &context.history_path,
        )
    } else if protocol_version.is_some() {
        context.chat_protocol.remember_incoming_message(
            friend_number,
            &friend_public_key,
            &stored_id,
            envelope_pq,
            stored_message.timestamp,
        )
    } else {
        Ok(())
    };
    if let Err(error) = persistence {
        if let Ok(mut messages) = context.messages.lock() {
            messages.retain(|message| message.id != stored_id);
        }
        return Err(error);
    }
    if !context.history_enabled.load(Ordering::Relaxed) {
        bump_chat_view_revision(&context.history_path, friend_number, &friend_public_key);
    }
    if context.history_enabled.load(Ordering::Relaxed)
        && !chat_history_is_active(
            &context.history_residency,
            friend_number,
            &friend_public_key,
        )
    {
        if let Ok(mut messages) = context.messages.lock() {
            messages.retain(|message| message.id != stored_id);
        }
    }
    increment_unread_friend_message(context, friend_number, &friend_public_key, &stored_id);
    record_friend_event_sequence(
        &context.friend_cache,
        &context.friend_cache_path,
        friend_number,
        &friend_public_key,
    );
    if protocol_version.is_some() {
        context
            .chat_protocol
            .finish_message(friend_number, &friend_public_key, &stored_id)?;
    }
    if protocol_version.is_some() || pq_protected {
        commit_chat_transaction_with_barrier(&context.history_path, &context.chat_transport_ready)?;
    }
    Ok(true)
}

fn reaction_target_policy(
    history_path: &Path,
    history_enabled: bool,
    messages: &[ToxMessage],
    friend_number: u32,
    friend_public_key: &str,
    target_id: &str,
) -> Result<bool, String> {
    let recent = if history_enabled && chat_history_store::contains_registered(history_path) {
        chat_history_store::latest_user_registered(
            history_path,
            friend_number,
            friend_public_key,
            chat_protocol::REACTION_ELIGIBLE_MESSAGE_COUNT,
        )?
    } else {
        messages
            .iter()
            .filter(|message| message_matches_friend(message, friend_number, friend_public_key))
            .cloned()
            .collect()
    };
    recent
        .iter()
        .rev()
        .filter(|message| message.event.is_none())
        .take(chat_protocol::REACTION_ELIGIBLE_MESSAGE_COUNT)
        .find(|message| message.id == target_id)
        .ok_or_else(|| "CHAT_REACTION_TARGET_OUTSIDE_RECENT_WINDOW".to_string())
        .and_then(|message| {
            if message.protocol_version == Some(chat_protocol::VERSION) {
                Ok(message.pq_protected)
            } else {
                Err("CHAT_REACTION_TARGET_LEGACY".to_string())
            }
        })
}

fn queue_chat_protocol_reply(
    context: &CallbackContext,
    friend_number: u32,
    packet: Vec<u8>,
    pq_protected: bool,
) -> Result<(), String> {
    if pq_protected {
        if !context.pq.queues_encrypted_messages(friend_number) {
            return Err("CHAT_REACTION_PQ_SESSION_REQUIRED".to_string());
        }
        let text = chat_protocol::encode_pq_service_packet(&packet);
        let encrypted = context.pq.encrypt(friend_number, &text)?;
        context.pq.queue(friend_number, encrypted.packets);
    } else {
        context.chat_protocol.queue_packet(friend_number, packet);
    }
    Ok(())
}

fn ensure_incoming_file_card(
    context: &CallbackContext,
    binding: &file_card_protocol::FileCardBinding,
) -> Result<bool, String> {
    let existing = if chat_history_store::contains_registered(&context.history_path) {
        chat_history_store::find_message_registered(
            &context.history_path,
            binding.friend_number,
            &binding.friend_public_key,
            &binding.message_id,
        )?
    } else {
        context.messages.lock().ok().and_then(|messages| {
            messages
                .iter()
                .find(|message| {
                    message.id == binding.message_id
                        && message_matches_friend(
                            message,
                            binding.friend_number,
                            &binding.friend_public_key,
                        )
                })
                .cloned()
        })
    };
    if let Some(existing) = existing {
        let valid = !existing.mine
            && existing.protocol_version == Some(chat_protocol::VERSION)
            && !existing.pq_protected
            && existing.attachment.as_ref().is_some_and(|attachment| {
                attachment.name == binding.filename && attachment.size == binding.size
            });
        return if valid {
            Ok(false)
        } else {
            Err("FILE_CARD_MESSAGE_ID_CONFLICT".to_string())
        };
    }

    let message = ToxMessage {
        id: binding.message_id.clone(),
        friend_number: binding.friend_number,
        friend_public_key: binding.friend_public_key.clone(),
        text: String::new(),
        mine: false,
        timestamp: unix_timestamp(),
        delivery: default_message_delivery(),
        delivered_at: None,
        attachment: Some(ToxAttachment {
            name: binding.filename.clone(),
            size: binding.size,
            mime: if is_image_name(&binding.filename) {
                "image/*".to_string()
            } else {
                "application/octet-stream".to_string()
            },
            path: format!(
                "pending-file-card://{}",
                file_card_protocol::transfer_id_to_hex(&binding.transfer_id)
            ),
            preview_source: None,
            image: is_image_name(&binding.filename),
            transferred: 0,
            speed_bytes_per_sec: 0,
            eta_seconds: None,
            transfer_state: "awaiting_confirmation".to_string(),
            completed: false,
            completed_at: None,
            transfer_error: None,
            retry_count: 0,
        }),
        event: None,
        protocol_version: Some(chat_protocol::VERSION),
        operation_id: None,
        quote: None,
        formatting: Vec::new(),
        pq_protected: false,
        reactions: None,
    };
    context
        .messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?
        .push(message.clone());
    if context.history_enabled.load(Ordering::Relaxed) {
        if let Err(error) = write_registered_history_rows_required(
            std::slice::from_ref(&message),
            &context.history_path,
        ) {
            if let Ok(mut messages) = context.messages.lock() {
                messages.retain(|item| item.id != binding.message_id);
            }
            return Err(error);
        }
    }
    Ok(true)
}

fn handle_file_card_packet(
    context: &CallbackContext,
    tox: *mut c_void,
    friend_number: u32,
    bytes: &[u8],
) -> Result<(), String> {
    let _transaction = context
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    if !context.chat_protocol.supports(friend_number) {
        return Err("CHAT_CAPABILITY_REQUIRED".to_string());
    }
    let friend_public_key = tox_friend_public_key(tox, friend_number).unwrap_or_default();
    let packet = file_card_protocol::decode_packet(bytes)
        .ok_or_else(|| "FILE_CARD_PACKET_INVALID".to_string())?;
    match packet {
        IncomingFileCardPacket::Offer(offer) => {
            if incoming_files_denied(&context.file_receive_settings) {
                let acknowledgement =
                    file_card_protocol::ack_for_offer(&offer, FileCardAckStatus::Rejected);
                context.chat_protocol.queue_packet(
                    friend_number,
                    file_card_protocol::encode_ack(&acknowledgement)?,
                );
                return Ok(());
            }
            let (binding, status) = context.file_card_protocol.apply_incoming_offer(
                friend_number,
                &friend_public_key,
                &offer,
            )?;
            context.chat_transport_ready.store(false, Ordering::Release);
            let inserted = ensure_incoming_file_card(context, &binding)?;
            let acknowledgement = file_card_protocol::ack_for_offer(&offer, status);
            let acknowledgement = file_card_protocol::encode_ack(&acknowledgement)?;
            if inserted {
                increment_unread_friend_message(
                    context,
                    friend_number,
                    &friend_public_key,
                    &binding.message_id,
                );
                record_friend_event_sequence(
                    &context.friend_cache,
                    &context.friend_cache_path,
                    friend_number,
                    &friend_public_key,
                );
                if let Some(updates) = &context.updates {
                    updates.changed();
                }
            }
            commit_chat_transaction_with_barrier(
                &context.history_path,
                &context.chat_transport_ready,
            )?;
            context
                .chat_protocol
                .queue_packet(friend_number, acknowledgement);
        }
        IncomingFileCardPacket::Ack(acknowledgement) => {
            apply_file_card_acknowledgement(
                context,
                friend_number,
                &friend_public_key,
                &acknowledgement,
            )?;
        }
    }
    Ok(())
}

fn apply_file_card_acknowledgement(
    context: &CallbackContext,
    friend_number: u32,
    friend_public_key: &str,
    acknowledgement: &file_card_protocol::FileCardAck,
) -> Result<(), String> {
    let status = context.file_card_protocol.acknowledge_offer(
        friend_number,
        friend_public_key,
        acknowledgement,
    )?;
    context.chat_transport_ready.store(false, Ordering::Release);
    let mut pending = context
        .pending_files
        .lock()
        .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?;
    if let Some(item) = pending.iter_mut().find(|item| {
        item.id == acknowledgement.message_id
            && friend_identity_matches(
                item.friend_number,
                &item.friend_public_key,
                friend_number,
                friend_public_key,
            )
    }) {
        if matches!(
            status,
            FileCardAckStatus::Applied | FileCardAckStatus::Duplicate
        ) {
            item.announcement_acked = true;
        }
    }
    drop(pending);
    let rejected = reconcile_rejected_file_cards(
        &context.file_card_protocol,
        &context.pending_files,
        &context.pending_files_path,
        &context.messages,
        &context.history_path,
        &context.history_enabled,
    )?;
    if rejected == 0 {
        persist_pending_files_required(&context.pending_files, &context.pending_files_path)?;
    }
    commit_chat_transaction_with_barrier(&context.history_path, &context.chat_transport_ready)?;
    if rejected > 0 {
        bump_history_revision(&context.history_path);
        if let Some(updates) = &context.updates {
            updates.changed();
        }
    }
    Ok(())
}

// A rejected announcement never becomes a native transfer. Persist its terminal
// history before releasing the queue slot, including old pending+Rejected pairs
// loaded after restart. Keep the ACK tombstone for the Web bridge and late ACKs.
fn reconcile_rejected_file_cards(
    engine: &FileCardEngine,
    pending_files: &Arc<Mutex<Vec<PendingToxFile>>>,
    pending_path: &Path,
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    history_path: &Path,
    history_enabled: &AtomicBool,
) -> Result<usize, String> {
    let candidates = pending_files
        .lock()
        .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?
        .clone();
    let rejected = candidates
        .into_iter()
        .filter(|item| {
            item.protocol_version == Some(file_card_protocol::VERSION)
                && engine.outgoing_acknowledgement(
                    item.friend_number,
                    &item.friend_public_key,
                    &item.id,
                ) == Some(FileCardAckStatus::Rejected)
        })
        .collect::<Vec<_>>();
    if rejected.is_empty() {
        return Ok(0);
    }
    let mut restored = Vec::new();
    if history_enabled.load(Ordering::Relaxed)
        && chat_history_store::contains_registered(history_path)
    {
        for item in &rejected {
            let cached = messages
                .lock()
                .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?
                .iter()
                .any(|row| {
                    row.mine
                        && row.id == item.id
                        && message_matches_friend(row, item.friend_number, &item.friend_public_key)
                });
            if !cached {
                if let Some(row) = chat_history_store::find_message_registered(
                    history_path,
                    item.friend_number,
                    &item.friend_public_key,
                    &item.id,
                )? {
                    restored.push(row);
                }
            }
        }
    }
    {
        let mut rows = messages
            .lock()
            .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
        for row in restored {
            if !rows.iter().any(|existing| {
                existing.id == row.id
                    && message_matches_friend(existing, row.friend_number, &row.friend_public_key)
            }) {
                rows.push(row);
            }
        }
        for row in rows.iter_mut().filter(|row| {
            row.mine
                && rejected.iter().any(|item| {
                    row.id == item.id
                        && message_matches_friend(row, item.friend_number, &item.friend_public_key)
                })
        }) {
            let Some(attachment) = row.attachment.as_mut() else {
                continue;
            };
            attachment.transfer_state = "failed".to_string();
            attachment.transfer_error = Some("TRANSFER_REJECTED_BY_RECIPIENT".to_string());
            attachment.speed_bytes_per_sec = 0;
            attachment.eta_seconds = None;
            attachment.completed = false;
            attachment.completed_at = None;
            row.delivery = "failed".to_string();
            row.delivered_at = None;
        }
    }
    persist_tox_history_required(messages, history_path, history_enabled)?;
    pending_files
        .lock()
        .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?
        .retain(|item| {
            !rejected.iter().any(|rejected| {
                item.id == rejected.id
                    && friend_identity_matches(
                        item.friend_number,
                        &item.friend_public_key,
                        rejected.friend_number,
                        &rejected.friend_public_key,
                    )
            })
        });
    persist_pending_files_required(pending_files, pending_path)?;
    Ok(rejected.len())
}

fn handle_chat_protocol_packet(
    context: &CallbackContext,
    tox: *mut c_void,
    friend_number: u32,
    bytes: &[u8],
    pq_protected: bool,
) -> Result<(), String> {
    let _transaction = context
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    let friend_public_key = tox_friend_public_key(tox, friend_number).unwrap_or_default();
    let capability_packet = ChatProtocolEngine::is_capability_packet(bytes);
    if pq_protected && capability_packet {
        return Err("CHAT_CAPABILITY_TRANSPORT_INVALID".to_string());
    }
    if capability_packet && !context.network_enabled.load(Ordering::Acquire) {
        // A callback from the iteration crossed by local suspend cannot
        // restore formatting/reaction support for the next interval.
        return Ok(());
    }
    match context.chat_protocol.handle_packet(friend_number, bytes)? {
        IncomingChatPacket::Capability { acknowledgement } => {
            if pq_protected {
                return Err("CHAT_CAPABILITY_TRANSPORT_INVALID".to_string());
            }
            context
                .chat_protocol
                .queue_packet(friend_number, acknowledgement);
        }
        IncomingChatPacket::CapabilityAcknowledged => {
            if pq_protected {
                return Err("CHAT_CAPABILITY_TRANSPORT_INVALID".to_string());
            }
        }
        IncomingChatPacket::Reaction(reaction) => {
            if !context.chat_protocol.supports(friend_number) {
                return Err("CHAT_CAPABILITY_REQUIRED".to_string());
            }
            if reaction.pq_required != pq_protected {
                return Err("CHAT_REACTION_PQ_TRANSPORT_MISMATCH".to_string());
            }
            let replay = context.chat_protocol.incoming_reaction_replay_status(
                friend_number,
                &friend_public_key,
                &reaction,
            )?;
            let status = if let Some(status) = replay {
                status
            } else {
                let history_enabled = context.history_enabled.load(Ordering::Relaxed);
                reconcile_reaction_targets(
                    &context.chat_protocol,
                    &context.history_path,
                    history_enabled,
                    &context.messages,
                    friend_number,
                    &friend_public_key,
                )?;
                let target_policy = {
                    context
                        .messages
                        .lock()
                        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())
                        .and_then(|messages| {
                            reaction_target_policy(
                                &context.history_path,
                                history_enabled,
                                &messages,
                                friend_number,
                                &friend_public_key,
                                &reaction.target_id,
                            )
                        })
                };
                let expected_pq = target_policy
                    .as_ref()
                    .map(|target_pq| {
                        *target_pq || context.pq.queues_encrypted_messages(friend_number)
                    })
                    .unwrap_or(false);
                if target_policy.is_ok()
                    && reaction.pq_required == expected_pq
                    && reaction.pq_required == pq_protected
                {
                    let applied = context.chat_protocol.apply_incoming_reaction(
                        friend_number,
                        &friend_public_key,
                        &reaction,
                        unix_timestamp(),
                    );
                    context.chat_transport_ready.store(false, Ordering::Release);
                    applied.unwrap_or(ReactionAckStatus::Rejected)
                } else {
                    ReactionAckStatus::Rejected
                }
            };
            if matches!(
                status,
                ReactionAckStatus::Applied | ReactionAckStatus::Duplicate
            ) {
                if let Some(view) = context.chat_protocol.reaction_view(
                    friend_number,
                    &friend_public_key,
                    &reaction.target_id,
                ) {
                    persist_message_reaction_view(
                        &context.history_path,
                        context.history_enabled.load(Ordering::Relaxed),
                        &context.messages,
                        friend_number,
                        &friend_public_key,
                        &reaction.target_id,
                        view,
                    )?;
                }
            }
            commit_chat_transaction_with_barrier(
                &context.history_path,
                &context.chat_transport_ready,
            )?;
            let acknowledgement = chat_protocol::encode_reaction_ack_packet(&reaction, status)?;
            queue_chat_protocol_reply(
                context,
                friend_number,
                acknowledgement,
                reaction.pq_required,
            )?;
            if status == ReactionAckStatus::Applied {
                bump_chat_view_revision(&context.history_path, friend_number, &friend_public_key);
                if let Some(updates) = &context.updates {
                    updates.changed();
                }
            }
        }
        IncomingChatPacket::ReactionAck(acknowledgement) => {
            if acknowledgement.pq_required != pq_protected {
                return Err("CHAT_REACTION_ACK_PQ_POLICY_MISMATCH".to_string());
            }
            stage_chat_mutation_result(
                &context.history_path,
                &context.chat_transport_ready,
                context.chat_protocol.acknowledge_reaction(
                    friend_number,
                    &friend_public_key,
                    &acknowledgement,
                ),
            )?;
            if let Some(view) = context.chat_protocol.reaction_view(
                friend_number,
                &friend_public_key,
                &acknowledgement.target_id,
            ) {
                persist_message_reaction_view(
                    &context.history_path,
                    context.history_enabled.load(Ordering::Relaxed),
                    &context.messages,
                    friend_number,
                    &friend_public_key,
                    &acknowledgement.target_id,
                    view,
                )?;
            }
            commit_chat_transaction_with_barrier(
                &context.history_path,
                &context.chat_transport_ready,
            )?;
            bump_chat_view_revision(&context.history_path, friend_number, &friend_public_key);
            if let Some(updates) = &context.updates {
                updates.changed();
            }
        }
    }
    Ok(())
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
    let raw_text = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(message, length) })
        .into_owned();
    let context = unsafe { &*(user_data as *const CallbackContext) };
    mark_friend_authorized(context, tox, friend_number);
    log_network(
        &context.network_log_path,
        format!(
            "FRIEND_MESSAGE friend={friend_number} bytes={length} fingerprint={}",
            event_fingerprint(raw_text.as_bytes())
        ),
    );
    let friend_public_key = tox_friend_public_key(tox, friend_number).unwrap_or_default();
    if context.chat_protocol.supports(friend_number)
        && chat_protocol::is_message_fragment(&raw_text)
    {
        match context.chat_protocol.accept_message_fragment(
            friend_number,
            &friend_public_key,
            &raw_text,
            unix_timestamp(),
        ) {
            Ok(Some(envelope)) => {
                let _ = store_incoming_chat_message(
                    context,
                    tox,
                    friend_number,
                    Some(envelope),
                    None,
                    false,
                );
            }
            Ok(None) => {}
            Err(error) => log_network(
                &context.network_log_path,
                format!("CHAT_MESSAGE_REJECTED friend={friend_number} error={error}"),
            ),
        }
        return;
    }
    let _ = store_incoming_chat_message(context, tox, friend_number, None, Some(raw_text), false);
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
    if file_card_protocol::is_packet(bytes) {
        mark_friend_authorized(context, tox, friend_number);
        if let Err(error) = handle_file_card_packet(context, tox, friend_number, bytes) {
            log_network(
                &context.network_log_path,
                format!(
                    "FILE_CARD_PACKET_REJECTED friend={friend_number} bytes={length} error={error}"
                ),
            );
        }
        return;
    }
    if ChatProtocolEngine::is_packet(bytes) {
        mark_friend_authorized(context, tox, friend_number);
        if let Err(error) = handle_chat_protocol_packet(context, tox, friend_number, bytes, false) {
            log_network(
                &context.network_log_path,
                format!("CHAT_PACKET_REJECTED friend={friend_number} bytes={length} error={error}"),
            );
        }
        return;
    }
    let result = match (|| {
        let _transaction = context
            .chat_transaction_gate
            .lock()
            .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE")?;
        let key = tox_friend_public_key(tox, friend_number).ok_or("FRIEND_NOT_FOUND")?;
        bind_pq_contact(
            &context.pq,
            &context.messages,
            &context.history_path,
            friend_number,
            &key,
            &pq_tox_owner(tox),
        )?;
        context.pq.handle_packet_observed(
            friend_number,
            bytes,
            context.network_enabled.load(Ordering::Acquire),
        )
    })() {
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
    let mut application_accepted = true;
    if let Some(text) = result.received_text {
        application_accepted = match chat_protocol::decode_pq_service_packet(&text) {
            Ok(Some(packet)) => {
                match handle_chat_protocol_packet(context, tox, friend_number, &packet, true) {
                    Ok(()) => true,
                    Err(error) => {
                        log_network(
                            &context.network_log_path,
                            format!("CHAT_PQ_PACKET_REJECTED friend={friend_number} error={error}"),
                        );
                        false
                    }
                }
            }
            Ok(None) => match chat_protocol::decode_pq_message(&text) {
                Ok(Some(envelope)) => store_incoming_chat_message(
                    context,
                    tox,
                    friend_number,
                    Some(envelope),
                    None,
                    true,
                )
                .is_ok(),
                Ok(None) if !context.pq.is_v2(friend_number) => {
                    store_incoming_chat_message(context, tox, friend_number, None, Some(text), true)
                        .is_ok()
                }
                Ok(None) => false, // V2 requires a durable application message ID.
                Err(error) => {
                    log_network(
                        &context.network_log_path,
                        format!("CHAT_PQ_MESSAGE_REJECTED friend={friend_number} error={error}"),
                    );
                    false
                }
            },
            Err(error) => {
                log_network(
                    &context.network_log_path,
                    format!("CHAT_PQ_PACKET_REJECTED friend={friend_number} error={error}"),
                );
                false
            }
        };
    }
    // A PQ data ACK is queued only after the decrypted application payload has
    // been durably accepted above. A sender can therefore retry after a crash
    // without either losing the payload or creating a second message/reaction.
    if application_accepted {
        if let Some(wire_id) = result.received_wire_id {
            if let Ok(_transaction) = context.chat_transaction_gate.lock() {
                match context.pq.commit_received(friend_number, wire_id) {
                    Ok(packets) => context.pq.queue(friend_number, packets),
                    Err(error) => log_network(
                        &context.network_log_path,
                        format!("PQ_RECEIVE_COMMIT_WAIT friend={friend_number} error={error}"),
                    ),
                }
            }
        }
        if !result.outgoing.is_empty() {
            context.pq.queue(friend_number, result.outgoing);
        }
    } else if let Some(wire_id) = result.received_wire_id {
        context.pq.discard_received(friend_number, wire_id);
    }
    if let Some(wire_id) = result
        .acknowledged_wire_id
        .filter(|_| !context.pq.is_v2(friend_number))
    {
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
            let friend_public_key = tox_friend_public_key(tox, friend_number).unwrap_or_default();
            let _ = context.chat_protocol.update_message_operation_delivery(
                friend_number,
                &friend_public_key,
                &local_id,
                "delivered",
            );
            drop_cached_message_if_inactive_evicted(
                &context.messages,
                &context.history_residency,
                &local_id,
            );
        }
    }
    log_network(
        &context.network_log_path,
        format!("PQ_PACKET friend={friend_number} bytes={length}"),
    );
}

unsafe extern "C" fn on_friend_delivery_receipt(
    tox: *mut c_void,
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
            format!(
                "DELIVERY_RECEIPT_UNMATCHED friend={friend_number} tox_message_id={message_id}"
            ),
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
    log_network(&context.network_log_path, format!("DELIVERY_RECEIPT friend={friend_number} tox_message_id={message_id} local_id={local_id} delivered_at={delivered_at}"));
    if fully_delivered {
        persist_tox_history(
            &context.messages,
            &context.history_path,
            &context.history_enabled,
        );
        let friend_public_key = tox_friend_public_key(tox, friend_number).unwrap_or_default();
        let _ = context.chat_protocol.update_message_operation_delivery(
            friend_number,
            &friend_public_key,
            &local_id,
            "delivered",
        );
        drop_cached_message_if_inactive_evicted(
            &context.messages,
            &context.history_residency,
            &local_id,
        );
    }
}

fn reconcile_reaction_targets(
    engine: &ChatProtocolEngine,
    history_path: &Path,
    history_enabled: bool,
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    friend_number: u32,
    friend_public_key: &str,
) -> Result<(), String> {
    let recent = if history_enabled && chat_history_store::contains_registered(history_path) {
        chat_history_store::latest_user_registered(
            history_path,
            friend_number,
            friend_public_key,
            chat_protocol::REACTION_ELIGIBLE_MESSAGE_COUNT,
        )?
    } else {
        let messages = messages
            .lock()
            .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
        let mut recent = messages
            .iter()
            .rev()
            .filter(|message| {
                message.event.is_none()
                    && message_matches_friend(message, friend_number, friend_public_key)
            })
            .take(chat_protocol::REACTION_ELIGIBLE_MESSAGE_COUNT)
            .cloned()
            .collect::<Vec<_>>();
        recent.reverse();
        recent
    };
    let eligible = recent
        .iter()
        .filter(|message| message.protocol_version == Some(chat_protocol::VERSION))
        .map(|message| message.id.clone())
        .collect::<HashSet<_>>();
    engine.retain_reaction_targets(friend_number, friend_public_key, &eligible)
}

fn persist_message_reaction_view(
    history_path: &Path,
    history_enabled: bool,
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    friend_number: u32,
    friend_public_key: &str,
    message_id: &str,
    view: ReactionView,
) -> Result<(), String> {
    let mut resident = messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
    if let Some(message) = resident.iter_mut().find(|message| {
        message.id == message_id
            && message_matches_friend(message, friend_number, friend_public_key)
    }) {
        if message.reactions.as_ref() == Some(&view) {
            return Ok(());
        }
        let previous = message.reactions.clone();
        message.reactions = Some(view.clone());
        let row = message.clone();
        let completed = if history_enabled {
            match enqueue_registered_history_rows_required(std::slice::from_ref(&row), history_path)
            {
                Ok(completed) => Some(completed),
                Err(error) => {
                    message.reactions = previous;
                    return Err(error);
                }
            }
        } else {
            None
        };
        // The FIFO position is now reserved while the resident row is still
        // locked. A concurrent attachment snapshot can only observe the new
        // reaction and enqueue after this write.
        drop(resident);
        if let Some(completed) = completed {
            if let Err(error) = wait_for_registered_history_write(completed) {
                if let Ok(mut resident) = messages.lock() {
                    if let Some(message) = resident.iter_mut().find(|message| {
                        message.id == message_id
                            && message_matches_friend(message, friend_number, friend_public_key)
                            && message.reactions.as_ref() == Some(&view)
                    }) {
                        // Roll back only the reaction field. Transfer callbacks
                        // may have changed the attachment while I/O was pending.
                        message.reactions = previous;
                    }
                }
                return Err(error);
            }
        }
        return Ok(());
    }
    drop(resident);

    let mut row = if history_enabled && chat_history_store::contains_registered(history_path) {
        chat_history_store::find_message_registered(
            history_path,
            friend_number,
            friend_public_key,
            message_id,
        )?
        .ok_or_else(|| "CHAT_REACTION_TARGET_UNKNOWN".to_string())?
    } else {
        return Err("CHAT_REACTION_TARGET_UNKNOWN".to_string());
    };
    if row.reactions.as_ref() == Some(&view) {
        return Ok(());
    }
    row.reactions = Some(view);
    write_registered_history_rows_required(std::slice::from_ref(&row), history_path)
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

fn normalize_status_message(value: &str) -> String {
    sanitize_untrusted_text(value).trim().to_string()
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

fn current_self_avatar_path(avatars_dir: &Path) -> Option<PathBuf> {
    profiles::list(avatars_dir)
        .ok()?
        .into_iter()
        .filter(|entry| {
            entry.is_file
                && entry
                    .path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("self-"))
        })
        .max_by(|left, right| left.path.file_name().cmp(&right.path.file_name()))
        .map(|entry| entry.path)
}

fn preferred_profile_avatar(
    profile: Option<&ToxState>,
    local_state: Option<&Value>,
) -> Option<String> {
    preferred_profile_avatar_from_directory(
        profile.map(|profile| profile.avatars_dir.as_path()),
        local_state,
    )
}

fn preferred_profile_avatar_from_directory(
    avatars_dir: Option<&Path>,
    local_state: Option<&Value>,
) -> Option<String> {
    if let Some(avatars_dir) = avatars_dir {
        return current_self_avatar_path(avatars_dir)
            .and_then(|path| avatar_data_url_from_path(&path).ok());
    }
    local_state.and_then(|state| {
        state
            .get("profileAvatar")
            .and_then(Value::as_str)
            .filter(|avatar| avatar.starts_with("data:image/"))
            .map(str::to_string)
    })
}

fn profile_media_source(path: &Path) -> Option<String> {
    if kai::managed_volume(path).is_none() {
        return Some(path.to_string_lossy().into_owned());
    }
    let mut bytes = profiles::read_file(path).ok()?;
    let mime = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let encoded = base64_basic(&bytes);
    wipe_sensitive_bytes(&mut bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn latest_friend_avatar_sources(avatars_dir: &Path) -> HashMap<u32, String> {
    let mut latest = HashMap::<u32, PathBuf>::new();
    for entry in profiles::list(avatars_dir).unwrap_or_default() {
        if !entry.is_file || !is_complete_avatar(&entry.path, None) {
            continue;
        }
        let Some(name) = entry.path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.ends_with(".part") {
            continue;
        }
        let Some(friend_number) = name
            .split_once('-')
            .and_then(|(number, _)| number.parse::<u32>().ok())
        else {
            continue;
        };
        let replace = latest
            .get(&friend_number)
            .and_then(|path| path.file_name())
            .is_none_or(|current| entry.path.file_name() > Some(current));
        if replace {
            latest.insert(friend_number, entry.path);
        }
    }
    latest
        .into_iter()
        .filter_map(|(number, path)| profile_media_source(&path).map(|source| (number, source)))
        .collect()
}

fn hydrate_attachment_preview_sources(messages: &mut [ToxMessage]) {
    for message in messages {
        let Some(attachment) = message.attachment.as_mut() else {
            continue;
        };
        if !attachment.image || (!message.mine && !attachment.completed) {
            continue;
        }
        let path = PathBuf::from(&attachment.path);
        if kai::managed_volume(&path).is_some() {
            attachment.preview_source = profile_media_source(&path);
        }
    }
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

fn current_self_avatar_matches(avatars_dir: &PathBuf, bytes: &[u8]) -> bool {
    current_self_avatar_path(avatars_dir)
        .and_then(|path| profiles::read_file(&path).ok())
        .map(|current| current == bytes)
        .unwrap_or(false)
}

fn log_transfer(path: &PathBuf, event: impl AsRef<str>) {
    if path.as_os_str().is_empty() {
        return;
    }
    let line = format!("{} {}\n", unix_timestamp(), event.as_ref());
    queue_log_write(path, line.into_bytes(), false);
}

fn log_network(path: &PathBuf, event: impl AsRef<str>) {
    if path.as_os_str().is_empty() {
        return;
    }
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
                    if kai::managed_volume(&path).is_some() {
                        let mut current = profiles::read_file(&path).unwrap_or_default();
                        if rotate
                            && current.len().saturating_add(bytes.len()) > MAX_LOG_SIZE as usize
                        {
                            let previous = path.with_extension("log.1");
                            let _ = profiles::remove_file(&previous);
                            let _ = profiles::rename(&path, &previous);
                            current.clear();
                        }
                        current.extend_from_slice(&bytes);
                        let _ = profiles::write_file(&path, &current);
                        continue;
                    }
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

#[inline]
unsafe fn callback_file_control(
    tox: *mut c_void,
    friend_number: u32,
    file_number: u32,
    control: i32,
    error: *mut i32,
) -> bool {
    #[cfg(test)]
    if let Some(result) = native_file_callback_pause_tests::with_io(|io| {
        io.controls.push((friend_number, file_number, control));
        unsafe { *error = 0 };
        true
    }) {
        return result;
    }
    unsafe { tox_file_control(tox, friend_number, file_number, control, error) }
}

#[inline]
fn callback_read_file_range(path: &Path, position: u64, length: usize) -> Result<Vec<u8>, String> {
    #[cfg(test)]
    if let Some(result) = native_file_callback_pause_tests::with_io(|io| {
        io.reads.push((position, length));
        let start = usize::try_from(position).map_err(|_| "invalid test range".to_string())?;
        let end = start.checked_add(length).ok_or("invalid test range")?;
        io.source
            .get(start..end)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid test range".to_string())
    }) {
        return result;
    }
    read_file_range(path, position, length)
}

#[inline]
unsafe fn callback_file_send_chunk(
    tox: *mut c_void,
    friend_number: u32,
    file_number: u32,
    position: u64,
    data: *const u8,
    length: usize,
    error: *mut i32,
) -> bool {
    #[cfg(test)]
    if let Some(result) = native_file_callback_pause_tests::with_io(|io| {
        let bytes = if length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(data, length).to_vec() }
        };
        io.chunks
            .push((friend_number, file_number, position, bytes));
        unsafe { *error = 0 };
        true
    }) {
        return result;
    }
    unsafe {
        tox_file_send_chunk(
            tox,
            friend_number,
            file_number,
            position,
            data,
            length,
            error,
        )
    }
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
    if length > 0 && transfer.locally_paused {
        // toxcore may have queued this request before the local PAUSE took
        // effect. Keep the source and progress untouched until local resume.
        // A zero-length final acknowledgement still completes an already sent stream.
        return;
    }
    if length > 0 {
        if let Ok(mut files) = context.outgoing_files.lock() {
            if let Some(active) = files.get_mut(&(friend_number, file_number)) {
                if active.phase == OutgoingFilePhase::WaitingForAcceptance {
                    // A real chunk request also proves acceptance if the peer's
                    // RESUME callback was not observed. A source-read failure
                    // after this point still has the normal idle deadline.
                    active.note_peer_activity(Instant::now());
                }
            }
        }
    }
    #[cfg(feature = "web-core")]
    let web_transfer = transfer.web_transfer_id.is_some();
    #[cfg(not(feature = "web-core"))]
    let web_transfer = false;
    #[cfg(feature = "web-core")]
    if let Some(transfer_id) = transfer.web_transfer_id.as_deref() {
        let handled = context
            .web_file_bridge
            .as_ref()
            .map(|bridge| bridge.on_outgoing_request(transfer_id, position, length))
            .unwrap_or(false);
        if length > 0 {
            // The workspace transfer worker supplies this requested range from
            // the committed server source. Callbacks only publish demand; they
            // never read the filesystem or wait for the storage worker.
            if !handled && !tox.is_null() {
                let mut error = 0_i32;
                unsafe {
                    let _ = callback_file_control(tox, friend_number, file_number, 2, &mut error);
                }
            }
            return;
        }
    }
    if !web_transfer && (position == 0 || length == 0) {
        log_transfer(&context.transfer_log_path, format!("SEND_CHUNK_REQUEST friend={friend_number} file={file_number} pos={position} len={length}"));
    }
    // A zero-length request is toxcore's final acknowledgement: the peer has
    // consumed the complete stream. It is not a request to send an empty
    // chunk. Sending one here made toxcore return an error, so the transfer
    // was never marked complete and the timeout worker offered it again.
    if length == 0 {
        if !web_transfer {
            log_transfer(
                &context.transfer_log_path,
                format!("SEND_COMPLETE friend={friend_number} file={file_number}"),
            );
        }
        let completed = context
            .outgoing_files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(&(friend_number, file_number)));
        if let Some(transfer) = completed {
            #[cfg(feature = "web-core")]
            if transfer.web_transfer_id.is_some()
                && context
                    .web_file_bridge
                    .as_ref()
                    .is_some_and(|bridge| bridge.uses_durable_storage())
            {
                // The bridge queues a durable delivery receipt on its bounded
                // storage worker. Reconciliation publishes the completed card
                // only after that receipt is committed; callbacks never wait for I/O.
                return;
            }
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
                finish_file_card_runtime_state(
                    &context.messages,
                    &context.history_residency,
                    &context.file_card_protocol,
                    friend_number,
                    &message_id,
                );
            }
        }
        return;
    }

    let data = if let Some(source) = transfer.source_bytes.as_ref() {
        let Ok(start) = usize::try_from(position) else {
            return;
        };
        let Some(end) = start.checked_add(length).filter(|end| *end <= source.len()) else {
            return;
        };
        source[start..end].to_vec()
    } else {
        let Ok(data) = callback_read_file_range(&transfer.path, position, length) else {
            return;
        };
        data
    };
    let mut error = 0_i32;
    unsafe {
        let _ = callback_file_send_chunk(
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
                active.note_peer_activity(Instant::now());
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

#[cfg(test)]
mod native_file_callback_pause_tests {
    use super::*;

    const FRIEND: u32 = 7;
    const FILE: u32 = 11;
    const MESSAGE: &str = "native-local-pause-callback";

    #[derive(Clone, Default)]
    pub(super) struct CallbackIo {
        pub(super) controls: Vec<(u32, u32, i32)>,
        pub(super) reads: Vec<(u64, usize)>,
        pub(super) chunks: Vec<(u32, u32, u64, Vec<u8>)>,
        pub(super) source: Vec<u8>,
    }

    std::thread_local! {
        static IO: std::cell::RefCell<Option<CallbackIo>> = const { std::cell::RefCell::new(None) };
    }

    pub(super) fn with_io<T>(operation: impl FnOnce(&mut CallbackIo) -> T) -> Option<T> {
        IO.with(|slot| slot.borrow_mut().as_mut().map(operation))
    }

    struct IoGuard;

    impl IoGuard {
        fn new() -> Self {
            IO.with(|slot| {
                let mut slot = slot.borrow_mut();
                assert!(slot.is_none(), "callback observer must not be nested");
                *slot = Some(CallbackIo {
                    source: b"abcdefgh".to_vec(),
                    ..CallbackIo::default()
                });
            });
            Self
        }

        fn snapshot(&self) -> CallbackIo {
            with_io(|io| io.clone()).unwrap()
        }
    }

    impl Drop for IoGuard {
        fn drop(&mut self) {
            IO.with(|slot| *slot.borrow_mut() = None);
        }
    }

    struct OwnedRoot(PathBuf);

    impl Drop for OwnedRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Fixture {
        context: CallbackContext,
        _root: OwnedRoot,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            chat_history_store::unregister(&self.context.history_path);
        }
    }

    impl Fixture {
        fn new() -> Self {
            let suffix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = OwnedRoot(std::env::temp_dir().join(format!(
                "kaigen-native-local-pause-{}-{suffix}",
                std::process::id()
            )));
            fs::create_dir(&root.0).unwrap();
            let message = serde_json::from_value(serde_json::json!({
                "id": MESSAGE, "friend_number": FRIEND, "text": "", "mine": true,
                "timestamp": 1, "attachment": {
                    "name": "payload.bin", "size": 8, "mime": "application/octet-stream",
                    "path": "payload.bin", "transfer_state": "sending", "completed": false
                }
            }))
            .unwrap();
            let now = Instant::now();
            let transfer = OutgoingFile {
                path: root.0.join("payload.bin"),
                filename: "payload.bin".to_string(),
                mime: "application/octet-stream".to_string(),
                size: 8,
                // Exercise the actual source-read branch, not only an in-memory slice.
                source_bytes: None,
                message_id: Some(MESSAGE.to_string()),
                protocol_transfer_id: None,
                meter: TransferMeter {
                    last_at: now - Duration::from_secs(1),
                    last_transferred: 0,
                    speed_bytes_per_sec: 0,
                },
                last_activity_at: now,
                active: true,
                locally_paused: false,
                phase: OutgoingFilePhase::WaitingForAcceptance,
                fully_sent: false,
                retry_count: 0,
                #[cfg(feature = "web-core")]
                web_transfer_id: None,
            };
            let context = CallbackContext {
                updates: None,
                incoming_requests: Arc::new(Mutex::new(Vec::new())),
                incoming_requests_path: root.0.join("requests.json"),
                messages: Arc::new(Mutex::new(vec![message])),
                history_residency: Arc::new(Mutex::new(HashMap::new())),
                delivery_receipts: Arc::new(Mutex::new(HashMap::new())),
                receipt_progress: Arc::new(Mutex::new(HashMap::new())),
                history_path: root.0.join("history.json"),
                history_enabled: Arc::new(AtomicBool::new(false)),
                pending_files: Arc::new(Mutex::new(Vec::new())),
                pending_files_path: root.0.join("pending.json"),
                incoming_files: Arc::new(Mutex::new(HashMap::new())),
                outgoing_files: Arc::new(Mutex::new(HashMap::from([((FRIEND, FILE), transfer)]))),
                downloads_dir: root.0.join("downloads"),
                avatars_dir: root.0.join("avatars"),
                transfer_log_path: root.0.join("transfer.log"),
                network_log_path: root.0.join("network.log"),
                friend_cache: Arc::new(Mutex::new(HashMap::new())),
                friend_cache_path: root.0.join("friends.json"),
                pq: Arc::new(PqEngine::new(&root.0).unwrap()),
                chat_protocol: Arc::new(ChatProtocolEngine::new(&root.0).unwrap()),
                file_card_protocol: Arc::new(FileCardEngine::new(&root.0).unwrap()),
                pq_receipts: Arc::new(Mutex::new(HashMap::new())),
                file_receive_settings: Arc::new(Mutex::new(FileReceiveSettings::default())),
                unread_state: Arc::new(Mutex::new(UnreadState::default())),
                unread_state_path: root.0.join("unread.json"),
                friend_message_ready_at: Arc::new(Mutex::new(HashMap::new())),
                network_enabled: Arc::new(AtomicBool::new(false)),
                chat_transaction_gate: Arc::new(Mutex::new(())),
                chat_transport_ready: Arc::new(AtomicBool::new(false)),
                #[cfg(feature = "web-core")]
                web_profile_id: None,
                #[cfg(feature = "web-core")]
                web_file_bridge: None,
            };
            Self {
                context,
                _root: root,
            }
        }

        fn local_pause(&self, paused: bool) {
            // This is the command's local-intent update, including the accepted
            // ALREADY_PAUSED result when the peer has not accepted the offer yet.
            self.context
                .outgoing_files
                .lock()
                .unwrap()
                .get_mut(&(FRIEND, FILE))
                .unwrap()
                .set_local_paused(paused, Instant::now());
            set_attachment_transfer_state(
                &self.context.messages,
                MESSAGE,
                if paused { "paused" } else { "sending" },
            );
        }

        fn peer_control(&mut self, control: i32) {
            // Both callbacks' native calls are intercepted while IoGuard is alive.
            let tox = std::ptr::NonNull::<u8>::dangling()
                .as_ptr()
                .cast::<c_void>();
            let user_data = (&mut self.context as *mut CallbackContext).cast::<c_void>();
            unsafe { on_file_recv_control(tox, FRIEND, FILE, control, user_data) };
        }

        fn chunk(&mut self) {
            self.chunk_at(0, 4);
        }

        fn chunk_at(&mut self, position: u64, length: usize) {
            let tox = std::ptr::NonNull::<u8>::dangling()
                .as_ptr()
                .cast::<c_void>();
            let user_data = (&mut self.context as *mut CallbackContext).cast::<c_void>();
            unsafe { on_file_chunk_request(tox, FRIEND, FILE, position, length, user_data) };
        }

        fn transfer(&self) -> OutgoingFile {
            self.context.outgoing_files.lock().unwrap()[&(FRIEND, FILE)].clone()
        }

        fn attachment(&self) -> ToxAttachment {
            self.context.messages.lock().unwrap()[0]
                .attachment
                .clone()
                .unwrap()
        }
    }

    fn file_card_ack_fixture() -> (Fixture, String, String, file_card_protocol::FileCardAck) {
        let fixture = Fixture::new();
        let public_key = "A1".repeat(32);
        let message_id = "b1".repeat(16);
        let next_id = "b2".repeat(16);
        let rows = [message_id.clone(), next_id]
            .into_iter()
            .enumerate()
            .map(|(index, id)| {
                serde_json::from_value::<ToxMessage>(serde_json::json!({
                    "id": id, "friend_number": FRIEND, "friend_public_key": public_key,
                    "text": "", "mine": true, "timestamp": index as u64 + 1,
                    "delivery": "pending", "protocol_version": file_card_protocol::VERSION,
                    "attachment": { "name": format!("ack-{index}.bin"), "size": 8,
                        "mime": "application/octet-stream", "path": format!("ack-{index}.bin"),
                        "transfer_state": "queued", "completed": false }
                }))
                .unwrap()
            })
            .collect::<Vec<_>>();
        let pending = rows
            .iter()
            .map(|row| {
                let attachment = row.attachment.as_ref().unwrap();
                PendingToxFile {
                    id: row.id.clone(),
                    friend_number: FRIEND,
                    friend_public_key: public_key.clone(),
                    filename: attachment.name.clone(),
                    mime: attachment.mime.clone(),
                    path: attachment.path.clone(),
                    size: attachment.size,
                    timestamp: row.timestamp,
                    retry_count: 0,
                    transfer_id: None,
                    announcement_acked: false,
                    protocol_version: Some(file_card_protocol::VERSION),
                }
            })
            .collect::<Vec<_>>();
        *fixture.context.messages.lock().unwrap() = rows.clone();
        *fixture.context.pending_files.lock().unwrap() = pending;
        fixture.context.outgoing_files.lock().unwrap().clear();
        fixture
            .context
            .history_enabled
            .store(true, Ordering::Relaxed);
        chat_history_store::open_and_register(&fixture.context.history_path, rows).unwrap();
        persist_pending_files_required(
            &fixture.context.pending_files,
            &fixture.context.pending_files_path,
        )
        .unwrap();
        let offer = fixture
            .context
            .file_card_protocol
            .offer_for_send(FRIEND, &public_key, &message_id, "ack-0.bin", 8)
            .unwrap();
        let acknowledgement =
            file_card_protocol::ack_for_offer(&offer, FileCardAckStatus::Rejected);
        (fixture, public_key, message_id, acknowledgement)
    }

    #[test]
    fn native_file_card_ack_rejection_is_visible_in_registered_history_after_reopen() {
        let (fixture, public_key, message_id, acknowledgement) = file_card_ack_fixture();
        apply_file_card_acknowledgement(&fixture.context, FRIEND, &public_key, &acknowledgement)
            .unwrap();
        let readback = chat_history_store::latest_registered(
            &fixture.context.history_path,
            FRIEND,
            &public_key,
            10,
        )
        .unwrap();
        let received = readback.iter().find(|row| row.id == message_id).unwrap();
        assert_eq!(
            received.attachment.as_ref().unwrap().transfer_state,
            "failed",
            "the real get_tox_messages read path must see rejection without an unrelated write"
        );
        chat_history_store::unregister(&fixture.context.history_path);
        chat_history_store::open_and_register(&fixture.context.history_path, Vec::new()).unwrap();
        let reopened = chat_history_store::latest_registered(
            &fixture.context.history_path,
            FRIEND,
            &public_key,
            10,
        )
        .unwrap();
        assert_eq!(
            reopened
                .iter()
                .find(|row| row.id == message_id)
                .unwrap()
                .attachment
                .as_ref()
                .unwrap()
                .transfer_state,
            "failed"
        );
    }

    #[test]
    fn native_file_card_ack_rejection_releases_durable_queue_and_preserves_next_offer() {
        let (fixture, public_key, message_id, acknowledgement) = file_card_ack_fixture();
        apply_file_card_acknowledgement(&fixture.context, FRIEND, &public_key, &acknowledgement)
            .unwrap();
        let saved: Vec<PendingToxFile> = serde_json::from_slice(
            &profiles::read_file(&fixture.context.pending_files_path).unwrap(),
        )
        .unwrap();
        assert_eq!(
            saved.len(),
            1,
            "rejected offers must release their queue capacity"
        );
        assert!(saved.iter().all(|item| item.id != message_id));
        assert_eq!(saved[0].id, "b2".repeat(16));
        assert!(!saved[0].announcement_acked);
        assert_eq!(
            fixture.context.file_card_protocol.outgoing_acknowledgement(
                FRIEND,
                &public_key,
                &message_id
            ),
            Some(FileCardAckStatus::Rejected),
            "Web needs the durable rejection until its bridge observes it"
        );
        apply_file_card_acknowledgement(&fixture.context, FRIEND, &public_key, &acknowledgement)
            .unwrap();
        assert_eq!(
            fixture.context.pending_files.lock().unwrap().len(),
            1,
            "duplicate rejection cannot remove the next offer"
        );
    }

    #[test]
    fn native_file_card_ack_rejection_recovers_old_durable_queue_without_another_peer_packet() {
        let (fixture, public_key, message_id, acknowledgement) = file_card_ack_fixture();
        fixture
            .context
            .file_card_protocol
            .acknowledge_offer(FRIEND, &public_key, &acknowledgement)
            .unwrap();
        let restarted_engine = FileCardEngine::new(&fixture._root.0).unwrap();
        let restored_pending: Vec<PendingToxFile> = serde_json::from_slice(
            &profiles::read_file(&fixture.context.pending_files_path).unwrap(),
        )
        .unwrap();
        *fixture.context.pending_files.lock().unwrap() = restored_pending;
        fixture.context.messages.lock().unwrap().clear();
        assert_eq!(
            reconcile_rejected_file_cards(
                &restarted_engine,
                &fixture.context.pending_files,
                &fixture.context.pending_files_path,
                &fixture.context.messages,
                &fixture.context.history_path,
                &fixture.context.history_enabled
            )
            .unwrap(),
            1
        );
        let saved = chat_history_store::latest_registered(
            &fixture.context.history_path,
            FRIEND,
            &public_key,
            10,
        )
        .unwrap();
        let rejected = saved.iter().find(|row| row.id == message_id).unwrap();
        assert_eq!(
            rejected.attachment.as_ref().unwrap().transfer_state,
            "failed"
        );
        assert_eq!(
            rejected
                .attachment
                .as_ref()
                .unwrap()
                .transfer_error
                .as_deref(),
            Some("TRANSFER_REJECTED_BY_RECIPIENT")
        );
        assert_eq!(rejected.delivery, "failed");
        assert!(!message_requires_runtime_residency(rejected));
        assert_eq!(fixture.context.pending_files.lock().unwrap().len(), 1);
        assert_eq!(
            reconcile_rejected_file_cards(
                &restarted_engine,
                &fixture.context.pending_files,
                &fixture.context.pending_files_path,
                &fixture.context.messages,
                &fixture.context.history_path,
                &fixture.context.history_enabled
            )
            .unwrap(),
            0,
            "idle reconciliation must not repeat persistence"
        );
    }

    #[test]
    fn native_file_card_ack_positive_keeps_queue_eligible_for_native_start() {
        let (fixture, public_key, message_id, mut acknowledgement) = file_card_ack_fixture();
        acknowledgement.status = FileCardAckStatus::Applied;
        apply_file_card_acknowledgement(&fixture.context, FRIEND, &public_key, &acknowledgement)
            .unwrap();
        let saved: Vec<PendingToxFile> = serde_json::from_slice(
            &profiles::read_file(&fixture.context.pending_files_path).unwrap(),
        )
        .unwrap();
        assert_eq!(saved.len(), 2);
        assert!(
            saved
                .iter()
                .find(|item| item.id == message_id)
                .unwrap()
                .announcement_acked
        );
        assert!(
            !saved
                .iter()
                .find(|item| item.id != message_id)
                .unwrap()
                .announcement_acked
        );
    }

    #[test]
    fn native_file_card_ack_rejection_notifies_live_views_without_saved_history() {
        let (mut fixture, public_key, message_id, acknowledgement) = file_card_ack_fixture();
        fixture
            .context
            .history_enabled
            .store(false, Ordering::Relaxed);
        let notices = Arc::new(AtomicU64::new(0));
        let changed = Arc::clone(&notices);
        fixture.context.updates = Some(ProfileUpdateEmitter(Arc::new(move || {
            changed.fetch_add(1, Ordering::Relaxed);
        })));
        let before = history_revision(&fixture.context.history_path);
        apply_file_card_acknowledgement(&fixture.context, FRIEND, &public_key, &acknowledgement)
            .unwrap();
        assert!(history_revision(&fixture.context.history_path) > before);
        assert_eq!(notices.load(Ordering::Relaxed), 1);
        assert_eq!(
            fixture
                .context
                .messages
                .lock()
                .unwrap()
                .iter()
                .find(|row| row.id == message_id)
                .unwrap()
                .attachment
                .as_ref()
                .unwrap()
                .transfer_state,
            "failed"
        );
        assert_eq!(fixture.context.pending_files.lock().unwrap().len(), 1);
    }

    #[test]
    fn native_callback_local_pause_before_accept_blocks_queued_chunk_until_local_resume() {
        let io = IoGuard::new();
        let mut fixture = Fixture::new();
        fixture.local_pause(true);
        fixture.peer_control(0);
        let accepted = fixture.transfer();
        fixture.chunk();

        let observed = io.snapshot();
        let paused = fixture.transfer();
        let attachment = fixture.attachment();
        assert_eq!(
            (
                observed.controls,
                observed.reads.len(),
                observed.chunks.len(),
                paused.meter.last_transferred,
                attachment.transferred,
                attachment.transfer_state.as_str(),
            ),
            (vec![(FRIEND, FILE, 1)], 0, 0, 0, 0, "paused"),
            "peer acceptance must reassert transport PAUSE; a queued callback must not read, send, or advance the paused card"
        );
        assert!(paused.locally_paused && !paused.active && !paused.fully_sent);
        assert_eq!(paused.last_activity_at, accepted.last_activity_at);
        assert_eq!(paused.meter.last_at, accepted.meter.last_at);

        fixture.local_pause(false);
        fixture.chunk();
        let observed = io.snapshot();
        assert_eq!(observed.reads, vec![(0, 4)]);
        assert_eq!(observed.chunks, vec![(FRIEND, FILE, 0, b"abcd".to_vec())]);
        assert_eq!(fixture.transfer().meter.last_transferred, 4);
        let attachment = fixture.attachment();
        assert_eq!(attachment.transferred, 4);
        assert_eq!(attachment.transfer_state, "sending");
        assert!(!attachment.completed);
    }

    #[test]
    fn native_callback_unpaused_peer_resume_reads_sends_and_updates_progress() {
        let io = IoGuard::new();
        let mut fixture = Fixture::new();
        fixture.peer_control(1);
        fixture.peer_control(0);
        fixture.chunk();
        let observed = io.snapshot();
        assert!(observed.controls.is_empty());
        assert_eq!(observed.reads, vec![(0, 4)]);
        assert_eq!(observed.chunks, vec![(FRIEND, FILE, 0, b"abcd".to_vec())]);
        let transfer = fixture.transfer();
        assert!(transfer.active && !transfer.locally_paused && !transfer.fully_sent);
        assert_eq!(transfer.phase, OutgoingFilePhase::Transferring);
        assert_eq!(transfer.meter.last_transferred, 4);
        let attachment = fixture.attachment();
        assert_eq!(attachment.transferred, 4);
        assert_eq!(attachment.transfer_state, "sending");
        assert!(!attachment.completed);
    }

    #[test]
    fn native_callback_local_pause_preserves_final_ack_for_fully_sent_stream() {
        let io = IoGuard::new();
        let mut fixture = Fixture::new();
        fixture.peer_control(0);
        fixture.chunk_at(0, 8);
        assert!(fixture.transfer().fully_sent);
        assert_eq!(fixture.attachment().transfer_state, "awaiting_confirmation");
        fixture.local_pause(true);
        fixture.chunk_at(8, 0);

        let observed = io.snapshot();
        assert_eq!(observed.reads, vec![(0, 8)]);
        assert_eq!(
            observed.chunks,
            vec![(FRIEND, FILE, 0, b"abcdefgh".to_vec())]
        );
        assert!(!fixture
            .context
            .outgoing_files
            .lock()
            .unwrap()
            .contains_key(&(FRIEND, FILE)));
        let attachment = fixture.attachment();
        assert_eq!(attachment.transferred, 8);
        assert_eq!(attachment.transfer_state, "complete");
        assert!(attachment.completed && attachment.completed_at.is_some());
        let messages = fixture.context.messages.lock().unwrap();
        assert_eq!(messages[0].delivery, "delivered");
        assert!(messages[0].delivered_at.is_some());
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
    let friend_public_key = tox_friend_public_key(tox, friend_number).unwrap_or_default();
    let protocol_binding = if is_avatar {
        None
    } else {
        let mut transfer_id = [0_u8; 32];
        let mut file_id_error = 0_i32;
        let has_file_id = unsafe {
            tox_file_get_file_id(
                tox,
                friend_number,
                file_number,
                transfer_id.as_mut_ptr(),
                &mut file_id_error,
            )
        };
        if has_file_id && file_id_error == 0 {
            context.file_card_protocol.binding_by_transfer_id(
                friend_number,
                &friend_public_key,
                transfer_id,
            )
        } else {
            None
        }
    };
    if let Some(binding) = protocol_binding.as_ref() {
        let valid = binding.direction == FileCardDirection::Incoming
            && binding.filename == name
            && binding.size == file_size
            && !binding.pq_required;
        if !valid {
            let mut error = 0_i32;
            unsafe {
                let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
            }
            set_attachment_transfer_error(
                &context.messages,
                &binding.message_id,
                "Метаданные передачи не совпадают с подтверждённой карточкой файла.",
            );
            persist_tox_history(
                &context.messages,
                &context.history_path,
                &context.history_enabled,
            );
            return;
        }
        if ensure_incoming_file_card(context, binding).is_err() {
            let mut error = 0_i32;
            unsafe {
                let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
            }
            return;
        }
    }
    let settings = context
        .file_receive_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_else(|_| FileReceiveSettings::blocked());
    if !is_avatar && file_size > MAX_CHAT_FILE_BYTES {
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
        }
        log_transfer(
            &context.transfer_log_path,
            format!("RECV_REJECTED_TOO_LARGE friend={friend_number} file={file_number} size={file_size} limit={MAX_CHAT_FILE_BYTES} error={error}"),
        );
        return;
    }
    if !is_avatar && settings.deny_all {
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
        }
        if let Some(binding) = protocol_binding.as_ref() {
            set_attachment_transfer_cancelled(
                &context.messages,
                &binding.message_id,
                FILE_RECEIVE_DENIED_REASON,
            );
            persist_tox_history(
                &context.messages,
                &context.history_path,
                &context.history_enabled,
            );
        }
        log_transfer(&context.transfer_log_path, format!("RECV_REJECTED_BY_POLICY friend={friend_number} file={file_number} size={file_size} name={name} error={error}"));
        return;
    }
    #[cfg(feature = "web-core")]
    if !is_avatar {
        if let (Some(profile_id), Some(bridge)) = (
            context.web_profile_id.as_deref(),
            context.web_file_bridge.as_ref(),
        ) {
            let message_id = protocol_binding
                .as_ref()
                .map(|binding| binding.message_id.clone())
                .unwrap_or_else(|| new_message_id(friend_number));
            let mime = if image {
                "image/*".to_string()
            } else {
                "application/octet-stream".to_string()
            };
            let transfer_id = match bridge.offer_incoming(
                profile_id,
                friend_number,
                file_number,
                message_id.clone(),
                name.clone(),
                mime.clone(),
                file_size,
            ) {
                Ok(value) => value,
                Err(_) => {
                    let mut error = 0_i32;
                    unsafe {
                        let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
                    }
                    return;
                }
            };
            if protocol_binding.is_none() {
                if let Ok(mut messages) = context.messages.lock() {
                    messages.push(ToxMessage {
                        id: message_id.clone(),
                        friend_number,
                        friend_public_key: friend_public_key.clone(),
                        text: String::new(),
                        mine: false,
                        timestamp: unix_timestamp(),
                        delivery: default_message_delivery(),
                        delivered_at: None,
                        attachment: Some(ToxAttachment {
                            name,
                            size: file_size,
                            mime,
                            path: format!("browser-stream://{transfer_id}"),
                            preview_source: None,
                            image,
                            transferred: 0,
                            speed_bytes_per_sec: 0,
                            eta_seconds: None,
                            transfer_state: "awaiting_confirmation".to_string(),
                            completed: false,
                            completed_at: None,
                            transfer_error: None,
                            retry_count: 0,
                        }),
                        event: None,
                        protocol_version: None,
                        operation_id: None,
                        quote: None,
                        formatting: Vec::new(),
                        pq_protected: false,
                        reactions: None,
                    });
                }
            } else if let Ok(mut messages) = context.messages.lock() {
                if let Some(message) = messages.iter_mut().find(|item| item.id == message_id) {
                    if let Some(attachment) = message.attachment.as_mut() {
                        attachment.path = format!("browser-stream://{transfer_id}");
                        attachment.mime = mime.clone();
                        attachment.transfer_state = "awaiting_confirmation".to_string();
                    }
                }
            }
            persist_tox_history(
                &context.messages,
                &context.history_path,
                &context.history_enabled,
            );
            if protocol_binding.is_none() {
                increment_unread_friend_message(
                    context,
                    friend_number,
                    &friend_public_key,
                    &message_id,
                );
            }
            return;
        }
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
    let automatically_allowed = is_avatar || settings.auto_accepts(&name, file_size);
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
    if let Err(error) = profiles::create_dir_all(base) {
        log_transfer(&context.transfer_log_path, format!("RECV_DIRECTORY_FAILED friend={friend_number} file={file_number} kind={kind} path={} error={error}", base.display()));
        return;
    }
    if let Err(error) = create_transfer_file(&path) {
        log_transfer(&context.transfer_log_path, format!("RECV_CREATE_FAILED friend={friend_number} file={file_number} kind={kind} path={} error={error}", path.display()));
        return;
    }
    log_transfer(&context.transfer_log_path, format!("RECV_OFFER friend={friend_number} file={file_number} kind={kind} size={file_size} name={name}"));
    let message_id = if is_avatar {
        None
    } else {
        Some(
            protocol_binding
                .as_ref()
                .map(|binding| binding.message_id.clone())
                .unwrap_or_else(|| new_message_id(friend_number)),
        )
    };
    if let Some(message_id) = &message_id {
        if let Ok(mut messages) = context.messages.lock() {
            if let Some(message) = messages
                .iter_mut()
                .find(|message| message.id == *message_id)
            {
                if let Some(attachment) = message.attachment.as_mut() {
                    attachment.path = path.to_string_lossy().into_owned();
                    attachment.mime = if image {
                        "image/*".to_string()
                    } else {
                        "application/octet-stream".to_string()
                    };
                    attachment.transfer_state = if start_now {
                        "receiving"
                    } else if auto_queued {
                        "queued"
                    } else {
                        "awaiting_confirmation"
                    }
                    .to_string();
                }
            } else {
                messages.push(ToxMessage {
                    id: message_id.clone(),
                    friend_number,
                    friend_public_key: friend_public_key.clone(),
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
                        preview_source: None,
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
                    protocol_version: None,
                    operation_id: None,
                    quote: None,
                    formatting: Vec::new(),
                    pq_protected: false,
                    reactions: None,
                });
            }
        }
        persist_tox_history(
            &context.messages,
            &context.history_path,
            &context.history_enabled,
        );
        if protocol_binding.is_none() {
            increment_unread_friend_message(context, friend_number, &friend_public_key, message_id);
        }
    }
    if let Ok(mut files) = context.incoming_files.lock() {
        let buffered_target = kai::managed_volume(&path).map(|_| Arc::new(Mutex::new(Vec::new())));
        files.insert(
            (friend_number, file_number),
            IncomingFile {
                path,
                final_path,
                size: file_size,
                buffered_target,
                kind: if is_avatar { 1 } else { kind },
                message_id,
                protocol_transfer_id: protocol_binding.as_ref().map(|binding| binding.transfer_id),
                meter: TransferMeter::new(),
                last_activity_at: Instant::now(),
                active: start_now,
                locally_paused: false,
                auto_queued,
                queue_order: NEXT_INCOMING_FILE_QUEUE_ORDER.fetch_add(1, Ordering::Relaxed),
            },
        );
    }
    if start_now {
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 0, &mut error);
        }
        if error != 0 && error != 4 {
            if let Ok(mut files) = context.incoming_files.lock() {
                if let Some(file) = files.get_mut(&(friend_number, file_number)) {
                    file.active = false;
                    file.auto_queued = automatically_allowed && !is_avatar;
                }
            }
            if let Some(message_id) = context
                .incoming_files
                .lock()
                .ok()
                .and_then(|files| files.get(&(friend_number, file_number))?.message_id.clone())
            {
                set_attachment_transfer_state(&context.messages, &message_id, "queued");
            }
        }
        log_transfer(
            &context.transfer_log_path,
            format!("RECV_RESUME friend={friend_number} file={file_number} error={error}"),
        );
    } else {
        log_transfer(&context.transfer_log_path, format!("RECV_WAITING friend={friend_number} file={file_number} automatic_queue={auto_queued}"));
    }
}

fn next_queued_incoming(files: &HashMap<(u32, u32), IncomingFile>) -> Option<((u32, u32), String)> {
    files
        .iter()
        .filter(|(_, file)| file.kind != 1 && file.auto_queued && !file.active)
        .filter_map(|(key, file)| {
            file.message_id
                .clone()
                .map(|message_id| (*key, file.queue_order, message_id))
        })
        .min_by_key(|(_, queue_order, _)| *queue_order)
        .map(|(key, _, message_id)| (key, message_id))
}

fn remove_file_transfer_for_direction(
    outgoing_files: &Arc<Mutex<HashMap<(u32, u32), OutgoingFile>>>,
    incoming_files: &Arc<Mutex<HashMap<(u32, u32), IncomingFile>>>,
    key: (u32, u32),
    outgoing: bool,
) -> Option<IncomingFile> {
    if outgoing {
        if let Ok(mut files) = outgoing_files.lock() {
            files.remove(&key);
        }
        None
    } else {
        incoming_files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(&key))
    }
}

fn take_incoming_chat_files(
    incoming_files: &Mutex<HashMap<(u32, u32), IncomingFile>>,
) -> Result<Vec<((u32, u32), IncomingFile)>, String> {
    let mut files = incoming_files
        .lock()
        .map_err(|_| "FILE_TRANSFER_STATE_UNAVAILABLE".to_string())?;
    let keys = files
        .iter()
        .filter_map(|(key, file)| (file.kind != 1).then_some(*key))
        .collect::<Vec<_>>();
    Ok(keys
        .into_iter()
        .filter_map(|key| files.remove(&key).map(|file| (key, file)))
        .collect())
}

fn cancel_incoming_file_cards(messages: &Mutex<Vec<ToxMessage>>) -> Vec<(u32, String)> {
    let Ok(mut messages) = messages.lock() else {
        return Vec::new();
    };
    let mut cancelled = Vec::new();
    for message in messages.iter_mut().filter(|message| !message.mine) {
        let Some(attachment) = message.attachment.as_mut() else {
            continue;
        };
        if attachment.completed
            || matches!(
                attachment.transfer_state.as_str(),
                "complete" | "cancelled" | "failed"
            )
        {
            continue;
        }
        attachment.transfer_state = "cancelled".to_string();
        attachment.speed_bytes_per_sec = 0;
        attachment.eta_seconds = None;
        attachment.completed_at = None;
        attachment.transfer_error = Some(FILE_RECEIVE_DENIED_REASON.to_string());
        cancelled.push((message.friend_number, message.id.clone()));
    }
    cancelled
}

// The caller owns the native handle. Applying the policy and cancelling all
// in-flight receives therefore cannot race a chunk, EOF or peer RESUME callback.
fn cancel_incoming_receives_for_policy(state: &ToxState, tox: *mut c_void) -> Result<bool, String> {
    let incoming = take_incoming_chat_files(&state.incoming_files)?;
    let mut changed = !incoming.is_empty();
    for ((friend_number, file_number), transfer) in incoming {
        if !tox.is_null() {
            let mut error = 0_i32;
            unsafe { tox_file_control(tox, friend_number, file_number, 2, &mut error) };
        }
        let _ = profiles::remove_file(&transfer.path);
    }
    #[cfg(feature = "web-core")]
    if let (Some(profile_id), Some(bridge)) = (
        state.web_profile_id.as_deref(),
        state.web_file_bridge.as_ref(),
    ) {
        changed |= bridge.cancel_incoming_for_policy(profile_id, tox)?;
    }
    let cancelled = cancel_incoming_file_cards(&state.messages);
    changed |= !cancelled.is_empty();
    if changed {
        persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
        for (friend_number, message_id) in cancelled {
            finish_file_card_runtime_state(
                &state.messages,
                &state.history_residency,
                &state.file_card_protocol,
                friend_number,
                &message_id,
            );
        }
        if let Some(updates) = &state.updates {
            updates.changed();
        }
    }
    Ok(changed)
}

fn set_file_receive_settings_for_state(
    state: &ToxState,
    mut settings: FileReceiveSettings,
) -> Result<FileReceiveSettings, String> {
    settings.max_auto_bytes = settings.max_auto_bytes.min(MAX_CHAT_FILE_BYTES);
    settings.max_concurrent = settings.max_concurrent.clamp(1, 2);
    let handle = state.handle.lock().map_err(|_| "TOX_BUSY".to_string())?;
    let encoded = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    profiles::atomic_write(&state.file_receive_settings_path, &encoded)?;
    *state
        .file_receive_settings
        .lock()
        .map_err(|_| "FILE_SETTINGS_UNAVAILABLE".to_string())? = settings.clone();
    let tox = handle
        .as_ref()
        .map(|handle| handle.instance.as_ptr())
        .unwrap_or(std::ptr::null_mut());
    if settings.deny_all {
        cancel_incoming_receives_for_policy(state, tox)?;
    } else {
        resume_next_queued_incoming_for_state(tox, state);
    }
    Ok(settings)
}

fn resume_next_queued_incoming(tox: *mut c_void, context: &CallbackContext) {
    resume_next_queued_incoming_with(
        tox,
        &context.file_receive_settings,
        &context.incoming_files,
        &context.messages,
        &context.history_path,
        &context.history_enabled,
        &context.transfer_log_path,
        context.updates.as_ref(),
    );
}

fn resume_next_queued_incoming_for_state(tox: *mut c_void, state: &ToxState) {
    resume_next_queued_incoming_with(
        tox,
        &state.file_receive_settings,
        &state.incoming_files,
        &state.messages,
        &state.history_path,
        &state.history_enabled,
        &state.transfer_log_path,
        state.updates.as_ref(),
    );
}

#[allow(clippy::too_many_arguments)]
fn resume_next_queued_incoming_with(
    tox: *mut c_void,
    file_receive_settings: &Arc<Mutex<FileReceiveSettings>>,
    incoming_files: &Arc<Mutex<HashMap<(u32, u32), IncomingFile>>>,
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    history_path: &PathBuf,
    history_enabled: &Arc<AtomicBool>,
    transfer_log_path: &PathBuf,
    updates: Option<&ProfileUpdateEmitter>,
) {
    if tox.is_null() {
        return;
    }
    let Ok(settings) = file_receive_settings.lock() else {
        return;
    };
    if settings.deny_all {
        return;
    }
    let maximum = settings.max_concurrent.clamp(1, 2);
    drop(settings);
    let next = incoming_files.lock().ok().and_then(|files| {
        let active = files
            .values()
            .filter(|file| file.kind != 1 && file.active)
            .count();
        (active < maximum)
            .then(|| next_queued_incoming(&files))
            .flatten()
    });
    let Some(((friend_number, file_number), message_id)) = next else {
        return;
    };
    let mut error = 0_i32;
    unsafe {
        let _ = tox_file_control(tox, friend_number, file_number, 0, &mut error);
    }
    let resumed = error == 0 || error == 4;
    if resumed {
        if let Ok(mut files) = incoming_files.lock() {
            if let Some(file) = files.get_mut(&(friend_number, file_number)) {
                file.set_local_paused(false, Instant::now());
                file.auto_queued = false;
            }
        }
        set_attachment_transfer_state(messages, &message_id, "receiving");
        persist_tox_history(messages, history_path, history_enabled);
        if let Some(updates) = updates {
            updates.changed();
        }
    }
    log_transfer(
        transfer_log_path,
        format!("RECV_QUEUE_RESUME friend={friend_number} file={file_number} error={error} resumed={resumed}"),
    );
}

unsafe extern "C" fn on_file_recv_control(
    tox: *mut c_void,
    friend_number: u32,
    file_number: u32,
    control: i32,
    user_data: *mut c_void,
) {
    if tox.is_null() || user_data.is_null() || !(0..=2).contains(&control) {
        return;
    }
    let context = unsafe { &*(user_data as *const CallbackContext) };

    #[cfg(feature = "web-core")]
    let web_update = context
        .web_profile_id
        .as_deref()
        .zip(context.web_file_bridge.as_ref())
        .and_then(|(profile_id, bridge)| {
            bridge.on_native_control(profile_id, friend_number, file_number, control as u32)
        });
    #[cfg(not(feature = "web-core"))]
    let web_update: Option<()> = None;

    #[cfg(feature = "web-core")]
    let blocked_web_resume = control == 0
        && web_update
            .as_ref()
            .is_some_and(|update| !matches!(update.state.as_str(), "sending" | "receiving"));
    #[cfg(not(feature = "web-core"))]
    let blocked_web_resume = false;
    let outgoing = if control == 2 {
        context
            .outgoing_files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(&(friend_number, file_number)))
    } else {
        context
            .outgoing_files
            .lock()
            .ok()
            .and_then(|files| files.get(&(friend_number, file_number)).cloned())
    };
    let incoming = if control == 2 {
        context
            .incoming_files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(&(friend_number, file_number)))
    } else {
        context
            .incoming_files
            .lock()
            .ok()
            .and_then(|files| files.get(&(friend_number, file_number)).cloned())
    };

    let blocked_local_resume = control == 0
        && (outgoing.as_ref().is_some_and(|file| file.locally_paused)
            || incoming.as_ref().is_some_and(|file| file.locally_paused));
    if blocked_web_resume || blocked_local_resume {
        // Pausing an unaccepted offer may return ALREADY_PAUSED without setting
        // toxcore's local pause bit. Reassert it when peer acceptance arrives.
        // Keep the Web workspace's existing pause/queue enforcement as well.
        let mut error = 0_i32;
        unsafe {
            let _ = callback_file_control(tox, friend_number, file_number, 1, &mut error);
        }
    }

    if control == 2 {
        if let Some(transfer) = incoming.as_ref() {
            let _ = profiles::remove_file(&transfer.path);
        }
    } else {
        if let Ok(mut files) = context.outgoing_files.lock() {
            if let Some(transfer) = files.get_mut(&(friend_number, file_number)) {
                transfer.apply_peer_control(control, blocked_web_resume, Instant::now());
            }
        }
        if let Ok(mut files) = context.incoming_files.lock() {
            if let Some(transfer) = files.get_mut(&(friend_number, file_number)) {
                transfer.apply_peer_control(control, blocked_web_resume, Instant::now());
            }
        }
    }

    let mut updates = Vec::<(String, bool)>::new();
    #[cfg(feature = "web-core")]
    if let Some(update) = web_update.as_ref() {
        updates.push((update.message_id.clone(), update.outgoing));
    }
    if let Some(message_id) = outgoing
        .as_ref()
        .and_then(|transfer| transfer.message_id.clone())
    {
        if !updates.iter().any(|(existing, _)| existing == &message_id) {
            updates.push((message_id, true));
        }
    }
    if let Some(message_id) = incoming
        .as_ref()
        .and_then(|transfer| transfer.message_id.clone())
    {
        if !updates.iter().any(|(existing, _)| existing == &message_id) {
            updates.push((message_id, false));
        }
    }

    for (message_id, outgoing) in &updates {
        let locally_paused = if *outgoing {
            context.outgoing_files.lock().ok().is_some_and(|files| {
                files
                    .get(&(friend_number, file_number))
                    .is_some_and(|file| file.locally_paused)
            })
        } else {
            context.incoming_files.lock().ok().is_some_and(|files| {
                files
                    .get(&(friend_number, file_number))
                    .is_some_and(|file| file.locally_paused)
            })
        };
        let resumed_state = if locally_paused {
            "paused"
        } else if *outgoing {
            "sending"
        } else {
            "receiving"
        };
        #[cfg(feature = "web-core")]
        let resumed_state = web_update
            .as_ref()
            .filter(|update| update.message_id == *message_id)
            .map_or(resumed_state, |update| update.state.as_str());
        match control {
            0 => set_attachment_transfer_state(&context.messages, message_id, resumed_state),
            1 => set_attachment_transfer_state(&context.messages, message_id, "paused"),
            2 => set_attachment_transfer_cancelled(
                &context.messages,
                message_id,
                if *outgoing {
                    "TRANSFER_REJECTED_BY_RECIPIENT"
                } else {
                    "TRANSFER_CANCELLED_BY_SENDER"
                },
            ),
            _ => unreachable!(),
        }
    }
    if !updates.is_empty() {
        persist_tox_history(
            &context.messages,
            &context.history_path,
            &context.history_enabled,
        );
        bump_history_revision(&context.history_path);
        if let Some(updates) = &context.updates {
            updates.changed();
        }
        if control == 2 {
            for (message_id, _) in &updates {
                finish_file_card_runtime_state(
                    &context.messages,
                    &context.history_residency,
                    &context.file_card_protocol,
                    friend_number,
                    message_id,
                );
            }
        }
    }
    if control == 2 && incoming.is_some() {
        resume_next_queued_incoming(tox, context);
    }
    log_transfer(
        &context.transfer_log_path,
        format!(
            "FILE_CONTROL_REMOTE friend={friend_number} file={file_number} control={control} matched={}",
            !updates.is_empty()
        ),
    );
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
    #[cfg(feature = "web-core")]
    if let (Some(profile_id), Some(bridge)) = (
        context.web_profile_id.as_deref(),
        context.web_file_bridge.as_ref(),
    ) {
        let transfer_id = if length == 0 {
            bridge.incoming_terminal_by_native(profile_id, friend_number, file_number)
        } else {
            bridge.incoming_by_native(profile_id, friend_number, file_number)
        };
        if let Some(transfer_id) = transfer_id {
            if length == 0 {
                // The backend transfer tick releases the slot after storage
                // confirms the exact payload, independently of browser reads.
                let _ = bridge.incoming_remote_complete(&transfer_id);
                return;
            }
            if data.is_null() {
                return;
            }
            let bytes = unsafe { std::slice::from_raw_parts(data, length) };
            let accepted = match bridge.push_incoming_chunk(&transfer_id, position, bytes) {
                Ok(value) => value,
                Err(_) => {
                    if !tox.is_null() {
                        let mut error = 0_i32;
                        unsafe {
                            let _ =
                                tox_file_control(tox, friend_number, file_number, 2, &mut error);
                        }
                    }
                    if let Some((message_id, _, _)) = bridge.progress(&transfer_id) {
                        set_attachment_transfer_error(
                            &context.messages,
                            &message_id,
                            "Получение остановлено: превышен безопасный буфер передачи.",
                        );
                        persist_tox_history(
                            &context.messages,
                            &context.history_path,
                            &context.history_enabled,
                        );
                    }
                    return;
                }
            };
            if !accepted && !tox.is_null() {
                let mut error = 0_i32;
                unsafe {
                    let _ = tox_file_control(tox, friend_number, file_number, 1, &mut error);
                }
            }
            // The backend tick advances visible progress only after the
            // workspace worker confirms durable bytes. Browser download is a
            // separate consumer and never acknowledges this native buffer.
            return;
        }
    }
    if length == 0 {
        let transfer = context
            .incoming_files
            .lock()
            .ok()
            .and_then(|mut files| files.remove(&(friend_number, file_number)));
        if let Some(transfer) = transfer {
            let staged_complete = if let Some(target) = transfer.buffered_target.as_ref() {
                target
                    .lock()
                    .map_err(|_| "FILE_TRANSFER_BUFFER_UNAVAILABLE".to_string())
                    .and_then(|contents| {
                        if contents.len() as u64 != transfer.size {
                            return Err("FILE_SIZE_INVALID".to_string());
                        }
                        profiles::write_file(&transfer.path, &contents)
                    })
            } else {
                fs::metadata(&transfer.path)
                    .map_err(|error| error.to_string())
                    .and_then(|metadata| {
                        (metadata.len() == transfer.size)
                            .then_some(())
                            .ok_or_else(|| "FILE_SIZE_INVALID".to_string())
                    })
            };
            if let Err(error) = staged_complete {
                let _ = profiles::remove_file(&transfer.path);
                if let Some(message_id) = transfer.message_id.as_deref() {
                    set_attachment_transfer_error(
                        &context.messages,
                        message_id,
                        "Полученный файл не прошёл проверку размера.",
                    );
                }
                log_transfer(
                    &context.transfer_log_path,
                    format!("RECV_PUBLISH_FAILED friend={friend_number} file={file_number} error={error}"),
                );
                persist_tox_history(
                    &context.messages,
                    &context.history_path,
                    &context.history_enabled,
                );
                if transfer.kind != 1 && !tox.is_null() {
                    resume_next_queued_incoming(tox, context);
                }
                return;
            }
            let mut published_path = transfer.path.clone();
            let valid = if let Some(final_path) = &transfer.final_path {
                if is_complete_avatar(&transfer.path, Some(transfer.size)) {
                    match profiles::rename(&transfer.path, final_path) {
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
                let _ = profiles::remove_file(&transfer.path);
                log_transfer(
                    &context.transfer_log_path,
                    format!(
                        "RECV_AVATAR_INVALID friend={friend_number} file={file_number} expected={}",
                        transfer.size
                    ),
                );
                if transfer.kind != 1 && !tox.is_null() {
                    resume_next_queued_incoming(tox, context);
                }
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
            let completed_message_id = transfer.message_id.clone();
            if let Some(message_id) = completed_message_id.as_deref() {
                update_attachment_progress(
                    &context.messages,
                    message_id,
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
            if let Some(message_id) = completed_message_id.as_deref() {
                finish_file_card_runtime_state(
                    &context.messages,
                    &context.history_residency,
                    &context.file_card_protocol,
                    friend_number,
                    message_id,
                );
            }
            if transfer.kind != 1 && !tox.is_null() {
                resume_next_queued_incoming(tox, context);
            }
        }
        return;
    }
    if data.is_null() {
        return;
    }
    let mut update = None;
    let mut chunk_failure = None;
    if let Ok(mut files) = context.incoming_files.lock() {
        if let Some(transfer) = files.get_mut(&(friend_number, file_number)) {
            transfer.last_activity_at = Instant::now();
            let result = write_transfer_chunk(
                &transfer.path,
                transfer.buffered_target.as_ref(),
                transfer.size,
                position,
                unsafe { std::slice::from_raw_parts(data, length) },
            );
            if result.is_ok() {
                let transferred = position.saturating_add(length as u64).min(transfer.size);
                let speed = transfer.meter.update(transferred);
                update = transfer
                    .message_id
                    .clone()
                    .map(|id| (id, transferred, speed, transfer.size));
            } else {
                chunk_failure = Some((
                    transfer.path.clone(),
                    transfer.message_id.clone(),
                    result.unwrap_err(),
                ));
            }
        }
    }
    if let Some((path, message_id, error)) = chunk_failure {
        if let Ok(mut files) = context.incoming_files.lock() {
            files.remove(&(friend_number, file_number));
        }
        if !tox.is_null() {
            let mut control_error = 0_i32;
            unsafe {
                let _ = tox_file_control(tox, friend_number, file_number, 2, &mut control_error);
            }
        }
        let _ = profiles::remove_file(&path);
        if let Some(message_id) = message_id {
            set_attachment_transfer_error(
                &context.messages,
                &message_id,
                "Не удалось записать получаемый файл.",
            );
        }
        log_transfer(
            &context.transfer_log_path,
            format!("RECV_CHUNK_FAILED friend={friend_number} file={file_number} error={error}"),
        );
        persist_tox_history(
            &context.messages,
            &context.history_path,
            &context.history_enabled,
        );
        if !tox.is_null() {
            resume_next_queued_incoming(tox, context);
        }
        return;
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
    note_friend_message_connection(
        &context.friend_message_ready_at,
        friend_number,
        connection,
        Instant::now(),
    );
    if connection == 0 {
        note_outgoing_transport_loss(&context.outgoing_files, Some(friend_number));
    }
    if let Err(error) = change_callback_protocol_connection_under_chat_gate(
        &context.pq,
        &context.chat_protocol,
        &context.chat_transaction_gate,
        &context.network_enabled,
        friend_number,
        connection != 0,
    ) {
        log_network(
            &context.network_log_path,
            format!("PQ_CONNECTION_STATE_WAIT friend={friend_number} error={error}"),
        );
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
            let mut changed = entry.friend_number != Some(friend_number);
            entry.friend_number = Some(friend_number);
            if connection != 0 {
                changed |= !entry.authorized || entry.pending_authorization;
                entry.authorized = true;
                entry.pending_authorization = false;
                entry.authorization_message.clear();
            }
            if connection != 0 || entry.last_online.is_some() {
                entry.last_online = Some(unix_timestamp());
                changed = true;
            }
            if changed {
                if let Ok(serialized) = serde_json::to_vec(&*cache) {
                    let _ = atomic_write_sender().try_send(AtomicWriteRequest::Write {
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
    let Ok(bytes) = profiles::read_file(&path) else {
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
                    filename: "avatar.png".to_string(),
                    mime: "image/png".to_string(),
                    size: bytes.len() as u64,
                    source_bytes: Some(Arc::new(bytes.clone())),
                    message_id: None,
                    protocol_transfer_id: None,
                    meter: TransferMeter::new(),
                    last_activity_at: Instant::now(),
                    active: true,
                    locally_paused: false,
                    phase: OutgoingFilePhase::Transferring,
                    fully_sent: false,
                    retry_count: 0,
                    #[cfg(feature = "web-core")]
                    web_transfer_id: None,
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

static NEXT_CHAT_EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn next_chat_event_sequence() -> u64 {
    let wall_clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(1);
    let mut observed = NEXT_CHAT_EVENT_SEQUENCE.load(Ordering::Relaxed);
    loop {
        let next = wall_clock.max(observed.saturating_add(1));
        match NEXT_CHAT_EVENT_SEQUENCE.compare_exchange_weak(
            observed,
            next,
            Ordering::SeqCst,
            Ordering::Relaxed,
        ) {
            Ok(_) => return next,
            Err(actual) => observed = actual,
        }
    }
}

fn record_friend_event_sequence(
    cache: &Arc<Mutex<HashMap<String, CachedFriendProfile>>>,
    cache_path: &Path,
    friend_number: u32,
    friend_public_key: &str,
) {
    let Ok(mut cache) = cache.lock() else { return };
    let key = if !friend_public_key.is_empty() {
        friend_public_key.to_ascii_uppercase()
    } else if let Some((key, _)) = cache
        .iter()
        .find(|(_, profile)| profile.friend_number == Some(friend_number))
    {
        key.clone()
    } else {
        return;
    };
    let entry = cache.entry(key).or_default();
    entry.friend_number = Some(friend_number);
    entry.added_event_sequence = next_chat_event_sequence();
    if let Ok(bytes) = serde_json::to_vec(&*cache) {
        let _ = atomic_write_sender().try_send(AtomicWriteRequest::Write {
            path: cache_path.to_path_buf(),
            bytes,
        });
    }
}

fn new_message_id(friend_number: u32) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{friend_number}-{nanos}")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageResult {
    message_id: String,
    delivery: String,
    recovered: bool,
    receipt_known: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatCapabilities {
    protocol_version: Option<u8>,
    stable_message_ids: bool,
    reactions: bool,
    quotes: bool,
    formatting: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerReactionSummary {
    message_id: String,
    revision: u64,
    reactions: Vec<ReactionCode>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageSearchMatch {
    message_id: String,
    index: usize,
    field: String,
    start: u32,
    end: u32,
    snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageSearchPage {
    matches: Vec<MessageSearchMatch>,
    next_cursor: Option<String>,
    total_matches: Option<usize>,
}

fn casefold_utf16_occurrences(text: &str, query: &str) -> Vec<(u32, u32)> {
    if query.is_empty() {
        return Vec::new();
    }
    let mut folded = String::new();
    let mut map = Vec::<(usize, usize, u32, u32)>::new();
    let mut original_utf16 = 0_u32;
    for character in text.chars() {
        let original_end = original_utf16.saturating_add(character.len_utf16() as u32);
        for lower in character.to_lowercase() {
            let start = folded.len();
            folded.push(lower);
            map.push((start, folded.len(), original_utf16, original_end));
        }
        original_utf16 = original_end;
    }
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut from = 0;
    while from <= folded.len().saturating_sub(needle.len()) {
        let Some(relative) = folded[from..].find(&needle) else {
            break;
        };
        let found = from + relative;
        let found_end = found + needle.len();
        let first = map
            .iter()
            .find(|(start, end, _, _)| *start <= found && found < *end);
        let last = map
            .iter()
            .rev()
            .find(|(start, end, _, _)| *start < found_end && found_end <= *end);
        if let (Some((_, _, start, _)), Some((_, _, _, end))) = (first, last) {
            result.push((*start, *end));
        }
        from = map
            .iter()
            .find(|(start, _, _, _)| *start > found)
            .map(|(start, _, _, _)| *start)
            .unwrap_or(folded.len().saturating_add(1));
    }
    result
}

fn displayed_message_text(message: &ToxMessage) -> String {
    if message.protocol_version.is_none() {
        chat_protocol::parse_qtox_quote(&message.text)
            .map(|(_, body)| body)
            .unwrap_or_else(|| message.text.clone())
    } else {
        message.text.clone()
    }
}

fn search_messages_in_memory(
    messages: &[ToxMessage],
    friend_number: u32,
    friend_public_key: &str,
    query: &str,
    cursor: usize,
    limit: usize,
) -> (Vec<MessageSearchMatch>, Option<usize>, usize) {
    let matching = messages
        .iter()
        .filter(|message| message_matches_friend(message, friend_number, friend_public_key))
        .collect::<Vec<_>>();
    let mut all_matches = Vec::new();
    for (index, message) in matching.into_iter().enumerate() {
        let body = displayed_message_text(message);
        for (start, end) in casefold_utf16_occurrences(&body, query) {
            all_matches.push(MessageSearchMatch {
                message_id: message.id.clone(),
                index,
                field: "text".to_string(),
                start,
                end,
                snippet: body.chars().take(160).collect(),
            });
        }
        if let Some(attachment) = &message.attachment {
            for (start, end) in casefold_utf16_occurrences(&attachment.name, query) {
                all_matches.push(MessageSearchMatch {
                    message_id: message.id.clone(),
                    index,
                    field: "attachment".to_string(),
                    start,
                    end,
                    snippet: attachment.name.chars().take(160).collect(),
                });
            }
        }
    }
    let total = all_matches.len();
    let start = cursor.min(total);
    let end = start.saturating_add(limit.clamp(1, 100)).min(total);
    (
        all_matches[start..end].to_vec(),
        (end < total).then_some(end),
        total,
    )
}

fn mark_chat_history_active(
    state: &ToxState,
    friend_number: u32,
    friend_public_key: &str,
    view_lease_id: Option<&str>,
) {
    let Some((session_id, generation)) = view_lease_id.and_then(parse_history_view_lease) else {
        return;
    };
    let key = unread_target_key(friend_number, friend_public_key);
    if let Ok(mut residency) = state.history_residency.lock() {
        let now = Instant::now();
        let entry = residency.entry(key).or_insert_with(|| HistoryResidence {
            friend_number,
            friend_public_key: friend_public_key.to_string(),
            active: false,
            left_at: None,
            last_access: now,
            evicted: false,
            lease_sessions: HashMap::new(),
        });
        entry.friend_number = friend_number;
        entry.friend_public_key = friend_public_key.to_string();
        refresh_history_residence(entry, session_id, generation, now);
    }
}

fn refresh_history_residence(
    entry: &mut HistoryResidence,
    session_id: String,
    generation: u64,
    now: Instant,
) {
    let session = entry.lease_sessions.entry(session_id).or_default();
    if generation <= session.released_through {
        return;
    }
    session
        .active_generations
        .retain(|active| *active >= generation);
    session.active_generations.insert(generation);
    session.last_seen = Some(now);
    entry.active = entry
        .lease_sessions
        .values()
        .any(|session| !session.active_generations.is_empty());
    entry.left_at = None;
    entry.last_access = now;
    entry.evicted = false;
}

fn parse_history_view_lease(value: &str) -> Option<(String, u64)> {
    let (session, generation) = value.rsplit_once(':')?;
    let session = session.trim();
    if session.is_empty() || session.len() > 128 {
        return None;
    }
    let generation = generation.parse::<u64>().ok()?;
    (generation > 0).then(|| (session.to_string(), generation))
}

fn release_chat_history_for_state(
    state: &ToxState,
    friend_number: u32,
    view_lease_id: Option<&str>,
) -> Result<(), String> {
    let friend_public_key = state.stable_friend_public_key(friend_number);
    let key = unread_target_key(friend_number, &friend_public_key);
    let now = Instant::now();
    let mut residency = state
        .history_residency
        .lock()
        .map_err(|_| "CHAT_HISTORY_RESIDENCY_LOCK_POISONED".to_string())?;
    let entry = residency.entry(key).or_insert_with(|| HistoryResidence {
        friend_number,
        friend_public_key: friend_public_key.clone(),
        active: false,
        left_at: Some(now),
        last_access: now,
        evicted: false,
        lease_sessions: HashMap::new(),
    });
    entry.friend_number = friend_number;
    entry.friend_public_key = friend_public_key;
    release_history_residence(entry, view_lease_id.and_then(parse_history_view_lease), now);
    Ok(())
}

fn release_history_residence(
    entry: &mut HistoryResidence,
    lease: Option<(String, u64)>,
    now: Instant,
) {
    if let Some((session_id, generation)) = lease {
        let session = entry.lease_sessions.entry(session_id).or_default();
        session.released_through = session.released_through.max(generation);
        session
            .active_generations
            .retain(|active| *active > session.released_through);
        session.last_seen = Some(now);
    } else {
        for session in entry.lease_sessions.values_mut() {
            if let Some(maximum) = session.active_generations.iter().copied().max() {
                session.released_through = session.released_through.max(maximum);
            }
            session.active_generations.clear();
        }
    }
    entry.active = entry
        .lease_sessions
        .values()
        .any(|session| !session.active_generations.is_empty());
    if !entry.active {
        entry.left_at = Some(now);
        entry.last_access = now;
        entry.evicted = false;
    }
}

fn refresh_chat_history_lease_for_state(
    state: &ToxState,
    friend_number: u32,
    view_lease_id: &str,
) -> Result<(), String> {
    if parse_history_view_lease(view_lease_id).is_none() {
        return Err("CHAT_HISTORY_VIEW_LEASE_INVALID".to_string());
    }
    let friend_public_key = state.stable_friend_public_key(friend_number);
    mark_chat_history_active(
        state,
        friend_number,
        &friend_public_key,
        Some(view_lease_id),
    );
    Ok(())
}

fn evict_inactive_chat_history(state: &ToxState, now: Instant) {
    let Ok(mut residency) = state.history_residency.lock() else {
        return;
    };
    for entry in residency.values_mut() {
        let was_active = entry.active;
        for session in entry.lease_sessions.values_mut() {
            if session.last_seen.is_some_and(|seen| {
                now.saturating_duration_since(seen) >= CHAT_HISTORY_LEASE_STALE_AFTER
            }) {
                if let Some(maximum) = session.active_generations.iter().copied().max() {
                    session.released_through = session.released_through.max(maximum);
                }
                session.active_generations.clear();
            }
        }
        entry.active = entry
            .lease_sessions
            .values()
            .any(|session| !session.active_generations.is_empty());
        if was_active && !entry.active {
            entry.left_at = Some(now);
            entry.last_access = now;
            entry.evicted = false;
        }
    }
    let Ok(messages) = state.messages.lock() else {
        return;
    };
    let mut cost_by_target = residency
        .keys()
        .cloned()
        .map(|key| (key, 0_usize))
        .collect::<HashMap<_, _>>();
    let number_fallbacks = residency
        .iter()
        .map(|(key, entry)| (entry.friend_number, key.clone()))
        .collect::<HashMap<_, _>>();
    for message in messages.iter() {
        let exact = unread_target_key(message.friend_number, &message.friend_public_key);
        let target = cost_by_target
            .contains_key(&exact)
            .then_some(exact)
            .or_else(|| number_fallbacks.get(&message.friend_number).cloned());
        let Some(target) = target else { continue };
        let cost = message.text.encode_utf16().count().saturating_mul(2)
            + message
                .attachment
                .as_ref()
                .map(|attachment| attachment.name.encode_utf16().count().saturating_mul(2))
                .unwrap_or(0)
            + 512;
        if let Some(total) = cost_by_target.get_mut(&target) {
            *total = total.saturating_add(cost);
        }
    }
    let evicted_targets = inactive_history_eviction_targets(&residency, &cost_by_target, now);
    if evicted_targets.is_empty() {
        return;
    }
    drop(messages);
    if let Ok(mut messages) = state.messages.lock() {
        messages.retain(|message| {
            !evicted_targets.contains(&unread_target_key(
                message.friend_number,
                &message.friend_public_key,
            )) || message_requires_runtime_residency(message)
        });
    }
    for (key, entry) in residency.iter_mut() {
        if evicted_targets.contains(key) {
            entry.evicted = true;
        }
    }
}

fn inactive_history_eviction_targets(
    residency: &HashMap<String, HistoryResidence>,
    cost_by_target: &HashMap<String, usize>,
    now: Instant,
) -> HashSet<String> {
    let mut inactive = residency
        .iter()
        .filter(|(_, entry)| !entry.active && !entry.evicted)
        .map(|(key, entry)| {
            (
                key.clone(),
                entry.last_access,
                cost_by_target.get(key).copied().unwrap_or(0),
                entry.left_at.is_some_and(|left_at| {
                    now.saturating_duration_since(left_at) >= CHAT_HISTORY_RELEASE_AFTER
                }),
            )
        })
        .collect::<Vec<_>>();
    inactive.sort_by_key(|(_, last_access, _, _)| std::cmp::Reverse(*last_access));
    let mut retained_windows = 0_usize;
    let mut retained_cost = 0_usize;
    let mut evicted_targets = HashSet::<String>::new();
    for (key, _, cost, ttl_expired) in inactive {
        let exceeds_count = retained_windows >= MAX_INACTIVE_CHAT_HISTORY_WINDOWS;
        let exceeds_cost = retained_cost.saturating_add(cost) > MAX_INACTIVE_CHAT_HISTORY_COST;
        if ttl_expired || exceeds_count || exceeds_cost {
            evicted_targets.insert(key);
        } else {
            retained_windows = retained_windows.saturating_add(1);
            retained_cost = retained_cost.saturating_add(cost);
        }
    }
    evicted_targets
}

fn message_requires_runtime_residency(message: &ToxMessage) -> bool {
    if message.mine && matches!(message.delivery.as_str(), "pending" | "awaiting_receipt") {
        return true;
    }
    message.attachment.as_ref().is_some_and(|attachment| {
        !attachment.completed
            && !matches!(
                attachment.transfer_state.as_str(),
                "failed" | "cancelled" | "declined"
            )
    })
}

fn active_file_card_message_ids(state: &ToxState) -> HashSet<String> {
    let mut ids = state
        .messages
        .lock()
        .map(|messages| {
            messages
                .iter()
                .filter(|message| {
                    message.protocol_version == Some(file_card_protocol::VERSION)
                        && message.attachment.is_some()
                        && message_requires_runtime_residency(message)
                })
                .map(|message| message.id.clone())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    if let Ok(pending) = state.pending_files.lock() {
        ids.extend(
            pending
                .iter()
                .filter(|file| file.protocol_version == Some(file_card_protocol::VERSION))
                .map(|file| file.id.clone()),
        );
    }
    if let Ok(incoming) = state.incoming_files.lock() {
        ids.extend(
            incoming
                .values()
                .filter_map(|transfer| transfer.message_id.clone()),
        );
    }
    if let Ok(outgoing) = state.outgoing_files.lock() {
        ids.extend(
            outgoing
                .values()
                .filter_map(|transfer| transfer.message_id.clone()),
        );
    }
    ids
}

fn finish_file_card_runtime_state(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    residency: &Arc<Mutex<HashMap<String, HistoryResidence>>>,
    engine: &FileCardEngine,
    friend_number: u32,
    message_id: &str,
) {
    let message = messages.lock().ok().and_then(|messages| {
        messages
            .iter()
            .find(|message| message.id == message_id)
            .cloned()
    });
    let Some(message) = message else { return };
    let terminal = message.attachment.as_ref().is_some_and(|attachment| {
        attachment.completed
            || matches!(
                attachment.transfer_state.as_str(),
                "complete" | "cancelled" | "declined"
            )
    });
    if message.protocol_version != Some(file_card_protocol::VERSION) || !terminal {
        return;
    }
    if engine
        .finish_message(friend_number, &message.friend_public_key, message_id)
        .is_err()
    {
        return;
    }
    drop_cached_message_if_inactive_evicted(messages, residency, message_id);
}

fn drop_cached_message_if_inactive_evicted(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    residency: &Arc<Mutex<HashMap<String, HistoryResidence>>>,
    message_id: &str,
) {
    let message = messages.lock().ok().and_then(|messages| {
        messages
            .iter()
            .find(|message| message.id == message_id)
            .cloned()
    });
    let Some(message) = message else { return };
    if message_requires_runtime_residency(&message) {
        return;
    }
    let target = unread_target_key(message.friend_number, &message.friend_public_key);
    let should_drop = residency
        .lock()
        .ok()
        .and_then(|residency| residency.get(&target).cloned())
        .is_some_and(|entry| entry.evicted && !entry.active);
    if should_drop {
        if let Ok(mut messages) = messages.lock() {
            messages.retain(|candidate| candidate.id != message_id);
        }
    }
}

fn prune_inactive_evicted_terminal_messages(state: &ToxState) {
    let terminal_ids = state
        .messages
        .lock()
        .map(|messages| {
            messages
                .iter()
                .filter(|message| !message_requires_runtime_residency(message))
                .map(|message| message.id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for message_id in terminal_ids {
        drop_cached_message_if_inactive_evicted(
            &state.messages,
            &state.history_residency,
            &message_id,
        );
    }
}

fn chat_history_is_active(
    residency: &Arc<Mutex<HashMap<String, HistoryResidence>>>,
    friend_number: u32,
    friend_public_key: &str,
) -> bool {
    let key = unread_target_key(friend_number, friend_public_key);
    residency
        .lock()
        .ok()
        .and_then(|state| state.get(&key).map(|entry| entry.active))
        .unwrap_or(false)
}

fn replace_cached_contact_window(
    state: &ToxState,
    friend_number: u32,
    friend_public_key: &str,
    window: &mut [ToxMessage],
) -> Result<(), String> {
    let mut replacement = window.to_vec();
    let mut known = replacement
        .iter()
        .enumerate()
        .map(|(index, message)| (message.id.clone(), index))
        .collect::<HashMap<_, _>>();
    for message in chat_history_store::working_set_registered(
        &state.history_path,
        friend_number,
        friend_public_key,
    )? {
        if !known.contains_key(&message.id) {
            known.insert(message.id.clone(), replacement.len());
            replacement.push(message);
        }
    }
    let mut messages = state
        .messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
    for message in messages
        .iter()
        .filter(|message| message_matches_friend(message, friend_number, friend_public_key))
    {
        if let Some(&index) = known.get(&message.id) {
            // The store read may predate a receipt or transfer update queued
            // for the deferred writer. Keep the current resident row in both
            // the cache and the returned window, including terminal updates.
            replacement[index] = message.clone();
            if let Some(visible) = window.get_mut(index) {
                *visible = message.clone();
            }
        } else if message_requires_runtime_residency(message) {
            known.insert(message.id.clone(), replacement.len());
            replacement.push(message.clone());
        }
    }
    replacement.sort_by_key(|message| message.timestamp);
    messages.retain(|message| !message_matches_friend(message, friend_number, friend_public_key));
    messages.extend(replacement);
    Ok(())
}

fn chat_window_metadata(
    state: &ToxState,
    friend_number: u32,
    friend_public_key: &str,
    window: &[ToxMessage],
) -> Result<
    (
        Vec<String>,
        Option<String>,
        Option<String>,
        Vec<String>,
        Vec<PeerReactionSummary>,
    ),
    String,
> {
    let recent = if state.history_enabled.load(Ordering::Relaxed)
        && chat_history_store::contains_registered(&state.history_path)
    {
        chat_history_store::latest_user_registered(
            &state.history_path,
            friend_number,
            friend_public_key,
            chat_protocol::REACTION_ELIGIBLE_MESSAGE_COUNT,
        )?
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
    } else {
        state
            .messages
            .lock()
            .map(|messages| {
                messages
                    .iter()
                    .rev()
                    .filter(|message| {
                        message.event.is_none()
                            && message_matches_friend(message, friend_number, friend_public_key)
                    })
                    .take(chat_protocol::REACTION_ELIGIBLE_MESSAGE_COUNT)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let reaction_eligible_ids = recent
        .iter()
        .filter(|message| message.protocol_version == Some(chat_protocol::VERSION))
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();
    let latest_message_id = recent.first().map(|message| message.id.clone());
    let peer_reactions = recent
        .iter()
        .filter_map(|message| {
            state
                .chat_protocol
                .reaction_view(friend_number, friend_public_key, &message.id)
                .filter(|view| view.peer_revision > 0)
                .map(|view| PeerReactionSummary {
                    message_id: message.id.clone(),
                    revision: view.peer_revision,
                    reactions: view.peer,
                })
        })
        .collect::<Vec<_>>();
    let target = unread_target_key(friend_number, friend_public_key);
    let unseen = state
        .unread_state
        .lock()
        .ok()
        .and_then(|state| state.unseen_messages.get(&target).cloned())
        .unwrap_or_default();
    let unseen_set = unseen.iter().map(String::as_str).collect::<HashSet<_>>();
    let unseen_in_window = window
        .iter()
        .filter(|message| unseen_set.contains(message.id.as_str()))
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();
    Ok((
        reaction_eligible_ids,
        latest_message_id,
        unseen.first().cloned(),
        unseen_in_window,
        peer_reactions,
    ))
}

fn chat_capabilities(state: &ToxState, friend_number: u32) -> ChatCapabilities {
    let supported = state.chat_protocol.supports(friend_number);
    ChatCapabilities {
        protocol_version: supported.then_some(chat_protocol::VERSION),
        stable_message_ids: supported,
        reactions: supported,
        quotes: supported,
        formatting: supported,
    }
}

fn validate_send_operation_id(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err("CHAT_SEND_OPERATION_ID_INVALID".to_string());
    }
    Ok(Some(value))
}

fn send_payload_fingerprint(
    text: &str,
    quote: &Option<ChatQuote>,
    formatting: &[TextFormatSpan],
) -> Result<String, String> {
    let encoded = serde_json::to_vec(&(text, quote, formatting))
        .map_err(|_| "CHAT_SEND_PAYLOAD_INVALID".to_string())?;
    Ok(hex_upper(&Sha256::digest(encoded)))
}

fn canonical_outgoing_quote(
    state: &ToxState,
    friend_number: u32,
    friend_public_key: &str,
    quote: Option<ChatQuote>,
) -> Result<Option<ChatQuote>, String> {
    let Some(mut quote) = quote else {
        return Ok(None);
    };
    if let Some(target_id) = quote.message_id.as_deref() {
        let target = if chat_history_store::contains_registered(&state.history_path) {
            chat_history_store::find_message_registered(
                &state.history_path,
                friend_number,
                friend_public_key,
                target_id,
            )?
        } else {
            state.messages.lock().ok().and_then(|messages| {
                messages
                    .iter()
                    .find(|message| {
                        message.id == target_id
                            && message_matches_friend(message, friend_number, friend_public_key)
                    })
                    .cloned()
            })
        }
        .ok_or_else(|| "CHAT_QUOTE_TARGET_UNKNOWN".to_string())?;
        quote.author = if target.mine { "self" } else { "peer" }.to_string();
        quote.text = quote_text_for_message(&target);
        if target.protocol_version == Some(chat_protocol::VERSION) {
            chat_protocol::validate_common_message_id(target_id)?;
            quote.legacy = false;
        } else {
            quote.message_id = None;
            quote.legacy = true;
        }
    } else {
        quote.author.clear();
        quote.text = sanitize_untrusted_text(&quote.text);
        quote.legacy = true;
    }
    if quote.text.is_empty() {
        return Err("CHAT_QUOTE_TEXT_REQUIRED".to_string());
    }
    Ok(Some(quote))
}

fn quote_text_for_message(message: &ToxMessage) -> String {
    if !message.text.is_empty() {
        message.text.clone()
    } else {
        message
            .attachment
            .as_ref()
            .map(|attachment| sanitize_untrusted_text(&attachment.name))
            .unwrap_or_default()
    }
}

fn decorate_message_reactions(state: &ToxState, messages: &mut [ToxMessage]) {
    for message in messages {
        if message.protocol_version == Some(chat_protocol::VERSION) {
            if let Some(view) = state.chat_protocol.reaction_view(
                message.friend_number,
                &message.friend_public_key,
                &message.id,
            ) {
                message.reactions = Some(view);
            }
        }
    }
}

fn pending_message_exists(state: &ToxState, message_id: &str) -> bool {
    [&state.pending_messages, &state.pending_pq_messages]
        .into_iter()
        .any(|queue| {
            queue
                .lock()
                .map(|queue| queue.iter().any(|item| item.id == message_id))
                .unwrap_or(false)
        })
}

fn pending_for_message(
    message: &ToxMessage,
    friend_number: u32,
    friend_public_key: &str,
) -> Result<PendingToxMessage, String> {
    let envelope = MessageEnvelope {
        version: chat_protocol::VERSION,
        id: message.id.clone(),
        text: message.text.clone(),
        quote: message.quote.clone(),
        formatting: message.formatting.clone(),
        pq_protected: message.pq_protected,
    };
    let (wire_fragments, wire_text) = if message.pq_protected {
        (
            Vec::new(),
            Some(chat_protocol::encode_pq_message(&envelope)?),
        )
    } else {
        (chat_protocol::encode_message_fragments(&envelope)?, None)
    };
    Ok(PendingToxMessage {
        id: message.id.clone(),
        friend_number,
        friend_public_key: friend_public_key.to_string(),
        text: message.text.clone(),
        timestamp: message.timestamp,
        next_offset: 0,
        wire_fragments,
        wire_text,
    })
}

fn observe_chat_peer_connection(
    state: &ToxState,
    friend_number: u32,
) -> Result<(bool, u64), String> {
    // Observe before taking the chat transaction gate: the network worker owns
    // the native handle while it acquires that gate for callbacks.
    let revision = state.pq.connection_revision(friend_number);
    let handle = state
        .handle
        .lock()
        .map_err(|_| "Tox handle is locked".to_string())?;
    let online = handle
        .as_ref()
        .is_some_and(|handle| friend_is_connected(handle.instance.as_ptr(), friend_number));
    Ok((online, revision))
}

fn begin_chat_pq_for_send(
    state: &ToxState,
    friend_number: u32,
    friend_public_key: &str,
    peer_online: bool,
    connection_revision: Option<u64>,
    local_online_override: Option<bool>,
) -> Result<bool, String> {
    // Text, native attachments and Web uploads make the same durable decision.
    // Identity generation and negotiation continue on the backend worker.
    let local_online = local_online_override.unwrap_or_else(|| local_transport_ready(state));
    if !local_online {
        state.pq.connection_changed(friend_number, false)?;
        state.chat_protocol.disconnected(friend_number);
    }
    let protected = state.pq.first_send_observed(
        friend_number,
        local_online,
        peer_online,
        connection_revision,
    )? || state.pq.queues_encrypted_messages(friend_number);
    run_send_after_pq_decision_hook();
    if state.pq.auto_skip_pending(friend_number) {
        resume_pq_auto_skip(state, friend_number, friend_public_key)?;
    }
    Ok(protected)
}

fn ordinary_chat_transport_waits_for_pq(state: &ToxState, friend_number: u32) -> bool {
    // A row already committed to ordinary Tox keeps its wire representation.
    // It may finish after a peer-initiated PQ session becomes active, while
    // negotiation, a pending decision and key shutdown still fence the queue.
    state.pq.holds_plaintext_messages(friend_number)
        && !(state.pq.is_v2(friend_number) && state.pq.status(friend_number).state == "active")
}

fn file_chat_transport_waits_for_pq(state: &ToxState, friend_number: u32) -> bool {
    // Files have always used native Tox in legacy PQ sessions. Only the new
    // v2 first-send negotiation adds a wait before publishing their offers.
    state.pq.is_v2(friend_number) && ordinary_chat_transport_waits_for_pq(state, friend_number)
}

fn send_chat_message_for_state(
    state: &ToxState,
    friend_number: u32,
    text: String,
    operation_id: Option<String>,
    quote: Option<ChatQuote>,
    formatting: Vec<TextFormatSpan>,
) -> Result<SendMessageResult, String> {
    let (peer_online, connection_revision) = observe_chat_peer_connection(state, friend_number)?;
    send_chat_message_for_state_with_connection_observation(
        state,
        friend_number,
        text,
        operation_id,
        quote,
        formatting,
        peer_online,
        Some(connection_revision),
        None,
    )
}

fn send_chat_message_for_state_with_peer_online(
    state: &ToxState,
    friend_number: u32,
    text: String,
    operation_id: Option<String>,
    quote: Option<ChatQuote>,
    formatting: Vec<TextFormatSpan>,
    peer_online: bool,
) -> Result<SendMessageResult, String> {
    send_chat_message_for_state_with_connection_observation(
        state,
        friend_number,
        text,
        operation_id,
        quote,
        formatting,
        peer_online,
        None,
        Some(true),
    )
}

fn send_chat_message_for_state_with_connection_observation(
    state: &ToxState,
    friend_number: u32,
    text: String,
    operation_id: Option<String>,
    quote: Option<ChatQuote>,
    formatting: Vec<TextFormatSpan>,
    peer_online: bool,
    connection_revision: Option<u64>,
    local_online_override: Option<bool>,
) -> Result<SendMessageResult, String> {
    let sanitized = sanitize_untrusted_text(&text);
    let text = sanitized.trim().to_string();
    if text.is_empty() {
        return Err("Нельзя отправить пустое сообщение".to_string());
    }
    if !formatting.is_empty() && text != sanitized {
        return Err("CHAT_FORMAT_TEXT_NORMALIZATION_REQUIRED".to_string());
    }
    chat_protocol::validate_formatting(&text, &formatting)?;
    let operation_id = validate_send_operation_id(operation_id)?;
    let (friend_public_key, _transaction) = lock_chat_transaction_for_friend(state, friend_number)?;
    let operation_fingerprint = operation_id
        .as_ref()
        .map(|_| send_payload_fingerprint(&text, &quote, &formatting))
        .transpose()?;
    let recorded_operation = match (operation_id.as_deref(), operation_fingerprint.as_deref()) {
        (Some(operation_id), Some(fingerprint)) => state.chat_protocol.message_operation(
            friend_number,
            &friend_public_key,
            operation_id,
            fingerprint,
        )?,
        _ => None,
    };

    if let Some(operation_id) = operation_id.as_deref() {
        let mut existing = if chat_history_store::contains_registered(&state.history_path) {
            chat_history_store::find_operation_registered(
                &state.history_path,
                friend_number,
                &friend_public_key,
                operation_id,
            )?
        } else {
            state
                .messages
                .lock()
                .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?
                .iter()
                .find(|message| message.operation_id.as_deref() == Some(operation_id))
                .cloned()
        };
        // Reservation precedes the history/queue writes. A failed history
        // write can therefore leave only the payload-bound operation record.
        // Stable envelope IDs make reconstructing that send retry-safe, even
        // if the caller restarted after the partial transaction.
        if existing.is_none() {
            if let Some(recorded) = recorded_operation.as_ref().filter(|recorded| {
                recorded.protocol_version == Some(chat_protocol::VERSION)
                    && recorded.delivery != "delivered"
            }) {
                existing = Some(ToxMessage {
                    id: recorded.message_id.clone(),
                    friend_number,
                    friend_public_key: friend_public_key.clone(),
                    text: text.clone(),
                    mine: true,
                    timestamp: recorded.timestamp,
                    delivery: "pending".into(),
                    delivered_at: None,
                    attachment: None,
                    event: None,
                    protocol_version: recorded.protocol_version,
                    operation_id: Some(operation_id.to_string()),
                    quote: canonical_outgoing_quote(
                        state,
                        friend_number,
                        &friend_public_key,
                        quote.clone(),
                    )?,
                    formatting: formatting.clone(),
                    pq_protected: recorded.pq_required,
                    reactions: None,
                });
            }
        }
        if let Some(mut existing) = existing {
            if recorded_operation.is_none() {
                let quote_matches = match (&existing.quote, &quote) {
                    (None, None) => true,
                    (Some(stored), Some(requested)) => {
                        if requested.message_id.is_some() {
                            stored.message_id == requested.message_id
                        } else {
                            stored.legacy && stored.text == sanitize_untrusted_text(&requested.text)
                        }
                    }
                    _ => false,
                };
                if !message_matches_friend(&existing, friend_number, &friend_public_key)
                    || existing.text != text
                    || !quote_matches
                    || existing.formatting != formatting
                {
                    return Err("CHAT_SEND_OPERATION_ID_REUSED".to_string());
                }
            }
            if existing.protocol_version == Some(chat_protocol::VERSION)
                && existing.delivery != "delivered"
            {
                state.chat_transport_ready.store(false, Ordering::Release);
                let queue = if existing.pq_protected {
                    &state.pending_pq_messages
                } else {
                    &state.pending_messages
                };
                if !pending_message_exists(state, &existing.id) {
                    let pending =
                        pending_for_message(&existing, friend_number, &friend_public_key)?;
                    queue
                        .lock()
                        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED".to_string())?
                        .push(pending);
                }
                let path = if existing.pq_protected {
                    &state.pending_pq_messages_path
                } else {
                    &state.pending_messages_path
                };
                persist_pending_messages_required(queue, path)?;
                existing.delivery = "pending".to_string();
                {
                    let mut messages = state
                        .messages
                        .lock()
                        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
                    if let Some(message) = messages.iter_mut().find(|item| item.id == existing.id) {
                        *message = existing.clone();
                    } else {
                        messages.push(existing.clone());
                    }
                }
                persist_tox_history_required(
                    &state.messages,
                    &state.history_path,
                    &state.history_enabled,
                )?;
                state.chat_protocol.update_message_operation_delivery(
                    friend_number,
                    &friend_public_key,
                    &existing.id,
                    "pending",
                )?;
            } else if existing.delivery != "delivered"
                && !pending_message_exists(state, &existing.id)
            {
                state.chat_transport_ready.store(false, Ordering::Release);
                existing.delivery = "unknown_recovered".to_string();
                if let Ok(mut messages) = state.messages.lock() {
                    if let Some(message) = messages.iter_mut().find(|item| item.id == existing.id) {
                        message.delivery = existing.delivery.clone();
                        message.delivered_at = None;
                    }
                }
                persist_tox_history_required(
                    &state.messages,
                    &state.history_path,
                    &state.history_enabled,
                )?;
            }
            commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)?;
            return Ok(SendMessageResult {
                message_id: existing.id,
                receipt_known: existing.delivery != "unknown_recovered",
                delivery: existing.delivery,
                recovered: true,
            });
        }
        if let Some(recorded) = recorded_operation.as_ref() {
            let delivery = if pending_message_exists(state, &recorded.message_id) {
                "pending".to_string()
            } else if recorded.delivery == "delivered" {
                "delivered".to_string()
            } else {
                "unknown_recovered".to_string()
            };
            if delivery != recorded.delivery {
                state.chat_protocol.update_message_operation_delivery(
                    friend_number,
                    &friend_public_key,
                    &recorded.message_id,
                    &delivery,
                )?;
                state.chat_transport_ready.store(false, Ordering::Release);
            }
            commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)?;
            return Ok(SendMessageResult {
                message_id: recorded.message_id.clone(),
                receipt_known: delivery != "unknown_recovered",
                delivery,
                recovered: true,
            });
        }
    }

    let quote = canonical_outgoing_quote(state, friend_number, &friend_public_key, quote)?;

    let pq_protected = begin_chat_pq_for_send(
        state,
        friend_number,
        &friend_public_key,
        peer_online,
        connection_revision,
        local_online_override,
    )?;
    // A first contact message is already assigned its final application ID
    // while it waits for capability/key confirmation; retries keep this ID.
    let protocol_supported = state.chat_protocol.supports(friend_number)
        || pq_protected && state.pq.is_v2(friend_number);
    let id = if protocol_supported {
        chat_protocol::new_common_message_id()?
    } else {
        new_message_id(friend_number)
    };
    let timestamp = unix_timestamp();
    let (pending_text, wire_fragments, wire_text, stored_formatting) = if protocol_supported {
        let envelope = MessageEnvelope {
            version: chat_protocol::VERSION,
            id: id.clone(),
            text: text.clone(),
            quote: quote.clone(),
            formatting: formatting.clone(),
            pq_protected,
        };
        if pq_protected {
            (
                text.clone(),
                Vec::new(),
                Some(chat_protocol::encode_pq_message(&envelope)?),
                formatting,
            )
        } else {
            (
                text.clone(),
                chat_protocol::encode_message_fragments(&envelope)?,
                None,
                formatting,
            )
        }
    } else {
        let fallback = quote
            .as_ref()
            .map(|quote| chat_protocol::qtox_quote_fallback(quote, &text))
            .unwrap_or_else(|| text.clone());
        (fallback, Vec::new(), None, Vec::new())
    };
    if let (Some(operation_id), Some(fingerprint)) =
        (operation_id.as_deref(), operation_fingerprint.as_deref())
    {
        state.chat_protocol.reserve_message_operation(
            friend_number,
            &friend_public_key,
            operation_id,
            fingerprint,
            &id,
            protocol_supported.then_some(chat_protocol::VERSION),
            pq_protected,
            timestamp,
        )?;
    }
    state.chat_transport_ready.store(false, Ordering::Release);
    let message = ToxMessage {
        id: id.clone(),
        friend_number,
        friend_public_key: friend_public_key.clone(),
        text: text.clone(),
        mine: true,
        timestamp,
        delivery: "pending".to_string(),
        delivered_at: None,
        attachment: None,
        event: None,
        protocol_version: protocol_supported.then_some(chat_protocol::VERSION),
        operation_id,
        quote,
        formatting: stored_formatting,
        pq_protected,
        reactions: None,
    };
    state
        .messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?
        .push(message);
    persist_tox_history_required(&state.messages, &state.history_path, &state.history_enabled)?;

    let pending = PendingToxMessage {
        id: id.clone(),
        friend_number,
        friend_public_key: friend_public_key.clone(),
        text: pending_text,
        timestamp,
        next_offset: 0,
        wire_fragments,
        wire_text,
    };
    let (queue, path) = if pq_protected {
        (&state.pending_pq_messages, &state.pending_pq_messages_path)
    } else {
        (&state.pending_messages, &state.pending_messages_path)
    };
    queue
        .lock()
        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED".to_string())?
        .push(pending);
    persist_pending_messages_required(queue, path)?;
    record_friend_event_sequence(
        &state.friend_cache,
        &state.friend_cache_path,
        friend_number,
        &friend_public_key,
    );
    commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)?;
    log_network(
        &state.network_log_path,
        format!(
            "QUEUE_MESSAGE friend={friend_number} local_id={id} bytes={} fingerprint={} protocol={} pq={pq_protected}",
            text.len(),
            event_fingerprint(text.as_bytes()),
            u8::from(protocol_supported),
        ),
    );
    Ok(SendMessageResult {
        message_id: id,
        delivery: "pending".to_string(),
        recovered: false,
        receipt_known: true,
    })
}

fn set_message_reactions_for_state(
    state: &ToxState,
    friend_number: u32,
    message_id: String,
    reactions: Vec<ReactionCode>,
    operation_id: Option<String>,
) -> Result<ReactionView, String> {
    let operation_id = validate_send_operation_id(operation_id)?;
    let (friend_public_key, _transaction) = lock_chat_transaction_for_friend(state, friend_number)?;
    if !state.chat_protocol.supports(friend_number) {
        return Err("CHAT_CAPABILITY_REQUIRED".to_string());
    }
    let history_enabled = state.history_enabled.load(Ordering::Relaxed);
    reconcile_reaction_targets(
        &state.chat_protocol,
        &state.history_path,
        history_enabled,
        &state.messages,
        friend_number,
        &friend_public_key,
    )?;
    let target_pq_required = {
        let messages = state
            .messages
            .lock()
            .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
        reaction_target_policy(
            &state.history_path,
            history_enabled,
            &messages,
            friend_number,
            &friend_public_key,
            &message_id,
        )?
    };
    let pq_required = target_pq_required || state.pq.queues_encrypted_messages(friend_number);
    if target_pq_required && !state.pq.queues_encrypted_messages(friend_number) {
        return Err("CHAT_REACTION_PQ_SESSION_REQUIRED".to_string());
    }
    let updated = state.chat_protocol.update_local_reactions(
        friend_number,
        &friend_public_key,
        &message_id,
        reactions,
        operation_id.as_deref(),
        pq_required,
        unix_timestamp(),
    );
    let view =
        stage_chat_mutation_result(&state.history_path, &state.chat_transport_ready, updated)?;
    persist_message_reaction_view(
        &state.history_path,
        history_enabled,
        &state.messages,
        friend_number,
        &friend_public_key,
        &message_id,
        view.clone(),
    )?;
    commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)?;
    bump_chat_view_revision(&state.history_path, friend_number, &friend_public_key);
    Ok(view)
}

fn outgoing_file_cache_path(directory: &Path, message_id: &str, filename: &str) -> PathBuf {
    directory.join(format!("out-{message_id}-{}", safe_file_name(filename)))
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
            friend_public_key: String::new(),
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
            protocol_version: None,
            operation_id: None,
            quote: None,
            formatting: Vec::new(),
            pq_protected: false,
            reactions: None,
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
    if !enabled.load(Ordering::Relaxed) {
        return;
    }
    let Ok(messages) = messages.lock() else {
        return;
    };
    let snapshot = messages.clone();
    // Enqueue while the source snapshot is still locked. A newer synchronous
    // mutation cannot otherwise reach the ordered writer first and leave this
    // older snapshot queued behind it.
    let result = history_persist_sender().send(HistoryPersistRequest::Write {
        messages: snapshot,
        path: path.clone(),
        enabled: Arc::clone(enabled),
    });
    drop(messages);
    let _ = result;
}

enum HistoryPersistRequest {
    Write {
        messages: Vec<ToxMessage>,
        path: PathBuf,
        enabled: Arc<AtomicBool>,
    },
    RequiredWrite {
        messages: Vec<ToxMessage>,
        path: PathBuf,
        completed: SyncSender<Result<(), String>>,
    },
    RequiredClear {
        path: PathBuf,
        friend: Option<(u32, String)>,
        completed: SyncSender<Result<(), String>>,
    },
    Flush(SyncSender<()>),
    #[cfg(test)]
    PauseBeforeCommit {
        entered: SyncSender<bool>,
        release: mpsc::Receiver<()>,
    },
}

static HISTORY_REVISIONS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
static HISTORY_PERSIST_SENDER: OnceLock<Sender<HistoryPersistRequest>> = OnceLock::new();
static CANCELLED_BATCH_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static CHAT_VIEW_REVISIONS: OnceLock<Mutex<HashMap<(PathBuf, String), (u64, u64)>>> =
    OnceLock::new();

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

fn with_active_batched_path_result(
    path: &Path,
    write: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let paths = CANCELLED_BATCH_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| "PROFILE_WRITE_CANCELLATION_UNAVAILABLE".to_string())?;
    if paths.contains(path) {
        return Err("PROFILE_WRITE_CANCELLED".to_string());
    }
    write()
}

fn atomic_write_active_path(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Keep cancellation and the actual replace in one critical section: once
    // deletion marks a path cancelled, no already-queued write can revive it.
    with_active_batched_path_result(path, || atomic_write(path, bytes))
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

fn chat_snapshot_revision(path: &Path, friend_number: u32, friend_public_key: &str) -> u64 {
    let target = unread_target_key(friend_number, friend_public_key);
    let committed =
        chat_history_store::contact_revision_registered(path, friend_number, friend_public_key)
            .unwrap_or(0);
    let Ok(mut revisions) = CHAT_VIEW_REVISIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    else {
        return committed.max(1);
    };
    let entry = revisions
        .entry((path.to_path_buf(), target))
        .or_insert((committed, 1));
    if entry.0 != committed {
        entry.0 = committed;
        entry.1 = entry.1.saturating_add(1).max(1);
    }
    entry.1
}

fn bump_chat_view_revision(path: &Path, friend_number: u32, friend_public_key: &str) -> u64 {
    let target = unread_target_key(friend_number, friend_public_key);
    let committed =
        chat_history_store::contact_revision_registered(path, friend_number, friend_public_key)
            .unwrap_or(0);
    let Ok(mut revisions) = CHAT_VIEW_REVISIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    else {
        return committed.max(1);
    };
    let entry = revisions
        .entry((path.to_path_buf(), target))
        .or_insert((committed, 1));
    entry.0 = committed;
    entry.1 = entry.1.saturating_add(1).max(1);
    entry.1
}

fn invalidate_chat_view_revisions(path: &Path) {
    if let Ok(mut revisions) = CHAT_VIEW_REVISIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        for ((revision_path, _), (_, revision)) in revisions.iter_mut() {
            if revision_path == path {
                *revision = revision.saturating_add(1).max(1);
            }
        }
    }
}

fn persist_tox_history_now(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    path: &Path,
    enabled: &AtomicBool,
) {
    let _ = write_tox_history_required(messages, path, enabled);
}

fn persist_tox_history_required(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    path: &Path,
    enabled: &AtomicBool,
) -> Result<(), String> {
    write_tox_history_required(messages, path, enabled)
}

fn write_tox_history_required(
    messages: &Arc<Mutex<Vec<ToxMessage>>>,
    path: &Path,
    enabled: &AtomicBool,
) -> Result<(), String> {
    if !enabled.load(Ordering::Relaxed) {
        return Ok(());
    }
    let messages = messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
    let snapshot = messages.clone();
    if chat_history_store::contains_registered(path) {
        // Reserve this snapshot's FIFO position before releasing the source
        // lock. A later mutation can then enqueue only after this snapshot.
        let completed = enqueue_registered_history_rows_required(&snapshot, path);
        drop(messages);
        return wait_for_registered_history_write(completed?);
    }
    drop(messages);
    write_tox_history_rows_direct(&snapshot, path, true)
}

fn write_tox_history_rows_required(
    messages: &[ToxMessage],
    path: &Path,
    enabled: &AtomicBool,
) -> Result<(), String> {
    if !enabled.load(Ordering::Relaxed) {
        return Ok(());
    }
    if chat_history_store::contains_registered(path) {
        return write_registered_history_rows_required(messages, path);
    }
    write_tox_history_rows_direct(messages, path, true)
}

fn write_registered_history_rows_required(
    messages: &[ToxMessage],
    path: &Path,
) -> Result<(), String> {
    let completed = enqueue_registered_history_rows_required(messages, path)?;
    wait_for_registered_history_write(completed)
}

fn enqueue_registered_history_rows_required(
    messages: &[ToxMessage],
    path: &Path,
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    let (completed, result) = mpsc::sync_channel(0);
    history_persist_sender()
        .send(HistoryPersistRequest::RequiredWrite {
            messages: messages.to_vec(),
            path: path.to_path_buf(),
            completed,
        })
        .map_err(|_| "PROFILE_HISTORY_QUEUE_UNAVAILABLE".to_string())?;
    Ok(result)
}

pub(crate) fn enqueue_registered_history_clear_required(
    path: &Path,
    friend: Option<(u32, &str)>,
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    let (completed, result) = mpsc::sync_channel(0);
    history_persist_sender()
        .send(HistoryPersistRequest::RequiredClear {
            path: path.to_path_buf(),
            friend: friend.map(|(friend_number, friend_public_key)| {
                (friend_number, friend_public_key.to_string())
            }),
            completed,
        })
        .map_err(|_| "PROFILE_HISTORY_QUEUE_UNAVAILABLE".to_string())?;
    Ok(result)
}

pub(crate) fn wait_for_registered_history_write(
    completed: mpsc::Receiver<Result<(), String>>,
) -> Result<(), String> {
    completed
        .recv()
        .map_err(|_| "PROFILE_HISTORY_WRITE_UNAVAILABLE".to_string())?
}

fn clear_registered_history_direct(
    path: &Path,
    friend: Option<&(u32, String)>,
) -> Result<(), String> {
    with_active_batched_path_result(path, || match friend {
        Some((friend_number, friend_public_key)) => chat_history_store::clear_registered(
            path,
            Some((*friend_number, friend_public_key.as_str())),
        ),
        None => chat_history_store::clear_registered(path, None),
    })
}

fn write_tox_history_rows_direct(
    messages: &[ToxMessage],
    path: &Path,
    enabled: bool,
) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    if chat_history_store::contains_registered(path) {
        return chat_history_store::upsert_registered(path, messages);
    }
    let serialized =
        serde_json::to_vec(messages).map_err(|_| "CHAT_HISTORY_ENCODE_FAILED".to_string())?;
    atomic_write(path, &serialized).map_err(|_| "CHAT_HISTORY_WRITE_FAILED".to_string())
}

fn history_persist_sender() -> &'static Sender<HistoryPersistRequest> {
    HISTORY_PERSIST_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<HistoryPersistRequest>();
        thread::spawn(move || {
            while let Ok(first) = receiver.recv() {
                let (path, messages, enabled) = match first {
                    HistoryPersistRequest::Write {
                        path,
                        messages,
                        enabled,
                    } => (path, messages, enabled),
                    HistoryPersistRequest::RequiredWrite {
                        path,
                        messages,
                        completed,
                    } => {
                        let result = with_active_batched_path_result(&path, || {
                            chat_history_store::upsert_registered(&path, &messages)
                        });
                        let _ = completed.send(result);
                        continue;
                    }
                    HistoryPersistRequest::RequiredClear {
                        path,
                        friend,
                        completed,
                    } => {
                        let result = clear_registered_history_direct(&path, friend.as_ref());
                        let _ = completed.send(result);
                        continue;
                    }
                    HistoryPersistRequest::Flush(completed) => {
                        let _ = completed.send(());
                        continue;
                    }
                    #[cfg(test)]
                    HistoryPersistRequest::PauseBeforeCommit { entered, release } => {
                        let _ = entered.send(false);
                        let _ = release.recv_timeout(Duration::from_secs(5));
                        continue;
                    }
                };
                let mut pending =
                    HashMap::<PathBuf, (HashMap<String, ToxMessage>, Arc<AtomicBool>)>::new();
                merge_history_rows(&mut pending, path, messages, enabled);
                let mut flush = None;
                let mut required = None;
                let deadline = Instant::now() + Duration::from_millis(350);
                loop {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match receiver.recv_timeout(remaining) {
                        Ok(HistoryPersistRequest::Write {
                            path,
                            messages,
                            enabled,
                        }) => {
                            merge_history_rows(&mut pending, path, messages, enabled);
                        }
                        Ok(HistoryPersistRequest::RequiredWrite {
                            path,
                            messages,
                            completed,
                        }) => {
                            required = Some((path, messages, completed));
                            break;
                        }
                        Ok(HistoryPersistRequest::RequiredClear {
                            path,
                            friend,
                            completed,
                        }) => {
                            for (pending_path, (messages, enabled)) in pending.drain() {
                                let messages = messages.into_values().collect::<Vec<_>>();
                                let _ = with_active_batched_path_result(&pending_path, || {
                                    write_tox_history_rows_direct(
                                        &messages,
                                        &pending_path,
                                        enabled.load(Ordering::Relaxed),
                                    )
                                });
                            }
                            let result = clear_registered_history_direct(&path, friend.as_ref());
                            let _ = completed.send(result);
                            continue;
                        }
                        Ok(HistoryPersistRequest::Flush(completed)) => {
                            flush = Some(completed);
                            break;
                        }
                        #[cfg(test)]
                        Ok(HistoryPersistRequest::PauseBeforeCommit { entered, release }) => {
                            let _ = entered.send(true);
                            let _ = release.recv_timeout(Duration::from_secs(5));
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                for (path, (messages, enabled)) in pending {
                    let messages = messages.into_values().collect::<Vec<_>>();
                    with_active_batched_path(&path, || {
                        let _ = write_tox_history_rows_direct(
                            &messages,
                            &path,
                            enabled.load(Ordering::Relaxed),
                        );
                    });
                }
                if let Some((path, messages, completed)) = required {
                    let result = with_active_batched_path_result(&path, || {
                        chat_history_store::upsert_registered(&path, &messages)
                    });
                    let _ = completed.send(result);
                }
                if let Some(completed) = flush {
                    let _ = completed.send(());
                }
            }
        });
        sender
    })
}

fn merge_history_rows(
    pending: &mut HashMap<PathBuf, (HashMap<String, ToxMessage>, Arc<AtomicBool>)>,
    path: PathBuf,
    messages: Vec<ToxMessage>,
    enabled: Arc<AtomicBool>,
) {
    let (rows, current_enabled) = pending
        .entry(path)
        .or_insert_with(|| (HashMap::new(), Arc::clone(&enabled)));
    *current_enabled = enabled;
    for message in messages {
        let identity = if message.friend_public_key.is_empty() {
            format!("number:{}", message.friend_number)
        } else {
            message.friend_public_key.to_ascii_uppercase()
        };
        rows.insert(format!("{identity}:{}", message.id), message);
    }
}

pub(crate) fn flush_deferred_profile_writes() -> Result<(), String> {
    let (atomic_completed, atomic_flushed) = mpsc::sync_channel(0);
    atomic_write_sender()
        .send(AtomicWriteRequest::Flush(atomic_completed))
        .map_err(|_| "PROFILE_WRITE_QUEUE_UNAVAILABLE".to_string())?;
    atomic_flushed
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "PROFILE_WRITE_FLUSH_TIMEOUT".to_string())?;

    let (history_completed, history_flushed) = mpsc::sync_channel(0);
    history_persist_sender()
        .send(HistoryPersistRequest::Flush(history_completed))
        .map_err(|_| "PROFILE_HISTORY_QUEUE_UNAVAILABLE".to_string())?;
    history_flushed
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "PROFILE_HISTORY_FLUSH_TIMEOUT".to_string())
}

fn persist_pending_messages(messages: &Arc<Mutex<Vec<PendingToxMessage>>>, path: &PathBuf) {
    let Ok(messages) = messages.lock() else {
        return;
    };
    let Ok(serialized) = serde_json::to_vec(&*messages) else {
        return;
    };
    let _ = atomic_write_sender().try_send(AtomicWriteRequest::Write {
        path: path.clone(),
        bytes: serialized,
    });
}

fn persist_pending_messages_now(messages: &Arc<Mutex<Vec<PendingToxMessage>>>, path: &Path) {
    let _ = persist_pending_messages_required(messages, path);
}

fn persist_pending_messages_required(
    messages: &Arc<Mutex<Vec<PendingToxMessage>>>,
    path: &Path,
) -> Result<(), String> {
    let messages = messages
        .lock()
        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED".to_string())?;
    let serialized = serde_json::to_vec(&*messages)
        .map_err(|_| "CHAT_PENDING_QUEUE_ENCODE_FAILED".to_string())?;
    let completed = enqueue_atomic_write_required(path, serialized);
    drop(messages);
    let completed = completed.map_err(|_| "CHAT_PENDING_QUEUE_WRITE_FAILED".to_string())?;
    wait_for_atomic_write(completed).map_err(|_| "CHAT_PENDING_QUEUE_WRITE_FAILED".to_string())
}

fn persist_pending_files(files: &Arc<Mutex<Vec<PendingToxFile>>>, path: &PathBuf) {
    let Ok(files) = files.lock() else { return };
    let Ok(serialized) = serde_json::to_vec(&*files) else {
        return;
    };
    let _ = profiles::write_file(path, &serialized);
}

fn persist_pending_files_required(
    files: &Arc<Mutex<Vec<PendingToxFile>>>,
    path: &Path,
) -> Result<(), String> {
    let files = files
        .lock()
        .map_err(|_| "TRANSFER_STATE_UNAVAILABLE".to_string())?;
    let serialized =
        serde_json::to_vec(&*files).map_err(|_| "TRANSFER_QUEUE_ENCODE_FAILED".to_string())?;
    profiles::atomic_write(path, &serialized).map_err(|_| "TRANSFER_QUEUE_WRITE_FAILED".to_string())
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
    let _ = profiles::write_file(path, &serialized);
}

// toxcore does not retain text messages for an offline peer.  Keep the queue
// in our profile and only pass an item to toxcore once the friend is online.
fn flush_pending_messages(state: &ToxState, tox: *mut c_void) {
    flush_pending_messages_with_transport(
        state,
        |key| resolve_current_friend_number(tox, key),
        |friend| friend_is_connected(tox, friend),
        |friend, bytes| {
            let mut error = 0_i32;
            let receipt = unsafe {
                tox_friend_send_message(tox, friend, 0, bytes.as_ptr(), bytes.len(), &mut error)
            };
            if error == 0 {
                Ok(receipt)
            } else {
                Err(error)
            }
        },
    );
}

fn flush_pending_messages_with_transport(
    state: &ToxState,
    resolve_friend: impl Fn(&str) -> Option<u32>,
    connected: impl Fn(u32) -> bool,
    mut send: impl FnMut(u32, &[u8]) -> Result<u32, i32>,
) {
    let Ok(_transaction) = state.chat_transaction_gate.lock() else {
        return;
    };
    if !state.chat_transport_ready.load(Ordering::Acquire) {
        return;
    }
    let pending = match state.pending_messages.lock() {
        Ok(items) => items.clone(),
        Err(_) => return,
    };
    if pending.is_empty() {
        return;
    }

    let mut sent_receipts = Vec::new();
    let mut offsets = Vec::new();
    for mut item in pending {
        let Some(current_friend_number) = resolve_friend(&item.friend_public_key) else {
            log_network(
                &state.network_log_path,
                format!(
                    "QUEUE_RECIPIENT_MISSING friend={} local_id={}",
                    item.friend_number, item.id
                ),
            );
            continue;
        };
        item.friend_number = current_friend_number;
        if ordinary_chat_transport_waits_for_pq(state, item.friend_number) {
            continue;
        }
        if !connected(item.friend_number) {
            continue;
        }
        // toxcore may report a newly reconnected friend before its receipt path
        // is ready. Sending the offline queue in that first iteration can
        // deliver the text while permanently losing the delivery receipt.
        if !friend_message_connection_is_settled(
            &state.friend_message_ready_at,
            item.friend_number,
            Instant::now(),
        ) {
            continue;
        }
        if !item.wire_fragments.is_empty() {
            if !state.chat_protocol.supports(item.friend_number) {
                continue;
            }
            let mut cursor = item.next_offset.min(item.wire_fragments.len());
            while cursor < item.wire_fragments.len() {
                let chunk = item.wire_fragments[cursor].as_bytes();
                let tox_message_id = match send(item.friend_number, chunk) {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        log_network(
                            &state.network_log_path,
                            format!(
                                "QUEUE_SEND_FAILED friend={} local_id={} fragment={} error={error}",
                                item.friend_number, item.id, cursor
                            ),
                        );
                        break;
                    }
                };
                sent_receipts.push((item.id.clone(), item.friend_number, tox_message_id));
                cursor += 1;
            }
            offsets.push((item.id, cursor, cursor == item.wire_fragments.len()));
        } else {
            let mut offset = item.next_offset.min(item.text.len());
            while offset < item.text.len() {
                let end = text_chunk_end(&item.text, offset);
                let chunk = &item.text.as_bytes()[offset..end];
                let tox_message_id = match send(item.friend_number, chunk) {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        log_network(
                            &state.network_log_path,
                            format!(
                                "QUEUE_SEND_FAILED friend={} local_id={} offset={} error={error}",
                                item.friend_number, item.id, offset
                            ),
                        );
                        break;
                    }
                };
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
    let Ok(_transaction) = state.chat_transaction_gate.lock() else {
        return;
    };
    if !state.chat_transport_ready.load(Ordering::Acquire) {
        return;
    }
    let pending = match state.pending_pq_messages.lock() {
        Ok(items) => items.clone(),
        Err(_) => return,
    };
    if pending.is_empty() {
        return;
    }

    let mut sent = Vec::new();
    let mut legacy_sent = Vec::new();
    for mut item in pending {
        let Some(current_friend_number) =
            resolve_current_friend_number(tox, &item.friend_public_key)
        else {
            log_network(
                &state.network_log_path,
                format!(
                    "PQ_QUEUE_RECIPIENT_MISSING friend={} local_id={}",
                    item.friend_number, item.id
                ),
            );
            continue;
        };
        item.friend_number = current_friend_number;
        if !friend_is_connected(tox, item.friend_number)
            || !state.pq.queues_encrypted_messages(item.friend_number)
        {
            continue;
        }
        if item.wire_text.is_some() && !state.chat_protocol.supports(item.friend_number) {
            continue;
        }
        let transport_text = item.wire_text.as_deref().unwrap_or(&item.text);
        let encrypted = match state
            .pq
            .encrypt_named(item.friend_number, &item.id, transport_text)
        {
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
        if encrypted.packets.is_empty() {
            continue;
        }
        if !state.pq.is_v2(item.friend_number) {
            if let Ok(mut receipts) = state.pq_receipts.lock() {
                receipts.insert((item.friend_number, encrypted.wire_id), item.id.clone());
            } else {
                continue;
            }
            legacy_sent.push(item.id.clone());
        }
        state.pq.queue(item.friend_number, encrypted.packets);
        sent.push(item.id);
    }
    if sent.is_empty() {
        return;
    }
    if let Ok(mut pending) = state.pending_pq_messages.lock() {
        pending.retain(|item| !legacy_sent.iter().any(|id| id == &item.id));
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

fn drive_pq_sessions(state: &ToxState, tox: *mut c_void) {
    let Ok(_transaction) = state.chat_transaction_gate.lock() else {
        return;
    };
    if !state.chat_transport_ready.load(Ordering::Acquire) {
        return;
    }
    let owner = pq_tox_owner(tox);
    for (key, friend) in tox_friend_numbers_by_public_key(tox) {
        let action = (|| -> Result<(), String> {
            bind_pq_contact(
                &state.pq,
                &state.messages,
                &state.history_path,
                friend,
                &key,
                &owner,
            )?;
            if state.pq.auto_skip_pending(friend) {
                resume_pq_auto_skip(state, friend, &key)?;
            }
            settle_pq_deliveries(state, friend, &key)?;
            let drained = state
                .pending_pq_messages
                .lock()
                .map_err(|_| "PQ_PENDING_LOCKED")?
                .iter()
                .all(|item| !pending_message_matches_friend(item, friend, &key));
            let before = state.pq.status(friend);
            state
                .pq
                .drive(friend, friend_is_connected(tox, friend), drained)?;
            let after = state.pq.status(friend);
            if before.state != after.state {
                if after.state == "active" {
                    if !update_latest_pq_history(&state.messages, friend, &after, "active") {
                        append_pq_history(
                            &state.messages,
                            friend,
                            &after,
                            "initiator",
                            "active",
                            true,
                        );
                    }
                } else if before.state.starts_with("closing") && after.state == "available" {
                    update_latest_pq_history(&state.messages, friend, &after, "closed");
                }
                persist_tox_history_required(
                    &state.messages,
                    &state.history_path,
                    &state.history_enabled,
                )?;
            }
            Ok(())
        })();
        if let Err(error) = action {
            log_network(
                &state.network_log_path,
                format!("PQ_DURABLE_WAIT friend={friend} error={error}"),
            );
        }
    }
}

fn pending_message_matches_friend(item: &PendingToxMessage, friend: u32, key: &str) -> bool {
    friend_identity_matches(item.friend_number, &item.friend_public_key, friend, key)
}

/// Ciphertext stays in the PQ journal until history, the operation receipt and
/// the application queue have durably recorded delivery. Restart repeats this
/// settlement if it ended between either checkpoint.
fn settle_pq_deliveries(state: &ToxState, friend: u32, key: &str) -> Result<(), String> {
    for (wire, id) in state.pq.delivered(friend) {
        if !id.starts_with("service:") {
            // The peer's durable ACK already makes delivery a fact. Partial
            // local settlement can safely retry without stopping transport;
            // the ciphertext journal is retained until this whole step commits.
            if let Ok(mut messages) = state.messages.lock() {
                if let Some(message) = messages
                    .iter_mut()
                    .find(|m| m.id == id && message_matches_friend(m, friend, key))
                {
                    message.delivery = "delivered".into();
                    message.delivered_at = Some(unix_timestamp());
                }
            }
            // A delivered row may already have left the resident window.
            if chat_history_store::contains_registered(&state.history_path) {
                if let Some(mut row) = chat_history_store::find_message_registered(
                    &state.history_path,
                    friend,
                    key,
                    &id,
                )? {
                    row.delivery = "delivered".into();
                    row.delivered_at = Some(unix_timestamp());
                    write_registered_history_rows_required(&[row], &state.history_path)?;
                }
            }
            persist_tox_history_required(
                &state.messages,
                &state.history_path,
                &state.history_enabled,
            )?;
            state
                .chat_protocol
                .update_message_operation_delivery(friend, key, &id, "delivered")?;
            state
                .pending_pq_messages
                .lock()
                .map_err(|_| "PQ_PENDING_LOCKED")?
                .retain(|item| item.id != id || !pending_message_matches_friend(item, friend, key));
            persist_pending_messages_required(
                &state.pending_pq_messages,
                &state.pending_pq_messages_path,
            )?;
            commit_chat_transaction(&state.history_path)?;
            bump_chat_view_revision(&state.history_path, friend, key);
        }
        state.pq.forget_delivered(friend, wire)?;
    }
    Ok(())
}

fn skip_pq_auto_for_state(state: &ToxState, friend: u32) -> Result<PqStatus, String> {
    let (key, _transaction) = lock_chat_transaction_for_friend(state, friend)?;
    state.pq.skip_auto(friend)?;
    if state.pq.auto_skip_pending(friend) {
        resume_pq_auto_skip(state, friend, &key)?;
    }
    Ok(state.pq.status(friend))
}

/// The durable PQ policy marker fences the normal queue until conversion has
/// committed. A crash between writing either queue resumes the same operation.
fn resume_pq_auto_skip(state: &ToxState, friend: u32, key: &str) -> Result<(), String> {
    let protocol_version = state
        .chat_protocol
        .supports(friend)
        .then_some(chat_protocol::VERSION);
    let mut selected = state
        .pending_pq_messages
        .lock()
        .map_err(|_| "PQ_PENDING_LOCKED")?
        .iter()
        .filter(|item| pending_message_matches_friend(item, friend, &key))
        .cloned()
        .collect::<Vec<_>>();
    for item in &mut selected {
        if let Some(mut envelope) = item
            .wire_text
            .as_deref()
            .map(chat_protocol::decode_pq_message)
            .transpose()?
            .flatten()
        {
            envelope.pq_protected = false;
            item.wire_fragments = if protocol_version.is_some() {
                chat_protocol::encode_message_fragments(&envelope)?
            } else {
                Vec::new()
            };
            if protocol_version.is_none() {
                // An unsupported client receives only the ordinary plaintext
                // compatibility representation. Remove negotiated-only metadata
                // from the staged envelope before retiring the protected copy.
                envelope.formatting.clear();
                item.text = envelope
                    .quote
                    .as_ref()
                    .map(|q| chat_protocol::qtox_quote_fallback(q, &envelope.text))
                    .unwrap_or(envelope.text);
            }
        }
        item.wire_text = None;
        item.next_offset = 0;
        state.chat_protocol.allow_message_without_pq_before_send(
            friend,
            &key,
            &item.id,
            protocol_version,
        )?;
        if chat_history_store::contains_registered(&state.history_path) {
            if let Some(mut row) = chat_history_store::find_message_registered(
                &state.history_path,
                friend,
                key,
                &item.id,
            )? {
                row.pq_protected = false;
                row.protocol_version = protocol_version;
                if protocol_version.is_none() {
                    row.formatting.clear();
                }
                write_registered_history_rows_required(&[row], &state.history_path)?;
            }
        }
        if let Ok(mut messages) = state.messages.lock() {
            if let Some(row) = messages
                .iter_mut()
                .find(|m| m.id == item.id && message_matches_friend(m, friend, &key))
            {
                row.pq_protected = false;
                row.protocol_version = protocol_version;
                if protocol_version.is_none() {
                    row.formatting.clear();
                }
            }
        }
    }
    {
        let mut normal = state
            .pending_messages
            .lock()
            .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?;
        for item in &selected {
            if !normal
                .iter()
                .any(|old| old.id == item.id && pending_message_matches_friend(old, friend, key))
            {
                normal.push(item.clone());
            }
        }
        drop(normal);
        // The protected queue is also the recovery source for security labels.
        // Persist every rewritten row before removing that source on disk.
        persist_tox_history_required(&state.messages, &state.history_path, &state.history_enabled)?;
        // Keep the old protected queue until the new durable queue is present.
        persist_pending_messages_required(&state.pending_messages, &state.pending_messages_path)?;
        state
            .pending_pq_messages
            .lock()
            .map_err(|_| "PQ_PENDING_LOCKED")?
            .retain(|item| {
                !pending_message_matches_friend(item, friend, key)
                    || !selected.iter().any(|m| m.id == item.id)
            });
        // Retry these writes even if a previous failed attempt already removed
        // the entries from RAM. The durable protected queue may still contain them.
        persist_pending_messages_required(
            &state.pending_pq_messages,
            &state.pending_pq_messages_path,
        )?;
        commit_chat_transaction(&state.history_path)?;
        bump_chat_view_revision(&state.history_path, friend, &key);
    }
    state.pq.finish_auto_skip(friend)
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
    let Ok(_transaction) = state.chat_transaction_gate.lock() else {
        return;
    };
    if !state.chat_transport_ready.load(Ordering::Acquire) {
        return;
    }
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

fn flush_chat_protocol_outbox(state: &ToxState, tox: *mut c_void) {
    let Ok(_transaction) = state.chat_transaction_gate.lock() else {
        return;
    };
    if !state.chat_transport_ready.load(Ordering::Acquire) {
        return;
    }
    let now = Instant::now();
    for pending in state.chat_protocol.due_reactions(now) {
        let Some(friend_number) = resolve_current_friend_number(tox, &pending.friend_public_key)
        else {
            continue;
        };
        if !friend_is_connected(tox, friend_number) || !state.chat_protocol.supports(friend_number)
        {
            continue;
        }
        let Ok(packet) = chat_protocol::encode_reaction_packet(&pending) else {
            continue;
        };
        if pending.pq_required {
            if !state.pq.queues_encrypted_messages(friend_number) {
                continue;
            }
            let encoded = chat_protocol::encode_pq_service_packet(&packet);
            let Ok(encrypted) = state.pq.encrypt(friend_number, &encoded) else {
                continue;
            };
            state.pq.queue(friend_number, encrypted.packets);
        } else {
            state.chat_protocol.queue_packet(friend_number, packet);
        }
        state.chat_protocol.mark_reaction_attempted(&pending, now);
    }

    let mut outbox = state.chat_protocol.take_packet_outbox();
    let mut retry = Vec::new();
    while let Some((friend_number, bytes)) = outbox.first().cloned() {
        outbox.remove(0);
        if !friend_is_connected(tox, friend_number) {
            retry.push((friend_number, bytes));
            continue;
        }
        if !ChatProtocolEngine::is_capability_packet(&bytes)
            && !state.chat_protocol.supports(friend_number)
        {
            // Current-connection capability traffic may pass older retained
            // controls. Those controls remain queued until this connection
            // validates the chat protocol again.
            retry.push((friend_number, bytes));
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
            retry.push((friend_number, bytes));
            retry.append(&mut outbox);
            break;
        }
    }
    state.chat_protocol.requeue_packets_front(retry);
}

fn flush_file_card_outbox(state: &ToxState, tox: *mut c_void) {
    let Ok(_transaction) = state.chat_transaction_gate.lock() else {
        return;
    };
    if !state.chat_transport_ready.load(Ordering::Acquire) {
        return;
    }
    match reconcile_rejected_file_cards(
        &state.file_card_protocol,
        &state.pending_files,
        &state.pending_files_path,
        &state.messages,
        &state.history_path,
        &state.history_enabled,
    ) {
        Ok(0) => {}
        Ok(_) => {
            state.chat_transport_ready.store(false, Ordering::Release);
            if commit_chat_transaction_with_barrier(
                &state.history_path,
                &state.chat_transport_ready,
            )
            .is_err()
            {
                return;
            }
            bump_history_revision(&state.history_path);
            if let Some(updates) = &state.updates {
                updates.changed();
            }
        }
        Err(_) => {
            state.chat_transport_ready.store(false, Ordering::Release);
            return;
        }
    }
    let candidates = state
        .pending_files
        .lock()
        .map(|files| {
            files
                .iter()
                .filter(|file| file.protocol_version == Some(file_card_protocol::VERSION))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut changed = false;
    for item in candidates {
        let Some(friend_number) = resolve_current_friend_number(tox, &item.friend_public_key)
        else {
            continue;
        };
        if !state.chat_protocol.supports(friend_number)
            || file_chat_transport_waits_for_pq(state, friend_number)
        {
            continue;
        }
        let offer_was_durable = state
            .file_card_protocol
            .outgoing_offer(friend_number, &item.friend_public_key, &item.id)
            .is_some();
        if !offer_was_durable {
            state.chat_transport_ready.store(false, Ordering::Release);
            changed = true;
        }
        let offer = match state.file_card_protocol.offer_for_send(
            friend_number,
            &item.friend_public_key,
            &item.id,
            &item.filename,
            item.size,
        ) {
            Ok(offer) => offer,
            Err(_) => continue,
        };
        let acknowledged = state
            .file_card_protocol
            .outgoing_acknowledgement(friend_number, &item.friend_public_key, &item.id)
            .is_some_and(|status| {
                matches!(
                    status,
                    FileCardAckStatus::Applied | FileCardAckStatus::Duplicate
                )
            });
        if let Ok(mut files) = state.pending_files.lock() {
            if let Some(current) = files.iter_mut().find(|current| current.id == item.id) {
                let transfer_id = file_card_protocol::transfer_id_to_hex(&offer.transfer_id);
                if current.transfer_id.as_deref() != Some(transfer_id.as_str())
                    || current.announcement_acked != acknowledged
                {
                    state.chat_transport_ready.store(false, Ordering::Release);
                    current.transfer_id = Some(transfer_id);
                    current.announcement_acked = acknowledged;
                    current.friend_number = friend_number;
                    changed = true;
                }
            }
        }
    }
    if changed {
        if persist_pending_files_required(&state.pending_files, &state.pending_files_path).is_err()
        {
            state.chat_transport_ready.store(false, Ordering::Release);
            return;
        }
        if commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)
            .is_err()
        {
            return;
        }
    }

    let now = unix_timestamp();
    for pending in state.file_card_protocol.due_offers(now) {
        let Some(friend_number) = resolve_current_friend_number(tox, &pending.friend_public_key)
        else {
            continue;
        };
        if !friend_is_connected(tox, friend_number)
            || !state.chat_protocol.supports(friend_number)
            || file_chat_transport_waits_for_pq(state, friend_number)
        {
            continue;
        }
        let Ok(packet) = file_card_protocol::encode_offer(&pending.offer) else {
            continue;
        };
        if state
            .file_card_protocol
            .mark_attempted(&pending, now)
            .is_err()
        {
            continue;
        }
        let mut error = 0_i32;
        let _ = unsafe {
            tox_friend_send_lossless_packet(
                tox,
                friend_number,
                packet.as_ptr(),
                packet.len(),
                &mut error,
            )
        };
    }
}

fn flush_pending_files(state: &ToxState, tox: *mut c_void) {
    let Ok(_transaction) = state.chat_transaction_gate.lock() else {
        return;
    };
    if !state.chat_transport_ready.load(Ordering::Acquire) {
        return;
    }
    let pending = match state.pending_files.lock() {
        Ok(items) => items.clone(),
        Err(_) => return,
    };
    if pending.is_empty() {
        return;
    }
    let active_outgoing = state
        .outgoing_files
        .lock()
        .map(|files| {
            files
                .values()
                .filter(|transfer| transfer.message_id.is_some())
                .count()
        })
        .unwrap_or(MAX_CONCURRENT_OUTGOING_FILES);
    let mut available_slots = MAX_CONCURRENT_OUTGOING_FILES.saturating_sub(active_outgoing);
    if available_slots == 0 {
        return;
    }

    let mut started = Vec::new();
    let mut failed = Vec::new();
    for mut item in pending {
        if available_slots == 0 {
            break;
        }
        let Some(current_friend_number) =
            resolve_current_friend_number(tox, &item.friend_public_key)
        else {
            log_transfer(
                &state.transfer_log_path,
                format!(
                    "FILE_QUEUE_RECIPIENT_MISSING friend={} local_id={}",
                    item.friend_number, item.id
                ),
            );
            continue;
        };
        item.friend_number = current_friend_number;
        if file_chat_transport_waits_for_pq(state, item.friend_number) {
            continue;
        }
        if item.protocol_version == Some(file_card_protocol::VERSION) {
            if !state.chat_protocol.supports(item.friend_number) {
                continue;
            }
            let acknowledged = item.announcement_acked
                || state
                    .file_card_protocol
                    .outgoing_acknowledgement(item.friend_number, &item.friend_public_key, &item.id)
                    .is_some_and(|status| {
                        matches!(
                            status,
                            FileCardAckStatus::Applied | FileCardAckStatus::Duplicate
                        )
                    });
            if !acknowledged {
                continue;
            }
        }
        let path = PathBuf::from(&item.path);
        if !profiles::file_exists(&path) {
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
        let (source_file_id, source_bytes) = match prepare_outgoing_source(&path, item.size) {
            Ok(source) => source,
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
        let file_id = match item.transfer_id.as_deref() {
            Some(value) if item.protocol_version == Some(file_card_protocol::VERSION) => {
                let Some(value) = file_card_protocol::transfer_id_from_hex(value) else {
                    set_attachment_transfer_error(
                        &state.messages,
                        &item.id,
                        "Идентификатор передачи повреждён.",
                    );
                    failed.push(item.id);
                    continue;
                };
                value
            }
            _ => source_file_id,
        };

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
                        filename: item.filename.clone(),
                        mime: item.mime.clone(),
                        size: item.size,
                        source_bytes,
                        message_id: Some(item.id.clone()),
                        protocol_transfer_id: item
                            .transfer_id
                            .as_deref()
                            .and_then(file_card_protocol::transfer_id_from_hex),
                        meter: TransferMeter::new(),
                        last_activity_at: Instant::now(),
                        active: true,
                        locally_paused: false,
                        phase: OutgoingFilePhase::WaitingForAcceptance,
                        fully_sent: false,
                        retry_count: item.retry_count,
                        #[cfg(feature = "web-core")]
                        web_transfer_id: None,
                    },
                );
            }
            available_slots -= 1;
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

fn outgoing_transfer_timed_out(transfer: &OutgoingFile) -> bool {
    outgoing_transfer_timed_out_at(transfer, Instant::now())
}

fn outgoing_transfer_timed_out_at(transfer: &OutgoingFile, now: Instant) -> bool {
    if transfer.locally_paused
        || !transfer.active
        || (transfer.message_id.is_some()
            && !transfer.fully_sent
            && transfer.phase == OutgoingFilePhase::WaitingForAcceptance)
    {
        // A live file offer has no user-acceptance deadline. Only a peer RESUME,
        // a chunk request, or proven transport loss starts the existing stall
        // recovery policy. Local pause/resume does not stand in for consent.
        return false;
    }
    let timeout = if transfer.fully_sent {
        FILE_TRANSFER_CONFIRMATION_TIMEOUT
    } else {
        transfer_idle_timeout(&transfer.meter)
    };
    now.saturating_duration_since(transfer.last_activity_at) >= timeout
}

fn incoming_transfer_timed_out(transfer: &IncomingFile) -> bool {
    incoming_transfer_timed_out_at(transfer, Instant::now())
}

fn incoming_transfer_timed_out_at(transfer: &IncomingFile, now: Instant) -> bool {
    !transfer.locally_paused
        && transfer.active
        && now.saturating_duration_since(transfer.last_activity_at)
            >= transfer_idle_timeout(&transfer.meter)
}

fn pending_file_retry(
    transfer: &OutgoingFile,
    message_id: String,
    friend_number: u32,
    friend_public_key: String,
) -> PendingToxFile {
    PendingToxFile {
        id: message_id,
        friend_number,
        friend_public_key,
        filename: transfer.filename.clone(),
        mime: transfer.mime.clone(),
        path: transfer.path.to_string_lossy().to_string(),
        size: transfer.size,
        timestamp: unix_timestamp(),
        retry_count: transfer.retry_count + 1,
        transfer_id: transfer
            .protocol_transfer_id
            .as_ref()
            .map(file_card_protocol::transfer_id_to_hex),
        announcement_acked: transfer.protocol_transfer_id.is_some(),
        protocol_version: transfer
            .protocol_transfer_id
            .is_some()
            .then_some(file_card_protocol::VERSION),
    }
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
                    #[cfg(feature = "web-core")]
                    if transfer.web_transfer_id.is_some() {
                        // Browser-backed transfers deliberately have no local
                        // source path. Their liveness is governed by the web
                        // UI lease and bridge state, so the desktop retry path
                        // must never cancel them or turn an empty path into a
                        // failed disk-file retry.
                        return false;
                    }
                    outgoing_transfer_timed_out(transfer)
                })
                .filter(|((friend_number, _), _)| friend_is_connected(tox, *friend_number))
                .map(|(key, transfer)| (*key, transfer.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let outgoing_changed = !expired_outgoing.is_empty();

    for ((friend_number, file_number), transfer) in expired_outgoing {
        if let Ok(mut files) = state.outgoing_files.lock() {
            files.remove(&(friend_number, file_number));
        }
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
        }
        if let Some(message_id) = transfer.message_id.clone() {
            if transfer.fully_sent {
                set_attachment_transfer_error(
                    &state.messages,
                    &message_id,
                    "Получатель не подтвердил завершение передачи. Можно отправить файл заново.",
                );
                log_transfer(&state.transfer_log_path, format!("FILE_CONFIRMATION_TIMEOUT friend={friend_number} file={file_number} message={message_id}"));
            } else if transfer.retry_count < MAX_FILE_TRANSFER_RETRIES
                && profiles::file_exists(&transfer.path)
            {
                let already_queued = state
                    .pending_files
                    .lock()
                    .ok()
                    .map(|items| items.iter().any(|item| item.id == message_id))
                    .unwrap_or(true);
                if !already_queued {
                    if let Ok(mut pending) = state.pending_files.lock() {
                        pending.push(pending_file_retry(
                            &transfer,
                            message_id.clone(),
                            friend_number,
                            tox_friend_public_key(tox, friend_number).unwrap_or_default(),
                        ));
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
                .filter(|(_, transfer)| incoming_transfer_timed_out(transfer))
                .filter(|((friend_number, _), _)| friend_is_connected(tox, *friend_number))
                .map(|(key, transfer)| (*key, transfer.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let incoming_changed = !expired_incoming.is_empty();
    for ((friend_number, file_number), transfer) in expired_incoming {
        if let Ok(mut files) = state.incoming_files.lock() {
            files.remove(&(friend_number, file_number));
        }
        let mut error = 0_i32;
        unsafe {
            let _ = tox_file_control(tox, friend_number, file_number, 2, &mut error);
        }
        let _ = profiles::remove_file(&transfer.path);
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
        if transfer.kind != 1 {
            resume_next_queued_incoming_for_state(tox, state);
        }
    }
    // Also heals a slot released while the Tox handle was being rebuilt.
    // The helper is a no-op unless capacity and an auto-queued file coexist.
    resume_next_queued_incoming_for_state(tox, state);
    if outgoing_changed {
        persist_pending_files(&state.pending_files, &state.pending_files_path);
    }
    if outgoing_changed || incoming_changed {
        persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);
        prune_inactive_evicted_terminal_messages(state);
    } else {
        let has_active_transfers = state
            .outgoing_files
            .lock()
            .map(|files| !files.is_empty())
            .unwrap_or(false)
            || state
                .incoming_files
                .lock()
                .map(|files| !files.is_empty())
                .unwrap_or(false);
        if has_active_transfers {
            // Progress is in-memory UI state. Refresh the bounded snapshot at
            // most once per housekeeping tick without serialising history or
            // dirtying the encrypted profile container.
            bump_history_revision(&state.history_path);
        }
    }
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
        chat_history_store::unregister(&self.history_path);
        // These ordered writes acquire the cancellation guard inside the
        // worker. Waiting while holding that guard would deadlock shutdown.
        persist_pending_messages_now(&self.pending_messages, &self.pending_messages_path);
        persist_pending_messages_now(&self.pending_pq_messages, &self.pending_pq_messages_path);
        persist_unread_state_now(&self.unread_state, &self.unread_state_path);
        if let Ok(mut state) = self.handle.lock() {
            if let Some(instance) = state.take() {
                let _ = Self::save(&instance);
                let _ = self.checkpoint_profile(true);
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
    fn tox_file_get_file_id(
        tox: *const c_void,
        friend_number: u32,
        file_number: u32,
        file_id: *mut u8,
        error: *mut i32,
    ) -> bool;
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
    fn tox_callback_file_recv_control(
        tox: *mut c_void,
        callback: Option<unsafe extern "C" fn(*mut c_void, u32, u32, i32, *mut c_void)>,
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

#[cfg(all(test, feature = "desktop"))]
mod tox_tests {
    use super::desktop_adapter::{
        get_tox_friends_snapshot, import_qtox_avatars, validated_download_file,
    };
    use super::{
        affected_friend_avatar_numbers, append_pq_history, apply_network_options,
        avatar_data_url_from_path, create_tox_handle, current_self_avatar_matches,
        exact_loaded_profile, friend_message_connection_is_settled, friend_message_snapshot,
        hex_upper, inactive_history_eviction_targets, incoming_transfer_timed_out,
        incoming_transfer_timed_out_at, local_notifications_enabled, message_matches_friend,
        next_queued_incoming, normalize_status_message, note_friend_message_connection,
        note_outgoing_transport_loss, outgoing_file_cache_path, outgoing_transfer_timed_out,
        outgoing_transfer_timed_out_at, parse_webview2_runtime_max_relative_path,
        pending_file_retry, persist_message_reaction_view, persist_tox_history,
        persist_unread_state, portable_webview_data_dir, preferred_profile_avatar_from_directory,
        prepare_outgoing_source, profile_local_state_preserving_avatar, profiles, qtox_history,
        reaction_target_policy, read_profile_local_state, rebase_portable_file,
        reconcile_friend_avatar_files, reconcile_reaction_targets, refresh_history_residence,
        release_history_residence, remove_file_transfer_for_direction, remove_self_avatar_files,
        resolved_bootstrap_nodes, safe_file_name, sanitize_untrusted_text,
        should_default_linux_dmabuf_renderer, text_chunk_end, tox_friend_add_norequest,
        tox_friend_get_public_key, tox_get_savedata, tox_get_savedata_size, tox_kill,
        tox_options_free, tox_options_get_ipv6_enabled, tox_options_get_local_discovery_enabled,
        tox_options_get_udp_enabled, tox_options_new, tox_savedata_public_key,
        tox_self_get_address, tox_self_get_friend_list, tox_self_get_friend_list_size,
        tray_base_image, tray_image, unique_download_path, update_latest_pq_history,
        validate_profile_avatar_update, webview2_runtime_paths_fit,
        write_profile_avatar_local_state, write_profile_local_state,
        write_profile_local_state_preserving_avatar, write_profile_local_state_transaction,
        write_transfer_chunk, CachedFriendProfile, ChatProtocolEngine, FileReceiveSettings,
        HistoryResidence, IncomingFile, NetworkSettings, OutgoingFile, OutgoingFilePhase,
        PortablePaths, PqStatus, ProfileAvatarUpdate, ProfilePaths, ProxySettings, TorManager,
        ToxMessage, ToxState, TransferMeter, UnreadState, FRIEND_MESSAGE_CONNECTION_SETTLE,
        MAX_PROFILE_AVATAR_BYTES, TOX_TEXT_CHUNK_BYTES, TRAY_UNREAD_SCALE_PERCENT,
        WEBVIEW2_RUNTIME_PATH_LIMIT_UTF16_UNITS,
    };
    use super::{chat_history_store, chat_protocol, ReactionCode};
    use serde_json::Value;
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Barrier, Mutex},
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
    fn chat_history_lease_rejects_stale_refresh_and_preserves_newer_view() {
        let started = Instant::now();
        let mut residence = HistoryResidence {
            friend_number: 7,
            friend_public_key: "KEY-7".to_string(),
            active: false,
            left_at: None,
            last_access: started,
            evicted: false,
            lease_sessions: HashMap::new(),
        };

        refresh_history_residence(&mut residence, "renderer".to_string(), 1, started);
        assert!(residence.active);
        release_history_residence(
            &mut residence,
            Some(("renderer".to_string(), 1)),
            started + Duration::from_secs(1),
        );
        assert!(!residence.active);
        refresh_history_residence(
            &mut residence,
            "renderer".to_string(),
            1,
            started + Duration::from_secs(2),
        );
        assert!(!residence.active, "a released generation must not revive");

        refresh_history_residence(
            &mut residence,
            "renderer".to_string(),
            2,
            started + Duration::from_secs(3),
        );
        assert!(residence.active);
        release_history_residence(
            &mut residence,
            Some(("renderer".to_string(), 1)),
            started + Duration::from_secs(4),
        );
        assert!(
            residence.active,
            "a late old release must preserve the newer view"
        );
        release_history_residence(
            &mut residence,
            Some(("renderer".to_string(), 2)),
            started + Duration::from_secs(5),
        );
        assert!(!residence.active);
        assert!(residence.left_at.is_some());
    }

    #[test]
    fn inactive_history_windows_obey_global_count_cost_and_ttl_bounds() {
        let now = Instant::now();
        let mut residency = HashMap::new();
        let mut costs = HashMap::new();
        for index in 0_u64..5 {
            let key = format!("friend-number:{index}");
            residency.insert(
                key.clone(),
                HistoryResidence {
                    friend_number: index as u32,
                    friend_public_key: String::new(),
                    active: false,
                    left_at: Some(now - Duration::from_secs(10)),
                    last_access: now - Duration::from_secs(5 - index),
                    evicted: false,
                    lease_sessions: HashMap::new(),
                },
            );
            costs.insert(key, 700 * 1024);
        }
        residency.insert(
            "friend-number:99".to_string(),
            HistoryResidence {
                friend_number: 99,
                friend_public_key: String::new(),
                active: true,
                left_at: None,
                last_access: now - Duration::from_secs(60 * 60 * 4),
                evicted: false,
                lease_sessions: HashMap::new(),
            },
        );
        costs.insert("friend-number:99".to_string(), 4 * 1024 * 1024);
        residency.insert(
            "friend-number:100".to_string(),
            HistoryResidence {
                friend_number: 100,
                friend_public_key: String::new(),
                active: false,
                left_at: Some(now - Duration::from_secs(2 * 60 * 60 + 1)),
                last_access: now,
                evicted: false,
                lease_sessions: HashMap::new(),
            },
        );
        costs.insert("friend-number:100".to_string(), 1);

        let evicted = inactive_history_eviction_targets(&residency, &costs, now);
        assert_eq!(evicted.len(), 4);
        assert!(evicted.contains("friend-number:0"));
        assert!(evicted.contains("friend-number:1"));
        assert!(evicted.contains("friend-number:2"));
        assert!(evicted.contains("friend-number:100"));
        assert!(!evicted.contains("friend-number:3"));
        assert!(!evicted.contains("friend-number:4"));
        assert!(!evicted.contains("friend-number:99"));
    }

    #[test]
    fn aged_reaction_is_archived_in_history_and_becomes_immutable() {
        let root = temporary_root("reaction-history-archive");
        fs::create_dir_all(&root).unwrap();
        let history_path = root.join("chat-history.json");
        let friend_public_key = "AABB";
        let rows = (1_u64..=51)
            .map(|index| ToxMessage {
                id: format!("{index:032x}"),
                friend_number: 7,
                friend_public_key: friend_public_key.to_string(),
                text: format!("message {index}"),
                mine: index % 2 == 0,
                timestamp: index,
                delivery: "delivered".to_string(),
                delivered_at: Some(index),
                attachment: None,
                event: None,
                protocol_version: Some(chat_protocol::VERSION),
                operation_id: None,
                quote: None,
                formatting: Vec::new(),
                pq_protected: false,
                reactions: None,
            })
            .collect::<Vec<_>>();
        chat_history_store::open_and_register(&history_path, rows.clone()).unwrap();
        let messages = Arc::new(Mutex::new(rows));
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let first_id = format!("{:032x}", 1_u64);
        let second_id = format!("{:032x}", 2_u64);
        let pending = engine
            .update_local_reactions(
                7,
                friend_public_key,
                &first_id,
                vec![ReactionCode::Heart],
                Some("reaction-op-1"),
                false,
                100,
            )
            .unwrap();
        engine
            .acknowledge_reaction(
                7,
                friend_public_key,
                &chat_protocol::IncomingReactionAck {
                    target_id: first_id.clone(),
                    revision: pending.mine_revision,
                    status: chat_protocol::ReactionAckStatus::Applied,
                    pq_required: false,
                },
            )
            .unwrap();
        let view = engine
            .reaction_view(7, friend_public_key, &first_id)
            .unwrap();
        persist_message_reaction_view(
            &history_path,
            true,
            &messages,
            7,
            friend_public_key,
            &first_id,
            view.clone(),
        )
        .unwrap();

        reconcile_reaction_targets(
            &engine,
            &history_path,
            true,
            &messages,
            7,
            friend_public_key,
        )
        .unwrap();
        assert!(engine
            .reaction_view(7, friend_public_key, &first_id)
            .is_none());
        assert_eq!(
            chat_history_store::find_message_registered(
                &history_path,
                7,
                friend_public_key,
                &first_id,
            )
            .unwrap()
            .unwrap()
            .reactions,
            Some(view)
        );
        assert_eq!(
            reaction_target_policy(&history_path, true, &[], 7, friend_public_key, &first_id,)
                .unwrap_err(),
            "CHAT_REACTION_TARGET_OUTSIDE_RECENT_WINDOW"
        );
        assert_eq!(
            reaction_target_policy(&history_path, true, &[], 7, friend_public_key, &second_id,)
                .unwrap(),
            false
        );

        chat_history_store::unregister(&history_path);
        fs::remove_dir_all(root).unwrap();
    }

    fn incoming_file_fixture(queue_order: u64, active: bool, auto_queued: bool) -> IncomingFile {
        IncomingFile {
            path: std::path::PathBuf::from(format!("incoming-{queue_order}.part")),
            final_path: None,
            size: 8,
            buffered_target: None,
            kind: 0,
            message_id: Some(format!("incoming-{queue_order}")),
            protocol_transfer_id: None,
            meter: TransferMeter::new(),
            last_activity_at: Instant::now(),
            active,
            locally_paused: false,
            auto_queued,
            queue_order,
        }
    }

    fn outgoing_file_fixture(active: bool, fully_sent: bool) -> OutgoingFile {
        OutgoingFile {
            path: std::path::PathBuf::from("cached-payload.bin"),
            filename: "payload.bin".to_string(),
            mime: "application/x-test".to_string(),
            size: 8,
            source_bytes: None,
            message_id: Some("outgoing-message".to_string()),
            protocol_transfer_id: None,
            meter: TransferMeter::new(),
            last_activity_at: Instant::now(),
            active,
            locally_paused: false,
            phase: OutgoingFilePhase::Transferring,
            fully_sent,
            retry_count: 1,
            #[cfg(feature = "web-core")]
            web_transfer_id: None,
        }
    }

    #[test]
    fn desktop_incoming_queue_is_fifo_and_ignores_nonqueued_entries() {
        let mut files = HashMap::new();
        files.insert((7, 30), incoming_file_fixture(30, false, true));
        files.insert((7, 10), incoming_file_fixture(10, false, true));
        files.insert((7, 5), incoming_file_fixture(5, true, true));
        files.insert((7, 1), incoming_file_fixture(1, false, false));
        assert_eq!(
            next_queued_incoming(&files),
            Some(((7, 10), "incoming-10".to_string()))
        );
    }

    #[test]
    fn deny_all_removes_active_waiting_paused_and_queued_receives_but_preserves_avatars() {
        let buffer = Arc::new(Mutex::new(vec![1_u8, 2, 3]));
        let mut active = incoming_file_fixture(1, true, false);
        active.buffered_target = Some(Arc::clone(&buffer));
        let mut paused = incoming_file_fixture(4, false, false);
        paused.locally_paused = true;
        let mut avatar = incoming_file_fixture(5, true, false);
        avatar.kind = 1;
        let files = Mutex::new(HashMap::from([
            ((7, 1), active),
            ((7, 2), incoming_file_fixture(2, false, true)),
            ((7, 3), incoming_file_fixture(3, false, false)),
            ((7, 4), paused),
            ((7, 5), avatar),
        ]));
        let removed = super::take_incoming_chat_files(&files).unwrap();
        assert_eq!(removed.len(), 4);
        assert_eq!(
            files.lock().unwrap().keys().copied().collect::<Vec<_>>(),
            vec![(7, 5)]
        );
        assert!(super::take_incoming_chat_files(&files).unwrap().is_empty());
        assert!(next_queued_incoming(&files.lock().unwrap()).is_none());
        drop(removed);
        assert_eq!(
            Arc::strong_count(&buffer),
            1,
            "cancelled plaintext receive buffers were released"
        );
    }

    #[test]
    fn desktop_watchdog_preserves_paused_and_queued_transfers_but_expires_terminal_ack() {
        let old = Instant::now() - Duration::from_secs(600);

        let mut queued_incoming = incoming_file_fixture(1, false, true);
        queued_incoming.last_activity_at = old;
        assert!(!incoming_transfer_timed_out(&queued_incoming));

        let mut active_incoming = incoming_file_fixture(2, true, false);
        active_incoming.last_activity_at = old;
        assert!(incoming_transfer_timed_out(&active_incoming));

        let mut paused_outgoing = outgoing_file_fixture(false, false);
        paused_outgoing.last_activity_at = old;
        assert!(!outgoing_transfer_timed_out(&paused_outgoing));

        let mut awaiting_confirmation = outgoing_file_fixture(true, true);
        awaiting_confirmation.last_activity_at = old;
        assert!(outgoing_transfer_timed_out(&awaiting_confirmation));
    }

    #[test]
    fn desktop_local_outgoing_pause_survives_peer_resume_and_watchdog_until_local_resume() {
        let started = Instant::now();
        let mut offer = outgoing_file_fixture(true, false);
        offer.phase = OutgoingFilePhase::WaitingForAcceptance;
        offer.set_local_paused(true, started);

        // The receiver accepts while the sender is deliberately paused. This
        // is real peer consent, but it cannot restart the local watchdog.
        offer.apply_peer_control(0, false, started + Duration::from_secs(1));
        assert_eq!(offer.phase, OutgoingFilePhase::Transferring);
        assert!(offer.locally_paused);
        assert!(!offer.active);
        for elapsed in [130, 600, 86_400] {
            assert!(
                !outgoing_transfer_timed_out_at(&offer, started + Duration::from_secs(elapsed)),
                "a paused offer must never enter the watchdog cancel/reoffer path"
            );
        }
        assert_eq!(offer.retry_count, 1);
        assert_eq!(offer.message_id.as_deref(), Some("outgoing-message"));
        offer.apply_peer_control(1, false, started + Duration::from_secs(86_401));
        offer.apply_peer_control(0, false, started + Duration::from_secs(86_402));
        assert!(offer.locally_paused && !offer.active);

        let resumed = started + Duration::from_secs(86_403);
        offer.set_local_paused(false, resumed);
        assert!(offer.active && !offer.locally_paused);
        assert_eq!(offer.last_activity_at, resumed);
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            resumed + Duration::from_secs(120) - Duration::from_nanos(1)
        ));
        assert!(outgoing_transfer_timed_out_at(
            &offer,
            resumed + Duration::from_secs(120)
        ));
        // Once local pause is released, ordinary peer pause/resume still works.
        offer.apply_peer_control(1, false, resumed + Duration::from_secs(1));
        assert!(!offer.active && !offer.locally_paused);
        offer.apply_peer_control(0, false, resumed + Duration::from_secs(2));
        assert!(offer.active && !offer.locally_paused);
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            resumed + Duration::from_secs(121)
        ));
    }

    #[test]
    fn desktop_local_incoming_pause_survives_peer_resume_until_local_resume() {
        let started = Instant::now();
        let mut incoming = incoming_file_fixture(1, true, false);
        incoming.set_local_paused(true, started);
        incoming.apply_peer_control(0, false, started + Duration::from_secs(1));
        assert!(incoming.locally_paused && !incoming.active);
        for elapsed in [130, 600, 86_400] {
            assert!(!incoming_transfer_timed_out_at(
                &incoming,
                started + Duration::from_secs(elapsed)
            ));
        }
        let resumed = started + Duration::from_secs(86_401);
        incoming.set_local_paused(false, resumed);
        assert!(incoming.active && !incoming.locally_paused);
        assert!(!incoming_transfer_timed_out_at(
            &incoming,
            resumed + Duration::from_secs(120) - Duration::from_nanos(1)
        ));
        assert!(incoming_transfer_timed_out_at(
            &incoming,
            resumed + Duration::from_secs(120)
        ));
        incoming.apply_peer_control(1, false, resumed + Duration::from_secs(1));
        assert!(!incoming.active && !incoming.locally_paused);
        incoming.apply_peer_control(0, false, resumed + Duration::from_secs(2));
        assert!(incoming.active && !incoming.locally_paused);
    }

    #[test]
    fn outgoing_offer_waits_for_remote_acceptance_without_reoffering() {
        let offered_at = Instant::now();
        let mut offer = outgoing_file_fixture(true, false);
        offer.phase = OutgoingFilePhase::WaitingForAcceptance;
        offer.last_activity_at = offered_at;
        for elapsed in [120, 300, 600, 86_400] {
            assert!(!outgoing_transfer_timed_out_at(
                &offer,
                offered_at + Duration::from_secs(elapsed)
            ));
        }
        // The sender's own pause/resume is not the recipient's acceptance.
        offer.active = false;
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            offered_at + Duration::from_secs(86_400)
        ));
        offer.active = true;
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            offered_at + Duration::from_secs(86_400)
        ));
        assert_eq!(offer.retry_count, 1);
        assert_eq!(offer.message_id.as_deref(), Some("outgoing-message"));
    }

    #[test]
    fn accepted_outgoing_offer_uses_initial_and_progress_idle_deadlines() {
        let accepted_at = Instant::now();
        let mut offer = outgoing_file_fixture(true, false);
        offer.phase = OutgoingFilePhase::WaitingForAcceptance;
        offer.last_activity_at = accepted_at - Duration::from_secs(86_400);
        // Production calls this on the peer RESUME or first chunk request.
        offer.note_peer_activity(accepted_at);
        assert_eq!(offer.phase, OutgoingFilePhase::Transferring);
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            accepted_at + Duration::from_secs(120) - Duration::from_nanos(1)
        ));
        assert!(outgoing_transfer_timed_out_at(
            &offer,
            accepted_at + Duration::from_secs(120)
        ));
        offer.meter.last_transferred = 1;
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            accepted_at + Duration::from_secs(300) - Duration::from_nanos(1)
        ));
        assert!(outgoing_transfer_timed_out_at(
            &offer,
            accepted_at + Duration::from_secs(300)
        ));
        offer.active = false;
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            accepted_at + Duration::from_secs(600)
        ));
        offer.active = true;
        offer.note_peer_activity(accepted_at + Duration::from_secs(600));
        assert!(!outgoing_transfer_timed_out_at(
            &offer,
            accepted_at + Duration::from_secs(600)
        ));
    }

    #[test]
    fn disconnected_offer_preserves_exact_friend_recovery_and_pause_state() {
        let offered_at = Instant::now();
        let mut first = outgoing_file_fixture(true, false);
        first.phase = OutgoingFilePhase::WaitingForAcceptance;
        first.last_activity_at = offered_at;
        let mut other = first.clone();
        other.message_id = Some("other-message".to_string());
        let mut paused = first.clone();
        paused.active = false;
        let files = Arc::new(Mutex::new(HashMap::from([
            ((7, 0), first),
            ((8, 0), other),
            ((7, 1), paused),
        ])));
        note_outgoing_transport_loss(&files, Some(7));
        {
            let files = files.lock().unwrap();
            assert_eq!(files[&(7, 0)].phase, OutgoingFilePhase::TransportLost);
            assert_eq!(
                files[&(8, 0)].phase,
                OutgoingFilePhase::WaitingForAcceptance
            );
            // The production watchdog additionally requires the friend online
            // before it cancels/requeues; this checks its elapsed predicate.
            assert!(outgoing_transfer_timed_out_at(
                &files[&(7, 0)],
                offered_at + Duration::from_secs(120)
            ));
            assert!(!outgoing_transfer_timed_out_at(
                &files[&(8, 0)],
                offered_at + Duration::from_secs(600)
            ));
            assert!(!outgoing_transfer_timed_out_at(
                &files[&(7, 1)],
                offered_at + Duration::from_secs(600)
            ));
            assert_eq!(files[&(7, 0)].retry_count, 1);
            assert_eq!(
                files[&(7, 0)].message_id.as_deref(),
                Some("outgoing-message")
            );
        }
        // An owned Tox handle replacement invalidates every old stream.
        note_outgoing_transport_loss(&files, None);
        let files = files.lock().unwrap();
        assert!(files
            .values()
            .all(|file| file.phase == OutgoingFilePhase::TransportLost));
        assert!(!files[&(7, 1)].active);
    }

    #[test]
    fn outgoing_confirmation_and_avatar_timeouts_remain_bounded() {
        let sent_at = Instant::now();
        let mut complete = outgoing_file_fixture(true, true);
        complete.phase = OutgoingFilePhase::TransportLost;
        complete.last_activity_at = sent_at;
        complete.meter.last_transferred = complete.size;
        assert!(!outgoing_transfer_timed_out_at(
            &complete,
            sent_at + Duration::from_secs(120) - Duration::from_nanos(1)
        ));
        assert!(outgoing_transfer_timed_out_at(
            &complete,
            sent_at + Duration::from_secs(120)
        ));
        // Avatars have no user file-consent UI and keep the existing deadline.
        let mut avatar = outgoing_file_fixture(true, false);
        avatar.message_id = None;
        avatar.last_activity_at = sent_at;
        assert!(outgoing_transfer_timed_out_at(
            &avatar,
            sent_at + Duration::from_secs(120)
        ));
    }

    #[test]
    fn cancelling_one_direction_does_not_remove_same_number_opposite_transfer() {
        let key = (9, 4);
        let outgoing = Arc::new(Mutex::new(HashMap::from([(
            key,
            outgoing_file_fixture(true, false),
        )])));
        let incoming = Arc::new(Mutex::new(HashMap::from([(
            key,
            incoming_file_fixture(1, true, false),
        )])));

        assert!(remove_file_transfer_for_direction(&outgoing, &incoming, key, true).is_none());
        assert!(outgoing.lock().unwrap().is_empty());
        assert!(incoming.lock().unwrap().contains_key(&key));

        let removed = remove_file_transfer_for_direction(&outgoing, &incoming, key, false);
        assert!(removed.is_some());
        assert!(incoming.lock().unwrap().is_empty());
    }

    #[test]
    fn same_name_desktop_files_get_distinct_cache_paths_and_retry_metadata_is_stable() {
        let root = std::path::Path::new("outgoing-files");
        let first = outgoing_file_cache_path(root, "7-100", "recording.aup3");
        let second = outgoing_file_cache_path(root, "7-101", "recording.aup3");
        assert_ne!(first, second);
        assert_eq!(first.file_name().unwrap(), "out-7-100-recording.aup3");

        let transfer = outgoing_file_fixture(true, false);
        let retry = pending_file_retry(
            &transfer,
            "message".to_string(),
            7,
            "PUBLIC-KEY".to_string(),
        );
        assert_eq!(retry.filename, "payload.bin");
        assert_eq!(retry.mime, "application/x-test");
        assert_eq!(retry.retry_count, 2);
    }

    #[test]
    fn portable_paths_stay_beside_the_executable() {
        let root = temporary_root("portable-paths");
        let paths = PortablePaths::from_root(root.clone()).unwrap();
        assert_eq!(paths.downloads_dir, root.join("downloads"));
        assert_eq!(
            portable_webview_data_dir(&paths),
            root.join("data/webview2")
        );
        assert!(paths.data_dir.is_dir());
        assert!(paths.downloads_dir.is_dir());
        assert!(paths.logs_dir.is_dir());
        assert!(!paths.data_dir.join("avatars").exists());
        assert!(!paths.data_dir.join("outgoing-files").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn offline_message_queue_waits_for_reconnected_receipt_path() {
        let ready_at = Mutex::new(HashMap::new());
        let connected_at = Instant::now();

        assert!(!friend_message_connection_is_settled(
            &ready_at,
            7,
            connected_at
        ));
        note_friend_message_connection(&ready_at, 7, 1, connected_at);
        assert!(!friend_message_connection_is_settled(
            &ready_at,
            7,
            connected_at + FRIEND_MESSAGE_CONNECTION_SETTLE - Duration::from_millis(1)
        ));
        assert!(friend_message_connection_is_settled(
            &ready_at,
            7,
            connected_at + FRIEND_MESSAGE_CONNECTION_SETTLE
        ));

        note_friend_message_connection(
            &ready_at,
            7,
            0,
            connected_at + FRIEND_MESSAGE_CONNECTION_SETTLE,
        );
        assert!(!friend_message_connection_is_settled(
            &ready_at,
            7,
            connected_at + FRIEND_MESSAGE_CONNECTION_SETTLE + Duration::from_secs(1)
        ));

        let reconnected_at = connected_at + Duration::from_secs(2);
        note_friend_message_connection(&ready_at, 7, 2, reconnected_at);
        assert!(!friend_message_connection_is_settled(
            &ready_at,
            7,
            reconnected_at + FRIEND_MESSAGE_CONNECTION_SETTLE - Duration::from_millis(1)
        ));
    }

    #[test]
    fn linux_dmabuf_workaround_preserves_every_explicit_value() {
        assert!(should_default_linux_dmabuf_renderer(None));
        assert!(!should_default_linux_dmabuf_renderer(Some(
            std::ffi::OsStr::new("0")
        )));
        assert!(!should_default_linux_dmabuf_renderer(Some(
            std::ffi::OsStr::new("1")
        )));
    }

    #[test]
    fn webview2_runtime_path_budget_rejects_the_legacy_limit() {
        assert!(webview2_runtime_paths_fit(200, 58));
        assert!(!webview2_runtime_paths_fit(200, 59));
        assert!(!webview2_runtime_paths_fit(usize::MAX, 1));
        assert_eq!(WEBVIEW2_RUNTIME_PATH_LIMIT_UTF16_UNITS, 260);
    }

    #[test]
    fn webview2_runtime_path_marker_is_strictly_numeric() {
        assert_eq!(
            parse_webview2_runtime_max_relative_path("42\r\n").unwrap(),
            42
        );
        assert!(parse_webview2_runtime_max_relative_path("").is_err());
        assert!(parse_webview2_runtime_max_relative_path("42 files").is_err());
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
    fn own_status_message_accepts_empty_after_sanitizing_and_trimming() {
        assert_eq!(normalize_status_message(""), "");
        assert_eq!(normalize_status_message(" \t\r\n "), "");
        assert_eq!(normalize_status_message("  Ready\0 now  "), "Ready now");
    }

    #[test]
    fn untrusted_file_names_cannot_carry_markup_paths_or_control_bytes() {
        assert_eq!(safe_file_name("../<script>alert.js\0"), "scriptalert.js");
        assert_eq!(safe_file_name("<>:\"/\\|?*\0"), "file");
    }

    #[test]
    fn native_avatar_reader_accepts_images_and_rejects_invalid_or_oversized_files() {
        let root = temporary_root("native-avatar-reader");
        fs::create_dir_all(&root).unwrap();
        let png = root.join("avatar.png");
        fs::write(&png, [137, 80, 78, 71, 13, 10, 26, 10]).unwrap();
        assert!(avatar_data_url_from_path(&png)
            .unwrap()
            .starts_with("data:image/png;base64,"));

        let invalid = root.join("invalid.png");
        fs::write(&invalid, b"not-an-image").unwrap();
        assert!(avatar_data_url_from_path(&invalid).is_err());

        let oversized = root.join("oversized.png");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_PROFILE_AVATAR_BYTES + 1)
            .unwrap();
        assert!(avatar_data_url_from_path(&oversized).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transfer_chunks_are_bounded_for_disk_and_buffered_kai_targets() {
        let root = temporary_root("bounded-transfer-chunks");
        fs::create_dir_all(&root).unwrap();
        let disk = root.join("received.bin");
        fs::write(&disk, []).unwrap();
        write_transfer_chunk(&disk, None, 6, 3, b"def").unwrap();
        write_transfer_chunk(&disk, None, 6, 0, b"abc").unwrap();
        assert_eq!(fs::read(&disk).unwrap(), b"abcdef");
        assert!(write_transfer_chunk(&disk, None, 6, 6, b"x").is_err());

        let buffered = Arc::new(Mutex::new(Vec::new()));
        write_transfer_chunk(&disk, Some(&buffered), 6, 3, b"def").unwrap();
        write_transfer_chunk(&disk, Some(&buffered), 6, 0, b"abc").unwrap();
        assert_eq!(&*buffered.lock().unwrap(), b"abcdef");
        assert!(write_transfer_chunk(&disk, Some(&buffered), 6, 5, b"xy").is_err());
        fs::remove_dir_all(root).unwrap();
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
            friend_number: Some(7),
            pending_authorization: true,
            authorization_message: "Please add me".to_string(),
            authorization_last_refreshed_at: 123,
            ..CachedFriendProfile::default()
        };
        let encoded = serde_json::to_vec(&profile).unwrap();
        let restored: CachedFriendProfile = serde_json::from_slice(&encoded).unwrap();
        assert!(restored.authorized);
        assert_eq!(restored.name, "Alice");
        assert_eq!(restored.friend_number, Some(7));
        assert!(restored.pending_authorization);
        assert_eq!(restored.authorization_last_refreshed_at, 123);
    }

    #[test]
    fn contact_history_uses_public_key_when_friend_number_changes() {
        let stable = ToxMessage {
            id: "stable".to_string(),
            friend_number: 7,
            friend_public_key: "ALICE".to_string(),
            text: "hello".to_string(),
            mine: false,
            timestamp: 1,
            delivery: "delivered".to_string(),
            delivered_at: None,
            attachment: None,
            event: None,
            protocol_version: None,
            operation_id: None,
            quote: None,
            formatting: Vec::new(),
            pq_protected: false,
            reactions: None,
        };
        assert!(message_matches_friend(&stable, 99, "ALICE"));
        assert!(!message_matches_friend(&stable, 7, "BOB"));

        let legacy = ToxMessage {
            friend_public_key: String::new(),
            ..stable
        };
        assert!(message_matches_friend(&legacy, 7, "ALICE"));
        assert!(!message_matches_friend(&legacy, 99, "ALICE"));
    }

    #[test]
    fn chat_snapshot_clones_only_the_bounded_tail() {
        let messages = (0..700)
            .map(|index| ToxMessage {
                id: format!("message-{index}"),
                friend_number: 7,
                friend_public_key: "ALICE".to_string(),
                text: format!("message {index}"),
                mine: index % 2 == 0,
                timestamp: index,
                delivery: "delivered".to_string(),
                delivered_at: None,
                attachment: None,
                event: None,
                protocol_version: None,
                operation_id: None,
                quote: None,
                formatting: Vec::new(),
                pq_protected: false,
                reactions: None,
            })
            .collect::<Vec<_>>();
        let default = friend_message_snapshot(&messages, 7, "ALICE", None);
        assert_eq!(default.len(), 500);
        assert_eq!(default.first().unwrap().id, "message-200");
        assert_eq!(default.last().unwrap().id, "message-699");
        let notification_tail = friend_message_snapshot(&messages, 7, "ALICE", Some(32));
        assert_eq!(notification_tail.len(), 32);
        assert_eq!(notification_tail.first().unwrap().id, "message-668");
    }

    #[test]
    fn disk_attachment_hashing_is_streamed_without_a_plaintext_cache() {
        let root = temporary_root("streamed-file-hash");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("attachment.bin");
        let bytes = vec![0x5a; 2 * 1024 * 1024 + 17];
        fs::write(&path, &bytes).unwrap();
        let (actual, cache) = prepare_outgoing_source(&path, bytes.len() as u64).unwrap();
        let mut expected = [0_u8; 32];
        unsafe {
            super::tox_hash(expected.as_mut_ptr(), bytes.as_ptr(), bytes.len());
        }
        assert_eq!(actual, expected);
        assert!(cache.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imported_savedata_exposes_the_same_stable_profile_identity() {
        let path = temporary_root("savedata-public-key").join("identity.tox");
        let handle =
            create_tox_handle(path, None, None, &NetworkSettings::default(), None).unwrap();
        let mut address = [0_u8; 38];
        unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
        let size = unsafe { tox_get_savedata_size(handle.instance.as_ptr()) };
        let mut savedata = vec![0_u8; size];
        unsafe { tox_get_savedata(handle.instance.as_ptr(), savedata.as_mut_ptr()) };
        assert_eq!(
            tox_savedata_public_key(&savedata).unwrap(),
            hex_upper(&address[..32])
        );
        unsafe { tox_kill(handle.instance.as_ptr()) };
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn disposable_qtox_sqlcipher_fixture_rejects_wrong_password_and_imports_with_correct_password()
    {
        let requested_output =
            std::env::var_os("KAIGEN_QTOX_FIXTURE_OUTPUT").map(std::path::PathBuf::from);
        let root = requested_output
            .clone()
            .unwrap_or_else(|| temporary_root("disposable-qtox-sqlcipher"));
        assert!(
            !root.exists(),
            "the disposable qTox output must not exist yet"
        );
        fs::create_dir_all(&root).unwrap();
        let password = "Kaigen disposable qTox 2026";
        let profile_path = root.join("Disposable.tox");
        let history_path = root.join("Disposable.db");
        let profile = create_tox_handle(
            profile_path.clone(),
            None,
            None,
            &NetworkSettings::default(),
            None,
        )
        .unwrap();
        let peer = create_tox_handle(
            root.join("peer.tox"),
            None,
            None,
            &NetworkSettings::default(),
            None,
        )
        .unwrap();
        let mut self_address = [0_u8; 38];
        let mut peer_address = [0_u8; 38];
        unsafe {
            tox_self_get_address(profile.instance.as_ptr(), self_address.as_mut_ptr());
            tox_self_get_address(peer.instance.as_ptr(), peer_address.as_mut_ptr());
        }
        let mut self_public_key = [0_u8; 32];
        let mut peer_public_key = [0_u8; 32];
        self_public_key.copy_from_slice(&self_address[..32]);
        peer_public_key.copy_from_slice(&peer_address[..32]);
        let mut friend_error = 0_i32;
        let friend_number = unsafe {
            tox_friend_add_norequest(
                profile.instance.as_ptr(),
                peer_public_key.as_ptr(),
                &mut friend_error,
            )
        };
        assert_eq!(friend_error, 0);
        assert_eq!(friend_number, 0);
        let savedata_size = unsafe { tox_get_savedata_size(profile.instance.as_ptr()) };
        let mut savedata = vec![0_u8; savedata_size];
        unsafe { tox_get_savedata(profile.instance.as_ptr(), savedata.as_mut_ptr()) };
        let encrypted = profiles::ProfileCipher::new(password)
            .unwrap()
            .encrypt(&savedata)
            .unwrap();
        fs::write(&profile_path, encrypted).unwrap();
        fs::write(
            root.join("Disposable.ini"),
            b"[General]\nname=Disposable Kaigen qTox fixture\n\n[Proxy]\nproxyType=1\nproxyAddr=127.0.0.1\nproxyPort=1\n",
        )
        .unwrap();
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let sqlcipher_path = project_root.join("runtime/qtox-import/libsqlcipher-0.dll");
        qtox_history::write_disposable_qtox_database(
            &history_path,
            &sqlcipher_path,
            password,
            &self_public_key,
            &peer_public_key,
        )
        .unwrap();
        let wrong_profile_password =
            match profiles::read_profile(&profile_path, Some("wrong password")) {
                Ok(_) => panic!("the disposable qTox profile opened with the wrong password"),
                Err(error) => error,
            };
        assert_eq!(wrong_profile_password, "PROFILE_PASSWORD_INVALID");
        let (decrypted, _) = profiles::read_profile(&profile_path, Some(password)).unwrap();
        assert_eq!(
            tox_savedata_public_key(&decrypted).unwrap(),
            hex_upper(&self_public_key)
        );
        assert!(qtox_history::read_qtox_history(
            &history_path,
            project_root,
            Some("wrong password"),
            &self_public_key,
        )
        .is_err());
        let rows = qtox_history::read_qtox_history(
            &history_path,
            project_root,
            Some(password),
            &self_public_key,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_id, 42);
        assert_eq!(rows[0].chat_key, peer_public_key);
        assert_eq!(rows[0].sender_key, self_public_key);
        assert_eq!(rows[0].text, "disposable qTox SQLCipher history");
        unsafe {
            tox_kill(peer.instance.as_ptr());
            tox_kill(profile.instance.as_ptr());
        }
        if requested_output.is_none() {
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn avatar_number_swap_is_staged_without_contact_replacement() {
        let directory = temporary_root("avatar-friend-number-swap");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("0-avatar.png"), b"alice").unwrap();
        fs::write(directory.join("1-avatar.png"), b"bob").unwrap();
        reconcile_friend_avatar_files(
            &directory,
            &HashMap::from([("ALICE".to_string(), 0), ("BOB".to_string(), 1)]),
            &HashMap::from([("ALICE".to_string(), 1), ("BOB".to_string(), 0)]),
        );
        assert_eq!(fs::read(directory.join("1-avatar.png")).unwrap(), b"alice");
        assert_eq!(fs::read(directory.join("0-avatar.png")).unwrap(), b"bob");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unchanged_friend_numbers_do_not_touch_avatar_files() {
        let mapping = HashMap::from([("ALICE".to_string(), 0), ("BOB".to_string(), 1)]);
        assert!(affected_friend_avatar_numbers(&mapping, &mapping).is_empty());
    }

    #[test]
    fn avatar_of_missing_owner_is_quarantined_before_number_reuse() {
        let directory = temporary_root("avatar-missing-owner");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("0-avatar.png"), b"alice").unwrap();
        fs::write(directory.join("1-avatar.png"), b"bob").unwrap();
        reconcile_friend_avatar_files(
            &directory,
            &HashMap::from([("ALICE".to_string(), 0), ("BOB".to_string(), 1)]),
            &HashMap::from([("ALICE".to_string(), 1)]),
        );
        assert_eq!(fs::read(directory.join("1-avatar.png")).unwrap(), b"alice");
        assert!(!directory.join("0-avatar.png").exists());
        let orphaned = fs::read_dir(directory.join(".kaigen-avatar-orphans"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| fs::read(entry.path()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(orphaned, vec![b"bob".to_vec()]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn offline_friend_request_retry_is_capped_at_sixty_seconds_in_every_build() {
        let patch = include_str!("../../patches/c-toxcore/friend-request-retry-cap.patch");
        let windows = include_str!("../../scripts/prepare-dependencies.ps1");
        let unix = include_str!("../../scripts/prepare-unix-dependencies.sh");
        for source in [patch, windows, unix] {
            assert!(source.contains("FRIENDREQUEST_TIMEOUT_MAX 60"));
            assert!(source.contains("friendrequest_timeout * 2"));
        }
    }

    #[test]
    fn pq_history_card_keeps_one_entry_and_reaches_terminal_state() {
        let messages = Arc::new(Mutex::new(Vec::<ToxMessage>::new()));
        let offered = PqStatus {
            identity_needs_entropy: false,
            identity_waiting: false,
            auto_pending: false,
            protocol_version: 2,
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
    fn new_install_network_and_file_receive_defaults_match_product_policy() {
        assert_eq!(
            NetworkSettings::default(),
            NetworkSettings {
                udp_enabled: true,
                ipv6_enabled: true,
                local_discovery_enabled: true,
            }
        );
        assert_eq!(
            serde_json::from_value::<NetworkSettings>(serde_json::json!({})).unwrap(),
            NetworkSettings::default(),
            "partial or migrated settings must receive the new-install field defaults"
        );
        let file = FileReceiveSettings::default();
        assert!(!file.deny_all);
        assert!(file.auto_accept_images);
        assert!(file.show_images);
        assert!(file.auto_accept_any);
        assert_eq!(file.max_auto_bytes, 24 * 1024 * 1024);
        assert_eq!(file.max_concurrent, 2);
    }

    #[test]
    fn tray_unread_digit_is_large_but_scaled_to_eighty_five_percent() {
        let base = tray_base_image();
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
    fn tray_base_has_a_visible_shape_on_a_transparent_background() {
        let base = tray_base_image();
        let pixels = base.rgba().chunks_exact(4).collect::<Vec<_>>();
        assert!(pixels.iter().any(|pixel| pixel[3] == 0));
        assert!(pixels.iter().any(|pixel| pixel[3] == 255));
        assert!(pixels.iter().filter(|pixel| pixel[3] == 0).count() > pixels.len() / 2);
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
        let retained_object = "browser-stream://retained-object-id";
        assert_eq!(
            rebase_portable_file(retained_object, &portable_downloads),
            retained_object
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
    fn avatar_update_arguments_are_coherent_for_set_and_nullable_clear() {
        assert!(matches!(
            validate_profile_avatar_update(
                Some("data:image/png;base64,AA==".to_string()),
                Some("avatar.png".to_string()),
                Some(vec![1]),
            )
            .unwrap(),
            ProfileAvatarUpdate::Set { .. }
        ));
        assert!(matches!(
            validate_profile_avatar_update(None, None, None).unwrap(),
            ProfileAvatarUpdate::Clear
        ));
        assert_eq!(
            validate_profile_avatar_update(None, Some("avatar.png".to_string()), Some(vec![1]),)
                .err()
                .unwrap(),
            "PROFILE_AVATAR_ARGUMENTS_INVALID"
        );
        assert_eq!(
            validate_profile_avatar_update(
                Some("data:text/plain;base64,AA==".to_string()),
                Some("avatar.png".to_string()),
                Some(vec![1]),
            )
            .err()
            .unwrap(),
            "PROFILE_AVATAR_INVALID"
        );
        assert_eq!(
            validate_profile_avatar_update(
                Some("data:image/png;base64,".to_string()),
                Some("avatar.png".to_string()),
                Some(Vec::new()),
            )
            .err()
            .unwrap(),
            "PROFILE_AVATAR_SIZE_INVALID"
        );
    }

    #[test]
    fn explicit_profile_local_state_target_survives_active_switch_and_restart() {
        let root = temporary_root("profile-local-state-identity");
        let alpha_path = root.join("alpha/local-state.json");
        let beta_path = root.join("beta/local-state.json");
        write_profile_local_state(
            &alpha_path,
            &serde_json::json!({ "profileAvatar": "data:image/png;base64,ALPHA-OLD" }),
        )
        .unwrap();
        write_profile_local_state(
            &beta_path,
            &serde_json::json!({ "profileAvatar": "data:image/png;base64,BETA" }),
        )
        .unwrap();
        let loaded = Mutex::new(HashMap::from([
            ("alpha".to_string(), alpha_path.clone()),
            ("beta".to_string(), beta_path.clone()),
        ]));
        assert_eq!(
            exact_loaded_profile(&loaded, "missing").err().unwrap(),
            "PROFILE_NOT_LOADED"
        );

        let active = Arc::new(Mutex::new("alpha".to_string()));
        let barrier = Arc::new(Barrier::new(2));
        let switched_active = Arc::clone(&active);
        let switched_barrier = Arc::clone(&barrier);
        let switch = thread::spawn(move || {
            switched_barrier.wait();
            *switched_active.lock().unwrap() = "beta".to_string();
        });
        let captured_alpha_path = exact_loaded_profile(&loaded, "alpha").unwrap();
        barrier.wait();
        switch.join().unwrap();
        write_profile_local_state(
            &captured_alpha_path,
            &serde_json::json!({ "profileAvatar": "data:image/png;base64,ALPHA-NEW" }),
        )
        .unwrap();

        assert_eq!(active.lock().unwrap().as_str(), "beta");
        assert_eq!(
            read_profile_local_state(&alpha_path)
                .unwrap()
                .unwrap()
                .get("profileAvatar")
                .and_then(serde_json::Value::as_str),
            Some("data:image/png;base64,ALPHA-NEW")
        );
        assert_eq!(
            read_profile_local_state(&beta_path)
                .unwrap()
                .unwrap()
                .get("profileAvatar")
                .and_then(serde_json::Value::as_str),
            Some("data:image/png;base64,BETA")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ordinary_local_state_save_preserves_dedicated_avatar_identity() {
        let root = temporary_root("profile-local-state-avatar-owner");
        let path = root.join("local-state.json");
        let avatars_dir = root.join("avatars");
        let local_state_lock = Mutex::new(());
        fs::create_dir_all(&avatars_dir).unwrap();
        let avatar_path = avatars_dir.join("self-avatar.png");
        fs::write(&avatar_path, b"\x89PNG\r\n\x1a\nauthoritative-avatar").unwrap();
        let avatar = avatar_data_url_from_path(&avatar_path).unwrap();
        write_profile_local_state(
            &path,
            &serde_json::json!({
                "profileAvatar": "data:image/png;base64,CORRUPT",
                "obsoleteSetting": true,
            }),
        )
        .unwrap();

        write_profile_local_state_preserving_avatar(
            &local_state_lock,
            &path,
            &avatars_dir,
            &serde_json::json!({
                "profileAvatar": "data:image/png;base64,STALE-CALLER",
                "sendOnEnter": false,
            }),
        )
        .unwrap();
        let restarted = read_profile_local_state(&path).unwrap().unwrap();
        assert_eq!(
            restarted.get("profileAvatar").and_then(Value::as_str),
            Some(avatar.as_str())
        );
        assert_eq!(
            restarted.get("sendOnEnter").and_then(Value::as_bool),
            Some(false)
        );
        assert!(restarted.get("obsoleteSetting").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_avatar_write_cannot_be_overwritten_by_inflight_ordinary_save() {
        let root = temporary_root("profile-local-state-avatar-race");
        let path = root.join("local-state.json");
        let avatars_dir = root.join("avatars");
        let avatar_path = avatars_dir.join("self-avatar.png");
        let local_state_lock = Arc::new(Mutex::new(()));
        fs::create_dir_all(&avatars_dir).unwrap();
        fs::write(&avatar_path, b"\x89PNG\r\n\x1a\nold-avatar").unwrap();
        write_profile_local_state(
            &path,
            &serde_json::json!({ "profileAvatar": "data:image/png;base64,OLD" }),
        )
        .unwrap();

        let ordinary_read = Arc::new(Barrier::new(2));
        let allow_ordinary_write = Arc::new(Barrier::new(2));
        let ordinary_lock = Arc::clone(&local_state_lock);
        let ordinary_path = path.clone();
        let ordinary_avatars = avatars_dir.clone();
        let ordinary_read_worker = Arc::clone(&ordinary_read);
        let ordinary_write_worker = Arc::clone(&allow_ordinary_write);
        let ordinary = thread::spawn(move || {
            write_profile_local_state_transaction(&ordinary_lock, &ordinary_path, |_| {
                let captured_avatar =
                    preferred_profile_avatar_from_directory(Some(&ordinary_avatars), None);
                ordinary_read_worker.wait();
                ordinary_write_worker.wait();
                profile_local_state_preserving_avatar(
                    &serde_json::json!({ "sendOnEnter": false }),
                    captured_avatar.as_deref(),
                )
            })
        });

        ordinary_read.wait();
        let setter_persisted = Arc::new(Barrier::new(2));
        let setter_lock = Arc::clone(&local_state_lock);
        let setter_path = path.clone();
        let setter_avatar_path = avatar_path.clone();
        let setter_persisted_worker = Arc::clone(&setter_persisted);
        let setter = thread::spawn(move || {
            profiles::write_file(&setter_avatar_path, b"\x89PNG\r\n\x1a\nnew-avatar")?;
            let data_url = avatar_data_url_from_path(&setter_avatar_path)?;
            setter_persisted_worker.wait();
            write_profile_avatar_local_state(&setter_lock, &setter_path, Some(&data_url))?;
            Ok::<String, String>(data_url)
        });
        setter_persisted.wait();
        allow_ordinary_write.wait();
        ordinary.join().unwrap().unwrap();
        let expected_avatar = setter.join().unwrap().unwrap();

        let persisted = read_profile_local_state(&path).unwrap().unwrap();
        assert_eq!(
            persisted.get("profileAvatar").and_then(Value::as_str),
            Some(expected_avatar.as_str())
        );
        assert_eq!(
            persisted.get("sendOnEnter").and_then(Value::as_bool),
            Some(false)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authoritative_self_avatar_repairs_mismatched_local_state_and_clear_is_exact() {
        let root = temporary_root("profile-avatar-authority");
        let avatars_dir = root.join("avatars");
        let local_state_path = root.join("local-state.json");
        let local_state_lock = Mutex::new(());
        fs::create_dir_all(&avatars_dir).unwrap();
        let avatar_path = avatars_dir.join("self-avatar.png");
        fs::write(&avatar_path, [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]).unwrap();
        let stale = "data:image/png;base64,WRONG-PROFILE";
        write_profile_local_state(
            &local_state_path,
            &serde_json::json!({ "profileAvatar": stale, "profileName": "Alpha" }),
        )
        .unwrap();

        let authoritative = avatar_data_url_from_path(&avatar_path).unwrap();
        assert_eq!(
            preferred_profile_avatar_from_directory(
                Some(&avatars_dir),
                read_profile_local_state(&local_state_path)
                    .unwrap()
                    .as_ref(),
            )
            .as_deref(),
            Some(authoritative.as_str())
        );
        assert_ne!(authoritative, stale);
        write_profile_local_state_preserving_avatar(
            &local_state_lock,
            &local_state_path,
            &avatars_dir,
            &serde_json::json!({ "profileName": "Alpha" }),
        )
        .unwrap();
        assert_eq!(
            read_profile_local_state(&local_state_path)
                .unwrap()
                .unwrap()
                .get("profileAvatar")
                .and_then(Value::as_str),
            Some(authoritative.as_str())
        );

        let loaded_without_avatar = root.join("loaded-without-avatar");
        fs::create_dir_all(&loaded_without_avatar).unwrap();
        let stale_local_state = serde_json::json!({ "profileAvatar": stale });
        assert!(preferred_profile_avatar_from_directory(
            Some(&loaded_without_avatar),
            Some(&stale_local_state),
        )
        .is_none());
        assert_eq!(
            preferred_profile_avatar_from_directory(None, Some(&stale_local_state)).as_deref(),
            Some(stale)
        );

        write_profile_avatar_local_state(&local_state_lock, &local_state_path, None).unwrap();
        remove_self_avatar_files(&avatars_dir).unwrap();
        let restarted = read_profile_local_state(&local_state_path)
            .unwrap()
            .unwrap();
        assert!(restarted.get("profileAvatar").is_some_and(Value::is_null));
        assert_eq!(
            restarted.get("profileName").and_then(Value::as_str),
            Some("Alpha")
        );
        assert!(
            preferred_profile_avatar_from_directory(Some(&avatars_dir), Some(&restarted)).is_none()
        );
        fs::remove_dir_all(root).unwrap();
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
        // Queue both delayed persistence paths immediately before destruction.
        // The directory must remain absent even after their batching windows.
        persist_tox_history(
            &profile.messages,
            &profile.history_path,
            &profile.history_enabled,
        );
        persist_unread_state(&profile.unread_state, &profile.unread_state_path);
        profile.stop_without_save().unwrap();
        fs::remove_dir_all(&profile_dir).unwrap();
        drop(profile);
        thread::sleep(Duration::from_millis(500));

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

enum ProfileAvatarUpdate {
    Set {
        data_url: String,
        filename: String,
        bytes: Vec<u8>,
    },
    Clear,
}

fn validate_profile_avatar_update(
    data_url: Option<String>,
    filename: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<ProfileAvatarUpdate, String> {
    match (data_url, filename, bytes) {
        (Some(data_url), Some(filename), Some(bytes)) => {
            if !data_url.starts_with("data:image/")
                || data_url.len() > MAX_PROFILE_AVATAR_BYTES as usize
            {
                return Err("PROFILE_AVATAR_INVALID".to_string());
            }
            if bytes.is_empty() || bytes.len() > 64 * 1024 {
                return Err("PROFILE_AVATAR_SIZE_INVALID".to_string());
            }
            Ok(ProfileAvatarUpdate::Set {
                data_url,
                filename,
                bytes,
            })
        }
        (None, None, None) => Ok(ProfileAvatarUpdate::Clear),
        _ => Err("PROFILE_AVATAR_ARGUMENTS_INVALID".to_string()),
    }
}

fn profile_local_state_path(tox_state: &ToxState) -> Result<PathBuf, String> {
    tox_state
        .history_path
        .parent()
        .map(|directory| directory.join("local-state.json"))
        .ok_or_else(|| "PROFILE_DATA_DIRECTORY_INVALID".to_string())
}

fn read_profile_local_state(path: &Path) -> Result<Option<Value>, String> {
    if !profiles::file_exists(path) {
        return Ok(None);
    }
    let contents = profiles::read_text(path)
        .map_err(|error| format!("Could not read profile local state: {error}"))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("PROFILE_LOCAL_STATE_INVALID: {error}"))
}

fn write_profile_local_state(path: &Path, state: &Value) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Could not encode profile local state: {error}"))?;
    profiles::write_file(path, &serialized)
        .map_err(|error| format!("Could not save profile local state: {error}"))
}

fn profile_local_state_preserving_avatar(
    state: &Value,
    authoritative_avatar: Option<&str>,
) -> Result<Value, String> {
    let mut next = state
        .as_object()
        .cloned()
        .ok_or_else(|| "PROFILE_LOCAL_STATE_INVALID".to_string())?;
    next.insert(
        "profileAvatar".to_string(),
        authoritative_avatar.map_or(Value::Null, |value| Value::String(value.to_string())),
    );
    Ok(Value::Object(next))
}

fn write_profile_local_state_transaction<F>(
    local_state_lock: &Mutex<()>,
    path: &Path,
    update: F,
) -> Result<(), String>
where
    F: FnOnce(Option<&Value>) -> Result<Value, String>,
{
    let _guard = local_state_lock
        .lock()
        .map_err(|_| "PROFILE_LOCAL_STATE_UNAVAILABLE".to_string())?;
    let current = read_profile_local_state(path)?;
    let next = update(current.as_ref())?;
    write_profile_local_state(path, &next)
}

fn write_profile_local_state_preserving_avatar(
    local_state_lock: &Mutex<()>,
    path: &Path,
    avatars_dir: &Path,
    state: &Value,
) -> Result<(), String> {
    write_profile_local_state_transaction(local_state_lock, path, |_| {
        let authoritative_avatar = preferred_profile_avatar_from_directory(Some(avatars_dir), None);
        profile_local_state_preserving_avatar(state, authoritative_avatar.as_deref())
    })
}

fn write_profile_avatar_local_state(
    local_state_lock: &Mutex<()>,
    path: &Path,
    data_url: Option<&str>,
) -> Result<(), String> {
    write_profile_local_state_transaction(local_state_lock, path, |current| {
        let mut local_state = current
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        local_state
            .as_object_mut()
            .ok_or_else(|| "PROFILE_LOCAL_STATE_INVALID".to_string())?
            .insert(
                "profileAvatar".to_string(),
                data_url.map_or(Value::Null, |value| Value::String(value.to_string())),
            );
        Ok(local_state)
    })
}

fn remove_self_avatar_files(avatars_dir: &Path) -> Result<(), String> {
    if !profiles::directory_exists(avatars_dir) {
        return Ok(());
    }
    for entry in profiles::list(avatars_dir)? {
        if entry.is_file
            && entry
                .path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("self-"))
        {
            profiles::remove_file(&entry.path)?;
        }
    }
    Ok(())
}

fn send_tox_avatar_for_shared_state(
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
    profiles::write_file(&avatar_path, &bytes)
        .map_err(|error| format!("Не удалось сохранить аватар: {error}"))?;
    for entry in profiles::list(&tox_state.avatars_dir)? {
        if entry.is_file
            && entry.path != avatar_path
            && entry
                .path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("self-"))
        {
            profiles::remove_file(&entry.path)?;
        }
    }
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
            log_transfer(
                &tox_state.transfer_log_path,
                format!("AVATAR_SKIP_OFFLINE friend={friend_number} connection_error={connection_error}"),
            );
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
                filename: "avatar.png".to_string(),
                mime: "image/png".to_string(),
                size: bytes.len() as u64,
                source_bytes: Some(Arc::new(bytes.clone())),
                message_id: None,
                protocol_transfer_id: None,
                meter: TransferMeter::new(),
                last_activity_at: Instant::now(),
                active: true,
                locally_paused: false,
                phase: OutgoingFilePhase::Transferring,
                fully_sent: false,
                retry_count: 0,
                #[cfg(feature = "web-core")]
                web_transfer_id: None,
            },
        );
    }
    Ok(started.len())
}

fn send_tox_avatar_removal_for_shared_state(tox_state: &ToxState) -> Result<usize, String> {
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
    let empty_id = [0_u8; 32];
    let empty_name = b"";
    let mut started = 0;
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
            log_transfer(
                &tox_state.transfer_log_path,
                format!("AVATAR_REMOVE_SKIP_OFFLINE friend={friend_number} connection_error={connection_error}"),
            );
            continue;
        }
        let mut error = 0_i32;
        let number = unsafe {
            tox_file_send(
                instance.instance.as_ptr(),
                friend_number,
                1,
                0,
                empty_id.as_ptr(),
                empty_name.as_ptr(),
                0,
                &mut error,
            )
        };
        log_transfer(
            &tox_state.transfer_log_path,
            format!("AVATAR_REMOVE_SEND friend={friend_number} file={number} error={error}"),
        );
        if error == 0 {
            started += 1;
        }
    }
    ToxState::save(instance)?;
    Ok(started)
}

#[cfg(feature = "desktop")]
mod desktop_adapter {
    use super::*;

    #[cfg(unix)]
    static TERMINATION_SIGNAL: AtomicU8 = AtomicU8::new(0);

    #[cfg(unix)]
    extern "C" fn record_termination_signal(signal: libc::c_int) {
        let signal_code = if signal > 0 && signal <= u8::MAX as libc::c_int {
            signal as u8
        } else {
            1
        };
        if TERMINATION_SIGNAL
            .compare_exchange(0, signal_code, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            // A second termination request must still be able to stop a process
            // whose graceful checkpoint is blocked. _exit is async-signal-safe.
            unsafe { libc::_exit(128 + signal.max(1)) };
        }
    }

    #[cfg(unix)]
    fn install_termination_signal_bridge(app: tauri::AppHandle) -> Result<(), String> {
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = record_termination_signal as usize;
        action.sa_flags = libc::SA_RESTART;
        if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0 {
            return Err(format!(
                "Could not initialise the termination signal mask: {}",
                std::io::Error::last_os_error()
            ));
        }
        for signal in [libc::SIGTERM, libc::SIGINT] {
            if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
                return Err(format!(
                    "Could not register termination signal {signal}: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }

        thread::Builder::new()
            .name("kaigen-termination".to_string())
            .spawn(move || loop {
                if TERMINATION_SIGNAL.load(Ordering::Acquire) != 0 {
                    if let Some(state) = app.try_state::<AppState>() {
                        request_application_exit(&app, state.inner());
                    } else {
                        app.exit(0);
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            })
            .map_err(|error| format!("Could not start the termination signal bridge: {error}"))?;
        Ok(())
    }

    fn begin_owned_service_shutdown(shutdown_started: &AtomicBool) -> bool {
        shutdown_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    #[cfg(test)]
    mod shutdown_tests {
        use super::*;

        #[test]
        fn owned_service_shutdown_is_single_shot() {
            let shutdown_started = AtomicBool::new(false);
            assert!(begin_owned_service_shutdown(&shutdown_started));
            assert!(!begin_owned_service_shutdown(&shutdown_started));
        }
    }

    fn state_path(app_state: &AppState, profile_id: &str) -> Result<PathBuf, String> {
        profile_local_state_path(app_state.loaded_profile(profile_id)?.as_ref())
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

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct QtoxProfileExport {
        file_name: String,
        bytes: Vec<u8>,
    }

    fn import_source_key(value: &str) -> String {
        fs::canonicalize(value)
            .unwrap_or_else(|_| PathBuf::from(value))
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase()
    }

    #[tauri::command]
    async fn get_startup_state(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
    ) -> Result<StartupState, String> {
        let app_state = app_state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || get_startup_state_blocking(app, &app_state))
            .await
            .map_err(|error| format!("Startup state task stopped unexpectedly: {error}"))?
    }

    fn get_startup_state_blocking(
        app: tauri::AppHandle,
        app_state: &AppState,
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
    fn report_webview_heartbeat(app: tauri::AppHandle) {
        webview_recovery::heartbeat(&app);
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
    fn set_close_to_tray(
        app_state: tauri::State<'_, AppState>,
        enabled: bool,
    ) -> Result<bool, String> {
        app_state
            .settings
            .lock()
            .map_err(|_| "Could not access application settings".to_string())?
            .close_to_tray = enabled;
        app_state.save_settings()?;
        Ok(enabled)
    }

    #[tauri::command]
    fn exit_application(app: tauri::AppHandle, app_state: tauri::State<'_, AppState>) {
        request_application_exit(&app, app_state.inner());
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
        if let Ok(mut grants) = app_state.native_file_grants.lock() {
            grants.clear_for_profile(&profile_id);
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
        if let Ok(mut grants) = app_state.native_file_grants.lock() {
            grants.clear_all();
        }
        update_tray(&app, &app_state);
        app_state.summaries()
    }

    #[tauri::command]
    fn get_unread_state(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
    ) -> Result<UnreadStateView, String> {
        let profile = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        unread_state_view(&profile)
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
    async fn acknowledge_local_messages(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        message_ids: Vec<String>,
    ) -> Result<UnreadStateView, String> {
        let app_state = app_state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            acknowledge_local_messages_blocking(
                &app,
                &app_state,
                profile_id,
                friend_number,
                message_ids,
            )
        })
        .await
        .map_err(|error| {
            format!("Local message acknowledgement task stopped unexpectedly: {error}")
        })?
    }

    fn acknowledge_local_messages_blocking(
        app: &tauri::AppHandle,
        app_state: &AppState,
        profile_id: Option<String>,
        friend_number: u32,
        message_ids: Vec<String>,
    ) -> Result<UnreadStateView, String> {
        let profile = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        let public_key = profile.stable_friend_public_key(friend_number);
        let target = unread_target_key(friend_number, &public_key);
        let requested = message_ids.into_iter().collect::<HashSet<_>>();
        {
            let mut state = profile
                .unread_state
                .lock()
                .map_err(|_| "Could not access unread events".to_string())?;
            let removed = state
                .unseen_messages
                .get_mut(&target)
                .map(|ids| {
                    let before = ids.len();
                    ids.retain(|id| !requested.contains(id));
                    before.saturating_sub(ids.len())
                })
                .unwrap_or(0);
            if state
                .unseen_messages
                .get(&target)
                .is_some_and(Vec::is_empty)
            {
                state.unseen_messages.remove(&target);
            }
            if removed > 0 {
                let key = friend_number.to_string();
                if let Some(count) = state.friends.get_mut(&key) {
                    *count = count.saturating_sub(removed.min(u32::MAX as usize) as u32);
                    if *count == 0 {
                        state.friends.remove(&key);
                    }
                }
            }
        }
        persist_unread_state_required(&profile.unread_state, &profile.unread_state_path)?;
        bump_chat_view_revision(&profile.history_path, friend_number, &public_key);
        update_tray(app, app_state);
        unread_state_view(&profile)
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
        let password = password.as_deref().filter(|password| !password.is_empty());
        record.encrypted = password.is_some();
        let container_path = app_state.root_dir.join(&record.file);
        let volume = KaiProfileVolume::create(container_path, password)?;
        let namespace = volume.namespace_root().to_path_buf();
        let paths = ProfilePaths::new_with_volume(
            app_state.root_dir.clone(),
            namespace.join("data"),
            namespace.join("profile.tox"),
            Some(Arc::clone(&volume)),
        )?;
        let tox = match ToxState::new_for_profile(
            paths,
            app_state.tor.clone(),
            Arc::clone(&app_state.proxy_settings),
            Arc::clone(&app_state.network_settings),
            app_state.updates_for(&record.id),
            None,
            None,
            Some(&name),
        ) {
            Ok(tox) => Arc::new(tox),
            Err(error) => {
                volume.discard();
                if let Some(directory) = volume.container_path().parent() {
                    let _ = fs::remove_dir_all(directory);
                }
                return Err(error);
            }
        };
        tox.checkpoint_profile(true)?;
        app_state.allow_profile_media(&tox)?;
        let record_id = record.id.clone();
        registry.active_profile_id = Some(record_id.clone());
        registry.profiles.push(record);
        registry.save(&app_state.data_dir)?;
        *app_state
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())? = registry;
        if let Ok(mut grants) = app_state.native_file_grants.lock() {
            grants.clear_all();
        }
        app_state
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .insert(record_id, Arc::clone(&tox));
        tox.start_network_loop();
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
            let extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default();
            if !extension.eq_ignore_ascii_case("tox") && !extension.eq_ignore_ascii_case("kai") {
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
            let history_path = extension
                .eq_ignore_ascii_case("tox")
                .then(|| sibling("db"))
                .flatten();
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
    fn discover_qtox_profiles(
        location: Option<String>,
    ) -> Result<Vec<QtoxProfileCandidate>, String> {
        // Discovery is deliberately manual. In particular, a missing location
        // must never turn into a scan of qTox's conventional profile folders.
        let Some(location) = location.filter(|value| !value.trim().is_empty()) else {
            return Ok(Vec::new());
        };
        let selected_path = PathBuf::from(location);
        if selected_path.is_file()
            && selected_path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            let extracted = qtox_zip_import::extract(&selected_path, &std::env::temp_dir())?;
            let name = selected_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("qTox profile")
                .to_string();
            return Ok(vec![QtoxProfileCandidate {
                name,
                profile_path: selected_path.to_string_lossy().into_owned(),
                history_path: None,
                settings_path: None,
                encrypted: profiles::file_is_encrypted(&extracted.profile_path).unwrap_or(false),
            }]);
        }

        let directories = vec![selected_path];
        let mut candidates = Vec::new();
        for directory in directories {
            if directory.is_file() {
                let mut selected = Vec::new();
                if let Some(parent) = directory.parent() {
                    collect_qtox_candidates(parent, &mut selected);
                }
                selected.retain(|candidate| PathBuf::from(&candidate.profile_path) == directory);
                candidates.extend(selected);
            } else {
                collect_qtox_candidates(&directory, &mut candidates);
            }
        }
        candidates.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        candidates
            .dedup_by(|left, right| left.profile_path.eq_ignore_ascii_case(&right.profile_path));
        Ok(candidates)
    }

    #[cfg(test)]
    mod qtox_manual_discovery_tests {
        use super::*;

        fn discovery_root() -> PathBuf {
            let root = std::env::temp_dir().join(format!(
                "kaigen-qtox-manual-discovery-{}-{}",
                std::process::id(),
                unix_timestamp()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            root
        }

        #[test]
        fn missing_location_never_discovers_standard_profile_directories() {
            assert!(discover_qtox_profiles(None).unwrap().is_empty());
            assert!(discover_qtox_profiles(Some("   ".to_string()))
                .unwrap()
                .is_empty());
        }

        #[test]
        fn selected_folder_and_zip_are_discovered_without_modifying_sources() {
            let root = discovery_root();
            let folder_profile = root.join("FolderProfile.tox");
            fs::write(&folder_profile, b"folder savedata").unwrap();
            let candidates =
                discover_qtox_profiles(Some(root.to_string_lossy().into_owned())).unwrap();
            assert_eq!(candidates.len(), 1);
            assert_eq!(PathBuf::from(&candidates[0].profile_path), folder_profile);
            assert_eq!(fs::read(&folder_profile).unwrap(), b"folder savedata");

            let archive = root.join("ArchiveProfile.zip");
            let archive_bytes = qtox_zip::encode(vec![qtox_zip::ZipEntry {
                name: "ArchiveProfile.tox".to_string(),
                bytes: b"archive savedata".to_vec(),
            }])
            .unwrap();
            fs::write(&archive, &archive_bytes).unwrap();
            let candidates =
                discover_qtox_profiles(Some(archive.to_string_lossy().into_owned())).unwrap();
            assert_eq!(candidates.len(), 1);
            assert_eq!(PathBuf::from(&candidates[0].profile_path), archive);
            assert_eq!(fs::read(&archive).unwrap(), archive_bytes);
            fs::remove_dir_all(root).unwrap();
        }
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

    pub(super) fn import_qtox_avatars(
        source_profile: &Path,
        profile_data_dir: &Path,
        avatars_dir: &Path,
        self_key: &[u8; 32],
        friends: &HashMap<Vec<u8>, u32>,
        encrypted_profile: bool,
        cipher: Option<&ProfileCipher>,
    ) -> Result<(), String> {
        let Some(source_directory) = source_profile.parent().map(|path| path.join("avatars"))
        else {
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
            for entry in profiles::list(avatars_dir).unwrap_or_default() {
                if entry.is_file
                    && entry
                        .path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("self-"))
                {
                    let _ = profiles::remove_file(&entry.path);
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
            let mut local_state = profiles::read_file(&local_state_path)
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
        let requested_source = PathBuf::from(&profile_path);
        if !requested_source.is_file() {
            return Err("QTOX_PROFILE_NOT_FOUND".to_string());
        }
        let archive = requested_source
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
            .then(|| qtox_zip_import::extract(&requested_source, &app_state.data_dir))
            .transpose()?;
        let source = archive
            .as_ref()
            .map(|archive| archive.profile_path.clone())
            .unwrap_or_else(|| requested_source.clone());
        let history_source = match archive.as_ref() {
            Some(archive) => archive.history_path.clone(),
            None => history_path
                .as_ref()
                .map(PathBuf::from)
                .filter(|path| path.is_file()),
        };
        let password = password.as_deref().filter(|value| !value.is_empty());
        let source_is_kai = is_kai_profile_path(&source);
        let mut source_volume = None;
        let (savedata, source_cipher, encrypted) = if source_is_kai {
            let info = KaiProfileVolume::inspect(&source)?;
            let volume = KaiProfileVolume::open(source.clone(), password)?;
            let profile_path = volume.namespace_root().join("profile.tox");
            let (savedata, inner_cipher) = profiles::read_profile(&profile_path, password)?;
            source_volume = Some(volume);
            (savedata, inner_cipher, info.password_protected)
        } else {
            let disk_data = fs::read(&source)
                .map_err(|error| format!("Could not read the qTox profile: {error}"))?;
            let encrypted = profiles::is_encrypted(&disk_data);
            if encrypted {
                let password = password.ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?;
                let cipher = ProfileCipher::unlock(&disk_data, password)?;
                (cipher.decrypt(&disk_data)?, Some(cipher), true)
            } else {
                (disk_data, None, false)
            }
        };
        let imported_public_key = tox_savedata_public_key(&savedata)?;
        let duplicate_identity_loaded = app_state
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .values()
            .any(|profile| profile.self_public_key().as_deref() == Some(&imported_public_key));
        if duplicate_identity_loaded {
            return Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string());
        }
        let name = requested_source
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
        record.encrypted = password.is_some();
        record.imported_from = Some(profile_path);
        let container_path = app_state.root_dir.join(&record.file);
        let volume = KaiProfileVolume::create(container_path, password)?;
        let namespace = volume.namespace_root().to_path_buf();
        let paths = ProfilePaths::new_with_volume(
            app_state.root_dir.clone(),
            namespace.join("data"),
            namespace.join("profile.tox"),
            Some(Arc::clone(&volume)),
        )?;
        let profile_data_dir = paths.data_dir.clone();
        let avatar_cipher = source_cipher.clone();
        if let Some(source_volume) = source_volume.as_ref() {
            for (path, mut bytes) in
                source_volume.snapshot_plain_files(source_volume.namespace_root())?
            {
                let relative = path
                    .strip_prefix(source_volume.namespace_root())
                    .map_err(|_| "KAI_VOLUME_PATH_INVALID".to_string())?;
                if relative != Path::new("profile.tox") {
                    let result = profiles::write_file(&namespace.join(relative), &bytes);
                    wipe_sensitive_bytes(&mut bytes);
                    result?;
                } else {
                    wipe_sensitive_bytes(&mut bytes);
                }
            }
        }
        profiles::write_file(&paths.profile_path, &savedata)?;
        if !source_is_kai {
            let import_directory = paths.data_dir.join("qtox-import");
            profiles::create_dir_all(&import_directory)
                .map_err(|error| format!("Could not create qTox import directory: {error}"))?;
            if let Some(history) = history_source.as_ref() {
                let mut bytes = fs::read(history)
                    .map_err(|error| format!("Could not copy qTox history: {error}"))?;
                let result = profiles::write_file(&import_directory.join("history.db"), &bytes);
                wipe_sensitive_bytes(&mut bytes);
                result?;
            }
            let settings_source = source.with_extension("ini");
            if settings_source.is_file() {
                if let Ok(mut bytes) = fs::read(settings_source) {
                    let _ = profiles::write_file(&import_directory.join("profile.ini"), &bytes);
                    wipe_sensitive_bytes(&mut bytes);
                }
            }
        }
        let tox = Arc::new(ToxState::new_for_profile(
            paths,
            app_state.tor.clone(),
            Arc::clone(&app_state.proxy_settings),
            Arc::clone(&app_state.network_settings),
            app_state.updates_for(&record.id),
            Some(savedata),
            None,
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
        if !source_is_kai {
            import_qtox_avatars(
                &source,
                &profile_data_dir,
                &tox.avatars_dir,
                &self_key,
                &friends,
                encrypted,
                avatar_cipher.as_ref(),
            )?;
        }
        if !source_is_kai {
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
                        let portable_path = source_path
                            .as_ref()
                            .filter(|path| path.is_file())
                            .and_then(|path| {
                                let destination =
                                    unique_download_path(&tox.downloads_dir, &file_name);
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
                            preview_source: None,
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
                        friend_public_key: hex_upper(&row.chat_key),
                        text: sanitize_untrusted_text(&row.text),
                        mine: row.sender_key == self_key,
                        timestamp: (row.timestamp_ms.max(0) as u64) / 1000,
                        delivery: "delivered".to_string(),
                        delivered_at: Some((row.timestamp_ms.max(0) as u64) / 1000),
                        attachment,
                        event: None,
                        protocol_version: None,
                        operation_id: None,
                        quote: None,
                        formatting: Vec::new(),
                        pq_protected: false,
                        reactions: None,
                    });
                }
                if !converted.is_empty() {
                    let mut combined = tox
                        .messages
                        .lock()
                        .map_err(|_| "Could not import qTox messages".to_string())?
                        .clone();
                    combined.extend(converted);
                    combined.sort_by_key(|message| message.timestamp);
                    let working =
                        chat_history_store::replace_all_registered(&tox.history_path, &combined)?;
                    *tox.messages
                        .lock()
                        .map_err(|_| "Could not import qTox messages".to_string())? = working;
                    bump_history_revision(&tox.history_path);
                }
            }
        }
        tox.checkpoint_profile(true)?;
        app_state.allow_profile_media(&tox)?;
        registry
            .profiles
            .retain(|existing| !replaced_ids.contains(&existing.id));
        let record_id = record.id.clone();
        registry.active_profile_id = Some(record_id.clone());
        registry.profiles.push(record);
        registry.save(&app_state.data_dir)?;
        *app_state
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())? = registry;
        if let Ok(mut grants) = app_state.native_file_grants.lock() {
            grants.clear_all();
        }
        app_state
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .insert(record_id, Arc::clone(&tox));
        tox.start_network_loop();
        for replaced in replaced_records {
            if let Ok(profile_path) = app_state.persistent_profile_path(&replaced) {
                if let Some(directory) = profile_path.parent() {
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

    fn export_qtox_profile_blocking(
        app_state: AppState,
        password: Option<String>,
    ) -> Result<QtoxProfileExport, String> {
        let active_id = app_state
            .registry
            .lock()
            .map_err(|_| "Could not access the profile registry".to_string())?
            .active_profile_id
            .clone()
            .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
        let record = app_state.record(&active_id)?;
        let state = app_state.active()?;
        let password = password.as_deref().filter(|value| !value.is_empty());
        let export_cipher = if record.encrypted {
            let password = password.ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?;
            state
                .profile_volume
                .as_ref()
                .ok_or_else(|| "KAI_PROFILE_VOLUME_REQUIRED".to_string())?
                .verify_password(Some(password))?;
            Some(ProfileCipher::new(password)?)
        } else {
            None
        };

        let (mut savedata, self_key, friends) = {
            let handle = state
                .handle
                .lock()
                .map_err(|_| "Could not access the active Tox profile".to_string())?;
            let handle = handle
                .as_ref()
                .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())?;
            let length = unsafe { tox_get_savedata_size(handle.instance.as_ptr()) };
            let mut savedata = vec![0_u8; length];
            unsafe { tox_get_savedata(handle.instance.as_ptr(), savedata.as_mut_ptr()) };
            let mut address = [0_u8; 38];
            unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
            let mut self_key = [0_u8; 32];
            self_key.copy_from_slice(&address[..32]);
            let count = unsafe { tox_self_get_friend_list_size(handle.instance.as_ptr()) };
            let mut numbers = vec![0_u32; count];
            unsafe { tox_self_get_friend_list(handle.instance.as_ptr(), numbers.as_mut_ptr()) };
            let friends = numbers
                .into_iter()
                .filter_map(|number| {
                    let mut key = [0_u8; 32];
                    let mut error = 0_i32;
                    unsafe {
                        tox_friend_get_public_key(
                            handle.instance.as_ptr(),
                            number,
                            key.as_mut_ptr(),
                            &mut error,
                        )
                    }
                    .then_some((number, key))
                })
                .collect::<Vec<_>>();
            (savedata, self_key, friends)
        };
        let tox_bytes = match export_cipher.as_ref() {
            Some(cipher) => {
                let encrypted = cipher.encrypt(&savedata)?;
                wipe_sensitive_bytes(&mut savedata);
                encrypted
            }
            None => savedata,
        };
        let profile_name = profiles::safe_component(&record.name);
        let mut entries = vec![qtox_zip::ZipEntry {
            name: format!("{profile_name}.tox"),
            bytes: tox_bytes,
        }];

        let mut add_avatar = |owner_key: &[u8], path: PathBuf| -> Result<(), String> {
            let Some(name) = qtox_avatar_name(owner_key, &self_key, record.encrypted) else {
                return Ok(());
            };
            let mut bytes = profiles::read_file(&path)?;
            let bytes = match export_cipher.as_ref() {
                Some(cipher) => {
                    let encrypted = cipher.encrypt(&bytes);
                    wipe_sensitive_bytes(&mut bytes);
                    encrypted?
                }
                None => bytes,
            };
            entries.push(qtox_zip::ZipEntry {
                name: format!("avatars/{name}"),
                bytes,
            });
            Ok(())
        };
        if let Some(path) = current_self_avatar_path(&state.avatars_dir) {
            add_avatar(&self_key, path)?;
        }
        let avatar_entries = profiles::list(&state.avatars_dir).unwrap_or_default();
        for (friend_number, key) in friends {
            let prefix = format!("{friend_number}-");
            if let Some(path) = avatar_entries
                .iter()
                .filter(|entry| {
                    entry.is_file
                        && entry.path.file_name().is_some_and(|name| {
                            let name = name.to_string_lossy();
                            name.starts_with(&prefix) && !name.ends_with(".part")
                        })
                        && is_complete_avatar(&entry.path, None)
                })
                .max_by(|left, right| left.path.file_name().cmp(&right.path.file_name()))
                .map(|entry| entry.path.clone())
            {
                add_avatar(&key, path)?;
            }
        }
        entries.push(qtox_zip::ZipEntry {
            name: "README.txt".to_string(),
            bytes: b"qTox-compatible Tox profile exported by Kaigen. Extract the archive before importing the .tox file.\r\n".to_vec(),
        });
        Ok(QtoxProfileExport {
            file_name: format!("{profile_name}-qtox.zip"),
            bytes: qtox_zip::encode(entries)?,
        })
    }

    #[tauri::command]
    async fn export_qtox_profile(
        app_state: tauri::State<'_, AppState>,
        password: Option<String>,
    ) -> Result<QtoxProfileExport, String> {
        let owned_state = app_state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            export_qtox_profile_blocking(owned_state, password)
        })
        .await
        .map_err(|error| format!("The qTox export worker stopped unexpectedly: {error}"))?
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
        let state = app_state.active()?;
        if let Some(volume) = state.profile_volume.as_ref() {
            let current = current_password
                .as_deref()
                .filter(|password| !password.is_empty());
            let replacement = new_password
                .as_deref()
                .filter(|password| !password.is_empty());
            volume.change_password(current, replacement)?;
            let mut registry = app_state
                .registry
                .lock()
                .map_err(|_| "Could not access the profile registry".to_string())?;
            let previous_encrypted = registry
                .profiles
                .iter_mut()
                .find(|record| record.id == active_id)
                .ok_or_else(|| "ACTIVE_PROFILE_NOT_REGISTERED".to_string())?
                .encrypted;
            if let Some(record) = registry
                .profiles
                .iter_mut()
                .find(|record| record.id == active_id)
            {
                record.encrypted = replacement.is_some();
            }
            if let Err(error) = registry.save(&app_state.data_dir) {
                if let Some(record) = registry
                    .profiles
                    .iter_mut()
                    .find(|record| record.id == active_id)
                {
                    record.encrypted = previous_encrypted;
                }
                drop(registry);
                let rollback = volume.change_password(replacement, current);
                return Err(match rollback {
                    Ok(()) => error,
                    Err(rollback_error) => {
                        format!("{error}; profile password rollback also failed: {rollback_error}")
                    }
                });
            }
            drop(registry);
            return app_state.summaries();
        }
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
                        format!(
                            "ACTIVE_PROFILE_NOT_REGISTERED; profile rollback also failed: {error}"
                        )
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
            let profile_path = app_state.persistent_profile_path(doomed)?;
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
        if let Ok(mut grants) = app_state.native_file_grants.lock() {
            for profile_id in &destroyed_ids {
                grants.clear_for_profile(profile_id);
            }
        }
        let summaries = app_state.summaries()?;
        update_tray(&app, &app_state);
        Ok(summaries)
    }

    #[tauri::command]
    fn load_local_state(
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
    ) -> Result<Option<Value>, String> {
        read_profile_local_state(&state_path(&app_state, &profile_id)?)
    }

    #[tauri::command]
    fn save_local_state(
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
        state: Value,
    ) -> Result<(), String> {
        let tox_state = app_state.loaded_profile(&profile_id)?;
        write_profile_local_state_preserving_avatar(
            &tox_state.local_state_lock,
            &profile_local_state_path(&tox_state)?,
            &tox_state.avatars_dir,
            &state,
        )
    }

    #[derive(Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeDialogFilter {
        name: String,
        extensions: Vec<String>,
    }

    #[derive(Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeDialogOptions {
        #[serde(default)]
        directory: bool,
        #[serde(default)]
        multiple: bool,
        title: Option<String>,
        #[serde(default)]
        filters: Vec<NativeDialogFilter>,
    }

    #[derive(Serialize)]
    #[serde(untagged)]
    enum NativeDialogSelection {
        One(String),
        Multiple(Vec<String>),
    }

    fn validate_native_dialog_path(path: PathBuf, directory: bool) -> Result<String, String> {
        let path = fs::canonicalize(&path)
            .map_err(|_| "The native file dialog returned an invalid selection".to_string())?;
        let valid_kind = if directory {
            path.is_dir()
        } else {
            path.is_file()
        };
        if !path.is_absolute() || !valid_kind {
            return Err("The native file dialog returned an invalid selection".to_string());
        }
        path.into_os_string()
            .into_string()
            .map_err(|_| "The native file dialog returned an invalid path".to_string())
    }

    async fn select_native_dialog_paths(
        app: tauri::AppHandle,
        options: &NativeDialogOptions,
    ) -> Result<Vec<PathBuf>, String> {
        use tauri_plugin_dialog::{DialogExt, FilePath};

        if options.filters.len() > 8
            || options
                .filters
                .iter()
                .any(|filter| filter.extensions.len() > 16)
        {
            return Err("NATIVE_DIALOG_FILTERS_INVALID".to_string());
        }

        let title = options
            .title
            .as_deref()
            .map(sanitize_untrusted_text)
            .filter(|title| !title.trim().is_empty())
            .map(|title| title.chars().take(120).collect::<String>())
            .unwrap_or_else(|| {
                if options.directory {
                    "Choose a folder".to_string()
                } else {
                    "Choose a file".to_string()
                }
            });
        let mut picker = app.dialog().file().set_title(title);
        for filter in &options.filters {
            let extensions = filter
                .extensions
                .iter()
                .filter(|extension| {
                    !extension.is_empty()
                        && extension.len() <= 16
                        && extension
                            .chars()
                            .all(|character| character.is_ascii_alphanumeric())
                })
                .map(String::as_str)
                .collect::<Vec<_>>();
            if extensions.is_empty() {
                continue;
            }
            picker = picker.add_filter(
                sanitize_untrusted_text(&filter.name)
                    .chars()
                    .take(80)
                    .collect::<String>(),
                &extensions,
            );
        }
        if let Some(window) = app.get_webview_window("main") {
            picker = picker.set_parent(&window);
        }

        // The callback picker is dispatched onto the native main thread. The
        // selected path never enters Tauri's JavaScript dialog plugin and is
        // therefore not added to the asset-protocol scope.
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Option<Vec<FilePath>>>(1);
        match (options.directory, options.multiple) {
            (true, true) => picker.pick_folders(move |selected| {
                let _ = sender.send(selected);
            }),
            (true, false) => picker.pick_folder(move |selected| {
                let _ = sender.send(selected.map(|path| vec![path]));
            }),
            (false, true) => picker.pick_files(move |selected| {
                let _ = sender.send(selected);
            }),
            (false, false) => picker.pick_file(move |selected| {
                let _ = sender.send(selected.map(|path| vec![path]));
            }),
        }

        let selected = tauri::async_runtime::spawn_blocking(move || receiver.recv())
            .await
            .map_err(|_| "The native file dialog task failed".to_string())?
            .map_err(|_| "The native file dialog closed unexpectedly".to_string())?
            .unwrap_or_default();
        selected
            .into_iter()
            .map(|path| {
                path.into_path()
                    .map_err(|_| "The native file dialog returned an invalid path".to_string())
            })
            .collect()
    }

    #[tauri::command]
    async fn open_native_dialog(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
        options: NativeDialogOptions,
    ) -> Result<Option<NativeDialogSelection>, String> {
        let _guard = app_state.begin_native_dialog()?;
        let selected = select_native_dialog_paths(app, &options).await?;
        let validated = selected
            .into_iter()
            .map(|path| validate_native_dialog_path(path, options.directory))
            .collect::<Result<Vec<_>, _>>()?;
        if options.multiple {
            Ok((!validated.is_empty()).then_some(NativeDialogSelection::Multiple(validated)))
        } else {
            Ok(validated.into_iter().next().map(NativeDialogSelection::One))
        }
    }

    fn issue_native_file_batch(
        app_state: &AppState,
        paths: Vec<PathBuf>,
        profile_id: String,
        recipient_public_key: String,
    ) -> Result<NativeFileBatchSelection, String> {
        let selected_count = paths.len();
        if selected_count > MAX_CHAT_FILE_QUEUE {
            return Ok(NativeFileBatchSelection {
                accepted: Vec::new(),
                rejected: Vec::new(),
                selected_count,
                too_many: true,
            });
        }
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        let mut grants = app_state
            .native_file_grants
            .lock()
            .map_err(|_| "Could not access native file grants".to_string())?;
        for path in paths {
            let name = safe_file_name(&path.to_string_lossy());
            let metadata = fs::metadata(&path).ok();
            let size = metadata.as_ref().map(fs::Metadata::len).unwrap_or(0);
            let reason = if metadata
                .as_ref()
                .is_some_and(|value| value.is_file() && size == 0)
            {
                Some("empty")
            } else if metadata
                .as_ref()
                .is_some_and(|value| value.is_file() && size > MAX_CHAT_FILE_BYTES)
            {
                Some("too_large")
            } else {
                None
            };
            if let Some(reason) = reason {
                rejected.push(NativeFileRejection {
                    file: NativeFileCandidate { name, size },
                    reason: reason.to_string(),
                });
                continue;
            }
            match grants.issue(
                &path,
                profile_id.clone(),
                recipient_public_key.clone(),
                MAX_CHAT_FILE_BYTES,
            ) {
                Ok(selection) => accepted.push(selection),
                Err(_) => rejected.push(NativeFileRejection {
                    file: NativeFileCandidate { name, size },
                    reason: "unreadable".to_string(),
                }),
            }
        }
        Ok(NativeFileBatchSelection {
            accepted,
            rejected,
            selected_count,
            too_many: false,
        })
    }

    #[tauri::command]
    async fn pick_tox_files(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<NativeFileBatchSelection, String> {
        let (profile_id, tox_state) = app_state.active_snapshot()?;
        let recipient_public_key = tox_state.stable_friend_public_key(friend_number);
        if recipient_public_key.is_empty() {
            return Err("FRIEND_NOT_FOUND".to_string());
        }
        let _guard = app_state.begin_native_dialog()?;
        let options = NativeDialogOptions {
            directory: false,
            multiple: true,
            title: Some("Выберите файлы для отправки".to_string()),
            filters: Vec::new(),
        };
        let paths = select_native_dialog_paths(app, &options).await?;
        let (current_profile_id, current_state) = app_state.active_snapshot()?;
        if current_profile_id != profile_id || !Arc::ptr_eq(&current_state, &tox_state) {
            return Err("ACTIVE_PROFILE_CHANGED".to_string());
        }
        if current_state.stable_friend_public_key(friend_number) != recipient_public_key {
            return Err("FILE_GRANT_RECIPIENT_CHANGED".to_string());
        }
        issue_native_file_batch(&app_state, paths, profile_id, recipient_public_key)
    }

    fn clipboard_image_temp_path() -> Result<PathBuf, String> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| "CLIPBOARD_IMAGE_RANDOM_SOURCE_FAILED".to_string())?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        Ok(std::env::temp_dir().join(format!("kaigen-clipboard-{suffix}.png")))
    }

    fn validate_captured_clipboard_image(path: &Path) -> Result<(), String> {
        let metadata = fs::metadata(path).map_err(|_| "CLIPBOARD_IMAGE_UNAVAILABLE".to_string())?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("CLIPBOARD_IMAGE_UNAVAILABLE".to_string());
        }
        if metadata.len() > MAX_CHAT_FILE_BYTES {
            return Err("CLIPBOARD_IMAGE_TOO_LARGE".to_string());
        }
        let mut signature = [0_u8; 8];
        File::open(path)
            .and_then(|mut file| file.read_exact(&mut signature))
            .map_err(|_| "CLIPBOARD_IMAGE_INVALID".to_string())?;
        if signature != [137, 80, 78, 71, 13, 10, 26, 10] {
            return Err("CLIPBOARD_IMAGE_INVALID".to_string());
        }
        Ok(())
    }

    fn copy_capped_clipboard_stream<R: Read>(
        source: &mut R,
        path: &Path,
        maximum: u64,
    ) -> Result<u64, String> {
        let mut destination =
            File::create(path).map_err(|_| "CLIPBOARD_IMAGE_WRITE_FAILED".to_string())?;
        std::io::copy(
            &mut source.take(maximum.saturating_add(1)),
            &mut destination,
        )
        .map_err(|_| "CLIPBOARD_IMAGE_WRITE_FAILED".to_string())
    }

    #[cfg(target_os = "windows")]
    fn capture_native_clipboard_image(path: &Path) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = r#"& { param([string]$path)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = $null
for ($attempt = 0; $attempt -lt 5 -and $null -eq $image; $attempt++) {
  try { if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $image = [System.Windows.Forms.Clipboard]::GetImage() } } catch {}
  if ($null -eq $image) { Start-Sleep -Milliseconds 40 }
}
if ($null -eq $image) { exit 3 }
try { $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }
}"#;
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Sta",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|_| "CLIPBOARD_IMAGE_SERVICE_UNAVAILABLE".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err("CLIPBOARD_IMAGE_UNAVAILABLE".to_string())
        }
    }

    #[cfg(target_os = "macos")]
    fn capture_native_clipboard_image(path: &Path) -> Result<(), String> {
        let script = r#"ObjC.import('AppKit');
function run(argv) {
  const image = $.NSImage.alloc.initWithPasteboard($.NSPasteboard.generalPasteboard);
  if (!image) throw new Error('no image');
  const tiff = image.TIFFRepresentation;
  const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!png || !png.writeToFileAtomically(argv[0], true)) throw new Error('write failed');
}"#;
        let output = std::process::Command::new("osascript")
            .args(["-l", "JavaScript", "-e", script, "--"])
            .arg(path)
            .output()
            .map_err(|_| "CLIPBOARD_IMAGE_SERVICE_UNAVAILABLE".to_string())?;
        output
            .status
            .success()
            .then_some(())
            .ok_or_else(|| "CLIPBOARD_IMAGE_UNAVAILABLE".to_string())
    }

    #[cfg(target_os = "linux")]
    fn capture_native_clipboard_image(path: &Path) -> Result<(), String> {
        for (program, args) in [
            ("wl-paste", vec!["--no-newline", "--type", "image/png"]),
            (
                "xclip",
                vec!["-selection", "clipboard", "-t", "image/png", "-o"],
            ),
        ] {
            let mut child = match std::process::Command::new(program)
                .args(args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => child,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("CLIPBOARD_IMAGE_SERVICE_UNAVAILABLE".to_string()),
            };
            let mut stdout = child
                .stdout
                .take()
                .ok_or_else(|| "CLIPBOARD_IMAGE_SERVICE_UNAVAILABLE".to_string())?;
            // Clipboard providers are untrusted processes. Stream directly to the
            // owned temporary file and stop after one byte beyond the admission
            // limit instead of buffering an arbitrarily large image in RAM.
            let copied = match copy_capped_clipboard_stream(&mut stdout, path, MAX_CHAT_FILE_BYTES)
            {
                Ok(copied) => copied,
                Err(error) => {
                    drop(stdout);
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            };
            if copied > MAX_CHAT_FILE_BYTES {
                drop(stdout);
                let _ = child.kill();
                let _ = child.wait();
                return Err("CLIPBOARD_IMAGE_TOO_LARGE".to_string());
            }
            drop(stdout);
            let status = child
                .wait()
                .map_err(|_| "CLIPBOARD_IMAGE_SERVICE_UNAVAILABLE".to_string())?;
            if status.success() && copied > 0 {
                return Ok(());
            }
        }
        Err("CLIPBOARD_IMAGE_UNAVAILABLE".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    fn capture_native_clipboard_image(_path: &Path) -> Result<(), String> {
        Err("CLIPBOARD_IMAGE_UNAVAILABLE".to_string())
    }

    #[tauri::command]
    async fn stage_clipboard_image_for_chat(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
    ) -> Result<NativeFileBatchSelection, String> {
        let app_state = app_state.inner().clone();
        let (profile_id, profile) = match profile_id {
            Some(profile_id) => {
                let profile = app_state.loaded_profile(&profile_id)?;
                (profile_id, profile)
            }
            None => app_state.active_snapshot()?,
        };
        let recipient_public_key = profile.stable_friend_public_key(friend_number);
        if recipient_public_key.is_empty() {
            return Err("FRIEND_NOT_FOUND".to_string());
        }
        let path = clipboard_image_temp_path()?;
        let capture_path = path.clone();
        let captured = tauri::async_runtime::spawn_blocking(move || {
            capture_native_clipboard_image(&capture_path)?;
            validate_captured_clipboard_image(&capture_path)
        })
        .await
        .map_err(|_| "CLIPBOARD_IMAGE_TASK_FAILED".to_string())?;
        if let Err(error) = captured {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        // Recheck the exact owner and recipient after the clipboard service
        // returns. The scoped token can never be redirected by a profile/chat
        // switch while capture was running.
        let current = app_state.loaded_profile(&profile_id)?;
        if !Arc::ptr_eq(&current, &profile)
            || current.stable_friend_public_key(friend_number) != recipient_public_key
        {
            let _ = fs::remove_file(&path);
            return Err("FILE_GRANT_RECIPIENT_CHANGED".to_string());
        }
        let selection = app_state
            .native_file_grants
            .lock()
            .map_err(|_| "Could not access native file grants".to_string())?
            .issue_owned(&path, profile_id, recipient_public_key, MAX_CHAT_FILE_BYTES);
        match selection {
            Ok(selection) => Ok(NativeFileBatchSelection {
                accepted: vec![selection],
                rejected: Vec::new(),
                selected_count: 1,
                too_many: false,
            }),
            Err(error) => {
                let _ = fs::remove_file(path);
                Err(error)
            }
        }
    }

    #[tauri::command]
    fn set_native_file_drop_target(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: Option<u32>,
    ) -> Result<(), String> {
        let target = match (profile_id, friend_number) {
            (None, None) => None,
            (Some(profile_id), Some(friend_number)) => {
                let tox_state = app_state.loaded_profile(&profile_id)?;
                let recipient_public_key = tox_state.stable_friend_public_key(friend_number);
                if recipient_public_key.is_empty() {
                    return Err("FRIEND_NOT_FOUND".to_string());
                }
                Some(NativeFileDropTarget {
                    profile_id,
                    friend_number,
                    recipient_public_key,
                })
            }
            _ => return Err("FILE_DROP_TARGET_INVALID".to_string()),
        };
        *app_state
            .native_file_drop_target
            .lock()
            .map_err(|_| "Could not update the native file drop target".to_string())? = target;
        Ok(())
    }

    #[tauri::command]
    async fn pick_profile_avatar_data_url(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
    ) -> Result<Option<String>, String> {
        let _guard = app_state.begin_native_dialog()?;
        let options = NativeDialogOptions {
            directory: false,
            multiple: false,
            title: Some("Выберите аватар".to_string()),
            filters: vec![NativeDialogFilter {
                name: "Images".to_string(),
                extensions: ["png", "jpg", "jpeg", "webp", "gif"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            }],
        };
        let Some(path) = select_native_dialog_paths(app, &options)
            .await?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        avatar_data_url_from_path(&path).map(Some)
    }

    #[cfg(test)]
    mod native_dialog_tests {
        use super::{copy_capped_clipboard_stream, validate_native_dialog_path};
        use std::io::Cursor;
        use std::path::PathBuf;

        #[test]
        fn accepts_existing_absolute_file_and_folder() {
            let file = std::env::current_exe().expect("test executable path");
            let folder = std::env::current_dir().expect("test working directory");
            assert_eq!(
                validate_native_dialog_path(file.clone(), false).expect("valid file"),
                std::fs::canonicalize(file).unwrap().to_string_lossy()
            );
            assert_eq!(
                validate_native_dialog_path(folder.clone(), true).expect("valid folder"),
                std::fs::canonicalize(folder).unwrap().to_string_lossy()
            );
        }

        #[test]
        fn rejects_relative_missing_and_wrong_kind_paths() {
            let file = std::env::current_exe().expect("test executable path");
            let folder = std::env::current_dir().expect("test working directory");
            assert!(validate_native_dialog_path(PathBuf::from("relative.png"), false).is_err());
            assert!(validate_native_dialog_path(folder, false).is_err());
            assert!(validate_native_dialog_path(file, true).is_err());
        }

        #[test]
        fn clipboard_stream_reads_at_most_one_byte_past_the_limit() {
            let path = std::env::temp_dir()
                .join(format!("kaigen-clipboard-cap-test-{}", std::process::id()));
            let mut source = Cursor::new(vec![7_u8; 32]);
            let copied = copy_capped_clipboard_stream(&mut source, &path, 8).unwrap();
            assert_eq!(copied, 9);
            assert_eq!(source.position(), 9);
            assert_eq!(std::fs::metadata(&path).unwrap().len(), 9);
            std::fs::remove_file(path).unwrap();
        }
    }

    #[tauri::command]
    fn set_profile_avatar(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
        data_url: Option<String>,
        filename: Option<String>,
        bytes: Option<Vec<u8>>,
    ) -> Result<Vec<ProfileSummary>, String> {
        let update = validate_profile_avatar_update(data_url, filename, bytes)?;
        let tox_state = app_state.loaded_profile(&profile_id)?;
        let path = profile_local_state_path(&tox_state)?;
        match update {
            ProfileAvatarUpdate::Set {
                data_url,
                filename,
                bytes,
            } => {
                let started = send_tox_avatar_for_state(&tox_state, filename, bytes);
                write_profile_avatar_local_state(
                    &tox_state.local_state_lock,
                    &path,
                    Some(&data_url),
                )?;
                started?;
            }
            ProfileAvatarUpdate::Clear => {
                remove_self_avatar_files(&tox_state.avatars_dir)?;
                let started = send_tox_avatar_removal_for_shared_state(&tox_state);
                write_profile_avatar_local_state(&tox_state.local_state_lock, &path, None)?;
                started?;
            }
        }
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
    fn save_layout_state(
        app_state: tauri::State<'_, AppState>,
        state: Value,
    ) -> Result<(), String> {
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
        let added_at = unix_timestamp();
        let added_event_sequence = next_chat_event_sequence();
        let cache_write = if let Ok(mut cache) = tox_state.friend_cache.lock() {
            let entry = cache.entry(public_key).or_default();
            entry.tox_id = tox_id
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
                .to_uppercase();
            entry.friend_number = Some(friend_number);
            entry.pending_authorization = true;
            entry.authorization_message = message.to_string();
            entry.authorization_last_refreshed_at = added_at;
            entry.added_at = Some(added_at);
            entry.added_event_sequence = added_event_sequence;
            enqueue_friend_cache_write_required(&cache, &tox_state.friend_cache_path).ok()
        } else {
            None
        };
        if let Some(completed) = cache_write {
            let _ = wait_for_atomic_write(completed);
        }
        ToxState::save(instance)?;
        Ok(friend_number)
    }

    #[tauri::command]
    async fn get_tox_friends(
        app_state: tauri::State<'_, AppState>,
    ) -> Result<Vec<ToxFriend>, String> {
        let app_state = app_state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || get_tox_friends_blocking(&app_state))
            .await
            .map_err(|error| format!("Tox contact refresh task failed: {error}"))?
    }

    fn get_tox_friends_blocking(app_state: &AppState) -> Result<Vec<ToxFriend>, String> {
        let tox_state = app_state.active()?;
        get_tox_friends_snapshot(&tox_state)
    }

    pub(super) fn get_tox_friends_snapshot(tox_state: &ToxState) -> Result<Vec<ToxFriend>, String> {
        let (last_events_by_key, last_events_by_number) = tox_state
            .messages
            .lock()
            .map_err(|_| "Не удалось прочитать историю событий".to_string())?
            .iter()
            .fold(
                (HashMap::<String, u64>::new(), HashMap::<u32, u64>::new()),
                |(mut by_key, mut by_number), message| {
                    if message.friend_public_key.is_empty() {
                        let entry = by_number.entry(message.friend_number).or_default();
                        *entry = (*entry).max(message.timestamp);
                    } else {
                        let entry = by_key.entry(message.friend_public_key.clone()).or_default();
                        *entry = (*entry).max(message.timestamp);
                    }
                    (by_key, by_number)
                },
            );
        let avatar_sources = latest_friend_avatar_sources(&tox_state.avatars_dir);
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

        let mut friend_cache = tox_state
            .friend_cache
            .lock()
            .map_err(|_| "Не удалось прочитать кэш контактов".to_string())?;
        let mut friend_cache_changed = false;
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
            {
                let entry = friend_cache.entry(public_key.clone()).or_default();
                if entry.friend_number != Some(number) {
                    entry.friend_number = Some(number);
                    friend_cache_changed = true;
                }
            }
            let name = if received_name.trim().is_empty() {
                friend_cache
                    .get(&public_key)
                    .map(|profile| profile.name.clone())
                    .unwrap_or_default()
            } else {
                let entry = friend_cache.entry(public_key.clone()).or_default();
                if entry.name != received_name {
                    entry.name = received_name.clone();
                    friend_cache_changed = true;
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
                let entry = friend_cache.entry(public_key.clone()).or_default();
                if !name.trim().is_empty() && entry.name != name {
                    entry.name = name.clone();
                    friend_cache_changed = true;
                }
                if entry.status_message != received_status_message {
                    entry.status_message = received_status_message.clone();
                    friend_cache_changed = true;
                }
                received_status_message
            } else {
                friend_cache
                    .get(&public_key)
                    .map(|profile| profile.status_message.clone())
                    .unwrap_or_default()
            };
            let status_message = sanitize_untrusted_text(&status_message);
            let avatar_path = avatar_sources.get(&number).cloned();
            let cached = friend_cache.get(&public_key).cloned().unwrap_or_default();
            let last_online = cached.last_online;
            let cached_tox_id = (!cached.tox_id.is_empty())
                .then_some(cached.tox_id)
                .filter(|tox_id| !tox_id.is_empty())
                .unwrap_or_else(|| public_key.clone());
            let authorized = cached.authorized;
            let last_event = last_events_by_key
                .get(&public_key)
                .copied()
                .or_else(|| last_events_by_number.get(&number).copied());
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
                added_at: cached.added_at,
                last_event_sequence: Some(cached.added_event_sequence),
            });
        }
        if friend_cache_changed {
            if let Ok(serialized) = serde_json::to_vec(&*friend_cache) {
                let _ = atomic_write_sender().try_send(AtomicWriteRequest::Write {
                    path: tox_state.friend_cache_path.clone(),
                    bytes: serialized,
                });
            }
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
    async fn get_tox_messages(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        limit: Option<usize>,
    ) -> Result<Vec<ToxMessage>, String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        tauri::async_runtime::spawn_blocking(move || {
            let friend_public_key = tox_state.stable_friend_public_key(friend_number);
            let cap = match limit {
                Some(0) => 1_000,
                Some(value) => value.clamp(1, 1_000),
                None => DEFAULT_MESSAGE_SNAPSHOT,
            };
            let mut result = if tox_state.history_enabled.load(Ordering::Relaxed)
                && chat_history_store::contains_registered(&tox_state.history_path)
            {
                chat_history_store::latest_registered(
                    &tox_state.history_path,
                    friend_number,
                    &friend_public_key,
                    cap,
                )?
            } else {
                tox_state
                    .messages
                    .lock()
                    .map(|messages| {
                        friend_message_snapshot(
                            &messages,
                            friend_number,
                            &friend_public_key,
                            Some(cap),
                        )
                    })
                    .map_err(|_| "Не удалось прочитать сообщения Tox".to_string())?
            };
            decorate_message_reactions(&tox_state, &mut result);
            hydrate_attachment_preview_sources(&mut result);
            Ok(result)
        })
        .await
        .map_err(|error| format!("Chat history task stopped unexpectedly: {error}"))?
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ToxMessagesSnapshot {
        revision: u64,
        messages: Option<Vec<ToxMessage>>,
        total: usize,
        window_start: usize,
        has_more: bool,
        has_more_before: bool,
        has_more_after: bool,
        target_index: Option<usize>,
        reaction_eligible_ids: Vec<String>,
        latest_message_id: Option<String>,
        first_unseen_message_id: Option<String>,
        unseen_message_ids: Vec<String>,
        peer_reactions: Vec<PeerReactionSummary>,
        peer_reaction_events: Vec<PeerReactionEvent>,
        peer_reaction_latest_revision: u64,
    }

    #[tauri::command]
    async fn get_tox_messages_snapshot(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        limit: Option<usize>,
        known_revision: Option<u64>,
        range_offset: Option<usize>,
        target_message_id: Option<String>,
        view_lease_id: Option<String>,
        peer_reaction_after: Option<u64>,
        ack_peer_reaction_through: Option<u64>,
    ) -> Result<ToxMessagesSnapshot, String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        tauri::async_runtime::spawn_blocking(move || {
            let friend_public_key = tox_state.stable_friend_public_key(friend_number);
            mark_chat_history_active(
                &tox_state,
                friend_number,
                &friend_public_key,
                view_lease_id.as_deref(),
            );
            if let Some(through) = ack_peer_reaction_through.filter(|value| *value > 0) {
                tox_state.chat_protocol.acknowledge_peer_reaction_events(
                    friend_number,
                    &friend_public_key,
                    through,
                )?;
            }
            let (peer_reaction_events, peer_reaction_latest_revision) =
                tox_state.chat_protocol.peer_reaction_events(
                    friend_number,
                    &friend_public_key,
                    peer_reaction_after.unwrap_or(0),
                    chat_protocol::MAX_PEER_REACTION_EVENT_PAGE,
                )?;
            let revision =
                chat_snapshot_revision(&tox_state.history_path, friend_number, &friend_public_key);
            if known_revision == Some(revision) {
                return Ok(ToxMessagesSnapshot {
                    revision,
                    messages: None,
                    total: 0,
                    window_start: 0,
                    has_more: false,
                    has_more_before: false,
                    has_more_after: false,
                    target_index: None,
                    reaction_eligible_ids: Vec::new(),
                    latest_message_id: None,
                    first_unseen_message_id: None,
                    unseen_message_ids: Vec::new(),
                    peer_reactions: Vec::new(),
                    peer_reaction_events,
                    peer_reaction_latest_revision,
                });
            }
            let (mut messages, total, window_start, target_index) =
                if tox_state.history_enabled.load(Ordering::Relaxed) {
                    let window = chat_history_store::window_registered(
                        &tox_state.history_path,
                        friend_number,
                        &friend_public_key,
                        limit,
                        range_offset,
                        target_message_id.as_deref(),
                    )?;
                    let mut messages = window.messages;
                    replace_cached_contact_window(
                        &tox_state,
                        friend_number,
                        &friend_public_key,
                        &mut messages,
                    )?;
                    (
                        messages,
                        window.total,
                        window.window_start,
                        window.target_index,
                    )
                } else {
                    let messages = tox_state
                        .messages
                        .lock()
                        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED".to_string())?;
                    session_history_window(
                        &messages,
                        friend_number,
                        &friend_public_key,
                        limit,
                        range_offset,
                        target_message_id.as_deref(),
                    )
                };
            decorate_message_reactions(&tox_state, &mut messages);
            hydrate_attachment_preview_sources(&mut messages);
            let (
                reaction_eligible_ids,
                latest_message_id,
                first_unseen_message_id,
                unseen_message_ids,
                peer_reactions,
            ) = chat_window_metadata(&tox_state, friend_number, &friend_public_key, &messages)?;
            let has_more_before = window_start > 0;
            let has_more_after = window_start.saturating_add(messages.len()) < total;
            Ok(ToxMessagesSnapshot {
                revision,
                messages: Some(messages),
                total,
                window_start,
                has_more: has_more_before,
                has_more_before,
                has_more_after,
                target_index,
                reaction_eligible_ids,
                latest_message_id,
                first_unseen_message_id,
                unseen_message_ids,
                peer_reactions,
                peer_reaction_events,
                peer_reaction_latest_revision,
            })
        })
        .await
        .map_err(|error| format!("Chat history snapshot task stopped unexpectedly: {error}"))?
    }

    #[tauri::command]
    async fn release_chat_history(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        view_lease_id: Option<String>,
    ) -> Result<(), String> {
        let profile = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        tauri::async_runtime::spawn_blocking(move || {
            release_chat_history_for_state(&profile, friend_number, view_lease_id.as_deref())
        })
        .await
        .map_err(|error| format!("Chat history release task stopped unexpectedly: {error}"))?
    }

    #[tauri::command]
    async fn refresh_chat_history_lease(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        view_lease_id: String,
    ) -> Result<(), String> {
        let profile = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        tauri::async_runtime::spawn_blocking(move || {
            refresh_chat_history_lease_for_state(&profile, friend_number, &view_lease_id)
        })
        .await
        .map_err(|error| format!("Chat history lease refresh task stopped unexpectedly: {error}"))?
    }

    #[tauri::command]
    async fn search_tox_messages(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        query: String,
        cursor: Option<String>,
        limit: Option<usize>,
    ) -> Result<MessageSearchPage, String> {
        let profile = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        let query = sanitize_untrusted_text(&query).trim().to_string();
        if query.is_empty() || query.chars().count() > 256 {
            return Err("CHAT_SEARCH_QUERY_INVALID".to_string());
        }
        let friend_public_key = profile.stable_friend_public_key(friend_number);
        let history_path = profile.history_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let page = chat_history_store::search_registered(
                &history_path,
                friend_number,
                &friend_public_key,
                &query,
                cursor.as_deref(),
                limit.unwrap_or(100),
            )?;
            Ok(MessageSearchPage {
                matches: page
                    .matches
                    .into_iter()
                    .map(|item| MessageSearchMatch {
                        message_id: item.message_id,
                        index: item.index,
                        field: item.field,
                        start: item.start,
                        end: item.end,
                        snippet: item.snippet.unwrap_or_default(),
                    })
                    .collect(),
                next_cursor: page.next_cursor,
                total_matches: None,
            })
        })
        .await
        .map_err(|error| format!("Chat history search task stopped unexpectedly: {error}"))?
    }

    #[tauri::command]
    async fn send_tox_message(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        text: String,
        operation_id: Option<String>,
        quote: Option<ChatQuote>,
        formatting: Option<Vec<TextFormatSpan>>,
    ) -> Result<SendMessageResult, String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        tauri::async_runtime::spawn_blocking(move || {
            send_chat_message_for_state(
                &tox_state,
                friend_number,
                text,
                operation_id,
                quote,
                formatting.unwrap_or_default(),
            )
        })
        .await
        .map_err(|error| format!("Chat send task stopped unexpectedly: {error}"))?
    }

    #[tauri::command]
    fn get_chat_capabilities(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
    ) -> Result<ChatCapabilities, String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        Ok(chat_capabilities(&tox_state, friend_number))
    }

    #[tauri::command]
    async fn set_message_reactions(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: u32,
        message_id: String,
        reactions: Vec<ReactionCode>,
        operation_id: Option<String>,
    ) -> Result<ReactionView, String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        tauri::async_runtime::spawn_blocking(move || {
            set_message_reactions_for_state(
                &tox_state,
                friend_number,
                message_id,
                reactions,
                operation_id,
            )
        })
        .await
        .map_err(|error| format!("Chat reaction task stopped unexpectedly: {error}"))?
    }

    #[tauri::command]
    async fn get_pq_status(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<PqStatus, String> {
        let state = app_state.active()?;
        tauri::async_runtime::spawn_blocking(move || state.pq.status(friend_number))
            .await
            .map_err(|_| "PQ_STATUS_TASK_FAILED".to_string())
    }

    #[tauri::command]
    async fn begin_pq_entropy(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<u64, String> {
        let state = app_state.active()?;
        tauri::async_runtime::spawn_blocking(move || state.pq.begin_identity_entropy(friend_number))
            .await
            .map_err(|_| "PQ_ENTROPY_TASK_FAILED".to_string())?
    }

    #[tauri::command]
    async fn complete_pq_identity(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
        mut extra_noise: Vec<u8>,
    ) -> Result<PqStatus, String> {
        if !extra_noise.is_empty() && extra_noise.len() != 32 {
            return Err("PQ_NOISE_DIGEST_INVALID".into());
        }
        let state = app_state.active()?;
        tauri::async_runtime::spawn_blocking(move || {
            let (_, _transaction) = lock_chat_transaction_for_friend(&state, friend_number)?;
            let result = state.pq.complete_identity(&extra_noise);
            extra_noise.fill(0);
            result?;
            Ok(state.pq.status(friend_number))
        })
        .await
        .map_err(|_| "PQ_IDENTITY_TASK_FAILED".to_string())?
    }

    #[tauri::command]
    async fn skip_pq_auto(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<PqStatus, String> {
        let state = app_state.active()?;
        tauri::async_runtime::spawn_blocking(move || skip_pq_auto_for_state(&state, friend_number))
            .await
            .map_err(|_| "PQ_SKIP_TASK_FAILED".to_string())?
    }

    async fn run_pq_control(
        tox_state: Arc<ToxState>,
        friend_number: u32,
        operation: fn(&PqEngine, u32) -> Result<Vec<Vec<u8>>, String>,
        history_state: &'static str,
        append: bool,
    ) -> Result<PqStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let (_, _transaction) = lock_chat_transaction_for_friend(&tox_state, friend_number)?;
            let packets = operation(&tox_state.pq, friend_number)?;
            tox_state.pq.queue(friend_number, packets);
            let status = tox_state.pq.status(friend_number);
            let changed = if append {
                append_pq_history(
                    &tox_state.messages,
                    friend_number,
                    &status,
                    "initiator",
                    history_state,
                    true,
                );
                true
            } else {
                update_latest_pq_history(&tox_state.messages, friend_number, &status, history_state)
            };
            if changed {
                persist_tox_history(
                    &tox_state.messages,
                    &tox_state.history_path,
                    &tox_state.history_enabled,
                );
            }
            Ok(status)
        })
        .await
        .map_err(|_| "PQ_CONTROL_TASK_FAILED".to_string())?
    }

    #[tauri::command]
    async fn request_pq_session(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<PqStatus, String> {
        run_pq_control(
            app_state.active()?,
            friend_number,
            PqEngine::request,
            "offered",
            true,
        )
        .await
    }

    #[tauri::command]
    async fn withdraw_pq_session(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<PqStatus, String> {
        run_pq_control(
            app_state.active()?,
            friend_number,
            PqEngine::withdraw,
            "withdrawn",
            false,
        )
        .await
    }

    #[tauri::command]
    async fn accept_pq_session(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<PqStatus, String> {
        run_pq_control(
            app_state.active()?,
            friend_number,
            PqEngine::accept,
            "accepting",
            false,
        )
        .await
    }

    #[tauri::command]
    async fn reject_pq_session(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<PqStatus, String> {
        run_pq_control(
            app_state.active()?,
            friend_number,
            PqEngine::reject,
            "rejected",
            false,
        )
        .await
    }

    #[tauri::command]
    async fn request_pq_shutdown(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<PqStatus, String> {
        run_pq_control(
            app_state.active()?,
            friend_number,
            PqEngine::request_shutdown,
            "close_pending",
            true,
        )
        .await
    }

    fn queue_tox_file_for_state(
        tox_state: Arc<ToxState>,
        friend_number: u32,
        expected_friend_public_key: Option<String>,
        filename: String,
        mime: String,
        mut bytes: Vec<u8>,
    ) -> Result<u32, String> {
        let (peer_online, revision) = match observe_chat_peer_connection(&tox_state, friend_number)
        {
            Ok(observation) => observation,
            Err(error) => {
                wipe_sensitive_bytes(&mut bytes);
                return Err(error);
            }
        };
        queue_tox_file_for_state_with_connection_observation(
            &tox_state,
            friend_number,
            expected_friend_public_key,
            filename,
            mime,
            bytes,
            peer_online,
            Some(revision),
        )
    }

    pub(super) fn queue_tox_file_for_state_with_connection_observation(
        tox_state: &ToxState,
        friend_number: u32,
        expected_friend_public_key: Option<String>,
        filename: String,
        mime: String,
        mut bytes: Vec<u8>,
        peer_online: bool,
        connection_revision: Option<u64>,
    ) -> Result<u32, String> {
        if bytes.is_empty() {
            wipe_sensitive_bytes(&mut bytes);
            return Err("Нельзя отправить пустой файл".to_string());
        }
        if bytes.len() as u64 > MAX_CHAT_FILE_BYTES {
            wipe_sensitive_bytes(&mut bytes);
            return Err("TRANSFER_FILE_TOO_LARGE".to_string());
        }
        let (current_friend_public_key, _transaction) =
            match lock_chat_transaction_for_friend(&tox_state, friend_number) {
                Ok(value) => value,
                Err(error) => {
                    wipe_sensitive_bytes(&mut bytes);
                    return Err(error);
                }
            };
        let friend_public_key = match expected_friend_public_key {
            Some(expected) if expected == current_friend_public_key => expected,
            Some(_) => {
                wipe_sensitive_bytes(&mut bytes);
                return Err("FILE_GRANT_RECIPIENT_CHANGED".to_string());
            }
            None => current_friend_public_key,
        };
        let queued = tox_state
            .pending_files
            .lock()
            .map_err(|_| "Не удалось проверить очередь файлов".to_string())?
            .len();
        let active = tox_state
            .outgoing_files
            .lock()
            .map_err(|_| "Не удалось проверить активные передачи".to_string())?
            .values()
            .filter(|transfer| transfer.message_id.is_some())
            .count();
        if queued.saturating_add(active) >= MAX_CHAT_FILE_QUEUE {
            wipe_sensitive_bytes(&mut bytes);
            return Err("TRANSFER_QUEUE_LIMIT".to_string());
        }
        if current_self_avatar_matches(&tox_state.avatars_dir, &bytes) {
            log_transfer(
                &tox_state.transfer_log_path,
                format!("AVATAR_COMMAND_SKIP_UNCHANGED bytes={}", bytes.len()),
            );
            wipe_sensitive_bytes(&mut bytes);
            return Ok(0);
        }
        let filename = safe_file_name(&filename);
        let pq_pending = match begin_chat_pq_for_send(
            tox_state,
            friend_number,
            &friend_public_key,
            peer_online,
            connection_revision,
            None,
        ) {
            Ok(protected) => protected,
            Err(error) => {
                wipe_sensitive_bytes(&mut bytes);
                return Err(error);
            }
        };
        let protocol_version = (tox_state.chat_protocol.supports(friend_number)
            || pq_pending && tox_state.pq.is_v2(friend_number))
        .then_some(file_card_protocol::VERSION);
        let id = if protocol_version.is_some() {
            chat_protocol::new_common_message_id()?
        } else {
            new_message_id(friend_number)
        };
        let source_path = outgoing_file_cache_path(&tox_state.outgoing_files_dir, &id, &filename);
        let size = bytes.len() as u64;
        let write_result = profiles::write_file(&source_path, &bytes)
            .map_err(|error| format!("Не удалось подготовить файл: {error}"));
        wipe_sensitive_bytes(&mut bytes);
        write_result?;
        let timestamp = unix_timestamp();
        let path = source_path.to_string_lossy().into_owned();
        tox_state
            .chat_transport_ready
            .store(false, Ordering::Release);
        tox_state
            .pending_files
            .lock()
            .map_err(|_| "Не удалось сохранить очередь файлов".to_string())?
            .push(PendingToxFile {
                id: id.clone(),
                friend_number,
                friend_public_key: friend_public_key.clone(),
                filename: filename.clone(),
                mime: mime.clone(),
                path: path.clone(),
                size,
                timestamp,
                retry_count: 0,
                transfer_id: None,
                announcement_acked: false,
                protocol_version,
            });
        tox_state
            .messages
            .lock()
            .map_err(|_| "Не удалось сохранить сообщение с файлом".to_string())?
            .push(ToxMessage {
                id: id.clone(),
                friend_number,
                friend_public_key: friend_public_key.clone(),
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
                    preview_source: None,
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
                protocol_version,
                operation_id: None,
                quote: None,
                formatting: Vec::new(),
                // Native Tox still transports the attachment bytes. Starting
                // a chat PQ session does not change this payload's protection.
                pq_protected: false,
                reactions: None,
            });
        log_transfer(
            &tox_state.transfer_log_path,
            format!(
                "FILE_QUEUE_ADD friend={friend_number} local_id={id} bytes={size} name={filename}"
            ),
        );
        if let Err(error) =
            persist_pending_files_required(&tox_state.pending_files, &tox_state.pending_files_path)
        {
            if let Ok(mut pending) = tox_state.pending_files.lock() {
                pending.retain(|item| item.id != id);
            }
            if let Ok(mut messages) = tox_state.messages.lock() {
                messages.retain(|message| message.id != id);
            }
            let _ = profiles::remove_file(&source_path);
            return Err(error);
        }
        if let Err(error) = persist_tox_history_required(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        ) {
            if let Ok(mut pending) = tox_state.pending_files.lock() {
                pending.retain(|item| item.id != id);
            }
            if let Ok(mut messages) = tox_state.messages.lock() {
                messages.retain(|message| message.id != id);
            }
            let _ = persist_pending_files_required(
                &tox_state.pending_files,
                &tox_state.pending_files_path,
            );
            let _ = profiles::remove_file(&source_path);
            return Err(error);
        }
        record_friend_event_sequence(
            &tox_state.friend_cache,
            &tox_state.friend_cache_path,
            friend_number,
            &friend_public_key,
        );
        commit_chat_transaction_with_barrier(
            &tox_state.history_path,
            &tox_state.chat_transport_ready,
        )?;
        Ok(0)
    }

    #[tauri::command]
    async fn send_tox_file(
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
        friend_number: u32,
        filename: String,
        mime: String,
        mut bytes: Vec<u8>,
    ) -> Result<u32, String> {
        let tox_state = match app_state.loaded_profile(&profile_id) {
            Ok(state) => state,
            Err(error) => {
                wipe_sensitive_bytes(&mut bytes);
                return Err(error);
            }
        };
        tauri::async_runtime::spawn_blocking(move || {
            queue_tox_file_for_state(tox_state, friend_number, None, filename, mime, bytes)
        })
        .await
        .map_err(|error| format!("File queue task stopped unexpectedly: {error}"))?
    }

    fn validated_portable_file(paths: &PortablePaths, path: &str) -> Result<PathBuf, String> {
        let source = PathBuf::from(path);
        let source = if source.is_absolute() {
            source
        } else {
            paths.root_dir.join(source)
        };
        let source = fs::canonicalize(&source).map_err(|error| {
            format!("Could not locate attachment {}: {error}", source.display())
        })?;
        let portable_root = fs::canonicalize(&paths.root_dir)
            .map_err(|error| format!("Could not verify portable directory: {error}"))?;
        if !source.starts_with(&portable_root) || !source.is_file() {
            return Err("Attachment is outside the portable application directory".to_string());
        }
        Ok(source)
    }

    pub(super) fn validated_download_file(
        paths: &PortablePaths,
        path: &str,
    ) -> Result<PathBuf, String> {
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
                .map_err(|error| {
                    format!("Could not show {} in Explorer: {error}", source.display())
                })?;
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .args(["-R", source.to_string_lossy().as_ref()])
                .spawn()
                .map_err(|error| {
                    format!("Could not reveal {} in Finder: {error}", source.display())
                })?;
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
        if kai::managed_volume(logs).is_some() {
            return Err("KAI_LOGS_STORED_IN_ENCRYPTED_CONTAINER".to_string());
        }
        profiles::create_dir_all(logs)
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
    fn open_project_repository(app: tauri::AppHandle) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;

        app.opener()
            .open_url("https://github.com/kaigendev/Kaigen", None::<&str>)
            .map_err(|error| format!("Could not open the Kaigen repository: {error}"))
    }

    fn validated_external_url(value: &str) -> Result<tauri::Url, String> {
        if value.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '\\'
        }) || !value.split_once("://").is_some_and(|(scheme, _)| {
            scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
        }) {
            return Err("EXTERNAL_URL_INVALID".to_string());
        }
        let url = tauri::Url::parse(value).map_err(|_| "EXTERNAL_URL_INVALID".to_string())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none_or(str::is_empty)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("EXTERNAL_URL_INVALID".to_string());
        }
        Ok(url)
    }

    #[tauri::command]
    fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;

        let url = validated_external_url(&url)?;
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|error| format!("Could not open the web link: {error}"))
    }

    #[cfg(test)]
    mod external_url_tests {
        use super::validated_external_url;

        #[test]
        fn web_urls_preserve_queries_and_support_unicode_domains_and_paths() {
            for value in [
                "http://example.com/",
                "https://example.com/path?q=a%20b&n=1#part",
                "HTTPS://EXAMPLE.COM:8443/path",
                "https://пример.рф/путь?q=значение#якорь",
            ] {
                let url = validated_external_url(value).unwrap();
                assert!(matches!(url.scheme(), "http" | "https"));
                assert!(url.host_str().is_some());
            }
            let url = validated_external_url("https://example.com/path?q=a%20b&n=1#part").unwrap();
            assert_eq!(url.query(), Some("q=a%20b&n=1"));
            assert_eq!(url.fragment(), Some("part"));
            let unicode = validated_external_url("https://пример.рф/путь").unwrap();
            assert_eq!(unicode.host_str(), Some("xn--e1afmkfd.xn--p1ai"));
            assert_eq!(unicode.path(), "/%D0%BF%D1%83%D1%82%D1%8C");
        }

        #[test]
        fn non_web_malformed_credential_and_control_urls_are_rejected() {
            for value in [
                "javascript:alert(1)",
                "data:text/html,test",
                "file:///C:/data",
                "mailto:user@example.com",
                "https://",
                "https:/example.com",
                "http:example.com",
                "/relative",
                "www.example.com",
                "https://exa mple.com",
                " https://example.com",
                "https://example.com\n/path",
                "https://example.com/\rtest",
                "https://example.com/\u{0}test",
                "https://example.com/\u{7f}test",
                "https://example.com\\other",
                "https://user:password@example.com/",
                "https://user@example.com/",
                "https://[invalid/",
            ] {
                assert_eq!(
                    validated_external_url(value).unwrap_err(),
                    "EXTERNAL_URL_INVALID",
                    "{value:?}"
                );
            }
        }
    }

    #[tauri::command]
    async fn send_tox_file_from_grant(
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
        friend_number: u32,
        grant_token: String,
    ) -> Result<u32, String> {
        let app_state = app_state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            send_tox_file_from_grant_blocking(&app_state, profile_id, friend_number, grant_token)
        })
        .await
        .map_err(|error| format!("Native file queue task stopped unexpectedly: {error}"))?
    }

    fn send_tox_file_from_grant_blocking(
        app_state: &AppState,
        profile_id: String,
        friend_number: u32,
        grant_token: String,
    ) -> Result<u32, String> {
        // Resolve the profile captured when the picker opened. The grant is
        // already bound to this profile and recipient, so a later UI switch
        // must neither redirect nor unnecessarily fail the queued send.
        let tox_state = app_state.loaded_profile(&profile_id)?;
        let recipient_public_key = tox_state.stable_friend_public_key(friend_number);
        if recipient_public_key.is_empty() {
            return Err("FRIEND_NOT_FOUND".to_string());
        }
        let selected = app_state
            .native_file_grants
            .lock()
            .map_err(|_| "Could not access native file grants".to_string())?
            .consume(&grant_token, &profile_id, &recipient_public_key)?;
        queue_tox_file_for_state(
            tox_state,
            friend_number,
            Some(recipient_public_key),
            selected.name,
            selected.mime,
            selected.bytes,
        )
    }

    #[tauri::command]
    fn discard_native_file_grant(
        app_state: tauri::State<'_, AppState>,
        grant_token: String,
    ) -> Result<(), String> {
        app_state
            .native_file_grants
            .lock()
            .map_err(|_| "Could not access native file grants".to_string())?
            .discard(&grant_token);
        Ok(())
    }

    #[tauri::command]
    fn control_tox_file_transfer(
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
        friend_number: u32,
        message_id: String,
        action: String,
    ) -> Result<(), String> {
        let tox_state = app_state.loaded_profile(&profile_id)?;
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
                pending
                    .retain(|file| !(file.friend_number == friend_number && file.id == message_id));
                before != pending.len()
            };
            let outgoing_key = tox_state.outgoing_files.lock().ok().and_then(|files| {
                files.iter().find_map(|(key, file)| {
                    (key.0 == friend_number
                        && file.message_id.as_deref() == Some(message_id.as_str()))
                    .then_some(*key)
                })
            });
            let incoming_key = tox_state.incoming_files.lock().ok().and_then(|files| {
                files.iter().find_map(|(key, file)| {
                    (key.0 == friend_number
                        && file.message_id.as_deref() == Some(message_id.as_str()))
                    .then_some(*key)
                })
            });

            // A protocol cancel is best-effort: local cancellation must never be blocked
            // by a stale Tox file number or by a peer that is currently offline.
            let active_transfer = outgoing_key
                .map(|key| (key, true))
                .or_else(|| incoming_key.map(|key| (key, false)));
            if let Some(((friend, file_number), outgoing)) = active_transfer {
                let mut removed_with_handle = false;
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
                        let removed = remove_file_transfer_for_direction(
                            &tox_state.outgoing_files,
                            &tox_state.incoming_files,
                            (friend, file_number),
                            outgoing,
                        );
                        removed_with_handle = true;
                        if let Some(transfer) = removed {
                            let _ = profiles::remove_file(&transfer.path);
                        }
                        if !outgoing {
                            resume_next_queued_incoming_for_state(
                                instance.instance.as_ptr(),
                                &tox_state,
                            );
                        }
                    }
                }
                // Local state must still terminate if the native handle is in
                // the middle of a rebuild. Housekeeping will resume the next
                // queued incoming transfer once the handle becomes available.
                if !removed_with_handle {
                    let removed = remove_file_transfer_for_direction(
                        &tox_state.outgoing_files,
                        &tox_state.incoming_files,
                        (friend, file_number),
                        outgoing,
                    );
                    if let Some(transfer) = removed {
                        let _ = profiles::remove_file(&transfer.path);
                    }
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
            finish_file_card_runtime_state(
                &tox_state.messages,
                &tox_state.history_residency,
                &tox_state.file_card_protocol,
                friend_number,
                &message_id,
            );
            log_transfer(&tox_state.transfer_log_path, format!("FILE_CONTROL_CANCELLED_LOCAL friend={friend_number} message={message_id} queued={removed_from_queue}"));
            return Ok(());
        }

        let state = tox_state
            .handle
            .lock()
            .map_err(|_| "Unable to access Tox profile".to_string())?;
        let outgoing_key = tox_state.outgoing_files.lock().ok().and_then(|files| {
            files.iter().find_map(|(key, file)| {
                if key.0 == friend_number && file.message_id.as_deref() == Some(message_id.as_str())
                {
                    Some(*key)
                } else {
                    None
                }
            })
        });
        let incoming_key = tox_state.incoming_files.lock().ok().and_then(|files| {
            files.iter().find_map(|(key, file)| {
                if key.0 == friend_number && file.message_id.as_deref() == Some(message_id.as_str())
                {
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
            drop_cached_message_if_inactive_evicted(
                &tox_state.messages,
                &tox_state.history_residency,
                &message_id,
            );
            return Err("Active transfer was not found".to_string());
        };

        if !outgoing && action == "resume" {
            let settings = tox_state
                .file_receive_settings
                .lock()
                .map_err(|_| "FILE_SETTINGS_UNAVAILABLE".to_string())?;
            if settings.deny_all {
                return Err("FILE_RECEIVE_DENIED".to_string());
            }
            let maximum = settings.max_concurrent.clamp(1, 2);
            drop(settings);
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
                        file.locally_paused = false;
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
        // toxcore reports a state that is already reached as an error.  A repeated
        // pause (6 = already paused) or resume (4 = not paused) is still the
        // requested end state, so accept it instead of leaving the UI stale.
        let already_in_requested_state =
            (action == "pause" && error == 6) || (action == "resume" && error == 4);
        if (!ok || error != 0) && !already_in_requested_state {
            drop(state);
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
            drop_cached_message_if_inactive_evicted(
                &tox_state.messages,
                &tox_state.history_residency,
                &message_id,
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
        if outgoing {
            if let Ok(mut files) = tox_state.outgoing_files.lock() {
                if let Some(file) = files.get_mut(&(friend, file_number)) {
                    file.set_local_paused(action == "pause", Instant::now());
                }
            }
        } else {
            if let Ok(mut files) = tox_state.incoming_files.lock() {
                if let Some(file) = files.get_mut(&(friend, file_number)) {
                    file.set_local_paused(action == "pause", Instant::now());
                    file.auto_queued = false;
                }
            }
        }
        // Publish local intent before releasing the native handle: tox_iterate
        // must not deliver a peer RESUME between our control and this state.
        drop(state);
        if !outgoing && action == "pause" {
            if let Ok(state) = tox_state.handle.lock() {
                if let Some(instance) = state.as_ref() {
                    resume_next_queued_incoming_for_state(instance.instance.as_ptr(), &tox_state);
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
        profile_id: Option<String>,
    ) -> Result<FileReceiveSettings, String> {
        let tox_state = match profile_id {
            Some(profile_id) => app_state.loaded_profile(&profile_id)?,
            None => app_state.active()?,
        };
        let settings = tox_state
            .file_receive_settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "Could not read file receive settings".to_string())?;
        Ok(settings)
    }

    #[tauri::command]
    fn set_file_receive_settings(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        settings: FileReceiveSettings,
    ) -> Result<FileReceiveSettings, String> {
        let tox_state = match profile_id {
            Some(profile_id) => app_state.loaded_profile(&profile_id)?,
            None => app_state.active()?,
        };
        set_file_receive_settings_for_state(&tox_state, settings)
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
        tauri::async_runtime::spawn_blocking(move || {
            set_proxy_settings_blocking(&app_state, settings)
        })
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
            .map_err(|_| "Could not update the shared proxy settings".to_string())? =
            settings.clone();
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
    fn get_network_settings(
        app_state: tauri::State<'_, AppState>,
    ) -> Result<NetworkSettings, String> {
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
            let credentials = (!settings.username.is_empty() || !settings.password.is_empty())
                .then(|| {
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
    async fn retry_tox_file_transfer(
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
        friend_number: u32,
        message_id: String,
    ) -> Result<(), String> {
        let tox_state = app_state.loaded_profile(&profile_id)?;
        tauri::async_runtime::spawn_blocking(move || {
            retry_tox_file_transfer_for_state(&tox_state, friend_number, message_id)
        })
        .await
        .map_err(|error| format!("File retry task stopped unexpectedly: {error}"))?
    }

    fn retry_tox_file_transfer_for_state(
        tox_state: &ToxState,
        friend_number: u32,
        message_id: String,
    ) -> Result<(), String> {
        let (friend_public_key, _transaction) =
            lock_chat_transaction_for_friend(tox_state, friend_number)?;
        let message = chat_history_store::find_message_registered(
            &tox_state.history_path,
            friend_number,
            &friend_public_key,
            &message_id,
        )?
        .ok_or_else(|| "File transfer card was not found".to_string())?;
        let attachment = message
            .attachment
            .clone()
            .ok_or_else(|| "File transfer card was not found".to_string())?;
        let path = PathBuf::from(&attachment.path);
        let size = profiles::metadata_len(&path)
            .map_err(|_| "Исходный файл больше недоступен для повторной отправки".to_string())?;
        if size == 0 {
            return Err("Нельзя отправить пустой файл".to_string());
        }
        if size != attachment.size {
            return Err("Исходный файл изменился. Выберите его заново.".to_string());
        }
        let transfer_id = if message.protocol_version == Some(file_card_protocol::VERSION) {
            Some(
                tox_state
                    .file_card_protocol
                    .offer_for_retry(
                        friend_number,
                        &friend_public_key,
                        &message_id,
                        &attachment.name,
                        size,
                    )?
                    .transfer_id_hex(),
            )
        } else {
            None
        };
        tox_state
            .chat_transport_ready
            .store(false, Ordering::Release);
        let announcement_acked = transfer_id.is_some()
            && tox_state
                .file_card_protocol
                .outgoing_acknowledgement(friend_number, &friend_public_key, &message_id)
                .is_some_and(|status| {
                    matches!(
                        status,
                        FileCardAckStatus::Applied | FileCardAckStatus::Duplicate
                    )
                });

        {
            let mut pending = tox_state
                .pending_files
                .lock()
                .map_err(|_| "Unable to access pending files".to_string())?;
            pending.retain(|file| !(file.friend_number == friend_number && file.id == message_id));
            pending.push(PendingToxFile {
                id: message_id.clone(),
                friend_number,
                friend_public_key: friend_public_key.clone(),
                filename: attachment.name,
                mime: attachment.mime,
                path: attachment.path,
                size,
                timestamp: unix_timestamp(),
                retry_count: 0,
                transfer_id,
                announcement_acked,
                protocol_version: message.protocol_version,
            });
        }
        set_attachment_retrying(&tox_state.messages, &message_id, 0);
        if let Ok(mut messages) = tox_state.messages.lock() {
            if let Some(row) = messages.iter_mut().find(|row| {
                row.mine
                    && row.id == message_id
                    && message_matches_friend(row, friend_number, &friend_public_key)
            }) {
                row.delivery = "pending".to_string();
                row.delivered_at = None;
            }
        }
        persist_pending_files_required(&tox_state.pending_files, &tox_state.pending_files_path)?;
        persist_tox_history_required(
            &tox_state.messages,
            &tox_state.history_path,
            &tox_state.history_enabled,
        )?;
        commit_chat_transaction_with_barrier(
            &tox_state.history_path,
            &tox_state.chat_transport_ready,
        )?;
        bump_history_revision(&tox_state.history_path);
        if let Some(updates) = &tox_state.updates {
            updates.changed();
        }
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
        send_tox_avatar_for_shared_state(tox_state, filename, bytes)
    }

    #[tauri::command]
    fn set_chat_history_enabled(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        enabled: bool,
    ) -> Result<(), String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        tox_state.history_enabled.store(enabled, Ordering::Relaxed);
        if enabled {
            persist_tox_history(
                &tox_state.messages,
                &tox_state.history_path,
                &tox_state.history_enabled,
            );
        } else if let Ok(mut messages) = tox_state.messages.lock() {
            messages.retain(message_requires_runtime_residency);
        }
        invalidate_chat_view_revisions(&tox_state.history_path);
        Ok(())
    }

    #[tauri::command]
    fn clear_tox_history(
        app_state: tauri::State<'_, AppState>,
        profile_id: Option<String>,
        friend_number: Option<u32>,
    ) -> Result<(), String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        let (friend_public_key, _transaction) =
            resolve_then_lock_chat_transaction(&tox_state.chat_transaction_gate, || {
                Ok(friend_number
                    .map(|number| tox_state.stable_friend_public_key(number))
                    .unwrap_or_default())
            })?;
        let retained_file_cards = active_file_card_message_ids(&tox_state);
        let mut messages = tox_state
            .messages
            .lock()
            .map_err(|_| "Unable to clear chat history".to_string())?;
        if let Some(friend_number) = friend_number {
            messages.retain(|message| {
                !message_matches_friend(message, friend_number, &friend_public_key)
            });
        } else {
            messages.clear();
        }
        let cleared = enqueue_registered_history_clear_required(
            &tox_state.history_path,
            friend_number.map(|friend_number| (friend_number, friend_public_key.as_str())),
        );
        drop(messages);
        wait_for_registered_history_write(cleared?)?;
        if let Some(friend_number) = friend_number {
            tox_state
                .chat_protocol
                .clear_friend_history_state(friend_number, &friend_public_key)?;
            tox_state.file_card_protocol.retain_friend_messages(
                friend_number,
                &friend_public_key,
                &retained_file_cards,
            )?;
        } else {
            tox_state.chat_protocol.clear_history_state()?;
            tox_state
                .file_card_protocol
                .retain_messages(|binding| retained_file_cards.contains(&binding.message_id))?;
        }
        bump_history_revision(&tox_state.history_path);
        if let Ok(mut unread) = tox_state.unread_state.lock() {
            if let Some(friend_number) = friend_number {
                unread.friends.remove(&friend_number.to_string());
                unread
                    .unseen_messages
                    .remove(&unread_target_key(friend_number, &friend_public_key));
            } else {
                unread.friends.clear();
                unread.unseen_messages.clear();
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
            fn FileTimeToSystemTime(
                file_time: *const FileTime,
                system_time: *mut SystemTime,
            ) -> i32;
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
        profile_id: Option<String>,
        friend_number: u32,
        contact_name: String,
        contact_id: String,
    ) -> Result<String, String> {
        let tox_state = match profile_id.as_deref() {
            Some(profile_id) => app_state.loaded_profile(profile_id)?,
            None => app_state.active()?,
        };
        let friend_public_key = tox_state.stable_friend_public_key(friend_number);
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
        let temporary = destination.with_extension(format!(
            "{}.writing",
            destination
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("txt")
        ));
        let write_result = (|| -> Result<(), String> {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("Could not create chat export: {error}"))?;
            let mut writer = BufWriter::with_capacity(64 * 1024, file);
            let mut offset = 0usize;
            loop {
                let page = chat_history_store::page_registered(
                    &tox_state.history_path,
                    friend_number,
                    &friend_public_key,
                    offset,
                    128,
                )?;
                for message in page.messages {
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
                    writer
                        .write_all(format!("{stamp}\r\n{author}: {body}\r\n\r\n").as_bytes())
                        .map_err(|error| format!("Could not write chat export: {error}"))?;
                }
                if !page.has_more {
                    break;
                }
                offset = page.next_offset;
            }
            writer
                .flush()
                .and_then(|_| writer.get_ref().sync_all())
                .map_err(|error| format!("Could not flush chat export: {error}"))
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        fs::rename(&temporary, &destination).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("Could not commit chat export: {error}")
        })?;
        Ok(destination.to_string_lossy().into_owned())
    }

    #[tauri::command]
    async fn delete_tox_friend(
        app_state: tauri::State<'_, AppState>,
        friend_number: u32,
    ) -> Result<(), String> {
        let tox_state = app_state.active()?;
        tauri::async_runtime::spawn_blocking(move || {
            delete_tox_friend_for_state(&tox_state, friend_number)
        })
        .await
        .map_err(|_| "CHAT_CONTACT_DELETE_TASK_FAILED".to_string())?
    }

    pub(super) fn delete_tox_friend_for_state(
        tox_state: &ToxState,
        friend_number: u32,
    ) -> Result<(), String> {
        let state = tox_state
            .handle
            .lock()
            .map_err(|_| "Unable to access Tox profile".to_string())?;
        let instance = state
            .as_ref()
            .ok_or_else(|| "Tox profile is not initialised".to_string())?;
        let friend_public_key =
            tox_friend_public_key(instance.instance.as_ptr(), friend_number).unwrap_or_default();
        if friend_public_key.is_empty() {
            return Err("CHAT_CONTACT_NOT_FOUND".into());
        }
        // Match the network loop's handle -> transaction lock order.
        let _transaction = tox_state
            .chat_transaction_gate
            .lock()
            .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
        bind_pq_contact(
            &tox_state.pq,
            &tox_state.messages,
            &tox_state.history_path,
            friend_number,
            &friend_public_key,
            &pq_tox_owner(instance.instance.as_ptr()),
        )?;

        // Snapshot every durable unsent item before changing toxcore. If the same
        // public key is added again later, these records must not silently resume;
        // the recovery JSON keeps both text and file references user-recoverable.
        let mut pending_messages = tox_state
            .pending_messages
            .lock()
            .map_err(|_| "Unable to access queued messages".to_string())?;
        let mut pending_pq_messages = tox_state
            .pending_pq_messages
            .lock()
            .map_err(|_| "Unable to access queued PQ messages".to_string())?;
        let mut pending_files = tox_state
            .pending_files
            .lock()
            .map_err(|_| "Unable to access queued files".to_string())?;
        let recovery = DeletedContactQueueRecovery {
            version: 1,
            quarantined_at: unix_timestamp(),
            friend_number,
            friend_public_key: friend_public_key.clone(),
            pending_messages: pending_messages
                .iter()
                .filter(|item| {
                    friend_identity_matches(
                        item.friend_number,
                        &item.friend_public_key,
                        friend_number,
                        &friend_public_key,
                    )
                })
                .cloned()
                .collect(),
            pending_pq_messages: pending_pq_messages
                .iter()
                .filter(|item| {
                    friend_identity_matches(
                        item.friend_number,
                        &item.friend_public_key,
                        friend_number,
                        &friend_public_key,
                    )
                })
                .cloned()
                .collect(),
            pending_files: pending_files
                .iter()
                .filter(|item| {
                    friend_identity_matches(
                        item.friend_number,
                        &item.friend_public_key,
                        friend_number,
                        &friend_public_key,
                    )
                })
                .cloned()
                .collect(),
        };
        let recovery_path = if recovery.pending_messages.is_empty()
            && recovery.pending_pq_messages.is_empty()
            && recovery.pending_files.is_empty()
        {
            None
        } else {
            let directory = tox_state
                .pending_messages_path
                .parent()
                .unwrap_or(&tox_state.pending_messages_path)
                .join("deleted-contact-recovery");
            profiles::create_dir_all(&directory)
                .map_err(|error| format!("Unable to create contact recovery directory: {error}"))?;
            let identity = if friend_public_key.is_empty() {
                format!("number-{friend_number}")
            } else {
                friend_public_key.chars().take(16).collect()
            };
            let path = unique_download_path(
                &directory,
                &format!("{}-{identity}.json", recovery.quarantined_at),
            );
            atomic_write(
                &path,
                &serde_json::to_vec_pretty(&recovery)
                    .map_err(|error| format!("Unable to encode contact recovery data: {error}"))?,
            )?;
            Some(path)
        };

        // This also checkpoints the recovery copy before deleting its live
        // source. A later re-add cannot publish archived PQ ciphertext.
        tox_state
            .chat_transport_ready
            .store(false, Ordering::Release);
        tox_state
            .pq
            .remove_friend(friend_number, Some(&friend_public_key))?;
        let mut error = 0_i32;
        if !unsafe { tox_friend_delete(instance.instance.as_ptr(), friend_number, &mut error) } {
            return Err(format!("Unable to delete Tox contact (code {error})"));
        }
        pending_messages.retain(|item| {
            !friend_identity_matches(
                item.friend_number,
                &item.friend_public_key,
                friend_number,
                &friend_public_key,
            )
        });
        pending_pq_messages.retain(|item| {
            !friend_identity_matches(
                item.friend_number,
                &item.friend_public_key,
                friend_number,
                &friend_public_key,
            )
        });
        pending_files.retain(|item| {
            !friend_identity_matches(
                item.friend_number,
                &item.friend_public_key,
                friend_number,
                &friend_public_key,
            )
        });
        let save_result = ToxState::save(instance);
        drop(state);
        drop(pending_messages);
        drop(pending_pq_messages);
        drop(pending_files);
        persist_pending_messages_required(
            &tox_state.pending_messages,
            &tox_state.pending_messages_path,
        )?;
        persist_pending_messages_required(
            &tox_state.pending_pq_messages,
            &tox_state.pending_pq_messages_path,
        )?;
        persist_pending_files_required(&tox_state.pending_files, &tox_state.pending_files_path)?;
        save_result?;

        // toxcore may give this numeric slot to another public key immediately.
        // Quarantine live protocol/receipt/transfer state that cannot be resumed.
        tox_state
            .chat_protocol
            .remove_friend(friend_number, &friend_public_key)?;
        tox_state
            .file_card_protocol
            .remove_friend(friend_number, &friend_public_key)?;
        if let Ok(mut receipts) = tox_state.delivery_receipts.lock() {
            receipts.retain(|(receipt_friend, _), _| *receipt_friend != friend_number);
        }
        if let Ok(mut receipts) = tox_state.pq_receipts.lock() {
            receipts.retain(|(receipt_friend, _), _| *receipt_friend != friend_number);
        }
        if let Ok(mut files) = tox_state.incoming_files.lock() {
            files.retain(|(file_friend, _), _| *file_friend != friend_number);
        }
        if let Ok(mut files) = tox_state.outgoing_files.lock() {
            files.retain(|(file_friend, _), _| *file_friend != friend_number);
        }
        let avatar_owner = if friend_public_key.is_empty() {
            format!("deleted-number-{friend_number}")
        } else {
            friend_public_key.clone()
        };
        reconcile_friend_avatar_files(
            &tox_state.avatars_dir,
            &HashMap::from([(avatar_owner, friend_number)]),
            &HashMap::new(),
        );
        let cache_write = if let Ok(mut cache) = tox_state.friend_cache.lock() {
            if let Some(profile) = cache.get_mut(&friend_public_key) {
                profile.authorized = false;
                profile.friend_number = None;
                profile.pending_authorization = false;
                profile.authorization_message.clear();
                profile.authorization_last_refreshed_at = 0;
            }
            Some(enqueue_friend_cache_write_required(
                &cache,
                &tox_state.friend_cache_path,
            )?)
        } else {
            None
        };
        if let Some(completed) = cache_write {
            wait_for_atomic_write(completed)?;
        }
        if let Some(path) = recovery_path {
            log_network(
                &tox_state.network_log_path,
                format!("FRIEND_DELETE_QUEUE_QUARANTINE path={}", path.display()),
            );
        }

        let mut messages = tox_state
            .messages
            .lock()
            .map_err(|_| "Unable to clear chat history".to_string())?;
        messages
            .retain(|message| !message_matches_friend(message, friend_number, &friend_public_key));
        let cleared = enqueue_registered_history_clear_required(
            &tox_state.history_path,
            Some((friend_number, &friend_public_key)),
        );
        drop(messages);
        wait_for_registered_history_write(cleared?)?;
        bump_history_revision(&tox_state.history_path);
        if let Ok(mut unread) = tox_state.unread_state.lock() {
            unread.friends.remove(&friend_number.to_string());
            unread
                .unseen_messages
                .remove(&unread_target_key(friend_number, &friend_public_key));
        }
        persist_unread_state_required(&tox_state.unread_state, &tox_state.unread_state_path)?;
        commit_chat_transaction_with_barrier(
            &tox_state.history_path,
            &tox_state.chat_transport_ready,
        )
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
        let number = unsafe {
            tox_friend_add_norequest(instance.instance.as_ptr(), key.as_ptr(), &mut error)
        };
        if error != 0 {
            return Err(format!("Не удалось принять запрос Tox (код {error})"));
        }
        ToxState::save(instance)?;
        drop(state);
        if let Ok(mut cache) = tox_state.friend_cache.lock() {
            let entry = cache.entry(public_key.clone()).or_default();
            entry.authorized = true;
            entry.friend_number = Some(number);
            entry.pending_authorization = false;
            entry.authorization_message.clear();
            entry.added_at.get_or_insert_with(unix_timestamp);
            entry.added_event_sequence = next_chat_event_sequence();
            if let Ok(serialized) = serde_json::to_vec(&*cache) {
                let _ = atomic_write_sender().try_send(AtomicWriteRequest::Write {
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
    async fn get_tox_network_status(
        app_state: tauri::State<'_, AppState>,
    ) -> Result<String, String> {
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
    async fn get_tor_settings(
        app_state: tauri::State<'_, AppState>,
    ) -> Result<TorSettings, String> {
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
        tauri::async_runtime::spawn_blocking(move || {
            set_tor_settings_blocking(&app_state, settings)
        })
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
    fn set_profile_user_status(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
        profile_id: String,
        status: String,
    ) -> Result<String, String> {
        let tox_state = app_state
            .profiles
            .lock()
            .map_err(|_| "Could not access loaded profiles".to_string())?
            .get(&profile_id)
            .cloned()
            .ok_or_else(|| "PROFILE_NOT_LOADED".to_string())?;
        let result = set_user_status_inner(&tox_state, &status)?;
        update_tray(&app, &app_state);
        let _ = app.emit("profiles-changed", &profile_id);
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

    #[tauri::command]
    fn get_tox_status_message(app_state: tauri::State<'_, AppState>) -> Result<String, String> {
        let tox_state = app_state.active()?;
        let state = tox_state
            .handle
            .lock()
            .map_err(|_| "Не удалось получить доступ к профилю Tox".to_string())?;
        let instance = state
            .as_ref()
            .ok_or_else(|| "Профиль Tox не инициализирован".to_string())?;
        let mut error = 0;
        let length =
            unsafe { tox_self_get_status_message_size(instance.instance.as_ptr(), &mut error) };
        if error != 0 {
            return Err(format!("Не удалось получить статус Tox (код {error})"));
        }
        if length == 0 {
            return Ok(String::new());
        }
        let mut bytes = vec![0_u8; length];
        error = 0;
        if !unsafe {
            tox_self_get_status_message(instance.instance.as_ptr(), bytes.as_mut_ptr(), &mut error)
        } {
            return Err(format!("Не удалось прочитать статус Tox (код {error})"));
        }
        Ok(normalize_status_message(&String::from_utf8_lossy(&bytes)))
    }

    #[tauri::command]
    fn set_tox_status_message(
        app_state: tauri::State<'_, AppState>,
        message: String,
    ) -> Result<String, String> {
        let tox_state = app_state.active()?;
        let value = normalize_status_message(&message);
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
        let instance_outcome = match InstanceGuard::acquire_for_current_executable() {
            Ok(outcome) => outcome,
            Err(error) => {
                instance::report_startup_error(&error);
                return;
            }
        };
        let instance_guard = match instance_outcome {
            InstanceOutcome::Primary(guard) => guard,
            InstanceOutcome::SecondaryActivated => return,
        };
        if let Err(error) = configure_portable_webview() {
            instance::report_startup_error(&error);
            return;
        }
        let app = tauri::Builder::default()
            .setup(move |app| {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_icon(tray_base_image()).map_err(|error| {
                        format!("Could not set the Kaigen window icon: {error}")
                    })?;
                }
                let app_state = AppState::new(app.handle().clone())
                    .map_err(|error| format!("Toxcore could not initialise: {error}"))?;
                let language = app_state
                    .settings
                    .lock()
                    .map(|settings| settings.language.clone())
                    .unwrap_or_else(|_| "ru".to_string());
                app.manage(app_state);
                webview_recovery::setup(app)
                    .map_err(|error| format!("Could not start WebView recovery: {error}"))?;
                #[cfg(unix)]
                install_termination_signal_bridge(app.handle().clone())?;
                let tray_items = create_tray(app, &language)
                    .map_err(|error| format!("Could not create the Kaigen tray icon: {error}"))?;
                app.manage(tray_items);
                update_tray(app.handle(), &app.state::<AppState>());
                instance_guard.start_activation_listener(app.handle().clone());
                app.manage(instance_guard);
                Ok(())
            })
            .on_window_event(|window, event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
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
                        webview_recovery::stop(window.app_handle());
                        stop_owned_services(&state);
                    }
                }
                tauri::WindowEvent::DragDrop(drag) if window.label() == "main" => match drag {
                    tauri::DragDropEvent::Enter { .. } | tauri::DragDropEvent::Over { .. } => {
                        let _ = window.emit("native-file-drag-state", "over");
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = window.emit("native-file-drag-state", "leave");
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let _ = window.emit("native-file-drag-state", "drop");
                        let state = window.state::<AppState>();
                        let target = state
                            .native_file_drop_target
                            .lock()
                            .ok()
                            .and_then(|target| target.clone());
                        let Some(target) = target else {
                            return;
                        };
                        let target_is_current = state
                            .loaded_profile(&target.profile_id)
                            .map(|profile| {
                                profile.stable_friend_public_key(target.friend_number)
                                    == target.recipient_public_key
                            })
                            .unwrap_or(false);
                        if !target_is_current {
                            let _ =
                                window.emit("native-file-drop-error", "FILE_DROP_TARGET_CHANGED");
                            return;
                        }
                        match issue_native_file_batch(
                            &state,
                            paths.clone(),
                            target.profile_id.clone(),
                            target.recipient_public_key,
                        ) {
                            Ok(batch) => {
                                let _ = window.emit(
                                    "native-file-drop-ready",
                                    NativeFileDropBatch {
                                        profile_id: target.profile_id,
                                        friend_number: target.friend_number,
                                        batch,
                                    },
                                );
                            }
                            Err(_) => {
                                let _ = window
                                    .emit("native-file-drop-error", "FILE_DROP_PREPARATION_FAILED");
                            }
                        }
                    }
                    _ => {}
                },
                _ => {}
            })
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(
                tauri_plugin_opener::Builder::new()
                    .open_js_links_on_click(false)
                    .build(),
            )
            .invoke_handler(tauri::generate_handler![
                get_startup_state,
                report_webview_heartbeat,
                set_app_language,
                set_close_to_tray,
                exit_application,
                get_unread_state,
                mark_friend_read,
                acknowledge_local_messages,
                mark_requests_read,
                unlock_profile,
                continue_with_loaded_profiles,
                disable_profile,
                switch_profile,
                create_profile,
                discover_qtox_profiles,
                import_qtox_profile,
                export_qtox_profile,
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
                release_chat_history,
                refresh_chat_history_lease,
                search_tox_messages,
                get_chat_capabilities,
                send_tox_message,
                set_message_reactions,
                get_pq_status,
                begin_pq_entropy,
                complete_pq_identity,
                skip_pq_auto,
                request_pq_session,
                withdraw_pq_session,
                accept_pq_session,
                reject_pq_session,
                request_pq_shutdown,
                send_tox_file,
                pick_tox_files,
                stage_clipboard_image_for_chat,
                set_native_file_drop_target,
                send_tox_file_from_grant,
                discard_native_file_grant,
                show_attachment_in_folder,
                copy_attachment_to_clipboard,
                open_downloads_directory,
                open_logs_directory,
                open_license_information,
                open_project_repository,
                open_external_url,
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
                pick_profile_avatar_data_url,
                open_native_dialog,
                get_incoming_friend_requests,
                accept_incoming_friend_request,
                get_tor_settings,
                get_tor_status,
                set_tor_settings,
                restart_tor,
                get_tox_network_status,
                get_tox_user_status,
                set_tox_user_status,
                set_profile_user_status,
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
                webview_recovery::stop(app_handle);
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut grants) = state.native_file_grants.lock() {
                        grants.clear_all();
                    }
                    stop_owned_services(&state);
                }
            }
        });
    }

    pub(super) fn stop_owned_services(state: &AppState) {
        if !begin_owned_service_shutdown(&state.shutdown_started) {
            return;
        }
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
                persist_pending_messages_now(
                    &profile.pending_messages,
                    &profile.pending_messages_path,
                );
                persist_pending_messages_now(
                    &profile.pending_pq_messages,
                    &profile.pending_pq_messages_path,
                );
                let cache_write = profile.friend_cache.lock().ok().and_then(|cache| {
                    enqueue_friend_cache_write_required(&cache, &profile.friend_cache_path).ok()
                });
                if let Some(completed) = cache_write {
                    let _ = wait_for_atomic_write(completed);
                }
                let _ = profile.checkpoint_profile(true);
            }
        }
    }
}

#[cfg(feature = "desktop")]
pub use desktop_adapter::run;

#[cfg(feature = "desktop")]
fn request_application_exit(app: &tauri::AppHandle, state: &AppState) {
    state.exit_requested.store(true, Ordering::Relaxed);
    if let Ok(mut grants) = state.native_file_grants.lock() {
        grants.clear_all();
    }
    webview_recovery::stop(app);
    desktop_adapter::stop_owned_services(state);
    app.exit(0);
}
