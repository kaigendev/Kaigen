//! Standalone transaction executor. This module does not import Tauri or Tox.
use super::{
    helper_types::{self as types, Job, Mode},
    platform,
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn run() -> i32 {
    match execute() {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

fn execute() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 || (args[1] != "--apply" && args[1] != "--recover") {
        return Err("UPDATE_HELPER_ARGUMENT_INVALID".into());
    }
    let recovering = args[1] == "--recover";
    let directory = fs::canonicalize(PathBuf::from(&args[2])).map_err(|_| "UPDATE_JOB_INVALID")?;
    let own_exe = fs::canonicalize(std::env::current_exe().map_err(|_| "UPDATE_JOB_INVALID")?)
        .map_err(|_| "UPDATE_JOB_INVALID")?;
    if own_exe.parent().and_then(Path::parent) != Some(directory.as_path())
        || own_exe
            .parent()
            .and_then(Path::file_name)
            .is_none_or(|name| name != "runner")
    {
        return Err("UPDATE_JOB_INVALID".into());
    }
    let mut job = types::read_job(&directory)?;
    let token = read_line()?;
    if token != job.nonce {
        return Err("UPDATE_HELPER_HANDSHAKE_INVALID".into());
    }
    let parent = super::helper_parent::Parent::open(
        job.parent_pid,
        &job.layout.executable,
        job.parent_identity,
    )?;
    if platform::other_instances(&job.layout.executable, job.parent_pid)? {
        return Err("UPDATE_OTHER_INSTANCE_ACTIVE".into());
    }
    job.helper_pid = Some(std::process::id());
    job.helper_identity = Some(platform::process_identity(std::process::id())?);
    types::save_job(&directory, &job)?;
    println!("READY {}", job.nonce);
    std::io::stdout()
        .flush()
        .map_err(|_| "UPDATE_HELPER_HANDSHAKE_INVALID")?;
    if read_line()? != format!("COMMIT {}", job.nonce) {
        return Err("UPDATE_CANCELLED".into());
    }
    job.phase = if recovering {
        "recovering-parent"
    } else {
        "waiting-parent"
    }
    .into();
    types::save_job(&directory, &job)?;
    if let Err(error) = parent.wait(Duration::from_secs(120)) {
        job.phase = "failed".into();
        job.error_code = Some(error.clone());
        let _ = types::save_job(&directory, &job);
        if error == "UPDATE_PARENT_EXIT_FAILED" {
            let _ = restart(&job);
        }
        return Err(error); // A timeout never starts a duplicate parent.
    }
    let mut marker = String::new();
    if let Ok(file) = fs::File::open(directory.join("clean-exit")) {
        let _ = file.take(64).read_to_string(&mut marker);
    }
    if marker != job.nonce {
        job.phase = "failed".into();
        job.error_code = Some("UPDATE_CLEAN_EXIT_UNCONFIRMED".into());
        types::save_job(&directory, &job)?;
        restart(&job)?; // Parent exited; payload has not been touched.
        return Err("UPDATE_CLEAN_EXIT_UNCONFIRMED".into());
    }
    if platform::other_instances(&job.layout.executable, 0)? {
        job.phase = "failed".into();
        job.error_code = Some("UPDATE_OTHER_INSTANCE_ACTIVE".into());
        types::save_job(&directory, &job)?;
        restart(&job)?;
        return Err("UPDATE_OTHER_INSTANCE_ACTIVE".into());
    }
    let result = if recovering {
        rollback(&directory, &mut job)
    } else {
        install(&directory, &mut job)
    };
    if let Err(error) = result {
        let restored = rollback(&directory, &mut job);
        job.phase = if restored.is_ok() {
            "failed"
        } else {
            "rollback-failed"
        }
        .into();
        job.error_code = Some(restored.as_ref().err().cloned().unwrap_or(error));
        types::save_job(&directory, &job)?;
        if restored.is_ok() {
            restart(&job)?;
        }
        return Err("UPDATE_INSTALL_FAILED".into());
    }
    if recovering {
        job.phase = "failed".into();
        job.error_code = Some("UPDATE_INTERRUPTED_ROLLED_BACK".into());
        types::save_job(&directory, &job)?;
        return restart(&job);
    }
    match restart_and_confirm(&directory, &mut job) {
        Ok(()) => {
            job.phase = "complete".into();
            types::save_job(&directory, &job)
        }
        Err(error) if error == "UPDATE_STARTUP_SHUTDOWN_TIMEOUT" => {
            job.phase = "restart-blocked".into();
            job.error_code = Some(error.clone());
            types::save_job(&directory, &job)?;
            Err(error)
        }
        Err(error) => {
            if job.layout.mode == Mode::WindowsMsi {
                job.phase = "failed".into();
                job.error_code = Some("UPDATE_MSI_STARTUP_FAILED".into());
                types::save_job(&directory, &job)?;
                return Err(error);
            }
            let restored = rollback(&directory, &mut job);
            job.phase = if restored.is_ok() {
                "failed"
            } else {
                "rollback-failed"
            }
            .into();
            job.error_code = Some(restored.as_ref().err().cloned().unwrap_or(error));
            types::save_job(&directory, &job)?;
            if restored.is_ok() {
                restart(&job)?;
            }
            Err("UPDATE_STARTUP_FAILED".into())
        }
    }
}

fn read_line() -> Result<String, String> {
    let mut input = std::io::stdin().lock();
    let mut bytes = Vec::new();
    for _ in 0..128 {
        let mut byte = [0];
        input
            .read_exact(&mut byte)
            .map_err(|_| "UPDATE_HELPER_HANDSHAKE_INVALID")?;
        if byte[0] == b'\n' {
            return String::from_utf8(bytes).map_err(|_| "UPDATE_HELPER_HANDSHAKE_INVALID".into());
        }
        bytes.push(byte[0]);
    }
    Err("UPDATE_HELPER_HANDSHAKE_INVALID".into())
}

/// Parent exit does not imply that Windows has released every WebView image
/// handle. Retry only admitted program mutations, without terminating children.
/// A single deadline covers all lock retries in one install/rollback phase.
fn program_io<T>(
    deadline: &mut Option<Instant>,
    last_native_error: &mut Option<i32>,
    code: &str,
    mut operation: impl FnMut() -> std::io::Result<T>,
) -> Result<T, String> {
    #[cfg(not(windows))]
    {
        let _ = (deadline, last_native_error);
        operation().map_err(|_| code.to_string())
    }
    #[cfg(windows)]
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let native = error.raw_os_error();
                *last_native_error = native;
                // Access denied is also returned for a loaded image/directory;
                // permanent ACL failures still stop at this bounded deadline.
                if matches!(native, Some(5 | 32 | 33)) {
                    let until =
                        *deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(15));
                    let remaining = until.saturating_duration_since(Instant::now());
                    if !remaining.is_zero() {
                        std::thread::sleep(remaining.min(Duration::from_millis(100)));
                        continue;
                    }
                }
                return Err(code.to_string());
            }
        }
    }
}

