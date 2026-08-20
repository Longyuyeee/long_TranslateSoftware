// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePdfImport } from "./usePdfImport";

const { inspectMock, pickMock } = vi.hoisted(() => ({
  inspectMock: vi.fn(),
  pickMock: vi.fn(),
}));

vi.mock("../services/documentTranslation", () => ({
  inspectPdfDocument: inspectMock,
  pickPdfDocument: pickMock,
}));

const inspection = {
  fingerprint: "sha256:fixture",
  fileName: "fixture.pdf",
  sizeBytes: 4096,
  pageCount: 2,
  warnings: [],
  segments: [],
};

const pickerLabels = {
  title: "Choose a PDF document",
  filterName: "PDF document (*.pdf)",
};

describe("usePdfImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects and inspects one PDF while suppressing duplicate actions", async () => {
    let resolvePick: (path: string) => void = () => undefined;
    pickMock.mockReturnValue(new Promise<string>(resolve => {
      resolvePick = resolve;
    }));
    inspectMock.mockResolvedValue(inspection);
    const { result } = renderHook(() => usePdfImport(pickerLabels));

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.choosePdf();
      void result.current.choosePdf();
      resolvePick("C:\\docs\\fixture.pdf");
      await first;
    });

    expect(pickMock).toHaveBeenCalledOnce();
    expect(inspectMock).toHaveBeenCalledWith("C:\\docs\\fixture.pdf");
    expect(result.current).toMatchObject({
      phase: "ready",
      inspection,
      sourcePath: "C:\\docs\\fixture.pdf",
      errorCode: null,
    });
  });

  it("keeps the previous result when the picker is cancelled", async () => {
    pickMock.mockResolvedValueOnce("C:\\docs\\fixture.pdf").mockResolvedValueOnce(null);
    inspectMock.mockResolvedValue(inspection);
    const { result } = renderHook(() => usePdfImport(pickerLabels));

    await act(() => result.current.choosePdf());
    await act(() => result.current.choosePdf());

    expect(result.current.phase).toBe("ready");
    expect(result.current.inspection).toEqual(inspection);
  });

  it("retains only allow-listed PDF errors without exposing backend details", async () => {
    pickMock.mockResolvedValue("C:\\private\\protected.pdf");
    inspectMock.mockRejectedValue({
      code: "encrypted-pdf",
      message: "C:\\private\\protected.pdf used a secret password",
    });
    const { result } = renderHook(() => usePdfImport(pickerLabels));

    await act(() => result.current.choosePdf());

    expect(result.current.phase).toBe("error");
    expect(result.current.errorCode).toBe("encrypted-pdf");
    expect(result.current).not.toHaveProperty("message");
  });
});
