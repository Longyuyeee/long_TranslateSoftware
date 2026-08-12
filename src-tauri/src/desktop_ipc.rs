use crate::native_protocol::{
    validate_origin, AddWordRequest, CancelRequest, ErrorCode, PairingState, ProtocolError,
    Request, RequestEnvelope, TranslateRequest, TranslationResponse, PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

pub const DESKTOP_IPC_VERSION: u16 = 1;
pub const DESKTOP_IPC_ENDPOINT_FILE: &str = "browser-ipc.json";
pub const MAX_DESKTOP_IPC_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopIpcEndpoint {
    pub protocol_version: u16,
    pub pipe_name: String,
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopIpcRequest {
    protocol_version: u16,
    token: String,
    action: DesktopIpcAction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "payload", rename_all = "snake_case")]
enum DesktopIpcAction {
    Probe,
    PairingState(BrowserPairingIdentity),
    RequestPairing(BrowserPairingRequest),
    Translate(BrowserTranslationRequest),
    AddWord(BrowserAddWordRequest),
    Cancel(BrowserCancelRequest),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum DesktopIpcResponse {
    Ok {
        protocol_version: u16,
        payload: DesktopIpcPayload,
    },
    Error {
        code: DesktopIpcErrorCode,
        retryable: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
enum DesktopIpcPayload {
    Probe { desktop_version: String },
    Pairing { pairing_state: PairingState },
    Translation { outcome: BrowserTranslationOutcome },
    WordAdded { outcome: BrowserWordAddedOutcome },
    Cancelled { accepted: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DesktopIpcErrorCode {
    InvalidMessage,
    Unauthorized,
    UnsupportedVersion,
    InternalError,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPairingRequest {
    pub origin: String,
    pub display_name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserTranslationRequest {
    pub origin: String,
    pub request_id: String,
    pub translation: TranslateRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserCancelRequest {
    pub origin: String,
    pub target_request_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserAddWordRequest {
    pub origin: String,
    pub word: AddWordRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BrowserTranslationOutcome {
    Success { response: TranslationResponse },
    Error { error: ProtocolError },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BrowserWordAddedOutcome {
    Success { word_id: String },
    Error { error: ProtocolError },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserPairingIdentity {
    origin: String,
    #[serde(default)]
    capabilities: Vec<String>,
}

pub trait DesktopIpcHandler: Send + Sync + 'static {
    fn pairing_state(&self, origin: &str, capabilities: &[String]) -> io::Result<PairingState>;
    fn request_pairing(&self, request: BrowserPairingRequest) -> io::Result<PairingState>;
    fn translate(&self, _request: BrowserTranslationRequest) -> BrowserTranslationOutcome {
        BrowserTranslationOutcome::Error {
            error: ProtocolError::new(
                ErrorCode::DesktopUnavailable,
                "Desktop translation bridge is unavailable",
                true,
            ),
        }
    }
    fn cancel(&self, _request: BrowserCancelRequest) -> io::Result<bool> {
        Ok(false)
    }
    fn add_word(&self, _request: BrowserAddWordRequest) -> BrowserWordAddedOutcome {
        BrowserWordAddedOutcome::Error {
            error: ProtocolError::new(
                ErrorCode::DesktopUnavailable,
                "Desktop wordbook bridge is unavailable",
                true,
            ),
        }
    }
}

pub struct DesktopIpcState {
    endpoint_path: PathBuf,
    token: String,
    #[cfg(windows)]
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for DesktopIpcState {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let owns_endpoint = read_endpoint(&self.endpoint_path).is_ok_and(|endpoint| {
            constant_time_eq(endpoint.token.as_bytes(), self.token.as_bytes())
        });
        if owns_endpoint {
            let _ = fs::remove_file(&self.endpoint_path);
        }
    }
}

pub fn endpoint_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DESKTOP_IPC_ENDPOINT_FILE)
}

#[cfg(windows)]
pub fn default_endpoint_path() -> io::Result<PathBuf> {
    let roaming = std::env::var_os("APPDATA").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Current user application data directory is unavailable",
        )
    })?;
    Ok(endpoint_path(
        &PathBuf::from(roaming).join("com.long.translate"),
    ))
}

pub fn read_endpoint(path: &Path) -> io::Result<DesktopIpcEndpoint> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_DESKTOP_IPC_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Desktop IPC endpoint metadata exceeds its size limit",
        ));
    }
    let endpoint: DesktopIpcEndpoint = serde_json::from_slice(&bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Desktop IPC endpoint metadata is invalid",
        )
    })?;
    validate_endpoint(&endpoint)?;
    Ok(endpoint)
}

fn validate_endpoint(endpoint: &DesktopIpcEndpoint) -> io::Result<()> {
    if endpoint.protocol_version != DESKTOP_IPC_VERSION
        || !endpoint
            .pipe_name
            .starts_with(r"\\.\pipe\com.long.translate.browser.")
        || endpoint.pipe_name.len() > 160
        || Uuid::parse_str(&endpoint.token).is_err()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Desktop IPC endpoint metadata failed validation",
        ));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(windows)]
