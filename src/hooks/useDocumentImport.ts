import { useCallback, useEffect, useRef, useState } from "react";
import { parseCommandError } from "../services/commandErrors";
import {
  inspectDocxDocument,
  pickDocxDocument,
  type DocxImportCommandError,
  type DocxInspection,
} from "../services/documentTranslation";

export type DocumentImportPhase =
  | "idle"
  | "selecting"
  | "inspecting"
  | "ready"
  | "error";

export type DocumentImportErrorCode = DocxImportCommandError["code"] | "unknown";

export interface DocumentImportState {
  phase: DocumentImportPhase;
  inspection: DocxInspection | null;
  sourcePath: string | null;
  errorCode: DocumentImportErrorCode | null;
}

const IMPORT_ERROR_CODES: readonly DocumentImportErrorCode[] = [
  "unsupported-format",
  "input-too-large",
  "invalid-input",
  "parse-failed",
];

function importErrorCode(error: unknown): DocumentImportErrorCode {
  const code = parseCommandError(error)?.code;
  return IMPORT_ERROR_CODES.includes(code as DocumentImportErrorCode)
    ? code as DocumentImportErrorCode
    : "unknown";
}

export function useDocumentImport(pickerLabels: {
  title: string;
  filterName: string;
}) {
  const [state, setState] = useState<DocumentImportState>({
    phase: "idle",
    inspection: null,
    sourcePath: null,
    errorCode: null,
  });
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const chooseDocument = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const previous = stateRef.current;
    setState(current => ({ ...current, phase: "selecting", errorCode: null }));
    try {
      const sourcePath = await pickDocxDocument(
        pickerLabels.title,
        pickerLabels.filterName,
      );
      if (!mountedRef.current) return;
      if (!sourcePath) {
        setState({ ...previous, errorCode: null });
        return;
      }
      setState(current => ({
        ...current,
        phase: "inspecting",
        sourcePath,
        errorCode: null,
      }));
      const inspection = await inspectDocxDocument(sourcePath);
      if (!mountedRef.current) return;
      setState({ phase: "ready", inspection, sourcePath, errorCode: null });
    } catch (error) {
      if (!mountedRef.current) return;
      setState({
        phase: "error",
        inspection: previous.inspection,
        sourcePath: previous.sourcePath,
        errorCode: importErrorCode(error),
      });
    } finally {
      busyRef.current = false;
    }
  }, [pickerLabels.filterName, pickerLabels.title]);

  return {
    ...state,
    isBusy: state.phase === "selecting" || state.phase === "inspecting",
    chooseDocument,
  };
}
