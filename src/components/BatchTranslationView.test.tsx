// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import BatchTranslationView from "./BatchTranslationView";

vi.mock("../hooks/useGlossary", () => ({
  useGlossary: () => ({
    entries: [],
    isLoading: false,
    isMutating: false,
    hasError: false,
    load: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("./GlossaryEditor", () => ({
  default: () => <div data-testid="glossary-editor" />,
}));

const callbacks = {
  onSourceLanguageChange: vi.fn(),
  onTargetLanguageChange: vi.fn(),
  onInputChange: vi.fn(),
  onTranslate: vi.fn(),
  onCompareTranslate: vi.fn(),
  onBackTranslate: vi.fn(),
  onCancel: vi.fn(),
  onCompareModeChange: vi.fn(),
};

const baseProps = {
  labels: translations.en,
  languageOptions: [
    { value: "English", label: "English" },
    { value: "Chinese", label: "Chinese" },
  ],
  sourceLang: "auto",
  targetLang: "English",
  primaryModelName: "primary-model",
  backupModelName: "backup-model",
  batchInput: "Hello",
  batchOutput: "",
  batchOutputBackup: "",
  compareMode: false,
  batchBackTranslation: "",
  isBatchBackTranslating: false,
  isTranslating: false,
  batchTaskState: { requestId: "", phase: "idle" } as const,
  primaryComparisonState: null,
  backupComparisonState: null,
  ...callbacks,
};

describe("BatchTranslationView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("routes text input and normal translation actions to its owner", async () => {
    render(<BatchTranslationView {...baseProps} />);

    fireEvent.change(screen.getByRole("textbox", { name: translations.en.inputText }), {
      target: { value: "Updated text" },
    });
    fireEvent.click(screen.getByRole("button", { name: translations.en.translate }));

    expect(callbacks.onInputChange).toHaveBeenCalledWith("Updated text");
    expect(callbacks.onTranslate).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("glossary-editor")).toBeInTheDocument();
  });

  it("uses cancel while translating and locks comparison switching", () => {
    render(
      <BatchTranslationView
        {...baseProps}
        isTranslating
        batchTaskState={{ requestId: "task-1", phase: "translating-primary" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: translations.en.cancelTranslation }));

    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: new RegExp(translations.en.compareMode, "i") })).toBeDisabled();
    expect(screen.getByText(translations.en.translationPrimary)).toBeInTheDocument();
  });

  it("routes comparison translation and renders independent model states", () => {
    render(
      <BatchTranslationView
        {...baseProps}
        compareMode
        batchOutput="Primary result"
        batchOutputBackup="Backup result"
        primaryComparisonState={{
          requestId: "compare-1",
          side: "primary",
          phase: "success",
          model: "fast-primary",
          durationMs: 120,
        }}
        backupComparisonState={{
          requestId: "compare-1",
          side: "backup",
          phase: "success",
          model: "safe-backup",
          durationMs: 240,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: translations.en.translate }));

    expect(callbacks.onCompareTranslate).toHaveBeenCalledOnce();
    expect(screen.getByText("Primary result")).toBeInTheDocument();
    expect(screen.getByText("Backup result")).toBeInTheDocument();
    expect(screen.getByText("fast-primary")).toBeInTheDocument();
    expect(screen.getByText("safe-backup")).toBeInTheDocument();
  });
});
