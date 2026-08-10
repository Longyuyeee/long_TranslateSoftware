// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if let Some(result) = long_translate_lib::native_registration::handle_cli_command(&args) {
        match result {
            Ok(message) => println!("{message}"),
            Err(error) => {
                eprintln!("Long Translate Native Host registration failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if long_translate_lib::native_host::is_native_host_invocation(&args) {
        if let Err(error) = long_translate_lib::native_host::run_from_args(&args) {
            eprintln!("Long Translate Native Host failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Some(output) = long_translate_lib::lifecycle_probe_output(&args) {
        println!("{output}");
        return;
    }
    long_translate_lib::run()
}
