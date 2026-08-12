import { Chrome, Unplug } from "lucide-react";
import type { TranslationCatalog } from "../i18n";
import type { BrowserPairingRecord } from "../services/browserPairing";

interface GeneralSettingsBrowserPairingSectionProps {
  labels: TranslationCatalog;
  pairings: BrowserPairingRecord[];
  isUpdating: boolean;
  onRevoke: (pairingId: string) => void;
}

export default function GeneralSettingsBrowserPairingSection({
  labels,
  pairings,
  isUpdating,
  onRevoke,
}: GeneralSettingsBrowserPairingSectionProps) {
  return (
    <section className="glass-card space-y-4 rounded-[28px] border-white/50 p-5 shadow-apple sm:p-8">
      <div>
        <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400">
          {labels.browserPairingTitle}
        </h3>
        <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          {labels.browserPairingDesc}
        </p>
      </div>
      {pairings.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-black/10 p-4 text-xs text-zinc-400 dark:border-white/10">
          {labels.browserPairingEmpty}
        </p>
      ) : (
        <div className="space-y-3">
          {pairings.map((pairing) => (
            <div
              key={pairing.pairing_id}
              className="flex items-center gap-3 rounded-2xl border border-black/5 bg-white/50 p-4 dark:border-white/5 dark:bg-white/5"
            >
              <Chrome size={18} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-black">
                  {pairing.display_name}
                </p>
                <p className="mt-1 truncate text-[10px] text-zinc-400">
                  {pairing.origin}
                </p>
              </div>
              <button
                type="button"
                aria-label={`${labels.browserPairingRevoke}: ${pairing.display_name}`}
                onClick={() => onRevoke(pairing.pairing_id)}
                disabled={isUpdating}
                className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[10px] font-black text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
              >
                <Unplug size={13} />
                {labels.browserPairingRevoke}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
