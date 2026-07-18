mod db;
mod ocr;
mod tray;

use tauri::{AppHandle, Manager, Emitter, Runtime, WindowEvent, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, Modifiers, Code, ShortcutState};
use tauri_plugin_clipboard_manager::ClipboardExt;
use base64::{Engine as _, engine::general_purpose};
use enigo::{Enigo, Key, Keyboard, Settings, Direction};
use std::thread;
use std::time::Duration;
use std::fs;
use std::path::PathBuf;
use sha2::{Sha256, Digest};
use rusqlite::OptionalExtension;
use std::io::Write;
use std::sync::Mutex;
use aes_gcm::{Aes256Gcm, AeadCore, Nonce, aead::{Aead, KeyInit, OsRng}};
use argon2::Argon2;
use futures_util::{StreamExt, SinkExt};
use tokio_tungstenite::{
    connect_async, 
    tungstenite::{
        protocol::Message,
        client::IntoClientRequest
    }
};
const BACKUP_KEY: &[u8; 32] = b"LONG-TRANS-PRIVATE-KEY-2024-MARC";
const BACKUP_V3_MAGIC: &[u8; 4] = b"TLB3";

fn derive_legacy_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(salt);
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    key
}

fn derive_backup_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

fn encrypt_backup_payload(payload: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let salt = uuid::Uuid::new_v4();
    let key = derive_backup_key(password, salt.as_bytes())?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut rng = OsRng;
    let nonce = Aes256Gcm::generate_nonce(&mut rng);
    let mut ciphertext = cipher.encrypt(&nonce, payload).map_err(|e| format!("Encryption error: {e}"))?;

    let mut output = Vec::with_capacity(4 + 16 + 12 + ciphertext.len());
    output.extend_from_slice(BACKUP_V3_MAGIC);
    output.extend_from_slice(salt.as_bytes());
    output.extend_from_slice(&nonce);
    output.append(&mut ciphertext);
    Ok(output)
}

fn decrypt_backup_payload(file_data: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if file_data.starts_with(BACKUP_V3_MAGIC) {
        if file_data.len() < 48 { return Err("Invalid v3 backup file".to_string()); }
        let salt = &file_data[4..20];
        let nonce = Nonce::from_slice(&file_data[20..32]);
        let key = derive_backup_key(password, salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        return cipher.decrypt(nonce, &file_data[32..])
            .map_err(|_| "Decryption failed: invalid password or damaged backup".to_string());
    }

    // v2 backups used salt(16) + nonce(12) + AES-GCM with a single SHA-256 KDF.
    let v2_plaintext = if file_data.len() >= 28 {
        let salt = &file_data[..16];
        let nonce = Nonce::from_slice(&file_data[16..28]);
        let key = derive_legacy_key(password, salt);
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        cipher.decrypt(nonce, &file_data[28..]).ok()
    } else { None };
    if let Some(plaintext) = v2_plaintext { return Ok(plaintext); }

    // v0/v1 compatibility: historical backups used a bundled application key.
    let cipher = Aes256Gcm::new_from_slice(BACKUP_KEY).map_err(|e| e.to_string())?;
    let plaintext = if file_data.len() >= 12 {
        let nonce = Nonce::from_slice(&file_data[..12]);
        cipher.decrypt(nonce, &file_data[12..]).ok()
    } else { None }
    .or_else(|| {
        let nonce = Nonce::from_slice(b"UNIQUE-NONCE");
        cipher.decrypt(nonce, file_data).ok()
    });
    plaintext.ok_or_else(|| "Decryption failed: invalid password or file format".to_string())
}

const SENSITIVE_KEYS: &[&str] = &["trans_api_key", "openai_api_key", "backup_api_key", "tts_api_key", "webdav_pass"];

fn is_sensitive_key(key: &str) -> bool {
    SENSITIVE_KEYS.contains(&key)
}

fn get_device_key(app_dir: &std::path::Path) -> [u8; 32] {
    let path_str = app_dir.to_string_lossy();
    let mut hasher = Sha256::new();
    hasher.update(path_str.as_bytes());
    hasher.update(b"LONG-TRANS-DEVICE-SALT");
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    key
}

fn encrypt_value(value: &str, device_key: &[u8; 32]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|e| e.to_string())?;
    let mut rng = OsRng;
    let nonce = Aes256Gcm::generate_nonce(&mut rng);
    let ciphertext = cipher.encrypt(&nonce, value.as_bytes()).map_err(|e| format!("encrypt: {}", e))?;
    let mut output = nonce.to_vec();
    output.extend_from_slice(&ciphertext);
    Ok(format!("ENC:{}", general_purpose::STANDARD.encode(&output)))
}

fn decrypt_value(encrypted: &str, device_key: &[u8; 32]) -> Result<String, String> {
    let enc_str = encrypted.strip_prefix("ENC:").ok_or("Not an encrypted value")?;
    let data = general_purpose::STANDARD.decode(enc_str).map_err(|e| e.to_string())?;
    if data.len() < 12 { return Err("Invalid encrypted data".to_string()); }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|e| e.to_string())?;
    let plaintext = cipher.decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Decryption failed".to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

struct AppState {
    shortcuts_paused: Mutex<bool>,
    clipboard_lock: Mutex<bool>,
}

#[tauri::command]
fn set_shortcuts_paused(state: tauri::State<AppState>, paused: bool) {
    let mut p = state.shortcuts_paused.lock().unwrap();
    *p = paused;
}

#[tauri::command]
fn get_screen_bounds(app: AppHandle) -> Result<serde_json::Value, String> {
    let screens = screenshots::Screen::all().map_err(|e| e.to_string())?;
    let mut min_x = 0i32; let mut min_y = 0i32;
    let mut max_x = 0i32; let mut max_y = 0i32;
    for s in &screens {
        let d = &s.display_info;
        if d.x < min_x { min_x = d.x; }
        if d.y < min_y { min_y = d.y; }
        let right = d.x + d.width as i32;
        let bottom = d.y + d.height as i32;
        if right > max_x { max_x = right; }
        if bottom > max_y { max_y = bottom; }
    }
    // Get scale factor from primary screen
    let factor = if let Some(win) = app.get_webview_window("ocr-overlay") {
        win.scale_factor().unwrap_or(1.0)
    } else { 1.0 };
    Ok(serde_json::json!({
        "x": min_x, "y": min_y,
        "width": (max_x - min_x) as f64 / factor,
        "height": (max_y - min_y) as f64 / factor,
        "physical_x": min_x, "physical_y": min_y,
        "physical_width": max_x - min_x,
        "physical_height": max_y - min_y,
        "factor": factor,
        "count": screens.len()
    }))
}

#[tauri::command]
fn hide_floating_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("floating") { let _ = win.hide(); }
}

#[tauri::command]
fn updater_configured(app: AppHandle) -> bool {
    app.config().plugins.0.get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty() && !key.contains("REPLACE_WITH"))
}

