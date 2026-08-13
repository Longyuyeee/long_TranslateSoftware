use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use quick_xml::XmlVersion;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::{Display, Formatter};
use std::fs::File;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use unicode_segmentation::UnicodeSegmentation;
use zip::result::ZipError;
use zip::ZipArchive;

const MAX_DOCX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 32 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_XML_PART_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 200;
const MAX_SEGMENTS: usize = 20_000;
const MAX_TOTAL_TEXT_BYTES: usize = 24 * 1024 * 1024;
const MAX_INSPECTION_BYTES: usize = 48 * 1024 * 1024;
const OFFICE_DOCUMENT_RELATIONSHIP: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const STRICT_OFFICE_DOCUMENT_RELATIONSHIP: &str =
    "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument";
const HEADER_RELATIONSHIP: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
const STRICT_HEADER_RELATIONSHIP: &str =
    "http://purl.oclc.org/ooxml/officeDocument/relationships/header";
const FOOTER_RELATIONSHIP: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
const STRICT_FOOTER_RELATIONSHIP: &str =
    "http://purl.oclc.org/ooxml/officeDocument/relationships/footer";
const DOCUMENT_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const PACKAGE_RELATIONSHIPS_NAMESPACE: &str =
    "http://schemas.openxmlformats.org/package/2006/relationships";
const STRICT_PACKAGE_RELATIONSHIPS_NAMESPACE: &str =
    "http://purl.oclc.org/ooxml/package/relationships";
const CONTENT_TYPES_NAMESPACE: &str =
    "http://schemas.openxmlformats.org/package/2006/content-types";
