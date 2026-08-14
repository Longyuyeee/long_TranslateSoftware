import { useCallback, useEffect, useRef, useState } from "react";
import {
  listDocumentCheckpoints,
  loadDocumentCheckpoint,
  type DocumentCheckpoint,
  type DocumentCheckpointSummary,
} from "../services/documentTranslation";
import { documentTranslationRuntime } from "../services/documentTranslationRuntime";
import { loadTranslationExecutionSnapshot } from "../services/translationTask";

export type DocumentRecoveryErrorCode =
  | "checkpoint-invalid"
  | "storage"
  | "missing-api-key"
  | "settings-mismatch"
  | "no-retryable-segments"
  | "unknown";

function recoveryErrorCode(error: unknown): DocumentRecoveryErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === "checkpoint-invalid" || code === "storage") return code;
  }
  return "unknown";
}

function recoveryActionErrorCode(error: unknown): DocumentRecoveryErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === "missing-api-key") return "missing-api-key";
    if (code === "checkpoint-invalid") return "settings-mismatch";
    if (code === "translation-failed") return "no-retryable-segments";
    if (code === "storage") return "storage";
  }
  return "unknown";
}

export function useDocumentRecovery() {
  const [summaries, setSummaries] = useState<DocumentCheckpointSummary[]>([]);
  const [checkpoint, setCheckpoint] = useState<DocumentCheckpoint | null>(null);
  const [isListing, setIsListing] = useState(true);
  const [loadingJobId, setLoadingJobId] = useState<string | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const [errorCode, setErrorCode] = useState<DocumentRecoveryErrorCode | null>(null);
  const [errorSource, setErrorSource] = useState<"discovery" | "action" | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const activeLoad = useRef<string | null>(null);
  const activeResume = useRef(false);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setIsListing(true);
    setErrorCode(null);
    setErrorSource(null);
    try {
      const next = await listDocumentCheckpoints();
      if (mounted.current && requestId.current === currentRequest) setSummaries(next);
    } catch (error) {
      if (mounted.current && requestId.current === currentRequest) {
        setSummaries([]);
        setErrorCode(recoveryErrorCode(error));
        setErrorSource("discovery");
      }
    } finally {
      if (mounted.current && requestId.current === currentRequest) setIsListing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, [refresh]);

  const load = useCallback(async (jobId: string) => {
    if (activeLoad.current !== null) return;
    activeLoad.current = jobId;
    setLoadingJobId(jobId);
    setErrorCode(null);
    setErrorSource(null);
    try {
      const loaded = await loadDocumentCheckpoint(jobId);
      if (mounted.current) setCheckpoint(loaded);
    } catch (error) {
      if (mounted.current) {
        setErrorCode(recoveryErrorCode(error));
        setErrorSource("discovery");
      }
    } finally {
      activeLoad.current = null;
      if (mounted.current) setLoadingJobId(null);
    }
  }, []);

  const resume = useCallback(async () => {
    const loaded = checkpoint;
    if (
      !loaded
      || (loaded.job.phase !== "ready" && loaded.job.phase !== "failed")
      || activeResume.current
    ) return;
    activeResume.current = true;
    setIsResuming(true);
    setErrorCode(null);
    setErrorSource(null);
    try {
      const execution = await loadTranslationExecutionSnapshot();
      const accepted = await documentTranslationRuntime.resume(loaded, execution);
      if (mounted.current && accepted) setCheckpoint(null);
    } catch (error) {
      if (mounted.current) {
        setErrorCode(recoveryActionErrorCode(error));
        setErrorSource("action");
      }
    } finally {
      activeResume.current = false;
      if (mounted.current) setIsResuming(false);
    }
  }, [checkpoint]);

  return {
    summaries,
    checkpoint,
    isListing,
    loadingJobId,
    isResuming,
    errorCode,
    errorSource,
    refresh,
    load,
    resume,
  };
}
