use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, protocol::Message},
};

const CACHE_LIMIT_BYTES: u64 = 200 * 1024 * 1024;
const EDGE_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_USER_AGENT_VERSION: &str = "131.0.2903.86";

fn audio_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Cannot resolve application cache directory: {error}"))?
        .join("audio_cache");
    fs::create_dir_all(&path)
        .map_err(|error| format!("Cannot create audio cache directory: {error}"))?;
    Ok(path)
}

fn cache_path(cache_dir: &Path, cache_key: &str) -> PathBuf {
    let hash = hex::encode(Sha256::digest(cache_key.as_bytes()));
    cache_dir.join(format!("{hash}.cache"))
}

fn is_valid_cache_file(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

fn write_cache(cache_dir: &Path, cache_key: &str, audio_data: &[u8]) -> Result<(), String> {
    if audio_data.is_empty() {
        return Err("Cannot cache empty speech audio".to_string());
    }
    fs::write(cache_path(cache_dir, cache_key), audio_data)
        .map_err(|error| format!("Cannot write audio cache: {error}"))
}

fn format_cache_size(size: u64) -> String {
    if size < 1024 {
        format!("{size} B")
    } else if size < 1024 * 1024 {
        format!("{:.2} KB", size as f64 / 1024.0)
    } else {
        format!("{:.2} MB", size as f64 / (1024.0 * 1024.0))
    }
}

fn cache_size(cache_dir: &Path) -> Result<u64, String> {
    let entries = fs::read_dir(cache_dir)
        .map_err(|error| format!("Cannot read audio cache directory: {error}"))?;
    let mut total = 0u64;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Cannot read audio cache entry: {error}"))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Cannot inspect audio cache entry: {error}"))?;
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

fn evict_cache_if_needed(cache_dir: &Path, max_size: u64) -> Result<(), String> {
    let mut entries = fs::read_dir(cache_dir)
        .map_err(|error| format!("Cannot read audio cache for eviction: {error}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata.modified().ok()?;
            Some((entry.path(), metadata.len(), modified))
        })
        .collect::<Vec<_>>();
    let total = entries
        .iter()
        .fold(0u64, |sum, (_, size, _)| sum.saturating_add(*size));
    if total <= max_size {
        return Ok(());
    }

    entries.sort_by_key(|(_, _, modified)| *modified);
    let target = max_size.saturating_sub(max_size / 10);
    let mut freed = 0u64;
    for (path, size, _) in entries {
        if total.saturating_sub(freed) <= target {
            break;
        }
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Cannot evict audio cache file '{}': {error}",
                path.display()
            )
        })?;
        freed = freed.saturating_add(size);
    }
    Ok(())
}

fn generate_sec_ms_gec_token() -> String {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let rounded_ticks = ticks / 3000 * 3000;
    let value = format!("{rounded_ticks}{EDGE_CLIENT_TOKEN}");
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn voice_locale(voice: &str) -> &str {
    let second_dash = voice
        .match_indices('-')
        .nth(1)
        .map(|(index, _)| index)
        .unwrap_or(voice.len());
    let candidate = &voice[..second_dash];
    if candidate.contains('-') {
        candidate
    } else {
        "en-US"
    }
}

fn speech_rate_percent(speed: f32) -> i32 {
    (((speed.clamp(0.5, 2.0) - 1.0) * 100.0).round() as i32).clamp(-50, 100)
}

fn edge_user_agent(edge_version: &str) -> Result<HeaderValue, String> {
    let browser_major = edge_version
        .split('.')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("131");
    format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/{browser_major}.0.0.0 Safari/537.36 Edg/{edge_version}"
    )
    .parse()
    .map_err(|error| format!("Invalid Edge TTS user-agent header: {error}"))
}

