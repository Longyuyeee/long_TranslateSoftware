use serde::Serialize;

pub const LIFECYCLE_PROBE_FLAG: &str = "--lifecycle-probe";
const AUTOSTART_FLAG: &str = "--autostart";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchMode {
    Manual,
    Autostart,
}

impl LaunchMode {
    pub fn from_args(args: &[String]) -> Self {
        if args.iter().any(|arg| arg == AUTOSTART_FLAG) {
            Self::Autostart
        } else {
            Self::Manual
        }
    }

    pub fn should_restore_main_window(self) -> bool {
        matches!(self, Self::Manual)
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct LifecycleProbe {
    launch_mode: LaunchMode,
    restore_main_window: bool,
}

pub fn probe_output(args: &[String]) -> Option<String> {
    if !args.iter().any(|arg| arg == LIFECYCLE_PROBE_FLAG) {
        return None;
    }

    let launch_mode = LaunchMode::from_args(args);
    serde_json::to_string(&LifecycleProbe {
        launch_mode,
        restore_main_window: launch_mode.should_restore_main_window(),
    })
    .ok()
}

pub trait MainWindowControl {
    fn show(&self) -> Result<(), String>;
    fn unminimize(&self) -> Result<(), String>;
    fn focus(&self) -> Result<(), String>;
    fn hide(&self) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecoveryReport {
    pub shown: bool,
    pub unminimized: bool,
    pub focused: bool,
}

pub fn recover_main_window(window: &impl MainWindowControl) -> RecoveryReport {
    RecoveryReport {
        shown: window.show().is_ok(),
        unminimized: window.unminimize().is_ok(),
        focused: window.focus().is_ok(),
    }
}

pub fn hide_main_window(window: &impl MainWindowControl) -> bool {
    window.hide().is_ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayMenuAction {
    Restore,
    Quit,
    Ignore,
}

impl TrayMenuAction {
    pub fn from_id(id: &str) -> Self {
        match id {
            "show_dashboard" => Self::Restore,
            "quit" => Self::Quit,
            _ => Self::Ignore,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeWindow {
        calls: RefCell<Vec<&'static str>>,
        fail_show: bool,
    }

    impl MainWindowControl for FakeWindow {
        fn show(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("show");
            if self.fail_show {
                Err("show failed".to_string())
            } else {
                Ok(())
            }
        }

        fn unminimize(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("unminimize");
            Ok(())
        }

        fn focus(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("focus");
            Ok(())
        }

        fn hide(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("hide");
            Ok(())
        }
    }

    #[test]
    fn launch_mode_distinguishes_manual_and_autostart_processes() {
        assert_eq!(
            LaunchMode::from_args(&["long-translate.exe".into()]),
            LaunchMode::Manual
        );
        assert_eq!(
            LaunchMode::from_args(&["long-translate.exe".into(), "--autostart".into()]),
            LaunchMode::Autostart
        );
        assert!(LaunchMode::Manual.should_restore_main_window());
        assert!(!LaunchMode::Autostart.should_restore_main_window());
    }

    #[test]
    fn recovery_attempts_show_unminimize_and_focus_in_order() {
        let window = FakeWindow {
            fail_show: true,
            ..Default::default()
        };

        assert_eq!(
            recover_main_window(&window),
            RecoveryReport {
                shown: false,
                unminimized: true,
                focused: true,
            }
        );
        assert_eq!(
            window.calls.into_inner(),
            vec!["show", "unminimize", "focus"]
        );
    }

    #[test]
    fn tray_menu_ids_map_to_explicit_actions() {
        assert_eq!(
            TrayMenuAction::from_id("show_dashboard"),
            TrayMenuAction::Restore
        );
        assert_eq!(TrayMenuAction::from_id("quit"), TrayMenuAction::Quit);
        assert_eq!(TrayMenuAction::from_id("unknown"), TrayMenuAction::Ignore);
    }

    #[test]
    fn close_request_hides_the_main_window_to_the_tray() {
        let window = FakeWindow::default();
        assert!(hide_main_window(&window));
        assert_eq!(window.calls.into_inner(), vec!["hide"]);
    }
}
