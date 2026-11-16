use super::*;

#[derive(Default)]
pub(super) struct RestoreJob {
    cancelled: Mutex<bool>,
}

impl RestoreJob {
    pub(super) fn cancel(&self) {
        if let Ok(mut cancelled) = self.cancelled.lock() {
            *cancelled = true;
        }
    }
    pub(super) fn cancelled(&self) -> bool {
        self.cancelled.lock().map(|value| *value).unwrap_or(true)
    }
}

pub(super) fn same_connection(left: &StoredConnection, right: &StoredConnection) -> bool {
    left.id == right.id
        && left.password == right.password
        && left.locked == right.locked
        && left.card.endpoint == right.card.endpoint
        && left.card.profile_name == right.card.profile_name
        && left.card.profile_id == right.card.profile_id
        && left.card.certificate_sha256 == right.card.certificate_sha256
        && left.card.identity == right.card.identity
        && left.profile_id == right.profile_id
        && left.tox_id == right.tox_id
        && left.trace == right.trace
}

impl WebgateHost {
    pub fn has_store(&self) -> bool {
        self.store
            .lock()
            .map(|store| store.is_some())
            .unwrap_or(false)
    }

    pub fn set_store(&self, store: ConnectionStore) -> Result<(), String> {
        *self.store.lock().map_err(|_| "WEBGATE_STATE_UNAVAILABLE")? = Some(store);
        Ok(())
    }

