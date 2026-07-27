// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "./useSettings";

const invokeMock = vi.fn();
const emitMock = vi.fn();
const isEnabledMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => emitMock(...args),
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: () => isEnabledMock(),
}));

describe("useSettings", () => {
  beforeEach(() => {
    emitMock.mockReset().mockResolvedValue(undefined);
    isEnabledMock.mockReset().mockResolvedValue(true);
    invokeMock.mockReset().mockImplementation((command: string) => {
      if (command === "get_config_values") {
        return Promise.resolve({
          language: "en",
          theme: "light",
          trans_base_url: "https://api.deepseek.com/v1",
          ocr_lang: "en",
        });
      }
      if (command === "get_available_ocr_languages") {
        return Promise.resolve([{
          tag: "en-US",
          display_name: "English (United States)",
          native_name: "English (United States)",
        }]);
      }
      return Promise.resolve(undefined);
    });
  });

  it("hydrates settings and establishes a clean persistence baseline", async () => {
    const { result } = renderHook(() => useSettings());

    await act(async () => {
      await result.current.loadSettings();
    });

    expect(result.current).toMatchObject({
      configHydrated: true,
      hasUnsavedChanges: false,
      lang: "en",
      theme: "light",
      ocrLang: "en-US",
      translationProvider: "deepseek",
      autoLaunch: true,
    });
  });

  it("saves the current snapshot and resets the dirty state", async () => {
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await result.current.loadSettings();
    });
    act(() => result.current.setTheme("dark"));
    expect(result.current.hasUnsavedChanges).toBe(true);

    let saved: "saved" | "skipped" | "failed" = "skipped";
    await act(async () => {
      saved = await result.current.saveSettings();
    });

    expect(saved).toBe("saved");
    expect(invokeMock).toHaveBeenCalledWith("set_config_values", {
      values: expect.objectContaining({ language: "en", theme: "dark" }),
    });
    expect(emitMock).toHaveBeenCalledWith("settings-changed", {
      theme: "dark",
      fontSize: 14,
    });
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("ignores an older configuration load that finishes last", async () => {
    let resolveOlder: (value: Record<string, string>) => void = () => {};
    let resolveNewer: (value: Record<string, string>) => void = () => {};
    const configQueue = [
      new Promise<Record<string, string>>((resolve) => { resolveOlder = resolve; }),
      new Promise<Record<string, string>>((resolve) => { resolveNewer = resolve; }),
    ];
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_config_values") return configQueue.shift();
      if (command === "get_available_ocr_languages") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useSettings());

    let olderLoad: Promise<void> = Promise.resolve();
    let newerLoad: Promise<void> = Promise.resolve();
    act(() => {
      olderLoad = result.current.loadSettings();
      newerLoad = result.current.loadSettings();
    });
    await act(async () => {
      resolveNewer({ theme: "dark" });
      await newerLoad;
    });
    expect(result.current.theme).toBe("dark");

    await act(async () => {
      resolveOlder({ theme: "light" });
      await olderLoad;
    });
    expect(result.current.theme).toBe("dark");
  });

  it("keeps local settings editable when configuration loading fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_config_values") {
        return Promise.reject(new Error("config unavailable"));
      }
      if (command === "get_available_ocr_languages") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useSettings());

    await act(async () => {
      await result.current.loadSettings();
    });
    expect(result.current.configHydrated).toBe(true);
    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => result.current.setTheme("dark"));
    expect(result.current.hasUnsavedChanges).toBe(true);
    consoleError.mockRestore();
  });
});
