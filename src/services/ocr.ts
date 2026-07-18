export function normalizeOcrText(text: string): string | null {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isOcrConfirmShortcut(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}
