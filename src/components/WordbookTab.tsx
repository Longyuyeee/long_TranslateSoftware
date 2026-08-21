import { AnimatePresence, motion } from "framer-motion";
import {
  Book,
  Info,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Volume2,
  X as CloseIcon,
} from "lucide-react";
import { contextSourceText, type TranslationCatalog } from "../i18n";
import {
  parseWordAnalysis,
  type WordbookEntry,
  type WordbookSort,
} from "../services/wordbook";
import ThemedSelect from "./ThemedSelect";

interface WordbookTabProps {
  labels: TranslationCatalog;
  words: WordbookEntry[];
  selectedWord: WordbookEntry | null;
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  search: string;
  sort: WordbookSort;
  newWord: string;
  isAdding: boolean;
  onSearchChange: (value: string) => void;
  onSortChange: (value: WordbookSort) => void;
  onSelectWord: (word: WordbookEntry) => void;
  onStartAdding: () => void;
  onNewWordChange: (value: string) => void;
  onAddWord: () => void;
  onCancelAdding: () => void;
  onLoadMore: () => void;
  onDeleteWord: (id: number) => void;
  onRetryAnalysis: () => void;
  onSpeak: (text: string) => void;
  onExport: (format: "csv" | "json") => void;
  onExportAnki: () => void;
}

