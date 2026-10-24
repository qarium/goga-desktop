import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Fit the two scroll panes in the remaining project/card viewport. Parent
 * scrolling must not grow the panes; long content never determines their height. */
export function HistoryViewport({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!active || !root.current) return;
    const node = root.current;
    const viewport = node.closest<HTMLElement>(
      ".topic-overview-body, .scroll-area",
    );
    const measure = () => {
      if (!node.isConnected || !node.getClientRects().length) return;
      const bottom = viewport
        ? viewport.getBoundingClientRect().top + viewport.clientHeight
        : window.innerHeight;
      const panel = node.closest<HTMLElement>(".project-settings-panel");
      const bottomSpace = Math.max(
        24,
        panel ? parseFloat(getComputedStyle(panel).paddingBottom) || 0 : 0,
      );
      setHeight(
        Math.max(
          180,
          Math.floor(
            bottom -
              node.getBoundingClientRect().top -
              (viewport?.scrollTop ?? 0) -
              bottomSpace,
          ),
        ),
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    // Ancestors cover wrapping controls, header/error changes and window resize.
    for (
      let parent = node.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      observer?.observe(parent);
      if (parent === viewport) break;
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return (
    <div ref={root} className="master-detail history-detail" style={{ height }}>
      {children}
    </div>
  );
}
