//! Narrow OS primitives shared by the app coordinator and the standalone helper.
#[cfg(windows)]
use std::path::PathBuf;
use std::{
    fs,
    path::Path,
    process::{Child, Command},
};

pub(super) fn spawn(command: &mut Command) -> Result<Child, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|_| "UPDATE_PROCESS_START_FAILED".into())
}

pub(super) fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    replace_file_io(source, destination).map_err(|_| "UPDATE_RENAME_FAILED".into())
}

pub(super) fn replace_file_io(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Both buffers remain alive and are NUL-terminated for this call.
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}

pub(super) fn create_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::{os::windows::ffi::OsStrExt, ptr};
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SECURITY_ATTRIBUTES,
            },
            Storage::FileSystem::CreateDirectoryW,
        };
        let sddl: Vec<u16> = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        // Protected owner/SYSTEM DACL: the public portable parent grants no
        // inherited access to downloaded code or the executable transaction.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err("UPDATE_PRIVATE_DIRECTORY_FAILED".into());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let success = unsafe { CreateDirectoryW(name.as_ptr(), &attributes) };
        unsafe {
            LocalFree(descriptor);
        }
        if success == 0 {
            Err("UPDATE_LOCATION_NOT_WRITABLE".into())
        } else {
            Ok(())
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| "UPDATE_LOCATION_NOT_WRITABLE".into())
    }
}

#[cfg(windows)]
pub(super) mod windows_process {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };

    pub(crate) struct Process(pub(crate) HANDLE);
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Process {
        pub(crate) fn open(pid: u32) -> Result<Self, String> {
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                Err("UPDATE_PARENT_UNAVAILABLE".into())
            } else {
                Ok(Self(handle))
            }
        }
        pub(crate) fn path(&self) -> Result<PathBuf, String> {
            let mut buffer = vec![0u16; 32768];
            let mut length = buffer.len() as u32;
            if unsafe { QueryFullProcessImageNameW(self.0, 0, buffer.as_mut_ptr(), &mut length) }
                == 0
            {
                return Err("UPDATE_PROCESS_CHECK_FAILED".into());
            }
            fs::canonicalize(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..length as usize],
            )))
            .map_err(|_| "UPDATE_PROCESS_CHECK_FAILED".into())
        }
        pub(crate) fn identity(&self) -> Result<u64, String> {
            let mut created = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let mut exited = created;
            let mut kernel = created;
            let mut user = created;
            if unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) }
                == 0
            {
                return Err("UPDATE_PARENT_UNAVAILABLE".into());
            }
            Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
        }
    }
    pub(super) fn identity(pid: u32) -> Result<u64, String> {
        Process::open(pid)?.identity()
    }
    pub(super) fn others(expected: &Path, ignore: u32) -> Result<bool, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("UPDATE_PROCESS_CHECK_FAILED".into());
        }
        let snapshot = Process(snapshot);
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut success = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        let basename = expected
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("UPDATE_LOCATION_INVALID")?;
        while success != 0 {
            let name = String::from_utf16_lossy(
                &entry.szExeFile[..entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len())],
            );
            if entry.th32ProcessID != ignore
                && entry.th32ProcessID != std::process::id()
                && name.eq_ignore_ascii_case(basename)
            {
                let process = Process::open(entry.th32ProcessID)
                    .map_err(|_| "UPDATE_OTHER_INSTANCE_ACTIVE")?;
                if process.path()? == expected {
                    return Ok(true);
                }
            }
            success = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        Ok(false)
    }
}

pub(super) fn process_identity(pid: u32) -> Result<u64, String> {
    #[cfg(windows)]
    {
        windows_process::identity(pid)
    }
    #[cfg(target_os = "linux")]
    {
        let text = fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_err(|_| "UPDATE_PARENT_UNAVAILABLE")?;
        text.rsplit_once(')')
            .and_then(|(_, tail)| tail.split_whitespace().nth(19))
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| "UPDATE_PARENT_UNAVAILABLE".into())
    }
    #[cfg(target_os = "macos")]
    {
        if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
            Err("UPDATE_PARENT_UNAVAILABLE".into())
        } else {
            Ok(u64::from(pid))
        }
    }
}

pub(super) fn other_instances(executable: &Path, ignore: u32) -> Result<bool, String> {
    #[cfg(windows)]
    {
        windows_process::others(executable, ignore)
    }
    #[cfg(target_os = "linux")]
    {
        // Replacing the single immutable AppImage preserves existing mounted/open
        // images; other roots keep running their old image without being closed.
        let _ = (executable, ignore);
        Ok(false)
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn proc_listpids(kind: u32, info: u32, buffer: *mut libc::c_void, size: i32) -> i32;
            fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
        }
        let mut pids = vec![0i32; 65536];
        let bytes =
            unsafe { proc_listpids(1, 0, pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
        if bytes <= 0 || bytes as usize >= pids.len() * 4 {
            return Err("UPDATE_PROCESS_CHECK_FAILED".into());
        }
        for pid in pids
            .into_iter()
            .take(bytes as usize / 4)
            .filter(|pid| *pid > 0 && *pid as u32 != ignore && *pid as u32 != std::process::id())
        {
            let mut buffer = [0u8; 4096];
            let length =
                unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
            if length > 0 {
                let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
                if let Ok(path) = std::str::from_utf8(&buffer[..end]) {
                    if fs::canonicalize(path).ok().as_deref() == Some(executable) {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }
}

#[cfg(windows)]
pub(super) fn msi_directory() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key: Vec<u16> = "Software\\Kaigen\\Installer"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = "InstallFolder".encode_utf16().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 32768];
    let mut size = (buffer.len() * 2) as u32;
    if unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
    {
        return None;
    }
    let end = buffer.iter().position(|c| *c == 0)?;
    use std::os::windows::ffi::OsStringExt;
    Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..end])))
}
