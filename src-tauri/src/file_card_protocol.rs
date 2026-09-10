use crate::profiles;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const VERSION: u8 = 1;
pub const PACKET_ID: u8 = 182;
pub const MAX_FILENAME_BYTES: usize = 255;

const MAGIC: &[u8; 3] = b"KFC";
const HEADER_SIZE: usize = 6;
const KIND_OFFER: u8 = 1;
const KIND_ACK: u8 = 2;
const MESSAGE_ID_BYTES: usize = 16;
const TRANSFER_ID_BYTES: usize = 32;
const OFFER_FIXED_BYTES: usize = MESSAGE_ID_BYTES + TRANSFER_ID_BYTES + 8 + 1 + 2;
const ACK_BYTES: usize = MESSAGE_ID_BYTES + TRANSFER_ID_BYTES + 2;
const OFFER_RETRY_SECONDS: u64 = 5;
const MAX_DUE_OFFERS: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileCardDirection {
    Incoming,
    Outgoing,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileCardAckStatus {
    Applied,
    Duplicate,
    Rejected,
}

impl FileCardAckStatus {
    fn wire(self) -> u8 {
        match self {
            Self::Applied => 0,
            Self::Duplicate => 1,
            Self::Rejected => 2,
        }
    }

    fn from_wire(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Applied),
            1 => Some(Self::Duplicate),
            2 => Some(Self::Rejected),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCardOffer {
    pub message_id: String,
    pub transfer_id: [u8; TRANSFER_ID_BYTES],
    pub filename: String,
    pub size: u64,
    pub pq_required: bool,
}

impl FileCardOffer {
    pub fn transfer_id_hex(&self) -> String {
        transfer_id_to_hex(&self.transfer_id)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCardAck {
    pub message_id: String,
    pub transfer_id: [u8; TRANSFER_ID_BYTES],
    pub status: FileCardAckStatus,
    pub pq_required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCardBinding {
    pub friend_number: u32,
    pub friend_public_key: String,
    pub direction: FileCardDirection,
    pub message_id: String,
    pub transfer_id: [u8; TRANSFER_ID_BYTES],
    pub filename: String,
    pub size: u64,
    pub pq_required: bool,
}

impl FileCardBinding {
    pub fn transfer_id_hex(&self) -> String {
        transfer_id_to_hex(&self.transfer_id)
    }

    fn offer(&self) -> FileCardOffer {
        FileCardOffer {
            message_id: self.message_id.clone(),
            transfer_id: self.transfer_id,
            filename: self.filename.clone(),
            size: self.size,
            pq_required: self.pq_required,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFileCardOffer {
    pub friend_number: u32,
    pub friend_public_key: String,
    pub offer: FileCardOffer,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IncomingFileCardPacket {
    Offer(FileCardOffer),
    Ack(FileCardAck),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredOutgoing {
    friend_number: u32,
    friend_public_key: String,
    offer: FileCardOffer,
    #[serde(default)]
    last_attempted_at: Option<u64>,
    #[serde(default)]
    acknowledgement: Option<FileCardAckStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    version: u8,
    #[serde(default)]
    bindings: HashMap<String, FileCardBinding>,
    #[serde(default)]
    message_bindings: HashMap<String, String>,
    #[serde(default)]
    outgoing: HashMap<String, StoredOutgoing>,
}

impl Default for StoredState {
    fn default() -> Self {
        Self {
            version: VERSION,
            bindings: HashMap::new(),
            message_bindings: HashMap::new(),
            outgoing: HashMap::new(),
        }
    }
}

pub struct FileCardEngine {
    path: PathBuf,
    state: Mutex<StoredState>,
}

impl FileCardEngine {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join("file-card-protocol-v1.json");
        let state = if profiles::file_exists(&path) {
            let bytes = profiles::read_file(&path)
                .map_err(|_| "FILE_CARD_STATE_READ_FAILED".to_string())?;
            serde_json::from_slice::<StoredState>(&bytes)
                .map_err(|_| "FILE_CARD_STATE_INVALID".to_string())?
        } else {
            StoredState::default()
        };
        validate_state(&state)?;
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    pub fn offer_for_send(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
        filename: &str,
        size: u64,
    ) -> Result<FileCardOffer, String> {
        self.offer_for_send_with_retry(
            friend_number,
            friend_public_key,
            message_id,
            filename,
            size,
            false,
        )
    }

    /// Only an explicit user retry may replace a rejected offer. Ordinary
    /// outbox/reconnect polling must continue to observe the durable rejection.
    pub fn offer_for_retry(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
        filename: &str,
        size: u64,
    ) -> Result<FileCardOffer, String> {
        self.offer_for_send_with_retry(
            friend_number,
            friend_public_key,
            message_id,
            filename,
            size,
            true,
        )
    }

    fn offer_for_send_with_retry(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
        filename: &str,
        size: u64,
        explicit_retry: bool,
    ) -> Result<FileCardOffer, String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key)?;
        let friend_public_key = canonical_friend_public_key(friend_public_key)?;
        let message_id = canonical_message_id(message_id)?;
        let filename = sanitize_filename(filename);
        validate_filename(&filename)?;
        let message_key = message_key(&friend_key, &message_id);
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;
        if let Some(transfer_key) = guard.message_bindings.get(&message_key).cloned() {
            let binding = guard
                .bindings
                .get(&transfer_key)
                .ok_or_else(|| "FILE_CARD_STATE_INVALID".to_string())?;
            if binding.direction != FileCardDirection::Outgoing
                || binding.filename != filename
                || binding.size != size
                || binding.pq_required
            {
                return Err("FILE_CARD_MESSAGE_ID_REUSED".to_string());
            }
            if explicit_retry
                && guard.outgoing.get(&message_key).is_some_and(|outgoing| {
                    outgoing.acknowledgement == Some(FileCardAckStatus::Rejected)
                })
            {
                let transfer_id = unique_transfer_id(&guard)?;
                let mut binding = binding.clone();
                binding.friend_number = friend_number;
                binding.friend_public_key = friend_public_key.clone();
                binding.transfer_id = transfer_id;
                let offer = binding.offer();
                let next_transfer_key = self::transfer_key(&friend_key, &transfer_id);
                let mut next = guard.clone();
                next.bindings.remove(&transfer_key);
                next.bindings.insert(next_transfer_key.clone(), binding);
                next.message_bindings
                    .insert(message_key.clone(), next_transfer_key);
                next.outgoing.insert(
                    message_key,
                    StoredOutgoing {
                        friend_number,
                        friend_public_key,
                        offer: offer.clone(),
                        last_attempted_at: None,
                        acknowledgement: None,
                    },
                );
                persist_state(&self.path, &next)?;
                *guard = next;
                return Ok(offer);
            }
            let offer = binding.offer();
            if binding.friend_number != friend_number
                || binding.friend_public_key != friend_public_key
            {
                let mut next = guard.clone();
                let rebound = next
                    .bindings
                    .get_mut(&transfer_key)
                    .ok_or_else(|| "FILE_CARD_STATE_INVALID".to_string())?;
                rebound.friend_number = friend_number;
                rebound.friend_public_key = friend_public_key.clone();
                let pending = next
                    .outgoing
                    .get_mut(&message_key)
                    .ok_or_else(|| "FILE_CARD_STATE_INVALID".to_string())?;
                pending.friend_number = friend_number;
                pending.friend_public_key = friend_public_key;
                persist_state(&self.path, &next)?;
                *guard = next;
            }
            return Ok(offer);
        }

        let transfer_id = unique_transfer_id(&guard)?;
        let offer = FileCardOffer {
            message_id: message_id.clone(),
            transfer_id,
            filename: filename.clone(),
            size,
            pq_required: false,
        };
        let binding = FileCardBinding {
            friend_number,
            friend_public_key: friend_public_key.clone(),
            direction: FileCardDirection::Outgoing,
            message_id: message_id.clone(),
            transfer_id,
            filename,
            size,
            pq_required: false,
        };
        let transfer_key = transfer_key(&friend_key, &transfer_id);
        let mut next = guard.clone();
        next.message_bindings
            .insert(message_key.clone(), transfer_key.clone());
        next.bindings.insert(transfer_key, binding);
        next.outgoing.insert(
            message_key,
            StoredOutgoing {
                friend_number,
                friend_public_key,
                offer: offer.clone(),
                last_attempted_at: None,
                acknowledgement: None,
            },
        );
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(offer)
    }

    pub fn apply_incoming_offer(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        offer: &FileCardOffer,
    ) -> Result<(FileCardBinding, FileCardAckStatus), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key)?;
        let friend_public_key = canonical_friend_public_key(friend_public_key)?;
        let offer = canonical_offer(offer)?;
        let message_key = message_key(&friend_key, &offer.message_id);
        let transfer_key = transfer_key(&friend_key, &offer.transfer_id);
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;

        if let Some(existing) = guard.bindings.get(&transfer_key) {
            if existing.direction == FileCardDirection::Incoming
                && binding_matches_offer(existing, &offer)
                && existing.friend_public_key == friend_public_key
            {
                let mut binding = existing.clone();
                if binding.friend_number != friend_number {
                    let mut next = guard.clone();
                    binding.friend_number = friend_number;
                    next.bindings.insert(transfer_key, binding.clone());
                    persist_state(&self.path, &next)?;
                    *guard = next;
                }
                return Ok((binding, FileCardAckStatus::Duplicate));
            }
            return Err("FILE_CARD_TRANSFER_ID_CONFLICT".to_string());
        }
        if guard.message_bindings.contains_key(&message_key) {
            return Err("FILE_CARD_MESSAGE_ID_CONFLICT".to_string());
        }

        let binding = FileCardBinding {
            friend_number,
            friend_public_key,
            direction: FileCardDirection::Incoming,
            message_id: offer.message_id.clone(),
            transfer_id: offer.transfer_id,
            filename: offer.filename.clone(),
            size: offer.size,
            pq_required: false,
        };
        let mut next = guard.clone();
        next.message_bindings
            .insert(message_key, transfer_key.clone());
        next.bindings.insert(transfer_key, binding.clone());
        // The binding reaches durable storage before the caller is allowed to
        // return or transmit an acknowledgement.
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok((binding, FileCardAckStatus::Applied))
    }

    pub fn acknowledge_offer(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        acknowledgement: &FileCardAck,
    ) -> Result<FileCardAckStatus, String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key)?;
        let message_id = canonical_message_id(&acknowledgement.message_id)?;
        if acknowledgement.pq_required {
            return Err("FILE_CARD_PQ_POLICY_MISMATCH".to_string());
        }
        let message_key = message_key(&friend_key, &message_id);
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;
        let Some(outgoing) = guard.outgoing.get(&message_key) else {
            return Err("FILE_CARD_ACK_UNKNOWN".to_string());
        };
        if outgoing.offer.transfer_id != acknowledgement.transfer_id
            || outgoing.offer.message_id != message_id
            || outgoing.offer.pq_required
        {
            return Err("FILE_CARD_ACK_BINDING_MISMATCH".to_string());
        }
        if let Some(existing) = outgoing.acknowledgement {
            if existing != acknowledgement.status {
                return Err("FILE_CARD_ACK_STATUS_CONFLICT".to_string());
            }
            return Ok(existing);
        }
        let mut next = guard.clone();
        let pending = next
            .outgoing
            .get_mut(&message_key)
            .ok_or_else(|| "FILE_CARD_ACK_UNKNOWN".to_string())?;
        pending.acknowledgement = Some(acknowledgement.status);
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(acknowledgement.status)
    }

    pub fn due_offers(&self, now: u64) -> Vec<PendingFileCardOffer> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let mut due = state
            .outgoing
            .values()
            .filter(|pending| {
                pending.acknowledgement.is_none()
                    && pending.last_attempted_at.is_none_or(|last| {
                        now < last || now.saturating_sub(last) >= OFFER_RETRY_SECONDS
                    })
            })
            .map(|pending| PendingFileCardOffer {
                friend_number: pending.friend_number,
                friend_public_key: pending.friend_public_key.clone(),
                offer: pending.offer.clone(),
            })
            .collect::<Vec<_>>();
        due.sort_by(|left, right| {
            left.friend_public_key
                .cmp(&right.friend_public_key)
                .then(left.friend_number.cmp(&right.friend_number))
                .then(left.offer.message_id.cmp(&right.offer.message_id))
        });
        due.truncate(MAX_DUE_OFFERS);
        due
    }

    pub fn mark_attempted(&self, pending: &PendingFileCardOffer, now: u64) -> Result<(), String> {
        let friend_key = durable_friend_key(pending.friend_number, &pending.friend_public_key)?;
        let message_id = canonical_message_id(&pending.offer.message_id)?;
        let key = message_key(&friend_key, &message_id);
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;
        let Some(existing) = guard.outgoing.get(&key) else {
            return Err("FILE_CARD_OFFER_UNKNOWN".to_string());
        };
        if existing.offer != pending.offer {
            return Err("FILE_CARD_OFFER_BINDING_MISMATCH".to_string());
        }
        if existing.acknowledgement.is_some() {
            return Ok(());
        }
        let mut next = guard.clone();
        next.outgoing
            .get_mut(&key)
            .ok_or_else(|| "FILE_CARD_OFFER_UNKNOWN".to_string())?
            .last_attempted_at = Some(now);
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn binding_by_transfer_id(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        transfer_id: [u8; TRANSFER_ID_BYTES],
    ) -> Option<FileCardBinding> {
        let friend_key = durable_friend_key(friend_number, friend_public_key).ok()?;
        self.state.lock().ok().and_then(|state| {
            state
                .bindings
                .get(&transfer_key(&friend_key, &transfer_id))
                .cloned()
        })
    }

    pub fn outgoing_acknowledgement(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
    ) -> Option<FileCardAckStatus> {
        let friend_key = durable_friend_key(friend_number, friend_public_key).ok()?;
        let message_id = canonical_message_id(message_id).ok()?;
        self.state.lock().ok().and_then(|state| {
            state
                .outgoing
                .get(&message_key(&friend_key, &message_id))
                .and_then(|pending| pending.acknowledgement)
        })
    }

    pub fn outgoing_offer(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
    ) -> Option<FileCardOffer> {
        let friend_key = durable_friend_key(friend_number, friend_public_key).ok()?;
        let message_id = canonical_message_id(message_id).ok()?;
        self.state.lock().ok().and_then(|state| {
            state
                .outgoing
                .get(&message_key(&friend_key, &message_id))
                .map(|pending| pending.offer.clone())
        })
    }

    pub fn remove_message(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key)?;
        let message_id = canonical_message_id(message_id)?;
        let message_key = message_key(&friend_key, &message_id);
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;
        let Some(transfer_key) = guard.message_bindings.get(&message_key).cloned() else {
            return Ok(());
        };
        let mut next = guard.clone();
        next.message_bindings.remove(&message_key);
        next.bindings.remove(&transfer_key);
        next.outgoing.remove(&message_key);
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    /// Drops all durable file-card state after the bound transfer reaches a
    /// terminal state. Repeating the call is safe after a lost response or a
    /// restart.
    pub fn finish_message(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
    ) -> Result<(), String> {
        self.remove_message(friend_number, friend_public_key, message_id)
    }

    /// Reconciles one contact with its durable history while retaining every
    /// unacknowledged outgoing offer. Such an offer is removed only by the
    /// explicit terminal/remove APIs, never as a side effect of history trim.
    pub fn retain_friend_messages(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        retained_message_ids: &HashSet<String>,
    ) -> Result<(), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key)?;
        let retained_message_ids = retained_message_ids
            .iter()
            .map(|message_id| canonical_message_id(message_id))
            .collect::<Result<HashSet<_>, _>>()?;
        self.retain_messages(|binding| {
            durable_friend_key(binding.friend_number, &binding.friend_public_key)
                .is_ok_and(|binding_friend_key| binding_friend_key != friend_key)
                || retained_message_ids.contains(&binding.message_id)
        })
    }

    /// Global reconciliation hook for clear-history flows. The predicate is
    /// evaluated against each durable binding; unacknowledged outgoing offers
    /// are retained independently of its result.
    pub fn retain_messages<F>(&self, mut retain: F) -> Result<(), String>
    where
        F: FnMut(&FileCardBinding) -> bool,
    {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;
        let mut retained_keys = HashSet::new();
        for binding in guard.bindings.values() {
            let friend_key = durable_friend_key(binding.friend_number, &binding.friend_public_key)?;
            let key = message_key(&friend_key, &binding.message_id);
            let unacknowledged = guard
                .outgoing
                .get(&key)
                .is_some_and(|pending| pending.acknowledgement.is_none());
            if unacknowledged || retain(binding) {
                retained_keys.insert(key);
            }
        }
        if retained_keys.len() == guard.message_bindings.len() {
            return Ok(());
        }

        let mut next = guard.clone();
        next.bindings.retain(|_, binding| {
            durable_friend_key(binding.friend_number, &binding.friend_public_key)
                .map(|friend_key| {
                    retained_keys.contains(&message_key(&friend_key, &binding.message_id))
                })
                .unwrap_or(false)
        });
        let retained_transfer_keys = next.bindings.keys().cloned().collect::<HashSet<_>>();
        next.message_bindings.retain(|message_key, transfer_key| {
            retained_keys.contains(message_key) && retained_transfer_keys.contains(transfer_key)
        });
        next.outgoing
            .retain(|message_key, _| retained_keys.contains(message_key));
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn remove_friend(&self, friend_number: u32, friend_public_key: &str) -> Result<(), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key)?;
        let prefix = format!("{friend_key}:");
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;
        let mut next = guard.clone();
        next.bindings.retain(|key, _| !key.starts_with(&prefix));
        next.message_bindings
            .retain(|key, _| !key.starts_with(&prefix));
        next.outgoing.retain(|key, _| !key.starts_with(&prefix));
        if next.bindings.len() == guard.bindings.len()
            && next.outgoing.len() == guard.outgoing.len()
        {
            return Ok(());
        }
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "FILE_CARD_STATE_LOCK_POISONED".to_string())?;
        let next = StoredState::default();
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }
}

