use crate::document::{dialog_label, inspect_docx_bytes, local_dialog_path, DocxInspection};
use crate::pdf_document::{inspect_pdf_document, PdfInspection};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use unicode_segmentation::UnicodeSegmentation;
use zip::write::ZipWriter;
use zip::ZipArchive;

const MAX_SEGMENTS: usize = 20_000;
const MAX_SEGMENT_BYTES: usize = 32 * 1024;
const MAX_TRANSLATED_BYTES: usize = 24 * 1024 * 1024;
const MAX_DOCX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_XML_PART_BYTES: usize = 16 * 1024 * 1024;
const REBUILD_RUNNING: u8 = 0;
const REBUILD_CANCELLED: u8 = 1;
const REBUILD_PUBLISHING: u8 = 2;
const REBUILD_COMPLETED: u8 = 3;

static REBUILD_TASKS: OnceLock<Mutex<HashMap<String, Arc<RebuildCancellation>>>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxRebuildErrorCode {
    InvalidPlan,
    StaleSource,
    RebuildFailed,
    Cancelled,
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

    fn cancelled() -> Self {
        Self {
            code: DocxRebuildErrorCode::Cancelled,
            message: "DOCX rebuild was cancelled".to_string(),
        }
    }
}

type RebuildResult<T> = Result<T, DocxRebuildError>;

#[derive(Debug)]
struct RebuildCancellation {
    state: AtomicU8,
}

