import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle,
  ChevronRight,
  Cpu,
  ExternalLink,
  Save,
  Settings,
  Sparkles,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { TranslationCatalog } from "../i18n";
import { translationErrorText } from "../i18n";
import type { ConnectionTestResult } from "../services/api";
import {
  TRANSLATION_PROVIDERS,
  type TranslationProviderId,
} from "../services/translationProvider";

export interface TranslationModelConfig {
  providerId: TranslationProviderId;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  customPrompt: string;
  backupApiKey: string;
  backupBaseUrl: string;
  backupModelName: string;
}

export type TranslationModelPatch = Partial<
  Omit<TranslationModelConfig, "providerId">
>;

export interface TtsModelConfig {
  engine: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  voice: string;
  speed: string;
}

interface ModelConfigTabProps {
  labels: TranslationCatalog;
  translation: TranslationModelConfig;
  tts: TtsModelConfig;
  connectionTest: ConnectionTestResult | null;
  isTestingConnection: boolean;
  onProviderChange: (providerId: TranslationProviderId) => void;
  onTranslationChange: (patch: TranslationModelPatch) => void;
  onTtsChange: (patch: Partial<TtsModelConfig>) => void;
  onTestConnection: () => void;
}

interface ConfigFieldProps {
  label: string;
  value: string;
  placeholder: string;
  icon: LucideIcon;
  onChange: (value: string) => void;
  type?: "text" | "password";
  compact?: boolean;
}

const VOICE_PRESETS = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
  "Cherry",
  "Serena",
] as const;

