use std::{
    ffi::{c_char, c_int, c_uchar, c_void, CString},
    path::{Path, PathBuf},
    ptr,
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

#[cfg(target_os = "windows")]
type Module = *mut c_void;
#[cfg(not(target_os = "windows"))]
type Module = *mut c_void;
type Sqlite = *mut c_void;
type Statement = *mut c_void;

type OpenV2 = unsafe extern "C" fn(*const c_char, *mut Sqlite, c_int, *const c_char) -> c_int;
type Close = unsafe extern "C" fn(Sqlite) -> c_int;
type Exec = unsafe extern "C" fn(
    Sqlite,
    *const c_char,
    *const c_void,
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
type ErrorMessage = unsafe extern "C" fn(Sqlite) -> *const c_char;

struct Api {
    module: Module,
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
    error_message: ErrorMessage,
}

unsafe impl Send for Api {}

impl Api {
    #[cfg(target_os = "windows")]
    fn load(path: &Path) -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
        const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
        };
        if module.is_null() {
            return Err(format!(
                "Could not load SQLCipher from {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        unsafe fn symbol<T: Copy>(module: Module, name: &'static [u8]) -> Result<T, String> {
            let address = unsafe { GetProcAddress(module, name.as_ptr() as *const c_char) };
            if address.is_null() {
                return Err(format!(
                    "SQLCipher export {} is missing",
                    String::from_utf8_lossy(&name[..name.len().saturating_sub(1)])
                ));
            }
            Ok(unsafe { std::mem::transmute_copy(&address) })
        }
        let loaded = unsafe {
            Self {
                module,
                open_v2: symbol(module, b"sqlite3_open_v2\0")?,
                close: symbol(module, b"sqlite3_close\0")?,
                exec: symbol(module, b"sqlite3_exec\0")?,
                prepare_v2: symbol(module, b"sqlite3_prepare_v2\0")?,
                step: symbol(module, b"sqlite3_step\0")?,
                finalize: symbol(module, b"sqlite3_finalize\0")?,
                column_int64: symbol(module, b"sqlite3_column_int64\0")?,
                column_text: symbol(module, b"sqlite3_column_text\0")?,
                column_blob: symbol(module, b"sqlite3_column_blob\0")?,
                column_bytes: symbol(module, b"sqlite3_column_bytes\0")?,
                column_type: symbol(module, b"sqlite3_column_type\0")?,
                error_message: symbol(module, b"sqlite3_errmsg\0")?,
            }
        };
        Ok(loaded)
    }

    #[cfg(not(target_os = "windows"))]
    fn load(_path: &Path) -> Result<Self, String> {
        Err("qTox history import is currently available in the Windows portable build".to_string())
    }

    fn error(&self, database: Sqlite) -> String {
        let pointer = unsafe { (self.error_message)(database) };
        if pointer.is_null() {
            return "unknown SQLCipher error".to_string();
        }
        unsafe { std::ffi::CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        unsafe {
            FreeLibrary(self.module);
        }
    }
}

struct Database<'a> {
    api: &'a Api,
    raw: Sqlite,
}

impl Drop for Database<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.api.close)(self.raw);
        }
    }
}

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

fn exec(api: &Api, database: Sqlite, query: &str) -> Result<(), String> {
    let query = CString::new(query).map_err(|_| "Invalid SQLCipher query".to_string())?;
    let result = unsafe {
        (api.exec)(
            database,
            query.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(api.error(database))
    }
}

fn open_database<'a>(
    api: &'a Api,
    path: &Path,
    key: Option<[u8; 32]>,
) -> Result<Database<'a>, String> {
    const SQLITE_OPEN_READONLY: c_int = 0x1;
    const SQLITE_OPEN_NOMUTEX: c_int = 0x8000;
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
        let mut raw = ptr::null_mut();
        if unsafe {
            (api.open_v2)(
                path.as_ptr(),
                &mut raw,
                SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX,
                ptr::null(),
            )
        } != 0
            || raw.is_null()
        {
            last_error = if raw.is_null() {
                "SQLCipher could not open the database".to_string()
            } else {
                api.error(raw)
            };
            if !raw.is_null() {
                unsafe {
                    (api.close)(raw);
                }
            }
            continue;
        }
        let database = Database { api, raw };
        if let Some(key) = key {
            let hex = key
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            if let Err(error) = exec(api, raw, &format!("PRAGMA key=\"x'{hex}'\"; {parameters}")) {
                last_error = error;
                continue;
            }
        }
        if exec(api, raw, "SELECT count(*) FROM sqlite_master;").is_ok() {
            return Ok(database);
        }
        last_error = api.error(raw);
    }
    Err(if last_error.is_empty() {
        "The qTox history database could not be decrypted".to_string()
    } else {
        format!("The qTox history database could not be decrypted: {last_error}")
    })
}

