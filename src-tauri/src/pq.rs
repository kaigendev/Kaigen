use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Instant,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MLKEM_PUBLIC_KEY_BYTES: usize = 1184;
const MLKEM_SECRET_KEY_BYTES: usize = 2400;
const MLKEM_CIPHERTEXT_BYTES: usize = 1088;
const MLKEM_SHARED_SECRET_BYTES: usize = 32;

const PACKET_ID: u8 = 180;
const MAGIC: &[u8; 3] = b"TPQ";
const VERSION: u8 = 1;
const KAIGEN_CAPABILITY_TAG: &[u8] = b"KAIGEN-PQ\0";
const KIND_CAPABILITY: u8 = 1;
const KIND_OFFER: u8 = 2;
const KIND_ACCEPT: u8 = 3;
const KIND_CONFIRM: u8 = 4;
const KIND_DATA: u8 = 5;
const KIND_ACK: u8 = 6;
const KIND_REJECT: u8 = 7;
const KIND_WITHDRAW: u8 = 8;
const KIND_CLOSE_REQUEST: u8 = 9;
const KIND_CLOSE_READY: u8 = 10;
const KIND_CLOSE_BUSY: u8 = 11;
const KIND_CLOSE_COMMIT: u8 = 12;
const KIND_CLOSE_ACK: u8 = 13;
const KIND_CLOSE_FINAL: u8 = 14;
const KIND_CAPABILITY_ACK: u8 = 15;
const HEADER_SIZE: usize = 6;
const DATA_HEADER_SIZE: usize = HEADER_SIZE + 8 + 8 + 2 + 2;
const DATA_FRAGMENT_BYTES: usize = 1200;

#[derive(Deserialize, Serialize)]
struct StoredIdentity {
    version: u8,
    algorithm: String,
    secret_key_hex: String,
}

#[derive(Default, Deserialize, Serialize)]
struct StoredTrust {
    fingerprints: HashMap<u32, String>,
    #[serde(default)]
    quarantined_fingerprints: Vec<QuarantinedFingerprint>,
}

#[derive(Deserialize, Serialize)]
struct QuarantinedFingerprint {
    previous_friend_number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    public_key: Option<String>,
    fingerprint: String,
}

struct Identity {
    secret_key: Vec<u8>,
    public_key: Vec<u8>,
    fingerprint: String,
}

struct Session {
    send_key: [u8; 32],
    receive_key: [u8; 32],
    nonce_prefix: [u8; 4],
    send_counter: u64,
}

struct Peer {
    supported: bool,
    state: String,
    public_key: Option<Vec<u8>>,
    fingerprint: Option<String>,
    pending_accept_secret: Option<[u8; 32]>,
    session: Option<Session>,
    shutdown_local_ready: bool,
    shutdown_peer_ready: bool,
    shutdown_commit_sent: bool,
    error: Option<String>,
}

impl Default for Peer {
    fn default() -> Self {
        Self {
            supported: false,
            state: "unavailable".to_string(),
            public_key: None,
            fingerprint: None,
            pending_accept_secret: None,
            session: None,
            shutdown_local_ready: false,
            shutdown_peer_ready: false,
            shutdown_commit_sent: false,
            error: None,
        }
    }
}

struct Reassembly {
    counter: u64,
    parts: Vec<Option<Vec<u8>>>,
    created_at: Instant,
}

struct Inner {
    peers: HashMap<u32, Peer>,
    reassembly: HashMap<(u32, u64), Reassembly>,
    outbox: VecDeque<(u32, Vec<u8>)>,
    quarantined_peers: Vec<(u32, Peer)>,
    quarantined_reassembly: Vec<((u32, u64), Reassembly)>,
    quarantined_outbox: VecDeque<(u32, Vec<u8>)>,
    trust: StoredTrust,
}

#[derive(Clone, Serialize)]
pub struct PqStatus {
    pub supported: bool,
    pub state: String,
    pub local_fingerprint: String,
    pub peer_fingerprint: Option<String>,
    pub fingerprint_changed: bool,
    pub error: Option<String>,
}

pub struct PacketResult {
    pub outgoing: Vec<Vec<u8>>,
    pub received_text: Option<String>,
    pub acknowledged_wire_id: Option<u64>,
    pub session_event: Option<PqSessionEvent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PqSessionEvent {
    OfferReceived,
    OfferCollisionYielded,
    Active,
    Rejected,
    Withdrawn,
    CloseRequested,
    Closed,
}

pub struct EncryptedMessage {
    pub wire_id: u64,
    pub packets: Vec<Vec<u8>>,
}

pub struct PqEngine {
    identity: Identity,
    trust_path: PathBuf,
    inner: Mutex<Inner>,
    next_wire_id: AtomicU64,
}

impl PqEngine {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let identity_path = data_dir.join("pq-identity.json");
        let trust_path = data_dir.join("pq-contacts.json");
        let identity = load_or_create_identity(&identity_path)?;
        let trust = fs::read(&trust_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Ok(Self {
            identity,
            trust_path,
            inner: Mutex::new(Inner {
                peers: HashMap::new(),
                reassembly: HashMap::new(),
                outbox: VecDeque::new(),
                quarantined_peers: Vec::new(),
                quarantined_reassembly: Vec::new(),
                quarantined_outbox: VecDeque::new(),
                trust,
            }),
            next_wire_id: AtomicU64::new(1),
        })
    }

    pub fn capability_packet(&self) -> Vec<u8> {
        self.capability_packet_with_kind(KIND_CAPABILITY)
    }

    fn capability_packet_with_kind(&self, kind: u8) -> Vec<u8> {
        let mut payload = Vec::with_capacity(KAIGEN_CAPABILITY_TAG.len() + MLKEM_PUBLIC_KEY_BYTES);
        payload.extend_from_slice(KAIGEN_CAPABILITY_TAG);
        payload.extend_from_slice(&self.identity.public_key);
        packet(kind, &payload)
    }

    pub fn queue(&self, friend_number: u32, packets: impl IntoIterator<Item = Vec<u8>>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner
                .outbox
                .extend(packets.into_iter().map(|packet| (friend_number, packet)));
        }
    }

    pub fn take_outbox(&self) -> VecDeque<(u32, Vec<u8>)> {
        self.inner
            .lock()
            .map(|mut inner| std::mem::take(&mut inner.outbox))
            .unwrap_or_default()
    }

