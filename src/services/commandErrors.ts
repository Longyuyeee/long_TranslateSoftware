export interface TauriCommandError {
  code: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseCommandError(error: unknown): TauriCommandError | null {
  if (
    !isRecord(error)
    || typeof error.code !== "string"
    || typeof error.message !== "string"
  ) {
    return null;
  }
  return { code: error.code, message: error.message };
}

export function commandErrorMessage(error: unknown): string {
  const commandError = parseCommandError(error);
  if (commandError) return commandError.message;
  if (error instanceof Error) return String(error);
  if (typeof error === "string") return error;
  return "Unknown command error";
}

export function isCommandError(error: unknown, code: string): boolean {
  return parseCommandError(error)?.code === code;
}
