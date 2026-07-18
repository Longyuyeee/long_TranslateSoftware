import { describe, expect, it } from "vitest";
import { isOcrConfirmShortcut, normalizeOcrText } from "./ocr";

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
});
