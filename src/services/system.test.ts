import { describe, expect, it } from "vitest";
import { shortcutFromKeyboardEvent } from "./system";

const keyboardEvent = (
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
  > = {},
) => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

describe("shortcutFromKeyboardEvent", () => {
  it("normalizes supported modifier combinations", () => {
    expect(
      shortcutFromKeyboardEvent(
        keyboardEvent("q", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("Ctrl+Shift+Q");
    expect(
      shortcutFromKeyboardEvent(keyboardEvent("7", { metaKey: true })),
    ).toBe("Win+7");
  });

  it("accepts F1-F12 without modifiers", () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent("F1"))).toBe("F1");
    expect(shortcutFromKeyboardEvent(keyboardEvent("F12"))).toBe("F12");
  });

  it("rejects modifiers alone, unsafe bare keys, punctuation and F13", () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent("Control", { ctrlKey: true }))).toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent("Q"))).toBeNull();
    expect(
      shortcutFromKeyboardEvent(keyboardEvent(";", { ctrlKey: true })),
    ).toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent("F13"))).toBeNull();
  });
});
