import { type ReactNode, useEffect, useRef } from "react";
import {
  Bell,
  Book,
  Brain,
  CheckCircle,
  Clock,
  Cpu,
  FileText,
  Languages,
  Monitor,
  Palette,
  Save,
  Settings,
  Sparkles,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import type { TranslationCatalog } from "../i18n";
import type { DashboardNotification } from "../hooks/useNotifications";
import {
  DASHBOARD_TAB_IDS,
  type DashboardTabId,
  dashboardTabFromNavigation,
  dashboardTabFromShortcut,
} from "../services/keyboard";

interface DashboardStats {
  word_count: number;
  trans_count: number;
  days_active: number;
  due_today: number;
}

interface DashboardShellProps {
  labels: TranslationCatalog;
  activeTab: DashboardTabId;
  stats: DashboardStats;
  notifications: DashboardNotification[];
  unreadNotificationCount: number;
  isNotificationsOpen: boolean;
  hasUnsavedChanges: boolean;
  isSavingSettings: boolean;
  isCheckingUpdate: boolean;
  children: ReactNode;
  onTabChange: (tab: DashboardTabId) => void;
  onToggleNotifications: () => void;
  onCloseNotifications: () => void;
  onDismissNotification: (index: number) => void;
  onClearNotifications: () => void;
  onSave: () => void;
  onCheckUpdate: () => void;
}

export default function DashboardShell({
  labels,
  activeTab,
  stats,
  notifications,
  unreadNotificationCount,
  isNotificationsOpen,
  hasUnsavedChanges,
  isSavingSettings,
  isCheckingUpdate,
  children,
  onTabChange,
  onToggleNotifications,
  onCloseNotifications,
  onDismissNotification,
  onClearNotifications,
  onSave,
  onCheckUpdate,
}: DashboardShellProps) {
  const notificationsRef = useRef<HTMLDivElement>(null);
  const previousTabRef = useRef<DashboardTabId>("general");
  const tabButtonRefs = useRef<Partial<Record<DashboardTabId, HTMLButtonElement | null>>>({});

  const tabs = [
    { id: "general", label: labels.general, icon: Settings },
    { id: "batch", label: labels.batchTranslate, icon: Languages },
    { id: "model", label: labels.modelConfig, icon: Cpu },
    { id: "appearance", label: labels.appearance, icon: Palette },
    { id: "wordbook", label: labels.wordbook, icon: Book },
    { id: "review", label: labels.review, icon: Brain },
    { id: "history", label: labels.history, icon: Clock },
    { id: "document", label: labels.documentTranslate, icon: FileText },
  ] satisfies Array<{
    id: DashboardTabId;
    label: string;
    icon: typeof Settings;
  }>;

  const previousIndex = DASHBOARD_TAB_IDS.indexOf(previousTabRef.current);
  const currentIndex = DASHBOARD_TAB_IDS.indexOf(activeTab);
  const slideDirection = currentIndex >= previousIndex ? 1 : -1;

  useEffect(() => {
    previousTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const tab = dashboardTabFromShortcut(event);
      if (!tab) return;
      event.preventDefault();
      onTabChange(tab);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onTabChange]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        notificationsRef.current &&
        !notificationsRef.current.contains(event.target as Node)
      ) {
        onCloseNotifications();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onCloseNotifications]);

  return (
    <>
      <aside
        className="dashboard-sidebar glass z-20 flex min-h-0 shrink-0 flex-col border-r border-black/5 shadow-xl dark:border-white/5"
        style={{ width: "180px", minWidth: "160px" }}
      >
        <div className="dashboard-sidebar-main custom-scrollbar min-h-0 flex-1 overflow-y-auto p-6">
          <div className="dashboard-brand group mb-8 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-blue-600 to-blue-700 text-lg font-black text-white shadow-lg shadow-accent transition-transform duration-500 group-hover:rotate-12">
              <Sparkles size={20} className="text-white/90" />
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="mb-1 text-sm leading-none font-black tracking-tighter">
                {labels.brandName}
              </span>
              <span className="text-[8px] font-bold tracking-widest text-zinc-400 uppercase opacity-60">
                {labels.brandEdition}
              </span>
            </div>
          </div>

          <nav className="space-y-1" aria-label={labels.mainNavigation}>
            <LayoutGroup id="sidebar">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  ref={(element) => {
                    tabButtonRefs.current[tab.id] = element;
                  }}
                  type="button"
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  onClick={() => onTabChange(tab.id)}
                  onKeyDown={(event) => {
                    const next = dashboardTabFromNavigation(tab.id, event.key);
                    if (!next) return;
                    event.preventDefault();
                    onTabChange(next);
                    tabButtonRefs.current[next]?.focus();
                  }}
                  className={`dashboard-nav-item group relative flex w-full items-center justify-between rounded-xl px-3 py-2.5 transition-all ${
                    activeTab === tab.id
                      ? "text-white"
                      : "text-zinc-500 hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                  style={{ fontSize: "0.85em" }}
                >
                  {activeTab === tab.id && (
                    <motion.div
                      layoutId="activeTabBg"
                      className="absolute inset-0 rounded-xl bg-accent shadow-lg shadow-accent"
                      transition={{ type: "spring", bounce: 0.1, duration: 0.5 }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-2.5 font-bold">
                    <tab.icon
                      size={15}
                      className={
                        activeTab === tab.id
                          ? "text-white"
                          : "text-zinc-400 transition-colors group-hover:text-zinc-600 dark:text-zinc-500 dark:group-hover:text-zinc-300"
                      }
                    />
                    <span className="truncate">{tab.label}</span>
                  </span>
                </button>
              ))}
            </LayoutGroup>
          </nav>
        </div>

        <div className="dashboard-sidebar-footer shrink-0 border-t border-black/5 p-4 dark:border-white/5">
          <div className="dashboard-stats-card space-y-3 rounded-2xl border border-white/40 bg-white/40 p-4 dark:border-white/5 dark:bg-white/5">
            <div className="dashboard-stat-row flex items-center justify-between">
              <div className="flex items-center gap-2 text-zinc-400">
                <Book size={12} />
                <span className="text-[9px] font-black tracking-tighter uppercase">
                  {labels.words}
                </span>
              </div>
              <span className="text-[10px] font-black text-accent">
                {stats.word_count}
              </span>
            </div>
            <div className="dashboard-stat-row flex items-center justify-between">
              <div className="flex items-center gap-2 text-zinc-400">
                <Languages size={12} />
                <span className="text-[9px] font-black tracking-tighter uppercase">
                  {labels.translations}
                </span>
              </div>
              <span className="text-[10px] font-black text-accent">
                {stats.trans_count}
              </span>
            </div>
            <div className="dashboard-stat-row flex items-center justify-between">
              <div className="flex items-center gap-2 text-zinc-400">
                <Brain size={12} />
                <span className="text-[9px] font-black tracking-tighter uppercase">
                  {labels.dueToday}
                </span>
              </div>
              <span className="text-[10px] font-black text-amber-500">
                {stats.due_today || 0}
              </span>
            </div>
            <div className="dashboard-stat-row flex items-center justify-between">
              <div className="flex items-center gap-2 text-zinc-400">
                <Monitor size={12} />
                <span className="text-[9px] font-black tracking-tighter uppercase">
                  {labels.streak}
                </span>
              </div>
              <span className="text-[10px] font-black text-accent">
                {stats.days_active}
                {labels.dayUnit}
              </span>
            </div>
            <button
              type="button"
              onClick={onCheckUpdate}
              disabled={isCheckingUpdate}
              className="mt-1 w-full rounded-xl border border-accent/20 bg-accent/10 py-2 text-[9px] font-black text-accent transition-all hover:bg-accent/20 disabled:opacity-50"
            >
              {isCheckingUpdate ? labels.updateChecking : labels.checkUpdate}
            </button>
          </div>
        </div>
      </aside>

      <div className="relative flex flex-1 flex-col overflow-hidden bg-transparent">
        <header className="dashboard-header z-10 flex h-20 shrink-0 items-center justify-between border-b border-black/5 bg-white/30 px-10 backdrop-blur-3xl dark:border-white/5 dark:bg-black/20">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h1 className="bg-gradient-to-r from-zinc-800 to-zinc-500 bg-clip-text text-xl font-black tracking-tighter text-transparent dark:from-white dark:to-zinc-400">
                {tabs.find((tab) => tab.id === activeTab)?.label}
              </h1>
              <span className="h-1 w-1 rounded-full bg-accent/40" />
              <span className="text-[10px] font-black tracking-widest text-accent/60 uppercase italic">
                {labels.brandCompact}
              </span>
            </div>
            <p className="dashboard-subtitle text-[9px] font-bold tracking-[0.3em] text-zinc-400 uppercase opacity-60">
              {labels.brandSubtitle}
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div ref={notificationsRef} className="relative">
              <button
                type="button"
                onClick={onToggleNotifications}
                aria-expanded={isNotificationsOpen}
                aria-label={labels.notifications}
                className="relative rounded-full p-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
              >
                <Bell size={16} className="text-zinc-400" />
                {unreadNotificationCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[8px] font-black text-white">
                    {unreadNotificationCount}
                  </span>
                )}
              </button>
              {isNotificationsOpen && notifications.length > 0 && (
                <div className="absolute top-full right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-black/5 bg-white shadow-2xl dark:border-white/10 dark:bg-zinc-800">
                  <div className="flex items-center justify-between border-b border-black/5 p-2 dark:border-white/5">
                    <span className="px-2 text-[9px] font-black tracking-wider text-zinc-400 uppercase">
                      {labels.notifications}
                    </span>
                    <button
                      type="button"
                      onClick={onClearNotifications}
                      className="rounded-lg px-2 py-1 text-[8px] font-black text-zinc-400 transition-colors hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/5"
                    >
                      {labels.clearAll}
                    </button>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {notifications.map((notification, index) => (
                      <button
                        key={`${notification.time}-${index}`}
                        type="button"
                        onClick={() => onDismissNotification(index)}
                        className="flex w-full items-start gap-2 px-3 py-2 text-left text-[10px] font-medium text-zinc-600 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/5"
                      >
                        <CheckCircle
                          size={10}
                          className="mt-0.5 shrink-0 text-green-500"
                        />
                        <span className="flex-1">{notification.msg}</span>
                        <span className="shrink-0 text-[8px] text-zinc-400">
                          {notification.time}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {activeTab !== "wordbook" && activeTab !== "batch" && activeTab !== "document" && (
              <motion.button
                type="button"
                whileHover={hasUnsavedChanges ? { scale: 1.02 } : undefined}
                whileTap={hasUnsavedChanges ? { scale: 0.98 } : undefined}
                onClick={onSave}
                disabled={!hasUnsavedChanges || isSavingSettings}
                className="flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-[12px] font-black text-white shadow-xl shadow-accent transition-all disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:shadow-none dark:disabled:bg-zinc-700"
              >
                {hasUnsavedChanges && !isSavingSettings && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                )}
                <Save size={14} />
                {isSavingSettings
                  ? labels.saving
                  : hasUnsavedChanges
                    ? labels.saveChanges
                    : labels.saved}
              </motion.button>
            )}
          </div>
        </header>

        <main className="dashboard-main custom-scrollbar relative min-h-0 flex-1 overflow-y-auto px-10 py-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: slideDirection * 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: slideDirection * -24 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="flex h-full min-h-0 flex-col"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}
