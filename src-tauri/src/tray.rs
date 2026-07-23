use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_dashboard = MenuItem::with_id(app, "show_dashboard", "Settings / 显示设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit / 退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_dashboard, &quit])?;

    let _ = TrayIconBuilder::with_id("tray")
        .tooltip("Long翻译 · AI Smart Assistant")
        .icon(app.default_window_icon().expect("App icon not configured").clone())
        .menu(&menu)
        .on_menu_event(move |app: &AppHandle<R>, event| match event.id.as_ref() {
            "show_dashboard" => show_main_window(app),
            "quit" => {
                std::process::exit(0);
            }
            _ => {}
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
