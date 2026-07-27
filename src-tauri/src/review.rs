use chrono::{Duration, Local, NaiveDateTime};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;

const DEFAULT_DUE_LIMIT: i32 = 50;
const MAX_DUE_LIMIT: i32 = 200;

// Standard FSRS-5 parameters from the open-spaced-repetition project.
const W: [f64; 19] = [
    0.4027, 0.5904, 0.9180, 0.4325, // w0-w3: initial stability per rating 1-4
    3.4615, 0.7028, // w4-w5: initial difficulty
    0.9264, // w6: difficulty delta
    0.0232, 0.8851, 0.3068, 0.6761, // w7-w10: stability
    2.1960, 0.0469, 0.3361, 1.2586, // w11-w14: stability
    0.2864, 2.5646, 0.2845, 0.3494, // w15-w18: rating modifiers
];

#[derive(Debug, Serialize)]
pub struct DueReview {
    id: i32,
    word: String,
    phonetic: String,
    meaning: String,
    analysis: String,
    stability: f64,
    difficulty: f64,
    interval_days: i32,
    repetitions: i32,
    next_review: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReviewResult {
    interval: i32,
    stability: f64,
    difficulty: f64,
    next_review: String,
}

#[derive(Debug, Serialize)]
pub struct ReviewStats {
    total: i32,
    reviewed: i32,
    mastered: i32,
    due_today: i32,
    streak: i32,
}

#[derive(Debug)]
struct ReviewSchedule {
    interval_days: i32,
    stability: f64,
    difficulty: f64,
    next_review: NaiveDateTime,
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))?;
    db::init_db(app_dir).map_err(|error| error.to_string())
}

fn normalized_due_limit(limit: Option<i32>) -> i32 {
    limit.unwrap_or(DEFAULT_DUE_LIMIT).clamp(1, MAX_DUE_LIMIT)
}

fn list_due_reviews(
    conn: &Connection,
    now: NaiveDateTime,
    limit: Option<i32>,
) -> Result<Vec<DueReview>, String> {
    let now = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let mut stmt = conn
        .prepare(
            "SELECT id, word, COALESCE(phonetic, ''), COALESCE(meaning, ''),
                    COALESCE(analysis_json, ''), stability, difficulty,
                    interval_days, repetitions, next_review
             FROM wordbook
             WHERE is_deleted = 0 AND (next_review IS NULL OR next_review <= ?1)
             ORDER BY next_review ASC, id ASC
             LIMIT ?2",
        )
        .map_err(|error| format!("Cannot prepare due review query: {error}"))?;
    let rows = stmt
        .query_map(params![now, normalized_due_limit(limit)], |row| {
            Ok(DueReview {
                id: row.get(0)?,
                word: row.get(1)?,
                phonetic: row.get(2)?,
                meaning: row.get(3)?,
                analysis: row.get(4)?,
                stability: row.get(5)?,
                difficulty: row.get(6)?,
                interval_days: row.get(7)?,
                repetitions: row.get(8)?,
                next_review: row.get(9)?,
            })
        })
        .map_err(|error| format!("Cannot query due reviews: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read due review row: {error}"))
}

fn retrievability(elapsed_days: f64, stability: f64) -> f64 {
    if stability <= 0.0 {
        return 1.0;
    }
    (0.9_f64).powf(elapsed_days.max(0.0) / stability)
}

fn init_stability(rating: u8) -> f64 {
    match rating {
        1 => W[0],
        2 => W[1],
        3 => W[2],
        4 => W[3],
        _ => W[2],
    }
}

fn init_difficulty(rating: u8) -> f64 {
    (W[4] - W[5] * (rating as f64 - 3.0)).clamp(1.0, 10.0)
}

fn next_difficulty(difficulty: f64, rating: u8) -> f64 {
    let delta = -W[6] * (rating as f64 - 3.0);
    (difficulty + delta * (10.0 - difficulty) / 9.0).clamp(1.0, 10.0)
}