    /// Reconcile numeric protocol state through a public-key-derived mapping.
    /// Unresolved state is quarantined rather than inherited by a future owner
    /// of the same toxcore slot. Trust fingerprints remain recoverable in the
    /// persisted quarantine section.
    pub fn reconcile_friend_numbers(
        &self,
        resolved: &HashMap<u32, u32>,
        previous_public_keys: &HashMap<u32, String>,
    ) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        for (friend_number, peer) in std::mem::take(&mut inner.peers) {
            if let Some(current) = resolved.get(&friend_number).copied() {
                if let Some(displaced) = inner.peers.insert(current, peer) {
                    inner.quarantined_peers.push((current, displaced));
                }
            } else {
                inner.quarantined_peers.push((friend_number, peer));
            }
        }
        for ((friend_number, wire_id), value) in std::mem::take(&mut inner.reassembly) {
            if let Some(current) = resolved.get(&friend_number).copied() {
                let key = (current, wire_id);
                if let Some(displaced) = inner.reassembly.insert(key, value) {
                    inner.quarantined_reassembly.push((key, displaced));
                }
            } else {
                inner
                    .quarantined_reassembly
                    .push(((friend_number, wire_id), value));
            }
        }
        for (friend_number, packet) in std::mem::take(&mut inner.outbox) {
            if let Some(current) = resolved.get(&friend_number).copied() {
                inner.outbox.push_back((current, packet));
            } else {
                inner.quarantined_outbox.push_back((friend_number, packet));
            }
        }
        let previous_trust = std::mem::take(&mut inner.trust.fingerprints);
        for (friend_number, fingerprint) in previous_trust {
            if let Some(current) = resolved.get(&friend_number).copied() {
                if let Some(displaced) = inner.trust.fingerprints.insert(current, fingerprint) {
                    inner
                        .trust
                        .quarantined_fingerprints
                        .push(QuarantinedFingerprint {
                            previous_friend_number: current,
                            public_key: previous_public_keys.get(&friend_number).cloned(),
                            fingerprint: displaced,
                        });
                }
            } else {
                inner
                    .trust
                    .quarantined_fingerprints
                    .push(QuarantinedFingerprint {
                        previous_friend_number: friend_number,
                        public_key: previous_public_keys.get(&friend_number).cloned(),
                        fingerprint,
                    });
            }
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&inner.trust) {
            let _ = fs::write(&self.trust_path, bytes);
        }
    }

    /// A c-toxcore friend number may be reused after deletion. Quarantine live
    /// protocol state and its trust decision so neither can reach the next key.
    pub fn remove_friend(&self, friend_number: u32, public_key: Option<&str>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if let Some(peer) = inner.peers.remove(&friend_number) {
            inner.quarantined_peers.push((friend_number, peer));
        }
        for (key, value) in std::mem::take(&mut inner.reassembly) {
            if key.0 == friend_number {
                inner.quarantined_reassembly.push((key, value));
            } else {
                inner.reassembly.insert(key, value);
            }
        }
        for (queued_friend, packet) in std::mem::take(&mut inner.outbox) {
            if queued_friend == friend_number {
                inner.quarantined_outbox.push_back((queued_friend, packet));
            } else {
                inner.outbox.push_back((queued_friend, packet));
            }
        }
        if let Some(fingerprint) = inner.trust.fingerprints.remove(&friend_number) {
            inner
                .trust
                .quarantined_fingerprints
                .push(QuarantinedFingerprint {
                    previous_friend_number: friend_number,
                    public_key: public_key.map(str::to_string),
                    fingerprint,
                });
            if let Ok(bytes) = serde_json::to_vec_pretty(&inner.trust) {
                let _ = fs::write(&self.trust_path, bytes);
            }
        }
    }

    pub fn requeue_front(&self, mut packets: VecDeque<(u32, Vec<u8>)>) {
        if let Ok(mut inner) = self.inner.lock() {
            packets.append(&mut inner.outbox);
            inner.outbox = packets;
        }
    }

    pub fn status(&self, friend_number: u32) -> PqStatus {
        let Ok(inner) = self.inner.lock() else {
            return PqStatus {
                supported: false,
                state: "error".to_string(),
                local_fingerprint: self.identity.fingerprint.clone(),
                peer_fingerprint: None,
                fingerprint_changed: false,
                error: Some("Состояние PQ временно недоступно".to_string()),
            };
        };
        let peer = inner.peers.get(&friend_number);
        let peer_fingerprint = peer.and_then(|value| value.fingerprint.clone());
        let fingerprint_changed = peer_fingerprint.as_ref().is_some_and(|current| {
            inner
                .trust
                .fingerprints
                .get(&friend_number)
                .is_some_and(|trusted| trusted != current)
        });
        PqStatus {
            supported: peer.is_some_and(|value| value.supported),
            state: peer
                .map(|value| value.state.clone())
                .unwrap_or_else(|| "unavailable".to_string()),
            local_fingerprint: self.identity.fingerprint.clone(),
            peer_fingerprint,
            fingerprint_changed,
            error: peer.and_then(|value| value.error.clone()),
        }
    }

    pub fn queues_encrypted_messages(&self, friend_number: u32) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| {
                inner.peers.get(&friend_number).map(|peer| {
                    peer.session.is_some() && matches!(peer.state.as_str(), "active" | "closing")
                })
            })
            .unwrap_or(false)
    }

    pub fn holds_plaintext_messages(&self, friend_number: u32) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| {
                inner.peers.get(&friend_number).map(|peer| {
                    peer.session.is_some()
                        || matches!(
                            peer.state.as_str(),
                            "closing" | "closing_commit" | "closing_ack" | "closing_final"
                        )
                })
            })
            .unwrap_or(false)
    }

    pub fn shutdown_friends(&self) -> Vec<u32> {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .peers
                    .iter()
                    .filter_map(|(friend_number, peer)| {
                        matches!(
                            peer.state.as_str(),
                            "closing" | "closing_commit" | "closing_ack" | "closing_final"
                        )
                        .then_some(*friend_number)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn request(&self, friend_number: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut inner = self.inner.lock().map_err(|_| "PQ state is locked")?;
        let fingerprint = {
            let peer = inner.peers.entry(friend_number).or_default();
            if !peer.supported || peer.public_key.is_none() {
                return Err("Этот контакт ещё не подтвердил поддержку PQ".to_string());
            }
            if peer.session.is_some() {
                return Err("Постквантовый слой уже активен или завершает работу".to_string());
            }
            if !matches!(peer.state.as_str(), "available" | "error") {
                return Err("Для этого контакта уже выполняется PQ-согласование".to_string());
            }
            peer.state = "offered".to_string();
            peer.error = None;
            peer.fingerprint.clone()
        };
        remember_fingerprint(&mut inner, friend_number, fingerprint, &self.trust_path)?;
        Ok(vec![packet(KIND_OFFER, &[])])
    }

    pub fn accept(&self, friend_number: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut inner = self.inner.lock().map_err(|_| "PQ state is locked")?;
        let (peer_key, fingerprint) = {
            let peer = inner.peers.entry(friend_number).or_default();
            if peer.state != "incoming_offer" {
                return Err("Нет ожидающего PQ-предложения".to_string());
            }
            (
                peer.public_key
                    .clone()
                    .ok_or("Не получен PQ-ключ контакта")?,
                peer.fingerprint.clone(),
            )
        };
        let (ciphertext, secret) = mlkem_encaps(&peer_key)?;
        let peer = inner.peers.get_mut(&friend_number).expect("peer exists");
        peer.pending_accept_secret = Some(secret);
        peer.state = "accepting".to_string();
        remember_fingerprint(&mut inner, friend_number, fingerprint, &self.trust_path)?;
        Ok(vec![packet(KIND_ACCEPT, &ciphertext)])
    }

    pub fn withdraw(&self, friend_number: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut inner = self.inner.lock().map_err(|_| "PQ state is locked")?;
        let peer = inner.peers.entry(friend_number).or_default();
        if peer.state != "offered" {
            return Err("Нет исходящего PQ-предложения, которое можно отозвать".to_string());
        }
        reset_negotiation(peer);
        Ok(vec![packet(KIND_WITHDRAW, &[])])
    }

    pub fn reject(&self, friend_number: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut inner = self.inner.lock().map_err(|_| "PQ state is locked")?;
        let peer = inner.peers.entry(friend_number).or_default();
        if peer.state != "incoming_offer" {
            return Err("Нет ожидающего PQ-предложения".to_string());
        }
        reset_negotiation(peer);
        Ok(vec![packet(KIND_REJECT, &[])])
    }

    pub fn request_shutdown(&self, friend_number: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut inner = self.inner.lock().map_err(|_| "PQ state is locked")?;
        let peer = inner.peers.get_mut(&friend_number).ok_or("PQ недоступен")?;
        if peer.session.is_none() || peer.state != "active" {
            return Err("Постквантовый слой сейчас не активен".to_string());
        }
        begin_shutdown(peer);
        Ok(vec![packet(KIND_CLOSE_REQUEST, &[])])
    }

    pub fn drive_shutdown(
        &self,
        friend_number: u32,
        external_queues_drained: bool,
    ) -> (Vec<Vec<u8>>, bool) {
        let Ok(mut inner) = self.inner.lock() else {
            return (Vec::new(), false);
        };
        let own_outbox_drained = inner
            .outbox
            .iter()
            .all(|(queued_friend, _)| *queued_friend != friend_number);
        let local_fingerprint = self.identity.fingerprint.as_str();
        let Some(peer) = inner.peers.get_mut(&friend_number) else {
            return (Vec::new(), false);
        };
        if peer.state == "closing_final" && external_queues_drained && own_outbox_drained {
            finish_shutdown(peer);
            return (Vec::new(), true);
        }
        if peer.state != "closing" || !external_queues_drained || !own_outbox_drained {
            return (Vec::new(), false);
        }
        let mut outgoing = Vec::new();
        if !peer.shutdown_local_ready {
            peer.shutdown_local_ready = true;
            outgoing.push(packet(KIND_CLOSE_READY, &[]));
        }
        if is_shutdown_coordinator(local_fingerprint, peer)
            && peer.shutdown_local_ready
            && peer.shutdown_peer_ready
            && !peer.shutdown_commit_sent
        {
            peer.shutdown_commit_sent = true;
            peer.state = "closing_commit".to_string();
            outgoing.push(packet(KIND_CLOSE_COMMIT, &[]));
        }
        (outgoing, false)
    }

    pub fn encrypt(&self, friend_number: u32, plaintext: &str) -> Result<EncryptedMessage, String> {
        let mut inner = self.inner.lock().map_err(|_| "PQ state is locked")?;
        let peer = inner.peers.get_mut(&friend_number).ok_or("PQ недоступен")?;
        if !matches!(peer.state.as_str(), "active" | "closing") {
            return Err("PQ-сессия завершает работу; сообщение будет отправлено после согласованного отключения".to_string());
        }
        let mut packets = Vec::new();
        if peer.shutdown_local_ready {
            peer.shutdown_local_ready = false;
            peer.shutdown_commit_sent = false;
            packets.push(packet(KIND_CLOSE_BUSY, &[]));
        }
        let session = peer.session.as_mut().ok_or("PQ-сессия не активна")?;
        session.send_counter = session
            .send_counter
            .checked_add(1)
            .ok_or("Исчерпан счётчик PQ-сессии")?;
        let counter = session.send_counter;
        let wire_id = ((crate::unix_timestamp() & 0xffff_ffff) << 32)
            | (self.next_wire_id.fetch_add(1, Ordering::Relaxed) & 0xffff_ffff);
        let nonce = nonce(&session.nonce_prefix, counter);
        let aad = data_aad(wire_id, counter, plaintext.len() as u64);
        let encrypted = aes_gcm_encrypt(&session.send_key, &nonce, &aad, plaintext.as_bytes())?;
        let total = encrypted.len().div_ceil(DATA_FRAGMENT_BYTES);
        if total > u16::MAX as usize {
            return Err("PQ-сообщение слишком длинное".to_string());
        }
        packets.extend(
            encrypted
                .chunks(DATA_FRAGMENT_BYTES)
                .enumerate()
                .map(|(index, chunk)| {
                    data_packet(wire_id, counter, index as u16, total as u16, chunk)
                }),
        );
        Ok(EncryptedMessage { wire_id, packets })
    }

    pub fn handle_packet(&self, friend_number: u32, bytes: &[u8]) -> Result<PacketResult, String> {
        if bytes.len() < HEADER_SIZE
            || bytes[0] != PACKET_ID
            || &bytes[1..4] != MAGIC
            || bytes[4] != VERSION
        {
            return Err("Неизвестный PQ-пакет".to_string());
        }
        let kind = bytes[5];
        let payload = &bytes[HEADER_SIZE..];
        let mut result = PacketResult {
            outgoing: Vec::new(),
            received_text: None,
            acknowledged_wire_id: None,
            session_event: None,
        };
        let mut inner = self.inner.lock().map_err(|_| "PQ state is locked")?;
        match kind {
            KIND_CAPABILITY | KIND_CAPABILITY_ACK => {
                if payload.len() != KAIGEN_CAPABILITY_TAG.len() + MLKEM_PUBLIC_KEY_BYTES
                    || !payload.starts_with(KAIGEN_CAPABILITY_TAG)
                {
                    return Err("Некорректный идентификатор возможности Kaigen PQ".to_string());
                }
                let canonical = payload[KAIGEN_CAPABILITY_TAG.len()..].to_vec();
                let fingerprint = fingerprint(&canonical);
                let peer = inner.peers.entry(friend_number).or_default();
                let changed = peer
                    .public_key
                    .as_ref()
                    .is_some_and(|old| old != &canonical);
                peer.supported = true;
                peer.public_key = Some(canonical);
                peer.fingerprint = Some(fingerprint);
                if changed {
                    peer.session = None;
                    peer.pending_accept_secret = None;
                    reset_shutdown(peer);
                    peer.state = "available".to_string();
                    peer.error =
                        Some("PQ-ключ контакта изменился; проверьте отпечаток".to_string());
                } else if peer.session.is_none() && peer.state == "unavailable" {
                    peer.state = "available".to_string();
                }
                if kind == KIND_CAPABILITY {
                    result
                        .outgoing
                        .push(self.capability_packet_with_kind(KIND_CAPABILITY_ACK));
                }
            }
            KIND_OFFER => {
                let peer = inner.peers.entry(friend_number).or_default();
                if peer.supported && peer.public_key.is_some() && peer.session.is_none() {
                    match peer.state.as_str() {
                        "offered" => {
                            let peer_fingerprint = peer.fingerprint.as_deref().unwrap_or_default();
                            if self.identity.fingerprint.as_str() > peer_fingerprint {
                                peer.state = "incoming_offer".to_string();
                                peer.error = None;
                                result.session_event = Some(PqSessionEvent::OfferCollisionYielded);
                            }
                        }
                        "incoming_offer" | "accepting" => {}
                        _ => {
                            peer.state = "incoming_offer".to_string();
                            peer.error = None;
                            result.session_event = Some(PqSessionEvent::OfferReceived);
                        }
                    }
                }
            }
            KIND_ACCEPT => {
                let peer = inner
                    .peers
                    .get_mut(&friend_number)
                    .ok_or("PQ-контакт неизвестен")?;
                if peer.state != "offered" {
                    if peer.session.is_none() {
                        result.outgoing.push(packet(KIND_WITHDRAW, &[]));
                    }
                    return Ok(result);
                }
                let secret_one = mlkem_decaps(&self.identity.secret_key, payload)?;
                let peer_key = peer
                    .public_key
                    .clone()
                    .ok_or("PQ-ключ контакта отсутствует")?;
                let (ciphertext_two, secret_two) = mlkem_encaps(&peer_key)?;
                let keys = derive_session(
                    &secret_one,
                    &secret_two,
                    &self.identity.public_key,
                    &peer_key,
                    true,
                )?;
                let confirm = keys.3;
                peer.session = Some(Session {
                    send_key: keys.0,
                    receive_key: keys.1,
                    nonce_prefix: keys.2,
                    send_counter: 0,
                });
                reset_shutdown(peer);
                peer.state = "active".to_string();
                result.session_event = Some(PqSessionEvent::Active);
                let mut confirm_payload = ciphertext_two.to_vec();
                confirm_payload.extend_from_slice(&confirm);
                result.outgoing.push(packet(KIND_CONFIRM, &confirm_payload));
            }
            KIND_CONFIRM => {
                if payload.len() < 16 {
                    return Err("Укороченный PQ confirm".to_string());
                }
                let split = payload.len() - 16;
                let secret_two = mlkem_decaps(&self.identity.secret_key, &payload[..split])?;
                let peer = inner
                    .peers
                    .get_mut(&friend_number)
                    .ok_or("PQ-контакт неизвестен")?;
                if peer.state != "accepting" || peer.pending_accept_secret.is_none() {
                    if peer.session.is_none() {
                        result.outgoing.push(packet(KIND_WITHDRAW, &[]));
                    }
                    return Ok(result);
                }
                let secret_one = peer
                    .pending_accept_secret
                    .take()
                    .ok_or("PQ accept не найден")?;
                let peer_key = peer
                    .public_key
                    .clone()
                    .ok_or("PQ-ключ контакта отсутствует")?;
                let keys = derive_session(
                    &secret_one,
                    &secret_two,
                    &peer_key,
                    &self.identity.public_key,
                    false,
                )?;
                if !constant_time_eq(&keys.3, &payload[split..]) {
                    peer.state = "error".to_string();
                    peer.error = Some("Не прошла проверка ключа PQ-сессии".to_string());
                    return Err("Не прошла проверка PQ confirm".to_string());
                }
                peer.session = Some(Session {
                    send_key: keys.0,
                    receive_key: keys.1,
                    nonce_prefix: keys.2,
                    send_counter: 0,
                });
                reset_shutdown(peer);
                peer.state = "active".to_string();
                result.session_event = Some(PqSessionEvent::Active);
            }
            KIND_DATA => {
                if bytes.len() < DATA_HEADER_SIZE {
                    return Err("Укороченный PQ data".to_string());
                }
                let wire_id = u64::from_be_bytes(bytes[6..14].try_into().unwrap());
                let counter = u64::from_be_bytes(bytes[14..22].try_into().unwrap());
                let index = u16::from_be_bytes(bytes[22..24].try_into().unwrap()) as usize;
                let total = u16::from_be_bytes(bytes[24..26].try_into().unwrap()) as usize;
                if total == 0 || index >= total || total > 4096 {
                    return Err("Некорректная PQ-фрагментация".to_string());
                }
                let entry = inner
                    .reassembly
                    .entry((friend_number, wire_id))
                    .or_insert_with(|| Reassembly {
                        counter,
                        parts: vec![None; total],
                        created_at: Instant::now(),
                    });
                if entry.counter != counter || entry.parts.len() != total {
                    return Err("Конфликт PQ-фрагментов".to_string());
                }
                entry.parts[index] = Some(bytes[DATA_HEADER_SIZE..].to_vec());
                if entry.parts.iter().all(Option::is_some) {
                    let entry = inner.reassembly.remove(&(friend_number, wire_id)).unwrap();
                    let encrypted = entry
                        .parts
                        .into_iter()
                        .flatten()
                        .flatten()
                        .collect::<Vec<_>>();
                    let peer = inner
                        .peers
                        .get(&friend_number)
                        .ok_or("PQ-контакт неизвестен")?;
                    let session = peer.session.as_ref().ok_or("PQ-сессия не активна")?;
                    let nonce = nonce(&session.nonce_prefix, counter);
                    let plaintext_len = encrypted.len().saturating_sub(16) as u64;
                    let aad = data_aad(wire_id, counter, plaintext_len);
                    let plaintext =
                        aes_gcm_decrypt(&session.receive_key, &nonce, &aad, &encrypted)?;
                    result.received_text =
                        Some(String::from_utf8(plaintext).map_err(|_| "PQ-текст не UTF-8")?);
                    result.outgoing.push(ack_packet(wire_id));
                }
                inner
                    .reassembly
                    .retain(|_, value| value.created_at.elapsed().as_secs() < 600);
            }
            KIND_ACK => {
                if payload.len() != 8 {
                    return Err("Некорректная PQ-квитанция".to_string());
                }
                result.acknowledged_wire_id = Some(u64::from_be_bytes(payload.try_into().unwrap()));
            }
            KIND_REJECT => {
                if !payload.is_empty() {
                    return Err("Некорректный PQ reject".to_string());
                }
                let peer = inner.peers.entry(friend_number).or_default();
                if matches!(peer.state.as_str(), "offered" | "accepting") && peer.session.is_none()
                {
                    reset_negotiation(peer);
                    peer.error =
                        Some("Контакт отклонил предложение постквантового шифрования".to_string());
                    result.session_event = Some(PqSessionEvent::Rejected);
                }
            }
            KIND_WITHDRAW => {
                if !payload.is_empty() {
                    return Err("Некорректный отзыв PQ-предложения".to_string());
                }
                let peer = inner.peers.entry(friend_number).or_default();
                if matches!(peer.state.as_str(), "incoming_offer" | "accepting")
                    && peer.session.is_none()
                {
                    reset_negotiation(peer);
                    peer.error =
                        Some("Контакт отозвал предложение постквантового шифрования".to_string());
                    result.session_event = Some(PqSessionEvent::Withdrawn);
                }
            }
            KIND_CLOSE_REQUEST => {
                if !payload.is_empty() {
                    return Err("Некорректный запрос отключения PQ".to_string());
                }
                let peer = inner.peers.entry(friend_number).or_default();
                if peer.session.is_some() {
                    if peer.state == "active" {
                        begin_shutdown(peer);
                        result.session_event = Some(PqSessionEvent::CloseRequested);
                    }
                } else if matches!(peer.state.as_str(), "available" | "unavailable") {
                    result.outgoing.push(packet(KIND_CLOSE_FINAL, &[]));
                }
            }
            KIND_CLOSE_READY => {
                if !payload.is_empty() {
                    return Err("Некорректная готовность к отключению PQ".to_string());
                }
                let peer = inner.peers.entry(friend_number).or_default();
                if matches!(peer.state.as_str(), "closing" | "closing_commit")
                    && peer.session.is_some()
                {
                    peer.shutdown_peer_ready = true;
                }
            }
            KIND_CLOSE_BUSY => {
                if !payload.is_empty() {
                    return Err("Некорректный сброс готовности PQ".to_string());
                }
                let peer = inner.peers.entry(friend_number).or_default();
                if matches!(peer.state.as_str(), "closing" | "closing_commit")
                    && peer.session.is_some()
                {
                    peer.shutdown_peer_ready = false;
                    peer.shutdown_commit_sent = false;
                    peer.state = "closing".to_string();
                }
            }
            KIND_CLOSE_COMMIT => {
                if !payload.is_empty() {
                    return Err("Некорректное подтверждение отключения PQ".to_string());
                }
                let peer = inner.peers.entry(friend_number).or_default();
                if peer.state == "closing_ack" && peer.session.is_some() {
                    result.outgoing.push(packet(KIND_CLOSE_ACK, &[]));
                } else if peer.state == "closing"
                    && peer.session.is_some()
                    && peer.shutdown_local_ready
                    && peer.shutdown_peer_ready
                {
                    peer.state = "closing_ack".to_string();
                    result.outgoing.push(packet(KIND_CLOSE_ACK, &[]));
                } else if peer.session.is_some() {
                    peer.shutdown_local_ready = false;
                    result.outgoing.push(packet(KIND_CLOSE_BUSY, &[]));
                } else {
                    result.outgoing.push(packet(KIND_CLOSE_FINAL, &[]));
                }
            }
            KIND_CLOSE_ACK => {
                if !payload.is_empty() {
                    return Err("Некорректная квитанция отключения PQ".to_string());
                }
                let local_fingerprint = self.identity.fingerprint.as_str();
                let peer = inner.peers.entry(friend_number).or_default();
                if peer.state == "closing_commit"
                    && peer.session.is_some()
                    && is_shutdown_coordinator(local_fingerprint, peer)
                {
                    peer.state = "closing_final".to_string();
                    result.outgoing.push(packet(KIND_CLOSE_FINAL, &[]));
                } else if peer.state == "closing_final" && peer.session.is_some() {
                    result.outgoing.push(packet(KIND_CLOSE_FINAL, &[]));
                } else if peer.session.is_none() {
                    result.outgoing.push(packet(KIND_CLOSE_FINAL, &[]));
                }
            }
            KIND_CLOSE_FINAL => {
                if !payload.is_empty() {
                    return Err("Некорректное завершение отключения PQ".to_string());
                }
                let peer = inner.peers.entry(friend_number).or_default();
                if peer.session.is_some()
                    && matches!(
                        peer.state.as_str(),
                        "active" | "closing" | "closing_commit" | "closing_ack" | "closing_final"
                    )
                {
                    finish_shutdown(peer);
                    result.session_event = Some(PqSessionEvent::Closed);
                }
            }
            _ => return Err("Неизвестный тип PQ-пакета".to_string()),
        }
        Ok(result)
    }
}

fn reset_shutdown(peer: &mut Peer) {
    peer.shutdown_local_ready = false;
    peer.shutdown_peer_ready = false;
    peer.shutdown_commit_sent = false;
}

fn reset_negotiation(peer: &mut Peer) {
    peer.pending_accept_secret = None;
    peer.session = None;
    reset_shutdown(peer);
    peer.state = if peer.supported {
        "available"
    } else {
        "unavailable"
    }
    .to_string();
}

fn begin_shutdown(peer: &mut Peer) {
    reset_shutdown(peer);
    peer.state = "closing".to_string();
    peer.error = None;
}

fn finish_shutdown(peer: &mut Peer) {
    peer.session = None;
    peer.pending_accept_secret = None;
    reset_shutdown(peer);
    peer.state = if peer.supported {
        "available"
    } else {
        "unavailable"
    }
    .to_string();
    peer.error = None;
}

fn is_shutdown_coordinator(local_fingerprint: &str, peer: &Peer) -> bool {
    peer.fingerprint
        .as_deref()
        .map(|remote| local_fingerprint < remote)
        .unwrap_or(true)
}

fn load_or_create_identity(path: &Path) -> Result<Identity, String> {
    let (public_key, secret_key) = if let Ok(bytes) = fs::read(path) {
        let stored: StoredIdentity = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Не удалось прочитать PQ identity: {error}"))?;
        if stored.version != VERSION || stored.algorithm != "ML-KEM-768" {
            return Err("Неподдерживаемый формат PQ identity".to_string());
        }
        let secret_key = decode_hex(&stored.secret_key_hex)?;
        if secret_key.len() != MLKEM_SECRET_KEY_BYTES {
            return Err("Некорректная длина secret key PQ identity".to_string());
        }
        // FIPS 203 stores the public encapsulation key inside dk.
        // mlkem-native serializes it at this fixed offset for ML-KEM-768.
        let public_key = secret_key[1152..1152 + MLKEM_PUBLIC_KEY_BYTES].to_vec();
        (public_key, secret_key)
    } else {
        let (public_key, secret_key) = mlkem_keypair()?;
        let stored = StoredIdentity {
            version: VERSION,
            algorithm: "ML-KEM-768".to_string(),
            secret_key_hex: encode_hex(&secret_key),
        };
        let bytes = serde_json::to_vec_pretty(&stored)
            .map_err(|error| format!("Не удалось сериализовать PQ identity: {error}"))?;
        fs::write(path, bytes)
            .map_err(|error| format!("Не удалось сохранить PQ identity: {error}"))?;
        (public_key, secret_key)
    };
    let fingerprint = fingerprint(&public_key);
    Ok(Identity {
        secret_key,
        public_key,
        fingerprint,
    })
}

fn remember_fingerprint(
    inner: &mut Inner,
    friend_number: u32,
    fingerprint: Option<String>,
    path: &Path,
) -> Result<(), String> {
    if let Some(fingerprint) = fingerprint {
        inner.trust.fingerprints.insert(friend_number, fingerprint);
        let bytes = serde_json::to_vec_pretty(&inner.trust)
            .map_err(|error| format!("Не удалось сохранить PQ-отпечаток: {error}"))?;
        fs::write(path, bytes)
            .map_err(|error| format!("Не удалось сохранить PQ-отпечаток: {error}"))?;
    }
    Ok(())
}

fn derive_session(
    first: &[u8],
    second: &[u8],
    initiator_public: &[u8],
    responder_public: &[u8],
    initiator: bool,
) -> Result<([u8; 32], [u8; 32], [u8; 4], [u8; 16]), String> {
    let mut input = Vec::with_capacity(first.len() + second.len());
    input.extend_from_slice(first);
    input.extend_from_slice(second);
    let mut context = Vec::with_capacity(initiator_public.len() + responder_public.len());
    context.extend_from_slice(initiator_public);
    context.extend_from_slice(responder_public);
    let expanded = hkdf_sha256(b"Tox-PQ-v1 ML-KEM-768 nested E2EE", &input, &context, 84);
    let mut i2r = [0_u8; 32];
    let mut r2i = [0_u8; 32];
    let mut nonce_prefix = [0_u8; 4];
    let mut confirm = [0_u8; 16];
    i2r.copy_from_slice(&expanded[..32]);
    r2i.copy_from_slice(&expanded[32..64]);
    nonce_prefix.copy_from_slice(&expanded[64..68]);
    confirm.copy_from_slice(&expanded[68..84]);
    Ok(if initiator {
        (i2r, r2i, nonce_prefix, confirm)
    } else {
        (r2i, i2r, nonce_prefix, confirm)
    })
}

fn packet(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_SIZE + payload.len());
    bytes.push(PACKET_ID);
    bytes.extend_from_slice(MAGIC);
    bytes.push(VERSION);
    bytes.push(kind);
    bytes.extend_from_slice(payload);
    bytes
}

fn data_packet(wire_id: u64, counter: u64, index: u16, total: u16, payload: &[u8]) -> Vec<u8> {
    let mut bytes = packet(KIND_DATA, &[]);
    bytes.extend_from_slice(&wire_id.to_be_bytes());
    bytes.extend_from_slice(&counter.to_be_bytes());
    bytes.extend_from_slice(&index.to_be_bytes());
    bytes.extend_from_slice(&total.to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn ack_packet(wire_id: u64) -> Vec<u8> {
    packet(KIND_ACK, &wire_id.to_be_bytes())
}

fn nonce(prefix: &[u8; 4], counter: u64) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[..4].copy_from_slice(prefix);
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn data_aad(wire_id: u64, counter: u64, plaintext_len: u64) -> Vec<u8> {
    let mut aad = b"Tox-PQ-Data-v1".to_vec();
    aad.extend_from_slice(&wire_id.to_be_bytes());
    aad.extend_from_slice(&counter.to_be_bytes());
    aad.extend_from_slice(&plaintext_len.to_be_bytes());
    aad
}

fn fingerprint(public_key: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"Tox-PQ ML-KEM-768 identity v1\0");
    hash.update(public_key);
    let encoded = encode_hex(&hash.finalize());
    encoded
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap())
        .collect::<Vec<_>>()
        .join(" ")
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Некорректный hex в PQ identity".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Некорректный PQ hex".to_string())
        })
        .collect()
}

