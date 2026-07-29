use crate::{db, system_integration};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState as GlobalShortcutState,
};

const DEFAULT_TRANSLATE_SHORTCUT: &str = "Alt+Q";
const DEFAULT_OCR_SHORTCUT: &str = "Alt+W";
static CLIPBOARD_MARKER_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct ShortcutState {
    paused: AtomicBool,
    clipboard_busy: AtomicBool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutAction {
    Translate,
    Ocr,
}

impl ShortcutAction {
    fn from_name(name: &str) -> Result<Self, String> {
        match name {
            "q" => Ok(Self::Translate),
            "w" => Ok(Self::Ocr),
            _ => Err(format!("Unsupported shortcut name: {name}")),
        }
    }

    fn config_key(self) -> &'static str {
        match self {
            Self::Translate => "shortcut_q",
            Self::Ocr => "shortcut_w",
        }
    }

    fn default_value(self) -> &'static str {
        match self {
            Self::Translate => DEFAULT_TRANSLATE_SHORTCUT,
            Self::Ocr => DEFAULT_OCR_SHORTCUT,
        }
    }

    fn other(self) -> Self {
        match self {
            Self::Translate => Self::Ocr,
            Self::Ocr => Self::Translate,
        }
    }
}

fn parse_shortcut(shortcut_text: &str) -> Result<Shortcut, String> {
    let mut modifiers = Modifiers::empty();
    let mut code = None;

    for raw_part in shortcut_text.split('+') {
        let part = raw_part.trim().to_uppercase();
        match part.as_str() {
            "CTRL" | "CONTROL" => modifiers.insert(Modifiers::CONTROL),
            "ALT" => modifiers.insert(Modifiers::ALT),
            "SHIFT" => modifiers.insert(Modifiers::SHIFT),
            "SUPER" | "COMMAND" | "WIN" => modifiers.insert(Modifiers::SUPER),
            key => {
                if code.is_some() {
                    return Err("Shortcut must contain exactly one non-modifier key".to_string());
                }
                code = Some(match key {
                    "A" => Code::KeyA,
                    "B" => Code::KeyB,
                    "C" => Code::KeyC,
                    "D" => Code::KeyD,
                    "E" => Code::KeyE,
                    "F" => Code::KeyF,
                    "G" => Code::KeyG,
                    "H" => Code::KeyH,
                    "I" => Code::KeyI,
                    "J" => Code::KeyJ,
                    "K" => Code::KeyK,
                    "L" => Code::KeyL,
                    "M" => Code::KeyM,
                    "N" => Code::KeyN,
                    "O" => Code::KeyO,
                    "P" => Code::KeyP,
                    "Q" => Code::KeyQ,
                    "R" => Code::KeyR,
                    "S" => Code::KeyS,
                    "T" => Code::KeyT,
                    "U" => Code::KeyU,
                    "V" => Code::KeyV,
                    "W" => Code::KeyW,
                    "X" => Code::KeyX,
                    "Y" => Code::KeyY,
                    "Z" => Code::KeyZ,
                    "0" => Code::Digit0,
                    "1" => Code::Digit1,
                    "2" => Code::Digit2,
                    "3" => Code::Digit3,
                    "4" => Code::Digit4,
                    "5" => Code::Digit5,
                    "6" => Code::Digit6,
                    "7" => Code::Digit7,
                    "8" => Code::Digit8,
                    "9" => Code::Digit9,
                    "F1" => Code::F1,
                    "F2" => Code::F2,
                    "F3" => Code::F3,
                    "F4" => Code::F4,
                    "F5" => Code::F5,
                    "F6" => Code::F6,
                    "F7" => Code::F7,
                    "F8" => Code::F8,
                    "F9" => Code::F9,
                    "F10" => Code::F10,
                    "F11" => Code::F11,
                    "F12" => Code::F12,
                    _ => return Err(format!("Unsupported key: {key}")),
                });
            }
        }
    }

    let code = code.ok_or_else(|| "No key specified".to_string())?;
    let is_function_key = matches!(
        code,
        Code::F1
            | Code::F2
            | Code::F3
            | Code::F4
            | Code::F5
            | Code::F6
            | Code::F7
            | Code::F8
            | Code::F9
            | Code::F10
            | Code::F11
            | Code::F12
    );
    if modifiers.is_empty() && !is_function_key {
        return Err("Letter and digit shortcuts require a modifier".to_string());
    }

    Ok(Shortcut::new(
        (!modifiers.is_empty()).then_some(modifiers),
        code,
    ))
}

