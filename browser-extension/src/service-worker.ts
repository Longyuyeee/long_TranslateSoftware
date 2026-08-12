import {
  requestNativePairing,
  runNativeSmoke,
  type ChromeEvent,
  type NativeRuntime,
} from "./native-client";

interface RuntimeMessageSender {
  id?: string;
}

export interface ExtensionRuntime extends NativeRuntime {
  onMessage: ChromeEvent<[
    unknown,
    RuntimeMessageSender,
    (response: unknown) => void,
  ]>;
}

declare const chrome: { runtime: ExtensionRuntime } | undefined;

export function installNativeBridgeListener(runtime: ExtensionRuntime): void {
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== runtime.id ||
      !isRecord(message) ||
      (message.type !== "native-smoke" && message.type !== "native-pair")
    ) {
      return;
    }

    const operation =
      message.type === "native-pair"
        ? requestNativePairing(runtime, "Long Translate browser extension")
        : runNativeSmoke(runtime);
    operation.then(
      (result) => sendResponse({ ok: true, result }),
      (error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Native Host operation failed",
        }),
    );
    return true;
  });
}

if (typeof chrome !== "undefined") {
  installNativeBridgeListener(chrome.runtime);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
