use long_translate_lib::desktop_ipc::{
    self, BrowserAddWordRequest, BrowserCancelRequest, BrowserPairingRequest,
    BrowserTranslationOutcome, BrowserTranslationRequest, BrowserWordAddedOutcome,
    DesktopIpcHandler,
};
use long_translate_lib::native_host::{read_frame, write_frame, ALLOWED_ORIGINS_ENV};
use long_translate_lib::native_protocol::{
    AddWordRequest, CancelRequest, ErrorCode, HelloRequest, PairRequest, PairingResponse,
    PairingState, ProtocolError, Request, RequestEnvelope, Response, ResponseEnvelope,
    ResponsePayload, TextFormat, TranslateRequest, TranslationResponse, WordAddedResponse,
    MAX_MESSAGE_BYTES,
};
use std::io::{Cursor, Write};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use uuid::Uuid;

const ALLOWED_ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

fn native_host_path() -> &'static str {
    env!("CARGO_BIN_EXE_long-translate")
}

fn run_host(origin: &str, input: &[u8]) -> Output {
    let mut child = Command::new(native_host_path())
        .arg(origin)
        .env(ALLOWED_ORIGINS_ENV, ALLOWED_ORIGIN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("native host should start");
    child
        .stdin
        .take()
        .expect("stdin should be piped")
        .write_all(input)
        .expect("test input should be written");
    child.wait_with_output().expect("native host should exit")
}

fn run_host_without_allowlist(origin: &str) -> Output {
    Command::new(native_host_path())
        .arg(origin)
        .env_remove(ALLOWED_ORIGINS_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("native host should start")
}

fn framed(request: &RequestEnvelope) -> Vec<u8> {
    let payload = serde_json::to_vec(request).expect("request should serialize");
    let mut frame = Vec::new();
    write_frame(&mut frame, &payload).expect("request frame should encode");
    frame
}

fn decode_responses(output: &[u8]) -> Vec<ResponseEnvelope> {
    let mut reader = Cursor::new(output);
    let mut responses = Vec::new();
    while let Some(payload) = read_frame(&mut reader).expect("response frame should decode") {
        responses.push(serde_json::from_slice(&payload).expect("response should be JSON"));
    }
    responses
}

#[derive(Default)]
struct RecordingPairingHandler {
    requests: Mutex<Vec<BrowserPairingRequest>>,
    translations: Mutex<Vec<BrowserTranslationRequest>>,
    cancellations: Mutex<Vec<BrowserCancelRequest>>,
    words: Mutex<Vec<BrowserAddWordRequest>>,
    cancellation: (Mutex<bool>, Condvar),
}

impl DesktopIpcHandler for RecordingPairingHandler {
    fn pairing_state(
        &self,
        _origin: &str,
        _capabilities: &[String],
    ) -> std::io::Result<PairingState> {
        Ok(PairingState::Required)
    }

    fn request_pairing(&self, request: BrowserPairingRequest) -> std::io::Result<PairingState> {
        self.requests.lock().unwrap().push(request);
        Ok(PairingState::Pending)
    }

    fn translate(&self, request: BrowserTranslationRequest) -> BrowserTranslationOutcome {
        let slow = request.translation.text == "slow request";
        self.translations.lock().unwrap().push(request);
        if slow {
            let (cancelled, signal) = &self.cancellation;
            let guard = cancelled.lock().unwrap();
            let (guard, _) = signal
                .wait_timeout_while(guard, std::time::Duration::from_secs(5), |value| !*value)
                .unwrap();
            if *guard {
                return BrowserTranslationOutcome::Error {
                    error: ProtocolError::new(ErrorCode::Cancelled, "Translation cancelled", false),
                };
            }
        }
        BrowserTranslationOutcome::Success {
            response: TranslationResponse {
                text: "translated by desktop".to_string(),
                detected_language: Some("en".to_string()),
                cached: false,
            },
        }
    }

    fn cancel(&self, request: BrowserCancelRequest) -> std::io::Result<bool> {
        self.cancellations.lock().unwrap().push(request);
        let (cancelled, signal) = &self.cancellation;
        *cancelled.lock().unwrap() = true;
        signal.notify_all();
        Ok(true)
    }

    fn add_word(&self, request: BrowserAddWordRequest) -> BrowserWordAddedOutcome {
        self.words.lock().unwrap().push(request);
        BrowserWordAddedOutcome::Success {
            word_id: "word-process-123".to_string(),
        }
    }
}

#[test]
fn host_process_handles_hello_and_ping_without_unframed_stdout() {
    let hello = RequestEnvelope {
        protocol_version: 1,
        request_id: "hello-1".to_string(),
        request: Request::Hello(HelloRequest {
            min_protocol: 1,
            max_protocol: 1,
            extension_version: "0.1.0".to_string(),
            client_nonce: "nonce-1".to_string(),
            capabilities: vec!["translation".to_string()],
        }),
    };
    let ping = RequestEnvelope {
        protocol_version: 1,
        request_id: "ping-1".to_string(),
        request: Request::Ping,
    };
    let mut input = framed(&hello);
    input.extend(framed(&ping));

    let output = run_host(ALLOWED_ORIGIN, &input);
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let responses = decode_responses(&output.stdout);
    assert_eq!(responses.len(), 2);
    match &responses[0].response {
        Response::Ok {
            payload: ResponsePayload::Hello(payload),
        } => {
            assert_eq!(payload.client_nonce, "nonce-1");
            assert_eq!(payload.pairing_state, PairingState::Required);
            assert_eq!(
                payload.capabilities,
                ["ping", "translation", "cancel", "wordbook"]
            );
        }
        response => panic!("unexpected hello response: {response:?}"),
    }
    assert!(matches!(
        responses[1].response,
        Response::Ok {
            payload: ResponsePayload::Pong(_)
        }
    ));
}

#[test]
fn host_process_rejects_an_unauthorized_origin_before_reading_messages() {
    let output = run_host("chrome-extension://unauthorized/", &[]);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("not authorized"), "stderr: {stderr}");
}

#[test]
fn host_process_requires_an_explicit_allowlist() {
    let output = run_host_without_allowlist(ALLOWED_ORIGIN);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(ALLOWED_ORIGINS_ENV),
        "stderr should identify the missing configuration"
    );
}

