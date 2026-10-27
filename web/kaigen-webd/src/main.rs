mod archive;
mod config;
mod proof;
mod server;
mod state;
mod transfer_store;
mod web_push;

use std::sync::atomic::{AtomicBool, Ordering};

static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

pub(crate) fn shutdown_requested() -> bool {
    SHUTDOWN_REQUESTED.load(Ordering::Acquire)
}

pub(crate) fn request_shutdown() {
    SHUTDOWN_REQUESTED.store(true, Ordering::Release);
}

#[cfg(unix)]
extern "C" fn shutdown_signal(_signal: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, Ordering::Release);
}

#[cfg(unix)]
fn install_shutdown_signals() -> Result<(), &'static str> {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = shutdown_signal as *const () as usize;
    action.sa_flags = libc::SA_RESTART;
    if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0 {
        return Err("WEB_SHUTDOWN_SIGNAL_REGISTRATION_FAILED");
    }
    let mut previous = std::mem::MaybeUninit::<libc::sigaction>::uninit();
    if unsafe { libc::sigaction(libc::SIGTERM, &action, previous.as_mut_ptr()) } != 0 {
        return Err("WEB_SHUTDOWN_SIGNAL_REGISTRATION_FAILED");
    }
    let previous = unsafe { previous.assume_init() };
    if unsafe { libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut()) } != 0 {
        if unsafe { libc::sigaction(libc::SIGTERM, &previous, std::ptr::null_mut()) } != 0 {
            return Err("WEB_SHUTDOWN_SIGNAL_RESTORE_FAILED");
        }
        return Err("WEB_SHUTDOWN_SIGNAL_REGISTRATION_FAILED");
    }
    Ok(())
}

#[cfg(not(unix))]
fn install_shutdown_signals() -> Result<(), &'static str> {
    Err("WEB_SHUTDOWN_SIGNAL_UNSUPPORTED")
}

fn main() {
    let config = match config::Config::from_environment() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("kaigen-webd configuration error: {error}");
            std::process::exit(2);
        }
    };
    if let Err(error) = install_shutdown_signals() {
        eprintln!("kaigen-webd signal error: {error}");
        std::process::exit(1);
    }
    if let Err(error) = tauri_app_lib::lock_sensitive_process_memory() {
        eprintln!("kaigen-webd secure-memory error: {error}");
        std::process::exit(1);
    }
    // Declared before runtime: on success runtime drops before stopped state.
    // On error process::exit happens before a state destructor can retry IO.
    let mut process_state_owner = None;
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kaigen-webd runtime error: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = runtime.block_on(server::run(config, &mut process_state_owner)) {
        eprintln!("kaigen-webd startup error: {error}");
        std::process::exit(1);
    }
}
