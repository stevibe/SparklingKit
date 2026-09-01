import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "./ui";

export interface SearchSelectOption {
  value: string;
  label: string;
  keywords?: string;
  disabled?: boolean;
}

interface SearchSelectProps {
  value: string;
  options: SearchSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  leadingIcon?: ReactNode;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

function searchableText(option: SearchSelectOption) {
  return `${option.label} ${option.value} ${option.keywords || ""}`.normalize("NFKD").toLocaleLowerCase();
}

export function SearchSelect({ value, options, onChange, placeholder = "Select an option", searchPlaceholder = "Search options", emptyMessage = "No matching options", ariaLabel, className, disabled, leadingIcon }: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const normalized = query.trim().normalize("NFKD").toLocaleLowerCase();
    return normalized ? options.filter((option) => searchableText(option).includes(normalized)) : options;
  }, [options, query]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 260), viewportWidth - 16);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - width - 8));
    const desiredHeight = Math.min(380, 66 + Math.max(1, Math.min(options.length, 7)) * 44);
    const below = viewportHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const upward = below < Math.min(260, desiredHeight) && above > below;
    const maxHeight = Math.max(150, Math.min(desiredHeight, upward ? above : below));
    const top = upward ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6;
    setPosition({ left, top, width, maxHeight });
  }, [options.length]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const focus = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(focus);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    const outside = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [close, open, updatePosition]);

  useEffect(() => {
    const firstEnabled = filtered.findIndex((option) => !option.disabled);
    setActiveIndex(Math.max(0, firstEnabled));
  }, [filtered]);

  function select(option: SearchSelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    close(true);
  }

  function moveActive(direction: 1 | -1) {
    if (!filtered.length) return;
    let next = activeIndex;
    for (let attempts = 0; attempts < filtered.length; attempts += 1) {
      next = (next + direction + filtered.length) % filtered.length;
      if (!filtered[next].disabled) break;
    }
    setActiveIndex(next);
    window.requestAnimationFrame(() => document.getElementById(`${menuId}-option-${next}`)?.scrollIntoView({ block: "nearest" }));
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const candidates = filtered.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);
      const candidate = event.key === "Home" ? candidates[0] : candidates.at(-1);
      if (candidate) setActiveIndex(candidate.index);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option) select(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  }

  const menuStyle: CSSProperties | undefined = position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight } : undefined;
  return <div className={cn("search-select", open && "open", disabled && "disabled", className)}>
    <button ref={triggerRef} type="button" className="search-select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} aria-label={ariaLabel} disabled={disabled} onClick={() => open ? close() : setOpen(true)} onKeyDown={onTriggerKeyDown}>
      {leadingIcon && <span className="search-select-leading">{leadingIcon}</span>}<span className={cn("search-select-value", !selected && "placeholder")}>{selected?.label || placeholder}</span><ChevronDown size={16} className="search-select-chevron" />
    </button>
    {open && createPortal(<div ref={menuRef} className="search-select-menu" style={menuStyle} role="presentation">
      <div className="search-select-search"><Search size={16} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKeyDown} placeholder={searchPlaceholder} aria-label={searchPlaceholder} aria-controls={menuId} aria-activedescendant={filtered[activeIndex] ? `${menuId}-option-${activeIndex}` : undefined} autoComplete="off" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}</div>
      <div id={menuId} className="search-select-options" role="listbox" aria-label={ariaLabel || placeholder}>{filtered.length ? filtered.map((option, index) => <button id={`${menuId}-option-${index}`} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={cn("search-select-option", index === activeIndex && "active", option.value === value && "selected")} onMouseMove={() => setActiveIndex(index)} onClick={() => select(option)} key={option.value}><span>{option.label}</span>{option.value === value && <Check size={16} />}</button>) : <div className="search-select-empty">{emptyMessage}</div>}</div>
    </div>, document.body)}
  </div>;
}
