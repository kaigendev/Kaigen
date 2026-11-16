//! Exact parent lifetime checks, linked only by the independent helper.
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(super) struct Parent {
    #[cfg(windows)]
    process: super::platform::windows_process::Process,
    #[cfg(unix)]
    pid: u32,
    #[cfg(unix)]
    identity: u64,
}

impl Parent {
    pub(super) fn open(pid: u32, expected: &Path, identity: u64) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let process = super::platform::windows_process::Process::open(pid)?;
            if process.path()? != expected || process.identity()? != identity {
                return Err("UPDATE_PARENT_IDENTITY_CHANGED".into());
            }
            Ok(Self { process })
        }
        #[cfg(unix)]
        {
            if unsafe { libc::getppid() } as u32 != pid
                || super::platform::process_identity(pid)? != identity
            {
                return Err("UPDATE_PARENT_IDENTITY_CHANGED".into());
            }
            let _ = expected;
            Ok(Self { pid, identity })
        }
    }
    pub(super) fn wait(self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        #[cfg(windows)]
        {
            use windows_sys::Win32::{
                Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::{GetExitCodeProcess, WaitForSingleObject},
            };
            loop {
                match unsafe { WaitForSingleObject(self.process.0, 500) } {
                    WAIT_OBJECT_0 => {
                        let mut code = 1;
                        if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == 0
                            || code != 0
                        {
                            return Err("UPDATE_PARENT_EXIT_FAILED".into());
                        }
                        return Ok(());
                    }
                    WAIT_TIMEOUT if Instant::now() < deadline => {}
                    WAIT_TIMEOUT => return Err("UPDATE_PARENT_EXIT_TIMEOUT".into()),
                    _ => return Err("UPDATE_PARENT_UNAVAILABLE".into()),
                }
            }
        }
        #[cfg(unix)]
        {
            loop {
                if unsafe { libc::kill(self.pid as libc::pid_t, 0) } != 0
                    || super::platform::process_identity(self.pid).ok() != Some(self.identity)
                {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err("UPDATE_PARENT_EXIT_TIMEOUT".into());
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}