impl RebuildCancellation {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(REBUILD_RUNNING),
        }
    }

    fn check(&self) -> RebuildResult<()> {
        if self.state.load(Ordering::Acquire) == REBUILD_CANCELLED {
            Err(DocxRebuildError::cancelled())
        } else {
            Ok(())
        }
    }

    fn cancel(&self) -> bool {
        self.state
            .compare_exchange(
                REBUILD_RUNNING,
                REBUILD_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn begin_publish(&self) -> RebuildResult<()> {
        self.state
            .compare_exchange(
                REBUILD_RUNNING,
                REBUILD_PUBLISHING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map(|_| ())
            .map_err(|_| DocxRebuildError::cancelled())
    }

    fn complete(&self) {
        self.state.store(REBUILD_COMPLETED, Ordering::Release);
    }
}

fn valid_rebuild_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && job_id.len() <= 64
        && job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn rebuild_tasks() -> &'static Mutex<HashMap<String, Arc<RebuildCancellation>>> {
    REBUILD_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RebuildRegistration {
    job_id: String,
    cancellation: Arc<RebuildCancellation>,
}

impl RebuildRegistration {
    fn register(job_id: String) -> RebuildResult<Self> {
        if !valid_rebuild_job_id(&job_id) {
            return Err(DocxRebuildError::invalid("Invalid DOCX rebuild job ID"));
        }
        let cancellation = Arc::new(RebuildCancellation::new());
        let mut tasks = rebuild_tasks()
            .lock()
            .map_err(|_| DocxRebuildError::rebuild("DOCX rebuild registry is unavailable"))?;
        if tasks.contains_key(&job_id) {
            return Err(DocxRebuildError::invalid(
                "DOCX rebuild job is already running",
            ));
        }
        tasks.insert(job_id.clone(), Arc::clone(&cancellation));
        Ok(Self {
            job_id,
            cancellation,
        })
    }
}

impl Drop for RebuildRegistration {
    fn drop(&mut self) {
        if let Ok(mut tasks) = rebuild_tasks().lock() {
            if tasks
                .get(&self.job_id)
                .is_some_and(|active| Arc::ptr_eq(active, &self.cancellation))
            {
                tasks.remove(&self.job_id);
            }
        }
    }
}

fn cancel_rebuild_job(job_id: &str) -> RebuildResult<bool> {
    if !valid_rebuild_job_id(job_id) {
        return Err(DocxRebuildError::invalid("Invalid DOCX rebuild job ID"));
    }
    let tasks = rebuild_tasks()
        .lock()
        .map_err(|_| DocxRebuildError::rebuild("DOCX rebuild registry is unavailable"))?;
    Ok(tasks.get(job_id).is_some_and(|task| task.cancel()))
}

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
    pub rebuilt_size_bytes: usize,
    pub rebuilt_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRebuildResult {
    pub output_path: String,
    pub replacement_count: usize,
    pub size_bytes: usize,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfDocxExportSegment {
    id: String,
    order: usize,
    page: u32,
    source_position: String,
    source_text: String,
    translated_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfDocxExportPlan {
    source_path: String,
    output_path: String,
    fingerprint: String,
    output_mode: DocxOutputMode,
    segments: Vec<PdfDocxExportSegment>,
}

struct TempFileGuard {
    path: PathBuf,
    armed: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReplacementAnchor {
    paragraph: usize,
    chunk: usize,
    byte_start: usize,
    byte_end: usize,
    run_start: usize,
    run_end: usize,
    text_start: usize,
    text_end: usize,
}

#[derive(Debug, Default)]
struct ParagraphRewrite {
    replacements: Vec<usize>,
    text_start: usize,
    text_end: usize,
}

#[derive(Debug)]
struct ParagraphOutput {
    text_nodes: Vec<Option<String>>,
    bilingual_translation: Option<String>,
}

fn normalized_windows_path(path: &str) -> String {
    path.trim().replace('/', "\\").to_ascii_lowercase()
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\UNC\")
        .map(|suffix| format!(r"\\{suffix}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| value.into_owned())
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

fn parse_anchor(value: &str) -> Option<ReplacementAnchor> {
    let fields = value.split(':').collect::<Vec<_>>();
    if fields.len() != 10
        || fields[0] != "paragraph"
        || fields[2] != "chunk"
        || fields[4] != "bytes"
        || fields[6] != "runs"
        || fields[8] != "texts"
    {
        return None;
    }
    let (byte_start, byte_end) = parse_range(fields[5])?;
    let (run_start, run_end) = parse_range(fields[7])?;
    let (text_start, text_end) = parse_range(fields[9])?;
    (byte_start < byte_end).then_some(ReplacementAnchor {
        paragraph: fields[1].parse().ok()?,
        chunk: fields[3].parse().ok()?,
        byte_start,
        byte_end,
        run_start,
        run_end,
        text_start,
        text_end,
    })
}

fn check_cancel(cancellation: Option<&RebuildCancellation>) -> RebuildResult<()> {
    cancellation.map_or(Ok(()), RebuildCancellation::check)
}

#[cfg(test)]
fn validate_against_inspection(
    plan: &DocxRebuildPlan,
    inspection: &DocxInspection,
) -> RebuildResult<DocxRebuildValidation> {
    validate_against_inspection_with_cancel(plan, inspection, None)
}

fn validate_against_inspection_with_cancel(
    plan: &DocxRebuildPlan,
    inspection: &DocxInspection,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<DocxRebuildValidation> {
    check_cancel(cancellation)?;
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
        check_cancel(cancellation)?;
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
        if parse_anchor(&replacement.source_position).is_none()
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
        rebuilt_size_bytes: 0,
        rebuilt_fingerprint: String::new(),
    })
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn contains_only_xml_characters(value: &str) -> bool {
    value.chars().all(|character| {
        matches!(character, '\u{9}' | '\u{A}' | '\u{D}')
            || matches!(character as u32, 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF)
    })
}

fn read_source_bytes_with_cancel(
    path: &str,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<Vec<u8>> {
    check_cancel(cancellation)?;
    let mut file = File::open(path.trim())
        .map_err(|error| DocxRebuildError::rebuild(format!("Cannot open DOCX source: {error}")))?;
    let metadata = file.metadata().map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot inspect DOCX source: {error}"))
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_DOCX_BYTES {
        return Err(DocxRebuildError::invalid(
            "DOCX source must be a non-empty file within the 50 MiB limit",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut limited = (&mut file).take(MAX_DOCX_BYTES + 1);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        check_cancel(cancellation)?;
        let read = limited.read(&mut chunk).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot read DOCX source: {error}"))
        })?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    if bytes.len() as u64 > MAX_DOCX_BYTES {
        return Err(DocxRebuildError::invalid(
            "DOCX source exceeds the 50 MiB limit",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
fn build_rewrite_index(
    plan: &DocxRebuildPlan,
) -> RebuildResult<BTreeMap<String, BTreeMap<usize, ParagraphRewrite>>> {
    build_rewrite_index_with_cancel(plan, None)
}

fn build_rewrite_index_with_cancel(
    plan: &DocxRebuildPlan,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<BTreeMap<String, BTreeMap<usize, ParagraphRewrite>>> {
    let mut parts = BTreeMap::<String, BTreeMap<usize, ParagraphRewrite>>::new();
    for (index, replacement) in plan.replacements.iter().enumerate() {
        check_cancel(cancellation)?;
        if !contains_only_xml_characters(&replacement.translated_text) {
            return Err(DocxRebuildError::invalid(format!(
                "DOCX replacement {index} contains characters forbidden by XML 1.0"
            )));
        }
        let anchor = parse_anchor(&replacement.source_position).ok_or_else(|| {
            DocxRebuildError::invalid(format!("DOCX replacement {index} has an invalid anchor"))
        })?;
        if anchor.byte_end - anchor.byte_start != replacement.source_text.len() {
            return Err(DocxRebuildError::stale(format!(
                "DOCX replacement {index} byte anchor no longer matches its source"
            )));
        }
        let paragraph = parts
            .entry(replacement.part.clone())
            .or_default()
            .entry(anchor.paragraph)
            .or_default();
        if let Some(previous_index) = paragraph.replacements.last().copied() {
            let previous = &plan.replacements[previous_index];
            let previous_anchor =
                parse_anchor(&previous.source_position).expect("validated anchor");
            if anchor.chunk != previous_anchor.chunk + 1
                || anchor.byte_start != previous_anchor.byte_end
            {
                return Err(DocxRebuildError::invalid(format!(
                    "DOCX paragraph {} has non-contiguous replacement chunks",
                    anchor.paragraph
                )));
            }
            paragraph.text_end = paragraph.text_end.max(anchor.text_end);
        } else {
            if anchor.chunk != 0 || anchor.byte_start != 0 {
                return Err(DocxRebuildError::invalid(format!(
                    "DOCX paragraph {} does not start at its first chunk",
                    anchor.paragraph
                )));
            }
            paragraph.text_start = anchor.text_start;
            paragraph.text_end = anchor.text_end;
        }
        paragraph.replacements.push(index);
    }
    Ok(parts)
}

#[cfg(test)]
fn collect_paragraph_text_nodes(xml: &[u8]) -> RebuildResult<HashMap<usize, Vec<String>>> {
    collect_paragraph_text_nodes_with_cancel(xml, None)
}

fn collect_paragraph_text_nodes_with_cancel(
    xml: &[u8],
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<HashMap<usize, Vec<String>>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut paragraphs = HashMap::new();
    let mut paragraph_depth = 0usize;
    let mut paragraph_index = 0usize;
    let mut text_nodes = Vec::new();
    let mut current_text = None::<String>;
    loop {
        check_cancel(cancellation)?;
        match reader.read_event() {
            Ok(Event::Start(event)) if local_name(event.name().as_ref()) == b"p" => {
                paragraph_depth += 1;
                if paragraph_depth == 1 {
                    text_nodes.clear();
                }
            }
            Ok(Event::Start(event))
                if paragraph_depth > 0 && local_name(event.name().as_ref()) == b"t" =>
            {
                current_text = Some(String::new());
            }
            Ok(Event::Text(text)) if current_text.is_some() => {
                let decoded = text.decode().map_err(|error| {
                    DocxRebuildError::rebuild(format!("Cannot decode DOCX text: {error}"))
                })?;
                let unescaped = quick_xml::escape::unescape(&decoded).map_err(|error| {
                    DocxRebuildError::rebuild(format!("Cannot unescape DOCX text: {error}"))
                })?;
                current_text
                    .as_mut()
                    .expect("checked text node")
                    .push_str(&unescaped);
            }
            Ok(Event::End(event)) if local_name(event.name().as_ref()) == b"t" => {
                if let Some(text) = current_text.take() {
                    text_nodes.push(text);
                }
            }
            Ok(Event::End(event)) if local_name(event.name().as_ref()) == b"p" => {
                if paragraph_depth == 1 {
                    paragraphs.insert(paragraph_index, std::mem::take(&mut text_nodes));
                    paragraph_index += 1;
                }
                paragraph_depth = paragraph_depth.saturating_sub(1);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(DocxRebuildError::rebuild(format!(
                    "Cannot parse DOCX XML for rebuilding: {error}"
                )))
            }
        }
    }
    Ok(paragraphs)
}

fn distribute_by_source_weight(text: &str, weights: &[usize]) -> Vec<String> {
    let graphemes = text.graphemes(true).collect::<Vec<_>>();
    let total_weight = weights.iter().sum::<usize>();
    let has_whitespace_boundaries = graphemes
        .iter()
        .any(|grapheme| grapheme.chars().all(char::is_whitespace));
    let mut previous = 0usize;
    let mut cumulative = 0usize;
    weights
        .iter()
        .enumerate()
        .map(|(index, weight)| {
            cumulative += weight;
            let weighted_end = if index + 1 == weights.len() {
                graphemes.len()
            } else {
                graphemes.len() * cumulative / total_weight
            };
            let end = if *weight == 0 || weighted_end <= previous {
                previous
            } else if index + 1 == weights.len() || !has_whitespace_boundaries {
                weighted_end
            } else {
                ((previous + 1)..=graphemes.len())
                    .filter(|candidate| {
                        *candidate == graphemes.len()
                            || graphemes[*candidate - 1].chars().all(char::is_whitespace)
                    })
                    .min_by_key(|candidate| candidate.abs_diff(weighted_end))
                    .unwrap_or(weighted_end)
            };
            let value = graphemes[previous..end].concat();
            previous = end;
            value
        })
        .collect()
}

fn paragraph_outputs_with_cancel(
    xml: &[u8],
    rewrites: &BTreeMap<usize, ParagraphRewrite>,
    plan: &DocxRebuildPlan,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<HashMap<usize, ParagraphOutput>> {
    let nodes = collect_paragraph_text_nodes_with_cancel(xml, cancellation)?;
    let mut outputs = HashMap::new();
    for (paragraph_index, rewrite) in rewrites {
        check_cancel(cancellation)?;
        let text_nodes = nodes.get(paragraph_index).ok_or_else(|| {
            DocxRebuildError::stale(format!(
                "DOCX paragraph {paragraph_index} is missing during rebuild"
            ))
        })?;
        if rewrite.text_start > rewrite.text_end || rewrite.text_end >= text_nodes.len() {
            return Err(DocxRebuildError::stale(format!(
                "DOCX paragraph {paragraph_index} text-node anchors are stale"
            )));
        }
        let translated = rewrite
            .replacements
            .iter()
            .map(|index| plan.replacements[*index].translated_text.as_str())
            .collect::<String>();
        let mut replacements = vec![None; text_nodes.len()];
        let bilingual_translation = match plan.output_mode {
            DocxOutputMode::Translated => {
                let target_nodes = &text_nodes[rewrite.text_start..=rewrite.text_end];
                let weights = target_nodes
                    .iter()
                    .map(|text| text.graphemes(true).count())
                    .collect::<Vec<_>>();
                if weights.iter().sum::<usize>() == 0 {
                    return Err(DocxRebuildError::stale(format!(
                        "DOCX paragraph {paragraph_index} has no anchored text"
                    )));
                }
                for (offset, value) in distribute_by_source_weight(&translated, &weights)
                    .into_iter()
                    .enumerate()
                {
                    replacements[rewrite.text_start + offset] = Some(value);
                }
                None
            }
            DocxOutputMode::Bilingual => Some(translated),
        };
        outputs.insert(
            *paragraph_index,
            ParagraphOutput {
                text_nodes: replacements,
                bilingual_translation,
            },
        );
    }
    Ok(outputs)
}

fn qualified_name(paragraph_name: &[u8], local: &str) -> String {
    let name = String::from_utf8_lossy(paragraph_name);
    name.rsplit_once(':')
        .map(|(prefix, _)| format!("{prefix}:{local}"))
        .unwrap_or_else(|| local.to_string())
}

fn needs_space_preservation(value: &str) -> bool {
    value.starts_with(char::is_whitespace) || value.ends_with(char::is_whitespace)
}

fn has_xml_space(event: &BytesStart<'_>) -> bool {
    event
        .attributes()
        .flatten()
        .any(|attribute| attribute.key.as_ref() == b"xml:space")
}

fn append_bilingual_run(
    writer: &mut Writer<Cursor<Vec<u8>>>,
    paragraph_name: &[u8],
    translated: &str,
) -> RebuildResult<()> {
    let run_name = qualified_name(paragraph_name, "r");
    let break_name = qualified_name(paragraph_name, "br");
    let text_name = qualified_name(paragraph_name, "t");
    writer
        .write_event(Event::Start(BytesStart::new(&run_name)))
        .and_then(|_| writer.write_event(Event::Empty(BytesStart::new(&break_name))))
        .map_err(|error| DocxRebuildError::rebuild(format!("Cannot write DOCX XML: {error}")))?;
    let mut text_start = BytesStart::new(&text_name);
    text_start.push_attribute(("xml:space", "preserve"));
    writer
        .write_event(Event::Start(text_start))
        .and_then(|_| writer.write_event(Event::Text(BytesText::new(translated))))
        .and_then(|_| writer.write_event(Event::End(BytesEnd::new(&text_name))))
        .and_then(|_| writer.write_event(Event::End(BytesEnd::new(&run_name))))
        .map_err(|error| DocxRebuildError::rebuild(format!("Cannot write DOCX XML: {error}")))
}

#[cfg(test)]
fn transform_xml_part(
    xml: &[u8],
    rewrites: &BTreeMap<usize, ParagraphRewrite>,
    plan: &DocxRebuildPlan,
) -> RebuildResult<Vec<u8>> {
    transform_xml_part_with_cancel(xml, rewrites, plan, None)
}

fn transform_xml_part_with_cancel(
    xml: &[u8],
    rewrites: &BTreeMap<usize, ParagraphRewrite>,
    plan: &DocxRebuildPlan,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<Vec<u8>> {
    let outputs = paragraph_outputs_with_cancel(xml, rewrites, plan, cancellation)?;
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut writer = Writer::new(Cursor::new(Vec::with_capacity(xml.len())));
    let mut paragraph_depth = 0usize;
    let mut paragraph_index = 0usize;
    let mut text_node_index = 0usize;
    let mut targeted_text = None::<String>;
    let mut targeted_text_written = false;
    let mut paragraph_name = Vec::new();
    loop {
        check_cancel(cancellation)?;
        match reader.read_event() {
            Ok(Event::Start(event)) if local_name(event.name().as_ref()) == b"p" => {
                paragraph_depth += 1;
                if paragraph_depth == 1 {
                    text_node_index = 0;
                    paragraph_name = event.name().as_ref().to_vec();
                }
                writer.write_event(Event::Start(event)).map_err(|error| {
                    DocxRebuildError::rebuild(format!("Cannot write DOCX XML: {error}"))
                })?;
            }
            Ok(Event::Start(event))
                if paragraph_depth > 0 && local_name(event.name().as_ref()) == b"t" =>
            {
                targeted_text = outputs
                    .get(&paragraph_index)
                    .and_then(|output| output.text_nodes.get(text_node_index))
                    .and_then(Clone::clone);
                targeted_text_written = false;
                let mut start = event.into_owned();
                if targeted_text
                    .as_deref()
                    .is_some_and(needs_space_preservation)
                    && !has_xml_space(&start)
                {
                    start.push_attribute(("xml:space", "preserve"));
                }
                writer.write_event(Event::Start(start)).map_err(|error| {
                    DocxRebuildError::rebuild(format!("Cannot write DOCX XML: {error}"))
                })?;
            }
            Ok(Event::Text(text)) if targeted_text.is_some() => {
                if !targeted_text_written {
                    writer
                        .write_event(Event::Text(BytesText::new(
                            targeted_text.as_deref().unwrap_or_default(),
                        )))
                        .map_err(|error| {
                            DocxRebuildError::rebuild(format!(
                                "Cannot write translated DOCX text: {error}"
                            ))
                        })?;
                    targeted_text_written = true;
                }
                let _ = text;
            }
            Ok(Event::End(event)) if local_name(event.name().as_ref()) == b"t" => {
                if targeted_text.is_some() && !targeted_text_written {
                    writer
                        .write_event(Event::Text(BytesText::new(
                            targeted_text.as_deref().unwrap_or_default(),
                        )))
                        .map_err(|error| {
                            DocxRebuildError::rebuild(format!(
                                "Cannot write translated DOCX text: {error}"
                            ))
                        })?;
                }
                targeted_text = None;
                text_node_index += 1;
                writer.write_event(Event::End(event)).map_err(|error| {
                    DocxRebuildError::rebuild(format!("Cannot write DOCX XML: {error}"))
                })?;
            }
            Ok(Event::End(event)) if local_name(event.name().as_ref()) == b"p" => {
                if paragraph_depth == 1 {
                    if let Some(translated) = outputs
                        .get(&paragraph_index)
                        .and_then(|output| output.bilingual_translation.as_deref())
                    {
                        append_bilingual_run(&mut writer, &paragraph_name, translated)?;
                    }
                    paragraph_index += 1;
                }
                paragraph_depth = paragraph_depth.saturating_sub(1);
                writer.write_event(Event::End(event)).map_err(|error| {
                    DocxRebuildError::rebuild(format!("Cannot write DOCX XML: {error}"))
                })?;
            }
            Ok(Event::Eof) => break,
            Ok(event) => writer.write_event(event).map_err(|error| {
                DocxRebuildError::rebuild(format!("Cannot write DOCX XML: {error}"))
            })?,
            Err(error) => {
                return Err(DocxRebuildError::rebuild(format!(
                    "Cannot parse DOCX XML for rebuilding: {error}"
                )))
            }
        }
    }
    let output = writer.into_inner().into_inner();
    if output.len() > MAX_XML_PART_BYTES {
        return Err(DocxRebuildError::invalid(
            "Rebuilt DOCX XML part exceeds the 16 MiB limit",
        ));
    }
    Ok(output)
}

#[cfg(test)]
fn rebuild_package_in_memory(source: &[u8], plan: &DocxRebuildPlan) -> RebuildResult<Vec<u8>> {
    rebuild_package_in_memory_with_cancel(source, plan, None)
}

fn rebuild_package_in_memory_with_cancel(
    source: &[u8],
    plan: &DocxRebuildPlan,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<Vec<u8>> {
    let rewrite_index = build_rewrite_index_with_cancel(plan, cancellation)?;
    let mut source_archive = ZipArchive::new(Cursor::new(source)).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot reopen DOCX source archive: {error}"))
    })?;
    let mut modified_parts = HashMap::new();
    for (part, rewrites) in &rewrite_index {
        check_cancel(cancellation)?;
        let mut entry = source_archive.by_name(part).map_err(|_| {
            DocxRebuildError::stale(format!("DOCX rebuild part is missing: {part}"))
        })?;
        let mut xml = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut xml).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot read DOCX rebuild part {part}: {error}"))
        })?;
        modified_parts.insert(
            part.clone(),
            transform_xml_part_with_cancel(&xml, rewrites, plan, cancellation)?,
        );
    }

    let target = Cursor::new(Vec::with_capacity(source.len()));
    let mut writer = ZipWriter::new(target);
    for index in 0..source_archive.len() {
        check_cancel(cancellation)?;
        let entry = source_archive.by_index(index).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot read DOCX ZIP entry: {error}"))
        })?;
        if let Some(modified) = modified_parts.get(entry.name()) {
            let name = entry.name().to_string();
            let options = entry.options();
            drop(entry);
            writer.start_file(&name, options).map_err(|error| {
                DocxRebuildError::rebuild(format!("Cannot create DOCX ZIP entry {name}: {error}"))
            })?;
            writer.write_all(modified).map_err(|error| {
                DocxRebuildError::rebuild(format!("Cannot write DOCX ZIP entry {name}: {error}"))
            })?;
        } else {
            writer.raw_copy_file(entry).map_err(|error| {
                DocxRebuildError::rebuild(format!("Cannot preserve DOCX ZIP entry: {error}"))
            })?;
        }
    }
    let output = writer
        .finish()
        .map_err(|error| DocxRebuildError::rebuild(format!("Cannot finish DOCX ZIP: {error}")))?
        .into_inner();
    check_cancel(cancellation)?;
    if output.len() as u64 > MAX_DOCX_BYTES {
        return Err(DocxRebuildError::invalid(
            "Rebuilt DOCX exceeds the 50 MiB package limit",
        ));
    }
    Ok(output)
}

fn prepare_rebuilt_package(
    plan: &DocxRebuildPlan,
) -> RebuildResult<(DocxRebuildValidation, Vec<u8>)> {
    prepare_rebuilt_package_with_cancel(plan, None)
}

fn prepare_rebuilt_package_with_cancel(
    plan: &DocxRebuildPlan,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<(DocxRebuildValidation, Vec<u8>)> {
    let source = read_source_bytes_with_cancel(&plan.source_path, cancellation)?;
    let file_name = Path::new(plan.source_path.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.docx")
        .to_string();
    let inspection = inspect_docx_bytes(&source, file_name.clone()).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot re-inspect DOCX source: {}", error.message))
    })?;
    check_cancel(cancellation)?;
    let mut validation = validate_against_inspection_with_cancel(plan, &inspection, cancellation)?;
    let rebuilt = rebuild_package_in_memory_with_cancel(&source, plan, cancellation)?;
    check_cancel(cancellation)?;
    inspect_docx_bytes(&rebuilt, file_name).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot validate rebuilt DOCX: {}", error.message))
    })?;
    check_cancel(cancellation)?;
    validation.rebuilt_size_bytes = rebuilt.len();
    validation.rebuilt_fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(&rebuilt)));
    Ok((validation, rebuilt))
}

fn validate_pdf_export_against_inspection_with_cancel(
    plan: &PdfDocxExportPlan,
    inspection: &PdfInspection,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<DocxRebuildValidation> {
    check_cancel(cancellation)?;
    validate_output_path(&plan.source_path, &plan.output_path)?;
    if plan.fingerprint != inspection.fingerprint {
        return Err(DocxRebuildError::stale(
            "PDF source fingerprint changed after inspection",
        ));
    }
    if plan.segments.is_empty() || plan.segments.len() > MAX_SEGMENTS {
        return Err(DocxRebuildError::invalid(
            "PDF export segment count is invalid",
        ));
    }
    if plan.segments.len() != inspection.segments.len() {
        return Err(DocxRebuildError::stale(
            "PDF segment count changed after inspection",
        ));
    }

    let mut translated_bytes = 0usize;
    let mut pages = HashSet::new();
    for (order, (segment, inspected)) in plan.segments.iter().zip(&inspection.segments).enumerate()
    {
        check_cancel(cancellation)?;
        if segment.order != order
            || segment.id != inspected.id
            || segment.page != inspected.page
            || segment.source_position != inspected.source_position
            || segment.source_text != inspected.source_text
        {
            return Err(DocxRebuildError::stale(format!(
                "PDF export anchor does not match segment {order}"
            )));
        }
        if segment.page == 0
            || segment.translated_text.trim().is_empty()
            || segment.translated_text.len() > MAX_SEGMENT_BYTES
            || !contains_only_xml_characters(&segment.source_text)
            || !contains_only_xml_characters(&segment.translated_text)
        {
            return Err(DocxRebuildError::invalid(format!(
                "PDF export segment {order} is invalid"
            )));
        }
        translated_bytes = translated_bytes
            .checked_add(segment.translated_text.len())
            .ok_or_else(|| DocxRebuildError::invalid("PDF translation size is invalid"))?;
        if translated_bytes > MAX_TRANSLATED_BYTES {
            return Err(DocxRebuildError::invalid(
                "PDF translated text exceeds the 24 MiB limit",
            ));
        }
        pages.insert(segment.page);
    }

    Ok(DocxRebuildValidation {
        replacement_count: plan.segments.len(),
        part_count: pages.len(),
        translated_bytes,
        rebuilt_size_bytes: 0,
        rebuilt_fingerprint: String::new(),
    })
}

fn append_generated_paragraph(xml: &mut String, text: &str) {
    use quick_xml::escape::escape;
    xml.push_str("<w:p><w:r><w:t xml:space=\"preserve\">");
    xml.push_str(&escape(text));
    xml.push_str("</w:t></w:r></w:p>");
}

fn build_pdf_export_package_with_cancel(
    plan: &PdfDocxExportPlan,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<Vec<u8>> {
    use zip::write::SimpleFileOptions;

    let mut document_xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
    );
    let mut previous_page = None;
    for segment in &plan.segments {
        check_cancel(cancellation)?;
        if previous_page.is_some_and(|page| page != segment.page) {
            document_xml.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
        }
        if plan.output_mode == DocxOutputMode::Bilingual {
            append_generated_paragraph(&mut document_xml, &segment.source_text);
        }
        append_generated_paragraph(&mut document_xml, &segment.translated_text);
        previous_page = Some(segment.page);
        if document_xml.len() > MAX_XML_PART_BYTES {
            return Err(DocxRebuildError::invalid(
                "Generated DOCX XML exceeds the 16 MiB limit",
            ));
        }
    }
    document_xml.push_str(
        r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#,
    );

    let target = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(target);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdOffice" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        ("word/document.xml", document_xml.as_str()),
    ] {
        check_cancel(cancellation)?;
        writer.start_file(name, options).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot create generated DOCX entry: {error}"))
        })?;
        writer.write_all(content.as_bytes()).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot write generated DOCX entry: {error}"))
        })?;
    }
    let output = writer
        .finish()
        .map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot finish generated DOCX: {error}"))
        })?
        .into_inner();
    check_cancel(cancellation)?;
    if output.len() as u64 > MAX_DOCX_BYTES {
        return Err(DocxRebuildError::invalid(
            "Generated DOCX exceeds the 50 MiB package limit",
        ));
    }
    Ok(output)
}

fn prepare_pdf_export_with_cancel(
    plan: &PdfDocxExportPlan,
    cancellation: Option<&RebuildCancellation>,
) -> RebuildResult<(DocxRebuildValidation, Vec<u8>)> {
    let inspection = inspect_pdf_document(plan.source_path.clone()).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot re-inspect PDF source: {}", error.message))
    })?;
    let mut validation =
        validate_pdf_export_against_inspection_with_cancel(plan, &inspection, cancellation)?;
    let output = build_pdf_export_package_with_cancel(plan, cancellation)?;
    inspect_docx_bytes(&output, "translated.docx".to_string()).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot validate generated DOCX: {}", error.message))
    })?;
    check_cancel(cancellation)?;
    validation.rebuilt_size_bytes = output.len();
    validation.rebuilt_fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(&output)));
    Ok((validation, output))
}

