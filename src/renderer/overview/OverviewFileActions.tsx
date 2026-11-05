import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { DesktopAPI } from "../../shared/bridge";
import type { ScopeRef } from "../../shared/context";
import { PasteConflictDialog } from "./PasteConflictDialog";
import type {
  OverviewPastePreview,
  OverviewPasteDecision,
  OverviewFileActionPreview,
} from "../../shared/project-overview";
import type { OverviewStore } from "./store";
import type { FileTreeMenu } from "./FileTree";
import { useViewActive } from "../RetainedViews";
import { preparationErrorMessage } from "../preparation-error";
import { readWithSignal } from "../read-request";
const parent = (p: string) =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const inside = (p: string, root: string) =>
  p === root || p.startsWith(root + "/");
export interface OverviewPasteActivity {
  owner: string;
  destination: string;
  phase: "preparing" | "copying" | "refreshing";
}
interface PasteActivityOperation {
  owner: string;
  destination: string;
  generation: number;
}
export function OverviewFileActions({
  api,
  scope,
  store,
  menu,
  onCloseMenu,
  onCreate,
  onNavigate,
  onBusy,
  onPasteActivity,
  onApplied,
  filePaneRef,
  filePaneVisible = true,
  treeScope = "",
  selectedPaths = [],
}: {
  filePaneRef?: RefObject<HTMLElement | null>;
  filePaneVisible?: boolean;
  treeScope?: string;
  selectedPaths?: string[];
  api: DesktopAPI;
  scope: ScopeRef;
  workspacePath?: string;
  store: OverviewStore;
  menu: FileTreeMenu | null;
  onCloseMenu: () => void;
  onCreate: (kind: "file" | "directory", parent: string) => void;
  onNavigate: (p: string) => void;
  onBusy: (busy: boolean) => void;
  onPasteActivity?: (activity: OverviewPasteActivity | null) => void;
  onApplied?: (
    kind: "rename" | "trash",
    paths: string[],
    destination?: string,
  ) => void;
}) {
  const active = useViewActive(),
    key = JSON.stringify(scope);
  const activityCallback = useRef(onPasteActivity),
    activityOperation = useRef<PasteActivityOperation | null>(null),
    currentView = useRef({ key, active });
  activityCallback.current = onPasteActivity;
  currentView.current = { key, active };
  const clearPasteActivity = (operation?: PasteActivityOperation) => {
    if (
      activityOperation.current &&
      (!operation || activityOperation.current === operation)
    ) {
      activityOperation.current = null;
      activityCallback.current?.(null);
    }
  };
  const reportPasteActivity = (
    operation: PasteActivityOperation,
    phase: OverviewPasteActivity["phase"],
  ) => {
    if (
      operation.generation !== generation.current ||
      operation.owner !== currentView.current.key ||
      !currentView.current.active
    )
      return;
    activityOperation.current = operation;
    activityCallback.current?.({
      owner: operation.owner,
      destination: operation.destination,
      phase,
    });
  };
  const previewRead = useRef(new AbortController());
  const generation = useRef(0),
    menuRef = useRef<HTMLDivElement>(null),
    dialogRef = useRef<HTMLElement>(null),
    running = useRef(false);
  const [preview, setPreview] = useState<OverviewFileActionPreview | null>(
      null,
    ),
    [rename, setRename] = useState<string | null>(null),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [pastePreview, setPastePreview] = useState<{
    preview: OverviewPastePreview;
    owner: ScopeRef;
    store: OverviewStore;
    generation: number;
    activity: PasteActivityOperation;
  } | null>(null);
  const [point, setPoint] = useState({ x: 0, y: 0 });
  useEffect(() => {
    generation.current++;
    clearPasteActivity();
    previewRead.current.abort();
    previewRead.current = new AbortController();
    setPreview(null);
    setRename(null);
    setPastePreview(null);
    setError("");
    onCloseMenu();
  }, [key, active]);
  useEffect(
    () => () => {
      generation.current++;
      clearPasteActivity();
      previewRead.current.abort();
    },
    [],
  );
  const prepare = (
    request: Parameters<DesktopAPI["prepareOverviewFileAction"]>[1],
  ) =>
    api === window.goga
      ? readWithSignal(
          previewRead.current.signal,
          "prepareOverviewFileAction",
          scope,
          request,
        )
      : api.prepareOverviewFileAction(scope, request);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useLayoutEffect(() => {
    if (!menu) return;
    const box = menuRef.current?.getBoundingClientRect();
    setPoint({
      x: Math.max(
        8,
        Math.min(menu.x, window.innerWidth - (box?.width || 245) - 8),
      ),
      y: Math.max(
        8,
        Math.min(menu.y, window.innerHeight - (box?.height || 300) - 8),
      ),
    });
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onCloseMenu();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, onCloseMenu]);
  useEffect(() => {
    if (preview || rename)
      dialogRef.current?.querySelector<HTMLElement>("input,button")?.focus();
  }, [preview, rename]);
  const guarded = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const id = generation.current;
    try {
      await action();
    } catch (e) {
      if (id === generation.current) setError(preparationErrorMessage(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const ready = (paths: string[]) => {
    const s = store.getSnapshot();
    if (
      s.order.some(
        (p) => paths.some((root) => inside(p, root)) && s.files[p].busy,
      )
    )
      throw Error(
        "Дождитесь завершения сохранения или обновления выбранных файлов.",
      );
  };
  const execute = async (ticket: OverviewFileActionPreview) => {
    ready(ticket.paths);
    const result = await api.executeOverviewFileAction(ticket.token);
    setPreview(null);
    setRename(null);
    if (result.completedPaths.length) {
      await store.applyFileAction(
        ticket.kind,
        result.completedPaths,
        ticket.destination,
      );
      onApplied?.(ticket.kind, result.completedPaths, ticket.destination);
    }
    setPreview(null);
    setRename(null);
    if (result.status !== "done")
      throw Error(
        result.message ||
          "Операция выполнена не полностью. Обновите дерево и проверьте выбранные пути.",
      );
  };
  const trash = () => {
    const paths = [...(menu?.paths ?? [])];
    onCloseMenu();
    const id = generation.current;
    void guarded(async () => {
      ready(paths);
      const ticket = await prepare({
        kind: "trash",
        paths,
      });
      if (id === generation.current) setPreview(ticket);
    });
  };
  const submitRename = () => {
    if (!rename) return;
    const source = rename,
      id = generation.current;
    if (
      !name.trim() ||
      /[\\/\x00-\x1f]/.test(name) ||
      name === "." ||
      name === ".."
    ) {
      setError("Введите имя без пути.");
      return;
    }
    const destination = (parent(source) ? parent(source) + "/" : "") + name;
    void guarded(async () => {
      ready([source]);
      if (store.getSnapshot().order.some((p) => inside(p, destination)))
        throw Error(
          "Это имя уже открыто во вкладке. Сначала сохраните копию или закройте её: черновик не будет перезаписан.",
        );
      const ticket = await prepare({
        kind: "rename",
        path: source,
        destination,
      });
      if (id === generation.current) await execute(ticket);
    });
  };
  const pasteTarget = (
    paths: string[],
    fallback: string,
    entry?: FileTreeMenu["entry"],
  ) => {
    if (paths.length !== 1) return fallback;
    const selected =
      entry ??
      Object.values(store.getSnapshot().directories)
        .flatMap((d) => d.entries)
        .find((e) => e.path === paths[0]);
    return selected?.kind === "directory" || paths[0] === fallback
      ? paths[0]
      : parent(paths[0]);
  };
  const copyEntries = (paths: string[]) => {
    if (!paths.length) return;
    const owner = structuredClone(scope),
      captured = [...paths];
    void guarded(async () => {
      await api.copyOverviewEntries(owner, captured);
    });
  };
  const blockedPasteTarget = (path: string) => {
    const state = store.getSnapshot();
    return state.order.some(
      (p) =>
        inside(p, path) &&
        (state.files[p].busy ||
          state.files[p].text !== state.files[p].document.text),
    );
  };
  const executePaste = async (
    pending: NonNullable<typeof pastePreview>,
    decisions: OverviewPasteDecision[],
  ) => {
    // A confirmation belongs to its prepared owner, never the currently selected tab.
    if (pending.generation !== generation.current) return;
    const replacements = decisions
      .filter((d) => d.action === "replace")
      .map((d) => d.path);
    if (replacements.some(blockedPasteTarget))
      throw Error(
        "Файл содержит несохранённые изменения или сохраняется. Черновик не перезаписан. Сохраните его или повторите вставку, пропустив файл.",
      );
    reportPasteActivity(pending.activity, "copying");
    try {
      let result;
      try {
        result = await api.executeOverviewPaste(
          pending.preview.token,
          decisions,
        );
      } catch (error) {
        reportPasteActivity(pending.activity, "refreshing");
        await pending.store.applyPaste([], pending.owner);
        throw error;
      }
      reportPasteActivity(pending.activity, "refreshing");
      await pending.store.applyPaste(result.touchedPaths, pending.owner);
      if (result.status !== "done") throw Error(result.message);
    } finally {
      clearPasteActivity(pending.activity);
    }
  };
  const pasteEntries = (destination: string) => {
    const owner = structuredClone(scope),
      targetStore = store,
      id = generation.current;
    const activity = {
      owner: JSON.stringify(owner),
      destination,
      generation: id,
    };
    void guarded(async () => {
      reportPasteActivity(activity, "preparing");
      try {
        const preview = await api.prepareOverviewPaste(owner, destination);
        if (id !== generation.current) return;
        const pending = {
          preview,
          owner,
          store: targetStore,
          generation: id,
          activity,
        };
        if (preview.conflicts.length) setPastePreview(pending);
        else await executePaste(pending, []);
      } finally {
        clearPasteActivity(activity);
      }
    });
  };
  useEffect(() => {
    const pane = filePaneRef?.current;
    if (!pane || !active || !filePaneVisible) return;
    const eligible = (event: Event) => {
      const target = event.target;
      return (
        !preview &&
        !rename &&
        !pastePreview &&
        !running.current &&
        pane.isConnected &&
        target instanceof HTMLElement &&
        pane.contains(target) &&
        !target.closest(
          'input,textarea,[contenteditable="true"],[role="dialog"]',
        ) &&
        !!document.activeElement &&
        pane.contains(document.activeElement) &&
        !pane.closest("[hidden],[inert]")
      );
    };
    const copy = (event: Event) => {
      if (!eligible(event) || !selectedPaths.length) return;
      event.preventDefault();
      event.stopPropagation();
      copyEntries(selectedPaths);
    };
    const paste = (event: Event) => {
      if (!eligible(event)) return;
      event.preventDefault();
      event.stopPropagation();
      pasteEntries(pasteTarget(selectedPaths, treeScope));
    };
    const key = (event: KeyboardEvent) => {
      if (event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey))
        return;
      if (event.key.toLowerCase() === "c") copy(event);
      if (event.key.toLowerCase() === "v") paste(event);
    };
    pane.addEventListener("keydown", key, true);
    pane.addEventListener("copy", copy, true);
    pane.addEventListener("paste", paste, true);
    return () => {
      pane.removeEventListener("keydown", key, true);
      pane.removeEventListener("copy", copy, true);
      pane.removeEventListener("paste", paste, true);
    };
  }, [
    active,
    key,
    filePaneRef,
    filePaneVisible,
    treeScope,
    selectedPaths.join("\0"),
    store,
    api,
    preview,
    rename,
    pastePreview,
  ]);
  const selected = menu?.paths ?? [],
    one = selected.length === 1,
    entry = menu?.entry;
  const dirty = preview
    ? store
        .getSnapshot()
        .order.filter(
          (p) =>
            preview.paths.some((root) => inside(p, root)) &&
            store.getSnapshot().files[p].text !==
              store.getSnapshot().files[p].document.text,
        )
    : [];
  const run = (fn: () => void) => {
    onCloseMenu();
    setError("");
    fn();
  };
  const items = menu
    ? [
        ...(selected.length && entry?.kind !== "unsupported"
          ? [{ label: "Копировать", action: () => copyEntries(selected) }]
          : []),
        {
          label: "Вставить",
          action: () =>
            pasteEntries(
              pasteTarget(
                selected,
                selected.length === 1 ? menu.parent : treeScope,
                entry,
              ),
            ),
        },
        ...(selected.length <= 1
          ? [
              {
                label: "Создать файл",
                action: () =>
                  onCreate(
                    "file",
                    entry?.kind === "directory" ? entry.path : menu.parent,
                  ),
              },
              {
                label: "Создать папку",
                action: () =>
                  onCreate(
                    "directory",
                    entry?.kind === "directory" ? entry.path : menu.parent,
                  ),
              },
            ]
          : []),
        ...(one && entry?.kind === "directory"
          ? [
              {
                label: "Показать на схеме",
                action: () => onNavigate(entry.path),
              },
            ]
          : []),
        {
          label: "Обновить",
          action: () =>
            void guarded(async () => {
              await store.refreshAll();
            }),
        },
        ...(one && entry?.kind !== "unsupported"
          ? [
              {
                label: "Переименовать",
                action: () => {
                  setRename(selected[0]);
                  setName(selected[0].split("/").at(-1)!);
                },
              },
            ]
          : []),
        ...(selected.length
          ? [
              {
                label:
                  selected.length > 1
                    ? "Скопировать полные пути"
                    : "Скопировать полный путь",
                action: () =>
                  void guarded(async () => {
                    await api.copyOverviewPaths(
                      structuredClone(scope),
                      [...selected],
                      true,
                    );
                  }),
              },
              {
                label:
                  selected.length > 1
                    ? "Скопировать относительные пути"
                    : "Скопировать относительный путь",
                action: () =>
                  void guarded(async () => {
                    await api.copyOverviewPaths(
                      structuredClone(scope),
                      [...selected],
                      false,
                    );
                  }),
              },
            ]
          : []),
        ...(one
          ? [
              {
                label: "Показать в Finder",
                action: () =>
                  void guarded(async () => {
                    await api.revealOverviewEntry(scope, selected[0]);
                  }),
              },
            ]
          : []),
      ]
    : [];
  return (
    <>
      {pastePreview && active && (
        <PasteConflictDialog
          key={pastePreview.preview.token}
          conflicts={pastePreview.preview.conflicts}
          blocked={blockedPasteTarget}
          onCancel={() => setPastePreview(null)}
          onConfirm={(decisions) => {
            const pending = pastePreview;
            setPastePreview(null);
            void guarded(() => executePaste(pending, decisions));
          }}
        />
      )}
      {menu &&
        active &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Действия с файлами"
            className="ov-file-menu"
            style={{ left: point.x, top: point.y }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                onCloseMenu();
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const all = [
                    ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ),
                  ],
                  i = all.indexOf(document.activeElement as HTMLButtonElement);
                all[
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? all.length - 1
                      : (i + (e.key === "ArrowDown" ? 1 : -1) + all.length) %
                        all.length
                ]?.focus();
              }
            }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                disabled={busy}
                onClick={() => run(item.action)}
              >
                {item.label}
              </button>
            ))}
            {!!selected.length && entry?.kind !== "unsupported" && (
              <button
                role="menuitem"
                className="ov-danger-text"
                disabled={busy}
                onClick={trash}
              >
                Переместить в Корзину
                {selected.length > 1 ? ` (${selected.length})` : ""}
              </button>
            )}
          </div>,
          document.body,
        )}
      {error && !preview && !rename && (
        <p className="ov-file-action-error ov-notice" role="alert">
          {error}
          <button onClick={() => setError("")}>Закрыть</button>
        </p>
      )}
      {(preview || rename) &&
        active &&
        createPortal(
          <div className="ov-modal-backdrop">
            <section
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={preview ? "Переместить в Корзину?" : "Переименовать"}
              className="ov-modal"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  if (!busy) {
                    setPreview(null);
                    setRename(null);
                    setError("");
                  }
                }
                if (e.key === "Tab") {
                  const all = [
                    ...e.currentTarget.querySelectorAll<HTMLElement>(
                      "button:not(:disabled),input:not(:disabled)",
                    ),
                  ];
                  if (all.length) {
                    const i = all.indexOf(
                      document.activeElement as HTMLElement,
                    );
                    if (e.shiftKey && i === 0) {
                      e.preventDefault();
                      all.at(-1)?.focus();
                    } else if (!e.shiftKey && i === all.length - 1) {
                      e.preventDefault();
                      all[0].focus();
                    }
                  }
                }
              }}
            >
              <header>
                <h2>{preview ? "Переместить в Корзину?" : "Переименовать"}</h2>
              </header>
              {preview ? (
                <>
                  <p>
                    Выбранные файлы и папки будут перемещены в системную
                    Корзину. Вложенное содержимое папок также перемещается.
                  </p>
                  <ul className="ov-action-paths">
                    {preview.paths.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  {dirty.length > 0 && (
                    <p className="ov-hint">
                      Несохранённый текст останется в открытых вкладках — его
                      можно сохранить в копию.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="ov-hint">{rename}</p>
                  <label>
                    Новое имя
                    <input
                      aria-label="Новое имя"
                      value={name}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRename();
                      }}
                    />
                  </label>
                  <p className="ov-hint">
                    Открытые черновики сохранятся. Существующий файл или папка
                    не заменяются.
                  </p>
                </>
              )}
              {error && (
                <p className="ov-notice" role="alert">
                  {error}
                </p>
              )}
              <footer>
                <button
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setRename(null);
                    setError("");
                  }}
                >
                  Отмена
                </button>
                <button
                  className={preview ? "danger" : "primary"}
                  disabled={busy}
                  onClick={() =>
                    preview
                      ? void guarded(() => execute(preview))
                      : submitRename()
                  }
                >
                  {busy
                    ? "Выполняем…"
                    : preview
                      ? "Переместить в Корзину"
                      : "Переименовать"}
                </button>
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
