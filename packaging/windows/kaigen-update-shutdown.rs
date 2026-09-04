#![windows_subsystem = "windows"]

use std::{
    collections::BTreeSet,
    env,
    ffi::{c_void, OsStr, OsString},
    fs,
    mem::{size_of, zeroed},
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::Path,
    thread,
    time::Duration,
};

type Bool = i32;
type Dword = u32;
type Handle = *mut c_void;
type Hwnd = *mut c_void;

const FALSE: Bool = 0;
const TRUE: Bool = 1;
const TH32CS_SNAPPROCESS: Dword = 0x0000_0002;
const PROCESS_SYNCHRONIZE: Dword = 0x0010_0000;
const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x0000_1000;
const EVENT_MODIFY_STATE: Dword = 0x0000_0002;
const WAIT_OBJECT_0: Dword = 0x0000_0000;
const WAIT_TIMEOUT: Dword = 0x0000_0102;
const WM_CLOSE: Dword = 0x0010;
const WM_QUIT: Dword = 0x0012;
const MAX_PATH: usize = 260;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

#[repr(C)]
struct ProcessEntry32W {
    size: Dword,
    usage: Dword,
    process_id: Dword,
    default_heap_id: usize,
    module_id: Dword,
    threads: Dword,
    parent_process_id: Dword,
    base_priority: i32,
    flags: Dword,
    executable_name: [u16; MAX_PATH],
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(object: Handle) -> Bool;
    fn CreateToolhelp32Snapshot(flags: Dword, process_id: Dword) -> Handle;
    fn GetCurrentProcessId() -> Dword;
    fn OpenEventW(desired_access: Dword, inherit_handle: Bool, name: *const u16) -> Handle;
    fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
    fn ProcessIdToSessionId(process_id: Dword, session_id: *mut Dword) -> Bool;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: Dword,
        image_name: *mut u16,
        size: *mut Dword,
    ) -> Bool;
    fn SetEvent(event: Handle) -> Bool;
    fn WaitForSingleObject(object: Handle, milliseconds: Dword) -> Dword;
}

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(
        callback: Option<unsafe extern "system" fn(Hwnd, isize) -> Bool>,
        data: isize,
    ) -> Bool;
    fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut Dword) -> Dword;
    fn PostMessageW(window: Hwnd, message: Dword, wparam: usize, lparam: isize) -> Bool;
    fn PostThreadMessageW(thread_id: Dword, message: Dword, wparam: usize, lparam: isize) -> Bool;
}

struct OwnedHandle(Handle);

impl OwnedHandle {
    fn new(handle: Handle) -> Option<Self> {
        (!handle.is_null() && handle != INVALID_HANDLE_VALUE).then_some(Self(handle))
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct MatchingProcess {
    id: Dword,
    handle: OwnedHandle,
}

#[derive(Default)]
struct ProcessWindows {
    process_id: Dword,
    windows: Vec<Hwnd>,
    threads: BTreeSet<Dword>,
}

unsafe extern "system" fn collect_process_windows(window: Hwnd, data: isize) -> Bool {
    let context = unsafe { &mut *(data as *mut ProcessWindows) };
    let mut process_id = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(window, &mut process_id) };
    if process_id == context.process_id && thread_id != 0 {
        context.windows.push(window);
        context.threads.insert(thread_id);
    }
    TRUE
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn normalized_path(path: &Path) -> String {
    let absolute = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = absolute.to_string_lossy().replace('/', "\\");
    let ascii_lowercase = value.to_ascii_lowercase();
    let value = if ascii_lowercase.starts_with("\\\\?\\unc\\") {
        format!("\\\\{}", &value[8..])
    } else if ascii_lowercase.starts_with("\\\\?\\") {
        value[4..].to_string()
    } else {
        value
    };
    value.trim_end_matches('\\').to_lowercase()
}

fn process_image_path(process: Handle) -> Option<OsString> {
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as Dword;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == FALSE
    {
        return None;
    }
    Some(OsString::from_wide(&buffer[..length as usize]))
}

fn same_session(process_id: Dword, current_session: Dword) -> bool {
    let mut session = 0;
    (unsafe { ProcessIdToSessionId(process_id, &mut session) }) != FALSE
        && session == current_session
}

fn matching_processes(target: &Path) -> Result<Vec<MatchingProcess>, String> {
    let mut current_session = 0;
    if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session) } == FALSE {
        return Err("could not resolve the installer session".to_string());
    }

