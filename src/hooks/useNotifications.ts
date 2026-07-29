import { useCallback, useRef, useState } from "react";

export type DashboardNotification = {
  msg: string;
  time: string;
};

export function useNotifications() {
  const [notifications, setNotifications] = useState<DashboardNotification[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const isOpenRef = useRef(false);

  const closeNotifications = useCallback(() => {
    isOpenRef.current = false;
    setIsNotificationsOpen(false);
  }, []);

  const addNotification = useCallback((msg: string) => {
    if (!msg) return;
    const time = new Date().toLocaleTimeString();
    setNotifications((current) =>
      [{ msg, time }, ...current].slice(0, 10),
    );
    if (!isOpenRef.current) {
      setUnreadNotificationCount((current) => Math.min(current + 1, 99));
    }
  }, []);

  const toggleNotifications = useCallback(() => {
    setNotifications((current) => {
      const open = current.length > 0 && !isOpenRef.current;
      isOpenRef.current = open;
      setIsNotificationsOpen(open);
      if (open || current.length === 0) setUnreadNotificationCount(0);
      return current;
    });
  }, []);

  const dismissNotification = useCallback((index: number) => {
    setNotifications((current) => {
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      if (next.length === 0) {
        isOpenRef.current = false;
        setIsNotificationsOpen(false);
      }
      return next;
    });
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
    setUnreadNotificationCount(0);
    isOpenRef.current = false;
    setIsNotificationsOpen(false);
  }, []);

  return {
    notifications,
    unreadNotificationCount,
    isNotificationsOpen,
    addNotification,
    toggleNotifications,
    closeNotifications,
    dismissNotification,
    clearNotifications,
  };
}
