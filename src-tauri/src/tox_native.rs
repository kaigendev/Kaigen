//! Typed access to a live Tox instance owned by the caller.

use std::{
    ffi::{c_void, CStr},
    marker::PhantomData,
    ptr::{self, NonNull},
};

use super::{CallbackContext, ToxHandle};

#[cfg(all(test, feature = "desktop"))]
pub(super) fn test_proxy_options(options: &super::ToxOptions) -> (i32, u16) {
    // SAFETY: Both getters only read the options allocation owned by this borrow.
    unsafe {
        (
            super::tox_options_get_proxy_type(options.as_ptr()),
            super::tox_options_get_proxy_port(options.as_ptr()),
        )
    }
}

#[cfg(all(test, windows, feature = "desktop"))]
pub(super) fn test_loaded_module_path(name: &str) -> Option<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleExW(flags: u32, name: *const u16, module: *mut *mut c_void) -> i32;
        fn GetModuleFileNameW(module: *mut c_void, path: *mut u16, size: u32) -> u32;
        fn FreeLibrary(module: *mut c_void) -> i32;
    }
    struct Module(NonNull<c_void>);
    impl Drop for Module {
        fn drop(&mut self) {
            // SAFETY: GetModuleHandleExW transferred a module reference.
            unsafe { FreeLibrary(self.0.as_ptr()) };
        }
    }

    if name.contains('\0') {
        return None;
    }
    let name: Vec<_> = name.encode_utf16().chain([0]).collect();
    let mut handle = ptr::null_mut();
    // SAFETY: The name is NUL-terminated and handle is a writable out pointer.
    if unsafe { GetModuleHandleExW(0, name.as_ptr(), &mut handle) } == 0 {
        return None;
    }
    let module = Module(NonNull::new(handle)?);
    let mut path = vec![0; 32768];
    // SAFETY: The module reference remains live and path covers the passed size.
    let len = unsafe { GetModuleFileNameW(module.0.as_ptr(), path.as_mut_ptr(), path.len() as u32) }
        as usize;
    if len == 0 || len >= path.len() {
        return None;
    }
    String::from_utf16(&path[..len]).ok()
}

type FriendTextSize = unsafe extern "C" fn(*const c_void, u32, *mut i32) -> usize;
type FriendTextGet = unsafe extern "C" fn(*const c_void, u32, *mut u8, *mut i32) -> bool;

enum FriendText {
    Name,
    Status,
}

unsafe extern "C" {
    fn tox_kaigen_bootstrap_status(
        tox: *const c_void,
        ip: *const std::ffi::c_char,
        port: u16,
        key: *const u8,
    ) -> u32;
}

/// The owner holds its profile lock for the entire borrow. Callback borrows
/// are confined to their synchronous invocation. NonNull keeps the borrow
/// on the current thread even though the owning handle may move.
#[derive(Clone, Copy)]
pub(super) struct ToxRef<'a> {
    ptr: NonNull<c_void>,
    _lifetime: PhantomData<&'a ToxHandle>,
}

impl<'a> ToxRef<'a> {
    pub(super) fn from_handle(handle: &'a ToxHandle) -> Self {
        Self {
            ptr: handle.instance,
            _lifetime: PhantomData,
        }
    }

    /// # Safety
    /// The pointer must be the live instance supplied by Tox for this
    /// synchronous callback. The callback context must not be borrowed for
    /// longer than this callback invocation.
    pub(super) unsafe fn from_callback(
        ptr: *mut c_void,
        _scope: &'a CallbackContext,
    ) -> Option<Self> {
        NonNull::new(ptr).map(|ptr| Self {
            ptr,
            _lifetime: PhantomData,
        })
    }

    pub(super) fn address(self) -> [u8; 38] {
        let mut address = [0; 38];
        // SAFETY: Tox writes exactly 38 bytes to this live output.
        unsafe { super::tox_self_get_address(self.ptr.as_ptr(), address.as_mut_ptr()) };
        address
    }

    pub(super) fn bootstrap_observed(self, ip: &CStr, port: u16, key: &[u8; 32]) -> bool {
        // SAFETY: The instance is live, the IP is NUL-terminated and the key has 32 bytes.
        unsafe {
            tox_kaigen_bootstrap_status(self.ptr.as_ptr(), ip.as_ptr(), port, key.as_ptr()) != 0
        }
    }

