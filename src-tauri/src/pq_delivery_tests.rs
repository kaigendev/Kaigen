//! App queue recovery uses actual profile, history and protocol engines.
//! No network worker is started and all data belongs to disposable profiles.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
            "kaigen-pq-delivery-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
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

#[test]
fn required_history_commit_orders_stale_worker_snapshot_before_restart_readback() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let sent = send_chat_message_for_state(
        state,
        fixture.friend,
        "FIFO delivery receipt survives restart".into(),
        Some("pq-history-order-operation".into()),
        None,
        Vec::new(),
    )
    .unwrap();
    flush_deferred_profile_writes().unwrap();

    // Stop the single writer first. This keeps the stale snapshot below from
    // reaching the store, without relying on a timing-sensitive Write/Pause
    // pair when other tests share the same worker.
    let (entered_tx, entered_rx) = mpsc::sync_channel(0);
    let (release_tx, release_rx) = mpsc::sync_channel(0);
    history_persist_sender()
        .send(HistoryPersistRequest::PauseBeforeCommit {
            entered: entered_tx,
            release: release_rx,
        })
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

    {
        let mut messages = state.messages.lock().unwrap();
        let row = messages
            .iter_mut()
            .find(|message| message.id == sent.message_id)
            .unwrap();
        row.delivery = "awaiting_receipt".into();
        row.delivered_at = None;
    }
    persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);

    {
        let mut messages = state.messages.lock().unwrap();
        let row = messages
            .iter_mut()
            .find(|message| message.id == sent.message_id)
            .unwrap();
        row.delivery = "delivered".into();
        row.delivered_at = Some(4242);
    }
    let messages = Arc::clone(&state.messages);
    let history_path = state.history_path.clone();
    let history_enabled = Arc::clone(&state.history_enabled);
    let (required_started_tx, required_started_rx) = mpsc::sync_channel(0);
    let (required_done_tx, required_done_rx) = mpsc::sync_channel(0);
    let required = thread::spawn(move || {
        required_started_tx.send(()).unwrap();
        let result = persist_tox_history_required(&messages, &history_path, &history_enabled);
        required_done_tx.send(result).unwrap();
    });
    required_started_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    assert!(required_done_rx
        .recv_timeout(Duration::from_millis(75))
        .is_err());

    release_tx.send(()).unwrap();
    required_done_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    required.join().unwrap();
    flush_deferred_profile_writes().unwrap();

    let durable = chat_history_store::find_message_registered(
        &state.history_path,
        fixture.friend,
        &fixture.key,
        &sent.message_id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(durable.delivery, "delivered");
    assert_eq!(durable.delivered_at, Some(4242));

    // Re-open only the durable chunk store, as ToxState startup does before it
    // applies its process-local receipt recovery policy.
    assert!(chat_history_store::unregister(&state.history_path));
    let reopened = chat_history_store::open_and_register(&state.history_path, Vec::new()).unwrap();
    let durable = reopened
        .iter()
        .find(|message| message.id == sent.message_id)
        .unwrap();
    assert_eq!(durable.delivery, "delivered");
    assert_eq!(durable.delivered_at, Some(4242));
}

