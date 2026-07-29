import { lazy, Suspense, useState, useEffect, useMemo, useRef } from "react";
import { Settings, Book, Cpu, Save, CheckCircle, Palette, Monitor, Sparkles, ExternalLink, Languages, Copy, X as CloseIcon, Clock, Bell, Brain, ArrowLeftRight, CircleStop, AlertCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
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
import ThemedSelect from "./ThemedSelect";
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

const ReviewTab = lazy(() => import("./ReviewTab"));
const HistoryTab = lazy(() => import("./HistoryTab"));
const ModelConfigTab = lazy(() => import("./ModelConfigTab"));
const AppearanceSettingsTab = lazy(() => import("./AppearanceSettingsTab"));
const GeneralSettingsTab = lazy(() => import("./GeneralSettingsTab"));
const WordbookTab = lazy(() => import("./WordbookTab"));

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

  const [notifications, setNotifications] = useState<{msg: string; time: string}[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const isNotificationsOpenRef = useRef(false);

  const addNotification = (msg: string) => {
    if (!msg) return;
    const time = new Date().toLocaleTimeString();
    setNotifications(prev => [{msg, time}, ...prev].slice(0, 10));
    if (!isNotificationsOpenRef.current) {
      setUnreadNotificationCount(prev => Math.min(prev + 1, 99));
    }
  };

  const toggleNotifications = () => {
    const next = notifications.length > 0 && !isNotificationsOpenRef.current;
    isNotificationsOpenRef.current = next;
    setIsNotificationsOpen(next);
    if (next || notifications.length === 0) setUnreadNotificationCount(0);
  };

  const dismissNotification = (index: number) => {
    setNotifications(prev => prev.filter((_, itemIndex) => itemIndex !== index));
    if (notifications.length <= 1) {
      isNotificationsOpenRef.current = false;
      setIsNotificationsOpen(false);
    }
  };

  const clearNotifications = () => {
    setNotifications([]);
    setUnreadNotificationCount(0);
    isNotificationsOpenRef.current = false;
    setIsNotificationsOpen(false);
  };
  const [isSyncing, setIsSyncing] = useState(false);
  const [cacheSize, setCacheSize] = useState("0 B");
  const [appStats, setAppStats] = useState({ word_count: 0, trans_count: 0, days_active: 1, due_today: 0 });

  // WebDAV Config
  const [isTestingWebdav, setIsTestingWebdav] = useState(false);
  const [webdavConnectionTest, setWebdavConnectionTest] = useState<{ ok: boolean; latencyMs?: number; error?: WebDavError } | null>(null);

  // Shortcuts
  const [recordingKey, setRecordingKey] = useState<"q" | "w" | null>(null);

  // Translation Model Config
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);
  const [isExportingDiagnostics, setIsExportingDiagnostics] = useState(false);
  // Glossary state
  interface GlossaryEntry { id: number; source_term: string; target_term: string; created_at: string; }
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [newSourceTerm, setNewSourceTerm] = useState("");
  const [newTargetTerm, setNewTargetTerm] = useState("");
  const [editingGlossaryId, setEditingGlossaryId] = useState<number | null>(null);
  const [editSourceTerm, setEditSourceTerm] = useState("");
  const [editTargetTerm, setEditTargetTerm] = useState("");

  const loadGlossary = async () => {
    try { setGlossary(await invoke<GlossaryEntry[]>("get_glossary_entries")); } catch { /* empty */ }
  };

  const addGlossaryEntry = async () => {
    if (!newSourceTerm.trim() || !newTargetTerm.trim()) return;
    await invoke("add_glossary_entry", { sourceTerm: newSourceTerm.trim(), targetTerm: newTargetTerm.trim() });
    setNewSourceTerm("");
    setNewTargetTerm("");
    await loadGlossary();
  };

  const deleteGlossaryEntry = async (id: number) => {
    await invoke("delete_glossary_entry", { id });
    await loadGlossary();
  };

  const saveEditGlossaryEntry = async () => {
    if (editingGlossaryId === null || !editSourceTerm.trim() || !editTargetTerm.trim()) return;
    await invoke("update_glossary_entry", { id: editingGlossaryId, sourceTerm: editSourceTerm.trim(), targetTerm: editTargetTerm.trim() });
    setEditingGlossaryId(null);
    await loadGlossary();
  };

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

  const batchStatusText = batchTaskState.phase === "loading-config" ? t.translationPreparing
    : batchTaskState.phase === "checking-cache" ? t.translationCheckingCache
      : batchTaskState.phase === "translating-primary" ? t.translationPrimary
        : batchTaskState.phase === "translating-backup" ? t.translationBackup
          : batchTaskState.phase === "error" ? t.translationFailed
            : batchTaskState.phase === "cancelled" ? t.translationCancelled
              : batchTaskState.cached ? t.translationCacheHit
                : "";

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
    refreshCacheSize();
    refreshStats();
    loadGlossary();

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

  // Shortcut Recording Logic
  useEffect(() => {
    if (!recordingKey) {
        invoke("set_shortcuts_paused", { paused: false });
        return;
    }

    invoke("set_shortcuts_paused", { paused: true });

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Only track if there's at least one modifier or it's a function key
      const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
      
      // Skip pure modifier keys alone
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Win');
      
      let key = e.key.toUpperCase();
      if (key === ' ') key = 'Space';
      
      // We accept modifier+key OR Function keys (F1-F12)
      if (hasModifier || key.startsWith('F')) {
        if (key.length === 1 || key.startsWith('F')) {
            parts.push(key);
            const newShortcut = parts.join('+');
            handleUpdateShortcut(recordingKey, newShortcut);
            setRecordingKey(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
        window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [recordingKey]);

  const handleUpdateShortcut = async (name: "q" | "w", shortcut: string) => {
    try {
        await invoke("update_shortcut", { name, shortcutStr: shortcut });
        if (name === 'q') setShortcutQ(shortcut);
        else setShortcutW(shortcut);
        toast("success", t.shortcutUpdated);
        addNotification(t.shortcutUpdated);
    } catch (e) {
        toast("error", `${t.shortcutFailed}: ${e}`);
        addNotification(`${t.shortcutFailed}: ${e}`);
    }
  };

  const refreshCacheSize = async () => {
    try {
      const size = await invoke<string>("get_audio_cache_size");
      setCacheSize(size);
    } catch (e) { console.error(e); }
  };

  const handleClearCache = async () => {
    try {
      await invoke("clear_audio_cache");
      await refreshCacheSize();
      toast("success", t.cacheCleared);
    } catch (e) { console.error(e); }
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

  // Clipboard monitoring
  const lastClipboardRef = useRef("");
  const clipboardTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (clipboardMonitor) {
      clipboardTimerRef.current = setInterval(async () => {
        try {
          const text = await invoke<string>("get_clipboard_text");
          if (text && text !== lastClipboardRef.current) {
            lastClipboardRef.current = text;
            await invoke("clipboard_detect", { text });
          }
        } catch { /* clipboard read can fail */ }
      }, 900);
    } else {
      lastClipboardRef.current = "";
    }
    return () => {
      if (clipboardTimerRef.current) {
        clearInterval(clipboardTimerRef.current);
        clipboardTimerRef.current = null;
      }
    };
  }, [clipboardMonitor]);

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
    const prevState = autoLaunch;
    try {
        const current = await isEnabled();
        if (current) {
            await disable();
        } else {
            await enable();
        }
        
        // Registry changes can take a moment, wait briefly before checking
        await new Promise(r => setTimeout(r, 500));
        
        const nowEnabled = await isEnabled();
        setAutoLaunch(nowEnabled);
        
        if (nowEnabled === prevState) {
            // If it didn't change, it might be blocked by system or antivirus
            toast("warning", t.autoLaunchDenied);
            addNotification(t.autoLaunchDenied);
        } else {
            toast("success", t.success);
            addNotification(t.success);
        }
    } catch (e) {
        console.error("Toggle autostart failed:", e);
        // Sync UI with reality
        const realState = await isEnabled();
        setAutoLaunch(realState);
        toast("error", t.autoLaunchFailed);
        addNotification(t.autoLaunchFailed);
    }
  };

  const handleExportDiagnostics = async () => {
    if (isExportingDiagnostics) return;
    setIsExportingDiagnostics(true);
    try {
      await invoke<string>("export_diagnostics");
      toast("success", t.diagnosticsExportSuccess);
      addNotification(t.diagnosticsExportSuccess);
    } catch (e: any) {
      if (e !== "User cancelled") {
        toast("error", `${t.diagnosticsExportFailed}: ${e}`);
        addNotification(`${t.diagnosticsExportFailed}: ${e}`);
      }
    } finally {
      setIsExportingDiagnostics(false);
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
        isNotificationsOpenRef.current = false;
        setIsNotificationsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
                        <div className="space-y-6 flex-1 flex flex-col min-h-0">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                                <div className="flex flex-col gap-4">
                                    <div className="flex items-center justify-between pl-4 pr-2">
                                        <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">{t.inputText}</h3>
                                        <ThemedSelect
                                            value={sourceLang}
                                            options={[{ value: "auto", label: t.autoDetect }, ...languageOptions]}
                                            onChange={setSourceLang}
                                            ariaLabel={t.sourceLang}
                                            className="w-32"
                                            compact
                                        />
                                    </div>
                                    <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative">
                                        <textarea value={batchInput} onChange={(e) => setBatchInput(e.target.value)} placeholder={t.inputPlaceholder} className="w-full h-full bg-transparent outline-none resize-none font-medium custom-scrollbar text-[0.9em] leading-relaxed dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500" />
                                        <div className="absolute bottom-6 right-6">
                                            <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={isTranslating ? cancelBatchWork : compareMode ? startCompareTranslation : startBatchTranslation} disabled={!batchInput} className={`px-6 py-2.5 rounded-full font-black text-[11px] shadow-xl flex items-center gap-2 transition-all ${!batchInput ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-400' : isTranslating ? 'bg-red-500 text-white shadow-red-500/20' : 'bg-accent text-white shadow-accent'}`}>
                                                {isTranslating ? <CircleStop size={14} /> : <Languages size={14} />} {isTranslating ? t.cancelTranslation : t.translate}
                                            </motion.button>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-wrap justify-between items-center gap-2 px-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">{t.output}</h3>
                                            <ThemedSelect
                                                value={targetLang}
                                                options={languageOptions}
                                                onChange={setTargetLang}
                                                ariaLabel={t.targetLang}
                                                className="w-28"
                                                compact
                                                accent
                                            />
                                        </div>
                                        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                                            {batchOutput && !compareMode && <button onClick={() => navigator.clipboard.writeText(batchOutput)} className="text-[10px] font-bold text-accent hover:bg-accent/10 px-3 py-1 rounded-full flex items-center gap-1.5 transition-all"><Copy size={12} /> {t.copy}</button>}
                                            {batchOutput && !compareMode && (
                                                <button onClick={startBatchBackTranslate} disabled={isBatchBackTranslating} className={`text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-1.5 transition-all ${isBatchBackTranslating ? 'text-zinc-300' : 'text-amber-500 hover:bg-amber-500/10'}`}>
                                                    <ArrowLeftRight size={12} /> {t.backTranslation}
                                                </button>
                                            )}
                                            <button
                                                onClick={() => setCompareModeEnabled(!compareMode)}
                                                disabled={isTranslating}
                                                className={`text-[9px] font-black px-2.5 py-1.5 rounded-full transition-all ${
                                                    isTranslating ? 'opacity-40 cursor-not-allowed' : compareMode ? 'bg-accent text-white shadow-accent' : 'bg-black/5 dark:bg-white/5 text-zinc-400 hover:bg-accent/10 hover:text-accent'
                                                }`}
                                            >
                                                {t.compareMode} {compareMode ? t.toggleOn : t.toggleOff}
                                            </button>
                                        </div>
                                    </div>
                                    {compareMode ? (
                                        <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
                                            {/* Primary model */}
                                            <div className="flex flex-col gap-1.5 min-h-0">
                                                <div className="flex items-center justify-between px-2">
                                                    <span className="text-[8px] font-black text-accent uppercase tracking-wider">{primaryComparisonState?.model || transModelName || "Primary"}</span>
                                                    {primaryComparisonState?.durationMs !== undefined && <span className="text-[8px] font-bold text-zinc-400">{primaryComparisonState.durationMs} {t.millisecondsShort}</span>}
                                                </div>
                                                <div className="flex-1 glass-card rounded-[24px] overflow-hidden p-5 border-white/50 bg-black/[0.02] dark:bg-white/[0.02]">
                                                    <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.8em] leading-relaxed selectable-text whitespace-pre-wrap">
                                                        {batchOutput || (primaryComparisonState?.phase === "error"
                                                            ? <span className="text-red-500"><AlertCircle size={13} className="inline mr-1.5" />{translationErrorText(t, primaryComparisonState.error?.code, primaryComparisonState.error?.message)}</span>
                                                            : primaryComparisonState?.phase === "cancelled" ? <span className="opacity-30 italic">{t.translationCancelled}</span>
                                                            : <span className="opacity-30 italic">{primaryComparisonState?.phase === "translating" ? t.translationPrimary : "..."}</span>)}
                                                        {primaryComparisonState?.phase === "translating" && !batchOutput && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-accent align-middle" />}
                                                    </div>
                                                </div>
                                                {batchOutput && <button onClick={() => navigator.clipboard.writeText(batchOutput)} className="self-end text-[9px] font-bold text-zinc-400 hover:text-accent px-2 py-1 rounded-lg hover:bg-accent/10 transition-all"><Copy size={10} className="inline mr-1" />{t.copy}</button>}
                                            </div>
                                            {/* Backup model */}
                                            <div className="flex flex-col gap-1.5 min-h-0">
                                                <div className="flex items-center justify-between px-2">
                                                    <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider">{backupComparisonState?.model || backupModelName || "Backup"}</span>
                                                    {backupComparisonState?.durationMs !== undefined && <span className="text-[8px] font-bold text-zinc-400">{backupComparisonState.durationMs} {t.millisecondsShort}</span>}
                                                </div>
                                                <div className="flex-1 glass-card rounded-[24px] overflow-hidden p-5 border-white/50 bg-black/[0.02] dark:bg-white/[0.02]">
                                                    <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.8em] leading-relaxed selectable-text whitespace-pre-wrap">
                                                        {batchOutputBackup || (backupComparisonState?.phase === "error"
                                                            ? <span className="text-red-500"><AlertCircle size={13} className="inline mr-1.5" />{translationErrorText(t, backupComparisonState.error?.code, backupComparisonState.error?.message)}</span>
                                                            : backupComparisonState?.phase === "cancelled" ? <span className="opacity-30 italic">{t.translationCancelled}</span>
                                                            : <span className="opacity-30 italic">{backupComparisonState?.phase === "translating" ? t.translationBackupModel : "..."}</span>)}
                                                        {backupComparisonState?.phase === "translating" && !batchOutputBackup && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-zinc-400 align-middle" />}
                                                    </div>
                                                </div>
                                                {batchOutputBackup && <button onClick={() => navigator.clipboard.writeText(batchOutputBackup)} className="self-end text-[9px] font-bold text-zinc-400 hover:text-accent px-2 py-1 rounded-lg hover:bg-accent/10 transition-all"><Copy size={10} className="inline mr-1" />{t.copy}</button>}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative bg-black/[0.02] dark:bg-white/[0.02]">
                                            <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.9em] leading-relaxed selectable-text">
                                                {batchOutput || (isTranslating ? <span className="opacity-30 italic">{batchStatusText}</span> : batchTaskState.phase === "error" ? "" : <span className="opacity-30 italic">{t.outputPlaceholder}</span>)}
                                                {isTranslating && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-accent align-middle" />}
                                            </div>
                                            {batchTaskState.phase === "error" && (
                                                <div className="absolute inset-x-5 bottom-5 flex items-center gap-3 rounded-2xl border border-red-500/15 bg-red-50/95 dark:bg-red-500/10 p-3 text-red-600 dark:text-red-400">
                                                    <AlertCircle size={15} className="shrink-0" />
                                                    <span className="min-w-0 flex-1 text-[10px] font-bold">{translationErrorText(t, batchTaskState.error?.code, batchTaskState.error?.message)}</span>
                                                    <button onClick={startBatchTranslation} className="text-[10px] font-black hover:underline">{t.retry}</button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* Back-translation result */}
                                    <AnimatePresence>
                                        {(batchBackTranslation || isBatchBackTranslating) && (
                                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                                                <div className="glass-card rounded-2xl p-4 border border-amber-500/20 bg-amber-50/50 dark:bg-amber-500/5">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <ArrowLeftRight size={12} className="text-amber-500" />
                                                        <span className="text-[9px] font-black uppercase text-amber-500 tracking-[0.2em]">{t.backTranslation}</span>
                                                    </div>
                                                    <div className="text-[12px] font-medium text-amber-800 dark:text-amber-300 leading-relaxed selectable-text">
                                                        {batchBackTranslation || (isBatchBackTranslating ? "" : "...")}
                                                        {isBatchBackTranslating && (
                                                            <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-3.5 ml-1 bg-amber-400 align-middle rounded-full" />
                                                        )}
                                                    </div>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </div>

                            {/* Glossary */}
                            <div className="shrink-0 glass-card rounded-[24px] p-5 shadow-apple border-white/50 space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em]">{t.glossary} ({glossary.length})</span>
                                    <p className="text-[8px] text-zinc-400 font-bold opacity-60">{t.glossaryDesc}</p>
                                </div>
                                {glossary.length > 0 && (
                                    <div className="space-y-2 max-h-32 overflow-y-auto custom-scrollbar">
                                        {glossary.map(g => (
                                            <div key={g.id} className="flex items-center gap-3 text-[10px]">
                                                {editingGlossaryId === g.id ? (
                                                    <>
                                                        <input value={editSourceTerm} onChange={e => setEditSourceTerm(e.target.value)} className="flex-1 py-1.5 px-3 rounded-lg bg-white/60 dark:bg-white/10 border border-accent/50 text-[10px] font-bold outline-none" />
                                                        <span className="text-zinc-400">→</span>
                                                        <input value={editTargetTerm} onChange={e => setEditTargetTerm(e.target.value)} className="flex-1 py-1.5 px-3 rounded-lg bg-white/60 dark:bg-white/10 border border-accent/50 text-[10px] font-bold outline-none" />
                                                        <button onClick={saveEditGlossaryEntry} className="p-1 text-green-500 hover:bg-green-500/10 rounded-full"><CheckCircle size={14} /></button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <span className="font-bold text-zinc-700 dark:text-zinc-200 flex-1">{g.source_term}</span>
                                                        <span className="text-zinc-400">→</span>
                                                        <span className="font-bold text-accent flex-1">{g.target_term}</span>
                                                        <button onClick={() => { setEditingGlossaryId(g.id); setEditSourceTerm(g.source_term); setEditTargetTerm(g.target_term); }} className="p-1 text-zinc-400 hover:text-accent rounded-full hover:bg-accent/10"><ExternalLink size={11} /></button>
                                                        <button onClick={() => deleteGlossaryEntry(g.id)} className="p-1 text-zinc-400 hover:text-red-500 rounded-full hover:bg-red-500/10"><CloseIcon size={11} /></button>
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="flex gap-2">
                                    <input value={newSourceTerm} onChange={e => setNewSourceTerm(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGlossaryEntry()} placeholder={t.glossaryTerm} className="flex-1 py-2 px-3 rounded-xl bg-white/60 dark:bg-white/10 border border-black/5 dark:border-white/10 text-[10px] font-bold outline-none focus:border-accent/50 transition-all placeholder:text-zinc-400" />
                                    <span className="self-center text-zinc-400 text-[10px]">→</span>
                                    <input value={newTargetTerm} onChange={e => setNewTargetTerm(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGlossaryEntry()} placeholder={t.glossaryTranslation} className="flex-1 py-2 px-3 rounded-xl bg-white/60 dark:bg-white/10 border border-black/5 dark:border-white/10 text-[10px] font-bold outline-none focus:border-accent/50 transition-all placeholder:text-zinc-400" />
                                    <button onClick={addGlossaryEntry} className="px-4 py-2 bg-accent text-white rounded-xl text-[10px] font-black hover:bg-accent/90 transition-all">{t.addTerm}</button>
                                </div>
                            </div>
                        </div>
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
