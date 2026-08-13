import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentJob, DocumentSegment } from "./documentTranslation";
import {
  createDocumentCheckpointWriter,
  startPersistentDocumentTranslationQueue,
  type DocumentCheckpointSink,
} from "./documentTranslationPersistence";
import type { TranslationExecutionSnapshot, TranslationTaskResult } from "./translationTask";

const now = "2026-08-13T00:00:00.000Z";
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

function segment(index: number): DocumentSegment {
  return {
    id: `segment-${index}`,
    location: { order: index, part: "word/document.xml" },
    structure: "paragraph",
    sourceText: `source-${index}`,
    status: "pending",
    attempts: 0,
  };
}

function job(count = 2): DocumentJob {
  return {
    id: "persistent-job",
    phase: "ready",
    input: {
      sourcePath: "C:\\docs\\input.docx",
      fileName: "input.docx",
      sizeBytes: 1024,
      format: "docx",
      fingerprint: "sha256:persistent",
    },
    outputMode: "translated",
    snapshot: {
      sourceLanguage: "auto",
      targetLanguage: "Chinese",
      primary: { baseUrl: "https://api.example.com/v1", model: "translate-1" },
      customPrompt: "",
      glossary: [],
    },
    concurrency: 2,
    segments: Array.from({ length: count }, (_, index) => segment(index)),
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => vi.useRealTimers());

describe("document checkpoint writer", () => {
  it("coalesces rapid updates and saves only the latest valid checkpoint", async () => {
    vi.useFakeTimers();
    const save = vi.fn<DocumentCheckpointSink>(async () => {});
    const writer = createDocumentCheckpointWriter({ intervalMs: 500, save });
    const first = job(1);
    const latest = { ...first, phase: "translating" as const };
    writer.schedule(first);
    writer.schedule(latest);

    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await writer.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].job.phase).toBe("translating");
    writer.close();
  });

  it("serializes writes that become due while an earlier save is running", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const save = vi.fn<DocumentCheckpointSink>(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active -= 1;
    });
    const writer = createDocumentCheckpointWriter({ intervalMs: 10, save });
    writer.schedule(job(1));
    await vi.advanceTimersByTimeAsync(10);
    writer.schedule({ ...job(1), phase: "translating" });
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledOnce();
    releases.shift()?.();
    await Promise.resolve();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await writer.flush();
    expect(maximumActive).toBe(1);
    writer.close();
  });
});

describe("persistent document translation queue", () => {
  it("flushes the final rebuilding checkpoint even inside the throttle window", async () => {
    const save = vi.fn<DocumentCheckpointSink>(async () => {});
    const completion = await startPersistentDocumentTranslationQueue(job(), execution, {
      checkpointIntervalMs: 60_000,
      saveCheckpoint: save,
      now: () => now,
      execute: async (text) => ({
        text: `translated-${text}`,
        model: "translate-1",
        cached: false,
        usedBackup: false,
      }),
    }).done;

    expect(completion.status).toBe("ready-to-rebuild");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].job.phase).toBe("rebuilding");
  });

  it("cancels active work and rejects completion when checkpoint storage fails", async () => {
    vi.useFakeTimers();
    const storageError = new Error("disk unavailable");
    const execute = vi.fn((_text: string, _snapshot: TranslationExecutionSnapshot, signal: AbortSignal) =>
      new Promise<TranslationTaskResult>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("Cancelled", "AbortError")), { once: true });
      }));
    const task = startPersistentDocumentTranslationQueue(job(3), execution, {
      checkpointIntervalMs: 0,
      saveCheckpoint: async () => { throw storageError; },
      execute,
      now: () => now,
    });
    const rejected = expect(task.done).rejects.toBe(storageError);

    await vi.runAllTimersAsync();
    await rejected;
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
