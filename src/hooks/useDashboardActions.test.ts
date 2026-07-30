// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { translations } from "../i18n";
import { speak } from "../services/api";
import { useDashboardActions } from "./useDashboardActions";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("../services/api", () => ({
  speak: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const speakMock = vi.mocked(speak);

const createOptions = () => ({
  labels: translations.en,
  addNotification: vi.fn(),
  showToast: vi.fn(),
  clearCache: vi.fn().mockResolvedValue(true),
  refreshCacheSize: vi.fn().mockResolvedValue("2 KB"),
  updateAutoLaunch: vi.fn().mockResolvedValue("success" as const),
  exportDiagnostics: vi.fn().mockResolvedValue({ status: "success" as const }),
  promptForPassword: vi.fn().mockReturnValue("secret"),
  reloadWindow: vi.fn(),
});

describe("useDashboardActions", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined as never);
    speakMock.mockReset();
    speakMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports an encrypted backup once and reports success", async () => {
    let resolveExport: (() => void) | undefined;
    invokeMock.mockImplementation((command) => {
      if (command === "export_data") {
        return new Promise<void>((resolve) => {
          resolveExport = resolve;
        }) as never;
      }
      return Promise.resolve() as never;
    });
    const options = createOptions();
    const { result } = renderHook(() => useDashboardActions(options));

    await act(async () => {
      const first = result.current.exportData();
      await result.current.exportData();
      resolveExport?.();
      await first;
    });

    expect(options.promptForPassword).toHaveBeenCalledWith(
      translations.en.exportPassword,
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("export_data", {
      password: "secret",
    });
    expect(options.showToast).toHaveBeenCalledWith(
      "success",
      translations.en.exportSuccessMsg,
    );
    expect(options.addNotification).toHaveBeenCalledWith(
      translations.en.exportSuccess,
    );
  });

  it("rejects an empty export password without invoking the backend", async () => {
    const options = createOptions();
    options.promptForPassword.mockReturnValue("   ");
    const { result } = renderHook(() => useDashboardActions(options));

    await act(() => result.current.exportData());

    expect(invokeMock).not.toHaveBeenCalled();
    expect(options.showToast).toHaveBeenCalledWith(
      "warning",
      translations.en.passwordEmpty,
    );
  });

  it("reloads after import and cancels the reload when unmounted", async () => {
    vi.useFakeTimers();
    const options = createOptions();
    const first = renderHook(() => useDashboardActions(options));

    await act(() => first.result.current.importData());
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(options.reloadWindow).toHaveBeenCalledTimes(1);

    const secondOptions = createOptions();
    const second = renderHook(() => useDashboardActions(secondOptions));
    await act(() => second.result.current.importData());
    second.unmount();
    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(secondOptions.reloadWindow).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("import_data", {
      password: "secret",
    });
  });

  it("exports wordbook formats and Anki with the existing command protocol", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "export_anki") return "C:\\exports\\words.apkg" as never;
      return undefined as never;
    });
    const options = createOptions();
    const { result } = renderHook(() => useDashboardActions(options));

    await act(async () => {
      await result.current.exportWordbook("csv");
      await result.current.exportWordbook("json");
      await result.current.exportAnki();
    });

    expect(invokeMock).toHaveBeenCalledWith("export_wordbook", {
      format: "csv",
    });
    expect(invokeMock).toHaveBeenCalledWith("export_wordbook", {
      format: "json",
    });
    expect(invokeMock).toHaveBeenCalledWith("export_anki");
    expect(options.showToast).toHaveBeenCalledWith(
      "success",
      `${translations.en.exportAnkiSuccess}: C:\\exports\\words.apkg`,
    );
  });

  it("keeps cancellation silent and reports other export failures", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "cancelled", message: "User cancelled" })
      .mockRejectedValueOnce(new Error("disk full"));
    const options = createOptions();
    const { result } = renderHook(() => useDashboardActions(options));

    await act(async () => {
      await result.current.exportData();
      await result.current.exportAnki();
    });

    expect(options.addNotification).not.toHaveBeenCalled();
    expect(options.showToast).toHaveBeenCalledTimes(1);
    expect(options.showToast).toHaveBeenCalledWith(
      "error",
      `${translations.en.exportFailed}: Error: disk full`,
    );
  });

  it("coordinates cache, speech, auto-launch, and diagnostics feedback", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useDashboardActions(options));

    await act(async () => {
      await result.current.clearAudioCache();
      result.current.speakWordbookText("hello");
      await Promise.resolve();
      await result.current.toggleAutoLaunch();
      await result.current.exportDiagnosticReport();
      window.dispatchEvent(new CustomEvent("tts-error", { detail: "offline" }));
    });

    expect(options.clearCache).toHaveBeenCalledTimes(1);
    expect(speakMock).toHaveBeenCalledWith("hello");
    expect(options.refreshCacheSize).toHaveBeenCalledTimes(1);
    expect(options.showToast).toHaveBeenCalledWith(
      "success",
      translations.en.cacheCleared,
    );
    expect(options.showToast).toHaveBeenCalledWith(
      "success",
      translations.en.success,
    );
    expect(options.showToast).toHaveBeenCalledWith(
      "success",
      translations.en.diagnosticsExportSuccess,
    );
    expect(options.showToast).toHaveBeenCalledWith(
      "error",
      `${translations.en.ttsPlaybackFailed}: offline`,
    );
  });

  it("uses the latest labels when an async action finishes", async () => {
    let resolveExport: (() => void) | undefined;
    invokeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = resolve;
        }) as never,
    );
    const options = createOptions();
    const { result, rerender } = renderHook(
      ({ currentOptions }) => useDashboardActions(currentOptions),
      { initialProps: { currentOptions: options } },
    );

    const pending = result.current.exportData();
    const updated = { ...options, labels: translations.zh };
    rerender({ currentOptions: updated });
    await act(async () => {
      resolveExport?.();
      await pending;
    });

    expect(options.showToast).toHaveBeenCalledWith(
      "success",
      translations.zh.exportSuccessMsg,
    );
  });
});
