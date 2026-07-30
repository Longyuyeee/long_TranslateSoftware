import type { Lang } from "../i18n";
import type { WebDavError, WebDavSyncSummary } from "../services/webdav";

export interface GeneralSettingsValue {
  lang: Lang;
  autoLaunch: boolean;
  sourceLang: string;
  targetLang: string;
  ocrLang: string;
  autoCopy: boolean;
  clipboardMonitor: boolean;
}

export type GeneralSettingsPatch = Partial<
  Omit<GeneralSettingsValue, "autoLaunch">
>;

export interface ShortcutSettingsValue {
  q: string;
  w: string;
  recording: "q" | "w" | null;
}

export interface WebDavSettingsValue {
  enabled: boolean;
  url: string;
  user: string;
  password: string;
  lastSyncTime: string;
  lastSyncSummary: WebDavSyncSummary | null;
}

export type WebDavSettingsPatch = Partial<
  Pick<WebDavSettingsValue, "enabled" | "url" | "user" | "password">
>;

export interface WebDavConnectionState {
  ok: boolean;
  latencyMs?: number;
  error?: WebDavError;
}
