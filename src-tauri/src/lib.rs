mod db;
mod ocr;
mod tray;

use tauri::{AppHandle, Manager, Emitter, Runtime, WindowEvent, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, Modifiers, Code};
use tauri_plugin_clipboard_manager::ClipboardExt;
use base64::{Engine as _, engine::general_purpose};
use enigo::{Enigo, Key, Keyboard, Settings, Direction};
use std::thread;
use std::time::Duration;
use std::fs;
use std::path::PathBuf;
use sha2::{Sha256, Digest};

#[tauri::command]
fn hide_floating_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("floating") { let _ = win.hide(); }
}

#[tauri::command]
fn start_window_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
async fn run_ocr(image_base64: String) -> Result<String, String> {
    let bytes = general_purpose::STANDARD.decode(image_base64).map_err(|e| e.to_string())?;
    ocr::run_ocr(bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn capture_and_ocr(
    app: AppHandle, 
    x: i32, y: i32, w: u32, h: u32
) -> Result<String, String> {
    let bytes = ocr::capture_rect(x, y, w, h).map_err(|e| e.to_string())?;
    let text = ocr::run_ocr(bytes).await.map_err(|e| e.to_string())?;
    
    if let Some(overlay) = app.get_webview_window("ocr-overlay") { let _ = overlay.hide(); }
    if let Some(floating) = app.get_webview_window("floating") {
        let _ = floating.show();
        let _ = floating.set_focus();
        app.emit("ocr-triggered", text.clone()).unwrap();
    }
    Ok(text)
}

#[tauri::command]
fn check_word_exists(app: AppHandle, word: String) -> Result<bool, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT 1 FROM wordbook WHERE word = ?1").map_err(|e| e.to_string())?;
    Ok(stmt.exists([word]).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn add_to_wordbook(app: AppHandle, word: String, phonetic: Option<String>, meaning: Option<String>, analysis: Option<String>) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;

    // Check if word already exists and not deleted
    let existing_uuid: Option<String> = conn.query_row(
        "SELECT uuid FROM wordbook WHERE word = ?1 AND is_deleted = 0",
        [&word],
        |row| row.get(0)
    ).optional().map_err(|e| e.to_string())?;

    if existing_uuid.is_some() {
        return Ok(()); // Already exists
    }

    let uuid = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)",
        [uuid, word, phonetic.unwrap_or_default(), meaning.unwrap_or_default(), analysis.unwrap_or_default()],
    ).map_err(|e| e.to_string())?;
    app.emit("wordbook-updated", "local").unwrap();
    Ok(())
}

#[tauri::command]
fn update_word_analysis(app: AppHandle, word: String, phonetic: String, meaning: String, analysis: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE wordbook SET phonetic = ?1, meaning = ?2, analysis_json = ?3, updated_at = CURRENT_TIMESTAMP WHERE word = ?4",
        [phonetic, meaning, analysis, word],
    ).map_err(|e| e.to_string())?;
    app.emit("wordbook-updated", "local").unwrap();
    Ok(())
}

#[tauri::command]
fn get_wordbook(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, word, phonetic, meaning, analysis_json, created_at, uuid FROM wordbook WHERE is_deleted = 0 ORDER BY created_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "id": row.get::<_, i32>(0)?,
            "word": row.get::<_, String>(1)?,
            "phonetic": row.get::<_, String>(2)?,
            "meaning": row.get::<_, String>(3)?,
            "analysis": row.get::<_, String>(4)?,
            "created_at": row.get::<_, String>(5)?,
            "uuid": row.get::<_, String>(6)?,
        }))
    }).map_err(|e| e.to_string())?;
    let mut words = Vec::new();
    for row in rows { words.push(row.map_err(|e| e.to_string())?); }
    Ok(words)
}

#[tauri::command]
fn delete_word(app: AppHandle, id: i32) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute("UPDATE wordbook SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    app.emit("wordbook-updated", "local").unwrap();
    Ok(())
}

