//! Deterministic crash/retry tests for the durable PQ v2 state machine.

use super::*;

#[test]
fn cancelling_before_identity_keeps_message_waiting_without_collecting_noise() {
    let pair = Pair::new("cancel-before-identity");
    assert!(pair.alice.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    assert!(pair.alice.status(FRIEND).identity_waiting);
    pair.alice.cancel(FRIEND).unwrap();
    let status = pair.alice.status(FRIEND);
    assert!(status.auto_pending);
    assert!(!status.identity_waiting);
    assert_eq!(
        pair.alice.complete_identity(&[]).unwrap_err(),
        "PQ_IDENTITY_NOT_REQUESTED"
    );
    pair.alice.skip_auto(FRIEND).unwrap();
    pair.alice.finish_auto_skip(FRIEND).unwrap();
    pair.cleanup();
}
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const FRIEND: u32 = 0;

static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

struct Pair {
    root: PathBuf,
    alice_dir: PathBuf,
    bob_dir: PathBuf,
    alice_key: String,
    bob_key: String,
    alice: Engine,
    bob: Engine,
}

impl Pair {
    fn new(label: &str) -> Self {
        Self::new_with_keys(label, 0x11, 0x22)
    }

    fn new_with_keys(label: &str, alice_key_byte: u8, bob_key_byte: u8) -> Self {
        let root = test_root(label);
        let alice_dir = root.join("alice");
        let bob_dir = root.join("bob");
        fs::create_dir_all(&alice_dir).unwrap();
        fs::create_dir_all(&bob_dir).unwrap();
        let alice_key = stable_key(alice_key_byte);
        let bob_key = stable_key(bob_key_byte);
        let alice = open_engine(&alice_dir, &bob_key, &alice_key);
        let bob = open_engine(&bob_dir, &alice_key, &bob_key);
        Self {
            root,
            alice_dir,
            bob_dir,
            alice_key,
            bob_key,
            alice,
            bob,
        }
    }

    fn restart_alice(&mut self) {
        self.alice = open_engine(&self.alice_dir, &self.bob_key, &self.alice_key);
    }

    fn restart_bob(&mut self) {
        self.bob = open_engine(&self.bob_dir, &self.alice_key, &self.bob_key);
    }

    fn cleanup(self) {
        let root = self.root.clone();
        drop(self);
        fs::remove_dir_all(root).unwrap();
    }
}

#[derive(Default)]
struct Delivery {
    outgoing: Vec<Vec<u8>>,
    texts: Vec<String>,
    received_wires: Vec<u64>,
    acknowledged_wires: Vec<u64>,
    events: Vec<PqSessionEvent>,
}

fn stable_key(byte: u8) -> String {
    format!("{byte:02X}").repeat(32)
}

fn test_root(label: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "kaigen-pq-v2-{label}-{}-{now}-{sequence}",
        std::process::id()
    ))
}

fn open_engine(path: &Path, remote: &str, owner: &str) -> Engine {
    let engine = Engine::new(path).unwrap();
    engine.bind(FRIEND, remote, owner, false).unwrap();
    engine
}

fn force_drive(engine: &Engine, external_drained: bool) -> Vec<Vec<u8>> {
    {
        let mut state = engine.inner.lock().unwrap();
        let key = state.routes.get(&FRIEND).unwrap().clone();
        state.runtime.entry(key).or_default().last_attempt = None;
    }
    engine.drive(FRIEND, true, external_drained).unwrap()
}

fn split_records(source: &[Vec<u8>]) -> Vec<(Record, Vec<Vec<u8>>)> {
    let mut groups = BTreeMap::<[u8; 16], BTreeMap<u16, Vec<u8>>>::new();
    for packet in source {
        assert!(is_packet(packet));
        let digest: [u8; 16] = packet[6..22].try_into().unwrap();
        let index = u16::from_be_bytes(packet[22..24].try_into().unwrap());
        groups
            .entry(digest)
            .or_default()
            .entry(index)
            .or_insert_with(|| packet.clone());
    }
    groups
        .into_values()
        .map(|parts| {
            let packets = parts.into_values().collect::<Vec<_>>();
            let bytes = packets
                .iter()
                .flat_map(|packet| packet[30..].iter().copied())
                .collect::<Vec<_>>();
            let record = serde_json::from_slice::<Record>(&bytes).unwrap();
            (record, packets)
        })
        .collect()
}

fn select_record(source: &[Vec<u8>], predicate: impl Fn(&Record) -> bool) -> Vec<Vec<u8>> {
    split_records(source)
        .into_iter()
        .find_map(|(record, packets)| predicate(&record).then_some(packets))
        .expect("expected record")
}

fn select_optional(source: &[Vec<u8>], predicate: impl Fn(&Record) -> bool) -> Vec<Vec<u8>> {
    split_records(source)
        .into_iter()
        .filter(|(record, _)| predicate(record))
        .flat_map(|(_, packets)| packets)
        .collect()
}

fn without_capabilities(source: &[Vec<u8>]) -> Vec<Vec<u8>> {
    select_optional(source, |record| {
        !matches!(record, Record::Capability { .. })
    })
}

fn deliver(engine: &Engine, packets: &[Vec<u8>]) -> Delivery {
    let mut delivery = Delivery::default();
    for packet in packets {
        let result = engine.handle(FRIEND, packet).unwrap();
        delivery.outgoing.extend(result.outgoing);
        delivery.texts.extend(result.received_text);
        delivery.received_wires.extend(result.received_wire_id);
        delivery
            .acknowledged_wires
            .extend(result.acknowledged_wire_id);
        delivery.events.extend(result.session_event);
    }
    delivery
}

fn current(engine: &Engine) -> Option<String> {
    let state = engine.inner.lock().unwrap();
    peer(&state, FRIEND).unwrap().current.clone()
}

fn epoch_count(engine: &Engine) -> usize {
    let state = engine.inner.lock().unwrap();
    peer(&state, FRIEND).unwrap().epochs.len()
}

fn retired_ids(engine: &Engine) -> Vec<String> {
    let state = engine.inner.lock().unwrap();
    peer(&state, FRIEND)
        .unwrap()
        .retired
        .keys()
        .cloned()
        .collect()
}

fn active_pair(label: &str) -> Pair {
    active_pair_with_keys(label, 0x11, 0x22)
}

fn active_pair_with_keys(label: &str, alice_key_byte: u8, bob_key_byte: u8) -> Pair {
    let pair = Pair::new_with_keys(label, alice_key_byte, bob_key_byte);
    assert!(pair.alice.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    pair.alice.complete_identity(&[0xA1; 32]).unwrap();

    let offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    deliver(&pair.bob, &offer);
    pair.bob.complete_identity(&[0xB2; 32]).unwrap();
    let accept = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });
    let finish = deliver(&pair.alice, &accept).outgoing;
    let ready = deliver(&pair.bob, &finish).outgoing;
    let commit = deliver(&pair.alice, &ready).outgoing;
    let done = deliver(&pair.bob, &commit).outgoing;
    deliver(&pair.alice, &done);

    assert_eq!(current(&pair.alice), current(&pair.bob));
    assert!(current(&pair.alice).is_some());
    pair
}

