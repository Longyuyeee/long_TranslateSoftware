use crate::desktop_ipc::{
    self, BrowserAddWordRequest, BrowserCancelRequest, BrowserPairingRequest,
    BrowserTranslationOutcome, BrowserTranslationRequest, BrowserWordAddedOutcome,
};
use crate::native_protocol::{
    parse_request, validate_message_size, validate_origin, AddWordRequest, CancelRequest,
    ErrorCode, HelloResponse, PairingResponse, PairingState, PongResponse, ProtocolError,
    ProtocolLimits, Request, RequestEnvelope, Response, ResponseEnvelope, ResponsePayload,
    TranslateRequest, WordAddedResponse, PROTOCOL_VERSION,
};
use crate::native_registration;
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use uuid::Uuid;

pub const ALLOWED_ORIGINS_ENV: &str = "LONG_TRANSLATE_NATIVE_ALLOWED_ORIGINS";
const FALLBACK_REQUEST_ID: &str = "host";

#[derive(Clone)]
pub struct NativeHostSession {
    desktop_version: String,
    session_id: String,
    hello_received: bool,
    requested_capabilities: Vec<String>,
    desktop_bridge: Option<DesktopBridge>,
}

#[derive(Clone)]
struct DesktopBridge {
    endpoint_path: PathBuf,
    caller_origin: String,
}

impl NativeHostSession {
    pub fn new(desktop_version: impl Into<String>) -> Self {
        Self {
            desktop_version: desktop_version.into(),
            session_id: format!("session-{}", Uuid::new_v4()),
            hello_received: false,
            requested_capabilities: Vec::new(),
            desktop_bridge: None,
        }
    }

    pub fn with_desktop_bridge(
        desktop_version: impl Into<String>,
        endpoint_path: PathBuf,
        caller_origin: impl Into<String>,
    ) -> Self {
        let mut session = Self::new(desktop_version);
        session.desktop_bridge = Some(DesktopBridge {
            endpoint_path,
            caller_origin: caller_origin.into(),
        });
        session
    }

