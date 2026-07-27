use crate::{db, secure_config};
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    AeadCore, Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

const BACKUP_KEY: &[u8; 32] = b"LONG-TRANS-PRIVATE-KEY-2024-MARC";
const BACKUP_V3_MAGIC: &[u8; 4] = b"TLB3";

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))
}

fn local_path(path: FilePath) -> Result<PathBuf, String> {
    match path {
        FilePath::Path(path) => Ok(path),
        FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "The selected backup path is not a local file".to_string()),
    }
}

fn derive_legacy_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(salt);
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    key
}

fn derive_backup_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| format!("Key derivation failed: {error}"))?;
    Ok(key)
}

fn encrypt_backup_payload(payload: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let salt = uuid::Uuid::new_v4();
    let key = derive_backup_key(password, salt.as_bytes())?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("Cannot initialize backup encryption: {error}"))?;
    let mut rng = OsRng;
    let nonce = Aes256Gcm::generate_nonce(&mut rng);
    let mut ciphertext = cipher
        .encrypt(&nonce, payload)
        .map_err(|error| format!("Cannot encrypt backup: {error}"))?;

    let mut output = Vec::with_capacity(4 + 16 + 12 + ciphertext.len());
    output.extend_from_slice(BACKUP_V3_MAGIC);
    output.extend_from_slice(salt.as_bytes());
    output.extend_from_slice(&nonce);
    output.append(&mut ciphertext);
    Ok(output)
}

fn decrypt_backup_payload(file_data: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if file_data.starts_with(BACKUP_V3_MAGIC) {
        if file_data.len() < 48 {
            return Err("Invalid v3 backup file".to_string());
        }
        let salt = &file_data[4..20];
        let nonce = Nonce::from_slice(&file_data[20..32]);
        let key = derive_backup_key(password, salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|error| format!("Cannot initialize backup decryption: {error}"))?;
        return cipher
            .decrypt(nonce, &file_data[32..])
            .map_err(|_| "Decryption failed: invalid password or damaged backup".to_string());
    }

    // v2 backups used salt(16) + nonce(12) + AES-GCM with a single SHA-256 KDF.
    let v2_plaintext = if file_data.len() >= 28 {
        let salt = &file_data[..16];
        let nonce = Nonce::from_slice(&file_data[16..28]);
        let key = derive_legacy_key(password, salt);
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|error| format!("Cannot initialize legacy backup decryption: {error}"))?;
        cipher.decrypt(nonce, &file_data[28..]).ok()
    } else {
        None
    };
    if let Some(plaintext) = v2_plaintext {
        return Ok(plaintext);
    }

    // v0/v1 compatibility: historical backups used a bundled application key.
    let cipher = Aes256Gcm::new_from_slice(BACKUP_KEY)
        .map_err(|error| format!("Cannot initialize legacy backup decryption: {error}"))?;
    let plaintext = if file_data.len() >= 12 {
        let nonce = Nonce::from_slice(&file_data[..12]);
        cipher.decrypt(nonce, &file_data[12..]).ok()
    } else {
        None
    }
    .or_else(|| {
        let nonce = Nonce::from_slice(b"UNIQUE-NONCE");
        cipher.decrypt(nonce, file_data).ok()
    });
    plaintext.ok_or_else(|| "Decryption failed: invalid password or file format".to_string())
}

fn validate_backup_document(document: &Value) -> Result<(), String> {
    let root = document
        .as_object()
        .ok_or_else(|| "Invalid backup: root must be an object".to_string())?;
    let config = root
        .get("config")
        .and_then(Value::as_object)
        .ok_or_else(|| "Invalid backup: config must be an object".to_string())?;
    if config.values().any(|value| !value.is_string()) {
        return Err("Invalid backup: configuration values must be strings".to_string());
    }

    let words = root
        .get("wordbook")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid backup: wordbook must be an array".to_string())?;
    for word in words {
        let text = word.get("word").and_then(Value::as_str).unwrap_or_default();
        if text.trim().is_empty() {
            return Err("Invalid backup: every wordbook entry needs a word".to_string());
        }
    }

    if root
        .get("word_contexts")
        .is_some_and(|contexts| !contexts.is_array())
    {
        return Err("Invalid backup: word_contexts must be an array".to_string());
    }
    Ok(())
}

