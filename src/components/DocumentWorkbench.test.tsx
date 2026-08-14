// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import DocumentWorkbench from "./DocumentWorkbench";

const { inspectMock, pickMock } = vi.hoisted(() => ({
  inspectMock: vi.fn(),
  pickMock: vi.fn(),
}));

vi.mock("../services/documentTranslation", () => ({
  inspectDocxDocument: inspectMock,
  pickDocxDocument: pickMock,
}));

describe("DocumentWorkbench", () => {
  beforeEach(() => {
    pickMock.mockResolvedValue("C:\\private\\fixture.docx");
    inspectMock.mockResolvedValue({
      fingerprint: "sha256:fixture",
      fileName: "fixture.docx",
      sizeBytes: 2048,
      warnings: [{ code: "images-ignored", message: "raw backend warning" }],
      segments: [{
        id: "segment-1",
        order: 0,
        part: "word/document.xml",
        sourcePosition: "paragraph:0:chunk:0:bytes:0-5:runs:0-0:text-nodes:0-0",
        structure: "heading",
        sourceText: "Hello 世界",
      }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("inspects a selected DOCX and renders bounded localized details", async () => {
    render(<DocumentWorkbench labels={translations.en} />);

    fireEvent.click(screen.getByRole("button", { name: translations.en.documentChoose }));

    expect(await screen.findByText("fixture.docx")).toBeInTheDocument();
    expect(screen.getByText("Hello 世界")).toBeInTheDocument();
    expect(screen.getByText(translations.en.documentStructure_heading)).toBeInTheDocument();
    expect(screen.getByText(translations.en["documentWarning_images-ignored"])).toBeInTheDocument();
    expect(screen.queryByText("raw backend warning")).not.toBeInTheDocument();
    expect(screen.queryByText("C:\\private\\fixture.docx")).not.toBeInTheDocument();
  });

  it("shows a stable localized error without exposing backend details", async () => {
    inspectMock.mockRejectedValue({
      code: "invalid-input",
      message: "C:\\private\\damaged.docx contains secret details",
    });
    render(<DocumentWorkbench labels={translations.en} />);

    fireEvent.click(screen.getByRole("button", { name: translations.en.documentChoose }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      translations.en["documentImportError_invalid-input"],
    );
    expect(screen.queryByText(/private.*secret/iu)).not.toBeInTheDocument();
  });

  it("disables the action while the system picker is active", async () => {
    let resolvePick: (value: null) => void = () => undefined;
    pickMock.mockReturnValue(new Promise<null>(resolve => {
      resolvePick = resolve;
    }));
    render(<DocumentWorkbench labels={translations.en} />);

    const button = screen.getByRole("button", { name: translations.en.documentChoose });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(screen.getByRole("button", { name: translations.en.documentSelecting })).toBeDisabled();
    expect(pickMock).toHaveBeenCalledOnce();
    resolvePick(null);
    await waitFor(() => expect(screen.getByRole("button", { name: translations.en.documentChoose })).toBeEnabled());
  });
});
