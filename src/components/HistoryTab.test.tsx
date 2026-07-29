// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import HistoryTab from "./HistoryTab";

const {
  clearHistoryMock,
  deleteHistoryMock,
  disposeMock,
  listHistoryMock,
  listenMock,
} = vi.hoisted(() => ({
  clearHistoryMock: vi.fn(),
  deleteHistoryMock: vi.fn(),
  disposeMock: vi.fn(),
  listHistoryMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("../services/history", () => ({
  clearTranslationHistory: clearHistoryMock,
  deleteTranslationHistoryEntry: deleteHistoryMock,
  listTranslationHistory: listHistoryMock,
}));

const entry = {
  id: 42,
  source_text: "source text",
  translated_text: "translated text",
  source_lang: "English",
  target_lang: "Chinese",
  model: "test-model",
  created_at: "2026-07-29 10:00:00",
};

describe("HistoryTab", () => {
  beforeEach(() => {
    clearHistoryMock.mockReset().mockResolvedValue(undefined);
    deleteHistoryMock.mockReset().mockResolvedValue(undefined);
    disposeMock.mockReset();
    listHistoryMock.mockReset().mockResolvedValue([entry]);
    listenMock.mockReset().mockResolvedValue(disposeMock);
  });

  afterEach(() => {
    cleanup();
  });

  it("loads on mount, removes a deleted entry locally, and releases its listener", async () => {
    const view = render(<HistoryTab labels={translations.en} />);

    expect(await screen.findByText("translated text")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(translations.en.delete));

    await waitFor(() => {
      expect(deleteHistoryMock).toHaveBeenCalledWith(42);
      expect(screen.queryByText("translated text")).not.toBeInTheDocument();
    });
    view.unmount();
    await waitFor(() => expect(disposeMock).toHaveBeenCalledOnce());
  });

  it("clears the visible history after the backend command succeeds", async () => {
    render(<HistoryTab labels={translations.en} />);

    await screen.findByText("translated text");
    fireEvent.click(screen.getByRole("button", { name: translations.en.clearAll }));

    await waitFor(() => expect(clearHistoryMock).toHaveBeenCalledOnce());
    expect(screen.getByText(translations.en.noHistory)).toBeInTheDocument();
  });

  it("offers a retry after the initial load fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    listHistoryMock
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([]);
    render(<HistoryTab labels={translations.en} />);

    fireEvent.click(await screen.findByRole("button", { name: translations.en.retry }));

    await waitFor(() => expect(listHistoryMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(translations.en.noHistory)).toBeInTheDocument();
  });
});
