//! Local history deletion. The Tox handle and chat gate serialize removal with
//! callbacks and sends; content-free fences survive an interrupted checkpoint.
use super::*;

#[derive(Serialize)]
pub(crate) struct DeleteMessageResult {
    deleted: bool,
}

pub(crate) fn delete_chat_message_for_state(
    state: &ToxState,
    friend_number: u32,
    expected_public_key: Option<&str>,
    message_id: &str,
) -> Result<DeleteMessageResult, String> {
    if message_id.is_empty() || message_id.len() > 256 {
        return Err("CHAT_MESSAGE_ID_REQUIRED".into());
    }
    let handle = state
        .handle
        .lock()
        .map_err(|_| "TOX_PROFILE_LOCK_POISONED")?;
    let instance = handle.as_ref().ok_or("TOX_NOT_INITIALIZED")?;
    let tox = instance.instance.as_ptr();
    let key = tox_friend_public_key(tox, friend_number).ok_or("CHAT_CONTACT_NOT_FOUND")?;
    if expected_public_key.is_some_and(|expected| !expected.eq_ignore_ascii_case(&key)) {
        return Err("CHAT_CONTACT_IDENTITY_CHANGED".into());
    }
    let _transaction = state
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE")?;
    // Recording may be disabled while older disk history still exists. Reopen
    // its exact store before lookup so deletion never means RAM-only removal.
    if !chat_history_store::contains_registered(&state.history_path) {
        chat_history_store::open_and_register(&state.history_path, Vec::new())?;
    }
    let in_history = chat_history_store::contains_registered(&state.history_path)
        && chat_history_store::find_message_registered(
            &state.history_path,
            friend_number,
            &key,
            message_id,
        )?
        .is_some();
    let in_memory = state
        .messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED")?
        .iter()
        .any(|row| row.id == message_id && message_matches_friend(row, friend_number, &key));
    let mut queued = false;
    for queue in [&state.pending_messages, &state.pending_pq_messages] {
        queued |= queue
            .lock()
            .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?
            .iter()
            .any(|row| {
                row.id == message_id && pending_message_matches_friend(row, friend_number, &key)
            });
    }
    queued |= state
        .pending_files
        .lock()
        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?
        .iter()
        .any(|row| {
            row.id == message_id
                && friend_identity_matches(
                    row.friend_number,
                    &row.friend_public_key,
                    friend_number,
                    &key,
                )
        });
    if !in_history
        && !in_memory
        && !queued
        && !state
            .chat_protocol
            .message_deleted(friend_number, &key, message_id)?
    {
        return Err("CHAT_MESSAGE_NOT_FOUND".into());
    }
    state.chat_transport_ready.store(false, Ordering::Release);
    // Persist the replay fence first. Recovery completes all remaining stores.
    state
        .chat_protocol
        .delete_message(friend_number, &key, message_id)?;
    finish_local_message_deletion(state, tox, friend_number, &key, message_id)?;
    commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)?;
    if chat_history_store::contains_registered(&state.history_path) {
        state
            .chat_protocol
            .complete_message_deletion(friend_number, &key, message_id)?;
    }
    bump_chat_view_revision(&state.history_path, friend_number, &key);
    if let Some(updates) = &state.updates {
        updates.changed();
    }
    Ok(DeleteMessageResult { deleted: true })
}