fn install(directory: &Path, job: &mut Job) -> Result<(), String> {
    if job.layout.mode == Mode::WindowsMsi {
        return install_msi(directory, job);
    }
    let candidate = directory.join("candidate");
    types::checked_path(&candidate)?;
    let backup = directory.join("backup");
    types::create_private_dir(&backup)?;
    job.phase = "installing".into();
    types::save_job(directory, job)?;
    let mut io_deadline = None;
    for index in 0..job.entries.len() {
        let entry = job.entries[index].clone();
        let from = candidate.join(&entry.name);
        let to = job.layout.program_root.join(&entry.name);
        let old = backup.join(&entry.name);
        types::checked_path(&from)?;
        if to.exists() != entry.had_old {
            return Err("UPDATE_PROGRAM_CHANGED".into());
        }
        if to.exists() {
            types::checked_path(&to)?;
            if to.is_file() {
                // Files remain present during replacement; in particular neither
                // the application EXE nor its import DLLs have a missing window.
                let partial = backup.join(format!("{}.partial", entry.name));
                program_io(
                    &mut io_deadline,
                    &mut job.last_native_error,
                    "UPDATE_BACKUP_FAILED",
                    || fs::copy(&to, &partial),
                )?;
                fs::OpenOptions::new()
                    .write(true)
                    .open(&partial)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| "UPDATE_BACKUP_FAILED")?;
                program_io(
                    &mut io_deadline,
                    &mut job.last_native_error,
                    "UPDATE_BACKUP_FAILED",
                    || fs::rename(&partial, &old),
                )?;
            } else {
                program_io(
                    &mut io_deadline,
                    &mut job.last_native_error,
                    "UPDATE_BACKUP_FAILED",
                    || fs::rename(&to, &old),
                )?;
            }
        }
        job.entries[index].backed_up = true;
        types::save_job(directory, job)?;
        if from.is_file() {
            program_io(
                &mut io_deadline,
                &mut job.last_native_error,
                "UPDATE_RENAME_FAILED",
                || platform::replace_file_io(&from, &to),
            )?;
        } else {
            program_io(
                &mut io_deadline,
                &mut job.last_native_error,
                "UPDATE_RENAME_FAILED",
                || fs::rename(&from, &to),
            )?;
        }
        job.entries[index].installed = true;
        types::save_job(directory, job)?;
        types::sync_directory(&job.layout.program_root)?;
    }
    Ok(())
}

