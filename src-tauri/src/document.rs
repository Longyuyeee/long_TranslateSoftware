use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use quick_xml::XmlVersion;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const MAX_DOCX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 32 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_XML_PART_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 200;

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
}

#[derive(Debug, Default)]
struct ParsedPart {
    paragraphs: Vec<ParsedParagraph>,
    has_revisions: bool,
    has_formulas: bool,
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn attribute_value(
    event: &BytesStart<'_>,
    attribute_name: &[u8],
) -> Result<Option<String>, String> {
    let decoder = event.decoder();
    for attribute in event.attributes() {
        let attribute =
            attribute.map_err(|error| format!("Invalid DOCX XML attribute: {error}"))?;
        if local_name(attribute.key.as_ref()) == attribute_name {
            return attribute
                .decoded_and_normalized_value(XmlVersion::Implicit1_0, decoder)
                .map(|value| Some(value.into_owned()))
                .map_err(|error| format!("Invalid DOCX XML attribute value: {error}"));
        }
    }
    Ok(None)
}

fn paragraph_kind(part: &str, in_table_cell: bool, heading: bool, list: bool) -> &'static str {
    if part.starts_with("word/header") {
        "header"
    } else if part.starts_with("word/footer") {
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

fn parse_document_part(part: &str, xml: &[u8]) -> Result<ParsedPart, String> {
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

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
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
                        }
                    }
                    b"pStyle" if paragraph_depth > 0 => {
                        let style = attribute_value(&event, b"val")?.unwrap_or_default();
                        let normalized = style.to_ascii_lowercase();
                        paragraph_heading = normalized.starts_with("heading")
                            || normalized == "title"
                            || normalized == "subtitle";
                    }
                    b"numPr" if paragraph_depth > 0 => paragraph_list = true,
                    b"t" if paragraph_depth > 0 => in_text = true,
                    b"tab" if paragraph_depth > 0 => paragraph_text.push('\t'),
                    b"br" | b"cr" if paragraph_depth > 0 => paragraph_text.push('\n'),
                    b"ins" | b"del" => has_revisions = true,
                    b"oMath" | b"oMathPara" => has_formulas = true,
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
                _ => {}
            },
            Ok(Event::Text(text)) if in_text && paragraph_depth > 0 => {
                let decoded = text
                    .decode()
                    .map_err(|error| format!("Invalid DOCX text encoding: {error}"))?;
                let unescaped = quick_xml::escape::unescape(&decoded)
                    .map_err(|error| format!("Invalid DOCX text entity: {error}"))?;
                paragraph_text.push_str(&unescaped);
            }
            Ok(Event::End(event)) => {
                match local_name(event.name().as_ref()) {
                    b"t" => in_text = false,
                    b"p" => {
                        if paragraph_depth == 1 {
                            let text = paragraph_text.trim_matches(['\r', '\n']).to_string();
                            if !text.trim().is_empty() {
                                paragraphs.push(ParsedParagraph {
                                    part: part.to_string(),
                                    position: paragraph_index,
                                    structure: paragraph_kind(
                                        part,
                                        paragraph_in_table,
                                        paragraph_heading,
                                        paragraph_list,
                                    )
                                    .to_string(),
                                    text,
                                });
                            }
                            paragraph_index += 1;
                        }
                        paragraph_depth = paragraph_depth.saturating_sub(1);
                    }
                    b"tc" => table_cell_depth = table_cell_depth.saturating_sub(1),
                    _ => {}
                }
                element_depth = element_depth.saturating_sub(1);
            }
            Ok(Event::Eof) => {
                if element_depth != 0 || paragraph_depth != 0 || table_cell_depth != 0 || in_text {
                    return Err(format!(
                        "Invalid DOCX XML in {part}: unexpected end of file"
                    ));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => return Err(format!("Invalid DOCX XML in {part}: {error}")),
        }
    }
    Ok(ParsedPart {
        paragraphs,
        has_revisions,
        has_formulas,
    })
}

fn split_utf8(text: &str) -> Vec<&str> {
    if text.len() <= MAX_SEGMENT_BYTES {
        return vec![text];
    }
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut end = (start + MAX_SEGMENT_BYTES).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
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
        chunks.push(&text[start..end]);
        start = end;
    }
    chunks
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

fn validate_archive<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<Vec<String>, String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("DOCX contains too many archive entries".to_string());
    }
    let mut names = Vec::with_capacity(archive.len());
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Cannot inspect DOCX archive: {error}"))?;
        if entry.encrypted() {
            return Err("Encrypted DOCX files are not supported".to_string());
        }
        if entry.enclosed_name().is_none() {
            return Err("DOCX contains an unsafe archive path".to_string());
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(|| "DOCX expanded size is invalid".to_string())?;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err("DOCX expanded content exceeds the 100 MiB limit".to_string());
        }
        if entry.size() > MAX_XML_PART_BYTES && entry.name().ends_with(".xml") {
            return Err(format!("DOCX XML part is too large: {}", entry.name()));
        }
        if entry.size() > 1024
            && entry.compressed_size() > 0
            && entry.size() / entry.compressed_size() > MAX_COMPRESSION_RATIO
        {
            return Err("DOCX compression ratio is unsafe".to_string());
        }
        names.push(entry.name().replace('\\', "/"));
    }
    Ok(names)
}

fn read_xml_part<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    part: &str,
) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(part)
        .map_err(|_| format!("DOCX is missing required part: {part}"))?;
    let mut xml = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut xml)
        .map_err(|error| format!("Cannot read DOCX part {part}: {error}"))?;
    Ok(xml)
}