fn mlkem_keypair() -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut public_key = vec![0_u8; MLKEM_PUBLIC_KEY_BYTES];
    let mut secret_key = vec![0_u8; MLKEM_SECRET_KEY_BYTES];
    let result = unsafe {
        PQCP_MLKEM_NATIVE_MLKEM768_keypair(public_key.as_mut_ptr(), secret_key.as_mut_ptr())
    };
    if result == 0 {
        Ok((public_key, secret_key))
    } else {
        Err(format!("mlkem-native keypair завершился с кодом {result}"))
    }
}

fn mlkem_encaps(public_key: &[u8]) -> Result<(Vec<u8>, [u8; 32]), String> {
    if public_key.len() != MLKEM_PUBLIC_KEY_BYTES {
        return Err("Некорректная длина ML-KEM-768 public key".to_string());
    }
    let mut ciphertext = vec![0_u8; MLKEM_CIPHERTEXT_BYTES];
    let mut shared = [0_u8; MLKEM_SHARED_SECRET_BYTES];
    let result = unsafe {
        PQCP_MLKEM_NATIVE_MLKEM768_enc(
            ciphertext.as_mut_ptr(),
            shared.as_mut_ptr(),
            public_key.as_ptr(),
        )
    };
    if result == 0 {
        Ok((ciphertext, shared))
    } else {
        Err(format!("mlkem-native encaps завершился с кодом {result}"))
    }
}