pub(super) fn rollback(directory: &Path, job: &mut Job) -> Result<(), String> {
    // Windows Installer owns MSI rollback; never overlay files onto its product.
    if job.layout.mode == Mode::WindowsMsi {
        return Ok(());
    }
    job.phase = "rolling-back".into();
    types::save_job(directory, job)?;
    let backup = directory.join("backup");
    let candidate = directory.join("candidate");
    let failed = directory.join("failed-payload");
    if !failed.exists() {
        types::create_private_dir(&failed)?;
    }
    let mut io_deadline = None;
    for index in (0..job.entries.len()).rev() {
        let entry = job.entries[index].clone();
        let live = job.layout.program_root.join(&entry.name);
        let old = backup.join(&entry.name);
        if old.exists() {
            types::checked_path(&old)?;
            if old.is_file() {
                program_io(
                    &mut io_deadline,
                    &mut job.last_native_error,
                    "UPDATE_ROLLBACK_FAILED",
                    || platform::replace_file_io(&old, &live),
                )?;
            } else {
                if live.exists() {
                    types::checked_path(&live)?;
                    program_io(
                        &mut io_deadline,
                        &mut job.last_native_error,
                        "UPDATE_ROLLBACK_FAILED",
                        || fs::rename(&live, failed.join(&entry.name)),
                    )?;
                }
                program_io(
                    &mut io_deadline,
                    &mut job.last_native_error,
                    "UPDATE_ROLLBACK_FAILED",
                    || fs::rename(&old, &live),
                )?;
            }
        } else if !entry.had_old && !candidate.join(&entry.name).exists() && live.exists() {
            types::checked_path(&live)?;
            program_io(
                &mut io_deadline,
                &mut job.last_native_error,
                "UPDATE_ROLLBACK_FAILED",
                || fs::rename(&live, failed.join(&entry.name)),
            )?;
        }
        job.entries[index].installed = false;
        job.entries[index].backed_up = false;
        types::save_job(directory, job)?;
    }
    types::sync_directory(&job.layout.program_root)
}

#[cfg(windows)]
fn msi_command_path(path: &Path) -> Result<PathBuf, String> {
    use std::ffi::OsString;
    use std::path::{Component, Prefix};

    let invalid = "UPDATE_MSI_PATH_INVALID";
    if !path.is_absolute() {
        return Err(invalid.into());
    }
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Err(invalid.into());
    };
    let mut plain = match prefix.kind() {
        Prefix::Disk(_) | Prefix::UNC(_, _) => return Ok(path.to_path_buf()),
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => {
            let mut root = OsString::from(r"\\");
            root.push(server);
            root.push(r"\");
            root.push(share);
            root.push(r"\");
            PathBuf::from(root)
        }
        _ => return Err(invalid.into()),
    };
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => plain.push(name),
            _ => return Err(invalid.into()),
        }
    }
    // The installer needs a DOS path. Keep the validated canonical identity
    // for filesystem and job checks.
    if fs::canonicalize(&plain).ok().as_deref() != Some(path) {
        return Err(invalid.into());
    }
    Ok(plain)
}

