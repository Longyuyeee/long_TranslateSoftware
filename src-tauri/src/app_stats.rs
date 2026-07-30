use crate::{command_error::CommandError, db};
use chrono::{Local, NaiveDate, NaiveDateTime};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, PartialEq, Serialize)]
pub struct AppStats {
    word_count: i32,
    trans_count: i32,
    days_active: i64,
    due_today: i32,
}

fn open_database(app: &AppHandle) -> Result<Connection, CommandError> {
    let app_dir = app.path().app_data_dir().map_err(|error| {
        CommandError::system(format!(
            "Cannot resolve application data directory: {error}"
        ))
    })?;
    db::init_db(app_dir).map_err(|error| CommandError::database(error.to_string()))
}

fn increment_count(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO config (key, value) VALUES ('translated_count', '1')
         ON CONFLICT(key) DO UPDATE
         SET value = CAST(config.value AS INTEGER) + 1",
        [],
    )
    .map_err(|error| format!("Cannot increment translation count: {error}"))?;
    Ok(())
}

fn days_active(install_date: &str, today: NaiveDate) -> i64 {
    NaiveDate::parse_from_str(install_date, "%Y-%m-%d")
        .map(|date| (today - date).num_days().saturating_add(1).max(1))
        .unwrap_or(1)
}

fn collect_app_stats(conn: &Connection, now: NaiveDateTime) -> Result<AppStats, String> {
    let word_count = conn
        .query_row(
            "SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot count wordbook entries: {error}"))?;
    let trans_count = db::get_config(conn, "translated_count")
        .map_err(|error| format!("Cannot read translation count: {error}"))?
        .parse()
        .unwrap_or(0);
    let now_text = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let due_today = conn
        .query_row(
            "SELECT COUNT(*) FROM wordbook
             WHERE is_deleted = 0
               AND (next_review IS NULL OR next_review <= ?1)",
            [now_text],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot count due reviews: {error}"))?;
    let install_date = db::get_config(conn, "install_date")
        .map_err(|error| format!("Cannot read install date: {error}"))?;

    Ok(AppStats {
        word_count,
        trans_count,
        days_active: days_active(&install_date, now.date()),
        due_today,
    })
}

#[tauri::command]
pub fn increment_translate_count(app: AppHandle) -> Result<(), CommandError> {
    let conn = open_database(&app)?;
    increment_count(&conn).map_err(CommandError::database)
}

#[tauri::command]
pub fn get_app_stats(app: AppHandle) -> Result<AppStats, CommandError> {
    let conn = open_database(&app)?;
    collect_app_stats(&conn, Local::now().naive_local()).map_err(CommandError::database)
}

#[cfg(test)]
mod tests {
    use super::{collect_app_stats, days_active, increment_count, AppStats};
    use crate::db;
    use chrono::NaiveDate;
    use uuid::Uuid;

    fn fixed_now() -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 30)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    }

    fn test_database() -> (std::path::PathBuf, rusqlite::Connection) {
        let directory =
            std::env::temp_dir().join(format!("long-translate-app-stats-{}", Uuid::new_v4()));
        let connection = db::init_db(directory.clone()).unwrap();
        (directory, connection)
    }

    #[test]
    fn increment_is_atomic_and_recovers_malformed_legacy_counts() {
        let (directory, conn) = test_database();
        db::set_config(&conn, "translated_count", "not-a-number").unwrap();

        increment_count(&conn).unwrap();
        increment_count(&conn).unwrap();

        assert_eq!(db::get_config(&conn, "translated_count").unwrap(), "2");
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stats_exclude_deleted_and_future_reviews_and_clamp_active_days() {
        let (directory, conn) = test_database();
        conn.execute(
            "INSERT INTO wordbook (uuid, word, next_review)
             VALUES ('due-word', 'due', NULL),
                    ('future-word', 'future', '2026-08-01 12:00:00'),
                    ('deleted-word', 'deleted', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE wordbook SET is_deleted = 1 WHERE uuid = 'deleted-word'",
            [],
        )
        .unwrap();
        db::set_config(&conn, "translated_count", "7").unwrap();
        db::set_config(&conn, "install_date", "2026-07-20").unwrap();

        assert_eq!(
            collect_app_stats(&conn, fixed_now()).unwrap(),
            AppStats {
                word_count: 2,
                trans_count: 7,
                days_active: 11,
                due_today: 1,
            }
        );
        assert_eq!(
            days_active("2026-08-01", NaiveDate::from_ymd_opt(2026, 7, 30).unwrap()),
            1
        );
        assert_eq!(
            days_active("invalid", NaiveDate::from_ymd_opt(2026, 7, 30).unwrap()),
            1
        );

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