fn finish_local_message_deletion(
    state: &ToxState,
    tox: *mut c_void,
    friend: u32,
    key: &str,
    id: &str,
) -> Result<(), String> {
    if !chat_history_store::contains_registered(&state.history_path) {
        chat_history_store::open_and_register(&state.history_path, Vec::new())?;
    }
    // Remove app-owned payload before retiring its last history path. A crash
    // can then recover the same cleanup from the still-present attachment row.
    let mut target_rows = state
        .messages
        .lock()
        .map_err(|_| "CHAT_HISTORY_LOCK_POISONED")?
        .iter()
        .filter(|row| row.id == id && message_matches_friend(row, friend, key))
        .cloned()
        .collect::<Vec<_>>();
    if chat_history_store::contains_registered(&state.history_path) {
        target_rows.extend(chat_history_store::find_message_registered(
            &state.history_path,
            friend,
            key,
            id,
        )?);
    }
    for row in target_rows.iter().filter(|row| !row.mine) {
        if let Some(attachment) = row
            .attachment
            .as_ref()
            .filter(|attachment| !attachment.completed)
        {
            let path = Path::new(&attachment.path);
            if path.parent() == Some(state.downloads_dir.as_path()) {
                profiles::remove_file(path)?;
            }
        }
    }
    let mut outgoing_cache_paths = target_rows
        .iter()
        .filter(|row| row.mine)
        .filter_map(|row| row.attachment.as_ref())
        .map(|attachment| outgoing_file_cache_path(&state.outgoing_files_dir, id, &attachment.name))
        .collect::<Vec<_>>();
    outgoing_cache_paths.extend(
        state
            .pending_files
            .lock()
            .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?
            .iter()
            .filter(|row| {
                row.id == id
                    && friend_identity_matches(
                        row.friend_number,
                        &row.friend_public_key,
                        friend,
                        key,
                    )
            })
            .map(|row| outgoing_file_cache_path(&state.outgoing_files_dir, id, &row.filename)),
    );
    if !outgoing_cache_paths.is_empty() && profiles::directory_exists(&state.outgoing_files_dir) {
        for entry in profiles::list(&state.outgoing_files_dir)? {
            if entry.is_file
                && entry.path.parent() == Some(state.outgoing_files_dir.as_path())
                && outgoing_cache_paths.contains(&entry.path)
            {
                profiles::remove_file(&entry.path)?;
            }
        }
    }
    // Serialized manifest mutation rejects older asynchronous writes too.
    if chat_history_store::contains_registered(&state.history_path) {
        chat_history_store::delete_message_registered(&state.history_path, friend, key, id)?;
    }
    {
        let mut rows = state
            .messages
            .lock()
            .map_err(|_| "CHAT_HISTORY_LOCK_POISONED")?;
        rows.retain(|row| row.id != id || !message_matches_friend(row, friend, key));
        for row in rows
            .iter_mut()
            .filter(|row| message_matches_friend(row, friend, key))
        {
            if let Some(quote) = row
                .quote
                .as_mut()
                .filter(|quote| quote.message_id.as_deref() == Some(id))
            {
                quote.text.clear();
                quote.author.clear();
            }
        }
    }
    for (queue, path) in [
        (&state.pending_messages, &state.pending_messages_path),
        (&state.pending_pq_messages, &state.pending_pq_messages_path),
    ] {
        {
            let mut queue = queue
                .lock()
                .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?;
            queue.retain(|row| row.id != id || !pending_message_matches_friend(row, friend, key));
            for row in queue.iter_mut().filter(|row| {
                row.next_offset == 0
                    && pending_message_matches_friend(row, friend, key)
                    && !state.pq.has_durable_message(&row.id)
            }) {
                let mut envelope = if let Some(wire) = row.wire_text.as_deref() {
                    chat_protocol::decode_pq_message(wire)?
                } else {
                    chat_protocol::decode_queued_message_fragments(&row.wire_fragments)?
                };
                if let Some(envelope) = envelope.as_mut().filter(|envelope| {
                    envelope
                        .quote
                        .as_ref()
                        .is_some_and(|quote| quote.message_id.as_deref() == Some(id))
                }) {
                    // v1 peers reject an empty quote. The local history keeps
                    // its reference; the untouched message body remains on wire.
                    envelope.quote = None;
                    if row.wire_text.is_some() {
                        row.wire_text = Some(chat_protocol::encode_pq_message(envelope)?);
                    } else {
                        row.wire_fragments = chat_protocol::encode_message_fragments(envelope)?;
                    }
                }
            }
        }
        persist_pending_messages_required(queue, path)?;
    }
    let legacy_wires = state
        .pq_receipts
        .lock()
        .map_err(|_| "CHAT_RECEIPT_STATE_UNAVAILABLE")?
        .iter()
        .filter_map(|((owner, wire), target)| (*owner == friend && target == id).then_some(*wire))
        .collect::<Vec<_>>();
    if state.pq.has_durable_message(id) {
        state
            .pq
            .bind_contact(friend, key, &pq_tox_owner(tox), true)?;
    }
    state.pq.discard_message(friend, id, &legacy_wires)?;
    state
        .pq_receipts
        .lock()
        .map_err(|_| "CHAT_RECEIPT_STATE_UNAVAILABLE")?
        .retain(|(owner, _), target| *owner != friend || target != id);
    state
        .delivery_receipts
        .lock()
        .map_err(|_| "CHAT_RECEIPT_STATE_UNAVAILABLE")?
        .retain(|(owner, _), target| *owner != friend || target != id);
    state
        .receipt_progress
        .lock()
        .map_err(|_| "CHAT_RECEIPT_STATE_UNAVAILABLE")?
        .remove(id);
    state
        .pending_files
        .lock()
        .map_err(|_| "CHAT_PENDING_QUEUE_LOCK_POISONED")?
        .retain(|row| {
            row.id != id
                || !friend_identity_matches(row.friend_number, &row.friend_public_key, friend, key)
        });
    persist_pending_files_required(&state.pending_files, &state.pending_files_path)?;
    let outgoing = state
        .outgoing_files
        .lock()
        .map_err(|_| "FILE_STATE_UNAVAILABLE")?
        .iter()
        .filter_map(|(slot, transfer)| {
            (slot.0 == friend && transfer.message_id.as_deref() == Some(id)).then_some(*slot)
        })
        .collect::<Vec<_>>();
    let incoming = state
        .incoming_files
        .lock()
        .map_err(|_| "FILE_STATE_UNAVAILABLE")?
        .iter()
        .filter_map(|(slot, transfer)| {
            (slot.0 == friend && transfer.message_id.as_deref() == Some(id))
                .then_some((*slot, transfer.path.clone()))
        })
        .collect::<Vec<_>>();
    // Active incoming paths are incomplete app-owned receives. Completed user
    // downloads have already left this runtime map and are preserved.
    for (_, path) in &incoming {
        if path.parent() == Some(state.downloads_dir.as_path()) {
            profiles::remove_file(path)?;
        }
    }
    for (slot, sending) in outgoing
        .into_iter()
        .map(|slot| (slot, true))
        .chain(incoming.into_iter().map(|(slot, _)| (slot, false)))
    {
        let mut error = 0;
        unsafe {
            tox_file_control(tox, slot.0, slot.1, 2, &mut error);
        }
        remove_file_transfer_for_direction(
            &state.outgoing_files,
            &state.incoming_files,
            slot,
            sending,
        );
    }
    if chat_protocol::validate_common_message_id(id).is_ok() {
        state.file_card_protocol.remove_message(friend, key, id)?;
    }
    #[cfg(feature = "web-core")]
    if let (Some(bridge), Some(profile)) = (&state.web_file_bridge, &state.web_profile_id) {
        bridge.forget_message(profile, friend, key, id)?;
    }
    {
        let mut unread = state
            .unread_state
            .lock()
            .map_err(|_| "UNREAD_STATE_UNAVAILABLE")?;
        let target = unread_target_key(friend, key);
        let removed = unread.unseen_messages.get_mut(&target).map_or(0, |ids| {
            let before = ids.len();
            ids.retain(|message| message != id);
            before - ids.len()
        });
        if let Some(count) = unread.friends.get_mut(&friend.to_string()) {
            *count = count.saturating_sub(removed as u32);
        }
    }
    persist_unread_state_required(&state.unread_state, &state.unread_state_path)?;
    persist_tox_history_required(&state.messages, &state.history_path, &state.history_enabled)?;
    Ok(())
}

