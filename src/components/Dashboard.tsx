import { lazy, Suspense, useState, useEffect, useMemo, useRef } from "react";
import { Settings, Book, Cpu, Save, CheckCircle, Palette, Monitor, Sparkles, Languages, Clock, Bell, Brain } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import {
  translations,
  translationErrorText,
  webDavErrorText,
  Lang,
} from "../i18n";
import { testTranslationConnection, speak, ConnectionTestResult } from "../services/api";
import { normalizeWebDavError, WebDavConnectionResult, WebDavError, WebDavSyncSummary } from "../services/webdav";
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
import { DashboardTabId, dashboardTabFromNavigation, dashboardTabFromShortcut } from "../services/keyboard";
import { useBatchTranslation } from "../hooks/useBatchTranslation";
import { useWordbook } from "../hooks/useWordbook";
import { useSettings } from "../hooks/useSettings";
import { useClipboardMonitor } from "../hooks/useClipboardMonitor";
import { useShortcutRecorder } from "../hooks/useShortcutRecorder";
import { useSystemMaintenance } from "../hooks/useSystemMaintenance";
import { useNotifications } from "../hooks/useNotifications";

const ReviewTab = lazy(() => import("./ReviewTab"));
const HistoryTab = lazy(() => import("./HistoryTab"));
const ModelConfigTab = lazy(() => import("./ModelConfigTab"));
const AppearanceSettingsTab = lazy(() => import("./AppearanceSettingsTab"));
const GeneralSettingsTab = lazy(() => import("./GeneralSettingsTab"));
const WordbookTab = lazy(() => import("./WordbookTab"));
const BatchTranslationView = lazy(() => import("./BatchTranslationView"));

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
  const [activeTab, setActiveTab] = useState("general");
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
  const [isSyncing, setIsSyncing] = useState(false);
  const [appStats, setAppStats] = useState({ word_count: 0, trans_count: 0, days_active: 1, due_today: 0 });

  // WebDAV Config
  const [isTestingWebdav, setIsTestingWebdav] = useState(false);
  const [webdavConnectionTest, setWebdavConnectionTest] = useState<{ ok: boolean; latencyMs?: number; error?: WebDavError } | null>(null);

  // Translation Model Config
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);
  const refreshStats = async () => {
    try {
      const stats = await invoke<any>("get_app_stats");
      setAppStats(stats);
    } catch (error) {
      console.error(error);
    }
  };

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

  const syncTimerRef = useRef<any>(null);
  const webdavEnabledRef = useRef(webdavEnabled);
  const t = useMemo(() => translations[lang] || translations.zh, [lang]);
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
  const updater = useUpdater({
    labels: t,
    addNotification,
    showToast: toast,
  });
  const translationRef = useRef(t);
  useEffect(() => {
    translationRef.current = t;
  }, [t]);
  useEffect(() => {
    const handleTtsError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      toast("error", `${translationRef.current.ttsPlaybackFailed}${message ? `: ${message}` : ""}`);
    };
    window.addEventListener("tts-error", handleTtsError);
    return () => window.removeEventListener("tts-error", handleTtsError);
  }, []);

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
  useEffect(() => { webdavEnabledRef.current = webdavEnabled; }, [webdavEnabled]);

  // Keyboard shortcuts for tab switching (Ctrl+1..7)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tab = dashboardTabFromShortcut(e);
      if (tab) { e.preventDefault(); setActiveTab(tab); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    loadSettings();
    loadWordbook();
    refreshStats();

    const unlistenWordbook = listen<string>("wordbook-updated", (event) => {
        loadWordbook();
        refreshStats();
        // 1-minute auto sync logic - only for local changes
        if (webdavEnabledRef.current && event.payload === "local") {
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            syncTimerRef.current = setTimeout(() => {
                invoke("sync_wordbook").catch(error => console.error("Background sync failed", error));
            }, 60000); // 1 minute
        }
    });

    const unlistenShortcutError = listen<string>("shortcut-error", (event) => {
        toast("error", `${translationRef.current.runtimeError}: ${event.payload}`);
    });

    const unlistenConfigImport = listen("config-updated", () => {
        loadSettings();
        loadWordbook();
        refreshStats();
        toast("success", translationRef.current.importSuccess);
    });
    const unlistenWebdavSync = listen<WebDavSyncSummary>("webdav-sync-completed", (event) => {
        setLastSyncSummary(event.payload);
        setLastSyncTime(event.payload.completedAt);
    });

    return () => {
        unlistenWordbook.then(f => f());
        unlistenShortcutError.then(f => f());
        unlistenConfigImport.then(f => f());
        unlistenWebdavSync.then(f => f());
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  const handleExport = async () => {
    try {
        const pw = window.prompt(t.exportPassword);
        if (pw === null) return; // User cancelled
        if (!pw.trim()) { toast("warning", t.passwordEmpty); return; }
        await invoke<string>("export_data", { password: pw });
        toast("success", t.exportSuccessMsg);
        addNotification(t.exportSuccess);
    } catch (e: any) {
        if (e !== "User cancelled") {
            toast("error", `${t.exportFailed}: ${e}`);
            addNotification(`${t.exportFailed}: ${e}`);
        }
    }
  };

  const handleImport = async () => {
    try {
        const pw = window.prompt(t.importPassword);
        if (pw === null) return;
        await invoke("import_data", { password: pw || "" });
        setTimeout(() => window.location.reload(), 500);
    } catch (e: any) {
        if (e !== "User cancelled") {
            toast("error", `${t.importFailed}: ${e}`);
            addNotification(`${t.importFailed}: ${e}`);
        }
    }
  };

  const handleClearCache = async () => {
    if (await clearCache()) toast("success", t.cacheCleared);
  };

  const handleWordbookExport = async (format: "csv" | "json") => {
    try {
      await invoke("export_wordbook", { format });
      addNotification(`${t.exportSuccess} (${format.toUpperCase()})`);
    } catch (error) {
      addNotification(`${t.exportFailed}: ${error}`);
    }
  };

  const handleAnkiExport = async () => {
    try {
      const path = await invoke<string>("export_anki");
      toast("success", `${t.exportAnkiSuccess}: ${path}`);
    } catch (error) {
      toast("error", `${t.exportFailed}: ${error}`);
    }
  };

  const handleSpeakWordbookText = (text: string) => {
    void speak(text).then(refreshCacheSize);
  };

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

  const toggleAutoLaunch = async () => {
    const result = await updateAutoLaunch();
    if (result === "denied") {
        toast("warning", t.autoLaunchDenied);
        addNotification(t.autoLaunchDenied);
    } else if (result === "success") {
        toast("success", t.success);
        addNotification(t.success);
    } else if (result === "failed") {
        toast("error", t.autoLaunchFailed);
        addNotification(t.autoLaunchFailed);
    }
  };

  const handleExportDiagnostics = async () => {
    const result = await exportDiagnostics();
    if (result.status === "success") {
      toast("success", t.diagnosticsExportSuccess);
      addNotification(t.diagnosticsExportSuccess);
    } else if (result.status === "failed") {
      const message = `${t.diagnosticsExportFailed}: ${result.error}`;
      toast("error", message);
      addNotification(message);
    }
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const summary = await invoke<WebDavSyncSummary>("sync_wordbook", {
        url: webdavUrl,
        user: webdavUser,
        password: webdavPass,
        enabled: webdavEnabled,
      });
      setLastSyncSummary(summary);
      setLastSyncTime(summary.completedAt);
      toast("success", t.syncSuccess);
      addNotification(t.syncSummary
        .replace("{added}", String(summary.added))
        .replace("{updated}", String(summary.updated))
        .replace("{uploaded}", String(summary.uploaded)));
      await loadWordbook();
    } catch (e) {
      console.error(e);
      const error = normalizeWebDavError(e);
      toast("error", webDavErrorText(t, error.code, error.message || t.syncFailed));
    } finally {
      setIsSyncing(false);
    }
  };

  const handleTestWebdavConnection = async () => {
    if (isTestingWebdav || !webdavUrl.trim()) return;
    setIsTestingWebdav(true);
    setWebdavConnectionTest(null);
    try {
      const result = await invoke<WebDavConnectionResult>("test_webdav_connection", {
        url: webdavUrl,
        user: webdavUser,
        password: webdavPass,
      });
      setWebdavConnectionTest({ ok: true, latencyMs: result.latencyMs });
      toast("success", t.connectionSuccess.replace("{latency}", String(result.latencyMs)));
    } catch (e) {
      const error = normalizeWebDavError(e);
      setWebdavConnectionTest({ ok: false, error });
      toast("error", webDavErrorText(t, error.code, error.message || t.connectionFailed));
    } finally {
      setIsTestingWebdav(false);
    }
  };

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
      setWebdavConnectionTest(null);
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

  const notificationsRef = useRef<HTMLDivElement>(null);
  const prevActiveTab = useRef("general");
  const tabButtonRefs = useRef<Partial<Record<DashboardTabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        closeNotifications();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeNotifications]);

  const tabs = [
    { id: "general", label: t.general, icon: Settings },
    { id: "batch", label: t.batchTranslate, icon: Languages },
    { id: "model", label: t.modelConfig, icon: Cpu },
    { id: "appearance", label: t.appearance, icon: Palette },
    { id: "wordbook", label: t.wordbook, icon: Book },
    { id: "review", label: t.review, icon: Brain },
    { id: "history", label: t.history, icon: Clock },
  ];

  // Compute slide direction for tab transitions
  const tabIds = ["general", "batch", "model", "appearance", "wordbook", "review", "history"];
  const prevIdx = tabIds.indexOf(prevActiveTab.current);
  const currIdx = tabIds.indexOf(activeTab);
  const slideDirection = currIdx >= prevIdx ? 1 : -1;
  prevActiveTab.current = activeTab;

  return (
    <div className="dashboard-shell flex h-dvh min-h-0 apple-gradient-bg text-zinc-900 dark:text-zinc-100 overflow-hidden font-sans select-none transition-colors duration-1000" style={{ fontSize: `${fontSize}px` }}>
      <ToastContainer dismissLabel={t.dismissNotification} />
      {/* Sidebar */}
      <div 
        className="dashboard-sidebar glass border-r border-black/5 dark:border-white/5 flex flex-col min-h-0 z-20 shadow-xl shrink-0"
        style={{ width: '180px', minWidth: '160px' }}
      >
        <div className="dashboard-sidebar-main flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6">
            <div className="dashboard-brand flex items-center gap-3 mb-8 group">
              <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 via-blue-600 to-blue-700 rounded-xl flex items-center justify-center text-white text-lg font-black shadow-lg shadow-accent group-hover:rotate-12 transition-transform duration-500">
                <Sparkles size={20} className="text-white/90" />
              </div>
              <div className="flex flex-col overflow-hidden">
                <span className="text-sm font-black tracking-tighter leading-none mb-1">{t.brandName}</span>
                <span className="text-[8px] font-bold text-zinc-400 uppercase tracking-widest opacity-60">{t.brandEdition}</span>
              </div>
            </div>
            
            <nav className="space-y-1" aria-label={t.mainNavigation}>
              <LayoutGroup id="sidebar">
                {tabs.map((tab) => (
                    <button 
                    key={tab.id} 
                    ref={element => { tabButtonRefs.current[tab.id as DashboardTabId] = element; }}
                    type="button"
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={event => {
                      const next = dashboardTabFromNavigation(tab.id as DashboardTabId, event.key);
                      if (!next) return;
                      event.preventDefault();
                      setActiveTab(next);
                      tabButtonRefs.current[next]?.focus();
                    }}
                    className={`dashboard-nav-item group w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all relative ${
                        activeTab === tab.id ? "text-white" : "hover:bg-black/5 dark:hover:bg-white/5 text-zinc-500"
                    }`}
                    style={{ fontSize: '0.85em' }}
                    >
                    {activeTab === tab.id && (
                        <motion.div 
                        layoutId="activeTabBg" 
                        className="absolute inset-0 bg-accent rounded-xl shadow-lg shadow-accent" 
                        transition={{ type: "spring", bounce: 0.1, duration: 0.5 }} 
                        />
                    )}
                    <span className="relative z-10 flex items-center gap-2.5 font-bold">
                        <tab.icon size={15} className={activeTab === tab.id ? "text-white" : "text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors"} />
                        <span className="truncate">{tab.label}</span>
                    </span>
                    </button>
                ))}
              </LayoutGroup>
            </nav>
        </div>
        
        <div className="dashboard-sidebar-footer shrink-0 p-4 border-t border-black/5 dark:border-white/5">
            <div className="dashboard-stats-card p-4 bg-white/40 dark:bg-white/5 rounded-2xl border border-white/40 dark:border-white/5 space-y-3">
                <div className="dashboard-stat-row flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Book size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">{t.words}</span></div>
                    <span className="text-[10px] font-black text-accent">{appStats.word_count}</span>
                </div>
                <div className="dashboard-stat-row flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Languages size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">{t.translations}</span></div>
                    <span className="text-[10px] font-black text-accent">{appStats.trans_count}</span>
                </div>
                <div className="dashboard-stat-row flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Brain size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">{t.dueToday}</span></div>
                    <span className="text-[10px] font-black text-amber-500">{appStats.due_today || 0}</span>
                </div>
                <div className="dashboard-stat-row flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Monitor size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">{t.streak}</span></div>
                    <span className="text-[10px] font-black text-accent">{appStats.days_active}{t.dayUnit}</span>
                </div>
                <button onClick={() => void updater.checkForUpdate(true)} disabled={updater.isChecking} className="w-full py-2 rounded-xl bg-accent/10 text-accent border border-accent/20 text-[9px] font-black hover:bg-accent/20 transition-all mt-1 disabled:opacity-50">{updater.isChecking ? t.updateChecking : t.checkUpdate}</button>
            </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-transparent relative">
        <header className="dashboard-header h-20 flex items-center justify-between px-10 shrink-0 border-b border-black/5 dark:border-white/5 backdrop-blur-3xl bg-white/30 dark:bg-black/20 z-10">
            <div className="flex flex-col">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-black tracking-tighter bg-gradient-to-r from-zinc-800 to-zinc-500 dark:from-white dark:to-zinc-400 bg-clip-text text-transparent">
                        {tabs.find(t_ => t_.id === activeTab)?.label}
                    </h1>
                    <span className="w-1 h-1 rounded-full bg-accent/40" />
                    <span className="text-[10px] font-black text-accent/60 dark:text-accent/60 tracking-widest uppercase italic">{t.brandCompact}</span>
                </div>
                <p className="dashboard-subtitle text-[9px] text-zinc-400 font-bold uppercase tracking-[0.3em] opacity-60">{t.brandSubtitle}</p>
            </div>
            <div className="flex items-center gap-4">
                {/* Notification Bell */}
                <div ref={notificationsRef} className="relative">
                    <button onClick={toggleNotifications} aria-expanded={isNotificationsOpen} aria-label={t.notifications} className="relative p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                        <Bell size={16} className="text-zinc-400" />
                        {unreadNotificationCount > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 bg-accent rounded-full text-[8px] text-white font-black flex items-center justify-center">{unreadNotificationCount}</span>
                        )}
                    </button>
                    {isNotificationsOpen && notifications.length > 0 && (
                        <div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-zinc-800 rounded-xl shadow-2xl border border-black/5 dark:border-white/10 z-50 overflow-hidden">
                            <div className="p-2 border-b border-black/5 dark:border-white/5 flex items-center justify-between">
                                <span className="text-[9px] font-black text-zinc-400 uppercase tracking-wider px-2">{t.notifications}</span>
                                <button onClick={clearNotifications} className="text-[8px] font-black text-zinc-400 hover:text-red-500 px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">{t.clearAll}</button>
                            </div>
                            <div className="max-h-48 overflow-y-auto">
                                {notifications.map((n, i) => (
                                    <button key={`${n.time}-${i}`} onClick={() => dismissNotification(i)} className="w-full text-left px-3 py-2 text-[10px] text-zinc-600 dark:text-zinc-300 font-medium hover:bg-black/5 dark:hover:bg-white/5 flex items-start gap-2">
                                        <CheckCircle size={10} className="mt-0.5 text-green-500 shrink-0" />
                                        <span className="flex-1">{n.msg}</span>
                                        <span className="text-[8px] text-zinc-400 shrink-0">{n.time}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                {activeTab !== 'wordbook' && activeTab !== 'batch' && (
                    <motion.button whileHover={hasUnsavedChanges ? { scale: 1.02 } : undefined} whileTap={hasUnsavedChanges ? { scale: 0.98 } : undefined} onClick={handleSave} disabled={!hasUnsavedChanges || isSavingSettings} className="flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-full font-black text-[12px] shadow-xl shadow-accent transition-all disabled:bg-zinc-300 dark:disabled:bg-zinc-700 disabled:shadow-none disabled:cursor-not-allowed">
                        {hasUnsavedChanges && !isSavingSettings && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
                        <Save size={14} /> {isSavingSettings ? t.saving : hasUnsavedChanges ? t.saveChanges : t.saved}
                    </motion.button>
                )}
            </div>
        </header>

        <main className="dashboard-main flex-1 min-h-0 overflow-y-auto custom-scrollbar px-10 py-8 relative">
            <AnimatePresence mode="wait">
                <motion.div key={activeTab} initial={{ opacity: 0, x: slideDirection * 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: slideDirection * -24 }} transition={{ type: "spring", stiffness: 300, damping: 30 }} className="h-full min-h-0 flex flex-col">
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
                                onChange={handleGeneralSettingsChange}
                                onToggleAutoLaunch={() => void toggleAutoLaunch()}
                                onRecordingChange={setRecordingKey}
                                onWebDavChange={handleWebDavSettingsChange}
                                onTestWebdav={() => void handleTestWebdavConnection()}
                                onSync={() => void handleSync()}
                                onClearCache={() => void handleClearCache()}
                                onExport={() => void handleExport()}
                                onImport={() => void handleImport()}
                                onExportDiagnostics={() => void handleExportDiagnostics()}
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
                                onSpeak={handleSpeakWordbookText}
                                onExport={(format) => void handleWordbookExport(format)}
                                onExportAnki={() => void handleAnkiExport()}
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
                </motion.div>
            </AnimatePresence>
        </main>
      </div>
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
