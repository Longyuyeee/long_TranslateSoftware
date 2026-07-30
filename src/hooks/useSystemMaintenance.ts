import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { isCommandError } from "../services/commandErrors";

export type AutoLaunchToggleResult =
  | "success"
  | "denied"
  | "failed"
  | "busy"
  | "ignored";
export type DiagnosticsExportResult =
  | { status: "success" | "cancelled" | "busy" | "ignored" }
  | { status: "failed"; error: unknown };

type UseSystemMaintenanceOptions = {
  setAutoLaunch: Dispatch<SetStateAction<boolean>>;
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export function useSystemMaintenance({
  setAutoLaunch,
}: UseSystemMaintenanceOptions) {
  const [cacheSize, setCacheSize] = useState("0 B");
  const [isExportingDiagnostics, setIsExportingDiagnostics] = useState(false);
  const mountedRef = useRef(true);
  const cacheRequestIdRef = useRef(0);
  const togglingAutoLaunchRef = useRef(false);
  const clearingCacheRef = useRef(false);
  const exportingDiagnosticsRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cacheRequestIdRef.current += 1;
    };
  }, []);

  const refreshCacheSize = useCallback(async () => {
    const requestId = ++cacheRequestIdRef.current;
    try {
      const size = await invoke<string>("get_audio_cache_size");
      if (!mountedRef.current || requestId !== cacheRequestIdRef.current) return null;
      setCacheSize(size);
      return size;
    } catch (error) {
      console.error(error);
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshCacheSize();
  }, [refreshCacheSize]);

  const clearCache = useCallback(async () => {
    if (clearingCacheRef.current) return false;
    clearingCacheRef.current = true;
    try {
      await invoke("clear_audio_cache");
      await refreshCacheSize();
      return mountedRef.current;
    } catch (error) {
      console.error(error);
      return false;
    } finally {
      clearingCacheRef.current = false;
    }
  }, [refreshCacheSize]);

  const toggleAutoLaunch = useCallback(async (): Promise<AutoLaunchToggleResult> => {
    if (togglingAutoLaunchRef.current) return "busy";
    togglingAutoLaunchRef.current = true;
    try {
      const currentState = await isEnabled();
      const expectedState = !currentState;
      if (currentState) await disable();
      else await enable();
      await wait(500);
      const enabled = await isEnabled();
      if (!mountedRef.current) return "ignored";
      setAutoLaunch(enabled);
      return enabled === expectedState ? "success" : "denied";
    } catch (error) {
      console.error("Toggle autostart failed:", error);
      if (!mountedRef.current) return "ignored";
      try {
        const enabled = await isEnabled();
        if (mountedRef.current) setAutoLaunch(enabled);
      } catch (stateError) {
        console.error("Unable to refresh autostart state:", stateError);
      }
      return "failed";
    } finally {
      togglingAutoLaunchRef.current = false;
    }
  }, [setAutoLaunch]);

  const exportDiagnostics =
    useCallback(async (): Promise<DiagnosticsExportResult> => {
      if (exportingDiagnosticsRef.current) return { status: "busy" };
      exportingDiagnosticsRef.current = true;
      if (mountedRef.current) setIsExportingDiagnostics(true);
      try {
        await invoke<string>("export_diagnostics");
        if (!mountedRef.current) return { status: "ignored" };
        return { status: "success" };
      } catch (error) {
        if (!mountedRef.current) return { status: "ignored" };
        if (error === "User cancelled" || isCommandError(error, "cancelled")) {
          return { status: "cancelled" };
        }
        return { status: "failed", error };
      } finally {
        exportingDiagnosticsRef.current = false;
        if (mountedRef.current) setIsExportingDiagnostics(false);
      }
    }, []);

  return {
    cacheSize,
    isExportingDiagnostics,
    refreshCacheSize,
    clearCache,
    toggleAutoLaunch,
    exportDiagnostics,
  };
}
