import { lazy, Suspense } from "react";
import { AlertCircle, ArrowLeftRight, CircleStop, Copy, Languages } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { translationErrorText, type TranslationCatalog } from "../i18n";
import { useGlossary } from "../hooks/useGlossary";
import type { ComparisonSideState, TranslationTaskState } from "../services/api";
import ThemedSelect from "./ThemedSelect";

const GlossaryEditor = lazy(() => import("./GlossaryEditor"));

interface LanguageOption {
  value: string;
  label: string;
}

interface BatchTranslationViewProps {
  labels: TranslationCatalog;
  languageOptions: LanguageOption[];
  sourceLang: string;
  targetLang: string;
  primaryModelName: string;
  backupModelName: string;
  batchInput: string;
  batchOutput: string;
  batchOutputBackup: string;
  compareMode: boolean;
  batchBackTranslation: string;
  isBatchBackTranslating: boolean;
  isTranslating: boolean;
  batchTaskState: TranslationTaskState;
  primaryComparisonState: ComparisonSideState | null;
  backupComparisonState: ComparisonSideState | null;
  onSourceLanguageChange: (language: string) => void;
  onTargetLanguageChange: (language: string) => void;
  onInputChange: (value: string) => void;
  onTranslate: () => void;
  onCompareTranslate: () => void;
  onBackTranslate: () => void;
  onCancel: () => void;
  onCompareModeChange: (enabled: boolean) => void;
}

function statusText(labels: TranslationCatalog, state: TranslationTaskState) {
  if (state.phase === "loading-config") return labels.translationPreparing;
  if (state.phase === "checking-cache") return labels.translationCheckingCache;
  if (state.phase === "translating-primary") return labels.translationPrimary;
  if (state.phase === "translating-backup") return labels.translationBackup;
  if (state.phase === "error") return labels.translationFailed;
  if (state.phase === "cancelled") return labels.translationCancelled;
  return state.cached ? labels.translationCacheHit : "";
}

