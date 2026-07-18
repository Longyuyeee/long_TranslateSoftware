export type ReviewKeyboardAction =
  | { type: "flip" }
  | { type: "rate"; quality: 1 | 2 | 3 | 4 }
  | { type: "previous" }
  | { type: "next" }
  | null;

export function getReviewKeyboardAction(key: string, isFlipped: boolean): ReviewKeyboardAction {
  if (key === " " || key === "Spacebar") return { type: "flip" };
  if (key === "ArrowLeft") return { type: "previous" };
  if (key === "ArrowRight") return { type: "next" };
  if (isFlipped && /^[1-4]$/.test(key)) {
    return { type: "rate", quality: Number(key) as 1 | 2 | 3 | 4 };
  }
  return null;
}
