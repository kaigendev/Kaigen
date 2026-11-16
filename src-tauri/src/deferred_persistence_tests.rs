//! Controlled legacy-order counterexamples and durable FIFO readbacks.
//! Every filesystem path belongs to a newly created disposable test directory.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

/// Keep deliberate global-writer stalls inside one instance of the real test binary.
/// Returns true only in the parent after the exact child case has passed.
pub(super) fn run_with_isolated_writers(case: &str) -> bool {
    use std::io::Read;
    use std::process::{Child, Command, Stdio};

    const MARKER: &str = "KAIGEN_WRITER_ISOLATION_CASE";
    const EXECUTABLE: &str = "KAIGEN_WRITER_ISOLATION_EXE";
    const LOG_LIMIT: u64 = 16 * 1024 * 1024;
    static BODY_ENTERED: AtomicBool = AtomicBool::new(false);
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let arguments = [
        "--exact",
        case,
        "--nocapture",
        "--test-threads=1",
        "--color",
        "never",
    ];
    let body_marker = format!("KAIGEN_WRITER_BODY_ENTERED:{case}");
    if let Some(selected) = std::env::var_os(MARKER) {
        assert_eq!(
            selected.as_os_str(),
            std::ffi::OsStr::new(case),
            "wrong isolated case"
        );
        assert_eq!(
            std::env::var_os(EXECUTABLE).map(PathBuf::from),
            Some(executable),
            "isolated case executable changed"
        );
        assert_eq!(
            std::env::args().skip(1).collect::<Vec<_>>(),
            arguments
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
        );
        assert!(
            !BODY_ENTERED.swap(true, Ordering::SeqCst),
            "body entered twice"
        );
        eprintln!("{body_marker}");
        return false;
    }
    assert!(
        std::env::var_os(EXECUTABLE).is_none(),
        "incomplete isolation marker"
    );

    let directory = std::env::temp_dir().join(format!(
        "kaigen-writer-isolation-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir(&directory).unwrap();
    let stdout_path = directory.join("stdout.log");
    let stderr_path = directory.join("stderr.log");
    let mut command = Command::new(&executable);
    command
        .args(arguments)
        .env(MARKER, case)
        .env(EXECUTABLE, &executable)
        .stdin(Stdio::null())
        .stdout(fs::File::create(&stdout_path).unwrap())
        .stderr(fs::File::create(&stderr_path).unwrap());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedChild(command.spawn().expect("start exact writer-isolation child"));
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        // Only an outer child-process watchdog; existing scenario deadlines are unchanged.
        if started.elapsed() >= Duration::from_secs(120) {
            timed_out = true;
            let _ = child.0.kill();
            break child.0.wait().unwrap();
        }
        thread::sleep(Duration::from_millis(10));
    };
    let read_log = |path: &Path| {
        let file = fs::File::open(path).unwrap();
        let within_limit = file.metadata().unwrap().len() <= LOG_LIMIT;
        let mut bytes = Vec::new();
        file.take(LOG_LIMIT).read_to_end(&mut bytes).unwrap();
        (String::from_utf8_lossy(&bytes).into_owned(), within_limit)
    };
    let (stdout, stdout_bounded) = read_log(&stdout_path);
    let (stderr, stderr_bounded) = read_log(&stderr_path);
    let summaries = stdout
        .lines()
        .filter(|line| line.starts_with("test result: "))
        .collect::<Vec<_>>();
    let exact_success = summaries.len() == 1
        && summaries[0].starts_with("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; ");
    let body_entries = stderr.lines().filter(|line| *line == body_marker).count();
    let passed = !timed_out
        && status.success()
        && stdout_bounded
        && stderr_bounded
        && exact_success
        && body_entries == 1;
    fs::write(
        directory.join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "case": case,
            "executable": executable,
            "arguments": arguments,
            "exitCode": status.code(),
            "timedOut": timed_out,
            "bodyEntries": body_entries,
            "exactOnePassed": exact_success,
            "logsWithinReadLimit": stdout_bounded && stderr_bounded,
            "stdout": stdout_path,
            "stderr": stderr_path,
            "passed": passed,
        }))
        .unwrap(),
    )
    .unwrap();
    if !passed {
        let tail = |text: &str| {
            let bytes = text.as_bytes();
            String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(8192)..]).into_owned()
        };
        panic!(
            "isolated writer case {case} failed; raw logs: {}\nstdout tail:\n{}\nstderr tail:\n{}",
            directory.display(),
            tail(&stdout),
            tail(&stderr)
        );
    }
    eprintln!(
        "isolated writer case {case} passed; raw logs: {}",
        directory.display()
    );
    true
}

