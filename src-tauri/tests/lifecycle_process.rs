use serde_json::Value;
use std::process::Command;

fn run_probe(extra_args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_long-translate"))
        .arg("--lifecycle-probe")
        .args(extra_args)
        .output()
        .expect("lifecycle probe process should start");

    assert!(
        output.status.success(),
        "probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("probe should emit one JSON report")
}

#[test]
fn manual_process_reports_that_the_main_window_should_be_restored() {
    let report = run_probe(&[]);
    assert_eq!(report["launch_mode"], "manual");
    assert_eq!(report["restore_main_window"], true);
}

#[test]
fn autostart_process_reports_tray_only_startup() {
    let report = run_probe(&["--autostart"]);
    assert_eq!(report["launch_mode"], "autostart");
    assert_eq!(report["restore_main_window"], false);
}
