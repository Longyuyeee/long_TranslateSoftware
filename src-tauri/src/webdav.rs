use crate::{db, secure_config};
use reqwest::{
    header::{ETAG, IF_MATCH, IF_NONE_MATCH},
    Client, Method, StatusCode, Url,
};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const SYNC_FILE_NAME: &str = "wordbook_sync.json";

#[derive(Debug, Clone, Copy)]
enum UploadCondition<'a> {
    Match(&'a str),
    CreateOnly,
    Unconditional,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavError {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
    pub recoverable: bool,
}

impl WebDavError {
    fn new(code: &str, message: impl Into<String>, status: Option<u16>, recoverable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            status,
            recoverable,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message, None, false)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConnectionResult {
    pub latency_ms: u128,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncSummary {
    pub downloaded: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub contexts_added: usize,
    pub uploaded: usize,
    pub first_sync: bool,
    pub completed_at: String,
}

fn normalize_base_url(value: &str) -> Result<String, WebDavError> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(WebDavError::new(
            "invalid_config",
            "WebDAV server URL is required",
            None,
            true,
        ));
    }

    let parsed = Url::parse(trimmed).map_err(|_| {
        WebDavError::new("invalid_config", "WebDAV server URL is invalid", None, true)
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(WebDavError::new(
            "invalid_config",
            "WebDAV server URL must use HTTP or HTTPS",
            None,
            true,
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(WebDavError::new(
            "invalid_config",
            "Put the WebDAV username and password in their dedicated fields",
            None,
            true,
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(WebDavError::new(
            "invalid_config",
            "WebDAV server URL cannot contain a query or fragment",
            None,
            true,
        ));
    }

    Ok(trimmed.to_string())
}

fn build_client() -> Result<Client, WebDavError> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("LongTranslate-WebDAV/0.4")
        .build()
        .map_err(|error| WebDavError::internal(format!("Could not create WebDAV client: {error}")))
}

fn request_error(error: reqwest::Error) -> WebDavError {
    if error.is_timeout() {
        WebDavError::new(
            "timeout",
            "The WebDAV server did not respond in time",
            None,
            true,
        )
    } else {
        WebDavError::new(
            "network",
            format!("Could not connect to the WebDAV server: {error}"),
            None,
            true,
        )
    }
}

fn response_error(status: StatusCode, operation: &str) -> WebDavError {
    let status_code = Some(status.as_u16());
    match status {
        StatusCode::UNAUTHORIZED => WebDavError::new(
            "unauthorized",
            "The WebDAV username or application password is incorrect",
            status_code,
            true,
        ),
        StatusCode::FORBIDDEN => WebDavError::new(
            "forbidden",
            "The WebDAV account does not have permission for this path",
            status_code,
            true,
        ),
        StatusCode::NOT_FOUND => WebDavError::new(
            "not_found",
            "The configured WebDAV path does not exist",
            status_code,
            true,
        ),
        StatusCode::METHOD_NOT_ALLOWED => WebDavError::new(
            "unsupported",
            "The configured endpoint does not support WebDAV requests",
            status_code,
            true,
        ),
        StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT => WebDavError::new(
            "conflict",
            "The remote wordbook changed during synchronization; retry to merge the latest data",
            status_code,
            true,
        ),
        status if status.is_server_error() => WebDavError::new(
            "server",
            format!("The WebDAV server failed while trying to {operation}"),
            status_code,
            true,
        ),
        _ => WebDavError::new(
            "request_failed",
            format!("The WebDAV server rejected the {operation} request"),
            status_code,
            true,
        ),
    }
}

#[tauri::command]
pub async fn test_webdav_connection(
    url: String,
    user: String,
    password: String,
) -> Result<WebDavConnectionResult, WebDavError> {
    let base_url = normalize_base_url(&url)?;
    let client = build_client()?;
    let method = Method::from_bytes(b"PROPFIND")
        .map_err(|error| WebDavError::internal(format!("Invalid WebDAV method: {error}")))?;
    let started = Instant::now();
    let response = client
        .request(method, &base_url)
        .header("Depth", "0")
        .basic_auth(user, Some(password))
        .send()
        .await
        .map_err(request_error)?;

    if response.status().is_success() {
        Ok(WebDavConnectionResult {
            latency_ms: started.elapsed().as_millis(),
        })
    } else {
        Err(response_error(response.status(), "test the connection"))
    }
}

async fn upload_snapshot(
    client: &Client,
    base_url: &str,
    sync_file_url: &str,
    user: &str,
    password: &str,
    local_items: &[Value],
    condition: UploadCondition<'_>,
) -> Result<(), WebDavError> {
    let mut request = client
        .put(sync_file_url)
        .basic_auth(user, Some(password))
        .json(local_items);
    match condition {
        UploadCondition::Match(etag) => request = request.header(IF_MATCH, etag),
        UploadCondition::CreateOnly => request = request.header(IF_NONE_MATCH, "*"),
        UploadCondition::Unconditional => {}
    }
    let response = request.send().await.map_err(request_error)?;

    if response.status().is_success() {
        return Ok(());
    }
    if response.status() != StatusCode::NOT_FOUND {
        return Err(response_error(response.status(), "upload the wordbook"));
    }

    let method = Method::from_bytes(b"MKCOL")
        .map_err(|error| WebDavError::internal(format!("Invalid WebDAV method: {error}")))?;
    let _ = client
        .request(method, base_url)
        .basic_auth(user, Some(password))
        .send()
        .await;

    let mut retry_request = client
        .put(sync_file_url)
        .basic_auth(user, Some(password))
        .json(local_items);
    if matches!(condition, UploadCondition::CreateOnly) {
        retry_request = retry_request.header(IF_NONE_MATCH, "*");
    }
    let retry = retry_request.send().await.map_err(request_error)?;
    if retry.status().is_success() {
        Ok(())
    } else {
        Err(response_error(
            retry.status(),
            "create the sync folder or upload the wordbook",
        ))
    }
}

async fn sync_wordbook_at(
    app_dir: PathBuf,
    url: Option<String>,
    user: Option<String>,
    password: Option<String>,
    enabled: Option<bool>,
) -> Result<WebDavSyncSummary, WebDavError> {
    let (stored_url, stored_user, stored_password, stored_enabled) = {
        let conn = db::init_db(app_dir.clone())
            .map_err(|error| WebDavError::internal(error.to_string()))?;
        let url = db::get_config(&conn, "webdav_url").unwrap_or_default();
        let user = db::get_config(&conn, "webdav_user").unwrap_or_default();
        let password = secure_config::load_value(&conn, "webdav_pass", &app_dir)
            .map_err(WebDavError::internal)?;
        let is_enabled = db::get_config(&conn, "webdav_enabled").unwrap_or_default() == "true";
        (url, user, password, is_enabled)
    };

    let url = url.unwrap_or(stored_url);
    let user = user.unwrap_or(stored_user);
    let password = password.unwrap_or(stored_password);
    let is_enabled = enabled.unwrap_or(stored_enabled);

    if !is_enabled {
        return Err(WebDavError::new(
            "disabled",
            "WebDAV synchronization is disabled",
            None,
            true,
        ));
    }

    let base_url = normalize_base_url(&url)?;
    let sync_file_url = format!("{base_url}/{SYNC_FILE_NAME}");
    let client = build_client()?;
    let response = client
        .get(&sync_file_url)
        .basic_auth(&user, Some(&password))
        .send()
        .await
        .map_err(request_error)?;

    let remote_etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let (remote_data, first_sync) = if response.status().is_success() {
        let data = response.json::<Vec<Value>>().await.map_err(|error| {
            WebDavError::new(
                "invalid_data",
                format!("The remote wordbook is not valid JSON: {error}"),
                None,
                true,
            )
        })?;
        (data, false)
    } else if response.status() == StatusCode::NOT_FOUND {
        (Vec::new(), true)
    } else {
        return Err(response_error(response.status(), "download the wordbook"));
    };

    let downloaded = remote_data.len();
    let mut summary = WebDavSyncSummary {
        downloaded,
        first_sync,
        ..WebDavSyncSummary::default()
    };

    let local_items: Vec<Value> = {
        let mut conn = db::init_db(app_dir.clone())
            .map_err(|error| WebDavError::internal(error.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|error| WebDavError::internal(error.to_string()))?;

        for item in remote_data {
            let uuid = item["uuid"].as_str().unwrap_or_default();
            let word = item["word"].as_str().unwrap_or_default();
            let updated_at = item["updated_at"].as_str().unwrap_or_default();
            if uuid.is_empty() || word.is_empty() || updated_at.is_empty() {
                return Err(WebDavError::new(
                    "invalid_data",
                    "The remote wordbook contains an incomplete item",
                    None,
                    true,
                ));
            }

            let is_deleted = item["is_deleted"].as_i64().unwrap_or(0);
            let local_updated_at: Option<String> = tx
                .query_row(
                    "SELECT updated_at FROM wordbook WHERE uuid = ?1",
                    [uuid],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| WebDavError::internal(error.to_string()))?;

            match local_updated_at {
                Some(local_time) if updated_at > local_time.as_str() => {
                    tx.execute(
                        "UPDATE wordbook SET word = ?1, phonetic = ?2, meaning = ?3, analysis_json = ?4, is_deleted = ?5, updated_at = ?6, ease_factor = ?7, interval_days = ?8, repetitions = ?9, next_review = ?10, last_reviewed = ?11, stability = ?12, difficulty = ?13 WHERE uuid = ?14",
                        (
                            word,
                            item["phonetic"].as_str().unwrap_or_default(),
                            item["meaning"].as_str().unwrap_or_default(),
                            item["analysis"].as_str().unwrap_or_default(),
                            is_deleted,
                            updated_at,
                            item["ease_factor"].as_f64().unwrap_or(2.5),
                            item["interval_days"].as_i64().unwrap_or(0),
                            item["repetitions"].as_i64().unwrap_or(0),
                            item["next_review"].as_str().unwrap_or(""),
                            item["last_reviewed"].as_str().unwrap_or(""),
                            item["stability"].as_f64().unwrap_or(0.0),
                            item["difficulty"].as_f64().unwrap_or(0.0),
                            uuid,
                        ),
                    )
                    .map_err(|error| WebDavError::internal(error.to_string()))?;
                    summary.updated += 1;
                }
                None => {
                    tx.execute(
                        "INSERT INTO wordbook (uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, difficulty) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        (
                            uuid,
                            word,
                            item["phonetic"].as_str().unwrap_or_default(),
                            item["meaning"].as_str().unwrap_or_default(),
                            item["analysis"].as_str().unwrap_or_default(),
                            is_deleted,
                            updated_at,
                            item["ease_factor"].as_f64().unwrap_or(2.5),
                            item["interval_days"].as_i64().unwrap_or(0),
                            item["repetitions"].as_i64().unwrap_or(0),
                            item["next_review"].as_str().unwrap_or(""),
                            item["last_reviewed"].as_str().unwrap_or(""),
                            item["stability"].as_f64().unwrap_or(0.0),
                            item["difficulty"].as_f64().unwrap_or(0.0),
                        ),
                    )
                    .map_err(|error| WebDavError::internal(error.to_string()))?;
                    summary.added += 1;
                }
                _ => summary.unchanged += 1,
            }

            if let Some(contexts) = item["contexts"].as_array() {
                for context in contexts {
                    summary.contexts_added += tx
                        .execute(
                            "INSERT OR IGNORE INTO word_contexts (word_uuid, source_text, translated_text, source_type, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                            (
                                uuid,
                                context["source_text"].as_str().unwrap_or_default(),
                                context["translated_text"].as_str().unwrap_or_default(),
                                context["source_type"].as_str().unwrap_or("manual"),
                                context["created_at"].as_str().unwrap_or_default(),
                            ),
                        )
                        .map_err(|error| WebDavError::internal(error.to_string()))?;
                }
            }
        }
        tx.commit()
            .map_err(|error| WebDavError::internal(error.to_string()))?;

        let mut stmt = conn
            .prepare("SELECT uuid, word, phonetic, meaning, analysis_json, is_deleted, updated_at, ease_factor, interval_days, repetitions, next_review, last_reviewed, stability, difficulty FROM wordbook")
            .map_err(|error| WebDavError::internal(error.to_string()))?;
        let mut items = stmt
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "uuid": row.get::<_, String>(0)?,
                    "word": row.get::<_, String>(1)?,
                    "phonetic": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "meaning": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    "analysis": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    "is_deleted": row.get::<_, i64>(5)?,
                    "updated_at": row.get::<_, String>(6)?,
                    "ease_factor": row.get::<_, f64>(7)?,
                    "interval_days": row.get::<_, i32>(8)?,
                    "repetitions": row.get::<_, i32>(9)?,
                    "next_review": row.get::<_, Option<String>>(10)?,
                    "last_reviewed": row.get::<_, Option<String>>(11)?,
                    "stability": row.get::<_, f64>(12)?,
                    "difficulty": row.get::<_, f64>(13)?,
                }))
            })
            .map_err(|error| WebDavError::internal(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WebDavError::internal(error.to_string()))?;
        drop(stmt);

        for item in &mut items {
            let uuid = item["uuid"].as_str().unwrap_or_default();
            let mut context_stmt = conn
                .prepare("SELECT source_text, translated_text, source_type, created_at FROM word_contexts WHERE word_uuid = ?1 ORDER BY created_at")
                .map_err(|error| WebDavError::internal(error.to_string()))?;
            let contexts = context_stmt
                .query_map([uuid], |row| {
                    Ok(serde_json::json!({
                        "source_text": row.get::<_, String>(0)?,
                        "translated_text": row.get::<_, String>(1)?,
                        "source_type": row.get::<_, String>(2)?,
                        "created_at": row.get::<_, String>(3)?,
                    }))
                })
                .map_err(|error| WebDavError::internal(error.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| WebDavError::internal(error.to_string()))?;
            item["contexts"] = serde_json::json!(contexts);
        }
        items
    };

    upload_snapshot(
        &client,
        &base_url,
        &sync_file_url,
        &user,
        &password,
        &local_items,
        match (remote_etag.as_deref(), first_sync) {
            (Some(etag), _) => UploadCondition::Match(etag),
            (None, true) => UploadCondition::CreateOnly,
            (None, false) => UploadCondition::Unconditional,
        },
    )
    .await?;

    summary.uploaded = local_items.len();
    summary.completed_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let serialized_summary = serde_json::to_string(&summary)
        .map_err(|error| WebDavError::internal(error.to_string()))?;
    {
        let conn =
            db::init_db(app_dir).map_err(|error| WebDavError::internal(error.to_string()))?;
        db::set_config(&conn, "last_sync_time", &summary.completed_at)
            .map_err(|error| WebDavError::internal(error.to_string()))?;
        db::set_config(&conn, "last_sync_result", &serialized_summary)
            .map_err(|error| WebDavError::internal(error.to_string()))?;
    }

    Ok(summary)
}

#[tauri::command]
pub async fn sync_wordbook(
    app: AppHandle,
    url: Option<String>,
    user: Option<String>,
    password: Option<String>,
    enabled: Option<bool>,
) -> Result<WebDavSyncSummary, WebDavError> {
    let app_dir = app.path().app_data_dir().map_err(|error| {
        WebDavError::internal(format!("Could not locate application data: {error}"))
    })?;
    let summary = sync_wordbook_at(app_dir, url, user, password, enabled).await?;
    let _ = app.emit("webdav-sync-completed", summary.clone());
    let _ = app.emit("wordbook-updated", "sync");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end + 4]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .or_else(|| line.strip_prefix("Content-Length: "))
                    })
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    async fn mock_webdav_response(status: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).await.unwrap();
            let response =
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn capture_webdav_request(status: &str) -> (String, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = sender.send(read_http_request(&mut stream).await);
            let response =
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        (format!("http://{address}"), receiver)
    }

    async fn mock_sync_server(remote_body: String) -> (String, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let (mut download, _) = listener.accept().await.unwrap();
            assert!(read_http_request(&mut download).await.starts_with("GET "));
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: \"revision-3\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                remote_body.len(),
                remote_body
            );
            download.write_all(response.as_bytes()).await.unwrap();

            let (mut upload, _) = listener.accept().await.unwrap();
            let _ = sender.send(read_http_request(&mut upload).await);
            upload
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        (format!("http://{address}"), receiver)
    }

    #[test]
    fn normalizes_supported_webdav_urls() {
        assert_eq!(
            normalize_base_url(" https://dav.example.com/remote.php/dav/files/user/ ").unwrap(),
            "https://dav.example.com/remote.php/dav/files/user"
        );
    }

    #[test]
    fn rejects_unsafe_or_unsupported_urls() {
        assert_eq!(
            normalize_base_url("ftp://dav.example.com")
                .unwrap_err()
                .code,
            "invalid_config"
        );
        assert_eq!(
            normalize_base_url("https://user:secret@dav.example.com")
                .unwrap_err()
                .code,
            "invalid_config"
        );
        assert_eq!(
            normalize_base_url("https://dav.example.com/root?token=secret")
                .unwrap_err()
                .code,
            "invalid_config"
        );
    }

    #[test]
    fn classifies_common_webdav_failures() {
        assert_eq!(
            response_error(StatusCode::UNAUTHORIZED, "test").code,
            "unauthorized"
        );
        assert_eq!(
            response_error(StatusCode::FORBIDDEN, "test").code,
            "forbidden"
        );
        assert_eq!(
            response_error(StatusCode::INTERNAL_SERVER_ERROR, "test").code,
            "server"
        );
        assert_eq!(
            response_error(StatusCode::PRECONDITION_FAILED, "upload").code,
            "conflict"
        );
    }

    #[tokio::test]
    async fn connection_probe_accepts_a_webdav_multistatus_response() {
        let url = mock_webdav_response("207 Multi-Status").await;
        let result = test_webdav_connection(url, "user".into(), "password".into())
            .await
            .unwrap();
        assert!(result.latency_ms < REQUEST_TIMEOUT.as_millis());
    }

    #[tokio::test]
    async fn connection_probe_returns_a_structured_authentication_error() {
        let url = mock_webdav_response("401 Unauthorized").await;
        let error = test_webdav_connection(url, "user".into(), "wrong".into())
            .await
            .unwrap_err();
        assert_eq!(error.code, "unauthorized");
        assert_eq!(error.status, Some(401));
        assert!(error.recoverable);
    }

    #[tokio::test]
    async fn existing_snapshot_upload_uses_the_downloaded_etag() {
        let (url, request) = capture_webdav_request("204 No Content").await;
        upload_snapshot(
            &build_client().unwrap(),
            &url,
            &url,
            "user",
            "password",
            &[],
            UploadCondition::Match("\"revision-7\""),
        )
        .await
        .unwrap();

        let request = request.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("put "));
        assert!(request.contains("if-match: \"revision-7\""));
        assert!(!request.contains("if-none-match:"));
    }

    #[tokio::test]
    async fn first_snapshot_upload_refuses_to_overwrite_a_new_remote_file() {
        let (url, request) = capture_webdav_request("412 Precondition Failed").await;
        let error = upload_snapshot(
            &build_client().unwrap(),
            &url,
            &url,
            "user",
            "password",
            &[],
            UploadCondition::CreateOnly,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "conflict");
        assert!(request
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("if-none-match: *"));
    }

    #[tokio::test]
    async fn isolated_sync_merges_remote_and_local_items_before_uploading() {
        let app_dir =
            std::env::temp_dir().join(format!("long-translate-webdav-{}", uuid::Uuid::new_v4()));
        let conn = db::init_db(app_dir.clone()).unwrap();
        conn.execute(
            "INSERT INTO wordbook (uuid, word, meaning, updated_at) VALUES (?1, ?2, ?3, ?4)",
            ("local-id", "local", "local meaning", "2026-07-27 09:00:00"),
        )
        .unwrap();
        drop(conn);

        let remote = serde_json::json!([{
            "uuid": "remote-id",
            "word": "remote",
            "meaning": "remote meaning",
            "updated_at": "2026-07-27 10:00:00",
            "contexts": [{
                "source_text": "remote context",
                "translated_text": "远端上下文",
                "source_type": "browser",
                "created_at": "2026-07-27 10:00:00"
            }]
        }])
        .to_string();
        let (url, uploaded_request) = mock_sync_server(remote).await;

        let summary = sync_wordbook_at(
            app_dir.clone(),
            Some(url),
            Some("user".into()),
            Some("password".into()),
            Some(true),
        )
        .await
        .unwrap();

        assert_eq!(summary.downloaded, 1);
        assert_eq!(summary.added, 1);
        assert_eq!(summary.contexts_added, 1);
        assert_eq!(summary.uploaded, 2);
        let uploaded = uploaded_request.await.unwrap();
        assert!(uploaded
            .to_ascii_lowercase()
            .contains("if-match: \"revision-3\""));
        assert!(uploaded.contains("\"uuid\":\"local-id\""));
        assert!(uploaded.contains("\"uuid\":\"remote-id\""));

        let conn = db::init_db(app_dir.clone()).unwrap();
        let remote_meaning: String = conn
            .query_row(
                "SELECT meaning FROM wordbook WHERE uuid = 'remote-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remote_meaning, "remote meaning");
        assert!(!db::get_config(&conn, "last_sync_time").unwrap().is_empty());
        drop(conn);
        std::fs::remove_dir_all(app_dir).unwrap();
    }
}