pub fn encode_offer(offer: &FileCardOffer) -> Result<Vec<u8>, String> {
    let offer = canonical_offer(offer)?;
    let message_id = decode_fixed_hex::<MESSAGE_ID_BYTES>(&offer.message_id)
        .ok_or_else(|| "FILE_CARD_MESSAGE_ID_INVALID".to_string())?;
    let filename = offer.filename.as_bytes();
    let mut payload = Vec::with_capacity(OFFER_FIXED_BYTES + filename.len());
    payload.extend_from_slice(&message_id);
    payload.extend_from_slice(&offer.transfer_id);
    payload.extend_from_slice(&offer.size.to_be_bytes());
    payload.push(0);
    payload.extend_from_slice(&(filename.len() as u16).to_be_bytes());
    payload.extend_from_slice(filename);
    Ok(packet(KIND_OFFER, &payload))
}

pub fn encode_ack(acknowledgement: &FileCardAck) -> Result<Vec<u8>, String> {
    let message_id = canonical_message_id(&acknowledgement.message_id)?;
    if acknowledgement.pq_required {
        return Err("FILE_CARD_PQ_POLICY_MISMATCH".to_string());
    }
    if acknowledgement.transfer_id.iter().all(|byte| *byte == 0) {
        return Err("FILE_CARD_TRANSFER_ID_INVALID".to_string());
    }
    let message_id = decode_fixed_hex::<MESSAGE_ID_BYTES>(&message_id)
        .ok_or_else(|| "FILE_CARD_MESSAGE_ID_INVALID".to_string())?;
    let mut payload = Vec::with_capacity(ACK_BYTES);
    payload.extend_from_slice(&message_id);
    payload.extend_from_slice(&acknowledgement.transfer_id);
    payload.push(acknowledgement.status.wire());
    payload.push(0);
    Ok(packet(KIND_ACK, &payload))
}

