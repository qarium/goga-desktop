import { useEffect, useId, useRef, useState } from "react";
import {
  contextKey,
  contextRunActivity,
  type RunKind,
  type RunWithContext,
  type TopicContextIdentity,
} from "./topic-context";
import "./ContextRuns.css";

export interface ContextLaunchMenuProps {
  runs: RunWithContext[];
  context: TopicContextIdentity | null;
  onPrepare: (kind: RunKind) => void;
  disabled?: boolean;
  blockedReason?: string;
  prepareWithoutContext?: boolean;
}

/** Opens preparation only; writer guards remain enforced by the host as well. */
export function ContextLaunchMenu({
  runs,
  context,
  onPrepare,
  disabled = false,
  blockedReason,
  prepareWithoutContext = false,
}: ContextLaunchMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusEdge = useRef<"first" | "last">("first");
  const id = useId();
  const key = context ? contextKey(context) : null;
  const { activeBuild, activePipeline } = contextRunActivity(runs, context);
  const inactive = disabled;
  const reason =
    blockedReason ||
    (!context && !prepareWithoutContext
      ? "Выберите топик и проверенную рабочую копию для подготовки запуска."
      : activePipeline
        ? "В этой рабочей копии выполняется конвейер. Новый запуск доступен после его завершения."
        : "");
  const blocked = Boolean(reason || activeBuild);
  const reasonId = `${id}-reason`;
  const buildHintId = `${id}-build-hint`;
  const describedBy =
    [reason ? reasonId : "", activeBuild ? buildHintId : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  useEffect(() => setOpen(false), [key, inactive]);
  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    const item =
      focusEdge.current === "last" ? items?.[items.length - 1] : items?.[0];
    (item ?? menu.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const prepare = (kind: RunKind) => {
    if (inactive || blocked) return;
    close(true);
    onPrepare(kind);
  };
  return (
    <div
      className="context-launch"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) close();
      }}
    >
      <button
        className="primary context-launch-trigger"
        type="button"
        ref={trigger}
        disabled={inactive}
        aria-haspopup="menu"
        aria-expanded={open && !inactive}
        aria-controls={open && !inactive ? id : undefined}
        onClick={() => {
          focusEdge.current = "first";
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusEdge.current = event.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            close(true);
          }
        }}
      >
        Запустить
        <span className="context-select-chevron" aria-hidden="true" />
      </button>
      {open && !inactive && (
        <div
          id={id}
          className="context-launch-menu"
          ref={menu}
          role="menu"
          tabIndex={-1}
          aria-label="Подготовить новый запуск"
          aria-describedby={describedBy}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "Tab") {
              // Leave from the trigger's position in the normal tab order.
              trigger.current?.focus();
              close();
            } else if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              if (!items.length) return;
              const current = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (current +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[index].focus();
            }
          }}
        >
          {reason && (
            <p className="context-launch-reason" id={reasonId}>
              {reason}
            </p>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={blocked}
            aria-describedby={describedBy}
            onClick={() => prepare("pipeline")}
          >
            Конвейер<small>Описать задачу и настроить запуск</small>
          </button>
          {activeBuild ? (
            <div className="context-launch-hint" id={buildHintId}>
              <p>Сборка уже выполняется</p>
              <small>Открыть её можно через «Запуски».</small>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={blocked}
              aria-describedby={describedBy}
              onClick={() => prepare("build")}
            >
              Сборка<small>Выбрать план и настроить запуск</small>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
