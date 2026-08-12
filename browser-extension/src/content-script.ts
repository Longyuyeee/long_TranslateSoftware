interface SelectionRuntime {
  lastError?: { message?: string };
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
}

interface SelectionChrome {
  runtime: SelectionRuntime;
  i18n?: { getMessage(messageName: string): string };
}

interface TranslationReply {
  ok: boolean;
  result?: { text?: string };
  error?: string;
}

export {};

const ROOT_ID = "long-translate-selection-root";
const MAX_SELECTION_BYTES = 32 * 1024;
const textEncoder = new TextEncoder();

function installSelectionOverlay(
  runtime: SelectionRuntime,
  i18n?: SelectionChrome["i18n"],
): void {
  const message = (key: string, fallback: string): string =>
    i18n?.getMessage(key) || fallback;
  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.style.cssText =
    "all:initial;position:fixed;inset:0 auto auto 0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${overlayStyles}</style><div id="mount"></div>`;
  document.documentElement.append(host);
  const mount = shadow.getElementById("mount")!;

  let selectedText = "";
  let taskId: string | undefined;
  let selectionVersion = 0;

  const hide = (cancel = false) => {
    if (cancel && taskId) {
      runtime.sendMessage({ type: "native-cancel", taskId }, () => undefined);
    }
    taskId = undefined;
    mount.replaceChildren();
  };

  const showLauncher = (text: string, rect: DOMRect) => {
    selectedText = text;
    taskId = undefined;
    mount.innerHTML = `<button class="launcher" type="button"></button>`;
    const launcher = mount.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) return;
    launcher.textContent = message("translateButton", "译");
    launcher.setAttribute(
      "aria-label",
      message("translateSelectionAria", "翻译所选文字"),
    );
    position(
      mount.firstElementChild as HTMLElement,
      rect.right + 8,
      rect.bottom + 8,
      42,
      42,
    );
    launcher.addEventListener("click", () => showPanel(rect));
  };

  const showPanel = (rect: DOMRect) => {
    const targetLanguage = targetFor(selectedText);
    const targetLabel =
      targetLanguage === "English"
        ? message("translateToEnglish", "译为英文")
        : message("translateToChinese", "译为中文");
    taskId = `selection_${crypto.randomUUID().replace(/-/g, "")}`;
    const currentTaskId = taskId;
    mount.innerHTML = `
      <section class="panel" role="dialog" tabindex="-1">
        <header><strong>Long Translate</strong><span>${targetLabel}</span></header>
        <p class="source"></p>
        <div class="result" role="status" aria-live="polite"><span class="spinner"></span><span class="progress"></span></div>
        <footer>
          <button class="cancel" type="button"></button>
          <button class="save" type="button" hidden></button>
          <button class="copy" type="button" hidden></button>
          <button class="close" type="button">×</button>
        </footer>
      </section>`;
    const panel = mount.querySelector<HTMLElement>(".panel");
    if (!panel) return;
    panel.setAttribute(
      "aria-label",
      message("selectionDialogAria", "Long Translate 划词翻译"),
    );
    const progress = panel.querySelector<HTMLElement>(".progress");
    if (progress) progress.textContent = message("translating", "正在翻译…");
    const cancel = panel.querySelector<HTMLButtonElement>(".cancel");
    const save = panel.querySelector<HTMLButtonElement>(".save");
    const copy = panel.querySelector<HTMLButtonElement>(".copy");
    const close = panel.querySelector<HTMLButtonElement>(".close");
    if (cancel) cancel.textContent = message("cancel", "取消");
    if (save) save.textContent = message("saveToWordbook", "收藏到生词本");
    if (copy) copy.textContent = message("copyTranslation", "复制译文");
    if (close) close.setAttribute("aria-label", message("close", "关闭"));
    position(
      panel,
      rect.left,
      rect.bottom + 10,
      Math.min(340, window.innerWidth - 24),
      220,
    );
    const source = panel.querySelector<HTMLElement>(".source");
    if (source) source.textContent = selectedText;
    cancel?.addEventListener("click", () => {
      if (!taskId) return;
      runtime.sendMessage({ type: "native-cancel", taskId }, () => undefined);
      taskId = undefined;
      setResult(panel, message("cancelled", "已取消"), "muted");
    });
    panel.querySelector(".close")?.addEventListener("click", () => hide(true));
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hide(true);
    });
    panel.querySelector<HTMLButtonElement>(".cancel")?.focus();

    runtime.sendMessage(
      {
        type: "native-translate",
        taskId,
        input: {
          text: selectedText,
          targetLanguage,
          format: "plain_text",
        },
      },
      (response) => {
        if (taskId !== currentTaskId) return;
        taskId = undefined;
        const runtimeError = runtime.lastError?.message?.trim();
        const reply = isReply(response) ? response : undefined;
        const translated = reply?.ok ? reply.result?.text?.trim() : undefined;
        if (runtimeError || !translated) {
          setResult(
            panel,
            friendlyError(runtimeError || reply?.error, message),
            "error",
          );
          return;
        }
        setResult(panel, translated, "success");
        if (save) {
          save.hidden = false;
          save.addEventListener("click", () => {
            if (save.dataset.saved === "true") return;
            save.disabled = true;
            save.textContent = message("saving", "正在收藏…");
            runtime.sendMessage(
              {
                type: "native-add-word",
                input: { word: selectedText, translation: translated },
              },
              (saveResponse) => {
                const saveError = runtime.lastError?.message?.trim();
                const saveReply = isReply(saveResponse)
                  ? saveResponse
                  : undefined;
                if (saveError || !saveReply?.ok) {
                  save.disabled = false;
                  save.textContent = friendlySaveError(
                    saveError || saveReply?.error,
                    message,
                  );
                  return;
                }
                save.dataset.saved = "true";
                save.textContent = message("saved", "已收藏");
              },
            );
          });
        }
        if (copy) {
          copy.hidden = false;
          copy.addEventListener(
            "click",
            () => {
              void navigator.clipboard
                .writeText(translated)
                .then(() => {
                  copy.textContent = message("copied", "已复制");
                })
                .catch(() => {
                  copy.textContent = message("copyFailed", "复制失败");
                });
            },
            { once: true },
          );
        }
      },
    );
  };

  const inspectSelection = (event: Event) => {
    if (event.composedPath().includes(host)) return;
    const version = ++selectionVersion;
    queueMicrotask(() => {
      if (version !== selectionVersion || taskId) return;
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      if (!selection || selection.rangeCount === 0 || !text) {
        hide();
        return;
      }
      if (textEncoder.encode(text).byteLength > MAX_SELECTION_BYTES) {
        showMessage(
          selection.getRangeAt(0).getBoundingClientRect(),
          message("selectionTooLarge", "所选文字超过 32 KiB"),
        );
        return;
      }
      showLauncher(text, selection.getRangeAt(0).getBoundingClientRect());
    });
  };

  document.addEventListener("mouseup", inspectSelection, true);
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.key === "Shift" || event.shiftKey) inspectSelection(event);
    },
    true,
  );

  window.addEventListener("pagehide", () => hide(true), { once: true });

  function showMessage(rect: DOMRect, message: string) {
    mount.innerHTML = `<div class="notice" role="status"></div>`;
    const notice = mount.firstElementChild as HTMLElement;
    notice.textContent = message;
    position(notice, rect.left, rect.bottom + 8, 260, 48);
  }
}

