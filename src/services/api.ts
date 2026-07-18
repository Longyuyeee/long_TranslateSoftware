import { invoke } from "@tauri-apps/api/core";
import { OpenAiSseParser } from "./sse";

const FETCH_TIMEOUT_MS = 60000; // 60 seconds

export type TranslationPhase =
  | "idle"
  | "loading-config"
  | "checking-cache"
  | "translating-primary"
  | "translating-backup"
  | "success"
  | "error"
  | "cancelled";

export type TranslationErrorCode =
  | "missing-api-key"
  | "unauthorized"
  | "model-not-found"
  | "rate-limited"
  | "timeout"
  | "network"
  | "server"
  | "unknown";

export interface TranslationTaskState {
  requestId: string;
  phase: TranslationPhase;
  model?: string;
  cached?: boolean;
  usedBackup?: boolean;
  error?: { code: TranslationErrorCode; message: string };
}

export interface TranslationTaskResult {
  text: string;
  model: string;
  cached: boolean;
  usedBackup: boolean;
}

export type TranslationTaskCompletion =
  | { status: "success"; result: TranslationTaskResult }
  | { status: "error"; error: { code: TranslationErrorCode; message: string } }
  | { status: "cancelled" };

export interface TranslationTask {
  id: string;
  cancel: () => void;
  done: Promise<TranslationTaskCompletion>;
}

export interface TranslationTaskCallbacks {
  onState?: (state: TranslationTaskState) => void;
  onText?: (text: string, requestId: string) => void;
}

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

class TranslationRequestError extends Error {
  constructor(public readonly code: TranslationErrorCode, message: string) {
    super(message);
    this.name = "TranslationRequestError";
  }
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("Translation request timed out", "TimeoutError")),
    timeoutMs,
  );
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  });
}

interface GlossaryEntry { source_term: string; target_term: string; }

async function doTranslate(
  text: string,
  apiKey: string,
  baseUrl: string,
  modelName: string,
  targetLang: string,
  sourceLang: string,
  customPrompt: string,
  onChunk: (chunk: string) => void,
  glossary?: GlossaryEntry[],
  signal?: AbortSignal,
): Promise<boolean> {
  const sourceHint = sourceLang !== "auto" ? ` from ${sourceLang}` : "";
  const defaultPrompt = `You are a professional translator. Translate the following text${sourceHint} to ${targetLang}. Return only the translated text.`;

  // Build system prompt with glossary injection
  let systemPrompt: string;
  if (customPrompt.trim()) {
    systemPrompt = customPrompt.replace(/\{\{targetLang\}\}/g, targetLang).replace(/\{\{text\}\}/g, text);
  } else {
    systemPrompt = defaultPrompt;
  }

  // Inject glossary terms into the system prompt
  if (glossary && glossary.length > 0) {
    const glossaryBlock = glossary
      .map(g => `- "${g.source_term}" → "${g.target_term}"`)
      .join("\n");
    systemPrompt = `IMPORTANT: Use these exact terminology translations:\n${glossaryBlock}\n\n${systemPrompt}`;
  }

  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      stream: true,
    }),
  }, FETCH_TIMEOUT_MS, signal);

  if (!response.ok) {
    const code: TranslationErrorCode = response.status === 401 || response.status === 403
      ? "unauthorized"
      : response.status === 404
        ? "model-not-found"
        : response.status === 429
          ? "rate-limited"
          : response.status >= 500
            ? "server"
            : "unknown";
    throw new TranslationRequestError(code, `Translation service returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TranslationRequestError("server", "Translation service returned an empty response");
  const parser = new OpenAiSseParser();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const content of parser.push(value)) onChunk(content);
  }
  for (const content of parser.finish()) onChunk(content);
  return true;
}

function normalizeTranslationError(error: unknown): { code: TranslationErrorCode; message: string } {
  if (error instanceof TranslationRequestError) return { code: error.code, message: error.message };
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { code: "timeout", message: "Translation request timed out" };
  }
  if (error instanceof TypeError) return { code: "network", message: "Unable to reach the translation service" };
  if (error instanceof Error) return { code: "unknown", message: error.message };
  return { code: "unknown", message: "Unknown translation error" };
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `translation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: { code: TranslationErrorCode; message: string };
}

/** Performs a minimal non-streaming request against an OpenAI-compatible chat endpoint. */
export async function testTranslationConnection(config: { apiKey: string; baseUrl: string; model: string }): Promise<ConnectionTestResult> {
  const apiKey = config.apiKey.trim();
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const model = config.model.trim();
  if (!apiKey) return { ok: false, error: { code: "missing-api-key", message: "API key is not configured" } };
  if (!baseUrl || !model) return { ok: false, error: { code: "unknown", message: "Base URL and model are required" } };

  const startedAt = performance.now();
  try {
    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 2,
        stream: false,
      }),
    }, 15000);
    if (!response.ok) {
      const code: TranslationErrorCode = response.status === 401 || response.status === 403
        ? "unauthorized"
        : response.status === 404
          ? "model-not-found"
          : response.status === 429
            ? "rate-limited"
            : response.status >= 500 ? "server" : "unknown";
      return { ok: false, error: { code, message: `Translation service returned HTTP ${response.status}` } };
    }
    await response.text();
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return { ok: false, error: normalizeTranslationError(error) };
  }
}

