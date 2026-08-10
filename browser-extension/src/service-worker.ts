import {
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

export function installNativeSmokeListener(runtime: ExtensionRuntime): void {
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== runtime.id ||
      !isRecord(message) ||
      message.type !== "native-smoke"
    ) {
      return;
    }

    runNativeSmoke(runtime).then(
      (result) => sendResponse({ ok: true, result }),
      (error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Native Host check failed",
        }),
    );
    return true;
  });
}

if (typeof chrome !== "undefined") {
  installNativeSmokeListener(chrome.runtime);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
