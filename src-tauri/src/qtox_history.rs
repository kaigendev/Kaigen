use std::{
    ffi::{c_char, c_int, c_uchar, c_void, CStr, CString},
    path::{Path, PathBuf},
    ptr::{self, NonNull},
};

#[cfg(all(test, target_os = "windows"))]
use std::fs;

use crate::profiles;

#[derive(Debug)]
pub struct ImportedHistoryRow {
    pub source_id: i64,
    pub timestamp_ms: i64,
    pub chat_key: Vec<u8>,
    pub sender_key: Vec<u8>,
    pub text: String,
    pub file_name: Option<String>,
    pub file_path: Option<String>,
    pub file_size: u64,
}

type Sqlite = *mut c_void;
type Statement = *mut c_void;

type OpenV2 = unsafe extern "C" fn(*const c_char, *mut Sqlite, c_int, *const c_char) -> c_int;
type Close = unsafe extern "C" fn(Sqlite) -> c_int;
type ExecCallback =
    unsafe extern "C" fn(*mut c_void, c_int, *mut *mut c_char, *mut *mut c_char) -> c_int;
type Exec = unsafe extern "C" fn(
    Sqlite,
    *const c_char,
    Option<ExecCallback>,
    *mut c_void,
    *mut *mut c_char,
) -> c_int;
type PrepareV2 =
    unsafe extern "C" fn(Sqlite, *const c_char, c_int, *mut Statement, *mut *const c_char) -> c_int;
type Step = unsafe extern "C" fn(Statement) -> c_int;
type Finalize = unsafe extern "C" fn(Statement) -> c_int;
type ColumnInt64 = unsafe extern "C" fn(Statement, c_int) -> i64;
type ColumnText = unsafe extern "C" fn(Statement, c_int) -> *const c_uchar;
type ColumnBlob = unsafe extern "C" fn(Statement, c_int) -> *const c_void;
type ColumnBytes = unsafe extern "C" fn(Statement, c_int) -> c_int;
type ColumnType = unsafe extern "C" fn(Statement, c_int) -> c_int;
type ColumnCount = unsafe extern "C" fn(Statement) -> c_int;
type ErrorMessage = unsafe extern "C" fn(Sqlite) -> *const c_char;

struct Api {
    _module: LoadedModule,
    open_v2: OpenV2,
    close: Close,
    exec: Exec,
    prepare_v2: PrepareV2,
    step: Step,
    finalize: Finalize,
    column_int64: ColumnInt64,
    column_text: ColumnText,
    column_blob: ColumnBlob,
    column_bytes: ColumnBytes,
    column_type: ColumnType,
    column_count: ColumnCount,
    error_message: ErrorMessage,
}

impl Api {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    fn load(path: &Path) -> Result<Self, String> {
        let module = LoadedModule::open(path)?;
        // SAFETY: The bundled SQLCipher runtime supplies these SQLite C ABI
        // symbols. The module remains owned during resolution and use.
        let api = unsafe {
            Self {
                open_v2: module.symbol(c"sqlite3_open_v2")?,
                close: module.symbol(c"sqlite3_close")?,
                exec: module.symbol(c"sqlite3_exec")?,
                prepare_v2: module.symbol(c"sqlite3_prepare_v2")?,
                step: module.symbol(c"sqlite3_step")?,
                finalize: module.symbol(c"sqlite3_finalize")?,
                column_int64: module.symbol(c"sqlite3_column_int64")?,
                column_text: module.symbol(c"sqlite3_column_text")?,
                column_blob: module.symbol(c"sqlite3_column_blob")?,
                column_bytes: module.symbol(c"sqlite3_column_bytes")?,
                column_type: module.symbol(c"sqlite3_column_type")?,
                column_count: module.symbol(c"sqlite3_column_count")?,
                error_message: module.symbol(c"sqlite3_errmsg")?,
                _module: module,
            }
        };
        Ok(api)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    fn load(_path: &Path) -> Result<Self, String> {
        Err("qTox history import is currently available in Windows and Linux builds".to_string())
    }

}

/// Owns a single loader reference, including while the API table is incomplete.
#[cfg(any(target_os = "windows", target_os = "linux"))]
struct LoadedModule(NonNull<c_void>);

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
struct LoadedModule;

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl LoadedModule {
    #[cfg(target_os = "windows")]
    fn open(path: &Path) -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;
        let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if wide.contains(&0) {
            return Err("Invalid bundled SQLCipher path".to_string());
        }
        wide.push(0);
        const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
        const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;
        // SAFETY: The path is NUL-terminated and live during the call.
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
        };
        NonNull::new(module).map(Self).ok_or_else(|| {
            format!(
                "Could not load SQLCipher from {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            )
        })
    }

