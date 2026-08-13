import { describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import {
  DOCUMENT_CHECKPOINT_VERSION,
  DOCUMENT_MAX_INPUT_BYTES,
  documentSegmentsFromDocx,
  documentSnapshotFromExecution,
  documentProgress,
  inspectDocumentInput,
  inspectDocxDocument,
  saveDocumentCheckpoint,
  loadDocumentCheckpoint,
  deleteDocumentCheckpoint,
  cleanupDocumentCheckpoints,
  parseDocumentCheckpoint,
  transitionDocumentJob,
  transitionDocumentSegment,
  type DocumentCheckpoint,
  type DocumentJob,
  type DocumentSegment,
} from "./documentTranslation";

const now = "2026-08-13T00:00:00.000Z";

function segment(overrides: Partial<DocumentSegment> = {}): DocumentSegment {
  return {
    id: "segment-1",
    location: { order: 0, part: "word/document.xml" },
    structure: "paragraph",
    sourceText: "Hello",
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

function job(overrides: Partial<DocumentJob> = {}): DocumentJob {
  return {
    id: "job-1",
    phase: "created",
    input: {
      sourcePath: "C:\\docs\\input.docx",
      fileName: "input.docx",
      sizeBytes: 1024,
      format: "docx",
      fingerprint: "sha256:abc123",
    },
    outputMode: "translated",
    snapshot: {
      sourceLanguage: "auto",
      targetLanguage: "Chinese",
      primary: { baseUrl: "https://api.example.com/v1", model: "translate-1" },
      customPrompt: "",
      glossary: [{ source_term: "hello", target_term: "你好" }],
    },
    concurrency: 3,
    segments: [segment()],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function checkpoint(overrides: Partial<DocumentJob> = {}): DocumentCheckpoint {
  return { schemaVersion: DOCUMENT_CHECKPOINT_VERSION, job: job(overrides) };
}

describe("document input contract", () => {
  it("accepts DOCX and case-insensitive PDF names", () => {
    expect(inspectDocumentInput("report.docx", 1)).toEqual({ format: "docx" });
    expect(inspectDocumentInput("REPORT.PDF", 1)).toEqual({ format: "pdf" });
  });

  it("rejects legacy Word files and oversized inputs", () => {
    expect(() => inspectDocumentInput("legacy.doc", 1)).toThrow("Only .docx");
    expect(() => inspectDocumentInput("large.docx", DOCUMENT_MAX_INPUT_BYTES + 1))
      .toThrow("50 MiB");
  });
});

describe("DOCX import adaptation", () => {
  it("invokes the read-only desktop DOCX inspection command", async () => {
    const inspection = {
      fingerprint: "sha256:fixture",
      fileName: "fixture.docx",
      sizeBytes: 2048,
      warnings: [],
      segments: [],
    };
    invokeMock.mockResolvedValueOnce(inspection);

    await expect(inspectDocxDocument("C:\\docs\\fixture.docx"))
      .resolves.toEqual(inspection);
    expect(invokeMock).toHaveBeenCalledWith("inspect_docx_document", {
      path: "C:\\docs\\fixture.docx",
    });
  });

  it("maps inspected DOCX text into pending document segments", () => {
    expect(documentSegmentsFromDocx({
      fingerprint: "sha256:fixture",
      fileName: "fixture.docx",
      sizeBytes: 2048,
      warnings: [],
      segments: [{
        id: "docx-stable-id",
        order: 0,
        part: "word/document.xml",
        sourcePosition: "paragraph:0:chunk:0",
        structure: "heading",
        sourceText: "Product Overview 产品概览",
      }],
    })).toEqual([{
      id: "docx-stable-id",
      location: {
        order: 0,
        part: "word/document.xml",
        sourcePosition: "paragraph:0:chunk:0",
      },
      structure: "heading",
      sourceText: "Product Overview 产品概览",
      status: "pending",
      attempts: 0,
    }]);
  });
});

describe("document state machines", () => {
  it("advances a job through an allowed pipeline transition", () => {
    expect(transitionDocumentJob(job(), "inspecting", "later")).toMatchObject({
      phase: "inspecting",
      updatedAt: "later",
    });
  });

  it("rejects skipped and post-completion job transitions", () => {
    expect(() => transitionDocumentJob(job(), "translating", now)).toThrow(
      "created -> translating",
    );
    expect(() => transitionDocumentJob(job({ phase: "completed" }), "ready", now))
      .toThrow("completed -> ready");
  });

  it("requires translated segments and an output before completion", () => {
    expect(() => transitionDocumentJob(job({ phase: "exporting" }), "completed", now))
      .toThrow("every segment and output");
    const completed = transitionDocumentJob(
      job({
        phase: "exporting",
        outputPath: "C:\\docs\\output.docx",
        segments: [segment({ status: "translated", translatedText: "你好" })],
      }),
      "completed",
      now,
    );
    expect(completed.phase).toBe("completed");
  });

  it("increments attempts and supports crash recovery and failed retry", () => {
    const translating = transitionDocumentSegment(segment(), "translating");
    expect(translating.attempts).toBe(1);
    expect(transitionDocumentSegment(translating, "pending")).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    const failed = transitionDocumentSegment(translating, "failed", {
      error: { code: "translation-failed", message: "timeout", retryable: true },
    });
    expect(transitionDocumentSegment(failed, "pending").error).toBeUndefined();
  });

  it("requires non-empty translated text", () => {
    expect(() =>
      transitionDocumentSegment(
        segment({ status: "translating", attempts: 1 }),
        "translated",
        { translatedText: " " },
      )
    ).toThrow("must contain translated text");
  });

  it("reports stable segment-based progress", () => {
    expect(documentProgress(job({
      segments: [
        segment({ id: "1", status: "translated", translatedText: "一" }),
        segment({ id: "2", status: "failed" }),
        segment({ id: "3" }),
      ],
    }))).toEqual({ completed: 1, failed: 1, total: 3 });
  });
});

describe("document checkpoints", () => {
  it("validates checkpoints on both sides of the persistence bridge", async () => {
    const value = checkpoint();
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(saveDocumentCheckpoint(value)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenLastCalledWith("save_document_checkpoint", {
      checkpoint: value,
    });

    invokeMock.mockResolvedValueOnce(value);
    await expect(loadDocumentCheckpoint("job-1")).resolves.toEqual(value);
    expect(invokeMock).toHaveBeenLastCalledWith("load_document_checkpoint", {
      jobId: "job-1",
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await expect(deleteDocumentCheckpoint("job-1")).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenLastCalledWith("delete_document_checkpoint", {
      jobId: "job-1",
    });

    const cleanup = {
      removedJobs: 1,
      removedTemporaryFiles: 2,
      removedQuarantinedFiles: 3,
    };
    invokeMock.mockResolvedValueOnce(cleanup);
    await expect(cleanupDocumentCheckpoints()).resolves.toEqual(cleanup);
    expect(invokeMock).toHaveBeenLastCalledWith("cleanup_document_checkpoints");
  });

  it("redacts runtime credentials from the persisted snapshot", () => {
    const persisted = documentSnapshotFromExecution({
      primary: {
        apiKey: "primary-secret",
        baseUrl: "https://api.example.com/v1",
        model: "primary-model",
      },
      backup: {
        apiKey: "backup-secret",
        baseUrl: "https://backup.example.com/v1",
        model: "backup-model",
      },
      sourceLang: "en",
      targetLang: "zh-Hans",
      customPrompt: "Translate",
      glossary: [{ source_term: "hello", target_term: "您好" }],
    });

    expect(persisted.primary).toEqual({
      baseUrl: "https://api.example.com/v1",
      model: "primary-model",
    });
    expect(persisted.backup).toEqual({
      baseUrl: "https://backup.example.com/v1",
      model: "backup-model",
    });
    expect(JSON.stringify(persisted)).not.toContain("secret");
  });

  it("round-trips the allow-listed v1 shape", () => {
    const value = checkpoint();
    expect(parseDocumentCheckpoint(JSON.stringify(value))).toEqual(value);
  });

  it("rejects future checkpoint versions", () => {
    expect(() => parseDocumentCheckpoint({ ...checkpoint(), schemaVersion: 2 }))
      .toThrow("Unsupported checkpoint version");
  });

  it("rejects secret or unknown snapshot fields", () => {
    const value = checkpoint() as unknown as {
      schemaVersion: number;
      job: DocumentJob & { snapshot: DocumentJob["snapshot"] & { apiKey: string } };
    };
    value.job.snapshot.apiKey = "must-not-persist";
    expect(() => parseDocumentCheckpoint(value)).toThrow("unknown fields");
  });

  it("rejects credentials hidden in provider URLs", () => {
    const withQuerySecret = checkpoint();
    withQuerySecret.job.snapshot.primary.baseUrl = "https://api.example.com/v1?api_key=secret";
    expect(() => parseDocumentCheckpoint(withQuerySecret)).toThrow(
      "must not contain credentials",
    );
  });

  it("rejects duplicate segment IDs and mismatched file formats", () => {
    expect(() => parseDocumentCheckpoint(checkpoint({
      segments: [segment(), segment()],
    }))).toThrow("must be unique");
    expect(() => parseDocumentCheckpoint(checkpoint({
      input: { ...job().input, format: "pdf" },
    }))).toThrow("does not match");
  });

  it("rejects oversized segment text before it reaches a provider", () => {
    expect(() => parseDocumentCheckpoint(checkpoint({
      segments: [segment({ sourceText: "译".repeat(11_000) })],
    }))).toThrow("32 KiB");
    expect(() => parseDocumentCheckpoint(checkpoint({
      segments: [segment({
        status: "translated",
        translatedText: "译".repeat(11_000),
      })],
    }))).toThrow("translated text");
  });

  it("rejects non-contiguous checkpoint segment order", () => {
    expect(() => parseDocumentCheckpoint(checkpoint({
      segments: [segment({ location: { order: 1, part: "word/document.xml" } })],
    }))).toThrow("must be contiguous");
  });

  it("rejects coerced sizes and source-overwriting outputs", () => {
    const coerced = checkpoint();
    (coerced.job.input as unknown as Record<string, unknown>).sizeBytes = "1024";
    expect(() => parseDocumentCheckpoint(coerced)).toThrow("input size");
    expect(() => parseDocumentCheckpoint(checkpoint({
      outputPath: "c:\\DOCS\\input.docx",
    }))).toThrow("must not overwrite");
  });
});