fn exchange_until(pair: &Pair, external_drained: bool, predicate: impl Fn() -> bool) {
    let mut alice_to_bob = Vec::new();
    let mut bob_to_alice = Vec::new();
    for _ in 0..32 {
        alice_to_bob.extend(without_capabilities(&force_drive(
            &pair.alice,
            external_drained,
        )));
        bob_to_alice.extend(without_capabilities(&force_drive(
            &pair.bob,
            external_drained,
        )));
        let from_bob = deliver(&pair.bob, &alice_to_bob).outgoing;
        let from_alice = deliver(&pair.alice, &bob_to_alice).outgoing;
        alice_to_bob = from_alice;
        bob_to_alice = from_bob;
        if predicate() {
            return;
        }
    }
    panic!("PQ exchange did not converge");
}

#[test]
fn every_handshake_cut_and_every_data_commit_cut_recovers_exactly() {
    let mut pair = Pair::new("all-crash-cuts");
    assert!(pair.alice.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    pair.alice.complete_identity(&[0xA1; 32]).unwrap();

    // OFFER was durably stored before publication. Losing it and restarting
    // publishes the exact same transaction and ephemeral public material.
    let offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    pair.restart_alice();
    let offer_retry = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    assert_eq!(offer_retry, offer);
    deliver(&pair.bob, &offer_retry);
    pair.bob.complete_identity(&[0xB2; 32]).unwrap();

    // Repeat the same proof at ACCEPT, FINISH, READY, and COMMIT.
    let accept = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });
    pair.restart_bob();
    let accept_retry = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });
    assert_eq!(accept_retry, accept);

    let finish = deliver(&pair.alice, &accept_retry).outgoing;
    pair.restart_alice();
    let finish_retry = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Finish { .. })
    });
    assert_eq!(finish_retry, finish);

    let ready = deliver(&pair.bob, &finish_retry).outgoing;
    pair.restart_bob();
    let ready_retry = select_record(
        &force_drive(&pair.bob, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "ready"),
    );
    assert_eq!(ready_retry, ready);

    let commit = deliver(&pair.alice, &ready_retry).outgoing;
    pair.restart_alice();
    let commit_retry = select_record(
        &force_drive(&pair.alice, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "commit"),
    );
    assert_eq!(commit_retry, commit);

    let done = deliver(&pair.bob, &commit_retry).outgoing;
    pair.restart_bob();
    let duplicate_commit_response = deliver(&pair.bob, &commit_retry).outgoing;
    assert_eq!(duplicate_commit_response, done);
    deliver(&pair.alice, &duplicate_commit_response);
    assert_eq!(current(&pair.alice), current(&pair.bob));
    assert!(current(&pair.alice).is_some());

    let encrypted = pair
        .alice
        .encrypt(FRIEND, "message-operation-1", "synthetic secret")
        .unwrap();
    let exact_data = encrypted.packets.clone();
    pair.restart_alice();
    let retried = pair
        .alice
        .encrypt(FRIEND, "message-operation-1", "synthetic secret")
        .unwrap();
    assert_eq!(retried.wire_id, encrypted.wire_id);
    assert!(retried.packets.is_empty());
    let driven_retry = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Data { .. })
    });
    assert_eq!(driven_retry, exact_data);

    // Authentication failure cannot consume a ratchet key.
    let mut changed = split_records(&exact_data).pop().unwrap().0;
    let Record::Data { ciphertext, .. } = &mut changed else {
        panic!("data record")
    };
    ciphertext[0] ^= 0x80;
    let error = deliver_error(&pair.bob, &packets(&changed).unwrap());
    assert!(error.contains("AES-GCM") || error == "PQ_MESSAGE_AUTHENTICATION_FAILED");

    // The application commits a synthetic inbox row, then crashes before the
    // receive-chain commit. Replay decrypts again, but app dedup keeps one row.
    let first = deliver(&pair.bob, &exact_data);
    assert_eq!(first.texts, ["synthetic secret"]);
    assert_eq!(first.received_wires, [encrypted.wire_id]);
    let inbox = pair.bob_dir.join("synthetic-inbox.txt");
    profiles::atomic_write(&inbox, first.texts[0].as_bytes()).unwrap();
    pair.restart_bob();
    let after_app_commit_crash = deliver(&pair.bob, &exact_data);
    assert_eq!(after_app_commit_crash.texts, ["synthetic secret"]);
    assert_eq!(profiles::read_text(&inbox).unwrap(), "synthetic secret");
    let acknowledgement = pair.bob.commit_received(FRIEND, encrypted.wire_id).unwrap();

    // Lose the ACK after the receive state is durable. A receiver restart must
    // answer duplicate ciphertext without publishing plaintext a second time.
    pair.restart_bob();
    let duplicate = deliver(&pair.bob, &exact_data);
    assert!(duplicate.texts.is_empty());
    assert_eq!(duplicate.outgoing, acknowledgement);

    // A forged ACK cannot release the exact durable ciphertext.
    let mut forged_ack = split_records(&acknowledgement).pop().unwrap().0;
    let Record::Signal { tag, .. } = &mut forged_ack else {
        panic!("ack record")
    };
    tag[0] ^= 0x80;
    assert_eq!(
        deliver_error(&pair.alice, &packets(&forged_ack).unwrap()),
        "PQ_SIGNAL_AUTHENTICATION_FAILED"
    );
    assert!(pair.alice.delivered(FRIEND).is_empty());

    let accepted = deliver(&pair.alice, &acknowledgement);
    assert_eq!(accepted.acknowledged_wires, [encrypted.wire_id]);
    pair.restart_alice();
    assert_eq!(
        pair.alice.delivered(FRIEND),
        vec![(encrypted.wire_id, "message-operation-1".into())]
    );
    pair.alice
        .forget_delivered(FRIEND, encrypted.wire_id)
        .unwrap();
    pair.restart_alice();
    assert!(pair.alice.delivered(FRIEND).is_empty());
    pair.cleanup();
}

