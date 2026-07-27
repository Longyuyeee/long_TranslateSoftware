export function normalizeOcrText(text: string): string | null {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isOcrConfirmShortcut(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}

export interface OcrLanguageInfo {
  tag: string;
  display_name: string;
  native_name: string;
}

export function resolveOcrLanguageTag(
  savedTag: string,
  installedLanguages: OcrLanguageInfo[],
): string {
  const normalizedSaved = savedTag.trim();
  if (!normalizedSaved || normalizedSaved.toLocaleLowerCase() === "auto") return "auto";

  const exact = installedLanguages.find(language =>
    language.tag.toLocaleLowerCase() === normalizedSaved.toLocaleLowerCase());
  if (exact) return exact.tag;

  const normalizedLower = normalizedSaved.toLocaleLowerCase();
  const sameLanguageAndScript = installedLanguages.find(language => {
    const tag = language.tag.toLocaleLowerCase();
    return tag.startsWith(`${normalizedLower}-`) || normalizedLower.startsWith(`${tag}-`);
  });
  if (sameLanguageAndScript) return sameLanguageAndScript.tag;

  const savedBase = normalizedSaved.split("-")[0].toLocaleLowerCase();
  const sameBase = installedLanguages.find(language =>
    language.tag.split("-")[0].toLocaleLowerCase() === savedBase);
  return sameBase?.tag || "auto";
}

function evaluationCharacters(text: string): string[] {
  return Array.from(text.normalize("NFKC").replace(/\s+/gu, " ").trim());
}

export function calculateCharacterErrorRate(reference: string, hypothesis: string): number {
  const expected = evaluationCharacters(reference);
  const actual = evaluationCharacters(hypothesis);
  if (expected.length === 0) return actual.length === 0 ? 0 : 1;

  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  expected.forEach((expectedCharacter, expectedIndex) => {
    const current = [expectedIndex + 1];
    actual.forEach((actualCharacter, actualIndex) => {
      current.push(Math.min(
        current[actualIndex] + 1,
        previous[actualIndex + 1] + 1,
        previous[actualIndex] + (expectedCharacter === actualCharacter ? 0 : 1),
      ));
    });
    previous = current;
  });
  return previous[actual.length] / expected.length;
}
