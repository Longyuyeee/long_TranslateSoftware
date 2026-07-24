import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";

import type { UpdatePhase } from "../components/UpdateDialog";
import { calculateUpdateProgress } from "../services/updater";

type ToastKind = "success" | "warning" | "error";

interface UpdaterLabels {
  updateNotConfigured: string;
  newVersion: string;
  upToDate: string;
  updateCheckFailed: string;
  updateInstallFailed: string;
}

interface UseUpdaterOptions {
  labels: UpdaterLabels;
  addNotification: (message: string) => void;
  showToast: (kind: ToastKind, message: string) => void;
  automaticCheckDelay?: number;
}

export function useUpdater({
  labels,
  addNotification,
  showToast,
  automaticCheckDelay = 8000,
}: UseUpdaterOptions) {
  const [isChecking, setIsChecking] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("available");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const checkingRef = useRef(false);
  const callbacksRef = useRef({ labels, addNotification, showToast });

  useEffect(() => {
    callbacksRef.current = { labels, addNotification, showToast };
  }, [labels, addNotification, showToast]);

  const checkForUpdate = useCallback(async (manual = true) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setIsChecking(true);

    const callbacks = callbacksRef.current;
    try {
      if (!(await invoke<boolean>("updater_configured"))) {
        if (manual) {
          callbacks.showToast("warning", callbacks.labels.updateNotConfigured);
          callbacks.addNotification(callbacks.labels.updateNotConfigured);
        }
        return;
      }

      const update = await check({ timeout: 15000 });
      if (update) {
        setPendingUpdate(update);
        setPhase("available");
        setProgress(null);
        setError("");
        setDialogOpen(true);
        callbacks.addNotification(
          callbacks.labels.newVersion.replace("{version}", update.version),
        );
      } else if (manual) {
        callbacks.showToast("success", callbacks.labels.upToDate);
        callbacks.addNotification(callbacks.labels.upToDate);
      }
    } catch (cause) {
      console.error("Update check failed", cause);
      if (manual) {
        callbacks.showToast("error", callbacks.labels.updateCheckFailed);
        callbacks.addNotification(callbacks.labels.updateCheckFailed);
      }
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  }, []);

  const installUpdate = async () => {
    if (!pendingUpdate || phase === "downloading" || phase === "installing") return;

    setPhase("downloading");
    setProgress(0);
    setError("");
    let downloaded = 0;
    let total: number | undefined;

    try {
      await pendingUpdate.downloadAndInstall(
        event => {
          if (event.event === "Started") {
            total = event.data.contentLength;
            setProgress(total ? 0 : null);
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            setProgress(calculateUpdateProgress(downloaded, total));
          } else if (event.event === "Finished") {
            setProgress(100);
            setPhase("installing");
          }
        },
        { timeout: 120000 },
      );
      await relaunch();
    } catch (cause) {
      console.error("Update installation failed", cause);
      setPhase("error");
      setError(callbacksRef.current.labels.updateInstallFailed);
    }
  };

  const dismissUpdate = () => {
    if (phase === "downloading" || phase === "installing") return;
    setDialogOpen(false);
    pendingUpdate?.close().catch(() => {});
    setPendingUpdate(null);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForUpdate(false);
    }, automaticCheckDelay);
    return () => window.clearTimeout(timer);
  }, [automaticCheckDelay, checkForUpdate]);

  return {
    isChecking,
    pendingUpdate,
    dialogOpen,
    phase,
    progress,
    error,
    checkForUpdate,
    installUpdate,
    dismissUpdate,
  };
}
