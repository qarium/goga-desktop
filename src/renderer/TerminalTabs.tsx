import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ScopeRef } from "../shared/context";
import type {
  TerminalCatalogChange,
  TerminalCatalogSnapshot,
} from "../shared/terminal-catalog";
import type { TerminalTab } from "../shared/terminal";
import { useViewActive } from "./RetainedViews";
import { TooltipButton } from "./RepositoryActions";
import {
  TopicPickerPopup,
  dismissActiveTopicPopup,
  hasNativeTopicPopup,
} from "./TopicPickerPopup";
import { TerminalActionIcon } from "./TerminalActionIcon";

export const terminalArea = (tab: TerminalTab) =>
  tab.scope.kind === "common"
    ? "Общий терминал"
    : tab.scope.context.kind === "primary"
      ? "Терминал проекта"
      : "Терминал топика";
type Capture = { tabId: string; revision: string };
type Props = {
  scope: ScopeRef;
  state?: TerminalCatalogSnapshot;
  busy: boolean;
  locked: boolean;
  refreshDisabled: boolean;
  onChange(value: TerminalCatalogChange): Promise<boolean>;
  onClose(tabId: string): void;
  onRefresh(): void;
  onError(message: string): void;
};

/** Metadata controls only. Never mount/unmount or reopen a terminal screen. */
export function TerminalTabs({
  scope,
  state,
  busy,
  locked,
  refreshDisabled,
  onChange,
  onClose,
  onRefresh,
  onError,
}: Props) {
  const active = useViewActive();
  const [adding, setAdding] = useState(false),
    [menu, setMenu] = useState<Capture | null>(null);
  const [rename, setRename] = useState<(Capture & { name: string }) | null>(
    null,
  );
  const selection = useRef<string | null>(null);
  const [selectionDone, setSelectionDone] = useState(0);
  const [pendingRename, setPendingRename] = useState<string | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const addAnchor = useRef<HTMLButtonElement>(null),
    actionAnchor = useRef<HTMLButtonElement | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null),
    tabsRoot = useRef<HTMLDivElement>(null);
  const drag = useRef<(Capture & { scope: string }) | null>(null);
  const saving = useRef(false),
    alive = useRef(true),
    sequence = useRef(0);
  const unavailable = busy || locked || !state;
  const selected = state?.selectedId;
  const actionTab = state?.tabs.find((t) => t.id === menu?.tabId);
  const closeMenus = () => {
    ++sequence.current;
    setAdding(false);
    setMenu(null);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++sequence.current;
    };
  }, []);
  useEffect(() => {
    if (!active) {
      closeMenus();
      setRename(null);
      setPendingRename(null);
      drag.current = null;
      setDrop(null);
    }
  }, [active]);
  useEffect(() => {
    if (!adding && !menu) return;
    const dismiss = (event: PointerEvent) => {
      const node = event.target as Node;
      if (
        !menuRoot.current?.contains(node) &&
        !addAnchor.current?.contains(node) &&
        !actionAnchor.current?.contains(node)
      )
        closeMenus();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [adding, menu]);
  useEffect(() => {
    if (!active || !pendingRename || selection.current || busy || !state)
      return;
    const tab = state.tabs.find((t) => t.id === pendingRename);
    setPendingRename(null);
    if (tab && !locked)
      setRename({ tabId: tab.id, revision: state.revision, name: tab.name });
  }, [active, pendingRename, selectionDone, busy, state, locked]);
  async function openMenu(
    kind: "add" | "actions",
    target?: Capture,
    anchor?: HTMLButtonElement,
  ) {
    if (unavailable) return;
    const order = ++sequence.current;
    try {
      if (hasNativeTopicPopup()) await dismissActiveTopicPopup();
      if (!alive.current || order !== sequence.current) return;
      if (anchor) actionAnchor.current = anchor;
      setRename(null);
      setAdding(kind === "add");
      setMenu(kind === "actions" ? target! : null);
    } catch (e) {
      if (alive.current)
        onError(e instanceof Error ? e.message : "Не удалось открыть меню.");
    }
  }
  const focusTab = (id: string) =>
    [
      ...(tabsRoot.current?.querySelectorAll<HTMLElement>(
        "[data-terminal-id]",
      ) ?? []),
    ]
      .find((node) => node.dataset.terminalId === id)
      ?.querySelector<HTMLButtonElement>('[role="tab"]')
      ?.focus();
  function beginRename(tab: TerminalTab, revision = state!.revision) {
    closeMenus();
    if (selection.current === tab.id) {
      setPendingRename(tab.id);
      return;
    }
    if (unavailable) return;
    setRename({ tabId: tab.id, revision, name: tab.name });
  }
  async function submitRename() {
    if (!rename || saving.current || unavailable || !rename.name.trim()) return;
    saving.current = true;
    const draft = rename;
    const ok = await onChange({
      kind: "rename",
      scope,
      revision: draft.revision,
      tabId: draft.tabId,
      name: draft.name.trim(),
    });
    saving.current = false;
    if (ok && alive.current) {
      setRename((current) => (current === draft ? null : current));
      queueMicrotask(() => focusTab(draft.tabId));
    }
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      const anchor = adding ? addAnchor.current : actionAnchor.current;
      closeMenus();
      anchor?.focus();
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [
        ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ),
      ];
      const i = items.indexOf(
        event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
      );
      items[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length
      ]?.focus();
    }
  }
  const create = (area: "common" | "context") => {
    if (!state || unavailable) return;
    closeMenus();
    void onChange({ kind: "create", scope, revision: state.revision, area });
  };
  return (
    <div className="terminal-tabs-row">
      <div
        role="tablist"
        aria-label="Вкладки терминала"
        className="terminal-tabs"
        ref={tabsRoot}
      >
        {state?.tabs.map((tab) => (
          <div
            className="terminal-tab"
            key={tab.id}
            data-terminal-id={tab.id}
            data-selected={selected === tab.id}
            data-drop={drop === tab.id || undefined}
            draggable={!unavailable && !rename}
            onDragStart={(event) => {
              if (unavailable || rename) {
                event.preventDefault();
                return;
              }
              closeMenus();
              drag.current = {
                tabId: tab.id,
                revision: state.revision,
                scope: JSON.stringify(scope),
              };
              event.dataTransfer.setData(
                "application/x-goga-terminal-tab",
                tab.id,
              );
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (
                drag.current &&
                !unavailable &&
                drag.current.scope === JSON.stringify(scope)
              ) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDrop(tab.id);
              }
            }}
            onDragLeave={() => setDrop(null)}
            onDragEnd={() => {
              drag.current = null;
              setDrop(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = drag.current;
              drag.current = null;
              setDrop(null);
              if (
                !source ||
                unavailable ||
                source.scope !== JSON.stringify(scope) ||
                source.tabId === tab.id
              )
                return;
              void onChange({
                kind: "reorder",
                scope,
                revision: source.revision,
                tabId: source.tabId,
                targetTabId: tab.id,
              });
            }}
          >
            {rename?.tabId === tab.id ? (
              <form
                className="terminal-inline-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRename();
                }}
              >
                <input
                  aria-label="Имя терминала"
                  autoFocus
                  maxLength={120}
                  value={rename.name}
                  disabled={busy}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) =>
                    setRename({ ...rename, name: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRename(null);
                      queueMicrotask(() => focusTab(tab.id));
                    }
                  }}
                  onBlur={() => {
                    if (!saving.current) setRename(null);
                  }}
                />
              </form>
            ) : (
              <TooltipButton
                buttonClassName="terminal-tab-label"
                busy={busy}
                disabled={locked || !state}
                tooltipEnabled={!adding && !menu}
                tooltipLabel={tab.name}
                description={terminalArea(tab)}
                label={`${tab.name} — ${terminalArea(tab)}`}
                tabProps={{
                  role: "tab",
                  "aria-selected": selected === tab.id,
                  tabIndex: selected === tab.id ? 0 : -1,
                  onDoubleClick: () => beginRename(tab),
                  onContextMenu: (event) => {
                    event.preventDefault();
                    void openMenu(
                      "actions",
                      { tabId: tab.id, revision: state.revision },
                      event.currentTarget,
                    );
                  },
                  onKeyDown: (event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      beginRename(tab);
                      return;
                    }
                    if (
                      event.key === "ContextMenu" ||
                      (event.shiftKey && event.key === "F10")
                    ) {
                      event.preventDefault();
                      void openMenu(
                        "actions",
                        { tabId: tab.id, revision: state.revision },
                        event.currentTarget,
                      );
                      return;
                    }
                    if (
                      event.altKey ||
                      event.ctrlKey ||
                      event.metaKey ||
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const buttons = [
                      ...tabsRoot.current!.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]:not(:disabled)',
                      ),
                    ];
                    const i = buttons.indexOf(event.currentTarget);
                    buttons[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : (i +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              buttons.length) %
                            buttons.length
                    ]?.focus();
                  },
                }}
                onClick={() => {
                  closeMenus();
                  if (
                    tab.id !== selected &&
                    !locked &&
                    (!busy || !!selection.current) &&
                    selection.current !== tab.id
                  ) {
                    selection.current = tab.id;
                    void onChange({
                      kind: "select",
                      scope,
                      revision: state.revision,
                      tabId: tab.id,
                    }).finally(() => {
                      if (selection.current === tab.id)
                        selection.current = null;
                      if (alive.current) setSelectionDone((value) => value + 1);
                    });
                  }
                }}
              >
                <TerminalActionIcon
                  kind={
                    tab.scope.kind === "common"
                      ? "common"
                      : tab.scope.context.kind === "primary"
                        ? "folder"
                        : "topic"
                  }
                />
                <span>{tab.name}</span>
              </TooltipButton>
            )}
            <button
              type="button"
              aria-label={`Закрыть терминал ${tab.name}`}
              disabled={unavailable}
              onClick={() => {
                closeMenus();
                onClose(tab.id);
              }}
            >
              <TerminalActionIcon kind="close" />
            </button>
          </div>
        ))}
      </div>
      <div className="terminal-add-split">
        <TooltipButton
          buttonClassName="terminal-add-button"
          disabled={unavailable}
          busy={busy}
          label="Добавить терминал"
          tooltipLabel={
            state?.context.kind === "topic"
              ? "Новый терминал топика"
              : "Новый терминал проекта"
          }
          description="Создать вкладку текущего контекста"
          onClick={() => create("context")}
        >
          <TerminalActionIcon kind="plus" />
        </TooltipButton>
        <button
          ref={addAnchor}
          type="button"
          className="terminal-type-button"
          aria-label="Выбрать тип терминала"
          aria-haspopup="menu"
          aria-expanded={adding}
          disabled={unavailable}
          onClick={() => (adding ? closeMenus() : void openMenu("add"))}
        >
          <TerminalActionIcon kind="chevron" />
        </button>
      </div>
      <div className="terminal-tabtools">
        <TooltipButton
          buttonClassName="terminal-icon-button"
          label="Обновить сессию"
          tooltipLabel="Обновить сессию"
          description="Применить текущее окружение; работающие команды потребуют подтверждения"
          busy={busy}
          disabled={unavailable || refreshDisabled}
          onClick={() => {
            closeMenus();
            onRefresh();
          }}
        >
          <TerminalActionIcon kind="refresh" />
        </TooltipButton>
      </div>
      {active && adding && state && (
        <TopicPickerPopup
          anchor={addAnchor}
          width={286}
          label="Добавить терминал"
          onClose={() => setAdding(false)}
        >
          <div
            ref={menuRoot}
            role="menu"
            aria-label="Тип терминала"
            className="terminal-add-menu"
            onKeyDown={menuKeys}
          >
            <button
              type="button"
              role="menuitem"
              aria-label="Общий терминал"
              onClick={() => create("common")}
            >
              <TerminalActionIcon kind="common" />
              <span>
                Общий терминал
                <small>
                  Во всех топиках проекта.
                  <br />В каждом — своя сессия.
                </small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label={
                state.context.kind === "topic"
                  ? "Терминал топика"
                  : "Терминал проекта"
              }
              onClick={() => create("context")}
            >
              <TerminalActionIcon
                kind={state.context.kind === "topic" ? "topic" : "folder"}
              />
              <span>
                {state.context.kind === "topic"
                  ? "Терминал топика"
                  : "Терминал проекта"}
                <small>
                  {state.context.kind === "topic"
                    ? "Только для выбранного топика."
                    : "Только для основной папки проекта."}
                </small>
              </span>
            </button>
          </div>
        </TopicPickerPopup>
      )}
      {active && menu && actionTab && (
        <TopicPickerPopup
          anchor={actionAnchor}
          width={254}
          label="Действия с вкладкой"
          onClose={() => setMenu(null)}
        >
          <div
            ref={menuRoot}
            role="menu"
            aria-label="Действия с вкладкой"
            className="terminal-actions-menu"
            onKeyDown={menuKeys}
          >
            <button
              type="button"
              role="menuitem"
              aria-label="Переименовать терминал"
              onClick={() => beginRename(actionTab, menu.revision)}
            >
              <TerminalActionIcon kind="rename" />
              Переименовать
            </button>
            {(["left", "right"] as const).map((direction) => (
              <button
                type="button"
                key={direction}
                role="menuitem"
                aria-label={`Переместить терминал ${direction === "left" ? "влево" : "вправо"}`}
                disabled={
                  state!.tabs.indexOf(actionTab) ===
                  (direction === "left" ? 0 : state!.tabs.length - 1)
                }
                onClick={() => {
                  const captured = menu;
                  closeMenus();
                  void onChange({
                    kind: "move",
                    scope,
                    ...captured,
                    direction,
                  });
                }}
              >
                <TerminalActionIcon kind={direction} />
                Переместить {direction === "left" ? "влево" : "вправо"}
              </button>
            ))}
            <div className="terminal-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const id = menu.tabId;
                closeMenus();
                onClose(id);
              }}
            >
              <TerminalActionIcon kind="close" />
              Закрыть вкладку
            </button>
          </div>
        </TopicPickerPopup>
      )}
    </div>
  );
}
