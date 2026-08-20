import { describe, expect, it } from "vitest";
import cases from "../quality/translation-format-cases.json";
import {
  evaluateTranslationFormat,
  TranslationInvariantKind,
} from "./translationQuality";

interface QualityCase {
  id: string;
  source: string;
  candidate: string;
  requiredTerms: string[];
  expectedPass: boolean;
  expectedMissingKinds: TranslationInvariantKind[];
}

describe("translation format quality gate", () => {
  it.each(cases as QualityCase[])("$id", qualityCase => {
    const report = evaluateTranslationFormat(
      qualityCase.source,
      qualityCase.candidate,
      { requiredTerms: qualityCase.requiredTerms },
    );
    const missingKinds = Array.from(new Set(report.issues.map(issue => issue.kind))).sort();

    expect(report.passed).toBe(qualityCase.expectedPass);
    expect(missingKinds).toEqual([...qualityCase.expectedMissingKinds].sort());
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(1);
  });

  it("tracks duplicate invariants as a multiset", () => {
    const report = evaluateTranslationFormat(
      "Keep {id} twice: {id}.",
      "保留一次 {id}。",
    );

    expect(report).toMatchObject({
      passed: false,
      issues: [{ kind: "placeholder", token: "{id}", missingCount: 1 }],
    });
  });

  it("accepts an exact source number next to translated CJK text", () => {
    expect(evaluateTranslationFormat(
      "Recovery acceptance page 1.",
      "恢复验收第1页。",
    ).passed).toBe(true);

    expect(evaluateTranslationFormat(
      "Recovery acceptance page 1.",
      "恢复验收第10页。",
    )).toMatchObject({
      passed: false,
      issues: [{ kind: "number", token: "1", missingCount: 1 }],
    });
  });
});
