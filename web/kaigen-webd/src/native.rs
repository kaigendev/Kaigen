//! Safe access to the Unix calls required by the daemon.

use std::{mem::MaybeUninit, ptr};

extern "C" fn shutdown_signal(_signal: libc::c_int) {
    // Keep the handler signal-safe. request_shutdown only stores to an atomic.
    crate::request_shutdown();
}

/// Installs both process handlers at startup and restores SIGTERM if SIGINT fails.
pub(super) fn install_shutdown_signals() -> Result<(), &'static str> {
    const REGISTRATION_FAILED: &str = "WEB_SHUTDOWN_SIGNAL_REGISTRATION_FAILED";

    // SAFETY: libc's sigaction uses C integer and mask fields on our Unix targets.
    // Initialize the mask before passing the action to the kernel. The handler
    // has the expected C ABI and only performs a lock-free atomic store.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = shutdown_signal as *const () as usize;
        action.sa_flags = libc::SA_RESTART;
        if libc::sigemptyset(&mut action.sa_mask) != 0 {
            return Err(REGISTRATION_FAILED);
        }

        let mut previous = MaybeUninit::<libc::sigaction>::uninit();
        if libc::sigaction(libc::SIGTERM, &action, previous.as_mut_ptr()) != 0 {
            return Err(REGISTRATION_FAILED);
        }
        if libc::sigaction(libc::SIGINT, &action, ptr::null_mut()) != 0 {
            // The successful SIGTERM call wrote the previous action in full.
            if libc::sigaction(libc::SIGTERM, previous.as_ptr(), ptr::null_mut()) != 0 {
                return Err("WEB_SHUTDOWN_SIGNAL_RESTORE_FAILED");
            }
            return Err(REGISTRATION_FAILED);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
/// Returns blocks available to unprivileged callers as a percentage of total blocks.
pub(super) fn disk_available_percent(path: &std::path::Path) -> Option<f64> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: The path is NUL-terminated and the output is writable and aligned.
    // The output is read only when statvfs reports successful initialization.
    let stats = unsafe {
        if libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) != 0 {
            return None;
        }
        stats.assume_init()
    };
    (stats.f_blocks != 0).then(|| stats.f_bavail as f64 * 100.0 / stats.f_blocks as f64)
}
