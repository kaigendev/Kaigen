use super::{parse_fingerprint, wipe_string, Endpoint, SecretBytes, MAX_JSON_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt,
    io::{self, BufRead, BufReader, Read, Write},
    net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use url::Url;

// A cold onion rendezvous can outlast an ordinary TCP connection. Keep its
// budget separate and recheck the selected route while waiting for Tor/TLS.
const TOR_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);
const HANDSHAKE_IO_TICK: Duration = Duration::from_millis(250);

pub type TorEndpoint = Arc<dyn Fn() -> Option<SocketAddr> + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyMode {
    HttpConnect,
    Socks5,
    /// Preserve an unsupported configured route; never silently use direct IO.
    Unsupported,
}

#[derive(Clone)]
pub struct ProxyRoute {
    pub mode: ProxyMode,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl fmt::Debug for ProxyRoute {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProxyRoute")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

impl Drop for ProxyRoute {
    fn drop(&mut self) {
        wipe_string(std::mem::take(&mut self.username));
        wipe_string(std::mem::take(&mut self.password));
    }
}

impl ProxyRoute {
    fn validate(&self) -> Result<(), String> {
        if self.mode == ProxyMode::Unsupported {
            return Err("WEBGATE_PROXY_UNSUPPORTED".into());
        }
        let host = self.host.trim_start_matches('[').trim_end_matches(']');
        if self.port == 0
            || host.is_empty()
            || host.len() > 253
            || host
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
            || (host.parse::<IpAddr>().is_err() && url::Host::parse(host).is_err())
            || host
                .trim_end_matches('.')
                .to_ascii_lowercase()
                .ends_with(".onion")
            || self.username.len() > 255
            || self.password.len() > 255
            || (self.mode == ProxyMode::HttpConnect && self.username.contains(':'))
        {
            return Err("WEBGATE_PROXY_INVALID".into());
        }
        Ok(())
    }

    fn identity(&self) -> [u8; 32] {
        let mut digest = Sha256::new();
        digest.update([match self.mode {
            ProxyMode::HttpConnect => 1,
            ProxyMode::Socks5 => 2,
            ProxyMode::Unsupported => 0,
        }]);
        digest.update(self.port.to_be_bytes());
        for part in [&self.host, &self.username, &self.password] {
            digest.update((part.len() as u64).to_be_bytes());
            digest.update(part.as_bytes());
        }
        digest.finalize().into()
    }
}

#[derive(Clone)]
pub struct TransportPolicy {
    /// Explicit host/deployment permission, never inferred from a remote redirect.
    pub allow_private_networks: bool,
    /// Returns only the currently ready built-in Tor SOCKS endpoint.
    pub tor: Option<TorEndpoint>,
    /// The current shared setting also requires Tor for clearnet endpoints.
    pub require_tor: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// Current explicit shared proxy. None means disabled, never ambient env.
    pub proxy: Option<Arc<dyn Fn() -> Option<ProxyRoute> + Send + Sync>>,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
}

impl Default for TransportPolicy {
    fn default() -> Self {
        Self {
            allow_private_networks: false,
            tor: None,
            require_tor: None,
            proxy: None,
            connect_timeout: Duration::from_secs(15),
            request_timeout: Duration::from_secs(60),
        }
    }
}

struct PinVerifier {
    pin: Arc<Mutex<Option<[u8; 32]>>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl fmt::Debug for PinVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EndpointPinVerifier")
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let observed: [u8; 32] = Sha256::digest(cert.as_ref()).into();
        let pin = self
            .pin
            .lock()
            .map_err(|_| rustls::Error::General("WEBGATE_TLS_UNAVAILABLE".into()))?;
        if pin.as_ref().is_some_and(|pin| pin != &observed) {
            return Err(rustls::Error::General("WEBGATE_CERTIFICATE_CHANGED".into()));
        }
        // This exception belongs to this endpoint instance. The TLS handshake
        // still verifies proof of possession below. Commit TOFU only after it.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub(crate) struct Transport {
    endpoint: Endpoint,
    policy: TransportPolicy,
    pin: Arc<Mutex<Option<[u8; 32]>>>,
    strict_tls: Option<Arc<ClientConfig>>,
    sockets: Mutex<HashMap<u64, TcpStream>>,
    sequence: AtomicU64,
    generation: AtomicU64,
}

impl Transport {
    pub fn new(
        endpoint: Endpoint,
        fingerprint: Option<&str>,
        policy: TransportPolicy,
    ) -> Result<Arc<Self>, String> {
        let pin = fingerprint.map(parse_fingerprint).transpose()?;
        if policy.connect_timeout.is_zero() || policy.request_timeout.is_zero() {
            return Err("WEBGATE_TIMEOUT_INVALID".into());
        }
        Ok(Arc::new(Self {
            endpoint,
            policy,
            pin: Arc::new(Mutex::new(pin)),
            strict_tls: None,
            sockets: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            generation: AtomicU64::new(1),
        }))
    }

    /// The software updater never inherits Webgate's endpoint TOFU verifier.
    #[cfg(feature = "desktop")]
    pub(crate) fn official(url: url::Url, policy: TransportPolicy) -> Result<Arc<Self>, String> {
        if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            return Err("UPDATE_URL_INVALID".into());
        }
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions().map_err(|_| "UPDATE_TLS_UNAVAILABLE")?
            .with_root_certificates(roots).with_no_client_auth();
        Ok(Arc::new(Self {
            endpoint: Endpoint { base: url, identifier: String::new() }, policy,
            pin: Arc::new(Mutex::new(None)), strict_tls: Some(Arc::new(config)),
            sockets: Mutex::new(HashMap::new()), sequence: AtomicU64::new(1), generation: AtomicU64::new(1),
        }))
    }

    #[cfg(feature = "desktop")]
    pub(crate) fn official_get(self: &Arc<Self>, streaming: bool) -> Result<HttpBody, String> {
        if self.strict_tls.is_none() { return Err("UPDATE_TLS_UNAVAILABLE".into()); }
        self.request_url("GET", self.endpoint.base.clone(), None, None, &[], streaming)
    }

    pub fn interrupt(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut sockets) = self.sockets.lock() {
            for (_, socket) in sockets.drain() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }

    pub fn fingerprint(&self) -> Option<String> {
        self.pin
            .lock()
            .ok()?
            .as_ref()
            .map(|bytes| bytes.iter().map(|b| format!("{b:02x}")).collect())
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn assert_generation(&self, generation: u64) -> Result<(), String> {
        if self.generation() != generation {
            return Err("WEBGATE_TRANSPORT_CHANGED".into());
        }
        self.tor_endpoint()?;
        Ok(())
    }

    fn tor_endpoint(&self) -> Result<Option<SocketAddr>, String> {
        if !self.endpoint.is_onion()
            && !self
                .policy
                .require_tor
                .as_ref()
                .is_some_and(|required| required())
        {
            return Ok(None);
        }
        self.policy
            .tor
            .as_ref()
            .and_then(|provider| provider())
            .map(Some)
            .ok_or_else(|| "WEBGATE_TOR_REQUIRED".into())
    }

    fn proxy_route(&self) -> Result<Option<ProxyRoute>, String> {
        let route = self.policy.proxy.as_ref().and_then(|provider| provider());
        if let Some(route) = &route {
            route.validate()?;
        }
        Ok(route)
    }

    fn connect(self: &Arc<Self>, streaming: bool) -> Result<GuardedStream, String> {
        let generation = self.generation.load(Ordering::Acquire);
        let tor = self.tor_endpoint()?;
        // Built-in Tor takes precedence over every generic proxy setting.
        let proxy = if tor.is_none() {
            self.proxy_route()?
        } else {
            None
        };
        let host = self
            .endpoint
            .base
            .host_str()
            .ok_or("WEBGATE_ENDPOINT_INVALID")?;
        let port = self
            .endpoint
            .base
            .port_or_known_default()
            .ok_or("WEBGATE_ENDPOINT_INVALID")?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let target = if proxy.is_some() && !self.policy.allow_private_networks {
            // Check every answer, then send an exact approved IP through the
            // proxy: a second proxy-side DNS lookup must not undo SSRF checks.
            resolve_allowed(host, port, false)?[0].ip().to_string()
        } else {
            if let Ok(address) = host.parse::<IpAddr>() {
                if !address_allowed(address, self.policy.allow_private_networks) {
                    return Err("WEBGATE_ADDRESS_DENIED".into());
                }
            }
            host.to_string()
        };
        let addresses = if let Some(proxy) = tor {
            // A configured built-in Tor route is trusted local infrastructure.
            vec![proxy]
        } else if let Some(proxy) = &proxy {
            resolve_allowed(&proxy.host, proxy.port, self.policy.allow_private_networks)?
        } else {
            resolve_allowed(host, port, self.policy.allow_private_networks)?
        };
        let deadline = Instant::now() + self.policy.connect_timeout;
        let mut socket = None;
        for address in addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            if let Ok(connected) = TcpStream::connect_timeout(&address, remaining) {
                socket = Some(connected);
                break;
            }
        }
        let mut socket = socket.ok_or("WEBGATE_CONNECT_FAILED")?;
        socket
            .set_read_timeout(Some(self.policy.connect_timeout))
            .map_err(|_| "WEBGATE_CONNECT_FAILED")?;
        socket
            .set_write_timeout(Some(self.policy.connect_timeout))
            .map_err(|_| "WEBGATE_CONNECT_FAILED")?;
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        self.sockets
            .lock()
            .map_err(|_| "WEBGATE_TRANSPORT_UNAVAILABLE")?
            .insert(
                id,
                socket.try_clone().map_err(|_| "WEBGATE_CONNECT_FAILED")?,
            );
        let lease = SocketLease {
            transport: Arc::clone(self),
            id,
            generation,
            tor,
            proxy_identity: proxy.as_ref().map(ProxyRoute::identity),
        };
        lease.check().map_err(io_code)?;
        let handshake_deadline = if tor.is_some() {
            Instant::now() + TOR_HANDSHAKE_TIMEOUT
        } else {
            deadline
        };
        {
            let mut tunnel = TunnelStream {
                socket: &mut socket,
                lease: &lease,
                deadline: handshake_deadline,
            };
            if tor.is_some() {
                socks_connect(&mut tunnel, &target, port, None).map_err(io_code)?;
            } else if let Some(proxy) = &proxy {
                match proxy.mode {
                    ProxyMode::HttpConnect => http_connect(&mut tunnel, &target, port, proxy),
                    ProxyMode::Socks5 => socks_connect(&mut tunnel, &target, port, Some(proxy)),
                    ProxyMode::Unsupported => return Err("WEBGATE_PROXY_UNSUPPORTED".into()),
                }
                .map_err(io_code)?;
            }
        }
        drop(proxy);
        let io: Box<dyn ReadWrite> = if self.endpoint.base.scheme() == "https" {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let config = if let Some(config) = &self.strict_tls { Arc::clone(config) } else {
                Arc::new(ClientConfig::builder_with_provider(Arc::clone(&provider))
                .with_safe_default_protocol_versions()
                .map_err(|_| "WEBGATE_TLS_UNAVAILABLE")?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(PinVerifier {
                    pin: Arc::clone(&self.pin),
                    provider,
                }))
                .with_no_client_auth())
            };
            let server_name = ServerName::try_from(
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_string(),
            )
            .map_err(|_| "WEBGATE_ENDPOINT_INVALID")?;
            let mut connection = ClientConnection::new(config, server_name)
                .map_err(|_| "WEBGATE_TLS_UNAVAILABLE")?;
            {
                let mut tunnel = TunnelStream {
                    socket: &mut socket,
                    lease: &lease,
                    deadline: handshake_deadline,
                };
                while connection.is_handshaking() {
                    tunnel.prepare().map_err(io_code)?;
                    connection.complete_io(&mut tunnel).map_err(|error| {
                        if let Err(changed) = lease.check() {
                            return io_code(changed);
                        }
                        if error.to_string().contains("WEBGATE_CERTIFICATE_CHANGED") {
                            "WEBGATE_CERTIFICATE_CHANGED".to_string()
                        } else {
                            let code = io_code(error);
                            if code == "WEBGATE_CONNECTION_LOST" {
                                "WEBGATE_TLS_FAILED".to_string()
                            } else {
                                code
                            }
                        }
                    })?;
                }
            }
            if self.strict_tls.is_none() {
            let cert = connection
                .peer_certificates()
                .and_then(|certificates| certificates.first())
                .ok_or("WEBGATE_TLS_FAILED")?;
            let observed: [u8; 32] = Sha256::digest(cert.as_ref()).into();
            let mut pin = self.pin.lock().map_err(|_| "WEBGATE_TLS_UNAVAILABLE")?;
            if pin.as_ref().is_some_and(|pin| pin != &observed) {
                return Err("WEBGATE_CERTIFICATE_CHANGED".into());
            }
            *pin = Some(observed);
            drop(pin);
            }
            Box::new(StreamOwned::new(connection, socket))
        } else {
            Box::new(socket)
        };
        lease.check().map_err(io_code)?;
        Ok(GuardedStream {
            io,
            lease,
            timeout: self.policy.request_timeout,
            deadline: (!streaming).then(|| Instant::now() + self.policy.request_timeout),
        })
    }

