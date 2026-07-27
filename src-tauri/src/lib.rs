mod backup;
mod db;
mod diagnostics;
mod history;
mod ocr;
mod review;
mod secure_config;
mod tray;
mod tts;
mod webdav;
mod wordbook;

use tauri::{AppHandle, Manager, Emitter, Runtime, WindowEvent, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, Modifiers, Code, ShortcutState};
use tauri_plugin_clipboard_manager::ClipboardExt;
use base64::{Engine as _, engine::general_purpose};
use enigo::{Enigo, Key, Keyboard, Settings, Direction};
use std::thread;
use std::time::Duration;
use std::fs;
use std::path::PathBuf;
use rusqlite::OptionalExtension;
use std::io::Write;
use std::sync::Mutex;

struct AppState {
    shortcuts_paused: Mutex<bool>,
    clipboard_lock: Mutex<bool>,
}

fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))
}

#[tauri::command]
fn set_shortcuts_paused(state: tauri::State<AppState>, paused: bool) {
    if let Ok(mut current) = state.shortcuts_paused.lock() {
        *current = paused;
    }
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
    let app_dir = resolve_app_data_dir(&app)?;
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
        let Ok(paused) = state.shortcuts_paused.lock() else { return; };
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
fn start_window_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
async fn run_ocr(app: AppHandle, image_base64: String) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(&app)?;
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
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let ocr_lang = db::get_config(&conn, "ocr_lang").unwrap_or_default();
    let bytes = ocr::capture_rect(x, y, w, h).map_err(|e| e.to_string())?;
    ocr::run_ocr(bytes, &ocr_lang).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn confirm_ocr_text(app: AppHandle, text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("OCR text is empty".to_string());
    }

    if let Some(overlay) = app.get_webview_window("ocr-overlay") { let _ = overlay.hide(); }
    if let Some(floating) = app.get_webview_window("floating") {
        let _ = floating.show();
        let _ = floating.set_focus();
    }
    app.emit("ocr-triggered", text).map_err(|e| e.to_string())
}

#[tauri::command]
fn check_word_exists(app: AppHandle, word: String) -> Result<bool, String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT 1 FROM wordbook WHERE word = ?1 AND is_deleted = 0").map_err(|e| e.to_string())?;
    stmt.exists([word]).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WordContextInput {
    source_text: String,
    translated_text: Option<String>,
    source_type: String,
}

#[tauri::command]
fn add_to_wordbook(
    app: AppHandle,
    word: String,
    phonetic: Option<String>,
    meaning: Option<String>,
    analysis: Option<String>,
    context: Option<WordContextInput>,
) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;

    let existing_uuid: Option<String> = conn.query_row(
        "SELECT uuid FROM wordbook WHERE word = ?1 AND is_deleted = 0",
        [&word],
        |row| row.get(0)
    ).optional().map_err(|e| e.to_string())?;

    let uuid = if let Some(uuid) = existing_uuid {
        uuid
    } else {
        let uuid = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)",
            [&uuid, &word, &phonetic.unwrap_or_default(), &meaning.unwrap_or_default(), &analysis.unwrap_or_default()],
        ).map_err(|e| e.to_string())?;
        uuid
    };

    if let Some(context) = context {
        let source = context.source_text.trim();
        if !source.is_empty() {
            conn.execute(
                "INSERT OR IGNORE INTO word_contexts (word_uuid, source_text, translated_text, source_type) VALUES (?1, ?2, ?3, ?4)",
                [&uuid, source, &context.translated_text.unwrap_or_default(), &context.source_type],
            ).map_err(|e| e.to_string())?;
        }
    }
    app.emit("wordbook-updated", "local").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_word_analysis(app: AppHandle, word: String, phonetic: String, meaning: String, analysis: String) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE wordbook SET phonetic = ?1, meaning = ?2, analysis_json = ?3, updated_at = CURRENT_TIMESTAMP WHERE word = ?4",
        [phonetic, meaning, analysis, word],
    ).map_err(|e| e.to_string())?;
    app.emit("wordbook-updated", "local").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_wordbook(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let app_dir = resolve_app_data_dir(&app)?;
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
    for row in rows {
        let mut word = row.map_err(|e| e.to_string())?;
        let uuid = word["uuid"].as_str().unwrap_or_default();
        let mut context_stmt = conn.prepare("SELECT id, source_text, translated_text, source_type, created_at FROM word_contexts WHERE word_uuid = ?1 ORDER BY created_at DESC").map_err(|e| e.to_string())?;
        let context_rows = context_stmt.query_map([uuid], |context_row| {
            Ok(serde_json::json!({
                "id": context_row.get::<_, i32>(0)?,
                "source_text": context_row.get::<_, String>(1)?,
                "translated_text": context_row.get::<_, String>(2)?,
                "source_type": context_row.get::<_, String>(3)?,
                "created_at": context_row.get::<_, String>(4)?,
            }))
        }).map_err(|e| e.to_string())?;
        let contexts = context_rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        word["contexts"] = serde_json::json!(contexts);
        words.push(word);
    }
    Ok(words)
}

