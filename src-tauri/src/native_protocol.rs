use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 32 * 1024;
pub const MAX_GLOSSARY_ENTRIES: usize = 100;
pub const MAX_IN_FLIGHT_REQUESTS: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "payload", rename_all = "snake_case")]
pub enum Request {
    Hello(HelloRequest),
    Pair(PairRequest),
    Translate(TranslateRequest),
    AddWord(AddWordRequest),
    Cancel(CancelRequest),
    Ping,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelloRequest {
    pub min_protocol: u16,
    pub max_protocol: u16,
    pub extension_version: String,
    pub client_nonce: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairRequest {
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranslateRequest {
    pub text: String,
    pub target_language: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_language: Option<String>,
    #[serde(default)]
    pub format: TextFormat,
    #[serde(default)]
    pub glossary: Vec<GlossaryTerm>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextFormat {
    #[default]
    PlainText,
    Markdown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GlossaryTerm {
    pub source: String,
    pub target: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddWordRequest {
    pub word: String,
    pub translation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    pub target_request_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    #[serde(flatten)]
    pub response: Response,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok { payload: ResponsePayload },
    Error { error: ProtocolError },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ResponsePayload {
    Hello(HelloResponse),
    Pairing(PairingResponse),
    Translation(TranslationResponse),
    WordAdded(WordAddedResponse),
    Cancelled,
    Pong(PongResponse),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloResponse {
    pub selected_protocol: u16,
    pub desktop_version: String,
    pub session_id: String,
    pub client_nonce: String,
    pub pairing_state: PairingState,
    pub capabilities: Vec<String>,
    pub limits: ProtocolLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PairingState {
    Required,
    Pending,
    Approved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolLimits {
    pub max_message_bytes: usize,
    pub max_text_bytes: usize,
    pub max_glossary_entries: usize,
    pub max_in_flight_requests: usize,
}

impl Default for ProtocolLimits {
    fn default() -> Self {
        Self {
            max_message_bytes: MAX_MESSAGE_BYTES,
            max_text_bytes: MAX_TEXT_BYTES,
            max_glossary_entries: MAX_GLOSSARY_ENTRIES,
            max_in_flight_requests: MAX_IN_FLIGHT_REQUESTS,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingResponse {
    pub pairing_state: PairingState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationResponse {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_language: Option<String>,
    pub cached: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordAddedResponse {
    pub word_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PongResponse {
    pub desktop_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    #[serde(flatten)]
    pub event: Event,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload", rename_all = "snake_case")]
pub enum Event {
    TranslationProgress { text: String },
    PairingChanged { pairing_state: PairingState },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl ProtocolError {
    fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidMessage,
    UnsupportedVersion,
    UnauthorizedOrigin,
    PairingRequired,
    PermissionDenied,
    RequestTooLarge,
    InvalidRequest,
    Busy,
    DesktopUnavailable,
    Timeout,
    Cancelled,
    ProviderError,
    InternalError,
}

impl RequestEnvelope {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::new(
                ErrorCode::UnsupportedVersion,
                "Unsupported protocol version",
                false,
            ));
        }
        validate_request_id(&self.request_id)?;

        match &self.request {
            Request::Hello(request) => {
                if request.min_protocol > PROTOCOL_VERSION
                    || request.max_protocol < PROTOCOL_VERSION
                    || request.min_protocol > request.max_protocol
                {
                    return Err(ProtocolError::new(
                        ErrorCode::UnsupportedVersion,
                        "No compatible protocol version",
                        false,
                    ));
                }
                validate_short_field("extension_version", &request.extension_version, 64)?;
                validate_short_field("client_nonce", &request.client_nonce, 128)?;
                if request.capabilities.len() > 32
                    || request
                        .capabilities
                        .iter()
                        .any(|value| !is_safe_identifier(value, 64))
                {
                    return Err(invalid_request("Invalid capability list"));
                }
            }
            Request::Pair(request) => {
                validate_short_field("display_name", &request.display_name, 80)?;
            }
            Request::Translate(request) => {
                validate_text("text", &request.text, MAX_TEXT_BYTES)?;
                validate_language("target_language", &request.target_language)?;
                if let Some(language) = &request.source_language {
                    validate_language("source_language", language)?;
                }
                if request.glossary.len() > MAX_GLOSSARY_ENTRIES {
                    return Err(invalid_request("Too many glossary entries"));
                }
                for term in &request.glossary {
                    validate_text("glossary.source", &term.source, 512)?;
                    validate_text("glossary.target", &term.target, 512)?;
                }
            }
            Request::AddWord(request) => {
                validate_text("word", &request.word, 1024)?;
                validate_text("translation", &request.translation, 8 * 1024)?;
                if let Some(context) = &request.context {
                    validate_text("context", context, 16 * 1024)?;
                }
            }
            Request::Cancel(request) => {
                validate_request_id(&request.target_request_id)?;
                if request.target_request_id == self.request_id {
                    return Err(invalid_request("A cancel request cannot target itself"));
                }
            }
            Request::Ping => {}
        }
        Ok(())
    }
}

pub fn parse_request(bytes: &[u8]) -> Result<RequestEnvelope, ProtocolError> {
    validate_message_size(bytes.len())?;
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| {
        ProtocolError::new(
            ErrorCode::InvalidMessage,
            "Message is not valid UTF-8 JSON",
            false,
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        ProtocolError::new(
            ErrorCode::InvalidMessage,
            "Message must be a JSON object",
            false,
        )
    })?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "protocol_version" | "request_id" | "action" | "payload"
        )
    }) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidMessage,
            "Message contains unknown top-level fields",
            false,
        ));
    }

    let request = serde_json::from_value::<RequestEnvelope>(value).map_err(|_| {
        ProtocolError::new(
            ErrorCode::InvalidMessage,
            "Message does not match the v1 request schema",
            false,
        )
    })?;
    request.validate()?;
    Ok(request)
}

pub fn validate_origin(origin: &str, allowed_origins: &[String]) -> Result<(), ProtocolError> {
    let structurally_valid = origin.starts_with("chrome-extension://")
        && origin.ends_with('/')
        && !origin.contains('*')
        && origin.len() <= 128;
    if !structurally_valid || !allowed_origins.iter().any(|allowed| allowed == origin) {
        return Err(ProtocolError::new(
            ErrorCode::UnauthorizedOrigin,
            "Extension origin is not authorized",
            false,
        ));
    }
    Ok(())
}

pub fn validate_message_size(size: usize) -> Result<(), ProtocolError> {
    if size > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::new(
            ErrorCode::RequestTooLarge,
            "Message exceeds the 1 MiB host limit",
            false,
        ));
    }
    Ok(())
}

fn validate_request_id(value: &str) -> Result<(), ProtocolError> {
    if !is_safe_identifier(value, 64) {
        return Err(invalid_request("Invalid request_id"));
    }
    Ok(())
}

fn validate_language(field: &str, value: &str) -> Result<(), ProtocolError> {
    if value.len() > 35
        || value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(invalid_request(format!("Invalid {field}")));
    }
    Ok(())
}

fn validate_short_field(field: &str, value: &str, max_bytes: usize) -> Result<(), ProtocolError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(invalid_request(format!("Invalid {field}")));
    }
    Ok(())
}

fn validate_text(field: &str, value: &str, max_bytes: usize) -> Result<(), ProtocolError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(invalid_request(format!("Invalid {field}")));
    }
    Ok(())
}

fn is_safe_identifier(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn invalid_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCode::InvalidRequest, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello_request() -> RequestEnvelope {
        RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "request-1".to_string(),
            request: Request::Hello(HelloRequest {
                min_protocol: 1,
                max_protocol: 1,
                extension_version: "0.1.0".to_string(),
                client_nonce: "nonce-1".to_string(),
                capabilities: vec!["translation".to_string(), "wordbook".to_string()],
            }),
        }
    }

    #[test]
    fn hello_round_trip_preserves_the_versioned_envelope() {
        let request = hello_request();
        request.validate().unwrap();
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<RequestEnvelope>(&json).unwrap(),
            request
        );
        assert_eq!(parse_request(json.as_bytes()).unwrap(), request);
    }

