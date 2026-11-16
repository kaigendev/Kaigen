//! Explicit user downloads are separate from the encrypted temporary cache.
//! Only opaque grants can write bounded chunks into this app's downloads folder.

use super::*;
use crate::webgate_download_receipts as receipts;
use base64::Engine;

struct DownloadReceipt {
    binding: receipts::Binding,
    message_id: String,
    transfer_id: String,
    sha256: String,
    expected_binding: String,
}

pub(crate) fn local_binding(
    state: &AppState,
    profile_id: &str,
    expected: Option<&str>,
) -> Result<receipts::Binding, String> {
    let metadata = state.remote_profiles.local_download_metadata(profile_id)?;
    let field = |value: &serde_json::Value, key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or("TRANSFER_WORKSPACE_BOUNDARY")
    };
    let root = metadata
        .get("trace")
        .and_then(serde_json::Value::as_array)
        .and_then(|trace| trace.first())
        .ok_or("TRANSFER_WORKSPACE_BOUNDARY")?;
    let stamp = serde_json::to_string(&(
        profile_id,
        field(&metadata, "profileId")?,
        field(&metadata, "toxId")?,
        field(root, "serverId")?,
        field(root, "workspaceId")?,
        field(root, "profileId")?,
    ))
    .map_err(|_| "TRANSFER_WORKSPACE_BOUNDARY")?;
    if expected.is_some_and(|expected| expected != stamp) {
        return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
    }
    Ok(receipts::Binding {
        profile_id: profile_id.into(),
        account: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(
            serde_json::to_vec(&(
                profile_id,
                field(&metadata, "toxId")?,
                field(root, "serverId")?,
                field(root, "workspaceId")?,
                field(root, "profileId")?,
            ))
            .map_err(|_| "TRANSFER_WORKSPACE_BOUNDARY")?,
        )),
    })
}

#[derive(Default)]
pub(crate) struct Downloads(Mutex<HashMap<String, Download>>);

struct Download {
    profile_id: String,
    temporary: PathBuf,
    destination: PathBuf,
    file: Option<File>,
    size: u64,
    exact_size: bool,
    written: u64,
    expected_hash: Option<Vec<u8>>,
    digest: Sha256,
    last_chunk: Option<(u64, Vec<u8>)>,
    committed: bool,
    receipt: Option<DownloadReceipt>,
}

