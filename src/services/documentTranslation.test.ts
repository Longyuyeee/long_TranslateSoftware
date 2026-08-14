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
  createReadyDocumentJob,
  pickDocxDocument,
  pickDocxOutput,
  saveDocumentCheckpoint,
  loadDocumentCheckpoint,
  listDocumentCheckpoints,
  deleteDocumentCheckpoint,
  cleanupDocumentCheckpoints,
  createDocxRebuildPlan,
  validateDocxRebuildPlan,
  rebuildDocxDocument,
  cancelDocxRebuild,
  parseDocumentCheckpoint,
  parseDocumentCheckpointSummary,
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
  it("passes localized labels to the desktop DOCX picker", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(pickDocxDocument(
      "Choose a DOCX document",
      "Word document (*.docx)",
    )).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("pick_docx_document", {
      title: "Choose a DOCX document",
      filterName: "Word document (*.docx)",
    });
  });

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

  it("passes a bounded DOCX output request to the desktop picker", async () => {
    invokeMock.mockResolvedValueOnce("C:\\docs\\fixture-translated.docx");

    await expect(pickDocxOutput(
      "C:\\docs\\fixture.docx",
      "fixture-translated.docx",
      "Choose output",
      "Word document (*.docx)",
    )).resolves.toBe("C:\\docs\\fixture-translated.docx");
    expect(invokeMock).toHaveBeenCalledWith("pick_docx_output", {
      sourcePath: "C:\\docs\\fixture.docx",
      suggestedFileName: "fixture-translated.docx",
      title: "Choose output",
      filterName: "Word document (*.docx)",
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

describe("document task preparation", () => {
  const execution = {
    primary: {
      apiKey: "private-key",
      baseUrl: "https://api.example.com/v1",
      model: "translate-1",
    },
    targetLang: "Chinese",
    sourceLang: "auto",
    customPrompt: "Translate clearly",
    glossary: [{ source_term: "hello", target_term: "你好" }],
  };
  const inspection = {
    fingerprint: "sha256:fixture",
    fileName: "fixture.docx",
    sizeBytes: 2048,
    warnings: [],
    segments: [{
      id: "segment-1",
      order: 0,
      part: "word/document.xml",
      sourcePosition: "paragraph:0:chunk:0",
      structure: "paragraph" as const,
      sourceText: "Hello",
    }],
  };

  it("creates a validated ready job without persisting runtime credentials", () => {
    const prepared = createReadyDocumentJob({
      id: "document-fixture",
      sourcePath: "C:\\docs\\fixture.docx",
      outputPath: "C:\\docs\\fixture-translated.docx",
      outputMode: "translated",
      inspection,
      execution,
      createdAt: now,
    });

    expect(prepared).toMatchObject({
      id: "document-fixture",
      phase: "ready",
      outputMode: "translated",
      outputPath: "C:\\docs\\fixture-translated.docx",
      snapshot: {
        sourceLanguage: "auto",
        targetLanguage: "Chinese",
        primary: { baseUrl: "https://api.example.com/v1", model: "translate-1" },
      },
      segments: [{ status: "pending", attempts: 0 }],
    });
    expect(JSON.stringify(prepared)).not.toContain("private-key");
  });

  it("rejects source overwrite and non-DOCX output before task creation", () => {
    expect(() => createReadyDocumentJob({
      id: "document-fixture",
      sourcePath: "C:\\docs\\fixture.docx",
      outputPath: "c:/docs/FIXTURE.DOCX",
      outputMode: "bilingual",
      inspection,
      execution,
      createdAt: now,
    })).toThrow("must not overwrite");
    expect(() => createReadyDocumentJob({
      id: "document-fixture",
      sourcePath: "C:\\docs\\fixture.docx",
      outputPath: "C:\\docs\\fixture.pdf",
      outputMode: "translated",
      inspection,
      execution,
      createdAt: now,
    })).toThrow(".docx extension");
    expect(() => createReadyDocumentJob({
      id: "../unsafe",
      sourcePath: "C:\\docs\\fixture.docx",
      outputPath: "C:\\docs\\fixture-translated.docx",
      outputMode: "translated",
      inspection,
      execution,
      createdAt: now,
    })).toThrow("document job ID");
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

  it("lists only allow-listed recovery summaries", async () => {
    const summary = {
      jobId: "job-1",
      fileName: "input.docx",
      phase: "ready",
      outputMode: "translated",
      completedSegments: 2,
      failedSegments: 0,
      totalSegments: 5,
      updatedAt: now,
    } as const;
    invokeMock.mockResolvedValueOnce([summary]);
    await expect(listDocumentCheckpoints()).resolves.toEqual([summary]);
    expect(invokeMock).toHaveBeenLastCalledWith("list_document_checkpoints");

    expect(() => parseDocumentCheckpointSummary({ ...summary, sourcePath: "C:\\private.docx" }))
      .toThrow("unknown fields");
    expect(() => parseDocumentCheckpointSummary({ ...summary, completedSegments: 6 }))
      .toThrow("summary values");
    expect(() => parseDocumentCheckpointSummary({ ...summary, phase: "completed" }))
      .toThrow("summary phase");
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

describe("DOCX rebuild preflight", () => {
  function rebuildingFixture() {
    const rebuilding = job({
      phase: "rebuilding",
      segments: [segment({
        location: {
          order: 0,
          part: "word/document.xml",
          sourcePosition: "paragraph:0:chunk:0:bytes:0-5:runs:0-0:texts:0-0",
        },
        status: "translated",
        translatedText: "你好",
        attempts: 1,
      })],
    });
    const inspection = {
      fingerprint: rebuilding.input.fingerprint,
      fileName: rebuilding.input.fileName,
      sizeBytes: rebuilding.input.sizeBytes,
      warnings: [],
      segments: [{
        id: "segment-1",
        order: 0,
        part: "word/document.xml",
        sourcePosition: "paragraph:0:chunk:0:bytes:0-5:runs:0-0:texts:0-0",
        structure: "paragraph" as const,
        sourceText: "Hello",
      }],
    };
    return { rebuilding, inspection };
  }

  it("creates an ordered replacement allowlist without runtime credentials", () => {
    const { rebuilding, inspection } = rebuildingFixture();
    const plan = createDocxRebuildPlan(
      rebuilding,
      inspection,
      "C:\\docs\\translated.docx",
    );

    expect(plan).toMatchObject({
      sourcePath: "C:\\docs\\input.docx",
      outputPath: "C:\\docs\\translated.docx",
      outputMode: "translated",
      replacements: [{
        id: "segment-1",
        translatedText: "你好",
      }],
    });
    expect(JSON.stringify(plan)).not.toContain("apiKey");
  });

  it("passes the closed plan to the Rust validation boundary", async () => {
    const { rebuilding, inspection } = rebuildingFixture();
    const plan = createDocxRebuildPlan(
      rebuilding,
      inspection,
      "C:\\docs\\translated.docx",
    );
    invokeMock.mockResolvedValueOnce({
      replacementCount: 1,
      partCount: 1,
      translatedBytes: 6,
      rebuiltSizeBytes: 2048,
      rebuiltFingerprint: "sha256:rebuilt",
    });

    await expect(validateDocxRebuildPlan(plan)).resolves.toEqual({
      replacementCount: 1,
      partCount: 1,
      translatedBytes: 6,
      rebuiltSizeBytes: 2048,
      rebuiltFingerprint: "sha256:rebuilt",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("validate_docx_rebuild_plan", { plan });
  });

  it("publishes only through the Rust atomic rebuild boundary", async () => {
    const { rebuilding, inspection } = rebuildingFixture();
    const plan = createDocxRebuildPlan(
      rebuilding,
      inspection,
      "C:\\docs\\translated.docx",
    );
    invokeMock.mockResolvedValueOnce({
      outputPath: "C:\\docs\\translated.docx",
      replacementCount: 1,
      sizeBytes: 2048,
      fingerprint: "sha256:rebuilt",
    });

    await expect(rebuildDocxDocument(rebuilding.id, plan)).resolves.toMatchObject({
      outputPath: "C:\\docs\\translated.docx",
      replacementCount: 1,
    });
    expect(invokeMock).toHaveBeenLastCalledWith("rebuild_docx_document", {
      jobId: rebuilding.id,
      plan,
    });

    invokeMock.mockResolvedValueOnce(true);
    await expect(cancelDocxRebuild(rebuilding.id)).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("cancel_docx_rebuild", {
      jobId: rebuilding.id,
    });
  });

  it("rejects changed sources, anchors, incomplete translations, and source overwrite", () => {
    const { rebuilding, inspection } = rebuildingFixture();
    expect(() => createDocxRebuildPlan(
      rebuilding,
      { ...inspection, fingerprint: "sha256:changed" },
      "C:\\docs\\translated.docx",
    )).toThrow("source changed");
    expect(() => createDocxRebuildPlan(
      rebuilding,
      {
        ...inspection,
        segments: [{ ...inspection.segments[0], sourcePosition: "paragraph:1" }],
      },
      "C:\\docs\\translated.docx",
    )).toThrow("anchor changed");
    expect(() => createDocxRebuildPlan(
      { ...rebuilding, segments: [segment()] },
      inspection,
      "C:\\docs\\translated.docx",
    )).toThrow("not ready");
    expect(() => createDocxRebuildPlan(
      rebuilding,
      inspection,
      "c:/DOCS/input.docx",
    )).toThrow("must not overwrite");
  });

  it("rejects relative and non-DOCX output paths", () => {
    const { rebuilding, inspection } = rebuildingFixture();
    expect(() => createDocxRebuildPlan(rebuilding, inspection, "output.docx"))
      .toThrow("absolute .docx path");
    expect(() => createDocxRebuildPlan(
      rebuilding,
      inspection,
      "C:\\docs\\output.pdf",
    )).toThrow("absolute .docx path");
  });
});
