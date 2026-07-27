import { Lang } from "../i18n";
import { OcrLanguageInfo, resolveOcrLanguageTag } from "./ocr";
import { parseStoredSyncSummary, WebDavSyncSummary } from "./webdav";

export const TRANSLATION_PROVIDERS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "custom", label: "Custom", baseUrl: "", model: "" },
] as const;

export type TranslationProviderId = typeof TRANSLATION_PROVIDERS[number]["id"];

export interface SettingsSnapshot {
  transApiKey: string;
  transBaseUrl: string;
  transModelName: string;
  customPrompt: string;
  backupApiKey: string;
  backupBaseUrl: string;
  backupModelName: string;
  lang: Lang;
  targetLang: string;
  sourceLang: string;
  autoCopy: boolean;
  clipboardMonitor: boolean;
  accentColor: string;
  theme: string;
  fontSize: number;
  ttsEngine: string;
  ttsApiKey: string;
  ttsBaseUrl: string;
  ttsModelName: string;
  ttsVoice: string;
  ttsSpeed: string;
  ocrLang: string;
  webdavEnabled: boolean;
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
}

export interface ParsedSettings {
  settings: SettingsSnapshot;
  translationProvider: TranslationProviderId;
  shortcutQ: string;
  shortcutW: string;
  lastSyncTime: string;
  lastSyncSummary: WebDavSyncSummary | null;
}

export const SETTINGS_KEYS = [
  "trans_api_key", "openai_api_key", "trans_base_url", "base_url", "trans_model_name", "model_name",
  "custom_prompt", "backup_api_key", "backup_base_url", "backup_model", "ocr_lang", "shortcut_q", "shortcut_w",
  "language", "target_lang", "source_lang", "auto_copy", "clipboard_monitor", "accent_color", "theme", "font_size",
  "tts_engine", "tts_api_key", "tts_base_url", "tts_model_name", "tts_model", "tts_voice", "tts_speed",
  "webdav_enabled", "webdav_url", "webdav_user", "webdav_pass", "last_sync_time", "last_sync_result",
] as const;

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  transApiKey: "",
  transBaseUrl: "https://api.deepseek.com/v1",
  transModelName: "deepseek-chat",
  customPrompt: "",
  backupApiKey: "",
  backupBaseUrl: "",
  backupModelName: "",
  lang: "zh",
  targetLang: "Chinese",
  sourceLang: "auto",
  autoCopy: false,
  clipboardMonitor: false,
  accentColor: "#007aff",
  theme: "system",
  fontSize: 14,
  ttsEngine: "local",
  ttsApiKey: "",
  ttsBaseUrl: "",
  ttsModelName: "tts-1",
  ttsVoice: "alloy",
  ttsSpeed: "1.0",
  ocrLang: "auto",
  webdavEnabled: false,
  webdavUrl: "",
  webdavUser: "",
  webdavPass: "",
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseFontSize(value: string): number {
  const parsed = Number.parseInt(value || String(DEFAULT_SETTINGS.fontSize), 10);
  return Number.isFinite(parsed) ? Math.min(24, Math.max(10, parsed)) : DEFAULT_SETTINGS.fontSize;
}

export function identifyTranslationProvider(baseUrl: string): TranslationProviderId {
  const normalized = normalizeBaseUrl(baseUrl);
  return TRANSLATION_PROVIDERS.find(
    (provider) => provider.baseUrl && normalizeBaseUrl(provider.baseUrl) === normalized,
  )?.id ?? "custom";
}

