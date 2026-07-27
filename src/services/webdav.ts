export type WebDavErrorCode =
  | "disabled"
  | "invalid_config"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unsupported"
  | "conflict"
  | "timeout"
  | "network"
  | "server"
  | "request_failed"
  | "invalid_data"
  | "internal"
  | "unknown";

export interface WebDavError {
  code: WebDavErrorCode;
  message: string;
  status?: number | null;
  recoverable: boolean;
}

export interface WebDavConnectionResult {
  latencyMs: number;
}

export interface WebDavSyncSummary {
  downloaded: number;
  added: number;
  updated: number;
  unchanged: number;
  contextsAdded: number;
  uploaded: number;
  firstSync: boolean;
  completedAt: string;
}

export function normalizeWebDavError(error: unknown): WebDavError {
  if (error && typeof error === "object") {
    const candidate = error as Partial<WebDavError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code as WebDavErrorCode,
        message: candidate.message,
        status: typeof candidate.status === "number" ? candidate.status : null,
        recoverable: candidate.recoverable !== false,
      };
    }
  }

  return {
    code: "unknown",
    message: typeof error === "string" ? error : "Unknown WebDAV error",
    status: null,
    recoverable: true,
  };
}

export function parseStoredSyncSummary(value: string): WebDavSyncSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WebDavSyncSummary>;
    if (
      typeof parsed.downloaded !== "number"
      || typeof parsed.added !== "number"
      || typeof parsed.updated !== "number"
      || typeof parsed.unchanged !== "number"
      || typeof parsed.contextsAdded !== "number"
      || typeof parsed.uploaded !== "number"
      || typeof parsed.firstSync !== "boolean"
      || typeof parsed.completedAt !== "string"
    ) {
      return null;
    }
    return parsed as WebDavSyncSummary;
  } catch {
    return null;
  }
}
