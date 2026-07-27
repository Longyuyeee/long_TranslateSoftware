export type SpeechLocale = "zh-CN" | "en-US" | "ja-JP" | "ko-KR" | "ru-RU" | "ar-SA";

export type SpeechVoiceReason =
  | "configured-voice"
  | "default-voice"
  | "locale-fallback";

export type SpeechAudioFormat =
  | "mp3"
  | "wav"
  | "ogg"
  | "m4a"
  | "webm"
  | "aac"
  | "unknown";

export interface SpeechVoiceRoute {
  locale: SpeechLocale;
  voice: string;
  reason: SpeechVoiceReason;
}

export interface SpeechAudioInspection {
  playable: boolean;
  format: SpeechAudioFormat;
  reason: "recognized-container" | "empty" | "text-response" | "unknown-container";
}

const EDGE_VOICE_BY_LOCALE: Record<SpeechLocale, string> = {
  "zh-CN": "zh-CN-XiaoxiaoNeural",
  "en-US": "en-US-AriaNeural",
  "ja-JP": "ja-JP-NanamiNeural",
  "ko-KR": "ko-KR-SunHiNeural",
  "ru-RU": "ru-RU-SvetlanaNeural",
  "ar-SA": "ar-SA-ZariyahNeural",
};

export function detectSpeechLocale(text: string): SpeechLocale {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja-JP";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko-KR";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh-CN";
  if (/[\u0400-\u04ff]/u.test(text)) return "ru-RU";
  if (/[\u0600-\u06ff]/u.test(text)) return "ar-SA";
  return "en-US";
}

export function resolveEdgeVoice(text: string, configuredVoice: string): SpeechVoiceRoute {
  const locale = detectSpeechLocale(text);
  const normalizedVoice = configuredVoice.trim();
  if (!normalizedVoice) {
    return { locale, voice: EDGE_VOICE_BY_LOCALE[locale], reason: "default-voice" };
  }

  const voiceMatchesLocale = normalizedVoice.toLocaleLowerCase()
    .startsWith(`${locale.toLocaleLowerCase()}-`);
  if (voiceMatchesLocale) {
    return { locale, voice: normalizedVoice, reason: "configured-voice" };
  }
  return { locale, voice: EDGE_VOICE_BY_LOCALE[locale], reason: "locale-fallback" };
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function looksLikeTextError(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.slice(0, 64)).trimStart().toLocaleLowerCase();
  return prefix.startsWith("<!doctype")
    || prefix.startsWith("<html")
    || prefix.startsWith("{")
    || prefix.startsWith("[")
    || prefix.startsWith("error");
}

export function inspectSpeechAudio(buffer: ArrayLike<number>): SpeechAudioInspection {
  const bytes = Uint8Array.from(buffer);
  if (bytes.length === 0) {
    return { playable: false, format: "unknown", reason: "empty" };
  }
  if (looksLikeTextError(bytes)) {
    return { playable: false, format: "unknown", reason: "text-response" };
  }

  let format: SpeechAudioFormat = "unknown";
  if (startsWith(bytes, [0x49, 0x44, 0x33])
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && ![0xf1, 0xf9].includes(bytes[1]))) {
    format = "mp3";
  } else if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)) {
    format = "wav";
  } else if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    format = "ogg";
  } else if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    format = "m4a";
  } else if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    format = "webm";
  } else if (bytes[0] === 0xff && [0xf1, 0xf9].includes(bytes[1])) {
    format = "aac";
  }

  return format === "unknown"
    ? { playable: false, format, reason: "unknown-container" }
    : { playable: true, format, reason: "recognized-container" };
}
