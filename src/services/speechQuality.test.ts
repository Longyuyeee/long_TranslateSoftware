import { describe, expect, it } from "vitest";
import speechCases from "../quality/speech-cases.json";
import { inspectSpeechAudio, resolveEdgeVoice } from "./speechQuality";

function bytesFromHex(hex: string): number[] {
  return Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

describe("speech quality fixtures", () => {
  it.each(speechCases.routes)("$id", speechCase => {
    expect(resolveEdgeVoice(speechCase.text, speechCase.configuredVoice))
      .toEqual(speechCase.expected);
  });

  it.each(speechCases.audio)("$id", audioCase => {
    expect(inspectSpeechAudio(bytesFromHex(audioCase.hex)))
      .toEqual(audioCase.expected);
  });
});
