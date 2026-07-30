import { invoke } from "@tauri-apps/api/core";
import {
  inspectSpeechAudio,
  resolveEdgeVoice,
} from "./speechQuality";
import {
  normalizeTranslationError,
  type TranslationErrorCode,
} from "./translationProvider";
import { fetchWithTimeout } from "./translationTransport";
import {
  buildTranslationCacheContext,
  createRequestId,
  doTranslate,
  requireTranslationFormat,
  type GlossaryEntry,
} from "./translationTask";

export {
  detectSpeechLocale,
  inspectSpeechAudio,
  resolveEdgeVoice,
} from "./speechQuality";
export type { TranslationErrorCode } from "./translationProvider";
export { testTranslationConnection } from "./translationTransport";
export type { ConnectionTestResult } from "./translationTransport";
export {
  buildTranslationCacheContext,
  buildTranslationMessages,
  selectRelevantGlossary,
  startTranslationTask,
} from "./translationTask";
export type {
  GlossaryEntry,
  TranslationPhase,
  TranslationTask,
  TranslationTaskCallbacks,
  TranslationTaskCompletion,
  TranslationTaskResult,
  TranslationTaskState,
} from "./translationTask";

export type ComparisonSide = "primary" | "backup";
export type ComparisonSidePhase = "idle" | "translating" | "success" | "error" | "cancelled";

export interface ComparisonSideState {
  requestId: string;
  side: ComparisonSide;
  phase: ComparisonSidePhase;
  model: string;
  durationMs?: number;
  error?: { code: TranslationErrorCode; message: string };
}

export interface TranslationComparisonResult {
  primary?: { text: string; model: string; durationMs: number };
  backup?: { text: string; model: string; durationMs: number };
}

export interface TranslationComparisonTask {
  id: string;
  cancel: () => void;
  done: Promise<{ status: "success"; result: TranslationComparisonResult } | { status: "error" } | { status: "cancelled" }>;
}

export interface TranslationComparisonCallbacks {
  onSideState?: (state: ComparisonSideState) => void;
  onText?: (side: ComparisonSide, text: string, requestId: string) => void;
}

