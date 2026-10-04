#![windows_subsystem = "windows"]

use std::{env, thread, time::Duration};

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--watch-canary" {
        thread::sleep(Duration::from_secs(3));
        return;
    }
    std::process::exit(64);
}
