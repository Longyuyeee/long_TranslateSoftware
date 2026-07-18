import { describe, expect, it } from "vitest";
import { getReviewKeyboardAction } from "./review";

describe("review keyboard flow", () => {
  it("maps the full flashcard keyboard flow", () => {
    expect(getReviewKeyboardAction(" ", false)).toEqual({ type: "flip" });
    expect(getReviewKeyboardAction("ArrowLeft", false)).toEqual({ type: "previous" });
    expect(getReviewKeyboardAction("ArrowRight", true)).toEqual({ type: "next" });
    expect(getReviewKeyboardAction("3", true)).toEqual({ type: "rate", quality: 3 });
  });

  it("does not rate a card before its answer is visible", () => {
    expect(getReviewKeyboardAction("1", false)).toBeNull();
    expect(getReviewKeyboardAction("5", true)).toBeNull();
  });
});
