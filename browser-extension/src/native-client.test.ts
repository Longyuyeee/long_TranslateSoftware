import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_HOST_NAME,
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
    runtime.lastError = { message: "Specified native messaging host not found." };
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
});
