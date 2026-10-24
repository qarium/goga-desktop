import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";

/** Search is local: typing never invokes Goga or reloads the history catalog. */
export function HistoryEntryPicker({
  entries,
  value,
  disabled,
  onChange,
}: {
  entries: string[];
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
  const filtered = entries.filter((e) =>
    e.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const choose = (entry: string) => {
    onChange(entry);
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
    setQuery("");
    setCursor(-1);
    setOpen(true);
  };
  return (
    <div
      className="history-entry-picker"
      ref={root}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          close();
      }}
    >
      <span id={`${id}-label`}>Запись истории</span>
      <button
        ref={trigger}
        type="button"
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
          {value || (entries.length ? "Выберите запись" : "Нет записей")}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && !disabled && (
        <div
          className="history-entry-menu"
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
            aria-label="Найти запись истории"
            placeholder="Название записи"
            value={query}
            aria-controls={`${id}-list`}
            aria-activedescendant={
              cursor >= 0 ? `${id}-option-${cursor}` : undefined
            }
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((i) =>
                  filtered.length
                    ? i < 0
                      ? e.key === "ArrowDown"
                        ? 0
                        : filtered.length - 1
                      : (i +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          filtered.length) %
                        filtered.length
                    : -1,
                );
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const entry = filtered[cursor >= 0 ? cursor : 0];
                if (entry) choose(entry);
              }
            }}
          />
          <div role="listbox" id={`${id}-list`} aria-label="Записи истории">
            {filtered.map((entry, i) => (
              <button
                type="button"
                role="option"
                id={`${id}-option-${i}`}
                key={entry}
                aria-selected={entry === value}
                data-cursor={cursor === i}
                onClick={() => choose(entry)}
              >
                {entry}
              </button>
            ))}
          </div>
          {!filtered.length && <p>Ничего не найдено</p>}
        </div>
      )}
    </div>
  );
}
