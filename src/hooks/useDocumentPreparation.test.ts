// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentOutputFileName,
  useDocumentPreparation,
} from "./useDocumentPreparation";
import { TranslationRequestError } from "../services/translationProvider";

const { createJobMock, loadSnapshotMock, pickOutputMock } = vi.hoisted(() => ({
  createJobMock: vi.fn(),
  loadSnapshotMock: vi.fn(),
  pickOutputMock: vi.fn(),
}));

vi.mock("../services/documentTranslation", () => ({
  createReadyDocumentJob: createJobMock,
  pickDocxOutput: pickOutputMock,
}));
vi.mock("../services/translationTask", () => ({
  createRequestId: () => "fixture-id",
  loadTranslationExecutionSnapshot: loadSnapshotMock,
}));

const inspection = {
  fingerprint: "sha256:fixture",
  fileName: "fixture.docx",
  sizeBytes: 2048,
  warnings: [],
  segments: [],
};
const options = {
  format: "docx" as const,
  inspection,
  sourcePath: "C:\\private\\fixture.docx",
  pickerTitle: "Choose output",
  pickerFilterName: "Word document (*.docx)",
};
const execution = {
  primary: { apiKey: "secret", baseUrl: "https://api.example.com/v1", model: "model" },
  sourceLang: "auto",
  targetLang: "Chinese",
  customPrompt: "",
  glossary: [],
};

describe("useDocumentPreparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSnapshotMock.mockResolvedValue(execution);
    createJobMock.mockReturnValue({ id: "document-fixture-id", phase: "ready" });
  });

  it("bounds suggested names and changes the output suffix by mode", () => {
    expect(documentOutputFileName("report.docx", "translated"))
      .toBe("report-translated.docx");
    expect(documentOutputFileName("REPORT.DOCX", "bilingual"))
      .toBe("REPORT-bilingual.docx");
    expect(documentOutputFileName("brief.PDF", "translated"))
      .toBe("brief-translated.docx");
    expect([...documentOutputFileName("x".repeat(300) + ".docx", "translated")].length)
      .toBeLessThanOrEqual(116);
  });

  it("selects a target once and freezes one validated task without starting work", async () => {
    pickOutputMock.mockResolvedValue("C:\\private\\fixture-translated.docx");
    const { result } = renderHook(() => useDocumentPreparation(options));

    await act(() => result.current.chooseOutput());
    await act(() => result.current.confirmTask());

    expect(pickOutputMock).toHaveBeenCalledWith(
      options.sourcePath,
      "fixture-translated.docx",
      options.pickerTitle,
      options.pickerFilterName,
    );
    expect(loadSnapshotMock).toHaveBeenCalledOnce();
    expect(createJobMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "document-fixture-id",
      format: "docx",
      sourcePath: options.sourcePath,
      outputPath: "C:\\private\\fixture-translated.docx",
      outputMode: "translated",
      inspection,
      execution,
    }));
    expect(result.current.phase).toBe("prepared");
  });

  it("invalidates the target and prepared task when output mode changes", async () => {
    pickOutputMock.mockResolvedValue("C:\\private\\fixture-translated.docx");
    const { result } = renderHook(() => useDocumentPreparation(options));
    await act(() => result.current.chooseOutput());
    await act(() => result.current.confirmTask());

    act(() => result.current.setOutputMode("bilingual"));

    expect(result.current.outputMode).toBe("bilingual");
    expect(result.current.outputPath).toBeNull();
    expect(result.current.preparedTask).toBeNull();
  });

  it("suppresses duplicate output pickers while one is active", async () => {
    let resolveOutput: (value: null) => void = () => undefined;
    pickOutputMock.mockReturnValue(new Promise<null>(resolve => {
      resolveOutput = resolve;
    }));
    const { result } = renderHook(() => useDocumentPreparation(options));

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.chooseOutput();
      void result.current.chooseOutput();
      resolveOutput(null);
      await first;
    });

    expect(pickOutputMock).toHaveBeenCalledOnce();
  });

  it("invalidates a prepared task when the inspected source changes", async () => {
    pickOutputMock.mockResolvedValue("C:\\private\\fixture-translated.docx");
    const { result, rerender } = renderHook(
      ({ fingerprint, sourcePath }) => useDocumentPreparation({
        ...options,
        inspection: { ...inspection, fingerprint },
        sourcePath,
      }),
      {
        initialProps: {
          fingerprint: inspection.fingerprint,
          sourcePath: options.sourcePath,
        },
      },
    );
    await act(() => result.current.chooseOutput());
    await act(() => result.current.confirmTask());

    rerender({
      fingerprint: "sha256:replacement",
      sourcePath: "C:\\private\\replacement.docx",
    });

    expect(result.current.outputPath).toBeNull();
    expect(result.current.preparedTask).toBeNull();
  });

  it("keeps picker cancellation non-fatal and localizes only stable error categories", async () => {
    pickOutputMock.mockResolvedValueOnce(null).mockRejectedValueOnce({
      code: "invalid-plan",
      message: "C:\\private\\secret.docx already exists",
    });
    const { result } = renderHook(() => useDocumentPreparation(options));

    await act(() => result.current.chooseOutput());
    expect(result.current.errorCode).toBeNull();
    await act(() => result.current.chooseOutput());
    expect(result.current.errorCode).toBe("output-invalid");
    expect(result.current).not.toHaveProperty("message");
  });

  it("reports a missing API key without creating a job", async () => {
    pickOutputMock.mockResolvedValue("C:\\private\\fixture-translated.docx");
    loadSnapshotMock.mockRejectedValue(
      new TranslationRequestError("missing-api-key", "private config"),
    );
    const { result } = renderHook(() => useDocumentPreparation(options));
    await act(() => result.current.chooseOutput());
    await act(() => result.current.confirmTask());

    expect(result.current.errorCode).toBe("missing-api-key");
    expect(createJobMock).not.toHaveBeenCalled();
  });
});
