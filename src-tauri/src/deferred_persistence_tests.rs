//! Controlled legacy-order counterexamples and durable FIFO readbacks.
//! Every filesystem path belongs to a newly created disposable test directory.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

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
    verify_ordered_history_clear(true);
}

#[test]
fn ordered_whole_history_clear_survives_old_and_new_snapshots() {
    verify_ordered_history_clear(false);
}