fn parse_shortcut(shortcut_str: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = shortcut_str.split('+').collect();
    let mut mods = Modifiers::empty();
    let mut key_code = None;

    for part in parts {
        match part.to_uppercase().as_str() {
            "CTRL" | "CONTROL" => mods.insert(Modifiers::CONTROL),
            "ALT" => mods.insert(Modifiers::ALT),
            "SHIFT" => mods.insert(Modifiers::SHIFT),
            "SUPER" | "COMMAND" | "WIN" => mods.insert(Modifiers::SUPER),
            key => {
                let code = match key {
                    "A" => Code::KeyA, "B" => Code::KeyB, "C" => Code::KeyC, "D" => Code::KeyD,
                    "E" => Code::KeyE, "F" => Code::KeyF, "G" => Code::KeyG, "H" => Code::KeyH,
                    "I" => Code::KeyI, "J" => Code::KeyJ, "K" => Code::KeyK, "L" => Code::KeyL,
                    "M" => Code::KeyM, "N" => Code::KeyN, "O" => Code::KeyO, "P" => Code::KeyP,
                    "Q" => Code::KeyQ, "R" => Code::KeyR, "S" => Code::KeyS, "T" => Code::KeyT,
                    "U" => Code::KeyU, "V" => Code::KeyV, "W" => Code::KeyW, "X" => Code::KeyX,
                    "Y" => Code::KeyY, "Z" => Code::KeyZ,
                    "0" => Code::Digit0, "1" => Code::Digit1, "2" => Code::Digit2, "3" => Code::Digit3,
                    "4" => Code::Digit4, "5" => Code::Digit5, "6" => Code::Digit6, "7" => Code::Digit7,
                    "8" => Code::Digit8, "9" => Code::Digit9,
                    "F1" => Code::F1, "F2" => Code::F2, "F3" => Code::F3, "F4" => Code::F4,
                    "F5" => Code::F5, "F6" => Code::F6, "F7" => Code::F7, "F8" => Code::F8,
                    "F9" => Code::F9, "F10" => Code::F10, "F11" => Code::F11, "F12" => Code::F12,
                    _ => return Err(format!("Unsupported key: {}", key)),
                };
                key_code = Some(code);
            }
        }
    }

    if let Some(code) = key_code {
        Ok(Shortcut::new(Some(mods), code))
    } else {
        Err("No key specified".to_string())
    }
}

#[tauri::command]
fn update_shortcut(app: AppHandle, _state: tauri::State<AppState>, name: String, shortcut_str: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
    
    let old_shortcut_str = db::get_config(&conn, &format!("shortcut_{}", name)).unwrap_or_default();
    if !old_shortcut_str.is_empty() {
        if let Ok(old_s) = parse_shortcut(&old_shortcut_str) {
            let _ = app.global_shortcut().unregister(old_s);
        }
    }

    let new_s = parse_shortcut(&shortcut_str)?;
    let name_for_closure = name.clone();
    app.global_shortcut().on_shortcut(new_s, move |app, _shortcut, event| {
        let state = app.state::<AppState>();
        let paused = state.shortcuts_paused.lock().unwrap();
        if *paused { return; }

        if event.state() == ShortcutState::Pressed {
            if name_for_closure == "q" {
                handle_translate_request(app);
            } else {
                show_ocr_overlay(app);
            }
        }
    }).map_err(|e| format!("Shortcut registration failed: {}", e))?;

    db::set_config(&conn, &format!("shortcut_{}", name), &shortcut_str).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn export_data(app: AppHandle, password: String) -> Result<String, String> {
    if password.is_empty() { return Err("Password cannot be empty".to_string()); }

    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;

    let mut config_data = std::collections::HashMap::new();
    let mut stmt = conn.prepare("SELECT key, value FROM config").map_err(|e| e.to_string())?;
    let config_rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in config_rows {
        let (k, mut v) = row.map_err(|e| e.to_string())?;
        if is_sensitive_key(&k) && v.starts_with("ENC:") {
            let device_key = get_device_key(&app_dir);
            v = decrypt_value(&v, &device_key)
                .map_err(|_| format!("Cannot export protected setting '{k}' on this device"))?;
        }
        config_data.insert(k, v);
    }

    let mut wordbook_data = Vec::new();
    let mut stmt = conn.prepare("SELECT uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, difficulty FROM wordbook").map_err(|e| e.to_string())?;
    let word_rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "uuid": row.get::<_, String>(0)?,
            "word": row.get::<_, String>(1)?,
            "phonetic": row.get::<_, String>(2)?,
            "meaning": row.get::<_, String>(3)?,
            "analysis": row.get::<_, String>(4)?,
            "is_deleted": row.get::<_, i64>(5)?,
            "updated_at": row.get::<_, String>(6)?,
            "ease_factor": row.get::<_, f64>(7)?,
            "interval_days": row.get::<_, i32>(8)?,
            "repetitions": row.get::<_, i32>(9)?,
            "next_review": row.get::<_, Option<String>>(10)?,
            "last_reviewed": row.get::<_, Option<String>>(11)?,
            "stability": row.get::<_, f64>(12)?,
            "difficulty": row.get::<_, f64>(13)?,
        }))
    }).map_err(|e| e.to_string())?;
    for row in word_rows {
        wordbook_data.push(row.map_err(|e| e.to_string())?);
    }

    let full_json = serde_json::json!({
        "config": config_data,
        "wordbook": wordbook_data,
        "export_version": "3.0",
        "export_time": chrono::Local::now().to_rfc3339()
    });
    let json_str = serde_json::to_string(&full_json).map_err(|e| e.to_string())?;

    let output = encrypt_backup_payload(json_str.as_bytes(), &password)?;

    use tauri_plugin_dialog::DialogExt;
    let file_path = app.dialog().file().set_title("Export LongTranslate Backup").add_filter("LongTranslate Backup (*.TLong)", &["TLong"]).set_file_name("LongTranslate_Backup.TLong").blocking_save_file();

    if let Some(path) = file_path {
        let actual_path = match path {
            tauri_plugin_dialog::FilePath::Path(p) => p,
            tauri_plugin_dialog::FilePath::Url(u) => u.to_file_path().map_err(|_| "Invalid URL path")?,
        };
        std::fs::write(actual_path, &output).map_err(|e| e.to_string())?;
        return Ok("Export successful".to_string());
    }

    Err("User cancelled".to_string())
}

