use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ring::signature;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest as _, Sha1};
use sha2::{Digest as Sha2Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri_app_lib::web_core::{
    decrypt_tox_profile_import, encrypt_tox_profile_export, DataLease, LeaseDecision, Presence,
    StorageMode, WebMessageSearchRequest, WorkspaceConfig, WorkspaceDomain, WorkspaceIdentifier,
};
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

use crate::{
    archive::{self, ArchiveArtifact},
    config::{source_address, Config},
    proof::{ProofSolution, PublicChallenge},
    state::{
        now_millis, now_seconds, AppState, InnerState, PendingProfileImport,
        PendingWorkspaceImport, SessionContext, StoredWorkspace, WorkspaceView,
        PROFILE_IMPORT_TTL_SECONDS,
    },
};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_LOCAL_STATE_JSON_BYTES: usize = 12 * 1024 * 1024;
const MAX_AVATAR_COMMAND_JSON_BYTES: usize = 12 * 1024 * 1024;
const MAX_RAW_PROFILE_IMPORT_BYTES: u64 = 25 * 1024 * 1024;
const PROFILE_PACKAGE_IMPORT_OVERHEAD_BYTES: u64 = 64 * 1024 * 1024;
const WORKSPACE_ARCHIVE_IMPORT_OVERHEAD_BYTES: u64 = 64 * 1024 * 1024;
const LEGACY_DEVICE_COOKIE_NAME: &str = "__Host-kaigen-device";
const DEVICE_COOKIE_PREFIX: &str = "__Host-kaigen-device-";
const WORKSPACE_SELECTOR_HEADER: &str = "x-kaigen-workspace";
const WORKSPACE_PROTOCOL_PREFIX: &str = "kaigen.workspace.";
const WEB_CONTENT_SECURITY_POLICY: &str = "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' blob: data:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; worker-src 'self'; require-trusted-types-for 'script'; trusted-types kaigen-spellcheck-worker";

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct HttpRequestError {
    status: u16,
    code: &'static str,
}

struct HttpResponse {
    status: u16,
    reason: &'static str,
    headers: Vec<(String, String)>,
    body: ResponseBody,
}

enum ResponseBody {
    Bytes(Vec<u8>),
    File {
        path: PathBuf,
        length: u64,
        delete_after: bool,
    },
}

pub async fn run(config: Config) -> Result<(), String> {
    let listener = TcpListener::bind(config.bind)
        .await
        .map_err(|error| format!("Could not bind kaigen-webd: {error}"))?;
    let state = Arc::new(AppState::load(config)?);
    let checkpoint_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let state = Arc::clone(&checkpoint_state);
            let _ = tokio::task::spawn_blocking(move || state.maintenance_tick()).await;
        }
    });
    let transfer_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let state = Arc::clone(&transfer_state);
            let _ = tokio::task::spawn_blocking(move || state.transfer_tick()).await;
        }
    });
    loop {
        let (stream, remote) = listener
            .accept()
            .await
            .map_err(|error| format!("Could not accept kaigen-webd connection: {error}"))?;
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            // Request details, addresses and payload-derived data are never logged.
            let _ = handle_connection(stream, remote, state).await;
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    remote: SocketAddr,
    state: Arc<AppState>,
) -> Result<(), String> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            return write_response(&mut stream, error_response(error.status, error.code)).await;
        }
    };
    if request.path == "/ws/v1" {
        return handle_websocket(stream, request, state).await;
    }
    let response = route(request, remote, state).await;
    write_response(&mut stream, response).await
}

async fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, HttpRequestError> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err(request_error(431, "REQUEST_HEADERS_TOO_LARGE"));
        }
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| request_error(400, "REQUEST_READ_FAILED"))?;
        if read == 0 {
            return Err(request_error(400, "REQUEST_INCOMPLETE"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_bytes(&buffer, b"\r\n\r\n") {
            break index + 4;
        }
    };
    let head = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| request_error(400, "REQUEST_HEADERS_INVALID"))?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines
        .next()
        .ok_or_else(|| request_error(400, "REQUEST_LINE_INVALID"))?
        .split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let target = request_line.next().unwrap_or_default();
    let version = request_line.next().unwrap_or_default();
    if method.is_empty()
        || !target.starts_with('/')
        || !matches!(version, "HTTP/1.1" | "HTTP/1.0")
        || request_line.next().is_some()
    {
        return Err(request_error(400, "REQUEST_LINE_INVALID"));
    }
    let path = target.split('?').next().unwrap_or(target).to_string();
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| request_error(400, "REQUEST_HEADERS_INVALID"))?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() || headers.contains_key(&name) {
            return Err(request_error(400, "REQUEST_HEADERS_INVALID"));
        }
        headers.insert(name, value.trim().to_string());
    }
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(request_error(400, "REQUEST_TRANSFER_ENCODING_UNSUPPORTED"));
    }
    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| request_error(400, "REQUEST_LENGTH_INVALID"))?
        .unwrap_or(0);
    if content_length > request_body_limit(&path) {
        let buffered_body = buffer.len().saturating_sub(header_end).min(content_length);
        discard_request_body(stream, content_length - buffered_body).await?;
        return Err(request_error(413, "REQUEST_TOO_LARGE"));
    }
    while buffer.len().saturating_sub(header_end) < content_length {
        let remaining = content_length - buffer.len().saturating_sub(header_end);
        let mut chunk = vec![0_u8; remaining.min(16 * 1024)];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| request_error(400, "REQUEST_READ_FAILED"))?;
        if read == 0 {
            return Err(request_error(400, "REQUEST_INCOMPLETE"));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Ok(HttpRequest {
        method,
        path,
        headers,
        body: buffer[header_end..header_end + content_length].to_vec(),
    })
}

async fn discard_request_body(
    stream: &mut TcpStream,
    mut remaining: usize,
) -> Result<(), HttpRequestError> {
    let mut chunk = [0_u8; 16 * 1024];
    while remaining > 0 {
        let read_limit = remaining.min(chunk.len());
        let read = stream
            .read(&mut chunk[..read_limit])
            .await
            .map_err(|_| request_error(400, "REQUEST_READ_FAILED"))?;
        if read == 0 {
            return Err(request_error(400, "REQUEST_INCOMPLETE"));
        }
        remaining -= read;
    }
    Ok(())
}

fn request_error(status: u16, code: &'static str) -> HttpRequestError {
    HttpRequestError { status, code }
}

fn request_body_limit(path: &str) -> usize {
    match path {
        "/api/v1/commands/save_local_state" => MAX_LOCAL_STATE_JSON_BYTES,
        "/api/v1/commands/set_profile_avatar" => MAX_AVATAR_COMMAND_JSON_BYTES,
        _ => MAX_JSON_BYTES,
    }
}

async fn route(request: HttpRequest, remote: SocketAddr, state: Arc<AppState>) -> HttpResponse {
    if request.method == "GET" && request.path == "/healthz" {
        return json_response(
            200,
            &json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }),
        );
    }
    if request.method == "GET" && request.path == "/readyz" {
        let ready = state.inner.lock().is_ok();
        return json_response(if ready { 200 } else { 503 }, &json!({ "ready": ready }));
    }
    if !request.path.starts_with("/api/v1/") {
        return error_response(404, "NOT_FOUND");
    }
    if request.method != "POST" {
        return error_response(405, "METHOD_NOT_ALLOWED");
    }
    if !valid_origin(&request, &state.config.public_origin) {
        return error_response(403, "ORIGIN_INVALID");
    }
    let forwarded = request.headers.get("x-real-ip").map(String::as_str);
    let source = match state.source_fingerprint(&source_address(remote, forwarded)) {
        Ok(value) => value,
        Err(_) => return error_response(503, "STATE_UNAVAILABLE"),
    };
    match request.path.as_str() {
        "/api/v1/initializer/challenge" => initializer_challenge(state, source),
        "/api/v1/workspaces" => create_workspace(request, state, source),
        "/api/v1/workspaces/import/start" => start_workspace_import(&request, state, source),
        "/api/v1/workspaces/import/upload" => upload_workspace_import(&request, state, source),
        "/api/v1/workspaces/import/finish" => {
            finish_workspace_import(&request, state, source).await
        }
        "/api/v1/workspaces/import/cancel" => cancel_workspace_import(&request, state, source),
        "/api/v1/workspaces/lookup" => lookup_workspace(&request, state),
        "/api/v1/auth/password" => password_login(&request, state, source).await,
        "/api/v1/auth/device-challenge" => device_challenge(&request, state),
        "/api/v1/auth/device" => device_login(&request, state),
        "/api/v1/lease/heartbeat" => heartbeat(&request, state),
        "/api/v1/workspaces/renew" => renew(&request, state),
        "/api/v1/workspaces/lock" => lock_workspace(&request, state),
        "/api/v1/workspaces/close" => close_workspace(&request, state),
        "/api/v1/workspaces/archive" => archive_workspace(&request, state).await,
        "/api/v1/workspaces/archive/cancel" => cancel_archive(&request, state),
        "/api/v1/workspaces/destroy" => destroy_workspace(&request, state),
        "/api/v1/workspaces/erase" => erase(&request, state),
        "/api/v1/profiles/export/package" => export_profile_package(&request, state).await,
        "/api/v1/profiles/export/tox" => export_profile_tox(&request, state).await,
        "/api/v1/profiles/import/start" => start_profile_import(&request, state),
        "/api/v1/profiles/import/upload" => upload_profile_import(&request, state),
        "/api/v1/profiles/import/finish" => finish_profile_import(&request, state).await,
        "/api/v1/profiles/import/cancel" => cancel_profile_import(&request, state),
        "/api/v1/transfers/outgoing" => begin_outgoing_transfer(&request, state),
        "/api/v1/transfers/status" => transfer_status(&request, state),
        "/api/v1/transfers/upload" => upload_transfer_chunk(&request, state),
        "/api/v1/transfers/download" => download_transfer_chunk(&request, state),
        path if path.starts_with("/api/v1/commands/") => {
            command(&request, state, &path["/api/v1/commands/".len()..]).await
        }
        _ => error_response(404, "NOT_FOUND"),
    }
}

