import { describe, expect, it } from "vitest";
import { OpenAiSseParser } from "./sse";

const encoder = new TextEncoder();

describe("OpenAiSseParser", () => {
  it("keeps an event split across network chunks", () => {
    const parser = new OpenAiSseParser();

    expect(parser.push(encoder.encode('data: {"choices":[{"delta":{"con'))).toEqual([]);
    expect(parser.push(encoder.encode('tent":"hello"}}]}\n\n'))).toEqual(["hello"]);
    expect(parser.finish()).toEqual([]);
  });

  it("preserves a multibyte UTF-8 character split across chunks", () => {
    const parser = new OpenAiSseParser();
    const event = encoder.encode('data: {"choices":[{"delta":{"content":"翻译"}}]}\n\n');
    const splitAt = event.indexOf(0xe7) + 1;

    expect(parser.push(event.slice(0, splitAt))).toEqual([]);
    expect(parser.push(event.slice(splitAt))).toEqual(["翻译"]);
  });

  it("flushes a final event without a trailing newline", () => {
    const parser = new OpenAiSseParser();

    expect(parser.push(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}'))).toEqual([]);
    expect(parser.finish()).toEqual(["done"]);
  });
});
