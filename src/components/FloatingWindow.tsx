import { useEffect, useState, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Star, Volume2, X, RotateCcw, Sparkles, ArrowLeftRight, CircleStop, AlertCircle, Database } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { startTranslationTask, translateStreaming, speak, TranslationTask, TranslationTaskState } from "../services/api";
import { analyzeAndSaveWord, checkWordExists } from "../services/wordbook";
import { translations, Lang } from "../i18n";

export default function FloatingWindow() {
  const [text, setText] = useState("");
  const [translation, setTranslation] = useState("");
  const [backTranslation, setBackTranslation] = useState("");
  const [taskState, setTaskState] = useState<TranslationTaskState>({ requestId: "", phase: "idle" });
  const [isBackTranslating, setIsBackTranslating] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [sourceType, setSourceType] = useState<"selection" | "ocr">("selection");
  const [lang, setLang] = useState<Lang>("zh");
  const taskRef = useRef<TranslationTask | null>(null);
  const activeRequestIdRef = useRef("");
  const t = useMemo(() => translations[lang] || translations.zh, [lang]);
  const isStreaming = taskState.phase === "loading-config"
    || taskState.phase === "checking-cache"
    || taskState.phase === "translating-primary"
    || taskState.phase === "translating-backup";
  const statusText = taskState.phase === "loading-config" ? t.translationPreparing
    : taskState.phase === "checking-cache" ? t.translationCheckingCache
      : taskState.phase === "translating-primary" ? t.translationPrimary
        : taskState.phase === "translating-backup" ? t.translationBackup
          : taskState.phase === "error" ? t.translationFailed
            : taskState.phase === "cancelled" ? t.translationCancelled
              : taskState.cached ? t.translationCacheHit
                : t.aiTranslation;

  useEffect(() => {
    const applyTheme = (savedTheme: string) => {
      const root = document.documentElement;
      if (savedTheme === "dark") root.classList.add("dark");
      else if (savedTheme === "light") root.classList.remove("dark");
      else {
        if (window.matchMedia("(prefers-color-scheme: dark)").matches) root.classList.add("dark");
        else root.classList.remove("dark");
      }
    };

    const loadConfig = async () => {
      const savedLang = await invoke<string>("get_config_value", { key: "language" }) as Lang;
      if (savedLang) setLang(savedLang);

      const savedTheme = await invoke<string>("get_config_value", { key: "theme" }) || "system";
      applyTheme(savedTheme);

      const savedFontSize = await invoke<string>("get_config_value", { key: "font_size" });
      if (savedFontSize) document.documentElement.style.fontSize = `${savedFontSize}px`;
    };
    loadConfig();

    const unlistenShortcut = listen<string>("shortcut-triggered", async (event) => {
      setSourceType("selection");
      const isExist = await checkWordExists(event.payload);
      setIsSaved(isExist);
      setText(event.payload);
      startTranslation(event.payload);
    });

    const unlistenOcr = listen<string>("ocr-triggered", async (event) => {
      setSourceType("ocr");
      const isExist = await checkWordExists(event.payload);
      setIsSaved(isExist);
      setText(event.payload);
      startTranslation(event.payload);
    });

    // Listen for settings changes from Dashboard
    interface SettingsChange { theme: string; fontSize: number }
    const unlistenSettings = listen<SettingsChange>("settings-changed", (event) => {
      applyTheme(event.payload.theme);
      document.documentElement.style.fontSize = `${event.payload.fontSize}px`;
    });

    return () => {
      unlistenShortcut.then(f => f());
      unlistenOcr.then(f => f());
      unlistenSettings.then(f => f());
      taskRef.current?.cancel();
    };
  }, []);

  const startTranslation = (sourceText: string) => {
    if (!sourceText) return;
    taskRef.current?.cancel();
    setTranslation("");
    setBackTranslation("");

    const task = startTranslationTask(sourceText, {
      onState: (nextState) => {
        if (activeRequestIdRef.current === nextState.requestId) setTaskState(nextState);
      },
      onText: (nextText, requestId) => {
        if (activeRequestIdRef.current === requestId) setTranslation(nextText);
      },
    });
    taskRef.current = task;
    activeRequestIdRef.current = task.id;
    setTaskState({ requestId: task.id, phase: "loading-config" });

    task.done.then((completion) => {
      if (activeRequestIdRef.current !== task.id || completion.status !== "success") return;
      invoke("save_translation", {
        sourceText,
        translatedText: completion.result.text,
        sourceLang: "",
        targetLang: "",
        model: completion.result.model,
      }).catch(console.error);
    });
  };

  const cancelTranslation = () => taskRef.current?.cancel();

  const startBackTranslate = async () => {
    if (!translation || isBackTranslating) return;
    setIsBackTranslating(true);
    setBackTranslation("");
    await translateStreaming(
      translation,
      (chunk) => setBackTranslation(prev => prev + chunk),
      () => setIsBackTranslating(false)
    );
  };

  const handleSaveToWordbook = () => {
    if (!text) return;
    setIsSaved(true);
    
    analyzeAndSaveWord(text, { sourceText: text, translatedText: translation, sourceType }).catch(err => {
        console.error("Background save failed", err);
        setIsSaved(false);
    });
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-white/80 dark:bg-[#1c1c1e]/80 glass border border-white/20 dark:border-white/10 shadow-2xl overflow-hidden select-none transition-colors duration-500 rounded-[24px] text-zinc-800 dark:text-zinc-100">
      {/* Apple Style Toolbar */}
      <div 
        onMouseDown={() => invoke("start_window_drag")}
        className="h-14 w-full flex items-center justify-between px-5 bg-white/30 dark:bg-black/20 border-b border-white/20 dark:border-white/10 cursor-move shrink-0"
      >
        <div className="flex items-center gap-3 pointer-events-none">
          <div className="relative">
            <div className={`w-3 h-3 rounded-full transition-all duration-500 ${isStreaming ? 'bg-accent shadow-[0_0_10px_rgba(59,130,246,0.8)]' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
            {isStreaming && (
                <motion.div 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1.5, opacity: 0 }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="absolute inset-0 bg-accent rounded-full"
                />
            )}
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] font-black text-zinc-800 dark:text-zinc-200 uppercase tracking-widest leading-none">Long AI</span>
            <span className="text-[8px] text-zinc-400 font-bold uppercase tracking-tighter">{statusText}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-1.5">
            <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onMouseDown={e => e.stopPropagation()} onClick={isStreaming ? cancelTranslation : () => startTranslation(text)} className={`p-2 hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition-colors ${isStreaming ? "text-red-500" : "text-zinc-500"}`} title={isStreaming ? t.cancelTranslation : t.retranslate}>
                {isStreaming ? <CircleStop size={16} /> : <RotateCcw size={16} />}
            </motion.button>
            <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onMouseDown={e => e.stopPropagation()} onClick={() => invoke("hide_floating_window")} className="group flex items-center justify-center w-8 h-8 bg-black/5 dark:bg-white/10 hover:bg-red-500 hover:text-white rounded-full transition-all" title={t.close}>
                <X size={16} className="text-zinc-600 dark:text-zinc-400 group-hover:text-white" />
            </motion.button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 custom-scrollbar selectable-text">
        <AnimatePresence mode="wait">
            {text ? (
                <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 break-words">
                    <div className="relative">
                        <div className="absolute -left-3 top-0 bottom-0 w-1 bg-accent/20 rounded-full" />
                        <div className="text-[12px] text-zinc-400 font-bold italic leading-relaxed pl-1 break-words">
                            {text}
                        </div>
                    </div>
                    
                    <div className="text-[16px] leading-[1.7] text-zinc-800 dark:text-zinc-100 font-medium tracking-tight break-words">
                        {translation || (isStreaming ? <span className="text-zinc-300 dark:text-zinc-600">{statusText}</span> : taskState.phase === "error" ? "" : "...")}
                        {isStreaming && (
                            <motion.span
                                animate={{ opacity: [1, 0, 1] }}
                                transition={{ repeat: Infinity, duration: 0.8 }}
                                className="inline-block w-1.5 h-5 ml-1.5 bg-accent align-middle rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                            />
                        )}
                    </div>

                    {taskState.phase === "error" && (
                        <div className="flex items-start gap-3 rounded-2xl border border-red-500/15 bg-red-500/5 p-4 text-red-600 dark:text-red-400">
                            <AlertCircle size={16} className="mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                                <div className="text-[10px] font-black uppercase tracking-wider">{t.translationFailed}</div>
                                <div className="mt-1 text-[11px] leading-relaxed opacity-80">{t[`translationError_${taskState.error?.code}`] || taskState.error?.message}</div>
                            </div>
                            <button onClick={() => startTranslation(text)} className="text-[10px] font-black hover:underline">{t.retry}</button>
                        </div>
                    )}

                    {/* Back-translation result */}
                    <AnimatePresence>
                        {(backTranslation || isBackTranslating) && (
                            <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="relative mt-2">
                                <div className="absolute -left-3 top-0 bottom-0 w-1 bg-amber-400/40 rounded-full" />
                                <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium leading-relaxed pl-1 break-words">
                                    <span className="text-[8px] font-black uppercase tracking-[0.2em] text-amber-400 mr-2">{t.backTranslation}</span>
                                    {backTranslation || (isBackTranslating ? "" : "...")}
                                    {isBackTranslating && (
                                        <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-3.5 ml-1 bg-amber-400 align-middle rounded-full" />
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.div>
            ) : (
                <div className="h-full flex flex-col items-center justify-center space-y-3 opacity-20 text-zinc-900 dark:text-white">
                    <Sparkles size={32} />
                    <span className="text-[10px] font-black uppercase tracking-[0.3em]">{t.readyToAssist}</span>
                </div>
            )}
        </AnimatePresence>
      </div>

      {/* Footer Controls */}
      <div className="px-5 py-4 bg-white/30 dark:bg-black/20 flex items-center justify-between border-t border-white/10 dark:border-white/5 shrink-0">
         <div className="flex gap-2">
          <motion.button
            whileHover={{ scale: 1.05, backgroundColor: "rgba(59,130,246,0.1)" }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigator.clipboard.writeText(translation)}
            disabled={!translation}
            className={`p-3 rounded-2xl transition-all ${translation ? "text-zinc-500 hover:text-accent" : "text-zinc-300 dark:text-zinc-700"}`}
            title={t.copyTranslation}
          >
            <Copy size={18} />
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05, backgroundColor: "rgba(59,130,246,0.1)" }}
            whileTap={{ scale: 0.95 }}
            onClick={() => speak(text)}
            disabled={!text}
            className={`p-3 rounded-2xl transition-all ${text ? "text-zinc-500 hover:text-accent" : "text-zinc-300 dark:text-zinc-700"}`}
            title={t.readAloud}
          >
            <Volume2 size={18} />
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
            onClick={handleSaveToWordbook}
            className={`p-3 rounded-2xl transition-all ${isSaved ? 'text-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/10' : 'text-zinc-500 hover:bg-accent/10 hover:text-accent'}`}
            title={isSaved ? t.saveCurrentContext : t.saveToWordbook}
          >
            <Star size={18} fill={isSaved ? "currentColor" : "none"} />
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
            onClick={startBackTranslate}
            disabled={!translation || isBackTranslating}
            className={`p-3 rounded-2xl transition-all ${!translation || isBackTranslating ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-500 hover:bg-amber-500/10 hover:text-amber-500'}`}
            title={t.backTranslation}
          >
            <ArrowLeftRight size={18} />
          </motion.button>
        </div>
        
        <div className="px-3 py-1 bg-black/5 dark:bg-white/5 rounded-full border border-white/10 flex items-center gap-1.5">
            {taskState.cached && <Database size={9} className="text-emerald-500" />}
            <span className="text-[9px] font-black text-zinc-400 uppercase tracking-tighter italic">{taskState.model || t.aiTranslation}</span>
        </div>
      </div>
    </div>
  );
}