    pub fn request(
        self: &Arc<Self>,
        method: &str,
        route: &str,
        query: Option<(&str, u64)>,
        bearer: Option<&str>,
        epoch: Option<&str>,
        body: &[u8],
        streaming: bool,
    ) -> Result<HttpBody, String> {
        if body.len() > MAX_JSON_BYTES {
            return Err("WEBGATE_REQUEST_TOO_LARGE".into());
        }
        let mut url = self.endpoint.route(route)?;
        if let Some((epoch, after)) = query {
            url.query_pairs_mut()
                .append_pair("epoch", epoch)
                .append_pair("after", &after.to_string());
        }
        self.request_url(method, url, bearer, epoch, body, streaming)
    }

    fn request_url(self: &Arc<Self>, method: &str, url: url::Url, bearer: Option<&str>,
        epoch: Option<&str>, body: &[u8], streaming: bool) -> Result<HttpBody, String> {
        let official = self.strict_tls.is_some();
        let mut stream = self.connect(streaming)?;
        let path = url.path().to_string()
            + &url
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default();
        let host = host_header(&url)?;
        if bearer.is_some_and(|token| {
            !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        }) {
            return Err("WEBGATE_SESSION_INVALID".into());
        }
        if epoch.is_some_and(|epoch| {
            epoch.len() > 256
                || !epoch
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        }) {
            return Err("WEBGATE_SESSION_INVALID".into());
        }
        let mut headers = SecretBytes(format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
            if official { "application/octet-stream, application/vnd.github+json" } else if streaming { "text/event-stream" } else { "application/json" }, body.len()).into_bytes());
        if official { headers.0.extend_from_slice(b"User-Agent: Kaigen-Updater\r\nX-GitHub-Api-Version: 2022-11-28\r\n"); }
        if let Some(token) = bearer {
            headers.0.extend_from_slice(b"Authorization: Bearer ");
            headers.0.extend_from_slice(token.as_bytes());
            headers.0.extend_from_slice(b"\r\n");
        }
        if let Some(epoch) = epoch {
            headers.0.extend_from_slice(b"X-Kaigen-Webgate-Epoch: ");
            headers.0.extend_from_slice(epoch.as_bytes());
            headers.0.extend_from_slice(b"\r\n");
        }
        headers.0.extend_from_slice(b"\r\n");
        stream
            .write_all(&headers.0)
            .and_then(|_| stream.write_all(body))
            .and_then(|_| stream.flush())
            .map_err(io_code)?;
        drop(headers);
        let mut reader = BufReader::new(stream);
        let status_line = bounded_line(&mut reader, 8192).map_err(io_code)?;
        let status_line = std::str::from_utf8(&status_line).map_err(|_| "WEBGATE_HTTP_INVALID")?;
        let mut parts = status_line.split_whitespace();
        if !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
            return Err("WEBGATE_HTTP_INVALID".into());
        }
        let status: u16 = parts
            .next()
            .and_then(|part| part.parse().ok())
            .ok_or("WEBGATE_HTTP_INVALID")?;
        let mut length = None;
        let mut chunked = false;
        let mut total = status_line.len();
        let mut content_type = String::new();
        let mut location = None;
        loop {
            let line = bounded_line(&mut reader, 8192).map_err(io_code)?;
            total += line.len();
            if total > 64 * 1024 {
                return Err("WEBGATE_HTTP_INVALID".into());
            }
            if line == b"\r\n" || line == b"\n" {
                break;
            }
            let line = std::str::from_utf8(&line).map_err(|_| "WEBGATE_HTTP_INVALID")?;
            let (name, value) = line
                .trim_end()
                .split_once(':')
                .ok_or("WEBGATE_HTTP_INVALID")?;
            let value = value.trim();
            match name.to_ascii_lowercase().as_str() {
                "content-length" => {
                    if length.is_some() {
                        return Err("WEBGATE_HTTP_INVALID".into());
                    }
                    length = Some(value.parse::<u64>().map_err(|_| "WEBGATE_HTTP_INVALID")?);
                }
                "transfer-encoding" => {
                    if chunked || !value.eq_ignore_ascii_case("chunked") {
                        return Err("WEBGATE_HTTP_INVALID".into());
                    }
                    chunked = true;
                }
                "content-encoding" if !value.eq_ignore_ascii_case("identity") => {
                    return Err("WEBGATE_HTTP_INVALID".into())
                }
                "content-type" => content_type = value.to_ascii_lowercase(),
                "location" => {
                    if location.is_some() || value.len() > 8192 { return Err("WEBGATE_HTTP_INVALID".into()); }
                    location = Some(value.to_string());
                }
                _ => {}
            }
        }
        if chunked && length.is_some() {
            return Err("WEBGATE_HTTP_INVALID".into());
        }
        // Redirects are never followed, including same-origin redirects.
        if !official && (300..400).contains(&status) {
            return Err("WEBGATE_REDIRECT_DENIED".into());
        }
        if !official && streaming && status == 200 && !content_type.starts_with("text/event-stream") {
            return Err("WEBGATE_STREAM_INVALID".into());
        }
        Ok(HttpBody {
            reader,
            status,
            location,
            content_length: length,
            remaining: length,
            chunked,
            chunk_remaining: 0,
            chunk_terminator: false,
            finished: false,
        })
    }
}

