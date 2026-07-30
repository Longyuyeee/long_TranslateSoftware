use crate::db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const DEFAULT_PAGE_SIZE: i64 = 100;
const MAX_PAGE_SIZE: i64 = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordbookPage {
    pub items: Vec<Value>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordContextInput {
    source_text: String,
    translated_text: Option<String>,
    source_type: String,
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn order_clause(sort: &str) -> &'static str {
    match sort {
        "az" => "word COLLATE NOCASE ASC, id DESC",
        "za" => "word COLLATE NOCASE DESC, id DESC",
        _ => "created_at DESC, id DESC",
    }
}

pub(crate) fn query_wordbook_page(
    conn: &Connection,
    query: Option<&str>,
    sort: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<WordbookPage, String> {
    let query = query.unwrap_or_default().trim();
    let pattern = format!("%{}%", escape_like(query));
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let offset = offset.unwrap_or(0).max(0);
    let order = order_clause(sort.unwrap_or("newest"));
    let filter =
        "is_deleted = 0 AND (?1 = '' OR word LIKE ?2 ESCAPE '\\' COLLATE NOCASE OR COALESCE(meaning, '') LIKE ?2 ESCAPE '\\' COLLATE NOCASE)";

    let total = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM wordbook WHERE {filter}"),
            params![query, pattern],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;

    let sql = format!(
        "SELECT id, word, phonetic, meaning, analysis_json, created_at, uuid
         FROM wordbook
         WHERE {filter}
         ORDER BY {order}
         LIMIT ?3 OFFSET ?4"
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![query, pattern, limit, offset], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "word": row.get::<_, String>(1)?,
                "phonetic": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "meaning": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "analysis": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "created_at": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "uuid": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|error| error.to_string())?;

    let mut items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(stmt);

    for item in &mut items {
        let uuid = item["uuid"].as_str().unwrap_or_default();
        let mut context_stmt = conn
            .prepare(
                "SELECT id, source_text, translated_text, source_type, created_at
                 FROM word_contexts
                 WHERE word_uuid = ?1
                 ORDER BY created_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let contexts = context_stmt
            .query_map([uuid], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, i64>(0)?,
                    "source_text": row.get::<_, String>(1)?,
                    "translated_text": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "source_type": row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "manual".into()),
                    "created_at": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                }))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        item["contexts"] = serde_json::json!(contexts);
    }

    let returned = items.len() as i64;
    Ok(WordbookPage {
        items,
        total,
        offset,
        limit,
        has_more: offset + returned < total,
    })
}

#[tauri::command]
pub fn get_wordbook_page(
    app: AppHandle,
    query: Option<String>,
    sort: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<WordbookPage, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate application data: {error}"))?;
    let conn = db::init_db(app_dir).map_err(|error| error.to_string())?;
    query_wordbook_page(&conn, query.as_deref(), sort.as_deref(), limit, offset)
}

