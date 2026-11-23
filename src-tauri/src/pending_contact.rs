//! Local lifecycle of a contact whose outgoing request has not been accepted.

use super::*;

// Zero is the legacy, never-retired incarnation. The backend alone advances
// this map; renderer snapshots only echo the incarnation they actually loaded.
const MAX_CONTACT_INCARNATION: u64 = 9_007_199_254_740_991;

pub(super) fn incarnations(local: Option<&Value>) -> Result<HashMap<String, u64>, String> {
    let mut result = HashMap::new();
    if let Some(saved) = local.and_then(|value| value.get("contactIncarnations")) {
        let saved = saved.as_object().ok_or("PROFILE_LOCAL_STATE_INVALID")?;
        for (key, value) in saved {
            let key = stable_public_key(key).ok_or("PROFILE_LOCAL_STATE_INVALID")?;
            let generation = value
                .as_u64()
                .filter(|value| *value <= MAX_CONTACT_INCARNATION)
                .ok_or("PROFILE_LOCAL_STATE_INVALID")?;
            result
                .entry(key)
                .and_modify(|current: &mut u64| *current = (*current).max(generation))
                .or_insert(generation);
        }
    }
    // R9 already persisted retirement fences without generations. A held R9
    // request has no map and must not become current after an upgrade/re-add.
    if let Some(retired) = local.and_then(|value| value.get("retiredPendingContactKeys")) {
        for key in retired.as_array().ok_or("PROFILE_LOCAL_STATE_INVALID")? {
            let key = key
                .as_str()
                .and_then(stable_public_key)
                .ok_or("PROFILE_LOCAL_STATE_INVALID")?;
            let generation = result.entry(key).or_insert(1);
            *generation = (*generation).max(1);
        }
    }
    Ok(result)
}

pub(super) fn expose_incarnations(local: &mut Value) -> Result<(), String> {
    let generations = incarnations(Some(local))?;
    local
        .as_object_mut()
        .ok_or("PROFILE_LOCAL_STATE_INVALID")?
        .insert(
            "contactIncarnations".into(),
            serde_json::to_value(generations).map_err(|_| "PROFILE_LOCAL_STATE_INVALID")?,
        );
    Ok(())
}

fn retire_incarnation(local: &mut Value, public_key: &str) -> Result<(), String> {
    let mut generations = incarnations(Some(local))?;
    let current = generations.get(public_key).copied().unwrap_or(0);
    let next = current
        .checked_add(1)
        .filter(|value| *value <= MAX_CONTACT_INCARNATION)
        .ok_or("CHAT_CONTACT_INCARNATION_EXHAUSTED")?;
    generations.insert(public_key.to_string(), next);
    local["contactIncarnations"] =
        serde_json::to_value(generations).map_err(|_| "PROFILE_LOCAL_STATE_INVALID")?;
    Ok(())
}

/// Fence an ordinary authorized-contact deletion without changing its existing
/// recovery/payload policy. Caller holds handle and chat transaction gate.
pub(super) fn retire_local_incarnation(state: &ToxState, public_key: &str) -> Result<(), String> {
    write_profile_local_state_transaction(
        &state.local_state_lock,
        &profile_local_state_path(state)?,
        |previous| {
            let mut next = previous.cloned().unwrap_or_else(|| serde_json::json!({}));
            retire_incarnation(&mut next, public_key)?;
            Ok(next)
        },
    )
}

/// Caller holds the handle or chat transaction gate, excluding deletion while
/// this admission is checked and its payload is committed.
pub(super) fn require_incarnation(
    state: &ToxState,
    public_key: &str,
    expected: Option<u64>,
) -> Result<(), String> {
    if expected.unwrap_or(0) != current_incarnation(state, public_key)? {
        return Err("CHAT_CONTACT_INCARNATION_CHANGED".into());
    }
    Ok(())
}

pub(super) fn current_incarnation(state: &ToxState, public_key: &str) -> Result<u64, String> {
    let _local = state
        .local_state_lock
        .lock()
        .map_err(|_| "PROFILE_LOCAL_STATE_UNAVAILABLE")?;
    let local = read_profile_local_state(&profile_local_state_path(state)?)?;
    Ok(incarnations(local.as_ref())?
        .get(&public_key.to_ascii_uppercase())
        .copied()
        .unwrap_or(0))
}

