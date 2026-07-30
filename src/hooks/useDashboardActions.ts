import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";
import type { TranslationCatalog } from "../i18n";
import { speak } from "../services/api";
import type { ToastType } from "../components/Toast";
import type {
  AutoLaunchToggleResult,
  DiagnosticsExportResult,
} from "./useSystemMaintenance";
import {
  commandErrorMessage,
  isCommandError,
} from "../services/commandErrors";

type UseDashboardActionsOptions = {
  labels: TranslationCatalog;
  addNotification: (message: string) => void;
  showToast: (type: ToastType, message: string) => void;
  clearCache: () => Promise<boolean>;
  refreshCacheSize: () => Promise<string | null>;
  updateAutoLaunch: () => Promise<AutoLaunchToggleResult>;
  exportDiagnostics: () => Promise<DiagnosticsExportResult>;
  promptForPassword?: (message: string) => string | null;
  reloadWindow?: () => void;
};

type WordbookExportFormat = "csv" | "json";
type DashboardAction =
  | "export-data"
  | "import-data"
  | "export-wordbook-csv"
  | "export-wordbook-json"
  | "export-anki";

const isCancelled = (error: unknown) =>
  error === "User cancelled" || isCommandError(error, "cancelled");
const requestPassword = (
  promptForPassword: UseDashboardActionsOptions["promptForPassword"],
  message: string,
) => promptForPassword ? promptForPassword(message) : window.prompt(message);

export function useDashboardActions(options: UseDashboardActionsOptions) {
  const latestRef = useRef(options);
  const mountedRef = useRef(true);
  const activeActionsRef = useRef(new Set<DashboardAction>());
  const reloadTimerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = options;
  }, [options]);

  useEffect(() => {
    mountedRef.current = true;
    const handleTtsError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      const current = latestRef.current;
      current.showToast(
        "error",
        `${current.labels.ttsPlaybackFailed}${message ? `: ${message}` : ""}`,
      );
    };
    window.addEventListener("tts-error", handleTtsError);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("tts-error", handleTtsError);
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, []);

  const runOnce = useCallback(
    async (action: DashboardAction, task: () => Promise<void>) => {
      if (activeActionsRef.current.has(action)) return;
      activeActionsRef.current.add(action);
      try {
        await task();
      } finally {
        activeActionsRef.current.delete(action);
      }
    },
    [],
  );

  const exportData = useCallback(async () => {
    await runOnce("export-data", async () => {
      const current = latestRef.current;
      const password = requestPassword(
        current.promptForPassword,
        current.labels.exportPassword,
      );
      if (password === null) return;
      if (!password.trim()) {
        current.showToast("warning", current.labels.passwordEmpty);
        return;
      }
      try {
        await invoke<string>("export_data", { password });
        if (!mountedRef.current) return;
        const latest = latestRef.current;
        latest.showToast("success", latest.labels.exportSuccessMsg);
        latest.addNotification(latest.labels.exportSuccess);
      } catch (error) {
        if (!mountedRef.current || isCancelled(error)) return;
        const latest = latestRef.current;
        const message = `${latest.labels.exportFailed}: ${commandErrorMessage(error)}`;
        latest.showToast("error", message);
        latest.addNotification(message);
      }
    });
  }, [runOnce]);

  const importData = useCallback(async () => {
    await runOnce("import-data", async () => {
      const current = latestRef.current;
      const password = requestPassword(
        current.promptForPassword,
        current.labels.importPassword,
      );
      if (password === null) return;
      try {
        await invoke("import_data", { password: password || "" });
        if (!mountedRef.current) return;
        reloadTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) {
            (latestRef.current.reloadWindow ?? (() => window.location.reload()))();
          }
        }, 500);
      } catch (error) {
        if (!mountedRef.current || isCancelled(error)) return;
        const latest = latestRef.current;
        const message = `${latest.labels.importFailed}: ${commandErrorMessage(error)}`;
        latest.showToast("error", message);
        latest.addNotification(message);
      }
    });
  }, [runOnce]);

  const clearAudioCache = useCallback(async () => {
    const current = latestRef.current;
    if (await current.clearCache()) {
      const latest = latestRef.current;
      latest.showToast("success", latest.labels.cacheCleared);
    }
  }, []);

  const exportWordbook = useCallback(
    async (format: WordbookExportFormat) => {
      const action: DashboardAction = `export-wordbook-${format}`;
      await runOnce(action, async () => {
        try {
          await invoke("export_wordbook", { format });
          if (!mountedRef.current) return;
          const latest = latestRef.current;
          latest.addNotification(
            `${latest.labels.exportSuccess} (${format.toUpperCase()})`,
          );
        } catch (error) {
          if (!mountedRef.current || isCancelled(error)) return;
          const latest = latestRef.current;
          latest.addNotification(
            `${latest.labels.exportFailed}: ${commandErrorMessage(error)}`,
          );
        }
      });
    },
    [runOnce],
  );

  const exportAnki = useCallback(async () => {
    await runOnce("export-anki", async () => {
      try {
        const path = await invoke<string>("export_anki");
        if (!mountedRef.current) return;
        const latest = latestRef.current;
        latest.showToast(
          "success",
          `${latest.labels.exportAnkiSuccess}: ${path}`,
        );
      } catch (error) {
        if (!mountedRef.current || isCancelled(error)) return;
        const latest = latestRef.current;
        latest.showToast(
          "error",
          `${latest.labels.exportFailed}: ${commandErrorMessage(error)}`,
        );
      }
    });
  }, [runOnce]);

  const speakWordbookText = useCallback((text: string) => {
    void speak(text).then(() => latestRef.current.refreshCacheSize());
  }, []);

  const toggleAutoLaunch = useCallback(async () => {
    const result = await latestRef.current.updateAutoLaunch();
    if (!mountedRef.current) return;
    const latest = latestRef.current;
    if (result === "denied") {
      latest.showToast("warning", latest.labels.autoLaunchDenied);
      latest.addNotification(latest.labels.autoLaunchDenied);
    } else if (result === "success") {
      latest.showToast("success", latest.labels.success);
      latest.addNotification(latest.labels.success);
    } else if (result === "failed") {
      latest.showToast("error", latest.labels.autoLaunchFailed);
      latest.addNotification(latest.labels.autoLaunchFailed);
    }
  }, []);

  const exportDiagnosticReport = useCallback(async () => {
    const result = await latestRef.current.exportDiagnostics();
    if (!mountedRef.current) return;
    const latest = latestRef.current;
    if (result.status === "success") {
      latest.showToast("success", latest.labels.diagnosticsExportSuccess);
      latest.addNotification(latest.labels.diagnosticsExportSuccess);
    } else if (result.status === "failed") {
      const message = `${latest.labels.diagnosticsExportFailed}: ${commandErrorMessage(result.error)}`;
      latest.showToast("error", message);
      latest.addNotification(message);
    }
  }, []);

  return {
    exportData,
    importData,
    clearAudioCache,
    exportWordbook,
    exportAnki,
    speakWordbookText,
    toggleAutoLaunch,
    exportDiagnosticReport,
  };
}