#[test]
fn receive_commit_backpressure_prevents_out_of_order_ratchet_rollback() {
    let mut pair = active_pair("receive-commit-backpressure");
    let first = pair
        .alice
        .encrypt(FRIEND, "receive-order-1", "first")
        .unwrap();
    let second = pair
        .alice
        .encrypt(FRIEND, "receive-order-2", "second")
        .unwrap();

    // Receive the second ciphertext first. It stages a candidate chain with a
    // skipped key for the first sequence, but publishes neither chain nor ACK
    // until the application commits the plaintext.
    let staged_second = deliver(&pair.bob, &second.packets);
    assert_eq!(staged_second.texts, ["second"]);
    assert_eq!(staged_second.received_wires, [second.wire_id]);
    assert!(staged_second.outgoing.is_empty());

    // Any DATA while that candidate is pending is backpressured. In particular,
    // neither a lower sequence nor a retry of the staged ciphertext creates a
    // competing snapshot or a duplicate application delivery.
    let blocked_first = deliver(&pair.bob, &first.packets);
    let blocked_retry = deliver(&pair.bob, &second.packets);
    assert!(blocked_first.texts.is_empty());
    assert!(blocked_first.received_wires.is_empty());
    assert!(blocked_retry.texts.is_empty());
    assert!(blocked_retry.received_wires.is_empty());

    let second_ack = pair.bob.commit_received(FRIEND, second.wire_id).unwrap();
    deliver(&pair.alice, &second_ack);

    // Once the first candidate is durable, the sender's exact retry consumes
    // the saved skipped key. Committing it advances the contiguous floor over
    // both sequences, and restart-time duplicates only recover authenticated
    // ACKs without publishing plaintext again.
    let retried_first = deliver(&pair.bob, &first.packets);
    assert_eq!(retried_first.texts, ["first"]);
    let first_ack = pair.bob.commit_received(FRIEND, first.wire_id).unwrap();
    deliver(&pair.alice, &first_ack);
    pair.restart_bob();
    assert!(deliver(&pair.bob, &first.packets).texts.is_empty());
    assert!(deliver(&pair.bob, &second.packets).texts.is_empty());
    pair.cleanup();
}

#[test]
fn detached_contact_never_resumes_archived_keys_or_ciphertext_after_rebind() {
    let mut pair = active_pair("detached-contact-quarantine");
    let old_epoch = current(&pair.alice).unwrap();
    let trusted = pair.alice.inner.lock().unwrap().stored.peers[&pair.bob_key]
        .trusted_fingerprint
        .clone();

    let archived_outgoing = pair
        .alice
        .encrypt(FRIEND, "detached-outgoing", "already deleted")
        .unwrap();
    let at_bob = deliver(&pair.bob, &archived_outgoing.packets);
    assert_eq!(at_bob.texts, ["already deleted"]);
    let late_ack = pair
        .bob
        .commit_received(FRIEND, archived_outgoing.wire_id)
        .unwrap();
    let late_incoming = pair
        .bob
        .encrypt(FRIEND, "detached-incoming", "from the archived epoch")
        .unwrap();

    pair.alice.detach(FRIEND).unwrap();
    {
        let state = pair.alice.inner.lock().unwrap();
        let replacement = peer(&state, FRIEND).unwrap();
        assert!(replacement.first_message_seen);
        assert!(replacement.auto_consumed);
        assert!(replacement.manual_only);
        assert!(replacement.current.is_none());
        assert!(replacement.epochs.is_empty());
        assert!(replacement.outgoing.is_empty());
        assert_eq!(replacement.trusted_fingerprint, trusted);

        let archived = &state.stored.detached[&pair.bob_key];
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].current.as_deref(), Some(old_epoch.as_str()));
        assert!(archived[0].epochs.contains_key(&old_epoch));
        assert!(archived[0]
            .outgoing
            .contains_key(&archived_outgoing.wire_id));
    }

    pair.restart_alice();
    assert!(!pair.alice.first_send(FRIEND).unwrap());
    let driven = force_drive(&pair.alice, true);
    assert!(split_records(&driven)
        .iter()
        .all(|(record, _)| { !matches!(record, Record::Offer { .. } | Record::Data { .. }) }));

    // Packets from the detached epoch are never routed into the archive. An
    // old ACK cannot release its retained ciphertext, and old DATA cannot be
    // decrypted into the new contact lifecycle.
    let ignored_ack = deliver(&pair.alice, &late_ack);
    assert!(ignored_ack.acknowledged_wires.is_empty());
    assert_eq!(
        deliver_error(&pair.alice, &late_incoming.packets),
        "PQ_EPOCH_WAIT"
    );
    pair.restart_alice();
    {
        let state = pair.alice.inner.lock().unwrap();
        let replacement = peer(&state, FRIEND).unwrap();
        assert!(replacement.manual_only);
        assert!(replacement.current.is_none());
        let archived = &state.stored.detached[&pair.bob_key][0];
        assert_eq!(archived.current.as_deref(), Some(old_epoch.as_str()));
        assert!(archived.epochs.contains_key(&old_epoch));
        assert!(!archived.outgoing[&archived_outgoing.wire_id].acknowledged);
    }
    pair.cleanup();
}

#[test]
fn detached_archive_limit_fails_closed_without_overwriting_recovery_state() {
    let mut pair = Pair::new("detached-archive-bound");
    for _ in 0..MAX_DETACHED_ARCHIVES {
        pair.alice.detach(FRIEND).unwrap();
    }
    assert_eq!(
        pair.alice.detach(FRIEND).unwrap_err(),
        "PQ_DETACHED_ARCHIVE_BACKPRESSURE"
    );
    {
        let state = pair.alice.inner.lock().unwrap();
        assert_eq!(
            state.stored.detached[&pair.bob_key].len(),
            MAX_DETACHED_ARCHIVES
        );
        let replacement = peer(&state, FRIEND).unwrap();
        assert!(replacement.manual_only);
        assert!(replacement.first_message_seen);
        assert!(replacement.auto_consumed);
    }
    pair.restart_alice();
    assert_eq!(
        pair.alice.inner.lock().unwrap().stored.detached[&pair.bob_key].len(),
        MAX_DETACHED_ARCHIVES
    );
    pair.cleanup();
}

fn deliver_error(engine: &Engine, packets: &[Vec<u8>]) -> String {
    let mut error = None;
    for packet in packets {
        match engine.handle(FRIEND, packet) {
            Ok(_) => {}
            Err(value) => error = Some(value),
        }
    }
    error.expect("expected packet rejection")
}