fn host_header(url: &Url) -> Result<String, String> {
    let host = url.host_str().ok_or("WEBGATE_ENDPOINT_INVALID")?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn address_allowed(address: IpAddr, private: bool) -> bool {
    match address {
        IpAddr::V4(address) => {
            if address.is_unspecified()
                || address.is_broadcast()
                || address.is_multicast()
                || address.is_link_local()
                || address.octets()[0] == 0
                || address.octets()[0] >= 240
            {
                return false;
            }
            private
                || !(address.is_private()
                    || address.is_loopback()
                    || address.octets()[0] == 127
                    || (address.octets()[0] == 100 && (64..=127).contains(&address.octets()[1])))
        }
        IpAddr::V6(address) => {
            if let Some(v4) = address.to_ipv4_mapped() {
                return address_allowed(IpAddr::V4(v4), private);
            }
            if address.is_unspecified() || address.is_multicast() || address.is_unicast_link_local()
            {
                return false;
            }
            private || !(address.is_loopback() || address.is_unique_local())
        }
    }
}

fn resolve_allowed(host: &str, port: u16, private: bool) -> Result<Vec<SocketAddr>, String> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| "WEBGATE_DNS_FAILED")?
        .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !address_allowed(address.ip(), private))
    {
        return Err("WEBGATE_ADDRESS_DENIED".into());
    }
    Ok(addresses)
}