fn mlkem_decaps(secret_key: &[u8], ciphertext: &[u8]) -> Result<[u8; 32], String> {
    if secret_key.len() != MLKEM_SECRET_KEY_BYTES || ciphertext.len() != MLKEM_CIPHERTEXT_BYTES {
        return Err("Некорректный материал ML-KEM-768".to_string());
    }
    let mut shared = [0_u8; MLKEM_SHARED_SECRET_BYTES];
    let result = unsafe {
        PQCP_MLKEM_NATIVE_MLKEM768_dec(
            shared.as_mut_ptr(),
            ciphertext.as_ptr(),
            secret_key.as_ptr(),
        )
    };
    if result == 0 {
        Ok(shared)
    } else {
        Err(format!("mlkem-native decaps завершился с кодом {result}"))
    }
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..64 {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    outer.finalize().into()
}

fn hkdf_sha256(salt: &[u8], input: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    let prk = hmac_sha256(salt, input);
    let mut output = Vec::with_capacity(length);
    let mut previous = Vec::new();
    let mut counter = 1_u8;
    while output.len() < length {
        let mut block_input = Vec::with_capacity(previous.len() + info.len() + 1);
        block_input.extend_from_slice(&previous);
        block_input.extend_from_slice(info);
        block_input.push(counter);
        previous = hmac_sha256(&prk, &block_input).to_vec();
        output.extend_from_slice(&previous);
        counter = counter.checked_add(1).expect("HKDF output is short");
    }
    output.truncate(length);
    output
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct AuthenticatedCipherModeInfo {
    cb_size: u32,
    info_version: u32,
    nonce: *mut u8,
    nonce_len: u32,
    auth_data: *mut u8,
    auth_data_len: u32,
    tag: *mut u8,
    tag_len: u32,
    mac_context: *mut u8,
    mac_context_len: u32,
    aad_len: u32,
    data_len: u64,
    flags: u32,
}

#[cfg(target_os = "windows")]
fn aes_gcm_encrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    aes_gcm(key, nonce, aad, plaintext, None)
}

#[cfg(target_os = "windows")]
fn aes_gcm_decrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    encrypted: &[u8],
) -> Result<Vec<u8>, String> {
    if encrypted.len() < 16 {
        return Err("Укороченный AES-GCM ciphertext".to_string());
    }
    let split = encrypted.len() - 16;
    aes_gcm(
        key,
        nonce,
        aad,
        &encrypted[..split],
        Some(&encrypted[split..]),
    )
}