fn collect_backup(conn: &Connection, app_dir: &Path) -> Result<Value, String> {
    let mut config_data = HashMap::new();
    let mut statement = conn
        .prepare("SELECT key, value FROM config")
        .map_err(|error| format!("Cannot prepare backup settings query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Cannot query backup settings: {error}"))?;
    for row in rows {
        let (key, mut value) =
            row.map_err(|error| format!("Cannot read backup setting: {error}"))?;
        if secure_config::is_sensitive_key(&key) && !value.is_empty() {
            value = secure_config::reveal_value(&value, app_dir)
                .map_err(|_| format!("Cannot export protected setting '{key}' on this device"))?;
        }
        config_data.insert(key, value);
    }

    let mut wordbook_data = Vec::new();
    let mut statement = conn
        .prepare(
            "SELECT uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, \
             ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, \
             difficulty FROM wordbook",
        )
        .map_err(|error| format!("Cannot prepare wordbook backup query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "uuid": row.get::<_, String>(0)?,
                "word": row.get::<_, String>(1)?,
                "phonetic": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "meaning": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "analysis": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "is_deleted": row.get::<_, i64>(5)?,
                "updated_at": row.get::<_, String>(6)?,
                "ease_factor": row.get::<_, f64>(7)?,
                "interval_days": row.get::<_, i32>(8)?,
                "repetitions": row.get::<_, i32>(9)?,
                "next_review": row.get::<_, Option<String>>(10)?,
                "last_reviewed": row.get::<_, Option<String>>(11)?,
                "stability": row.get::<_, f64>(12)?,
                "difficulty": row.get::<_, f64>(13)?,
            }))
        })
        .map_err(|error| format!("Cannot query wordbook backup: {error}"))?;
    for row in rows {
        wordbook_data
            .push(row.map_err(|error| format!("Cannot read wordbook backup entry: {error}"))?);
    }

    let mut word_contexts = Vec::new();
    let mut statement = conn
        .prepare(
            "SELECT word_uuid, source_text, translated_text, source_type, created_at \
             FROM word_contexts ORDER BY created_at",
        )
        .map_err(|error| format!("Cannot prepare context backup query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "word_uuid": row.get::<_, String>(0)?,
                "source_text": row.get::<_, String>(1)?,
                "translated_text": row.get::<_, String>(2)?,
                "source_type": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|error| format!("Cannot query context backup: {error}"))?;
    for row in rows {
        word_contexts
            .push(row.map_err(|error| format!("Cannot read context backup entry: {error}"))?);
    }

    Ok(serde_json::json!({
        "config": config_data,
        "wordbook": wordbook_data,
        "word_contexts": word_contexts,
        "export_version": "3.1",
        "export_time": chrono::Local::now().to_rfc3339()
    }))
}

