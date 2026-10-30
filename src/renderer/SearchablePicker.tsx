import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";

import "./SearchablePicker.css";

export interface PickerOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Shared local filtering and keyboard interaction for catalog selectors. */
export function SearchablePicker({
  entries,
  value,
  disabled,
  onChange,
  label,
  placeholder,
  emptyLabel,
  searchLabel,
  searchPlaceholder,
  listLabel,
  hideLabel = false,
  className = "",
  loading = false,
  onOpen,
}: {
  label: string;
  placeholder: string;
  emptyLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  listLabel: string;
  hideLabel?: boolean;
  className?: string;
  loading?: boolean;
  onOpen?(): void;
  entries: (string | PickerOption)[];
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState(-1);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    search = useRef<HTMLInputElement>(null);
  const id = useId();
  const [placement, setPlacement] = useState({ height: 360, above: false });
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const place = () => {
      const node = root.current!;
      let top = 0,
        bottom = window.innerHeight;
      for (
        let parent = node.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (
          /(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)
        ) {
          const rect = parent.getBoundingClientRect();
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      const anchor = node.getBoundingClientRect();
      const below = bottom - anchor.bottom - 8,
        above = anchor.top - top - 8;
      const useAbove = below < 160 && above > below;
      setPlacement({
        height: Math.max(0, Math.min(360, useAbove ? above : below)),
        above: useAbove,
      });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const options = entries.map((e) =>
    typeof e === "string" ? { value: e, label: e } : e,
  );
  const selected = options.find((e) => e.value === value);
  const filtered = options.filter((e) =>
    e.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const blocked = () => disabled || !!trigger.current?.matches(":disabled");
  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const choose = (entry: PickerOption) => {
    if (blocked() || entry.disabled) return;
    // Match native select semantics: reselecting must not invalidate a ready form.
    if (entry.value !== value) onChange(entry.value);
    close(true);
  };
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>(`[data-cursor="true"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);
  const show = () => {
    if (blocked()) return;
    setQuery("");
    setCursor(-1);
    setOpen(true);
    onOpen?.();
  };
  return (
    <div
      className={`searchable-picker ${className}`}
      ref={root}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          close();
      }}
    >
      <span id={`${id}-label`} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        value={value}
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-list` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
      >
        <span>
          {selected?.label ??
            (value ||
              (loading
                ? "Загружаем…"
                : entries.length
                  ? placeholder
                  : emptyLabel))}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && !disabled && (
        <div
          className="searchable-menu"
          style={{
            maxHeight: placement.height,
            ...(placement.above
              ? { top: "auto", bottom: "calc(100% + 8px)" }
              : {}),
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
          <input
            ref={search}
            type="search"
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={query}
            aria-controls={`${id}-list`}
            aria-activedescendant={
              cursor >= 0 && cursor < filtered.length
                ? `${id}-option-${cursor}`
                : undefined
            }
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const direction = e.key === "ArrowDown" ? 1 : -1;
                setCursor((i) => {
                  for (let step = 1; step <= filtered.length; step++) {
                    const next =
                      i < 0
                        ? direction > 0
                          ? step - 1
                          : filtered.length - step
                        : (i + direction * step + filtered.length) %
                          filtered.length;
                    if (!filtered[next].disabled) return next;
                  }
                  return -1;
                });
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const entry =
                  cursor >= 0
                    ? filtered[cursor]
                    : filtered.find((e) => !e.disabled);
                if (entry) choose(entry);
              }
            }}
          />
          <div role="listbox" id={`${id}-list`} aria-label={listLabel}>
            {filtered.map((entry, i) => (
              <button
                type="button"
                role="option"
                id={`${id}-option-${i}`}
                key={entry.value}
                value={entry.value}
                disabled={entry.disabled}
                aria-selected={entry.value === value}
                data-cursor={cursor === i}
                onClick={() => choose(entry)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {loading ? (
            <p role="status">Загружаем…</p>
          ) : (
            !filtered.length && <p>Ничего не найдено</p>
          )}
        </div>
      )}
    </div>
  );
}