const WORDPROCESSING_NAMESPACE: &str =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORDPROCESSING_NAMESPACE: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxImportErrorCode {
    UnsupportedFormat,
    InputTooLarge,
    InvalidInput,
    ParseFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DocxImportError {
    pub code: DocxImportErrorCode,
    pub message: String,
}

impl DocxImportError {
    fn new(code: DocxImportErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn unsupported_format(message: impl Into<String>) -> Self {
        Self::new(DocxImportErrorCode::UnsupportedFormat, message)
    }

    fn input_too_large(message: impl Into<String>) -> Self {
        Self::new(DocxImportErrorCode::InputTooLarge, message)
    }

    fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(DocxImportErrorCode::InvalidInput, message)
    }

    fn parse_failed(message: impl Into<String>) -> Self {
        Self::new(DocxImportErrorCode::ParseFailed, message)
    }
}

impl Display for DocxImportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DocxImportError {}

type ImportResult<T> = Result<T, DocxImportError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxSegment {
    pub id: String,
    pub order: usize,
    pub part: String,
    pub source_position: String,
    pub structure: String,
    pub source_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxImportWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxInspection {
    pub fingerprint: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub segments: Vec<DocxSegment>,
    pub warnings: Vec<DocxImportWarning>,
}

#[derive(Debug, Clone)]
struct ParsedParagraph {
    part: String,
    position: usize,
    structure: String,
    text: String,
    text_spans: Vec<TextSpan>,
}

#[derive(Debug, Clone)]
struct TextSpan {
    run: usize,
    text_node: usize,
    start: usize,
    end: usize,
}

#[derive(Debug, Default)]
struct ParsedPart {
    paragraphs: Vec<ParsedParagraph>,
    has_revisions: bool,
    has_formulas: bool,
    has_text_boxes: bool,
    has_fields: bool,
}

#[derive(Debug, Clone)]
struct Relationship {
    id: String,
    relationship_type: String,
    target: String,
    external: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentPartKind {
    Document,
    Header,
    Footer,
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn attribute_value(event: &BytesStart<'_>, attribute_name: &[u8]) -> ImportResult<Option<String>> {
    let decoder = event.decoder();
    for attribute in event.attributes() {
        let attribute = attribute.map_err(|error| {
            DocxImportError::parse_failed(format!("Invalid DOCX XML attribute: {error}"))
        })?;
        if local_name(attribute.key.as_ref()) == attribute_name {
            return attribute
                .decoded_and_normalized_value(XmlVersion::Implicit1_0, decoder)
                .map(|value| Some(value.into_owned()))
                .map_err(|error| {
                    DocxImportError::parse_failed(format!(
                        "Invalid DOCX XML attribute value: {error}"
                    ))
                });
        }
    }
    Ok(None)
}

fn declares_namespace(event: &BytesStart<'_>, accepted: &[&str]) -> ImportResult<bool> {
    let decoder = event.decoder();
    for attribute in event.attributes() {
        let attribute = attribute.map_err(|error| {
            DocxImportError::parse_failed(format!("Invalid DOCX XML namespace: {error}"))
        })?;
        let key = attribute.key.as_ref();
        if key == b"xmlns" || key.starts_with(b"xmlns:") {
            let value = attribute
                .decoded_and_normalized_value(XmlVersion::Implicit1_0, decoder)
                .map_err(|error| {
                    DocxImportError::parse_failed(format!(
                        "Invalid DOCX XML namespace value: {error}"
                    ))
                })?;
            if accepted.iter().any(|accepted| *accepted == value.as_ref()) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn paragraph_kind(
    part_kind: DocumentPartKind,
    in_table_cell: bool,
    heading: bool,
    list: bool,
) -> &'static str {
    if part_kind == DocumentPartKind::Header {
        "header"
    } else if part_kind == DocumentPartKind::Footer {
        "footer"
    } else if in_table_cell {
        "table-cell"
    } else if heading {
        "heading"
    } else if list {
        "list-item"
    } else {
        "paragraph"
    }
}

fn parse_document_part(
    part: &str,
    part_kind: DocumentPartKind,
    xml: &[u8],
) -> ImportResult<ParsedPart> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut paragraphs = Vec::new();
    let mut paragraph_text = String::new();
    let mut paragraph_index = 0usize;
    let mut paragraph_depth = 0usize;
    let mut table_cell_depth = 0usize;
    let mut paragraph_in_table = false;
    let mut paragraph_heading = false;
    let mut paragraph_list = false;
    let mut in_text = false;
    let mut element_depth = 0usize;
    let mut has_revisions = false;
    let mut has_formulas = false;
    let mut has_text_boxes = false;
    let mut has_fields = false;
    let mut text_box_depth = 0usize;
    let mut paragraph_run_index = 0usize;
    let mut paragraph_text_node_index = 0usize;
    let mut current_run = None;
    let mut current_text_span = None;
    let mut paragraph_text_spans = Vec::new();
    let mut root_validated = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                if !root_validated {
                    let expected_root = match part_kind {
                        DocumentPartKind::Document => b"document".as_slice(),
                        DocumentPartKind::Header => b"hdr".as_slice(),
                        DocumentPartKind::Footer => b"ftr".as_slice(),
                    };
                    if local_name(event.name().as_ref()) != expected_root
                        || !declares_namespace(
                            &event,
                            &[WORDPROCESSING_NAMESPACE, STRICT_WORDPROCESSING_NAMESPACE],
                        )?
                    {
                        return Err(DocxImportError::parse_failed(format!(
                            "DOCX part {part} has an invalid root element or namespace"
                        )));
                    }
                    root_validated = true;
                }
                element_depth += 1;
                match local_name(event.name().as_ref()) {
                    b"tc" => table_cell_depth += 1,
                    b"p" => {
                        paragraph_depth += 1;
                        if paragraph_depth == 1 {
                            paragraph_text.clear();
                            paragraph_in_table = table_cell_depth > 0;
                            paragraph_heading = false;
                            paragraph_list = false;
                            paragraph_run_index = 0;
                            paragraph_text_node_index = 0;
                            current_run = None;
                            current_text_span = None;
                            paragraph_text_spans.clear();
                        }
                    }
                    b"r" if paragraph_depth > 0 => {
                        current_run = Some(paragraph_run_index);
                        paragraph_run_index += 1;
                    }
                    b"pStyle" if paragraph_depth > 0 => {
                        let style = attribute_value(&event, b"val")?.unwrap_or_default();
                        let normalized = style.to_ascii_lowercase();
                        paragraph_heading = normalized.starts_with("heading")
                            || normalized == "title"
                            || normalized == "subtitle";
                    }
                    b"numPr" if paragraph_depth > 0 => paragraph_list = true,
                    b"t" if paragraph_depth > 0 => {
                        in_text = true;
                        current_text_span = Some((
                            current_run.unwrap_or(paragraph_run_index),
                            paragraph_text_node_index,
                            paragraph_text.len(),
                        ));
                        paragraph_text_node_index += 1;
                    }
                    b"tab" if paragraph_depth > 0 => paragraph_text.push('\t'),
                    b"br" | b"cr" if paragraph_depth > 0 => paragraph_text.push('\n'),
                    b"ins" | b"del" => has_revisions = true,
                    b"oMath" | b"oMathPara" => has_formulas = true,
                    b"txbxContent" => {
                        has_text_boxes = true;
                        text_box_depth += 1;
                    }
                    b"fldChar" | b"instrText" => has_fields = true,
                    _ => {}
                }
            }
            Ok(Event::Empty(event)) => match local_name(event.name().as_ref()) {
                b"pStyle" if paragraph_depth > 0 => {
                    let style = attribute_value(&event, b"val")?.unwrap_or_default();
                    let normalized = style.to_ascii_lowercase();
                    paragraph_heading = normalized.starts_with("heading")
                        || normalized == "title"
                        || normalized == "subtitle";
                }
                b"numPr" if paragraph_depth > 0 => paragraph_list = true,
                b"tab" if paragraph_depth > 0 => paragraph_text.push('\t'),
                b"br" | b"cr" if paragraph_depth > 0 => paragraph_text.push('\n'),
                b"ins" | b"del" => has_revisions = true,
                b"oMath" | b"oMathPara" => has_formulas = true,
                b"txbxContent" => has_text_boxes = true,
                b"fldChar" | b"instrText" => has_fields = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_text && paragraph_depth > 0 => {
                let decoded = text.decode().map_err(|error| {
                    DocxImportError::parse_failed(format!("Invalid DOCX text encoding: {error}"))
                })?;
                let unescaped = quick_xml::escape::unescape(&decoded).map_err(|error| {
                    DocxImportError::parse_failed(format!("Invalid DOCX text entity: {error}"))
                })?;
                paragraph_text.push_str(&unescaped);
            }
            Ok(Event::End(event)) => {
                match local_name(event.name().as_ref()) {
                    b"t" => {
                        in_text = false;
                        if let Some((run, text_node, start)) = current_text_span.take() {
                            let end = paragraph_text.len();
                            if end > start {
                                paragraph_text_spans.push(TextSpan {
                                    run,
                                    text_node,
                                    start,
                                    end,
                                });
                            }
                        }
                    }
                    b"r" if paragraph_depth > 0 => current_run = None,
                    b"p" => {
                        if paragraph_depth == 1 {
                            let text = paragraph_text.clone();
                            if text_box_depth == 0 && !text.trim().is_empty() {
                                paragraphs.push(ParsedParagraph {
                                    part: part.to_string(),
                                    position: paragraph_index,
                                    structure: paragraph_kind(
                                        part_kind,
                                        paragraph_in_table,
                                        paragraph_heading,
                                        paragraph_list,
                                    )
                                    .to_string(),
                                    text,
                                    text_spans: paragraph_text_spans.clone(),
                                });
                            }
                            paragraph_index += 1;
                        }
                        paragraph_depth = paragraph_depth.saturating_sub(1);
                    }
                    b"tc" => table_cell_depth = table_cell_depth.saturating_sub(1),
                    b"txbxContent" => text_box_depth = text_box_depth.saturating_sub(1),
                    _ => {}
                }
                element_depth = element_depth.saturating_sub(1);
            }
            Ok(Event::Eof) => {
                if !root_validated
                    || element_depth != 0
                    || paragraph_depth != 0
                    || table_cell_depth != 0
                    || in_text
                {
                    return Err(DocxImportError::parse_failed(format!(
                        "Invalid DOCX XML in {part}: unexpected end of file"
                    )));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => {
                return Err(DocxImportError::parse_failed(format!(
                    "Invalid DOCX XML in {part}: {error}"
                )))
            }
        }
    }
    Ok(ParsedPart {
        paragraphs,
        has_revisions,
        has_formulas,
        has_text_boxes,
        has_fields,
    })
}

fn split_utf8(text: &str) -> Vec<(usize, usize, &str)> {
    if text.len() <= MAX_SEGMENT_BYTES {
        return vec![(0, text.len(), text)];
    }
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let hard_end = (start + MAX_SEGMENT_BYTES).min(text.len());
        let mut end = start;
        for (relative, grapheme) in text[start..].grapheme_indices(true) {
            let grapheme_end = start + relative + grapheme.len();
            if grapheme_end > hard_end {
                break;
            }
            end = grapheme_end;
        }
        if end == start {
            end = hard_end;
            while end > start && !text.is_char_boundary(end) {
                end -= 1;
            }
        }
        if end < text.len() {
            if let Some(relative) = text[start..end]
                .char_indices()
                .rev()
                .find_map(|(index, character)| character.is_whitespace().then_some(index))
            {
                if relative > MAX_SEGMENT_BYTES / 2 {
                    end = start
                        + relative
                        + text[start + relative..]
                            .chars()
                            .next()
                            .map(char::len_utf8)
                            .unwrap_or(0);
                }
            }
        }
        chunks.push((start, end, &text[start..end]));
        start = end;
    }
    chunks
}

fn source_position(paragraph: &ParsedParagraph, chunk: usize, start: usize, end: usize) -> String {
    let intersecting = paragraph
        .text_spans
        .iter()
        .filter(|span| span.end > start && span.start < end)
        .collect::<Vec<_>>();
    let ranges = intersecting
        .first()
        .zip(intersecting.last())
        .map(|(first, last)| {
            format!(
                "runs:{}-{}:texts:{}-{}",
                first.run, last.run, first.text_node, last.text_node
            )
        })
        .unwrap_or_else(|| "runs:none:texts:none".to_string());
    format!(
        "paragraph:{}:chunk:{chunk}:bytes:{start}-{end}:{ranges}",
        paragraph.position
    )
}

fn stable_segment_id(
    fingerprint: &str,
    part: &str,
    position: usize,
    chunk: usize,
    structure: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(fingerprint.as_bytes());
    hasher.update([0]);
    hasher.update(part.as_bytes());
    hasher.update(position.to_le_bytes());
    hasher.update(chunk.to_le_bytes());
    hasher.update(structure.as_bytes());
    format!("docx-{}", &hex::encode(hasher.finalize())[..24])
}

fn warning(code: &str, message: &str) -> DocxImportWarning {
    DocxImportWarning {
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn parse_relationships(part: &str, xml: &[u8]) -> ImportResult<Vec<Relationship>> {
    let mut reader = Reader::from_reader(xml);
    let mut relationships = Vec::new();
    let mut root_validated = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if !root_validated => {
                if local_name(event.name().as_ref()) != b"Relationships"
                    || !declares_namespace(
                        &event,
                        &[
                            PACKAGE_RELATIONSHIPS_NAMESPACE,
                            STRICT_PACKAGE_RELATIONSHIPS_NAMESPACE,
                        ],
                    )?
                {
                    return Err(DocxImportError::parse_failed(format!(
                        "DOCX relationships in {part} have an invalid root element or namespace"
                    )));
                }
                root_validated = true;
            }
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == b"Relationship" =>
            {
                let id = attribute_value(&event, b"Id")?.ok_or_else(|| {
                    DocxImportError::parse_failed(format!(
                        "DOCX relationship in {part} is missing Id"
                    ))
                })?;
                let relationship_type = attribute_value(&event, b"Type")?.ok_or_else(|| {
                    DocxImportError::parse_failed(format!(
                        "DOCX relationship {id} in {part} is missing Type"
                    ))
                })?;
                let target = attribute_value(&event, b"Target")?.ok_or_else(|| {
                    DocxImportError::parse_failed(format!(
                        "DOCX relationship {id} in {part} is missing Target"
                    ))
                })?;
                let external = attribute_value(&event, b"TargetMode")?
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("external"));
                relationships.push(Relationship {
                    id,
                    relationship_type,
                    target,
                    external,
                });
            }
            Ok(Event::Eof) => {
                if !root_validated {
                    return Err(DocxImportError::parse_failed(format!(
                        "DOCX relationships in {part} are empty"
                    )));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => {
                return Err(DocxImportError::parse_failed(format!(
                    "Invalid DOCX relationships XML in {part}: {error}"
                )))
            }
        }
    }
    let mut ids = HashSet::new();
    if relationships
        .iter()
        .any(|relationship| !ids.insert(relationship.id.clone()))
    {
        return Err(DocxImportError::parse_failed(format!(
            "DOCX relationships in {part} contain duplicate IDs"
        )));
    }
    Ok(relationships)
}

fn normalize_relationship_target(source_part: &str, target: &str) -> ImportResult<String> {
    if target.is_empty()
        || target.contains('\\')
        || target.starts_with('/')
        || target.contains(':')
        || target.contains('#')
        || target.contains('?')
    {
        return Err(DocxImportError::parse_failed(
            "DOCX contains an unsafe internal relationship target",
        ));
    }
    let mut components = source_part
        .rsplit_once('/')
        .map(|(directory, _)| {
            directory
                .split('/')
                .filter(|component| !component.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for component in target.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                if components.pop().is_none() {
                    return Err(DocxImportError::parse_failed(
                        "DOCX relationship target escapes the package root",
                    ));
                }
            }
            value => components.push(value.to_string()),
        }
    }
    if components.is_empty() {
        return Err(DocxImportError::parse_failed(
            "DOCX relationship target is empty",
        ));
    }
    Ok(components.join("/"))
}

fn validate_content_types(xml: &[u8], main_part: &str) -> ImportResult<()> {
    let mut reader = Reader::from_reader(xml);
    let expected_part = format!("/{main_part}");
    let mut valid_main_type = false;
    let mut root_validated = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if !root_validated => {
                if local_name(event.name().as_ref()) != b"Types"
                    || !declares_namespace(&event, &[CONTENT_TYPES_NAMESPACE])?
                {
                    return Err(DocxImportError::parse_failed(
                        "DOCX content types have an invalid root element or namespace",
                    ));
                }
                root_validated = true;
            }
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == b"Override" =>
            {
                if attribute_value(&event, b"PartName")?.as_deref() == Some(expected_part.as_str())
                    && attribute_value(&event, b"ContentType")?.as_deref()
                        == Some(DOCUMENT_CONTENT_TYPE)
                {
                    valid_main_type = true;
                }
            }
            Ok(Event::Eof) => {
                if !root_validated {
                    return Err(DocxImportError::parse_failed(
                        "DOCX content types are empty",
                    ));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => {
                return Err(DocxImportError::parse_failed(format!(
                    "Invalid DOCX content types XML: {error}"
                )))
            }
        }
    }
    if !valid_main_type {
        return Err(DocxImportError::parse_failed(
            "DOCX main document content type is missing or unsupported",
        ));
    }
    Ok(())
}

fn referenced_header_footer_ids(document_xml: &[u8]) -> ImportResult<Vec<(String, &'static str)>> {
    let mut reader = Reader::from_reader(document_xml);
    let mut references = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event) | Event::Empty(event)) => {
                let kind = match local_name(event.name().as_ref()) {
                    b"headerReference" => Some("header"),
                    b"footerReference" => Some("footer"),
                    _ => None,
                };
                if let Some(kind) = kind {
                    let id = attribute_value(&event, b"id")?.ok_or_else(|| {
                        DocxImportError::parse_failed(format!(
                            "DOCX {kind} reference is missing its relationship ID"
                        ))
                    })?;
                    references.push((id, kind));
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(DocxImportError::parse_failed(format!(
                    "Invalid DOCX document relationships reference: {error}"
                )))
            }
        }
    }
    Ok(references)
}

fn relationship_matches(kind: &str, relationship_type: &str) -> bool {
    match kind {
        "header" => matches!(
            relationship_type,
            HEADER_RELATIONSHIP | STRICT_HEADER_RELATIONSHIP
        ),
        "footer" => matches!(
            relationship_type,
            FOOTER_RELATIONSHIP | STRICT_FOOTER_RELATIONSHIP
        ),
        _ => false,
    }
}

fn validate_archive<R: Read + Seek>(archive: &mut ZipArchive<R>) -> ImportResult<Vec<String>> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(DocxImportError::input_too_large(
            "DOCX contains too many archive entries",
        ));
    }
    let mut names = Vec::with_capacity(archive.len());
    let mut unique_names = HashSet::with_capacity(archive.len());
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| match error {
            ZipError::UnsupportedArchive(reason) if reason == ZipError::PASSWORD_REQUIRED => {
                DocxImportError::invalid_input("Encrypted DOCX files are not supported")
            }
            error => DocxImportError::parse_failed(format!("Cannot inspect DOCX archive: {error}")),
        })?;
        if entry.encrypted() {
            return Err(DocxImportError::invalid_input(
                "Encrypted DOCX files are not supported",
            ));
        }
        if entry.enclosed_name().is_none() || entry.name().contains('\\') {
            return Err(DocxImportError::parse_failed(
                "DOCX contains an unsafe archive path",
            ));
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(|| DocxImportError::input_too_large("DOCX expanded size is invalid"))?;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(DocxImportError::input_too_large(
                "DOCX expanded content exceeds the 100 MiB limit",
            ));
        }
        if entry.size() > MAX_XML_PART_BYTES && entry.name().ends_with(".xml") {
            return Err(DocxImportError::input_too_large(format!(
                "DOCX XML part is too large: {}",
                entry.name()
            )));
        }
        if entry.size() > 1024
            && (entry.compressed_size() == 0
                || entry.size() / entry.compressed_size() > MAX_COMPRESSION_RATIO)
        {
            return Err(DocxImportError::input_too_large(
                "DOCX compression ratio is unsafe",
            ));
        }
        let name = entry.name().to_string();
        if !unique_names.insert(name.to_ascii_lowercase()) {
            return Err(DocxImportError::parse_failed(
                "DOCX contains duplicate archive entries",
            ));
        }
        names.push(name);
    }
    Ok(names)
}

