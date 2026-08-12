// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

function popupFixture(): void {
  document.body.innerHTML = `
    <p id="status"></p><dl id="details"></dl>
    <span id="desktop-version"></span><span id="pairing-state"></span><span id="latency"></span>
    <button id="check"></button><button id="enable-selection"></button><button id="pair"></button>
    <p id="selection-status"></p>`;
}

describe("browser popup active-tab boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    popupFixture();
  });

  it("injects the reviewed content script only after an explicit click", async () => {
    const executeScript = vi.fn((_injection, callback: () => void) =>
      callback(),
    );
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn() },
      tabs: {
        query: vi.fn(
          (
            _query,
            callback: (tabs: Array<{ id: number; url: string }>) => void,
          ) => callback([{ id: 42, url: "https://example.com/article" }]),
        ),
      },
      scripting: { executeScript },
    });
    await import("./popup");

    expect(executeScript).not.toHaveBeenCalled();
    document.getElementById("enable-selection")?.click();

    expect(executeScript).toHaveBeenCalledWith(
      {
        target: { tabId: 42 },
        files: ["assets/content-script.js"],
      },
      expect.any(Function),
    );
    expect(document.getElementById("selection-status")?.textContent).toContain(
      "已启用",
    );
  });

  it("reports restricted browser pages without widening permissions", async () => {
    const runtime: {
      lastError?: { message: string };
      sendMessage: ReturnType<typeof vi.fn>;
    } = {
      sendMessage: vi.fn(),
    };
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      runtime,
      tabs: {
        query: (
          _query: unknown,
          callback: (tabs: Array<{ id: number; url: string }>) => void,
        ) => callback([{ id: 7, url: "chrome://settings" }]),
      },
      scripting: { executeScript },
    });
    await import("./popup");
    document.getElementById("enable-selection")?.click();

    expect(document.getElementById("selection-status")?.textContent).toContain(
      "无法访问",
    );
    expect(
      (document.getElementById("enable-selection") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("requests translation and wordbook pairing from the popup", async () => {
    const sendMessage = vi.fn(
      (_message, callback: (response: unknown) => void) => {
        callback({
          ok: true,
          result: { desktopVersion: "0.4.9", pairingState: "pending" },
        });
      },
    );
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      tabs: { query: vi.fn() },
      scripting: { executeScript: vi.fn() },
    });
    await import("./popup");
    document.getElementById("pair")?.click();

    expect(sendMessage).toHaveBeenCalledWith(
      { type: "native-pair" },
      expect.any(Function),
    );
    expect(document.getElementById("status")?.textContent).toContain(
      "桌面端确认",
    );
  });
});
