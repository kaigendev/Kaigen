use std::{
    env,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

use tauri_app_lib::web_core::{TEST_DISK_QUOTA_BYTES, TEST_MAX_INSTANCES, TEST_RAM_QUOTA_BYTES};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeploymentMode {
    Personal,
    Service,
}

impl DeploymentMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "personal" => Ok(Self::Personal),
            "service" => Ok(Self::Service),
            _ => Err("KAIGEN_WEB_DEPLOYMENT_MODE must be personal or service".to_string()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub deployment_mode: DeploymentMode,
    pub bind: SocketAddr,
    pub public_origin: String,
    pub disk_root: PathBuf,
    pub ram_root: PathBuf,
    pub active_root: PathBuf,
    pub resource_root: PathBuf,
    pub disk_quota_bytes: u64,
    pub ram_quota_bytes: u64,
    pub security_reserve_bytes: u64,
    pub lease_hours: u64,
    pub max_instances: usize,
    pub proof_difficulty: u8,
}

impl Config {
    pub fn from_environment() -> Result<Self, String> {
        let deployment_mode =
            DeploymentMode::parse(&value("KAIGEN_WEB_DEPLOYMENT_MODE", "service")?)?;
        let bind = value("KAIGEN_WEB_BIND", "127.0.0.1:8787")?
            .parse::<SocketAddr>()
            .map_err(|_| "KAIGEN_WEB_BIND must be a socket address".to_string())?;
        if !bind.ip().is_loopback() {
            return Err("kaigen-webd must bind to loopback behind Nginx".to_string());
        }
        let public_origin = value("KAIGEN_WEB_ORIGIN", "https://web.kaigen.one")?;
        if !valid_origin(&public_origin) {
            return Err("KAIGEN_WEB_ORIGIN must be an HTTPS origin without a path".to_string());
        }
        let disk_root = PathBuf::from(value("KAIGEN_WEB_DATA_ROOT", "/var/lib/kaigen-webd/disk")?);
        let ram_root = PathBuf::from(value("KAIGEN_WEB_RAM_ROOT", "/run/kaigen-webd/ram")?);
        let active_root =
            PathBuf::from(value("KAIGEN_WEB_ACTIVE_ROOT", "/run/kaigen-webd/active")?);
        let resource_root = PathBuf::from(value(
            "KAIGEN_WEB_RESOURCE_ROOT",
            "/opt/kaigen-webd/current",
        )?);
        let (disk_quota_bytes, ram_quota_bytes, security_reserve_bytes, max_instances) =
            deployment_limits(deployment_mode)?;
        let lease_hours = number("KAIGEN_WEB_LEASE_HOURS", 24)?;
        let proof_difficulty = number::<u8>("KAIGEN_WEB_PROOF_DIFFICULTY", 18)?;
        if !(12..=28).contains(&proof_difficulty) {
            return Err("KAIGEN_WEB_PROOF_DIFFICULTY must be between 12 and 28".to_string());
        }
        if active_root == disk_root
            || active_root == ram_root
            || disk_root.starts_with(&active_root)
            || ram_root.starts_with(&active_root)
            || active_root.starts_with(&disk_root)
            || active_root.starts_with(&ram_root)
        {
            return Err("KAIGEN_WEB_ACTIVE_ROOT must be isolated from storage roots".to_string());
        }
        Ok(Self {
            deployment_mode,
            bind,
            public_origin,
            disk_root,
            ram_root,
            active_root,
            resource_root,
            disk_quota_bytes,
            ram_quota_bytes,
            security_reserve_bytes,
            lease_hours,
            max_instances,
            proof_difficulty,
        })
    }

    pub fn quota_for(&self, mode: tauri_app_lib::web_core::StorageMode) -> u64 {
        match mode {
            tauri_app_lib::web_core::StorageMode::Disk => self.disk_quota_bytes,
            tauri_app_lib::web_core::StorageMode::Ram => self.ram_quota_bytes,
        }
    }

    pub fn public_quota_for(&self, mode: tauri_app_lib::web_core::StorageMode) -> Option<u64> {
        match self.deployment_mode {
            DeploymentMode::Personal => None,
            DeploymentMode::Service => Some(self.quota_for(mode)),
        }
    }
}

fn deployment_limits(mode: DeploymentMode) -> Result<(u64, u64, u64, usize), String> {
    if mode == DeploymentMode::Personal {
        for name in [
            "KAIGEN_WEB_DISK_QUOTA_BYTES",
            "KAIGEN_WEB_RAM_QUOTA_BYTES",
            "KAIGEN_WEB_SECURITY_RESERVE_BYTES",
            "KAIGEN_WEB_MAX_INSTANCES",
        ] {
            if env::var_os(name).is_some() {
                return Err(format!(
                    "{name} is not allowed in personal mode; personal mode has one workspace and no configured resource quotas"
                ));
            }
        }
        return Ok(personal_limits());
    }
    let disk_quota_bytes = number("KAIGEN_WEB_DISK_QUOTA_BYTES", TEST_DISK_QUOTA_BYTES)?;
    let ram_quota_bytes = number("KAIGEN_WEB_RAM_QUOTA_BYTES", TEST_RAM_QUOTA_BYTES)?;
    let security_reserve_bytes = number("KAIGEN_WEB_SECURITY_RESERVE_BYTES", 8 * 1024 * 1024)?;
    let max_instances = number::<usize>("KAIGEN_WEB_MAX_INSTANCES", TEST_MAX_INSTANCES)?;
    if max_instances == 0 {
        return Err("KAIGEN_WEB_MAX_INSTANCES must be finite and non-zero".to_string());
    }
    Ok((
        disk_quota_bytes,
        ram_quota_bytes,
        security_reserve_bytes,
        max_instances,
    ))
}

fn personal_limits() -> (u64, u64, u64, usize) {
    (u64::MAX, u64::MAX, u64::MAX, 1)
}

fn value(name: &str, default: &str) -> Result<String, String> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        Ok(_) => Err(format!("{name} cannot be empty")),
        Err(env::VarError::NotPresent) => Ok(default.to_string()),
        Err(error) => Err(format!("Could not read {name}: {error}")),
    }
}

