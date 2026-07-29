import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle,
  ChevronRight,
  Info,
  RotateCcw,
  Settings,
} from "lucide-react";
import {
  webDavErrorText,
  type Lang,
  type TranslationCatalog,
} from "../i18n";
import type {
  WebDavError,
  WebDavSyncSummary,
} from "../services/webdav";
import ThemedSelect, { type ThemedSelectOption } from "./ThemedSelect";

export interface GeneralSettingsValue {
  lang: Lang;
  autoLaunch: boolean;
  sourceLang: string;
  targetLang: string;
  ocrLang: string;
  autoCopy: boolean;
  clipboardMonitor: boolean;
}

export type GeneralSettingsPatch = Partial<
  Omit<GeneralSettingsValue, "autoLaunch">
>;

export interface ShortcutSettingsValue {
  q: string;
  w: string;
  recording: "q" | "w" | null;
}

export interface WebDavSettingsValue {
  enabled: boolean;
  url: string;
  user: string;
  password: string;
  lastSyncTime: string;
  lastSyncSummary: WebDavSyncSummary | null;
}

export type WebDavSettingsPatch = Partial<
  Pick<WebDavSettingsValue, "enabled" | "url" | "user" | "password">
>;

export interface WebDavConnectionState {
  ok: boolean;
  latencyMs?: number;
  error?: WebDavError;
}

interface GeneralSettingsTabProps {
  labels: TranslationCatalog;
  value: GeneralSettingsValue;
  interfaceLanguageOptions: readonly ThemedSelectOption<Lang>[];
  languageOptions: readonly ThemedSelectOption[];
  ocrLanguageOptions: readonly ThemedSelectOption[];
  shortcuts: ShortcutSettingsValue;
  webdav: WebDavSettingsValue;
  webdavConnection: WebDavConnectionState | null;
  isTestingWebdav: boolean;
  isSyncing: boolean;
  cacheSize: string;
  isExportingDiagnostics: boolean;
  onChange: (patch: GeneralSettingsPatch) => void;
  onToggleAutoLaunch: () => void;
  onRecordingChange: (recording: "q" | "w" | null) => void;
  onWebDavChange: (patch: WebDavSettingsPatch) => void;
  onTestWebdav: () => void;
  onSync: () => void;
  onClearCache: () => void;
  onExport: () => void;
  onImport: () => void;
  onExportDiagnostics: () => void;
}