mod windows {
    use super::*;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    const ERROR_PIPE_BUSY: i32 = 231;
    const PIPE_OPEN_RETRY_LIMIT: usize = 50;
    const PIPE_OPEN_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

    pub fn start_server(
        app_data_dir: PathBuf,
        handler: Arc<dyn DesktopIpcHandler>,
    ) -> io::Result<DesktopIpcState> {
        fs::create_dir_all(&app_data_dir)?;
        let instance_id = Uuid::new_v4();
        let endpoint = DesktopIpcEndpoint {
            protocol_version: DESKTOP_IPC_VERSION,
            pipe_name: format!(r"\\.\pipe\com.long.translate.browser.{instance_id}"),
            token: Uuid::new_v4().to_string(),
        };
        validate_endpoint(&endpoint)?;

        let server = create_initial_server(&endpoint.pipe_name)?;
        let endpoint_path = endpoint_path(&app_data_dir);
        write_endpoint(&endpoint_path, &endpoint)?;

        let (shutdown, shutdown_receiver) = tokio::sync::oneshot::channel();
        let state = DesktopIpcState {
            endpoint_path,
            token: endpoint.token.clone(),
            shutdown: Some(shutdown),
        };
        tauri::async_runtime::spawn(run_server(server, endpoint, handler, shutdown_receiver));
        Ok(state)
    }

    fn create_initial_server(pipe_name: &str) -> io::Result<NamedPipeServer> {
        let create = || {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(pipe_name)
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            create()
        } else {
            tauri::async_runtime::block_on(async { create() })
        }
    }

    async fn run_server(
        mut server: NamedPipeServer,
        endpoint: DesktopIpcEndpoint,
        handler: Arc<dyn DesktopIpcHandler>,
        mut shutdown: tokio::sync::oneshot::Receiver<()>,
    ) {
        loop {
            tokio::select! {
                _ = &mut shutdown => return,
                result = server.connect() => {
                    if let Err(error) = result {
                        log::error!("Desktop IPC listener failed: {error}");
                        return;
                    }
                }
            }
            let next = match ServerOptions::new()
                .reject_remote_clients(true)
                .create(&endpoint.pipe_name)
            {
                Ok(next) => next,
                Err(error) => {
                    log::error!("Desktop IPC listener could not accept another client: {error}");
                    return;
                }
            };
            let connected = server;
            let client_endpoint = endpoint.clone();
            let client_handler = Arc::clone(&handler);
            tauri::async_runtime::spawn(async move {
                if let Err(error) =
                    handle_client(connected, &client_endpoint, &client_handler).await
                {
                    log::warn!("Desktop IPC client was rejected: {error}");
                }
            });
            server = next;
        }
    }