async fn fetch_edge_tts(text: &str, voice: &str, speed: f32) -> Result<Vec<u8>, String> {
    let token = generate_sec_ms_gec_token();
    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let version = format!("1-{EDGE_USER_AGENT_VERSION}");
    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1\
         ?TrustedClientToken={EDGE_CLIENT_TOKEN}&Sec-MS-GEC={token}\
         &Sec-MS-GEC-Version={version}&ConnectionId={connection_id}"
    );
    let mut request = url
        .into_client_request()
        .map_err(|error| format!("Cannot prepare Edge TTS request: {error}"))?;
    let headers = request.headers_mut();
    headers.insert("Host", HeaderValue::from_static("speech.platform.bing.com"));
    headers.insert("Origin", HeaderValue::from_static("https://www.bing.com"));
    headers.insert("User-Agent", edge_user_agent(EDGE_USER_AGENT_VERSION)?);
    headers.insert("Pragma", HeaderValue::from_static("no-cache"));
    headers.insert("Cache-Control", HeaderValue::from_static("no-cache"));

    let (stream, _) = connect_async(request)
        .await
        .map_err(|error| format!("Cannot connect to Edge TTS: {error}"))?;
    let (mut write, mut read) = stream.split();
    let config = format!(
        r#"{{"context":{{"system":{{"name":"Edge","version":"{0}","build":"{0}","lang":"en-US"}}}}}}"#,
        EDGE_USER_AGENT_VERSION
    );
    write
        .send(Message::Text(
            format!(
                "Content-Type:application/json; charset=utf-8\r\n\
                 Path:speech.config\r\n\r\n{config}"
            )
            .into(),
        ))
        .await
        .map_err(|error| format!("Cannot configure Edge TTS: {error}"))?;

    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let ssml = format!(
        r#"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{}'><voice name='{}'><prosody pitch='+0Hz' rate='{:+}%' volume='+0%'>{}</prosody></voice></speak>"#,
        voice_locale(voice),
        xml_escape(voice),
        speech_rate_percent(speed),
        xml_escape(text)
    );
    write
        .send(Message::Text(
            format!(
                "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\n\
                 Path:ssml\r\n\r\n{ssml}"
            )
            .into(),
        ))
        .await
        .map_err(|error| format!("Cannot send Edge TTS text: {error}"))?;

    let mut audio_data = Vec::new();
    while let Some(message) = read.next().await {
        match message.map_err(|error| format!("Cannot read Edge TTS response: {error}"))? {
            Message::Binary(data) => {
                if let Some(position) = data
                    .windows(12)
                    .position(|value| value == b"Path:audio\r\n")
                {
                    audio_data.extend_from_slice(&data[position + 12..]);
                }
            }
            Message::Text(text) if text.contains("Path:turn.end") => break,
            _ => {}
        }
    }
    if audio_data.is_empty() {
        return Err("Edge speech service returned empty audio".to_string());
    }
    Ok(audio_data)
}

async fn fetch_http_audio(url: &str) -> Result<Vec<u8>, String> {
    if url.trim().is_empty() {
        return Err("Cache miss and no URL provided".to_string());
    }
    let response = reqwest::Client::new()
        .get(url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|error| format!("Cannot request speech audio: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Speech audio request failed with HTTP {status}"));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("Cannot read speech audio response: {error}"))
}

#[tauri::command]
pub fn save_audio_cache(
    app: AppHandle,
    cache_key: String,
    audio_data: Vec<u8>,
) -> Result<(), String> {
    write_cache(&audio_cache_dir(&app)?, &cache_key, &audio_data)
}

#[tauri::command]
pub fn check_audio_cache(app: AppHandle, cache_key: String) -> Result<bool, String> {
    Ok(is_valid_cache_file(&cache_path(
        &audio_cache_dir(&app)?,
        &cache_key,
    )))
}