function Toggle({
  checked,
  label,
  onClick,
  activeClass = "bg-accent shadow-lg shadow-accent",
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
  activeClass?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className={`relative h-6.5 w-12 cursor-pointer rounded-full transition-all focus-visible:ring-4 focus-visible:ring-accent/20 ${
        checked ? activeClass : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <motion.span
        animate={{ left: checked ? 24 : 3 }}
        className="absolute top-0.75 h-5 w-5 rounded-full bg-white shadow-sm"
      />
    </button>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-white/30 bg-white/20 p-5 transition-all hover:bg-white/40 dark:border-white/5 dark:bg-white/5 dark:hover:bg-white/10">
      <div className="min-w-0">
        <div className="block text-[0.9em] font-black leading-snug">{label}</div>
        <span className="text-[0.7em] font-bold leading-snug text-zinc-400 opacity-70">
          {description}
        </span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function GeneralSettingsTab({
  labels,
  value,
  interfaceLanguageOptions,
  languageOptions,
  ocrLanguageOptions,
  shortcuts,
  webdav,
  webdavConnection,
  isTestingWebdav,
  isSyncing,
  cacheSize,
  isExportingDiagnostics,
  onChange,
  onToggleAutoLaunch,
  onRecordingChange,
  onWebDavChange,
  onTestWebdav,
  onSync,
  onClearCache,
  onExport,
  onImport,
  onExportDiagnostics,
}: GeneralSettingsTabProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const shortcutItems = [
    {
      label: labels.shortcutLabelQ,
      description: labels.shortcutDescQ,
      value: shortcuts.q,
      id: "q" as const,
    },
    {
      label: labels.shortcutLabelW,
      description: labels.shortcutDescW,
      value: shortcuts.w,
      id: "w" as const,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
        <h3 className="mb-4 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
          {labels.coreSettings}
        </h3>
        <SettingRow label={labels.language} description={labels.interfaceLangDesc}>
          <ThemedSelect
            value={value.lang}
            options={interfaceLanguageOptions}
            onChange={(lang) => onChange({ lang })}
            ariaLabel={labels.language}
            className="w-44"
          />
        </SettingRow>
        <SettingRow label={labels.autoLaunch} description={labels.autoLaunchDesc}>
          <Toggle
            checked={value.autoLaunch}
            label={labels.autoLaunch}
            onClick={onToggleAutoLaunch}
            activeClass="bg-indigo-600 shadow-lg shadow-indigo-500/20"
          />
        </SettingRow>
        <SettingRow label={labels.sourceLang} description={labels.autoDetect}>
          <ThemedSelect
            value={value.sourceLang}
            options={[{ value: "auto", label: labels.autoDetect }, ...languageOptions]}
            onChange={(sourceLang) => onChange({ sourceLang })}
            ariaLabel={labels.sourceLang}
            className="w-44"
          />
        </SettingRow>
        <SettingRow label={labels.targetLang} description={labels.translationOutput}>
          <ThemedSelect
            value={value.targetLang}
            options={languageOptions}
            onChange={(targetLang) => onChange({ targetLang })}
            ariaLabel={labels.targetLang}
            className="w-44"
            accent
          />
        </SettingRow>
        <SettingRow label={labels.ocrLang} description={labels.ocrLangDesc}>
          <ThemedSelect
            value={value.ocrLang}
            options={ocrLanguageOptions}
            onChange={(ocrLang) => onChange({ ocrLang })}
            ariaLabel={labels.ocrLang}
            className="w-44"
          />
        </SettingRow>
        <SettingRow label={labels.autoCopy} description={labels.autoCopyDesc}>
          <Toggle
            checked={value.autoCopy}
            label={labels.autoCopy}
            onClick={() => onChange({ autoCopy: !value.autoCopy })}
          />
        </SettingRow>
        <SettingRow
          label={labels.clipboardMonitor}
          description={labels.clipboardMonitorDesc}
        >
          <Toggle
            checked={value.clipboardMonitor}
            label={labels.clipboardMonitor}
            onClick={() =>
              onChange({ clipboardMonitor: !value.clipboardMonitor })
            }
          />
        </SettingRow>
      </div>

      <div className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
        <h3 className="mb-4 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
          {labels.shortcuts}
        </h3>
        {shortcutItems.map((item) => (
          <SettingRow
            key={item.id}
            label={item.label}
            description={item.description}
          >
            <button
              type="button"
              aria-pressed={shortcuts.recording === item.id}
              onClick={() =>
                onRecordingChange(
                  shortcuts.recording === item.id ? null : item.id,
                )
              }
              className={`min-w-[130px] rounded-2xl border px-4 py-2.5 text-[11px] font-black transition-all ${
                shortcuts.recording === item.id
                  ? "animate-pulse border-accent bg-accent text-white"
                  : "border-black/5 bg-white/60 hover:border-accent/50 dark:border-white/10 dark:bg-white/10"
              }`}
            >
              {shortcuts.recording === item.id
                ? labels.shortcutRecording
                : item.value}
            </button>
          </SettingRow>
        ))}
      </div>

      <button
        type="button"
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((current) => !current)}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-black/10 py-3 text-[10px] font-black text-zinc-400 transition-all hover:border-accent/30 hover:text-accent dark:border-white/10"
      >
        <Settings size={14} />
        {showAdvanced
          ? labels.hideAdvancedSettings
          : labels.showAdvancedSettings}
        <ChevronRight
          size={13}
          className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
        />
      </button>

      {showAdvanced && (
        <>
          <div className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex flex-col">
                <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
                  {labels.cloudSync}
                </h3>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[9px] font-black uppercase text-zinc-400 opacity-60">
                    {labels.lastSync}:
                  </span>
                  <span className="text-[9px] font-black uppercase text-accent">
                    {webdav.lastSyncTime || labels.neverSync}
                  </span>
                </div>
              </div>
              <Toggle
                checked={webdav.enabled}
                label={labels.toggleWebdav}
                onClick={() => onWebDavChange({ enabled: !webdav.enabled })}
                activeClass="bg-green-500 shadow-lg shadow-green-500/20"
              />
            </div>

            <AnimatePresence>
              {webdav.enabled && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-4 overflow-hidden"
                >
                  <div className="rounded-2xl border border-accent/10 bg-accent/5 p-4">
                    <div className="flex gap-3">
                      <Info size={16} className="mt-0.5 shrink-0 text-accent" />
                      <p className="text-[10px] font-bold leading-relaxed text-accent/80">
                        {labels.webdavUrlHelp}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <input
                      value={webdav.url}
                      onChange={(event) =>
                        onWebDavChange({ url: event.target.value })
                      }
                      aria-label={labels.webdavUrl}
                      placeholder={labels.webdavUrl}
                      className="rounded-xl border border-black/5 bg-white/60 px-4 py-3 text-[0.8em] font-bold outline-none placeholder:text-zinc-400 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500"
                    />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <input
                        value={webdav.user}
                        onChange={(event) =>
                          onWebDavChange({ user: event.target.value })
                        }
                        aria-label={labels.webdavUser}
                        placeholder={labels.webdavUser}
                        className="rounded-xl border border-black/5 bg-white/60 px-4 py-3 text-[0.8em] font-bold outline-none placeholder:text-zinc-400 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500"
                      />
                      <input
                        type="password"
                        value={webdav.password}
                        onChange={(event) =>
                          onWebDavChange({ password: event.target.value })
                        }
                        aria-label={labels.webdavPass}
                        placeholder={labels.webdavPass}
                        className="rounded-xl border border-black/5 bg-white/60 px-4 py-3 text-[0.8em] font-bold outline-none placeholder:text-zinc-400 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500"
                      />
                    </div>
                  </div>
                  {webdavConnection && (
                    <div
                      role={webdavConnection.ok ? "status" : "alert"}
                      className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-[10px] font-bold ${
                        webdavConnection.ok
                          ? "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400"
                          : "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {webdavConnection.ok ? (
                        <CheckCircle size={14} />
                      ) : (
                        <AlertCircle size={14} />
                      )}
                      <span>
                        {webdavConnection.ok
                          ? labels.connectionSuccess.replace(
                              "{latency}",
                              String(webdavConnection.latencyMs || 0),
                            )
                          : webDavErrorText(
                              labels,
                              webdavConnection.error?.code,
                              webdavConnection.error?.message ||
                                labels.connectionFailed,
                            )}
                      </span>
                    </div>
                  )}
                  {webdav.lastSyncSummary && (
                    <div className="grid grid-cols-3 gap-2 rounded-2xl border border-black/5 bg-white/35 p-3 dark:border-white/10 dark:bg-white/5">
                      {[
                        {
                          label: labels.syncAdded,
                          value: webdav.lastSyncSummary.added,
                        },
                        {
                          label: labels.syncUpdated,
                          value: webdav.lastSyncSummary.updated,
                        },
                        {
                          label: labels.syncUploaded,
                          value: webdav.lastSyncSummary.uploaded,
                        },
                      ].map((item) => (
                        <div
                          key={item.label}
                          className="rounded-xl bg-white/55 px-2 py-2 text-center dark:bg-black/15"
                        >
                          <div className="text-sm font-black text-accent">
                            {item.value}
                          </div>
                          <div className="text-[8px] font-bold text-zinc-400">
                            {item.label}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={onTestWebdav}
                      disabled={
                        isTestingWebdav || isSyncing || !webdav.url.trim()
                      }
                      className="flex items-center justify-center gap-2 rounded-xl border border-accent/20 bg-accent/10 py-3 text-[10px] font-black text-accent transition-all hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isTestingWebdav ? (
                        <RotateCcw size={14} className="animate-spin" />
                      ) : (
                        <CheckCircle size={14} />
                      )}
                      {isTestingWebdav
                        ? labels.connectionTesting
                        : labels.testConnection}
                    </button>
                    <button
                      type="button"
                      onClick={onSync}
                      disabled={
                        isSyncing || isTestingWebdav || !webdav.url.trim()
                      }
                      className={`flex items-center justify-center gap-2 rounded-xl py-3 text-[10px] font-black transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                        isSyncing
                          ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
                          : "bg-zinc-900 text-white hover:scale-[1.01] dark:bg-white dark:text-zinc-900"
                      }`}
                    >
                      <RotateCcw
                        size={14}
                        className={isSyncing ? "animate-spin" : ""}
                      />
                      {isSyncing ? labels.syncing : labels.syncNow}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
            <h3 className="mb-4 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
              {labels.storage}
            </h3>
            <SettingRow label={labels.cacheSize} description={labels.storageDesc}>
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
            </SettingRow>
            <SettingRow
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
            </SettingRow>
            <SettingRow
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
            </SettingRow>
          </div>
        </>
      )}
    </div>
  );
}
