import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Project } from "../shared/types";
import type { WorktreeRecord } from "../shared/worktrees";
import type { RepositoryActionRequest } from "../shared/repository-actions";
import { contextRef } from "./topic-context";
import { topicSyncUnavailable } from "./topic-sync-controller";
import {
  repositoryActionKey,
  useRepositoryActionController,
} from "./repository-action-controller";
import { TopicPickerPopup, dismissActiveTopicPopup } from "./TopicPickerPopup";
import "./RepositoryActions.css";

export function RepositoryIcon({
  action,
}: {
  action: RepositoryActionRequest["action"];
}) {
  if (action === "update-remote") return <span aria-hidden="true">↻</span>;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={action === "sync" || action === "propagate" ? "2" : "1.8"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {action === "sync" ? (
        <>
          {/* Lucide refresh-cw: https://github.com/lucide-icons/lucide/blob/main/icons/refresh-cw.svg */}
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </>
      ) : action === "publish" ? (
        <>
          <path d="M7 18H6a4 4 0 0 1-.7-7.94 7 7 0 0 1 13.4 0A4 4 0 0 1 18 18h-1M12 21V11M8 15l4-4 4 4" />
        </>
      ) : action === "propagate" ? (
        <>
          {/* Lucide git-merge: https://github.com/lucide-icons/lucide/blob/main/icons/git-merge.svg */}
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </>
      ) : (
        <path d="M12 3v12M8 11l4 4 4-4M4 16v5h16v-5" />
      )}
    </svg>
  );
}

export function RepositoryActions({
  project,
  selected,
  disabled = false,
  onlySync = false,
  onStarted,
}: {
  project: Project;
  selected: WorktreeRecord | null;
  disabled?: boolean;
  onlySync?: boolean;
  onStarted?: () => void;
}) {
  const controller = useRepositoryActionController();
  const context = selected ? contextRef(selected) : undefined;
  const request = { projectId: project.id, ...(context ? { context } : {}) };
  const busy = controller.busy.has(repositoryActionKey(request));
  const unavailable = selected
    ? selected.projectId !== project.id
      ? "Контекст другого проекта."
      : topicSyncUnavailable(selected)
    : "";
  const available = typeof window.goga.runRepositoryAction === "function";
  const actions: RepositoryActionRequest["action"][] = onlySync
    ? ["sync"]
    : selected
      ? ["sync", "publish", "update-base", "propagate", "update-remote"]
      : ["sync", "publish"];
  const labels = {
    sync:
      onlySync && selected
        ? `Синхронизировать коммиты · ${selected.topic}/${selected.year}/${selected.branch}`
        : selected
          ? "Синхронизировать топик"
          : "Синхронизировать текущую ветку",
    publish: selected ? "Опубликовать топик" : "Опубликовать текущую ветку",
    "update-remote": "Обновить топик из remote",
    "update-base": "Обновить из base",
    propagate: "Перенести топик в base и опубликовать",
  };
  const tooltipLabels = {
    sync: "Синхронизировать",
    publish: "Опубликовать",
    "update-remote": "Обновить топик из remote",
    "update-base": "Обновить из base",
    propagate: "Перенести топик в base и опубликовать",
  };
  const descriptions = {
    "update-remote":
      "Коммиты: origin → ветка топика в исходном проекте → копия; только fast-forward, без публикации",
    sync: selected
      ? "Коммиты: копия → исходный проект"
      : "Обновить текущую ветку из upstream (fast-forward)",
    publish: selected
      ? "Коммиты: копия → исходный проект → origin"
      : "Опубликовать текущую ветку в origin",
    propagate:
      "Синхронизировать копию; перенести топик в base и опубликовать base в origin",
    "update-base":
      "Обновить base из remote; получить в копию и выполнить goga topics update",
  };
  return (
    <div
      className={
        onlySync
          ? "repository-actions repository-actions-row"
          : "repository-actions"
      }
      role="group"
      aria-label="Действия с веткой"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (
          ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
        )
          e.stopPropagation();
      }}
    >
      {actions.map((action) => (
        <TooltipButton
          key={action}
          disabled={disabled || busy || !available || !!unavailable}
          label={labels[action]}
          tooltipLabel={tooltipLabels[action]}
          busy={busy}
          description={
            unavailable ||
            (!available
              ? "Действие недоступно в этой версии хоста"
              : busy
                ? "Операция выполняется…"
                : disabled
                  ? "Действие временно недоступно"
                  : descriptions[action])
          }
          onClick={() => {
            void controller.run(
              { ...request, action },
              `${project.name} · ${selected ? `${selected.topic} · ${selected.year} · ${selected.branch}` : "Без топика · исходный проект"}`,
            );
            onStarted?.();
          }}
        >
          <RepositoryIcon action={action} />
        </TooltipButton>
      ))}
    </div>
  );
}

