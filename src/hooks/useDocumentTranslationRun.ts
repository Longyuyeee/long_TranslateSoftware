import { useCallback, useSyncExternalStore } from "react";
import {
  documentTranslationRuntime,
  type PreparedDocumentTask,
  type DocumentTranslationRuntime,
} from "../services/documentTranslationRuntime";

export function useDocumentTranslationRun(
  preparedTask: PreparedDocumentTask | null,
  runtime: DocumentTranslationRuntime = documentTranslationRuntime,
) {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const start = useCallback(async () => {
    if (preparedTask) await runtime.start(preparedTask);
  }, [preparedTask, runtime]);
  const cancel = useCallback(() => runtime.cancel(), [runtime]);
  return { ...snapshot, start, cancel };
}
