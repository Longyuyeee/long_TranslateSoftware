import type {
  GlossaryEntry,
  TranslationExecutionSnapshot,
} from "./translationTask";
import { invoke } from "@tauri-apps/api/core";

export const DOCUMENT_CHECKPOINT_VERSION = 1 as const;
export const DOCUMENT_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const DOCUMENT_MAX_SEGMENT_BYTES = 32 * 1024;
export const DOCUMENT_MAX_SEGMENTS = 20_000;
export const DOCUMENT_MAX_SOURCE_TEXT_BYTES = 24 * 1024 * 1024;
export const DOCUMENT_MAX_TRANSLATED_TEXT_BYTES = 24 * 1024 * 1024;
export const DOCUMENT_DEFAULT_CONCURRENCY = 3;
export const DOCUMENT_MAX_CONCURRENCY = 8;

export type DocumentFormat = "docx" | "pdf";
export type DocumentOutputMode = "translated" | "bilingual";
export type DocumentJobPhase =
  | "created"
  | "inspecting"
  | "parsing"
  | "ready"
  | "translating"
  | "rebuilding"
  | "exporting"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export type DocumentSegmentStatus =
  | "pending"
  | "translating"
  | "translated"
  | "failed";

export type DocumentStructureKind =
  | "paragraph"
  | "heading"
  | "list-item"
  | "table-cell"
  | "header"
  | "footer";

export type DocumentErrorCode =
  | "unsupported-format"
  | "input-too-large"
  | "invalid-input"
  | "encrypted-pdf"
  | "text-layer-required"
  | "parse-failed"
  | "translation-failed"
  | "rebuild-failed"
  | "export-failed"
  | "checkpoint-invalid";

export interface DocumentError {
  code: DocumentErrorCode;
  message: string;
  retryable: boolean;
  segmentId?: string;
}

export interface DocumentProviderSnapshot {
  baseUrl: string;
  model: string;
}

/** Deliberately excludes API keys and every unrelated desktop setting. */
export interface DocumentTranslationSnapshot {
  sourceLanguage: string;
  targetLanguage: string;
  primary: DocumentProviderSnapshot;
  backup?: DocumentProviderSnapshot;
  customPrompt: string;
  glossary: GlossaryEntry[];
}

export interface DocumentInput {
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  format: DocumentFormat;
  fingerprint: string;
}

export interface DocumentSegmentLocation {
  order: number;
  part: string;
  page?: number;
  sourcePosition?: string;
}

export interface DocumentSegment {
  id: string;
  location: DocumentSegmentLocation;
  structure: DocumentStructureKind;
  sourceText: string;
  translatedText?: string;
  status: DocumentSegmentStatus;
  attempts: number;
  error?: DocumentError;
}

