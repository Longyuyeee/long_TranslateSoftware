import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { isEnabled } from "@tauri-apps/plugin-autostart";
import { OcrLanguageInfo } from "../services/ocr";
import {
  DEFAULT_SETTINGS,
  parseStoredSettings,
  serializeSettings,
  SETTINGS_KEYS,
  SettingsSnapshot,
  settingsFingerprint,
  TRANSLATION_PROVIDERS,
  TranslationProviderId,
} from "../services/settings";
import { WebDavSyncSummary } from "../services/webdav";
import { cachePreferredLanguage } from "../i18n";

function applyStateAction<T>(current: T, action: SetStateAction<T>): T {
  return typeof action === "function"
    ? (action as (value: T) => T)(current)
    : action;
}

export function useSettings() {
  const [settings, setSettings] = useState<SettingsSnapshot>(DEFAULT_SETTINGS);
  const [translationProvider, setTranslationProvider] =
    useState<TranslationProviderId>("deepseek");
  const [shortcutQ, setShortcutQ] = useState("Alt+Q");
  const [shortcutW, setShortcutW] = useState("Alt+W");
  const [installedOcrLanguages, setInstalledOcrLanguages] =
    useState<OcrLanguageInfo[] | null>(null);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState("");
  const [lastSyncSummary, setLastSyncSummary] =
    useState<WebDavSyncSummary | null>(null);
  const [configHydrated, setConfigHydrated] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  const mountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);
  const savingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, []);

  const currentFingerprint = useMemo(
    () => settingsFingerprint(settings),
    [settings],
  );
  const hasUnsavedChanges =
    configHydrated &&
    savedFingerprint !== null &&
    currentFingerprint !== savedFingerprint;

  useEffect(() => {
    if (configHydrated && savedFingerprint === null) {
      setSavedFingerprint(currentFingerprint);
    }
  }, [configHydrated, currentFingerprint, savedFingerprint]);

  useEffect(() => {
    if (configHydrated) cachePreferredLanguage(settings.lang);
  }, [configHydrated, settings.lang]);

  useEffect(() => {
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [hasUnsavedChanges]);

  const updateSetting = useCallback(
    <Key extends keyof SettingsSnapshot>(
      key: Key,
      action: SetStateAction<SettingsSnapshot[Key]>,
    ) => {
      setSettings((current) => ({
        ...current,
        [key]: applyStateAction(current[key], action),
      }));
    },
    [],
  );

  const createSetter = <Key extends keyof SettingsSnapshot>(
    key: Key,
  ): Dispatch<SetStateAction<SettingsSnapshot[Key]>> =>
    (action) => updateSetting(key, action);

  const loadSettings = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setConfigHydrated(false);
    setSavedFingerprint(null);
    try {
      const [values, detectedOcrLanguages] = await Promise.all([
        invoke<Record<string, string>>("get_config_values", {
          keys: SETTINGS_KEYS,
        }),
        invoke<OcrLanguageInfo[]>("get_available_ocr_languages").catch((error) => {
          console.warn(
            "Unable to enumerate installed OCR languages; using fallback list",
            error,
          );
          return null;
        }),
      ]);
      const enabled = await isEnabled();
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;

      const parsed = parseStoredSettings(values, detectedOcrLanguages);
      setSettings(parsed.settings);
      setSavedFingerprint(settingsFingerprint(parsed.settings));
      setTranslationProvider(parsed.translationProvider);
      setShortcutQ(parsed.shortcutQ);
      setShortcutW(parsed.shortcutW);
      setInstalledOcrLanguages(detectedOcrLanguages);
      setLastSyncTime(parsed.lastSyncTime);
      setLastSyncSummary(parsed.lastSyncSummary);
      setAutoLaunch(enabled);
    } catch (error) {
      console.error(error);
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setConfigHydrated(true);
      }
    }
  }, []);

  const saveSettings = useCallback(async () => {
    if (savingRef.current || !hasUnsavedChanges) return "skipped" as const;
    savingRef.current = true;
    setIsSavingSettings(true);
    try {
      await invoke("set_config_values", {
        values: serializeSettings(settings),
      });
      if (!mountedRef.current) return "skipped" as const;
      setSavedFingerprint(settingsFingerprint(settings));
      void emit("settings-changed", {
        theme: settings.theme,
        fontSize: settings.fontSize,
      }).catch(console.error);
      return "saved" as const;
    } catch (error) {
      console.error("Failed to save settings", error);
      return "failed" as const;
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setIsSavingSettings(false);
    }
  }, [hasUnsavedChanges, settings]);

  const applyTranslationProvider = useCallback(
    (providerId: TranslationProviderId) => {
      setTranslationProvider(providerId);
      const provider = TRANSLATION_PROVIDERS.find(
        (item) => item.id === providerId,
      );
      if (provider && provider.id !== "custom") {
        setSettings((current) => ({
          ...current,
          transBaseUrl: provider.baseUrl,
          transModelName: provider.model,
        }));
      }
    },
    [],
  );

  return {
    ...settings,
    setTransApiKey: createSetter("transApiKey"),
    setTransBaseUrl: createSetter("transBaseUrl"),
    setTransModelName: createSetter("transModelName"),
    setCustomPrompt: createSetter("customPrompt"),
    setBackupApiKey: createSetter("backupApiKey"),
    setBackupBaseUrl: createSetter("backupBaseUrl"),
    setBackupModelName: createSetter("backupModelName"),
    setLang: createSetter("lang"),
    setTargetLang: createSetter("targetLang"),
    setSourceLang: createSetter("sourceLang"),
    setAutoCopy: createSetter("autoCopy"),
    setClipboardMonitor: createSetter("clipboardMonitor"),
    setAccentColor: createSetter("accentColor"),
    setTheme: createSetter("theme"),
    setFontSize: createSetter("fontSize"),
    setTtsEngine: createSetter("ttsEngine"),
    setTtsApiKey: createSetter("ttsApiKey"),
    setTtsBaseUrl: createSetter("ttsBaseUrl"),
    setTtsModelName: createSetter("ttsModelName"),
    setTtsVoice: createSetter("ttsVoice"),
    setTtsSpeed: createSetter("ttsSpeed"),
    setOcrLang: createSetter("ocrLang"),
    setWebdavEnabled: createSetter("webdavEnabled"),
    setWebdavUrl: createSetter("webdavUrl"),
    setWebdavUser: createSetter("webdavUser"),
    setWebdavPass: createSetter("webdavPass"),
    translationProvider,
    setTranslationProvider,
    applyTranslationProvider,
    shortcutQ,
    setShortcutQ,
    shortcutW,
    setShortcutW,
    installedOcrLanguages,
    autoLaunch,
    setAutoLaunch,
    lastSyncTime,
    setLastSyncTime,
    lastSyncSummary,
    setLastSyncSummary,
    configHydrated,
    hasUnsavedChanges,
    isSavingSettings,
    loadSettings,
    saveSettings,
  };
}
