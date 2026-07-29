// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useShortcutRecorder } from "./useShortcutRecorder";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("useShortcutRecorder", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined as never);
  });

  it("pauses global shortcuts while recording and saves a normalized key", async () => {
    const onUpdated = vi.fn();
    const onResult = vi.fn();
    const { result } = renderHook(() =>
      useShortcutRecorder({ onUpdated, onResult }),
    );

    act(() => result.current.setRecordingKey("q"));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    await waitFor(() => {
      expect(onUpdated).toHaveBeenCalledWith("q", "Ctrl+Shift+K");
    });
    expect(invokeMock).toHaveBeenCalledWith("set_shortcuts_paused", {
      paused: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("update_shortcut", {
      name: "q",
      shortcutStr: "Ctrl+Shift+K",
    });
    expect(result.current.recordingKey).toBeNull();
  });

  it("always unpauses shortcuts when unmounted during recording", () => {
    const { result, unmount } = renderHook(() =>
      useShortcutRecorder({ onUpdated: vi.fn(), onResult: vi.fn() }),
    );

    act(() => result.current.setRecordingKey("w"));
    invokeMock.mockClear();
    unmount();

    expect(invokeMock).toHaveBeenCalledWith("set_shortcuts_paused", {
      paused: false,
    });
  });

  it("ignores a shortcut update that resolves after unmount", async () => {
    let resolveUpdate: (() => void) | undefined;
    invokeMock.mockImplementation((command) => {
      if (command === "update_shortcut") {
        return new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        }) as never;
      }
      return Promise.resolve() as never;
    });
    const onUpdated = vi.fn();
    const onResult = vi.fn();
    const { result, unmount } = renderHook(() =>
      useShortcutRecorder({ onUpdated, onResult }),
    );

    act(() => result.current.setRecordingKey("q"));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F8",
          bubbles: true,
        }),
      );
    });
    unmount();
    await act(async () => {
      resolveUpdate?.();
      await Promise.resolve();
    });

    expect(onUpdated).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
