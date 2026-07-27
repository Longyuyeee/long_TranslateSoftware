use crate::db;
use rusqlite::{params, Connection};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;

const COLLECTION_FILE: &str = "collection.anki2";
const MEDIA_FILE: &str = "media";
const FIELD_SEPARATOR: char = '\x1f';

#[derive(Debug, Clone)]
struct AnkiWord {
    word: String,
    phonetic: String,
    meaning: String,
    analysis_json: String,
}

struct TemporaryExportDir {
    path: PathBuf,
}

impl TemporaryExportDir {
    fn create() -> Result<Self, String> {
        let path =
            std::env::temp_dir().join(format!("long_anki_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&path)
            .map_err(|error| format!("Cannot create temporary Anki directory: {error}"))?;
        Ok(Self { path })
    }
}

impl Drop for TemporaryExportDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn load_words(conn: &Connection) -> Result<Vec<AnkiWord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT word, phonetic, meaning, analysis_json \
             FROM wordbook WHERE is_deleted = 0 ORDER BY word",
        )
        .map_err(|error| format!("Cannot prepare Anki word query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(AnkiWord {
                word: row.get(0)?,
                phonetic: row.get(1)?,
                meaning: row.get(2)?,
                analysis_json: row.get(3)?,
            })
        })
        .map_err(|error| format!("Cannot query words for Anki export: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read word for Anki export: {error}"))
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace(FIELD_SEPARATOR, " ")
}

fn analysis_fields(analysis_json: &str) -> (String, String, String, String) {
    let Ok(analysis) = serde_json::from_str::<serde_json::Value>(analysis_json) else {
        return Default::default();
    };
    let mnemonic = escape_html(analysis["mnemonic"].as_str().unwrap_or_default());
    let etymology = escape_html(analysis["etymology"].as_str().unwrap_or_default());
    let examples = analysis["examples"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|example| {
                    let english = escape_html(example["en"].as_str().unwrap_or_default());
                    let chinese = escape_html(example["zh"].as_str().unwrap_or_default());
                    if chinese.is_empty() {
                        english
                    } else {
                        format!("{english} ({chinese})")
                    }
                })
                .collect::<Vec<_>>()
                .join("<br>")
        })
        .unwrap_or_default();
    let synonyms = analysis["synonyms"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(escape_html)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    (mnemonic, etymology, examples, synonyms)
}

fn note_fields(word: &AnkiWord) -> String {
    let (mnemonic, etymology, examples, synonyms) = analysis_fields(&word.analysis_json);
    [
        escape_html(&word.word),
        escape_html(&word.phonetic),
        escape_html(&word.meaning),
        mnemonic,
        etymology,
        examples,
        synonyms,
    ]
    .join("\x1f")
}

