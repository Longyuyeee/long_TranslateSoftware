fn main() {
    if let Err(error) = long_translate_lib::native_host::run_from_env() {
        eprintln!("Long Translate Native Host failed: {error}");
        std::process::exit(1);
    }
}