/// A tunnel handshake has the same cancellation generation and overall deadline
/// as TLS, including when a proxy trickles individual response bytes.
struct TunnelStream<'a> {
    socket: &'a mut TcpStream,
    lease: &'a SocketLease,
    deadline: Instant,
}

impl TunnelStream<'_> {
    fn prepare(&self) -> io::Result<()> {
        self.lease.check()?;
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::other("WEBGATE_TIMEOUT"));
        }
        let tick = remaining.min(HANDSHAKE_IO_TICK);
        self.socket.set_read_timeout(Some(tick))?;
        self.socket.set_write_timeout(Some(tick))
    }
}

impl Read for TunnelStream<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        loop {
            self.prepare()?;
            match self.socket.read(bytes) {
                Ok(count) => {
                    self.lease.check()?;
                    return Ok(count);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted
                            | io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => {
                    self.lease.check()?;
                    return Err(error);
                }
            }
        }
    }
}

impl Write for TunnelStream<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        loop {
            self.prepare()?;
            match self.socket.write(bytes) {
                Ok(count) => {
                    self.lease.check()?;
                    return Ok(count);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted
                            | io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => {
                    self.lease.check()?;
                    return Err(error);
                }
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        self.prepare()?;
        let flushed = self.socket.flush();
        self.lease.check()?;
        flushed
    }
}

fn http_connect(
    socket: &mut (impl Read + Write),
    host: &str,
    port: u16,
    proxy: &ProxyRoute,
) -> io::Result<()> {
    let authority = match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{host}]:{port}"),
        _ => format!("{host}:{port}"),
    };
    let mut request =
        SecretBytes(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n").into_bytes());
    if !proxy.username.is_empty() || !proxy.password.is_empty() {
        let mut credentials = SecretBytes(Vec::with_capacity(
            proxy.username.len() + proxy.password.len() + 1,
        ));
        credentials.0.extend_from_slice(proxy.username.as_bytes());
        credentials.0.push(b':');
        credentials.0.extend_from_slice(proxy.password.as_bytes());
        let encoded = SecretBytes(STANDARD.encode(&credentials.0).into_bytes());
        request.0.extend_from_slice(b"Proxy-Authorization: Basic ");
        request.0.extend_from_slice(&encoded.0);
        request.0.extend_from_slice(b"\r\n");
    }
    request.0.extend_from_slice(b"\r\n");
    socket.write_all(&request.0)?;
    drop(request);
    socket.flush()?;
    // Do not buffer beyond the proxy headers: following bytes belong to TLS.
    let mut response = Vec::new();
    let mut byte = [0; 1];
    while response.len() < 64 * 1024 && !response.ends_with(b"\r\n\r\n") {
        socket.read_exact(&mut byte)?;
        response.push(byte[0]);
    }
    if !response.ends_with(b"\r\n\r\n") {
        return Err(io::Error::other("WEBGATE_PROXY_RESPONSE_INVALID"));
    }
    let first_line = response
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    let first_line = std::str::from_utf8(first_line)
        .map_err(|_| io::Error::other("WEBGATE_PROXY_RESPONSE_INVALID"))?;
    let mut parts = first_line.split_ascii_whitespace();
    if !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        return Err(io::Error::other("WEBGATE_PROXY_RESPONSE_INVALID"));
    }
    match parts.next() {
        Some("200") => Ok(()),
        Some("407") => Err(io::Error::other("WEBGATE_PROXY_AUTH_FAILED")),
        _ => Err(io::Error::other("WEBGATE_PROXY_CONNECT_FAILED")),
    }
}

