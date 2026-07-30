mod anki;
mod app_stats;
mod backup;
mod config;
mod db;
mod diagnostics;
mod glossary;
mod history;
mod lifecycle;
pub mod native_protocol;
mod ocr;
mod review;
mod secure_config;
mod shortcuts;
mod system_integration;
mod tray;
mod tts;
mod webdav;
mod wordbook;

use base64::{engine::general_purpose, Engine as _};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))
}

#[tauri::command]
fn updater_configured(app: AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty() && !key.contains("REPLACE_WITH"))
}

#[tauri::command]
fn export_diagnostics(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|error| error.to_string())?;
    let report = diagnostics::build_report(
        &conn,
        &app.package_info().version.to_string(),
        updater_configured(app.clone()),
    )?;
    let contents = serde_json::to_vec_pretty(&report)
        .map_err(|error| format!("Cannot serialize diagnostic report: {error}"))?;
    let file_name = format!(
        "LongTranslate_Diagnostics_{}.json",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    let file_path = app
        .dialog()
        .file()
        .set_title("Export privacy-safe diagnostics")
        .add_filter("JSON diagnostic report", &["json"])
        .set_file_name(file_name)
        .blocking_save_file()
        .ok_or_else(|| "User cancelled".to_string())?;
    let path = match file_path {
        tauri_plugin_dialog::FilePath::Path(path) => path,
        tauri_plugin_dialog::FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "The selected diagnostic destination is not a local file".to_string())?,
    };
    fs::write(&path, contents)
        .map_err(|error| format!("Cannot write diagnostic report: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn run_ocr(app: AppHandle, image_base64: String) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|error| error.to_string())?;
    let ocr_lang = db::get_config(&conn, "ocr_lang").unwrap_or_default();
    let bytes = general_purpose::STANDARD
        .decode(image_base64)
        .map_err(|error| error.to_string())?;
    ocr::run_ocr(bytes, &ocr_lang)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn capture_and_ocr(app: AppHandle, x: i32, y: i32, w: u32, h: u32) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|error| error.to_string())?;
    let ocr_lang = db::get_config(&conn, "ocr_lang").unwrap_or_default();
    let bytes = ocr::capture_rect(x, y, w, h).map_err(|error| error.to_string())?;
    ocr::run_ocr(bytes, &ocr_lang)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn confirm_ocr_text(app: AppHandle, text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("OCR text is empty".to_string());
    }

    if let Some(overlay) = app.get_webview_window("ocr-overlay") {
        let _ = overlay.hide();
    }
    if let Some(floating) = app.get_webview_window("floating") {
        let _ = floating.show();
        let _ = floating.set_focus();
    }
    app.emit("ocr-triggered", text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_available_ocr_languages() -> Result<Vec<ocr::OcrLanguageInfo>, String> {
    ocr::available_ocr_languages().map_err(|error| error.to_string())
}

fn migrate_old_data(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let new_data_dir = app.path().app_data_dir()?;
    let old_data_dir = if let Some(parent) = new_data_dir.parent() {
        parent.join("com.ai.trans.assistant")
    } else {
        return Ok(());
    };
    let new_db_path = new_data_dir.join("words.db");
    let old_db_path = old_data_dir.join("words.db");

    if new_db_path.exists() && fs::metadata(&new_db_path)?.len() > 0 {
        return Ok(());
    }
    if old_data_dir.exists() && old_db_path.exists() {
        if !new_data_dir.exists() {
            fs::create_dir_all(&new_data_dir)?;
        }
        let _ = copy_dir_all(&old_data_dir, &new_data_dir);
    }
    Ok(())
}

fn copy_dir_all(
    src: impl AsRef<std::path::Path>,
    dst: impl AsRef<std::path::Path>,
) -> std::io::Result<()> {
    fs::create_dir_all(&dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(entry.path(), dst.as_ref().join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.as_ref().join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if lifecycle::LaunchMode::from_args(&args).should_restore_main_window() {
                tray::show_main_window(app);
            }
        }));
    }

    if let Err(error) = builder
        .manage(shortcuts::ShortcutState::default())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let _ = migrate_old_data(app);
            let app_handle = app.handle().clone();
            tray::create_tray(&app_handle)?;
            let app_dir = app.path().app_data_dir()?;
            let conn = db::init_db(app_dir)?;
            let main_win = app.get_webview_window("main").ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Main application window is not configured",
                )
            })?;
            let main_win_clone = main_win.clone();
            main_win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = lifecycle::hide_main_window(&main_win_clone);
                }
            });
            let launch_args = std::env::args().collect::<Vec<_>>();
            if lifecycle::LaunchMode::from_args(&launch_args).should_restore_main_window() {
                tray::show_main_window(&app_handle);
            }
            shortcuts::register_saved_shortcuts(app.handle(), &conn);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_ocr,
            capture_and_ocr,
            confirm_ocr_text,
            get_available_ocr_languages,
            system_integration::get_screen_bounds,
            system_integration::get_clipboard_text,
            config::set_config_value,
            config::get_config_value,
            config::get_config_values,
            config::set_config_values,
            updater_configured,
            export_diagnostics,
            system_integration::hide_floating_window,
            system_integration::start_window_drag,
            system_integration::clipboard_detect,
            wordbook::add_to_wordbook,
            wordbook::get_wordbook,
            wordbook::get_wordbook_page,
            wordbook::delete_word,
            wordbook::check_word_exists,
            wordbook::update_word_analysis,
            tts::proxy_fetch_audio,
            tts::get_audio_cache_size,
            tts::clear_audio_cache,
            tts::check_audio_cache,
            webdav::sync_wordbook,
            webdav::test_webdav_connection,
            app_stats::increment_translate_count,
            app_stats::get_app_stats,
            shortcuts::update_shortcut,
            shortcuts::set_shortcuts_paused,
            backup::export_data,
            backup::import_data,
            tts::save_audio_cache,
            history::save_translation,
            history::get_translation_history,
            history::delete_translation,
            history::clear_translation_history,
            wordbook::export_wordbook,
            history::lookup_translation_memory,
            history::save_translation_memory,
            review::get_due_reviews,
            review::submit_review,
            review::get_review_stats,
            anki::export_anki,
            glossary::add_glossary_entry,
            glossary::get_glossary_entries,
            glossary::delete_glossary_entry,
            glossary::update_glossary_entry
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("Long Translate failed to start: {error}");
    }
}

pub fn lifecycle_probe_output(args: &[String]) -> Option<String> {
    lifecycle::probe_output(args)
}
