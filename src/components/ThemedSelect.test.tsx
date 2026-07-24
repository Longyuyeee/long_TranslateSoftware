// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import ThemedSelect from "./ThemedSelect";

const options = [
  { value: "auto", label: "Automatic" },
  { value: "zh", label: "Chinese" },
  { value: "en", label: "English" },
] as const;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("ThemedSelect", () => {
  it("exposes the selected option and listbox state to assistive technology", async () => {
    const user = userEvent.setup();
    render(
      <ThemedSelect
        value="zh"
        options={options}
        onChange={vi.fn()}
        ariaLabel="Target language"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Target language" });
    expect(trigger).toHaveTextContent("Chinese");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("listbox", { name: "Target language" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Chinese" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("supports wrapped arrow navigation and keyboard selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ThemedSelect
        value="auto"
        options={options}
        onChange={onChange}
        ariaLabel="Source language"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Source language" });
    trigger.focus();
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");

    expect(onChange).toHaveBeenCalledWith("en");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes without changing the value on Escape or an outside click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div>
        <ThemedSelect
          value="auto"
          options={options}
          onChange={onChange}
          ariaLabel="Language"
        />
        <button type="button">Outside</button>
      </div>,
    );

    const trigger = screen.getByRole("combobox", { name: "Language" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