export default function WordbookTab({
  labels,
  words,
  selectedWord,
  total,
  hasMore,
  isLoading,
  search,
  sort,
  newWord,
  isAdding,
  onSearchChange,
  onSortChange,
  onSelectWord,
  onStartAdding,
  onNewWordChange,
  onAddWord,
  onCancelAdding,
  onLoadMore,
  onDeleteWord,
  onRetryAnalysis,
  onSpeak,
  onExport,
  onExportAnki,
}: WordbookTabProps) {
  const analysis = selectedWord?.analysis
    ? parseWordAnalysis(selectedWord.analysis)
    : null;
  const analysisFailed =
    Boolean(selectedWord?.analysis) &&
    (!analysis || analysis.status === "failed");

  return (
    <div className="wordbook-layout relative flex min-h-full flex-col gap-5 min-[960px]:h-full min-[960px]:min-h-0 min-[960px]:flex-row min-[960px]:gap-6 min-[960px]:overflow-hidden">
      <aside className="wordbook-sidebar flex w-full shrink-0 flex-col gap-3 min-[960px]:h-full min-[960px]:w-[28%] min-[960px]:min-w-[220px] min-[960px]:max-w-[300px] min-[960px]:overflow-hidden min-[960px]:pr-2">
        <div className="wordbook-toolbar shrink-0 space-y-3 rounded-[24px] border border-white/50 bg-white/45 p-3 shadow-sm backdrop-blur-xl dark:border-white/[0.07] dark:bg-white/[0.035]">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-[960px]:grid-cols-1">
          <div className="relative flex-1">
            <input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={labels.searchWords}
              aria-label={labels.searchWords}
              className="w-full rounded-xl border border-black/5 bg-white/60 py-2.5 pr-8 pl-8 text-[10px] font-bold text-zinc-800 outline-none ring-blue-500/10 transition-all placeholder:text-zinc-400 focus:border-accent/50 focus:ring-2 dark:border-white/10 dark:bg-white/10 dark:text-white dark:placeholder:text-zinc-500"
            />
            <Search
              size={12}
              className="absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-400"
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                aria-label={labels.clearSearch}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          <ThemedSelect
            value={sort}
            onChange={onSortChange}
            options={[
              { value: "newest", label: labels.sortNewest },
              { value: "az", label: labels.sortAZ },
              { value: "za", label: labels.sortZA },
            ]}
            ariaLabel={labels.sortWords}
            className="w-full"
            compact
          />
        </div>

        <div className="flex items-center justify-between px-1">
          <span className="rounded-full bg-black/[0.035] px-2.5 py-1 text-[9px] font-black tracking-wider text-zinc-400 uppercase dark:bg-white/[0.055]">
            {words.length} / {total} {labels.wordCount}
          </span>
        </div>

        {words.length > 0 && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onExport("csv")}
              className="flex-1 rounded-xl border border-black/5 bg-white/40 py-2 text-[9px] font-black text-zinc-500 transition-all hover:border-accent/20 hover:text-accent dark:border-white/5 dark:bg-white/5"
            >
              {labels.exportCsv}
            </button>
            <button
              type="button"
              onClick={() => onExport("json")}
              className="flex-1 rounded-xl border border-black/5 bg-white/40 py-2 text-[9px] font-black text-zinc-500 transition-all hover:border-accent/20 hover:text-accent dark:border-white/5 dark:bg-white/5"
            >
              {labels.exportJson}
            </button>
            <button
              type="button"
              onClick={onExportAnki}
              className="flex-1 rounded-xl border border-orange-500/20 bg-orange-50/80 py-2 text-[9px] font-black text-orange-600 transition-all hover:bg-orange-500 hover:text-white dark:bg-orange-500/10"
            >
              {labels.exportAnki}
            </button>
          </div>
        )}

        <div>
          <AnimatePresence mode="wait">
            {!isAdding ? (
              <motion.button
                key="add-btn"
                type="button"
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                onClick={onStartAdding}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-accent/20 bg-accent/10 py-3 text-[10px] font-black text-accent transition-all hover:bg-accent/20"
              >
                <Plus size={14} /> {labels.addWord}
              </motion.button>
            ) : (
              <motion.div
                key="add-input"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="relative"
              >
                <input
                  autoFocus
                  value={newWord}
                  onChange={(event) => onNewWordChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onAddWord();
                  }}
                  placeholder={labels.enterWord}
                  aria-label={labels.enterWord}
                  className="w-full rounded-2xl border border-accent/50 bg-white/80 py-3 pr-10 pl-4 text-[11px] font-bold text-zinc-800 outline-none placeholder:text-zinc-400 dark:bg-white/10 dark:text-white dark:placeholder:text-zinc-500"
                />
                <button
                  type="button"
                  onClick={onCancelAdding}
                  aria-label={labels.cancelAddingWord}
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-zinc-400 hover:text-red-500"
                >
                  <CloseIcon size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        </div>

        <div
          className="wordbook-list custom-scrollbar flex min-h-[108px] gap-3 overflow-x-auto pb-2 min-[960px]:min-h-0 min-[960px]:flex-1 min-[960px]:flex-col min-[960px]:overflow-x-hidden min-[960px]:overflow-y-auto min-[960px]:pb-0 min-[960px]:pr-1"
          data-testid="wordbook-list"
        >
          {words.map((word) => {
            const isSelected = selectedWord?.id === word.id;
            return (
              <motion.div
                layout
                key={word.id}
                className={`group relative w-[190px] shrink-0 overflow-hidden rounded-[22px] border transition-all duration-300 min-[960px]:w-full ${
                  isSelected
                    ? "border-accent bg-accent shadow-2xl"
                    : "glass-card border-transparent hover:border-accent/30 hover:bg-white/80"
                }`}
              >
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectWord(word)}
                  className="w-full p-4 text-left"
                >
                  <h3
                    className={`mb-1.5 truncate pr-8 text-[0.95em] font-black ${
                      isSelected
                        ? "text-white"
                        : "text-zinc-800 dark:text-zinc-100"
                    }`}
                  >
                    {word.word}
                  </h3>
                  <p
                    className={`truncate text-[0.7em] font-bold opacity-80 ${
                      isSelected ? "text-white/70" : "text-zinc-400"
                    }`}
                  >
                    {word.meaning || labels.analyzing}
                  </p>
                </button>
                <button
                  type="button"
                  aria-label={`${labels.readAloud}: ${word.word}`}
                  onClick={() => onSpeak(word.word)}
                  className={`absolute top-3.5 right-3.5 rounded-lg p-1 transition-all ${
                    isSelected
                      ? "text-white/40 hover:bg-white/10 hover:text-white"
                      : "text-zinc-300 hover:bg-accent/10 hover:text-accent"
                  }`}
                >
                  <Volume2 size={13} />
                </button>
                {isSelected && (
                  <motion.span
                    layoutId="selectIndicator"
                    className="absolute top-5 bottom-5 left-0 w-1 rounded-r-full bg-white"
                  />
                )}
              </motion.div>
            );
          })}

          {hasMore && (
            <button
              type="button"
              disabled={isLoading}
              onClick={onLoadMore}
              className="w-[190px] shrink-0 rounded-2xl border border-accent/20 bg-accent/10 px-4 py-3 text-[10px] font-black text-accent transition-all hover:bg-accent/20 disabled:cursor-wait disabled:opacity-50 min-[960px]:w-full"
            >
              {isLoading
                ? labels.loading
                : `${labels.loadMore} (${labels.remaining} ${total - words.length})`}
            </button>
          )}
        </div>
      </aside>

      <section className="glass-card relative flex min-h-[360px] shrink-0 flex-col overflow-hidden rounded-[32px] border-white/40 shadow-2xl min-[960px]:min-h-0 min-[960px]:flex-1">
        <AnimatePresence mode="wait">
          {selectedWord ? (
            !selectedWord.analysis ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-1 flex-col items-center justify-center space-y-6"
              >
                <div className="relative">
                  <div className="h-14 w-14 animate-spin rounded-full border-4 border-accent/10 border-t-accent shadow-inner" />
                  <Sparkles
                    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-accent"
                    size={24}
                  />
                </div>
                <div className="text-center">
                  <p className="mb-2 text-[10px] font-black tracking-[0.5em] text-zinc-400 uppercase">
                    {labels.neuralSync}
                  </p>
                  <p className="animate-pulse text-[10px] font-bold tracking-widest text-zinc-300 uppercase dark:text-zinc-500">
                    {labels.processing}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onDeleteWord(selectedWord.id)}
                  className="rounded-full border border-red-500/20 bg-red-500/10 px-6 py-2 text-[10px] font-black text-red-500 transition-all hover:bg-red-500 hover:text-white"
                >
                  {labels.abortDelete}
                </button>
              </motion.div>
            ) : analysisFailed ? (
              <motion.div
                key="failed"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-1 flex-col items-center justify-center space-y-6 p-10"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-red-500/10 text-red-500 shadow-inner">
                  <Info size={32} />
                </div>
                <div className="max-w-sm text-center">
                  <h3 className="mb-2 text-lg font-black tracking-tight">
                    {labels.analysisFailed}
                  </h3>
                  <p className="text-[11px] font-bold leading-relaxed text-zinc-400">
                    {analysis?.error_msg || labels.analysisFailed}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    onClick={onRetryAnalysis}
                    className="flex items-center gap-2 rounded-2xl bg-accent px-8 py-3 text-[11px] font-black text-white shadow-lg shadow-accent"
                  >
                    <RotateCcw size={14} /> {labels.retryAnalysis}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteWord(selectedWord.id)}
                    className="rounded-2xl border border-black/5 bg-white px-8 py-3 text-[11px] font-black transition-all hover:bg-red-500 hover:text-white dark:border-white/5 dark:bg-white/10"
                  >
                    {labels.delete}
                  </button>
                </div>
              </motion.div>
            ) : analysis ? (
              <motion.div
                key={selectedWord.id}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.5 }}
                className="custom-scrollbar flex-1 space-y-7 overflow-y-auto p-5 sm:p-8"
              >
                <div className="flex items-start justify-between gap-4 border-b border-black/5 pb-6 dark:border-white/5">
                  <div className="flex min-w-0 flex-col gap-3">
                    <h2 className="break-words text-2xl font-black tracking-tighter text-accent sm:text-3xl">
                      {selectedWord.word}
                    </h2>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="max-w-full break-all rounded-full border border-black/5 bg-black/5 px-4 py-1 font-mono text-[0.85em] text-zinc-400 dark:bg-white/5">
                        /{analysis.phonetic}/
                      </span>
                      <button
                        type="button"
                        aria-label={`${labels.readAloud}: ${selectedWord.word}`}
                        onClick={() => onSpeak(selectedWord.word)}
                        className="rounded-full bg-accent/10 p-2 text-accent transition-all hover:bg-accent hover:text-white"
                      >
                        <Volume2 size={14} />
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={labels.delete}
                    onClick={() => onDeleteWord(selectedWord.id)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] border border-red-500/20 bg-red-500/10 text-red-500 shadow-sm transition-all hover:bg-red-500 hover:text-white"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="group relative overflow-hidden rounded-[24px] border border-white/50 bg-white/50 p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-white/5">
                    <div className="absolute top-0 left-0 h-full w-1.5 bg-accent/20" />
                    <h4 className="mb-3 text-[10px] font-black tracking-[0.4em] text-accent uppercase">
                      {labels.meaning}
                    </h4>
                    <p className="font-bold leading-relaxed">
                      {analysis.meaning}
                    </p>
                  </div>
                  {analysis.mnemonic && (
                    <div className="relative overflow-hidden rounded-[24px] border border-amber-500/20 bg-amber-50/80 p-5 sm:p-6 dark:bg-amber-500/5">
                      <div className="absolute top-0 left-0 h-full w-1.5 bg-amber-400/60" />
                      <h4 className="mb-3 text-[10px] font-black tracking-[0.4em] text-amber-500 uppercase">
                        💡 {labels.mnemonic}
                      </h4>
                      <p className="text-[0.85em] leading-relaxed font-medium text-amber-800 dark:text-amber-300">
                        {analysis.mnemonic}
                      </p>
                    </div>
                  )}
                  <div className="rounded-[24px] border border-black/5 bg-black/[0.02] p-5 sm:p-6 dark:border-white/5 dark:bg-white/[0.02]">
                    <h4 className="mb-3 text-[10px] font-black tracking-[0.4em] text-zinc-400 uppercase">
                      {labels.etymology}
                    </h4>
                    <p className="text-[0.85em] leading-relaxed font-medium text-zinc-500 italic dark:text-zinc-400">
                      {analysis.etymology}
                    </p>
                  </div>
                  <div className="rounded-[24px] border border-black/5 bg-black/[0.02] p-5 sm:p-6 dark:border-white/5 dark:bg-white/[0.02]">
                    <h4 className="mb-3 text-[10px] font-black tracking-[0.4em] text-zinc-400 uppercase">
                      {labels.synonyms}
                    </h4>
                    <div className="flex flex-wrap gap-2.5">
                      {analysis.synonyms.map((synonym) => (
                        <span
                          key={synonym}
                          className="rounded-xl border border-accent/10 bg-accent/5 px-3 py-1.5 text-[10px] font-black text-accent transition-all dark:text-blue-400"
                        >
                          {synonym}
                        </span>
                      ))}
                    </div>
                  </div>
                  {selectedWord.contexts.length > 0 && (
                    <div className="space-y-4 pt-2">
                      <h4 className="pl-6 text-[10px] font-black tracking-[0.4em] text-zinc-400 uppercase">
                        {labels.savedContext}
                      </h4>
                      {selectedWord.contexts.map((context) => (
                        <div
                          key={context.id}
                          className="space-y-3 rounded-[24px] border border-accent/10 bg-accent/[0.035] p-6"
                        >
                          <div className="flex items-center justify-between gap-4 text-[9px] font-black tracking-wider text-zinc-400 uppercase">
                            <span>
                              {contextSourceText(labels, context.source_type)}
                            </span>
                            <time>
                              {new Date(context.created_at).toLocaleString()}
                            </time>
                          </div>
                          <div>
                            <span className="text-[9px] font-black text-accent uppercase">
                              {labels.originalContext}
                            </span>
                            <p className="mt-1 text-[12px] leading-relaxed font-semibold">
                              {context.source_text}
                            </p>
                          </div>
                          {context.translated_text && (
                            <div>
                              <span className="text-[9px] font-black text-zinc-400 uppercase">
                                {labels.translatedContext}
                              </span>
                              <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-300">
                                {context.translated_text}
                              </p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-4 pt-4">
                    <h4 className="pl-6 text-[10px] font-black tracking-[0.4em] text-zinc-400 uppercase">
                      {labels.examples}
                    </h4>
                    <div className="space-y-4">
                      {analysis.examples.map((example, index) => (
                        <div
                          key={`${example.en}-${index}`}
                          className="group relative overflow-hidden rounded-[28px] border border-black/5 bg-white/20 p-7 transition-all hover:bg-white/40 dark:border-white/5 dark:bg-white/2 dark:hover:bg-white/5"
                        >
                          <div className="absolute top-0 bottom-0 left-0 w-1 bg-accent/10 transition-all group-hover:bg-accent" />
                          <div className="mb-2 flex items-start justify-between">
                            <p className="text-[0.9em] leading-relaxed font-black text-zinc-800 transition-colors group-hover:text-accent dark:text-zinc-100">
                              {example.en}
                            </p>
                            <button
                              type="button"
                              aria-label={`${labels.readAloud}: ${example.en}`}
                              onClick={() => onSpeak(example.en)}
                              className="p-1.5 text-zinc-300 opacity-0 transition-all group-hover:opacity-100 hover:text-accent focus:opacity-100"
                            >
                              <Volume2 size={12} />
                            </button>
                          </div>
                          <p className="border-l-3 border-accent/20 pl-4 text-[0.8em] font-bold text-zinc-400">
                            {example.zh}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : null
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center text-zinc-200 opacity-20 dark:text-zinc-800">
              <Book size={80} className="mb-4" />
              <p className="text-[10px] font-black tracking-[0.6em] uppercase">
                {labels.noWordSelected}
              </p>
            </div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
