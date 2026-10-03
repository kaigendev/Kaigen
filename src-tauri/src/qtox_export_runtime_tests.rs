use super::*;
use std::cell::RefCell;
use std::time::{SystemTime, UNIX_EPOCH};

thread_local! {
    static AFTER_RECORD: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
}

pub(super) fn after_record_snapshot() {
    let action = AFTER_RECORD.with(|value| value.borrow_mut().take());
    if let Some(action) = action {
        action();
    }
}

#[cfg(target_os = "windows")]
fn record_native_runtime() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetModuleHandleW(name: *const u16) -> *mut c_void;
            fn GetModuleFileNameW(module: *mut c_void, path: *mut u16, size: u32) -> u32;
        }
        for library in ["toxcore.dll", "pthreadVC3.dll"] {
            let name = format!("{library}\0").encode_utf16().collect::<Vec<_>>();
            let module = unsafe { GetModuleHandleW(name.as_ptr()) };
            assert!(!module.is_null(), "native module must be loaded: {library}");
            let mut path = vec![0u16; 32768];
            let length = unsafe { GetModuleFileNameW(module, path.as_mut_ptr(), path.len() as u32) }
                as usize;
            assert!(length > 0 && length < path.len());
            println!(
                "QTOX_EXPORT_NATIVE_RUNTIME {library}={}",
                String::from_utf16(&path[..length]).unwrap()
            );
        }
    });
}

struct Fixture {
    root: PathBuf,
    registry: Arc<Mutex<ProfileRegistry>>,
    profiles: Arc<Mutex<HashMap<String, Arc<ToxState>>>>,
    states: Vec<Arc<ToxState>>,
    savedata: Vec<Vec<u8>>,
    keys: Vec<[u8; 32]>,
}

