import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslationHistory,
  deleteTranslationHistoryEntry,
  listTranslationHistory,
} from "./history";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("translation history service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads a bounded first history page by default", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await expect(listTranslationHistory()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("get_translation_history", {
      limit: 100,
      offset: 0,
    });
  });

  it("forwards explicit pagination", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await listTranslationHistory(25, 50);
    expect(invokeMock).toHaveBeenCalledWith("get_translation_history", {
      limit: 25,
      offset: 50,
    });
  });

  it("uses typed commands for delete and clear operations", async () => {
    invokeMock.mockResolvedValue(undefined);

    await deleteTranslationHistoryEntry(42);
    await clearTranslationHistory();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "delete_translation", { id: 42 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "clear_translation_history");
  });
});
