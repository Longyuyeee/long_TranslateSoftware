use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{db, updater};

const EXCLUDED_DATA: &[&str] = &[
    "API keys and authentication tokens",
    "WebDAV URLs, usernames, and passwords",
    "source and translated text",
    "wordbook terms, meanings, and saved contexts",
    "glossary terms and custom prompts",
    "database files and cached audio",
];

#[derive(Debug, Serialize)]
pub struct DiagnosticReport {
    schema_version: u8,
    generated_at: String,
    application: ApplicationDiagnostics,
    database: DatabaseDiagnostics,
    configuration: ConfigurationDiagnostics,
    privacy: PrivacyDiagnostics,
}

#[derive(Debug, Serialize)]
struct ApplicationDiagnostics {
    version: String,
    operating_system: String,
    architecture: String,
    debug_build: bool,
}

#[derive(Debug, Serialize)]
struct DatabaseDiagnostics {
    schema_version: i64,
    active_word_count: i64,
    translation_history_count: i64,
    translation_memory_count: i64,
    glossary_count: i64,
    saved_context_count: i64,
}

#[derive(Debug, Serialize)]
struct ConfigurationDiagnostics {
    primary_translation_configured: bool,
    backup_translation_configured: bool,
    text_to_speech_configured: bool,
    webdav_configured: bool,
    updater_configured: bool,
    custom_ocr_language_selected: bool,
    previous_sync_recorded: bool,
}

#[derive(Debug, Serialize)]
struct PrivacyDiagnostics {
    contains_user_content: bool,
    excluded_data: &'static [&'static str],
}

fn count(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|error| format!("Cannot collect diagnostic count: {error}"))
}