#[test]
fn host_process_rejects_oversized_frames_before_payload_allocation() {
    let input = ((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes();
    let output = run_host(ALLOWED_ORIGIN, &input);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("1 MiB"), "stderr: {stderr}");
}

#[test]
fn host_process_returns_a_framed_error_for_invalid_json() {
    let mut input = Vec::new();
    write_frame(&mut input, b"not-json").expect("invalid JSON can still be framed");
    let output = run_host(ALLOWED_ORIGIN, &input);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let responses = decode_responses(&output.stdout);
    assert_eq!(responses.len(), 1);
    assert!(matches!(
        responses[0].response,
        Response::Error {
            error: long_translate_lib::native_protocol::ProtocolError {
                code: ErrorCode::InvalidMessage,
                ..
            }
        }
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn host_process_forwards_pairing_to_the_running_desktop_pipe() {
    let roaming_root = std::env::temp_dir().join(format!("long-host-process-{}", Uuid::new_v4()));
    let app_dir = roaming_root.join("com.long.translate");
    let handler = Arc::new(RecordingPairingHandler::default());
    let state = desktop_ipc::start_server(app_dir, handler.clone()).unwrap();

    let hello = RequestEnvelope {
        protocol_version: 1,
        request_id: "hello-pair".to_string(),
        request: Request::Hello(HelloRequest {
            min_protocol: 1,
            max_protocol: 1,
            extension_version: "0.1.0".to_string(),
            client_nonce: "nonce-pair".to_string(),
            capabilities: vec!["translation".to_string()],
        }),
    };
    let pair = RequestEnvelope {
        protocol_version: 1,
        request_id: "pair-1".to_string(),
        request: Request::Pair(PairRequest {
            display_name: "Long Translate browser extension".to_string(),
        }),
    };
    let mut input = framed(&hello);
    input.extend(framed(&pair));
    let roaming_for_child = roaming_root.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(native_host_path())
            .arg(ALLOWED_ORIGIN)
            .env(ALLOWED_ORIGINS_ENV, ALLOWED_ORIGIN)
            .env("APPDATA", roaming_for_child)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("native host should start");
        child.stdin.take().unwrap().write_all(&input).unwrap();
        child.wait_with_output().unwrap()
    })
    .await
    .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = decode_responses(&output.stdout);
    assert!(matches!(
        responses[1].response,
        Response::Ok {
            payload: ResponsePayload::Pairing(PairingResponse {
                pairing_state: PairingState::Pending
            })
        }
    ));
    assert_eq!(handler.requests.lock().unwrap().len(), 1);

    drop(state);
    let _ = std::fs::remove_dir_all(roaming_root);
}

#[tokio::test(flavor = "multi_thread")]
async fn host_process_forwards_translation_cancellation_and_wordbook_write() {
    let roaming_root = std::env::temp_dir().join(format!("long-host-data-{}", Uuid::new_v4()));
    let app_dir = roaming_root.join("com.long.translate");
    let handler = Arc::new(RecordingPairingHandler::default());
    let state = desktop_ipc::start_server(app_dir, handler.clone()).unwrap();

    let hello = RequestEnvelope {
        protocol_version: 1,
        request_id: "hello-data".to_string(),
        request: Request::Hello(HelloRequest {
            min_protocol: 1,
            max_protocol: 1,
            extension_version: "0.1.0".to_string(),
            client_nonce: "nonce-data".to_string(),
            capabilities: vec!["translation".to_string(), "wordbook".to_string()],
        }),
    };
    let translation = TranslateRequest {
        text: "slow request".to_string(),
        target_language: "zh-Hans".to_string(),
        source_language: Some("en".to_string()),
        format: TextFormat::PlainText,
        glossary: Vec::new(),
    };
    let translate = RequestEnvelope {
        protocol_version: 1,
        request_id: "translate-process-1".to_string(),
        request: Request::Translate(translation.clone()),
    };
    let word = AddWordRequest {
        word: "hello".to_string(),
        translation: "你好".to_string(),
        context: None,
    };
    let add_word = RequestEnvelope {
        protocol_version: 1,
        request_id: "word-process-1".to_string(),
        request: Request::AddWord(word.clone()),
    };
    let cancel = RequestEnvelope {
        protocol_version: 1,
        request_id: "cancel-process-1".to_string(),
        request: Request::Cancel(CancelRequest {
            target_request_id: "translate-process-1".to_string(),
        }),
    };
    let mut input = framed(&hello);
    input.extend(framed(&translate));
    input.extend(framed(&add_word));
    input.extend(framed(&cancel));

    let roaming_for_child = roaming_root.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(native_host_path())
            .arg(ALLOWED_ORIGIN)
            .env(ALLOWED_ORIGINS_ENV, ALLOWED_ORIGIN)
            .env("APPDATA", roaming_for_child)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("native host should start");
        child.stdin.take().unwrap().write_all(&input).unwrap();
        child.wait_with_output().unwrap()
    })
    .await
    .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = decode_responses(&output.stdout);
    assert_eq!(responses.len(), 4);
    let response = |request_id: &str| {
        responses
            .iter()
            .find(|response| response.request_id == request_id)
            .unwrap_or_else(|| panic!("missing response for {request_id}"))
    };
    assert!(matches!(
        response("word-process-1").response,
        Response::Ok {
            payload: ResponsePayload::WordAdded(WordAddedResponse { ref word_id })
        } if word_id == "word-process-123"
    ));
    assert!(matches!(
        response("cancel-process-1").response,
        Response::Ok {
            payload: ResponsePayload::Cancelled
        }
    ));
    let translation_response = response("translate-process-1");
    assert!(
        matches!(
            translation_response.response,
            Response::Error {
                error: ProtocolError {
                    code: ErrorCode::Cancelled,
                    ..
                }
            }
        ),
        "unexpected translation response: {translation_response:?}"
    );
    assert_eq!(
        *handler.translations.lock().unwrap(),
        vec![BrowserTranslationRequest {
            origin: ALLOWED_ORIGIN.to_string(),
            request_id: "translate-process-1".to_string(),
            translation,
        }]
    );
    assert_eq!(
        *handler.cancellations.lock().unwrap(),
        vec![BrowserCancelRequest {
            origin: ALLOWED_ORIGIN.to_string(),
            target_request_id: "translate-process-1".to_string(),
        }]
    );
    assert_eq!(
        *handler.words.lock().unwrap(),
        vec![BrowserAddWordRequest {
            origin: ALLOWED_ORIGIN.to_string(),
            word,
        }]
    );

    drop(state);
    let _ = std::fs::remove_dir_all(roaming_root);
}