fn read_xml_part<R: Read + Seek>(archive: &mut ZipArchive<R>, part: &str) -> ImportResult<Vec<u8>> {
    let mut entry = archive.by_name(part).map_err(|_| {
        DocxImportError::parse_failed(format!("DOCX is missing required part: {part}"))
    })?;
    let capacity = usize::try_from(entry.size().min(MAX_XML_PART_BYTES)).unwrap_or(0);
    let mut xml = Vec::with_capacity(capacity);
    (&mut entry)
        .take(MAX_XML_PART_BYTES + 1)
        .read_to_end(&mut xml)
        .map_err(|error| {
            DocxImportError::parse_failed(format!("Cannot read DOCX part {part}: {error}"))
        })?;
    if xml.len() as u64 > MAX_XML_PART_BYTES {
        return Err(DocxImportError::input_too_large(format!(
            "DOCX XML part is too large: {part}"
        )));
    }
    Ok(xml)
}

fn inspect_archive<R: Read + Seek>(
    mut archive: ZipArchive<R>,
    fingerprint: String,
    file_name: String,
    size_bytes: u64,
) -> ImportResult<DocxInspection> {
    let names = validate_archive(&mut archive)?;
    let name_set = names.iter().cloned().collect::<HashSet<_>>();
    if !name_set.contains("[Content_Types].xml") || !name_set.contains("_rels/.rels") {
        return Err(DocxImportError::parse_failed(
            "File is not a valid DOCX package",
        ));
    }
    let package_relationships_xml = read_xml_part(&mut archive, "_rels/.rels")?;
    let package_relationships = parse_relationships("_rels/.rels", &package_relationships_xml)?;
    let office_relationships = package_relationships
        .iter()
        .filter(|relationship| {
            matches!(
                relationship.relationship_type.as_str(),
                OFFICE_DOCUMENT_RELATIONSHIP | STRICT_OFFICE_DOCUMENT_RELATIONSHIP
            )
        })
        .collect::<Vec<_>>();
    if office_relationships.len() != 1 || office_relationships[0].external {
        return Err(DocxImportError::parse_failed(
            "DOCX must contain one internal Office Document relationship",
        ));
    }
    let main_part = normalize_relationship_target("", &office_relationships[0].target)?;
    if main_part != "word/document.xml" || !name_set.contains(&main_part) {
        return Err(DocxImportError::parse_failed(
            "DOCX Office Document relationship does not target word/document.xml",
        ));
    }
    let content_types = read_xml_part(&mut archive, "[Content_Types].xml")?;
    validate_content_types(&content_types, &main_part)?;
    let document_xml = read_xml_part(&mut archive, &main_part)?;

    let references = referenced_header_footer_ids(&document_xml)?;
    let mut parts = vec![(main_part.clone(), DocumentPartKind::Document)];
    if !references.is_empty() {
        let relationship_part = "word/_rels/document.xml.rels";
        if !name_set.contains(relationship_part) {
            return Err(DocxImportError::parse_failed(
                "DOCX document references headers or footers without relationships",
            ));
        }
        let relationships_xml = read_xml_part(&mut archive, relationship_part)?;
        let relationships = parse_relationships(relationship_part, &relationships_xml)?
            .into_iter()
            .map(|relationship| (relationship.id.clone(), relationship))
            .collect::<HashMap<_, _>>();
        let mut selected = HashMap::new();
        for (id, kind) in references {
            let relationship = relationships.get(&id).ok_or_else(|| {
                DocxImportError::parse_failed(format!(
                    "DOCX {kind} reference {id} has no matching relationship"
                ))
            })?;
            if relationship.external || !relationship_matches(kind, &relationship.relationship_type)
            {
                return Err(DocxImportError::parse_failed(format!(
                    "DOCX {kind} reference {id} has an invalid relationship"
                )));
            }
            let target = normalize_relationship_target(&main_part, &relationship.target)?;
            if !target.ends_with(".xml") || !name_set.contains(&target) {
                return Err(DocxImportError::parse_failed(format!(
                    "DOCX {kind} reference {id} targets a missing part"
                )));
            }
            let part_kind = if kind == "header" {
                DocumentPartKind::Header
            } else {
                DocumentPartKind::Footer
            };
            if let Some(existing_kind) = selected.get(&target) {
                if *existing_kind != part_kind {
                    return Err(DocxImportError::parse_failed(
                        "DOCX reuses one part as both a header and footer",
                    ));
                }
            } else {
                selected.insert(target.clone(), part_kind);
                parts.push((target, part_kind));
            }
        }
    }

    let mut has_revisions = false;
    let mut has_formulas = false;
    let mut has_text_boxes = false;
    let mut has_fields = false;
    let mut total_text_bytes = 0usize;
    let mut segments = Vec::new();
    for (part, part_kind) in parts {
        let parsed_part = if part == main_part {
            parse_document_part(&part, part_kind, &document_xml)?
        } else {
            let xml = read_xml_part(&mut archive, &part)?;
            parse_document_part(&part, part_kind, &xml)?
        };
        for paragraph in parsed_part.paragraphs {
            total_text_bytes = total_text_bytes
                .checked_add(paragraph.text.len())
                .ok_or_else(|| {
                    DocxImportError::input_too_large("DOCX extracted text size is invalid")
                })?;
            if total_text_bytes > MAX_TOTAL_TEXT_BYTES {
                return Err(DocxImportError::input_too_large(
                    "DOCX extracted text exceeds the 24 MiB limit",
                ));
            }
            for (chunk_index, (start, end, chunk)) in
                split_utf8(&paragraph.text).into_iter().enumerate()
            {
                if segments.len() >= MAX_SEGMENTS {
                    return Err(DocxImportError::input_too_large(
                        "DOCX contains more than 20,000 translation segments",
                    ));
                }
                let order = segments.len();
                segments.push(DocxSegment {
                    id: stable_segment_id(
                        &fingerprint,
                        &paragraph.part,
                        paragraph.position,
                        chunk_index,
                        &paragraph.structure,
                    ),
                    order,
                    part: paragraph.part.clone(),
                    source_position: source_position(&paragraph, chunk_index, start, end),
                    structure: paragraph.structure.clone(),
                    source_text: chunk.to_string(),
                });
            }
        }
        has_revisions |= parsed_part.has_revisions;
        has_formulas |= parsed_part.has_formulas;
        has_text_boxes |= parsed_part.has_text_boxes;
        has_fields |= parsed_part.has_fields;
    }
    if segments.is_empty() {
        return Err(DocxImportError::invalid_input(
            "DOCX contains no translatable text",
        ));
    }

    let mut warnings = Vec::new();
    if names.iter().any(|name| name == "word/comments.xml") {
        warnings.push(warning(
            "comments-ignored",
            "Comments are not translated in this version",
        ));
    }
    if names.iter().any(|name| name.starts_with("word/media/")) {
        warnings.push(warning(
            "images-ignored",
            "Images are preserved as document content but are not sent for translation",
        ));
    }
    if names
        .iter()
        .any(|name| name.starts_with("word/embeddings/") || name.ends_with("vbaProject.bin"))
    {
        warnings.push(warning(
            "embedded-objects-unsupported",
            "Embedded objects are not supported in this version",
        ));
    }
    if has_revisions {
        warnings.push(warning(
            "revisions-degraded",
            "Tracked revisions are read as visible text only",
        ));
    }
    if has_formulas {
        warnings.push(warning(
            "formulas-ignored",
            "Formulas are not translated in this version",
        ));
    }
    if has_text_boxes {
        warnings.push(warning(
            "text-boxes-unsupported",
            "Text boxes are not translated in this version",
        ));
    }
    if has_fields {
        warnings.push(warning(
            "fields-degraded",
            "Document fields are preserved but their instructions are not translated",
        ));
    }

    let inspection = DocxInspection {
        fingerprint,
        file_name,
        size_bytes,
        segments,
        warnings,
    };
    let serialized_size = serde_json::to_vec(&inspection)
        .map_err(|error| {
            DocxImportError::parse_failed(format!("Cannot serialize DOCX inspection: {error}"))
        })?
        .len();
    if serialized_size > MAX_INSPECTION_BYTES {
        return Err(DocxImportError::input_too_large(
            "DOCX inspection result exceeds the 48 MiB limit",
        ));
    }
    Ok(inspection)
}

