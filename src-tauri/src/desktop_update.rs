//! Official release updates. UI accepts an opaque checked candidate, never a URL.
mod helper_types;
mod network;
mod package;
mod platform;
mod releases;
const LOCK_NAME: &str = ".kaigen-update-lock";

use helper_types::{Entry, Job, Layout, Mode};
use network::Network;
use releases::{Asset, Release, Version, REPOSITORY_API};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CandidateView {
    pub id: String,
    pub version: String,
    pub release_name: String,
    pub size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateView {
    pub enabled: bool,
    pub last_checked_at: Option<u64>,
    pub candidate: Option<CandidateView>,
    pub phase: String,
    pub job_id: Option<String>,
    pub downloaded_bytes: u64,
    pub download_total: u64,
    pub install_completed: u64,
    pub install_total: u64,
    pub blocking: bool,
    pub cancellable: bool,
    pub error_code: Option<String>,
    pub retryable: bool,
}

#[derive(Clone)]
struct Candidate {
    view: CandidateView,
    release_id: u64,
    tag: String,
    asset: Asset,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    last_attempt_at: Option<u64>,
    last_successful_check_at: Option<u64>,
}
#[derive(Deserialize, Serialize)]
struct LockOwner {
    nonce: String,
    pid: u32,
    identity: u64,
}
struct State {
    view: UpdateView,
    candidate: Option<Candidate>,
    metadata: Metadata,
    job: Option<PathBuf>,
}

pub(crate) struct UpdateManager {
    state: Mutex<State>,
    layout: Result<Layout, String>,
    metadata_path: PathBuf,
    network: Network,
    stopped: AtomicBool,
    busy: AtomicBool,
    started: AtomicBool,
    committed: AtomicBool,
    native_ready: AtomicBool,
    renderer_ready: AtomicBool,
    acknowledgement_gate: Mutex<()>,
    wake: Condvar,
    wake_gate: Mutex<()>,
    emit: Arc<dyn Fn(UpdateView) + Send + Sync>,
    request_exit: Arc<dyn Fn() + Send + Sync>,
    save_enabled: Arc<dyn Fn(bool) -> Result<(), String> + Send + Sync>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallStarted {
    pub job_id: String,
}

impl UpdateManager {
    pub(crate) fn new(
        data_dir: PathBuf,
        portable_root: PathBuf,
        policy: crate::webgate::TransportPolicy,
        enabled: bool,
        emit: Arc<dyn Fn(UpdateView) + Send + Sync>,
        request_exit: Arc<dyn Fn() + Send + Sync>,
        save_enabled: Arc<dyn Fn(bool) -> Result<(), String> + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let metadata_path = data_dir.join("desktop-update.json");
        let metadata = bounded_read(&metadata_path, 64 * 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Metadata>(&bytes).ok())
            .unwrap_or_default();
        let layout = Layout::detect(&portable_root).and_then(|layout| {
            layout.validate()?;
            Ok(layout)
        });
        let mut error_code = layout.as_ref().err().cloned();
        let mut phase = "idle".to_string();
        if let Ok(layout) = &layout {
            if let Ok(Some((directory, job))) = pending_job(layout) {
                if matches!(job.phase.as_str(), "complete" | "failed") {
                    error_code = job.error_code.clone();
                    if error_code.is_some() {
                        phase = "failed".into();
                    }
                    let _ = release_lock(layout, &job.nonce);
                    // The independent helper may still be exiting. Cleanup is
                    // restricted to this validated terminal transaction only.
                    std::thread::spawn(move || {
                        for _ in 0..3 {
                            std::thread::sleep(Duration::from_secs(1));
                            if safe_remove_job(&directory, &job).is_ok() {
                                break;
                            }
                        }
                    });
                } else {
                    error_code = Some("UPDATE_RECOVERY_REQUIRED".into());
                    phase = "failed".into();
                }
            }
        }
        let view = UpdateView {
            enabled,
            last_checked_at: metadata.last_attempt_at,
            candidate: None,
            phase,
            job_id: None,
            downloaded_bytes: 0,
            download_total: 0,
            install_completed: 0,
            install_total: 0,
            blocking: false,
            cancellable: false,
            retryable: error_code.is_some(),
            error_code,
        };
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                view,
                candidate: None,
                metadata,
                job: None,
            }),
            layout,
            metadata_path,
            network: Network::new(policy),
            stopped: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            started: AtomicBool::new(false),
            committed: AtomicBool::new(false),
            native_ready: AtomicBool::new(false),
            renderer_ready: AtomicBool::new(false),
            acknowledgement_gate: Mutex::new(()),
            wake: Condvar::new(),
            wake_gate: Mutex::new(()),
            emit,
            request_exit,
            save_enabled,
        }))
    }

    pub(crate) fn view(&self) -> Result<UpdateView, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "UPDATE_STATE_UNAVAILABLE")?
            .view
            .clone())
    }
    fn publish(&self, change: impl FnOnce(&mut State)) {
        let view = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            change(&mut state);
            state.view.clone()
        };
        (self.emit)(view);
    }
    fn failed(&self, error: String) {
        self.publish(|state| {
            state.view.phase = "failed".into();
            state.view.error_code = Some(error);
            state.view.blocking = false;
            state.view.cancellable = false;
            state.view.retryable = true;
        });
        self.busy.store(false, Ordering::Release);
    }
    pub(crate) fn set_enabled(&self, enabled: bool) -> Result<UpdateView, String> {
        (self.save_enabled)(enabled)?;
        self.publish(|state| state.view.enabled = enabled);
        self.wake.notify_all();
        self.view()
    }

    pub(crate) fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.watch_owned_startup();
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            let Some(manager) = weak.upgrade() else {
                return;
            };
            if manager.stopped.load(Ordering::Acquire) {
                return;
            }
            let due = manager
                .state
                .lock()
                .map(|state| {
                    state.view.enabled
                        && state.view.phase != "restarting"
                        && state.metadata.last_attempt_at.is_none_or(|time| {
                            time > now() || now().saturating_sub(time) >= 24 * 60 * 60
                        })
                })
                .unwrap_or(false);
            if due && !manager.busy.load(Ordering::Acquire) {
                let _ = manager.check();
            }
            let Ok(guard) = manager.wake_gate.lock() else {
                return;
            };
            let _ = manager.wake.wait_timeout(guard, Duration::from_secs(60));
        });
    }

    fn watch_owned_startup(self: &Arc<Self>) {
        let Ok(layout) = &self.layout else {
            return;
        };
        let Ok(Some((directory, job))) = pending_job(layout) else {
            return;
        };
        if std::env::var("KAIGEN_UPDATE_NONCE").ok().as_deref() != Some(job.nonce.as_str())
            || job.phase != "awaiting-ready"
        {
            return;
        }
        self.publish(|state| {
            state.view.phase = "restarting".into();
            state.view.blocking = true;
            state.view.error_code = None;
        });
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(130);
            while std::time::Instant::now() < deadline {
                let Some(manager) = weak.upgrade() else {
                    return;
                };
                if manager.stopped.load(Ordering::Acquire) {
                    return;
                }
                if bounded_read(&directory.join("abort-startup"), 64)
                    .ok()
                    .as_deref()
                    == Some(job.nonce.as_bytes())
                {
                    (manager.request_exit)();
                    return;
                }
                if let Ok(current) = helper_types::read_job(&directory) {
                    if current.phase == "complete" {
                        manager.publish(|state| {
                            state.view.phase = "idle".into();
                            state.view.blocking = false;
                        });
                        let _ = release_lock(&current.layout, &current.nonce);
                        for _ in 0..3 {
                            std::thread::sleep(Duration::from_secs(1));
                            if safe_remove_job(&directory, &current).is_ok() {
                                break;
                            }
                        }
                        return;
                    }
                }
                drop(manager);
                std::thread::sleep(Duration::from_millis(200));
            }
            if let Some(manager) = weak.upgrade() {
                manager.failed("UPDATE_STARTUP_CONFIRMATION_TIMEOUT".into());
            }
        });
    }

    pub(crate) fn acknowledge_startup(self: &Arc<Self>) -> Result<(), String> {
        self.acknowledge(false)
    }

    pub(crate) fn acknowledge_renderer(self: &Arc<Self>) -> Result<(), String> {
        self.acknowledge(true)
    }

    fn acknowledge(&self, renderer: bool) -> Result<(), String> {
        let guard = self
            .acknowledgement_gate
            .lock()
            .map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        let ready = if renderer {
            &self.renderer_ready
        } else {
            &self.native_ready
        };
        if ready.load(Ordering::Acquire) {
            return Ok(());
        }
        let Ok(expected_nonce) = std::env::var("KAIGEN_UPDATE_NONCE") else {
            return Ok(());
        };
        let result = self.write_startup_ack(
            &expected_nonce,
            if renderer {
                "renderer-ready"
            } else {
                "startup-ready"
            },
        );
        drop(guard);
        if let Err(error) = &result {
            self.failed(error.clone());
            (self.request_exit)();
        } else {
            ready.store(true, Ordering::Release);
        }
        result
    }

    fn write_startup_ack(&self, expected_nonce: &str, marker: &str) -> Result<(), String> {
        let layout = self.layout.as_ref().map_err(Clone::clone)?;
        let (directory, job) = pending_job(layout)?.ok_or("UPDATE_JOB_INVALID")?;
        let identity = platform::process_identity(std::process::id())?;
        if job.phase != "awaiting-ready"
            || expected_nonce != job.nonce
            || job.restart_pid != Some(std::process::id())
            || job.restart_identity != Some(identity)
        {
            return Err("UPDATE_STARTUP_IDENTITY_INVALID".into());
        }
        let ack = helper_types::StartupAck {
            nonce: job.nonce,
            pid: std::process::id(),
            identity,
        };
        let bytes = serde_json::to_vec(&ack).map_err(|_| "UPDATE_JOB_INVALID")?;
        let marker = directory.join(marker);
        if bounded_read(&marker, 1024).ok().as_deref() == Some(bytes.as_slice()) {
            return Ok(());
        }
        let mut file = helper_types::create_private_file(&marker)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "UPDATE_JOURNAL_FAILED".into())
    }

    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.wake.notify_all();
        if !self.committed.load(Ordering::Acquire) {
            self.network.cancel();
        }
    }

    pub(crate) fn interrupt_network(&self) {
        if !self.committed.load(Ordering::Acquire) {
            self.network.cancel();
        }
    }

    pub(crate) fn finish_shutdown(&self) -> Result<(), String> {
        if !self.committed.load(Ordering::Acquire) {
            return Ok(());
        }
        let directory = self
            .state
            .lock()
            .map_err(|_| "UPDATE_STATE_UNAVAILABLE")?
            .job
            .clone()
            .ok_or("UPDATE_JOB_INVALID")?;
        let job = helper_types::read_job(&directory)?;
        let marker = directory.join("clean-exit");
        let mut file = helper_types::create_private_file(&marker)?;
        file.write_all(job.nonce.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "UPDATE_CLEAN_EXIT_MARKER_FAILED")?;
        helper_types::sync_directory(&directory)
    }

    pub(crate) fn check(self: &Arc<Self>) -> Result<UpdateView, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("UPDATE_STOPPED".into());
        }
        let checking = {
            let mut state = self.state.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
            // Reserve the operation and publish its phase in the same state
            // transaction so a joining caller cannot read the previous phase.
            if self.busy.swap(true, Ordering::AcqRel) {
                return Ok(state.view.clone());
            }
            self.network.begin();
            state.view.phase = "checking".into();
            state.view.error_code = None;
            state.view.retryable = false;
            state.metadata.last_attempt_at = Some(now());
            state.view.last_checked_at = state.metadata.last_attempt_at;
            state.view.clone()
        };
        (self.emit)(checking.clone());
        let manager = Arc::clone(self);
        std::thread::spawn(move || {
            let result = manager.check_inner();
            match result {
                Ok(candidate) => {
                    manager.publish(|state| {
                        state.view.candidate =
                            candidate.as_ref().map(|candidate| candidate.view.clone());
                        state.candidate = candidate;
                        state.view.phase = if state.candidate.is_some() {
                            "available"
                        } else {
                            "idle"
                        }
                        .into();
                        state.metadata.last_successful_check_at = Some(now());
                    });
                    let _ = manager.save_metadata();
                    manager.busy.store(false, Ordering::Release);
                }
                Err(error) => manager.failed(error),
            }
        });
        Ok(checking)
    }

    fn check_inner(&self) -> Result<Option<Candidate>, String> {
        self.save_metadata()?;
        let layout = self.layout.as_ref().map_err(Clone::clone)?;
        let current = Version::current()?;
        let mut best: Option<(Version, Release)> = None;
        let mut complete = false;
        for page in 1..=32 {
            let releases: Vec<Release> = self.network.json(&format!(
                "{REPOSITORY_API}/releases?per_page=100&page={page}"
            ))?;
            complete = releases.len() < 100;
            for release in releases {
                if let Some(version) = release.stable_version() {
                    if version > current && best.as_ref().is_none_or(|(old, _)| version > *old) {
                        best = Some((version, release));
                    }
                }
            }
            if complete {
                break;
            }
        }
        if !complete {
            return Err("UPDATE_RELEASE_LIST_LIMIT".into());
        }
        let Some((_, release)) = best else {
            return Ok(None);
        };
        let asset = release.asset(layout.asset_name())?;
        let candidate = Candidate {
            view: CandidateView {
                id: nonce()?,
                version: release.tag_name.trim_start_matches(['v', 'V']).into(),
                release_name: release
                    .name
                    .clone()
                    .unwrap_or_else(|| release.tag_name.clone()),
                size_bytes: asset.size,
            },
            release_id: release.id,
            tag: release.tag_name,
            asset,
        };
        Ok(Some(candidate))
    }

    pub(crate) fn install(self: &Arc<Self>, candidate_id: &str) -> Result<InstallStarted, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("UPDATE_STOPPED".into());
        }
        let candidate = self
            .state
            .lock()
            .map_err(|_| "UPDATE_STATE_UNAVAILABLE")?
            .candidate
            .clone()
            .filter(|candidate| candidate.view.id == candidate_id)
            .ok_or("UPDATE_CANDIDATE_EXPIRED")?;
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err("UPDATE_BUSY".into());
        }
        let job_id = match nonce() {
            Ok(value) => value,
            Err(error) => {
                self.busy.store(false, Ordering::Release);
                return Err(error);
            }
        };
        self.network.begin();
        self.publish(|state| {
            state.view.phase = "downloading".into();
            state.view.job_id = Some(job_id.clone());
            state.view.downloaded_bytes = 0;
            state.view.download_total = candidate.asset.size;
            state.view.install_completed = 0;
            state.view.install_total = 0;
            state.view.blocking = true;
            state.view.cancellable = true;
            state.view.error_code = None;
            state.view.retryable = false;
        });
        let manager = Arc::clone(self);
        let id = job_id.clone();
        std::thread::spawn(move || {
            if let Err(error) = manager.install_inner(candidate, &id) {
                manager.failed(error);
            }
        });
        Ok(InstallStarted { job_id })
    }

    fn install_inner(&self, candidate: Candidate, id: &str) -> Result<(), String> {
        let layout = self.layout.as_ref().map_err(Clone::clone)?.clone();
        layout.validate()?;
        if platform::other_instances(&layout.executable, std::process::id())? {
            return Err("UPDATE_OTHER_INSTANCE_ACTIVE".into());
        }
        let fresh: Release = self.network.json(&format!(
            "{REPOSITORY_API}/releases/{}",
            candidate.release_id
        ))?;
        let current_version = Version::current()?;
        if fresh.id != candidate.release_id
            || fresh.tag_name != candidate.tag
            || fresh
                .stable_version()
                .is_none_or(|version| version <= current_version)
            || fresh.asset(layout.asset_name())? != candidate.asset
        {
            return Err("UPDATE_CANDIDATE_CHANGED".into());
        }
        let directory = helper_types::job_path(&layout, id)?;
        acquire_lock(&layout, id)?;
        let result = (|| {
            helper_types::create_private_dir(&directory)?;
            let archive = directory.join(if layout.mode == Mode::WindowsMsi {
                "archive.msi"
            } else {
                "archive.zip"
            });
            let partial = directory.join("archive.partial");
            let mut file = helper_types::create_private_file(&partial)?;
            self.network
                .download(&candidate.asset, &mut file, |bytes| {
                    self.publish(|state| state.view.downloaded_bytes = bytes)
                })?;
            drop(file);
            self.publish(|state| state.view.phase = "verifying".into());
            fs::rename(&partial, &archive).map_err(|_| "UPDATE_DISK_WRITE_FAILED")?;
            self.network.check()?;
            self.publish(|state| state.view.phase = "extracting".into());
            let entries = if layout.mode == Mode::WindowsMsi {
                Vec::new()
            } else {
                package::extract(
                    &layout,
                    &archive,
                    &directory.join("candidate"),
                    |done, total| {
                        self.publish(|state| {
                            state.view.install_completed = done;
                            state.view.install_total = total;
                        })
                    },
                )?
            };
            self.network.check()?;
            let job = Job {
                format_version: 1,
                nonce: id.into(),
                layout: layout.clone(),
                parent_pid: std::process::id(),
                parent_identity: platform::process_identity(std::process::id())?,
                helper_pid: None,
                helper_identity: None,
                restart_pid: None,
                restart_identity: None,
                version: candidate.view.version,
                archive_sha256: candidate
                    .asset
                    .digest
                    .as_deref()
                    .and_then(|value| value.strip_prefix("sha256:"))
                    .ok_or("UPDATE_DIGEST_INVALID")?
                    .into(),
                phase: "prepared".into(),
                entries: entries
                    .into_iter()
                    .map(|name| Entry {
                        had_old: layout.program_root.join(&name).exists(),
                        name,
                        backed_up: false,
                        installed: false,
                    })
                    .collect(),
                error_code: None,
                last_native_error: None,
            };
            helper_types::save_job(&directory, &job)?;
            let mut helper = prepare_helper(&directory, &job, false)?;
            {
                let mut state = self.state.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
                self.network.check()?;
                if self.stopped.load(Ordering::Acquire) {
                    return Err("UPDATE_STOPPED".into());
                }
                helper.commit(id)?;
                self.committed.store(true, Ordering::Release);
                state.job = Some(directory.clone());
                state.view.phase = "closing".into();
                state.view.cancellable = false;
            }
            self.publish(|_| {});
            (self.request_exit)();
            Ok(())
        })();
        if result.is_err() && !self.committed.load(Ordering::Acquire) {
            let _ = release_lock(&layout, id);
            // All descendants here were created in this fresh updater-owned
            // namespace; no selected program/data directory is removed.
            if directory == helper_types::job_path(&layout, id)? && directory.exists() {
                let _ = fs::remove_dir_all(&directory);
            }
        }
        result
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<UpdateView, String> {
        {
            let state = self.state.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
            if state.view.job_id.as_deref() != Some(id)
                || !state.view.cancellable
                || self.committed.load(Ordering::Acquire)
            {
                return Err("UPDATE_CANNOT_CANCEL".into());
            }
            self.network.cancel();
        }
        self.view()
    }

    fn save_metadata(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(
            &self
                .state
                .lock()
                .map_err(|_| "UPDATE_STATE_UNAVAILABLE")?
                .metadata,
        )
        .map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        let temp = self.metadata_path.with_extension("next");
        if temp.exists() {
            helper_types::checked_path(&temp)?;
            fs::remove_file(&temp).map_err(|_| "UPDATE_METADATA_WRITE_FAILED")?;
        }
        let mut file = helper_types::create_private_file(&temp)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "UPDATE_METADATA_WRITE_FAILED")?;
        drop(file);
        platform::replace_file(&temp, &self.metadata_path)
    }
}

