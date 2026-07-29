use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db;

#[derive(Debug, Deserialize, Serialize)]
pub struct GlossaryEntry {
    id: i64,
    source_term: String,
    target_term: String,
    created_at: String,
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))?;
    db::init_db(app_dir).map_err(|error| error.to_string())
}

fn map_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<GlossaryEntry> {
    Ok(GlossaryEntry {
        id: row.get(0)?,
        source_term: row.get(1)?,
        target_term: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn insert_entry(
    conn: &Connection,
    source_term: &str,
    target_term: &str,
) -> Result<GlossaryEntry, String> {
    conn.execute(
        "INSERT INTO glossary (source_term, target_term) VALUES (?1, ?2)",
        params![source_term, target_term],
    )
    .map_err(|error| format!("Cannot add glossary entry: {error}"))?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, source_term, target_term, created_at FROM glossary WHERE id = ?1",
        [id],
        map_entry,
    )
    .map_err(|error| format!("Cannot read added glossary entry: {error}"))
}

fn list_entries(conn: &Connection) -> Result<Vec<GlossaryEntry>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, source_term, target_term, created_at
             FROM glossary
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|error| format!("Cannot prepare glossary query: {error}"))?;
    let rows = statement
        .query_map([], map_entry)
        .map_err(|error| format!("Cannot query glossary entries: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read glossary entry: {error}"))
}

fn delete_entry(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM glossary WHERE id = ?1", [id])
        .map_err(|error| format!("Cannot delete glossary entry: {error}"))?;
    Ok(())
}

fn update_entry(
    conn: &Connection,
    id: i64,
    source_term: &str,
    target_term: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE glossary SET source_term = ?1, target_term = ?2 WHERE id = ?3",
        params![source_term, target_term, id],
    )
    .map_err(|error| format!("Cannot update glossary entry: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn add_glossary_entry(
    app: AppHandle,
    source_term: String,
    target_term: String,
) -> Result<GlossaryEntry, String> {
    let conn = open_database(&app)?;
    insert_entry(&conn, &source_term, &target_term)
}

#[tauri::command]
pub fn get_glossary_entries(app: AppHandle) -> Result<Vec<GlossaryEntry>, String> {
    let conn = open_database(&app)?;
    list_entries(&conn)
}

#[tauri::command]
pub fn delete_glossary_entry(app: AppHandle, id: i64) -> Result<(), String> {
    let conn = open_database(&app)?;
    delete_entry(&conn, id)
}

#[tauri::command]
pub fn update_glossary_entry(
    app: AppHandle,
    id: i64,
    source_term: String,
    target_term: String,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    update_entry(&conn, id, &source_term, &target_term)
}

#[cfg(test)]
mod tests {
    use super::{delete_entry, insert_entry, list_entries, update_entry};
    use crate::db;
    use uuid::Uuid;

    fn test_database() -> (std::path::PathBuf, rusqlite::Connection) {
        let directory =
            std::env::temp_dir().join(format!("long-translate-glossary-{}", Uuid::new_v4()));
        let connection = db::init_db(directory.clone()).unwrap();
        (directory, connection)
    }

    #[test]
    fn glossary_crud_returns_persisted_values_in_stable_order() {
        let (directory, conn) = test_database();
        let first = insert_entry(&conn, "API", "接口").unwrap();
        let second = insert_entry(&conn, "cache", "缓存").unwrap();

        assert!(!first.created_at.is_empty());
        assert!(!second.created_at.is_empty());
        assert_eq!(
            list_entries(&conn)
                .unwrap()
                .iter()
                .map(|entry| entry.source_term.as_str())
                .collect::<Vec<_>>(),
            vec!["cache", "API"],
        );

        update_entry(&conn, first.id, "REST API", "REST 接口").unwrap();
        let updated = list_entries(&conn).unwrap();
        assert!(updated.iter().any(|entry| {
            entry.id == first.id
                && entry.source_term == "REST API"
                && entry.target_term == "REST 接口"
        }));

        delete_entry(&conn, second.id).unwrap();
        let remaining = list_entries(&conn).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, first.id);

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
