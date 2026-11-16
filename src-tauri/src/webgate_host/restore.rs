//! Bounded startup reconnect work. Delayed retries return their worker slot.
use super::*;
use std::{
    path::PathBuf,
    sync::Weak,
    thread,
    time::{Duration, Instant},
};

struct Pending {
    id: String,
    job: Arc<persistence::RestoreJob>,
    ready: Instant,
    attempts: u32,
}

#[derive(Default)]
pub(super) struct RestorePool {
    pending: Mutex<Vec<Pending>>,
    pub(super) wake: Condvar,
    stopped: AtomicBool,
}

impl RestorePool {
    pub(super) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        self.wake.notify_all();
    }

    pub(super) fn retry_now(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            for item in pending.iter_mut() {
                item.ready = Instant::now();
            }
        }
        self.wake.notify_all();
    }

    fn put(&self, item: Pending) {
        if let Ok(mut pending) = self.pending.lock() {
            if !self.stopped.load(Ordering::Acquire) {
                pending.push(item);
            }
        }
        self.wake.notify_one();
    }

    fn next(&self) -> Option<Pending> {
        let mut pending = self.pending.lock().ok()?;
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return None;
            }
            pending.retain(|item| !item.job.cancelled());
            if let Some((index, due)) = pending
                .iter()
                .enumerate()
                .min_by_key(|(_, item)| item.ready)
                .map(|(index, item)| (index, item.ready))
            {
                let now = Instant::now();
                if due <= now {
                    return Some(pending.swap_remove(index));
                }
                pending = self
                    .wake
                    .wait_timeout(pending, due.saturating_duration_since(now))
                    .ok()?
                    .0;
            } else {
                pending = self.wake.wait(pending).ok()?;
            }
        }
    }
}

impl WebgateHost {
    pub(super) fn start_restore_pool(
        self: &Arc<Self>,
        policy: TransportPolicy,
        cache_root: &Path,
    ) -> Result<(), String> {
        let records = self.export_connections()?;
        if !records
            .profiles
            .iter()
            .any(|record| !record.locked && self.get(&record.id).is_none())
        {
            return Ok(());
        }
        let mut current = self
            .restore_pool
            .lock()
            .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
        if self.closing.load(Ordering::Acquire) {
            return Err("WEBGATE_CLOSED".into());
        }
        let pool = match current.as_ref() {
            Some(pool) => Arc::clone(pool),
            None => {
                let pool = Arc::new(RestorePool::default());
                for _ in 0..4 {
                    let worker_pool = Arc::clone(&pool);
                    let weak = Arc::downgrade(self);
                    let policy = policy.clone();
                    let root = cache_root.to_owned();
                    if thread::Builder::new()
                        .name("webgate-restore".into())
                        .spawn(move || restore_worker(weak, worker_pool, policy, root))
                        .is_err()
                    {
                        pool.stop();
                        return Err("WEBGATE_WORKER_UNAVAILABLE".into());
                    }
                }
                *current = Some(Arc::clone(&pool));
                pool
            }
        };
        drop(current);
        for record in &records.profiles {
            if record.locked || self.get(&record.id).is_some() {
                continue;
            }
            let mut jobs = self
                .restore_jobs
                .lock()
                .map_err(|_| "WEBGATE_STATE_UNAVAILABLE")?;
            if jobs.contains_key(&record.id) {
                continue;
            }
            let job = Arc::new(persistence::RestoreJob::default());
            jobs.insert(record.id.clone(), Arc::clone(&job));
            pool.put(Pending {
                id: record.id.clone(),
                job,
                ready: Instant::now(),
                attempts: 0,
            });
        }
        Ok(())
    }
}

fn restore_worker(
    weak: Weak<WebgateHost>,
    pool: Arc<RestorePool>,
    policy: TransportPolicy,
    root: PathBuf,
) {
    while let Some(mut pending) = pool.next() {
        let Some(host) = weak.upgrade() else { return };
        let should_attempt = !pending.job.cancelled()
            && !host.closing.load(Ordering::Acquire)
            && host.get(&pending.id).is_none();
        let mut retry = false;
        if should_attempt {
            if let Some(record) = host.stored(&pending.id).filter(|record| !record.locked) {
                let result = host.connect_at(
                    pending.id.clone(),
                    record.card.clone(),
                    &record.password,
                    policy.clone(),
                    &root,
                    Some(&record),
                );
                if !pending.job.cancelled() && !host.closing.load(Ordering::Acquire) {
                    match result {
                        Ok(_) => host.notify_restore(&pending.id, "connection-ready", None),
                        Err(error) if error != "WEBGATE_RESTORE_SUPERSEDED" => {
                            let code = persistence::safe_error(&error);
                            if let Ok(mut errors) = host.restore_errors.lock() {
                                errors.insert(pending.id.clone(), code.clone());
                            }
                            host.notify_restore(&pending.id, "connection-unavailable", Some(&code));
                            retry = persistence::retryable(&code);
                        }
                        Err(_) => {}
                    }
                }
            }
        }
        if retry && !pending.job.cancelled() {
            pending.attempts = pending.attempts.saturating_add(1);
            pending.ready =
                Instant::now() + Duration::from_secs((1_u64 << pending.attempts.min(6)).min(60));
            pool.put(pending);
        } else if let Ok(mut jobs) = host.restore_jobs.lock() {
            if jobs
                .get(&pending.id)
                .is_some_and(|current| Arc::ptr_eq(current, &pending.job))
            {
                jobs.remove(&pending.id);
            }
        }
    }
}
