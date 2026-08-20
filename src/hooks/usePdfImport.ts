import { useCallback, useEffect, useRef, useState } from "react";
import { parseCommandError } from "../services/commandErrors";
import {
  inspectPdfDocument,
  pickPdfDocument,
  type PdfImportCommandError,
  type PdfInspection,
} from "../services/documentTranslation";

export type PdfImportPhase =
  | "idle"
  | "selecting"
  | "inspecting"
  | "ready"
  | "error";

export type PdfImportErrorCode = PdfImportCommandError["code"] | "unknown";

const PDF_IMPORT_ERROR_CODES: readonly PdfImportErrorCode[] = [
  "unsupported-format",
  "input-too-large",
  "invalid-input",
  "encrypted-pdf",
  "text-layer-required",
  "parse-failed",
];

function pdfImportErrorCode(error: unknown): PdfImportErrorCode {
  const code = parseCommandError(error)?.code;
  return PDF_IMPORT_ERROR_CODES.includes(code as PdfImportErrorCode)
    ? code as PdfImportErrorCode
    : "unknown";
}

export function usePdfImport(pickerLabels: {
  title: string;
  filterName: string;
}) {
  const [phase, setPhase] = useState<PdfImportPhase>("idle");
  const [inspection, setInspection] = useState<PdfInspection | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<PdfImportErrorCode | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const previousRef = useRef({ inspection, sourcePath, phase });
  previousRef.current = { inspection, sourcePath, phase };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const choosePdf = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const previous = previousRef.current;
    setPhase("selecting");
    setErrorCode(null);
    try {
      const path = await pickPdfDocument(pickerLabels.title, pickerLabels.filterName);
      if (!mountedRef.current) return;
      if (!path) {
        setPhase(previous.phase);
        return;
      }
      setPhase("inspecting");
      setSourcePath(path);
      const result = await inspectPdfDocument(path);
      if (!mountedRef.current) return;
      setInspection(result);
      setSourcePath(path);
      setPhase("ready");
    } catch (error) {
      if (!mountedRef.current) return;
      setInspection(previous.inspection);
      setSourcePath(previous.sourcePath);
      setErrorCode(pdfImportErrorCode(error));
      setPhase("error");
    } finally {
      busyRef.current = false;
    }
  }, [pickerLabels.filterName, pickerLabels.title]);

  return {
    phase,
    inspection,
    sourcePath,
    errorCode,
    isBusy: phase === "selecting" || phase === "inspecting",
    choosePdf,
  };
}
