use rusqlite::{Connection, Result};
use std::path::PathBuf;
use uuid::Uuid;
use chrono;

pub fn init_db(app_dir: PathBuf) -> Result<Connection> {
    if !app_dir.exists() {
        std::fs::create_dir_all(&app_dir).unwrap();
    }
    let db_path = app_dir.join("words.db");
    let conn = Connection::open(db_path)?;

    // Create Wordbook table (Updated with uuid and soft delete)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS wordbook (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT UNIQUE NOT NULL,
            word TEXT NOT NULL,
            phonetic TEXT,
            meaning TEXT,
            analysis_json TEXT,
            source_context TEXT,
            is_deleted INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // Run Migrations for existing tables
    migrate_schema(&conn)?;

    // Create Config table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    // Initialize install_date if not exists
    let install_date = get_config(&conn, "install_date").unwrap_or_default();
    if install_date.is_empty() {
        let now = chrono::Local::now().format("%Y-%m-%d").to_string();
        set_config(&conn, "install_date", &now)?;
    }

    Ok(conn)
}

fn migrate_schema(conn: &Connection) -> Result<()> {
    let pragma_info: Vec<String> = conn
        .prepare("PRAGMA table_info(wordbook)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .map(|r| r.unwrap())
        .collect();

    // Add uuid if not exists
    if !pragma_info.contains(&"uuid".to_string()) {
        conn.execute("ALTER TABLE wordbook ADD COLUMN uuid TEXT", [])?;
        // Initialize existing rows with a random uuid
        let mut stmt = conn.prepare("SELECT id FROM wordbook WHERE uuid IS NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, i32>(0))?;
        let ids: Vec<i32> = rows.map(|r| r.unwrap()).collect();
        for id in ids {
            conn.execute("UPDATE wordbook SET uuid = ?1 WHERE id = ?2", [Uuid::new_v4().to_string(), id.to_string()])?;
        }
    }

    // Add is_deleted if not exists
    if !pragma_info.contains(&"is_deleted".to_string()) {
        conn.execute("ALTER TABLE wordbook ADD COLUMN is_deleted INTEGER DEFAULT 0", [])?;
    }

    // Add updated_at if not exists
    if !pragma_info.contains(&"updated_at".to_string()) {
        // SQLite doesn't allow CURRENT_TIMESTAMP as default for ALTER TABLE.
        // Use a fixed string instead, then update existing rows if needed.
        conn.execute("ALTER TABLE wordbook ADD COLUMN updated_at DATETIME DEFAULT '2024-01-01 00:00:00'", [])?;
        conn.execute("UPDATE wordbook SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = '2024-01-01 00:00:00'", [])?;
    }

    Ok(())
}

pub fn set_config(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
        [key, value],
    )?;
    Ok(())
}

pub fn get_config(conn: &Connection, key: &str) -> Result<String> {
    let mut stmt = conn.prepare("SELECT value FROM config WHERE key = ?1")?;
    let res: Result<String, rusqlite::Error> = stmt.query_row([key], |row| row.get(0));
    match res {
        Ok(value) => Ok(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok("".to_string()),
        Err(e) => Err(e),
    }
}
