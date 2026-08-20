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
  inspectPdfMock,
  listCheckpointsMock,
  loadCheckpointMock,
  loadSnapshotMock,
  pickMock,
  pickPdfMock,
  pickOutputMock,
  runHookMock,
  resumeRecoveredMock,
  startRunMock,
} = vi.hoisted(() => ({
  cancelRunMock: vi.fn(),
  inspectMock: vi.fn(),
  inspectPdfMock: vi.fn(),
  listCheckpointsMock: vi.fn(),
  loadCheckpointMock: vi.fn(),
  loadSnapshotMock: vi.fn(),
  pickMock: vi.fn(),
  pickPdfMock: vi.fn(),
  pickOutputMock: vi.fn(),
  runHookMock: vi.fn(),
  resumeRecoveredMock: vi.fn(),
  startRunMock: vi.fn(),
}));

vi.mock("../services/documentTranslation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/documentTranslation")>(),
  inspectDocxDocument: inspectMock,
  inspectPdfDocument: inspectPdfMock,
  listDocumentCheckpoints: listCheckpointsMock,
  loadDocumentCheckpoint: loadCheckpointMock,
  pickDocxDocument: pickMock,
  pickPdfDocument: pickPdfMock,
  pickDocxOutput: pickOutputMock,
}));
vi.mock("../services/translationTask", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/translationTask")>(),
  loadTranslationExecutionSnapshot: loadSnapshotMock,
}));
vi.mock("../hooks/useDocumentTranslationRun", () => ({
  useDocumentTranslationRun: runHookMock,
}));
vi.mock("../services/documentTranslationRuntime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/documentTranslationRuntime")>(),
  documentTranslationRuntime: { resume: resumeRecoveredMock },
}));

