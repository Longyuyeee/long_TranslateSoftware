use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const CHECKPOINT_SCHEMA_VERSION: u8 = 1;
const CHECKPOINT_ROOT: &str = "document-jobs";
const CHECKPOINT_FILE: &str = "checkpoint.json";
const MAX_CHECKPOINT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SEGMENTS: usize = 20_000;
const MAX_SEGMENT_BYTES: usize = 32 * 1024;
const MAX_SOURCE_TEXT_BYTES: usize = 24 * 1024 * 1024;
const MAX_TRANSLATED_TEXT_BYTES: usize = 24 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 4 * 1024;
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_GLOSSARY_ENTRIES: usize = 10_000;
const MAX_GLOSSARY_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const COMPLETED_RETENTION_DAYS: i64 = 30;
const CANCELLED_FAILED_RETENTION_DAYS: i64 = 14;
const TEMPORARY_RETENTION_HOURS: i64 = 24;
const QUARANTINE_RETENTION_DAYS: i64 = 30;
const MAX_RECOVERY_SUMMARIES: usize = 100;
const MAX_CHECKPOINT_SCAN_ENTRIES: usize = 10_000;

static STORAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentCheckpointErrorCode {
    CheckpointInvalid,
    Storage,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCheckpointError {
    pub code: DocumentCheckpointErrorCode,
    pub message: String,
}

impl DocumentCheckpointError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: DocumentCheckpointErrorCode::CheckpointInvalid,
            message: message.into(),
        }
    }

    fn storage(message: impl Into<String>) -> Self {
        Self {
            code: DocumentCheckpointErrorCode::Storage,
            message: message.into(),
        }
    }
}

