import { useState, useEffect, useMemo, useRef } from "react";
import { Settings, Book, Cpu, Save, CheckCircle, Trash2, Palette, Sun, Moon, Monitor, ChevronRight, Sparkles, ExternalLink, Info, Languages, Copy, RotateCcw, Plus, X as CloseIcon, Volume2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { translations, Lang } from "../i18n";
import { WordAnalysis, analyzeAndSaveWord } from "../services/wordbook";
import { translateStreaming, speak } from "../services/api";

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("general");
  const [lang, setLang] = useState<Lang>("zh");
  const [targetLang, setTargetLang] = useState("Chinese");
  const [autoCopy, setAutoCopy] = useState(false);
  const [theme, setTheme] = useState("system");
  const [fontSize, setFontSize] = useState(14);
  const [status, setStatus] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState("");
  const [cacheSize, setCacheSize] = useState("0 B");
  const [appStats, setAppStats] = useState({ word_count: 0, trans_count: 0, days_active: 1 });

  // WebDAV Config
  const [webdavEnabled, setWebdavEnabled] = useState(false);
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUser, setWebdavUser] = useState("");
  const [webdavPass, setWebdavPass] = useState("");

  // Translation Model Config
  const [transApiKey, setTransApiKey] = useState("");
  const [transBaseUrl, setTransBaseUrl] = useState("");
  const [transModelName, setTransModelName] = useState("");

  // Audio (TTS) Model Config
  const [ttsEngine, setTtsEngine] = useState("local");
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModelName, setTtsModelName] = useState("");
  const [ttsVoice, setTtsVoice] = useState("alloy");
  const [ttsSpeed, setTtsSpeed] = useState("1.0");

  const [words, setWords] = useState<any[]>([]);
  const [selectedWord, setSelectedWord] = useState<any>(null);

  // Batch Translator state
  const [batchInput, setBatchInput] = useState("");
  const [batchOutput, setBatchOutput] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);

  // Manual Add Word state
  const [newWord, setNewWord] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const syncTimerRef = useRef<any>(null);
  const t = useMemo(() => translations[lang] || translations.zh, [lang]);

  const refreshStats = async () => {
    try {
        const stats = await invoke<any>("get_app_stats");
        setAppStats(stats);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    loadConfig();
    loadWordbook();
    refreshCacheSize();
    refreshStats();
    
    const unlisten = listen<string>("wordbook-updated", (event) => {
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

    return () => { 
        unlisten.then(f => f()); 
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [webdavEnabled]);

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
      setStatus(t.cacheCleared);
      setTimeout(() => setStatus(""), 2000);
    } catch (e) { console.error(e); }
  };

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

      setLang(await getVal("language") as Lang || "zh");
      setTargetLang(await getVal("target_lang") || "Chinese");
      setAutoCopy((await getVal("auto_copy")) === "true");
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

      setAutoLaunch(await isEnabled());
    } catch (e) { console.error(e); }
  };

  const toggleAutoLaunch = async () => {
    try {
        const next = !autoLaunch;
        if (next) await enable();
        else await disable();
        setAutoLaunch(next);
    } catch (e) { console.error(e); }
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

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setStatus(t.syncing);
    try {
      await invoke("sync_wordbook");
      setStatus(t.syncSuccess);
      const time = await invoke<string>("get_config_value", { key: "last_sync_time" });
      setLastSyncTime(time);
      await loadWordbook();
    } catch (e) {
      console.error(e);
      setStatus(`${t.syncFailed}: ${e}`);
    } finally {
      setIsSyncing(false);
      setTimeout(() => setStatus(""), 5000);
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
        setVal("auto_copy", autoCopy ? "true" : "false"),
        setVal("theme", theme),
        setVal("font_size", fontSize.toString()),
        setVal("tts_engine", ttsEngine),
        setVal("tts_api_key", ttsApiKey),
        setVal("tts_base_url", ttsBaseUrl),
        setVal("tts_model_name", ttsModelName),
        setVal("tts_voice", ttsVoice),
        setVal("tts_speed", ttsSpeed),
        setVal("webdav_enabled", webdavEnabled ? "true" : "false"),
        setVal("webdav_url", webdavUrl),
        setVal("webdav_user", webdavUser),
        setVal("webdav_pass", webdavPass)
      ]);
      setStatus(t.success);
      setTimeout(() => setStatus(""), 3000);
    } catch (e) { setStatus(t.error); }
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
    await translateStreaming(
      batchInput,
      (chunk) => setBatchOutput(prev => prev + chunk),
      () => {
        setIsTranslating(false);
        refreshStats();
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
  ];

  return (
    <div className="flex h-screen apple-gradient-bg text-zinc-900 dark:text-zinc-100 overflow-hidden font-sans select-none transition-colors duration-1000" style={{ fontSize: `${fontSize}px` }}>
      {/* Sidebar */}
      <div 
        className="glass border-r border-black/5 dark:border-white/5 flex flex-col z-20 shadow-xl shrink-0" 
        style={{ width: '180px', minWidth: '160px' }}
      >
        <div className="p-6">
            <div className="flex items-center gap-3 mb-8 group">
              <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 via-blue-600 to-blue-700 rounded-xl flex items-center justify-center text-white text-lg font-black shadow-lg shadow-blue-500/30 group-hover:rotate-12 transition-transform duration-500">
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
                        className="absolute inset-0 bg-blue-600 rounded-xl shadow-lg shadow-blue-600/20" 
                        transition={{ type: "spring", bounce: 0.1, duration: 0.5 }} 
                        />
                    )}
                    <span className="relative z-10 flex items-center gap-2.5 font-bold">
                        <tab.icon size={15} className={activeTab === tab.id ? "text-white" : "text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors"} /> 
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
                    <span className="text-[10px] font-black text-blue-600">{appStats.word_count}</span>
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Languages size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">Trans</span></div>
                    <span className="text-[10px] font-black text-blue-600">{appStats.trans_count}</span>
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-400"><Monitor size={12} /><span className="text-[9px] font-black uppercase tracking-tighter">Days</span></div>
                    <span className="text-[10px] font-black text-blue-600">{appStats.days_active}d</span>
                </div>
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
                    <span className="w-1 h-1 rounded-full bg-blue-500/40" />
                    <span className="text-[10px] font-black text-blue-600/60 dark:text-blue-400/60 tracking-widest uppercase italic">LONG AI</span>
                </div>
                <p className="text-[9px] text-zinc-400 font-bold uppercase tracking-[0.3em] opacity-60">Long翻译 · 智能助手</p>
            </div>
            <div className="flex items-center gap-4">
                <AnimatePresence>
                    {status && (
                        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="flex items-center gap-2 px-4 py-2 bg-green-500/10 text-green-600 border border-green-500/20 rounded-full text-[10px] font-black">
                            <CheckCircle size={12} /> {status}
                        </motion.div>
                    )}
                </AnimatePresence>
                {activeTab !== 'wordbook' && activeTab !== 'batch' && (
                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={handleSave} className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2.5 rounded-full font-black text-[12px] shadow-xl shadow-blue-600/20 transition-all">
                        <Save size={14} /> {t.save}
                    </motion.button>
                )}
            </div>
        </header>

        <main className="flex-1 overflow-y-auto custom-scrollbar px-10 py-8 relative">
            <AnimatePresence mode="wait">
                <motion.div key={activeTab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3 }} className="h-full flex flex-col">
                    {activeTab === "general" && (
                        <div className="space-y-6 max-w-2xl">
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
                                                <ChevronRight size={14} className={`text-zinc-400 group-hover:text-blue-500 transition-all ${isLangOpen ? 'rotate-90' : ''}`} />
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
                                                                className={`w-full text-left px-5 py-2.5 text-[11px] font-black transition-all ${lang === opt.id ? 'bg-blue-600 text-white' : 'hover:bg-black/5 dark:hover:bg-white/5 text-zinc-500'}`}
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
                                    { label: t.targetLang, desc: "Translation Output", component: (
                                        <input value={targetLang} onChange={(e) => setTargetLang(e.target.value)} className="bg-white/60 dark:bg-white/10 px-6 py-2.5 rounded-2xl border border-black/5 dark:border-white/10 font-black text-[12px] w-40 outline-none text-right focus:ring-4 ring-blue-500/10 transition-all" />
                                    )},
                                    { label: t.autoCopy, desc: "Clipboard Integration", component: (
                                        <div onClick={() => setAutoCopy(!autoCopy)} className={`w-12 h-6.5 rounded-full cursor-pointer transition-all relative ${autoCopy ? 'bg-blue-600 shadow-lg shadow-blue-500/20' : 'bg-zinc-300 dark:bg-zinc-700'}`}>
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
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex flex-col">
                                        <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">{t.cloudSync}</h3>
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className="text-[9px] font-black text-zinc-400 uppercase opacity-60">{t.lastSync}:</span>
                                            <span className="text-[9px] font-black text-blue-500 uppercase">{lastSyncTime || t.neverSync}</span>
                                        </div>
                                    </div>
                                    <div onClick={toggleWebdav} className={`w-12 h-6.5 rounded-full cursor-pointer transition-all relative ${webdavEnabled ? 'bg-green-500 shadow-lg shadow-green-500/20' : 'bg-zinc-300 dark:bg-zinc-700'}`}>
                                        <motion.div animate={{ left: webdavEnabled ? 24 : 3 }} className="absolute w-5 h-5 bg-white rounded-full top-0.75 shadow-sm" />
                                    </div>
                                </div>
                                
                                <AnimatePresence>
                                    {webdavEnabled && (
                                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="space-y-4 overflow-hidden">
                                            <div className="p-4 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                                                <div className="flex gap-3">
                                                    <Info size={16} className="text-blue-500 shrink-0 mt-0.5" />
                                                    <p className="text-[10px] font-bold leading-relaxed text-blue-600/80 dark:text-blue-400/80">{t.webdavUrlHelp}</p>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-1 gap-3">
                                                <input value={webdavUrl} onChange={(e) => setWebdavUrl(e.target.value)} placeholder={t.webdavUrl} className="bg-white/60 dark:bg-black/20 px-4 py-3 rounded-xl border border-black/5 dark:border-white/10 font-bold text-[0.8em] outline-none" />
                                                <div className="grid grid-cols-2 gap-3">
                                                    <input value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} placeholder={t.webdavUser} className="bg-white/60 dark:bg-black/20 px-4 py-3 rounded-xl border border-black/5 dark:border-white/10 font-bold text-[0.8em] outline-none" />
                                                    <input type="password" value={webdavPass} onChange={(e) => setWebdavPass(e.target.value)} placeholder={t.webdavPass} className="bg-white/60 dark:bg-black/20 px-4 py-3 rounded-xl border border-black/5 dark:border-white/10 font-bold text-[0.8em] outline-none" />
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
                            </div>
                        </div>
                    )}

                    {activeTab === "batch" && (
                        <div className="space-y-6 flex-1 flex flex-col min-h-0">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                                <div className="flex flex-col gap-4">
                                    <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] pl-4">Input Text</h3>
                                    <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative">
                                        <textarea value={batchInput} onChange={(e) => setBatchInput(e.target.value)} placeholder={t.inputPlaceholder} className="w-full h-full bg-transparent outline-none resize-none font-medium custom-scrollbar text-[0.9em] leading-relaxed" />
                                        <div className="absolute bottom-6 right-6">
                                            <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={startBatchTranslation} disabled={isTranslating || !batchInput} className={`px-6 py-2.5 rounded-full font-black text-[11px] shadow-xl flex items-center gap-2 transition-all ${isTranslating || !batchInput ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-400' : 'bg-blue-600 text-white shadow-blue-500/20'}`}>
                                                {isTranslating ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Languages size={14} />} {t.translate}
                                            </motion.button>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-col gap-4">
                                    <div className="flex justify-between items-center px-4">
                                        <h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">Output</h3>
                                        {batchOutput && <button onClick={() => navigator.clipboard.writeText(batchOutput)} className="text-[10px] font-bold text-blue-600 hover:bg-blue-500/10 px-3 py-1 rounded-full flex items-center gap-1.5 transition-all"><Copy size={12} /> {t.copy}</button>}
                                    </div>
                                    <div className="flex-1 glass-card rounded-[28px] overflow-hidden p-6 border-white/50 relative bg-black/[0.02] dark:bg-white/[0.02]">
                                        <div className="w-full h-full custom-scrollbar overflow-y-auto font-medium text-[0.9em] leading-relaxed selectable-text">
                                            {batchOutput || (isTranslating ? "" : <span className="opacity-30 italic">{t.outputPlaceholder}</span>)}
                                            {isTranslating && <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-4 ml-1 bg-blue-500 align-middle" />}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === "model" && (
                        <div className="space-y-8 max-w-2xl pb-20">
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
                                            <div className="relative"><input type={f.type} value={f.val} onChange={(e) => f.set(e.target.value)} className="w-full pl-5 pr-12 py-4 bg-white/40 dark:bg-black/20 rounded-[20px] border border-black/5 dark:border-white/10 text-[0.85em] font-bold outline-none focus:ring-4 ring-blue-500/10 transition-all" placeholder={f.placeholder} /><f.icon className="absolute right-5 top-1/2 -translate-y-1/2 text-zinc-300" size={20} /></div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="glass-card rounded-[28px] p-10 space-y-6 shadow-apple border-white/50">
                                <div className="flex items-center gap-5 mb-4">
                                    <div className="w-14 h-14 bg-blue-600/10 rounded-[20px] flex items-center justify-center text-blue-600 shadow-inner"><Volume2 size={28} /></div>
                                    <div><h3 className="text-lg font-black tracking-tight">{t.audioModel}</h3><p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest opacity-60">Voice Synthesis Engine</p></div>
                                </div>
                                <div className="space-y-6">
                                    <div className="flex items-center justify-between p-5 bg-white/20 dark:bg-white/5 rounded-[22px] border border-white/30 dark:border-white/5">
                                        <div><label className="text-[0.9em] font-black block">{t.ttsEngine}</label><span className="text-[0.7em] text-zinc-400 font-bold opacity-60 uppercase">{ttsEngine === "local" ? t.ttsLocal : t.ttsOnline}</span></div>
                                        <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-full border border-black/5">
                                            <button onClick={() => setTtsEngine("local")} className={`px-4 py-1.5 rounded-full text-[10px] font-black transition-all ${ttsEngine === "local" ? "bg-white dark:bg-zinc-800 shadow-md text-blue-600" : "text-zinc-400"}`}>{t.ttsLocal}</button>
                                            <button onClick={() => setTtsEngine("online")} className={`px-4 py-1.5 rounded-full text-[10px] font-black transition-all ${ttsEngine === "online" ? "bg-white dark:bg-zinc-800 shadow-md text-blue-600" : "text-zinc-400"}`}>{t.ttsOnline}</button>
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
                                                    <div className="relative"><input type={f.type} value={f.val} onChange={(e) => f.set(e.target.value)} className="w-full pl-5 pr-12 py-4 bg-white/40 dark:bg-black/20 rounded-[20px] border border-black/5 dark:border-white/10 text-[0.85em] font-bold outline-none focus:ring-4 ring-blue-500/10 transition-all" placeholder={f.placeholder} /><f.icon className="absolute right-5 top-1/2 -translate-y-1/2 text-zinc-300" size={20} /></div>
                                                </div>
                                            ))}
                                            <div><label className="block text-[10px] font-black uppercase text-zinc-400 mb-2 tracking-[0.2em] ml-2">{t.ttsVoice}</label>
                                                <div className="relative"><input value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} className="w-full px-5 py-4 bg-white/40 dark:bg-black/20 rounded-[20px] border border-black/5 dark:border-white/10 text-[0.85em] font-bold outline-none" placeholder="alloy / Cherry..." />
                                                    <div className="mt-2 flex flex-wrap gap-2 px-2">{['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'Cherry', 'Serena'].map(v => (<button key={v} onClick={() => setTtsVoice(v)} className="text-[9px] px-2 py-1 rounded-md bg-black/5 dark:bg-white/5 hover:bg-blue-500 hover:text-white transition-all">{v}</button>))}</div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                    <div><label className="block text-[10px] font-black uppercase text-zinc-400 mb-2 tracking-[0.2em] ml-2">{t.ttsSpeed} ({ttsSpeed}x)</label><input type="range" min="0.5" max="2.0" step="0.1" value={ttsSpeed} onChange={(e) => setTtsSpeed(e.target.value)} className="w-full accent-blue-600 h-1.5 bg-black/5 dark:bg-white/5 rounded-full appearance-none" /></div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === "appearance" && (
                        <div className="space-y-6 max-w-2xl">
                            <div className="glass-card rounded-[28px] p-8 space-y-8 shadow-apple border-white/50">
                                <div><h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em] mb-6 pl-2">Theme Mode</h3>
                                    <div className="grid grid-cols-3 gap-5">
                                        {[
                                            { id: "light", icon: Sun, label: t.themeLight, color: "from-orange-400 to-orange-500" },
                                            { id: "dark", icon: Moon, label: t.themeDark, color: "from-zinc-700 to-black" },
                                            { id: "system", icon: Monitor, label: t.themeSystem, color: "from-blue-400 to-indigo-600" }
                                        ].map(item => (
                                            <button key={item.id} onClick={() => setTheme(item.id)} className={`group flex flex-col items-center gap-4 p-6 rounded-[24px] border transition-all duration-500 relative overflow-hidden ${theme === item.id ? 'bg-white dark:bg-white/10 border-blue-500 shadow-2xl scale-[1.02]' : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:bg-black/10'}`}><div className={`w-14 h-14 rounded-[20px] bg-gradient-to-br ${item.color} flex items-center justify-center text-white shadow-lg ${theme === item.id ? 'shadow-blue-500/30' : ''} transition-all`}><item.icon size={28} /></div><span className={`text-[10px] font-black uppercase tracking-widest ${theme === item.id ? 'text-blue-600' : 'text-zinc-400'}`}>{item.label}</span></button>
                                        ))}
                                    </div>
                                </div>
                                <div className="pt-4"><div className="flex items-center justify-between mb-8 px-2"><div><h3 className="text-[11px] font-black uppercase text-zinc-400 tracking-[0.2em]">Interface Scale</h3><p className="text-[10px] text-zinc-400 font-bold opacity-60">Global UI Scaling Engine</p></div><div className="px-5 py-2.5 bg-blue-600 rounded-2xl text-white font-black text-[12px] shadow-xl shadow-blue-500/30">{fontSize}px</div></div>
                                    <div className="px-4"><input type="range" min="10" max="24" step="1" value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value))} className="w-full accent-blue-600 cursor-pointer h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full appearance-none mb-10" />
                                        <div className="p-8 bg-black/5 dark:bg-white/5 rounded-[28px] border border-black/5 dark:border-white/5 flex flex-col items-center text-center"><p className="text-[10px] font-black text-zinc-300 uppercase tracking-[0.4em] mb-4 opacity-60">Scaling Preview</p><p className="font-bold leading-relaxed max-w-sm transition-all duration-300">Everything is designed, but few things are designed well.</p></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === "wordbook" && (
                        <div className="flex h-full gap-8 relative overflow-hidden">
                            <div className="flex flex-col gap-3 overflow-y-auto custom-scrollbar pr-3 shrink-0" style={{ width: 'min(30%, 260px)', minWidth: '160px' }}>
                                <div className="mb-2"><AnimatePresence mode="wait">{!isAdding ? (
                                    <motion.button key="add-btn" initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} onClick={() => setIsAdding(true)} className="w-full py-3 rounded-2xl bg-blue-600/10 text-blue-600 border border-blue-600/20 font-black text-[10px] flex items-center justify-center gap-2 hover:bg-blue-600/20 transition-all"><Plus size={14} /> ADD WORD</motion.button>
                                ) : (
                                    <motion.div key="add-input" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative"><input autoFocus value={newWord} onChange={(e) => setNewWord(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleManualAdd()} placeholder="Enter word..." className="w-full py-3 px-4 rounded-2xl bg-white/80 dark:bg-white/10 border border-blue-500/50 outline-none text-[11px] font-bold pr-10" /><button onClick={() => { setIsAdding(false); setNewWord(""); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-red-500"><CloseIcon size={14} /></button></motion.div>
                                )}</AnimatePresence></div>
                                {words.map(w => (
                                    <motion.div layout key={w.id} onClick={() => setSelectedWord(w)} className={`group p-5 rounded-[24px] border cursor-pointer transition-all duration-500 relative ${selectedWord?.id === w.id ? 'bg-blue-600 border-blue-600 shadow-2xl' : 'glass-card border-transparent hover:border-blue-500/30 hover:bg-white/80'}`}>
                                        <div className="flex justify-between items-start mb-1.5">
                                            <h3 className={`font-black text-[0.95em] truncate pr-4 ${selectedWord?.id === w.id ? 'text-white' : 'text-zinc-800 dark:text-zinc-100'}`}>{w.word}</h3>
                                            <button onClick={(e) => { e.stopPropagation(); speak(w.word).then(refreshCacheSize); }} className={`p-1 rounded-lg transition-all ${selectedWord?.id === w.id ? 'text-white/40 hover:text-white hover:bg-white/10' : 'text-zinc-300 hover:text-blue-600 hover:bg-blue-500/10'}`}><Volume2 size={13}/></button>
                                        </div>
                                        <p className={`text-[0.7em] font-bold truncate opacity-80 ${selectedWord?.id === w.id ? 'text-white/70' : 'text-zinc-400'}`}>{w.meaning || "Analyzing..."}</p>
                                        {selectedWord?.id === w.id && <motion.div layoutId="selectIndicator" className="absolute left-0 top-5 bottom-5 w-1 bg-white rounded-r-full" />}
                                    </motion.div>
                                ))}
                            </div>
                            <div className="flex-1 glass-card rounded-[32px] flex flex-col overflow-hidden relative shadow-2xl border-white/40">
                                <AnimatePresence mode="wait">
                                    {selectedWord ? (!selectedWord.analysis ? (
                                        <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col items-center justify-center space-y-6">
                                            <div className="relative">
                                                <div className="w-14 h-14 border-4 border-blue-600/10 rounded-full animate-spin border-t-blue-600 shadow-inner" />
                                                <Sparkles className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-blue-600" size={24} />
                                            </div>
                                            <div className="text-center">
                                                <p className="text-[10px] font-black uppercase tracking-[0.5em] mb-2 text-zinc-400">Neural Sync</p>
                                                <p className="text-[10px] text-zinc-300 font-bold uppercase tracking-widest animate-pulse">Processing...</p>
                                            </div>
                                            <div className="pt-4">
                                                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => deleteWord(selectedWord.id)} className="px-6 py-2 bg-red-500/10 text-red-500 border border-red-500/20 rounded-full text-[10px] font-black hover:bg-red-500 hover:text-white transition-all">ABORT & DELETE</motion.button>
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
                                                        <h3 className="text-lg font-black tracking-tight mb-2">Analysis Failed</h3>
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
                                                            className="px-8 py-3 bg-blue-600 text-white rounded-2xl text-[11px] font-black shadow-lg shadow-blue-500/20 flex items-center gap-2"
                                                        >
                                                            <RotateCcw size={14} /> RETRY ANALYSIS
                                                        </button>
                                                        <button onClick={() => deleteWord(selectedWord.id)} className="px-8 py-3 bg-white dark:bg-white/10 border border-black/5 dark:border-white/5 rounded-2xl text-[11px] font-black hover:bg-red-500 hover:text-white transition-all">DELETE</button>
                                                    </div>
                                                </motion.div>
                                            );
                                        }

                                        return (
                                            <motion.div key={selectedWord.id} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.5 }} className="flex-1 overflow-y-auto custom-scrollbar p-10 space-y-10">
                                                <div className="flex items-start justify-between pb-8 border-b border-black/5 dark:border-white/5">
                                                    <div className="flex flex-col gap-3 min-w-0"><h2 className="text-3xl font-black text-blue-600 tracking-tighter break-words">{selectedWord.word}</h2>
                                                        <div className="flex items-center gap-3"><span className="text-zinc-400 font-mono text-[0.85em] bg-black/5 dark:bg-white/5 px-4 py-1 rounded-full border border-black/5">/{analysis.phonetic}/</span><button onClick={() => speak(selectedWord.word).then(refreshCacheSize)} className="p-2 bg-blue-600/10 text-blue-600 rounded-full hover:bg-blue-600 hover:text-white transition-all"><Volume2 size={14} /></button></div>
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => deleteWord(selectedWord.id)} className="w-12 h-12 rounded-[18px] bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500 hover:bg-red-500 hover:text-white transition-all shadow-sm"><Trash2 size={20} /></motion.button>
                                                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} className="w-12 h-12 rounded-[18px] bg-white dark:bg-white/10 border border-black/5 dark:border-white/5 flex items-center justify-center text-zinc-400 hover:text-blue-600 shadow-md transition-all shrink-0"><ExternalLink size={20} /></motion.button>
                                                    </div>
                                                </div>
                                                <div className="space-y-6">
                                                    <div className="p-7 bg-white/50 dark:bg-white/5 rounded-[28px] border border-white/50 dark:border-white/10 shadow-sm relative overflow-hidden group"><div className="absolute top-0 left-0 w-1.5 h-full bg-blue-600/20" /><h4 className="text-[10px] font-black uppercase text-blue-500 mb-3 tracking-[0.4em]">Meaning</h4><p className="font-bold leading-relaxed">{analysis.meaning}</p></div>
                                                    <div className="p-7 bg-black/[0.02] dark:bg-white/[0.02] rounded-[28px] border border-black/5 dark:border-white/5"><h4 className="text-[10px] font-black uppercase text-zinc-400 mb-3 tracking-[0.4em]">Origin & Etymology</h4><p className="text-[0.85em] text-zinc-500 dark:text-zinc-400 font-medium italic leading-relaxed">{analysis.etymology}</p></div>
                                                    <div className="p-7 bg-black/[0.02] dark:bg-white/[0.02] rounded-[28px] border border-black/5 dark:border-white/5"><h4 className="text-[10px] font-black uppercase text-zinc-400 mb-3 tracking-[0.4em]">Synonyms</h4><div className="flex flex-wrap gap-2.5">{analysis.synonyms.map(s => (<span key={s} className="px-3 py-1.5 bg-blue-500/5 text-blue-600 dark:text-blue-400 text-[10px] font-black rounded-xl border border-blue-500/10 transition-all">{s}</span>))}</div></div>
                                                    <div className="space-y-4 pt-4"><h4 className="text-[10px] font-black uppercase text-zinc-400 tracking-[0.4em] pl-6">Examples</h4>
                                                        <div className="space-y-4">{analysis.examples.map((ex, i) => (<div key={i} className="p-7 bg-white/20 dark:bg-white/2 rounded-[28px] border border-black/5 dark:border-white/5 group transition-all hover:bg-white/40 dark:hover:bg-white/5 relative overflow-hidden"><div className="absolute top-0 left-0 bottom-0 w-1 bg-blue-500/10 group-hover:bg-blue-600 transition-all" /><div className="flex justify-between items-start mb-2"><p className="font-black text-[0.9em] text-zinc-800 dark:text-zinc-100 leading-relaxed group-hover:text-blue-600 transition-colors">"{ex.en}"</p><button onClick={() => speak(ex.en).then(refreshCacheSize)} className="p-1.5 text-zinc-300 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-all"><Volume2 size={12} /></button></div><p className="text-[0.8em] text-zinc-400 font-bold border-l-3 border-blue-500/20 pl-4">{ex.zh}</p></div>))}</div>
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
                </motion.div>
            </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
