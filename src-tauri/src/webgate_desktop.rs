//! Desktop IPC for remote profiles. No command here creates local Tox state.

use super::*;
use crate::{
    webgate::{ConnectionCard, ProxyMode, ProxyRoute, TransportPolicy},
    webgate_host::WebgateHost,
    webgate_persistence::{PersistedConnections, MAX_CONNECTION_STORE_BYTES},
};

/// Decrypt only the minimal connection catalogue, then restore transports in
/// background. It is safe to call this before the first local Tox profile exists.
pub(crate) fn initialize_persistence(state: &AppState) -> Result<(), String> {
    static INITIALIZE: Mutex<()> = Mutex::new(());
    let _initialize = INITIALIZE.lock().map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
    if state.remote_profiles.has_store() {
        return Ok(());
    }
    let path = state.data_dir.join("webgate-connections.enc");
    let records = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > (MAX_CONNECTION_STORE_BYTES + 64 * 1024) as u64
            {
                return Err("WEBGATE_STORE_INVALID".into());
            }
            let ciphertext = fs::read(&path).map_err(|_| "WEBGATE_STORE_READ_FAILED")?;
            let mut plaintext = crate::webgate_store::unprotect_webgate_store(&ciphertext)?;
            PersistedConnections::from_json(&mut plaintext)?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            PersistedConnections::default()
        }
        Err(_) => return Err("WEBGATE_STORE_READ_FAILED".into()),
    };
    state.remote_profiles.import_connections(records)?;
    state.remote_profiles.set_store(Arc::new(move |records| {
        let ciphertext = records.with_json(crate::webgate_store::protect_webgate_store)?;
        crate::profiles::atomic_write(&path, &ciphertext)
            .map_err(|_| "WEBGATE_STORE_SAVE_FAILED".to_string())
    }))?;
    state.remote_profiles.restore_connections(
        transport_policy(state),
        &state.data_dir.join("cache/webgate"),
    )
}

fn transport_policy(state: &AppState) -> TransportPolicy {
    transport_policy_parts(state.tor.clone(), state.proxy_settings.clone())
}

pub(crate) fn transport_policy_parts(
    tor: TorManager,
    proxy: Arc<Mutex<ProxySettings>>,
) -> TransportPolicy {
    let route_tor = tor.clone();
    TransportPolicy {
        // A desktop user explicitly selects this destination, including their
        // own LAN server. Web deployments use a separate server-side policy.
        allow_private_networks: true,
        require_tor: Some(Arc::new(move || route_tor.enabled())),
        proxy: Some(Arc::new(move || {
            let settings = match proxy.lock() {
                Ok(settings) => settings.clone(),
                Err(_) => {
                    return Some(ProxyRoute {
                        mode: ProxyMode::Unsupported,
                        host: String::new(),
                        port: 0,
                        username: String::new(),
                        password: String::new(),
                    })
                }
            };
            if settings.mode == "none" {
                return None;
            }
            Some(ProxyRoute {
                mode: match settings.mode.as_str() {
                    "http" => ProxyMode::HttpConnect,
                    "socks5" => ProxyMode::Socks5,
                    _ => ProxyMode::Unsupported,
                },
                host: settings.host,
                port: settings.port,
                username: settings.username,
                password: settings.password,
            })
        })),
        tor: Some(Arc::new(move || {
            if !tor.enabled() || !tor.is_ready() {
                return None;
            }
            tor.proxy_port()
                .map(|port| std::net::SocketAddr::from(([127, 0, 0, 1], port)))
        })),
        ..TransportPolicy::default()
    }
}

pub(crate) fn combined_profiles(state: &AppState) -> Result<Value, String> {
    let mut profiles = serde_json::to_value(state.summaries()?)
        .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
        .as_array()
        .cloned()
        .ok_or("WEBGATE_STATE_UNAVAILABLE")?;
    let active = state.remote_profiles.active_id();
    if active.is_some() {
        for profile in &mut profiles {
            if let Some(object) = profile.as_object_mut() {
                object.insert("active".into(), Value::Bool(false));
            }
        }
    }
    profiles.extend(state.remote_profiles.summaries());
    let error = state
        .load_errors
        .lock()
        .ok()
        .and_then(|errors| errors.get("webgate-store").cloned());
    Ok(
        serde_json::json!({"profiles":profiles,"activeProfileId":active,
        "initialConnectionPresetRequired":false,"webgateStoreError":error}),
    )
}

