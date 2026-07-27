import { describe, expect, it } from "vitest";
import ocrCases from "../quality/ocr-text-cases.json";
import {
  calculateCharacterErrorRate,
  isOcrConfirmShortcut,
  normalizeOcrText,
  resolveOcrLanguageTag,
} from "./ocr";

describe("OCR confirmation helpers", () => {
  it("normalizes recognized text without accepting whitespace-only results", () => {
    expect(normalizeOcrText("  hello world\n")).toBe("hello world");
    expect(normalizeOcrText(" \n\t ")).toBeNull();
  });

  it("uses Enter to confirm and Shift+Enter to insert a line break", () => {
    expect(isOcrConfirmShortcut("Enter", false)).toBe(true);
    expect(isOcrConfirmShortcut("Enter", true)).toBe(false);
    expect(isOcrConfirmShortcut("Escape", false)).toBe(false);
  });

  it("maps legacy short language tags to installed Windows OCR languages", () => {
    const installed = [
      { tag: "en-US", display_name: "English", native_name: "English" },
      { tag: "zh-Hant-TW", display_name: "Chinese Traditional", native_name: "繁體中文" },
      { tag: "zh-Hans-CN", display_name: "Chinese", native_name: "中文" },
    ];

    expect(resolveOcrLanguageTag("en", installed)).toBe("en-US");
    expect(resolveOcrLanguageTag("ZH-hans", installed)).toBe("zh-Hans-CN");
    expect(resolveOcrLanguageTag("ja", installed)).toBe("auto");
    expect(resolveOcrLanguageTag("AUTO", installed)).toBe("auto");
  });
});

describe("OCR character error rate baseline", () => {
  it.each(ocrCases)("$id", qualityCase => {
    expect(calculateCharacterErrorRate(qualityCase.reference, qualityCase.baseline))
      .toBeLessThanOrEqual(qualityCase.maxCer);
  });

  it("normalizes compatibility characters and whitespace before scoring", () => {
    expect(calculateCharacterErrorRate("Ａ  B\nC", "A B C")).toBe(0);
    expect(calculateCharacterErrorRate("cat", "cut")).toBeCloseTo(1 / 3);
    expect(calculateCharacterErrorRate("", "unexpected")).toBe(1);
  });
});