#[cfg(target_os = "windows")]
fn aes_gcm(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    input: &[u8],
    decrypt_tag: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut algorithm = std::ptr::null_mut();
    let aes = wide("AES");
    let status =
        unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, aes.as_ptr(), std::ptr::null(), 0) };
    if status != 0 {
        return Err(format!(
            "Windows CNG AES недоступен: 0x{:08X}",
            status as u32
        ));
    }
    let chaining_mode = wide("ChainingMode");
    let gcm = wide("ChainingModeGCM");
    let status = unsafe {
        BCryptSetProperty(
            algorithm,
            chaining_mode.as_ptr(),
            gcm.as_ptr() as *mut u8,
            (gcm.len() * 2) as u32,
            0,
        )
    };
    if status != 0 {
        unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
        return Err(format!(
            "Windows CNG GCM недоступен: 0x{:08X}",
            status as u32
        ));
    }
    let object_length_name = wide("ObjectLength");
    let mut object_length = 0_u32;
    let mut copied = 0_u32;
    let status = unsafe {
        BCryptGetProperty(
            algorithm,
            object_length_name.as_ptr(),
            (&mut object_length as *mut u32).cast(),
            4,
            &mut copied,
            0,
        )
    };
    if status != 0 {
        unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
        return Err(format!(
            "Windows CNG key object error: 0x{:08X}",
            status as u32
        ));
    }
    let mut key_object = vec![0_u8; object_length as usize];
    let mut key_handle = std::ptr::null_mut();
    let status = unsafe {
        BCryptGenerateSymmetricKey(
            algorithm,
            &mut key_handle,
            key_object.as_mut_ptr(),
            object_length,
            key.as_ptr() as *mut u8,
            key.len() as u32,
            0,
        )
    };
    if status != 0 {
        unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
        return Err(format!("Windows CNG key error: 0x{:08X}", status as u32));
    }
    let mut nonce_copy = *nonce;
    let mut aad_copy = aad.to_vec();
    let mut tag = decrypt_tag.map_or_else(|| vec![0_u8; 16], |value| value.to_vec());
    let mut auth = AuthenticatedCipherModeInfo {
        cb_size: std::mem::size_of::<AuthenticatedCipherModeInfo>() as u32,
        info_version: 1,
        nonce: nonce_copy.as_mut_ptr(),
        nonce_len: nonce_copy.len() as u32,
        auth_data: aad_copy.as_mut_ptr(),
        auth_data_len: aad_copy.len() as u32,
        tag: tag.as_mut_ptr(),
        tag_len: tag.len() as u32,
        mac_context: std::ptr::null_mut(),
        mac_context_len: 0,
        aad_len: 0,
        data_len: 0,
        flags: 0,
    };
    let mut output = vec![0_u8; input.len()];
    let mut output_len = 0_u32;
    let status = unsafe {
        if decrypt_tag.is_some() {
            BCryptDecrypt(
                key_handle,
                input.as_ptr() as *mut u8,
                input.len() as u32,
                &mut auth,
                std::ptr::null_mut(),
                0,
                output.as_mut_ptr(),
                output.len() as u32,
                &mut output_len,
                0,
            )
        } else {
            BCryptEncrypt(
                key_handle,
                input.as_ptr() as *mut u8,
                input.len() as u32,
                &mut auth,
                std::ptr::null_mut(),
                0,
                output.as_mut_ptr(),
                output.len() as u32,
                &mut output_len,
                0,
            )
        }
    };
    unsafe {
        BCryptDestroyKey(key_handle);
        BCryptCloseAlgorithmProvider(algorithm, 0);
    }
    if status != 0 {
        return Err("PQ-сообщение не прошло проверку целостности AES-GCM".to_string());
    }
    output.truncate(output_len as usize);
    if decrypt_tag.is_none() {
        output.extend_from_slice(&tag);
    }
    Ok(output)
}

