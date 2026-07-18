import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AlertCircle, Check, RotateCcw, X } from "lucide-react";
import { translations, Lang } from "../i18n";
import { isOcrConfirmShortcut, normalizeOcrText } from "../services/ocr";

type ScreenBounds = { physical_x: number; physical_y: number; factor: number; count: number };

const EMPTY_RECT = { x: 0, y: 0, w: 0, h: 0 };

export default function OcrOverlay() {
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [rect, setRect] = useState(EMPTY_RECT);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [ocrError, setOcrError] = useState<"empty" | "failed" | null>(null);
  const [screenBounds, setScreenBounds] = useState<ScreenBounds>({ physical_x: 0, physical_y: 0, factor: 1, count: 1 });
  const [lang, setLang] = useState<Lang>("zh");
  const captureIdRef = useRef(0);
  const t = useMemo(() => translations[lang] || translations.zh, [lang]);
  const isReviewing = Boolean(ocrText) || ocrError !== null;
  const hasCaptureError = ocrError !== null;

  useEffect(() => {
    invoke<string>("get_config_value", { key: "language" })
      .then(value => { if (value) setLang(value as Lang); })
      .catch(() => {});
    invoke<ScreenBounds>("get_screen_bounds").then(setScreenBounds).catch(console.error);
  }, []);

  const resetCapture = () => {
    captureIdRef.current += 1;
    setIsProcessing(false);
    setIsDrawing(false);
    setRect(EMPTY_RECT);
    setOcrText("");
    setOcrError(null);
  };

  const close = async () => {
    resetCapture();
    try {
      await getCurrentWebviewWindow().hide();
    } catch (error) {
      console.error("Failed to hide OCR overlay", error);
    }
  };

  const confirmOcr = async () => {
    const text = normalizeOcrText(ocrText);
    if (!text || isProcessing) return;
    setIsProcessing(true);
    try {
      await invoke("confirm_ocr_text", { text });
      resetCapture();
    } catch (error) {
      console.error("Failed to confirm OCR text", error);
      setOcrError("failed");
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void close();
      } else if (ocrText && isOcrConfirmShortcut(event.key, event.shiftKey)) {
        event.preventDefault();
        void confirmOcr();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const onMouseDown = (event: React.MouseEvent) => {
    if (isProcessing || isReviewing) return;
    setIsDrawing(true);
    setStartPos({ x: event.clientX, y: event.clientY });
    setRect({ x: event.clientX, y: event.clientY, w: 0, h: 0 });
  };

  const onMouseMove = (event: React.MouseEvent) => {
    if (!isDrawing || isProcessing || isReviewing) return;
    setRect({
      x: Math.min(startPos.x, event.clientX),
      y: Math.min(startPos.y, event.clientY),
      w: Math.abs(event.clientX - startPos.x),
      h: Math.abs(event.clientY - startPos.y),
    });
  };

  const onMouseUp = async () => {
    if (!isDrawing || isProcessing || isReviewing) return;
    setIsDrawing(false);
    if (rect.w < 5 || rect.h < 5) {
      setRect(EMPTY_RECT);
      return;
    }

    setIsProcessing(true);
    setOcrError(null);
    const captureId = ++captureIdRef.current;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const win = getCurrentWebviewWindow();
      const factor = screenBounds.factor || await win.scaleFactor();
      const outerPos = await win.outerPosition();
      const ocrPromise = invoke<string>("capture_and_ocr", {
        x: outerPos.x + Math.round(rect.x * factor),
        y: outerPos.y + Math.round(rect.y * factor),
        w: Math.round(rect.w * factor),
        h: Math.round(rect.h * factor),
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("OCR timeout")), 15000);
      });
      const result = normalizeOcrText(await Promise.race([ocrPromise, timeoutPromise]));
      if (captureIdRef.current !== captureId) return;
      if (result) setOcrText(result);
      else setOcrError("empty");
    } catch (error) {
      if (captureIdRef.current !== captureId) return;
      console.error("OCR operation failed or timed out", error);
      setOcrError("failed");
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (captureIdRef.current === captureId) setIsProcessing(false);
    }
  };

  return (
    <div
      className="h-screen w-screen bg-black/10 cursor-crosshair overflow-hidden relative select-none"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {(rect.w > 0 || isProcessing) && (
        <div
          className="absolute border-2 border-accent bg-accent/10 pointer-events-none ring-1 ring-white/20"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          {isProcessing && !isReviewing && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-[10px] font-black tracking-widest animate-pulse">
              {t.ocrProcessing}
            </div>
          )}
        </div>
      )}

      {!isReviewing && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-black/45 backdrop-blur-2xl text-white px-8 py-3 rounded-2xl text-[11px] font-black tracking-[0.2em] border border-white/20 shadow-2xl pointer-events-none flex items-center gap-3">
          <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          {screenBounds.count > 1 ? t.ocrMultiHint.replace("{count}", String(screenBounds.count)) : t.ocrDragHint}
        </div>
      )}

      {isReviewing && (
        <div className="absolute inset-0 bg-black/45 backdrop-blur-sm flex items-center justify-center p-8 cursor-default" onMouseDown={event => event.stopPropagation()}>
          <section className="w-full max-w-2xl rounded-3xl bg-white dark:bg-[#18181b] border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden">
            <header className="flex items-start justify-between gap-5 px-6 py-5 border-b border-black/5 dark:border-white/10">
              <div>
                <h1 className="text-base font-black text-black dark:text-white">{ocrError === "empty" ? t.ocrEmptyTitle : ocrError === "failed" ? t.ocrFailedTitle : t.ocrConfirmTitle}</h1>
                <p className="mt-1 text-xs text-black/50 dark:text-white/45">{ocrError === "empty" ? t.ocrEmptyDesc : ocrError === "failed" ? t.ocrFailedDesc : t.ocrConfirmHint}</p>
              </div>
              <button type="button" onClick={() => void close()} className="p-2 rounded-xl text-black/45 dark:text-white/45 hover:bg-black/5 dark:hover:bg-white/10" aria-label={t.close}>
                <X size={18} />
              </button>
            </header>

            <div className="p-6">
              {hasCaptureError ? (
                <div className="min-h-40 rounded-2xl bg-amber-500/8 border border-amber-500/20 flex flex-col items-center justify-center text-center px-6">
                  <AlertCircle size={28} className="text-amber-500" />
                  <p className="mt-3 text-sm font-bold text-black/65 dark:text-white/65">{ocrError === "empty" ? t.ocrEmptyDesc : t.ocrFailedDesc}</p>
                </div>
              ) : (
                <label className="block">
                  <span className="block mb-2 text-[11px] font-bold uppercase tracking-wider text-black/40 dark:text-white/40">{t.ocrRecognizedText}</span>
                  <textarea
                    autoFocus
                    value={ocrText}
                    onChange={event => { setOcrText(event.target.value); setOcrError(null); }}
                    className="w-full min-h-48 resize-y rounded-2xl bg-black/[0.035] dark:bg-white/[0.055] border border-black/10 dark:border-white/10 px-4 py-3 text-sm leading-6 text-black dark:text-white outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                  />
                  <span className="block mt-2 text-[11px] text-black/35 dark:text-white/35">{t.ocrShiftEnterHint}</span>
                </label>
              )}
            </div>

            <footer className="flex justify-end gap-3 px-6 py-4 bg-black/[0.025] dark:bg-white/[0.025] border-t border-black/5 dark:border-white/10">
              <button type="button" onClick={resetCapture} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-black/10 dark:border-white/10 text-sm font-bold text-black/65 dark:text-white/65 hover:bg-black/5 dark:hover:bg-white/10">
                <RotateCcw size={15} /> {t.ocrRetryCapture}
              </button>
              {!hasCaptureError && (
                <button type="button" onClick={() => void confirmOcr()} disabled={!normalizeOcrText(ocrText) || isProcessing} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-black shadow-lg shadow-accent/20 disabled:opacity-40 disabled:cursor-not-allowed">
                  <Check size={15} /> {t.ocrConfirmTranslate}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