fn socks_connect(
    socket: &mut (impl Read + Write),
    host: &str,
    port: u16,
    proxy: Option<&ProxyRoute>,
) -> io::Result<()> {
    if host.len() > 255 {
        return Err(io::Error::other("WEBGATE_ENDPOINT_INVALID"));
    }
    let failure = if proxy.is_some() {
        "WEBGATE_PROXY_CONNECT_FAILED"
    } else {
        "WEBGATE_TOR_FAILED"
    };
    let authenticated =
        proxy.is_some_and(|proxy| !proxy.username.is_empty() || !proxy.password.is_empty());
    let method = if authenticated { 2 } else { 0 };
    socket.write_all(&[5, 1, method])?;
    let mut reply = [0; 2];
    socket.read_exact(&mut reply)?;
    if reply != [5, method] {
        return Err(io::Error::other(failure));
    }
    if let Some(proxy) = proxy.filter(|_| authenticated) {
        let mut auth = SecretBytes(vec![1, proxy.username.len() as u8]);
        auth.0.extend_from_slice(proxy.username.as_bytes());
        auth.0.push(proxy.password.len() as u8);
        auth.0.extend_from_slice(proxy.password.as_bytes());
        socket.write_all(&auth.0)?;
        drop(auth);
        socket.read_exact(&mut reply)?;
        if reply != [1, 0] {
            return Err(io::Error::other("WEBGATE_PROXY_AUTH_FAILED"));
        }
    }
    let mut request = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            request.push(1);
            request.extend_from_slice(&address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            request.push(4);
            request.extend_from_slice(&address.octets());
        }
        Err(_) => {
            request.extend_from_slice(&[3, host.len() as u8]);
            request.extend_from_slice(host.as_bytes());
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    socket.write_all(&request)?;
    let mut response = [0; 4];
    socket.read_exact(&mut response)?;
    if response[..3] != [5, 0, 0] {
        return Err(io::Error::other(failure));
    }
    let size = match response[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut size = [0];
            socket.read_exact(&mut size)?;
            usize::from(size[0])
        }
        _ => return Err(io::Error::other(failure)),
    };
    let mut ignored = vec![0; size + 2];
    socket.read_exact(&mut ignored)
}

