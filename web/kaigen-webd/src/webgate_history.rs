//! Opt-in history deltas. Bases contain identities/hashes, never message text.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};

pub(super) const FIELD: &str = "_webgateHistory";
const MAX_BASE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;

struct Base {
    token: String,
    order: Vec<String>,
    rows: HashMap<String, String>,
    fields: HashMap<String, String>,
    array: bool,
}

#[derive(Default)]
pub(super) struct HistoryBases {
    queries: HashMap<String, VecDeque<Base>>,
    order: VecDeque<String>,
}

fn digest(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(&canonical(value)).map_err(|_| "WEBGATE_HISTORY_INVALID")?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut fields = fields.iter().collect::<Vec<_>>();
            fields.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (key.clone(), canonical(value)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

pub(super) fn query_key(command: &str, args: &Value) -> Result<String, String> {
    let mut args = args.as_object().cloned().ok_or("WEBGATE_REQUEST_INVALID")?;
    for field in [
        FIELD,
        "profileId",
        "operationId",
        "knownRevision",
        "viewLeaseId",
        "peerReactionAfter",
        "ackPeerReactionThrough",
    ] {
        args.remove(field);
    }
    digest(&json!({"command":command,"args":args}))
}

impl Base {
    fn size(&self) -> usize {
        self.order.iter().map(String::len).sum::<usize>()
            + self
                .rows
                .iter()
                .map(|(id, hash)| id.len() + hash.len() + 64)
                .sum::<usize>()
            + self
                .fields
                .iter()
                .map(|(id, hash)| id.len() + hash.len() + 64)
                .sum::<usize>()
            + 128
    }
}

impl HistoryBases {
    pub(super) fn encode(
        &mut self,
        command: &str,
        args: &Value,
        claim: Option<Value>,
        value: Value,
    ) -> Result<Value, String> {
        if !matches!(
            command,
            "get_tox_messages" | "get_tox_messages_snapshot" | "get_tox_messages_page"
        ) || claim.is_none()
        {
            return Ok(value);
        }
        let claim = claim.ok_or("WEBGATE_HISTORY_INVALID")?;
        let key = query_key(command, args)?;
        if claim.get("key").and_then(Value::as_str) != Some(key.as_str()) {
            return Err("WEBGATE_HISTORY_SCOPE_INVALID".into());
        }
        let array = value.is_array();
        let (messages, mut metadata) = if array {
            (value.as_array().cloned(), Map::new())
        } else {
            let mut metadata = value
                .as_object()
                .cloned()
                .ok_or("WEBGATE_HISTORY_INVALID")?;
            let messages = metadata
                .remove("messages")
                .and_then(|messages| messages.as_array().cloned());
            (messages, metadata)
        };
        // Native knownRevision responses are already sparse and preserve their
        // existing null semantics. Do not replace a complete encrypted base.
        let Some(messages) = messages else {
            return Ok(value);
        };
        if messages.len() > MAX_ROWS {
            return Err("WEBGATE_HISTORY_LIMIT".into());
        }
        let mut next = Base {
            token: digest(&value)?,
            order: Vec::new(),
            rows: HashMap::new(),
            fields: HashMap::new(),
            array,
        };
        for row in &messages {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .ok_or("WEBGATE_HISTORY_INVALID")?;
            if next.rows.insert(id.into(), digest(row)?).is_some() {
                return Err("WEBGATE_HISTORY_INVALID".into());
            }
            next.order.push(id.into());
        }
        for (field, value) in &metadata {
            next.fields.insert(field.clone(), digest(value)?);
        }
        let previous = claim
            .get("baseToken")
            .and_then(Value::as_str)
            .and_then(|token| {
                self.queries
                    .get(&key)?
                    .iter()
                    .find(|base| base.token == token && base.array == array)
            });
        let result = if let Some(previous) = previous {
            let prefix = previous
                .order
                .iter()
                .zip(&next.order)
                .take_while(|(a, b)| a == b)
                .count();
            let max_suffix = previous
                .order
                .len()
                .min(next.order.len())
                .saturating_sub(prefix);
            let suffix = previous
                .order
                .iter()
                .rev()
                .zip(next.order.iter().rev())
                .take(max_suffix)
                .take_while(|(a, b)| a == b)
                .count();
            let upserts = messages
                .into_iter()
                .filter(|row| {
                    row.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| previous.rows.get(id) != next.rows.get(id))
                })
                .collect::<Vec<_>>();
            metadata
                .retain(|field, value| previous.fields.get(field) != digest(value).ok().as_ref());
            let removed_fields = previous
                .fields
                .keys()
                .filter(|field| !next.fields.contains_key(*field))
                .cloned()
                .collect::<Vec<_>>();
            json!({"_webgateHistory":{"version":1,"mode":"delta","key":key,"baseToken":previous.token,"token":next.token,
                "prefix":prefix,"suffix":suffix,"insert":&next.order[prefix..next.order.len()-suffix],
                "upserts":upserts,"metadata":metadata,"removedFields":removed_fields,"array":array}})
        } else {
            json!({"_webgateHistory":{"version":1,"mode":"full","reason":"base-unknown","key":key,"token":next.token,"value":value,"array":array}})
        };
        let bases = self.queries.entry(key.clone()).or_default();
        if !bases.iter().any(|base| base.token == next.token) {
            bases.push_back(next);
        }
        while bases.len() > 2 {
            bases.pop_front();
        }
        self.order.retain(|old| old != &key);
        self.order.push_back(key);
        while self
            .queries
            .values()
            .flat_map(|bases| bases.iter())
            .map(Base::size)
            .sum::<usize>()
            > MAX_BASE_BYTES
        {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            self.queries.remove(&old);
        }
        Ok(result)
    }
}
