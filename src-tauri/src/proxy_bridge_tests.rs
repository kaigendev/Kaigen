use super::{ProxyBridge, ProxySettings};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::ops::{Deref, DerefMut};
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::thread;
use std::time::{Duration, Instant};

const LIMIT: Duration = Duration::from_secs(3);
const FRAME_DELAY: Duration = Duration::from_millis(120);

struct FixtureStream(TcpStream);

impl Deref for FixtureStream {
    type Target = TcpStream;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for FixtureStream {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for FixtureStream {
    fn drop(&mut self) {
        // Release both relay directions, including cloned production handles,
        // when any fixture assertion or bounded read fails.
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

fn bounded_stream(stream: TcpStream) -> FixtureStream {
    stream.set_nonblocking(false).unwrap();
    stream.set_read_timeout(Some(LIMIT)).unwrap();
    stream.set_write_timeout(Some(LIMIT)).unwrap();
    FixtureStream(stream)
}

fn accept_fixture(listener: TcpListener) -> FixtureStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + LIMIT;
    loop {
        match listener.accept() {
            Ok((stream, _)) => return bounded_stream(stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "fixture accept deadline");
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => panic!("fixture accept failed"),
        }
    }
}

fn with_bridge(mode: &str, exercise: impl FnOnce(&ProxyBridge, TcpListener)) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let bridge = ProxyBridge::start(settings(&listener, mode)).unwrap();
    // Scoped fixture threads join before this returns, including on panic.
    let outcome = catch_unwind(AssertUnwindSafe(|| exercise(&bridge, listener)));
    bridge.stop();
    let deadline = Instant::now() + LIMIT;
    // Only the accept worker owns a clone. Its release proves that the worker
    // has left the listener loop; do not open extra connections during cleanup.
    while std::sync::Arc::strong_count(&bridge.running) != 1 {
        assert!(
            Instant::now() < deadline,
            "adapter accept worker did not stop"
        );
        thread::sleep(Duration::from_millis(5));
    }
    if let Err(panic) = outcome {
        resume_unwind(panic);
    }
}

fn settings(listener: &TcpListener, mode: &str) -> ProxySettings {
    ProxySettings {
        mode: mode.into(),
        host: "127.0.0.1".into(),
        port: listener.local_addr().unwrap().port(),
        username: "synthetic".into(),
        password: "fixture".into(),
    }
}

fn authenticate_fixture(upstream: &mut TcpStream, accepted: bool) {
    let mut greeting = [0; 4];
    upstream.read_exact(&mut greeting).unwrap();
    assert_eq!(greeting, [5, 2, 0, 2]);
    upstream.write_all(&[5, 2]).unwrap();
    let mut header = [0; 2];
    upstream.read_exact(&mut header).unwrap();
    assert_eq!(header, [1, 9]);
    let mut username = [0; 9];
    upstream.read_exact(&mut username).unwrap();
    assert_eq!(&username, b"synthetic");
    let mut pass_length = [0];
    upstream.read_exact(&mut pass_length).unwrap();
    assert_eq!(pass_length, [7]);
    let mut password = [0; 7];
    upstream.read_exact(&mut password).unwrap();
    assert_eq!(&password, b"fixture");
    upstream.write_all(&[1, u8::from(!accepted)]).unwrap();
}

#[test]
fn authenticated_socks_accepts_delayed_connect_and_relay_frames() {
    with_bridge("socks5", |bridge, upstream_listener| {
        thread::scope(|scope| {
            let fixture = scope.spawn(move || {
                let mut upstream = accept_fixture(upstream_listener);
                authenticate_fixture(&mut upstream, true);
                let mut request = [0; 10];
                upstream.read_exact(&mut request).unwrap();
                assert_eq!(request, [5, 1, 0, 1, 127, 0, 0, 1, 0, 1]);
                upstream
                    .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 1])
                    .unwrap();
                let mut payload = [0; 4];
                upstream.read_exact(&mut payload).unwrap();
                assert_eq!(&payload, b"ping");
                thread::sleep(FRAME_DELAY);
                upstream.write_all(b"pong").unwrap();
                upstream.shutdown(Shutdown::Write).unwrap();
            });
            let mut client =
                bounded_stream(TcpStream::connect(("127.0.0.1", bridge.port)).unwrap());
            client.write_all(&[5, 1, 0]).unwrap();
            let mut selected = [0; 2];
            client.read_exact(&mut selected).unwrap();
            assert_eq!(selected, [5, 0]);
            // The native Tox client sends CONNECT on a later iterate after selection.
            thread::sleep(FRAME_DELAY);
            client.write_all(&[5, 1, 0, 1, 127, 0, 0, 1, 0, 1]).unwrap();
            let mut response = [0; 10];
            client.read_exact(&mut response).unwrap();
            assert_eq!(response, [5, 0, 0, 1, 127, 0, 0, 1, 0, 1]);
            thread::sleep(FRAME_DELAY);
            client.write_all(b"ping").unwrap();
            client.shutdown(Shutdown::Write).unwrap();
            let mut reply = [0; 4];
            client.read_exact(&mut reply).unwrap();
            assert_eq!(&reply, b"pong");
            drop(client);
            fixture.join().unwrap();
        });
    });
}

