import type { TranslationCatalog } from "../i18n";
import { SettingsRow } from "./GeneralSettingsControls";
import type { ShortcutSettingsValue } from "./generalSettingsTypes";

interface GeneralSettingsShortcutsSectionProps {
  labels: TranslationCatalog;
  shortcuts: ShortcutSettingsValue;
  onRecordingChange: (recording: "q" | "w" | null) => void;
}

export default function GeneralSettingsShortcutsSection({
  labels,
  shortcuts,
  onRecordingChange,
}: GeneralSettingsShortcutsSectionProps) {
  const items = [
    {
      label: labels.shortcutLabelQ,
      description: labels.shortcutDescQ,
      value: shortcuts.q,
      id: "q" as const,
    },
    {
      label: labels.shortcutLabelW,
      description: labels.shortcutDescW,
      value: shortcuts.w,
      id: "w" as const,
    },
  ];

  return (
    <div className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
      <h3 className="mb-4 text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
        {labels.shortcuts}
      </h3>
      {items.map((item) => (
        <SettingsRow
          key={item.id}
          label={item.label}
          description={item.description}
        >
          <button
            type="button"
            aria-pressed={shortcuts.recording === item.id}
            onClick={() =>
              onRecordingChange(
                shortcuts.recording === item.id ? null : item.id,
              )
            }
            className={`min-w-[130px] rounded-2xl border px-4 py-2.5 text-[11px] font-black transition-all ${
              shortcuts.recording === item.id
                ? "animate-pulse border-accent bg-accent text-white"
                : "border-black/5 bg-white/60 hover:border-accent/50 dark:border-white/10 dark:bg-white/10"
            }`}
          >
            {shortcuts.recording === item.id
              ? labels.shortcutRecording
              : item.value}
          </button>
        </SettingsRow>
      ))}
    </div>
  );
}