/** Starts one isolated translation request with explicit state, cancellation and failover semantics. */
export function startTranslationTask(text: string, callbacks: TranslationTaskCallbacks = {}): TranslationTask {
  const requestId = createRequestId();
  const controller = new AbortController();
  const emitState = (state: Omit<TranslationTaskState, "requestId">) => callbacks.onState?.({ requestId, ...state });

  const done = (async (): Promise<TranslationTaskCompletion> => {
    let usedBackup = false;
    const completeCancellation = (): TranslationTaskCompletion => {
      emitState({ phase: "cancelled", usedBackup });
      return { status: "cancelled" };
    };
    try {
      invoke("increment_translate_count").catch(console.error);
      emitState({ phase: "loading-config" });

      const config = await invoke<Record<string, string>>("get_config_values", { keys: [
        "trans_api_key", "openai_api_key", "trans_base_url", "base_url", "trans_model_name", "model_name",
        "target_lang", "source_lang", "custom_prompt", "backup_api_key", "backup_base_url", "backup_model",
      ] });
      const primaryKey = (config.trans_api_key || config.openai_api_key || "").trim();
      const primaryUrl = (config.trans_base_url || config.base_url || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
      const primaryModel = (config.trans_model_name || config.model_name || "deepseek-chat").trim();
      const targetLang = config.target_lang || "Chinese";
      const sourceLang = config.source_lang || "auto";
      const customPrompt = config.custom_prompt || "";

      if (controller.signal.aborted) return completeCancellation();
      if (!primaryKey) throw new TranslationRequestError("missing-api-key", "API key is not configured");

      let glossary: GlossaryEntry[] = [];
      try { glossary = await invoke<GlossaryEntry[]>("get_glossary_entries"); } catch { /* optional */ }

      emitState({ phase: "checking-cache", model: primaryModel });
      const cached = await invoke<string | null>("lookup_translation_memory", { text, targetLang });
      if (controller.signal.aborted) return completeCancellation();
      if (cached) {
        callbacks.onText?.(cached, requestId);
        const result = { text: cached, model: primaryModel, cached: true, usedBackup: false };
        emitState({ phase: "success", model: primaryModel, cached: true, usedBackup: false });
        return { status: "success", result };
      }

      let translatedText = "";
      let activeModel = primaryModel;
      callbacks.onText?.("", requestId);
      emitState({ phase: "translating-primary", model: primaryModel, cached: false, usedBackup: false });

      try {
        await doTranslate(text, primaryKey, primaryUrl, primaryModel, targetLang, sourceLang, customPrompt, (chunk) => {
          if (controller.signal.aborted) return;
          translatedText += chunk;
          callbacks.onText?.(translatedText, requestId);
        }, glossary, controller.signal);
      } catch (primaryError) {
        if (controller.signal.aborted) return completeCancellation();

        const backupKey = (config.backup_api_key || "").trim();
        const backupUrl = (config.backup_base_url || "").trim().replace(/\/+$/, "");
        const backupModel = (config.backup_model || "").trim();
        if (!backupKey || !backupUrl || !backupModel) throw primaryError;

        usedBackup = true;
        activeModel = backupModel;
        translatedText = "";
        callbacks.onText?.("", requestId);
        emitState({ phase: "translating-backup", model: backupModel, cached: false, usedBackup: true });
        await doTranslate(text, backupKey, backupUrl, backupModel, targetLang, sourceLang, customPrompt, (chunk) => {
          if (controller.signal.aborted) return;
          translatedText += chunk;
          callbacks.onText?.(translatedText, requestId);
        }, glossary, controller.signal);
      }

      if (controller.signal.aborted) return completeCancellation();
      const result = { text: translatedText.trim(), model: activeModel, cached: false, usedBackup };
      if (!result.text) throw new TranslationRequestError("server", "Translation service returned no text");

      if (text.length < 500) {
        invoke("save_translation_memory", { sourceText: text, translatedText: result.text, targetLang }).catch(() => {});
      }
      emitState({ phase: "success", model: activeModel, cached: false, usedBackup });
      return { status: "success", result };
    } catch (error) {
      if (controller.signal.aborted) {
        return completeCancellation();
      }
      const normalized = normalizeTranslationError(error);
      emitState({ phase: "error", usedBackup, error: normalized });
      return { status: "error", error: normalized };
    }
  })();

  return {
    id: requestId,
    cancel: () => controller.abort(),
    done,
  };
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
      invoke("save_translation_memory", { sourceText: text, translatedText: bestResult, targetLang }).catch(() => {});
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
    const cached = await invoke<string | null>("lookup_translation_memory", { text, targetLang });
    if (cached) {
      onChunk(cached);
      onFinish();
      return;
    }

    let translatedResult = "";

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
      invoke("save_translation_memory", { sourceText: text, translatedText: translatedResult.trim(), targetLang }).catch(() => {});
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
    const cached = await invoke<string | null>("lookup_translation_memory", { text, targetLang });
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
      invoke("save_translation_memory", { sourceText: text, translatedText: bestResult, targetLang }).catch(() => {});
    }
  } finally {
    onFinish();
  }
}

