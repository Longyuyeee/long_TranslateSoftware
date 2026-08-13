import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isTemporaryBrowserProfile,
  removeTemporaryBrowserProfile,
} from "./browser-smoke-cleanup.mjs";

const profile = join(tmpdir(), "long-translate-browser-smoke-test-profile");

describe("browser smoke profile cleanup", () => {
  it("accepts only smoke-owned temporary profiles", () => {
    expect(isTemporaryBrowserProfile(profile)).toBe(true);
    expect(isTemporaryBrowserProfile(join(tmpdir(), "unrelated-profile"))).toBe(false);
    expect(isTemporaryBrowserProfile(process.cwd())).toBe(false);
  });

  it("retries transient Windows locks with bounded backoff", async () => {
    const locked = Object.assign(new Error("locked"), { code: "EBUSY" });
    const remove = vi.fn()
      .mockImplementationOnce(() => { throw locked; })
      .mockImplementationOnce(() => { throw locked; })
      .mockImplementationOnce(() => undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await removeTemporaryBrowserProfile(profile, { remove, wait, maxAttempts: 4 });

    expect(remove).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 100);
    expect(wait).toHaveBeenNthCalledWith(2, 200);
  });

  it("does not retry unexpected errors or exceed the attempt limit", async () => {
    const denied = Object.assign(new Error("bad path"), { code: "EINVAL" });
    const removeUnexpected = vi.fn(() => { throw denied; });
    const waitUnexpected = vi.fn();
    await expect(removeTemporaryBrowserProfile(profile, {
      remove: removeUnexpected,
      wait: waitUnexpected,
    })).rejects.toBe(denied);
    expect(removeUnexpected).toHaveBeenCalledOnce();
    expect(waitUnexpected).not.toHaveBeenCalled();

    const locked = Object.assign(new Error("locked"), { code: "EPERM" });
    const removeLocked = vi.fn(() => { throw locked; });
    const waitLocked = vi.fn().mockResolvedValue(undefined);
    await expect(removeTemporaryBrowserProfile(profile, {
      remove: removeLocked,
      wait: waitLocked,
      maxAttempts: 3,
    })).rejects.toBe(locked);
    expect(removeLocked).toHaveBeenCalledTimes(3);
    expect(waitLocked).toHaveBeenCalledTimes(2);
  });

  it("refuses an unrelated path before invoking removal", async () => {
    const remove = vi.fn();
    await expect(removeTemporaryBrowserProfile(process.cwd(), { remove }))
      .rejects.toThrow("Refusing to remove");
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects a cleanup configuration that would skip removal", async () => {
    const remove = vi.fn();
    await expect(removeTemporaryBrowserProfile(profile, {
      remove,
      maxAttempts: 0,
    })).rejects.toThrow("at least one attempt");
    expect(remove).not.toHaveBeenCalled();
  });
});
