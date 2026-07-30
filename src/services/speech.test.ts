/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { speak } from "./speech";

const source = {
  buffer: null as AudioBuffer | null,
  connect: vi.fn(),
  onended: null as (() => void) | null,
  start: vi.fn(),
  stop: vi.fn(),
};
const audioContext = {
  createBufferSource: vi.fn(() => source),
  decodeAudioData: vi.fn(async () => ({}) as AudioBuffer),
  destination: {},
};
const AudioContextMock = vi.fn(() => audioContext);
const mp3Buffer = [0x49, 0x44, 0x33, 0x03];
let consoleErrorMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
  invokeMock.mockReset();
  source.connect.mockReset();
  source.start.mockReset();
  source.stop.mockReset();
  source.onended = null;
  audioContext.createBufferSource.mockClear();
  audioContext.decodeAudioData.mockClear();
  AudioContextMock.mockClear();
  source.start.mockImplementation(() => {
    queueMicrotask(() => source.onended?.());
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: AudioContextMock,
  });
});

afterEach(() => {
  consoleErrorMock.mockRestore();
});

function useConfig(values: Record<string, string>) {
  invokeMock.mockImplementation(
    (command: string, args?: { key?: string }) => {
      if (command === "get_config_value") {
        return Promise.resolve(values[args?.key || ""] || "");
      }
      if (command === "check_audio_cache") return Promise.resolve(false);
      if (command === "proxy_fetch_audio") return Promise.resolve(mp3Buffer);
      return Promise.resolve(undefined);
    },
  );
}

describe("speak", () => {
  it("ignores empty text without reading configuration", async () => {
    await expect(speak("   ")).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes local speech through the existing cache proxy", async () => {
    useConfig({ tts_engine: "local", tts_speed: "1.0" });

    await expect(speak("hello world")).resolves.toBe(true);

    const url =
      "https://dict.youdao.com/dictvoice?audio=hello%20world&type=2";
    expect(invokeMock).toHaveBeenCalledWith(
      "check_audio_cache",
      { cacheKey: url },
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "proxy_fetch_audio",
      { url, cacheKey: url },
    );
    expect(audioContext.decodeAudioData).toHaveBeenCalledOnce();
  });

  it("keeps Edge locale fallback and speed clamping in the service boundary", async () => {
    useConfig({
      tts_engine: "edge",
      tts_speed: "9",
      tts_voice: "zh-CN-XiaoxiaoNeural",
    });

    await expect(speak("Hello")).resolves.toBe(true);

    const cacheKey = "edge_v2_en-US_en-US-AriaNeural_2_Hello";
    expect(invokeMock).toHaveBeenCalledWith(
      "proxy_fetch_audio",
      {
        url: "Hello",
        cacheKey,
        engine: "edge",
        voice: "en-US-AriaNeural",
        speed: "2",
      },
    );
  });

  it("keeps online provider requests and binary caching aligned", async () => {
    useConfig({
      tts_engine: "online",
      tts_speed: "1.25",
      tts_voice: "nova",
      tts_model_name: "tts-1",
      tts_api_key: "speech-key",
      tts_base_url: "https://voice.example/v1/",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(mp3Buffer), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(speak("Hello")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://voice.example/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Authorization": "Bearer speech-key",
        }),
        body: JSON.stringify({
          model: "tts-1",
          input: "Hello",
          voice: "nova",
          speed: 1.25,
        }),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "save_audio_cache",
      {
        cacheKey: "online_v2_tts-1_nova_1.25_Hello",
        audioData: mp3Buffer,
      },
    );
  });

  it("reports text responses before attempting audio decoding", async () => {
    useConfig({ tts_engine: "local" });
    invokeMock.mockImplementation(
      (command: string, args?: { key?: string }) => {
        if (command === "get_config_value") {
          return Promise.resolve(
            args?.key === "tts_engine" ? "local" : "",
          );
        }
        if (command === "check_audio_cache") return Promise.resolve(false);
        if (command === "proxy_fetch_audio") {
          return Promise.resolve(Array.from(new TextEncoder().encode("{}")));
        }
        return Promise.resolve(undefined);
      },
    );
    const onError = vi.fn();
    window.addEventListener("tts-error", onError, { once: true });

    await expect(speak("hello")).resolves.toBe(false);

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as CustomEvent).detail).toBe(
      "The speech service returned text instead of audio",
    );
    expect(audioContext.decodeAudioData).not.toHaveBeenCalled();
  });
});