    pub(super) fn friend_numbers(self) -> Vec<u32> {
        // SAFETY: The instance stays on one thread between querying its
        // friend count and writing the matching number of entries.
        unsafe {
            let count = super::tox_self_get_friend_list_size(self.ptr.as_ptr());
            let mut numbers = vec![0; count];
            if !numbers.is_empty() {
                super::tox_self_get_friend_list(self.ptr.as_ptr(), numbers.as_mut_ptr());
            }
            numbers
        }
    }

    pub(super) fn friend_public_key(self, friend: u32, error: &mut i32) -> Option<[u8; 32]> {
        let mut key = [0; 32];
        // SAFETY: Tox writes at most the 32-byte public key and an error code.
        unsafe {
            super::tox_friend_get_public_key(self.ptr.as_ptr(), friend, key.as_mut_ptr(), error)
        }
        .then_some(key)
    }

    pub(super) fn file_id(self, friend: u32, file: u32, error: &mut i32) -> Option<[u8; 32]> {
        let mut id = [0; 32];
        // SAFETY: Tox writes at most the 32-byte file ID and an error code.
        unsafe {
            super::tox_file_get_file_id(self.ptr.as_ptr(), friend, file, id.as_mut_ptr(), error)
        }
        .then_some(id)
    }

    fn friend_text(self, friend: u32, field: FriendText, error: &mut i32) -> Option<Vec<u8>> {
        let (size, get): (FriendTextSize, FriendTextGet) = match field {
            FriendText::Name => (super::tox_friend_get_name_size, super::tox_friend_get_name),
            FriendText::Status => (
                super::tox_friend_get_status_message_size,
                super::tox_friend_get_status_message,
            ),
        };
        // SAFETY: The size and read operations are paired above.
        // The live instance cannot change between the query and the read.
        unsafe {
            let count = size(self.ptr.as_ptr(), friend, error);
            if *error != 0 {
                return None;
            }
            let mut text = vec![0; count];
            if !text.is_empty() && !get(self.ptr.as_ptr(), friend, text.as_mut_ptr(), error) {
                return None;
            }
            Some(text)
        }
    }

    pub(super) fn friend_name_bytes(self, friend: u32, error: &mut i32) -> Option<Vec<u8>> {
        self.friend_text(friend, FriendText::Name, error)
    }

    pub(super) fn friend_status_bytes(self, friend: u32, error: &mut i32) -> Option<Vec<u8>> {
        self.friend_text(friend, FriendText::Status, error)
    }

    #[cfg(feature = "web-core")]
    fn sanitized_friend_text(bytes: Option<Vec<u8>>, error: i32) -> String {
        bytes
            .filter(|_| error == 0)
            .map_or_else(String::new, |bytes| {
                super::sanitize_untrusted_text(&String::from_utf8_lossy(&bytes))
                    .trim()
                    .to_string()
            })
    }

    #[cfg(feature = "web-core")]
    pub(super) fn friend_name(self, friend: u32) -> String {
        let mut error = 0;
        let bytes = self.friend_name_bytes(friend, &mut error);
        Self::sanitized_friend_text(bytes, error)
    }

    #[cfg(feature = "web-core")]
    pub(super) fn friend_status_text(self, friend: u32) -> String {
        let mut error = 0;
        let bytes = self.friend_status_bytes(friend, &mut error);
        Self::sanitized_friend_text(bytes, error)
    }

    pub(super) fn self_status_message(self, error: &mut i32) -> Option<Vec<u8>> {
        // SAFETY: The live instance cannot change between querying the
        // size and reading into an output of that size.
        unsafe {
            let count = super::tox_self_get_status_message_size(self.ptr.as_ptr(), error);
            if *error != 0 {
                return None;
            }
            let mut text = vec![0; count];
            if !text.is_empty()
                && !super::tox_self_get_status_message(self.ptr.as_ptr(), text.as_mut_ptr(), error)
            {
                return None;
            }
            Some(text)
        }
    }

