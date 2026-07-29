import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const CLIPBOARD_POLL_INTERVAL_MS = 900;

export function useClipboardMonitor(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let isPolling = false;
    let lastText = "";

    const pollClipboard = async () => {
      if (!active || isPolling) return;
      isPolling = true;
      try {
        const text = await invoke<string>("get_clipboard_text");
        if (!active || !text || text === lastText) return;
        lastText = text;
        await invoke("clipboard_detect", { text });
      } catch {
        // Clipboard access can fail while another application owns it.
      } finally {
        isPolling = false;
      }
    };

    const timer = window.setInterval(() => {
      void pollClipboard();
    }, CLIPBOARD_POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled]);
}
