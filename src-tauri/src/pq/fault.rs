//! Feature-gated, synthetic-root-only transport suppression for the two-process
//! PQ recovery harness. No payload, key, transcript, or packet digest is ever
//! written to evidence.

use super::v2;
use crate::profiles;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

const SCHEMA_VERSION: u8 = 2;
const TEST_DIRECTORY: &str = "pq-fault-test";
const MARKER_FILE: &str = "marker.json";
const ARM_FILE: &str = "arm.json";
const SUPPORT_FILE: &str = "support.json";
const STATUS_FILE: &str = "status.json";
const HOLD_FILE: &str = "hold.json";
const OBSERVE_FILE: &str = "observe.json";
const STATE_FILE: &str = "state.json";
const MAX_CONTROL_BYTES: u64 = 4096;
const MAX_RECORD_BYTES: usize = 512 * 1024;
const FRAGMENT_BYTES: usize = 1200;

pub(crate) const STAGES: &[&str] = &[
    "offer",
    "accept",
    "finish",
    "ready",
    "commit",
    "done",
    "data",
    "ack",
    "close",
    "close_ready",
    "close_commit",
    "close_ack",
];

pub(crate) const ROTATION_STAGES: &[&str] = &[
    "refresh", "offer", "accept", "finish", "ready", "commit", "done", "data", "ack", "retire",
];

/// Test-only observations contain no keys, payloads, contact IDs or raw epochs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EpochSnapshot {
    pub sha256: String,
    pub current: bool,
    pub send_sealed: bool,
    pub unacknowledged: usize,
    pub pending_ciphertext_sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub online: bool,
    pub capability_validated: bool,
    pub current_epoch_sha256: Option<String>,
    pub handshake_parent_sha256: Option<String>,
    pub handshake_epoch_sha256: Option<String>,
    pub handshake_phase: Option<String>,
    pub refresh_requested: bool,
    pub closing: bool,
    pub epochs: Vec<EpochSnapshot>,
    pub retired_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    schema_version: u8,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arm {
    schema_version: u8,
    nonce: String,
    friend_number: u32,
    stage: String,
    #[serde(default)]
    rotation_parent_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hold {
    schema_version: u8,
    nonce: String,
    friend_number: u32,
    epoch_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observe {
    schema_version: u8,
    nonce: String,
    friend_number: u32,
    request_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Support<'a> {
    schema_version: u8,
    nonce: &'a str,
    supported: bool,
    feature: &'static str,
    stages: &'static [&'static str],
    rotation_stages: &'static [&'static str],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TriggerStatus<'a> {
    schema_version: u8,
    nonce: &'a str,
    triggered: bool,
    stage: &'a str,
    suppressed_before_transport: bool,
    blocks_peer_v2_until_process_exit: bool,
    rotation_parent_sha256: Option<&'a str>,
    snapshot: Option<&'a Snapshot>,
}

struct Config {
    root: PathBuf,
    nonce: String,
}

#[derive(Default)]
struct Runtime {
    blocked_friend: Option<u32>,
}

pub(crate) struct FilteredPackets {
    pub packets: Vec<Vec<u8>>,
    pub blocked: bool,
}

pub(crate) struct FaultInjector {
    config: Option<Config>,
    runtime: Mutex<Runtime>,
}

impl FaultInjector {
    pub(crate) fn from_env() -> Result<Self, String> {
        let test_root = std::env::var_os("KAIGEN_PQ_TEST_ROOT");
        let portable_root = std::env::var_os("KAIGEN_PORTABLE_ROOT");
        let nonce = std::env::var("KAIGEN_PQ_TEST_NONCE").ok();
        match (portable_root, test_root, nonce) {
            (_, None, None) => Ok(Self::disabled()),
            (Some(portable), Some(root), Some(nonce)) => {
                Self::from_paths(Path::new(&portable), Path::new(&root), &nonce)
            }
            _ => Err("PQ_FAULT_TEST_ENV_INCOMPLETE".into()),
        }
    }

