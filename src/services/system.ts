export type ShortcutAction = "q" | "w";

type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);
const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1[0-2])$/;
const LETTER_OR_DIGIT_PATTERN = /^[A-Z0-9]$/;

export function shortcutFromKeyboardEvent(
  event: ShortcutKeyboardEvent,
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const key = event.key.toUpperCase();
  const isFunctionKey = FUNCTION_KEY_PATTERN.test(key);
  const hasModifier =
    event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
  if ((!hasModifier && !isFunctionKey) || (!isFunctionKey && !LETTER_OR_DIGIT_PATTERN.test(key))) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Win");
  parts.push(key);
  return parts.join("+");
}
