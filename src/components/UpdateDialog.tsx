import { AnimatePresence, motion } from "framer-motion";
import { Download, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";

export type UpdatePhase = "available" | "downloading" | "installing" | "error";

interface UpdateDialogProps {
  open: boolean;
  version: string;
  notes?: string;
  phase: UpdatePhase;
  progress: number | null;
  error?: string;
  labels: Record<string, string>;
  onInstall: () => void;
  onClose: () => void;
}

export default function UpdateDialog({ open, version, notes, phase, progress, error, labels, onInstall, onClose }: UpdateDialogProps) {
  const busy = phase === "downloading" || phase === "installing";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-6 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-dialog-title"
        >
          <motion.section
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            className="w-full max-w-lg overflow-hidden rounded-[30px] border border-white/40 bg-white/95 shadow-2xl dark:border-white/10 dark:bg-zinc-900/95"
          >
            <header className="flex items-start justify-between gap-5 border-b border-black/5 px-7 py-6 dark:border-white/10">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                  <Sparkles size={23} />
                </div>
                <div>
                  <h2 id="update-dialog-title" className="text-lg font-black text-zinc-900 dark:text-white">{labels.updateAvailableTitle}</h2>
                  <p className="mt-1 text-xs font-bold text-zinc-400">{labels.updateVersionLabel.replace("{version}", version)}</p>
                </div>
              </div>
              <button type="button" onClick={onClose} disabled={busy} className="rounded-xl p-2 text-zinc-400 hover:bg-black/5 hover:text-zinc-700 disabled:opacity-30 dark:hover:bg-white/10 dark:hover:text-white" aria-label={labels.close}>
                <X size={18} />
              </button>
            </header>

            <div className="space-y-5 px-7 py-6">
              {notes && (
                <div className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-2xl bg-black/[0.035] p-4 text-xs font-medium leading-6 text-zinc-600 dark:bg-white/[0.055] dark:text-zinc-300">
                  {notes}
                </div>
              )}

              <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4 text-emerald-700 dark:text-emerald-400">
                <ShieldCheck size={18} className="shrink-0" />
                <p className="text-[11px] font-bold leading-relaxed">{labels.updateSignatureHint}</p>
              </div>

              {busy && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-zinc-400">
                    <span>{phase === "installing" ? labels.updateInstalling : labels.updateDownloading}</span>
                    <span>{progress === null ? "..." : `${progress}%`}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                    <motion.div className="h-full rounded-full bg-accent" animate={{ width: progress === null ? "18%" : `${progress}%` }} transition={{ duration: 0.25 }} />
                  </div>
                  <p className="text-[10px] font-medium text-zinc-400">{labels.updateDoNotClose}</p>
                </div>
              )}

              {phase === "error" && (
                <div className="rounded-2xl border border-red-500/15 bg-red-500/5 p-4 text-xs font-bold text-red-600 dark:text-red-400">
                  {error || labels.updateInstallFailed}
                </div>
              )}
            </div>

            <footer className="flex justify-end gap-3 border-t border-black/5 bg-black/[0.02] px-7 py-5 dark:border-white/10 dark:bg-white/[0.025]">
              {!busy && <button type="button" onClick={onClose} className="rounded-xl px-5 py-2.5 text-xs font-black text-zinc-500 hover:bg-black/5 dark:hover:bg-white/10">{labels.updateLater}</button>}
              {!busy && (
                <button type="button" onClick={onInstall} className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-xs font-black text-white shadow-lg shadow-accent/20">
                  {phase === "error" ? <RefreshCw size={15} /> : <Download size={15} />}
                  {phase === "error" ? labels.retry : labels.updateNow}
                </button>
              )}
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