pub(crate) fn recover_local_message_deletions(state: &ToxState) -> Result<(), String> {
    let handle = state
        .handle
        .lock()
        .map_err(|_| "TOX_PROFILE_LOCK_POISONED")?;
    let tox = handle
        .as_ref()
        .ok_or("TOX_NOT_INITIALIZED")?
        .instance
        .as_ptr();
    let _transaction = state
        .chat_transaction_gate
        .lock()
        .map_err(|_| "CHAT_TRANSACTION_UNAVAILABLE")?;
    let mut recovered = Vec::new();
    for (key, friend) in tox_friend_numbers_by_public_key(tox) {
        let deleted = state
            .chat_protocol
            .deleted_messages_for_friend(friend, &key)?;
        if !deleted.is_empty() {
            // Startup has not driven transport yet. Resolve the stable PQ
            // route before retiring any already journaled ciphertext.
            state
                .pq
                .bind_contact(friend, &key, &pq_tox_owner(tox), true)?;
        }
        for id in deleted {
            state.chat_transport_ready.store(false, Ordering::Release);
            finish_local_message_deletion(state, tox, friend, &key, &id)?;
            recovered.push((friend, key.clone(), id));
        }
    }
    if !recovered.is_empty() {
        commit_chat_transaction_with_barrier(&state.history_path, &state.chat_transport_ready)?;
        for (friend, key, id) in recovered {
            // An unavailable history store can still contain the old row on
            // disk. Keep its content-free intent until a registered recovery
            // has committed the history tombstone as well.
            if chat_history_store::contains_registered(&state.history_path) {
                state
                    .chat_protocol
                    .complete_message_deletion(friend, &key, &id)?;
            }
            bump_chat_view_revision(&state.history_path, friend, &key);
        }
        if let Some(updates) = &state.updates {
            updates.changed();
        }
    }
    Ok(())
}