fn initializer_challenge(state: Arc<AppState>, source: [u8; 32]) -> HttpResponse {
    let now = now_seconds();
    let result: Result<PublicChallenge, String> = state
        .inner
        .lock()
        .map_err(|_| "STATE_UNAVAILABLE".to_string())
        .and_then(|mut inner| {
            inner
                .proofs
                .issue(source, state.config.proof_difficulty, now)
        });
    result_json(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    storage_mode: StorageMode,
    access_password: String,
    language: String,
    proof: ProofSolution,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateResponse {
    identifier: String,
    workspace: WorkspaceView,
}

fn create_workspace(request: HttpRequest, state: Arc<AppState>, source: [u8; 32]) -> HttpResponse {
    let mut input: CreateRequest = match parse_json(&request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if input.access_password.is_empty()
        || input.access_password.len() > 1024
        || !matches!(input.language.as_str(), "ru" | "en")
    {
        wipe_string(&mut input.access_password);
        return error_response(400, "CREATE_REQUEST_INVALID");
    }
    let snapshot = state.resource_snapshot();
    let now = now_seconds();
    let result = (|| -> Result<CreateResponse, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if inner.maintenance {
            return Err("MAINTENANCE".to_string());
        }
        if !inner.proofs.consume(&source, &input.proof, now) {
            return Err("PROOF_INVALID".to_string());
        }
        if !inner.admission.evaluate(snapshot, now).allowed {
            return Err("CREATION_UNAVAILABLE".to_string());
        }
        let identifier = WorkspaceIdentifier::generate()?;
        let workspace_hash = identifier.hash();
        let root = state.workspace_root(input.storage_mode, &workspace_hash);
        if inner.workspaces.contains_key(&workspace_hash) || root.exists() {
            return Err("CREATION_RETRY".to_string());
        }
        let mut domain = WorkspaceDomain::provisional(
            workspace_hash,
            WorkspaceConfig {
                storage_mode: input.storage_mode,
                quota_bytes: state.config.quota_for(input.storage_mode),
                security_reserve_bytes: state.config.security_reserve_bytes,
                lease_hours: state.config.lease_hours,
            },
            now,
        )?;
        domain.set_language(&input.language)?;
        domain.initialize_workspace(&input.access_password, now)?;
        let mut stored = StoredWorkspace {
            root,
            active_root: state.workspace_active_root(&workspace_hash),
            domain,
            runtime: None,
            browser_locked: false,
            pending_profile_import: None,
            last_payload_checkpoint: Instant::now(),
            durability: None,
        };
        let view = state.view(&mut stored.domain, None, inner.maintenance, now);
        AppState::persist(&stored)?;
        if let Err(error) = stored.ensure_runtime(&state.config.resource_root) {
            let _ = stored.stop_runtime();
            let _ = state.remove_workspace_directory(&stored.root);
            let _ = state.remove_active_workspace_directory(&stored.active_root);
            return Err(error);
        }
        if let Err(error) = stored.checkpoint(true) {
            let _ = stored.stop_runtime();
            let _ = state.remove_workspace_directory(&stored.root);
            let _ = state.remove_active_workspace_directory(&stored.active_root);
            return Err(error);
        }
        AppState::persist(&stored)?;
        // The registry mutation is required in release builds.  Never hide it
        // inside debug_assert!, whose expression is compiled out with
        // debug-assertions disabled.
        match inner.workspaces.entry(workspace_hash) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(stored);
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err("CREATION_RETRY".to_string());
            }
        }
        Ok(CreateResponse {
            identifier: identifier.expose_once().to_string(),
            workspace: view,
        })
    })();
    wipe_string(&mut input.access_password);
    match result {
        Ok(value) => json_response(201, &value),
        Err(code) if matches!(code.as_str(), "CREATION_UNAVAILABLE" | "MAINTENANCE") => {
            error_response(503, &code)
        }
        Err(code) => error_response(400, &code),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartWorkspaceImportRequest {
    storage_mode: StorageMode,
    size_bytes: u64,
    proof: ProofSolution,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishWorkspaceImportRequest {
    import_id: String,
    archive_password: String,
    access_password: String,
    sha256: String,
    #[serde(default)]
    identifier: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelWorkspaceImportRequest {
    import_id: String,
}

fn start_workspace_import(
    request: &HttpRequest,
    state: Arc<AppState>,
    source: [u8; 32],
) -> HttpResponse {
    let input: StartWorkspaceImportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let max_bytes = state
        .config
        .quota_for(input.storage_mode)
        .saturating_add(state.config.security_reserve_bytes)
        .saturating_add(WORKSPACE_ARCHIVE_IMPORT_OVERHEAD_BYTES);
    if input.size_bytes == 0 || input.size_bytes > max_bytes {
        return error_response(400, "WORKSPACE_IMPORT_SIZE_INVALID");
    }
    let snapshot = state.resource_snapshot();
    let now = now_seconds();
    let result = (|| -> Result<Value, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if inner.maintenance {
            return Err("MAINTENANCE".to_string());
        }
        if !inner.proofs.consume(&source, &input.proof, now) {
            return Err("PROOF_INVALID".to_string());
        }
        if !inner.admission.evaluate(snapshot, now).allowed {
            return Err("CREATION_UNAVAILABLE".to_string());
        }
        if inner
            .pending_workspace_imports
            .values()
            .any(|pending| bool::from(pending.source_hash.ct_eq(&source)))
        {
            return Err("WORKSPACE_IMPORT_ALREADY_IN_PROGRESS".to_string());
        }
        if inner.pending_workspace_imports.len() >= state.config.max_instances {
            return Err("CREATION_UNAVAILABLE".to_string());
        }
        let import_id = random_token(24)?;
        let path = state
            .config
            .active_root
            .join(format!(".workspace-import-{import_id}.upload"));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        protect_private_file(&path)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        drop(file);
        inner.pending_workspace_imports.insert(
            import_id.clone(),
            PendingWorkspaceImport {
                id: import_id.clone(),
                source_hash: source,
                storage_mode: input.storage_mode,
                path,
                expected_bytes: input.size_bytes,
                received_bytes: 0,
                created_at: now,
                finalizing: false,
            },
        );
        Ok(json!({
            "importId": import_id,
            "chunkBytes": MAX_JSON_BYTES,
        }))
    })();
    match result {
        Ok(value) => json_response(200, &value),
        Err(code) if matches!(code.as_str(), "CREATION_UNAVAILABLE" | "MAINTENANCE") => {
            error_response(503, &code)
        }
        Err(code) => operation_error(&code),
    }
}

fn upload_workspace_import(
    request: &HttpRequest,
    state: Arc<AppState>,
    source: [u8; 32],
) -> HttpResponse {
    if request
        .headers
        .get("content-type")
        .is_none_or(|value| !value.eq_ignore_ascii_case("application/octet-stream"))
    {
        return error_response(400, "WORKSPACE_IMPORT_CONTENT_TYPE_INVALID");
    }
    if request.body.is_empty() || request.body.len() > MAX_JSON_BYTES {
        return error_response(400, "WORKSPACE_IMPORT_CHUNK_INVALID");
    }
    let import_id = match request.headers.get("x-kaigen-import-id") {
        Some(value) if valid_transfer_id(value) => value,
        _ => return error_response(400, "WORKSPACE_IMPORT_ID_INVALID"),
    };
    let position = match request
        .headers
        .get("x-kaigen-import-position")
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(value) => value,
        None => return error_response(400, "WORKSPACE_IMPORT_POSITION_INVALID"),
    };
    let result = (|| -> Result<Value, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let pending = inner
            .pending_workspace_imports
            .get_mut(import_id)
            .filter(|pending| bool::from(pending.source_hash.ct_eq(&source)))
            .ok_or("WORKSPACE_IMPORT_NOT_FOUND")?;
        if pending.finalizing || position != pending.received_bytes {
            return Err("WORKSPACE_IMPORT_POSITION_INVALID".to_string());
        }
        let next = position
            .checked_add(request.body.len() as u64)
            .ok_or("WORKSPACE_IMPORT_SIZE_INVALID")?;
        if next > pending.expected_bytes {
            return Err("WORKSPACE_IMPORT_SIZE_INVALID".to_string());
        }
        let current_size = fs::metadata(&pending.path)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?
            .len();
        if current_size != pending.received_bytes {
            return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(&pending.path)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        file.write_all(&request.body)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        pending.received_bytes = next;
        Ok(json!({
            "receivedBytes": next,
            "complete": next == pending.expected_bytes,
        }))
    })();
    result_json(result)
}

fn cancel_workspace_import(
    request: &HttpRequest,
    state: Arc<AppState>,
    source: [u8; 32],
) -> HttpResponse {
    let input: CancelWorkspaceImportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !valid_transfer_id(&input.import_id) {
        return error_response(400, "WORKSPACE_IMPORT_ID_INVALID");
    }
    let result = (|| -> Result<Value, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let pending = inner
            .pending_workspace_imports
            .get(&input.import_id)
            .filter(|pending| bool::from(pending.source_hash.ct_eq(&source)))
            .ok_or("WORKSPACE_IMPORT_NOT_FOUND")?;
        if pending.finalizing {
            return Err("WORKSPACE_IMPORT_FINALIZING".to_string());
        }
        pending.remove_file(&state.config.active_root)?;
        inner.pending_workspace_imports.remove(&input.import_id);
        Ok(json!({ "cancelled": true }))
    })();
    result_json(result)
}

struct PreparedWorkspaceRestore {
    identifier: String,
    workspace_hash: [u8; 32],
    storage_mode: StorageMode,
    domain: WorkspaceDomain,
    payload_root: PathBuf,
}

async fn finish_workspace_import(
    request: &HttpRequest,
    state: Arc<AppState>,
    source: [u8; 32],
) -> HttpResponse {
    let mut input: FinishWorkspaceImportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !valid_transfer_id(&input.import_id)
        || input.archive_password.is_empty()
        || input.archive_password.len() > 1024
        || input.access_password.is_empty()
        || input.access_password.len() > 1024
    {
        wipe_workspace_import_request(&mut input);
        return error_response(400, "WORKSPACE_IMPORT_ARGUMENT_INVALID");
    }
    let expected_hash = match URL_SAFE_NO_PAD.decode(&input.sha256) {
        Ok(value) if value.len() == 32 => {
            let mut hash = [0_u8; 32];
            hash.copy_from_slice(&value);
            hash
        }
        _ => {
            wipe_workspace_import_request(&mut input);
            return error_response(400, "WORKSPACE_IMPORT_HASH_INVALID");
        }
    };
    let preparation = (|| -> Result<(PathBuf, u64, StorageMode, PathBuf, u64), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let pending = inner
            .pending_workspace_imports
            .get_mut(&input.import_id)
            .filter(|pending| bool::from(pending.source_hash.ct_eq(&source)))
            .ok_or("WORKSPACE_IMPORT_NOT_FOUND")?;
        if pending.finalizing || pending.received_bytes != pending.expected_bytes {
            return Err("WORKSPACE_IMPORT_INCOMPLETE".to_string());
        }
        pending.finalizing = true;
        let max_plaintext = state
            .config
            .quota_for(pending.storage_mode)
            .saturating_add(state.config.security_reserve_bytes)
            .saturating_add(WORKSPACE_ARCHIVE_IMPORT_OVERHEAD_BYTES);
        Ok((
            pending.path.clone(),
            pending.expected_bytes,
            pending.storage_mode,
            state
                .config
                .active_root
                .join(format!(".workspace-restore-{}", input.import_id)),
            max_plaintext,
        ))
    })();
    let (upload_path, expected_bytes, storage_mode, staging_root, max_plaintext) = match preparation
    {
        Ok(value) => value,
        Err(code) => {
            wipe_workspace_import_request(&mut input);
            return operation_error(&code);
        }
    };
    let import_id = input.import_id.clone();
    let mut archive_password = std::mem::take(&mut input.archive_password);
    let mut access_password = std::mem::take(&mut input.access_password);
    let mut supplied_identifier = input.identifier.take();
    let staging_cleanup = staging_root.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        let result = (|| -> Result<PreparedWorkspaceRestore, String> {
            verify_import_file(&upload_path, expected_bytes, &expected_hash)?;
            let mut restored = archive::restore_workspace_archive(
                &upload_path,
                &staging_root,
                &archive_password,
                max_plaintext,
            )?;
            let identifier = match (restored.identifier.take(), supplied_identifier.take()) {
                (Some(archived), Some(supplied)) if archived != supplied => {
                    return Err("WORKSPACE_ARCHIVE_IDENTIFIER_INVALID".to_string())
                }
                (Some(archived), _) => archived,
                (None, Some(supplied)) => supplied,
                (None, None) => return Err("WORKSPACE_ARCHIVE_IDENTIFIER_REQUIRED".to_string()),
            };
            let parsed_identifier = WorkspaceIdentifier::parse(&identifier)
                .map_err(|_| "WORKSPACE_ARCHIVE_IDENTIFIER_INVALID".to_string())?;
            let workspace_hash = parsed_identifier.hash();
            let mut domain_json = std::mem::take(&mut restored.domain_json);
            let decoded_domain = serde_json::from_slice(&domain_json)
                .map_err(|_| "WORKSPACE_ARCHIVE_DOMAIN_INVALID".to_string());
            wipe_bytes(&mut domain_json);
            let mut domain: WorkspaceDomain = decoded_domain?;
            if !bool::from(domain.workspace_hash.ct_eq(&workspace_hash))
                || domain.profiles.stored_count() != restored.profile_count
            {
                return Err("WORKSPACE_ARCHIVE_DOMAIN_INVALID".to_string());
            }
            domain.storage_mode = storage_mode;
            domain.close_transaction = None;
            domain.devices = Default::default();
            domain.ui_lease = Default::default();
            domain.transfers.on_ui_lost();
            domain.lock_after_restart();
            domain.unlock(&access_password)?;
            Ok(PreparedWorkspaceRestore {
                identifier,
                workspace_hash,
                storage_mode,
                domain,
                payload_root: restored.payload_root.clone(),
            })
        })();
        wipe_string(&mut archive_password);
        wipe_string(&mut access_password);
        if let Some(identifier) = supplied_identifier.as_mut() {
            wipe_string(identifier);
        }
        result
    })
    .await
    .map_err(|_| "WORKSPACE_IMPORT_FAILED".to_string())
    .and_then(|value| value);
    let mut prepared = match prepared {
        Ok(value) => value,
        Err(code) => {
            let _ = remove_workspace_restore_directory(
                &state.config.active_root,
                &staging_cleanup,
                &import_id,
            );
            reset_pending_workspace_import(&state, &import_id, &source);
            return operation_error(&code);
        }
    };

    let now = now_seconds();
    let snapshot = state.resource_snapshot();
    let reservation = (|| -> Result<(), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if inner.maintenance {
            return Err("MAINTENANCE".to_string());
        }
        if !inner.admission.evaluate(snapshot, now).allowed {
            return Err("CREATION_UNAVAILABLE".to_string());
        }
        let pending = inner
            .pending_workspace_imports
            .get(&import_id)
            .filter(|pending| pending.finalizing && bool::from(pending.source_hash.ct_eq(&source)))
            .ok_or("WORKSPACE_IMPORT_NOT_FOUND")?;
        let root = state.workspace_root(prepared.storage_mode, &prepared.workspace_hash);
        if inner.workspaces.contains_key(&prepared.workspace_hash)
            || inner
                .restoring_workspaces
                .contains(&prepared.workspace_hash)
            || root.exists()
        {
            return Err("WORKSPACE_ALREADY_EXISTS".to_string());
        }
        pending.remove_file(&state.config.active_root)?;
        inner.pending_workspace_imports.remove(&import_id);
        inner.restoring_workspaces.insert(prepared.workspace_hash);
        Ok(())
    })();
    if let Err(code) = reservation {
        let _ = remove_workspace_restore_directory(
            &state.config.active_root,
            &staging_cleanup,
            &import_id,
        );
        reset_pending_workspace_import(&state, &import_id, &source);
        return if matches!(code.as_str(), "CREATION_UNAVAILABLE" | "MAINTENANCE") {
            error_response(503, &code)
        } else {
            operation_error(&code)
        };
    }

    let workspace_root = state.workspace_root(prepared.storage_mode, &prepared.workspace_hash);
    let active_root = state.workspace_active_root(&prepared.workspace_hash);
    prepared.domain.quota.user_limit_bytes = state.config.quota_for(prepared.storage_mode);
    prepared.domain.quota.reserve_limit_bytes = state.config.security_reserve_bytes;
    if prepared.domain.quota.user_used_bytes > prepared.domain.quota.user_limit_bytes
        || prepared.domain.quota.reserve_used_bytes > prepared.domain.quota.reserve_limit_bytes
    {
        release_workspace_restore_reservation(&state, &prepared.workspace_hash);
        let _ = remove_workspace_restore_directory(
            &state.config.active_root,
            &staging_cleanup,
            &import_id,
        );
        return error_response(400, "WORKSPACE_IMPORT_QUOTA_EXCEEDED");
    }
    prepared.domain.data_lease = DataLease::provisional(state.config.lease_hours, now);
    prepared.domain.data_lease.activate_after_first_profile(now);

    let activated = activate_restored_workspace_payload(
        &prepared.payload_root,
        &workspace_root,
        &import_id,
        &prepared.domain,
    );
    if let Err(code) = activated {
        release_workspace_restore_reservation(&state, &prepared.workspace_hash);
        let _ = remove_workspace_restore_directory(
            &state.config.active_root,
            &staging_cleanup,
            &import_id,
        );
        return operation_error(&code);
    }
    if let Err(code) =
        remove_workspace_restore_directory(&state.config.active_root, &staging_cleanup, &import_id)
    {
        release_workspace_restore_reservation(&state, &prepared.workspace_hash);
        let _ = state.remove_workspace_directory(&workspace_root);
        return operation_error(&code);
    }

    let mut stored = StoredWorkspace {
        root: workspace_root.clone(),
        active_root: active_root.clone(),
        domain: prepared.domain,
        runtime: None,
        browser_locked: false,
        pending_profile_import: None,
        last_payload_checkpoint: Instant::now(),
        durability: None,
    };
    let runtime_result = (|| -> Result<(), String> {
        stored.ensure_runtime(&state.config.resource_root)?;
        stored.checkpoint(true)?;
        AppState::persist(&stored)
    })();
    if let Err(code) = runtime_result {
        let _ = stored.stop_runtime();
        release_workspace_restore_reservation(&state, &prepared.workspace_hash);
        let _ = state.remove_active_workspace_directory(&active_root);
        let _ = state.remove_workspace_directory(&workspace_root);
        return operation_error(&code);
    }
    let view = state.view(&mut stored.domain, None, false, now);
    let committed = (|| -> Result<(), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        if !inner.restoring_workspaces.remove(&prepared.workspace_hash)
            || inner.workspaces.contains_key(&prepared.workspace_hash)
        {
            return Err("WORKSPACE_IMPORT_STATE_INVALID".to_string());
        }
        inner.workspaces.insert(prepared.workspace_hash, stored);
        Ok(())
    })();
    if let Err(code) = committed {
        release_workspace_restore_reservation(&state, &prepared.workspace_hash);
        let _ = state.remove_active_workspace_directory(&active_root);
        let _ = state.remove_workspace_directory(&workspace_root);
        return operation_error(&code);
    }
    json_response(
        201,
        &json!({
            "identifier": prepared.identifier,
            "workspace": view,
        }),
    )
}

#[derive(Deserialize)]
struct LookupRequest {
    identifier: String,
}

fn lookup_workspace(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: LookupRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let exists = match state.inner.lock() {
        Ok(inner) => workspace_exists(&inner.workspaces, &input.identifier),
        Err(_) => return error_response(503, "STATE_UNAVAILABLE"),
    };
    json_response(
        200,
        &json!({
            "exists": exists,
            "provisional": false
        }),
    )
}

