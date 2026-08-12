import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const extensionRoot = resolve(process.cwd(), "browser-extension");
const sourceManifestPath = resolve(extensionRoot, "public/manifest.json");
const builtManifestPath = resolve(extensionRoot, "dist/manifest.json");
const nsisHooksPath = resolve(process.cwd(), "src-tauri/windows/native-host-hooks.nsh");
const wixFragmentPath = resolve(process.cwd(), "src-tauri/windows/native-host.wxs");
const maximumPackageBytes = 64 * 1024;

const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
const builtManifest = JSON.parse(readFileSync(builtManifestPath, "utf8"));
const extensionId = extensionIdFromKey(sourceManifest.key);
const extensionOrigin = `chrome-extension://${extensionId}/`;

if (sourceManifest.manifest_version !== 3) {
  throw new Error("Browser extension must use Manifest V3");
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
