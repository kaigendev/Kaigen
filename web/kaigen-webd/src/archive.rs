use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::File;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri_app_lib::web_core::derive_export_key;

const ARCHIVE_MAGIC: &[u8] = b"KAIGEN-WORKSPACE\n";
const PROFILE_ARCHIVE_MAGIC: &[u8] = b"KAIGEN-PROFILE\n";
const ARCHIVE_VERSION: u32 = 1;
const ARCHIVE_AAD: &[u8] = b"kaigen-workspace-archive-frame-v1";
const PROFILE_ARCHIVE_AAD: &[u8] = b"kaigen-profile-archive-frame-v1";
const FRAME_DATA_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = FRAME_DATA_BYTES + 64 * 1024;
const MAX_PROFILE_SAVEDATA_BYTES: u64 = 25 * 1024 * 1024;

const FRAME_MANIFEST: u8 = 1;
const FRAME_FILE_HEADER: u8 = 2;
const FRAME_FILE_DATA: u8 = 3;
const FRAME_FILE_END: u8 = 4;
const FRAME_ARCHIVE_END: u8 = 5;

#[derive(Debug)]
pub struct ArchiveArtifact {
    pub path: PathBuf,
    pub sha256: [u8; 32],
    pub bytes: u64,
    pub transaction_id: String,
}

pub struct RestoredProfilePackage {
    pub display_name: String,
    pub savedata: Vec<u8>,
    pub data_root: PathBuf,
}

pub struct RestoredWorkspaceArchive {
    pub identifier: Option<String>,
    pub domain_json: Vec<u8>,
    pub payload_root: PathBuf,
    pub profile_count: usize,
}

