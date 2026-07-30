use crate::db;
use base64::{engine::general_purpose, Engine as _};
use rusqlite::Connection;
use screenshots::Screen;
use screenshots::image::{imageops::FilterType, load_from_memory, DynamicImage, ImageFormat};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Cursor;
use tauri::{AppHandle, Emitter, Manager};
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Storage::Streams::InMemoryRandomAccessStream;
use windows::Globalization::Language;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OcrLanguageInfo {
    pub tag: String,
    pub display_name: String,
    pub native_name: String,
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve application data directory: {error}"))?;
    db::init_db(app_dir).map_err(|error| error.to_string())
}

fn configured_language(conn: &Connection) -> Result<String, String> {
    db::get_config(conn, "ocr_lang")
        .map_err(|error| format!("Cannot read configured OCR language: {error}"))
}

fn decode_image_payload(image_base64: &str) -> Result<Vec<u8>, String> {
    let payload = image_base64
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:") && prefix.ends_with(";base64"))
        .map_or(image_base64, |(_, payload)| payload);
    if payload.trim().is_empty() {
        return Err("OCR image payload is empty".to_string());
    }
    general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("Cannot decode OCR image: {error}"))
}

fn confirmed_text(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() {
        Err("OCR text is empty".to_string())
    } else {
        Ok(text)
    }
}

fn normalize_ocr_languages(mut languages: Vec<OcrLanguageInfo>) -> Vec<OcrLanguageInfo> {
    languages.retain(|language| !language.tag.trim().is_empty());
    languages.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.tag.to_lowercase().cmp(&right.tag.to_lowercase()))
    });
    let mut seen_tags = HashSet::new();
    languages.retain(|language| seen_tags.insert(language.tag.to_lowercase()));
    languages
}

pub fn available_ocr_languages() -> Result<Vec<OcrLanguageInfo>, Box<dyn std::error::Error>> {
    let languages = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|error| format!("Failed to enumerate OCR languages: {error}"))?;
    let result = languages
        .into_iter()
        .filter_map(|language| {
            let tag = language.LanguageTag().ok()?.to_string();
            let display_name = language.DisplayName().ok()?.to_string();
            let native_name = language.NativeName().ok()?.to_string();
            Some(OcrLanguageInfo {
                tag,
                display_name,
                native_name,
            })
        })
        .collect();
    Ok(normalize_ocr_languages(result))
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut buffer = Cursor::new(Vec::new());
    image.write_to(&mut buffer, ImageFormat::Png)?;
    Ok(buffer.into_inner())
}

fn prepare_ocr_images(
    image_bytes: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), Box<dyn std::error::Error>> {
    let source = load_from_memory(image_bytes)?;
    let longest_side = source.width().max(source.height()).max(1);
    let desired_scale: f32 = if source.height() < 80 { 3.0 } else if source.height() < 160 { 2.0 } else { 1.5 };
    let max_scale = 2600.0 / longest_side as f32;
    let scale = desired_scale.min(max_scale).max(1.0);
    let width = ((source.width() as f32 * scale).round() as u32).max(1);
    let height = ((source.height() as f32 * scale).round() as u32).max(1);

    let resized = source.resize_exact(width, height, FilterType::CatmullRom);
    let enhanced = resized.grayscale().adjust_contrast(38.0).unsharpen(1.0, 1);

    let mut binary = enhanced.to_luma8();
    let mean = binary.pixels().map(|pixel| pixel[0] as u64).sum::<u64>()
        / (binary.width() as u64 * binary.height() as u64).max(1);
    for pixel in binary.pixels_mut() {
        pixel[0] = if pixel[0] as u64 > mean { 255 } else { 0 };
    }

    Ok((
        encode_png(&enhanced)?,
        encode_png(&DynamicImage::ImageLuma8(binary))?,
    ))
}

