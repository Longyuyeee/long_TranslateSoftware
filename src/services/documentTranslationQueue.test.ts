import { describe, expect, it, vi } from "vitest";
import { TranslationRequestError } from "./translationProvider";
import {
  startDocumentTranslationQueue,
  type DocumentSegmentExecutor,
} from "./documentTranslationQueue";
import type { DocumentJob, DocumentSegment } from "./documentTranslation";
import type {
  TranslationExecutionSnapshot,
  TranslationTaskResult,
} from "./translationTask";

const now = "2026-08-13T00:00:00.000Z";

const execution: TranslationExecutionSnapshot = Object.freeze({
  primary: Object.freeze({
    apiKey: "runtime-only-secret",
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

function job(count: number, concurrency = 3): DocumentJob {
  return {
    id: "job-queue",
    phase: "ready",
    input: {
      sourcePath: "C:\\docs\\input.docx",
      fileName: "input.docx",
      sizeBytes: 1024,
      format: "docx",
      fingerprint: "sha256:queue",
    },
    outputMode: "translated",
    snapshot: {
      sourceLanguage: "auto",
      targetLanguage: "Chinese",
      primary: {
        baseUrl: "https://api.example.com/v1",
        model: "translate-1",
      },
      customPrompt: "",
      glossary: [],
    },
    concurrency,
    segments: Array.from({ length: count }, (_, index) => segment(index)),
    createdAt: now,
    updatedAt: now,
  };
}

describe("document translation queue", () => {
  it("bounds concurrency and keeps progress stable across out-of-order completion", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const execute: DocumentSegmentExecutor = vi.fn(async (text, snapshot) => {
      expect(snapshot).toBe(execution);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active -= 1;
      return { text: `translated-${text}`, model: "translate-1", cached: false, usedBackup: false };
    });
    const progress: Array<{ completed: number; total: number }> = [];
    const task = startDocumentTranslationQueue(job(5, 2), execution, {
      execute,
      now: () => now,
      onJob: (_nextJob, nextProgress) => progress.push(nextProgress),
    });

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(1, 1)[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(5));
    while (releases.length > 0) releases.shift()?.();

    const completion = await task.done;
    expect(completion.status).toBe("ready-to-rebuild");
    expect(completion.job.phase).toBe("rebuilding");
    expect(completion.job.segments.map(item => item.status)).toEqual([
      "translated", "translated", "translated", "translated", "translated",
    ]);
    expect(maximumActive).toBe(2);
    expect(progress.every(item => item.completed <= item.total)).toBe(true);
  });

  it("cancels in-flight work and never starts queued segments", async () => {
    const execute: DocumentSegmentExecutor = vi.fn((_text, _snapshot, signal) =>
      new Promise<TranslationTaskResult>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("Cancelled", "AbortError")), { once: true });
      }));
    const task = startDocumentTranslationQueue(job(5, 2), execution, {
      execute,
      now: () => now,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    task.cancel();

    const completion = await task.done;
    expect(completion.status).toBe("cancelled");
    expect(completion.job.phase).toBe("cancelled");
    expect(completion.job.segments.map(item => item.status)).toEqual([
      "pending", "pending", "pending", "pending", "pending",
    ]);
    expect(completion.job.segments.map(item => item.attempts)).toEqual([1, 1, 0, 0, 0]);
  });

  it("isolates retryable failures without discarding successful segments", async () => {
    const execute: DocumentSegmentExecutor = vi.fn(async (text) => {
      if (text === "source-1") {
        throw new TranslationRequestError("rate-limited", "Try later");
      }
      return { text: `translated-${text}`, model: "translate-1", cached: false, usedBackup: false };
    });
    const completion = await startDocumentTranslationQueue(job(3), execution, {
      execute,
      now: () => now,
    }).done;

    expect(completion.status).toBe("failed");
    expect(completion.job.phase).toBe("failed");
    expect(completion.job.segments[0].status).toBe("translated");
    expect(completion.job.segments[1]).toMatchObject({
      status: "failed",
      error: { code: "translation-failed", retryable: true, segmentId: "segment-1" },
    });
    expect(completion.job.segments[2].status).toBe("translated");
  });

  it("does not mistake a provider AbortError for user cancellation", async () => {
    const execute: DocumentSegmentExecutor = vi.fn(async () => {
      throw new DOMException("Provider aborted", "AbortError");
    });
    const completion = await startDocumentTranslationQueue(job(1), execution, {
      execute,
      now: () => now,
    }).done;

    expect(completion.status).toBe("failed");
    expect(completion.job.segments[0]).toMatchObject({
      status: "failed",
      error: { retryable: false },
    });
  });

  it("bounds provider errors so the failed checkpoint remains persistable", async () => {
    const execute: DocumentSegmentExecutor = vi.fn(async () => {
      throw new Error("错".repeat(5_000));
    });
    const completion = await startDocumentTranslationQueue(job(1), execution, {
      execute,
      now: () => now,
    }).done;
    const message = completion.job.segments[0].error?.message ?? "";

    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(message.endsWith("�")).toBe(false);
  });

  it("rejects settings drift before any provider request", () => {
    const mismatched = {
      ...execution,
      targetLang: "Japanese",
    } satisfies TranslationExecutionSnapshot;
    const execute = vi.fn<DocumentSegmentExecutor>();
    expect(() => startDocumentTranslationQueue(job(1), mismatched, { execute }))
      .toThrow("do not match the frozen document snapshot");
    expect(execute).not.toHaveBeenCalled();
  });
});
