use crate::document::{inspect_docx_bytes, DocxInspection};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use unicode_segmentation::UnicodeSegmentation;
use zip::write::ZipWriter;
use zip::ZipArchive;

const MAX_SEGMENTS: usize = 20_000;
const MAX_SEGMENT_BYTES: usize = 32 * 1024;
const MAX_TRANSLATED_BYTES: usize = 24 * 1024 * 1024;
const MAX_DOCX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_XML_PART_BYTES: usize = 16 * 1024 * 1024;

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

fn read_source_bytes(path: &str) -> RebuildResult<Vec<u8>> {
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
    (&mut file)
        .take(MAX_DOCX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| DocxRebuildError::rebuild(format!("Cannot read DOCX source: {error}")))?;
    if bytes.len() as u64 > MAX_DOCX_BYTES {
        return Err(DocxRebuildError::invalid(
            "DOCX source exceeds the 50 MiB limit",
        ));
    }
    Ok(bytes)
}

fn build_rewrite_index(
    plan: &DocxRebuildPlan,
) -> RebuildResult<BTreeMap<String, BTreeMap<usize, ParagraphRewrite>>> {
    let mut parts = BTreeMap::<String, BTreeMap<usize, ParagraphRewrite>>::new();
    for (index, replacement) in plan.replacements.iter().enumerate() {
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

fn collect_paragraph_text_nodes(xml: &[u8]) -> RebuildResult<HashMap<usize, Vec<String>>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut paragraphs = HashMap::new();
    let mut paragraph_depth = 0usize;
    let mut paragraph_index = 0usize;
    let mut text_nodes = Vec::new();
    let mut current_text = None::<String>;
    loop {
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
    let mut previous = 0usize;
    let mut cumulative = 0usize;
    weights
        .iter()
        .enumerate()
        .map(|(index, weight)| {
            cumulative += weight;
            let end = if index + 1 == weights.len() {
                graphemes.len()
            } else {
                graphemes.len() * cumulative / total_weight
            };
            let value = graphemes[previous..end].concat();
            previous = end;
            value
        })
        .collect()
}

fn paragraph_outputs(
    xml: &[u8],
    rewrites: &BTreeMap<usize, ParagraphRewrite>,
    plan: &DocxRebuildPlan,
) -> RebuildResult<HashMap<usize, ParagraphOutput>> {
    let nodes = collect_paragraph_text_nodes(xml)?;
    let mut outputs = HashMap::new();
    for (paragraph_index, rewrite) in rewrites {
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

fn transform_xml_part(
    xml: &[u8],
    rewrites: &BTreeMap<usize, ParagraphRewrite>,
    plan: &DocxRebuildPlan,
) -> RebuildResult<Vec<u8>> {
    let outputs = paragraph_outputs(xml, rewrites, plan)?;
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

fn rebuild_package_in_memory(source: &[u8], plan: &DocxRebuildPlan) -> RebuildResult<Vec<u8>> {
    let rewrite_index = build_rewrite_index(plan)?;
    let mut source_archive = ZipArchive::new(Cursor::new(source)).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot reopen DOCX source archive: {error}"))
    })?;
    let mut modified_parts = HashMap::new();
    for (part, rewrites) in &rewrite_index {
        let mut entry = source_archive.by_name(part).map_err(|_| {
            DocxRebuildError::stale(format!("DOCX rebuild part is missing: {part}"))
        })?;
        let mut xml = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut xml).map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot read DOCX rebuild part {part}: {error}"))
        })?;
        modified_parts.insert(part.clone(), transform_xml_part(&xml, rewrites, plan)?);
    }

    let target = Cursor::new(Vec::with_capacity(source.len()));
    let mut writer = ZipWriter::new(target);
    for index in 0..source_archive.len() {
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
    let source = read_source_bytes(&plan.source_path)?;
    let file_name = Path::new(plan.source_path.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.docx")
        .to_string();
    let inspection = inspect_docx_bytes(&source, file_name.clone()).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot re-inspect DOCX source: {}", error.message))
    })?;
    let mut validation = validate_against_inspection(plan, &inspection)?;
    let rebuilt = rebuild_package_in_memory(&source, plan)?;
    inspect_docx_bytes(&rebuilt, file_name).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot validate rebuilt DOCX: {}", error.message))
    })?;
    validation.rebuilt_size_bytes = rebuilt.len();
    validation.rebuilt_fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(&rebuilt)));
    Ok((validation, rebuilt))
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

fn canonical_output_path(plan: &DocxRebuildPlan) -> RebuildResult<(PathBuf, PathBuf)> {
    let requested = Path::new(plan.output_path.trim());
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
    let source = fs::canonicalize(plan.source_path.trim()).map_err(|error| {
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

#[cfg(windows)]
fn publish_without_overwrite(temp: &Path, output: &Path) -> std::io::Result<()> {
    fs::rename(temp, output)
}

#[cfg(not(windows))]
fn publish_without_overwrite(temp: &Path, output: &Path) -> std::io::Result<()> {
    fs::hard_link(temp, output)?;
    if let Err(error) = fs::remove_file(temp) {
        let _ = fs::remove_file(output);
        return Err(error);
    }
    Ok(())
}

fn publish_rebuilt_package(
    plan: &DocxRebuildPlan,
    validation: &DocxRebuildValidation,
    rebuilt: &[u8],
) -> RebuildResult<DocxRebuildResult> {
    let (canonical_parent, output) = canonical_output_path(plan)?;
    let temp = canonical_parent.join(format!(".long-translate-{}.docx.tmp", uuid::Uuid::new_v4()));
    let mut guard = TempFileGuard::new(temp.clone());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| {
            DocxRebuildError::rebuild(format!("Cannot create DOCX temporary file: {error}"))
        })?;
    file.write_all(rebuilt).map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot write DOCX temporary file: {error}"))
    })?;
    file.sync_all().map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot sync DOCX temporary file: {error}"))
    })?;
    drop(file);

    let persisted = read_source_bytes(&temp.to_string_lossy())?;
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

    let current_parent = fs::canonicalize(
        output
            .parent()
            .expect("canonical output always has a parent"),
    )
    .map_err(|error| {
        DocxRebuildError::rebuild(format!("Cannot recheck DOCX output directory: {error}"))
    })?;
    if normalized_windows_path(&current_parent.to_string_lossy())
        != normalized_windows_path(&canonical_parent.to_string_lossy())
    {
        return Err(DocxRebuildError::rebuild(
            "DOCX output directory changed during publication",
        ));
    }
    publish_without_overwrite(&temp, &output).map_err(|error| {
        DocxRebuildError::rebuild(format!(
            "Cannot publish DOCX without overwriting an existing file: {error}"
        ))
    })?;
    guard.disarm();
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
pub fn rebuild_docx_document(plan: DocxRebuildPlan) -> RebuildResult<DocxRebuildResult> {
    let (validation, rebuilt) = prepare_rebuilt_package(&plan)?;
    publish_rebuilt_package(&plan, &validation, &rebuilt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{DocxImportWarning, DocxSegment};
    use zip::write::SimpleFileOptions;

    const DOCUMENT_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo</w:t></w:r></w:p></w:body></w:document>"#;
    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    const PACKAGE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdOffice" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

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

        let result = rebuild_docx_document(plan.clone()).unwrap();
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
            rebuild_docx_document(plan).unwrap_err().code,
            DocxRebuildErrorCode::InvalidPlan
        );
        assert_eq!(std::fs::read(&output_path).unwrap(), published);

        std::fs::remove_file(output_path).unwrap();
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
