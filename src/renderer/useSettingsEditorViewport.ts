import { useLayoutEffect, useState, type RefObject } from "react";
import { useViewActive } from "./RetainedViews";

/** Reserve the real footer height (including wrapped controls and errors) before
 * sizing CodeMirror. Parent scrolling must not make the editor grow again. */
export function useSettingsEditorViewport(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  identity: string,
) {
  const active = useViewActive();
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!active || !enabled || !root.current) return;
    const node = root.current;
    const editor = node.querySelector<HTMLElement>(".yaml-code-editor");
    const footer = node.querySelector<HTMLElement>(".document-editor-footer");
    if (!editor || !footer) return;
    const viewport = node.closest<HTMLElement>(".scroll-area");
    const measure = () => {
      if (!node.isConnected || !editor.getClientRects().length) return;
      const bottom = viewport
        ? viewport.getBoundingClientRect().top + viewport.clientHeight
        : window.innerHeight;
      setHeight(
        Math.max(
          96,
          Math.floor(
            bottom -
              editor.getBoundingClientRect().top -
              (viewport?.scrollTop ?? 0) -
              footer.getBoundingClientRect().height -
              18,
          ),
        ),
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(footer);
    for (
      let parent: HTMLElement | null = node;
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
  }, [active, enabled, identity, root]);
  return height;
}
