// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useSystemMaintenance } from "./useSystemMaintenance";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  disable: vi.fn(),
  enable: vi.fn(),
  isEnabled: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const disableMock = vi.mocked(disable);
const enableMock = vi.mocked(enable);
const isEnabledMock = vi.mocked(isEnabled);

describe("useSystemMaintenance", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_audio_cache_size") return "12 KB" as never;
      return undefined as never;
    });
    disableMock.mockReset();
    enableMock.mockReset();
    isEnabledMock.mockReset();
    disableMock.mockResolvedValue(undefined);
    enableMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads cache size and refreshes it after a successful clear", async () => {
    const { result } = renderHook(() =>
      useSystemMaintenance({ setAutoLaunch: vi.fn() }),
    );
    await waitFor(() => expect(result.current.cacheSize).toBe("12 KB"));

    invokeMock.mockImplementation(async (command) => {
      if (command === "get_audio_cache_size") return "0 B" as never;
      return undefined as never;
    });
    let cleared = false;
    await act(async () => {
      cleared = await result.current.clearCache();
    });

    expect(cleared).toBe(true);
    expect(result.current.cacheSize).toBe("0 B");
    expect(invokeMock).toHaveBeenCalledWith("clear_audio_cache");
  });

  it("ignores a cache response that arrives after unmount", async () => {
    let resolveSize: ((value: string) => void) | undefined;
    invokeMock.mockImplementation((command) => {
      if (command === "get_audio_cache_size") {
        return new Promise<string>((resolve) => {
          resolveSize = resolve;
        }) as never;
      }
      return Promise.resolve() as never;
    });
    const { result, unmount } = renderHook(() =>
      useSystemMaintenance({ setAutoLaunch: vi.fn() }),
    );
    unmount();
    await act(async () => {
      resolveSize?.("late");
      await Promise.resolve();
    });

    expect(result.current.cacheSize).toBe("0 B");
  });

  it("toggles autostart once and verifies the operating-system state", async () => {
    vi.useFakeTimers();
    isEnabledMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const setAutoLaunch = vi.fn();
    const { result } = renderHook(() =>
      useSystemMaintenance({ setAutoLaunch }),
    );

    let toggleResult: string | undefined;
    await act(async () => {
      const pending = result.current.toggleAutoLaunch();
      await vi.advanceTimersByTimeAsync(500);
      toggleResult = await pending;
    });

    expect(enableMock).toHaveBeenCalledTimes(1);
    expect(disableMock).not.toHaveBeenCalled();
    expect(setAutoLaunch).toHaveBeenCalledWith(true);
    expect(toggleResult).toBe("success");
  });

  it("deduplicates diagnostics exports and classifies cancellation", async () => {
    let rejectExport: ((reason: unknown) => void) | undefined;
    invokeMock.mockImplementation((command) => {
      if (command === "export_diagnostics") {
        return new Promise((_, reject) => {
          rejectExport = reject;
        }) as never;
      }
      if (command === "get_audio_cache_size") return Promise.resolve("0 B") as never;
      return Promise.resolve() as never;
    });
    const { result } = renderHook(() =>
      useSystemMaintenance({ setAutoLaunch: vi.fn() }),
    );

    let firstResult:
      | Awaited<ReturnType<typeof result.current.exportDiagnostics>>
      | undefined;
    await act(async () => {
      const first = result.current.exportDiagnostics();
      expect(await result.current.exportDiagnostics()).toEqual({ status: "busy" });
      rejectExport?.({ code: "cancelled", message: "User cancelled" });
      firstResult = await first;
    });

    expect(firstResult).toEqual({ status: "cancelled" });
    expect(invokeMock.mock.calls.filter(([command]) => command === "export_diagnostics")).toHaveLength(1);
  });

  it("marks a diagnostics result as ignored after unmount", async () => {
    let resolveExport: (() => void) | undefined;
    invokeMock.mockImplementation((command) => {
      if (command === "export_diagnostics") {
        return new Promise<void>((resolve) => {
          resolveExport = resolve;
        }) as never;
      }
      if (command === "get_audio_cache_size") return Promise.resolve("0 B") as never;
      return Promise.resolve() as never;
    });
    const { result, unmount } = renderHook(() =>
      useSystemMaintenance({ setAutoLaunch: vi.fn() }),
    );

    const pending = result.current.exportDiagnostics();
    unmount();
    let exportResult:
      | Awaited<ReturnType<typeof result.current.exportDiagnostics>>
      | undefined;
    await act(async () => {
      resolveExport?.();
      exportResult = await pending;
    });

    expect(exportResult).toEqual({ status: "ignored" });
  });
});
