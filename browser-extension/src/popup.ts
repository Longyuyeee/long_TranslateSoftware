interface SmokeSuccess {
  ok: true;
  result: {
    desktopVersion: string;
    pairingState: string;
    latencyMs: number;
  };
}

interface SmokeFailure {
  ok: false;
  error: string;
}

interface PopupRuntime {
  lastError?: { message?: string };
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
}

export {};

interface PopupTab {
  id?: number;
  url?: string;
}

interface PopupChrome {
  runtime: PopupRuntime;
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }, callback: (tabs: PopupTab[]) => void): void;
  };
  scripting: {
    executeScript(
      injection: { target: { tabId: number }; files: string[] },
      callback: () => void,
    ): void;
  };
}

declare const chrome: PopupChrome;

const checkButton = requiredElement<HTMLButtonElement>("check");
const statusElement = requiredElement<HTMLParagraphElement>("status");
const details = requiredElement<HTMLDListElement>("details");
const desktopVersion = requiredElement<HTMLElement>("desktop-version");
const pairingState = requiredElement<HTMLElement>("pairing-state");
const latency = requiredElement<HTMLElement>("latency");
const enableSelectionButton = requiredElement<HTMLButtonElement>("enable-selection");
const selectionStatus = requiredElement<HTMLParagraphElement>("selection-status");

enableSelectionButton.addEventListener("click", () => {
  enableSelectionButton.disabled = true;
  selectionStatus.dataset.state = "pending";
  selectionStatus.textContent = "正在启用…";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const queryError = chrome.runtime.lastError?.message?.trim();
    const tabId = tabs[0]?.id;
    const tabUrl = tabs[0]?.url;
    if (queryError || tabId === undefined || !/^https?:\/\//u.test(tabUrl || "")) {
      showSelectionFailure(queryError || "无法访问当前页面");
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["assets/content-script.js"],
    }, () => {
      const injectionError = chrome.runtime.lastError?.message?.trim();
      if (injectionError) {
        showSelectionFailure("此页面不允许注入扩展，请在普通网页中重试");
        return;
      }
      selectionStatus.dataset.state = "success";
      selectionStatus.textContent = "当前页面已启用，选中文字后点击“译”";
      enableSelectionButton.textContent = "当前页面已启用";
    });
  });
});

checkButton.addEventListener("click", () => {
  checkButton.disabled = true;
  statusElement.dataset.state = "pending";
  statusElement.textContent = "正在连接桌面端…";
  details.hidden = true;

  chrome.runtime.sendMessage({ type: "native-smoke" }, (response) => {
    checkButton.disabled = false;
    const runtimeError = chrome.runtime.lastError?.message?.trim();
    if (runtimeError) {
      showFailure(runtimeError);
      return;
    }
    if (!isSmokeResponse(response)) {
      showFailure("扩展返回了无法识别的检查结果");
      return;
    }
    if (!response.ok) {
      showFailure(response.error);
      return;
    }

    statusElement.dataset.state = "success";
    statusElement.textContent = "桌面桥接可用";
    desktopVersion.textContent = response.result.desktopVersion;
    pairingState.textContent = response.result.pairingState;
    latency.textContent = `${response.result.latencyMs} ms`;
    details.hidden = false;
  });
});

function showFailure(message: string): void {
  statusElement.dataset.state = "error";
  statusElement.textContent = message;
  details.hidden = true;
}

function showSelectionFailure(message: string): void {
  enableSelectionButton.disabled = false;
  selectionStatus.dataset.state = "error";
  selectionStatus.textContent = message;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
}

function isSmokeResponse(value: unknown): value is SmokeSuccess | SmokeFailure {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.error === "string";
  const result = value.result;
  return (
    isRecord(result) &&
    typeof result.desktopVersion === "string" &&
    typeof result.pairingState === "string" &&
    typeof result.latencyMs === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