struct PreparedHelper {
    child: Child,
    input: Option<ChildStdin>,
}
impl PreparedHelper {
    fn commit(&mut self, nonce: &str) -> Result<(), String> {
        let mut input = self.input.take().ok_or("UPDATE_HELPER_HANDSHAKE_INVALID")?;
        input
            .write_all(format!("COMMIT {nonce}\n").as_bytes())
            .and_then(|_| input.flush())
            .map_err(|_| "UPDATE_HELPER_HANDSHAKE_INVALID".to_string())
    }
}
impl Drop for PreparedHelper {
    fn drop(&mut self) {
        drop(self.input.take());
        let _ = self.child.try_wait();
    }
}

fn prepare_helper(directory: &Path, job: &Job, recover: bool) -> Result<PreparedHelper, String> {
    let source = match job.layout.mode {
        Mode::WindowsPortable | Mode::WindowsMsi => {
            job.layout.program_root.join("KaigenUpdater.exe")
        }
        Mode::LinuxAppImage => job.layout.program_root.join("kaigen-updater"),
        Mode::MacApp => job
            .layout
            .program_root
            .join(&job.layout.target_name)
            .join("Contents/Helpers/kaigen-updater"),
    };
    let runner = directory.join("runner");
    if !runner.exists() {
        helper_types::create_private_dir(&runner)?;
    }
    let executable = runner.join(if cfg!(windows) {
        "KaigenUpdater.exe"
    } else {
        "kaigen-updater"
    });
    if !recover {
        helper_types::checked_path(&source)?;
        fs::copy(&source, &executable).map_err(|_| "UPDATE_HELPER_MISSING")?;
    }
    helper_types::checked_path(&executable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .map_err(|_| "UPDATE_HELPER_MISSING")?;
    }
    let mut command = Command::new(&executable);
    command
        .arg(if recover { "--recover" } else { "--apply" })
        .arg(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = platform::spawn(&mut command)?;
    let mut input = child
        .stdin
        .take()
        .ok_or("UPDATE_HELPER_HANDSHAKE_INVALID")?;
    input
        .write_all(format!("{}\n", job.nonce).as_bytes())
        .and_then(|_| input.flush())
        .map_err(|_| "UPDATE_HELPER_HANDSHAKE_INVALID")?;
    let output = child
        .stdout
        .take()
        .ok_or("UPDATE_HELPER_HANDSHAKE_INVALID")?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(output).read_line(&mut line).map(|_| line);
        let _ = send.send(result);
    });
    let line = receive
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "UPDATE_HELPER_START_TIMEOUT")?
        .map_err(|_| "UPDATE_HELPER_HANDSHAKE_INVALID")?;
    if line.trim_end() != format!("READY {}", job.nonce) {
        return Err("UPDATE_HELPER_HANDSHAKE_INVALID".into());
    }
    Ok(PreparedHelper {
        child,
        input: Some(input),
    })
}

