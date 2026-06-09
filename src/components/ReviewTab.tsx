import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { Brain, Volume2, RotateCcw, CheckCircle, ChevronRight } from "lucide-react";
import { translations, Lang } from "../i18n";
import { speak } from "../services/api";

interface ReviewWord {
  id: number;
  word: string;
  phonetic: string;
  meaning: string;
  analysis: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review: string | null;
}

interface ReviewStats {
  total: number;
  reviewed: number;
  mastered: number;
  due_today: number;
  streak: number;
}

export default function ReviewTab({ lang, onRefreshStats }: { lang: Lang; onRefreshStats: () => void }) {
  const t = useMemo(() => translations[lang] || translations.zh, [lang]);
  const [mode, setMode] = useState<"flashcard" | "quiz">("flashcard");
  const [dueWords, setDueWords] = useState<ReviewWord[]>([]);
  const [stats, setStats] = useState<ReviewStats>({ total: 0, reviewed: 0, mastered: 0, due_today: 0, streak: 0 });
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  // Quiz state
  const [quizQuestion, setQuizQuestion] = useState(0);
  const [quizOptions, setQuizOptions] = useState<string[]>([]);
  const [quizCorrectAnswer, setQuizCorrectAnswer] = useState("");
  const [quizScore, setQuizScore] = useState({ correct: 0, total: 0 });
  const [quizAnswered, setQuizAnswered] = useState(false);
  const [quizFinished, setQuizFinished] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [words, s] = await Promise.all([
        invoke<ReviewWord[]>("get_due_reviews", { limit: 50 }),
        invoke<ReviewStats>("get_review_stats"),
      ]);
      setDueWords(words);
      setStats(s);
      setCurrentIdx(0);
      setIsFlipped(false);
    } catch (e) { console.error(e); }
  };

  const handleReview = async (quality: number) => {
    const word = dueWords[currentIdx];
    if (!word) return;
    try {
      await invoke("submit_review", { wordId: word.id, quality });
      setIsFlipped(false);
      if (currentIdx < dueWords.length - 1) {
        setCurrentIdx(i => i + 1);
      } else {
        await loadData();
        onRefreshStats();
      }
    } catch (e) { console.error(e); }
  };

  const currentWord = dueWords[currentIdx];
  const examples: { en: string; zh: string }[] = useMemo(() => {
    if (!currentWord?.analysis) return [];
    try { return JSON.parse(currentWord.analysis).examples || []; }
    catch { return []; }
  }, [currentWord?.analysis]);

  // Quiz mode helpers
  const startQuiz = () => {
    if (dueWords.length < 4) return;
    const shuffled = [...dueWords].sort(() => Math.random() - 0.5);
    const qWords = shuffled.slice(0, Math.min(10, shuffled.length));
    setQuizScore({ correct: 0, total: qWords.length });
    nextQuizQuestion(qWords, 0);
  };

  const nextQuizQuestion = (words: ReviewWord[], idx: number) => {
    if (idx >= words.length) { setQuizFinished(true); return; }
    const correct = words[idx];
    // Pick 3 random wrong answers
    const others = words.filter(w => w.id !== correct.id).sort(() => Math.random() - 0.5);
    const options = [correct.meaning, ...others.slice(0, 3).map(w => w.meaning)].sort(() => Math.random() - 0.5);
    setQuizQuestion(idx);
    setQuizOptions(options);
    setQuizCorrectAnswer(correct.meaning);
    setQuizAnswered(false);
  };

  const handleQuizAnswer = (answer: string) => {
    if (quizAnswered) return;
    setQuizAnswered(true);
    if (answer === quizCorrectAnswer) {
      setQuizScore(s => ({ ...s, correct: s.correct + 1 }));
    }
  };

  const handleQuizNext = () => {
    const shuffled = [...dueWords].sort(() => Math.random() - 0.5);
    const qWords = shuffled.slice(0, Math.min(10, shuffled.length));
    nextQuizQuestion(qWords, quizQuestion + 1);
  };

  // Stats bar
  const StatsBar = () => (
    <div className="flex gap-4 mb-6">
      {[
        { label: t.dueToday, value: stats.due_today, color: "text-blue-500" },
        { label: t.reviewed, value: stats.reviewed, color: "text-green-500" },
        { label: t.mastered, value: stats.mastered, color: "text-amber-500" },
        { label: t.streak, value: `${stats.streak}d`, color: "text-purple-500" },
      ].map(s => (
        <div key={s.label} className="flex-1 glass-card rounded-xl p-4 border border-black/5 dark:border-white/5 text-center">
          <div className={`text-2xl font-black ${s.color}`}>{s.value}</div>
          <div className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider mt-1">{s.label}</div>
        </div>
      ))}
    </div>
  );

  // --- FLASHCARD MODE ---
  if (mode === "flashcard") {
    return (
      <div className="flex flex-col h-full gap-4">
        <div className="flex items-center justify-between shrink-0">
          <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-full border border-black/5">
            <button onClick={() => setMode("flashcard")} className="px-4 py-1.5 rounded-full text-[10px] font-black bg-white dark:bg-zinc-800 shadow-md text-blue-600">{t.flashcardMode}</button>
            <button onClick={() => setMode("quiz")} className="px-4 py-1.5 rounded-full text-[10px] font-black text-zinc-400">{t.quizMode}</button>
          </div>
          {currentWord && <span className="text-[10px] font-bold text-zinc-400">{currentIdx + 1} / {dueWords.length}</span>}
        </div>

        <StatsBar />

        {!currentWord ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-zinc-300 dark:text-zinc-700">
            <Brain size={64} className="opacity-30" />
            <p className="font-black text-sm opacity-40">{t.allCaughtUp}</p>
            <button onClick={loadData} className="px-6 py-2 bg-blue-600/10 text-blue-600 rounded-full text-[10px] font-black hover:bg-blue-600/20 transition-all">
              <RotateCcw size={12} className="inline mr-1" />Refresh
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-6">
            {/* Flashcard */}
            <div
              className="w-full max-w-md aspect-[3/2] cursor-pointer perspective-1000"
              onClick={() => setIsFlipped(!isFlipped)}
            >
              <motion.div
                animate={{ rotateY: isFlipped ? 180 : 0 }}
                transition={{ duration: 0.4, ease: "easeInOut" }}
                className="w-full h-full relative preserve-3d"
              >
                {/* Front */}
                <div className={`absolute inset-0 glass-card rounded-3xl border border-black/5 dark:border-white/10 flex flex-col items-center justify-center gap-4 p-8 backface-hidden ${isFlipped ? 'pointer-events-none' : ''}`}>
                  <button onClick={(e) => { e.stopPropagation(); speak(currentWord.word); }} className="p-2 hover:bg-black/5 dark:hover:bg-white/10 rounded-full text-zinc-400 transition-colors">
                    <Volume2 size={20} />
                  </button>
                  <h2 className="text-3xl font-black text-zinc-800 dark:text-zinc-100 tracking-tight">{currentWord.word}</h2>
                  {currentWord.phonetic && <p className="text-sm text-zinc-400 font-medium">{currentWord.phonetic}</p>}
                  <p className="text-[10px] text-zinc-300 font-bold uppercase tracking-[0.3em] mt-2">{t.flipHint}</p>
                </div>
                {/* Back */}
                <div className={`absolute inset-0 glass-card rounded-3xl border border-blue-500/20 bg-blue-50/80 dark:bg-blue-900/20 flex flex-col items-center justify-center gap-3 p-8 backface-hidden rotate-y-180 ${!isFlipped ? 'pointer-events-none' : ''}`}>
                  <h3 className="text-xl font-black text-blue-600 dark:text-blue-400">{currentWord.meaning || "?"}</h3>
                  {examples.length > 0 && (
                    <div className="text-center">
                      <p className="text-[11px] text-zinc-500 italic">"{examples[0].en}"</p>
                      <p className="text-[10px] text-zinc-400 font-bold mt-1">{examples[0].zh}</p>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>

            {/* Rating buttons (visible after flip) */}
            <AnimatePresence>
              {isFlipped && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex gap-3">
                  {[
                    { label: t.again, quality: 0, color: "bg-red-500/10 text-red-600 border-red-500/20 hover:bg-red-500 hover:text-white" },
                    { label: t.hard, quality: 2, color: "bg-orange-500/10 text-orange-600 border-orange-500/20 hover:bg-orange-500 hover:text-white" },
                    { label: t.good, quality: 4, color: "bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500 hover:text-white" },
                    { label: t.easy, quality: 5, color: "bg-blue-500/10 text-blue-600 border-blue-500/20 hover:bg-blue-500 hover:text-white" },
                  ].map(b => (
                    <button key={b.label} onClick={() => handleReview(b.quality)} className={`px-5 py-2.5 rounded-full border font-black text-[11px] transition-all ${b.color}`}>
                      {b.label}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    );
  }

  // --- QUIZ MODE ---
  if (!quizFinished && dueWords.length >= 4 && quizScore.total > 0) {
    const qWord = dueWords.find(w => w.meaning === quizCorrectAnswer);
    return (
      <div className="flex flex-col h-full gap-4">
        <div className="flex items-center justify-between shrink-0">
          <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-full border border-black/5">
            <button onClick={() => setMode("flashcard")} className="px-4 py-1.5 rounded-full text-[10px] font-black text-zinc-400">{t.flashcardMode}</button>
            <button onClick={() => setMode("quiz")} className="px-4 py-1.5 rounded-full text-[10px] font-black bg-white dark:bg-zinc-800 shadow-md text-blue-600">{t.quizMode}</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-green-500">{t.correct}: {quizScore.correct}</span>
            <span className="text-[10px] font-bold text-zinc-400">{quizQuestion + 1} / {quizScore.total}</span>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="glass-card rounded-3xl border border-black/5 dark:border-white/10 p-10 w-full max-w-md text-center">
            <p className="text-[11px] font-black text-zinc-400 uppercase tracking-widest mb-4">{t.score}</p>
            <h2 className="text-2xl font-black text-zinc-800 dark:text-zinc-100 mb-2">{qWord?.word || "?"}</h2>
            {qWord?.phonetic && <p className="text-sm text-zinc-400 mb-6">{qWord.phonetic}</p>}
            <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-[0.2em]">Choose the correct meaning</p>
          </div>

          <div className="grid grid-cols-2 gap-3 w-full max-w-md">
            {quizOptions.map(opt => {
              let btnClass = "p-4 rounded-2xl border font-bold text-[12px] transition-all ";
              if (quizAnswered) {
                if (opt === quizCorrectAnswer) btnClass += "bg-green-500/20 border-green-500 text-green-600";
                else btnClass += "bg-black/5 dark:bg-white/5 border-transparent text-zinc-300";
              } else {
                btnClass += "glass-card border-black/5 dark:border-white/5 hover:border-blue-500/30 hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer text-zinc-700 dark:text-zinc-200";
              }
              return (
                <button key={opt} onClick={() => handleQuizAnswer(opt)} className={btnClass} disabled={quizAnswered}>
                  {quizAnswered && opt === quizCorrectAnswer && <CheckCircle size={14} className="inline mr-1 text-green-500" />}
                  {opt}
                </button>
              );
            })}
          </div>

          {quizAnswered && (
            <motion.button initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={handleQuizNext} className="px-6 py-2.5 bg-blue-600 text-white rounded-full font-black text-[11px] flex items-center gap-2 hover:bg-blue-700 transition-all">
              {quizQuestion + 1 < quizScore.total ? <>Next <ChevronRight size={14} /></> : "Finish"}
            </motion.button>
          )}
        </div>
      </div>
    );
  }

  // Quiz start or finished state
  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-full border border-black/5">
          <button onClick={() => setMode("flashcard")} className="px-4 py-1.5 rounded-full text-[10px] font-black text-zinc-400">{t.flashcardMode}</button>
          <button onClick={() => setMode("quiz")} className="px-4 py-1.5 rounded-full text-[10px] font-black bg-white dark:bg-zinc-800 shadow-md text-blue-600">{t.quizMode}</button>
        </div>
      </div>

      <StatsBar />

      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        {quizFinished ? (
          <>
            <div className={`text-6xl font-black ${quizScore.correct >= quizScore.total * 0.7 ? 'text-green-500' : 'text-amber-500'}`}>
              {quizScore.correct}/{quizScore.total}
            </div>
            <p className="text-sm font-bold text-zinc-500">{Math.round(quizScore.correct / quizScore.total * 100)}% {t.correct}</p>
            <button onClick={() => { setQuizFinished(false); startQuiz(); }} className="px-6 py-2.5 bg-blue-600 text-white rounded-full font-black text-[11px] flex items-center gap-2 hover:bg-blue-700 transition-all">
              <RotateCcw size={14} /> {t.playAgain}
            </button>
          </>
        ) : dueWords.length < 4 ? (
          <>
            <Brain size={64} className="opacity-30 text-zinc-300" />
            <p className="font-bold text-sm text-zinc-400">Need at least 4 words for quiz mode</p>
            <button onClick={loadData} className="px-4 py-2 bg-blue-600/10 text-blue-600 rounded-full text-[10px] font-black">Refresh</button>
          </>
        ) : (
          <>
            <Brain size={64} className="opacity-30 text-zinc-300" />
            <p className="font-bold text-sm text-zinc-400">Test your vocabulary</p>
            <button onClick={startQuiz} className="px-8 py-3 bg-blue-600 text-white rounded-full font-black text-[12px] hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20">
              Start Quiz
            </button>
          </>
        )}
      </div>
    </div>
  );
}
