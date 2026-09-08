use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::profiles;

pub const VERSION: u8 = 1;
pub const PACKET_ID: u8 = 181;
pub const MAX_OWN_REACTIONS: usize = 3;
pub const MAX_REACTION_CHANGES_PER_MINUTE: usize = 4;
pub const REACTION_WINDOW_SECONDS: u64 = 60;
pub const REACTION_ELIGIBLE_MESSAGE_COUNT: usize = 50;

const MAGIC: &[u8; 3] = b"KCH";
const HEADER_SIZE: usize = 6;
const KIND_CAPABILITY: u8 = 1;
const KIND_CAPABILITY_ACK: u8 = 2;
const KIND_REACTION_STATE: u8 = 3;
const KIND_REACTION_ACK: u8 = 4;
// v1 peers must explicitly advertise the file-card binding bit as well as
// stable text IDs, reactions, quotes, and formatting. This keeps an older v1
// implementation from being mistaken for one that understands KFC packets.
const CAPABILITIES: u32 = 0b1_1111;
const MESSAGE_PREFIX: &str = "~KAI1~|";
const PQ_MESSAGE_PREFIX: &str = "~KAI-PQ-MSG1~|";
const PQ_SERVICE_PREFIX: &str = "~KAI-PQ-SVC1~|";
const MESSAGE_FRAGMENT_BYTES: usize = 1_000;
const MAX_MESSAGE_WIRE_BYTES: usize = 256 * 1024;
const MAX_MESSAGE_FRAGMENTS: usize = MAX_MESSAGE_WIRE_BYTES / MESSAGE_FRAGMENT_BYTES + 1;
const MAX_PARTIAL_MESSAGES: usize = 16;
const MAX_PARTIAL_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_FORMAT_SPANS: usize = 128;
const MAX_QUOTE_BYTES: usize = 64 * 1024;
const PARTIAL_MESSAGE_TTL_SECONDS: u64 = 10 * 60;
const REACTION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const MAX_REACTION_OPERATIONS: usize = 4_096;
const MAX_REACTION_OPERATIONS_PER_FRIEND: usize = 256;
const MAX_REACTION_OUTBOX: usize = 1_024;
const MAX_REACTION_OUTBOX_PER_FRIEND: usize = 64;
const MAX_REACTION_RECORDS: usize = 4_096;
const MAX_REACTION_REPLAYS: usize = 4_096;
const MAX_REACTION_REPLAYS_PER_FRIEND: usize = 256;
const MAX_MESSAGE_OPERATIONS: usize = 4_096;
const MAX_ACCEPTED_MESSAGES: usize = 4_096;
const MAX_PEER_REACTION_EVENTS: usize = 4_096;
const MAX_PEER_REACTION_EVENTS_PER_FRIEND: usize = 256;
pub const MAX_PEER_REACTION_EVENT_PAGE: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReactionCode {
    ThumbsUp,
    ThumbsDown,
    Grin,
    Sad,
    Heart,
    Rocket,
}

impl ReactionCode {
    fn wire(self) -> u8 {
        match self {
            Self::ThumbsUp => 1,
            Self::ThumbsDown => 2,
            Self::Grin => 3,
            Self::Sad => 4,
            Self::Heart => 5,
            Self::Rocket => 6,
        }
    }