    async fn handle_client(
        mut stream: NamedPipeServer,
        endpoint: &DesktopIpcEndpoint,
        handler: &Arc<dyn DesktopIpcHandler>,
    ) -> io::Result<()> {
        let request = match read_json_frame::<_, DesktopIpcRequest>(&mut stream).await {
            Ok(request) => request,
            Err(error) => {
                let _ = write_json_frame(
                    &mut stream,
                    &DesktopIpcResponse::Error {
                        code: DesktopIpcErrorCode::InvalidMessage,
                        retryable: false,
                    },
                )
                .await;
                return Err(error);
            }
        };

        let response = if request.protocol_version != DESKTOP_IPC_VERSION {
            DesktopIpcResponse::Error {
                code: DesktopIpcErrorCode::UnsupportedVersion,
                retryable: false,
            }
        } else if !constant_time_eq(request.token.as_bytes(), endpoint.token.as_bytes()) {
            DesktopIpcResponse::Error {
                code: DesktopIpcErrorCode::Unauthorized,
                retryable: false,
            }
        } else {
            match request.action {
                DesktopIpcAction::Probe => DesktopIpcResponse::Ok {
                    protocol_version: DESKTOP_IPC_VERSION,
                    payload: DesktopIpcPayload::Probe {
                        desktop_version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                },
                DesktopIpcAction::PairingState(identity) => {
                    match validate_pairing_identity(&identity).and_then(|_| {
                        handler.pairing_state(&identity.origin, &identity.capabilities)
                    }) {
                        Ok(pairing_state) => DesktopIpcResponse::Ok {
                            protocol_version: DESKTOP_IPC_VERSION,
                            payload: DesktopIpcPayload::Pairing { pairing_state },
                        },
                        Err(_) => DesktopIpcResponse::Error {
                            code: DesktopIpcErrorCode::InvalidMessage,
                            retryable: false,
                        },
                    }
                }
                DesktopIpcAction::RequestPairing(request) => {
                    if validate_pairing_request(&request).is_err() {
                        DesktopIpcResponse::Error {
                            code: DesktopIpcErrorCode::InvalidMessage,
                            retryable: false,
                        }
                    } else {
                        match handler.request_pairing(request) {
                            Ok(pairing_state) => DesktopIpcResponse::Ok {
                                protocol_version: DESKTOP_IPC_VERSION,
                                payload: DesktopIpcPayload::Pairing { pairing_state },
                            },
                            Err(_) => DesktopIpcResponse::Error {
                                code: DesktopIpcErrorCode::InternalError,
                                retryable: true,
                            },
                        }
                    }
                }
                DesktopIpcAction::Translate(request) => {
                    if validate_translation_request(&request).is_err() {
                        DesktopIpcResponse::Error {
                            code: DesktopIpcErrorCode::InvalidMessage,
                            retryable: false,
                        }
                    } else {
                        let handler = Arc::clone(handler);
                        let outcome =
                            tokio::task::spawn_blocking(move || handler.translate(request))
                                .await
                                .unwrap_or_else(|_| BrowserTranslationOutcome::Error {
                                    error: ProtocolError::new(
                                        ErrorCode::InternalError,
                                        "Desktop translation worker stopped unexpectedly",
                                        true,
                                    ),
                                });
                        DesktopIpcResponse::Ok {
                            protocol_version: DESKTOP_IPC_VERSION,
                            payload: DesktopIpcPayload::Translation { outcome },
                        }
                    }
                }
                DesktopIpcAction::AddWord(request) => {
                    if validate_add_word_request(&request).is_err() {
                        DesktopIpcResponse::Error {
                            code: DesktopIpcErrorCode::InvalidMessage,
                            retryable: false,
                        }
                    } else {
                        let outcome = handler.add_word(request);
                        DesktopIpcResponse::Ok {
                            protocol_version: DESKTOP_IPC_VERSION,
                            payload: DesktopIpcPayload::WordAdded { outcome },
                        }
                    }
                }
                DesktopIpcAction::Cancel(request) => {
                    if validate_cancel_request(&request).is_err() {
                        DesktopIpcResponse::Error {
                            code: DesktopIpcErrorCode::InvalidMessage,
                            retryable: false,
                        }
                    } else {
                        match handler.cancel(request) {
                            Ok(accepted) => DesktopIpcResponse::Ok {
                                protocol_version: DESKTOP_IPC_VERSION,
                                payload: DesktopIpcPayload::Cancelled { accepted },
                            },
                            Err(_) => DesktopIpcResponse::Error {
                                code: DesktopIpcErrorCode::InternalError,
                                retryable: true,
                            },
                        }
                    }
                }
            }
        };
        write_json_frame(&mut stream, &response).await
    }

    pub async fn probe(endpoint_path: &Path) -> io::Result<String> {
        let endpoint = read_endpoint(endpoint_path)?;
        probe_endpoint(&endpoint).await
    }

    async fn probe_endpoint(endpoint: &DesktopIpcEndpoint) -> io::Result<String> {
        let mut stream = ClientOptions::new().open(&endpoint.pipe_name)?;
        write_json_frame(
            &mut stream,
            &DesktopIpcRequest {
                protocol_version: DESKTOP_IPC_VERSION,
                token: endpoint.token.clone(),
                action: DesktopIpcAction::Probe,
            },
        )
        .await?;
        match read_json_frame::<_, DesktopIpcResponse>(&mut stream).await? {
            DesktopIpcResponse::Ok {
                protocol_version: DESKTOP_IPC_VERSION,
                payload: DesktopIpcPayload::Probe { desktop_version },
            } => Ok(desktop_version),
            DesktopIpcResponse::Ok { .. } => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC response uses an unsupported version",
            )),
            DesktopIpcResponse::Error { code, .. } => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("Desktop IPC request failed: {code:?}"),
            )),
        }
    }

    pub fn request_pairing_blocking(
        endpoint_path: &Path,
        request: BrowserPairingRequest,
    ) -> io::Result<PairingState> {
        if tokio::runtime::Handle::try_current().is_ok() {
            let endpoint_path = endpoint_path.to_path_buf();
            return std::thread::spawn(move || {
                desktop_client_runtime()?.block_on(request_pairing(&endpoint_path, request))
            })
            .join()
            .map_err(|_| io::Error::other("Desktop IPC worker stopped unexpectedly"))?;
        }
        desktop_client_runtime()?.block_on(request_pairing(endpoint_path, request))
    }

    pub fn pairing_state_blocking(
        endpoint_path: &Path,
        origin: String,
        capabilities: Vec<String>,
    ) -> io::Result<PairingState> {
        if tokio::runtime::Handle::try_current().is_ok() {
            let endpoint_path = endpoint_path.to_path_buf();
            return std::thread::spawn(move || {
                desktop_client_runtime()?.block_on(pairing_state(
                    &endpoint_path,
                    origin,
                    capabilities,
                ))
            })
            .join()
            .map_err(|_| io::Error::other("Desktop IPC worker stopped unexpectedly"))?;
        }
        desktop_client_runtime()?.block_on(pairing_state(endpoint_path, origin, capabilities))
    }

    pub fn translate_blocking(
        endpoint_path: &Path,
        request: BrowserTranslationRequest,
    ) -> io::Result<BrowserTranslationOutcome> {
        run_client_blocking(endpoint_path, move |path| async move {
            translate(&path, request).await
        })
    }

    pub fn cancel_blocking(
        endpoint_path: &Path,
        request: BrowserCancelRequest,
    ) -> io::Result<bool> {
        run_client_blocking(endpoint_path, move |path| async move {
            cancel(&path, request).await
        })
    }

    pub fn add_word_blocking(
        endpoint_path: &Path,
        request: BrowserAddWordRequest,
    ) -> io::Result<BrowserWordAddedOutcome> {
        run_client_blocking(endpoint_path, move |path| async move {
            add_word(&path, request).await
        })
    }

    fn run_client_blocking<T, F, Fut>(endpoint_path: &Path, operation: F) -> io::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(PathBuf) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = io::Result<T>> + 'static,
    {
        let endpoint_path = endpoint_path.to_path_buf();
        if tokio::runtime::Handle::try_current().is_ok() {
            return std::thread::spawn(move || {
                desktop_client_runtime()?.block_on(operation(endpoint_path))
            })
            .join()
            .map_err(|_| io::Error::other("Desktop IPC worker stopped unexpectedly"))?;
        }
        desktop_client_runtime()?.block_on(operation(endpoint_path))
    }

    fn desktop_client_runtime() -> io::Result<tokio::runtime::Runtime> {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .map_err(|_| io::Error::other("Desktop IPC runtime is unavailable"))
    }

    async fn pairing_state(
        endpoint_path: &Path,
        origin: String,
        capabilities: Vec<String>,
    ) -> io::Result<PairingState> {
        let identity = BrowserPairingIdentity {
            origin,
            capabilities,
        };
        validate_pairing_identity(&identity)?;
        let endpoint = read_endpoint(endpoint_path)?;
        let mut stream = ClientOptions::new().open(&endpoint.pipe_name)?;
        write_json_frame(
            &mut stream,
            &DesktopIpcRequest {
                protocol_version: DESKTOP_IPC_VERSION,
                token: endpoint.token,
                action: DesktopIpcAction::PairingState(identity),
            },
        )
        .await?;
        pairing_response(&mut stream).await
    }

    async fn translate(
        endpoint_path: &Path,
        request: BrowserTranslationRequest,
    ) -> io::Result<BrowserTranslationOutcome> {
        validate_translation_request(&request)?;
        let mut stream = open_client(endpoint_path, DesktopIpcAction::Translate(request)).await?;
        match read_json_frame::<_, DesktopIpcResponse>(&mut stream).await? {
            DesktopIpcResponse::Ok {
                protocol_version: DESKTOP_IPC_VERSION,
                payload: DesktopIpcPayload::Translation { outcome },
            } => Ok(outcome),
            response => Err(response_error(response, "translation")),
        }
    }

    async fn cancel(endpoint_path: &Path, request: BrowserCancelRequest) -> io::Result<bool> {
        validate_cancel_request(&request)?;
        let mut stream = open_client(endpoint_path, DesktopIpcAction::Cancel(request)).await?;
        match read_json_frame::<_, DesktopIpcResponse>(&mut stream).await? {
            DesktopIpcResponse::Ok {
                protocol_version: DESKTOP_IPC_VERSION,
                payload: DesktopIpcPayload::Cancelled { accepted },
            } => Ok(accepted),
            response => Err(response_error(response, "cancellation")),
        }
    }

    async fn add_word(
        endpoint_path: &Path,
        request: BrowserAddWordRequest,
    ) -> io::Result<BrowserWordAddedOutcome> {
        validate_add_word_request(&request)?;
        let mut stream = open_client(endpoint_path, DesktopIpcAction::AddWord(request)).await?;
        match read_json_frame::<_, DesktopIpcResponse>(&mut stream).await? {
            DesktopIpcResponse::Ok {
                protocol_version: DESKTOP_IPC_VERSION,
                payload: DesktopIpcPayload::WordAdded { outcome },
            } => Ok(outcome),
            response => Err(response_error(response, "wordbook write")),
        }
    }

    async fn open_client(
        endpoint_path: &Path,
        action: DesktopIpcAction,
    ) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
        let endpoint = read_endpoint(endpoint_path)?;
        let mut retries = 0;
        let mut stream = loop {
            match ClientOptions::new().open(&endpoint.pipe_name) {
                Ok(stream) => break stream,
                Err(error)
                    if error.raw_os_error() == Some(ERROR_PIPE_BUSY)
                        && retries < PIPE_OPEN_RETRY_LIMIT =>
                {
                    retries += 1;
                    tokio::time::sleep(PIPE_OPEN_RETRY_DELAY).await;
                }
                Err(error) => return Err(error),
            }
        };
        write_json_frame(
            &mut stream,
            &DesktopIpcRequest {
                protocol_version: DESKTOP_IPC_VERSION,
                token: endpoint.token,
                action,
            },
        )
        .await?;
        Ok(stream)
    }

    fn response_error(response: DesktopIpcResponse, operation: &str) -> io::Error {
        let retryable = matches!(
            response,
            DesktopIpcResponse::Error {
                retryable: true,
                ..
            }
        );
        io::Error::new(
            if retryable {
                io::ErrorKind::WouldBlock
            } else {
                io::ErrorKind::PermissionDenied
            },
            format!("Desktop IPC {operation} request was rejected"),
        )
    }

    pub async fn request_pairing(
        endpoint_path: &Path,
        request: BrowserPairingRequest,
    ) -> io::Result<PairingState> {
        validate_pairing_request(&request)?;
        let endpoint = read_endpoint(endpoint_path)?;
        let mut stream = ClientOptions::new().open(&endpoint.pipe_name)?;
        write_json_frame(
            &mut stream,
            &DesktopIpcRequest {
                protocol_version: DESKTOP_IPC_VERSION,
                token: endpoint.token,
                action: DesktopIpcAction::RequestPairing(request),
            },
        )
        .await?;
        pairing_response(&mut stream).await
    }

    async fn pairing_response(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<PairingState> {
        match read_json_frame::<_, DesktopIpcResponse>(stream).await? {
            DesktopIpcResponse::Ok {
                protocol_version: DESKTOP_IPC_VERSION,
                payload: DesktopIpcPayload::Pairing { pairing_state },
            } => Ok(pairing_state),
            DesktopIpcResponse::Ok { .. } => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC pairing response is invalid",
            )),
            DesktopIpcResponse::Error { retryable, .. } => Err(io::Error::new(
                if retryable {
                    io::ErrorKind::WouldBlock
                } else {
                    io::ErrorKind::PermissionDenied
                },
                "Desktop IPC pairing request was rejected",
            )),
        }
    }

    async fn read_json_frame<R, T>(reader: &mut R) -> io::Result<T>
    where
        R: AsyncRead + Unpin,
        T: for<'de> Deserialize<'de>,
    {
        let mut prefix = [0_u8; 4];
        reader.read_exact(&mut prefix).await?;
        let message_size = u32::from_le_bytes(prefix) as usize;
        if message_size == 0 || message_size > MAX_DESKTOP_IPC_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC message exceeds its size limit",
            ));
        }
        let mut message = vec![0_u8; message_size];
        reader.read_exact(&mut message).await?;
        serde_json::from_slice(&message).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "Desktop IPC message is invalid")
        })
    }

    async fn write_json_frame<W, T>(writer: &mut W, value: &T) -> io::Result<()>
    where
        W: AsyncWrite + Unpin,
        T: Serialize,
    {
        let payload = serde_json::to_vec(value).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC response is invalid",
            )
        })?;
        if payload.is_empty() || payload.len() > MAX_DESKTOP_IPC_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC message exceeds its size limit",
            ));
        }
        writer
            .write_all(&(payload.len() as u32).to_le_bytes())
            .await?;
        writer.write_all(&payload).await?;
        writer.flush().await
    }

    fn write_endpoint(path: &Path, endpoint: &DesktopIpcEndpoint) -> io::Result<()> {
        let payload = serde_json::to_vec(endpoint).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC endpoint metadata could not be serialized",
            )
        })?;
        let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        fs::write(&temporary, payload)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Mutex;

        struct RecordingHandler {
            requests: Mutex<Vec<BrowserPairingRequest>>,
            pairing_state: Mutex<PairingState>,
            translations: Mutex<Vec<BrowserTranslationRequest>>,
            cancellations: Mutex<Vec<BrowserCancelRequest>>,
            words: Mutex<Vec<BrowserAddWordRequest>>,
        }

        impl Default for RecordingHandler {
            fn default() -> Self {
                Self {
                    requests: Mutex::new(Vec::new()),
                    pairing_state: Mutex::new(PairingState::Required),
                    translations: Mutex::new(Vec::new()),
                    cancellations: Mutex::new(Vec::new()),
                    words: Mutex::new(Vec::new()),
                }
            }
        }

        impl DesktopIpcHandler for RecordingHandler {
            fn pairing_state(
                &self,
                _origin: &str,
                _capabilities: &[String],
            ) -> io::Result<PairingState> {
                Ok(*self.pairing_state.lock().unwrap())
            }

            fn request_pairing(&self, request: BrowserPairingRequest) -> io::Result<PairingState> {
                self.requests.lock().unwrap().push(request);
                Ok(PairingState::Pending)
            }

            fn translate(&self, request: BrowserTranslationRequest) -> BrowserTranslationOutcome {
                self.translations.lock().unwrap().push(request);
                BrowserTranslationOutcome::Success {
                    response: TranslationResponse {
                        text: "translated".to_string(),
                        detected_language: Some("en".to_string()),
                        cached: false,
                    },
                }
            }

            fn cancel(&self, request: BrowserCancelRequest) -> io::Result<bool> {
                self.cancellations.lock().unwrap().push(request);
                Ok(true)
            }

            fn add_word(&self, request: BrowserAddWordRequest) -> BrowserWordAddedOutcome {
                self.words.lock().unwrap().push(request);
                BrowserWordAddedOutcome::Success {
                    word_id: "word-123".to_string(),
                }
            }
        }

        fn temporary_app_dir() -> PathBuf {
            std::env::temp_dir().join(format!("long-translate-ipc-{}", Uuid::new_v4()))
        }

        #[test]
        fn server_initialization_is_safe_outside_an_entered_async_runtime() {
            let app_dir = temporary_app_dir();
            let state =
                start_server(app_dir.clone(), Arc::new(RecordingHandler::default())).unwrap();
            assert!(endpoint_path(&app_dir).exists());
            drop(state);
            assert!(!endpoint_path(&app_dir).exists());
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn authenticated_probe_reaches_the_running_desktop_server() {
            let app_dir = temporary_app_dir();
            let state =
                start_server(app_dir.clone(), Arc::new(RecordingHandler::default())).unwrap();
            let version = probe(&endpoint_path(&app_dir)).await.unwrap();
            assert_eq!(version, env!("CARGO_PKG_VERSION"));
            let second_version = probe(&endpoint_path(&app_dir)).await.unwrap();
            assert_eq!(second_version, env!("CARGO_PKG_VERSION"));

            drop(state);
            assert!(!endpoint_path(&app_dir).exists());
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn pairing_state_clients_are_safe_inside_an_existing_runtime() {
            let app_dir = temporary_app_dir();
            let handler = Arc::new(RecordingHandler::default());
            *handler.pairing_state.lock().unwrap() = PairingState::Approved;
            let state = start_server(app_dir.clone(), handler).unwrap();
            let endpoint = endpoint_path(&app_dir);
            let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

            assert_eq!(
                pairing_state(
                    &endpoint,
                    origin.to_string(),
                    vec!["translation".to_string()]
                )
                .await
                .unwrap(),
                PairingState::Approved
            );
            assert_eq!(
                pairing_state_blocking(
                    &endpoint,
                    origin.to_string(),
                    vec!["translation".to_string()],
                )
                .unwrap(),
                PairingState::Approved
            );

            drop(state);
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn invalid_tokens_are_rejected_without_returning_desktop_data() {
            let app_dir = temporary_app_dir();
            let state =
                start_server(app_dir.clone(), Arc::new(RecordingHandler::default())).unwrap();
            let mut endpoint = read_endpoint(&endpoint_path(&app_dir)).unwrap();
            endpoint.token = Uuid::new_v4().to_string();
            let error = probe_endpoint(&endpoint).await.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);

            drop(state);
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn stale_state_cannot_remove_a_newer_endpoint() {
            let app_dir = temporary_app_dir();
            let stale_state =
                start_server(app_dir.clone(), Arc::new(RecordingHandler::default())).unwrap();
            let endpoint_file = endpoint_path(&app_dir);
            let mut replacement = read_endpoint(&endpoint_file).unwrap();
            replacement.token = Uuid::new_v4().to_string();
            write_endpoint(&endpoint_file, &replacement).unwrap();

            drop(stale_state);
            assert_eq!(read_endpoint(&endpoint_file).unwrap(), replacement);

            let _ = fs::remove_file(endpoint_file);
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn pairing_requests_reach_the_desktop_handler_without_origin_rewriting() {
            let app_dir = temporary_app_dir();
            let handler = Arc::new(RecordingHandler::default());
            let state = start_server(app_dir.clone(), handler.clone()).unwrap();
            let request = BrowserPairingRequest {
                origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(),
                display_name: "Long Translate extension".to_string(),
                capabilities: vec!["translation".to_string()],
            };

            assert_eq!(
                request_pairing(&endpoint_path(&app_dir), request.clone())
                    .await
                    .unwrap(),
                PairingState::Pending
            );
            assert_eq!(*handler.requests.lock().unwrap(), vec![request]);

            drop(state);
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn translation_and_cancel_keep_origin_and_request_correlation() {
            let app_dir = temporary_app_dir();
            let handler = Arc::new(RecordingHandler::default());
            let state = start_server(app_dir.clone(), handler.clone()).unwrap();
            let endpoint = endpoint_path(&app_dir);
            let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
            let translation = TranslateRequest {
                text: "hello".to_string(),
                target_language: "zh-Hans".to_string(),
                source_language: Some("en".to_string()),
                format: crate::native_protocol::TextFormat::PlainText,
                glossary: Vec::new(),
            };

            let outcome = translate(
                &endpoint,
                BrowserTranslationRequest {
                    origin: origin.to_string(),
                    request_id: "translate-1".to_string(),
                    translation: translation.clone(),
                },
            )
            .await
            .unwrap();
            assert!(matches!(outcome, BrowserTranslationOutcome::Success { .. }));
            assert!(cancel(
                &endpoint,
                BrowserCancelRequest {
                    origin: origin.to_string(),
                    target_request_id: "translate-1".to_string(),
                },
            )
            .await
            .unwrap());
            let word_request = BrowserAddWordRequest {
                origin: origin.to_string(),
                word: AddWordRequest {
                    word: "hello".to_string(),
                    translation: "你好".to_string(),
                    context: None,
                },
            };
            assert_eq!(
                add_word(&endpoint, word_request.clone()).await.unwrap(),
                BrowserWordAddedOutcome::Success {
                    word_id: "word-123".to_string(),
                }
            );
            assert_eq!(
                *handler.translations.lock().unwrap(),
                vec![BrowserTranslationRequest {
                    origin: origin.to_string(),
                    request_id: "translate-1".to_string(),
                    translation,
                }]
            );
            assert_eq!(
                *handler.cancellations.lock().unwrap(),
                vec![BrowserCancelRequest {
                    origin: origin.to_string(),
                    target_request_id: "translate-1".to_string(),
                }]
            );
            assert_eq!(*handler.words.lock().unwrap(), vec![word_request]);

            drop(state);
            let _ = fs::remove_dir_all(app_dir);
        }
    }
}

#[cfg(windows)]
pub use windows::{
    add_word_blocking, cancel_blocking, pairing_state_blocking, probe, request_pairing,
    request_pairing_blocking, start_server, translate_blocking,
};

#[cfg(not(windows))]
pub fn default_endpoint_path() -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Desktop browser IPC is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
pub fn request_pairing_blocking(
    _endpoint_path: &Path,
    _request: BrowserPairingRequest,
) -> io::Result<PairingState> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Desktop browser IPC is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
pub fn pairing_state_blocking(
    _endpoint_path: &Path,
    _origin: String,
    _capabilities: Vec<String>,
) -> io::Result<PairingState> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Desktop browser IPC is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
pub fn translate_blocking(
    _endpoint_path: &Path,
    _request: BrowserTranslationRequest,
) -> io::Result<BrowserTranslationOutcome> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Desktop browser IPC is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
pub fn cancel_blocking(_endpoint_path: &Path, _request: BrowserCancelRequest) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Desktop browser IPC is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
pub fn add_word_blocking(
    _endpoint_path: &Path,
    _request: BrowserAddWordRequest,
) -> io::Result<BrowserWordAddedOutcome> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Desktop browser IPC is currently supported only on Windows",
    ))
}