    pub fn handle(&mut self, request: RequestEnvelope) -> ResponseEnvelope {
        let request_id = request.request_id;
        let action_request_id = request_id.clone();
        let is_hello = matches!(&request.request, Request::Hello(_));
        if (!self.hello_received && !is_hello) || (self.hello_received && is_hello) {
            return ResponseEnvelope {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                response: Response::Error {
                    error: ProtocolError::new(
                        ErrorCode::InvalidRequest,
                        if is_hello {
                            "Hello has already been completed for this session"
                        } else {
                            "Hello must be the first request in a Native Host session"
                        },
                        false,
                    ),
                },
            };
        }
        let response = match request.request {
            Request::Hello(payload) => {
                self.hello_received = true;
                self.requested_capabilities = payload.capabilities;
                let pairing_state = self.current_pairing_state();
                Response::Ok {
                    payload: ResponsePayload::Hello(HelloResponse {
                        selected_protocol: PROTOCOL_VERSION,
                        desktop_version: self.desktop_version.clone(),
                        session_id: self.session_id.clone(),
                        client_nonce: payload.client_nonce,
                        pairing_state,
                        capabilities: vec![
                            "ping".to_string(),
                            "translation".to_string(),
                            "cancel".to_string(),
                            "wordbook".to_string(),
                        ],
                        limits: ProtocolLimits::default(),
                    }),
                }
            }
            Request::Ping => Response::Ok {
                payload: ResponsePayload::Pong(PongResponse {
                    desktop_version: self.desktop_version.clone(),
                }),
            },
            Request::Pair(payload) => self.request_pairing(payload.display_name),
            Request::Translate(payload) => self.translate(action_request_id, payload),
            Request::Cancel(payload) => self.cancel_translation(payload),
            Request::AddWord(payload) => self.add_word(payload),
        };

        ResponseEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            response,
        }
    }

    fn request_pairing(&self, display_name: String) -> Response {
        let Some(bridge) = &self.desktop_bridge else {
            return desktop_unavailable();
        };
        match desktop_ipc::request_pairing_blocking(
            &bridge.endpoint_path,
            BrowserPairingRequest {
                origin: bridge.caller_origin.clone(),
                display_name,
                capabilities: self.requested_capabilities.clone(),
            },
        ) {
            Ok(pairing_state) => Response::Ok {
                payload: ResponsePayload::Pairing(PairingResponse { pairing_state }),
            },
            Err(_) => desktop_unavailable(),
        }
    }

    fn current_pairing_state(&self) -> PairingState {
        let Some(bridge) = &self.desktop_bridge else {
            return PairingState::Required;
        };
        desktop_ipc::pairing_state_blocking(
            &bridge.endpoint_path,
            bridge.caller_origin.clone(),
            self.requested_capabilities.clone(),
        )
        .unwrap_or(PairingState::Required)
    }

    fn translate(&self, request_id: String, translation: TranslateRequest) -> Response {
        let Some(bridge) = &self.desktop_bridge else {
            return desktop_unavailable();
        };
        match desktop_ipc::translate_blocking(
            &bridge.endpoint_path,
            BrowserTranslationRequest {
                origin: bridge.caller_origin.clone(),
                request_id,
                translation,
            },
        ) {
            Ok(BrowserTranslationOutcome::Success { response }) => Response::Ok {
                payload: ResponsePayload::Translation(response),
            },
            Ok(BrowserTranslationOutcome::Error { error }) => Response::Error { error },
            Err(_) => desktop_unavailable(),
        }
    }

    fn cancel_translation(&self, request: CancelRequest) -> Response {
        let Some(bridge) = &self.desktop_bridge else {
            return desktop_unavailable();
        };
        match desktop_ipc::cancel_blocking(
            &bridge.endpoint_path,
            BrowserCancelRequest {
                origin: bridge.caller_origin.clone(),
                target_request_id: request.target_request_id,
            },
        ) {
            Ok(true) => Response::Ok {
                payload: ResponsePayload::Cancelled,
            },
            Ok(false) => Response::Error {
                error: ProtocolError::new(
                    ErrorCode::InvalidRequest,
                    "Translation request is not active in this session",
                    false,
                ),
            },
            Err(_) => desktop_unavailable(),
        }
    }

    fn add_word(&self, word: AddWordRequest) -> Response {
        let Some(bridge) = &self.desktop_bridge else {
            return desktop_unavailable();
        };
        match desktop_ipc::add_word_blocking(
            &bridge.endpoint_path,
            BrowserAddWordRequest {
                origin: bridge.caller_origin.clone(),
                word,
            },
        ) {
            Ok(BrowserWordAddedOutcome::Success { word_id }) => Response::Ok {
                payload: ResponsePayload::WordAdded(WordAddedResponse { word_id }),
            },
            Ok(BrowserWordAddedOutcome::Error { error }) => Response::Error { error },
            Err(_) => desktop_unavailable(),
        }
    }
}

fn desktop_unavailable() -> Response {
    Response::Error {
        error: ProtocolError::new(
            ErrorCode::DesktopUnavailable,
            "Long Translate desktop is unavailable",
            true,
        ),
    }
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut prefix = [0_u8; 4];
    let mut prefix_bytes = 0;
    while prefix_bytes < prefix.len() {
        match reader.read(&mut prefix[prefix_bytes..])? {
            0 if prefix_bytes == 0 => return Ok(None),
            0 => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Native Messaging frame ended inside its length prefix",
                ));
            }
            count => prefix_bytes += count,
        }
    }

    let message_size = u32::from_le_bytes(prefix) as usize;
    validate_message_size(message_size)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.message))?;

    let mut message = vec![0_u8; message_size];
    reader.read_exact(&mut message)?;
    Ok(Some(message))
}

