// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNotifications } from "./useNotifications";

describe("useNotifications", () => {
  it("tracks unread items and clears the count when opened", () => {
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockReturnValue("10:00");
    const { result } = renderHook(() => useNotifications());

    act(() => {
      result.current.addNotification("first");
      result.current.addNotification("second");
    });
    expect(result.current.unreadNotificationCount).toBe(2);
    expect(result.current.notifications.map((item) => item.msg)).toEqual([
      "second",
      "first",
    ]);

    act(() => result.current.toggleNotifications());
    expect(result.current.isNotificationsOpen).toBe(true);
    expect(result.current.unreadNotificationCount).toBe(0);
    vi.restoreAllMocks();
  });

  it("dismisses the final item and closes the popover atomically", () => {
    const { result } = renderHook(() => useNotifications());
    act(() => result.current.addNotification("only"));
    act(() => result.current.toggleNotifications());
    act(() => result.current.dismissNotification(0));

    expect(result.current.notifications).toEqual([]);
    expect(result.current.isNotificationsOpen).toBe(false);
  });

  it("clears notifications, unread state and visibility together", () => {
    const { result } = renderHook(() => useNotifications());
    act(() => {
      result.current.addNotification("one");
      result.current.addNotification("two");
    });
    act(() => result.current.toggleNotifications());
    act(() => result.current.clearNotifications());

    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadNotificationCount).toBe(0);
    expect(result.current.isNotificationsOpen).toBe(false);
  });
});