trait ReadWrite: Read + Write + Send {
    fn set_timeout(&self, timeout: Duration) -> io::Result<()>;
}

impl ReadWrite for TcpStream {
    fn set_timeout(&self, timeout: Duration) -> io::Result<()> {
        self.set_read_timeout(Some(timeout))?;
        self.set_write_timeout(Some(timeout))
    }
}

impl ReadWrite for StreamOwned<ClientConnection, TcpStream> {
    fn set_timeout(&self, timeout: Duration) -> io::Result<()> {
        // Windows socket duplicates retain independent timeout options. Update
        // the handle that performs TLS I/O, including after the short handshake ticks.
        ReadWrite::set_timeout(&self.sock, timeout)
    }
}

struct SocketLease {
    transport: Arc<Transport>,
    id: u64,
    generation: u64,
    tor: Option<SocketAddr>,
    proxy_identity: Option<[u8; 32]>,
}
impl SocketLease {
    fn check(&self) -> io::Result<()> {
        if self.transport.generation.load(Ordering::Acquire) != self.generation {
            return Err(io::Error::other("WEBGATE_TRANSPORT_CHANGED"));
        }
        if self.transport.tor_endpoint().ok() != Some(self.tor) {
            return Err(io::Error::other("WEBGATE_TOR_REQUIRED"));
        }
        if self.tor.is_none() {
            let current = self.transport.proxy_route().map_err(io::Error::other)?;
            if current.as_ref().map(ProxyRoute::identity) != self.proxy_identity {
                return Err(io::Error::other("WEBGATE_TRANSPORT_CHANGED"));
            }
        }
        Ok(())
    }
}
impl Drop for SocketLease {
    fn drop(&mut self) {
        if let Ok(mut sockets) = self.transport.sockets.lock() {
            if let Some(socket) = sockets.remove(&self.id) {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
}

struct GuardedStream {
    io: Box<dyn ReadWrite>,
    lease: SocketLease,
    timeout: Duration,
    deadline: Option<Instant>,
}
impl GuardedStream {
    fn prepare(&self) -> io::Result<()> {
        self.lease.check()?;
        let timeout = self
            .deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(self.timeout)
            .min(self.timeout);
        if timeout.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline"));
        }
        self.io.set_timeout(timeout)
    }
}
impl Read for GuardedStream {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.prepare()?;
        self.io.read(output)
    }
}
impl Write for GuardedStream {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        self.prepare()?;
        self.io.write(input)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.prepare()?;
        self.io.flush()
    }
}

