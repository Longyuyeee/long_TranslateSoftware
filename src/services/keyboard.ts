export const DASHBOARD_TAB_IDS = [
  "general",
  "batch",
  "model",
  "appearance",
  "wordbook",
  "review",
  "history",
] as const;

export type DashboardTabId = typeof DASHBOARD_TAB_IDS[number];

interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function dashboardTabFromShortcut(event: ShortcutEvent): DashboardTabId | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  const index = Number(event.key) - 1;
  return DASHBOARD_TAB_IDS[index] ?? null;
}

export function dashboardTabFromNavigation(
  current: DashboardTabId,
  key: string,
): DashboardTabId | null {
  if (key === "Home") return DASHBOARD_TAB_IDS[0];
  if (key === "End") return DASHBOARD_TAB_IDS[DASHBOARD_TAB_IDS.length - 1];

  const direction = key === "ArrowDown" || key === "ArrowRight"
    ? 1
    : key === "ArrowUp" || key === "ArrowLeft"
      ? -1
      : 0;
  if (!direction) return null;

  const currentIndex = DASHBOARD_TAB_IDS.indexOf(current);
  const nextIndex = (currentIndex + direction + DASHBOARD_TAB_IDS.length)
    % DASHBOARD_TAB_IDS.length;
  return DASHBOARD_TAB_IDS[nextIndex];
}
