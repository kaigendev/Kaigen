use super::*;
use std::{collections::HashSet, sync::OnceLock};

const CAPABILITY_REQUEST: &[u8] = &[PACKET_ID, b'T', b'P', b'Q', 2, 0];
const MAX_V2_TRANSPORT_BYTES: usize = 8 * 1024 * 1024;
const MAX_V2_TRANSPORT_PACKETS: usize = 16_384;
const MAX_DEFERRED_LEGACY_NEGOTIATION_PACKETS: usize = 32;
const MAX_DEFERRED_LEGACY_NEGOTIATION_BYTES: usize = 256 * 1024;

#[derive(Clone)]
struct LegacyCapability {
    packet: Vec<u8>,
    public_key: Vec<u8>,
    fingerprint: String,
    changed: bool,
}

#[derive(Default)]
struct LegacyBridge {
    /// Numeric Tox slots are runtime routes only. Capability ownership follows
    /// the stable Tox public key so a slot remap cannot transfer PQ identity.
    routes: HashMap<u32, String>,
    capabilities: HashMap<String, LegacyCapability>,
    validated_capabilities: HashSet<String>,
    deferred_negotiation: HashMap<String, VecDeque<Vec<u8>>>,
    manual_requests: HashSet<String>,
}

/// Version dispatch keeps the old manual wire protocol compatible while v2
/// owns all new automatic sessions and durable per-message ratchets.
pub struct PqEngine {
    data_dir: PathBuf,
    legacy: OnceLock<LegacyEngine>,
    legacy_bridge: Mutex<LegacyBridge>,
    v2: v2::Engine,
    outbox: Mutex<VecDeque<(u32, Vec<u8>)>>,
    #[cfg(feature = "pq-fault-tests")]
    fault: super::fault::FaultInjector,
}

