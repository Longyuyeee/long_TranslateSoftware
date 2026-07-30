// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import {
  BACKGROUND_SYNC_DELAY_MS,
  useAppStats,
  useDashboardSync,
} from "./useDashboardSync";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const summary = {
  downloaded: 1,
  added: 2,
  updated: 3,
  unchanged: 4,
  contextsAdded: 5,
  uploaded: 6,
  firstSync: false,
  completedAt: "2026-07-30T10:00:00Z",
};

const listeners = new Map<string, (event: { payload: any }) => void>();
const disposers = new Map<string, ReturnType<typeof vi.fn>>();

function createOptions() {
  return {
    labels: translations.en,
    webdav: {
      enabled: true,
      url: "https://dav.example/remote.php/dav/files/user",
      user: "user",
      password: "secret",
    },
    loadSettings: vi.fn(),
    loadWordbook: vi.fn(),
    refreshStats: vi.fn(),
    setLastSyncTime: vi.fn(),
    setLastSyncSummary: vi.fn(),
    addNotification: vi.fn(),
    showToast: vi.fn(),
  };
}

describe("dashboard synchronization hooks", () => {
  beforeEach(() => {
    listeners.clear();
    disposers.clear();
    invokeMock.mockReset().mockImplementation((command: string) => {
      if (command === "get_app_stats") {
        return Promise.resolve({
          word_count: 12,
          trans_count: 34,
          days_active: 5,
          due_today: 6,
        });
      }
      if (command === "sync_wordbook") return Promise.resolve(summary);
      if (command === "test_webdav_connection") {
        return Promise.resolve({ latencyMs: 42 });
      }
      return Promise.resolve(undefined);
    });
    listenMock.mockReset().mockImplementation(
      (event: string, callback: (event: { payload: any }) => void) => {
        listeners.set(event, callback);
        const dispose = vi.fn();
        disposers.set(event, dispose);
        return Promise.resolve(dispose);
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads dashboard data, updates statistics, and releases every listener", async () => {
    const options = createOptions();
    const view = renderHook(() => {
      const stats = useAppStats();
      const sync = useDashboardSync({
        ...options,
        refreshStats: stats.refreshStats,
      });
      return { ...stats, ...sync };
    });

    await waitFor(() => expect(view.result.current.appStats.word_count).toBe(12));
    expect(options.loadSettings).toHaveBeenCalledOnce();
    expect(options.loadWordbook).toHaveBeenCalledOnce();
    expect([...listeners.keys()]).toEqual([
      "wordbook-updated",
      "shortcut-error",
      "config-updated",
      "webdav-sync-completed",
    ]);

    view.unmount();
    await waitFor(() => {
      expect([...disposers.values()].every((dispose) => dispose.mock.calls.length === 1))
        .toBe(true);
    });
  });

  it("debounces local wordbook changes and serializes background sync", async () => {
    vi.useFakeTimers();
    const options = createOptions();
    renderHook(() => useDashboardSync(options));
    await act(async () => {});

    act(() => {
      listeners.get("wordbook-updated")?.({ payload: "local" });
      listeners.get("wordbook-updated")?.({ payload: "local" });
    });
    expect(invokeMock).not.toHaveBeenCalledWith("sync_wordbook");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_DELAY_MS);
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "sync_wordbook"),
    ).toEqual([["sync_wordbook"]]);
    expect(options.loadWordbook).toHaveBeenCalledTimes(3);
    expect(options.refreshStats).toHaveBeenCalledTimes(3);
  });

  it("reports manual synchronization and connection-test results", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useDashboardSync(options));
    await act(async () => {});

    await act(async () => {
      await result.current.sync();
      await result.current.testConnection();
    });

    expect(invokeMock).toHaveBeenCalledWith("sync_wordbook", {
      url: options.webdav.url,
      user: options.webdav.user,
      password: options.webdav.password,
      enabled: true,
    });
    expect(options.setLastSyncSummary).toHaveBeenCalledWith(summary);
    expect(options.setLastSyncTime).toHaveBeenCalledWith(summary.completedAt);
    expect(options.addNotification).toHaveBeenCalledWith(
      expect.stringContaining("2"),
    );
    expect(result.current.webdavConnectionTest).toEqual({
      ok: true,
      latencyMs: 42,
    });
    expect(options.showToast).toHaveBeenCalledWith(
      "success",
      translations.en.connectionSuccess.replace("{latency}", "42"),
    );
  });

  it("normalizes connection failures into the shared error state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => {
      if (command === "test_webdav_connection") {
        return Promise.reject({
          code: "unauthorized",
          message: "Denied",
          recoverable: true,
        });
      }
      return Promise.resolve(undefined);
    });
    const options = createOptions();
    const { result } = renderHook(() => useDashboardSync(options));
    await act(async () => {});

    await act(async () => {
      await result.current.testConnection();
    });

    expect(result.current.webdavConnectionTest).toMatchObject({
      ok: false,
      error: { code: "unauthorized", message: "Denied" },
    });
    expect(options.showToast).toHaveBeenCalledWith(
      "error",
      translations.en.webdavError_unauthorized,
    );
  });
});