    fn disabled() -> Self {
        Self {
            config: None,
            runtime: Mutex::new(Runtime::default()),
        }
    }

    pub(crate) fn from_paths(
        portable_root: &Path,
        test_root: &Path,
        nonce: &str,
    ) -> Result<Self, String> {
        if !valid_nonce(nonce) {
            return Err("PQ_FAULT_TEST_NONCE_INVALID".into());
        }
        let portable = canonical_directory(portable_root, "PQ_FAULT_TEST_PORTABLE_ROOT_INVALID")?;
        let root = canonical_directory(test_root, "PQ_FAULT_TEST_ROOT_INVALID")?;
        let expected = portable.join(TEST_DIRECTORY);
        let expected = canonical_directory(&expected, "PQ_FAULT_TEST_ROOT_INVALID")?;
        if root != expected || root.parent() != Some(portable.as_path()) {
            return Err("PQ_FAULT_TEST_ROOT_OUTSIDE_PORTABLE".into());
        }

        let marker_path = checked_regular_file(&root, MARKER_FILE)?;
        let marker: Marker = read_small_json(&marker_path)?;
        if marker.schema_version != SCHEMA_VERSION || marker.nonce != nonce {
            return Err("PQ_FAULT_TEST_MARKER_INVALID".into());
        }

        let support = serde_json::to_vec_pretty(&Support {
            schema_version: SCHEMA_VERSION,
            nonce,
            supported: true,
            feature: "pq-fault-tests",
            stages: STAGES,
            rotation_stages: ROTATION_STAGES,
        })
        .map_err(|_| "PQ_FAULT_TEST_SUPPORT_ENCODE_FAILED")?;
        profiles::atomic_write(&root.join(SUPPORT_FILE), &support)
            .map_err(|_| "PQ_FAULT_TEST_SUPPORT_WRITE_FAILED")?;

        Ok(Self {
            config: Some(Config {
                root,
                nonce: nonce.into(),
            }),
            runtime: Mutex::new(Runtime::default()),
        })
    }

    #[cfg(test)]
    pub(crate) fn filter(&self, friend: u32, packets: Vec<Vec<u8>>) -> FilteredPackets {
        self.filter_with_snapshot(friend, packets, None)
    }

