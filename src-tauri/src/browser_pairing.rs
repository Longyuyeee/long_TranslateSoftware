use crate::desktop_ipc::{
    BrowserAddWordRequest, BrowserCancelRequest, BrowserPairingRequest, BrowserTranslationOutcome,
    BrowserTranslationRequest, BrowserWordAddedOutcome, DesktopIpcHandler,
};
use crate::native_protocol::{validate_origin, ErrorCode, PairingState, ProtocolError};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const PAIRINGS_FILE: &str = "browser-pairings.json";
const MAX_PAIRINGS_FILE_BYTES: usize = 64 * 1024;
const MAX_TRANSLATIONS_PER_ORIGIN: usize = 4;
const TRANSLATION_TIMEOUT: Duration = Duration::from_secs(65);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPairingRecord {
    pub pairing_id: String,
    pub origin: String,
    pub display_name: String,
    pub capabilities: Vec<String>,
    pub approved_at: String,
    pub last_used_at: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserPairingFile {
    pairings: Vec<BrowserPairingRecord>,
}

struct PendingPairing {
    request: BrowserPairingRequest,
    last_notified: Instant,
}

struct PendingTranslation {
    origin: String,
    request_id: String,
    sender: mpsc::Sender<BrowserTranslationOutcome>,
}

#[derive(Clone, Debug, Serialize)]
struct BrowserTranslationEvent {
    task_id: String,
    request: BrowserTranslationRequest,
}

pub struct BrowserPairingManager {
    app: AppHandle,
    path: PathBuf,
    pending: Mutex<HashMap<String, PendingPairing>>,
    records: Mutex<Vec<BrowserPairingRecord>>,
    translations: Mutex<HashMap<String, PendingTranslation>>,
    translation_bridges: Mutex<HashSet<String>>,
}

impl BrowserPairingManager {
    pub fn load(app: AppHandle, app_data_dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join(PAIRINGS_FILE);
        let records = match load_records(&path) {
            Ok(records) => records,
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                let backup = path.with_extension("json.bak");
                let recovered = if backup.exists() {
                    load_records(&backup).ok()
                } else {
                    None
                };
                let invalid = path.with_extension(format!("invalid-{}.json", Uuid::new_v4()));
                if path.exists() {
                    fs::rename(&path, &invalid)?;
                }
                if let Some(records) = recovered {
                    fs::rename(backup, &path)?;
                    log::warn!("Recovered browser pairings from the last complete backup");
                    records
                } else {
                    log::warn!("Quarantined an invalid browser pairing file");
                    Vec::new()
                }
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            app,
            path,
            pending: Mutex::new(HashMap::new()),
            records: Mutex::new(records),
            translations: Mutex::new(HashMap::new()),
            translation_bridges: Mutex::new(HashSet::new()),
        })
    }

    fn pairing_state(&self, origin: &str, capabilities: &[String]) -> io::Result<PairingState> {
        validate_origin(origin, &[origin.to_string()])
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid extension origin"))?;
        let mut records = self
            .records
            .lock()
            .map_err(|_| io::Error::other("Browser pairing records are unavailable"))?;
        let Some(index) = records.iter().position(|record| {
            record.origin == origin
                && capabilities
                    .iter()
                    .all(|capability| record.capabilities.contains(capability))
        }) else {
            return Ok(PairingState::Required);
        };
        let mut next_records = records.clone();
        next_records[index].last_used_at = Utc::now().to_rfc3339();
        write_records(&self.path, &next_records)?;
        *records = next_records;
        Ok(PairingState::Approved)
    }

    fn approve(&self, request: &BrowserPairingRequest) -> Result<BrowserPairingRecord, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Browser pairing request is unavailable".to_string())?;
        let pending_request = pending
            .get(&request.origin)
            .map(|entry| &entry.request)
            .ok_or_else(|| "Browser pairing request is no longer pending".to_string())?;
        if pending_request != request {
            return Err("Browser pairing request changed; review it again".to_string());
        }
        let now = Utc::now().to_rfc3339();
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Browser pairing records are unavailable".to_string())?;
        let mut next_records = records.clone();
        next_records.retain(|record| record.origin != request.origin);
        let record = BrowserPairingRecord {
            pairing_id: Uuid::new_v4().to_string(),
            origin: request.origin.clone(),
            display_name: request.display_name.clone(),
            capabilities: request.capabilities.clone(),
            approved_at: now.clone(),
            last_used_at: now,
        };
        next_records.push(record.clone());
        write_records(&self.path, &next_records)
            .map_err(|_| "Browser pairing approval could not be saved".to_string())?;
        *records = next_records;
        pending.remove(&request.origin);
        Ok(record)
    }

    fn reject(&self, request: &BrowserPairingRequest) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Browser pairing request is unavailable".to_string())?;
        let pending_request = pending
            .get(&request.origin)
            .map(|entry| &entry.request)
            .ok_or_else(|| "Browser pairing request is no longer pending".to_string())?;
        if pending_request != request {
            return Err("Browser pairing request changed; review it again".to_string());
        }
        pending.remove(&request.origin);
        Ok(())
    }

    fn revoke(&self, pairing_id: &str) -> Result<(), String> {
        Uuid::parse_str(pairing_id).map_err(|_| "Invalid browser pairing ID".to_string())?;
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Browser pairing records are unavailable".to_string())?;
        let mut next_records = records.clone();
        let revoked_origin = next_records
            .iter()
            .find(|record| record.pairing_id == pairing_id)
            .map(|record| record.origin.clone());
        let original_len = next_records.len();
        next_records.retain(|record| record.pairing_id != pairing_id);
        if next_records.len() == original_len {
            return Err("Browser pairing was not found".to_string());
        }
        write_records(&self.path, &next_records)
            .map_err(|_| "Browser pairing revocation could not be saved".to_string())?;
        *records = next_records;
        if let Some(origin) = revoked_origin {
            self.cancel_origin(&origin);
        }
        Ok(())
    }

    fn list(&self) -> Result<Vec<BrowserPairingRecord>, String> {
        self.records
            .lock()
            .map(|records| records.clone())
            .map_err(|_| "Browser pairing records are unavailable".to_string())
    }

    fn cancel_origin(&self, origin: &str) {
        let task_ids = self
            .translations
            .lock()
            .map(|translations| {
                translations
                    .iter()
                    .filter(|(_, task)| task.origin == origin)
                    .map(|(task_id, _)| task_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for task_id in task_ids {
            let _ = self.app.emit("browser-translation-cancelled", task_id);
        }
    }
}

impl DesktopIpcHandler for BrowserPairingManager {
    fn pairing_state(&self, origin: &str, capabilities: &[String]) -> io::Result<PairingState> {
        self.pairing_state(origin, capabilities)
    }

    fn request_pairing(&self, request: BrowserPairingRequest) -> io::Result<PairingState> {
        if self.pairing_state(&request.origin, &request.capabilities)? == PairingState::Approved {
            return Ok(PairingState::Approved);
        }
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| io::Error::other("Browser pairing request is unavailable"))?;
        let should_notify = pending.get(&request.origin).is_none_or(|entry| {
            entry.request != request || entry.last_notified.elapsed() >= Duration::from_secs(3)
        });
        if should_notify {
            pending.insert(
                request.origin.clone(),
                PendingPairing {
                    request: request.clone(),
                    last_notified: Instant::now(),
                },
            );
        }
        pending.retain(|_, entry| entry.last_notified.elapsed() < Duration::from_secs(60));
        drop(pending);
        if should_notify {
            crate::tray::show_main_window(&self.app);
            self.app
                .emit("browser-pairing-requested", request)
                .map_err(|_| io::Error::other("Browser pairing notification failed"))?;
        }
        Ok(PairingState::Pending)
    }

    fn translate(&self, request: BrowserTranslationRequest) -> BrowserTranslationOutcome {
        match self.pairing_state(&request.origin, &["translation".to_string()]) {
            Ok(PairingState::Approved) => {}
            Ok(_) => return translation_error(ErrorCode::PairingRequired, false),
            Err(_) => return translation_error(ErrorCode::InternalError, true),
        }
        if self
            .translation_bridges
            .lock()
            .map_or(true, |bridges| bridges.is_empty())
        {
            return translation_error(ErrorCode::DesktopUnavailable, true);
        }

        let task_id = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        let mut translations = match self.translations.lock() {
            Ok(translations) => translations,
            Err(_) => return translation_error(ErrorCode::InternalError, true),
        };
        let origin_count = translations
            .values()
            .filter(|task| task.origin == request.origin)
            .count();
        let duplicate = translations
            .values()
            .any(|task| task.origin == request.origin && task.request_id == request.request_id);
        if duplicate || origin_count >= MAX_TRANSLATIONS_PER_ORIGIN {
            return translation_error(ErrorCode::Busy, true);
        }
        translations.insert(
            task_id.clone(),
            PendingTranslation {
                origin: request.origin.clone(),
                request_id: request.request_id.clone(),
                sender,
            },
        );
        drop(translations);

        if self
            .app
            .emit(
                "browser-translation-requested",
                BrowserTranslationEvent {
                    task_id: task_id.clone(),
                    request,
                },
            )
            .is_err()
        {
            let _ = self
                .translations
                .lock()
                .map(|mut tasks| tasks.remove(&task_id));
            return translation_error(ErrorCode::InternalError, true);
        }

        let outcome = receiver
            .recv_timeout(TRANSLATION_TIMEOUT)
            .unwrap_or_else(|_| translation_error(ErrorCode::Timeout, true));
        let _ = self
            .translations
            .lock()
            .map(|mut tasks| tasks.remove(&task_id));
        outcome
    }

    fn cancel(&self, request: BrowserCancelRequest) -> io::Result<bool> {
        let task_id = self
            .translations
            .lock()
            .map_err(|_| io::Error::other("Browser translations are unavailable"))?
            .iter()
            .find(|(_, task)| {
                task.origin == request.origin && task.request_id == request.target_request_id
            })
            .map(|(task_id, _)| task_id.clone());
        let Some(task_id) = task_id else {
            return Ok(false);
        };
        self.app
            .emit("browser-translation-cancelled", task_id)
            .map_err(|_| io::Error::other("Browser translation cancellation failed"))?;
        Ok(true)
    }

    fn add_word(&self, request: BrowserAddWordRequest) -> BrowserWordAddedOutcome {
        match self.pairing_state(&request.origin, &["wordbook".to_string()]) {
            Ok(PairingState::Approved) => {}
            Ok(_) => return wordbook_error(ErrorCode::PairingRequired, false),
            Err(_) => return wordbook_error(ErrorCode::InternalError, true),
        }
        let context = request.word.context.clone().map(|source| {
            crate::wordbook::WordContextInput::browser(source, request.word.translation.clone())
        });
        match crate::wordbook::add_wordbook_entry(
            &self.app,
            request.word.word,
            None,
            Some(request.word.translation),
            None,
            context,
        ) {
            Ok(word_id) => BrowserWordAddedOutcome::Success { word_id },
            Err(_) => wordbook_error(ErrorCode::InternalError, true),
        }
    }
}

fn translation_error(code: ErrorCode, retryable: bool) -> BrowserTranslationOutcome {
    let message = match code {
        ErrorCode::PairingRequired => "Desktop approval is required",
        ErrorCode::Busy => "Too many browser translation requests are active",
        ErrorCode::Timeout => "Desktop translation timed out",
        ErrorCode::Cancelled => "Desktop translation was cancelled",
        ErrorCode::ProviderError => "Translation provider request failed",
        ErrorCode::DesktopUnavailable => "Desktop translation bridge is not ready",
        _ => "Desktop translation failed",
    };
    BrowserTranslationOutcome::Error {
        error: ProtocolError::new(code, message, retryable),
    }
}

fn wordbook_error(code: ErrorCode, retryable: bool) -> BrowserWordAddedOutcome {
    let message = match code {
        ErrorCode::PairingRequired => "Desktop wordbook approval is required",
        _ => "Desktop wordbook write failed",
    };
    BrowserWordAddedOutcome::Error {
        error: ProtocolError::new(code, message, retryable),
    }
}

#[tauri::command]
pub fn approve_browser_pairing(
    state: State<'_, std::sync::Arc<BrowserPairingManager>>,
    request: BrowserPairingRequest,
) -> Result<BrowserPairingRecord, String> {
    state.approve(&request)
}

#[tauri::command]
pub fn reject_browser_pairing(
    state: State<'_, std::sync::Arc<BrowserPairingManager>>,
    request: BrowserPairingRequest,
) -> Result<(), String> {
    state.reject(&request)
}

#[tauri::command]
pub fn get_browser_pairings(
    state: State<'_, std::sync::Arc<BrowserPairingManager>>,
) -> Result<Vec<BrowserPairingRecord>, String> {
    state.list()
}

#[tauri::command]
pub fn revoke_browser_pairing(
    state: State<'_, std::sync::Arc<BrowserPairingManager>>,
    pairing_id: String,
) -> Result<(), String> {
    state.revoke(&pairing_id)
}

#[tauri::command]
pub fn complete_browser_translation(
    state: State<'_, std::sync::Arc<BrowserPairingManager>>,
    task_id: String,
    outcome: BrowserTranslationOutcome,
) -> Result<(), String> {
    Uuid::parse_str(&task_id).map_err(|_| "Invalid browser translation task ID".to_string())?;
    let task = state
        .translations
        .lock()
        .map_err(|_| "Browser translations are unavailable".to_string())?
        .remove(&task_id)
        .ok_or_else(|| "Browser translation task is no longer pending".to_string())?;
    task.sender
        .send(outcome)
        .map_err(|_| "Browser translation requester is no longer available".to_string())
}

#[tauri::command]
pub fn set_browser_translation_bridge_ready(
    state: State<'_, std::sync::Arc<BrowserPairingManager>>,
    bridge_id: String,
    ready: bool,
) -> Result<(), String> {
    Uuid::parse_str(&bridge_id).map_err(|_| "Invalid browser translation bridge ID".to_string())?;
    let mut bridges = state
        .translation_bridges
        .lock()
        .map_err(|_| "Browser translation bridge state is unavailable".to_string())?;
    if ready {
        bridges.insert(bridge_id);
    } else {
        bridges.remove(&bridge_id);
    }
    let should_cancel = !ready && bridges.is_empty();
    drop(bridges);
    if should_cancel {
        let origins = state
            .translations
            .lock()
            .map(|tasks| {
                tasks
                    .values()
                    .map(|task| task.origin.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for origin in origins {
            state.cancel_origin(&origin);
        }
    }
    Ok(())
}

fn load_records(path: &Path) -> io::Result<Vec<BrowserPairingRecord>> {
    let backup = path.with_extension("json.bak");
    if !path.exists() && backup.exists() {
        fs::rename(&backup, path)?;
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_PAIRINGS_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Browser pairing file exceeds its size limit",
        ));
    }
    let file: BrowserPairingFile = serde_json::from_slice(&bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Browser pairing file is invalid",
        )
    })?;
    for record in &file.pairings {
        validate_record(record)?;
    }
    Ok(file.pairings)
}