#[test]
fn authenticated_socks_rejection_does_not_report_local_success() {
    with_bridge("socks5", |bridge, upstream_listener| {
        thread::scope(|scope| {
            let fixture = scope.spawn(move || {
                let mut upstream = accept_fixture(upstream_listener);
                authenticate_fixture(&mut upstream, false);
                let mut data = [0; 1];
                assert!(matches!(upstream.read(&mut data), Ok(0)));
            });
            let mut client =
                bounded_stream(TcpStream::connect(("127.0.0.1", bridge.port)).unwrap());
            client.write_all(&[5, 1, 0]).unwrap();
            let mut selected = [0; 2];
            assert!(client.read_exact(&mut selected).is_err());
            assert_ne!(selected, [5, 0]);
            drop(client);
            fixture.join().unwrap();
        });
    });
}

#[test]
fn authenticated_http_accepts_fragmented_headers_and_delayed_relay() {
    with_bridge("http", |bridge, upstream_listener| {
        thread::scope(|scope| {
            let fixture = scope.spawn(move || {
            let mut upstream = accept_fixture(upstream_listener);
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < 1024);
                let mut byte = [0];
                upstream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert_eq!(request, b"CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\nProxy-Authorization: Basic c3ludGhldGljOmZpeHR1cmU=\r\n\r\n");
            upstream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
            let mut payload = [0; 4];
            upstream.read_exact(&mut payload).unwrap();
            assert_eq!(&payload, b"ping");
            thread::sleep(FRAME_DELAY);
            upstream.write_all(b"pong").unwrap();
            upstream.shutdown(Shutdown::Write).unwrap();
        });
            let mut client =
                bounded_stream(TcpStream::connect(("127.0.0.1", bridge.port)).unwrap());
            client
                .write_all(b"CONNECT fixture.invalid:443 HTTP/1.1\r\n")
                .unwrap();
            thread::sleep(FRAME_DELAY);
            client
                .write_all(b"Host: fixture.invalid:443\r\n\r\n")
                .unwrap();
            let mut response = [0; 19];
            client.read_exact(&mut response).unwrap();
            assert_eq!(&response, b"HTTP/1.1 200 OK\r\n\r\n");
            thread::sleep(FRAME_DELAY);
            client.write_all(b"ping").unwrap();
            client.shutdown(Shutdown::Write).unwrap();
            let mut reply = [0; 4];
            client.read_exact(&mut reply).unwrap();
            assert_eq!(&reply, b"pong");
            drop(client);
            fixture.join().unwrap();
        });
    });
}