    pub(crate) fn observe(&self, friend: u32, snapshot: Option<Snapshot>) {
        let (Some(config), Some(snapshot)) = (&self.config, snapshot) else {
            return;
        };
        let Some(request) = checked_regular_file(&config.root, OBSERVE_FILE)
            .ok()
            .and_then(|path| read_small_json::<Observe>(&path).ok())
        else {
            return;
        };
        if request.schema_version != SCHEMA_VERSION
            || request.nonce != config.nonce
            || request.friend_number != friend
            || !valid_nonce(&request.request_id)
        {
            return;
        }
        let state = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION, "nonce": config.nonce,
            "requestId": request.request_id, "snapshot": snapshot,
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&state) {
            let _ = profiles::atomic_write(&config.root.join(STATE_FILE), &bytes);
        }
    }

    pub(crate) fn filter_with_snapshot(
        &self,
        friend: u32,
        mut packets: Vec<Vec<u8>>,
        snapshot: Option<Snapshot>,
    ) -> FilteredPackets {
        let Some(config) = &self.config else {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        };
        let Ok(mut runtime) = self.runtime.lock() else {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        };
        if runtime.blocked_friend == Some(friend) {
            return FilteredPackets {
                packets: retain_non_v2(packets),
                blocked: true,
            };
        }
        if runtime.blocked_friend.is_some() {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        }

        // Hold only an old epoch's DATA; its authentic journal record remains
        // retryable while rekey and discovery traffic use the real transport.
        if let Some(hold) = read_hold(config).filter(|hold| hold.friend_number == friend) {
            let held = complete_records(&packets)
                .into_iter()
                .filter(|record| {
                    record_stage(&record.bytes).as_deref() == Some("data")
                        && record_epoch_sha256(&record.bytes).as_deref() == Some(&hold.epoch_sha256)
                })
                .map(|record| record.digest)
                .collect::<std::collections::HashSet<_>>();
            packets.retain(|packet| {
                fragment(packet).is_none_or(|(digest, _, _, _, _)| !held.contains(&digest))
            });
        }

        let Some(arm) = read_arm(config) else {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        };
        if arm.friend_number != friend {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        }
        let Some(trigger_at) = complete_records(&packets)
            .into_iter()
            .filter(|record| record_stage(&record.bytes).as_deref() == Some(&arm.stage))
            .filter(|record| {
                arm.rotation_parent_sha256.as_deref().is_none_or(|parent| {
                    rotation_matches(&record.bytes, &arm.stage, parent, snapshot.as_ref())
                })
            })
            .map(|record| record.first_index)
            .min()
        else {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        };

        let status = serde_json::to_vec_pretty(&TriggerStatus {
            schema_version: SCHEMA_VERSION,
            nonce: &config.nonce,
            triggered: true,
            stage: &arm.stage,
            suppressed_before_transport: true,
            blocks_peer_v2_until_process_exit: true,
            rotation_parent_sha256: arm.rotation_parent_sha256.as_deref(),
            snapshot: snapshot.as_ref(),
        });
        let Ok(status) = status else {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        };
        if profiles::atomic_write(&config.root.join(STATUS_FILE), &status).is_err() {
            return FilteredPackets {
                packets,
                blocked: false,
            };
        }

        runtime.blocked_friend = Some(friend);
        let packets = packets
            .into_iter()
            .enumerate()
            .filter_map(|(index, packet)| {
                (index < trigger_at || !v2::is_packet(&packet)).then_some(packet)
            })
            .collect();
        FilteredPackets {
            packets,
            blocked: true,
        }
    }

    pub(crate) fn blocked_friend(&self) -> Option<u32> {
        self.runtime
            .lock()
            .ok()
            .and_then(|state| state.blocked_friend)
    }
}

fn canonical_directory(path: &Path, error: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(error.into());
    }
    fs::canonicalize(path).map_err(|_| error.into())
}

fn checked_regular_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    let candidate = root.join(name);
    let metadata = fs::symlink_metadata(&candidate).map_err(|_| "PQ_FAULT_TEST_FILE_INVALID")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_CONTROL_BYTES
    {
        return Err("PQ_FAULT_TEST_FILE_INVALID".into());
    }
    let canonical = fs::canonicalize(&candidate).map_err(|_| "PQ_FAULT_TEST_FILE_INVALID")?;
    if canonical.parent() != Some(root) {
        return Err("PQ_FAULT_TEST_FILE_OUTSIDE_ROOT".into());
    }
    Ok(canonical)
}

fn read_small_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|_| "PQ_FAULT_TEST_FILE_READ_FAILED")?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_CONTROL_BYTES {
        return Err("PQ_FAULT_TEST_FILE_INVALID".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "PQ_FAULT_TEST_FILE_INVALID".into())
}

