import { useState, useEffect, useMemo, useRef } from "react";
import { Settings, Book, Cpu, Save, CheckCircle, Trash2, Palette, Sun, Moon, Monitor, ChevronRight, Sparkles, ExternalLink, Info, Languages, Copy, RotateCcw, Plus, X as CloseIcon, Volume2, Clock, Bell, Brain, Search } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { translations, Lang } from "../i18n";
import { WordAnalysis, analyzeAndSaveWord } from "../services/wordbook";
import { translateStreaming, translateCompare, speak } from "../services/api";
import ReviewTab from "./ReviewTab";
import { ToastContainer, toast } from "./Toast";

const ACCENT_PALETTE = [
  { id: "blue",   value: "#007aff" },
  { id: "indigo", value: "#5856d6" },
  { id: "violet", value: "#af52de" },
  { id: "pink",   value: "#ff2d55" },
  { id: "orange", value: "#ff9500" },
  { id: "green",  value: "#34c759" },
  { id: "teal",   value: "#5ac8fa" },
  { id: "mint",   value: "#00c7be" },
];

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("general");
  const [lang, setLang] = useState<Lang>("zh");
  const [targetLang, setTargetLang] = useState("Chinese");
  const [sourceLang, setSourceLang] = useState("auto");

  const LANGUAGES = [
    "Chinese", "English", "Japanese", "Korean", "French", "German",
    "Spanish", "Portuguese", "Russian", "Arabic", "Italian", "Dutch",
    "Thai", "Vietnamese", "Indonesian", "Hindi", "Turkish", "Polish",
    "Swedish", "Danish", "Norwegian", "Finnish", "Greek", "Czech",
    "Romanian", "Hungarian", "Hebrew", "Ukrainian", "Catalan", "Slovak",
  ];
  const [autoCopy, setAutoCopy] = useState(false);
  const [theme, setTheme] = useState("system");
  const [accentColor, setAccentColor] = useState("#007aff");
  const [fontSize, setFontSize] = useState(14);
  const [notifications, setNotifications] = useState<{msg: string; time: string}[]>([]);

  const addNotification = (msg: string) => {
    if (!msg) return;
    const time = new Date().toLocaleTimeString();
    setNotifications(prev => [{msg, time}, ...prev].slice(0, 10));
  };
  const [isSyncing, setIsSyncing] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState("");
  const [cacheSize, setCacheSize] = useState("0 B");
  const [appStats, setAppStats] = useState({ word_count: 0, trans_count: 0, days_active: 1, due_today: 0 });

  // WebDAV Config
  const [webdavEnabled, setWebdavEnabled] = useState(false);
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUser, setWebdavUser] = useState("");
  const [webdavPass, setWebdavPass] = useState("");

  // Shortcuts
  const [shortcutQ, setShortcutQ] = useState("Alt+Q");
  const [shortcutW, setShortcutW] = useState("Alt+W");
  const [recordingKey, setRecordingKey] = useState<"q" | "w" | null>(null);

  // Translation Model Config
  const [transApiKey, setTransApiKey] = useState("");
  const [transBaseUrl, setTransBaseUrl] = useState("");
  const [transModelName, setTransModelName] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  // Backup model config
  const [backupApiKey, setBackupApiKey] = useState("");
  const [backupBaseUrl, setBackupBaseUrl] = useState("");
  const [backupModelName, setBackupModelName] = useState("");

  // OCR language
  const [ocrLang, setOcrLang] = useState("auto");

  // Audio (TTS) Model Config
  const [ttsEngine, setTtsEngine] = useState("local");
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModelName, setTtsModelName] = useState("");
  const [ttsVoice, setTtsVoice] = useState("alloy");
  const [ttsSpeed, setTtsSpeed] = useState("1.0");

  const [words, setWords] = useState<any[]>([]);
  const [selectedWord, setSelectedWord] = useState<any>(null);

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

  // Translation History state
  const [history, setHistory] = useState<any[]>([]);

  // Batch Translator state
  const [batchInput, setBatchInput] = useState("");
  const [batchOutput, setBatchOutput] = useState("");
  const [batchOutputBackup, setBatchOutputBackup] = useState("");
  const [compareMode, setCompareMode] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);

  // Wordbook search, sort & pagination
  const [wordsLimit, setWordsLimit] = useState(200);
  const [wordbookSearch, setWordbookSearch] = useState("");
  const [wordbookSort, setWordbookSort] = useState<"newest" | "az" | "za">("newest");

  const filteredWords = useMemo(() => {
    let result = words;
    if (wordbookSearch.trim()) {
      const q = wordbookSearch.trim().toLowerCase();
      result = result.filter(w =>
        w.word.toLowerCase().includes(q) ||
        (w.meaning && w.meaning.toLowerCase().includes(q))
      );
    }
    if (wordbookSort === "az") {
      result = [...result].sort((a, b) => a.word.localeCompare(b.word));
    } else if (wordbookSort === "za") {
      result = [...result].sort((a, b) => b.word.localeCompare(a.word));
    }
    return result;
  }, [words, wordbookSearch, wordbookSort]);

  const displayedWords = filteredWords.slice(0, wordsLimit);

  // Manual Add Word state
  const [newWord, setNewWord] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const syncTimerRef = useRef<any>(null);
  const t = useMemo(() => translations[lang] || translations.zh, [lang]);

  // Keyboard shortcuts for tab switching (Ctrl+1..5)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const tabMap: Record<string, string> = { '1': 'general', '2': 'batch', '3': 'model', '4': 'appearance', '5': 'wordbook', '6': 'review', '7': 'history' };
      const tab = tabMap[e.key];
      if (tab) { e.preventDefault(); setActiveTab(tab); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const refreshStats = async () => {
    try {
        const stats = await invoke<any>("get_app_stats");
        setAppStats(stats);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    loadConfig();
    loadWordbook();
    loadHistory();
    refreshCacheSize();
    refreshStats();
    loadGlossary();

    const unlistenHistory = listen("history-updated", () => { loadHistory(); });

    const unlistenWordbook = listen<string>("wordbook-updated", (event) => {
        loadWordbook();
        refreshStats();
        // 1-minute auto sync logic - only for local changes
        if (webdavEnabled && event.payload === "local") {
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            syncTimerRef.current = setTimeout(() => {
                handleSync();
            }, 60000); // 1 minute
        }
    });

    const unlistenShortcutError = listen<string>("shortcut-error", (event) => {
        toast("error", `错误: ${event.payload}`);
    });

    const unlistenConfigImport = listen("config-updated", () => {
        loadConfig();
        loadWordbook();
        refreshStats();
        toast("success", t.importSuccess);
    });

    return () => {
        unlistenHistory.then(f => f());
        unlistenWordbook.then(f => f());
        unlistenShortcutError.then(f => f());
        unlistenConfigImport.then(f => f());
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [webdavEnabled, lang]); // Added lang to deps to refresh UI when lang changes

  const handleExport = async () => {
    try {
        const pw = window.prompt("Enter a password to encrypt the backup:");
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
        const pw = window.prompt("Enter the backup password:");
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

  // Accent color effect
  const applyAccent = (color: string) => {
    document.documentElement.style.setProperty("--accent", color);
  };

  useEffect(() => {
    applyAccent(accentColor);
  }, [accentColor]);

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

  const loadConfig = async () => {
    try {
      const getVal = async (key: string) => await invoke<string>("get_config_value", { key });
      
      setTransApiKey(await getVal("trans_api_key") || await getVal("openai_api_key") || "");
      setTransBaseUrl(await getVal("trans_base_url") || await getVal("base_url") || "");
      setTransModelName(await getVal("trans_model_name") || await getVal("model_name") || "");
      setCustomPrompt(await getVal("custom_prompt") || "");
      setBackupApiKey(await getVal("backup_api_key") || "");
      setBackupBaseUrl(await getVal("backup_base_url") || "");
      setBackupModelName(await getVal("backup_model") || "");
      setOcrLang(await getVal("ocr_lang") || "auto");

      setShortcutQ(await getVal("shortcut_q") || "Alt+Q");
      setShortcutW(await getVal("shortcut_w") || "Alt+W");

      const savedLang = await getVal("language") as Lang;
      if (savedLang) setLang(savedLang);
      
      setTargetLang(await getVal("target_lang") || "Chinese");
      setSourceLang(await getVal("source_lang") || "auto");
      setAutoCopy((await getVal("auto_copy")) === "true");
      const savedAccent = await getVal("accent_color") || "#007aff";
      setAccentColor(savedAccent);
      applyAccent(savedAccent);
      setTheme(await getVal("theme") || "system");
      setFontSize(parseInt(await getVal("font_size") || "14"));

      setTtsEngine(await getVal("tts_engine") || "local");
      setTtsApiKey(await getVal("tts_api_key") || await getVal("openai_api_key") || "");
      setTtsBaseUrl(await getVal("tts_base_url") || await getVal("base_url") || "");
      setTtsModelName(await getVal("tts_model_name") || await getVal("tts_model") || "tts-1");
      setTtsVoice(await getVal("tts_voice") || "alloy");
      setTtsSpeed(await getVal("tts_speed") || "1.0");

      setWebdavEnabled((await getVal("webdav_enabled")) === "true");
      setWebdavUrl(await getVal("webdav_url") || "");
      setWebdavUser(await getVal("webdav_user") || "");
      setWebdavPass(await getVal("webdav_pass") || "");
      setLastSyncTime(await getVal("last_sync_time") || "");

      const enabled = await isEnabled();
      setAutoLaunch(enabled);
    } catch (e) { console.error(e); }
  };

  const checkUpdate = async () => {
    try {
      const update = await check();
      if (update) {
        toast("info", t.versionDownloading.replace("{version}", update.version));
        addNotification(t.versionDownloading.replace("{version}", update.version));
        await update.downloadAndInstall();
        await update.install();
      } else {
        toast("success", t.upToDate);
        addNotification(t.upToDate);
      }
    } catch (e) {
      toast("error", `${t.updateCheckFailed}: ${e}`);
      addNotification(`${t.updateCheckFailed}: ${e}`);
    }
  };

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

  const loadWordbook = async () => {
    try {
      const data = await invoke<any[]>("get_wordbook");
      setWords(data);
      if (selectedWord) {
        const updated = data.find(w => w.uuid === selectedWord.uuid || w.id === selectedWord.id);
        if (updated) setSelectedWord(updated);
      }
    } catch (e) { console.error(e); }
  };

  const loadHistory = async () => {
    try {
      const data = await invoke<any[]>("get_translation_history", { limit: 100, offset: 0 });
      setHistory(data);
    } catch (e) { console.error(e); }
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      await invoke("sync_wordbook");
      toast("success", t.syncSuccess);
      addNotification(t.syncSuccess);
      const time = await invoke<string>("get_config_value", { key: "last_sync_time" });
      setLastSyncTime(time);
      await loadWordbook();
    } catch (e) {
      console.error(e);
      toast("error", `${t.syncFailed}: ${e}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const toggleWebdav = async () => {
    const next = !webdavEnabled;
    setWebdavEnabled(next);
    try {
        await invoke("set_config_value", { key: "webdav_enabled", value: next ? "true" : "false" });
    } catch (e) { console.error(e); }
  };

  const handleSave = async () => {
    try {
      const setVal = async (key: string, value: string) => await invoke("set_config_value", { key, value });
      
      await Promise.all([
        setVal("trans_api_key", transApiKey),
        setVal("trans_base_url", transBaseUrl),
        setVal("trans_model_name", transModelName),
        setVal("language", lang),
        setVal("target_lang", targetLang),
        setVal("source_lang", sourceLang),
        setVal("auto_copy", autoCopy ? "true" : "false"),
        setVal("accent_color", accentColor),
        setVal("theme", theme),
        setVal("font_size", fontSize.toString()),
        setVal("tts_engine", ttsEngine),
        setVal("tts_api_key", ttsApiKey),
        setVal("tts_base_url", ttsBaseUrl),
        setVal("tts_model_name", ttsModelName),
        setVal("tts_voice", ttsVoice),
        setVal("tts_speed", ttsSpeed),
        setVal("custom_prompt", customPrompt),
        setVal("backup_api_key", backupApiKey),
        setVal("backup_base_url", backupBaseUrl),
        setVal("backup_model", backupModelName),
        setVal("ocr_lang", ocrLang),
        setVal("webdav_enabled", webdavEnabled ? "true" : "false"),
        setVal("webdav_url", webdavUrl),
        setVal("webdav_user", webdavUser),
        setVal("webdav_pass", webdavPass)
      ]);
      toast("success", t.success);
      addNotification(t.success);
      emit("settings-changed", { theme, fontSize }).catch(console.error);
    } catch (e) { toast("error", t.error); }
  };

  const deleteWord = async (id: number) => {
    await invoke("delete_word", { id });
    if (selectedWord?.id === id) setSelectedWord(null);
    refreshStats();
  };

  const startBatchTranslation = async () => {
    if (!batchInput || isTranslating) return;
    setBatchOutput("");
    setIsTranslating(true);
    let fullText = "";
    await translateStreaming(
      batchInput,
      (chunk) => {
        fullText += chunk;
        setBatchOutput(prev => prev + chunk);
      },
      () => {
        setIsTranslating(false);
        refreshStats();
        if (fullText.trim()) {
          invoke("save_translation", {
            sourceText: batchInput,
            translatedText: fullText.trim(),
            sourceLang: "",
            targetLang: targetLang,
            model: "",
          }).catch(console.error);
        }
      }
    );
  };

  const startCompareTranslation = async () => {
    if (!batchInput || isTranslating) return;
    setBatchOutput("");
    setBatchOutputBackup("");
    setIsTranslating(true);
    const primaryModel = transModelName || "Primary";
    const backupModel = backupModelName || "Backup";
    let primaryResult = "";
    let backupResult = "";
    await translateCompare(
      batchInput,
      (chunk) => { primaryResult += chunk; setBatchOutput(prev => prev + chunk); },
      (chunk) => { backupResult += chunk; setBatchOutputBackup(prev => prev + chunk); },
      () => {
        setIsTranslating(false);
        refreshStats();
        const combined = `[${primaryModel}]\n${primaryResult.trim()}\n\n[${backupModel}]\n${backupResult.trim()}`;
        if (primaryResult.trim() || backupResult.trim()) {
          invoke("save_translation", {
            sourceText: batchInput,
            translatedText: combined,
            sourceLang: "",
            targetLang: targetLang,
            model: `${primaryModel} vs ${backupModel}`,
          }).catch(console.error);
        }
      }
    );
  };

  const handleManualAdd = async () => {
    if (!newWord.trim()) return;
    const wordToAdd = newWord.trim();
    setNewWord("");
    setIsAdding(false);
    await analyzeAndSaveWord(wordToAdd);
  };

  const [isLangOpen, setIsLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const prevActiveTab = useRef("general");

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(event.target as Node)) {
        setIsLangOpen(false);
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
    <div className="flex h-screen apple-gradient-bg text-zinc-900 dark:text-zinc-100 overflow-hidden font-sans select-none transition-colors duration-1000" style={{ fontSize: `${fontSize}px` }}>
      <ToastContainer />
      {/* Sidebar */}
      <div 
        className="glass border-r border-black/5 dark:border-white/5 flex flex-col z-20 shadow-xl shrink-0" 
        style={{ width: '180px', minWidth: '160px' }}
      >
        <div className="p-6">
            <div className="flex items-center gap-3 mb-8 group">
              <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 via-blue-600 to-blue-700 rounded-xl flex items-center justify-center text-white text-lg font-black shadow-lg shadow-accent group-hover:rotate-12 transition-transform duration-500">
                <Sparkles size={20} className="text-white/90" />
              </div>
              <div className="flex flex-col overflow-hidden">
                <span className="text-sm font-black tracking-tighter leading-none mb-1">Long Trans</span>
                <span className="text-[8px] font-bold text-zinc-400 uppercase tracking-widest opacity-60">Professional</span>
              </div>
            </div>
            
            <nav className="space-y-1">
              <LayoutGroup id="sidebar">
                {tabs.map((tab) => (
                    <button 
                    key={tab.id} 
                    onClick={() => setActiveTab(tab.id)}
                    className={`group w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all relative ${
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
        
        <div className="mt-auto p-4 border-t border-black/5 dark:border-white/5">
            <div className="p-4 bg-white/40 dark:bg-white/5 rounded-2xl border border-white/40 dark:border-white/5 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Book size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">Words</span></div>
                    <span className="text-[10px] font-black text-accent">{appStats.word_count}</span>
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Languages size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">Trans</span></div>
                    <span className="text-[10px] font-black text-accent">{appStats.trans_count}</span>
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Brain size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">Due</span></div>
                    <span className="text-[10px] font-black text-amber-500">{appStats.due_today || 0}</span>
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Monitor size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">Days</span></div>
                    <span className="text-[10px] font-black text-accent">{appStats.days_active}d</span>
                </div>
                <button onClick={checkUpdate} className="w-full py-2 rounded-xl bg-accent/10 text-accent border border-accent/20 text-[9px] font-black hover:bg-accent/20 transition-all mt-1">{t.checkUpdate}</button>
            </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-transparent relative">
        <header className="h-20 flex items-center justify-between px-10 shrink-0 border-b border-black/5 dark:border-white/5 backdrop-blur-3xl bg-white/30 dark:bg-black/20 z-10">
            <div className="flex flex-col">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-black tracking-tighter bg-gradient-to-r from-zinc-800 to-zinc-500 dark:from-white dark:to-zinc-400 bg-clip-text text-transparent">
                        {tabs.find(t_ => t_.id === activeTab)?.label}
                    </h1>
                    <span className="w-1 h-1 rounded-full bg-accent/40" />
                    <span className="text-[10px] font-black text-accent/60 dark:text-accent/60 tracking-widest uppercase italic">LONG AI</span>
                </div>
                <p className="text-[9px] text-zinc-400 font-bold uppercase tracking-[0.3em] opacity-60">Long翻译 · 智能助手</p>
            </div>
            <div className="flex items-center gap-4">
                {/* Notification Bell */}
                <div className="relative group">
                    <button className="relative p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                        <Bell size={16} className="text-zinc-400" />
                        {notifications.length > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-accent rounded-full text-[8px] text-white font-black flex items-center justify-center">{notifications.length}</span>
                        )}
                    </button>
                    {notifications.length > 0 && (
                        <div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-zinc-800 rounded-xl shadow-2xl border border-black/5 dark:border-white/10 z-50 overflow-hidden opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200">
                            <div className="p-2 border-b border-black/5 dark:border-white/5">
                                <span className="text-[9px] font-black text-zinc-400 uppercase tracking-wider px-2">{t.notifications}</span>
                            </div>
                            <div className="max-h-48 overflow-y-auto">
                                {notifications.map((n, i) => (
                                    <div key={i} className="px-3 py-2 text-[10px] text-zinc-600 dark:text-zinc-300 font-medium hover:bg-black/5 dark:hover:bg-white/5 flex items-start gap-2">
                                        <CheckCircle size={10} className="mt-0.5 text-green-500 shrink-0" />
                                        <span className="flex-1">{n.msg}</span>
                                        <span className="text-[8px] text-zinc-400 shrink-0">{n.time}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                {activeTab !== 'wordbook' && activeTab !== 'batch' && (
                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={handleSave} className="flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-full font-black text-[12px] shadow-xl shadow-accent transition-all">
                        <Save size={14} /> {t.save}
                    </motion.button>
                )}
            </div>
        </header>

        <main className="flex-1 overflow-y-auto custom-scrollbar px-10 py-8 relative">
            <AnimatePresence mode="wait">
                <motion.div key={activeTab} initial={{ opacity: 0, x: slideDirection * 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: slideDirection * -24 }} transition={{ type: "spring", stiffness: 300, damping: 30 }} className="h-full flex flex-col">
                    {activeTab === "general" && (
                        <div className="space-y-6 max-w-3xl mx-auto w-full">
                            <div className="glass-card rounded-[28px] p-8 space-y-4 shadow-apple border-white/50">
                                <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] mb-4">Core</h3>
                                {[
                                    { label: t.language, desc: "Interface Language", component: (
                                        <div className="relative" ref={langRef}>
                                            <button 
                                                onClick={() => setIsLangOpen(!isLangOpen)}
                                                className="flex items-center justify-between bg-white/60 dark:bg-white/10 px-6 py-2.5 rounded-2xl font-black text-[12px] w-40 outline-none border border-black/5 dark:border-white/10 hover:bg-white dark:hover:bg-white/20 transition-all group"
                                            >
                                                <span>{lang === 'zh' ? '简体中文' : 'English'}</span>
                                                <ChevronRight size={14} className={`text-zinc-400 group-hover:text-accent transition-all ${isLangOpen ? 'rotate-90' : ''}`} />
                                            </button>
                                            <AnimatePresence>
                                                {isLangOpen && (
                                                    <motion.div 
                                                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                                        animate={{ opacity: 1, y: 5, scale: 1 }}
                                                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                                        className="absolute right-0 top-full w-40 glass-card rounded-2xl border border-white/50 dark:border-white/10 shadow-2xl z-50 overflow-hidden py-1.5 backdrop-blur-3xl"
                                                    >
                                                        {[
                                                            { id: 'zh', label: '简体中文' },
                                                            { id: 'en', label: 'English' }
                                                        ].map(opt => (
                                                            <button 
                                                                key={opt.id}
                                                                onClick={() => { setLang(opt.id as Lang); setIsLangOpen(false); }}
                                                                className={`w-full text-left px-5 py-2.5 text-[11px] font-black transition-all ${lang === opt.id ? 'bg-accent text-white' : 'hover:bg-black/5 dark:hover:bg-white/5 text-zinc-500'}`}
                                                            >
                                                                {opt.label}
                                                            </button>
                                                        ))}
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>
                                    )},
                                    { label: t.autoLaunch, desc: "Run on Startup", component: (
                                        <div onClick={toggleAutoLaunch} className={`w-12 h-6.5 rounded-full cursor-pointer transition-all relative ${autoLaunch ? 'bg-indigo-600 shadow-lg shadow-indigo-500/20' : 'bg-zinc-300 dark:bg-zinc-700'}`}>
                                            <motion.div animate={{ left: autoLaunch ? 24 : 3 }} className="absolute w-5 h-5 bg-white rounded-full top-0.75 shadow-sm" />
                                        </div>
                                    )},
                                    { label: t.sourceLang, desc: t.autoDetect, component: (
                                        <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)} className="bg-white/60 dark:bg-zinc-800 dark:text-white px-4 py-2.5 rounded-2xl border border-black/5 dark:border-zinc-600 font-black text-[11px] text-zinc-800 w-40 outline-none text-right focus:ring-4 ring-blue-500/10 transition-all appearance-none cursor-pointer">
                                            <option value="auto" className="dark:bg-zinc-800 dark:text-white">Auto Detect</option>
                                            {LANGUAGES.map(l => <option key={l} value={l} className="dark:bg-zinc-800 dark:text-white">{l}</option>)}
                                        </select>
                                    )},
                                    { label: t.targetLang, desc: "Translation Output", component: (
                                        <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)} className="bg-white/60 dark:bg-zinc-800 dark:text-white px-4 py-2.5 rounded-2xl border border-black/5 dark:border-zinc-600 font-black text-[11px] text-zinc-800 w-40 outline-none text-right focus:ring-4 ring-blue-500/10 transition-all appearance-none cursor-pointer">
                                            {LANGUAGES.map(l => <option key={l} value={l} className="dark:bg-zinc-800 dark:text-white">{l}</option>)}
                                        </select>
                                    )},
                                    { label: t.ocrLang, desc: t.ocrLangDesc, component: (
                                        <select value={ocrLang} onChange={(e) => setOcrLang(e.target.value)} className="bg-white/60 dark:bg-zinc-800 dark:text-white px-4 py-2.5 rounded-2xl border border-black/5 dark:border-zinc-600 font-black text-[11px] text-zinc-800 w-40 outline-none text-right focus:ring-4 ring-blue-500/10 transition-all appearance-none cursor-pointer">
                                            <option value="auto" className="dark:bg-zinc-800 dark:text-white">System Default</option>
                                            <option value="zh-Hans" className="dark:bg-zinc-800 dark:text-white">中文 (Chinese)</option>
                                            <option value="en" className="dark:bg-zinc-800 dark:text-white">English</option>
                                            <option value="ja" className="dark:bg-zinc-800 dark:text-white">日本語</option>
                                            <option value="ko" className="dark:bg-zinc-800 dark:text-white">한국어</option>
                                            <option value="fr" className="dark:bg-zinc-800 dark:text-white">Français</option>
                                            <option value="de" className="dark:bg-zinc-800 dark:text-white">Deutsch</option>
                                            <option value="es" className="dark:bg-zinc-800 dark:text-white">Español</option>
                                        </select>
                                    )},
                                    { label: t.autoCopy, desc: "Clipboard Integration", component: (
                                        <div onClick={() => setAutoCopy(!autoCopy)} className={`w-12 h-6.5 rounded-full cursor-pointer transition-all relative ${autoCopy ? 'bg-accent shadow-lg shadow-accent' : 'bg-zinc-300 dark:bg-zinc-700'}`}>
                                            <motion.div animate={{ left: autoCopy ? 24 : 3 }} className="absolute w-5 h-5 bg-white rounded-full top-0.75 shadow-sm" />
                                        </div>
                                    )}
                                ].map((item, idx) => (
                                    <div key={idx} className="flex items-center justify-between p-5 bg-white/20 dark:bg-white/5 rounded-[22px] border border-white/30 dark:border-white/5 transition-all hover:bg-white/40 dark:hover:bg-white/10">
                                        <div><label className="text-[0.9em] font-black block">{item.label}</label><span className="text-[0.7em] text-zinc-400 font-bold opacity-60 uppercase tracking-tighter">{item.desc}</span></div>
                                        {item.component}
                                    </div>
                                ))}
                            </div>

                            <div className="glass-card rounded-[28px] p-8 space-y-4 shadow-apple border-white/50">
                                <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] mb-4">Shortcuts</h3>
                                {[
                                    { label: "快速翻译", desc: "自动抓取并翻译选中文本", value: shortcutQ, id: 'q' as const },
                                    { label: "截图识别", desc: "唤起截图区域识别并翻译", value: shortcutW, id: 'w' as const }
                                ].map((item) => (
                                    <div key={item.id} className="flex items-center justify-between p-5 bg-white/20 dark:bg-white/5 rounded-[22px] border border-white/30 dark:border-white/5">
                                        <div>
                                            <label className="text-[0.9em] font-black block">{item.label}</label>
                                            <span className="text-[0.7em] text-zinc-400 font-bold opacity-60 uppercase tracking-tighter">{item.desc}</span>
                                        </div>
                                        <button 
                                            onClick={() => setRecordingKey(recordingKey === item.id ? null : item.id)}
                                            className={`min-w-[120px] px-4 py-2.5 rounded-2xl font-black text-[11px] border transition-all ${
                                                recordingKey === item.id 
                                                ? 'bg-accent text-white border-accent animate-pulse' 
                                                : 'bg-white/60 dark:bg-white/10 border-black/5 dark:border-white/10 hover:border-accent/50'
                                            }`}
                                        >
                                            {recordingKey === item.id ? "请按下组合键..." : item.value}
                                        </button>
                                    </div>
                                ))}
                            </div>

                            <div className="glass-card rounded-[28px] p-8 space-y-4 shadow-apple border-white/50">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex flex-col">
                                        <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">{t.cloudSync}</h3>
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className="text-[9px] font-black text-zinc-400 uppercase opacity-60">{t.lastSync}:</span>
                                            <span className="text-[9px] font-black text-accent uppercase">{lastSyncTime || t.neverSync}</span>
                                        </div>
                                    </div>
                                    <div onClick={toggleWebdav} className={`w-12 h-6.5 rounded-full cursor-pointer transition-all relative ${webdavEnabled ? 'bg-green-500 shadow-lg shadow-green-500/20' : 'bg-zinc-300 dark:bg-zinc-700'}`}>
                                        <motion.div animate={{ left: webdavEnabled ? 24 : 3 }} className="absolute w-5 h-5 bg-white rounded-full top-0.75 shadow-sm" />
                                    </div>
                                </div>
                                
                                <AnimatePresence>
                                    {webdavEnabled && (
                                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="space-y-4 overflow-hidden">
                                            <div className="p-4 bg-accent/5 rounded-2xl border border-accent/10">
                                                <div className="flex gap-3">
                                                    <Info size={16} className="text-accent shrink-0 mt-0.5" />
                                                    <p className="text-[10px] font-bold leading-relaxed text-accent/80 dark:text-accent/80">{t.webdavUrlHelp}</p>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-1 gap-3">
                                                <input value={webdavUrl} onChange={(e) => setWebdavUrl(e.target.value)} placeholder={t.webdavUrl} className="bg-white/60 dark:bg-black/20 px-4 py-3 rounded-xl border border-black/5 dark:border-white/10 font-bold text-[0.8em] outline-none dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500" />
                                                <div className="grid grid-cols-2 gap-3">
                                                    <input value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} placeholder={t.webdavUser} className="bg-white/60 dark:bg-black/20 px-4 py-3 rounded-xl border border-black/5 dark:border-white/10 font-bold text-[0.8em] outline-none dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500" />
                                                    <input type="password" value={webdavPass} onChange={(e) => setWebdavPass(e.target.value)} placeholder={t.webdavPass} className="bg-white/60 dark:bg-black/20 px-4 py-3 rounded-xl border border-black/5 dark:border-white/10 font-bold text-[0.8em] outline-none dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500" />
                                                </div>
                                            </div>
                                            <button 
                                                onClick={handleSync} 
                                                disabled={isSyncing || !webdavUrl}
                                                className={`w-full py-3 rounded-xl font-black text-[10px] flex items-center justify-center gap-2 transition-all ${isSyncing ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400' : 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:scale-[1.01]'}`}
                                            >
                                                {isSyncing ? <RotateCcw size={14} className="animate-spin" /> : <RotateCcw size={14} />} 
                                                {isSyncing ? t.syncing.toUpperCase() : t.syncNow.toUpperCase()}
                                            </button>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>

                            <div className="glass-card rounded-[28px] p-8 space-y-4 shadow-apple border-white/50">
                                <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] mb-4">Storage</h3>
                                <div className="flex items-center justify-between p-5 bg-white/20 dark:bg-white/5 rounded-[22px] border border-white/30 dark:border-white/5">
                                    <div><label className="text-[0.9em] font-black block">{t.cacheSize}</label><span className="text-[0.7em] text-zinc-400 font-bold opacity-60 uppercase tracking-tighter">Cached audio files</span></div>
                                    <div className="flex items-center gap-4">
                                        <span className="text-[11px] font-black text-zinc-500">{cacheSize}</span>
                                        <button onClick={handleClearCache} className="px-4 py-1.5 rounded-full bg-red-500/10 text-red-500 border border-red-500/20 text-[10px] font-black hover:bg-red-500 hover:text-white transition-all">{t.clearCache}</button>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between p-5 bg-white/20 dark:bg-white/5 rounded-[22px] border border-white/30 dark:border-white/5">
                                    <div><label className="text-[0.9em] font-black block">{t.backupRestore}</label><span className="text-[0.7em] text-zinc-400 font-bold opacity-60 uppercase tracking-tighter">{t.backupDesc}</span></div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={handleExport} className="px-4 py-1.5 rounded-full bg-accent/10 text-accent border border-accent/20 text-[10px] font-black hover:bg-accent hover:text-white transition-all uppercase">{t.exportData}</button>
                                        <button onClick={handleImport} className="px-4 py-1.5 rounded-full bg-zinc-900/10 dark:bg-white/10 text-zinc-900 dark:text-white border border-black/5 dark:border-white/10 text-[10px] font-black hover:bg-zinc-900 dark:hover:bg-white hover:text-white dark:hover:text-zinc-900 transition-all uppercase">{t.importData}</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === "batch" && (
                        <div className="space-y-6 flex-1 flex flex-col min-h-0">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                                <div className="flex flex-col gap-4">
                                    <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] pl-4">Input Text</h3>
                                    <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative">
                                        <textarea value={batchInput} onChange={(e) => setBatchInput(e.target.value)} placeholder={t.inputPlaceholder} className="w-full h-full bg-transparent outline-none resize-none font-medium custom-scrollbar text-[0.9em] leading-relaxed dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500" />
                                        <div className="absolute bottom-6 right-6">
                                            <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={compareMode ? startCompareTranslation : startBatchTranslation} disabled={isTranslating || !batchInput} className={`px-6 py-2.5 rounded-full font-black text-[11px] shadow-xl flex items-center gap-2 transition-all ${isTranslating || !batchInput ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-400' : 'bg-accent text-white shadow-accent'}`}>
                                                {isTranslating ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Languages size={14} />} {t.translate}
                                            </motion.button>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-col gap-4">
                                    <div className="flex justify-between items-center px-4">
                                        <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">Output</h3>
                                        <div className="flex items-center gap-2">
                                            {batchOutput && !compareMode && <button onClick={() => navigator.clipboard.writeText(batchOutput)} className="text-[10px] font-bold text-accent hover:bg-accent/10 px-3 py-1 rounded-full flex items-center gap-1.5 transition-all"><Copy size={12} /> {t.copy}</button>}
                                            <button
                                                onClick={() => { setCompareMode(!compareMode); setBatchOutput(""); setBatchOutputBackup(""); }}
                                                className={`text-[9px] font-black px-2.5 py-1.5 rounded-full transition-all ${
                                                    compareMode ? 'bg-accent text-white shadow-accent' : 'bg-black/5 dark:bg-white/5 text-zinc-400 hover:bg-accent/10 hover:text-accent'
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
                                                <span className="text-[8px] font-black text-accent uppercase tracking-wider px-2">{transModelName || "Primary"}</span>
                                                <div className="flex-1 glass-card rounded-[24px] overflow-hidden p-5 border-white/50 bg-black/[0.02] dark:bg-white/[0.02]">
                                                    <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.8em] leading-relaxed selectable-text whitespace-pre-wrap">
                                                        {batchOutput || (isTranslating ? "" : <span className="opacity-30 italic">...</span>)}
                                                        {isTranslating && !batchOutput && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-accent align-middle" />}
                                                    </div>
                                                </div>
                                                {batchOutput && <button onClick={() => navigator.clipboard.writeText(batchOutput)} className="self-end text-[9px] font-bold text-zinc-400 hover:text-accent px-2 py-1 rounded-lg hover:bg-accent/10 transition-all"><Copy size={10} className="inline mr-1" />{t.copy}</button>}
                                            </div>
                                            {/* Backup model */}
                                            <div className="flex flex-col gap-1.5 min-h-0">
                                                <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider px-2">{backupModelName || "Backup"}</span>
                                                <div className="flex-1 glass-card rounded-[24px] overflow-hidden p-5 border-white/50 bg-black/[0.02] dark:bg-white/[0.02]">
                                                    <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.8em] leading-relaxed selectable-text whitespace-pre-wrap">
                                                        {batchOutputBackup || (isTranslating ? "" : <span className="opacity-30 italic">...</span>)}
                                                        {isTranslating && !batchOutputBackup && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-zinc-400 align-middle" />}
                                                    </div>
                                                </div>
                                                {batchOutputBackup && <button onClick={() => navigator.clipboard.writeText(batchOutputBackup)} className="self-end text-[9px] font-bold text-zinc-400 hover:text-accent px-2 py-1 rounded-lg hover:bg-accent/10 transition-all"><Copy size={10} className="inline mr-1" />{t.copy}</button>}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative bg-black/[0.02] dark:bg-white/[0.02]">
                                            <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.9em] leading-relaxed selectable-text">
                                                {batchOutput || (isTranslating ? "" : <span className="opacity-30 italic">{t.outputPlaceholder}</span>)}
                                                {isTranslating && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-accent align-middle" />}
                                            </div>
                                        </div>
                                    )}
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
                        <div className="space-y-8 max-w-3xl mx-auto w-full pb-20">
                            <div className="glass-card rounded-[28px] p-10 space-y-6 shadow-apple border-white/50">
                                <div className="flex items-center gap-5 mb-4">
                                    <div className="w-14 h-14 bg-zinc-200 dark:bg-white/10 rounded-[20px] flex items-center justify-center text-zinc-600 dark:text-zinc-300 shadow-inner"><Cpu size={28} /></div>
                                    <div><h3 className="text-lg font-black tracking-tight">{t.transModel}</h3><p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest opacity-60">Translation Intelligence</p></div>
                                </div>
                                <div className="space-y-5">
                                    {[
                                        { label: t.baseUrl, val: transBaseUrl, set: setTransBaseUrl, placeholder: "https://api.deepseek.com", icon: ExternalLink, type: "text" },
                                        { label: t.apiKey, val: transApiKey, set: setTransApiKey, placeholder: "sk-...", icon: Save, type: "password" },
                                        { label: t.modelName, val: transModelName, set: setTransModelName, placeholder: "deepseek-chat", icon: Sparkles, type: "text" }
                                    ].map((f, i) => (
                                        <div key={i}><label className="block text-[10px] font-black uppercase text-zinc-400 mb-2 tracking-[0.2em] ml-2">{f.label}</label>
                                            <div className="relative"><input type={f.type} value={f.val} onChange={(e) => f.set(e.target.value)} className="w-full pl-5 pr-12 py-4 bg-white/40 dark:bg-black/20 rounded-[20px] border border-black/5 dark:border-white/10 text-[0.85em] dark:text-white font-bold outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:ring-4 ring-blue-500/10 transition-all" placeholder={f.placeholder} /><f.icon className="absolute right-5 top-1/2 -translate-y-1/2 text-zinc-300" size={20} /></div>
                                        </div>
                                    ))}
                                </div>
                                {/* Custom Prompt */}
                                <div className="mt-6 pt-5 border-t border-black/5 dark:border-white/5">
                                    <label className="block text-[10px] font-black uppercase text-zinc-400 mb-2 tracking-[0.2em] ml-2">{t.customPrompt}</label>
                                    <textarea
                                        value={customPrompt}
                                        onChange={(e) => setCustomPrompt(e.target.value)}
                                        placeholder="You are a professional translator. Translate to {{targetLang}}. Return only the translated text."
                                        className="w-full px-5 py-4 bg-white/40 dark:bg-black/20 rounded-[20px] border border-black/5 dark:border-white/10 text-[0.8em] font-medium dark:text-white outline-none focus:ring-4 ring-blue-500/10 transition-all resize-none h-28 custom-scrollbar placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                                    />
                                    <p className="text-[9px] text-zinc-400 font-bold mt-1.5 ml-2">{t.customPromptDesc}</p>
                                </div>
                                {/* Backup Model */}
                                <div className="mt-6 pt-5 border-t border-black/5 dark:border-white/5">
                                    <label className="block text-[10px] font-black uppercase text-zinc-400 mb-3 tracking-[0.2em] ml-2">{t.backupModel}</label>
                                    <div className="space-y-4">
                                        {[
                                            { label: t.baseUrl, val: backupBaseUrl, set: setBackupBaseUrl, placeholder: "https://api.openai.com/v1", icon: ExternalLink, type: "text" },
                                            { label: t.apiKey, val: backupApiKey, set: setBackupApiKey, placeholder: "sk-...", icon: Save, type: "password" },
                                            { label: t.modelName, val: backupModelName, set: setBackupModelName, placeholder: "gpt-3.5-turbo", icon: Sparkles, type: "text" }
                                        ].map((f, i) => (
                                            <div key={i}><label className="block text-[9px] font-black uppercase text-zinc-400 mb-1.5 tracking-[0.15em] ml-2">{f.label}</label>
                                                <div className="relative"><input type={f.type} value={f.val} onChange={(e) => f.set(e.target.value)} className="w-full pl-5 pr-12 py-3.5 bg-white/40 dark:bg-black/20 rounded-[18px] border border-black/5 dark:border-white/10 text-[0.8em] font-bold outline-none focus:ring-4 ring-blue-500/10 transition-all" placeholder={f.placeholder} /><f.icon className="absolute right-5 top-1/2 -translate-y-1/2 text-zinc-300" size={18} /></div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div className="glass-card rounded-[28px] p-10 space-y-6 shadow-apple border-white/50">
                                <div className="flex items-center gap-5 mb-4">
                                    <div className="w-14 h-14 bg-accent/10 rounded-[20px] flex items-center justify-center text-accent shadow-inner"><Volume2 size={28} /></div>
                                    <div><h3 className="text-lg font-black tracking-tight">{t.audioModel}</h3><p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest opacity-60">Voice Synthesis Engine</p></div>
                                </div>
                                <div className="space-y-6">
                                    <div className="flex items-center justify-between p-5 bg-white/20 dark:bg-white/5 rounded-[22px] border border-white/30 dark:border-white/5">
                                        <div><label className="text-[0.9em] font-black block">{t.ttsEngine}</label><span className="text-[0.7em] text-zinc-400 font-bold opacity-60 uppercase">
                                            {ttsEngine === "local" ? t.ttsLocal : t.ttsOnline}
                                        </span></div>
                                        <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-full border border-black/5">
                                            <button onClick={() => setTtsEngine("local")} className={`px-4 py-1.5 rounded-full text-[10px] font-black transition-all ${ttsEngine === "local" ? "bg-white dark:bg-zinc-800 shadow-md text-accent" : "text-zinc-400"}`}>{t.ttsLocal}</button>
                                            <button onClick={() => setTtsEngine("online")} className={`px-4 py-1.5 rounded-full text-[10px] font-black transition-all ${ttsEngine === "online" ? "bg-white dark:bg-zinc-800 shadow-md text-accent" : "text-zinc-400"}`}>{t.ttsOnline}</button>
                                        </div>
                                    </div>
                                    {ttsEngine === "online" && (
                                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-5">
                                            {[
                                                { label: t.baseUrl, val: ttsBaseUrl, set: setTtsBaseUrl, placeholder: "https://api.openai.com/v1", icon: ExternalLink, type: "text" },
                                                { label: t.apiKey, val: ttsApiKey, set: setTtsApiKey, placeholder: "sk-...", icon: Save, type: "password" },
                                                { label: t.ttsModel, val: ttsModelName, set: setTtsModelName, placeholder: "tts-1", icon: Sparkles, type: "text" }
                                            ].map((f, i) => (
                                                <div key={i}><label className="block text-[10px] font-black uppercase text-zinc-400 mb-2 tracking-[0.2em] ml-2">{f.label}</label>
                                                    <div className="relative"><input type={f.type} value={f.val} onChange={(e) => f.set(e.target.value)} className="w-full pl-5 pr-12 py-4 bg-white/40 dark:bg-black/20 rounded-[20px] border border-black/5 dark:border-white/10 text-[0.85em] dark:text-white font-bold outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:ring-4 ring-blue-500/10 transition-all" placeholder={f.placeholder} /><f.icon className="absolute right-5 top-1/2 -translate-y-1/2 text-zinc-300" size={20} /></div>
                                                </div>
                                            ))}
                                            <div><label className="block text-[10px] font-black uppercase text-zinc-400 mb-2 tracking-[0.2em] ml-2">{t.ttsVoice}</label>
                                                <div className="relative"><input value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} className="w-full px-5 py-4 bg-white/40 dark:bg-black/20 rounded-[20px] border border-black/5 dark:border-white/10 text-[0.85em] dark:text-white font-bold outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500" placeholder="alloy / Cherry..." />
                                                    <div className="mt-2 flex flex-wrap gap-2 px-2">{['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'Cherry', 'Serena'].map(v => (<button key={v} onClick={() => setTtsVoice(v)} className="text-[9px] px-2 py-1 rounded-md bg-black/5 dark:bg-white/5 hover:bg-accent hover:text-white transition-all">{v}</button>))}</div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                    <div><label className="block text-[10px] font-black uppercase text-zinc-400 mb-2 tracking-[0.2em] ml-2">{t.ttsSpeed} ({ttsSpeed}x)</label><input type="range" min="0.5" max="2.0" step="0.1" value={ttsSpeed} onChange={(e) => setTtsSpeed(e.target.value)} className="w-full accent-[var(--accent)] h-1.5 bg-black/5 dark:bg-white/5 rounded-full appearance-none" /></div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === "appearance" && (
                        <div className="space-y-6 max-w-3xl mx-auto w-full">
                            <div className="glass-card rounded-[28px] p-8 space-y-8 shadow-apple border-white/50">
                                <div><h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] mb-6 pl-2">Theme Mode</h3>
                                    <div className="grid grid-cols-3 gap-5">
                                        {[
                                            { id: "light", icon: Sun, label: t.themeLight, color: "from-orange-400 to-orange-500" },
                                            { id: "dark", icon: Moon, label: t.themeDark, color: "from-zinc-700 to-black" },
                                            { id: "system", icon: Monitor, label: t.themeSystem, color: "from-blue-400 to-indigo-600" }
                                        ].map(item => (
                                            <button key={item.id} onClick={() => setTheme(item.id)} className={`group flex flex-col items-center gap-4 p-6 rounded-[24px] border transition-all duration-500 relative overflow-hidden ${theme === item.id ? 'bg-white dark:bg-white/10 border-accent shadow-2xl scale-[1.02]' : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:bg-black/10'}`}><div className={`w-14 h-14 rounded-[20px] bg-gradient-to-br ${item.color} flex items-center justify-center text-white shadow-lg ${theme === item.id ? 'shadow-accent' : ''} transition-all`}><item.icon size={28} /></div><span className={`text-[10px] font-black uppercase tracking-widest ${theme === item.id ? 'text-accent' : 'text-zinc-400'}`}>{item.label}</span></button>
                                        ))}
                                    </div>
                                </div>

                                {/* Accent Color Picker */}
                                <div className="pt-4">
                                    <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] mb-4 pl-2">{t.accentColor}</h3>
                                    <div className="flex gap-3 px-2 flex-wrap">
                                        {ACCENT_PALETTE.map(c => (
                                            <button
                                                key={c.id}
                                                onClick={() => setAccentColor(c.value)}
                                                className={`relative w-9 h-9 rounded-full flex items-center justify-center transition-all duration-300 hover:scale-110 ${
                                                    accentColor === c.value ? 'ring-2 ring-offset-2 ring-zinc-400 dark:ring-zinc-300 scale-110' : ''
                                                }`}
                                                style={{ backgroundColor: c.value }}
                                            >
                                                {accentColor === c.value && (
                                                    <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 400, damping: 25 }}>
                                                        <CheckCircle size={12} className="text-white drop-shadow-md" fill="white" />
                                                    </motion.div>
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="pt-4"><div className="flex items-center justify-between mb-8 px-2"><div><h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">Interface Scale</h3><p className="text-[10px] text-zinc-400 font-bold opacity-60">Global UI Scaling Engine</p></div><div className="px-5 py-2.5 bg-accent rounded-2xl text-white font-black text-[12px] shadow-xl shadow-accent">{fontSize}px</div></div>
                                    <div className="px-4"><input type="range" min="10" max="24" step="1" value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value))} className="w-full accent-[var(--accent)] cursor-pointer h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full appearance-none mb-10" />
                                        <div className="p-8 bg-black/5 dark:bg-white/5 rounded-[28px] border border-black/5 dark:border-white/5 flex flex-col items-center text-center"><p className="text-[10px] font-black text-zinc-300 uppercase tracking-[0.4em] mb-4 opacity-60">Scaling Preview</p><p className="font-bold leading-relaxed max-w-sm transition-all duration-300">Everything is designed, but few things are designed well.</p></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === "wordbook" && (
                        <div className="flex h-full gap-8 relative overflow-hidden">
                            <div className="flex flex-col gap-3 overflow-y-auto custom-scrollbar pr-3 shrink-0" style={{ width: 'min(30%, 260px)', minWidth: '160px' }}>
                                {/* Search & Sort */}
                                <div className="flex gap-2">
                                    <div className="flex-1 relative">
                                        <input
                                            type="text"
                                            value={wordbookSearch}
                                            onChange={(e) => setWordbookSearch(e.target.value)}
                                            placeholder={t.searchWords}
                                            className="w-full py-2.5 pl-8 pr-8 rounded-xl bg-white/60 dark:bg-white/10 border border-black/5 dark:border-white/10 text-[10px] font-bold outline-none text-zinc-800 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:border-accent/50 focus:ring-2 ring-blue-500/10 transition-all"
                                        />
                                        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                                        {wordbookSearch && (
                                            <button onClick={() => setWordbookSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
                                                <CloseIcon size={12} />
                                            </button>
                                        )}
                                    </div>
                                    <div className="relative">
                                        <select
                                            value={wordbookSort}
                                            onChange={(e) => setWordbookSort(e.target.value as "newest" | "az" | "za")}
                                            className="py-2.5 pl-3 pr-7 rounded-xl bg-white/60 dark:bg-white/10 border border-black/5 dark:border-white/10 text-[10px] font-bold outline-none text-zinc-600 dark:text-zinc-300 appearance-none cursor-pointer focus:border-accent/50 transition-all"
                                        >
                                            <option value="newest">{t.sortNewest}</option>
                                            <option value="az">{t.sortAZ}</option>
                                            <option value="za">{t.sortZA}</option>
                                        </select>
                                        <ChevronRight size={12} className="absolute right-2 top-1/2 -translate-y-1/2 rotate-90 text-zinc-400 pointer-events-none" />
                                    </div>
                                </div>

                                {/* Word count */}
                                <div className="flex items-center justify-between px-1">
                                    <span className="text-[9px] font-black text-zinc-400 uppercase tracking-wider">
                                        {wordbookSearch ? `${filteredWords.length} / ` : ""}{words.length} {t.wordCount}
                                    </span>
                                </div>

                                {words.length > 0 && (
                                    <div className="flex gap-2">
                                        <button onClick={() => invoke("export_wordbook", { format: "csv" }).then(() => addNotification(t.exportSuccess + " (CSV)")).catch(e => addNotification(`${t.exportFailed}: ${e}`))} className="flex-1 py-2 rounded-xl bg-white/40 dark:bg-white/5 border border-black/5 dark:border-white/5 text-[9px] font-black text-zinc-500 hover:text-accent hover:border-accent/20 transition-all">{t.exportCsv}</button>
                                        <button onClick={() => invoke("export_wordbook", { format: "json" }).then(() => addNotification(t.exportSuccess + " (JSON)")).catch(e => addNotification(`${t.exportFailed}: ${e}`))} className="flex-1 py-2 rounded-xl bg-white/40 dark:bg-white/5 border border-black/5 dark:border-white/5 text-[9px] font-black text-zinc-500 hover:text-accent hover:border-accent/20 transition-all">{t.exportJson}</button>
                                    </div>
                                )}
                                <div className="mb-2"><AnimatePresence mode="wait">{!isAdding ? (
                                    <motion.button key="add-btn" initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} onClick={() => setIsAdding(true)} className="w-full py-3 rounded-2xl bg-accent/10 text-accent border border-accent/20 font-black text-[10px] flex items-center justify-center gap-2 hover:bg-accent/20 transition-all"><Plus size={14} /> {t.addWord}</motion.button>
                                ) : (
                                    <motion.div key="add-input" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative"><input autoFocus value={newWord} onChange={(e) => setNewWord(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleManualAdd()} placeholder="{t.enterWord}" className="w-full py-3 px-4 rounded-2xl bg-white/80 dark:bg-white/10 border border-accent/50 outline-none text-[11px] font-bold pr-10 text-zinc-800 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500" /><button onClick={() => { setIsAdding(false); setNewWord(""); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-red-500"><CloseIcon size={14} /></button></motion.div>
                                )}</AnimatePresence></div>
                                {displayedWords.map(w => (
                                    <motion.div layout key={w.id} onClick={() => setSelectedWord(w)} className={`group p-5 rounded-[24px] border cursor-pointer transition-all duration-500 relative ${selectedWord?.id === w.id ? 'bg-accent border-accent shadow-2xl' : 'glass-card border-transparent hover:border-accent/30 hover:bg-white/80'}`}>
                                        <div className="flex justify-between items-start mb-1.5">
                                            <h3 className={`font-black text-[0.95em] truncate pr-4 ${selectedWord?.id === w.id ? 'text-white' : 'text-zinc-800 dark:text-zinc-100'}`}>{w.word}</h3>
                                            <button onClick={(e) => { e.stopPropagation(); speak(w.word).then(refreshCacheSize); }} className={`p-1 rounded-lg transition-all ${selectedWord?.id === w.id ? 'text-white/40 hover:text-white hover:bg-white/10' : 'text-zinc-300 hover:text-accent hover:bg-accent/10'}`}><Volume2 size={13}/></button>
                                        </div>
                                        <p className={`text-[0.7em] font-bold truncate opacity-80 ${selectedWord?.id === w.id ? 'text-white/70' : 'text-zinc-400'}`}>{w.meaning || "{t.analyzing}"}</p>
                                        {selectedWord?.id === w.id && <motion.div layoutId="selectIndicator" className="absolute left-0 top-5 bottom-5 w-1 bg-white rounded-r-full" />}
                                    </motion.div>
                                ))}
                                {filteredWords.length > wordsLimit && !wordbookSearch && (
                                    <div className="flex gap-2">
                                        <button onClick={() => setWordsLimit(l => l + 200)} className="flex-1 py-3 rounded-2xl bg-accent/10 text-accent border border-accent/20 font-black text-[10px] hover:bg-accent/20 transition-all">LOAD MORE ({filteredWords.length - wordsLimit} remaining)</button>
                                        <button onClick={() => setWordsLimit(filteredWords.length)} className="py-3 px-4 rounded-2xl bg-white/40 dark:bg-white/5 border border-black/5 dark:border-white/5 font-black text-[10px] text-zinc-500 hover:text-accent transition-all">ALL</button>
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 glass-card rounded-[32px] flex flex-col overflow-hidden relative shadow-2xl border-white/40">
                                <AnimatePresence mode="wait">
                                    {selectedWord ? (!selectedWord.analysis ? (
                                        <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col items-center justify-center space-y-6">
                                            <div className="relative">
                                                <div className="w-14 h-14 border-4 border-accent/10 rounded-full animate-spin border-t-accent shadow-inner" />
                                                <Sparkles className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-accent" size={24} />
                                            </div>
                                            <div className="text-center">
                                                <p className="text-[10px] font-black uppercase tracking-[0.5em] mb-2 text-zinc-400">Neural Sync</p>
                                                <p className="text-[10px] text-zinc-300 dark:text-zinc-500 font-bold uppercase tracking-widest animate-pulse">Processing...</p>
                                            </div>
                                            <div className="pt-4">
                                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => deleteWord(selectedWord.id)} className="px-6 py-2 bg-red-500/10 text-red-500 border border-red-500/20 rounded-full text-[10px] font-black hover:bg-red-500 hover:text-white transition-all">{t.abortDelete}</motion.button>
                                            </div>
                                        </motion.div>
                                    ) : (() => {
                                        const analysis: WordAnalysis = JSON.parse(selectedWord.analysis);
                                        
                                        // Handle Failure State
                                        if (analysis.status === "failed") {
                                            return (
                                                <motion.div key="failed" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="flex-1 flex flex-col items-center justify-center p-10 space-y-6">
                                                    <div className="w-16 h-16 bg-red-500/10 rounded-3xl flex items-center justify-center text-red-500 shadow-inner"><Info size={32} /></div>
                                                    <div className="text-center max-w-sm">
                                                        <h3 className="text-lg font-black tracking-tight mb-2">{t.analysisFailed}</h3>
                                                        <p className="text-[11px] text-zinc-400 font-bold leading-relaxed">{analysis.error_msg || "Unknown AI error. Please check your model configuration and internet connection."}</p>
                                                    </div>
                                                    <div className="flex gap-3">
                                                        <button 
                                                            onClick={() => {
                                                                if (selectedWord) {
                                                                    // 立即触发 UI 加载动画
                                                                    setSelectedWord({ ...selectedWord, analysis: null });
                                                                    analyzeAndSaveWord(selectedWord.word);
                                                                }
                                                            }} 
                                                            className="px-8 py-3 bg-accent text-white rounded-2xl text-[11px] font-black shadow-lg shadow-accent flex items-center gap-2"
                                                        >
                                                            <RotateCcw size={14} /> {t.retryAnalysis}
                                                        </button>
                                                        <button onClick={() => deleteWord(selectedWord.id)} className="px-8 py-3 bg-white dark:bg-white/10 border border-black/5 dark:border-white/5 rounded-2xl text-[11px] font-black hover:bg-red-500 hover:text-white transition-all">{t.delete}</button>
                                                    </div>
                                                </motion.div>
                                            );
                                        }

                                        return (
                                            <motion.div key={selectedWord.id} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.5 }} className="flex-1 overflow-y-auto custom-scrollbar p-10 space-y-10">
                                                <div className="flex items-start justify-between pb-8 border-b border-black/5 dark:border-white/5">
                                                    <div className="flex flex-col gap-3 min-w-0"><h2 className="text-3xl font-black text-accent tracking-tighter break-words">{selectedWord.word}</h2>
                                                        <div className="flex items-center gap-3"><span className="text-zinc-400 font-mono text-[0.85em] bg-black/5 dark:bg-white/5 px-4 py-1 rounded-full border border-black/5">/{analysis.phonetic}/</span><button onClick={() => speak(selectedWord.word).then(refreshCacheSize)} className="p-2 bg-accent/10 text-accent rounded-full hover:bg-accent hover:text-white transition-all"><Volume2 size={14} /></button></div>
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => deleteWord(selectedWord.id)} className="w-12 h-12 rounded-[18px] bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500 hover:bg-red-500 hover:text-white transition-all shadow-sm"><Trash2 size={20} /></motion.button>
                                                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} className="w-12 h-12 rounded-[18px] bg-white dark:bg-white/10 border border-black/5 dark:border-white/5 flex items-center justify-center text-zinc-400 hover:text-accent shadow-md transition-all shrink-0"><ExternalLink size={20} /></motion.button>
                                                    </div>
                                                </div>
                                                <div className="space-y-6">
                                                    <div className="p-7 bg-white/50 dark:bg-white/5 rounded-[28px] border border-white/50 dark:border-white/10 shadow-sm relative overflow-hidden group"><div className="absolute top-0 left-0 w-1.5 h-full bg-accent/20" /><h4 className="text-[10px] font-black uppercase text-accent mb-3 tracking-[0.4em]">Meaning</h4><p className="font-bold leading-relaxed">{analysis.meaning}</p></div>
                                                    <div className="p-7 bg-black/[0.02] dark:bg-white/[0.02] rounded-[28px] border border-black/5 dark:border-white/5"><h4 className="text-[10px] font-black uppercase text-zinc-400 mb-3 tracking-[0.4em]">Origin & Etymology</h4><p className="text-[0.85em] text-zinc-500 dark:text-zinc-400 font-medium italic leading-relaxed">{analysis.etymology}</p></div>
                                                    <div className="p-7 bg-black/[0.02] dark:bg-white/[0.02] rounded-[28px] border border-black/5 dark:border-white/5"><h4 className="text-[10px] font-black uppercase text-zinc-400 mb-3 tracking-[0.4em]">Synonyms</h4><div className="flex flex-wrap gap-2.5">{analysis.synonyms.map(s => (<span key={s} className="px-3 py-1.5 bg-accent/5 text-accent dark:text-blue-400 text-[10px] font-black rounded-xl border border-accent/10 transition-all">{s}</span>))}</div></div>
                                                    <div className="space-y-4 pt-4"><h4 className="text-[10px] font-black uppercase text-zinc-400 tracking-[0.4em] pl-6">Examples</h4>
                                                        <div className="space-y-4">{analysis.examples.map((ex, i) => (<div key={i} className="p-7 bg-white/20 dark:bg-white/2 rounded-[28px] border border-black/5 dark:border-white/5 group transition-all hover:bg-white/40 dark:hover:bg-white/5 relative overflow-hidden"><div className="absolute top-0 left-0 bottom-0 w-1 bg-accent/10 group-hover:bg-accent transition-all" /><div className="flex justify-between items-start mb-2"><p className="font-black text-[0.9em] text-zinc-800 dark:text-zinc-100 leading-relaxed group-hover:text-accent transition-colors">"{ex.en}"</p><button onClick={() => speak(ex.en).then(refreshCacheSize)} className="p-1.5 text-zinc-300 hover:text-accent opacity-0 group-hover:opacity-100 transition-all"><Volume2 size={12} /></button></div><p className="text-[0.8em] text-zinc-400 font-bold border-l-3 border-accent/20 pl-4">{ex.zh}</p></div>))}</div>
                                                    </div>
                                                </div>
                                            </motion.div>
                                        );
                                    })()) : (
                                        <div className="flex-1 flex flex-col items-center justify-center text-zinc-200 dark:text-zinc-800 opacity-20"><Book size={80} className="mb-4" /><p className="font-black uppercase tracking-[0.6em] text-[10px]">Awaiting Selection</p></div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>
                    )}

                    {activeTab === "review" && (
                        <ReviewTab lang={lang} onRefreshStats={refreshStats} />
                    )}

                    {activeTab === "history" && (
                        <div className="flex flex-col h-full gap-4 overflow-hidden">
                            <div className="flex items-center justify-between shrink-0">
                                <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{history.length} {t.translations}</span>
                                {history.length > 0 && (
                                    <button
                                        onClick={async () => { await invoke("clear_translation_history"); setHistory([]); }}
                                        className="px-4 py-2 bg-red-500/10 text-red-500 border border-red-500/20 rounded-full text-[10px] font-black hover:bg-red-500 hover:text-white transition-all"
                                    >
                                        {t.clearAll}
                                    </button>
                                )}
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3">
                                {history.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-zinc-300 dark:text-zinc-700 opacity-40 gap-3">
                                        <Clock size={48} />
                                        <p className="font-black uppercase tracking-[0.4em] text-[10px]">{t.noHistory}</p>
                                    </div>
                                ) : (
                                    history.map((h: any) => (
                                        <motion.div
                                            key={h.id}
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            className="glass-card rounded-2xl p-5 border border-black/5 dark:border-white/5 group hover:border-accent/20 transition-all"
                                        >
                                            <div className="flex items-start justify-between gap-4">
                                                <div className="flex-1 min-w-0 space-y-3">
                                                    <p className="text-[11px] text-zinc-500 font-medium italic line-clamp-2 break-words">{h.source_text}</p>
                                                    <p className="text-[13px] text-zinc-800 dark:text-zinc-100 font-bold break-words">{h.translated_text}</p>
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-[8px] text-zinc-400 font-black uppercase tracking-wider">{h.created_at?.split(" ")[0]}</span>
                                                        {h.target_lang && <span className="text-[8px] text-accent/60 font-black uppercase">{h.target_lang}</span>}
                                                    </div>
                                                </div>
                                                <div className="flex gap-1 shrink-0">
                                                    <button
                                                        onClick={() => navigator.clipboard.writeText(h.translated_text)}
                                                        className="p-2 text-zinc-300 hover:text-accent rounded-lg hover:bg-accent/10 transition-all"
                                                        title="Copy translation"
                                                    >
                                                        <Copy size={14} />
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            await invoke("delete_translation", { id: h.id });
                                                            loadHistory();
                                                        }}
                                                        className="p-2 text-zinc-300 hover:text-red-500 rounded-lg hover:bg-red-500/10 transition-all"
                                                        title="Delete"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            </div>
                                        </motion.div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </motion.div>
            </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