#[tauri::command]
fn export_anki(app: AppHandle) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(&app)?;
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
    let col_conf_json = serde_json::to_string(&col_conf)
        .map_err(|error| format!("Cannot serialize Anki collection settings: {error}"))?;
    let models_json = serde_json::to_string(&models)
        .map_err(|error| format!("Cannot serialize Anki note model: {error}"))?;
    let decks_json = serde_json::to_string(&decks)
        .map_err(|error| format!("Cannot serialize Anki deck: {error}"))?;
    let dconf_json = serde_json::to_string(&dconf)
        .map_err(|error| format!("Cannot serialize Anki deck settings: {error}"))?;

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
            col_conf_json,
            models_json,
            decks_json,
            dconf_json,
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
fn delete_word(app: AppHandle, id: i32) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute("UPDATE wordbook SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    app.emit("wordbook-updated", "local").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_wordbook(app: AppHandle, format: String) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(&app)?;
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
fn set_config_value(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
    let store_value = secure_config::prepare_value(&key, &value)?;
    db::set_config(&conn, &key, &store_value).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config_value(app: AppHandle, key: String) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
    secure_config::load_value(&conn, &key, &app_dir)
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

#[tauri::command]
fn get_available_ocr_languages() -> Result<Vec<ocr::OcrLanguageInfo>, String> {
    ocr::available_ocr_languages().map_err(|error| error.to_string())
}

fn handle_translate_request<R: Runtime>(app: &AppHandle<R>) {
    // Prevent concurrent clipboard operations
    let app_handle = app.clone();
    {
        let state = app.state::<AppState>();
        let Ok(mut lock) = state.clipboard_lock.lock() else { return; };
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
                if let Ok(mut lock) = app_handle.state::<AppState>().clipboard_lock.lock() {
                    *lock = false;
                }
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
        if let Ok(mut lock) = app_handle.state::<AppState>().clipboard_lock.lock() {
            *lock = false;
        }
    });
}

#[allow(dead_code)]
async fn sync_wordbook_legacy(app: AppHandle) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    
    let (url, user, pass, is_enabled) = {
        let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
        let url = db::get_config(&conn, "webdav_url").unwrap_or_default();
        let user = db::get_config(&conn, "webdav_user").unwrap_or_default();
        let pass = secure_config::load_value(&conn, "webdav_pass", &app_dir)?;
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
            if let Some(contexts) = item["contexts"].as_array() {
                for context in contexts {
                    tx.execute(
                        "INSERT OR IGNORE INTO word_contexts (word_uuid, source_text, translated_text, source_type, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        (
                            uuid,
                            context["source_text"].as_str().unwrap_or_default(),
                            context["translated_text"].as_str().unwrap_or_default(),
                            context["source_type"].as_str().unwrap_or("manual"),
                            context["created_at"].as_str().unwrap_or_default(),
                        )
                    ).map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare("SELECT uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, difficulty FROM wordbook").map_err(|e| e.to_string())?;
        let mut items: Vec<serde_json::Value> = stmt.query_map([], |row| {
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
        }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        drop(stmt);
        for item in &mut items {
            let uuid = item["uuid"].as_str().unwrap_or_default();
            let mut context_stmt = conn.prepare("SELECT source_text, translated_text, source_type, created_at FROM word_contexts WHERE word_uuid = ?1 ORDER BY created_at").map_err(|e| e.to_string())?;
            let contexts = context_stmt.query_map([uuid], |row| {
                Ok(serde_json::json!({
                    "source_text": row.get::<_, String>(0)?,
                    "translated_text": row.get::<_, String>(1)?,
                    "source_type": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            item["contexts"] = serde_json::json!(contexts);
        }
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
                let mkcol_method = reqwest::Method::from_bytes(b"MKCOL")
                    .map_err(|error| format!("Cannot prepare WebDAV directory request: {error}"))?;
                let _ = client.request(mkcol_method, parent_dir)
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

    app.emit("wordbook-updated", "sync").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn increment_translate_count(app: AppHandle) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    let count_str = db::get_config(&conn, "translated_count").unwrap_or_default();
    let count: i32 = count_str.parse().unwrap_or(0);
    db::set_config(&conn, "translated_count", &(count + 1).to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_app_stats(app: AppHandle) -> Result<serde_json::Value, String> {
    let app_dir = resolve_app_data_dir(&app)?;
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
    let app_dir = resolve_app_data_dir(&app)?;
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
    let app_dir = resolve_app_data_dir(&app)?;
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
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM glossary WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_glossary_entry(app: AppHandle, id: i64, source_term: String, target_term: String) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
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
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if should_show_main_window(&args) {
                tray::show_main_window(app);
            }
        }));
    }

    if let Err(error) = builder
        .manage(AppState { shortcuts_paused: Mutex::new(false), clipboard_lock: Mutex::new(false) })
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
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
                    let _ = main_win_clone.hide();
                }
            });

            let launch_args = std::env::args().collect::<Vec<_>>();
            if should_show_main_window(&launch_args) {
                tray::show_main_window(&app_handle);
            }

            let q_shortcut_str = db::get_config(&conn, "shortcut_q").unwrap_or_else(|_| "Alt+Q".to_string());
            let w_shortcut_str = db::get_config(&conn, "shortcut_w").unwrap_or_else(|_| "Alt+W".to_string());
            
            let q_shortcut_str = if q_shortcut_str.is_empty() { "Alt+Q".to_string() } else { q_shortcut_str };
            let w_shortcut_str = if w_shortcut_str.is_empty() { "Alt+W".to_string() } else { w_shortcut_str };

            let global_shortcut = app.global_shortcut();
            
            if let Ok(s) = parse_shortcut(&q_shortcut_str) {
                let _ = global_shortcut.on_shortcut(s, move |app, _shortcut, event| {
                    let paused = app
                        .state::<AppState>()
                        .shortcuts_paused
                        .lock()
                        .map(|value| *value)
                        .unwrap_or(true);
                    if paused { return; }
                    if event.state() == ShortcutState::Pressed {
                        handle_translate_request(app);
                    }
                });
            }

            if let Ok(s) = parse_shortcut(&w_shortcut_str) {
                let _ = global_shortcut.on_shortcut(s, move |app, _shortcut, event| {
                    let paused = app
                        .state::<AppState>()
                        .shortcuts_paused
                        .lock()
                        .map(|value| *value)
                        .unwrap_or(true);
                    if paused { return; }
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
            run_ocr, capture_and_ocr, confirm_ocr_text, get_available_ocr_languages, get_screen_bounds, get_clipboard_text, set_config_value, get_config_value,
            get_config_values, set_config_values, updater_configured,
            export_diagnostics,
            hide_floating_window, start_window_drag, clipboard_detect, add_to_wordbook, get_wordbook, wordbook::get_wordbook_page, delete_word,
            check_word_exists, update_word_analysis, tts::proxy_fetch_audio, tts::get_audio_cache_size,
            tts::clear_audio_cache, tts::check_audio_cache, webdav::sync_wordbook, webdav::test_webdav_connection, increment_translate_count, get_app_stats,
            update_shortcut, set_shortcuts_paused, backup::export_data, backup::import_data, tts::save_audio_cache,
            history::save_translation, history::get_translation_history, history::delete_translation, history::clear_translation_history,
            export_wordbook, history::lookup_translation_memory, history::save_translation_memory,
            review::get_due_reviews, review::submit_review, review::get_review_stats, export_anki,
            add_glossary_entry, get_glossary_entries, delete_glossary_entry, update_glossary_entry
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("Long Translate failed to start: {error}");
    }
}

fn should_show_main_window(args: &[String]) -> bool {
    !args.iter().any(|arg| arg == "--autostart")
}

#[cfg(test)]
mod tests {
    use super::should_show_main_window;

    #[test]
    fn manual_launch_shows_main_window_but_autostart_stays_in_tray() {
        assert!(should_show_main_window(&["long-translate.exe".into()]));
        assert!(!should_show_main_window(&[
            "long-translate.exe".into(),
            "--autostart".into(),
        ]));
    }

}

#[tauri::command]
fn get_config_values(app: AppHandle, keys: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
    let mut values = std::collections::HashMap::new();
    for key in keys {
        let value = secure_config::load_value(&conn, &key, &app_dir)?;
        values.insert(key, value);
    }
    Ok(values)
}

#[tauri::command]
fn set_config_values(app: AppHandle, values: std::collections::HashMap<String, String>) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let mut conn = db::init_db(app_dir.clone()).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (key, value) in values {
        let stored = secure_config::prepare_value(&key, &value)?;
        tx.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)", [&key, &stored])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
