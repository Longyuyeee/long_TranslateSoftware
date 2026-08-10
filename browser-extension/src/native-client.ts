import {
  NATIVE_PROTOCOL_VERSION,
  createNativeRequest,
  parseNativeResponse,
  type NativeRequest,
  type NativeResponse,
} from "../../src/services/nativeMessagingProtocol";

export const NATIVE_HOST_NAME = "com.long.translate";
const DEFAULT_TIMEOUT_MS = 5_000;

type Listener<T extends unknown[] = []> = (...args: T) => void;

export interface ChromeEvent<T extends unknown[] = []> {
  addListener(listener: Listener<T>): void;
  removeListener(listener: Listener<T>): void;
}

export interface NativePort {
  onMessage: ChromeEvent<[unknown]>;
  onDisconnect: ChromeEvent;
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface NativeRuntime {
  id: string;
  lastError?: { message?: string };
  getManifest(): { version: string };
  connectNative(hostName: string): NativePort;
}

export interface NativeSmokeResult {
  desktopVersion: string;
  pairingState: "required" | "pending" | "approved";
  latencyMs: number;
}

interface HelloData {
  selected_protocol: number;
  desktop_version: string;
  session_id: string;
  client_nonce: string;
  pairing_state: NativeSmokeResult["pairingState"];
  capabilities: string[];
}

interface PongData {
  desktop_version: string;
}

export function runNativeSmoke(
  runtime: NativeRuntime,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now: () => number = () => performance.now(),
): Promise<NativeSmokeResult> {
  const startedAt = now();
  const helloRequestId = createRequestId("hello");
  const pingRequestId = createRequestId("ping");
  const nonce = createRequestId("nonce");

  return new Promise((resolve, reject) => {
    let port: NativePort;
    try {
      port = runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    let hello: HelloData | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try {
        port.disconnect();
      } catch {
        // Chrome can already have closed the port after an error.
      }
    };

    const finish = (result: NativeSmokeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onMessage = (message: unknown) => {
      try {
        if (!hello) {
          const response = parseNativeResponse(message, helloRequestId);
          hello = parseHello(response, nonce);
          port.postMessage(createPingRequest(pingRequestId));
          return;
        }

        const response = parseNativeResponse(message, pingRequestId);
        const pong = parsePong(response);
        if (pong.desktop_version !== hello.desktop_version) {
          throw new Error("Native Host version changed during the smoke session");
        }
        finish({
          desktopVersion: hello.desktop_version,
          pairingState: hello.pairing_state,
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
        });
      } catch (error) {
        fail(error);
      }
    };

    const onDisconnect = () => {
      const message = runtime.lastError?.message?.trim();
      fail(new Error(message || "Native Host disconnected before the smoke check completed"));
    };

    const timer = setTimeout(
      () => fail(new Error(`Native Host did not respond within ${timeoutMs} ms`)),
      timeoutMs,
    );

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);

    try {
      port.postMessage(createHelloRequest(runtime.getManifest().version, helloRequestId, nonce));
    } catch (error) {
      fail(error);
    }
  });
}

function createHelloRequest(
  extensionVersion: string,
  requestId: string,
  nonce: string,
): NativeRequest {
  return createNativeRequest({
    protocol_version: NATIVE_PROTOCOL_VERSION,
    request_id: requestId,
    action: "hello",
    payload: {
      min_protocol: NATIVE_PROTOCOL_VERSION,
      max_protocol: NATIVE_PROTOCOL_VERSION,
      extension_version: extensionVersion,
      client_nonce: nonce,
      capabilities: ["ping"],
    },
  });
}

function createPingRequest(requestId: string): NativeRequest {
  return createNativeRequest({
    protocol_version: NATIVE_PROTOCOL_VERSION,
    request_id: requestId,
    action: "ping",
  });
}

function parseHello(response: NativeResponse, nonce: string): HelloData {
  if (response.status !== "ok" || response.payload.type !== "hello") {
    throw responseError(response, "Native Host rejected hello");
  }
  const data = response.payload.data;
  if (!isRecord(data)) throw new Error("Native Host returned invalid hello data");
  const pairingState = data.pairing_state;
  if (
    data.selected_protocol !== NATIVE_PROTOCOL_VERSION ||
    typeof data.desktop_version !== "string" ||
    data.desktop_version.length === 0 ||
    typeof data.session_id !== "string" ||
    data.session_id.length === 0 ||
    data.client_nonce !== nonce ||
    !isPairingState(pairingState) ||
    !Array.isArray(data.capabilities) ||
    !data.capabilities.every((value) => typeof value === "string") ||
    !data.capabilities.includes("ping")
  ) {
    throw new Error("Native Host returned invalid hello data");
  }
  return {
    selected_protocol: data.selected_protocol,
    desktop_version: data.desktop_version,
    session_id: data.session_id,
    client_nonce: data.client_nonce,
    pairing_state: pairingState,
    capabilities: data.capabilities,
  };
}

function parsePong(response: NativeResponse): PongData {
  if (response.status !== "ok" || response.payload.type !== "pong") {
    throw responseError(response, "Native Host rejected ping");
  }
  const data = response.payload.data;
  if (!isRecord(data) || typeof data.desktop_version !== "string") {
    throw new Error("Native Host returned invalid pong data");
  }
  return { desktop_version: data.desktop_version };
}

function responseError(response: NativeResponse, fallback: string): Error {
  return new Error(response.status === "error" ? `${response.error.code}: ${response.error.message}` : fallback);
}

function createRequestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isPairingState(value: unknown): value is NativeSmokeResult["pairingState"] {
  return value === "required" || value === "pending" || value === "approved";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