fn register_shortcut(
    app: &AppHandle,
    shortcut_text: &str,
    action: ShortcutAction,
) -> Result<Shortcut, String> {
    let shortcut = parse_shortcut(shortcut_text)?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            let state = app.state::<ShortcutState>();
            if state.paused.load(Ordering::Acquire) || event.state() != GlobalShortcutState::Pressed
            {
                return;
            }

            match action {
                ShortcutAction::Translate => handle_translate_request(app),
                ShortcutAction::Ocr => system_integration::show_ocr_overlay(app),
            }
        })
        .map_err(|error| format!("Shortcut registration failed: {error}"))?;
    Ok(shortcut)
}

pub fn register_saved_shortcuts(app: &AppHandle, connection: &Connection) {
    for action in [ShortcutAction::Translate, ShortcutAction::Ocr] {
        let value = db::get_config(connection, action.config_key())
            .unwrap_or_default()
            .trim()
            .to_string();
        let value = if value.is_empty() {
            action.default_value()
        } else {
            &value
        };

        if let Err(error) = register_shortcut(app, value, action) {
            eprintln!(
                "Cannot register {} shortcut '{}': {error}",
                action.config_key(),
                value
            );
            if value != action.default_value() {
                let _ = register_shortcut(app, action.default_value(), action);
            }
        }
    }
}

#[tauri::command]
pub fn set_shortcuts_paused(state: tauri::State<'_, ShortcutState>, paused: bool) {
    state.paused.store(paused, Ordering::Release);
}

#[tauri::command]
pub fn update_shortcut(app: AppHandle, name: String, shortcut_str: String) -> Result<(), String> {
    let action = ShortcutAction::from_name(&name)?;
    let new_shortcut = parse_shortcut(&shortcut_str)?;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))?;
    let connection = db::init_db(app_dir).map_err(|error| error.to_string())?;
    let old_text = db::get_config(&connection, action.config_key()).unwrap_or_default();
    let old_effective = if old_text.trim().is_empty() {
        action.default_value()
    } else {
        &old_text
    };
    let other_action = action.other();
    let other_text = db::get_config(&connection, other_action.config_key()).unwrap_or_default();
    let other_effective = if other_text.trim().is_empty() {
        other_action.default_value()
    } else {
        &other_text
    };
    if parse_shortcut(other_effective).is_ok_and(|shortcut| shortcut == new_shortcut) {
        return Err("This shortcut is already assigned to another action".to_string());
    }

    let old_shortcut = parse_shortcut(old_effective).ok();
    if old_shortcut.is_some_and(|shortcut| shortcut == new_shortcut) {
        if !app.global_shortcut().is_registered(new_shortcut) {
            register_shortcut(&app, &shortcut_str, action)?;
        }
        return db::set_config(&connection, action.config_key(), &shortcut_str)
            .map_err(|error| error.to_string());
    }

    register_shortcut(&app, &shortcut_str, action)?;
    if let Some(old_shortcut) = old_shortcut {
        if let Err(error) = app.global_shortcut().unregister(old_shortcut) {
            let _ = app.global_shortcut().unregister(new_shortcut);
            return Err(format!("Cannot replace the previous shortcut: {error}"));
        }
    }

    if let Err(error) = db::set_config(&connection, action.config_key(), &shortcut_str) {
        let _ = app.global_shortcut().unregister(new_shortcut);
        let _ = register_shortcut(&app, old_effective, action);
        return Err(error.to_string());
    }

    Ok(())
}

struct ClipboardBusyGuard {
    app: AppHandle,
}

impl Drop for ClipboardBusyGuard {
    fn drop(&mut self) {
        self.app
            .state::<ShortcutState>()
            .clipboard_busy
            .store(false, Ordering::Release);
    }
}