fn text_quality_score(text: &str) -> usize {
    let meaningful = text.chars().filter(|character| character.is_alphanumeric()).count();
    let line_bonus = text.lines().filter(|line| !line.trim().is_empty()).count().min(8);
    let noise = text.chars().filter(|character| *character == '\u{fffd}').count() * 4;
    meaningful.saturating_add(line_bonus).saturating_sub(noise)
}

#[cfg(test)]
fn ocr_evaluation_characters(text: &str) -> Vec<char> {
    text.chars()
        .flat_map(char::to_uppercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

#[cfg(test)]
fn character_error_rate(reference: &str, hypothesis: &str) -> f64 {
    let expected = ocr_evaluation_characters(reference);
    let actual = ocr_evaluation_characters(hypothesis);
    if expected.is_empty() {
        return if actual.is_empty() { 0.0 } else { 1.0 };
    }

    let mut previous: Vec<usize> = (0..=actual.len()).collect();
    for (expected_index, expected_character) in expected.iter().enumerate() {
        let mut current = vec![expected_index + 1];
        for (actual_index, actual_character) in actual.iter().enumerate() {
            current.push(
                (current[actual_index] + 1)
                    .min(previous[actual_index + 1] + 1)
                    .min(
                        previous[actual_index]
                            + usize::from(expected_character != actual_character),
                    ),
            );
        }
        previous = current;
    }
    previous[actual.len()] as f64 / expected.len() as f64
}

fn recognize_image(
    engine: &OcrEngine,
    image_bytes: &[u8],
) -> Result<String, Box<dyn std::error::Error>> {
    let stream = InMemoryRandomAccessStream::new().map_err(|e| format!("Failed to create stream: {}", e))?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| format!("Failed to create writer: {}", e))?;
    writer.WriteBytes(image_bytes).map_err(|e| format!("Failed to write bytes: {}", e))?;
    writer.StoreAsync().map_err(|e| format!("Failed to store async: {}", e))?.get().map_err(|e| format!("StoreAsync get failed: {}", e))?;
    writer.FlushAsync().map_err(|e| format!("Failed to flush async: {}", e))?.get().map_err(|e| format!("FlushAsync get failed: {}", e))?;

    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(|e| format!("Failed to create decoder: {}", e))?.get().map_err(|e| format!("CreateAsync get failed: {}", e))?;
    let bitmap = decoder.GetSoftwareBitmapAsync().map_err(|e| format!("Failed to get bitmap: {}", e))?.get().map_err(|e| format!("GetSoftwareBitmapAsync get failed: {}", e))?;
    let result = engine.RecognizeAsync(&bitmap).map_err(|e| format!("Failed to recognize: {}", e))?.get().map_err(|e| format!("RecognizeAsync get failed: {}", e))?;
    let text = result.Text().map_err(|e| format!("Failed to get text: {}", e))?;
    Ok(text.to_string())
}

fn create_ocr_engine(lang: &str) -> Result<OcrEngine, Box<dyn std::error::Error>> {
    if !lang.trim().is_empty() && !lang.eq_ignore_ascii_case("auto") {
        let lang_hstr = windows::core::HSTRING::from(lang);
        if let Ok(language) = Language::CreateLanguage(&lang_hstr) {
            if OcrEngine::IsLanguageSupported(&language).unwrap_or(false) {
                return OcrEngine::TryCreateFromLanguage(&language)
                    .map_err(|error| format!("Failed to create OcrEngine for {lang}: {error}").into());
            }
        }
    }

    OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|error| format!("Failed to create default OcrEngine: {error}").into())
}

async fn recognize_text(image_bytes: Vec<u8>, lang: &str) -> Result<String, Box<dyn std::error::Error>> {
    let engine = create_ocr_engine(lang)?;
    let original = recognize_image(&engine, &image_bytes)?;
    let mut best = original;
    let mut best_score = text_quality_score(&best);

    // Always compare against a scale/contrast optimized pass. If both results
    // are weak, add a binary pass for low-contrast subtitles and UI text.
    if let Ok((enhanced, binary)) = prepare_ocr_images(&image_bytes) {
        if let Ok(candidate) = recognize_image(&engine, &enhanced) {
            let score = text_quality_score(&candidate);
            if score > best_score {
                best = candidate;
                best_score = score;
            }
        }
        if best_score < 8 {
            if let Ok(candidate) = recognize_image(&engine, &binary) {
                if text_quality_score(&candidate) > best_score {
                    best = candidate;
                }
            }
        }
    }

    Ok(best)
}

