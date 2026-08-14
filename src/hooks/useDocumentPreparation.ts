import { useCallback, useEffect, useRef, useState } from "react";
import { parseCommandError } from "../services/commandErrors";
import {
  createReadyDocumentJob,
  pickDocxOutput,
  type DocxInspection,
  type DocumentOutputMode,
} from "../services/documentTranslation";
import {
  createRequestId,
  loadTranslationExecutionSnapshot,
} from "../services/translationTask";
import { normalizeTranslationError } from "../services/translationProvider";
import type { PreparedDocumentTask } from "../services/documentTranslationRuntime";

export type DocumentPreparationPhase =
  | "idle"
  | "selecting-output"
  | "preparing"
  | "prepared"
  | "error";

export type DocumentPreparationErrorCode =
  | "output-invalid"
  | "missing-api-key"
  | "invalid-task"
  | "unknown";

interface DocumentPreparationState {
  phase: DocumentPreparationPhase;
  outputMode: DocumentOutputMode;
  outputPath: string | null;
  preparedTask: PreparedDocumentTask | null;
  errorCode: DocumentPreparationErrorCode | null;
}

interface UseDocumentPreparationOptions {
  inspection: DocxInspection | null;
  sourcePath: string | null;
  pickerTitle: string;
  pickerFilterName: string;
}

export function documentOutputFileName(
  fileName: string,
  outputMode: DocumentOutputMode,
): string {
  const stem = fileName.replace(/\.docx$/iu, "").trim() || "document";
  const boundedStem = [...stem].slice(0, 100).join("");
  const suffix = outputMode === "translated" ? "translated" : "bilingual";
  return `${boundedStem}-${suffix}.docx`;
}

function preparationErrorCode(error: unknown): DocumentPreparationErrorCode {
  if (parseCommandError(error)?.code === "invalid-plan") return "output-invalid";
  if (normalizeTranslationError(error).code === "missing-api-key") {
    return "missing-api-key";
  }
  if (error instanceof Error && error.name === "DocumentContractError") {
    return "invalid-task";
  }
  return "unknown";
}

export function useDocumentPreparation({
  inspection,
  sourcePath,
  pickerTitle,
  pickerFilterName,
}: UseDocumentPreparationOptions) {
  const [state, setState] = useState<DocumentPreparationState>({
    phase: "idle",
    outputMode: "translated",
    outputPath: null,
    preparedTask: null,
    errorCode: null,
  });
  const stateRef = useRef(state);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    busyRef.current = false;
    setState(current => ({
      ...current,
      phase: "idle",
      outputPath: null,
      preparedTask: null,
      errorCode: null,
    }));
  }, [inspection?.fingerprint, sourcePath]);

  const setOutputMode = useCallback((outputMode: DocumentOutputMode) => {
    if (busyRef.current) return;
    generationRef.current += 1;
    setState(current => ({
      ...current,
      phase: "idle",
      outputMode,
      outputPath: null,
      preparedTask: null,
      errorCode: null,
    }));
  }, []);

  const chooseOutput = useCallback(async () => {
    if (!inspection || !sourcePath || busyRef.current) return;
    busyRef.current = true;
    const generation = generationRef.current;
    const previous = stateRef.current;
    setState(current => ({
      ...current,
      phase: "selecting-output",
      errorCode: null,
    }));
    try {
      const outputPath = await pickDocxOutput(
        sourcePath,
        documentOutputFileName(inspection.fileName, previous.outputMode),
        pickerTitle,
        pickerFilterName,
      );
      if (!mountedRef.current || generationRef.current !== generation) return;
      if (!outputPath) {
        setState({ ...previous, errorCode: null });
        return;
      }
      setState(current => ({
        ...current,
        phase: "idle",
        outputPath,
        preparedTask: null,
        errorCode: null,
      }));
    } catch (error) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setState({
        ...previous,
        phase: "error",
        errorCode: preparationErrorCode(error),
      });
    } finally {
      if (generationRef.current === generation) busyRef.current = false;
    }
  }, [inspection, pickerFilterName, pickerTitle, sourcePath]);

  const confirmTask = useCallback(async () => {
    const current = stateRef.current;
    if (!inspection || !sourcePath || !current.outputPath || busyRef.current) return;
    busyRef.current = true;
    const generation = generationRef.current;
    setState(value => ({ ...value, phase: "preparing", errorCode: null }));
    try {
      const execution = await loadTranslationExecutionSnapshot();
      if (!mountedRef.current || generationRef.current !== generation) return;
      const createdAt = new Date().toISOString();
      const job = createReadyDocumentJob({
        id: `document-${createRequestId()}`,
        sourcePath,
        outputPath: current.outputPath,
        outputMode: current.outputMode,
        inspection,
        execution,
        createdAt,
      });
      setState(value => ({
        ...value,
        phase: "prepared",
        preparedTask: { job, execution },
        errorCode: null,
      }));
    } catch (error) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setState(value => ({
        ...value,
        phase: "error",
        preparedTask: null,
        errorCode: preparationErrorCode(error),
      }));
    } finally {
      if (generationRef.current === generation) busyRef.current = false;
    }
  }, [inspection, sourcePath]);

  return {
    ...state,
    isBusy: state.phase === "selecting-output" || state.phase === "preparing",
    setOutputMode,
    chooseOutput,
    confirmTask,
  };
}