impl Drop for RestoredWorkspaceArchive {
    fn drop(&mut self) {
        wipe(&mut self.domain_json);
        if let Some(identifier) = self.identifier.as_mut() {
            wipe_string(identifier);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportManifest {
    format_version: u32,
    workspace_export: bool,
    profile_export: bool,
    profile_count: usize,
    created_at: u64,
    file_count: usize,
    encryption: &'static str,
    kdf: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileHeader<'a> {
    path: &'a str,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEnd {
    bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveEnd {
    file_count: usize,
    plaintext_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoredManifest {
    format_version: u32,
    workspace_export: bool,
    profile_export: bool,
    profile_count: usize,
    file_count: usize,
}

#[derive(Deserialize)]
struct RestoredFileHeader {
    path: String,
    bytes: u64,
}

#[derive(Deserialize)]
struct RestoredFileEnd {
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoredArchiveEnd {
    file_count: usize,
    plaintext_bytes: u64,
}

struct SourceFile {
    source: PathBuf,
    archive_path: String,
    bytes: u64,
    expected_sha256: Option<[u8; 32]>,
}

pub fn build_workspace_archive(
    workspace_root: &Path,
    transaction_id: &str,
    domain_json: &[u8],
    profile_count: usize,
    created_at: u64,
    workspace_identifier: Option<&str>,
    mut password: String,
) -> Result<ArchiveArtifact, String> {
    validate_transaction_id(transaction_id)?;
    if password.is_empty() {
        return Err("ARCHIVE_PASSWORD_REQUIRED".to_string());
    }
    let files = collect_payload_files(workspace_root)?;
    let final_path = archive_path(workspace_root, transaction_id)?;
    let temporary_path = temporary_archive_path(workspace_root, transaction_id)?;
    remove_exact_file(&temporary_path)?;
    remove_exact_file(&final_path)?;

    let result = (|| -> Result<ArchiveArtifact, String> {
        let salt = random_array::<32>()?;
        let nonce_prefix = random_array::<4>()?;
        let mut key = derive_export_key(&password, &salt)?;
        wipe_string(&mut password);
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| format!("Could not create workspace archive: {error}"))?;
        protect_file(&temporary_path)?;
        let archive_writer =
            ArchiveWriter::new(file, &key, salt, nonce_prefix, ARCHIVE_MAGIC, ARCHIVE_AAD);
        wipe(&mut key);
        let mut archive = archive_writer?;

        let identifier_file_count = usize::from(workspace_identifier.is_some());
        let manifest = ExportManifest {
            format_version: ARCHIVE_VERSION,
            workspace_export: true,
            profile_export: false,
            profile_count,
            created_at,
            file_count: files.len() + 1 + identifier_file_count,
            encryption: "AES-256-GCM framed",
            kdf: "Kaigen memory-hard profile KDF with archive domain separation",
        };
        archive.write_json_frame(FRAME_MANIFEST, &manifest)?;

        let mut total_plaintext = 0_u64;
        archive.write_memory_file("domain.json", domain_json)?;
        total_plaintext = total_plaintext.saturating_add(domain_json.len() as u64);
        if let Some(identifier) = workspace_identifier {
            if !(40..=80).contains(&identifier.len())
                || !identifier
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err("ARCHIVE_IDENTIFIER_INVALID".to_string());
            }
            archive.write_memory_file("workspace-identifier.txt", identifier.as_bytes())?;
            total_plaintext = total_plaintext.saturating_add(identifier.len() as u64);
        }
        for source in &files {
            archive.write_source_file(source)?;
            total_plaintext = total_plaintext.saturating_add(source.bytes);
        }
        archive.write_json_frame(
            FRAME_ARCHIVE_END,
            &ArchiveEnd {
                file_count: files.len() + 1 + identifier_file_count,
                plaintext_bytes: total_plaintext,
            },
        )?;
        let (output, sha256, bytes) = archive.finish()?;
        output
            .sync_all()
            .map_err(|error| format!("Could not sync workspace archive: {error}"))?;
        drop(output);
        fs::rename(&temporary_path, &final_path)
            .map_err(|error| format!("Could not activate workspace archive: {error}"))?;
        sync_parent(workspace_root)?;
        Ok(ArchiveArtifact {
            path: final_path.clone(),
            sha256,
            bytes,
            transaction_id: transaction_id.to_string(),
        })
    })();
    wipe_string(&mut password);
    if result.is_err() {
        let _ = remove_exact_file(&temporary_path);
        let _ = remove_exact_file(&final_path);
    }
    result
}

#[allow(clippy::too_many_arguments)]
pub fn build_profile_archive(
    workspace_root: &Path,
    artifact_id: &str,
    mut profile_files: Vec<(String, Vec<u8>)>,
    metadata_json: &[u8],
    settings_json: &[u8],
    mut savedata: Vec<u8>,
    created_at: u64,
    mut password: String,
) -> Result<ArchiveArtifact, String> {
    validate_transaction_id(artifact_id)?;
    if password.is_empty() {
        wipe(&mut savedata);
        for (_, bytes) in &mut profile_files {
            wipe(bytes);
        }
        wipe_string(&mut password);
        return Err("ARCHIVE_PASSWORD_REQUIRED".to_string());
    }
    if savedata.is_empty() {
        wipe(&mut savedata);
        for (_, bytes) in &mut profile_files {
            wipe(bytes);
        }
        wipe_string(&mut password);
        return Err("PROFILE_EXPORT_EMPTY".to_string());
    }
    for (relative, _) in &profile_files {
        if relative.is_empty()
            || relative.starts_with('/')
            || relative.contains('\\')
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || relative == "profile.tox"
            || relative == "data/logs"
            || relative.starts_with("data/logs/")
        {
            wipe(&mut savedata);
            for (_, bytes) in &mut profile_files {
                wipe(bytes);
            }
            wipe_string(&mut password);
            return Err("PROFILE_EXPORT_PATH_INVALID".to_string());
        }
    }
    let final_path = profile_archive_path(workspace_root, artifact_id)?;
    let temporary_path = temporary_profile_archive_path(workspace_root, artifact_id)?;
    remove_exact_file(&temporary_path)?;
    remove_exact_file(&final_path)?;

    let result = (|| -> Result<ArchiveArtifact, String> {
        let salt = random_array::<32>()?;
        let nonce_prefix = random_array::<4>()?;
        let mut key = derive_export_key(&password, &salt)?;
        wipe_string(&mut password);
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| format!("Could not create profile archive: {error}"))?;
        protect_file(&temporary_path)?;
        let archive_writer = ArchiveWriter::new(
            file,
            &key,
            salt,
            nonce_prefix,
            PROFILE_ARCHIVE_MAGIC,
            PROFILE_ARCHIVE_AAD,
        );
        wipe(&mut key);
        let mut archive = archive_writer?;

        let file_count = profile_files.len() + 3;
        archive.write_json_frame(
            FRAME_MANIFEST,
            &ExportManifest {
                format_version: ARCHIVE_VERSION,
                workspace_export: false,
                profile_export: true,
                profile_count: 1,
                created_at,
                file_count,
                encryption: "AES-256-GCM framed",
                kdf: "Kaigen memory-hard profile KDF with archive domain separation",
            },
        )?;

        let mut total_plaintext = 0_u64;
        archive.write_memory_file("profile-metadata.json", metadata_json)?;
        total_plaintext = total_plaintext.saturating_add(metadata_json.len() as u64);
        archive.write_memory_file("profile/tox.savedata", &savedata)?;
        total_plaintext = total_plaintext.saturating_add(savedata.len() as u64);
        wipe(&mut savedata);
        archive.write_memory_file("profile/settings.json", settings_json)?;
        total_plaintext = total_plaintext.saturating_add(settings_json.len() as u64);
        for (relative, bytes) in &mut profile_files {
            archive.write_memory_file(&format!("profile/{relative}"), bytes)?;
            total_plaintext = total_plaintext.saturating_add(bytes.len() as u64);
            wipe(bytes);
        }
        archive.write_json_frame(
            FRAME_ARCHIVE_END,
            &ArchiveEnd {
                file_count,
                plaintext_bytes: total_plaintext,
            },
        )?;
        let (output, sha256, bytes) = archive.finish()?;
        output
            .sync_all()
            .map_err(|error| format!("Could not sync profile archive: {error}"))?;
        drop(output);
        fs::rename(&temporary_path, &final_path)
            .map_err(|error| format!("Could not activate profile archive: {error}"))?;
        sync_parent(workspace_root)?;
        Ok(ArchiveArtifact {
            path: final_path.clone(),
            sha256,
            bytes,
            transaction_id: artifact_id.to_string(),
        })
    })();
    wipe(&mut savedata);
    for (_, bytes) in &mut profile_files {
        wipe(bytes);
    }
    wipe_string(&mut password);
    if result.is_err() {
        let _ = remove_exact_file(&temporary_path);
        let _ = remove_exact_file(&final_path);
    }
    result
}

struct SecretBytes(Vec<u8>);

impl SecretBytes {
    fn with_capacity(capacity: usize) -> Self {
        Self(Vec::with_capacity(capacity))
    }

    fn extend_from_slice(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    fn as_slice(&self) -> &[u8] {
        &self.0
    }

    fn into_vec(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

enum RestoredSink {
    Memory(SecretBytes),
    File(fs::File),
}

struct RestoredCurrentFile {
    path: String,
    expected_bytes: u64,
    written_bytes: u64,
    digest: Sha256,
    sink: RestoredSink,
}

struct ArchiveReader {
    input: fs::File,
    cipher: Aes256Gcm,
    salt: [u8; 32],
    nonce_prefix: [u8; 4],
    counter: u64,
    aad_domain: &'static [u8],
    invalid_code: &'static str,
    password_code: &'static str,
}

impl ArchiveReader {
    fn open_profile(path: &Path, password: &str) -> Result<Self, String> {
        Self::open(
            path,
            password,
            PROFILE_ARCHIVE_MAGIC,
            PROFILE_ARCHIVE_AAD,
            "PROFILE_PACKAGE_INVALID",
            "PROFILE_PACKAGE_PASSWORD_INVALID",
        )
    }

    fn open_workspace(path: &Path, password: &str) -> Result<Self, String> {
        Self::open(
            path,
            password,
            ARCHIVE_MAGIC,
            ARCHIVE_AAD,
            "WORKSPACE_ARCHIVE_INVALID",
            "WORKSPACE_ARCHIVE_PASSWORD_INVALID",
        )
    }

    fn open(
        path: &Path,
        password: &str,
        expected_magic: &'static [u8],
        aad_domain: &'static [u8],
        invalid_code: &'static str,
        password_code: &'static str,
    ) -> Result<Self, String> {
        let mut input =
            fs::File::open(path).map_err(|_| "ARCHIVE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
        let mut magic = vec![0_u8; expected_magic.len()];
        let mut version = [0_u8; 4];
        let mut salt = [0_u8; 32];
        let mut nonce_prefix = [0_u8; 4];
        input
            .read_exact(&mut magic)
            .and_then(|_| input.read_exact(&mut version))
            .and_then(|_| input.read_exact(&mut salt))
            .and_then(|_| input.read_exact(&mut nonce_prefix))
            .map_err(|_| invalid_code.to_string())?;
        if magic != expected_magic || u32::from_le_bytes(version) != ARCHIVE_VERSION {
            return Err(invalid_code.to_string());
        }
        let mut key = derive_export_key(password, &salt).map_err(|_| password_code.to_string())?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| invalid_code.to_string());
        wipe(&mut key);
        let cipher = cipher?;
        Ok(Self {
            input,
            cipher,
            salt,
            nonce_prefix,
            counter: 0,
            aad_domain,
            invalid_code,
            password_code,
        })
    }

    fn next_frame(&mut self) -> Result<Option<(u8, Vec<u8>)>, String> {
        let mut length = [0_u8; 4];
        match self.input.read(&mut length[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => {}
            Ok(_) => unreachable!(),
            Err(_) => return Err(self.invalid_code.to_string()),
        }
        self.input
            .read_exact(&mut length[1..])
            .map_err(|_| self.invalid_code.to_string())?;
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > MAX_FRAME_BYTES + 32 {
            return Err(self.invalid_code.to_string());
        }
        let mut ciphertext = vec![0_u8; length];
        self.input
            .read_exact(&mut ciphertext)
            .map_err(|_| self.invalid_code.to_string())?;
        let counter = self.counter;
        self.counter = self.counter.checked_add(1).ok_or(self.invalid_code)?;
        let mut nonce = [0_u8; 12];
        nonce[..4].copy_from_slice(&self.nonce_prefix);
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        let mut aad = Vec::with_capacity(self.aad_domain.len() + 44);
        aad.extend_from_slice(self.aad_domain);
        aad.extend_from_slice(&self.salt);
        aad.extend_from_slice(&self.nonce_prefix);
        aad.extend_from_slice(&counter.to_be_bytes());
        let mut plaintext = self
            .cipher
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| self.password_code.to_string())?;
        if plaintext.is_empty() {
            return Err(self.invalid_code.to_string());
        }
        let kind = plaintext[0];
        plaintext.remove(0);
        Ok(Some((kind, plaintext)))
    }
}

pub fn restore_profile_archive(
    input_path: &Path,
    staging_root: &Path,
    password: &str,
) -> Result<RestoredProfilePackage, String> {
    if password.is_empty() || staging_root.exists() {
        return Err("PROFILE_PACKAGE_ARGUMENT_INVALID".to_string());
    }
    fs::create_dir_all(staging_root.join("data"))
        .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
    protect_directory(staging_root)?;
    let result = (|| -> Result<RestoredProfilePackage, String> {
        let mut reader = ArchiveReader::open_profile(input_path, password)?;
        let mut manifest = None;
        let mut current: Option<RestoredCurrentFile> = None;
        let mut seen_paths = HashSet::new();
        let mut completed_files = 0_usize;
        let mut total_plaintext = 0_u64;
        let mut metadata_json = None;
        let mut settings_json = None;
        let mut savedata = None;
        let mut archive_complete = false;

        while let Some((kind, mut payload)) = reader.next_frame()? {
            let frame_result = (|| -> Result<(), String> {
                match kind {
                    FRAME_MANIFEST if manifest.is_none() && current.is_none() => {
                        let value: RestoredManifest = serde_json::from_slice(&payload)
                            .map_err(|_| "PROFILE_PACKAGE_INVALID".to_string())?;
                        if value.format_version != ARCHIVE_VERSION
                            || value.workspace_export
                            || !value.profile_export
                            || value.profile_count != 1
                            || value.file_count < 3
                            || value.file_count > 100_000
                        {
                            return Err("PROFILE_PACKAGE_INVALID".to_string());
                        }
                        manifest = Some(value);
                    }
                    FRAME_FILE_HEADER if manifest.is_some() && current.is_none() => {
                        let header: RestoredFileHeader = serde_json::from_slice(&payload)
                            .map_err(|_| "PROFILE_PACKAGE_INVALID".to_string())?;
                        if !seen_paths.insert(header.path.clone()) {
                            return Err("PROFILE_PACKAGE_INVALID".to_string());
                        }
                        let sink = match header.path.as_str() {
                            "profile-metadata.json" if header.bytes <= 64 * 1024 => {
                                RestoredSink::Memory(SecretBytes::with_capacity(
                                    header.bytes as usize,
                                ))
                            }
                            "profile/tox.savedata"
                                if header.bytes > 0
                                    && header.bytes <= MAX_PROFILE_SAVEDATA_BYTES =>
                            {
                                RestoredSink::Memory(SecretBytes::with_capacity(
                                    header.bytes as usize,
                                ))
                            }
                            "profile/settings.json" if header.bytes <= 1024 * 1024 => {
                                RestoredSink::Memory(SecretBytes::with_capacity(
                                    header.bytes as usize,
                                ))
                            }
                            path if path.starts_with("profile/data/") => {
                                let relative = &path["profile/data/".len()..];
                                let destination =
                                    safe_restore_join(&staging_root.join("data"), relative)?;
                                if let Some(parent) = destination.parent() {
                                    fs::create_dir_all(parent).map_err(|_| {
                                        "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string()
                                    })?;
                                }
                                let file = OpenOptions::new()
                                    .create_new(true)
                                    .write(true)
                                    .open(&destination)
                                    .map_err(|_| {
                                        "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string()
                                    })?;
                                protect_file(&destination)?;
                                RestoredSink::File(file)
                            }
                            _ => return Err("PROFILE_PACKAGE_PATH_INVALID".to_string()),
                        };
                        current = Some(RestoredCurrentFile {
                            path: header.path,
                            expected_bytes: header.bytes,
                            written_bytes: 0,
                            digest: Sha256::new(),
                            sink,
                        });
                    }
                    FRAME_FILE_DATA => {
                        let file = current.as_mut().ok_or("PROFILE_PACKAGE_INVALID")?;
                        let next = file
                            .written_bytes
                            .checked_add(payload.len() as u64)
                            .ok_or("PROFILE_PACKAGE_INVALID")?;
                        if next > file.expected_bytes {
                            return Err("PROFILE_PACKAGE_INVALID".to_string());
                        }
                        file.digest.update(&payload);
                        match &mut file.sink {
                            RestoredSink::Memory(bytes) => bytes.extend_from_slice(&payload),
                            RestoredSink::File(output) => output
                                .write_all(&payload)
                                .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?,
                        }
                        file.written_bytes = next;
                    }
                    FRAME_FILE_END => {
                        let end: RestoredFileEnd = serde_json::from_slice(&payload)
                            .map_err(|_| "PROFILE_PACKAGE_INVALID".to_string())?;
                        let file = current.take().ok_or("PROFILE_PACKAGE_INVALID")?;
                        let actual_hash: [u8; 32] = file.digest.finalize().into();
                        let expected_hash = URL_SAFE_NO_PAD
                            .decode(end.sha256)
                            .map_err(|_| "PROFILE_PACKAGE_INVALID".to_string())?;
                        if end.bytes != file.expected_bytes
                            || file.written_bytes != file.expected_bytes
                            || expected_hash.len() != 32
                            || !bool::from(actual_hash.ct_eq(expected_hash.as_slice()))
                        {
                            return Err("PROFILE_PACKAGE_INVALID".to_string());
                        }
                        total_plaintext = total_plaintext
                            .checked_add(file.written_bytes)
                            .ok_or("PROFILE_PACKAGE_INVALID")?;
                        match file.sink {
                            RestoredSink::Memory(bytes) => match file.path.as_str() {
                                "profile-metadata.json" => metadata_json = Some(bytes),
                                "profile/settings.json" => settings_json = Some(bytes),
                                "profile/tox.savedata" => savedata = Some(bytes),
                                _ => return Err("PROFILE_PACKAGE_INVALID".to_string()),
                            },
                            RestoredSink::File(output) => {
                                output.sync_all().map_err(|_| {
                                    "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string()
                                })?;
                            }
                        }
                        completed_files += 1;
                    }
                    FRAME_ARCHIVE_END if current.is_none() => {
                        let end: RestoredArchiveEnd = serde_json::from_slice(&payload)
                            .map_err(|_| "PROFILE_PACKAGE_INVALID".to_string())?;
                        let manifest = manifest.as_ref().ok_or("PROFILE_PACKAGE_INVALID")?;
                        if end.file_count != completed_files
                            || end.file_count != manifest.file_count
                            || end.plaintext_bytes != total_plaintext
                        {
                            return Err("PROFILE_PACKAGE_INVALID".to_string());
                        }
                        archive_complete = true;
                    }
                    _ => return Err("PROFILE_PACKAGE_INVALID".to_string()),
                }
                Ok(())
            })();
            wipe(&mut payload);
            frame_result?;
            if archive_complete {
                if reader.next_frame()?.is_some() {
                    return Err("PROFILE_PACKAGE_INVALID".to_string());
                }
                break;
            }
        }
        if !archive_complete || current.is_some() {
            return Err("PROFILE_PACKAGE_INVALID".to_string());
        }
        let metadata_json = metadata_json.ok_or("PROFILE_PACKAGE_INVALID")?;
        let settings_json = settings_json.ok_or("PROFILE_PACKAGE_INVALID")?;
        let metadata: serde_json::Value = serde_json::from_slice(metadata_json.as_slice())
            .map_err(|_| "PROFILE_PACKAGE_INVALID".to_string())?;
        serde_json::from_slice::<serde_json::Value>(settings_json.as_slice())
            .map_err(|_| "PROFILE_PACKAGE_INVALID".to_string())?;
        let display_name = metadata
            .get("displayName")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or("PROFILE_PACKAGE_INVALID")?
            .to_string();
        Ok(RestoredProfilePackage {
            display_name,
            savedata: savedata.ok_or("PROFILE_PACKAGE_INVALID")?.into_vec(),
            data_root: staging_root.join("data"),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging_root);
    }
    result
}

pub fn restore_workspace_archive(
    input_path: &Path,
    staging_root: &Path,
    password: &str,
    max_plaintext_bytes: u64,
) -> Result<RestoredWorkspaceArchive, String> {
    if password.is_empty()
        || max_plaintext_bytes == 0
        || staging_root.exists()
        || staging_root.parent().is_none()
        || staging_root.file_name().is_none()
    {
        return Err("WORKSPACE_ARCHIVE_ARGUMENT_INVALID".to_string());
    }
    fs::create_dir_all(staging_root)
        .map_err(|_| "ARCHIVE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    protect_directory(staging_root)?;
    let result = (|| -> Result<RestoredWorkspaceArchive, String> {
        let mut reader = ArchiveReader::open_workspace(input_path, password)?;
        let mut manifest = None;
        let mut current: Option<RestoredCurrentFile> = None;
        let mut seen_paths = HashSet::new();
        let mut completed_files = 0_usize;
        let mut total_plaintext = 0_u64;
        let mut domain_json = None;
        let mut identifier_bytes = None;
        let mut archive_complete = false;

        while let Some((kind, mut payload)) = reader.next_frame()? {
            let frame_result = (|| -> Result<(), String> {
                match kind {
                    FRAME_MANIFEST if manifest.is_none() && current.is_none() => {
                        let value: RestoredManifest = serde_json::from_slice(&payload)
                            .map_err(|_| "WORKSPACE_ARCHIVE_INVALID".to_string())?;
                        if value.format_version != ARCHIVE_VERSION
                            || !value.workspace_export
                            || value.profile_export
                            || value.profile_count == 0
                            || value.file_count == 0
                            || value.file_count > 1_000_000
                        {
                            return Err("WORKSPACE_ARCHIVE_INVALID".to_string());
                        }
                        manifest = Some(value);
                    }
                    FRAME_FILE_HEADER if manifest.is_some() && current.is_none() => {
                        let header: RestoredFileHeader = serde_json::from_slice(&payload)
                            .map_err(|_| "WORKSPACE_ARCHIVE_INVALID".to_string())?;
                        if header.bytes > max_plaintext_bytes
                            || !seen_paths.insert(header.path.clone())
                        {
                            return Err("WORKSPACE_ARCHIVE_INVALID".to_string());
                        }
                        let sink = match header.path.as_str() {
                            "domain.json"
                                if header.bytes > 0 && header.bytes <= 16 * 1024 * 1024 =>
                            {
                                RestoredSink::Memory(SecretBytes::with_capacity(
                                    header.bytes as usize,
                                ))
                            }
                            "workspace-identifier.txt"
                                if header.bytes > 0 && header.bytes <= 128 =>
                            {
                                RestoredSink::Memory(SecretBytes::with_capacity(
                                    header.bytes as usize,
                                ))
                            }
                            path if path.starts_with("payload/") => {
                                let relative = &path["payload/".len()..];
                                let destination =
                                    safe_restore_join(&staging_root.join("payload"), relative)?;
                                restored_file_sink(&destination)?
                            }
                            path if path.starts_with("payload-critical/") => {
                                let relative = &path["payload-critical/".len()..];
                                let destination = safe_restore_join(
                                    &staging_root.join("payload-critical"),
                                    relative,
                                )?;
                                restored_file_sink(&destination)?
                            }
                            _ => return Err("WORKSPACE_ARCHIVE_PATH_INVALID".to_string()),
                        };
                        current = Some(RestoredCurrentFile {
                            path: header.path,
                            expected_bytes: header.bytes,
                            written_bytes: 0,
                            digest: Sha256::new(),
                            sink,
                        });
                    }
                    FRAME_FILE_DATA => {
                        let file = current.as_mut().ok_or("WORKSPACE_ARCHIVE_INVALID")?;
                        let next = file
                            .written_bytes
                            .checked_add(payload.len() as u64)
                            .ok_or("WORKSPACE_ARCHIVE_INVALID")?;
                        if next > file.expected_bytes
                            || total_plaintext.saturating_add(next) > max_plaintext_bytes
                        {
                            return Err("WORKSPACE_ARCHIVE_SIZE_INVALID".to_string());
                        }
                        file.digest.update(&payload);
                        match &mut file.sink {
                            RestoredSink::Memory(bytes) => bytes.extend_from_slice(&payload),
                            RestoredSink::File(output) => output
                                .write_all(&payload)
                                .map_err(|_| "ARCHIVE_IMPORT_STORAGE_UNAVAILABLE".to_string())?,
                        }
                        file.written_bytes = next;
                    }
                    FRAME_FILE_END => {
                        let end: RestoredFileEnd = serde_json::from_slice(&payload)
                            .map_err(|_| "WORKSPACE_ARCHIVE_INVALID".to_string())?;
                        let file = current.take().ok_or("WORKSPACE_ARCHIVE_INVALID")?;
                        let actual_hash: [u8; 32] = file.digest.finalize().into();
                        let expected_hash = URL_SAFE_NO_PAD
                            .decode(end.sha256)
                            .map_err(|_| "WORKSPACE_ARCHIVE_INVALID".to_string())?;
                        if end.bytes != file.expected_bytes
                            || file.written_bytes != file.expected_bytes
                            || expected_hash.len() != 32
                            || !bool::from(actual_hash.ct_eq(expected_hash.as_slice()))
                        {
                            return Err("WORKSPACE_ARCHIVE_INVALID".to_string());
                        }
                        total_plaintext = total_plaintext
                            .checked_add(file.written_bytes)
                            .ok_or("WORKSPACE_ARCHIVE_INVALID")?;
                        if total_plaintext > max_plaintext_bytes {
                            return Err("WORKSPACE_ARCHIVE_SIZE_INVALID".to_string());
                        }
                        match file.sink {
                            RestoredSink::Memory(bytes) => match file.path.as_str() {
                                "domain.json" => domain_json = Some(bytes),
                                "workspace-identifier.txt" => identifier_bytes = Some(bytes),
                                _ => return Err("WORKSPACE_ARCHIVE_INVALID".to_string()),
                            },
                            RestoredSink::File(output) => output
                                .sync_all()
                                .map_err(|_| "ARCHIVE_IMPORT_STORAGE_UNAVAILABLE".to_string())?,
                        }
                        completed_files += 1;
                    }
                    FRAME_ARCHIVE_END if current.is_none() => {
                        let end: RestoredArchiveEnd = serde_json::from_slice(&payload)
                            .map_err(|_| "WORKSPACE_ARCHIVE_INVALID".to_string())?;
                        let manifest = manifest.as_ref().ok_or("WORKSPACE_ARCHIVE_INVALID")?;
                        if end.file_count != completed_files
                            || end.file_count != manifest.file_count
                            || end.plaintext_bytes != total_plaintext
                        {
                            return Err("WORKSPACE_ARCHIVE_INVALID".to_string());
                        }
                        archive_complete = true;
                    }
                    _ => return Err("WORKSPACE_ARCHIVE_INVALID".to_string()),
                }
                Ok(())
            })();
            wipe(&mut payload);
            frame_result?;
            if archive_complete {
                if reader.next_frame()?.is_some() {
                    return Err("WORKSPACE_ARCHIVE_INVALID".to_string());
                }
                break;
            }
        }
        if !archive_complete || current.is_some() {
            return Err("WORKSPACE_ARCHIVE_INVALID".to_string());
        }
        let domain_json = domain_json.ok_or("WORKSPACE_ARCHIVE_INVALID")?.into_vec();
        serde_json::from_slice::<serde_json::Value>(&domain_json)
            .map_err(|_| "WORKSPACE_ARCHIVE_INVALID".to_string())?;
        let identifier = identifier_bytes
            .map(|bytes| {
                let value = std::str::from_utf8(bytes.as_slice())
                    .map_err(|_| "WORKSPACE_ARCHIVE_IDENTIFIER_INVALID")?;
                if value.trim() != value {
                    return Err("WORKSPACE_ARCHIVE_IDENTIFIER_INVALID".to_string());
                }
                Ok(value.to_string())
            })
            .transpose()?;
        Ok(RestoredWorkspaceArchive {
            identifier,
            domain_json,
            payload_root: staging_root.to_path_buf(),
            profile_count: manifest
                .as_ref()
                .ok_or("WORKSPACE_ARCHIVE_INVALID")?
                .profile_count,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging_root);
    }
    result
}

fn restored_file_sink(destination: &Path) -> Result<RestoredSink, String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|_| "ARCHIVE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    }
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|_| "ARCHIVE_IMPORT_STORAGE_UNAVAILABLE".to_string())?;
    protect_file(destination)?;
    Ok(RestoredSink::File(file))
}

pub fn archive_path(workspace_root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    validate_transaction_id(transaction_id)?;
    Ok(workspace_root.join(format!(".workspace-export-{transaction_id}.kaigen")))
}

pub fn profile_archive_path(workspace_root: &Path, artifact_id: &str) -> Result<PathBuf, String> {
    validate_transaction_id(artifact_id)?;
    Ok(workspace_root.join(format!(".profile-export-{artifact_id}.kaigen-profile")))
}

pub fn remove_workspace_archive(workspace_root: &Path, transaction_id: &str) -> Result<(), String> {
    let final_path = archive_path(workspace_root, transaction_id)?;
    let temporary = temporary_archive_path(workspace_root, transaction_id)?;
    remove_exact_file(&temporary)?;
    remove_exact_file(&final_path)
}

fn temporary_archive_path(workspace_root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    validate_transaction_id(transaction_id)?;
    Ok(workspace_root.join(format!(".workspace-export-{transaction_id}.kaigen.new")))
}

fn temporary_profile_archive_path(
    workspace_root: &Path,
    artifact_id: &str,
) -> Result<PathBuf, String> {
    validate_transaction_id(artifact_id)?;
    Ok(workspace_root.join(format!(".profile-export-{artifact_id}.kaigen-profile.new")))
}

fn validate_transaction_id(value: &str) -> Result<(), String> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("CLOSE_TRANSACTION_INVALID".to_string());
    }
    Ok(())
}

fn collect_payload_files(workspace_root: &Path) -> Result<Vec<SourceFile>, String> {
    fn visit(
        payload_root: &Path,
        directory: &Path,
        archive_prefix: &str,
        output: &mut Vec<SourceFile>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("Could not inspect encrypted workspace payload: {error}"))?
        {
            let entry = entry.map_err(|error| {
                format!("Could not inspect encrypted workspace payload: {error}")
            })?;
            let source = entry.path();
            let metadata = fs::symlink_metadata(&source).map_err(|error| {
                format!("Could not inspect encrypted workspace payload: {error}")
            })?;
            if metadata.file_type().is_symlink() {
                return Err("ARCHIVE_PAYLOAD_SYMLINK_FORBIDDEN".to_string());
            }
            if metadata.is_dir() {
                visit(payload_root, &source, archive_prefix, output)?;
            } else if metadata.is_file() {
                let relative = source
                    .strip_prefix(payload_root)
                    .map_err(|_| "ARCHIVE_PAYLOAD_BOUNDARY_INVALID")?;
                let relative = relative
                    .components()
                    .map(|component| {
                        component
                            .as_os_str()
                            .to_str()
                            .ok_or("ARCHIVE_PAYLOAD_PATH_INVALID")
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join("/");
                if relative.is_empty()
                    || relative
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                {
                    return Err("ARCHIVE_PAYLOAD_PATH_INVALID".to_string());
                }
                output.push(SourceFile {
                    source,
                    archive_path: format!("{archive_prefix}/{relative}"),
                    bytes: metadata.len(),
                    expected_sha256: None,
                });
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    for archive_prefix in ["payload", "payload-critical"] {
        let payload_root = workspace_root.join(archive_prefix);
        if !payload_root.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&payload_root)
            .map_err(|error| format!("Could not inspect encrypted workspace payload: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("ARCHIVE_PAYLOAD_BOUNDARY_INVALID".to_string());
        }
        visit(&payload_root, &payload_root, archive_prefix, &mut output)?;
    }
    output.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    Ok(output)
}

fn collect_profile_files(
    profile_root: &Path,
    profile_path: &Path,
) -> Result<Vec<SourceFile>, String> {
    let metadata = fs::symlink_metadata(profile_root)
        .map_err(|error| format!("Could not inspect profile export payload: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("PROFILE_EXPORT_BOUNDARY_INVALID".to_string());
    }
    let mut writing_path = profile_path.as_os_str().to_os_string();
    writing_path.push(".writing");
    let writing_path = PathBuf::from(writing_path);

    fn visit(
        profile_root: &Path,
        directory: &Path,
        profile_path: &Path,
        writing_path: &Path,
        output: &mut Vec<SourceFile>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("Could not inspect profile export payload: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("Could not inspect profile export payload: {error}"))?;
            let source = entry.path();
            let metadata = fs::symlink_metadata(&source)
                .map_err(|error| format!("Could not inspect profile export payload: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("PROFILE_EXPORT_SYMLINK_FORBIDDEN".to_string());
            }
            if metadata.is_dir() {
                visit(profile_root, &source, profile_path, writing_path, output)?;
            } else if metadata.is_file() && source != profile_path && source != writing_path {
                let relative = source
                    .strip_prefix(profile_root)
                    .map_err(|_| "PROFILE_EXPORT_BOUNDARY_INVALID")?;
                let relative = relative
                    .components()
                    .map(|component| {
                        component
                            .as_os_str()
                            .to_str()
                            .ok_or("PROFILE_EXPORT_PATH_INVALID")
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join("/");
                if relative.is_empty()
                    || relative
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                {
                    return Err("PROFILE_EXPORT_PATH_INVALID".to_string());
                }
                if relative == "data/logs" || relative.starts_with("data/logs/") {
                    continue;
                }
                output.push(SourceFile {
                    expected_sha256: Some(hash_source_file(&source, metadata.len())?),
                    source,
                    archive_path: format!("profile/{relative}"),
                    bytes: metadata.len(),
                });
            }
        }
        Ok(())
    }

    let mut output = Vec::new();
    visit(
        profile_root,
        profile_root,
        profile_path,
        &writing_path,
        &mut output,
    )?;
    output.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    Ok(output)
}

fn hash_source_file(path: &Path, expected_bytes: u64) -> Result<[u8; 32], String> {
    let mut input = fs::File::open(path)
        .map_err(|error| format!("Could not read profile export payload: {error}"))?;
    let mut buffer = vec![0_u8; FRAME_DATA_BYTES];
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("Could not read profile export payload: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    wipe(&mut buffer);
    if bytes != expected_bytes {
        return Err("ARCHIVE_SOURCE_CHANGED".to_string());
    }
    Ok(digest.finalize().into())
}

struct ArchiveWriter {
    output: fs::File,
    digest: Sha256,
    bytes: u64,
    cipher: Aes256Gcm,
    salt: [u8; 32],
    nonce_prefix: [u8; 4],
    counter: u64,
    aad_prefix: &'static [u8],
}

impl ArchiveWriter {
    fn new(
        output: fs::File,
        key: &[u8; 32],
        salt: [u8; 32],
        nonce_prefix: [u8; 4],
        magic: &'static [u8],
        aad_prefix: &'static [u8],
    ) -> Result<Self, String> {
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| "Could not initialize archive encryption".to_string())?;
        let mut writer = Self {
            output,
            digest: Sha256::new(),
            bytes: 0,
            cipher,
            salt,
            nonce_prefix,
            counter: 0,
            aad_prefix,
        };
        writer.write_raw(magic)?;
        writer.write_raw(&ARCHIVE_VERSION.to_le_bytes())?;
        writer.write_raw(&salt)?;
        writer.write_raw(&nonce_prefix)?;
        Ok(writer)
    }

    fn write_json_frame(&mut self, kind: u8, value: &impl Serialize) -> Result<(), String> {
        let encoded =
            serde_json::to_vec(value).map_err(|_| "ARCHIVE_MANIFEST_INVALID".to_string())?;
        self.write_frame(kind, &encoded)
    }

    fn write_memory_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.write_json_frame(
            FRAME_FILE_HEADER,
            &FileHeader {
                path,
                bytes: bytes.len() as u64,
            },
        )?;
        let mut digest = Sha256::new();
        for chunk in bytes.chunks(FRAME_DATA_BYTES) {
            digest.update(chunk);
            self.write_frame(FRAME_FILE_DATA, chunk)?;
        }
        self.write_json_frame(
            FRAME_FILE_END,
            &FileEnd {
                bytes: bytes.len() as u64,
                sha256: URL_SAFE_NO_PAD.encode(digest.finalize()),
            },
        )
    }

    fn write_source_file(&mut self, source: &SourceFile) -> Result<(), String> {
        self.write_json_frame(
            FRAME_FILE_HEADER,
            &FileHeader {
                path: &source.archive_path,
                bytes: source.bytes,
            },
        )?;
        let mut input = fs::File::open(&source.source)
            .map_err(|error| format!("Could not read encrypted workspace payload: {error}"))?;
        let mut buffer = vec![0_u8; FRAME_DATA_BYTES];
        let result = (|| -> Result<(u64, [u8; 32]), String> {
            let mut digest = Sha256::new();
            let mut bytes = 0_u64;
            loop {
                let read = input.read(&mut buffer).map_err(|error| {
                    format!("Could not read encrypted workspace payload: {error}")
                })?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
                self.write_frame(FRAME_FILE_DATA, &buffer[..read])?;
                bytes = bytes.saturating_add(read as u64);
            }
            Ok((bytes, digest.finalize().into()))
        })();
        wipe(&mut buffer);
        let (bytes, sha256) = result?;
        if bytes != source.bytes {
            return Err("ARCHIVE_SOURCE_CHANGED".to_string());
        }
        if source
            .expected_sha256
            .is_some_and(|expected| expected != sha256)
        {
            return Err("ARCHIVE_SOURCE_CHANGED".to_string());
        }
        self.write_json_frame(
            FRAME_FILE_END,
            &FileEnd {
                bytes,
                sha256: URL_SAFE_NO_PAD.encode(sha256),
            },
        )
    }

    fn write_frame(&mut self, kind: u8, payload: &[u8]) -> Result<(), String> {
        if payload.len() > MAX_FRAME_BYTES {
            return Err("ARCHIVE_FRAME_TOO_LARGE".to_string());
        }
        let mut plaintext = Vec::with_capacity(payload.len() + 1);
        plaintext.push(kind);
        plaintext.extend_from_slice(payload);
        let counter = self.counter;
        self.counter = self.counter.checked_add(1).ok_or("ARCHIVE_TOO_LARGE")?;
        let mut nonce_bytes = [0_u8; 12];
        nonce_bytes[..4].copy_from_slice(&self.nonce_prefix);
        nonce_bytes[4..].copy_from_slice(&counter.to_be_bytes());
        let mut aad = Vec::with_capacity(self.aad_prefix.len() + 32 + 4 + 8);
        aad.extend_from_slice(self.aad_prefix);
        aad.extend_from_slice(&self.salt);
        aad.extend_from_slice(&self.nonce_prefix);
        aad.extend_from_slice(&counter.to_be_bytes());
        let ciphertext = self
            .cipher
            .encrypt(
                &Nonce::from(nonce_bytes),
                Payload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| "Could not encrypt workspace archive".to_string())?;
        wipe(&mut plaintext);
        let length = u32::try_from(ciphertext.len()).map_err(|_| "ARCHIVE_TOO_LARGE")?;
        self.write_raw(&length.to_le_bytes())?;
        self.write_raw(&ciphertext)
    }

    fn write_raw(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.output
            .write_all(bytes)
            .map_err(|error| format!("Could not write workspace archive: {error}"))?;
        self.digest.update(bytes);
        self.bytes = self
            .bytes
            .checked_add(bytes.len() as u64)
            .ok_or("ARCHIVE_TOO_LARGE")?;
        Ok(())
    }

    fn finish(self) -> Result<(fs::File, [u8; 32], u64), String> {
        Ok((self.output, self.digest.finalize().into(), self.bytes))
    }
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut value = [0_u8; N];
    SystemRandom::new()
        .fill(&mut value)
        .map_err(|_| "Secure random source failed".to_string())?;
    Ok(value)
}

fn wipe(value: &mut [u8]) {
    for byte in value {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

fn wipe_string(value: &mut String) {
    unsafe { wipe(value.as_bytes_mut()) };
    value.clear();
}

fn remove_exact_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Could not inspect workspace archive: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("ARCHIVE_PATH_INVALID".to_string());
        }
        fs::remove_file(path)
            .map_err(|error| format!("Could not remove workspace archive: {error}"))?;
    }
    Ok(())
}

fn safe_restore_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':', '\0'])
        })
    {
        return Err("PROFILE_PACKAGE_PATH_INVALID".to_string());
    }
    Ok(relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part)))
}

fn protect_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect workspace archive: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn protect_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "PROFILE_PACKAGE_STORAGE_UNAVAILABLE".to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync workspace archive directory: {error}"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decrypt_frames(
        path: &Path,
        password: &str,
        magic_bytes: &[u8],
        aad_prefix: &[u8],
    ) -> Result<Vec<Vec<u8>>, String> {
        let mut input = fs::File::open(path).map_err(|error| error.to_string())?;
        let mut magic = vec![0_u8; magic_bytes.len()];
        input
            .read_exact(&mut magic)
            .map_err(|error| error.to_string())?;
        if magic != magic_bytes {
            return Err("bad magic".to_string());
        }
        let mut version = [0_u8; 4];
        let mut salt = [0_u8; 32];
        let mut prefix = [0_u8; 4];
        input
            .read_exact(&mut version)
            .map_err(|error| error.to_string())?;
        input
            .read_exact(&mut salt)
            .map_err(|error| error.to_string())?;
        input
            .read_exact(&mut prefix)
            .map_err(|error| error.to_string())?;
        if u32::from_le_bytes(version) != ARCHIVE_VERSION {
            return Err("bad version".to_string());
        }
        let mut key = derive_export_key(password, &salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "bad key".to_string())?;
        wipe(&mut key);
        let mut counter = 0_u64;
        let mut frames = Vec::new();
        loop {
            let mut length = [0_u8; 4];
            match input.read_exact(&mut length) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.to_string()),
            }
            let length = u32::from_le_bytes(length) as usize;
            if length == 0 || length > MAX_FRAME_BYTES + 32 {
                return Err("bad frame".to_string());
            }
            let mut ciphertext = vec![0_u8; length];
            input
                .read_exact(&mut ciphertext)
                .map_err(|error| error.to_string())?;
            let mut nonce = [0_u8; 12];
            nonce[..4].copy_from_slice(&prefix);
            nonce[4..].copy_from_slice(&counter.to_be_bytes());
            let mut aad = Vec::new();
            aad.extend_from_slice(aad_prefix);
            aad.extend_from_slice(&salt);
            aad.extend_from_slice(&prefix);
            aad.extend_from_slice(&counter.to_be_bytes());
            frames.push(
                cipher
                    .decrypt(
                        &Nonce::from(nonce),
                        Payload {
                            msg: &ciphertext,
                            aad: &aad,
                        },
                    )
                    .map_err(|_| "decrypt failed".to_string())?,
            );
            counter += 1;
        }
        Ok(frames)
    }

    #[test]
    fn archive_is_framed_encrypted_and_password_bound() {
        let root =
            std::env::temp_dir().join(format!("kaigen-web-archive-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("payload")).unwrap();
        fs::write(root.join("payload/index.enc"), b"ciphertext marker").unwrap();
        let transaction_id = "12345678901234567890123456789012";
        let artifact = build_workspace_archive(
            &root,
            transaction_id,
            br#"{"closeTransaction":null}"#,
            2,
            42,
            Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            "export password".to_string(),
        )
        .unwrap();
        let encoded = fs::read(&artifact.path).unwrap();
        assert!(!encoded
            .windows(17)
            .any(|value| value == b"ciphertext marker"));
        let frames = decrypt_frames(
            &artifact.path,
            "export password",
            ARCHIVE_MAGIC,
            ARCHIVE_AAD,
        )
        .unwrap();
        assert_eq!(frames.first().map(|frame| frame[0]), Some(FRAME_MANIFEST));
        assert!(frames.iter().any(|frame| frame[0] == FRAME_ARCHIVE_END));
        assert!(
            decrypt_frames(&artifact.path, "wrong password", ARCHIVE_MAGIC, ARCHIVE_AAD,).is_err()
        );
        let wrong_staging = root.join("workspace-restore-wrong");
        assert!(restore_workspace_archive(
            &artifact.path,
            &wrong_staging,
            "wrong password",
            1024 * 1024,
        )
        .is_err());
        assert!(!wrong_staging.exists());
        let staging = root.join("workspace-restore-success");
        let mut restored =
            restore_workspace_archive(&artifact.path, &staging, "export password", 1024 * 1024)
                .unwrap();
        assert_eq!(
            restored.identifier.as_deref(),
            Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        );
        assert_eq!(restored.domain_json, br#"{"closeTransaction":null}"#);
        assert_eq!(
            fs::read(restored.payload_root.join("payload/index.enc")).unwrap(),
            b"ciphertext marker"
        );
        wipe(&mut restored.domain_json);
        fs::remove_dir_all(staging).unwrap();
        remove_workspace_archive(&root, transaction_id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profile_archive_is_private_password_bound_and_non_destructive() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-web-profile-archive-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let profile_root = root.join("profiles/profile-test");
        fs::create_dir_all(profile_root.join("data")).unwrap();
        let profile_path = profile_root.join("profile-test.tox");
        fs::write(&profile_path, b"internal encrypted savedata").unwrap();
        fs::write(
            profile_root.join("profile-test.tox.writing"),
            b"incomplete savedata",
        )
        .unwrap();
        fs::write(
            profile_root.join("data/chat-history.json"),
            b"profile history marker",
        )
        .unwrap();
        fs::write(profile_root.join("data/pq-state.bin"), b"pq marker").unwrap();
        let artifact_id = "abcdefghijklmnopqrstuvwxyzABCDEF";
        let artifact = build_profile_archive(
            &root,
            artifact_id,
            vec![
                (
                    "data/chat-history.json".to_string(),
                    b"profile history marker".to_vec(),
                ),
                ("data/pq-state.bin".to_string(), b"pq marker".to_vec()),
            ],
            br#"{"displayName":"private profile marker"}"#,
            br#"{"language":"en"}"#,
            b"raw tox savedata marker".to_vec(),
            42,
            "profile export password".to_string(),
        )
        .unwrap();

        let encoded = fs::read(&artifact.path).unwrap();
        for secret in [
            b"private profile marker".as_slice(),
            b"raw tox savedata marker".as_slice(),
            b"profile history marker".as_slice(),
            b"profile export password".as_slice(),
        ] {
            assert!(!encoded.windows(secret.len()).any(|window| window == secret));
        }
        let frames = decrypt_frames(
            &artifact.path,
            "profile export password",
            PROFILE_ARCHIVE_MAGIC,
            PROFILE_ARCHIVE_AAD,
        )
        .unwrap();
        assert_eq!(frames.first().map(|frame| frame[0]), Some(FRAME_MANIFEST));
        assert!(frames.iter().any(|frame| {
            frame
                .windows(b"raw tox savedata marker".len())
                .any(|window| window == b"raw tox savedata marker")
        }));
        assert!(frames.iter().any(|frame| {
            frame
                .windows(b"profile history marker".len())
                .any(|window| window == b"profile history marker")
        }));
        assert!(!frames.iter().any(|frame| {
            frame
                .windows(b"internal encrypted savedata".len())
                .any(|window| window == b"internal encrypted savedata")
        }));
        assert!(decrypt_frames(
            &artifact.path,
            "wrong password",
            PROFILE_ARCHIVE_MAGIC,
            PROFILE_ARCHIVE_AAD,
        )
        .is_err());
        assert_eq!(
            fs::read(&profile_path).unwrap(),
            b"internal encrypted savedata"
        );

        let wrong_staging = root.join(".restore-wrong");
        assert!(restore_profile_archive(&artifact.path, &wrong_staging, "wrong password").is_err());
        assert!(!wrong_staging.exists());
        let staging = root.join(".restore-success");
        let restored =
            restore_profile_archive(&artifact.path, &staging, "profile export password").unwrap();
        assert_eq!(restored.display_name, "private profile marker");
        assert_eq!(restored.savedata, b"raw tox savedata marker");
        assert_eq!(
            fs::read(restored.data_root.join("chat-history.json")).unwrap(),
            b"profile history marker"
        );
        assert_eq!(
            fs::read(restored.data_root.join("pq-state.bin")).unwrap(),
            b"pq marker"
        );
        fs::remove_dir_all(staging).unwrap();

        remove_exact_file(&artifact.path).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
