export const NATIVE_PROTOCOL_VERSION = 1 as const;
export const NATIVE_MAX_MESSAGE_BYTES = 1024 * 1024;
export const NATIVE_MAX_TEXT_BYTES = 32 * 1024;
export const NATIVE_MAX_GLOSSARY_ENTRIES = 100;
export const NATIVE_MAX_IN_FLIGHT_REQUESTS = 4;

export type NativeRequestId = string;
export type NativeTextFormat = "plain_text" | "markdown";

export type NativeRequest =
  | {
      protocol_version: 1;
      request_id: NativeRequestId;
      action: "hello";
      payload: {
        min_protocol: number;
        max_protocol: number;
        extension_version: string;
        client_nonce: string;
        capabilities: string[];
      };
    }
  | {
      protocol_version: 1;
      request_id: NativeRequestId;
      action: "pair";
      payload: { display_name: string };
    }
  | {
      protocol_version: 1;
      request_id: NativeRequestId;
      action: "translate";
      payload: {
        text: string;
        target_language: string;
        source_language?: string;
        format: NativeTextFormat;
        glossary: Array<{ source: string; target: string }>;
      };
    }
  | {
      protocol_version: 1;
      request_id: NativeRequestId;
      action: "add_word";
      payload: { word: string; translation: string; context?: string };
    }
  | {
      protocol_version: 1;
      request_id: NativeRequestId;
      action: "cancel";
      payload: { target_request_id: string };
    }
  | {
      protocol_version: 1;
      request_id: NativeRequestId;
      action: "ping";
    };

export const NATIVE_ERROR_CODES = [
  "invalid_message",
  "unsupported_version",
  "unauthorized_origin",
  "pairing_required",
  "permission_denied",
  "request_too_large",
  "invalid_request",
  "busy",
  "desktop_unavailable",
  "timeout",
  "cancelled",
  "provider_error",
  "internal_error",
] as const;

export type NativeErrorCode = (typeof NATIVE_ERROR_CODES)[number];

export type NativeResponse =
  | {
      protocol_version: 1;
      request_id: string;
      status: "ok";
      payload: {
        type:
          | "hello"
          | "pairing"
          | "translation"
          | "word_added"
          | "cancelled"
          | "pong";
        data?: unknown;
      };
    }
  | {
      protocol_version: 1;
      request_id: string;
      status: "error";
      error: {
        code: NativeErrorCode;
        message: string;
        retryable: boolean;
      };
    };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const RESPONSE_TYPES = [
  "hello",
  "pairing",
  "translation",
  "word_added",
  "cancelled",
  "pong",
] as const;
const textEncoder = new TextEncoder();

export function createNativeRequest(
  request: NativeRequest,
): NativeRequest {
  if (request.protocol_version !== NATIVE_PROTOCOL_VERSION) {
    throw new Error("Unsupported native messaging protocol version");
  }
  if (!REQUEST_ID_PATTERN.test(request.request_id)) {
    throw new Error("Invalid native messaging request ID");
  }
  const size = textEncoder.encode(JSON.stringify(request)).byteLength;
  if (size > NATIVE_MAX_MESSAGE_BYTES) {
    throw new Error("Native messaging request exceeds 1 MiB");
  }
  if (
    request.action === "translate" &&
    textEncoder.encode(request.payload.text).byteLength > NATIVE_MAX_TEXT_BYTES
  ) {
    throw new Error("Translation text exceeds 32 KiB");
  }
  if (
    request.action === "translate" &&
    request.payload.glossary.length > NATIVE_MAX_GLOSSARY_ENTRIES
  ) {
    throw new Error("Too many native messaging glossary entries");
  }
  return request;
}

export function parseNativeResponse(
  value: unknown,
  expectedRequestId: string,
): NativeResponse {
  if (!isRecord(value)) throw new Error("Invalid native messaging response");
  if (
    value.protocol_version !== NATIVE_PROTOCOL_VERSION ||
    value.request_id !== expectedRequestId
  ) {
    throw new Error("Native messaging response does not match the request");
  }

  if (value.status === "ok") {
    if (
      !isRecord(value.payload) ||
      !RESPONSE_TYPES.includes(
        value.payload.type as (typeof RESPONSE_TYPES)[number],
      )
    ) {
      throw new Error("Invalid native messaging success payload");
    }
    return value as NativeResponse;
  }
  if (value.status === "error") {
    const error = value.error;
    if (
      !isRecord(error) ||
      !NATIVE_ERROR_CODES.includes(error.code as NativeErrorCode) ||
      typeof error.message !== "string" ||
      typeof error.retryable !== "boolean"
    ) {
      throw new Error("Invalid native messaging error payload");
    }
    return value as NativeResponse;
  }
  throw new Error("Invalid native messaging response status");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