type CheckpointResult<T> = Result<T, DocumentCheckpointError>;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCheckpointCleanupReport {
    removed_jobs: usize,
    removed_temporary_files: usize,
    removed_quarantined_files: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCheckpointSummary {
    job_id: String,
    file_name: String,
    phase: DocumentJobPhase,
    output_mode: DocumentOutputMode,
    completed_segments: usize,
    failed_segments: usize,
    total_segments: usize,
    updated_at: String,
}

#[derive(Debug)]
struct CheckpointParseError {
    error: DocumentCheckpointError,
    quarantine: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentCheckpoint {
    schema_version: u8,
    job: DocumentJob,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentJob {
    id: String,
    phase: DocumentJobPhase,
    input: DocumentInput,
    output_mode: DocumentOutputMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_path: Option<String>,
    snapshot: DocumentTranslationSnapshot,
    concurrency: u8,
    segments: Vec<DocumentSegment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DocumentError>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DocumentJobPhase {
    Created,
    Inspecting,
    Parsing,
    Ready,
    Translating,
    Rebuilding,
    Exporting,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DocumentOutputMode {
    Translated,
    Bilingual,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentInput {
    source_path: String,
    file_name: String,
    size_bytes: u64,
    format: DocumentFormat,
    fingerprint: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DocumentFormat {
    Docx,
    Pdf,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentTranslationSnapshot {
    source_language: String,
    target_language: String,
    primary: DocumentProviderSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    backup: Option<DocumentProviderSnapshot>,
    custom_prompt: String,
    glossary: Vec<GlossaryEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentProviderSnapshot {
    base_url: String,
    model: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GlossaryEntry {
    source_term: String,
    target_term: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentSegment {
    id: String,
    location: DocumentSegmentLocation,
    structure: DocumentStructureKind,
    source_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    translated_text: Option<String>,
    status: DocumentSegmentStatus,
    attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DocumentError>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentSegmentLocation {
    order: usize,
    part: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_position: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DocumentStructureKind {
    Paragraph,
    Heading,
    ListItem,
    TableCell,
    Header,
    Footer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DocumentSegmentStatus {
    Pending,
    Translating,
    Translated,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentError {
    code: DocumentErrorCode,
    message: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    segment_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DocumentErrorCode {
    UnsupportedFormat,
    InputTooLarge,
    InvalidInput,
    EncryptedPdf,
    TextLayerRequired,
    ParseFailed,
    TranslationFailed,
    RebuildFailed,
    ExportFailed,
    CheckpointInvalid,
}

fn invalid_if(condition: bool, message: &'static str) -> CheckpointResult<()> {
    if condition {
        Err(DocumentCheckpointError::invalid(message))
    } else {
        Ok(())
    }
}

fn bounded_text(value: &str, max_bytes: usize, label: &'static str) -> CheckpointResult<()> {
    invalid_if(value.is_empty() || value.len() > max_bytes, label)
}

fn valid_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_provider(provider: &DocumentProviderSnapshot) -> CheckpointResult<()> {
    bounded_text(&provider.base_url, 2048, "Invalid document provider URL")?;
    bounded_text(&provider.model, 256, "Invalid document provider model")?;
    let url = url::Url::parse(&provider.base_url)
        .map_err(|_| DocumentCheckpointError::invalid("Invalid document provider URL"))?;
    invalid_if(
        !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some(),
        "Document provider URL must not contain credentials, query parameters, or fragments",
    )
}

fn validate_error(error: &DocumentError) -> CheckpointResult<()> {
    bounded_text(
        &error.message,
        MAX_ERROR_BYTES,
        "Document checkpoint error message exceeds its limit",
    )?;
    if let Some(segment_id) = &error.segment_id {
        bounded_text(
            segment_id,
            256,
            "Invalid document checkpoint error segment ID",
        )?;
    }
    Ok(())
}

impl DocumentCheckpoint {
    fn validate(&self) -> CheckpointResult<()> {
        invalid_if(
            self.schema_version != CHECKPOINT_SCHEMA_VERSION,
            "Unsupported document checkpoint version",
        )?;
        invalid_if(!valid_job_id(&self.job.id), "Invalid document job ID")?;
        bounded_text(
            &self.job.input.source_path,
            MAX_PATH_BYTES,
            "Invalid document source path",
        )?;
        bounded_text(
            &self.job.input.file_name,
            1024,
            "Invalid document file name",
        )?;
        bounded_text(
            &self.job.input.fingerprint,
            256,
            "Invalid document fingerprint",
        )?;
        invalid_if(
            self.job.input.size_bytes == 0 || self.job.input.size_bytes > 50 * 1024 * 1024,
            "Invalid document input size",
        )?;
        let extension = Path::new(&self.job.input.file_name)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        invalid_if(
            !matches!(
                (&self.job.input.format, extension.as_str()),
                (DocumentFormat::Docx, "docx") | (DocumentFormat::Pdf, "pdf")
            ),
            "Document format does not match its file name",
        )?;
        if let Some(output_path) = &self.job.output_path {
            bounded_text(output_path, MAX_PATH_BYTES, "Invalid document output path")?;
            invalid_if(
                output_path.eq_ignore_ascii_case(&self.job.input.source_path),
                "Document output must not overwrite its source",
            )?;
        }
        invalid_if(
            !(1..=8).contains(&self.job.concurrency),
            "Invalid document concurrency",
        )?;
        bounded_text(&self.job.created_at, 64, "Invalid document creation time")?;
        bounded_text(&self.job.updated_at, 64, "Invalid document update time")?;
        let created_at = DateTime::parse_from_rfc3339(&self.job.created_at)
            .map_err(|_| DocumentCheckpointError::invalid("Invalid document creation time"))?;
        let updated_at = DateTime::parse_from_rfc3339(&self.job.updated_at)
            .map_err(|_| DocumentCheckpointError::invalid("Invalid document update time"))?;
        invalid_if(
            updated_at < created_at,
            "Document update time precedes its creation",
        )?;
        bounded_text(
            &self.job.snapshot.source_language,
            128,
            "Invalid document source language",
        )?;
        bounded_text(
            &self.job.snapshot.target_language,
            128,
            "Invalid document target language",
        )?;
        invalid_if(
            self.job.snapshot.custom_prompt.len() > MAX_PROMPT_BYTES,
            "Document custom prompt exceeds its limit",
        )?;
        validate_provider(&self.job.snapshot.primary)?;
        if let Some(backup) = &self.job.snapshot.backup {
            validate_provider(backup)?;
        }
        invalid_if(
            self.job.snapshot.glossary.len() > MAX_GLOSSARY_ENTRIES,
            "Document glossary contains too many entries",
        )?;
        let glossary_bytes =
            self.job
                .snapshot
                .glossary
                .iter()
                .try_fold(0usize, |total, entry| {
                    bounded_text(
                        &entry.source_term,
                        MAX_SEGMENT_BYTES,
                        "Invalid glossary source term",
                    )?;
                    bounded_text(
                        &entry.target_term,
                        MAX_SEGMENT_BYTES,
                        "Invalid glossary target term",
                    )?;
                    total
                        .checked_add(entry.source_term.len() + entry.target_term.len())
                        .ok_or_else(|| {
                            DocumentCheckpointError::invalid("Document glossary size is invalid")
                        })
                })?;
        invalid_if(
            glossary_bytes > MAX_GLOSSARY_BYTES,
            "Document glossary exceeds its size limit",
        )?;
        invalid_if(
            self.job.segments.is_empty() || self.job.segments.len() > MAX_SEGMENTS,
            "Invalid document segment count",
        )?;

        let mut ids = HashSet::with_capacity(self.job.segments.len());
        let mut source_bytes = 0usize;
        let mut translated_bytes = 0usize;
        for (expected_order, segment) in self.job.segments.iter().enumerate() {
            bounded_text(&segment.id, 256, "Invalid document segment ID")?;
            invalid_if(
                !ids.insert(segment.id.as_str()),
                "Document segment IDs must be unique",
            )?;
            invalid_if(
                segment.location.order != expected_order,
                "Document segment order must be contiguous",
            )?;
            bounded_text(
                &segment.location.part,
                1024,
                "Invalid document segment part",
            )?;
            if let Some(position) = &segment.location.source_position {
                bounded_text(position, 1024, "Invalid document segment source position")?;
            }
            invalid_if(
                segment.location.page == Some(0),
                "Invalid document segment page",
            )?;
            bounded_text(
                &segment.source_text,
                MAX_SEGMENT_BYTES,
                "Document source segment exceeds the 32 KiB limit",
            )?;
            source_bytes = source_bytes
                .checked_add(segment.source_text.len())
                .ok_or_else(|| {
                    DocumentCheckpointError::invalid("Document source text size is invalid")
                })?;
            if let Some(translated_text) = &segment.translated_text {
                invalid_if(
                    translated_text.len() > MAX_SEGMENT_BYTES,
                    "Document translated segment exceeds the 32 KiB limit",
                )?;
                translated_bytes = translated_bytes
                    .checked_add(translated_text.len())
                    .ok_or_else(|| {
                        DocumentCheckpointError::invalid("Document translated text size is invalid")
                    })?;
            }
            invalid_if(
                segment.status == DocumentSegmentStatus::Translated
                    && segment
                        .translated_text
                        .as_deref()
                        .is_none_or(|text| text.trim().is_empty()),
                "Translated document segment has no result",
            )?;
            if let Some(error) = &segment.error {
                validate_error(error)?;
            }
        }
        invalid_if(
            source_bytes > MAX_SOURCE_TEXT_BYTES,
            "Document source text exceeds the 24 MiB limit",
        )?;
        invalid_if(
            translated_bytes > MAX_TRANSLATED_TEXT_BYTES,
            "Document translated text exceeds the 24 MiB limit",
        )?;
        if let Some(error) = &self.job.error {
            validate_error(error)?;
        }
        invalid_if(
            self.job.phase == DocumentJobPhase::Completed
                && (self.job.output_path.is_none()
                    || self
                        .job
                        .segments
                        .iter()
                        .any(|segment| segment.status != DocumentSegmentStatus::Translated)),
            "Completed document checkpoint is missing output or translations",
        )
    }

    fn recover(mut self) -> Self {
        for segment in &mut self.job.segments {
            if segment.status == DocumentSegmentStatus::Translating {
                segment.status = DocumentSegmentStatus::Pending;
                segment.translated_text = None;
                segment.error = None;
            }
        }
        self.job.phase = match self.job.phase {
            DocumentJobPhase::Inspecting | DocumentJobPhase::Parsing => DocumentJobPhase::Created,
            DocumentJobPhase::Translating | DocumentJobPhase::Cancelling => DocumentJobPhase::Ready,
            DocumentJobPhase::Rebuilding | DocumentJobPhase::Exporting => {
                DocumentJobPhase::Translating
            }
            phase => phase,
        };
        self
    }
}

fn storage_lock() -> CheckpointResult<std::sync::MutexGuard<'static, ()>> {
    STORAGE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| DocumentCheckpointError::storage("Document checkpoint storage is unavailable"))
}

fn job_directory(root: &Path, job_id: &str) -> CheckpointResult<PathBuf> {
    invalid_if(!valid_job_id(job_id), "Invalid document job ID")?;
    Ok(root.join(job_id))
}

fn validate_job_directory(root: &Path, directory: &Path) -> CheckpointResult<PathBuf> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|_| DocumentCheckpointError::storage("Cannot inspect document job directory"))?;
    invalid_if(
        metadata.file_type().is_symlink() || !metadata.is_dir(),
        "Document job directory is unsafe",
    )?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| DocumentCheckpointError::storage("Cannot resolve document checkpoint root"))?;
    let canonical_directory = fs::canonicalize(directory)
        .map_err(|_| DocumentCheckpointError::storage("Cannot resolve document job directory"))?;
    invalid_if(
        canonical_directory.parent() != Some(canonical_root.as_path()),
        "Document job directory escapes checkpoint storage",
    )?;
    Ok(canonical_directory)
}

fn cleanup_temporary_files(directory: &Path) -> CheckpointResult<()> {
    let prefix = format!(".{CHECKPOINT_FILE}.");
    for entry in fs::read_dir(directory)
        .map_err(|_| DocumentCheckpointError::storage("Cannot inspect document job directory"))?
    {
        let entry = entry.map_err(|_| {
            DocumentCheckpointError::storage("Cannot inspect document job directory")
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) && name.ends_with(".tmp") {
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| {
                DocumentCheckpointError::storage("Cannot inspect temporary checkpoint")
            })?;
            if metadata.is_file() || metadata.file_type().is_symlink() {
                fs::remove_file(entry.path()).map_err(|_| {
                    DocumentCheckpointError::storage("Cannot clean temporary checkpoint")
                })?;
            }
        }
    }
    Ok(())
}

fn ensure_job_directory(root: &Path, job_id: &str) -> CheckpointResult<PathBuf> {
    fs::create_dir_all(root)
        .map_err(|_| DocumentCheckpointError::storage("Cannot create document checkpoint root"))?;
    let directory = job_directory(root, job_id)?;
    if !directory.exists() {
        fs::create_dir(&directory).map_err(|_| {
            DocumentCheckpointError::storage("Cannot create document job directory")
        })?;
    }
    validate_job_directory(root, &directory)
}

fn read_bounded(path: &Path) -> CheckpointResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| DocumentCheckpointError::storage("Document checkpoint does not exist"))?;
    invalid_if(
        metadata.file_type().is_symlink() || !metadata.is_file(),
        "Document checkpoint path is unsafe",
    )?;
    invalid_if(
        metadata.len() == 0 || metadata.len() > MAX_CHECKPOINT_BYTES,
        "Document checkpoint exceeds its size limit",
    )?;
    let file = File::open(path)
        .map_err(|_| DocumentCheckpointError::storage("Cannot open document checkpoint"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CHECKPOINT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DocumentCheckpointError::storage("Cannot read document checkpoint"))?;
    invalid_if(
        bytes.is_empty() || bytes.len() as u64 > MAX_CHECKPOINT_BYTES,
        "Document checkpoint exceeds its size limit",
    )?;
    Ok(bytes)
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(temporary.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| io::Error::other(error.to_string()))
    }
}

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temporary, target)
}

fn save_at_with_replace<F>(
    root: &Path,
    checkpoint: &DocumentCheckpoint,
    replace: F,
) -> CheckpointResult<()>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    checkpoint.validate()?;
    let payload = serde_json::to_vec(checkpoint)
        .map_err(|_| DocumentCheckpointError::invalid("Cannot serialize document checkpoint"))?;
    invalid_if(
        payload.len() as u64 > MAX_CHECKPOINT_BYTES,
        "Document checkpoint exceeds its size limit",
    )?;
    let _guard = storage_lock()?;
    let directory = ensure_job_directory(root, &checkpoint.job.id)?;
    cleanup_temporary_files(&directory)?;
    let target = directory.join(CHECKPOINT_FILE);
    let temporary = directory.join(format!(".{CHECKPOINT_FILE}.{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        drop(file);
        replace(&temporary, &target)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(DocumentCheckpointError::storage(format!(
            "Cannot save document checkpoint: {error}"
        )));
    }
    Ok(())
}

fn save_at(root: &Path, checkpoint: &DocumentCheckpoint) -> CheckpointResult<()> {
    save_at_with_replace(root, checkpoint, atomic_replace)
}

fn parse_checkpoint(bytes: &[u8]) -> Result<DocumentCheckpoint, CheckpointParseError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| CheckpointParseError {
            error: DocumentCheckpointError::invalid("Document checkpoint is invalid"),
            quarantine: true,
        })?;
    let version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| CheckpointParseError {
            error: DocumentCheckpointError::invalid("Document checkpoint version is invalid"),
            quarantine: true,
        })?;
    if version != CHECKPOINT_SCHEMA_VERSION as u64 {
        return Err(CheckpointParseError {
            error: DocumentCheckpointError::invalid(format!(
                "Unsupported document checkpoint version: {version}"
            )),
            quarantine: false,
        });
    }
    let checkpoint: DocumentCheckpoint =
        serde_json::from_value(value).map_err(|_| CheckpointParseError {
            error: DocumentCheckpointError::invalid("Document checkpoint is invalid"),
            quarantine: true,
        })?;
    checkpoint
        .validate()
        .map_err(|error| CheckpointParseError {
            error,
            quarantine: true,
        })?;
    Ok(checkpoint)
}

fn quarantine_checkpoint(path: &Path) -> CheckpointResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| DocumentCheckpointError::storage("Cannot isolate damaged checkpoint"))?;
    let quarantined = parent.join(format!("checkpoint.corrupt.{}.json", Uuid::new_v4()));
    fs::rename(path, quarantined)
        .map_err(|_| DocumentCheckpointError::storage("Cannot isolate damaged checkpoint"))
}

fn load_at(root: &Path, job_id: &str) -> CheckpointResult<DocumentCheckpoint> {
    let _guard = storage_lock()?;
    let directory = job_directory(root, job_id)?;
    let directory = validate_job_directory(root, &directory)?;
    cleanup_temporary_files(&directory)?;
    let path = directory.join(CHECKPOINT_FILE);
    let bytes = read_bounded(&path)?;
    let checkpoint = match parse_checkpoint(&bytes) {
        Ok(checkpoint) => checkpoint,
        Err(parsed_error) => {
            if parsed_error.quarantine {
                quarantine_checkpoint(&path)?;
            }
            return Err(parsed_error.error);
        }
    };
    if checkpoint.job.id != job_id {
        quarantine_checkpoint(&path)?;
        return Err(DocumentCheckpointError::invalid(
            "Document checkpoint job ID does not match its directory",
        ));
    }
    Ok(checkpoint.recover())
}

fn list_at(root: &Path) -> CheckpointResult<Vec<DocumentCheckpointSummary>> {
    let _guard = storage_lock()?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| DocumentCheckpointError::storage("Cannot resolve document checkpoint root"))?;
    let entries = fs::read_dir(&canonical_root)
        .map_err(|_| DocumentCheckpointError::storage("Cannot inspect document checkpoint root"))?;
    let mut summaries = Vec::new();
    for entry in entries.take(MAX_CHECKPOINT_SCAN_ENTRIES) {
        let entry = entry.map_err(|_| {
            DocumentCheckpointError::storage("Cannot inspect document checkpoint root")
        })?;
        let directory = entry.path();
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let directory = match validate_job_directory(&canonical_root, &directory) {
            Ok(directory) => directory,
            Err(_) => continue,
        };
        let job_id = match directory.file_name().and_then(|name| name.to_str()) {
            Some(job_id) if valid_job_id(job_id) => job_id,
            _ => continue,
        };
        let bytes = match read_bounded(&directory.join(CHECKPOINT_FILE)) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let checkpoint = match parse_checkpoint(&bytes) {
            Ok(checkpoint) if checkpoint.job.id == job_id => checkpoint.recover(),
            _ => continue,
        };
        if checkpoint.job.input.format != DocumentFormat::Docx {
            continue;
        }
        if !matches!(
            checkpoint.job.phase,
            DocumentJobPhase::Ready | DocumentJobPhase::Translating | DocumentJobPhase::Failed
        ) {
            continue;
        }
        let completed_segments = checkpoint
            .job
            .segments
            .iter()
            .filter(|segment| segment.status == DocumentSegmentStatus::Translated)
            .count();
        let failed_segments = checkpoint
            .job
            .segments
            .iter()
            .filter(|segment| segment.status == DocumentSegmentStatus::Failed)
            .count();
        summaries.push(DocumentCheckpointSummary {
            job_id: checkpoint.job.id,
            file_name: checkpoint.job.input.file_name,
            phase: checkpoint.job.phase,
            output_mode: checkpoint.job.output_mode,
            completed_segments,
            failed_segments,
            total_segments: checkpoint.job.segments.len(),
            updated_at: checkpoint.job.updated_at,
        });
    }
    summaries.sort_by(|left, right| {
        let left_updated = DateTime::parse_from_rfc3339(&left.updated_at).ok();
        let right_updated = DateTime::parse_from_rfc3339(&right.updated_at).ok();
        right_updated
            .cmp(&left_updated)
            .then_with(|| left.job_id.cmp(&right.job_id))
    });
    summaries.truncate(MAX_RECOVERY_SUMMARIES);
    Ok(summaries)
}

fn older_than(modified: std::time::SystemTime, now: DateTime<Utc>, age: Duration) -> bool {
    DateTime::<Utc>::from(modified) <= now - age
}

fn cleanup_at(
    root: &Path,
    now: DateTime<Utc>,
) -> CheckpointResult<DocumentCheckpointCleanupReport> {
    let _guard = storage_lock()?;
    let mut report = DocumentCheckpointCleanupReport::default();
    if !root.exists() {
        return Ok(report);
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| DocumentCheckpointError::storage("Cannot resolve document checkpoint root"))?;
    let entries = fs::read_dir(&canonical_root)
        .map_err(|_| DocumentCheckpointError::storage("Cannot inspect document checkpoint root"))?;
    for entry in entries {
        let entry = entry.map_err(|_| {
            DocumentCheckpointError::storage("Cannot inspect document checkpoint root")
        })?;
        let directory = entry.path();
        let metadata = fs::symlink_metadata(&directory).map_err(|_| {
            DocumentCheckpointError::storage("Cannot inspect document job directory")
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let directory = match validate_job_directory(&canonical_root, &directory) {
            Ok(directory) => directory,
            Err(_) => continue,
        };
        let mut remove_job = false;
        for file in fs::read_dir(&directory).map_err(|_| {
            DocumentCheckpointError::storage("Cannot inspect document job directory")
        })? {
            let file = file.map_err(|_| {
                DocumentCheckpointError::storage("Cannot inspect document job directory")
            })?;
            let name = file.file_name().to_string_lossy().into_owned();
            let metadata = fs::symlink_metadata(file.path()).map_err(|_| {
                DocumentCheckpointError::storage("Cannot inspect document job file")
            })?;
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata.modified().map_err(|_| {
                DocumentCheckpointError::storage("Cannot read document job file time")
            })?;
            if name.starts_with(&format!(".{CHECKPOINT_FILE}."))
                && name.ends_with(".tmp")
                && older_than(modified, now, Duration::hours(TEMPORARY_RETENTION_HOURS))
            {
                fs::remove_file(file.path()).map_err(|_| {
                    DocumentCheckpointError::storage("Cannot clean temporary checkpoint")
                })?;
                report.removed_temporary_files += 1;
            } else if name.starts_with("checkpoint.corrupt.")
                && name.ends_with(".json")
                && older_than(modified, now, Duration::days(QUARANTINE_RETENTION_DAYS))
            {
                fs::remove_file(file.path()).map_err(|_| {
                    DocumentCheckpointError::storage("Cannot clean quarantined checkpoint")
                })?;
                report.removed_quarantined_files += 1;
            } else if name == CHECKPOINT_FILE {
                let bytes = match read_bounded(&file.path()) {
                    Ok(bytes) => bytes,
                    Err(_) => continue,
                };
                let checkpoint = match parse_checkpoint(&bytes) {
                    Ok(checkpoint) => checkpoint,
                    Err(_) => continue,
                };
                let updated_at = match DateTime::parse_from_rfc3339(&checkpoint.job.updated_at) {
                    Ok(updated_at) => updated_at.with_timezone(&Utc),
                    Err(_) => continue,
                };
                let retention = match checkpoint.job.phase {
                    DocumentJobPhase::Completed => Some(Duration::days(COMPLETED_RETENTION_DAYS)),
                    DocumentJobPhase::Cancelled | DocumentJobPhase::Failed => {
                        Some(Duration::days(CANCELLED_FAILED_RETENTION_DAYS))
                    }
                    _ => None,
                };
                remove_job = retention.is_some_and(|retention| updated_at <= now - retention);
            }
        }
        if remove_job {
            fs::remove_dir_all(&directory).map_err(|_| {
                DocumentCheckpointError::storage("Cannot clean expired document job")
            })?;
            report.removed_jobs += 1;
        }
    }
    Ok(report)
}

fn delete_at(root: &Path, job_id: &str) -> CheckpointResult<()> {
    let _guard = storage_lock()?;
    let directory = job_directory(root, job_id)?;
    if !directory.exists() {
        return Ok(());
    }
    let directory = validate_job_directory(root, &directory)?;
    fs::remove_dir_all(&directory)
        .map_err(|_| DocumentCheckpointError::storage("Cannot delete document checkpoint"))
}

fn checkpoint_root(app: &AppHandle) -> CheckpointResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CHECKPOINT_ROOT))
        .map_err(|_| DocumentCheckpointError::storage("Cannot resolve application data directory"))
}

