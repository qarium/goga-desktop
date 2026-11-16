import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type { EditorView } from "@codemirror/view";

const position = (node: HTMLElement) => ({
  top: node.scrollTop,
  left: node.scrollLeft,
});
type Position = ReturnType<typeof position>;

export function useProjectDocumentExpansion(
  pane: RefObject<HTMLElement | null>,
  identity: string | null,
) {
  const editor = useRef<EditorView | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expanded = identity !== null && expandedKey === identity;
  // Retained views become inactive without unmounting. Never enlarge the next
  // document, steal its focus, or resume enlarged after returning to this one.
  if (expandedKey !== null && !expanded) setExpandedKey(null);

  const snapshot = useRef<{
    before: Position;
    after: Position;
    outer?: Position;
  } | null>(null);
  const toggle = useCallback(() => {
    const view = editor.current;
    if (!identity || !view || !pane.current?.isConnected) return;
    const scroller = view.scrollDOM;
    const outer = pane.current.closest<HTMLElement>(".scroll-area");
    const before = position(scroller);
    const outerPosition = outer ? position(outer) : undefined;
    const previous = expanded ? snapshot.current : null;
    // Read both sides of a single committed resize, before the browser paints.
    // The same live EditorView keeps its selection and undo history.
    flushSync(() => setExpandedKey(expanded ? null : identity));
    if (previous?.outer && outer) {
      outer.scrollTop = previous.outer.top;
      outer.scrollLeft = previous.outer.left;
    }
    view.focus();
    // The expanded viewport may clamp either axis near the end. Restore its
    // old offset only if the user did not scroll that axis in the meantime.
    scroller.scrollTop =
      previous && previous.after.top === before.top
        ? previous.before.top
        : before.top;
    scroller.scrollLeft =
      previous && previous.after.left === before.left
        ? previous.before.left
        : before.left;
    snapshot.current = expanded
      ? null
      : { before, after: position(scroller), outer: outerPosition };
    view.requestMeasure();
  }, [expanded, identity, pane]);

  useEffect(() => {
    if (!expanded) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented)
        return;
      // Sidebar controls, nested confirmations and unrelated dialogs own their Escape.
      const target = event.target;
      if (
        target !== document &&
        target !== document.body &&
        (!(target instanceof Element) ||
          !pane.current?.contains(target) ||
          target.closest("dialog, [role='dialog']"))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    // Capture before CodeMirror's Escape binding can simplify the selection.
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [expanded, pane, toggle]);

  return { editor, expanded, toggle };
}