fn workspace_exists<V>(workspaces: &HashMap<[u8; 32], V>, identifier: &str) -> bool {
    WorkspaceIdentifier::parse(identifier)
        .ok()
        .is_some_and(|identifier| workspaces.contains_key(&identifier.hash()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordLoginRequest {
    identifier: String,
    password: String,
    public_key: String,
    #[serde(default)]
    proof: Option<ProofSolution>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    csrf_token: String,
    device_id: String,
    workspace: WorkspaceView,
}

async fn password_login(
    request: &HttpRequest,
    state: Arc<AppState>,
    source: [u8; 32],
) -> HttpResponse {
    let mut input: PasswordLoginRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let public_key = match URL_SAFE_NO_PAD.decode(&input.public_key) {
        Ok(value) => value,
        Err(_) => {
            wipe_string(&mut input.password);
            return error_response(401, "AUTH_INVALID");
        }
    };
    let now = now_seconds();
    let workspace_hash = WorkspaceIdentifier::parse(&input.identifier)
        .ok()
        .map(|identifier| identifier.hash());
    let result = (|| -> Result<(SessionResponse, String), (String, u64)> {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| ("STATE_UNAVAILABLE".to_string(), 0))?;
        let policy = inner.auth_backoff.policy(&source, now);
        if policy.allowed_at > now {
            return Err(("AUTH_DELAYED".to_string(), policy.allowed_at - now));
        }
        if policy.captcha_required
            && !input
                .proof
                .as_ref()
                .is_some_and(|proof| inner.proofs.consume(&source, proof, now))
        {
            return Err(("CAPTCHA_REQUIRED".to_string(), 0));
        }
        let authenticated =
            if let Some(stored) = workspace_hash.and_then(|hash| inner.workspaces.get_mut(&hash)) {
                if stored.domain.unlock(&input.password).is_ok() {
                    if let Some(transaction_id) = stored
                        .domain
                        .close_transaction
                        .as_ref()
                        .map(|transaction| transaction.id.clone())
                    {
                        if archive::remove_workspace_archive(&stored.root, &transaction_id).is_err()
                            || stored.domain.cancel_close().is_err()
                        {
                            stored.domain.lock_after_restart();
                            let _ = AppState::persist(stored);
                            return Err(("RUNTIME_UNAVAILABLE".to_string(), 0));
                        }
                    }
                    if stored.ensure_runtime(&state.config.resource_root).is_err() {
                        let _ = stored.stop_runtime();
                        stored.domain.lock_after_restart();
                        let _ = AppState::persist(stored);
                        return Err(("RUNTIME_UNAVAILABLE".to_string(), 0));
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            };
        if !authenticated {
            let exists = workspace_hash.is_some_and(|hash| inner.workspaces.contains_key(&hash));
            if !exists {
                let _ = inner.dummy_vault.unlock(&input.password);
                inner.dummy_vault.lock();
            }
            let next = inner.auth_backoff.record_failure(source, now);
            return Err((
                if exists {
                    "AUTH_INVALID".to_string()
                } else {
                    "WORKSPACE_NOT_FOUND".to_string()
                },
                next.delay_seconds,
            ));
        }
        let hash = workspace_hash.expect("authenticated workspace");
        inner.auth_backoff.record_success(&source);
        let maintenance = inner.maintenance;
        let (response, token, device_hash) = {
            let stored = inner
                .workspaces
                .get_mut(&hash)
                .expect("authenticated workspace");
            let enrollment = stored
                .domain
                .devices
                .enroll_after_password(public_key, now)
                .map_err(|_| ("AUTH_INVALID".to_string(), 0))?;
            let device_hash = stored
                .domain
                .devices
                .token_hash(&enrollment.device_token)
                .map_err(|_| ("AUTH_INVALID".to_string(), 0))?;
            // Password login always transfers control, but acquiring the
            // lease is still a required release-build side effect.
            let lease_decision = stored.domain.ui_lease.acquire(device_hash, now, true);
            if lease_decision == LeaseDecision::Occupied {
                return Err(("UI_LEASE_OCCUPIED".to_string(), 0));
            }
            let view = state.view(&mut stored.domain, Some(&device_hash), maintenance, now);
            AppState::persist(stored).map_err(|_| ("PERSIST_FAILED".to_string(), 0))?;
            (
                SessionResponse {
                    csrf_token: String::new(),
                    device_id: enrollment.device_token.clone(),
                    workspace: view,
                },
                enrollment.device_token,
                device_hash,
            )
        };
        let csrf = AppState::issue_session(&mut inner, hash, device_hash)
            .map_err(|_| ("AUTH_INVALID".to_string(), 0))?;
        inner
            .workspaces
            .get_mut(&hash)
            .expect("authenticated workspace")
            .unlock_browser();
        Ok((
            SessionResponse {
                csrf_token: csrf,
                ..response
            },
            token,
        ))
    })();
    wipe_string(&mut input.password);
    match result {
        Ok((response, token)) => session_response(
            response,
            &token,
            &workspace_hash.expect("authenticated workspace"),
        ),
        Err((code, delay)) => {
            if delay > 0 {
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
            let mut response = error_response(
                if code == "AUTH_DELAYED" {
                    429
                } else if matches!(code.as_str(), "STATE_UNAVAILABLE" | "RUNTIME_UNAVAILABLE") {
                    503
                } else if code == "WORKSPACE_NOT_FOUND" {
                    404
                } else {
                    401
                },
                &code,
            );
            if delay > 0 {
                response
                    .headers
                    .push(("Retry-After".to_string(), delay.to_string()));
            }
            response
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRequest {
    identifier: String,
    device_id: String,
}

fn device_challenge(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: DeviceRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if device_cookie_matching(request, &input.device_id).is_none() {
        return error_response(401, "DEVICE_AUTH_INVALID");
    }
    let hash = WorkspaceIdentifier::parse(&input.identifier)
        .ok()
        .map(|identifier| identifier.hash());
    let result = state
        .inner
        .lock()
        .map_err(|_| "STATE_UNAVAILABLE".to_string())
        .and_then(|mut inner| {
            let hash = hash.ok_or_else(|| "DEVICE_AUTH_INVALID".to_string())?;
            ensure_workspace_selector(request, &hash)
                .map_err(|_| "DEVICE_AUTH_INVALID".to_string())?;
            let stored = inner
                .workspaces
                .get_mut(&hash)
                .ok_or_else(|| "DEVICE_AUTH_INVALID".to_string())?;
            if stored.runtime.is_none() || stored.browser_locked {
                return Err("PASSWORD_REAUTH_REQUIRED".to_string());
            }
            stored
                .domain
                .devices
                .issue_challenge(&input.device_id, now_seconds())
        });
    match result {
        Ok(value) => json_response(200, &value),
        Err(_) => error_response(401, "DEVICE_AUTH_INVALID"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLoginRequest {
    identifier: String,
    device_id: String,
    challenge: String,
    signature: String,
}

fn device_login(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: DeviceLoginRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if device_cookie_matching(request, &input.device_id).is_none() {
        return error_response(401, "DEVICE_AUTH_INVALID");
    }
    let signature = match URL_SAFE_NO_PAD.decode(&input.signature) {
        Ok(value) => value,
        Err(_) => return error_response(401, "DEVICE_AUTH_INVALID"),
    };
    let hash = WorkspaceIdentifier::parse(&input.identifier)
        .ok()
        .map(|identifier| identifier.hash());
    let result = (|| -> Result<(SessionResponse, [u8; 32]), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let hash = hash.ok_or("DEVICE_AUTH_INVALID")?;
        ensure_workspace_selector(request, &hash).map_err(|_| "DEVICE_AUTH_INVALID".to_string())?;
        let maintenance = inner.maintenance;
        let (device_hash, view) = {
            let stored = inner
                .workspaces
                .get_mut(&hash)
                .ok_or("DEVICE_AUTH_INVALID")?;
            if stored.runtime.is_none() || stored.browser_locked {
                return Err("PASSWORD_REAUTH_REQUIRED".to_string());
            }
            stored.domain.devices.verify_challenge_with(
                &input.device_id,
                &input.challenge,
                &signature,
                now_seconds(),
                verify_p256,
            )?;
            let device_hash = stored.domain.devices.token_hash(&input.device_id)?;
            if stored
                .domain
                .ui_lease
                .acquire(device_hash, now_seconds(), false)
                == LeaseDecision::Occupied
            {
                return Err("UI_LEASE_OCCUPIED".to_string());
            }
            let view = state.view(
                &mut stored.domain,
                Some(&device_hash),
                maintenance,
                now_seconds(),
            );
            (device_hash, view)
        };
        let csrf = AppState::issue_session(&mut inner, hash, device_hash)?;
        Ok((
            SessionResponse {
                csrf_token: csrf,
                device_id: input.device_id.clone(),
                workspace: view,
            },
            hash,
        ))
    })();
    match result {
        Ok((response, workspace_hash)) => {
            session_response(response, &input.device_id, &workspace_hash)
        }
        Err(code) if code == "UI_LEASE_OCCUPIED" => error_response(409, &code),
        Err(_) => error_response(401, "DEVICE_AUTH_INVALID"),
    }
}

fn heartbeat(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let result = (|| -> Result<Value, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, token) = authenticate_request(&inner, request, csrf)?;
        let maintenance = inner.maintenance;
        let stored = inner
            .workspaces
            .get_mut(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        let now = now_seconds();
        stored.domain.devices.heartbeat(&token, now)?;
        stored
            .domain
            .ui_lease
            .heartbeat(&session.device_hash, now)?;
        stored.refresh_effective_presence(now)?;
        Ok(json!({
            "workspace": state.view(
                &mut stored.domain,
                Some(&session.device_hash),
                maintenance,
                now_seconds()
            )
        }))
    })();
    match result {
        Ok(value) => json_response(200, &value),
        Err(code) => operation_error(&code),
    }
}

fn renew(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    authenticated_operation(request, state.clone(), |stored, session, maintenance| {
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        stored.domain.data_lease.renew(now_seconds())?;
        AppState::persist(stored)?;
        Ok(json!({
            "workspace": state.view(
                &mut stored.domain,
                Some(&session.device_hash),
                maintenance,
                now_seconds()
            )
        }))
    })
}

fn lock_workspace(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let locked = (|| -> Result<([u8; 32], bool), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, cookie) = authenticate_request(&inner, request, csrf)?;
        let clear_legacy_cookie =
            legacy_device_cookie(request).is_some_and(|legacy| legacy == cookie);
        {
            let stored = inner
                .workspaces
                .get_mut(&session.workspace_hash)
                .ok_or("AUTH_INVALID")?;
            if !stored.domain.ui_lease.owned_by(&session.device_hash) {
                return Err("UI_LEASE_TRANSFERRED".to_string());
            }
            if stored.domain.close_transaction.is_some() {
                return Err("WORKSPACE_FROZEN".to_string());
            }
            // This is an authentication/UI lock, not application shutdown.
            // Keep this exact runtime and its loaded profiles alive so toxcore
            // continues receiving events while no browser session is trusted.
            stored.lock_browser();
        }
        inner
            .sessions
            .retain(|_, candidate| candidate.workspace_hash != session.workspace_hash);
        Ok((session.workspace_hash, clear_legacy_cookie))
    })();
    let (workspace_hash, clear_legacy_cookie) = match locked {
        Ok(value) => value,
        Err(code) => return operation_error(&code),
    };
    let mut response = json_response(200, &json!({ "locked": true }));
    response.headers.push((
        "Set-Cookie".to_string(),
        format!(
            "{}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
            workspace_cookie_name(&workspace_hash)
        ),
    ));
    if clear_legacy_cookie {
        response.headers.push((
            "Set-Cookie".to_string(),
            format!(
                "{LEGACY_DEVICE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
            ),
        ));
    }
    response
}

fn close_workspace(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let closed = (|| -> Result<([u8; 32], bool), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, cookie) = authenticate_request(&inner, request, csrf)?;
        let clear_legacy_cookie =
            legacy_device_cookie(request).is_some_and(|legacy| legacy == cookie);
        {
            let stored = inner
                .workspaces
                .get_mut(&session.workspace_hash)
                .ok_or("AUTH_INVALID")?;
            if !stored.domain.ui_lease.owned_by(&session.device_hash) {
                return Err("UI_LEASE_TRANSFERRED".to_string());
            }
            if stored.domain.close_transaction.is_some() {
                return Err("WORKSPACE_FROZEN".to_string());
            }
            stored.checkpoint_profiles(true)?;
            if let Err(error) = stored.stop_runtime() {
                let _ = stored.ensure_runtime(&state.config.resource_root);
                return Err(error);
            }
            if let Err(error) = stored.checkpoint_after_stop() {
                let _ = stored.ensure_runtime(&state.config.resource_root);
                return Err(error);
            }
            if let Err(error) = state.remove_active_workspace_directory(&stored.active_root) {
                let _ = stored.ensure_runtime(&state.config.resource_root);
                return Err(error);
            }
            stored.domain.close_without_export()?;
            AppState::persist(stored)?;
        }
        inner
            .sessions
            .retain(|_, candidate| candidate.workspace_hash != session.workspace_hash);
        Ok((session.workspace_hash, clear_legacy_cookie))
    })();
    let (workspace_hash, clear_legacy_cookie) = match closed {
        Ok(value) => value,
        Err(code) => return operation_error(&code),
    };
    let mut response = json_response(200, &json!({ "closed": true }));
    response.headers.push((
        "Set-Cookie".to_string(),
        format!(
            "{}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
            workspace_cookie_name(&workspace_hash)
        ),
    ));
    if clear_legacy_cookie {
        response.headers.push((
            "Set-Cookie".to_string(),
            format!(
                "{LEGACY_DEVICE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
            ),
        ));
    }
    response
}

async fn command(request: &HttpRequest, state: Arc<AppState>, command: &str) -> HttpResponse {
    let args: Value = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if command == "search_tox_messages" {
        return message_search_command(request, state, &args).await;
    }
    authenticated_operation(request, state, |stored, session, maintenance| {
        dispatch_command(stored, session, maintenance, command, &args)
    })
}

async fn message_search_command(
    request: &HttpRequest,
    state: Arc<AppState>,
    args: &Value,
) -> HttpResponse {
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let prepared = (|| -> Result<(SessionContext, WebMessageSearchRequest), String> {
        let inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, _) = authenticate_request(&inner, request, csrf)?;
        let stored = inner
            .workspaces
            .get(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        if !stored.domain.ui_lease.owned_by(&session.device_hash) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        let profile_id = args
            .get("profileId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .map(Ok)
            .unwrap_or_else(|| selected_profile_id(&stored.domain))?;
        let search = stored
            .runtime
            .as_ref()
            .ok_or_else(|| "RUNTIME_LOCKED".to_string())?
            .prepare_message_search(&profile_id, args)?;
        Ok((session, search))
    })();
    let (session, search) = match prepared {
        Ok(prepared) => prepared,
        Err(code) => return operation_error(&code),
    };

    // A 100k-message search can take seconds. The owned profile handle keeps
    // the exact request identity while the global workspace mutex remains free
    // for heartbeats, transfer progress, and unrelated profiles.
    let completed = tokio::task::spawn_blocking(move || {
        let result = search.execute();
        (search, result)
    })
    .await;
    let (search, result) = match completed {
        Ok(completed) => completed,
        Err(_) => return operation_error("STATE_UNAVAILABLE"),
    };

    let checked = (|| -> Result<Value, String> {
        let inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (current, _) = authenticate_request(&inner, request, csrf)?;
        if current.workspace_hash != session.workspace_hash
            || current.device_hash != session.device_hash
        {
            return Err("AUTH_INVALID".to_string());
        }
        let stored = inner
            .workspaces
            .get(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        if !stored.domain.ui_lease.owned_by(&session.device_hash) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        let runtime = stored.runtime.as_ref().ok_or("RUNTIME_LOCKED")?;
        if !runtime.message_search_is_current(&search) {
            return Err("ACTIVE_PROFILE_LOCKED".to_string());
        }
        result
    })();
    match checked {
        Ok(value) => json_response(200, &value),
        Err(code) => operation_error(&code),
    }
}

fn dispatch_command(
    stored: &mut StoredWorkspace,
    session: SessionContext,
    _maintenance: bool,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    if !stored.domain.ui_lease.owned_by(&session.device_hash) {
        return Err("UI_LEASE_TRANSFERRED".to_string());
    }
    if stored.domain.close_transaction.is_some() {
        return Err("WORKSPACE_FROZEN".to_string());
    }
    let mut changed = false;
    let result = match command {
        "get_startup_state" => json!({
            "firstRun": stored.domain.profiles.stored_count() == 0,
            "language": stored.domain.language,
            "closeToTray": false,
            "profiles": profile_summaries(stored)
        }),
        "continue_with_loaded_profiles" => Value::Array(profile_summaries(stored)),
        "set_app_language" => {
            stored.domain.set_language(string_arg(args, "language")?)?;
            changed = true;
            Value::Null
        }
        "create_profile" => {
            let name = string_arg(args, "name")?.trim();
            let password = optional_password_arg(args, "password")?;
            if name.is_empty() {
                return Err("PROFILE_INVALID".to_string());
            }
            let id = random_token(18)?;
            let activate = stored.domain.profiles.active_count() < 3;
            stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .create_profile(&id, name, password)?;
            if let Err(error) =
                stored
                    .domain
                    .add_profile(id.clone(), name.to_string(), password.is_some())
            {
                let _ = stored
                    .runtime
                    .as_mut()
                    .and_then(|runtime| runtime.remove_profile_data(&id).ok());
                return Err(error);
            }
            if activate {
                stored.domain.profiles.activate(&id)?;
            } else {
                stored
                    .runtime
                    .as_mut()
                    .ok_or("RUNTIME_LOCKED")?
                    .stop_profile(&id)?;
            }
            changed = true;
            Value::Array(profile_summaries(stored))
        }
        "unlock_profile" => {
            let profile_id = string_arg(args, "profileId")?;
            let password = optional_password_arg(args, "password")?;
            stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .load_profile(profile_id, password)?;
            if let Err(error) = stored.domain.profiles.activate(profile_id) {
                let _ = stored
                    .runtime
                    .as_mut()
                    .and_then(|runtime| runtime.stop_profile(profile_id).ok());
                return Err(error);
            }
            changed = true;
            Value::Array(profile_summaries(stored))
        }
        "disable_profile" => {
            stored
                .domain
                .profiles
                .deactivate(string_arg(args, "profileId")?)?;
            stored.synchronize_runtime()?;
            changed = true;
            Value::Array(profile_summaries(stored))
        }
        "switch_profile" => {
            stored
                .domain
                .profiles
                .select(string_arg(args, "profileId")?)?;
            changed = true;
            Value::Array(profile_summaries(stored))
        }
        "change_profile_password" => {
            let profile_id = selected_profile_id(&stored.domain)?;
            let current = optional_password_arg(args, "currentPassword")?;
            let next = optional_password_arg(args, "newPassword")?;
            stored
                .runtime
                .as_ref()
                .ok_or("RUNTIME_LOCKED")?
                .change_profile_password(&profile_id, current, next)?;
            if let Err(error) = stored
                .domain
                .set_profile_password_protected(&profile_id, next.is_some())
            {
                let _ = stored.runtime.as_ref().and_then(|runtime| {
                    runtime
                        .change_profile_password(&profile_id, next, current)
                        .ok()
                });
                return Err(error);
            }
            changed = true;
            Value::Array(profile_summaries(stored))
        }
        "set_profile_avatar" => {
            let profile_id = string_arg(args, "profileId")?;
            let data_url = nullable_string_arg(args, "dataUrl")?.map(str::to_string);
            let filename = nullable_string_arg(args, "filename")?.map(str::to_string);
            stored
                .runtime
                .as_ref()
                .ok_or("RUNTIME_LOCKED")?
                .set_profile_avatar(
                    profile_id,
                    data_url,
                    filename,
                    optional_bytes_arg(args, "bytes")?,
                )?;
            changed = true;
            Value::Array(profile_summaries(stored))
        }
        "send_tox_avatar" => {
            let profile_id = selected_profile_id(&stored.domain)?;
            let started = stored
                .runtime
                .as_ref()
                .ok_or("RUNTIME_LOCKED")?
                .send_profile_avatar(
                    &profile_id,
                    string_arg(args, "filename")?,
                    bytes_arg(args, "bytes")?,
                )?;
            changed = true;
            json!(started)
        }
        "destroy_active_profile" => {
            let profile_id = selected_profile_id(&stored.domain)?;
            stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .remove_profile_data(&profile_id)?;
            stored.domain.remove_profile(&profile_id)?;
            stored.synchronize_runtime()?;
            changed = true;
            Value::Array(profile_summaries(stored))
        }
        "control_tox_file_transfer" => {
            let profile_id = string_arg(args, "profileId")?;
            let message_id = string_arg(args, "messageId")?;
            let action = string_arg(args, "action")?;
            let view = stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .control_web_transfer(
                    &mut stored.domain,
                    profile_id,
                    message_id,
                    action,
                    now_millis(),
                )?;
            changed = true;
            serde_json::to_value(view).map_err(|_| "TRANSFER_STATE_INVALID")?
        }
        "acknowledge_web_incoming_chunk" => {
            let profile_id = string_arg(args, "profileId")?;
            let transfer_id = string_arg(args, "transferId")?;
            let through = args
                .get("through")
                .and_then(Value::as_u64)
                .ok_or("TRANSFER_ACK_RANGE_INVALID")?;
            let view = stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .acknowledge_web_incoming_chunk(
                    &mut stored.domain,
                    profile_id,
                    transfer_id,
                    through,
                    now_seconds(),
                    now_millis(),
                )?;
            serde_json::to_value(view).map_err(|_| "TRANSFER_STATE_INVALID")?
        }
        "complete_web_incoming_transfer" => {
            let profile_id = string_arg(args, "profileId")?;
            let transfer_id = string_arg(args, "transferId")?;
            let view = stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .complete_web_incoming_transfer(
                    &mut stored.domain,
                    profile_id,
                    transfer_id,
                    now_seconds(),
                    now_millis(),
                )?;
            changed = true;
            serde_json::to_value(view).map_err(|_| "TRANSFER_STATE_INVALID")?
        }
        "get_background_transfer_work" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            // This command is workspace-wide and must also work before the
            // first profile exists. WebCore handles it before profile lookup.
            .dispatch("", command, args)?,
        "get_tox_user_status" => dispatch_requested_profile_runtime(stored, command, args)?,
        "set_tox_user_status" => {
            let profile_id = selected_profile_id(&stored.domain)?;
            let runtime_value = set_stored_profile_status(stored, &profile_id, args)?;
            changed = true;
            runtime_value
        }
        "set_profile_user_status" => {
            let profile_id = string_arg(args, "profileId")?.to_string();
            let runtime_value = set_stored_profile_status(stored, &profile_id, args)?;
            changed = true;
            runtime_value
        }
        "get_tox_network_status" => dispatch_requested_profile_runtime(stored, command, args)?,
        "load_local_state" | "save_local_state" => {
            dispatch_profile_runtime(stored, string_arg(args, "profileId")?, command, args)?
        }
        "get_tor_status" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .tor_status()?,
        "get_tor_settings" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .tor_settings()?,
        "set_tor_settings" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .apply_tor_settings(
                args.get("settings")
                    .cloned()
                    .ok_or("COMMAND_ARGUMENT_INVALID")?,
            )?,
        "restart_tor" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .restart_tor()?,
        "get_proxy_settings" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .proxy_settings()?,
        "set_proxy_settings" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .apply_proxy_settings(
                args.get("settings")
                    .cloned()
                    .ok_or("COMMAND_ARGUMENT_INVALID")?,
            )?,
        "get_network_settings" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .network_settings()?,
        "set_network_settings" => stored
            .runtime
            .as_ref()
            .ok_or("RUNTIME_LOCKED")?
            .apply_network_settings(
                args.get("settings")
                    .cloned()
                    .ok_or("COMMAND_ARGUMENT_INVALID")?,
            )?,
        "discover_qtox_profiles" => json!([]),
        "export_qtox_profile" => {
            let profile_id = selected_profile_id(&stored.domain)?.to_string();
            let display_name = stored
                .domain
                .profiles
                .profiles()
                .iter()
                .find(|profile| profile.id == profile_id)
                .map(|profile| profile.display_name.clone())
                .ok_or("PROFILE_NOT_FOUND")?;
            let password = args
                .get("password")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or("PROFILE_PASSWORD_REQUIRED")?;
            if stored
                .domain
                .profiles
                .profiles()
                .iter()
                .find(|profile| profile.id == profile_id)
                .is_some_and(|profile| profile.password_protected)
            {
                stored
                    .runtime
                    .as_ref()
                    .ok_or("RUNTIME_LOCKED")?
                    .verify_profile_password(&profile_id, Some(password))?;
            }
            stored
                .runtime
                .as_ref()
                .ok_or("RUNTIME_LOCKED")?
                .export_qtox_profile(&profile_id, &display_name, password)?
        }
        "get_tox_id"
        | "get_tox_friends"
        | "get_tox_messages"
        | "get_tox_messages_page"
        | "get_tox_messages_snapshot"
        | "get_chat_capabilities"
        | "set_message_reactions"
        | "acknowledge_local_messages"
        | "release_chat_history"
        | "refresh_chat_history_lease"
        | "send_tox_message"
        | "add_tox_friend"
        | "delete_tox_friend"
        | "get_incoming_friend_requests"
        | "accept_incoming_friend_request"
        | "get_tox_status_message"
        | "set_tox_status_message"
        | "set_tox_nickname"
        | "get_pq_status"
        | "complete_pq_identity"
        | "skip_pq_auto"
        | "request_pq_session"
        | "withdraw_pq_session"
        | "accept_pq_session"
        | "reject_pq_session"
        | "request_pq_shutdown"
        | "get_unread_state"
        | "mark_friend_read"
        | "mark_requests_read"
        | "get_file_receive_settings"
        | "set_file_receive_settings"
        | "set_chat_history_enabled"
        | "clear_tox_history"
        | "load_layout_state"
        | "save_layout_state" => dispatch_requested_profile_runtime(stored, command, args)?,
        _ => return Err("COMMAND_NOT_AVAILABLE".to_string()),
    };
    if changed || command_mutates_runtime(command) {
        // UI settings are confirmed to the browser as saved. They live in the
        // volatile active workspace, so seal them before replying; otherwise a
        // service restart inside the regular five-minute payload interval
        // restores the previous settings from encrypted storage.
        let immediate_checkpoint = command_requires_immediate_checkpoint(command);
        let checkpoint = stored.checkpoint(immediate_checkpoint);
        AppState::persist(stored)?;
        if let Err(code) = checkpoint {
            // Optional user data stays at its last valid encrypted snapshot,
            // while the separately reserved savedata snapshot above has
            // already committed. The quota ledger may keep network actions
            // successful, but an explicit UI-state save must never claim
            // durability when its optional payload was not committed.
            if immediate_checkpoint || code != "WORKSPACE_QUOTA_FULL" {
                return Err(code);
            }
        }
    }
    Ok(result)
}

fn command_requires_immediate_checkpoint(command: &str) -> bool {
    matches!(
        command,
        "save_layout_state" | "save_local_state" | "complete_pq_identity" | "skip_pq_auto"
    )
}

fn command_mutates_runtime(command: &str) -> bool {
    matches!(
        command,
        "send_tox_message"
            | "add_tox_friend"
            | "delete_tox_friend"
            | "accept_incoming_friend_request"
            | "set_message_reactions"
            | "acknowledge_local_messages"
            | "set_tox_user_status"
            | "set_profile_user_status"
            | "set_tox_status_message"
            | "set_tox_nickname"
            | "set_profile_avatar"
            | "send_tox_avatar"
            | "set_tor_settings"
            | "restart_tor"
            | "set_proxy_settings"
            | "set_network_settings"
            | "request_pq_session"
            | "complete_pq_identity"
            | "skip_pq_auto"
            | "withdraw_pq_session"
            | "accept_pq_session"
            | "reject_pq_session"
            | "request_pq_shutdown"
            | "mark_friend_read"
            | "mark_requests_read"
            | "set_file_receive_settings"
            | "set_chat_history_enabled"
            | "clear_tox_history"
            | "save_local_state"
            | "save_layout_state"
            | "control_tox_file_transfer"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginOutgoingTransferRequest {
    profile_id: String,
    friend_number: u32,
    filename: String,
    mime: String,
    size_bytes: u64,
}

fn begin_outgoing_transfer(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: BeginOutgoingTransferRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !valid_profile_id(&input.profile_id) {
        return error_response(400, "PROFILE_ID_INVALID");
    }
    authenticated_operation(request, state, |stored, session, _| {
        if !stored.domain.ui_lease.owned_by(&session.device_hash) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        let view = stored
            .runtime
            .as_mut()
            .ok_or("RUNTIME_LOCKED")?
            .begin_web_outgoing_transfer(
                &mut stored.domain,
                &input.profile_id,
                input.friend_number,
                &input.filename,
                &input.mime,
                input.size_bytes,
                now_seconds(),
                now_millis(),
            )?;
        let _ = stored.checkpoint(false);
        AppState::persist(stored)?;
        serde_json::to_value(view).map_err(|_| "TRANSFER_STATE_INVALID".to_string())
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    transfer_id: String,
}

fn transfer_status(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: TransferRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    authenticated_operation(request, state, |stored, session, _| {
        if !stored.domain.ui_lease.owned_by(&session.device_hash) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        let now = now_seconds();
        let now_ms = now_millis();
        let view = stored
            .runtime
            .as_mut()
            .ok_or("RUNTIME_LOCKED")?
            .web_transfer_status(&mut stored.domain, &input.transfer_id, now, now_ms)?;
        if matches!(view.state.as_str(), "complete" | "cancelled" | "failed") {
            AppState::persist(stored)?;
        }
        serde_json::to_value(view).map_err(|_| "TRANSFER_STATE_INVALID".to_string())
    })
}

fn upload_transfer_chunk(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    if request
        .headers
        .get("content-type")
        .is_none_or(|value| !value.eq_ignore_ascii_case("application/octet-stream"))
    {
        return error_response(400, "TRANSFER_CONTENT_TYPE_INVALID");
    }
    let transfer_id = match request.headers.get("x-kaigen-transfer-id") {
        Some(value) if valid_transfer_id(value) => value.clone(),
        _ => return error_response(400, "TRANSFER_ID_INVALID"),
    };
    let profile_id = match request.headers.get("x-kaigen-profile-id") {
        Some(value) if valid_profile_id(value) => value.clone(),
        _ => return error_response(400, "PROFILE_ID_INVALID"),
    };
    let position = match request
        .headers
        .get("x-kaigen-transfer-position")
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(value) => value,
        None => return error_response(400, "TRANSFER_POSITION_INVALID"),
    };
    authenticated_operation(request, state, |stored, session, _| {
        if !stored.domain.ui_lease.owned_by(&session.device_hash)
            || !stored.domain.ui_lease.has_fresh_holder(now_seconds())
        {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        let outcome = stored
            .runtime
            .as_mut()
            .ok_or("RUNTIME_LOCKED")?
            .upload_web_transfer_chunk(
                &mut stored.domain,
                &profile_id,
                &transfer_id,
                position,
                &request.body,
                now_seconds(),
                now_millis(),
            )?;
        serde_json::to_value(outcome).map_err(|_| "TRANSFER_STATE_INVALID".to_string())
    })
}

fn download_transfer_chunk(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: TransferRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let result = (|| -> Result<Option<(u64, Vec<u8>, String)>, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, _) = authenticate_request(&inner, request, csrf)?;
        let stored = inner
            .workspaces
            .get_mut(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        if !stored.domain.ui_lease.owned_by(&session.device_hash)
            || !stored.domain.ui_lease.has_fresh_holder(now_seconds())
        {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        let now = now_seconds();
        let now_ms = now_millis();
        let chunk = stored
            .runtime
            .as_mut()
            .ok_or("RUNTIME_LOCKED")?
            .take_web_incoming_chunk(&mut stored.domain, &input.transfer_id, now, now_ms)?;
        let terminal = if let Some(chunk) = chunk.as_ref() {
            matches!(
                chunk.transfer.state.as_str(),
                "complete" | "cancelled" | "failed"
            )
        } else {
            let view = stored
                .runtime
                .as_mut()
                .ok_or("RUNTIME_LOCKED")?
                .web_transfer_status(&mut stored.domain, &input.transfer_id, now, now_ms)?;
            matches!(view.state.as_str(), "complete" | "cancelled" | "failed")
        };
        if terminal {
            AppState::persist(stored)?;
        }
        if let Some(chunk) = chunk {
            Ok(Some((chunk.position, chunk.data, chunk.transfer.state)))
        } else {
            Ok(None)
        }
    })();
    match result {
        Ok(Some((position, bytes, transfer_state))) => HttpResponse {
            status: 200,
            reason: reason(200),
            headers: vec![
                (
                    "Content-Type".to_string(),
                    "application/octet-stream".to_string(),
                ),
                (
                    "X-Kaigen-Transfer-Position".to_string(),
                    position.to_string(),
                ),
                ("X-Kaigen-Transfer-State".to_string(), transfer_state),
            ],
            body: ResponseBody::Bytes(bytes),
        },
        Ok(None) => HttpResponse {
            status: 204,
            reason: reason(204),
            headers: vec![],
            body: ResponseBody::Bytes(Vec::new()),
        },
        Err(code) => operation_error(&code),
    }
}

fn valid_transfer_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Deserialize)]
struct ProfileExportRequest {
    password: String,
}

struct ProfileExportPreparation {
    workspace_root: PathBuf,
    material: tauri_app_lib::web_core::WebProfileExportMaterial,
    created_at: u64,
}

fn prepare_profile_export(
    request: &HttpRequest,
    state: &Arc<AppState>,
) -> Result<ProfileExportPreparation, String> {
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
    let (session, _) = authenticate_request(&inner, request, csrf)?;
    let stored = inner
        .workspaces
        .get(&session.workspace_hash)
        .ok_or("AUTH_INVALID")?;
    if !stored.domain.ui_lease.owned_by(&session.device_hash)
        || !stored.domain.ui_lease.has_fresh_holder(now_seconds())
    {
        return Err("UI_LEASE_TRANSFERRED".to_string());
    }
    if stored.domain.close_transaction.is_some() {
        return Err("WORKSPACE_FROZEN".to_string());
    }
    let material = stored
        .runtime
        .as_ref()
        .ok_or("RUNTIME_LOCKED")?
        .selected_profile_export_material(&stored.domain)?;
    Ok(ProfileExportPreparation {
        workspace_root: stored.root.clone(),
        material,
        created_at: now_seconds(),
    })
}

async fn export_profile_tox(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let mut input: ProfileExportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if input.password.is_empty() || input.password.as_bytes().len() > 1024 {
        wipe_string(&mut input.password);
        return error_response(400, "PROFILE_EXPORT_PASSWORD_INVALID");
    }
    let preparation = match prepare_profile_export(request, &state) {
        Ok(value) => value,
        Err(code) => {
            wipe_string(&mut input.password);
            return operation_error(&code);
        }
    };
    let password = std::mem::take(&mut input.password);
    let encrypted = tokio::task::spawn_blocking(move || {
        let mut metadata_json = preparation.material.metadata_json;
        let mut settings_json = preparation.material.settings_json;
        let mut profile_files = preparation.material.profile_files;
        let result = encrypt_tox_profile_export(preparation.material.savedata, password)
            .and_then(tauri_app_lib::encode_qtox_profile_archive);
        wipe_bytes(&mut metadata_json);
        wipe_bytes(&mut settings_json);
        for file in &mut profile_files {
            wipe_bytes(&mut file.bytes);
        }
        result
    })
    .await
    .map_err(|_| "PROFILE_EXPORT_FAILED".to_string())
    .and_then(|value| value);
    match encrypted {
        Ok(bytes) => HttpResponse {
            status: 200,
            reason: reason(200),
            headers: vec![
                ("Content-Type".to_string(), "application/zip".to_string()),
                (
                    "Content-Disposition".to_string(),
                    "attachment; filename=\"kaigen-profile-qtox.zip\"".to_string(),
                ),
            ],
            body: ResponseBody::Bytes(bytes),
        },
        Err(code) => operation_error(&code),
    }
}

async fn export_profile_package(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let mut input: ProfileExportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if input.password.is_empty() || input.password.as_bytes().len() > 1024 {
        wipe_string(&mut input.password);
        return error_response(400, "PROFILE_EXPORT_PASSWORD_INVALID");
    }
    let mut preparation = match prepare_profile_export(request, &state) {
        Ok(value) => value,
        Err(code) => {
            wipe_string(&mut input.password);
            return operation_error(&code);
        }
    };
    let artifact_id = match random_token(24) {
        Ok(value) => value,
        Err(code) => {
            wipe_bytes(&mut preparation.material.savedata);
            wipe_string(&mut input.password);
            return operation_error(&code);
        }
    };
    let password = std::mem::take(&mut input.password);
    let root = preparation.workspace_root;
    let material = preparation.material;
    let created_at = preparation.created_at;
    let built = tokio::task::spawn_blocking(move || {
        let mut metadata_json = material.metadata_json;
        let mut settings_json = material.settings_json;
        let profile_files = material
            .profile_files
            .into_iter()
            .map(|file| (file.path, file.bytes))
            .collect();
        let result = archive::build_profile_archive(
            &root,
            &artifact_id,
            profile_files,
            &metadata_json,
            &settings_json,
            material.savedata,
            created_at,
            password,
        );
        wipe_bytes(&mut metadata_json);
        wipe_bytes(&mut settings_json);
        result
    })
    .await
    .map_err(|_| "PROFILE_EXPORT_FAILED".to_string())
    .and_then(|value| value);
    match built {
        Ok(artifact) => profile_archive_response(artifact),
        Err(code) => operation_error(&code),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartProfileImportRequest {
    kind: String,
    size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishProfileImportRequest {
    import_id: String,
    name: String,
    #[serde(default)]
    password: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelProfileImportRequest {
    import_id: String,
}

enum DecryptedProfileImport {
    Tox(Vec<u8>),
    QtoxZip(tauri_app_lib::QtoxZipImportMaterial),
    Kai(tauri_app_lib::web_core::WebKaiImportMaterial),
    Package(archive::RestoredProfilePackage),
}

fn start_profile_import(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: StartProfileImportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !matches!(input.kind.as_str(), "tox" | "qtoxZip" | "kai" | "package")
        || input.size_bytes == 0
        || (input.kind == "tox" && input.size_bytes > MAX_RAW_PROFILE_IMPORT_BYTES)
    {
        return error_response(400, "PROFILE_IMPORT_SIZE_INVALID");
    }
    authenticated_operation(request, state, |stored, session, _| {
        if !stored.domain.ui_lease.owned_by(&session.device_hash)
            || !stored.domain.ui_lease.has_fresh_holder(now_seconds())
        {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        if matches!(input.kind.as_str(), "package" | "kai" | "qtoxZip")
            && input.size_bytes
                > stored
                    .domain
                    .quota
                    .user_limit_bytes
                    .saturating_add(PROFILE_PACKAGE_IMPORT_OVERHEAD_BYTES)
        {
            return Err("PROFILE_IMPORT_SIZE_INVALID".to_string());
        }
        if stored
            .pending_profile_import
            .as_ref()
            .is_some_and(|pending| {
                now_seconds().saturating_sub(pending.created_at) >= PROFILE_IMPORT_TTL_SECONDS
                    && !pending.finalizing
            })
        {
            if let Some(expired) = stored.pending_profile_import.take() {
                let _ = remove_profile_import_file(&stored.active_root, &expired);
            }
        }
        if stored.pending_profile_import.is_some() {
            return Err("PROFILE_IMPORT_ALREADY_IN_PROGRESS".to_string());
        }
        fs::create_dir_all(&stored.active_root)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        let import_id = random_token(24)?;
        let path = stored
            .active_root
            .join(format!(".profile-import-{import_id}.upload"));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        protect_private_file(&path)?;
        drop(file);
        stored.pending_profile_import = Some(PendingProfileImport {
            id: import_id.clone(),
            kind: input.kind,
            path,
            expected_bytes: input.size_bytes,
            received_bytes: 0,
            created_at: now_seconds(),
            finalizing: false,
        });
        Ok(json!({
            "importId": import_id,
            "chunkBytes": MAX_JSON_BYTES,
        }))
    })
}

fn upload_profile_import(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    if request
        .headers
        .get("content-type")
        .is_none_or(|value| !value.eq_ignore_ascii_case("application/octet-stream"))
    {
        return error_response(400, "PROFILE_IMPORT_CONTENT_TYPE_INVALID");
    }
    if request.body.is_empty() || request.body.len() > MAX_JSON_BYTES {
        return error_response(400, "PROFILE_IMPORT_CHUNK_INVALID");
    }
    let import_id = match request.headers.get("x-kaigen-import-id") {
        Some(value) if valid_transfer_id(value) => value.clone(),
        _ => return error_response(400, "PROFILE_IMPORT_ID_INVALID"),
    };
    let position = match request
        .headers
        .get("x-kaigen-import-position")
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(value) => value,
        None => return error_response(400, "PROFILE_IMPORT_POSITION_INVALID"),
    };
    authenticated_operation(request, state, |stored, session, _| {
        if !stored.domain.ui_lease.owned_by(&session.device_hash)
            || !stored.domain.ui_lease.has_fresh_holder(now_seconds())
        {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        if stored.domain.close_transaction.is_some() {
            return Err("WORKSPACE_FROZEN".to_string());
        }
        let pending = stored
            .pending_profile_import
            .as_mut()
            .filter(|pending| pending.id == import_id)
            .ok_or("PROFILE_IMPORT_NOT_FOUND")?;
        if pending.finalizing || position != pending.received_bytes {
            return Err("PROFILE_IMPORT_POSITION_INVALID".to_string());
        }
        let next = position
            .checked_add(request.body.len() as u64)
            .ok_or("PROFILE_IMPORT_SIZE_INVALID")?;
        if next > pending.expected_bytes {
            return Err("PROFILE_IMPORT_SIZE_INVALID".to_string());
        }
        let current_size = fs::metadata(&pending.path)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?
            .len();
        if current_size != pending.received_bytes {
            return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(&pending.path)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        file.write_all(&request.body)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        pending.received_bytes = next;
        Ok(json!({
            "receivedBytes": pending.received_bytes,
            "complete": pending.received_bytes == pending.expected_bytes,
        }))
    })
}

async fn finish_profile_import(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let mut input: FinishProfileImportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let name = input.name.trim().to_string();
    if !valid_transfer_id(&input.import_id) || name.len() > 128 || input.password.len() > 1024 {
        wipe_string(&mut input.password);
        return error_response(400, "PROFILE_IMPORT_ARGUMENT_INVALID");
    }
    let expected_hash = match URL_SAFE_NO_PAD.decode(&input.sha256) {
        Ok(value) if value.len() == 32 => {
            let mut hash = [0_u8; 32];
            hash.copy_from_slice(&value);
            hash
        }
        _ => {
            wipe_string(&mut input.password);
            return error_response(400, "PROFILE_IMPORT_HASH_INVALID");
        }
    };
    let csrf = request.headers.get("x-kaigen-csrf").cloned();
    let preparation =
        (|| -> Result<([u8; 32], [u8; 32], PathBuf, u64, String, PathBuf, PathBuf), String> {
            let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
            let (session, _) = authenticate_request(&inner, request, csrf.as_deref())?;
            let stored = inner
                .workspaces
                .get_mut(&session.workspace_hash)
                .ok_or("AUTH_INVALID")?;
            if !stored.domain.ui_lease.owned_by(&session.device_hash)
                || !stored.domain.ui_lease.has_fresh_holder(now_seconds())
            {
                return Err("UI_LEASE_TRANSFERRED".to_string());
            }
            if stored.domain.close_transaction.is_some() {
                return Err("WORKSPACE_FROZEN".to_string());
            }
            let pending = stored
                .pending_profile_import
                .as_mut()
                .filter(|pending| pending.id == input.import_id)
                .ok_or("PROFILE_IMPORT_NOT_FOUND")?;
            if pending.finalizing || pending.received_bytes != pending.expected_bytes {
                return Err("PROFILE_IMPORT_INCOMPLETE".to_string());
            }
            pending.finalizing = true;
            Ok((
                session.workspace_hash,
                session.device_hash,
                pending.path.clone(),
                pending.expected_bytes,
                pending.kind.clone(),
                stored
                    .active_root
                    .join(format!(".profile-restore-{}", input.import_id)),
                stored.active_root.clone(),
            ))
        })();
    let (
        workspace_hash,
        device_hash,
        upload_path,
        expected_bytes,
        import_kind,
        staging_root,
        active_root,
    ) = match preparation {
        Ok(value) => value,
        Err(code) => {
            wipe_string(&mut input.password);
            return operation_error(&code);
        }
    };
    if import_kind != "package" && import_kind != "qtoxZip" && name.is_empty() {
        wipe_string(&mut input.password);
        reset_pending_profile_import(&state, workspace_hash, &input.import_id);
        return error_response(400, "PROFILE_IMPORT_ARGUMENT_INVALID");
    }
    let mut password = std::mem::take(&mut input.password);
    let staging_cleanup = staging_root.clone();
    let decrypted = tokio::task::spawn_blocking(move || {
        let result = (|| -> Result<DecryptedProfileImport, String> {
            let mut encrypted = fs::read(&upload_path)
                .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            if encrypted.len() as u64 != expected_bytes {
                wipe_bytes(&mut encrypted);
                return Err("PROFILE_IMPORT_SIZE_INVALID".to_string());
            }
            let actual_hash: [u8; 32] = Sha256::digest(&encrypted).into();
            if !bool::from(actual_hash.ct_eq(&expected_hash)) {
                wipe_bytes(&mut encrypted);
                return Err("PROFILE_IMPORT_HASH_INVALID".to_string());
            }
            match import_kind.as_str() {
                "tox" => decrypt_tox_profile_import(encrypted, &password)
                    .map(DecryptedProfileImport::Tox),
                "kai" => {
                    wipe_bytes(&mut encrypted);
                    tauri_app_lib::web_core::read_kai_profile_import(
                        &upload_path,
                        (!password.is_empty()).then_some(password.as_str()),
                    )
                    .map(DecryptedProfileImport::Kai)
                }
                "qtoxZip" => {
                    wipe_bytes(&mut encrypted);
                    tauri_app_lib::read_qtox_zip_import(
                        &upload_path,
                        (!password.is_empty()).then_some(password.as_str()),
                    )
                    .map(DecryptedProfileImport::QtoxZip)
                }
                _ => {
                    if password.is_empty() {
                        wipe_bytes(&mut encrypted);
                        return Err("PROFILE_PASSWORD_REQUIRED".to_string());
                    }
                    wipe_bytes(&mut encrypted);
                    archive::restore_profile_archive(&upload_path, &staging_root, &password)
                        .map(DecryptedProfileImport::Package)
                }
            }
        })();
        match result {
            Ok(decrypted) => Ok((decrypted, password)),
            Err(error) => {
                wipe_string(&mut password);
                Err(error)
            }
        }
    })
    .await
    .map_err(|_| "PROFILE_IMPORT_FAILED".to_string())
    .and_then(|value| value);
    let (decrypted, mut password) = match decrypted {
        Ok(value) => value,
        Err(code) => {
            let _ =
                remove_profile_restore_directory(&active_root, &staging_cleanup, &input.import_id);
            reset_pending_profile_import(&state, workspace_hash, &input.import_id);
            return operation_error(&code);
        }
    };
    let (mut savedata, restored_data_root, restored_data_files, imported_name) = match decrypted {
        DecryptedProfileImport::Tox(savedata) => (savedata, None, Vec::new(), name),
        DecryptedProfileImport::QtoxZip(material) => {
            let imported_name = if name.is_empty() {
                material.imported_name
            } else {
                name
            };
            (material.savedata, None, material.data_files, imported_name)
        }
        DecryptedProfileImport::Kai(material) => {
            (material.savedata, None, material.data_files, name)
        }
        DecryptedProfileImport::Package(package) => (
            package.savedata,
            Some(package.data_root),
            Vec::new(),
            package.display_name,
        ),
    };

    let result = (|| -> Result<Value, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, _) = authenticate_request(&inner, request, csrf.as_deref())?;
        if session.workspace_hash != workspace_hash || session.device_hash != device_hash {
            return Err("AUTH_INVALID".to_string());
        }
        let stored = inner
            .workspaces
            .get_mut(&workspace_hash)
            .ok_or("AUTH_INVALID")?;
        if !stored.domain.ui_lease.owned_by(&device_hash)
            || !stored.domain.ui_lease.has_fresh_holder(now_seconds())
        {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        let pending = stored
            .pending_profile_import
            .as_ref()
            .filter(|pending| pending.id == input.import_id && pending.finalizing)
            .ok_or("PROFILE_IMPORT_NOT_FOUND")?;
        if stored.runtime.is_none() {
            return Err("RUNTIME_LOCKED".to_string());
        }
        let profile_id = random_token(18)?;
        remove_profile_import_file(&stored.active_root, pending)?;
        stored.pending_profile_import = None;
        let profile_password_protected = !password.is_empty();
        stored.domain.add_profile(
            profile_id.clone(),
            imported_name,
            profile_password_protected,
        )?;
        let activate = stored.domain.profiles.active_count() < 3;
        if activate {
            if let Err(error) = stored.domain.profiles.activate(&profile_id) {
                let _ = stored.domain.remove_profile(&profile_id);
                return Err(error);
            }
        }
        let imported = stored
            .runtime
            .as_mut()
            .ok_or("RUNTIME_LOCKED")?
            .import_profile(
                &profile_id,
                profile_password_protected.then_some(password.as_str()),
                std::mem::take(&mut savedata),
                activate,
                restored_data_root.as_deref(),
                restored_data_files,
            );
        wipe_string(&mut password);
        if let Err(error) = imported {
            let _ = stored
                .runtime
                .as_mut()
                .and_then(|runtime| runtime.remove_profile_data(&profile_id).ok());
            let _ = stored.domain.remove_profile(&profile_id);
            return Err(error);
        }
        if let Err(error) =
            remove_profile_restore_directory(&active_root, &staging_cleanup, &input.import_id)
        {
            let _ = stored
                .runtime
                .as_mut()
                .and_then(|runtime| runtime.remove_profile_data(&profile_id).ok());
            let _ = stored.domain.remove_profile(&profile_id);
            return Err(error);
        }
        if let Err(error) = stored.checkpoint(true) {
            let _ = stored
                .runtime
                .as_mut()
                .and_then(|runtime| runtime.remove_profile_data(&profile_id).ok());
            let _ = stored.domain.remove_profile(&profile_id);
            let _ = stored.checkpoint(true);
            let _ = AppState::persist(stored);
            return Err(error);
        }
        if let Err(error) = AppState::persist(stored) {
            let _ = stored
                .runtime
                .as_mut()
                .and_then(|runtime| runtime.remove_profile_data(&profile_id).ok());
            let _ = stored.domain.remove_profile(&profile_id);
            let _ = stored.checkpoint(true);
            let _ = AppState::persist(stored);
            return Err(error);
        }
        Ok(Value::Array(profile_summaries(stored)))
    })();
    if staging_cleanup.exists() {
        let _ = remove_profile_restore_directory(&active_root, &staging_cleanup, &input.import_id);
    }
    wipe_bytes(&mut savedata);
    wipe_string(&mut password);
    match result {
        Ok(value) => json_response(200, &value),
        Err(code) => {
            reset_pending_profile_import(&state, workspace_hash, &input.import_id);
            operation_error(&code)
        }
    }
}

fn cancel_profile_import(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: CancelProfileImportRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !valid_transfer_id(&input.import_id) {
        return error_response(400, "PROFILE_IMPORT_ID_INVALID");
    }
    authenticated_operation(request, state, |stored, session, _| {
        if !stored.domain.ui_lease.owned_by(&session.device_hash) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        let pending = stored
            .pending_profile_import
            .as_ref()
            .filter(|pending| pending.id == input.import_id)
            .ok_or("PROFILE_IMPORT_NOT_FOUND")?;
        if pending.finalizing {
            return Err("PROFILE_IMPORT_FINALIZING".to_string());
        }
        remove_profile_import_file(&stored.active_root, pending)?;
        stored.pending_profile_import = None;
        Ok(json!({ "cancelled": true }))
    })
}

#[derive(Deserialize)]
struct ArchiveRequest {
    password: String,
    #[serde(default)]
    identifier: Option<String>,
}

struct ArchivePreparation {
    workspace_hash: [u8; 32],
    workspace_root: PathBuf,
    transaction_id: String,
    domain_json: Vec<u8>,
    profile_count: usize,
    created_at: u64,
    workspace_identifier: Option<String>,
}

async fn archive_workspace(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let mut input: ArchiveRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if input.password.is_empty() {
        if let Some(identifier) = input.identifier.as_mut() {
            wipe_string(identifier);
        }
        return error_response(400, "ARCHIVE_PASSWORD_REQUIRED");
    }
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let resource_root = state.config.resource_root.clone();
    let preparation = (|| -> Result<ArchivePreparation, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, _) = authenticate_request(&inner, request, csrf)?;
        let stored = inner
            .workspaces
            .get_mut(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        if !stored.domain.ui_lease.owned_by(&session.device_hash) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        if stored.pending_profile_import.is_some() {
            return Err("PROFILE_IMPORT_IN_PROGRESS".to_string());
        }
        let workspace_identifier = input
            .identifier
            .as_deref()
            .map(WorkspaceIdentifier::parse)
            .transpose()?;
        if workspace_identifier
            .as_ref()
            .is_some_and(|identifier| identifier.hash() != session.workspace_hash)
        {
            return Err("WORKSPACE_IDENTIFIER_INVALID".to_string());
        }
        let transaction_id = stored.domain.begin_close()?.id.clone();
        if let Err(error) = stored.checkpoint(true) {
            let _ = stored.domain.cancel_close();
            let _ = AppState::persist(stored);
            return Err(error);
        }
        if let Err(error) = stored.stop_runtime() {
            let _ = stored.domain.cancel_close();
            let _ = stored.ensure_runtime(&resource_root);
            let _ = AppState::persist(stored);
            return Err(error);
        }
        if let Err(error) = stored.checkpoint_after_stop() {
            let _ = stored.domain.cancel_close();
            let _ = stored.ensure_runtime(&resource_root);
            let _ = AppState::persist(stored);
            return Err(error);
        }
        AppState::persist(stored)?;
        let mut export_domain = serde_json::to_value(&stored.domain)
            .map_err(|_| "ARCHIVE_MANIFEST_INVALID".to_string())?;
        export_domain
            .as_object_mut()
            .ok_or("ARCHIVE_MANIFEST_INVALID")?
            .insert("closeTransaction".to_string(), Value::Null);
        let domain_json = serde_json::to_vec(&export_domain)
            .map_err(|_| "ARCHIVE_MANIFEST_INVALID".to_string())?;
        Ok(ArchivePreparation {
            workspace_hash: session.workspace_hash,
            workspace_root: stored.root.clone(),
            transaction_id,
            domain_json,
            profile_count: stored.domain.profiles.stored_count(),
            created_at: now_seconds(),
            workspace_identifier: input.identifier.take(),
        })
    })();
    let preparation = match preparation {
        Ok(value) => value,
        Err(code) => {
            wipe_string(&mut input.password);
            if let Some(identifier) = input.identifier.as_mut() {
                wipe_string(identifier);
            }
            return operation_error(&code);
        }
    };
    let password = std::mem::take(&mut input.password);
    let root = preparation.workspace_root.clone();
    let transaction_id = preparation.transaction_id.clone();
    let domain_json = preparation.domain_json;
    let profile_count = preparation.profile_count;
    let created_at = preparation.created_at;
    let workspace_identifier = preparation.workspace_identifier;
    let built = tokio::task::spawn_blocking(move || {
        let mut workspace_identifier = workspace_identifier;
        let result = archive::build_workspace_archive(
            &root,
            &transaction_id,
            &domain_json,
            profile_count,
            created_at,
            workspace_identifier.as_deref(),
            password,
        );
        if let Some(identifier) = workspace_identifier.as_mut() {
            wipe_string(identifier);
        }
        result
    })
    .await
    .map_err(|_| "ARCHIVE_BUILD_FAILED".to_string())
    .and_then(|value| value);
    let artifact = match built {
        Ok(value) => value,
        Err(code) => {
            rollback_close(
                &state,
                preparation.workspace_hash,
                &preparation.transaction_id,
            );
            return operation_error(&code);
        }
    };
    let finalization = (|| -> Result<(), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let stored = inner
            .workspaces
            .get_mut(&preparation.workspace_hash)
            .ok_or("CLOSE_TRANSACTION_NOT_FOUND")?;
        let transaction = stored
            .domain
            .close_transaction
            .as_mut()
            .filter(|transaction| transaction.id == preparation.transaction_id)
            .ok_or("CLOSE_TRANSACTION_INVALID")?;
        transaction.archive_complete(artifact.sha256, artifact.bytes)?;
        AppState::persist(stored)
    })();
    if let Err(code) = finalization {
        let _ = archive::remove_workspace_archive(
            &preparation.workspace_root,
            &preparation.transaction_id,
        );
        rollback_close(
            &state,
            preparation.workspace_hash,
            &preparation.transaction_id,
        );
        return operation_error(&code);
    }
    archive_response(artifact)
}

fn cancel_archive(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    authenticated_operation(request, Arc::clone(&state), |stored, session, _| {
        if !stored.domain.ui_lease.owned_by(&session.device_hash) {
            return Err("UI_LEASE_TRANSFERRED".to_string());
        }
        let transaction_id = stored
            .domain
            .close_transaction
            .as_ref()
            .map(|transaction| transaction.id.clone())
            .ok_or("CLOSE_TRANSACTION_NOT_FOUND")?;
        archive::remove_workspace_archive(&stored.root, &transaction_id)?;
        stored.domain.cancel_close()?;
        stored.ensure_runtime(&state.config.resource_root)?;
        AppState::persist(stored)?;
        Ok(json!({ "cancelled": true }))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DestroyWorkspaceRequest {
    #[serde(default)]
    explicit_confirmation: bool,
}

fn destroy_workspace(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: DestroyWorkspaceRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let destroyed = (|| -> Result<(PathBuf, PathBuf, [u8; 32], bool), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, cookie) = authenticate_request(&inner, request, csrf)?;
        if !input.explicit_confirmation {
            return Err("WORKSPACE_DESTROY_CONFIRMATION_REQUIRED".to_string());
        }
        let clear_legacy_cookie =
            legacy_device_cookie(request).is_some_and(|legacy| legacy == cookie);
        {
            let stored = inner
                .workspaces
                .get_mut(&session.workspace_hash)
                .ok_or("AUTH_INVALID")?;
            if !stored.domain.ui_lease.owned_by(&session.device_hash) {
                return Err("UI_LEASE_TRANSFERRED".to_string());
            }
            stored.stop_runtime()?;
            stored.domain.destroy_without_export();
            // Persist the cryptographic erasure before deleting ciphertext. If
            // filesystem cleanup is interrupted, the orphaned payload no
            // longer has a durable key capable of opening it.
            AppState::persist(stored)?;
        }
        let workspace_hash = session.workspace_hash;
        let removed = inner
            .workspaces
            .remove(&workspace_hash)
            .ok_or("AUTH_INVALID")?;
        inner
            .sessions
            .retain(|_, session| session.workspace_hash != workspace_hash);
        Ok((
            removed.root,
            removed.active_root,
            workspace_hash,
            clear_legacy_cookie,
        ))
    })();
    let (workspace_root, active_root, workspace_hash, clear_legacy_cookie) = match destroyed {
        Ok(value) => value,
        Err(code) => return operation_error(&code),
    };
    let active_result = state.remove_active_workspace_directory(&active_root);
    let storage_result = state.remove_workspace_directory(&workspace_root);
    if active_result.is_err() || storage_result.is_err() {
        return error_response(500, "WORKSPACE_DESTROY_STORAGE_CLEANUP_FAILED");
    }
    let mut response = json_response(200, &json!({ "destroyed": true }));
    response.headers.push((
        "Set-Cookie".to_string(),
        format!(
            "{}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
            workspace_cookie_name(&workspace_hash)
        ),
    ));
    if clear_legacy_cookie {
        response.headers.push((
            "Set-Cookie".to_string(),
            format!(
                "{LEGACY_DEVICE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
            ),
        ));
    }
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EraseRequest {
    transaction_id: String,
    archive_hash: String,
    archive_bytes: u64,
    explicit_confirmation: bool,
}

fn erase(request: &HttpRequest, state: Arc<AppState>) -> HttpResponse {
    let input: EraseRequest = match parse_json(request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let hash = match URL_SAFE_NO_PAD.decode(&input.archive_hash) {
        Ok(bytes) if bytes.len() == 32 => {
            let mut hash = [0_u8; 32];
            hash.copy_from_slice(&bytes);
            hash
        }
        _ => return error_response(400, "ARCHIVE_CONFIRMATION_INVALID"),
    };
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let erased = (|| -> Result<(PathBuf, PathBuf, [u8; 32], bool), String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, cookie) = authenticate_request(&inner, request, csrf)?;
        let clear_legacy_cookie =
            legacy_device_cookie(request).is_some_and(|legacy| legacy == cookie);
        {
            let stored = inner
                .workspaces
                .get_mut(&session.workspace_hash)
                .ok_or("AUTH_INVALID")?;
            if !stored.domain.ui_lease.owned_by(&session.device_hash) {
                return Err("UI_LEASE_TRANSFERRED".to_string());
            }
            stored.domain.erase_after_archive_confirmation(
                &input.transaction_id,
                hash,
                input.archive_bytes,
                input.explicit_confirmation,
            )?;
            stored.stop_runtime()?;
            // Persist the erased marker before deleting ciphertext.  If
            // directory cleanup is interrupted, no durable workspace key
            // remains capable of opening the orphaned payload.
            AppState::persist(stored)?;
        }
        let workspace_hash = session.workspace_hash;
        let removed = inner
            .workspaces
            .remove(&workspace_hash)
            .ok_or("AUTH_INVALID")?;
        inner
            .sessions
            .retain(|_, session| session.workspace_hash != workspace_hash);
        Ok((
            removed.root,
            removed.active_root,
            workspace_hash,
            clear_legacy_cookie,
        ))
    })();
    let (workspace_root, active_root, workspace_hash, clear_legacy_cookie) = match erased {
        Ok(value) => value,
        Err(code) => return operation_error(&code),
    };
    let active_result = state.remove_active_workspace_directory(&active_root);
    let storage_result = state.remove_workspace_directory(&workspace_root);
    if active_result.is_err() || storage_result.is_err() {
        return error_response(500, "ERASURE_STORAGE_CLEANUP_FAILED");
    }
    let mut response = json_response(200, &json!({ "erased": true }));
    response.headers.push((
        "Set-Cookie".to_string(),
        format!(
            "{}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
            workspace_cookie_name(&workspace_hash)
        ),
    ));
    if clear_legacy_cookie {
        response.headers.push((
            "Set-Cookie".to_string(),
            format!(
                "{LEGACY_DEVICE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
            ),
        ));
    }
    response
}

fn rollback_close(state: &Arc<AppState>, workspace_hash: [u8; 32], transaction_id: &str) {
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    let Some(stored) = inner.workspaces.get_mut(&workspace_hash) else {
        return;
    };
    if stored
        .domain
        .close_transaction
        .as_ref()
        .is_some_and(|transaction| transaction.id == transaction_id)
    {
        let _ = archive::remove_workspace_archive(&stored.root, transaction_id);
        let _ = stored.domain.cancel_close();
        let _ = stored.ensure_runtime(&state.config.resource_root);
        let _ = AppState::persist(stored);
    }
}

fn archive_response(artifact: ArchiveArtifact) -> HttpResponse {
    HttpResponse {
        status: 200,
        reason: reason(200),
        headers: vec![
            (
                "Content-Type".to_string(),
                "application/vnd.kaigen.workspace+encrypted".to_string(),
            ),
            (
                "Content-Disposition".to_string(),
                "attachment; filename=\"kaigen-workspace.kaigen\"".to_string(),
            ),
            (
                "X-Kaigen-Archive-SHA256".to_string(),
                URL_SAFE_NO_PAD.encode(artifact.sha256),
            ),
            (
                "X-Kaigen-Archive-Transaction".to_string(),
                artifact.transaction_id,
            ),
        ],
        body: ResponseBody::File {
            path: artifact.path,
            length: artifact.bytes,
            delete_after: false,
        },
    }
}

fn profile_archive_response(artifact: ArchiveArtifact) -> HttpResponse {
    HttpResponse {
        status: 200,
        reason: reason(200),
        headers: vec![
            (
                "Content-Type".to_string(),
                "application/vnd.kaigen.profile+encrypted".to_string(),
            ),
            (
                "Content-Disposition".to_string(),
                "attachment; filename=\"kaigen-profile.kaigen-profile\"".to_string(),
            ),
            (
                "X-Kaigen-Export-SHA256".to_string(),
                URL_SAFE_NO_PAD.encode(artifact.sha256),
            ),
        ],
        body: ResponseBody::File {
            path: artifact.path,
            length: artifact.bytes,
            delete_after: true,
        },
    }
}

fn authenticated_operation<F>(
    request: &HttpRequest,
    state: Arc<AppState>,
    operation: F,
) -> HttpResponse
where
    F: FnOnce(&mut StoredWorkspace, SessionContext, bool) -> Result<Value, String>,
{
    let csrf = request.headers.get("x-kaigen-csrf").map(String::as_str);
    let result = (|| -> Result<Value, String> {
        let mut inner = state.inner.lock().map_err(|_| "STATE_UNAVAILABLE")?;
        let (session, _) = authenticate_request(&inner, request, csrf)?;
        let maintenance = inner.maintenance;
        let stored = inner
            .workspaces
            .get_mut(&session.workspace_hash)
            .ok_or("AUTH_INVALID")?;
        operation(stored, session, maintenance)
    })();
    match result {
        Ok(value) => json_response(200, &value),
        Err(code) => operation_error(&code),
    }
}

async fn handle_websocket(
    mut stream: TcpStream,
    request: HttpRequest,
    state: Arc<AppState>,
) -> Result<(), String> {
    if !valid_origin(&request, &state.config.public_origin)
        || !request
            .headers
            .get("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        || !request.headers.get("connection").is_some_and(|value| {
            value
                .to_ascii_lowercase()
                .split(',')
                .any(|item| item.trim() == "upgrade")
        })
        || !request
            .headers
            .get("sec-websocket-protocol")
            .is_some_and(|value| value.split(',').any(|item| item.trim() == "kaigen.v1"))
    {
        return write_response(&mut stream, error_response(400, "WEBSOCKET_INVALID")).await;
    }
    let authenticated = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| authenticate_websocket_request(&inner, &request).ok())
        .map(|(session, token)| (session, token))
        .ok_or_else(|| "AUTH_INVALID".to_string())?;
    let key = request
        .headers
        .get("sec-websocket-key")
        .ok_or_else(|| "WEBSOCKET_INVALID".to_string())?;
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept = STANDARD.encode(digest.finalize());
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: kaigen.v1\r\nCache-Control: no-store\r\n\r\n"
    );
    stream
        .write_all(handshake.as_bytes())
        .await
        .map_err(|_| "WEBSOCKET_WRITE_FAILED".to_string())?;
    let mut interval = tokio::time::interval(Duration::from_secs(20));
    loop {
        interval.tick().await;
        let still_authorized = state
            .inner
            .lock()
            .ok()
            .and_then(|inner| authenticate_websocket_request(&inner, &request).ok())
            .is_some_and(|(session, token)| {
                session.device_hash == authenticated.0.device_hash && token == authenticated.1
            });
        if !still_authorized {
            let _ = write_websocket_close(&mut stream, 4001, b"control transferred").await;
            return Ok(());
        }
        let event = json!({
            "event": "workspace-heartbeat",
            "payload": { "at": now_seconds().saturating_mul(1000) }
        })
        .to_string();
        if write_websocket_frame(&mut stream, 0x1, event.as_bytes())
            .await
            .is_err()
        {
            return Ok(());
        }
    }
}

async fn write_websocket_close<W>(writer: &mut W, code: u16, reason: &[u8]) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason);
    write_websocket_frame(writer, 0x8, &payload).await
}

async fn write_websocket_frame<W>(writer: &mut W, opcode: u8, payload: &[u8]) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut header = vec![0x80 | opcode];
    match payload.len() {
        length if length < 126 => header.push(length as u8),
        length if length <= u16::MAX as usize => {
            header.push(126);
            header.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            header.push(127);
            header.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    writer.write_all(&header).await?;
    writer.write_all(payload).await?;
    writer.flush().await
}

fn profile_summaries(stored: &StoredWorkspace) -> Vec<Value> {
    let selected = selected_profile_id(&stored.domain).ok();
    stored
        .domain
        .profiles
        .profiles()
        .iter()
        .map(|profile| {
            json!({
                "id": profile.id,
                "name": profile.display_name,
                "fileName": format!("{}.kai", profile.id),
                "encrypted": profile.password_protected,
                "loaded": stored.runtime.as_ref().is_some_and(|runtime| runtime.profile_loaded(&profile.id)),
                "active": selected.as_deref() == Some(profile.id.as_str()),
                "connection": stored.runtime.as_ref().map(|runtime| runtime.profile_connection(&profile.id)).unwrap_or("locked"),
                "userStatus": presence_name(profile.explicitly_selected_presence),
                "unread": 0,
                "avatar": stored.runtime.as_ref().and_then(|runtime| runtime.profile_avatar(&profile.id)),
                "notificationsEnabled": false,
                "unreadTarget": null,
                "error": null
            })
        })
        .collect()
}

fn dispatch_requested_profile_runtime(
    stored: &StoredWorkspace,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    let profile_id = args
        .get("profileId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .map(Ok)
        .unwrap_or_else(|| selected_profile_id(&stored.domain))?;
    dispatch_profile_runtime(stored, &profile_id, command, args)
}

fn dispatch_profile_runtime(
    stored: &StoredWorkspace,
    profile_id: &str,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    stored
        .runtime
        .as_ref()
        .ok_or_else(|| "RUNTIME_LOCKED".to_string())?
        .dispatch(profile_id, command, args)
}

fn set_stored_profile_status(
    stored: &mut StoredWorkspace,
    profile_id: &str,
    args: &Value,
) -> Result<Value, String> {
    let status = presence_from_string(string_arg(args, "status")?)?;
    let previous = stored
        .domain
        .profiles
        .profiles()
        .iter()
        .find(|profile| profile.id == profile_id)
        .map(|profile| profile.explicitly_selected_presence)
        .ok_or_else(|| "PROFILE_NOT_FOUND".to_string())?;
    stored.domain.profiles.set_presence(profile_id, status)?;
    match dispatch_profile_runtime(stored, profile_id, "set_tox_user_status", args) {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = stored.domain.profiles.set_presence(profile_id, previous);
            Err(error)
        }
    }
}

fn selected_profile_id(domain: &WorkspaceDomain) -> Result<String, String> {
    domain
        .profiles
        .selected_profile_id()
        .map(str::to_string)
        .ok_or_else(|| "NO_ACTIVE_PROFILE".to_string())
}

fn presence_from_string(value: &str) -> Result<Presence, String> {
    match value {
        "online" => Ok(Presence::Online),
        "away" => Ok(Presence::Away),
        "busy" => Ok(Presence::Busy),
        "offline" => Ok(Presence::Offline),
        _ => Err("STATUS_INVALID".to_string()),
    }
}

fn presence_name(value: Presence) -> &'static str {
    match value {
        Presence::Online => "online",
        Presence::Away => "away",
        Presence::Busy => "busy",
        Presence::Offline => "offline",
    }
}

fn string_arg<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| "COMMAND_ARGUMENT_INVALID".to_string())
}

fn nullable_string_arg<'a>(value: &'a Value, name: &str) -> Result<Option<&'a str>, String> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(result)) => Ok(Some(result.as_str())),
        _ => Err("COMMAND_ARGUMENT_INVALID".to_string()),
    }
}

fn optional_password_arg<'a>(value: &'a Value, name: &str) -> Result<Option<&'a str>, String> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(password)) if password.is_empty() => Ok(None),
        Some(Value::String(password)) => Ok(Some(password.as_str())),
        _ => Err("COMMAND_ARGUMENT_INVALID".to_string()),
    }
}