fn read_input_with_limit<R: Read>(reader: &mut R, limit: u64) -> ImportResult<Vec<u8>> {
    let capacity = usize::try_from(limit.min(1024 * 1024)).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            DocxImportError::invalid_input(format!("Cannot read DOCX file: {error}"))
        })?;
    if bytes.len() as u64 > limit {
        return Err(DocxImportError::input_too_large(format!(
            "DOCX input exceeds the {} MiB limit",
            limit / (1024 * 1024)
        )));
    }
    Ok(bytes)
}

pub fn inspect_docx_path(path: &Path) -> ImportResult<DocxInspection> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("docx"))
    {
        return Err(DocxImportError::unsupported_format(
            "Only .docx Word files are supported",
        ));
    }
    let file = File::open(path).map_err(|error| {
        DocxImportError::invalid_input(format!("Cannot open DOCX file: {error}"))
    })?;
    let metadata = file.metadata().map_err(|error| {
        DocxImportError::invalid_input(format!("Cannot inspect DOCX file: {error}"))
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(DocxImportError::invalid_input(
            "DOCX input must be a non-empty file",
        ));
    }
    if metadata.len() > MAX_DOCX_BYTES {
        return Err(DocxImportError::input_too_large(
            "DOCX input exceeds the 50 MiB limit",
        ));
    }
    let mut file = file;
    let bytes = read_input_with_limit(&mut file, MAX_DOCX_BYTES)?;
    if bytes.is_empty() {
        return Err(DocxImportError::invalid_input(
            "DOCX input must be a non-empty file",
        ));
    }
    let fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    let actual_size = bytes.len() as u64;
    let archive = ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|error| {
        DocxImportError::parse_failed(format!("Invalid DOCX ZIP container: {error}"))
    })?;
    inspect_archive(
        archive,
        fingerprint,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document.docx")
            .to_string(),
        actual_size,
    )
}

