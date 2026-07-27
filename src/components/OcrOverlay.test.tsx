// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hideMock, invokeMock } = vi.hoisted(() => ({
  hideMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    hide: hideMock,
    scaleFactor: vi.fn().mockResolvedValue(1),
    outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  }),
}));

import OcrOverlay from "./OcrOverlay";

beforeEach(() => {
  hideMock.mockReset().mockResolvedValue(undefined);
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === "get_config_value") return Promise.resolve("en");
    if (command === "get_screen_bounds") {
      return Promise.resolve({ physical_x: 0, physical_y: 0, factor: 1, count: 1 });
    }
    if (command === "capture_and_ocr") return Promise.resolve("Recognized text");
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
});

describe("OcrOverlay review dialog", () => {
  it("provides dialog semantics, initial focus, focus containment and Escape dismissal", async () => {
    const user = userEvent.setup();
    const { container } = render(<OcrOverlay />);
    const overlay = container.firstElementChild as HTMLElement;

    fireEvent.mouseDown(overlay, { clientX: 20, clientY: 20 });
    fireEvent.mouseMove(overlay, { clientX: 180, clientY: 100 });
    fireEvent.mouseUp(overlay);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Review recognized text");
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveFocus();

    const confirm = screen.getByRole("button", { name: "Confirm & translate" });
    confirm.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(hideMock).toHaveBeenCalledOnce();
  });
});