pub(crate) fn cleanup_document_checkpoints_in(
    app_data_dir: &Path,
) -> CheckpointResult<DocumentCheckpointCleanupReport> {
    cleanup_at(&app_data_dir.join(CHECKPOINT_ROOT), Utc::now())
}

#[tauri::command]
pub fn save_document_checkpoint(
    app: AppHandle,
    checkpoint: DocumentCheckpoint,
) -> CheckpointResult<()> {
    save_at(&checkpoint_root(&app)?, &checkpoint)
}

#[tauri::command]
pub fn load_document_checkpoint(
    app: AppHandle,
    job_id: String,
) -> CheckpointResult<DocumentCheckpoint> {
    load_at(&checkpoint_root(&app)?, &job_id)
}

#[tauri::command]
pub fn list_document_checkpoints(
    app: AppHandle,
) -> CheckpointResult<Vec<DocumentCheckpointSummary>> {
    list_at(&checkpoint_root(&app)?)
}

#[tauri::command]
pub fn delete_document_checkpoint(app: AppHandle, job_id: String) -> CheckpointResult<()> {
    delete_at(&checkpoint_root(&app)?, &job_id)
}

#[tauri::command]
pub fn cleanup_document_checkpoints(
    app: AppHandle,
) -> CheckpointResult<DocumentCheckpointCleanupReport> {
    cleanup_at(&checkpoint_root(&app)?, Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("long-translate-checkpoint-{}", Uuid::new_v4()))
    }

    fn checkpoint() -> DocumentCheckpoint {
        DocumentCheckpoint {
            schema_version: 1,
            job: DocumentJob {
                id: "job-1".to_string(),
                phase: DocumentJobPhase::Translating,
                input: DocumentInput {
                    source_path: r"C:\docs\input.docx".to_string(),
                    file_name: "input.docx".to_string(),
                    size_bytes: 1024,
                    format: DocumentFormat::Docx,
                    fingerprint: "sha256:fixture".to_string(),
                },
                output_mode: DocumentOutputMode::Translated,
                output_path: None,
                snapshot: DocumentTranslationSnapshot {
                    source_language: "en".to_string(),
                    target_language: "zh-Hans".to_string(),
                    primary: DocumentProviderSnapshot {
                        base_url: "https://api.example.com/v1".to_string(),
                        model: "translate-1".to_string(),
                    },
                    backup: None,
                    custom_prompt: "Translate".to_string(),
                    glossary: vec![GlossaryEntry {
                        source_term: "hello".to_string(),
                        target_term: "你好".to_string(),
                    }],
                },
                concurrency: 3,
                segments: vec![DocumentSegment {
                    id: "segment-1".to_string(),
                    location: DocumentSegmentLocation {
                        order: 0,
                        part: "word/document.xml".to_string(),
                        page: None,
                        source_position: Some("paragraph:0".to_string()),
                    },
                    structure: DocumentStructureKind::Paragraph,
                    source_text: "Hello".to_string(),
                    translated_text: Some("partial".to_string()),
                    status: DocumentSegmentStatus::Translating,
                    attempts: 1,
                    error: Some(DocumentError {
                        code: DocumentErrorCode::TranslationFailed,
                        message: "interrupted".to_string(),
                        retryable: true,
                        segment_id: Some("segment-1".to_string()),
                    }),
                }],
                error: None,
                created_at: "2026-08-13T00:00:00.000Z".to_string(),
                updated_at: "2026-08-13T00:01:00.000Z".to_string(),
            },
        }
    }

    #[test]
    #[ignore = "requires the explicitly downloaded public PDF acceptance corpus"]
    fn real_pdf_inspection_round_trips_through_the_shared_checkpoint_contract() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".pdf-acceptance")
            .join("resource-hub.pdf");
        let inspection =
            crate::pdf_document::inspect_pdf_document(source.to_string_lossy().into_owned())
                .expect("real public PDF must inspect successfully");
        assert_eq!(inspection.page_count, 1);
        assert_eq!(inspection.segments.len(), 4);

        let root = test_root();
        let output = root.join("resource-hub-translated.docx");
        let checkpoint = DocumentCheckpoint {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            job: DocumentJob {
                id: "real-pdf-checkpoint".to_string(),
                phase: DocumentJobPhase::Ready,
                input: DocumentInput {
                    source_path: source.to_string_lossy().into_owned(),
                    file_name: inspection.file_name,
                    size_bytes: inspection.size_bytes,
                    format: DocumentFormat::Pdf,
                    fingerprint: inspection.fingerprint,
                },
                output_mode: DocumentOutputMode::Translated,
                output_path: Some(output.to_string_lossy().into_owned()),
                snapshot: DocumentTranslationSnapshot {
                    source_language: "auto".to_string(),
                    target_language: "zh-Hans".to_string(),
                    primary: DocumentProviderSnapshot {
                        base_url: "https://api.example.com/v1".to_string(),
                        model: "acceptance-model".to_string(),
                    },
                    backup: None,
                    custom_prompt: String::new(),
                    glossary: Vec::new(),
                },
                concurrency: 3,
                segments: inspection
                    .segments
                    .into_iter()
                    .map(|segment| DocumentSegment {
                        id: segment.id,
                        location: DocumentSegmentLocation {
                            order: segment.order,
                            part: format!("page:{}", segment.page),
                            page: Some(segment.page),
                            source_position: Some(segment.source_position),
                        },
                        structure: DocumentStructureKind::Paragraph,
                        source_text: segment.source_text,
                        translated_text: None,
                        status: DocumentSegmentStatus::Pending,
                        attempts: 0,
                        error: None,
                    })
                    .collect(),
                error: None,
                created_at: "2026-08-20T00:00:00.000Z".to_string(),
                updated_at: "2026-08-20T00:00:00.000Z".to_string(),
            },
        };

        save_at(&root, &checkpoint).unwrap();
        let recovered = load_at(&root, "real-pdf-checkpoint").unwrap();
        assert_eq!(recovered.job.input.format, DocumentFormat::Pdf);
        assert_eq!(recovered.job.segments.len(), 4);
        assert!(recovered.job.segments.iter().all(|segment| {
            segment.location.page == Some(1)
                && segment.location.part == "page:1"
                && segment
                    .location
                    .source_position
                    .as_deref()
                    .is_some_and(|position| position.starts_with("page:1:line:"))
        }));
        assert!(!output.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomically_replaces_and_recovers_interrupted_translation() {
        let root = test_root();
        let first = checkpoint();
        save_at(&root, &first).unwrap();
        let stale = root
            .join("job-1")
            .join(format!(".{CHECKPOINT_FILE}.stale.tmp"));
        fs::write(&stale, b"truncated").unwrap();

        let mut second = first.clone();
        second.job.updated_at = "2026-08-13T00:02:00.000Z".to_string();
        save_at(&root, &second).unwrap();
        let recovered = load_at(&root, "job-1").unwrap();

        assert_eq!(recovered.job.phase, DocumentJobPhase::Ready);
        assert_eq!(recovered.job.updated_at, second.job.updated_at);
        assert_eq!(
            recovered.job.segments[0].status,
            DocumentSegmentStatus::Pending
        );
        assert_eq!(recovered.job.segments[0].translated_text, None);
        assert_eq!(recovered.job.segments[0].error, None);
        assert!(!stale.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_only_recoverable_jobs_as_bounded_redacted_summaries() {
        let root = test_root();
        let interrupted = checkpoint();
        save_at(&root, &interrupted).unwrap();

        let mut failed = checkpoint();
        failed.job.id = "failed-job".to_string();
        failed.job.phase = DocumentJobPhase::Failed;
        failed.job.updated_at = "2026-08-13T00:03:00.000Z".to_string();
        failed.job.segments[0].status = DocumentSegmentStatus::Failed;
        failed.job.segments[0].translated_text = None;
        save_at(&root, &failed).unwrap();

        let mut completed = checkpoint();
        completed.job.id = "completed-job".to_string();
        completed.job.phase = DocumentJobPhase::Completed;
        completed.job.output_path = Some(r"C:\docs\output.docx".to_string());
        completed.job.segments[0].status = DocumentSegmentStatus::Translated;
        completed.job.segments[0].translated_text = Some("translated secret".to_string());
        completed.job.segments[0].error = None;
        save_at(&root, &completed).unwrap();

        let summaries = list_at(&root).unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].job_id, "failed-job");
        assert_eq!(summaries[0].failed_segments, 1);
        assert_eq!(summaries[1].job_id, "job-1");
        assert_eq!(summaries[1].phase, DocumentJobPhase::Ready);
        assert_eq!(summaries[1].completed_segments, 0);
        assert_eq!(summaries[1].failed_segments, 0);

        let serialized = serde_json::to_string(&summaries).unwrap();
        for private_value in [
            r"C:\docs\input.docx",
            "https://api.example.com/v1",
            "Translate",
            "Hello",
            "partial",
            "interrupted",
            "translated secret",
        ] {
            assert!(!serialized.contains(private_value));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovery_skips_invalid_entries_without_mutating_them() {
        let root = test_root();
        save_at(&root, &checkpoint()).unwrap();
        let invalid_dir = root.join("invalid-job");
        fs::create_dir_all(&invalid_dir).unwrap();
        let invalid_path = invalid_dir.join(CHECKPOINT_FILE);
        fs::write(&invalid_path, b"not-json").unwrap();

        let summaries = list_at(&root).unwrap();
        assert_eq!(summaries.len(), 1);
        assert!(invalid_path.exists());
        assert_eq!(fs::read_dir(&invalid_dir).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unknown_secret_fields_and_credential_urls() {
        let mut value = serde_json::to_value(checkpoint()).unwrap();
        value["job"]["snapshot"]["apiKey"] = serde_json::json!("must-not-persist");
        assert!(serde_json::from_value::<DocumentCheckpoint>(value).is_err());

        let mut invalid_url = checkpoint();
        invalid_url.job.snapshot.primary.base_url =
            "https://api.example.com/v1?api_key=secret".to_string();
        assert!(invalid_url
            .validate()
            .unwrap_err()
            .message
            .contains("credentials"));
    }

    #[test]
    fn rejects_unsafe_ids_limits_and_future_versions() {
        let mut value = checkpoint();
        value.schema_version = 2;
        assert!(value.validate().unwrap_err().message.contains("version"));
        value.schema_version = 1;
        value.job.id = "../escape".to_string();
        assert!(value.validate().unwrap_err().message.contains("job ID"));
        value.job.id = "job-1".to_string();
        value.job.segments[0].source_text = "译".repeat(11_000);
        assert!(value.validate().unwrap_err().message.contains("32 KiB"));
    }

    #[test]
    fn rejects_truncated_checkpoints_and_accepts_the_restored_last_good_file() {
        let root = test_root();
        save_at(&root, &checkpoint()).unwrap();
        let path = root.join("job-1").join(CHECKPOINT_FILE);
        let good = fs::read(&path).unwrap();
        fs::write(&path, b"{\"schemaVersion\":1").unwrap();
        assert_eq!(
            load_at(&root, "job-1").unwrap_err().code,
            DocumentCheckpointErrorCode::CheckpointInvalid
        );
        assert!(!path.exists());
        assert_eq!(
            fs::read_dir(root.join("job-1"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("checkpoint.corrupt."))
                .count(),
            1
        );
        fs::write(&path, good).unwrap();
        assert!(load_at(&root, "job-1").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_future_versions_for_a_newer_application() {
        let root = test_root();
        save_at(&root, &checkpoint()).unwrap();
        let path = root.join("job-1").join(CHECKPOINT_FILE);
        let mut value = serde_json::to_value(checkpoint()).unwrap();
        value["schemaVersion"] = serde_json::json!(2);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(load_at(&root, "job-1")
            .unwrap_err()
            .message
            .contains("version: 2"));
        assert!(path.exists());
        assert_eq!(fs::read_dir(root.join("job-1")).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_replacement_preserves_the_last_complete_checkpoint() {
        let root = test_root();
        let first = checkpoint();
        save_at(&root, &first).unwrap();
        let path = root.join("job-1").join(CHECKPOINT_FILE);
        let before = fs::read(&path).unwrap();
        let mut second = first;
        second.job.updated_at = "2026-08-13T00:02:00.000Z".to_string();
        let error = save_at_with_replace(&root, &second, |_, _| {
            Err(io::Error::new(io::ErrorKind::StorageFull, "injected"))
        })
        .unwrap_err();
        assert_eq!(error.code, DocumentCheckpointErrorCode::Storage);
        assert_eq!(fs::read(&path).unwrap(), before);
        let permission_error = save_at_with_replace(&root, &second, |_, _| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"))
        })
        .unwrap_err();
        assert_eq!(permission_error.code, DocumentCheckpointErrorCode::Storage);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            fs::read_dir(root.join("job-1"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn exclusive_windows_file_lock_preserves_the_last_complete_checkpoint() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = test_root();
        let first = checkpoint();
        save_at(&root, &first).unwrap();
        let path = root.join("job-1").join(CHECKPOINT_FILE);
        let before = fs::read(&path).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let mut second = first;
        second.job.updated_at = "2026-08-13T00:02:00.000Z".to_string();
        let error = save_at(&root, &second).unwrap_err();
        assert_eq!(error.code, DocumentCheckpointErrorCode::Storage);
        assert_eq!(
            fs::read_dir(root.join("job-1"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );

        drop(lock);
        assert_eq!(fs::read(&path).unwrap(), before);
        save_at(&root, &second).unwrap();
        assert_eq!(
            load_at(&root, "job-1").unwrap().job.updated_at,
            "2026-08-13T00:02:00.000Z"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_saves_leave_one_complete_valid_checkpoint() {
        let root = test_root();
        let mut first = checkpoint();
        let mut second = checkpoint();
        first.job.updated_at = "2026-08-13T00:02:00.000Z".to_string();
        second.job.updated_at = "2026-08-13T00:03:00.000Z".to_string();
        std::thread::scope(|scope| {
            let first_handle = scope.spawn(|| save_at(&root, &first));
            let second_handle = scope.spawn(|| save_at(&root, &second));
            first_handle.join().unwrap().unwrap();
            second_handle.join().unwrap().unwrap();
        });
        let bytes = fs::read(root.join("job-1").join(CHECKPOINT_FILE)).unwrap();
        let stored = parse_checkpoint(&bytes).unwrap();
        assert!(matches!(
            stored.job.updated_at.as_str(),
            "2026-08-13T00:02:00.000Z" | "2026-08-13T00:03:00.000Z"
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_removes_only_expired_terminal_jobs_and_stale_artifacts() {
        let root = test_root();
        let mut completed = checkpoint();
        completed.job.id = "completed-job".to_string();
        completed.job.phase = DocumentJobPhase::Completed;
        completed.job.output_path = Some(r"C:\docs\output.docx".to_string());
        completed.job.segments[0].status = DocumentSegmentStatus::Translated;
        completed.job.segments[0].translated_text = Some("你好".to_string());
        completed.job.segments[0].error = None;
        save_at(&root, &completed).unwrap();

        let active = checkpoint();
        save_at(&root, &active).unwrap();
        let active_dir = root.join("job-1");
        fs::write(
            active_dir.join(format!(".{CHECKPOINT_FILE}.stale.tmp")),
            b"stale",
        )
        .unwrap();
        fs::write(active_dir.join("checkpoint.corrupt.stale.json"), b"stale").unwrap();

        let report = cleanup_at(&root, Utc::now() + Duration::days(31)).unwrap();
        assert_eq!(report.removed_jobs, 1);
        assert_eq!(report.removed_temporary_files, 1);
        assert_eq!(report.removed_quarantined_files, 1);
        assert!(!root.join("completed-job").exists());
        assert!(active_dir.join(CHECKPOINT_FILE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_is_idempotent_and_confined_to_the_job_directory() {
        let root = test_root();
        save_at(&root, &checkpoint()).unwrap();
        delete_at(&root, "job-1").unwrap();
        delete_at(&root, "job-1").unwrap();
        assert!(!root.join("job-1").exists());
        assert!(delete_at(&root, "../outside").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
