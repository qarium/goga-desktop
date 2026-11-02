import { useLayoutEffect, useState } from "react";

/** Native dashboards follow the same content viewport as the React pages. */
export function useDashboardViewport(onError: (error: unknown) => void) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!element || !window.goga.setDashboardViewport) return;
    let last = "";
    let alive = true;
    const report = () => {
      if (!alive) return;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const bounds = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
      const key = JSON.stringify(bounds);
      if (key === last) return;
      last = key;
      void window.goga.setDashboardViewport!(bounds).catch((error) => {
        if (alive) onError(error);
      });
    };
    report();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(report) : null;
    observer?.observe(element);
    window.addEventListener("resize", report);
    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [element, onError]);
  return setElement;
}
