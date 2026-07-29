use crate::lifecycle::{self, MainWindowControl, TrayMenuAction};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

impl<R: Runtime> MainWindowControl for tauri::WebviewWindow<R> {
    fn show(&self) -> Result<(), String> {
        tauri::WebviewWindow::show(self).map_err(|error| error.to_string())
    }

    fn unminimize(&self) -> Result<(), String> {
        tauri::WebviewWindow::unminimize(self).map_err(|error| error.to_string())
    }

    fn focus(&self) -> Result<(), String> {
        self.set_focus().map_err(|error| error.to_string())
    }

    fn hide(&self) -> Result<(), String> {
        tauri::WebviewWindow::hide(self).map_err(|error| error.to_string())
    }
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = lifecycle::recover_main_window(&window);
    }
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_dashboard = MenuItem::with_id(
        app,
        "show_dashboard",
        "Settings / 显示设置",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit / 退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_dashboard, &quit])?;
    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Application tray icon is not configured",
        )
    })?;

    let _ = TrayIconBuilder::with_id("tray")
        .tooltip("Long翻译 · AI Smart Assistant")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(move |app: &AppHandle<R>, event| {
            match TrayMenuAction::from_id(event.id.as_ref()) {
                TrayMenuAction::Restore => show_main_window(app),
                TrayMenuAction::Quit => {
                    std::process::exit(0);
                }
                TrayMenuAction::Ignore => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
