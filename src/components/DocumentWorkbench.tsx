import {
  AlertCircle,
  AlertTriangle,
  FileText,
  FolderOpen,
  ShieldCheck,
} from "lucide-react";
import { useMemo } from "react";
import {
  documentImportErrorText,
  documentStructureText,
  documentWarningText,
  type TranslationCatalog,
} from "../i18n";
import { useDocumentImport } from "../hooks/useDocumentImport";

const PREVIEW_SEGMENT_LIMIT = 100;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function DocumentWorkbench({
  labels,
}: {
  labels: TranslationCatalog;
}) {
  const {
    phase,
    inspection,
    errorCode,
    isBusy,
    chooseDocument,
  } = useDocumentImport({
    title: labels.documentPickerTitle,
    filterName: labels.documentPickerFilter,
  });
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
            {isBusy
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
