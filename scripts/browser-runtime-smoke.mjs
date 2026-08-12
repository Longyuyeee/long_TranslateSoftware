import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const requireDesktop = process.argv.includes("--require-desktop");
const extensionArgument = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("--"));
const extensionDirectory = resolve(extensionArgument || "browser-extension/dist");
const extensionId = "imaogjlfhfohdnngppnfhapdfkaldmkn";
const extensionOrigin = `chrome-extension://${extensionId}`;
const popupUrl = `${extensionOrigin}/popup.html`;
const contentScriptSource = readFileSync(
  join(extensionDirectory, "assets/content-script.js"),
  "utf8",
);
const timeoutMs = 20_000;

if (!existsSync(join(extensionDirectory, "manifest.json"))) {
  throw new Error(`Built extension was not found at ${extensionDirectory}`);
}

const browserCandidates = [
  {
    name: "Edge",
    paths: [
      join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
      join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
      join(process.env.LOCALAPPDATA || "", "Microsoft/Edge/Application/msedge.exe"),
    ],
  },
  {
    name: "Chrome",
    paths: [
      join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
      join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
      join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    ],
  },
];
const localizedPopup = {
  "en-US": {
    title: "Desktop bridge check",
    bridgeStatus: "Desktop bridge is available",
  },
  "zh-CN": { title: "桌面桥接检查", bridgeStatus: "桌面桥接可用" },
};
const locales = Object.keys(localizedPopup);
const results = [];

for (const candidate of browserCandidates) {
  const executable = candidate.paths.find((path) => path && existsSync(path));
  if (!executable) throw new Error(`${candidate.name} was not found`);
  for (const language of locales) {
    try {
      results.push(
        await inspectPopup(candidate.name, executable, language),
      );
    } catch (error) {
      if (
        candidate.name === "Chrome" &&
        error instanceof Error &&
        error.message.includes("ERR_BLOCKED_BY_CLIENT")
      ) {
        results.push({
          browser: candidate.name,
          executable: basename(executable),
          language: "manual",
          extensionLoaded: false,
          reason:
            "Official Chrome builds disable command-line extension loading; use chrome://extensions for the release smoke.",
        });
        break;
      }
      throw error;
    }
  }
}

const automated = results.filter((result) => result.extensionLoaded);
if (!automated.some((result) => result.browser === "Edge")) {
  throw new Error("No installed browser completed the real extension runtime smoke");
}
console.log(
  JSON.stringify(
    {
      status: results.some((result) => !result.extensionLoaded)
        ? "pass_with_manual_chrome_gate"
        : "pass",
      extensionId,
      results,
    },
    null,
    2,
  ),
);