fn bytes_arg(value: &Value, name: &str) -> Result<Vec<u8>, String> {
    serde_json::from_value(value.get(name).cloned().ok_or("COMMAND_ARGUMENT_INVALID")?)
        .map_err(|_| "COMMAND_ARGUMENT_INVALID".to_string())
}

fn optional_bytes_arg(value: &Value, name: &str) -> Result<Option<Vec<u8>>, String> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(bytes) => serde_json::from_value(bytes.clone())
            .map(Some)
            .map_err(|_| "COMMAND_ARGUMENT_INVALID".to_string()),
    }
}

fn parse_json<T: DeserializeOwned>(request: &HttpRequest) -> Result<T, HttpResponse> {
    if request.body.len() > request_body_limit(&request.path) {
        return Err(error_response(413, "REQUEST_TOO_LARGE"));
    }
    serde_json::from_slice(&request.body).map_err(|_| error_response(400, "REQUEST_INVALID"))
}

fn valid_origin(request: &HttpRequest, expected: &str) -> bool {
    request
        .headers
        .get("origin")
        .is_some_and(|value| value == expected)
}

fn valid_workspace_selector(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn request_workspace_selector(request: &HttpRequest) -> Result<Option<&str>, String> {
    let header = request
        .headers
        .get(WORKSPACE_SELECTOR_HEADER)
        .map(String::as_str);
    let protocol = request
        .headers
        .get("sec-websocket-protocol")
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find_map(|item| item.strip_prefix(WORKSPACE_PROTOCOL_PREFIX))
        });
    let selector = match (header, protocol) {
        (Some(left), Some(right)) if left != right => return Err("AUTH_INVALID".to_string()),
        (Some(value), _) | (_, Some(value)) => Some(value),
        (None, None) => None,
    };
    if selector.is_some_and(|value| !valid_workspace_selector(value)) {
        return Err("AUTH_INVALID".to_string());
    }
    Ok(selector)
}

