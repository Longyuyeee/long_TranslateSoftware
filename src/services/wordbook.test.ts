import { describe, expect, it } from "vitest";
import { parseWordAnalysis } from "./wordbook";

describe("parseWordAnalysis", () => {
  it("normalizes valid analysis and removes malformed list entries", () => {
    expect(
      parseWordAnalysis(
        JSON.stringify({
          phonetic: "test",
          meaning: "测试",
          examples: [{ en: "A test.", zh: "一个测试。" }, null],
          synonyms: ["trial", 7],
        }),
      ),
    ).toEqual({
      phonetic: "test",
      meaning: "测试",
      etymology: "",
      mnemonic: "",
      examples: [{ en: "A test.", zh: "一个测试。" }],
      synonyms: ["trial"],
      status: "success",
    });
  });

  it("preserves structured failures without requiring success fields", () => {
    expect(
      parseWordAnalysis(
        JSON.stringify({ status: "failed", error_msg: "provider error" }),
      ),
    ).toEqual({
      phonetic: "",
      meaning: "",
      etymology: "",
      mnemonic: "",
      examples: [],
      synonyms: [],
      status: "failed",
      error_msg: "provider error",
    });
  });

  it("returns null for empty, malformed, or incomplete analysis", () => {
    expect(parseWordAnalysis("")).toBeNull();
    expect(parseWordAnalysis("{broken")).toBeNull();
    expect(parseWordAnalysis(JSON.stringify({ meaning: "missing phonetic" }))).toBeNull();
  });
});
