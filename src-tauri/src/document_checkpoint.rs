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

fn save_at(root: &Path, checkpoint: &DocumentCheckpoint) -> CheckpointResult<()> {
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
        atomic_replace(&temporary, &target)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(DocumentCheckpointError::storage(format!(
            "Cannot save document checkpoint: {error}"
        )));
    }
    Ok(())
}

fn load_at(root: &Path, job_id: &str) -> CheckpointResult<DocumentCheckpoint> {
    let _guard = storage_lock()?;
    let directory = job_directory(root, job_id)?;
    let directory = validate_job_directory(root, &directory)?;
    cleanup_temporary_files(&directory)?;
    let bytes = read_bounded(&directory.join(CHECKPOINT_FILE))?;
    let checkpoint: DocumentCheckpoint = serde_json::from_slice(&bytes)
        .map_err(|_| DocumentCheckpointError::invalid("Document checkpoint is invalid"))?;
    checkpoint.validate()?;
    invalid_if(
        checkpoint.job.id != job_id,
        "Document checkpoint job ID does not match its directory",
    )?;
    Ok(checkpoint.recover())
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
pub fn delete_document_checkpoint(app: AppHandle, job_id: String) -> CheckpointResult<()> {
    delete_at(&checkpoint_root(&app)?, &job_id)
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
        fs::write(&path, good).unwrap();
        assert!(load_at(&root, "job-1").is_ok());
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