#[tauri::command]
pub fn inspect_docx_document(path: String) -> ImportResult<DocxInspection> {
    inspect_docx_path(&PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::{
        inspect_archive, inspect_docx_path, read_input_with_limit, DocxImportError,
        DocxImportErrorCode, MAX_SEGMENT_BYTES,
    };
    use std::io::{Cursor, Write};
    use std::path::Path;
    use zip::write::SimpleFileOptions;

    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;

    const PACKAGE_RELATIONSHIPS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdOffice" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    const DOCUMENT_RELATIONSHIPS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>"#;

    fn docx_with_metadata(
        parts: &[(&str, &str)],
        content_types: &str,
        package_relationships: &str,
        document_relationships: Option<&str>,
    ) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            writer.start_file("[Content_Types].xml", options).unwrap();
            writer.write_all(content_types.as_bytes()).unwrap();
            writer.start_file("_rels/.rels", options).unwrap();
            writer.write_all(package_relationships.as_bytes()).unwrap();
            if let Some(relationships) = document_relationships {
                writer
                    .start_file("word/_rels/document.xml.rels", options)
                    .unwrap();
                writer.write_all(relationships.as_bytes()).unwrap();
            }
            for (name, content) in parts {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        output.into_inner()
    }

    fn docx(parts: &[(&str, &str)]) -> Vec<u8> {
        docx_with_metadata(parts, CONTENT_TYPES, PACKAGE_RELATIONSHIPS, None)
    }

    fn inspect_bytes(bytes: Vec<u8>) -> Result<super::DocxInspection, DocxImportError> {
        inspect_archive(
            zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap(),
            "sha256:fixture".to_string(),
            "fixture.docx".to_string(),
            bytes.len() as u64,
        )
    }

    fn inspect(parts: &[(&str, &str)]) -> Result<super::DocxInspection, DocxImportError> {
        inspect_bytes(docx(parts))
    }

    fn inspect_with_relationships(
        parts: &[(&str, &str)],
        relationships: &str,
    ) -> Result<super::DocxInspection, DocxImportError> {
        inspect_bytes(docx_with_metadata(
            parts,
            CONTENT_TYPES,
            PACKAGE_RELATIONSHIPS,
            Some(relationships),
        ))
    }

    #[test]
    fn extracts_stable_structures_in_document_order() {
        let document = include_str!("../tests/fixtures/docx/document.xml");
        let header = include_str!("../tests/fixtures/docx/header1.xml");
        let footer = include_str!("../tests/fixtures/docx/footer1.xml");
        let result = inspect_with_relationships(
            &[
                ("word/document.xml", document),
                ("word/header1.xml", header),
                ("word/footer1.xml", footer),
                (
                    "word/header2.xml",
                    r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Orphan secret</w:t></w:r></w:p></w:hdr>"#,
                ),
            ],
            DOCUMENT_RELATIONSHIPS,
        )
        .unwrap();
        let values = result
            .segments
            .iter()
            .map(|segment| (segment.structure.as_str(), segment.source_text.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            values,
            vec![
                ("heading", "Product Overview 产品概览"),
                ("paragraph", "Visit example.com today."),
                ("list-item", "First item"),
                ("table-cell", "Cell A 单元格"),
                ("header", "Confidential"),
                ("footer", "Page footer"),
            ]
        );
        assert!(result
            .segments
            .iter()
            .enumerate()
            .all(|(order, segment)| segment.order == order));
        assert!(result
            .segments
            .iter()
            .all(|segment| segment.source_text != "Orphan secret"));
        let hyperlink_paragraph = result
            .segments
            .iter()
            .find(|segment| segment.source_text.contains("example.com"))
            .unwrap();
        assert!(hyperlink_paragraph
            .source_position
            .contains("runs:0-2:texts:0-2"));
        let second = inspect_with_relationships(
            &[
                ("word/document.xml", document),
                ("word/header1.xml", header),
                ("word/footer1.xml", footer),
                (
                    "word/header2.xml",
                    r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Orphan secret</w:t></w:r></w:p></w:hdr>"#,
                ),
            ],
            DOCUMENT_RELATIONSHIPS,
        )
        .unwrap();
        assert_eq!(result.segments, second.segments);
    }

    #[test]
    fn uses_relationship_types_for_custom_header_and_footer_part_names() {
        let document = include_str!("../tests/fixtures/docx/document.xml");
        let header = include_str!("../tests/fixtures/docx/header1.xml");
        let footer = include_str!("../tests/fixtures/docx/footer1.xml");
        let relationships = DOCUMENT_RELATIONSHIPS
            .replace("header1.xml", "parts/top.xml")
            .replace("footer1.xml", "parts/bottom.xml");
        let result = inspect_with_relationships(
            &[
                ("word/document.xml", document),
                ("word/parts/top.xml", header),
                ("word/parts/bottom.xml", footer),
            ],
            &relationships,
        )
        .unwrap();
        assert!(result.segments.iter().any(|segment| {
            segment.part == "word/parts/top.xml" && segment.structure == "header"
        }));
        assert!(result.segments.iter().any(|segment| {
            segment.part == "word/parts/bottom.xml" && segment.structure == "footer"
        }));
    }

    #[test]
    fn inspects_a_complete_docx_package_through_the_public_file_path() {
        let document = include_str!("../tests/fixtures/docx/document.xml");
        let header = include_str!("../tests/fixtures/docx/header1.xml");
        let footer = include_str!("../tests/fixtures/docx/footer1.xml");
        let bytes = docx_with_metadata(
            &[
                ("word/document.xml", document),
                ("word/header1.xml", header),
                ("word/footer1.xml", footer),
            ],
            CONTENT_TYPES,
            PACKAGE_RELATIONSHIPS,
            Some(DOCUMENT_RELATIONSHIPS),
        );
        let path = std::env::temp_dir().join(format!(
            "long-translate-docx-inspection-{}.docx",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, &bytes).unwrap();
        let result = inspect_docx_path(&path);
        let source_after_inspection = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let result = result.unwrap();
        assert_eq!(source_after_inspection, bytes);
        assert_eq!(result.size_bytes, bytes.len() as u64);
        assert!(result.fingerprint.starts_with("sha256:"));
        assert_eq!(result.segments.len(), 6);
    }

    #[test]
    fn splits_multibyte_paragraphs_at_the_byte_limit() {
        for long_text in [
            "a".repeat(40_000),
            "译".repeat(20_000),
            "e\u{301}".repeat(20_000),
        ] {
            let xml = format!(
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{long_text}</w:t></w:r></w:p></w:body></w:document>"#
            );
            let result = inspect(&[("word/document.xml", &xml)]).unwrap();
            assert!(result.segments.len() > 1);
            assert!(result
                .segments
                .iter()
                .all(|segment| segment.source_text.len() <= MAX_SEGMENT_BYTES));
            assert_eq!(
                result
                    .segments
                    .iter()
                    .map(|segment| segment.source_text.as_str())
                    .collect::<String>(),
                long_text
            );
            if long_text.contains('\u{301}') {
                assert!(result
                    .segments
                    .iter()
                    .all(|segment| !segment.source_text.starts_with('\u{301}')));
            }
        }
    }

    #[test]
    fn follows_multiple_section_relationships_in_reference_order() {
        let document = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr><w:headerReference r:id="h1"/></w:sectPr><w:sectPr><w:headerReference r:id="h2"/><w:footerReference r:id="f1"/></w:sectPr></w:body></w:document>"#;
        let relationships = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="h1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="parts/first.xml"/><Relationship Id="h2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="parts/second.xml"/><Relationship Id="f1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="parts/footer.xml"/></Relationships>"#;
        let header_one = r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>First header</w:t></w:r></w:p></w:hdr>"#;
        let header_two = r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Second header</w:t></w:r></w:p></w:hdr>"#;
        let footer = r#"<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:ftr>"#;
        let result = inspect_with_relationships(
            &[
                ("word/document.xml", document),
                ("word/parts/first.xml", header_one),
                ("word/parts/second.xml", header_two),
                ("word/parts/footer.xml", footer),
            ],
            relationships,
        )
        .unwrap();
        assert_eq!(
            result
                .segments
                .iter()
                .map(|segment| segment.source_text.as_str())
                .collect::<Vec<_>>(),
            vec!["Body", "First header", "Second header", "Footer"]
        );
    }

    #[test]
    fn reports_unsupported_non_text_content_without_extracting_it() {
        let document = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="m"><w:body><w:ins><w:p><w:r><w:t>Visible</w:t></w:r></w:p></w:ins><m:oMath/><w:txbxContent><w:p><w:r><w:t>Hidden text box</w:t></w:r></w:p></w:txbxContent><w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>PRIVATE FIELD</w:instrText><w:t>Field result</w:t></w:r></w:p></w:body></w:document>"#;
        let result = inspect(&[
            ("word/document.xml", document),
            ("word/comments.xml", "<w:comments xmlns:w=\"w\"/>"),
            ("word/media/image1.png", "not-real-image"),
            ("word/embeddings/object1.bin", "private-binary"),
        ])
        .unwrap();
        assert_eq!(
            result
                .segments
                .iter()
                .map(|segment| segment.source_text.as_str())
                .collect::<Vec<_>>(),
            vec!["Visible", "Field result"]
        );
        assert_eq!(
            result
                .warnings
                .iter()
                .map(|warning| warning.code.as_str())
                .collect::<Vec<_>>(),
            vec![
                "comments-ignored",
                "images-ignored",
                "embedded-objects-unsupported",
                "revisions-degraded",
                "formulas-ignored",
                "text-boxes-unsupported",
                "fields-degraded",
            ]
        );
    }

    #[test]
    fn rejects_missing_main_part_and_malformed_xml() {
        let missing = inspect(&[("word/styles.xml", "<w:styles/>")]).unwrap_err();
        assert_eq!(missing.code, DocxImportErrorCode::ParseFailed);
        assert!(missing.message.contains("word/document.xml"));
        let malformed = inspect(&[(
            "word/document.xml",
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>"#,
        )])
        .unwrap_err();
        assert_eq!(malformed.code, DocxImportErrorCode::ParseFailed);
        assert!(malformed.message.contains("Invalid DOCX XML"));
    }

    #[test]
    fn rejects_fake_content_types_and_external_office_relationships() {
        let document = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>"#;
        let fake_content_types = CONTENT_TYPES.replace(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            "application/xml",
        );
        let wrong_type = inspect_bytes(docx_with_metadata(
            &[("word/document.xml", document)],
            &fake_content_types,
            PACKAGE_RELATIONSHIPS,
            None,
        ))
        .unwrap_err();
        assert_eq!(wrong_type.code, DocxImportErrorCode::ParseFailed);
        assert!(wrong_type.message.contains("content type"));

        let external = PACKAGE_RELATIONSHIPS.replace(
            "Target=\"word/document.xml\"",
            "Target=\"https://example.com/document.xml\" TargetMode=\"External\"",
        );
        let external_error = inspect_bytes(docx_with_metadata(
            &[("word/document.xml", document)],
            CONTENT_TYPES,
            &external,
            None,
        ))
        .unwrap_err();
        assert_eq!(external_error.code, DocxImportErrorCode::ParseFailed);
        assert!(external_error.message.contains("internal Office Document"));
    }

    #[test]
    fn rejects_broken_or_external_header_relationships() {
        let document = include_str!("../tests/fixtures/docx/document.xml");
        let header = include_str!("../tests/fixtures/docx/header1.xml");
        let footer = include_str!("../tests/fixtures/docx/footer1.xml");
        let missing = DOCUMENT_RELATIONSHIPS.replace("rIdHeader", "otherHeader");
        let missing_error = inspect_with_relationships(
            &[
                ("word/document.xml", document),
                ("word/header1.xml", header),
                ("word/footer1.xml", footer),
            ],
            &missing,
        )
        .unwrap_err();
        assert!(missing_error.message.contains("no matching relationship"));

        let external = DOCUMENT_RELATIONSHIPS.replace(
            "Target=\"header1.xml\"",
            "Target=\"https://example.com/header.xml\" TargetMode=\"External\"",
        );
        let external_error = inspect_with_relationships(
            &[
                ("word/document.xml", document),
                ("word/header1.xml", header),
                ("word/footer1.xml", footer),
            ],
            &external,
        )
        .unwrap_err();
        assert!(external_error.message.contains("invalid relationship"));

        let traversal = DOCUMENT_RELATIONSHIPS
            .replace("Target=\"header1.xml\"", "Target=\"../../outside.xml\"");
        let traversal_error = inspect_with_relationships(
            &[
                ("word/document.xml", document),
                ("word/header1.xml", header),
                ("word/footer1.xml", footer),
            ],
            &traversal,
        )
        .unwrap_err();
        assert!(traversal_error.message.contains("escapes the package root"));
    }

    #[test]
    fn rejects_duplicate_archive_entries() {
        let document = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>"#;
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, content) in [
                ("[Content_Types].xml", CONTENT_TYPES),
                ("_rels/.rels", PACKAGE_RELATIONSHIPS),
                ("word/document.xml", document),
                ("word/Document.xml", document),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        let error = inspect_bytes(output.into_inner()).unwrap_err();
        assert_eq!(error.code, DocxImportErrorCode::ParseFailed);
        assert!(error.message.contains("duplicate archive entries"));
    }

    #[test]
    fn rejects_unsafe_archive_paths_and_compression_ratios() {
        let document = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>"#;
        let mut unsafe_output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut unsafe_output);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, content) in [
                ("[Content_Types].xml", CONTENT_TYPES),
                ("_rels/.rels", PACKAGE_RELATIONSHIPS),
                ("word/document.xml", document),
                ("../outside.xml", "secret"),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        let unsafe_error = inspect_bytes(unsafe_output.into_inner()).unwrap_err();
        assert_eq!(unsafe_error.code, DocxImportErrorCode::ParseFailed);
        assert!(unsafe_error.message.contains("unsafe archive path"));

        let mut compressed_output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut compressed_output);
            let stored =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            writer.start_file("[Content_Types].xml", stored).unwrap();
            writer.write_all(CONTENT_TYPES.as_bytes()).unwrap();
            writer.start_file("_rels/.rels", stored).unwrap();
            writer.write_all(PACKAGE_RELATIONSHIPS.as_bytes()).unwrap();
            writer.start_file("word/document.xml", stored).unwrap();
            writer.write_all(document.as_bytes()).unwrap();
            let deflated =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file("word/media/payload.bin", deflated)
                .unwrap();
            writer.write_all(&vec![0u8; 1024 * 1024]).unwrap();
            writer.finish().unwrap();
        }
        let ratio_error = inspect_bytes(compressed_output.into_inner()).unwrap_err();
        assert_eq!(ratio_error.code, DocxImportErrorCode::InputTooLarge);
        assert!(ratio_error.message.contains("compression ratio"));
    }

    #[test]
    fn rejects_excessive_segment_counts() {
        let paragraphs = (0..20_001)
            .map(|index| format!("<w:p><w:r><w:t>{index}</w:t></w:r></w:p>"))
            .collect::<String>();
        let document = format!(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{paragraphs}</w:body></w:document>"#
        );
        let error = inspect(&[("word/document.xml", &document)]).unwrap_err();
        assert_eq!(error.code, DocxImportErrorCode::InputTooLarge);
        assert!(error.message.contains("20,000 translation segments"));
    }

    #[test]
    fn bounded_reader_rejects_growth_beyond_the_open_file_limit() {
        let error = read_input_with_limit(&mut Cursor::new(b"12345"), 4).unwrap_err();
        assert_eq!(error.code, DocxImportErrorCode::InputTooLarge);
    }

    #[test]
    fn serializes_stable_document_error_codes() {
        let error = DocxImportError::input_too_large("too large");
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({ "code": "input-too-large", "message": "too large" })
        );
    }

    #[test]
    fn rejects_legacy_doc_before_opening_it() {
        let error = inspect_docx_path(Path::new("legacy.doc")).unwrap_err();
        assert_eq!(error.code, DocxImportErrorCode::UnsupportedFormat);
        assert!(error.message.contains("Only .docx"));
    }

    #[test]
    #[ignore = "requires an explicitly generated and visually reviewed DOCX corpus"]
    fn validates_rendered_docx_corpus_manifest() {
        let manifest_path = std::env::var("DOCX_VALIDATION_MANIFEST")
            .expect("DOCX_VALIDATION_MANIFEST must point to the reviewed corpus manifest");
        let manifest_path = Path::new(&manifest_path);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(manifest_path).expect("validation manifest must be readable"),
        )
        .expect("validation manifest must contain valid JSON");
        let cases = manifest["cases"]
            .as_array()
            .expect("validation manifest must contain a cases array");
        let corpus_dir = manifest_path
            .parent()
            .expect("validation manifest must have a parent directory")
            .join("docs");

        assert!(
            cases.len() >= 5,
            "manual validation requires at least five DOCX cases"
        );
        for case in cases {
            let file_name = case["file"]
                .as_str()
                .expect("each validation case must name a file");
            let path = corpus_dir.join(file_name);
            let before = std::fs::read(&path).expect("validation DOCX must be readable");
            let inspection = inspect_docx_path(&path).expect("validation DOCX must be inspectable");
            let after = std::fs::read(&path).expect("validation DOCX must remain readable");
            assert_eq!(before, after, "inspection changed source file {file_name}");

            let actual_text = inspection
                .segments
                .iter()
                .map(|segment| segment.source_text.as_str())
                .collect::<Vec<_>>();
            let expected_text = case["expectedSourceText"]
                .as_array()
                .expect("each validation case must define expectedSourceText")
                .iter()
                .map(|value| value.as_str().expect("expected text must be a string"))
                .collect::<Vec<_>>();
            assert_eq!(
                actual_text, expected_text,
                "visible reading order differs for {file_name}"
            );

            let actual_warnings = inspection
                .warnings
                .iter()
                .map(|warning| warning.code.as_str())
                .collect::<Vec<_>>();
            let expected_warnings = case["expectedWarnings"]
                .as_array()
                .expect("each validation case must define expectedWarnings")
                .iter()
                .map(|value| value.as_str().expect("expected warning must be a string"))
                .collect::<Vec<_>>();
            assert_eq!(
                actual_warnings, expected_warnings,
                "warning set differs for {file_name}"
            );
        }

        let encrypted_file = manifest["encryptedFile"]
            .as_str()
            .expect("validation manifest must name an encrypted DOCX");
        let encrypted_error = inspect_docx_path(&corpus_dir.join(encrypted_file))
            .expect_err("encrypted validation DOCX must be rejected");
        assert_eq!(encrypted_error.code, DocxImportErrorCode::InvalidInput);
        assert_eq!(
            encrypted_error.message,
            "Encrypted DOCX files are not supported"
        );
    }
}
