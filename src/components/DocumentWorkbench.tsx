import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
  FileOutput,
  FolderOpen,
  History,
  Languages,
  LoaderCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useMemo } from "react";
import {
  documentImportErrorText,
  documentPreparationErrorText,
  documentRunErrorText,
  documentStructureText,
  documentWarningText,
  type TranslationCatalog,
} from "../i18n";
import { useDocumentImport } from "../hooks/useDocumentImport";
import { useDocumentPreparation } from "../hooks/useDocumentPreparation";
import { useDocumentRecovery } from "../hooks/useDocumentRecovery";
import { useDocumentTranslationRun } from "../hooks/useDocumentTranslationRun";

const PREVIEW_SEGMENT_LIMIT = 100;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function displayFileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

function languageLabel(labels: TranslationCatalog, language: string): string {
  if (language === "auto") return labels.autoDetect;
  return (labels.languageNames as Record<string, string>)[language] ?? language;
}

export default function DocumentWorkbench({
  labels,
}: {
  labels: TranslationCatalog;
}) {
  const {
    phase,
    inspection,
    sourcePath,
    errorCode,
    isBusy: isImportBusy,
    chooseDocument,
  } = useDocumentImport({
    title: labels.documentPickerTitle,
    filterName: labels.documentPickerFilter,
  });
  const {
    phase: preparationPhase,
    outputMode,
    outputPath,
    preparedTask,
    errorCode: preparationErrorCode,
    isBusy: isPreparationBusy,
    setOutputMode,
    chooseOutput,
    confirmTask,
  } = useDocumentPreparation({
    inspection,
    sourcePath,
    pickerTitle: labels.documentOutputPickerTitle,
    pickerFilterName: labels.documentPickerFilter,
  });
  const {
    phase: runPhase,
    job: runJob,
    progress: runProgress,
    errorCode: runErrorCode,
    start: startTranslation,
    cancel: cancelTranslation,
  } = useDocumentTranslationRun(preparedTask);
  const recovery = useDocumentRecovery();
  const isRunActive = runPhase === "checkpointing"
    || runPhase === "translating"
    || runPhase === "cancelling";
  const isBusy = isImportBusy || isPreparationBusy || isRunActive;
  const canStartPreparedTask = Boolean(preparedTask) && !isRunActive && (
    runPhase === "idle" || runJob?.id !== preparedTask?.job.id
  );
  const preview = inspection?.segments.slice(0, PREVIEW_SEGMENT_LIMIT) ?? [];
  const sourceBytes = useMemo(() => {
    if (!inspection) return 0;
    const encoder = new TextEncoder();
    return inspection.segments.reduce(
      (total, segment) => total + encoder.encode(segment.sourceText).length,
      0,
    );
  }, [inspection]);
  const busyLabel = phase === "selecting"
    ? labels.documentSelecting
    : labels.documentInspecting;
  const progressPercent = runProgress && runProgress.total > 0
    ? Math.round(((runProgress.completed + runProgress.failed) / runProgress.total) * 100)
    : 0;
  const runTitle = runPhase === "checkpointing"
    ? labels.documentCheckpointing
    : runPhase === "translating"
      ? labels.documentTranslationRunning
      : runPhase === "cancelling"
        ? labels.documentCancelling
        : runPhase === "ready-to-rebuild"
          ? labels.documentReadyToRebuildTitle
          : runPhase === "cancelled"
            ? labels.documentCancelledTitle
            : labels.documentRunErrorTitle;

  return (
    <section className="flex h-full min-h-0 flex-col gap-4" aria-labelledby="document-workbench-title">
      <div className="glass-card shrink-0 rounded-[28px] p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-accent">
              <FileText size={18} aria-hidden="true" />
              <h2 id="document-workbench-title" className="text-lg font-black text-zinc-900 dark:text-white">
                {labels.documentWorkbenchTitle}
              </h2>
            </div>
            <p className="text-xs leading-relaxed font-medium text-zinc-500 dark:text-zinc-400">
              {labels.documentWorkbenchDescription}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void chooseDocument()}
            disabled={isBusy}
            className="flex min-w-40 items-center justify-center gap-2 rounded-2xl bg-accent px-5 py-3 text-xs font-black text-white shadow-lg shadow-accent transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
          >
            <FolderOpen size={16} aria-hidden="true" />
            {isImportBusy
              ? busyLabel
              : inspection
                ? labels.documentChooseAnother
                : labels.documentChoose}
          </button>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-accent/10 bg-accent/5 px-4 py-3 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <span>{labels.documentPrivacyNotice}</span>
        </div>
      </div>

      <div className="glass-card shrink-0 rounded-[24px] border border-accent/10 p-4">
        <div className="flex items-start gap-3">
          <History size={17} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-black text-zinc-800 dark:text-zinc-100">
              {labels.documentRecoveryTitle}
            </h3>
            <p className="mt-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
              {labels.documentRecoveryDescription}
            </p>

            {recovery.errorCode ? (
              <div role="alert" className="mt-3 rounded-2xl border border-red-500/15 bg-red-500/5 p-3 text-red-700 dark:text-red-300">
                <p className="text-[10px] font-black">
                  {recovery.errorSource === "action"
                    ? labels.documentRecoveryActionErrorTitle
                    : labels.documentRecoveryErrorTitle}
                </p>
                <p className="mt-1 text-[9px] font-semibold">
                  {(labels as unknown as Record<string, string>)[`documentRecoveryError_${recovery.errorCode}`]
                    ?? labels.documentRecoveryError_unknown}
                </p>
              </div>
            ) : recovery.isListing ? (
              <p role="status" className="mt-3 text-[10px] font-semibold text-zinc-400">
                {labels.documentRecoveryScanning}
              </p>
            ) : recovery.summaries.length === 0 ? (
              <p className="mt-3 text-[10px] font-semibold text-zinc-400">
                {labels.documentRecoveryEmpty}
              </p>
            ) : (
              <ul className="custom-scrollbar mt-3 grid max-h-52 gap-2 overflow-y-auto pr-1 lg:grid-cols-2">
                {recovery.summaries.map(summary => (
                  <li key={summary.jobId} className="rounded-2xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.025]">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-black text-zinc-800 dark:text-zinc-100">
                          {summary.fileName}
                        </p>
                        <p className="mt-1 text-[9px] font-semibold text-zinc-400">
                          {(labels as unknown as Record<string, string>)[`documentRecoveryPhase_${summary.phase}`]}
                          {" · "}
                          {labels.documentRecoveryUpdated.replace("{time}", new Date(summary.updatedAt).toLocaleString())}
                        </p>
                        <p className="mt-1 text-[9px] font-semibold text-zinc-500 dark:text-zinc-400">
                          {labels.documentRecoveryProgress
                            .replace("{completed}", String(summary.completedSegments))
                            .replace("{failed}", String(summary.failedSegments))
                            .replace("{total}", String(summary.totalSegments))}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void recovery.load(summary.jobId)}
                        disabled={recovery.loadingJobId !== null}
                        className="shrink-0 rounded-xl bg-accent/10 px-3 py-2 text-[9px] font-black text-accent disabled:opacity-45"
                      >
                        {recovery.loadingJobId === summary.jobId
                          ? labels.documentRecoveryLoading
                          : labels.documentRecoveryLoad}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {recovery.checkpoint && (
              <div role="status" className="mt-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-emerald-800 dark:text-emerald-300">
                <p className="text-[10px] font-black">{labels.documentRecoveryLoadedTitle}</p>
                <p className="mt-1 text-[9px] font-semibold">
                  {recovery.checkpoint.job.phase === "translating"
                    ? labels.documentRecoveryAwaitingRebuild
                    : labels.documentRecoveryLoadedDescription}
                </p>
                {(recovery.checkpoint.job.phase === "ready" || recovery.checkpoint.job.phase === "failed") && (
                  <button
                    type="button"
                    onClick={() => void recovery.resume()}
                    disabled={isRunActive || recovery.isResuming}
                    className="mt-3 rounded-xl bg-emerald-600 px-3 py-2 text-[9px] font-black text-white shadow-lg shadow-emerald-500/15 disabled:opacity-45"
                  >
                    {recovery.isResuming
                      ? labels.documentRecoveryCheckingSettings
                      : recovery.checkpoint.job.phase === "failed"
                        ? labels.documentRecoveryRetryFailed
                        : labels.documentRecoveryContinue}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {phase === "error" && (
        <div role="alert" className="shrink-0 rounded-2xl border border-red-500/20 bg-red-50 p-4 text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <h3 className="text-xs font-black">{labels.documentImportErrorTitle}</h3>
              <p className="mt-1 text-[11px] font-medium">{documentImportErrorText(labels, errorCode ?? undefined)}</p>
            </div>
          </div>
        </div>
      )}

      {preparationPhase === "error" && (
        <div role="alert" className="shrink-0 rounded-2xl border border-red-500/20 bg-red-50 p-4 text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <h3 className="text-xs font-black">{labels.documentPreparationErrorTitle}</h3>
              <p className="mt-1 text-[11px] font-medium">
                {documentPreparationErrorText(labels, preparationErrorCode ?? undefined)}
              </p>
            </div>
          </div>
        </div>
      )}

      {runPhase !== "idle" && (
        <div
          role={runPhase === "failed" ? "alert" : "status"}
          aria-live="polite"
          className={`glass-card shrink-0 rounded-[24px] border p-4 ${
            runPhase === "failed"
              ? "border-red-500/20"
              : runPhase === "ready-to-rebuild"
                ? "border-emerald-500/20"
                : "border-accent/15"
          }`}
        >
          <div className="flex items-start gap-3">
            {runPhase === "failed" ? (
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
            ) : runPhase === "ready-to-rebuild" ? (
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
            ) : runPhase === "cancelled" ? (
              <XCircle size={18} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true" />
            ) : (
              <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-xs font-black text-zinc-800 dark:text-zinc-100">
                  {runTitle}
                </h3>
                {(runPhase === "checkpointing" || runPhase === "translating" || runPhase === "cancelling") && (
                  <button
                    type="button"
                    onClick={cancelTranslation}
                    disabled={runPhase === "cancelling"}
                    className="rounded-xl border border-red-500/15 bg-red-500/5 px-3 py-1.5 text-[9px] font-black text-red-600 disabled:opacity-45 dark:text-red-300"
                  >
                    {runPhase === "cancelling"
                      ? labels.documentCancelling
                      : labels.documentCancelTranslation}
                  </button>
                )}
              </div>
              {runProgress && isRunActive && (
                <>
                  <p className="mt-1 text-[10px] font-semibold text-zinc-500 dark:text-zinc-400">
                    {labels.documentProgressSummary
                      .replace("{completed}", String(runProgress.completed))
                      .replace("{total}", String(runProgress.total))
                      .replace("{failed}", String(runProgress.failed))
                      .replace("{active}", String(runProgress.active))}
                  </p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </>
              )}
              {runPhase === "ready-to-rebuild" && (
                <p className="mt-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                  {labels.documentReadyToRebuildDescription}
                </p>
              )}
              {runPhase === "cancelled" && (
                <p className="mt-1 text-[10px] font-semibold text-zinc-500 dark:text-zinc-400">
                  {labels.documentCancelledDescription}
                </p>
              )}
              {runPhase === "failed" && (
                <p className="mt-1 text-[10px] font-semibold text-red-700 dark:text-red-300">
                  {documentRunErrorText(labels, runErrorCode ?? undefined)}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {!inspection ? (
        <div className="glass-card flex min-h-64 flex-1 flex-col items-center justify-center rounded-[28px] px-8 text-center">
          <FileText size={38} className="mb-4 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
          <h3 className="text-sm font-black text-zinc-800 dark:text-zinc-100">
            {labels.documentEmptyTitle}
          </h3>
          <p className="mt-2 max-w-md text-xs font-medium text-zinc-400">
            {labels.documentEmptyDescription}
          </p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <div className="custom-scrollbar min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="glass-card rounded-[24px] p-5">
              <div className="mb-4 flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                  <FileText size={19} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-black text-zinc-800 dark:text-zinc-100">
                    {inspection.fileName}
                  </h3>
                  <p className="text-[10px] font-semibold text-zinc-400">
                    {labels.documentDocxFormat}
                  </p>
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-2">
                {[
                  [labels.documentFileSize, formatBytes(inspection.sizeBytes)],
                  [labels.documentSegmentCount, String(inspection.segments.length)],
                  [labels.documentSourceBytes, formatBytes(sourceBytes)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-2xl bg-black/[0.025] p-3 dark:bg-white/[0.035]">
                    <dt className="text-[9px] font-bold text-zinc-400">{label}</dt>
                    <dd className="mt-1 text-xs font-black text-zinc-700 dark:text-zinc-200">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="glass-card rounded-[24px] p-5">
              <h3 className="mb-3 flex items-center gap-2 text-xs font-black text-zinc-800 dark:text-zinc-100">
                <AlertTriangle size={15} className="text-amber-500" aria-hidden="true" />
                {labels.documentWarnings}
              </h3>
              {inspection.warnings.length === 0 ? (
                <p className="rounded-2xl bg-emerald-500/10 px-3 py-2.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  {labels.documentNoWarnings}
                </p>
              ) : (
                <ul className="space-y-2">
                  {inspection.warnings.map(warning => (
                    <li key={warning.code} className="rounded-2xl border border-amber-500/15 bg-amber-500/5 px-3 py-2.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                      {documentWarningText(labels, warning.code)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="glass-card rounded-[24px] p-5">
              <h3 className="mb-4 flex items-center gap-2 text-xs font-black text-zinc-800 dark:text-zinc-100">
                <FileOutput size={15} className="text-accent" aria-hidden="true" />
                {labels.documentOutputSetup}
              </h3>

              <fieldset disabled={isBusy}>
                <legend className="mb-2 text-[10px] font-bold text-zinc-500 dark:text-zinc-400">
                  {labels.documentOutputMode}
                </legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {([
                    [
                      "translated",
                      labels.documentOutputTranslated,
                      labels.documentOutputTranslatedDescription,
                    ],
                    [
                      "bilingual",
                      labels.documentOutputBilingual,
                      labels.documentOutputBilingualDescription,
                    ],
                  ] as const).map(([value, label, description]) => (
                    <label
                      key={value}
                      className={`cursor-pointer rounded-2xl border p-3 transition-colors ${
                        outputMode === value
                          ? "border-accent/40 bg-accent/10"
                          : "border-black/5 bg-black/[0.02] dark:border-white/5 dark:bg-white/[0.025]"
                      }`}
                    >
                      <span className="flex items-center gap-2 text-[11px] font-black text-zinc-800 dark:text-zinc-100">
                        <input
                          type="radio"
                          name="document-output-mode"
                          value={value}
                          checked={outputMode === value}
                          onChange={() => setOutputMode(value)}
                          className="accent-[var(--accent)]"
                        />
                        {label}
                      </span>
                      <span className="mt-1 block pl-5 text-[9px] leading-relaxed font-medium text-zinc-400">
                        {description}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="mt-4">
                <p className="mb-2 text-[10px] font-bold text-zinc-500 dark:text-zinc-400">
                  {labels.documentOutputTarget}
                </p>
                <div className="flex min-w-0 items-center gap-2 rounded-2xl bg-black/[0.025] p-2.5 dark:bg-white/[0.035]">
                  <FileOutput size={15} className="shrink-0 text-zinc-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">
                    {outputPath
                      ? displayFileName(outputPath)
                      : labels.documentOutputNotSelected}
                  </span>
                  <button
                    type="button"
                    onClick={() => void chooseOutput()}
                    disabled={isBusy}
                    className="shrink-0 rounded-xl border border-accent/15 bg-accent/10 px-3 py-2 text-[9px] font-black text-accent disabled:opacity-50"
                  >
                    {isPreparationBusy && preparationPhase === "selecting-output"
                      ? labels.documentOutputSelecting
                      : outputPath
                        ? labels.documentOutputChooseAnother
                        : labels.documentOutputChoose}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void confirmTask()}
                disabled={!outputPath || isBusy || Boolean(preparedTask)}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3 text-[11px] font-black text-white shadow-lg shadow-accent disabled:cursor-not-allowed disabled:opacity-45"
              >
                <CheckCircle2 size={15} aria-hidden="true" />
                {preparationPhase === "preparing"
                  ? labels.documentPreparingTask
                  : labels.documentConfirmTask}
              </button>

              {preparedTask && (
                <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-emerald-800 dark:text-emerald-300">
                  <p className="flex items-center gap-2 text-[10px] font-black">
                    <CheckCircle2 size={14} aria-hidden="true" />
                    {labels.documentPreparedTitle}
                  </p>
                  <p className="mt-1 text-[9px] leading-relaxed font-medium">
                    {labels.documentPreparedDescription}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-2">
                    <div>
                      <dt className="text-[8px] font-bold opacity-70">{labels.documentPreparedModel}</dt>
                      <dd className="mt-0.5 truncate text-[9px] font-black">
                        {preparedTask.job.snapshot.primary.model}
                      </dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1 text-[8px] font-bold opacity-70">
                        <Languages size={9} aria-hidden="true" />
                        {labels.documentPreparedLanguages}
                      </dt>
                      <dd className="mt-0.5 truncate text-[9px] font-black">
                        {languageLabel(labels, preparedTask.job.snapshot.sourceLanguage)}
                        {" → "}
                        {languageLabel(labels, preparedTask.job.snapshot.targetLanguage)}
                      </dd>
                    </div>
                  </dl>
                  {canStartPreparedTask && (
                    <button
                      type="button"
                      onClick={() => void startTranslation()}
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-[10px] font-black text-white shadow-lg shadow-emerald-500/15"
                    >
                      <Languages size={13} aria-hidden="true" />
                      {labels.documentStartTranslation}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="glass-card flex min-h-0 flex-col rounded-[24px] p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-xs font-black text-zinc-800 dark:text-zinc-100">
                {labels.documentPreview}
              </h3>
              <span className="text-[9px] font-bold text-zinc-400">
                {labels.documentPreviewCount
                  .replace("{shown}", String(preview.length))
                  .replace("{total}", String(inspection.segments.length))}
              </span>
            </div>
            <ol className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {preview.map(segment => (
                <li key={segment.id} className="rounded-2xl border border-black/5 bg-white/45 p-3 dark:border-white/5 dark:bg-white/[0.035]">
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[9px] font-black text-accent">
                      {documentStructureText(labels, segment.structure)}
                    </span>
                    <span className="text-[9px] font-bold text-zinc-400">{segment.order + 1}</span>
                  </div>
                  <p className="selectable-text whitespace-pre-wrap break-words text-xs leading-relaxed font-medium text-zinc-700 dark:text-zinc-200">
                    {segment.sourceText}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