pub(crate) struct HttpBody {
    reader: BufReader<GuardedStream>,
    pub status: u16,
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub location: Option<String>,
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub content_length: Option<u64>,
    remaining: Option<u64>,
    chunked: bool,
    chunk_remaining: usize,
    chunk_terminator: bool,
    finished: bool,
}
impl HttpBody {
    pub fn bytes(mut self, limit: usize) -> Result<SecretBytes, String> {
        let mut result = SecretBytes(Vec::new());
        (&mut self)
            .take(limit as u64 + 1)
            .read_to_end(&mut result.0)
            .map_err(io_code)?;
        if result.0.len() > limit {
            return Err("WEBGATE_RESPONSE_TOO_LARGE".into());
        }
        Ok(result)
    }
}

impl Read for HttpBody {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.reader.get_ref().lease.check()?;
        if output.is_empty() || self.finished {
            return Ok(0);
        }
        if self.chunked {
            if self.chunk_remaining == 0 {
                if self.chunk_terminator {
                    let mut end = [0; 2];
                    self.reader.read_exact(&mut end)?;
                    if end != *b"\r\n" {
                        return Err(io::Error::other("WEBGATE_HTTP_INVALID"));
                    }
                }
                let line = bounded_line(&mut self.reader, 1024)?;
                let line = std::str::from_utf8(&line)
                    .map_err(|_| io::Error::other("WEBGATE_HTTP_INVALID"))?;
                let size = line.trim().split(';').next().unwrap_or_default();
                self.chunk_remaining = usize::from_str_radix(size, 16)
                    .map_err(|_| io::Error::other("WEBGATE_HTTP_INVALID"))?;
                if self.chunk_remaining == 0 {
                    self.finished = true;
                    return Ok(0);
                }
                self.chunk_terminator = true;
            }
            let amount = output.len().min(self.chunk_remaining);
            let count = self.reader.read(&mut output[..amount])?;
            if count == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "chunk"));
            }
            self.chunk_remaining -= count;
            return Ok(count);
        }
        let amount = self
            .remaining
            .map(|left| left.min(output.len() as u64) as usize)
            .unwrap_or(output.len());
        if amount == 0 {
            self.finished = true;
            return Ok(0);
        }
        let count = self.reader.read(&mut output[..amount])?;
        if count == 0 && self.remaining.is_some_and(|left| left > 0) {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "body"));
        }
        if let Some(left) = &mut self.remaining {
            *left -= count as u64;
        }
        Ok(count)
    }
}

