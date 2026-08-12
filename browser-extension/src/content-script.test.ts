// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

function selection(text: string): Selection {
  return {
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({
      getBoundingClientRect: () => new DOMRect(40, 50, 120, 20),
    }),
  } as unknown as Selection;
}

async function install(
  sendMessage: (
    message: unknown,
    callback: (response: unknown) => void,
  ) => void,
  selectedText = "hello world",
  translations: Record<string, string> = {},
) {
  document.getElementById("long-translate-selection-root")?.remove();
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    i18n: { getMessage: (key: string) => translations[key] || "" },
  });
  vi.spyOn(window, "getSelection").mockReturnValue(selection(selectedText));
  vi.resetModules();
  await import("./content-script");
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await Promise.resolve();
  const host = document.getElementById("long-translate-selection-root");
  if (!host?.shadowRoot) throw new Error("Selection overlay was not installed");
  return host.shadowRoot;
}

describe("selection translation overlay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.getElementById("long-translate-selection-root")?.remove();
  });

  it("sends only the selected text after the user chooses translate", async () => {
    const messages: unknown[] = [];
    const shadow = await install((message, callback) => {
      messages.push(message);
      callback({ ok: true, result: { text: "你好，世界" } });
    });

    expect(
      shadow.querySelector<HTMLButtonElement>(".launcher")?.textContent,
    ).toBe("译");
    shadow.querySelector<HTMLButtonElement>(".launcher")?.click();

    expect(messages[0]).toMatchObject({
      type: "native-translate",
      input: {
        text: "hello world",
        targetLanguage: "Chinese",
        format: "plain_text",
      },
    });
    expect(shadow.querySelector(".result")?.textContent).toBe("你好，世界");
    expect(shadow.querySelector<HTMLButtonElement>(".copy")?.hidden).toBe(
      false,
    );
  });

  it("focuses the dialog and cancels the correlated task on Escape", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const shadow = await install((message) => {
      messages.push(message as Record<string, unknown>);
    });
    shadow.querySelector<HTMLButtonElement>(".launcher")?.click();
    const translation = messages[0];
    expect(shadow.activeElement).toBe(shadow.querySelector(".cancel"));
    shadow
      .querySelector(".panel")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

    expect(messages[1]).toEqual({
      type: "native-cancel",
      taskId: translation.taskId,
    });
    expect(shadow.querySelector(".panel")).toBeNull();
  });

  it("routes selections containing Han characters to English", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const shadow = await install((message) => {
      messages.push(message as Record<string, unknown>);
    }, "你好世界");
    shadow.querySelector<HTMLButtonElement>(".launcher")?.click();

    expect(messages[0]).toMatchObject({
      input: { text: "你好世界", targetLanguage: "English" },
    });
  });

  it("shows the wordbook action only after success and saves the selected pair", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const shadow = await install((message, callback) => {
      messages.push(message as Record<string, unknown>);
      const type = (message as Record<string, unknown>).type;
      callback(
        type === "native-translate"
          ? { ok: true, result: { text: "你好，世界" } }
          : { ok: true, result: { wordId: "word-123" } },
      );
    });
    shadow.querySelector<HTMLButtonElement>(".launcher")?.click();
    const save = shadow.querySelector<HTMLButtonElement>(".save");
    expect(save?.hidden).toBe(false);
    save?.click();

    expect(messages[1]).toEqual({
      type: "native-add-word",
      input: { word: "hello world", translation: "你好，世界" },
    });
    expect(save?.textContent).toBe("已收藏");
  });

  it("rejects oversized selections before messaging the desktop", async () => {
    const sendMessage = vi.fn();
    const shadow = await install(sendMessage);
    vi.mocked(window.getSelection).mockReturnValue(
      selection("文".repeat(11_000)),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(shadow.querySelector(".notice")?.textContent).toContain("32 KiB");
  });

  it("localizes the selection launcher and dialog without page permissions", async () => {
    const messages: unknown[] = [];
    const shadow = await install(
      (payload) => messages.push(payload),
      "hello world",
      {
        translateButton: "T",
        translateSelectionAria: "Translate selected text",
        translateToChinese: "Translate to Chinese",
        selectionDialogAria: "Long Translate selection translation",
        translating: "Translating…",
        cancel: "Cancel",
      },
    );
    const launcher = shadow.querySelector<HTMLButtonElement>(".launcher");
    expect(launcher?.textContent).toBe("T");
    expect(launcher?.getAttribute("aria-label")).toBe(
      "Translate selected text",
    );
    launcher?.click();

    expect(shadow.querySelector("header span")?.textContent).toBe(
      "Translate to Chinese",
    );
    expect(shadow.querySelector(".panel")?.getAttribute("aria-label")).toBe(
      "Long Translate selection translation",
    );
    expect(shadow.querySelector(".progress")?.textContent).toBe(
      "Translating…",
    );
    expect(shadow.querySelector(".cancel")?.textContent).toBe("Cancel");
    expect(messages).toHaveLength(1);
  });
});
