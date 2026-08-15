import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(scriptsDirectory, "word-docx-acceptance.ps1");

describe("Microsoft Word DOCX acceptance runner", () => {
  it("rejects WPS identity evidence and incomplete corpora in its self-test", () => {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", runnerPath,
      "-SelfTest",
    ], { encoding: "utf8", timeout: 15_000 });

    expect(result.error, result.stderr || result.stdout).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Word DOCX acceptance self-test passed.");
  }, 20_000);

  it("keeps engine identity, source hashes, isolated sessions, and review evidence mandatory", () => {
    const source = readFileSync(runnerPath, "utf8");

    expect(source).toContain("Get-AuthenticodeSignature");
    expect(source).toContain("Microsoft.PowerShell.Utility");
    expect(source.indexOf("Join-Path $PSHOME"))
      .toBeLessThan(source.indexOf("New-Object -ComObject Word.Application"));
    expect(source).toContain("Microsoft Corporation");
    expect(source).toContain("kingsoft|wps office");
    expect(source).toContain("AutomationSecurity = 3");
    expect(source).toContain("UpdateLinksAtOpen = $false");
    expect(source).toContain("Get-FileHash");
    expect(source).toContain("Resolve-OutputDirectoryPath $OutputDirectory");
    expect(source).toContain("Self-test changed an absolute output path");
    expect(source).toContain("Test-WordActivationEvidence");
    expect(source).toContain("Microsoft Word is not activated");
    expect(source).toContain("$wordPidsBefore");
    expect(source).toContain("$process.MainWindowHandle -eq [IntPtr]::Zero");
    expect(source).toContain("foreach ($file in $files)");
    expect(source).toContain("$session = Open-VerifiedWord");
    expect(source).toContain("word-render-manifest.json");
    expect(source).toContain("review.md");
  });
});