fn open_wordbook(app: &AppHandle) -> Result<Connection, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate application data: {error}"))?;
    db::init_db(app_dir).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn check_word_exists(app: AppHandle, word: String) -> Result<bool, String> {
    let conn = open_wordbook(&app)?;
    let mut stmt = conn
        .prepare("SELECT 1 FROM wordbook WHERE word = ?1 AND is_deleted = 0")
        .map_err(|error| error.to_string())?;
    stmt.exists([word]).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_to_wordbook(
    app: AppHandle,
    word: String,
    phonetic: Option<String>,
    meaning: Option<String>,
    analysis: Option<String>,
    context: Option<WordContextInput>,
) -> Result<(), String> {
    let conn = open_wordbook(&app)?;
    let existing_uuid: Option<String> = conn
        .query_row(
            "SELECT uuid FROM wordbook WHERE word = ?1 AND is_deleted = 0",
            [&word],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let uuid = if let Some(uuid) = existing_uuid {
        uuid
    } else {
        let uuid = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)",
            [
                &uuid,
                &word,
                &phonetic.unwrap_or_default(),
                &meaning.unwrap_or_default(),
                &analysis.unwrap_or_default(),
            ],
        )
        .map_err(|error| error.to_string())?;
        uuid
    };

    if let Some(context) = context {
        let source = context.source_text.trim();
        if !source.is_empty() {
            conn.execute(
                "INSERT OR IGNORE INTO word_contexts
                 (word_uuid, source_text, translated_text, source_type)
                 VALUES (?1, ?2, ?3, ?4)",
                [
                    &uuid,
                    source,
                    &context.translated_text.unwrap_or_default(),
                    &context.source_type,
                ],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    app.emit("wordbook-updated", "local")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_word_analysis(
    app: AppHandle,
    word: String,
    phonetic: String,
    meaning: String,
    analysis: String,
) -> Result<(), String> {
    let conn = open_wordbook(&app)?;
    conn.execute(
        "UPDATE wordbook
         SET phonetic = ?1, meaning = ?2, analysis_json = ?3,
             updated_at = CURRENT_TIMESTAMP
         WHERE word = ?4",
        [phonetic, meaning, analysis, word],
    )
    .map_err(|error| error.to_string())?;
    app.emit("wordbook-updated", "local")
        .map_err(|error| error.to_string())
}

fn query_all_wordbook(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, word, phonetic, meaning, analysis_json, created_at, uuid
             FROM wordbook
             WHERE is_deleted = 0
             ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i32>(0)?,
                "word": row.get::<_, String>(1)?,
                "phonetic": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "meaning": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "analysis": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "created_at": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "uuid": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    let mut words = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(stmt);

    for word in &mut words {
        let uuid = word["uuid"].as_str().unwrap_or_default();
        let mut context_stmt = conn
            .prepare(
                "SELECT id, source_text, translated_text, source_type, created_at
                 FROM word_contexts
                 WHERE word_uuid = ?1
                 ORDER BY created_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let contexts = context_stmt
            .query_map([uuid], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, i32>(0)?,
                    "source_text": row.get::<_, String>(1)?,
                    "translated_text": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "source_type": row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "manual".into()),
                    "created_at": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                }))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        word["contexts"] = serde_json::json!(contexts);
    }
    Ok(words)
}

#[tauri::command]
pub fn get_wordbook(app: AppHandle) -> Result<Vec<Value>, String> {
    let conn = open_wordbook(&app)?;
    query_all_wordbook(&conn)
}

#[tauri::command]
pub fn delete_word(app: AppHandle, id: i32) -> Result<(), String> {
    let conn = open_wordbook(&app)?;
    conn.execute(
        "UPDATE wordbook
         SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        [id],
    )
    .map_err(|error| error.to_string())?;
    app.emit("wordbook-updated", "local")
        .map_err(|error| error.to_string())
}

fn export_items(conn: &Connection) -> Result<Vec<(String, String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT word, phonetic, meaning, analysis_json
             FROM wordbook
             WHERE is_deleted = 0
             ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let items = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(items)
}

fn csv_field(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(crate) fn build_wordbook_export(conn: &Connection, format: &str) -> Result<String, String> {
    let items = export_items(conn)?;
    match format {
        "csv" => {
            let mut csv = String::from("word,phonetic,meaning,examples,synonyms\n");
            for (word, phonetic, meaning, analysis) in &items {
                let parsed = serde_json::from_str::<Value>(analysis).unwrap_or_default();
                let examples = parsed["examples"]
                    .as_array()
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|example| example["en"].as_str())
                            .collect::<Vec<_>>()
                            .join(" | ")
                    })
                    .unwrap_or_default();
                let synonyms = parsed["synonyms"]
                    .as_array()
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" | ")
                    })
                    .unwrap_or_default();
                csv.push_str(
                    &[
                        csv_field(word),
                        csv_field(phonetic),
                        csv_field(meaning),
                        csv_field(&examples),
                        csv_field(&synonyms),
                    ]
                    .join(","),
                );
                csv.push('\n');
            }
            Ok(csv)
        }
        "json" => {
            let json_items = items
                .iter()
                .map(|(word, phonetic, meaning, analysis)| {
                    serde_json::json!({
                        "word": word,
                        "phonetic": phonetic,
                        "meaning": meaning,
                        "analysis": serde_json::from_str::<Value>(analysis).unwrap_or_default(),
                    })
                })
                .collect::<Vec<_>>();
            serde_json::to_string_pretty(&json_items).map_err(|error| error.to_string())
        }
        _ => Err("Unsupported format".to_string()),
    }
}

