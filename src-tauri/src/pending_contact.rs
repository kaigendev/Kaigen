//! Local lifecycle of a contact whose outgoing request has not been accepted.

use super::*;

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