    pub(super) fn nickname(self) -> String {
        // SAFETY: The live instance cannot change between querying the
        // size and reading into an output of that size.
        let bytes = unsafe {
            let count = super::tox_self_get_name_size(self.ptr.as_ptr());
            let mut bytes = vec![0; count];
            if !bytes.is_empty() {
                super::tox_self_get_name(self.ptr.as_ptr(), bytes.as_mut_ptr());
            }
            bytes
        };
        String::from_utf8_lossy(&bytes).into_owned()
    }

    pub(super) fn friend_add(self, address: &[u8; 38], message: &[u8], error: &mut i32) -> u32 {
        // SAFETY: The address and message cover the complete native input sizes.
        unsafe {
            super::tox_friend_add(
                self.ptr.as_ptr(),
                address.as_ptr(),
                message.as_ptr(),
                message.len(),
                error,
            )
        }
    }

    pub(super) fn friend_add_norequest(self, key: &[u8; 32], error: &mut i32) -> u32 {
        // SAFETY: The key has the required 32 bytes.
        unsafe { super::tox_friend_add_norequest(self.ptr.as_ptr(), key.as_ptr(), error) }
    }

    pub(super) fn friend_delete(self, friend: u32, error: &mut i32) -> bool {
        // SAFETY: Native code validates the friend number.
        unsafe { super::tox_friend_delete(self.ptr.as_ptr(), friend, error) }
    }

    pub(super) fn friend_connection_status(self, friend: u32, error: &mut i32) -> u8 {
        // SAFETY: Native code validates the friend number.
        unsafe { super::tox_friend_get_connection_status(self.ptr.as_ptr(), friend, error) }
    }

    pub(super) fn friend_status(self, friend: u32, error: &mut i32) -> u8 {
        // SAFETY: Native code validates the friend number.
        unsafe { super::tox_friend_get_status(self.ptr.as_ptr(), friend, error) }
    }

    pub(super) fn self_status(self) -> u8 {
        // SAFETY: The borrowed instance is live.
        unsafe { super::tox_self_get_status(self.ptr.as_ptr()) }
    }

    pub(super) fn self_set_status(self, status: u8) {
        // SAFETY: The borrowed instance is live.
        unsafe { super::tox_self_set_status(self.ptr.as_ptr(), status) }
    }

    pub(super) fn self_set_status_message(self, message: &[u8], error: &mut i32) -> bool {
        // SAFETY: The slice supplies the pointer and length together.
        unsafe {
            super::tox_self_set_status_message(
                self.ptr.as_ptr(),
                message.as_ptr(),
                message.len(),
                error,
            )
        }
    }

    pub(super) fn self_set_name(self, name: &[u8], error: &mut i32) -> bool {
        // SAFETY: The slice supplies the pointer and length together.
        unsafe { super::tox_self_set_name(self.ptr.as_ptr(), name.as_ptr(), name.len(), error) }
    }

    pub(super) fn file_control(
        self,
        friend: u32,
        file: u32,
        control: i32,
        error: &mut i32,
    ) -> bool {
        // SAFETY: Native code validates the transfer identifiers and control code.
        unsafe { super::tox_file_control(self.ptr.as_ptr(), friend, file, control, error) }
    }

    pub(super) fn file_send(
        self,
        friend: u32,
        kind: u32,
        size: u64,
        id: Option<&[u8; 32]>,
        filename: &[u8],
        error: &mut i32,
    ) -> u32 {
        // SAFETY: The optional ID is null or a full 32-byte ID. The filename slice supplies its length.
        unsafe {
            super::tox_file_send(
                self.ptr.as_ptr(),
                friend,
                kind,
                size,
                id.map_or(ptr::null(), |bytes| bytes.as_ptr()),
                filename.as_ptr(),
                filename.len(),
                error,
            )
        }
    }

    pub(super) fn file_send_chunk(
        self,
        friend: u32,
        file: u32,
        position: u64,
        data: &[u8],
        error: &mut i32,
    ) -> bool {
        // SAFETY: The chunk slice supplies the pointer and length together.
        unsafe {
            super::tox_file_send_chunk(
                self.ptr.as_ptr(),
                friend,
                file,
                position,
                data.as_ptr(),
                data.len(),
                error,
            )
        }
    }

