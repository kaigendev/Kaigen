use super::*;
use std::sync::atomic::AtomicUsize;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    states: Vec<Arc<ToxState>>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "kaigen-avatar-runtime-{}-{}",
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
        let states = ["alpha", "beta"]
            .into_iter()
            .map(|id| {
                let volume =
                    KaiProfileVolume::create(root.join(format!("profiles/{id}/{id}.kai")), None)
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
                // Let the resource monitor observe the loaded native modules.
                std::thread::sleep(Duration::from_millis(150));
                write_profile_local_state(
                    &profile_local_state_path(&state).unwrap(),
                    &serde_json::json!({"owner": id, "unrelated": {"keep": true}}),
                )
                .unwrap();
                profiles::write_file(&state.avatars_dir.join("7-contact.png"), b"contact-canary")
                    .unwrap();
                state.checkpoint_profile(true).unwrap();
                state
            })
            .collect();
        Self { root, states }
    }

    fn update(&self, index: usize, image: Option<Vec<u8>>) -> Result<usize, String> {
        let (data_url, filename, bytes) = match image {
            Some(bytes) => (Some(url(&bytes)), Some("avatar.png".into()), Some(bytes)),
            None => (None, None, None),
        };
        set_profile_avatar_blocking(
            self.loaded(),
            ["alpha", "beta"][index].into(),
            data_url,
            filename,
            bytes,
        )
    }

    fn loaded(&self) -> Arc<Mutex<HashMap<String, Arc<ToxState>>>> {
        Arc::new(Mutex::new(
            [
                ("alpha".into(), Arc::clone(&self.states[0])),
                ("beta".into(), Arc::clone(&self.states[1])),
            ]
            .into_iter()
            .collect(),
        ))
    }

    fn cold(&self, index: usize, expected: Option<&[u8]>) {
        // Reopen an exact disk snapshot without flushing the still-live volume.
        let state = &self.states[index];
        let live = state.profile_volume.as_ref().unwrap();
        let snapshot = self.root.join(format!("cold-{index}.kai"));
        fs::copy(live.container_path(), &snapshot).unwrap();
        fs::copy(
            live.key_path(),
            self.root.join(format!("cold-{index}.kai.keys")),
        )
        .unwrap();
        let volume = KaiProfileVolume::open(snapshot, None).unwrap();
        let local_path = volume.namespace_root().join(
            profile_local_state_path(state)
                .unwrap()
                .strip_prefix(live.namespace_root())
                .unwrap(),
        );
        let avatars = volume.namespace_root().join(
            state
                .avatars_dir
                .strip_prefix(live.namespace_root())
                .unwrap(),
        );
        let local: Value = serde_json::from_slice(&volume.read(&local_path).unwrap()).unwrap();
        assert_eq!(local["unrelated"]["keep"], true);
        assert_eq!(local["owner"], if index == 0 { "alpha" } else { "beta" });
        assert_eq!(
            volume.read(&avatars.join("7-contact.png")).unwrap(),
            b"contact-canary"
        );
        let own = volume
            .list(&avatars)
            .unwrap()
            .into_iter()
            .filter(|entry| {
                entry.is_file
                    && entry
                        .path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("self-")
            })
            .collect::<Vec<_>>();
        if let Some(bytes) = expected {
            assert_eq!(
                local["profileAvatar"],
                url(bytes),
                "local avatar must survive immediate cold open"
            );
            assert_eq!(own.len(), 1);
            assert_eq!(
                volume.read(&own[0].path).unwrap(),
                bytes,
                "PNG matches local avatar after cold open"
            );
        } else {
            assert!(local.get("profileAvatar").is_none_or(Value::is_null));
            assert!(own.is_empty(), "clear must survive immediate cold open");
        }
        volume.discard();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for state in &self.states {
            if let Some(volume) = &state.profile_volume {
                volume.discard();
            }
        }
        self.states.clear();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn png(color: u8) -> Vec<u8> {
    png_size(color, 1, 1)
}

fn png_size(color: u8, width: u32, height: u32) -> Vec<u8> {
    use std::io::Write;
    fn chunk(bytes: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(data);
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        bytes.extend_from_slice(&crc.finalize().to_be_bytes());
    }
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = width.to_be_bytes().to_vec();
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut bytes, b"IHDR", &header);
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    for _ in 0..height {
        encoder.write_all(&[0]).unwrap();
        for _ in 0..width {
            encoder.write_all(&[color, 0, 0, 255]).unwrap();
        }
    }
    chunk(&mut bytes, b"IDAT", &encoder.finish().unwrap());
    chunk(&mut bytes, b"IEND", &[]);
    bytes
}