#[tauri::command]
fn set_config_value(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    db::set_config(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config_value(app: AppHandle, key: String) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    db::get_config(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_clipboard_text(app: AppHandle) -> Result<String, String> {
    let clipboard = app.clipboard();
    clipboard.read_text().map_err(|e| e.to_string())
}

fn get_audio_cache_dir(app: &AppHandle) -> PathBuf {
    let mut path = app.path().app_cache_dir().expect("Failed to get cache dir");
    path.push("audio_cache");
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    path
}

#[tauri::command]
fn check_audio_cache(app: AppHandle, cache_key: String) -> Result<bool, String> {
    let cache_dir = get_audio_cache_dir(&app);
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    let hash = hex::encode(hasher.finalize());
    let cache_path = cache_dir.join(format!("{}.cache", hash));
    Ok(cache_path.exists())
}

#[tauri::command]
async fn proxy_fetch_audio(app: AppHandle, url: String, cache_key: Option<String>) -> Result<Vec<u8>, String> {
    let cache_dir = get_audio_cache_dir(&app);
    let key_to_hash = cache_key.clone().unwrap_or_else(|| url.clone());
    let mut hasher = Sha256::new();
    hasher.update(key_to_hash.as_bytes());
    let hash = hex::encode(hasher.finalize());
    let cache_path = cache_dir.join(format!("{}.cache", hash));

    if cache_path.exists() {
        if let Ok(bytes) = fs::read(&cache_path) {
            return Ok(bytes);
        }
    }

    if url.is_empty() { return Err("Cache miss and no URL provided".to_string()); }

    let client = reqwest::Client::new();
    let response = client.get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let bytes = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.len() > 100 { let _ = fs::write(&cache_path, &bytes); }
    Ok(bytes)
}

#[tauri::command]
fn get_audio_cache_size(app: AppHandle) -> Result<String, String> {
    let cache_dir = get_audio_cache_dir(&app);
    let mut size = 0u64;
    if let Ok(entries) = fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() { size += meta.len(); }
        }
    }
    
    if size < 1024 { Ok(format!("{} B", size)) }
    else if size < 1024 * 1024 { Ok(format!("{:.2} KB", size as f64 / 1024.0)) }
    else { Ok(format!("{:.2} MB", size as f64 / (1024.0 * 1024.0))) }
}

#[tauri::command]
fn clear_audio_cache(app: AppHandle) -> Result<(), String> {
    let cache_dir = get_audio_cache_dir(&app);
    let _ = fs::remove_dir_all(&cache_dir);
    let _ = fs::create_dir_all(&cache_dir);
    Ok(())
}

fn handle_translate_request<R: Runtime>(app: &AppHandle<R>) {
    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        let clipboard = app_handle.clipboard();
        let original_text = clipboard.read_text().unwrap_or_default();
        let token = "__DETECT_TOKEN__";
        let _ = clipboard.write_text(token.to_string());

        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        let _ = enigo.key(Key::Control, Direction::Press);
        thread::sleep(Duration::from_millis(50));
        let _ = enigo.key(Key::C, Direction::Press);
        thread::sleep(Duration::from_millis(100));
        let _ = enigo.key(Key::C, Direction::Release);
        thread::sleep(Duration::from_millis(50));
        let _ = enigo.key(Key::Control, Direction::Release);
        
        let mut final_text = String::new();
        let mut success = false;
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(50));
            let current = clipboard.read_text().unwrap_or_default();
            if current != token && !current.trim().is_empty() {
                final_text = current;
                success = true;
                break;
            }
        }

        if !success {
            let _ = clipboard.write_text(original_text.clone());
            final_text = original_text;
        }

        if !final_text.trim().is_empty() {
            if let Some(floating) = app_handle.get_webview_window("floating") {
                let _ = floating.show();
                let _ = floating.set_focus();
                let _ = app_handle.emit("shortcut-triggered", final_text);
            }
        }
    });
}