fn next_stability(stability: f64, difficulty: f64, retrievability: f64, rating: u8) -> f64 {
    if rating == 1 {
        let minimum = W[7];
        let maximum = stability / (1.0 + W[8] * (difficulty - 1.0).max(0.0));
        return maximum.max(minimum).min(stability);
    }

    let hard_penalty = if rating == 2 { W[15] } else { 1.0 };
    let easy_bonus = if rating == 4 {
        W[16].exp() * (difficulty - W[17]).max(0.0) / W[18]
    } else {
        0.0
    };
    let base = stability
        * (1.0
            + W[9].exp()
                * (11.0 - difficulty)
                * stability.powf(-W[10])
                * ((1.0 - retrievability) * W[11]).exp()
                * W[12]);
    (base * hard_penalty + easy_bonus).max(0.01)
}

fn calculate_schedule(
    stability: f64,
    difficulty: f64,
    last_reviewed: Option<&str>,
    quality: i32,
    now: NaiveDateTime,
) -> ReviewSchedule {
    let rating = quality.clamp(1, 4) as u8;
    let elapsed_days = last_reviewed
        .and_then(|value| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").ok())
        .map(|last| (now - last).num_seconds().max(0) as f64 / 86_400.0)
        .unwrap_or(0.0);

    let (new_stability, new_difficulty) = if stability <= 0.0 {
        (init_stability(rating), init_difficulty(rating))
    } else {
        let remembered = retrievability(elapsed_days, stability);
        let new_difficulty = next_difficulty(difficulty, rating);
        (
            next_stability(stability, new_difficulty, remembered, rating),
            new_difficulty,
        )
    };
    let interval_days = (new_stability.round() as i32).max(1);

    ReviewSchedule {
        interval_days,
        stability: new_stability,
        difficulty: new_difficulty,
        next_review: now + Duration::days(interval_days as i64),
    }
}

fn apply_review(
    conn: &mut Connection,
    word_id: i32,
    quality: i32,
    now: NaiveDateTime,
) -> Result<ReviewResult, String> {
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Cannot start review transaction: {error}"))?;
    let (stability, difficulty, last_reviewed): (f64, f64, Option<String>) = transaction
        .query_row(
            "SELECT stability, difficulty, last_reviewed FROM wordbook
             WHERE id = ?1 AND is_deleted = 0",
            [word_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Cannot load review state: {error}"))?;
    let schedule = calculate_schedule(
        stability,
        difficulty,
        last_reviewed.as_deref(),
        quality,
        now,
    );
    let now_text = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let next_review = schedule.next_review.format("%Y-%m-%d %H:%M:%S").to_string();

    transaction
        .execute(
            "UPDATE wordbook
             SET stability = ?1, difficulty = ?2, interval_days = ?3,
                 repetitions = repetitions + 1, next_review = ?4, last_reviewed = ?5
             WHERE id = ?6",
            params![
                schedule.stability,
                schedule.difficulty,
                schedule.interval_days,
                next_review,
                now_text,
                word_id
            ],
        )
        .map_err(|error| format!("Cannot save review result: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit review result: {error}"))?;

    Ok(ReviewResult {
        interval: schedule.interval_days,
        stability: schedule.stability,
        difficulty: schedule.difficulty,
        next_review,
    })
}

fn collect_review_stats(conn: &Connection, now: NaiveDateTime) -> Result<ReviewStats, String> {
    let now_text = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let count = |sql: &str| {
        conn.query_row(sql, [], |row| row.get::<_, i32>(0))
            .map_err(|error| format!("Cannot collect review statistics: {error}"))
    };
    let total = count("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0")?;
    let reviewed = count(
        "SELECT COUNT(*) FROM wordbook
         WHERE is_deleted = 0 AND last_reviewed IS NOT NULL",
    )?;
    let mastered = count("SELECT COUNT(*) FROM wordbook WHERE is_deleted = 0 AND stability >= 21")?;
    let due_today = conn
        .query_row(
            "SELECT COUNT(*) FROM wordbook
             WHERE is_deleted = 0 AND (next_review IS NULL OR next_review <= ?1)",
            [now_text],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot collect due review statistics: {error}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT DATE(last_reviewed) AS review_date
             FROM wordbook
             WHERE is_deleted = 0 AND last_reviewed IS NOT NULL
             ORDER BY review_date DESC
             LIMIT 30",
        )
        .map_err(|error| format!("Cannot prepare review streak query: {error}"))?;
    let review_dates = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Cannot query review streak: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read review streak row: {error}"))?;
    let today = now.date();
    let mut streak = 0;
    for day_offset in 0..30 {
        let date = (today - Duration::days(day_offset))
            .format("%Y-%m-%d")
            .to_string();
        if review_dates.contains(&date) {
            streak += 1;
        } else if day_offset > 0 {
            break;
        }
    }

    Ok(ReviewStats {
        total,
        reviewed,
        mastered,
        due_today,
        streak,
    })
}

#[tauri::command]
pub fn get_due_reviews(app: AppHandle, limit: Option<i32>) -> Result<Vec<DueReview>, String> {
    let conn = open_database(&app)?;
    list_due_reviews(&conn, Local::now().naive_local(), limit)
}

#[tauri::command]
pub fn submit_review(app: AppHandle, word_id: i32, quality: i32) -> Result<ReviewResult, String> {
    let mut conn = open_database(&app)?;
    let result = apply_review(&mut conn, word_id, quality, Local::now().naive_local())?;
    app.emit("wordbook-updated", "local")
        .map_err(|error| format!("Cannot notify wordbook update: {error}"))?;
    Ok(result)
}

#[tauri::command]
pub fn get_review_stats(app: AppHandle) -> Result<ReviewStats, String> {
    let conn = open_database(&app)?;
    collect_review_stats(&conn, Local::now().naive_local())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_review, calculate_schedule, collect_review_stats, list_due_reviews,
        normalized_due_limit, MAX_DUE_LIMIT,
    };
    use crate::db;
    use chrono::NaiveDate;
    use uuid::Uuid;

    fn fixed_now() -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 27)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    }

    fn test_database() -> (std::path::PathBuf, rusqlite::Connection) {
        let directory =
            std::env::temp_dir().join(format!("long-translate-review-{}", Uuid::new_v4()));
        let connection = db::init_db(directory.clone()).unwrap();
        (directory, connection)
    }

    #[test]
    fn fsrs_schedule_clamps_ratings_and_keeps_values_bounded() {
        let now = fixed_now();
        for quality in [-100, 1, 2, 3, 4, 100] {
            let schedule = calculate_schedule(0.0, 0.0, None, quality, now);
            assert!(schedule.stability > 0.0);
            assert!((1.0..=10.0).contains(&schedule.difficulty));
            assert!(schedule.interval_days >= 1);
            assert!(schedule.next_review > now);
        }

        let again = calculate_schedule(10.0, 5.0, Some("2026-07-20 12:00:00"), 1, now);
        assert!(again.stability <= 10.0);
        assert_eq!(normalized_due_limit(Some(i32::MAX)), MAX_DUE_LIMIT);
        assert_eq!(normalized_due_limit(Some(-1)), 1);
    }

    #[test]
    fn due_query_review_submission_and_stats_share_one_database_boundary() {
        let (directory, mut conn) = test_database();
        conn.execute(
            "INSERT INTO wordbook
             (uuid, word, phonetic, meaning, analysis_json, next_review)
             VALUES ('due-word', 'due', '', '', '{}', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wordbook
             (uuid, word, phonetic, meaning, analysis_json, next_review)
             VALUES ('future-word', 'future', '', '', '{}', '2026-08-01 12:00:00')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wordbook
             (uuid, word, phonetic, meaning, analysis_json, is_deleted, last_reviewed)
             VALUES ('deleted-word', 'deleted', '', '', '{}', 1, '2026-07-27 09:00:00')",
            [],
        )
        .unwrap();

        assert_eq!(
            collect_review_stats(&conn, fixed_now()).unwrap().streak,
            0,
            "deleted cards must not contribute to the active review streak"
        );
        let due = list_due_reviews(&conn, fixed_now(), None).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].word, "due");

        let result = apply_review(&mut conn, due[0].id, 3, fixed_now()).unwrap();
        assert!(result.interval >= 1);
        assert!(result.next_review.starts_with("2026-07-28"));

        let stats = collect_review_stats(&conn, fixed_now()).unwrap();
        assert_eq!(stats.total, 2);
        assert_eq!(stats.reviewed, 1);
        assert_eq!(stats.due_today, 0);
        assert_eq!(stats.streak, 1);

        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
