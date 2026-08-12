// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import BrowserPairingDialog from "./BrowserPairingDialog";

const request = {
  origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
  display_name: "Long Translate extension",
  capabilities: ["translation", "wordbook"],
};

afterEach(cleanup);

describe("BrowserPairingDialog", () => {
  it("shows the exact extension identity and requested capabilities", () => {
    render(
      <BrowserPairingDialog
        labels={translations.en}
        request={request}
        isUpdating={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      translations.en.browserPairingRequestTitle,
    );
    expect(screen.getByText(request.origin)).toBeInTheDocument();
    expect(screen.getByText("translation")).toBeInTheDocument();
    expect(screen.getByText("wordbook")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: translations.en.browserPairingApprove,
      }),
    ).toHaveFocus();
  });

  it("routes approval and Escape rejection without an implicit backdrop action", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <BrowserPairingDialog
        labels={translations.en}
        request={request}
        isUpdating={false}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: translations.en.browserPairingApprove,
      }),
    );
    expect(onApprove).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("locks both decisions while persistence is in progress", async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(
      <BrowserPairingDialog
        labels={translations.en}
        request={request}
        isUpdating
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );

    expect(
      screen.getByRole("button", { name: translations.en.browserPairingUpdating }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: translations.en.browserPairingReject }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onReject).not.toHaveBeenCalled();
  });
});
