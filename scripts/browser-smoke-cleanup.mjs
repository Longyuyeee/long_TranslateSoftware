import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE_WINDOWS_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const PROFILE_PREFIX = "long-translate-browser-smoke-";

export function isTemporaryBrowserProfile(profile) {
  const resolvedProfile = resolve(profile);
  const expectedRoot = `${resolve(tmpdir())}${sep}`;
  return resolvedProfile.startsWith(expectedRoot)
    && basename(resolvedProfile).startsWith(PROFILE_PREFIX);
}

/** Removes only this smoke test's profile, allowing Windows browser handles to settle. */
export async function removeTemporaryBrowserProfile(
  profile,
  {
    remove = (path) => rmSync(path, { recursive: true, force: true }),
    wait = delay,
    maxAttempts = 8,
  } = {},
) {
  if (!isTemporaryBrowserProfile(profile)) {
    throw new Error(`Refusing to remove an unexpected browser profile: ${profile}`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Browser profile cleanup requires at least one attempt");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      remove(resolve(profile));
      return;
    } catch (error) {
      const retryable = error && RETRYABLE_WINDOWS_CODES.has(error.code);
      if (!retryable || attempt === maxAttempts) throw error;
      await wait(Math.min(100 * (2 ** (attempt - 1)), 500));
    }
  }
}