pub(crate) fn bounded_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if result.is_empty() {
                Ok(result)
            } else {
                Err(io::Error::new(io::ErrorKind::UnexpectedEof, "line"))
            };
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        if result.len().saturating_add(count) > limit {
            return Err(io::Error::other("WEBGATE_RESPONSE_TOO_LARGE"));
        }
        result.extend_from_slice(&available[..count]);
        reader.consume(count);
        if result.last() == Some(&b'\n') {
            return Ok(result);
        }
    }
}

pub(crate) fn io_code(error: io::Error) -> String {
    let message = error.to_string();
    for code in [
        "WEBGATE_TOR_REQUIRED",
        "WEBGATE_TOR_FAILED",
        "WEBGATE_PROXY_UNSUPPORTED",
        "WEBGATE_PROXY_INVALID",
        "WEBGATE_PROXY_AUTH_FAILED",
        "WEBGATE_PROXY_CONNECT_FAILED",
        "WEBGATE_PROXY_RESPONSE_INVALID",
        "WEBGATE_TIMEOUT",
        "WEBGATE_TRANSPORT_CHANGED",
        "WEBGATE_HTTP_INVALID",
        "WEBGATE_RESPONSE_TOO_LARGE",
    ] {
        if message.contains(code) {
            return code.into();
        }
    }
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        "WEBGATE_TIMEOUT".into()
    } else {
        "WEBGATE_CONNECTION_LOST".into()
    }
}
