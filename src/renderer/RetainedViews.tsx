import { createPortal } from "react-dom";
import {
  Component,
  createContext,
  useContext,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./RetainedViews.css";
const ViewActive = createContext(true);
export const useViewActive = () => useContext(ViewActive);

/** Navigation changes visibility, not ownership/lifetime. Kept in memory only.
 * An owner may explicitly discard entries (e.g. when removing a project), never
 * evict silently: doing so would lose editor selection and unsaved local state. */
export function RetainedViews({
  activeKey,
  children,
  retain,
}: {
  activeKey: string | null;
  children: ReactNode;
  retain?: (key: string) => boolean;
}) {
  const parentActive = useViewActive();
  const [entries, setEntries] = useState(new Map<string, ReactNode>());
  let next = entries;
  if (retain && [...entries.keys()].some((key) => !retain(key)))
    next = new Map([...entries].filter(([key]) => retain(key)));
  if (
    activeKey !== null &&
    (!retain || retain(activeKey)) &&
    next.get(activeKey) !== children
  ) {
    next = new Map(next);
    next.set(activeKey, children);
  }
  if (next !== entries) setEntries(next);
  return (
    <>
      {[...next].map(([key, child]) => (
        <RetainedEntry key={key} active={parentActive && key === activeKey}>
          {child}
        </RetainedEntry>
      ))}
    </>
  );
}
function RetainedEntry({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [content] = useState(() => {
    const node = document.createElement("div");
    node.className = "retained-content";
    return node;
  });
  const attach = () => {
    content.hidden = !active;
    content.toggleAttribute("inert", !active);
    if (active) {
      // Moving the same DOM node again resets Chromium's nested scroll offsets.
      if (content.parentNode !== root.current)
        root.current?.appendChild(content);
    } else content.remove();
  };
  // Detaching the portal keeps React/editor state but removes inactive IDs,
  // labels and focus targets from the document. Attach before layout effects
  // on reactivation so native surfaces measure their real geometry.
  useInsertionEffect(attach, [active, content]);
  useLayoutEffect(attach, [active, content]);
  const position = useRef({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!active) return;
    // Only the outer retained section owns the shared scroll container.
    if (root.current?.parentElement?.closest(".retained-view")) return;
    const scroller = root.current?.closest<HTMLElement>(".scroll-area");
    if (!scroller) return;
    scroller.scrollTop = position.current.top;
    scroller.scrollLeft = position.current.left;
    const save = () => {
      position.current = { top: scroller.scrollTop, left: scroller.scrollLeft };
    };
    scroller.addEventListener("scroll", save);
    return () => {
      scroller.removeEventListener("scroll", save);
    };
  }, [active]);
  return (
    <ScrollSnapshot active={active} content={content}>
      <div
        className="retained-view"
        ref={root}
        hidden={!active}
        inert={!active}
      />
      {createPortal(
        <ViewActive.Provider value={active}>{children}</ViewActive.Provider>,
        content,
      )}
    </ScrollSnapshot>
  );
}

/** Chromium resets nested scroll offsets when their portal is detached.
 * Snapshot before DOM mutations: an effect cleanup runs too late after hiding.
 * This also covers editor scrollers without depending on their implementation. */
class ScrollSnapshot extends Component<{
  active: boolean;
  content: HTMLElement;
  children: ReactNode;
}> {
  private positions: { node: HTMLElement; top: number; left: number }[] = [];
  getSnapshotBeforeUpdate(previous: Readonly<ScrollSnapshot["props"]>) {
    if (previous.active && !this.props.active) {
      this.positions = [
        ...this.props.content.querySelectorAll<HTMLElement>("*"),
      ]
        .filter((node) => node.scrollTop !== 0 || node.scrollLeft !== 0)
        .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    }
    return null;
  }
  componentDidUpdate(previous: Readonly<ScrollSnapshot["props"]>) {
    if (!previous.active && this.props.active) {
      for (const { node, top, left } of this.positions) {
        if (!this.props.content.contains(node)) continue;
        node.scrollTop = top;
        node.scrollLeft = left;
      }
      this.positions = [];
    }
  }
  render() {
    return this.props.children;
  }
}
