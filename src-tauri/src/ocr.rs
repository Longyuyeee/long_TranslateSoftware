use screenshots::Screen;
use screenshots::image::{imageops::FilterType, load_from_memory, DynamicImage, ImageFormat};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Cursor;
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

pub async fn run_ocr(image_bytes: Vec<u8>, lang: &str) -> Result<String, Box<dyn std::error::Error>> {
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

pub fn capture_rect(x: i32, y: i32, w: u32, h: u32) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let screens = Screen::all()?;
    let center_x = x + (w as i32 / 2);
    let center_y = y + (h as i32 / 2);

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

#[cfg(test)]
mod tests {
    use super::{
        available_ocr_languages, character_error_rate, create_ocr_engine,
        normalize_ocr_languages, prepare_ocr_images, run_ocr, text_quality_score, OcrLanguageInfo,
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
        assert!(
            OcrEngine::IsLanguageSupported(&language).unwrap_or(false),
            "The quality runner must provide the en-US Windows OCR language"
        );

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

        for quality_case in cases {
            let png = render_text_fixture(quality_case.text, quality_case.scale, quality_case.dark);
            let recognized = run_ocr(png, "en-US").await.unwrap();
            let cer = character_error_rate(quality_case.text, &recognized);
            eprintln!(
                "{}: expected={:?}, recognized={:?}, cer={:.3}",
                quality_case.id, quality_case.text, recognized, cer
            );
            assert!(
                cer <= quality_case.max_cer,
                "{} CER {:.3} exceeded {:.3}; recognized {:?}",
                quality_case.id,
                cer,
                quality_case.max_cer,
                recognized
            );
        }
    }
}
