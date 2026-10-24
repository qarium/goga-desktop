import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  HistoryScrollPane,
  type HistoryScrollHandle,
  type HistoryScrollPositions,
} from "./HistoryScrollPane";
import "./HistoryDocument.css";

/** The same document stays mounted in normal flow and in the modal top layer. */
export function HistoryDocument({
  identity,
  active,
  ready,
  readable,
  positions,
  title,
  format,
  contextLabel,
  children,
}: {
  identity: string;
  active: boolean;
  ready: boolean;
  readable: boolean;
  positions: HistoryScrollPositions;
  title: string;
  format: string;
  contextLabel: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const scroll = useRef<HistoryScrollHandle>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const expandedRef = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string>();
  const transaction = (change: () => void) =>
    scroll.current ? scroll.current.preserveReadingPosition(change) : change();
  const collapse = (restoreFocus = true) => {
    if (!expandedRef.current || !dialog.current) return;
    const node = dialog.current;
    const restoreLayout = () => {
      release.current?.();
      release.current = null;
      node.close();
      node.classList.remove("history-reader-expanded");
      node.removeAttribute("style");
      // Non-modal open dialog returns to its original place in normal flow.
      node.open = true;
    };
    // On invalidation/unmount the DOM may already be detached or owned by the
    // next file. Never overwrite saved reading positions with those offsets.
    if (restoreFocus) transaction(restoreLayout);
    else restoreLayout();
    expandedRef.current = false;
    setExpanded(false);
    if (restoreFocus) toggle.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!active) collapse(false);
    setError(undefined);
    return () => collapse(false);
  }, [active, identity]);

  const expand = () => {
    const node = dialog.current;
    // Selector cards are siblings of main-area in App, not its descendants.
    // Stay scoped to this shell rather than selecting an unrelated workspace.
    const workspace =
      root.current?.closest<HTMLElement>(".main-area") ??
      root.current
        ?.closest(".app-shell")
        ?.querySelector<HTMLElement>(":scope > .main-area");
    if (!node || !workspace || !active) {
      setError("Не удалось определить рабочую область для просмотра.");
      return;
    }
    const parent = root.current?.closest<HTMLDialogElement>(
      "dialog.topic-dialog",
    );
    const measure = () => {
      const rect = workspace.getBoundingClientRect();
      Object.assign(node.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    };
    try {
      transaction(() => {
        measure();
        node.close();
        node.classList.add("history-reader-expanded");
        node.showModal();
        parent?.classList.add("history-reader-parent");
      });
      expandedRef.current = true;
      setExpanded(true);
      setError(undefined);
      const resize = () => transaction(measure);
      const observer =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(resize);
      observer?.observe(workspace);
      // A collapsed sidebar changes main-area's left edge as well as its width.
      if (workspace.parentElement) observer?.observe(workspace.parentElement);
      window.addEventListener("resize", resize);
      release.current = () => {
        observer?.disconnect();
        window.removeEventListener("resize", resize);
        parent?.classList.remove("history-reader-parent");
      };
      toggle.current?.focus({ preventScroll: true });
    } catch {
      release.current?.();
      release.current = null;
      expandedRef.current = false;
      setExpanded(false);
      parent?.classList.remove("history-reader-parent");
      node.close();
      node.classList.remove("history-reader-expanded");
      node.removeAttribute("style");
      node.open = true;
      setError("Не удалось развернуть документ. Обычный просмотр доступен.");
    }
  };
  return (
    <div className="history-document" ref={root}>
      <dialog
        open
        ref={dialog}
        className="history-reader"
        role={expanded ? "dialog" : "region"}
        aria-modal={expanded || undefined}
        aria-label={`Просмотр ${title}`}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          collapse();
        }}
      >
        {expanded && (
          <div className="history-reader-context">
            <span>{contextLabel}</span>
            <span>Только просмотр · Esc — свернуть</span>
          </div>
        )}
        <div className="history-reader-body">
          <header className="history-document-head">
            <h3>{title}</h3>
            <span>{format}</span>
          </header>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <HistoryScrollPane
            ref={scroll}
            positionKey={identity}
            positions={positions}
            active={ready}
            label="Содержимое артефакта"
            showTopButton={readable}
            actions={
              readable && (
                <button
                  type="button"
                  ref={toggle}
                  disabled={!active}
                  aria-label={
                    expanded ? "Свернуть документ" : "Развернуть документ"
                  }
                  aria-expanded={expanded}
                  onClick={() => (expanded ? collapse() : expand())}
                >
                  {expanded ? "Свернуть" : "Развернуть"}
                </button>
              )
            }
          >
            {children}
          </HistoryScrollPane>
        </div>
      </dialog>
    </div>
  );
}
