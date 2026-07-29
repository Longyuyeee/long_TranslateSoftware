use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DisplayRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DesktopBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    count: usize,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ScreenBoundsResponse {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    physical_x: i32,
    physical_y: i32,
    physical_width: u32,
    physical_height: u32,
    factor: f64,
    count: usize,
}

fn desktop_bounds(displays: &[DisplayRect]) -> Option<DesktopBounds> {
    let first = displays.first()?;
    let mut min_x = i64::from(first.x);
    let mut min_y = i64::from(first.y);
    let mut max_x = i64::from(first.x) + i64::from(first.width);
    let mut max_y = i64::from(first.y) + i64::from(first.height);

    for display in &displays[1..] {
        min_x = min_x.min(i64::from(display.x));
        min_y = min_y.min(i64::from(display.y));
        max_x = max_x.max(i64::from(display.x) + i64::from(display.width));
        max_y = max_y.max(i64::from(display.y) + i64::from(display.height));
    }

    Some(DesktopBounds {
        x: min_x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y: min_y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        width: (max_x - min_x).clamp(0, i64::from(u32::MAX)) as u32,
        height: (max_y - min_y).clamp(0, i64::from(u32::MAX)) as u32,
        count: displays.len(),
    })
}

fn available_desktop_bounds() -> Result<DesktopBounds, String> {
    let displays = screenshots::Screen::all()
        .map_err(|error| format!("Failed to enumerate screens: {error}"))?
        .into_iter()
        .map(|screen| {
            let info = screen.display_info;
            DisplayRect {
                x: info.x,
                y: info.y,
                width: info.width,
                height: info.height,
            }
        })
        .collect::<Vec<_>>();

    desktop_bounds(&displays).ok_or_else(|| "No screen available".to_string())
}

fn response_for(bounds: DesktopBounds, scale_factor: f64) -> ScreenBoundsResponse {
    let factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };

    ScreenBoundsResponse {
        x: bounds.x,
        y: bounds.y,
        width: f64::from(bounds.width) / factor,
        height: f64::from(bounds.height) / factor,
        physical_x: bounds.x,
        physical_y: bounds.y,
        physical_width: bounds.width,
        physical_height: bounds.height,
        factor,
        count: bounds.count,
    }
}

#[tauri::command]
pub fn get_screen_bounds(app: AppHandle) -> Result<ScreenBoundsResponse, String> {
    let bounds = available_desktop_bounds()?;
    let scale_factor = app
        .get_webview_window("ocr-overlay")
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);

    Ok(response_for(bounds, scale_factor))
}

#[tauri::command]
pub fn hide_floating_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("floating") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn start_window_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
pub fn get_clipboard_text(app: AppHandle) -> Result<String, String> {
    app.clipboard()
        .read_text()
        .map_err(|error| format!("Failed to read clipboard: {error}"))
}

#[tauri::command]
pub fn clipboard_detect(app: AppHandle, text: String) {
    if let Some(window) = app.get_webview_window("floating") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("shortcut-triggered", text);
    }
}

pub fn show_ocr_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window("ocr-overlay") else {
        return;
    };
    let Ok(bounds) = available_desktop_bounds() else {
        return;
    };

    let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
    let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_union_covers_negative_and_positive_monitor_coordinates() {
        let displays = [
            DisplayRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            DisplayRect {
                x: -1280,
                y: -200,
                width: 1280,
                height: 1024,
            },
            DisplayRect {
                x: 1920,
                y: 100,
                width: 2560,
                height: 1440,
            },
        ];

        assert_eq!(
            desktop_bounds(&displays),
            Some(DesktopBounds {
                x: -1280,
                y: -200,
                width: 5760,
                height: 1740,
                count: 3,
            })
        );
    }

    #[test]
    fn response_keeps_physical_bounds_and_reports_logical_size() {
        let response = response_for(
            DesktopBounds {
                x: -1920,
                y: 0,
                width: 3840,
                height: 2160,
                count: 2,
            },
            1.5,
        );

        assert_eq!(response.x, -1920);
        assert_eq!(response.width, 2560.0);
        assert_eq!(response.height, 1440.0);
        assert_eq!(response.physical_width, 3840);
        assert_eq!(response.physical_height, 2160);
        assert_eq!(response.factor, 1.5);
    }

    #[test]
    fn empty_desktop_is_rejected_and_invalid_scale_is_sanitized() {
        assert_eq!(desktop_bounds(&[]), None);

        let response = response_for(
            DesktopBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                count: 1,
            },
            f64::NAN,
        );
        assert_eq!(response.factor, 1.0);
        assert_eq!(response.width, 1920.0);
    }
}
