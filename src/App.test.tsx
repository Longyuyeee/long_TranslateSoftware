// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const windowState = vi.hoisted(() => ({ label: "main" }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowState.label }),
}));

vi.mock("./components/Dashboard", () => ({
  default: () => <div data-testid="dashboard-window" />,
}));

vi.mock("./components/FloatingWindow", () => ({
  default: () => <div data-testid="floating-window" />,
}));

vi.mock("./components/OcrOverlay", () => ({
  default: () => <div data-testid="ocr-window" />,
}));

describe("application window routing", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it.each([
    ["main", "dashboard-window"],
    ["floating", "floating-window"],
    ["ocr-overlay", "ocr-window"],
  ])("loads the %s window entry point on demand", async (label, testId) => {
    windowState.label = label;
    render(<App />);

    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it("uses the main window in browser preview mode", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    windowState.label = "floating";
    render(<App />);

    expect(await screen.findByTestId("dashboard-window")).toBeInTheDocument();
  });
});
