import { describe, expect, it } from "vitest";
import {
  commandErrorMessage,
  isCommandError,
  parseCommandError,
} from "./commandErrors";

describe("Tauri command errors", () => {
  it("parses structured command errors", () => {
    const error = { code: "cancelled", message: "User cancelled" };

    expect(parseCommandError(error)).toEqual(error);
    expect(isCommandError(error, "cancelled")).toBe(true);
    expect(commandErrorMessage(error)).toBe("User cancelled");
  });

  it("keeps legacy string and Error values readable", () => {
    expect(commandErrorMessage("legacy failure")).toBe("legacy failure");
    expect(commandErrorMessage(new Error("native failure"))).toBe(
      "Error: native failure",
    );
    expect(commandErrorMessage({ message: "missing code" })).toBe(
      "Unknown command error",
    );
  });
});
