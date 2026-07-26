use screenshots::Screen;
use screenshots::image::{imageops::FilterType, load_from_memory, DynamicImage, ImageFormat};
use std::io::Cursor;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Storage::Streams::InMemoryRandomAccessStream;
use windows::Globalization::Language;

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

pub async fn run_ocr(image_bytes: Vec<u8>, lang: &str) -> Result<String, Box<dyn std::error::Error>> {
    let engine = if lang.is_empty() || lang == "auto" {
        OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| format!("Failed to create OcrEngine: {}", e))?
    } else {
        let lang_hstr = windows::core::HSTRING::from(lang);
        let lang_obj = Language::CreateLanguage(&lang_hstr).map_err(|e| format!("Invalid language: {}", e))?;
        OcrEngine::TryCreateFromLanguage(&lang_obj).map_err(|e| format!("Failed to create OcrEngine for {}: {}", lang, e))?
    };
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
    use super::{prepare_ocr_images, text_quality_score};
    use screenshots::image::{DynamicImage, GenericImageView, ImageFormat, RgbaImage};
    use std::io::Cursor;

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
}
