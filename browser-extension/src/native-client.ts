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

export interface NativePairingResult {
  desktopVersion: string;
  pairingState: NativeSmokeResult["pairingState"];
}

export interface NativeTranslationInput {
  text: string;
  targetLanguage: string;
  sourceLanguage?: string;
  format?: "plain_text" | "markdown";
  glossary?: Array<{ source: string; target: string }>;
}

export interface NativeTranslationResult {
  text: string;
  cached: boolean;
  detectedLanguage?: string;
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
      port.postMessage(
        createHelloRequest(runtime.getManifest().version, helloRequestId, nonce, ["ping"]),
      );
    } catch (error) {
      fail(error);
    }
  });
}

export function requestNativePairing(
  runtime: NativeRuntime,
  displayName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NativePairingResult> {
  const helloRequestId = createRequestId("hello");
  const pairRequestId = createRequestId("pair");
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
        // Chromium may already have closed the native port.
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finish = (result: NativePairingResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onMessage = (message: unknown) => {
      try {
        if (!hello) {
          hello = parseHello(parseNativeResponse(message, helloRequestId), nonce);
          port.postMessage(createPairRequest(pairRequestId, displayName));
          return;
        }
        const response = parseNativeResponse(message, pairRequestId);
        if (response.status !== "ok" || response.payload.type !== "pairing") {
          throw responseError(response, "Native Host rejected pairing");
        }
        const data = response.payload.data;
        if (!isRecord(data) || !isPairingState(data.pairing_state)) {
          throw new Error("Native Host returned invalid pairing data");
        }
        finish({
          desktopVersion: hello.desktop_version,
          pairingState: data.pairing_state,
        });
      } catch (error) {
        fail(error);
      }
    };
    const onDisconnect = () => {
      const message = runtime.lastError?.message?.trim();
      fail(new Error(message || "Native Host disconnected before pairing completed"));
    };
    const timer = setTimeout(
      () => fail(new Error(`Native Host did not respond within ${timeoutMs} ms`)),
      timeoutMs,
    );

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try {
      port.postMessage(
        createHelloRequest(runtime.getManifest().version, helloRequestId, nonce, [
          "ping",
          "translation",
          "wordbook",
        ]),
      );
    } catch (error) {
      fail(error);
    }
  });
}

export function runNativeTranslation(
  runtime: NativeRuntime,
  input: NativeTranslationInput,
  signal?: AbortSignal,
  timeoutMs = 65_000,
): Promise<NativeTranslationResult> {
  const helloRequestId = createRequestId("hello");
  const translateRequestId = createRequestId("translate");
  const cancelRequestId = createRequestId("cancel");
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
    let helloCompleted = false;
    let translateStarted = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try { port.disconnect(); } catch { /* Chromium may already have closed it. */ }
    };
    const finish = (result: NativeTranslationResult) => {
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
    const onAbort = () => {
      if (!translateStarted || settled) {
        fail(new DOMException("Translation cancelled", "AbortError"));
        return;
      }
      try {
        port.postMessage(createNativeRequest({
          protocol_version: NATIVE_PROTOCOL_VERSION,
          request_id: cancelRequestId,
          action: "cancel",
          payload: { target_request_id: translateRequestId },
        }));
      } catch (error) {
        fail(error);
      }
    };
    const onMessage = (message: unknown) => {
      try {
        if (!helloCompleted) {
          const hello = parseHello(parseNativeResponse(message, helloRequestId), nonce);
          if (hello.pairing_state !== "approved") {
            throw new Error("pairing_required: Desktop approval is required");
          }
          if (!hello.capabilities.includes("translation")) {
            throw new Error("Native Host does not support translation");
          }
          helloCompleted = true;
          translateStarted = true;
          port.postMessage(createNativeRequest({
            protocol_version: NATIVE_PROTOCOL_VERSION,
            request_id: translateRequestId,
            action: "translate",
            payload: {
              text: input.text,
              target_language: input.targetLanguage,
              source_language: input.sourceLanguage,
              format: input.format || "plain_text",
              glossary: input.glossary || [],
            },
          }));
          if (signal?.aborted) onAbort();
          return;
        }

        if (isRecord(message) && message.request_id === cancelRequestId) {
          const response = parseNativeResponse(message, cancelRequestId);
          if (response.status !== "ok" || response.payload.type !== "cancelled") {
            throw responseError(response, "Native Host could not cancel translation");
          }
          fail(new DOMException("Translation cancelled", "AbortError"));
          return;
        }

        const response = parseNativeResponse(message, translateRequestId);
        if (response.status !== "ok" || response.payload.type !== "translation") {
          throw responseError(response, "Native Host rejected translation");
        }
        const data = response.payload.data;
        if (
          !isRecord(data) ||
          typeof data.text !== "string" ||
          !data.text.trim() ||
          typeof data.cached !== "boolean" ||
          (data.detected_language !== undefined &&
            typeof data.detected_language !== "string")
        ) {
          throw new Error("Native Host returned invalid translation data");
        }
        finish({
          text: data.text,
          cached: data.cached,
          detectedLanguage: data.detected_language,
        });
      } catch (error) {
        fail(error);
      }
    };
    const onDisconnect = () => {
      fail(new Error(runtime.lastError?.message?.trim() || "Native Host disconnected"));
    };
    const timer = setTimeout(
      () => fail(new Error(`Native Host did not respond within ${timeoutMs} ms`)),
      timeoutMs,
    );

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      port.postMessage(createHelloRequest(
        runtime.getManifest().version,
        helloRequestId,
        nonce,
        ["ping", "translation"],
      ));
    } catch (error) {
      fail(error);
    }
  });
}

function createHelloRequest(
  extensionVersion: string,
  requestId: string,
  nonce: string,
  capabilities: string[],
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
      capabilities,
    },
  });
}

function createPairRequest(requestId: string, displayName: string): NativeRequest {
  return createNativeRequest({
    protocol_version: NATIVE_PROTOCOL_VERSION,
    request_id: requestId,
    action: "pair",
    payload: { display_name: displayName },
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
