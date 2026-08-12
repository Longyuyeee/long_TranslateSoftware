import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_HOST_NAME,
  requestNativePairing,
  runNativeAddWord,
  runNativeTranslation,
  runNativeSmoke,
  type ChromeEvent,
  type NativePort,
  type NativeRuntime,
} from "./native-client";

class FakeEvent<T extends unknown[] = []> implements ChromeEvent<T> {
  private readonly listeners = new Set<(...args: T) => void>();

  addListener(listener: (...args: T) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (...args: T) => void): void {
    this.listeners.delete(listener);
  }

  emit(...args: T): void {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

class FakePort implements NativePort {
  readonly onMessage = new FakeEvent<[unknown]>();
  readonly onDisconnect = new FakeEvent();
  readonly posted: unknown[] = [];
  disconnectCalls = 0;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

function createRuntime(port: FakePort): NativeRuntime {
  return {
    id: "imaogjlfhfohdnngppnfhapdfkaldmkn",
    getManifest: () => ({ version: "0.1.0" }),
    connectNative: vi.fn((hostName: string) => {
      expect(hostName).toBe(NATIVE_HOST_NAME);
      return port;
    }),
  };
}

describe("browser Native Messaging smoke client", () => {
  it("keeps hello and ping on one port and validates their correlation", async () => {
    const port = new FakePort();
    const runtime = createRuntime(port);
    const times = [10, 37];
    const pending = runNativeSmoke(runtime, 1_000, () => times.shift() ?? 37);

    const hello = port.posted[0] as {
      request_id: string;
      payload: { client_nonce: string };
    };
    expect(hello).toMatchObject({
      protocol_version: 1,
      action: "hello",
      payload: { extension_version: "0.1.0", capabilities: ["ping"] },
    });

    port.onMessage.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      status: "ok",
      payload: {
        type: "hello",
        data: {
          selected_protocol: 1,
          desktop_version: "0.4.9",
          session_id: "session-test",
          client_nonce: hello.payload.client_nonce,
          pairing_state: "required",
          capabilities: ["ping"],
          limits: {},
        },
      },
    });

    const ping = port.posted[1] as { request_id: string };
    expect(ping).toMatchObject({ protocol_version: 1, action: "ping" });
    port.onMessage.emit({
      protocol_version: 1,
      request_id: ping.request_id,
      status: "ok",
      payload: {
        type: "pong",
        data: { desktop_version: "0.4.9" },
      },
    });

    await expect(pending).resolves.toEqual({
      desktopVersion: "0.4.9",
      pairingState: "required",
      latencyMs: 27,
    });
    expect(port.disconnectCalls).toBe(1);
  });

  it("fails closed when a response does not match its request", async () => {
    const port = new FakePort();
    const pending = runNativeSmoke(createRuntime(port), 1_000);
    port.onMessage.emit({
      protocol_version: 1,
      request_id: "other-request",
      status: "ok",
      payload: { type: "hello", data: {} },
    });
    await expect(pending).rejects.toThrow("does not match the request");
    expect(port.disconnectCalls).toBe(1);
  });

  it("surfaces Chrome's disconnect reason without hanging", async () => {
    const port = new FakePort();
    const runtime = createRuntime(port);
    runtime.lastError = {
      message: "Specified native messaging host not found.",
    };
    const pending = runNativeSmoke(runtime, 1_000);
    port.onDisconnect.emit();
    await expect(pending).rejects.toThrow("host not found");
    expect(port.disconnectCalls).toBe(1);
  });

  it("turns a synchronous connection failure into a rejected check", async () => {
    const runtime = createRuntime(new FakePort());
    runtime.connectNative = () => {
      throw new Error("Native Messaging permission is unavailable");
    };
    await expect(runNativeSmoke(runtime)).rejects.toThrow(
      "Native Messaging permission is unavailable",
    );
  });

  it("keeps hello and pairing on one authenticated native port", async () => {
    const port = new FakePort();
    const pending = requestNativePairing(
      createRuntime(port),
      "Long Translate browser extension",
      1_000,
    );
    const hello = port.posted[0] as {
      request_id: string;
      payload: { client_nonce: string; capabilities: string[] };
    };
    expect(hello.payload.capabilities).toEqual([
      "ping",
      "translation",
      "wordbook",
    ]);
    port.onMessage.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      status: "ok",
      payload: {
        type: "hello",
        data: {
          selected_protocol: 1,
          desktop_version: "0.4.9",
          session_id: "session-pair",
          client_nonce: hello.payload.client_nonce,
          pairing_state: "required",
          capabilities: ["ping"],
          limits: {},
        },
      },
    });
    const pair = port.posted[1] as { request_id: string };
    expect(pair).toMatchObject({
      protocol_version: 1,
      action: "pair",
      payload: { display_name: "Long Translate browser extension" },
    });
    port.onMessage.emit({
      protocol_version: 1,
      request_id: pair.request_id,
      status: "ok",
      payload: { type: "pairing", data: { pairing_state: "pending" } },
    });

    await expect(pending).resolves.toEqual({
      desktopVersion: "0.4.9",
      pairingState: "pending",
    });
    expect(port.disconnectCalls).toBe(1);
  });