async function chooseOutputDestination(): Promise<void> {
  const button = await screen.findByRole("button", {
    name: translations.en.documentOutputChoose,
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText("fixture-translated.docx");
}

describe("DocumentWorkbench", () => {
  beforeEach(() => {
    listCheckpointsMock.mockResolvedValue([]);
    resumeRecoveredMock.mockResolvedValue(true);
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
    pickPdfMock.mockResolvedValue("C:\\private\\fixture.pdf");
    inspectPdfMock.mockResolvedValue({
      fingerprint: "sha256:pdf-fixture",
      fileName: "fixture.pdf",
      sizeBytes: 4096,
      pageCount: 2,
      warnings: [{
        code: "reading-order-inferred",
        message: "raw PDF warning",
      }],
      segments: [{
        id: "pdf:2:0",
        order: 0,
        page: 2,
        sourcePosition: "page:2:line:0",
        structure: "paragraph",
        sourceText: "Public PDF body",
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

  it("shows the DOCX preview compatibility boundary", () => {
    render(<DocumentWorkbench labels={translations.en} />);

    expect(screen.getByText(/DOCX preview/iu)).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Word compatibility validation is still pending/iu)).toBeInTheDocument();
  });

  it("discovers and loads a redacted checkpoint without exposing private payloads", async () => {
    listCheckpointsMock.mockResolvedValue([{
      jobId: "job-1",
      fileName: "recover.docx",
      phase: "ready",
      outputMode: "translated",
      completedSegments: 2,
      failedSegments: 0,
      totalSegments: 5,
      updatedAt: "2026-08-14T00:00:00.000Z",
    }]);
    const loadedCheckpoint = {
      schemaVersion: 1,
      job: { id: "job-1", phase: "ready" },
    };
    loadCheckpointMock.mockResolvedValue(loadedCheckpoint);

    render(<DocumentWorkbench labels={translations.en} />);
    expect(await screen.findByText("recover.docx")).toBeInTheDocument();
    expect(screen.getByText("Completed 2 of 5 · Failed 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentRecoveryLoad }));

    expect(await screen.findByText(translations.en.documentRecoveryLoadedTitle)).toBeInTheDocument();
    expect(loadCheckpointMock).toHaveBeenCalledWith("job-1");
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentRecoveryContinue }));
    await waitFor(() => expect(resumeRecoveredMock).toHaveBeenCalledWith(
      loadedCheckpoint,
      expect.objectContaining({ primary: expect.objectContaining({ apiKey: "private-key" }) }),
    ));
    expect(screen.queryByText(/sourcePath|api\.example|private/iu)).not.toBeInTheDocument();
  });

  it("keeps a recovered task intact when current settings do not match", async () => {
    listCheckpointsMock.mockResolvedValue([{
      jobId: "job-1",
      fileName: "recover.docx",
      phase: "failed",
      outputMode: "translated",
      completedSegments: 2,
      failedSegments: 1,
      totalSegments: 3,
      updatedAt: "2026-08-14T00:00:00.000Z",
    }]);
    loadCheckpointMock.mockResolvedValue({
      schemaVersion: 1,
      job: { id: "job-1", phase: "failed" },
    });
    resumeRecoveredMock.mockRejectedValue({
      code: "checkpoint-invalid",
      message: "private model and path mismatch",
    });

    render(<DocumentWorkbench labels={translations.en} />);
    fireEvent.click(await screen.findByRole("button", { name: translations.en.documentRecoveryLoad }));
    fireEvent.click(await screen.findByRole("button", { name: translations.en.documentRecoveryRetryFailed }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      translations.en["documentRecoveryError_settings-mismatch"],
    );
    expect(screen.getByRole("button", { name: translations.en.documentRecoveryRetryFailed })).toBeEnabled();
    expect(screen.queryByText(/private model|path mismatch/iu)).not.toBeInTheDocument();
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

  it("starts a confirmed PDF task explicitly without exposing paths", async () => {
    render(<DocumentWorkbench labels={translations.en} />);

    fireEvent.click(screen.getByRole("button", { name: translations.en.documentFormatPdf }));
    fireEvent.click(screen.getByRole("button", { name: translations.en.pdfChoose }));

    expect(await screen.findByText("fixture.pdf")).toBeInTheDocument();
    expect(screen.getByText("Public PDF body")).toBeInTheDocument();
    expect(screen.getByText(translations.en.pdfPageLabel.replace("{page}", "2"))).toBeInTheDocument();
    expect(screen.getByText(translations.en["pdfWarning_reading-order-inferred"])).toBeInTheDocument();
    expect(screen.getByText(translations.en.documentOutputSetup)).toBeInTheDocument();
    expect(screen.getByText(translations.en.documentRecoveryTitle)).toBeInTheDocument();
    expect(screen.queryByText(/raw PDF warning|C:\\private/iu)).not.toBeInTheDocument();

    await chooseOutputDestination();
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentConfirmTask }));

    expect(await screen.findByText(translations.en.documentPreparedTitle)).toBeInTheDocument();
    const start = screen.getByRole("button", { name: translations.en.documentStartTranslation });
    expect(loadSnapshotMock).toHaveBeenCalledOnce();
    expect(startRunMock).not.toHaveBeenCalled();
    fireEvent.click(start);
    expect(startRunMock).toHaveBeenCalledOnce();
    expect(screen.queryByText(/api\.example|private-key|C:\\private/iu)).not.toBeInTheDocument();
  });

  it("shows a localized encrypted-PDF error without leaking its path", async () => {
    inspectPdfMock.mockRejectedValue({
      code: "encrypted-pdf",
      message: "C:\\private\\protected.pdf requires secret-password",
    });
    render(<DocumentWorkbench labels={translations.en} />);

    fireEvent.click(screen.getByRole("button", { name: translations.en.documentFormatPdf }));
    fireEvent.click(screen.getByRole("button", { name: translations.en.pdfChoose }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      translations.en["pdfImportError_encrypted-pdf"],
    );
    expect(screen.queryByText(/private|secret-password/iu)).not.toBeInTheDocument();
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

    await chooseOutputDestination();
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
    await chooseOutputDestination();
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
    await chooseOutputDestination();
    fireEvent.click(screen.getByRole("button", { name: translations.en.documentConfirmTask }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      translations.en["documentPreparationError_missing-api-key"],
    );
    expect(screen.queryByText(/private API/iu)).not.toBeInTheDocument();
  });
});
