import { invoke } from "@tauri-apps/api/core";
import type { NativeTextFormat } from "./nativeMessagingProtocol";

export interface BrowserTranslationRequest {
  origin: string;
  request_id: string;
  translation: {
    text: string;
    target_language: string;
    source_language?: string;
    format: NativeTextFormat;
    glossary: Array<{ source: string; target: string }>;
  };
}

export interface BrowserTranslationEvent {
  task_id: string;
  request: BrowserTranslationRequest;
}

export type BrowserTranslationOutcome =
  | {
      status: "success";
      response: { text: string; cached: boolean; detected_language?: string };
    }
  | {
      status: "error";
      error: {
        code:
          | "pairing_required"
          | "busy"
          | "timeout"
          | "cancelled"
          | "provider_error"
          | "internal_error";
        message: string;
        retryable: boolean;
      };
    };

export function completeBrowserTranslation(
  taskId: string,
  outcome: BrowserTranslationOutcome,
): Promise<void> {
  return invoke<void>("complete_browser_translation", { taskId, outcome });
}

export function setBrowserTranslationBridgeReady(
  bridgeId: string,
  ready: boolean,
): Promise<void> {
  return invoke<void>("set_browser_translation_bridge_ready", { bridgeId, ready });
}
