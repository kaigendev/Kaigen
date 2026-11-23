use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const WINDOWS_ENTRIES: &[&str] = &[
    "Kaigen.exe",
    "KaigenUpdater.exe",
    "toxcore.dll",
    "pthreadVC3.dll",
    "PORTABLE.txt",
    "POST_QUANTUM.txt",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
    "WebView2Runtime",
    "TorExpertBundle",
    "runtime",
];
pub(super) const JOB_PREFIX: &str = ".kaigen-update-";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Mode {
    WindowsPortable,
    WindowsMsi,
    LinuxAppImage,
    MacApp,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Layout {
    pub mode: Mode,
    pub program_root: PathBuf,
    pub executable: PathBuf,
    pub target_name: String,
    pub portable_root: PathBuf,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub name: String,
    pub had_old: bool,
    pub backed_up: bool,
    pub installed: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Job {
    pub format_version: u32,
    pub nonce: String,
    pub layout: Layout,
    pub parent_pid: u32,
    pub parent_identity: u64,
    pub helper_pid: Option<u32>,
    pub helper_identity: Option<u64>,
    pub restart_pid: Option<u32>,
    pub restart_identity: Option<u64>,
    pub version: String,
    pub archive_sha256: String,
    pub phase: String,
    pub entries: Vec<Entry>,
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_native_error: Option<i32>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct StartupAck {
    pub nonce: String,
    pub pid: u32,
    pub identity: u64,
}

pub(super) fn staging_parent(layout: &Layout) -> Result<&Path, String> {
    match layout.mode {
        Mode::WindowsPortable | Mode::WindowsMsi => layout
            .program_root
            .parent()
            .ok_or_else(|| "UPDATE_LOCATION_INVALID".into()),
        _ => Ok(&layout.program_root),
    }
}

pub(super) fn job_path(layout: &Layout, nonce: &str) -> Result<PathBuf, String> {
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("UPDATE_JOB_INVALID".into());
    }
    Ok(staging_parent(layout)?.join(format!("{JOB_PREFIX}{nonce}")))
}

pub(super) fn single_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && !value.contains(['/', '\\', ':'])
        && value != "."
        && value != ".."
        && !value.chars().any(char::is_control)
}

pub(super) fn checked_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("UPDATE_LOCATION_INVALID".into());
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| "UPDATE_LOCATION_INVALID")?;
        if metadata.file_type().is_symlink() {
            return Err("UPDATE_LINK_DENIED".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("UPDATE_LINK_DENIED".into());
            }
        }
    }
    Ok(())
}

pub(super) fn create_private_dir(path: &Path) -> Result<(), String> {
    super::platform::create_private_directory(path)
}

pub(super) fn create_private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "UPDATE_DISK_WRITE_FAILED".into())
}

pub(super) fn save_job(directory: &Path, job: &Job) -> Result<(), String> {
    let bytes = serde_json::to_vec(job).map_err(|_| "UPDATE_JOB_INVALID")?;
    if bytes.len() > 64 * 1024 {
        return Err("UPDATE_JOB_INVALID".into());
    }
    let temporary = directory.join("journal.next");
    if temporary.exists() {
        checked_path(&temporary)?;
        fs::remove_file(&temporary).map_err(|_| "UPDATE_JOURNAL_FAILED")?;
    }
    let mut file = create_private_file(&temporary)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "UPDATE_JOURNAL_FAILED")?;
    drop(file);
    super::platform::replace_file(&temporary, &directory.join("journal.json"))?;
    sync_directory(directory)
}

pub(super) fn read_job(directory: &Path) -> Result<Job, String> {
    checked_path(directory)?;
    let path = directory.join("journal.json");
    checked_path(&path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "UPDATE_JOB_INVALID")?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "UPDATE_JOB_INVALID")?;
    if bytes.len() > 64 * 1024 {
        return Err("UPDATE_JOB_INVALID".into());
    }
    let job: Job = serde_json::from_slice(&bytes).map_err(|_| "UPDATE_JOB_INVALID")?;
    if job.format_version != 1
        || job_path(&job.layout, &job.nonce)? != directory
        || job.entries.len() > WINDOWS_ENTRIES.len() + 2
        || job.archive_sha256.len() != 64
        || !job.archive_sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("UPDATE_JOB_INVALID".into());
    }
    if !match job.layout.mode {
        Mode::WindowsPortable | Mode::WindowsMsi => cfg!(windows),
        Mode::LinuxAppImage => cfg!(target_os = "linux"),
        Mode::MacApp => cfg!(target_os = "macos"),
    } {
        return Err("UPDATE_PLATFORM_UNSUPPORTED".into());
    }
    checked_path(&job.layout.program_root)?;
    checked_path(&job.layout.portable_root)?;
    if !job.layout.program_root.is_dir() || !single_name(&job.layout.target_name) {
        return Err("UPDATE_JOB_INVALID".into());
    }
    let mut names = std::collections::HashSet::new();
    for entry in &job.entries {
        if !single_name(&entry.name) || !names.insert(entry.name.to_ascii_lowercase()) {
            return Err("UPDATE_JOB_INVALID".into());
        }
        let allowed = match job.layout.mode {
            Mode::WindowsPortable => WINDOWS_ENTRIES.contains(&entry.name.as_str()),
            Mode::WindowsMsi => false,
            Mode::LinuxAppImage => {
                entry.name == job.layout.target_name || entry.name == "kaigen-updater"
            }
            Mode::MacApp => entry.name == job.layout.target_name && entry.name.ends_with(".app"),
        };
        if !allowed {
            return Err("UPDATE_JOB_INVALID".into());
        }
        let at = job.layout.program_root.join(&entry.name);
        if at.exists() {
            checked_path(&at)?;
        }
        if job.layout.portable_root != job.layout.program_root
            && job.layout.portable_root.starts_with(&at)
        {
            return Err("UPDATE_DATA_LOCATION_OVERLAP".into());
        }
    }
    let expected_exe = match job.layout.mode {
        Mode::WindowsPortable | Mode::WindowsMsi => job.layout.program_root.join("Kaigen.exe"),
        Mode::LinuxAppImage => job.layout.program_root.join(&job.layout.target_name),
        Mode::MacApp => {
            let base = job
                .layout
                .program_root
                .join(&job.layout.target_name)
                .join("Contents/MacOS");
            if !job.layout.executable.starts_with(&base)
                || job.layout.executable.parent() != Some(base.as_path())
            {
                return Err("UPDATE_JOB_INVALID".into());
            }
            job.layout.executable.clone()
        }
    };
    if job.layout.executable != expected_exe {
        return Err("UPDATE_JOB_INVALID".into());
    }
    Ok(job)
}

pub(super) fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "UPDATE_JOURNAL_FAILED")?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}