#[tauri::command]
async fn sync_wordbook(app: AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    
    // 1. Get WebDAV Config (scoped to drop conn before await)
    let (url, user, pass, is_enabled) = {
        let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
        let url = db::get_config(&conn, "webdav_url").unwrap_or_default();
        let user = db::get_config(&conn, "webdav_user").unwrap_or_default();
        let pass = db::get_config(&conn, "webdav_pass").unwrap_or_default();
        let is_enabled = db::get_config(&conn, "webdav_enabled").unwrap_or_default() == "true";
        (url, user, pass, is_enabled)
    };

    if !is_enabled || url.is_empty() { return Ok(()); }

    let client = reqwest::Client::new();
    let sync_file_url = format!("{}/wordbook_sync.json", url.trim_end_matches('/'));

    // 2. Download remote data
    let mut remote_data: Vec<serde_json::Value> = Vec::new();
    let resp = client.get(&sync_file_url)
        .basic_auth(&user, Some(&pass))
        .send()
        .await;

    if let Ok(r) = resp {
        if r.status().is_success() {
            remote_data = r.json().await.unwrap_or_default();
        } else if r.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("WebDAV Authorization Failed".to_string());
        }
    }

    // 3. Merge and Fetch Local (scoped to drop conn and stmt before await)
    let local_items: Vec<serde_json::Value> = {
        let mut conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // Merge Cloud to Local
        for item in remote_data {
            let uuid = item["uuid"].as_str().unwrap_or_default();
            let updated_at = item["updated_at"].as_str().unwrap_or_default();
            let is_deleted = item["is_deleted"].as_i64().unwrap_or(0);

            let local_updated_at: Option<String> = tx.query_row(
                "SELECT updated_at FROM wordbook WHERE uuid = ?1",
                [uuid],
                |row| row.get(0)
            ).optional().map_err(|e| e.to_string())?;

            match local_updated_at {
                Some(local_time) if updated_at > local_time.as_str() => {
                    tx.execute(
                        "UPDATE wordbook SET word = ?1, phonetic = ?2, meaning = ?3, analysis_json = ?4, is_deleted = ?5, updated_at = ?6 WHERE uuid = ?7",
                        (
                            item["word"].as_str().unwrap_or_default(),
                            item["phonetic"].as_str().unwrap_or_default(),
                            item["meaning"].as_str().unwrap_or_default(),
                            item["analysis"].as_str().unwrap_or_default(),
                            is_deleted,
                            updated_at,
                            uuid
                        )
                    ).map_err(|e| e.to_string())?;
                },
                None => {
                    tx.execute(
                        "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        (
                            uuid,
                            item["word"].as_str().unwrap_or_default(),
                            item["phonetic"].as_str().unwrap_or_default(),
                            item["meaning"].as_str().unwrap_or_default(),
                            item["analysis"].as_str().unwrap_or_default(),
                            is_deleted,
                            updated_at
                        )
                    ).map_err(|e| e.to_string())?;
                },
                _ => {}
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        // Fetch all for upload
        let mut stmt = conn.prepare("SELECT uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at FROM wordbook").map_err(|e| e.to_string())?;
        let items = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "uuid": row.get::<_, String>(0)?,
                "word": row.get::<_, String>(1)?,
                "phonetic": row.get::<_, String>(2)?,
                "meaning": row.get::<_, String>(3)?,
                "analysis": row.get::<_, String>(4)?,
                "is_deleted": row.get::<_, i64>(5)?,
                "updated_at": row.get::<_, String>(6)?,
            }))
        }).map_err(|e| e.to_string())?.map(|r| r.unwrap()).collect();
        items
    };

    // 4. Export to cloud
    let upload_resp = client.put(&sync_file_url)
        .basic_auth(&user, Some(&pass))
        .json(&local_items)
        .send()
        .await
        .map_err(|e| format!("Upload failed: {}", e))?;

    if !upload_resp.status().is_success() {
        if upload_resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(format!("同步失败：网盘路径不存在。\n请确保文件夹已手动创建。\n请求路径: {}", sync_file_url));
        }
        if upload_resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("同步失败：网盘账号或应用密码错误。".to_string());
        }
        return Err(format!("同步失败 (HTTP {}): {}", upload_resp.status(), sync_file_url));
    }

    // Save sync time
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    {
        let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
        db::set_config(&conn, "last_sync_time", &now).map_err(|e| e.to_string())?;
    }

    app.emit("wordbook-updated", "sync").unwrap();
    Ok(())
}