fn restore_backup(conn: &mut Connection, document: &Value) -> Result<(), String> {
    validate_backup_document(document)?;
    let configs = document["config"]
        .as_object()
        .ok_or_else(|| "Invalid backup: config must be an object".to_string())?;
    let words = document["wordbook"]
        .as_array()
        .ok_or_else(|| "Invalid backup: wordbook must be an array".to_string())?;
    let is_portable_v3 = document["export_version"]
        .as_str()
        .is_some_and(|version| version.starts_with("3."));
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Cannot start backup import transaction: {error}"))?;

    transaction
        .execute("DELETE FROM config", [])
        .map_err(|error| format!("Cannot replace settings during import: {error}"))?;
    transaction
        .execute("DELETE FROM word_contexts", [])
        .map_err(|error| format!("Cannot replace contexts during import: {error}"))?;
    transaction
        .execute("DELETE FROM wordbook", [])
        .map_err(|error| format!("Cannot replace wordbook during import: {error}"))?;

    for (key, raw_value) in configs {
        let mut value = raw_value
            .as_str()
            .ok_or_else(|| "Invalid backup: configuration values must be strings".to_string())?
            .to_string();
        if is_portable_v3 && secure_config::is_sensitive_key(key) && !value.is_empty() {
            value = secure_config::protect_value(&value)?;
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                [key, &value],
            )
            .map_err(|error| format!("Cannot import setting '{key}': {error}"))?;
    }

    for item in words {
        let uuid = item["uuid"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        transaction
            .execute(
                "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, is_deleted, \
                 updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, \
                 stability, difficulty) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, \
                 ?12, ?13, ?14)",
                (
                    uuid,
                    item["word"].as_str().unwrap_or_default(),
                    item["phonetic"].as_str().unwrap_or_default(),
                    item["meaning"].as_str().unwrap_or_default(),
                    item["analysis"].as_str().unwrap_or_default(),
                    item["is_deleted"].as_i64().unwrap_or(0),
                    item["updated_at"].as_str().unwrap_or_default(),
                    item["ease_factor"].as_f64().unwrap_or(2.5),
                    item["interval_days"].as_i64().unwrap_or(0),
                    item["repetitions"].as_i64().unwrap_or(0),
                    item["next_review"].as_str().unwrap_or(""),
                    item["last_reviewed"].as_str().unwrap_or(""),
                    item["stability"].as_f64().unwrap_or(0.0),
                    item["difficulty"].as_f64().unwrap_or(0.0),
                ),
            )
            .map_err(|error| format!("Cannot import wordbook entry: {error}"))?;
    }

    if let Some(contexts) = document["word_contexts"].as_array() {
        for item in contexts {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO word_contexts (word_uuid, source_text, translated_text, \
                     source_type, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    (
                        item["word_uuid"].as_str().unwrap_or_default(),
                        item["source_text"].as_str().unwrap_or_default(),
                        item["translated_text"].as_str().unwrap_or_default(),
                        item["source_type"].as_str().unwrap_or("manual"),
                        item["created_at"].as_str().unwrap_or_default(),
                    ),
                )
                .map_err(|error| format!("Cannot import word context: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit backup import: {error}"))?;

    Ok(())
}

#[tauri::command]
pub async fn export_data(app: AppHandle, password: String) -> Result<String, String> {
    if password.is_empty() {
        return Err("Password cannot be empty".to_string());
    }
    let app_dir = app_data_dir(&app)?;
    let conn = db::init_db(app_dir.clone()).map_err(|error| error.to_string())?;
    let document = collect_backup(&conn, &app_dir)?;
    let json = serde_json::to_vec(&document)
        .map_err(|error| format!("Cannot serialize backup: {error}"))?;
    let encrypted = encrypt_backup_payload(&json, &password)?;
    let destination = app
        .dialog()
        .file()
        .set_title("Export LongTranslate Backup")
        .add_filter("LongTranslate Backup (*.TLong)", &["TLong"])
        .set_file_name("LongTranslate_Backup.TLong")
        .blocking_save_file()
        .ok_or_else(|| "User cancelled".to_string())?;
    let path = local_path(destination)?;
    fs::write(&path, encrypted).map_err(|error| format!("Cannot write backup file: {error}"))?;
    Ok("Export successful".to_string())
}

#[tauri::command]
pub async fn import_data(app: AppHandle, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("Password cannot be empty".to_string());
    }
    let source = app
        .dialog()
        .file()
        .set_title("Import LongTranslate Backup")
        .add_filter("LongTranslate Backup (*.TLong)", &["TLong"])
        .blocking_pick_file()
        .ok_or_else(|| "User cancelled".to_string())?;
    let file_data = fs::read(local_path(source)?)
        .map_err(|error| format!("Cannot read backup file: {error}"))?;
    let plaintext = decrypt_backup_payload(&file_data, &password)?;
    let document: Value = serde_json::from_slice(&plaintext)
        .map_err(|error| format!("Invalid backup JSON: {error}"))?;
    validate_backup_document(&document)?;

    let app_dir = app_data_dir(&app)?;
    let mut conn = db::init_db(app_dir.clone()).map_err(|error| error.to_string())?;
    restore_backup(&mut conn, &document)?;
    app.emit("wordbook-updated", "import")
        .map_err(|error| format!("Cannot notify wordbook import: {error}"))?;
    app.emit("config-updated", "import")
        .map_err(|error| format!("Cannot notify settings import: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        decrypt_backup_payload, encrypt_backup_payload, restore_backup, validate_backup_document,
        BACKUP_V3_MAGIC,
    };
    use rusqlite::Connection;

    #[test]
    fn v3_backup_round_trip_uses_authenticated_encryption() {
        let plaintext = b"portable encrypted backup";
        let encrypted = encrypt_backup_payload(plaintext, "correct horse battery staple").unwrap();

        assert!(encrypted.starts_with(BACKUP_V3_MAGIC));
        assert_ne!(&encrypted[32..], plaintext);
        assert_eq!(
            decrypt_backup_payload(&encrypted, "correct horse battery staple").unwrap(),
            plaintext
        );
    }

    #[test]
    fn v3_backup_rejects_wrong_password_and_truncated_files() {
        let encrypted = encrypt_backup_payload(b"payload", "right-password").unwrap();

        assert!(decrypt_backup_payload(&encrypted, "wrong-password").is_err());
        assert!(decrypt_backup_payload(BACKUP_V3_MAGIC, "right-password").is_err());
    }

    #[test]
    fn invalid_backup_shape_is_rejected_before_restore() {
        assert!(validate_backup_document(&serde_json::json!({})).is_err());
        assert!(validate_backup_document(&serde_json::json!({
            "config": {"api_key": 123},
            "wordbook": []
        }))
        .is_err());
        assert!(validate_backup_document(&serde_json::json!({
            "config": {},
            "wordbook": [{"uuid": "word-1", "word": ""}]
        }))
        .is_err());
        assert!(validate_backup_document(&serde_json::json!({
            "config": {},
            "wordbook": [{"uuid": "word-1", "word": "hello"}],
            "word_contexts": []
        }))
        .is_ok());
    }

    #[test]
    fn invalid_backup_cannot_replace_existing_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO config (key, value) VALUES ('theme', 'dark');",
        )
        .unwrap();

        assert!(restore_backup(&mut conn, &serde_json::json!({})).is_err());
        let theme: String = conn
            .query_row("SELECT value FROM config WHERE key = 'theme'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(theme, "dark");
    }
}
