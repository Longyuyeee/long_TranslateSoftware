import {
  DOCUMENT_CHECKPOINT_VERSION,
  parseDocumentCheckpoint,
  saveDocumentCheckpoint,
  type DocumentCheckpoint,
  type DocumentJob,
} from "./documentTranslation";
import {
  startDocumentTranslationQueue,
  type DocumentTranslationQueueCompletion,
  type DocumentTranslationQueueOptions,
  type DocumentTranslationQueueTask,
} from "./documentTranslationQueue";
import type { TranslationExecutionSnapshot } from "./translationTask";

export const DOCUMENT_CHECKPOINT_THROTTLE_MS = 500;

export type DocumentCheckpointSink = (
  checkpoint: DocumentCheckpoint,
) => Promise<void>;

export interface DocumentCheckpointWriter {
  schedule: (job: DocumentJob) => void;
  flush: (job?: DocumentJob) => Promise<void>;
  close: () => void;
}

export interface DocumentCheckpointWriterOptions {
  intervalMs?: number;
  save?: DocumentCheckpointSink;
  onError?: (error: unknown) => void;
}

function checkpointFor(job: DocumentJob): DocumentCheckpoint {
  return parseDocumentCheckpoint(JSON.parse(JSON.stringify({
    schemaVersion: DOCUMENT_CHECKPOINT_VERSION,
    job,
  })) as unknown);
}

/** Coalesces rapid state changes while keeping checkpoint writes serialized. */
export function createDocumentCheckpointWriter(
  options: DocumentCheckpointWriterOptions = {},
): DocumentCheckpointWriter {
  const intervalMs = options.intervalMs ?? DOCUMENT_CHECKPOINT_THROTTLE_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError("Checkpoint throttle interval must be non-negative");
  }
  const save = options.save ?? saveDocumentCheckpoint;
  let pending: DocumentCheckpoint | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  let failure: unknown;
  let closed = false;

  const enqueue = () => {
    timer = undefined;
    const checkpoint = pending;
    pending = undefined;
    if (!checkpoint || failure !== undefined) return;
    chain = chain.then(async () => {
      if (failure !== undefined) return;
      try {
        await save(checkpoint);
      } catch (error) {
        failure = error;
        options.onError?.(error);
      }
    });
  };

  const schedule = (job: DocumentJob) => {
    if (closed) throw new Error("Document checkpoint writer is closed");
    if (failure !== undefined) return;
    pending = checkpointFor(job);
    if (timer === undefined) timer = setTimeout(enqueue, intervalMs);
  };

  const flush = async (job?: DocumentJob) => {
    if (job) pending = checkpointFor(job);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (pending && failure === undefined) {
      enqueue();
      await chain;
    }
    await chain;
    if (failure !== undefined) throw failure;
  };

  return {
    schedule,
    flush,
    close: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      closed = true;
    },
  };
}

export interface PersistentDocumentTranslationQueueOptions
  extends DocumentTranslationQueueOptions {
  checkpointIntervalMs?: number;
  saveCheckpoint?: DocumentCheckpointSink;
}

/** Adds durable, throttled checkpoints around the pure translation scheduler. */
export function startPersistentDocumentTranslationQueue(
  job: DocumentJob,
  execution: TranslationExecutionSnapshot,
  options: PersistentDocumentTranslationQueueOptions = {},
): DocumentTranslationQueueTask {
  let queue: DocumentTranslationQueueTask | undefined;
  let cancelWhenReady = false;
  const writer = createDocumentCheckpointWriter({
    intervalMs: options.checkpointIntervalMs,
    save: options.saveCheckpoint,
    onError: () => {
      if (queue) queue.cancel();
      else cancelWhenReady = true;
    },
  });
  const { checkpointIntervalMs: _interval, saveCheckpoint: _save, ...queueOptions } = options;
  queue = startDocumentTranslationQueue(job, execution, {
    ...queueOptions,
    onJob: (nextJob, progress) => {
      writer.schedule(nextJob);
      options.onJob?.(nextJob, progress);
    },
  });
  if (cancelWhenReady) queue.cancel();

  const done = (async (): Promise<DocumentTranslationQueueCompletion> => {
    try {
      const completion = await queue.done;
      await writer.flush(completion.job);
      return completion;
    } finally {
      writer.close();
    }
  })();

  return {
    cancel: () => queue?.cancel(),
    done,
  };
}
