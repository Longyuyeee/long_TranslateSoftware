use long_translate_lib::native_host::{read_frame, write_frame, ALLOWED_ORIGINS_ENV};
use long_translate_lib::native_protocol::{
    ErrorCode, HelloRequest, PairingState, Request, RequestEnvelope, Response, ResponseEnvelope,
    ResponsePayload, MAX_MESSAGE_BYTES,
};
use std::io::{Cursor, Write};
use std::process::{Command, Output, Stdio};

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
            assert_eq!(payload.capabilities, ["ping"]);
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
