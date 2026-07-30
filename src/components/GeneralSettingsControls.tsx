import { motion } from "framer-motion";
import type { ReactNode } from "react";

export function SettingsToggle({
  checked,
  label,
  onClick,
  activeClass = "bg-accent shadow-lg shadow-accent",
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
  activeClass?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className={`relative h-6.5 w-12 cursor-pointer rounded-full transition-all focus-visible:ring-4 focus-visible:ring-accent/20 ${
        checked ? activeClass : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <motion.span
        animate={{ left: checked ? 24 : 3 }}
        className="absolute top-0.75 h-5 w-5 rounded-full bg-white shadow-sm"
      />
    </button>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-white/30 bg-white/20 p-5 transition-all hover:bg-white/40 dark:border-white/5 dark:bg-white/5 dark:hover:bg-white/10">
      <div className="min-w-0">
        <div className="block text-[0.9em] font-black leading-snug">{label}</div>
        <span className="text-[0.7em] font-bold leading-snug text-zinc-400 opacity-70">
          {description}
        </span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