pub fn decode_packet(bytes: &[u8]) -> Option<IncomingFileCardPacket> {
    if !is_packet(bytes) {
        return None;
    }
    let payload = &bytes[HEADER_SIZE..];
    match bytes[5] {
        KIND_OFFER => decode_offer(payload).map(IncomingFileCardPacket::Offer),
        KIND_ACK => decode_ack(payload).map(IncomingFileCardPacket::Ack),
        _ => None,
    }
}

pub fn is_packet(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER_SIZE
        && bytes[0] == PACKET_ID
        && &bytes[1..4] == MAGIC
        && bytes[4] == VERSION
}

pub fn ack_for_offer(offer: &FileCardOffer, status: FileCardAckStatus) -> FileCardAck {
    FileCardAck {
        message_id: offer.message_id.clone(),
        transfer_id: offer.transfer_id,
        status,
        pq_required: false,
    }
}

pub fn transfer_id_to_hex(transfer_id: &[u8; TRANSFER_ID_BYTES]) -> String {
    encode_hex(transfer_id)
}

pub fn transfer_id_from_hex(value: &str) -> Option<[u8; TRANSFER_ID_BYTES]> {
    decode_fixed_hex(value)
}

pub fn sanitize_filename(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len().min(MAX_FILENAME_BYTES));
    for character in value.chars() {
        if character.is_control() {
            continue;
        }
        let character = if matches!(
            character,
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) {
            '_'
        } else {
            character
        };
        if sanitized.len().saturating_add(character.len_utf8()) > MAX_FILENAME_BYTES {
            break;
        }
        sanitized.push(character);
    }
    let trimmed = sanitized
        .trim_matches(|character: char| character.is_whitespace() || character == '.')
        .to_string();
    let mut sanitized = if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed
    };
    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_digit() && suffix != "0"
            });
    if reserved {
        sanitized.insert(0, '_');
        while sanitized.len() > MAX_FILENAME_BYTES {
            sanitized.pop();
        }
    }
    sanitized
}

