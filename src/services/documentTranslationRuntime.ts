import {
  DOCUMENT_CHECKPOINT_VERSION,
  saveDocumentCheckpoint,
  transitionDocumentJob,
  type DocumentCheckpoint,
  type DocumentJob,
} from "./documentTranslation";
import { DocumentTranslationTaskRegistry } from "./documentTranslationRegistry";
import type {
  DocumentTranslationQueueProgress,
  DocumentTranslationQueueTask,
} from "./documentTranslationQueue";
import type { PersistentDocumentTranslationQueueOptions } from "./documentTranslationPersistence";
import type { TranslationExecutionSnapshot } from "./translationTask";

export interface PreparedDocumentTask {
  job: DocumentJob;
  execution: TranslationExecutionSnapshot;
}

export type DocumentRunPhase =
  | "idle"
  | "checkpointing"
  | "translating"
  | "cancelling"
  | "ready-to-rebuild"
  | "failed"
  | "cancelled";

export type DocumentRunErrorCode =
  | "storage"
  | "invalid-task"
  | "translation-failed"
  | "unknown";

export interface DocumentRunSnapshot {
  phase: DocumentRunPhase;
  job: DocumentJob | null;
  progress: DocumentTranslationQueueProgress | null;
  errorCode: DocumentRunErrorCode | null;
}

type DocumentCheckpointSink = (checkpoint: DocumentCheckpoint) => Promise<void>;
type Listener = () => void;

interface DocumentTaskRegistry {
  start: (
    job: DocumentJob,
    execution: TranslationExecutionSnapshot,
    options?: PersistentDocumentTranslationQueueOptions,
  ) => DocumentTranslationQueueTask;
  cancel: (jobId: string) => boolean;
}

const EMPTY_SNAPSHOT: DocumentRunSnapshot = Object.freeze({
  phase: "idle",
  job: null,
  progress: null,
  errorCode: null,
});

function runPhase(job: DocumentJob): DocumentRunPhase {
  if (job.phase === "rebuilding") return "ready-to-rebuild";
  if (job.phase === "cancelling") return "cancelling";
  if (job.phase === "cancelled") return "cancelled";
  if (job.phase === "failed") return "failed";
  return "translating";
}

function failedCode(error: unknown): DocumentRunErrorCode {
  if (error instanceof Error && error.name === "DocumentContractError") {
    return "invalid-task";
  }
  return "storage";
}

/**
 * Window-level owner for the current document translation. It survives tab
 * remounts while keeping credentials inside the existing queue closure only.
 */
export class DocumentTranslationRuntime {
  private snapshot: DocumentRunSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<Listener>();
  private activeJobId: string | null = null;
  private cancelBeforeStart = false;

  constructor(
    private readonly registry: DocumentTaskRegistry = new DocumentTranslationTaskRegistry(),
    private readonly saveCheckpoint: DocumentCheckpointSink = saveDocumentCheckpoint,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getSnapshot = (): DocumentRunSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: DocumentRunSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  async start(prepared: PreparedDocumentTask): Promise<void> {
    if (this.activeJobId !== null) return;
    const { job, execution } = prepared;
    this.activeJobId = job.id;
    this.cancelBeforeStart = false;
    this.publish({
      phase: "checkpointing",
      job,
      progress: { completed: 0, failed: 0, total: job.segments.length, active: 0 },
      errorCode: null,
    });

    try {
      await this.saveCheckpoint({ schemaVersion: DOCUMENT_CHECKPOINT_VERSION, job });
      if (this.activeJobId !== job.id) return;
      if (this.cancelBeforeStart) {
        const cancelling = transitionDocumentJob(job, "cancelling", this.now());
        const cancelled = transitionDocumentJob(cancelling, "cancelled", this.now());
        await this.saveCheckpoint({
          schemaVersion: DOCUMENT_CHECKPOINT_VERSION,
          job: cancelled,
        });
        this.activeJobId = null;
        this.publish({
          phase: "cancelled",
          job: cancelled,
          progress: { completed: 0, failed: 0, total: job.segments.length, active: 0 },
          errorCode: null,
        });
        return;
      }

      const task = this.registry.start(job, execution, {
        onJob: (nextJob, progress) => {
          if (this.activeJobId !== job.id) return;
          this.publish({
            phase: runPhase(nextJob),
            job: nextJob,
            progress,
            errorCode: nextJob.phase === "failed" ? "translation-failed" : null,
          });
        },
      });
      void task.done.then(completion => {
        if (this.activeJobId !== job.id) return;
        this.activeJobId = null;
        this.publish({
          phase: runPhase(completion.job),
          job: completion.job,
          progress: {
            completed: completion.job.segments.filter(segment => segment.status === "translated").length,
            failed: completion.job.segments.filter(segment => segment.status === "failed").length,
            total: completion.job.segments.length,
            active: 0,
          },
          errorCode: completion.status === "failed" ? "translation-failed" : null,
        });
      }).catch(error => {
        if (this.activeJobId !== job.id) return;
        this.activeJobId = null;
        this.publish({
          phase: "failed",
          job: this.snapshot.job,
          progress: this.snapshot.progress,
          errorCode: failedCode(error),
        });
      });
    } catch (error) {
      if (this.activeJobId !== job.id) return;
      this.activeJobId = null;
      this.publish({
        phase: "failed",
        job,
        progress: this.snapshot.progress,
        errorCode: failedCode(error),
      });
    }
  }

  cancel(): boolean {
    const jobId = this.activeJobId;
    if (!jobId) return false;
    if (this.snapshot.phase === "checkpointing") {
      this.cancelBeforeStart = true;
      this.publish({ ...this.snapshot, phase: "cancelling" });
      return true;
    }
    return this.registry.cancel(jobId);
  }
}

export const documentTranslationRuntime = new DocumentTranslationRuntime();

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    documentTranslationRuntime.cancel();
  });
}