export interface DocumentJob {
  id: string;
  phase: DocumentJobPhase;
  input: DocumentInput;
  outputMode: DocumentOutputMode;
  outputPath?: string;
  snapshot: DocumentTranslationSnapshot;
  concurrency: number;
  segments: DocumentSegment[];
  error?: DocumentError;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentCheckpoint {
  schemaVersion: typeof DOCUMENT_CHECKPOINT_VERSION;
  job: DocumentJob;
}

export interface DocxImportSegment {
  id: string;
  order: number;
  part: string;
  sourcePosition: string;
  structure: DocumentStructureKind;
  sourceText: string;
}

export interface DocxImportWarning {
  code:
    | "comments-ignored"
    | "images-ignored"
    | "embedded-objects-unsupported"
    | "revisions-degraded"
    | "formulas-ignored"
    | "text-boxes-unsupported"
    | "fields-degraded";
  message: string;
}

export interface DocxImportCommandError {
  code: "unsupported-format" | "input-too-large" | "invalid-input" | "parse-failed";
  message: string;
}

export interface DocumentCheckpointCommandError {
  code: "checkpoint-invalid" | "storage";
  message: string;
}

export interface DocxInspection {
  fingerprint: string;
  fileName: string;
  sizeBytes: number;
  segments: DocxImportSegment[];
  warnings: DocxImportWarning[];
}

export async function inspectDocxDocument(path: string): Promise<DocxInspection> {
  return invoke<DocxInspection>("inspect_docx_document", { path });
}

export async function saveDocumentCheckpoint(
  checkpoint: DocumentCheckpoint,
): Promise<void> {
  const validated = parseDocumentCheckpoint(checkpoint);
  return invoke<void>("save_document_checkpoint", { checkpoint: validated });
}

export async function loadDocumentCheckpoint(jobId: string): Promise<DocumentCheckpoint> {
  const checkpoint = await invoke<DocumentCheckpoint>("load_document_checkpoint", {
    jobId,
  });
  return parseDocumentCheckpoint(checkpoint);
}

export async function deleteDocumentCheckpoint(jobId: string): Promise<void> {
  return invoke<void>("delete_document_checkpoint", { jobId });
}

export function documentSegmentsFromDocx(
  inspection: DocxInspection,
): DocumentSegment[] {
  return inspection.segments.map(segment => ({
    id: segment.id,
    location: {
      order: segment.order,
      part: segment.part,
      sourcePosition: segment.sourcePosition,
    },
    structure: segment.structure,
    sourceText: segment.sourceText,
    status: "pending",
    attempts: 0,
  }));
}

/** Produces the persistable task summary without copying runtime credentials. */
export function documentSnapshotFromExecution(
  snapshot: TranslationExecutionSnapshot,
): DocumentTranslationSnapshot {
  return {
    sourceLanguage: snapshot.sourceLang,
    targetLanguage: snapshot.targetLang,
    primary: {
      baseUrl: snapshot.primary.baseUrl,
      model: snapshot.primary.model,
    },
    backup: snapshot.backup
      ? { baseUrl: snapshot.backup.baseUrl, model: snapshot.backup.model }
      : undefined,
    customPrompt: snapshot.customPrompt,
    glossary: snapshot.glossary.map(entry => ({ ...entry })),
  };
}

export class DocumentContractError extends Error {
  constructor(
    public readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentContractError";
  }
}

const JOB_TRANSITIONS: Record<DocumentJobPhase, readonly DocumentJobPhase[]> = {
  created: ["inspecting", "cancelling", "failed"],
  inspecting: ["parsing", "cancelling", "failed"],
  parsing: ["ready", "cancelling", "failed"],
  ready: ["translating", "cancelling", "failed"],
  translating: ["rebuilding", "cancelling", "failed"],
  rebuilding: ["exporting", "cancelling", "failed"],
  exporting: ["completed", "cancelling", "failed"],
  cancelling: ["cancelled", "failed"],
  failed: ["ready", "cancelling"],
  cancelled: ["ready"],
  completed: [],
};

const SEGMENT_TRANSITIONS: Record<
  DocumentSegmentStatus,
  readonly DocumentSegmentStatus[]
> = {
  pending: ["translating"],
  translating: ["translated", "failed", "pending"],
  failed: ["pending"],
  translated: [],
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function inspectDocumentInput(
  fileName: string,
  sizeBytes: number,
): { format: DocumentFormat } {
  if (!fileName.trim() || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new DocumentContractError("invalid-input", "Document input is invalid");
  }
  if (sizeBytes > DOCUMENT_MAX_INPUT_BYTES) {
    throw new DocumentContractError(
      "input-too-large",
      "Document input exceeds the 50 MiB limit",
    );
  }
  const extension = fileName.trim().toLocaleLowerCase().split(".").pop();
  if (extension !== "docx" && extension !== "pdf") {
    throw new DocumentContractError(
      "unsupported-format",
      "Only .docx and text-based .pdf files are supported",
    );
  }
  return { format: extension };
}

export function transitionDocumentJob(
  job: DocumentJob,
  nextPhase: DocumentJobPhase,
  updatedAt: string,
): DocumentJob {
  if (!JOB_TRANSITIONS[job.phase].includes(nextPhase)) {
    throw new DocumentContractError(
      "checkpoint-invalid",
      `Invalid document job transition: ${job.phase} -> ${nextPhase}`,
    );
  }
  if (
    nextPhase === "completed"
    && (!job.outputPath || job.segments.some(segment => segment.status !== "translated"))
  ) {
    throw new DocumentContractError(
      "checkpoint-invalid",
      "A document job cannot complete before every segment and output are ready",
    );
  }
  return {
    ...job,
    phase: nextPhase,
    updatedAt,
    error: nextPhase === "ready" ? undefined : job.error,
  };
}

export function transitionDocumentSegment(
  segment: DocumentSegment,
  nextStatus: DocumentSegmentStatus,
  update: Pick<DocumentSegment, "translatedText" | "error"> = {},
): DocumentSegment {
  if (!SEGMENT_TRANSITIONS[segment.status].includes(nextStatus)) {
    throw new DocumentContractError(
      "checkpoint-invalid",
      `Invalid document segment transition: ${segment.status} -> ${nextStatus}`,
    );
  }
  if (nextStatus === "translated" && !update.translatedText?.trim()) {
    throw new DocumentContractError(
      "checkpoint-invalid",
      "A translated segment must contain translated text",
    );
  }
  return {
    ...segment,
    ...update,
    status: nextStatus,
    attempts: nextStatus === "translating" ? segment.attempts + 1 : segment.attempts,
    translatedText: nextStatus === "pending" ? undefined : update.translatedText,
    error: nextStatus === "pending" || nextStatus === "translated"
      ? undefined
      : update.error,
  };
}

export function documentProgress(job: DocumentJob): {
  completed: number;
  failed: number;
  total: number;
} {
  return {
    completed: job.segments.filter(segment => segment.status === "translated").length,
    failed: job.segments.filter(segment => segment.status === "failed").length,
    total: job.segments.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new DocumentContractError("checkpoint-invalid", "Checkpoint contains unknown fields");
  }
  if (required.some(key => !(key in value))) {
    throw new DocumentContractError("checkpoint-invalid", "Checkpoint is missing required fields");
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DocumentContractError("checkpoint-invalid", `Invalid ${label}`);
  }
}

function validateProvider(value: unknown): asserts value is DocumentProviderSnapshot {
  if (!isRecord(value)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid provider snapshot");
  }
  requireKeys(value, ["baseUrl", "model"], ["baseUrl", "model"]);
  requireString(value.baseUrl, "provider base URL");
  requireString(value.model, "provider model");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.baseUrl);
  } catch {
    throw new DocumentContractError("checkpoint-invalid", "Invalid provider base URL");
  }
  if (
    (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new DocumentContractError(
      "checkpoint-invalid",
      "Provider base URL must not contain credentials, query parameters, or fragments",
    );
  }
}

function validateSnapshot(value: unknown): asserts value is DocumentTranslationSnapshot {
  if (!isRecord(value)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid translation snapshot");
  }
  requireKeys(
    value,
    ["sourceLanguage", "targetLanguage", "primary", "backup", "customPrompt", "glossary"],
    ["sourceLanguage", "targetLanguage", "primary", "customPrompt", "glossary"],
  );
  requireString(value.sourceLanguage, "source language");
  requireString(value.targetLanguage, "target language");
  if (typeof value.customPrompt !== "string" || !Array.isArray(value.glossary)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid translation snapshot values");
  }
  validateProvider(value.primary);
  if (value.backup !== undefined) validateProvider(value.backup);
  for (const entry of value.glossary) {
    if (!isRecord(entry)) {
      throw new DocumentContractError("checkpoint-invalid", "Invalid glossary snapshot");
    }
    requireKeys(entry, ["source_term", "target_term"], ["source_term", "target_term"]);
    requireString(entry.source_term, "glossary source term");
    requireString(entry.target_term, "glossary target term");
  }
}

function validateError(value: unknown): asserts value is DocumentError {
  if (!isRecord(value)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document error");
  }
  requireKeys(value, ["code", "message", "retryable", "segmentId"], ["code", "message", "retryable"]);
  const codes: readonly string[] = [
    "unsupported-format", "input-too-large", "invalid-input", "encrypted-pdf",
    "text-layer-required", "parse-failed", "translation-failed", "rebuild-failed",
    "export-failed", "checkpoint-invalid",
  ];
  if (!codes.includes(String(value.code)) || typeof value.retryable !== "boolean") {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document error values");
  }
  requireString(value.message, "document error message");
  if (value.segmentId !== undefined) requireString(value.segmentId, "error segment ID");
}

function validateSegment(value: unknown): asserts value is DocumentSegment {
  if (!isRecord(value)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document segment");
  }
  requireKeys(
    value,
    ["id", "location", "structure", "sourceText", "translatedText", "status", "attempts", "error"],
    ["id", "location", "structure", "sourceText", "status", "attempts"],
  );
  requireString(value.id, "segment ID");
  requireString(value.sourceText, "segment source text");
  if (byteLength(value.sourceText) > DOCUMENT_MAX_SEGMENT_BYTES) {
    throw new DocumentContractError("checkpoint-invalid", "Segment exceeds the 32 KiB limit");
  }
  const structures: readonly string[] = [
    "paragraph", "heading", "list-item", "table-cell", "header", "footer",
  ];
  const statuses: readonly string[] = ["pending", "translating", "translated", "failed"];
  if (!structures.includes(String(value.structure)) || !statuses.includes(String(value.status))) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document segment values");
  }
  if (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid segment attempt count");
  }
  if (!isRecord(value.location)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid segment location");
  }
  requireKeys(
    value.location,
    ["order", "part", "page", "sourcePosition"],
    ["order", "part"],
  );
  if (!Number.isSafeInteger(value.location.order) || Number(value.location.order) < 0) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid segment order");
  }
  requireString(value.location.part, "segment part");
  if (value.location.sourcePosition !== undefined) {
    requireString(value.location.sourcePosition, "segment source position");
  }
  if (value.location.page !== undefined && (!Number.isSafeInteger(value.location.page) || Number(value.location.page) < 1)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid segment page");
  }
  if (value.translatedText !== undefined && typeof value.translatedText !== "string") {
    throw new DocumentContractError("checkpoint-invalid", "Invalid translated text");
  }
  if (value.status === "translated" && !value.translatedText?.trim()) {
    throw new DocumentContractError("checkpoint-invalid", "Translated segment has no result");
  }
  if (value.error !== undefined) validateError(value.error);
}