#[tauri::command]
async fn import_data(app: AppHandle, password: String) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    let file_path = app.dialog().file().set_title("Import LongTranslate Backup").add_filter("LongTranslate Backup (*.TLong)", &["TLong"]).blocking_pick_file();

    if let Some(path) = file_path {
        let actual_path = match path {
            tauri_plugin_dialog::FilePath::Path(p) => p,
            tauri_plugin_dialog::FilePath::Url(u) => u.to_file_path().map_err(|_| "Invalid URL path")?,
        };
        let file_data = std::fs::read(actual_path).map_err(|e| e.to_string())?;

        let plaintext = decrypt_backup_payload(&file_data, &password)?;
        let json_str = String::from_utf8(plaintext).map_err(|e| e.to_string())?;

        let full_json: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
        let is_portable_v3 = full_json["export_version"].as_str() == Some("3.0");

        let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
        {
            let mut conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            tx.execute("DELETE FROM config", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM wordbook", []).map_err(|e| e.to_string())?;

            if let Some(configs) = full_json["config"].as_object() {
                for (k, v) in configs {
                    let mut value = v.as_str().unwrap_or_default().to_string();
                    if is_portable_v3 && is_sensitive_key(k) && !value.is_empty() {
                        let device_key = get_device_key(&app_dir);
                        value = encrypt_value(&value, &device_key)?;
                    }
                    tx.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)", [k, &value]).map_err(|e| e.to_string())?;
                }
            }

            if let Some(words) = full_json["wordbook"].as_array() {
                for item in words {
                    tx.execute(
                        "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, difficulty) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        (
                            item["uuid"].as_str().unwrap_or_default(),
                            item["word"].as_str().unwrap_or_default(),
                            item["phonetic"].as_str().unwrap_or_default(),
                            item["meaning"].as_str().unwrap_or_default(),
                            item["analysis"].as_str().unwrap_or_default(),
                            item["is_deleted"].as_i64().unwrap_or(0),
                            item["updated_at"].as_str().unwrap_or_default(),
                            item["ease_factor"].as_f64().unwrap_or(2.5),
                            item["interval_days"].as_i64().unwrap_or(0),
                            item["repetitions"].as_i64().unwrap_or(0),
                            item["next_review"].as_str().unwrap_or(""),
                            item["last_reviewed"].as_str().unwrap_or(""),
                            item["stability"].as_f64().unwrap_or(0.0),
                            item["difficulty"].as_f64().unwrap_or(0.0),
                        )
                    ).map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        app.emit("wordbook-updated", "import").unwrap();
        app.emit("config-updated", "import").unwrap();
        return Ok(());
    }

    Err("User cancelled".to_string())
}

#[tauri::command]
fn start_window_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
async fn run_ocr(app: AppHandle, image_base64: String) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let ocr_lang = db::get_config(&conn, "ocr_lang").unwrap_or_default();
    let bytes = general_purpose::STANDARD.decode(image_base64).map_err(|e| e.to_string())?;
    ocr::run_ocr(bytes, &ocr_lang).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn capture_and_ocr(
    app: AppHandle,
    x: i32, y: i32, w: u32, h: u32
) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let ocr_lang = db::get_config(&conn, "ocr_lang").unwrap_or_default();
    let bytes = ocr::capture_rect(x, y, w, h).map_err(|e| e.to_string())?;
    let text = ocr::run_ocr(bytes, &ocr_lang).await.map_err(|e| e.to_string())?;
    
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
    let mut stmt = conn.prepare("SELECT 1 FROM wordbook WHERE word = ?1 AND is_deleted = 0").map_err(|e| e.to_string())?;
    stmt.exists([word]).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_to_wordbook(app: AppHandle, word: String, phonetic: Option<String>, meaning: Option<String>, analysis: Option<String>) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;

    let existing_uuid: Option<String> = conn.query_row(
        "SELECT uuid FROM wordbook WHERE word = ?1 AND is_deleted = 0",
        [&word],
        |row| row.get(0)
    ).optional().map_err(|e| e.to_string())?;

    if existing_uuid.is_some() {
        return Ok(());
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
fn get_due_reviews(app: AppHandle, limit: Option<i32>) -> Result<Vec<serde_json::Value>, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut stmt = conn.prepare(
        "SELECT id, word, phonetic, meaning, analysis_json, stability, difficulty, interval_days, repetitions, next_review FROM wordbook WHERE is_deleted = 0 AND (next_review IS NULL OR next_review <= ?1) ORDER BY next_review ASC LIMIT ?2"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&now, &limit.unwrap_or(50).to_string()], |row| {
        Ok(serde_json::json!({
            "id": row.get::<_, i32>(0)?,
            "word": row.get::<_, String>(1)?,
            "phonetic": row.get::<_, String>(2)?,
            "meaning": row.get::<_, String>(3)?,
            "analysis": row.get::<_, String>(4)?,
            "stability": row.get::<_, f64>(5)?,
            "difficulty": row.get::<_, f64>(6)?,
            "interval_days": row.get::<_, i32>(7)?,
            "repetitions": row.get::<_, i32>(8)?,
            "next_review": row.get::<_, Option<String>>(9)?,
        }))
    }).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for row in rows { items.push(row.map_err(|e| e.to_string())?); }
    Ok(items)
}

// ── FSRS (Free Spaced Repetition Scheduler) ──

// Standard FSRS-5 parameters from open-spaced-repetition project
const W: [f64; 19] = [
    0.4027, 0.5904, 0.9180, 0.4325,  // w0-w3: init stability per rating 1-4
    3.4615, 0.7028,                    // w4-w5: init difficulty params
    0.9264,                            // w6: difficulty delta
    0.0232, 0.8851, 0.3068, 0.6761,   // w7-w10: short-term stability
    2.1960, 0.0469, 0.3361, 1.2586,   // w11-w14: long-term stability
    0.2864, 2.5646, 0.2845, 0.3494,   // w15-w18: rating modifiers
];

fn retrievability(elapsed_days: f64, stability: f64) -> f64 {
    if stability <= 0.0 { return 1.0; }
    (0.9_f64).powf(elapsed_days.max(0.0) / stability)
}

fn init_stability(rating: u8) -> f64 {
    match rating {
        1 => W[0],
        2 => W[1],
        3 => W[2],
        4 => W[3],
        _ => W[2],
    }
}

fn init_difficulty(rating: u8) -> f64 {
    let d = W[4] - W[5] * (rating as f64 - 3.0);
    d.clamp(1.0, 10.0)
}

fn next_difficulty(d: f64, rating: u8) -> f64 {
    let delta = -W[6] * (rating as f64 - 3.0);
    (d + delta * (10.0 - d) / 9.0).clamp(1.0, 10.0)
}

fn next_stability(s: f64, d: f64, r: f64, rating: u8) -> f64 {
    if rating == 1 {
        // Again: short-term stability
        let s_min = W[7];
        let s_max = s / (1.0 + W[8] * (d - 1.0).max(0.0));
        s_max.max(s_min).min(s) // never increase stability on "again"
    } else {
        // Hard/Good/Easy: long-term stability
        let hard_pen = if rating == 2 { W[15] } else { 1.0 };
        let easy_bonus = if rating == 4 { W[16].exp() * (d - W[17]).max(0.0) / W[18] } else { 0.0 };
        let base = s * (1.0 + W[9].exp() * (11.0 - d) * s.powf(-W[10]) * ((1.0 - r) * W[11]).exp() * W[12]);
        (base * hard_pen + easy_bonus).max(0.01)
    }
}

