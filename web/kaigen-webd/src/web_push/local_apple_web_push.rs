use super::*;
use std::{
    net::{Ipv4Addr, SocketAddr},
    process::{Child, Command, Stdio},
    thread,
};
use ureq::{
    config::Config as HttpConfig,
    http::Uri,
    tls::{Certificate, RootCerts, TlsConfig},
    unversioned::{
        resolver::{ResolvedSocketAddrs, Resolver},
        transport::{DefaultConnector, NextTimeout},
    },
};

const PROVIDER_HOST: &str = "kaigen-fixture.push.apple.com";
const PUBLIC_ORIGIN: &str = "https://kaigen.test";

#[derive(Debug)]
struct LocalProviderResolver(SocketAddr);

impl Resolver for LocalProviderResolver {
    fn resolve(
        &self,
        uri: &Uri,
        _config: &HttpConfig,
        _timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        if uri.scheme_str() != Some("https")
            || uri.host() != Some(PROVIDER_HOST)
            || uri.port_u16().is_some_and(|port| port != 443)
        {
            return Err(ureq::Error::HostNotFound);
        }
        let mut addresses = self.empty();
        addresses.push(self.0);
        Ok(addresses)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderReady {
    origin: String,
    port: u16,
    ca_pem_path: PathBuf,
    p256dh: String,
    auth: String,
    endpoints: HashMap<String, String>,
}

struct LocalProvider {
    root: PathBuf,
    child: Option<Child>,
}

impl LocalProvider {
    fn start(vapid_public_key: &str) -> (Self, ProviderReady) {
        let root =
            PathBuf::from(std::env::var_os("KAIGEN_LOCAL_WEB_PUSH_RUN_ROOT").expect(
                "set KAIGEN_LOCAL_WEB_PUSH_RUN_ROOT to an existing test artifact directory",
            ));
        assert!(root.is_absolute() && root.is_dir());
        let mut nonce = [0; 16];
        SystemRandom::new().fill(&mut nonce).unwrap();
        let root = root.join(format!("local-web-push-{}", URL_SAFE_NO_PAD.encode(nonce)));
        fs::create_dir(&root).expect("create isolated provider run directory");
        let mut provider = Self { root, child: None };
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/local_apple_web_push_provider.mjs");
        let child = Command::new("node")
            .arg(fixture)
            .arg("--dir")
            .arg(&provider.root)
            .arg("--vapid")
            .arg(vapid_public_key)
            .args(["--subject", PUBLIC_ORIGIN])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .expect("start Node local Web Push provider");
        provider.child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(15);
        let readiness = provider.root.join("ready.json");
        loop {
            if let Ok(bytes) = fs::read(&readiness) {
                let ready = serde_json::from_slice(&bytes).expect("valid provider readiness");
                return (provider, ready);
            }
            assert!(
                provider
                    .child
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .unwrap()
                    .is_none(),
                "local Web Push provider exited before readiness"
            );
            assert!(
                Instant::now() < deadline,
                "local Web Push provider did not start"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for LocalProvider {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "starts a loopback fixture; requires Node.js, OpenSSL and an explicit test artifact directory"]
fn production_sender_round_trips_through_local_apple_web_push_provider() {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let vapid =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let public_key = URL_SAFE_NO_PAD.encode(vapid.public_key().as_ref());
    let (provider, ready) = LocalProvider::start(&public_key);
    assert_eq!(ready.origin, format!("https://{PROVIDER_HOST}"));
    assert_ne!(ready.port, 0);
    assert!(ready
        .ca_pem_path
        .canonicalize()
        .unwrap()
        .starts_with(provider.root.canonicalize().unwrap()));
    let ca = Certificate::from_pem(&fs::read(&ready.ca_pem_path).unwrap()).unwrap();
    let config = HttpConfig::builder()
        .https_only(true)
        .proxy(None)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::from([ca]))
                .build(),
        )
        .build();
    let agent = ureq::Agent::with_parts(
        config,
        DefaultConnector::default(),
        LocalProviderResolver(SocketAddr::from((Ipv4Addr::LOCALHOST, ready.port))),
    );

    let profile = "d3503f35-28b9-4b8f-9c2c-431892370d86".to_owned();
    let peer = "A1".repeat(32);
    let target = (profile.clone(), peer.clone());
    let device = [91; 32];
    let hint = URL_SAFE_NO_PAD.encode([15; 16]);
    let mut secret = [0; 32];
    rng.fill(&mut secret).unwrap();
    let token_key =
        aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &secret).unwrap());
    let token = seal_notification_token(&token_key, &device, &hint, &target).unwrap();

    let mut job = Job {
        root: provider.root.clone(),
        subscription: Subscription {
            endpoint: String::new(),
            keys: Keys {
                p256dh: ready.p256dh,
                auth: ready.auth,
            },
            device,
            language: "en".into(),
            generation: 1,
        },
        sequence: 1,
        silent: true,
        volume: 0.25,
        routing_hint: hint.clone(),
        targets: vec![target],
        key: Arc::new(vapid),
        public_key,
        subject: PUBLIC_ORIGIN.into(),
        agent,
        vapid: Arc::new(Mutex::new(HashMap::new())),
    };
    let outcomes = [
        ("accepted", 201),
        ("expired", 404),
        ("gone", 410),
        ("retry", 503),
    ];
    for (branch, expected) in outcomes {
        job.subscription.endpoint = ready.endpoints[branch].clone();
        assert_eq!(send(&job, &token), Ok(expected), "provider branch {branch}");
    }
    job.subscription.endpoint = "https://127.0.0.1/".into();
    assert!(
        send(&job, &token).is_err(),
        "ordinary localhost must remain rejected"
    );

    let observed = fs::read_to_string(provider.root.join("observed.jsonl")).unwrap();
    assert_eq!(observed.lines().count(), outcomes.len());
    for (line, (branch, expected)) in observed.lines().zip(outcomes) {
        let event: Value = serde_json::from_str(line).unwrap();
        assert_eq!(event["branch"], branch);
        assert_eq!(event["status"], expected);
        let payload = &event["payload"];
        assert_eq!(payload["web_push"], 8030);
        assert_eq!(payload["routingHint"], hint);
        assert_eq!(payload["eventToken"], token);
        assert_eq!(payload["notification"]["title"], "Kaigen");
        assert_eq!(payload["notification"]["silent"], true);
        let navigate =
            url::Url::parse(payload["notification"]["navigate"].as_str().unwrap()).unwrap();
        assert_eq!(navigate.origin().ascii_serialization(), PUBLIC_ORIGIN);
        assert_eq!(navigate.path(), "/");
        assert_eq!(navigate.query(), Some("kaigen-notification=1"));
        let fragment: HashMap<_, _> =
            url::form_urlencoded::parse(navigate.fragment().unwrap().as_bytes()).collect();
        assert_eq!(fragment.len(), 2);
        assert_eq!(fragment["kaigen-notification"], hint);
        let routed = open_notification_token(
            &token_key,
            &device,
            &hint,
            &fragment["kaigen-notification-event"],
        )
        .unwrap();
        assert_eq!(routed, json!({ "profileId": profile, "target": peer }));
        assert!(!payload.to_string().contains(&profile));
        assert!(!payload.to_string().contains(&peer));
    }
    println!("LOCAL_APPLE_WEB_PUSH_PASS statuses=201,404,410,503 vapid=verified aes128gcm=decrypted exact_chat=true");
}