fn read_arm(config: &Config) -> Option<Arm> {
    let path = checked_regular_file(&config.root, ARM_FILE).ok()?;
    let arm: Arm = read_small_json(&path).ok()?;
    (arm.schema_version == SCHEMA_VERSION
        && arm.nonce == config.nonce
        && match arm.rotation_parent_sha256.as_deref() {
            Some(parent) => valid_sha256(parent) && ROTATION_STAGES.contains(&arm.stage.as_str()),
            None => STAGES.contains(&arm.stage.as_str()),
        })
    .then_some(arm)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

fn read_hold(config: &Config) -> Option<Hold> {
    let path = checked_regular_file(&config.root, HOLD_FILE).ok()?;
    let hold: Hold = read_small_json(&path).ok()?;
    (hold.schema_version == SCHEMA_VERSION
        && hold.nonce == config.nonce
        && valid_sha256(&hold.epoch_sha256))
    .then_some(hold)
}

fn digest_text(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

fn record_epoch_sha256(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    value
        .get("epoch")
        .and_then(serde_json::Value::as_str)
        .map(digest_text)
}

fn rotation_matches(bytes: &[u8], stage: &str, parent: &str, snapshot: Option<&Snapshot>) -> bool {
    let Some(snapshot) =
        snapshot.filter(|state| state.online && state.capability_validated && !state.closing)
    else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return false;
    };
    match stage {
        "refresh" => {
            snapshot.current_epoch_sha256.as_deref() == Some(parent)
                && record_epoch_sha256(bytes).as_deref() == Some(parent)
        }
        "offer" => {
            snapshot.current_epoch_sha256.as_deref() == Some(parent)
                && value
                    .get("parent")
                    .and_then(serde_json::Value::as_str)
                    .map(digest_text)
                    .as_deref()
                    == Some(parent)
        }
        "accept" | "finish" | "ready" | "commit" | "done" => {
            let tx = value
                .get("tx")
                .or_else(|| value.get("epoch"))
                .and_then(serde_json::Value::as_str)
                .map(digest_text);
            snapshot.handshake_parent_sha256.as_deref() == Some(parent)
                && tx.is_some()
                && tx == snapshot.handshake_epoch_sha256
        }
        "data" | "ack" | "retire" => {
            snapshot.current_epoch_sha256.is_some()
                && snapshot.current_epoch_sha256.as_deref() != Some(parent)
                && record_epoch_sha256(bytes).as_deref() == Some(parent)
        }
        _ => false,
    }
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn retain_non_v2(packets: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    packets
        .into_iter()
        .filter(|packet| !v2::is_packet(packet))
        .collect()
}

struct FragmentGroup {
    first_index: usize,
    total: usize,
    len: usize,
    parts: Vec<Option<Vec<u8>>>,
    valid: bool,
}

struct CompleteRecord {
    digest: [u8; 16],
    first_index: usize,
    bytes: Vec<u8>,
}

fn complete_records(packets: &[Vec<u8>]) -> Vec<CompleteRecord> {
    let mut groups = HashMap::<[u8; 16], FragmentGroup>::new();
    for (position, packet) in packets.iter().enumerate() {
        let Some((digest, index, total, len, part)) = fragment(packet) else {
            continue;
        };
        let group = groups.entry(digest).or_insert_with(|| FragmentGroup {
            first_index: position,
            total,
            len,
            parts: vec![None; total],
            valid: true,
        });
        if group.total != total || group.len != len || index >= group.parts.len() {
            group.valid = false;
            continue;
        }
        if group.parts[index]
            .as_ref()
            .is_some_and(|existing| existing != part)
        {
            group.valid = false;
            continue;
        }
        group.parts[index] = Some(part.to_vec());
    }
    groups
        .into_iter()
        .filter_map(|(digest, group)| {
            if !group.valid || group.parts.iter().any(Option::is_none) {
                return None;
            }
            let bytes = group
                .parts
                .into_iter()
                .flatten()
                .flatten()
                .collect::<Vec<_>>();
            if bytes.len() != group.len || Sha256::digest(&bytes)[..16] != digest {
                return None;
            }
            Some(CompleteRecord {
                digest,
                first_index: group.first_index,
                bytes,
            })
        })
        .collect()
}

fn fragment(packet: &[u8]) -> Option<([u8; 16], usize, usize, usize, &[u8])> {
    if !v2::is_packet(packet) || packet.len() < 31 || packet.len() > 30 + FRAGMENT_BYTES {
        return None;
    }
    let digest: [u8; 16] = packet[6..22].try_into().ok()?;
    let index = u16::from_be_bytes(packet[22..24].try_into().ok()?) as usize;
    let total = u16::from_be_bytes(packet[24..26].try_into().ok()?) as usize;
    let len = u32::from_be_bytes(packet[26..30].try_into().ok()?) as usize;
    if len == 0
        || len > MAX_RECORD_BYTES
        || total != len.div_ceil(FRAGMENT_BYTES)
        || index >= total
        || packet.len() - 30 != (len - index * FRAGMENT_BYTES).min(FRAGMENT_BYTES)
    {
        return None;
    }
    Some((digest, index, total, len, &packet[30..]))
}

fn record_stage(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    match value.get("kind")?.as_str()? {
        "Offer" => Some("offer".into()),
        "Accept" => Some("accept".into()),
        "Finish" => Some("finish".into()),
        "Data" => Some("data".into()),
        "Signal" => {
            let action = value.get("action")?.as_str()?;
            matches!(
                action,
                "ready"
                    | "commit"
                    | "done"
                    | "ack"
                    | "close"
                    | "close_ready"
                    | "close_commit"
                    | "close_ack"
                    | "refresh"
                    | "retire"
            )
            .then(|| action.into())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);
    const NONCE: &str = "01234567-89ab-4def-8123-456789abcdef";

    fn root(label: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "kaigen-pq-fault-{label}-{}-{now}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn fixture(label: &str) -> (PathBuf, PathBuf) {
        let portable = root(label);
        let fault = portable.join(TEST_DIRECTORY);
        fs::create_dir_all(&fault).unwrap();
        fs::write(
            fault.join(MARKER_FILE),
            format!(r#"{{"schemaVersion":2,"nonce":"{NONCE}"}}"#),
        )
        .unwrap();
        (portable, fault)
    }

    fn arm(root: &Path, friend: u32, stage: &str, nonce: &str) {
        profiles::atomic_write(
            &root.join(ARM_FILE),
            format!(
                r#"{{"schemaVersion":2,"nonce":"{nonce}","friendNumber":{friend},"stage":"{stage}"}}"#
            )
            .as_bytes(),
        )
        .unwrap();
    }

    fn packets(value: serde_json::Value) -> Vec<Vec<u8>> {
        let bytes = serde_json::to_vec(&value).unwrap();
        let digest = Sha256::digest(&bytes);
        let total = bytes.len().div_ceil(FRAGMENT_BYTES);
        bytes
            .chunks(FRAGMENT_BYTES)
            .enumerate()
            .map(|(index, part)| {
                let mut packet = vec![super::super::PACKET_ID, b'T', b'P', b'Q', 2, 1];
                packet.extend_from_slice(&digest[..16]);
                packet.extend_from_slice(&(index as u16).to_be_bytes());
                packet.extend_from_slice(&(total as u16).to_be_bytes());
                packet.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                packet.extend_from_slice(part);
                packet
            })
            .collect()
    }

    #[test]
    fn root_guard_requires_exact_marked_child_and_writes_feature_proof() {
        let (portable, fault) = fixture("root-guard");
        let injector = FaultInjector::from_paths(&portable, &fault, NONCE).unwrap();
        assert!(injector.config.is_some());
        let support: serde_json::Value =
            serde_json::from_slice(&fs::read(fault.join(SUPPORT_FILE)).unwrap()).unwrap();
        assert_eq!(support["nonce"], NONCE);
        assert_eq!(support["supported"], true);
        assert_eq!(support["feature"], "pq-fault-tests");
        assert_eq!(support["stages"], serde_json::json!(STAGES));
        assert_eq!(
            support["rotationStages"],
            serde_json::json!(ROTATION_STAGES)
        );

        let outside = root("outside");
        fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            FaultInjector::from_paths(&portable, &outside, NONCE)
                .err()
                .unwrap(),
            "PQ_FAULT_TEST_ROOT_OUTSIDE_PORTABLE"
        );
        assert_eq!(
            FaultInjector::from_paths(&portable, &fault, "wrong")
                .err()
                .unwrap(),
            "PQ_FAULT_TEST_NONCE_INVALID"
        );
        fs::remove_dir_all(portable).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    fn rotation_snapshot(old: &str, new: &str, activated: bool) -> Snapshot {
        Snapshot {
            online: true,
            capability_validated: true,
            current_epoch_sha256: Some(digest_text(if activated { new } else { old })),
            handshake_parent_sha256: Some(digest_text(old)),
            handshake_epoch_sha256: Some(digest_text(new)),
            handshake_phase: Some(if activated { "done" } else { "prepared" }.into()),
            refresh_requested: false,
            closing: false,
            epochs: vec![EpochSnapshot {
                sha256: digest_text(old),
                current: !activated,
                send_sealed: activated,
                unacknowledged: 1,
                pending_ciphertext_sha256: Some("A".repeat(64)),
            }],
            retired_count: 0,
        }
    }

    #[test]
    fn rotation_hold_filters_only_complete_old_data_and_survives_injector_restart() {
        let (portable, fault) = fixture("rotation-hold");
        let old_data = packets(
            serde_json::json!({"kind":"Data", "epoch":"old", "ciphertext":"x".repeat(3000)}),
        );
        let new_data =
            packets(serde_json::json!({"kind":"Data", "epoch":"new", "ciphertext":"new"}));
        let offer = packets(serde_json::json!({"kind":"Offer", "parent":"old", "tx":"new"}));
        let hold = serde_json::json!({"schemaVersion":SCHEMA_VERSION, "nonce":NONCE, "friendNumber":7, "epochSha256":digest_text("old")});
        profiles::atomic_write(&fault.join(HOLD_FILE), &serde_json::to_vec(&hold).unwrap())
            .unwrap();
        for _ in 0..2 {
            let injector = FaultInjector::from_paths(&portable, &fault, NONCE).unwrap();
            let original = [old_data.clone(), offer.clone(), new_data.clone()].concat();
            assert_eq!(injector.filter(8, original.clone()).packets, original);
            let held = injector.filter(7, original);
            assert!(!held.blocked);
            assert_eq!(held.packets, [offer.clone(), new_data.clone()].concat());
            assert!(!fault.join(STATUS_FILE).exists());
        }
        let mut invalid = hold;
        invalid["nonce"] = serde_json::json!("ffffffff-ffff-4fff-8fff-ffffffffffff");
        profiles::atomic_write(
            &fault.join(HOLD_FILE),
            &serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        let injector = FaultInjector::from_paths(&portable, &fault, NONCE).unwrap();
        assert_eq!(injector.filter(7, old_data.clone()).packets, old_data);
        fs::remove_file(fault.join(HOLD_FILE)).unwrap();
        assert_eq!(injector.filter(7, old_data.clone()).packets, old_data);
        fs::remove_dir_all(portable).unwrap();
    }

    #[test]
    fn rotation_barriers_require_online_parent_bound_real_record_context() {
        let old = "old-epoch";
        let new = "new-epoch";
        for stage in ROTATION_STAGES {
            let (portable, fault) = fixture(&format!("rotation-{stage}"));
            let activated = matches!(*stage, "data" | "ack" | "retire");
            let snapshot = rotation_snapshot(old, new, activated);
            let record = match *stage {
                "offer" => serde_json::json!({"kind":"Offer", "parent":old, "tx":new}),
                "accept" => serde_json::json!({"kind":"Accept", "tx":new}),
                "finish" => serde_json::json!({"kind":"Finish", "tx":new}),
                "data" => serde_json::json!({"kind":"Data", "epoch":old, "ciphertext":"sealed"}),
                action => {
                    serde_json::json!({"kind":"Signal", "action":action, "epoch":if matches!(action, "refresh" | "ack" | "retire") { old } else { new }})
                }
            };
            let record_packets = packets(record);
            let arm = serde_json::json!({"schemaVersion":SCHEMA_VERSION, "nonce":NONCE, "friendNumber":7, "stage":stage, "rotationParentSha256":digest_text(old)});
            profiles::atomic_write(&fault.join(ARM_FILE), &serde_json::to_vec(&arm).unwrap())
                .unwrap();
            let injector = FaultInjector::from_paths(&portable, &fault, NONCE).unwrap();
            assert!(
                !injector
                    .filter_with_snapshot(7, record_packets.clone(), None)
                    .blocked
            );
            let mut offline = snapshot.clone();
            offline.online = false;
            assert!(
                !injector
                    .filter_with_snapshot(7, record_packets.clone(), Some(offline))
                    .blocked
            );
            let mut stale = snapshot.clone();
            stale.capability_validated = false;
            assert!(
                !injector
                    .filter_with_snapshot(7, record_packets.clone(), Some(stale))
                    .blocked
            );
            let mut wrong_parent = arm.clone();
            wrong_parent["rotationParentSha256"] = serde_json::json!(digest_text("another-epoch"));
            profiles::atomic_write(
                &fault.join(ARM_FILE),
                &serde_json::to_vec(&wrong_parent).unwrap(),
            )
            .unwrap();
            assert!(
                !injector
                    .filter_with_snapshot(7, record_packets.clone(), Some(snapshot.clone()))
                    .blocked
            );
            profiles::atomic_write(&fault.join(ARM_FILE), &serde_json::to_vec(&arm).unwrap())
                .unwrap();
            let triggered =
                injector.filter_with_snapshot(7, record_packets.clone(), Some(snapshot));
            assert!(triggered.blocked, "{stage}");
            assert!(triggered.packets.is_empty(), "{stage}");
            let status: serde_json::Value =
                serde_json::from_slice(&fs::read(fault.join(STATUS_FILE)).unwrap()).unwrap();
            assert_eq!(status["rotationParentSha256"], digest_text(old));
            assert_eq!(status["snapshot"]["online"], true);
            assert_eq!(status["stage"], *stage);
            let encoded = serde_json::to_string(&status).unwrap();
            assert!(
                !encoded.contains(old) && !encoded.contains(new) && !encoded.contains("sealed")
            );
            assert!(injector.filter(7, record_packets).packets.is_empty());
            fs::remove_dir_all(portable).unwrap();
        }
    }

    #[test]
    fn rotation_observation_requires_fresh_matching_nonce_and_friend() {
        let (portable, fault) = fixture("rotation-observe");
        let injector = FaultInjector::from_paths(&portable, &fault, NONCE).unwrap();
        let snapshot = rotation_snapshot("old", "new", true);
        let request_id = "abcdef01-1234-4567-89ab-123456789abc";
        let request = serde_json::json!({"schemaVersion":SCHEMA_VERSION, "nonce":NONCE, "friendNumber":7, "requestId":request_id});
        profiles::atomic_write(
            &fault.join(OBSERVE_FILE),
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        injector.observe(8, Some(snapshot.clone()));
        assert!(!fault.join(STATE_FILE).exists());
        injector.observe(7, Some(snapshot.clone()));
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(fault.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(state["requestId"], request_id);
        assert_eq!(state["snapshot"]["currentEpochSha256"], digest_text("new"));
        fs::remove_file(fault.join(STATE_FILE)).unwrap();
        let mut wrong = request;
        wrong["nonce"] = serde_json::json!("ffffffff-ffff-4fff-8fff-ffffffffffff");
        profiles::atomic_write(
            &fault.join(OBSERVE_FILE),
            &serde_json::to_vec(&wrong).unwrap(),
        )
        .unwrap();
        injector.observe(7, Some(snapshot));
        assert!(!fault.join(STATE_FILE).exists());
        fs::remove_dir_all(portable).unwrap();
    }

    #[test]
    fn advertised_stages_match_wire_record_kinds_and_actions() {
        let records = [
            (serde_json::json!({"kind": "Offer"}), "offer"),
            (serde_json::json!({"kind": "Accept"}), "accept"),
            (serde_json::json!({"kind": "Finish"}), "finish"),
            (
                serde_json::json!({"kind": "Signal", "action": "ready"}),
                "ready",
            ),
            (
                serde_json::json!({"kind": "Signal", "action": "commit"}),
                "commit",
            ),
            (
                serde_json::json!({"kind": "Signal", "action": "done"}),
                "done",
            ),
            (serde_json::json!({"kind": "Data"}), "data"),
            (
                serde_json::json!({"kind": "Signal", "action": "ack"}),
                "ack",
            ),
            (
                serde_json::json!({"kind": "Signal", "action": "close"}),
                "close",
            ),
            (
                serde_json::json!({"kind": "Signal", "action": "close_ready"}),
                "close_ready",
            ),
            (
                serde_json::json!({"kind": "Signal", "action": "close_commit"}),
                "close_commit",
            ),
            (
                serde_json::json!({"kind": "Signal", "action": "close_ack"}),
                "close_ack",
            ),
        ];
        let classified = records
            .into_iter()
            .map(|(record, _)| record_stage(&serde_json::to_vec(&record).unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(classified, STAGES);
    }

    #[test]
    fn complete_target_record_is_suppressed_and_blocks_later_peer_v2() {
        let (portable, fault) = fixture("fragment-stage");
        let injector = FaultInjector::from_paths(&portable, &fault, NONCE).unwrap();
        arm(&fault, 7, "accept", NONCE);

        let offer = packets(serde_json::json!({
            "kind": "Offer",
            "padding": "o".repeat(2400),
        }));
        let accept = packets(serde_json::json!({
            "kind": "Accept",
            "padding": "a".repeat(3600),
        }));
        assert!(accept.len() > 1);
        let data = packets(serde_json::json!({"kind": "Data", "padding": "later"}));
        let legacy = vec![super::super::PACKET_ID, b'T', b'P', b'Q', 1, 1];

        // An incomplete logical record never triggers suppression.
        let incomplete = injector.filter(7, vec![accept[0].clone()]);
        assert!(!incomplete.blocked);
        assert_eq!(incomplete.packets, [accept[0].clone()]);

        let mut batch = offer.clone();
        batch.extend(accept.clone());
        batch.extend(data);
        batch.push(legacy.clone());
        let filtered = injector.filter(7, batch);
        assert!(filtered.blocked);
        assert_eq!(filtered.packets.len(), offer.len() + 1);
        assert_eq!(&filtered.packets[..offer.len()], offer);
        assert_eq!(filtered.packets.last(), Some(&legacy));
        assert_eq!(injector.blocked_friend(), Some(7));

        let status: serde_json::Value =
            serde_json::from_slice(&fs::read(fault.join(STATUS_FILE)).unwrap()).unwrap();
        assert_eq!(status["stage"], "accept");
        assert_eq!(status["suppressedBeforeTransport"], true);
        assert_eq!(status["blocksPeerV2UntilProcessExit"], true);

        let later = injector.filter(
            7,
            vec![
                packets(serde_json::json!({"kind": "Data"}))[0].clone(),
                legacy.clone(),
            ],
        );
        assert!(later.blocked);
        assert_eq!(later.packets, [legacy]);
        let other_peer = injector.filter(8, accept);
        assert!(!other_peer.blocked);
        assert!(!other_peer.packets.is_empty());
        fs::remove_dir_all(portable).unwrap();
    }

    #[test]
    fn wrong_nonce_or_unknown_stage_cannot_arm_suppression() {
        let (portable, fault) = fixture("arm-guard");
        let injector = FaultInjector::from_paths(&portable, &fault, NONCE).unwrap();
        let offer = packets(serde_json::json!({"kind": "Offer"}));
        arm(&fault, 7, "offer", "ffffffff-ffff-4fff-8fff-ffffffffffff");
        let wrong_nonce = injector.filter(7, offer.clone());
        assert!(!wrong_nonce.blocked);
        assert_eq!(wrong_nonce.packets, offer);
        arm(&fault, 7, "capability", NONCE);
        let unknown = injector.filter(7, wrong_nonce.packets.clone());
        assert!(!unknown.blocked);
        assert_eq!(unknown.packets, wrong_nonce.packets);
        assert!(!fault.join(STATUS_FILE).exists());
        fs::remove_dir_all(portable).unwrap();
    }
}