    fn from_wire(value: u8) -> Result<Self, String> {
        match value {
            1 => Ok(Self::ThumbsUp),
            2 => Ok(Self::ThumbsDown),
            3 => Ok(Self::Grin),
            4 => Ok(Self::Sad),
            5 => Ok(Self::Heart),
            6 => Ok(Self::Rocket),
            _ => Err("CHAT_REACTION_CODE_INVALID".to_string()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextFormatKind {
    Bold,
    Underline,
    Italic,
    Strikethrough,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFormatSpan {
    pub kind: TextFormatKind,
    pub offset_utf16: u32,
    pub length_utf16: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQuote {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub author: String,
    pub text: String,
    #[serde(default)]
    pub legacy: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEnvelope {
    pub version: u8,
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<ChatQuote>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub formatting: Vec<TextFormatSpan>,
    #[serde(default)]
    pub pq_protected: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReactionDelivery {
    Pending,
    Delivered,
    Rejected,
}

impl Default for ReactionDelivery {
    fn default() -> Self {
        Self::Delivered
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionView {
    #[serde(default)]
    pub mine: Vec<ReactionCode>,
    #[serde(default)]
    pub peer: Vec<ReactionCode>,
    #[serde(default)]
    pub mine_revision: u64,
    #[serde(default)]
    pub peer_revision: u64,
    #[serde(default)]
    pub delivery: ReactionDelivery,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerReactionEvent {
    pub event_revision: u64,
    pub message_id: String,
    pub peer_revision: u64,
    #[serde(default)]
    pub added: Vec<ReactionCode>,
    #[serde(default)]
    pub removed: Vec<ReactionCode>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct IncomingReaction {
    pub target_id: String,
    pub revision: u64,
    pub reactions: Vec<ReactionCode>,
    pub pq_required: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReactionAckStatus {
    Applied,
    Duplicate,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IncomingReactionAck {
    pub target_id: String,
    pub revision: u64,
    pub status: ReactionAckStatus,
    pub pq_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IncomingPacket {
    Capability { acknowledgement: Vec<u8> },
    CapabilityAcknowledged,
    Reaction(IncomingReaction),
    ReactionAck(IncomingReactionAck),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReactionRecord {
    #[serde(default)]
    local: Vec<ReactionCode>,
    #[serde(default)]
    peer: Vec<ReactionCode>,
    #[serde(default)]
    local_revision: u64,
    #[serde(default)]
    peer_revision: u64,
    #[serde(default)]
    peer_pq_required: Option<bool>,
    #[serde(default)]
    local_pq_required: Option<bool>,
    #[serde(default)]
    local_delivery: ReactionDelivery,
    #[serde(default)]
    updated_sequence: u64,
}

impl Default for ReactionRecord {
    fn default() -> Self {
        Self {
            local: Vec::new(),
            peer: Vec::new(),
            local_revision: 0,
            peer_revision: 0,
            peer_pq_required: None,
            local_pq_required: None,
            local_delivery: ReactionDelivery::Delivered,
            updated_sequence: 0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReactionOperation {
    target_id: String,
    reactions: Vec<ReactionCode>,
    revision: u64,
    pq_required: bool,
    created_at: u64,
    result: ReactionView,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageOperation {
    pub friend_number: u32,
    pub friend_public_key: String,
    pub operation_id: String,
    pub payload_fingerprint: String,
    pub message_id: String,
    pub protocol_version: Option<u8>,
    pub pq_required: bool,
    pub timestamp: u64,
    pub delivery: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PendingReaction {
    pub friend_number: u32,
    pub friend_public_key: String,
    pub target_id: String,
    pub revision: u64,
    pub reactions: Vec<ReactionCode>,
    pub pq_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PartialMessage {
    total: usize,
    parts: Vec<Option<String>>,
    updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AcceptedMessage {
    friend_number: u32,
    friend_public_key: String,
    message_id: String,
    pq_required: bool,
    accepted_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredPeerReactionEvent {
    friend_number: u32,
    friend_public_key: String,
    event: PeerReactionEvent,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct StoredState {
    #[serde(default)]
    reactions: HashMap<String, ReactionRecord>,
    #[serde(default)]
    reaction_replays: HashMap<String, ReactionRecord>,
    #[serde(default)]
    reaction_outbox: Vec<PendingReaction>,
    #[serde(default)]
    reaction_operations: HashMap<String, ReactionOperation>,
    #[serde(default)]
    message_operations: HashMap<String, MessageOperation>,
    #[serde(default)]
    outgoing_rate: HashMap<String, Vec<u64>>,
    #[serde(default)]
    outgoing_rate_floor: HashMap<String, u64>,
    #[serde(default)]
    incoming_rate: HashMap<String, Vec<u64>>,
    #[serde(default)]
    incoming_rate_floor: HashMap<String, u64>,
    #[serde(default)]
    next_reaction_sequence: u64,
    #[serde(default)]
    partial_messages: HashMap<String, PartialMessage>,
    #[serde(default)]
    accepted_messages: HashMap<String, AcceptedMessage>,
    #[serde(default)]
    peer_reaction_events: Vec<StoredPeerReactionEvent>,
    /// Monotonic for the lifetime of this profile. History clearing removes
    /// pending rows but deliberately preserves this high-water mark, so a
    /// stale renderer response cannot make a newer event look old.
    #[serde(default)]
    next_peer_reaction_event_revision: u64,
    #[serde(default)]
    peer_reaction_latest: HashMap<String, u64>,
}

#[derive(Default)]
struct RuntimeState {
    supported_friends: HashSet<u32>,
    packet_outbox: Vec<(u32, Vec<u8>)>,
    last_reaction_attempt: HashMap<String, Instant>,
}

pub struct ChatProtocolEngine {
    path: PathBuf,
    stored: Mutex<StoredState>,
    runtime: Mutex<RuntimeState>,
}

impl ChatProtocolEngine {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join("chat-protocol-v1.json");
        let mut stored = match profiles::read_file(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "CHAT_PROTOCOL_STATE_INVALID".to_string())?,
            Err(_) => StoredState::default(),
        };
        let before = (
            stored.reactions.len(),
            stored.reaction_replays.len(),
            stored.reaction_operations.len(),
        );
        enforce_reaction_outbox_bounds(&stored)?;
        compact_reaction_records(&mut stored)?;
        prune_reaction_operations(&mut stored)?;
        if before
            != (
                stored.reactions.len(),
                stored.reaction_replays.len(),
                stored.reaction_operations.len(),
            )
        {
            persist_state(&path, &stored)?;
        }
        Ok(Self {
            path,
            stored: Mutex::new(stored),
            runtime: Mutex::new(RuntimeState::default()),
        })
    }

    pub fn capability_packet(&self) -> Vec<u8> {
        packet(KIND_CAPABILITY, &CAPABILITIES.to_be_bytes())
    }

    pub fn supports(&self, friend_number: u32) -> bool {
        self.runtime
            .lock()
            .map(|runtime| runtime.supported_friends.contains(&friend_number))
            .unwrap_or(false)
    }

    pub fn disconnected(&self, friend_number: u32) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.supported_friends.remove(&friend_number);
        }
    }

    pub fn is_packet(bytes: &[u8]) -> bool {
        bytes.len() >= HEADER_SIZE
            && bytes[0] == PACKET_ID
            && &bytes[1..4] == MAGIC
            && bytes[4] == VERSION
    }

    pub fn is_capability_packet(bytes: &[u8]) -> bool {
        Self::is_packet(bytes) && matches!(bytes[5], KIND_CAPABILITY | KIND_CAPABILITY_ACK)
    }

    pub fn handle_packet(
        &self,
        friend_number: u32,
        bytes: &[u8],
    ) -> Result<IncomingPacket, String> {
        if !Self::is_packet(bytes) {
            return Err("CHAT_PACKET_NOT_OURS".to_string());
        }
        let payload = &bytes[HEADER_SIZE..];
        match bytes[5] {
            KIND_CAPABILITY | KIND_CAPABILITY_ACK => {
                if payload != CAPABILITIES.to_be_bytes() {
                    return Err("CHAT_CAPABILITY_INVALID".to_string());
                }
                self.runtime
                    .lock()
                    .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?
                    .supported_friends
                    .insert(friend_number);
                if bytes[5] == KIND_CAPABILITY {
                    Ok(IncomingPacket::Capability {
                        acknowledgement: packet(KIND_CAPABILITY_ACK, &CAPABILITIES.to_be_bytes()),
                    })
                } else {
                    Ok(IncomingPacket::CapabilityAcknowledged)
                }
            }
            KIND_REACTION_STATE => Ok(IncomingPacket::Reaction(decode_reaction(payload)?)),
            KIND_REACTION_ACK => Ok(IncomingPacket::ReactionAck(decode_reaction_ack(payload)?)),
            _ => Err("CHAT_PACKET_KIND_INVALID".to_string()),
        }
    }

    pub fn queue_packet(&self, friend_number: u32, bytes: Vec<u8>) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.packet_outbox.push((friend_number, bytes));
        }
    }

    pub fn take_packet_outbox(&self) -> Vec<(u32, Vec<u8>)> {
        self.runtime
            .lock()
            .map(|mut runtime| std::mem::take(&mut runtime.packet_outbox))
            .unwrap_or_default()
    }

    pub fn requeue_packets_front(&self, mut packets: Vec<(u32, Vec<u8>)>) {
        if packets.is_empty() {
            return;
        }
        if let Ok(mut runtime) = self.runtime.lock() {
            packets.append(&mut runtime.packet_outbox);
            runtime.packet_outbox = packets;
        }
    }

    pub fn message_operation(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        operation_id: &str,
        payload_fingerprint: &str,
    ) -> Result<Option<MessageOperation>, String> {
        validate_operation_id(operation_id)?;
        validate_payload_fingerprint(payload_fingerprint)?;
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let key = message_operation_key(&friend_key, operation_id);
        let guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let Some(existing) = guard.message_operations.get(&key) else {
            return Ok(None);
        };
        if existing.payload_fingerprint != payload_fingerprint {
            return Err("CHAT_SEND_OPERATION_ID_REUSED".to_string());
        }
        Ok(Some(existing.clone()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reserve_message_operation(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        operation_id: &str,
        payload_fingerprint: &str,
        message_id: &str,
        protocol_version: Option<u8>,
        pq_required: bool,
        timestamp: u64,
    ) -> Result<MessageOperation, String> {
        validate_operation_id(operation_id)?;
        validate_payload_fingerprint(payload_fingerprint)?;
        if protocol_version == Some(VERSION) {
            validate_common_message_id(message_id)?;
        } else if message_id.is_empty() || message_id.len() > 128 {
            return Err("CHAT_MESSAGE_ID_INVALID".to_string());
        }
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let key = message_operation_key(&friend_key, operation_id);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        if let Some(existing) = guard.message_operations.get(&key) {
            if existing.payload_fingerprint != payload_fingerprint {
                return Err("CHAT_SEND_OPERATION_ID_REUSED".to_string());
            }
            return Ok(existing.clone());
        }
        let operation = MessageOperation {
            friend_number,
            friend_public_key: friend_public_key.to_string(),
            operation_id: operation_id.to_string(),
            payload_fingerprint: payload_fingerprint.to_string(),
            message_id: message_id.to_string(),
            protocol_version,
            pq_required,
            timestamp,
            delivery: "pending".to_string(),
            created_at: timestamp,
        };
        let mut next = guard.clone();
        next.message_operations.insert(key, operation.clone());
        prune_message_operations(&mut next)?;
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(operation)
    }

    pub fn update_message_operation_delivery(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
        delivery: &str,
    ) -> Result<(), String> {
        if !matches!(delivery, "pending" | "delivered" | "unknown_recovered") {
            return Err("CHAT_MESSAGE_DELIVERY_INVALID".to_string());
        }
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        if !guard.message_operations.values().any(|operation| {
            durable_friend_key(operation.friend_number, &operation.friend_public_key) == friend_key
                && operation.message_id == message_id
                && operation.delivery != delivery
        }) {
            return Ok(());
        }
        let mut next = guard.clone();
        for operation in next.message_operations.values_mut() {
            if durable_friend_key(operation.friend_number, &operation.friend_public_key)
                == friend_key
                && operation.message_id == message_id
            {
                operation.friend_number = friend_number;
                operation.friend_public_key = friend_public_key.to_string();
                operation.delivery = delivery.to_string();
            }
        }
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    /// Explicit user choice while first-contact capability is still unknown.
    /// This is never called by a timeout or by a negotiated PQ session.
    pub fn allow_message_without_pq_before_send(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
        protocol_version: Option<u8>,
    ) -> Result<(), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED")?;
        let mut next = guard.clone();
        for operation in next.message_operations.values_mut().filter(|operation| {
            durable_friend_key(operation.friend_number, &operation.friend_public_key) == friend_key
                && operation.message_id == message_id
        }) {
            if operation.delivery != "pending" {
                return Err("CHAT_OPERATION_ALREADY_SENT".into());
            }
            operation.pq_required = false;
            operation.protocol_version = protocol_version;
        }
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn update_local_reactions(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        target_id: &str,
        reactions: Vec<ReactionCode>,
        operation_id: Option<&str>,
        pq_required: bool,
        now: u64,
    ) -> Result<ReactionView, String> {
        validate_reactions(&reactions)?;
        validate_common_message_id(target_id)?;
        if let Some(operation_id) = operation_id {
            validate_operation_id(operation_id)?;
        }
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let record_key = reaction_key(&friend_key, target_id);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let operation_key =
            operation_id.map(|operation_id| format!("{friend_key}:operation:{operation_id}"));
        if let Some(operation_key) = operation_key.as_deref() {
            if let Some(existing) = guard.reaction_operations.get(operation_key) {
                if existing.target_id != target_id
                    || existing.reactions != reactions
                    || existing.pq_required != pq_required
                {
                    return Err("CHAT_REACTION_OPERATION_ID_REUSED".to_string());
                }
                return Ok(existing.result.clone());
            }
        }
        let mut next = guard.clone();
        if let Some(record) = next.reactions.get(&record_key) {
            if record.local == reactions && record.local_delivery != ReactionDelivery::Rejected {
                let current = view(record);
                if let Some(operation_key) = operation_key {
                    next.reaction_operations.insert(
                        operation_key,
                        ReactionOperation {
                            target_id: target_id.to_string(),
                            reactions,
                            revision: record.local_revision,
                            pq_required,
                            created_at: now,
                            result: current.clone(),
                        },
                    );
                    prune_reaction_operations(&mut next)?;
                    persist_state(&self.path, &next)?;
                    *guard = next;
                }
                return Ok(current);
            }
        }
        let (rate_admitted, rate_rebased) = admit_rate(
            &mut next.outgoing_rate,
            &mut next.outgoing_rate_floor,
            &friend_key,
            now,
        );
        if !rate_admitted {
            if rate_rebased {
                persist_state(&self.path, &next)?;
                *guard = next;
            }
            return Err("CHAT_REACTION_RATE_LIMIT".to_string());
        }
        restore_reaction_record(&mut next, &record_key);
        let local_revision = {
            next.next_reaction_sequence = next.next_reaction_sequence.saturating_add(1).max(1);
            let updated_sequence = next.next_reaction_sequence;
            let record = next.reactions.entry(record_key.clone()).or_default();
            record.local_revision = record.local_revision.saturating_add(1).max(1);
            record.local = reactions.clone();
            record.local_pq_required = Some(pq_required);
            record.local_delivery = ReactionDelivery::Pending;
            record.updated_sequence = updated_sequence;
            record.local_revision
        };
        next.reaction_outbox.retain(|item| {
            durable_friend_key(item.friend_number, &item.friend_public_key) != friend_key
                || item.target_id != target_id
        });
        next.reaction_outbox.push(PendingReaction {
            friend_number,
            friend_public_key: friend_public_key.to_string(),
            target_id: target_id.to_string(),
            revision: local_revision,
            reactions: reactions.clone(),
            pq_required,
        });
        enforce_reaction_outbox_bounds(&next)?;
        let view = next
            .reactions
            .get(&record_key)
            .map(view)
            .ok_or_else(|| "CHAT_REACTION_STATE_MISSING".to_string())?;
        if let Some(operation_key) = operation_key {
            next.reaction_operations.insert(
                operation_key,
                ReactionOperation {
                    target_id: target_id.to_string(),
                    reactions: reactions.clone(),
                    revision: local_revision,
                    pq_required,
                    created_at: now,
                    result: view.clone(),
                },
            );
        }
        compact_reaction_records(&mut next)?;
        prune_reaction_operations(&mut next)?;
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(view)
    }

    pub fn apply_incoming_reaction(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        reaction: &IncomingReaction,
        now: u64,
    ) -> Result<ReactionAckStatus, String> {
        validate_reactions(&reaction.reactions)?;
        validate_common_message_id(&reaction.target_id)?;
        if reaction.revision == 0 {
            return Err("CHAT_REACTION_REVISION_INVALID".to_string());
        }
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let record_key = reaction_key(&friend_key, &reaction.target_id);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        if let Some(record) = peer_reaction_record(&guard, &record_key) {
            if reaction.revision <= record.peer_revision {
                if record.peer_pq_required != Some(reaction.pq_required) {
                    return Err("CHAT_REACTION_PQ_POLICY_MISMATCH".to_string());
                }
                if reaction.revision == record.peer_revision && record.peer != reaction.reactions {
                    return Err("CHAT_REACTION_REVISION_CONFLICT".to_string());
                }
                return Ok(ReactionAckStatus::Duplicate);
            }
        }
        let mut next = guard.clone();
        let (rate_admitted, rate_rebased) = admit_rate(
            &mut next.incoming_rate,
            &mut next.incoming_rate_floor,
            &friend_key,
            now,
        );
        if !rate_admitted {
            if rate_rebased {
                persist_state(&self.path, &next)?;
                *guard = next;
            }
            return Err("CHAT_REACTION_PEER_RATE_LIMIT".to_string());
        }
        let previous_peer = peer_reaction_record(&next, &record_key)
            .map(|record| record.peer.clone())
            .unwrap_or_default();
        restore_reaction_record(&mut next, &record_key);
        next.next_reaction_sequence = next.next_reaction_sequence.saturating_add(1).max(1);
        let updated_sequence = next.next_reaction_sequence;
        let record = next.reactions.entry(record_key).or_default();
        record.peer_revision = reaction.revision;
        record.peer = reaction.reactions.clone();
        record.peer_pq_required = Some(reaction.pq_required);
        record.updated_sequence = updated_sequence;
        let added = reaction
            .reactions
            .iter()
            .copied()
            .filter(|code| !previous_peer.contains(code))
            .collect::<Vec<_>>();
        let removed = previous_peer
            .iter()
            .copied()
            .filter(|code| !reaction.reactions.contains(code))
            .collect::<Vec<_>>();
        if !added.is_empty() || !removed.is_empty() {
            next.next_peer_reaction_event_revision = next
                .next_peer_reaction_event_revision
                .saturating_add(1)
                .max(1);
            next.peer_reaction_events.push(StoredPeerReactionEvent {
                friend_number,
                friend_public_key: friend_public_key.to_string(),
                event: PeerReactionEvent {
                    event_revision: next.next_peer_reaction_event_revision,
                    message_id: reaction.target_id.clone(),
                    peer_revision: reaction.revision,
                    added,
                    removed,
                    created_at: now,
                },
            });
            next.peer_reaction_latest
                .insert(friend_key.clone(), next.next_peer_reaction_event_revision);
            prune_peer_reaction_events(&mut next, &friend_key);
        }
        compact_reaction_records(&mut next)?;
        prune_reaction_operations(&mut next)?;
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(ReactionAckStatus::Applied)
    }

    pub fn acknowledge_reaction(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        acknowledgement: &IncomingReactionAck,
    ) -> Result<(), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let record_key = reaction_key(&friend_key, &acknowledgement.target_id);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let Some(record) = guard.reactions.get(&record_key) else {
            return Ok(());
        };
        if record.local_revision != acknowledgement.revision {
            return Ok(());
        }
        if record.local_pq_required != Some(acknowledgement.pq_required) {
            return Err("CHAT_REACTION_ACK_PQ_POLICY_MISMATCH".to_string());
        }
        let mut next = guard.clone();
        if let Some(record) = next.reactions.get_mut(&record_key) {
            record.local_delivery = match acknowledgement.status {
                ReactionAckStatus::Applied | ReactionAckStatus::Duplicate => {
                    ReactionDelivery::Delivered
                }
                ReactionAckStatus::Rejected => ReactionDelivery::Rejected,
            };
        }
        let delivery = next
            .reactions
            .get(&record_key)
            .map(|record| record.local_delivery.clone());
        if let Some(delivery) = delivery {
            for operation in next.reaction_operations.values_mut() {
                if operation.target_id == acknowledgement.target_id
                    && operation.revision == acknowledgement.revision
                    && operation.pq_required == acknowledgement.pq_required
                {
                    operation.result.delivery = delivery.clone();
                }
            }
        }
        next.reaction_outbox.retain(|item| {
            durable_friend_key(item.friend_number, &item.friend_public_key) != friend_key
                || item.target_id != acknowledgement.target_id
                || item.revision != acknowledgement.revision
        });
        compact_reaction_records(&mut next)?;
        prune_reaction_operations(&mut next)?;
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn reaction_view(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        target_id: &str,
    ) -> Option<ReactionView> {
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        self.stored
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .reactions
                    .get(&reaction_key(&friend_key, target_id))
                    .cloned()
            })
            .map(|record| view(&record))
            .filter(|view| {
                !view.mine.is_empty()
                    || !view.peer.is_empty()
                    || view.mine_revision > 0
                    || view.peer_revision > 0
            })
    }

    /// Keeps protocol state for the exact current reaction window. Callers
    /// persist each current `ReactionView` into the history row before this
    /// reconciliation; live outbox entries remain durable even after their
    /// target has aged out of the last-50 window.
    pub fn retain_reaction_targets(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        eligible_target_ids: &HashSet<String>,
    ) -> Result<(), String> {
        for target_id in eligible_target_ids {
            validate_common_message_id(target_id)?;
        }
        let eligible = eligible_target_ids
            .iter()
            .map(|target_id| target_id.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let prefix = format!("{friend_key}:");
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let pending_records = pending_reaction_record_keys(&guard);
        let live_operations = live_reaction_operation_keys(&guard);
        let mut next = guard.clone();
        let remove_records = next
            .reactions
            .keys()
            .filter(|key| {
                key.starts_with(&prefix)
                    && !key.rsplit_once(':').is_some_and(|(_, target_id)| {
                        eligible.contains(&target_id.to_ascii_lowercase())
                    })
                    && !pending_records.contains(*key)
            })
            .cloned()
            .collect::<HashSet<_>>();
        remove_reaction_records(&mut next, &remove_records);
        next.reaction_operations.retain(|key, operation| {
            reaction_operation_friend_key(key) != Some(friend_key.as_str())
                || eligible.contains(&operation.target_id.to_ascii_lowercase())
                || live_operations.contains(key)
        });
        compact_reaction_records(&mut next)?;
        prune_reaction_operations(&mut next)?;
        if next.reactions.len() == guard.reactions.len()
            && next.reaction_replays.len() == guard.reaction_replays.len()
            && next.reaction_operations.len() == guard.reaction_operations.len()
        {
            return Ok(());
        }
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn peer_reaction_events(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        after_revision: u64,
        limit: usize,
    ) -> Result<(Vec<PeerReactionEvent>, u64), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let events = guard
            .peer_reaction_events
            .iter()
            .filter(|stored| {
                durable_friend_key(stored.friend_number, &stored.friend_public_key) == friend_key
                    && stored.event.event_revision > after_revision
            })
            .take(limit.clamp(1, MAX_PEER_REACTION_EVENT_PAGE))
            .map(|stored| stored.event.clone())
            .collect::<Vec<_>>();
        let latest = guard
            .peer_reaction_latest
            .get(&friend_key)
            .copied()
            .unwrap_or(0);
        Ok((events, latest))
    }

    pub fn acknowledge_peer_reaction_events(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        through_revision: u64,
    ) -> Result<(), String> {
        if through_revision == 0 {
            return Ok(());
        }
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        if !guard.peer_reaction_events.iter().any(|stored| {
            durable_friend_key(stored.friend_number, &stored.friend_public_key) == friend_key
                && stored.event.event_revision <= through_revision
        }) {
            return Ok(());
        }
        let mut next = guard.clone();
        next.peer_reaction_events.retain(|stored| {
            durable_friend_key(stored.friend_number, &stored.friend_public_key) != friend_key
                || stored.event.event_revision > through_revision
        });
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn pending_peer_reaction_revisions(&self) -> Vec<(u32, String, u64)> {
        let Ok(guard) = self.stored.lock() else {
            return Vec::new();
        };
        let mut pending = HashMap::<String, (u32, String, u64)>::new();
        for stored in &guard.peer_reaction_events {
            let friend_key = durable_friend_key(stored.friend_number, &stored.friend_public_key);
            let entry = pending.entry(friend_key).or_insert_with(|| {
                (
                    stored.friend_number,
                    stored.friend_public_key.clone(),
                    stored.event.event_revision,
                )
            });
            entry.0 = stored.friend_number;
            entry.1 = stored.friend_public_key.clone();
            entry.2 = entry.2.max(stored.event.event_revision);
        }
        pending.into_values().collect()
    }

    /// Returns a durable duplicate decision before the current last-50 policy
    /// is evaluated. This lets a retransmission receive the same ACK after the
    /// original target ages out, while still binding it to its original PQ
    /// transport policy.
    pub fn incoming_reaction_replay_status(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        reaction: &IncomingReaction,
    ) -> Result<Option<ReactionAckStatus>, String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let record_key = reaction_key(&friend_key, &reaction.target_id);
        let guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let Some(record) = peer_reaction_record(&guard, &record_key) else {
            return Ok(None);
        };
        if reaction.revision > record.peer_revision {
            return Ok(None);
        }
        if record.peer_pq_required != Some(reaction.pq_required) {
            return Ok(Some(ReactionAckStatus::Rejected));
        }
        if reaction.revision == record.peer_revision && record.peer != reaction.reactions {
            return Ok(Some(ReactionAckStatus::Rejected));
        }
        Ok(Some(ReactionAckStatus::Duplicate))
    }

    pub fn due_reactions(&self, now: Instant) -> Vec<PendingReaction> {
        let pending = self
            .stored
            .lock()
            .map(|state| state.reaction_outbox.clone())
            .unwrap_or_default();
        let Ok(runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        pending
            .into_iter()
            .filter(|item| {
                let key = pending_key(item);
                runtime.last_reaction_attempt.get(&key).is_none_or(|last| {
                    now.saturating_duration_since(*last) >= REACTION_RETRY_INTERVAL
                })
            })
            .collect()
    }

    pub fn mark_reaction_attempted(&self, item: &PendingReaction, now: Instant) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.last_reaction_attempt.insert(pending_key(item), now);
        }
    }

    pub fn accept_message_fragment(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        wire_text: &str,
        now: u64,
    ) -> Result<Option<MessageEnvelope>, String> {
        let Some((id, index, total, part)) = decode_message_fragment(wire_text)? else {
            return Ok(None);
        };
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let key = reaction_key(&friend_key, &id);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let mut next = guard.clone();
        next.partial_messages.retain(|_, partial| {
            now.saturating_sub(partial.updated_at) <= PARTIAL_MESSAGE_TTL_SECONDS
        });
        if !next.partial_messages.contains_key(&key)
            && next.partial_messages.len() >= MAX_PARTIAL_MESSAGES
        {
            return Err("CHAT_MESSAGE_REASSEMBLY_LIMIT".to_string());
        }
        if let Some(existing) = next.partial_messages.get(&key) {
            if existing.total != total || existing.parts.len() != total {
                return Err("CHAT_MESSAGE_FRAGMENT_CONFLICT".to_string());
            }
            if existing.parts[index]
                .as_ref()
                .is_some_and(|existing| existing != &part)
            {
                return Err("CHAT_MESSAGE_FRAGMENT_CONFLICT".to_string());
            }
        }
        let additional_bytes = next
            .partial_messages
            .get(&key)
            .and_then(|partial| partial.parts.get(index))
            .and_then(Option::as_ref)
            .map_or(part.len(), |_| 0);
        let aggregate_bytes = next
            .partial_messages
            .values()
            .flat_map(|partial| partial.parts.iter().flatten())
            .map(String::len)
            .sum::<usize>();
        if aggregate_bytes.saturating_add(additional_bytes) > MAX_PARTIAL_MESSAGE_BYTES {
            return Err("CHAT_MESSAGE_REASSEMBLY_LIMIT".to_string());
        }
        let partial = next
            .partial_messages
            .entry(key)
            .or_insert_with(|| PartialMessage {
                total,
                parts: vec![None; total],
                updated_at: now,
            });
        if partial.total != total || partial.parts.len() != total {
            return Err("CHAT_MESSAGE_FRAGMENT_CONFLICT".to_string());
        }
        if let Some(existing) = &partial.parts[index] {
            if existing != &part {
                return Err("CHAT_MESSAGE_FRAGMENT_CONFLICT".to_string());
            }
        } else {
            partial.parts[index] = Some(part);
        }
        partial.updated_at = now;
        persist_state(&self.path, &next)?;
        let complete = next
            .partial_messages
            .get(&reaction_key(&friend_key, &id))
            .filter(|partial| partial.parts.iter().all(Option::is_some))
            .map(|partial| partial.parts.iter().flatten().cloned().collect::<String>());
        *guard = next;
        let Some(serialized) = complete else {
            return Ok(None);
        };
        let envelope: MessageEnvelope = serde_json::from_str(&serialized)
            .map_err(|_| "CHAT_MESSAGE_ENVELOPE_INVALID".to_string())?;
        validate_envelope(&envelope)?;
        if envelope.id != id {
            return Err("CHAT_MESSAGE_ID_CONFLICT".to_string());
        }
        Ok(Some(envelope))
    }

    pub fn finish_message(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let key = reaction_key(&friend_key, message_id);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        if !guard.partial_messages.contains_key(&key) {
            return Ok(());
        }
        let mut next = guard.clone();
        next.partial_messages.remove(&key);
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn accepted_incoming_message(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
        pq_required: bool,
    ) -> Result<bool, String> {
        validate_common_message_id(message_id)?;
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let key = reaction_key(&friend_key, message_id);
        let guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let Some(existing) = guard.accepted_messages.get(&key) else {
            return Ok(false);
        };
        if existing.pq_required != pq_required {
            return Err("CHAT_MESSAGE_PQ_POLICY_MISMATCH".to_string());
        }
        Ok(true)
    }

    pub fn remember_incoming_message(
        &self,
        friend_number: u32,
        friend_public_key: &str,
        message_id: &str,
        pq_required: bool,
        accepted_at: u64,
    ) -> Result<(), String> {
        validate_common_message_id(message_id)?;
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let key = reaction_key(&friend_key, message_id);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        if let Some(existing) = guard.accepted_messages.get(&key) {
            return if existing.pq_required == pq_required {
                Ok(())
            } else {
                Err("CHAT_MESSAGE_PQ_POLICY_MISMATCH".to_string())
            };
        }
        let mut next = guard.clone();
        next.accepted_messages.insert(
            key,
            AcceptedMessage {
                friend_number,
                friend_public_key: friend_public_key.to_string(),
                message_id: message_id.to_string(),
                pq_required,
                accepted_at,
            },
        );
        if next.accepted_messages.len() > MAX_ACCEPTED_MESSAGES {
            let overflow = next.accepted_messages.len() - MAX_ACCEPTED_MESSAGES;
            let mut oldest = next
                .accepted_messages
                .iter()
                .map(|(key, message)| (key.clone(), message.accepted_at))
                .collect::<Vec<_>>();
            oldest.sort_by_key(|(key, accepted_at)| (*accepted_at, key.clone()));
            for (key, _) in oldest.into_iter().take(overflow) {
                next.accepted_messages.remove(&key);
            }
        }
        persist_state(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    pub fn clear_friend_history_state(
        &self,
        friend_number: u32,
        friend_public_key: &str,
    ) -> Result<(), String> {
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let prefix = format!("{friend_key}:");
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let mut next = guard.clone();
        next.reactions.retain(|key, _| !key.starts_with(&prefix));
        next.reaction_replays
            .retain(|key, _| !key.starts_with(&prefix));
        next.reaction_operations
            .retain(|key, _| !key.starts_with(&prefix));
        next.message_operations
            .retain(|key, _| !key.starts_with(&prefix));
        next.partial_messages
            .retain(|key, _| !key.starts_with(&prefix));
        next.accepted_messages
            .retain(|key, _| !key.starts_with(&prefix));
        next.peer_reaction_events.retain(|stored| {
            durable_friend_key(stored.friend_number, &stored.friend_public_key) != friend_key
        });
        next.outgoing_rate.remove(&friend_key);
        next.outgoing_rate_floor.remove(&friend_key);
        next.incoming_rate.remove(&friend_key);
        next.incoming_rate_floor.remove(&friend_key);
        next.reaction_outbox.retain(|item| {
            durable_friend_key(item.friend_number, &item.friend_public_key) != friend_key
        });
        persist_state(&self.path, &next)?;
        *guard = next;
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime
                .packet_outbox
                .retain(|(friend, _)| *friend != friend_number);
            runtime
                .last_reaction_attempt
                .retain(|key, _| !key.starts_with(&prefix));
        }
        Ok(())
    }

    pub fn remove_friend(&self, friend_number: u32, friend_public_key: &str) -> Result<(), String> {
        self.clear_friend_history_state(friend_number, friend_public_key)?;
        let friend_key = durable_friend_key(friend_number, friend_public_key);
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        if guard.peer_reaction_latest.remove(&friend_key).is_some() {
            persist_state(&self.path, &guard)?;
        }
        drop(guard);
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.supported_friends.remove(&friend_number);
        }
        Ok(())
    }

    pub fn clear_history_state(&self) -> Result<(), String> {
        let mut guard = self
            .stored
            .lock()
            .map_err(|_| "CHAT_PROTOCOL_LOCK_POISONED".to_string())?;
        let mut next = guard.clone();
        next.reactions.clear();
        next.reaction_replays.clear();
        next.reaction_outbox.clear();
        next.reaction_operations.clear();
        next.message_operations.clear();
        next.outgoing_rate.clear();
        next.outgoing_rate_floor.clear();
        next.incoming_rate.clear();
        next.incoming_rate_floor.clear();
        next.partial_messages.clear();
        next.accepted_messages.clear();
        next.peer_reaction_events.clear();
        // Keep both the global sequence and per-friend high-water marks. A
        // clear must not allow a late pre-clear renderer response to collide
        // with a future event revision.
        persist_state(&self.path, &next)?;
        *guard = next;
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.packet_outbox.clear();
            runtime.last_reaction_attempt.clear();
        }
        Ok(())
    }
}

pub fn new_common_message_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "CHAT_MESSAGE_ID_RANDOM_FAILED".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn encode_message_fragments(envelope: &MessageEnvelope) -> Result<Vec<String>, String> {
    validate_envelope(envelope)?;
    let serialized = serde_json::to_string(envelope)
        .map_err(|_| "CHAT_MESSAGE_ENVELOPE_ENCODE_FAILED".to_string())?;
    if serialized.len() > MAX_MESSAGE_WIRE_BYTES {
        return Err("CHAT_MESSAGE_TOO_LARGE".to_string());
    }
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < serialized.len() {
        let mut end = offset
            .saturating_add(MESSAGE_FRAGMENT_BYTES)
            .min(serialized.len());
        while end > offset && !serialized.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset {
            return Err("CHAT_MESSAGE_FRAGMENT_INVALID".to_string());
        }
        chunks.push(serialized[offset..end].to_string());
        offset = end;
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    if chunks.len() > MAX_MESSAGE_FRAGMENTS {
        return Err("CHAT_MESSAGE_TOO_LARGE".to_string());
    }
    let total = chunks.len();
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| format!("{MESSAGE_PREFIX}{}|{index}|{total}|{chunk}", envelope.id))
        .collect())
}

pub fn encode_pq_message(envelope: &MessageEnvelope) -> Result<String, String> {
    validate_envelope(envelope)?;
    let serialized = serde_json::to_string(envelope)
        .map_err(|_| "CHAT_MESSAGE_ENVELOPE_ENCODE_FAILED".to_string())?;
    if serialized.len() > MAX_MESSAGE_WIRE_BYTES {
        return Err("CHAT_MESSAGE_TOO_LARGE".to_string());
    }
    Ok(format!("{PQ_MESSAGE_PREFIX}{serialized}"))
}

pub fn decode_pq_message(text: &str) -> Result<Option<MessageEnvelope>, String> {
    let Some(serialized) = text.strip_prefix(PQ_MESSAGE_PREFIX) else {
        return Ok(None);
    };
    if serialized.len() > MAX_MESSAGE_WIRE_BYTES {
        return Err("CHAT_MESSAGE_TOO_LARGE".to_string());
    }
    let envelope: MessageEnvelope = serde_json::from_str(serialized)
        .map_err(|_| "CHAT_MESSAGE_ENVELOPE_INVALID".to_string())?;
    validate_envelope(&envelope)?;
    if !envelope.pq_protected {
        return Err("CHAT_MESSAGE_PQ_POLICY_MISMATCH".to_string());
    }
    Ok(Some(envelope))
}

pub fn is_message_fragment(text: &str) -> bool {
    text.starts_with(MESSAGE_PREFIX)
}

pub fn validate_envelope(envelope: &MessageEnvelope) -> Result<(), String> {
    if envelope.version != VERSION {
        return Err("CHAT_MESSAGE_VERSION_UNSUPPORTED".to_string());
    }
    validate_common_message_id(&envelope.id)?;
    if envelope.text.trim().is_empty() {
        return Err("CHAT_MESSAGE_EMPTY".to_string());
    }
    if envelope.text.len() > MAX_MESSAGE_WIRE_BYTES {
        return Err("CHAT_MESSAGE_TOO_LARGE".to_string());
    }
    validate_formatting(&envelope.text, &envelope.formatting)?;
    if let Some(quote) = &envelope.quote {
        if quote.legacy {
            if quote.message_id.is_some() {
                return Err("CHAT_QUOTE_LEGACY_TARGET_INVALID".to_string());
            }
            if !quote.author.is_empty() {
                return Err("CHAT_QUOTE_AUTHOR_INVALID".to_string());
            }
        } else {
            let target_id = quote
                .message_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "CHAT_QUOTE_TARGET_REQUIRED".to_string())?;
            validate_common_message_id(target_id)?;
            if !matches!(quote.author.as_str(), "self" | "peer") {
                return Err("CHAT_QUOTE_AUTHOR_INVALID".to_string());
            }
        }
        if quote.text.is_empty() {
            return Err("CHAT_QUOTE_TEXT_REQUIRED".to_string());
        }
        if quote.text.len() > MAX_QUOTE_BYTES {
            return Err("CHAT_QUOTE_TOO_LARGE".to_string());
        }
    }
    Ok(())
}

pub fn validate_formatting(text: &str, spans: &[TextFormatSpan]) -> Result<(), String> {
    if spans.len() > MAX_FORMAT_SPANS {
        return Err("CHAT_FORMAT_SPAN_LIMIT".to_string());
    }
    let mut boundaries = HashSet::from([0_u32]);
    let mut utf16 = 0_u32;
    for character in text.chars() {
        utf16 = utf16.saturating_add(character.len_utf16() as u32);
        boundaries.insert(utf16);
    }
    for span in spans {
        if span.length_utf16 == 0 {
            return Err("CHAT_FORMAT_SPAN_EMPTY".to_string());
        }
        let Some(end) = span.offset_utf16.checked_add(span.length_utf16) else {
            return Err("CHAT_FORMAT_SPAN_INVALID".to_string());
        };
        if !boundaries.contains(&span.offset_utf16) || !boundaries.contains(&end) {
            return Err("CHAT_FORMAT_SPAN_INVALID".to_string());
        }
    }
    Ok(())
}

pub fn qtox_quote_fallback(quote: &ChatQuote, body: &str) -> String {
    let normalized = normalize_line_breaks(&quote.text);
    let quoted = normalized
        .split('\n')
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{quoted}\n{body}")
}

pub fn parse_qtox_quote(text: &str) -> Option<(ChatQuote, String)> {
    let normalized = normalize_line_breaks(text);
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let quoted = lines
        .iter()
        .take_while(|line| line.starts_with("> "))
        .count();
    if quoted == 0 || quoted >= lines.len() {
        return None;
    }
    let body = lines[quoted..].join("\n");
    if body.trim().is_empty() {
        return None;
    }
    Some((
        ChatQuote {
            message_id: None,
            author: String::new(),
            text: lines[..quoted]
                .iter()
                .map(|line| &line[2..])
                .collect::<Vec<_>>()
                .join("\n"),
            legacy: true,
        },
        body,
    ))
}

pub fn encode_reaction_packet(item: &PendingReaction) -> Result<Vec<u8>, String> {
    validate_reactions(&item.reactions)?;
    validate_common_message_id(&item.target_id)?;
    if item.revision == 0 {
        return Err("CHAT_REACTION_REVISION_INVALID".to_string());
    }
    let mut payload = encode_target_and_revision(&item.target_id, item.revision)?;
    payload.push(u8::from(item.pq_required));
    payload.push(item.reactions.len() as u8);
    payload.extend(item.reactions.iter().copied().map(ReactionCode::wire));
    Ok(packet(KIND_REACTION_STATE, &payload))
}

pub fn encode_reaction_ack_packet(
    reaction: &IncomingReaction,
    status: ReactionAckStatus,
) -> Result<Vec<u8>, String> {
    let mut payload = encode_target_and_revision(&reaction.target_id, reaction.revision)?;
    payload.push(match status {
        ReactionAckStatus::Applied => 0,
        ReactionAckStatus::Duplicate => 1,
        ReactionAckStatus::Rejected => 2,
    });
    payload.push(u8::from(reaction.pq_required));
    Ok(packet(KIND_REACTION_ACK, &payload))
}

pub fn encode_pq_service_packet(packet: &[u8]) -> String {
    format!(
        "{PQ_SERVICE_PREFIX}{}",
        packet
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

pub fn decode_pq_service_packet(text: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(encoded) = text.strip_prefix(PQ_SERVICE_PREFIX) else {
        return Ok(None);
    };
    if encoded.len() % 2 != 0 || encoded.len() > 2_748 {
        return Err("CHAT_PQ_SERVICE_INVALID".to_string());
    }
    let mut bytes = Vec::with_capacity(encoded.len() / 2);
    for index in (0..encoded.len()).step_by(2) {
        bytes.push(
            u8::from_str_radix(&encoded[index..index + 2], 16)
                .map_err(|_| "CHAT_PQ_SERVICE_INVALID".to_string())?,
        );
    }
    if !ChatProtocolEngine::is_packet(&bytes) {
        return Err("CHAT_PQ_SERVICE_INVALID".to_string());
    }
    Ok(Some(bytes))
}

fn decode_message_fragment(text: &str) -> Result<Option<(String, usize, usize, String)>, String> {
    let Some(rest) = text.strip_prefix(MESSAGE_PREFIX) else {
        return Ok(None);
    };
    let mut parts = rest.splitn(4, '|');
    let id = parts
        .next()
        .ok_or_else(|| "CHAT_MESSAGE_FRAGMENT_INVALID".to_string())?
        .to_string();
    validate_common_message_id(&id)?;
    let index = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "CHAT_MESSAGE_FRAGMENT_INVALID".to_string())?;
    let total = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "CHAT_MESSAGE_FRAGMENT_INVALID".to_string())?;
    let part = parts
        .next()
        .ok_or_else(|| "CHAT_MESSAGE_FRAGMENT_INVALID".to_string())?
        .to_string();
    if total == 0 || total > MAX_MESSAGE_FRAGMENTS || index >= total {
        return Err("CHAT_MESSAGE_FRAGMENT_INVALID".to_string());
    }
    Ok(Some((id, index, total, part)))
}

fn decode_reaction(payload: &[u8]) -> Result<IncomingReaction, String> {
    let (target_id, revision, rest) = decode_target_and_revision(payload)?;
    if rest.len() < 2 {
        return Err("CHAT_REACTION_PACKET_INVALID".to_string());
    }
    let pq_required = match rest[0] {
        0 => false,
        1 => true,
        _ => return Err("CHAT_REACTION_PACKET_INVALID".to_string()),
    };
    let count = rest[1] as usize;
    if rest.len() != 2 + count {
        return Err("CHAT_REACTION_PACKET_INVALID".to_string());
    }
    let reactions = rest[2..]
        .iter()
        .copied()
        .map(ReactionCode::from_wire)
        .collect::<Result<Vec<_>, _>>()?;
    validate_reactions(&reactions)?;
    Ok(IncomingReaction {
        target_id,
        revision,
        reactions,
        pq_required,
    })
}

fn decode_reaction_ack(payload: &[u8]) -> Result<IncomingReactionAck, String> {
    let (target_id, revision, rest) = decode_target_and_revision(payload)?;
    if rest.len() != 2 {
        return Err("CHAT_REACTION_ACK_INVALID".to_string());
    }
    let status = match rest[0] {
        0 => ReactionAckStatus::Applied,
        1 => ReactionAckStatus::Duplicate,
        2 => ReactionAckStatus::Rejected,
        _ => return Err("CHAT_REACTION_ACK_INVALID".to_string()),
    };
    let pq_required = match rest[1] {
        0 => false,
        1 => true,
        _ => return Err("CHAT_REACTION_ACK_INVALID".to_string()),
    };
    Ok(IncomingReactionAck {
        target_id,
        revision,
        status,
        pq_required,
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

fn encode_target_and_revision(target_id: &str, revision: u64) -> Result<Vec<u8>, String> {
    validate_common_message_id(target_id)?;
    let mut payload = Vec::with_capacity(1 + target_id.len() + 8);
    payload.push(target_id.len() as u8);
    payload.extend_from_slice(target_id.as_bytes());
    payload.extend_from_slice(&revision.to_be_bytes());
    Ok(payload)
}

fn decode_target_and_revision(payload: &[u8]) -> Result<(String, u64, &[u8]), String> {
    let Some(length) = payload.first().copied().map(usize::from) else {
        return Err("CHAT_REACTION_PACKET_INVALID".to_string());
    };
    if payload.len() < 1 + length + 8 {
        return Err("CHAT_REACTION_PACKET_INVALID".to_string());
    }
    let target_id = std::str::from_utf8(&payload[1..1 + length])
        .map_err(|_| "CHAT_REACTION_PACKET_INVALID".to_string())?
        .to_string();
    validate_common_message_id(&target_id)?;
    let revision = u64::from_be_bytes(
        payload[1 + length..1 + length + 8]
            .try_into()
            .map_err(|_| "CHAT_REACTION_PACKET_INVALID".to_string())?,
    );
    if revision == 0 {
        return Err("CHAT_REACTION_REVISION_INVALID".to_string());
    }
    Ok((target_id, revision, &payload[1 + length + 8..]))
}

pub fn validate_common_message_id(value: &str) -> Result<(), String> {
    if value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("CHAT_MESSAGE_ID_INVALID".to_string())
    }
}

fn validate_reactions(reactions: &[ReactionCode]) -> Result<(), String> {
    if reactions.len() > MAX_OWN_REACTIONS {
        return Err("CHAT_REACTION_SELECTION_LIMIT".to_string());
    }
    let mut unique = HashSet::new();
    if reactions.iter().all(|reaction| unique.insert(*reaction)) {
        Ok(())
    } else {
        Err("CHAT_REACTION_DUPLICATE".to_string())
    }
}

fn admit_rate(
    rates: &mut HashMap<String, Vec<u64>>,
    floors: &mut HashMap<String, u64>,
    friend_key: &str,
    now: u64,
) -> (bool, bool) {
    let floor = floors.entry(friend_key.to_string()).or_insert(now);
    let rebased = now < *floor;
    let events = rates.entry(friend_key.to_string()).or_default();
    if rebased {
        for timestamp in events.iter_mut() {
            if *timestamp > now {
                *timestamp = now;
            }
        }
        *floor = now;
    }
    let logical_now = now.max(*floor);
    *floor = logical_now;
    events.retain(|timestamp| logical_now.saturating_sub(*timestamp) < REACTION_WINDOW_SECONDS);
    if events.len() >= MAX_REACTION_CHANGES_PER_MINUTE {
        return (false, rebased);
    }
    events.push(logical_now);
    (true, rebased)
}

fn reaction_operation_friend_key(key: &str) -> Option<&str> {
    key.split_once(":operation:")
        .map(|(friend_key, _)| friend_key)
}

fn pending_reaction_record_keys(state: &StoredState) -> HashSet<String> {
    state
        .reaction_outbox
        .iter()
        .map(|pending| {
            reaction_key(
                &durable_friend_key(pending.friend_number, &pending.friend_public_key),
                &pending.target_id,
            )
        })
        .collect()
}

fn live_reaction_operation_keys(state: &StoredState) -> HashSet<String> {
    state
        .reaction_operations
        .iter()
        .filter(|(key, operation)| {
            let Some(friend_key) = reaction_operation_friend_key(key) else {
                return false;
            };
            state.reaction_outbox.iter().any(|pending| {
                durable_friend_key(pending.friend_number, &pending.friend_public_key) == friend_key
                    && pending.target_id == operation.target_id
                    && pending.revision == operation.revision
                    && pending.pq_required == operation.pq_required
            })
        })
        .map(|(key, _)| key.clone())
        .collect()
}

fn enforce_reaction_outbox_bounds(state: &StoredState) -> Result<(), String> {
    if state.reaction_outbox.len() > MAX_REACTION_OUTBOX {
        return Err("CHAT_REACTION_OUTBOX_CAPACITY".to_string());
    }
    let mut per_friend = HashMap::<String, usize>::new();
    for pending in &state.reaction_outbox {
        let friend_key = durable_friend_key(pending.friend_number, &pending.friend_public_key);
        let count = per_friend.entry(friend_key).or_default();
        *count = count.saturating_add(1);
        if *count > MAX_REACTION_OUTBOX_PER_FRIEND {
            return Err("CHAT_REACTION_OUTBOX_CAPACITY".to_string());
        }
    }
    Ok(())
}

fn peer_reaction_record<'a>(state: &'a StoredState, key: &str) -> Option<&'a ReactionRecord> {
    match (state.reactions.get(key), state.reaction_replays.get(key)) {
        (Some(active), Some(replay)) if replay.peer_revision > active.peer_revision => Some(replay),
        (Some(active), _) => Some(active),
        (None, replay) => replay,
    }
}

fn restore_reaction_record(state: &mut StoredState, key: &str) {
    let Some(replay) = state.reaction_replays.remove(key) else {
        return;
    };
    let active = state.reactions.entry(key.to_string()).or_default();
    if replay.peer_revision > active.peer_revision {
        active.peer = replay.peer;
        active.peer_revision = replay.peer_revision;
        active.peer_pq_required = replay.peer_pq_required;
    }
    active.updated_sequence = active.updated_sequence.max(replay.updated_sequence);
}

fn archive_reaction_record(state: &mut StoredState, key: String, record: ReactionRecord) {
    if record.peer_revision == 0 {
        return;
    }
    if state
        .reaction_replays
        .get(&key)
        .is_some_and(|replay| replay.peer_revision > record.peer_revision)
    {
        return;
    }
    state.reaction_replays.insert(
        key,
        ReactionRecord {
            peer: record.peer,
            peer_revision: record.peer_revision,
            peer_pq_required: record.peer_pq_required,
            updated_sequence: record.updated_sequence,
            ..ReactionRecord::default()
        },
    );
}

fn remove_reaction_records(state: &mut StoredState, keys: &HashSet<String>) {
    for key in keys {
        if let Some(record) = state.reactions.remove(key) {
            archive_reaction_record(state, key.clone(), record);
        }
    }
    prune_reaction_replays(state);
}

fn prune_reaction_replays(state: &mut StoredState) {
    let mut per_friend = HashMap::<String, Vec<(String, u64)>>::new();
    for (key, replay) in &state.reaction_replays {
        let Some((friend_key, _)) = key.rsplit_once(':') else {
            continue;
        };
        per_friend
            .entry(friend_key.to_string())
            .or_default()
            .push((key.clone(), replay.updated_sequence));
    }
    let mut remove = HashSet::new();
    for replays in per_friend.values_mut() {
        replays.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        let overflow = replays
            .len()
            .saturating_sub(MAX_REACTION_REPLAYS_PER_FRIEND);
        remove.extend(replays.iter().take(overflow).map(|(key, _)| key.clone()));
    }
    state
        .reaction_replays
        .retain(|key, _| !remove.contains(key));

    let overflow = state
        .reaction_replays
        .len()
        .saturating_sub(MAX_REACTION_REPLAYS);
    if overflow == 0 {
        return;
    }
    let mut oldest = state
        .reaction_replays
        .iter()
        .map(|(key, replay)| (key.clone(), replay.updated_sequence))
        .collect::<Vec<_>>();
    oldest.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
    let remove = oldest
        .into_iter()
        .take(overflow)
        .map(|(key, _)| key)
        .collect::<HashSet<_>>();
    state
        .reaction_replays
        .retain(|key, _| !remove.contains(key));
}

fn compact_reaction_records(state: &mut StoredState) -> Result<(), String> {
    let pending = pending_reaction_record_keys(state);
    let mut per_friend = HashMap::<String, Vec<(String, u64)>>::new();
    for (key, record) in &state.reactions {
        if pending.contains(key) {
            continue;
        }
        let Some((friend_key, _)) = key.rsplit_once(':') else {
            continue;
        };
        per_friend
            .entry(friend_key.to_string())
            .or_default()
            .push((key.clone(), record.updated_sequence));
    }
    let mut remove = HashSet::new();
    for records in per_friend.values_mut() {
        records.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        let overflow = records
            .len()
            .saturating_sub(REACTION_ELIGIBLE_MESSAGE_COUNT);
        remove.extend(records.iter().take(overflow).map(|(key, _)| key.clone()));
    }
    remove_reaction_records(state, &remove);

    let overflow = state.reactions.len().saturating_sub(MAX_REACTION_RECORDS);
    if overflow > 0 {
        let mut evictable = state
            .reactions
            .iter()
            .filter(|(key, _)| !pending.contains(*key))
            .map(|(key, record)| (key.clone(), record.updated_sequence))
            .collect::<Vec<_>>();
        evictable.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        if evictable.len() < overflow {
            return Err("CHAT_REACTION_STATE_CAPACITY".to_string());
        }
        let remove = evictable
            .into_iter()
            .take(overflow)
            .map(|(key, _)| key)
            .collect::<HashSet<_>>();
        remove_reaction_records(state, &remove);
    }
    prune_reaction_replays(state);
    Ok(())
}

fn prune_reaction_operations(state: &mut StoredState) -> Result<(), String> {
    let live = live_reaction_operation_keys(state);
    let mut per_friend = HashMap::<String, Vec<(String, u64)>>::new();
    for (key, operation) in &state.reaction_operations {
        let friend_key = reaction_operation_friend_key(key).unwrap_or_default();
        per_friend
            .entry(friend_key.to_string())
            .or_default()
            .push((key.clone(), operation.created_at));
    }
    let mut remove = HashSet::new();
    for operations in per_friend.values_mut() {
        let overflow = operations
            .len()
            .saturating_sub(MAX_REACTION_OPERATIONS_PER_FRIEND);
        if overflow == 0 {
            continue;
        }
        let mut evictable = operations
            .iter()
            .filter(|(key, _)| !live.contains(key))
            .cloned()
            .collect::<Vec<_>>();
        evictable.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        if evictable.len() < overflow {
            return Err("CHAT_REACTION_OPERATION_CAPACITY".to_string());
        }
        remove.extend(evictable.into_iter().take(overflow).map(|(key, _)| key));
    }
    state
        .reaction_operations
        .retain(|key, _| !remove.contains(key));

    let overflow = state
        .reaction_operations
        .len()
        .saturating_sub(MAX_REACTION_OPERATIONS);
    if overflow > 0 {
        let mut evictable = state
            .reaction_operations
            .iter()
            .filter(|(key, _)| !live.contains(*key))
            .map(|(key, operation)| (key.clone(), operation.created_at))
            .collect::<Vec<_>>();
        evictable.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        if evictable.len() < overflow {
            return Err("CHAT_REACTION_OPERATION_CAPACITY".to_string());
        }
        let remove = evictable
            .into_iter()
            .take(overflow)
            .map(|(key, _)| key)
            .collect::<HashSet<_>>();
        state
            .reaction_operations
            .retain(|key, _| !remove.contains(key));
    }
    Ok(())
}

fn durable_friend_key(friend_number: u32, friend_public_key: &str) -> String {
    if friend_public_key.is_empty() {
        format!("number-{friend_number}")
    } else {
        friend_public_key.to_ascii_uppercase()
    }
}

fn reaction_key(friend_key: &str, target_id: &str) -> String {
    format!("{friend_key}:{target_id}")
}

fn message_operation_key(friend_key: &str, operation_id: &str) -> String {
    format!("{friend_key}:message-operation:{operation_id}")
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        Err("CHAT_SEND_OPERATION_ID_INVALID".to_string())
    } else {
        Ok(())
    }
}

fn validate_payload_fingerprint(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("CHAT_SEND_PAYLOAD_FINGERPRINT_INVALID".to_string())
    }
}

fn prune_message_operations(state: &mut StoredState) -> Result<(), String> {
    let overflow = state
        .message_operations
        .len()
        .saturating_sub(MAX_MESSAGE_OPERATIONS);
    if overflow == 0 {
        return Ok(());
    }
    let mut oldest = state
        .message_operations
        .iter()
        .filter(|(_, operation)| operation.delivery == "delivered")
        .map(|(key, operation)| (key.clone(), operation.created_at))
        .collect::<Vec<_>>();
    oldest.sort_by_key(|(key, created_at)| (*created_at, key.clone()));
    if oldest.len() < overflow {
        return Err("CHAT_MESSAGE_OPERATION_CAPACITY".to_string());
    }
    for (key, _) in oldest.into_iter().take(overflow) {
        state.message_operations.remove(&key);
    }
    Ok(())
}

fn prune_peer_reaction_events(state: &mut StoredState, friend_key: &str) {
    let friend_count = state
        .peer_reaction_events
        .iter()
        .filter(|stored| {
            durable_friend_key(stored.friend_number, &stored.friend_public_key) == friend_key
        })
        .count();
    let mut remove_for_friend = friend_count.saturating_sub(MAX_PEER_REACTION_EVENTS_PER_FRIEND);
    if remove_for_friend > 0 {
        state.peer_reaction_events.retain(|stored| {
            if remove_for_friend > 0
                && durable_friend_key(stored.friend_number, &stored.friend_public_key) == friend_key
            {
                remove_for_friend -= 1;
                false
            } else {
                true
            }
        });
    }
    let overflow = state
        .peer_reaction_events
        .len()
        .saturating_sub(MAX_PEER_REACTION_EVENTS);
    if overflow > 0 {
        state.peer_reaction_events.drain(..overflow);
    }
}

fn pending_key(item: &PendingReaction) -> String {
    format!(
        "{}:{}:{}",
        durable_friend_key(item.friend_number, &item.friend_public_key),
        item.target_id,
        item.revision
    )
}

fn persist_state(path: &Path, state: &StoredState) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(state).map_err(|_| "CHAT_PROTOCOL_STATE_ENCODE_FAILED".to_string())?;
    profiles::atomic_write(path, &bytes).map_err(|_| "CHAT_PROTOCOL_STATE_WRITE_FAILED".to_string())
}

fn view(record: &ReactionRecord) -> ReactionView {
    ReactionView {
        mine: record.local.clone(),
        peer: record.peer.clone(),
        mine_revision: record.local_revision,
        peer_revision: record.peer_revision,
        delivery: record.local_delivery.clone(),
    }
}

fn normalize_line_breaks(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\u{2028}', '\u{2029}'], "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        let id = new_common_message_id().unwrap();
        let root = std::env::temp_dir().join(format!("kaigen-chat-protocol-{label}-{id}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn pending(target_id: &str, revision: u64, reactions: Vec<ReactionCode>) -> PendingReaction {
        PendingReaction {
            friend_number: 7,
            friend_public_key: "AABB".to_string(),
            target_id: target_id.to_string(),
            revision,
            reactions,
            pq_required: false,
        }
    }

    #[test]
    fn capability_is_explicit_and_resets_on_disconnect() {
        let root = temporary_root("capability");
        let engine = ChatProtocolEngine::new(&root).unwrap();
        assert!(!engine.supports(7));
        let packet = engine.capability_packet();
        let incoming = engine.handle_packet(7, &packet).unwrap();
        assert!(matches!(incoming, IncomingPacket::Capability { .. }));
        assert!(engine.supports(7));
        engine.disconnected(7);
        assert!(!engine.supports(7));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn message_fragments_round_trip_unicode_and_restart() {
        let root = temporary_root("message");
        let id = new_common_message_id().unwrap();
        let envelope = MessageEnvelope {
            version: VERSION,
            id: id.clone(),
            text: "🙂привет ".repeat(500),
            quote: None,
            formatting: Vec::new(),
            pq_protected: false,
        };
        let fragments = encode_message_fragments(&envelope).unwrap();
        assert!(fragments.len() > 1);
        let split = fragments.len() / 2;
        let engine = ChatProtocolEngine::new(&root).unwrap();
        for fragment in &fragments[..split] {
            assert!(engine
                .accept_message_fragment(7, "AABB", fragment, 100)
                .unwrap()
                .is_none());
        }
        drop(engine);
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let mut completed = None;
        for fragment in &fragments[split..] {
            completed = engine
                .accept_message_fragment(7, "AABB", fragment, 101)
                .unwrap()
                .or(completed);
        }
        assert_eq!(completed, Some(envelope));
        engine.finish_message(7, "AABB", &id).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reaction_packet_is_lossless_state_not_a_file() {
        let id = new_common_message_id().unwrap();
        let packet = encode_reaction_packet(&pending(
            &id,
            9,
            vec![ReactionCode::Heart, ReactionCode::Rocket],
        ))
        .unwrap();
        assert_eq!(packet[0], PACKET_ID);
        let root = temporary_root("packet");
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let decoded = engine.handle_packet(7, &packet).unwrap();
        let IncomingPacket::Reaction(decoded) = decoded else {
            panic!("reaction expected")
        };
        assert_eq!(decoded.target_id, id);
        assert_eq!(decoded.revision, 9);
        assert_eq!(
            decoded.reactions,
            vec![ReactionCode::Heart, ReactionCode::Rocket]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reaction_limit_duplicate_and_restart_are_durable() {
        let root = temporary_root("durable");
        let id = new_common_message_id().unwrap();
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let first = engine
            .update_local_reactions(7, "AABB", &id, vec![ReactionCode::Heart], None, false, 10)
            .unwrap();
        assert_eq!(first.mine_revision, 1);
        drop(engine);
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let second = engine
            .update_local_reactions(7, "AABB", &id, vec![ReactionCode::Rocket], None, false, 11)
            .unwrap();
        assert_eq!(second.mine_revision, 2);
        let incoming = IncomingReaction {
            target_id: id.clone(),
            revision: 3,
            reactions: vec![ReactionCode::Grin],
            pq_required: false,
        };
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &incoming, 12)
                .unwrap(),
            ReactionAckStatus::Applied
        );
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &incoming, 12)
                .unwrap(),
            ReactionAckStatus::Duplicate
        );
        for now in 13..16 {
            let mut update = incoming.clone();
            update.revision = now;
            engine
                .apply_incoming_reaction(7, "AABB", &update, now)
                .unwrap();
        }
        let mut limited = incoming;
        limited.revision = 16;
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &limited, 16)
                .unwrap_err(),
            "CHAT_REACTION_PEER_RATE_LIMIT"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reaction_rate_limit_survives_clock_rollback_and_restart() {
        let root = temporary_root("rate-clock-rollback");
        let local_id = new_common_message_id().unwrap();
        let local_states = [
            ReactionCode::Heart,
            ReactionCode::Rocket,
            ReactionCode::Grin,
            ReactionCode::Sad,
        ];
        let engine = ChatProtocolEngine::new(&root).unwrap();
        for (offset, reaction) in local_states.into_iter().enumerate() {
            engine
                .update_local_reactions(
                    7,
                    "AABB",
                    &local_id,
                    vec![reaction],
                    None,
                    false,
                    1_000_000 + offset as u64,
                )
                .unwrap();
        }
        assert_eq!(
            engine
                .update_local_reactions(
                    7,
                    "AABB",
                    &local_id,
                    vec![ReactionCode::ThumbsUp],
                    None,
                    false,
                    100,
                )
                .unwrap_err(),
            "CHAT_REACTION_RATE_LIMIT"
        );
        drop(engine);

        let engine = ChatProtocolEngine::new(&root).unwrap();
        assert_eq!(
            engine
                .update_local_reactions(
                    7,
                    "AABB",
                    &local_id,
                    vec![ReactionCode::ThumbsUp],
                    None,
                    false,
                    159,
                )
                .unwrap_err(),
            "CHAT_REACTION_RATE_LIMIT"
        );
        engine
            .update_local_reactions(
                7,
                "AABB",
                &local_id,
                vec![ReactionCode::ThumbsUp],
                None,
                false,
                160,
            )
            .unwrap();

        let peer_id = new_common_message_id().unwrap();
        for revision in 1..=4 {
            engine
                .apply_incoming_reaction(
                    7,
                    "AABB",
                    &IncomingReaction {
                        target_id: peer_id.clone(),
                        revision,
                        reactions: vec![if revision % 2 == 0 {
                            ReactionCode::Rocket
                        } else {
                            ReactionCode::Heart
                        }],
                        pq_required: true,
                    },
                    2_000_000 + revision,
                )
                .unwrap();
        }
        let fifth_peer_state = IncomingReaction {
            target_id: peer_id,
            revision: 5,
            reactions: vec![ReactionCode::Grin],
            pq_required: true,
        };
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &fifth_peer_state, 200)
                .unwrap_err(),
            "CHAT_REACTION_PEER_RATE_LIMIT"
        );
        drop(engine);

        let engine = ChatProtocolEngine::new(&root).unwrap();
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &fifth_peer_state, 259)
                .unwrap_err(),
            "CHAT_REACTION_PEER_RATE_LIMIT"
        );
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &fifth_peer_state, 260)
                .unwrap(),
            ReactionAckStatus::Applied
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn acknowledgement_only_removes_the_matching_latest_revision() {
        let root = temporary_root("ack");
        let id = new_common_message_id().unwrap();
        let engine = ChatProtocolEngine::new(&root).unwrap();
        engine
            .update_local_reactions(7, "AABB", &id, vec![ReactionCode::Heart], None, false, 10)
            .unwrap();
        engine
            .update_local_reactions(7, "AABB", &id, vec![ReactionCode::Rocket], None, false, 11)
            .unwrap();
        engine
            .acknowledge_reaction(
                7,
                "AABB",
                &IncomingReactionAck {
                    target_id: id.clone(),
                    revision: 1,
                    status: ReactionAckStatus::Applied,
                    pq_required: false,
                },
            )
            .unwrap();
        assert_eq!(engine.due_reactions(Instant::now()).len(), 1);
        engine
            .acknowledge_reaction(
                7,
                "AABB",
                &IncomingReactionAck {
                    target_id: id.clone(),
                    revision: 2,
                    status: ReactionAckStatus::Applied,
                    pq_required: false,
                },
            )
            .unwrap();
        assert!(engine.due_reactions(Instant::now()).is_empty());
        assert_eq!(
            engine.reaction_view(7, "AABB", &id).unwrap().delivery,
            ReactionDelivery::Delivered
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn peer_reaction_events_survive_restart_and_preserve_clear_high_water() {
        let root = temporary_root("reaction-events");
        let id = new_common_message_id().unwrap();
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let added = IncomingReaction {
            target_id: id.clone(),
            revision: 1,
            reactions: vec![ReactionCode::Heart],
            pq_required: false,
        };
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &added, 10)
                .unwrap(),
            ReactionAckStatus::Applied
        );
        let removed = IncomingReaction {
            target_id: id.clone(),
            revision: 2,
            reactions: Vec::new(),
            pq_required: false,
        };
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &removed, 11)
                .unwrap(),
            ReactionAckStatus::Applied
        );
        // A wire retry never creates a second service event.
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &removed, 12)
                .unwrap(),
            ReactionAckStatus::Duplicate
        );
        drop(engine);

        let engine = ChatProtocolEngine::new(&root).unwrap();
        let (events, latest) = engine.peer_reaction_events(7, "AABB", 0, 64).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].added, vec![ReactionCode::Heart]);
        assert_eq!(events[1].removed, vec![ReactionCode::Heart]);
        let added_json = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(added_json["added"], serde_json::json!(["heart"]));
        assert_eq!(added_json["removed"], serde_json::json!([]));
        let removed_json = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(removed_json["added"], serde_json::json!([]));
        assert_eq!(removed_json["removed"], serde_json::json!(["heart"]));
        assert_eq!(latest, events[1].event_revision);
        engine
            .acknowledge_peer_reaction_events(7, "AABB", events[0].event_revision)
            .unwrap();
        drop(engine);

        let engine = ChatProtocolEngine::new(&root).unwrap();
        let (remaining, _) = engine.peer_reaction_events(7, "AABB", 0, 64).unwrap();
        assert_eq!(remaining.len(), 1);
        let before_clear = remaining[0].event_revision;
        engine.clear_friend_history_state(7, "AABB").unwrap();
        let replacement = IncomingReaction {
            target_id: id,
            revision: 3,
            reactions: vec![ReactionCode::Rocket],
            pq_required: false,
        };
        engine
            .apply_incoming_reaction(7, "AABB", &replacement, 13)
            .unwrap();
        let (after_clear, _) = engine.peer_reaction_events(7, "AABB", 0, 64).unwrap();
        assert_eq!(after_clear.len(), 1);
        assert!(after_clear[0].event_revision > before_clear);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reaction_operation_id_is_idempotent_across_restart() {
        let root = temporary_root("reaction-operation");
        let id = new_common_message_id().unwrap();
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let first = engine
            .update_local_reactions(
                7,
                "AABB",
                &id,
                vec![ReactionCode::Heart],
                Some("operation-1"),
                true,
                10,
            )
            .unwrap();
        drop(engine);
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let retry = engine
            .update_local_reactions(
                7,
                "AABB",
                &id,
                vec![ReactionCode::Heart],
                Some("operation-1"),
                true,
                11,
            )
            .unwrap();
        assert_eq!(retry, first);
        assert_eq!(engine.due_reactions(Instant::now()).len(), 1);
        assert_eq!(
            engine
                .update_local_reactions(
                    7,
                    "AABB",
                    &id,
                    vec![ReactionCode::Rocket],
                    Some("operation-1"),
                    true,
                    12,
                )
                .unwrap_err(),
            "CHAT_REACTION_OPERATION_ID_REUSED"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reaction_replay_binds_pq_after_hot_state_eviction_and_restart() {
        let root = temporary_root("reaction-replay-pq");
        let id = new_common_message_id().unwrap();
        let reaction = IncomingReaction {
            target_id: id.clone(),
            revision: 1,
            reactions: vec![ReactionCode::Heart],
            pq_required: true,
        };
        let engine = ChatProtocolEngine::new(&root).unwrap();
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &reaction, 10)
                .unwrap(),
            ReactionAckStatus::Applied
        );
        engine
            .retain_reaction_targets(7, "AABB", &HashSet::new())
            .unwrap();
        assert!(engine.reaction_view(7, "AABB", &id).is_none());
        assert_eq!(
            engine
                .incoming_reaction_replay_status(7, "AABB", &reaction)
                .unwrap(),
            Some(ReactionAckStatus::Duplicate)
        );
        let opposite_transport = IncomingReaction {
            pq_required: false,
            ..reaction.clone()
        };
        assert_eq!(
            engine
                .incoming_reaction_replay_status(7, "AABB", &opposite_transport)
                .unwrap(),
            Some(ReactionAckStatus::Rejected)
        );
        assert_eq!(
            engine
                .apply_incoming_reaction(7, "AABB", &opposite_transport, 11)
                .unwrap_err(),
            "CHAT_REACTION_PQ_POLICY_MISMATCH"
        );
        drop(engine);

        let engine = ChatProtocolEngine::new(&root).unwrap();
        assert_eq!(
            engine
                .incoming_reaction_replay_status(7, "AABB", &reaction)
                .unwrap(),
            Some(ReactionAckStatus::Duplicate)
        );
        assert_eq!(
            engine
                .incoming_reaction_replay_status(7, "AABB", &opposite_transport)
                .unwrap(),
            Some(ReactionAckStatus::Rejected)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reaction_hot_state_and_operations_are_bounded_without_pruning_pending() {
        let friend_key = durable_friend_key(7, "AABB");
        let pending_id = format!("{:032x}", 10_000_u64);
        let mut state = StoredState::default();
        state
            .reaction_outbox
            .push(pending(&pending_id, 1, vec![ReactionCode::Heart]));
        state.reactions.insert(
            reaction_key(&friend_key, &pending_id),
            ReactionRecord {
                local: vec![ReactionCode::Heart],
                local_revision: 1,
                local_pq_required: Some(false),
                local_delivery: ReactionDelivery::Pending,
                updated_sequence: 1,
                ..ReactionRecord::default()
            },
        );
        for index in 0..60_u64 {
            let target_id = format!("{index:032x}");
            state.reactions.insert(
                reaction_key(&friend_key, &target_id),
                ReactionRecord {
                    peer: vec![ReactionCode::Rocket],
                    peer_revision: 1,
                    peer_pq_required: Some(false),
                    updated_sequence: index + 2,
                    ..ReactionRecord::default()
                },
            );
        }
        compact_reaction_records(&mut state).unwrap();
        assert_eq!(state.reactions.len(), REACTION_ELIGIBLE_MESSAGE_COUNT + 1);
        assert!(state
            .reactions
            .contains_key(&reaction_key(&friend_key, &pending_id)));
        assert_eq!(state.reaction_replays.len(), 10);
        assert!(!state
            .reactions
            .contains_key(&reaction_key(&friend_key, &format!("{:032x}", 0))));
        assert!(state
            .reactions
            .contains_key(&reaction_key(&friend_key, &format!("{:032x}", 59))));

        for index in 0..=MAX_REACTION_OPERATIONS_PER_FRIEND {
            state.reaction_operations.insert(
                format!("{friend_key}:operation:live-{index}"),
                ReactionOperation {
                    target_id: pending_id.clone(),
                    reactions: vec![ReactionCode::Heart],
                    revision: 1,
                    pq_required: false,
                    created_at: index as u64,
                    result: ReactionView {
                        mine: vec![ReactionCode::Heart],
                        mine_revision: 1,
                        delivery: ReactionDelivery::Pending,
                        ..ReactionView::default()
                    },
                },
            );
        }
        assert_eq!(
            prune_reaction_operations(&mut state).unwrap_err(),
            "CHAT_REACTION_OPERATION_CAPACITY"
        );
        assert_eq!(
            state.reaction_operations.len(),
            MAX_REACTION_OPERATIONS_PER_FRIEND + 1
        );
        assert_eq!(state.reaction_outbox.len(), 1);

        let mut completed = StoredState::default();
        for friend in 0..17_u32 {
            let key = durable_friend_key(friend, &format!("FRIEND{friend:03}"));
            for index in 0..MAX_REACTION_OPERATIONS_PER_FRIEND {
                completed.reaction_operations.insert(
                    format!("{key}:operation:done-{index}"),
                    ReactionOperation {
                        target_id: format!("{:032x}", (friend as usize * 1_000) + index),
                        reactions: Vec::new(),
                        revision: 1,
                        pq_required: false,
                        created_at: (friend as usize * 1_000 + index) as u64,
                        result: ReactionView::default(),
                    },
                );
            }
        }
        prune_reaction_operations(&mut completed).unwrap();
        assert_eq!(completed.reaction_operations.len(), MAX_REACTION_OPERATIONS);

        let mut oversized_outbox = StoredState::default();
        for index in 0..=MAX_REACTION_OUTBOX_PER_FRIEND {
            oversized_outbox.reaction_outbox.push(pending(
                &format!("{index:032x}"),
                1,
                vec![ReactionCode::Heart],
            ));
        }
        assert_eq!(
            enforce_reaction_outbox_bounds(&oversized_outbox).unwrap_err(),
            "CHAT_REACTION_OUTBOX_CAPACITY"
        );
        assert_eq!(
            oversized_outbox.reaction_outbox.len(),
            MAX_REACTION_OUTBOX_PER_FRIEND + 1
        );
    }

    #[test]
    fn message_operation_recovery_is_payload_bound_and_durable() {
        let root = temporary_root("message-operation");
        let id = new_common_message_id().unwrap();
        let fingerprint = "AB".repeat(32);
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let reserved = engine
            .reserve_message_operation(
                7,
                "AABB",
                "send-operation-1",
                &fingerprint,
                &id,
                Some(VERSION),
                true,
                10,
            )
            .unwrap();
        assert_eq!(reserved.message_id, id);
        drop(engine);

        let engine = ChatProtocolEngine::new(&root).unwrap();
        let recovered = engine
            .message_operation(7, "AABB", "send-operation-1", &fingerprint)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.message_id, id);
        assert_eq!(
            engine
                .message_operation(7, "AABB", "send-operation-1", &"CD".repeat(32))
                .unwrap_err(),
            "CHAT_SEND_OPERATION_ID_REUSED"
        );
        engine
            .update_message_operation_delivery(7, "AABB", &id, "delivered")
            .unwrap();
        drop(engine);
        let engine = ChatProtocolEngine::new(&root).unwrap();
        assert_eq!(
            engine
                .message_operation(7, "AABB", "send-operation-1", &fingerprint)
                .unwrap()
                .unwrap()
                .delivery,
            "delivered"
        );
        assert_eq!(
            engine
                .update_local_reactions(
                    7,
                    "AABB",
                    &id,
                    vec![ReactionCode::Heart],
                    Some(&"x".repeat(129)),
                    false,
                    12,
                )
                .unwrap_err(),
            "CHAT_SEND_OPERATION_ID_INVALID"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_message_operations_are_never_evicted_at_capacity() {
        let root = temporary_root("message-operation-capacity");
        let engine = ChatProtocolEngine::new(&root).unwrap();
        let friend_key = durable_friend_key(7, "AABB");
        let fingerprint = "AB".repeat(32);
        {
            let mut stored = engine.stored.lock().unwrap();
            for index in 0..MAX_MESSAGE_OPERATIONS {
                let operation_id = format!("send-operation-{index}");
                stored.message_operations.insert(
                    message_operation_key(&friend_key, &operation_id),
                    MessageOperation {
                        friend_number: 7,
                        friend_public_key: "AABB".to_string(),
                        operation_id,
                        payload_fingerprint: fingerprint.clone(),
                        message_id: format!("{index:032x}"),
                        protocol_version: Some(VERSION),
                        pq_required: false,
                        timestamp: index as u64,
                        delivery: "pending".to_string(),
                        created_at: index as u64,
                    },
                );
            }
        }

        let new_id = format!("{:032x}", MAX_MESSAGE_OPERATIONS);
        assert_eq!(
            engine
                .reserve_message_operation(
                    7,
                    "AABB",
                    "send-operation-new",
                    &fingerprint,
                    &new_id,
                    Some(VERSION),
                    false,
                    MAX_MESSAGE_OPERATIONS as u64,
                )
                .unwrap_err(),
            "CHAT_MESSAGE_OPERATION_CAPACITY"
        );
        assert!(engine
            .message_operation(7, "AABB", "send-operation-0", &fingerprint)
            .unwrap()
            .is_some());
        assert!(engine
            .message_operation(7, "AABB", "send-operation-new", &fingerprint)
            .unwrap()
            .is_none());

        engine
            .stored
            .lock()
            .unwrap()
            .message_operations
            .get_mut(&message_operation_key(&friend_key, "send-operation-0"))
            .unwrap()
            .delivery = "delivered".to_string();
        engine
            .reserve_message_operation(
                7,
                "AABB",
                "send-operation-new",
                &fingerprint,
                &new_id,
                Some(VERSION),
                false,
                MAX_MESSAGE_OPERATIONS as u64,
            )
            .unwrap();
        assert!(engine
            .message_operation(7, "AABB", "send-operation-0", &fingerprint)
            .unwrap()
            .is_none());
        assert!(engine
            .message_operation(7, "AABB", "send-operation-new", &fingerprint)
            .unwrap()
            .is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn qtox_quote_round_trip_uses_contiguous_prefixed_lines() {
        let quote = ChatQuote {
            message_id: None,
            author: "Alice".to_string(),
            text: "one\r\ntwo\u{2028}three".to_string(),
            legacy: true,
        };
        let wire = qtox_quote_fallback(&quote, "reply");
        assert_eq!(wire, "> one\n> two\n> three\nreply");
        let (parsed, body) = parse_qtox_quote(&wire).unwrap();
        assert_eq!(parsed.text, "one\ntwo\nthree");
        assert!(parsed.legacy);
        assert_eq!(body, "reply");
    }

    #[test]
    fn formatting_rejects_half_of_a_surrogate_pair() {
        assert!(validate_formatting(
            "🙂a",
            &[TextFormatSpan {
                kind: TextFormatKind::Bold,
                offset_utf16: 1,
                length_utf16: 1,
            }]
        )
        .is_err());
        assert!(validate_formatting(
            "🙂a",
            &[TextFormatSpan {
                kind: TextFormatKind::Bold,
                offset_utf16: 0,
                length_utf16: 2,
            }]
        )
        .is_ok());
    }
}
