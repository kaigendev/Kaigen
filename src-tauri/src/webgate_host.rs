//! Remote profiles and their minimal saved connections. This registry never
//! opens a Tox runtime or a profile container.

mod persistence;
mod restore;

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;

use crate::webgate::{ConnectionCard, HopIdentity, RemoteProfile, StreamEvent, TransportPolicy};
use crate::webgate_persistence::{ConnectionStore, PersistedConnections, StoredConnection};

pub type RemoteEventHandler = Arc<dyn Fn(String, StreamEvent) + Send + Sync>;

struct HostEntry {
    remote: Arc<RemoteProfile>,
    generation: AtomicU64,
    cache_gate: Mutex<()>,
}

#[derive(Default)]
pub struct WebgateHost {
    connection_gate: Mutex<()>,
    profiles: Mutex<HashMap<String, Arc<HostEntry>>>,
    active: Mutex<Option<String>>,
    events: Mutex<Option<RemoteEventHandler>>,
    relay_identity: Mutex<Option<(String, String)>>,
    records: Mutex<PersistedConnections>,
    store: Mutex<Option<ConnectionStore>>,
    store_gate: Mutex<()>,
    restore_jobs: Mutex<HashMap<String, Arc<persistence::RestoreJob>>>,
    restore_pool: Mutex<Option<Arc<restore::RestorePool>>>,
    restore_errors: Mutex<HashMap<String, String>>,
    closing: AtomicBool,
    lifecycle_generation: AtomicU64,
}

impl WebgateHost {
    /// The network operation deliberately runs before acquiring registry locks.
    pub fn connect(
        self: &Arc<Self>,
        card: ConnectionCard,
        password: &str,
        policy: TransportPolicy,
        cache_root: &Path,
    ) -> Result<Value, String> {
        let mut random = [0_u8; 24];
        getrandom::fill(&mut random).map_err(|_| "WEBGATE_RANDOM_FAILED")?;
        let id = format!("wg-{}", URL_SAFE_NO_PAD.encode(random));
        self.connect_at(id, card, password, policy, cache_root, None)
    }

    pub fn reconnect(
        self: &Arc<Self>,
        id: &str,
        card: ConnectionCard,
        password: &str,
        policy: TransportPolicy,
        cache_root: &Path,
    ) -> Result<Value, String> {
        if !self.contains(id) {
            return Err("WEBGATE_PROFILE_NOT_FOUND".into());
        }
        self.connect_at(id.to_owned(), card, password, policy, cache_root, None)
    }

