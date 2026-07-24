import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";

export interface ThemedSelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface ThemedSelectProps<T extends string = string> {
  value: T;
  options: readonly ThemedSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  compact?: boolean;
  accent?: boolean;
  align?: "left" | "right";
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export default function ThemedSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  compact = false,
  accent = false,
  align = "right",
}: ThemedSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selectedOption = options[selectedIndex] ?? options[0];

  const optionIds = useMemo(
    () => options.map((_, index) => `${listboxId}-option-${index}`),
    [listboxId, options],
  );

  const updateMenuPosition = () => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const viewportPadding = 12;
    const desiredHeight = Math.min(options.length * (compact ? 34 : 38) + 12, 280);
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openAbove = spaceBelow < Math.min(desiredHeight, 180) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(desiredHeight, openAbove ? spaceAbove : spaceBelow));
    const width = Math.max(rect.width, compact ? 148 : 176);
    const unclampedLeft = align === "right" ? rect.right - width : rect.left;
    const left = Math.min(
      Math.max(viewportPadding, unclampedLeft),
      window.innerWidth - width - viewportPadding,
    );

    setMenuPosition({
      left,
      top: openAbove ? Math.max(viewportPadding, rect.top - maxHeight - 6) : rect.bottom + 6,
      width,
      maxHeight,
    });
  };

  const openMenu = () => {
    setActiveIndex(selectedIndex);
    setIsOpen(true);
  };

  const selectOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    updateMenuPosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const handleViewportChange = () => updateMenuPosition();

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isOpen, options.length]);

  useEffect(() => {
    if (!isOpen) return;
    const activeOption = document.getElementById(optionIds[activeIndex] ?? "");
    if (activeOption && menuRef.current?.contains(activeOption)) {
      activeOption.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, isOpen, optionIds]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(current => (current + direction + options.length) % options.length);
      return;
    }

    if ((event.key === "Enter" || event.key === " ") && isOpen) {
      event.preventDefault();
      selectOption(activeIndex);
    }
  };

  const menu = isOpen && menuPosition && (
    <div
      ref={menuRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      className="themed-select-menu fixed z-[200] overflow-y-auto custom-scrollbar rounded-2xl border border-black/10 bg-white/95 p-1.5 text-zinc-700 shadow-[0_24px_70px_rgba(15,23,42,0.24)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/95 dark:text-zinc-100 dark:shadow-[0_24px_70px_rgba(0,0,0,0.58)]"
      style={{
        left: menuPosition.left,
        top: menuPosition.top,
        width: menuPosition.width,
        maxHeight: menuPosition.maxHeight,
      }}
    >
      {options.map((option, index) => {
        const isSelected = option.value === value;
        const isActive = index === activeIndex;
        return (
          <button
            key={option.value}
            id={optionIds[index]}
            type="button"
            role="option"
            aria-selected={isSelected}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => selectOption(index)}
            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-bold transition-colors ${
              compact ? "text-[10px]" : "text-[11px]"
            } ${
              isSelected
                ? "bg-accent text-white shadow-sm shadow-accent"
                : isActive
                  ? "bg-black/5 text-zinc-900 dark:bg-white/10 dark:text-white"
                  : "text-zinc-600 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/10"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <Check size={13} className={isSelected ? "shrink-0 opacity-100" : "shrink-0 opacity-0"} />
          </button>
        );
      })}
    </div>
  );

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-activedescendant={isOpen ? optionIds[activeIndex] : undefined}
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        className={`group flex w-full items-center justify-between gap-2 border bg-white/65 font-black shadow-sm outline-none backdrop-blur-xl transition-all hover:bg-white focus-visible:border-accent/60 focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_16%,transparent)] dark:bg-zinc-800/75 dark:hover:bg-zinc-700/90 ${
          compact
            ? "min-h-8 rounded-xl px-3 py-1.5 text-[10px]"
            : "min-h-10 rounded-2xl px-4 py-2.5 text-[11px]"
        } ${
          isOpen
            ? "border-accent/50 ring-4 ring-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
            : "border-black/10 dark:border-white/10"
        } ${accent ? "text-accent" : "text-zinc-700 dark:text-zinc-100"}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selectedOption?.label ?? value}</span>
        <ChevronDown
          size={compact ? 12 : 14}
          className={`shrink-0 text-zinc-400 transition-transform duration-200 group-hover:text-accent ${
            isOpen ? "rotate-180 text-accent" : ""
          }`}
        />
      </button>
      {typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </div>
  );
}