impl Fixture {
    fn new(encrypted: bool) -> Self {
        #[cfg(target_os = "windows")]
        record_native_runtime();
        let root = std::env::temp_dir().join(format!(
            "kaigen-qtox-export-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data = root.join("data");
        fs::create_dir_all(data.join("logs")).unwrap();
        atomic_write(
            &data.join("tor-settings.json"),
            br#"{"enabled":false,"transport":"none","bridgeLines":""}"#,
        )
        .unwrap();
        let tor = TorManager::new(root.clone(), data.clone(), data.join("logs")).unwrap();
        let network = Arc::new(Mutex::new(NetworkSettings {
            udp_enabled: false,
            ipv6_enabled: false,
            local_discovery_enabled: false,
        }));
        let proxy = Arc::new(Mutex::new(ProxySettings::default()));
        let mut states = Vec::new();
        let mut records = Vec::new();
        let mut savedata = Vec::new();
        let mut keys = Vec::new();
        for (index, id) in ["first", "second"].into_iter().enumerate() {
            let password = (encrypted && index == 0).then_some("Synthetic-export-password");
            let volume =
                KaiProfileVolume::create(root.join(format!("profiles/{id}/{id}.kai")), password)
                    .unwrap();
            let state = Arc::new(
                ToxState::new_for_profile(
                    ProfilePaths::new_with_volume(
                        root.clone(),
                        volume.namespace_root().join("data"),
                        volume.namespace_root().join("profile.tox"),
                        Some(volume),
                    )
                    .unwrap(),
                    tor.clone(),
                    Arc::clone(&proxy),
                    Arc::clone(&network),
                    None,
                    None,
                    None,
                    Some(id),
                )
                .unwrap(),
            );
            initialize_created_profile_offline(&state).unwrap();
            let guard = state.handle.lock().unwrap();
            let handle = guard.as_ref().unwrap();
            let mut address = [0u8; 38];
            unsafe { tox_self_get_address(handle.instance.as_ptr(), address.as_mut_ptr()) };
            let mut key = [0u8; 32];
            key.copy_from_slice(&address[..32]);
            keys.push(key);
            let friend_key = [0x55 + index as u8; 32];
            let mut error = 0;
            let friend = unsafe {
                tox_friend_add_norequest(handle.instance.as_ptr(), friend_key.as_ptr(), &mut error)
            };
            assert_eq!(error, 0);
            let mut bytes = vec![0u8; unsafe { tox_get_savedata_size(handle.instance.as_ptr()) }];
            unsafe { tox_get_savedata(handle.instance.as_ptr(), bytes.as_mut_ptr()) };
            savedata.push(bytes);
            drop(guard);
            atomic_write(&state.avatars_dir.join("self-100.png"), avatar(index, true)).unwrap();
            atomic_write(
                &state.avatars_dir.join(format!("{friend}-100.png")),
                avatar(index, false),
            )
            .unwrap();
            atomic_write(
                &state.avatars_dir.join(format!("{friend}-999.png.part")),
                b"partial-canary",
            )
            .unwrap();
            atomic_write(
                &state.avatars_dir.join("unrelated-secret.txt"),
                b"excluded-secret-canary",
            )
            .unwrap();
            state.checkpoint_profile(true).unwrap();
            records.push(ProfileRecord {
                id: id.into(),
                name: format!("{id}/ unsafe:name"),
                file: format!("{id}.kai"),
                data_directory: id.into(),
                encrypted: password.is_some(),
                enabled: true,
                imported_from: None,
                created_at: 1,
            });
            states.push(state);
        }
        let profiles = Arc::new(Mutex::new(
            [
                ("first".into(), Arc::clone(&states[0])),
                ("second".into(), Arc::clone(&states[1])),
            ]
            .into_iter()
            .collect(),
        ));
        Self {
            root,
            registry: Arc::new(Mutex::new(ProfileRegistry {
                version: 1,
                active_profile_id: Some("first".into()),
                profiles: records,
            })),
            profiles,
            states,
            savedata,
            keys,
        }
    }

    fn export(
        &self,
        profile: Option<&str>,
        password: Option<&str>,
    ) -> Result<QtoxProfileExport, String> {
        export_qtox_profile_blocking(
            Arc::clone(&self.registry),
            Arc::clone(&self.profiles),
            profile.map(str::to_owned),
            password.map(str::to_owned),
        )
    }

    fn check(&self, exported: QtoxProfileExport, index: usize, encrypted: bool) {
        let record = &self.registry.lock().unwrap().profiles[index];
        let name = profiles::safe_component(&record.name);
        assert_eq!(
            exported.file_name,
            format!("{name}-qtox.zip"),
            "filename belongs to requested owner"
        );
        assert!(!exported
            .bytes
            .windows(b"excluded-secret-canary".len())
            .any(|w| w == b"excluded-secret-canary"));
        assert!(!exported
            .bytes
            .windows(b"Synthetic-export-password".len())
            .any(|w| w == b"Synthetic-export-password"));
        if encrypted {
            for secret in [
                self.savedata[index].as_slice(),
                avatar(index, true),
                avatar(index, false),
            ] {
                assert!(
                    !exported
                        .bytes
                        .windows(secret.len())
                        .any(|bytes| bytes == secret),
                    "encrypted archive must not contain plaintext profile/avatar bytes"
                );
            }
        }
        let archive_path = self.root.join("result.zip");
        fs::write(&archive_path, &exported.bytes).unwrap();
        let archive = qtox_zip_import::extract(&archive_path, &self.root).unwrap();
        assert_eq!(
            archive.profile_path.file_name().unwrap().to_string_lossy(),
            format!("{name}.tox")
        );
        let profile = fs::read(&archive.profile_path).unwrap();
        assert_eq!(profiles::is_encrypted(&profile), encrypted);
        let plaintext = if encrypted {
            assert!(ProfileCipher::unlock(&profile, "wrong-export-password").is_err());
            ProfileCipher::unlock(&profile, "Synthetic-export-password")
                .unwrap()
                .decrypt(&profile)
                .unwrap()
        } else {
            profile
        };
        assert!(
            plaintext == self.savedata[index],
            "native savedata belongs to requested owner"
        );
        let material = qtox_zip_import::read_material(
            &archive_path,
            encrypted.then_some("Synthetic-export-password"),
        )
        .unwrap();
        assert!(
            material.savedata == self.savedata[index],
            "imported savedata matches owner"
        );
        assert_eq!(
            material.data_files.len(),
            2,
            "only self/friend avatars are exported"
        );
        for (owner, expected) in [
            (self.keys[index], avatar(index, true)),
            ([0x55 + index as u8; 32], avatar(index, false)),
        ] {
            let filename = qtox_avatar_name(&owner, &self.keys[index], encrypted).unwrap();
            let bytes = &material
                .data_files
                .iter()
                .find(|(path, _)| {
                    path.eq_ignore_ascii_case(&format!("qtox-import/avatars/{filename}"))
                })
                .unwrap()
                .1;
            let plain = if encrypted {
                assert!(profiles::is_encrypted(bytes));
                assert_ne!(bytes, expected);
                ProfileCipher::unlock(bytes, "Synthetic-export-password")
                    .unwrap()
                    .decrypt(bytes)
                    .unwrap()
            } else {
                bytes.clone()
            };
            assert_eq!(plain, expected, "avatar bytes roundtrip exactly");
        }
    }
}

fn avatar(index: usize, own: bool) -> &'static [u8] {
    match (index, own) {
        (0, true) => b"\x89PNG\r\n\x1a\nfirst-self-canary",
        (0, false) => b"\x89PNG\r\n\x1a\nfirst-friend-canary",
        (1, true) => b"\x89PNG\r\n\x1a\nsecond-self-canary",
        _ => b"\x89PNG\r\n\x1a\nsecond-friend-canary",
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        AFTER_RECORD.with(|value| value.borrow_mut().take());
        self.profiles.lock().unwrap().clear();
        for state in &self.states {
            state.stop();
            chat_history_store::unregister(&state.history_path);
        }
        self.states.clear();
        let _ = flush_deferred_profile_writes();
        assert!(
            self.root.starts_with(std::env::temp_dir())
                && self
                    .root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("kaigen-qtox-export-")
        );
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn explicit_owner_survives_active_switch_before_worker() {
    let fixture = Fixture::new(false);
    fixture.registry.lock().unwrap().active_profile_id = Some("second".into());
    fixture.check(fixture.export(Some("first"), None).unwrap(), 0, false);
}

#[test]
fn active_fallback_keeps_one_owner_across_record_state_race() {
    let fixture = Fixture::new(false);
    let registry = Arc::clone(&fixture.registry);
    AFTER_RECORD.with(|value| {
        *value.borrow_mut() = Some(Box::new(move || {
            registry.lock().unwrap().active_profile_id = Some("second".into());
        }))
    });
    fixture.check(fixture.export(None, None).unwrap(), 0, false);
}

#[test]
fn encrypted_rejects_missing_wrong_password_then_retry_roundtrips() {
    let fixture = Fixture::new(true);
    fixture.registry.lock().unwrap().active_profile_id = Some("second".into());
    for password in [None, Some("")] {
        assert_eq!(
            fixture.export(Some("first"), password).err().unwrap(),
            "PROFILE_PASSWORD_REQUIRED"
        );
    }
    assert_eq!(
        fixture
            .export(Some("first"), Some("wrong-export-password"))
            .err()
            .unwrap(),
        "PROFILE_PASSWORD_INVALID"
    );
    fixture.check(
        fixture
            .export(Some("first"), Some("Synthetic-export-password"))
            .unwrap(),
        0,
        true,
    );
    fixture.check(
        fixture
            .export(Some("first"), Some("Synthetic-export-password"))
            .unwrap(),
        0,
        true,
    );
}

#[test]
fn explicit_unknown_unloaded_and_removed_owner_never_fall_back() {
    let fixture = Fixture::new(false);
    assert_eq!(
        fixture.export(Some("unknown"), None).err().unwrap(),
        "PROFILE_NOT_FOUND"
    );
    fixture.profiles.lock().unwrap().remove("first");
    fixture.registry.lock().unwrap().active_profile_id = Some("second".into());
    assert_eq!(
        fixture.export(Some("first"), None).err().unwrap(),
        "PROFILE_NOT_LOADED"
    );
    fixture.registry.lock().unwrap().active_profile_id = None;
    assert_eq!(
        fixture.export(None, None).err().unwrap(),
        "NO_ACTIVE_PROFILE"
    );
    fixture.check(fixture.export(Some("second"), None).unwrap(), 1, false);
}

#[test]
fn owner_unloaded_after_record_snapshot_fails_closed_then_retries() {
    let fixture = Fixture::new(false);
    let profiles = Arc::clone(&fixture.profiles);
    let registry = Arc::clone(&fixture.registry);
    AFTER_RECORD.with(|value| {
        *value.borrow_mut() = Some(Box::new(move || {
            profiles.lock().unwrap().remove("first");
            registry.lock().unwrap().active_profile_id = Some("second".into());
        }))
    });
    assert_eq!(
        fixture.export(Some("first"), None).err().unwrap(),
        "PROFILE_NOT_LOADED"
    );
    fixture
        .profiles
        .lock()
        .unwrap()
        .insert("first".into(), Arc::clone(&fixture.states[0]));
    fixture.check(fixture.export(Some("first"), None).unwrap(), 0, false);
}