    pub(super) fn send_message(
        self,
        friend: u32,
        kind: i32,
        message: &[u8],
        error: &mut i32,
    ) -> u32 {
        // SAFETY: The message slice supplies the pointer and length together.
        unsafe {
            super::tox_friend_send_message(
                self.ptr.as_ptr(),
                friend,
                kind,
                message.as_ptr(),
                message.len(),
                error,
            )
        }
    }

    pub(super) fn send_lossless_packet(self, friend: u32, data: &[u8], error: &mut i32) -> bool {
        // SAFETY: The packet slice supplies the pointer and length together.
        unsafe {
            super::tox_friend_send_lossless_packet(
                self.ptr.as_ptr(),
                friend,
                data.as_ptr(),
                data.len(),
                error,
            )
        }
    }

    pub(super) fn bootstrap(self, host: &CStr, port: u16, key: &[u8; 32], error: &mut i32) -> bool {
        // SAFETY: The host is NUL-terminated and the key has 32 bytes.
        unsafe {
            super::tox_bootstrap(
                self.ptr.as_ptr(),
                host.as_ptr().cast(),
                port,
                key.as_ptr(),
                error,
            )
        }
    }

    pub(super) fn add_tcp_relay(
        self,
        host: &CStr,
        port: u16,
        key: &[u8; 32],
        error: &mut i32,
    ) -> bool {
        // SAFETY: The host is NUL-terminated and the key has 32 bytes.
        unsafe {
            super::tox_add_tcp_relay(
                self.ptr.as_ptr(),
                host.as_ptr().cast(),
                port,
                key.as_ptr(),
                error,
            )
        }
    }

    pub(super) fn iteration_interval(self) -> u32 {
        // SAFETY: The borrowed instance is live.
        unsafe { super::tox_iteration_interval(self.ptr.as_ptr()) }
    }

    pub(super) fn connection_status(self) -> u8 {
        // SAFETY: The borrowed instance is live.
        unsafe { super::tox_self_get_connection_status(self.ptr.as_ptr()) }
    }
}

#[cfg(all(test, feature = "web-core"))]
impl ToxRef<'_> {
    fn test_context(context: &mut CallbackContext) -> *mut c_void {
        ptr::from_mut(context).cast()
    }

    pub(super) fn test_file_control(
        self,
        context: &mut CallbackContext,
        friend: u32,
        file: u32,
        control: i32,
    ) {
        // SAFETY: The callback receives a live instance and context for this call.
        unsafe {
            super::on_file_recv_control(
                self.ptr.as_ptr(),
                friend,
                file,
                control,
                Self::test_context(context),
            );
        }
    }

    pub(super) fn test_file_chunk_request(
        self,
        context: &mut CallbackContext,
        friend: u32,
        file: u32,
        position: u64,
        length: usize,
    ) {
        // SAFETY: The callback receives a live instance and context for this call.
        unsafe {
            super::on_file_chunk_request(
                self.ptr.as_ptr(),
                friend,
                file,
                position,
                length,
                Self::test_context(context),
            );
        }
    }

    pub(super) fn test_file_recv(
        self,
        context: &mut CallbackContext,
        friend: u32,
        file: u32,
        kind: u32,
        size: u64,
        name: &[u8],
    ) {
        // SAFETY: The callback receives a live instance, context, and name slice.
        unsafe {
            super::on_file_recv(
                self.ptr.as_ptr(),
                friend,
                file,
                kind,
                size,
                name.as_ptr(),
                name.len(),
                Self::test_context(context),
            );
        }
    }

    pub(super) fn test_file_recv_chunk(
        self,
        context: &mut CallbackContext,
        friend: u32,
        file: u32,
        position: u64,
        bytes: &[u8],
    ) {
        // SAFETY: The callback receives a live instance, context, and data slice.
        unsafe {
            super::on_file_recv_chunk(
                self.ptr.as_ptr(),
                friend,
                file,
                position,
                bytes.as_ptr(),
                bytes.len(),
                Self::test_context(context),
            );
        }
    }

    pub(super) fn test_friend_request(
        self,
        context: &mut CallbackContext,
        key: &[u8; 32],
        message: &[u8],
    ) {
        // SAFETY: The callback receives a live instance, context, fixed key and message slice.
        unsafe {
            super::on_friend_request(
                self.ptr.as_ptr(),
                key.as_ptr(),
                message.as_ptr(),
                message.len(),
                Self::test_context(context),
            );
        }
    }
}