struct TestDirectory {
    root: PathBuf,
    history: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "kaigen-deferred-persistence-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".owned-deferred-persistence-test"), b"1").unwrap();
        let root = root.canonicalize().unwrap();
        Self {
            history: root.join("history.json"),
            root,
        }
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = flush_deferred_profile_writes();
        chat_history_store::unregister(&self.history);
        let parent_is_temp =
            std::env::temp_dir().canonicalize().ok().as_deref() == self.root.parent();
        if parent_is_temp && self.root.join(".owned-deferred-persistence-test").is_file() {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

/// Pause first, then enqueue the stale snapshot. Other parallel tests cannot
/// split a Write/Pause pair and accidentally let that snapshot commit early.
struct PausedWriter(Option<SyncSender<()>>);

impl PausedWriter {
    fn atomic() -> Self {
        let (entered, acknowledged) = mpsc::sync_channel(0);
        let (release, held) = mpsc::sync_channel(0);
        atomic_write_sender()
            .send(AtomicWriteRequest::PauseBeforeCommit {
                entered,
                release: held,
            })
            .unwrap();
        acknowledged.recv_timeout(Duration::from_secs(5)).unwrap();
        Self(Some(release))
    }

    fn history() -> Self {
        let (entered, acknowledged) = mpsc::sync_channel(0);
        let (release, held) = mpsc::sync_channel(0);
        history_persist_sender()
            .send(HistoryPersistRequest::PauseBeforeCommit {
                entered,
                release: held,
            })
            .unwrap();
        acknowledged.recv_timeout(Duration::from_secs(5)).unwrap();
        Self(Some(release))
    }

    fn resume(mut self) {
        self.0.take().unwrap().send(()).unwrap();
    }
}

impl Drop for PausedWriter {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}

fn history_row(id: u64, friend_number: u32, friend_public_key: &str) -> ToxMessage {
    serde_json::from_value(serde_json::json!({
        "id": format!("{id:032x}"),
        "friend_number": friend_number,
        "friend_public_key": friend_public_key,
        "text": "Synthetic retained history row",
        "mine": true,
        "timestamp": id,
        "delivery": "delivered",
        "pq_protected": true,
    }))
    .unwrap()
}

#[test]
fn ordered_friend_cache_write_preserves_revoked_authorization() {
    if run_with_isolated_writers(
        "deferred_persistence_tests::ordered_friend_cache_write_preserves_revoked_authorization",
    ) {
        return;
    }
    for ordered in [false, true] {
        let directory = TestDirectory::new();
        let path = directory.root.join("friend-profiles.json");
        let key = "A".repeat(64);
        let cache = Mutex::new(HashMap::from([(
            key.clone(),
            CachedFriendProfile {
                name: "Synthetic contact".into(),
                authorized: true,
                ..CachedFriendProfile::default()
            },
        )]));
        let paused = PausedWriter::atomic();
        {
            let cache = cache.lock().unwrap();
            atomic_write_sender()
                .try_send(AtomicWriteRequest::Write {
                    path: path.clone(),
                    bytes: serde_json::to_vec(&*cache).unwrap(),
                })
                .unwrap();
        }

        let completed = {
            let mut cache = cache.lock().unwrap();
            cache.get_mut(&key).unwrap().authorized = false;
            if ordered {
                Some(enqueue_friend_cache_write_required(&cache, &path).unwrap())
            } else {
                // Reproduce the former direct-write path as a control.
                atomic_write(&path, &serde_json::to_vec(&*cache).unwrap()).unwrap();
                None
            }
        };
        if let Some(completed) = completed.as_ref() {
            assert!(matches!(
                completed.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
        }
        paused.resume();
        if let Some(completed) = completed {
            wait_for_atomic_write(completed).unwrap();
        }
        flush_deferred_profile_writes().unwrap();

        let reopened: HashMap<String, CachedFriendProfile> =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            reopened[&key].authorized, !ordered,
            "only the legacy direct-write control may revive authorization",
        );
    }
}

fn verify_ordered_history_clear(contact_only: bool) {
    for ordered in [false, true] {
        let directory = TestDirectory::new();
        let first_key = "A".repeat(64);
        let second_key = "B".repeat(64);
        let initial = vec![
            history_row(1, 7, &first_key),
            history_row(2, 8, &second_key),
        ];
        chat_history_store::open_and_register(&directory.history, initial.clone()).unwrap();
        let messages = Arc::new(Mutex::new(initial));
        let enabled = Arc::new(AtomicBool::new(true));
        let target = contact_only.then_some((7, first_key.as_str()));

        let paused = PausedWriter::history();
        persist_tox_history(&messages, &directory.history, &enabled);
        let completed = {
            let mut messages = messages.lock().unwrap();
            if contact_only {
                messages.retain(|message| message.friend_number != 7);
            } else {
                messages.clear();
            }
            if ordered {
                Some(enqueue_registered_history_clear_required(&directory.history, target).unwrap())
            } else {
                // This direct clear used to race the already captured snapshot.
                chat_history_store::clear_registered(&directory.history, target).unwrap();
                None
            }
        };
        // A subsequent ordinary snapshot must keep the clear result as well.
        persist_tox_history(&messages, &directory.history, &enabled);
        if let Some(completed) = completed.as_ref() {
            assert!(matches!(
                completed.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
        }
        paused.resume();
        if let Some(completed) = completed {
            wait_for_registered_history_write(completed).unwrap();
        }
        flush_deferred_profile_writes().unwrap();
        assert!(chat_history_store::unregister(&directory.history));
        let reopened =
            chat_history_store::open_and_register(&directory.history, Vec::new()).unwrap();
        let expected_count = if ordered {
            usize::from(contact_only)
        } else {
            2
        };
        assert_eq!(reopened.len(), expected_count);
        if ordered && contact_only {
            assert_eq!(
                reopened[0].friend_number, 8,
                "the other contact must survive"
            );
            assert_eq!(reopened[0].delivery, "delivered");
        }
    }
}

#[test]
fn ordered_contact_history_clear_survives_old_and_new_snapshots() {
    if run_with_isolated_writers(
        "deferred_persistence_tests::ordered_contact_history_clear_survives_old_and_new_snapshots",
    ) {
        return;
    }
    verify_ordered_history_clear(true);
}

#[test]
fn ordered_whole_history_clear_survives_old_and_new_snapshots() {
    if run_with_isolated_writers(
        "deferred_persistence_tests::ordered_whole_history_clear_survives_old_and_new_snapshots",
    ) {
        return;
    }
    verify_ordered_history_clear(false);
}