fn workspace_selector(workspace_hash: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(workspace_hash)
}

fn workspace_cookie_name(workspace_hash: &[u8; 32]) -> String {
    format!(
        "{DEVICE_COOKIE_PREFIX}{}",
        workspace_selector(workspace_hash)
    )
}

fn cookie_value(request: &HttpRequest, name: &str) -> Option<String> {
    request
        .headers
        .get("cookie")?
        .split(';')
        .map(str::trim)
        .filter_map(|item| item.split_once('='))
        .find_map(|(cookie_name, value)| (cookie_name == name).then(|| value.to_string()))
        .filter(|value| {
            value.len() == 43
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

fn legacy_device_cookie(request: &HttpRequest) -> Option<String> {
    cookie_value(request, LEGACY_DEVICE_COOKIE_NAME)
}

fn device_cookie_candidates(request: &HttpRequest) -> Vec<String> {
    let mut candidates = Vec::new();
    match request_workspace_selector(request) {
        Ok(Some(selector)) => {
            if let Some(token) = cookie_value(request, &format!("{DEVICE_COOKIE_PREFIX}{selector}"))
            {
                candidates.push(token);
            }
            if let Some(token) = legacy_device_cookie(request) {
                if !candidates.iter().any(|candidate| candidate == &token) {
                    candidates.push(token);
                }
            }
        }
        Ok(None) => {
            if let Some(token) = legacy_device_cookie(request) {
                candidates.push(token);
            }
            if let Some(cookies) = request.headers.get("cookie") {
                for (name, value) in cookies
                    .split(';')
                    .map(str::trim)
                    .filter_map(|item| item.split_once('='))
                {
                    let Some(selector) = name.strip_prefix(DEVICE_COOKIE_PREFIX) else {
                        continue;
                    };
                    if !valid_workspace_selector(selector)
                        || value.len() != 43
                        || !value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                        || candidates.iter().any(|candidate| candidate == value)
                    {
                        continue;
                    }
                    candidates.push(value.to_string());
                }
            }
        }
        Err(_) => {}
    }
    candidates
}

fn device_cookie_matching(request: &HttpRequest, expected: &str) -> Option<String> {
    device_cookie_candidates(request)
        .into_iter()
        .find(|candidate| {
            candidate.len() == expected.len()
                && bool::from(candidate.as_bytes().ct_eq(expected.as_bytes()))
        })
}

#[cfg(test)]
fn device_cookie(request: &HttpRequest) -> Option<String> {
    device_cookie_candidates(request).into_iter().next()
}

fn ensure_workspace_selector(
    request: &HttpRequest,
    workspace_hash: &[u8; 32],
) -> Result<(), String> {
    let Some(actual) = request_workspace_selector(request)? else {
        // Temporary compatibility for a browser tab loaded before this protocol
        // version was deployed. New clients always send a selector.
        return Ok(());
    };
    let expected = workspace_selector(workspace_hash);
    if !bool::from(actual.as_bytes().ct_eq(expected.as_bytes())) {
        return Err("AUTH_INVALID".to_string());
    }
    Ok(())
}

fn authenticate_token(
    inner: &InnerState,
    request: &HttpRequest,
    token: &str,
    csrf: Option<&str>,
) -> Result<SessionContext, String> {
    let session = AppState::authenticate(inner, token, csrf)?;
    ensure_workspace_selector(request, &session.workspace_hash)?;
    Ok(session)
}

fn authenticate_cookie_request(
    inner: &InnerState,
    request: &HttpRequest,
    csrf: Option<&str>,
) -> Result<(SessionContext, String), String> {
    let selector = request_workspace_selector(request)?;
    let candidates = device_cookie_candidates(request);
    if csrf.is_none() && selector.is_none() && candidates.len() != 1 {
        return Err("AUTH_INVALID".to_string());
    }
    let mut csrf_mismatch = false;
    for token in candidates {
        match authenticate_token(inner, request, &token, csrf) {
            Ok(session) => return Ok((session, token)),
            Err(code) if code == "CSRF_INVALID" => csrf_mismatch = true,
            Err(_) => {}
        }
    }
    Err(if csrf_mismatch {
        "CSRF_INVALID".to_string()
    } else {
        "AUTH_INVALID".to_string()
    })
}

fn authenticate_request(
    inner: &InnerState,
    request: &HttpRequest,
    csrf: Option<&str>,
) -> Result<(SessionContext, String), String> {
    if csrf.is_none() {
        return Err("CSRF_INVALID".to_string());
    }
    authenticate_cookie_request(inner, request, csrf)
}

fn authenticate_websocket_request(
    inner: &InnerState,
    request: &HttpRequest,
) -> Result<(SessionContext, String), String> {
    authenticate_cookie_request(inner, request, None)
}

fn session_response(
    value: SessionResponse,
    token: &str,
    workspace_hash: &[u8; 32],
) -> HttpResponse {
    let mut response = json_response(200, &value);
    response.headers.push((
        "Set-Cookie".to_string(),
        format!(
            "{}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800",
            workspace_cookie_name(workspace_hash)
        ),
    ));
    response.headers.push((
        "Set-Cookie".to_string(),
        format!(
            "{LEGACY_DEVICE_COOKIE_NAME}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800"
        ),
    ));
    response
}

fn result_json<T: Serialize>(result: Result<T, String>) -> HttpResponse {
    match result {
        Ok(value) => json_response(200, &value),
        Err(code) if code == "STATE_UNAVAILABLE" => error_response(503, &code),
        Err(code) => error_response(400, &code),
    }
}

fn operation_error(code: &str) -> HttpResponse {
    if code.starts_with("AUTH_") || code == "CSRF_INVALID" {
        error_response(401, code)
    } else if code.starts_with("UI_LEASE_")
        || matches!(
            code,
            "CLOSE_ALREADY_IN_PROGRESS"
                | "CLOSE_TRANSACTION_INVALID"
                | "CLOSE_TRANSACTION_NOT_FOUND"
                | "TRANSFER_CHUNK_STALE"
                | "WORKSPACE_FROZEN"
        )
    {
        error_response(409, code)
    } else if matches!(code, "STATE_UNAVAILABLE" | "RUNTIME_UNAVAILABLE") {
        error_response(503, code)
    } else if code == "WORKSPACE_QUOTA_FULL" || code == "WORKSPACE_SECURITY_RESERVE_FULL" {
        error_response(507, code)
    } else if code
        .bytes()
        .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
    {
        error_response(400, code)
    } else {
        error_response(500, "ARCHIVE_OPERATION_FAILED")
    }
}

fn json_response<T: Serialize>(status: u16, value: &T) -> HttpResponse {
    let body =
        serde_json::to_vec(value).unwrap_or_else(|_| b"{\"code\":\"ENCODING_FAILED\"}".to_vec());
    HttpResponse {
        status,
        reason: reason(status),
        headers: vec![(
            "Content-Type".to_string(),
            "application/json; charset=utf-8".to_string(),
        )],
        body: ResponseBody::Bytes(body),
    }
}

fn error_response(status: u16, code: &str) -> HttpResponse {
    json_response(status, &json!({ "code": code }))
}

async fn write_response(stream: &mut TcpStream, mut response: HttpResponse) -> Result<(), String> {
    let content_length = match &response.body {
        ResponseBody::Bytes(body) => body.len() as u64,
        ResponseBody::File { length, .. } => *length,
    };
    let cleanup_path = match &response.body {
        ResponseBody::File {
            path,
            delete_after: true,
            ..
        } => Some(path.clone()),
        _ => None,
    };
    let result = async {
        response
            .headers
            .push(("Cache-Control".to_string(), "no-store".to_string()));
        response
            .headers
            .push(("Referrer-Policy".to_string(), "no-referrer".to_string()));
        response
            .headers
            .push(("X-Content-Type-Options".to_string(), "nosniff".to_string()));
        response.headers.push((
            "Content-Security-Policy".to_string(),
            WEB_CONTENT_SECURITY_POLICY.to_string(),
        ));
        response.headers.push((
            "Cross-Origin-Opener-Policy".to_string(),
            "same-origin".to_string(),
        ));
        response.headers.push((
            "Cross-Origin-Resource-Policy".to_string(),
            "same-origin".to_string(),
        ));
        response
            .headers
            .push(("X-Frame-Options".to_string(), "DENY".to_string()));
        response
            .headers
            .push(("Connection".to_string(), "close".to_string()));
        response
            .headers
            .push(("Content-Length".to_string(), content_length.to_string()));
        let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, response.reason);
        for (name, value) in response.headers {
            if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
                return Err("RESPONSE_HEADER_INVALID".to_string());
            }
            head.push_str(&name);
            head.push_str(": ");
            head.push_str(&value);
            head.push_str("\r\n");
        }
        head.push_str("\r\n");
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|_| "RESPONSE_WRITE_FAILED".to_string())?;
        match response.body {
            ResponseBody::Bytes(body) => stream
                .write_all(&body)
                .await
                .map_err(|_| "RESPONSE_WRITE_FAILED".to_string())?,
            ResponseBody::File { path, length, .. } => {
                let mut file = tokio::fs::File::open(path)
                    .await
                    .map_err(|_| "RESPONSE_FILE_OPEN_FAILED".to_string())?;
                let mut remaining = length;
                let mut buffer = vec![0_u8; 64 * 1024];
                while remaining > 0 {
                    let read_limit = usize::try_from(remaining.min(buffer.len() as u64))
                        .map_err(|_| "RESPONSE_FILE_LENGTH_INVALID".to_string())?;
                    let read = file
                        .read(&mut buffer[..read_limit])
                        .await
                        .map_err(|_| "RESPONSE_FILE_READ_FAILED".to_string())?;
                    if read == 0 {
                        return Err("RESPONSE_FILE_TRUNCATED".to_string());
                    }
                    stream
                        .write_all(&buffer[..read])
                        .await
                        .map_err(|_| "RESPONSE_WRITE_FAILED".to_string())?;
                    remaining -= read as u64;
                }
                // On Windows, make the file handle release explicit before a
                // verified client can immediately confirm workspace erasure.
                drop(file);
            }
        }
        stream
            .shutdown()
            .await
            .map_err(|_| "RESPONSE_SHUTDOWN_FAILED".to_string())
    }
    .await;
    if let Some(path) = cleanup_path {
        let _ = tokio::fs::remove_file(path).await;
    }
    result
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        507 => "Insufficient Storage",
        _ => "Error",
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn random_token(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut value)
        .map_err(|_| "Secure random source failed".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn verify_p256(spki: &[u8], message: &[u8], signature_bytes: &[u8]) -> bool {
    if spki.len() != 91 || spki[26] != 0x04 {
        return false;
    }
    let public_key = &spki[26..];
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, public_key)
        .verify(message, signature_bytes)
        .is_ok()
        || signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, public_key)
            .verify(message, signature_bytes)
            .is_ok()
}