fn install_msi(directory: &Path, job: &mut Job) -> Result<(), String> {
    #[cfg(windows)]
    {
        let msi = directory.join("archive.msi");
        types::checked_path(&msi)?;
        if platform::msi_directory()
            .and_then(|root| fs::canonicalize(root).ok())
            .as_ref()
            != Some(&job.layout.program_root)
        {
            return Err("UPDATE_MSI_REGISTRATION_CHANGED".into());
        }
        let package = msi_command_path(&msi)?;
        let mut install_folder = std::ffi::OsString::from("INSTALLFOLDER=");
        install_folder.push(msi_command_path(&job.layout.program_root)?);
        job.phase = "installing".into();
        types::save_job(directory, job)?;
        let system = std::env::var_os("SystemRoot").ok_or("UPDATE_MSI_UNAVAILABLE")?;
        let mut command = Command::new(PathBuf::from(system).join("System32/msiexec.exe"));
        command
            .arg("/i")
            .arg(package)
            .args([
                "/passive",
                "/norestart",
                "REBOOT=ReallySuppress",
                "MSIRESTARTMANAGERCONTROL=Disable",
            ])
            .arg(install_folder)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = platform::spawn(&mut command)?.wait().map_err(|error| {
            job.last_native_error = error.raw_os_error();
            "UPDATE_MSI_FAILED"
        })?;
        match status.code() {
            Some(0) => Ok(()),
            Some(3010) => {
                job.error_code = Some("UPDATE_REBOOT_REQUIRED".into());
                Ok(())
            }
            Some(code) => {
                job.last_native_error = Some(code);
                Err(format!("UPDATE_MSI_FAILED_{code}"))
            }
            None => Err("UPDATE_MSI_FAILED".into()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (directory, job);
        Err("UPDATE_PLATFORM_UNSUPPORTED".into())
    }
}

fn restart(job: &Job) -> Result<(), String> {
    launch(job, false).map(|_| ())
}

fn launch(job: &Job, confirming: bool) -> Result<std::process::Child, String> {
    if !job.layout.executable.is_file() {
        return Err("UPDATE_RESTART_FAILED".into());
    }
    let mut command = Command::new(&job.layout.executable);
    command
        .current_dir(&job.layout.portable_root)
        .env("KAIGEN_PORTABLE_ROOT", &job.layout.portable_root)
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env_remove("KAIGEN_UPDATE_NONCE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if confirming {
        command.env("KAIGEN_UPDATE_NONCE", &job.nonce);
    }
    platform::spawn(&mut command)
}

fn restart_and_confirm(directory: &Path, job: &mut Job) -> Result<(), String> {
    job.phase = "awaiting-ready".into();
    types::save_job(directory, job)?;
    let mut child = launch(job, true)?;
    let readiness = (|| -> Result<(), String> {
        job.restart_pid = Some(child.id());
        job.restart_identity = Some(platform::process_identity(child.id())?);
        types::save_job(directory, job)?;
        let deadline = Instant::now() + Duration::from_secs(90);
        let mut acknowledged = None;
        while Instant::now() < deadline {
            if child
                .try_wait()
                .map_err(|_| "UPDATE_STARTUP_FAILED")?
                .is_some()
            {
                return Err("UPDATE_STARTUP_FAILED".into());
            }
            if ["startup-ready", "renderer-ready"]
                .iter()
                .all(|name| valid_startup_ack(&directory.join(name), job))
            {
                let since = acknowledged.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_secs(3) {
                    return Ok(());
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        Err("UPDATE_STARTUP_FAILED".into())
    })();
    if readiness.is_ok() {
        return Ok(());
    }
    if child.try_wait().ok().flatten().is_some() {
        return readiness;
    }
    // Any failure after spawn (including journal/disk failure) must keep live
    // program files intact until this exact child has exited gracefully.
    if let Ok(mut marker) = types::create_private_file(&directory.join("abort-startup")) {
        let _ = marker
            .write_all(job.nonce.as_bytes())
            .and_then(|_| marker.sync_all());
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|_| "UPDATE_STARTUP_SHUTDOWN_TIMEOUT")?
            .is_some()
        {
            return readiness;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Only a graceful owned-child exit permits rollback. No forced termination.
    Err("UPDATE_STARTUP_SHUTDOWN_TIMEOUT".into())
}

fn valid_startup_ack(path: &Path, job: &Job) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(1024).read_to_end(&mut bytes).is_err() {
        return false;
    }
    serde_json::from_slice::<types::StartupAck>(&bytes).is_ok_and(|ack| {
        ack.nonce == job.nonce
            && Some(ack.pid) == job.restart_pid
            && Some(ack.identity) == job.restart_identity
    })
}