fn preferred_translation_text(
    original_text: &str,
    observed_text: Option<&str>,
    marker: &str,
) -> Option<String> {
    observed_text
        .filter(|text| *text != marker && !text.trim().is_empty())
        .or_else(|| (!original_text.trim().is_empty()).then_some(original_text))
        .map(ToOwned::to_owned)
}

fn handle_translate_request(app: &AppHandle) {
    let state = app.state::<ShortcutState>();
    if state
        .clipboard_busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        let _busy_guard = ClipboardBusyGuard {
            app: app_handle.clone(),
        };
        thread::sleep(Duration::from_millis(200));

        let clipboard = app_handle.clipboard();
        let mut original_text = String::new();
        for attempt in 0..3 {
            match clipboard.read_text() {
                Ok(text) => {
                    original_text = text;
                    break;
                }
                Err(_) if attempt < 2 => thread::sleep(Duration::from_millis(25)),
                Err(_) => {}
            }
        }
        let marker = format!(
            "__LONG_TRANSLATE_CLIPBOARD_{}_{}__",
            std::process::id(),
            CLIPBOARD_MARKER_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        if clipboard.write_text(marker.clone()).is_err() {
            return;
        }

        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(enigo) => enigo,
            Err(_) => {
                let _ = clipboard.write_text(original_text);
                return;
            }
        };

        let _ = enigo.key(Key::Control, Direction::Press);
        thread::sleep(Duration::from_millis(50));
        let _ = enigo.key(Key::C, Direction::Press);
        thread::sleep(Duration::from_millis(100));
        let _ = enigo.key(Key::C, Direction::Release);
        thread::sleep(Duration::from_millis(50));
        let _ = enigo.key(Key::Control, Direction::Release);

        let mut observed_text = None;
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(50));
            let Ok(current_text) = clipboard.read_text() else {
                continue;
            };
            if current_text != marker && !current_text.trim().is_empty() {
                observed_text = Some(current_text);
                break;
            }
        }

        let final_text =
            preferred_translation_text(&original_text, observed_text.as_deref(), &marker);
        for attempt in 0..3 {
            match clipboard.write_text(original_text.clone()) {
                Ok(()) => break,
                Err(_) if attempt < 2 => thread::sleep(Duration::from_millis(25)),
                Err(_) => {}
            }
        }

        if let (Some(text), Some(window)) = (final_text, app_handle.get_webview_window("floating"))
        {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app_handle.emit("shortcut-triggered", text);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_accepts_aliases_and_function_keys() {
        assert!(parse_shortcut("Control + Shift + 7").is_ok());
        assert!(parse_shortcut("Win+F12").is_ok());
        assert!(parse_shortcut("F1").is_ok());
        assert_eq!(
            parse_shortcut("Control+Q").unwrap(),
            parse_shortcut("Ctrl+Q").unwrap()
        );
    }

    #[test]
    fn parser_rejects_unsafe_or_ambiguous_shortcuts() {
        assert_eq!(
            parse_shortcut("Q").unwrap_err(),
            "Letter and digit shortcuts require a modifier"
        );
        assert_eq!(
            parse_shortcut("Ctrl+Q+W").unwrap_err(),
            "Shortcut must contain exactly one non-modifier key"
        );
        assert!(parse_shortcut("Ctrl+Space").is_err());
    }

    #[test]
    fn shortcut_names_are_restricted_to_supported_actions() {
        assert_eq!(
            ShortcutAction::from_name("q"),
            Ok(ShortcutAction::Translate)
        );
        assert_eq!(ShortcutAction::from_name("w"), Ok(ShortcutAction::Ocr));
        assert!(ShortcutAction::from_name("other").is_err());
        assert_eq!(ShortcutAction::Translate.other(), ShortcutAction::Ocr);
        assert_eq!(ShortcutAction::Ocr.other(), ShortcutAction::Translate);
    }

    #[test]
    fn selected_text_wins_but_clipboard_content_is_the_fallback() {
        assert_eq!(
            preferred_translation_text("clipboard", Some("selection"), "marker"),
            Some("selection".to_string())
        );
        assert_eq!(
            preferred_translation_text("clipboard", Some("marker"), "marker"),
            Some("clipboard".to_string())
        );
        assert_eq!(preferred_translation_text(" ", None, "marker"), None);
    }
}