fn wipe_workspace_import_request(input: &mut FinishWorkspaceImportRequest) {
    wipe_string(&mut input.archive_password);
    wipe_string(&mut input.access_password);
    if let Some(identifier) = input.identifier.as_mut() {
        wipe_string(identifier);
    }
}

fn verify_import_file(
    path: &Path,
    expected_bytes: u64,
    expected_hash: &[u8; 32],
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != expected_bytes
    {
        return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
    }
    let mut input =
        fs::File::open(path).map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        bytes = bytes
            .checked_add(read as u64)
            .ok_or("WORKSPACE_IMPORT_SIZE_INVALID")?;
    }
    wipe_bytes(&mut buffer);
    let actual_hash: [u8; 32] = digest.finalize().into();
    if bytes != expected_bytes || !bool::from(actual_hash.ct_eq(expected_hash)) {
        return Err("WORKSPACE_IMPORT_HASH_INVALID".to_string());
    }
    Ok(())
}

fn reset_pending_workspace_import(state: &Arc<AppState>, import_id: &str, source: &[u8; 32]) {
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    if let Some(pending) = inner
        .pending_workspace_imports
        .get_mut(import_id)
        .filter(|pending| bool::from(pending.source_hash.ct_eq(source)))
    {
        pending.finalizing = false;
    }
}

