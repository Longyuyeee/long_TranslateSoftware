import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...segments) => readFileSync(resolve(repositoryRoot, ...segments), "utf8");

describe("Windows installer Native Host contract", () => {
  it("links the WiX fragment into the MSI feature", () => {
    const config = JSON.parse(read("src-tauri", "tauri.conf.json"));
    const wix = config.bundle.windows.wix;
    const fragment = read("src-tauri", "windows", "native-host.wxs");

    expect(wix.fragmentPaths).toContain("./windows/native-host.wxs");
    expect(wix.componentRefs).toContain("LongTranslateNativeHostIntegration");
    expect(fragment).toContain('<Component Id="LongTranslateNativeHostIntegration"');
    expect(fragment).toContain('Custom Action="RegisterLongTranslateNativeHost"');
    expect(fragment).toContain('Custom Action="UnregisterLongTranslateNativeHost"');
  });

  it("keeps both installers on the user-writable manifest location", () => {
    const registration = read("src-tauri", "src", "native_registration.rs");
    const nsisHooks = read("src-tauri", "windows", "native-host-hooks.nsh");

    expect(registration).toContain('std::env::var_os("LOCALAPPDATA")');
    expect(registration).toContain('.join("native-messaging")');
    expect(nsisHooks).toContain(
      "$LOCALAPPDATA\\com.long.translate\\native-messaging\\com.long.translate.json",
    );
  });
});