    let snapshot = OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })
        .ok_or_else(|| "could not enumerate running processes".to_string())?;
    let mut entry: ProcessEntry32W = unsafe { zeroed() };
    entry.size = size_of::<ProcessEntry32W>() as Dword;
    let mut has_entry = unsafe { Process32FirstW(snapshot.0, &mut entry) } != FALSE;
    let target = normalized_path(target);
    let mut matches = Vec::new();

    while has_entry {
        let name_length = entry
            .executable_name
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(entry.executable_name.len());
        let name = OsString::from_wide(&entry.executable_name[..name_length]);
        if name.to_string_lossy().eq_ignore_ascii_case("Kaigen.exe")
            && same_session(entry.process_id, current_session)
        {
            if let Some(handle) = OwnedHandle::new(unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    FALSE,
                    entry.process_id,
                )
            }) {
                if process_image_path(handle.0)
                    .as_deref()
                    .is_some_and(|path| normalized_path(Path::new(path)) == target)
                {
                    matches.push(MatchingProcess {
                        id: entry.process_id,
                        handle,
                    });
                }
            }
        }
        has_entry = unsafe { Process32NextW(snapshot.0, &mut entry) } != FALSE;
    }
    Ok(matches)
}

fn wait_for_exit(process: Handle, milliseconds: Dword) -> Result<bool, String> {
    match unsafe { WaitForSingleObject(process, milliseconds) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        code => Err(format!("process wait failed with status 0x{code:08x}")),
    }
}

fn request_named_shutdown(process_id: Dword) -> bool {
    let name = wide(OsStr::new(&format!(
        "Local\\Kaigen.UpdateShutdown.{process_id}"
    )));
    let Some(event) =
        OwnedHandle::new(unsafe { OpenEventW(EVENT_MODIFY_STATE, FALSE, name.as_ptr()) })
    else {
        return false;
    };
    (unsafe { SetEvent(event.0) }) != FALSE
}

fn collect_windows(process_id: Dword) -> Result<ProcessWindows, String> {
    let mut context = ProcessWindows {
        process_id,
        ..ProcessWindows::default()
    };
    if unsafe {
        EnumWindows(
            Some(collect_process_windows),
            &mut context as *mut ProcessWindows as isize,
        )
    } == FALSE
    {
        return Err(format!(
            "could not enumerate windows for Kaigen process {process_id}"
        ));
    }
    Ok(context)
}

fn gracefully_stop(process: &MatchingProcess) -> Result<(), String> {
    if request_named_shutdown(process.id) {
        if wait_for_exit(process.handle.0, 60_000)? {
            return Ok(());
        }
        return Err(format!(
            "Kaigen process {} accepted the update shutdown request but did not finish before the timeout",
            process.id
        ));
    }

    let windows = collect_windows(process.id)?;
    if windows.windows.is_empty() || windows.threads.is_empty() {
        return Err(format!(
            "Kaigen process {} has no same-session top-level window for graceful shutdown",
            process.id
        ));
    }

    for window in &windows.windows {
        unsafe {
            PostMessageW(*window, WM_CLOSE, 0, 0);
        }
    }
    if wait_for_exit(process.handle.0, 5_000)? {
        return Ok(());
    }

    let mut posted = false;
    for thread_id in windows.threads {
        posted |= unsafe { PostThreadMessageW(thread_id, WM_QUIT, 0, 0) } != FALSE;
    }
    if !posted {
        return Err(format!(
            "could not request event-loop shutdown for Kaigen process {}",
            process.id
        ));
    }
    if !wait_for_exit(process.handle.0, 60_000)? {
        return Err(format!(
            "Kaigen process {} did not finish its graceful shutdown before the timeout",
            process.id
        ));
    }
    thread::sleep(Duration::from_millis(500));
    Ok(())
}

fn run() -> Result<(), String> {
    let target = env::args_os()
        .nth(1)
        .ok_or_else(|| "the exact installed Kaigen.exe path is required".to_string())?;
    let target = Path::new(&target);
    for process in matching_processes(target)? {
        gracefully_stop(&process)?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Kaigen update shutdown failed: {error}");
        std::process::exit(1);
    }
}
