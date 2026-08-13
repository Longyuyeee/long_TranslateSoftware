import { describe, expect, it, vi } from "vitest";
import type { DocumentJob, DocumentSegment } from "./documentTranslation";
import { DocumentTranslationTaskRegistry } from "./documentTranslationRegistry";
import type { TranslationExecutionSnapshot, TranslationTaskResult } from "./translationTask";

const now = "2026-08-14T00:00:00.000Z";
const execution: TranslationExecutionSnapshot = Object.freeze({
  primary: Object.freeze({
    apiKey: "runtime-secret",
    baseUrl: "https://api.example.com/v1",
    model: "translate-1",
  }),
  sourceLang: "auto",
  targetLang: "Chinese",
  customPrompt: "",
  glossary: Object.freeze([]),
});

function segment(jobId: string): DocumentSegment {
  return {
    id: `${jobId}-segment`,
    location: { order: 0, part: "word/document.xml" },
    structure: "paragraph",
    sourceText: jobId,
    status: "pending",
    attempts: 0,
  };
}

function job(id: string): DocumentJob {
  return {
    id,
    phase: "ready",
    input: {
      sourcePath: `C:\\docs\\${id}.docx`,
      fileName: `${id}.docx`,
      sizeBytes: 1024,
      format: "docx",
      fingerprint: `sha256:${id}`,
    },
    outputMode: "translated",
    snapshot: {
      sourceLanguage: "auto",
      targetLanguage: "Chinese",
      primary: { baseUrl: "https://api.example.com/v1", model: "translate-1" },
      customPrompt: "",
      glossary: [],
    },
    concurrency: 1,
    segments: [segment(id)],
    createdAt: now,
    updatedAt: now,
  };
}

function pendingExecutor() {
  return vi.fn((_text: string, _snapshot: TranslationExecutionSnapshot, signal: AbortSignal) =>
    new Promise<TranslationTaskResult>((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));
}

describe("document translation task registry", () => {
  it("prevents duplicate starts while keeping distinct jobs isolated", async () => {
    const registry = new DocumentTranslationTaskRegistry();
    const execute = pendingExecutor();
    const options = {
      execute,
      saveCheckpoint: async () => {},
      checkpointIntervalMs: 60_000,
      now: () => now,
    };
    const first = registry.start(job("first"), execution, options);
    const second = registry.start(job("second"), execution, options);
    expect(registry.size).toBe(2);
    expect(() => registry.start(job("first"), execution, options))
      .toThrow("already running");

    expect(registry.cancel("first")).toBe(true);
    await expect(first.done).resolves.toMatchObject({ status: "cancelled" });
    expect(registry.has("first")).toBe(false);
    expect(registry.has("second")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);

    second.cancel();
    await second.done;
    expect(registry.size).toBe(0);
  });

  it("cancels every owned task for application cleanup", async () => {
    const registry = new DocumentTranslationTaskRegistry();
    const execute = pendingExecutor();
    const options = {
      execute,
      saveCheckpoint: async () => {},
      checkpointIntervalMs: 60_000,
      now: () => now,
    };
    const tasks = [
      registry.start(job("one"), execution, options),
      registry.start(job("two"), execution, options),
      registry.start(job("three"), execution, options),
    ];

    expect(registry.cancelAll()).toBe(3);
    await expect(Promise.all(tasks.map(task => task.done))).resolves.toEqual([
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "cancelled" }),
    ]);
    expect(registry.size).toBe(0);
    expect(registry.cancelAll()).toBe(0);
    expect(registry.cancel("missing")).toBe(false);
  });

  it("releases completed jobs so they can be explicitly started again", async () => {
    const registry = new DocumentTranslationTaskRegistry();
    const execute = vi.fn(async (text: string) => ({
      text: `translated-${text}`,
      model: "translate-1",
      cached: false,
      usedBackup: false,
    }));
    const options = { execute, saveCheckpoint: async () => {}, now: () => now };

    await expect(registry.start(job("repeat"), execution, options).done)
      .resolves.toMatchObject({ status: "ready-to-rebuild" });
    expect(registry.has("repeat")).toBe(false);
    await expect(registry.start(job("repeat"), execution, options).done)
      .resolves.toMatchObject({ status: "ready-to-rebuild" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
