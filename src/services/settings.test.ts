import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  identifyTranslationProvider,
  parseStoredSettings,
  serializeSettings,
} from "./settings";

describe("settings persistence", () => {
  it("loads legacy model keys and resolves installed OCR language variants", () => {
    const parsed = parseStoredSettings({
      openai_api_key: "legacy-key",
      base_url: "https://api.openai.com/v1/",
      model_name: "legacy-model",
      language: "unsupported",
      font_size: "99",
      ocr_lang: "en",
      tts_model: "legacy-tts",
    }, [{
      tag: "en-US",
      display_name: "English (United States)",
      native_name: "English (United States)",
    }]);

    expect(parsed.settings).toMatchObject({
      transApiKey: "legacy-key",
      transBaseUrl: "https://api.openai.com/v1/",
      transModelName: "legacy-model",
      lang: "zh",
      fontSize: 24,
      ocrLang: "en-US",
      ttsApiKey: "legacy-key",
      ttsBaseUrl: "https://api.openai.com/v1/",
      ttsModelName: "legacy-tts",
    });
    expect(parsed.translationProvider).toBe("openai");
  });

  it("uses stable defaults when stored values are missing or malformed", () => {
    const parsed = parseStoredSettings({ font_size: "not-a-number" }, null);
    expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
    expect(parsed.translationProvider).toBe("deepseek");
    expect(parsed.shortcutQ).toBe("Alt+Q");
    expect(parsed.shortcutW).toBe("Alt+W");
  });

  it("serializes booleans and numbers to the existing Tauri config contract", () => {
    expect(serializeSettings({
      ...DEFAULT_SETTINGS,
      autoCopy: true,
      clipboardMonitor: true,
      fontSize: 18,
      webdavEnabled: true,
    })).toMatchObject({
      auto_copy: "true",
      clipboard_monitor: "true",
      font_size: "18",
      webdav_enabled: "true",
    });
    expect(identifyTranslationProvider("https://unknown.example/v1")).toBe("custom");
  });
});