    #[cfg(target_os = "linux")]
    fn open(path: &Path) -> Result<Self, String> {
        use std::os::unix::ffi::OsStrExt;
        if !path.is_absolute() {
            return Err("SQLCipher requires an absolute bundled path".to_string());
        }
        let name = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "Invalid bundled SQLCipher path".to_string())?;
        // SAFETY: The absolute bundled path is a live C string.
        let module = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        NonNull::new(module)
            .map(Self)
            .ok_or_else(|| "Could not load the bundled Linux SQLCipher runtime".to_string())
    }

    /// Resolves a C function from this loaded SQLCipher module.
    ///
    /// # Safety
    ///
    /// T must be the precise C ABI function-pointer type for the named export.
    /// The caller must keep this module alive while the function is used.
    unsafe fn symbol<T: Copy>(&self, name: &CStr) -> Result<T, String> {
        #[cfg(target_os = "windows")]
        // SAFETY: The module and NUL-terminated name are live during resolution.
        let address = unsafe { GetProcAddress(self.0.as_ptr(), name.as_ptr()) };
        #[cfg(target_os = "linux")]
        // SAFETY: The module and NUL-terminated name are live during resolution.
        let address = unsafe { libc::dlsym(self.0.as_ptr(), name.as_ptr()) };
        if address.is_null() {
            return Err(format!(
                "SQLCipher export {} is missing",
                name.to_string_lossy()
            ));
        }
        if std::mem::size_of::<T>() != std::mem::size_of_val(&address) {
            return Err(format!(
                "SQLCipher export {} has an unsupported pointer size",
                name.to_string_lossy()
            ));
        }
        // SAFETY: The caller matches the ABI, and the copy is exactly pointer-sized.
        Ok(unsafe { std::mem::transmute_copy(&address) })
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl Drop for LoadedModule {
    fn drop(&mut self) {
        // SAFETY: The loader returned this owned reference, and Drop runs once.
        #[cfg(target_os = "windows")]
        unsafe {
            FreeLibrary(self.0.as_ptr());
        }
        #[cfg(target_os = "linux")]
        unsafe {
            libc::dlclose(self.0.as_ptr());
        }
    }
}

/// Owns a thread-local SQLite connection and borrows its loaded API.
struct Database<'a> {
    api: &'a Api,
    raw: NonNull<c_void>,
}

impl<'a> Database<'a> {
    fn open(api: &'a Api, path: &CStr, flags: c_int) -> Result<Self, String> {
        const SQLITE_OPEN_NOMUTEX: c_int = 0x8000;
        let mut raw = ptr::null_mut();
        // SAFETY: The path is NUL-terminated and the output slot is writable.
        let result = unsafe {
            (api.open_v2)(
                path.as_ptr(),
                &mut raw,
                flags | SQLITE_OPEN_NOMUTEX,
                ptr::null(),
            )
        };
        let raw = NonNull::new(raw)
            .ok_or_else(|| "SQLCipher could not open the database".to_string())?;
        // SQLite can return an owned handle even when open fails.
        let database = Self { api, raw };
        if result != 0 {
            return Err(database.error());
        }
        Ok(database)
    }

    fn error(&self) -> String {
        // SAFETY: SQLite returns a borrowed C string for this live connection.
        // Copy it before issuing another call on that connection.
        unsafe {
            let pointer = (self.api.error_message)(self.raw.as_ptr());
            if pointer.is_null() {
                return "unknown SQLCipher error".to_string();
            }
            CStr::from_ptr(pointer).to_string_lossy().into_owned()
        }
    }

    fn exec(&self, query: &str) -> Result<(), String> {
        let query = CString::new(query).map_err(|_| "Invalid SQLCipher query".to_string())?;
        self.exec_cstr(&query)
    }

    fn exec_cstr(&self, query: &CStr) -> Result<(), String> {
        // SAFETY: This connection and the NUL-terminated query are live.
        // A null context and no callback keep execution synchronous.
        let result = unsafe {
            (self.api.exec)(
                self.raw.as_ptr(),
                query.as_ptr(),
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(self.error())
        }
    }
}

impl Drop for Database<'_> {
    fn drop(&mut self) {
        // SAFETY: All statements borrow this connection and finalize before it drops.
        unsafe { (self.api.close)(self.raw.as_ptr()) };
    }
}

