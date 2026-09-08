//! App queue recovery uses actual profile, history and protocol engines.
//! No network worker is started and all data belongs to disposable profiles.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    state: Option<ToxState>,
    friend: u32,
    key: String,
    owner: String,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "kaigen-pq-delivery-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let global = root.join("global");
        let logs = global.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            global.join("tor-settings.json"),
            br#"{"enabled":false,"transport":"none","bridgeLines":""}"#,
        )
        .unwrap();
        let tor = TorManager::new(root.clone(), global, logs).unwrap();
        let state = ToxState::new_for_profile(
            ProfilePaths::new(
                root.clone(),
                root.join("profile/data"),
                root.join("profile/test.tox"),
            )
            .unwrap(),
            tor,
            Arc::new(Mutex::new(ProxySettings {
                mode: "socks5".into(),
                host: "127.0.0.1".into(),
                port: 9,
                username: String::new(),
                password: String::new(),
            })),
            Arc::new(Mutex::new(NetworkSettings::default())),
            None,
            None,
            None,
            Some("Synthetic queue recovery"),
        )
        .unwrap();
        let (friend, owner) = {
            let handle = state.handle.lock().unwrap();
            let tox = handle.as_ref().unwrap().instance.as_ptr();
            let mut error = 0;
            let friend =
                unsafe { tox_friend_add_norequest(tox, [0x73u8; 32].as_ptr(), &mut error) };
            assert_eq!(error, 0);
            (friend, pq_tox_owner(tox))
        };
        Self {
            root,
            state: Some(state),
            friend,
            key: hex_upper(&[0x73u8; 32]),
            owner,
        }
    }
    fn state(&self) -> &ToxState {
        self.state.as_ref().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.state.take());
        // This unique root was created by this fixture and contains no user data.
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn explicit_compatibility_choice_recovers_each_queue_write_failure() {
    for blocked_protected_queue in [false, true] {
        let fixture = Fixture::new();
        let state = fixture.state();
        let sent = send_chat_message_for_state(
            state,
            fixture.friend,
            "Сохранённое первое сообщение 🔐".into(),
            Some("pq-compatibility-operation".into()),
            None,
            Vec::new(),
        )
        .unwrap();
        assert!(state.pq.holds_plaintext_messages(fixture.friend));
        let blocked = if blocked_protected_queue {
            &state.pending_pq_messages_path
        } else {
            &state.pending_messages_path
        };
        let old_bytes = fs::read(blocked).ok();
        if blocked.is_file() {
            fs::remove_file(blocked).unwrap();
        }
        fs::create_dir(blocked).unwrap();
        assert!(skip_pq_auto_for_state(state, fixture.friend).is_err());
        assert!(state.pq.auto_skip_pending(fixture.friend));
        assert!(state.pq.holds_plaintext_messages(fixture.friend));
        assert!(
            state.chat_transport_ready.load(Ordering::Acquire),
            "one contact's conversion must not freeze all chats"
        );
        let reloaded = PqEngine::new(state.history_path.parent().unwrap()).unwrap();
        reloaded
            .bind_contact(fixture.friend, &fixture.key, &fixture.owner, true)
            .unwrap();
        assert!(reloaded.auto_skip_pending(fixture.friend));
        assert!(reloaded.holds_plaintext_messages(fixture.friend));

        fs::remove_dir(blocked).unwrap();
        if let Some(old_bytes) = old_bytes {
            fs::write(blocked, old_bytes).unwrap();
        }
        // The failed second-queue write already removed the row from RAM;
        // retry still has to remove its old durable copy before clearing the fence.
        skip_pq_auto_for_state(state, fixture.friend).unwrap();
        let protected: Vec<PendingToxMessage> =
            serde_json::from_slice(&fs::read(&state.pending_pq_messages_path).unwrap()).unwrap();
        let normal: Vec<PendingToxMessage> =
            serde_json::from_slice(&fs::read(&state.pending_messages_path).unwrap()).unwrap();
        assert!(protected.is_empty());
        assert_eq!(normal.len(), 1);
        assert_eq!(normal[0].id, sent.message_id);
        assert!(normal[0].wire_text.is_none());
        assert_eq!(normal[0].text, "Сохранённое первое сообщение 🔐");
        let row = chat_history_store::find_message_registered(
            &state.history_path,
            fixture.friend,
            &fixture.key,
            &sent.message_id,
        )
        .unwrap()
        .unwrap();
        assert!(!row.pq_protected);
        let reloaded = PqEngine::new(state.history_path.parent().unwrap()).unwrap();
        reloaded
            .bind_contact(fixture.friend, &fixture.key, &fixture.owner, true)
            .unwrap();
        assert!(!reloaded.auto_skip_pending(fixture.friend));
        assert!(!reloaded.first_send(fixture.friend).unwrap());
        assert!(!reloaded.holds_plaintext_messages(fixture.friend));
    }
}

