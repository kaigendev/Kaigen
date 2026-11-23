use std::{
    io,
    os::windows::io::{FromRawHandle, OwnedHandle},
    ptr,
};

use windows_sys::Win32::{Foundation::ERROR_ALREADY_EXISTS, System::Threading::CreateMutexW};

/// Keeps the named object alive and reports whether it was already present.
/// The mutex is used as an existence marker, so this call never acquires it.
pub(super) fn create(name: &str) -> io::Result<(OwnedHandle, bool)> {
    if name.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid mutex name",
        ));
    }
    let name: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: The name is a live NUL-terminated UTF-16 string. Null attributes
    // select the default security descriptor and a non-inheritable handle.
    let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
    // Win32 also sets the last error on success when the object exists.
    let error = io::Error::last_os_error();
    if handle.is_null() {
        return Err(error);
    }
    // SAFETY: CreateMutexW returned one non-null, caller-owned handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    Ok((
        handle,
        error.raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32),
    ))
}
