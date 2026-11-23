//! Requested history survives for this process in the RAM-key encrypted cache.
//! Every read still validates with the source; cached rows are only delta bases.
use super::{CommandRequest, RemoteProfile};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const FIELD: &str = "_webgateHistory";
const MAX_ROWS: usize = 20_000;

#[derive(Default)]
pub(super) struct HistoryCache;

fn digest(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(&canonical(value)).map_err(|_| "WEBGATE_HISTORY_INVALID")?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
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

fn query_key(request: &CommandRequest) -> Result<String, String> {
    let mut args = request
        .args
        .as_object()
        .cloned()
        .ok_or("WEBGATE_REQUEST_INVALID")?;
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
    digest(&json!({"command":request.command,"args":args}))
}

impl HistoryCache {
    pub(super) fn fetch(
        &mut self,
        remote: &RemoteProfile,
        mut request: CommandRequest,
    ) -> Result<Value, String> {
        let key = query_key(&request)?;
        let object = format!("history:{key}");
        let mut epoch = remote
            .session
            .lock()
            .map_err(|_| "WEBGATE_SESSION_INVALID")?
            .epoch
            .clone();
        let cached = remote
            .cache
            .get(&object)
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|cached| {
                cached.get("epoch").and_then(Value::as_str) == Some(epoch.as_str())
                    && cached.get("key").and_then(Value::as_str) == Some(key.as_str())
                    && cached.get("value").is_some_and(|value| {
                        digest(value).ok().as_deref() == cached.get("token").and_then(Value::as_str)
                    })
            });
        for attempt in 0..2 {
            let base = if attempt == 0 { cached.as_ref() } else { None };
            let args = request
                .args
                .as_object_mut()
                .ok_or("WEBGATE_REQUEST_INVALID")?;
            args.insert(
                FIELD.into(),
                json!({"key":key,"baseToken":base.and_then(|base|base.get("token"))}),
            );
            if base.is_none() {
                args.remove("knownRevision");
            }
            let result = remote.json_operation(
                "command",
                &serde_json::to_value(&request).map_err(|_| "WEBGATE_REQUEST_INVALID")?,
            )?;
            let received_epoch = remote
                .session
                .lock()
                .map_err(|_| "WEBGATE_SESSION_INVALID")?
                .epoch
                .clone();
            if received_epoch != epoch {
                let _ = remote.cache.invalidate(&object);
                epoch = received_epoch;
                if attempt == 0 {
                    continue;
                }
                return Err("WEBGATE_HISTORY_EPOCH_CHANGED".into());
            }
            // Compatibility with old servers and native messages:null replies.
            let Some(wire) = result.get(FIELD) else {
                return Ok(result);
            };
            match hydrate(&key, base, wire) {
                Ok(value) => {
                    let encoded = serde_json::to_vec(
                        &json!({"epoch":epoch,"key":key,"token":wire["token"],"value":value}),
                    )
                    .map_err(|_| "WEBGATE_HISTORY_INVALID")?;
                    remote.cache.put(&object, &encoded)?;
                    return Ok(value);
                }
                Err(_) if attempt == 0 => {
                    let _ = remote.cache.invalidate(&object);
                }
                Err(code) => return Err(code),
            }
        }
        Err("WEBGATE_HISTORY_INVALID".into())
    }
}

fn rows(value: &Value, array: bool) -> Result<&Vec<Value>, String> {
    if array {
        value.as_array()
    } else {
        value.get("messages").and_then(Value::as_array)
    }
    .ok_or_else(|| "WEBGATE_HISTORY_INVALID".into())
}

fn identity(row: &Value) -> Result<&str, String> {
    row.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or_else(|| "WEBGATE_HISTORY_INVALID".into())
}