#[tauri::command]
fn submit_review(app: AppHandle, word_id: i32, quality: i32) -> Result<serde_json::Value, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let rating = quality.clamp(1, 4) as u8;

    // Read current FSRS state (stability and difficulty)
    let (stability, difficulty, last_reviewed): (f64, f64, Option<String>) = conn.query_row(
        "SELECT stability, difficulty, last_reviewed FROM wordbook WHERE id = ?1",
        [word_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    ).map_err(|e| e.to_string())?;

    // Compute elapsed days since last review
    let elapsed = if let Some(ref lr) = last_reviewed {
        if let Ok(lr_time) = chrono::NaiveDateTime::parse_from_str(lr, "%Y-%m-%d %H:%M:%S") {
            let now_time = chrono::Local::now().naive_local();
            (now_time - lr_time).num_seconds() as f64 / 86400.0
        } else { 0.0 }
    } else { 0.0 };

    // FSRS: compute new stability and difficulty
    let (new_s, new_d) = if stability <= 0.0 {
        // First review
        (init_stability(rating), init_difficulty(rating))
    } else {
        let r = retrievability(elapsed, stability);
        let nd = next_difficulty(difficulty, rating);
        let ns = next_stability(stability, nd, r, rating);
        (ns, nd)
    };

    // Schedule next review at target retrievability (90%)
    let interval_days = (new_s * (- (0.9_f64).ln()).recip() * (0.9_f64).ln().abs()).round() as i32;
    let next_review = chrono::Local::now() + chrono::Duration::days(interval_days.max(1) as i64);
    let next_str = next_review.format("%Y-%m-%d %H:%M:%S").to_string();

    // Update DB with new FSRS state
    conn.execute(
        "UPDATE wordbook SET stability = ?1, difficulty = ?2, interval_days = ?3, repetitions = repetitions + 1, next_review = ?4, last_reviewed = ?5 WHERE id = ?6",
        rusqlite::params![new_s, new_d, interval_days, &next_str, &now, word_id],
    ).map_err(|e| e.to_string())?;

    app.emit("wordbook-updated", "local").unwrap();
    Ok(serde_json::json!({
        "interval": interval_days,
        "stability": new_s,
        "difficulty": new_d,
        "next_review": next_str,
    }))
}

#[tauri::command]
fn export_anki(app: AppHandle) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;

    // Read wordbook data
    let mut stmt = conn.prepare(
        "SELECT word, phonetic, meaning, analysis_json FROM wordbook WHERE is_deleted = 0 ORDER BY word"
    ).map_err(|e| e.to_string())?;
    let words: Vec<(String, String, String, String)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    if words.is_empty() {
        return Err("No words to export.".to_string());
    }

    let now = chrono::Utc::now();
    let ts = now.timestamp_millis();
    let ts_sec = now.timestamp();
    let deck_id = ts;
    let model_id = ts;

    // Build Anki model JSON
    let models = serde_json::json!({
        model_id.to_string(): {
            "id": model_id,
            "name": "Long Translate Vocabulary",
            "type": 0,
            "mod": ts_sec,
            "usn": 0,
            "sortf": 0,
            "did": null,
            "tmpls": [{
                "name": "Card 1",
                "ord": 0,
                "qfmt": "<div style='font-size:24px;margin-bottom:8px'>{{Word}}</div>{{#Phonetic}}<div style='color:#888;font-size:16px'>{{Phonetic}}</div>{{/Phonetic}}",
                "afmt": "<div style='font-size:20px;color:#1a73e8;margin-bottom:12px'><b>{{Meaning}}</b></div>{{#Mnemonic}}<hr><div style='background:#fff8e1;padding:12px;border-radius:8px;margin:8px 0'><b>💡 Memory Hook</b><br>{{Mnemonic}}</div>{{/Mnemonic}}{{#Etymology}}<hr><div style='color:#666;font-style:italic;font-size:14px'>📖 {{Etymology}}</div>{{/Etymology}}{{#Examples}}<hr><div style='font-size:14px'>📝 {{Examples}}</div>{{/Examples}}{{#Synonyms}}<hr><div style='font-size:14px'>🔤 {{Synonyms}}</div>{{/Synonyms}}",
                "bqfmt": "",
                "bafmt": "",
                "did": null,
                "bfont": "",
                "bsize": 0
            }],
            "flds": [
                {"name": "Word", "ord": 0, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Phonetic", "ord": 1, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Meaning", "ord": 2, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Mnemonic", "ord": 3, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Etymology", "ord": 4, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Examples", "ord": 5, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Synonyms", "ord": 6, "sticky": false, "rtl": false, "font": "Arial", "size": 20}
            ],
            "css": ".card{font-family:Arial,sans-serif;font-size:20px;text-align:center;color:#333;background:#fff;padding:16px}hr{border:none;border-top:1px solid #e0e0e0;margin:12px 0}",
            "latexPre": "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\begin{document}\n",
            "latexPost": "\\end{document}",
            "latexsvg": false,
            "req": [[0, "any", [0, 1, 2]]]
        }
    });

    let decks = serde_json::json!({
        deck_id.to_string(): {
            "id": deck_id,
            "name": "Long Translate Import",
            "mod": ts_sec,
            "usn": 0,
            "desc": "Imported from Long Translate",
            "collapsed": false,
            "browserCollapsed": false,
            "newToday": [0, 0],
            "revToday": [0, 0],
            "lrnToday": [0, 0],
            "conf": 1,
            "extendNew": 10,
            "extendRev": 50
        }
    });

    let dconf = serde_json::json!({
        "1": {
            "id": 1, "name": "Default", "mod": ts_sec, "usn": 0,
            "new": {"delays": [1.0, 10.0], "ints": [1, 4, 7], "initialFactor": 2500, "separate": true, "order": 1, "perDay": 20, "bury": true},
            "lapse": {"delays": [10.0], "mult": 0.0, "minInt": 1, "leechFails": 8, "leechAction": 0},
            "rev": {"perDay": 200, "ease4": 1.3, "fuzz": 0.05, "minSpace": 1, "ivlFct": 1.0, "maxIvl": 36500, "bury": true, "hardFactor": 1.2},
            "maxTaken": 60, "timer": 0, "autoplay": true, "replayq": true, "mod": 0, "usn": 0
        }
    });

    let col_conf = serde_json::json!({
        "activeDecks": [1], "curDeck": 1, "newSpread": 0, "collapseTime": 1200,
        "timeLim": 0, "estTimes": true, "dueCounts": true, "curModel": null,
        "nextPos": 1, "sortType": "noteFld", "sortBackwards": false,
        "addToCur": true, "dayLearnFirst": false
    });

    // Create temp Anki database
    let temp_dir = std::env::temp_dir().join(format!("long_anki_{}", ts));
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let db_path = temp_dir.join("collection.anki2");
    let aconn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

    aconn.execute_batch(
        "CREATE TABLE col (
            id INTEGER PRIMARY KEY, crt INTEGER NOT NULL, mod INTEGER NOT NULL,
            scm INTEGER NOT NULL, ver INTEGER NOT NULL, dty INTEGER NOT NULL,
            usn INTEGER NOT NULL, ls INTEGER NOT NULL, conf TEXT NOT NULL,
            models TEXT NOT NULL, decks TEXT NOT NULL, dconf TEXT NOT NULL, tags TEXT NOT NULL
        );
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY, guid TEXT NOT NULL, mid INTEGER NOT NULL,
            mod INTEGER NOT NULL, usn INTEGER NOT NULL, tags TEXT NOT NULL,
            flds TEXT NOT NULL, sfld TEXT NOT NULL, csum INTEGER NOT NULL,
            flags INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE TABLE cards (
            id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL,
            ord INTEGER NOT NULL, mod INTEGER NOT NULL, usn INTEGER NOT NULL,
            type INTEGER NOT NULL, queue INTEGER NOT NULL, due INTEGER NOT NULL,
            ivl INTEGER NOT NULL, factor INTEGER NOT NULL, reps INTEGER NOT NULL,
            lapses INTEGER NOT NULL, left INTEGER NOT NULL, odue INTEGER NOT NULL,
            odid INTEGER NOT NULL, flags INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX idx_notes_usn ON notes (usn);
        CREATE INDEX idx_cards_nid ON cards (nid);
        CREATE INDEX idx_cards_sched ON cards (did, queue, due);
        CREATE INDEX idx_cards_usn ON cards (usn);"
    ).map_err(|e| e.to_string())?;

    // Insert collection row
    aconn.execute(
        "INSERT INTO col VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            1_i64, ts, ts, ts_sec, 21_i64, 0_i64, -1_i64, 0_i64,
            serde_json::to_string(&col_conf).unwrap(),
            serde_json::to_string(&models).unwrap(),
            serde_json::to_string(&decks).unwrap(),
            serde_json::to_string(&dconf).unwrap(),
            "{}"
        ],
    ).map_err(|e| e.to_string())?;

    // Insert notes and cards
    for (i, (word, phonetic, meaning, analysis_json)) in words.iter().enumerate() {
        let note_id = ts + i as i64;
        let guid = uuid::Uuid::new_v4().to_string();
        let sfld = word.clone();

        // Parse analysis JSON for extra fields
        let (mnemonic, etymology, examples, synonyms): (String, String, String, String) =
            if let Ok(analysis) = serde_json::from_str::<serde_json::Value>(analysis_json) {
                (
                    analysis["mnemonic"].as_str().unwrap_or("").to_string(),
                    analysis["etymology"].as_str().unwrap_or("").to_string(),
                    analysis["examples"].as_array().map(|arr| {
                        arr.iter().map(|ex| {
                            format!("{} ({})", ex["en"].as_str().unwrap_or(""), ex["zh"].as_str().unwrap_or(""))
                        }).collect::<Vec<_>>().join("<br>")
                    }).unwrap_or_default(),
                    analysis["synonyms"].as_array().map(|arr| {
                        arr.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                    }).unwrap_or_default(),
                )
            } else {
                (String::new(), String::new(), String::new(), String::new())
            };

        let flds = [
            word.clone(),
            phonetic.clone(),
            meaning.clone(),
            mnemonic,
            etymology,
            examples,
            synonyms,
        ].join("\x1f"); // Anki field separator

        aconn.execute(
            "INSERT INTO notes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![note_id, guid, model_id, ts_sec, -1_i64, "", flds, sfld, 0_i64, 0_i64, ""],
        ).map_err(|e| e.to_string())?;

        // New card: queue=0 (new), type=0 (new), due=note_id
        aconn.execute(
            "INSERT INTO cards VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            rusqlite::params![
                note_id + 1, note_id, deck_id, 0_i64, ts_sec, -1_i64,
                0_i64, 0_i64, note_id, 0_i64, 0_i64, 0_i64, 0_i64, 0_i64,
                0_i64, 0_i64, 0_i64, ""
            ],
        ).map_err(|e| e.to_string())?;
    }

    aconn.close().map_err(|_| "close error".to_string())?;

    // Create media file
    std::fs::write(temp_dir.join("media"), "{}").map_err(|e| e.to_string())?;

    // Create APKG zip
    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    let filename = format!("LongTranslate_Anki_{}.apkg", now.format("%Y%m%d_%H%M%S"));
    let apkg_path = desktop.join(&filename);

    let file = std::fs::File::create(&apkg_path).map_err(|e| e.to_string())?;
    let mut zip_writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    for entry_name in &["collection.anki2", "media"] {
        zip_writer.start_file(*entry_name, options).map_err(|e| e.to_string())?;
        let data = std::fs::read(temp_dir.join(entry_name)).map_err(|e| e.to_string())?;
        zip_writer.write(&data).map_err(|e| e.to_string())?;
    }

    zip_writer.finish().map_err(|e| e.to_string())?;

    // Cleanup temp
    let _ = std::fs::remove_dir_all(&temp_dir);

    Ok(apkg_path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_review_stats(app: AppHandle) -> Result<serde_json::Value, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let total: i32 = conn.query_row("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let reviewed: i32 = conn.query_row("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0 AND last_reviewed IS NOT NULL", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let mastered: i32 = conn.query_row("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0 AND stability >= 21", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let due: i32 = conn.query_row("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0 AND (next_review IS NULL OR next_review <= ?1)", [&now], |r| r.get(0)).map_err(|e| e.to_string())?;

    // Streak: count consecutive days with reviews
    let mut stmt = conn.prepare("SELECT DISTINCT DATE(last_reviewed) as d FROM wordbook WHERE last_reviewed IS NOT NULL ORDER BY d DESC LIMIT 30").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let streak_rows: Vec<String> = rows.filter_map(|r| r.ok()).collect();
    let mut streak = 0i32;
    let today = chrono::Local::now().date_naive();
    for i in 0..30 {
        let check_date = today - chrono::Duration::days(i);
        let check_str = check_date.format("%Y-%m-%d").to_string();
        if streak_rows.contains(&check_str) { streak += 1; }
        else if i > 0 { break; }
    }

    Ok(serde_json::json!({ "total": total, "reviewed": reviewed, "mastered": mastered, "due_today": due, "streak": streak }))
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
fn save_translation(app: AppHandle, source_text: String, translated_text: String, source_lang: Option<String>, target_lang: Option<String>, model: Option<String>) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO translation_history (source_text, translated_text, source_lang, target_lang, model) VALUES (?1, ?2, ?3, ?4, ?5)",
        [&source_text, &translated_text, &source_lang.unwrap_or_default(), &target_lang.unwrap_or_default(), &model.unwrap_or_default()],
    ).map_err(|e| e.to_string())?;
    app.emit("history-updated", "").unwrap();
    Ok(())
}

