import { CheckCircle, Monitor, Moon, Sun } from "lucide-react";
import { motion } from "framer-motion";
import type { TranslationCatalog } from "../i18n";

export interface AppearanceConfig {
  theme: string;
  accentColor: string;
  fontSize: number;
}

export type AppearanceConfigPatch = Partial<AppearanceConfig>;

interface AppearanceSettingsTabProps {
  labels: TranslationCatalog;
  value: AppearanceConfig;
  onChange: (patch: AppearanceConfigPatch) => void;
}

export default function AppearanceSettingsTab({
  labels,
  value,
  onChange,
}: AppearanceSettingsTabProps) {
  const themes = [
    {
      id: "light",
      icon: Sun,
      label: labels.themeLight,
      color: "from-orange-400 to-orange-500",
    },
    {
      id: "dark",
      icon: Moon,
      label: labels.themeDark,
      color: "from-zinc-700 to-black",
    },
    {
      id: "system",
      icon: Monitor,
      label: labels.themeSystem,
      color: "from-blue-400 to-indigo-600",
    },
  ];
  const accentPalette = [
    { label: labels.accentColorBlue, value: "#007aff" },
    { label: labels.accentColorIndigo, value: "#5856d6" },
    { label: labels.accentColorViolet, value: "#af52de" },
    { label: labels.accentColorPink, value: "#ff2d55" },
    { label: labels.accentColorOrange, value: "#ff9500" },
    { label: labels.accentColorGreen, value: "#34c759" },
    { label: labels.accentColorTeal, value: "#5ac8fa" },
    { label: labels.accentColorMint, value: "#00c7be" },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="glass-card space-y-8 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
        <div>
          <h3 className="mb-6 pl-2 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
            {labels.themeMode}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-5">
            {themes.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={value.theme === item.id}
                onClick={() => onChange({ theme: item.id })}
                className={`group relative flex items-center gap-4 overflow-hidden rounded-[24px] border p-4 transition-all duration-500 sm:flex-col sm:p-6 ${
                  value.theme === item.id
                    ? "scale-[1.02] border-accent bg-white shadow-2xl dark:bg-white/10"
                    : "border-transparent bg-black/5 text-zinc-500 hover:bg-black/10 dark:bg-white/5"
                }`}
              >
                <div
                  className={`flex h-14 w-14 items-center justify-center rounded-[20px] bg-gradient-to-br ${item.color} text-white shadow-lg ${
                    value.theme === item.id ? "shadow-accent" : ""
                  } transition-all`}
                >
                  <item.icon size={28} />
                </div>
                <span
                  className={`text-[10px] font-black uppercase tracking-widest ${
                    value.theme === item.id ? "text-accent" : "text-zinc-400"
                  }`}
                >
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="pt-4">
          <h3 className="mb-4 pl-2 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
            {labels.accentColor}
          </h3>
          <div className="flex flex-wrap gap-3 px-2">
            {accentPalette.map((color) => (
              <button
                key={color.value}
                type="button"
                aria-label={`${labels.accentColor}: ${color.label}`}
                aria-pressed={value.accentColor === color.value}
                onClick={() => onChange({ accentColor: color.value })}
                className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-all duration-300 hover:scale-110 ${
                  value.accentColor === color.value
                    ? "scale-110 ring-2 ring-zinc-400 ring-offset-2 dark:ring-zinc-300"
                    : ""
                }`}
                style={{ backgroundColor: color.value }}
              >
                {value.accentColor === color.value && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  >
                    <CheckCircle
                      size={12}
                      className="text-white drop-shadow-md"
                      fill="white"
                    />
                  </motion.div>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-4">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4 px-2">
            <div>
              <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
                {labels.interfaceScale}
              </h3>
              <p className="text-[10px] font-bold text-zinc-400 opacity-60">
                {labels.scaleDesc}
              </p>
            </div>
            <div className="rounded-2xl bg-accent px-5 py-2.5 text-[12px] font-black text-white shadow-xl shadow-accent">
              {value.fontSize}
              {labels.pixelsShort}
            </div>
          </div>
          <div className="px-4">
            <input
              type="range"
              aria-label={labels.interfaceScale}
              min="10"
              max="24"
              step="1"
              value={value.fontSize}
              onChange={(event) =>
                onChange({ fontSize: Number.parseInt(event.target.value, 10) })
              }
              className="mb-10 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-[var(--accent)] dark:bg-zinc-800"
            />
            <div className="flex flex-col items-center rounded-[28px] border border-black/5 bg-black/5 p-8 text-center dark:border-white/5 dark:bg-white/5">
              <p className="mb-4 text-[10px] font-black uppercase tracking-[0.4em] text-zinc-300 opacity-60">
                {labels.scalePreview}
              </p>
              <p className="max-w-sm font-bold leading-relaxed transition-all duration-300">
                {labels.scalePreviewText}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
