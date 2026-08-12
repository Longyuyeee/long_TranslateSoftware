import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  approveBrowserPairing,
  getBrowserPairings,
  rejectBrowserPairing,
  revokeBrowserPairing,
} from "./browserPairing";

const request = {
  origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
  display_name: "Long Translate extension",
  capabilities: ["translation"],
};

describe("browserPairing service", () => {
  beforeEach(() => invoke.mockReset());

  it("binds approval and rejection to the complete reviewed request", async () => {
    invoke.mockResolvedValue(undefined);
    await approveBrowserPairing(request);
    await rejectBrowserPairing(request);

    expect(invoke).toHaveBeenNthCalledWith(1, "approve_browser_pairing", {
      request,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "reject_browser_pairing", {
      request,
    });
  });

  it("uses dedicated list and revoke commands", async () => {
    invoke.mockResolvedValue(undefined);
    await getBrowserPairings();
    await revokeBrowserPairing("pairing-id");

    expect(invoke).toHaveBeenNthCalledWith(1, "get_browser_pairings");
    expect(invoke).toHaveBeenNthCalledWith(2, "revoke_browser_pairing", {
      pairingId: "pairing-id",
    });
  });
});
