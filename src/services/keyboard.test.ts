import { describe, expect, it } from "vitest";
import {
  dashboardTabFromNavigation,
  dashboardTabFromShortcut,
} from "./keyboard";

describe("dashboard keyboard navigation", () => {
  it("maps Ctrl+1 through Ctrl+8 to every dashboard section", () => {
    const expected = [
      "general",
      "batch",
      "model",
      "appearance",
      "wordbook",
      "review",
      "history",
      "document",
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
    expect(dashboardTabFromNavigation("general", "ArrowUp")).toBe("document");
    expect(dashboardTabFromNavigation("document", "ArrowDown")).toBe("general");
    expect(dashboardTabFromNavigation("model", "Home")).toBe("general");
    expect(dashboardTabFromNavigation("model", "End")).toBe("document");
    expect(dashboardTabFromNavigation("model", "Tab")).toBeNull();
  });
});
