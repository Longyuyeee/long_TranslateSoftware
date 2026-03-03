import { invoke } from "@tauri-apps/api/core";

export async function translateStreaming(
  text: string,
  onChunk: (chunk: string) => void,
  onFinish: () => void
) {
  try {
    // Increment translate stats
    invoke("increment_translate_count").catch(console.error);

    const rawApiKey = await invoke<string>("get_config_value", { key: "trans_api_key" }) || await invoke<string>("get_config_value", { key: "openai_api_key" });
    const rawBaseUrl = (await invoke<string>("get_config_value", { key: "trans_base_url" })) || (await invoke<string>("get_config_value", { key: "base_url" })) || "https://api.openai.com/v1";
    const rawModelName = (await invoke<string>("get_config_value", { key: "trans_model_name" })) || (await invoke<string>("get_config_value", { key: "model_name" })) || "deepseek-chat";
    
    const apiKey = rawApiKey?.trim();
    const baseUrl = rawBaseUrl?.trim().replace(/\/+$/, "");
    const modelName = rawModelName?.trim();

    if (!apiKey) {
      onChunk("Error: API Key is missing. Please set it in the Model Config.");
      onFinish();
      return;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: "You are a professional translator. Translate the following text to Chinese. Return only the translated text." },
          { role: "user", content: text },
        ],
        stream: true,
      }),
    });

    if (!response.ok) throw new Error(`API Request Failed: ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) return;
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
          } catch (e) {
            console.error("Error parsing stream chunk", e);
          }
        }
      }
    }
  } catch (error) {
    console.error("Translation error:", error);
    onChunk(`\n\n[Error: ${error instanceof Error ? error.message : "Unknown Error"}]`);
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

      const response = await fetch(`${rawBaseUrl?.trim().replace(/\/+$/, "")}/audio/speech`, {
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
        await playBuffer(buffer);
      }
    }
  } catch (error) {
    console.error("[TTS] FAILED:", error);
  }
}