fn validate_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.len() > MAX_FILENAME_BYTES
        || sanitize_filename(filename) != filename
    {
        Err("FILE_CARD_FILENAME_INVALID".to_string())
    } else {
        Ok(())
    }
}

fn canonical_offer(offer: &FileCardOffer) -> Result<FileCardOffer, String> {
    let message_id = canonical_message_id(&offer.message_id)?;
    validate_filename(&offer.filename)?;
    if offer.transfer_id.iter().all(|byte| *byte == 0) {
        return Err("FILE_CARD_TRANSFER_ID_INVALID".to_string());
    }
    if offer.pq_required {
        return Err("FILE_CARD_PQ_POLICY_MISMATCH".to_string());
    }
    Ok(FileCardOffer {
        message_id,
        transfer_id: offer.transfer_id,
        filename: offer.filename.clone(),
        size: offer.size,
        pq_required: false,
    })
}

fn canonical_message_id(value: &str) -> Result<String, String> {
    if value.len() != MESSAGE_ID_BYTES * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("FILE_CARD_MESSAGE_ID_INVALID".to_string());
    }
    Ok(value.to_ascii_lowercase())
}

fn canonical_friend_public_key(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("FILE_CARD_FRIEND_KEY_INVALID".to_string());
    }
    Ok(value.to_ascii_uppercase())
}

