import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  shortcutFromKeyboardEvent,
  ShortcutAction,
} from "../services/system";

type ShortcutUpdateResult =
  | { status: "success"; action: ShortcutAction; shortcut: string }
  | { status: "failed"; action: ShortcutAction; error: unknown };

type UseShortcutRecorderOptions = {
  onUpdated: (action: ShortcutAction, shortcut: string) => void;
  onResult: (result: ShortcutUpdateResult) => void;
};

export function useShortcutRecorder({
  onUpdated,
  onResult,
}: UseShortcutRecorderOptions) {
  const [recordingKey, setRecordingKey] = useState<ShortcutAction | null>(null);
  const mountedRef = useRef(true);
  const updateRequestIdRef = useRef(0);
  const onUpdatedRef = useRef(onUpdated);
  const onResultRef = useRef(onResult);
  onUpdatedRef.current = onUpdated;
  onResultRef.current = onResult;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      updateRequestIdRef.current += 1;
      void invoke("set_shortcuts_paused", { paused: false }).catch(console.error);
    };
  }, []);

  const updateShortcut = useCallback(
    async (action: ShortcutAction, shortcut: string) => {
      const requestId = ++updateRequestIdRef.current;
      try {
        await invoke("update_shortcut", {
          name: action,
          shortcutStr: shortcut,
        });
        if (!mountedRef.current || requestId !== updateRequestIdRef.current) return;
        onUpdatedRef.current(action, shortcut);
        onResultRef.current({ status: "success", action, shortcut });
      } catch (error) {
        if (!mountedRef.current || requestId !== updateRequestIdRef.current) return;
        onResultRef.current({ status: "failed", action, error });
      }
    },
    [],
  );

  useEffect(() => {
    void invoke("set_shortcuts_paused", {
      paused: recordingKey !== null,
    }).catch(console.error);
    if (!recordingKey) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return;

      const action = recordingKey;
      setRecordingKey(null);
      void updateShortcut(action, shortcut);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingKey, updateShortcut]);

  return {
    recordingKey,
    setRecordingKey,
  };
}