#[cfg(target_os = "linux")]
fn sqlcipher_candidates(_history_path: &Path, portable_root: &Path) -> Vec<PathBuf> {
    if !portable_root.is_absolute() {
        return Vec::new();
    }
    let Ok(root) = portable_root.canonicalize() else {
        return Vec::new();
    };
    let candidate = root
        .join("runtime")
        .join("qtox-import")
        .join("libsqlcipher.so");
    // Never load a library supplied beside an imported profile, via a symlink,
    // or through the process library search path.
    let regular = std::fs::symlink_metadata(&candidate)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    if regular && candidate.canonicalize().ok().as_ref() == Some(&candidate) {
        vec![candidate]
    } else {
        Vec::new()
    }
}

#[cfg(not(target_os = "linux"))]
fn sqlcipher_candidates(history_path: &Path, portable_root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = history_path.parent() {
        candidates.push(parent.join("libsqlcipher-0.dll"));
    }
    candidates.push(
        portable_root
            .join("runtime")
            .join("qtox-import")
            .join("libsqlcipher-0.dll"),
    );
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .collect()
}

/// Applies one cipher profile without retaining plaintext key material in Rust.
fn set_cipher_key(
    database: &Database<'_>,
    key: &[u8; 32],
    parameters: &str,
) -> Result<(), String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    const PREFIX: &[u8] = b"PRAGMA key=\"x'";
    const SUFFIX: &[u8] = b"'\"; ";
    let mut query =
        Vec::with_capacity(PREFIX.len() + key.len() * 2 + SUFFIX.len() + parameters.len() + 1);
    query.extend_from_slice(PREFIX);
    for &byte in key {
        query.push(HEX[(byte >> 4) as usize]);
        query.push(HEX[(byte & 0x0f) as usize]);
    }
    query.extend_from_slice(SUFFIX);
    query.extend_from_slice(parameters.as_bytes());
    query.push(0);
    let result = CStr::from_bytes_with_nul(&query)
        .map_err(|_| "Invalid SQLCipher key query".to_string())
        .and_then(|query| database.exec_cstr(query));
    crate::wipe_secret_bytes(&mut query);
    result
}

fn open_database<'a>(
    api: &'a Api,
    path: &Path,
    key: Option<&[u8; 32]>,
) -> Result<Database<'a>, String> {
    const SQLITE_OPEN_READONLY: c_int = 0x1;
    let path = CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| "Invalid qTox history path".to_string())?;
    let parameter_sets = if key.is_some() {
        vec![
            "PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; PRAGMA cipher_hmac_algorithm=HMAC_SHA512; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512;",
            "PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; PRAGMA cipher_hmac_algorithm=HMAC_SHA1; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA1;",
            "PRAGMA cipher_page_size=1024; PRAGMA kdf_iter=64000; PRAGMA cipher_hmac_algorithm=HMAC_SHA1; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA1;",
        ]
    } else {
        vec![""]
    };
    let mut last_error = String::new();
    for parameters in parameter_sets {
        let database = match Database::open(api, &path, SQLITE_OPEN_READONLY) {
            Ok(database) => database,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        if let Some(key) = key {
            if let Err(error) = set_cipher_key(&database, key, parameters) {
                last_error = error;
                continue;
            }
        }
        match database.exec("SELECT count(*) FROM sqlite_master;") {
            Ok(()) => return Ok(database),
            Err(error) => last_error = error,
        }
    }
    Err(if last_error.is_empty() {
        "The qTox history database could not be decrypted".to_string()
    } else {
        format!("The qTox history database could not be decrypted: {last_error}")
    })
}

/// A statement keeps its connection and module alive until finalization.
struct Prepared<'a> {
    database: &'a Database<'a>,
    raw: NonNull<c_void>,
}

