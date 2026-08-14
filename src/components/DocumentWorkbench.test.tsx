// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import { TranslationRequestError } from "../services/translationProvider";
import DocumentWorkbench from "./DocumentWorkbench";

const {
  cancelRunMock,
  inspectMock,
  loadSnapshotMock,
  pickMock,
  pickOutputMock,
  runHookMock,
  startRunMock,
} = vi.hoisted(() => ({
  cancelRunMock: vi.fn(),
  inspectMock: vi.fn(),
  loadSnapshotMock: vi.fn(),
  pickMock: vi.fn(),
  pickOutputMock: vi.fn(),
  runHookMock: vi.fn(),
  startRunMock: vi.fn(),
}));

vi.mock("../services/documentTranslation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/documentTranslation")>(),
  inspectDocxDocument: inspectMock,
  pickDocxDocument: pickMock,
  pickDocxOutput: pickOutputMock,
}));
vi.mock("../services/translationTask", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/translationTask")>(),
  loadTranslationExecutionSnapshot: loadSnapshotMock,
}));
vi.mock("../hooks/useDocumentTranslationRun", () => ({
  useDocumentTranslationRun: runHookMock,
}));

describe("DocumentWorkbench", () => {
  beforeEach(() => {
    runHookMock.mockReturnValue({
      phase: "idle",
      job: null,
      progress: null,
      errorCode: null,
      start: startRunMock,
      cancel: cancelRunMock,
    });
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
    pickOutputMock.mockResolvedValue("C:\\private\\fixture-translated.docx");
    loadSnapshotMock.mockResolvedValue({
      primary: {
        apiKey: "private-key",
        baseUrl: "https://api.example.com/v1",
        model: "translate-1",
      },
      sourceLang: "auto",
      targetLang: "Chinese",
      customPrompt: "",
      glossary: [],
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

  it("confirms a frozen task without exposing either selected path", async () => {
    render(<DocumentWorkbench labels={translations.en} />);
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentChoose }));
    expect(await screen.findByText("fixture.docx")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: translations.en.documentOutputChoose }));
    expect(await screen.findByText("fixture-translated.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentConfirmTask }));

    expect(await screen.findByText(translations.en.documentPreparedTitle)).toBeInTheDocument();
    expect(screen.getByText("translate-1")).toBeInTheDocument();
    expect(screen.getByText(`${translations.en.autoDetect} → Chinese`)).toBeInTheDocument();
    expect(loadSnapshotMock).toHaveBeenCalledOnce();
    expect(screen.queryByText("C:\\private\\fixture.docx")).not.toBeInTheDocument();
    expect(screen.queryByText("C:\\private\\fixture-translated.docx")).not.toBeInTheDocument();
    expect(screen.queryByText("private-key")).not.toBeInTheDocument();
  });

  it("starts only after explicit confirmation and renders bounded task progress", async () => {
    const view = render(<DocumentWorkbench labels={translations.en} />);
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentChoose }));
    await screen.findByText("fixture.docx");
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentOutputChoose }));
    await screen.findByText("fixture-translated.docx");
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentConfirmTask }));
    await screen.findByText(translations.en.documentPreparedTitle);

    expect(startRunMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentStartTranslation }));
    expect(startRunMock).toHaveBeenCalledOnce();

    runHookMock.mockReturnValue({
      phase: "translating",
      job: null,
      progress: { completed: 2, failed: 1, total: 5, active: 1 },
      errorCode: null,
      start: startRunMock,
      cancel: cancelRunMock,
    });
    view.rerender(<DocumentWorkbench labels={translations.en} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Completed 2 of 5 · Failed 1 · Active 1",
    );
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentCancelTranslation }));
    expect(cancelRunMock).toHaveBeenCalledOnce();
  });

  it("shows a localized configuration error without leaking its message", async () => {
    loadSnapshotMock.mockRejectedValue(
      new TranslationRequestError("missing-api-key", "private API configuration"),
    );
    render(<DocumentWorkbench labels={translations.en} />);
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentChoose }));
    expect(await screen.findByText("fixture.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentOutputChoose }));
    expect(await screen.findByText("fixture-translated.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentConfirmTask }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      translations.en["documentPreparationError_missing-api-key"],
    );
    expect(screen.queryByText(/private API/iu)).not.toBeInTheDocument();
  });
});
