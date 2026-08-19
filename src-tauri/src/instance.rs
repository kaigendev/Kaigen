use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use sha2::{Digest, Sha256};

pub enum InstanceOutcome {
    Primary(InstanceGuard),
    SecondaryActivated,
}

pub(crate) fn report_startup_error(error: &str) {
    eprintln!("Kaigen startup error: {error}");
    #[cfg(target_os = "macos")]
    {
        use std::{
            fs::OpenOptions,
            io::Write,
            process::{Command, Stdio},
            time::{SystemTime, UNIX_EPOCH},
        };

        // Finder launches have no terminal. Persist one unique plain-text
        // diagnostic and ask LaunchServices to show it without Apple Events,
        // Automation permission, or a blocking child wait.
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "Kaigen-startup-error-{}-{timestamp}.txt",
            std::process::id()
        ));
        let write_result = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .and_then(|mut file| writeln!(file, "Kaigen could not start.\n\n{error}\n"));
        if write_result.is_ok() {
            let _ = Command::new("/usr/bin/open")
                .arg("-t")
                .arg(&path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }
}

#[cfg(any(not(target_os = "windows"), test))]
fn portable_instance_error(action: &str, path: &Path, error: &std::io::Error) -> String {
    let mut message = format!("{action} {}: {error}", path.display());
    if cfg!(target_os = "macos") {
        message.push_str("\n\nKaigen could not prepare its writable portable installation in ");
        message.push_str("~/Applications/Kaigen-portable. Existing portable data was not changed.");
    }
    message
}

fn executable_parent(executable: &Path) -> Result<PathBuf, String> {
    let executable = executable
        .canonicalize()
        .unwrap_or_else(|_| executable.to_path_buf());
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "The executable has no parent directory".to_string())
}

#[cfg(any(target_os = "macos", test))]
fn macos_bundle_parent(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .and_then(Path::parent)
        .map(|parent| parent.join("Kaigen-portable-data"))
}

#[cfg(any(target_os = "macos", test))]
mod macos_portable {
    use std::path::{Path, PathBuf};

    #[derive(Debug, Eq, PartialEq)]
    pub(super) struct Layout {
        pub source_dir: PathBuf,
        pub source_data: PathBuf,
        pub destination_dir: PathBuf,
        pub destination_app: PathBuf,
    }

    pub(super) fn layout(executable: &Path, home: &Path) -> Result<Layout, String> {
        let app = executable
            .ancestors()
            .find(|path| path.file_name().is_some_and(|name| name == "Kaigen.app"))
            .ok_or_else(|| "The macOS executable is not inside Kaigen.app".to_string())?;
        if executable.file_name().is_none_or(|name| name != "Kaigen") {
            return Err("The macOS application executable is not named Kaigen".to_string());
        }
        let source_dir = app
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Kaigen.app has no portable parent directory".to_string())?;
        if source_dir
            .file_name()
            .is_none_or(|name| name != "Kaigen-portable")
        {
            return Err(
                "Automatic macOS installation requires the complete Kaigen-portable folder"
                    .to_string(),
            );
        }
        let destination_dir = home.join("Applications").join("Kaigen-portable");
        Ok(Layout {
            source_data: source_dir.join("Kaigen-portable-data"),
            source_dir,
            destination_app: destination_dir.join("Kaigen.app"),
            destination_dir,
        })
    }

