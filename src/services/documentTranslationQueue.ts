import {
  DOCUMENT_CHECKPOINT_VERSION,
  DocumentContractError,
  documentProgress,
  documentSnapshotFromExecution,
  parseDocumentCheckpoint,
  transitionDocumentJob,
  transitionDocumentSegment,
  type DocumentError,
  type DocumentJob,
} from "./documentTranslation";
import {
  executeTranslationWithSnapshot,
  type TranslationExecutionSnapshot,
  type TranslationTaskResult,
} from "./translationTask";
import {
  normalizeTranslationError,
  type TranslationErrorCode,
} from "./translationProvider";

export interface DocumentTranslationQueueProgress {
  completed: number;
  failed: number;
  total: number;
  active: number;
}

export type DocumentSegmentExecutor = (
  text: string,
  snapshot: TranslationExecutionSnapshot,
  signal: AbortSignal,
) => Promise<TranslationTaskResult>;

export interface DocumentTranslationQueueOptions {
  execute?: DocumentSegmentExecutor;
  now?: () => string;
  onJob?: (
    job: DocumentJob,
    progress: DocumentTranslationQueueProgress,
  ) => void;
}

export type DocumentTranslationQueueCompletion =
  | { status: "ready-to-rebuild"; job: DocumentJob }
  | { status: "failed"; job: DocumentJob }
  | { status: "cancelled"; job: DocumentJob };

export interface DocumentTranslationQueueTask {
  cancel: () => void;
  done: Promise<DocumentTranslationQueueCompletion>;
}

const RETRYABLE_CODES: ReadonlySet<TranslationErrorCode> = new Set([
  "rate-limited",
  "timeout",
  "network",
  "server",
]);
const MAX_CHECKPOINT_ERROR_BYTES = 4 * 1024;

function boundedErrorMessage(message: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(message).byteLength <= MAX_CHECKPOINT_ERROR_BYTES) {
    return message;
  }
  let result = "";
  let usedBytes = 0;
  for (const character of message) {
    const characterBytes = encoder.encode(character).byteLength;
    if (usedBytes + characterBytes > MAX_CHECKPOINT_ERROR_BYTES) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function cloneAndValidateJob(job: DocumentJob): DocumentJob {
  const checkpoint = JSON.parse(JSON.stringify({
    schemaVersion: DOCUMENT_CHECKPOINT_VERSION,
    job,
  })) as unknown;
  return parseDocumentCheckpoint(checkpoint).job;
}

function assertSnapshotMatches(
  job: DocumentJob,
  execution: TranslationExecutionSnapshot,
): void {
  const persistable = documentSnapshotFromExecution(execution);
  if (JSON.stringify(job.snapshot) !== JSON.stringify(persistable)) {
    throw new DocumentContractError(
      "checkpoint-invalid",
      "Runtime translation settings do not match the frozen document snapshot",
    );
  }
}

function segmentError(error: unknown, segmentId: string): DocumentError {
  const normalized = normalizeTranslationError(error);
  return {
    code: "translation-failed",
    message: boundedErrorMessage(normalized.message),
    retryable: RETRYABLE_CODES.has(normalized.code),
    segmentId,
  };
}

function isCancellation(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Runs only the document translation stage. Reconstruction, persistence
 * throttling, retry policy and UI ownership deliberately remain outside.
 */
export function startDocumentTranslationQueue(
  sourceJob: DocumentJob,
  execution: TranslationExecutionSnapshot,
  options: DocumentTranslationQueueOptions = {},
): DocumentTranslationQueueTask {
  let job = cloneAndValidateJob(sourceJob);
  if (job.phase !== "ready") {
    throw new DocumentContractError(
      "checkpoint-invalid",
      `Document translation requires a ready job, received ${job.phase}`,
    );
  }
  assertSnapshotMatches(job, execution);

  const now = options.now ?? (() => new Date().toISOString());
  const execute = options.execute ?? ((text, snapshot, signal) =>
    executeTranslationWithSnapshot(text, snapshot, {}, signal));
  const controller = new AbortController();
  let active = 0;
  let nextIndex = 0;
  let settled = false;

  const emit = () => {
    options.onJob?.(job, { ...documentProgress(job), active });
  };
  const updateSegment = (
    index: number,
    segment: DocumentJob["segments"][number],
  ) => {
    const segments = job.segments.slice();
    segments[index] = segment;
    job = { ...job, segments, updatedAt: now() };
    emit();
  };

  job = transitionDocumentJob(job, "translating", now());
  emit();

  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= job.segments.length) return;
      const segment = job.segments[index];
      if (segment.status !== "pending") continue;

      updateSegment(index, transitionDocumentSegment(segment, "translating"));
      active += 1;
      emit();
      try {
        const result = await execute(
          segment.sourceText,
          execution,
          controller.signal,
        );
        if (controller.signal.aborted) {
          updateSegment(
            index,
            transitionDocumentSegment(job.segments[index], "pending"),
          );
          return;
        }
        updateSegment(
          index,
          transitionDocumentSegment(job.segments[index], "translated", {
            translatedText: result.text,
          }),
        );
      } catch (error) {
        if (isCancellation(controller.signal)) {
          updateSegment(
            index,
            transitionDocumentSegment(job.segments[index], "pending"),
          );
          return;
        }
        updateSegment(
          index,
          transitionDocumentSegment(job.segments[index], "failed", {
            error: segmentError(error, segment.id),
          }),
        );
      } finally {
        active -= 1;
        emit();
      }
    }
  };

  const done = (async (): Promise<DocumentTranslationQueueCompletion> => {
    await Promise.all(Array.from({ length: job.concurrency }, () => worker()));
    if (controller.signal.aborted) {
      job = transitionDocumentJob(job, "cancelled", now());
      settled = true;
      emit();
      return { status: "cancelled", job };
    }
    const failed = job.segments.filter(segment => segment.status === "failed");
    if (failed.length > 0) {
      job = {
        ...transitionDocumentJob(job, "failed", now()),
        error: {
          code: "translation-failed",
          message: `${failed.length} document segment(s) failed to translate`,
          retryable: failed.some(segment => segment.error?.retryable),
        },
      };
      settled = true;
      emit();
      return { status: "failed", job };
    }
    if (job.segments.some(segment => segment.status !== "translated")) {
      job = {
        ...transitionDocumentJob(job, "failed", now()),
        error: {
          code: "translation-failed",
          message: "Document translation stopped before every segment completed",
          retryable: true,
        },
      };
      settled = true;
      emit();
      return { status: "failed", job };
    }
    job = transitionDocumentJob(job, "rebuilding", now());
    settled = true;
    emit();
    return { status: "ready-to-rebuild", job };
  })();

  return {
    cancel: () => {
      if (settled || controller.signal.aborted) return;
      job = transitionDocumentJob(job, "cancelling", now());
      emit();
      controller.abort();
    },
    done,
  };
}
