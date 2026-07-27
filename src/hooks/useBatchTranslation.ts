import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ComparisonSideState,
  startTranslationComparisonTask,
  startTranslationTask,
  translateStreaming,
  TranslationComparisonResult,
  TranslationComparisonTask,
  TranslationTask,
  TranslationTaskState,
} from "../services/api";

interface UseBatchTranslationOptions {
  sourceLang: string;
  targetLang: string;
  onCompleted?: () => void;
}

export function combineComparisonResults(result: TranslationComparisonResult): {
  text: string;
  model: string;
} {
  const entries = [result.primary, result.backup].filter(
    (entry): entry is NonNullable<typeof entry> => Boolean(entry),
  );
  return {
    text: entries.map((entry) => `[${entry.model}]\n${entry.text}`).join("\n\n"),
    model: entries.map((entry) => entry.model).join(" vs "),
  };
}

export function useBatchTranslation({
  sourceLang,
  targetLang,
  onCompleted,
}: UseBatchTranslationOptions) {
  const [batchInput, setBatchInput] = useState("");
  const [batchOutput, setBatchOutput] = useState("");
  const [batchOutputBackup, setBatchOutputBackup] = useState("");
  const [compareMode, setCompareMode] = useState(false);
  const [batchBackTranslation, setBatchBackTranslation] = useState("");
  const [isBatchBackTranslating, setIsBatchBackTranslating] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [batchTaskState, setBatchTaskState] = useState<TranslationTaskState>({
    requestId: "",
    phase: "idle",
  });
  const [primaryComparisonState, setPrimaryComparisonState] =
    useState<ComparisonSideState | null>(null);
  const [backupComparisonState, setBackupComparisonState] =
    useState<ComparisonSideState | null>(null);
  const batchTaskRef = useRef<TranslationTask | null>(null);
  const comparisonTaskRef = useRef<TranslationComparisonTask | null>(null);
  const activeBatchRequestIdRef = useRef("");
  const activeComparisonRequestIdRef = useRef("");
  const mountedRef = useRef(true);
  const onCompletedRef = useRef(onCompleted);

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeBatchRequestIdRef.current = "";
      activeComparisonRequestIdRef.current = "";
      batchTaskRef.current?.cancel();
      comparisonTaskRef.current?.cancel();
    };
  }, []);

  const startBatchTranslation = useCallback(() => {
    if (!batchInput || isTranslating) return;
    batchTaskRef.current?.cancel();
    comparisonTaskRef.current?.cancel();
    activeComparisonRequestIdRef.current = "";
    setBatchOutput("");
    setIsTranslating(true);
    const sourceText = batchInput;
    const task = startTranslationTask(sourceText, {
      onState: (nextState) => {
        if (
          mountedRef.current &&
          activeBatchRequestIdRef.current === nextState.requestId
        ) {
          setBatchTaskState(nextState);
        }
      },
      onText: (nextText, requestId) => {
        if (
          mountedRef.current &&
          activeBatchRequestIdRef.current === requestId
        ) {
          setBatchOutput(nextText);
        }
      },
    });
    batchTaskRef.current = task;
    activeBatchRequestIdRef.current = task.id;
    setBatchTaskState({ requestId: task.id, phase: "loading-config" });

    void task.done.then((completion) => {
      if (
        !mountedRef.current ||
        activeBatchRequestIdRef.current !== task.id
      ) {
        return;
      }
      setIsTranslating(false);
      onCompletedRef.current?.();
      if (completion.status === "success") {
        void invoke("save_translation", {
          sourceText,
          translatedText: completion.result.text,
          sourceLang,
          targetLang,
          model: completion.result.model,
        }).catch(console.error);
      }
    });
  }, [batchInput, isTranslating, sourceLang, targetLang]);

  const startCompareTranslation = useCallback(() => {
    if (!batchInput || isTranslating) return;
    comparisonTaskRef.current?.cancel();
    batchTaskRef.current?.cancel();
    activeBatchRequestIdRef.current = "";
    setBatchOutput("");
    setBatchOutputBackup("");
    setPrimaryComparisonState(null);
    setBackupComparisonState(null);
    setIsTranslating(true);
    const sourceText = batchInput;
    const task = startTranslationComparisonTask(sourceText, {
      onText: (side, nextText, requestId) => {
        if (
          !mountedRef.current ||
          activeComparisonRequestIdRef.current !== requestId
        ) {
          return;
        }
        if (side === "primary") setBatchOutput(nextText);
        else setBatchOutputBackup(nextText);
      },
      onSideState: (nextState) => {
        if (
          !mountedRef.current ||
          activeComparisonRequestIdRef.current !== nextState.requestId
        ) {
          return;
        }
        if (nextState.side === "primary") {
          setPrimaryComparisonState(nextState);
        } else {
          setBackupComparisonState(nextState);
        }
      },
    });
    comparisonTaskRef.current = task;
    activeComparisonRequestIdRef.current = task.id;

    void task.done.then((completion) => {
      if (
        !mountedRef.current ||
        activeComparisonRequestIdRef.current !== task.id
      ) {
        return;
      }
      setIsTranslating(false);
      onCompletedRef.current?.();
      if (completion.status !== "success") return;
      const combined = combineComparisonResults(completion.result);
      if (combined.text) {
        void invoke("save_translation", {
          sourceText,
          translatedText: combined.text,
          sourceLang,
          targetLang,
          model: combined.model,
        }).catch(console.error);
      }
    });
  }, [batchInput, isTranslating, sourceLang, targetLang]);

  const startBatchBackTranslate = useCallback(async () => {
    if (!batchOutput || isBatchBackTranslating) return;
    setIsBatchBackTranslating(true);
    setBatchBackTranslation("");
    await translateStreaming(
      batchOutput,
      (chunk) => {
        if (mountedRef.current) {
          setBatchBackTranslation((previous) => previous + chunk);
        }
      },
      () => {
        if (mountedRef.current) setIsBatchBackTranslating(false);
      },
    );
  }, [batchOutput, isBatchBackTranslating]);

  const cancelBatchWork = useCallback(() => {
    if (compareMode) comparisonTaskRef.current?.cancel();
    else batchTaskRef.current?.cancel();
  }, [compareMode]);

  const setCompareModeEnabled = useCallback((enabled: boolean) => {
    setCompareMode(enabled);
    setBatchOutput("");
    setBatchOutputBackup("");
    setBatchBackTranslation("");
  }, []);

  return {
    batchInput,
    setBatchInput,
    batchOutput,
    batchOutputBackup,
    compareMode,
    setCompareModeEnabled,
    batchBackTranslation,
    isBatchBackTranslating,
    isTranslating,
    batchTaskState,
    primaryComparisonState,
    backupComparisonState,
    startBatchTranslation,
    startCompareTranslation,
    startBatchBackTranslate,
    cancelBatchWork,
  };
}