impl Prepared<'_> {
    /// Borrows this statement for the lifetime of its current row.
    fn next(&mut self) -> Result<Option<HistoryRow<'_>>, String> {
        const SQLITE_ROW: c_int = 100;
        const SQLITE_DONE: c_int = 101;
        // SAFETY: The statement belongs to this live, thread-local connection.
        match unsafe { (self.database.api.step)(self.raw.as_ptr()) } {
            SQLITE_ROW => Ok(Some(HistoryRow {
                api: self.database.api,
                raw: self.raw,
                // SAFETY: The successful step leaves the statement on a live row.
                columns: unsafe { (self.database.api.column_count)(self.raw.as_ptr()) },
            })),
            SQLITE_DONE => Ok(None),
            _ => Err(self.database.error()),
        }
    }
}

impl Drop for Prepared<'_> {
    fn drop(&mut self) {
        // SAFETY: This statement was prepared on the live borrowed database.
        unsafe { (self.database.api.finalize)(self.raw.as_ptr()) };
    }
}

struct HistoryRow<'a> {
    api: &'a Api,
    raw: NonNull<c_void>,
    columns: c_int,
}

impl HistoryRow<'_> {
    fn check_column(&self, column: c_int) {
        assert!(
            (0..self.columns).contains(&column),
            "invalid qTox history query column"
        );
    }

    fn is_null(&self, column: c_int) -> bool {
        const SQLITE_NULL: c_int = 5;
        self.check_column(column);
        // SAFETY: This is an in-range column of the current row. Its
        // original type is inspected before any conversion of this column.
        unsafe { (self.api.column_type)(self.raw.as_ptr(), column) == SQLITE_NULL }
    }

    fn integer(&self, column: c_int) -> i64 {
        self.check_column(column);
        // SAFETY: This is an in-range column of the current row.
        unsafe { (self.api.column_int64)(self.raw.as_ptr(), column) }
    }

    fn bytes(&self, column: c_int, text: bool) -> Vec<u8> {
        self.check_column(column);
        // SAFETY: The current row is live and the column is in range.
        // Ask SQLite to convert before querying length, then copy while the
        // returned buffer is still valid. A NULL pointer represents no data.
        unsafe {
            let pointer = if text {
                (self.api.column_text)(self.raw.as_ptr(), column)
            } else {
                (self.api.column_blob)(self.raw.as_ptr(), column).cast()
            };
            if pointer.is_null() {
                return Vec::new();
            }
            let length = (self.api.column_bytes)(self.raw.as_ptr(), column).max(0) as usize;
            std::slice::from_raw_parts(pointer, length).to_vec()
        }
    }
}

fn prepare<'a>(database: &'a Database<'_>, query: &str) -> Result<Prepared<'a>, String> {
    let query = CString::new(query).map_err(|_| "Invalid qTox history query".to_string())?;
    let mut raw = ptr::null_mut();
    // SAFETY: The connection is live, the SQL string is NUL-terminated, and
    // the output slot belongs to this call. The unused tail pointer is null.
    let result = unsafe {
        (database.api.prepare_v2)(
            database.raw.as_ptr(),
            query.as_ptr(),
            -1,
            &mut raw,
            ptr::null_mut(),
        )
    };
    let statement = NonNull::new(raw).map(|raw| Prepared { database, raw });
    match statement {
        Some(statement) if result == 0 => Ok(statement),
        _ => Err(format!("Could not read qTox history: {}", database.error())),
    }
}

