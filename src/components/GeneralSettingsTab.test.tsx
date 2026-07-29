// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import GeneralSettingsTab, {
  type GeneralSettingsValue,
  type ShortcutSettingsValue,
  type WebDavSettingsValue,
} from "./GeneralSettingsTab";

const value: GeneralSettingsValue = {
  lang: "en",
  autoLaunch: false,
  sourceLang: "auto",
  targetLang: "Chinese",
  ocrLang: "auto",
  autoCopy: false,
  clipboardMonitor: false,
};

const shortcuts: ShortcutSettingsValue = {
  q: "Alt+Q",
  w: "Alt+W",
  recording: null,
};

const webdav: WebDavSettingsValue = {
  enabled: true,
  url: "https://dav.example/",
  user: "reader",
  password: "",
  lastSyncTime: "",
  lastSyncSummary: null,
};

describe("GeneralSettingsTab", () => {
  const onChange = vi.fn();
  const onToggleAutoLaunch = vi.fn();
  const onRecordingChange = vi.fn();
  const onWebDavChange = vi.fn();
  const onTestWebdav = vi.fn();
  const onSync = vi.fn();
  const onClearCache = vi.fn();
  const onExport = vi.fn();
  const onImport = vi.fn();
  const onExportDiagnostics = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function renderTab(
    overrides: Partial<React.ComponentProps<typeof GeneralSettingsTab>> = {},
  ) {
    return render(
      <GeneralSettingsTab
        labels={translations.en}
        value={value}
        interfaceLanguageOptions={[
          { value: "zh", label: translations.en.simplifiedChinese },
          { value: "en", label: translations.en.english },
        ]}
        languageOptions={[
          { value: "Chinese", label: translations.en.languageNames.Chinese },
          { value: "English", label: translations.en.languageNames.English },
        ]}
        ocrLanguageOptions={[
          { value: "auto", label: translations.en.autoDetect },
          { value: "en", label: translations.en.languageNames.English },
        ]}
        shortcuts={shortcuts}
        webdav={webdav}
        webdavConnection={null}
        isTestingWebdav={false}
        isSyncing={false}
        cacheSize="0 B"
        isExportingDiagnostics={false}
        onChange={onChange}
        onToggleAutoLaunch={onToggleAutoLaunch}
        onRecordingChange={onRecordingChange}
        onWebDavChange={onWebDavChange}
        onTestWebdav={onTestWebdav}
        onSync={onSync}
        onClearCache={onClearCache}
        onExport={onExport}
        onImport={onImport}
        onExportDiagnostics={onExportDiagnostics}
        {...overrides}
      />,
    );
  }

  it("routes core toggles through explicit callbacks", () => {
    renderTab();

    fireEvent.click(
      screen.getByRole("switch", { name: translations.en.autoLaunch }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: translations.en.autoCopy }),
    );

    expect(onToggleAutoLaunch).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ autoCopy: true });
  });

  it("exposes shortcut recording as a controlled pressed state", () => {
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Alt+Q" }));

    expect(onRecordingChange).toHaveBeenCalledWith("q");
  });

  it("keeps WebDAV edits and actions behind advanced settings", () => {
    renderTab();
    fireEvent.click(
      screen.getByRole("button", {
        name: translations.en.showAdvancedSettings,
      }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: translations.en.webdavUrl }),
      { target: { value: "https://next.example/dav" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: translations.en.testConnection }),
    );

    expect(onWebDavChange).toHaveBeenCalledWith({
      url: "https://next.example/dav",
    });
    expect(onTestWebdav).toHaveBeenCalledOnce();
  });

  it("renders structured WebDAV failures through the shared catalog", () => {
    renderTab({
      webdavConnection: {
        ok: false,
        error: {
          code: "unauthorized",
          message: "HTTP 401",
          recoverable: true,
        },
      },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: translations.en.showAdvancedSettings,
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      translations.en.webdavError_unauthorized,
    );
  });
});
