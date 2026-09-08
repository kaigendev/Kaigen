//! Durable, transcript-bound hybrid PQ sessions. Numeric Tox slots are routing
//! hints only; all persisted state belongs to a stable Tox public key.
use super::crypto::hmac_sha256;
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

#[cfg(test)]
mod tests;

const WIRE_VERSION: u8 = 2;
const FRAGMENT: usize = 1200;
const MAX_RECORD: usize = 512 * 1024;
const MAX_TEXT: usize = 256 * 1024 + 64;
const MAX_PARTIALS: usize = 16;
const MAX_SKIPPED: u64 = 128;
const MAX_OUTGOING: usize = 128;
const MAX_OUTGOING_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETIRED: usize = 4096;
const MAX_DETACHED_ARCHIVES: usize = 16;
const RETRY: Duration = Duration::from_secs(1);
const DATA_RETRY: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize, Deserialize)]
struct Secret([u8; 32]);
impl Drop for Secret {
    fn drop(&mut self) {
        crypto::wipe(&mut self.0);
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct PrivateBytes(Vec<u8>);
impl Drop for PrivateBytes {
    fn drop(&mut self) {
        crypto::wipe(&mut self.0);
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Record {
    Capability {
        #[serde(with = "wire_bytes")]
        identity: Vec<u8>,
    },
    Offer {
        tx: String,
        parent: Option<String>,
        automatic: bool,
        initiator: String,
        responder: String,
        #[serde(with = "wire_bytes")]
        identity: Vec<u8>,
        #[serde(with = "wire_bytes")]
        kem: Vec<u8>,
        dh: [u8; 32],
    },
    Accept {
        tx: String,
        #[serde(with = "wire_bytes")]
        identity: Vec<u8>,
        #[serde(with = "wire_bytes")]
        kem: Vec<u8>,
        dh: [u8; 32],
        #[serde(with = "wire_bytes")]
        ct_ephemeral: Vec<u8>,
        #[serde(with = "wire_bytes")]
        ct_identity: Vec<u8>,
    },
    Finish {
        tx: String,
        #[serde(with = "wire_bytes")]
        ct_ephemeral: Vec<u8>,
        #[serde(with = "wire_bytes")]
        ct_identity: Vec<u8>,
        #[serde(with = "wire_bytes")]
        tag: Vec<u8>,
    },
    Signal {
        epoch: String,
        action: String,
        sequence: u64,
        #[serde(with = "wire_bytes")]
        tag: Vec<u8>,
    },
    Data {
        epoch: String,
        sequence: u64,
        #[serde(with = "wire_bytes")]
        ciphertext: Vec<u8>,
    },
    Cancel {
        tx: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct Handshake {
    initiator: bool,
    phase: String,
    offer: Record,
    accept: Option<Record>,
    finish: Option<Record>,
    kem_secret: Option<PrivateBytes>,
    dh_secret: Option<Secret>,
    first_ephemeral: Option<Secret>,
    first_identity: Option<Secret>,
    last: Option<Record>,
}
impl Handshake {
    fn tx(&self) -> &str {
        match &self.offer {
            Record::Offer { tx, .. } => tx,
            _ => unreachable!(),
        }
    }
    fn erase_preparation(&mut self) {
        self.kem_secret = None;
        self.dh_secret = None;
        self.first_ephemeral = None;
        self.first_identity = None;
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct ReceiveChain {
    chain: Secret,
    next: u64,
    skipped: BTreeMap<u64, Secret>,
    floor: u64,
    committed_above_floor: BTreeSet<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Epoch {
    send_chain: Option<Secret>,
    send_sequence: u64,
    receive: ReceiveChain,
    send_control: Secret,
    receive_control: Secret,
    peer_final: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Outgoing {
    operation: String,
    epoch: String,
    sequence: u64,
    record: Record,
    acknowledged: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct PeerState {
    supported: bool,
    identity: Vec<u8>,
    trusted_fingerprint: Option<String>,
    first_message_seen: bool,
    auto_pending: bool,
    auto_consumed: bool,
    manual_only: bool,
    #[serde(default)]
    auto_skip_pending: bool,
    wanted: bool,
    manual_request: bool,
    refresh_requested: bool,
    handshake: Option<Handshake>,
    #[serde(default)]
    cancelled: Option<Record>,
    #[serde(default)]
    close_after_activation: bool,
    current: Option<String>,
    epochs: BTreeMap<String, Epoch>,
    outgoing: BTreeMap<u64, Outgoing>,
    retired: BTreeMap<String, Record>,
    close_phase: String,
    peer_close_final: Option<u64>,
    close_last: Option<Record>,
    closed_response: Option<Record>,
    error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    version: u8,
    owner: String,
    peers: BTreeMap<String, PeerState>,
    /// Explicit contact deletion quarantines protocol state instead of making
    /// it reachable from a later Tox friend-number reuse or same-key re-add.
    #[serde(default)]
    detached: BTreeMap<String, Vec<PeerState>>,
}
impl Default for Stored {
    fn default() -> Self {
        Self {
            version: WIRE_VERSION,
            owner: String::new(),
            peers: BTreeMap::new(),
            detached: BTreeMap::new(),
        }
    }
}
struct Partial {
    total: usize,
    parts: Vec<Option<Vec<u8>>>,
    created: Instant,
}
#[derive(Default)]
struct RuntimePeer {
    online: bool,
    was_online: bool,
    refresh_due: bool,
    last_attempt: Option<Instant>,
    identity_wait: Option<Instant>,
    last_capability: Option<Instant>,
    capability_identity_len: usize,
    send_attempts: BTreeMap<u64, Instant>,
}
struct ReceiveCommit {
    peer: String,
    epoch: String,
    sequence: u64,
    receive: ReceiveChain,
}
struct State {
    stored: Stored,
    identity: Option<Identity>,
    routes: HashMap<u32, String>,
    runtime: HashMap<String, RuntimePeer>,
    partials: HashMap<(String, String), Partial>,
    pending_receive: HashMap<(String, u64), ReceiveCommit>,
}
pub(super) struct Engine {
    path: PathBuf,
    identity_path: PathBuf,
    inner: Mutex<State>,
}

impl Engine {
    pub(super) fn new(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join("pq-sessions-v2.json");
        let identity_path = data_dir.join("pq-identity.json");
        let stored: Stored = if profiles::file_exists(&path) {
            serde_json::from_slice(&profiles::read_file(&path)?)
                .map_err(|_| "PQ_SAVED_STATE_INVALID")?
        } else {
            Stored::default()
        };
        if stored.version != WIRE_VERSION {
            return Err("PQ_SAVED_VERSION_UNSUPPORTED".into());
        }
        validate_stored(&stored)?;
        let identity = if profiles::file_exists(&identity_path) {
            Some(load_or_create_identity(&identity_path)?)
        } else {
            None
        };
        if identity.is_none()
            && stored.peers.values().any(|p| {
                !p.epochs.is_empty()
                    || p.handshake
                        .as_ref()
                        .is_some_and(|h| !matches!(h.phase.as_str(), "incoming" | "accept_pending"))
            })
        {
            return Err("PQ_IDENTITY_MISSING_FOR_SAVED_SESSION".into());
        }
        Ok(Self {
            path,
            identity_path,
            inner: Mutex::new(State {
                stored,
                identity,
                routes: HashMap::new(),
                runtime: HashMap::new(),
                partials: HashMap::new(),
                pending_receive: HashMap::new(),
            }),
        })
    }

    fn persist(&self, stored: &Stored) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(stored).map_err(|_| "PQ_STATE_ENCODE_FAILED")?;
        let result = profiles::write_file_checkpointed(&self.path, &bytes);
        crypto::wipe(&mut bytes);
        result
    }

    /// Publish a state transition only after the durable checkpoint succeeds.
    fn transaction<T>(
        &self,
        state: &mut State,
        operation: impl FnOnce(&mut Stored) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut next = state.stored.clone();
        let result = operation(&mut next)?;
        self.persist(&next)?;
        state.stored = next;
        Ok(result)
    }

    pub(super) fn bind(
        &self,
        friend: u32,
        key: &str,
        owner: &str,
        existing: bool,
    ) -> Result<(), String> {
        let key = normalized_key(key)?;
        let owner = normalized_key(owner)?;
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        if !s.stored.owner.is_empty() && s.stored.owner != owner {
            return Err("PQ_OWNER_MISMATCH".into());
        }
        if s.stored.owner.is_empty() || !s.stored.peers.contains_key(&key) {
            self.transaction(&mut s, |store| {
                store.owner = owner;
                store.peers.entry(key.clone()).or_insert_with(|| PeerState {
                    first_message_seen: existing,
                    auto_consumed: existing,
                    ..PeerState::default()
                });
                Ok(())
            })?;
        }
        let stored_active = s.stored.peers[&key].current.is_some();
        s.routes.insert(friend, key.clone());
        let runtime = s.runtime.entry(key).or_default();
        // A process restart is itself an offline interval. Remember it until
        // the first subsequent send asks for a refresh; the refresh still
        // cannot start until the peer is observed online by `drive`.
        if stored_active && !runtime.was_online {
            runtime.refresh_due = true;
        }
        Ok(())
    }

    pub(super) fn unbind(&self, friend: u32) {
        if let Ok(mut s) = self.inner.lock() {
            if let Some(key) = s.routes.remove(&friend) {
                s.runtime.remove(&key);
                s.partials.retain(|(peer, _), _| peer != &key);
            }
        }
    }

    /// Durably quarantine all cryptographic and ciphertext state for an
    /// explicitly deleted contact. A later bind of the same stable key sees
    /// only the inert replacement policy and cannot resume the archive.
    pub(super) fn detach(&self, friend: u32) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let archived_count = st.detached.values().try_fold(0usize, |total, peers| {
                total
                    .checked_add(peers.len())
                    .ok_or_else(|| "PQ_DETACHED_ARCHIVE_BACKPRESSURE".to_string())
            })?;
            if archived_count >= MAX_DETACHED_ARCHIVES {
                return Err("PQ_DETACHED_ARCHIVE_BACKPRESSURE".into());
            }
            let old = st.peers.remove(&key).ok_or("PQ_PEER_MISSING")?;
            let replacement = PeerState {
                supported: old.supported,
                identity: old.identity.clone(),
                trusted_fingerprint: old.trusted_fingerprint.clone(),
                first_message_seen: true,
                auto_consumed: true,
                manual_only: true,
                ..PeerState::default()
            };
            st.detached.entry(key.clone()).or_default().push(old);
            st.peers.insert(key.clone(), replacement);
            Ok(())
        })?;
        s.runtime.remove(&key);
        s.partials.retain(|(peer, _), _| peer != &key);
        s.pending_receive.retain(|(peer, _), _| peer != &key);
        Ok(())
    }
    pub(super) fn bound(&self, friend: u32, key: &str) -> bool {
        self.inner.lock().is_ok_and(|s| {
            s.routes
                .get(&friend)
                .is_some_and(|k| k.eq_ignore_ascii_case(key))
        })
    }
    pub(super) fn import_trust(&self, friend: u32, fingerprint: String) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        if s.stored.peers[&key].trusted_fingerprint.as_ref() == Some(&fingerprint) {
            return Ok(());
        }
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            if p.trusted_fingerprint
                .as_ref()
                .is_some_and(|old| old != &fingerprint)
            {
                return Err("PQ_TRUST_MIGRATION_MISMATCH".into());
            }
            p.trusted_fingerprint = Some(fingerprint);
            Ok(())
        })
    }

    pub(super) fn remap(&self, mapping: &HashMap<u32, u32>) {
        if let Ok(mut s) = self.inner.lock() {
            s.routes = std::mem::take(&mut s.routes)
                .into_iter()
                .filter_map(|(old, key)| mapping.get(&old).map(|new| (*new, key)))
                .collect();
        }
    }

    pub(super) fn capability(&self) -> Vec<Vec<u8>> {
        let identity = self
            .inner
            .lock()
            .ok()
            .and_then(|s| s.identity.as_ref().map(|i| i.public_key.clone()))
            .unwrap_or_default();
        packets(&Record::Capability { identity }).unwrap_or_default()
    }
    pub(super) fn has_identity(&self) -> bool {
        self.inner.lock().is_ok_and(|s| s.identity.is_some())
    }
    pub(super) fn has_durable_message(&self, id: &str) -> bool {
        self.inner.lock().is_ok_and(|s| {
            s.stored
                .peers
                .values()
                .any(|p| p.outgoing.values().any(|o| o.operation == id))
        })
    }
    pub(super) fn supported(&self, friend: u32) -> bool {
        self.inner
            .lock()
            .is_ok_and(|s| peer(&s, friend).is_some_and(|p| p.supported))
    }
    pub(super) fn owns(&self, friend: u32) -> bool {
        self.inner.lock().is_ok_and(|s| {
            peer(&s, friend)
                .is_some_and(|p| p.supported || p.auto_pending || p.wanted || p.current.is_some())
        })
    }

    pub(super) fn status(&self, friend: u32) -> PqStatus {
        let Ok(s) = self.inner.lock() else {
            return unavailable_status("PQ_STATE_LOCKED");
        };
        let p = peer(&s, friend);
        let waiting = s.identity.is_none()
            && p.is_some_and(|p| (p.supported || p.manual_request) && p.wanted);
        let changed = p.is_some_and(|p| {
            !p.identity.is_empty()
                && p.trusted_fingerprint
                    .as_ref()
                    .is_some_and(|trusted| *trusted != fingerprint(&p.identity))
        });
        let state = p
            .map(|p| {
                if !p.close_phase.is_empty() {
                    "closing"
                } else if p.current.is_some() {
                    "active"
                } else if let Some(h) = &p.handshake {
                    if h.phase == "incoming" {
                        "incoming_offer"
                    } else if h.initiator {
                        "offered"
                    } else {
                        "accepting"
                    }
                } else if p.wanted || p.auto_pending {
                    "accepting"
                } else if p.error.is_some() {
                    "error"
                } else if p.supported {
                    "available"
                } else {
                    "unavailable"
                }
            })
            .unwrap_or("unavailable");
        PqStatus {
            supported: p.is_some_and(|p| p.supported),
            state: state.into(),
            local_fingerprint: s
                .identity
                .as_ref()
                .map(|i| i.fingerprint.clone())
                .unwrap_or_default(),
            peer_fingerprint: p
                .filter(|p| !p.identity.is_empty())
                .map(|p| fingerprint(&p.identity)),
            fingerprint_changed: changed,
            error: p.and_then(|p| p.error.clone()),
            identity_needs_entropy: s.identity.is_none(),
            identity_waiting: waiting,
            auto_pending: p.is_some_and(|p| p.auto_pending),
            protocol_version: WIRE_VERSION,
        }
    }

    pub(super) fn complete_identity(&self, noise: &[u8]) -> Result<(), String> {
        if !noise.is_empty() && noise.len() != 32 {
            return Err("PQ_NOISE_DIGEST_INVALID".into());
        }
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        if s.identity.is_some() {
            return Ok(());
        }
        if !s.stored.peers.values().any(|p| p.wanted) {
            return Err("PQ_IDENTITY_NOT_REQUESTED".into());
        }
        let (public_key, secret_key) = crypto::identity_keypair(noise)?;
        let identity = Identity {
            fingerprint: fingerprint(&public_key),
            public_key,
            secret_key,
        };
        let stored = StoredIdentity {
            version: VERSION,
            algorithm: "ML-KEM-768".into(),
            secret_key_hex: encode_hex(&identity.secret_key),
        };
        let mut bytes = serde_json::to_vec(&stored).map_err(|_| "PQ_IDENTITY_ENCODE_FAILED")?;
        let result = profiles::write_file_checkpointed(&self.identity_path, &bytes);
        crypto::wipe(&mut bytes);
        result?;
        s.identity = Some(identity);
        for r in s.runtime.values_mut() {
            r.identity_wait = None;
            r.last_attempt = None;
        }
        Ok(())
    }

    /// The first durable send consumes eligibility independently of chat history.
    /// An offline first send can remain a probe until capability discovery.
    pub(super) fn first_send(&self, friend: u32) -> Result<bool, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        let refresh_due = s
            .runtime
            .get(&key)
            .is_some_and(|r| r.refresh_due || !r.online);
        let needed = s.stored.peers.get(&key).is_some_and(|p| {
            !p.first_message_seen
                || (p.current.is_some()
                    && refresh_due
                    && !p.refresh_requested
                    && p.close_phase.is_empty())
        });
        if needed {
            self.transaction(&mut s, |st| {
                let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
                if !p.first_message_seen {
                    p.first_message_seen = true;
                    if !p.manual_only && !p.auto_consumed {
                        p.auto_pending = true;
                        p.wanted = true;
                    }
                }
                if p.current.is_some() && refresh_due && p.close_phase.is_empty() {
                    p.refresh_requested = true;
                }
                Ok(())
            })?;
        }
        Ok(peer(&s, friend).is_some_and(|p| {
            p.current.is_some() && matches!(p.close_phase.as_str(), "" | "pending" | "draining")
                || p.auto_pending
                || p.wanted && p.close_phase.is_empty()
        }))
    }

    pub(super) fn skip_auto(&self, friend: u32) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            if p.auto_skip_pending {
                return Ok(());
            }
            if p.manual_only && !p.wanted && p.current.is_none() && p.handshake.is_none() {
                if !p.auto_pending {
                    return Ok(());
                }
            }
            if p.handshake.is_some() || p.current.is_some() || !p.auto_pending {
                return Err("PQ_AUTO_ALREADY_NEGOTIATING".into());
            }
            p.wanted = false;
            p.auto_pending = false;
            p.auto_consumed = true;
            p.manual_only = true;
            p.auto_skip_pending = true;
            p.cancelled = None;
            Ok(())
        })
    }
    pub(super) fn auto_skip_pending(&self, friend: u32) -> bool {
        self.inner
            .lock()
            .is_ok_and(|s| peer(&s, friend).is_some_and(|p| p.auto_skip_pending))
    }
    pub(super) fn finish_auto_skip(&self, friend: u32) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            p.auto_skip_pending = false;
            p.error = None;
            Ok(())
        })
    }
    pub(super) fn request_identity_only(&self, friend: u32) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            if p.auto_skip_pending {
                return Err("PQ_SESSION_WAIT".into());
            }
            p.wanted = true;
            p.manual_request = true;
            p.auto_consumed = true;
            p.auto_pending = false;
            p.error = None;
            Ok(())
        })
    }
    pub(super) fn legacy_request_pending(&self, friend: u32) -> bool {
        self.inner.lock().is_ok_and(|s| {
            peer(&s, friend).is_some_and(|p| {
                p.manual_request && p.wanted && !p.supported && p.current.is_none()
            })
        })
    }
    pub(super) fn finish_legacy_request(&self, friend: u32) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            p.wanted = false;
            p.manual_request = false;
            p.cancelled = None;
            Ok(())
        })
    }
    pub(super) fn latch_manual_only(&self, friend: u32) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            p.manual_only = true;
            p.auto_consumed = true;
            p.auto_pending = false;
            p.wanted = false;
            p.manual_request = false;
            p.cancelled = None;
            Ok(())
        })
    }
    pub(super) fn holds_plaintext(&self, friend: u32) -> bool {
        self.inner.lock().is_ok_and(|s| {
            peer(&s, friend).is_some_and(|p| {
                p.current.is_some()
                    || p.wanted
                    || p.auto_skip_pending
                    || p.auto_pending && p.supported
                    || !p.close_phase.is_empty()
            })
        })
    }
    pub(super) fn encrypts(&self, friend: u32) -> bool {
        self.inner.lock().is_ok_and(|s| {
            peer(&s, friend).is_some_and(|p| {
                p.current.is_some() && matches!(p.close_phase.as_str(), "" | "pending" | "draining")
            })
        })
    }

    pub(super) fn request(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            if !p.supported {
                return Err("PQ_V2_CAPABILITY_REQUIRED".into());
            }
            if p.auto_skip_pending {
                return Err("PQ_SESSION_WAIT".into());
            }
            if p.current.is_some() || !p.close_phase.is_empty() {
                return Err("PQ_ALREADY_ACTIVE".into());
            }
            p.wanted = true;
            p.manual_request = true;
            p.auto_consumed = true;
            p.auto_pending = false;
            p.error = None;
            Ok(())
        })?;
        Ok(Vec::new())
    }
    pub(super) fn accept(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            let h = p.handshake.as_mut().ok_or("PQ_NO_OFFER")?;
            if h.phase != "incoming" {
                return Err("PQ_NO_OFFER".into());
            }
            h.phase = "accept_pending".into();
            p.wanted = true;
            Ok(())
        })?;
        Ok(Vec::new())
    }
    pub(super) fn cancel(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        let record = self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            if p.current.is_some() {
                return Err("PQ_ACTIVE_USE_SHUTDOWN".into());
            }
            let prepared = p.handshake.as_ref().is_some_and(|h| h.phase == "prepared");
            if prepared {
                // Either peer may already possess the same prepared epoch.
                // Finish the authenticated activation, then use the ordinary
                // bilateral drain/close protocol instead of orphaning keys.
                p.close_after_activation = true;
                p.manual_only = true;
                p.auto_consumed = true;
                p.auto_pending = false;
                p.manual_request = false;
                p.wanted = false;
                p.error = Some("PQ_CANCEL_DEFERRED_UNTIL_SAFE_CLOSE".into());
                return Ok(None);
            }
            let automatic = p
                .handshake
                .as_ref()
                .and_then(handshake_automatic)
                .unwrap_or(p.auto_pending && !p.manual_request);
            let decision_wait = automatic && p.first_message_seen && p.auto_pending;
            let tx = p.handshake.as_ref().map(|h| h.tx().to_owned());
            let cancel = tx.map(|tx| Record::Cancel { tx });
            p.handshake = None;
            p.close_after_activation = false;
            p.manual_only = true;
            p.auto_consumed = true;
            // An automatic first message remains fenced until the local user
            // explicitly retries PQ or chooses plaintext conversion.
            p.auto_pending = decision_wait;
            p.wanted = false;
            p.manual_request = false;
            p.refresh_requested = false;
            p.cancelled = cancel.clone();
            p.error = Some("PQ_NEGOTIATION_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ".into());
            Ok(cancel)
        })?;
        record
            .as_ref()
            .map(packets)
            .transpose()
            .map(Option::unwrap_or_default)
    }

    pub(super) fn shutdown(&self, friend: u32) -> Result<Vec<Vec<u8>>, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        let record = self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            let id = p.current.clone().ok_or("PQ_NOT_ACTIVE")?;
            if !p.close_phase.is_empty() {
                return Ok(p.close_last.clone());
            }
            p.manual_only = true;
            p.auto_consumed = true;
            p.auto_pending = false;
            p.wanted = false;
            p.refresh_requested = false;
            if p.handshake.as_ref().is_some_and(|h| h.phase != "done") {
                p.close_phase = "pending".into();
                return Ok(None);
            }
            p.close_phase = "draining".into();
            let record = signal(&id, "close", 0, &p.epochs[&id].send_control.0);
            p.close_last = Some(record.clone());
            Ok(Some(record))
        })?;
        record
            .as_ref()
            .map(packets)
            .transpose()
            .map(Option::unwrap_or_default)
    }

    /// Called by the native network loop, never by a UI timer. An offline peer
    /// cannot create, activate, retire, or close an epoch here.
    pub(super) fn drive(
        &self,
        friend: u32,
        online: bool,
        external_drained: bool,
    ) -> Result<Vec<Vec<u8>>, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        let now = Instant::now();
        let r = s.runtime.entry(key.clone()).or_default();
        if !online && r.was_online {
            r.refresh_due = true;
        }
        r.online = online;
        r.was_online |= online;
        if !online {
            r.last_attempt = None;
            r.last_capability = None;
            r.send_attempts.clear();
            return Ok(Vec::new());
        }
        if r.last_attempt
            .is_some_and(|last| now.duration_since(last) < RETRY)
        {
            return Ok(Vec::new());
        }
        r.last_attempt = Some(now);
        let needs_identity = s.identity.is_none()
            && s.stored
                .peers
                .get(&key)
                .is_some_and(|p| (p.supported || p.manual_request) && p.wanted);
        if needs_identity {
            let r = s.runtime.entry(key.clone()).or_default();
            let began = r.identity_wait.get_or_insert(now);
            if now.duration_since(*began) < Duration::from_secs(5) {
                return Ok(self.capability_locked(&s));
            }
            drop(s);
            self.complete_identity(&[])?;
            return self.drive_after_identity(friend, external_drained);
        }
        self.drive_locked(&mut s, &key, external_drained)
    }
    fn drive_after_identity(
        &self,
        friend: u32,
        external_drained: bool,
    ) -> Result<Vec<Vec<u8>>, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        self.drive_locked(&mut s, &key, external_drained)
    }
    fn capability_locked(&self, s: &State) -> Vec<Vec<u8>> {
        packets(&Record::Capability {
            identity: s
                .identity
                .as_ref()
                .map(|i| i.public_key.clone())
                .unwrap_or_default(),
        })
        .unwrap_or_default()
    }
    fn drive_locked(
        &self,
        s: &mut State,
        key: &str,
        external_drained: bool,
    ) -> Result<Vec<Vec<u8>>, String> {
        let mut records = Vec::new();
        // Public capability also wakes a peer whose first probe preceded ours.
        let now = Instant::now();
        let public_len = s.identity.as_ref().map_or(0, |i| i.public_key.len());
        let supported = s.stored.peers[key].supported;
        let runtime = s.runtime.entry(key.into()).or_default();
        let announce = runtime.last_capability.is_none()
            || runtime.capability_identity_len != public_len
            || !supported
                && runtime
                    .last_capability
                    .is_some_and(|last| now.duration_since(last) >= DATA_RETRY);
        if announce {
            runtime.last_capability = Some(now);
            runtime.capability_identity_len = public_len;
        }
        let mut result = if announce {
            self.capability_locked(s)
        } else {
            Vec::new()
        };
        // Cancellation has no separate acknowledgement. Keep the last exact
        // tombstone on the wire until a different valid transaction proves
        // the peer has moved on. It precedes any replacement OFFER.
        if let Some(cancelled) = &s.stored.peers[key].cancelled {
            result.extend(packets(cancelled)?);
        }
        let Some(identity) = s.identity.as_ref() else {
            return Ok(result);
        };
        let identity_public = identity.public_key.clone();
        let p = s.stored.peers.get(key).ok_or("PQ_PEER_MISSING")?;
        let start = p.supported && p.wanted && p.current.is_none() && p.handshake.is_none();
        let refresh = p.current.is_some()
            && p.refresh_requested
            && p.close_phase.is_empty()
            && p.epochs.len() < 2
            && p.handshake.as_ref().is_none_or(|h| h.phase == "done");
        let coordinator = s.stored.owner.as_str() < key;
        if start || refresh && coordinator {
            let h = new_offer(
                &s.stored.owner,
                key,
                &identity_public,
                p,
                start && !p.manual_request,
            )?;
            let offer = h.offer.clone();
            self.transaction(s, |st| {
                let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                p.handshake = Some(h);
                p.error = None;
                p.refresh_requested = false;
                Ok(())
            })?;
            records.push(offer);
        } else if refresh {
            let p = &s.stored.peers[key];
            let id = p.current.as_ref().ok_or("PQ_NOT_ACTIVE")?;
            records.push(signal(id, "refresh", 0, &p.epochs[id].send_control.0));
        }
        let pending = s.stored.peers[key]
            .handshake
            .as_ref()
            .is_some_and(|h| h.phase == "accept_pending");
        if pending {
            let identity = s.identity.as_ref().ok_or("PQ_IDENTITY_WAIT")?;
            let mut h = s.stored.peers[key].handshake.clone().ok_or("PQ_NO_OFFER")?;
            let record = prepare_accept(&mut h, identity)?;
            self.transaction(s, |st| {
                st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?.handshake = Some(h);
                Ok(())
            })?;
            records.push(record);
        }
        if let Some(h) = &s.stored.peers[key].handshake {
            if h.phase != "done" {
                if let Some(last) = &h.last {
                    if !records.contains(last) {
                        records.push(last.clone());
                    }
                }
            }
        }
        let p = &s.stored.peers[key];
        if !p.close_phase.is_empty() {
            self.drive_close(s, key, external_drained, &mut records)?;
        }
        self.drive_retirement(s, key, &mut records)?;
        let runtime = s.runtime.entry(key.into()).or_default();
        runtime.send_attempts.retain(|wire, _| {
            s.stored.peers[key]
                .outgoing
                .get(wire)
                .is_some_and(|o| !o.acknowledged)
        });
        for (wire, outgoing) in s.stored.peers[key]
            .outgoing
            .iter()
            .filter(|(_, o)| !o.acknowledged)
        {
            if runtime
                .send_attempts
                .get(wire)
                .is_none_or(|last| now.duration_since(*last) >= DATA_RETRY)
            {
                records.push(outgoing.record.clone());
                runtime.send_attempts.insert(*wire, now);
            }
        }
        for record in records {
            result.extend(packets(&record)?);
        }
        Ok(result)
    }

    pub(super) fn encrypt(
        &self,
        friend: u32,
        operation: &str,
        text: &str,
    ) -> Result<EncryptedMessage, String> {
        if text.len() > MAX_TEXT || operation.len() > 256 {
            return Err("PQ_MESSAGE_LIMIT".into());
        }
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        let p = &s.stored.peers[&key];
        if let Some((id, _old)) = p.outgoing.iter().find(|(_, o)| o.operation == operation) {
            return Ok(EncryptedMessage {
                wire_id: *id,
                // The native drive loop retries the exact durable record at a
                // bounded rate; a composer/outbox poll must not flood toxcore.
                packets: Vec::new(),
            });
        }
        if !matches!(p.close_phase.as_str(), "" | "pending" | "draining") {
            return Err("PQ_CLOSE_DRAIN_WAIT".into());
        }
        if p.outgoing.len() >= MAX_OUTGOING
            || p.outgoing
                .values()
                .map(|o| match &o.record {
                    Record::Data { ciphertext, .. } => ciphertext.len(),
                    _ => 0,
                })
                .sum::<usize>()
                + text.len()
                > MAX_OUTGOING_BYTES
        {
            return Err("PQ_OUTBOX_BACKPRESSURE".into());
        }
        let epoch_id = p.current.clone().ok_or("PQ_SESSION_WAIT")?;
        let epoch = p.epochs.get(&epoch_id).ok_or("PQ_EPOCH_MISSING")?;
        let sequence = epoch
            .send_sequence
            .checked_add(1)
            .ok_or("PQ_SEQUENCE_EXHAUSTED")?;
        let chain = epoch.send_chain.as_ref().ok_or("PQ_EPOCH_SEALED")?;
        let (mut message_key, next) = ratchet(&chain.0);
        let aad = aad(&epoch_id, sequence, text.len());
        let encrypted = aes_gcm_encrypt(
            &message_key,
            &message_nonce(&epoch_id, sequence),
            &aad,
            text.as_bytes(),
        );
        crypto::wipe(&mut message_key);
        let record = Record::Data {
            epoch: epoch_id.clone(),
            sequence,
            ciphertext: encrypted?,
        };
        let wire_id = wire_id(&epoch_id, sequence);
        let output = packets(&record)?;
        self.transaction(&mut s, |st| {
            let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
            if p.outgoing.contains_key(&wire_id) {
                return Err("PQ_WIRE_ID_COLLISION".into());
            }
            let e = p.epochs.get_mut(&epoch_id).ok_or("PQ_EPOCH_MISSING")?;
            e.send_chain = Some(Secret(next));
            e.send_sequence = sequence;
            p.outgoing.insert(
                wire_id,
                Outgoing {
                    operation: operation.into(),
                    epoch: epoch_id,
                    sequence,
                    record,
                    acknowledged: false,
                },
            );
            Ok(())
        })?;
        s.runtime
            .entry(key)
            .or_default()
            .send_attempts
            .insert(wire_id, Instant::now());
        Ok(EncryptedMessage {
            wire_id,
            packets: output,
        })
    }

    pub(super) fn delivered(&self, friend: u32) -> Vec<(u64, String)> {
        self.inner
            .lock()
            .ok()
            .and_then(|s| {
                peer(&s, friend).map(|p| {
                    p.outgoing
                        .iter()
                        .filter(|(_, o)| o.acknowledged)
                        .map(|(id, o)| (*id, o.operation.clone()))
                        .collect()
                })
            })
            .unwrap_or_default()
    }
    pub(super) fn forget_delivered(&self, friend: u32, wire: u64) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        if s.stored.peers[&key]
            .outgoing
            .get(&wire)
            .is_some_and(|o| o.acknowledged)
        {
            self.transaction(&mut s, |st| {
                st.peers
                    .get_mut(&key)
                    .ok_or("PQ_PEER_MISSING")?
                    .outgoing
                    .remove(&wire);
                Ok(())
            })?;
        }
        Ok(())
    }

    pub(super) fn handle(&self, friend: u32, bytes: &[u8]) -> Result<PacketResult, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        let Some(record) = reassemble(&mut s, &key, bytes)? else {
            return Ok(empty_result());
        };
        let mut result = empty_result();
        match record {
            Record::Capability { identity } => {
                if !identity.is_empty() && identity.len() != MLKEM_PUBLIC_KEY_BYTES {
                    return Err("PQ_CAPABILITY_INVALID".into());
                }
                let p = &s.stored.peers[&key];
                if !p.supported || !identity.is_empty() && p.identity != identity {
                    self.transaction(&mut s, |st| {
                        let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
                        p.supported = true;
                        if !identity.is_empty() {
                            if p.trusted_fingerprint
                                .as_ref()
                                .is_some_and(|f| *f != fingerprint(&identity))
                            {
                                p.error = Some("PQ_CONTACT_IDENTITY_CHANGED".into());
                                // Keep all old decryption material and queued ciphertext.
                                return Ok(());
                            }
                            p.identity = identity;
                        }
                        if p.auto_pending && !p.manual_only {
                            p.wanted = true;
                        }
                        Ok(())
                    })?;
                }
            }
            offer @ Record::Offer { .. } => self.receive_offer(&mut s, &key, offer, &mut result)?,
            accept @ Record::Accept { .. } => {
                self.receive_accept(&mut s, &key, accept, &mut result)?
            }
            finish @ Record::Finish { .. } => {
                self.receive_finish(&mut s, &key, finish, &mut result)?
            }
            Record::Data {
                epoch,
                sequence,
                ciphertext,
            } => {
                let p = &s.stored.peers[&key];
                let e = p.epochs.get(&epoch).ok_or("PQ_EPOCH_WAIT")?;
                if sequence == 0 {
                    return Err("PQ_SEQUENCE_INVALID".into());
                }
                let wire = wire_id(&epoch, sequence);
                if sequence <= e.receive.floor
                    || e.receive.committed_above_floor.contains(&sequence)
                {
                    result.outgoing = packets(&signal(&epoch, "ack", sequence, &e.send_control.0))?;
                    return Ok(result);
                }
                // A staged receive chain is only a candidate until the
                // application durably commits its plaintext/dedup row. Do not
                // derive another candidate from the older committed chain: two
                // independently staged snapshots could otherwise be committed
                // out of order and roll the ratchet backwards. The sender keeps
                // the exact ciphertext and will retry after this one settles.
                if s.pending_receive.keys().any(|(peer, _)| peer == &key) {
                    return Ok(result);
                }
                if ciphertext.len() < 16 || ciphertext.len() > MAX_TEXT + 16 {
                    return Err("PQ_CIPHERTEXT_INVALID".into());
                }
                let (mut message_key, advanced) = receive_key(&e.receive, sequence)?;
                let plaintext = aes_gcm_decrypt(
                    &message_key,
                    &message_nonce(&epoch, sequence),
                    &aad(&epoch, sequence, ciphertext.len() - 16),
                    &ciphertext,
                );
                crypto::wipe(&mut message_key);
                let plaintext = match String::from_utf8(plaintext?) {
                    Ok(text) => text,
                    Err(error) => {
                        let mut bytes = error.into_bytes();
                        crypto::wipe(&mut bytes);
                        return Err("PQ_TEXT_INVALID_UTF8".into());
                    }
                };
                s.pending_receive.insert(
                    (key.clone(), wire),
                    ReceiveCommit {
                        peer: key,
                        epoch,
                        sequence,
                        receive: advanced,
                    },
                );
                result.received_text = Some(plaintext);
                result.received_wire_id = Some(wire);
            }
            Record::Signal {
                epoch,
                action,
                sequence,
                tag,
            } => self.receive_signal(&mut s, &key, &epoch, &action, sequence, &tag, &mut result)?,
            Record::Cancel { tx } => {
                if decode_hex(&tx)?.len() != 16 {
                    return Err("PQ_CANCEL_INVALID".into());
                }
                let p = &s.stored.peers[&key];
                if p.current.is_some() {
                    return Ok(result);
                }
                let Some(h) = p.handshake.clone().filter(|h| h.tx() == tx) else {
                    return Ok(result);
                };
                let automatic = handshake_automatic(&h).unwrap_or(false);
                let decision_wait = automatic && p.first_message_seen && p.auto_pending;
                if !h.initiator && h.phase == "prepared" {
                    // The initiator may already have activated and emitted
                    // DATA. Keep the prepared responder epoch, complete the
                    // authenticated exchange, then drain and close it.
                    self.transaction(&mut s, |st| {
                        let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
                        p.close_after_activation = true;
                        p.manual_only = true;
                        p.auto_consumed = true;
                        p.auto_pending = false;
                        p.manual_request = false;
                        p.wanted = false;
                        p.error = Some("PQ_CANCEL_DEFERRED_UNTIL_SAFE_CLOSE".into());
                        Ok(())
                    })?;
                } else {
                    self.transaction(&mut s, |st| {
                        let p = st.peers.get_mut(&key).ok_or("PQ_PEER_MISSING")?;
                        // An initiator receiving CANCEL while prepared knows
                        // the responder cancelled before accepting FINISH, so
                        // this never-active epoch can be discarded safely.
                        if h.initiator && h.phase == "prepared" {
                            p.epochs.remove(&tx);
                        }
                        p.handshake = None;
                        p.cancelled = Some(Record::Cancel { tx: tx.clone() });
                        p.close_after_activation = false;
                        p.wanted = false;
                        p.auto_pending = decision_wait;
                        p.auto_consumed = true;
                        p.manual_only = true;
                        p.manual_request = false;
                        p.refresh_requested = false;
                        p.error = Some("PQ_PEER_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ".into());
                        Ok(())
                    })?;
                }
                result.session_event = Some(PqSessionEvent::Rejected);
            }
        }
        Ok(result)
    }

    /// The application has already committed plaintext / dedup state. Only now
    /// may the receive chain advance and a receipt become eligible to transmit.
    pub(super) fn commit_received(&self, friend: u32, wire: u64) -> Result<Vec<Vec<u8>>, String> {
        let mut s = self.inner.lock().map_err(|_| "PQ_STATE_LOCKED")?;
        let key = route(&s, friend)?;
        let staged = s
            .pending_receive
            .remove(&(key.clone(), wire))
            .ok_or("PQ_RECEIVE_COMMIT_MISSING")?;
        if staged.peer != key {
            return Err("PQ_RECEIVE_OWNER_MISMATCH".into());
        }
        let record = self.transaction(&mut s, |st| {
            let e = st
                .peers
                .get_mut(&key)
                .ok_or("PQ_PEER_MISSING")?
                .epochs
                .get_mut(&staged.epoch)
                .ok_or("PQ_EPOCH_MISSING")?;
            e.receive = staged.receive;
            e.receive.committed_above_floor.insert(staged.sequence);
            while e.receive.floor < u64::MAX
                && e.receive
                    .committed_above_floor
                    .remove(&(e.receive.floor + 1))
            {
                e.receive.floor += 1;
            }
            Ok(signal(
                &staged.epoch,
                "ack",
                staged.sequence,
                &e.send_control.0,
            ))
        })?;
        packets(&record)
    }

    pub(super) fn discard_received(&self, friend: u32, wire: u64) {
        if let Ok(mut s) = self.inner.lock() {
            if let Ok(key) = route(&s, friend) {
                // Drop wipes all staged message/chain keys. A valid retry can
                // derive them again from the still-committed receive state.
                s.pending_receive.remove(&(key, wire));
            }
        }
    }

    fn receive_offer(
        &self,
        s: &mut State,
        key: &str,
        offer: Record,
        result: &mut PacketResult,
    ) -> Result<(), String> {
        let Record::Offer {
            tx,
            parent,
            automatic,
            initiator,
            responder,
            identity,
            kem,
            ..
        } = &offer
        else {
            unreachable!()
        };
        if cancelled_tx(&s.stored.peers[key]) == Some(tx.as_str()) {
            result.outgoing = packets(
                s.stored.peers[key]
                    .cancelled
                    .as_ref()
                    .ok_or("PQ_CANCEL_RECORD_MISSING")?,
            )?;
            return Ok(());
        }
        if decode_hex(tx)?.len() != 16
            || initiator != key
            || responder != &s.stored.owner
            || identity.len() != MLKEM_PUBLIC_KEY_BYTES
            || kem.len() != MLKEM_PUBLIC_KEY_BYTES
        {
            return Err("PQ_OFFER_INVALID".into());
        }
        let p = &s.stored.peers[key];
        if p.trusted_fingerprint
            .as_ref()
            .is_some_and(|f| *f != fingerprint(identity))
        {
            return Err("PQ_CONTACT_IDENTITY_CHANGED".into());
        }
        if *automatic && p.manual_only {
            result.outgoing = packets(&Record::Cancel { tx: tx.clone() })?;
            return Ok(());
        }
        if parent != &p.current || !p.close_phase.is_empty() || p.epochs.len() >= 2 {
            return Err("PQ_OFFER_PARENT_WAIT".into());
        }
        if let Some(h) = &p.handshake {
            if h.tx() == tx {
                if h.offer != offer {
                    return Err("PQ_TRANSACTION_REUSED".into());
                }
                if let Some(last) = &h.last {
                    result.outgoing = packets(last)?;
                }
                return Ok(());
            }
            if h.phase != "done" && (s.stored.owner.as_str() < key || !h.initiator) {
                return Ok(());
            }
        }
        let auto_accept = *automatic && !p.manual_only || parent.is_some();
        let phase = if auto_accept {
            "accept_pending"
        } else {
            "incoming"
        };
        let identity = identity.clone();
        let h = Handshake {
            initiator: false,
            phase: phase.into(),
            offer,
            accept: None,
            finish: None,
            kem_secret: None,
            dh_secret: None,
            first_ephemeral: None,
            first_identity: None,
            last: None,
        };
        self.transaction(s, |st| {
            let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
            p.supported = true;
            p.identity = identity;
            p.handshake = Some(h);
            p.cancelled = None;
            p.close_after_activation = false;
            p.wanted |= auto_accept;
            p.auto_pending |= auto_accept && p.current.is_none();
            p.refresh_requested = false;
            p.error = None;
            Ok(())
        })?;
        if !auto_accept {
            result.session_event = Some(PqSessionEvent::OfferReceived);
        }
        if let Some(r) = s.runtime.get_mut(key) {
            r.last_attempt = None;
        }
        Ok(())
    }

    fn receive_accept(
        &self,
        s: &mut State,
        key: &str,
        accept: Record,
        result: &mut PacketResult,
    ) -> Result<(), String> {
        let Record::Accept {
            tx,
            identity,
            kem,
            dh,
            ct_ephemeral,
            ct_identity,
        } = &accept
        else {
            unreachable!()
        };
        if cancelled_tx(&s.stored.peers[key]) == Some(tx.as_str()) {
            result.outgoing = packets(
                s.stored.peers[key]
                    .cancelled
                    .as_ref()
                    .ok_or("PQ_CANCEL_RECORD_MISSING")?,
            )?;
            return Ok(());
        }
        let Some(mut h) = s.stored.peers[key].handshake.clone() else {
            return Ok(());
        };
        if h.tx() != tx || !h.initiator {
            return Ok(());
        }
        if let Some(old) = &h.accept {
            if old != &accept {
                return Err("PQ_TRANSCRIPT_CHANGED".into());
            }
            if let Some(last) = &h.last {
                result.outgoing = packets(last)?;
            }
            return Ok(());
        }
        if h.phase != "offered"
            || identity.len() != MLKEM_PUBLIC_KEY_BYTES
            || kem.len() != MLKEM_PUBLIC_KEY_BYTES
        {
            return Err("PQ_ACCEPT_INVALID".into());
        }
        let p = &s.stored.peers[key];
        if !p.identity.is_empty() && p.identity != *identity
            || p.trusted_fingerprint
                .as_ref()
                .is_some_and(|f| *f != fingerprint(identity))
        {
            return Err("PQ_CONTACT_IDENTITY_CHANGED".into());
        }
        let own = s.identity.as_ref().ok_or("PQ_IDENTITY_WAIT")?;
        let a = Secret(mlkem_decaps(
            &h.kem_secret
                .as_ref()
                .ok_or("PQ_HANDSHAKE_SECRET_MISSING")?
                .0,
            ct_ephemeral,
        )?);
        let b = Secret(mlkem_decaps(&own.secret_key, ct_identity)?);
        let (ct_e, c) = mlkem_encaps(kem)?;
        let c = Secret(c);
        let (ct_i, d) = mlkem_encaps(identity)?;
        let d = Secret(d);
        let x = Secret(crypto::x25519(
            &h.dh_secret.as_ref().ok_or("PQ_HANDSHAKE_SECRET_MISSING")?.0,
            dh,
        )?);
        let mut finish = Record::Finish {
            tx: tx.clone(),
            ct_ephemeral: ct_e,
            ct_identity: ct_i,
            tag: Vec::new(),
        };
        let epoch = derive_epoch(
            &h.offer,
            &accept,
            &finish,
            [&a.0, &b.0, &c.0, &d.0, &x.0],
            true,
        )?;
        let confirmation =
            transcript_mac(&epoch.send_control.0, b"finish", &h.offer, &accept, &finish)?;
        if let Record::Finish { tag, .. } = &mut finish {
            *tag = confirmation;
        }
        let tx = tx.clone();
        let peer_identity = identity.clone();
        h.accept = Some(accept);
        h.finish = Some(finish.clone());
        h.last = Some(finish.clone());
        h.phase = "prepared".into();
        h.erase_preparation();
        self.transaction(s, |st| {
            let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
            p.identity = peer_identity;
            p.epochs.insert(tx, epoch);
            p.handshake = Some(h);
            p.cancelled = None;
            Ok(())
        })?;
        result.outgoing = packets(&finish)?;
        Ok(())
    }

    fn receive_finish(
        &self,
        s: &mut State,
        key: &str,
        finish: Record,
        result: &mut PacketResult,
    ) -> Result<(), String> {
        let Record::Finish {
            tx,
            ct_ephemeral,
            ct_identity,
            tag,
        } = &finish
        else {
            unreachable!()
        };
        if cancelled_tx(&s.stored.peers[key]) == Some(tx.as_str()) {
            result.outgoing = packets(
                s.stored.peers[key]
                    .cancelled
                    .as_ref()
                    .ok_or("PQ_CANCEL_RECORD_MISSING")?,
            )?;
            return Ok(());
        }
        let Some(mut h) = s.stored.peers[key].handshake.clone() else {
            return Ok(());
        };
        if h.tx() != tx || h.initiator {
            return Ok(());
        }
        if let Some(old) = &h.finish {
            if old != &finish {
                return Err("PQ_TRANSCRIPT_CHANGED".into());
            }
            if let Some(last) = &h.last {
                result.outgoing = packets(last)?;
            }
            return Ok(());
        }
        if h.phase != "accepting" {
            return Err("PQ_FINISH_WAIT".into());
        }
        let accept = h.accept.as_ref().ok_or("PQ_ACCEPT_MISSING")?;
        let Record::Offer { dh, .. } = &h.offer else {
            unreachable!()
        };
        let own = s.identity.as_ref().ok_or("PQ_IDENTITY_WAIT")?;
        let c = Secret(mlkem_decaps(
            &h.kem_secret
                .as_ref()
                .ok_or("PQ_HANDSHAKE_SECRET_MISSING")?
                .0,
            ct_ephemeral,
        )?);
        let d = Secret(mlkem_decaps(&own.secret_key, ct_identity)?);
        let x = Secret(crypto::x25519(
            &h.dh_secret.as_ref().ok_or("PQ_HANDSHAKE_SECRET_MISSING")?.0,
            dh,
        )?);
        let epoch = derive_epoch(
            &h.offer,
            accept,
            &finish_without_tag(&finish),
            [
                &h.first_ephemeral
                    .as_ref()
                    .ok_or("PQ_HANDSHAKE_SECRET_MISSING")?
                    .0,
                &h.first_identity
                    .as_ref()
                    .ok_or("PQ_HANDSHAKE_SECRET_MISSING")?
                    .0,
                &c.0,
                &d.0,
                &x.0,
            ],
            false,
        )?;
        let expected = transcript_mac(
            &epoch.receive_control.0,
            b"finish",
            &h.offer,
            accept,
            &finish_without_tag(&finish),
        )?;
        if !constant_time_eq(tag, &expected) {
            return Err("PQ_CONFIRMATION_INVALID".into());
        }
        let ready = signal(tx, "ready", 0, &epoch.send_control.0);
        h.finish = Some(finish.clone());
        h.last = Some(ready.clone());
        h.phase = "prepared".into();
        h.erase_preparation();
        let tx = tx.clone();
        self.transaction(s, |st| {
            let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
            p.epochs.insert(tx, epoch);
            p.handshake = Some(h);
            Ok(())
        })?;
        result.outgoing = packets(&ready)?;
        Ok(())
    }

    fn receive_signal(
        &self,
        s: &mut State,
        key: &str,
        id: &str,
        action: &str,
        sequence: u64,
        tag: &[u8],
        result: &mut PacketResult,
    ) -> Result<(), String> {
        let p = &s.stored.peers[key];
        let Some(epoch) = p.epochs.get(id) else {
            if action == "retire" {
                if let Some(record) = p.retired.get(id) {
                    result.outgoing = packets(record)?;
                }
            }
            if matches!(action, "close_commit" | "close_ready" | "close") {
                if let Some(record) = &p.closed_response {
                    result.outgoing = packets(record)?;
                }
            }
            return Ok(());
        };
        if !constant_time_eq(
            tag,
            &signal_tag(&epoch.receive_control.0, id, action, sequence),
        ) {
            return Err("PQ_SIGNAL_AUTHENTICATION_FAILED".into());
        }
        let response = match action {
            "ready" | "commit" | "done" => {
                let mut h = p.handshake.clone().ok_or("PQ_HANDSHAKE_MISSING")?;
                if h.tx() != id {
                    return Ok(());
                }
                let valid = match action {
                    "ready" => {
                        h.initiator
                            && matches!(h.phase.as_str(), "prepared" | "activating" | "done")
                    }
                    "commit" => !h.initiator && matches!(h.phase.as_str(), "prepared" | "done"),
                    "done" => h.initiator && matches!(h.phase.as_str(), "activating" | "done"),
                    _ => false,
                };
                if !valid {
                    return Err("PQ_COMMIT_ORDER_INVALID".into());
                }
                let was_active = p.current.as_deref() == Some(id);
                let response = if action == "ready" {
                    Some(signal(id, "commit", 0, &epoch.send_control.0))
                } else if action == "commit" {
                    Some(signal(id, "done", 0, &epoch.send_control.0))
                } else {
                    None
                };
                h.phase = if action == "ready" {
                    "activating"
                } else {
                    "done"
                }
                .into();
                h.last = response.clone();
                self.transaction(s, |st| {
                    let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                    p.handshake = Some(h);
                    activate(p, id);
                    Ok(())
                })?;
                if !was_active {
                    result.session_event = Some(PqSessionEvent::Active);
                }
                if let Some(r) = s.runtime.get_mut(key) {
                    r.refresh_due = false;
                }
                response
            }
            "ack" => {
                let wire = wire_id(id, sequence);
                if p.outgoing
                    .get(&wire)
                    .is_some_and(|o| o.epoch == id && o.sequence == sequence && !o.acknowledged)
                {
                    self.transaction(s, |st| {
                        st.peers
                            .get_mut(key)
                            .ok_or("PQ_PEER_MISSING")?
                            .outgoing
                            .get_mut(&wire)
                            .ok_or("PQ_OUTGOING_MISSING")?
                            .acknowledged = true;
                        Ok(())
                    })?;
                    result.acknowledged_wire_id = Some(wire);
                }
                None
            }
            "refresh" => {
                if p.current.as_deref() == Some(id)
                    && p.close_phase.is_empty()
                    && !p.refresh_requested
                {
                    self.transaction(s, |st| {
                        st.peers
                            .get_mut(key)
                            .ok_or("PQ_PEER_MISSING")?
                            .refresh_requested = true;
                        Ok(())
                    })?;
                }
                None
            }
            "retire" => {
                if p.current.as_deref() == Some(id) {
                    return Err("PQ_ACTIVE_EPOCH_CANNOT_RETIRE".into());
                }
                self.transaction(s, |st| {
                    let e = st
                        .peers
                        .get_mut(key)
                        .ok_or("PQ_PEER_MISSING")?
                        .epochs
                        .get_mut(id)
                        .ok_or("PQ_EPOCH_MISSING")?;
                    if e.peer_final.is_some_and(|final_seq| final_seq != sequence) {
                        return Err("PQ_RETIRE_BOUNDARY_CHANGED".into());
                    }
                    e.peer_final = Some(sequence);
                    Ok(())
                })?;
                None
            }
            "close" | "close_ready" => {
                if p.current.as_deref() != Some(id) {
                    return Err("PQ_CLOSE_EPOCH_MISMATCH".into());
                }
                if p.close_phase.is_empty() {
                    self.transaction(s, |st| {
                        let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                        p.manual_only = true;
                        p.auto_consumed = true;
                        p.auto_pending = false;
                        p.wanted = false;
                        p.refresh_requested = false;
                        // An unanswered local rekey offer has published no new
                        // secret to the peer and can yield to its close request.
                        if p.handshake
                            .as_ref()
                            .is_some_and(|h| h.initiator && h.phase == "offered")
                        {
                            p.handshake = None;
                        }
                        if p.handshake.as_ref().is_some_and(|h| h.phase != "done") {
                            p.close_phase = "pending".into();
                            p.close_last = None;
                        } else {
                            p.close_phase = "draining".into();
                            p.close_last =
                                Some(signal(id, "close", 0, &p.epochs[id].send_control.0));
                        }
                        Ok(())
                    })?;
                    result.session_event = Some(PqSessionEvent::CloseRequested);
                }
                if action == "close_ready" {
                    // Readiness is itself an authenticated request to close.
                    // The earlier CLOSE may have been lost before reconnect.
                    self.transaction(s, |st| {
                        let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                        if p.peer_close_final.is_some_and(|v| v != sequence) {
                            return Err("PQ_CLOSE_BOUNDARY_CHANGED".into());
                        }
                        p.peer_close_final = Some(sequence);
                        Ok(())
                    })?;
                }
                if action == "close" {
                    s.stored.peers[key].close_last.clone()
                } else {
                    None
                }
            }
            "close_commit" => {
                if s.stored.owner.as_str() < key || !close_drained(p) || p.close_phase != "ready" {
                    return Err("PQ_CLOSE_COMMIT_WAIT".into());
                }
                let response = signal(id, "close_ack", 0, &epoch.send_control.0);
                self.transaction(s, |st| {
                    close_complete(
                        st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?,
                        response.clone(),
                    );
                    Ok(())
                })?;
                result.session_event = Some(PqSessionEvent::Closed);
                Some(response)
            }
            "close_ack" => {
                if p.close_phase != "commit" || !close_drained(p) {
                    return Err("PQ_CLOSE_ACK_WAIT".into());
                }
                let response = p.close_last.clone().ok_or("PQ_CLOSE_RECORD_MISSING")?;
                self.transaction(s, |st| {
                    close_complete(st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?, response);
                    Ok(())
                })?;
                result.session_event = Some(PqSessionEvent::Closed);
                None
            }
            _ => return Err("PQ_SIGNAL_UNKNOWN".into()),
        };
        if let Some(record) = response {
            result.outgoing.extend(packets(&record)?);
        }
        Ok(())
    }

    fn drive_retirement(
        &self,
        s: &mut State,
        key: &str,
        records: &mut Vec<Record>,
    ) -> Result<(), String> {
        let p = &s.stored.peers[key];
        let mut remove = Vec::new();
        for (id, epoch) in &p.epochs {
            if p.current.as_ref() == Some(id)
                || p.handshake
                    .as_ref()
                    .is_some_and(|h| h.tx() == id && h.phase != "done")
            {
                continue;
            }
            if p.outgoing
                .values()
                .any(|o| o.epoch == *id && !o.acknowledged)
            {
                continue;
            }
            let record = signal(id, "retire", epoch.send_sequence, &epoch.send_control.0);
            records.push(record.clone());
            if epoch
                .peer_final
                .is_some_and(|last| epoch.receive.floor >= last)
                && epoch.receive.skipped.is_empty()
                && p.retired.len() < MAX_RETIRED
            {
                remove.push((id.clone(), record));
            }
        }
        if !remove.is_empty() {
            self.transaction(s, |st| {
                let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                for (id, record) in remove {
                    p.epochs.remove(&id);
                    p.retired.insert(id, record);
                }
                Ok(())
            })?;
        }
        Ok(())
    }
    fn drive_close(
        &self,
        s: &mut State,
        key: &str,
        external_drained: bool,
        records: &mut Vec<Record>,
    ) -> Result<(), String> {
        let p = &s.stored.peers[key];
        let id = p.current.clone().ok_or("PQ_CLOSE_EPOCH_MISSING")?;
        if p.close_phase == "pending" {
            if p.handshake.as_ref().is_some_and(|h| h.phase != "done") {
                return Ok(());
            }
            self.transaction(s, |st| {
                let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                p.close_phase = "draining".into();
                p.wanted = false;
                p.close_last = Some(signal(&id, "close", 0, &p.epochs[&id].send_control.0));
                Ok(())
            })?;
            records.push(
                s.stored.peers[key]
                    .close_last
                    .clone()
                    .ok_or("PQ_CLOSE_RECORD_MISSING")?,
            );
            // Give the peer the explicit close request before readiness.
            return Ok(());
        }
        let p = &s.stored.peers[key];
        if p.close_phase == "draining"
            && external_drained
            && p.outgoing.values().all(|o| o.acknowledged)
        {
            self.transaction(s, |st| {
                let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                let e = p.epochs.get_mut(&id).ok_or("PQ_EPOCH_MISSING")?;
                e.send_chain = None;
                p.close_last = Some(signal(
                    &id,
                    "close_ready",
                    e.send_sequence,
                    &e.send_control.0,
                ));
                p.close_phase = "ready".into();
                Ok(())
            })?;
            records.push(
                s.stored.peers[key]
                    .close_last
                    .clone()
                    .ok_or("PQ_CLOSE_RECORD_MISSING")?,
            );
            // The peer must durably learn our final receive boundary before a
            // coordinator can replace this record with CLOSE_COMMIT.
            return Ok(());
        }
        let p = &s.stored.peers[key];
        if p.close_phase == "ready" && s.stored.owner.as_str() < key && close_drained(p) {
            self.transaction(s, |st| {
                let p = st.peers.get_mut(key).ok_or("PQ_PEER_MISSING")?;
                p.close_last = Some(signal(
                    &id,
                    "close_commit",
                    0,
                    &p.epochs[&id].send_control.0,
                ));
                p.close_phase = "commit".into();
                Ok(())
            })?;
        }
        if let Some(record) = &s.stored.peers[key].close_last {
            records.push(record.clone());
        }
        Ok(())
    }
}

