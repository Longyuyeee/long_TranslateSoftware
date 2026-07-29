import { useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import type { TranslationCatalog } from "../i18n";
import type { GlossaryEntry } from "../services/glossary";

interface GlossaryEditorProps {
  labels: TranslationCatalog;
  entries: GlossaryEntry[];
  isLoading: boolean;
  isMutating: boolean;
  hasError: boolean;
  onRetry: () => void;
  onAdd: (sourceTerm: string, targetTerm: string) => Promise<boolean>;
  onUpdate: (id: number, sourceTerm: string, targetTerm: string) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
}

const inputClass =
  "min-w-0 rounded-xl border border-black/5 bg-white/60 px-3 py-2 text-[10px] font-bold text-zinc-800 outline-none transition-all placeholder:text-zinc-400 focus:border-accent/50 focus:ring-2 focus:ring-accent/10 dark:border-white/10 dark:bg-white/10 dark:text-white dark:placeholder:text-zinc-500";

export default function GlossaryEditor({
  labels,
  entries,
  isLoading,
  isMutating,
  hasError,
  onRetry,
  onAdd,
  onUpdate,
  onDelete,
}: GlossaryEditorProps) {
  const [sourceTerm, setSourceTerm] = useState("");
  const [targetTerm, setTargetTerm] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSourceTerm, setEditSourceTerm] = useState("");
  const [editTargetTerm, setEditTargetTerm] = useState("");

  const submitNewEntry = async () => {
    const source = sourceTerm.trim();
    const target = targetTerm.trim();
    if (!source || !target) return;
    if (await onAdd(source, target)) {
      setSourceTerm("");
      setTargetTerm("");
    }
  };

  const submitEdit = async () => {
    const source = editSourceTerm.trim();
    const target = editTargetTerm.trim();
    if (editingId === null || !source || !target) return;
    if (await onUpdate(editingId, source, target)) setEditingId(null);
  };

  const beginEdit = (entry: GlossaryEntry) => {
    setEditingId(entry.id);
    setEditSourceTerm(entry.source_term);
    setEditTargetTerm(entry.target_term);
  };

  return (
    <section className="glass-card shrink-0 space-y-3 rounded-[24px] border-white/50 p-5 shadow-apple">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-[10px] font-black tracking-[0.2em] text-zinc-400 uppercase">
          {labels.glossary} ({entries.length})
        </h2>
        <p className="text-[8px] font-bold text-zinc-400 opacity-60">
          {labels.glossaryDesc}
        </p>
      </div>

      {hasError && (
        <div className="flex items-center justify-between rounded-xl bg-red-500/10 px-3 py-2 text-[10px] font-bold text-red-500" role="alert">
          <span>{labels.somethingWrong}</span>
          <button type="button" onClick={onRetry} className="rounded-lg px-2 py-1 hover:bg-red-500/10">
            {labels.retry}
          </button>
        </div>
      )}

      {isLoading && entries.length === 0 ? (
        <p className="py-3 text-center text-[10px] font-bold text-zinc-400" role="status">
          {labels.loading}
        </p>
      ) : entries.length === 0 ? (
        <p className="py-2 text-center text-[10px] font-bold text-zinc-400">
          {labels.noTerms}
        </p>
      ) : (
        <div className="custom-scrollbar max-h-36 space-y-2 overflow-y-auto pr-1">
          {entries.map((entry) => (
            <div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 text-[10px]">
              {editingId === entry.id ? (
                <>
                  <input
                    value={editSourceTerm}
                    onChange={(event) => setEditSourceTerm(event.target.value)}
                    aria-label={labels.glossaryTerm}
                    className={inputClass}
                  />
                  <span className="text-zinc-400">→</span>
                  <input
                    value={editTargetTerm}
                    onChange={(event) => setEditTargetTerm(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitEdit();
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    aria-label={labels.glossaryTranslation}
                    className={inputClass}
                  />
                  <div className="flex">
                    <button type="button" disabled={isMutating} onClick={() => void submitEdit()} aria-label={labels.save} className="rounded-full p-1.5 text-green-500 hover:bg-green-500/10 disabled:opacity-40">
                      <Check size={14} />
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} aria-label={labels.glossaryCancelEdit} className="rounded-full p-1.5 text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10">
                      <X size={14} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate font-bold text-zinc-700 dark:text-zinc-200">{entry.source_term}</span>
                  <span className="text-zinc-400">→</span>
                  <span className="min-w-0 truncate font-bold text-accent">{entry.target_term}</span>
                  <div className="flex">
                    <button type="button" onClick={() => beginEdit(entry)} aria-label={labels.editTerm} className="rounded-full p-1.5 text-zinc-400 hover:bg-accent/10 hover:text-accent">
                      <Pencil size={12} />
                    </button>
                    <button type="button" disabled={isMutating} onClick={() => void onDelete(entry.id)} aria-label={labels.delete} className="rounded-full p-1.5 text-zinc-400 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-center">
        <input
          value={sourceTerm}
          onChange={(event) => setSourceTerm(event.target.value)}
          aria-label={labels.glossaryTerm}
          placeholder={labels.glossaryTerm}
          className={inputClass}
        />
        <span className="hidden text-[10px] text-zinc-400 sm:block">→</span>
        <input
          value={targetTerm}
          onChange={(event) => setTargetTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitNewEntry();
          }}
          aria-label={labels.glossaryTranslation}
          placeholder={labels.glossaryTranslation}
          className={inputClass}
        />
        <button
          type="button"
          onClick={() => void submitNewEntry()}
          disabled={isMutating || !sourceTerm.trim() || !targetTerm.trim()}
          className="rounded-xl bg-accent px-4 py-2 text-[10px] font-black text-white transition-all hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {labels.addTerm}
        </button>
      </div>
    </section>
  );
}
