//! Minimal remote connection records. Callers must encrypt the entire envelope.
//! This is deliberately separate from ephemeral messages, avatars and file cache.

use std::{collections::HashSet, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::webgate::{ConnectionCard, HopIdentity, RemoteProfile};

pub const MAX_CONNECTION_STORE_BYTES: usize = 16 * 1024 * 1024;
pub type ConnectionStore = Arc<dyn Fn(&PersistedConnections) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredConnection {
    pub id: String,
    pub card: ConnectionCard,
    pub password: String,
    pub profile_id: String,
    pub tox_id: String,
    pub trace: Vec<HopIdentity>,
    pub name: String,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedConnections {
    pub format_version: u32,
    pub active_profile_id: Option<String>,
    pub profiles: Vec<StoredConnection>,
}

impl Default for PersistedConnections {
    fn default() -> Self {
        Self {
            format_version: 1,
            active_profile_id: None,
            profiles: Vec::new(),
        }
    }
}

impl PersistedConnections {
    pub fn validate(&self) -> Result<(), String> {
        if self.format_version != 1 {
            return Err("WEBGATE_STORE_VERSION_UNSUPPORTED".into());
        }
        let mut ids = HashSet::new();
        for profile in &self.profiles {
            profile.validate()?;
            if !ids.insert(profile.id.as_str()) {
                return Err("WEBGATE_STORE_INVALID".into());
            }
        }
        if self
            .active_profile_id
            .as_deref()
            .is_some_and(|id| !ids.contains(id))
        {
            return Err("WEBGATE_STORE_INVALID".into());
        }
        Ok(())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_CONNECTION_STORE_BYTES {
            return Err("WEBGATE_STORE_TOO_LARGE".into());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| "WEBGATE_STORE_INVALID")?;
        value.validate()?;
        Ok(value)
    }

    /// The returned buffer contains credentials: encrypt then wipe it promptly.
    pub fn encode(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let mut bytes = serde_json::to_vec(self).map_err(|_| "WEBGATE_STORE_INVALID")?;
        if bytes.len() > MAX_CONNECTION_STORE_BYTES {
            crate::wipe_secret_bytes(&mut bytes);
            return Err("WEBGATE_STORE_TOO_LARGE".into());
        }
        Ok(bytes)
    }

    pub fn with_json<R>(&self, f: impl FnOnce(&[u8]) -> Result<R, String>) -> Result<R, String> {
        let bytes = crate::webgate::SecretBytes(self.encode()?);
        f(&bytes.0)
    }

    pub fn from_json(bytes: &mut Vec<u8>) -> Result<Self, String> {
        let result = Self::decode(bytes);
        crate::wipe_secret_bytes(bytes);
        bytes.clear();
        result
    }
}

impl StoredConnection {
    pub fn authenticated(
        id: String,
        remote: &RemoteProfile,
        password: &str,
    ) -> Result<Self, String> {
        let metadata = remote.metadata();
        let card = remote.card();
        let value = Self {
            id,
            name: card.profile_name.clone(),
            card,
            password: password.to_owned(),
            profile_id: metadata
                .get("profileId")
                .and_then(Value::as_str)
                .ok_or("WEBGATE_SESSION_INVALID")?
                .to_owned(),
            tox_id: remote.tox_id(),
            trace: serde_json::from_value(metadata.get("trace").cloned().unwrap_or(Value::Null))
                .map_err(|_| "WEBGATE_TRACE_INVALID")?,
            locked: false,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.id.starts_with("wg-")
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || self.password.len() > 16 * 1024
            || self.card.password.is_some()
            || self.profile_id.is_empty()
            || self.profile_id.len() > 256
            || self.tox_id.is_empty()
            || self.tox_id.len() > 256
            || self.name.len() > 1024
            || self.trace.is_empty()
        {
            return Err("WEBGATE_STORE_INVALID".into());
        }
        self.card.validate()?;
        let mut visited = HashSet::new();
        for hop in &self.trace {
            hop.validate()?;
            if !visited.insert(hop) {
                return Err("WEBGATE_CYCLE_DETECTED".into());
            }
        }
        Ok(())
    }

    pub fn validate_remote(&self, remote: &RemoteProfile) -> Result<(), String> {
        let metadata = remote.metadata();
        if remote.tox_id() != self.tox_id
            || metadata.get("profileId").and_then(Value::as_str) != Some(self.profile_id.as_str())
            || metadata.get("trace")
                != Some(&serde_json::to_value(&self.trace).map_err(|_| "WEBGATE_TRACE_INVALID")?)
        {
            return Err("WEBGATE_ACCOUNT_IDENTITY_CHANGED".into());
        }
        Ok(())
    }

    /// Contains no endpoint, credentials, history or cached avatar.
    pub fn summary(&self, active: bool, error: Option<&str>) -> Value {
        json!({"id":self.id,"profileId":self.profile_id,"toxId":self.tox_id,
            "name":self.name,"fileName":"Webgate","backend":"webgate",
            "active":active,"loaded":!self.locked,"encrypted":false,"enabled":true,
            "connection":"offline","statusMessage":"","avatar":null,
            "userStatus":"offline","unread":0,"unreadTarget":null,"notificationsEnabled":true,
            "error":error,"webgateLocked":self.locked,"webgateError":error})
    }
}

impl Drop for StoredConnection {
    fn drop(&mut self) {
        crate::webgate::wipe_string(std::mem::take(&mut self.password));
        crate::webgate::wipe_string(std::mem::take(&mut self.card.endpoint));
        if let Some(password) = self.card.password.take() {
            crate::webgate::wipe_string(password);
        }
    }
}