/// Merge one untrusted renderer snapshot without allowing an older contact
/// incarnation to replace data already stored by its current incarnation.
pub(super) fn merge_local_incarnations(
    next: &mut Value,
    previous: Option<&Value>,
    friends: &HashMap<u32, String>,
) -> Result<bool, String> {
    let generations = incarnations(previous)?;
    let incarnation_changed = generations.iter().any(|(key, current)| {
        next.get("contactIncarnations")
            .and_then(|value| value.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            != *current
    });
    let live = |key: &str| {
        friends
            .values()
            .any(|value| value.eq_ignore_ascii_case(key))
    };
    let stale = generations
        .iter()
        .filter_map(|(key, current)| {
            let supplied = next
                .get("contactIncarnations")
                .and_then(|value| value.get(key))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            (!live(key) || supplied != *current).then_some(key.clone())
        })
        .collect::<HashSet<_>>();
    let stale_chat = |chat: &str| {
        chat.strip_prefix("tox-")
            .and_then(stable_public_key)
            .is_some_and(|key| stale.contains(&key))
    };
    let restore_chat = |chat: &str| {
        chat.strip_prefix("tox-")
            .and_then(stable_public_key)
            .is_some_and(|key| stale.contains(&key) && live(&key))
    };
    let object = next.as_object_mut().ok_or("PROFILE_LOCAL_STATE_INVALID")?;
    for field in [
        "contactNames",
        "drafts",
        "draftFormatting",
        "draftQuotes",
        "scrollAnchors",
        "peerReactionNotices",
    ] {
        let rows = object.entry(field).or_insert_with(|| serde_json::json!({}));
        let rows = rows.as_object_mut().ok_or("PROFILE_LOCAL_STATE_INVALID")?;
        rows.retain(|chat, _| !stale_chat(chat));
        if let Some(saved) = previous
            .and_then(|value| value.get(field))
            .and_then(Value::as_object)
        {
            rows.extend(
                saved
                    .iter()
                    .filter(|(chat, _)| restore_chat(chat))
                    .map(|(chat, value)| (chat.clone(), value.clone())),
            );
        }
    }
    if object
        .get("activeChat")
        .and_then(Value::as_str)
        .is_some_and(stale_chat)
    {
        object.insert(
            "activeChat".into(),
            previous
                .and_then(|value| value.get("activeChat"))
                .filter(|value| {
                    value
                        .as_str()
                        .is_none_or(|chat| !stale_chat(chat) || restore_chat(chat))
                })
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
    }
    let operations = object
        .entry("pendingSendOperations")
        .or_insert_with(|| serde_json::json!({}));
    let operations = operations
        .as_object_mut()
        .ok_or("PROFILE_LOCAL_STATE_INVALID")?;
    operations.retain(|_, operation| {
        let (Some(key), Some(chat)) = local_send_stable_keys(operation) else {
            return false;
        };
        key == chat
            && !stale.contains(&key)
            && operation
                .get("expectedContactIncarnation")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                == generations.get(&key).copied().unwrap_or(0)
    });
    if let Some(saved) = previous
        .and_then(|value| value.get("pendingSendOperations"))
        .and_then(Value::as_object)
    {
        for (id, operation) in saved {
            let (Some(key), Some(chat)) = local_send_stable_keys(operation) else {
                continue;
            };
            if key == chat
                && stale.contains(&key)
                && live(&key)
                && operation
                    .get("expectedContactIncarnation")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    == generations.get(&key).copied().unwrap_or(0)
            {
                operations.insert(id.clone(), operation.clone());
            }
        }
    }
    // Group definitions referenced by a preserved assignment must survive too.
    if let Some(groups) = object
        .get_mut("contactGroups")
        .and_then(Value::as_object_mut)
    {
        let assignments = groups
            .entry("assignments")
            .or_insert_with(|| serde_json::json!({}));
        let assignments = assignments
            .as_object_mut()
            .ok_or("PROFILE_LOCAL_STATE_INVALID")?;
        assignments.retain(|key, _| !stale.contains(&key.to_ascii_uppercase()));
        let saved_groups = previous.and_then(|value| value.get("contactGroups"));
        let mut preserved_groups = HashSet::new();
        if let Some(saved) = saved_groups
            .and_then(|value| value.get("assignments"))
            .and_then(Value::as_object)
        {
            for (key, value) in saved {
                let Some(key) = stable_public_key(key) else {
                    continue;
                };
                if stale.contains(&key) && live(&key) {
                    assignments.insert(key, value.clone());
                    if let Some(id) = value.as_str() {
                        preserved_groups.insert(id.to_string());
                    }
                }
            }
        }
        if let Some(rows) = groups.get_mut("groups").and_then(Value::as_array_mut) {
            rows.retain(|row| {
                !row.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| preserved_groups.contains(id))
            });
            rows.extend(
                saved_groups
                    .and_then(|value| value.get("groups"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|row| {
                        row.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| preserved_groups.contains(id))
                    })
                    .cloned(),
            );
        }
    } else if !stale.is_empty() {
        // Missing groups is an old/partial snapshot, not authority to erase a
        // newer incarnation's assignment. The normal sanitizer filters peers.
        if let Some(saved) = previous.and_then(|value| value.get("contactGroups")) {
            object.insert("contactGroups".into(), saved.clone());
        }
    }
    object.insert(
        "contactIncarnations".into(),
        serde_json::to_value(generations).map_err(|_| "PROFILE_LOCAL_STATE_INVALID")?,
    );
    if let Some(retired) = previous.and_then(|value| value.get("retiredPendingContactKeys")) {
        object.insert("retiredPendingContactKeys".into(), retired.clone());
    }
    Ok(incarnation_changed)
}

pub(super) fn is_pending(state: &ToxState, public_key: &str) -> Result<bool, String> {
    let cache = state
        .friend_cache
        .lock()
        .map_err(|_| "FRIEND_CACHE_UNAVAILABLE".to_string())?;
    Ok(cache
        .get(&public_key.to_ascii_uppercase())
        .is_some_and(|entry| entry.pending_authorization && !entry.authorized))
}

pub(super) fn retain_local_contact_fields(
    state: &mut Value,
    keep: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let object = state.as_object_mut().ok_or("PROFILE_LOCAL_STATE_INVALID")?;
    for field in [
        "contactNames",
        "drafts",
        "draftFormatting",
        "draftQuotes",
        "scrollAnchors",
        "peerReactionNotices",
    ] {
        if let Some(rows) = object.get_mut(field).and_then(Value::as_object_mut) {
            rows.retain(|chat_id, _| {
                chat_id
                    .strip_prefix("tox-")
                    .and_then(stable_public_key)
                    .is_none_or(|key| keep(&key))
            });
        }
    }
    if object
        .get("activeChat")
        .and_then(Value::as_str)
        .and_then(|chat| chat.strip_prefix("tox-"))
        .and_then(stable_public_key)
        .is_some_and(|key| !keep(&key))
    {
        object.insert("activeChat".into(), Value::String(String::new()));
    }
    Ok(())
}

pub(super) fn restore_outgoing_requests(
    local: &mut Value,
    cache: &HashMap<String, CachedFriendProfile>,
    friends: &HashMap<u32, String>,
) -> Result<(), String> {
    let object = local.as_object_mut().ok_or("PROFILE_LOCAL_STATE_INVALID")?;
    let mut pending = cache
        .iter()
        .filter(|(key, entry)| {
            entry.pending_authorization
                && !entry.authorized
                && !entry.tox_id.is_empty()
                && friends.values().any(|live| live.eq_ignore_ascii_case(key))
        })
        .collect::<Vec<_>>();
    pending
        .sort_by(|(left, a), (right, b)| a.added_at.cmp(&b.added_at).then_with(|| left.cmp(right)));
    object.insert(
        "outgoingFriendRequests".into(),
        Value::Array(
            pending
                .into_iter()
                .map(|(_, entry)| {
                    serde_json::json!({
                        "toxId": entry.tox_id,
                        "message": entry.authorization_message,
                    })
                })
                .collect(),
        ),
    );
    Ok(())
}

// The caller owns the handle, so a profile switch or reused number cannot
// change the recipient while the durable request metadata is written.
pub(super) fn persist_outgoing_requests(
    state: &ToxState,
    handle: &ToxHandle,
) -> Result<(), String> {
    let friends = handle
        .friend_numbers()
        .into_iter()
        .filter_map(|number| {
            tox_friend_public_key(Some(handle.native()), number).map(|key| (number, key))
        })
        .collect::<HashMap<_, _>>();
    let cache = state
        .friend_cache
        .lock()
        .map_err(|_| "FRIEND_CACHE_UNAVAILABLE".to_string())?
        .clone();
    write_profile_local_state_transaction(
        &state.local_state_lock,
        &profile_local_state_path(state)?,
        |previous| {
            let mut next = previous.cloned().unwrap_or_else(|| serde_json::json!({}));
            validate_pending_send_owners(&next, state.owner_profile_id.as_deref())?;
            expose_incarnations(&mut next)?;
            restore_outgoing_requests(&mut next, &cache, &friends)?;
            Ok(next)
        },
    )
}

/// Retry the durable tail after native deletion already succeeded. A numeric
/// slot is never used here: a live re-add and an authorized cache record are
/// excluded even when an older deletion marker exists for the same key.
pub(super) fn finish_absent_with_handle(
    state: &ToxState,
    handle: &ToxHandle,
    expected_key: Option<&str>,
) -> Result<bool, String> {
    if expected_key.is_some_and(|key| resolve_current_friend_number(handle.native(), key).is_some())
    {
        return Ok(false);
    }
    let _transaction = state
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE")?;
    let retired = {
        let _local = state
            .local_state_lock
            .lock()
            .map_err(|_| "PROFILE_LOCAL_STATE_UNAVAILABLE")?;
        read_profile_local_state(&profile_local_state_path(state)?)?
            .and_then(|local| local.get("retiredPendingContactKeys").cloned())
            .and_then(|keys| keys.as_array().cloned())
            .unwrap_or_default()
    };
    let mut cache = state
        .friend_cache
        .lock()
        .map_err(|_| "FRIEND_CACHE_UNAVAILABLE")?;
    let absent = retired
        .iter()
        .filter_map(Value::as_str)
        .filter_map(stable_public_key)
        .filter(|key| expected_key.is_none_or(|expected| expected.eq_ignore_ascii_case(key)))
        .filter(|key| resolve_current_friend_number(handle.native(), key).is_none())
        .filter(|key| {
            cache
                .get(key)
                .is_none_or(|entry| entry.pending_authorization && !entry.authorized)
        })
        .collect::<HashSet<_>>();
    if absent.is_empty() {
        return Ok(false);
    }
    state.chat_transport_ready.store(false, Ordering::Release);
    ToxState::save(handle)?;
    let mut next_cache = cache.clone();
    next_cache.retain(|key, _| !absent.contains(key));
    wait_for_atomic_write(enqueue_friend_cache_write_required(
        &next_cache,
        &state.friend_cache_path,
    )?)?;
    *cache = next_cache;
    drop(cache);
    // Keep the barrier closed until the caller runs the existing recovery of
    // message-deletion intents and staged queues/history after this tail.
    commit_chat_transaction(&state.history_path)?;
    Ok(true)
}

#[cfg(test)]
mod incarnation_tests {
    use super::*;

    #[test]
    fn legacy_retirement_migrates_once_and_incarnation_cannot_wrap() {
        let key = "AB".repeat(32);
        let untouched = "CD".repeat(32);
        let mut legacy = serde_json::json!({
            "retiredPendingContactKeys": [key.to_lowercase()],
            "drafts": {"existing-r9-data": "retain migration data"}
        });
        expose_incarnations(&mut legacy).unwrap();
        assert_eq!(legacy["contactIncarnations"][&key], 1);
        assert_eq!(incarnations(Some(&legacy)).unwrap().get(&untouched), None);
        assert_eq!(
            legacy["drafts"]["existing-r9-data"],
            "retain migration data"
        );
        let migrated = legacy.clone();
        expose_incarnations(&mut legacy).unwrap();
        assert_eq!(
            legacy, migrated,
            "reading a migrated state must not retire again"
        );
        retire_incarnation(&mut legacy, &key).unwrap();
        assert_eq!(legacy["contactIncarnations"][&key], 2);
        legacy["contactIncarnations"][&key] = Value::from(MAX_CONTACT_INCARNATION);
        let exhausted = legacy.clone();
        assert_eq!(
            retire_incarnation(&mut legacy, &key).unwrap_err(),
            "CHAT_CONTACT_INCARNATION_EXHAUSTED"
        );
        assert_eq!(legacy, exhausted);
        assert!(incarnations(None).unwrap().is_empty());
    }

    #[test]
    fn malformed_authoritative_incarnations_fail_without_mutating_state() {
        let key = "AB".repeat(32);
        let invalid = [
            serde_json::json!({"contactIncarnations": null}),
            serde_json::json!({"contactIncarnations": {(key.clone()): "1"}}),
            serde_json::json!({"contactIncarnations": {(key): MAX_CONTACT_INCARNATION + 1}}),
            serde_json::json!({"contactIncarnations": {"not-a-public-key": 1}}),
            serde_json::json!({"retiredPendingContactKeys": [false]}),
        ];
        for mut state in invalid {
            let before = state.clone();
            assert_eq!(
                expose_incarnations(&mut state).unwrap_err(),
                "PROFILE_LOCAL_STATE_INVALID"
            );
            assert_eq!(state, before);
        }
    }

    #[test]
    fn stale_snapshot_preserves_current_contact_and_unrelated_edits() {
        let key = "AB".repeat(32);
        let other = "CD".repeat(32);
        let chat = format!("tox-{key}");
        let other_chat = format!("tox-{other}");
        let operation = |key: &str, epoch, text: &str| {
            serde_json::json!({
                "expectedPublicKey": key, "chatId": format!("tox-{key}"),
                "expectedContactIncarnation": epoch, "text": text
            })
        };
        let mut previous = serde_json::json!({
            "contactIncarnations": {(key.clone()): 1},
            "retiredPendingContactKeys": [key.clone()],
            "activeChat": chat.clone(),
            "pendingSendOperations": {"new-operation": operation(&key, 1, "new queued text")},
            "contactGroups": {
                "groups": [{"id": "new-group", "name": "New group"}],
                "assignments": {(key.clone()): "new-group"},
                "order": ["new-group"]
            }
        });
        let mut stale = serde_json::json!({
            "contactIncarnations": {(key.clone()): 0},
            "activeChat": chat.clone(), "sendOnEnter": false,
            "pendingSendOperations": {
                "old-operation": operation(&key, 0, "old queued text"),
                "other-operation": operation(&other, 0, "other queued text")
            },
            "contactGroups": {
                "groups": [{"id": "old-group", "name": "Old group"}, {"id": "other-group", "name": "Other group"}],
                "assignments": {(key.clone()): "old-group", (other.clone()): "other-group"},
                "order": ["old-group", "other-group"]
            }
        });
        let fields = [
            ("contactNames", serde_json::json!("New contact name")),
            ("drafts", serde_json::json!("New contact draft")),
            ("draftFormatting", serde_json::json!([])),
            (
                "draftQuotes",
                serde_json::json!({"id": "new-quote", "text": "New quote"}),
            ),
            (
                "scrollAnchors",
                serde_json::json!({"messageId": "new-anchor", "offset": 0}),
            ),
            (
                "peerReactionNotices",
                serde_json::json!({"through": 7, "notices": []}),
            ),
        ];
        for (field, current) in &fields {
            previous[*field] = serde_json::json!({(chat.clone()): current});
            stale[*field] = serde_json::json!({(chat.clone()): "old value", (other_chat.clone()): "unrelated edit"});
        }
        let friends = HashMap::from([(2, key.clone()), (8, other.clone())]);
        assert!(merge_local_incarnations(&mut stale, Some(&previous), &friends).unwrap());
        for (field, current) in fields {
            assert_eq!(
                &stale[field][&chat], &current,
                "current {field} was overwritten"
            );
            assert_eq!(stale[field][&other_chat], "unrelated edit");
        }
        assert_eq!(stale["activeChat"], chat);
        assert_eq!(stale["sendOnEnter"], false);
        assert_eq!(stale["contactIncarnations"][&key], 1);
        assert!(stale["pendingSendOperations"]
            .get("old-operation")
            .is_none());
        assert_eq!(
            stale["pendingSendOperations"]["new-operation"],
            previous["pendingSendOperations"]["new-operation"]
        );
        assert_eq!(
            stale["pendingSendOperations"]["other-operation"]["text"],
            "other queued text"
        );
        assert_eq!(stale["contactGroups"]["assignments"][&key], "new-group");
        assert_eq!(stale["contactGroups"]["assignments"][&other], "other-group");
        assert!(stale["contactGroups"]["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| group["id"] == "new-group"));

        // A snapshot-level token cannot promote an older queued operation.
        stale["pendingSendOperations"]["old-operation"] = operation(&key, 0, "old queued text");
        assert!(!merge_local_incarnations(&mut stale, Some(&previous), &friends).unwrap());
        assert!(stale["pendingSendOperations"]
            .get("old-operation")
            .is_none());
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn same_key_readd_rejects_stale_send_delete_and_reject_without_replay() {
        let root = crate::tox_tests::temporary_root("contact-incarnation-boundary");
        let paths = ProfilePaths::new(
            root.clone(),
            root.join("profile/data"),
            root.join("profile/test.tox"),
        )
        .unwrap();
        let state = crate::tox_tests::offline_test_state(&root, paths, None, "Incarnation fixture");
        let (old_friend, key) =
            crate::tox_tests::add_offline_test_friend(&state, &root, "incarnation");
        state.stop();
        crate::desktop_adapter::delete_tox_friend_for_state(&state, old_friend).unwrap();
        assert_eq!(current_incarnation(&state, &key).unwrap(), 1);
        let peer_key: [u8; 32] = std::array::from_fn(|index| {
            u8::from_str_radix(&key[index * 2..index * 2 + 2], 16).unwrap()
        });
        let friend = {
            let handle = state.handle.lock().unwrap();
            let handle = handle.as_ref().unwrap();
            let mut error = 0;
            let friend = handle.native().friend_add_norequest(&peer_key, &mut error);
            assert_eq!(error, 0);
            ToxState::save(handle).unwrap();
            friend
        };
        *state.incoming_requests.lock().unwrap() = vec![IncomingFriendRequest {
            public_key: key.clone(),
            message: "current request".into(),
        }];
        let operation_id = "contact-incarnation-operation";
        let send = |epoch, text: &str| {
            crate::send_chat_message_for_state_with_connection_observation_bound(
                &state,
                friend,
                text.into(),
                Some(operation_id.into()),
                None,
                Vec::new(),
                false,
                None,
                Some(false),
                Some(&key),
                epoch,
            )
        };
        for old_epoch in [None, Some(0)] {
            assert_eq!(
                send(old_epoch, "old synthetic text").err().unwrap(),
                "CHAT_CONTACT_INCARNATION_CHANGED"
            );
        }
        assert_eq!(
            crate::desktop_adapter::delete_tox_friend_for_state(&state, friend).unwrap_err(),
            "CHAT_CONTACT_INCARNATION_CHANGED"
        );
        let mut cleanup_called = false;
        assert_eq!(
            crate::reject_incoming_friend_request_with_cleanup(&state, &key, Some(0), |_, _| {
                cleanup_called = true;
                Ok(Vec::new())
            })
            .unwrap_err(),
            "CHAT_CONTACT_INCARNATION_CHANGED"
        );
        assert!(!cleanup_called);
        assert_eq!(
            state.incoming_requests.lock().unwrap()[0].message,
            "current request"
        );
        assert_eq!(state.stable_friend_public_key(friend), key);
        assert!(state.pending_messages.lock().unwrap().is_empty());
        assert!(state.pending_pq_messages.lock().unwrap().is_empty());
        assert!(!state
            .messages
            .lock()
            .unwrap()
            .iter()
            .any(|message| message.operation_id.as_deref() == Some(operation_id)));

        // A refused old payload did not reserve this operation ID. The current
        // incarnation can admit new text, and a later old retry still refuses.
        let accepted = send(Some(1), "new synthetic text").unwrap();
        assert_eq!(accepted.delivery, "pending");
        assert_eq!(
            send(Some(0), "old synthetic text").err().unwrap(),
            "CHAT_CONTACT_INCARNATION_CHANGED"
        );
        let messages = state.messages.lock().unwrap();
        let admitted = messages
            .iter()
            .filter(|message| message.operation_id.as_deref() == Some(operation_id))
            .collect::<Vec<_>>();
        assert_eq!(admitted.len(), 1);
        assert_eq!(admitted[0].id, accepted.message_id);
        assert_eq!(admitted[0].text, "new synthetic text");
        drop(messages);
        assert_eq!(current_incarnation(&state, &key).unwrap(), 1);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}

pub(super) fn recover_absent_purges(state: &ToxState) -> Result<(), String> {
    let handle = state
        .handle
        .lock()
        .map_err(|_| "TOX_PROFILE_LOCK_POISONED")?;
    let handle = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
    finish_absent_with_handle(state, handle, None)?;
    Ok(())
}

/// Caller holds the native handle. This helper takes the transaction gate in
/// network-loop order and never touches an already authorized contact.
pub(super) fn purge_with_handle(
    state: &ToxState,
    handle: &ToxHandle,
    friend: u32,
    public_key: &str,
    remove_external_payloads: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<bool, String> {
    let current_key =
        tox_friend_public_key(Some(handle.native()), friend).ok_or("CHAT_CONTACT_NOT_FOUND")?;
    if !current_key.eq_ignore_ascii_case(public_key) {
        return Err("CHAT_CONTACT_IDENTITY_CHANGED".into());
    }
    if !is_pending(state, &current_key)? {
        return Ok(false);
    }
    let _transaction = state
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE".to_string())?;
    // Web storage may complete asynchronously. Keep the native contact present
    // until that route confirms removal, so BUSY/error can be safely retried.
    let extra_message_ids = remove_external_payloads()?;
    bind_pq_contact(
        &state.pq,
        &state.messages,
        &state.history_path,
        friend,
        &current_key,
        &pq_tox_owner(handle.native()),
    )?;
    let local_state_path = profile_local_state_path(state)?;
    let local_operation_ids = {
        let _local = state
            .local_state_lock
            .lock()
            .map_err(|_| "PROFILE_LOCAL_STATE_UNAVAILABLE")?;
        let saved = read_profile_local_state(&local_state_path)?;
        if let Some(saved) = &saved {
            validate_pending_send_owners(saved, state.owner_profile_id.as_deref())?;
        }
        deleted_contact_local_operation_ids(saved.as_ref(), &current_key)
    };
    let mut pending = state
        .pending_messages
        .lock()
        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?;
    let mut pending_pq = state
        .pending_pq_messages
        .lock()
        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?;
    let mut files = state
        .pending_files
        .lock()
        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?;
    let matches = |key: &str| key.eq_ignore_ascii_case(&current_key);
    let mut retired_ids = pending
        .iter()
        .chain(pending_pq.iter())
        .filter(|item| matches(&item.friend_public_key))
        .map(|item| item.id.clone())
        .chain(
            files
                .iter()
                .filter(|item| matches(&item.friend_public_key))
                .map(|item| item.id.clone()),
        )
        .chain(extra_message_ids)
        .collect::<Vec<_>>();
    let mut owned_files = files
        .iter()
        .filter(|item| matches(&item.friend_public_key))
        .filter_map(|item| {
            let expected =
                outgoing_file_cache_path(&state.outgoing_files_dir, &item.id, &item.filename);
            (expected.parent() == Some(state.outgoing_files_dir.as_path())
                && Path::new(&item.path) == expected.as_path())
            .then_some(expected)
        })
        .collect::<HashSet<_>>();
    {
        let messages = state
            .messages
            .lock()
            .map_err(|_| "CHAT_HISTORY_LOCK_POISONED")?;
        for message in messages
            .iter()
            .filter(|item| matches(&item.friend_public_key))
        {
            retired_ids.push(message.id.clone());
            if let Some(attachment) = &message.attachment {
                let expected = outgoing_file_cache_path(
                    &state.outgoing_files_dir,
                    &message.id,
                    &attachment.name,
                );
                if expected.parent() == Some(state.outgoing_files_dir.as_path())
                    && Path::new(&attachment.path) == expected.as_path()
                {
                    owned_files.insert(expected);
                }
            }
        }
    }
    state
        .chat_protocol
        .block_friend_send_operations(friend, &current_key, &local_operation_ids)?;
    state
        .chat_protocol
        .retire_friend_message_ids(friend, &current_key, &retired_ids)?;
    state.chat_transport_ready.store(false, Ordering::Release);
    commit_chat_transaction(&state.history_path)?;
    state.pq.remove_friend(friend)?;
    // Keep queue references until every owned file has been removed. A failed
    // remove can then be retried without losing the only path to its payload.
    for path in owned_files {
        profiles::remove_file(&path)?;
    }
    pending.retain(|item| !matches(&item.friend_public_key));
    pending_pq.retain(|item| !matches(&item.friend_public_key));
    files.retain(|item| !matches(&item.friend_public_key));
    drop(pending);
    drop(pending_pq);
    drop(files);
    persist_pending_messages_required(&state.pending_messages, &state.pending_messages_path)?;
    persist_pending_messages_required(&state.pending_pq_messages, &state.pending_pq_messages_path)?;
    persist_pending_files_required(&state.pending_files, &state.pending_files_path)?;
    state.chat_protocol.remove_friend(friend, &current_key)?;
    state
        .file_card_protocol
        .remove_friend(friend, &current_key)?;
    let avatar_prefix = format!("{current_key}-");
    for entry in profiles::list(&state.avatars_dir)? {
        if entry.is_file
            && entry
                .path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(&avatar_prefix))
        {
            profiles::remove_file(&entry.path)?;
        }
    }
    {
        let mut messages = state
            .messages
            .lock()
            .map_err(|_| "CHAT_HISTORY_LOCK_POISONED")?;
        messages.retain(|item| !matches(&item.friend_public_key));
        let cleared = enqueue_registered_history_clear_required(
            &state.history_path,
            Some((friend, &current_key)),
        );
        drop(messages);
        wait_for_registered_history_write(cleared?)?;
    }
    write_profile_local_state_transaction(
        &state.local_state_lock,
        &local_state_path,
        |previous| {
            let mut next = previous.cloned().unwrap_or_else(|| serde_json::json!({}));
            retire_incarnation(&mut next, &current_key)?;
            remove_deleted_contact_from_local_state(&mut next, &current_key)?;
            retain_local_contact_fields(&mut next, |key| !matches(key))?;
            let retired = next
                .as_object_mut()
                .ok_or("PROFILE_LOCAL_STATE_INVALID")?
                .entry("retiredPendingContactKeys")
                .or_insert_with(|| serde_json::json!([]));
            let retired = retired
                .as_array_mut()
                .ok_or("PROFILE_LOCAL_STATE_INVALID")?;
            if !retired.iter().filter_map(Value::as_str).any(matches) {
                retired.push(Value::String(current_key.clone()));
            }
            Ok(next)
        },
    )?;
    {
        let mut requests = state
            .incoming_requests
            .lock()
            .map_err(|_| "FRIEND_REQUESTS_UNAVAILABLE")?;
        let mut next = requests.clone();
        next.retain(|request| !matches(&request.public_key));
        profiles::write_file_checkpointed(
            &state.incoming_requests_path,
            &serde_json::to_vec(&next).map_err(|error| error.to_string())?,
        )?;
        *requests = next;
    }
    {
        let mut unread = state
            .unread_state
            .lock()
            .map_err(|_| "UNREAD_STATE_UNAVAILABLE")?;
        let target = unread_target_key(friend, &current_key);
        unread.friends.remove(&target);
        unread.unseen_messages.remove(&target);
        unread.requests.retain(|key| !matches(key));
    }
    persist_unread_state_required(&state.unread_state, &state.unread_state_path)?;
    {
        let mut receipts = state
            .delivery_receipts
            .lock()
            .map_err(|_| "CHAT_RECEIPTS_UNAVAILABLE")?;
        let removed = receipts
            .iter()
            .filter(|((owner, _), _)| *owner == friend)
            .map(|(_, id)| id.clone())
            .collect::<HashSet<_>>();
        receipts.retain(|(owner, _), _| *owner != friend);
        state
            .receipt_progress
            .lock()
            .map_err(|_| "CHAT_RECEIPTS_UNAVAILABLE")?
            .retain(|id, _| !removed.contains(id));
    }
    state
        .incoming_files
        .lock()
        .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?
        .retain(|(owner, _), _| *owner != friend);
    state
        .outgoing_files
        .lock()
        .map_err(|_| "TRANSFER_STATE_UNAVAILABLE")?
        .retain(|(owner, _), _| *owner != friend);
    state
        .friend_message_ready_at
        .lock()
        .map_err(|_| "FRIEND_CACHE_UNAVAILABLE")?
        .remove(&friend);
    state
        .friend_status_received
        .lock()
        .map_err(|_| "FRIEND_CACHE_UNAVAILABLE")?
        .remove(&friend);
    state
        .history_residency
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED")?
        .remove(&unread_target_key(friend, &current_key));
    state
        .pq_active_history_reconciled
        .lock()
        .map_err(|_| "PQ_STATE_LOCKED")?
        .remove(&current_key);
    // Remove numeric runtime bindings before toxcore can reuse the slot. The
    // remaining fallible tail is retryable solely by the retired public key.
    let mut error = 0;
    if !handle.native().friend_delete(friend, &mut error) {
        return Err(format!("TOX_FRIEND_DELETE_FAILED_{error}"));
    }
    ToxState::save(handle)?;
    let cache_write = {
        let mut cache = state
            .friend_cache
            .lock()
            .map_err(|_| "FRIEND_CACHE_UNAVAILABLE")?;
        cache.remove(&current_key);
        enqueue_friend_cache_write_required(&cache, &state.friend_cache_path)?
    };
    wait_for_atomic_write(cache_write)?;
    bump_history_revision(&state.history_path);
    commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)?;
    if let Some(updates) = &state.updates {
        updates.changed();
    }
    Ok(true)
}
