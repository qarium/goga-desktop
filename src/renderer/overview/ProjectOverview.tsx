import { t as msg } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import type { HomeSessions } from "../home/session-summary";
import { selectOverviewRows } from "./selection";
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
  Replace,
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
  CornerDownRight,
} from "lucide-react";
import type { ScopeRef } from "../../shared/context";
import type { DesktopAPI } from "../../shared/bridge";
import type { OverviewEntry } from "../../shared/project-overview";
import { buildArchitectureIndex } from "../../shared/project-architecture";
import { createOverviewStore, type OverviewStore } from "./store";
import { HistoryMarkdown } from "../HistoryMarkdown";
import {
  HistoryScrollPane,
  type HistoryScrollPositions,
} from "../HistoryScrollPane";
import "../ProjectHistory.css";
import { OverviewEditor, type OverviewEditorCommands, type OverviewEditorProps } from "./OverviewEditor";
import type { YamlEditorMemory } from "../YamlEditor";
import type { NavigationPresentation } from "./navigation/types";
import { resolveNavigationLanguage } from "./languages";
import { FileTree, type FileTreeMenu } from "./FileTree";
import {
  OverviewFileActions,
  type OverviewPasteActivity,
} from "./OverviewFileActions";
import { SchemaGraph } from "./SchemaGraph";
import { IconButton } from "./OverviewIconButton";
import { ContractPane } from "./ContractPane";
import { ownerForPath, projectScope, basename } from "./graph";
import { useViewActive } from "../RetainedViews";
import "./overview.css";
// Subscribe here, not on the canvas: buffer writes remain synchronous, but
// typing into an already-dirty file does not reconcile its tree or graph.
function useFileText(store: OverviewStore, path: string) {
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().files[path]?.text ?? "");
}
function LiveEditor({
  store, ...props
}: Omit<OverviewEditorProps, "value" | "onChange" | "onSave"> & { store: OverviewStore }) {
  useLocale();
  const text = useFileText(store, props.path);
  return (
    <OverviewEditor
      {...props}
      value={text}
      onChange={(value) => store.edit(props.path, value)}
      onSave={() => void store.save(props.path)}
    />
  );
}