#[tauri::command]
fn get_translation_history(app: AppHandle, limit: Option<i32>, offset: Option<i32>) -> Result<Vec<serde_json::Value>, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, source_text, translated_text, source_lang, target_lang, model, created_at FROM translation_history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([limit.unwrap_or(100), offset.unwrap_or(0)], |row| {
        Ok(serde_json::json!({
            "id": row.get::<_, i32>(0)?,
            "source_text": row.get::<_, String>(1)?,
            "translated_text": row.get::<_, String>(2)?,
            "source_lang": row.get::<_, String>(3)?,
            "target_lang": row.get::<_, String>(4)?,
            "model": row.get::<_, String>(5)?,
            "created_at": row.get::<_, String>(6)?,
        }))
    }).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for row in rows { items.push(row.map_err(|e| e.to_string())?); }
    Ok(items)
}

#[tauri::command]
fn delete_translation(app: AppHandle, id: i32) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM translation_history WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_wordbook(app: AppHandle, format: String) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT word, phonetic, meaning, analysis_json FROM wordbook WHERE is_deleted = 0 ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }).map_err(|e| e.to_string())?;
    let items: Vec<_> = rows.filter_map(|r| r.ok()).collect();

    let content = match format.as_str() {
        "csv" => {
            let mut csv = String::from("word,phonetic,meaning,examples,synonyms\n");
            for (word, phonetic, meaning, analysis) in &items {
                let examples = serde_json::from_str::<serde_json::Value>(analysis)
                    .ok().and_then(|a| a["examples"].as_array().cloned())
                    .map(|ex| ex.iter().filter_map(|e| e["en"].as_str()).collect::<Vec<_>>().join(" | "))
                    .unwrap_or_default();
                let synonyms = serde_json::from_str::<serde_json::Value>(analysis)
                    .ok().and_then(|a| a["synonyms"].as_array().cloned())
                    .map(|s| s.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" | "))
                    .unwrap_or_default();
                csv.push_str(&format!("\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"\n",
                    word.replace("\"", "\"\""),
                    phonetic.replace("\"", "\"\""),
                    meaning.replace("\"", "\"\""),
                    examples.replace("\"", "\"\""),
                    synonyms.replace("\"", "\"\""),
                ));
            }
            csv
        },
        "json" => {
            let json_items: Vec<serde_json::Value> = items.iter().map(|(w, p, m, a)| {
                let analysis: serde_json::Value = serde_json::from_str(a).unwrap_or_default();
                serde_json::json!({"word": w, "phonetic": p, "meaning": m, "analysis": analysis})
            }).collect();
            serde_json::to_string_pretty(&json_items).map_err(|e| e.to_string())?
        },
        _ => return Err("Unsupported format".to_string()),
    };

    use tauri_plugin_dialog::DialogExt;
    let ext = if format == "csv" { "csv" } else { "json" };
    let filter_name = if format == "csv" { "CSV Files" } else { "JSON Files" };
    let file_path = app.dialog().file()
        .set_title("Export Wordbook")
        .add_filter(filter_name, &[ext])
        .set_file_name(format!("wordbook_export.{}", ext))
        .blocking_save_file();

    if let Some(path) = file_path {
        let actual_path = match path {
            tauri_plugin_dialog::FilePath::Path(p) => p,
            tauri_plugin_dialog::FilePath::Url(u) => u.to_file_path().map_err(|_| "Invalid URL path")?,
        };
        std::fs::write(actual_path, &content).map_err(|e| e.to_string())?;
        Ok("Export successful".to_string())
    } else {
        Err("User cancelled".to_string())
    }
}

