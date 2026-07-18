/** Incrementally parses OpenAI-compatible SSE data without losing split lines or UTF-8 code points. */
export class OpenAiSseParser {
  private readonly decoder = new TextDecoder();
  private pending = "";

  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    return this.drainCompleteLines(false);
  }

  finish(): string[] {
    this.pending += this.decoder.decode();
    return this.drainCompleteLines(true);
  }

  private drainCompleteLines(includeRemainder: boolean): string[] {
    const lines = this.pending.split(/\r?\n/);
    this.pending = includeRemainder ? "" : (lines.pop() ?? "");
    const contents: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trimStart();
      if (!payload || payload === "[DONE]") continue;

      try {
        const data = JSON.parse(payload);
        const content = data?.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content.length > 0) contents.push(content);
      } catch {
        // A complete malformed event should not prevent later valid events.
      }
    }

    return contents;
  }
}