export function parseStoredSettings(
  values: Record<string, string>,
  detectedOcrLanguages: OcrLanguageInfo[] | null,
): ParsedSettings {
  const get = (key: string) => values[key] || "";
  const transBaseUrl = get("trans_base_url") || get("base_url") || DEFAULT_SETTINGS.transBaseUrl;
  const savedLanguage = get("language");
  const lang: Lang = savedLanguage === "en" || savedLanguage === "zh"
    ? savedLanguage
    : DEFAULT_SETTINGS.lang;
  const savedOcrLanguage = get("ocr_lang") || DEFAULT_SETTINGS.ocrLang;

  return {
    settings: {
      transApiKey: get("trans_api_key") || get("openai_api_key"),
      transBaseUrl,
      transModelName: get("trans_model_name") || get("model_name") || DEFAULT_SETTINGS.transModelName,
      customPrompt: get("custom_prompt"),
      backupApiKey: get("backup_api_key"),
      backupBaseUrl: get("backup_base_url"),
      backupModelName: get("backup_model"),
      lang,
      targetLang: get("target_lang") || DEFAULT_SETTINGS.targetLang,
      sourceLang: get("source_lang") || DEFAULT_SETTINGS.sourceLang,
      autoCopy: get("auto_copy") === "true",
      clipboardMonitor: get("clipboard_monitor") === "true",
      accentColor: get("accent_color") || DEFAULT_SETTINGS.accentColor,
      theme: get("theme") || DEFAULT_SETTINGS.theme,
      fontSize: parseFontSize(get("font_size")),
      ttsEngine: get("tts_engine") || DEFAULT_SETTINGS.ttsEngine,
      ttsApiKey: get("tts_api_key") || get("openai_api_key"),
      ttsBaseUrl: get("tts_base_url") || get("base_url"),
      ttsModelName: get("tts_model_name") || get("tts_model") || DEFAULT_SETTINGS.ttsModelName,
      ttsVoice: get("tts_voice") || DEFAULT_SETTINGS.ttsVoice,
      ttsSpeed: get("tts_speed") || DEFAULT_SETTINGS.ttsSpeed,
      ocrLang: detectedOcrLanguages?.length
        ? resolveOcrLanguageTag(savedOcrLanguage, detectedOcrLanguages)
        : savedOcrLanguage,
      webdavEnabled: get("webdav_enabled") === "true",
      webdavUrl: get("webdav_url"),
      webdavUser: get("webdav_user"),
      webdavPass: get("webdav_pass"),
    },
    translationProvider: identifyTranslationProvider(transBaseUrl),
    shortcutQ: get("shortcut_q") || "Alt+Q",
    shortcutW: get("shortcut_w") || "Alt+W",
    lastSyncTime: get("last_sync_time"),
    lastSyncSummary: parseStoredSyncSummary(get("last_sync_result")),
  };
}

export function serializeSettings(settings: SettingsSnapshot): Record<string, string> {
  return {
    trans_api_key: settings.transApiKey,
    trans_base_url: settings.transBaseUrl,
    trans_model_name: settings.transModelName,
    language: settings.lang,
    target_lang: settings.targetLang,
    source_lang: settings.sourceLang,
    auto_copy: settings.autoCopy ? "true" : "false",
    clipboard_monitor: settings.clipboardMonitor ? "true" : "false",
    accent_color: settings.accentColor,
    theme: settings.theme,
    font_size: String(settings.fontSize),
    tts_engine: settings.ttsEngine,
    tts_api_key: settings.ttsApiKey,
    tts_base_url: settings.ttsBaseUrl,
    tts_model_name: settings.ttsModelName,
    tts_voice: settings.ttsVoice,
    tts_speed: settings.ttsSpeed,
    custom_prompt: settings.customPrompt,
    backup_api_key: settings.backupApiKey,
    backup_base_url: settings.backupBaseUrl,
    backup_model: settings.backupModelName,
    ocr_lang: settings.ocrLang,
    webdav_enabled: settings.webdavEnabled ? "true" : "false",
    webdav_url: settings.webdavUrl,
    webdav_user: settings.webdavUser,
    webdav_pass: settings.webdavPass,
  };
}

export function settingsFingerprint(settings: SettingsSnapshot): string {
  return JSON.stringify(serializeSettings(settings));
}
