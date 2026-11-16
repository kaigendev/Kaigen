//! Durable local attachment metadata. Payload stays in the normal downloads
//! directory; no credentials, message bodies or ephemeral cache keys are stored.
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

const ERROR: &str = "WEBGATE_LOCAL_DOWNLOAD_INVALID";
const MAX_RECEIPT: u64 = 96 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Binding {
    pub profile_id: String,
    pub account: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    binding: Binding,
    message_id: String,
    transfer_id: String,
    size: u64,
    sha256: String,
    filename: String,
}

#[derive(Clone, Eq, PartialEq)]
struct Stamp {
    identity: (u64, u64),
    size: u64,
    modified: SystemTime,
}
static VERIFIED: OnceLock<Mutex<HashMap<String, Stamp>>> = OnceLock::new();

pub(crate) fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(ERROR.into());
    }
    Ok(())
}

fn no_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

pub(crate) fn checked_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(ERROR.into());
    }
    for parent in path.ancestors() {
        if parent.as_os_str().is_empty() {
            continue;
        }
        let meta = fs::symlink_metadata(parent).map_err(|_| ERROR)?;
        if !meta.is_dir() || !no_reparse(&meta) {
            return Err(ERROR.into());
        }
    }
    Ok(())
}

pub(crate) fn directory(root: &Path, name: &str, create: bool) -> Result<PathBuf, String> {
    filename(name)?;
    checked_directory(root)?;
    let path = root.join(name);
    if create && !path.exists() {
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = fs::DirBuilder::new();
        match builder.create(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ERROR.into()),
        }
    }
    checked_directory(&path)?;
    Ok(path)
}

fn regular(path: &Path) -> Result<File, String> {
    checked_directory(path.parent().ok_or(ERROR)?)?;
    let before = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if !before.is_file() || !no_reparse(&before) {
        return Err(ERROR.into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|_| ERROR)?;
    let meta = file.metadata().map_err(|_| ERROR)?;
    if !meta.is_file()
        || !no_reparse(&meta)
        || before.len() != meta.len()
        || before.modified().ok() != meta.modified().ok()
    {
        return Err(ERROR.into());
    }
    Ok(file)
}

fn stamp(file: &File) -> Result<Stamp, String> {
    let meta = file.metadata().map_err(|_| ERROR)?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        // The owned File keeps its handle alive; the zeroed fixed-layout output
        // is writable throughout this synchronous Windows metadata call.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(ERROR.into());
        }
        (
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        )
    };
    #[cfg(not(any(unix, windows)))]
    let identity = return Err(ERROR.into());
    Ok(Stamp {
        identity,
        size: meta.len(),
        modified: meta.modified().map_err(|_| ERROR)?,
    })
}

fn key(binding: &Binding, message: &str, transfer: &str) -> Result<String, String> {
    identifier(&binding.profile_id)?;
    identifier(&binding.account)?;
    identifier(message)?;
    identifier(transfer)?;
    let bytes = serde_json::to_vec(&(binding, message, transfer)).map_err(|_| ERROR)?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn filename(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains(['/', '\\', ':'])
        || value.ends_with(['.', ' '])
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(ERROR.into());
    }
    Ok(())
}

fn verify(
    root: &Path,
    receipt: &Receipt,
    force: bool,
    cache_key: &str,
) -> Result<Option<PathBuf>, String> {
    filename(&receipt.filename)?;
    if receipt.version != 1 || receipt.size == 0 || receipt.size > 25 * 1024 * 1024 {
        return Err(ERROR.into());
    }
    let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&receipt.sha256)
        .map_err(|_| ERROR)?;
    if expected.len() != 32 {
        return Err(ERROR.into());
    }
    let downloads = directory(root, "downloads", false)?;
    let path = downloads.join(&receipt.filename);
    if !path.try_exists().map_err(|_| ERROR)? {
        return Ok(None);
    }
    let mut file = regular(&path)?;
    let before = stamp(&file)?;
    if before.size != receipt.size {
        return Ok(None);
    }
    let cache = VERIFIED.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = !force && cache.lock().map_err(|_| ERROR)?.get(cache_key) == Some(&before);
    if !cached {
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|_| ERROR)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        if digest.finalize().as_slice() != expected {
            return Ok(None);
        }
    }
    let after = stamp(&file)?;
    let path_file = regular(&path)?;
    if before != after || before != stamp(&path_file)? {
        return Err(ERROR.into());
    }
    let mut cached = cache.lock().map_err(|_| ERROR)?;
    if cached.len() >= 512 {
        cached.clear();
    }
    cached.insert(cache_key.into(), before);
    Ok(Some(path))
}