pub fn write_frame(writer: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    validate_message_size(payload.len())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.message))?;
    let message_size = u32::try_from(payload.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Native Messaging response length does not fit in four bytes",
        )
    })?;
    writer.write_all(&message_size.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

pub fn run_stream(
    reader: &mut impl Read,
    writer: &mut impl Write,
    session: &mut NativeHostSession,
) -> io::Result<()> {
    while let Some(frame) = read_frame(reader)? {
        let response = match parse_request(&frame) {
            Ok(request) => session.handle(request),
            Err(error) => ResponseEnvelope {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id_for_error(&frame),
                response: Response::Error { error },
            },
        };
        let payload = serde_json::to_vec(&response).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Cannot serialize Native Messaging response: {error}"),
            )
        })?;
        write_frame(writer, &payload)?;
    }
    Ok(())
}

fn write_response(writer: &mut impl Write, response: &ResponseEnvelope) -> io::Result<()> {
    let payload = serde_json::to_vec(response).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Cannot serialize Native Messaging response: {error}"),
        )
    })?;
    write_frame(writer, &payload)
}

fn run_stdio_concurrent(mut session: NativeHostSession) -> io::Result<()> {
    let writer = Arc::new(Mutex::new(io::stdout()));
    let in_flight = Arc::new(Mutex::new(HashSet::<String>::new()));
    let mut workers = Vec::new();
    let mut reader = io::stdin().lock();

    while let Some(frame) = read_frame(&mut reader)? {
        let request = match parse_request(&frame) {
            Ok(request) => request,
            Err(error) => {
                let response = ResponseEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id_for_error(&frame),
                    response: Response::Error { error },
                };
                write_response(
                    &mut *writer
                        .lock()
                        .map_err(|_| io::Error::other("Native Host output is unavailable"))?,
                    &response,
                )?;
                continue;
            }
        };

        if matches!(&request.request, Request::Translate(_)) {
            let request_id = request.request_id.clone();
            let mut active = in_flight
                .lock()
                .map_err(|_| io::Error::other("Native Host request state is unavailable"))?;
            if active.len() >= crate::native_protocol::MAX_IN_FLIGHT_REQUESTS
                || !active.insert(request_id.clone())
            {
                drop(active);
                let response = ResponseEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    request_id,
                    response: Response::Error {
                        error: ProtocolError::new(
                            ErrorCode::Busy,
                            "Too many translation requests are active",
                            true,
                        ),
                    },
                };
                write_response(
                    &mut *writer
                        .lock()
                        .map_err(|_| io::Error::other("Native Host output is unavailable"))?,
                    &response,
                )?;
                continue;
            }
            drop(active);

            let mut worker_session = session.clone();
            let worker_writer = Arc::clone(&writer);
            let worker_requests = Arc::clone(&in_flight);
            workers.push(thread::spawn(move || {
                let response = worker_session.handle(request);
                if let Ok(mut output) = worker_writer.lock() {
                    let _ = write_response(&mut *output, &response);
                }
                if let Ok(mut active) = worker_requests.lock() {
                    active.remove(&request_id);
                }
            }));
            continue;
        }

        let response = session.handle(request);
        write_response(
            &mut *writer
                .lock()
                .map_err(|_| io::Error::other("Native Host output is unavailable"))?,
            &response,
        )?;
    }

    let active = in_flight
        .lock()
        .map(|requests| requests.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for request_id in active {
        let _ = session.cancel_translation(CancelRequest {
            target_request_id: request_id,
        });
    }
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

pub fn parse_allowed_origins(value: &str) -> io::Result<Vec<String>> {
    let origins = value
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if origins.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native Host allowed origin list is empty",
        ));
    }
    for origin in &origins {
        validate_origin(origin, std::slice::from_ref(origin))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.message))?;
    }
    Ok(origins)
}