#[test]
fn crossed_first_sends_converge_and_manual_close_disables_future_auto() {
    let mut pair = Pair::new("crossed-and-manual-latch");
    assert!(pair.alice.first_send(FRIEND).unwrap());
    assert!(pair.bob.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    deliver(&pair.bob, &pair.alice.capability());
    pair.alice.complete_identity(&[0x31; 32]).unwrap();
    pair.bob.complete_identity(&[0x42; 32]).unwrap();

    let alice_offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    let bob_offer = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    deliver(&pair.alice, &bob_offer);
    deliver(&pair.bob, &alice_offer);
    exchange_until(&pair, true, || {
        current(&pair.alice).is_some() && current(&pair.bob).is_some()
    });
    assert_eq!(current(&pair.alice), current(&pair.bob));
    assert_eq!(epoch_count(&pair.alice), 1);
    assert_eq!(epoch_count(&pair.bob), 1);

    // Each crossed first message uses its own directional ratchet key and is
    // committed once.
    let a_message = pair.alice.encrypt(FRIEND, "cross-a", "from alice").unwrap();
    let b_message = pair.bob.encrypt(FRIEND, "cross-b", "from bob").unwrap();
    let at_bob = deliver(&pair.bob, &a_message.packets);
    let at_alice = deliver(&pair.alice, &b_message.packets);
    assert_eq!(at_bob.texts, ["from alice"]);
    assert_eq!(at_alice.texts, ["from bob"]);
    let a_ack = pair.bob.commit_received(FRIEND, a_message.wire_id).unwrap();
    let b_ack = pair
        .alice
        .commit_received(FRIEND, b_message.wire_id)
        .unwrap();
    deliver(&pair.alice, &a_ack);
    deliver(&pair.bob, &b_ack);
    pair.alice
        .forget_delivered(FRIEND, a_message.wire_id)
        .unwrap();
    pair.bob
        .forget_delivered(FRIEND, b_message.wire_id)
        .unwrap();

    let close = pair.alice.shutdown(FRIEND).unwrap();
    let response = deliver(&pair.bob, &close).outgoing;
    deliver(&pair.alice, &response);
    exchange_until(&pair, true, || {
        current(&pair.alice).is_none() && current(&pair.bob).is_none()
    });
    pair.restart_alice();
    pair.restart_bob();
    assert!(!pair.alice.first_send(FRIEND).unwrap());
    assert!(!pair.bob.first_send(FRIEND).unwrap());
    assert!(
        select_optional(&force_drive(&pair.alice, true), |record| matches!(
            record,
            Record::Offer { .. }
        ))
        .is_empty()
    );

    // A valid old automatic offer is rejected after restart. Only an explicit
    // manual request can create another session.
    let rejected = deliver(&pair.bob, &alice_offer).outgoing;
    assert!(split_records(&rejected)
        .iter()
        .any(|(record, _)| matches!(record, Record::Cancel { .. })));
    pair.alice.request(FRIEND).unwrap();
    let manual_offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(
            record,
            Record::Offer {
                automatic: false,
                ..
            }
        )
    });
    let incoming = deliver(&pair.bob, &manual_offer);
    assert_eq!(incoming.events, [PqSessionEvent::OfferReceived]);
    pair.bob.accept(FRIEND).unwrap();
    exchange_until(&pair, true, || {
        current(&pair.alice).is_some() && current(&pair.bob).is_some()
    });
    pair.cleanup();
}

#[test]
fn automatic_skip_marker_survives_restart_and_fences_plaintext_until_app_commit() {
    let root = test_root("automatic-skip-commit");
    fs::create_dir_all(&root).unwrap();
    let peer_key = stable_key(0x22);
    let owner_key = stable_key(0x11);
    let engine = open_engine(&root, &peer_key, &owner_key);

    assert!(engine.first_send(FRIEND).unwrap());
    engine.skip_auto(FRIEND).unwrap();
    assert!(engine.auto_skip_pending(FRIEND));
    assert!(engine.holds_plaintext(FRIEND));
    // A new send is assigned to the regular queue, while the marker keeps that
    // contact's plaintext fenced until conversion of the original queue is
    // durably complete.
    assert!(!engine.first_send(FRIEND).unwrap());
    assert_eq!(
        engine.request_identity_only(FRIEND).unwrap_err(),
        "PQ_SESSION_WAIT"
    );
    force_drive(&engine, true);
    assert!(engine.auto_skip_pending(FRIEND));
    drop(engine);

    let restarted = open_engine(&root, &peer_key, &owner_key);
    assert!(restarted.auto_skip_pending(FRIEND));
    assert!(restarted.holds_plaintext(FRIEND));
    assert!(!restarted.first_send(FRIEND).unwrap());
    {
        let state = restarted.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert!(peer.manual_only);
        assert!(peer.auto_consumed);
    }

    // Only the application-level queue/history commit authorizes clearing the
    // fence. The durable manual-only latch remains after that acknowledgement.
    restarted.finish_auto_skip(FRIEND).unwrap();
    assert!(!restarted.auto_skip_pending(FRIEND));
    assert!(!restarted.holds_plaintext(FRIEND));
    drop(restarted);
    let reopened = open_engine(&root, &peer_key, &owner_key);
    assert!(!reopened.auto_skip_pending(FRIEND));
    assert!(!reopened.holds_plaintext(FRIEND));
    assert!(!reopened.first_send(FRIEND).unwrap());
    drop(reopened);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn lost_manual_cancel_replays_before_a_replacement_offer_and_converges() {
    let mut pair = Pair::new("manual-cancel-replay");
    deliver(&pair.alice, &pair.bob.capability());
    pair.alice.request(FRIEND).unwrap();
    pair.alice.complete_identity(&[0xA1; 32]).unwrap();
    let first_offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(
            record,
            Record::Offer {
                automatic: false,
                ..
            }
        )
    });
    deliver(&pair.bob, &first_offer);
    pair.bob.accept(FRIEND).unwrap();
    pair.bob.complete_identity(&[0xB2; 32]).unwrap();
    let old_accept = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });

    // Alice withdraws before receiving ACCEPT. Lose CANCEL and restart both
    // peers while Bob still durably retries the old ACCEPT.
    let cancel = select_record(&pair.alice.cancel(FRIEND).unwrap(), |record| {
        matches!(record, Record::Cancel { .. })
    });
    pair.restart_alice();
    pair.restart_bob();
    let cancel_retry = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Cancel { .. })
    });
    assert_eq!(cancel_retry, cancel);
    let stale_accept_response = deliver(&pair.alice, &old_accept).outgoing;
    assert_eq!(stale_accept_response, cancel);

    // Lose that response too and immediately request a replacement. The
    // durable tombstone and new OFFER share one ordered drive; Bob first drops
    // its stale responder preparation and can then accept the replacement.
    pair.alice.request(FRIEND).unwrap();
    let replacement_drive = force_drive(&pair.alice, true);
    assert_eq!(
        select_record(&replacement_drive, |record| matches!(
            record,
            Record::Cancel { .. }
        )),
        cancel
    );
    let replacement_offer = select_record(&replacement_drive, |record| {
        matches!(
            record,
            Record::Offer {
                automatic: false,
                ..
            }
        )
    });
    assert_ne!(replacement_offer, first_offer);
    let incoming = deliver(&pair.bob, &replacement_drive);
    assert!(incoming.events.contains(&PqSessionEvent::OfferReceived));
    pair.bob.accept(FRIEND).unwrap();
    exchange_until(&pair, true, || {
        current(&pair.alice).is_some() && current(&pair.alice) == current(&pair.bob)
    });
    assert!(pair.alice.inner.lock().unwrap().stored.peers[&pair.bob_key]
        .cancelled
        .is_none());
    assert!(pair.bob.inner.lock().unwrap().stored.peers[&pair.alice_key]
        .cancelled
        .is_none());
    pair.cleanup();
}

