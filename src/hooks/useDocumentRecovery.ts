import { useCallback, useEffect, useRef, useState } from "react";
import {
  listDocumentCheckpoints,
  loadDocumentCheckpoint,
  type DocumentCheckpoint,
  type DocumentCheckpointSummary,
} from "../services/documentTranslation";

export type DocumentRecoveryErrorCode = "checkpoint-invalid" | "storage" | "unknown";

function recoveryErrorCode(error: unknown): DocumentRecoveryErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === "checkpoint-invalid" || code === "storage") return code;
  }
  return "unknown";
}

export function useDocumentRecovery() {
  const [summaries, setSummaries] = useState<DocumentCheckpointSummary[]>([]);
  const [checkpoint, setCheckpoint] = useState<DocumentCheckpoint | null>(null);
  const [isListing, setIsListing] = useState(true);
  const [loadingJobId, setLoadingJobId] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<DocumentRecoveryErrorCode | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const activeLoad = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setIsListing(true);
    setErrorCode(null);
    try {
      const next = await listDocumentCheckpoints();
      if (mounted.current && requestId.current === currentRequest) setSummaries(next);
    } catch (error) {
      if (mounted.current && requestId.current === currentRequest) {
        setSummaries([]);
        setErrorCode(recoveryErrorCode(error));
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
    try {
      const loaded = await loadDocumentCheckpoint(jobId);
      if (mounted.current) setCheckpoint(loaded);
    } catch (error) {
      if (mounted.current) setErrorCode(recoveryErrorCode(error));
    } finally {
      activeLoad.current = null;
      if (mounted.current) setLoadingJobId(null);
    }
  }, []);

  return { summaries, checkpoint, isListing, loadingJobId, errorCode, refresh, load };
}