pub(crate) fn save(
    root: &Path,
    binding: Binding,
    message: String,
    transfer: String,
    size: u64,
    sha256: String,
    destination: &Path,
) -> Result<(), String> {
    let id = key(&binding, &message, &transfer)?;
    let downloads = directory(root, "downloads", false)?;
    if destination.parent() != Some(downloads.as_path()) {
        return Err(ERROR.into());
    }
    let receipt = Receipt {
        version: 1,
        binding,
        message_id: message,
        transfer_id: transfer,
        size,
        sha256,
        filename: destination
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(ERROR)?
            .into(),
    };
    let cache_key = format!("{}:{id}:{}", root.display(), receipt.sha256);
    if verify(root, &receipt, true, &cache_key)?.is_none() {
        return Err(ERROR.into());
    }
    let folder = directory(root, "webgate-download-receipts", true)?;
    let path = folder.join(format!("{id}.receipt"));
    if path.try_exists().map_err(|_| ERROR)? {
        let _ = regular(&path)?;
    }
    let mut json = serde_json::to_vec(&receipt).map_err(|_| ERROR)?;
    let encrypted = crate::webgate_store::protect_webgate_store(&json);
    crate::wipe_secret_bytes(&mut json);
    let encrypted = encrypted?;
    crate::profiles::atomic_write(&path, &encrypted)?;
    let _ = regular(&path)?; // atomic_write already flushed the write handle; Windows publish is write-through.
    #[cfg(unix)]
    File::open(&folder)
        .and_then(|f| f.sync_all())
        .map_err(|_| ERROR)?;
    checked_directory(&folder)?;
    Ok(())
}

pub(crate) fn resolve(
    root: &Path,
    binding: &Binding,
    message: &str,
    transfer: &str,
    expected: Option<(u64, &str)>,
    force: bool,
) -> Result<Option<PathBuf>, String> {
    let id = key(binding, message, transfer)?;
    checked_directory(root)?;
    let folder = root.join("webgate-download-receipts");
    if !folder.try_exists().map_err(|_| ERROR)? {
        return Ok(None);
    }
    checked_directory(&folder)?;
    let path = folder.join(format!("{id}.receipt"));
    if !path.try_exists().map_err(|_| ERROR)? {
        return Ok(None);
    }
    let file = regular(&path)?;
    if file.metadata().map_err(|_| ERROR)?.len() > MAX_RECEIPT {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECEIPT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ERROR)?;
    if bytes.len() as u64 > MAX_RECEIPT {
        return Err(ERROR.into());
    }
    let mut json = crate::webgate_store::unprotect_webgate_store(&bytes)?;
    let receipt: Result<Receipt, _> = serde_json::from_slice(&json);
    crate::wipe_secret_bytes(&mut json);
    let receipt = receipt.map_err(|_| ERROR)?;
    if receipt.binding != *binding
        || receipt.message_id != message
        || receipt.transfer_id != transfer
    {
        return Err(ERROR.into());
    }
    if expected.is_some_and(|(size, sha256)| receipt.size != size || receipt.sha256 != sha256) {
        return Ok(None);
    }
    verify(
        root,
        &receipt,
        force,
        &format!("{}:{id}:{}", root.display(), receipt.sha256),
    )
}
