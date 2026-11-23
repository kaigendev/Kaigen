//! Real toxcore callbacks on a disposable, local-only two-client connection.
//! Protocol unit tests cover policy edges; this checks the actual wire boundary.
use crate::{chat_protocol::*, file_card_protocol as cards};
use std::{
    ffi::c_void,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

extern "C" {
    fn tox_self_get_public_key(tox: *const c_void, key: *mut u8);
    fn tox_self_get_dht_id(tox: *const c_void, key: *mut u8);
    fn tox_self_get_udp_port(tox: *const c_void, error: *mut i32) -> u16;
    fn tox_default_system() -> ToxSystem;
    fn tox_new_testing(
        options: *const c_void,
        error: *mut i32,
        testing: *const ToxOptionsTesting,
        testing_error: *mut i32,
    ) -> *mut c_void;
}

// Exact layouts from the pinned toxcore/net.h and tox_private.h. The unused
// function pointers are copied opaquely, never called with a Rust signature.
#[repr(C)]
#[derive(Clone, Copy)]
struct Socket {
    value: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Family {
    value: u8,
}
#[repr(C)]
#[derive(Clone, Copy)]
union IpBytes {
    v4: [u8; 4],
    v6: [u64; 2],
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Ip {
    family: Family,
    bytes: IpBytes,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct IpPort {
    ip: Ip,
    port: u16,
}
type Bind = unsafe extern "C" fn(*mut c_void, Socket, *const IpPort) -> i32;
#[repr(C)]
#[derive(Clone, Copy)]
struct NetworkFunctions {
    close: *const c_void,
    accept: *const c_void,
    bind: Option<Bind>,
    // listen, connect, recvbuf, recv, recvfrom, send, sendto, socket,
    // socket_nonblock, getsockopt, setsockopt, getaddrinfo, freeaddrinfo.
    remaining: [*const c_void; 13],
}
#[repr(C)]
struct Network {
    functions: *const NetworkFunctions,
    object: *mut c_void,
}
#[repr(C)]
struct ToxSystem {
    mono_time_callback: Option<unsafe extern "C" fn(*mut c_void) -> u64>,
    mono_time_user_data: *mut c_void,
    random: *const c_void,
    network: *const Network,
    memory: *const c_void,
}
#[repr(C)]
struct ToxOptionsTesting {
    operating_system: *const ToxSystem,
}

static LOOPBACK_BINDS: AtomicUsize = AtomicUsize::new(0);

unsafe extern "C" fn loopback_bind(
    object: *mut c_void,
    socket: Socket,
    address: *const IpPort,
) -> i32 {
    // SAFETY: Tox passes an aligned IpPort for the duration of this callback.
    let Some(address) = (unsafe { address.as_ref() }) else {
        return -1;
    };
    if address.ip.family.value != 2 {
        return -1;
    }
    // SAFETY: The pinned Tox implementation returns its static default
    // network tables. Read their bind function without retaining the pointers.
    let bind = unsafe {
        tox_default_system()
            .network
            .as_ref()
            .and_then(|network| network.functions.as_ref())
            .and_then(|functions| functions.bind)
    };
    let Some(bind) = bind else {
        return -1;
    };
    let mut local = *address;
    local.ip.bytes = IpBytes { v6: [0; 2] };
    local.ip.bytes.v4 = [127, 0, 0, 1];
    // SAFETY: Forward the native object and socket with a live IpPort value.
    let result = unsafe { bind(object, socket, &local) };
    if result == 0 {
        LOOPBACK_BINDS.fetch_add(1, Ordering::Relaxed);
    }
    result
}

/// # Safety
/// The test iteration owns the Inbox supplied as native user data. This
/// callback may borrow it only until the closure returns.
unsafe fn with_native_inbox(user: *mut c_void, consume: impl FnOnce(&mut Inbox)) {
    let user = user.cast::<Inbox>();
    if user.is_null() || !user.is_aligned() {
        return;
    }
    // SAFETY: The caller guarantees exclusive access during this invocation.
    consume(unsafe { &mut *user });
}

/// # Safety
/// Tox owns a readable payload of length len for this invocation, and user
/// must satisfy with_native_inbox's contract.
unsafe fn with_native_payload(
    user: *mut c_void,
    bytes: *const u8,
    len: usize,
    limit: usize,
    consume: impl FnOnce(&mut Inbox, &[u8]),
) {
    if bytes.is_null() || len > limit {
        return;
    }
    // SAFETY: Both borrows are valid for the closure and cannot escape it.
    unsafe {
        with_native_inbox(user, |inbox| {
            consume(inbox, std::slice::from_raw_parts(bytes, len));
        });
    }
}

#[derive(Default)]
struct Inbox {
    packets: Vec<(u32, Vec<u8>)>,
    messages: Vec<(u32, String)>,
    client_delivery: Vec<(u32, u32)>,
}

unsafe extern "C" fn packet_callback(
    _: *mut c_void,
    friend: u32,
    bytes: *const u8,
    len: usize,
    user: *mut c_void,
) {
    // SAFETY: The pointer and payload come from this synchronous Tox callback.
    unsafe {
        with_native_payload(user, bytes, len, 1373, |inbox, bytes| {
            if inbox.packets.len() < 128 {
                inbox.packets.push((friend, bytes.to_vec()));
            }
        });
    }
}

unsafe extern "C" fn message_callback(
    _: *mut c_void,
    friend: u32,
    kind: i32,
    bytes: *const u8,
    len: usize,
    user: *mut c_void,
) {
    if kind != 0 {
        return;
    }
    // SAFETY: The pointer and payload come from this synchronous Tox callback.
    unsafe {
        with_native_payload(user, bytes, len, 1372, |inbox, bytes| {
            if inbox.messages.len() < 128 {
                if let Ok(text) = std::str::from_utf8(bytes) {
                    inbox.messages.push((friend, text.to_owned()));
                }
            }
        });
    }
}

// This is toxcore's historically named read_receipt callback. It acknowledges
// delivery to the receiving Tox client; no viewing action exists in this test.
unsafe extern "C" fn delivery_callback(
    _: *mut c_void,
    friend: u32,
    receipt: u32,
    user: *mut c_void,
) {
    // SAFETY: The test iteration passes its own Inbox as callback data.
    unsafe {
        with_native_inbox(user, |inbox| {
            if inbox.client_delivery.len() < 128 {
                inbox.client_delivery.push((friend, receipt));
            }
        });
    }
}

struct Peer {
    // Drop the instance before its borrowed testing system and network tables.
    tox: super::ToxHandle,
    inbox: Inbox,
    public_key: [u8; 32],
    _system: Box<ToxSystem>,
    _network: Box<Network>,
    _network_functions: Box<NetworkFunctions>,
}

impl Peer {
    fn new() -> Self {
        let mut error = 0;
        let mut options = super::ToxOptions::new(&mut error)
            .unwrap_or_else(|| panic!("loopback options: {error}"));
        assert_eq!(error, 0);
        options.apply_network(
            &super::NetworkSettings {
                ipv6_enabled: false,
                udp_enabled: true,
                local_discovery_enabled: false,
            },
            false,
        );
        // SAFETY: ToxOptions owns the live allocation.
        unsafe { super::tox_options_set_experimental_disable_dns(options.as_ptr(), true) };
        // SAFETY: The pinned native system and default table use the C layouts above.
        let mut system = Box::new(unsafe { tox_default_system() });
        let (base_object, mut network_functions) = unsafe {
            let base = system.network.as_ref().expect("default network");
            let functions = base.functions.as_ref().expect("default network functions");
            (base.object, Box::new(*functions))
        };
        assert!(network_functions.bind.is_some());
        network_functions.bind = Some(loopback_bind);
        let network = Box::new(Network {
            functions: &*network_functions,
            object: base_object,
        });
        system.network = &*network;
        let testing = ToxOptionsTesting {
            operating_system: &*system,
        };
        let mut testing_error = 0;
        let binds_before = LOOPBACK_BINDS.load(Ordering::Relaxed);
        // SAFETY: Options and the exact C layout are valid. The native
        // instance drops before the boxed system and network tables it borrows.
        let instance = std::ptr::NonNull::new(unsafe {
            tox_new_testing(options.as_ptr(), &mut error, &testing, &mut testing_error)
        })
        .unwrap_or_else(|| panic!("loopback tox_new: {error}"));
        let tox = super::ToxHandle {
            instance,
            tor_proxy_port: 0,
            profile_path: PathBuf::new(),
            cipher: None,
        };
        assert_eq!(error, 0);
        assert_eq!(testing_error, 0);
        assert!(
            LOOPBACK_BINDS.load(Ordering::Relaxed) > binds_before,
            "Tox socket must bind through the loopback-only adapter"
        );
        let mut public_key = [0; 32];
        // SAFETY: Tox owns a live instance and writes a 32-byte key. The
        // callbacks receive only our own Inbox during synchronous iteration.
        unsafe {
            tox_self_get_public_key(instance.as_ptr(), public_key.as_mut_ptr());
            super::tox_callback_friend_lossless_packet(instance.as_ptr(), Some(packet_callback));
            super::tox_callback_friend_message(instance.as_ptr(), Some(message_callback));
            super::tox_callback_friend_read_receipt(instance.as_ptr(), Some(delivery_callback));
        }
        Self {
            tox,
            inbox: Inbox::default(),
            public_key,
            _system: system,
            _network: network,
            _network_functions: network_functions,
        }
    }

    fn key(&self) -> String {
        self.public_key
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect()
    }

    fn connect(&self, peer: &Self) {
        let mut error = 0;
        let tox = self.tox.native();
        assert_eq!(tox.friend_add_norequest(&peer.public_key, &mut error), 0);
        assert_eq!(error, 0);
        let (dht_key, port) = peer.dht_endpoint();
        // No public bootstrap, TCP relay, multicast discovery, or DNS.
        assert!(tox.bootstrap(c"127.0.0.1", port, &dht_key, &mut error));
        assert_eq!(error, 0);
    }

    fn dht_endpoint(&self) -> ([u8; 32], u16) {
        let mut key = [0; 32];
        let mut error = 0;
        // SAFETY: The handle is live and the key and error output have the required sizes.
        let port = unsafe {
            tox_self_get_dht_id(self.tox.instance.as_ptr(), key.as_mut_ptr());
            tox_self_get_udp_port(self.tox.instance.as_ptr(), &mut error)
        };
        assert_eq!(error, 0);
        assert_ne!(port, 0);
        (key, port)
    }

    fn connected(&self) -> bool {
        let mut error = 0;
        self.tox.native().friend_connection_status(0, &mut error) != 0 && error == 0
    }

    fn iterate(&mut self) {
        // SAFETY: The fixture callbacks consume this uniquely borrowed Inbox
        // only during this synchronous iteration.
        unsafe {
            super::tox_iterate(self.tox.instance.as_ptr(), std::ptr::from_mut(&mut self.inbox).cast());
        }
    }

    fn packet(&self, bytes: &[u8]) -> bool {
        let mut error = 0;
        let accepted = self.tox.native().send_lossless_packet(0, bytes, &mut error);
        // SENDQ means the packet was not admitted. Pump both peers before
        // retrying it; every other error remains an immediate test failure.
        assert!(accepted || error == 7, "lossless packet: {error}");
        if accepted {
            assert_eq!(error, 0);
        }
        accepted
    }

    fn message(&self, text: &str) -> u32 {
        let mut error = 0;
        let receipt = self.tox.native().send_message(0, 0, text.as_bytes(), &mut error);
        assert_eq!(error, 0, "normal message queue");
        receipt
    }
}

fn pump_until(a: &mut Peer, b: &mut Peer, label: &str, ready: impl Fn(&Peer, &Peer) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready(a, b) {
        assert!(
            Instant::now() < deadline,
            "local transport deadline: {label}"
        );
        a.iterate();
        b.iterate();
        thread::sleep(Duration::from_millis(5));
    }
}

fn transmit_packet(from: &mut Peer, to: &mut Peer, bytes: &[u8]) -> Vec<u8> {
    assert!(to.inbox.packets.is_empty());
    // Admission and callback delivery share the existing 20-second budget.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut admitted = false;
    while !admitted || to.inbox.packets.is_empty() {
        assert!(
            Instant::now() < deadline,
            "local transport deadline: custom packet callback"
        );
        if !admitted {
            admitted = from.packet(bytes);
        }
        from.iterate();
        to.iterate();
        thread::sleep(Duration::from_millis(5));
    }
    let (friend, received) = to.inbox.packets.remove(0);
    assert_eq!(friend, 0);
    assert_eq!(received, bytes);
    received
}

fn negotiate(a: &mut Peer, b: &mut Peer, ea: &ChatProtocolEngine, eb: &ChatProtocolEngine) {
    let wire = transmit_packet(a, b, &ea.capability_packet());
    let IncomingPacket::Capability { acknowledgement } = eb.handle_packet(0, &wire).unwrap() else {
        panic!("capability expected")
    };
    let ack = transmit_packet(b, a, &acknowledgement);
    assert_eq!(
        ea.handle_packet(0, &ack).unwrap(),
        IncomingPacket::CapabilityAcknowledged
    );
    assert!(ea.supports(0) && eb.supports(0));
}

struct Disposable(PathBuf);
impl Disposable {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "kaigen-chat-loopback-{}",
            new_common_message_id().unwrap()
        ));
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        Self(root)
    }
}
impl Drop for Disposable {
    fn drop(&mut self) {
        // Only the uniquely created disposable tree may be removed.
        if self.0.parent() == Some(std::env::temp_dir().as_path())
            && self
                .0
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("kaigen-chat-loopback-"))
        {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

// Synthetic 32-byte contact identity shared by the managed-history fixtures.
const MANAGED_FRIEND_KEY: &str = "AABBAABBAABBAABBAABBAABBAABBAABBAABBAABBAABBAABBAABBAABBAABBAABB";

fn managed_message(id: &str, mine: bool, operation_id: Option<&str>) -> crate::ToxMessage {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "friend_number": 7,
        "friend_public_key": MANAGED_FRIEND_KEY,
        "text": "Synthetic durable message",
        "mine": mine,
        "timestamp": 100,
        "protocol_version": 1,
        "operation_id": operation_id
    }))
    .unwrap()
}

