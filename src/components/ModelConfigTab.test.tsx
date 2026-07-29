// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import ModelConfigTab, {
  type TranslationModelConfig,
  type TtsModelConfig,
} from "./ModelConfigTab";

const translation: TranslationModelConfig = {
  providerId: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  modelName: "deepseek-chat",
  customPrompt: "",
  backupApiKey: "",
  backupBaseUrl: "",
  backupModelName: "",
};

const tts: TtsModelConfig = {
  engine: "local",
  apiKey: "",
  baseUrl: "",
  modelName: "tts-1",
  voice: "alloy",
  speed: "1.0",
};

describe("ModelConfigTab", () => {
  const onProviderChange = vi.fn();
  const onTranslationChange = vi.fn();
  const onTtsChange = vi.fn();
  const onTestConnection = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function renderTab(overrides: Partial<React.ComponentProps<typeof ModelConfigTab>> = {}) {
    return render(
      <ModelConfigTab
        labels={translations.en}
        translation={translation}
        tts={tts}
        connectionTest={null}
        isTestingConnection={false}
        onProviderChange={onProviderChange}
        onTranslationChange={onTranslationChange}
        onTtsChange={onTtsChange}
        onTestConnection={onTestConnection}
        {...overrides}
      />,
    );
  }

  it("routes provider selection and connection testing through explicit callbacks", () => {
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
    fireEvent.click(screen.getByRole("button", { name: translations.en.testConnection }));

    expect(onProviderChange).toHaveBeenCalledWith("openai");
    expect(onTestConnection).toHaveBeenCalledOnce();
  });

  it("marks edited base URLs as custom and emits a typed translation patch", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: translations.en.advancedSettings }));
    fireEvent.change(screen.getAllByPlaceholderText(translations.en.baseUrlExample)[0], {
      target: { value: "https://gateway.example/v1" },
    });

    expect(onProviderChange).toHaveBeenCalledWith("custom");
    expect(onTranslationChange).toHaveBeenCalledWith({
      baseUrl: "https://gateway.example/v1",
    });
  });

  it("keeps TTS settings behind the secondary advanced-settings control", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: translations.en.showAdvancedSettings }));
    fireEvent.click(screen.getByRole("button", { name: translations.en.ttsOnline }));

    expect(onTtsChange).toHaveBeenCalledWith({ engine: "online" });
  });

  it("renders structured connection failures through the shared translation mapping", () => {
    renderTab({
      connectionTest: {
        ok: false,
        error: { code: "unauthorized", message: "HTTP 401" },
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      translations.en.translationError_unauthorized,
    );
  });
});
