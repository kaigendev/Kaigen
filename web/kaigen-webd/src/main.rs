#![deny(unsafe_op_in_unsafe_fn)]

mod archive;
mod config;
#[cfg(unix)]
mod native;
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
use native::install_shutdown_signals;

#[cfg(windows)]
fn install_shutdown_signals() -> Result<(), &'static str> {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }

    extern "system" fn console_control(control: u32) -> i32 {
        match control {
            // CTRL_C_EVENT and CTRL_BREAK_EVENT allow the existing server loop
            // to stop accepting requests and finish its normal durable shutdown.
            0 | 1 => {
                request_shutdown();
                1
            }
            // Close, logoff and system shutdown have OS-enforced termination
            // deadlines. Do not claim that an atomic request handles those.
            _ => 0,
        }
    }

    // SAFETY: the callback has the Windows HANDLER_ROUTINE ABI and static
    // lifetime. It only requests shutdown through the existing atomic flag.
    if unsafe { SetConsoleCtrlHandler(Some(console_control), 1) } == 0 {
        Err("WEB_SHUTDOWN_SIGNAL_REGISTRATION_FAILED")
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
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
