import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const extensionDirectory = resolve(process.argv[2] || "browser-extension/dist");
const extensionId = "imaogjlfhfohdnngppnfhapdfkaldmkn";
const extensionOrigin = `chrome-extension://${extensionId}`;
const popupUrl = `${extensionOrigin}/popup.html`;
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
const locales = [
  { language: "en-US", expectedTitle: "Desktop bridge check" },
  { language: "zh-CN", expectedTitle: "桌面桥接检查" },
];
const results = [];

for (const candidate of browserCandidates) {
  const executable = candidate.paths.find((path) => path && existsSync(path));
  if (!executable) throw new Error(`${candidate.name} was not found`);
  for (const locale of locales) {
    try {
      results.push(
        await inspectPopup(
          candidate.name,
          executable,
          locale.language,
          locale.expectedTitle,
        ),
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

async function inspectPopup(browserName, executable, language, expectedTitle) {
  const profile = mkdtempSync(join(tmpdir(), "long-translate-browser-smoke-"));
  const port = await reservePort();
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
      `--lang=${language}`,
      "about:blank",
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
        `${browserName} ${language} did not open its debugging endpoint: ${sanitize(stderr)}`,
      );
    }

    const popupTarget = await jsonRequest(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(popupUrl)}`,
      { method: "PUT" },
    );
    const page = await readPageState(popupTarget.webSocketDebuggerUrl);
    const { html } = page;
    if (!html.includes(`data-i18n="popupTitle">${expectedTitle}</h1>`)) {
      const heading = html.match(/<h1[^>]*>([^<]*)<\/h1>/u)?.[1] || "<missing>";
      throw new Error(
        `${browserName} ${language} did not render the localized extension popup (heading=${heading}, title=${page.title}, url=${page.url}, body=${page.body.slice(0, 120)})`,
      );
    }
    if (!html.includes('id="check"') || !html.includes('id="enable-selection"')) {
      throw new Error(`${browserName} ${language} popup controls are incomplete`);
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
      throw new Error(`${browserName} ${language} did not expose the extension service worker`);
    }
    return {
      browser: browserName,
      executable: basename(executable),
      language,
      popupTitle: expectedTitle,
      extensionLoaded: true,
    };
  } finally {
    browser.kill();
    await Promise.race([
      new Promise((done) => browser.once("close", done)),
      new Promise((done) => setTimeout(done, 2_000)),
    ]);
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

async function readPageState(webSocketUrl) {
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
              expression:
                "({html: document.documentElement.outerHTML, url: location.href, title: document.title, body: document.body?.innerText || ''})",
              returnByValue: true,
            }),
          250,
        );
      } else if (response.id === 2) {
        clearTimeout(timer);
        socket.close();
        const page = response.result?.result?.value;
        if (page && typeof page.html === "string") resolveHtml(page);
        else rejectHtml(new Error("Popup DOM evaluation returned no page state"));
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

function sanitize(value) {
  return value.replaceAll(extensionDirectory, "<extension>").slice(0, 500).trim();
}