fn safe_output_file_name(output: &Path) -> RebuildResult<&str> {
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            DocxRebuildError::invalid("DOCX output must have a valid Unicode file name")
        })?;
    if name.contains(':') || name.ends_with([' ', '.']) {
        return Err(DocxRebuildError::invalid(
            "DOCX output file name is unsafe on Windows",
        ));
    }
    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device
            .strip_prefix("COM")
            .or_else(|| device.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'));
    if reserved {
        return Err(DocxRebuildError::invalid(
            "DOCX output uses a reserved Windows device name",
        ));
    }
    Ok(name)
}

fn canonical_output_destination(
    source_path: &str,
    requested: &Path,
) -> RebuildResult<(PathBuf, PathBuf)> {
    let requested_text = requested
        .to_str()
        .ok_or_else(|| DocxRebuildError::invalid("DOCX output path must be valid Unicode"))?;
    validate_output_path(source_path, requested_text)?;
    let file_name = safe_output_file_name(requested)?;
    let parent = requested.parent().ok_or_else(|| {
        DocxRebuildError::invalid("DOCX output must have an existing parent directory")
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        DocxRebuildError::invalid(format!("Cannot resolve DOCX output directory: {error}"))
    })?;
    if !canonical_parent.is_dir() {
        return Err(DocxRebuildError::invalid(
            "DOCX output parent must be a directory",
        ));
    }
    let output = canonical_parent.join(file_name);
    match fs::symlink_metadata(&output) {
        Ok(_) => {
            return Err(DocxRebuildError::invalid(
                "DOCX output already exists; choose a new file name",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(DocxRebuildError::rebuild(format!(
                "Cannot inspect DOCX output path: {error}"
            )))
        }
    }
    let source = fs::canonicalize(source_path.trim()).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot resolve DOCX source path: {error}"))
    })?;
    if normalized_windows_path(&source.to_string_lossy())
        == normalized_windows_path(&output.to_string_lossy())
    {
        return Err(DocxRebuildError::invalid(
            "DOCX output must not resolve to its source",
        ));
    }
    Ok((canonical_parent, output))
}

