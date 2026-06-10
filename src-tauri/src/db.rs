use rusqlite::{Connection, Result};
use std::path::PathBuf;
use uuid::Uuid;
use chrono;

fn get_schema_version(conn: &Connection) -> i32 {
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = 'version'",
        [],
        |row| row.get::<_, String>(0),
    )
    .map(|v| v.parse().unwrap_or(0))
    .unwrap_or(0)
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?1)",
        [version.to_string()],
    )?;
    Ok(())
}

pub fn init_db(app_dir: PathBuf) -> Result<Connection> {
    if !app_dir.exists() {
        std::fs::create_dir_all(&app_dir).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    }
    let db_path = app_dir.join("words.db");
    let conn = Connection::open(db_path)?;

    // Create schema version table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )?;

    let current_version = get_schema_version(&conn);

    // Run versioned migrations
    if current_version < 1 {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS wordbook (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT UNIQUE NOT NULL,
                word TEXT NOT NULL,
                phonetic TEXT,
                meaning TEXT,
                analysis_json TEXT,
                is_deleted INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )?;
        set_schema_version(&conn, 1)?;
    }

    if current_version < 2 {
        // Handle old databases: add uuid/is_deleted/updated_at if missing
        let pragma_info: Vec<String> = conn
            .prepare("PRAGMA table_info(wordbook)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();
        if !pragma_info.contains(&"uuid".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN uuid TEXT", [])?;
            let mut stmt = conn.prepare("SELECT id FROM wordbook WHERE uuid IS NULL")?;
            let rows = stmt.query_map([], |row| row.get::<_, i32>(0))?;
            for row in rows {
                if let Ok(id) = row {
                    conn.execute("UPDATE wordbook SET uuid = ?1 WHERE id = ?2",
                        [Uuid::new_v4().to_string(), id.to_string()])?;
                }
            }
        }
        if !pragma_info.contains(&"is_deleted".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN is_deleted INTEGER DEFAULT 0", [])?;
        }
        if !pragma_info.contains(&"updated_at".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN updated_at DATETIME DEFAULT '2024-01-01 00:00:00'", [])?;
            conn.execute("UPDATE wordbook SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = '2024-01-01 00:00:00'", [])?;
        }
        set_schema_version(&conn, 2)?;
    }

    if current_version < 3 {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS translation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_text TEXT NOT NULL, translated_text TEXT NOT NULL,
                source_lang TEXT DEFAULT '', target_lang TEXT DEFAULT '',
                model TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_history_created_at ON translation_history(created_at)", [])?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS translation_memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_hash TEXT NOT NULL, target_lang TEXT NOT NULL,
                source_text TEXT NOT NULL, translated_text TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(source_hash, target_lang)
            )",
            [],
        )?;
        // Create performance indexes
        for idx in &["word", "is_deleted", "created_at", "updated_at", "uuid"] {
            let sql = format!("CREATE INDEX IF NOT EXISTS idx_wordbook_{} ON wordbook({})", idx, idx);
            conn.execute(&sql, [])?;
        }
        set_schema_version(&conn, 3)?;
    }

    if current_version < 4 {
        // Add SM-2 spaced repetition columns for vocabulary learning
        let pragma_info: Vec<String> = conn
            .prepare("PRAGMA table_info(wordbook)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();
        if !pragma_info.contains(&"ease_factor".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN ease_factor REAL DEFAULT 2.5", [])?;
        }
        if !pragma_info.contains(&"interval_days".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN interval_days INTEGER DEFAULT 0", [])?;
        }
        if !pragma_info.contains(&"repetitions".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN repetitions INTEGER DEFAULT 0", [])?;
        }
        if !pragma_info.contains(&"next_review".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN next_review DATETIME", [])?;
        }
        if !pragma_info.contains(&"last_reviewed".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN last_reviewed DATETIME", [])?;
        }
        set_schema_version(&conn, 4)?;
    }

    if current_version < 5 {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS glossary (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_term TEXT NOT NULL,
                target_term TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;
        set_schema_version(&conn, 5)?;
    }

    if current_version < 6 {
        // Add FSRS columns to replace SM-2
        let pragma_info: Vec<String> = conn
            .prepare("PRAGMA table_info(wordbook)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();
        if !pragma_info.contains(&"stability".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN stability REAL DEFAULT 0", [])?;
        }
        if !pragma_info.contains(&"difficulty".to_string()) {
            conn.execute("ALTER TABLE wordbook ADD COLUMN difficulty REAL DEFAULT 0", [])?;
        }
        // Migrate existing SM-2 data → FSRS: stability = interval_days, difficulty = 5.0 (default)
        conn.execute(
            "UPDATE wordbook SET stability = MAX(interval_days, 0.1), difficulty = 5.0 WHERE stability = 0 AND interval_days > 0",
            [],
        )?;
        set_schema_version(&conn, 6)?;
    }

    // Initialize install_date if not exists
    let install_date = get_config(&conn, "install_date").unwrap_or_default();
    if install_date.is_empty() {
        let now = chrono::Local::now().format("%Y-%m-%d").to_string();
        set_config(&conn, "install_date", &now)?;
    }

    Ok(conn)
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
