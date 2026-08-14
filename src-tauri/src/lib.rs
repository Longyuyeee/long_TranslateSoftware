mod anki;
mod app_stats;
mod backup;
pub mod browser_pairing;
mod command_error;
mod config;
mod db;
pub mod desktop_ipc;
mod diagnostics;
mod document;
mod document_checkpoint;
mod document_rebuild;
mod glossary;
mod history;
mod lifecycle;
pub mod native_host;
pub mod native_protocol;
pub mod native_registration;
mod ocr;
mod review;
mod secure_config;
mod shortcuts;
mod system_integration;
mod tray;
mod tts;
mod updater;
mod webdav;
mod wordbook;

use std::fs;
use tauri::{Manager, WindowEvent};

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
            if let Err(error) = document_checkpoint::cleanup_document_checkpoints_in(&app_dir) {
                log::warn!("Document checkpoint cleanup was skipped: {}", error.message);
            }
            #[cfg(windows)]
            match browser_pairing::BrowserPairingManager::load(app_handle.clone(), &app_dir) {
                Ok(manager) => {
                    let manager = std::sync::Arc::new(manager);
                    match desktop_ipc::start_server(app_dir.clone(), manager.clone()) {
                        Ok(ipc_state) => {
                            app.manage(ipc_state);
                        }
                        Err(error) => {
                            log::error!("Desktop browser IPC is unavailable: {error}");
                        }
                    }
                    app.manage(manager);
                }
                Err(error) => {
                    log::error!("Browser pairing storage is unavailable: {error}");
                }
            }
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
            ocr::run_ocr,
            ocr::capture_and_ocr,
            ocr::confirm_ocr_text,
            ocr::get_available_ocr_languages,
            system_integration::get_screen_bounds,
            system_integration::get_clipboard_text,
            config::set_config_value,
            config::get_config_value,
            config::get_config_values,
            config::set_config_values,
            updater::updater_configured,
            diagnostics::export_diagnostics,
            document::pick_docx_document,
            document::inspect_docx_document,
            document_checkpoint::save_document_checkpoint,
            document_checkpoint::load_document_checkpoint,
            document_checkpoint::delete_document_checkpoint,
            document_checkpoint::cleanup_document_checkpoints,
            document_rebuild::validate_docx_rebuild_plan,
            document_rebuild::rebuild_docx_document,
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
            glossary::update_glossary_entry,
            browser_pairing::approve_browser_pairing,
            browser_pairing::reject_browser_pairing,
            browser_pairing::get_browser_pairings,
            browser_pairing::revoke_browser_pairing,
            browser_pairing::complete_browser_translation,
            browser_pairing::set_browser_translation_bridge_ready
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("Long Translate failed to start: {error}");
    }
}

pub fn lifecycle_probe_output(args: &[String]) -> Option<String> {
    lifecycle::probe_output(args)
}
