import { describe, expect, it, vi } from "vitest";
import { type ChromeEvent, type NativePort } from "./native-client";
import {
  installNativeSmokeListener,
  type ExtensionRuntime,
} from "./service-worker";

class CapturingEvent<T extends unknown[]> implements ChromeEvent<T> {
  listener?: (...args: T) => void;

  addListener(listener: (...args: T) => void): void {
    this.listener = listener;
  }

  removeListener(listener: (...args: T) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }
}

describe("browser service worker boundary", () => {
  it("ignores messages that do not come from this extension", () => {
    const onMessage = new CapturingEvent<[
      unknown,
      { id?: string },
      (response: unknown) => void,
    ]>();
    const connectNative = vi.fn<() => NativePort>();
    const runtime: ExtensionRuntime = {
      id: "imaogjlfhfohdnngppnfhapdfkaldmkn",
      getManifest: () => ({ version: "0.1.0" }),
      connectNative,
      onMessage,
    };
    installNativeSmokeListener(runtime);

    onMessage.listener?.(
      { type: "native-smoke" },
      { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      vi.fn(),
    );

    expect(connectNative).not.toHaveBeenCalled();
  });
});