async function inspectPopup(browserName, executable, requestedLanguage) {
  const profile = mkdtempSync(join(tmpdir(), "long-translate-browser-smoke-"));
  const port = await reservePort();
  const selectionPage = await serveSelectionPage();
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      `--lang=${requestedLanguage}`,
      selectionPage.url,
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  browser.stderr.setEncoding("utf8");
  browser.stderr.on("data", (chunk) => (stderr += chunk));

  try {
    const debuggerReady = await poll(async () => {
      const version = await jsonRequest(`http://127.0.0.1:${port}/json/version`);
      return typeof version.webSocketDebuggerUrl === "string" ? true : undefined;
    });
    if (!debuggerReady) {
      throw new Error(
        `${browserName} ${requestedLanguage} did not open its debugging endpoint: ${sanitize(stderr)}`,
      );
    }

    const popupTarget = await jsonRequest(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(popupUrl)}`,
      { method: "PUT" },
    );
    const page = await evaluatePage(
      popupTarget.webSocketDebuggerUrl,
      "({html: document.documentElement.outerHTML, url: location.href, title: document.title, body: document.body?.innerText || ''})",
      250,
    );
    const { html } = page;
    const heading = html.match(/<h1[^>]*>([^<]*)<\/h1>/u)?.[1] || "<missing>";
    const actualLanguage = Object.entries(localizedPopup).find(
      ([, messages]) => messages.title === heading,
    )?.[0];
    if (!actualLanguage) {
      throw new Error(
        `${browserName} ${requestedLanguage} did not render a supported localized extension popup (heading=${heading}, title=${page.title}, url=${page.url}, body=${page.body.slice(0, 120)})`,
      );
    }
    if (!html.includes('id="check"') || !html.includes('id="enable-selection"')) {
      throw new Error(`${browserName} ${requestedLanguage} popup controls are incomplete`);
    }
    const targets = await poll(async () => {
      const list = await jsonRequest(`http://127.0.0.1:${port}/json/list`);
      return list.some(
        (target) =>
          target.type === "service_worker" && target.url.startsWith(extensionOrigin),
      )
        ? list
        : undefined;
    });
    if (!targets) {
      throw new Error(`${browserName} ${requestedLanguage} did not expose the extension service worker`);
    }
    let selection;
    if (browserName === "Edge") {
      selection = await inspectSelectionOverlay(
        port,
        selectionPage.url,
      );
    }
    let bridge;
    if (requireDesktop && browserName === "Edge") {
      await evaluatePage(
        popupTarget.webSocketDebuggerUrl,
        "document.getElementById('check').click(); true",
      );
      bridge = await poll(async () => {
        const state = await evaluatePage(
          popupTarget.webSocketDebuggerUrl,
          "({status: document.getElementById('status')?.textContent || '', state: document.getElementById('status')?.dataset.state || '', detailsHidden: document.getElementById('details')?.hidden ?? true, desktopVersion: document.getElementById('desktop-version')?.textContent || '', pairingState: document.getElementById('pairing-state')?.textContent || '', latency: document.getElementById('latency')?.textContent || ''})",
        );
        return state.state === "success" || state.state === "error"
          ? state
          : undefined;
      });
      if (bridge?.state === "error") {
        throw new Error(
          `${browserName} ${requestedLanguage} desktop bridge failed: ${bridge.status.slice(0, 160)}`,
        );
      }
      if (
        !bridge ||
        bridge.status !== localizedPopup[actualLanguage].bridgeStatus ||
        bridge.detailsHidden ||
        !/^\d+\.\d+\.\d+$/u.test(bridge.desktopVersion) ||
        !/^\d+ ms$/u.test(bridge.latency) ||
        !bridge.pairingState
      ) {
        throw new Error(
          `${browserName} ${requestedLanguage} returned incomplete desktop bridge details`,
        );
      }
    }
    return {
      browser: browserName,
      executable: basename(executable),
      requestedLanguage,
      actualLanguage,
      popupTitle: heading,
      extensionLoaded: true,
      ...(selection ? { selectionOverlay: selection } : {}),
      ...(bridge
        ? {
            bridgeConnected: true,
            desktopVersion: bridge.desktopVersion,
            pairingState: bridge.pairingState,
            latency: bridge.latency,
          }
        : {}),
    };
  } finally {
    browser.kill();
    await Promise.race([
      new Promise((done) => browser.once("close", done)),
      new Promise((done) => setTimeout(done, 2_000)),
    ]);
    selectionPage.close();
    const resolvedProfile = resolve(profile);
    const expectedRoot = resolve(tmpdir()) + "\\";
    if (
      resolvedProfile.startsWith(expectedRoot) &&
      basename(resolvedProfile).startsWith("long-translate-browser-smoke-")
    ) {
      rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

async function inspectSelectionOverlay(port, pageUrl) {
  const pageTarget = await poll(async () => {
    const targets = await jsonRequest(`http://127.0.0.1:${port}/json/list`);
    return targets.find((target) => target.type === "page" && target.url === pageUrl);
  });
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error("Edge did not expose the isolated selection smoke page");
  }
  await evaluatePage(
    pageTarget.webSocketDebuggerUrl,
    `(() => {
      globalThis.__longTranslateSmokeMessages = [];
      globalThis.chrome = {
        runtime: {
          sendMessage(message, callback) {
            globalThis.__longTranslateSmokeMessages.push(message);
            callback({ ok: false, error: "pairing_required" });
          }
        },
        i18n: { getMessage: () => "" }
      };
      (0, eval)(${JSON.stringify(contentScriptSource)});
      return Boolean(document.getElementById("long-translate-selection-root"));
    })()`,
  );
  const launcher = await poll(async () => {
    const state = await evaluatePage(
      pageTarget.webSocketDebuggerUrl,
      `(() => {
        const text = document.getElementById("selection-source").firstChild;
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        const root = document.getElementById("long-translate-selection-root");
        return {
          root: Boolean(root),
          launcher: root?.shadowRoot?.querySelector(".launcher")?.textContent || "",
          panel: Boolean(root?.shadowRoot?.querySelector(".panel")),
          messages: globalThis.__longTranslateSmokeMessages?.length || 0,
        };
      })()`,
    );
    return state.launcher ? state : undefined;
  });
  if (!launcher?.root || launcher.panel || launcher.messages !== 0) {
    throw new Error("Edge selection overlay sent content before the user clicked its launcher");
  }
  const translated = await evaluatePage(
    pageTarget.webSocketDebuggerUrl,
    `(() => {
      const root = document.getElementById("long-translate-selection-root");
      root.shadowRoot.querySelector(".launcher").click();
      const message = globalThis.__longTranslateSmokeMessages[0];
      return {
        panel: Boolean(root.shadowRoot.querySelector(".panel")),
        messageType: message?.type,
        selectedText: message?.input?.text,
      };
    })()`,
  );
  if (
    !translated?.panel ||
    translated.messageType !== "native-translate" ||
    translated.selectedText !== "Hello from the isolated selection smoke page."
  ) {
    throw new Error("Edge selection overlay did not defer the selected text until launcher click");
  }
  await evaluatePage(pageTarget.webSocketDebuggerUrl, "location.reload(); true");
  const removedAfterRefresh = await poll(async () => {
    const state = await evaluatePage(
      pageTarget.webSocketDebuggerUrl,
      "({ready: document.readyState === 'complete', root: Boolean(document.getElementById('long-translate-selection-root'))})",
      100,
    );
    return state.ready ? !state.root : undefined;
  });
  if (!removedAfterRefresh) {
    throw new Error("Edge selection overlay remained injected after page refresh");
  }
  return {
    productionBundleLoaded: true,
    launcher: launcher.launcher,
    translationDeferredUntilClick: true,
    removedAfterRefresh: true,
  };
}

async function evaluatePage(webSocketUrl, expression, delayMs = 0) {
  return new Promise((resolveHtml, rejectHtml) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      rejectHtml(new Error(`Popup DOM did not become ready within ${timeoutMs} ms`));
    }, timeoutMs);
    let requestId = 0;
    const send = (method, params = {}) => {
      const id = ++requestId;
      socket.send(JSON.stringify({ id, method, params }));
      return id;
    };
    socket.addEventListener("open", () => send("Runtime.enable"));
    socket.addEventListener("message", (event) => {
      const response = JSON.parse(event.data);
      if (response.id === 1) {
        setTimeout(
          () =>
            send("Runtime.evaluate", {
              expression,
              returnByValue: true,
              awaitPromise: true,
            }),
          delayMs,
        );
      } else if (response.id === 2) {
        clearTimeout(timer);
        socket.close();
        if (response.result?.exceptionDetails) {
          rejectHtml(new Error("Popup evaluation failed"));
          return;
        }
        resolveHtml(response.result?.result?.value);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectHtml(new Error("Popup DevTools connection failed"));
    });
  });
}

async function poll(operation) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch {
      // The browser may not have opened its debugging endpoint yet.
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Browser debugging endpoint returned ${response.status}`);
  return response.json();
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not reserve a browser debugging port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function serveSelectionPage() {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      const body = "<!doctype html><html><head><title>Long Translate selection smoke</title></head><body><p id=\"selection-source\">Hello from the isolated selection smoke page.</p></body></html>";
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    server.unref();
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectServer(new Error("Could not open the isolated selection smoke page"));
        return;
      }
      resolveServer({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => {
          server.close();
        },
      });
    });
  });
}

function sanitize(value) {
  return value.replaceAll(extensionDirectory, "<extension>").slice(0, 500).trim();
}