impl Drop for Download {
    fn drop(&mut self) {
        self.file.take();
        if !self.committed {
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

impl Downloads {
    pub(crate) fn cancel_profile(&self, profile_id: &str) {
        if let Ok(mut files) = self.0.lock() {
            files.retain(|_, file| file.profile_id != profile_id);
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut files) = self.0.lock() {
            files.clear();
        }
    }
}

#[tauri::command]
pub(crate) async fn begin_webgate_download(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    name: String,
    size_bytes: u64,
    sha256: String,
    message_id: String,
    transfer_id: String,
    expected_binding: String,
) -> Result<String, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        if !state.remote_profiles.contains(&profile_id) {
            return Err("WEBGATE_PROFILE_NOT_FOUND".into());
        }
        let binding = local_binding(&state, &profile_id, Some(&expected_binding))?;
        receipts::identifier(&message_id)?;
        receipts::identifier(&transfer_id)?;
        let payload_sha256 = sha256.clone();
        if size_bytes == 0 || size_bytes > MAX_CHAT_FILE_BYTES {
            return Err("TRANSFER_SIZE_INVALID".into());
        }
        let expected_hash = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(sha256)
            .map_err(|_| "TRANSFER_HASH_INVALID")?;
        if expected_hash.len() != 32 {
            return Err("TRANSFER_HASH_INVALID".into());
        }
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| "WEBGATE_RANDOM_FAILED")?;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        let directory = receipts::directory(&state.root_dir, "downloads", true)?;
        let destination = unique_download_path(&directory, &safe_file_name(&name));
        let temporary = directory.join(format!(".webgate-{token}.writing"));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        let download = Download {
            profile_id,
            temporary,
            destination,
            file: Some(file),
            size: size_bytes,
            exact_size: true,
            written: 0,
            expected_hash: Some(expected_hash),
            digest: Sha256::new(),
            last_chunk: None,
            committed: false,
            receipt: Some(DownloadReceipt {
                binding,
                message_id,
                transfer_id,
                sha256: payload_sha256,
                expected_binding,
            }),
        };
        let mut files = state
            .webgate_downloads
            .0
            .lock()
            .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        if files.len() >= 8 {
            return Err("WEBGATE_DOWNLOAD_BUSY".into());
        }
        files.insert(token.clone(), download);
        Ok(token)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

/// Explicit chat-history export streams into a normal user file. It is not a
/// transferred chat attachment and does not use the attachment's 25 MiB limit.
#[tauri::command]
pub(crate) async fn begin_webgate_history_export(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    name: String,
) -> Result<String, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        if !state.remote_profiles.contains(&profile_id) {
            return Err("WEBGATE_PROFILE_NOT_FOUND".into());
        }
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| "WEBGATE_RANDOM_FAILED")?;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        let directory = receipts::directory(&state.root_dir, "downloads", true)?;
        let mut name = safe_file_name(&name);
        if !name.to_ascii_lowercase().ends_with(".txt") {
            name.push_str(".txt");
        }
        let destination = unique_download_path(&directory, &name);
        let temporary = directory.join(format!(".webgate-{token}.writing"));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        let download = Download {
            profile_id,
            temporary,
            destination,
            file: Some(file),
            size: 2 * 1024 * 1024 * 1024,
            exact_size: false,
            written: 0,
            expected_hash: None,
            digest: Sha256::new(),
            last_chunk: None,
            committed: false,
            receipt: None,
        };
        let mut files = state
            .webgate_downloads
            .0
            .lock()
            .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        if files.len() >= 8 {
            return Err("WEBGATE_DOWNLOAD_BUSY".into());
        }
        files.insert(token.clone(), download);
        Ok(token)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn write_webgate_download(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    token: String,
    position: u64,
    data: String,
) -> Result<u64, String> {
    let admission = state.desktop_work.admit()?;
    let files = state.webgate_downloads.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        if data.len() > 350_000 {
            return Err("TRANSFER_CHUNK_RANGE_INVALID".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| "TRANSFER_CHUNK_RANGE_INVALID")?;
        if bytes.is_empty() || bytes.len() > 256 * 1024 {
            return Err("TRANSFER_CHUNK_RANGE_INVALID".into());
        }
        let chunk_hash = Sha256::digest(&bytes).to_vec();
        let mut files = files.0.lock().map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        let file = files
            .get_mut(&token)
            .ok_or("WEBGATE_DOWNLOAD_GRANT_INVALID")?;
        if file.profile_id != profile_id {
            return Err("WEBGATE_DOWNLOAD_GRANT_INVALID".into());
        }
        if file
            .last_chunk
            .as_ref()
            .is_some_and(|(previous, hash)| *previous == position && hash == &chunk_hash)
        {
            return Ok(file.written);
        }
        if position != file.written || bytes.len() as u64 > file.size.saturating_sub(file.written) {
            return Err("TRANSFER_CHUNK_RANGE_INVALID".into());
        }
        file.file
            .as_mut()
            .ok_or("WEBGATE_DOWNLOAD_FAILED")?
            .write_all(&bytes)
            .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        Digest::update(&mut file.digest, &bytes);
        file.written += bytes.len() as u64;
        file.last_chunk = Some((position, chunk_hash));
        Ok(file.written)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn finish_webgate_download(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    token: String,
) -> Result<String, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        let mut files = state
            .webgate_downloads
            .0
            .lock()
            .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        if !files
            .get(&token)
            .is_some_and(|file| file.profile_id == profile_id)
        {
            return Err("WEBGATE_DOWNLOAD_GRANT_INVALID".into());
        }
        let mut file = files
            .remove(&token)
            .ok_or("WEBGATE_DOWNLOAD_GRANT_INVALID")?;
        drop(files); // Never acquire Host locks while holding the downloads map.
        if let Some(receipt) = &file.receipt {
            if local_binding(&state, &profile_id, Some(&receipt.expected_binding))?
                != receipt.binding
            {
                return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
            }
        }
        receipts::checked_directory(file.temporary.parent().ok_or("WEBGATE_DOWNLOAD_FAILED")?)?;
        if (file.exact_size && file.written != file.size)
            || file
                .expected_hash
                .as_ref()
                .is_some_and(|expected| file.digest.clone().finalize().as_slice() != expected)
        {
            return Err("TRANSFER_HASH_MISMATCH".into());
        }
        file.file
            .as_mut()
            .ok_or("WEBGATE_DOWNLOAD_FAILED")?
            .sync_all()
            .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
        file.file.take();
        // Publishing must never replace another download that appeared while
        // these chunks were arriving. A hard link is atomic where supported;
        // create_new provides the same no-overwrite boundary on other volumes.
        let mut destination = file.destination.clone();
        loop {
            match fs::hard_link(&file.temporary, &destination) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let directory = destination.parent().ok_or("WEBGATE_DOWNLOAD_FAILED")?;
                    let filename = file
                        .destination
                        .file_name()
                        .and_then(|name| name.to_str())
                        .ok_or("WEBGATE_DOWNLOAD_FAILED")?;
                    destination = unique_download_path(directory, filename);
                }
                Err(_) => {
                    let mut output = match OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&destination)
                    {
                        Ok(file) => file,
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            let directory =
                                destination.parent().ok_or("WEBGATE_DOWNLOAD_FAILED")?;
                            let filename = file
                                .destination
                                .file_name()
                                .and_then(|name| name.to_str())
                                .ok_or("WEBGATE_DOWNLOAD_FAILED")?;
                            destination = unique_download_path(directory, filename);
                            continue;
                        }
                        Err(_) => return Err("WEBGATE_DOWNLOAD_FAILED".into()),
                    };
                    let copied = File::open(&file.temporary)
                        .and_then(|mut input| std::io::copy(&mut input, &mut output))
                        .and_then(|_| output.sync_all());
                    drop(output);
                    if copied.is_err() {
                        let _ = fs::remove_file(&destination);
                        return Err("WEBGATE_DOWNLOAD_FAILED".into());
                    }
                    break;
                }
            }
        }
        let _ = fs::remove_file(&file.temporary);
        file.committed = true;
        if let Some(receipt) = &file.receipt {
            if local_binding(&state, &profile_id, Some(&receipt.expected_binding))?
                != receipt.binding
            {
                return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
            }
            receipts::save(
                &state.root_dir,
                receipt.binding.clone(),
                receipt.message_id.clone(),
                receipt.transfer_id.clone(),
                file.size,
                receipt.sha256.clone(),
                &destination,
            )?;
            if local_binding(&state, &profile_id, Some(&receipt.expected_binding))?
                != receipt.binding
            {
                return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
            }
        }
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) fn cancel_webgate_download(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    token: String,
) -> Result<(), String> {
    let mut files = state
        .webgate_downloads
        .0
        .lock()
        .map_err(|_| "WEBGATE_DOWNLOAD_FAILED")?;
    if files
        .get(&token)
        .is_some_and(|file| file.profile_id == profile_id)
    {
        files.remove(&token);
    }
    Ok(())
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalDownloadQuery {
    message_id: String,
    transfer_id: String,
}

pub(crate) fn resolve_saved(
    state: &AppState,
    profile_id: &str,
    message_id: &str,
    transfer_id: &str,
    expected: Option<(u64, &str)>,
    expected_binding: Option<&str>,
    force: bool,
) -> Result<Option<PathBuf>, String> {
    let binding = local_binding(state, profile_id, expected_binding)?;
    let result = receipts::resolve(
        &state.root_dir,
        &binding,
        message_id,
        transfer_id,
        expected,
        force,
    )?;
    if local_binding(state, profile_id, expected_binding)? != binding {
        return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn webgate_local_downloads(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    requests: Vec<LocalDownloadQuery>,
) -> Result<Vec<LocalDownloadQuery>, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        if requests.len() > 512 {
            return Err("WEBGATE_DOWNLOAD_QUERY_LIMIT".into());
        }
        let binding = local_binding(&state, &profile_id, None)?;
        let mut found = Vec::new();
        for query in requests {
            if receipts::resolve(
                &state.root_dir,
                &binding,
                &query.message_id,
                &query.transfer_id,
                None,
                false,
            )?
            .is_some()
            {
                found.push(query);
            }
        }
        if local_binding(&state, &profile_id, None)? != binding {
            return Err("TRANSFER_WORKSPACE_BOUNDARY".into());
        }
        Ok(found)
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}

#[tauri::command]
pub(crate) async fn webgate_resolve_download(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    message_id: String,
    transfer_id: String,
    size_bytes: u64,
    sha256: String,
    expected_binding: String,
) -> Result<Option<String>, String> {
    let admission = state.desktop_work.admit()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        resolve_saved(
            &state,
            &profile_id,
            &message_id,
            &transfer_id,
            Some((size_bytes, &sha256)),
            Some(&expected_binding),
            true,
        )
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "WEBGATE_TASK_FAILED".to_string())?
}
