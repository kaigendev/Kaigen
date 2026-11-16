use super::releases::Asset;
use crate::webgate::{OfficialTransport, TransportPolicy};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub(super) struct Network {
    policy: TransportPolicy,
    active: Mutex<Option<Arc<OfficialTransport>>>,
    cancelled: AtomicBool,
}

impl Network {
    pub(super) fn new(policy: TransportPolicy) -> Self {
        Self {
            policy,
            active: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        }
    }
    pub(super) fn begin(&self) {
        self.cancelled.store(false, Ordering::Release);
    }
    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(active) = self.active.lock() {
            if let Some(active) = active.as_ref() {
                active.interrupt();
            }
        }
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("UPDATE_CANCELLED".into())
        } else {
            Ok(())
        }
    }

    fn response(
        &self,
        input: &str,
        streaming: bool,
    ) -> Result<crate::webgate::OfficialHttpBody, String> {
        let mut url = url::Url::parse(input).map_err(|_| "UPDATE_URL_INVALID")?;
        for _ in 0..6 {
            self.check()?;
            validate_url(&url)?;
            let transport = OfficialTransport::official(url.clone(), self.policy.clone())?;
            *self.active.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")? =
                Some(Arc::clone(&transport));
            let response = transport.official_get(streaming).map_err(|error| {
                if self.cancelled.load(Ordering::Acquire) {
                    "UPDATE_CANCELLED".to_string()
                } else if error.contains("TLS") {
                    "UPDATE_TLS_FAILED".to_string()
                } else {
                    "UPDATE_NETWORK_FAILED".to_string()
                }
            })?;
            if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
                let next = response
                    .location
                    .as_deref()
                    .ok_or("UPDATE_REDIRECT_INVALID")?;
                url = url.join(next).map_err(|_| "UPDATE_REDIRECT_INVALID")?;
                transport.interrupt();
                continue;
            }
            if response.status != 200 {
                return Err(format!("UPDATE_HTTP_{}", response.status));
            }
            return Ok(response);
        }
        Err("UPDATE_REDIRECT_LIMIT".into())
    }

    pub(super) fn json<T: DeserializeOwned>(&self, url: &str) -> Result<T, String> {
        let mut response = self.response(url, false)?;
        if response
            .content_length
            .is_some_and(|length| length > 8 * 1024 * 1024)
        {
            return Err("UPDATE_METADATA_TOO_LARGE".into());
        }
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "UPDATE_NETWORK_FAILED")?;
        self.check()?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("UPDATE_METADATA_TOO_LARGE".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "UPDATE_METADATA_INVALID".into())
    }

    pub(super) fn download(
        &self,
        asset: &Asset,
        output: &mut File,
        mut progress: impl FnMut(u64),
    ) -> Result<(), String> {
        let expected = asset.sha256()?;
        let mut response = self.response(&asset.browser_download_url, true)?;
        if response
            .content_length
            .is_some_and(|length| length != asset.size)
        {
            return Err("UPDATE_SIZE_MISMATCH".into());
        }
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0; 256 * 1024];
        loop {
            self.check()?;
            let read = response
                .read(&mut buffer)
                .map_err(|_| "UPDATE_NETWORK_FAILED")?;
            if read == 0 {
                break;
            }
            count = count
                .checked_add(read as u64)
                .ok_or("UPDATE_SIZE_MISMATCH")?;
            if count > asset.size {
                return Err("UPDATE_SIZE_MISMATCH".into());
            }
            hash.update(&buffer[..read]);
            output
                .write_all(&buffer[..read])
                .map_err(|_| "UPDATE_DISK_WRITE_FAILED")?;
            progress(count);
        }
        if count != asset.size {
            return Err("UPDATE_SIZE_MISMATCH".into());
        }
        let actual: [u8; 32] = hash.finalize().into();
        if actual != expected {
            return Err("UPDATE_HASH_MISMATCH".into());
        }
        output
            .sync_all()
            .map_err(|_| "UPDATE_DISK_WRITE_FAILED".to_string())
    }
}

fn validate_url(url: &url::Url) -> Result<(), String> {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("UPDATE_URL_INVALID".into());
    }
    let allowed = match url.host_str() {
        Some("api.github.com") => url.path().starts_with("/repos/kaigendev/Kaigen/releases"),
        Some("github.com") => url
            .path()
            .starts_with("/kaigendev/Kaigen/releases/download/"),
        Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("UPDATE_REDIRECT_DENIED".into())
    }
}