function setResult(panel: HTMLElement, text: string, state: string): void {
  const result = panel.querySelector<HTMLElement>(".result");
  if (result) {
    result.className = `result ${state}`;
    result.textContent = text;
  }
  panel.querySelector<HTMLButtonElement>(".cancel")?.setAttribute("hidden", "");
}

function targetFor(text: string): "Chinese" | "English" {
  return /[\u3400-\u9fff]/u.test(text) ? "English" : "Chinese";
}

type MessageLookup = (key: string, fallback: string) => string;

function friendlyError(
  error: string | undefined,
  message: MessageLookup,
): string {
  if (error?.includes("pairing_required"))
    return message("approvePairingFirst", "请先在桌面端批准浏览器配对");
  if (
    error?.toLowerCase().includes("desktop") ||
    error?.includes("host not found")
  ) {
    return message("startDesktopFirst", "请先启动 Long Translate 桌面端");
  }
  if (error?.includes("cancel")) return message("cancelled", "已取消");
  return message("translationFailed", "翻译失败，请稍后重试");
}

function friendlySaveError(
  error: string | undefined,
  message: MessageLookup,
): string {
  if (error?.includes("pairing_required"))
    return message("updateDesktopAccess", "请更新桌面授权");
  if (
    error?.toLowerCase().includes("desktop") ||
    error?.includes("host not found")
  ) {
    return message("desktopNotRunning", "桌面端未运行");
  }
  return message("saveFailed", "收藏失败，请重试");
}

