use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::{db, secure_config};

fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))
}

fn open_database(app_dir: &Path) -> Result<Connection, String> {
    db::init_db(app_dir.to_path_buf())
        .map_err(|error| format!("Cannot open settings database: {error}"))
}

fn store_value(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    let stored = secure_config::prepare_value(key, value)?;
    db::set_config(conn, key, &stored)
        .map_err(|error| format!("Cannot save setting {key}: {error}"))
}

fn load_value(conn: &Connection, key: &str, app_dir: &Path) -> Result<String, String> {
    secure_config::load_value(conn, key, app_dir)
        .map_err(|error| format!("Cannot load setting {key}: {error}"))
}

fn load_values(
    conn: &Connection,
    keys: Vec<String>,
    app_dir: &Path,
) -> Result<HashMap<String, String>, String> {
    keys.into_iter()
        .map(|key| {
            let value = load_value(conn, &key, app_dir)?;
            Ok((key, value))
        })
        .collect()
}

fn store_values(conn: &mut Connection, values: HashMap<String, String>) -> Result<(), String> {
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Cannot start settings transaction: {error}"))?;
    for (key, value) in values {
        let stored = secure_config::prepare_value(&key, &value)?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                [&key, &stored],
            )
            .map_err(|error| format!("Cannot save setting {key}: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit settings transaction: {error}"))
}

#[tauri::command]
pub fn set_config_value(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = open_database(&app_dir)?;
    store_value(&conn, &key, &value)
}

#[tauri::command]
pub fn get_config_value(app: AppHandle, key: String) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = open_database(&app_dir)?;
    load_value(&conn, &key, &app_dir)
}

#[tauri::command]
pub fn get_config_values(
    app: AppHandle,
    keys: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let conn = open_database(&app_dir)?;
    load_values(&conn, keys, &app_dir)
}

#[tauri::command]
pub fn set_config_values(app: AppHandle, values: HashMap<String, String>) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(&app)?;
    let mut conn = open_database(&app_dir)?;
    store_values(&mut conn, values)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{load_values, store_value, store_values};
    use crate::{db, secure_config};
    use uuid::Uuid;

    fn test_database() -> (std::path::PathBuf, rusqlite::Connection) {
        let directory =
            std::env::temp_dir().join(format!("long-translate-config-{}", Uuid::new_v4()));
        let connection = db::init_db(directory.clone()).unwrap();
        (directory, connection)
    }

    #[test]
    #[cfg(windows)]
    fn config_round_trip_protects_sensitive_values_and_reads_missing_keys() {
        let (directory, mut conn) = test_database();
        store_values(
            &mut conn,
            HashMap::from([
                ("theme".to_string(), "dark".to_string()),
                ("webdav_pass".to_string(), "private-password".to_string()),
            ]),
        )
        .unwrap();

        let stored_secret = db::get_config(&conn, "webdav_pass").unwrap();
        assert!(stored_secret.starts_with("DPAPI:"));
        assert!(!stored_secret.contains("private-password"));
        let values = load_values(
            &conn,
            vec![
                "theme".to_string(),
                "webdav_pass".to_string(),
                "missing".to_string(),
            ],
            &directory,
        )
        .unwrap();
        assert_eq!(values["theme"], "dark");
        assert_eq!(values["webdav_pass"], "private-password");
        assert_eq!(values["missing"], "");

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn batch_write_rolls_back_every_key_when_one_insert_fails() {
        let (directory, mut conn) = test_database();
        store_value(&conn, "preserved", "before").unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_blocked_setting
             BEFORE INSERT ON config
             WHEN NEW.key = 'blocked'
             BEGIN
                 SELECT RAISE(ABORT, 'blocked setting');
             END;",
        )
        .unwrap();

        let result = store_values(
            &mut conn,
            HashMap::from([
                ("preserved".to_string(), "after".to_string()),
                ("new_value".to_string(), "new".to_string()),
                ("blocked".to_string(), "rejected".to_string()),
            ]),
        );

        assert!(result.is_err());
        assert_eq!(db::get_config(&conn, "preserved").unwrap(), "before");
        assert_eq!(db::get_config(&conn, "new_value").unwrap(), "");
        assert_eq!(db::get_config(&conn, "blocked").unwrap(), "");

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn batch_read_migrates_plaintext_sensitive_values() {
        let (directory, conn) = test_database();
        db::set_config(&conn, "trans_api_key", "legacy-plaintext").unwrap();

        let values = load_values(&conn, vec!["trans_api_key".to_string()], &directory).unwrap();

        assert_eq!(values["trans_api_key"], "legacy-plaintext");
        let migrated = db::get_config(&conn, "trans_api_key").unwrap();
        assert!(secure_config::is_sensitive_key("trans_api_key"));
        assert!(migrated.starts_with("DPAPI:"));
        assert!(!migrated.contains("legacy-plaintext"));

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
