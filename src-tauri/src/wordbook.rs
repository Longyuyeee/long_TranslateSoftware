use crate::db;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

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
}