fn durable_friend_key(friend_number: u32, friend_public_key: &str) -> Result<String, String> {
    let public_key = canonical_friend_public_key(friend_public_key)?;
    if public_key.is_empty() {
        Ok(format!("number-{friend_number}"))
    } else {
        Ok(format!("key-{public_key}"))
    }
}

fn message_key(friend_key: &str, message_id: &str) -> String {
    format!("{friend_key}:{message_id}")
}

fn transfer_key(friend_key: &str, transfer_id: &[u8; TRANSFER_ID_BYTES]) -> String {
    format!("{friend_key}:{}", transfer_id_to_hex(transfer_id))
}

fn unique_transfer_id(state: &StoredState) -> Result<[u8; TRANSFER_ID_BYTES], String> {
    for _ in 0..8 {
        let mut transfer_id = [0u8; TRANSFER_ID_BYTES];
        getrandom::fill(&mut transfer_id)
            .map_err(|_| "FILE_CARD_TRANSFER_ID_RANDOM_FAILED".to_string())?;
        if transfer_id.iter().any(|byte| *byte != 0)
            && state
                .bindings
                .values()
                .all(|binding| binding.transfer_id != transfer_id)
        {
            return Ok(transfer_id);
        }
    }
    Err("FILE_CARD_TRANSFER_ID_COLLISION".to_string())
}

