import {
  requestNativePairing,
  runNativeAddWord,
  runNativeTranslation,
  runNativeSmoke,
  type ChromeEvent,
  type NativeRuntime,
} from "./native-client";

interface RuntimeMessageSender {
  id?: string;
  tab?: { id?: number };
  frameId?: number;
}

interface ActiveTranslation {
  controller: AbortController;
  senderKey: string;
}

export interface ExtensionRuntime extends NativeRuntime {
  onMessage: ChromeEvent<
    [unknown, RuntimeMessageSender, (response: unknown) => void]
  >;
}

declare const chrome: { runtime: ExtensionRuntime } | undefined;

export function installNativeBridgeListener(runtime: ExtensionRuntime): void {
  const translations = new Map<string, ActiveTranslation>();
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== runtime.id ||
      !isRecord(message) ||
      (message.type !== "native-smoke" &&
        message.type !== "native-pair" &&
        message.type !== "native-translate" &&
        message.type !== "native-cancel" &&
        message.type !== "native-add-word")
    ) {
      return;
    }

    if (message.type === "native-cancel") {
      const taskId = validTaskId(message.taskId);
      const translation = taskId ? translations.get(taskId) : undefined;
      if (!translation || translation.senderKey !== contentSenderKey(sender)) {
        sendResponse({
          ok: false,
          error: "Browser translation task was not found",
        });
      } else {
        translation.controller.abort();
        sendResponse({ ok: true, result: { cancelled: true } });
      }
      return;
    }

    const taskId =
      message.type === "native-translate"
        ? validTaskId(message.taskId)
        : undefined;
    const senderKey =
      message.type === "native-translate"
        ? contentSenderKey(sender)
        : undefined;
    const controller = taskId && senderKey ? new AbortController() : undefined;
    if (taskId && translations.has(taskId)) {
      sendResponse({
        ok: false,
        error: "Browser translation task is already active",
      });
      return;
    }
    if (controller && taskId && senderKey)
      translations.set(taskId, { controller, senderKey });

    const operation =
      message.type === "native-pair"
        ? requestNativePairing(runtime, "Long Translate browser extension")
        : message.type === "native-add-word" &&
            contentSenderKey(sender) &&
            isAddWordInput(message.input)
          ? runNativeAddWord(runtime, message.input)
          : message.type === "native-translate" &&
              taskId &&
              senderKey &&
              isTranslationInput(message.input)
            ? runNativeTranslation(runtime, message.input, controller?.signal)
            : message.type === "native-smoke"
              ? runNativeSmoke(runtime)
              : Promise.reject(
                  new Error("Invalid browser translation request"),
                );
    operation
      .finally(() => {
        if (taskId) translations.delete(taskId);
      })
      .then(
        (result) => sendResponse({ ok: true, result }),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Native Host operation failed",
          }),
      );
    return true;
  });
}

function isAddWordInput(value: unknown): value is {
  word: string;
  translation: string;
  context?: string;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value.word === "string" &&
    value.word.trim().length > 0 &&
    typeof value.translation === "string" &&
    value.translation.trim().length > 0 &&
    (value.context === undefined || typeof value.context === "string")
  );
}

function contentSenderKey(sender: RuntimeMessageSender): string | undefined {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  return typeof tabId === "number" && frameId === 0 ? `${tabId}:0` : undefined;
}

if (typeof chrome !== "undefined") {
  installNativeBridgeListener(chrome.runtime);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTaskId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)
    ? value
    : undefined;
}

function isTranslationInput(value: unknown): value is {
  text: string;
  targetLanguage: string;
  sourceLanguage?: string;
  format?: "plain_text" | "markdown";
  glossary?: Array<{ source: string; target: string }>;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    typeof value.targetLanguage === "string" &&
    value.targetLanguage.length > 0 &&
    (value.sourceLanguage === undefined ||
      typeof value.sourceLanguage === "string") &&
    (value.format === undefined ||
      value.format === "plain_text" ||
      value.format === "markdown") &&
    (value.glossary === undefined ||
      (Array.isArray(value.glossary) &&
        value.glossary.every(
          (term) =>
            isRecord(term) &&
            typeof term.source === "string" &&
            typeof term.target === "string",
        )))
  );
}