#[test]
fn automatic_cancel_waits_for_explicit_plaintext_commit_after_restart() {
    let mut pair = Pair::new("automatic-cancel-choice");
    assert!(pair.alice.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    pair.alice.complete_identity(&[0xA1; 32]).unwrap();
    let offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(
            record,
            Record::Offer {
                automatic: true,
                ..
            }
        )
    });
    deliver(&pair.bob, &offer);

    // Bob cancels before generating ACCEPT. Alice must retain an explicit
    // decision wait rather than strand the first protected application row or
    // silently let a later row overtake it as plaintext.
    let cancel = pair.bob.cancel(FRIEND).unwrap();
    let rejected = deliver(&pair.alice, &cancel);
    assert_eq!(rejected.events, [PqSessionEvent::Rejected]);
    assert!(pair.alice.holds_plaintext(FRIEND));
    assert!(pair.alice.status(FRIEND).auto_pending);
    pair.restart_alice();
    assert!(pair.alice.holds_plaintext(FRIEND));
    assert!(pair.alice.first_send(FRIEND).unwrap());
    pair.alice.skip_auto(FRIEND).unwrap();
    assert!(pair.alice.auto_skip_pending(FRIEND));
    pair.restart_alice();
    assert!(pair.alice.holds_plaintext(FRIEND));
    pair.alice.finish_auto_skip(FRIEND).unwrap();
    assert!(!pair.alice.holds_plaintext(FRIEND));
    assert!(!pair.alice.first_send(FRIEND).unwrap());
    pair.cleanup();
}

#[test]
fn prepared_local_cancel_finishes_activation_then_closes_without_orphaning_keys() {
    let mut pair = Pair::new("prepared-cancel-safe-close");
    assert!(pair.alice.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    pair.alice.complete_identity(&[0xA1; 32]).unwrap();
    let offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    deliver(&pair.bob, &offer);
    pair.bob.complete_identity(&[0xB2; 32]).unwrap();
    let accept = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });
    let finish = deliver(&pair.alice, &accept).outgoing;
    assert!(pair.alice.cancel(FRIEND).unwrap().is_empty());
    {
        let state = pair.alice.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert_eq!(peer.handshake.as_ref().unwrap().phase, "prepared");
        assert!(peer.close_after_activation);
        assert_eq!(peer.epochs.len(), 1);
    }

    pair.restart_alice();
    let finish_retry = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Finish { .. })
    });
    assert_eq!(finish_retry, finish);
    let ready = deliver(&pair.bob, &finish_retry).outgoing;
    let commit = deliver(&pair.alice, &ready).outgoing;
    {
        let state = pair.alice.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert!(peer.current.is_some());
        assert_eq!(peer.close_phase, "pending");
        assert!(!peer.close_after_activation);
    }
    let done = deliver(&pair.bob, &commit).outgoing;
    deliver(&pair.alice, &done);
    exchange_until(&pair, true, || {
        current(&pair.alice).is_none() && current(&pair.bob).is_none()
    });
    pair.restart_alice();
    pair.restart_bob();
    assert_eq!(pair.alice.status(FRIEND).state, "available");
    assert_eq!(pair.bob.status(FRIEND).state, "available");
    pair.cleanup();
}

#[test]
fn cancel_race_discards_only_an_initiator_epoch_the_responder_never_prepared() {
    let mut pair = Pair::new("cancel-race-initiator-prepared");
    assert!(pair.alice.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    pair.alice.complete_identity(&[0xA1; 32]).unwrap();
    let offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    deliver(&pair.bob, &offer);
    pair.bob.complete_identity(&[0xB2; 32]).unwrap();
    let accept = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });

    // Bob cancels its accepting state before it ever handles FINISH, while the
    // ACCEPT already in flight lets Alice prepare the candidate epoch.
    let cancel = pair.bob.cancel(FRIEND).unwrap();
    let finish = deliver(&pair.alice, &accept).outgoing;
    let rejected = deliver(&pair.alice, &cancel);
    assert_eq!(rejected.events, [PqSessionEvent::Rejected]);
    {
        let state = pair.alice.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert!(peer.handshake.is_none());
        assert!(peer.epochs.is_empty());
        assert!(peer.auto_pending);
    }
    pair.restart_alice();
    pair.restart_bob();
    let stale_finish_response = deliver(&pair.bob, &finish).outgoing;
    assert_eq!(stale_finish_response, cancel);
    pair.alice.skip_auto(FRIEND).unwrap();
    pair.alice.finish_auto_skip(FRIEND).unwrap();
    pair.cleanup();
}

#[test]
fn responder_prepared_cancel_race_retains_keys_then_closes_after_activation() {
    let mut pair = Pair::new("cancel-race-responder-prepared");
    assert!(pair.alice.first_send(FRIEND).unwrap());
    deliver(&pair.alice, &pair.bob.capability());
    pair.alice.complete_identity(&[0xA1; 32]).unwrap();
    let offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Offer { .. })
    });
    let tx = match split_records(&offer).pop().unwrap().0 {
        Record::Offer { tx, .. } => tx,
        _ => unreachable!(),
    };
    deliver(&pair.bob, &offer);
    pair.bob.complete_identity(&[0xB2; 32]).unwrap();
    let accept = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });
    let finish = deliver(&pair.alice, &accept).outgoing;
    let ready = deliver(&pair.bob, &finish).outgoing;

    // Once the responder accepted FINISH, the initiator may already have
    // activated and emitted DATA. A late authenticated-by-transport CANCEL
    // cannot erase this preparation; it requests a close after activation.
    let injected_cancel = packets(&Record::Cancel { tx }).unwrap();
    let deferred = deliver(&pair.bob, &injected_cancel);
    assert_eq!(deferred.events, [PqSessionEvent::Rejected]);
    {
        let state = pair.bob.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert_eq!(peer.handshake.as_ref().unwrap().phase, "prepared");
        assert_eq!(peer.epochs.len(), 1);
        assert!(peer.close_after_activation);
    }
    pair.restart_bob();
    let commit = deliver(&pair.alice, &ready).outgoing;
    let done = deliver(&pair.bob, &commit).outgoing;
    {
        let state = pair.bob.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert!(peer.current.is_some());
        assert_eq!(peer.close_phase, "draining");
        assert!(!peer.close_after_activation);
    }
    deliver(&pair.alice, &done);
    exchange_until(&pair, true, || {
        current(&pair.alice).is_none() && current(&pair.bob).is_none()
    });
    pair.cleanup();
}

