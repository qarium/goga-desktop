import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useViewActive } from "./RetainedViews";
import "./RepositoryActions.css";

/** A DOM tooltip above the header, never over the native pipeline view. */
// Subscribe only while a tooltip is open: thousands of idle row buttons need
// not rerender on navigation. A body portal does not inherit its anchor's inert.
function ActiveTooltip({
  close,
  children,
}: {
  close: () => void;
  children: ReactNode;
}) {
  const active = useViewActive();
  useLayoutEffect(() => {
    if (!active) close();
  }, [active, close]);
  return active ? children : null;
}

export function TooltipButton({
  disabled,
  label,
  tooltipLabel = label,
  busy,
  description = "",
  onClick,
  children,
  buttonClassName = "repository-action-button",
  sidebar = false,
  tooltipEnabled = true,
  fitViewport = false,
  tabProps,
  native,
}: {
  native?: ComponentPropsWithRef<"button">;
  tabProps?: Pick<
    ButtonHTMLAttributes<HTMLButtonElement>,
    | "role"
    | "aria-selected"
    | "aria-pressed"
    | "tabIndex"
    | "onKeyDown"
    | "onDoubleClick"
    | "onContextMenu"
  >;
  buttonClassName?: string;
  sidebar?: boolean;
  tooltipEnabled?: boolean;
  fitViewport?: boolean;
  disabled: boolean;
  label: string;
  tooltipLabel?: string;
  busy: boolean;
  description?: string;
  onClick?: NonNullable<ButtonHTMLAttributes<HTMLButtonElement>["onClick"]>;
  children?: ReactNode;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const direct = useRef<HTMLButtonElement>(null);
  useImperativeHandle(native?.ref, () => direct.current!, []);
  const trigger = native ? direct : anchor;
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
      if (trigger.current?.ownerDocument.activeElement !== tooltip.current)
        setOpen(false);
    }, 180);
  };
  const contains = (target: EventTarget | null) => {
    const NodeType = trigger.current?.ownerDocument.defaultView?.Node;
    return (
      !!NodeType &&
      target instanceof NodeType &&
      (!!trigger.current?.contains(target) ||
        !!tooltip.current?.contains(target))
    );
  };
  const returnFocus = () => {
    const control = native
      ? direct.current
      : disabled
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
  const document = trigger.current?.ownerDocument;
  useLayoutEffect(() => {
    if (!open || !document?.defaultView) return;
    const view = document.defaultView;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
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
      const below =
        fitViewport &&
        Math.max(height, tooltip.current?.scrollHeight ?? 0) > top - 16 &&
        view.innerHeight - rect.bottom > top;
      setPosition({
        left: Math.max(
          8,
          Math.min(
            rect.left + (rect.width - actualWidth) / 2,
            view.innerWidth - actualWidth - 8,
          ),
        ),
        top: below ? rect.bottom + 8 : Math.max(8, top - height - 8),
        maxWidth: width,
        maxHeight: Math.max(
          0,
          (below ? view.innerHeight - rect.bottom : top) - 16,
        ),
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // A compact button hint must not swallow Escape meant for its menu or dialog.
        if (!native || document.activeElement === tooltip.current) event.stopPropagation();
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
    fitViewport,
    tooltipLabel,
    document,
    description,
    disabled,
    position.maxWidth,
    position.maxHeight,
  ]);

  const keydown = (event: ReactKeyboardEvent<HTMLElement>) => {
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
  };
  const bubble =
    open &&
    document &&
    createPortal(
      <ActiveTooltip close={() => setOpen(false)}>
        <div
          ref={tooltip}
          id={id}
          role="tooltip"
          onKeyDown={native ? keydown : undefined}
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
          {description && (
            <>
              {": "}
              <span>{description}</span>
            </>
          )}
        </div>
      </ActiveTooltip>,
      trigger.current?.closest("dialog[open]") ?? document.body,
    );
  if (native) {
    const describedBy =
      [native["aria-describedby"], open ? id : undefined]
        .filter(Boolean)
        .join(" ") || undefined;
    return (
      <>
        <button
          {...native}
          ref={direct}
          title=""
          aria-description={
            native["aria-description"] ??
            (tooltipLabel !== native["aria-label"]
              ? tooltipLabel || undefined
              : undefined)
          }
          aria-describedby={describedBy}
          onMouseEnter={(e) => {
            native.onMouseEnter?.(e);
            show();
          }}
          onMouseLeave={(e) => {
            native.onMouseLeave?.(e);
            leave();
          }}
          onFocus={(e) => {
            native.onFocus?.(e);
            show();
          }}
          onBlur={(e) => {
            native.onBlur?.(e);
            if (!contains(e.relatedTarget)) setOpen(false);
          }}
          onKeyDown={(e) => {
            native.onKeyDown?.(e);
            if (!e.defaultPrevented) keydown(e);
          }}
          onClick={(e) => {
            setOpen(false);
            native.onClick?.(e);
          }}
        >
          {children}
        </button>
        {bubble}
      </>
    );
  }
  return (
    <span
      ref={anchor}
      className={
        sidebar
          ? "repository-action-anchor sidebar-project-anchor"
          : "repository-action-anchor"
      }
      title={fitViewport ? "" : undefined}
      tabIndex={disabled ? 0 : undefined}
      aria-describedby={disabled && open ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={leave}
      onFocus={show}
      onBlur={(e) => {
        if (!contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={keydown}
    >
      <button
        {...tabProps}
        type="button"
        className={buttonClassName}
        title={
          sidebar && !tooltipEnabled
            ? description
            : fitViewport
              ? ""
              : undefined
        }
        disabled={disabled}
        aria-label={label}
        aria-busy={busy}
        aria-describedby={open ? id : undefined}
        onClick={onClick}
      >
        {children}
      </button>
      {bubble}
    </span>
  );
}

/** Keeps the original button as the layout/focus target, including inside dialogs and foreign documents. */
export function HintButton({
  hint,
  children,
  ...native
}: ComponentPropsWithRef<"button"> & { hint?: string }) {
  return (
    <TooltipButton
      native={native}
      label={hint ?? ""}
      disabled={!!native.disabled}
      busy={false}
      tooltipEnabled={!!hint}
      fitViewport
    >
      {children}
    </TooltipButton>
  );
}
