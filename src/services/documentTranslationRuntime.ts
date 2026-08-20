import {
  cancelDocxRebuild,
  createDocxRebuildPlan,
  createPdfDocxExportPlan,
  DOCUMENT_CHECKPOINT_VERSION,
  DocumentContractError,
  exportPdfTranslationDocx,
  inspectDocxDocument,
  inspectPdfDocument,
  rebuildDocxDocument,
  saveDocumentCheckpoint,
  parseDocumentCheckpoint,
  transitionDocumentJob,
  type DocumentCheckpoint,
  type DocxInspection,
  type DocxRebuildPlan,
  type DocxRebuildResult,
  type DocumentJob,
  type PdfDocxExportPlan,
  type PdfInspection,
} from "./documentTranslation";
import { DocumentTranslationTaskRegistry } from "./documentTranslationRegistry";
import type {
  DocumentTranslationQueueProgress,
  DocumentTranslationQueueTask,
} from "./documentTranslationQueue";
import {
  assertDocumentExecutionSnapshotMatches,
  prepareDocumentJobForFailedSegmentRetry,
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
  | "rebuilding"
  | "exporting"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type DocumentRunErrorCode =
  | "storage"
  | "invalid-task"
  | "translation-failed"
  | "rebuild-failed"
  | "unknown";

export interface DocumentRunSnapshot {
  phase: DocumentRunPhase;
  job: DocumentJob | null;
  progress: DocumentTranslationQueueProgress | null;
  errorCode: DocumentRunErrorCode | null;
}

type DocumentCheckpointSink = (checkpoint: DocumentCheckpoint) => Promise<void>;
type DocumentInspectionSource = (path: string) => Promise<DocxInspection>;
type DocumentRebuildSink = (jobId: string, plan: DocxRebuildPlan) => Promise<DocxRebuildResult>;
type PdfInspectionSource = (path: string) => Promise<PdfInspection>;
type PdfExportSink = (jobId: string, plan: PdfDocxExportPlan) => Promise<DocxRebuildResult>;
type DocumentRebuildCancellation = (jobId: string) => Promise<boolean>;
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
  if (job.phase === "rebuilding") return "rebuilding";
  if (job.phase === "exporting") return "exporting";
  if (job.phase === "completed") return "completed";
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
  private rebuildCancelRequested = false;

  constructor(
    private readonly registry: DocumentTaskRegistry = new DocumentTranslationTaskRegistry(),
    private readonly saveCheckpoint: DocumentCheckpointSink = saveDocumentCheckpoint,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly inspect: DocumentInspectionSource = inspectDocxDocument,
    private readonly rebuild: DocumentRebuildSink = rebuildDocxDocument,
    private readonly cancelRebuild: DocumentRebuildCancellation = cancelDocxRebuild,
    private readonly inspectPdf: PdfInspectionSource = inspectPdfDocument,
    private readonly exportPdf: PdfExportSink = exportPdfTranslationDocx,
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

  private progress(job: DocumentJob): DocumentTranslationQueueProgress {
    return {
      completed: job.segments.filter(segment => segment.status === "translated").length,
      failed: job.segments.filter(segment => segment.status === "failed").length,
      total: job.segments.length,
      active: 0,
    };
  }

  private async finishCancelled(job: DocumentJob): Promise<void> {
    const cancelling = transitionDocumentJob(job, "cancelling", this.now());
    const cancelled = transitionDocumentJob(cancelling, "cancelled", this.now());
    await this.saveCheckpoint({ schemaVersion: DOCUMENT_CHECKPOINT_VERSION, job: cancelled });
    if (this.activeJobId !== job.id) return;
    this.activeJobId = null;
    this.publish({ phase: "cancelled", job: cancelled, progress: this.progress(cancelled), errorCode: null });
  }

  private async finishRebuild(sourceJob: DocumentJob): Promise<void> {
    const jobId = sourceJob.id;
    try {
      this.publish({ phase: "rebuilding", job: sourceJob, progress: this.progress(sourceJob), errorCode: null });
      const inspection = sourceJob.input.format === "pdf"
        ? await this.inspectPdf(sourceJob.input.sourcePath)
        : await this.inspect(sourceJob.input.sourcePath);
      if (this.activeJobId !== jobId) return;
      if (this.rebuildCancelRequested) {
        await this.finishCancelled(sourceJob);
        return;
      }
      if (!sourceJob.outputPath) {
        throw new DocumentContractError("rebuild-failed", "DOCX output path is missing");
      }
      const plan = sourceJob.input.format === "pdf"
        ? createPdfDocxExportPlan(sourceJob, inspection as PdfInspection, sourceJob.outputPath)
        : createDocxRebuildPlan(sourceJob, inspection as DocxInspection, sourceJob.outputPath);
      const exporting = transitionDocumentJob(sourceJob, "exporting", this.now());
      await this.saveCheckpoint({ schemaVersion: DOCUMENT_CHECKPOINT_VERSION, job: exporting });
      if (this.activeJobId !== jobId) return;
      if (this.rebuildCancelRequested) {
        await this.finishCancelled(exporting);
        return;
      }
      this.publish({ phase: "exporting", job: exporting, progress: this.progress(exporting), errorCode: null });
      const result = sourceJob.input.format === "pdf"
        ? await this.exportPdf(jobId, plan as PdfDocxExportPlan)
        : await this.rebuild(jobId, plan as DocxRebuildPlan);
      if (this.activeJobId !== jobId) return;
      const completed = transitionDocumentJob(
        { ...exporting, outputPath: result.outputPath },
        "completed",
        this.now(),
      );
      try {
        await this.saveCheckpoint({ schemaVersion: DOCUMENT_CHECKPOINT_VERSION, job: completed });
      } catch {
        // The atomically published output is authoritative even if final checkpoint cleanup fails.
      }
      if (this.activeJobId !== jobId) return;
      this.activeJobId = null;
      this.publish({ phase: "completed", job: completed, progress: this.progress(completed), errorCode: null });
    } catch (error) {
      if (this.activeJobId !== jobId) return;
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && String((error as { code?: unknown }).code) === "cancelled"
      ) {
        const current = this.snapshot.job ?? sourceJob;
        await this.finishCancelled(current.phase === "exporting" ? current : sourceJob);
        return;
      }
      const current = this.snapshot.job ?? sourceJob;
      const failed = {
        ...transitionDocumentJob(current, "failed", this.now()),
        error: {
          code: "rebuild-failed" as const,
          message: "DOCX rebuild or export failed",
          retryable: true,
        },
      };
      try {
        await this.saveCheckpoint({ schemaVersion: DOCUMENT_CHECKPOINT_VERSION, job: failed });
      } catch {
        // The stable runtime error below must not expose storage or source-path details.
      }
      if (this.activeJobId !== jobId) return;
      this.activeJobId = null;
      this.publish({ phase: "failed", job: failed, progress: this.progress(failed), errorCode: "rebuild-failed" });
    }
  }

  async start(prepared: PreparedDocumentTask): Promise<void> {
    if (this.activeJobId !== null) return;
    const { job, execution } = prepared;
    this.activeJobId = job.id;
    this.cancelBeforeStart = false;
    this.rebuildCancelRequested = false;
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
      void task.done.then(async completion => {
        if (this.activeJobId !== job.id) return;
        if (completion.status === "ready-to-rebuild") {
          await this.finishRebuild(completion.job);
          return;
        }
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

  /**
   * Re-enters the existing queue from a persisted checkpoint. Current runtime
   * credentials are accepted only when every non-secret setting still matches.
   */
  async resume(
    sourceCheckpoint: DocumentCheckpoint,
    execution: TranslationExecutionSnapshot,
  ): Promise<boolean> {
    if (this.activeJobId !== null) return false;
    const checkpoint = parseDocumentCheckpoint(sourceCheckpoint);
    assertDocumentExecutionSnapshotMatches(checkpoint.job, execution);
    const job = checkpoint.job.phase === "failed"
      ? prepareDocumentJobForFailedSegmentRetry(checkpoint.job, this.now())
      : checkpoint.job;
    if (job.phase !== "ready") {
      throw new DocumentContractError(
        "checkpoint-invalid",
        `Document checkpoint cannot resume translation from ${job.phase}`,
      );
    }
    await this.start({ job, execution });
    return true;
  }

  async resumeRebuild(sourceCheckpoint: DocumentCheckpoint): Promise<boolean> {
    if (this.activeJobId !== null) return false;
    const checkpoint = parseDocumentCheckpoint(sourceCheckpoint);
    if (
      checkpoint.job.phase !== "translating"
      || !checkpoint.job.outputPath
      || checkpoint.job.segments.some(segment => segment.status !== "translated")
    ) {
      throw new DocumentContractError(
        "checkpoint-invalid",
        "Document checkpoint is not ready to resume rebuild",
      );
    }
    const rebuilding = transitionDocumentJob(checkpoint.job, "rebuilding", this.now());
    this.activeJobId = rebuilding.id;
    this.rebuildCancelRequested = false;
    try {
      await this.saveCheckpoint({ schemaVersion: DOCUMENT_CHECKPOINT_VERSION, job: rebuilding });
    } catch (error) {
      this.activeJobId = null;
      throw error;
    }
    void this.finishRebuild(rebuilding);
    return true;
  }

  cancel(): boolean {
    const jobId = this.activeJobId;
    if (!jobId) return false;
    if (this.snapshot.phase === "checkpointing") {
      this.cancelBeforeStart = true;
      this.publish({ ...this.snapshot, phase: "cancelling" });
      return true;
    }
    if (this.snapshot.phase === "rebuilding" || this.snapshot.phase === "exporting") {
      const phase = this.snapshot.phase;
      this.rebuildCancelRequested = true;
      this.publish({ ...this.snapshot, phase: "cancelling" });
      if (phase === "exporting") void this.cancelRebuild(jobId).catch(() => false);
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