fn peer(s: &State, friend: u32) -> Option<&PeerState> {
    s.routes
        .get(&friend)
        .and_then(|key| s.stored.peers.get(key))
}
fn handshake_automatic(handshake: &Handshake) -> Option<bool> {
    match &handshake.offer {
        Record::Offer { automatic, .. } => Some(*automatic),
        _ => None,
    }
}
fn cancelled_tx(peer: &PeerState) -> Option<&str> {
    match &peer.cancelled {
        Some(Record::Cancel { tx }) => Some(tx),
        _ => None,
    }
}
fn validate_stored(st: &Stored) -> Result<(), String> {
    let invalid = || "PQ_SAVED_STATE_INVALID".to_string();
    if !st.owner.is_empty() {
        normalized_key(&st.owner).map_err(|_| invalid())?;
    }
    if st.owner.is_empty() && (!st.peers.is_empty() || !st.detached.is_empty()) {
        return Err(invalid());
    }
    let detached_count = st.detached.values().try_fold(0usize, |total, peers| {
        total.checked_add(peers.len()).ok_or_else(invalid)
    })?;
    if detached_count > MAX_DETACHED_ARCHIVES {
        return Err(invalid());
    }
    for (key, p) in &st.peers {
        normalized_key(key).map_err(|_| invalid())?;
        if !p.identity.is_empty() && p.identity.len() != MLKEM_PUBLIC_KEY_BYTES
            || p.epochs.len() > 2
            || p.outgoing.len() > MAX_OUTGOING
            || p.retired.len() > MAX_RETIRED
            || !matches!(
                p.close_phase.as_str(),
                "" | "pending" | "draining" | "ready" | "commit"
            )
            || p.current
                .as_ref()
                .is_some_and(|id| !p.epochs.contains_key(id))
            || !p.close_phase.is_empty() && p.current.is_none()
            || p.close_after_activation
                && (p.current.is_some()
                    || p.handshake.as_ref().is_none_or(|h| h.phase != "prepared"))
        {
            return Err(invalid());
        }
        if let Some(cancelled) = &p.cancelled {
            let Record::Cancel { tx } = cancelled else {
                return Err(invalid());
            };
            if decode_hex(tx).map_err(|_| invalid())?.len() != 16 {
                return Err(invalid());
            }
        }
        for (id, e) in &p.epochs {
            if decode_hex(id).map_err(|_| invalid())?.len() != 16
                || e.receive.next == 0
                || e.receive.floor >= e.receive.next
                || e.receive.skipped.len() > MAX_SKIPPED as usize
                || e.receive.committed_above_floor.len() > MAX_SKIPPED as usize + 1
                || e.receive.skipped.keys().any(|seq| {
                    *seq <= e.receive.floor
                        || *seq >= e.receive.next
                        || e.receive.committed_above_floor.contains(seq)
                })
                || e.receive
                    .committed_above_floor
                    .iter()
                    .any(|seq| *seq <= e.receive.floor || *seq >= e.receive.next)
                || p.current.as_ref() == Some(id)
                    && p.close_phase.is_empty()
                    && e.send_chain.is_none()
            {
                return Err(invalid());
            }
        }
        let mut operations = BTreeSet::new();
        let mut bytes = 0usize;
        for (wire, o) in &p.outgoing {
            let Record::Data {
                epoch,
                sequence,
                ciphertext,
            } = &o.record
            else {
                return Err(invalid());
            };
            if epoch != &o.epoch
                || *sequence != o.sequence
                || *sequence == 0
                || *wire != wire_id(epoch, *sequence)
                || o.operation.len() > 256
                || !operations.insert(o.operation.as_str())
                || ciphertext.len() < 16
                || ciphertext.len() > MAX_TEXT + 16
                || !o.acknowledged && !p.epochs.contains_key(epoch)
                || p.epochs
                    .get(epoch)
                    .is_some_and(|e| *sequence > e.send_sequence)
            {
                return Err(invalid());
            }
            bytes = bytes.checked_add(ciphertext.len()).ok_or_else(invalid)?;
        }
        if bytes > MAX_OUTGOING_BYTES + 16 * MAX_OUTGOING {
            return Err(invalid());
        }
        if let Some(h) = &p.handshake {
            let Record::Offer {
                tx,
                initiator,
                responder,
                identity,
                kem,
                ..
            } = &h.offer
            else {
                return Err(invalid());
            };
            if decode_hex(tx).map_err(|_| invalid())?.len() != 16
                || identity.len() != MLKEM_PUBLIC_KEY_BYTES
                || kem.len() != MLKEM_PUBLIC_KEY_BYTES
                || if h.initiator {
                    initiator != &st.owner || responder != key
                } else {
                    initiator != key || responder != &st.owner
                }
                || !matches!(
                    h.phase.as_str(),
                    "offered"
                        | "incoming"
                        | "accept_pending"
                        | "accepting"
                        | "prepared"
                        | "activating"
                        | "done"
                )
            {
                return Err(invalid());
            }
            if matches!(h.phase.as_str(), "offered" | "accepting")
                && (h
                    .kem_secret
                    .as_ref()
                    .is_none_or(|s| s.0.len() != MLKEM_SECRET_KEY_BYTES)
                    || h.dh_secret.is_none())
            {
                return Err(invalid());
            }
            if matches!(h.phase.as_str(), "prepared" | "activating" | "done")
                && (!p.epochs.contains_key(tx)
                    || h.kem_secret.is_some()
                    || h.dh_secret.is_some()
                    || h.first_ephemeral.is_some()
                    || h.first_identity.is_some()
                    || h.accept.is_none()
                    || h.finish.is_none())
            {
                return Err(invalid());
            }
        }
    }
    for (key, archived) in &st.detached {
        normalized_key(key).map_err(|_| invalid())?;
        if archived.is_empty() {
            return Err(invalid());
        }
        // Reuse the exact active-peer validator while ensuring archived state
        // remains unreachable from normal routing. Recursion is one level:
        // this isolated value has no detached entries.
        for p in archived {
            let isolated = Stored {
                version: st.version,
                owner: st.owner.clone(),
                peers: BTreeMap::from([(key.clone(), p.clone())]),
                detached: BTreeMap::new(),
            };
            validate_stored(&isolated)?;
        }
    }
    Ok(())
}
fn route(s: &State, friend: u32) -> Result<String, String> {
    s.routes
        .get(&friend)
        .cloned()
        .ok_or("PQ_CONTACT_NOT_BOUND".into())
}
fn normalized_key(value: &str) -> Result<String, String> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("PQ_CONTACT_KEY_INVALID".into());
    }
    Ok(value.to_ascii_uppercase())
}
fn empty_result() -> PacketResult {
    PacketResult {
        outgoing: Vec::new(),
        received_text: None,
        acknowledged_wire_id: None,
        received_wire_id: None,
        session_event: None,
    }
}
fn unavailable_status(error: &str) -> PqStatus {
    PqStatus {
        supported: false,
        state: "error".into(),
        local_fingerprint: String::new(),
        peer_fingerprint: None,
        fingerprint_changed: false,
        error: Some(error.into()),
        identity_needs_entropy: false,
        identity_waiting: false,
        auto_pending: false,
        protocol_version: WIRE_VERSION,
    }
}
fn new_offer(
    owner: &str,
    key: &str,
    identity: &[u8],
    p: &PeerState,
    automatic: bool,
) -> Result<Handshake, String> {
    let mut tx = [0u8; 16];
    getrandom::fill(&mut tx).map_err(|_| "PQ_OS_RANDOM_FAILED")?;
    let (public, secret) = mlkem_keypair()?;
    let (dh_secret, dh_public) = crypto::x25519_keypair()?;
    let offer = Record::Offer {
        tx: encode_hex(&tx),
        parent: p.current.clone(),
        automatic,
        initiator: owner.into(),
        responder: key.into(),
        identity: identity.into(),
        kem: public,
        dh: dh_public,
    };
    Ok(Handshake {
        initiator: true,
        phase: "offered".into(),
        offer: offer.clone(),
        accept: None,
        finish: None,
        kem_secret: Some(PrivateBytes(secret)),
        dh_secret: Some(Secret(dh_secret)),
        first_ephemeral: None,
        first_identity: None,
        last: Some(offer),
    })
}
fn prepare_accept(h: &mut Handshake, identity: &Identity) -> Result<Record, String> {
    let Record::Offer {
        tx,
        kem,
        identity: peer_identity,
        ..
    } = &h.offer
    else {
        return Err("PQ_OFFER_INVALID".into());
    };
    let (public, secret) = mlkem_keypair()?;
    let (dh_secret, dh_public) = crypto::x25519_keypair()?;
    let (ct_ephemeral, first) = mlkem_encaps(kem)?;
    let (ct_identity, static_first) = mlkem_encaps(peer_identity)?;
    let accept = Record::Accept {
        tx: tx.clone(),
        identity: identity.public_key.clone(),
        kem: public,
        dh: dh_public,
        ct_ephemeral,
        ct_identity,
    };
    h.kem_secret = Some(PrivateBytes(secret));
    h.dh_secret = Some(Secret(dh_secret));
    h.first_ephemeral = Some(Secret(first));
    h.first_identity = Some(Secret(static_first));
    h.accept = Some(accept.clone());
    h.last = Some(accept.clone());
    h.phase = "accepting".into();
    Ok(accept)
}
fn finish_without_tag(record: &Record) -> Record {
    let mut record = record.clone();
    if let Record::Finish { tag, .. } = &mut record {
        tag.clear();
    }
    record
}
fn transcript(offer: &Record, accept: &Record, finish: &Record) -> Result<Vec<u8>, String> {
    let mut output = b"Kaigen PQ v2 / X25519 + ML-KEM-768 / AES-256-GCM / HKDF-SHA256\0".to_vec();
    for record in [offer, accept, finish] {
        let bytes = serde_json::to_vec(record).map_err(|_| "PQ_TRANSCRIPT_ENCODING")?;
        output.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        output.extend_from_slice(&bytes);
    }
    Ok(output)
}
fn transcript_mac(
    key: &[u8; 32],
    label: &[u8],
    offer: &Record,
    accept: &Record,
    finish: &Record,
) -> Result<Vec<u8>, String> {
    let mut bytes = label.to_vec();
    bytes.extend_from_slice(&transcript(offer, accept, finish)?);
    Ok(hmac_sha256(key, &bytes).to_vec())
}
fn derive_epoch(
    offer: &Record,
    accept: &Record,
    finish: &Record,
    secrets: [&[u8; 32]; 5],
    initiator: bool,
) -> Result<Epoch, String> {
    let transcript = transcript(offer, accept, finish)?;
    let mut input = Vec::with_capacity(160);
    for secret in secrets {
        input.extend_from_slice(secret);
    }
    let mut material = expand_epoch(&Sha256::digest(&transcript), &input);
    crypto::wipe(&mut input);
    let take = |offset| {
        let mut result = [0; 32];
        result.copy_from_slice(&material[offset..offset + 32]);
        Secret(result)
    };
    let (send, receive, send_control, receive_control) = if initiator {
        (take(0), take(32), take(64), take(96))
    } else {
        (take(32), take(0), take(96), take(64))
    };
    crypto::wipe(&mut material);
    Ok(Epoch {
        send_chain: Some(send),
        send_sequence: 0,
        receive: ReceiveChain {
            chain: receive,
            next: 1,
            skipped: BTreeMap::new(),
            floor: 0,
            committed_above_floor: BTreeSet::new(),
        },
        send_control,
        receive_control,
        peer_final: None,
    })
}
fn expand_epoch(salt: &[u8], input: &[u8]) -> Vec<u8> {
    // RFC 5869 extract-and-expand. The PRK never becomes a persisted master.
    let prk = Secret(hmac_sha256(salt, input));
    let mut output = Vec::with_capacity(128);
    let mut previous = Vec::new();
    for counter in 1..=4u8 {
        let mut block = previous.clone();
        block.extend_from_slice(b"Kaigen PQ v2 directional chains and controls");
        block.push(counter);
        let next = Secret(hmac_sha256(&prk.0, &block));
        crypto::wipe(&mut block);
        crypto::wipe(&mut previous);
        previous = next.0.to_vec();
        output.extend_from_slice(&next.0);
    }
    crypto::wipe(&mut previous);
    output
}
fn activate(p: &mut PeerState, id: &str) {
    let new_epoch = p.current.as_deref() != Some(id);
    if new_epoch && p.close_phase == "pending" {
        p.peer_close_final = None;
        p.close_last = None;
    }
    if new_epoch {
        // A confirmed child epoch can exist only after both peers drained all
        // epochs older than its parent. Their cached RETIRE responses are no
        // longer needed; keep the cache bounded without blocking refresh.
        p.retired.clear();
    }
    for (old, epoch) in &mut p.epochs {
        if old != id {
            epoch.send_chain = None;
        }
    }
    p.current = Some(id.into());
    p.wanted = true;
    p.auto_consumed = true;
    p.auto_pending = false;
    p.trusted_fingerprint = Some(fingerprint(&p.identity));
    p.error = None;
    if p.close_after_activation {
        p.manual_only = true;
        p.manual_request = false;
        p.wanted = false;
        p.refresh_requested = false;
        if p.handshake.as_ref().is_some_and(|h| h.phase != "done") {
            p.close_phase = "pending".into();
            p.close_last = None;
        } else {
            p.close_phase = "draining".into();
            p.close_last = Some(signal(id, "close", 0, &p.epochs[id].send_control.0));
        }
        p.close_after_activation = false;
    }
}
fn close_drained(p: &PeerState) -> bool {
    p.outgoing.values().all(|o| o.acknowledged)
        && p.epochs.len() == 1
        && p.current
            .as_ref()
            .and_then(|id| p.epochs.get(id))
            .is_some_and(|e| {
                p.peer_close_final
                    .is_some_and(|last| e.receive.floor >= last && e.receive.skipped.is_empty())
            })
}
fn close_complete(p: &mut PeerState, response: Record) {
    p.epochs.clear();
    p.retired.clear();
    p.current = None;
    p.handshake = None;
    p.cancelled = None;
    p.close_after_activation = false;
    p.close_phase.clear();
    p.peer_close_final = None;
    p.close_last = None;
    p.closed_response = Some(response);
    p.manual_only = true;
    p.auto_consumed = true;
    p.auto_pending = false;
    p.wanted = false;
    p.manual_request = false;
    p.refresh_requested = false;
    p.error = None;
}
fn ratchet(chain: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (hmac_sha256(chain, &[1]), hmac_sha256(chain, &[2]))
}
fn receive_key(current: &ReceiveChain, sequence: u64) -> Result<([u8; 32], ReceiveChain), String> {
    if sequence.saturating_sub(current.floor) > MAX_SKIPPED + 1 {
        return Err("PQ_RECEIVE_WINDOW_BACKPRESSURE".into());
    }
    let mut next = current.clone();
    if let Some(key) = next.skipped.remove(&sequence) {
        return Ok((key.0, next));
    }
    if sequence < next.next {
        return Err("PQ_RECEIVE_SEQUENCE_COMMITTED".into());
    }
    if sequence - next.next > MAX_SKIPPED
        || next.skipped.len() as u64 + sequence - next.next > MAX_SKIPPED
    {
        return Err("PQ_SKIPPED_KEY_BACKPRESSURE".into());
    }
    loop {
        let (message, chain) = ratchet(&next.chain.0);
        next.chain = Secret(chain);
        let position = next.next;
        next.next = next.next.checked_add(1).ok_or("PQ_SEQUENCE_EXHAUSTED")?;
        if position == sequence {
            return Ok((message, next));
        }
        next.skipped.insert(position, Secret(message));
    }
}
fn aad(epoch: &str, sequence: u64, len: usize) -> Vec<u8> {
    let mut bytes = b"Kaigen PQ v2 message\0".to_vec();
    bytes.extend_from_slice(epoch.as_bytes());
    bytes.extend_from_slice(&sequence.to_be_bytes());
    bytes.extend_from_slice(&(len as u64).to_be_bytes());
    bytes
}
fn message_nonce(epoch: &str, sequence: u64) -> [u8; 12] {
    let mut nonce = [0; 12];
    nonce[..4].copy_from_slice(&Sha256::digest(epoch.as_bytes())[..4]);
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}
fn wire_id(epoch: &str, sequence: u64) -> u64 {
    let mut bytes = epoch.as_bytes().to_vec();
    bytes.extend_from_slice(&sequence.to_be_bytes());
    u64::from_be_bytes(Sha256::digest(&bytes)[..8].try_into().expect("digest size"))
}
fn signal_tag(key: &[u8; 32], epoch: &str, action: &str, sequence: u64) -> [u8; 32] {
    let mut bytes = b"Kaigen PQ v2 control\0".to_vec();
    bytes.extend_from_slice(epoch.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(action.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&sequence.to_be_bytes());
    hmac_sha256(key, &bytes)
}
fn signal(epoch: &str, action: &str, sequence: u64, key: &[u8; 32]) -> Record {
    Record::Signal {
        epoch: epoch.into(),
        action: action.into(),
        sequence,
        tag: signal_tag(key, epoch, action, sequence).to_vec(),
    }
}
fn packets(record: &Record) -> Result<Vec<Vec<u8>>, String> {
    let bytes = serde_json::to_vec(record).map_err(|_| "PQ_PACKET_ENCODING")?;
    if bytes.len() > MAX_RECORD {
        return Err("PQ_PACKET_LIMIT".into());
    }
    let digest = Sha256::digest(&bytes);
    let total = bytes.len().div_ceil(FRAGMENT);
    Ok(bytes
        .chunks(FRAGMENT)
        .enumerate()
        .map(|(index, part)| {
            let mut packet = vec![PACKET_ID, b'T', b'P', b'Q', WIRE_VERSION, 1];
            packet.extend_from_slice(&digest[..16]);
            packet.extend_from_slice(&(index as u16).to_be_bytes());
            packet.extend_from_slice(&(total as u16).to_be_bytes());
            packet.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            packet.extend_from_slice(part);
            packet
        })
        .collect())
}
pub(super) fn is_packet(bytes: &[u8]) -> bool {
    bytes.len() >= 6 && bytes[..6] == [PACKET_ID, b'T', b'P', b'Q', WIRE_VERSION, 1]
}
fn reassemble(s: &mut State, peer: &str, packet: &[u8]) -> Result<Option<Record>, String> {
    if !is_packet(packet) || packet.len() < 31 || packet.len() > 30 + FRAGMENT {
        return Err("PQ_PACKET_INVALID".into());
    }
    let id = encode_hex(&packet[6..22]);
    let index = u16::from_be_bytes(packet[22..24].try_into().unwrap()) as usize;
    let total = u16::from_be_bytes(packet[24..26].try_into().unwrap()) as usize;
    let len = u32::from_be_bytes(packet[26..30].try_into().unwrap()) as usize;
    if len == 0
        || len > MAX_RECORD
        || total != len.div_ceil(FRAGMENT)
        || index >= total
        || packet.len() - 30 != (len - index * FRAGMENT).min(FRAGMENT)
    {
        return Err("PQ_FRAGMENT_INVALID".into());
    }
    let now = Instant::now();
    s.partials
        .retain(|_, p| now.duration_since(p.created) < Duration::from_secs(30));
    let key = (peer.into(), id.clone());
    if !s.partials.contains_key(&key)
        && (s.partials.len() >= 64
            || s.partials.keys().filter(|(p, _)| p == peer).count() >= MAX_PARTIALS)
    {
        return Err("PQ_REASSEMBLY_BACKPRESSURE".into());
    }
    let partial = s.partials.entry(key.clone()).or_insert_with(|| Partial {
        total: len,
        parts: vec![None; total],
        created: now,
    });
    if partial.total != len {
        return Err("PQ_FRAGMENT_CHANGED".into());
    }
    if partial.parts[index]
        .as_ref()
        .is_some_and(|old| old != &packet[30..])
    {
        return Err("PQ_FRAGMENT_CHANGED".into());
    }
    partial.parts[index] = Some(packet[30..].to_vec());
    if partial.parts.iter().any(Option::is_none) {
        return Ok(None);
    }
    let partial = s.partials.remove(&key).ok_or("PQ_REASSEMBLY_MISSING")?;
    let bytes: Vec<u8> = partial.parts.into_iter().flatten().flatten().collect();
    if encode_hex(&Sha256::digest(&bytes)[..16]) != id {
        return Err("PQ_FRAGMENT_DIGEST_INVALID".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "PQ_RECORD_INVALID".into())
}

mod wire_bytes {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};
    pub(super) fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<u8>, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        if encoded.len() > super::MAX_RECORD {
            return Err(serde::de::Error::custom("PQ_BYTE_FIELD_LIMIT"));
        }
        base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .map_err(serde::de::Error::custom)
    }
}