#[test]
fn same_send_operation_recovers_history_and_queue_write_failures() {
    for block_history in [true, false] {
        let fixture = Fixture::new();
        let state = fixture.state();
        let chunk_root = state.history_path.with_extension("chunks");
        let chunk_backup = chunk_root.with_extension("chunks-backup");
        let queue_path = &state.pending_pq_messages_path;
        let queue_before = fs::read(queue_path).ok();
        if block_history {
            fs::rename(&chunk_root, &chunk_backup).unwrap();
            fs::write(&chunk_root, b"synthetic filesystem failure").unwrap();
        } else {
            if queue_path.is_file() {
                fs::remove_file(queue_path).unwrap();
            }
            fs::create_dir(queue_path).unwrap();
        }
        let text = "Retry preserves the original message 🔐";
        let operation = "pq-partial-send-operation";
        assert!(send_chat_message_for_state(
            state,
            fixture.friend,
            text.into(),
            Some(operation.into()),
            None,
            Vec::new()
        )
        .is_err());
        let recorded = state
            .chat_protocol
            .message_operation(
                fixture.friend,
                &fixture.key,
                operation,
                &send_payload_fingerprint(text, &None, &[]).unwrap(),
            )
            .unwrap()
            .unwrap();
        assert!(!state.chat_transport_ready.load(Ordering::Acquire));
        if block_history {
            fs::remove_file(&chunk_root).unwrap();
            fs::rename(&chunk_backup, &chunk_root).unwrap();
            // Also prove reconstruction without relying on the failed call's
            // resident row: only the payload-bound reservation remains.
            state.messages.lock().unwrap().clear();
        } else {
            fs::remove_dir(queue_path).unwrap();
            if let Some(previous) = queue_before {
                fs::write(queue_path, previous).unwrap();
            }
        }
        for _ in 0..2 {
            let result = send_chat_message_for_state(
                state,
                fixture.friend,
                text.into(),
                Some(operation.into()),
                None,
                Vec::new(),
            )
            .unwrap();
            assert_eq!(result.message_id, recorded.message_id);
            assert_eq!(result.delivery, "pending");
            assert!(result.recovered && result.receipt_known);
        }
        let durable: Vec<PendingToxMessage> =
            serde_json::from_slice(&fs::read(queue_path).unwrap()).unwrap();
        assert_eq!(durable.len(), 1);
        assert_eq!(durable[0].id, recorded.message_id);
        assert_eq!(durable[0].text, text);
        let row = chat_history_store::find_operation_registered(
            &state.history_path,
            fixture.friend,
            &fixture.key,
            operation,
        )
        .unwrap()
        .unwrap();
        assert_eq!(row.id, recorded.message_id);
        assert_eq!(row.text, text);
        assert!(row.pq_protected);
        assert_eq!(
            state
                .messages
                .lock()
                .unwrap()
                .iter()
                .filter(|row| row.id == recorded.message_id)
                .count(),
            1
        );
        assert!(state.chat_transport_ready.load(Ordering::Acquire));
    }
}

#[cfg(feature = "desktop")]
#[test]
fn deleting_contact_quarantines_pending_pq_before_readd() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let sent = send_chat_message_for_state(
        state,
        fixture.friend,
        "Explicit deletion stops this send".into(),
        Some("pq-delete-operation".into()),
        None,
        Vec::new(),
    )
    .unwrap();
    desktop_adapter::delete_tox_friend_for_state(state, fixture.friend).unwrap();
    let protected: Vec<PendingToxMessage> =
        serde_json::from_slice(&fs::read(&state.pending_pq_messages_path).unwrap()).unwrap();
    assert!(protected.is_empty());
    assert!(state.pending_pq_messages.lock().unwrap().is_empty());
    let directory = state
        .pending_messages_path
        .parent()
        .unwrap()
        .join("deleted-contact-recovery");
    let files: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    let recovery: serde_json::Value =
        serde_json::from_slice(&fs::read(&files[0]).unwrap()).unwrap();
    assert!(recovery.to_string().contains(&sent.message_id));
    let readded = {
        let handle = state.handle.lock().unwrap();
        let mut error = 0;
        let friend = unsafe {
            tox_friend_add_norequest(
                handle.as_ref().unwrap().instance.as_ptr(),
                [0x73u8; 32].as_ptr(),
                &mut error,
            )
        };
        assert_eq!(error, 0);
        friend
    };
    let reloaded = PqEngine::new(state.history_path.parent().unwrap()).unwrap();
    reloaded
        .bind_contact(readded, &fixture.key, &fixture.owner, false)
        .unwrap();
    assert!(!reloaded.first_send(readded).unwrap());
    assert!(!reloaded.holds_plaintext_messages(readded));
    assert!(!reloaded.has_durable_message(&sent.message_id));
    assert!(state.chat_transport_ready.load(Ordering::Acquire));
}
