//! Workspace-owned transfer storage. Every trait method is nonblocking: native
//! callbacks and the workspace registry may enqueue work, never perform or wait
//! for filesystem/crypto work. Published snapshots contain metadata only.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub type StoreTicket = u64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreDirection {
    Incoming,
    Outgoing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSpec {
    pub object_id: String,
    pub operation_id: Option<String>,
    pub profile_id: String,
    pub message_id: String,
    pub friend_public_key: String,
    pub direction: StoreDirection,
    pub name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub expected_sha256: Option<[u8; 32]>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StorePhase {
    Staging,
    Committed,
    Removed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreObjectStatus {
    pub spec: StoreSpec,
    pub durable_bytes: u64,
    pub phase: StorePhase,
    pub committed_sha256: Option<[u8; 32]>,
    /// Absent only in legacy objects. New outgoing objects remain false until
    /// the native peer's final acknowledgement has crossed the durable index
    /// boundary; payload commitment alone does not prove delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_delivery_confirmed: Option<bool>,
}

#[derive(Clone, Debug)]
pub enum StoreOperation {
    Begin(StoreSpec),
    Append {
        object_id: String,
        offset: u64,
        bytes: Arc<[u8]>,
    },
    Finalize {
        object_id: String,
    },
    /// Records the native final acknowledgement for a committed outgoing
    /// object. Idempotent and independent of optional chat-history persistence.
    MarkDelivered {
        object_id: String,
    },
    ReadRange {
        object_id: String,
        offset: u64,
        length: usize,
    },
    Remove {
        object_id: String,
    },
}

#[derive(Clone, Debug)]
pub enum StoreReply {
    Status(StoreObjectStatus),
    Range {
        status: StoreObjectStatus,
        offset: u64,
        bytes: Arc<[u8]>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreError {
    Busy,
    Quota,
    Range,
    Conflict,
    Hash,
    Unavailable,
}

impl StoreError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Busy => "TRANSFER_STORAGE_BUSY",
            Self::Quota => "WORKSPACE_QUOTA_FULL",
            Self::Range => "TRANSFER_CHUNK_RANGE_INVALID",
            Self::Conflict => "TRANSFER_STORAGE_CONFLICT",
            Self::Hash => "TRANSFER_HASH_MISMATCH",
            Self::Unavailable => "TRANSFER_STORAGE_UNAVAILABLE",
        }
    }
}

pub trait WebTransferStore: Send + Sync {
    /// False until recovery has published the complete operation-id index.
    fn is_ready(&self) -> bool;
    /// Replaying the same operation is idempotent, including while pending.
    /// Busy does not take ownership of the caller's retained byte buffer.
    fn try_submit(&self, operation: StoreOperation) -> Result<StoreTicket, StoreError>;
    /// Non-destructive result lookup; repeated HTTP replies may read it again.
    fn try_result(&self, ticket: StoreTicket) -> Option<Result<StoreReply, StoreError>>;
    /// Workspace-wide, published memory only. Core resolves/filter profiles.
    fn snapshot(&self) -> Vec<StoreObjectStatus>;
}