fn has_column(database: &Database<'_>, table: &str, column: &str) -> Result<bool, String> {
    // Both names come from the fixed schema names below, never from the file.
    let mut statement = prepare(database, &format!("PRAGMA table_info({table});"))?;
    while let Some(row) = statement
        .next()
        .map_err(|error| format!("Could not inspect qTox history: {error}"))?
    {
        if row.bytes(1, true) == column.as_bytes() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn history_query(database: &Database<'_>) -> Result<String, String> {
    let split = has_column(database, "history", "message_type")?;
    let modern = has_column(database, "chats", "uuid")?;
    let (query, chat_key) = if split {
        let (chat_key, sender_key, chat_join, sender_join) = if modern {
            ("chats.uuid", "authors.public_key", "chats", "authors")
        } else {
            (
                "chats.public_key",
                "authors.public_key",
                "peers AS chats",
                "peers AS authors",
            )
        };
        (
            format!(
                "SELECT history.id, history.timestamp, {chat_key}, {sender_key}, text_messages.message, file_transfers.file_name, file_transfers.file_path, file_transfers.file_size, CASE history.message_type WHEN 'T' THEN text_messages.id ELSE file_transfers.id END FROM history LEFT JOIN {chat_join} ON history.chat_id=chats.id LEFT JOIN text_messages ON history.id=text_messages.id AND history.message_type='T' LEFT JOIN file_transfers ON history.id=file_transfers.id AND history.message_type='F' LEFT JOIN aliases ON aliases.id=CASE history.message_type WHEN 'T' THEN text_messages.sender_alias ELSE file_transfers.sender_alias END LEFT JOIN {sender_join} ON aliases.owner=authors.id WHERE history.message_type IN ('T','F')"
            ),
            chat_key,
        )
    } else {
        let files = has_column(database, "history", "file_id")?;
        let (file_columns, file_join) = if files {
            (
                "file_transfers.file_name, file_transfers.file_path, file_transfers.file_size",
                " LEFT JOIN file_transfers ON history.file_id=file_transfers.id",
            )
        } else {
            ("NULL, NULL, 0", "")
        };
        (
            format!(
                "SELECT history.id, history.timestamp, chats.public_key, authors.public_key, history.message, {file_columns}, history.id FROM history LEFT JOIN peers AS chats ON history.chat_id=chats.id LEFT JOIN aliases ON history.sender_alias=aliases.id LEFT JOIN peers AS authors ON aliases.owner=authors.id{file_join}"
            ),
            "chats.public_key",
        )
    };
    // Legacy databases can contain multiple peer rows for the same contact
    // (raw key, lowercase hex, or a full ToxId). Group by the same identity as
    // normalize_public_key, then chronology, so streaming batches append every
    // contact's messages in order even when their source chat IDs differ.
    Ok(format!(
        "{query} ORDER BY CASE length(CAST({chat_key} AS BLOB)) WHEN 32 THEN hex({chat_key}) ELSE upper(substr(CAST({chat_key} AS TEXT),1,64)) END, history.timestamp, history.id;"
    ))
}

fn normalize_public_key(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.len() == 32 {
        return Ok(bytes);
    }
    let key = std::str::from_utf8(&bytes)
        .ok()
        .and_then(crate::qtox_settings::public_key_from_address);
    key.ok_or_else(|| "QTOX_HISTORY_PUBLIC_KEY_INVALID".to_string())
}

/// Collects small fixtures. Production imports stream rows through the visitor.
#[cfg(test)]
pub fn read_qtox_history(
    history_path: &Path,
    portable_root: &Path,
    password: Option<&str>,
    self_public_key: &[u8; 32],
) -> Result<Vec<ImportedHistoryRow>, String> {
    let mut rows = Vec::new();
    visit_qtox_history(
        history_path,
        portable_root,
        password,
        self_public_key,
        |row| {
            rows.push(row);
            Ok(())
        },
    )?;
    Ok(rows)
}

pub(crate) fn visit_qtox_history(
    history_path: &Path,
    portable_root: &Path,
    password: Option<&str>,
    self_public_key: &[u8; 32],
    mut visit: impl FnMut(ImportedHistoryRow) -> Result<(), String>,
) -> Result<usize, String> {
    let library = sqlcipher_candidates(history_path, portable_root)
        .into_iter()
        .next()
        .ok_or_else(|| "SQLCipher runtime was not found for qTox history import".to_string())?;
    let api = Api::load(&library)?;
    let mut key = password
        .filter(|value| !value.is_empty())
        .map(|password| profiles::derive_qtox_database_key(password, self_public_key))
        .transpose()?;
    let database = open_database(&api, history_path, key.as_ref());
    if let Some(key) = key.as_mut() {
        crate::wipe_secret_bytes(key);
    }
    let database = database?;
    let query = history_query(&database)?;
    let mut statement = prepare(&database, &query)?;
    let mut count = 0;
    while let Some(row) = statement
        .next()
        .map_err(|error| format!("Could not iterate qTox history: {error}"))?
    {
        if row.is_null(8) {
            return Err("QTOX_HISTORY_MESSAGE_MISSING".to_string());
        }
        visit(ImportedHistoryRow {
            source_id: row.integer(0),
            timestamp_ms: row.integer(1),
            chat_key: normalize_public_key(row.bytes(2, false))?,
            sender_key: normalize_public_key(row.bytes(3, false))?,
            text: String::from_utf8_lossy(&row.bytes(4, true)).replace('\0', ""),
            file_name: {
                let value = String::from_utf8_lossy(&row.bytes(5, true)).replace('\0', "");
                (!value.is_empty()).then_some(value)
            },
            file_path: {
                let value = String::from_utf8_lossy(&row.bytes(6, true)).replace('\0', "");
                (!value.is_empty()).then_some(value)
            },
            file_size: row.integer(7).max(0) as u64,
        })?;
        count += 1;
    }
    Ok(count)
}

#[cfg(all(test, target_os = "windows"))]
pub fn write_disposable_qtox_database(
    history_path: &Path,
    sqlcipher_path: &Path,
    password: &str,
    self_public_key: &[u8; 32],
    friend_public_key: &[u8; 32],
) -> Result<(), String> {
    if history_path.exists() {
        return Err(format!(
            "Refusing to overwrite disposable qTox history {}",
            history_path.display()
        ));
    }
    let parent = history_path
        .parent()
        .ok_or_else(|| "The disposable qTox history path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let api = Api::load(sqlcipher_path)?;
    let path = CString::new(history_path.to_string_lossy().as_bytes())
        .map_err(|_| "Invalid disposable qTox history path".to_string())?;
    const SQLITE_OPEN_READWRITE: c_int = 0x2;
    const SQLITE_OPEN_CREATE: c_int = 0x4;
    let database = Database::open(&api, &path, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)?;
    let mut key = profiles::derive_qtox_database_key(password, self_public_key)?;
    let keyed = set_cipher_key(
        &database,
        &key,
        "PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; PRAGMA cipher_hmac_algorithm=HMAC_SHA512; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512;",
    );
    crate::wipe_secret_bytes(&mut key);
    keyed?;
    let friend = friend_public_key
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    let owner = self_public_key
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    database.exec(&format!(
            "CREATE TABLE authors(id INTEGER PRIMARY KEY, public_key BLOB NOT NULL UNIQUE);\
             CREATE TABLE chats(id INTEGER PRIMARY KEY, uuid BLOB NOT NULL UNIQUE);\
             CREATE TABLE aliases(id INTEGER PRIMARY KEY, owner INTEGER, display_name BLOB NOT NULL, UNIQUE(owner, display_name), FOREIGN KEY(owner) REFERENCES authors(id));\
             CREATE TABLE history(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL DEFAULT 'T' CHECK(message_type IN ('T','F','S')), timestamp INTEGER NOT NULL, chat_id INTEGER NOT NULL, UNIQUE(id, message_type), FOREIGN KEY(chat_id) REFERENCES chats(id));\
             CREATE TABLE text_messages(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL CHECK(message_type = 'T'), sender_alias INTEGER NOT NULL, message BLOB NOT NULL, FOREIGN KEY(id, message_type) REFERENCES history(id, message_type), FOREIGN KEY(sender_alias) REFERENCES aliases(id));\
             CREATE TABLE file_transfers(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL CHECK(message_type = 'F'), sender_alias INTEGER NOT NULL, file_restart_id BLOB NOT NULL, file_name BLOB NOT NULL, file_path BLOB NOT NULL, file_hash BLOB NOT NULL, file_size INTEGER NOT NULL, direction INTEGER NOT NULL, file_state INTEGER NOT NULL, FOREIGN KEY(id, message_type) REFERENCES history(id, message_type), FOREIGN KEY(sender_alias) REFERENCES aliases(id));\
             CREATE TABLE system_messages(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL CHECK(message_type = 'S'), system_message_type INTEGER NOT NULL, arg1 BLOB, arg2 BLOB, arg3 BLOB, arg4 BLOB, FOREIGN KEY(id, message_type) REFERENCES history(id, message_type));\
             CREATE TABLE faux_offline_pending(id INTEGER PRIMARY KEY, required_extensions INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(id) REFERENCES history(id));\
             CREATE TABLE broken_messages(id INTEGER PRIMARY KEY, reason INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(id) REFERENCES history(id));\
             CREATE INDEX chat_id_idx ON history(chat_id);\
             INSERT INTO chats VALUES(1, X'{friend}');\
             INSERT INTO authors VALUES(1, X'{owner}');\
             INSERT INTO aliases VALUES(1, 1, 'Disposable Kaigen');\
             INSERT INTO history VALUES(42, 'T', 1700000000000, 1);\
             INSERT INTO text_messages VALUES(42, 'T', 1, 'disposable qTox SQLCipher history');\
             PRAGMA user_version=11;"
    ))?;
    drop(database);
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
#[path = "qtox_import_tests.rs"]
mod import_tests;

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryExW(filename: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
}