pub fn is_native_host_invocation(args: &[String]) -> bool {
    args.get(1)
        .is_some_and(|value| value.starts_with("chrome-extension://"))
}

pub fn run_from_args(args: &[String]) -> io::Result<()> {
    set_stdio_binary()?;
    let caller_origin = args.get(1).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native Host requires the calling extension origin",
        )
    })?;
    let executable = env::current_exe()?;
    let allowed_origins = match native_registration::load_allowed_origins(&executable) {
        Ok(origins) => origins,
        Err(manifest_error) => development_allowed_origins().map_err(|env_error| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "Native Host has no valid installed manifest ({manifest_error}); {env_error}"
                ),
            )
        })?,
    };
    validate_origin(caller_origin, &allowed_origins)
        .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error.message))?;

    let session = match desktop_ipc::default_endpoint_path() {
        Ok(endpoint_path) => NativeHostSession::with_desktop_bridge(
            env!("CARGO_PKG_VERSION"),
            endpoint_path,
            caller_origin,
        ),
        Err(_) => NativeHostSession::new(env!("CARGO_PKG_VERSION")),
    };
    run_stdio_concurrent(session)
}

fn development_allowed_origins() -> io::Result<Vec<String>> {
    if !cfg!(debug_assertions) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "release builds require an installed Native Host manifest",
        ));
    }
    let allowed_value = env::var(ALLOWED_ORIGINS_ENV).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("debug Native Host requires {ALLOWED_ORIGINS_ENV}"),
        )
    })?;
    parse_allowed_origins(&allowed_value)
}

fn request_id_for_error(bytes: &[u8]) -> String {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("request_id")?.as_str().map(str::to_string))
        .filter(|value| is_safe_request_id(value))
        .unwrap_or_else(|| FALLBACK_REQUEST_ID.to_string())
}