fn build_collection(
    path: &Path,
    words: &[AnkiWord],
    timestamp_ms: i64,
    timestamp_sec: i64,
) -> Result<(), String> {
    if words.is_empty() {
        return Err("No words to export.".to_string());
    }
    let deck_id = timestamp_ms;
    let model_id = timestamp_ms;
    let models = serde_json::json!({
        model_id.to_string(): {
            "id": model_id,
            "name": "Long Translate Vocabulary",
            "type": 0,
            "mod": timestamp_sec,
            "usn": 0,
            "sortf": 0,
            "did": null,
            "tmpls": [{
                "name": "Card 1",
                "ord": 0,
                "qfmt": "<div style='font-size:24px;margin-bottom:8px'>{{Word}}</div>{{#Phonetic}}<div style='color:#888;font-size:16px'>{{Phonetic}}</div>{{/Phonetic}}",
                "afmt": "<div style='font-size:20px;color:#1a73e8;margin-bottom:12px'><b>{{Meaning}}</b></div>{{#Mnemonic}}<hr><div style='background:#fff8e1;padding:12px;border-radius:8px;margin:8px 0'><b>Memory Hook</b><br>{{Mnemonic}}</div>{{/Mnemonic}}{{#Etymology}}<hr><div style='color:#666;font-style:italic;font-size:14px'>Etymology: {{Etymology}}</div>{{/Etymology}}{{#Examples}}<hr><div style='font-size:14px'>Examples: {{Examples}}</div>{{/Examples}}{{#Synonyms}}<hr><div style='font-size:14px'>Synonyms: {{Synonyms}}</div>{{/Synonyms}}",
                "bqfmt": "",
                "bafmt": "",
                "did": null,
                "bfont": "",
                "bsize": 0
            }],
            "flds": [
                {"name": "Word", "ord": 0, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Phonetic", "ord": 1, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Meaning", "ord": 2, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Mnemonic", "ord": 3, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Etymology", "ord": 4, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Examples", "ord": 5, "sticky": false, "rtl": false, "font": "Arial", "size": 20},
                {"name": "Synonyms", "ord": 6, "sticky": false, "rtl": false, "font": "Arial", "size": 20}
            ],
            "css": ".card{font-family:Arial,sans-serif;font-size:20px;text-align:center;color:#333;background:#fff;padding:16px}hr{border:none;border-top:1px solid #e0e0e0;margin:12px 0}",
            "latexPre": "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\begin{document}\n",
            "latexPost": "\\end{document}",
            "latexsvg": false,
            "req": [[0, "any", [0, 1, 2]]]
        }
    });
    let decks = serde_json::json!({
        deck_id.to_string(): {
            "id": deck_id,
            "name": "Long Translate Import",
            "mod": timestamp_sec,
            "usn": 0,
            "desc": "Imported from Long Translate",
            "collapsed": false,
            "browserCollapsed": false,
            "newToday": [0, 0],
            "revToday": [0, 0],
            "lrnToday": [0, 0],
            "conf": 1,
            "extendNew": 10,
            "extendRev": 50
        }
    });
    let deck_settings = serde_json::json!({
        "1": {
            "id": 1, "name": "Default", "mod": timestamp_sec, "usn": 0,
            "new": {"delays": [1.0, 10.0], "ints": [1, 4, 7], "initialFactor": 2500, "separate": true, "order": 1, "perDay": 20, "bury": true},
            "lapse": {"delays": [10.0], "mult": 0.0, "minInt": 1, "leechFails": 8, "leechAction": 0},
            "rev": {"perDay": 200, "ease4": 1.3, "fuzz": 0.05, "minSpace": 1, "ivlFct": 1.0, "maxIvl": 36500, "bury": true, "hardFactor": 1.2},
            "maxTaken": 60, "timer": 0, "autoplay": true, "replayq": true, "mod": 0, "usn": 0
        }
    });
    let collection_settings = serde_json::json!({
        "activeDecks": [deck_id],
        "curDeck": deck_id,
        "newSpread": 0,
        "collapseTime": 1200,
        "timeLim": 0,
        "estTimes": true,
        "dueCounts": true,
        "curModel": model_id,
        "nextPos": words.len() + 1,
        "sortType": "noteFld",
        "sortBackwards": false,
        "addToCur": true,
        "dayLearnFirst": false
    });
    let collection_settings = serde_json::to_string(&collection_settings)
        .map_err(|error| format!("Cannot serialize Anki collection settings: {error}"))?;
    let models = serde_json::to_string(&models)
        .map_err(|error| format!("Cannot serialize Anki note model: {error}"))?;
    let decks = serde_json::to_string(&decks)
        .map_err(|error| format!("Cannot serialize Anki deck: {error}"))?;
    let deck_settings = serde_json::to_string(&deck_settings)
        .map_err(|error| format!("Cannot serialize Anki deck settings: {error}"))?;

    let conn = Connection::open(path)
        .map_err(|error| format!("Cannot create temporary Anki database: {error}"))?;
    conn.execute_batch(
        "CREATE TABLE col (
            id INTEGER PRIMARY KEY, crt INTEGER NOT NULL, mod INTEGER NOT NULL,
            scm INTEGER NOT NULL, ver INTEGER NOT NULL, dty INTEGER NOT NULL,
            usn INTEGER NOT NULL, ls INTEGER NOT NULL, conf TEXT NOT NULL,
            models TEXT NOT NULL, decks TEXT NOT NULL, dconf TEXT NOT NULL, tags TEXT NOT NULL
        );
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY, guid TEXT NOT NULL, mid INTEGER NOT NULL,
            mod INTEGER NOT NULL, usn INTEGER NOT NULL, tags TEXT NOT NULL,
            flds TEXT NOT NULL, sfld TEXT NOT NULL, csum INTEGER NOT NULL,
            flags INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE TABLE cards (
            id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL,
            ord INTEGER NOT NULL, mod INTEGER NOT NULL, usn INTEGER NOT NULL,
            type INTEGER NOT NULL, queue INTEGER NOT NULL, due INTEGER NOT NULL,
            ivl INTEGER NOT NULL, factor INTEGER NOT NULL, reps INTEGER NOT NULL,
            lapses INTEGER NOT NULL, left INTEGER NOT NULL, odue INTEGER NOT NULL,
            odid INTEGER NOT NULL, flags INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX idx_notes_usn ON notes (usn);
        CREATE INDEX idx_cards_nid ON cards (nid);
        CREATE INDEX idx_cards_sched ON cards (did, queue, due);
        CREATE INDEX idx_cards_usn ON cards (usn);",
    )
    .map_err(|error| format!("Cannot initialize Anki database: {error}"))?;
    conn.execute(
        "INSERT INTO col VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            1_i64,
            timestamp_ms,
            timestamp_ms,
            timestamp_sec,
            21_i64,
            0_i64,
            -1_i64,
            0_i64,
            collection_settings,
            models,
            decks,
            deck_settings,
            "{}"
        ],
    )
    .map_err(|error| format!("Cannot write Anki collection metadata: {error}"))?;

    for (index, word) in words.iter().enumerate() {
        let note_id = timestamp_ms.saturating_add(index as i64);
        let fields = note_fields(word);
        conn.execute(
            "INSERT INTO notes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                note_id,
                uuid::Uuid::new_v4().simple().to_string(),
                model_id,
                timestamp_sec,
                -1_i64,
                "",
                fields,
                escape_html(&word.word),
                0_i64,
                0_i64,
                ""
            ],
        )
        .map_err(|error| format!("Cannot write Anki note '{}': {error}", word.word))?;
        conn.execute(
            "INSERT INTO cards VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![
                note_id, note_id, deck_id, 0_i64, timestamp_sec, -1_i64,
                0_i64, 0_i64, index as i64 + 1, 0_i64, 0_i64, 0_i64, 0_i64,
                0_i64, 0_i64, 0_i64, 0_i64, ""
            ],
        )
        .map_err(|error| format!("Cannot write Anki card '{}': {error}", word.word))?;
    }
    conn.close()
        .map_err(|(_, error)| format!("Cannot finalize Anki database: {error}"))
}