fn capture_center(x: i32, y: i32, w: u32, h: u32) -> Result<(i32, i32), String> {
    if w == 0 || h == 0 {
        return Err("OCR capture dimensions must be positive".to_string());
    }
    let half_width =
        i32::try_from(w / 2).map_err(|_| "OCR capture width is too large".to_string())?;
    let half_height =
        i32::try_from(h / 2).map_err(|_| "OCR capture height is too large".to_string())?;
    let center_x = x
        .checked_add(half_width)
        .ok_or_else(|| "OCR capture horizontal bounds overflow".to_string())?;
    let center_y = y
        .checked_add(half_height)
        .ok_or_else(|| "OCR capture vertical bounds overflow".to_string())?;
    Ok((center_x, center_y))
}

pub fn capture_rect(x: i32, y: i32, w: u32, h: u32) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let screens = Screen::all()?;
    let (center_x, center_y) = capture_center(x, y, w, h)?;

    let screen = screens.iter().find(|s| {
        let display = s.display_info;
        center_x >= display.x && center_x < display.x + display.width as i32 &&
        center_y >= display.y && center_y < display.y + display.height as i32
    }).or_else(|| {
        screens.first()
    }).ok_or("No screen found")?;

    let local_x = x - screen.display_info.x;
    let local_y = y - screen.display_info.y;

    let image = screen.capture_area(local_x, local_y, w, h)?;
    let mut buffer = Vec::new();
    image.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png)?;
    Ok(buffer)
}

