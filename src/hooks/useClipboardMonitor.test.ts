// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardMonitor } from "./useClipboardMonitor";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("useClipboardMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("forwards only new non-empty clipboard values", async () => {
    const clipboardValues = ["first", "first", "", "second"];
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_clipboard_text") return clipboardValues.shift() as never;
      return undefined as never;
    });
    renderHook(() => useClipboardMonitor(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900 * 4);
    });

    expect(invokeMock.mock.calls).toEqual([
      ["get_clipboard_text"],
      ["clipboard_detect", { text: "first" }],
      ["get_clipboard_text"],
      ["get_clipboard_text"],
      ["get_clipboard_text"],
      ["clipboard_detect", { text: "second" }],
    ]);
  });

  it("stops polling when monitoring is disabled", async () => {
    invokeMock.mockResolvedValue("text" as never);
    const { rerender } = renderHook(
      ({ enabled }) => useClipboardMonitor(enabled),
      { initialProps: { enabled: true } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    rerender({ enabled: false });
    invokeMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not forward a pending read after unmount", async () => {
    let resolveRead: ((value: string) => void) | undefined;
    invokeMock.mockImplementation((command) => {
      if (command === "get_clipboard_text") {
        return new Promise<string>((resolve) => {
          resolveRead = resolve;
        }) as never;
      }
      return Promise.resolve() as never;
    });
    const { unmount } = renderHook(() => useClipboardMonitor(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    unmount();
    await act(async () => {
      resolveRead?.("late text");
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith("clipboard_detect", expect.anything());
  });
});
