use super::{emit_state, password_login, response_json, secret_text, validate_session, Lifecycle};
use crate::webgate::{
    new_operation_id, transport::Transport, HopIdentity, OpenSessionRequest, OpenSessionResponse,
    SecretBytes, MAX_JSON_BYTES,
};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc, Mutex};

pub(super) struct Credentials {
    password: Mutex<SecretBytes>,
    profile_name: String,
    trace: Vec<HopIdentity>,
    renewal: Mutex<()>,
}

pub(super) struct AuthSnapshot {
    pub token: SecretBytes,
    pub epoch: String,
}

pub(super) fn snapshot(session: &Mutex<OpenSessionResponse>) -> Result<AuthSnapshot, String> {
    let session = session.lock().map_err(|_| "WEBGATE_SESSION_INVALID")?;
    if session.session_token.is_empty() {
        return Err("WEBGATE_CLOSED".into());
    }
    Ok(AuthSnapshot {
        token: SecretBytes(session.session_token.as_bytes().to_vec()),
        epoch: session.epoch.clone(),
    })
}

pub(super) fn renewable(code: &str) -> bool {
    matches!(code, "SESSION_RESTARTED" | "SESSION_EXPIRED")
}

impl Credentials {
    pub fn new(password: &str, profile_name: String, trace: Vec<HopIdentity>) -> Self {
        Self {
            password: Mutex::new(SecretBytes(password.as_bytes().to_vec())),
            profile_name,
            trace,
            renewal: Mutex::new(()),
        }
    }

    pub fn clear(&self) {
        if let Ok(mut password) = self.password.lock() {
            crate::wipe_secret_bytes(&mut password.0);
            password.0.clear();
        }
    }

    pub fn renew(
        &self,
        session: &Mutex<OpenSessionResponse>,
        transport: &Arc<Transport>,
        lifecycle: &Lifecycle,
        observed: &AuthSnapshot,
    ) -> Result<(), String> {
        let _renewal = self.renewal.lock().map_err(|_| "WEBGATE_SESSION_INVALID")?;
        if lifecycle.closed.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        let (profile_id, tox_id, trace, profile_name) = {
            let current = session.lock().map_err(|_| "WEBGATE_SESSION_INVALID")?;
            if current.epoch != observed.epoch
                || current.session_token.as_bytes() != observed.token.0.as_slice()
            {
                return Ok(()); // Another request completed this renewal.
            }
            (
                current.profile_id.clone(),
                current.tox_id.clone(),
                current.trace.clone(),
                current
                    .profile
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty() && name.len() <= 1024)
                    .unwrap_or(&self.profile_name)
                    .to_owned(),
            )
        };
        let password = self
            .password
            .lock()
            .map_err(|_| "WEBGATE_SESSION_INVALID")?;
        let input = OpenSessionRequest {
            password: secret_text(&password)?.to_string(),
            profile_name,
            profile_id: Some(profile_id.clone()),
            client_id: new_operation_id()?,
            trace: self.trace.clone(),
            proof: None,
        };
        drop(password);
        let replacement = password_login(transport, input, || {
            lifecycle.closed.load(Ordering::Acquire)
        })?;
        if lifecycle.closed.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        validate_session(&replacement, &self.trace, trace.first())?;
        if replacement.profile_id != profile_id
            || replacement.tox_id != tox_id
            || replacement.trace != trace
        {
            return Err("WEBGATE_ACCOUNT_IDENTITY_CHANGED".into());
        }
        let avatar_revision = super::avatar_revision(&replacement.profile);
        *session.lock().map_err(|_| "WEBGATE_SESSION_INVALID")? = replacement;
        *lifecycle
            .avatar_revision
            .lock()
            .map_err(|_| "WEBGATE_SESSION_INVALID")? = avatar_revision;
        // Old socket replies must not land after the new snapshot barrier.
        transport.interrupt();
        let handler = lifecycle
            .handler
            .lock()
            .ok()
            .and_then(|handler| handler.clone());
        if let Some(handler) = handler {
            let profile = session
                .lock()
                .map(|current| current.profile.clone())
                .unwrap_or(Value::Null);
            emit_state(
                session,
                &handler,
                "resync-required",
                json!({"profile": profile, "reason": "session-renewed"}),
            );
        }
        Ok(())
    }

    pub fn request(
        &self,
        session: &Mutex<OpenSessionResponse>,
        transport: &Arc<Transport>,
        lifecycle: &Lifecycle,
        route: &str,
        value: &Value,
    ) -> Result<Value, String> {
        let body = SecretBytes(serde_json::to_vec(value).map_err(|_| "WEBGATE_REQUEST_INVALID")?);
        if body.0.len() > MAX_JSON_BYTES {
            return Err("WEBGATE_REQUEST_TOO_LARGE".into());
        }
        for attempt in 0..2 {
            if lifecycle.closed.load(Ordering::Acquire) {
                return Err("WEBGATE_CLOSED".into());
            }
            let auth = snapshot(session)?;
            let generation = transport.generation();
            let result = transport
                .request(
                    "POST",
                    route,
                    None,
                    Some(secret_text(&auth.token)?),
                    Some(&auth.epoch),
                    &body.0,
                    false,
                )
                .and_then(response_json);
            if attempt == 0 && transport.generation() != generation {
                let renewed = session.lock().map_err(|_| "WEBGATE_SESSION_INVALID")?;
                if renewed.epoch != auth.epoch
                    || renewed.session_token.as_bytes() != auth.token.0.as_slice()
                {
                    // A concurrent authenticated renewal cancelled the old socket.
                    // Only that renewal, not a route change alone, permits replay.
                    continue;
                }
            }
            transport.assert_generation(generation)?;
            if let Err(code) = &result {
                if attempt == 0 && renewable(code) {
                    self.renew(session, transport, lifecycle, &auth)?;
                    continue; // The exact bytes and operation ID are reused.
                }
            }
            if lifecycle.closed.load(Ordering::Acquire) {
                return Err("WEBGATE_CLOSED".into());
            }
            return result;
        }
        Err("WEBGATE_AUTH_INVALID".into())
    }
}

impl Drop for Credentials {
    fn drop(&mut self) {
        self.clear();
    }
}
