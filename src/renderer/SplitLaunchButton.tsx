import { useEffect, useId, useRef, useState } from "react";
export function SplitLaunchButton({
  disabled,
  busy,
  dirty,
  context,
  onLaunch,
  describedBy,
}: {
  describedBy?: string;
  disabled: boolean;
  busy: boolean;
  dirty: boolean;
  context: object;
  onLaunch: (update: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => setOpen(false), [context, disabled]);
  useEffect(() => {
    if (!open) return;
    item.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    arrow.current?.focus();
  };
  return (
    <div
      className="split-launch"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="primary split-launch-main"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => onLaunch(false)}
      >
        {busy
          ? "Подготавливаем запуск…"
          : dirty
            ? "Сохранить и запустить"
            : "Запустить"}
      </button>
      <button
        type="button"
        className="primary split-launch-arrow"
        ref={arrow}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-label="Варианты запуска"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          id={menuId}
          aria-label="Варианты запуска"
          className="launch-menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
            ) {
              e.preventDefault();
              item.current?.focus();
            } else if (e.key === "Tab") setOpen(false);
          }}
        >
          <button
            ref={item}
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              onLaunch(true);
            }}
          >
            {dirty
              ? "Сохранить и запустить с обновлением образа"
              : "Запустить с обновлением образа"}
          </button>
        </div>
      )}
    </div>
  );
}
