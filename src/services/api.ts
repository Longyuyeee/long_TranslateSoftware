import { invoke } from "@tauri-apps/api/core";
import {
  inspectSpeechAudio,
  resolveEdgeVoice,
} from "./speechQuality";
import { fetchWithTimeout } from "./translationTransport";

export {
  detectSpeechLocale,
  inspectSpeechAudio,
  resolveEdgeVoice,
} from "./speechQuality";
export type { TranslationErrorCode } from "./translationProvider";
export { testTranslationConnection } from "./translationTransport";
export type { ConnectionTestResult } from "./translationTransport";
export {
  startTranslationComparisonTask,
  translateCompare,
  translateStreaming,
} from "./translationComparison";
export type {
  ComparisonSide,
  ComparisonSidePhase,
  ComparisonSideState,
  TranslationComparisonCallbacks,
  TranslationComparisonResult,
  TranslationComparisonTask,
} from "./translationComparison";
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

let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

async function playBuffer(buffer: number[]) {
  const inspection = inspectSpeechAudio(buffer);
  if (inspection.reason === "empty") {
    throw new Error("The speech service returned empty audio");
  }
  if (inspection.reason === "text-response") {
    throw new Error("The speech service returned text instead of audio");
  }
  if (!audioCtx) {
    audioCtx = new (
      window.AudioContext
      || (window as typeof window & { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    )();
  }
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // The previous source has already stopped.
    }
  }

  const arrayBuffer = new Uint8Array(buffer).buffer;
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error(
      `The speech audio could not be decoded (${inspection.format})`,
    );
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
    const ttsEngine = await invoke<string>(
      "get_config_value",
      { key: "tts_engine" },
    ) || "local";
    const speed = await invoke<string>(
      "get_config_value",
      { key: "tts_speed" },
    ) || "1.0";
    const configuredVoice = await invoke<string>(
      "get_config_value",
      { key: "tts_voice" },
    ) || "";
    const speedValue = Math.min(
      2,
      Math.max(0.5, Number.parseFloat(speed) || 1),
    );
    const { locale, voice: edgeVoice } = resolveEdgeVoice(
      text,
      configuredVoice,
    );
    const onlineVoice = configuredVoice.trim() || "alloy";

    let cacheKey = "";
    let url = "";
    if (ttsEngine === "local") {
      url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&${locale === "zh-CN" ? "le=zh" : "type=2"}`;
      cacheKey = url;
    } else if (ttsEngine === "edge") {
      cacheKey = `edge_v2_${locale}_${edgeVoice}_${speedValue}_${text}`;
    } else {
      const rawModel = (
        await invoke<string>(
          "get_config_value",
          { key: "tts_model_name" },
        )
        || await invoke<string>("get_config_value", { key: "tts_model" })
      )?.trim();
      cacheKey = `online_v2_${rawModel}_${onlineVoice}_${speedValue}_${text}`;
    }

    const isCached = await invoke<boolean>("check_audio_cache", { cacheKey });
    if (isCached) {
      const buffer = await invoke<number[]>("proxy_fetch_audio", {
        url: "",
        cacheKey,
      });
      await playBuffer(buffer);
      return true;
    }

    if (ttsEngine === "local") {
      const buffer = await invoke<number[]>("proxy_fetch_audio", {
        url,
        cacheKey,
      });
      await playBuffer(buffer);
    } else if (ttsEngine === "edge") {
      const buffer = await invoke<number[]>("proxy_fetch_audio", {
        url: text,
        cacheKey,
        engine: "edge",
        voice: edgeVoice,
        speed: speedValue.toString(),
      });
      await playBuffer(buffer);
    } else {
      const rawApiKey = await invoke<string>(
        "get_config_value",
        { key: "tts_api_key" },
      ) || await invoke<string>("get_config_value", { key: "openai_api_key" });
      const rawBaseUrl = await invoke<string>(
        "get_config_value",
        { key: "tts_base_url" },
      ) || await invoke<string>("get_config_value", { key: "base_url" })
        || "https://api.openai.com/v1";
      const rawModel = (
        await invoke<string>(
          "get_config_value",
          { key: "tts_model_name" },
        )
        || await invoke<string>("get_config_value", { key: "tts_model" })
      )?.trim();

      const response = await fetchWithTimeout(
        `${rawBaseUrl?.trim().replace(/\/+$/, "")}/audio/speech`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${rawApiKey?.trim()}`,
          },
          body: JSON.stringify({
            model: rawModel,
            input: text,
            voice: onlineVoice,
            speed: speedValue,
          }),
        },
      );
      if (!response.ok) throw new Error(`API Error ${response.status}`);

      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("json")) {
        const json = await response.json();
        const rawUrl = json.output?.audio?.url || json.url || json.audio_url;
        const buffer = await invoke<number[]>("proxy_fetch_audio", {
          url: rawUrl,
          cacheKey,
        });
        await playBuffer(buffer);
      } else {
        const blob = await response.blob();
        const buffer = Array.from(new Uint8Array(await blob.arrayBuffer()));
        invoke("save_audio_cache", {
          cacheKey,
          audioData: buffer,
        }).catch(console.error);
        await playBuffer(buffer);
      }
    }
    return true;
  } catch (error) {
    console.error("[TTS] FAILED:", error);
    window.dispatchEvent(new CustomEvent("tts-error", {
      detail: error instanceof Error
        ? error.message
        : "Speech playback failed",
    }));
    return false;
  }
}
