use super::{CommandRequest, RemoteProfile};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const KNOWN_AVATARS: &str = "_webgateKnownAvatars";

/// Only public identities and content hashes survive between calls in RAM.
/// Avatar bytes live in the existing ciphertext namespace with its RAM-only key.
#[derive(Default)]
pub(super) struct FriendAvatars {
    known: HashMap<String, String>,
}

impl FriendAvatars {
    pub(super) fn fetch(
        &mut self,
        remote: &RemoteProfile,
        mut request: CommandRequest,
    ) -> Result<Value, String> {
        let mut cached = HashMap::new();
        self.known.retain(|identity, expected| {
            let key = object_key(identity, expected);
            let avatar = remote
                .cache
                .get(&key)
                .ok()
                .flatten()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(|avatar| avatar_hash(avatar).as_deref() == Some(expected.as_str()));
            if let Some(avatar) = avatar {
                cached.insert(identity.clone(), avatar);
                true
            } else {
                let _ = remote.cache.invalidate(&key);
                false
            }
        });
        let args = request
            .args
            .as_object_mut()
            .ok_or("WEBGATE_REQUEST_INVALID")?;
        // Never forward a downstream relay's cache claims to our own upstream.
        // This field's presence opts into the compatible delta response.
        args.insert(KNOWN_AVATARS.into(), json!(self.known));
        let mut result = send(remote, &request)?;
        if !hydrate(&mut result, &cached)? {
            // A missing/corrupt local object must recover with one full fetch.
            // The same read operation ID is retained; no mutation is repeated.
            request.args[KNOWN_AVATARS] = json!({});
            result = send(remote, &request)?;
            if !hydrate(&mut result, &HashMap::new())? {
                return Err("WEBGATE_AVATAR_DELTA_INVALID".into());
            }
        }
        let mut next = HashMap::new();
        for friend in result.as_array().ok_or("WEBGATE_RESPONSE_INVALID")? {
            let identity = friend["public_key"]
                .as_str()
                .ok_or("WEBGATE_RESPONSE_INVALID")?;
            let avatar = &friend["avatar_path"];
            let hash = avatar_hash(avatar).ok_or("WEBGATE_RESPONSE_INVALID")?;
            let existing = self.known.get(identity) == Some(&hash) && cached.contains_key(identity);
            let written = existing
                || serde_json::to_vec(avatar).ok().is_some_and(|bytes| {
                    remote
                        .cache
                        .put(&object_key(identity, &hash), &bytes)
                        .is_ok()
                });
            if written {
                next.insert(identity.to_string(), hash);
            }
        }
        // Keep one version per current contact. Query invalidation deliberately
        // leaves these independent immutable avatar objects available for reuse.
        for (identity, hash) in &self.known {
            if next.get(identity) != Some(hash) {
                let _ = remote.cache.invalidate(&object_key(identity, hash));
            }
        }
        self.known = next;
        Ok(result)
    }
}

fn send(remote: &RemoteProfile, request: &CommandRequest) -> Result<Value, String> {
    remote.json_operation(
        "command",
        &serde_json::to_value(request).map_err(|_| "WEBGATE_REQUEST_INVALID")?,
    )
}

/// False requests exactly one complete retry; malformed hashes fail closed.
fn hydrate(result: &mut Value, cached: &HashMap<String, Value>) -> Result<bool, String> {
    let friends = result.as_array_mut().ok_or("WEBGATE_RESPONSE_INVALID")?;
    let mut identities = HashSet::new();
    let mut complete = true;
    for friend in friends {
        let friend = friend.as_object_mut().ok_or("WEBGATE_RESPONSE_INVALID")?;
        let identity = friend
            .get("public_key")
            .and_then(Value::as_str)
            .filter(|key| key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or("WEBGATE_RESPONSE_INVALID")?
            .to_string();
        if !identities.insert(identity.clone()) {
            return Err("WEBGATE_RESPONSE_INVALID".into());
        }
        let expected = friend
            .remove("avatarSha256")
            .map(|hash| {
                hash.as_str()
                    .filter(|hash| {
                        hash.len() == 64
                            && hash
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                    .map(str::to_string)
                    .ok_or("WEBGATE_AVATAR_DELTA_INVALID")
            })
            .transpose()?;
        if !friend.contains_key("avatar_path") {
            let avatar = cached
                .get(&identity)
                .filter(|avatar| avatar_hash(avatar).as_ref() == expected.as_ref());
            let Some(avatar) = avatar else {
                complete = false;
                continue;
            };
            friend.insert("avatar_path".into(), avatar.clone());
        }
        let actual = avatar_hash(&friend["avatar_path"]).ok_or("WEBGATE_RESPONSE_INVALID")?;
        if expected
            .as_ref()
            .is_some_and(|expected| expected != &actual)
        {
            return Err("WEBGATE_AVATAR_DELTA_INVALID".into());
        }
    }
    Ok(complete)
}

fn avatar_hash(avatar: &Value) -> Option<String> {
    let text = if avatar.is_null() {
        ""
    } else {
        avatar.as_str()?
    };
    Some(
        Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

fn object_key(identity: &str, hash: &str) -> String {
    format!("friend-avatar:{identity}:{hash}")
}