fn canonical_output_path(plan: &DocxRebuildPlan) -> RebuildResult<(PathBuf, PathBuf)> {
    canonical_output_destination(&plan.source_path, Path::new(plan.output_path.trim()))
}

fn suggested_docx_file_name(value: String) -> RebuildResult<String> {
    let value = value.trim();
    let path = Path::new(value);
    if value.is_empty()
        || path.file_name().and_then(|name| name.to_str()) != Some(value)
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("docx"))
    {
        return Err(DocxRebuildError::invalid(
            "Suggested DOCX output must be a safe .docx file name",
        ));
    }
    safe_output_file_name(path)?;
    Ok(value.to_string())
}

#[tauri::command]
pub fn pick_docx_output(
    app: AppHandle,
    source_path: String,
    suggested_file_name: String,
    title: String,
    filter_name: String,
) -> RebuildResult<Option<String>> {
    let suggested_file_name = suggested_docx_file_name(suggested_file_name)?;
    let title = dialog_label(title, "Choose a DOCX output");
    let filter_name = dialog_label(filter_name, "Word document (*.docx)");
    let selected = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(filter_name, &["docx"])
        .set_file_name(suggested_file_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected =
        local_dialog_path(selected).map_err(|error| DocxRebuildError::invalid(error.message))?;
    let (_, output) = canonical_output_destination(&source_path, &selected)?;
    Ok(Some(display_path(&output)))
}

fn publish_without_overwrite(temp: &Path, output: &Path) -> std::io::Result<()> {
    fs::hard_link(temp, output)?;
    if let Err(error) = fs::remove_file(temp) {
        let _ = fs::remove_file(output);
        return Err(error);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublishFaultPoint {
    CreateTemp,
    WriteTemp,
    SyncTemp,
    PublishAtomically,
}

fn publish_rebuilt_package_with_cancel(
    plan: &DocxRebuildPlan,
    validation: &DocxRebuildValidation,
    rebuilt: &[u8],
    cancellation: &RebuildCancellation,
) -> RebuildResult<DocxRebuildResult> {
    publish_rebuilt_package_with_faults(plan, validation, rebuilt, cancellation, |_, _, _| Ok(()))
}

fn publish_rebuilt_package_with_faults<F>(
    plan: &DocxRebuildPlan,
    validation: &DocxRebuildValidation,
    rebuilt: &[u8],
    cancellation: &RebuildCancellation,
    mut check_fault: F,
) -> RebuildResult<DocxRebuildResult>
where
    F: FnMut(PublishFaultPoint, &Path, &Path) -> std::io::Result<()>,
{
    cancellation.check()?;
    let (canonical_parent, output) = canonical_output_path(plan)?;
    let temp = canonical_parent.join(format!(".long-translate-{}.docx.tmp", uuid::Uuid::new_v4()));
    let mut guard = TempFileGuard::new(temp.clone());
    check_fault(PublishFaultPoint::CreateTemp, &temp, &output).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot create DOCX temporary file: {error}"))
    })?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot create DOCX temporary file: {error}"))
        })?;
    check_fault(PublishFaultPoint::WriteTemp, &temp, &output).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot write DOCX temporary file: {error}"))
    })?;
    for chunk in rebuilt.chunks(64 * 1024) {
        cancellation.check()?;
        file.write_all(chunk).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot write DOCX temporary file: {error}"))
        })?;
    }
    cancellation.check()?;
    check_fault(PublishFaultPoint::SyncTemp, &temp, &output).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot sync DOCX temporary file: {error}"))
    })?;
    file.sync_all().map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot sync DOCX temporary file: {error}"))
    })?;
    drop(file);

    let persisted = read_source_bytes_with_cancel(&temp.to_string_lossy(), Some(cancellation))?;
    if persisted != rebuilt {
        return Err(DocxRebuildError::rebuild(
            "DOCX temporary file verification failed",
        ));
    }
    inspect_docx_bytes(&persisted, "translated.docx".to_string()).map_err(|error| {
        DocxRebuildError::rebuild(format!(
            "Cannot validate DOCX temporary file: {}",
            error.message
        ))
    })?;
    cancellation.check()?;

    let output_parent = output.parent().ok_or_else(|| {
        DocxRebuildError::rebuild("Canonical DOCX output has no parent directory")
    })?;
    let current_parent = fs::canonicalize(output_parent).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot recheck DOCX output directory: {error}"))
    })?;
    if normalized_windows_path(&current_parent.to_string_lossy())
        != normalized_windows_path(&canonical_parent.to_string_lossy())
    {
        return Err(DocxRebuildError::rebuild(
            "DOCX output directory changed during publication",
        ));
    }
    check_fault(PublishFaultPoint::PublishAtomically, &temp, &output).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot publish DOCX temporary file: {error}"))
    })?;
    cancellation.begin_publish()?;
    publish_without_overwrite(&temp, &output).map_err(|error| {
        DocxRebuildError::rebuild(format!(
            "Cannot publish DOCX without overwriting an existing file: {error}"
        ))
    })?;
    guard.disarm();
    cancellation.complete();
    Ok(DocxRebuildResult {
        output_path: display_path(&output),
        replacement_count: validation.replacement_count,
        size_bytes: validation.rebuilt_size_bytes,
        fingerprint: validation.rebuilt_fingerprint.clone(),
    })
}