fn url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64_basic(bytes))
}

#[test]
fn normalized_avatar_payload_rejects_mismatch_and_non_png() {
    let a = png(20);
    let b = png(80);
    assert!(
        validate_profile_avatar_update(Some(url(&a)), Some("avatar.png".into()), Some(b)).is_err(),
        "data URL must match PNG bytes"
    );
    assert!(validate_profile_avatar_update(
        Some(url(b"garbage")),
        Some("avatar.png".into()),
        Some(b"garbage".to_vec())
    )
    .is_err());
}

#[test]
fn avatar_set_rejection_preserves_existing_file() {
    let fixture = Fixture::new();
    let a = png(20);
    let b = png(80);
    fixture.update(0, Some(a.clone())).unwrap();
    let state = &fixture.states[0];
    profiles::write_file(&profile_local_state_path(state).unwrap(), b"invalid-json").unwrap();
    assert!(fixture.update(0, Some(b)).is_err());
    assert_eq!(
        profiles::read_file(&current_self_avatar_path(&state.avatars_dir).unwrap()).unwrap(),
        a,
        "failed set must retain old avatar"
    );
}

#[test]
fn avatar_clear_rejection_preserves_existing_file() {
    let fixture = Fixture::new();
    let a = png(20);
    fixture.update(0, Some(a.clone())).unwrap();
    let state = &fixture.states[0];
    profiles::write_file(&profile_local_state_path(state).unwrap(), b"invalid-json").unwrap();
    assert!(fixture.update(0, None).is_err());
    assert_eq!(
        current_self_avatar_path(&state.avatars_dir).map(|p| profiles::read_file(&p).unwrap()),
        Some(a),
        "failed clear must retain old avatar"
    );
}

#[test]
fn avatar_managed_owner_set_replace_clear_is_durable_and_isolated() {
    let fixture = Fixture::new();
    let a = png(20);
    let b = png(80);
    fixture.update(1, Some(b.clone())).unwrap();
    fixture.cold(1, Some(&b));
    fixture.cold(0, None);
    fixture.update(0, Some(a.clone())).unwrap();
    fixture.cold(0, Some(&a));
    fixture.cold(1, Some(&b));
    fixture.update(0, Some(b.clone())).unwrap();
    fixture.cold(0, Some(&b));
    fixture.cold(1, Some(&b));
    fixture.update(0, None).unwrap();
    fixture.cold(0, None);
    fixture.cold(1, Some(&b));
}

#[test]
fn avatar_unknown_or_unloaded_owner_cannot_fall_back() {
    let fixture = Fixture::new();
    let loaded = fixture.loaded();
    loaded.lock().unwrap().remove("alpha");
    for id in ["alpha", "missing", ""] {
        assert_eq!(
            set_profile_avatar_blocking(Arc::clone(&loaded), id.into(), None, None, None)
                .unwrap_err(),
            "PROFILE_NOT_LOADED"
        );
    }
    fixture.cold(0, None);
    fixture.cold(1, None);
}