    pub fn import_connections(&self, records: PersistedConnections) -> Result<(), String> {
        records.validate()?;
        let _connection = self
            .connection_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if !self
            .profiles
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
            .is_empty()
        {
            return Err("WEBGATE_STORE_ALREADY_LOADED".into());
        }
        self.lifecycle_generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut pool) = self.restore_pool.lock() {
            if let Some(pool) = pool.take() {
                pool.stop();
            }
        }
        if let Ok(mut jobs) = self.restore_jobs.lock() {
            for job in jobs.values() {
                job.cancel();
            }
            jobs.clear();
        }
        if let Ok(mut errors) = self.restore_errors.lock() {
            errors.clear();
        }
        *self
            .active
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")? = records.active_profile_id.clone();
        *self
            .records
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")? = records;
        self.closing.store(false, Ordering::Release);
        Ok(())
    }

    pub fn export_connections(&self) -> Result<PersistedConnections, String> {
        Ok(self
            .records
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
            .clone())
    }

    /// Called under connection_gate. Commit persistent bytes before publishing
    /// new access, so failed updates leave the previous working record intact.
    pub(super) fn commit_connections(&self, records: PersistedConnections) -> Result<(), String> {
        records.validate()?;
        let _store_gate = self
            .store_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        let lifecycle = self.lifecycle_generation.load(Ordering::Acquire);
        if self.closing.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        let store = self
            .store
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
            .clone();
        if let Some(store) = store {
            store(&records)?;
        }
        let mut current = self
            .records
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if self.closing.load(Ordering::Acquire)
            || lifecycle != self.lifecycle_generation.load(Ordering::Acquire)
        {
            return Err("WEBGATE_CLOSED".into());
        }
        *current = records;
        Ok(())
    }

    pub(super) fn unavailable_error(&self, id: &str) -> String {
        if self.stored(id).is_some() {
            "WEBGATE_PROFILE_OFFLINE"
        } else {
            "WEBGATE_PROFILE_NOT_FOUND"
        }
        .into()
    }

    /// Opening a relay session requires authenticated live metadata. Saved
    /// remote profiles remain remote while their upstream connection restores.
    pub fn open_session_metadata(&self, id: &str) -> Result<Value, String> {
        let _connection = self
            .connection_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if self.closing.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        let record = self.stored(id).ok_or("WEBGATE_PROFILE_NOT_FOUND")?;
        if record.locked {
            return Err("WEBGATE_PROFILE_LOCKED".into());
        }
        if let Some(remote) = self.get(id) {
            return Ok(remote.metadata());
        }
        // Workers publish the error before removing a completed job. Observe
        // the job first so a completed failure cannot look like unknown offline.
        let pending = self
            .restore_jobs
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
            .get(id)
            .is_some_and(|job| !job.cancelled());
        if let Some(error) = self
            .restore_errors
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?
            .get(id)
            .cloned()
        {
            return Err(error);
        }
        Err(if pending {
            "WEBGATE_TRANSPORT_UNAVAILABLE"
        } else {
            "WEBGATE_PROFILE_OFFLINE"
        }
        .into())
    }

    pub(super) fn offline_invoke(&self, id: &str, command: &str) -> Result<Value, String> {
        let record = self.stored(id).ok_or("WEBGATE_PROFILE_NOT_FOUND")?;
        if record.locked {
            return Err("WEBGATE_PROFILE_LOCKED".into());
        }
        match command {
            "get_tox_network_status" => Ok(Value::String("offline".into())),
            "get_tox_id" => Ok(Value::String(record.tox_id.clone())),
            "get_tox_nickname" => Ok(Value::String(record.name.clone())),
            "get_tox_status_message" => Ok(Value::String(String::new())),
            _ => Err("WEBGATE_PROFILE_OFFLINE".into()),
        }
    }

    pub(super) fn stored(&self, id: &str) -> Option<StoredConnection> {
        self.records
            .lock()
            .ok()?
            .profiles
            .iter()
            .find(|record| record.id == id)
            .cloned()
    }

    pub fn connection_card(&self, id: &str) -> Result<ConnectionCard, String> {
        if let Some(remote) = self.get(id) {
            return Ok(remote.card());
        }
        self.stored(id)
            .map(|record| record.card.clone())
            .ok_or_else(|| "WEBGATE_PROFILE_NOT_FOUND".into())
    }

    pub fn restore_profile(
        self: &Arc<Self>,
        id: &str,
        policy: TransportPolicy,
        cache_root: &Path,
    ) -> Result<Value, String> {
        self.cancel_restore(id);
        if self.get(id).is_none() {
            let record = self.stored(id).ok_or("WEBGATE_PROFILE_NOT_FOUND")?;
            self.connect_at(
                id.to_owned(),
                record.card.clone(),
                &record.password,
                policy,
                cache_root,
                Some(&record),
            )?;
        }
        self.set_active(id)?;
        Ok(serde_json::json!({"profileId":id,"profiles":self.summaries()}))
    }

    /// Restore uses a bounded pool; retry delays never occupy a worker.
    pub fn restore_connections(
        self: &Arc<Self>,
        policy: TransportPolicy,
        cache_root: &Path,
    ) -> Result<(), String> {
        self.start_restore_pool(policy, cache_root)
    }

    pub fn forget(&self, id: &str) -> Result<(), String> {
        let _connection = self
            .connection_gate
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        let mut records = self.export_connections()?;
        records.profiles.retain(|record| record.id != id);
        if records.active_profile_id.as_deref() == Some(id) {
            records.active_profile_id = None;
        }
        self.commit_connections(records)?;
        self.cancel_restore(id);
        if let Ok(mut errors) = self.restore_errors.lock() {
            errors.remove(id);
        }
        self.disconnect_inner(id)
    }

    pub(super) fn cancel_restore(&self, id: &str) {
        if let Ok(mut jobs) = self.restore_jobs.lock() {
            if let Some(job) = jobs.remove(id) {
                job.cancel();
            }
        }
    }

    pub(super) fn refresh_saved_metadata(&self, id: &str, remote: &Arc<RemoteProfile>) {
        let card = remote.card();
        let Some(previous) = self.stored(id) else {
            return;
        };
        if previous.card.profile_name == card.profile_name
            && previous.card.certificate_sha256 == card.certificate_sha256
        {
            return;
        }
        let Ok(_connection) = self.connection_gate.lock() else {
            return;
        };
        if !self
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(&current, remote))
        {
            return;
        }
        let Ok(mut records) = self.export_connections() else {
            return;
        };
        let Some(record) = records.profiles.iter_mut().find(|record| record.id == id) else {
            return;
        };
        record.name = card.profile_name.clone();
        record.card = card;
        // Never discard the last durable access on an IO failure.
        if self.commit_connections(records).is_err() {
            if let Ok(mut errors) = self.restore_errors.lock() {
                errors.insert(id.to_owned(), "WEBGATE_STORE_SAVE_FAILED".into());
            }
        }
    }

    pub(super) fn pause_revoked_connection(
        &self,
        id: &str,
        remote: &Arc<RemoteProfile>,
        event: &StreamEvent,
    ) {
        let code = event
            .payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("");
        if event.event != "session-revoked"
            && !matches!(
                code,
                "AUTH_INVALID"
                    | "WEBGATE_AUTH_INVALID"
                    | "SESSION_REVOKED"
                    | "WEBGATE_SESSION_REVOKED"
                    | "WEBGATE_ACCOUNT_IDENTITY_CHANGED"
                    | "PASSWORD_REAUTH_REQUIRED"
                    | "WORKSPACE_LOCKED"
                    | "WORKSPACE_CLOSED"
            )
        {
            return;
        }
        let Ok(_connection) = self.connection_gate.lock() else {
            return;
        };
        if !self
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(&current, remote))
        {
            return;
        }
        let Ok(mut records) = self.export_connections() else {
            return;
        };
        let Some(record) = records.profiles.iter_mut().find(|record| record.id == id) else {
            return;
        };
        record.locked = true;
        if records.active_profile_id.as_deref() == Some(id) {
            records.active_profile_id = None;
        }
        let persisted = self.commit_connections(records.clone()).is_ok();
        // Even when durable storage is unavailable, never turn a live admin
        // revocation into an automatic password login in this process.
        if !persisted {
            if let Ok(mut current) = self.records.lock() {
                *current = records;
            }
        }
        self.cancel_restore(id);
        if let Ok(mut profiles) = self.profiles.lock() {
            profiles.remove(id);
        }
        if let Ok(mut active) = self.active.lock() {
            if active.as_deref() == Some(id) {
                *active = None;
            }
        }
        if let Ok(mut errors) = self.restore_errors.lock() {
            errors.insert(
                id.to_owned(),
                if persisted {
                    "WEBGATE_SESSION_REVOKED"
                } else {
                    "WEBGATE_STORE_SAVE_FAILED"
                }
                .into(),
            );
        }
        remote.interrupt_transport();
    }

    pub(super) fn notify_restore(&self, id: &str, event: &str, error: Option<&str>) {
        let handler = self.events.lock().ok().and_then(|handler| handler.clone());
        if let (Some(handler), Some(record)) = (handler, self.stored(id)) {
            handler(
                id.to_owned(),
                StreamEvent {
                    epoch: String::new(),
                    cursor: 0,
                    event: event.to_owned(),
                    profile_id: record.profile_id.clone(),
                    payload: serde_json::json!({"kind":"profile","code":error}),
                    revision: None,
                },
            );
        }
    }
}

