import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type Ref,
} from "react";

type Position = { top: number; left: number };
export type HistoryScrollPositions = Map<string, Position>;
export type HistoryScrollHandle = {
  preserveReadingPosition: (changeLayout: () => void) => void;
};
type Props = {
  ref?: Ref<HistoryScrollHandle>;
  positionKey: string;
  positions: HistoryScrollPositions;
  active: boolean;
  label: string;
  children: ReactNode;
  className?: string;
  showTopButton?: boolean;
  actions?: ReactNode;
};
const scrollKeys = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  // Tab / Shift+Tab can scroll the region to reveal its next focused file.
  "Tab",
]);
function limits(element: HTMLElement): Position {
  return {
    top: Math.max(0, element.scrollHeight - element.clientHeight),
    left: Math.max(0, element.scrollWidth - element.clientWidth),
  };
}

/** Positions belong to the retained parent, never to a loading-state DOM node. */
export function HistoryScrollPane({
  ref,
  label,
  children,
  positionKey,
  positions,
  active,
  className,
  showTopButton = false,
  actions,
}: Props) {
  const region = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const restoration = useRef<Position | null>(null);
  const manualLayout = useRef<Position | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      preserveReadingPosition(changeLayout) {
        const element = region.current;
        if (!element || !active) {
          changeLayout();
          return;
        }
        const old = { top: element.scrollTop, left: element.scrollLeft };
        const edge = element.getBoundingClientRect().top;
        const blocks = element.querySelectorAll<HTMLElement>(
          ".history-markdown > *, .history-plain, .history-empty",
        );
        const anchor = [...blocks].find(
          (node) => node.getBoundingClientRect().bottom > edge + 1,
        );
        const offset = anchor ? anchor.getBoundingClientRect().top - edge : 0;
        // Suspend the old pixel target before synchronous modal/reflow changes.
        restoration.current = null;
        changeLayout();
        element.scrollTop =
          old.top === 0
            ? 0
            : anchor?.isConnected
              ? element.scrollTop +
                anchor.getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                offset
              : old.top;
        element.scrollLeft = old.left;
        const target = { top: element.scrollTop, left: element.scrollLeft };
        positions.set(positionKey, target);
        restoration.current = target;
        manualLayout.current = limits(element);
      },
    }),
    [active, positionKey, positions],
  );

  useLayoutEffect(() => {
    manualLayout.current = null;
    restoration.current = null;
    const element = region.current;
    if (!active || !element) return;
    restoration.current = positions.get(positionKey) ?? { top: 0, left: 0 };
    let disposed = false;
    const restore = () => {
      if (disposed) return;
      const target = restoration.current;
      if (target) {
        // Keep the original target even when the current Markdown placeholder
        // clamps these assignments. A later content resize retries it.
        element.scrollTop = target.top;
        element.scrollLeft = target.left;
      } else if (manualLayout.current) {
        const available = limits(element);
        if (
          available.top < manualLayout.current.top ||
          available.left < manualLayout.current.left
        ) {
          // Layout clamps are not user choices. Do not re-arm restoration after
          // manual input: subsequent document expansion must not yank the reader.
          manualLayout.current = null;
        }
      }
    };
    restore();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(restore);
    observer?.observe(element);
    if (content.current) observer?.observe(content.current);
    return () => {
      disposed = true;
      observer?.disconnect();
      // Hidden/loading/unmount DOM offsets may already be zero: never save here.
    };
  }, [active, positionKey, positions]);

  const manualInput = () => {
    if (!active || !region.current) return;
    restoration.current = null;
    manualLayout.current = limits(region.current);
  };
  const savePosition = () => {
    const element = region.current;
    const previousLayout = manualLayout.current;
    if (!active || !element || !previousLayout) return;
    const available = limits(element);
    if (
      available.top < previousLayout.top ||
      available.left < previousLayout.left
    ) {
      manualLayout.current = null;
      return;
    }
    positions.set(positionKey, {
      top: element.scrollTop,
      left: element.scrollLeft,
    });
    manualLayout.current = available;
  };
  const goToTop = () => {
    if (!active || !region.current) return;
    const top = { top: 0, left: 0 };
    positions.set(positionKey, top);
    restoration.current = top;
    manualLayout.current = null;
    region.current.scrollTop = 0;
    region.current.scrollLeft = 0;
  };

  return (
    <div
      className={["history-scroll-pane", className].filter(Boolean).join(" ")}
    >
      {(showTopButton || actions) && (
        <div className="history-scroll-toolbar">
          {showTopButton && (
            <button type="button" onClick={goToTop} disabled={!active}>
              Наверх
            </button>
          )}
          {actions}
        </div>
      )}
      <div
        ref={region}
        className="history-scroll-region"
        role="region"
        aria-label={label}
        tabIndex={0}
        onScroll={savePosition}
        onWheelCapture={manualInput}
        onPointerDownCapture={manualInput}
        onTouchStartCapture={manualInput}
        onKeyDownCapture={(event) => {
          if (scrollKeys.has(event.key)) manualInput();
        }}
      >
        <div ref={content} className="history-scroll-content">
          {children}
        </div>
      </div>
    </div>
  );
}