fn inspect_archive<R: Read + Seek>(
    mut archive: ZipArchive<R>,
    fingerprint: String,
    file_name: String,
    size_bytes: u64,
) -> Result<DocxInspection, String> {
    let names = validate_archive(&mut archive)?;
    if !names.iter().any(|name| name == "[Content_Types].xml") {
        return Err("File is not a valid DOCX package".to_string());
    }
    if !names.iter().any(|name| name == "word/document.xml") {
        return Err("DOCX is missing word/document.xml".to_string());
    }
    let mut parts = vec!["word/document.xml".to_string()];
    let mut headers = names
        .iter()
        .filter(|name| name.starts_with("word/header") && name.ends_with(".xml"))
        .cloned()
        .collect::<Vec<_>>();
    let mut footers = names
        .iter()
        .filter(|name| name.starts_with("word/footer") && name.ends_with(".xml"))
        .cloned()
        .collect::<Vec<_>>();
    headers.sort();
    footers.sort();
    parts.extend(headers);
    parts.extend(footers);

    let mut parsed = Vec::new();
    let mut has_revisions = false;
    let mut has_formulas = false;
    for part in parts {
        let xml = read_xml_part(&mut archive, &part)?;
        let parsed_part = parse_document_part(&part, &xml)?;
        parsed.extend(parsed_part.paragraphs);
        has_revisions |= parsed_part.has_revisions;
        has_formulas |= parsed_part.has_formulas;
    }

    let mut segments = Vec::new();
    for paragraph in parsed {
        for (chunk_index, chunk) in split_utf8(&paragraph.text).into_iter().enumerate() {
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
                source_position: format!("paragraph:{}:chunk:{chunk_index}", paragraph.position),
                structure: paragraph.structure.clone(),
                source_text: chunk.to_string(),
            });
        }
    }
    if segments.is_empty() {
        return Err("DOCX contains no translatable text".to_string());
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

    Ok(DocxInspection {
        fingerprint,
        file_name,
        size_bytes,
        segments,
        warnings,
    })
}

pub fn inspect_docx_path(path: &Path) -> Result<DocxInspection, String> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("docx"))
    {
        return Err("Only .docx Word files are supported".to_string());
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("Cannot inspect DOCX file: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("DOCX input must be a non-empty file".to_string());
    }
    if metadata.len() > MAX_DOCX_BYTES {
        return Err("DOCX input exceeds the 50 MiB limit".to_string());
    }
    let mut file = File::open(path).map_err(|error| format!("Cannot open DOCX file: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read DOCX file: {error}"))?;
    let fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    let archive = ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("Invalid DOCX ZIP container: {error}"))?;
    inspect_archive(
        archive,
        fingerprint,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document.docx")
            .to_string(),
        metadata.len(),
    )
}

#[tauri::command]
pub fn inspect_docx_document(path: String) -> Result<DocxInspection, String> {
    inspect_docx_path(&PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::{inspect_archive, inspect_docx_path, MAX_SEGMENT_BYTES};
    use std::io::{Cursor, Write};
    use std::path::Path;
    use zip::write::SimpleFileOptions;

    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;

    fn docx(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options = SimpleFileOptions::default();
            writer.start_file("[Content_Types].xml", options).unwrap();
            writer.write_all(CONTENT_TYPES.as_bytes()).unwrap();
            for (name, content) in parts {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        output.into_inner()
    }

    fn inspect(parts: &[(&str, &str)]) -> Result<super::DocxInspection, String> {
        let bytes = docx(parts);
        inspect_archive(
            zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap(),
            "sha256:fixture".to_string(),
            "fixture.docx".to_string(),
            bytes.len() as u64,
        )
    }

    #[test]
    fn extracts_stable_structures_in_document_order() {
        let document = include_str!("../tests/fixtures/docx/document.xml");
        let header = include_str!("../tests/fixtures/docx/header1.xml");
        let footer = include_str!("../tests/fixtures/docx/footer1.xml");
        let result = inspect(&[
            ("word/document.xml", document),
            ("word/header1.xml", header),
            ("word/footer1.xml", footer),
        ])
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
        let second = inspect(&[
            ("word/document.xml", document),
            ("word/header1.xml", header),
            ("word/footer1.xml", footer),
        ])
        .unwrap();
        assert_eq!(result.segments, second.segments);
    }

    #[test]
    fn splits_multibyte_paragraphs_at_the_byte_limit() {
        let long_text = "译".repeat(20_000);
        let xml = format!(
            r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>{long_text}</w:t></w:r></w:p></w:body></w:document>"#
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
    }

    #[test]
    fn reports_unsupported_non_text_content_without_extracting_it() {
        let document = r#"<w:document xmlns:w="w" xmlns:m="m"><w:body><w:ins><w:p><w:r><w:t>Visible</w:t></w:r></w:p></w:ins><m:oMath/></w:body></w:document>"#;
        let result = inspect(&[
            ("word/document.xml", document),
            ("word/comments.xml", "<w:comments xmlns:w=\"w\"/>"),
            ("word/media/image1.png", "not-real-image"),
            ("word/embeddings/object1.bin", "private-binary"),
        ])
        .unwrap();
        assert_eq!(result.segments[0].source_text, "Visible");
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
            ]
        );
    }

    #[test]
    fn rejects_missing_main_part_and_malformed_xml() {
        assert!(inspect(&[("word/styles.xml", "<w:styles/>")])
            .unwrap_err()
            .contains("word/document.xml"));
        assert!(inspect(&[("word/document.xml", "<w:document><w:p>")])
            .unwrap_err()
            .contains("Invalid DOCX XML"));
    }

    #[test]
    fn rejects_legacy_doc_before_opening_it() {
        assert!(inspect_docx_path(Path::new("legacy.doc"))
            .unwrap_err()
            .contains("Only .docx"));
    }
}