#[tauri::command]
fn clear_translation_history(app: AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM translation_history", []).map_err(|e| e.to_string())?;
    app.emit("history-updated", "").unwrap();
    Ok(())
}

#[tauri::command]
fn lookup_translation_memory(app: AppHandle, text: String, target_lang: String) -> Result<Option<String>, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let result: Option<String> = conn.query_row(
        "SELECT translated_text FROM translation_memory WHERE source_hash = ?1 AND target_lang = ?2",
        [&hash, &target_lang],
        |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
fn save_translation_memory(app: AppHandle, source_text: String, translated_text: String, target_lang: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(source_text.as_bytes()));
    conn.execute(
        "INSERT OR REPLACE INTO translation_memory (source_hash, target_lang, source_text, translated_text) VALUES (?1, ?2, ?3, ?4)",
        [&hash, &target_lang, &source_text, &translated_text],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_config_value(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
    let store_value = if is_sensitive_key(&key) && !value.is_empty() {
        let device_key = get_device_key(&app_dir);
        encrypt_value(&value, &device_key)?
    } else {
        value
    };
    db::set_config(&conn, &key, &store_value).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config_value(app: AppHandle, key: String) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
    let value = db::get_config(&conn, &key).map_err(|e| e.to_string())?;
    if is_sensitive_key(&key) && value.starts_with("ENC:") {
        let device_key = get_device_key(&app_dir);
        decrypt_value(&value, &device_key)
    } else {
        Ok(value)
    }
}

#[tauri::command]
fn save_audio_cache(app: AppHandle, cache_key: String, audio_data: Vec<u8>) -> Result<(), String> {
    let cache_dir = get_audio_cache_dir(&app);
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    let hash = hex::encode(hasher.finalize());
    let cache_path = cache_dir.join(format!("{}.cache", hash));
    std::fs::write(&cache_path, &audio_data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_clipboard_text(app: AppHandle) -> Result<String, String> {
    let clipboard = app.clipboard();
    clipboard.read_text().map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_detect(app: AppHandle, text: String) {
    if let Some(floating) = app.get_webview_window("floating") {
        let _ = floating.show();
        let _ = floating.set_focus();
        let _ = app.emit("shortcut-triggered", text);
    }
}

fn show_ocr_overlay(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("ocr-overlay") {
        // Span all monitors for dual/multi-monitor support
        if let Ok(screens) = screenshots::Screen::all() {
            let mut min_x = 0i32; let mut min_y = 0i32;
            let mut max_x = 0i32; let mut max_y = 0i32;
            for s in &screens {
                let d = &s.display_info;
                if d.x < min_x { min_x = d.x; }
                if d.y < min_y { min_y = d.y; }
                let right = d.x + d.width as i32;
                let bottom = d.y + d.height as i32;
                if right > max_x { max_x = right; }
                if bottom > max_y { max_y = bottom; }
            }
            let factor = overlay.scale_factor().unwrap_or(1.0);
            let _ = overlay.set_position(tauri::PhysicalPosition::new(min_x, min_y));
            let _ = overlay.set_size(tauri::PhysicalSize::new(
                ((max_x - min_x) as f64 / factor) as u32,
                ((max_y - min_y) as f64 / factor) as u32,
            ));
        }
        let _ = overlay.show();
        let _ = overlay.set_focus();
    }
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

use std::time::{SystemTime, UNIX_EPOCH};

fn generate_sec_ms_gec_token() -> String {
    let ticks = SystemTime::now().duration_since(UNIX_EPOCH).expect("Time flew backwards").as_secs();
    let rounded_ticks = ticks / 3000 * 3000;
    let str_to_hash = format!("{}6A5AA1D4EAFF4E9FB37E23D68491D6F4", rounded_ticks);
    let mut hasher = Sha256::new();
    hasher.update(str_to_hash.as_bytes());
    hex::encode(hasher.finalize())
}

async fn fetch_edge_tts(text: String, voice: String) -> Result<Vec<u8>, String> {
    let token = generate_sec_ms_gec_token();
    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let edge_ua_version = "131.0.2903.86";
    let version = format!("1-{}", edge_ua_version);
    
    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC={}&Sec-MS-GEC-Version={}&ConnectionId={}",
        token, version, connection_id
    );
    
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    {
        let headers = request.headers_mut();
        headers.insert("Host", "speech.platform.bing.com".parse().unwrap());
        headers.insert("Origin", "https://www.bing.com".parse().unwrap());
        headers.insert("User-Agent", format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36 Edg/{}", edge_ua_version.split('.').next().unwrap(), edge_ua_version).parse().unwrap());
        headers.insert("Pragma", "no-cache".parse().unwrap());
        headers.insert("Cache-Control", "no-cache".parse().unwrap());
    }
    
    let (ws_stream, _) = connect_async(request).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws_stream.split();

    let config = format!(r#"{{"context":{{"system":{{"name":"Edge","version":"{}","build":"{}","lang":"en-US"}}}}}}"#, edge_ua_version, edge_ua_version);
    let config_msg = format!("Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{}", config);
    write.send(Message::Text(config_msg.into())).await.map_err(|e| e.to_string())?;

    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let escaped_text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    let ssml = format!(
        r#"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='{}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>{}</prosody></voice></speak>"#,
        voice, escaped_text
    );
    let ssml_msg = format!("X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n{}", request_id, ssml);
    write.send(Message::Text(ssml_msg.into())).await.map_err(|e| e.to_string())?;

    let mut audio_data = Vec::new();
    while let Some(msg) = read.next().await {
        match msg.map_err(|e| e.to_string())? {
            Message::Binary(data) => {
                let data_vec = data.to_vec();
                if let Some(pos) = data_vec.windows(12).position(|w| w == b"Path:audio\r\n") {
                    audio_data.extend_from_slice(&data_vec[pos + 12..]);
                }
            },
            Message::Text(t) if t.contains("Path:turn.end") => break,
            _ => {}
        }
    }
    Ok(audio_data)
}

#[tauri::command]
async fn proxy_fetch_audio(app: AppHandle, url: String, cache_key: Option<String>, engine: Option<String>, voice: Option<String>) -> Result<Vec<u8>, String> {
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

    let bytes = if engine.as_deref() == Some("edge") {
        fetch_edge_tts(url, voice.unwrap_or_else(|| "zh-CN-XiaoxiaoNeural".to_string())).await?
    } else {
        if url.is_empty() { return Err("Cache miss and no URL provided".to_string()); }
        let client = reqwest::Client::new();
        let response = client.get(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        response.bytes().await.map_err(|e| e.to_string())?.to_vec()
    };

    if bytes.len() > 100 { let _ = fs::write(&cache_path, &bytes); }
    // Evict oldest files if cache exceeds 200 MB
    evict_cache_if_needed(&cache_dir, 200 * 1024 * 1024);
    Ok(bytes)
}

fn evict_cache_if_needed(cache_dir: &PathBuf, max_size: u64) {
    let mut entries: Vec<_> = match fs::read_dir(cache_dir) {
        Ok(iter) => iter.filter_map(|e| e.ok()).filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.path(), meta.len(), meta.modified().ok()?))
        }).collect(),
        Err(_) => return,
    };
    let total: u64 = entries.iter().map(|(_, s, _)| s).sum();
    if total <= max_size { return; }
    // Sort by modification time (oldest first), remove oldest until under limit
    entries.sort_by_key(|(_, _, mtime)| *mtime);
    let mut freed = 0u64;
    let target = max_size.saturating_sub(max_size / 10); // aim for 90% of max
    for (path, size, _) in &entries {
        if total.saturating_sub(freed) <= target { break; }
        let _ = fs::remove_file(path);
        freed += size;
    }
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
    // Prevent concurrent clipboard operations
    let app_handle = app.clone();
    {
        let state = app.state::<AppState>();
        let mut lock = state.clipboard_lock.lock().unwrap();
        if *lock {
            return; // Another translation is in progress
        }
        *lock = true;
    }

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        let clipboard = app_handle.clipboard();
        let original_text = clipboard.read_text().unwrap_or_default();
        let token = "__DETECT_TOKEN__";
        let _ = clipboard.write_text(token.to_string());

        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(_) => {
                // Failed to init Enigo, restore clipboard and unlock
                let _ = clipboard.write_text(original_text);
                *app_handle.state::<AppState>().clipboard_lock.lock().unwrap() = false;
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

        // Release lock
        *app_handle.state::<AppState>().clipboard_lock.lock().unwrap() = false;
    });
}

#[tauri::command]
async fn sync_wordbook(app: AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    
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

    let mut remote_data: Vec<serde_json::Value> = Vec::new();
    let resp = client.get(&sync_file_url)
        .basic_auth(&user, Some(&pass))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            remote_data = r.json().await.unwrap_or_default();
        },
        Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
            return Err("WebDAV Authorization Failed".to_string());
        },
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
            // File doesn't exist yet (first sync), proceed with upload
        },
        Ok(r) => {
            return Err(format!("WebDAV download failed: HTTP {}", r.status()));
        },
        Err(e) => {
            return Err(format!("WebDAV connection failed: {}", e));
        }
    }

    let local_items: Vec<serde_json::Value> = {
        let mut conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

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
                        "UPDATE wordbook SET word = ?1, phonetic = ?2, meaning = ?3, analysis_json = ?4, is_deleted = ?5, updated_at = ?6, ease_factor = ?7, interval_days = ?8, repetitions = ?9, next_review = ?10, last_reviewed = ?11, stability = ?12, difficulty = ?13 WHERE uuid = ?14",
                        (
                            item["word"].as_str().unwrap_or_default(),
                            item["phonetic"].as_str().unwrap_or_default(),
                            item["meaning"].as_str().unwrap_or_default(),
                            item["analysis"].as_str().unwrap_or_default(),
                            is_deleted,
                            updated_at,
                            item["ease_factor"].as_f64().unwrap_or(2.5),
                            item["interval_days"].as_i64().unwrap_or(0),
                            item["repetitions"].as_i64().unwrap_or(0),
                            item["next_review"].as_str().unwrap_or(""),
                            item["last_reviewed"].as_str().unwrap_or(""),
                            item["stability"].as_f64().unwrap_or(0.0),
                            item["difficulty"].as_f64().unwrap_or(0.0),
                            uuid
                        )
                    ).map_err(|e| e.to_string())?;
                },
                None => {
                    tx.execute(
                        "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, difficulty) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        (
                            uuid,
                            item["word"].as_str().unwrap_or_default(),
                            item["phonetic"].as_str().unwrap_or_default(),
                            item["meaning"].as_str().unwrap_or_default(),
                            item["analysis"].as_str().unwrap_or_default(),
                            is_deleted,
                            updated_at,
                            item["ease_factor"].as_f64().unwrap_or(2.5),
                            item["interval_days"].as_i64().unwrap_or(0),
                            item["repetitions"].as_i64().unwrap_or(0),
                            item["next_review"].as_str().unwrap_or(""),
                            item["last_reviewed"].as_str().unwrap_or(""),
                            item["stability"].as_f64().unwrap_or(0.0),
                            item["difficulty"].as_f64().unwrap_or(0.0),
                        )
                    ).map_err(|e| e.to_string())?;
                },
                _ => {}
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare("SELECT uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, difficulty FROM wordbook").map_err(|e| e.to_string())?;
        let items = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "uuid": row.get::<_, String>(0)?,
                "word": row.get::<_, String>(1)?,
                "phonetic": row.get::<_, String>(2)?,
                "meaning": row.get::<_, String>(3)?,
                "analysis": row.get::<_, String>(4)?,
                "is_deleted": row.get::<_, i64>(5)?,
                "updated_at": row.get::<_, String>(6)?,
                "ease_factor": row.get::<_, f64>(7)?,
                "interval_days": row.get::<_, i32>(8)?,
                "repetitions": row.get::<_, i32>(9)?,
                "next_review": row.get::<_, Option<String>>(10)?,
                "last_reviewed": row.get::<_, Option<String>>(11)?,
                "stability": row.get::<_, f64>(12)?,
                "difficulty": row.get::<_, f64>(13)?,
            }))
        }).map_err(|e| e.to_string())?.map(|r| r.unwrap()).collect();
        items
    };

    let upload_resp = client.put(&sync_file_url)
        .basic_auth(&user, Some(&pass))
        .json(&local_items)
        .send()
        .await
        .map_err(|e| format!("Upload failed: {}", e))?;

    if !upload_resp.status().is_success() {
        if upload_resp.status() == reqwest::StatusCode::NOT_FOUND {
            // Try to auto-create directory hierarchy via MKCOL
            let base = sync_file_url.trim_end_matches('/');
            if let Some(last_slash) = base.rfind('/') {
                let parent_dir = &base[..last_slash];
                // Try MKCOL on parent directory, ignore errors (might already exist)
                let _ = client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), parent_dir)
                    .basic_auth(&user, Some(&pass))
                    .send()
                    .await;
                // Retry the PUT
                let retry = client.put(&sync_file_url)
                    .basic_auth(&user, Some(&pass))
                    .json(&local_items)
                    .send()
                    .await
                    .map_err(|e| format!("Upload failed: {}", e))?;
                if !retry.status().is_success() {
                    return Err(format!("同步失败：无法创建网盘目录或上传文件 (HTTP {})。\n请求路径: {}", retry.status(), sync_file_url));
                }
            } else {
                return Err(format!("同步失败：网盘路径不存在。\n请确保文件夹已手动创建。\n请求路径: {}", sync_file_url));
            }
        } else if upload_resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("同步失败：网盘账号或应用密码错误。".to_string());
        } else {
            return Err(format!("同步失败 (HTTP {}): {}", upload_resp.status(), sync_file_url));
        }
    }

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
    
    let word_count: i32 = conn.query_row("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    
    let trans_count: i32 = db::get_config(&conn, "translated_count").unwrap_or_default().parse().unwrap_or(0);
    
    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let due_count: i32 = conn.query_row("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0 AND (next_review IS NULL OR next_review <= ?1)", [&now_str], |row| row.get(0)).map_err(|e| e.to_string())?;

    let install_date_str = db::get_config(&conn, "install_date").unwrap_or_default();
    let days = if !install_date_str.is_empty() {
        let install_date = chrono::NaiveDate::parse_from_str(&install_date_str, "%Y-%m-%d").unwrap_or_else(|_| chrono::Local::now().date_naive());
        let now = chrono::Local::now().date_naive();
        (now - install_date).num_days() + 1
    } else { 1 };

    Ok(serde_json::json!({
        "word_count": word_count,
        "trans_count": trans_count,
        "days_active": days,
        "due_today": due_count
    }))
}