impl PqEngine {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let engine = Self {
            data_dir: data_dir.into(),
            legacy: OnceLock::new(),
            legacy_bridge: Mutex::new(LegacyBridge::default()),
            v2: v2::Engine::new(data_dir)?,
            outbox: Mutex::new(VecDeque::new()),
            #[cfg(feature = "pq-fault-tests")]
            fault: super::fault::FaultInjector::from_env()?,
        };
        if engine.v2.has_identity() {
            let _ = engine.legacy.set(LegacyEngine::new(data_dir)?);
        }
        Ok(engine)
    }

    pub fn bind_contact(
        &self,
        friend: u32,
        key: &str,
        owner: &str,
        existing: bool,
    ) -> Result<(), String> {
        self.v2.bind(friend, key, owner, existing)?;
        let stable_key = key.to_ascii_uppercase();
        self.legacy_bridge
            .lock()
            .map_err(|_| "PQ_LEGACY_BRIDGE_LOCKED")?
            .routes
            .insert(friend, stable_key);
        self.import_legacy_trust(friend)
    }

    pub fn contact_bound(&self, friend: u32, key: &str) -> bool {
        self.v2.bound(friend, key)
    }

    fn import_legacy_trust(&self, friend: u32) -> Result<(), String> {
        let Some(legacy) = self.legacy.get() else {
            return Ok(());
        };
        let trusted = legacy
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.trust.fingerprints.get(&friend).cloned());
        if let Some(trusted) = trusted {
            self.v2.import_trust(friend, trusted)?;
        }
        Ok(())
    }

    fn legacy_owns(&self, friend: u32) -> bool {
        let Some(legacy) = self.legacy.get() else {
            return false;
        };
        if legacy.holds_plaintext_messages(friend) {
            return true;
        }
        matches!(
            legacy.status(friend).state.as_str(),
            "offered"
                | "incoming_offer"
                | "accepting"
                | "active"
                | "closing"
                | "closing_commit"
                | "closing_ack"
                | "closing_final"
        )
    }

    fn stable_key(&self, friend: u32) -> Result<String, String> {
        self.legacy_bridge
            .lock()
            .map_err(|_| "PQ_LEGACY_BRIDGE_LOCKED")?
            .routes
            .get(&friend)
            .cloned()
            .ok_or_else(|| "PQ_CONTACT_NOT_BOUND".to_string())
    }

    fn cached_legacy_status(&self, friend: u32) -> Option<PqStatus> {
        let capability = {
            let bridge = self.legacy_bridge.lock().ok()?;
            bridge
                .routes
                .get(&friend)
                .filter(|key| bridge.validated_capabilities.contains(*key))
                .and_then(|key| bridge.capabilities.get(key))
                .cloned()?
        };
        let mut status = self.v2.status(friend);
        status.protocol_version = VERSION;
        status.supported = true;
        status.state = if status.identity_waiting {
            "accepting".to_string()
        } else {
            "available".to_string()
        };
        status.peer_fingerprint = Some(capability.fingerprint.clone());
        status.fingerprint_changed = capability.changed;
        if capability.changed {
            status.error = Some("PQ-ключ контакта изменился; проверьте отпечаток".to_string());
        }
        Some(status)
    }

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
        if self.legacy_owns(friend) {
            Ok(true)
        } else {
            self.v2
                .first_send(friend, local_online, peer_online, observed_revision)
        }
    }

    pub fn connection_changed(&self, friend: u32, online: bool) -> Result<(), String> {
        let result = self.v2.connection_changed(friend, online);
        if let Ok(mut bridge) = self.legacy_bridge.lock() {
            if let Some(key) = bridge.routes.get(&friend).cloned() {
                bridge.validated_capabilities.remove(&key);
                bridge.deferred_negotiation.remove(&key);
            }
        }
        // A v2 transport packet belongs to the capability-validation interval
        // in which it was queued. Durable DATA, handshake, ACK, and close state
        // remains in v2 and is regenerated by drive; legacy v1 is independent.
        if let Ok(mut outbox) = self.outbox.lock() {
            outbox.retain(|(owner, packet)| *owner != friend || !v2::is_packet(packet));
        }
        result
    }

    pub fn skip_auto(&self, friend: u32) -> Result<(), String> {
        self.v2.skip_auto(friend)?;
        self.clear_pending_legacy_request(friend);
        Ok(())
    }

    pub fn auto_skip_pending(&self, friend: u32) -> bool {
        self.v2.auto_skip_pending(friend)
    }

    pub fn finish_auto_skip(&self, friend: u32) -> Result<(), String> {
        self.v2.finish_auto_skip(friend)
    }

    pub fn is_v2(&self, friend: u32) -> bool {
        !self.legacy_owns(friend) && self.v2.owns(friend)
    }

    pub fn capability_packet(&self) -> Vec<u8> {
        CAPABILITY_REQUEST.to_vec()
    }

    /// V2 ciphertext is already durable and controls are replayable, so a full
    /// transient transport queue can apply backpressure without losing messages.
    /// Legacy v1 retains its existing queue semantics. Exact deduplication avoids
    /// accumulating a second copy on every retry while the Tox queue is blocked.
    pub fn queue(&self, friend: u32, packets: impl IntoIterator<Item = Vec<u8>>) {
        let mut expanded_packets = Vec::new();
        for bytes in packets {
            let expanded = if bytes == CAPABILITY_REQUEST {
                let mut packets = self.v2.capability();
                if let Some(legacy) = self.legacy.get() {
                    packets.push(legacy.capability_packet());
                }
                packets
            } else {
                vec![bytes]
            };
            expanded_packets.extend(expanded);
        }
        #[cfg(feature = "pq-fault-tests")]
        let filtered = self.fault.filter(friend, expanded_packets);
        #[cfg(feature = "pq-fault-tests")]
        let expanded_packets = filtered.packets;
        let Ok(mut outbox) = self.outbox.lock() else {
            return;
        };
        #[cfg(feature = "pq-fault-tests")]
        if filtered.blocked {
            outbox.retain(|(owner, packet)| *owner != friend || !v2::is_packet(packet));
        }
        let mut known = outbox.iter().cloned().collect::<HashSet<_>>();
        let mut queued_bytes: usize = outbox.iter().map(|(_, bytes)| bytes.len()).sum();
        for packet in expanded_packets {
            if v2::is_packet(&packet)
                && (queued_bytes.saturating_add(packet.len()) > MAX_V2_TRANSPORT_BYTES
                    || outbox.len() >= MAX_V2_TRANSPORT_PACKETS)
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
        #[cfg(feature = "pq-fault-tests")]
        let blocked = self.fault.blocked_friend();
        let mut output = self
            .outbox
            .lock()
            .map(|mut outbox| std::mem::take(&mut *outbox))
            .unwrap_or_default();
        #[cfg(feature = "pq-fault-tests")]
        if let Some(friend) = blocked {
            output.retain(|(owner, packet)| *owner != friend || !v2::is_packet(packet));
        }
        if let Some(legacy) = self.legacy.get() {
            output.extend(legacy.take_outbox());
        }
        let mut sendable = VecDeque::new();
        let mut deferred = VecDeque::new();
        for (friend, packet) in output {
            if is_legacy_negotiation_packet(&packet) && !self.legacy_capability_validated(friend) {
                deferred.push_back((friend, packet));
            } else {
                sendable.push_back((friend, packet));
            }
        }
        if !deferred.is_empty() {
            if let Ok(mut outbox) = self.outbox.lock() {
                deferred.append(&mut outbox);
                *outbox = deferred;
            }
        }
        sendable
    }

    pub fn requeue_front(&self, mut packets: VecDeque<(u32, Vec<u8>)>) {
        #[cfg(feature = "pq-fault-tests")]
        if let Some(friend) = self.fault.blocked_friend() {
            packets.retain(|(owner, packet)| *owner != friend || !v2::is_packet(packet));
        }
        if let Ok(mut outbox) = self.outbox.lock() {
            packets.append(&mut outbox);
            *outbox = packets;
        }
    }

    pub fn reconcile_friend_numbers(
        &self,
        resolved: &HashMap<u32, u32>,
        previous: &HashMap<u32, String>,
    ) {
        self.v2.remap(resolved);
        if let Some(legacy) = self.legacy.get() {
            legacy.reconcile_friend_numbers(resolved, previous);
        }
        if let Ok(mut bridge) = self.legacy_bridge.lock() {
            bridge.routes = std::mem::take(&mut bridge.routes)
                .into_iter()
                .filter_map(|(old, key)| resolved.get(&old).map(|new| (*new, key)))
                .collect();
            let bound = bridge.routes.values().cloned().collect::<HashSet<_>>();
            bridge.capabilities.retain(|key, _| bound.contains(key));
            bridge
                .validated_capabilities
                .retain(|key| bound.contains(key));
            bridge
                .deferred_negotiation
                .retain(|key, _| bound.contains(key));
            bridge.manual_requests.retain(|key| bound.contains(key));
        }
        if let Ok(mut outbox) = self.outbox.lock() {
            *outbox = std::mem::take(&mut *outbox)
                .into_iter()
                .filter_map(|(old, packet)| resolved.get(&old).map(|new| (*new, packet)))
                .collect();
        }
    }

    pub fn remove_friend(&self, friend: u32, key: Option<&str>) -> Result<(), String> {
        self.v2.detach(friend)?;
        if let Ok(mut bridge) = self.legacy_bridge.lock() {
            let stable = bridge
                .routes
                .remove(&friend)
                .or_else(|| key.map(str::to_ascii_uppercase));
            if let Some(stable) = stable {
                if !bridge.routes.values().any(|value| value == &stable) {
                    bridge.capabilities.remove(&stable);
                    bridge.validated_capabilities.remove(&stable);
                    bridge.deferred_negotiation.remove(&stable);
                    bridge.manual_requests.remove(&stable);
                }
            }
        }
        self.v2.unbind(friend);
        if let Some(legacy) = self.legacy.get() {
            legacy.remove_friend(friend, key);
        }
        if let Ok(mut outbox) = self.outbox.lock() {
            outbox.retain(|(owner, _)| *owner != friend);
        }
        Ok(())
    }

    pub fn status(&self, friend: u32) -> PqStatus {
        if self.legacy_owns(friend) {
            return self.legacy.get().expect("legacy present").status(friend);
        }
        if self.v2.legacy_request_pending(friend) {
            if let Some(status) = self.cached_legacy_status(friend) {
                return status;
            }
        }
        // v2 pending/active state takes precedence over a passive v1
        // capability, including the first-message capability wait.
        if self.v2.owns(friend) {
            return self.v2.status(friend);
        }
        if let Some(legacy) = self.legacy.get() {
            let status = legacy.status(friend);
            if self.legacy_capability_validated(friend) && status.supported {
                return status;
            }
        }
        self.cached_legacy_status(friend)
            .unwrap_or_else(|| self.v2.status(friend))
    }

    pub fn complete_identity(&self, noise: &[u8]) -> Result<(), String> {
        self.v2.complete_identity(noise)?;
        self.initialize_legacy_after_identity()
    }

    fn initialize_legacy_after_identity(&self) -> Result<(), String> {
        if !self.v2.has_identity() || self.legacy.get().is_some() {
            return Ok(());
        }
        let created = LegacyEngine::new(&self.data_dir)?;
        if self.legacy.set(created).is_err() {
            // A concurrent caller installed the same identity-backed engine.
            return Ok(());
        }
        let legacy = self.legacy.get().ok_or("PQ_LEGACY_IDENTITY_NOT_CREATED")?;
        let cached = {
            let bridge = self
                .legacy_bridge
                .lock()
                .map_err(|_| "PQ_LEGACY_BRIDGE_LOCKED")?;
            bridge
                .routes
                .iter()
                .filter_map(|(friend, key)| {
                    bridge.validated_capabilities.contains(key).then(|| {
                        bridge
                            .capabilities
                            .get(key)
                            .map(|capability| (*friend, capability.packet.clone()))
                    })?
                })
                .collect::<Vec<_>>()
        };
        for (friend, packet) in cached {
            let result = legacy.handle_packet(friend, &packet)?;
            self.queue(friend, result.outgoing);
            self.import_legacy_trust(friend)?;
            let request = self.start_pending_legacy_request(friend)?;
            self.queue(friend, request);
        }
        Ok(())
    }

    fn start_pending_legacy_request(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        if self.v2.supported(friend) {
            if let Ok(key) = self.stable_key(friend) {
                if let Ok(mut bridge) = self.legacy_bridge.lock() {
                    bridge.manual_requests.remove(&key);
                }
            }
            return Ok(Vec::new());
        }
        let runtime_pending = self
            .legacy_bridge
            .lock()
            .ok()
            .and_then(|bridge| {
                bridge
                    .routes
                    .get(&friend)
                    .map(|key| bridge.manual_requests.contains(key))
            })
            .unwrap_or(false);
        if !runtime_pending && !self.v2.legacy_request_pending(friend) {
            return Ok(Vec::new());
        }
        if !self.legacy_capability_validated(friend) {
            return Ok(Vec::new());
        }
        let legacy = self.legacy.get().ok_or("PQ_LEGACY_IDENTITY_NOT_CREATED")?;
        let status = legacy.status(friend);
        if !status.supported || !matches!(status.state.as_str(), "available" | "error") {
            return Ok(Vec::new());
        }
        let packets = legacy.request(friend)?;
        self.import_legacy_trust(friend)?;
        self.v2.finish_legacy_request(friend)?;
        if let Ok(key) = self.stable_key(friend) {
            if let Ok(mut bridge) = self.legacy_bridge.lock() {
                bridge.manual_requests.remove(&key);
            }
        }
        Ok(packets)
    }

    fn clear_pending_legacy_request(&self, friend: u32) {
        let Ok(key) = self.stable_key(friend) else {
            return;
        };
        if let Ok(mut bridge) = self.legacy_bridge.lock() {
            bridge.manual_requests.remove(&key);
        }
    }

    pub fn queues_encrypted_messages(&self, friend: u32) -> bool {
        if self.is_v2(friend) {
            self.v2.encrypts(friend)
        } else {
            self.legacy
                .get()
                .is_some_and(|legacy| legacy.queues_encrypted_messages(friend))
        }
    }

    pub fn holds_plaintext_messages(&self, friend: u32) -> bool {
        self.v2.holds_plaintext(friend) || self.legacy_owns(friend)
    }

    pub fn shutdown_friends(&self) -> Vec<u32> {
        self.legacy
            .get()
            .map(LegacyEngine::shutdown_friends)
            .unwrap_or_default()
    }

    pub fn drive_shutdown(&self, friend: u32, drained: bool) -> (Vec<Vec<u8>>, bool) {
        self.legacy
            .get()
            .map(|legacy| legacy.drive_shutdown(friend, drained))
            .unwrap_or_default()
    }

    pub fn drive(&self, friend: u32, online: bool, external_drained: bool) -> Result<(), String> {
        if self.legacy_owns(friend) {
            return Ok(());
        }
        let packets = self.v2.drive(friend, online, external_drained);
        // v2 may create the identity itself after its bounded OS-only entropy
        // fallback. Initialize legacy compatibility on that path as well.
        self.initialize_legacy_after_identity()?;
        let packets = packets?;
        self.queue(friend, packets);
        Ok(())
    }

    pub fn request(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        if self.legacy_owns(friend) {
            return self.legacy.get().ok_or("PQ_UNAVAILABLE")?.request(friend);
        }
        if self.v2.supported(friend) {
            return self.v2.request(friend);
        }

        let legacy_supported = self.legacy_capability_validated(friend)
            && self
                .legacy
                .get()
                .is_some_and(|legacy| legacy.status(friend).supported);
        let cached_supported = self.cached_legacy_status(friend).is_some();
        if !legacy_supported && !cached_supported {
            return self.v2.request(friend);
        }

        self.v2.request_identity_only(friend)?;
        let key = self.stable_key(friend)?;
        self.legacy_bridge
            .lock()
            .map_err(|_| "PQ_LEGACY_BRIDGE_LOCKED")?
            .manual_requests
            .insert(key);
        if self.legacy.get().is_none() {
            return Ok(Vec::new());
        }
        self.start_pending_legacy_request(friend)
    }

    pub fn accept(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        if self.is_v2(friend) {
            self.v2.accept(friend)
        } else {
            self.legacy.get().ok_or("PQ_UNAVAILABLE")?.accept(friend)
        }
    }

    pub fn withdraw(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        if self.is_v2(friend) {
            let packets = self.v2.cancel(friend)?;
            self.clear_pending_legacy_request(friend);
            Ok(packets)
        } else {
            self.legacy.get().ok_or("PQ_UNAVAILABLE")?.withdraw(friend)
        }
    }

    pub fn reject(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        if self.is_v2(friend) {
            let packets = self.v2.cancel(friend)?;
            self.clear_pending_legacy_request(friend);
            Ok(packets)
        } else {
            self.legacy.get().ok_or("PQ_UNAVAILABLE")?.reject(friend)
        }
    }

    pub fn request_shutdown(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        if self.is_v2(friend) {
            self.v2.shutdown(friend)
        } else {
            self.v2.latch_manual_only(friend)?;
            self.legacy
                .get()
                .ok_or("PQ_UNAVAILABLE")?
                .request_shutdown(friend)
        }
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
        if self.is_v2(friend) {
            self.v2.encrypt(friend, operation, text)
        } else {
            self.legacy
                .get()
                .ok_or("PQ_UNAVAILABLE")?
                .encrypt(friend, text)
        }
    }

    pub fn handle_packet(&self, friend: u32, bytes: &[u8]) -> Result<PacketResult, String> {
        self.handle_packet_observed(friend, bytes, true)
    }

    pub fn handle_packet_observed(
        &self,
        friend: u32,
        bytes: &[u8],
        local_online: bool,
    ) -> Result<PacketResult, String> {
        if v2::is_packet(bytes) {
            if !local_online {
                // Every v2 record is journaled by its sender and retried. Drop
                // packets delivered by an iteration that crossed a local
                // suspend boundary so neither a capability nor a fragment can
                // validate or mutate the next connection interval.
                return Ok(empty_packet_result());
            }
            return self.v2.handle(friend, bytes);
        }
        let capability = parse_legacy_capability(bytes)?;
        if !local_online && (capability.is_some() || is_legacy_negotiation_packet(bytes)) {
            return Ok(empty_packet_result());
        }
        if capability.is_none()
            && is_legacy_negotiation_packet(bytes)
            && !self.legacy_capability_validated(friend)
        {
            self.defer_legacy_negotiation(friend, bytes)?;
            return Ok(empty_packet_result());
        }
        if let Some(legacy) = self.legacy.get() {
            let mut result = legacy.handle_packet(friend, bytes)?;
            self.latch_legacy_session_event(friend, &result)?;
            if let Some(capability) = capability {
                let changed = self.remember_legacy_capability(friend, capability)?;
                if !changed {
                    for deferred in self.take_deferred_legacy_negotiation(friend)? {
                        let replayed = legacy.handle_packet(friend, &deferred)?;
                        self.latch_legacy_session_event(friend, &replayed)?;
                        merge_legacy_negotiation_result(&mut result, replayed)?;
                    }
                }
                result
                    .outgoing
                    .extend(self.start_pending_legacy_request(friend)?);
            }
            return Ok(result);
        }
        let Some(capability) = capability else {
            return Err("PQ_LEGACY_IDENTITY_NOT_CREATED".to_string());
        };
        self.remember_legacy_capability(friend, capability)?;
        Ok(empty_packet_result())
    }

    fn latch_legacy_session_event(&self, friend: u32, result: &PacketResult) -> Result<(), String> {
        if matches!(
            result.session_event,
            Some(PqSessionEvent::Active)
                | Some(PqSessionEvent::CloseRequested)
                | Some(PqSessionEvent::Closed)
        ) {
            self.v2.latch_manual_only(friend)?;
        }
        Ok(())
    }

    fn defer_legacy_negotiation(&self, friend: u32, bytes: &[u8]) -> Result<(), String> {
        let mut bridge = self
            .legacy_bridge
            .lock()
            .map_err(|_| "PQ_LEGACY_BRIDGE_LOCKED")?;
        let key = bridge
            .routes
            .get(&friend)
            .cloned()
            .ok_or("PQ_CONTACT_NOT_BOUND")?;
        let deferred = bridge.deferred_negotiation.entry(key).or_default();
        if deferred.iter().any(|packet| packet == bytes) {
            return Ok(());
        }
        let bytes_after = deferred
            .iter()
            .try_fold(bytes.len(), |total, packet| total.checked_add(packet.len()))
            .ok_or("PQ_LEGACY_NEGOTIATION_BACKPRESSURE")?;
        if deferred.len() >= MAX_DEFERRED_LEGACY_NEGOTIATION_PACKETS
            || bytes_after > MAX_DEFERRED_LEGACY_NEGOTIATION_BYTES
        {
            return Err("PQ_LEGACY_NEGOTIATION_BACKPRESSURE".to_string());
        }
        deferred.push_back(bytes.to_vec());
        Ok(())
    }

    fn take_deferred_legacy_negotiation(&self, friend: u32) -> Result<VecDeque<Vec<u8>>, String> {
        let mut bridge = self
            .legacy_bridge
            .lock()
            .map_err(|_| "PQ_LEGACY_BRIDGE_LOCKED")?;
        let key = bridge
            .routes
            .get(&friend)
            .cloned()
            .ok_or("PQ_CONTACT_NOT_BOUND")?;
        Ok(bridge.deferred_negotiation.remove(&key).unwrap_or_default())
    }

    fn legacy_capability_validated(&self, friend: u32) -> bool {
        self.legacy_bridge.lock().is_ok_and(|bridge| {
            bridge
                .routes
                .get(&friend)
                .is_some_and(|key| bridge.validated_capabilities.contains(key))
        })
    }

    fn remember_legacy_capability(
        &self,
        friend: u32,
        capability: LegacyCapability,
    ) -> Result<bool, String> {
        let mut bridge = self
            .legacy_bridge
            .lock()
            .map_err(|_| "PQ_LEGACY_BRIDGE_LOCKED")?;
        let key = bridge
            .routes
            .get(&friend)
            .cloned()
            .ok_or("PQ_CONTACT_NOT_BOUND")?;
        let previous = bridge.capabilities.get(&key);
        let changed = previous.is_some_and(|old| old.public_key != capability.public_key)
            || previous.is_some_and(|old| old.changed);
        bridge.capabilities.insert(
            key.clone(),
            LegacyCapability {
                changed,
                ..capability
            },
        );
        bridge.validated_capabilities.insert(key.clone());
        if changed {
            bridge.deferred_negotiation.remove(&key);
        }
        drop(bridge);
        if changed {
            self.purge_legacy_negotiation(friend);
        }
        self.v2.legacy_capability_validated(friend);
        Ok(changed)
    }

    fn purge_legacy_negotiation(&self, friend: u32) {
        if let Ok(mut outbox) = self.outbox.lock() {
            outbox.retain(|(owner, packet)| {
                *owner != friend || !is_legacy_negotiation_packet(packet)
            });
        }
        let Some(legacy) = self.legacy.get() else {
            return;
        };
        let mut retained = legacy.take_outbox();
        retained
            .retain(|(owner, packet)| *owner != friend || !is_legacy_negotiation_packet(packet));
        legacy.requeue_front(retained);
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
}

fn parse_legacy_capability(bytes: &[u8]) -> Result<Option<LegacyCapability>, String> {
    if bytes.len() < HEADER_SIZE
        || bytes[0] != PACKET_ID
        || &bytes[1..4] != MAGIC
        || bytes[4] != VERSION
        || !matches!(bytes[5], KIND_CAPABILITY | KIND_CAPABILITY_ACK)
    {
        return Ok(None);
    }
    let payload = &bytes[HEADER_SIZE..];
    if payload.len() != KAIGEN_CAPABILITY_TAG.len() + MLKEM_PUBLIC_KEY_BYTES
        || !payload.starts_with(KAIGEN_CAPABILITY_TAG)
    {
        return Err("Некорректный идентификатор возможности Kaigen PQ".to_string());
    }
    let public_key = payload[KAIGEN_CAPABILITY_TAG.len()..].to_vec();
    let mut packet = bytes.to_vec();
    // Replaying either capability kind as a request makes the freshly created
    // local identity visible before a queued offer. This also repairs a delayed
    // ACK that referred to an identity file which no longer exists.
    packet[5] = KIND_CAPABILITY;
    Ok(Some(LegacyCapability {
        fingerprint: fingerprint(&public_key),
        public_key,
        packet,
        changed: false,
    }))
}

fn is_legacy_negotiation_packet(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER_SIZE
        && bytes[0] == PACKET_ID
        && &bytes[1..4] == MAGIC
        && bytes[4] == VERSION
        && matches!(
            bytes[5],
            KIND_OFFER | KIND_ACCEPT | KIND_CONFIRM | KIND_REJECT | KIND_WITHDRAW
        )
}

fn merge_legacy_negotiation_result(
    target: &mut PacketResult,
    mut replayed: PacketResult,
) -> Result<(), String> {
    if replayed.received_wire_id.is_some()
        || replayed.received_text.is_some()
        || replayed.acknowledged_wire_id.is_some()
    {
        return Err("PQ_LEGACY_NEGOTIATION_RESULT_INVALID".to_string());
    }
    target.outgoing.append(&mut replayed.outgoing);
    if replayed.session_event.is_some() {
        target.session_event = replayed.session_event;
    }
    Ok(())
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

    fn test_root(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kaigen-pq-engine-{label}-{suffix}"));
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

    fn has_legacy_kind(packets: &VecDeque<(u32, Vec<u8>)>, kind: u8) -> bool {
        packets.iter().any(|(_, packet)| {
            packet.len() >= HEADER_SIZE
                && packet[0] == PACKET_ID
                && &packet[1..4] == MAGIC
                && packet[4] == VERSION
                && packet[5] == kind
        })
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
            format!(r#"{{"schemaVersion":1,"nonce":"{NONCE}"}}"#).as_bytes(),
        )
        .unwrap();

        let mut engine = PqEngine::new(&data_root).unwrap();
        engine.fault =
            super::super::fault::FaultInjector::from_paths(&portable, &fault_root, NONCE).unwrap();

        let queued_before_arm = fault_record("Data");
        engine.queue(7, [queued_before_arm.clone()]);
        profiles::atomic_write(
            &fault_root.join("arm.json"),
            format!(r#"{{"schemaVersion":1,"nonce":"{NONCE}","friendNumber":7,"stage":"accept"}}"#)
                .as_bytes(),
        )
        .unwrap();

        let legacy = vec![PACKET_ID, b'T', b'P', b'Q', 1, 1];
        engine.queue(7, [fault_record("Accept"), legacy.clone()]);
        assert_eq!(engine.take_outbox(), VecDeque::from([(7, legacy.clone())]));

        engine.requeue_front(VecDeque::from([
            (7, queued_before_arm),
            (7, legacy.clone()),
        ]));
        assert_eq!(engine.take_outbox(), VecDeque::from([(7, legacy)]));

        std::fs::remove_dir_all(portable).unwrap();
    }

    #[test]
    fn v2_transport_pressure_bounds_memory_and_admits_retry_after_drain() {
        let root = test_root("transport-pressure");
        let engine = PqEngine::new(&root).unwrap();
        let make_packet = |number: u64| {
            let mut packet = vec![0u8; 1230];
            packet[..6].copy_from_slice(&[PACKET_ID, b'T', b'P', b'Q', 2, 1]);
            packet[6..14].copy_from_slice(&number.to_be_bytes());
            packet
        };
        engine.queue(7, (0..MAX_V2_TRANSPORT_PACKETS as u64 + 1).map(make_packet));
        let queued = engine.take_outbox();
        assert!(
            queued.iter().map(|(_, packet)| packet.len()).sum::<usize>() <= MAX_V2_TRANSPORT_BYTES
        );
        assert!(queued.len() <= MAX_V2_TRANSPORT_PACKETS);
        let retry = make_packet(MAX_V2_TRANSPORT_PACKETS as u64);
        assert!(!queued.iter().any(|(_, packet)| *packet == retry));
        engine.queue(7, [retry.clone(), retry.clone()]);
        assert_eq!(engine.take_outbox(), VecDeque::from([(7, retry)]));
        drop(engine);
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
        remote
            .bind_contact(friend, &owner_key, &peer_key, false)
            .unwrap();
        local.connection_changed(friend, true).unwrap();
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
    fn legacy_negotiation_waits_for_same_connection_capability_and_key() {
        let root = test_root("legacy-connection-control-fence");
        let local_dir = root.join("local");
        let remote_dir = root.join("remote");
        let changed_dir = root.join("changed");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_dir).unwrap();
        std::fs::create_dir_all(&changed_dir).unwrap();
        let friend = 9;
        let peer_key = "33".repeat(32);
        let owner_key = "44".repeat(32);
        let local = PqEngine::new(&local_dir).unwrap();
        local
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        local.v2.request_identity_only(friend).unwrap();
        local.complete_identity(&[0x42; 32]).unwrap();
        local.v2.finish_legacy_request(friend).unwrap();
        let local_legacy = local.legacy.get().unwrap();
        let remote = LegacyEngine::new(&remote_dir).unwrap();
        remote
            .handle_packet(friend, &local_legacy.capability_packet())
            .unwrap();
        local
            .handle_packet(friend, &remote.capability_packet())
            .unwrap();
        local.connection_changed(friend, false).unwrap();
        local.connection_changed(friend, true).unwrap();

        let offer = remote.request(friend).unwrap();
        assert_eq!(offer.len(), 1);
        let before_marker = local.handle_packet(friend, &offer[0]).unwrap();
        assert!(before_marker.outgoing.is_empty());
        assert!(before_marker.session_event.is_none());
        assert_ne!(local_legacy.status(friend).state, "incoming_offer");
        let replayed = local
            .handle_packet(friend, &remote.capability_packet())
            .unwrap();
        assert_eq!(replayed.session_event, Some(PqSessionEvent::OfferReceived));
        assert_eq!(local_legacy.status(friend).state, "incoming_offer");
        local.reject(friend).unwrap();

        // Outbound negotiation is retained while capability traffic passes.
        let outbound_dir = root.join("outbound");
        std::fs::create_dir_all(&outbound_dir).unwrap();
        let outbound = PqEngine::new(&outbound_dir).unwrap();
        outbound
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        outbound
            .handle_packet(friend, &remote.capability_packet())
            .unwrap();
        assert!(outbound.request(friend).unwrap().is_empty());
        outbound.complete_identity(&[0x43; 32]).unwrap();
        assert!(outbound
            .outbox
            .lock()
            .unwrap()
            .iter()
            .any(|(_, packet)| is_legacy_negotiation_packet(packet)));
        outbound.connection_changed(friend, false).unwrap();
        outbound.connection_changed(friend, true).unwrap();
        outbound.queue(friend, [outbound.capability_packet()]);
        let capability_only = outbound.take_outbox();
        assert!(has_legacy_kind(&capability_only, KIND_CAPABILITY));
        assert!(!has_legacy_kind(&capability_only, KIND_OFFER));
        assert!(outbound
            .outbox
            .lock()
            .unwrap()
            .iter()
            .any(|(_, packet)| is_legacy_negotiation_packet(packet)));
        outbound
            .handle_packet(friend, &remote.capability_packet())
            .unwrap();
        assert!(has_legacy_kind(&outbound.take_outbox(), KIND_OFFER));

        // A different current identity invalidates both directions of the
        // fenced transaction instead of replaying it against a new key.
        let changed_remote = LegacyEngine::new(&changed_dir).unwrap();
        local.connection_changed(friend, false).unwrap();
        local.connection_changed(friend, true).unwrap();
        local.handle_packet(friend, &offer[0]).unwrap();
        let changed = local
            .handle_packet(friend, &changed_remote.capability_packet())
            .unwrap();
        assert!(changed.session_event.is_none());
        assert_ne!(local_legacy.status(friend).state, "incoming_offer");
        assert!(!local
            .take_outbox()
            .iter()
            .any(|(_, packet)| is_legacy_negotiation_packet(packet)));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manual_v1_capability_waits_for_entropy_then_replays_without_v2_shadowing() {
        let root = test_root("legacy-before-identity");
        let local_dir = root.join("local");
        let remote_dir = root.join("remote");
        let bare_v2_dir = root.join("bare-v2");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_dir).unwrap();
        std::fs::create_dir_all(&bare_v2_dir).unwrap();

        let friend = 7;
        let peer_key = "11".repeat(32);
        let owner_key = "22".repeat(32);
        let local = PqEngine::new(&local_dir).unwrap();
        local
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        let remote = LegacyEngine::new(&remote_dir).unwrap();

        let cached = local
            .handle_packet(friend, &remote.capability_packet())
            .unwrap();
        assert!(cached.outgoing.is_empty());
        assert!(!local_dir.join("pq-identity.json").exists());
        let available = local.status(friend);
        assert!(available.supported);
        assert_eq!(available.protocol_version, 1);
        assert_eq!(available.state, "available");

        assert!(local.request(friend).unwrap().is_empty());
        let waiting = local.status(friend);
        assert!(waiting.identity_needs_entropy);
        assert!(waiting.identity_waiting);
        assert!(waiting.supported);
        assert_eq!(waiting.protocol_version, 1);

        local.complete_identity(&[0x42; 32]).unwrap();
        let negotiation = local.take_outbox().into_iter().collect::<Vec<_>>();
        assert_eq!(negotiation.len(), 2);
        assert!(negotiation
            .iter()
            .any(|(_, packet)| packet[4] == VERSION && packet[5] == KIND_CAPABILITY_ACK));
        assert!(negotiation
            .iter()
            .any(|(_, packet)| packet[4] == VERSION && packet[5] == KIND_OFFER));
        assert_eq!(local.status(friend).state, "offered");
        assert_eq!(local.status(friend).protocol_version, 1);

        // A v2 capability without identity can arrive after a v1 offer. It may
        // update future compatibility, but cannot steal dispatch mid-session.
        let bare_v2 = PqEngine::new(&bare_v2_dir).unwrap();
        for packet in bare_v2.v2.capability() {
            local.handle_packet(friend, &packet).unwrap();
        }
        assert!(!local.is_v2(friend));
        assert_eq!(local.status(friend).state, "offered");
        assert_eq!(local.status(friend).protocol_version, 1);

        let mut offer_received = false;
        for (_, packet) in negotiation {
            let result = remote.handle_packet(friend, &packet).unwrap();
            offer_received |= result.session_event == Some(PqSessionEvent::OfferReceived);
        }
        assert!(offer_received);
        let mut confirms = Vec::new();
        for packet in remote.accept(friend).unwrap() {
            let result = local.handle_packet(friend, &packet).unwrap();
            assert_eq!(result.session_event, Some(PqSessionEvent::Active));
            confirms.extend(result.outgoing);
        }
        for packet in confirms {
            remote.handle_packet(friend, &packet).unwrap();
        }
        assert!(local.queues_encrypted_messages(friend));

        drop(local);
        let restarted = PqEngine::new(&local_dir).unwrap();
        restarted
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        assert!(!restarted.first_send(friend, true).unwrap());
        assert!(!restarted.status(friend).auto_pending);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queue_deduplicates_capability_expansion_exactly() {
        let root = test_root("queue-dedup");
        let engine = PqEngine::new(&root).unwrap();
        engine.queue(3, [engine.capability_packet(), engine.capability_packet()]);
        let queued = engine.take_outbox().into_iter().collect::<Vec<_>>();
        let unique = queued.iter().cloned().collect::<HashSet<_>>();
        assert_eq!(queued.len(), unique.len());
        assert_eq!(queued.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validated_v1_stays_manual_and_is_hidden_after_a_connection_change() {
        let root = test_root("legacy-auto-boundary");
        let local_dir = root.join("local");
        let remote_dir = root.join("remote");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_dir).unwrap();
        let friend = 9;
        let peer_key = "33".repeat(32);
        let owner_key = "44".repeat(32);

        let local = PqEngine::new(&local_dir).unwrap();
        local
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        let remote = LegacyEngine::new(&remote_dir).unwrap();
        local
            .handle_packet(friend, &remote.capability_packet())
            .unwrap();

        assert!(!local.first_send(friend, true).unwrap());
        let available = local.status(friend);
        assert_eq!(available.protocol_version, 1);
        assert!(available.supported);
        assert!(!available.auto_pending);
        assert!(available.identity_needs_entropy);
        assert!(!available.identity_waiting);
        assert!(!local_dir.join("pq-identity.json").exists());
        assert!(local.take_outbox().is_empty());

        local.connection_changed(friend, false).unwrap();
        local.connection_changed(friend, true).unwrap();
        let unconfirmed = local.status(friend);
        assert_eq!(unconfirmed.protocol_version, 2);
        assert!(!unconfirmed.supported);
        assert!(!unconfirmed.auto_pending);
        assert_eq!(
            local.request(friend).unwrap_err(),
            "PQ_V2_CAPABILITY_REQUIRED"
        );

        drop(local);
        let restarted = PqEngine::new(&local_dir).unwrap();
        restarted
            .bind_contact(friend, &peer_key, &owner_key, false)
            .unwrap();
        assert!(!restarted.first_send(friend, true).unwrap());
        assert!(!restarted.status(friend).auto_pending);
        assert!(!local_dir.join("pq-identity.json").exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancel_before_entropy_clears_the_runtime_legacy_request() {
        let root = test_root("cancel-before-entropy");
        let local_dir = root.join("local");
        let remote_one_dir = root.join("remote-one");
        let remote_two_dir = root.join("remote-two");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_one_dir).unwrap();
        std::fs::create_dir_all(&remote_two_dir).unwrap();
        let local = PqEngine::new(&local_dir).unwrap();
        let owner_key = "55".repeat(32);
        local
            .bind_contact(1, &"66".repeat(32), &owner_key, false)
            .unwrap();
        local
            .bind_contact(2, &"77".repeat(32), &owner_key, false)
            .unwrap();
        let remote_one = LegacyEngine::new(&remote_one_dir).unwrap();
        let remote_two = LegacyEngine::new(&remote_two_dir).unwrap();
        local
            .handle_packet(1, &remote_one.capability_packet())
            .unwrap();
        local
            .handle_packet(2, &remote_two.capability_packet())
            .unwrap();

        assert!(local.request(1).unwrap().is_empty());
        assert!(local.withdraw(1).unwrap().is_empty());
        assert!(local.request(2).unwrap().is_empty());
        local.complete_identity(&[0x24; 32]).unwrap();

        let queued = local.take_outbox().into_iter().collect::<Vec<_>>();
        assert!(!queued
            .iter()
            .any(|(friend, packet)| *friend == 1 && packet[5] == KIND_OFFER));
        assert!(queued
            .iter()
            .any(|(friend, packet)| *friend == 2 && packet[5] == KIND_OFFER));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn os_only_identity_timeout_initializes_legacy_and_resumes_manual_request() {
        let root = test_root("legacy-os-fallback");
        let local_dir = root.join("local");
        let remote_dir = root.join("remote");
        std::fs::create_dir_all(&local_dir).unwrap();
        std::fs::create_dir_all(&remote_dir).unwrap();
        let friend = 5;
        let local = PqEngine::new(&local_dir).unwrap();
        local
            .bind_contact(friend, &"88".repeat(32), &"99".repeat(32), false)
            .unwrap();
        let remote = LegacyEngine::new(&remote_dir).unwrap();
        local
            .handle_packet(friend, &remote.capability_packet())
            .unwrap();
        assert!(local.request(friend).unwrap().is_empty());

        local.drive(friend, true, true).unwrap();
        assert!(local.legacy.get().is_none());
        assert!(!local_dir.join("pq-identity.json").exists());
        std::thread::sleep(std::time::Duration::from_millis(5_100));
        local.drive(friend, true, true).unwrap();

        assert!(local.legacy.get().is_some());
        assert!(local_dir.join("pq-identity.json").exists());
        assert!(local
            .take_outbox()
            .iter()
            .any(|(owner, packet)| *owner == friend
                && packet[4] == VERSION
                && packet[5] == KIND_OFFER));

        std::fs::remove_dir_all(root).unwrap();
    }
}