fn hydrate(key: &str, base: Option<&Value>, wire: &Value) -> Result<Value, String> {
    if wire.get("version").and_then(Value::as_u64) != Some(1)
        || wire.get("key").and_then(Value::as_str) != Some(key)
    {
        return Err("WEBGATE_HISTORY_SCOPE_INVALID".into());
    }
    let token = wire
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| {
            token.len() == 64
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or("WEBGATE_HISTORY_INVALID")?;
    let array = wire
        .get("array")
        .and_then(Value::as_bool)
        .ok_or("WEBGATE_HISTORY_INVALID")?;
    let value = match wire.get("mode").and_then(Value::as_str) {
        Some("full") => wire
            .get("value")
            .cloned()
            .ok_or("WEBGATE_HISTORY_INVALID")?,
        Some("delta") => {
            let base = base.ok_or("WEBGATE_HISTORY_BASE_MISSING")?;
            if base.get("token").and_then(Value::as_str)
                != wire.get("baseToken").and_then(Value::as_str)
            {
                return Err("WEBGATE_HISTORY_BASE_MISSING".into());
            }
            let old = base.get("value").ok_or("WEBGATE_HISTORY_BASE_MISSING")?;
            let old_rows = rows(old, array)?;
            let prefix = wire
                .get("prefix")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or("WEBGATE_HISTORY_INVALID")?;
            let suffix = wire
                .get("suffix")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or("WEBGATE_HISTORY_INVALID")?;
            if prefix
                .checked_add(suffix)
                .is_none_or(|n| n > old_rows.len())
            {
                return Err("WEBGATE_HISTORY_INVALID".into());
            }
            let insert = wire
                .get("insert")
                .and_then(Value::as_array)
                .ok_or("WEBGATE_HISTORY_INVALID")?;
            if prefix.saturating_add(suffix).saturating_add(insert.len()) > MAX_ROWS {
                return Err("WEBGATE_HISTORY_LIMIT".into());
            }
            let mut order = old_rows[..prefix]
                .iter()
                .map(identity)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            for id in insert {
                order.push(
                    id.as_str()
                        .filter(|id| !id.is_empty() && id.len() <= 256)
                        .ok_or("WEBGATE_HISTORY_INVALID")?
                        .to_string(),
                );
            }
            order.extend(
                old_rows[old_rows.len() - suffix..]
                    .iter()
                    .map(identity)
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .map(str::to_string),
            );
            let identities = order.iter().cloned().collect::<HashSet<_>>();
            if identities.len() != order.len() {
                return Err("WEBGATE_HISTORY_INVALID".into());
            }
            let mut indexed = HashMap::new();
            for row in old_rows {
                if indexed
                    .insert(identity(row)?.to_string(), row.clone())
                    .is_some()
                {
                    return Err("WEBGATE_HISTORY_INVALID".into());
                }
            }
            let upserts = wire
                .get("upserts")
                .and_then(Value::as_array)
                .ok_or("WEBGATE_HISTORY_INVALID")?;
            let mut changed = HashSet::new();
            for row in upserts {
                let id = identity(row)?;
                if !identities.contains(id) || !changed.insert(id) {
                    return Err("WEBGATE_HISTORY_INVALID".into());
                }
                indexed.insert(id.into(), row.clone());
            }
            let messages = order
                .into_iter()
                .map(|id| {
                    indexed
                        .remove(&id)
                        .ok_or_else(|| "WEBGATE_HISTORY_BASE_MISSING".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if array {
                Value::Array(messages)
            } else {
                let mut metadata = old.as_object().cloned().ok_or("WEBGATE_HISTORY_INVALID")?;
                metadata.remove("messages");
                for field in wire
                    .get("removedFields")
                    .and_then(Value::as_array)
                    .ok_or("WEBGATE_HISTORY_INVALID")?
                {
                    let field = field
                        .as_str()
                        .filter(|field| *field != "messages")
                        .ok_or("WEBGATE_HISTORY_INVALID")?;
                    metadata.remove(field);
                }
                for (field, value) in wire
                    .get("metadata")
                    .and_then(Value::as_object)
                    .ok_or("WEBGATE_HISTORY_INVALID")?
                {
                    if field == "messages" {
                        return Err("WEBGATE_HISTORY_INVALID".into());
                    }
                    metadata.insert(field.clone(), value.clone());
                }
                metadata.insert("messages".into(), Value::Array(messages));
                Value::Object(metadata)
            }
        }
        _ => return Err("WEBGATE_HISTORY_INVALID".into()),
    };
    let messages = rows(&value, array)?;
    if messages.len() > MAX_ROWS {
        return Err("WEBGATE_HISTORY_LIMIT".into());
    }
    let mut ids = HashSet::new();
    for message in messages {
        if !ids.insert(identity(message)?) {
            return Err("WEBGATE_HISTORY_INVALID".into());
        }
    }
    if digest(&value)? != token {
        return Err("WEBGATE_HISTORY_HASH_MISMATCH".into());
    }
    Ok(value)
}