    fn connect_at(
        self: &Arc<Self>,
        id: String,
        card: ConnectionCard,
        password: &str,
        policy: TransportPolicy,
        cache_root: &Path,
        expected: Option<&StoredConnection>,
    ) -> Result<Value, String> {
        // Capture the registration before network work. An offline restore
        // must never block removing/editing another account or this record.
        let (lifecycle, before_record, before_entry) = {
            let _connection = self
                .connection_gate
                .lock()
                .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
            if self.closing.load(Ordering::Acquire) {
                return Err("WEBGATE_CLOSED".into());
            }
            if let Some(expected) = expected {
                let current = self.stored(&id).ok_or("WEBGATE_PROFILE_NOT_FOUND")?;
                if !persistence::same_connection(&current, expected) {
                    return Err("WEBGATE_RESTORE_SUPERSEDED".into());
                }
                if let Some(remote) = self.get(&id) {
                    expected.validate_remote(&remote)?;
                    return Ok(serde_json::json!({"profileId":id,"profiles":self.summaries()}));
                }
            }
            (
                self.lifecycle_generation.load(Ordering::Acquire),
                self.stored(&id),
                self.get_entry(&id),
            )
        };
        let is_new = before_record.is_none();
        let remote = RemoteProfile::connect(card, password, policy, &cache_root.join(&id))?;
        let _connection = self
            .connection_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if self.closing.load(Ordering::Acquire)
            || lifecycle != self.lifecycle_generation.load(Ordering::Acquire)
        {
            let _ = remote.close();
            return Err("WEBGATE_CLOSED".into());
        }
        let same_record = match (&before_record, self.stored(&id)) {
            (None, None) => true,
            (Some(before), Some(current)) => persistence::same_connection(before, &current),
            _ => false,
        };
        let same_entry = match (&before_entry, self.get_entry(&id)) {
            (None, None) => true,
            (Some(before), Some(current)) => Arc::ptr_eq(before, &current),
            _ => false,
        };
        if !same_record || !same_entry {
            let _ = remote.close();
            return Err("WEBGATE_RESTORE_SUPERSEDED".into());
        }
        if let Some(expected) = expected {
            if let Err(error) = expected.validate_remote(&remote) {
                let _ = remote.close();
                return Err(error);
            }
        }
        if let Some((server, workspace)) = self
            .relay_identity
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
            .as_ref()
        {
            let metadata = remote.metadata();
            let trace = metadata
                .get("trace")
                .and_then(Value::as_array)
                .ok_or("WEBGATE_TRACE_INVALID")?;
            if trace.iter().any(|hop| {
                hop.get("serverId").and_then(Value::as_str) == Some(server.as_str())
                    && hop.get("workspaceId").and_then(Value::as_str) == Some(workspace.as_str())
                    && hop.get("profileId").and_then(Value::as_str) == Some(id.as_str())
            }) {
                let _ = remote.close();
                return Err("WEBGATE_CYCLE_DETECTED".into());
            }
        }
        let previous = self.get(&id);
        if self
            .stored(&id)
            .is_some_and(|old| old.tox_id != remote.tox_id())
            || previous
                .as_ref()
                .is_some_and(|old| old.tox_id() != remote.tox_id())
        {
            let _ = remote.close();
            return Err("WEBGATE_ACCOUNT_IDENTITY_CHANGED".into());
        }
        let entry = Arc::new(HostEntry {
            remote: Arc::clone(&remote),
            generation: AtomicU64::new(1),
            cache_gate: Mutex::new(()),
        });
        let previous_active = self.active_id();
        let weak = Arc::downgrade(self);
        let weak_entry = Arc::downgrade(&entry);
        let event_id = id.clone();
        if let Err(error) = remote.start_events(Arc::new(move |event| {
            let Some(host) = weak.upgrade() else { return };
            let Some(entry) = weak_entry.upgrade() else {
                return;
            };
            if !host
                .get_entry(&event_id)
                .is_some_and(|current| Arc::ptr_eq(&current, &entry))
            {
                return;
            }
            {
                let Ok(_cache) = entry.cache_gate.lock() else {
                    entry.remote.interrupt_transport();
                    return;
                };
                entry.generation.fetch_add(1, Ordering::AcqRel);
                invalidate_for_event(&entry.remote, &event);
            }
            host.refresh_saved_metadata(&event_id, &entry.remote);
            host.pause_revoked_connection(&event_id, &entry.remote, &event);
            let handler = host.events.lock().ok().and_then(|handler| handler.clone());
            if let Some(handler) = handler {
                handler(event_id.clone(), event);
            }
        })) {
            let _ = remote.close();
            return Err(error);
        }
        let saved = self.export_connections().and_then(|mut records| {
            let record = StoredConnection::authenticated(id.clone(), &remote, password)?;
            records.profiles.retain(|old| old.id != id);
            records.profiles.push(record);
            records.active_profile_id = if is_new {
                Some(id.clone())
            } else {
                previous_active.clone()
            };
            self.commit_connections(records)
        });
        if let Err(error) = saved {
            let _ = remote.close();
            return Err(error);
        }
        // Publish only after authentication, stream setup and durable storage
        // succeeded. Concurrent calls keep using the old working entry until now.
        let previous = {
            let mut profiles = self
                .profiles
                .lock()
                .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
            if self.closing.load(Ordering::Acquire)
                || lifecycle != self.lifecycle_generation.load(Ordering::Acquire)
            {
                drop(profiles);
                let _ = remote.close();
                return Err("WEBGATE_CLOSED".into());
            }
            let previous = profiles.insert(id.clone(), entry);
            if is_new {
                *self
                    .active
                    .lock()
                    .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")? = Some(id.clone());
            }
            previous
        };
        if let Ok(mut errors) = self.restore_errors.lock() {
            errors.remove(&id);
        }
        if let Some(previous) = previous {
            previous.remote.interrupt_transport();
            let _ = previous.remote.close();
        }
        Ok(serde_json::json!({"profileId": id, "profiles": self.summaries()}))
    }

