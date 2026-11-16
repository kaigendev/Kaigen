//! Profile-scoped remote access. No local Tox identity or persistent credential store.
mod cache;
mod client;
mod transport;

pub use cache::EphemeralCache;
pub use client::RemoteProfile;
pub use transport::{ProxyMode, ProxyRoute, TorEndpoint, TransportPolicy};
#[cfg(feature = "desktop")]
pub(crate) use transport::{Transport as OfficialTransport, HttpBody as OfficialHttpBody};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use url::Url;

pub const PROTOCOL_VERSION: u32 = 1;
// Existing Web avatar/local-state commands accept 12 MiB plus the RPC envelope.
pub const MAX_JSON_BYTES: usize = 13 * 1024 * 1024;
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_CARD_BYTES: usize = 64 * 1024;
pub const MAX_FILE_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct Endpoint {
    pub(crate) base: Url,
    pub(crate) identifier: String,
}

impl fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Endpoint([redacted])")
    }
}

impl Endpoint {
    /// Accept current browser #k links and explicit /[space/|w/]identifier/api URLs.
    pub fn parse(input: &str) -> Result<Self, String> {
        if input.len() > MAX_CARD_BYTES || input.chars().any(char::is_control) {
            return Err("WEBGATE_ENDPOINT_INVALID".into());
        }
        let mut base = Url::parse(input.trim()).map_err(|_| "WEBGATE_ENDPOINT_INVALID")?;
        if !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.host_str().is_none()
        {
            return Err("WEBGATE_ENDPOINT_INVALID".into());
        }
        // A trailing DNS dot must not turn an onion route into a direct lookup.
        if let Some(host) = base.host_str().filter(|host| host.ends_with('.')) {
            let canonical = host.trim_end_matches('.').to_string();
            base.set_host(Some(&canonical))
                .map_err(|_| "WEBGATE_ENDPOINT_INVALID")?;
        }
        let onion = base.host_str().is_some_and(|host| host.ends_with(".onion"));
        if base.scheme() != "https" && !(base.scheme() == "http" && onion) {
            return Err("WEBGATE_HTTPS_REQUIRED".into());
        }
        let identifier = if let Some(fragment) = base.fragment() {
            if base.path() != "/" {
                return Err("WEBGATE_ENDPOINT_INVALID".into());
            }
            let value = fragment
                .strip_prefix("k=")
                .ok_or("WEBGATE_ENDPOINT_INVALID")?;
            value
                .strip_suffix("/api/v1")
                .or_else(|| value.strip_suffix("/api"))
                .unwrap_or(value)
                .to_string()
        } else {
            let path = base.path().trim_matches('/');
            let path = path
                .strip_suffix("/api/v1")
                .or_else(|| path.strip_suffix("/api"))
                .unwrap_or(path);
            path.strip_prefix("space/")
                .or_else(|| path.strip_prefix("w/"))
                .unwrap_or(path)
                .to_string()
        };
        let decoded = URL_SAFE_NO_PAD
            .decode(&identifier)
            .map_err(|_| "WEBGATE_WORKSPACE_INVALID")?;
        if !(43..=55).contains(&identifier.len())
            || !(32..=41).contains(&decoded.len())
            || !identifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("WEBGATE_WORKSPACE_INVALID".into());
        }
        base.set_fragment(None);
        base.set_path(&format!("/{identifier}/api/v1"));
        Ok(Self { base, identifier })
    }

    pub fn is_onion(&self) -> bool {
        self.base
            .host_str()
            .is_some_and(|host| host.ends_with(".onion"))
    }

    pub fn api_url(&self) -> String {
        self.base.as_str().to_string()
    }

    pub fn workspace_url(&self) -> String {
        let mut url = self.base.clone();
        url.set_path("/");
        url.set_fragment(Some(&format!("k={}", self.identifier)));
        url.into()
    }

    pub(crate) fn route(&self, route: &str) -> Result<Url, String> {
        if !matches!(
            route,
            "session/open"
                | "session/challenge"
                | "session/heartbeat"
                | "session/close"
                | "command"
                | "stream"
                | "files/start"
                | "files/chunk"
                | "files/finish"
                | "files/status"
                | "files/cancel"
                | "files/snapshot"
        ) {
            return Err("WEBGATE_OPERATION_INVALID".into());
        }
        let mut url = self.base.clone();
        url.set_path(&format!("{}/{route}", self.base.path()));
        Ok(url)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HopIdentity {
    pub server_id: String,
    pub workspace_id: String,
    pub profile_id: String,
}

impl HopIdentity {
    pub fn validate(&self) -> Result<(), String> {
        for value in [&self.server_id, &self.workspace_id, &self.profile_id] {
            if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err("WEBGATE_IDENTITY_INVALID".into());
            }
        }
        Ok(())
    }
}

