mod archive;
mod config;
mod proof;
mod server;
mod state;
mod transfer_store;

fn main() {
    let config = match config::Config::from_environment() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("kaigen-webd configuration error: {error}");
            std::process::exit(2);
        }
    };
    if let Err(error) = tauri_app_lib::lock_sensitive_process_memory() {
        eprintln!("kaigen-webd secure-memory error: {error}");
        std::process::exit(1);
    }
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
    if let Err(error) = runtime.block_on(server::run(config)) {
        eprintln!("kaigen-webd startup error: {error}");
        std::process::exit(1);
    }
}
