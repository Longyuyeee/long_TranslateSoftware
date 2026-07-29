import { listen } from "@tauri-apps/api/event";
import { Clock, Copy, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import type { TranslationCatalog } from "../i18n";
import {
  clearTranslationHistory,
  deleteTranslationHistoryEntry,
  listTranslationHistory,
  type TranslationHistoryEntry,
} from "../services/history";

type HistoryLabels = Pick<
  TranslationCatalog,
  | "translations"
  | "clearAll"
  | "noHistory"
  | "copyTranslation"
  | "delete"
  | "loading"
  | "somethingWrong"
  | "retry"
>;

interface HistoryTabProps {
  labels: HistoryLabels;
}

export default function HistoryTab({ labels }: HistoryTabProps) {
  const [history, setHistory] = useState<TranslationHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const loadHistory = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      setHistory(await listTranslationHistory());
      setFailed(false);
    } catch (error) {
      console.error("Unable to load translation history", error);
      setFailed(true);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void loadHistory(true);
    void listen("history-updated", () => void loadHistory()).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => {
      console.error("Unable to subscribe to translation history updates", error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadHistory]);

  const clearHistory = async () => {
    try {
      await clearTranslationHistory();
      setHistory([]);
      setFailed(false);
    } catch (error) {
      console.error("Unable to clear translation history", error);
      setFailed(true);
    }
  };

  const deleteHistoryEntry = async (id: number) => {
    try {
      await deleteTranslationHistoryEntry(id);
      setHistory((entries) => entries.filter((entry) => entry.id !== id));
      setFailed(false);
    } catch (error) {
      console.error("Unable to delete translation history entry", error);
      setFailed(true);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label={labels.loading}>
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent" />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-zinc-400" role="alert">
        <p className="text-sm font-bold">{labels.somethingWrong}</p>
        <button
          type="button"
          onClick={() => void loadHistory(true)}
          className="rounded-full bg-accent px-5 py-2 text-xs font-black text-white"
        >
          {labels.retry}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
          {history.length} {labels.translations}
        </span>
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => void clearHistory()}
            className="rounded-full border border-red-500/20 bg-red-500/10 px-4 py-2 text-[10px] font-black text-red-500 transition-all hover:bg-red-500 hover:text-white"
          >
            {labels.clearAll}
          </button>
        )}
      </div>
      <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto">
        {history.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-300 opacity-40 dark:text-zinc-700">
            <Clock size={48} />
            <p className="text-[10px] font-black uppercase tracking-[0.4em]">{labels.noHistory}</p>
          </div>
        ) : (
          history.map((entry) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-card group rounded-2xl border border-black/5 p-5 transition-all hover:border-accent/20 dark:border-white/5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-3">
                  <p className="line-clamp-2 break-words text-[11px] font-medium italic text-zinc-500">{entry.source_text}</p>
                  <p className="break-words text-[13px] font-bold text-zinc-800 dark:text-zinc-100">{entry.translated_text}</p>
                  <div className="flex items-center gap-3">
                    <span className="text-[8px] font-black uppercase tracking-wider text-zinc-400">{entry.created_at?.split(" ")[0]}</span>
                    {entry.target_lang && <span className="text-[8px] font-black uppercase text-accent/60">{entry.target_lang}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(entry.translated_text)}
                    className="rounded-lg p-2 text-zinc-300 transition-all hover:bg-accent/10 hover:text-accent"
                    title={labels.copyTranslation}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteHistoryEntry(entry.id)}
                    className="rounded-lg p-2 text-zinc-300 transition-all hover:bg-red-500/10 hover:text-red-500"
                    title={labels.delete}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}
