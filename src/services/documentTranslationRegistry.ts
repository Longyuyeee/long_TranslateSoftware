import { DocumentContractError, type DocumentJob } from "./documentTranslation";
import {
  startPersistentDocumentTranslationQueue,
  type PersistentDocumentTranslationQueueOptions,
} from "./documentTranslationPersistence";
import type {
  DocumentTranslationQueueCompletion,
  DocumentTranslationQueueTask,
} from "./documentTranslationQueue";
import type { TranslationExecutionSnapshot } from "./translationTask";

/** Owns document tasks so lifecycle cleanup and duplicate prevention share one boundary. */
export class DocumentTranslationTaskRegistry {
  private readonly tasks = new Map<string, DocumentTranslationQueueTask>();

  get size(): number {
    return this.tasks.size;
  }

  has(jobId: string): boolean {
    return this.tasks.has(jobId);
  }

  start(
    job: DocumentJob,
    execution: TranslationExecutionSnapshot,
    options: PersistentDocumentTranslationQueueOptions = {},
  ): DocumentTranslationQueueTask {
    if (this.tasks.has(job.id)) {
      throw new DocumentContractError(
        "checkpoint-invalid",
        `Document job is already running: ${job.id}`,
      );
    }
    const task = startPersistentDocumentTranslationQueue(job, execution, options);
    let trackedTask: DocumentTranslationQueueTask;
    const done = task.done.finally(() => {
      if (this.tasks.get(job.id) === trackedTask) this.tasks.delete(job.id);
    }) as Promise<DocumentTranslationQueueCompletion>;
    trackedTask = {
      cancel: task.cancel,
      done,
    };
    this.tasks.set(job.id, trackedTask);
    return trackedTask;
  }

  cancel(jobId: string): boolean {
    const task = this.tasks.get(jobId);
    if (!task) return false;
    task.cancel();
    return true;
  }

  /** Call from the owning UI/window cleanup path before it releases task state. */
  cancelAll(): number {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.cancel();
    return tasks.length;
  }
}