#[test]
fn managed_reaction_commit_survives_without_a_shutdown_checkpoint() {
    use crate::{chat_history_store as history, kai::KaiProfileVolume};
    use std::sync::{Arc, Mutex};

    let disposable = Disposable::new();
    let container = disposable.0.join("a/profile.kai");
    let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
    let data = volume.namespace_root().join("data");
    let history_path = data.join("chat-history.json");
    let id = new_common_message_id().unwrap();
    history::open_and_register(&history_path, Vec::new()).unwrap();
    let row = managed_message(&id, false, None);
    history::upsert_registered(&history_path, std::slice::from_ref(&row)).unwrap();
    volume.checkpoint(true).unwrap();
    let resident = Arc::new(Mutex::new(vec![row]));
    let engine = ChatProtocolEngine::new(&data).unwrap();
    let incoming = IncomingReaction {
        target_id: id.clone(),
        revision: 1,
        reactions: vec![ReactionCode::Heart, ReactionCode::Rocket],
        pq_required: false,
    };
    assert_eq!(
        engine
            .apply_incoming_reaction(7, MANAGED_FRIEND_KEY, &incoming, 101)
            .unwrap(),
        ReactionAckStatus::Applied
    );
    crate::persist_message_reaction_view(
        &history_path,
        true,
        &resident,
        7,
        MANAGED_FRIEND_KEY,
        &id,
        engine.reaction_view(7, MANAGED_FRIEND_KEY, &id).unwrap(),
    )
    .unwrap();
    crate::commit_chat_transaction(&history_path).unwrap();

    // Simulate abrupt termination. Normal volume Drop flushes dirty RAM and
    // would conceal a missing commit at the application-ACK boundary.
    history::unregister(&history_path);
    drop(engine);
    drop(resident);
    volume.discard();
    drop(volume);

    let reopened = KaiProfileVolume::open(container, None).unwrap();
    let data = reopened.namespace_root().join("data");
    let history_path = data.join("chat-history.json");
    let engine = ChatProtocolEngine::new(&data).unwrap();
    history::open_and_register(&history_path, Vec::new()).unwrap();
    assert_eq!(
        engine
            .apply_incoming_reaction(7, MANAGED_FRIEND_KEY, &incoming, 102)
            .unwrap(),
        ReactionAckStatus::Duplicate
    );
    let restored = history::find_message_registered(&history_path, 7, MANAGED_FRIEND_KEY, &id)
        .unwrap()
        .unwrap();
    let reactions = restored.reactions.unwrap();
    assert_eq!(reactions.peer, incoming.reactions);
    assert_eq!(reactions.peer_revision, 1);
    assert_eq!(
        engine.reaction_view(7, MANAGED_FRIEND_KEY, &id).unwrap().peer,
        reactions.peer
    );
    history::unregister(&history_path);
}