fn column_bytes(api: &Api, statement: Statement, column: c_int, text: bool) -> Vec<u8> {
    const SQLITE_NULL: c_int = 5;
    if unsafe { (api.column_type)(statement, column) } == SQLITE_NULL {
        return Vec::new();
    }
    let length = unsafe { (api.column_bytes)(statement, column) }.max(0) as usize;
    if length == 0 {
        return Vec::new();
    }
    let pointer = if text {
        unsafe { (api.column_text)(statement, column) as *const u8 }
    } else {
        unsafe { (api.column_blob)(statement, column) as *const u8 }
    };
    if pointer.is_null() {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec()
    }
}

pub fn read_qtox_history(
    history_path: &Path,
    portable_root: &Path,
    password: Option<&str>,
    self_public_key: &[u8; 32],
) -> Result<Vec<ImportedHistoryRow>, String> {
    let library = sqlcipher_candidates(history_path, portable_root)
        .into_iter()
        .next()
        .ok_or_else(|| "SQLCipher runtime was not found for qTox history import".to_string())?;
    let api = Api::load(&library)?;
    let key = password
        .filter(|value| !value.is_empty())
        .map(|password| profiles::derive_qtox_database_key(password, self_public_key))
        .transpose()?;
    let database = open_database(&api, history_path, key)?;
    let query = CString::new(
        "SELECT history.id, history.timestamp, chats.uuid, authors.public_key, text_messages.message, file_transfers.file_name, file_transfers.file_path, file_transfers.file_size FROM history JOIN chats ON history.chat_id=chats.id LEFT JOIN text_messages ON history.id=text_messages.id LEFT JOIN file_transfers ON history.id=file_transfers.id LEFT JOIN aliases ON text_messages.sender_alias=aliases.id OR file_transfers.sender_alias=aliases.id LEFT JOIN authors ON aliases.owner=authors.id WHERE history.message_type IN ('T','F') ORDER BY history.timestamp, history.id;"
    ).unwrap();
    let mut statement = ptr::null_mut();
    let result = unsafe {
        (api.prepare_v2)(
            database.raw,
            query.as_ptr(),
            -1,
            &mut statement,
            ptr::null_mut(),
        )
    };
    if result != 0 || statement.is_null() {
        return Err(format!(
            "Could not read qTox history: {}",
            api.error(database.raw)
        ));
    }
    const SQLITE_ROW: c_int = 100;
    const SQLITE_DONE: c_int = 101;
    let mut rows = Vec::new();
    loop {
        match unsafe { (api.step)(statement) } {
            SQLITE_ROW => rows.push(ImportedHistoryRow {
                source_id: unsafe { (api.column_int64)(statement, 0) },
                timestamp_ms: unsafe { (api.column_int64)(statement, 1) },
                chat_key: column_bytes(&api, statement, 2, false),
                sender_key: column_bytes(&api, statement, 3, false),
                text: String::from_utf8_lossy(&column_bytes(&api, statement, 4, true))
                    .replace('\0', ""),
                file_name: {
                    let value = String::from_utf8_lossy(&column_bytes(&api, statement, 5, true))
                        .replace('\0', "");
                    (!value.is_empty()).then_some(value)
                },
                file_path: {
                    let value = String::from_utf8_lossy(&column_bytes(&api, statement, 6, true))
                        .replace('\0', "");
                    (!value.is_empty()).then_some(value)
                },
                file_size: unsafe { (api.column_int64)(statement, 7).max(0) as u64 },
            }),
            SQLITE_DONE => break,
            _ => {
                unsafe {
                    (api.finalize)(statement);
                }
                return Err(format!(
                    "Could not iterate qTox history: {}",
                    api.error(database.raw)
                ));
            }
        }
    }
    unsafe {
        (api.finalize)(statement);
    }
    Ok(rows)
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
    const SQLITE_OPEN_NOMUTEX: c_int = 0x8000;
    let mut raw = ptr::null_mut();
    if unsafe {
        (api.open_v2)(
            path.as_ptr(),
            &mut raw,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX,
            ptr::null(),
        )
    } != 0
        || raw.is_null()
    {
        return Err(if raw.is_null() {
            "SQLCipher could not create the disposable qTox database".to_string()
        } else {
            api.error(raw)
        });
    }
    let database = Database { api: &api, raw };
    let key = profiles::derive_qtox_database_key(password, self_public_key)?;
    let key = key
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    exec(
        &api,
        database.raw,
        &format!(
            "PRAGMA key=\"x'{key}'\"; PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; PRAGMA cipher_hmac_algorithm=HMAC_SHA512; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512;"
        ),
    )?;
    let friend = friend_public_key
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    let owner = self_public_key
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    exec(
        &api,
        database.raw,
        &format!(
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
        ),
    )?;
    drop(database);
    Ok(())
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryExW(filename: *const u16, file: *mut c_void, flags: u32) -> Module;
    fn GetProcAddress(module: Module, name: *const c_char) -> *mut c_void;
    fn FreeLibrary(module: Module) -> i32;
}
