use super::*;
use std::collections::HashSet;

const CAPABILITY_REQUEST: &[u8] = &[PACKET_ID, b'T', b'P', b'Q', 2, 0];
const MAX_TRANSPORT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TRANSPORT_PACKETS: usize = 16_384;

/// Connects the durable PQ engine to the transient Tox packet queue.
pub struct PqEngine {
    v2: v2::Engine,
    outbox: Mutex<VecDeque<(u32, Vec<u8>)>>,
    #[cfg(feature = "pq-fault-tests")]
    fault: super::fault::FaultInjector,
}

impl PqEngine {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        Ok(Self {
            v2: v2::Engine::new(data_dir)?,
            outbox: Mutex::new(VecDeque::new()),
            #[cfg(feature = "pq-fault-tests")]
            fault: super::fault::FaultInjector::from_env()?,
        })
    }

    pub fn bind_contact(
        &self,
        friend: u32,
        key: &str,
        owner: &str,
        existing: bool,
    ) -> Result<(), String> {
        self.v2.bind(friend, key, owner, existing)
    }

    pub fn contact_bound(&self, friend: u32, key: &str) -> bool {
        self.v2.bound(friend, key)
    }

    pub fn bind_contacts(
        &self,
        contacts: &[(u32, String, bool)],
        owner: &str,
    ) -> Result<(), String> {
        self.v2.bind_contacts(contacts, owner)
    }

    #[cfg(test)]
    pub fn first_send(&self, friend: u32, peer_online: bool) -> Result<bool, String> {
        self.first_send_observed(friend, true, peer_online, None)
    }

    pub fn connection_revision(&self, friend: u32) -> u64 {
        self.v2.connection_revision(friend)
    }

    pub fn first_send_observed(
        &self,
        friend: u32,
        local_online: bool,
        peer_online: bool,
        observed_revision: Option<u64>,
    ) -> Result<bool, String> {
        self.v2.first_send(friend, local_online, peer_online, observed_revision)
    }

    pub fn observe_contact_readiness(
        &self,
        friend: u32,
        key: &str,
        observed_revision: u64,
        ready: bool,
    ) -> Result<(), String> {
        self.v2
            .observe_contact_readiness(friend, key, observed_revision, ready)?;
        if !self.v2.ready(friend) {
            let local_ready = self.v2.local_ready(friend);
            if let Ok(mut outbox) = self.outbox.lock() {
                outbox.retain(|(owner, packet)| {
                    *owner != friend
                        || local_ready && v2::is_readiness_packet(packet)
                });
            }
        }
        Ok(())
    }

    pub fn contact_ready(&self, friend: u32, key: &str) -> bool {
        self.v2.contact_ready(friend, key)
    }

    fn require_ready(&self, friend: u32) -> Result<(), String> {
        if self.v2.ready(friend) {
            Ok(())
        } else {
            Err("PQ_PEER_READINESS_NOT_CONFIRMED".into())
        }
    }

    fn packet_ready(&self, friend: u32, packet: &[u8]) -> bool {
        v2::is_packet(packet)
            && (self.v2.ready(friend) || self.v2.local_ready(friend) && v2::is_readiness_packet(packet))
    }

    pub fn superseded(&self, friend: u32) -> Vec<(u64, String)> {
        self.v2.superseded(friend)
    }

    pub fn forget_superseded(&self, friend: u32, wire: u64) -> Result<(), String> {
        self.v2.forget_superseded(friend, wire)
    }

    pub fn connection_changed(&self, friend: u32, online: bool) -> Result<(), String> {
        let result = self.v2.connection_changed(friend, online);
        // A packet from a previous validation interval cannot be sent after
        // reconnecting. The journal regenerates durable records.
        if let Ok(mut outbox) = self.outbox.lock() {
            outbox.retain(|(owner, _)| *owner != friend);
        }
        result
    }

    pub fn skip_auto(&self, friend: u32) -> Result<(), String> {
        self.v2.skip_auto(friend)
    }

    pub fn auto_skip_pending(&self, friend: u32) -> bool {
        self.v2.auto_skip_pending(friend)
    }

    pub fn finish_auto_skip(&self, friend: u32) -> Result<(), String> {
        self.v2.finish_auto_skip(friend)
    }

    pub fn owns_session(&self, friend: u32) -> bool {
        self.v2.owns(friend)
    }

    pub fn capability_packet(&self) -> Vec<u8> {
        CAPABILITY_REQUEST.to_vec()
    }

    /// Bounds the transient outbox. The journal regenerates durable packets,
    /// and deduplication keeps retries from accumulating under backpressure.
    pub fn queue(&self, friend: u32, packets: impl IntoIterator<Item = Vec<u8>>) {
        let mut expanded_packets = Vec::new();
        for bytes in packets {
            let expanded = if bytes == CAPABILITY_REQUEST {
                self.v2.discovery(friend)
            } else {
                vec![bytes]
            };
            expanded_packets.extend(
                expanded
                    .into_iter()
                    .filter(|packet| self.packet_ready(friend, packet)),
            );
        }
        #[cfg(feature = "pq-fault-tests")]
        let filtered = self.fault.filter_with_snapshot(
            friend,
            expanded_packets,
            self.v2.fault_snapshot(friend).ok(),
        );
        #[cfg(feature = "pq-fault-tests")]
        let expanded_packets = filtered.packets;
        let discovery_ids = expanded_packets
            .iter()
            .filter_map(|packet| v2::capability_discovery_id(packet))
            .collect::<HashSet<_>>();
        let Ok(mut outbox) = self.outbox.lock() else {
            return;
        };
        #[cfg(feature = "pq-fault-tests")]
        if filtered.blocked {
            outbox.retain(|(owner, _)| *owner != friend);
        }
        let mut known = outbox.iter().cloned().collect::<HashSet<_>>();
        let mut queued_bytes: usize = outbox.iter().map(|(_, bytes)| bytes.len()).sum();
        for packet in expanded_packets {
            if known.contains(&(friend, packet.clone())) {
                continue;
            }
            let discovery = v2::packet_id(&packet).is_some_and(|id| discovery_ids.contains(&id));
            if discovery {
                // Capability probes and their ACKs are runtime-only. Admit the
                // complete incoming discovery record by yielding older durable
                // v2 transport packets, which drive regenerates from its journal.
                while queued_bytes.saturating_add(packet.len()) > MAX_TRANSPORT_BYTES
                    || outbox.len() >= MAX_TRANSPORT_PACKETS
                {
                    let protected_ids = outbox
                        .iter()
                        .filter_map(|(_, queued)| v2::capability_discovery_id(queued))
                        .collect::<HashSet<_>>();
                    let incoming_id = v2::packet_id(&packet);
                    let index = outbox
                        .iter()
                        .rposition(|(_, queued)| {
                            v2::packet_id(queued)
                                    .is_none_or(|id| !protected_ids.contains(&id))
                        })
                        .or_else(|| {
                            outbox.iter().rposition(|(_, queued)| {
                                v2::packet_id(queued) != incoming_id
                            })
                        });
                    let Some(index) = index else {
                        break;
                    };
                    let (owner, removed) = outbox.remove(index).expect("selected outbox packet");
                    queued_bytes = queued_bytes.saturating_sub(removed.len());
                    known.remove(&(owner, removed));
                }
            }
            if queued_bytes.saturating_add(packet.len()) > MAX_TRANSPORT_BYTES
                || outbox.len() >= MAX_TRANSPORT_PACKETS
            {
                // The protocol journal is not changed. DATA retries include
                // missing fragments; duplicate DATA also regenerates its ACK.
                continue;
            }
            if known.insert((friend, packet.clone())) {
                queued_bytes += packet.len();
                outbox.push_back((friend, packet));
            }
        }
    }

    pub fn take_outbox(&self) -> VecDeque<(u32, Vec<u8>)> {
        let mut output = self
            .outbox
            .lock()
            .map(|mut outbox| std::mem::take(&mut *outbox))
            .unwrap_or_default();
        #[cfg(feature = "pq-fault-tests")]
        if let Some(blocked) = self.fault.blocked_friend() {
            output.retain(|(owner, _)| *owner != blocked);
        }
        output.retain(|(friend, packet)| self.packet_ready(*friend, packet));
        output
    }

    pub fn requeue_front(&self, mut packets: VecDeque<(u32, Vec<u8>)>) {
        packets.retain(|(friend, packet)| self.packet_ready(*friend, packet));
        #[cfg(feature = "pq-fault-tests")]
        if let Some(friend) = self.fault.blocked_friend() {
            packets.retain(|(owner, _)| *owner != friend);
        }
        if let Ok(mut outbox) = self.outbox.lock() {
            packets.append(&mut outbox);
            *outbox = packets;
        }
    }

    pub fn reconcile_friend_numbers(&self, resolved: &HashMap<u32, u32>) {
        self.v2.remap(resolved);
        if let Ok(mut outbox) = self.outbox.lock() {
            *outbox = std::mem::take(&mut *outbox)
                .into_iter()
                .filter_map(|(old, packet)| resolved.get(&old).map(|new| (*new, packet)))
                .collect();
        }
    }

    pub fn remove_friend(&self, friend: u32) -> Result<(), String> {
        self.v2.detach(friend)?;
        self.v2.unbind(friend);
        if let Ok(mut outbox) = self.outbox.lock() {
            outbox.retain(|(owner, _)| *owner != friend);
        }
        Ok(())
    }

    pub fn status(&self, friend: u32) -> PqStatus {
        #[cfg(feature = "pq-fault-tests")]
        self.fault.observe(friend, self.v2.fault_snapshot(friend).ok());
        self.v2.status(friend)
    }

    pub fn active_history_role(&self, friend: u32) -> Option<(&'static str, bool)> {
        self.v2.active_history_role(friend)
    }

    pub fn active_history_notice(
        &self,
        friend: u32,
    ) -> Result<(Option<(String, Option<String>)>, bool, u64), String> {
        self.v2.active_history_notice(friend)
    }

    pub fn mark_active_history_notified(
        &self,
        friend: u32,
        local: &str,
        remote: Option<&str>,
    ) -> Result<(), String> {
        self.v2.mark_active_history_notified(friend, local, remote)
    }

    pub fn begin_identity_entropy(&self, friend: u32) -> Result<u64, String> {
        self.v2.begin_identity_entropy(friend)
    }

    pub fn complete_identity(&self, noise: &[u8]) -> Result<(), String> {
        self.v2.complete_identity(noise)
    }

    pub fn queues_encrypted_messages(&self, friend: u32) -> bool {
        self.v2.encrypts(friend)
    }

    pub fn holds_plaintext_messages(&self, friend: u32) -> bool {
        self.v2.holds_plaintext(friend)
    }

    pub fn drive(&self, friend: u32, online: bool, external_drained: bool) -> Result<(), String> {
        self.queue(friend, self.v2.drive(friend, online, external_drained)?);
        Ok(())
    }

    pub fn request(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        self.require_ready(friend)?;
        self.v2.request(friend)
    }

    pub fn accept(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        self.require_ready(friend)?;
        self.v2.accept(friend)
    }

    pub fn withdraw(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        self.v2.cancel(friend)
    }

    pub fn reject(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        self.v2.cancel(friend)
    }

    pub fn request_shutdown(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        self.v2.shutdown(friend)
    }

    pub fn cancel_shutdown(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        self.v2.cancel_shutdown(friend)
    }

    pub fn encrypt(&self, friend: u32, text: &str) -> Result<EncryptedMessage, String> {
        let operation = format!("service:{}", encode_hex(&Sha256::digest(text.as_bytes())));
        self.encrypt_named(friend, &operation, text)
    }

    pub fn encrypt_named(
        &self,
        friend: u32,
        operation: &str,
        text: &str,
    ) -> Result<EncryptedMessage, String> {
        self.v2.encrypt(friend, operation, text)
    }

    #[cfg(test)]
    pub fn handle_packet(&self, friend: u32, bytes: &[u8]) -> Result<PacketResult, String> {
        self.handle_packet_observed(friend, bytes, true)
    }

    /// Ignores obsolete packets and packets delivered across a local suspend.
    /// The durable sender can retry a current packet after reconnection.
    pub fn handle_packet_observed(
        &self,
        friend: u32,
        bytes: &[u8],
        local_online: bool,
    ) -> Result<PacketResult, String> {
        if !local_online || !v2::is_packet(bytes) {
            return Ok(empty_packet_result());
        }
        let generation = self.v2.reset_generation(friend);
        let result = self.v2.handle(friend, bytes);
        if self.v2.reset_generation(friend) != generation {
            if let Ok(mut outbox) = self.outbox.lock() {
                outbox.retain(|(owner, _)| *owner != friend);
            }
        }
        result
    }

    pub fn commit_received(&self, friend: u32, wire: u64) -> Result<Vec<Vec<u8>>, String> {
        self.v2.commit_received(friend, wire)
    }

    pub fn discard_received(&self, friend: u32, wire: u64) {
        self.v2.discard_received(friend, wire);
    }

    pub fn delivered(&self, friend: u32) -> Vec<(u64, String)> {
        self.v2.delivered(friend)
    }

    pub fn forget_delivered(&self, friend: u32, wire: u64) -> Result<(), String> {
        self.v2.forget_delivered(friend, wire)
    }

    pub fn has_durable_message(&self, id: &str) -> bool {
        self.v2.has_durable_message(id)
    }

    pub fn discard_message(&self, friend: u32, operation: &str) -> Result<(), String> {
        let retired = self.v2.discard_message(friend, operation)?;
        self.outbox
            .lock()
            .map_err(|_| "PQ_STATE_LOCKED")?
            .retain(|(owner, packet)| *owner != friend || !retired.contains(packet));
        Ok(())
    }
}