fn binding_matches_offer(binding: &FileCardBinding, offer: &FileCardOffer) -> bool {
    binding.message_id == offer.message_id
        && binding.transfer_id == offer.transfer_id
        && binding.filename == offer.filename
        && binding.size == offer.size
        && binding.pq_required == offer.pq_required
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

fn decode_offer(payload: &[u8]) -> Option<FileCardOffer> {
    if payload.len() < OFFER_FIXED_BYTES {
        return None;
    }
    let message_id = encode_hex(&payload[..MESSAGE_ID_BYTES]);
    let transfer_id: [u8; TRANSFER_ID_BYTES] = payload
        [MESSAGE_ID_BYTES..MESSAGE_ID_BYTES + TRANSFER_ID_BYTES]
        .try_into()
        .ok()?;
    if transfer_id.iter().all(|byte| *byte == 0) {
        return None;
    }
    let size_offset = MESSAGE_ID_BYTES + TRANSFER_ID_BYTES;
    let size = u64::from_be_bytes(payload[size_offset..size_offset + 8].try_into().ok()?);
    if payload[size_offset + 8] != 0 {
        return None;
    }
    let filename_length =
        u16::from_be_bytes(payload[size_offset + 9..size_offset + 11].try_into().ok()?) as usize;
    if filename_length == 0
        || filename_length > MAX_FILENAME_BYTES
        || payload.len() != OFFER_FIXED_BYTES + filename_length
    {
        return None;
    }
    let filename = std::str::from_utf8(&payload[OFFER_FIXED_BYTES..])
        .ok()?
        .to_string();
    validate_filename(&filename).ok()?;
    Some(FileCardOffer {
        message_id,
        transfer_id,
        filename,
        size,
        pq_required: false,
    })
}

fn decode_ack(payload: &[u8]) -> Option<FileCardAck> {
    if payload.len() != ACK_BYTES {
        return None;
    }
    let message_id = encode_hex(&payload[..MESSAGE_ID_BYTES]);
    let transfer_id: [u8; TRANSFER_ID_BYTES] = payload
        [MESSAGE_ID_BYTES..MESSAGE_ID_BYTES + TRANSFER_ID_BYTES]
        .try_into()
        .ok()?;
    if transfer_id.iter().all(|byte| *byte == 0) {
        return None;
    }
    let status = FileCardAckStatus::from_wire(payload[MESSAGE_ID_BYTES + TRANSFER_ID_BYTES])?;
    if payload[MESSAGE_ID_BYTES + TRANSFER_ID_BYTES + 1] != 0 {
        return None;
    }
    Some(FileCardAck {
        message_id,
        transfer_id,
        status,
        pq_required: false,
    })
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_fixed_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut decoded = [0u8; N];
    for (index, byte) in decoded.iter_mut().enumerate() {
        let start = index * 2;
        *byte = u8::from_str_radix(&value[start..start + 2], 16).ok()?;
    }
    Some(decoded)
}

fn persist_state(path: &Path, state: &StoredState) -> Result<(), String> {
    validate_state(state)?;
    let bytes =
        serde_json::to_vec(state).map_err(|_| "FILE_CARD_STATE_ENCODE_FAILED".to_string())?;
    profiles::atomic_write(path, &bytes).map_err(|_| "FILE_CARD_STATE_WRITE_FAILED".to_string())
}

fn validate_state(state: &StoredState) -> Result<(), String> {
    if state.version != VERSION || state.message_bindings.len() != state.bindings.len() {
        return Err("FILE_CARD_STATE_INVALID".to_string());
    }
    for (key, binding) in &state.bindings {
        let friend_key = durable_friend_key(binding.friend_number, &binding.friend_public_key)?;
        let friend_public_key = canonical_friend_public_key(&binding.friend_public_key)?;
        let message_id = canonical_message_id(&binding.message_id)?;
        let offer = canonical_offer(&binding.offer())?;
        if friend_public_key != binding.friend_public_key
            || message_id != binding.message_id
            || offer.filename != binding.filename
            || key != &transfer_key(&friend_key, &binding.transfer_id)
            || state
                .message_bindings
                .get(&message_key(&friend_key, &binding.message_id))
                != Some(key)
        {
            return Err("FILE_CARD_STATE_INVALID".to_string());
        }
    }
    for (key, transfer_key) in &state.message_bindings {
        let Some(binding) = state.bindings.get(transfer_key) else {
            return Err("FILE_CARD_STATE_INVALID".to_string());
        };
        let friend_key = durable_friend_key(binding.friend_number, &binding.friend_public_key)?;
        if key != &message_key(&friend_key, &binding.message_id) {
            return Err("FILE_CARD_STATE_INVALID".to_string());
        }
    }
    for (key, outgoing) in &state.outgoing {
        let friend_key = durable_friend_key(outgoing.friend_number, &outgoing.friend_public_key)?;
        let friend_public_key = canonical_friend_public_key(&outgoing.friend_public_key)?;
        let message_id = canonical_message_id(&outgoing.offer.message_id)?;
        let transfer_key = state
            .message_bindings
            .get(&message_key(&friend_key, &message_id))
            .ok_or_else(|| "FILE_CARD_STATE_INVALID".to_string())?;
        let binding = state
            .bindings
            .get(transfer_key)
            .ok_or_else(|| "FILE_CARD_STATE_INVALID".to_string())?;
        if friend_public_key != outgoing.friend_public_key
            || key != &message_key(&friend_key, &message_id)
            || binding.direction != FileCardDirection::Outgoing
            || !binding_matches_offer(binding, &outgoing.offer)
        {
            return Err("FILE_CARD_STATE_INVALID".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_directory(label: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "kaigen-file-card-{label}-{}-{now}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create isolated file-card directory");
        directory
    }

    fn public_key(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    fn message_id(value: u128) -> String {
        format!("{value:032x}")
    }

    #[test]
    fn codecs_are_lossless_distinct_and_strictly_bounded() {
        let offer = FileCardOffer {
            message_id: message_id(1),
            transfer_id: [7; TRANSFER_ID_BYTES],
            filename: "фото.png".to_string(),
            size: 42,
            pq_required: false,
        };
        let encoded = encode_offer(&offer).unwrap();
        assert_eq!(encoded[0], PACKET_ID);
        assert_eq!(&encoded[1..4], MAGIC);
        assert_eq!(
            decode_packet(&encoded),
            Some(IncomingFileCardPacket::Offer(offer.clone()))
        );

        let acknowledgement = ack_for_offer(&offer, FileCardAckStatus::Applied);
        assert_eq!(
            decode_packet(&encode_ack(&acknowledgement).unwrap()),
            Some(IncomingFileCardPacket::Ack(acknowledgement))
        );
        let mut wrong_magic = encoded.clone();
        wrong_magic[1] = b'X';
        assert_eq!(decode_packet(&wrong_magic), None);
        assert_eq!(decode_packet(&encoded[..encoded.len() - 1]), None);

        let unsafe_offer = FileCardOffer {
            filename: "../secret\0.txt".to_string(),
            ..offer
        };
        assert_eq!(
            encode_offer(&unsafe_offer).unwrap_err(),
            "FILE_CARD_FILENAME_INVALID"
        );
        let sanitized = sanitize_filename(&format!("../{}?.png", "😀".repeat(100)));
        assert!(sanitized.len() <= MAX_FILENAME_BYTES);
        assert!(sanitized.is_char_boundary(sanitized.len()));
        assert!(!sanitized.contains('/') && !sanitized.contains('?'));
    }

    #[test]
    fn identical_files_with_distinct_messages_keep_distinct_transfer_ids() {
        let directory = test_directory("distinct");
        let key = public_key('a');
        let first_id = message_id(1);
        let second_id = message_id(2);
        let first;
        {
            let engine = FileCardEngine::new(&directory).unwrap();
            first = engine
                .offer_for_send(4, &key, &first_id, "same.bin", 1024)
                .unwrap();
            let second = engine
                .offer_for_send(4, &key, &second_id, "same.bin", 1024)
                .unwrap();
            assert_ne!(first.transfer_id, second.transfer_id);
            assert_eq!(
                engine
                    .offer_for_send(4, &key, &first_id, "same.bin", 1024)
                    .unwrap(),
                first
            );
            assert_eq!(
                engine
                    .offer_for_send(4, &key, &first_id, "changed.bin", 1024)
                    .unwrap_err(),
                "FILE_CARD_MESSAGE_ID_REUSED"
            );
        }
        let restarted = FileCardEngine::new(&directory).unwrap();
        assert_eq!(
            restarted
                .offer_for_send(99, &key.to_ascii_lowercase(), &first_id, "same.bin", 1024)
                .unwrap(),
            first
        );
        let rebound = restarted.due_offers(0);
        let rebound = rebound
            .iter()
            .find(|pending| pending.offer.message_id == first_id)
            .unwrap();
        assert_eq!(rebound.friend_number, 99);
        assert_eq!(rebound.friend_public_key, key.to_ascii_uppercase());
        drop(restarted);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn lost_ack_retries_survive_restart_and_ack_binding_is_exact() {
        let directory = test_directory("retry");
        let key = public_key('b');
        let other_key = public_key('c');
        let id = message_id(3);
        let offer;
        {
            let engine = FileCardEngine::new(&directory).unwrap();
            offer = engine
                .offer_for_send(5, &key, &id, "archive.zip", 800)
                .unwrap();
            let due = engine.due_offers(100);
            assert_eq!(due.len(), 1);
            engine.mark_attempted(&due[0], 100).unwrap();
            assert!(engine.due_offers(104).is_empty());
        }

        let engine = FileCardEngine::new(&directory).unwrap();
        assert!(engine.due_offers(104).is_empty());
        assert_eq!(engine.due_offers(105).len(), 1);
        let acknowledgement = ack_for_offer(&offer, FileCardAckStatus::Applied);
        assert_eq!(
            engine
                .acknowledge_offer(5, &other_key, &acknowledgement)
                .unwrap_err(),
            "FILE_CARD_ACK_UNKNOWN"
        );
        let mut wrong_transfer = acknowledgement.clone();
        wrong_transfer.transfer_id[0] ^= 1;
        assert_eq!(
            engine
                .acknowledge_offer(5, &key, &wrong_transfer)
                .unwrap_err(),
            "FILE_CARD_ACK_BINDING_MISMATCH"
        );
        assert_eq!(
            engine.acknowledge_offer(5, &key, &acknowledgement).unwrap(),
            FileCardAckStatus::Applied
        );
        assert!(engine.due_offers(1_000).is_empty());
        drop(engine);

        let restarted = FileCardEngine::new(&directory).unwrap();
        assert!(restarted.due_offers(1_000).is_empty());
        assert_eq!(
            restarted
                .acknowledge_offer(5, &key, &acknowledgement)
                .unwrap(),
            FileCardAckStatus::Applied
        );
        drop(restarted);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn incoming_offer_is_durable_before_ack_and_replays_as_duplicate() {
        let directory = test_directory("incoming");
        let key = public_key('d');
        let offer = FileCardOffer {
            message_id: message_id(4),
            transfer_id: [9; TRANSFER_ID_BYTES],
            filename: "photo.jpg".to_string(),
            size: 500,
            pq_required: false,
        };
        {
            let engine = FileCardEngine::new(&directory).unwrap();
            let (binding, status) = engine.apply_incoming_offer(7, &key, &offer).unwrap();
            assert_eq!(status, FileCardAckStatus::Applied);
            assert_eq!(binding.direction, FileCardDirection::Incoming);
        }
        let engine = FileCardEngine::new(&directory).unwrap();
        let (binding, status) = engine.apply_incoming_offer(77, &key, &offer).unwrap();
        assert_eq!(status, FileCardAckStatus::Duplicate);
        assert_eq!(binding.friend_number, 77);
        assert_eq!(
            engine
                .binding_by_transfer_id(77, &key, offer.transfer_id)
                .unwrap(),
            binding
        );
        assert!(engine
            .binding_by_transfer_id(7, &public_key('e'), offer.transfer_id)
            .is_none());

        let mut reused_transfer = offer.clone();
        reused_transfer.message_id = message_id(5);
        assert_eq!(
            engine
                .apply_incoming_offer(7, &key, &reused_transfer)
                .unwrap_err(),
            "FILE_CARD_TRANSFER_ID_CONFLICT"
        );
        let mut reused_message = offer.clone();
        reused_message.transfer_id = [10; TRANSFER_ID_BYTES];
        assert_eq!(
            engine
                .apply_incoming_offer(7, &key, &reused_message)
                .unwrap_err(),
            "FILE_CARD_MESSAGE_ID_CONFLICT"
        );
        drop(engine);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn file_card_ack_rejected_offer_rearms_only_for_explicit_retry_and_rejects_late_old_ack() {
        let directory = test_directory("rejected-retry");
        let key = public_key('a');
        let id = message_id(41);
        let engine = FileCardEngine::new(&directory).unwrap();
        let first = engine
            .offer_for_send(7, &key, &id, "retry.bin", 128)
            .unwrap();
        let rejected = ack_for_offer(&first, FileCardAckStatus::Rejected);
        engine.acknowledge_offer(7, &key, &rejected).unwrap();
        drop(engine);
        let restarted = FileCardEngine::new(&directory).unwrap();
        assert!(restarted.due_offers(1_000).is_empty());
        assert_eq!(
            restarted
                .offer_for_send(77, &key, &id, "retry.bin", 128)
                .unwrap(),
            first,
            "automatic outbox/reconnect must not rearm a rejected offer"
        );
        let retry = restarted
            .offer_for_retry(77, &key, &id, "retry.bin", 128)
            .unwrap();
        assert_eq!(retry.message_id, first.message_id);
        assert_ne!(retry.transfer_id, first.transfer_id);
        assert_eq!(restarted.outgoing_acknowledgement(77, &key, &id), None);
        assert_eq!(restarted.due_offers(1_000)[0].offer, retry);
        assert_eq!(
            restarted
                .offer_for_retry(77, &key, &id, "retry.bin", 128)
                .unwrap(),
            retry,
            "a repeated user command must retain the newly armed transfer identity"
        );
        assert_eq!(
            restarted
                .acknowledge_offer(77, &key, &rejected)
                .unwrap_err(),
            "FILE_CARD_ACK_BINDING_MISMATCH"
        );
        drop(restarted);
        let reopened = FileCardEngine::new(&directory).unwrap();
        assert_eq!(reopened.due_offers(2_000)[0].offer, retry);
        let accepted = ack_for_offer(&retry, FileCardAckStatus::Applied);
        reopened.acknowledge_offer(77, &key, &accepted).unwrap();
        assert_eq!(
            reopened
                .offer_for_retry(77, &key, &id, "retry.bin", 128)
                .unwrap(),
            retry,
            "accepted offers keep their existing identity for a native transfer retry"
        );
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn terminal_cleanup_is_idempotent_and_survives_restart() {
        let directory = test_directory("terminal-cleanup");
        let key = public_key('f');
        let outgoing_id = message_id(30);
        let incoming_id = message_id(31);
        let outgoing;
        let incoming = FileCardOffer {
            message_id: incoming_id.clone(),
            transfer_id: [31; TRANSFER_ID_BYTES],
            filename: "received.bin".to_string(),
            size: 31,
            pq_required: false,
        };
        {
            let engine = FileCardEngine::new(&directory).unwrap();
            outgoing = engine
                .offer_for_send(30, &key, &outgoing_id, "sent.bin", 30)
                .unwrap();
            engine
                .acknowledge_offer(
                    30,
                    &key,
                    &ack_for_offer(&outgoing, FileCardAckStatus::Applied),
                )
                .unwrap();
            engine.apply_incoming_offer(30, &key, &incoming).unwrap();

            engine.finish_message(30, &key, &outgoing_id).unwrap();
            engine.finish_message(30, &key, &outgoing_id).unwrap();
            engine.finish_message(30, &key, &incoming_id).unwrap();
            assert!(engine
                .binding_by_transfer_id(30, &key, outgoing.transfer_id)
                .is_none());
            assert!(engine
                .binding_by_transfer_id(30, &key, incoming.transfer_id)
                .is_none());
            assert!(engine.outgoing_offer(30, &key, &outgoing_id).is_none());
        }

        let restarted = FileCardEngine::new(&directory).unwrap();
        assert!(restarted
            .binding_by_transfer_id(30, &key, outgoing.transfer_id)
            .is_none());
        assert!(restarted
            .binding_by_transfer_id(30, &key, incoming.transfer_id)
            .is_none());
        assert!(restarted.due_offers(u64::MAX).is_empty());
        drop(restarted);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn scoped_retain_keeps_active_unacked_and_unrelated_friend_across_restart() {
        let directory = test_directory("scoped-retain");
        let first_key = public_key('6');
        let second_key = public_key('7');
        let unacked_id = message_id(40);
        let active_id = message_id(41);
        let stale_id = message_id(42);
        let unrelated_id = message_id(43);
        let unacked;
        let active;
        let stale = FileCardOffer {
            message_id: stale_id.clone(),
            transfer_id: [42; TRANSFER_ID_BYTES],
            filename: "stale.bin".to_string(),
            size: 42,
            pq_required: false,
        };
        let unrelated = FileCardOffer {
            message_id: unrelated_id,
            transfer_id: [43; TRANSFER_ID_BYTES],
            filename: "other.bin".to_string(),
            size: 43,
            pq_required: false,
        };
        {
            let engine = FileCardEngine::new(&directory).unwrap();
            unacked = engine
                .offer_for_send(40, &first_key, &unacked_id, "pending.bin", 40)
                .unwrap();
            active = engine
                .offer_for_send(40, &first_key, &active_id, "active.bin", 41)
                .unwrap();
            engine
                .acknowledge_offer(
                    40,
                    &first_key,
                    &ack_for_offer(&active, FileCardAckStatus::Applied),
                )
                .unwrap();
            engine.apply_incoming_offer(40, &first_key, &stale).unwrap();
            engine
                .apply_incoming_offer(43, &second_key, &unrelated)
                .unwrap();

            engine
                .retain_friend_messages(40, &first_key, &HashSet::from([active_id.clone()]))
                .unwrap();
            assert!(
                engine
                    .binding_by_transfer_id(40, &first_key, unacked.transfer_id)
                    .is_some(),
                "unacknowledged outgoing state cannot be pruned implicitly"
            );
            assert!(
                engine
                    .binding_by_transfer_id(40, &first_key, active.transfer_id)
                    .is_some(),
                "an explicitly active message survives scoped history cleanup"
            );
            assert!(engine
                .binding_by_transfer_id(40, &first_key, stale.transfer_id)
                .is_none());
            assert!(
                engine
                    .binding_by_transfer_id(43, &second_key, unrelated.transfer_id)
                    .is_some(),
                "scoped cleanup cannot touch another friend"
            );
        }

        let restarted = FileCardEngine::new(&directory).unwrap();
        assert!(restarted
            .binding_by_transfer_id(40, &first_key, unacked.transfer_id)
            .is_some());
        assert!(restarted
            .binding_by_transfer_id(40, &first_key, active.transfer_id)
            .is_some());
        assert!(restarted
            .binding_by_transfer_id(40, &first_key, stale.transfer_id)
            .is_none());
        assert!(restarted
            .binding_by_transfer_id(43, &second_key, unrelated.transfer_id)
            .is_some());
        drop(restarted);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn global_retain_keeps_only_selected_or_unacknowledged_bindings() {
        let directory = test_directory("global-retain");
        let first_key = public_key('8');
        let second_key = public_key('9');
        let selected_id = message_id(50);
        let stale_id = message_id(51);
        let pending_id = message_id(52);
        let selected;
        let stale;
        let pending;
        {
            let engine = FileCardEngine::new(&directory).unwrap();
            selected = engine
                .offer_for_send(50, &first_key, &selected_id, "same.bin", 100)
                .unwrap();
            stale = engine
                .offer_for_send(50, &first_key, &stale_id, "same.bin", 100)
                .unwrap();
            pending = engine
                .offer_for_send(52, &second_key, &pending_id, "pending.bin", 52)
                .unwrap();
            for offer in [&selected, &stale] {
                engine
                    .acknowledge_offer(
                        50,
                        &first_key,
                        &ack_for_offer(offer, FileCardAckStatus::Applied),
                    )
                    .unwrap();
            }
            engine
                .retain_messages(|binding| binding.message_id == selected_id)
                .unwrap();
        }

        let restarted = FileCardEngine::new(&directory).unwrap();
        assert!(
            restarted
                .binding_by_transfer_id(50, &first_key, selected.transfer_id)
                .is_some(),
            "the selected active card survives global history cleanup"
        );
        assert!(restarted
            .binding_by_transfer_id(50, &first_key, stale.transfer_id)
            .is_none());
        assert!(
            restarted
                .binding_by_transfer_id(52, &second_key, pending.transfer_id)
                .is_some(),
            "global cleanup preserves an unacknowledged offer without an explicit retain match"
        );
        assert_eq!(restarted.due_offers(u64::MAX).len(), 1);
        drop(restarted);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn friend_purge_and_global_clear_remove_durable_bindings() {
        let directory = test_directory("purge");
        let first_key = public_key('1');
        let second_key = public_key('2');
        let engine = FileCardEngine::new(&directory).unwrap();
        let first = engine
            .offer_for_send(1, &first_key, &message_id(10), "a", 1)
            .unwrap();
        let second = engine
            .offer_for_send(2, &second_key, &message_id(20), "b", 2)
            .unwrap();
        engine.remove_friend(100, &first_key).unwrap();
        assert!(engine
            .binding_by_transfer_id(1, &first_key, first.transfer_id)
            .is_none());
        assert!(engine
            .binding_by_transfer_id(2, &second_key, second.transfer_id)
            .is_some());
        assert_eq!(engine.due_offers(0).len(), 1);

        engine.clear().unwrap();
        assert!(engine.due_offers(0).is_empty());
        assert!(engine
            .binding_by_transfer_id(2, &second_key, second.transfer_id)
            .is_none());
        drop(engine);
        fs::remove_dir_all(directory).unwrap();
    }
}