#[test]
fn managed_send_commit_preserves_operation_history_and_retry_queue_together() {
    use crate::{chat_history_store as history, kai::KaiProfileVolume};
    use std::sync::{Arc, Mutex};

    let disposable = Disposable::new();
    let container = disposable.0.join("a/profile.kai");
    let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
    let data = volume.namespace_root().join("data");
    let history_path = data.join("chat-history.json");
    let queue_path = data.join("pending-messages.json");
    history::open_and_register(&history_path, Vec::new()).unwrap();
    volume.checkpoint(true).unwrap();
    let engine = ChatProtocolEngine::new(&data).unwrap();
    let id = new_common_message_id().unwrap();
    let operation_id = "managed-send-operation";
    let row = managed_message(&id, true, Some(operation_id));
    let fingerprint = crate::send_payload_fingerprint(&row.text, &None, &[]).unwrap();
    engine
        .reserve_message_operation(
            7,
            MANAGED_FRIEND_KEY,
            operation_id,
            &fingerprint,
            &id,
            Some(1),
            false,
            100,
        )
        .unwrap();
    history::upsert_registered(&history_path, std::slice::from_ref(&row)).unwrap();
    let pending = Arc::new(Mutex::new(vec![crate::PendingToxMessage {
        id: id.clone(),
        friend_number: 7,
        friend_public_key: MANAGED_FRIEND_KEY.to_string(),
        text: row.text.clone(),
        timestamp: 100,
        next_offset: 0,
        wire_fragments: Vec::new(),
        wire_text: None,
    }]));
    crate::persist_pending_messages_required(&pending, &queue_path).unwrap();
    crate::commit_chat_transaction(&history_path).unwrap();
    history::unregister(&history_path);
    drop(engine);
    drop(pending);
    volume.discard();
    drop(volume);

    let reopened = KaiProfileVolume::open(container, None).unwrap();
    let data = reopened.namespace_root().join("data");
    let history_path = data.join("chat-history.json");
    let engine = ChatProtocolEngine::new(&data).unwrap();
    history::open_and_register(&history_path, Vec::new()).unwrap();
    let operation = engine
        .message_operation(7, MANAGED_FRIEND_KEY, operation_id, &fingerprint)
        .unwrap()
        .unwrap();
    assert_eq!(operation.message_id, id);
    assert_eq!(operation.delivery, "pending");
    let restored = history::find_message_registered(&history_path, 7, MANAGED_FRIEND_KEY, &id)
        .unwrap()
        .unwrap();
    assert_eq!(restored.operation_id.as_deref(), Some(operation_id));
    assert_eq!(restored.text, row.text);
    let queue: Vec<crate::PendingToxMessage> = serde_json::from_slice(
        &crate::profiles::read_file(&data.join("pending-messages.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].id, id);
    assert_eq!(queue[0].text, restored.text);
    history::unregister(&history_path);
}

#[test]
#[ignore = "Explicit 100k encrypted-container scale check; run separately from the fast library suite"]
fn managed_large_history_reopens_with_bounded_windows_and_full_search() {
    use crate::{chat_history_store as history, kai::KaiProfileVolume};

    let started = Instant::now();
    let disposable = Disposable::new();
    let container = disposable.0.join("a/profile.kai");
    let volume = KaiProfileVolume::create(container.clone(), None).unwrap();
    let history_path = volume.namespace_root().join("data/chat-history.json");
    let template = managed_message("unused", false, None);
    let rows = (0..100_000)
        .map(|index| {
            let mut row = template.clone();
            row.id = format!("{index:032x}");
            row.timestamp += index as u64;
            row.text = if [1_000, 50_000, 99_999].contains(&index) {
                format!("🧪 Needle {index}")
            } else if index % 87 == 0 {
                "Synthetic long text with Unicode Пример 🧪. ".repeat(100)
            } else {
                format!("Synthetic history row {index}")
            };
            row
        })
        .collect();
    let working = history::open_and_register(&history_path, rows).unwrap();
    assert!(working.len() <= 500);
    drop(working);
    let migration_ms = started.elapsed().as_millis();
    let checkpoint_started = Instant::now();
    crate::commit_chat_transaction(&history_path).unwrap();
    let checkpoint_ms = checkpoint_started.elapsed().as_millis();
    let container_bytes = std::fs::metadata(&container).unwrap().len();
    history::unregister(&history_path);
    volume.discard();
    drop(volume);

    let reopen_started = Instant::now();
    let reopened = KaiProfileVolume::open(container, None).unwrap();
    let history_path = reopened.namespace_root().join("data/chat-history.json");
    let working = history::open_and_register(&history_path, Vec::new()).unwrap();
    assert!(working.len() <= 500);
    drop(working);
    let reopen_ms = reopen_started.elapsed().as_millis();
    let target_id = format!("{:032x}", 1_000);
    let window =
        history::window_registered(&history_path, 7, MANAGED_FRIEND_KEY, Some(0), None, Some(&target_id))
            .unwrap();
    assert_eq!(window.total, 100_000);
    assert_eq!(window.target_index, Some(1_000));
    assert!(window.messages.len() <= 1_000);
    assert!(window.messages.iter().any(|row| row.id == target_id));
    assert!(serde_json::to_vec(&window.messages).unwrap().len() < 2 * 1024 * 1024);
    let search_started = Instant::now();
    let matches =
        history::search_registered(&history_path, 7, MANAGED_FRIEND_KEY, "Needle", None, 100).unwrap();
    let search_ms = search_started.elapsed().as_millis();
    assert!(matches.next_cursor.is_none());
    assert_eq!(
        matches
            .matches
            .iter()
            .map(|item| item.index)
            .collect::<Vec<_>>(),
        vec![99_999, 50_000, 1_000]
    );
    assert!(matches
        .matches
        .iter()
        .all(|item| item.start == 3 && item.end == 9));
    history::unregister(&history_path);
    eprintln!("CHAT_MANAGED_100K_PASS rows=100000 migration_ms={migration_ms} checkpoint_ms={checkpoint_ms} reopen_ms={reopen_ms} search_ms={search_ms} container_bytes={container_bytes} elapsed_ms={}", started.elapsed().as_millis());
}

#[test]
fn real_two_tox_clients_deliver_chat_fragments_reactions_and_file_card_ack() {
    let started = Instant::now();
    let disposable = Disposable::new();
    let (a_dir, b_dir) = (disposable.0.join("a"), disposable.0.join("b"));
    let (mut a, mut b) = (Peer::new(), Peer::new());
    a.connect(&b);
    b.connect(&a);
    pump_until(&mut a, &mut b, "friend connection", |a, b| {
        a.connected() && b.connected()
    });
    let (a_key, b_key) = (a.key(), b.key());
    let ea = ChatProtocolEngine::new(&a_dir).unwrap();
    let eb = ChatProtocolEngine::new(&b_dir).unwrap();
    negotiate(&mut a, &mut b, &ea, &eb);

    let quote = ChatQuote {
        message_id: Some(new_common_message_id().unwrap()),
        author: "peer".into(),
        text: "Цитата\nвторая строка".into(),
        legacy: false,
    };
    let envelope = MessageEnvelope {
        version: VERSION,
        id: new_common_message_id().unwrap(),
        text: format!("Hello 😀 {}", "длинное сообщение ".repeat(170)),
        quote: Some(quote.clone()),
        formatting: vec![TextFormatSpan {
            kind: TextFormatKind::Bold,
            offset_utf16: 0,
            length_utf16: 5,
        }],
        pq_protected: false,
    };
    let fragments = encode_message_fragments(&envelope).unwrap();
    assert!(fragments.len() > 1);
    let receipts: Vec<_> = fragments
        .iter()
        .map(|fragment| a.message(fragment))
        .collect();
    pump_until(
        &mut a,
        &mut b,
        "message fragments and client delivery",
        |a, b| {
            b.inbox.messages.len() == fragments.len()
                && receipts
                    .iter()
                    .all(|id| a.inbox.client_delivery.contains(&(0, *id)))
        },
    );
    let mut completed = Vec::new();
    for (friend, text) in b.inbox.messages.drain(..) {
        assert_eq!(friend, 0);
        if let Some(message) = eb.accept_message_fragment(0, &a_key, &text, 1_000).unwrap() {
            completed.push(message);
        }
    }
    assert_eq!(completed, vec![envelope.clone()]);

    let pending = ea
        .update_local_reactions(
            0,
            &b_key,
            &envelope.id,
            vec![ReactionCode::Heart, ReactionCode::Rocket],
            None,
            false,
            1_001,
        )
        .unwrap();
    assert_eq!(pending.delivery, ReactionDelivery::Pending);
    let due = ea.due_reactions(Instant::now());
    assert_eq!(due.len(), 1);
    let reaction_wire = encode_reaction_packet(&due[0]).unwrap();
    let received = transmit_packet(&mut a, &mut b, &reaction_wire);
    let IncomingPacket::Reaction(reaction) = eb.handle_packet(0, &received).unwrap() else {
        panic!("reaction expected")
    };
    assert_eq!(
        eb.apply_incoming_reaction(0, &a_key, &reaction, 1_001)
            .unwrap(),
        ReactionAckStatus::Applied
    );
    // Simulate a lost application ACK followed by a receiver restart.
    drop(eb);
    let eb = ChatProtocolEngine::new(&b_dir).unwrap();
    negotiate(&mut a, &mut b, &ea, &eb);
    let replay = transmit_packet(&mut a, &mut b, &reaction_wire);
    let IncomingPacket::Reaction(replayed) = eb.handle_packet(0, &replay).unwrap() else {
        panic!("reaction replay expected")
    };
    let status = eb
        .apply_incoming_reaction(0, &a_key, &replayed, 1_002)
        .unwrap();
    assert_eq!(status, ReactionAckStatus::Duplicate);
    let ack = transmit_packet(
        &mut b,
        &mut a,
        &encode_reaction_ack_packet(&replayed, status).unwrap(),
    );
    let IncomingPacket::ReactionAck(ack) = ea.handle_packet(0, &ack).unwrap() else {
        panic!("reaction ACK expected")
    };
    ea.acknowledge_reaction(0, &b_key, &ack).unwrap();
    assert_eq!(
        ea.reaction_view(0, &b_key, &envelope.id).unwrap().delivery,
        ReactionDelivery::Delivered
    );
    assert_eq!(
        eb.reaction_view(0, &a_key, &envelope.id).unwrap().peer,
        vec![ReactionCode::Heart, ReactionCode::Rocket]
    );

    let fa = cards::FileCardEngine::new(&a_dir).unwrap();
    let fb = cards::FileCardEngine::new(&b_dir).unwrap();
    let offer = fa
        .offer_for_send(
            0,
            &b_key,
            &new_common_message_id().unwrap(),
            "image.png",
            1_024,
        )
        .unwrap();
    let offer_wire = cards::encode_offer(&offer).unwrap();
    let received = transmit_packet(&mut a, &mut b, &offer_wire);
    let Some(cards::IncomingFileCardPacket::Offer(received)) = cards::decode_packet(&received)
    else {
        panic!("file-card offer expected")
    };
    let (binding, status) = fb.apply_incoming_offer(0, &a_key, &received).unwrap();
    assert_eq!(status, cards::FileCardAckStatus::Applied);
    assert_eq!(binding.message_id, offer.message_id);
    assert_eq!(binding.transfer_id, offer.transfer_id);
    drop(fb);
    let fb = cards::FileCardEngine::new(&b_dir).unwrap();
    let received = transmit_packet(&mut a, &mut b, &offer_wire);
    let Some(cards::IncomingFileCardPacket::Offer(received)) = cards::decode_packet(&received)
    else {
        panic!("file-card replay expected")
    };
    let (_, status) = fb.apply_incoming_offer(0, &a_key, &received).unwrap();
    assert_eq!(status, cards::FileCardAckStatus::Duplicate);
    let ack = transmit_packet(
        &mut b,
        &mut a,
        &cards::encode_ack(&cards::ack_for_offer(&received, status)).unwrap(),
    );
    let Some(cards::IncomingFileCardPacket::Ack(ack)) = cards::decode_packet(&ack) else {
        panic!("file-card ACK expected")
    };
    assert_eq!(fa.acknowledge_offer(0, &b_key, &ack).unwrap(), status);

    // The compatibility boundary is ordinary plaintext, not a KCH envelope.
    // This proves the bidirectional wire format, not a live qTox UI session.
    let wire_quote = qtox_quote_fallback(&quote, "Ответ");
    let receipt = b.message(&wire_quote);
    pump_until(
        &mut b,
        &mut a,
        "plaintext quote delivery",
        |sender, receiver| {
            !receiver.inbox.messages.is_empty()
                && sender.inbox.client_delivery.contains(&(0, receipt))
        },
    );
    let (_, received) = a.inbox.messages.remove(0);
    let (parsed, body) = parse_qtox_quote(&received).unwrap();
    assert_eq!(parsed.text, quote.text);
    assert_eq!(body, "Ответ");
    assert!(parsed.legacy && parsed.message_id.is_none());
    eprintln!("CHAT_LOOPBACK_PASS clients=2 endpoint=127.0.0.1 fragments={} delivery=client-only reaction=lost-ack-restart file-card=lost-ack-restart quote=plaintext elapsed_ms={}", fragments.len(), started.elapsed().as_millis());
}
