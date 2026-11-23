use super::{
    create_tox_handle, prepare_proxy_route, profiles, tox_iterate, NetworkSettings, ProxyRoute,
    ProxySettings, TorManager, ToxHandle,
};
use crate::tox_native::ToxRef;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    ffi::CString,
    fs, io,
    net::{IpAddr, ToSocketAddrs},
    path::PathBuf,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const DEFAULT_NODES: [(&str, u16, &str); 4] = [
    (
        "144.217.167.73",
        33445,
        "7E5668E0EE09E19F320AD47902419331FFEE147BB3606769CFBE921A2A2FD34C",
    ),
    (
        "172.104.215.182",
        33445,
        "DA2BD927E01CD05EBCC2574EBE5BEBB10FF59AE0B2105A7D1E2B40E49BB20239",
    ),
    (
        "tox.initramfs.io",
        33445,
        "3F0A45A268367C1BEA652F258C85F4A66DA76BCAA667A49E770BCC4917AB6A25",
    ),
    (
        "tox1.mf-net.eu",
        33445,
        "B3E5FA80DC8EBD1149AD2AB35ED8B85BD546DEDE261CA593234C619249419506",
    ),
];
const MAX_NODES: usize = 32;
const DNS_TTL: Duration = Duration::from_secs(300);

/// A freshly constructed probe never installs application callbacks.
struct ProbeTox(ToxHandle);

impl ProbeTox {
    fn iterate(&self) {
        // SAFETY: This probe owns a live Tox instance without callbacks or
        // callback userdata. It is used only on its creating thread.
        unsafe { tox_iterate(self.0.instance.as_ptr(), ptr::null_mut()) };
    }
}

#[derive(Clone, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Node {
    host: String,
    port: u16,
    public_key: String,
}

