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

const failureCases: Array<{
  error: string;
  expected: string;
  translations: Record<string, string>;
}> = [
  {
    error: "pairing_required: approval missing",
    expected: "Approve browser access in the desktop app first",
    translations: {
      approvePairingFirst: "Approve browser access in the desktop app first",
    },
  },
  {
    error: "Specified native messaging host not found at C:\\private-host",
    expected: "Start the Long Translate desktop app first",
    translations: {
      startDesktopFirst: "Start the Long Translate desktop app first",
    },
  },
];

const saveFailureCases: Array<{
  error: string;
  expected: string;
  translations: Record<string, string>;
}> = [
  {
    error: "pairing_required: wordbook approval missing",
    expected: "Update desktop access",
    translations: { updateDesktopAccess: "Update desktop access" },
  },
  {
    error: "Specified native messaging host not found at C:\\private-host",
    expected: "Desktop app is not running",
    translations: { desktopNotRunning: "Desktop app is not running" },
  },
];

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

  it.each(saveFailureCases)(
    "keeps wordbook save retryable for $error",
    async ({ error, expected, translations }) => {
      const messages: Array<Record<string, unknown>> = [];
      const shadow = await install(
        (message, callback) => {
          messages.push(message as Record<string, unknown>);
          callback(
            (message as Record<string, unknown>).type === "native-translate"
              ? { ok: true, result: { text: "translated private text" } }
              : { ok: false, error },
          );
        },
        "private selected text",
        translations,
      );
      shadow.querySelector<HTMLButtonElement>(".launcher")?.click();
      const save = shadow.querySelector<HTMLButtonElement>(".save");
      save?.click();

      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual({
        type: "native-add-word",
        input: {
          word: "private selected text",
          translation: "translated private text",
        },
      });
      expect(save?.disabled).toBe(false);
      expect(save?.dataset.saved).toBeUndefined();
      expect(save?.textContent).toBe(expected);
      expect(shadow.querySelector(".panel")?.textContent).not.toContain(error);
    },
  );

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

  it("keeps the launcher and panel inside an offset visual viewport", async () => {
    vi.stubGlobal("visualViewport", {
      offsetLeft: 100,
      offsetTop: 50,
      width: 280,
      height: 213,
    });
    const shadow = await install((_message, callback) => {
      callback({ ok: true, result: { text: "你好，世界" } });
    });
    const launcher = shadow.querySelector<HTMLElement>(".launcher");
    expect(launcher?.style.left).toBe("168px");
    expect(launcher?.style.top).toBe("78px");

    launcher?.click();
    const panel = shadow.querySelector<HTMLElement>(".panel");
    expect(panel?.style.maxWidth).toBe("256px");
    expect(panel?.style.maxHeight).toBe("189px");
    expect(panel?.style.left).toBe("112px");
    expect(panel?.style.top).toBe("62px");
  });

  it.each(failureCases)("renders a safe failure for $error", async ({ error, expected, translations }) => {
    const shadow = await install((_message, callback) => {
      callback({ ok: false, error });
    }, "private selected text", translations);
    shadow.querySelector<HTMLButtonElement>(".launcher")?.click();

    const result = shadow.querySelector<HTMLElement>(".result");
    expect(result?.textContent).toBe(expected);
    expect(result?.textContent).not.toContain(error);
    expect(result?.classList.contains("error")).toBe(true);
    expect(shadow.querySelector<HTMLButtonElement>(".cancel")?.hidden).toBe(true);
    expect(shadow.querySelector<HTMLButtonElement>(".copy")?.hidden).toBe(true);
    expect(shadow.querySelector<HTMLButtonElement>(".save")?.hidden).toBe(true);
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