function LiveMarkdown({ store, path, onFile }: {
  store: OverviewStore;
  path: string;
  onFile: (path: string) => void;
}) {
  useLocale();
  const text = useFileText(store, path);
  return <HistoryMarkdown path={path} text={text} onFile={onFile} />;
}

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
  useLocale();
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
  sessions, retainedViewKey,
}: {
  sessions?: HomeSessions;
  retainedViewKey?: string;
  scope: ScopeRef;
  workspacePath?: string;
  api?: DesktopAPI;
  onMutation?: () => void;
  onCloseState?: (paths: string[], busy: boolean) => void;
}) {
  useLocale();
  const callback = useRef(onMutation);
  callback.current = onMutation;
  const [transport] = useState(() => createOverviewTransport(api));
  const [store] = useState(() =>
    createOverviewStore(transport.api, scope, () => callback.current?.()),
  );
  const state = useSyncExternalStore(store.subscribe, store.getPresentation);
  const active = useViewActive();
  const filePaneRef = useRef<HTMLElement>(null);
  const searchAnchor = useRef<string | null>(null);
  useEffect(() => {
    searchAnchor.current = null;
  }, [JSON.stringify(scope)]);
  const editorCommands = useRef<OverviewEditorCommands>(null);
  const [graphScope, setGraphScope] = useState(projectScope),
    [treeScope, setTreeScope] = useState(""),
    [selection, setSelection] = useState<string | null>(null),
    [selectedPaths, setSelectedPaths] = useState<string[]>([]),
    [fileMenu, setFileMenu] = useState<FileTreeMenu | null>(null),
    [fileActionBusy, setFileActionBusy] = useState(false),
    [pasteActivity, setPasteActivity] = useState<OverviewPasteActivity | null>(
      null,
    ),
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
  useEffect(() => {
    if (!sessions || !retainedViewKey) return;
    return sessions.attachOverview(store, retainedViewKey, path => {
      store.activate(path);
      setFull(current => current === "graph" ? null : current);
      setPreviews(current => {
        if (!current.has(path)) return current;
        const next = new Set(current); next.delete(path); return next;
      });
      setSelection(path);
      setSelectedPaths([path]);
    });
  }, [sessions, retainedViewKey, store]);
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
  const dirty = useMemo(() => state.order.filter((p) => state.files[p].dirty), [state.order, state.files]);
  const file = state.active ? state.files[state.active] : null;
  const navigationOwner = useMemo(
    () =>
      file && state.active ? { path: state.active, memory: file.memory } : null,
    [state.active, file?.memory],
  );
  const latestNavigationOwner = useRef(navigationOwner);
  latestNavigationOwner.current = navigationOwner;
  const [navigationReport, setNavigationReport] = useState<{
    owner: { path: string; memory: YamlEditorMemory };
    presentation: NavigationPresentation;
  } | null>(null);
  const reportNavigation = useCallback(
    (presentation: NavigationPresentation) => {
      // A clean refresh can replace memory without changing the relative path.
      // Reports from that old editor must not enable Back or replace this footer.
      if (!navigationOwner || latestNavigationOwner.current !== navigationOwner)
        return;
      setNavigationReport({ owner: navigationOwner, presentation });
    },
    [navigationOwner],
  );
  const navigation =
    navigationReport?.owner === navigationOwner
      ? navigationReport?.presentation
      : null;
  const navigationSupported =
    !!state.active && resolveNavigationLanguage(state.active) !== null;
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
  // Selection belongs to the visible tree/filter, not to whichever tab was last
  // opened. Navigation must not leave hidden paths as clipboard targets.
  const changeFileFilter = (value: string, paths: string[] = []) => {
    searchAnchor.current = null;
    setSearch(value);
    setResults(null);
    setSearchNotice("");
    setSelectedPaths(paths);
    setSelection(paths[0] ?? null);
    setFileMenu(null);
  };
  const showFileDirectory = (
    directory: string,
    paths: string[] = [],
    query = "",
  ) => {
    setTreeScope(directory);
    changeFileFilter(query, paths);
    void store.loadDirectory(directory);
  };
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
            const visible = new Set(r.entries.map((entry) => entry.path));
            setSelectedPaths((paths) =>
              paths.filter((p) => p === treeScope || visible.has(p)),
            );
            setSearchNotice(
              r.truncated
                ? msg("overview.onlySomeResultsAreShownNarrowTheNameOrSearch")
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
      showFileDirectory("");
      return;
    }
    if (!Object.hasOwn(index.cells, p)) return;
    setGraphScope(p);
    showFileDirectory(p === "." ? "" : p);
    setSelection(p);
  };
  const navigateFromTree = (p: string) => {
    const owner = ownerForPath(state.schema ?? [], p);
    showFileDirectory(p, [p]);
    setGraphScope(Object.hasOwn(index.cells, p) ? p : (owner ?? projectScope));
    setGraphCollapsed(false);
    setCompactTab("graph");
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
      setModalError(msg("overview.enterANameWithoutAPath2"));
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
          msg("overview.couldNotCreateTheFileCheckThePathAndMake"),
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
        msg("overview.theFirst200FoldersAreExpandedExpandTheRestManually"),
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
      aria-label={msg("overview.projectOverview")}
    >
      {!treeHidden && (
        <>
          <aside
            ref={filePaneRef}
            tabIndex={-1}
            className="ov-files"
            onPointerDown={(event) => {
              if (
                !(event.target as HTMLElement).closest(
                  "input,button,.ov-tree-row",
                )
              )
                event.currentTarget.focus();
            }}
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
              <strong>{msg("overview.files")}</strong>
              <div className="ov-tree-tools">
                <IconButton
                  label={msg("overview.createFile")}
                  onClick={() => startCreate("file")}
                >
                  <FilePlus2 size={15} />
                </IconButton>
                <IconButton
                  label={msg("overview.createFolder")}
                  onClick={() => startCreate("directory")}
                >
                  <FolderPlus size={15} />
                </IconButton>
                <IconButton
                  label={msg("overview.collapseFileTree")}
                  onClick={() => setExpanded([])}
                >
                  <ChevronsDownUp size={15} />
                </IconButton>
                <IconButton
                  label={msg("overview.expandFileTree")}
                  onClick={() => void expandAll()}
                >
                  <ChevronsUpDown size={15} />
                </IconButton>
                <IconButton
                  label={msg("overview.closeAllOpenFiles")}
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
                aria-label={msg("overview.searchFiles")}
                placeholder={msg("overview.findAFile")}
                value={search}
                onChange={(e) => changeFileFilter(e.target.value)}
              />
              {search && (
                <IconButton
                  label={msg("overview.clearSearch")}
                  onClick={() => changeFileFilter("")}
                >
                  <X size={13} />
                </IconButton>
              )}
            </div>
            {active && pasteActivity?.owner === JSON.stringify(scope) && (
              <div
                className="ov-paste-activity"
                role="status"
                aria-label={msg("overview.pasteFiles")}
                aria-live="polite"
              >
                <RefreshCw size={14} className="ov-spin" aria-hidden="true" />
                <span>
                  {
                    {
                      preparing: msg("overview.preparingToPaste"),
                      copying: msg("overview.copyingFiles"),
                      refreshing: msg("overview.refreshingTree"),
                    }[pasteActivity.phase]
                  }
                  …
                  <span
                    className="ov-paste-destination"
                    title={pasteActivity.destination || msg("overview.projectRoot")}
                  >
                    {pasteActivity.destination || msg("overview.projectRoot")}
                  </span>
                </span>
              </div>
            )}
            <div className="ov-file-scope">
              <button
                onClick={() => {
                  showFileDirectory("");
                }}
              >
                <FolderOpen size={15} />
                {treeScope ? basename(treeScope) : msg("overview.allFiles")}
                {treeScope && <X size={13} />}
              </button>
              {treeScope && Object.hasOwn(index.cells, treeScope) && (
                <IconButton
                  label={msg("overview.showFolderContract", { path: treeScope })}
                  onClick={() => showContract(treeScope)}
                >
                  <Braces size={15} />
                </IconButton>
              )}
              {treeScope && Object.hasOwn(index.cells, treeScope) && (
                <IconButton
                  label={msg("overview.showCurrentFolderOnGraph")}
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
                      <strong>{p || msg("overview.project")}:</strong>{" "}
                      <span>{state.directoryErrors[p]}</span>
                      <button
                        aria-label={msg("overview.retryLoading") + (p || msg("overview.projects"))}
                        onClick={() => void store.loadDirectory(p)}
                      >{msg("overview.retry")}</button>
                    </p>
                  ) : state.directories[p]?.truncated ? (
                    <p key={p} className="ov-hint" role="status">
                      <strong>{p || msg("overview.project")}:</strong>{" "}
                      <span>{msg("overview.listTruncatedNarrowTheSearchOrSelectAFolder")}</span>
                    </p>
                  ) : null,
                )}
            </div>
            {results ? (
              <div className="ov-search-results">
                {results.map((e) => (
                  <button
                    key={e.path}
                    aria-pressed={selectedPaths.includes(e.path)}
                    className={
                      selectedPaths.includes(e.path) ? "ov-tree-selected" : ""
                    }
                    onDoubleClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey)
                        return;
                      if (e.kind === "directory") navigateFromTree(e.path);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const paths = selectedPaths.includes(e.path)
                        ? selectedPaths
                        : [e.path];
                      if (!selectedPaths.includes(e.path))
                        searchAnchor.current = e.path;
                      setSelectedPaths(paths);
                      setFileMenu({
                        paths,
                        entry: e,
                        parent: e.path.includes("/")
                          ? e.path.slice(0, e.path.lastIndexOf("/"))
                          : "",
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    onClick={(event) => {
                      const next = selectOverviewRows(
                        results.map((row) => row.path),
                        selectedPaths,
                        searchAnchor.current,
                        e.path,
                        event,
                      );
                      searchAnchor.current = next.anchor;
                      setSelectedPaths(next.paths);
                      if (event.metaKey || event.ctrlKey || event.shiftKey)
                        return;
                      if (e.kind === "directory") {
                        showFileDirectory(e.path, [e.path], search);
                        select(e.path);
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
              <Network size={13} />{msg("overview.selectingAnItemInTheTreeHighlightsItInThe")}</footer>
          </aside>
          <Splitter
            label={msg("overview.fileTreeWidth")}
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
            <strong>{msg("overview.projectMap")}</strong>
            {compact && showInspector && (
              <div className="ov-architecture-tabs">
                <button
                  aria-pressed={compactTab === "graph"}
                  onClick={() => setCompactTab("graph")}
                >{msg("overview.graph")}</button>
                <button
                  aria-pressed={compactTab === "contract"}
                  onClick={() => setCompactTab("contract")}
                >{msg("overview.contract")}</button>
              </div>
            )}
            <div className="ov-map-actions">
              <IconButton
                label={msg("overview.showContractForCurrentFolder")}
                disabled={!Object.hasOwn(index.cells, graphScope)}
                onClick={() => showContract(graphScope)}
              >
                <Braces size={16} />
              </IconButton>
              <IconButton
                label={full === "graph" ? msg("overview.restoreGraphSize") : msg("overview.expandGraph")}
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
                label={graphCollapsed ? msg("overview.showGraph") : msg("overview.collapseGraph")}
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
                label={msg("overview.refreshOverview")}
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
                label={msg("overview.upOneLevel")}
                disabled={graphScope === projectScope}
                onClick={() => drill(index.parents[graphScope] ?? projectScope)}
              >
                <ArrowUp size={15} />
              </IconButton>
              <button
                aria-label={msg("overview.projectRoot")}
                onClick={() => {
                  setGraphScope(projectScope);
                  showFileDirectory("");
                }}
              >{msg("overview.project")}</button>
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
                <button onClick={() => void store.refreshAll()}>{msg("overview.retry")}</button>
              </p>
            )}
            {state.stale && (
              <p className="ov-hint ov-stale" role="status">{msg("overview.theGraphAndContractsMayHaveChangedRefreshOverview")}</p>
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
                  {state.refreshing ? msg("overview.loadingGraph") : msg("overview.noGraphAvailable")}
                </h3>
                <p>{msg("overview.filesAreAvailableInTheTreeRefreshOverviewAfterAdding")}</p>
              </div>
            )}
          </div>
        </section>
        {graphCollapsed && !file && !displayContract && (
          <div className="ov-empty">
            <p>{msg("overview.theGraphIsCollapsedOpenAFileFromTheTree")}</p>
          </div>
        )}
        {compact && displayContract && (
          <div className="ov-inline-contract">
            <div className="ov-inline-tabs">
              <button onClick={() => setCompactTab("graph")}>{msg("overview.graph")}</button>
              <strong>{msg("overview.contract")}</strong>
              <IconButton
                label={msg("overview.closeContract")}
                onClick={() => {
                  transport.cancel("contract");
                  store.closeContract();
                  setCompactTab("graph");
                }}
              >
                <X size={16} />
              </IconButton>
              <IconButton
                label={msg("overview.refreshOverview")}
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
                  label={msg("overview.graphHeight")}
                  value={graphHeight}
                  onChange={(v) =>
                    setGraphHeight(Math.max(180, Math.min(800, v)))
                  }
                />
              )}
            <section className="ov-document">
              <header className="ov-tabs">
                <div role="tablist" aria-label={msg("overview.openFiles")}>
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
                        label={msg("overview.close2") + p}
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
                        ? msg("overview.showMarkdownSource")
                        : msg("overview.markdownPreview")
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
                    full === "file" ? msg("overview.restoreDocumentSize") : msg("overview.expandDocument")
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
                  title={msg("overview.revealFileInTree")}
                  onClick={() => {
                    const p = state.active!;
                    const parent = p.includes("/")
                      ? p.slice(0, p.lastIndexOf("/"))
                      : "";
                    showFileDirectory(parent, [p]);
                    select(p);
                  }}
                >
                  <FileCode2 size={15} />
                  <span>{state.active}</span>
                </button>
                <div className="ov-file-actions">
                  {navigationSupported && (
                    <>
                      <IconButton
                        label={msg("overview.backToPreviousLocation")}
                        hint={msg("overview.backToPreviousLocationAfterF12ClickCtrlClick")}
                        disabled={!active || !navigation?.canBack}
                        onClick={() => editorCommands.current?.goBack()}
                      >
                        <ArrowLeft size={15} />
                      </IconButton>
                      <IconButton
                        label={msg("overview.goToDefinition")}
                        hint={msg("overview.goToDefinitionF12ClickCtrlClick")}
                        disabled={!active || !navigation?.ready}
                        onClick={() => editorCommands.current?.goToDefinition()}
                      >
                        <CornerDownRight size={15} />
                      </IconButton>
                    </>
                  )}
                  <IconButton
                    label={msg("overview.findInFile")}
                    hint={msg("overview.findInFileCtrlFF")}
                    disabled={!active || preview || file.busy}
                    onClick={() => editorCommands.current?.find()}
                  >
                    <Search size={15} />
                  </IconButton>
                  <IconButton
                    label={msg("overview.replaceInFile")}
                    hint={msg("overview.replaceInFileCtrlRF")}
                    disabled={!active || preview || file.busy}
                    onClick={() => editorCommands.current?.replace()}
                  >
                    <Replace size={15} />
                  </IconButton>
                  <IconButton
                    label={msg("overview.reloadFileFromDisk")}
                    disabled={file.busy}
                    onClick={() => void refreshOne(state.active!)}
                  >
                    <RefreshCw size={15} />
                  </IconButton>
                  <IconButton
                    className="ov-close-without-save ov-labeled-action"
                    label={msg("overview.closeWithoutSaving")}
                    disabled={file.busy}
                    onClick={() => close([state.active!])}
                  >
                    <X size={15} />
                    <span>{msg("overview.closeWithoutSaving")}</span>
                  </IconButton>
                  <IconButton
                    className="ov-labeled-action"
                    label={msg("overview.save")}
                    disabled={
                      file.busy ||
                      !file.exists ||
                      !dirty.includes(state.active!)
                    }
                    onClick={() => void store.save(state.active!)}
                  >
                    <Save size={14} />
                    <span>{msg("overview.save")}</span>
                  </IconButton>
                </div>
              </div>
              {file.error && (
                <div className="ov-notice" role="alert">
                  {file.error}
                </div>
              )}
              {(file.changedExternally ||
                (file.error && dirty.includes(state.active!))) && (
                <div className="ov-notice">{msg("overview.fileChangedOnDiskYourDraftWasKept")}<button onClick={() => startCreate("file", state.active!)}>{msg("overview.saveACopy")}</button>
                </div>
              )}
              {preview ? (
                <HistoryScrollPane
                  key={state.active}
                  className="ov-markdown-preview"
                  positionKey={state.active!}
                  positions={previewScroll.current}
                  active={active}
                  label={msg("overview.markdownPreview")}
                >
                  <LiveMarkdown
                    store={store}
                    path={state.active!}
                    onFile={(p) => {
                      select(p);
                      void store.open(p);
                    }}
                  />
                </HistoryScrollPane>
              ) : (
                <LiveEditor
                  store={store}
                  key={state.active}
                  path={state.active!}
                  readOnly={file.busy}
                  memory={file.memory}
                  commands={editorCommands}
                  active={active}
                  onNavigationChange={reportNavigation}
                />
              )}
              <footer className="ov-status">
                <span className="ov-save-status">
                  {dirty.includes(state.active!) ? msg("overview.notSaved") : msg("overview.saved")}{" "}
                  · {state.active?.split(".").at(-1)}
                </span>
                {navigation?.message && (
                  <span
                    className="ov-navigation-message"
                    role="status"
                    title={navigation.message}
                  >
                    {navigation.message}
                  </span>
                )}
                <span>{msg("overview.savingDoesNotCreateACommit")}</span>
              </footer>
            </section>
          </>
        )}
      </div>
      {displayContract && !compact && (
        <>
          <Splitter
            label={msg("overview.contractPanelWidth")}
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
        filePaneRef={filePaneRef}
        filePaneVisible={!treeHidden}
        treeScope={treeScope}
        selectedPaths={selectedPaths}
        menu={fileMenu}
        onCloseMenu={closeFileMenu}
        onCreate={(kind, parent) => startCreate(kind, undefined, parent)}
        onNavigate={navigateFromTree}
        onBusy={setFileActionBusy}
        onPasteActivity={setPasteActivity}
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
                ? msg("overview.saveACopy2")
                : creation.kind === "file"
                  ? msg("overview.createFile")
                  : msg("overview.createFolder")
            }
            className="ov-modal"
          >
            <header>
              <h2>
                {creation.copy
                  ? msg("overview.saveACopy2")
                  : creation.kind === "file"
                    ? msg("overview.createFile")
                    : msg("overview.createFolder")}
              </h2>
              <IconButton
                label={msg("overview.closeWindow")}
                onClick={() => setCreation(null)}
              >
                <X size={17} />
              </IconButton>
            </header>
            <p className="ov-hint">{msg("overview.inFolder")}{creation.parent || msg("overview.projectRoot")}
            </p>
            <label>{msg("overview.name")}<input
                aria-label={msg("overview.name")}
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
              <button onClick={() => setCreation(null)}>{msg("overview.cancel")}</button>
              <button className="primary" onClick={() => void create()}>
                {creation.copy ? msg("overview.saveACopy2") : msg("overview.create")}
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
            aria-label={msg("overview.unsavedChanges")}
            className="ov-modal"
          >
            <header>
              <h2>{reload ? msg("overview.reloadFileFromDisk2") : msg("overview.closeFiles")}</h2>
              <IconButton
                label={msg("overview.cancelClosing")}
                onClick={() => {
                  setClosing(null);
                  setReload(null);
                }}
              >
                <X size={17} />
              </IconButton>
            </header>
            <p>{msg("overview.unsavedChangesInTheseFilesWillBeLostOtherFiles")}</p>
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
              >{msg("overview.cancel")}</button>
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
                >{msg("overview.saveAndClose")}</button>
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
                {reload ? msg("overview.loadFromDisk") : msg("overview.closeWithoutSaving")}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
