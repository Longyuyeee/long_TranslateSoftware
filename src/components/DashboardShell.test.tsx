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
    expect(callbacks.onTabChange).toHaveBeenCalledWith("model");

    const generalTab = screen.getByRole("button", { name: translations.en.general });
    fireEvent.keyDown(generalTab, { key: "ArrowUp" });
    expect(callbacks.onTabChange).toHaveBeenCalledWith("history");
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
    fireEvent.click(screen.getByRole("button", { name: translations.en.saveChanges }));
    fireEvent.click(screen.getByRole("button", { name: translations.en.checkUpdate }));

    expect(callbacks.onSave).toHaveBeenCalledOnce();
    expect(callbacks.onCheckUpdate).toHaveBeenCalledOnce();
  });
});