#[test]
fn offline_rekey_retains_old_epoch_until_its_ciphertext_is_acknowledged() {
    let mut pair = active_pair("old-epoch-backlog");
    let old_epoch = current(&pair.alice).unwrap();
    let backlog = pair
        .alice
        .encrypt(FRIEND, "old-operation", "old epoch backlog")
        .unwrap();

    pair.alice.drive(FRIEND, false, false).unwrap();
    pair.bob.drive(FRIEND, false, false).unwrap();
    assert!(pair.alice.first_send(FRIEND).unwrap());
    assert!(pair.alice.drive(FRIEND, false, false).unwrap().is_empty());
    assert_eq!(current(&pair.alice).as_deref(), Some(old_epoch.as_str()));
    assert_eq!(epoch_count(&pair.alice), 1);

    // Bring both peers back, but intentionally drop old DATA while allowing
    // the new epoch handshake to finish.
    let mut alice_to_bob = Vec::new();
    let mut bob_to_alice = Vec::new();
    for _ in 0..32 {
        alice_to_bob.extend(select_optional(
            &force_drive(&pair.alice, false),
            |record| !matches!(record, Record::Capability { .. } | Record::Data { .. }),
        ));
        bob_to_alice.extend(select_optional(&force_drive(&pair.bob, false), |record| {
            !matches!(record, Record::Capability { .. } | Record::Data { .. })
        }));
        let from_bob = deliver(&pair.bob, &alice_to_bob).outgoing;
        let from_alice = deliver(&pair.alice, &bob_to_alice).outgoing;
        alice_to_bob = from_alice;
        bob_to_alice = from_bob;
        if current(&pair.alice).as_deref() != Some(old_epoch.as_str())
            && current(&pair.alice) == current(&pair.bob)
        {
            break;
        }
    }
    assert_ne!(current(&pair.alice).as_deref(), Some(old_epoch.as_str()));
    assert_eq!(current(&pair.alice), current(&pair.bob));
    assert_eq!(epoch_count(&pair.alice), 2);
    assert_eq!(epoch_count(&pair.bob), 2);

    pair.restart_alice();
    pair.restart_bob();
    let exact_retry = pair
        .alice
        .encrypt(FRIEND, "old-operation", "old epoch backlog")
        .unwrap();
    assert_eq!(exact_retry.wire_id, backlog.wire_id);
    assert!(exact_retry.packets.is_empty());
    let driven_retry = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(record, Record::Data { .. })
    });
    assert_eq!(driven_retry, backlog.packets);
    let received = deliver(&pair.bob, &driven_retry);
    assert_eq!(received.texts, ["old epoch backlog"]);
    let ack = pair.bob.commit_received(FRIEND, backlog.wire_id).unwrap();
    deliver(&pair.alice, &ack);
    pair.alice
        .forget_delivered(FRIEND, backlog.wire_id)
        .unwrap();

    exchange_until(&pair, true, || {
        epoch_count(&pair.alice) == 1 && epoch_count(&pair.bob) == 1
    });
    assert!(
        !pair.alice.inner.lock().unwrap().stored.peers[&pair.bob_key]
            .epochs
            .contains_key(&old_epoch)
    );
    assert!(
        !pair.bob.inner.lock().unwrap().stored.peers[&pair.alice_key]
            .epochs
            .contains_key(&old_epoch)
    );
    pair.cleanup();
}

#[test]
fn process_restart_marks_an_active_session_for_online_first_send_refresh() {
    let mut pair = active_pair("restart-refresh");
    let old_epoch = current(&pair.alice).unwrap();

    // No explicit offline drive occurs before process loss. Rebinding a saved
    // active session must still remember that the local endpoint was offline.
    pair.restart_alice();
    assert!(pair.alice.inner.lock().unwrap().runtime[&pair.bob_key].refresh_due);
    assert!(pair.alice.first_send(FRIEND).unwrap());
    assert!(pair.alice.inner.lock().unwrap().stored.peers[&pair.bob_key].refresh_requested);

    // Offline drive cannot create a replacement epoch and never expires the
    // old one. The first online exchange performs the durable refresh.
    assert!(pair.alice.drive(FRIEND, false, true).unwrap().is_empty());
    assert_eq!(current(&pair.alice).as_deref(), Some(old_epoch.as_str()));
    exchange_until(&pair, true, || {
        current(&pair.alice).as_deref() != Some(old_epoch.as_str())
            && current(&pair.alice) == current(&pair.bob)
    });
    assert!(!pair.alice.inner.lock().unwrap().runtime[&pair.bob_key].refresh_due);
    pair.cleanup();
}

#[test]
fn repeated_confirmed_epochs_compact_only_obsolete_retirement_tombstones() {
    let pair = active_pair("retired-compaction");
    let mut parent = current(&pair.alice).unwrap();

    for _ in 0..6 {
        pair.alice.drive(FRIEND, false, true).unwrap();
        assert!(pair.alice.first_send(FRIEND).unwrap());
        exchange_until(&pair, true, || {
            current(&pair.alice).as_deref() != Some(parent.as_str())
                && current(&pair.alice) == current(&pair.bob)
        });
        let child = current(&pair.alice).unwrap();

        // Activation of the authenticated child proves both peers had already
        // retired everything older than its parent. The parent's live epoch is
        // retained until the bilateral final sequence exchange completes.
        assert!(retired_ids(&pair.alice).is_empty());
        assert!(retired_ids(&pair.bob).is_empty());
        assert!(pair.alice.inner.lock().unwrap().stored.peers[&pair.bob_key]
            .epochs
            .contains_key(&parent));
        assert!(pair.bob.inner.lock().unwrap().stored.peers[&pair.alice_key]
            .epochs
            .contains_key(&parent));

        exchange_until(&pair, true, || {
            epoch_count(&pair.alice) == 1 && epoch_count(&pair.bob) == 1
        });
        assert_eq!(retired_ids(&pair.alice), [parent.clone()]);
        assert_eq!(retired_ids(&pair.bob), [parent.clone()]);
        parent = child;
    }
    pair.cleanup();
}

