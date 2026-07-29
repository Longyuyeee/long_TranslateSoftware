// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import AppearanceSettingsTab, {
  type AppearanceConfig,
} from "./AppearanceSettingsTab";

const appearance: AppearanceConfig = {
  theme: "system",
  accentColor: "#007aff",
  fontSize: 14,
};

describe("AppearanceSettingsTab", () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("emits typed patches for theme and accent color changes", () => {
    render(
      <AppearanceSettingsTab
        labels={translations.en}
        value={appearance}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: translations.en.themeDark }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `${translations.en.accentColor}: ${translations.en.accentColorViolet}`,
      }),
    );

    expect(onChange).toHaveBeenNthCalledWith(1, { theme: "dark" });
    expect(onChange).toHaveBeenNthCalledWith(2, { accentColor: "#af52de" });
  });

  it("exposes current selections through pressed state", () => {
    render(
      <AppearanceSettingsTab
        labels={translations.en}
        value={appearance}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole("button", { name: translations.en.themeSystem }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", {
        name: `${translations.en.accentColor}: ${translations.en.accentColorBlue}`,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("emits numeric font size patches from the scale control", () => {
    render(
      <AppearanceSettingsTab
        labels={translations.zh}
        value={appearance}
        onChange={onChange}
      />,
    );

    fireEvent.change(
      screen.getByRole("slider", { name: translations.zh.interfaceScale }),
      { target: { value: "18" } },
    );

    expect(onChange).toHaveBeenCalledWith({ fontSize: 18 });
  });
});
