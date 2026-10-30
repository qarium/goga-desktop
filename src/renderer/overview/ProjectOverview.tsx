import { createOverviewTransport } from "./transport";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  FilePlus2,
  FolderPlus,
  ChevronsDownUp,
  ChevronsUpDown,
  CopyX,
  Search,
  X,
  FolderOpen,
  Braces,
  Network,
  RefreshCw,
  Maximize2,
  Minimize2,
  ArrowUp,
  Save,
  FileCode2,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Eye,
  ArrowLeft,
} from "lucide-react";
import type { ScopeRef } from "../../shared/context";
import type { DesktopAPI } from "../../shared/bridge";
import type { OverviewEntry } from "../../shared/project-overview";
import { buildArchitectureIndex } from "../../shared/project-architecture";
import { createOverviewStore } from "./store";
import { HistoryMarkdown } from "../HistoryMarkdown";
import {
  HistoryScrollPane,
  type HistoryScrollPositions,
} from "../HistoryScrollPane";
import "../ProjectHistory.css";
import { OverviewEditor } from "./OverviewEditor";
import { FileTree, type FileTreeMenu } from "./FileTree";
import { OverviewFileActions } from "./OverviewFileActions";
import { SchemaGraph, IconButton } from "./SchemaGraph";
import { ContractPane } from "./ContractPane";
import { ownerForPath, projectScope, basename } from "./graph";
import { useViewActive } from "../RetainedViews";
import "./overview.css";
function Splitter({
  label,
  value,
  onChange,
  axis = "x",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  axis?: "x" | "y";
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={value}
      className={"ov-splitter ov-" + axis}
      onKeyDown={(e) => {
        const d =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 20
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -20
              : 0;
        if (d) {
          e.preventDefault();
          onChange(value + d);
        }
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const start = axis === "x" ? e.clientX : e.clientY,
          initial = value;
        const el = e.currentTarget;
        const move = (v: PointerEvent) =>
          onChange(initial + (axis === "x" ? v.clientX : v.clientY) - start);
        const end = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", end);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end, { once: true });
      }}
    />
  );
}
export function ProjectOverview({
  scope,
  workspacePath,
  api = window.goga,
  onMutation,
  onCloseState,
}: {
  scope: ScopeRef;
  workspacePath?: string;
  api?: DesktopAPI;
  onMutation?: () => void;
  onCloseState?: (paths: string[], busy: boolean) => void;
}) {
  const callback = useRef(onMutation);
  callback.current = onMutation;
  const [transport] = useState(() => createOverviewTransport(api));
  const [store] = useState(() =>
    createOverviewStore(transport.api, scope, () => callback.current?.()),
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const active = useViewActive();
  const [graphScope, setGraphScope] = useState(projectScope),
    [treeScope, setTreeScope] = useState(""),
    [selection, setSelection] = useState<string | null>(null),
    [selectedPaths, setSelectedPaths] = useState<string[]>([]),
    [fileMenu, setFileMenu] = useState<FileTreeMenu | null>(null),
    [fileActionBusy, setFileActionBusy] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [results, setResults] = useState<OverviewEntry[] | null>(null),
    [searchNotice, setSearchNotice] = useState("");
  const [treeWidth, setTreeWidth] = useState(270),
    [contractWidth, setContractWidth] = useState(400),
    [graphHeight, setGraphHeight] = useState(390),
    [graphCollapsed, setGraphCollapsed] = useState(false),
    [previews, setPreviews] = useState<Set<string>>(() => new Set()),
    [width, setWidth] = useState(1000),
    [full, setFull] = useState<"graph" | "file" | null>(null),
    [compactTab, setCompactTab] = useState<"graph" | "contract">("graph");
  const [history, setHistory] = useState<string[]>([]),
    [historyIndex, setHistoryIndex] = useState(-1);
  const [creation, setCreation] = useState<{
      kind: "file" | "directory";
      copy?: string;
      parent?: string;
    } | null>(null),
    [newName, setNewName] = useState(""),
    [modalError, setModalError] = useState(""),
    [closing, setClosing] = useState<string[] | null>(null),
    [reload, setReload] = useState<string | null>(null);
  const contractScroll = useRef<Record<string, number>>({});
  const previewScroll = useRef<HistoryScrollPositions>(new Map());
  const host = useRef<HTMLElement>(null);
  const index = useMemo(
    () => buildArchitectureIndex(state.schema ?? []),
    [state.schema],
  );
  const dirty = state.order.filter(
    (p) => state.files[p].text !== state.files[p].document.text,
  );
  const file = state.active ? state.files[state.active] : null;
  // A fullscreen document cannot outlive the last open file. All close paths
  // (clean, save, discard and close-all) must restore navigation automatically.
  useEffect(() => {
    if (full === "file" && !file) setFull(null);
  }, [full, file]);
  const isMarkdown =
    !!state.active && /\.(?:md|markdown|mdown|mkd|mkdn)$/i.test(state.active);
  const preview = isMarkdown && previews.has(state.active!);
  useEffect(() => {
    setPreviews((current) =>
      [...current].some((p) => !state.order.includes(p))
        ? new Set([...current].filter((p) => state.order.includes(p)))
        : current,
    );
    for (const p of previewScroll.current.keys())
      if (!state.order.includes(p)) previewScroll.current.delete(p);
  }, [state.order]);
  useEffect(() => {
    store.setScope(scope);
    if (active) {
      void store.loadDirectory("");
      void store.refreshAll();
    }
    return () => {
      store.suspendReads();
      transport.dispose();
    };
  }, [store, transport, active, JSON.stringify(scope)]);
  useEffect(
    () => () => {
      transport.dispose();
      store.dispose();
    },
    [store, transport],
  );
  useEffect(() => {
    if (!host.current) return;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0].contentRect.width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(next));
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    if (graphScope === projectScope && index.roots.length === 1)
      setGraphScope(index.roots[0]);
  }, [index]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFull(null);
        setCreation(null);
        setClosing(null);
        setReload(null);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  const busy = fileActionBusy || state.order.some((p) => state.files[p].busy);
  useEffect(() => {
    onCloseState?.(dirty, busy);
  }, [dirty.join("\0"), busy, onCloseState]);
  useEffect(() => () => onCloseState?.([], false), []);
  useEffect(() => {
    let current = true;
    if (!active) {
      transport.cancel("search");
      return;
    }
    if (!search.trim()) {
      setResults(null);
      setSearchNotice("");
      return;
    }
    const timer = setTimeout(() => {
      void transport.api.searchOverviewFiles(scope, treeScope, search).then(
        (r) => {
          if (current) {
            setResults(r.entries);
            setSearchNotice(
              r.truncated
                ? "Показана часть результатов. Уточните имя или область поиска."
                : "",
            );
          }
        },
        (e) => {
          if (current)
            setSearchNotice(e instanceof Error ? e.message : String(e));
        },
      );
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
      transport.cancel("search");
    };
  }, [api, JSON.stringify(scope), search, treeScope, state.refreshing, active]);
  const select = useCallback(
    (p: string) => {
      setSelection(p);
      const owner = ownerForPath(state.schema ?? [], p);
      if (owner) {
        const current = index.cells[graphScope];
        const visible = current?.children.map((c) => c.cell) ?? index.roots;
        if (!visible.includes(owner) && owner !== graphScope)
          setGraphScope(index.parents[owner] ?? owner);
      }
    },
    [state.schema, index, graphScope],
  );
  const drill = (p: string) => {
    if (p === projectScope) {
      setGraphScope(projectScope);
      setTreeScope("");
      void store.loadDirectory("");
      return;
    }
    if (!Object.hasOwn(index.cells, p)) return;
    setGraphScope(p);
    setTreeScope(p === "." ? "" : p);
    setSelection(p);
    setSearch("");
    void store.loadDirectory(p === "." ? "" : p);
  };
  const navigateFromTree = (p: string) => {
    const owner = ownerForPath(state.schema ?? [], p);
    setTreeScope(p);
    setGraphScope(Object.hasOwn(index.cells, p) ? p : (owner ?? projectScope));
    setSelection(p);
    setSelectedPaths([p]);
    setSearch("");
    setGraphCollapsed(false);
    setCompactTab("graph");
    void store.loadDirectory(p);
  };
  const closeFileMenu = useCallback(() => setFileMenu(null), []);
  const showContract = (p: string, record = true) => {
    if (!Object.hasOwn(index.cells, p)) return;
    if (record) {
      const next = [...history.slice(0, historyIndex + 1), p];
      setHistory(next);
      setHistoryIndex(next.length - 1);
    }
    setFull((current) => (current === "file" ? null : current));
    void store.showContract(p);
    setCompactTab("contract");
    drill(p);
  };
  const back = (delta: number) => {
    const n = historyIndex + delta;
    if (n < 0 || n >= history.length) return;
    setHistoryIndex(n);
    showContract(history[n], false);
  };
  const close = (paths: string[]) => {
    if (paths.some((p) => state.files[p]?.busy)) return;
    if (!store.close(paths)) setClosing(paths);
  };
  const refreshOne = async (p: string) => {
    if ((await store.refreshFile(p)) === "needs-confirmation") setReload(p);
  };
  const startCreate = (
    kind: "file" | "directory",
    copy?: string,
    parent = treeScope,
  ) => {
    setNewName(copy ? basename(copy) + ".copy" : "");
    setModalError("");
    setCreation({ kind, copy, parent });
  };
  const create = async () => {
    if (!creation) return;
    if (
      !newName ||
      newName.includes("/") ||
      newName.includes("\\") ||
      [".", ".."].includes(newName)
    ) {
      setModalError("Введите название без пути");
      return;
    }
    const base = creation.parent ? creation.parent + "/" : "";
    const p = base + newName;
    const ok = creation.copy
      ? await store.saveCopy(creation.copy, p)
      : await store.create(p, creation.kind, "");
    if (ok) setCreation(null);
    else
      setModalError(
        store.getSnapshot().creationError ||
          "Не удалось создать файл. Проверьте путь и отсутствие одноимённого файла.",
      );
  };
  const expandAll = async () => {
    const queue = [treeScope];
    const folders = new Set(expanded),
      visited = new Set<string>();
    let count = 0;
    while (queue.length && count < 200) {
      const p = queue.shift()!;
      if (visited.has(p)) continue;
      visited.add(p);
      await store.loadDirectory(p);
      for (const e of store.getSnapshot().directories[p]?.entries ?? [])
        if (e.kind === "directory" && !visited.has(e.path)) {
          folders.add(e.path);
          queue.push(e.path);
          count++;
        }
    }
    setExpanded([...folders]);
    if (queue.length)
      setSearchNotice(
        "Развёрнуты первые 200 папок. Остальные можно раскрыть вручную.",
      );
  };
  const compact = full !== "graph" && width - treeWidth < 790;
  const contract = state.contractCell ? index.cells[state.contractCell] : null;
  const showInspector = !!contract && full !== "file";
  const displayContract =
    showInspector && (!compact || compactTab === "contract");
  const mapHidden = full === "file" || (compact && displayContract);
  const treeHidden = full !== null;
  const cw = Math.max(
    340,
    Math.min(contractWidth, width - (treeHidden ? 0 : treeWidth) - 450),
  );
  const contractPane = contract && (
    <ContractPane
      inline={compact}
      positions={contractScroll.current}
      cell={contract}
      data={state.contract}
      busy={state.contractBusy}
      error={state.contractError}
      onRetry={() => void store.showContract(contract.cell)}
      onClose={() => {
        transport.cancel("contract");
        store.closeContract();
        setCompactTab("graph");
      }}
      onGo={showContract}
      onSource={(p) => {
        setFull(null);
        void store.open(p);
      }}
      onBack={() => back(-1)}
      onForward={() => back(1)}
      canBack={historyIndex > 0}
      canForward={historyIndex < history.length - 1}
      navigable={(p) => Object.hasOwn(index.cells, p)}
    />
  );
  return (
    <section
      ref={host}
      className={
        "project-overview " +
        (full ? "ov-full-" + full : "") +
        (displayContract && !compact ? " ov-docked" : "")
      }
      style={
        {
          "--ov-tree": treeWidth + "px",
          "--ov-contract": cw + "px",
        } as CSSProperties
      }
      aria-label="Обзор проекта"
    >
      {!treeHidden && (
        <>
          <aside
            className="ov-files"
            onContextMenu={(event) => {
              if (
                (event.target as HTMLElement).closest(
                  ".ov-tree-row,button,input",
                )
              )
                return;
              event.preventDefault();
              setFileMenu({
                paths: [],
                parent: treeScope,
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <header className="ov-heading">
              <strong>Файлы</strong>
              <div className="ov-tree-tools">
                <IconButton
                  label="Создать файл"
                  onClick={() => startCreate("file")}
                >
                  <FilePlus2 size={15} />
                </IconButton>
                <IconButton
                  label="Создать папку"
                  onClick={() => startCreate("directory")}
                >
                  <FolderPlus size={15} />
                </IconButton>
                <IconButton
                  label="Свернуть дерево файлов"
                  onClick={() => setExpanded([])}
                >
                  <ChevronsDownUp size={15} />
                </IconButton>
                <IconButton
                  label="Развернуть дерево файлов"
                  onClick={() => void expandAll()}
                >
                  <ChevronsUpDown size={15} />
                </IconButton>
                <IconButton
                  label="Закрыть все открытые файлы"
                  disabled={!state.order.length || busy}
                  onClick={() => close(state.order)}
                >
                  <CopyX size={15} />
                </IconButton>
              </div>
            </header>
            <div className="ov-search">
              <Search size={15} />
              <input
                aria-label="Поиск файлов"
                placeholder="Найти файл…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <IconButton
                  label="Очистить поиск"
                  onClick={() => setSearch("")}
                >
                  <X size={13} />
                </IconButton>
              )}
            </div>
            <div className="ov-file-scope">
              <button
                onClick={() => {
                  setTreeScope("");
                  setSearch("");
                  void store.loadDirectory("");
                }}
              >
                <FolderOpen size={15} />
                {treeScope ? basename(treeScope) : "Все файлы"}
                {treeScope && <X size={13} />}
              </button>
              {treeScope && Object.hasOwn(index.cells, treeScope) && (
                <IconButton
                  label={"Показать контракт папки " + treeScope}
                  onClick={() => showContract(treeScope)}
                >
                  <Braces size={15} />
                </IconButton>
              )}
              {treeScope && Object.hasOwn(index.cells, treeScope) && (
                <IconButton
                  label="Показать текущую папку на схеме"
                  onClick={() => navigateFromTree(treeScope)}
                >
                  <Network size={15} />
                </IconButton>
              )}
            </div>
            <div className="ov-directory-notices">
              {[...new Set([treeScope, ...expanded])]
                .filter((p) => {
                  if (p === treeScope) return true;
                  if (treeScope && !p.startsWith(treeScope + "/")) return false;
                  const parts = p.split("/");
                  return parts.slice(0, -1).every((_, i) => {
                    const ancestor = parts.slice(0, i + 1).join("/");
                    return (
                      ancestor === treeScope || expanded.includes(ancestor)
                    );
                  });
                })
                .map((p) =>
                  state.directoryErrors[p] ? (
                    <p key={p} className="ov-notice" role="alert">
                      <strong>{p || "Проект"}:</strong>{" "}
                      <span>{state.directoryErrors[p]}</span>
                      <button
                        aria-label={"Повторить загрузку " + (p || "проекта")}
                        onClick={() => void store.loadDirectory(p)}
                      >
                        Повторить
                      </button>
                    </p>
                  ) : state.directories[p]?.truncated ? (
                    <p key={p} className="ov-hint" role="status">
                      <strong>{p || "Проект"}:</strong>{" "}
                      <span>
                        Список ограничен. Уточните поиск или выберите папку.
                      </span>
                    </p>
                  ) : null,
                )}
            </div>
            {results ? (
              <div className="ov-search-results">
                {results.map((e) => (
                  <button
                    key={e.path}
                    onDoubleClick={() => {
                      if (e.kind === "directory") navigateFromTree(e.path);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedPaths([e.path]);
                      setFileMenu({
                        paths: [e.path],
                        entry: e,
                        parent: e.path.includes("/")
                          ? e.path.slice(0, e.path.lastIndexOf("/"))
                          : "",
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    onClick={() => {
                      if (e.kind === "directory") {
                        setTreeScope(e.path);
                        select(e.path);
                        void store.loadDirectory(e.path);
                      } else {
                        select(e.path);
                        void store.open(e.path);
                      }
                    }}
                  >
                    <FileCode2 size={15} />
                    <span>
                      {e.name}
                      <small>{e.path}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <FileTree
                scope={treeScope}
                directories={state.directories}
                expanded={expanded}
                setExpanded={setExpanded}
                selection={selection ?? state.active}
                selectedPaths={selectedPaths}
                onSelectedPaths={setSelectedPaths}
                onNavigate={navigateFromTree}
                onContextMenu={setFileMenu}
                onFile={(p) => {
                  setSelectedPaths([p]);
                  select(p);
                  void store.open(p);
                }}
                onFolder={(p) => {
                  setSelectedPaths([p]);
                  select(p);
                }}
                onContract={showContract}
                hasContract={(p) => Object.hasOwn(index.cells, p)}
                load={store.loadDirectory}
                dirty={dirty}
              />
            )}{" "}
            {searchNotice && (
              <p className="ov-notice" role="status">
                {searchNotice}
              </p>
            )}
            <footer className="ov-status">
              <Network size={13} />
              Выбор в дереве подсвечивает схему
            </footer>
          </aside>
          <Splitter
            label="Ширина дерева файлов"
            value={treeWidth}
            onChange={(v) => setTreeWidth(Math.max(220, Math.min(420, v)))}
          />
        </>
      )}
      <div className="ov-work">
        <section
          className={
            "ov-map " +
            (mapHidden ? "ov-hidden " : "") +
            (graphCollapsed ? "ov-collapsed" : "")
          }
          style={
            graphCollapsed
              ? { height: 44, minHeight: 44, maxHeight: 44, flex: "0 0 44px" }
              : file && full !== "graph"
                ? { height: Math.max(180, graphHeight), maxHeight: "58%" }
                : undefined
          }
        >
          <header className="ov-heading">
            <Network size={17} />
            <strong>Карта проекта</strong>
            {compact && showInspector && (
              <div className="ov-architecture-tabs">
                <button
                  aria-pressed={compactTab === "graph"}
                  onClick={() => setCompactTab("graph")}
                >
                  Схема
                </button>
                <button
                  aria-pressed={compactTab === "contract"}
                  onClick={() => setCompactTab("contract")}
                >
                  Контракт
                </button>
              </div>
            )}
            <div className="ov-map-actions">
              <IconButton
                label="Показать контракт текущей папки"
                disabled={!Object.hasOwn(index.cells, graphScope)}
                onClick={() => showContract(graphScope)}
              >
                <Braces size={16} />
              </IconButton>
              <IconButton
                label={full === "graph" ? "Вернуть схему" : "Развернуть схему"}
                onClick={() => {
                  setGraphCollapsed(false);
                  setFull(full === "graph" ? null : "graph");
                }}
              >
                {full === "graph" ? (
                  <Minimize2 size={16} />
                ) : (
                  <Maximize2 size={16} />
                )}
              </IconButton>
              <IconButton
                label={graphCollapsed ? "Показать схему" : "Свернуть схему"}
                onClick={() => {
                  setFull(null);
                  setGraphCollapsed((v) => !v);
                }}
              >
                {graphCollapsed ? (
                  <ChevronDown size={16} />
                ) : (
                  <ChevronUp size={16} />
                )}
              </IconButton>
              <IconButton
                label="Обновить обзор"
                disabled={state.refreshing}
                onClick={() => void store.refreshAll()}
              >
                <RefreshCw
                  size={16}
                  className={state.refreshing ? "ov-spin" : ""}
                />
              </IconButton>
            </div>
          </header>
          <div className="ov-map-body" hidden={graphCollapsed}>
            <nav className="ov-breadcrumb">
              <IconButton
                label="На уровень выше"
                disabled={graphScope === projectScope}
                onClick={() => drill(index.parents[graphScope] ?? projectScope)}
              >
                <ArrowUp size={15} />
              </IconButton>
              <button
                aria-label="Корень проекта"
                onClick={() => {
                  setGraphScope(projectScope);
                  setTreeScope("");
                  void store.loadDirectory("");
                }}
              >
                Проект
              </button>
              {(() => {
                const chain: string[] = [];
                let current: string | null = graphScope;
                while (current && current !== projectScope) {
                  chain.unshift(current);
                  current = index.parents[current] ?? null;
                }
                return chain.map((p) => (
                  <span className="ov-breadcrumb-part" key={p}>
                    <ChevronRight size={12} />
                    <button onClick={() => drill(p)}>{basename(p)}</button>
                  </span>
                ));
              })()}
            </nav>
            {state.schemaError && (
              <p className="ov-notice" role="alert">
                {state.schemaError}
                <button onClick={() => void store.refreshAll()}>
                  Повторить
                </button>
              </p>
            )}
            {state.stale && (
              <p className="ov-hint ov-stale" role="status">
                Схема и контракты могли измениться. Обновите обзор.
              </p>
            )}
            {state.schema?.length ? (
              <SchemaGraph
                schema={state.schema}
                scope={graphScope}
                selection={selection}
                onDrill={drill}
                onContract={showContract}
              />
            ) : (
              <div className="ov-empty">
                <Network size={28} />
                <h3>
                  {state.refreshing ? "Загружаем схему…" : "Схема отсутствует"}
                </h3>
                <p>
                  Файлы доступны в дереве. После добавления контракта обновите
                  обзор.
                </p>
              </div>
            )}
          </div>
        </section>
        {graphCollapsed && !file && !displayContract && (
          <div className="ov-empty">
            <p>Схема свёрнута. Откройте файл в дереве или покажите схему.</p>
          </div>
        )}
        {compact && displayContract && (
          <div className="ov-inline-contract">
            <div className="ov-inline-tabs">
              <button onClick={() => setCompactTab("graph")}>Схема</button>
              <strong>Контракт</strong>
              <IconButton
                label="Закрыть контракт"
                onClick={() => {
                  transport.cancel("contract");
                  store.closeContract();
                  setCompactTab("graph");
                }}
              >
                <X size={16} />
              </IconButton>
              <IconButton
                label="Обновить обзор"
                disabled={state.refreshing}
                onClick={() => void store.refreshAll()}
              >
                <RefreshCw size={16} />
              </IconButton>
            </div>
            {contractPane}
          </div>
        )}
        {file && full !== "graph" && (
          <>
            {full !== "file" &&
              (!graphCollapsed || (compact && displayContract)) && (
                <Splitter
                  axis="y"
                  label="Высота графа"
                  value={graphHeight}
                  onChange={(v) =>
                    setGraphHeight(Math.max(180, Math.min(800, v)))
                  }
                />
              )}
            <section className="ov-document">
              <header className="ov-tabs">
                <div role="tablist" aria-label="Открытые файлы">
                  {state.order.map((p) => (
                    <div
                      key={p}
                      className={
                        p === state.active ? "ov-tab ov-tab-active" : "ov-tab"
                      }
                    >
                      <button
                        role="tab"
                        aria-selected={p === state.active}
                        onClick={() => {
                          store.activate(p);
                          select(p);
                        }}
                        title={p}
                      >
                        <FileCode2 size={14} />
                        {basename(p)}
                        {dirty.includes(p) && <i className="ov-dirty" />}
                      </button>
                      <IconButton
                        label={"Закрыть " + p}
                        disabled={state.files[p].busy}
                        onClick={() => close([p])}
                      >
                        <X size={13} />
                      </IconButton>
                    </div>
                  ))}
                </div>
                {isMarkdown && (
                  <IconButton
                    label={
                      preview
                        ? "Показать исходник Markdown"
                        : "Предпросмотр Markdown"
                    }
                    onClick={() =>
                      setPreviews((current) => {
                        const next = new Set(current);
                        if (next.has(state.active!)) next.delete(state.active!);
                        else next.add(state.active!);
                        return next;
                      })
                    }
                  >
                    {preview ? <FileCode2 size={16} /> : <Eye size={16} />}
                  </IconButton>
                )}
                <IconButton
                  label={
                    full === "file" ? "Вернуть документ" : "Развернуть документ"
                  }
                  onClick={() => setFull(full === "file" ? null : "file")}
                >
                  {full === "file" ? (
                    <Minimize2 size={16} />
                  ) : (
                    <Maximize2 size={16} />
                  )}
                </IconButton>
              </header>
              <div className="ov-file-toolbar">
                <button
                  className="ov-file-path"
                  title="Показать файл в дереве"
                  onClick={() => {
                    const p = state.active!;
                    const parent = p.includes("/")
                      ? p.slice(0, p.lastIndexOf("/"))
                      : "";
                    setTreeScope(parent);
                    void store.loadDirectory(parent);
                    select(p);
                  }}
                >
                  <FileCode2 size={15} />
                  {state.active}
                </button>
                <div>
                  <IconButton
                    label="Обновить файл с диска"
                    disabled={file.busy}
                    onClick={() => void refreshOne(state.active!)}
                  >
                    <RefreshCw size={15} />
                  </IconButton>
                  <button
                    className="ov-close-without-save"
                    disabled={file.busy}
                    onClick={() => close([state.active!])}
                  >
                    Закрыть без сохранения
                  </button>
                  <button
                    disabled={
                      file.busy ||
                      !file.document.exists ||
                      !dirty.includes(state.active!)
                    }
                    onClick={() => void store.save(state.active!)}
                  >
                    <Save size={14} />
                    Сохранить
                  </button>
                </div>
              </div>
              {file.error && (
                <div className="ov-notice" role="alert">
                  {file.error}
                </div>
              )}
              {(file.changedExternally ||
                (file.error && dirty.includes(state.active!))) && (
                <div className="ov-notice">
                  Файл изменён на диске. Черновик сохранён.
                  <button onClick={() => startCreate("file", state.active!)}>
                    Сохранить копию…
                  </button>
                </div>
              )}
              {preview ? (
                <HistoryScrollPane
                  key={state.active}
                  className="ov-markdown-preview"
                  positionKey={state.active!}
                  positions={previewScroll.current}
                  active={active}
                  label="Предпросмотр Markdown"
                >
                  <HistoryMarkdown
                    text={file.text}
                    path={state.active!}
                    onFile={(p) => {
                      select(p);
                      void store.open(p);
                    }}
                  />
                </HistoryScrollPane>
              ) : (
                <OverviewEditor
                  key={state.active}
                  path={state.active!}
                  value={file.text}
                  onChange={(text) => store.edit(state.active!, text)}
                  onSave={() => void store.save(state.active!)}
                  readOnly={file.busy}
                  memory={file.memory}
                />
              )}
              <footer className="ov-status">
                {dirty.includes(state.active!) ? "Не сохранено" : "Сохранено"} ·{" "}
                {state.active?.split(".").at(-1)}
                <span>Сохранение не создаёт коммит</span>
              </footer>
            </section>
          </>
        )}
      </div>
      {displayContract && !compact && (
        <>
          <Splitter
            label="Ширина панели контракта"
            value={contractWidth}
            onChange={(v) =>
              setContractWidth(
                Math.max(340, Math.min(560, 2 * contractWidth - v)),
              )
            }
          />
          {contractPane}
        </>
      )}
      <OverviewFileActions
        api={api}
        scope={scope}
        workspacePath={workspacePath}
        store={store}
        menu={fileMenu}
        onCloseMenu={closeFileMenu}
        onCreate={(kind, parent) => startCreate(kind, undefined, parent)}
        onNavigate={navigateFromTree}
        onBusy={setFileActionBusy}
        onApplied={(kind, paths, destination) => {
          const affected = (p: string) =>
            paths.some((root) => p === root || p.startsWith(root + "/"));
          const next = (p: string) =>
            affected(p)
              ? kind === "rename" && destination
                ? destination + p.slice(paths[0].length)
                : paths
                    .find((root) => p === root || p.startsWith(root + "/"))!
                    .split("/")
                    .slice(0, -1)
                    .join("/")
              : p;
          const tree = next(treeScope);
          setTreeScope(tree);
          setSelection(selection ? next(selection) : null);
          setSelectedPaths((v) =>
            kind === "trash" ? v.filter((p) => !affected(p)) : v.map(next),
          );
          setExpanded((v) =>
            kind === "trash" ? v.filter((p) => !affected(p)) : v.map(next),
          );
          if (affected(graphScope)) setGraphScope(projectScope);
          void store.loadDirectory(tree);
        }}
      />
      {creation && (
        <div className="ov-modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={
              creation.copy
                ? "Сохранить копию"
                : creation.kind === "file"
                  ? "Создать файл"
                  : "Создать папку"
            }
            className="ov-modal"
          >
            <header>
              <h2>
                {creation.copy
                  ? "Сохранить копию"
                  : creation.kind === "file"
                    ? "Создать файл"
                    : "Создать папку"}
              </h2>
              <IconButton
                label="Закрыть окно"
                onClick={() => setCreation(null)}
              >
                <X size={17} />
              </IconButton>
            </header>
            <p className="ov-hint">
              В папке: {creation.parent || "Корень проекта"}
            </p>
            <label>
              Название
              <input
                aria-label="Название"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
            </label>
            {modalError && (
              <p className="ov-notice" role="alert">
                {modalError}
              </p>
            )}
            <footer>
              <button onClick={() => setCreation(null)}>Отмена</button>
              <button className="primary" onClick={() => void create()}>
                {creation.copy ? "Сохранить копию" : "Создать"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {(closing || reload) && (
        <div className="ov-modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Несохранённые изменения"
            className="ov-modal"
          >
            <header>
              <h2>{reload ? "Обновить файл с диска?" : "Закрыть файлы?"}</h2>
              <IconButton
                label="Отменить закрытие"
                onClick={() => {
                  setClosing(null);
                  setReload(null);
                }}
              >
                <X size={17} />
              </IconButton>
            </header>
            <p>
              Несохранённые изменения этих файлов будут потеряны. Остальные
              файлы не затрагиваются.
            </p>
            <ul>
              {(closing ?? [reload!])
                .filter((p) => dirty.includes(p))
                .map((p) => (
                  <li key={p}>{p}</li>
                ))}
            </ul>
            <footer>
              <button
                onClick={() => {
                  setClosing(null);
                  setReload(null);
                }}
              >
                Отмена
              </button>
              {closing && (
                <button
                  onClick={() =>
                    void (async () => {
                      for (const p of closing)
                        if (dirty.includes(p) && !(await store.save(p))) return;
                      store.close(closing);
                      setClosing(null);
                    })()
                  }
                >
                  Сохранить и закрыть
                </button>
              )}
              <button
                className="danger"
                onClick={() => {
                  if (reload) void store.refreshFile(reload, true);
                  else store.close(closing!, true);
                  setClosing(null);
                  setReload(null);
                }}
              >
                {reload ? "Загрузить с диска" : "Закрыть без сохранения"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
