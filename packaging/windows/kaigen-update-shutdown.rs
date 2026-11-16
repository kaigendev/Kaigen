#![windows_subsystem = "windows"]

use std::{
    collections::BTreeSet,
    env,
    ffi::{c_void, OsStr, OsString},
    fs,
    mem::size_of,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
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

impl ProcessEntry32W {
    /// Supplies the initialized, size-tagged buffer required by Toolhelp.
    fn new() -> Self {
        Self {
            size: size_of::<Self>() as Dword,
            usage: 0,
            process_id: 0,
            default_heap_id: 0,
            module_id: 0,
            threads: 0,
            parent_process_id: 0,
            base_priority: 0,
            flags: 0,
            executable_name: [0; MAX_PATH],
        }
    }
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: Dword, process_id: Dword) -> Handle;
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
unsafe extern "system" {
    fn EnumWindows(
        callback: Option<unsafe extern "system" fn(Hwnd, isize) -> Bool>,
        data: isize,
    ) -> Bool;
    fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut Dword) -> Dword;
    fn PostMessageW(window: Hwnd, message: Dword, wparam: usize, lparam: isize) -> Bool;
    fn PostThreadMessageW(thread_id: Dword, message: Dword, wparam: usize, lparam: isize) -> Bool;
}

/// Adopts one newly acquired Win32 handle if the native call succeeded.
///
/// # Safety
///
/// A successful handle must be owned by the caller and closable with CloseHandle.
unsafe fn take_owned_handle(handle: Handle) -> Option<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }
    // SAFETY: The caller transferred the successful native handle.
    Some(unsafe { OwnedHandle::from_raw_handle(handle) })
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
    // SAFETY: EnumWindows is synchronous and passes our live context unchanged.
    let context =
        unsafe { &mut *std::ptr::with_exposed_provenance_mut::<ProcessWindows>(data as usize) };
    let mut process_id = 0;
    // SAFETY: This callback receives a native HWND and owns the output variable.
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

fn process_image_path(process: &OwnedHandle) -> Option<OsString> {
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as Dword;
    // SAFETY: The process handle is live and length is the writable buffer size.
    if unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut length)
    } == FALSE
    {
        return None;
    }
    buffer.get(..length as usize).map(OsString::from_wide)
}

fn process_session(process_id: Dword) -> Option<Dword> {
    let mut session = 0;
    // SAFETY: Win32 receives a process ID and a live output variable.
    (unsafe { ProcessIdToSessionId(process_id, &mut session) } != FALSE).then_some(session)
}

struct ProcessSnapshot {
    handle: OwnedHandle,
    entry: ProcessEntry32W,
    first: bool,
}

impl ProcessSnapshot {
    fn open() -> Result<Self, String> {
        // SAFETY: Toolhelp returns an owned snapshot or its documented sentinel.
        let handle = unsafe { take_owned_handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)) }
            .ok_or_else(|| "could not enumerate running processes".to_string())?;
        Ok(Self {
            handle,
            entry: ProcessEntry32W::new(),
            first: true,
        })
    }

    /// Borrows the initialized entry until the next snapshot step.
    fn next(&mut self) -> Option<&ProcessEntry32W> {
        // SAFETY: The snapshot handle is live and the initialized buffer
        // remains exclusive and correctly sized for both Toolhelp calls.
        let has_entry = unsafe {
            if std::mem::take(&mut self.first) {
                Process32FirstW(self.handle.as_raw_handle(), &mut self.entry)
            } else {
                Process32NextW(self.handle.as_raw_handle(), &mut self.entry)
            }
        };
        (has_entry != FALSE).then_some(&self.entry)
    }
}

impl MatchingProcess {
    fn open(id: Dword) -> Option<Self> {
        // SAFETY: OpenProcess returns one owned process handle or null.
        let handle = unsafe {
            take_owned_handle(OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                FALSE,
                id,
            ))
        }?;
        Some(Self { id, handle })
    }
}

fn matching_processes(target: &Path) -> Result<Vec<MatchingProcess>, String> {
    let current_session = process_session(std::process::id())
        .ok_or_else(|| "could not resolve the installer session".to_string())?;
    let mut snapshot = ProcessSnapshot::open()?;
    let target = normalized_path(target);
    let mut matches = Vec::new();

    while let Some(entry) = snapshot.next() {
        let name_length = entry
            .executable_name
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(entry.executable_name.len());
        let name = OsString::from_wide(&entry.executable_name[..name_length]);
        if name.to_string_lossy().eq_ignore_ascii_case("Kaigen.exe")
            && process_session(entry.process_id) == Some(current_session)
        {
            if let Some(process) = MatchingProcess::open(entry.process_id) {
                if process_image_path(&process.handle)
                    .as_deref()
                    .is_some_and(|path| normalized_path(Path::new(path)) == target)
                {
                    matches.push(process);
                }
            }
        }
    }
    Ok(matches)
}

fn wait_for_exit(process: &OwnedHandle, milliseconds: Dword) -> Result<bool, String> {
    // SAFETY: The owned process handle stays open throughout the wait.
    match unsafe { WaitForSingleObject(process.as_raw_handle(), milliseconds) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        code => Err(format!("process wait failed with status 0x{code:08x}")),
    }
}

fn request_named_shutdown(process_id: Dword) -> bool {
    let name = wide(OsStr::new(&format!(
        "Local\\Kaigen.UpdateShutdown.{process_id}"
    )));
    // SAFETY: name is NUL-terminated. OpenEventW returns an owned handle or null.
    let Some(event) =
        (unsafe { take_owned_handle(OpenEventW(EVENT_MODIFY_STATE, FALSE, name.as_ptr())) })
    else {
        return false;
    };
    // SAFETY: The owned event has EVENT_MODIFY_STATE access.
    (unsafe { SetEvent(event.as_raw_handle()) }) != FALSE
}

fn collect_windows(process_id: Dword) -> Result<ProcessWindows, String> {
    let mut context = ProcessWindows {
        process_id,
        ..ProcessWindows::default()
    };
    // SAFETY: EnumWindows invokes our callback synchronously and never retains
    // the exclusive context pointer after returning.
    if unsafe {
        EnumWindows(
            Some(collect_process_windows),
            std::ptr::from_mut(&mut context).expose_provenance() as isize,
        )
    } == FALSE
    {
        return Err(format!(
            "could not enumerate windows for Kaigen process {process_id}"
        ));
    }
    Ok(context)
}

impl ProcessWindows {
    fn post_close(&self) {
        for &window in &self.windows {
            // SAFETY: WM_CLOSE has scalar parameters and needs no borrowed buffer.
            let _ = unsafe { PostMessageW(window, WM_CLOSE, 0, 0) };
        }
    }

    fn post_quit(&self) -> bool {
        let mut posted = false;
        for &thread in &self.threads {
            // SAFETY: WM_QUIT has scalar parameters and needs no borrowed buffer.
            posted |= unsafe { PostThreadMessageW(thread, WM_QUIT, 0, 0) } != FALSE;
        }
        posted
    }
}

fn gracefully_stop(process: &MatchingProcess) -> Result<(), String> {
    if request_named_shutdown(process.id) {
        if wait_for_exit(&process.handle, 60_000)? {
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

    windows.post_close();
    if wait_for_exit(&process.handle, 5_000)? {
        return Ok(());
    }

    let posted = windows.post_quit();
    if !posted {
        return Err(format!(
            "could not request event-loop shutdown for Kaigen process {}",
            process.id
        ));
    }
    if !wait_for_exit(&process.handle, 60_000)? {
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