/// No hop-count ceiling. The normal request-size bound still applies to the trace.
pub fn validate_trace(trace: &[HopIdentity]) -> Result<(), String> {
    let mut seen = HashSet::new();
    for hop in trace {
        hop.validate()?;
        if !seen.insert(hop) {
            return Err("WEBGATE_CYCLE".into());
        }
    }
    if serde_json::to_vec(trace)
        .map_err(|_| "WEBGATE_TRACE_INVALID")?
        .len()
        > MAX_CARD_BYTES
    {
        return Err("WEBGATE_TRACE_TOO_LARGE".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCard {
    pub format: String,
    pub version: u32,
    pub endpoint: String,
    pub profile_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<HopIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

impl fmt::Debug for ConnectionCard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionCard")
            .field("version", &self.version)
            .field("credentials", &"[redacted]")
            .finish()
    }
}

impl Drop for ConnectionCard {
    fn drop(&mut self) {
        if let Some(password) = self.password.take() {
            wipe_string(password);
        }
    }
}

impl ConnectionCard {
    pub fn new(endpoint: String, profile_name: String) -> Self {
        Self {
            format: "kaigen-webgate".into(),
            version: PROTOCOL_VERSION,
            endpoint,
            profile_name,
            profile_id: None,
            certificate_sha256: None,
            identity: None,
            password: None,
        }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        if text.len() > MAX_CARD_BYTES {
            return Err("WEBGATE_CARD_TOO_LARGE".into());
        }
        let card: Self = serde_json::from_str(text).map_err(|_| "WEBGATE_CARD_INVALID")?;
        card.validate()?;
        Ok(card)
    }

    pub fn validate(&self) -> Result<Endpoint, String> {
        if self.format != "kaigen-webgate" || self.version != PROTOCOL_VERSION {
            return Err("WEBGATE_CARD_VERSION_UNSUPPORTED".into());
        }
        if self.profile_name.trim().is_empty()
            || self.profile_name.len() > 1024
            || self.profile_name.chars().any(char::is_control)
            || self
                .password
                .as_ref()
                .is_some_and(|password| password.len() > 16 * 1024)
        {
            return Err("WEBGATE_CARD_INVALID".into());
        }
        if let Some(pin) = &self.certificate_sha256 {
            parse_fingerprint(pin)?;
        }
        if self
            .profile_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err("WEBGATE_CARD_INVALID".into());
        }
        if let Some(identity) = &self.identity {
            identity.validate()?;
        }
        let endpoint = Endpoint::parse(&self.endpoint)?;
        if endpoint.base.scheme() != "https" && self.certificate_sha256.is_some() {
            return Err("WEBGATE_PIN_REQUIRES_TLS".into());
        }
        Ok(endpoint)
    }

    /// A password is exported only when the caller explicitly supplies it here.
    pub fn export(&self, explicit_password: Option<&str>) -> Result<String, String> {
        let mut card = self.clone();
        if let Some(previous) = card.password.take() {
            wipe_string(previous);
        }
        card.password = explicit_password.map(str::to_string);
        card.validate()?;
        serde_json::to_string_pretty(&card).map_err(|_| "WEBGATE_CARD_INVALID".into())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionRequest {
    pub password: String,
    pub profile_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub client_id: String,
    #[serde(default)]
    pub trace: Vec<HopIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<ProofSolution>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofSolution {
    pub challenge_id: String,
    pub nonce: u64,
}

impl Drop for OpenSessionRequest {
    fn drop(&mut self) {
        wipe_string(std::mem::take(&mut self.password));
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionResponse {
    pub session_token: String,
    pub session_id: String,
    pub epoch: String,
    pub cursor: u64,
    pub profile_id: String,
    pub profile: Value,
    pub tox_id: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub trace: Vec<HopIdentity>,
    #[serde(default = "default_heartbeat")]
    pub heartbeat_seconds: u64,
}

impl Drop for OpenSessionResponse {
    fn drop(&mut self) {
        wipe_string(std::mem::take(&mut self.session_token));
    }
}

fn default_heartbeat() -> u64 {
    20
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequest {
    pub operation_id: String,
    pub command: String,
    pub args: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub epoch: String,
    pub cursor: u64,
    pub event: String,
    pub profile_id: String,
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

pub fn new_operation_id() -> Result<String, String> {
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| "WEBGATE_ENTROPY_UNAVAILABLE")?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

pub(crate) fn parse_fingerprint(value: &str) -> Result<[u8; 32], String> {
    let value = value.replace(':', "");
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("WEBGATE_CERTIFICATE_PIN_INVALID".into());
    }
    let mut hash = [0u8; 32];
    for (index, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "WEBGATE_CERTIFICATE_PIN_INVALID")?;
    }
    Ok(hash)
}

pub(crate) fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn wipe_string(value: String) {
    crate::wipe_secret_bytes(&mut value.into_bytes());
}

pub(crate) struct SecretBytes(pub Vec<u8>);
impl Drop for SecretBytes {
    fn drop(&mut self) {
        crate::wipe_secret_bytes(&mut self.0);
    }
}
