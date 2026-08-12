import { Chrome, ShieldCheck } from "lucide-react";
import { useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { TranslationCatalog } from "../i18n";
import type { BrowserPairingRequest } from "../services/browserPairing";

interface BrowserPairingDialogProps {
  labels: TranslationCatalog;
  request: BrowserPairingRequest | null;
  isUpdating: boolean;
  onApprove: () => void;
  onReject: () => void;
}

export default function BrowserPairingDialog({
  labels,
  request,
  isUpdating,
  onApprove,
  onReject,
}: BrowserPairingDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap({
    active: request !== null,
    containerRef: dialogRef,
    onEscape: onReject,
    escapeDisabled: isUpdating,
  });

  if (!request) return null;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/45 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="browser-pairing-title"
    >
      <section
        className="w-full max-w-md rounded-[28px] border border-white/60 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-zinc-900 sm:p-8"
      >
        <div className="mb-5 flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Chrome size={24} />
          </div>
          <div>
            <h2 id="browser-pairing-title" className="text-lg font-black">
              {labels.browserPairingRequestTitle}
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              {labels.browserPairingRequestDesc}
            </p>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-black/5 bg-zinc-50 p-4 dark:border-white/5 dark:bg-white/5">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
              {labels.browserPairingExtension}
            </p>
            <p className="mt-1 break-words text-sm font-bold">
              {request.display_name}
            </p>
            <p className="mt-1 break-all text-xs text-zinc-500">
              {request.origin}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
              {labels.browserPairingPermissions}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {request.capabilities.map((capability) => (
                <span
                  key={capability}
                  className="rounded-full bg-accent/10 px-3 py-1 text-[10px] font-black text-accent"
                >
                  {capability}
                </span>
              ))}
            </div>
          </div>
        </div>

        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-500" />
          {labels.browserPairingPrivacy}
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onReject}
            disabled={isUpdating}
            className="rounded-xl border border-black/10 px-5 py-2.5 text-xs font-black transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
          >
            {labels.browserPairingReject}
          </button>
          <button
            type="button"
            data-dialog-initial-focus
            onClick={onApprove}
            disabled={isUpdating}
            className="rounded-xl bg-accent px-5 py-2.5 text-xs font-black text-white shadow-lg shadow-accent/20 disabled:opacity-50"
          >
            {isUpdating
              ? labels.browserPairingUpdating
              : labels.browserPairingApprove}
          </button>
        </div>
      </section>
    </div>
  );
}