#[cfg(not(target_os = "windows"))]
fn aes_gcm_encrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid AES-256-GCM key length".to_string())?;
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Failed to encrypt PQ message with AES-GCM".to_string())
}

#[cfg(not(target_os = "windows"))]
fn aes_gcm_decrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    encrypted: &[u8],
) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};

    if encrypted.len() < 16 {
        return Err("Truncated AES-GCM ciphertext".to_string());
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid AES-256-GCM key length".to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: encrypted,
                aad,
            },
        )
        .map_err(|_| "PQ message failed AES-GCM authentication".to_string())
}

#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
#[no_mangle]
unsafe extern "C" fn randombytes(output: *mut u8, output_len: usize) -> i32 {
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 2;
    if output.is_null() || output_len > u32::MAX as usize {
        return -1;
    }
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            output,
            output_len as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        0
    } else {
        -1
    }
}

#[cfg(not(target_os = "windows"))]
#[no_mangle]
unsafe extern "C" fn randombytes(output: *mut u8, output_len: usize) -> i32 {
    if output.is_null() {
        return -1;
    }
    let output = unsafe { std::slice::from_raw_parts_mut(output, output_len) };
    if getrandom::fill(output).is_ok() {
        0
    } else {
        -1
    }
}

unsafe extern "C" {
    fn PQCP_MLKEM_NATIVE_MLKEM768_keypair(public_key: *mut u8, secret_key: *mut u8) -> i32;
    fn PQCP_MLKEM_NATIVE_MLKEM768_enc(
        ciphertext: *mut u8,
        shared_secret: *mut u8,
        public_key: *const u8,
    ) -> i32;
    fn PQCP_MLKEM_NATIVE_MLKEM768_dec(
        shared_secret: *mut u8,
        ciphertext: *const u8,
        secret_key: *const u8,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptOpenAlgorithmProvider(
        handle: *mut *mut std::ffi::c_void,
        algorithm: *const u16,
        provider: *const u16,
        flags: u32,
    ) -> i32;
    fn BCryptCloseAlgorithmProvider(handle: *mut std::ffi::c_void, flags: u32) -> i32;
    fn BCryptSetProperty(
        handle: *mut std::ffi::c_void,
        property: *const u16,
        input: *mut u8,
        input_len: u32,
        flags: u32,
    ) -> i32;
    fn BCryptGetProperty(
        handle: *mut std::ffi::c_void,
        property: *const u16,
        output: *mut u8,
        output_len: u32,
        result: *mut u32,
        flags: u32,
    ) -> i32;
    fn BCryptGenerateSymmetricKey(
        algorithm: *mut std::ffi::c_void,
        key: *mut *mut std::ffi::c_void,
        key_object: *mut u8,
        key_object_len: u32,
        secret: *mut u8,
        secret_len: u32,
        flags: u32,
    ) -> i32;
    fn BCryptDestroyKey(key: *mut std::ffi::c_void) -> i32;
    fn BCryptEncrypt(
        key: *mut std::ffi::c_void,
        input: *mut u8,
        input_len: u32,
        padding_info: *mut AuthenticatedCipherModeInfo,
        iv: *mut u8,
        iv_len: u32,
        output: *mut u8,
        output_len: u32,
        result: *mut u32,
        flags: u32,
    ) -> i32;
    fn BCryptDecrypt(
        key: *mut std::ffi::c_void,
        input: *mut u8,
        input_len: u32,
        padding_info: *mut AuthenticatedCipherModeInfo,
        iv: *mut u8,
        iv_len: u32,
        output: *mut u8,
        output_len: u32,
        result: *mut u32,
        flags: u32,
    ) -> i32;
    fn BCryptGenRandom(
        algorithm: *mut std::ffi::c_void,
        output: *mut u8,
        output_len: u32,
        flags: u32,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn data_fragments_fit_tox_custom_packet_limit() {
        let packet = data_packet(1, 1, 0, 1, &vec![0_u8; DATA_FRAGMENT_BYTES]);
        assert!(packet.len() <= 1373);
    }

    #[test]
    fn fingerprint_is_grouped_sha256() {
        let value = fingerprint(&[7_u8; 1184]);
        assert_eq!(value.replace(' ', "").len(), 64);
        assert_eq!(value.split(' ').count(), 16);
    }

    #[test]
    fn capability_requires_exact_kaigen_tag_and_is_acknowledged() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tox-pq-capability-{suffix}"));
        let alice_dir = root.join("alice");
        let bob_dir = root.join("bob");
        fs::create_dir_all(&alice_dir).unwrap();
        fs::create_dir_all(&bob_dir).unwrap();
        let alice = PqEngine::new(&alice_dir).unwrap();
        let bob = PqEngine::new(&bob_dir).unwrap();

        let valid = alice.capability_packet();
        let legacy_without_client_tag = packet(
            KIND_CAPABILITY,
            &valid[HEADER_SIZE + KAIGEN_CAPABILITY_TAG.len()..],
        );
        assert!(bob.handle_packet(0, &legacy_without_client_tag).is_err());
        assert!(!bob.status(0).supported);

        let response = bob.handle_packet(0, &valid).unwrap();
        assert_eq!(response.outgoing.len(), 1);
        assert!(bob.status(0).supported);
        alice.handle_packet(0, &response.outgoing[0]).unwrap();
        assert!(alice.status(0).supported);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mlkem_native_round_trip_and_serialized_public_key_layout() {
        let (public_key, secret_key) = mlkem_keypair().unwrap();
        assert_eq!(
            &secret_key[1152..1152 + MLKEM_PUBLIC_KEY_BYTES],
            public_key.as_slice()
        );
        let (ciphertext, shared_secret) = mlkem_encaps(&public_key).unwrap();
        let recovered = mlkem_decaps(&secret_key, &ciphertext).unwrap();
        assert_eq!(recovered, shared_secret);
    }

    #[test]
    fn aes_gcm_detects_tampering() {
        let key = [7_u8; 32];
        let nonce = [9_u8; 12];
        let aad = b"Tox-PQ test metadata";
        let plaintext = "Проверка целостности 🔐".as_bytes();
        let encrypted = aes_gcm_encrypt(&key, &nonce, aad, plaintext).unwrap();
        assert_eq!(
            aes_gcm_decrypt(&key, &nonce, aad, &encrypted).unwrap(),
            plaintext
        );
        let mut tampered = encrypted;
        tampered[0] ^= 1;
        assert!(aes_gcm_decrypt(&key, &nonce, aad, &tampered).is_err());
    }

    #[test]
    fn complete_two_party_handshake_and_fragmented_message() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tox-pq-protocol-{suffix}"));
        let alice_dir = root.join("alice");
        let bob_dir = root.join("bob");
        fs::create_dir_all(&alice_dir).unwrap();
        fs::create_dir_all(&bob_dir).unwrap();
        let alice = PqEngine::new(&alice_dir).unwrap();
        let bob = PqEngine::new(&bob_dir).unwrap();

        alice.handle_packet(0, &bob.capability_packet()).unwrap();
        bob.handle_packet(0, &alice.capability_packet()).unwrap();
        assert_eq!(alice.status(0).state, "available");
        assert_eq!(bob.status(0).state, "available");

        for offer in alice.request(0).unwrap() {
            assert_eq!(
                bob.handle_packet(0, &offer).unwrap().session_event,
                Some(PqSessionEvent::OfferReceived)
            );
        }
        assert_eq!(bob.status(0).state, "incoming_offer");
        let mut confirms = Vec::new();
        for accept in bob.accept(0).unwrap() {
            let result = alice.handle_packet(0, &accept).unwrap();
            assert_eq!(result.session_event, Some(PqSessionEvent::Active));
            confirms.extend(result.outgoing);
        }
        for confirm in confirms {
            assert_eq!(
                bob.handle_packet(0, &confirm).unwrap().session_event,
                Some(PqSessionEvent::Active)
            );
        }
        assert!(alice.queues_encrypted_messages(0));
        assert!(bob.queues_encrypted_messages(0));

        let original = "Большое PQ-сообщение 🔐 ".repeat(240);
        let encrypted = alice.encrypt(0, &original).unwrap();
        assert!(encrypted.packets.len() > 2);
        let mut received = None;
        let mut acknowledgements = Vec::new();
        for part in encrypted.packets {
            assert!(part.len() <= 1373);
            let result = bob.handle_packet(0, &part).unwrap();
            if result.received_text.is_some() {
                received = result.received_text;
            }
            acknowledgements.extend(result.outgoing);
        }
        assert_eq!(received.as_deref(), Some(original.as_str()));
        assert_eq!(acknowledgements.len(), 1);
        assert_eq!(
            alice
                .handle_packet(0, &acknowledgements[0])
                .unwrap()
                .acknowledged_wire_id,
            Some(encrypted.wire_id)
        );

        fs::remove_dir_all(root).unwrap();
    }

    fn connected_pair(label: &str) -> (PathBuf, PqEngine, PqEngine) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tox-pq-{label}-{suffix}"));
        let alice_dir = root.join("alice");
        let bob_dir = root.join("bob");
        fs::create_dir_all(&alice_dir).unwrap();
        fs::create_dir_all(&bob_dir).unwrap();
        let alice = PqEngine::new(&alice_dir).unwrap();
        let bob = PqEngine::new(&bob_dir).unwrap();
        alice.handle_packet(0, &bob.capability_packet()).unwrap();
        bob.handle_packet(0, &alice.capability_packet()).unwrap();
        (root, alice, bob)
    }

    fn activate_pair(alice: &PqEngine, bob: &PqEngine) {
        for offer in alice.request(0).unwrap() {
            bob.handle_packet(0, &offer).unwrap();
        }
        let mut confirms = Vec::new();
        for accept in bob.accept(0).unwrap() {
            confirms.extend(alice.handle_packet(0, &accept).unwrap().outgoing);
        }
        for confirm in confirms {
            bob.handle_packet(0, &confirm).unwrap();
        }
        assert!(alice.queues_encrypted_messages(0));
        assert!(bob.queues_encrypted_messages(0));
    }

    #[test]
    fn public_key_reconciliation_remaps_owner_and_quarantines_missing_owner() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tox-pq-reconcile-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let engine = PqEngine::new(&root).unwrap();
        engine
            .handle_packet(7, &engine.capability_packet())
            .unwrap();
        engine.queue(7, [vec![1, 2, 3]]);
        {
            let mut inner = engine.inner.lock().unwrap();
            inner.trust.fingerprints.insert(7, "ALICE-FP".to_string());
        }
        engine.reconcile_friend_numbers(
            &HashMap::from([(7, 19)]),
            &HashMap::from([(7, "ALICE".to_string())]),
        );
        {
            let inner = engine.inner.lock().unwrap();
            assert!(inner.peers.contains_key(&19));
            assert_eq!(inner.outbox.front().map(|entry| entry.0), Some(19));
            assert_eq!(
                inner.trust.fingerprints.get(&19).map(String::as_str),
                Some("ALICE-FP")
            );
        }

        engine
            .reconcile_friend_numbers(&HashMap::new(), &HashMap::from([(19, "ALICE".to_string())]));
        {
            let inner = engine.inner.lock().unwrap();
            assert!(inner.peers.is_empty());
            assert!(inner.outbox.is_empty());
            assert_eq!(inner.quarantined_peers.len(), 1);
            assert_eq!(inner.quarantined_outbox.len(), 1);
            assert!(inner.trust.fingerprints.is_empty());
            assert_eq!(inner.trust.quarantined_fingerprints.len(), 1);
            assert_eq!(
                inner.trust.quarantined_fingerprints[0]
                    .public_key
                    .as_deref(),
                Some("ALICE")
            );
        }
        let persisted: StoredTrust =
            serde_json::from_slice(&fs::read(root.join("pq-contacts.json")).unwrap()).unwrap();
        assert_eq!(persisted.quarantined_fingerprints.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_friend_quarantines_pq_packets_and_trust() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tox-pq-delete-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let engine = PqEngine::new(&root).unwrap();
        engine
            .handle_packet(3, &engine.capability_packet())
            .unwrap();
        engine.queue(3, [vec![9, 8, 7]]);
        {
            let mut inner = engine.inner.lock().unwrap();
            inner.trust.fingerprints.insert(3, "BOB-FP".to_string());
        }
        engine.remove_friend(3, Some("BOB"));
        let inner = engine.inner.lock().unwrap();
        assert!(!inner.peers.contains_key(&3));
        assert!(inner.outbox.is_empty());
        assert_eq!(inner.quarantined_peers.len(), 1);
        assert_eq!(inner.quarantined_outbox.len(), 1);
        assert!(!inner.trust.fingerprints.contains_key(&3));
        assert_eq!(inner.trust.quarantined_fingerprints.len(), 1);
        assert_eq!(
            inner.trust.quarantined_fingerprints[0]
                .public_key
                .as_deref(),
            Some("BOB")
        );
        drop(inner);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn offer_withdrawal_is_symmetric_and_late_accept_cannot_activate() {
        let (root, alice, bob) = connected_pair("withdraw");
        let offer = alice.request(0).unwrap();
        for packet in offer {
            bob.handle_packet(0, &packet).unwrap();
        }
        let late_accept = bob.accept(0).unwrap();
        let withdrawal = alice.withdraw(0).unwrap();
        for packet in withdrawal {
            let result = bob.handle_packet(0, &packet).unwrap();
            assert_eq!(result.session_event, Some(PqSessionEvent::Withdrawn));
        }
        assert_eq!(alice.status(0).state, "available");
        assert_eq!(bob.status(0).state, "available");

        for packet in late_accept {
            let result = alice.handle_packet(0, &packet).unwrap();
            assert_eq!(result.outgoing.len(), 1);
            for repeated_withdrawal in result.outgoing {
                bob.handle_packet(0, &repeated_withdrawal).unwrap();
            }
        }
        assert!(!alice.queues_encrypted_messages(0));
        assert!(!bob.queues_encrypted_messages(0));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn simultaneous_offers_choose_one_initiator_without_deadlock() {
        let (root, alice, bob) = connected_pair("simultaneous-offers");
        let alice_offer = alice.request(0).unwrap();
        let bob_offer = bob.request(0).unwrap();
        let alice_result = alice.handle_packet(0, &bob_offer[0]).unwrap();
        let bob_result = bob.handle_packet(0, &alice_offer[0]).unwrap();
        let yielded = [alice_result.session_event, bob_result.session_event]
            .into_iter()
            .filter(|event| *event == Some(PqSessionEvent::OfferCollisionYielded))
            .count();
        assert_eq!(yielded, 1);

        let (initiator, responder) = if alice.status(0).state == "offered" {
            (&alice, &bob)
        } else {
            (&bob, &alice)
        };
        assert_eq!(initiator.status(0).state, "offered");
        assert_eq!(responder.status(0).state, "incoming_offer");
        let mut confirms = Vec::new();
        for accept in responder.accept(0).unwrap() {
            confirms.extend(initiator.handle_packet(0, &accept).unwrap().outgoing);
        }
        for confirm in confirms {
            responder.handle_packet(0, &confirm).unwrap();
        }
        assert!(alice.queues_encrypted_messages(0));
        assert!(bob.queues_encrypted_messages(0));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn coordinated_shutdown_waits_for_delivery_and_finishes_on_both_sides() {
        let (root, alice, bob) = connected_pair("shutdown");
        activate_pair(&alice, &bob);

        for request in alice.request_shutdown(0).unwrap() {
            let result = bob.handle_packet(0, &request).unwrap();
            assert_eq!(result.session_event, Some(PqSessionEvent::CloseRequested));
        }
        assert_eq!(alice.status(0).state, "closing");
        assert_eq!(bob.status(0).state, "closing");
        assert!(alice.drive_shutdown(0, false).0.is_empty());
        assert!(bob.drive_shutdown(0, false).0.is_empty());

        let queued = alice.encrypt(0, "Сообщение перед отключением").unwrap();
        let mut acknowledgements = Vec::new();
        for packet in queued.packets {
            acknowledgements.extend(bob.handle_packet(0, &packet).unwrap().outgoing);
        }
        assert_eq!(acknowledgements.len(), 1);
        for acknowledgement in acknowledgements {
            assert_eq!(
                alice
                    .handle_packet(0, &acknowledgement)
                    .unwrap()
                    .acknowledged_wire_id,
                Some(queued.wire_id)
            );
        }

        let alice_ready = alice.drive_shutdown(0, true).0;
        let bob_ready = bob.drive_shutdown(0, true).0;
        for packet in alice_ready {
            assert!(bob.handle_packet(0, &packet).unwrap().outgoing.is_empty());
        }
        for packet in bob_ready {
            assert!(alice.handle_packet(0, &packet).unwrap().outgoing.is_empty());
        }
        assert_eq!(alice.status(0).state, "closing");
        assert_eq!(bob.status(0).state, "closing");

        let after_ready = alice
            .encrypt(0, "Сообщение, набранное после готовности")
            .unwrap();
        assert_eq!(after_ready.packets[0][5], KIND_CLOSE_BUSY);
        let mut after_ready_acks = Vec::new();
        for packet in after_ready.packets {
            after_ready_acks.extend(bob.handle_packet(0, &packet).unwrap().outgoing);
        }
        for acknowledgement in after_ready_acks {
            alice.handle_packet(0, &acknowledgement).unwrap();
        }

        let mut alice_to_bob = alice.drive_shutdown(0, true).0;
        let mut bob_to_alice = bob.drive_shutdown(0, true).0;
        for _ in 0..12 {
            let mut next_bob_to_alice = Vec::new();
            for packet in alice_to_bob.drain(..) {
                next_bob_to_alice.extend(bob.handle_packet(0, &packet).unwrap().outgoing);
            }
            let mut next_alice_to_bob = Vec::new();
            for packet in bob_to_alice.drain(..) {
                next_alice_to_bob.extend(alice.handle_packet(0, &packet).unwrap().outgoing);
            }
            next_alice_to_bob.extend(alice.drive_shutdown(0, true).0);
            next_bob_to_alice.extend(bob.drive_shutdown(0, true).0);
            alice_to_bob = next_alice_to_bob;
            bob_to_alice = next_bob_to_alice;
            if alice.status(0).state == "available" && bob.status(0).state == "available" {
                break;
            }
        }
        assert_eq!(alice.status(0).state, "available");
        assert_eq!(bob.status(0).state, "available");
        assert!(!alice.queues_encrypted_messages(0));
        assert!(!bob.queues_encrypted_messages(0));
        fs::remove_dir_all(root).unwrap();
    }
}
