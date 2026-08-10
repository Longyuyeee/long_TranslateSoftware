use crate::native_protocol::{
    parse_request, validate_message_size, validate_origin, ErrorCode, HelloResponse, PairingState,
    PongResponse, ProtocolError, ProtocolLimits, Request, RequestEnvelope, Response,
    ResponseEnvelope, ResponsePayload, PROTOCOL_VERSION,
};
use serde_json::Value;
use std::env;
use std::io::{self, Read, Write};
use uuid::Uuid;

pub const ALLOWED_ORIGINS_ENV: &str = "LONG_TRANSLATE_NATIVE_ALLOWED_ORIGINS";
const FALLBACK_REQUEST_ID: &str = "host";

pub struct NativeHostSession {
    desktop_version: String,
    session_id: String,
}

impl NativeHostSession {
    pub fn new(desktop_version: impl Into<String>) -> Self {
        Self {
            desktop_version: desktop_version.into(),
            session_id: format!("session-{}", Uuid::new_v4()),
        }
    }

    pub fn handle(&self, request: RequestEnvelope) -> ResponseEnvelope {
        let request_id = request.request_id;
        let response = match request.request {
            Request::Hello(payload) => Response::Ok {
                payload: ResponsePayload::Hello(HelloResponse {
                    selected_protocol: PROTOCOL_VERSION,
                    desktop_version: self.desktop_version.clone(),
                    session_id: self.session_id.clone(),
                    client_nonce: payload.client_nonce,
                    pairing_state: PairingState::Required,
                    capabilities: vec!["ping".to_string()],
                    limits: ProtocolLimits::default(),
                }),
            },
            Request::Ping => Response::Ok {
                payload: ResponsePayload::Pong(PongResponse {
                    desktop_version: self.desktop_version.clone(),
                }),
            },
            Request::Pair(_) => Response::Error {
                error: ProtocolError::new(
                    ErrorCode::DesktopUnavailable,
                    "Desktop pairing is not available in this host build",
                    true,
                ),
            },
            Request::Translate(_) | Request::AddWord(_) | Request::Cancel(_) => Response::Error {
                error: ProtocolError::new(
                    ErrorCode::PairingRequired,
                    "Desktop approval is required",
                    false,
                ),
            },
        };

        ResponseEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            response,
        }
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
    session: &NativeHostSession,
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

pub fn run_from_env() -> io::Result<()> {
    set_stdio_binary()?;
    let mut args = env::args();
    let _executable = args.next();
    let caller_origin = args.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native Host requires the calling extension origin",
        )
    })?;
    let allowed_value = env::var(ALLOWED_ORIGINS_ENV).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Native Host requires {ALLOWED_ORIGINS_ENV}"),
        )
    })?;
    let allowed_origins = parse_allowed_origins(&allowed_value)?;
    validate_origin(&caller_origin, &allowed_origins)
        .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error.message))?;

    let session = NativeHostSession::new(env!("CARGO_PKG_VERSION"));
    run_stream(&mut io::stdin().lock(), &mut io::stdout().lock(), &session)
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
        let session = NativeHostSession::new("0.5.0-test");
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
                assert_eq!(payload.capabilities, ["ping"]);
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
        let session = NativeHostSession::new("test");
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
                    code: ErrorCode::PairingRequired,
                    retryable: false,
                    ..
                }
            }
        ));
    }

    #[test]
    fn malformed_framed_json_returns_an_error_without_leaking_input() {
        let input = encode_frame(br#"{"request_id":"broken-1","secret":"do-not-echo"}"#);
        let mut output = Vec::new();
        run_stream(
            &mut Cursor::new(input),
            &mut output,
            &NativeHostSession::new("test"),
        )
        .unwrap();

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
    fn allowed_origins_are_exact_and_fail_closed() {
        let origins = parse_allowed_origins(
            " chrome-extension://abcdefghijklmnop/ ;chrome-extension://qrstuvwxyzabcdef/ ",
        )
        .unwrap();
        assert_eq!(origins.len(), 2);
        validate_origin("chrome-extension://abcdefghijklmnop/", &origins).unwrap();
        assert!(validate_origin("chrome-extension://other/", &origins).is_err());
        assert!(parse_allowed_origins(" ; ").is_err());
        assert!(parse_allowed_origins("chrome-extension://*/").is_err());
    }
}