function ConfigField({
  label,
  value,
  placeholder,
  icon: Icon,
  onChange,
  type = "text",
  compact = false,
}: ConfigFieldProps) {
  return (
    <div>
      <label className={`mb-2 ml-2 block font-black uppercase tracking-[0.2em] text-zinc-400 ${compact ? "text-[9px]" : "text-[10px]"}`}>
        {label}
      </label>
      <div className="relative">
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full border border-black/5 bg-white/40 pl-5 pr-12 font-bold outline-none transition-all placeholder:text-zinc-400 focus:ring-4 ring-blue-500/10 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500 ${
            compact ? "rounded-[18px] py-3.5 text-[0.8em]" : "rounded-[20px] py-4 text-[0.85em]"
          }`}
          placeholder={placeholder}
        />
        <Icon
          className="absolute right-5 top-1/2 -translate-y-1/2 text-zinc-300"
          size={compact ? 18 : 20}
        />
      </div>
    </div>
  );
}

export default function ModelConfigTab({
  labels,
  translation,
  tts,
  connectionTest,
  isTestingConnection,
  onProviderChange,
  onTranslationChange,
  onTtsChange,
  onTestConnection,
}: ModelConfigTabProps) {
  const [showAdvancedModel, setShowAdvancedModel] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 pb-20">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowAdvancedSettings((value) => !value)}
          className="flex items-center gap-2 rounded-full bg-black/5 px-4 py-2 text-[10px] font-black text-zinc-400 transition-colors hover:text-accent dark:bg-white/5"
        >
          <Settings size={13} />
          {showAdvancedSettings ? labels.hideAdvancedSettings : labels.showAdvancedSettings}
        </button>
      </div>

      <div className="glass-card space-y-6 rounded-[28px] border-white/50 p-10 shadow-apple">
        <div className="mb-4 flex items-center gap-5">
          <div className="flex h-14 w-14 items-center justify-center rounded-[20px] bg-zinc-200 text-zinc-600 shadow-inner dark:bg-white/10 dark:text-zinc-300">
            <Cpu size={28} />
          </div>
          <div>
            <h3 className="text-lg font-black tracking-tight">{labels.transModel}</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 opacity-60">{labels.transIntelligence}</p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="mb-2 ml-2 block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">
              {labels.translationService}
            </label>
            <div className="grid grid-cols-3 gap-2 rounded-[20px] bg-black/[0.03] p-1.5 dark:bg-white/[0.04]">
              {TRANSLATION_PROVIDERS.map((provider) => (
                <button
                  type="button"
                  key={provider.id}
                  onClick={() => onProviderChange(provider.id)}
                  className={`rounded-[15px] px-3 py-3 text-[10px] font-black transition-all ${
                    translation.providerId === provider.id
                      ? "bg-white text-accent shadow-sm dark:bg-white/10"
                      : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  }`}
                >
                  {provider.id === "custom" ? labels.customService : provider.label}
                </button>
              ))}
            </div>
          </div>

          <ConfigField
            label={labels.apiKey}
            value={translation.apiKey}
            onChange={(apiKey) => onTranslationChange({ apiKey })}
            placeholder={labels.apiKeyPlaceholder}
            icon={Save}
            type="password"
          />
          <ConfigField
            label={labels.modelName}
            value={translation.modelName}
            onChange={(modelName) => onTranslationChange({ modelName })}
            placeholder={labels.translationModelPlaceholder}
            icon={Sparkles}
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onTestConnection}
              disabled={isTestingConnection}
              className="flex items-center gap-2 rounded-full bg-accent/10 px-5 py-2.5 text-[10px] font-black text-accent transition-all hover:bg-accent/15 disabled:opacity-50"
            >
              {isTestingConnection
                ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
                : <CheckCircle size={14} />}
              {isTestingConnection ? labels.connectionTesting : labels.testConnection}
            </button>
            {connectionTest && (
              <span
                role={connectionTest.ok ? "status" : "alert"}
                className={`flex items-center gap-1.5 text-[10px] font-bold ${
                  connectionTest.ok ? "text-emerald-500" : "text-red-500"
                }`}
              >
                {connectionTest.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}
                {connectionTest.ok
                  ? labels.connectionSuccess.replace("{latency}", String(connectionTest.latencyMs || 0))
                  : translationErrorText(labels, connectionTest.error?.code, connectionTest.error?.message)}
              </span>
            )}
          </div>
        </div>

        <div className="border-t border-black/5 pt-4 dark:border-white/5">
          <button
            type="button"
            onClick={() => setShowAdvancedModel((value) => !value)}
            className="flex w-full items-center justify-between rounded-2xl px-2 py-2 text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400 transition-colors hover:text-accent"
          >
            {labels.advancedSettings}
            <ChevronRight size={15} className={`transition-transform ${showAdvancedModel ? "rotate-90" : ""}`} />
          </button>
          <AnimatePresence initial={false}>
            {showAdvancedModel && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="space-y-5 pt-4">
                  <ConfigField
                    label={labels.baseUrl}
                    value={translation.baseUrl}
                    onChange={(baseUrl) => {
                      onProviderChange("custom");
                      onTranslationChange({ baseUrl });
                    }}
                    placeholder={labels.baseUrlExample}
                    icon={ExternalLink}
                  />
                  <div>
                    <label className="mb-2 ml-2 block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">{labels.customPrompt}</label>
                    <textarea
                      value={translation.customPrompt}
                      onChange={(event) => onTranslationChange({ customPrompt: event.target.value })}
                      placeholder={labels.customPromptExample}
                      className="custom-scrollbar h-28 w-full resize-none rounded-[20px] border border-black/5 bg-white/40 px-5 py-4 text-[0.8em] font-medium outline-none transition-all placeholder:text-zinc-400 focus:ring-4 ring-blue-500/10 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500"
                    />
                    <p className="ml-2 mt-1.5 text-[9px] font-bold text-zinc-400">{labels.customPromptDesc}</p>
                  </div>
                  <div className="border-t border-black/5 pt-5 dark:border-white/5">
                    <label className="mb-3 ml-2 block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">{labels.backupModel}</label>
                    <div className="space-y-4">
                      <ConfigField
                        label={labels.baseUrl}
                        value={translation.backupBaseUrl}
                        onChange={(backupBaseUrl) => onTranslationChange({ backupBaseUrl })}
                        placeholder={labels.baseUrlExample}
                        icon={ExternalLink}
                        compact
                      />
                      <ConfigField
                        label={labels.apiKey}
                        value={translation.backupApiKey}
                        onChange={(backupApiKey) => onTranslationChange({ backupApiKey })}
                        placeholder={labels.apiKeyPlaceholder}
                        icon={Save}
                        type="password"
                        compact
                      />
                      <ConfigField
                        label={labels.modelName}
                        value={translation.backupModelName}
                        onChange={(backupModelName) => onTranslationChange({ backupModelName })}
                        placeholder={labels.backupModelPlaceholder}
                        icon={Sparkles}
                        compact
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className={`${showAdvancedSettings ? "block" : "hidden"} glass-card space-y-6 rounded-[28px] border-white/50 p-10 shadow-apple`}>
        <div className="mb-4 flex items-center gap-5">
          <div className="flex h-14 w-14 items-center justify-center rounded-[20px] bg-accent/10 text-accent shadow-inner">
            <Volume2 size={28} />
          </div>
          <div>
            <h3 className="text-lg font-black tracking-tight">{labels.audioModel}</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 opacity-60">{labels.voiceEngine}</p>
          </div>
        </div>
        <div className="space-y-6">
          <div className="flex items-center justify-between rounded-[22px] border border-white/30 bg-white/20 p-5 dark:border-white/5 dark:bg-white/5">
            <div>
              <label className="block text-[0.9em] font-black">{labels.ttsEngine}</label>
              <span className="text-[0.7em] font-bold uppercase text-zinc-400 opacity-60">
                {tts.engine === "local" ? labels.ttsLocal : tts.engine === "edge" ? labels.ttsEdge : labels.ttsOnline}
              </span>
            </div>
            <div className="flex rounded-full border border-black/5 bg-black/5 p-1 dark:bg-white/5">
              {(["local", "edge", "online"] as const).map((engine) => (
                <button
                  type="button"
                  key={engine}
                  onClick={() => onTtsChange({ engine })}
                  className={`rounded-full px-4 py-1.5 text-[10px] font-black transition-all ${
                    tts.engine === engine
                      ? "bg-white text-accent shadow-md dark:bg-zinc-800"
                      : "text-zinc-400"
                  }`}
                >
                  {engine === "local" ? labels.ttsLocal : engine === "edge" ? labels.ttsEdge : labels.ttsOnline}
                </button>
              ))}
            </div>
          </div>

          {tts.engine === "online" && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="space-y-5">
              <ConfigField label={labels.baseUrl} value={tts.baseUrl} onChange={(baseUrl) => onTtsChange({ baseUrl })} placeholder={labels.baseUrlExample} icon={ExternalLink} />
              <ConfigField label={labels.apiKey} value={tts.apiKey} onChange={(apiKey) => onTtsChange({ apiKey })} placeholder={labels.apiKeyPlaceholder} icon={Save} type="password" />
              <ConfigField label={labels.ttsModel} value={tts.modelName} onChange={(modelName) => onTtsChange({ modelName })} placeholder={labels.ttsModelPlaceholder} icon={Sparkles} />
              <div>
                <label className="mb-2 ml-2 block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">{labels.ttsVoice}</label>
                <input
                  value={tts.voice}
                  onChange={(event) => onTtsChange({ voice: event.target.value })}
                  className="w-full rounded-[20px] border border-black/5 bg-white/40 px-5 py-4 text-[0.85em] font-bold outline-none placeholder:text-zinc-400 dark:border-white/10 dark:bg-black/20 dark:text-white dark:placeholder:text-zinc-500"
                  placeholder={labels.ttsVoicePlaceholder}
                />
                <div className="mt-2 flex flex-wrap gap-2 px-2">
                  {VOICE_PRESETS.map((voice) => (
                    <button
                      type="button"
                      key={voice}
                      onClick={() => onTtsChange({ voice })}
                      className="rounded-md bg-black/5 px-2 py-1 text-[9px] transition-all hover:bg-accent hover:text-white dark:bg-white/5"
                    >
                      {voice}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
          <div>
            <label className="mb-2 ml-2 block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">
              {labels.ttsSpeed} ({tts.speed}{labels.speedMultiplierSuffix})
            </label>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={tts.speed}
              onChange={(event) => onTtsChange({ speed: event.target.value })}
              className="h-1.5 w-full appearance-none rounded-full bg-black/5 accent-[var(--accent)] dark:bg-white/5"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
