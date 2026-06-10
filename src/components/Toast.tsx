import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
}

const iconMap = {
  success: { icon: CheckCircle, color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  error:   { icon: XCircle,     color: "text-red-500",     bg: "bg-red-500/10",     border: "border-red-500/20" },
  warning: { icon: AlertTriangle, color: "text-amber-500",  bg: "bg-amber-500/10",  border: "border-amber-500/20" },
  info:    { icon: Info,        color: "text-blue-500",    bg: "bg-blue-500/10",    border: "border-blue-500/20" },
};

let nextId = 0;
let notifyFn: ((type: ToastType, message: string) => void) | null = null;

/** Imperative toast trigger — call from anywhere. */
export function toast(type: ToastType, message: string) {
  notifyFn?.(type, message);
}

/** Render once near the root of the component tree. */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = String(++nextId);
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3500);
  }, []);

  useEffect(() => {
    notifyFn = addToast;
    return () => { notifyFn = null; };
  }, [addToast]);

  const dismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <div className="fixed top-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none" aria-live="polite">
      <AnimatePresence>
        {toasts.map(t => {
          const cfg = iconMap[t.type];
          const Icon = cfg.icon;
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 80, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 400, damping: 28 }}
              className={`pointer-events-auto flex items-center gap-3 pl-4 pr-2 py-3 rounded-2xl backdrop-blur-2xl border shadow-2xl ${cfg.bg} ${cfg.border}`}
            >
              <Icon size={16} className={`shrink-0 ${cfg.color}`} />
              <span className="text-[11px] font-bold text-zinc-800 dark:text-zinc-100 leading-snug">{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X size={12} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
