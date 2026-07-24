use std::path::Path;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::db;

const LEGACY_PREFIX: &str = "ENC:";
const DPAPI_PREFIX: &str = "DPAPI:";
const SENSITIVE_KEYS: &[&str] = &[
    "trans_api_key",
    "openai_api_key",
    "backup_api_key",
    "tts_api_key",
    "webdav_pass",
];

pub fn is_sensitive_key(key: &str) -> bool {
    SENSITIVE_KEYS.contains(&key)
}

fn legacy_device_key(app_dir: &Path) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(app_dir.to_string_lossy().as_bytes());
    hasher.update(b"LONG-TRANS-DEVICE-SALT");
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    key
}

fn decrypt_legacy_value(encrypted: &str, app_dir: &Path) -> Result<String, String> {
    let encoded = encrypted
        .strip_prefix(LEGACY_PREFIX)
        .ok_or("Not a legacy encrypted value")?;
    let data = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    if data.len() < 12 {
        return Err("Invalid legacy encrypted data".to_string());
    }

    let (nonce_bytes, ciphertext) = data.split_at(12);
    let key = legacy_device_key(app_dir);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Legacy sensitive setting decryption failed".to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn protect_for_current_user(value: &str) -> Result<String, String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };

    let bytes = value.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| "Sensitive setting is too large".to_string())?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("Windows DPAPI protection failed: {e}"))?;

        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(format!(
            "{DPAPI_PREFIX}{}",
            general_purpose::STANDARD.encode(protected)
        ))
    }
}

#[cfg(windows)]
fn unprotect_for_current_user(encrypted: &str) -> Result<String, String> {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let encoded = encrypted
        .strip_prefix(DPAPI_PREFIX)
        .ok_or("Not a DPAPI protected value")?;
    let mut protected = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected
            .len()
            .try_into()
            .map_err(|_| "Protected setting is too large".to_string())?,
        pbData: protected.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| {
            "This protected setting belongs to another Windows account or is damaged".to_string()
        })?;

        let plaintext = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        String::from_utf8(plaintext).map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
fn protect_for_current_user(_value: &str) -> Result<String, String> {
    Err("Sensitive settings are currently supported only on Windows".to_string())
}

#[cfg(not(windows))]
fn unprotect_for_current_user(_encrypted: &str) -> Result<String, String> {
    Err("DPAPI protected settings can only be opened on Windows".to_string())
}

pub fn protect_value(value: &str) -> Result<String, String> {
    protect_for_current_user(value)
}

pub fn reveal_value(value: &str, app_dir: &Path) -> Result<String, String> {
    if value.starts_with(DPAPI_PREFIX) {
        unprotect_for_current_user(value)
    } else if value.starts_with(LEGACY_PREFIX) {
        decrypt_legacy_value(value, app_dir)
    } else {
        Ok(value.to_string())
    }
}

pub fn prepare_value(key: &str, value: &str) -> Result<String, String> {
    if is_sensitive_key(key) && !value.is_empty() {
        protect_value(value)
    } else {
        Ok(value.to_string())
    }
}

pub fn load_value(conn: &Connection, key: &str, app_dir: &Path) -> Result<String, String> {
    let stored = db::get_config(conn, key).map_err(|e| e.to_string())?;
    if !is_sensitive_key(key) || stored.is_empty() {
        return Ok(stored);
    }

    let plaintext = reveal_value(&stored, app_dir)?;
    if !stored.starts_with(DPAPI_PREFIX) {
        let migrated = protect_value(&plaintext)?;
        db::set_config(conn, key, &migrated).map_err(|e| e.to_string())?;
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::{
        legacy_device_key, load_value, protect_value, reveal_value, DPAPI_PREFIX, LEGACY_PREFIX,
    };
    use crate::db;
    use aes_gcm::{
        aead::{Aead, AeadCore, KeyInit, OsRng},
        Aes256Gcm,
    };
    use base64::{engine::general_purpose, Engine as _};

    fn legacy_protect(value: &str, app_dir: &std::path::Path) -> String {
        let cipher = Aes256Gcm::new_from_slice(&legacy_device_key(app_dir)).unwrap();
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let mut protected = nonce.to_vec();
        protected.extend_from_slice(&cipher.encrypt(&nonce, value.as_bytes()).unwrap());
        format!(
            "{LEGACY_PREFIX}{}",
            general_purpose::STANDARD.encode(protected)
        )
    }

    #[test]
    #[cfg(windows)]
    fn dpapi_value_round_trip_is_bound_to_current_windows_user() {
        let protected = protect_value("secret-value").unwrap();
        assert!(protected.starts_with(DPAPI_PREFIX));
        assert!(!protected.contains("secret-value"));
        assert_eq!(
            reveal_value(&protected, std::path::Path::new("unused")).unwrap(),
            "secret-value"
        );
    }

    #[test]
    #[cfg(windows)]
    fn plaintext_sensitive_value_is_migrated_when_read() {
        let test_dir =
            std::env::temp_dir().join(format!("long-translate-secure-{}", uuid::Uuid::new_v4()));
        let conn = db::init_db(test_dir.clone()).unwrap();
        db::set_config(&conn, "webdav_pass", "legacy-plaintext").unwrap();

        assert_eq!(
            load_value(&conn, "webdav_pass", &test_dir).unwrap(),
            "legacy-plaintext"
        );
        let stored = db::get_config(&conn, "webdav_pass").unwrap();
        assert!(stored.starts_with(DPAPI_PREFIX));
        assert!(!stored.contains("legacy-plaintext"));

        drop(conn);
        std::fs::remove_dir_all(test_dir).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn legacy_encrypted_value_is_migrated_without_losing_the_secret() {
        let test_dir =
            std::env::temp_dir().join(format!("long-translate-legacy-{}", uuid::Uuid::new_v4()));
        let conn = db::init_db(test_dir.clone()).unwrap();
        let legacy = legacy_protect("existing-password", &test_dir);
        db::set_config(&conn, "webdav_pass", &legacy).unwrap();

        assert_eq!(
            load_value(&conn, "webdav_pass", &test_dir).unwrap(),
            "existing-password"
        );
        let stored = db::get_config(&conn, "webdav_pass").unwrap();
        assert!(stored.starts_with(DPAPI_PREFIX));
        assert_ne!(stored, legacy);

        drop(conn);
        std::fs::remove_dir_all(test_dir).unwrap();
    }
}