fn number<T>(name: &str, default: T) -> Result<T, String>
where
    T: std::str::FromStr + ToString,
{
    value(name, &default.to_string())?
        .parse::<T>()
        .map_err(|_| format!("{name} has an invalid numeric value"))
}

fn valid_origin(origin: &str) -> bool {
    if !origin.starts_with("https://") || origin.ends_with('/') {
        return false;
    }
    let authority = &origin["https://".len()..];
    !authority.is_empty()
        && !authority.contains('/')
        && !authority.contains('?')
        && !authority.contains('#')
}

pub fn source_address(remote: SocketAddr, forwarded: Option<&str>) -> Vec<u8> {
    if remote.ip().is_loopback() {
        if let Some(address) = forwarded
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .and_then(|value| value.parse::<IpAddr>().ok())
        {
            return address.to_string().into_bytes();
        }
    }
    remote.ip().to_string().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::{personal_limits, DeploymentMode};

    #[test]
    fn deployment_mode_parser_is_fail_closed() {
        assert_eq!(
            DeploymentMode::parse("personal").unwrap(),
            DeploymentMode::Personal
        );
        assert_eq!(
            DeploymentMode::parse("service").unwrap(),
            DeploymentMode::Service
        );
        assert!(DeploymentMode::parse("shared").is_err());
    }

    #[test]
    fn personal_mode_has_one_workspace_and_unbounded_internal_ledgers() {
        let (disk, ram, reserve, instances) = personal_limits();
        assert_eq!(instances, 1);
        assert_eq!(disk, u64::MAX);
        assert_eq!(ram, u64::MAX);
        assert_eq!(reserve, u64::MAX);
    }
}