pub(super) fn safe_error(error: &str) -> String {
    let code = error.split([':', ' ', '\n']).next().unwrap_or("");
    if !code.is_empty()
        && code.len() <= 96
        && code.bytes().all(|c| c.is_ascii_uppercase() || c == b'_')
    {
        code.to_owned()
    } else {
        "WEBGATE_RESTORE_FAILED".into()
    }
}

pub(super) fn retryable(code: &str) -> bool {
    matches!(
        code,
        "WEBGATE_CONNECTION_FAILED"
            | "WEBGATE_CONNECT_FAILED"
            | "WEBGATE_DNS_FAILED"
            | "WEBGATE_TIMEOUT"
            | "WEBGATE_TRANSPORT_FAILED"
            | "WEBGATE_IO_FAILED"
            | "WEBGATE_TOR_REQUIRED"
            | "WEBGATE_TOR_NOT_READY"
            | "WEBGATE_TOR_DISABLED"
            | "WEBGATE_TRANSPORT_INTERRUPTED"
            | "WEBGATE_PROXY_CONNECT_FAILED"
            | "WEBGATE_PROXY_UNAVAILABLE"
            | "WEBGATE_HTTP_UNAVAILABLE"
            | "WEBGATE_TRANSPORT_UNAVAILABLE"
            | "WEBGATE_CONNECTION_LOST"
            | "WEBGATE_TRANSPORT_CHANGED"
            | "WEBGATE_TOR_FAILED"
            | "WEBGATE_TLS_FAILED"
            | "SESSION_RESTARTED"
            | "SESSION_EXPIRED"
    )
}