#[tauri::command]
pub fn validate_docx_rebuild_plan(plan: DocxRebuildPlan) -> RebuildResult<DocxRebuildValidation> {
    prepare_rebuilt_package(&plan).map(|(validation, _)| validation)
}

#[tauri::command]
pub fn validate_pdf_docx_export_plan(
    plan: PdfDocxExportPlan,
) -> RebuildResult<DocxRebuildValidation> {
    prepare_pdf_export_with_cancel(&plan, None).map(|(validation, _)| validation)
}

#[tauri::command]
pub async fn rebuild_docx_document(
    job_id: String,
    plan: DocxRebuildPlan,
) -> RebuildResult<DocxRebuildResult> {
    let registration = RebuildRegistration::register(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cancellation = Arc::clone(&registration.cancellation);
        let (validation, rebuilt) =
            prepare_rebuilt_package_with_cancel(&plan, Some(&cancellation))?;
        publish_rebuilt_package_with_cancel(&plan, &validation, &rebuilt, &cancellation)
    })
    .await
    .map_err(|_| DocxRebuildError::rebuild("DOCX rebuild worker stopped unexpectedly"))?
}

#[tauri::command]
pub async fn export_pdf_translation_docx(
    job_id: String,
    plan: PdfDocxExportPlan,
) -> RebuildResult<DocxRebuildResult> {
    let registration = RebuildRegistration::register(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cancellation = Arc::clone(&registration.cancellation);
        let (validation, output) = prepare_pdf_export_with_cancel(&plan, Some(&cancellation))?;
        let publish_plan = DocxRebuildPlan {
            source_path: plan.source_path,
            output_path: plan.output_path,
            fingerprint: plan.fingerprint,
            output_mode: plan.output_mode,
            replacements: Vec::new(),
        };
        publish_rebuilt_package_with_cancel(&publish_plan, &validation, &output, &cancellation)
    })
    .await
    .map_err(|_| DocxRebuildError::rebuild("PDF DOCX export worker stopped unexpectedly"))?
}

