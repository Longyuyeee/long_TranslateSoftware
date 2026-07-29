// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import GlossaryEditor from "./GlossaryEditor";

const glossaryEntry = {
  id: 42,
  source_term: "Long Translate",
  target_term: "Long 翻译",
  created_at: "2026-07-29",
};

const defaultProps = {
  labels: translations.en,
  entries: [glossaryEntry],
  isLoading: false,
  isMutating: false,
  hasError: false,
  onRetry: vi.fn(),
  onAdd: vi.fn().mockResolvedValue(true),
  onUpdate: vi.fn().mockResolvedValue(true),
  onDelete: vi.fn().mockResolvedValue(true),
};

describe("GlossaryEditor", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("trims a new entry and clears the form only after success", async () => {
    render(<GlossaryEditor {...defaultProps} />);

    fireEvent.change(screen.getAllByLabelText(translations.en.glossaryTerm)[0], {
      target: { value: "  API  " },
    });
    fireEvent.change(screen.getAllByLabelText(translations.en.glossaryTranslation)[0], {
      target: { value: "  接口  " },
    });
    fireEvent.click(screen.getByRole("button", { name: translations.en.addTerm }));

    await waitFor(() => expect(defaultProps.onAdd).toHaveBeenCalledWith("API", "接口"));
    expect(screen.getAllByLabelText(translations.en.glossaryTerm)[0]).toHaveValue("");
  });

  it("supports editing, saving, cancelling, and deleting with named controls", async () => {
    render(<GlossaryEditor {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: translations.en.editTerm }));
    const sourceInput = screen.getAllByLabelText(translations.en.glossaryTerm)[0];
    fireEvent.change(sourceInput, { target: { value: "Updated term" } });
    fireEvent.click(screen.getByRole("button", { name: translations.en.save }));

    await waitFor(() => {
      expect(defaultProps.onUpdate).toHaveBeenCalledWith(
        42,
        "Updated term",
        "Long 翻译",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: translations.en.delete }));
    expect(defaultProps.onDelete).toHaveBeenCalledWith(42);
  });

  it("shows an explicit retry action after loading fails", () => {
    render(<GlossaryEditor {...defaultProps} entries={[]} hasError />);

    fireEvent.click(screen.getByRole("button", { name: translations.en.retry }));
    expect(defaultProps.onRetry).toHaveBeenCalledOnce();
  });
});
