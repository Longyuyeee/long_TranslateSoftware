import { describe, expect, it } from "vitest";
import {
  dashboardTabFromNavigation,
  dashboardTabFromShortcut,
} from "./keyboard";

describe("dashboard keyboard navigation", () => {
  it("maps Ctrl+1 through Ctrl+8 to every dashboard section", () => {
    const expected = [
      "batch",
      "document",
      "wordbook",
      "review",
      "history",
      "general",
      "model",
      "appearance",
    ];
    expect(expected.map((_, index) => dashboardTabFromShortcut({
      key: String(index + 1),
      ctrlKey: true,
      altKey: false,
      metaKey: false,
    }))).toEqual(expected);
  });

  it("does not consume unrelated or modified shortcuts", () => {
    expect(dashboardTabFromShortcut({
      key: "1",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    })).toBeNull();
    expect(dashboardTabFromShortcut({
      key: "1",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
    })).toBeNull();
    expect(dashboardTabFromShortcut({
      key: "9",
      ctrlKey: true,
      altKey: false,
      metaKey: false,
    })).toBeNull();
  });

  it("wraps arrow navigation and supports Home and End", () => {
    expect(dashboardTabFromNavigation("batch", "ArrowUp")).toBe("appearance");
    expect(dashboardTabFromNavigation("appearance", "ArrowDown")).toBe("batch");
    expect(dashboardTabFromNavigation("model", "Home")).toBe("batch");
    expect(dashboardTabFromNavigation("model", "End")).toBe("appearance");
    expect(dashboardTabFromNavigation("model", "Tab")).toBeNull();
  });
});