    pub(super) fn validate_portable_dir(directory: &Path) -> Result<(), String> {
        let app = directory.join("Kaigen.app");
        let executable = app.join("Contents").join("MacOS").join("Kaigen");
        let data = directory.join("Kaigen-portable-data");
        if !app.is_dir() || !executable.is_file() || !data.is_dir() {
            return Err(format!(
                "Refusing to overwrite incomplete portable installation {}",
                directory.display()
            ));
        }
        if directory.join(".kaigen-auto-install-incomplete").exists() {
            return Err(format!(
                "Refusing to overwrite interrupted portable installation {}",
                directory.display()
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn equivalent(left: &Path, right: &Path) -> bool {
        let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
        let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
        left == right
    }

    #[cfg(target_os = "macos")]
    fn ensure_writable_copy(layout: &Layout) -> Result<(), String> {
        use std::{
            fs::{self, OpenOptions},
            os::fd::AsRawFd,
            process::Command,
        };

        validate_portable_dir(&layout.source_dir)?;
        let applications = layout
            .destination_dir
            .parent()
            .ok_or_else(|| "The macOS portable destination has no parent".to_string())?;
        fs::create_dir_all(applications).map_err(|error| {
            format!(
                "Could not create macOS user Applications directory {}: {error}",
                applications.display()
            )
        })?;
        let install_lock_path = applications.join(".kaigen-portable-install.lock");
        let install_lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&install_lock_path)
            .map_err(|error| {
                format!(
                    "Could not open macOS portable install lock {}: {error}",
                    install_lock_path.display()
                )
            })?;
        if unsafe { libc::flock(install_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(format!(
                "Another Kaigen portable installation is already running: {}",
                std::io::Error::last_os_error()
            ));
        }

        if layout.destination_dir.exists() {
            return validate_portable_dir(&layout.destination_dir);
        }

        // create_dir is the no-overwrite commit point. `ditto` may only merge
        // into the directory this process just created while holding the
        // machine-local install lock. A failed copy keeps the marker and is
        // refused on every later launch instead of overwriting unknown data.
        fs::create_dir(&layout.destination_dir).map_err(|error| {
            format!(
                "Could not reserve macOS portable destination {}: {error}",
                layout.destination_dir.display()
            )
        })?;
        let incomplete = layout
            .destination_dir
            .join(".kaigen-auto-install-incomplete");
        fs::write(
            &incomplete,
            b"Kaigen portable installation is incomplete.\n",
        )
        .map_err(|error| {
            format!(
                "Could not mark macOS portable installation {}: {error}",
                incomplete.display()
            )
        })?;
        let output = Command::new("/usr/bin/ditto")
            .arg(&layout.source_dir)
            .arg(&layout.destination_dir)
            .output()
            .map_err(|error| format!("Could not start the macOS portable copy: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not copy Kaigen-portable to {} (ditto exit {}): {}",
                layout.destination_dir.display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        // Validate the entire portable shape before removing the interrupted
        // marker. The validation intentionally ignores the marker here.
        let executable = layout
            .destination_app
            .join("Contents")
            .join("MacOS")
            .join("Kaigen");
        if !layout.destination_app.is_dir()
            || !executable.is_file()
            || !layout.destination_dir.join("Kaigen-portable-data").is_dir()
        {
            return Err(format!(
                "Copied macOS portable installation is incomplete: {}",
                layout.destination_dir.display()
            ));
        }
        fs::remove_file(&incomplete).map_err(|error| {
            format!(
                "Could not finalize macOS portable installation {}: {error}",
                layout.destination_dir.display()
            )
        })?;
        validate_portable_dir(&layout.destination_dir)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn install_and_relaunch(failing_root: &Path) -> Result<bool, String> {
        use std::process::{Command, Stdio};

        // An explicit portable root belongs to its caller and must never cause
        // an implicit copy to a different location.
        if std::env::var_os("KAIGEN_PORTABLE_ROOT").is_some_and(|value| !value.is_empty()) {
            return Ok(false);
        }
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate the macOS executable: {error}"))?;
        let home = std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is unavailable for the macOS portable installation".to_string())?;
        let layout = layout(&executable, &home)?;
        if !equivalent(failing_root, &layout.source_data)
            || equivalent(&layout.source_dir, &layout.destination_dir)
        {
            return Ok(false);
        }
        ensure_writable_copy(&layout)?;
        Command::new("/usr/bin/open")
            .arg("-n")
            .arg(&layout.destination_app)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not relaunch writable Kaigen.app {}: {error}",
                    layout.destination_app.display()
                )
            })?;
        Ok(true)
    }
}

pub(crate) fn portable_root_for_current_executable() -> Result<PathBuf, String> {
    if let Some(override_root) =
        std::env::var_os("KAIGEN_PORTABLE_ROOT").filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(override_root));
    }

    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE").filter(|value| !value.is_empty()) {
        let appimage = PathBuf::from(appimage);
        return appimage
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "The AppImage has no parent directory".to_string());
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the executable: {error}"))?;
    #[cfg(target_os = "macos")]
    if let Some(root) = macos_bundle_parent(&executable) {
        return Ok(root);
    }
    executable_parent(&executable)
}

fn instance_key_for_root(root: &Path) -> String {
    let normalized = root.to_string_lossy().replace('/', "\\").to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

static ACTIVE_PROFILE_IDENTITIES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn profile_identity_key(public_key: &str) -> Result<String, String> {
    let public_key = public_key.trim().to_ascii_uppercase();
    if public_key.len() != 64 || !public_key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("TOX_PROFILE_IDENTITY_INVALID".to_string());
    }
    Ok(public_key)
}

fn profile_identity_lock_name(public_key: &str) -> String {
    let digest = Sha256::digest(public_key.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Keeps one Tox identity exclusive across every loaded profile and every
/// portable Kaigen root on this machine. Running two toxcore instances with
/// the same savedata makes remote contacts observe one row alternating between
/// the two local names/statuses.
pub(crate) struct ProfileIdentityGuard {
    public_key: String,
    platform: Option<profile_identity_platform::Guard>,
}

impl ProfileIdentityGuard {
    pub(crate) fn acquire(public_key: &str) -> Result<Self, String> {
        let public_key = profile_identity_key(public_key)?;
        let identities = ACTIVE_PROFILE_IDENTITIES.get_or_init(|| Mutex::new(HashSet::new()));
        {
            let mut identities = identities
                .lock()
                .map_err(|_| "Could not reserve the Tox profile identity".to_string())?;
            if !identities.insert(public_key.clone()) {
                return Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string());
            }
        }

        match profile_identity_platform::Guard::acquire(&public_key) {
            Ok(platform) => Ok(Self {
                public_key,
                platform: Some(platform),
            }),
            Err(error) => {
                if let Ok(mut identities) = identities.lock() {
                    identities.remove(&public_key);
                }
                Err(error)
            }
        }
    }
}

impl Drop for ProfileIdentityGuard {
    fn drop(&mut self) {
        // Release the machine-wide primitive before allowing this process to
        // reserve the same public key again.
        drop(self.platform.take());
        if let Some(identities) = ACTIVE_PROFILE_IDENTITIES.get() {
            match identities.lock() {
                Ok(mut identities) => {
                    identities.remove(&self.public_key);
                }
                Err(poisoned) => {
                    poisoned.into_inner().remove(&self.public_key);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod profile_identity_platform {
    use std::{ffi::OsStr, iter, os::windows::ffi::OsStrExt, ptr};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
        System::Threading::CreateMutexW,
    };

    use super::profile_identity_lock_name;

    pub(super) struct Guard {
        mutex: usize,
    }

    unsafe impl Send for Guard {}
    unsafe impl Sync for Guard {}

    impl Guard {
        pub(super) fn acquire(public_key: &str) -> Result<Self, String> {
            let name = format!(
                "Local\\Kaigen.ToxProfileIdentity.{}",
                profile_identity_lock_name(public_key)
            );
            let wide = OsStr::new(&name)
                .encode_wide()
                .chain(iter::once(0))
                .collect::<Vec<_>>();
            let mutex = unsafe { CreateMutexW(ptr::null(), 0, wide.as_ptr()) };
            if mutex.is_null() {
                return Err(format!(
                    "Could not create the Tox profile identity mutex: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                unsafe { CloseHandle(mutex) };
                return Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string());
            }
            Ok(Self {
                mutex: mutex as usize,
            })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.mutex as HANDLE) };
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod profile_identity_platform {
    use std::{fs::OpenOptions, io::ErrorKind, os::fd::AsRawFd, path::PathBuf};

    use super::profile_identity_lock_name;

    pub(super) struct Guard {
        lock: std::fs::File,
    }

    impl Guard {
        pub(super) fn acquire(public_key: &str) -> Result<Self, String> {
            let directory: PathBuf = std::env::temp_dir().join("kaigen-profile-identities");
            std::fs::create_dir_all(&directory).map_err(|error| {
                format!("Could not create the Tox identity lock directory: {error}")
            })?;
            let path = directory.join(format!("{}.lock", profile_identity_lock_name(public_key)));
            let lock = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| format!("Could not open the Tox identity lock: {error}"))?;
            let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(Self { lock });
            }
            let error = std::io::Error::last_os_error();
            match error.kind() {
                ErrorKind::WouldBlock => Err("TOX_PROFILE_IDENTITY_ALREADY_LOADED".to_string()),
                _ => Err(format!("Could not lock the Tox profile identity: {error}")),
            }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe { libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::{ffi::OsStr, iter, os::windows::ffi::OsStrExt, ptr, thread};

    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0},
        System::Threading::{CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject, INFINITE},
    };

    use super::{instance_key_for_root, portable_root_for_current_executable, InstanceOutcome};

    pub struct InstanceGuard {
        mutex: usize,
        activation_event: usize,
    }

    // Win32 kernel handles may be waited on and closed from another thread.
    unsafe impl Send for InstanceGuard {}
    unsafe impl Sync for InstanceGuard {}

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(iter::once(0))
            .collect()
    }

    impl InstanceGuard {
        pub fn acquire_for_current_executable() -> Result<InstanceOutcome, String> {
            let root = portable_root_for_current_executable()?;
            let key = instance_key_for_root(&root);
            let mutex_name = wide(&format!("Local\\Kaigen.Instance.{key}"));
            let event_name = wide(&format!("Local\\Kaigen.Activate.{key}"));

            let mutex = unsafe { CreateMutexW(ptr::null(), 0, mutex_name.as_ptr()) };
            if mutex.is_null() {
                return Err(format!(
                    "Could not create the Kaigen instance mutex: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let already_running = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            let activation_event = unsafe { CreateEventW(ptr::null(), 0, 0, event_name.as_ptr()) };
            if activation_event.is_null() {
                unsafe {
                    CloseHandle(mutex);
                }
                return Err(format!(
                    "Could not create the Kaigen activation event: {}",
                    std::io::Error::last_os_error()
                ));
            }

            if already_running {
                unsafe {
                    let _ = SetEvent(activation_event);
                    CloseHandle(activation_event);
                    CloseHandle(mutex);
                }
                return Ok(InstanceOutcome::SecondaryActivated);
            }

            Ok(InstanceOutcome::Primary(Self {
                mutex: mutex as usize,
                activation_event: activation_event as usize,
            }))
        }

        pub fn start_activation_listener(&self, app: tauri::AppHandle) {
            let activation_event = self.activation_event;
            thread::spawn(move || loop {
                let result = unsafe { WaitForSingleObject(activation_event as HANDLE, INFINITE) };
                if result != WAIT_OBJECT_0 {
                    return;
                }
                let Some(window) = app.get_webview_window("main") else {
                    return;
                };
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            });
        }
    }

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.activation_event as HANDLE);
                CloseHandle(self.mutex as HANDLE);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use std::{fs::OpenOptions, io::ErrorKind, os::fd::AsRawFd};

    #[cfg(target_os = "macos")]
    use super::macos_portable;
    use super::{portable_instance_error, portable_root_for_current_executable, InstanceOutcome};

    pub struct InstanceGuard {
        lock: std::fs::File,
    }

    impl InstanceGuard {
        pub fn acquire_for_current_executable() -> Result<InstanceOutcome, String> {
            let root = portable_root_for_current_executable()?;
            let data_dir = root.join("data");
            if let Err(error) = std::fs::create_dir_all(&data_dir) {
                #[cfg(target_os = "macos")]
                if macos_portable::install_and_relaunch(&root)? {
                    return Ok(InstanceOutcome::SecondaryActivated);
                }
                return Err(portable_instance_error(
                    "Could not create portable instance directory",
                    &data_dir,
                    &error,
                ));
            }
            let lock_path = data_dir.join(".kaigen-instance.lock");
            let lock = match OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(&lock_path)
            {
                Ok(lock) => lock,
                Err(error) => {
                    #[cfg(target_os = "macos")]
                    if macos_portable::install_and_relaunch(&root)? {
                        return Ok(InstanceOutcome::SecondaryActivated);
                    }
                    return Err(portable_instance_error(
                        "Could not open portable instance lock",
                        &lock_path,
                        &error,
                    ));
                }
            };
            let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(InstanceOutcome::Primary(Self { lock }));
            }
            let error = std::io::Error::last_os_error();
            match error.kind() {
                ErrorKind::WouldBlock => Ok(InstanceOutcome::SecondaryActivated),
                _ => {
                    #[cfg(target_os = "macos")]
                    if macos_portable::install_and_relaunch(&root)? {
                        return Ok(InstanceOutcome::SecondaryActivated);
                    }
                    Err(portable_instance_error(
                        "Could not lock portable Kaigen directory",
                        &root,
                        &error,
                    ))
                }
            }
        }

        pub fn start_activation_listener(&self, _app: tauri::AppHandle) {}
    }

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            unsafe {
                libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

pub use platform::InstanceGuard;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_key_is_shared_by_executables_in_one_portable_directory() {
        let root = Path::new(r"C:\Portable\Kaigen");
        assert_eq!(instance_key_for_root(root), instance_key_for_root(root));
        assert_eq!(
            instance_key_for_root(Path::new(r"C:\PORTABLE\KAIGEN")),
            instance_key_for_root(root)
        );
    }

    #[test]
    fn different_portable_directories_have_independent_instances() {
        assert_ne!(
            instance_key_for_root(Path::new(r"C:\Portable\Kaigen-A")),
            instance_key_for_root(Path::new(r"C:\Portable\Kaigen-B"))
        );
    }

    #[test]
    fn duplicate_tox_identity_is_exclusive_and_released_on_drop() {
        let alice = "A".repeat(64);
        let bob = "B".repeat(64);
        let first = ProfileIdentityGuard::acquire(&alice).unwrap();
        assert_eq!(
            ProfileIdentityGuard::acquire(&alice).err().as_deref(),
            Some("TOX_PROFILE_IDENTITY_ALREADY_LOADED")
        );
        let different = ProfileIdentityGuard::acquire(&bob).unwrap();
        drop(different);
        drop(first);
        let reacquired = ProfileIdentityGuard::acquire(&alice).unwrap();
        drop(reacquired);
    }

    #[test]
    fn concurrent_identity_admission_has_exactly_one_winner() {
        use std::sync::{mpsc, Arc, Barrier};

        let public_key = "C".repeat(64);
        let start = Arc::new(Barrier::new(3));
        let release = Arc::new(Barrier::new(2));
        let (sender, receiver) = mpsc::channel();
        let workers = (0..2)
            .map(|_| {
                let public_key = public_key.clone();
                let start = Arc::clone(&start);
                let release = Arc::clone(&release);
                let sender = sender.clone();
                std::thread::spawn(move || {
                    start.wait();
                    let reservation = ProfileIdentityGuard::acquire(&public_key);
                    sender.send(reservation.is_ok()).unwrap();
                    if let Ok(reservation) = reservation {
                        release.wait();
                        drop(reservation);
                    }
                })
            })
            .collect::<Vec<_>>();
        drop(sender);
        start.wait();
        let winners = [receiver.recv().unwrap(), receiver.recv().unwrap()]
            .into_iter()
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
        release.wait();
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn profile_identity_lock_child() {
        use std::io::{self, Write};

        if std::env::var_os("KAIGEN_IDENTITY_LOCK_CHILD").is_none() {
            return;
        }
        let reservation = ProfileIdentityGuard::acquire(&"D".repeat(64)).unwrap();
        println!("KAIGEN_IDENTITY_LOCK_READY");
        io::stdout().flush().unwrap();
        let mut release = String::new();
        io::stdin().read_line(&mut release).unwrap();
        drop(reservation);
    }

    #[test]
    fn copied_identity_is_exclusive_across_processes() {
        use std::{
            io::{BufRead, BufReader, Write},
            process::{Command, Stdio},
        };

        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "instance::tests::profile_identity_lock_child",
                "--nocapture",
            ])
            .env("KAIGEN_IDENTITY_LOCK_CHILD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line.contains("KAIGEN_IDENTITY_LOCK_READY") {
                break;
            }
        }
        assert_eq!(
            ProfileIdentityGuard::acquire(&"D".repeat(64))
                .err()
                .as_deref(),
            Some("TOX_PROFILE_IDENTITY_ALREADY_LOADED")
        );
        child.stdin.take().unwrap().write_all(b"release\n").unwrap();
        assert!(child.wait().unwrap().success());
        let reacquired = ProfileIdentityGuard::acquire(&"D".repeat(64)).unwrap();
        drop(reacquired);
    }

    #[test]
    fn malformed_tox_identity_never_creates_a_machine_lock() {
        assert_eq!(
            ProfileIdentityGuard::acquire("not-a-public-key")
                .err()
                .as_deref(),
            Some("TOX_PROFILE_IDENTITY_INVALID")
        );
    }

    #[test]
    fn macos_bundle_uses_a_writable_sibling_portable_directory() {
        let executable = Path::new("/Applications/Kaigen.app/Contents/MacOS/Kaigen");
        assert_eq!(
            macos_bundle_parent(executable),
            Some(PathBuf::from("/Applications/Kaigen-portable-data"))
        );
    }

    #[test]
    fn macos_portable_error_explains_the_required_copy_step() {
        let error = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let message = portable_instance_error(
            "Could not open portable instance lock",
            Path::new("/Volumes/Kaigen Portable/Kaigen-portable-data/data/.kaigen-instance.lock"),
            &error,
        );
        if cfg!(target_os = "macos") {
            assert!(message.contains("could not prepare its writable portable installation"));
            assert!(message.contains("Existing portable data was not changed"));
        }
    }

    #[test]
    fn macos_dmg_bootstrap_targets_the_user_applications_portable_folder() {
        let executable =
            Path::new("/Volumes/Kaigen/Kaigen-portable/Kaigen.app/Contents/MacOS/Kaigen");
        let layout = macos_portable::layout(executable, Path::new("/Users/alice")).unwrap();
        assert_eq!(
            layout.source_dir,
            PathBuf::from("/Volumes/Kaigen/Kaigen-portable")
        );
        assert_eq!(
            layout.source_data,
            PathBuf::from("/Volumes/Kaigen/Kaigen-portable/Kaigen-portable-data")
        );
        assert_eq!(
            layout.destination_dir,
            PathBuf::from("/Users/alice/Applications/Kaigen-portable")
        );
        assert_eq!(
            layout.destination_app,
            PathBuf::from("/Users/alice/Applications/Kaigen-portable/Kaigen.app")
        );
    }

    #[test]
    fn macos_dmg_bootstrap_rejects_a_legacy_executable_name() {
        let error = macos_portable::layout(
            Path::new("/Volumes/Kaigen/Kaigen-portable/Kaigen.app/Contents/MacOS/tox-pq-client"),
            Path::new("/Users/alice"),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "The macOS application executable is not named Kaigen"
        );
    }

    #[test]
    fn macos_dmg_bootstrap_never_copies_an_arbitrary_app_parent() {
        let error = macos_portable::layout(
            Path::new("/Applications/Kaigen.app/Contents/MacOS/Kaigen"),
            Path::new("/Users/alice"),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "Automatic macOS installation requires the complete Kaigen-portable folder"
        );
    }

    #[test]
    fn macos_existing_portable_installation_is_validated_without_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "kaigen-macos-portable-layout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app_executable = root
            .join("Kaigen.app")
            .join("Contents")
            .join("MacOS")
            .join("Kaigen");
        std::fs::create_dir_all(app_executable.parent().unwrap()).unwrap();
        std::fs::write(&app_executable, b"test").unwrap();
        let existing_data = root.join("Kaigen-portable-data").join("profile.tox");
        std::fs::create_dir_all(existing_data.parent().unwrap()).unwrap();
        std::fs::write(&existing_data, b"existing-profile-must-not-change").unwrap();
        assert_eq!(macos_portable::validate_portable_dir(&root), Ok(()));
        assert_eq!(
            std::fs::read(&existing_data).unwrap(),
            b"existing-profile-must-not-change"
        );

        let interrupted = root.join(".kaigen-auto-install-incomplete");
        std::fs::write(&interrupted, b"incomplete").unwrap();
        assert!(macos_portable::validate_portable_dir(&root)
            .unwrap_err()
            .contains("Refusing to overwrite interrupted portable installation"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
