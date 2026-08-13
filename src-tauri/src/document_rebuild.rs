use crate::document::{inspect_docx_path, DocxInspection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_SEGMENTS: usize = 20_000;
const MAX_SEGMENT_BYTES: usize = 32 * 1024;
const MAX_TRANSLATED_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxRebuildErrorCode {
    InvalidPlan,
    StaleSource,
    RebuildFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DocxRebuildError {
    pub code: DocxRebuildErrorCode,
    pub message: String,
}

impl DocxRebuildError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: DocxRebuildErrorCode::InvalidPlan,
            message: message.into(),
        }
    }

    fn stale(message: impl Into<String>) -> Self {
        Self {
            code: DocxRebuildErrorCode::StaleSource,
            message: message.into(),
        }
    }

    fn rebuild(message: impl Into<String>) -> Self {
        Self {
            code: DocxRebuildErrorCode::RebuildFailed,
            message: message.into(),
        }
    }
}

type RebuildResult<T> = Result<T, DocxRebuildError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum DocxOutputMode {
    Translated,
    Bilingual,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRebuildReplacement {
    id: String,
    order: usize,
    part: String,
    source_position: String,
    structure: String,
    source_text: String,
    translated_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRebuildPlan {
    source_path: String,
    output_path: String,
    fingerprint: String,
    output_mode: DocxOutputMode,
    replacements: Vec<DocxRebuildReplacement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRebuildValidation {
    pub replacement_count: usize,
    pub part_count: usize,
    pub translated_bytes: usize,
}

fn normalized_windows_path(path: &str) -> String {
    path.trim().replace('/', "\\").to_ascii_lowercase()
}

fn validate_output_path(source: &str, output: &str) -> RebuildResult<()> {
    let source_path = Path::new(source.trim());
    let output_path = Path::new(output.trim());
    if !source_path.is_absolute()
        || !output_path.is_absolute()
        || output_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("docx"))
    {
        return Err(DocxRebuildError::invalid(
            "DOCX rebuild paths must be absolute and the output must use .docx",
        ));
    }
    if normalized_windows_path(source) == normalized_windows_path(output) {
        return Err(DocxRebuildError::invalid(
            "DOCX output must not overwrite its source",
        ));
    }
    Ok(())
}

fn parse_range(value: &str) -> Option<(usize, usize)> {
    let (start, end) = value.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    (start <= end).then_some((start, end))
}

fn validate_anchor(value: &str) -> bool {
    let fields = value.split(':').collect::<Vec<_>>();
    if fields.len() != 10
        || fields[0] != "paragraph"
        || fields[2] != "chunk"
        || fields[4] != "bytes"
        || fields[6] != "runs"
        || fields[8] != "texts"
        || fields[1].parse::<usize>().is_err()
        || fields[3].parse::<usize>().is_err()
    {
        return false;
    }
    let Some((byte_start, byte_end)) = parse_range(fields[5]) else {
        return false;
    };
    byte_start < byte_end && parse_range(fields[7]).is_some() && parse_range(fields[9]).is_some()
}

fn validate_against_inspection(
    plan: &DocxRebuildPlan,
    inspection: &DocxInspection,
) -> RebuildResult<DocxRebuildValidation> {
    validate_output_path(&plan.source_path, &plan.output_path)?;
    if plan.fingerprint != inspection.fingerprint {
        return Err(DocxRebuildError::stale(
            "DOCX source fingerprint changed after inspection",
        ));
    }
    if plan.replacements.is_empty() || plan.replacements.len() > MAX_SEGMENTS {
        return Err(DocxRebuildError::invalid(
            "DOCX rebuild replacement count is invalid",
        ));
    }
    if plan.replacements.len() != inspection.segments.len() {
        return Err(DocxRebuildError::stale(
            "DOCX segment count changed after inspection",
        ));
    }

    let mut translated_bytes = 0usize;
    let mut parts = HashSet::new();
    for (order, (replacement, inspected)) in plan
        .replacements
        .iter()
        .zip(&inspection.segments)
        .enumerate()
    {
        if replacement.order != order
            || replacement.id != inspected.id
            || replacement.part != inspected.part
            || replacement.source_position != inspected.source_position
            || replacement.structure != inspected.structure
            || replacement.source_text != inspected.source_text
        {
            return Err(DocxRebuildError::stale(format!(
                "DOCX replacement anchor does not match segment {order}"
            )));
        }
        if !validate_anchor(&replacement.source_position)
            || replacement.translated_text.trim().is_empty()
            || replacement.translated_text.len() > MAX_SEGMENT_BYTES
        {
            return Err(DocxRebuildError::invalid(format!(
                "DOCX replacement {order} is invalid"
            )));
        }
        translated_bytes = translated_bytes
            .checked_add(replacement.translated_text.len())
            .ok_or_else(|| DocxRebuildError::invalid("DOCX translation size is invalid"))?;
        if translated_bytes > MAX_TRANSLATED_BYTES {
            return Err(DocxRebuildError::invalid(
                "DOCX translated text exceeds the 24 MiB limit",
            ));
        }
        parts.insert(replacement.part.as_str());
    }

    let _ = plan.output_mode;
    Ok(DocxRebuildValidation {
        replacement_count: plan.replacements.len(),
        part_count: parts.len(),
        translated_bytes,
    })
}

#[tauri::command]
pub fn validate_docx_rebuild_plan(plan: DocxRebuildPlan) -> RebuildResult<DocxRebuildValidation> {
    let inspection =
        inspect_docx_path(&PathBuf::from(plan.source_path.trim())).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot re-inspect DOCX source: {}", error.message))
        })?;
    validate_against_inspection(&plan, &inspection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{DocxImportWarning, DocxSegment};

    fn inspection() -> DocxInspection {
        DocxInspection {
            fingerprint: "sha256:fixture".to_string(),
            file_name: "input.docx".to_string(),
            size_bytes: 1024,
            segments: vec![DocxSegment {
                id: "segment-1".to_string(),
                order: 0,
                part: "word/document.xml".to_string(),
                source_position: "paragraph:0:chunk:0:bytes:0-5:runs:0-0:texts:0-0".to_string(),
                structure: "paragraph".to_string(),
                source_text: "Hello".to_string(),
            }],
            warnings: Vec::<DocxImportWarning>::new(),
        }
    }

    fn plan() -> DocxRebuildPlan {
        DocxRebuildPlan {
            source_path: r"C:\docs\input.docx".to_string(),
            output_path: r"C:\docs\translated.docx".to_string(),
            fingerprint: "sha256:fixture".to_string(),
            output_mode: DocxOutputMode::Translated,
            replacements: vec![DocxRebuildReplacement {
                id: "segment-1".to_string(),
                order: 0,
                part: "word/document.xml".to_string(),
                source_position: "paragraph:0:chunk:0:bytes:0-5:runs:0-0:texts:0-0".to_string(),
                structure: "paragraph".to_string(),
                source_text: "Hello".to_string(),
                translated_text: "你好".to_string(),
            }],
        }
    }

    #[test]
    fn validates_a_closed_rebuild_plan() {
        assert_eq!(
            validate_against_inspection(&plan(), &inspection()).unwrap(),
            DocxRebuildValidation {
                replacement_count: 1,
                part_count: 1,
                translated_bytes: 6,
            }
        );
    }

    #[test]
    fn rejects_stale_anchors_and_source_fingerprints() {
        let mut stale = plan();
        stale.replacements[0].source_text = "Changed".to_string();
        assert_eq!(
            validate_against_inspection(&stale, &inspection())
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::StaleSource
        );
        let mut fingerprint = plan();
        fingerprint.fingerprint = "sha256:changed".to_string();
        assert_eq!(
            validate_against_inspection(&fingerprint, &inspection())
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::StaleSource
        );
    }

    #[test]
    fn rejects_unsafe_paths_malformed_anchors_and_oversized_translations() {
        let mut overwrite = plan();
        overwrite.output_path = r"c:/DOCS/input.docx".to_string();
        assert_eq!(
            validate_against_inspection(&overwrite, &inspection())
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::InvalidPlan
        );
        let mut malformed = plan();
        malformed.replacements[0].source_position = "paragraph:0".to_string();
        let mut matching = inspection();
        matching.segments[0].source_position = "paragraph:0".to_string();
        assert_eq!(
            validate_against_inspection(&malformed, &matching)
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::InvalidPlan
        );
        let mut oversized = plan();
        oversized.replacements[0].translated_text = "译".repeat(11_000);
        assert_eq!(
            validate_against_inspection(&oversized, &inspection())
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::InvalidPlan
        );
    }

    #[test]
    fn rejects_unknown_plan_fields_before_validation() {
        let value = serde_json::json!({
            "sourcePath": "C:\\docs\\input.docx",
            "outputPath": "C:\\docs\\translated.docx",
            "fingerprint": "sha256:fixture",
            "outputMode": "translated",
            "replacements": [],
            "apiKey": "must-not-cross-the-boundary"
        });
        assert!(serde_json::from_value::<DocxRebuildPlan>(value).is_err());
    }
}