#[test]
fn avatar_outer_checkpoint_failure_restores_set_and_clear_before_later_checkpoint() {
    let fixture = Fixture::new();
    let a = png(20);
    let b = png(80);
    fixture.update(0, Some(a.clone())).unwrap();
    fixture.update(1, Some(b.clone())).unwrap();
    let volume = fixture.states[0].profile_volume.as_ref().unwrap();
    for next in [Some(b.clone()), None] {
        let calls = Arc::new(AtomicUsize::new(0));
        let callback_calls = Arc::clone(&calls);
        let callback_volume = Arc::downgrade(volume);
        volume
            .set_durability_hook(kai::KaiDurabilityHook::new(move || {
                if callback_calls.fetch_add(1, Ordering::AcqRel) == 0 {
                    let volume = callback_volume.upgrade().unwrap();
                    volume
                        .write(
                            &volume
                                .namespace_root()
                                .join("data/concurrent-unrelated.txt"),
                            b"keep-concurrent",
                        )
                        .unwrap();
                    Err("SYNTHETIC_AVATAR_CHECKPOINT_FAILURE".into())
                } else {
                    Ok(())
                }
            }))
            .unwrap();
        assert_eq!(
            fixture.update(0, next).unwrap_err(),
            "SYNTHETIC_AVATAR_CHECKPOINT_FAILURE"
        );
        assert_eq!(
            calls.load(Ordering::Acquire),
            2,
            "rejected generation must be durably rolled back"
        );
        assert_eq!(
            volume
                .read(
                    &volume
                        .namespace_root()
                        .join("data/concurrent-unrelated.txt")
                )
                .unwrap(),
            b"keep-concurrent"
        );
        assert_eq!(
            preferred_profile_avatar(Some(&fixture.states[0]), None),
            Some(url(&a))
        );
        fixture.cold(0, Some(&a));
        fixture.cold(1, Some(&b));
        profiles::write_file(
            &volume.namespace_root().join("data/later-unrelated.txt"),
            b"unrelated",
        )
        .unwrap();
        volume.checkpoint(true).unwrap();
        fixture.cold(0, Some(&a));
        fixture.cold(1, Some(&b));
    }
}

#[test]
fn normalized_avatar_png_bounds_and_corruption_are_rejected() {
    let bytes = png(20);
    assert!(normalized_avatar_png_valid(&bytes));
    for length in 0..bytes.len() {
        assert!(!normalized_avatar_png_valid(&bytes[..length]));
    }
    let mut corrupt = bytes.clone();
    corrupt[16] ^= 1;
    assert!(!normalized_avatar_png_valid(&corrupt));
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(!normalized_avatar_png_valid(&trailing));
    for (width, height) in [(128, 512), (512, 51), (512, 512)] {
        let bounded = png_size(20, width, height);
        assert!(
            normalized_avatar_png_valid(&bounded),
            "accepted canvas dimensions {width}x{height}"
        );
    }
    for (width, height) in [(0, 1), (1, 0), (513, 1), (1, 513)] {
        assert!(!normalized_avatar_png_valid(&png_size(20, width, height)));
    }
    let mut boundary = bytes[..bytes.len() - 12].to_vec();
    let padding = vec![0; 65536 - bytes.len() - 12];
    boundary.extend_from_slice(&(padding.len() as u32).to_be_bytes());
    boundary.extend_from_slice(b"tEXt");
    boundary.extend_from_slice(&padding);
    let mut crc = crc32fast::Hasher::new();
    crc.update(b"tEXt");
    crc.update(&padding);
    boundary.extend_from_slice(&crc.finalize().to_be_bytes());
    boundary.extend_from_slice(&bytes[bytes.len() - 12..]);
    assert_eq!(boundary.len(), 65536);
    assert!(validate_profile_avatar_update(
        Some(url(&boundary)),
        Some("avatar.png".into()),
        Some(boundary)
    )
    .is_ok());
    let oversized = vec![0; 65537];
    assert_eq!(
        validate_profile_avatar_update(
            Some(url(&oversized)),
            Some("avatar.png".into()),
            Some(oversized)
        )
        .err()
        .unwrap(),
        "PROFILE_AVATAR_SIZE_INVALID"
    );
}

#[test]
fn avatar_disk_checkpoint_failure_keeps_hot_and_cold_state() {
    let fixture = Fixture::new();
    let a = png(20);
    let b = png(80);
    fixture.update(0, Some(a.clone())).unwrap();
    fixture.update(1, Some(b.clone())).unwrap();
    let volume = fixture.states[0].profile_volume.as_ref().unwrap();
    let container = volume.container_path();
    let backup = fixture.root.join("synthetic-container-backup.kai");
    for next in [Some(b.clone()), None] {
        fs::rename(container, &backup).unwrap();
        fs::create_dir(container).unwrap();
        let failed = fixture.update(0, next);
        fs::remove_dir(container).unwrap();
        fs::rename(&backup, container).unwrap();
        assert!(failed.is_err(), "disk barrier must reject set and clear");
        assert_eq!(
            preferred_profile_avatar(Some(&fixture.states[0]), None),
            Some(url(&a))
        );
        fixture.cold(0, Some(&a));
        fixture.cold(1, Some(&b));
        volume.checkpoint(true).unwrap();
        fixture.cold(0, Some(&a));
        fixture.cold(1, Some(&b));
    }
}

