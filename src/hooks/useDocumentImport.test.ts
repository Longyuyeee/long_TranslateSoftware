// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentImport } from "./useDocumentImport";

const { inspectMock, pickMock } = vi.hoisted(() => ({
  inspectMock: vi.fn(),
  pickMock: vi.fn(),
}));

vi.mock("../services/documentTranslation", () => ({
  inspectDocxDocument: inspectMock,
  pickDocxDocument: pickMock,
}));

const inspection = {
  fingerprint: "sha256:fixture",
  fileName: "fixture.docx",
  sizeBytes: 2048,
  warnings: [],
  segments: [],
};

const pickerLabels = {
  title: "Choose a DOCX document",
  filterName: "Word document (*.docx)",
};

describe("useDocumentImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects and inspects one DOCX while suppressing duplicate actions", async () => {
    let resolvePick: (path: string) => void = () => undefined;
    pickMock.mockReturnValue(new Promise<string>(resolve => {
      resolvePick = resolve;
    }));
    inspectMock.mockResolvedValue(inspection);
    const { result } = renderHook(() => useDocumentImport(pickerLabels));

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.chooseDocument();
      void result.current.chooseDocument();
      resolvePick("C:\\docs\\fixture.docx");
      await first;
    });

    expect(pickMock).toHaveBeenCalledOnce();
    expect(pickMock).toHaveBeenCalledWith(
      pickerLabels.title,
      pickerLabels.filterName,
    );
    expect(inspectMock).toHaveBeenCalledWith("C:\\docs\\fixture.docx");
    expect(result.current).toMatchObject({
      phase: "ready",
      inspection,
      sourcePath: "C:\\docs\\fixture.docx",
      errorCode: null,
    });
  });

  it("treats picker cancellation as a non-error", async () => {
    pickMock.mockResolvedValue(null);
    const { result } = renderHook(() => useDocumentImport(pickerLabels));

    await act(() => result.current.chooseDocument());

    expect(inspectMock).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.errorCode).toBeNull();
  });

  it("keeps only an allow-listed error code", async () => {
    pickMock.mockResolvedValue("C:\\docs\\fixture.docx");
    inspectMock.mockRejectedValue({
      code: "invalid-input",
      message: "private path must not be shown",
    });
    const { result } = renderHook(() => useDocumentImport(pickerLabels));

    await act(() => result.current.chooseDocument());

    expect(result.current.phase).toBe("error");
    expect(result.current.errorCode).toBe("invalid-input");
    expect(result.current).not.toHaveProperty("message");
  });
});
