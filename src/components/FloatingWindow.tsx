import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Star, Volume2, X, RotateCcw, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { translateStreaming, speak } from "../services/api";
import { analyzeAndSaveWord, checkWordExists } from "../services/wordbook";

export default function FloatingWindow() {
  const [text, setText] = useState("");
  const [translation, setTranslation] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {

    const loadConfig = async () => {
      const savedLang = await invoke<string>("get_config_value", { key: "language" });
      // We still load the lang to ensure config exists, but don't store it if unused
      console.log("Current language:", savedLang);
      
      const savedTheme = await invoke<string>("get_config_value", { key: "theme" }) || "system";
      const root = document.documentElement;
      if (savedTheme === "dark") root.classList.add("dark");
      else if (savedTheme === "light") root.classList.remove("dark");
      else {
        if (window.matchMedia("(prefers-color-scheme: dark)").matches) root.classList.add("dark");
        else root.classList.remove("dark");
      }

      const savedFontSize = await invoke<string>("get_config_value", { key: "font_size" });
      if (savedFontSize) root.style.fontSize = `${savedFontSize}px`;
    };
    loadConfig();

    const unlistenShortcut = listen<string>("shortcut-triggered", async (event) => {
      const isExist = await checkWordExists(event.payload);
      setIsSaved(isExist);
      setText(event.payload);
      startTranslation(event.payload);
    });

    const unlistenOcr = listen<string>("ocr-triggered", async (event) => {
      const isExist = await checkWordExists(event.payload);
      setIsSaved(isExist);
      setText(event.payload);
      startTranslation(event.payload);
    });

    return () => {
      unlistenShortcut.then(f => f());
      unlistenOcr.then(f => f());
    };
  }, []);

  const startTranslation = async (sourceText: string) => {
    if (!sourceText) return;
    setIsStreaming(true);
    setTranslation("");
    await translateStreaming(
        sourceText,
        (chunk) => setTranslation(prev => prev + chunk),
        () => setIsStreaming(false)
    );
  };

  const handleSaveToWordbook = () => {
    if (!text || isSaved) return;
    setIsSaved(true);
    
    analyzeAndSaveWord(text).catch(err => {
        console.error("Background save failed", err);
        setIsSaved(false);
    });
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-white/80 dark:bg-[#1c1c1e]/80 glass border border-white/20 dark:border-white/10 shadow-2xl overflow-hidden select-none transition-colors duration-500 rounded-[24px]">
      {/* Apple Style Toolbar */}
      <div 
        onMouseDown={() => invoke("start_window_drag")}
        className="h-14 w-full flex items-center justify-between px-5 bg-white/30 dark:bg-black/20 border-b border-white/20 dark:border-white/10 cursor-move shrink-0"
      >
        <div className="flex items-center gap-3 pointer-events-none">
          <div className="relative">
            <div className={`w-3 h-3 rounded-full transition-all duration-500 ${isStreaming ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.8)]' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
            {isStreaming && (
                <motion.div 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1.5, opacity: 0 }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="absolute inset-0 bg-blue-500 rounded-full"
                />
            )}
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] font-black text-zinc-800 dark:text-zinc-200 uppercase tracking-widest leading-none">AI Intelligence</span>
            <span className="text-[8px] text-zinc-400 font-bold uppercase tracking-tighter">Processing...</span>
          </div>
        </div>
        
        <div className="flex items-center gap-1.5">
            <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onMouseDown={e => e.stopPropagation()} onClick={() => startTranslation(text)} className="p-2 hover:bg-black/5 dark:hover:bg-white/10 rounded-full text-zinc-500 transition-colors">
                <RotateCcw size={16} />
            </motion.button>
            <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onMouseDown={e => e.stopPropagation()} onClick={() => invoke("hide_floating_window")} className="group flex items-center justify-center w-8 h-8 bg-black/5 dark:bg-white/10 hover:bg-red-500 hover:text-white rounded-full transition-all">
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
                        <div className="absolute -left-3 top-0 bottom-0 w-1 bg-blue-500/20 rounded-full" />
                        <div className="text-[12px] text-zinc-400 font-bold italic leading-relaxed pl-1 break-words">
                            {text}
                        </div>
                    </div>
                    
                    <div className="text-[16px] leading-[1.7] text-zinc-800 dark:text-zinc-100 font-medium tracking-tight break-words">
                        {translation || (isStreaming ? "" : "...")}
                        {isStreaming && (
                            <motion.span 
                                animate={{ opacity: [1, 0, 1] }}
                                transition={{ repeat: Infinity, duration: 0.8 }}
                                className="inline-block w-1.5 h-5 ml-1.5 bg-blue-500 align-middle rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)]" 
                            />
                        )}
                    </div>
                </motion.div>
            ) : (
                <div className="h-full flex flex-col items-center justify-center space-y-3 opacity-20">
                    <Sparkles size={32} />
                    <span className="text-[10px] font-black uppercase tracking-[0.3em]">Ready to assist</span>
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
            className="p-3 text-zinc-500 hover:text-blue-500 rounded-2xl transition-all"
          >
            <Copy size={18} />
          </motion.button>
          <motion.button 
            whileHover={{ scale: 1.05, backgroundColor: "rgba(59,130,246,0.1)" }} 
            whileTap={{ scale: 0.95 }}
            onClick={() => speak(text)}
            className="p-3 text-zinc-500 hover:text-blue-500 rounded-2xl transition-all"
          >
            <Volume2 size={18} />
          </motion.button>
          <motion.button 
            whileHover={{ scale: 1.05 }} 
            whileTap={{ scale: 0.9 }}
            onClick={handleSaveToWordbook} 
            className={`p-3 rounded-2xl transition-all ${isSaved ? 'text-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/10' : 'text-zinc-500 hover:bg-blue-500/10 hover:text-blue-500'}`}
          >
            <Star size={18} fill={isSaved ? "currentColor" : "none"} />
          </motion.button>
        </div>
        
        <div className="px-3 py-1 bg-black/5 dark:bg-white/5 rounded-full border border-white/10">
            <span className="text-[9px] font-black text-zinc-400 uppercase tracking-tighter italic">AI TRANSLATION</span>
        </div>
      </div>
    </div>
  );
}