/** Runs primary and backup models independently so status and errors never pollute either result. */
export function startTranslationComparisonTask(text: string, callbacks: TranslationComparisonCallbacks = {}): TranslationComparisonTask {
  const requestId = createRequestId();
  const controller = new AbortController();

  const done = (async () => {
    invoke("increment_translate_count").catch(console.error);
    const config = await invoke<Record<string, string>>("get_config_values", { keys: [
      "trans_api_key", "openai_api_key", "trans_base_url", "base_url", "trans_model_name", "model_name",
      "backup_api_key", "backup_base_url", "backup_model", "target_lang", "source_lang", "custom_prompt",
    ] });
    const primary = {
      key: (config.trans_api_key || config.openai_api_key || "").trim(),
      url: (config.trans_base_url || config.base_url || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
      model: (config.trans_model_name || config.model_name || "deepseek-chat").trim(),
    };
    const backup = {
      key: (config.backup_api_key || "").trim(),
      url: (config.backup_base_url || "").trim().replace(/\/+$/, ""),
      model: (config.backup_model || "").trim(),
    };
    const targetLang = config.target_lang || "Chinese";
    const sourceLang = config.source_lang || "auto";
    const customPrompt = config.custom_prompt || "";
    let glossary: GlossaryEntry[] = [];
    try { glossary = await invoke<GlossaryEntry[]>("get_glossary_entries"); } catch { /* optional */ }

    if (controller.signal.aborted) return { status: "cancelled" } as const;

    const runSide = async (side: ComparisonSide, service: { key: string; url: string; model: string }) => {
      const startedAt = performance.now();
      let translatedText = "";
      const model = service.model || (side === "primary" ? "Primary" : "Backup");
      callbacks.onText?.(side, "", requestId);
      if (!service.key || !service.url || !service.model) {
        const error = { code: "missing-api-key" as const, message: `${model} is not fully configured` };
        callbacks.onSideState?.({ requestId, side, phase: "error", model, error });
        return undefined;
      }

      callbacks.onSideState?.({ requestId, side, phase: "translating", model });
      try {
        await doTranslate(text, service.key, service.url, service.model, targetLang, sourceLang, customPrompt, (chunk) => {
          if (controller.signal.aborted) return;
          translatedText += chunk;
          callbacks.onText?.(side, translatedText, requestId);
        }, glossary, controller.signal);
        requireTranslationFormat(text, translatedText, glossary);
        if (controller.signal.aborted) {
          callbacks.onSideState?.({ requestId, side, phase: "cancelled", model });
          return undefined;
        }
        const durationMs = Math.round(performance.now() - startedAt);
        callbacks.onSideState?.({ requestId, side, phase: "success", model, durationMs });
        return translatedText.trim() ? { text: translatedText.trim(), model, durationMs } : undefined;
      } catch (error) {
        if (controller.signal.aborted) {
          callbacks.onSideState?.({ requestId, side, phase: "cancelled", model });
          return undefined;
        }
        const normalized = normalizeTranslationError(error);
        callbacks.onSideState?.({ requestId, side, phase: "error", model, error: normalized });
        return undefined;
      }
    };

    const [primaryResult, backupResult] = await Promise.all([
      runSide("primary", primary),
      runSide("backup", backup),
    ]);
    if (controller.signal.aborted) return { status: "cancelled" } as const;
    if (!primaryResult && !backupResult) return { status: "error" } as const;

    const bestResult = primaryResult?.text || backupResult?.text;
    if (bestResult && text.length < 500) {
      const selectedService = primaryResult ? primary : backup;
      const cacheContext = buildTranslationCacheContext({
        baseUrl: selectedService.url,
        model: selectedService.model,
        sourceLang,
        targetLang,
        customPrompt,
        glossary,
        text,
      });
      invoke("save_translation_memory", {
        sourceText: text, translatedText: bestResult, targetLang, cacheContext,
      }).catch(() => {});
    }
    return { status: "success", result: { primary: primaryResult, backup: backupResult } } as const;
  })();

  return { id: requestId, cancel: () => controller.abort(), done };
}

export async function translateStreaming(
  text: string,
  onChunk: (chunk: string) => void,
  onFinish: () => void
) {
  try {
    invoke("increment_translate_count").catch(console.error);

    const rawApiKey = await invoke<string>("get_config_value", { key: "trans_api_key" }) || await invoke<string>("get_config_value", { key: "openai_api_key" });
    const rawBaseUrl = (await invoke<string>("get_config_value", { key: "trans_base_url" })) || (await invoke<string>("get_config_value", { key: "base_url" })) || "https://api.openai.com/v1";
    const rawModelName = (await invoke<string>("get_config_value", { key: "trans_model_name" })) || (await invoke<string>("get_config_value", { key: "model_name" })) || "deepseek-chat";
    const targetLang = await invoke<string>("get_config_value", { key: "target_lang" }) || "Chinese";
    const sourceLang = await invoke<string>("get_config_value", { key: "source_lang" }) || "auto";
    const customPrompt = await invoke<string>("get_config_value", { key: "custom_prompt" }) || "";

    // Fetch glossary entries
    let glossary: GlossaryEntry[] = [];
    try {
      glossary = await invoke<GlossaryEntry[]>("get_glossary_entries");
    } catch { /* glossary fetch is optional */ }

    const primaryKey = rawApiKey?.trim();
    const primaryUrl = rawBaseUrl?.trim().replace(/\/+$/, "");
    const primaryModel = rawModelName?.trim();

    if (!primaryKey) {
      onChunk("Error: API Key is missing. Please set it in the Model Config.");
      onFinish();
      return;
    }

    // Check translation memory first
    const primaryCacheContext = buildTranslationCacheContext({
      baseUrl: primaryUrl, model: primaryModel, sourceLang, targetLang, customPrompt, glossary, text,
    });
    const cached = await invoke<string | null>("lookup_translation_memory", {
      text, targetLang, cacheContext: primaryCacheContext,
    });
    if (cached) {
      onChunk(cached);
      onFinish();
      return;
    }

    let translatedResult = "";
    let activeBaseUrl = primaryUrl;
    let activeModel = primaryModel;

    // Try primary model
    try {
      await doTranslate(text, primaryKey, primaryUrl, primaryModel, targetLang, sourceLang, customPrompt, (chunk) => {
        translatedResult += chunk;
        onChunk(chunk);
      }, glossary);
    } catch (primaryError) {
      console.warn("Primary model failed, trying backup...", primaryError);
      // Try backup model
      const backupKey = (await invoke<string>("get_config_value", { key: "backup_api_key" })).trim();
      const backupUrl = (await invoke<string>("get_config_value", { key: "backup_base_url" })).trim().replace(/\/+$/, "");
      const backupModel = (await invoke<string>("get_config_value", { key: "backup_model" })).trim();

      if (backupKey && backupUrl && backupModel) {
        onChunk(`[Fallback to backup model: ${backupModel}]\n`);
        try {
          translatedResult = ""; // reset for backup attempt
          activeBaseUrl = backupUrl;
          activeModel = backupModel;
          await doTranslate(text, backupKey, backupUrl, backupModel, targetLang, sourceLang, customPrompt, (chunk) => {
            translatedResult += chunk;
            onChunk(chunk);
          }, glossary);
        } catch (backupError) {
          onChunk(`\n\n[Error: Both primary and backup models failed]`);
        }
      } else {
        onChunk(`\n\n[Error: ${primaryError instanceof Error ? primaryError.message : "Unknown Error"}]`);
      }
    }

    // Save successful translation to memory cache
    if (translatedResult.trim() && text.length < 500) {
      const cacheContext = buildTranslationCacheContext({
        baseUrl: activeBaseUrl, model: activeModel, sourceLang, targetLang, customPrompt, glossary, text,
      });
      invoke("save_translation_memory", {
        sourceText: text, translatedText: translatedResult.trim(), targetLang, cacheContext,
      }).catch(() => {});
    }
  } finally {
    onFinish();
  }
}

/** Translate with both primary and backup models in parallel for comparison. */
export async function translateCompare(
  text: string,
  onPrimaryChunk: (chunk: string) => void,
  onBackupChunk: (chunk: string) => void,
  onFinish: () => void
) {
  try {
    invoke("increment_translate_count").catch(console.error);

    const getVal = async (key: string) => await invoke<string>("get_config_value", { key }) || "";

    const primaryKey = (await getVal("trans_api_key") || await getVal("openai_api_key")).trim();
    const primaryUrl = (await getVal("trans_base_url") || await getVal("base_url") || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    const primaryModel = (await getVal("trans_model_name") || await getVal("model_name") || "deepseek-chat").trim();

    const backupKey = (await getVal("backup_api_key")).trim();
    const backupUrl = (await getVal("backup_base_url")).trim().replace(/\/+$/, "");
    const backupModel = (await getVal("backup_model")).trim();

    const targetLang = await getVal("target_lang") || "Chinese";
    const sourceLang = await getVal("source_lang") || "auto";
    const customPrompt = await getVal("custom_prompt") || "";

    let glossary: GlossaryEntry[] = [];
    try { glossary = await invoke<GlossaryEntry[]>("get_glossary_entries"); } catch { /* optional */ }

    if (!primaryKey) {
      onPrimaryChunk("Error: Primary API Key is missing.");
      onBackupChunk("Error: Primary API Key is missing.");
      onFinish();
      return;
    }

    // Check translation memory
    const primaryCacheContext = buildTranslationCacheContext({
      baseUrl: primaryUrl, model: primaryModel, sourceLang, targetLang, customPrompt, glossary, text,
    });
    const cached = await invoke<string | null>("lookup_translation_memory", {
      text, targetLang, cacheContext: primaryCacheContext,
    });
    if (cached) {
      onPrimaryChunk(cached);
      onBackupChunk(cached);
      onFinish();
      return;
    }

    let primaryResult = "";
    let backupResult = "";

    const primaryTask = doTranslate(text, primaryKey, primaryUrl, primaryModel, targetLang, sourceLang, customPrompt, (chunk) => {
      primaryResult += chunk;
      onPrimaryChunk(chunk);
    }, glossary).catch(e => {
      onPrimaryChunk(`\n[Error: ${e instanceof Error ? e.message : "Unknown"}]`);
      return false;
    });

    const backupTask = (async () => {
      if (backupKey && backupUrl && backupModel) {
        return doTranslate(text, backupKey, backupUrl, backupModel, targetLang, sourceLang, customPrompt, (chunk) => {
          backupResult += chunk;
          onBackupChunk(chunk);
        }, glossary).catch(e => {
          onBackupChunk(`\n[Error: ${e instanceof Error ? e.message : "Unknown"}]`);
          return false;
        });
      } else {
        onBackupChunk("[Backup model not configured. Set it in Model Config.]");
        return false;
      }
    })();

    await Promise.all([primaryTask, backupTask]);

    // Save to memory cache (use primary result if available, otherwise backup)
    const bestResult = primaryResult.trim() || backupResult.trim();
    if (bestResult && text.length < 500) {
      const usePrimary = Boolean(primaryResult.trim());
      const cacheContext = buildTranslationCacheContext({
        baseUrl: usePrimary ? primaryUrl : backupUrl,
        model: usePrimary ? primaryModel : backupModel,
        sourceLang,
        targetLang,
        customPrompt,
        glossary,
        text,
      });
      invoke("save_translation_memory", {
        sourceText: text, translatedText: bestResult, targetLang, cacheContext,
      }).catch(() => {});
    }
  } finally {
    onFinish();
  }
}

let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

async function playBuffer(buffer: number[]) {
  const inspection = inspectSpeechAudio(buffer);
  if (inspection.reason === "empty") throw new Error("The speech service returned empty audio");
  if (inspection.reason === "text-response") {
    throw new Error("The speech service returned text instead of audio");
  }
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (currentSource) { try { currentSource.stop(); } catch { /* already stopped */ } }

  const arrayBuffer = new Uint8Array(buffer).buffer;
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error(`The speech audio could not be decoded (${inspection.format})`);
  }

  currentSource = audioCtx.createBufferSource();
  currentSource.buffer = audioBuffer;
  currentSource.connect(audioCtx.destination);

  return new Promise<void>((resolve, reject) => {
    currentSource!.onended = () => resolve();
    try {
      currentSource!.start(0);
    } catch (error) {
      reject(error);
    }
  });
}

export async function speak(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  
  try {
    const ttsEngine = (await invoke<string>("get_config_value", { key: "tts_engine" })) || "local";
    const speed = (await invoke<string>("get_config_value", { key: "tts_speed" })) || "1.0";
    const configuredVoice = (await invoke<string>("get_config_value", { key: "tts_voice" })) || "";
    const speedValue = Math.min(2, Math.max(0.5, Number.parseFloat(speed) || 1));
    const { locale, voice: edgeVoice } = resolveEdgeVoice(text, configuredVoice);
    const onlineVoice = configuredVoice.trim() || "alloy";
    
    let cacheKey = "";
    let url = "";

    // 1. Determine Engine Strategy
    if (ttsEngine === "local") {
      url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&${locale === "zh-CN" ? "le=zh" : "type=2"}`;
      cacheKey = url;
    } else if (ttsEngine === "edge") {
      cacheKey = `edge_v2_${locale}_${edgeVoice}_${speedValue}_${text}`;
    } else {
      const rawModel = (await invoke<string>("get_config_value", { key: "tts_model_name" }) || await invoke<string>("get_config_value", { key: "tts_model" }))?.trim();
      cacheKey = `online_v2_${rawModel}_${onlineVoice}_${speedValue}_${text}`;
    }

    // 2. SHORT-CIRCUIT: Check local cache first
    const isCached = await invoke<boolean>("check_audio_cache", { cacheKey });
    if (isCached) {
      const buffer = await invoke<number[]>("proxy_fetch_audio", { url: "", cacheKey: cacheKey });
      await playBuffer(buffer);
      return true;
    }

    // 3. CACHE MISS: Proceed with network request
    if (ttsEngine === "local") {
      const buffer = await invoke<number[]>("proxy_fetch_audio", { url, cacheKey });
      await playBuffer(buffer);
    } else if (ttsEngine === "edge") {
      // Special handling for Edge-TTS: pass text as "url" parameter to backend
      const buffer = await invoke<number[]>("proxy_fetch_audio", { 
        url: text, 
        cacheKey,
        engine: "edge",
        voice: edgeVoice,
        speed: speedValue.toString(),
      });
      await playBuffer(buffer);
    } else {
      const rawApiKey = (await invoke<string>("get_config_value", { key: "tts_api_key" }) || await invoke<string>("get_config_value", { key: "openai_api_key" }));
      const rawBaseUrl = (await invoke<string>("get_config_value", { key: "tts_base_url" }) || await invoke<string>("get_config_value", { key: "base_url" })) || "https://api.openai.com/v1";
      const rawModel = (await invoke<string>("get_config_value", { key: "tts_model_name" }) || await invoke<string>("get_config_value", { key: "tts_model" }))?.trim();

      const response = await fetchWithTimeout(`${rawBaseUrl?.trim().replace(/\/+$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${rawApiKey?.trim()}`,
        },
        body: JSON.stringify({ model: rawModel, input: text, voice: onlineVoice, speed: speedValue }),
      });

      if (!response.ok) throw new Error(`API Error ${response.status}`);

      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("json")) {
        const json = await response.json();
        const rawUrl = json.output?.audio?.url || json.url || json.audio_url;
        const buffer = await invoke<number[]>("proxy_fetch_audio", { url: rawUrl, cacheKey: cacheKey });
        await playBuffer(buffer);
      } else {
        const blob = await response.blob();
        const buffer = Array.from(new Uint8Array(await blob.arrayBuffer()));
        // Cache the binary audio response
        invoke("save_audio_cache", { cacheKey, audioData: buffer }).catch(console.error);
        await playBuffer(buffer);
      }
    }
    return true;
  } catch (error) {
    console.error("[TTS] FAILED:", error);
    window.dispatchEvent(new CustomEvent("tts-error", {
      detail: error instanceof Error ? error.message : "Speech playback failed",
    }));
    return false;
  }
}