#[tauri::command]
fn increment_translate_count(app: AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let count_str = db::get_config(&conn, "translated_count").unwrap_or_default();
    let count: i32 = count_str.parse().unwrap_or(0);
    db::set_config(&conn, "translated_count", &(count + 1).to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_app_stats(app: AppHandle) -> Result<serde_json::Value, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    
    // 1. Wordbook count
    let word_count: i32 = conn.query_row("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    
    // 2. Translated count
    let trans_count: i32 = db::get_config(&conn, "translated_count").unwrap_or_default().parse().unwrap_or(0);
    
    // 3. Days active
    let install_date_str = db::get_config(&conn, "install_date").unwrap_or_default();
    let days = if !install_date_str.is_empty() {
        let install_date = chrono::NaiveDate::parse_from_str(&install_date_str, "%Y-%m-%d").unwrap_or_else(|_| chrono::Local::now().date_naive());
        let now = chrono::Local::now().date_naive();
        (now - install_date).num_days() + 1
    } else { 1 };

    Ok(serde_json::json!({
        "word_count": word_count,
        "trans_count": trans_count,
        "days_active": days
    }))
}

use rusqlite::OptionalExtension;

fn migrate_old_data(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let new_data_dir = app.path().app_data_dir()?;
    let old_identifier = "com.ai.trans.assistant";
    
    // 构造旧路径：将新路径最后的标识符部分替换为旧标识符
    let old_data_dir = if let Some(parent) = new_data_dir.parent() {
        parent.join(old_identifier)
    } else {
        return Ok(());
    };

    // 关键修复：数据库文件名为 words.db，而不是 app.db
    let new_db_path = new_data_dir.join("words.db");
    let old_db_path = old_data_dir.join("words.db");

    println!("[Migration] New Dir: {:?}", new_data_dir);
    println!("[Migration] Old Dir: {:?}", old_data_dir);

    // 如果新目录已存在有效数据库文件，说明不需要迁移
    if new_db_path.exists() && fs::metadata(&new_db_path)?.len() > 0 {
        println!("[Migration] New database already exists, skipping migration.");
        return Ok(());
    }

    // 如果旧目录存在且包含数据库，则执行迁移
    if old_data_dir.exists() && old_db_path.exists() {
        println!("[Migration] Found old data. Starting migration...");
        if !new_data_dir.exists() {
            fs::create_dir_all(&new_data_dir)?;
        }
        
        // 递归复制所有内容
        if let Err(e) = copy_dir_all(&old_data_dir, &new_data_dir) {
            println!("[Migration] Error during copying: {:?}", e);
        } else {
            println!("[Migration] Successfully migrated data to new directory.");
        }
    } else {
        println!("[Migration] Old data not found at {:?}. Skipping.", old_db_path);
    }

    Ok(())
}

fn copy_dir_all(src: impl AsRef<std::path::Path>, dst: impl AsRef<std::path::Path>) -> std::io::Result<()> {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 执行数据迁移
            let _ = migrate_old_data(app);

            let app_handle = app.handle().clone();
            tray::create_tray(&app_handle)?;
            let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            let _conn = db::init_db(app_dir).expect("Failed to initialize database");
            
            let main_win = app.get_webview_window("main").unwrap();
            let main_win_clone = main_win.clone();
            main_win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_win_clone.hide();
                }
            });

            let global_shortcut = app.global_shortcut();
            let q_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyQ);
            global_shortcut.on_shortcut(q_shortcut, move |app, _shortcut, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    handle_translate_request(app);
                }
            }).unwrap();

            let w_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyW);
            global_shortcut.on_shortcut(w_shortcut, move |app, _shortcut, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    if let Some(overlay) = app.get_webview_window("ocr-overlay") {
                        let _ = overlay.show();
                        let _ = overlay.set_focus();
                    }
                }
            }).unwrap();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_ocr, capture_and_ocr, get_clipboard_text, set_config_value, get_config_value,
            hide_floating_window, start_window_drag, add_to_wordbook, get_wordbook, delete_word,
            check_word_exists, update_word_analysis, proxy_fetch_audio, get_audio_cache_size,
            clear_audio_cache, check_audio_cache, sync_wordbook, increment_translate_count, get_app_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