impl Node {
    fn normalized(mut self, public_only: bool) -> Result<Self, String> {
        self.host = self.host.trim().to_ascii_lowercase();
        self.public_key = self.public_key.trim().to_ascii_uppercase();
        if self.port == 0 || decode_key(&self.public_key).is_none() {
            return Err("BOOTSTRAP_NODE_INVALID".into());
        }
        if let Ok(ip) = self.host.parse::<IpAddr>() {
            if public_only && !public_address(ip) {
                return Err("BOOTSTRAP_NODE_ADDRESS_FORBIDDEN".into());
            }
            self.host = ip.to_string();
        } else if self.host.len() > 253
            || !self.host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err("BOOTSTRAP_NODE_INVALID".into());
        }
        Ok(self)
    }

    fn endpoints(&self, dns: bool, ipv6: bool, public_only: bool) -> Vec<Endpoint> {
        let Some(key) = decode_key(&self.public_key) else {
            return Vec::new();
        };
        let addresses = match self.host.parse::<IpAddr>() {
            Ok(ip) => vec![ip],
            Err(_) if dns => (self.host.as_str(), self.port)
                .to_socket_addrs()
                .map(|addresses| addresses.map(|address| address.ip()).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        let mut seen = HashSet::new();
        addresses
            .into_iter()
            .filter(|ip| {
                (ipv6 || ip.is_ipv4()) && (!public_only || public_address(*ip)) && seen.insert(*ip)
            })
            .take(4)
            .filter_map(|ip| {
                Some(Endpoint {
                    node: self.clone(),
                    ip: CString::new(ip.to_string()).ok()?,
                    key,
                })
            })
            .collect()
    }
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut key = [0; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    (key != [0; 32]).then_some(key)
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => !matches!(
            ip.octets(),
            [0 | 10 | 127 | 224..=255, ..]
                | [100, 64..=127, ..]
                | [169, 254, ..]
                | [172, 16..=31, ..]
                | [192, 0, 0 | 2, _]
                | [192, 88, 99, _]
                | [192, 168, ..]
                | [198, 18 | 19, ..]
                | [198, 51, 100, _]
                | [203, 0, 113, _]
        ),
        IpAddr::V6(ip) => {
            let [first, second, ..] = ip.segments();
            (0x2000..=0x3fff).contains(&first)
                && !(first == 0x2001 && (second < 0x200 || second == 0xdb8))
                && first != 0x2002
                && first != 0x3fff
        }
    }
}

#[derive(Clone)]
pub(super) struct Endpoint {
    node: Node,
    ip: CString,
    key: [u8; 32],
}

impl Endpoint {
    #[cfg(test)]
    pub(super) fn numeric_ip(&self) -> bool {
        self.ip
            .to_str()
            .is_ok_and(|ip| ip.parse::<IpAddr>().is_ok())
    }

    fn begin(&self, tox: ToxRef<'_>) {
        let mut error = 0;
        let _ = tox.bootstrap(&self.ip, self.node.port, &self.key, &mut error);
        let _ = tox.add_tcp_relay(&self.ip, self.node.port, &self.key, &mut error);
    }

    fn used(&self, tox: ToxRef<'_>) -> bool {
        tox.bootstrap_observed(&self.ip, self.node.port, &self.key)
    }
}

pub(super) fn connect(tox: ToxRef<'_>, endpoints: &[Endpoint]) {
    for endpoint in endpoints {
        endpoint.begin(tox);
    }
}

pub(super) fn observed(tox: ToxRef<'_>, endpoints: &[Endpoint]) -> HashSet<Node> {
    endpoints
        .iter()
        .filter(|endpoint| endpoint.used(tox))
        .map(|endpoint| endpoint.node.clone())
        .collect()
}

struct Config {
    nodes: Vec<Node>,
    revision: u64,
    resolved: Option<(Instant, Vec<Endpoint>)>,
    resolving: bool,
}

pub(super) struct State {
    path: Option<PathBuf>,
    public_only: bool,
    config: Mutex<Config>,
    probing: AtomicBool,
}

impl State {
    fn validate(nodes: Vec<Node>, public_only: bool) -> Result<Vec<Node>, String> {
        if nodes.len() > MAX_NODES {
            return Err("BOOTSTRAP_NODE_LIMIT".into());
        }
        let nodes: Vec<_> = nodes
            .into_iter()
            .map(|node| node.normalized(public_only))
            .collect::<Result<_, _>>()?;
        if nodes.iter().collect::<HashSet<_>>().len() != nodes.len() {
            return Err("BOOTSTRAP_NODE_DUPLICATE".into());
        }
        Ok(nodes)
    }

    fn defaults() -> Vec<Node> {
        DEFAULT_NODES
            .iter()
            .map(|&(host, port, key)| Node {
                host: host.into(),
                port,
                public_key: key.into(),
            })
            .collect()
    }

    pub(super) fn load(path: Option<PathBuf>, public_only: bool) -> Result<Arc<Self>, String> {
        let nodes = if let Some(path) = &path {
            match fs::read(path) {
                Ok(data) if data.len() <= 32 * 1024 => Self::validate(
                    serde_json::from_slice(&data).map_err(|_| "BOOTSTRAP_SETTINGS_INVALID")?,
                    public_only,
                )?,
                Ok(_) => return Err("BOOTSTRAP_SETTINGS_INVALID".into()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Self::defaults(),
                Err(_) => return Err("BOOTSTRAP_SETTINGS_UNAVAILABLE".into()),
            }
        } else {
            Self::defaults()
        };
        Ok(Arc::new(Self {
            path,
            public_only,
            config: Mutex::new(Config {
                nodes,
                revision: 0,
                resolved: None,
                resolving: false,
            }),
            probing: AtomicBool::new(false),
        }))
    }

    pub(super) fn replace(&self, nodes: Vec<Node>) -> Result<(), String> {
        self.replace_after_checkpoint(nodes, || Ok(()))
    }

    pub(super) fn replace_after_checkpoint(
        &self,
        nodes: Vec<Node>,
        checkpoint: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let nodes = Self::validate(nodes, self.public_only)?;
        let mut config = self
            .config
            .lock()
            .map_err(|_| "BOOTSTRAP_SETTINGS_UNAVAILABLE")?;
        if config.nodes == nodes {
            return Ok(());
        }
        if let Some(path) = &self.path {
            let encoded =
                serde_json::to_vec_pretty(&nodes).map_err(|_| "BOOTSTRAP_SETTINGS_INVALID")?;
            let previous = match fs::read(path) {
                Ok(data) => Some(data),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(_) => return Err("BOOTSTRAP_SETTINGS_UNAVAILABLE".into()),
            };
            profiles::atomic_write(path, &encoded)?;
            if let Err(error) = checkpoint() {
                let restored = match previous {
                    Some(data) => profiles::atomic_write(path, &data).is_ok(),
                    None => fs::remove_file(path).is_ok(),
                };
                return if restored {
                    Err(error)
                } else {
                    Err(format!("BOOTSTRAP_SETTINGS_ROLLBACK_FAILED: {error}"))
                };
            }
        } else {
            checkpoint()?;
        }
        config.nodes = nodes;
        config.revision = config.revision.wrapping_add(1);
        config.resolved = None;
        config.resolving = false;
        Ok(())
    }

    pub(super) fn view(
        &self,
        used: impl FnOnce(u64) -> HashSet<Node>,
    ) -> Result<serde_json::Value, String> {
        let config = self
            .config
            .lock()
            .map_err(|_| "BOOTSTRAP_SETTINGS_UNAVAILABLE")?;
        let used = used(config.revision);
        let rows: Vec<_> = config
            .nodes
            .iter()
            .map(|node| {
                serde_json::json!({
                    "host": node.host, "port": node.port, "publicKey": node.public_key,
                    "status": if used.contains(node) { "used" } else { "unknown" },
                })
            })
            .collect();
        Ok(serde_json::Value::Array(rows))
    }

    pub(super) fn snapshot(
        self: &Arc<Self>,
        dns: bool,
        ipv6: bool,
    ) -> Option<(u64, Vec<Endpoint>)> {
        let mut config = self.config.try_lock().ok()?;
        let revision = config.revision;
        let filter_ipv6 = |endpoints: &[Endpoint]| {
            endpoints
                .iter()
                .filter(|entry| ipv6 || !entry.ip.as_bytes().contains(&b':'))
                .cloned()
                .collect()
        };
        if dns {
            if let Some((updated, endpoints)) = &config.resolved {
                if updated.elapsed() < DNS_TTL {
                    return Some((revision, filter_ipv6(endpoints)));
                }
            }
            if !config.resolving
                && config
                    .nodes
                    .iter()
                    .any(|node| node.host.parse::<IpAddr>().is_err())
            {
                config.resolving = true;
                let nodes = config.nodes.clone();
                let owner = Arc::clone(self);
                let spawned = thread::Builder::new().spawn(move || {
                    let endpoints = nodes
                        .iter()
                        .flat_map(|node| node.endpoints(true, true, owner.public_only))
                        .collect();
                    if let Ok(mut current) = owner.config.lock() {
                        if current.revision == revision {
                            current.resolving = false;
                            current.resolved = Some((Instant::now(), endpoints));
                        }
                    }
                });
                if spawned.is_err() {
                    config.resolving = false;
                }
            }
            if let Some((_, endpoints)) = &config.resolved {
                return Some((revision, filter_ipv6(endpoints)));
            }
        }
        Some((
            revision,
            config
                .nodes
                .iter()
                .flat_map(|node| node.endpoints(false, ipv6, self.public_only))
                .collect(),
        ))
    }

    pub(super) fn revision_is_current(&self, revision: u64) -> bool {
        self.config
            .try_lock()
            .is_ok_and(|config| config.revision == revision)
    }

    pub(super) fn with_current(&self, revision: u64, apply: impl FnOnce()) -> bool {
        let Ok(config) = self.config.try_lock() else {
            return false;
        };
        if config.revision != revision {
            return false;
        }
        apply();
        true
    }

    pub(super) fn prepare_probe(
        self: &Arc<Self>,
        node: Node,
        network_owner: Arc<Mutex<NetworkSettings>>,
        proxy_owner: Arc<Mutex<ProxySettings>>,
        tor: TorManager,
    ) -> Result<Probe, String> {
        let node = node.normalized(self.public_only)?;
        let network = network_owner
            .lock()
            .map_err(|_| "BOOTSTRAP_ROUTE_UNAVAILABLE")?
            .clone();
        let proxy = proxy_owner
            .lock()
            .map_err(|_| "BOOTSTRAP_ROUTE_UNAVAILABLE")?
            .clone();
        let tor_port = tor.enabled().then(|| tor.proxy_port());
        if tor_port == Some(None) {
            return Err("BOOTSTRAP_ROUTE_UNAVAILABLE".into());
        }
        if self.probing.swap(true, Ordering::AcqRel) {
            return Err("BOOTSTRAP_PROBE_BUSY".into());
        }
        Ok(Probe {
            owner: Arc::clone(self),
            node,
            network,
            proxy,
            network_owner,
            proxy_owner,
            tor,
            tor_port,
        })
    }
}

pub struct Probe {
    owner: Arc<State>,
    node: Node,
    network: NetworkSettings,
    proxy: ProxySettings,
    network_owner: Arc<Mutex<NetworkSettings>>,
    proxy_owner: Arc<Mutex<ProxySettings>>,
    tor: TorManager,
    tor_port: Option<Option<u16>>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.owner.probing.store(false, Ordering::Release);
    }
}

impl Probe {
    fn route_is_current(&self) -> bool {
        self.tor.enabled().then(|| self.tor.proxy_port()) == self.tor_port
            && self
                .network_owner
                .lock()
                .is_ok_and(|network| *network == self.network)
            && self
                .proxy_owner
                .lock()
                .is_ok_and(|proxy| *proxy == self.proxy)
    }

    #[cfg(feature = "web-core")]
    pub(super) fn belongs_to(&self, owner: &Arc<State>) -> bool {
        Arc::ptr_eq(&self.owner, owner) && self.route_is_current()
    }

    pub fn execute(&self) -> Result<&'static str, String> {
        let (route, _bridge) = if let Some(port) = self.tor_port.flatten() {
            (
                Some(ProxyRoute {
                    proxy_type: 2,
                    host: "127.0.0.1".into(),
                    port,
                    label: "tor-socks5".into(),
                }),
                None,
            )
        } else {
            prepare_proxy_route(&self.proxy)?
        };
        let endpoints = self.node.endpoints(
            route.is_none(),
            self.network.ipv6_enabled,
            self.owner.public_only,
        );
        if !self.route_is_current() {
            return Err("BOOTSTRAP_ROUTE_CHANGED".into());
        }
        if endpoints.is_empty() {
            return Ok("unreachable");
        }
        let mut network = self.network.clone();
        network.local_discovery_enabled = false;
        let handle = ProbeTox(create_tox_handle(
            PathBuf::new(), None, route.as_ref(), &network, None,
        )?);
        let tox = handle.0.native();
        connect(tox, &endpoints);
        let until = Instant::now() + Duration::from_secs(5);
        let mut reached = false;
        while Instant::now() < until && self.route_is_current() {
            handle.iterate();
            if endpoints.iter().any(|endpoint| endpoint.used(tox)) {
                reached = true;
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
        drop(handle);
        if !self.route_is_current() {
            return Err("BOOTSTRAP_ROUTE_CHANGED".into());
        }
        Ok(if reached { "reachable" } else { "unreachable" })
    }
}
