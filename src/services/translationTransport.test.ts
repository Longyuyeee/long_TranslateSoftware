import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithTimeout,
  streamChatCompletion,
  testTranslationConnection,
} from "./translationTransport";

const encoder = new TextEncoder();

describe("translation transport", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends an OpenAI-compatible request and streams parsed content", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"Hel',
        ));
        controller.enqueue(encoder.encode(
          'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n',
        ));
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 200 }));
    const chunks: string[] = [];

    await streamChatCompletion({
      apiKey: "secret",
      baseUrl: "https://api.example.com/v1/",
      model: "example-model",
      messages: [{ role: "user", content: "Hello" }],
      onChunk: chunk => chunks.push(chunk),
    });

    expect(chunks).toEqual(["Hello", "!"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret",
        },
      }),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "example-model",
      stream: true,
    });
  });

  it("maps HTTP failures to stable translation errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );

    const request = streamChatCompletion({
      apiKey: "secret",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Hello" }],
      onChunk: vi.fn(),
    });

    await expect(request).rejects.toMatchObject({
      code: "rate-limited",
    });
  });

  it("forwards external cancellation to the network request", async () => {
    const captured: { signal?: AbortSignal } = {};
    vi.mocked(fetch).mockImplementation((_url, options) => {
      captured.signal = options?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        captured.signal?.addEventListener(
          "abort",
          () => reject(captured.signal?.reason),
          { once: true },
        );
      });
    });
    const external = new AbortController();
    const pending = fetchWithTimeout(
      "https://api.example.com",
      {},
      60_000,
      external.signal,
    );

    external.abort(new DOMException("Cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(captured.signal?.aborted).toBe(true);
  });

  it("validates connection settings without touching the network", async () => {
    await expect(testTranslationConnection({
      apiKey: " ",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "missing-api-key" },
    });
    await expect(testTranslationConnection({
      apiKey: "secret",
      baseUrl: "",
      model: "",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown" },
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies a connection timeout through the shared transport", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_url, options) => {
      const signal = options?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const pending = testTranslationConnection({
      apiKey: "secret",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });
});