fn config_is_set(conn: &Connection, key: &str) -> Result<bool, String> {
    conn.query_row("SELECT value FROM config WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map(|value| value.is_some_and(|value| !value.trim().is_empty()))
    .map_err(|error| format!("Cannot inspect diagnostic configuration state: {error}"))
}

fn any_config_is_set(conn: &Connection, keys: &[&str]) -> Result<bool, String> {
    for key in keys {
        if config_is_set(conn, key)? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn build_report(
    conn: &Connection,
    app_version: &str,
    updater_configured: bool,
) -> Result<DiagnosticReport, String> {
    let schema_version = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read database schema version: {error}"))?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);

    let ocr_language_is_set = config_is_set(conn, "ocr_lang")?;
    let default_ocr_language = db::get_config(conn, "ocr_lang").unwrap_or_default();

    Ok(DiagnosticReport {
        schema_version: 1,
        generated_at: chrono::Utc::now().to_rfc3339(),
        application: ApplicationDiagnostics {
            version: app_version.to_string(),
            operating_system: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            debug_build: cfg!(debug_assertions),
        },
        database: DatabaseDiagnostics {
            schema_version,
            active_word_count: count(conn, "SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0")?,
            translation_history_count: count(conn, "SELECT COUNT(*) FROM translation_history")?,
            translation_memory_count: count(conn, "SELECT COUNT(*) FROM translation_memory")?,
            glossary_count: count(conn, "SELECT COUNT(*) FROM glossary")?,
            saved_context_count: count(conn, "SELECT COUNT(*) FROM word_contexts")?,
        },
        configuration: ConfigurationDiagnostics {
            primary_translation_configured: any_config_is_set(
                conn,
                &["trans_api_key", "openai_api_key"],
            )?,
            backup_translation_configured: config_is_set(conn, "backup_api_key")?,
            text_to_speech_configured: any_config_is_set(conn, &["tts_engine", "tts_api_key"])?,
            webdav_configured: any_config_is_set(conn, &["webdav_url", "webdav_pass"])?,
            updater_configured,
            custom_ocr_language_selected: ocr_language_is_set
                && !matches!(default_ocr_language.trim(), "" | "auto"),
            previous_sync_recorded: config_is_set(conn, "last_sync_result")?,
        },
        privacy: PrivacyDiagnostics {
            contains_user_content: false,
            excluded_data: EXCLUDED_DATA,
        },
    })
}

#[tauri::command]
pub fn export_diagnostics(app: AppHandle) -> Result<String, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))?;
    let conn = db::init_db(app_dir).map_err(|error| error.to_string())?;
    let report = build_report(
        &conn,
        &app.package_info().version.to_string(),
        updater::is_configured(&app),
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

#[cfg(test)]
mod tests {
    use super::build_report;
    use crate::db;
    use uuid::Uuid;

    #[test]
    fn diagnostic_report_contains_counts_but_never_user_content_or_credentials() {
        let test_dir =
            std::env::temp_dir().join(format!("long-translate-diagnostics-{}", Uuid::new_v4()));
        let conn = db::init_db(test_dir.clone()).unwrap();

        let secret_markers = [
            ("trans_api_key", "API-SECRET-MARKER"),
            ("backup_api_key", "BACKUP-SECRET-MARKER"),
            ("tts_api_key", "TTS-SECRET-MARKER"),
            ("webdav_url", "https://private.example.invalid/user"),
            ("webdav_user", "PRIVATE-USERNAME-MARKER"),
            ("webdav_pass", "WEBDAV-PASSWORD-MARKER"),
            ("custom_prompt", "CUSTOM-PROMPT-MARKER"),
            ("ocr_lang", "ja-JP"),
            (
                "last_sync_result",
                r#"{"added":1,"completedAt":"private-time"}"#,
            ),
        ];
        for (key, value) in secret_markers {
            db::set_config(&conn, key, value).unwrap();
        }

        conn.execute(
            "INSERT INTO wordbook
             (uuid, word, meaning, is_deleted) VALUES ('diagnostic-word', 'PRIVATE-WORD-MARKER', 'PRIVATE-MEANING-MARKER', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO translation_history
             (source_text, translated_text) VALUES ('PRIVATE-SOURCE-MARKER', 'PRIVATE-TRANSLATION-MARKER')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO translation_memory
             (source_hash, target_lang, context_hash, source_text, translated_text)
             VALUES ('hash', 'English', 'context', 'PRIVATE-MEMORY-SOURCE', 'PRIVATE-MEMORY-TRANSLATION')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO glossary (source_term, target_term)
             VALUES ('PRIVATE-GLOSSARY-SOURCE', 'PRIVATE-GLOSSARY-TARGET')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO word_contexts
             (word_uuid, source_text, translated_text)
             VALUES ('diagnostic-word', 'PRIVATE-CONTEXT-SOURCE', 'PRIVATE-CONTEXT-TRANSLATION')",
            [],
        )
        .unwrap();

        let report = build_report(&conn, "0.4.8-test", true).unwrap();
        let serialized = serde_json::to_string_pretty(&report).unwrap();

        for marker in [
            "SECRET-MARKER",
            "private.example.invalid",
            "PRIVATE-USERNAME-MARKER",
            "WEBDAV-PASSWORD-MARKER",
            "CUSTOM-PROMPT-MARKER",
            "PRIVATE-WORD-MARKER",
            "PRIVATE-MEANING-MARKER",
            "PRIVATE-SOURCE-MARKER",
            "PRIVATE-TRANSLATION-MARKER",
            "PRIVATE-MEMORY-SOURCE",
            "PRIVATE-MEMORY-TRANSLATION",
            "PRIVATE-GLOSSARY-SOURCE",
            "PRIVATE-GLOSSARY-TARGET",
            "PRIVATE-CONTEXT-SOURCE",
            "PRIVATE-CONTEXT-TRANSLATION",
            "private-time",
        ] {
            assert!(!serialized.contains(marker), "report leaked {marker}");
        }

        assert!(serialized.contains(r#""active_word_count": 1"#));
        assert!(serialized.contains(r#""translation_history_count": 1"#));
        assert!(serialized.contains(r#""contains_user_content": false"#));
        assert!(serialized.contains(r#""primary_translation_configured": true"#));

        drop(conn);
        std::fs::remove_dir_all(test_dir).unwrap();
    }
}
