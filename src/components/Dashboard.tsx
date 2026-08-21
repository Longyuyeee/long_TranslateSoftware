import { lazy, Suspense, useCallback, useState, useEffect, useMemo } from "react";
import { getVersion } from "@tauri-apps/api/app";
import packageMetadata from "../../package.json";
import {
  translations,
  translationErrorText,
  Lang,
} from "../i18n";
import { testTranslationConnection, ConnectionTestResult } from "../services/api";
import { useUpdater } from "../hooks/useUpdater";
import { ToastContainer, toast } from "./Toast";
import UpdateDialog from "./UpdateDialog";
import type {
  TranslationModelPatch,
  TtsModelConfig,
} from "./ModelConfigTab";
import type { AppearanceConfigPatch } from "./AppearanceSettingsTab";
import type {
  GeneralSettingsPatch,
  WebDavSettingsPatch,
} from "./GeneralSettingsTab";
import type { DashboardTabId } from "../services/keyboard";
import { useBatchTranslation } from "../hooks/useBatchTranslation";
import { useWordbook } from "../hooks/useWordbook";
import { useSettings } from "../hooks/useSettings";
import { useClipboardMonitor } from "../hooks/useClipboardMonitor";
import { useShortcutRecorder } from "../hooks/useShortcutRecorder";
import { useSystemMaintenance } from "../hooks/useSystemMaintenance";
import { useNotifications } from "../hooks/useNotifications";
import { useAppStats, useDashboardSync } from "../hooks/useDashboardSync";
import { useDashboardActions } from "../hooks/useDashboardActions";
import DashboardShell from "./DashboardShell";
import BrowserPairingDialog from "./BrowserPairingDialog";
import { useBrowserPairing } from "../hooks/useBrowserPairing";
import { useBrowserTranslationBridge } from "../hooks/useBrowserTranslationBridge";

const ReviewTab = lazy(() => import("./ReviewTab"));
const HistoryTab = lazy(() => import("./HistoryTab"));
const ModelConfigTab = lazy(() => import("./ModelConfigTab"));
const AppearanceSettingsTab = lazy(() => import("./AppearanceSettingsTab"));
const GeneralSettingsTab = lazy(() => import("./GeneralSettingsTab"));
const WordbookTab = lazy(() => import("./WordbookTab"));
const BatchTranslationView = lazy(() => import("./BatchTranslationView"));
const DocumentWorkbench = lazy(() => import("./DocumentWorkbench"));

const LANGUAGES = [
  "Chinese", "English", "Japanese", "Korean", "French", "German",
  "Spanish", "Portuguese", "Russian", "Arabic", "Italian", "Dutch",
  "Thai", "Vietnamese", "Indonesian", "Hindi", "Turkish", "Polish",
  "Swedish", "Danish", "Norwegian", "Finnish", "Greek", "Czech",
  "Romanian", "Hungarian", "Hebrew", "Ukrainian", "Catalan", "Slovak",
] as const;

const OCR_LANGUAGES = [
  { value: "zh-Hans", language: "Chinese" },
  { value: "en", language: "English" },
  { value: "ja", language: "Japanese" },
  { value: "ko", language: "Korean" },
  { value: "fr", language: "French" },
  { value: "de", language: "German" },
  { value: "es", language: "Spanish" },
  { value: "pt", language: "Portuguese" },
  { value: "ru", language: "Russian" },
  { value: "ar", language: "Arabic" },
  { value: "it", language: "Italian" },
  { value: "nl", language: "Dutch" },
  { value: "th", language: "Thai" },
  { value: "vi", language: "Vietnamese" },
  { value: "id", language: "Indonesian" },
  { value: "hi", language: "Hindi" },
  { value: "tr", language: "Turkish" },
  { value: "pl", language: "Polish" },
  { value: "sv", language: "Swedish" },
  { value: "da", language: "Danish" },
  { value: "nb-NO", language: "Norwegian" },
  { value: "fi", language: "Finnish" },
  { value: "el", language: "Greek" },
  { value: "cs", language: "Czech" },
  { value: "ro", language: "Romanian" },
  { value: "hu", language: "Hungarian" },
  { value: "he", language: "Hebrew" },
  { value: "uk", language: "Ukrainian" },
  { value: "ca", language: "Catalan" },
  { value: "sk", language: "Slovak" },
] as const;

