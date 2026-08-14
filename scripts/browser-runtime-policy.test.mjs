import { describe, expect, it } from "vitest";
import { manualChromeRuntimeReason } from "./browser-runtime-policy.mjs";

describe("browser runtime policy", () => {
  it("keeps official Chrome command-line extension restrictions as a manual gate", () => {
    expect(manualChromeRuntimeReason(new Error("net::ERR_BLOCKED_BY_CLIENT")))
      .toContain("chrome://extensions");
    expect(manualChromeRuntimeReason(
      new Error("Chrome en-US did not open its debugging endpoint:"),
    )).toContain("automation debugging endpoint");
  });

  it("does not hide unrelated Chrome runtime failures", () => {
    expect(manualChromeRuntimeReason(new Error("popup controls are incomplete"))).toBeNull();
    expect(manualChromeRuntimeReason("not an error")).toBeNull();
  });
});
