import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle,
  Info,
  RotateCcw,
} from "lucide-react";
import {
  webDavErrorText,
  type TranslationCatalog,
} from "../i18n";
import { SettingsToggle } from "./GeneralSettingsControls";
import type {
  WebDavConnectionState,
  WebDavSettingsPatch,
  WebDavSettingsValue,
} from "./generalSettingsTypes";

interface GeneralSettingsWebDavSectionProps {
  labels: TranslationCatalog;
  webdav: WebDavSettingsValue;
  webdavConnection: WebDavConnectionState | null;
  isTestingWebdav: boolean;
  isSyncing: boolean;
  onChange: (patch: WebDavSettingsPatch) => void;
  onTest: () => void;
  onSync: () => void;
}

export default function GeneralSettingsWebDavSection({
  labels,
  webdav,
  webdavConnection,
  isTestingWebdav,
  isSyncing,
  onChange,
  onTest,
  onSync,
}: GeneralSettingsWebDavSectionProps) {
  return (
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
        <SettingsToggle
          checked={webdav.enabled}
          label={labels.toggleWebdav}
          onClick={() => onChange({ enabled: !webdav.enabled })}
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
                onChange={(event) => onChange({ url: event.target.value })}
                aria-label={labels.webdavUrl}
                placeholder={labels.webdavUrl}
                className="rounded-xl border border-black/5 bg-white/60 px-4 py-3 text-[0.8em] font-bold outline-none placeholder:text-zinc-400 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500"
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  value={webdav.user}
                  onChange={(event) => onChange({ user: event.target.value })}
                  aria-label={labels.webdavUser}
                  placeholder={labels.webdavUser}
                  className="rounded-xl border border-black/5 bg-white/60 px-4 py-3 text-[0.8em] font-bold outline-none placeholder:text-zinc-400 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500"
                />
                <input
                  type="password"
                  value={webdav.password}
                  onChange={(event) =>
                    onChange({ password: event.target.value })
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
                        webdavConnection.error?.message
                          || labels.connectionFailed,
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
                onClick={onTest}
                disabled={isTestingWebdav || isSyncing || !webdav.url.trim()}
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
                disabled={isSyncing || isTestingWebdav || !webdav.url.trim()}
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
  );
}