export default function Dashboard() {
  useBrowserTranslationBridge();
  const [activeTab, setActiveTab] = useState<DashboardTabId>("general");
  const [appVersion, setAppVersion] = useState(packageMetadata.version);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let isActive = true;
    void getVersion()
      .then((version) => {
        if (isActive) setAppVersion(version);
      })
      .catch(() => {
        // The packaged metadata stays as a safe fallback if runtime lookup fails.
      });

    return () => {
      isActive = false;
    };
  }, []);
  const {
    lang,
    setLang,
    targetLang,
    setTargetLang,
    sourceLang,
    setSourceLang,
    autoCopy,
    setAutoCopy,
    clipboardMonitor,
    setClipboardMonitor,
    theme,
    setTheme,
    accentColor,
    setAccentColor,
    fontSize,
    setFontSize,
    webdavEnabled,
    setWebdavEnabled,
    webdavUrl,
    setWebdavUrl,
    webdavUser,
    setWebdavUser,
    webdavPass,
    setWebdavPass,
    shortcutQ,
    setShortcutQ,
    shortcutW,
    setShortcutW,
    transApiKey,
    setTransApiKey,
    transBaseUrl,
    setTransBaseUrl,
    transModelName,
    setTransModelName,
    customPrompt,
    setCustomPrompt,
    translationProvider,
    applyTranslationProvider,
    backupApiKey,
    setBackupApiKey,
    backupBaseUrl,
    setBackupBaseUrl,
    backupModelName,
    setBackupModelName,
    ocrLang,
    setOcrLang,
    installedOcrLanguages,
    ttsEngine,
    setTtsEngine,
    ttsApiKey,
    setTtsApiKey,
    ttsBaseUrl,
    setTtsBaseUrl,
    ttsModelName,
    setTtsModelName,
    ttsVoice,
    setTtsVoice,
    ttsSpeed,
    setTtsSpeed,
    autoLaunch,
    setAutoLaunch,
    lastSyncTime,
    setLastSyncTime,
    lastSyncSummary,
    setLastSyncSummary,
    hasUnsavedChanges,
    isSavingSettings,
    loadSettings,
    saveSettings,
  } = useSettings();

  const {
    notifications,
    unreadNotificationCount,
    isNotificationsOpen,
    addNotification,
    toggleNotifications,
    closeNotifications,
    dismissNotification,
    clearNotifications,
  } = useNotifications();
  const { appStats, refreshStats } = useAppStats();

  // Translation Model Config
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);

  const {
    words,
    selectedWord,
    setSelectedWord,
    wordbookTotal,
    wordbookHasMore,
    isWordbookLoading,
    wordbookSearch,
    setWordbookSearch,
    wordbookSort,
    setWordbookSort,
    newWord,
    setNewWord,
    isAdding,
    setIsAdding,
    loadWordbook,
    loadMore,
    deleteWord,
    addManualWord,
    cancelAdding,
    retrySelectedAnalysis,
  } = useWordbook({ onChanged: refreshStats });

  // Batch Translator state
  const {
    batchInput,
    setBatchInput,
    batchOutput,
    batchOutputBackup,
    compareMode,
    setCompareModeEnabled,
    batchBackTranslation,
    isBatchBackTranslating,
    isTranslating,
    batchTaskState,
    primaryComparisonState,
    backupComparisonState,
    startBatchTranslation,
    startCompareTranslation,
    startBatchBackTranslate,
    cancelBatchWork,
  } = useBatchTranslation({
    sourceLang,
    targetLang,
    onCompleted: refreshStats,
  });

  const t = useMemo(() => translations[lang] || translations.zh, [lang]);
  const handleBrowserPairingError = useCallback(
    () => toast("error", t.browserPairingFailed),
    [t],
  );
  const browserPairing = useBrowserPairing({
    onError: handleBrowserPairingError,
  });
  const {
    isSyncing,
    isTestingWebdav,
    webdavConnectionTest,
    sync: syncWebdav,
    testConnection: testWebdavConnection,
    resetConnectionTest: resetWebdavConnectionTest,
  } = useDashboardSync({
    labels: t,
    webdav: {
      enabled: webdavEnabled,
      url: webdavUrl,
      user: webdavUser,
      password: webdavPass,
    },
    loadSettings,
    loadWordbook,
    refreshStats,
    setLastSyncTime,
    setLastSyncSummary,
    addNotification,
    showToast: toast,
  });
  const { recordingKey, setRecordingKey } = useShortcutRecorder({
    onUpdated: (action, shortcut) => {
      if (action === "q") setShortcutQ(shortcut);
      else setShortcutW(shortcut);
    },
    onResult: (result) => {
      if (result.status === "success") {
        toast("success", t.shortcutUpdated);
        addNotification(t.shortcutUpdated);
      } else {
        const message = `${t.shortcutFailed}: ${result.error}`;
        toast("error", message);
        addNotification(message);
      }
    },
  });
  const {
    cacheSize,
    isExportingDiagnostics,
    refreshCacheSize,
    clearCache,
    toggleAutoLaunch: updateAutoLaunch,
    exportDiagnostics,
  } = useSystemMaintenance({ setAutoLaunch });
  const dashboardActions = useDashboardActions({
    labels: t, addNotification, showToast: toast, clearCache,
    refreshCacheSize, updateAutoLaunch, exportDiagnostics,
  });
  const updater = useUpdater({
    labels: t,
    addNotification,
    showToast: toast,
  });
  const languageOptions = useMemo(
    () => LANGUAGES.map(value => ({ value, label: t.languageNames[value] || value })),
    [t],
  );
  const interfaceLanguageOptions = useMemo(
    () => [
      { value: "zh" as Lang, label: t.simplifiedChinese },
      { value: "en" as Lang, label: t.english },
    ],
    [t],
  );
  const ocrLanguageOptions = useMemo(
    () => {
      const detected = installedOcrLanguages?.length
        ? installedOcrLanguages.map(language => ({
          value: language.tag,
          label: `${language.native_name || language.display_name || language.tag} (${language.tag})`,
        }))
        : OCR_LANGUAGES.map(option => ({
          value: option.value,
          label: t.languageNames[option.language] || option.language,
        }));
      return [{ value: "auto", label: t.systemDefault }, ...detected];
    },
    [installedOcrLanguages, t],
  );
  // Accent color effect
  const applyAccent = (color: string) => {
    document.documentElement.style.setProperty("--accent", color);
  };

  useEffect(() => {
    applyAccent(accentColor);
  }, [accentColor]);

  useClipboardMonitor(clipboardMonitor);

  // Theme effect
  useEffect(() => {
    const applyTheme = () => {
      const root = document.documentElement;
      const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      if (isDark) {
        root.classList.add("dark");
        root.classList.remove("light");
      } else {
        root.classList.add("light");
        root.classList.remove("dark");
      }
    };
    applyTheme();
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => { if (theme === "system") applyTheme(); };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [theme]);

  const handleTestTranslationConnection = async () => {
    if (isTestingConnection) return;
    setIsTestingConnection(true);
    setConnectionTest(null);
    const result = await testTranslationConnection({ apiKey: transApiKey, baseUrl: transBaseUrl, model: transModelName });
    setConnectionTest(result);
    setIsTestingConnection(false);
    if (result.ok) toast("success", t.connectionSuccess.replace("{latency}", String(result.latencyMs || 0)));
    else toast("error", translationErrorText(t, result.error?.code, result.error?.message || t.connectionFailed));
  };

  const handleTranslationConfigChange = (patch: TranslationModelPatch) => {
    if (patch.apiKey !== undefined) setTransApiKey(patch.apiKey);
    if (patch.baseUrl !== undefined) setTransBaseUrl(patch.baseUrl);
    if (patch.modelName !== undefined) setTransModelName(patch.modelName);
    if (patch.customPrompt !== undefined) setCustomPrompt(patch.customPrompt);
    if (patch.backupApiKey !== undefined) setBackupApiKey(patch.backupApiKey);
    if (patch.backupBaseUrl !== undefined) setBackupBaseUrl(patch.backupBaseUrl);
    if (patch.backupModelName !== undefined) setBackupModelName(patch.backupModelName);
    if (patch.apiKey !== undefined || patch.baseUrl !== undefined || patch.modelName !== undefined) {
      setConnectionTest(null);
    }
  };

  const handleTtsConfigChange = (patch: Partial<TtsModelConfig>) => {
    if (patch.engine !== undefined) setTtsEngine(patch.engine);
    if (patch.apiKey !== undefined) setTtsApiKey(patch.apiKey);
    if (patch.baseUrl !== undefined) setTtsBaseUrl(patch.baseUrl);
    if (patch.modelName !== undefined) setTtsModelName(patch.modelName);
    if (patch.voice !== undefined) setTtsVoice(patch.voice);
    if (patch.speed !== undefined) setTtsSpeed(patch.speed);
  };

  const handleAppearanceChange = (patch: AppearanceConfigPatch) => {
    if (patch.theme !== undefined) setTheme(patch.theme);
    if (patch.accentColor !== undefined) setAccentColor(patch.accentColor);
    if (patch.fontSize !== undefined) setFontSize(patch.fontSize);
  };

  const handleGeneralSettingsChange = (patch: GeneralSettingsPatch) => {
    if (patch.lang !== undefined) setLang(patch.lang);
    if (patch.sourceLang !== undefined) setSourceLang(patch.sourceLang);
    if (patch.targetLang !== undefined) setTargetLang(patch.targetLang);
    if (patch.ocrLang !== undefined) setOcrLang(patch.ocrLang);
    if (patch.autoCopy !== undefined) setAutoCopy(patch.autoCopy);
    if (patch.clipboardMonitor !== undefined) {
      setClipboardMonitor(patch.clipboardMonitor);
    }
  };

  const handleWebDavSettingsChange = (patch: WebDavSettingsPatch) => {
    if (patch.enabled !== undefined) setWebdavEnabled(patch.enabled);
    if (patch.url !== undefined) setWebdavUrl(patch.url);
    if (patch.user !== undefined) setWebdavUser(patch.user);
    if (patch.password !== undefined) setWebdavPass(patch.password);
    if (
      patch.url !== undefined ||
      patch.user !== undefined ||
      patch.password !== undefined
    ) {
      resetWebdavConnectionTest();
    }
  };

  const handleSave = async () => {
    const result = await saveSettings();
    if (result === "saved") {
      toast("success", t.success);
      addNotification(t.success);
    } else if (result === "failed") {
      toast("error", t.settingsSaveFailed);
    }
  };

  return (
    <div className="dashboard-shell flex h-dvh min-h-0 apple-gradient-bg text-zinc-900 dark:text-zinc-100 overflow-hidden font-sans select-none transition-colors duration-1000" style={{ fontSize: `${fontSize}px` }}>
      <ToastContainer dismissLabel={t.dismissNotification} />
      <BrowserPairingDialog
        labels={t}
        request={browserPairing.pendingRequest}
        isUpdating={browserPairing.isUpdating}
        onApprove={() => void browserPairing.approve()}
        onReject={() => void browserPairing.reject()}
      />
      <DashboardShell
        labels={t}
        appVersion={appVersion}
        activeTab={activeTab}
        stats={appStats}
        notifications={notifications}
        unreadNotificationCount={unreadNotificationCount}
        isNotificationsOpen={isNotificationsOpen}
        hasUnsavedChanges={hasUnsavedChanges}
        isSavingSettings={isSavingSettings}
        isCheckingUpdate={updater.isChecking}
        onTabChange={setActiveTab}
        onToggleNotifications={toggleNotifications}
        onCloseNotifications={closeNotifications}
        onDismissNotification={dismissNotification}
        onClearNotifications={clearNotifications}
        onSave={() => void handleSave()}
        onCheckUpdate={() => void updater.checkForUpdate(true)}
      >
                    {activeTab === "general" && (
                        <Suspense fallback={<div className="h-64 animate-pulse rounded-[28px] bg-black/5 dark:bg-white/5" />}>
                            <GeneralSettingsTab
                                labels={t}
                                value={{
                                    lang,
                                    autoLaunch,
                                    sourceLang,
                                    targetLang,
                                    ocrLang,
                                    autoCopy,
                                    clipboardMonitor,
                                }}
                                interfaceLanguageOptions={interfaceLanguageOptions}
                                languageOptions={languageOptions}
                                ocrLanguageOptions={ocrLanguageOptions}
                                shortcuts={{ q: shortcutQ, w: shortcutW, recording: recordingKey }}
                                webdav={{
                                    enabled: webdavEnabled,
                                    url: webdavUrl,
                                    user: webdavUser,
                                    password: webdavPass,
                                    lastSyncTime,
                                    lastSyncSummary,
                                }}
                                webdavConnection={webdavConnectionTest}
                                isTestingWebdav={isTestingWebdav}
                                isSyncing={isSyncing}
                                cacheSize={cacheSize}
                                isExportingDiagnostics={isExportingDiagnostics}
                                browserPairings={browserPairing.pairings}
                                isUpdatingBrowserPairing={browserPairing.isUpdating}
                                onChange={handleGeneralSettingsChange}
                                onToggleAutoLaunch={() => void dashboardActions.toggleAutoLaunch()}
                                onRecordingChange={setRecordingKey}
                                onWebDavChange={handleWebDavSettingsChange}
                                onTestWebdav={() => void testWebdavConnection()}
                                onSync={() => void syncWebdav()}
                                onClearCache={() => void dashboardActions.clearAudioCache()}
                                onExport={() => void dashboardActions.exportData()}
                                onImport={() => void dashboardActions.importData()}
                                onExportDiagnostics={() => void dashboardActions.exportDiagnosticReport()}
                                onRevokeBrowserPairing={(pairingId) => void browserPairing.revoke(pairingId)}
                            />
                        </Suspense>
                    )}

                    {activeTab === "batch" && (
                        <Suspense
                            fallback={(
                                <div className="flex h-full items-center justify-center" role="status" aria-label={t.loading}>
                                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent" />
                                </div>
                            )}
                        >
                            <BatchTranslationView
                                labels={t}
                                languageOptions={languageOptions}
                                sourceLang={sourceLang}
                                targetLang={targetLang}
                                primaryModelName={transModelName}
                                backupModelName={backupModelName}
                                batchInput={batchInput}
                                batchOutput={batchOutput}
                                batchOutputBackup={batchOutputBackup}
                                compareMode={compareMode}
                                batchBackTranslation={batchBackTranslation}
                                isBatchBackTranslating={isBatchBackTranslating}
                                isTranslating={isTranslating}
                                batchTaskState={batchTaskState}
                                primaryComparisonState={primaryComparisonState}
                                backupComparisonState={backupComparisonState}
                                onSourceLanguageChange={setSourceLang}
                                onTargetLanguageChange={setTargetLang}
                                onInputChange={setBatchInput}
                                onTranslate={startBatchTranslation}
                                onCompareTranslate={startCompareTranslation}
                                onBackTranslate={startBatchBackTranslate}
                                onCancel={cancelBatchWork}
                                onCompareModeChange={setCompareModeEnabled}
                            />
                        </Suspense>
                    )}

                    {activeTab === "document" && (
                        <Suspense
                            fallback={(
                                <div className="flex h-full items-center justify-center" role="status" aria-label={t.loading}>
                                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent" />
                                </div>
                            )}
                        >
                            <DocumentWorkbench labels={t} />
                        </Suspense>
                    )}

                    {activeTab === "model" && (
                        <Suspense
                            fallback={(
                                <div className="flex h-full items-center justify-center" role="status" aria-label={t.loading}>
                                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent" />
                                </div>
                            )}
                        >
                            <ModelConfigTab
                                labels={t}
                                translation={{
                                    providerId: translationProvider,
                                    apiKey: transApiKey,
                                    baseUrl: transBaseUrl,
                                    modelName: transModelName,
                                    customPrompt,
                                    backupApiKey,
                                    backupBaseUrl,
                                    backupModelName,
                                }}
                                tts={{
                                    engine: ttsEngine,
                                    apiKey: ttsApiKey,
                                    baseUrl: ttsBaseUrl,
                                    modelName: ttsModelName,
                                    voice: ttsVoice,
                                    speed: ttsSpeed,
                                }}
                                connectionTest={connectionTest}
                                isTestingConnection={isTestingConnection}
                                onProviderChange={(providerId) => {
                                    applyTranslationProvider(providerId);
                                    setConnectionTest(null);
                                }}
                                onTranslationChange={handleTranslationConfigChange}
                                onTtsChange={handleTtsConfigChange}
                                onTestConnection={() => void handleTestTranslationConnection()}
                            />
                        </Suspense>
                    )}

                    {activeTab === "appearance" && (
                        <Suspense fallback={<div className="h-64 animate-pulse rounded-[28px] bg-black/5 dark:bg-white/5" />}>
                            <AppearanceSettingsTab
                                labels={t}
                                value={{ theme, accentColor, fontSize }}
                                onChange={handleAppearanceChange}
                            />
                        </Suspense>
                    )}

                    {activeTab === "wordbook" && (
                        <Suspense fallback={<div className="h-full min-h-80 animate-pulse rounded-[32px] bg-black/5 dark:bg-white/5" />}>
                            <WordbookTab
                                labels={t}
                                words={words}
                                selectedWord={selectedWord}
                                total={wordbookTotal}
                                hasMore={wordbookHasMore}
                                isLoading={isWordbookLoading}
                                search={wordbookSearch}
                                sort={wordbookSort}
                                newWord={newWord}
                                isAdding={isAdding}
                                onSearchChange={setWordbookSearch}
                                onSortChange={setWordbookSort}
                                onSelectWord={setSelectedWord}
                                onStartAdding={() => setIsAdding(true)}
                                onNewWordChange={setNewWord}
                                onAddWord={() => void addManualWord()}
                                onCancelAdding={cancelAdding}
                                onLoadMore={loadMore}
                                onDeleteWord={(id) => void deleteWord(id)}
                                onRetryAnalysis={() => void retrySelectedAnalysis()}
                                onSpeak={dashboardActions.speakWordbookText}
                                onExport={(format) => void dashboardActions.exportWordbook(format)}
                                onExportAnki={() => void dashboardActions.exportAnki()}
                            />
                        </Suspense>
                    )}

                    {activeTab === "review" && (
                        <Suspense
                            fallback={(
                                <div className="flex h-full items-center justify-center" role="status" aria-label={t.loading}>
                                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent" />
                                </div>
                            )}
                        >
                            <ReviewTab lang={lang} onRefreshStats={refreshStats} />
                        </Suspense>
                    )}

                    {activeTab === "history" && (
                        <Suspense
                            fallback={(
                                <div className="flex h-full items-center justify-center" role="status" aria-label={t.loading}>
                                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent" />
                                </div>
                            )}
                        >
                            <HistoryTab labels={t} />
                        </Suspense>
                    )}
      </DashboardShell>
      <UpdateDialog
        open={updater.dialogOpen}
        version={updater.pendingUpdate?.version || ""}
        notes={updater.pendingUpdate?.body}
        phase={updater.phase}
        progress={updater.progress}
        error={updater.error}
        labels={t}
        onInstall={() => void updater.installUpdate()}
        onClose={updater.dismissUpdate}
      />
    </div>
  );
}