    pub fn get(&self, id: &str) -> Option<Arc<RemoteProfile>> {
        self.get_entry(id).map(|entry| entry.remote.clone())
    }

    fn get_entry(&self, id: &str) -> Option<Arc<HostEntry>> {
        self.profiles.lock().ok()?.get(id).cloned()
    }

    pub fn set_relay_identity(
        &self,
        server_id: String,
        workspace_id: String,
    ) -> Result<(), String> {
        let mut identity = self
            .relay_identity
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if identity
            .as_ref()
            .is_some_and(|current| current != &(server_id.clone(), workspace_id.clone()))
        {
            return Err("WEBGATE_RELAY_IDENTITY_CHANGED".into());
        }
        *identity = Some((server_id, workspace_id));
        Ok(())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.get(id).is_some() || self.stored(id).is_some()
    }

    pub fn active_id(&self) -> Option<String> {
        self.active.lock().ok().and_then(|id| id.clone())
    }

    pub fn set_active(&self, id: &str) -> Result<(), String> {
        let _connection = self
            .connection_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if !self.contains(id) {
            return Err("WEBGATE_PROFILE_NOT_FOUND".into());
        }
        let mut records = self.export_connections()?;
        records.active_profile_id = Some(id.to_owned());
        self.commit_connections(records)?;
        *self
            .active
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")? = Some(id.to_owned());
        Ok(())
    }

    pub fn clear_active(&self) -> Result<(), String> {
        let _connection = self
            .connection_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        let mut records = self.export_connections()?;
        records.active_profile_id = None;
        self.commit_connections(records)?;
        *self
            .active
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")? = None;
        Ok(())
    }

