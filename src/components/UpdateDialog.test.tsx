// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import UpdateDialog from "./UpdateDialog";

const labels = {
  updateAvailableTitle: "Update available",
  updateVersionLabel: "Version {version}",
  close: "Close",
  updateSignatureHint: "The package signature will be verified.",
  updateInstalling: "Installing",
  updateDownloading: "Downloading",
  updateDoNotClose: "Do not close the app.",
  updateInstallFailed: "Installation failed.",
  updateLater: "Later",
  retry: "Retry",
  updateNow: "Update now",
};

afterEach(() => {
  cleanup();
});

describe("UpdateDialog", () => {
  it("focuses the primary action and supports Escape before installation starts", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <UpdateDialog
        open
        version="0.4.5"
        notes="Security and reliability improvements"
        phase="available"
        progress={null}
        labels={labels}
        onInstall={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Update available");
    expect(screen.getByRole("button", { name: "Update now" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("locks dismissal and reports progress while an update is downloading", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <UpdateDialog
        open
        version="0.4.5"
        phase="downloading"
        progress={42}
        labels={labels}
        onInstall={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers a retry action with the returned installation error", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(
      <UpdateDialog
        open
        version="0.4.5"
        phase="error"
        progress={null}
        error="Signature verification failed"
        labels={labels}
        onInstall={onInstall}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Signature verification failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onInstall).toHaveBeenCalledOnce();
  });
});