fn release_workspace_restore_reservation(state: &Arc<AppState>, workspace_hash: &[u8; 32]) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.restoring_workspaces.remove(workspace_hash);
    }
}

fn remove_workspace_restore_directory(
    active_root: &Path,
    staging_root: &Path,
    import_id: &str,
) -> Result<(), String> {
    if !valid_transfer_id(import_id) {
        return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
    }
    let expected = active_root.join(format!(".workspace-restore-{import_id}"));
    if staging_root != expected || staging_root.parent() != Some(active_root) {
        return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
    }
    if staging_root.exists() {
        let metadata = fs::symlink_metadata(staging_root)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
        }
        fs::remove_dir_all(staging_root)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    }
    Ok(())
}

fn activate_restored_workspace_payload(
    staging_root: &Path,
    final_root: &Path,
    import_id: &str,
    domain: &WorkspaceDomain,
) -> Result<(), String> {
    if !valid_transfer_id(import_id) || final_root.exists() {
        return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
    }
    let storage_root = final_root
        .parent()
        .ok_or("WORKSPACE_IMPORT_STORAGE_INVALID")?;
    let activation_root = storage_root.join(format!(".workspace-activate-{import_id}"));
    if activation_root.exists() || activation_root.parent() != Some(storage_root) {
        return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
    }
    fs::create_dir(&activation_root)
        .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    protect_private_directory(&activation_root)?;
    let result = (|| -> Result<(), String> {
        for name in ["payload", "payload-critical"] {
            let source = staging_root.join(name);
            if !source.exists() {
                continue;
            }
            let source_metadata = fs::symlink_metadata(&source)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
                return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
            }
            let destination = activation_root.join(name);
            fs::create_dir(&destination)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            protect_private_directory(&destination)?;
            copy_restored_tree(&source, &source, &destination)?;
        }
        let temporary_stored = StoredWorkspace {
            root: activation_root.clone(),
            active_root: PathBuf::new(),
            domain: clone_workspace_domain(domain)?,
            runtime: None,
            browser_locked: false,
            pending_profile_import: None,
            last_payload_checkpoint: Instant::now(),
            durability: None,
        };
        AppState::persist(&temporary_stored)?;
        fs::rename(&activation_root, final_root)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        Ok(())
    })();
    if result.is_err() && activation_root.exists() {
        let _ = fs::remove_dir_all(&activation_root);
    }
    result
}

fn clone_workspace_domain(domain: &WorkspaceDomain) -> Result<WorkspaceDomain, String> {
    let mut encoded =
        serde_json::to_vec(domain).map_err(|_| "WORKSPACE_ARCHIVE_DOMAIN_INVALID".to_string())?;
    let result = serde_json::from_slice(&encoded)
        .map_err(|_| "WORKSPACE_ARCHIVE_DOMAIN_INVALID".to_string());
    wipe_bytes(&mut encoded);
    result
}

fn copy_restored_tree(
    source_root: &Path,
    source: &Path,
    destination_root: &Path,
) -> Result<(), String> {
    for entry in
        fs::read_dir(source).map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?
    {
        let entry = entry.map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
        }
        let relative = path
            .strip_prefix(source_root)
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_INVALID")?;
        if relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        }) {
            return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
        }
        let destination = destination_root.join(relative);
        if metadata.is_dir() {
            fs::create_dir(&destination)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            protect_private_directory(&destination)?;
            copy_restored_tree(source_root, &path, destination_root)?;
        } else if metadata.is_file() {
            let mut input = fs::File::open(&path)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&destination)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            protect_private_file(&destination)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            std::io::copy(&mut input, &mut output)
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
            output
                .sync_all()
                .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        } else {
            return Err("WORKSPACE_IMPORT_STORAGE_INVALID".to_string());
        }
    }
    Ok(())
}

fn protect_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "WORKSPACE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn wipe_string(value: &mut String) {
    // The request owns this allocation exclusively until the wipe completes.
    unsafe { value.as_bytes_mut().fill(0) };
    value.clear();
}

