import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import type { DemoTab } from "../../shared/demonstrations";
import "../WorkspaceTabs.css";

export function DemoTabs({
  tabs,
  activeTabId,
  disabled,
  select,
  close,
  create,
}: {
  tabs: readonly DemoTab[];
  activeTabId: string | null | undefined;
  disabled: boolean;
  select: (tabId: string) => void;
  close: (tabId: string) => void;
  create: () => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>()),
    scroller = useRef<HTMLDivElement>(null),
    createButton = useRef<HTMLButtonElement>(null),
    closingWithFocus = useRef<string | null>(null);
  const entryTabId = tabs.some((tab) => tab.tabId === activeTabId)
    ? activeTabId
    : tabs[0]?.tabId;
  useEffect(() => {
    if (activeTabId)
      buttons.current.get(activeTabId)?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
  }, [activeTabId]);
  useEffect(() => {
    const el = scroller.current!;
    function wheel(event: WheelEvent) {
      if (
        event.ctrlKey ||
        event.metaKey ||
        el.scrollWidth <= el.clientWidth ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      )
        return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    }
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  useLayoutEffect(() => {
    const closing = closingWithFocus.current;
    if (disabled || closing === null) return;
    closingWithFocus.current = null;
    if (tabs.some((tab) => tab.tabId === closing)) return;
    const selected = activeTabId ? buttons.current.get(activeTabId) : undefined;
    (selected ?? createButton.current)?.focus();
  }, [tabs, activeTabId, disabled]);
  function move(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const next =
      e.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[next];
    buttons.current.get(tab.tabId)?.focus();
    if (tab.tabId !== activeTabId) select(tab.tabId);
  }
  return (
    <div className="demo-tabs-bar">
      <div
        className="demo-tabs"
        ref={scroller}
        role="tablist"
        aria-label="Вкладки показа"
      >
        {tabs.map((tab, index) => {
          const label =
            tab.title === "about:blank" && tab.url === null
              ? "Новая вкладка"
              : tab.title.trim() || tab.url || "Новая вкладка";
          const selected = tab.tabId === activeTabId;
          return (
            <div
              className="workspace-tab demo-tab"
              data-selected={selected}
              key={tab.tabId}
              role="presentation"
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="workspace-tab-select demo-tab-select"
                tabIndex={tab.tabId === entryTabId ? 0 : -1}
                title={label}
                disabled={disabled}
                ref={(el) => {
                  if (el) buttons.current.set(tab.tabId, el);
                  else buttons.current.delete(tab.tabId);
                }}
                onClick={() => {
                  if (!selected) select(tab.tabId);
                }}
                onKeyDown={(e) => move(e, index)}
              >
                <span>{label}</span>
              </button>
              <button
                type="button"
                className="workspace-tab-close demo-tab-close"
                aria-label={"Закрыть вкладку: " + label}
                title={"Закрыть вкладку: " + label}
                disabled={disabled}
                onClick={(e) => {
                  if (document.activeElement === e.currentTarget)
                    closingWithFocus.current = tab.tabId;
                  close(tab.tabId);
                }}
              >
                <X size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="workspace-tab-create demo-tab-create"
        aria-label="Создать вкладку"
        title="Создать вкладку"
        disabled={disabled}
        ref={createButton}
        onClick={create}
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
