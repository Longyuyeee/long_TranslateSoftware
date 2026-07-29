import { useCallback, useEffect, useRef, useState } from "react";
import {
  addGlossaryEntry,
  deleteGlossaryEntry,
  type GlossaryEntry,
  listGlossaryEntries,
  updateGlossaryEntry,
} from "../services/glossary";

export function useGlossary() {
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [hasError, setHasError] = useState(false);
  const mountedRef = useRef(true);
  const mutatingRef = useRef(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setHasError(false);
    try {
      const nextEntries = await listGlossaryEntries();
      if (mountedRef.current && requestId === requestIdRef.current) {
        setEntries(nextEntries);
      }
    } catch (error) {
      console.error("Failed to load glossary", error);
      if (mountedRef.current && requestId === requestIdRef.current) {
        setHasError(true);
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(async (operation: () => Promise<void>) => {
    if (mutatingRef.current) return false;
    mutatingRef.current = true;
    setIsMutating(true);
    setHasError(false);
    try {
      await operation();
      await load();
      return true;
    } catch (error) {
      console.error("Failed to update glossary", error);
      if (mountedRef.current) setHasError(true);
      return false;
    } finally {
      mutatingRef.current = false;
      if (mountedRef.current) setIsMutating(false);
    }
  }, [load]);

  const add = useCallback(
    (sourceTerm: string, targetTerm: string) =>
      mutate(() => addGlossaryEntry(sourceTerm, targetTerm)),
    [mutate],
  );
  const update = useCallback(
    (id: number, sourceTerm: string, targetTerm: string) =>
      mutate(() => updateGlossaryEntry(id, sourceTerm, targetTerm)),
    [mutate],
  );
  const remove = useCallback(
    (id: number) => mutate(() => deleteGlossaryEntry(id)),
    [mutate],
  );

  return {
    entries,
    isLoading,
    isMutating,
    hasError,
    load,
    add,
    update,
    remove,
  };
}
