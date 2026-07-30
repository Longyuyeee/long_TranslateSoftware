import { OpenAiSseParser } from "./sse";
import {
  chatCompletionsEndpoint,
  normalizeTranslationError,
  resolveTranslationProvider,
  TranslationRequestError,
  translationHttpError,
  type TranslationErrorCode,
} from "./translationProvider";

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  latencyMs?: number;
  error?: { code: TranslationErrorCode; message: string };
};

export type StreamChatCompletionOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
};

export function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const timeoutId = setTimeout(
    () => controller.abort(
      new DOMException("Translation request timed out", "TimeoutError"),
    ),
    timeoutMs,
  );
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  });
}

export async function streamChatCompletion({
  apiKey,
  baseUrl,
  model,
  messages,
  onChunk,
  signal,
}: StreamChatCompletionOptions): Promise<void> {
  const provider = resolveTranslationProvider(baseUrl);
  const response = await fetchWithTimeout(
    chatCompletionsEndpoint(baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: provider.capabilities.streaming,
      }),
    },
    provider.capabilities.requestTimeoutMs,
    signal,
  );

  if (!response.ok) {
    const error = translationHttpError(response.status);
    throw new TranslationRequestError(error.code, error.message);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new TranslationRequestError(
      "server",
      "Translation service returned an empty response",
    );
  }
  const parser = new OpenAiSseParser();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const content of parser.push(value)) onChunk(content);
  }
  for (const content of parser.finish()) onChunk(content);
}

/** Performs a minimal non-streaming request against an OpenAI-compatible endpoint. */
export async function testTranslationConnection(config: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): Promise<ConnectionTestResult> {
  const apiKey = config.apiKey.trim();
  const baseUrl = config.baseUrl;
  const model = config.model.trim();
  if (!apiKey) {
    return {
      ok: false,
      error: {
        code: "missing-api-key",
        message: "API key is not configured",
      },
    };
  }
  if (!baseUrl.trim() || !model) {
    return {
      ok: false,
      error: {
        code: "unknown",
        message: "Base URL and model are required",
      },
    };
  }

  const startedAt = performance.now();
  try {
    const provider = resolveTranslationProvider(baseUrl);
    const response = await fetchWithTimeout(
      chatCompletionsEndpoint(baseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 2,
          stream: false,
        }),
      },
      provider.capabilities.connectionTimeoutMs,
    );
    if (!response.ok) {
      return { ok: false, error: translationHttpError(response.status) };
    }
    await response.text();
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return { ok: false, error: normalizeTranslationError(error) };
  }
}