let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

async function playBuffer(buffer: number[]) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (currentSource) { try { currentSource.stop(); } catch(e) {} }

    const arrayBuffer = new Uint8Array(buffer).buffer;
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    
    currentSource = audioCtx.createBufferSource();
    currentSource.buffer = audioBuffer;
    currentSource.connect(audioCtx.destination);
    
    return new Promise((resolve) => {
      currentSource!.onended = resolve;
      currentSource!.start(0);
    });
  } catch (e) {
    console.error("[TTS] AudioContext Playback Failed:", e);
  }
}

export async function speak(text: string) {
  if (!text) return;
  
  try {
    const ttsEngine = (await invoke<string>("get_config_value", { key: "tts_engine" })) || "local";
    const speed = (await invoke<string>("get_config_value", { key: "tts_speed" })) || "1.0";
    const voice = (await invoke<string>("get_config_value", { key: "tts_voice" })) || "zh-CN-XiaoxiaoNeural";
    
    let cacheKey = "";
    let url = "";

    // 1. Determine Engine Strategy
    if (ttsEngine === "local") {
      const isChinese = /[\u4e00-\u9fa5]/.test(text);
      url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&${isChinese ? "le=zh" : "type=2"}`;
      cacheKey = url;
    } else if (ttsEngine === "edge") {
      cacheKey = `edge_${voice}_${text}`;
    } else {
      const rawModel = (await invoke<string>("get_config_value", { key: "tts_model_name" }) || await invoke<string>("get_config_value", { key: "tts_model" }))?.trim();
      cacheKey = `online_${rawModel}_${voice}_${speed}_${text}`;
    }

    // 2. SHORT-CIRCUIT: Check local cache first
    const isCached = await invoke<boolean>("check_audio_cache", { cacheKey });
    if (isCached) {
      const buffer = await invoke<number[]>("proxy_fetch_audio", { url: "", cacheKey: cacheKey });
      await playBuffer(buffer);
      return;
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
        voice
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
        body: JSON.stringify({ model: rawModel, input: text, voice, speed: parseFloat(speed) }),
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
  } catch (error) {
    console.error("[TTS] FAILED:", error);
  }
}