#[tauri::command]
pub fn export_wordbook(app: AppHandle, format: String) -> Result<String, String> {
    let conn = open_wordbook(&app)?;
    let content = build_wordbook_export(&conn, &format)?;
    let extension = if format == "csv" { "csv" } else { "json" };
    let filter_name = if format == "csv" {
        "CSV Files"
    } else {
        "JSON Files"
    };
    let file_path = app
        .dialog()
        .file()
        .set_title("Export Wordbook")
        .add_filter(filter_name, &[extension])
        .set_file_name(format!("wordbook_export.{extension}"))
        .blocking_save_file()
        .ok_or_else(|| "User cancelled".to_string())?;
    let actual_path = match file_path {
        tauri_plugin_dialog::FilePath::Path(path) => path,
        tauri_plugin_dialog::FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "Invalid URL path".to_string())?,
    };
    std::fs::write(actual_path, content).map_err(|error| error.to_string())?;
    Ok("Export successful".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use uuid::Uuid;

    fn seeded_wordbook(count: usize) -> (std::path::PathBuf, Connection) {
        let test_dir =
            std::env::temp_dir().join(format!("long-translate-wordbook-{}", Uuid::new_v4()));
        let mut conn = db::init_db(test_dir.clone()).unwrap();
        let tx = conn.transaction().unwrap();
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO wordbook (uuid, word, meaning, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .unwrap();
            for index in 0..count {
                insert
                    .execute(params![
                        format!("word-{index:05}"),
                        format!("word-{index:05}"),
                        format!("meaning-{index:05}"),
                        format!("2026-07-{:02} 10:00:00", 1 + index % 27),
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
        (test_dir, conn)
    }

    #[test]
    fn paginates_searches_sorts_and_escapes_wildcards() {
        let (test_dir, conn) = seeded_wordbook(250);
        conn.execute(
            "INSERT INTO wordbook (uuid, word, meaning) VALUES ('literal-percent', '100% real', 'literal')",
            [],
        )
        .unwrap();

        let first = query_wordbook_page(&conn, None, Some("az"), Some(100), Some(0)).unwrap();
        assert_eq!(first.total, 251);
        assert_eq!(first.items.len(), 100);
        assert!(first.has_more);
        assert_eq!(first.items[0]["word"], "100% real");

        let last = query_wordbook_page(&conn, None, Some("za"), Some(100), Some(200)).unwrap();
        assert_eq!(last.items.len(), 51);
        assert!(!last.has_more);

        let literal =
            query_wordbook_page(&conn, Some("%"), Some("newest"), Some(100), Some(0)).unwrap();
        assert_eq!(literal.total, 1);
        assert_eq!(literal.items[0]["uuid"], "literal-percent");

        drop(conn);
        std::fs::remove_dir_all(test_dir).unwrap();
    }

    #[test]
    fn ten_thousand_item_query_has_a_repeatable_baseline() {
        let (test_dir, conn) = seeded_wordbook(10_000);
        let started = Instant::now();
        let first_page =
            query_wordbook_page(&conn, None, Some("newest"), Some(100), Some(0)).unwrap();
        let search_page =
            query_wordbook_page(&conn, Some("09999"), Some("newest"), Some(100), Some(0)).unwrap();
        let elapsed = started.elapsed();

        assert_eq!(first_page.total, 10_000);
        assert_eq!(first_page.items.len(), 100);
        assert!(first_page.has_more);
        assert_eq!(search_page.total, 1);
        assert_eq!(search_page.items[0]["uuid"], "word-09999");
        assert!(
            elapsed < Duration::from_secs(2),
            "10k first page and search took {elapsed:?}"
        );

        drop(conn);
        std::fs::remove_dir_all(test_dir).unwrap();
    }

    #[test]
    fn legacy_list_keeps_all_items_and_word_contexts() {
        let (test_dir, conn) = seeded_wordbook(250);
        conn.execute(
            "INSERT INTO word_contexts
             (word_uuid, source_text, translated_text, source_type)
             VALUES ('word-00000', 'source', 'translated', 'manual')",
            [],
        )
        .unwrap();

        let words = query_all_wordbook(&conn).unwrap();

        assert_eq!(words.len(), 250);
        let first = words
            .iter()
            .find(|word| word["uuid"] == "word-00000")
            .unwrap();
        assert_eq!(first["contexts"][0]["source_text"], "source");

        drop(conn);
        std::fs::remove_dir_all(test_dir).unwrap();
    }

    #[test]
    fn exports_csv_escaping_and_structured_json() {
        let (test_dir, conn) = seeded_wordbook(0);
        conn.execute(
            "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "export-word",
                "say \"hello\"",
                "/hello/",
                "greeting, salutation",
                r#"{"examples":[{"en":"Hello, world"}],"synonyms":["hi","welcome"]}"#,
            ],
        )
        .unwrap();

        let csv = build_wordbook_export(&conn, "csv").unwrap();
        assert!(csv.contains("\"say \"\"hello\"\"\""));
        assert!(csv.contains("\"greeting, salutation\""));
        assert!(csv.contains("\"Hello, world\""));

        let json: Value =
            serde_json::from_str(&build_wordbook_export(&conn, "json").unwrap()).unwrap();
        assert_eq!(json[0]["analysis"]["synonyms"][0], "hi");
        assert_eq!(
            build_wordbook_export(&conn, "xml").unwrap_err(),
            "Unsupported format"
        );

        drop(conn);
        std::fs::remove_dir_all(test_dir).unwrap();
    }
}