#[test]
fn reaction_fifo_preserves_concurrent_attachment_and_failed_write_retry() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let message_id = "abababababababababababababababab";
    let row = ToxMessage {
        id: message_id.into(),
        friend_number: fixture.friend,
        friend_public_key: fixture.key.clone(),
        text: "reaction and transfer share one durable row".into(),
        mine: true,
        timestamp: 4100,
        delivery: "delivered".into(),
        delivered_at: Some(4101),
        attachment: Some(ToxAttachment {
            name: "shared.bin".into(),
            size: 10,
            mime: "application/octet-stream".into(),
            path: "synthetic/shared.bin".into(),
            preview_source: None,
            image: false,
            transferred: 0,
            speed_bytes_per_sec: 0,
            eta_seconds: None,
            transfer_state: "queued".into(),
            completed: false,
            completed_at: None,
            transfer_error: None,
            retry_count: 0,
        }),
        event: None,
        protocol_version: Some(chat_protocol::VERSION),
        operation_id: None,
        quote: None,
        formatting: Vec::new(),
        pq_protected: true,
        reactions: None,
    };
    state.messages.lock().unwrap().push(row.clone());
    write_registered_history_rows_required(std::slice::from_ref(&row), &state.history_path)
        .unwrap();
    flush_deferred_profile_writes().unwrap();

    // Stop the worker first, then enqueue an older full-row snapshot. The
    // reaction update must change RAM and reserve its required FIFO position
    // before a transfer can snapshot RAM.
    let (entered_tx, entered_rx) = mpsc::sync_channel(0);
    let (release_tx, release_rx) = mpsc::sync_channel(0);
    history_persist_sender()
        .send(HistoryPersistRequest::PauseBeforeCommit {
            entered: entered_tx,
            release: release_rx,
        })
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);

    let first_view = ReactionView {
        mine: vec![ReactionCode::Rocket],
        mine_revision: 1,
        delivery: chat_protocol::ReactionDelivery::Pending,
        ..ReactionView::default()
    };
    let messages = Arc::clone(&state.messages);
    let history_path = state.history_path.clone();
    let friend_key = fixture.key.clone();
    let view_for_thread = first_view.clone();
    let (reaction_done_tx, reaction_done_rx) = mpsc::sync_channel(0);
    let reaction = thread::spawn(move || {
        let result = persist_message_reaction_view(
            &history_path,
            true,
            &messages,
            fixture.friend,
            &friend_key,
            message_id,
            view_for_thread,
        );
        reaction_done_tx.send(result).unwrap();
    });

    let deadline = Instant::now() + Duration::from_secs(2);
    let reaction_visible = loop {
        if state.messages.lock().unwrap()[0].reactions.as_ref() == Some(&first_view) {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        thread::sleep(Duration::from_millis(2));
    };
    if !reaction_visible {
        let _ = release_tx.send(());
        let _ = reaction_done_rx.recv_timeout(Duration::from_secs(2));
        let _ = reaction.join();
        panic!("reaction was not made resident before its required write completed");
    }
    {
        let mut messages = state.messages.lock().unwrap();
        let attachment = messages[0].attachment.as_mut().unwrap();
        attachment.transferred = 7;
        attachment.transfer_state = "sending".into();
    }
    persist_tox_history(&state.messages, &state.history_path, &state.history_enabled);

    release_tx.send(()).unwrap();
    reaction_done_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    reaction.join().unwrap();
    flush_deferred_profile_writes().unwrap();

    assert!(chat_history_store::unregister(&state.history_path));
    let reopened = chat_history_store::open_and_register(&state.history_path, Vec::new()).unwrap();
    let durable = reopened
        .iter()
        .find(|message| message.id == message_id)
        .unwrap();
    assert_eq!(durable.reactions.as_ref(), Some(&first_view));
    let attachment = durable.attachment.as_ref().unwrap();
    assert_eq!(attachment.transferred, 7);
    assert_eq!(attachment.transfer_state, "sending");

    // A failed required write rolls back only the attempted reaction. An
    // identical user retry must perform the durable write instead of taking
    // the same-view early return.
    assert!(chat_history_store::unregister(&state.history_path));
    let second_view = ReactionView {
        mine: vec![ReactionCode::Heart],
        mine_revision: 2,
        delivery: chat_protocol::ReactionDelivery::Pending,
        ..ReactionView::default()
    };
    assert!(persist_message_reaction_view(
        &state.history_path,
        true,
        &state.messages,
        fixture.friend,
        &fixture.key,
        message_id,
        second_view.clone(),
    )
    .is_err());
    let resident = state.messages.lock().unwrap()[0].clone();
    assert_eq!(resident.reactions.as_ref(), Some(&first_view));
    assert_eq!(resident.attachment.as_ref().unwrap().transferred, 7);

    chat_history_store::open_and_register(&state.history_path, Vec::new()).unwrap();
    persist_message_reaction_view(
        &state.history_path,
        true,
        &state.messages,
        fixture.friend,
        &fixture.key,
        message_id,
        second_view.clone(),
    )
    .unwrap();
    let durable = chat_history_store::find_message_registered(
        &state.history_path,
        fixture.friend,
        &fixture.key,
        message_id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(durable.reactions.as_ref(), Some(&second_view));
    assert_eq!(durable.attachment.as_ref().unwrap().transferred, 7);
}

#[test]
fn required_pending_commit_orders_stale_empty_worker_snapshot_before_restart_readback() {
    let fixture = Fixture::new();
    let state = fixture.state();
    persist_pending_messages_required(&state.pending_pq_messages, &state.pending_pq_messages_path)
        .unwrap();
    flush_deferred_profile_writes().unwrap();

    // Stop the worker, then capture an empty async snapshot before it can
    // commit.
    let (entered_tx, entered_rx) = mpsc::sync_channel(0);
    let (release_tx, release_rx) = mpsc::sync_channel(0);
    atomic_write_sender()
        .send(AtomicWriteRequest::PauseBeforeCommit {
            entered: entered_tx,
            release: release_rx,
        })
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    persist_pending_messages(&state.pending_pq_messages, &state.pending_pq_messages_path);

    let anchor = PendingToxMessage {
        id: "pq-pending-fifo-anchor".into(),
        friend_number: fixture.friend,
        friend_public_key: fixture.key.clone(),
        text: "durable ciphertext anchor".into(),
        timestamp: 4242,
        next_offset: 0,
        wire_fragments: Vec::new(),
        wire_text: Some("synthetic-pq-envelope".into()),
    };
    state
        .pending_pq_messages
        .lock()
        .unwrap()
        .push(anchor.clone());
    let queue = Arc::clone(&state.pending_pq_messages);
    let path = state.pending_pq_messages_path.clone();
    let (required_started_tx, required_started_rx) = mpsc::sync_channel(0);
    let (required_done_tx, required_done_rx) = mpsc::sync_channel(0);
    let required = thread::spawn(move || {
        required_started_tx.send(()).unwrap();
        let result = persist_pending_messages_required(&queue, &path);
        required_done_tx.send(result).unwrap();
    });
    required_started_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let completed_early = required_done_rx
        .recv_timeout(Duration::from_millis(75))
        .ok();
    let completed_before_release = completed_early.is_some();

    release_tx.send(()).unwrap();
    let required_result = match completed_early {
        Some(result) => result,
        None => required_done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
    };
    required_result.unwrap();
    required.join().unwrap();
    flush_deferred_profile_writes().unwrap();

    // Startup reads this exact durable file. The old empty snapshot must not
    // erase the ciphertext anchor after the required transaction completed.
    let reopened: Vec<PendingToxMessage> =
        serde_json::from_slice(&profiles::read_file(&state.pending_pq_messages_path).unwrap())
            .unwrap();
    assert_eq!(
        reopened.len(),
        1,
        "required write completed before older async snapshot: {completed_before_release}"
    );
    assert_eq!(reopened[0].id, anchor.id);
    assert_eq!(reopened[0].wire_text, anchor.wire_text);

    // The reverse transition is equally important: after an ACK removes the
    // durable queue item, an older async snapshot must not resurrect it.
    let (entered_tx, entered_rx) = mpsc::sync_channel(0);
    let (release_tx, release_rx) = mpsc::sync_channel(0);
    atomic_write_sender()
        .send(AtomicWriteRequest::PauseBeforeCommit {
            entered: entered_tx,
            release: release_rx,
        })
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    persist_pending_messages(&state.pending_pq_messages, &state.pending_pq_messages_path);
    state.pending_pq_messages.lock().unwrap().clear();

    let queue = Arc::clone(&state.pending_pq_messages);
    let path = state.pending_pq_messages_path.clone();
    let (required_done_tx, required_done_rx) = mpsc::sync_channel(0);
    let required = thread::spawn(move || {
        let result = persist_pending_messages_required(&queue, &path);
        required_done_tx.send(result).unwrap();
    });
    assert!(required_done_rx
        .recv_timeout(Duration::from_millis(75))
        .is_err());
    release_tx.send(()).unwrap();
    required_done_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    required.join().unwrap();
    flush_deferred_profile_writes().unwrap();

    let reopened: Vec<PendingToxMessage> =
        serde_json::from_slice(&profiles::read_file(&state.pending_pq_messages_path).unwrap())
            .unwrap();
    assert!(reopened.is_empty());
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
