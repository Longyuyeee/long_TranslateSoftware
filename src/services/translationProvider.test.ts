import { describe, expect, it } from "vitest";
import {
  chatCompletionsEndpoint,
  identifyTranslationProvider,
  normalizeTranslationError,
  resolveTranslationProvider,
  TRANSLATION_PROVIDERS,
  TranslationRequestError,
  translationHttpError,
} from "./translationProvider";

describe("translation provider strategy", () => {
  it("describes every supported provider through the same OpenAI-compatible capability contract", () => {
    expect(TRANSLATION_PROVIDERS.map((provider) => provider.id)).toEqual([
      "deepseek",
      "openai",
      "custom",
    ]);
    for (const provider of TRANSLATION_PROVIDERS) {
      expect(provider.capabilities).toEqual({
        protocol: "openai-chat-completions",
        streaming: true,
        requestTimeoutMs: 60_000,
        connectionTimeoutMs: 15_000,
      });
    }
  });

  it("normalizes endpoints and falls back to the custom compatibility strategy", () => {
    expect(identifyTranslationProvider(" https://api.openai.com/v1/// ")).toBe("openai");
    expect(identifyTranslationProvider("https://gateway.example/v1")).toBe("custom");
    expect(resolveTranslationProvider("https://gateway.example/v1").id).toBe("custom");
    expect(chatCompletionsEndpoint(" https://gateway.example/v1/// ")).toBe(
      "https://gateway.example/v1/chat/completions",
    );
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "model-not-found"],
    [429, "rate-limited"],
    [500, "server"],
    [503, "server"],
    [400, "unknown"],
  ] as const)("maps HTTP %i to %s", (status, code) => {
    expect(translationHttpError(status)).toEqual({
      code,
      message: `Translation service returned HTTP ${status}`,
    });
  });

  it("normalizes typed, timeout, network, and unknown failures consistently", () => {
    expect(normalizeTranslationError(
      new TranslationRequestError("format-invalid", "Invalid structure"),
    )).toEqual({ code: "format-invalid", message: "Invalid structure" });
    expect(normalizeTranslationError(
      new DOMException("timed out", "TimeoutError"),
    )).toEqual({ code: "timeout", message: "Translation request timed out" });
    expect(normalizeTranslationError(new TypeError("fetch failed"))).toEqual({
      code: "network",
      message: "Unable to reach the translation service",
    });
    expect(normalizeTranslationError("unexpected")).toEqual({
      code: "unknown",
      message: "Unknown translation error",
    });
  });
});
