// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if let Some(output) = long_translate_lib::lifecycle_probe_output(&args) {
        println!("{output}");
        return;
    }
    long_translate_lib::run()
}