fn acquire_lock(layout: &Layout, nonce: &str) -> Result<(), String> {
    let directory = layout.program_root.join(LOCK_NAME);
    helper_types::create_private_dir(&directory).map_err(|_| "UPDATE_BUSY")?;
    let mut file = helper_types::create_private_file(&directory.join("owner"))?;
    let owner = LockOwner {
        nonce: nonce.into(),
        pid: std::process::id(),
        identity: platform::process_identity(std::process::id())?,
    };
    let bytes = serde_json::to_vec(&owner).map_err(|_| "UPDATE_JOB_INVALID")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "UPDATE_JOURNAL_FAILED".into())
}
fn release_lock(layout: &Layout, nonce: &str) -> Result<(), String> {
    let directory = layout.program_root.join(LOCK_NAME);
    helper_types::checked_path(&directory)?;
    if read_lock(layout)?.ok_or("UPDATE_JOB_INVALID")?.nonce != nonce {
        return Err("UPDATE_JOB_INVALID".into());
    }
    fs::remove_file(directory.join("owner"))
        .and_then(|_| fs::remove_dir(directory))
        .map_err(|_| "UPDATE_JOURNAL_FAILED".into())
}
fn pending_job(layout: &Layout) -> Result<Option<(PathBuf, Job)>, String> {
    let Some(owner) = read_lock(layout)? else {
        return Ok(None);
    };
    let directory = helper_types::job_path(layout, &owner.nonce)?;
    let job = helper_types::read_job(&directory)?;
    if job.layout.program_root != layout.program_root || job.layout.executable != layout.executable
    {
        return Err("UPDATE_JOB_INVALID".into());
    }
    Ok(Some((directory, job)))
}
fn safe_remove_job(directory: &Path, job: &Job) -> Result<(), String> {
    if !matches!(job.phase.as_str(), "complete" | "failed")
        || directory != helper_types::job_path(&job.layout, &job.nonce)?
    {
        return Err("UPDATE_JOB_INVALID".into());
    }
    helper_types::checked_path(directory)?;
    fs::remove_dir_all(directory).map_err(|_| "UPDATE_CLEANUP_PENDING".into())
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    helper_types::checked_path(path)?;
    let file = fs::File::open(path).map_err(|_| "UPDATE_JOB_INVALID")?;
    if !file.metadata().map_err(|_| "UPDATE_JOB_INVALID")?.is_file() {
        return Err("UPDATE_JOB_INVALID".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "UPDATE_JOB_INVALID")?;
    if bytes.len() as u64 > limit {
        return Err("UPDATE_JOB_INVALID".into());
    }
    Ok(bytes)
}

fn read_lock(layout: &Layout) -> Result<Option<LockOwner>, String> {
    let lock = layout.program_root.join(LOCK_NAME);
    if !lock.exists() {
        return Ok(None);
    }
    helper_types::checked_path(&lock)?;
    let owner = serde_json::from_slice(&bounded_read(&lock.join("owner"), 1024)?)
        .map_err(|_| "UPDATE_JOB_INVALID")?;
    Ok(Some(owner))
}

/// Called before any profile or native service is opened. Returning true means
/// this invocation must exit normally: an independent helper owns the program.
pub(crate) fn recover_before_startup(portable_root: &Path) -> Result<bool, String> {
    let layout = match Layout::detect(portable_root) {
        Ok(layout) => layout,
        Err(_) => return Ok(false),
    };
    let Some(owner) = read_lock(&layout)? else {
        return Ok(false);
    };
    let directory = helper_types::job_path(&layout, &owner.nonce)?;
    let owner_alive = platform::process_identity(owner.pid).ok() == Some(owner.identity);
    if !directory.join("journal.json").exists() {
        if owner_alive {
            return Ok(false);
        } // Only download/staging was started.
        if directory.exists() {
            helper_types::checked_path(&directory)?;
            fs::remove_dir_all(&directory).map_err(|_| "UPDATE_CLEANUP_PENDING")?;
        }
        release_lock(&layout, &owner.nonce)?;
        return Ok(false);
    }
    let (_, mut job) = pending_job(&layout)?.ok_or("UPDATE_JOB_INVALID")?;
    if matches!(job.phase.as_str(), "complete" | "failed") {
        return Ok(false);
    }
    let helper_alive = job
        .helper_pid
        .zip(job.helper_identity)
        .is_some_and(|(pid, identity)| platform::process_identity(pid).ok() == Some(identity));
    if helper_alive {
        return Ok(!(job.phase == "awaiting-ready"
            && std::env::var("KAIGEN_UPDATE_NONCE").ok().as_deref() == Some(job.nonce.as_str())));
    }
    if job
        .restart_pid
        .zip(job.restart_identity)
        .is_some_and(|(pid, identity)| platform::process_identity(pid).ok() == Some(identity))
    {
        return Ok(true);
    }
    if owner_alive {
        return Ok(false);
    }
    if matches!(
        job.phase.as_str(),
        "prepared" | "waiting-parent" | "recovering-parent"
    ) && !directory.join("backup").exists()
    {
        job.phase = "failed".into();
        job.error_code = Some("UPDATE_INTERRUPTED_BEFORE_INSTALL".into());
        helper_types::save_job(&directory, &job)?;
        return Ok(false);
    }
    if job.layout.mode == Mode::WindowsMsi {
        // MSI's own transaction recovers the registered product. Never lay ZIP
        // files over it or start a second msiexec after an interrupted launch.
        job.phase = "failed".into();
        job.error_code = Some("UPDATE_MSI_RECOVERY_REQUIRED".into());
        helper_types::save_job(&directory, &job)?;
        return Ok(false);
    }
    job.parent_pid = std::process::id();
    job.parent_identity = platform::process_identity(job.parent_pid)?;
    job.helper_pid = None;
    job.helper_identity = None;
    helper_types::save_job(&directory, &job)?;
    let marker = directory.join("clean-exit");
    if marker.exists() {
        helper_types::checked_path(&marker)?;
        fs::remove_file(&marker).map_err(|_| "UPDATE_JOURNAL_FAILED")?;
    }
    let mut helper = prepare_helper(&directory, &job, true)?;
    let mut file = helper_types::create_private_file(&marker)?;
    file.write_all(job.nonce.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "UPDATE_CLEAN_EXIT_MARKER_FAILED")?;
    helper.commit(&job.nonce)?;
    Ok(true)
}
fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "UPDATE_RANDOM_UNAVAILABLE")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[tauri::command]
pub(crate) fn acknowledge_desktop_update_renderer(
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    state.desktop_update.acknowledge_renderer()
}

#[tauri::command]
pub(crate) fn get_desktop_update_state(
    state: tauri::State<'_, crate::AppState>,
) -> Result<UpdateView, String> {
    state.desktop_update.view()
}
#[tauri::command]
pub(crate) fn set_desktop_auto_update(
    state: tauri::State<'_, crate::AppState>,
    enabled: bool,
) -> Result<UpdateView, String> {
    state.desktop_update.set_enabled(enabled)
}
#[tauri::command]
pub(crate) fn check_desktop_update(
    state: tauri::State<'_, crate::AppState>,
) -> Result<UpdateView, String> {
    state.desktop_update.check()
}
#[tauri::command]
pub(crate) fn install_desktop_update(
    state: tauri::State<'_, crate::AppState>,
    candidate_id: String,
) -> Result<InstallStarted, String> {
    state.desktop_update.install(&candidate_id)
}
#[tauri::command]
pub(crate) fn cancel_desktop_update(
    state: tauri::State<'_, crate::AppState>,
    job_id: String,
) -> Result<UpdateView, String> {
    state.desktop_update.cancel(&job_id)
}