/** A DOM tooltip above the header, never over the native pipeline view. */
export function TooltipButton({
  disabled,
  label,
  tooltipLabel,
  busy,
  description,
  onClick,
  children,
  buttonClassName = "repository-action-button",
  sidebar = false,
  tooltipEnabled = true,
}: {
  buttonClassName?: string;
  sidebar?: boolean;
  tooltipEnabled?: boolean;
  disabled: boolean;
  label: string;
  tooltipLabel: string;
  busy: boolean;
  description: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const cancelLeave = () => {
    clearTimeout(leaveTimer.current);
  };
  const show = () => {
    cancelLeave();
    if (tooltipEnabled) setOpen(true);
  };
  useEffect(() => {
    if (!tooltipEnabled) setOpen(false);
  }, [tooltipEnabled]);
  const leave = () => {
    cancelLeave();
    leaveTimer.current = setTimeout(() => {
      if (anchor.current?.ownerDocument.activeElement !== tooltip.current)
        setOpen(false);
    }, 180);
  };
  const contains = (target: EventTarget | null) => {
    const NodeType = anchor.current?.ownerDocument.defaultView?.Node;
    return (
      !!NodeType &&
      target instanceof NodeType &&
      (!!anchor.current?.contains(target) ||
        !!tooltip.current?.contains(target))
    );
  };
  const returnFocus = () => {
    const control = disabled
      ? anchor.current
      : anchor.current?.querySelector("button");
    control?.focus();
  };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const [position, setPosition] = useState({
    left: 8,
    top: 8,
    maxWidth: 640,
    maxHeight: 0,
  });
  const document = anchor.current?.ownerDocument;
  useLayoutEffect(() => {
    if (!open || !document?.defaultView) return;
    const view = document.defaultView;
    const place = () => {
      const rect = anchor.current!.getBoundingClientRect();
      // Native pipeline content is a separate view; keep sidebar hints above it.
      const top = sidebar
        ? Math.min(
            rect.top,
            document.querySelector(".project-bar")?.getBoundingClientRect()
              .bottom ?? 52,
          )
        : rect.top;
      const width = Math.min(640, Math.max(0, view.innerWidth - 16));
      const height = tooltip.current?.getBoundingClientRect().height ?? 0;
      const actualWidth =
        tooltip.current?.getBoundingClientRect().width || width;
      setOverflowing(
        !!tooltip.current &&
          tooltip.current.scrollHeight > tooltip.current.clientHeight,
      );
      setPosition({
        left: Math.max(
          8,
          Math.min(
            rect.left + (rect.width - actualWidth) / 2,
            view.innerWidth - actualWidth - 8,
          ),
        ),
        top: Math.max(8, top - height - 8),
        maxWidth: width,
        maxHeight: Math.max(0, top - 16),
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        cancelLeave();
        if (document.activeElement === tooltip.current) returnFocus();
        setOpen(false);
      }
    };
    place();
    view.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      view.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [
    open,
    sidebar,
    document,
    description,
    disabled,
    position.maxWidth,
    position.maxHeight,
  ]);
  return (
    <span
      ref={anchor}
      className={
        sidebar
          ? "repository-action-anchor sidebar-project-anchor"
          : "repository-action-anchor"
      }
      tabIndex={disabled ? 0 : undefined}
      aria-describedby={disabled && open ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={leave}
      onFocus={show}
      onBlur={(event) => {
        if (!contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && overflowing && event.key === "Tab") {
          if (event.target === tooltip.current) {
            if (event.shiftKey) {
              event.preventDefault();
              returnFocus();
            } else {
              // Resume native Tab navigation from the control, not the portal
              // at the end of body. Do not prevent the browser's default Tab.
              returnFocus();
              setOpen(false);
            }
          } else if (!event.shiftKey) {
            event.preventDefault();
            tooltip.current?.focus();
          }
        }
      }}
    >
      <button
        type="button"
        className={buttonClassName}
        title={sidebar && !tooltipEnabled ? description : undefined}
        disabled={disabled}
        aria-label={label}
        aria-busy={busy}
        aria-describedby={open ? id : undefined}
        onClick={onClick}
      >
        {children}
      </button>
      {open &&
        document &&
        createPortal(
          <div
            ref={tooltip}
            id={id}
            role="tooltip"
            tabIndex={overflowing ? 0 : -1}
            onMouseEnter={show}
            onMouseLeave={leave}
            className="repository-action-tooltip"
            style={{
              position: "fixed",
              ...position,
              overflowY: "auto",
              pointerEvents: "auto",
            }}
          >
            <strong>{tooltipLabel}</strong>
            {": "}
            <span>{description}</span>
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Same-origin native overlay stays above Electron's pipeline WebContentsView. */
export function RepositoryOperationPopup({
  anchor,
}: {
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const controller = useRepositoryActionController();
  const failure = controller.failures[0];
  const [ready, setReady] = useState<typeof failure>();
  useEffect(() => {
    let alive = true;
    if (failure)
      void dismissActiveTopicPopup()
        .then(() => {
          if (alive) setReady(failure);
        })
        .catch(() => {
          if (alive) setReady(failure);
        });
    return () => {
      alive = false;
    };
  }, [failure]);
  if (!failure || ready !== failure) return null;
  return (
    <TopicPickerPopup
      anchor={anchor}
      onClose={controller.close}
      label="Ошибка операции"
    >
      <OperationFailure
        label={failure.label}
        log={failure.result.log}
        error={failure.result.error || "Операция не выполнена"}
        onClose={controller.close}
      />
    </TopicPickerPopup>
  );
}
function OperationFailure({
  label,
  log,
  error,
  onClose,
}: {
  label: string;
  log: string;
  error: string;
  onClose: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    button.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <section
      className="repository-operation-popup"
      role="dialog"
      aria-label="Ошибка операции"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <h2>Ошибка операции</h2>
          <p>{label}</p>
        </div>
        <button
          ref={button}
          type="button"
          className="icon-button"
          aria-label="Закрыть попап"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <pre aria-label="Лог операции">{log}</pre>
      <p className="repository-operation-error" role="alert">
        {error}
      </p>
    </section>
  );
}