fn empty_packet_result() -> PacketResult {
    PacketResult {
        received_wire_id: None,
        outgoing: Vec::new(),
        received_text: None,
        acknowledged_wire_id: None,
        session_event: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "pq-fault-tests")]
    use sha2::{Digest, Sha256};
    use std::{
        collections::BTreeMap,
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_ROOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn test_root(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let sequence = NEXT_ROOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "kaigen-pq-engine-{label}-{}-{suffix}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create test root");
        root
    }

    fn v2_record_kinds(packets: &VecDeque<(u32, Vec<u8>)>) -> Vec<String> {
        let mut groups = HashMap::<[u8; 16], BTreeMap<u16, Vec<u8>>>::new();
        for (_, packet) in packets.iter().filter(|(_, packet)| v2::is_packet(packet)) {
            let digest: [u8; 16] = packet[6..22].try_into().unwrap();
            let index = u16::from_be_bytes(packet[22..24].try_into().unwrap());
            groups
                .entry(digest)
                .or_default()
                .insert(index, packet.clone());
        }
        groups
            .into_values()
            .map(|parts| {
                let bytes = parts
                    .into_values()
                    .flat_map(|packet| packet[30..].to_vec())
                    .collect::<Vec<_>>();
                serde_json::from_slice::<serde_json::Value>(&bytes)
                    .unwrap()
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    // Readiness is a separate fixture boundary from PQ capability discovery.
    // Reassemble actual generated records so CapabilityProbe/Ack cannot leak in.
    fn readiness_only_packets(packets: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let mut groups = BTreeMap::<[u8; 16], BTreeMap<u16, Vec<u8>>>::new();
        for packet in packets {
            let digest = v2::packet_id(&packet).expect("generated v2 packet");
            let index = u16::from_be_bytes(packet[22..24].try_into().unwrap());
            groups.entry(digest).or_default().insert(index, packet);
        }
        groups
            .into_values()
            .flat_map(|parts| {
                let packets = parts.into_values().collect::<Vec<_>>();
                let bytes = packets
                    .iter()
                    .flat_map(|p| p[30..].iter().copied())
                    .collect::<Vec<_>>();
                let record = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap();
                if matches!(
                    record["kind"].as_str(),
                    Some("ReadinessProbe" | "ReadinessAck")
                ) {
                    packets
                } else {
                    Vec::new()
                }
            })
            .collect()
    }

    fn confirm_readiness(local: &PqEngine, friend: u32, key: &str) {
        local.connection_changed(friend, true).unwrap();
        local
            .observe_contact_readiness(friend, key, local.connection_revision(friend), true)
            .unwrap();
        let path = test_root("readiness-peer-fixture");
        std::fs::create_dir_all(&path).unwrap();
        let peer = PqEngine::new(&path).unwrap();
        let remote_key = "AA".repeat(32);
        peer.bind_contact(friend, &remote_key, &"BB".repeat(32), false)
            .unwrap();
        peer.connection_changed(friend, true).unwrap();
        peer.observe_contact_readiness(friend, &remote_key, peer.connection_revision(friend), true)
            .unwrap();
        for packet in readiness_only_packets(local.v2.discovery(friend)) {
            let result = peer.handle_packet(friend, &packet).unwrap();
            for reply in readiness_only_packets(result.outgoing) {
                local.handle_packet(friend, &reply).unwrap();
            }
        }
        assert!(local.contact_ready(friend, &key));
        drop(peer);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn manual_known_v2_request_waits_for_fresh_capability_across_restart() {
        let root = test_root("manual-known-v2-restart");
        let local_dir = root.join("local");
        let remote_dir = root.join("remote");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_dir).unwrap();
        let friend = 7;
        let peer_key = "11".repeat(32);
        let owner_key = "22".repeat(32);
        let remote = PqEngine::new(&remote_dir).unwrap();
        let local = PqEngine::new(&local_dir).unwrap();
        local
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        confirm_readiness(&local, friend, &peer_key);
        local.connection_changed(friend, true).unwrap();
        confirm_readiness(&local, friend, &peer_key);
        // An obsolete wire version cannot establish a session.
        let obsolete_offer = [PACKET_ID, b'T', b'P', b'Q', 1, 2];
        let ignored = local.handle_packet(friend, &obsolete_offer).unwrap();
        assert!(ignored.session_event.is_none() && ignored.outgoing.is_empty());
        for packet in remote.v2.capability() {
            local.handle_packet(friend, &packet).unwrap();
        }
        local.take_outbox();
        local.request(friend).unwrap();
        local.complete_identity(&[0x42; 32]).unwrap();
        local.connection_changed(friend, false).unwrap();
        assert_eq!(
            local.request(friend).unwrap_err(),
            "PQ_PEER_READINESS_NOT_CONFIRMED"
        );
        assert_eq!(local.status(friend).state, "accepting");
        assert!(local.holds_plaintext_messages(friend));
        assert!(local.take_outbox().is_empty());
        local.complete_identity(&[0x42; 32]).unwrap();
        drop(local);

        let restarted = PqEngine::new(&local_dir).unwrap();
        restarted
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        confirm_readiness(&restarted, friend, &peer_key);
        restarted.connection_changed(friend, true).unwrap();
        confirm_readiness(&restarted, friend, &peer_key);
        restarted.request(friend).unwrap();
        restarted.drive(friend, true, true).unwrap();
        let before_marker = restarted.take_outbox();
        assert!(!v2_record_kinds(&before_marker)
            .iter()
            .any(|kind| kind == "Offer"));
        assert_eq!(restarted.status(friend).protocol_version, 2);
        assert_eq!(restarted.status(friend).state, "accepting");
        assert!(restarted.status(friend).manual_waiting_for_capability);

        for packet in remote.v2.capability() {
            restarted.handle_packet(friend, &packet).unwrap();
        }
        restarted.drive(friend, true, true).unwrap();
        let resumed = restarted.take_outbox();
        assert!(v2_record_kinds(&resumed).iter().any(|kind| kind == "Offer"));
        assert!(restarted.owns_session(friend));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "pq-fault-tests")]
    fn fault_record(kind: &str) -> Vec<u8> {
        let bytes = serde_json::to_vec(&serde_json::json!({ "kind": kind })).unwrap();
        let digest = Sha256::digest(&bytes);
        let mut packet = vec![PACKET_ID, b'T', b'P', b'Q', 2, 1];
        packet.extend_from_slice(&digest[..16]);
        packet.extend_from_slice(&0u16.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        packet.extend_from_slice(&bytes);
        packet
    }

    #[cfg(feature = "pq-fault-tests")]
    #[test]
    fn fault_hook_purges_queued_v2_and_fences_take_and_requeue() {
        const NONCE: &str = "12345678-9abc-4def-8123-456789abcdef";
        let portable = test_root("fault-hook-facade");
        let fault_root = portable.join("pq-fault-test");
        let data_root = portable.join("data");
        std::fs::create_dir_all(&fault_root).unwrap();
        std::fs::create_dir_all(&data_root).unwrap();
        profiles::atomic_write(
            &fault_root.join("marker.json"),
            format!(r#"{{"schemaVersion":2,"nonce":"{NONCE}"}}"#).as_bytes(),
        )
        .unwrap();

        let mut engine = PqEngine::new(&data_root).unwrap();
        engine.fault =
            super::super::fault::FaultInjector::from_paths(&portable, &fault_root, NONCE).unwrap();

        engine
            .bind_contact(7, &"BB".repeat(32), &"AA".repeat(32), false)
            .unwrap();
        confirm_readiness(&engine, 7, &"BB".repeat(32));

        let queued_before_arm = fault_record("Data");
        engine.queue(7, [queued_before_arm.clone()]);
        profiles::atomic_write(
            &fault_root.join("arm.json"),
            format!(r#"{{"schemaVersion":2,"nonce":"{NONCE}","friendNumber":7,"stage":"accept"}}"#)
                .as_bytes(),
        )
        .unwrap();

        engine.queue(7, [fault_record("Accept")]);
        assert!(engine.take_outbox().is_empty());
        engine.requeue_front(VecDeque::from([(7, queued_before_arm)]));
        assert!(engine.take_outbox().is_empty());

        std::fs::remove_dir_all(portable).unwrap();
    }

    #[test]
    fn v2_transport_pressure_bounds_memory_and_admits_retry_after_drain() {
        let root = test_root("transport-pressure");
        let engine = PqEngine::new(&root).unwrap();
        engine
            .bind_contact(7, &"11".repeat(32), &"22".repeat(32), false)
            .unwrap();
        confirm_readiness(&engine, 7, &"11".repeat(32));
        let make_packet = |number: u64| {
            let mut packet = vec![0u8; 1230];
            packet[..6].copy_from_slice(&[PACKET_ID, b'T', b'P', b'Q', 2, 1]);
            packet[6..14].copy_from_slice(&number.to_be_bytes());
            packet
        };
        engine.queue(7, (0..MAX_TRANSPORT_PACKETS as u64 + 1).map(make_packet));
        let queued = engine.take_outbox();
        assert!(
            queued.iter().map(|(_, packet)| packet.len()).sum::<usize>() <= MAX_TRANSPORT_BYTES
        );
        assert!(queued.len() <= MAX_TRANSPORT_PACKETS);
        let retry = make_packet(MAX_TRANSPORT_PACKETS as u64);
        assert!(!queued.iter().any(|(_, packet)| *packet == retry));
        engine.queue(7, [retry.clone(), retry.clone()]);
        assert_eq!(engine.take_outbox(), VecDeque::from([(7, retry)]));
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_v2_transport_queue_admits_complete_capability_probe_and_ack_records() {
        let root = test_root("capability-discovery-priority");
        let local_dir = root.join("local");
        let remote_dir = root.join("remote");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_dir).unwrap();
        let friend = 7;
        let peer_key = "11".repeat(32);
        let owner_key = "22".repeat(32);
        let local = PqEngine::new(&local_dir).unwrap();
        let remote = PqEngine::new(&remote_dir).unwrap();
        local
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        confirm_readiness(&local, friend, &peer_key);
        remote
            .bind_contact(friend, &owner_key, &peer_key, false)
            .unwrap();
        confirm_readiness(&remote, friend, &owner_key);
        local.connection_changed(friend, true).unwrap();
        confirm_readiness(&local, friend, &peer_key);
        remote.connection_changed(friend, true).unwrap();
        confirm_readiness(&remote, friend, &owner_key);
        local.request(friend).unwrap();
        local.complete_identity(&[0x41; 32]).unwrap();
        local.withdraw(friend).unwrap();
        local.take_outbox();

        let make_packet = |number: u64| {
            let mut packet = vec![0u8; 31];
            packet[..6].copy_from_slice(&[PACKET_ID, b'T', b'P', b'Q', 2, 1]);
            packet[6..14].copy_from_slice(&number.to_be_bytes());
            packet[14..22].copy_from_slice(&(!number).to_be_bytes());
            packet[24..26].copy_from_slice(&1u16.to_be_bytes());
            packet[26..30].copy_from_slice(&1u32.to_be_bytes());
            packet[30] = b'X';
            packet
        };
        local.queue(
            friend,
            (0..MAX_TRANSPORT_PACKETS as u64).map(make_packet),
        );
        assert_eq!(local.outbox.lock().unwrap().len(), MAX_TRANSPORT_PACKETS);

        let local_capability = local.v2.capability();
        let local_probe = local.v2.capability_probe(friend);
        assert!(!local_capability.is_empty());
        assert!(!local_probe.is_empty());
        let remote_probe = remote.v2.capability_probe(friend);
        let mut ack = Vec::new();
        for packet in remote_probe {
            ack.extend(local.handle_packet(friend, &packet).unwrap().outgoing);
        }
        // The identity-bearing ACK spans more than one Tox lossless packet.
        assert!(ack.len() > 1);

        local.queue(friend, [local.capability_packet()]);
        local.queue(friend, ack.clone());
        let before_retry = local.outbox.lock().unwrap().clone();
        local.queue(friend, [local.capability_packet()]);
        local.queue(friend, ack.clone());
        assert_eq!(*local.outbox.lock().unwrap(), before_retry);
        let queued = local.take_outbox();
        assert_eq!(queued.len(), MAX_TRANSPORT_PACKETS);
        assert!(
            queued.iter().map(|(_, packet)| packet.len()).sum::<usize>() <= MAX_TRANSPORT_BYTES
        );
        for expected in local_capability.iter().chain(&local_probe).chain(&ack) {
            assert!(queued
                .iter()
                .any(|(owner, packet)| *owner == friend && packet == expected));
        }
        let discovery_ids = local_capability
            .iter()
            .chain(&local_probe)
            .chain(&ack)
            .filter_map(|packet| v2::capability_discovery_id(packet))
            .collect::<HashSet<_>>();
        assert_eq!(discovery_ids.len(), 3);
        assert!(local_capability
            .iter()
            .chain(&local_probe)
            .chain(&ack)
            .all(|packet| v2::packet_id(packet).is_some_and(|id| discovery_ids.contains(&id))));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn connection_transition_purges_v2_transport_until_a_fresh_capability() {
        let root = test_root("v2-connection-outbox-fence");
        let local_dir = root.join("local");
        let remote_dir = root.join("remote");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_dir).unwrap();
        let friend = 7;
        let peer_key = "11".repeat(32);
        let owner_key = "22".repeat(32);
        let local = PqEngine::new(&local_dir).unwrap();
        let remote = PqEngine::new(&remote_dir).unwrap();
        local
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        confirm_readiness(&local, friend, &peer_key);
        remote
            .bind_contact(friend, &owner_key, &peer_key, false)
            .unwrap();
        confirm_readiness(&remote, friend, &owner_key);
        local.connection_changed(friend, true).unwrap();
        confirm_readiness(&local, friend, &peer_key);
        for packet in remote.v2.capability() {
            local.handle_packet(friend, &packet).unwrap();
        }
        assert!(local.first_send(friend, true).unwrap());
        local.complete_identity(&[0x41; 32]).unwrap();
        local.drive(friend, true, true).unwrap();
        let queued = local.outbox.lock().unwrap().clone();
        assert!(v2_record_kinds(&queued).iter().any(|kind| kind == "Offer"));

        local.connection_changed(friend, false).unwrap();
        assert!(!local
            .outbox
            .lock()
            .unwrap()
            .iter()
            .any(|(_, packet)| v2::is_packet(packet)));
        for packet in remote.v2.capability() {
            local
                .handle_packet_observed(friend, &packet, false)
                .unwrap();
        }
        assert!(!local.status(friend).supported);
        assert!(local.take_outbox().is_empty());
        local.connection_changed(friend, true).unwrap();
        confirm_readiness(&local, friend, &peer_key);
        local.drive(friend, true, true).unwrap();
        let before_marker = local.take_outbox();
        let before_kinds = v2_record_kinds(&before_marker);
        assert!(before_kinds.iter().any(|kind| kind == "Capability"));
        assert!(!before_kinds.iter().any(|kind| kind == "Offer"));

        for packet in remote.v2.capability() {
            local.handle_packet(friend, &packet).unwrap();
        }
        local.drive(friend, true, true).unwrap();
        let after_marker = local.take_outbox();
        assert!(v2_record_kinds(&after_marker)
            .iter()
            .any(|kind| kind == "Offer"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queue_deduplicates_capability_expansion_exactly() {
        let root = test_root("queue-dedup");
        let engine = PqEngine::new(&root).unwrap();
        engine.queue(3, [engine.capability_packet(), engine.capability_packet()]);
        let unbound = engine.take_outbox();
        assert!(
            unbound.is_empty(),
            "unbound contacts cannot emit PQ discovery"
        );
        engine
            .bind_contact(3, &"11".repeat(32), &"22".repeat(32), false)
            .unwrap();
        confirm_readiness(&engine, 3, &"11".repeat(32));
        engine.connection_changed(3, true).unwrap();
        confirm_readiness(&engine, 3, &"11".repeat(32));
        engine.queue(3, [engine.capability_packet(), engine.capability_packet()]);
        let queued = engine.take_outbox().into_iter().collect::<Vec<_>>();
        let unique = queued.iter().cloned().collect::<HashSet<_>>();
        assert_eq!(queued.len(), unique.len());
        assert_eq!(queued.len(), 2);
        let kinds = v2_record_kinds(&queued.into_iter().collect());
        assert!(kinds.iter().any(|kind| kind == "Capability"));
        assert!(kinds.iter().any(|kind| kind == "CapabilityProbe"));
        std::fs::remove_dir_all(root).unwrap();
    }

}
