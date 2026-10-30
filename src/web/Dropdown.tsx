// One Planban dropdown for the online screens and the board page (Planban 2.0
// plan, "Mobile and dropdowns"; approved mockup section 11). As wide as the
// chosen value, with the arrow 6 px after the text and the height of the
// buttons beside it. The menu ticks the current choice. On a touch screen it
// opens the phone's own picker. Works with the keyboard and screen readers.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean | undefined;
}

export interface DropdownProps<T extends string> {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (value: T) => void;
  /** What the dropdown chooses, for screen readers ("Role", "What it may do"). */
  label: string;
  disabled?: boolean;
  className?: string;
  /** A short label shown inside the button before the value ("Status"). */
  prefix?: string | undefined;
  /** The id of text explaining why the dropdown is disabled. */
  describedBy?: string | undefined;
  /** Dialogs focus this dropdown first. */
  initialFocus?: boolean;
}

/** Touch screens get the phone's own picker. */
function prefersNativePicker() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

export function Dropdown<T extends string>({ value, options, onChange, label, disabled = false, className = "", prefix, describedBy, initialFocus = false }: DropdownProps<T>) {
  const [native] = useState(prefersNativePicker);
  const current = options.find((option) => option.value === value) ?? options[0];
  const text = current?.label ?? "";

  if (native) {
    return (
      <span className={`pb-dropdown ${disabled ? "disabled" : ""} ${className}`}>
        <span className="pb-dropdown-trigger" aria-hidden="true">
          {prefix ? <span className="pb-dropdown-prefix">{prefix}</span> : null}
          <span>{text}</span>
          <ChevronDown size={12} />
        </span>
        <select className="pb-dropdown-native" value={value} disabled={disabled} aria-label={label} aria-describedby={describedBy}
          data-dialog-initial-focus={initialFocus ? true : undefined} onChange={(event) => onChange(event.target.value as T)}>
          {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </select>
      </span>
    );
  }
  return <MenuDropdown value={value} options={options} onChange={onChange} label={label} disabled={disabled} className={className} text={text}
    prefix={prefix} describedBy={describedBy} initialFocus={initialFocus} />;
}

function MenuDropdown<T extends string>({ value, options, onChange, label, disabled, className, text, prefix, describedBy, initialFocus }: {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (value: T) => void;
  label: string;
  disabled: boolean;
  className: string;
  text: string;
  prefix: string | undefined;
  describedBy: string | undefined;
  initialFocus: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  /** Set when a choice is made, so focus comes back once the dropdown is enabled again after saving. */
  const refocus = useRef(false);
  const id = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (disabled || !refocus.current) return;
    refocus.current = false;
    if (document.activeElement === document.body || document.activeElement === null) triggerRef.current?.focus();
  }, [disabled]);

  const openAt = (index: number) => {
    if (disabled) return;
    setActive(index);
    setOpen(true);
  };

  // Place the menu under the trigger, in the page's own layer, so dialogs can't clip it.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const below = rect.bottom + 4;
    const height = Math.min(320, options.length * 30 + 12);
    const top = below + height > window.innerHeight && rect.top - height - 4 > 0 ? rect.top - height - 4 : below;
    setPlace({ left: Math.min(rect.left, window.innerWidth - 178), top, minWidth: Math.max(170, rect.width) });
  }, [open, options.length]);

  // The active choice stays in view in a long menu.
  useEffect(() => {
    // Waits for the menu to be placed on screen, so a long menu opens scrolled to the current choice.
    if (open && place) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, place, active, id]);

  // Keyboard focus moves into the menu once it is on screen.
  useEffect(() => {
    if (open && place) listRef.current?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!listRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    // Scrolling the page moves the trigger away, so the menu closes; scrolling the menu itself doesn't.
    const onMove = (event: Event) => {
      if (event.type === "scroll" && listRef.current?.contains(event.target as Node)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  const choose = (index: number) => {
    const option = options[index];
    if (option?.disabled) return;
    close(true);
    if (option && option.value !== value) {
      refocus.current = true;
      onChange(option.value);
    }
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAt(selectedIndex);
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);
    const move = (index: number | undefined) => {
      event.preventDefault();
      if (index !== undefined) setActive(index);
    };
    if (event.key === "ArrowDown") return move(enabled.find((index) => index > active) ?? enabled.at(-1));
    if (event.key === "ArrowUp") return move([...enabled].reverse().find((index) => index < active) ?? enabled[0]);
    if (event.key === "Home") return move(enabled[0]);
    if (event.key === "End") return move(enabled.at(-1));
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      return choose(active);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return close(true);
    }
    // Tab carries on from the dropdown's own button, so focus never jumps out of a dialog.
    if (event.key === "Tab") {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    // Type the start of a choice to jump to it.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
      const found = options.findIndex((option) => !option.disabled && option.label.toLowerCase().startsWith(typed.current.text));
      if (found >= 0) setActive(found);
    }
  };

  return (
    <span className={`pb-dropdown ${disabled ? "disabled" : ""} ${className}`}>
      <button ref={triggerRef} type="button" className="pb-dropdown-trigger" disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-label={`${label}: ${text}`}
        aria-describedby={describedBy} data-dialog-initial-focus={initialFocus ? true : undefined}
        onClick={() => (open ? close(false) : openAt(selectedIndex))} onKeyDown={onTriggerKey}
        onBlur={(event) => { if (event.relatedTarget && event.relatedTarget !== listRef.current) refocus.current = false; }}>
        {prefix ? <span className="pb-dropdown-prefix">{prefix}</span> : null}
        <span>{text}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && place ? createPortal(
        <ul ref={listRef} id={`${id}-list`} className="pb-dropdown-menu" role="listbox" aria-label={label} tabIndex={-1}
          aria-activedescendant={`${id}-option-${active}`} onKeyDown={onListKey}
          style={{ left: place.left, top: place.top, minWidth: place.minWidth }}>
          {options.map((option, index) => (
            <li key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled ? true : undefined}
              className={`pb-dropdown-option ${index === active ? "active" : ""} ${option.disabled ? "disabled" : ""}`}
              onPointerEnter={() => setActive(index)} onClick={() => choose(index)}>
              <span>{option.label}</span>
              {option.value === value ? <Check size={13} aria-hidden="true" /> : <span className="pb-dropdown-tick-space" />}
            </li>
          ))}
        </ul>,
        document.body,
      ) : null}
    </span>
  );
}
