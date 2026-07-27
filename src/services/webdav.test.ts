import { describe, expect, it } from "vitest";
import { normalizeWebDavError, parseStoredSyncSummary } from "./webdav";

describe("WebDAV result helpers", () => {
  it("preserves structured backend errors", () => {
    expect(normalizeWebDavError({
      code: "unauthorized",
      message: "bad credentials",
      status: 401,
      recoverable: true,
    })).toEqual({
      code: "unauthorized",
      message: "bad credentials",
      status: 401,
      recoverable: true,
    });
  });

  it("converts legacy string failures into a recoverable fallback", () => {
    expect(normalizeWebDavError("connection failed")).toMatchObject({
      code: "unknown",
      message: "connection failed",
      recoverable: true,
    });
  });

  it("only restores complete sync summaries", () => {
    const summary = {
      downloaded: 4,
      added: 1,
      updated: 2,
      unchanged: 1,
      contextsAdded: 3,
      uploaded: 8,
      firstSync: false,
      completedAt: "2026-07-27 12:00:00",
    };
    expect(parseStoredSyncSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseStoredSyncSummary('{"downloaded":4}')).toBeNull();
    expect(parseStoredSyncSummary("not-json")).toBeNull();
  });
});