#[test]
fn actual_browser_normalized_png_payloads_pass_native_validation() {
    use base64::Engine;
    // Production canvas outputs captured from four synthetic image formats.
    let samples = [
        ("image/png", "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAYAAABpYH0BAAAA1ElEQVR4AezUsQ2CQBhH8S9XWZjYmTiQ9m7hBk7iAsbeBQgD0NIwAWvADOQdlwOeyZXPHD/+IY3tYypxvp/ndLu/dndS+EMCAiK+CAEFhAIwd4ECQgGYu0ABoQDMXaCAUADmLlDAxQJZg/T+X6PE+XWXrBev5c9SM5yjxOnHUy3PnPUefgMhp4ACQgGYu0ABoQDMXaCAUADmLlBAKABzF3gMQPiUK+YuEOIKKCAUgLkLFBAKwNwFCggFYO4CBYQCMHeBAkIBmLvAagHhxbaSu0D4pmYAAAD//ynKbscAAAAGSURBVAMAO8n54R1FMRsAAAAASUVORK5CYII=", 80u32, 40u32),
        ("image/jpeg", "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAYAAABpYH0BAAAEEElEQVR4AeyYT28cRRDFX1XP7hjjmESgEMdBKApfgDtCyMQHJPgGXFEi8XESIw5InJNIcEYxWYcjCEWJQEi2EKcA5oDCrmXv7kx38WoWk7OnzZ9RZtTP1dsz1Tv9m9fd49VfvrxqrXVvw34evWmPd6jRW/Z4tGH77O+3u5u2v/2O7d991/a/eM9+2r5uH9/40F7feMNe23jf1t++ZpeuXrOLmx/Y2ub1TkuRcxjTrYCkAgkFYIFRYAJGSgxRU6PEmPhd/jnxfPRURjZ1uqiJD7i9xAaAlY0ShgQ3RBSFA6tDjVoj6hBREWAVgJrgXJHwXJ2mx5tXmoQBaBOlcSCJQMEnAYBUQJYMSSLMpTWSJNbBCBivhefxOv0rstrZoj4I4UDaRLUElYrYZlSEIjLWVALEoyuyPUEMCJzqIYUmFpzHyjZ0/FAgcQgt5VRkDlBGYN6XAIRldCQacA7JLwtJCU6gx5HwmnPo9sHxLKZa4lplnHIniZHTMzLPc1xPUQj+dnQDrCA8FyHS7QIQ8kLo+OEmaIZAQ5w4mnBtY1byjcj95mT42Tt1uevUZAGL7YuSGAxsRlSv82OHi0ID2kow4Ho3pEqqoAJEhCifCr5OcqEAnYrCMLUZUHKXLgRzLh/HDw4dPbgPKMeYI4Lzl7okdJpBEt3lYMz8LyCKuq5RxTkiN5wwUMxThRrAoFxqnMhqZ4uKr0mtVUC5swpfppUIhG6DRNYSfIomehGBD6dQSAEkbjSuBmgVMT9yjLy8w0VnsoqZrFAnj3OsosJZ1LbK6eh9rOCIfU11lfEcpnIOhzxXyxnE4jk6T2AmGBYFloclBiHAd2h0+NCDcAFtNQkXcaDrmIRXqEsYF1R4FU/CZfwRrmCsV3Agl/GkfglH6SyKpRehgeulAVqlRvLvwzvVb9St2w+wdfshdfL4EXOPdfPOt1joAW7ceYSbt77D1q1H+OSzh/j082+w/fWP+P1QMOd6GSNfnao5Sm4kpzqa/6Az3dl9Ae11Bju7K9Qy7u8uY7S3gnt7z2PEttHeKu7vse17xVc/zLH3qyCV52HlCmTAHx+04nSuOGSjult0jHW01YS5E7mAcaM1jLGGA3Aai8eXMcHi3KGdxzRxHUSJ6cyhEZgK187ESreLGu+/rRIXsIog/NcX2JA7Mt8JTeGdCugwSYhaIoYlsMr/RiJKEYhFQIdIOoBBeAfdLZpz68bkhQjBhGAEaCJPIPEPARKYIfAcCJCy1NSN4Fy8qNMlC2CnR35KN98DzATZA+wBZhLITO8d2APMJJCZ3jvw2QCYOcp/ML13YCbcHmAPMJNAZnrvwB5gJoHM9N6BPcBMApnpvQN7gJkEMtN7B/YAMwlkpvcO/N8CzLyxrqT3Dsx8Un8CAAD//8QH7fgAAAAGSURBVAMA0ywODsrvwhQAAAAASUVORK5CYII=", 80u32, 40u32),
        ("image/webp", "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAYAAABpYH0BAAACQElEQVR4AeyVz2pTQRTGvzk3YrFN3SjWLkpewGcQJPUZXLoSlz5MBfsI5h1Ku1AQBBEXYgi4UlwKrQZMcuf4TduUS3sz3Hby74YTzsedmXPOzJzfPUnk50Fb43pKf0zx/F9Hu9o9eq77b17poyePtdV+ptvtF7q1+3IlJLBPEgEDmIQPMIAGMJFAYrp1YN0AqgM8lXjvpUmfQweGI4TQgpam7qldhNXRTv9LJj09D4uJ7ogp9w7y589xqCgQNJ7X9RmozffuOv8jZ1mgeOf59YqJv1lC/w0ULp6x0zLPbsMIDhyExRWSDNxdxNXEAIy5ibj3P2xi6DaQYw2KBtGFDgzicAVM+lkL5drhetDYH8bX05/GDo5dCyduG31dR56tQ90tOOegcqYFMJzqkbL39jPK9QV7HfoudHle9JWPX4e9O5+w3/mIgw/f0R82cNqFyg4Mmmopi9lMDrubKNcGDr/RN1aX84mxjCvz9Zp417uD9z3F1x85fOM+vK6xUoJ0IEyC5KzOJsd4iFI5rhc1KS6yfuK38Ns/wF+5h6E04eU2IBl5eWo1TOBYTJmu1CdcuZ68Eyg14hHQnDZC7gdQjjlhC+bcs94WiMy0Au8K2xdfVGG5zsOZA6wznCp3N4BVKEViDGAEThWXAaxCKRJjACNwqrgMYBVKkRgDGIFTxVUTgFVKWUyMAUzkbgANYCKBxHTrQAOYSCAx3TrQACYSSEy3DjSAiQQS060DDWAigcR068ClBZh4sbqkWwcmvqn/AAAA//+zsQVrAAAABklEQVQDAExQ3KDwR4ugAAAAAElFTkSuQmCC", 80u32, 40u32),
        ("image/gif", "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAYAAABpYH0BAAAA1UlEQVR4AeyZsQ2AMAwE0Q/BDC6ZgYJxmICSuZiBkglYAypqhB0lSrgqBaAIc75PiPpxvs5tuhh9ddC+HN2wWsfoq4MonoXggcBgBwoCDQJLQqCSk7cQXDgQB1rIYdEOhEAIhMCqd0KKOqDC55M6EwfiQEtK1NeOgkAIhEBSuIU97Vf3PffjQByIA3EgDuRUzr0Y15MmjOYqYiUp7Hu5HFAoxyQtOxICWQeay12pOg8CIRAC2Ym0nLJvrsSBOBAH4kAcyN8Y92Jcbynjvv6Tj0IKB1P4BgAA//977oKaAAAABklEQVQDAEYMBJ5y3O6sAAAAAElFTkSuQmCC", 80u32, 40u32),
    ];
    for (format, encoded, width, height) in samples {
        let bytes = base64::prelude::BASE64_STANDARD.decode(encoded).unwrap();
        assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), width);
        assert_eq!(
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
            height
        );
        assert!(
            validate_profile_avatar_update(
                Some(format!("data:image/png;base64,{encoded}")),
                Some("avatar.png".into()),
                Some(bytes)
            )
            .is_ok(),
            "production browser output rejected: {format}"
        );
    }
}