// ── Glossary CRUD ──

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct GlossaryEntry {
    id: i64,
    source_term: String,
    target_term: String,
    created_at: String,
}

#[tauri::command]
fn add_glossary_entry(app: AppHandle, source_term: String, target_term: String) -> Result<GlossaryEntry, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO glossary (source_term, target_term) VALUES (?1, ?2)",
        rusqlite::params![source_term, target_term],
    ).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(GlossaryEntry { id, source_term, target_term, created_at: String::new() })
}

#[tauri::command]
fn get_glossary_entries(app: AppHandle) -> Result<Vec<GlossaryEntry>, String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, source_term, target_term, created_at FROM glossary ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let entries = stmt.query_map([], |row| {
        Ok(GlossaryEntry {
            id: row.get(0)?,
            source_term: row.get(1)?,
            target_term: row.get(2)?,
            created_at: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(entries)
}

#[tauri::command]
fn delete_glossary_entry(app: AppHandle, id: i64) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM glossary WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_glossary_entry(app: AppHandle, id: i64, source_term: String, target_term: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE glossary SET source_term = ?1, target_term = ?2 WHERE id = ?3",
        rusqlite::params![source_term, target_term, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn migrate_old_data(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let new_data_dir = app.path().app_data_dir()?;
    let old_identifier = "com.ai.trans.assistant";
    
    let old_data_dir = if let Some(parent) = new_data_dir.parent() {
        parent.join(old_identifier)
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
        .manage(AppState { shortcuts_paused: Mutex::new(false), clipboard_lock: Mutex::new(false) })
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let _ = migrate_old_data(app);

            let app_handle = app.handle().clone();
            tray::create_tray(&app_handle)?;
            let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            let conn = db::init_db(app_dir).expect("Failed to initialize database");

            let main_win = app.get_webview_window("main").unwrap();
            let main_win_clone = main_win.clone();
            main_win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_win_clone.hide();
                }
            });

            let q_shortcut_str = db::get_config(&conn, "shortcut_q").unwrap_or_else(|_| "Alt+Q".to_string());
            let w_shortcut_str = db::get_config(&conn, "shortcut_w").unwrap_or_else(|_| "Alt+W".to_string());
            
            let q_shortcut_str = if q_shortcut_str.is_empty() { "Alt+Q".to_string() } else { q_shortcut_str };
            let w_shortcut_str = if w_shortcut_str.is_empty() { "Alt+W".to_string() } else { w_shortcut_str };

            let global_shortcut = app.global_shortcut();
            
            if let Ok(s) = parse_shortcut(&q_shortcut_str) {
                let _ = global_shortcut.on_shortcut(s, move |app, _shortcut, event| {
                    if *app.state::<AppState>().shortcuts_paused.lock().unwrap() { return; }
                    if event.state() == ShortcutState::Pressed {
                        handle_translate_request(app);
                    }
                });
            }

            if let Ok(s) = parse_shortcut(&w_shortcut_str) {
                let _ = global_shortcut.on_shortcut(s, move |app, _shortcut, event| {
                    if *app.state::<AppState>().shortcuts_paused.lock().unwrap() { return; }
                    if event.state() == ShortcutState::Pressed {
                        if let Some(overlay) = app.get_webview_window("ocr-overlay") {
                            let _ = overlay.show();
                            let _ = overlay.set_focus();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_ocr, capture_and_ocr, get_screen_bounds, get_clipboard_text, set_config_value, get_config_value,
            updater_configured,
            hide_floating_window, start_window_drag, clipboard_detect, add_to_wordbook, get_wordbook, delete_word,
            check_word_exists, update_word_analysis, proxy_fetch_audio, get_audio_cache_size,
            clear_audio_cache, check_audio_cache, sync_wordbook, increment_translate_count, get_app_stats,
            update_shortcut, set_shortcuts_paused, export_data, import_data, save_audio_cache,
            save_translation, get_translation_history, delete_translation, clear_translation_history,
            export_wordbook, lookup_translation_memory, save_translation_memory,
            get_due_reviews, submit_review, get_review_stats, export_anki,
            add_glossary_entry, get_glossary_entries, delete_glossary_entry, update_glossary_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{decrypt_backup_payload, encrypt_backup_payload, BACKUP_V3_MAGIC};

    #[test]
    fn v3_backup_round_trip_uses_authenticated_encryption() {
        let plaintext = br#"{"config":{"trans_api_key":"secret"}}"#;
        let encrypted = encrypt_backup_payload(plaintext, "correct horse battery staple").unwrap();

        assert!(encrypted.starts_with(BACKUP_V3_MAGIC));
        assert!(!encrypted.windows(b"secret".len()).any(|part| part == b"secret"));
        assert_eq!(decrypt_backup_payload(&encrypted, "correct horse battery staple").unwrap(), plaintext);
    }

    #[test]
    fn v3_backup_rejects_wrong_password_and_truncated_files() {
        let encrypted = encrypt_backup_payload(b"payload", "right-password").unwrap();

        assert!(decrypt_backup_payload(&encrypted, "wrong-password").is_err());
        assert!(decrypt_backup_payload(BACKUP_V3_MAGIC, "right-password").is_err());
    }
}
