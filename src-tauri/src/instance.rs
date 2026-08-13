use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub enum InstanceOutcome {
    Primary(InstanceGuard),
    SecondaryActivated,
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

    use super::{portable_root_for_current_executable, InstanceOutcome};

    pub struct InstanceGuard {
        lock: std::fs::File,
    }

    impl InstanceGuard {
        pub fn acquire_for_current_executable() -> Result<InstanceOutcome, String> {
            let root = portable_root_for_current_executable()?;
            let data_dir = root.join("data");
            std::fs::create_dir_all(&data_dir).map_err(|error| {
                format!(
                    "Could not create portable instance directory {}: {error}",
                    data_dir.display()
                )
            })?;
            let lock_path = data_dir.join(".kaigen-instance.lock");
            let lock = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|error| {
                    format!(
                        "Could not open portable instance lock {}: {error}",
                        lock_path.display()
                    )
                })?;
            let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(InstanceOutcome::Primary(Self { lock }));
            }
            let error = std::io::Error::last_os_error();
            match error.kind() {
                ErrorKind::WouldBlock => Ok(InstanceOutcome::SecondaryActivated),
                _ => Err(format!(
                    "Could not lock portable Kaigen directory {}: {error}",
                    root.display()
                )),
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
    fn macos_bundle_uses_a_writable_sibling_portable_directory() {
        let executable = Path::new("/Applications/Kaigen.app/Contents/MacOS/Kaigen");
        assert_eq!(
            macos_bundle_parent(executable),
            Some(PathBuf::from("/Applications/Kaigen-portable-data"))
        );
    }
}