function isReply(value: unknown): value is TranslationReply {
  if (typeof value !== "object" || value === null) return false;
  const reply = value as Record<string, unknown>;
  return typeof reply.ok === "boolean";
}

function position(
  element: HTMLElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const margin = 12;
  const left = Math.max(
    margin,
    Math.min(x, window.innerWidth - width - margin),
  );
  const top = Math.max(
    margin,
    Math.min(y, window.innerHeight - height - margin),
  );
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

const overlayStyles = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; }
  button, section, div, p, header, footer, span, strong { font-family: Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .launcher { position: fixed; width: 38px; height: 38px; border: 0; border-radius: 12px 12px 12px 4px; background: #5b7cfa; color: #fff; box-shadow: 0 8px 24px rgb(15 23 42 / 28%); font-size: 16px; font-weight: 800; cursor: pointer; }
  .panel { position: fixed; width: min(340px, calc(100vw - 24px)); max-height: min(420px, calc(100vh - 24px)); overflow: auto; border: 1px solid #dbe3f0; border-radius: 16px 16px 16px 6px; background: #f8faff; color: #172033; box-shadow: 0 18px 48px rgb(15 23 42 / 24%); padding: 14px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  header strong { color: #3159d9; font-size: 14px; }
  header span { color: #66738a; font-size: 12px; }
  .source { max-height: 72px; overflow: hidden; margin: 12px 0; padding: 9px 10px; border-radius: 9px; background: #eaf0fb; color: #56647b; font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
  .result { min-height: 52px; color: #34425a; font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .result.error { color: #b4233c; }
  .result.muted { color: #748198; }
  .spinner { display: inline-block; width: 12px; height: 12px; margin-right: 7px; border: 2px solid #bdc9df; border-top-color: #5b7cfa; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  footer button { min-height: 30px; border: 0; border-radius: 8px; padding: 0 10px; background: #e8eef9; color: #34425a; cursor: pointer; }
  footer .copy, footer .save { background: #5b7cfa; color: #fff; }
  footer .close { width: 30px; padding: 0; font-size: 18px; }
  .notice { position: fixed; min-width: 220px; border-radius: 10px; background: #172033; color: #fff; box-shadow: 0 10px 30px rgb(15 23 42 / 24%); padding: 11px 13px; font: 12px/1.4 Inter, "Segoe UI", sans-serif; }
  @media (prefers-color-scheme: dark) {
    .panel { border-color: #33415d; background: #111a2b; color: #eaf0fb; }
    .source { background: #1c2940; color: #aebbd0; }
    .result { color: #dce5f5; }
    footer button { background: #26344d; color: #dce5f5; }
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

const selectionChrome = (
  globalThis as typeof globalThis & { chrome?: SelectionChrome }
).chrome;
if (selectionChrome && !document.getElementById(ROOT_ID)) {
  installSelectionOverlay(selectionChrome.runtime, selectionChrome.i18n);
}
