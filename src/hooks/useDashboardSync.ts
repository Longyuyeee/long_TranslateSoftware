import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type TranslationCatalog,
  webDavErrorText,
} from "../i18n";
import type { ToastType } from "../components/Toast";
import {
  normalizeWebDavError,
  type WebDavConnectionResult,
  type WebDavError,
  type WebDavSyncSummary,
} from "../services/webdav";

export const BACKGROUND_SYNC_DELAY_MS = 60_000;

export interface AppStats {
  word_count: number;
  trans_count: number;
  days_active: number;
  due_today: number;
}

interface WebDavConfig {
  enabled: boolean;
  url: string;
  user: string;
  password: string;
}

interface UseDashboardSyncOptions {
  labels: TranslationCatalog;
  webdav: WebDavConfig;
  loadSettings: () => void | Promise<void>;
  loadWordbook: () => void | Promise<void>;
  refreshStats: () => void | Promise<void>;
  setLastSyncTime: (value: string) => void;
  setLastSyncSummary: (value: WebDavSyncSummary) => void;
  addNotification: (message: string) => void;
  showToast: (type: ToastType, message: string) => void;
}

type WebDavConnectionState = {
  ok: boolean;
  latencyMs?: number;
  error?: WebDavError;
} | null;

const EMPTY_STATS: AppStats = {
  word_count: 0,
  trans_count: 0,
  days_active: 1,
  due_today: 0,
};

export function useAppStats() {
  const [appStats, setAppStats] = useState<AppStats>(EMPTY_STATS);

  const refreshStats = useCallback(async () => {
    try {
      setAppStats(await invoke<AppStats>("get_app_stats"));
    } catch (error) {
      console.error("Failed to refresh app statistics", error);
    }
  }, []);

  return { appStats, refreshStats };
}

export function useDashboardSync(options: UseDashboardSyncOptions) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [isTestingWebdav, setIsTestingWebdav] = useState(false);
  const [webdavConnectionTest, setWebdavConnectionTest] =
    useState<WebDavConnectionState>(null);
  const latestRef = useRef(options);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncingRef = useRef(false);
  const testingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    latestRef.current = options;
  }, [options]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applySummary = useCallback((summary: WebDavSyncSummary) => {
    if (!mountedRef.current) return;
    const current = latestRef.current;
    current.setLastSyncSummary(summary);
    current.setLastSyncTime(summary.completedAt);
  }, []);

  const sync = useCallback(async (showFeedback = true) => {
    if (syncingRef.current) return false;
    syncingRef.current = true;
    if (mountedRef.current) setIsSyncing(true);
    const current = latestRef.current;

    try {
      const args = showFeedback
        ? {
            url: current.webdav.url,
            user: current.webdav.user,
            password: current.webdav.password,
            enabled: current.webdav.enabled,
          }
        : undefined;
      const summary = args
        ? await invoke<WebDavSyncSummary>("sync_wordbook", args)
        : await invoke<WebDavSyncSummary>("sync_wordbook");
      if (!mountedRef.current) return true;
      applySummary(summary);
      if (showFeedback) {
        current.showToast("success", current.labels.syncSuccess);
        current.addNotification(
          current.labels.syncSummary
            .replace("{added}", String(summary.added))
            .replace("{updated}", String(summary.updated))
            .replace("{uploaded}", String(summary.uploaded)),
        );
        await current.loadWordbook();
      }
      return true;
    } catch (error) {
      console.error("WebDAV sync failed", error);
      if (showFeedback) {
        const normalized = normalizeWebDavError(error);
        current.showToast(
          "error",
          webDavErrorText(
            current.labels,
            normalized.code,
            normalized.message || current.labels.syncFailed,
          ),
        );
      }
      return false;
    } finally {
      syncingRef.current = false;
      if (mountedRef.current) setIsSyncing(false);
    }
  }, [applySummary]);

  const testConnection = useCallback(async () => {
    const current = latestRef.current;
    if (testingRef.current || !current.webdav.url.trim()) return false;
    testingRef.current = true;
    if (mountedRef.current) {
      setIsTestingWebdav(true);
      setWebdavConnectionTest(null);
    }
    try {
      const result = await invoke<WebDavConnectionResult>(
        "test_webdav_connection",
        {
          url: current.webdav.url,
          user: current.webdav.user,
          password: current.webdav.password,
        },
      );
      if (!mountedRef.current) return true;
      setWebdavConnectionTest({ ok: true, latencyMs: result.latencyMs });
      current.showToast(
        "success",
        current.labels.connectionSuccess.replace(
          "{latency}",
          String(result.latencyMs),
        ),
      );
      return true;
    } catch (error) {
      const normalized = normalizeWebDavError(error);
      if (mountedRef.current) {
        setWebdavConnectionTest({ ok: false, error: normalized });
      }
      current.showToast(
        "error",
        webDavErrorText(
          current.labels,
          normalized.code,
          normalized.message || current.labels.connectionFailed,
        ),
      );
      return false;
    } finally {
      testingRef.current = false;
      if (mountedRef.current) setIsTestingWebdav(false);
    }
  }, []);

  useEffect(() => {
    const current = latestRef.current;
    void current.loadSettings();
    void current.loadWordbook();
    void current.refreshStats();

    const unlistenWordbook = listen<string>("wordbook-updated", (event) => {
      const latest = latestRef.current;
      void latest.loadWordbook();
      void latest.refreshStats();
      if (latest.webdav.enabled && event.payload === "local") {
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(() => {
          void sync(false);
        }, BACKGROUND_SYNC_DELAY_MS);
      }
    });
    const unlistenShortcutError = listen<string>("shortcut-error", (event) => {
      const latest = latestRef.current;
      latest.showToast(
        "error",
        `${latest.labels.runtimeError}: ${event.payload}`,
      );
    });
    const unlistenConfigImport = listen("config-updated", () => {
      const latest = latestRef.current;
      void latest.loadSettings();
      void latest.loadWordbook();
      void latest.refreshStats();
      latest.showToast("success", latest.labels.importSuccess);
    });
    const unlistenWebdavSync = listen<WebDavSyncSummary>(
      "webdav-sync-completed",
      (event) => applySummary(event.payload),
    );

    return () => {
      for (const unlisten of [
        unlistenWordbook,
        unlistenShortcutError,
        unlistenConfigImport,
        unlistenWebdavSync,
      ]) {
        void unlisten
          .then((dispose) => dispose())
          .catch((error) => console.error("Failed to release dashboard event", error));
      }
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [applySummary, sync]);

  return {
    isSyncing,
    isTestingWebdav,
    webdavConnectionTest,
    sync,
    testConnection,
    resetConnectionTest: () => setWebdavConnectionTest(null),
  };
}
