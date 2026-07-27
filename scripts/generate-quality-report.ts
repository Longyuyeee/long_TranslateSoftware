import fs from "node:fs";
import path from "node:path";
import packageManifest from "../package.json";
import ocrCases from "../src/quality/ocr-text-cases.json";
import speechCases from "../src/quality/speech-cases.json";
import translationCases from "../src/quality/translation-format-cases.json";
import { calculateCharacterErrorRate } from "../src/services/ocr";
import { inspectSpeechAudio, resolveEdgeVoice } from "../src/services/speechQuality";
import { evaluateTranslationFormat } from "../src/services/translationQuality";

const workspace = process.cwd();
const reportDirectory = path.join(workspace, "quality-reports");
const runtimeOcrPath = path.join(reportDirectory, "ocr-runtime.json");
const outputPath = path.join(reportDirectory, "quality-report.json");
const requireRuntime = process.argv.includes("--require-runtime");
const failures: string[] = [];

function matchesExpected(observed: object, expected: object): boolean {
  const observedRecord = observed as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => observedRecord[key] === value);
}

const translationResults = translationCases.map(qualityCase => {
  const result = evaluateTranslationFormat(qualityCase.source, qualityCase.candidate, {
    requiredTerms: qualityCase.requiredTerms,
  });
  if (result.passed !== qualityCase.expectedPass) {
    failures.push(`translation:${qualityCase.id}`);
  }
  return {
    id: qualityCase.id,
    expected_pass: qualityCase.expectedPass,
    observed_pass: result.passed,
    score: Number(result.score.toFixed(4)),
    issue_kinds: Array.from(new Set(result.issues.map(issue => issue.kind))).sort(),
  };
});

function bytesFromHex(hex: string): number[] {
  return Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

const speechRouteResults = speechCases.routes.map(qualityCase => {
  const observed = resolveEdgeVoice(qualityCase.text, qualityCase.configuredVoice);
  const passed = matchesExpected(observed, qualityCase.expected);
  if (!passed) failures.push(`speech-route:${qualityCase.id}`);
  return { id: qualityCase.id, passed, expected: qualityCase.expected, observed };
});

const speechAudioResults = speechCases.audio.map(qualityCase => {
  const observed = inspectSpeechAudio(bytesFromHex(qualityCase.hex));
  const passed = matchesExpected(observed, qualityCase.expected);
  if (!passed) failures.push(`speech-audio:${qualityCase.id}`);
  return { id: qualityCase.id, passed, expected: qualityCase.expected, observed };
});

const ocrTextResults = ocrCases.map(qualityCase => {
  const cer = calculateCharacterErrorRate(qualityCase.reference, qualityCase.baseline);
  const passed = cer <= qualityCase.maxCer;
  if (!passed) failures.push(`ocr-text:${qualityCase.id}`);
  return {
    id: qualityCase.id,
    scenario: qualityCase.scenario,
    cer: Number(cer.toFixed(4)),
    max_cer: qualityCase.maxCer,
    passed,
  };
});

let runtimeOcr: Record<string, unknown> | null = null;
if (fs.existsSync(runtimeOcrPath)) {
  runtimeOcr = JSON.parse(fs.readFileSync(runtimeOcrPath, "utf8"));
  if (runtimeOcr.passed !== true) failures.push("ocr-runtime:failed");
} else if (requireRuntime) {
  failures.push("ocr-runtime:missing");
}

const report = {
  schema_version: 1,
  app_version: packageManifest.version,
  generated_at: new Date().toISOString(),
  git_sha: process.env.GITHUB_SHA || null,
  github_run_id: process.env.GITHUB_RUN_ID || null,
  passed: failures.length === 0,
  failures,
  translation_format: {
    case_count: translationResults.length,
    passed: translationResults.every(result => result.observed_pass === result.expected_pass),
    cases: translationResults,
  },
  speech: {
    route_case_count: speechRouteResults.length,
    audio_case_count: speechAudioResults.length,
    passed: [...speechRouteResults, ...speechAudioResults].every(result => result.passed),
    routes: speechRouteResults,
    audio: speechAudioResults,
  },
  ocr: {
    text_case_count: ocrTextResults.length,
    text_max_observed_cer: Math.max(...ocrTextResults.map(result => result.cer)),
    text_passed: ocrTextResults.every(result => result.passed),
    text_cases: ocrTextResults,
    runtime_images: runtimeOcr || { status: "not-run" },
  },
};

fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Quality report: ${outputPath}`);
console.log(`Quality gate: ${report.passed ? "PASS" : "FAIL"}`);

if (!report.passed) {
  throw new Error(`Quality report failed: ${failures.join(", ")}`);
}