#[tauri::command]
pub fn cancel_docx_rebuild(job_id: String) -> RebuildResult<bool> {
    cancel_rebuild_job(&job_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{inspect_docx_path, DocxImportWarning, DocxSegment};
    use crate::pdf_document::PdfSegment;
    use zip::write::SimpleFileOptions;

    const DOCUMENT_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo</w:t></w:r></w:p></w:body></w:document>"#;
    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    const PACKAGE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdOffice" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

    fn pdf_inspection() -> PdfInspection {
        PdfInspection {
            fingerprint: "sha256:pdf-fixture".to_string(),
            file_name: "fixture.pdf".to_string(),
            size_bytes: 1024,
            page_count: 2,
            warnings: Vec::new(),
            segments: vec![
                PdfSegment {
                    id: "pdf:1:0".to_string(),
                    order: 0,
                    page: 1,
                    source_position: "page:1:line:0".to_string(),
                    structure: "paragraph".to_string(),
                    source_text: "Hello & world".to_string(),
                },
                PdfSegment {
                    id: "pdf:2:0".to_string(),
                    order: 1,
                    page: 2,
                    source_position: "page:2:line:0".to_string(),
                    structure: "paragraph".to_string(),
                    source_text: "Second <page>".to_string(),
                },
            ],
        }
    }

    fn pdf_export_plan(mode: DocxOutputMode) -> PdfDocxExportPlan {
        PdfDocxExportPlan {
            source_path: r"C:\docs\fixture.pdf".to_string(),
            output_path: r"C:\docs\fixture-translated.docx".to_string(),
            fingerprint: "sha256:pdf-fixture".to_string(),
            output_mode: mode,
            segments: vec![
                PdfDocxExportSegment {
                    id: "pdf:1:0".to_string(),
                    order: 0,
                    page: 1,
                    source_position: "page:1:line:0".to_string(),
                    source_text: "Hello & world".to_string(),
                    translated_text: "你好 & 世界".to_string(),
                },
                PdfDocxExportSegment {
                    id: "pdf:2:0".to_string(),
                    order: 1,
                    page: 2,
                    source_position: "page:2:line:0".to_string(),
                    source_text: "Second <page>".to_string(),
                    translated_text: "第二 <页>".to_string(),
                },
            ],
        }
    }

    fn inspection() -> DocxInspection {
        DocxInspection {
            fingerprint: "sha256:fixture".to_string(),
            file_name: "input.docx".to_string(),
            size_bytes: 1024,
            segments: vec![DocxSegment {
                id: "segment-1".to_string(),
                order: 0,
                part: "word/document.xml".to_string(),
                source_position: "paragraph:0:chunk:0:bytes:0-5:runs:0-1:texts:0-1".to_string(),
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
                source_position: "paragraph:0:chunk:0:bytes:0-5:runs:0-1:texts:0-1".to_string(),
                structure: "paragraph".to_string(),
                source_text: "Hello".to_string(),
                translated_text: "你好".to_string(),
            }],
        }
    }

    fn rebuild_for_test(plan: &DocxRebuildPlan) -> RebuildResult<DocxRebuildResult> {
        let cancellation = RebuildCancellation::new();
        let (validation, rebuilt) = prepare_rebuilt_package_with_cancel(plan, Some(&cancellation))?;
        publish_rebuilt_package_with_cancel(plan, &validation, &rebuilt, &cancellation)
    }

    #[test]
    fn generates_valid_translated_and_bilingual_docx_from_pdf_segments() {
        let inspection = pdf_inspection();
        for (mode, expected_segments) in [
            (DocxOutputMode::Translated, 2usize),
            (DocxOutputMode::Bilingual, 4usize),
        ] {
            let plan = pdf_export_plan(mode);
            let validation =
                validate_pdf_export_against_inspection_with_cancel(&plan, &inspection, None)
                    .unwrap();
            assert_eq!(validation.replacement_count, 2);
            assert_eq!(validation.part_count, 2);
            let output = build_pdf_export_package_with_cancel(&plan, None).unwrap();
            let mut archive = ZipArchive::new(Cursor::new(&output)).unwrap();
            let mut document_xml = String::new();
            archive
                .by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut document_xml)
                .unwrap();
            assert!(document_xml.contains("<w:pgSz w:w=\"11906\" w:h=\"16838\"/>"));
            assert!(document_xml.contains("<w:pgMar w:top=\"1440\""));
            let reopened = inspect_docx_bytes(&output, "generated.docx".to_string()).unwrap();
            assert_eq!(reopened.segments.len(), expected_segments);
            let text = reopened
                .segments
                .iter()
                .map(|segment| segment.source_text.as_str())
                .collect::<Vec<_>>();
            assert!(text.contains(&"你好 & 世界"));
            assert!(text.contains(&"第二 <页>"));
            if mode == DocxOutputMode::Bilingual {
                assert!(text.contains(&"Hello & world"));
                assert!(text.contains(&"Second <page>"));
            }
        }
    }

    #[test]
    fn rejects_stale_or_unsafe_pdf_export_segments() {
        let inspection = pdf_inspection();
        let mut stale = pdf_export_plan(DocxOutputMode::Translated);
        stale.segments[0].source_position = "page:1:line:99".to_string();
        assert_eq!(
            validate_pdf_export_against_inspection_with_cancel(&stale, &inspection, None)
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::StaleSource
        );

        let mut unsafe_text = pdf_export_plan(DocxOutputMode::Translated);
        unsafe_text.segments[0].translated_text = "bad\u{0001}text".to_string();
        assert_eq!(
            validate_pdf_export_against_inspection_with_cancel(&unsafe_text, &inspection, None)
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::InvalidPlan
        );
    }

    #[test]
    #[ignore = "requires the explicitly downloaded public PDF acceptance corpus"]
    fn exports_real_public_pdf_to_both_docx_modes_without_changing_source() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".pdf-acceptance")
            .join("resource-hub.pdf");
        let source_before = fs::read(&source).unwrap();
        let inspection = inspect_pdf_document(source.to_string_lossy().into_owned()).unwrap();
        let retained_output_directory = std::env::var_os("LONG_TRANSLATE_PDF_DOCX_OUTPUT_DIR");
        let directory = retained_output_directory
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir().join(format!("pdf-docx-real-export-{}", uuid::Uuid::new_v4()))
            });
        fs::create_dir_all(&directory).unwrap();

        for mode in [DocxOutputMode::Translated, DocxOutputMode::Bilingual] {
            let suffix = if mode == DocxOutputMode::Translated {
                "translated"
            } else {
                "bilingual"
            };
            let output_path = directory.join(format!("resource-hub-{suffix}.docx"));
            let plan = PdfDocxExportPlan {
                source_path: source.to_string_lossy().into_owned(),
                output_path: output_path.to_string_lossy().into_owned(),
                fingerprint: inspection.fingerprint.clone(),
                output_mode: mode,
                segments: inspection
                    .segments
                    .iter()
                    .map(|segment| PdfDocxExportSegment {
                        id: segment.id.clone(),
                        order: segment.order,
                        page: segment.page,
                        source_position: segment.source_position.clone(),
                        source_text: segment.source_text.clone(),
                        translated_text: format!("验收译文 {}", segment.order + 1),
                    })
                    .collect(),
            };
            let cancellation = RebuildCancellation::new();
            let (validation, output) =
                prepare_pdf_export_with_cancel(&plan, Some(&cancellation)).unwrap();
            let publish_plan = DocxRebuildPlan {
                source_path: plan.source_path.clone(),
                output_path: plan.output_path.clone(),
                fingerprint: plan.fingerprint.clone(),
                output_mode: plan.output_mode,
                replacements: Vec::new(),
            };
            let result = publish_rebuilt_package_with_cancel(
                &publish_plan,
                &validation,
                &output,
                &cancellation,
            )
            .unwrap();
            assert_eq!(result.replacement_count, 4);
            let reopened = inspect_docx_path(&output_path).unwrap();
            assert_eq!(
                reopened.segments.len(),
                if mode == DocxOutputMode::Translated {
                    4
                } else {
                    8
                }
            );
        }

        assert_eq!(fs::read(&source).unwrap(), source_before);
        if retained_output_directory.is_none() {
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn output_picker_contract_rejects_overwrite_and_existing_targets() {
        let directory = std::env::temp_dir().join(format!(
            "long-translate-output-picker-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("source.docx");
        let output = directory.join("translated.docx");
        std::fs::write(&source, b"source").unwrap();

        let (canonical_parent, validated) =
            canonical_output_destination(source.to_str().unwrap(), &output).unwrap();
        assert_eq!(canonical_parent, std::fs::canonicalize(&directory).unwrap());
        assert_eq!(validated, canonical_parent.join("translated.docx"));
        assert_eq!(
            canonical_output_destination(source.to_str().unwrap(), &source)
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::InvalidPlan
        );

        std::fs::write(&output, b"existing").unwrap();
        assert_eq!(
            canonical_output_destination(source.to_str().unwrap(), &output)
                .unwrap_err()
                .code,
            DocxRebuildErrorCode::InvalidPlan
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn output_picker_contract_accepts_only_safe_docx_file_names() {
        assert_eq!(
            suggested_docx_file_name(" translated.docx ".to_string()).unwrap(),
            "translated.docx"
        );
        for unsafe_name in ["", "translated.pdf", "folder/translated.docx", "CON.docx"] {
            assert_eq!(
                suggested_docx_file_name(unsafe_name.to_string())
                    .unwrap_err()
                    .code,
                DocxRebuildErrorCode::InvalidPlan
            );
        }
    }

    fn fixture_package() -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut output);
            let options = SimpleFileOptions::default();
            for (name, bytes) in [
                ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
                ("_rels/.rels", PACKAGE_RELS.as_bytes()),
                ("word/document.xml", DOCUMENT_XML.as_bytes()),
                ("word/media/image.bin", b"unchanged-media".as_slice()),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        output.into_inner()
    }

    const ROUNDTRIP_CORPUS: [(&str, &[u8]); 5] = [
        (
            "heading-hyperlink",
            include_bytes!("../tests/fixtures/docx/roundtrip/01-heading-hyperlink.docx"),
        ),
        (
            "lists",
            include_bytes!("../tests/fixtures/docx/roundtrip/02-lists.docx"),
        ),
        (
            "tables",
            include_bytes!("../tests/fixtures/docx/roundtrip/03-tables.docx"),
        ),
        (
            "sections",
            include_bytes!("../tests/fixtures/docx/roundtrip/04-sections.docx"),
        ),
        (
            "unicode-resources",
            include_bytes!("../tests/fixtures/docx/roundtrip/05-unicode-resources.docx"),
        ),
    ];

    fn package_entries(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut entries = HashMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let mut payload = Vec::new();
            entry.read_to_end(&mut payload).unwrap();
            entries.insert(entry.name().to_string(), payload);
        }
        entries
    }

    fn fixture_plan_for_paths(
        source: &Path,
        output: &Path,
        source_bytes: &[u8],
    ) -> DocxRebuildPlan {
        let inspection = inspect_docx_bytes(source_bytes, "source.docx".to_string()).unwrap();
        let segment = &inspection.segments[0];
        DocxRebuildPlan {
            source_path: source.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            fingerprint: inspection.fingerprint,
            output_mode: DocxOutputMode::Translated,
            replacements: vec![DocxRebuildReplacement {
                id: segment.id.clone(),
                order: segment.order,
                part: segment.part.clone(),
                source_position: segment.source_position.clone(),
                structure: segment.structure.clone(),
                source_text: segment.source_text.clone(),
                translated_text: "你好 & <世界> 👩‍💻".to_string(),
            }],
        }
    }

    struct PublishFailureFixture {
        source_bytes: Vec<u8>,
        directory: PathBuf,
        source_path: PathBuf,
        output_path: PathBuf,
        plan: DocxRebuildPlan,
        validation: DocxRebuildValidation,
        rebuilt: Vec<u8>,
        cancellation: RebuildCancellation,
    }

    impl PublishFailureFixture {
        fn new(label: &str) -> Self {
            let source_bytes = fixture_package();
            let directory =
                std::env::temp_dir().join(format!("docx-publish-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let source_path = directory.join("source.docx");
            let output_path = directory.join("translated.docx");
            std::fs::write(&source_path, &source_bytes).unwrap();
            let plan = fixture_plan_for_paths(&source_path, &output_path, &source_bytes);
            let cancellation = RebuildCancellation::new();
            let (validation, rebuilt) =
                prepare_rebuilt_package_with_cancel(&plan, Some(&cancellation)).unwrap();
            Self {
                source_bytes,
                directory,
                source_path,
                output_path,
                plan,
                validation,
                rebuilt,
                cancellation,
            }
        }

        fn publish_with<F>(&self, check_fault: F) -> RebuildResult<DocxRebuildResult>
        where
            F: FnMut(PublishFaultPoint, &Path, &Path) -> std::io::Result<()>,
        {
            publish_rebuilt_package_with_faults(
                &self.plan,
                &self.validation,
                &self.rebuilt,
                &self.cancellation,
                check_fault,
            )
        }

        fn assert_source_unchanged_and_no_temp(&self) {
            assert_eq!(std::fs::read(&self.source_path).unwrap(), self.source_bytes);
            assert!(std::fs::read_dir(&self.directory).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".long-translate-")
            }));
        }
    }

    impl Drop for PublishFailureFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
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
                rebuilt_size_bytes: 0,
                rebuilt_fingerprint: String::new(),
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

    #[test]
    fn rewrites_anchored_text_nodes_and_preserves_run_boundaries() {
        let plan = plan();
        let index = build_rewrite_index(&plan).unwrap();
        let rebuilt = transform_xml_part(
            DOCUMENT_XML.as_bytes(),
            index.get("word/document.xml").unwrap(),
            &plan,
        )
        .unwrap();
        let nodes = collect_paragraph_text_nodes(&rebuilt).unwrap();
        assert_eq!(
            nodes.get(&0).unwrap(),
            &vec!["你".to_string(), "好".to_string()]
        );
    }

    #[test]
    fn translated_latin_words_are_not_split_across_run_boundaries() {
        let distributed = distribute_by_source_weight("Validation translation 3.11", &[2, 8, 5]);

        assert_eq!(
            distributed,
            vec![
                "Validation ".to_string(),
                "translation ".to_string(),
                "3.11".to_string()
            ]
        );
        assert_eq!(distributed.concat(), "Validation translation 3.11");
    }

    #[test]
    fn word_boundary_distribution_remains_monotonic_with_many_runs() {
        let distributed = distribute_by_source_weight("one two", &[1, 1, 1, 1, 1, 1, 1, 1]);

        assert_eq!(distributed.concat(), "one two");
        assert_eq!(distributed.len(), 8);
    }

    #[test]
    fn bilingual_mode_keeps_source_and_appends_a_hard_break_run() {
        let mut plan = plan();
        plan.output_mode = DocxOutputMode::Bilingual;
        let index = build_rewrite_index(&plan).unwrap();
        let rebuilt = transform_xml_part(
            DOCUMENT_XML.as_bytes(),
            index.get("word/document.xml").unwrap(),
            &plan,
        )
        .unwrap();
        let nodes = collect_paragraph_text_nodes(&rebuilt).unwrap();
        assert_eq!(
            nodes.get(&0).unwrap(),
            &vec!["Hel".to_string(), "lo".to_string(), "你好".to_string()]
        );
        assert!(String::from_utf8(rebuilt).unwrap().contains("<w:br/>"));
    }

    #[test]
    fn rebuilds_in_memory_and_preserves_unmodified_zip_entries() {
        let source = fixture_package();
        let rebuilt = rebuild_package_in_memory(&source, &plan()).unwrap();
        inspect_docx_bytes(&rebuilt, "translated.docx".to_string()).unwrap();

        let mut source_archive = ZipArchive::new(Cursor::new(source)).unwrap();
        let mut rebuilt_archive = ZipArchive::new(Cursor::new(rebuilt)).unwrap();
        let source_media = source_archive.by_name("word/media/image.bin").unwrap();
        let source_crc = source_media.crc32();
        let source_compressed_size = source_media.compressed_size();
        drop(source_media);
        let rebuilt_media = rebuilt_archive.by_name("word/media/image.bin").unwrap();
        assert_eq!(rebuilt_media.crc32(), source_crc);
        assert_eq!(rebuilt_media.compressed_size(), source_compressed_size);
    }

    #[test]
    fn rejects_xml_control_characters_before_transforming() {
        let mut plan = plan();
        plan.replacements[0].translated_text = "unsafe\u{1}".to_string();
        assert_eq!(
            build_rewrite_index(&plan).unwrap_err().code,
            DocxRebuildErrorCode::InvalidPlan
        );
    }

    #[test]
    fn command_rebuilds_and_reopens_in_memory_without_writing_a_target() {
        let source_bytes = fixture_package();
        let directory = std::env::temp_dir().join(format!("docx-rebuild-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source_path = directory.join("source.docx");
        let output_path = directory.join("translated.docx");
        std::fs::write(&source_path, &source_bytes).unwrap();
        let plan = fixture_plan_for_paths(&source_path, &output_path, &source_bytes);

        let validation = validate_docx_rebuild_plan(plan).unwrap();
        assert!(validation.rebuilt_size_bytes > 0);
        assert!(validation.rebuilt_fingerprint.starts_with("sha256:"));
        assert!(!output_path.exists());
        assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);

        std::fs::remove_file(source_path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn publishes_once_without_overwriting_or_leaving_temporary_files() {
        let source_bytes = fixture_package();
        let directory = std::env::temp_dir().join(format!("docx-publish-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source_path = directory.join("source.docx");
        let output_path = directory.join("translated.docx");
        std::fs::write(&source_path, &source_bytes).unwrap();
        let plan = fixture_plan_for_paths(&source_path, &output_path, &source_bytes);

        let result = rebuild_for_test(&plan).unwrap();
        let published = std::fs::read(&output_path).unwrap();
        inspect_docx_bytes(&published, "translated.docx".to_string()).unwrap();
        assert_eq!(
            result.output_path,
            display_path(&std::fs::canonicalize(&output_path).unwrap())
        );
        assert_eq!(result.size_bytes, published.len());
        assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);
        assert!(std::fs::read_dir(&directory).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".long-translate-")
        }));

        assert_eq!(
            rebuild_for_test(&plan).unwrap_err().code,
            DocxRebuildErrorCode::InvalidPlan
        );
        assert_eq!(std::fs::read(&output_path).unwrap(), published);

        std::fs::remove_file(output_path).unwrap();
        std::fs::remove_file(source_path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn permission_denied_before_temp_creation_preserves_the_source() {
        let fixture = PublishFailureFixture::new("permission-denied");
        let error = fixture
            .publish_with(|point, _, _| {
                if point == PublishFaultPoint::CreateTemp {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "simulated permission denial",
                    ))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();

        assert_eq!(error.code, DocxRebuildErrorCode::RebuildFailed);
        assert!(!fixture.output_path.exists());
        fixture.assert_source_unchanged_and_no_temp();
    }

    #[test]
    fn disk_write_failure_removes_the_temporary_file() {
        let fixture = PublishFailureFixture::new("disk-write-failure");
        let error = fixture
            .publish_with(|point, _, _| {
                if point == PublishFaultPoint::WriteTemp {
                    Err(std::io::Error::other("simulated disk full"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();

        assert_eq!(error.code, DocxRebuildErrorCode::RebuildFailed);
        assert!(!fixture.output_path.exists());
        fixture.assert_source_unchanged_and_no_temp();
    }

    #[test]
    fn sync_failure_removes_the_temporary_file() {
        let fixture = PublishFailureFixture::new("sync-failure");
        let error = fixture
            .publish_with(|point, _, _| {
                if point == PublishFaultPoint::SyncTemp {
                    Err(std::io::Error::other("simulated sync failure"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();

        assert_eq!(error.code, DocxRebuildErrorCode::RebuildFailed);
        assert!(!fixture.output_path.exists());
        fixture.assert_source_unchanged_and_no_temp();
    }

    #[test]
    fn target_created_at_commit_is_never_overwritten() {
        const COMPETING_CONTENT: &[u8] = b"created by a competing writer";
        let fixture = PublishFailureFixture::new("target-race");
        let error = fixture
            .publish_with(|point, _, output| {
                if point == PublishFaultPoint::PublishAtomically {
                    std::fs::write(output, COMPETING_CONTENT)?;
                }
                Ok(())
            })
            .unwrap_err();

        assert_eq!(error.code, DocxRebuildErrorCode::RebuildFailed);
        assert_eq!(
            std::fs::read(&fixture.output_path).unwrap(),
            COMPETING_CONTENT
        );
        fixture.assert_source_unchanged_and_no_temp();
    }

    #[test]
    fn round_trips_the_synthetic_compatibility_corpus_in_both_output_modes() {
        let keep_outputs =
            std::env::var("LONG_TRANSLATE_KEEP_DOCX_CORPUS").is_ok_and(|value| value == "1");
        let directory =
            std::env::temp_dir().join(format!("docx-roundtrip-corpus-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut structures = HashSet::new();
        let mut warning_codes = HashSet::new();

        for (fixture_name, source_bytes) in ROUNDTRIP_CORPUS {
            let source_path = directory.join(format!("{fixture_name}.docx"));
            std::fs::write(&source_path, source_bytes).unwrap();
            let inspection = inspect_docx_path(&source_path).unwrap();
            assert!(!inspection.segments.is_empty(), "{fixture_name}");
            structures.extend(
                inspection
                    .segments
                    .iter()
                    .map(|segment| segment.structure.clone()),
            );
            warning_codes.extend(
                inspection
                    .warnings
                    .iter()
                    .map(|warning| warning.code.clone()),
            );
            let rewritten_parts = inspection
                .segments
                .iter()
                .map(|segment| segment.part.clone())
                .collect::<HashSet<_>>();
            let source_entries = package_entries(source_bytes);

            for output_mode in [DocxOutputMode::Translated, DocxOutputMode::Bilingual] {
                let mode_name = match output_mode {
                    DocxOutputMode::Translated => "translated",
                    DocxOutputMode::Bilingual => "bilingual",
                };
                let output_path = directory.join(format!("{fixture_name}-{mode_name}.docx"));
                let translations = inspection
                    .segments
                    .iter()
                    .enumerate()
                    .map(|(index, _)| format!("Synthetic translation {}", index + 1))
                    .collect::<Vec<_>>();
                let plan = DocxRebuildPlan {
                    source_path: source_path.to_string_lossy().into_owned(),
                    output_path: output_path.to_string_lossy().into_owned(),
                    fingerprint: inspection.fingerprint.clone(),
                    output_mode,
                    replacements: inspection
                        .segments
                        .iter()
                        .zip(&translations)
                        .map(|(segment, translated_text)| DocxRebuildReplacement {
                            id: segment.id.clone(),
                            order: segment.order,
                            part: segment.part.clone(),
                            source_position: segment.source_position.clone(),
                            structure: segment.structure.clone(),
                            source_text: segment.source_text.clone(),
                            translated_text: translated_text.clone(),
                        })
                        .collect(),
                };

                let result = rebuild_for_test(&plan).unwrap();
                assert_eq!(result.replacement_count, inspection.segments.len());
                let reopened = inspect_docx_path(&output_path).unwrap();
                assert_eq!(reopened.segments.len(), inspection.segments.len());
                for (((source, rebuilt), translation), order) in inspection
                    .segments
                    .iter()
                    .zip(&reopened.segments)
                    .zip(&translations)
                    .zip(0..)
                {
                    assert_eq!(rebuilt.order, order);
                    assert_eq!(rebuilt.part, source.part);
                    assert_eq!(rebuilt.structure, source.structure);
                    match output_mode {
                        DocxOutputMode::Translated => {
                            assert_eq!(
                                rebuilt.source_text.trim_end_matches(['\r', '\n']),
                                translation
                            )
                        }
                        DocxOutputMode::Bilingual => {
                            assert!(rebuilt.source_text.contains(&source.source_text));
                            assert!(rebuilt.source_text.contains(translation));
                        }
                    }
                }

                let output_bytes = std::fs::read(&output_path).unwrap();
                let output_entries = package_entries(&output_bytes);
                assert_eq!(output_entries.len(), source_entries.len());
                for (name, payload) in &source_entries {
                    if !rewritten_parts.contains(name) {
                        assert_eq!(
                            output_entries.get(name),
                            Some(payload),
                            "{fixture_name}:{name}"
                        );
                    }
                }
                assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);
                if !keep_outputs {
                    std::fs::remove_file(output_path).unwrap();
                }
            }
            if !keep_outputs {
                std::fs::remove_file(source_path).unwrap();
            }
        }

        for required in [
            "paragraph",
            "heading",
            "list-item",
            "table-cell",
            "header",
            "footer",
        ] {
            assert!(
                structures.contains(required),
                "missing {required} corpus coverage"
            );
        }
        assert!(warning_codes.contains("images-ignored"));
        assert!(warning_codes.contains("fields-degraded"));
        if keep_outputs {
            eprintln!("DOCX_ROUNDTRIP_CORPUS_DIR={}", directory.display());
        } else {
            std::fs::remove_dir(directory).unwrap();
        }
    }

    #[test]
    #[ignore = "requires an explicit private DOCX manifest and a new output directory"]
    fn round_trips_real_validation_corpus_for_visual_review() {
        let manifest_path = std::env::var("DOCX_VALIDATION_MANIFEST")
            .expect("DOCX_VALIDATION_MANIFEST must point to the private corpus manifest");
        let output_directory = std::env::var("DOCX_ROUNDTRIP_OUTPUT_DIR")
            .expect("DOCX_ROUNDTRIP_OUTPUT_DIR must name a new directory for review outputs");
        let manifest_path = Path::new(&manifest_path);
        let output_directory = Path::new(&output_directory);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(manifest_path).expect("validation manifest must be readable"),
        )
        .expect("validation manifest must contain valid JSON");
        let cases = manifest["cases"]
            .as_array()
            .expect("validation manifest must contain a cases array");
        let corpus_directory = manifest_path
            .parent()
            .expect("validation manifest must have a parent directory")
            .join("docs");

        assert!(
            cases.len() >= 5,
            "visual review requires at least five DOCX cases"
        );
        std::fs::create_dir(output_directory)
            .expect("DOCX_ROUNDTRIP_OUTPUT_DIR must not already exist");

        for (case_index, case) in cases.iter().enumerate() {
            let file_name = case["file"]
                .as_str()
                .expect("each validation case must name a file");
            let relative_path = Path::new(file_name);
            assert_eq!(
                relative_path.file_name().and_then(|value| value.to_str()),
                Some(file_name),
                "validation case names must not contain directories"
            );
            assert!(
                relative_path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("docx")),
                "validation case must be a DOCX"
            );
            let source_path = corpus_directory.join(relative_path);
            let source_bytes = std::fs::read(&source_path)
                .unwrap_or_else(|_| panic!("validation DOCX must be readable: {file_name}"));
            let inspection = inspect_docx_path(&source_path)
                .unwrap_or_else(|_| panic!("validation DOCX must be inspectable: {file_name}"));
            assert!(
                !inspection.segments.is_empty(),
                "{file_name} has no translatable segments"
            );

            for output_mode in [DocxOutputMode::Translated, DocxOutputMode::Bilingual] {
                let mode_name = match output_mode {
                    DocxOutputMode::Translated => "translated",
                    DocxOutputMode::Bilingual => "bilingual",
                };
                let stem = relative_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .expect("validation DOCX must have a Unicode file stem");
                let output_path = output_directory.join(format!("{stem}-{mode_name}.docx"));
                let translations = inspection
                    .segments
                    .iter()
                    .enumerate()
                    .map(|(segment_index, _)| {
                        format!(
                            "Validation translation {}.{}",
                            case_index + 1,
                            segment_index + 1
                        )
                    })
                    .collect::<Vec<_>>();
                let plan = DocxRebuildPlan {
                    source_path: source_path.to_string_lossy().into_owned(),
                    output_path: output_path.to_string_lossy().into_owned(),
                    fingerprint: inspection.fingerprint.clone(),
                    output_mode,
                    replacements: inspection
                        .segments
                        .iter()
                        .zip(&translations)
                        .map(|(segment, translated_text)| DocxRebuildReplacement {
                            id: segment.id.clone(),
                            order: segment.order,
                            part: segment.part.clone(),
                            source_position: segment.source_position.clone(),
                            structure: segment.structure.clone(),
                            source_text: segment.source_text.clone(),
                            translated_text: translated_text.clone(),
                        })
                        .collect(),
                };

                let result = rebuild_for_test(&plan).unwrap_or_else(|_| {
                    panic!("real corpus rebuild failed: {file_name}:{mode_name}")
                });
                assert_eq!(result.replacement_count, inspection.segments.len());
                let reopened = inspect_docx_path(&output_path).unwrap_or_else(|_| {
                    panic!("rebuilt DOCX cannot reopen: {file_name}:{mode_name}")
                });
                assert_eq!(reopened.segments.len(), inspection.segments.len());
                for ((source, rebuilt), translation) in inspection
                    .segments
                    .iter()
                    .zip(&reopened.segments)
                    .zip(&translations)
                {
                    assert_eq!(rebuilt.part, source.part);
                    assert_eq!(rebuilt.structure, source.structure);
                    let translated_content = rebuilt
                        .source_text
                        .chars()
                        .filter(|character| !matches!(character, '\r' | '\n' | '\t'))
                        .collect::<String>();
                    match output_mode {
                        DocxOutputMode::Translated => {
                            assert_eq!(translated_content, *translation)
                        }
                        DocxOutputMode::Bilingual => {
                            assert!(rebuilt.source_text.contains(&source.source_text));
                            assert!(translated_content.contains(translation));
                        }
                    }
                }
            }
            assert_eq!(
                std::fs::read(&source_path).unwrap(),
                source_bytes,
                "round-trip changed source file {file_name}"
            );
        }

        eprintln!("DOCX_ROUNDTRIP_OUTPUT_DIR={}", output_directory.display());
    }

    #[test]
    fn cancellation_is_accepted_only_before_the_atomic_publish_commit() {
        let cancellation = RebuildCancellation::new();
        assert!(cancellation.cancel());
        assert!(!cancellation.cancel());
        assert_eq!(
            cancellation.check().unwrap_err().code,
            DocxRebuildErrorCode::Cancelled
        );

        let publishing = RebuildCancellation::new();
        publishing.begin_publish().unwrap();
        assert!(!publishing.cancel());
        publishing.complete();
        assert!(!publishing.cancel());
    }

    #[test]
    fn cancelled_rebuild_never_creates_an_output_or_leaks_its_registration() {
        let source_bytes = fixture_package();
        let directory =
            std::env::temp_dir().join(format!("docx-cancelled-publish-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source_path = directory.join("source.docx");
        let output_path = directory.join("translated.docx");
        std::fs::write(&source_path, &source_bytes).unwrap();
        let plan = fixture_plan_for_paths(&source_path, &output_path, &source_bytes);
        let job_id = format!("cancelled-{}", uuid::Uuid::new_v4());
        let registration = RebuildRegistration::register(job_id.clone()).unwrap();

        assert!(cancel_rebuild_job(&job_id).unwrap());
        let error = prepare_rebuilt_package_with_cancel(&plan, Some(&registration.cancellation))
            .unwrap_err();
        assert_eq!(error.code, DocxRebuildErrorCode::Cancelled);
        assert!(!output_path.exists());
        drop(registration);
        assert!(!cancel_rebuild_job(&job_id).unwrap());

        std::fs::remove_file(source_path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn rejects_reserved_or_unresolvable_output_paths() {
        let source_bytes = fixture_package();
        let directory = std::env::temp_dir().join(format!("docx-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source_path = directory.join("source.docx");
        std::fs::write(&source_path, &source_bytes).unwrap();

        let reserved =
            fixture_plan_for_paths(&source_path, &directory.join("CON.docx"), &source_bytes);
        assert_eq!(
            canonical_output_path(&reserved).unwrap_err().code,
            DocxRebuildErrorCode::InvalidPlan
        );
        let missing = fixture_plan_for_paths(
            &source_path,
            &directory.join("missing").join("translated.docx"),
            &source_bytes,
        );
        assert_eq!(
            canonical_output_path(&missing).unwrap_err().code,
            DocxRebuildErrorCode::InvalidPlan
        );

        std::fs::remove_file(source_path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
