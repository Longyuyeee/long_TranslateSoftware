mod anki;
mod backup;
mod config;
mod db;
mod diagnostics;
mod glossary;
mod history;
mod ocr;
mod review;
mod secure_config;
mod shortcuts;
mod system_integration;
mod tray;
mod tts;
mod webdav;
mod wordbook;

use tauri::{AppHandle, Manager, Emitter, WindowEvent};
use base64::{Engine as _, engine::general_purpose};
use std::fs;
use std::path::PathBuf;
use rusqlite::OptionalExtension;

fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))
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
fn get_available_ocr_languages() -> Result<Vec<ocr::OcrLanguageInfo>, String> {
    ocr::available_ocr_languages().map_err(|error| error.to_string())
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
        .manage(shortcuts::ShortcutState::default())
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

            shortcuts::register_saved_shortcuts(app.handle(), &conn);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_ocr, capture_and_ocr, confirm_ocr_text, get_available_ocr_languages,
            system_integration::get_screen_bounds, system_integration::get_clipboard_text,
            config::set_config_value, config::get_config_value,
            config::get_config_values, config::set_config_values, updater_configured,
            export_diagnostics,
            system_integration::hide_floating_window, system_integration::start_window_drag,
            system_integration::clipboard_detect, add_to_wordbook, get_wordbook, wordbook::get_wordbook_page, delete_word,
            check_word_exists, update_word_analysis, tts::proxy_fetch_audio, tts::get_audio_cache_size,
            tts::clear_audio_cache, tts::check_audio_cache, webdav::sync_wordbook, webdav::test_webdav_connection, increment_translate_count, get_app_stats,
            shortcuts::update_shortcut, shortcuts::set_shortcuts_paused,
            backup::export_data, backup::import_data, tts::save_audio_cache,
            history::save_translation, history::get_translation_history, history::delete_translation, history::clear_translation_history,
            export_wordbook, history::lookup_translation_memory, history::save_translation_memory,
            review::get_due_reviews, review::submit_review, review::get_review_stats, anki::export_anki,
            glossary::add_glossary_entry, glossary::get_glossary_entries,
            glossary::delete_glossary_entry, glossary::update_glossary_entry
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
