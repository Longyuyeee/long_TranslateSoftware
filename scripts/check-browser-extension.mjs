import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const extensionRoot = resolve(process.cwd(), "browser-extension");
const sourceManifestPath = resolve(extensionRoot, "public/manifest.json");
const builtManifestPath = resolve(extensionRoot, "dist/manifest.json");
const desktopConfigPath = resolve(process.cwd(), "src-tauri/tauri.conf.json");
const localeNames = ["en", "zh_CN"];
const nsisHooksPath = resolve(process.cwd(), "src-tauri/windows/native-host-hooks.nsh");
const wixFragmentPath = resolve(process.cwd(), "src-tauri/windows/native-host.wxs");
const maximumPackageBytes = 64 * 1024;

const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
const builtManifest = JSON.parse(readFileSync(builtManifestPath, "utf8"));
const desktopConfig = JSON.parse(readFileSync(desktopConfigPath, "utf8"));
const extensionId = extensionIdFromKey(sourceManifest.key);
const extensionOrigin = `chrome-extension://${extensionId}/`;

if (sourceManifest.manifest_version !== 3) {
  throw new Error("Browser extension must use Manifest V3");
}
if (sourceManifest.version !== desktopConfig.version) {
  throw new Error(
    `Browser extension version ${sourceManifest.version} differs from desktop version ${desktopConfig.version}`,
  );
}
if (
  sourceManifest.default_locale !== "en" ||
  sourceManifest.name !== "__MSG_extensionName__" ||
  sourceManifest.description !== "__MSG_extensionDescription__" ||
  sourceManifest.action?.default_title !== "__MSG_extensionActionTitle__"
) {
  throw new Error("Browser extension manifest localization contract is invalid");
}
if (
  JSON.stringify(sourceManifest.permissions) !==
    JSON.stringify(["nativeMessaging", "activeTab", "scripting"]) ||
  "host_permissions" in sourceManifest ||
  "content_scripts" in sourceManifest
) {
  throw new Error("Browser extension permissions exceed the reviewed active-tab boundary");
}
if (
  sourceManifest.background?.service_worker !== "assets/service-worker.js" ||
  sourceManifest.background?.type !== "module"
) {
  throw new Error("Browser extension service worker contract is invalid");
}
if (JSON.stringify(sourceManifest) !== JSON.stringify(builtManifest)) {
  throw new Error("Built extension manifest differs from its reviewed source");
}

const localeCatalogs = localeNames.map((locale) => {
  const sourcePath = resolve(extensionRoot, `public/_locales/${locale}/messages.json`);
  const builtPath = resolve(extensionRoot, `dist/_locales/${locale}/messages.json`);
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const built = JSON.parse(readFileSync(builtPath, "utf8"));
  if (JSON.stringify(source) !== JSON.stringify(built)) {
    throw new Error(`Built ${locale} locale differs from its reviewed source`);
  }
  for (const [key, value] of Object.entries(source)) {
    if (typeof value?.message !== "string" || value.message.trim().length === 0) {
      throw new Error(`${locale} locale message ${key} is empty or invalid`);
    }
  }
  return [locale, source];
});
const expectedLocaleKeys = Object.keys(localeCatalogs[0][1]).sort();
for (const [locale, catalog] of localeCatalogs.slice(1)) {
  if (JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(expectedLocaleKeys)) {
    throw new Error(`${locale} locale keys differ from the default locale`);
  }
}
const localizedSources = [
  readFileSync(resolve(extensionRoot, "popup.html"), "utf8"),
  readFileSync(resolve(extensionRoot, "src/popup.ts"), "utf8"),
  readFileSync(resolve(extensionRoot, "src/content-script.ts"), "utf8"),
  JSON.stringify(sourceManifest),
].join("\n");
const referencedLocaleKeys = new Set([
  ...[...localizedSources.matchAll(/data-i18n="([A-Za-z0-9_]+)"/gu)].map((match) => match[1]),
  ...[...localizedSources.matchAll(/message\("([A-Za-z0-9_]+)"/gu)].map((match) => match[1]),
  ...[...localizedSources.matchAll(/__MSG_([A-Za-z0-9_]+)__/gu)].map((match) => match[1]),
]);
for (const key of referencedLocaleKeys) {
  if (!expectedLocaleKeys.includes(key)) {
    throw new Error(`Browser extension references missing locale message ${key}`);
  }
}

for (const installerPath of [nsisHooksPath, wixFragmentPath]) {
  const installer = readFileSync(installerPath, "utf8");
  if (!installer.includes(extensionOrigin)) {
    throw new Error(`${installerPath} does not register ${extensionOrigin}`);
  }
}

const nsisHooks = readFileSync(nsisHooksPath, "utf8");
if (
  !nsisHooks.includes("NSIS_HOOK_POSTUNINSTALL") ||
  !nsisHooks.includes("$UpdateMode <> 1") ||
  !nsisHooks.includes("SetRegView 64") ||
  nsisHooks.includes("NSIS_HOOK_PREUNINSTALL")
) {
  throw new Error("NSIS Native Host cleanup must run after a non-update uninstall");
}

const wixFragment = readFileSync(wixFragmentPath, "utf8");
if (!wixFragment.includes("--unregister-native-host")) {
  throw new Error("WiX Native Host transaction does not unregister the Host");
}
for (const action of [
  "RollbackLongTranslateNativeHostRegistration",
  "RegisterLongTranslateNativeHost",
  "RollbackLongTranslateNativeHostUnregistration",
  "UnregisterLongTranslateNativeHost",
]) {
  if (!wixFragment.includes(action)) {
    throw new Error(`WiX Native Host transaction is missing ${action}`);
  }
}

const files = walk(resolve(extensionRoot, "dist"));
const contentScriptPath = resolve(extensionRoot, "dist/assets/content-script.js");
if (!files.includes(contentScriptPath)) {
  throw new Error("Built extension is missing the reviewed content script entry");
}
const contentScript = readFileSync(contentScriptPath, "utf8");
if (/\b(?:import|export)\s/u.test(contentScript)) {
  throw new Error("Injected content script must be a self-contained classic script");
}
const popupCssPath = files.find((file) => /popup-[^\\/]+\.css$/u.test(file));
if (!popupCssPath || !readFileSync(popupCssPath, "utf8").includes("prefers-color-scheme:dark")) {
  throw new Error("Browser extension popup must preserve automatic light/dark theme support");
}
const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
if (totalBytes > maximumPackageBytes) {
  throw new Error(
    `Browser extension package is ${(totalBytes / 1024).toFixed(2)} KiB; limit is ${maximumPackageBytes / 1024} KiB`,
  );
}

console.log(`Development extension ID: ${extensionId}`);
console.log(`Browser extension package: ${(totalBytes / 1024).toFixed(2)} KiB`);
console.log(`Extension package limit: ${maximumPackageBytes / 1024} KiB`);

function extensionIdFromKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Browser extension manifest key is missing");
  }
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
