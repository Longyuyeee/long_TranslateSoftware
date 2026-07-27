export type TranslationInvariantKind =
  | "terminology"
  | "url"
  | "placeholder"
  | "inline-code"
  | "xml"
  | "number"
  | "markdown";

export interface TranslationFormatIssue {
  kind: TranslationInvariantKind;
  token: string;
  missingCount: number;
}

export interface TranslationFormatReport {
  passed: boolean;
  score: number;
  expectedCount: number;
  matchedCount: number;
  issues: TranslationFormatIssue[];
}

interface TranslationFormatOptions {
  requiredTerms?: string[];
}

interface InvariantToken {
  kind: TranslationInvariantKind;
  value: string;
}

function matches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), match => match[0]);
}

function extractUrls(text: string): string[] {
  return matches(text, /https?:\/\/[^\s<>"'`]+/gu)
    .map(url => url.replace(/[.,;:!?，。；：！？]+$/gu, ""));
}

function extractMarkdownMarkers(text: string): string[] {
  return [
    ...matches(text, /^```/gmu).map(() => "code-fence"),
    ...matches(text, /^#{1,6}(?=\s)/gmu).map(marker => `heading-${marker.length}`),
    ...matches(text, /^\s*[-*+](?=\s)/gmu).map(() => "unordered-list"),
    ...matches(text, /^\s*\d+[.)](?=\s)/gmu).map(() => "ordered-list"),
    ...matches(text, /^>(?=\s?)/gmu).map(() => "blockquote"),
  ];
}

function extractSourceInvariants(source: string): InvariantToken[] {
  const tokens: InvariantToken[] = [];
  const add = (kind: TranslationInvariantKind, values: string[]) => {
    values.forEach(value => tokens.push({ kind, value }));
  };

  add("url", extractUrls(source));
  add(
    "placeholder",
    matches(
      source,
      /\{\{[^{}\n]+\}\}|\$\{[^{}\n]+\}|%\([^)]+\)[a-zA-Z]|%[a-zA-Z]|\{[A-Za-z_][\w.-]*\}|__[A-Z0-9_]+__/gu,
    ),
  );
  add("inline-code", matches(source, /`[^`\n]+`/gu));
  add("xml", matches(source, /<\/?[A-Za-z][^<>]*?\/?>/gu));
  add(
    "number",
    matches(
      source,
      /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,:/-]\d+)*(?:%|°[CF])?(?![\p{L}\p{N}_])/gu,
    ),
  );
  add("markdown", extractMarkdownMarkers(source));
  return tokens;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return counts;
}

export function evaluateTranslationFormat(
  source: string,
  candidate: string,
  options: TranslationFormatOptions = {},
): TranslationFormatReport {
  const sourceTokens = extractSourceInvariants(source);
  const candidateTokens = extractSourceInvariants(candidate);
  const issues: TranslationFormatIssue[] = [];
  let expectedCount = sourceTokens.length;
  let matchedCount = 0;

  const candidateByKind = new Map<TranslationInvariantKind, Map<string, number>>();
  candidateTokens.forEach(token => {
    const values = candidateByKind.get(token.kind) || new Map<string, number>();
    values.set(token.value, (values.get(token.value) || 0) + 1);
    candidateByKind.set(token.kind, values);
  });

  const expectedByKind = new Map<TranslationInvariantKind, string[]>();
  sourceTokens.forEach(token => {
    const values = expectedByKind.get(token.kind) || [];
    values.push(token.value);
    expectedByKind.set(token.kind, values);
  });

  expectedByKind.forEach((values, kind) => {
    const expected = countValues(values);
    const actual = candidateByKind.get(kind) || new Map<string, number>();
    expected.forEach((count, token) => {
      const matched = Math.min(count, actual.get(token) || 0);
      matchedCount += matched;
      if (matched < count) issues.push({ kind, token, missingCount: count - matched });
    });
  });

  const requiredTerms = Array.from(new Set(
    (options.requiredTerms || []).map(term => term.trim()).filter(Boolean),
  ));
  expectedCount += requiredTerms.length;
  const normalizedCandidate = candidate.toLocaleLowerCase();
  requiredTerms.forEach(term => {
    if (normalizedCandidate.includes(term.toLocaleLowerCase())) {
      matchedCount += 1;
    } else {
      issues.push({ kind: "terminology", token: term, missingCount: 1 });
    }
  });

  const score = expectedCount === 0 ? 1 : matchedCount / expectedCount;
  return {
    passed: issues.length === 0,
    score,
    expectedCount,
    matchedCount,
    issues,
  };
}

export function summarizeTranslationFormatIssues(report: TranslationFormatReport): string {
  return report.issues
    .slice(0, 4)
    .map(issue => `${issue.kind}:${issue.token}${issue.missingCount > 1 ? `×${issue.missingCount}` : ""}`)
    .join(", ");
}