  it("translates through the approved desktop session", async () => {
    const port = new FakePort();
    const pending = runNativeTranslation(
      createRuntime(port),
      {
        text: "hello",
        targetLanguage: "zh-Hans",
        sourceLanguage: "en",
      },
      undefined,
      1_000,
    );
    const hello = port.posted[0] as {
      request_id: string;
      payload: { client_nonce: string };
    };
    port.onMessage.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      status: "ok",
      payload: {
        type: "hello",
        data: {
          selected_protocol: 1,
          desktop_version: "0.4.9",
          session_id: "session-translate",
          client_nonce: hello.payload.client_nonce,
          pairing_state: "approved",
          capabilities: ["ping", "translation"],
          limits: {},
        },
      },
    });
    const translate = port.posted[1] as { request_id: string };
    expect(translate).toMatchObject({
      action: "translate",
      payload: {
        text: "hello",
        target_language: "zh-Hans",
        source_language: "en",
      },
    });
    port.onMessage.emit({
      protocol_version: 1,
      request_id: translate.request_id,
      status: "ok",
      payload: { type: "translation", data: { text: "你好", cached: false } },
    });
    await expect(pending).resolves.toEqual({
      text: "你好",
      cached: false,
      detectedLanguage: undefined,
    });
  });

  it("sends a correlated cancel request when aborted", async () => {
    const port = new FakePort();
    const controller = new AbortController();
    const pending = runNativeTranslation(
      createRuntime(port),
      { text: "hello", targetLanguage: "zh-Hans" },
      controller.signal,
      1_000,
    );
    const hello = port.posted[0] as {
      request_id: string;
      payload: { client_nonce: string };
    };
    port.onMessage.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      status: "ok",
      payload: {
        type: "hello",
        data: {
          selected_protocol: 1,
          desktop_version: "0.4.9",
          session_id: "session-cancel",
          client_nonce: hello.payload.client_nonce,
          pairing_state: "approved",
          capabilities: ["ping", "translation"],
          limits: {},
        },
      },
    });
    const translate = port.posted[1] as { request_id: string };
    controller.abort();
    const cancel = port.posted[2] as { request_id: string };
    expect(cancel).toMatchObject({
      action: "cancel",
      payload: { target_request_id: translate.request_id },
    });
    port.onMessage.emit({
      protocol_version: 1,
      request_id: cancel.request_id,
      status: "ok",
      payload: { type: "cancelled", data: { accepted: true } },
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requires wordbook approval and returns the persisted word ID", async () => {
    const port = new FakePort();
    const pending = runNativeAddWord(
      createRuntime(port),
      {
        word: "hello",
        translation: "你好",
      },
      1_000,
    );
    const hello = port.posted[0] as {
      request_id: string;
      payload: { client_nonce: string };
    };
    expect(hello).toMatchObject({
      payload: { capabilities: ["ping", "wordbook"] },
    });
    port.onMessage.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      status: "ok",
      payload: {
        type: "hello",
        data: {
          selected_protocol: 1,
          desktop_version: "0.4.9",
          session_id: "session-wordbook",
          client_nonce: hello.payload.client_nonce,
          pairing_state: "approved",
          capabilities: ["ping", "wordbook"],
          limits: {},
        },
      },
    });
    const addWord = port.posted[1] as { request_id: string };
    expect(addWord).toMatchObject({
      action: "add_word",
      payload: { word: "hello", translation: "你好" },
    });
    port.onMessage.emit({
      protocol_version: 1,
      request_id: addWord.request_id,
      status: "ok",
      payload: { type: "word_added", data: { word_id: "word-123" } },
    });
    await expect(pending).resolves.toEqual({ wordId: "word-123" });
  });
});