#[tauri::command]
pub async fn run_ocr(app: AppHandle, image_base64: String) -> Result<String, String> {
    let conn = open_database(&app)?;
    let ocr_lang = configured_language(&conn)?;
    let bytes = decode_image_payload(&image_base64)?;
    recognize_text(bytes, &ocr_lang)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn capture_and_ocr(
    app: AppHandle,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<String, String> {
    let conn = open_database(&app)?;
    let ocr_lang = configured_language(&conn)?;
    let bytes = capture_rect(x, y, w, h).map_err(|error| error.to_string())?;
    recognize_text(bytes, &ocr_lang)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn confirm_ocr_text(app: AppHandle, text: String) -> Result<(), String> {
    let text = confirmed_text(&text)?;
    if let Some(overlay) = app.get_webview_window("ocr-overlay") {
        let _ = overlay.hide();
    }
    if let Some(floating) = app.get_webview_window("floating") {
        let _ = floating.show();
        let _ = floating.set_focus();
    }
    app.emit("ocr-triggered", text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_available_ocr_languages() -> Result<Vec<OcrLanguageInfo>, String> {
    available_ocr_languages().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        available_ocr_languages, capture_center, character_error_rate, confirmed_text,
        create_ocr_engine, decode_image_payload, normalize_ocr_languages, prepare_ocr_images,
        recognize_text, text_quality_score, OcrLanguageInfo,
    };
    use font8x8::{UnicodeFonts, BASIC_FONTS};
    use screenshots::image::{DynamicImage, GenericImageView, ImageFormat, RgbaImage};
    use std::io::Cursor;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    struct OcrImageCase {
        id: &'static str,
        text: &'static str,
        scale: u32,
        dark: bool,
        max_cer: f64,
    }

    fn render_text_fixture(text: &str, scale: u32, dark: bool) -> Vec<u8> {
        let padding = scale * 3;
        let glyph_width = scale * 8;
        let width = padding * 2 + glyph_width * text.chars().count() as u32;
        let height = padding * 2 + scale * 8;
        let background = if dark { 20 } else { 245 };
        let foreground = if dark { 245 } else { 20 };
        let mut image = RgbaImage::from_pixel(
            width,
            height,
            screenshots::image::Rgba([background, background, background, 255]),
        );

        for (character_index, character) in text.chars().enumerate() {
            let Some(glyph) = BASIC_FONTS.get(character) else {
                continue;
            };
            for (row, bits) in glyph.iter().enumerate() {
                for column in 0..8 {
                    if bits & (1 << column) == 0 {
                        continue;
                    }
                    let origin_x = padding
                        + character_index as u32 * glyph_width
                        + column * scale;
                    let origin_y = padding + row as u32 * scale;
                    for offset_y in 0..scale {
                        for offset_x in 0..scale {
                            image.put_pixel(
                                origin_x + offset_x,
                                origin_y + offset_y,
                                screenshots::image::Rgba([
                                    foreground,
                                    foreground,
                                    foreground,
                                    255,
                                ]),
                            );
                        }
                    }
                }
            }
        }

        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut output, ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }

    #[test]
    fn preprocessing_upscales_small_capture_and_produces_valid_pngs() {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            40,
            20,
            screenshots::image::Rgba([120, 120, 120, 255]),
        ));
        let mut source = Cursor::new(Vec::new());
        image.write_to(&mut source, ImageFormat::Png).unwrap();

        let (enhanced, binary) = prepare_ocr_images(source.get_ref()).unwrap();
        let enhanced_image = screenshots::image::load_from_memory(&enhanced).unwrap();
        let binary_image = screenshots::image::load_from_memory(&binary).unwrap();

        assert_eq!(enhanced_image.dimensions(), (120, 60));
        assert_eq!(binary_image.dimensions(), (120, 60));
    }

    #[test]
    fn text_quality_prefers_meaningful_text_over_replacement_noise() {
        assert!(text_quality_score("Hello world 123") > text_quality_score("\u{fffd}\u{fffd}\u{fffd}"));
    }

    #[test]
    fn command_inputs_decode_data_urls_trim_text_and_reject_unsafe_captures() {
        assert_eq!(decode_image_payload("SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(
            decode_image_payload("data:image/png;base64,SGVsbG8=").unwrap(),
            b"Hello"
        );
        assert!(decode_image_payload("").unwrap_err().contains("empty"));
        assert_eq!(confirmed_text("  recognized text \n").unwrap(), "recognized text");
        assert_eq!(confirmed_text(" \n ").unwrap_err(), "OCR text is empty");
        assert_eq!(capture_center(-100, -50, 20, 10).unwrap(), (-90, -45));
        assert!(capture_center(0, 0, 0, 10).unwrap_err().contains("positive"));
        assert!(capture_center(i32::MAX, 0, 2, 2)
            .unwrap_err()
            .contains("overflow"));
    }

    #[test]
    fn character_error_rate_counts_substitutions_and_ignores_layout_whitespace() {
        assert_eq!(character_error_rate("HELLO 2026", "hello\n2026"), 0.0);
        assert!((character_error_rate("CAT", "CUT") - (1.0 / 3.0)).abs() < f64::EPSILON);
        assert_eq!(character_error_rate("", "unexpected"), 1.0);
    }

    #[test]
    fn installed_languages_are_sorted_deduplicated_and_empty_tags_removed() {
        let languages = normalize_ocr_languages(vec![
            OcrLanguageInfo {
                tag: "zh-Hans-CN".to_string(),
                display_name: "Chinese".to_string(),
                native_name: "中文".to_string(),
            },
            OcrLanguageInfo {
                tag: "EN-us".to_string(),
                display_name: "English".to_string(),
                native_name: "English".to_string(),
            },
            OcrLanguageInfo {
                tag: "en-US".to_string(),
                display_name: "Zulu duplicate".to_string(),
                native_name: "English".to_string(),
            },
            OcrLanguageInfo {
                tag: " ".to_string(),
                display_name: "Invalid".to_string(),
                native_name: "Invalid".to_string(),
            },
        ]);

        assert_eq!(languages.len(), 2);
        assert_eq!(languages[0].tag, "zh-Hans-CN");
        assert_eq!(languages[1].tag, "EN-us");
    }

    #[test]
    fn windows_exposes_at_least_one_installed_ocr_language() {
        let languages = available_ocr_languages().unwrap();
        assert!(!languages.is_empty());
        assert!(languages.iter().all(|language| !language.tag.is_empty()));
    }

    #[test]
    fn unsupported_saved_language_falls_back_to_the_windows_default() {
        assert!(create_ocr_engine("not-a-real-language").is_ok());
        assert!(create_ocr_engine("AUTO").is_ok());
    }

    #[tokio::test]
    async fn generated_png_gold_cases_stay_within_the_windows_ocr_cer_gate() {
        let language = Language::CreateLanguage(&windows::core::HSTRING::from("en-US")).unwrap();
        let language_supported = OcrEngine::IsLanguageSupported(&language).unwrap_or(false);
        if !language_supported {
            let language_is_required = std::env::var("LONG_TRANSLATE_REQUIRE_EN_US_OCR")
                .is_ok_and(|value| value == "1");
            assert!(
                !language_is_required,
                "The quality runner must provide the en-US Windows OCR language"
            );
            eprintln!(
                "Skipping the generated OCR gold cases because en-US is not installed; \
                 set LONG_TRANSLATE_REQUIRE_EN_US_OCR=1 to enforce the quality-runner contract"
            );
            return;
        }

        let cases = [
            OcrImageCase {
                id: "small-ui-text",
                text: "HELLO 2026",
                scale: 3,
                dark: false,
                max_cer: 0.2,
            },
            OcrImageCase {
                id: "dark-subtitle",
                text: "FOCUS NOW",
                scale: 5,
                dark: true,
                max_cer: 0.2,
            },
            OcrImageCase {
                id: "scaled-display",
                text: "SCALE 150",
                scale: 7,
                dark: false,
                max_cer: 0.2,
            },
        ];

        let mut report_cases = Vec::new();
        for quality_case in cases {
            let png = render_text_fixture(quality_case.text, quality_case.scale, quality_case.dark);
            let recognized = recognize_text(png, "en-US").await.unwrap();
            let cer = character_error_rate(quality_case.text, &recognized);
            eprintln!(
                "{}: expected={:?}, recognized={:?}, cer={:.3}",
                quality_case.id, quality_case.text, recognized, cer
            );
            report_cases.push(serde_json::json!({
                "id": quality_case.id,
                "cer": (cer * 10_000.0).round() / 10_000.0,
                "max_cer": quality_case.max_cer,
                "passed": cer <= quality_case.max_cer,
            }));
            assert!(
                cer <= quality_case.max_cer,
                "{} CER {:.3} exceeded {:.3}; recognized {:?}",
                quality_case.id,
                cer,
                quality_case.max_cer,
                recognized
            );
        }

        if let Ok(report_directory) = std::env::var("LONG_TRANSLATE_QUALITY_REPORT_DIR") {
            let report_directory = std::path::PathBuf::from(report_directory);
            std::fs::create_dir_all(&report_directory).unwrap();
            let max_observed_cer = report_cases
                .iter()
                .filter_map(|result| result.get("cer").and_then(serde_json::Value::as_f64))
                .fold(0.0_f64, f64::max);
            let report = serde_json::json!({
                "engine": "Windows.Media.Ocr",
                "language": "en-US",
                "case_count": report_cases.len(),
                "max_observed_cer": max_observed_cer,
                "passed": report_cases.iter().all(|result| result["passed"] == true),
                "cases": report_cases,
            });
            std::fs::write(
                report_directory.join("ocr-runtime.json"),
                serde_json::to_vec_pretty(&report).unwrap(),
            )
            .unwrap();
        }
    }
}