fn wipe_bytes(value: &mut [u8]) {
    for byte in value {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

fn protect_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn remove_profile_import_file(
    active_root: &Path,
    pending: &PendingProfileImport,
) -> Result<(), String> {
    if pending.path.parent() != Some(active_root)
        || pending.path.file_name().and_then(|value| value.to_str())
            != Some(format!(".profile-import-{}.upload", pending.id).as_str())
    {
        return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
    }
    if pending.path.exists() {
        let metadata = fs::symlink_metadata(&pending.path)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
        }
        fs::remove_file(&pending.path)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    }
    Ok(())
}

fn remove_profile_restore_directory(
    active_root: &Path,
    staging_root: &Path,
    import_id: &str,
) -> Result<(), String> {
    if !valid_transfer_id(import_id) {
        return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
    }
    let expected = active_root.join(format!(".profile-restore-{import_id}"));
    if staging_root != expected || staging_root.parent() != Some(active_root) {
        return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
    }
    if staging_root.exists() {
        let metadata = fs::symlink_metadata(staging_root)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("PROFILE_IMPORT_STORAGE_INVALID".to_string());
        }
        fs::remove_dir_all(staging_root)
            .map_err(|_| "PROFILE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    }
    Ok(())
}

fn reset_pending_profile_import(state: &Arc<AppState>, workspace_hash: [u8; 32], import_id: &str) {
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    if let Some(pending) = inner
        .workspaces
        .get_mut(&workspace_hash)
        .and_then(|stored| stored.pending_profile_import.as_mut())
        .filter(|pending| pending.id == import_id)
    {
        pending.finalizing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_ui_state_is_checkpointed_before_success_is_returned() {
        assert!(command_requires_immediate_checkpoint("save_layout_state"));
        assert!(command_requires_immediate_checkpoint("save_local_state"));
        assert!(!command_requires_immediate_checkpoint("load_layout_state"));
        assert!(!command_requires_immediate_checkpoint("send_tox_message"));
    }

    #[test]
    fn durable_chat_mutations_trigger_workspace_checkpointing() {
        assert!(command_mutates_runtime("set_message_reactions"));
        assert!(command_mutates_runtime("acknowledge_local_messages"));
        assert!(!command_mutates_runtime("get_chat_capabilities"));
        assert!(!command_mutates_runtime("release_chat_history"));
        assert!(!command_mutates_runtime("get_background_transfer_work"));
    }

    #[test]
    fn nullable_avatar_arguments_distinguish_clear_from_invalid_input() {
        let clear = serde_json::json!({
            "profileId": "alpha",
            "dataUrl": null,
            "filename": null,
            "bytes": null,
        });
        assert_eq!(nullable_string_arg(&clear, "dataUrl").unwrap(), None);
        assert_eq!(nullable_string_arg(&clear, "filename").unwrap(), None);
        assert_eq!(optional_bytes_arg(&clear, "bytes").unwrap(), None);

        let set = serde_json::json!({
            "profileId": "alpha",
            "dataUrl": "data:image/png;base64,AA==",
            "filename": "avatar.png",
            "bytes": [1, 2, 3],
        });
        assert_eq!(
            nullable_string_arg(&set, "dataUrl").unwrap(),
            Some("data:image/png;base64,AA==")
        );
        assert_eq!(
            optional_bytes_arg(&set, "bytes").unwrap(),
            Some(vec![1, 2, 3])
        );
        assert_eq!(
            nullable_string_arg(&serde_json::json!({ "dataUrl": 7 }), "dataUrl")
                .err()
                .unwrap(),
            "COMMAND_ARGUMENT_INVALID"
        );
    }

    struct DestroyWorkspaceFixture {
        state: Arc<AppState>,
        workspace_hash: [u8; 32],
        device_token: String,
        csrf: String,
        workspace_root: PathBuf,
        active_root: PathBuf,
        test_root: PathBuf,
    }

    impl Drop for DestroyWorkspaceFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.test_root);
        }
    }

    fn request(headers: &[(&str, String)]) -> HttpRequest {
        HttpRequest {
            method: "POST".to_string(),
            path: "/api/v1/lease/heartbeat".to_string(),
            headers: headers
                .iter()
                .map(|(name, value)| ((*name).to_string(), value.clone()))
                .collect(),
            body: Vec::new(),
        }
    }

    fn destroy_workspace_fixture() -> DestroyWorkspaceFixture {
        let test_root = std::env::temp_dir().join(format!(
            "kaigen-web-destroy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let disk_root = test_root.join("disk");
        let ram_root = test_root.join("ram");
        let active_base = test_root.join("active");
        let resource_root = test_root.join("resources");
        for directory in [&disk_root, &ram_root, &active_base, &resource_root] {
            fs::create_dir_all(directory).unwrap();
        }
        let config = crate::config::Config {
            deployment_mode: crate::config::DeploymentMode::Service,
            bind: "127.0.0.1:0".parse().unwrap(),
            public_origin: "https://kaigen.test".to_string(),
            disk_root,
            ram_root,
            active_root: active_base,
            resource_root,
            disk_quota_bytes: 4096,
            ram_quota_bytes: 4096,
            security_reserve_bytes: 2048,
            lease_hours: 24,
            max_instances: 4,
            proof_difficulty: 12,
        };
        let mut dummy_vault =
            tauri_app_lib::web_core::WorkspaceVault::create([0xF0_u8; 32], "dummy password")
                .unwrap();
        dummy_vault.lock();
        let state = Arc::new(AppState {
            config,
            inner: std::sync::Mutex::new(InnerState {
                workspaces: HashMap::new(),
                pending_workspace_imports: HashMap::new(),
                restoring_workspaces: std::collections::HashSet::new(),
                proofs: crate::proof::ProofRegistry::default(),
                auth_backoff: tauri_app_lib::web_core::AuthBackoff::default(),
                admission: tauri_app_lib::web_core::ResourceAdmission::new(4).unwrap(),
                sessions: HashMap::new(),
                server_secret: [0xE0_u8; 32],
                dummy_vault,
                maintenance: false,
            }),
        });

        let workspace_hash = [0xA5_u8; 32];
        let workspace_root = state.workspace_root(StorageMode::Disk, &workspace_hash);
        let active_root = state.workspace_active_root(&workspace_hash);
        fs::create_dir_all(&workspace_root).unwrap();
        fs::create_dir_all(&active_root).unwrap();
        fs::write(workspace_root.join("encrypted-payload.test"), b"ciphertext").unwrap();
        fs::write(active_root.join("runtime.test"), b"runtime").unwrap();

        let now = now_seconds();
        let mut domain = WorkspaceDomain::provisional(
            workspace_hash,
            WorkspaceConfig {
                storage_mode: StorageMode::Disk,
                quota_bytes: 4096,
                security_reserve_bytes: 2048,
                lease_hours: 24,
            },
            now,
        )
        .unwrap();
        domain
            .initialize_workspace("workspace access", now)
            .unwrap();
        domain
            .add_profile(
                "only-profile".to_string(),
                "Only Profile".to_string(),
                false,
            )
            .unwrap();
        domain.profiles.activate("only-profile").unwrap();
        let mut public_key = vec![0_u8; 91];
        public_key[..26].copy_from_slice(&[
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
            0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
        ]);
        public_key[26] = 0x04;
        let enrollment = domain
            .devices
            .enroll_after_password(public_key, now)
            .unwrap();
        let device_token = enrollment.device_token;
        let device_hash = domain.devices.token_hash(&device_token).unwrap();
        assert_ne!(
            domain.ui_lease.acquire(device_hash, now, true),
            LeaseDecision::Occupied
        );
        let stored = StoredWorkspace {
            root: workspace_root.clone(),
            active_root: active_root.clone(),
            domain,
            runtime: None,
            browser_locked: false,
            pending_profile_import: None,
            last_payload_checkpoint: Instant::now(),
            durability: None,
        };
        AppState::persist(&stored).unwrap();
        let csrf = {
            let mut inner = state.inner.lock().unwrap();
            inner.workspaces.insert(workspace_hash, stored);
            AppState::issue_session(&mut inner, workspace_hash, device_hash).unwrap()
        };

        DestroyWorkspaceFixture {
            state,
            workspace_hash,
            device_token,
            csrf,
            workspace_root,
            active_root,
            test_root,
        }
    }

    fn destroy_request(
        fixture: &DestroyWorkspaceFixture,
        body: Value,
        include_csrf: bool,
    ) -> HttpRequest {
        let mut headers = HashMap::from([
            (
                "origin".to_string(),
                fixture.state.config.public_origin.clone(),
            ),
            (
                "cookie".to_string(),
                format!(
                    "{}={}",
                    workspace_cookie_name(&fixture.workspace_hash),
                    fixture.device_token
                ),
            ),
            (
                WORKSPACE_SELECTOR_HEADER.to_string(),
                workspace_selector(&fixture.workspace_hash),
            ),
        ]);
        if include_csrf {
            headers.insert("x-kaigen-csrf".to_string(), fixture.csrf.clone());
        }
        HttpRequest {
            method: "POST".to_string(),
            path: "/api/v1/workspaces/destroy".to_string(),
            headers,
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    fn lock_request(fixture: &DestroyWorkspaceFixture, include_csrf: bool) -> HttpRequest {
        let mut request = destroy_request(fixture, json!({}), include_csrf);
        request.path = "/api/v1/workspaces/lock".to_string();
        request
    }

    fn response_json(response: &HttpResponse) -> Value {
        match &response.body {
            ResponseBody::Bytes(body) => serde_json::from_slice(body).unwrap(),
            ResponseBody::File { .. } => panic!("expected JSON response"),
        }
    }

    #[test]
    fn targeted_profile_status_rolls_back_when_runtime_is_unavailable() {
        let fixture = destroy_workspace_fixture();
        let mut inner = fixture.state.inner.lock().unwrap();
        let stored = inner.workspaces.get_mut(&fixture.workspace_hash).unwrap();
        let before = stored
            .domain
            .profiles
            .effective_presence("only-profile", true)
            .unwrap();
        assert_eq!(
            set_stored_profile_status(stored, "only-profile", &json!({ "status": "busy" }),)
                .unwrap_err(),
            "RUNTIME_LOCKED"
        );
        assert_eq!(
            stored
                .domain
                .profiles
                .effective_presence("only-profile", true)
                .unwrap(),
            before
        );
    }

    #[test]
    fn destroy_workspace_requires_csrf_and_explicit_confirmation_then_removes_it() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let fixture = destroy_workspace_fixture();
                let remote = "127.0.0.1:12345".parse().unwrap();

                let missing_csrf = route(
                    destroy_request(&fixture, json!({ "explicitConfirmation": true }), false),
                    remote,
                    Arc::clone(&fixture.state),
                )
                .await;
                assert_eq!(missing_csrf.status, 401);
                assert_eq!(response_json(&missing_csrf)["code"], "CSRF_INVALID");

                for body in [json!({}), json!({ "explicitConfirmation": false })] {
                    let rejected = route(
                        destroy_request(&fixture, body, true),
                        remote,
                        Arc::clone(&fixture.state),
                    )
                    .await;
                    assert_eq!(rejected.status, 400);
                    assert_eq!(
                        response_json(&rejected)["code"],
                        "WORKSPACE_DESTROY_CONFIRMATION_REQUIRED"
                    );
                    assert!(fixture
                        .state
                        .inner
                        .lock()
                        .unwrap()
                        .workspaces
                        .contains_key(&fixture.workspace_hash));
                    assert!(fixture.workspace_root.is_dir());
                    assert!(fixture.active_root.is_dir());
                }

                let destroyed = route(
                    destroy_request(&fixture, json!({ "explicitConfirmation": true }), true),
                    remote,
                    Arc::clone(&fixture.state),
                )
                .await;
                assert_eq!(destroyed.status, 200);
                assert_eq!(response_json(&destroyed), json!({ "destroyed": true }));
                let inner = fixture.state.inner.lock().unwrap();
                assert!(!inner.workspaces.contains_key(&fixture.workspace_hash));
                assert!(inner
                    .sessions
                    .values()
                    .all(|session| session.workspace_hash != fixture.workspace_hash));
                drop(inner);
                assert!(!fixture.workspace_root.exists());
                assert!(!fixture.active_root.exists());
            });
    }

    #[test]
    fn browser_lock_revokes_browser_auth_but_preserves_workspace_and_background_presence() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let fixture = destroy_workspace_fixture();
                let remote = "127.0.0.1:12345".parse().unwrap();

                let missing_csrf = route(
                    lock_request(&fixture, false),
                    remote,
                    Arc::clone(&fixture.state),
                )
                .await;
                assert_eq!(missing_csrf.status, 401);
                assert_eq!(response_json(&missing_csrf)["code"], "CSRF_INVALID");
                assert!(
                    !fixture
                        .state
                        .inner
                        .lock()
                        .unwrap()
                        .workspaces
                        .get(&fixture.workspace_hash)
                        .unwrap()
                        .browser_locked
                );

                let locked = route(
                    lock_request(&fixture, true),
                    remote,
                    Arc::clone(&fixture.state),
                )
                .await;
                assert_eq!(locked.status, 200);
                assert_eq!(response_json(&locked), json!({ "locked": true }));
                assert!(locked.headers.iter().any(|(name, value)| {
                    name == "Set-Cookie"
                        && value.starts_with(&workspace_cookie_name(&fixture.workspace_hash))
                        && value.contains("Max-Age=0")
                }));

                {
                    let inner = fixture.state.inner.lock().unwrap();
                    let stored = inner.workspaces.get(&fixture.workspace_hash).unwrap();
                    assert!(stored.browser_locked);
                    assert!(stored.runtime_should_remain_online(
                        now_seconds()
                            .saturating_add(tauri_app_lib::web_core::UI_LEASE_STALE_SECONDS + 1)
                    ));
                    assert_eq!(stored.domain.profiles.stored_count(), 1);
                    assert_eq!(stored.domain.profiles.active_count(), 1);
                    assert!(inner
                        .sessions
                        .values()
                        .all(|session| session.workspace_hash != fixture.workspace_hash));
                }
                assert!(fixture.workspace_root.is_dir());
                assert!(fixture.active_root.join("runtime.test").is_file());

                let stale_browser_session = route(
                    lock_request(&fixture, true),
                    remote,
                    Arc::clone(&fixture.state),
                )
                .await;
                assert_eq!(stale_browser_session.status, 401);
            });
    }

    #[test]
    fn profile_state_routes_have_bounded_legacy_avatar_headroom() {
        assert_eq!(
            request_body_limit("/api/v1/commands/save_local_state"),
            MAX_LOCAL_STATE_JSON_BYTES
        );
        assert_eq!(
            request_body_limit("/api/v1/commands/set_profile_avatar"),
            MAX_AVATAR_COMMAND_JSON_BYTES
        );
        assert_eq!(
            request_body_limit("/api/v1/commands/save_layout_state"),
            MAX_JSON_BYTES
        );
        assert!(MAX_LOCAL_STATE_JSON_BYTES > 1_349_270);
    }

    #[test]
    fn workspace_lookup_requires_a_loaded_workspace_not_only_a_valid_identifier() {
        let identifier = WorkspaceIdentifier::generate().unwrap();
        let value = identifier.expose_once().to_string();
        let mut workspaces = HashMap::<[u8; 32], ()>::new();

        assert!(!workspace_exists(&workspaces, &value));
        workspaces.insert(identifier.hash(), ());
        assert!(workspace_exists(&workspaces, &value));
        assert!(!workspace_exists(&workspaces, "not-a-workspace-identifier"));
    }

    #[test]
    fn workspace_selector_chooses_its_cookie_from_a_shared_browser_jar() {
        let first_hash = [1_u8; 32];
        let second_hash = [2_u8; 32];
        let first_selector = workspace_selector(&first_hash);
        let second_selector = workspace_selector(&second_hash);
        let first_token = "A".repeat(43);
        let second_token = "B".repeat(43);
        let cookies = format!(
            "{DEVICE_COOKIE_PREFIX}{first_selector}={first_token}; {DEVICE_COOKIE_PREFIX}{second_selector}={second_token}; {LEGACY_DEVICE_COOKIE_NAME}={second_token}"
        );

        let first = request(&[
            ("cookie", cookies.clone()),
            (WORKSPACE_SELECTOR_HEADER, first_selector),
        ]);
        let second = request(&[
            ("cookie", cookies),
            (WORKSPACE_SELECTOR_HEADER, second_selector),
        ]);

        assert_eq!(device_cookie(&first).as_deref(), Some(first_token.as_str()));
        assert_eq!(
            device_cookie(&second).as_deref(),
            Some(second_token.as_str())
        );
        assert!(ensure_workspace_selector(&first, &first_hash).is_ok());
        assert!(ensure_workspace_selector(&first, &second_hash).is_err());
    }

    #[test]
    fn websocket_protocol_selects_the_matching_workspace_cookie() {
        let workspace_hash = [3_u8; 32];
        let selector = workspace_selector(&workspace_hash);
        let token = "C".repeat(43);
        let cookie = format!("{DEVICE_COOKIE_PREFIX}{selector}={token}");
        let protocols = format!("kaigen.v1, {WORKSPACE_PROTOCOL_PREFIX}{selector}");
        let request = request(&[("cookie", cookie), ("sec-websocket-protocol", protocols)]);

        assert_eq!(device_cookie(&request).as_deref(), Some(token.as_str()));
        assert!(ensure_workspace_selector(&request, &workspace_hash).is_ok());
    }

    #[test]
    fn invalid_workspace_selector_does_not_fall_back_to_legacy_cookie() {
        let token = "D".repeat(43);
        let request = request(&[
            ("cookie", format!("{LEGACY_DEVICE_COOKIE_NAME}={token}")),
            (WORKSPACE_SELECTOR_HEADER, "invalid".to_string()),
        ]);

        assert_eq!(device_cookie(&request), None);
    }

    #[test]
    fn legacy_tab_can_match_its_device_among_workspace_cookies() {
        let first_selector = workspace_selector(&[4_u8; 32]);
        let second_selector = workspace_selector(&[5_u8; 32]);
        let first_token = "E".repeat(43);
        let second_token = "F".repeat(43);
        let request = request(&[(
            "cookie",
            format!(
                "{LEGACY_DEVICE_COOKIE_NAME}={second_token}; {DEVICE_COOKIE_PREFIX}{first_selector}={first_token}; {DEVICE_COOKIE_PREFIX}{second_selector}={second_token}"
            ),
        )]);

        assert_eq!(
            device_cookie_matching(&request, &first_token).as_deref(),
            Some(first_token.as_str())
        );
        assert_eq!(device_cookie_candidates(&request).len(), 2);
    }
}
