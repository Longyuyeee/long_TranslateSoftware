import { useState } from "react";
import { ChevronRight, Settings } from "lucide-react";
import type { Lang, TranslationCatalog } from "../i18n";
import ThemedSelect, { type ThemedSelectOption } from "./ThemedSelect";
import {
  SettingsRow,
  SettingsToggle,
} from "./GeneralSettingsControls";
import GeneralSettingsMaintenanceSection from "./GeneralSettingsMaintenanceSection";
import GeneralSettingsShortcutsSection from "./GeneralSettingsShortcutsSection";
import GeneralSettingsWebDavSection from "./GeneralSettingsWebDavSection";
import GeneralSettingsBrowserPairingSection from "./GeneralSettingsBrowserPairingSection";
import type { BrowserPairingRecord } from "../services/browserPairing";
import type {
  GeneralSettingsPatch,
  GeneralSettingsValue,
  ShortcutSettingsValue,
  WebDavConnectionState,
  WebDavSettingsPatch,
  WebDavSettingsValue,
} from "./generalSettingsTypes";

export type {
  GeneralSettingsPatch,
  GeneralSettingsValue,
  ShortcutSettingsValue,
  WebDavConnectionState,
  WebDavSettingsPatch,
  WebDavSettingsValue,
} from "./generalSettingsTypes";

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
  browserPairings: BrowserPairingRecord[];
  isUpdatingBrowserPairing: boolean;
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
  onRevokeBrowserPairing: (pairingId: string) => void;
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
  browserPairings,
  isUpdatingBrowserPairing,
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
  onRevokeBrowserPairing,
}: GeneralSettingsTabProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
        <h3 className="mb-4 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
          {labels.coreSettings}
        </h3>
        <SettingsRow
          label={labels.language}
          description={labels.interfaceLangDesc}
        >
          <ThemedSelect
            value={value.lang}
            options={interfaceLanguageOptions}
            onChange={(lang) => onChange({ lang })}
            ariaLabel={labels.language}
            className="w-44"
          />
        </SettingsRow>
        <SettingsRow
          label={labels.autoLaunch}
          description={labels.autoLaunchDesc}
        >
          <SettingsToggle
            checked={value.autoLaunch}
            label={labels.autoLaunch}
            onClick={onToggleAutoLaunch}
            activeClass="bg-indigo-600 shadow-lg shadow-indigo-500/20"
          />
        </SettingsRow>
        <SettingsRow label={labels.sourceLang} description={labels.autoDetect}>
          <ThemedSelect
            value={value.sourceLang}
            options={[
              { value: "auto", label: labels.autoDetect },
              ...languageOptions,
            ]}
            onChange={(sourceLang) => onChange({ sourceLang })}
            ariaLabel={labels.sourceLang}
            className="w-44"
          />
        </SettingsRow>
        <SettingsRow
          label={labels.targetLang}
          description={labels.translationOutput}
        >
          <ThemedSelect
            value={value.targetLang}
            options={languageOptions}
            onChange={(targetLang) => onChange({ targetLang })}
            ariaLabel={labels.targetLang}
            className="w-44"
            accent
          />
        </SettingsRow>
        <SettingsRow label={labels.ocrLang} description={labels.ocrLangDesc}>
          <ThemedSelect
            value={value.ocrLang}
            options={ocrLanguageOptions}
            onChange={(ocrLang) => onChange({ ocrLang })}
            ariaLabel={labels.ocrLang}
            className="w-44"
          />
        </SettingsRow>
        <SettingsRow label={labels.autoCopy} description={labels.autoCopyDesc}>
          <SettingsToggle
            checked={value.autoCopy}
            label={labels.autoCopy}
            onClick={() => onChange({ autoCopy: !value.autoCopy })}
          />
        </SettingsRow>
        <SettingsRow
          label={labels.clipboardMonitor}
          description={labels.clipboardMonitorDesc}
        >
          <SettingsToggle
            checked={value.clipboardMonitor}
            label={labels.clipboardMonitor}
            onClick={() =>
              onChange({ clipboardMonitor: !value.clipboardMonitor })
            }
          />
        </SettingsRow>
      </div>

      <GeneralSettingsShortcutsSection
        labels={labels}
        shortcuts={shortcuts}
        onRecordingChange={onRecordingChange}
      />

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
          <GeneralSettingsBrowserPairingSection
            labels={labels}
            pairings={browserPairings}
            isUpdating={isUpdatingBrowserPairing}
            onRevoke={onRevokeBrowserPairing}
          />
          <GeneralSettingsWebDavSection
            labels={labels}
            webdav={webdav}
            webdavConnection={webdavConnection}
            isTestingWebdav={isTestingWebdav}
            isSyncing={isSyncing}
            onChange={onWebDavChange}
            onTest={onTestWebdav}
            onSync={onSync}
          />
          <GeneralSettingsMaintenanceSection
            labels={labels}
            cacheSize={cacheSize}
            isExportingDiagnostics={isExportingDiagnostics}
            onClearCache={onClearCache}
            onExport={onExport}
            onImport={onImport}
            onExportDiagnostics={onExportDiagnostics}
          />
        </>
      )}
    </div>
  );
}
