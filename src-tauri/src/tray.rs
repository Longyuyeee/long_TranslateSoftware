use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_dashboard = MenuItem::with_id(app, "show_dashboard", "显示设置 (Reload)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_dashboard, &quit])?;

    let _ = TrayIconBuilder::with_id("tray")
        .tooltip("AI 翻译助手")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(move |app: &AppHandle<R>, event| match event.id.as_ref() {
            "show_dashboard" => {
                if let Some(window) = app.get_webview_window("main") {
                    // 核心修复：强制重新加载 URL，解决 Localhost 拒绝连接
                    let _ = window.eval("window.location.reload()");
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
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
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
        })
        .build(app)?;

    Ok(())
}
