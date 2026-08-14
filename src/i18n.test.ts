import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachePreferredLanguage,
  contextSourceText,
  documentImportErrorText,
  documentStructureText,
  documentWarningText,
  getPreferredLanguage,
  translationErrorText,
  translations,
  TranslationCatalog,
  webDavErrorText,
} from "./i18n";

type FlatCatalog = Record<string, string>;

function flattenCatalog(
  value: Record<string, unknown>,
  prefix = "",
  output: FlatCatalog = {},
): FlatCatalog {
  for (const [key, entry] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === "string") {
      output[fullKey] = entry;
    } else {
      flattenCatalog(entry as Record<string, unknown>, fullKey, output);
    }
  }
  return output;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{?([A-Za-z][\w-]*)\}?\}/g)]
    .map((match) => match[1])
    .sort();
}

function componentFiles(): string[] {
  const directory = path.resolve(process.cwd(), "src/components");
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => path.join(directory, file));
}

function literalUiText(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: string[] = [];
  const literalAttributes = new Set(["alt", "aria-label", "placeholder", "title"]);
  const allowedBrandText = new Set([":("]);

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).trim();
      if (/[\p{L}\p{N}]/u.test(text) && !allowedBrandText.has(text)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push(`${path.basename(file)}:${line}:${text}`);
      }
    }
    if (
      ts.isJsxAttribute(node) &&
      literalAttributes.has(node.name.getText(sourceFile)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      findings.push(
        `${path.basename(file)}:${line}:${node.name.getText(sourceFile)}="${node.initializer.text}"`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (/[\u3400-\u9fff]/u.test(line)) {
      findings.push(`${path.basename(file)}:${index + 1}:contains hard-coded CJK text`);
    }
  }
  return findings;
}

describe("translation catalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every locale key and interpolation placeholder aligned", () => {
    const chinese = flattenCatalog(translations.zh as TranslationCatalog);
    const english = flattenCatalog(translations.en as TranslationCatalog);

    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    for (const key of Object.keys(chinese)) {
      expect(placeholders(english[key]), key).toEqual(placeholders(chinese[key]));
    }
  });

  it("remembers the selected interface language for crash-safe fallback UI", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    cachePreferredLanguage("en");
    expect(getPreferredLanguage()).toBe("en");
    cachePreferredLanguage("zh");
    expect(getPreferredLanguage()).toBe("zh");
  });

  it("resolves dynamic status codes without leaking invalid translation keys", () => {
    expect(translationErrorText(translations.en, "timeout")).toBe(
      translations.en.translationError_timeout,
    );
    expect(translationErrorText(translations.en, undefined, "Provider failed")).toBe(
      "Provider failed",
    );
    expect(translationErrorText(translations.en)).toBe(
      translations.en.translationError_unknown,
    );
    expect(webDavErrorText(translations.zh, "unknown")).toBe(
      translations.zh.webdavError_unknown,
    );
    expect(contextSourceText(translations.en, "selection")).toBe(
      translations.en.contextSource_selection,
    );
    expect(contextSourceText(translations.en, "extension")).toBe("extension");
    expect(documentImportErrorText(translations.en, "invalid-input")).toBe(
      translations.en["documentImportError_invalid-input"],
    );
    expect(documentWarningText(translations.zh, "text-boxes-unsupported")).toBe(
      translations.zh["documentWarning_text-boxes-unsupported"],
    );
    expect(documentStructureText(translations.en, "heading")).toBe(
      translations.en.documentStructure_heading,
    );
    expect(documentStructureText(translations.en, "future-structure")).toBe(
      translations.en.documentStructure_unknown,
    );
  });

  it("rejects new user-facing literals in component markup", () => {
    expect(componentFiles().flatMap(literalUiText)).toEqual([]);
  });
});
