import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) =>
  readFileSync(resolve(repositoryRoot, ".github", "workflows", name), "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const commandPattern = (command) =>
  new RegExp(`^\\s*run:\\s*${escapeRegExp(command)}\\s*$`, "m");

const requiredQualityCommands = [
  "npm test",
  "npm audit --audit-level=high",
  "npm run build",
  "npm run audit:bundle",
  "npm run audit:extension",
  "npm run smoke:browser:runtime",
  "cargo test --manifest-path src-tauri/Cargo.toml --test lifecycle_process",
  "cargo test --manifest-path src-tauri/Cargo.toml",
  "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings",
  "npm run quality:report -- --require-runtime",
];

describe("GitHub release quality gates", () => {
  it("keeps the merge and release workflows on the same explicit gates", () => {
    for (const name of ["ci.yml", "release.yml"]) {
      const contents = workflow(name);
      for (const command of requiredQualityCommands) {
        expect(contents, `${name} is missing: ${command}`).toMatch(commandPattern(command));
      }
    }
  });

  it("runs every release gate and uploads its report before publishing", () => {
    const contents = workflow("release.yml");
    const publishIndex = contents.indexOf("- name: Build, sign and publish");
    expect(publishIndex).toBeGreaterThan(0);

    for (const command of requiredQualityCommands) {
      const gateIndex = contents.search(commandPattern(command));
      expect(gateIndex, `${command} must run before publishing`).toBeGreaterThan(0);
      expect(gateIndex, `${command} must run before publishing`).toBeLessThan(publishIndex);
    }

    const reportUploadIndex = contents.indexOf("- name: Upload quality report artifact");
    expect(reportUploadIndex).toBeGreaterThan(0);
    expect(reportUploadIndex).toBeLessThan(publishIndex);
    expect(contents).toMatch(/dtolnay\/rust-toolchain@stable\s+with:\s+components: clippy/);
  });
});
