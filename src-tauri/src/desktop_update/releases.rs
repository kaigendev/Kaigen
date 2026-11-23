use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

pub(super) const REPOSITORY_API: &str = "https://api.github.com/repos/kaigendev/Kaigen";
pub(super) const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Version(Vec<String>);

impl Version {
    pub(super) fn public(value: &str) -> Result<Self, String> {
        let value = value
            .strip_prefix('v')
            .or_else(|| value.strip_prefix('V'))
            .unwrap_or(value);
        if value.is_empty() || value.len() > 128 {
            return Err("UPDATE_VERSION_INVALID".into());
        }
        let mut parts = Vec::new();
        for part in value.split('.') {
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return Err("UPDATE_VERSION_INVALID".into());
            }
            let digits = part.trim_start_matches('0');
            parts.push(if digits.is_empty() { "0" } else { digits }.to_string());
        }
        while parts.len() > 1 && parts.last().is_some_and(|part| part == "0") {
            parts.pop();
        }
        Ok(Self(parts))
    }

    pub(super) fn current() -> Result<Self, String> {
        Self::public(&env!("CARGO_PKG_VERSION").replace('+', "."))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        for index in 0..self.0.len().max(other.0.len()) {
            let left = self.0.get(index).map(String::as_str).unwrap_or("0");
            let right = other.0.get(index).map(String::as_str).unwrap_or("0");
            let order = left.len().cmp(&right.len()).then_with(|| left.cmp(right));
            if order != Ordering::Equal {
                return order;
            }
        }
        Ordering::Equal
    }
}
impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Deserialize)]
pub(super) struct Release {
    pub id: u64,
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct Asset {
    pub id: u64,
    pub name: String,
    pub state: String,
    pub size: u64,
    pub digest: Option<String>,
    pub browser_download_url: String,
}

impl Release {
    pub(super) fn stable_version(&self) -> Option<Version> {
        if self.id == 0
            || self.draft
            || self.prerelease
            || self.tag_name.to_ascii_lowercase().contains("rc")
            || self
                .name
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("rc")
        {
            return None;
        }
        Version::public(&self.tag_name).ok()
    }

    pub(super) fn asset(&self, expected: &str) -> Result<Asset, String> {
        let mut assets = self.assets.iter().filter(|asset| asset.name == expected);
        let asset = assets.next().ok_or("UPDATE_ASSET_MISSING")?;
        if assets.next().is_some()
            || asset.id == 0
            || asset.state != "uploaded"
            || asset.size == 0
            || asset.size > MAX_ARCHIVE_BYTES
        {
            return Err("UPDATE_ASSET_INVALID".into());
        }
        asset.sha256()?;
        let url = url::Url::parse(&asset.browser_download_url).map_err(|_| "UPDATE_URL_INVALID")?;
        let mut expected_url =
            url::Url::parse("https://github.com").map_err(|_| "UPDATE_URL_INVALID")?;
        expected_url
            .path_segments_mut()
            .map_err(|_| "UPDATE_URL_INVALID")?
            .extend([
                "kaigendev",
                "Kaigen",
                "releases",
                "download",
                &self.tag_name,
                expected,
            ]);
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != expected_url.path()
        {
            return Err("UPDATE_URL_INVALID".into());
        }
        Ok(asset.clone())
    }
}

impl Asset {
    pub(super) fn sha256(&self) -> Result<[u8; 32], String> {
        let value = self
            .digest
            .as_deref()
            .and_then(|digest| digest.strip_prefix("sha256:"))
            .ok_or("UPDATE_DIGEST_MISSING")?;
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("UPDATE_DIGEST_INVALID".into());
        }
        let mut hash = [0; 32];
        for (index, byte) in hash.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| "UPDATE_DIGEST_INVALID")?;
        }
        Ok(hash)
    }
}