export default function BatchTranslationView({
  labels,
  languageOptions,
  sourceLang,
  targetLang,
  primaryModelName,
  backupModelName,
  batchInput,
  batchOutput,
  batchOutputBackup,
  compareMode,
  batchBackTranslation,
  isBatchBackTranslating,
  isTranslating,
  batchTaskState,
  primaryComparisonState,
  backupComparisonState,
  onSourceLanguageChange,
  onTargetLanguageChange,
  onInputChange,
  onTranslate,
  onCompareTranslate,
  onBackTranslate,
  onCancel,
  onCompareModeChange,
}: BatchTranslationViewProps) {
  const {
    entries: glossary,
    isLoading: isGlossaryLoading,
    isMutating: isGlossaryMutating,
    hasError: hasGlossaryError,
    load: loadGlossary,
    add: addGlossaryEntry,
    update: updateGlossaryEntry,
    remove: deleteGlossaryEntry,
  } = useGlossary();
  const handleTranslation = isTranslating
    ? onCancel
    : compareMode
      ? onCompareTranslate
      : onTranslate;

  return (
    <div className="space-y-6 flex-1 flex flex-col min-h-0">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between pl-4 pr-2">
            <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">{labels.inputText}</h3>
            <ThemedSelect
              value={sourceLang}
              options={[{ value: "auto", label: labels.autoDetect }, ...languageOptions]}
              onChange={onSourceLanguageChange}
              ariaLabel={labels.sourceLang}
              className="w-32"
              compact
            />
          </div>
          <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative">
            <textarea
              aria-label={labels.inputText}
              value={batchInput}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder={labels.inputPlaceholder}
              className="w-full h-full bg-transparent outline-none resize-none font-medium custom-scrollbar text-[0.9em] leading-relaxed dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
            />
            <div className="absolute bottom-6 right-6">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleTranslation}
                disabled={!batchInput}
                className={`px-6 py-2.5 rounded-full font-black text-[11px] shadow-xl flex items-center gap-2 transition-all ${!batchInput ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-400" : isTranslating ? "bg-red-500 text-white shadow-red-500/20" : "bg-accent text-white shadow-accent"}`}
              >
                {isTranslating ? <CircleStop size={14} /> : <Languages size={14} />}
                {isTranslating ? labels.cancelTranslation : labels.translate}
              </motion.button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap justify-between items-center gap-2 px-2">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">{labels.output}</h3>
              <ThemedSelect
                value={targetLang}
                options={languageOptions}
                onChange={onTargetLanguageChange}
                ariaLabel={labels.targetLang}
                className="w-28"
                compact
                accent
              />
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              {batchOutput && !compareMode && (
                <button onClick={() => void navigator.clipboard.writeText(batchOutput)} className="text-[10px] font-bold text-accent hover:bg-accent/10 px-3 py-1 rounded-full flex items-center gap-1.5 transition-all">
                  <Copy size={12} /> {labels.copy}
                </button>
              )}
              {batchOutput && !compareMode && (
                <button
                  onClick={onBackTranslate}
                  disabled={isBatchBackTranslating}
                  className={`text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-1.5 transition-all ${isBatchBackTranslating ? "text-zinc-300" : "text-amber-500 hover:bg-amber-500/10"}`}
                >
                  <ArrowLeftRight size={12} /> {labels.backTranslation}
                </button>
              )}
              <button
                onClick={() => onCompareModeChange(!compareMode)}
                disabled={isTranslating}
                className={`text-[9px] font-black px-2.5 py-1.5 rounded-full transition-all ${
                  isTranslating ? "opacity-40 cursor-not-allowed" : compareMode ? "bg-accent text-white shadow-accent" : "bg-black/5 dark:bg-white/5 text-zinc-400 hover:bg-accent/10 hover:text-accent"
                }`}
              >
                {labels.compareMode} {compareMode ? labels.toggleOn : labels.toggleOff}
              </button>
            </div>
          </div>

          {compareMode ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0">
              <div className="flex flex-col gap-1.5 min-h-0">
                <div className="flex items-center justify-between px-2">
                  <span className="text-[8px] font-black text-accent uppercase tracking-wider">{primaryComparisonState?.model || primaryModelName || "Primary"}</span>
                  {primaryComparisonState?.durationMs !== undefined && <span className="text-[8px] font-bold text-zinc-400">{primaryComparisonState.durationMs} {labels.millisecondsShort}</span>}
                </div>
                <div className="flex-1 glass-card rounded-[24px] overflow-hidden p-5 border-white/50 bg-black/[0.02] dark:bg-white/[0.02]">
                  <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.8em] leading-relaxed selectable-text whitespace-pre-wrap">
                    {batchOutput || (primaryComparisonState?.phase === "error"
                      ? <span className="text-red-500"><AlertCircle size={13} className="inline mr-1.5" />{translationErrorText(labels, primaryComparisonState.error?.code, primaryComparisonState.error?.message)}</span>
                      : primaryComparisonState?.phase === "cancelled" ? <span className="opacity-30 italic">{labels.translationCancelled}</span>
                        : <span className="opacity-30 italic">{primaryComparisonState?.phase === "translating" ? labels.translationPrimary : "..."}</span>)}
                    {primaryComparisonState?.phase === "translating" && !batchOutput && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-accent align-middle" />}
                  </div>
                </div>
                {batchOutput && <button onClick={() => void navigator.clipboard.writeText(batchOutput)} className="self-end text-[9px] font-bold text-zinc-400 hover:text-accent px-2 py-1 rounded-lg hover:bg-accent/10 transition-all"><Copy size={10} className="inline mr-1" />{labels.copy}</button>}
              </div>

              <div className="flex flex-col gap-1.5 min-h-0">
                <div className="flex items-center justify-between px-2">
                  <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider">{backupComparisonState?.model || backupModelName || "Backup"}</span>
                  {backupComparisonState?.durationMs !== undefined && <span className="text-[8px] font-bold text-zinc-400">{backupComparisonState.durationMs} {labels.millisecondsShort}</span>}
                </div>
                <div className="flex-1 glass-card rounded-[24px] overflow-hidden p-5 border-white/50 bg-black/[0.02] dark:bg-white/[0.02]">
                  <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.8em] leading-relaxed selectable-text whitespace-pre-wrap">
                    {batchOutputBackup || (backupComparisonState?.phase === "error"
                      ? <span className="text-red-500"><AlertCircle size={13} className="inline mr-1.5" />{translationErrorText(labels, backupComparisonState.error?.code, backupComparisonState.error?.message)}</span>
                      : backupComparisonState?.phase === "cancelled" ? <span className="opacity-30 italic">{labels.translationCancelled}</span>
                        : <span className="opacity-30 italic">{backupComparisonState?.phase === "translating" ? labels.translationBackupModel : "..."}</span>)}
                    {backupComparisonState?.phase === "translating" && !batchOutputBackup && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-zinc-400 align-middle" />}
                  </div>
                </div>
                {batchOutputBackup && <button onClick={() => void navigator.clipboard.writeText(batchOutputBackup)} className="self-end text-[9px] font-bold text-zinc-400 hover:text-accent px-2 py-1 rounded-lg hover:bg-accent/10 transition-all"><Copy size={10} className="inline mr-1" />{labels.copy}</button>}
              </div>
            </div>
          ) : (
            <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative bg-black/[0.02] dark:bg-white/[0.02]">
              <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.9em] leading-relaxed selectable-text">
                {batchOutput || (isTranslating ? <span className="opacity-30 italic">{statusText(labels, batchTaskState)}</span> : batchTaskState.phase === "error" ? "" : <span className="opacity-30 italic">{labels.outputPlaceholder}</span>)}
                {isTranslating && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-accent align-middle" />}
              </div>
              {batchTaskState.phase === "error" && (
                <div className="absolute inset-x-5 bottom-5 flex items-center gap-3 rounded-2xl border border-red-500/15 bg-red-50/95 dark:bg-red-500/10 p-3 text-red-600 dark:text-red-400">
                  <AlertCircle size={15} className="shrink-0" />
                  <span className="min-w-0 flex-1 text-[10px] font-bold">{translationErrorText(labels, batchTaskState.error?.code, batchTaskState.error?.message)}</span>
                  <button onClick={onTranslate} className="text-[10px] font-black hover:underline">{labels.retry}</button>
                </div>
              )}
            </div>
          )}

          <AnimatePresence>
            {(batchBackTranslation || isBatchBackTranslating) && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="glass-card rounded-2xl p-4 border border-amber-500/20 bg-amber-50/50 dark:bg-amber-500/5">
                  <div className="flex items-center gap-2 mb-2">
                    <ArrowLeftRight size={12} className="text-amber-500" />
                    <span className="text-[9px] font-black uppercase text-amber-500 tracking-[0.2em]">{labels.backTranslation}</span>
                  </div>
                  <div className="text-[12px] font-medium text-amber-800 dark:text-amber-300 leading-relaxed selectable-text">
                    {batchBackTranslation || (isBatchBackTranslating ? "" : "...")}
                    {isBatchBackTranslating && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-3.5 ml-1 bg-amber-400 align-middle rounded-full" />}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <Suspense fallback={<div className="h-28 animate-pulse rounded-[24px] bg-black/5 dark:bg-white/5" />}>
        <GlossaryEditor
          labels={labels}
          entries={glossary}
          isLoading={isGlossaryLoading}
          isMutating={isGlossaryMutating}
          hasError={hasGlossaryError}
          onRetry={() => void loadGlossary()}
          onAdd={addGlossaryEntry}
          onUpdate={updateGlossaryEntry}
          onDelete={deleteGlossaryEntry}
        />
      </Suspense>
    </div>
  );
}