#[tauri::command]
pub async fn proxy_fetch_audio(
    app: AppHandle,
    url: String,
    cache_key: Option<String>,
    engine: Option<String>,
    voice: Option<String>,
    speed: Option<String>,
) -> Result<Vec<u8>, String> {
    let cache_dir = audio_cache_dir(&app)?;
    let key = cache_key.unwrap_or_else(|| url.clone());
    let path = cache_path(&cache_dir, &key);
    if is_valid_cache_file(&path) {
        if let Ok(bytes) = fs::read(&path) {
            return Ok(bytes);
        }
    }

    let bytes = if engine.as_deref() == Some("edge") {
        let speed = speed
            .as_deref()
            .unwrap_or("1.0")
            .parse::<f32>()
            .unwrap_or(1.0);
        fetch_edge_tts(&url, voice.as_deref().unwrap_or("en-US-AriaNeural"), speed).await?
    } else {
        fetch_http_audio(&url).await?
    };

    if bytes.len() > 100 {
        let _ = fs::write(&path, &bytes);
    }
    let _ = evict_cache_if_needed(&cache_dir, CACHE_LIMIT_BYTES);
    Ok(bytes)
}

#[tauri::command]
pub fn get_audio_cache_size(app: AppHandle) -> Result<String, String> {
    Ok(format_cache_size(cache_size(&audio_cache_dir(&app)?)?))
}

#[tauri::command]
pub fn clear_audio_cache(app: AppHandle) -> Result<(), String> {
    let cache_dir = audio_cache_dir(&app)?;
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir)
            .map_err(|error| format!("Cannot clear audio cache: {error}"))?;
    }
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Cannot recreate audio cache directory: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        cache_path, cache_size, edge_user_agent, evict_cache_if_needed, format_cache_size,
        is_valid_cache_file, speech_rate_percent, voice_locale, write_cache, xml_escape,
    };
    use uuid::Uuid;

    #[test]
    fn edge_user_agent_rejects_header_injection_without_panicking() {
        let error = edge_user_agent("131.0\r\nInjected: true")
            .expect_err("invalid header characters must be rejected");
        assert!(error.contains("Invalid Edge TTS user-agent header"));
    }

    #[test]
    fn edge_speech_uses_voice_locale_clamped_speed_and_escaped_ssml() {
        assert_eq!(voice_locale("en-US-AriaNeural"), "en-US");
        assert_eq!(voice_locale("zh-CN-XiaoxiaoNeural"), "zh-CN");
        assert_eq!(voice_locale("alloy"), "en-US");
        assert_eq!(speech_rate_percent(0.1), -50);
        assert_eq!(speech_rate_percent(1.0), 0);
        assert_eq!(speech_rate_percent(3.0), 100);
        assert_eq!(xml_escape("A&B<'\""), "A&amp;B&lt;&apos;&quot;");
    }

    #[test]
    fn cache_keys_are_opaque_and_size_formatting_is_stable() {
        let directory = std::env::temp_dir().join(format!("long-translate-tts-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = cache_path(&directory, "../../outside");

        assert_eq!(path.parent(), Some(directory.as_path()));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("cache")
        );
        assert!(!path.to_string_lossy().contains("outside"));
        assert_eq!(format_cache_size(512), "512 B");
        assert_eq!(format_cache_size(1024), "1.00 KB");
        assert_eq!(format_cache_size(1024 * 1024), "1.00 MB");
        std::fs::write(&path, []).unwrap();
        assert!(!is_valid_cache_file(&path));
        assert!(write_cache(&directory, "valid", &[]).is_err());
        write_cache(&directory, "valid", &[1, 2, 3]).unwrap();
        assert!(is_valid_cache_file(&cache_path(&directory, "valid")));

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cache_eviction_reduces_usage_below_the_hysteresis_target() {
        let directory =
            std::env::temp_dir().join(format!("long-translate-tts-evict-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        for index in 0..3 {
            std::fs::write(
                directory.join(format!("{index}.cache")),
                vec![index as u8; 60],
            )
            .unwrap();
        }

        evict_cache_if_needed(&directory, 100).unwrap();
        assert!(cache_size(&directory).unwrap() <= 90);

        std::fs::remove_dir_all(directory).unwrap();
    }
}
