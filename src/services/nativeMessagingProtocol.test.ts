import { describe, expect, it } from "vitest";
import {
  createNativeRequest,
  NATIVE_MAX_TEXT_BYTES,
  NATIVE_MAX_WORD_BYTES,
  NATIVE_MAX_WORD_CONTEXT_BYTES,
  parseNativeResponse,
} from "./nativeMessagingProtocol";

describe("native messaging protocol", () => {
  it("builds a versioned hello request", () => {
    expect(
      createNativeRequest({
        protocol_version: 1,
        request_id: "hello-1",
        action: "hello",
        payload: {
          min_protocol: 1,
          max_protocol: 1,
          extension_version: "0.1.0",
          client_nonce: "nonce-1",
          capabilities: ["translation"],
        },
      }),
    ).toMatchObject({ protocol_version: 1, request_id: "hello-1" });
  });

  it("rejects invalid wordbook writes before opening the native channel", () => {
    expect(() =>
      createNativeRequest({
        protocol_version: 1,
        request_id: "word-1",
        action: "add_word",
        payload: {
          word: "x".repeat(NATIVE_MAX_WORD_BYTES + 1),
          translation: "译文",
        },
      }),
    ).toThrow("Word must be non-empty and at most 1 KiB");
    expect(() =>
      createNativeRequest({
        protocol_version: 1,
        request_id: "word-2",
        action: "add_word",
        payload: {
          word: "word",
          translation: "译文",
          context: "x".repeat(NATIVE_MAX_WORD_CONTEXT_BYTES + 1),
        },
      }),
    ).toThrow("Word context exceeds 16 KiB");
  });

  it("rejects unsafe IDs and oversized translation text", () => {
    expect(() =>
      createNativeRequest({
        protocol_version: 1,
        request_id: "../unsafe",
        action: "ping",
      }),
    ).toThrow("Invalid native messaging request ID");
    expect(() =>
      createNativeRequest({
        protocol_version: 1,
        request_id: "translate-1",
        action: "translate",
        payload: {
          text: "x".repeat(NATIVE_MAX_TEXT_BYTES + 1),
          target_language: "zh-Hans",
          format: "plain_text",
          glossary: [],
        },
      }),
    ).toThrow("Translation text exceeds 32 KiB");
  });

  it("accepts correlated success and stable error responses", () => {
    expect(
      parseNativeResponse(
        {
          protocol_version: 1,
          request_id: "request-1",
          status: "ok",
          payload: { type: "pong", data: { desktop_version: "0.4.9" } },
        },
        "request-1",
      ),
    ).toMatchObject({ status: "ok" });
    expect(
      parseNativeResponse(
        {
          protocol_version: 1,
          request_id: "request-2",
          status: "error",
          error: {
            code: "pairing_required",
            message: "Desktop approval is required",
            retryable: false,
          },
        },
        "request-2",
      ),
    ).toMatchObject({ status: "error" });
  });

  it("rejects mismatched IDs and unknown error codes", () => {
    expect(() =>
      parseNativeResponse(
        {
          protocol_version: 1,
          request_id: "other",
          status: "ok",
          payload: { type: "pong" },
        },
        "request-1",
      ),
    ).toThrow("does not match");
    expect(() =>
      parseNativeResponse(
        {
          protocol_version: 1,
          request_id: "request-1",
          status: "error",
          error: { code: "secret_leak", message: "bad", retryable: false },
        },
        "request-1",
      ),
    ).toThrow("Invalid native messaging error payload");
  });
});
