import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  completeBrowserTranslation,
  setBrowserTranslationBridgeReady,
  type BrowserTranslationEvent,
  type BrowserTranslationOutcome,
} from "../services/browserTranslation";
import {
  startTranslationTask,
  type TranslationTask,
} from "../services/translationTask";

function failedOutcome(
  code: "timeout" | "cancelled" | "provider_error" | "internal_error",
  retryable: boolean,
): BrowserTranslationOutcome {
  const message = code === "cancelled"
    ? "Desktop translation was cancelled"
    : code === "timeout"
      ? "Desktop translation timed out"
      : code === "provider_error"
        ? "Translation provider request failed"
        : "Desktop translation failed";
  return { status: "error", error: { code, message, retryable } };
}

export function useBrowserTranslationBridge(): void {
  const tasks = useRef(new Map<string, TranslationTask>());
  const bridgeId = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    const requested = listen<BrowserTranslationEvent>(
      "browser-translation-requested",
      (event) => {
        const { task_id: taskId, request } = event.payload;
        if (!active || tasks.current.has(taskId)) return;
        const task = startTranslationTask(
          request.translation.text,
          {},
          {
            targetLang: request.translation.target_language,
            sourceLang: request.translation.source_language || "auto",
            glossary: request.translation.glossary.map((term) => ({
              source_term: term.source,
              target_term: term.target,
            })),
          },
        );
        tasks.current.set(taskId, task);
        void task.done.then(async (completion) => {
          tasks.current.delete(taskId);
          let outcome: BrowserTranslationOutcome;
          if (completion.status === "success") {
            outcome = {
              status: "success",
              response: {
                text: completion.result.text,
                cached: completion.result.cached,
              },
            };
          } else if (completion.status === "cancelled") {
            outcome = failedOutcome("cancelled", false);
          } else {
            outcome = failedOutcome(
              completion.error.code === "timeout" ? "timeout" : "provider_error",
              completion.error.code !== "format-invalid",
            );
          }
          try {
            await completeBrowserTranslation(taskId, outcome);
          } catch {
            // The Host may have disconnected or timed out; never surface its content in UI logs.
          }
        });
      },
    );
    const cancelled = listen<string>("browser-translation-cancelled", (event) => {
      tasks.current.get(event.payload)?.cancel();
    });
    let listenersDisposed = false;
    const listeners = Promise.allSettled([requested, cancelled]);
    const disposeListeners = (results: Awaited<typeof listeners>) => {
      if (listenersDisposed) return;
      listenersDisposed = true;
      for (const result of results) {
        if (result.status === "fulfilled") result.value();
      }
    };
    void listeners.then((results) => {
      if (!active || results.some((result) => result.status === "rejected")) {
        disposeListeners(results);
        return;
      }
      return setBrowserTranslationBridgeReady(bridgeId.current, true);
    }).catch(() => {
      // App shutdown can race listener setup; the Host will fail closed while not ready.
    });

    return () => {
      active = false;
      void setBrowserTranslationBridgeReady(bridgeId.current, false).catch(() => undefined);
      for (const task of tasks.current.values()) task.cancel();
      tasks.current.clear();
      void listeners.then(disposeListeners);
    };
  }, []);
}
