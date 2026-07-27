import { RefObject, useLayoutEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface FocusTrapOptions {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  escapeDisabled?: boolean;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => element.getAttribute("aria-hidden") !== "true");
}

export function useFocusTrap({
  active,
  containerRef,
  onEscape,
  escapeDisabled = false,
}: FocusTrapOptions) {
  const onEscapeRef = useRef(onEscape);
  const escapeDisabledRef = useRef(escapeDisabled);
  onEscapeRef.current = onEscape;
  escapeDisabledRef.current = escapeDisabled;

  useLayoutEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const initialFocus = container.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      || getFocusableElements(container)[0]
      || container;
    initialFocus.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !escapeDisabledRef.current) {
        event.preventDefault();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, containerRef]);
}