/** Parses only the v1 allow-listed checkpoint shape, rejecting secret-like extras. */
export function parseDocumentCheckpoint(value: string | unknown): DocumentCheckpoint {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new DocumentContractError("checkpoint-invalid", "Checkpoint is not valid JSON");
    }
  }
  if (!isRecord(parsed)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document checkpoint");
  }
  requireKeys(parsed, ["schemaVersion", "job"], ["schemaVersion", "job"]);
  if (parsed.schemaVersion !== DOCUMENT_CHECKPOINT_VERSION || !isRecord(parsed.job)) {
    throw new DocumentContractError("checkpoint-invalid", "Unsupported checkpoint version");
  }
  const job = parsed.job;
  requireKeys(
    job,
    ["id", "phase", "input", "outputMode", "outputPath", "snapshot", "concurrency", "segments", "error", "createdAt", "updatedAt"],
    ["id", "phase", "input", "outputMode", "snapshot", "concurrency", "segments", "createdAt", "updatedAt"],
  );
  requireString(job.id, "document job ID");
  requireString(job.createdAt, "creation time");
  requireString(job.updatedAt, "update time");
  const phases: readonly string[] = Object.keys(JOB_TRANSITIONS);
  if (!phases.includes(String(job.phase))) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document job phase");
  }
  if (job.outputMode !== "translated" && job.outputMode !== "bilingual") {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document output mode");
  }
  if (job.outputPath !== undefined) requireString(job.outputPath, "document output path");
  if (!Number.isSafeInteger(job.concurrency) || Number(job.concurrency) < 1 || Number(job.concurrency) > DOCUMENT_MAX_CONCURRENCY) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document concurrency");
  }
  if (!isRecord(job.input)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document input");
  }
  requireKeys(
    job.input,
    ["sourcePath", "fileName", "sizeBytes", "format", "fingerprint"],
    ["sourcePath", "fileName", "sizeBytes", "format", "fingerprint"],
  );
  requireString(job.input.sourcePath, "document source path");
  requireString(job.input.fileName, "document file name");
  requireString(job.input.fingerprint, "document fingerprint");
  if (!Number.isSafeInteger(job.input.sizeBytes)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document input size");
  }
  const inspected = inspectDocumentInput(job.input.fileName, job.input.sizeBytes as number);
  if (job.input.format !== inspected.format) {
    throw new DocumentContractError("checkpoint-invalid", "Document format does not match its name");
  }
  validateSnapshot(job.snapshot);
  if (!Array.isArray(job.segments)) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document segments");
  }
  if (job.segments.length === 0 || job.segments.length > DOCUMENT_MAX_SEGMENTS) {
    throw new DocumentContractError("checkpoint-invalid", "Invalid document segment count");
  }
  job.segments.forEach(validateSegment);
  if (new Set(job.segments.map(segment => segment.id)).size !== job.segments.length) {
    throw new DocumentContractError("checkpoint-invalid", "Document segment IDs must be unique");
  }
  if (job.segments.some((segment, order) => segment.location.order !== order)) {
    throw new DocumentContractError("checkpoint-invalid", "Document segment order must be contiguous");
  }
  const sourceBytes = job.segments.reduce(
    (total, segment) => total + byteLength(segment.sourceText),
    0,
  );
  const translatedBytes = job.segments.reduce(
    (total, segment) => total + byteLength(segment.translatedText ?? ""),
    0,
  );
  if (sourceBytes > DOCUMENT_MAX_SOURCE_TEXT_BYTES) {
    throw new DocumentContractError("checkpoint-invalid", "Document source text exceeds the 24 MiB limit");
  }
  if (
    job.segments.some(segment => byteLength(segment.translatedText ?? "") > DOCUMENT_MAX_SEGMENT_BYTES)
    || translatedBytes > DOCUMENT_MAX_TRANSLATED_TEXT_BYTES
  ) {
    throw new DocumentContractError("checkpoint-invalid", "Document translated text exceeds its limit");
  }
  if (job.error !== undefined) validateError(job.error);
  if (
    typeof job.outputPath === "string"
    && job.outputPath.trim().toLocaleLowerCase()
      === job.input.sourcePath.trim().toLocaleLowerCase()
  ) {
    throw new DocumentContractError("checkpoint-invalid", "Document output must not overwrite its source");
  }
  if (
    job.phase === "completed"
    && (!job.outputPath || job.segments.some(segment => segment.status !== "translated"))
  ) {
    throw new DocumentContractError("checkpoint-invalid", "Completed checkpoint is missing output or translations");
  }
  return parsed as unknown as DocumentCheckpoint;
}
