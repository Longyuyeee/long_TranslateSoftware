import { describe, expect, it, vi } from "vitest";
import type { DocumentCheckpoint, DocumentJob } from "./documentTranslation";
import type { PersistentDocumentTranslationQueueOptions } from "./documentTranslationPersistence";
import type { DocumentTranslationQueueCompletion } from "./documentTranslationQueue";
import {
  DocumentTranslationRuntime,
  type PreparedDocumentTask,
} from "./documentTranslationRuntime";

const now = "2026-08-14T00:00:00.000Z";

function preparedTask(): PreparedDocumentTask {
  const job: DocumentJob = {
    id: "document-runtime",
    phase: "ready",
    input: {
      sourcePath: "C:\\private\\source.docx",
      fileName: "source.docx",
      sizeBytes: 1024,
      format: "docx",
      fingerprint: "sha256:runtime",
    },
    outputMode: "translated",
    outputPath: "C:\\private\\translated.docx",
    snapshot: {
      sourceLanguage: "auto",
      targetLanguage: "Chinese",
      primary: { baseUrl: "https://api.example.com/v1", model: "translate-1" },
      customPrompt: "",
      glossary: [],
    },
    concurrency: 1,
    segments: [{
      id: "segment-1",
      location: { order: 0, part: "word/document.xml" },
      structure: "paragraph",
      sourceText: "Hello",
      status: "pending",
      attempts: 0,
    }],
    createdAt: now,
    updatedAt: now,
  };
  return {
    job,
    execution: {
      primary: {
        apiKey: "runtime-secret",
        baseUrl: "https://api.example.com/v1",
        model: "translate-1",
      },
      sourceLang: "auto",
      targetLang: "Chinese",
      customPrompt: "",
      glossary: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("document translation runtime", () => {
  it("durably saves the ready job before starting and publishes progress across subscribers", async () => {
    const saves = vi.fn<(checkpoint: DocumentCheckpoint) => Promise<void>>(async () => {});
    const completion = deferred<DocumentTranslationQueueCompletion>();
    let options: PersistentDocumentTranslationQueueOptions | undefined;
    const registry = {
      start: vi.fn((_job: DocumentJob, _execution: unknown, nextOptions?: PersistentDocumentTranslationQueueOptions) => {
        options = nextOptions;
        return { cancel: vi.fn(), done: completion.promise };
      }),
      cancel: vi.fn(() => true),
    };
    const runtime = new DocumentTranslationRuntime(registry, saves, () => now);
    const prepared = preparedTask();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);

    await runtime.start(prepared);

    expect(saves).toHaveBeenCalledOnce();
    expect(registry.start).toHaveBeenCalledOnce();
    expect(saves.mock.invocationCallOrder[0]).toBeLessThan(
      registry.start.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(saves.mock.calls[0][0])).not.toContain("runtime-secret");

    const translating = { ...prepared.job, phase: "translating" as const };
    options?.onJob?.(translating, { completed: 0, failed: 0, total: 1, active: 1 });
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "translating",
      progress: { completed: 0, total: 1, active: 1 },
    });

    unsubscribe();
    const remountedListener = vi.fn();
    runtime.subscribe(remountedListener);
    const rebuilding = {
      ...translating,
      phase: "rebuilding" as const,
      segments: [{ ...translating.segments[0], status: "translated" as const, translatedText: "你好" }],
    };
    completion.resolve({ status: "ready-to-rebuild", job: rebuilding });
    await completion.promise;
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe("ready-to-rebuild"));
    expect(remountedListener).toHaveBeenCalled();
  });

  it("cancels during the initial checkpoint without starting a network queue", async () => {
    const firstSave = deferred<void>();
    const saves = vi.fn<(checkpoint: DocumentCheckpoint) => Promise<void>>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined);
    const registry = {
      start: vi.fn(),
      cancel: vi.fn(() => true),
    };
    const runtime = new DocumentTranslationRuntime(registry, saves, () => now);
    const started = runtime.start(preparedTask());

    expect(runtime.cancel()).toBe(true);
    expect(runtime.getSnapshot().phase).toBe("cancelling");
    firstSave.resolve();
    await started;

    expect(registry.start).not.toHaveBeenCalled();
    expect(saves).toHaveBeenCalledTimes(2);
    expect(saves.mock.calls[1][0].job.phase).toBe("cancelled");
    expect(runtime.getSnapshot().phase).toBe("cancelled");
  });

  it("fails closed when the initial checkpoint cannot be saved", async () => {
    const registry = { start: vi.fn(), cancel: vi.fn(() => true) };
    const runtime = new DocumentTranslationRuntime(
      registry,
      async () => { throw new Error("private disk path"); },
      () => now,
    );

    await runtime.start(preparedTask());

    expect(registry.start).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({ phase: "failed", errorCode: "storage" });
    expect(runtime.getSnapshot()).not.toHaveProperty("message");
  });

  it("validates current settings before saving or resuming a checkpoint", async () => {
    const saves = vi.fn<(checkpoint: DocumentCheckpoint) => Promise<void>>(async () => {});
    const completion = deferred<DocumentTranslationQueueCompletion>();
    const registry = {
      start: vi.fn((_job: DocumentJob) => ({ cancel: vi.fn(), done: completion.promise })),
      cancel: vi.fn(() => true),
    };
    const runtime = new DocumentTranslationRuntime(registry, saves, () => now);
    const prepared = preparedTask();
    const checkpoint = { schemaVersion: 1 as const, job: prepared.job };
    const mismatched = {
      ...prepared.execution,
      primary: { ...prepared.execution.primary, model: "changed-model" },
    };

    await expect(runtime.resume(checkpoint, mismatched)).rejects.toThrow(
      "do not match the frozen document snapshot",
    );
    expect(saves).not.toHaveBeenCalled();
    expect(registry.start).not.toHaveBeenCalled();
    expect(checkpoint.job.phase).toBe("ready");

    await expect(runtime.resume(checkpoint, prepared.execution)).resolves.toBe(true);
    expect(saves).toHaveBeenCalledOnce();
    expect(registry.start).toHaveBeenCalledOnce();
    expect(JSON.stringify(saves.mock.calls[0][0])).not.toContain("runtime-secret");
  });

  it("prepares only retryable failed segments before re-entering the existing queue", async () => {
    const saves = vi.fn<(checkpoint: DocumentCheckpoint) => Promise<void>>(async () => {});
    const completion = deferred<DocumentTranslationQueueCompletion>();
    const registry = {
      start: vi.fn((_job: DocumentJob) => ({ cancel: vi.fn(), done: completion.promise })),
      cancel: vi.fn(() => true),
    };
    const runtime = new DocumentTranslationRuntime(registry, saves, () => now);
    const prepared = preparedTask();
    const translated = {
      ...prepared.job.segments[0],
      id: "translated",
      status: "translated" as const,
      translatedText: "Done",
    };
    const retryable = {
      ...prepared.job.segments[0],
      id: "retryable",
      location: { ...prepared.job.segments[0].location, order: 1 },
      status: "failed" as const,
      error: {
        code: "translation-failed" as const,
        message: "timeout detail",
        retryable: true,
        segmentId: "retryable",
      },
    };
    const permanent = {
      ...prepared.job.segments[0],
      id: "permanent",
      location: { ...prepared.job.segments[0].location, order: 2 },
      status: "failed" as const,
      error: {
        code: "translation-failed" as const,
        message: "permanent detail",
        retryable: false,
        segmentId: "permanent",
      },
    };
    const failedJob: DocumentJob = {
      ...prepared.job,
      phase: "failed",
      segments: [translated, retryable, permanent],
      error: { code: "translation-failed", message: "private failure", retryable: true },
    };

    await expect(runtime.resume(
      { schemaVersion: 1, job: failedJob },
      prepared.execution,
    )).resolves.toBe(true);

    const resumed = registry.start.mock.calls[0][0];
    expect(resumed.phase).toBe("ready");
    expect(resumed.error).toBeUndefined();
    expect(resumed.segments.map(segment => segment.status)).toEqual([
      "translated",
      "pending",
      "failed",
    ]);
    expect(resumed.segments[0].translatedText).toBe("Done");
    expect(resumed.segments[2].error?.retryable).toBe(false);
    expect(failedJob.phase).toBe("failed");
    expect(saves.mock.calls[0][0].job).toEqual(resumed);
  });
});
