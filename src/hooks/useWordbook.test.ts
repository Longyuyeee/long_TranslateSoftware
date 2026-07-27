// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WordbookEntry, WordbookPage } from "../services/wordbook";
import { useWordbook } from "./useWordbook";

const invokeMock = vi.fn();
const getWordbookPageMock = vi.fn();
const analyzeAndSaveWordMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../services/wordbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/wordbook")>();
  return {
    ...actual,
    getWordbookPage: (...args: unknown[]) => getWordbookPageMock(...args),
    analyzeAndSaveWord: (...args: unknown[]) => analyzeAndSaveWordMock(...args),
  };
});

function entry(id: number, word: string): WordbookEntry {
  return {
    id,
    uuid: `word-${id}`,
    word,
    phonetic: "",
    meaning: "",
    analysis: "",
    created_at: "",
    contexts: [],
  };
}

function page(items: WordbookEntry[], total = items.length): WordbookPage<WordbookEntry> {
  return {
    items,
    total,
    offset: 0,
    limit: 100,
    hasMore: items.length < total,
  };
}

describe("useWordbook", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    getWordbookPageMock.mockReset();
    analyzeAndSaveWordMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces filter changes and requests the latest search and sort", async () => {
    vi.useFakeTimers();
    getWordbookPageMock.mockResolvedValue(page([]));
    const { result } = renderHook(() => useWordbook());

    act(() => {
      result.current.setWordbookSearch("term");
      result.current.setWordbookSort("az");
    });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(getWordbookPageMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(getWordbookPageMock).toHaveBeenCalledWith({
      query: "term",
      sort: "az",
      limit: 100,
      offset: 0,
    });
  });

  it("ignores an older page that finishes after the active request", async () => {
    let resolveOlder: (value: WordbookPage<WordbookEntry>) => void = () => {};
    getWordbookPageMock
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOlder = resolve;
      }))
      .mockResolvedValueOnce(page([entry(2, "new result")]));
    const { result } = renderHook(() => useWordbook());

    let olderRequest: Promise<void> = Promise.resolve();
    await act(async () => {
      olderRequest = result.current.loadWordbook({ query: "old" });
      await result.current.loadWordbook({ query: "new" });
    });
    expect(result.current.words.map((word) => word.word)).toEqual(["new result"]);

    await act(async () => {
      resolveOlder(page([entry(1, "old result")]));
      await olderRequest;
    });
    expect(result.current.words.map((word) => word.word)).toEqual(["new result"]);
  });

  it("appends the next page and preserves an updated selected item", async () => {
    const first = entry(1, "alpha");
    const updated = { ...first, meaning: "updated" };
    getWordbookPageMock
      .mockResolvedValueOnce(page([first], 2))
      .mockResolvedValueOnce({
        ...page([entry(2, "beta")], 2),
        offset: 1,
        hasMore: false,
      })
      .mockResolvedValueOnce(page([updated], 2));
    const { result } = renderHook(() => useWordbook());

    await act(async () => {
      await result.current.loadWordbook();
    });
    act(() => result.current.setSelectedWord(first));
    await act(async () => {
      result.current.loadMore();
      await Promise.resolve();
    });
    expect(result.current.words.map((word) => word.word)).toEqual(["alpha", "beta"]);

    await act(async () => {
      await result.current.loadWordbook();
    });
    expect(result.current.selectedWord?.meaning).toBe("updated");
  });

  it("deletes the selected word and reports a data change", async () => {
    const onChanged = vi.fn();
    const selected = entry(7, "remove me");
    const { result } = renderHook(() => useWordbook({ onChanged }));
    act(() => result.current.setSelectedWord(selected));

    await act(async () => {
      await result.current.deleteWord(selected.id);
    });

    expect(invokeMock).toHaveBeenCalledWith("delete_word", { id: 7 });
    expect(result.current.selectedWord).toBeNull();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("clears the manual form before starting analysis", async () => {
    const { result } = renderHook(() => useWordbook());
    act(() => {
      result.current.setIsAdding(true);
      result.current.setNewWord("  hello  ");
    });

    await act(async () => {
      await result.current.addManualWord();
    });

    expect(result.current.isAdding).toBe(false);
    expect(result.current.newWord).toBe("");
    expect(analyzeAndSaveWordMock).toHaveBeenCalledWith("hello");
  });
});