fn is_safe_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(windows)]
fn set_stdio_binary() -> io::Result<()> {
    const STDIN_FILENO: i32 = 0;
    const STDOUT_FILENO: i32 = 1;
    const O_BINARY: i32 = 0x8000;

    unsafe extern "C" {
        #[link_name = "_setmode"]
        fn set_mode(file_descriptor: i32, mode: i32) -> i32;
    }

    for descriptor in [STDIN_FILENO, STDOUT_FILENO] {
        // SAFETY: stdin/stdout are valid CRT descriptors for the process lifetime, and
        // `_setmode` does not retain either argument.
        if unsafe { set_mode(descriptor, O_BINARY) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_stdio_binary() -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_protocol::{
        HelloRequest, PairRequest, ResponsePayload, TextFormat, TranslateRequest, MAX_MESSAGE_BYTES,
    };
    use std::io::Cursor;
    #[cfg(windows)]
    use std::sync::{Arc, Mutex};

    #[cfg(windows)]
    struct RecordingPairingHandler {
        requests: Mutex<Vec<BrowserPairingRequest>>,
        translations: Mutex<Vec<BrowserTranslationRequest>>,
        pairing_state: Mutex<PairingState>,
        words: Mutex<Vec<BrowserAddWordRequest>>,
    }

    #[cfg(windows)]
    impl Default for RecordingPairingHandler {
        fn default() -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                translations: Mutex::new(Vec::new()),
                pairing_state: Mutex::new(PairingState::Required),
                words: Mutex::new(Vec::new()),
            }
        }
    }

    #[cfg(windows)]
    impl desktop_ipc::DesktopIpcHandler for RecordingPairingHandler {
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
                response: crate::native_protocol::TranslationResponse {
                    text: "translated".to_string(),
                    detected_language: Some("en".to_string()),
                    cached: false,
                },
            }
        }

        fn add_word(&self, request: BrowserAddWordRequest) -> BrowserWordAddedOutcome {
            self.words.lock().unwrap().push(request);
            BrowserWordAddedOutcome::Success {
                word_id: "word-123".to_string(),
            }
        }
    }

    fn encode_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::new();
        write_frame(&mut frame, payload).unwrap();
        frame
    }

    #[test]
    fn frame_round_trip_uses_little_endian_lengths() {
        let payload = br#"{"action":"ping"}"#;
        let frame = encode_frame(payload);
        assert_eq!(&frame[..4], &(payload.len() as u32).to_le_bytes());
        assert_eq!(
            read_frame(&mut Cursor::new(frame)).unwrap().unwrap(),
            payload
        );
    }

    #[test]
    fn oversized_frame_is_rejected_before_reading_a_payload() {
        let prefix = ((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes();
        let error = read_frame(&mut Cursor::new(prefix)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("1 MiB"));
    }

    #[test]
    fn truncated_prefix_and_payload_are_rejected() {
        assert_eq!(
            read_frame(&mut Cursor::new([1_u8, 0])).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            read_frame(&mut Cursor::new([2_u8, 0, 0, 0, b'{']))
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn hello_and_ping_advertise_only_the_available_foundation() {
        let mut session = NativeHostSession::new("0.5.0-test");
        let hello = session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "hello-1".to_string(),
            request: Request::Hello(HelloRequest {
                min_protocol: 1,
                max_protocol: 1,
                extension_version: "0.1.0".to_string(),
                client_nonce: "nonce-1".to_string(),
                capabilities: vec!["translation".to_string()],
            }),
        });
        match hello.response {
            Response::Ok {
                payload: ResponsePayload::Hello(payload),
            } => {
                assert_eq!(payload.desktop_version, "0.5.0-test");
                assert_eq!(payload.client_nonce, "nonce-1");
                assert_eq!(payload.pairing_state, PairingState::Required);
                assert_eq!(
                    payload.capabilities,
                    ["ping", "translation", "cancel", "wordbook"]
                );
                assert!(payload.session_id.starts_with("session-"));
            }
            response => panic!("unexpected hello response: {response:?}"),
        }

        let pong = session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "ping-1".to_string(),
            request: Request::Ping,
        });
        assert!(matches!(
            pong.response,
            Response::Ok {
                payload: ResponsePayload::Pong(PongResponse { .. })
            }
        ));
    }

    #[test]
    fn actions_without_a_desktop_bridge_fail_closed() {
        let mut session = NativeHostSession::new("test");
        session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "hello-1".to_string(),
            request: Request::Hello(HelloRequest {
                min_protocol: 1,
                max_protocol: 1,
                extension_version: "0.1.0".to_string(),
                client_nonce: "nonce-1".to_string(),
                capabilities: vec!["translation".to_string()],
            }),
        });
        let pair = session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "pair-1".to_string(),
            request: Request::Pair(PairRequest {
                display_name: "Long Translate test".to_string(),
            }),
        });
        assert!(matches!(
            pair.response,
            Response::Error {
                error: ProtocolError {
                    code: ErrorCode::DesktopUnavailable,
                    retryable: true,
                    ..
                }
            }
        ));

        let translate = session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "translate-1".to_string(),
            request: Request::Translate(TranslateRequest {
                text: "hello".to_string(),
                target_language: "zh-Hans".to_string(),
                source_language: Some("en".to_string()),
                format: TextFormat::PlainText,
                glossary: Vec::new(),
            }),
        });
        assert!(matches!(
            translate.response,
            Response::Error {
                error: ProtocolError {
                    code: ErrorCode::DesktopUnavailable,
                    retryable: true,
                    ..
                }
            }
        ));
    }

    #[test]
    fn malformed_framed_json_returns_an_error_without_leaking_input() {
        let input = encode_frame(br#"{"request_id":"broken-1","secret":"do-not-echo"}"#);
        let mut output = Vec::new();
        let mut session = NativeHostSession::new("test");
        run_stream(&mut Cursor::new(input), &mut output, &mut session).unwrap();

        let payload = read_frame(&mut Cursor::new(output)).unwrap().unwrap();
        let response: ResponseEnvelope = serde_json::from_slice(&payload).unwrap();
        assert_eq!(response.request_id, "broken-1");
        assert!(matches!(
            response.response,
            Response::Error {
                error: ProtocolError {
                    code: ErrorCode::InvalidMessage,
                    ..
                }
            }
        ));
        assert!(!String::from_utf8(payload).unwrap().contains("do-not-echo"));
    }

    #[test]
    fn hello_is_required_once_at_the_start_of_each_session() {
        let mut session = NativeHostSession::new("test");
        let before_hello = session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "ping-before-hello".to_string(),
            request: Request::Ping,
        });
        assert!(matches!(
            before_hello.response,
            Response::Error {
                error: ProtocolError {
                    code: ErrorCode::InvalidRequest,
                    ..
                }
            }
        ));

        let hello = RequestEnvelope {
            protocol_version: 1,
            request_id: "hello-1".to_string(),
            request: Request::Hello(HelloRequest {
                min_protocol: 1,
                max_protocol: 1,
                extension_version: "0.1.0".to_string(),
                client_nonce: "nonce-1".to_string(),
                capabilities: Vec::new(),
            }),
        };
        assert!(matches!(
            session.handle(hello.clone()).response,
            Response::Ok { .. }
        ));
        assert!(matches!(
            session.handle(hello).response,
            Response::Error {
                error: ProtocolError {
                    code: ErrorCode::InvalidRequest,
                    ..
                }
            }
        ));
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn paired_action_is_forwarded_to_the_authenticated_desktop_pipe() {
        let app_dir = std::env::temp_dir().join(format!("long-host-pair-{}", Uuid::new_v4()));
        let handler = Arc::new(RecordingPairingHandler::default());
        let state = desktop_ipc::start_server(app_dir.clone(), handler.clone()).unwrap();
        let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
        let mut session = NativeHostSession::with_desktop_bridge(
            "test",
            desktop_ipc::endpoint_path(&app_dir),
            origin,
        );
        session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "hello-1".to_string(),
            request: Request::Hello(HelloRequest {
                min_protocol: 1,
                max_protocol: 1,
                extension_version: "0.1.0".to_string(),
                client_nonce: "nonce-1".to_string(),
                capabilities: vec!["translation".to_string()],
            }),
        });

        let response = tokio::task::spawn_blocking(move || {
            session.handle(RequestEnvelope {
                protocol_version: 1,
                request_id: "pair-1".to_string(),
                request: Request::Pair(PairRequest {
                    display_name: "Long Translate extension".to_string(),
                }),
            })
        })
        .await
        .unwrap();
        assert!(matches!(
            response.response,
            Response::Ok {
                payload: ResponsePayload::Pairing(PairingResponse {
                    pairing_state: PairingState::Pending
                })
            }
        ));
        assert_eq!(
            *handler.requests.lock().unwrap(),
            vec![BrowserPairingRequest {
                origin: origin.to_string(),
                display_name: "Long Translate extension".to_string(),
                capabilities: vec!["translation".to_string()],
            }]
        );

        drop(state);
        let _ = std::fs::remove_dir_all(app_dir);
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn translation_is_forwarded_to_the_authenticated_desktop_pipe() {
        let app_dir = std::env::temp_dir().join(format!("long-host-translate-{}", Uuid::new_v4()));
        let handler = Arc::new(RecordingPairingHandler::default());
        *handler.pairing_state.lock().unwrap() = PairingState::Approved;
        let state = desktop_ipc::start_server(app_dir.clone(), handler.clone()).unwrap();
        let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
        let mut session = NativeHostSession::with_desktop_bridge(
            "test",
            desktop_ipc::endpoint_path(&app_dir),
            origin,
        );
        session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "hello-1".to_string(),
            request: Request::Hello(HelloRequest {
                min_protocol: 1,
                max_protocol: 1,
                extension_version: "0.1.0".to_string(),
                client_nonce: "nonce-1".to_string(),
                capabilities: vec!["translation".to_string()],
            }),
        });
        let translation = TranslateRequest {
            text: "hello".to_string(),
            target_language: "zh-Hans".to_string(),
            source_language: Some("en".to_string()),
            format: TextFormat::PlainText,
            glossary: Vec::new(),
        };
        let request_translation = translation.clone();
        let response = tokio::task::spawn_blocking(move || {
            session.handle(RequestEnvelope {
                protocol_version: 1,
                request_id: "translate-1".to_string(),
                request: Request::Translate(request_translation),
            })
        })
        .await
        .unwrap();
        assert!(matches!(
            response.response,
            Response::Ok {
                payload: ResponsePayload::Translation(crate::native_protocol::TranslationResponse {
                    text,
                    cached: false,
                    ..
                })
            } if text == "translated"
        ));
        assert_eq!(
            *handler.translations.lock().unwrap(),
            vec![BrowserTranslationRequest {
                origin: origin.to_string(),
                request_id: "translate-1".to_string(),
                translation,
            }]
        );

        drop(state);
        let _ = std::fs::remove_dir_all(app_dir);
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn wordbook_write_is_forwarded_to_the_authenticated_desktop_pipe() {
        let app_dir = std::env::temp_dir().join(format!("long-host-word-{}", Uuid::new_v4()));
        let handler = Arc::new(RecordingPairingHandler::default());
        *handler.pairing_state.lock().unwrap() = PairingState::Approved;
        let state = desktop_ipc::start_server(app_dir.clone(), handler.clone()).unwrap();
        let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
        let mut session = NativeHostSession::with_desktop_bridge(
            "test",
            desktop_ipc::endpoint_path(&app_dir),
            origin,
        );
        session.handle(RequestEnvelope {
            protocol_version: 1,
            request_id: "hello-1".to_string(),
            request: Request::Hello(HelloRequest {
                min_protocol: 1,
                max_protocol: 1,
                extension_version: "0.1.0".to_string(),
                client_nonce: "nonce-1".to_string(),
                capabilities: vec!["wordbook".to_string()],
            }),
        });
        let word = AddWordRequest {
            word: "hello".to_string(),
            translation: "你好".to_string(),
            context: None,
        };
        let request_word = word.clone();
        let response = tokio::task::spawn_blocking(move || {
            session.handle(RequestEnvelope {
                protocol_version: 1,
                request_id: "word-1".to_string(),
                request: Request::AddWord(request_word),
            })
        })
        .await
        .unwrap();
        assert!(matches!(
            response.response,
            Response::Ok {
                payload: ResponsePayload::WordAdded(WordAddedResponse { word_id })
            } if word_id == "word-123"
        ));
        assert_eq!(
            *handler.words.lock().unwrap(),
            vec![BrowserAddWordRequest {
                origin: origin.to_string(),
                word,
            }]
        );
        drop(state);
        let _ = std::fs::remove_dir_all(app_dir);
    }

    #[test]
    fn allowed_origins_are_exact_and_fail_closed() {
        let origins = parse_allowed_origins(
            " chrome-extension://abcdefghijklmnopabcdefghijklmnop/ ;chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/ ",
        )
        .unwrap();
        assert_eq!(origins.len(), 2);
        validate_origin(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            &origins,
        )
        .unwrap();
        assert!(validate_origin("chrome-extension://other/", &origins).is_err());
        assert!(parse_allowed_origins(" ; ").is_err());
        assert!(parse_allowed_origins("chrome-extension://*/").is_err());
    }

    #[test]
    fn only_an_extension_origin_selects_native_host_mode() {
        assert!(is_native_host_invocation(&[
            "long-translate.exe".to_string(),
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(),
        ]));
        assert!(!is_native_host_invocation(&[
            "long-translate.exe".to_string(),
            "--autostart".to_string(),
        ]));
    }
}
