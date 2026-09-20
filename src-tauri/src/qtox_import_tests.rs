//! Disposable qTox fixtures. The large regression is opt-in so unrelated Rust
//! unit runs do not repeatedly generate/import a million-message database.

use super::*;
use crate::{
    chat_history_store, kai::KaiProfileVolume, qtox_import, qtox_settings, CachedFriendProfile,
    NetworkSettings, ProfilePaths, ProxyRoute, ProxySettings, ToxState,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const FRIEND_COUNT: usize = 128;
const START_MS: i64 = 1_474_070_400_000;
const TEN_YEARS_MS: i64 = 3_652 * 86_400_000;
const PASSWORD: &str = "Kaigen synthetic decade 2026";

fn root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "kaigen-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn runtime() -> PathBuf {
    if let Some(root) = std::env::var_os("KAIGEN_QTOX_IMPORT_RUNTIME_ROOT") {
        return PathBuf::from(root);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn friend_key(index: usize) -> [u8; 32] {
    let mut key: [u8; 32] =
        Sha256::digest(format!("Kaigen disposable qTox contact {index}").as_bytes()).into();
    key[31] &= 0x7f;
    key
}

fn alias(index: usize) -> String {
    match index % 4 {
        0 => format!("Мой друг {index:03} 🚀"),
        1 => format!("Local nickname {index:03}, team"),
        2 => format!("工作伙伴 {index:03}"),
        _ => format!("Amie {index:03} — café"),
    }
}

fn row_count(index: usize, large: bool) -> usize {
    if !large {
        return 113;
    }
    match index {
        0..16 => 32_768,
        16..64 => 8_192,
        _ => 2_048,
    }
}

fn vint(mut value: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if value == 0 {
            return bytes;
        }
    }
}

fn packed(bytes: &mut Vec<u8>, value: &[u8]) {
    bytes.extend(vint(value.len()));
    bytes.extend_from_slice(value);
}

fn settings_bytes() -> Vec<u8> {
    let mut bytes = b"QTOX\x01".to_vec();
    packed(&mut bytes, b"Friends");
    bytes.push(2);
    packed(&mut bytes, b"Friend");
    packed(&mut bytes, &vint(FRIEND_COUNT));
    for index in 0..FRIEND_COUNT {
        for (key, value) in [
            ("addr", crate::hex_upper(&friend_key(index))),
            ("alias", alias(index)),
        ] {
            bytes.push(3);
            packed(&mut bytes, &vint(index));
            packed(&mut bytes, key.as_bytes());
            packed(&mut bytes, value.as_bytes());
        }
    }
    bytes.push(4);
    bytes.push(1);
    packed(&mut bytes, b"Privacy");
    bytes.push(0);
    packed(&mut bytes, b"enableLogging");
    packed(&mut bytes, b"1");
    bytes
}

fn create_database(
    path: &Path,
    password: Option<&str>,
    self_key: &[u8; 32],
    schema: u32,
    large: bool,
) {
    assert!(!path.exists());
    let api = Api::load(&runtime().join("runtime/qtox-import/libsqlcipher-0.dll")).unwrap();
    let mut raw = ptr::null_mut();
    let cpath = CString::new(path.to_str().unwrap()).unwrap();
    assert_eq!(
        unsafe { (api.open_v2)(cpath.as_ptr(), &mut raw, 0x2 | 0x4 | 0x8000, ptr::null()) },
        0
    );
    let database = Database { api: &api, raw };
    if let Some(password) = password {
        let key =
            crate::hex_upper(&profiles::derive_qtox_database_key(password, self_key).unwrap());
        exec(&api, raw, &format!("PRAGMA key=\"x'{key}'\"; PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; PRAGMA cipher_hmac_algorithm=HMAC_SHA512; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512;")).unwrap();
    }
    let modern = schema >= 11;
    let split = schema >= 7;
    let peers_schema = if modern {
        "CREATE TABLE authors(id INTEGER PRIMARY KEY, public_key BLOB NOT NULL UNIQUE); CREATE TABLE chats(id INTEGER PRIMARY KEY, uuid BLOB NOT NULL UNIQUE);"
    } else {
        "CREATE TABLE peers(id INTEGER PRIMARY KEY, public_key TEXT NOT NULL UNIQUE);"
    };
    exec(&api, raw, peers_schema).unwrap();
    exec(&api, raw, "CREATE TABLE aliases(id INTEGER PRIMARY KEY, owner INTEGER, display_name BLOB NOT NULL, UNIQUE(owner,display_name)); CREATE TABLE faux_offline_pending(id INTEGER PRIMARY KEY, required_extensions INTEGER NOT NULL DEFAULT 0); CREATE TABLE broken_messages(id INTEGER PRIMARY KEY, reason INTEGER NOT NULL DEFAULT 0);").unwrap();
    if split {
        exec(&api, raw, "CREATE TABLE history(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL DEFAULT 'T', timestamp INTEGER NOT NULL, chat_id INTEGER NOT NULL, UNIQUE(id,message_type)); CREATE TABLE text_messages(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL, sender_alias INTEGER NOT NULL, message BLOB NOT NULL); CREATE TABLE file_transfers(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL, sender_alias INTEGER NOT NULL, file_restart_id BLOB NOT NULL, file_name BLOB NOT NULL, file_path BLOB NOT NULL, file_hash BLOB NOT NULL, file_size INTEGER NOT NULL, direction INTEGER NOT NULL, file_state INTEGER NOT NULL); CREATE TABLE system_messages(id INTEGER PRIMARY KEY, message_type CHAR(1) NOT NULL, system_message_type INTEGER NOT NULL, arg1 BLOB,arg2 BLOB,arg3 BLOB,arg4 BLOB);").unwrap();
    } else if schema == 0 {
        exec(&api, raw, "CREATE TABLE history(id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id INTEGER NOT NULL, sender_alias INTEGER NOT NULL, message BLOB NOT NULL);").unwrap();
    } else {
        exec(&api, raw, "CREATE TABLE history(id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, chat_id INTEGER NOT NULL, sender_alias INTEGER NOT NULL, message BLOB NOT NULL, file_id INTEGER); CREATE TABLE file_transfers(id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, file_restart_id BLOB NOT NULL, file_name BLOB NOT NULL, file_path BLOB NOT NULL, file_hash BLOB NOT NULL, file_size INTEGER NOT NULL, direction INTEGER NOT NULL, file_state INTEGER NOT NULL);").unwrap();
    }
    let owner = crate::hex_upper(self_key);
    exec(
        &api,
        raw,
        &if modern {
            format!("INSERT INTO authors VALUES(1,X'{owner}');")
        } else {
            format!("INSERT INTO peers VALUES(1,'{owner}');")
        },
    )
    .unwrap();
    exec(
        &api,
        raw,
        "INSERT INTO aliases VALUES(1,1,'Synthetic owner'); BEGIN;",
    )
    .unwrap();
    let mut start_id = 1usize;
    for index in 0..FRIEND_COUNT {
        let id = index + 2;
        let key = crate::hex_upper(&friend_key(index));
        let peer = if modern {
            format!("INSERT INTO authors VALUES({id},X'{key}'); INSERT INTO chats VALUES({id},X'{key}');")
        } else {
            // Exercise pre-v11 lowercase and full ToxId legacy keys as well.
            let key = if index % 2 == 0 {
                key.to_ascii_lowercase()
            } else {
                format!("{key}000000000000")
            };
            format!("INSERT INTO peers VALUES({id},'{key}');")
        };
        exec(
            &api,
            raw,
            &format!("{peer} INSERT INTO aliases VALUES({id},{id},'Network name {index}');"),
        )
        .unwrap();
        let count = row_count(index, large);
        let seq = format!("WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n+1<{count})");
        let stamp = format!("{START_MS}+n*{TEN_YEARS_MS}/{}", count - 1);
        let sender = format!("CASE WHEN n%2=0 THEN 1 ELSE {id} END");
        let message = format!("'Synthetic contact {index:03}, message ' || n || ': Привет / hello / 你好. Ten-year qTox import regression.'");
        if split {
            exec(&api, raw, &format!("{seq} INSERT INTO history SELECT {start_id}+n,CASE WHEN n%100>=98 THEN 'F' ELSE 'T' END,{stamp},{id} FROM sequence; {seq} INSERT INTO text_messages SELECT {start_id}+n,'T',{sender},{message} FROM sequence WHERE n%100<98; {seq} INSERT INTO file_transfers SELECT {start_id}+n,'F',{sender},zeroblob(32),'synthetic-' || n || '.txt','',zeroblob(32),1000+n,n%2,2 FROM sequence WHERE n%100>=98;")).unwrap();
        } else if schema == 0 {
            exec(&api, raw, &format!("{seq} INSERT INTO history SELECT {start_id}+n,{stamp},{id},{sender},{message} FROM sequence;")).unwrap();
        } else {
            exec(&api, raw, &format!("{seq} INSERT INTO history SELECT {start_id}+n,{stamp},{id},{sender},{message},CASE WHEN n%100>=98 THEN {start_id}+n ELSE NULL END FROM sequence; {seq} INSERT INTO file_transfers SELECT {start_id}+n,{id},zeroblob(32),'synthetic-' || n || '.txt','',zeroblob(32),1000+n,n%2,2 FROM sequence WHERE n%100>=98;")).unwrap();
        }
        start_id += count;
    }
    exec(
        &api,
        raw,
        &format!(
            "COMMIT; CREATE INDEX chat_id_idx ON history(chat_id); PRAGMA user_version={schema};"
        ),
    )
    .unwrap();
    drop(database);
}

fn savedata(root: &Path) -> (Vec<u8>, [u8; 32]) {
    let route = ProxyRoute {
        proxy_type: 2,
        host: "127.0.0.1".to_string(),
        port: 9,
        label: "offline fixture".to_string(),
    };
    let handle = crate::create_tox_handle(
        root.join("Synthetic.tox"),
        None,
        Some(&route),
        &NetworkSettings::default(),
        None,
    )
    .unwrap();
    let mut address = [0; 38];
    unsafe { crate::tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
    let mut self_key = [0; 32];
    self_key.copy_from_slice(&address[..32]);
    for index in 0..FRIEND_COUNT {
        let mut error = 0;
        let number = unsafe {
            crate::tox_friend_add_norequest(
                handle.instance.as_ptr(),
                friend_key(index).as_ptr(),
                &mut error,
            )
        };
        assert_eq!(error, 0);
        assert_eq!(number as usize, index);
    }
    let size = unsafe { crate::tox_get_savedata_size(handle.instance.as_ptr()) };
    let mut bytes = vec![0; size];
    unsafe {
        crate::tox_get_savedata(handle.instance.as_ptr(), bytes.as_mut_ptr());
        crate::tox_kill(handle.instance.as_ptr());
    }
    (bytes, self_key)
}

fn imported_state(root: &Path, volume: Arc<KaiProfileVolume>, savedata: Vec<u8>) -> ToxState {
    let data = root.join("global-data");
    fs::create_dir_all(data.join("logs")).unwrap();
    fs::write(
        data.join("tor-settings.json"),
        br#"{"enabled":false,"transport":"none","bridgeLines":""}"#,
    )
    .unwrap();
    let paths = ProfilePaths::new_with_volume(
        root.to_path_buf(),
        volume.namespace_root().join("data"),
        volume.namespace_root().join("profile.tox"),
        Some(Arc::clone(&volume)),
    )
    .unwrap();
    profiles::write_file(&paths.profile_path, &savedata).unwrap();
    ToxState::new_for_profile(
        paths,
        crate::TorManager::new(root.to_path_buf(), data.clone(), data.join("logs")).unwrap(),
        Arc::new(Mutex::new(ProxySettings {
            mode: "socks5".to_string(),
            host: "127.0.0.1".to_string(),
            port: 9,
            username: String::new(),
            password: String::new(),
        })),
        Arc::new(Mutex::new(NetworkSettings::default())),
        None,
        Some(savedata),
        None,
        None,
    )
    .unwrap()
}

fn friends(state: &ToxState) -> HashMap<Vec<u8>, u32> {
    let guard = state.handle.lock().unwrap();
    let handle = guard.as_ref().unwrap();
    let count = unsafe { crate::tox_self_get_friend_list_size(handle.instance.as_ptr()) };
    assert_eq!(count, FRIEND_COUNT);
    let mut numbers = vec![0; count];
    unsafe { crate::tox_self_get_friend_list(handle.instance.as_ptr(), numbers.as_mut_ptr()) };
    numbers
        .into_iter()
        .map(|number| {
            let mut key = [0; 32];
            let mut error = 0;
            assert!(unsafe {
                crate::tox_friend_get_public_key(
                    handle.instance.as_ptr(),
                    number,
                    key.as_mut_ptr(),
                    &mut error,
                )
            });
            (key.to_vec(), number)
        })
        .collect()
}

fn assert_imported(state: &ToxState, large: bool, scan_all: bool) -> usize {
    let mapping = friends(state);
    let cache = state.friend_cache.lock().unwrap().clone();
    let mut total = 0;
    let mut first_id = 1;
    for index in 0..FRIEND_COUNT {
        let key = friend_key(index);
        let hex = crate::hex_upper(&key);
        let number = mapping[&key.to_vec()];
        let profile = &cache[&hex];
        assert_eq!(profile.local_alias, alias(index));
        assert!(profile.authorized);
        assert!(!profile.pending_authorization);
        assert_eq!(
            profile.display_name("Changed nickname from Tox"),
            alias(index)
        );
        let expected = row_count(index, large);
        let window = chat_history_store::window_registered(
            &state.history_path,
            number,
            &hex,
            Some(500),
            None,
            None,
        )
        .unwrap();
        assert_eq!(window.total, expected);
        assert!(window.messages.len() <= 500);
        total += window.total;
        let mut offset = 0;
        while offset < expected {
            let page = chat_history_store::page_registered(
                &state.history_path,
                number,
                &hex,
                offset,
                1000,
            )
            .unwrap();
            assert_eq!(page.total, expected);
            assert_eq!(page.offset, offset);
            for (within, message) in page.messages.iter().enumerate() {
                let ordinal = offset + within;
                assert_eq!(message.id, format!("qtox-{}", first_id + ordinal));
                assert_eq!(message.friend_public_key, hex);
                assert_eq!(message.friend_number, number);
                assert_eq!(message.mine, ordinal % 2 == 0);
                assert_eq!(
                    message.timestamp,
                    ((START_MS + ordinal as i64 * TEN_YEARS_MS / (expected - 1) as i64) / 1000)
                        as u64
                );
                assert_eq!(message.attachment.is_some(), ordinal % 100 >= 98);
                if message.attachment.is_none() {
                    assert!(message
                        .text
                        .contains(&format!("contact {index:03}, message {ordinal}:")));
                }
            }
            assert!(page.next_offset > offset);
            offset = page.next_offset;
            if !scan_all && offset < expected - 1 {
                offset = expected - 1;
            }
        }
        first_id += expected;
    }
    assert!(state.messages.lock().unwrap().len() <= FRIEND_COUNT * 82);
    total
}

#[test]
fn qtox_history_legacy_schemas_and_encrypted_settings_preserve_all_contacts() {
    let root = root("qtox-import-schemas");
    fs::create_dir_all(&root).unwrap();
    let (savedata, self_key) = savedata(&root);
    let cipher = profiles::ProfileCipher::new(PASSWORD).unwrap();
    let profile_path = root.join("Synthetic.tox");
    fs::write(&profile_path, cipher.encrypt(&savedata).unwrap()).unwrap();
    fs::write(
        profile_path.with_extension("ini"),
        cipher.encrypt(&settings_bytes()).unwrap(),
    )
    .unwrap();
    assert!(qtox_settings::read_friend_aliases(&profile_path, Some("incorrect password")).is_err());
    assert_eq!(
        qtox_settings::read_friend_aliases(&profile_path, Some(PASSWORD))
            .unwrap()
            .len(),
        FRIEND_COUNT
    );
    for schema in [0, 6, 10, 11] {
        let history = root.join(format!("schema-{schema}.db"));
        create_database(&history, None, &self_key, schema, false);
        let rows = read_qtox_history(&history, &runtime(), None, &self_key).unwrap();
        assert_eq!(rows.len(), FRIEND_COUNT * 113);
        let mut expected_keys = (0..FRIEND_COUNT).map(friend_key).collect::<Vec<_>>();
        expected_keys.sort();
        for (key, rows) in expected_keys.iter().zip(rows.chunks_exact(113)) {
            assert!(rows.iter().all(|row| row.chat_key == key.as_slice()));
            assert_eq!(rows[0].sender_key, self_key);
            assert_eq!(rows[1].sender_key, key.as_slice());
            assert_eq!(rows[0].timestamp_ms, START_MS);
            assert_eq!(rows[112].timestamp_ms, START_MS + TEN_YEARS_MS);
            assert_eq!(rows[99].file_name.is_some(), schema != 0);
        }
    }
    let history = root.join("Synthetic.db");
    create_database(&history, Some(PASSWORD), &self_key, 11, false);
    assert!(
        read_qtox_history(&history, &runtime(), Some("incorrect password"), &self_key).is_err()
    );
    let contacts = qtox_import::read_contacts(&profile_path, Some(PASSWORD), &savedata).unwrap();
    let container = root.join("imported/Profile.kai");
    let volume = KaiProfileVolume::create(container.clone(), Some(PASSWORD)).unwrap();
    let state = imported_state(&root, Arc::clone(&volume), savedata.clone());
    let mut missing_friend = friends(&state);
    missing_friend.remove(&friend_key(0).to_vec());
    assert_eq!(
        qtox_import::import_profile_data(
            &state,
            &contacts,
            Some(&history),
            &runtime(),
            Some(PASSWORD),
            &self_key,
            &missing_friend
        )
        .unwrap_err(),
        "QTOX_CONTACT_COUNT_MISMATCH"
    );
    assert!(state
        .friend_cache
        .lock()
        .unwrap()
        .values()
        .all(|profile| profile.local_alias.is_empty()));
    let report = qtox_import::import_profile_data(
        &state,
        &contacts,
        Some(&history),
        &runtime(),
        Some(PASSWORD),
        &self_key,
        &friends(&state),
    )
    .unwrap();
    assert_eq!(report.history_rows, FRIEND_COUNT * 113);
    assert_eq!(report.imported_rows, report.history_rows);
    assert_eq!(report.unmatched_rows, 0);
    assert_eq!(assert_imported(&state, false, true), report.imported_rows);
    state.checkpoint_profile(true).unwrap();
    let checkpoints = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = Arc::clone(&checkpoints);
    volume
        .set_durability_hook(crate::kai::KaiDurabilityHook::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }))
        .unwrap();
    {
        let handle = state.handle.lock().unwrap();
        let tox = handle.as_ref().unwrap().instance.as_ptr();
        // The real driver must bind all 128 imported contacts with a single
        // durable KAI write while it owns Tox, not 128 whole-history writes.
        crate::drive_pq_sessions(&state, tox);
        assert_eq!(checkpoints.load(Ordering::SeqCst), 1);
        for index in 0..FRIEND_COUNT {
            assert!(state
                .pq
                .contact_bound(index as u32, &crate::hex_upper(&friend_key(index))));
        }
        crate::drive_pq_sessions(&state, tox);
        assert_eq!(checkpoints.load(Ordering::SeqCst), 1);
    }
    drop(state);
    drop(volume);
    let reopened = KaiProfileVolume::open(container, Some(PASSWORD)).unwrap();
    let restarted = imported_state(&root, reopened, savedata);
    assert_eq!(
        assert_imported(&restarted, false, true),
        report.imported_rows
    );
    drop(restarted);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn qtox_duplicate_legacy_peer_keys_keep_chronology_across_import_batches() {
    const MESSAGE_COUNT: usize = 2_051;
    let root = root("qtox-duplicate-peer-order");
    fs::create_dir_all(&root).unwrap();
    let (savedata, self_key) = savedata(&root);
    let profile_path = root.join("Synthetic.tox");
    fs::write(&profile_path, &savedata).unwrap();
    fs::write(profile_path.with_extension("ini"), settings_bytes()).unwrap();
    let contacts = qtox_import::read_contacts(&profile_path, None, &savedata).unwrap();
    let key = friend_key(0);
    let hex = crate::hex_upper(&key);
    for schema in [0, 10] {
        let history = root.join(format!("schema-{schema}.db"));
        create_database(&history, None, &self_key, schema, false);
        let api = Api::load(&runtime().join("runtime/qtox-import/libsqlcipher-0.dll")).unwrap();
        let mut raw = ptr::null_mut();
        let cpath = CString::new(history.to_str().unwrap()).unwrap();
        assert_eq!(
            unsafe { (api.open_v2)(cpath.as_ptr(), &mut raw, 0x2 | 0x8000, ptr::null()) },
            0
        );
        let database = Database { api: &api, raw };
        exec(&api, raw, "BEGIN; DELETE FROM history;").unwrap();
        if schema >= 7 {
            exec(
                &api,
                raw,
                "DELETE FROM text_messages; DELETE FROM file_transfers;",
            )
            .unwrap();
        }
        let upper_peer = FRIEND_COUNT + 2;
        let address_peer = upper_peer + 1;
        let binary_peer = upper_peer + 2;
        exec(&api, raw, &format!("INSERT INTO peers VALUES({upper_peer},'{hex}'),({address_peer},'{hex}000000000000'),({binary_peer},X'{hex}');")).unwrap();
        let sequence = format!("WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n+1<{MESSAGE_COUNT})");
        let chat = format!("CASE n%4 WHEN 0 THEN 2 WHEN 1 THEN {upper_peer} WHEN 2 THEN {address_peer} ELSE {binary_peer} END");
        // Interleave all four spellings, including equal timestamps that must
        // use the source ID as their stable secondary order.
        let timestamp = format!("{START_MS}+(n/2)*1000");
        if schema >= 7 {
            exec(&api, raw, &format!("{sequence} INSERT INTO history SELECT n+1,'T',{timestamp},{chat} FROM sequence; {sequence} INSERT INTO text_messages SELECT n+1,'T',1,'interleaved-' || n FROM sequence;")).unwrap();
        } else {
            exec(&api, raw, &format!("{sequence} INSERT INTO history SELECT n+1,{timestamp},{chat},1,'interleaved-' || n FROM sequence;")).unwrap();
        }
        exec(&api, raw, "COMMIT;").unwrap();
        drop(database);
        drop(api);

        let rows = read_qtox_history(&history, &runtime(), None, &self_key).unwrap();
        assert_eq!(rows.len(), MESSAGE_COUNT);
        for (ordinal, row) in rows.iter().enumerate() {
            assert_eq!(row.source_id, (ordinal + 1) as i64);
            assert_eq!(row.chat_key, key);
            assert_eq!(row.timestamp_ms, START_MS + (ordinal / 2) as i64 * 1000);
        }
        let directory = root.join(format!("import-{schema}"));
        let container = directory.join("Profile.kai");
        let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
        let state = imported_state(&directory, Arc::clone(&volume), savedata.clone());
        let mapping = friends(&state);
        let report = qtox_import::import_profile_data(
            &state,
            &contacts,
            Some(&history),
            &runtime(),
            None,
            &self_key,
            &mapping,
        )
        .unwrap();
        assert_eq!(report.imported_rows, MESSAGE_COUNT);
        assert_eq!(report.unmatched_rows, 0);
        state.checkpoint_profile(true).unwrap();
        drop(state);
        drop(volume);
        let reopened = KaiProfileVolume::open(container, None).unwrap();
        let restarted = imported_state(&directory, reopened, savedata.clone());
        let number = friends(&restarted)[&key.to_vec()];
        let mut offset = 0;
        while offset < MESSAGE_COUNT {
            let page = chat_history_store::page_registered(
                &restarted.history_path,
                number,
                &hex,
                offset,
                257,
            )
            .unwrap();
            assert_eq!(page.total, MESSAGE_COUNT);
            for (within, message) in page.messages.iter().enumerate() {
                let ordinal = offset + within;
                assert_eq!(message.id, format!("qtox-{}", ordinal + 1));
                assert_eq!(message.text, format!("interleaved-{ordinal}"));
                assert_eq!(message.friend_public_key, hex);
                assert_eq!(
                    message.timestamp,
                    START_MS as u64 / 1000 + (ordinal / 2) as u64
                );
            }
            assert!(page.next_offset > offset);
            offset = page.next_offset;
        }
        drop(restarted);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn imported_local_alias_is_durable_and_network_name_updates_stay_separate() {
    let profile = CachedFriendProfile {
        name: "Old network name".to_string(),
        local_alias: "Личное имя 🚀".to_string(),
        ..CachedFriendProfile::default()
    };
    let mut restored: CachedFriendProfile =
        serde_json::from_slice(&serde_json::to_vec(&profile).unwrap()).unwrap();
    restored.name = "New network name".to_string();
    assert_eq!(restored.display_name("Another live name"), "Личное имя 🚀");
    assert_eq!(restored.display_name(""), "Личное имя 🚀");
    let legacy: CachedFriendProfile =
        serde_json::from_str(r#"{"name":"Legacy nickname"}"#).unwrap();
    assert_eq!(legacy.display_name(""), "Legacy nickname");
    assert_eq!(legacy.display_name("Current nickname"), "Current nickname");
}

#[test]
#[ignore = "Explicit large qTox import gate; generates and validates 1,048,576 rows in plain and encrypted profiles"]
fn qtox_large_profile_import_decade() {
    let requested = std::env::var_os("KAIGEN_QTOX_LARGE_FIXTURE_OUTPUT").map(PathBuf::from);
    let root = requested.clone().unwrap_or_else(|| root("qtox-decade"));
    assert!(!root.exists(), "refusing to overwrite a fixture directory");
    fs::create_dir_all(&root).unwrap();
    let start = Instant::now();
    let (savedata, self_key) = savedata(&root);
    let total: usize = (0..FRIEND_COUNT).map(|index| row_count(index, true)).sum();
    assert_eq!(total, 1_048_576);
    let mut cases = Vec::new();
    for encrypted in [false, true] {
        let name = if encrypted { "encrypted" } else { "plain" };
        let directory = root.join(name);
        fs::create_dir_all(&directory).unwrap();
        let password = encrypted.then_some(PASSWORD);
        let profile = directory.join("SyntheticDecade.tox");
        let history = profile.with_extension("db");
        let cipher = password.map(|password| profiles::ProfileCipher::new(password).unwrap());
        fs::write(
            &profile,
            cipher
                .as_ref()
                .map(|cipher| cipher.encrypt(&savedata).unwrap())
                .unwrap_or_else(|| savedata.clone()),
        )
        .unwrap();
        let settings = settings_bytes();
        fs::write(
            profile.with_extension("ini"),
            cipher
                .as_ref()
                .map(|cipher| cipher.encrypt(&settings).unwrap())
                .unwrap_or(settings),
        )
        .unwrap();
        create_database(&history, password, &self_key, 11, true);
        println!("qTox {name}: generated {FRIEND_COUNT} contacts and {total} rows");
        let contacts = qtox_import::read_contacts(&profile, password, &savedata).unwrap();
        let container = root.join("verified-import").join(name).join("Profile.kai");
        let volume = KaiProfileVolume::create(container.clone(), password).unwrap();
        let state = imported_state(&directory, Arc::clone(&volume), savedata.clone());
        let imported_at = Instant::now();
        let report = qtox_import::import_profile_data(
            &state,
            &contacts,
            Some(&history),
            &runtime(),
            password,
            &self_key,
            &friends(&state),
        )
        .unwrap();
        let import_ms = imported_at.elapsed().as_millis();
        assert_eq!(report.contacts, FRIEND_COUNT);
        assert_eq!(report.aliases, FRIEND_COUNT);
        assert_eq!(report.imported_rows, total);
        assert_eq!(report.history_rows, total);
        assert_eq!(report.unmatched_rows, 0);
        assert_eq!(assert_imported(&state, true, true), total);
        state.checkpoint_profile(true).unwrap();
        drop(state);
        drop(volume);
        let reopened = KaiProfileVolume::open(container, password).unwrap();
        let restarted = imported_state(&directory, reopened, savedata.clone());
        assert_eq!(assert_imported(&restarted, true, false), total);
        drop(restarted);
        cases.push(serde_json::json!({"kind":name,"contacts":FRIEND_COUNT,"aliases":FRIEND_COUNT,"messages":total,"unmatched":0,"importMs":import_ms,"coldReopen":"PASS","allRowsVerified":true,"historyBytes":fs::metadata(&history).unwrap().len()}));
        println!("qTox {name}: import + every row + cold reopen PASS, import {import_ms} ms");
    }
    let manifest = serde_json::json!({"schemaVersion":1,"synthetic":true,"startTimestampMs":START_MS,"endTimestampMs":START_MS+TEN_YEARS_MS,"contacts":FRIEND_COUNT,"rows":total,"disposablePassword":PASSWORD,"elapsedMs":start.elapsed().as_millis(),"cases":cases});
    fs::write(
        root.join("fixture-manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    if requested.is_none() {
        fs::remove_dir_all(root).unwrap();
    }
}