fn write_records(path: &Path, records: &[BrowserPairingRecord]) -> io::Result<()> {
    for record in records {
        validate_record(record)?;
    }
    let payload = serde_json::to_vec_pretty(&BrowserPairingFile {
        pairings: records.to_vec(),
    })
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Browser pairings could not be serialized",
        )
    })?;
    if payload.len() > MAX_PAIRINGS_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Browser pairing file exceeds its size limit",
        ));
    }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let backup = path.with_extension("json.bak");
    fs::write(&temporary, payload)?;
    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup)?;
        }
        fs::rename(path, &backup)?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error);
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn validate_record(record: &BrowserPairingRecord) -> io::Result<()> {
    validate_origin(&record.origin, std::slice::from_ref(&record.origin)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid paired extension origin",
        )
    })?;
    if Uuid::parse_str(&record.pairing_id).is_err()
        || record.display_name.trim().is_empty()
        || record.display_name.len() > 80
        || record.capabilities.len() > 32
        || record.capabilities.iter().any(|capability| {
            capability.is_empty()
                || capability.len() > 64
                || !capability.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
                })
        })
        || record.approved_at.len() > 64
        || record.last_used_at.len() > 64
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid browser pairing record",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_records_round_trip_without_secret_or_content_fields() {
        let dir = std::env::temp_dir().join(format!("long-pairing-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PAIRINGS_FILE);
        let record = BrowserPairingRecord {
            pairing_id: Uuid::new_v4().to_string(),
            origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(),
            display_name: "Long Translate extension".to_string(),
            capabilities: vec!["translation".to_string()],
            approved_at: Utc::now().to_rfc3339(),
            last_used_at: Utc::now().to_rfc3339(),
        };
        write_records(&path, std::slice::from_ref(&record)).unwrap();
        assert_eq!(load_records(&path).unwrap(), vec![record]);
        let serialized = fs::read_to_string(&path).unwrap();
        assert!(!serialized.contains("api_key"));
        assert!(!serialized.contains("text"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_or_oversized_pairing_files_fail_closed() {
        let dir = std::env::temp_dir().join(format!("long-pairing-invalid-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PAIRINGS_FILE);
        fs::write(&path, b"not-json").unwrap();
        assert_eq!(
            load_records(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::write(&path, vec![b'x'; MAX_PAIRINGS_FILE_BYTES + 1]).unwrap();
        assert_eq!(
            load_records(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn interrupted_replacement_recovers_the_last_complete_pairing_file() {
        let dir = std::env::temp_dir().join(format!("long-pairing-recovery-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PAIRINGS_FILE);
        let record = BrowserPairingRecord {
            pairing_id: Uuid::new_v4().to_string(),
            origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(),
            display_name: "Long Translate extension".to_string(),
            capabilities: vec!["translation".to_string()],
            approved_at: Utc::now().to_rfc3339(),
            last_used_at: Utc::now().to_rfc3339(),
        };
        write_records(&path, std::slice::from_ref(&record)).unwrap();
        fs::rename(&path, path.with_extension("json.bak")).unwrap();

        assert_eq!(load_records(&path).unwrap(), vec![record]);
        assert!(path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_replacement_cannot_overwrite_existing_approvals() {
        let dir = std::env::temp_dir().join(format!("long-pairing-atomic-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PAIRINGS_FILE);
        let record = BrowserPairingRecord {
            pairing_id: Uuid::new_v4().to_string(),
            origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(),
            display_name: "Long Translate extension".to_string(),
            capabilities: vec!["translation".to_string()],
            approved_at: Utc::now().to_rfc3339(),
            last_used_at: Utc::now().to_rfc3339(),
        };
        write_records(&path, std::slice::from_ref(&record)).unwrap();
        let mut invalid = record.clone();
        invalid.pairing_id = "not-a-uuid".to_string();

        assert_eq!(
            write_records(&path, &[invalid]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(load_records(&path).unwrap(), vec![record]);
        let _ = fs::remove_dir_all(dir);
    }
}