#[tauri::command]
pub(crate) async fn connect_webgate_profile(
    state: tauri::State<'_, AppState>,
    mut card: ConnectionCard,
    password: String,
) -> Result<Value, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    let mut password = password.into_bytes();
    if let Some(embedded) = card.password.take() {
        if password.is_empty() {
            password.extend_from_slice(embedded.as_bytes());
        }
        // The imported secret is stored only inside the encrypted connection catalogue.
        let mut bytes = embedded.into_bytes();
        wipe_secret_bytes(&mut bytes);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        let result = initialize_persistence(&state).and_then(|_| {
            std::str::from_utf8(&password)
                .map_err(|_| "WEBGATE_PASSWORD_INVALID".to_string())
                .and_then(|password| {
                    state.remote_profiles.connect(
                        card,
                        password,
                        transport_policy(&state),
                        &state.data_dir.join("cache/webgate"),
                    )
                })
        });
        wipe_secret_bytes(&mut password);
        result?;
        let profiles = combined_profiles(&state)?;
        let _ = state.app.emit("profiles-changed", "webgate");
        Ok(profiles)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn webgate_profiles(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || combined_profiles(&state))
        .await
        .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn update_webgate_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    mut card: ConnectionCard,
    password: String,
) -> Result<Value, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    let mut password = password.into_bytes();
    if let Some(embedded) = card.password.take() {
        if password.is_empty() {
            password.extend_from_slice(embedded.as_bytes());
        }
        let mut bytes = embedded.into_bytes();
        wipe_secret_bytes(&mut bytes);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        let result = initialize_persistence(&state).and_then(|_| {
            std::str::from_utf8(&password)
                .map_err(|_| "WEBGATE_PASSWORD_INVALID".to_string())
                .and_then(|password| {
                    state.remote_profiles.reconnect(
                        &profile_id,
                        card,
                        password,
                        transport_policy(&state),
                        &state.data_dir.join("cache/webgate"),
                    )
                })
        });
        wipe_secret_bytes(&mut password);
        result?;
        let _ = state.app.emit("profiles-changed", &profile_id);
        combined_profiles(&state)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn webgate_invoke(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    command: String,
    args: Value,
    operation_id: Option<String>,
) -> Result<Value, String> {
    let admission = state.desktop_work.admit()?;
    let host: Arc<WebgateHost> = state.remote_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        host.invoke(&profile_id, &command, args, operation_id.as_deref())
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn webgate_select_profile(
    state: tauri::State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<Value, String> {
    match profile_id {
        Some(id) => state.remote_profiles.set_active(&id)?,
        None => state.remote_profiles.clear_active()?,
    }
    combined_profiles(&state)
}

#[tauri::command]
pub(crate) async fn webgate_disconnect_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<Value, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        state.webgate_downloads.cancel_profile(&profile_id);
        state.remote_profiles.disconnect(&profile_id)?;
        let _ = state.app.emit("profiles-changed", &profile_id);
        combined_profiles(&state)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) fn get_webgate_connection_card(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<ConnectionCard, String> {
    state.remote_profiles.connection_card(&profile_id)
}

#[tauri::command]
pub(crate) async fn save_webgate_connection_card(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    card: String,
) -> Result<String, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        let connection = state.remote_profiles.connection_card(&profile_id)?;
        let parsed = ConnectionCard::parse(&card)?;
        let directory = state.root_dir.join("Webgate cards");
        fs::create_dir_all(&directory).map_err(|_| "WEBGATE_CARD_SAVE_FAILED")?;
        let name = format!("{}.webgate.json", safe_file_name(&connection.profile_name));
        let destination = unique_download_path(&directory, &name);
        let encoded = parsed.export(parsed.password.as_deref())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|_| "WEBGATE_CARD_SAVE_FAILED")?;
        if file
            .write_all(encoded.as_bytes())
            .and_then(|_| file.sync_all())
            .is_err()
        {
            drop(file);
            let _ = fs::remove_file(&destination);
            return Err("WEBGATE_CARD_SAVE_FAILED".into());
        }
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn webgate_file_operation(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    operation: String,
    args: Value,
) -> Result<Value, String> {
    let admission = state.desktop_work.admit()?;
    let host = state.remote_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        host.file_operation(&profile_id, &operation, args)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn webgate_restore_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<Value, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        initialize_persistence(&state)?;
        state.remote_profiles.restore_profile(
            &profile_id,
            transport_policy(&state),
            &state.data_dir.join("cache/webgate"),
        )?;
        let _ = state.app.emit("profiles-changed", &profile_id);
        combined_profiles(&state)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn webgate_forget_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<Value, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        state.remote_profiles.forget(&profile_id)?;
        crate::desktop_notifications::forget_webgate_profile(&profile_id);
        state.webgate_downloads.cancel_profile(&profile_id);
        let _ = state.app.emit("profiles-changed", &profile_id);
        combined_profiles(&state)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}
