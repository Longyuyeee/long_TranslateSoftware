export type TranslationErrorCode =
  | "missing-api-key"
  | "unauthorized"
  | "model-not-found"
  | "rate-limited"
  | "timeout"
  | "network"
  | "server"
  | "format-invalid"
  | "unknown";

export interface TranslationProviderCapabilities {
  protocol: "openai-chat-completions";
  streaming: boolean;
  requestTimeoutMs: number;
  connectionTimeoutMs: number;
}

export interface TranslationProviderDefinition {
  id: "deepseek" | "openai" | "custom";
  label: string;
  baseUrl: string;
  model: string;
  capabilities: TranslationProviderCapabilities;
}

const OPENAI_COMPATIBLE_CAPABILITIES: TranslationProviderCapabilities = {
  protocol: "openai-chat-completions",
  streaming: true,
  requestTimeoutMs: 60_000,
  connectionTimeoutMs: 15_000,
};

export const TRANSLATION_PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    model: "",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
] as const satisfies readonly TranslationProviderDefinition[];

export type TranslationProviderId = typeof TRANSLATION_PROVIDERS[number]["id"];

export function normalizeTranslationBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function identifyTranslationProvider(baseUrl: string): TranslationProviderId {
  const normalized = normalizeTranslationBaseUrl(baseUrl);
  return TRANSLATION_PROVIDERS.find(
    (provider) => provider.baseUrl
      && normalizeTranslationBaseUrl(provider.baseUrl) === normalized,
  )?.id ?? "custom";
}

export function resolveTranslationProvider(
  baseUrl: string,
): TranslationProviderDefinition {
  const id = identifyTranslationProvider(baseUrl);
  return TRANSLATION_PROVIDERS.find((provider) => provider.id === id)
    ?? TRANSLATION_PROVIDERS[TRANSLATION_PROVIDERS.length - 1];
}

export function chatCompletionsEndpoint(baseUrl: string): string {
  return `${normalizeTranslationBaseUrl(baseUrl)}/chat/completions`;
}

export function translationHttpError(status: number): {
  code: TranslationErrorCode;
  message: string;
} {
  const code: TranslationErrorCode = status === 401 || status === 403
    ? "unauthorized"
    : status === 404
      ? "model-not-found"
      : status === 429
        ? "rate-limited"
        : status >= 500
          ? "server"
          : "unknown";
  return {
    code,
    message: `Translation service returned HTTP ${status}`,
  };
}

export class TranslationRequestError extends Error {
  constructor(
    public readonly code: TranslationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TranslationRequestError";
  }
}

export function normalizeTranslationError(error: unknown): {
  code: TranslationErrorCode;
  message: string;
} {
  if (error instanceof TranslationRequestError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { code: "timeout", message: "Translation request timed out" };
  }
  if (error instanceof TypeError) {
    return { code: "network", message: "Unable to reach the translation service" };
  }
  if (error instanceof Error) return { code: "unknown", message: error.message };
  return { code: "unknown", message: "Unknown translation error" };
}
