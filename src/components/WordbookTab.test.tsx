// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import type { WordbookEntry } from "../services/wordbook";
import WordbookTab from "./WordbookTab";

const word: WordbookEntry = {
  id: 1,
  uuid: "word-1",
  word: "elegant",
  phonetic: "ˈelɪɡənt",
  meaning: "优雅的",
  analysis: JSON.stringify({
    phonetic: "ˈelɪɡənt",
    meaning: "优雅的",
    etymology: "Latin",
    mnemonic: "",
    examples: [{ en: "An elegant design.", zh: "一个优雅的设计。" }],
    synonyms: ["graceful"],
  }),
  created_at: "2026-07-29T00:00:00Z",
  contexts: [],
};

describe("WordbookTab", () => {
  const onSearchChange = vi.fn();
  const onSortChange = vi.fn();
  const onSelectWord = vi.fn();
  const onStartAdding = vi.fn();
  const onNewWordChange = vi.fn();
  const onAddWord = vi.fn();
  const onCancelAdding = vi.fn();
  const onLoadMore = vi.fn();
  const onDeleteWord = vi.fn();
  const onRetryAnalysis = vi.fn();
  const onSpeak = vi.fn();
  const onExport = vi.fn();
  const onExportAnki = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function renderTab(
    overrides: Partial<React.ComponentProps<typeof WordbookTab>> = {},
  ) {
    return render(
      <WordbookTab
        labels={translations.en}
        words={[word]}
        selectedWord={null}
        total={1}
        hasMore={false}
        isLoading={false}
        search=""
        sort="newest"
        newWord=""
        isAdding={false}
        onSearchChange={onSearchChange}
        onSortChange={onSortChange}
        onSelectWord={onSelectWord}
        onStartAdding={onStartAdding}
        onNewWordChange={onNewWordChange}
        onAddWord={onAddWord}
        onCancelAdding={onCancelAdding}
        onLoadMore={onLoadMore}
        onDeleteWord={onDeleteWord}
        onRetryAnalysis={onRetryAnalysis}
        onSpeak={onSpeak}
        onExport={onExport}
        onExportAnki={onExportAnki}
        {...overrides}
      />,
    );
  }

  it("routes search, selection, speech, and export actions", () => {
    renderTab();

    fireEvent.change(
      screen.getByRole("searchbox", { name: translations.en.searchWords }),
      { target: { value: "ele" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "elegant 优雅的" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `${translations.en.readAloud}: elegant`,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: translations.en.exportCsv }),
    );

    expect(onSearchChange).toHaveBeenCalledWith("ele");
    expect(onSelectWord).toHaveBeenCalledWith(word);
    expect(onSpeak).toHaveBeenCalledWith("elegant");
    expect(onExport).toHaveBeenCalledWith("csv");
  });

  it("routes the controlled add-word workflow", () => {
    renderTab({ isAdding: true, newWord: "polished" });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: translations.en.enterWord }),
      { key: "Enter" },
    );

    expect(onAddWord).toHaveBeenCalledOnce();
  });

  it("degrades malformed analysis into a retryable failure state", () => {
    renderTab({
      selectedWord: { ...word, analysis: "{broken" },
    });

    expect(
      screen.getAllByText(translations.en.analysisFailed)[0],
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: translations.en.retryAnalysis }),
    );

    expect(onRetryAnalysis).toHaveBeenCalledOnce();
  });

  it("renders normalized analysis and detail actions", () => {
    renderTab({ selectedWord: word });

    expect(screen.getByText("An elegant design.")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: translations.en.delete }),
    );

    expect(onDeleteWord).toHaveBeenCalledWith(word.id);
  });
});
