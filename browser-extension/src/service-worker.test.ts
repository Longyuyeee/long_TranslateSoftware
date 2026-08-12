import { describe, expect, it, vi } from "vitest";
import { type ChromeEvent, type NativePort } from "./native-client";
import {
  installNativeBridgeListener,
  type ExtensionRuntime,
} from "./service-worker";

class CapturingEvent<T extends unknown[]> implements ChromeEvent<T> {
  listener?: (...args: T) => void;

  addListener(listener: (...args: T) => void): void {
    this.listener = listener;
  }

  removeListener(listener: (...args: T) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  emit(...args: T): void {
    this.listener?.(...args);
  }
}

class FakePort implements NativePort {
  readonly onMessage = new CapturingEvent<[unknown]>();
  readonly onDisconnect = new CapturingEvent();
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {}
}

describe("browser service worker boundary", () => {
  it("ignores messages that do not come from this extension", () => {
    const onMessage = new CapturingEvent<[
      unknown,
      { id?: string },
      (response: unknown) => void,
    ]>();
    const connectNative = vi.fn<() => NativePort>();
    const runtime: ExtensionRuntime = {
      id: "imaogjlfhfohdnngppnfhapdfkaldmkn",
      getManifest: () => ({ version: "0.1.0" }),
      connectNative,
      onMessage,
    };
    installNativeBridgeListener(runtime);

    onMessage.listener?.(
      { type: "native-smoke" },
      { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      vi.fn(),
    );

    expect(connectNative).not.toHaveBeenCalled();
  });

  it("routes an internal pairing request through hello before pair", async () => {
    const onMessage = new CapturingEvent<[
      unknown,
      { id?: string },
      (response: unknown) => void,
    ]>();
    const port = new FakePort();
    const runtime: ExtensionRuntime = {
      id: "imaogjlfhfohdnngppnfhapdfkaldmkn",
      getManifest: () => ({ version: "0.1.0" }),
      connectNative: () => port,
      onMessage,
    };
    const sendResponse = vi.fn();
    installNativeBridgeListener(runtime);

    expect(
      onMessage.listener?.(
        { type: "native-pair" },
        { id: runtime.id },
        sendResponse,
      ),
    ).toBe(true);
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
          session_id: "session-pair",
          client_nonce: hello.payload.client_nonce,
          pairing_state: "required",
          capabilities: ["ping"],
          limits: {},
        },
      },
    });
    const pair = port.posted[1] as { request_id: string };
    expect(pair).toMatchObject({ action: "pair" });
    port.onMessage.emit({
      protocol_version: 1,
      request_id: pair.request_id,
      status: "ok",
      payload: { type: "pairing", data: { pairing_state: "pending" } },
    });
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        result: { desktopVersion: "0.4.9", pairingState: "pending" },
      }),
    );
  });

  it("cancels an active internal translation by task ID", async () => {
    const onMessage = new CapturingEvent<[
      unknown, { id?: string }, (response: unknown) => void,
    ]>();
    const port = new FakePort();
    const runtime: ExtensionRuntime = {
      id: "imaogjlfhfohdnngppnfhapdfkaldmkn",
      getManifest: () => ({ version: "0.1.0" }),
      connectNative: () => port,
      onMessage,
    };
    const translationResponse = vi.fn();
    const cancelResponse = vi.fn();
    installNativeBridgeListener(runtime);

    expect(onMessage.listener?.(
      { type: "native-translate", taskId: "selection-1", input: {
        text: "hello", targetLanguage: "zh-Hans",
      } },
      { id: runtime.id },
      translationResponse,
    )).toBe(true);
    const hello = port.posted[0] as { request_id: string; payload: { client_nonce: string } };
    port.onMessage.emit({
      protocol_version: 1, request_id: hello.request_id, status: "ok",
      payload: { type: "hello", data: {
        selected_protocol: 1, desktop_version: "0.4.9", session_id: "session-translate",
        client_nonce: hello.payload.client_nonce, pairing_state: "approved",
        capabilities: ["ping", "translation"], limits: {},
      } },
    });
    const translate = port.posted[1] as { request_id: string };
    onMessage.listener?.(
      { type: "native-cancel", taskId: "selection-1" },
      { id: runtime.id },
      cancelResponse,
    );
    expect(cancelResponse).toHaveBeenCalledWith({ ok: true, result: { cancelled: true } });
    expect(port.posted[2]).toMatchObject({
      action: "cancel", payload: { target_request_id: translate.request_id },
    });
    const cancel = port.posted[2] as { request_id: string };
    port.onMessage.emit({
      protocol_version: 1, request_id: cancel.request_id, status: "ok",
      payload: { type: "cancelled", data: { accepted: true } },
    });
    await vi.waitFor(() => expect(translationResponse).toHaveBeenCalledWith({
      ok: false, error: "Translation cancelled",
    }));
  });
});
