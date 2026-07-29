// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGlossary } from "./useGlossary";

const {
  addMock,
  deleteMock,
  listMock,
  updateMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  deleteMock: vi.fn(),
  listMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../services/glossary", () => ({
  addGlossaryEntry: addMock,
  deleteGlossaryEntry: deleteMock,
  listGlossaryEntries: listMock,
  updateGlossaryEntry: updateMock,
}));

const entry = (id: number, source = `source-${id}`) => ({
  id,
  source_term: source,
  target_term: `target-${id}`,
  created_at: "2026-07-29",
});

describe("useGlossary", () => {
  beforeEach(() => {
    addMock.mockReset().mockResolvedValue(undefined);
    deleteMock.mockReset().mockResolvedValue(undefined);
    updateMock.mockReset().mockResolvedValue(undefined);
    listMock.mockReset().mockResolvedValue([]);
  });

  it("loads entries and refreshes after a successful mutation", async () => {
    listMock
      .mockResolvedValueOnce([entry(1)])
      .mockResolvedValueOnce([entry(1), entry(2)]);
    const { result } = renderHook(() => useGlossary());

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.add("source-2", "target-2");
    });

    expect(succeeded).toBe(true);
    expect(addMock).toHaveBeenCalledWith("source-2", "target-2");
    expect(result.current.entries).toHaveLength(2);
  });

  it("ignores an older load that finishes after the latest request", async () => {
    let resolveOlder: (value: ReturnType<typeof entry>[]) => void = () => {};
    let resolveNewer: (value: ReturnType<typeof entry>[]) => void = () => {};
    listMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveOlder = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNewer = resolve; }));
    const { result } = renderHook(() => useGlossary());

    act(() => {
      void result.current.load();
    });
    await act(async () => {
      resolveNewer([entry(2, "latest")]);
    });
    expect(result.current.entries[0]?.source_term).toBe("latest");

    await act(async () => {
      resolveOlder([entry(1, "stale")]);
    });
    expect(result.current.entries[0]?.source_term).toBe("latest");
  });

  it("keeps existing entries and exposes retry state after a mutation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    listMock.mockResolvedValueOnce([entry(1)]);
    deleteMock.mockRejectedValueOnce(new Error("database unavailable"));
    const { result } = renderHook(() => useGlossary());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.remove(1);
    });

    expect(succeeded).toBe(false);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.hasError).toBe(true);
  });
});
