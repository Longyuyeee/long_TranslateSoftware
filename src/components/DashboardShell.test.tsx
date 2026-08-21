// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translations } from "../i18n";
import DashboardShell from "./DashboardShell";

const callbacks = {
  onTabChange: vi.fn(),
  onToggleNotifications: vi.fn(),
  onCloseNotifications: vi.fn(),
  onDismissNotification: vi.fn(),
  onClearNotifications: vi.fn(),
  onSave: vi.fn(),
  onCheckUpdate: vi.fn(),
};

const baseProps = {
  labels: translations.en,
  appVersion: "0.5.2",
  activeTab: "general" as const,
  stats: {
    word_count: 12,
    trans_count: 34,
    days_active: 5,
    due_today: 6,
  },
  notifications: [{ msg: "Saved", time: "10:00" }],
  unreadNotificationCount: 1,
  isNotificationsOpen: false,
  hasUnsavedChanges: true,
  isSavingSettings: false,
  isCheckingUpdate: false,
  ...callbacks,
};

describe("DashboardShell", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("routes pointer, global shortcut, and wrapped navigation actions", () => {
    render(
      <DashboardShell {...baseProps}>
        <div>Active page</div>
      </DashboardShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: translations.en.batchTranslate }));
    expect(callbacks.onTabChange).toHaveBeenCalledWith("batch");

    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(callbacks.onTabChange).toHaveBeenCalledWith("wordbook");

    const generalTab = screen.getByRole("button", { name: translations.en.general });
    fireEvent.keyDown(generalTab, { key: "ArrowUp" });
    expect(callbacks.onTabChange).toHaveBeenCalledWith("history");
  });

  it("groups navigation by workflow in the same order as shortcuts", () => {
    render(
      <DashboardShell {...baseProps}>
        <div>Active page</div>
      </DashboardShell>,
    );

    expect(screen.getByText(translations.en.navTranslation)).toBeInTheDocument();
    expect(screen.getByText(translations.en.navLearning)).toBeInTheDocument();
    expect(screen.getByText(translations.en.navSettings)).toBeInTheDocument();

    const navigation = screen.getByRole("navigation", { name: translations.en.mainNavigation });
    expect(Array.from(navigation.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
      `${translations.en.batchTranslate}1`,
      `${translations.en.documentTranslate}2`,
      `${translations.en.wordbook}3`,
      `${translations.en.review}4`,
      `${translations.en.history}5`,
      `${translations.en.general}6`,
      `${translations.en.modelConfig}7`,
      `${translations.en.appearance}8`,
    ]);
  });

  it("keeps notification actions and outside dismissal in the shell boundary", () => {
    render(
      <DashboardShell {...baseProps} isNotificationsOpen>
        <div>Active page</div>
      </DashboardShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: translations.en.notifications }));
    expect(callbacks.onToggleNotifications).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByText("Saved"));
    expect(callbacks.onDismissNotification).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByRole("button", { name: translations.en.clearAll }));
    expect(callbacks.onClearNotifications).toHaveBeenCalledOnce();

    fireEvent.mouseDown(document.body);
    expect(callbacks.onCloseNotifications).toHaveBeenCalledOnce();
  });

  it("renders stats and routes save and update actions", () => {
    render(
      <DashboardShell {...baseProps}>
        <div>Active page</div>
      </DashboardShell>,
    );

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("34")).toBeInTheDocument();
    expect(screen.getByLabelText("Current version 0.5.2")).toHaveTextContent("v0.5.2");
    fireEvent.click(screen.getByRole("button", { name: translations.en.saveChanges }));
    fireEvent.click(screen.getByRole("button", { name: translations.en.checkUpdate }));

    expect(callbacks.onSave).toHaveBeenCalledOnce();
    expect(callbacks.onCheckUpdate).toHaveBeenCalledOnce();
  });

  it("does not expose the settings save action in the document workspace", () => {
    render(
      <DashboardShell {...baseProps} activeTab="document">
        <div>Document page</div>
      </DashboardShell>,
    );

    expect(screen.queryByRole("button", { name: translations.en.saveChanges }))
      .not.toBeInTheDocument();
  });
});
