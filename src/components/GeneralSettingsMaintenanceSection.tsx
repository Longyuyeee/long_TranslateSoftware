import { RotateCcw } from "lucide-react";
import type { TranslationCatalog } from "../i18n";
import { SettingsRow } from "./GeneralSettingsControls";

interface GeneralSettingsMaintenanceSectionProps {
  labels: TranslationCatalog;
  cacheSize: string;
  isExportingDiagnostics: boolean;
  onClearCache: () => void;
  onExport: () => void;
  onImport: () => void;
  onExportDiagnostics: () => void;
}

export default function GeneralSettingsMaintenanceSection({
  labels,
  cacheSize,
  isExportingDiagnostics,
  onClearCache,
  onExport,
  onImport,
  onExportDiagnostics,
}: GeneralSettingsMaintenanceSectionProps) {
  return (
    <div className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
      <h3 className="mb-4 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
        {labels.storage}
      </h3>
      <SettingsRow label={labels.cacheSize} description={labels.storageDesc}>
        <div className="flex items-center gap-4">
          <span className="text-[11px] font-black text-zinc-500">
            {cacheSize}
          </span>
          <button
            type="button"
            onClick={onClearCache}
            className="rounded-full border border-red-500/20 bg-red-500/10 px-4 py-1.5 text-[10px] font-black text-red-500 transition-all hover:bg-red-500 hover:text-white"
          >
            {labels.clearCache}
          </button>
        </div>
      </SettingsRow>
      <SettingsRow
        label={labels.backupRestore}
        description={labels.backupDesc}
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onExport}
            className="rounded-full border border-accent/20 bg-accent/10 px-4 py-1.5 text-[10px] font-black uppercase text-accent transition-all hover:bg-accent hover:text-white"
          >
            {labels.exportData}
          </button>
          <button
            type="button"
            onClick={onImport}
            className="rounded-full border border-black/5 bg-zinc-900/10 px-4 py-1.5 text-[10px] font-black uppercase text-zinc-900 transition-all hover:bg-zinc-900 hover:text-white dark:border-white/10 dark:bg-white/10 dark:text-white dark:hover:bg-white dark:hover:text-zinc-900"
          >
            {labels.importData}
          </button>
        </div>
      </SettingsRow>
      <SettingsRow
        label={labels.diagnosticsReport}
        description={labels.diagnosticsDesc}
      >
        <button
          type="button"
          onClick={onExportDiagnostics}
          disabled={isExportingDiagnostics}
          className="flex shrink-0 items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-4 py-1.5 text-[10px] font-black uppercase text-accent transition-all hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isExportingDiagnostics && (
            <RotateCcw size={12} className="animate-spin" />
          )}
          {isExportingDiagnostics
            ? labels.exportingDiagnostics
            : labels.exportDiagnostics}
        </button>
      </SettingsRow>
    </div>
  );
}