#[test]
fn close_defers_during_inflight_refresh_and_a_ready_close_routes_new_text_plain() {
    let mut pair = active_pair("close-versus-refresh");
    let original_epoch = current(&pair.alice).unwrap();

    pair.alice.drive(FRIEND, false, true).unwrap();
    assert!(pair.alice.first_send(FRIEND).unwrap());
    let refresh_offer = select_record(&force_drive(&pair.alice, true), |record| {
        matches!(
            record,
            Record::Offer {
                parent: Some(_),
                ..
            }
        )
    });
    deliver(&pair.bob, &refresh_offer);
    let delayed_accept = select_record(&force_drive(&pair.bob, true), |record| {
        matches!(record, Record::Accept { .. })
    });

    let close = pair.alice.shutdown(FRIEND).unwrap();
    assert!(close.is_empty());
    // An ACCEPT that was already in flight finishes the already durable refresh
    // before shutdown advances. Discarding one side's prepared secrets would
    // make the two peers disagree after a crash.
    let late = deliver(&pair.alice, &delayed_accept);
    assert!(late.texts.is_empty());
    let ready = deliver(&pair.bob, &late.outgoing).outgoing;
    let commit = deliver(&pair.alice, &ready).outgoing;
    let done = deliver(&pair.bob, &commit).outgoing;
    deliver(&pair.alice, &done);
    assert_ne!(
        current(&pair.alice).as_deref(),
        Some(original_epoch.as_str())
    );
    assert_eq!(current(&pair.alice), current(&pair.bob));
    assert_eq!(epoch_count(&pair.alice), 2);

    // The next drive publishes close for the newly agreed current epoch.
    let close = select_record(
        &force_drive(&pair.alice, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close"),
    );
    let response = deliver(&pair.bob, &close).outgoing;
    deliver(&pair.alice, &response);
    let close_ready = force_drive(&pair.alice, true);
    assert!(split_records(&close_ready).iter().any(|(record, _)| {
        matches!(record, Record::Signal { action, .. } if action == "close_ready")
    }));
    {
        let state = pair.alice.inner.lock().unwrap();
        assert_eq!(peer(&state, FRIEND).unwrap().close_phase, "ready");
    }
    // The product's regular queue will hold this text until close completes;
    // it must not be stranded forever in the now sealed PQ queue.
    assert!(!pair.alice.first_send(FRIEND).unwrap());

    exchange_until(&pair, true, || {
        current(&pair.alice).is_none() && current(&pair.bob).is_none()
    });
    pair.restart_alice();
    pair.restart_bob();
    assert!(!pair.alice.first_send(FRIEND).unwrap());
    pair.cleanup();
}

#[test]
fn every_close_phase_cut_survives_restart_and_a_lost_close_still_converges() {
    let mut pair = active_pair("all-close-cuts");

    // CLOSE is durable before publication. Prove its exact retry, then lose it
    // anyway: the sender is allowed to advance to CLOSE_READY after restart,
    // and that authenticated record must also initiate close at the peer.
    let close = select_record(
        &pair.alice.shutdown(FRIEND).unwrap(),
        |record| matches!(record, Record::Signal { action, .. } if action == "close"),
    );
    pair.restart_alice();
    let close_retry = select_record(
        &pair.alice.shutdown(FRIEND).unwrap(),
        |record| matches!(record, Record::Signal { action, .. } if action == "close"),
    );
    assert_eq!(close_retry, close);
    pair.restart_alice();
    pair.restart_bob();

    let alice_ready = select_record(
        &force_drive(&pair.alice, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
    );
    pair.restart_alice();
    let alice_ready_retry = select_record(
        &force_drive(&pair.alice, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
    );
    assert_eq!(alice_ready_retry, alice_ready);
    let bob_received_ready = deliver(&pair.bob, &alice_ready_retry);
    assert_eq!(bob_received_ready.events, [PqSessionEvent::CloseRequested]);
    assert!(bob_received_ready.outgoing.is_empty());

    // Bob's accepted boundary and its own CLOSE_READY are durable too.
    pair.restart_bob();
    let bob_ready = select_record(
        &force_drive(&pair.bob, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
    );
    pair.restart_bob();
    let bob_ready_retry = select_record(
        &force_drive(&pair.bob, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
    );
    assert_eq!(bob_ready_retry, bob_ready);
    deliver(&pair.alice, &bob_ready_retry);

    // Lose CLOSE_COMMIT after its durable transition, then restart and require
    // an exact retry. Bob commits close before publishing CLOSE_ACK.
    pair.restart_alice();
    let close_commit = select_record(
        &force_drive(&pair.alice, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close_commit"),
    );
    pair.restart_alice();
    let close_commit_retry = select_record(
        &force_drive(&pair.alice, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close_commit"),
    );
    assert_eq!(close_commit_retry, close_commit);
    let bob_closed = deliver(&pair.bob, &close_commit_retry);
    assert_eq!(bob_closed.events, [PqSessionEvent::Closed]);
    let close_ack = select_record(
        &bob_closed.outgoing,
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ack"),
    );

    // Lose CLOSE_ACK and restart the already-closed peer. A duplicate durable
    // commit must recover the exact cached response without resurrecting keys.
    pair.restart_bob();
    let commit_after_ack_loss = select_record(
        &force_drive(&pair.alice, true),
        |record| matches!(record, Record::Signal { action, .. } if action == "close_commit"),
    );
    assert_eq!(commit_after_ack_loss, close_commit);
    let recovered_ack = deliver(&pair.bob, &commit_after_ack_loss);
    assert_eq!(recovered_ack.outgoing, close_ack);
    assert!(recovered_ack.events.is_empty());
    deliver(&pair.alice, &recovered_ack.outgoing);

    pair.restart_alice();
    pair.restart_bob();
    assert!(current(&pair.alice).is_none());
    assert!(current(&pair.bob).is_none());
    assert_eq!(pair.alice.status(FRIEND).state, "available");
    assert_eq!(pair.bob.status(FRIEND).state, "available");
    assert!(!pair.alice.first_send(FRIEND).unwrap());
    assert!(!pair.bob.first_send(FRIEND).unwrap());
    pair.cleanup();
}

fn crossed_close_ready_restart_converges(label: &str, alice_key_byte: u8, bob_key_byte: u8) {
    let mut pair = active_pair_with_keys(label, alice_key_byte, bob_key_byte);
    let alice_is_coordinator = pair.alice_key < pair.bob_key;

    let dropped_ready = {
        let (coordinator, peer) = if alice_is_coordinator {
            (&pair.alice, &pair.bob)
        } else {
            (&pair.bob, &pair.alice)
        };
        let message = coordinator
            .encrypt(
                FRIEND,
                "crossed-close-ready-boundary",
                "delivered before close",
            )
            .unwrap();
        let received = deliver(peer, &message.packets);
        assert_eq!(received.texts, ["delivered before close"]);
        assert_eq!(received.received_wires, [message.wire_id]);
        let acknowledgement = peer.commit_received(FRIEND, message.wire_id).unwrap();
        let acknowledged = deliver(coordinator, &acknowledgement);
        assert_eq!(acknowledged.acknowledged_wires, [message.wire_id]);

        let close = select_record(
            &coordinator.shutdown(FRIEND).unwrap(),
            |record| matches!(record, Record::Signal { action, .. } if action == "close"),
        );
        deliver(peer, &close);

        // The peer's boundary crosses first. The coordinator then durably
        // creates its own CLOSE_READY, but that publication is lost.
        let peer_ready = select_record(
            &force_drive(peer, true),
            |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
        );
        deliver(coordinator, &peer_ready);
        let dropped_ready = select_record(
            &force_drive(coordinator, true),
            |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
        );
        assert!(!dropped_ready.is_empty());
        dropped_ready
    };

    if alice_is_coordinator {
        pair.restart_alice();
    } else {
        pair.restart_bob();
    }

    let first_retry = force_drive(
        if alice_is_coordinator {
            &pair.alice
        } else {
            &pair.bob
        },
        true,
    );
    let coordinator_ready = select_record(
        &first_retry,
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
    );
    assert_eq!(coordinator_ready, dropped_ready);
    let close_commit = select_record(
        &first_retry,
        |record| matches!(record, Record::Signal { action, .. } if action == "close_commit"),
    );
    let ready_index = first_retry
        .iter()
        .position(|packet| packet == &coordinator_ready[0])
        .unwrap();
    let commit_index = first_retry
        .iter()
        .position(|packet| packet == &close_commit[0])
        .unwrap();
    assert!(ready_index < commit_index);

    // Reordering cannot retire the epoch: COMMIT is rejected until READY has
    // supplied the authenticated final receive boundary.
    let peer = if alice_is_coordinator {
        &pair.bob
    } else {
        &pair.alice
    };
    for packet in &close_commit {
        let error = match peer.handle(FRIEND, packet) {
            Ok(_) => panic!("reordered CLOSE_COMMIT was accepted before CLOSE_READY"),
            Err(error) => error,
        };
        assert_eq!(error, "PQ_CLOSE_COMMIT_WAIT");
    }
    assert!(current(peer).is_some());
    assert_eq!(epoch_count(peer), 1);

    // The persisted commit phase must retain both records across another
    // coordinator restart, with READY still ordered before COMMIT.
    if alice_is_coordinator {
        pair.restart_alice();
    } else {
        pair.restart_bob();
    }
    let coordinator = if alice_is_coordinator {
        &pair.alice
    } else {
        &pair.bob
    };
    let peer = if alice_is_coordinator {
        &pair.bob
    } else {
        &pair.alice
    };
    let second_retry = force_drive(coordinator, true);
    let coordinator_ready_retry = select_record(
        &second_retry,
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ready"),
    );
    let close_commit_retry = select_record(
        &second_retry,
        |record| matches!(record, Record::Signal { action, .. } if action == "close_commit"),
    );
    assert_eq!(coordinator_ready_retry, coordinator_ready);
    assert_eq!(close_commit_retry, close_commit);
    let ready_index = second_retry
        .iter()
        .position(|packet| packet == &coordinator_ready_retry[0])
        .unwrap();
    let commit_index = second_retry
        .iter()
        .position(|packet| packet == &close_commit_retry[0])
        .unwrap();
    assert!(ready_index < commit_index);

    let first_ready = deliver(peer, &coordinator_ready_retry);
    assert!(first_ready.outgoing.is_empty());
    let duplicate_ready = deliver(peer, &coordinator_ready_retry);
    assert!(duplicate_ready.outgoing.is_empty());

    let closed = deliver(peer, &close_commit_retry);
    assert_eq!(closed.events, [PqSessionEvent::Closed]);
    let close_ack = select_record(
        &closed.outgoing,
        |record| matches!(record, Record::Signal { action, .. } if action == "close_ack"),
    );
    assert!(current(peer).is_none());

    // After a restart, duplicate READY and COMMIT both return the exact cached
    // ACK and never resurrect the retired epoch.
    if alice_is_coordinator {
        pair.restart_bob();
    } else {
        pair.restart_alice();
    }
    let coordinator = if alice_is_coordinator {
        &pair.alice
    } else {
        &pair.bob
    };
    let peer = if alice_is_coordinator {
        &pair.bob
    } else {
        &pair.alice
    };
    let cached_ready = deliver(peer, &coordinator_ready_retry);
    let cached_commit = deliver(peer, &close_commit_retry);
    assert_eq!(cached_ready.outgoing, close_ack);
    assert_eq!(cached_commit.outgoing, close_ack);
    assert!(cached_ready.events.is_empty());
    assert!(cached_commit.events.is_empty());
    deliver(coordinator, &cached_commit.outgoing);
    assert!(current(coordinator).is_none());

    pair.restart_alice();
    pair.restart_bob();
    assert!(current(&pair.alice).is_none());
    assert!(current(&pair.bob).is_none());
    assert!(!pair.alice.first_send(FRIEND).unwrap());
    assert!(!pair.bob.first_send(FRIEND).unwrap());
    pair.cleanup();
}

#[test]
fn crossed_close_ready_restart_replays_boundary_before_commit_for_both_owner_orderings() {
    crossed_close_ready_restart_converges("crossed-ready-alice-coordinator", 0x11, 0x22);
    crossed_close_ready_restart_converges("crossed-ready-bob-coordinator", 0x22, 0x11);
}

#[test]
fn reassembly_bounds_and_failed_checkpoint_do_not_publish_state() {
    let root = test_root("reassembly-bounds");
    fs::create_dir_all(&root).unwrap();
    let engine = open_engine(&root, &stable_key(0x22), &stable_key(0x11));
    for marker in 0..MAX_PARTIALS {
        let record = Record::Capability {
            identity: vec![marker as u8; MLKEM_PUBLIC_KEY_BYTES],
        };
        let fragments = packets(&record).unwrap();
        assert!(fragments.len() > 1);
        assert!(engine
            .handle(FRIEND, &fragments[0])
            .unwrap()
            .received_text
            .is_none());
    }
    let overflow = packets(&Record::Capability {
        identity: vec![0xFF; MLKEM_PUBLIC_KEY_BYTES],
    })
    .unwrap();
    assert_eq!(
        match engine.handle(FRIEND, &overflow[0]) {
            Ok(_) => panic!("seventeenth partial record was accepted"),
            Err(error) => error,
        },
        "PQ_REASSEMBLY_BACKPRESSURE"
    );
    drop(engine);
    fs::remove_dir_all(root).unwrap();

    // Use a real mounted synthetic .kai profile, then make its parent path
    // unwritable. The transaction must return failure while keeping the
    // published in-memory state and every later checkpoint at the previous
    // value for this exact file.
    let root = test_root("checkpoint-publication");
    let held_root = root.with_extension("held");
    let container = root.join("profile.kai");
    let volume = crate::kai::KaiProfileVolume::create(container.clone(), None).unwrap();
    let data_dir = volume.namespace_root().join("data");
    let engine = open_engine(&data_dir, &stable_key(0x22), &stable_key(0x11));
    fs::rename(&root, &held_root).unwrap();
    fs::write(&root, b"checkpoint parent blocker").unwrap();
    assert!(engine.first_send(FRIEND).is_err());
    {
        let state = engine.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert!(!peer.first_message_seen);
        assert!(!peer.auto_pending);
    }
    assert!(
        select_optional(&force_drive(&engine, true), |record| matches!(
            record,
            Record::Offer { .. }
        ))
        .is_empty()
    );

    fs::remove_file(&root).unwrap();
    fs::rename(&held_root, &root).unwrap();
    let unrelated = data_dir.join("unrelated.json");
    profiles::write_file(&unrelated, br#"{"committed":true}"#).unwrap();
    profiles::checkpoint_managed_volume(&unrelated).unwrap();
    drop(engine);
    volume.discard();
    drop(volume);

    let reopened_volume = crate::kai::KaiProfileVolume::open(container, None).unwrap();
    let reopened = open_engine(&data_dir, &stable_key(0x22), &stable_key(0x11));
    {
        let state = reopened.inner.lock().unwrap();
        let peer = peer(&state, FRIEND).unwrap();
        assert!(!peer.first_message_seen);
        assert!(!peer.auto_pending);
    }
    drop(reopened);
    reopened_volume.discard();
    drop(reopened_volume);
    fs::remove_dir_all(root).unwrap();
}
