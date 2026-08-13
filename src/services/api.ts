export {
  detectSpeechLocale,
  inspectSpeechAudio,
  resolveEdgeVoice,
} from "./speechQuality";
export { speak } from "./speech";
export type { TranslationErrorCode } from "./translationProvider";
export { testTranslationConnection } from "./translationTransport";
export type { ConnectionTestResult } from "./translationTransport";
export {
  startTranslationComparisonTask,
  translateCompare,
  translateStreaming,
} from "./translationComparison";
export type {
  ComparisonSide,
  ComparisonSidePhase,
  ComparisonSideState,
  TranslationComparisonCallbacks,
  TranslationComparisonResult,
  TranslationComparisonTask,
} from "./translationComparison";
export {
  buildTranslationCacheContext,
  buildTranslationMessages,
  executeTranslationWithSnapshot,
  loadTranslationExecutionSnapshot,
  selectRelevantGlossary,
  startTranslationTask,
} from "./translationTask";
export { startDocumentTranslationQueue } from "./documentTranslationQueue";
export type {
  DocumentSegmentExecutor,
  DocumentTranslationQueueCompletion,
  DocumentTranslationQueueOptions,
  DocumentTranslationQueueProgress,
  DocumentTranslationQueueTask,
} from "./documentTranslationQueue";
export type {
  GlossaryEntry,
  TranslationExecutionCallbacks,
  TranslationExecutionSnapshot,
  TranslationPhase,
  TranslationRuntimeProvider,
  TranslationTask,
  TranslationTaskCallbacks,
  TranslationTaskCompletion,
  TranslationTaskResult,
  TranslationTaskState,
} from "./translationTask";
