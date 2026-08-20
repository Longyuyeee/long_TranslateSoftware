use lopdf::{Document, LoadOptions};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use unicode_segmentation::UnicodeSegmentation;

const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PAGES: usize = 2_000;
const MAX_OBJECTS: usize = 100_000;
const MAX_STREAM_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGE_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 32 * 1024;
const MAX_SEGMENTS: usize = 20_000;
const MAX_TOTAL_TEXT_BYTES: usize = 24 * 1024 * 1024;
const MAX_INSPECTION_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfImportErrorCode {
    UnsupportedFormat,
    InputTooLarge,
    InvalidInput,
    EncryptedPdf,
    TextLayerRequired,
    ParseFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PdfImportError {
    pub code: PdfImportErrorCode,
    pub message: String,
}

impl PdfImportError {
    fn new(code: PdfImportErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn unsupported_format(message: impl Into<String>) -> Self {
        Self::new(PdfImportErrorCode::UnsupportedFormat, message)
    }

    fn input_too_large(message: impl Into<String>) -> Self {
        Self::new(PdfImportErrorCode::InputTooLarge, message)
    }

    fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(PdfImportErrorCode::InvalidInput, message)
    }

    fn encrypted_pdf(message: impl Into<String>) -> Self {
        Self::new(PdfImportErrorCode::EncryptedPdf, message)
    }

    fn text_layer_required(message: impl Into<String>) -> Self {
        Self::new(PdfImportErrorCode::TextLayerRequired, message)
    }

    fn parse_failed(message: impl Into<String>) -> Self {
        Self::new(PdfImportErrorCode::ParseFailed, message)
    }
}

impl Display for PdfImportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PdfImportError {}

type ImportResult<T> = Result<T, PdfImportError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSegment {
    pub id: String,
    pub order: usize,
    pub page: u32,
    pub source_position: String,
    pub structure: String,
    pub source_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfImportWarning {
    pub code: String,
    pub message: String,
    pub page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInspection {
    pub fingerprint: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub page_count: usize,
    pub segments: Vec<PdfSegment>,
    pub warnings: Vec<PdfImportWarning>,
}

fn warning(code: &str, message: &str, page: Option<u32>) -> PdfImportWarning {
    PdfImportWarning {
        code: code.to_string(),
        message: message.to_string(),
        page,
    }
}

fn split_bounded_text(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if text.len() <= MAX_SEGMENT_BYTES {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut chunk = String::new();
    for grapheme in text.graphemes(true) {
        if !chunk.is_empty() && chunk.len() + grapheme.len() > MAX_SEGMENT_BYTES {
            chunks.push(std::mem::take(&mut chunk));
        }
        chunk.push_str(grapheme);
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

fn page_lines(text: &str) -> Vec<String> {
    text.replace('\0', "")
        .replace('\u{000c}', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .flat_map(split_bounded_text)
        .collect()
}

fn load_pdf(bytes: &[u8]) -> ImportResult<Document> {
    let parsed = std::panic::catch_unwind(|| {
        Document::load_mem_with_options(
            bytes,
            LoadOptions {
                max_decompressed_size: Some(MAX_STREAM_BYTES),
                ..Default::default()
            },
        )
    })
    .map_err(|_| PdfImportError::parse_failed("PDF parser stopped on an invalid document"))?;
    match parsed {
        Ok(document) => Ok(document),
        Err(
            lopdf::Error::AlreadyEncrypted
            | lopdf::Error::Decryption(_)
            | lopdf::Error::InvalidPassword
            | lopdf::Error::UnsupportedSecurityHandler(_),
        ) => Err(PdfImportError::encrypted_pdf(
            "Encrypted PDF documents are not supported",
        )),
        Err(error) => Err(PdfImportError::parse_failed(format!(
            "Cannot parse PDF: {error}"
        ))),
    }
}

pub(crate) fn inspect_pdf_bytes(bytes: &[u8], file_name: String) -> ImportResult<PdfInspection> {
    if bytes.is_empty() {
        return Err(PdfImportError::invalid_input(
            "PDF input must be a non-empty file",
        ));
    }
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(PdfImportError::input_too_large(
            "PDF input exceeds the 50 MiB limit",
        ));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(PdfImportError::invalid_input(
            "The selected file is not a PDF document",
        ));
    }

    let document = load_pdf(bytes)?;
    if document.was_encrypted() || document.is_encrypted() {
        return Err(PdfImportError::encrypted_pdf(
            "Encrypted PDF documents are not supported",
        ));
    }
    if document.objects.len() > MAX_OBJECTS {
        return Err(PdfImportError::input_too_large(
            "PDF object count exceeds the supported limit",
        ));
    }

    let pages = document.get_pages();
    if pages.is_empty() {
        return Err(PdfImportError::invalid_input(
            "PDF document does not contain any pages",
        ));
    }
    if pages.len() > MAX_PAGES {
        return Err(PdfImportError::input_too_large(
            "PDF page count exceeds the supported limit",
        ));
    }

    let mut segments = Vec::new();
    let mut warnings = vec![warning(
        "reading-order-inferred",
        "PDF text order is inferred from the content stream and must be reviewed before translation",
        None,
    )];
    let mut total_text_bytes = 0usize;

    for (page_number, page_id) in &pages {
        let text = document
            .extract_text_with_limit(&[*page_number], MAX_PAGE_CONTENT_BYTES)
            .map_err(|error| {
                PdfImportError::parse_failed(format!(
                    "Cannot extract bounded text from PDF page {page_number}: {error}"
                ))
            })?;
        let lines = page_lines(&text);
        if lines.is_empty() {
            warnings.push(warning(
                "page-text-missing",
                "No selectable text was found on this page",
                Some(*page_number),
            ));
        }
        if document
            .get_page_images(*page_id)
            .is_ok_and(|images| !images.is_empty())
        {
            warnings.push(warning(
                "images-ignored",
                "Images are not included in the PDF translation text",
                Some(*page_number),
            ));
        }
        if document
            .get_page_annotations(*page_id)
            .is_ok_and(|annotations| !annotations.is_empty())
        {
            warnings.push(warning(
                "annotations-ignored",
                "PDF annotations are not included in the translation text",
                Some(*page_number),
            ));
        }

        for (line_index, line) in lines.into_iter().enumerate() {
            total_text_bytes = total_text_bytes.checked_add(line.len()).ok_or_else(|| {
                PdfImportError::input_too_large("PDF text size exceeds the supported limit")
            })?;
            if total_text_bytes > MAX_TOTAL_TEXT_BYTES {
                return Err(PdfImportError::input_too_large(
                    "PDF text exceeds the 24 MiB limit",
                ));
            }
            if segments.len() >= MAX_SEGMENTS {
                return Err(PdfImportError::input_too_large(
                    "PDF segment count exceeds the supported limit",
                ));
            }
            let order = segments.len();
            segments.push(PdfSegment {
                id: format!("pdf:{page_number}:{line_index}"),
                order,
                page: *page_number,
                source_position: format!("page:{page_number}:line:{line_index}"),
                structure: "paragraph".to_string(),
                source_text: line,
            });
        }
    }

    if segments.is_empty() {
        return Err(PdfImportError::text_layer_required(
            "PDF translation requires a selectable text layer",
        ));
    }

    let inspection = PdfInspection {
        fingerprint: format!("sha256:{}", hex::encode(Sha256::digest(bytes))),
        file_name,
        size_bytes: bytes.len() as u64,
        page_count: pages.len(),
        segments,
        warnings,
    };
    let serialized_size = serde_json::to_vec(&inspection)
        .map_err(|error| {
            PdfImportError::parse_failed(format!("Cannot serialize PDF inspection: {error}"))
        })?
        .len();
    if serialized_size > MAX_INSPECTION_BYTES {
        return Err(PdfImportError::input_too_large(
            "PDF inspection result exceeds the 48 MiB limit",
        ));
    }
    Ok(inspection)
}

fn read_input_with_limit<R: Read>(reader: &mut R) -> ImportResult<Vec<u8>> {
    let mut bytes = Vec::with_capacity(1024 * 1024);
    reader
        .take(MAX_PDF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| PdfImportError::invalid_input(format!("Cannot read PDF file: {error}")))?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(PdfImportError::input_too_large(
            "PDF input exceeds the 50 MiB limit",
        ));
    }
    Ok(bytes)
}

pub fn inspect_pdf_path(path: &Path) -> ImportResult<PdfInspection> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("pdf"))
    {
        return Err(PdfImportError::unsupported_format(
            "Only .pdf documents are supported",
        ));
    }
    let file = File::open(path)
        .map_err(|error| PdfImportError::invalid_input(format!("Cannot open PDF file: {error}")))?;
    let metadata = file.metadata().map_err(|error| {
        PdfImportError::invalid_input(format!("Cannot inspect PDF file: {error}"))
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(PdfImportError::invalid_input(
            "PDF input must be a non-empty file",
        ));
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err(PdfImportError::input_too_large(
            "PDF input exceeds the 50 MiB limit",
        ));
    }
    let mut file = file;
    let bytes = read_input_with_limit(&mut file)?;
    inspect_pdf_bytes(
        &bytes,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document.pdf")
            .to_string(),
    )
}

fn dialog_label(value: String, fallback: &str) -> String {
    let value = value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect::<String>();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn local_dialog_path(path: FilePath) -> ImportResult<PathBuf> {
    match path {
        FilePath::Path(path) => Ok(path),
        FilePath::Url(url) => url.to_file_path().map_err(|_| {
            PdfImportError::invalid_input("The selected PDF path is not a local file")
        }),
    }
}

#[tauri::command]
pub fn pick_pdf_document(
    app: AppHandle,
    title: String,
    filter_name: String,
) -> ImportResult<Option<String>> {
    let title = dialog_label(title, "Select a PDF document");
    let filter_name = dialog_label(filter_name, "PDF document (*.pdf)");
    let selected = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(filter_name, &["pdf"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = local_dialog_path(selected)?;
    path.to_str()
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| PdfImportError::invalid_input("The selected PDF path is not valid Unicode"))
}

#[tauri::command]
pub fn inspect_pdf_document(path: String) -> ImportResult<PdfInspection> {
    inspect_pdf_path(&PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::{inspect_pdf_bytes, PdfImportErrorCode, MAX_SEGMENT_BYTES};
    use lopdf::content::{Content, Operation};
    use lopdf::{
        dictionary, Document, EncryptionState, EncryptionVersion, Object, Permissions, Stream,
    };
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    struct PublicPdfCase {
        file_name: &'static str,
        sha256: &'static str,
        page_count: usize,
        minimum_text_bytes: usize,
        required_text: &'static [&'static str],
    }

    fn test_pdf(text: Option<&str>) -> Vec<u8> {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let operations = text.map_or_else(Vec::new, |text| {
            vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 12.into()]),
                Operation::new("Td", vec![72.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ]
        });
        let content = Content { operations }.encode().unwrap();
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        document.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            }),
        );
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.compress();
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn extracts_page_level_text_with_stable_locations() {
        let bytes = test_pdf(Some("Expected public PDF text"));
        let inspection = inspect_pdf_bytes(&bytes, "sample.pdf".to_string()).unwrap();
        assert_eq!(inspection.page_count, 1);
        assert_eq!(inspection.segments.len(), 1);
        assert_eq!(inspection.segments[0].page, 1);
        assert_eq!(inspection.segments[0].source_position, "page:1:line:0");
        assert_eq!(
            inspection.segments[0].source_text,
            "Expected public PDF text"
        );
        assert!(inspection.segments[0].source_text.len() <= MAX_SEGMENT_BYTES);
    }

    #[test]
    fn rejects_documents_without_a_selectable_text_layer() {
        let error = inspect_pdf_bytes(&test_pdf(None), "scan.pdf".to_string()).unwrap_err();
        assert_eq!(error.code, PdfImportErrorCode::TextLayerRequired);
    }

    fn encrypted_test_pdf(user_password: &str) -> Vec<u8> {
        let source = test_pdf(Some("secret"));
        let mut document = Document::load_mem(&source).unwrap();
        document.trailer.set(
            "ID",
            Object::Array(vec![
                Object::string_literal(vec![1u8; 16]),
                Object::string_literal(vec![2u8; 16]),
            ]),
        );
        let state = EncryptionState::try_from(EncryptionVersion::V1 {
            document: &document,
            owner_password: "owner",
            user_password,
            permissions: Permissions::PRINTABLE,
        })
        .unwrap();
        document.encrypt(&state).unwrap();
        let mut encrypted = Vec::new();
        document.save_to(&mut encrypted).unwrap();
        encrypted
    }

    #[test]
    fn rejects_encrypted_documents_even_when_a_password_is_empty() {
        let encrypted = encrypted_test_pdf("");
        let error = inspect_pdf_bytes(&encrypted, "encrypted.pdf".to_string()).unwrap_err();
        assert_eq!(error.code, PdfImportErrorCode::EncryptedPdf);
    }

    #[test]
    fn reports_password_protected_documents_as_encrypted() {
        let encrypted = encrypted_test_pdf("user-secret");
        let error = inspect_pdf_bytes(&encrypted, "protected.pdf".to_string()).unwrap_err();
        assert_eq!(error.code, PdfImportErrorCode::EncryptedPdf);
    }

    #[test]
    fn rejects_non_pdf_bytes_before_parsing() {
        let error = inspect_pdf_bytes(b"not a pdf", "fake.pdf".to_string()).unwrap_err();
        assert_eq!(error.code, PdfImportErrorCode::InvalidInput);
    }

    #[test]
    #[ignore = "requires the explicitly downloaded public PDF acceptance corpus"]
    fn inspects_real_public_pdf_corpus_against_recorded_expectations() {
        let corpus_dir = std::env::var_os("LONG_TRANSLATE_PDF_ACCEPTANCE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join(".pdf-acceptance")
            });
        let cases = [
            PublicPdfCase {
                file_name: "easy-read-guidance.pdf",
                sha256: "4eeaaa58f2dd453528e6b46fd38e09f09354f590829b0110434bcbd9895c0c3c",
                page_count: 40,
                minimum_text_bytes: 45_000,
                required_text: &["Making written information", "learning disabilities"],
            },
            PublicPdfCase {
                file_name: "know-the-warnings.pdf",
                sha256: "55c41c41728ddae50c92a80a9963624c4d96895918c462549f1911d163016134",
                page_count: 1,
                minimum_text_bytes: 1_500,
                required_text: &["Know the warnings", "Australian Warning System"],
            },
            PublicPdfCase {
                file_name: "know-your-neighbours.pdf",
                sha256: "c02f188227d09b5220d8f7fb3d36f5ba15abe8a04793e49fe85b7c33f462919d",
                page_count: 1,
                minimum_text_bytes: 1_150,
                required_text: &["Your neighbours can help", "Making a connection"],
            },
            PublicPdfCase {
                file_name: "resource-hub.pdf",
                sha256: "b85626ba3ba32d70ddb359272834ae7d36cdf5b932fcae301d5c660295fe1de3",
                page_count: 1,
                minimum_text_bytes: 2_200,
                required_text: &[
                    "The resource hub has been developed",
                    "Frequently Asked Questions",
                ],
            },
        ];

        for case in cases {
            let path = corpus_dir.join(case.file_name);
            let bytes = std::fs::read(&path).unwrap_or_else(|error| {
                panic!("cannot read acceptance fixture {}: {error}", path.display())
            });
            assert_eq!(hex::encode(Sha256::digest(&bytes)), case.sha256);
            let inspection = inspect_pdf_bytes(&bytes, case.file_name.to_string()).unwrap();
            let text = inspection
                .segments
                .iter()
                .map(|segment| segment.source_text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            println!(
                "{} pages={} segments={} text_bytes={} replacement_chars={} warnings={:?} preview={:?}",
                case.file_name,
                inspection.page_count,
                inspection.segments.len(),
                text.len(),
                text.matches('\u{fffd}').count(),
                inspection
                    .warnings
                    .iter()
                    .map(|warning| (&warning.code, warning.page))
                    .collect::<Vec<_>>(),
                text.chars().take(240).collect::<String>(),
            );
            assert_eq!(inspection.page_count, case.page_count);
            assert!(
                text.len() >= case.minimum_text_bytes,
                "{} extracted only {} bytes; expected at least {}",
                case.file_name,
                text.len(),
                case.minimum_text_bytes
            );
            assert_eq!(
                text.matches('\u{fffd}').count(),
                0,
                "{} contains Unicode replacement characters",
                case.file_name
            );
            assert!(inspection.warnings.iter().any(|warning| {
                warning.code == "reading-order-inferred" && warning.page.is_none()
            }));
            for required in case.required_text {
                assert!(
                    text.contains(required),
                    "{} is missing expected text {required:?}",
                    case.file_name
                );
            }
        }
    }
}