fn write_apkg(destination: &Path, collection: &Path, media: &Path) -> Result<(), String> {
    let file = fs::File::create(destination)
        .map_err(|error| format!("Cannot create Anki package: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (entry_name, source) in [(COLLECTION_FILE, collection), (MEDIA_FILE, media)] {
        archive
            .start_file(entry_name, options)
            .map_err(|error| format!("Cannot add '{entry_name}' to Anki package: {error}"))?;
        let data = fs::read(source)
            .map_err(|error| format!("Cannot read temporary Anki file '{entry_name}': {error}"))?;
        archive
            .write_all(&data)
            .map_err(|error| format!("Cannot write '{entry_name}' to Anki package: {error}"))?;
    }
    archive
        .finish()
        .map_err(|error| format!("Cannot finalize Anki package: {error}"))?;
    Ok(())
}

fn create_apkg(
    destination: &Path,
    words: &[AnkiWord],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    let temporary = TemporaryExportDir::create()?;
    let collection_path = temporary.path.join(COLLECTION_FILE);
    let media_path = temporary.path.join(MEDIA_FILE);
    build_collection(
        &collection_path,
        words,
        now.timestamp_millis(),
        now.timestamp(),
    )?;
    fs::write(&media_path, "{}")
        .map_err(|error| format!("Cannot create Anki media manifest: {error}"))?;
    write_apkg(destination, &collection_path, &media_path)
}

#[tauri::command]
pub fn export_anki(app: AppHandle) -> Result<String, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))?;
    let conn = db::init_db(app_dir).map_err(|error| error.to_string())?;
    let words = load_words(&conn)?;
    if words.is_empty() {
        return Err("No words to export.".to_string());
    }

    let now = chrono::Utc::now();
    let desktop = app
        .path()
        .desktop_dir()
        .map_err(|error| format!("Cannot resolve desktop directory: {error}"))?;
    let destination = desktop.join(format!(
        "LongTranslate_Anki_{}.apkg",
        now.format("%Y%m%d_%H%M%S")
    ));
    create_apkg(&destination, &words, now)?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{analysis_fields, build_collection, create_apkg, note_fields, AnkiWord};
    use chrono::TimeZone;
    use rusqlite::Connection;
    use std::fs;
    use std::io::Read;

    fn sample_word() -> AnkiWord {
        AnkiWord {
            word: "<hello>".to_string(),
            phonetic: "/həˈləʊ/".to_string(),
            meaning: "greeting\u{1f}value".to_string(),
            analysis_json: serde_json::json!({
                "mnemonic": "<script>alert(1)</script>",
                "etymology": "origin & history",
                "examples": [{"en": "Hello <world>", "zh": "你好"}],
                "synonyms": ["hi", "greetings"]
            })
            .to_string(),
        }
    }

    #[test]
    fn fields_are_seven_part_html_safe_values() {
        let word = sample_word();
        let fields = note_fields(&word);
        let parts = fields.split('\x1f').collect::<Vec<_>>();

        assert_eq!(parts.len(), 7);
        assert_eq!(parts[0], "&lt;hello&gt;");
        assert_eq!(parts[2], "greeting value");
        assert!(parts[3].contains("&lt;script&gt;"));
        assert!(!parts[3].contains("<script>"));
        let (_, etymology, examples, synonyms) = analysis_fields(&word.analysis_json);
        assert_eq!(etymology, "origin &amp; history");
        assert_eq!(examples, "Hello &lt;world&gt; (你好)");
        assert_eq!(synonyms, "hi, greetings");
    }

    #[test]
    fn collection_uses_dynamic_deck_and_contains_matching_notes_and_cards() {
        let directory =
            std::env::temp_dir().join(format!("long-anki-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("collection.anki2");
        build_collection(&path, &[sample_word()], 1_700_000_000_000, 1_700_000_000).unwrap();
        let conn = Connection::open(&path).unwrap();

        let note_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        let card_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        let (settings, decks): (String, String) = conn
            .query_row("SELECT conf, decks FROM col", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(note_count, 1);
        assert_eq!(card_count, 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&settings).unwrap()["curDeck"],
            1_700_000_000_000_i64
        );
        assert!(decks.contains("Long Translate Import"));

        drop(conn);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn apkg_contains_collection_and_media_entries() {
        let directory =
            std::env::temp_dir().join(format!("long-anki-package-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let package = directory.join("export.apkg");
        let now = chrono::Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .unwrap();
        create_apkg(&package, &[sample_word()], now).unwrap();

        let file = fs::File::open(&package).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.by_name("collection.anki2").is_ok());
        let mut media = String::new();
        archive
            .by_name("media")
            .unwrap()
            .read_to_string(&mut media)
            .unwrap();
        assert_eq!(media, "{}");

        drop(archive);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn empty_collection_is_rejected_without_creating_a_database() {
        let path = std::env::temp_dir().join(format!("long-anki-empty-{}", uuid::Uuid::new_v4()));
        assert!(build_collection(&path, &[], 1, 1).is_err());
        assert!(!path.exists());
    }
}
