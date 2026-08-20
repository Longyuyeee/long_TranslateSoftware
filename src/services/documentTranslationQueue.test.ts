import { describe, expect, it, vi } from "vitest";
import { TranslationRequestError } from "./translationProvider";
import {
  prepareDocumentJobForFailedSegmentRetry,
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
  it("keeps PDF page anchors intact while reusing the existing queue", async () => {
    const pdfJob: DocumentJob = {
      ...job(1),
      input: {
        sourcePath: "C:\\docs\\input.pdf",
        fileName: "input.pdf",
        sizeBytes: 2048,
        format: "pdf",
        fingerprint: "sha256:pdf-queue",
      },
      outputPath: "C:\\docs\\input-translated.docx",
      segments: [{
        ...segment(0),
        id: "pdf:3:0",
        location: {
          order: 0,
          part: "page:3",
          page: 3,
          sourcePosition: "page:3:line:0",
        },
        sourceText: "Real page text",
      }],
    };
    const execute: DocumentSegmentExecutor = vi.fn(async text => ({
      text: `translated-${text}`,
      model: "translate-1",
      cached: false,
      usedBackup: false,
    }));

    const completion = await startDocumentTranslationQueue(pdfJob, execution, {
      execute,
      now: () => now,
    }).done;

    expect(completion).toMatchObject({
      status: "ready-to-rebuild",
      job: {
        phase: "rebuilding",
        input: { format: "pdf" },
        segments: [{
          translatedText: "translated-Real page text",
          location: { part: "page:3", page: 3, sourcePosition: "page:3:line:0" },
        }],
      },
    });
    expect(execute).toHaveBeenCalledWith("Real page text", execution, expect.any(AbortSignal));
  });

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
      waitForRetry: async () => {},
    }).done;

    expect(completion.status).toBe("failed");
    expect(completion.job.phase).toBe("failed");
    expect(completion.job.segments[0].status).toBe("translated");
    expect(completion.job.segments[1]).toMatchObject({
      status: "failed",
      error: { code: "translation-failed", retryable: true, segmentId: "segment-1" },
    });
    expect(completion.job.segments[2].status).toBe("translated");
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("retries transient failures with bounded exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const execute: DocumentSegmentExecutor = vi.fn(async (text) => {
      calls += 1;
      if (calls < 3) throw new TranslationRequestError("network", "Offline");
      return { text: `translated-${text}`, model: "translate-1", cached: false, usedBackup: false };
    });
    const completion = await startDocumentTranslationQueue(job(1), execution, {
      execute,
      now: () => now,
      retryBaseDelayMs: 250,
      waitForRetry: async delayMs => { delays.push(delayMs); },
    }).done;

    expect(completion.status).toBe("ready-to-rebuild");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([250, 500]);
    expect(completion.job.segments[0]).toMatchObject({
      status: "translated",
      attempts: 3,
    });
  });

  it("does not retry permanent failures", async () => {
    const execute: DocumentSegmentExecutor = vi.fn(async () => {
      throw new TranslationRequestError("unauthorized", "Invalid key");
    });
    const waitForRetry = vi.fn(async () => {});
    const completion = await startDocumentTranslationQueue(job(1), execution, {
      execute,
      waitForRetry,
      now: () => now,
    }).done;

    expect(completion.status).toBe("failed");
    expect(execute).toHaveBeenCalledOnce();
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("cancels retry backoff without starting another billable request", async () => {
    let retrySignal: AbortSignal | undefined;
    const execute: DocumentSegmentExecutor = vi.fn(async () => {
      throw new TranslationRequestError("rate-limited", "Try later");
    });
    const task = startDocumentTranslationQueue(job(1), execution, {
      execute,
      now: () => now,
      waitForRetry: (_delayMs, signal) => {
        retrySignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Cancelled", "AbortError")), { once: true });
        });
      },
    });
    await vi.waitFor(() => expect(retrySignal).toBeDefined());
    task.cancel();

    const completion = await task.done;
    expect(completion.status).toBe("cancelled");
    expect(execute).toHaveBeenCalledOnce();
    expect(completion.job.segments[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("prepares and executes only retryable failed segments from a recovered job", async () => {
    const recovered = job(3);
    recovered.phase = "failed";
    recovered.error = {
      code: "translation-failed",
      message: "Two segments failed",
      retryable: true,
    };
    recovered.segments = [
      segment(0),
      segment(1),
      segment(2),
    ];
    recovered.segments[0] = {
      ...recovered.segments[0],
      status: "translated",
      translatedText: "already paid",
      attempts: 1,
    };
    recovered.segments[1] = {
      ...recovered.segments[1],
      status: "failed",
      attempts: 2,
      error: {
        code: "translation-failed",
        message: "Offline",
        retryable: true,
        segmentId: "segment-1",
      },
    };
    recovered.segments[2] = {
      ...recovered.segments[2],
      status: "failed",
      attempts: 1,
      error: {
        code: "translation-failed",
        message: "Invalid format",
        retryable: false,
        segmentId: "segment-2",
      },
    };

    const prepared = prepareDocumentJobForFailedSegmentRetry(recovered, now);
    expect(prepared.phase).toBe("ready");
    expect(prepared.error).toBeUndefined();
    expect(prepared.segments[0]).toMatchObject({
      status: "translated",
      translatedText: "already paid",
      attempts: 1,
    });
    expect(prepared.segments[1]).toMatchObject({ status: "pending", attempts: 2 });
    expect(prepared.segments[2]).toMatchObject({ status: "failed", attempts: 1 });

    const execute: DocumentSegmentExecutor = vi.fn(async text => ({
      text: `translated-${text}`,
      model: "translate-1",
      cached: false,
      usedBackup: false,
    }));
    const completion = await startDocumentTranslationQueue(prepared, execution, {
      execute,
      now: () => now,
    }).done;
    expect(completion.status).toBe("failed");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("source-1", execution, expect.any(AbortSignal));
    expect(completion.job.segments[0].translatedText).toBe("already paid");
    expect(completion.job.segments[2].status).toBe("failed");
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
