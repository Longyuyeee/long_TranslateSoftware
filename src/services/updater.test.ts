import { describe, expect, it } from "vitest";

import { calculateUpdateProgress } from "./updater";

describe("calculateUpdateProgress", () => {
  it("reports indeterminate progress when the server omits a valid total", () => {
    expect(calculateUpdateProgress(10)).toBeNull();
    expect(calculateUpdateProgress(10, 0)).toBeNull();
  });

  it("rounds and clamps byte progress to a valid percentage", () => {
    expect(calculateUpdateProgress(41, 100)).toBe(41);
    expect(calculateUpdateProgress(2, 3)).toBe(67);
    expect(calculateUpdateProgress(120, 100)).toBe(100);
    expect(calculateUpdateProgress(-10, 100)).toBe(0);
  });
});
