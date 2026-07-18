import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { startTranslationComparisonTask, startTranslationTask, testTranslationConnection, TranslationTaskState } from "./api";

const config: Record<string, string> = {
  trans_api_key: "primary-key",
  trans_base_url: "https://primary.example/v1",
  trans_model_name: "primary-model",
  backup_api_key: "backup-key",
  backup_base_url: "https://backup.example/v1",
  backup_model: "backup-model",
  target_lang: "Chinese",
  source_lang: "auto",
  custom_prompt: "",
};

function sseResponse(content: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
}

describe("startTranslationTask", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
    invokeMock.mockImplementation((command: string, args?: { key?: string; keys?: string[] }) => {
      if (command === "get_config_value") return Promise.resolve(config[args?.key || ""] || "");
      if (command === "get_config_values") return Promise.resolve(Object.fromEntries((args?.keys || []).map(key => [key, config[key] || ""])));
      if (command === "get_glossary_entries") return Promise.resolve([]);
      if (command === "lookup_translation_memory") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
  });

  it("isolates backup output from a failed primary model", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("primary failed", { status: 500 }))
      .mockResolvedValueOnce(sseResponse("备用译文"));
    const texts: string[] = [];
    const states: TranslationTaskState[] = [];

    const task = startTranslationTask("hello", {
      onText: text => texts.push(text),
      onState: state => states.push(state),
    });
    const completion = await task.done;

    expect(completion).toEqual({
      status: "success",
      result: { text: "备用译文", model: "backup-model", cached: false, usedBackup: true },
    });
    expect(texts[texts.length - 1]).toBe("备用译文");
    expect(states.map(state => state.phase)).toContain("translating-backup");
    expect(states[states.length - 1]).toMatchObject({ phase: "success", model: "backup-model", usedBackup: true });
  });

  it("returns a cache hit without calling the network", async () => {
    invokeMock.mockImplementation((command: string, args?: { key?: string; keys?: string[] }) => {
      if (command === "get_config_value") return Promise.resolve(config[args?.key || ""] || "");
      if (command === "get_config_values") return Promise.resolve(Object.fromEntries((args?.keys || []).map(key => [key, config[key] || ""])));
      if (command === "get_glossary_entries") return Promise.resolve([]);
      if (command === "lookup_translation_memory") return Promise.resolve("缓存译文");
      return Promise.resolve(undefined);
    });

    const task = startTranslationTask("hello");
    const completion = await task.done;

    expect(completion).toMatchObject({ status: "success", result: { text: "缓存译文", cached: true } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request without producing an error result", async () => {
    vi.mocked(fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));
    const states: TranslationTaskState[] = [];

    const task = startTranslationTask("hello", { onState: state => states.push(state) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    task.cancel();
    const completion = await task.done;

    expect(completion).toEqual({ status: "cancelled" });
    expect(states[states.length - 1]?.phase).toBe("cancelled");
  });

  it("keeps configuration errors out of translated text", async () => {
    const texts: string[] = [];
    invokeMock.mockImplementation((command: string, args?: { key?: string; keys?: string[] }) => {
      if (command === "get_config_value") {
        const key = args?.key || "";
        return Promise.resolve(key.includes("api_key") ? "" : config[key] || "");
      }
      if (command === "get_config_values") return Promise.resolve(Object.fromEntries((args?.keys || []).map(key => [key, key.includes("api_key") ? "" : config[key] || ""])));
      return Promise.resolve(undefined);
    });

    const completion = await startTranslationTask("hello", { onText: text => texts.push(text) }).done;

    expect(completion).toMatchObject({ status: "error", error: { code: "missing-api-key" } });
    expect(texts).toEqual([]);
  });

  it("keeps comparison errors separate from model output", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(sseResponse("备用结果"));
    const primaryTexts: string[] = [];
    const backupTexts: string[] = [];

    const task = startTranslationComparisonTask("hello", {
      onText: (side, text) => (side === "primary" ? primaryTexts : backupTexts).push(text),
    });
    const completion = await task.done;

    expect(completion).toMatchObject({
      status: "success",
      result: { backup: { text: "备用结果", model: "backup-model" } },
    });
    expect(primaryTexts).toEqual([""]);
    expect(backupTexts[backupTexts.length - 1]).toBe("备用结果");
  });

  it("classifies connection-test authentication failures", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const result = await testTranslationConnection({
      apiKey: "bad-key",
      baseUrl: "https://api.example.com/v1/",
      model: "example-model",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