    #[test]
    fn incompatible_versions_and_unsafe_ids_are_rejected() {
        let mut request = hello_request();
        request.protocol_version = 2;
        assert_eq!(
            request.validate().unwrap_err().code,
            ErrorCode::UnsupportedVersion
        );
        request.protocol_version = 1;
        request.request_id = "../unsafe".to_string();
        assert_eq!(
            request.validate().unwrap_err().code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn translation_limits_bound_text_languages_and_glossary() {
        let mut request = RequestEnvelope {
            protocol_version: 1,
            request_id: "translate-1".to_string(),
            request: Request::Translate(TranslateRequest {
                text: "hello".to_string(),
                target_language: "zh-Hans".to_string(),
                source_language: Some("en".to_string()),
                format: TextFormat::PlainText,
                glossary: vec![GlossaryTerm {
                    source: "Long Translate".to_string(),
                    target: "Long翻译".to_string(),
                }],
            }),
        };
        request.validate().unwrap();
        if let Request::Translate(payload) = &mut request.request {
            payload.text = "x".repeat(MAX_TEXT_BYTES + 1);
        }
        assert_eq!(
            request.validate().unwrap_err().code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn origins_require_an_exact_manifest_allowlist_match() {
        let allowed = vec!["chrome-extension://abcdefghijklmnop/".to_string()];
        validate_origin("chrome-extension://abcdefghijklmnop/", &allowed).unwrap();
        assert_eq!(
            validate_origin("chrome-extension://other/", &allowed)
                .unwrap_err()
                .code,
            ErrorCode::UnauthorizedOrigin
        );
        assert!(validate_origin("chrome-extension://*/", &allowed).is_err());
    }

    #[test]
    fn host_applies_a_stricter_symmetric_message_limit() {
        validate_message_size(MAX_MESSAGE_BYTES).unwrap();
        assert_eq!(
            validate_message_size(MAX_MESSAGE_BYTES + 1)
                .unwrap_err()
                .code,
            ErrorCode::RequestTooLarge
        );
    }

    #[test]
    fn parser_rejects_unknown_fields_and_invalid_json_before_dispatch() {
        assert_eq!(
            parse_request(
                br#"{"protocol_version":1,"request_id":"ping-1","action":"ping","secret":"no"}"#
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidMessage
        );
        assert_eq!(
            parse_request(b"not-json").unwrap_err().code,
            ErrorCode::InvalidMessage
        );
    }

    #[test]
    fn error_responses_use_stable_machine_readable_codes() {
        let response = ResponseEnvelope {
            protocol_version: 1,
            request_id: "request-1".to_string(),
            response: Response::Error {
                error: ProtocolError::new(
                    ErrorCode::PairingRequired,
                    "Desktop approval is required",
                    false,
                ),
            },
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["status"], "error");
        assert_eq!(value["error"]["code"], "pairing_required");
    }

    #[test]
    fn published_schema_version_examples_and_error_codes_match_rust() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../protocol/native-messaging-v1.schema.json"
        ))
        .unwrap();
        assert_eq!(schema["$defs"]["version"]["const"], PROTOCOL_VERSION);

        for example in schema["examples"].as_array().unwrap() {
            serde_json::from_value::<RequestEnvelope>(example.clone())
                .unwrap()
                .validate()
                .unwrap();
        }

        let schema_codes = schema["$defs"]["errorCode"]["enum"].as_array().unwrap();
        for code in [
            ErrorCode::InvalidMessage,
            ErrorCode::UnsupportedVersion,
            ErrorCode::UnauthorizedOrigin,
            ErrorCode::PairingRequired,
            ErrorCode::PermissionDenied,
            ErrorCode::RequestTooLarge,
            ErrorCode::InvalidRequest,
            ErrorCode::Busy,
            ErrorCode::DesktopUnavailable,
            ErrorCode::Timeout,
            ErrorCode::Cancelled,
            ErrorCode::ProviderError,
            ErrorCode::InternalError,
        ] {
            let value = serde_json::to_value(code).unwrap();
            assert!(schema_codes.contains(&value), "schema is missing {value}");
        }
    }
}
