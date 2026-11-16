// Standalone executable: never links or initializes tauri_app_lib / Tox.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod helper_parent;
mod helper_runtime;
mod helper_types;
mod platform;

fn main() {
    std::process::exit(helper_runtime::run());
}
