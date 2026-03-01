use screenshots::Screen;
use std::io::Cursor;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Storage::Streams::InMemoryRandomAccessStream;

pub async fn run_ocr(image_bytes: Vec<u8>) -> Result<String, Box<dyn std::error::Error>> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| format!("Failed to create OcrEngine: {}", e))?;
    let stream = InMemoryRandomAccessStream::new().map_err(|e| format!("Failed to create stream: {}", e))?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| format!("Failed to create writer: {}", e))?;
    writer.WriteBytes(&image_bytes).map_err(|e| format!("Failed to write bytes: {}", e))?;
    writer.StoreAsync().map_err(|e| format!("Failed to store async: {}", e))?.get().map_err(|e| format!("StoreAsync get failed: {}", e))?;
    writer.FlushAsync().map_err(|e| format!("Failed to flush async: {}", e))?.get().map_err(|e| format!("FlushAsync get failed: {}", e))?;
    
    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(|e| format!("Failed to create decoder: {}", e))?.get().map_err(|e| format!("CreateAsync get failed: {}", e))?;
    let bitmap = decoder.GetSoftwareBitmapAsync().map_err(|e| format!("Failed to get bitmap: {}", e))?.get().map_err(|e| format!("GetSoftwareBitmapAsync get failed: {}", e))?;
    let result = engine.RecognizeAsync(&bitmap).map_err(|e| format!("Failed to recognize: {}", e))?.get().map_err(|e| format!("RecognizeAsync get failed: {}", e))?;
    let text = result.Text().map_err(|e| format!("Failed to get text: {}", e))?;
    Ok(text.to_string())
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
    image.write_to(&mut Cursor::new(&mut buffer), screenshots::image::ImageFormat::Png)?;
    Ok(buffer)
}