fn validate_pairing_identity(identity: &BrowserPairingIdentity) -> io::Result<()> {
    validate_pairing_request(&BrowserPairingRequest {
        origin: identity.origin.clone(),
        display_name: "Browser extension".to_string(),
        capabilities: identity.capabilities.clone(),
    })
}

fn validate_pairing_request(request: &BrowserPairingRequest) -> io::Result<()> {
    validate_origin(&request.origin, std::slice::from_ref(&request.origin))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid extension origin"))?;
    if request.display_name.trim().is_empty()
        || request.display_name.len() > 80
        || request.capabilities.len() > 32
        || request.capabilities.iter().any(|capability| {
            capability.is_empty()
                || capability.len() > 64
                || !capability.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
                })
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid desktop pairing request",
        ));
    }
    Ok(())
}

fn validate_translation_request(request: &BrowserTranslationRequest) -> io::Result<()> {
    validate_origin(&request.origin, std::slice::from_ref(&request.origin))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid extension origin"))?;
    RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        request: Request::Translate(request.translation.clone()),
    }
    .validate()
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid translation request"))
}

fn validate_cancel_request(request: &BrowserCancelRequest) -> io::Result<()> {
    validate_origin(&request.origin, std::slice::from_ref(&request.origin))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid extension origin"))?;
    RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: "cancel-validation".to_string(),
        request: Request::Cancel(CancelRequest {
            target_request_id: request.target_request_id.clone(),
        }),
    }
    .validate()
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid cancellation request"))
}

fn validate_add_word_request(request: &BrowserAddWordRequest) -> io::Result<()> {
    validate_origin(&request.origin, std::slice::from_ref(&request.origin))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid extension origin"))?;
    RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: "desktop-add-word".to_string(),
        request: Request::AddWord(request.word.clone()),
    }
    .validate()
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid wordbook request"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_metadata_is_strict_and_bounded() {
        let endpoint = DesktopIpcEndpoint {
            protocol_version: DESKTOP_IPC_VERSION,
            pipe_name: format!(r"\\.\pipe\com.long.translate.browser.{}", Uuid::new_v4()),
            token: Uuid::new_v4().to_string(),
        };
        validate_endpoint(&endpoint).unwrap();
        assert!(constant_time_eq(
            endpoint.token.as_bytes(),
            endpoint.token.as_bytes()
        ));
        assert!(!constant_time_eq(endpoint.token.as_bytes(), b"invalid"));

        let mut invalid = endpoint;
        invalid.pipe_name = r"\\.\pipe\other-product".to_string();
        assert_eq!(
            validate_endpoint(&invalid).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