    pub fn summaries(&self) -> Vec<Value> {
        let active = self.active_id();
        let entries = self
            .profiles
            .lock()
            .map(|profiles| {
                profiles
                    .iter()
                    .map(|(id, entry)| (id.clone(), Arc::clone(&entry.remote)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut summaries = entries
            .into_iter()
            .map(|(id, profile)| {
                let mut summary = profile.summary();
                if let Some(object) = summary.as_object_mut() {
                    object.insert("id".into(), Value::String(id.clone()));
                    object.insert("active".into(), Value::Bool(active.as_ref() == Some(&id)));
                    object.insert("backend".into(), Value::String("webgate".into()));
                    object.insert("fileName".into(), Value::String("Webgate".into()));
                    object.insert("encrypted".into(), Value::Bool(false));
                    // Loaded describes an open account, not momentary transport
                    // connectivity. Keep the view/cache mounted during reconnect.
                    object.insert("loaded".into(), Value::Bool(true));
                    if !profile.is_connected() {
                        object.insert("connection".into(), Value::String("offline".into()));
                    }
                }
                summary
            })
            .collect::<Vec<_>>();
        let loaded = summaries
            .iter()
            .filter_map(|value| value.get("id").and_then(Value::as_str))
            .map(str::to_owned)
            .collect::<std::collections::HashSet<_>>();
        if let Ok(records) = self.records.lock() {
            let errors = self.restore_errors.lock().ok();
            for record in &records.profiles {
                if !loaded.contains(&record.id) {
                    let error = errors
                        .as_ref()
                        .and_then(|errors| errors.get(&record.id))
                        .map(String::as_str);
                    summaries.push(record.summary(active.as_ref() == Some(&record.id), error));
                }
            }
        }
        summaries.sort_by(|left, right| {
            left.get("id")
                .and_then(Value::as_str)
                .cmp(&right.get("id").and_then(Value::as_str))
        });
        summaries
    }

    pub fn invoke(
        &self,
        id: &str,
        command: &str,
        args: Value,
        operation_id: Option<&str>,
    ) -> Result<Value, String> {
        let Some(entry) = self.get_entry(id) else {
            return self.offline_invoke(id, command);
        };
        Self::invoke_entry(entry, command, args, operation_id)
    }

    pub fn invoke_bound(
        &self,
        id: &str,
        expected_tox_id: &str,
        expected_trace: &[HopIdentity],
        command: &str,
        args: Value,
        operation_id: Option<&str>,
    ) -> Result<Value, String> {
        let entry = self.get_entry(id).ok_or("WEBGATE_PROFILE_NOT_FOUND")?;
        validate_bound_entry(&entry, expected_tox_id, expected_trace)?;
        Self::invoke_entry(entry, command, args, operation_id)
    }

    fn invoke_entry(
        entry: Arc<HostEntry>,
        command: &str,
        mut args: Value,
        operation_id: Option<&str>,
    ) -> Result<Value, String> {
        let profile = &entry.remote;
        // Local aliases never leave this host. The upstream independently
        // enforces its immutable session account binding.
        if let Some(object) = args.as_object_mut() {
            object.remove("profileId");
        }
        if command == "get_tox_network_status" && !profile.is_connected() {
            return Ok(Value::String("offline".into()));
        }
        let cache_key = cacheable_query(command).then(|| format!("query:{command}:{}", args));
        let before = {
            let _cache = entry
                .cache_gate
                .lock()
                .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
            if let Some(key) = &cache_key {
                if let Ok(Some(bytes)) = profile.cache().get(key) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        return Ok(value);
                    }
                }
            }
            entry.generation.load(Ordering::Acquire)
        };
        let result = profile.invoke(command, args, operation_id)?;
        let _cache = entry
            .cache_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if let Some(key) = cache_key {
            // An event racing this request must not resurrect its old result.
            if before == entry.generation.load(Ordering::Acquire) {
                if let Ok(bytes) = serde_json::to_vec(&result) {
                    let _ = profile.cache().put(&key, &bytes);
                }
            }
        } else if !command.starts_with("get_")
            && !command.starts_with("load_")
            && !command.starts_with("refresh_")
            && !command.starts_with("search_")
        {
            entry.generation.fetch_add(1, Ordering::AcqRel);
            invalidate_for_command(&profile, command);
        }
        Ok(result)
    }

    /// Local attachment identity remains available from the OS-protected saved
    /// connection while its server is offline; credentials never leave the host.
    pub(crate) fn local_download_metadata(&self, id: &str) -> Result<Value, String> {
        let stored = self.stored(id);
        if stored.as_ref().is_some_and(|record| record.locked) {
            return Err("WEBGATE_PROFILE_LOCKED".into());
        }
        if let Some(profile) = self.get(id) {
            return Ok(profile.metadata());
        }
        let record = stored.ok_or("WEBGATE_PROFILE_NOT_FOUND")?;
        Ok(serde_json::json!({"profileId": record.profile_id, "toxId": record.tox_id, "trace": record.trace}))
    }

    pub fn profile_metadata(&self, id: &str) -> Result<Value, String> {
        self.get(id)
            .map(|profile| profile.metadata())
            .ok_or_else(|| "WEBGATE_PROFILE_NOT_FOUND".into())
    }

    pub fn file_operation(
        &self,
        id: &str,
        operation: &str,
        mut args: Value,
    ) -> Result<Value, String> {
        let profile = self.get(id).ok_or_else(|| self.unavailable_error(id))?;
        if let Some(object) = args.as_object_mut() {
            object.remove("profileId");
        }
        profile.file_operation(operation, args)
    }

    pub fn file_operation_bound(
        &self,
        id: &str,
        expected_tox_id: &str,
        expected_trace: &[HopIdentity],
        operation: &str,
        mut args: Value,
    ) -> Result<Value, String> {
        let entry = self.get_entry(id).ok_or("WEBGATE_PROFILE_NOT_FOUND")?;
        validate_bound_entry(&entry, expected_tox_id, expected_trace)?;
        if let Some(object) = args.as_object_mut() {
            object.remove("profileId");
        }
        entry.remote.file_operation(operation, args)
    }

    pub fn set_event_handler(&self, handler: RemoteEventHandler) -> Result<(), String> {
        *self
            .events
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")? = Some(handler);
        Ok(())
    }

    pub fn disconnect(&self, id: &str) -> Result<(), String> {
        let _connection = self
            .connection_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        let mut records = self.export_connections()?;
        if let Some(record) = records.profiles.iter_mut().find(|record| record.id == id) {
            record.locked = true;
        }
        if records.active_profile_id.as_deref() == Some(id) {
            records.active_profile_id = None;
        }
        self.commit_connections(records)?;
        self.cancel_restore(id);
        self.disconnect_inner(id)
    }

    fn disconnect_inner(&self, id: &str) -> Result<(), String> {
        let removed = self
            .profiles
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
            .remove(id);
        if let Ok(mut active) = self.active.lock() {
            if active.as_deref() == Some(id) {
                *active = None;
            }
        }
        if let Some(profile) = removed {
            // Interrupt first, so closing cannot wait behind a live stream.
            profile.remote.interrupt_transport();
            // Local teardown is complete even when an offline peer cannot
            // receive revocation. Its presence lease expires independently.
            let _ = profile.remote.close();
        }
        Ok(())
    }

    pub fn interrupt_transports(&self) {
        if let Ok(pool) = self.restore_pool.lock() {
            if let Some(pool) = pool.as_ref() {
                pool.retry_now();
            }
        }
        let profiles = self
            .profiles
            .lock()
            .map(|profiles| {
                profiles
                    .values()
                    .map(|entry| entry.remote.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for profile in profiles {
            profile.interrupt_transport();
        }
    }

    pub fn close_all(&self) {
        self.closing.store(true, Ordering::Release);
        self.lifecycle_generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut pool) = self.restore_pool.lock() {
            if let Some(pool) = pool.take() {
                pool.stop();
            }
        }
        if let Ok(jobs) = self.restore_jobs.lock() {
            for job in jobs.values() {
                job.cancel();
            }
        }
        let ids = self
            .profiles
            .lock()
            .map(|profiles| profiles.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            let _ = self.disconnect_inner(&id);
        }
        // Workspace lock must also release the credential record and the
        // storage closure's cloned workspace cipher. Disk records remain intact.
        if let Ok(_store) = self.store_gate.lock() {
            if let Ok(mut store) = self.store.lock() {
                *store = None;
            }
            if let Ok(mut records) = self.records.lock() {
                *records = PersistedConnections::default();
            }
        }
        if let Ok(mut active) = self.active.lock() {
            *active = None;
        }
        if let Ok(mut errors) = self.restore_errors.lock() {
            errors.clear();
        }
    }
}

fn validate_bound_entry(
    entry: &HostEntry,
    tox_id: &str,
    trace: &[HopIdentity],
) -> Result<(), String> {
    let expected = serde_json::to_value(trace).map_err(|_| "WEBGATE_TRACE_INVALID")?;
    if entry.remote.tox_id() != tox_id || entry.remote.metadata().get("trace") != Some(&expected) {
        return Err("WEBGATE_ROUTE_CHANGED".into());
    }
    Ok(())
}

fn cacheable_query(command: &str) -> bool {
    matches!(
        command,
        "get_tox_id"
            | "get_tox_nickname"
            | "get_tox_status_message"
            | "get_tox_friends"
            | "get_incoming_friend_requests"
            | "get_file_receive_settings"
            | "load_local_state"
            | "load_layout_state"
            | "get_chat_capabilities"
            | "get_unread_state"
    )
}

fn invalidate_prefixes(profile: &RemoteProfile, commands: &[&str]) {
    for command in commands {
        let _ = profile
            .cache()
            .invalidate_prefix(&format!("query:{command}:"));
    }
}

fn invalidate_for_command(profile: &RemoteProfile, command: &str) {
    if command == "save_local_state" {
        invalidate_prefixes(profile, &["load_local_state"]);
    } else if command.starts_with("send_tox_")
        || matches!(
            command,
            "mark_friend_read" | "mark_requests_read" | "acknowledge_local_messages"
        )
    {
        invalidate_prefixes(profile, &["get_unread_state", "get_tox_friends"]);
    } else {
        // History pages belong to the view/session cache and are retained;
        // these are small account/query results that a mutation can change.
        let _ = profile.cache().invalidate_prefix("query:");
    }
}

fn invalidate_for_event(profile: &RemoteProfile, event: &StreamEvent) {
    let change = event.payload.get("change").unwrap_or(&event.payload);
    match change.get("kind").and_then(Value::as_str) {
        Some("message") => invalidate_prefixes(profile, &["get_unread_state", "get_tox_friends"]),
        Some("friend-request") => invalidate_prefixes(
            profile,
            &["get_unread_state", "get_incoming_friend_requests"],
        ),
        Some("command") => invalidate_for_command(
            profile,
            change.get("command").and_then(Value::as_str).unwrap_or(""),
        ),
        _ => {
            let _ = profile.cache().invalidate_prefix("query:");
        }
    }
}

impl Drop for WebgateHost {
    fn drop(&mut self) {
        self.close_all();
    }
}
