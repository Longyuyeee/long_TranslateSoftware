import { invoke } from "@tauri-apps/api/core";

const FETCH_TIMEOUT_MS = 60000; // 60 seconds

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

async function doTranslate(
  text: string,
  apiKey: string,
  baseUrl: string,
  modelName: string,
  targetLang: string,
  sourceLang: string,
  customPrompt: string,
  onChunk: (chunk: string) => void
): Promise<boolean> {
  const sourceHint = sourceLang !== "auto" ? ` from ${sourceLang}` : "";
  const defaultPrompt = `You are a professional translator. Translate the following text${sourceHint} to ${targetLang}. Return only the translated text.`;
  const systemPrompt = customPrompt.trim()
    ? customPrompt.replace(/\{\{targetLang\}\}/g, targetLang).replace(/\{\{text\}\}/g, text)
    : defaultPrompt;

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
  });

  if (!response.ok) throw new Error(`API ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (trimmed.startsWith("data: ")) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          const content = data.choices[0].delta?.content;
          if (content) onChunk(content);
        } catch (e) { /* skip parse errors */ }
      }
    }
  }
  return true;
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
      });
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
          });
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
