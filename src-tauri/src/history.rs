use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::db;

const DEFAULT_HISTORY_LIMIT: i32 = 100;
const MAX_HISTORY_LIMIT: i32 = 500;

#[derive(Debug, Serialize)]
pub struct TranslationHistoryEntry {
    id: i32,
    source_text: String,
    translated_text: String,
    source_lang: String,
    target_lang: String,
    model: String,
    created_at: String,
}

fn insert_translation(
    conn: &Connection,
    source_text: &str,
    translated_text: &str,
    source_lang: Option<&str>,
    target_lang: Option<&str>,
    model: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO translation_history
         (source_text, translated_text, source_lang, target_lang, model)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            source_text,
            translated_text,
            source_lang.unwrap_or_default(),
            target_lang.unwrap_or_default(),
            model.unwrap_or_default()
        ],
    )
    .map_err(|error| format!("Cannot save translation history: {error}"))?;
    Ok(())
}

fn list_translation_history(
    conn: &Connection,
    limit: Option<i32>,
    offset: Option<i32>,
) -> Result<Vec<TranslationHistoryEntry>, String> {
    let limit = limit
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(1, MAX_HISTORY_LIMIT);
    let offset = offset.unwrap_or(0).max(0);
    let mut stmt = conn
        .prepare(
            "SELECT id, source_text, translated_text, source_lang, target_lang, model, created_at
             FROM translation_history
             ORDER BY created_at DESC, id DESC
             LIMIT ?1 OFFSET ?2",
        )
        .map_err(|error| format!("Cannot prepare translation history query: {error}"))?;
    let rows = stmt
        .query_map([limit, offset], |row| {
            Ok(TranslationHistoryEntry {
                id: row.get(0)?,
                source_text: row.get(1)?,
                translated_text: row.get(2)?,
                source_lang: row.get(3)?,
                target_lang: row.get(4)?,
                model: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Cannot query translation history: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read translation history row: {error}"))
}

fn delete_translation_by_id(conn: &Connection, id: i32) -> Result<(), String> {
    conn.execute("DELETE FROM translation_history WHERE id = ?1", [id])
        .map_err(|error| format!("Cannot delete translation history entry: {error}"))?;
    Ok(())
}

fn clear_history(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM translation_history", [])
        .map_err(|error| format!("Cannot clear translation history: {error}"))?;
    Ok(())
}

fn content_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn lookup_memory(
    conn: &Connection,
    text: &str,
    target_lang: &str,
    cache_context: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT translated_text FROM translation_memory
         WHERE source_hash = ?1 AND target_lang = ?2 AND context_hash = ?3",
        params![content_hash(text), target_lang, content_hash(cache_context)],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("Cannot read translation memory: {error}"))
}

fn store_memory(
    conn: &Connection,
    source_text: &str,
    translated_text: &str,
    target_lang: &str,
    cache_context: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO translation_memory
         (source_hash, target_lang, context_hash, source_text, translated_text)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            content_hash(source_text),
            target_lang,
            content_hash(cache_context),
            source_text,
            translated_text
        ],
    )
    .map_err(|error| format!("Cannot save translation memory: {error}"))?;
    Ok(())
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))?;
    db::init_db(app_dir).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_translation(
    app: AppHandle,
    source_text: String,
    translated_text: String,
    source_lang: Option<String>,
    target_lang: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    insert_translation(
        &conn,
        &source_text,
        &translated_text,
        source_lang.as_deref(),
        target_lang.as_deref(),
        model.as_deref(),
    )?;
    app.emit("history-updated", "")
        .map_err(|error| format!("Cannot notify translation history update: {error}"))
}

#[tauri::command]
pub fn get_translation_history(
    app: AppHandle,
    limit: Option<i32>,
    offset: Option<i32>,
) -> Result<Vec<TranslationHistoryEntry>, String> {
    let conn = open_database(&app)?;
    list_translation_history(&conn, limit, offset)
}

#[tauri::command]
pub fn delete_translation(app: AppHandle, id: i32) -> Result<(), String> {
    let conn = open_database(&app)?;
    delete_translation_by_id(&conn, id)
}

#[tauri::command]
pub fn clear_translation_history(app: AppHandle) -> Result<(), String> {
    let conn = open_database(&app)?;
    clear_history(&conn)?;
    app.emit("history-updated", "")
        .map_err(|error| format!("Cannot notify translation history update: {error}"))
}

#[tauri::command]
pub fn lookup_translation_memory(
    app: AppHandle,
    text: String,
    target_lang: String,
    cache_context: String,
) -> Result<Option<String>, String> {
    let conn = open_database(&app)?;
    lookup_memory(&conn, &text, &target_lang, &cache_context)
}

#[tauri::command]
pub fn save_translation_memory(
    app: AppHandle,
    source_text: String,
    translated_text: String,
    target_lang: String,
    cache_context: String,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    store_memory(
        &conn,
        &source_text,
        &translated_text,
        &target_lang,
        &cache_context,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        clear_history, delete_translation_by_id, insert_translation, list_translation_history,
        lookup_memory, store_memory, MAX_HISTORY_LIMIT,
    };
    use crate::db;
    use uuid::Uuid;

    fn test_database(name: &str) -> (std::path::PathBuf, rusqlite::Connection) {
        let directory =
            std::env::temp_dir().join(format!("long-translate-{name}-{}", Uuid::new_v4()));
        let connection = db::init_db(directory.clone()).unwrap();
        (directory, connection)
    }

    #[test]
    fn history_pagination_is_bounded_and_delete_clear_are_deterministic() {
        let (directory, conn) = test_database("history");
        for index in 0..(MAX_HISTORY_LIMIT + 5) {
            insert_translation(
                &conn,
                &format!("source-{index}"),
                &format!("translation-{index}"),
                Some("English"),
                Some("Chinese"),
                Some("test-model"),
            )
            .unwrap();
        }

        let bounded = list_translation_history(&conn, Some(i32::MAX), Some(-100)).unwrap();
        assert_eq!(bounded.len(), MAX_HISTORY_LIMIT as usize);
        assert_eq!(
            bounded[0].source_text,
            format!("source-{}", MAX_HISTORY_LIMIT + 4)
        );

        let id_to_delete = bounded[0].id;
        delete_translation_by_id(&conn, id_to_delete).unwrap();
        assert!(list_translation_history(&conn, Some(1), Some(0))
            .unwrap()
            .iter()
            .all(|entry| entry.id != id_to_delete));

        clear_history(&conn).unwrap();
        assert!(list_translation_history(&conn, None, None)
            .unwrap()
            .is_empty());

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn translation_memory_isolated_by_language_and_cache_context() {
        let (directory, conn) = test_database("memory");
        store_memory(&conn, "hello", "你好", "Chinese", "primary:model-a").unwrap();
        store_memory(&conn, "hello", "您好", "Chinese", "backup:model-b").unwrap();

        assert_eq!(
            lookup_memory(&conn, "hello", "Chinese", "primary:model-a").unwrap(),
            Some("你好".to_string())
        );
        assert_eq!(
            lookup_memory(&conn, "hello", "Chinese", "backup:model-b").unwrap(),
            Some("您好".to_string())
        );
        assert_eq!(
            lookup_memory(&conn, "hello", "Japanese", "primary:model-a").unwrap(),
            None
        );

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
