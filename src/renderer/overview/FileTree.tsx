import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTree } from "@headless-tree/react";
import {
  syncDataLoaderFeature,
  selectionFeature,
  hotkeysCoreFeature,
} from "@headless-tree/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileCode2,
  Braces,
  Network,
} from "lucide-react";
import type {
  OverviewDirectory,
  OverviewEntry,
} from "../../shared/project-overview";
export interface FileTreeMenu {
  paths: string[];
  x: number;
  y: number;
  parent: string;
  entry?: OverviewEntry;
}
export function FileTree({
  scope,
  directories,
  expanded,
  setExpanded,
  selection,
  selectedPaths,
  onSelectedPaths,
  onNavigate,
  onContextMenu,
  onFile,
  onFolder,
  onContract,
  hasContract,
  load,
  dirty,
}: {
  scope: string;
  directories: Record<string, OverviewDirectory>;
  expanded: string[];
  setExpanded: Dispatch<SetStateAction<string[]>>;
  selection: string | null;
  selectedPaths?: string[];
  onSelectedPaths?: (paths: string[]) => void;
  onNavigate?: (p: string) => void;
  onContextMenu?: (menu: FileTreeMenu) => void;
  onFile: (p: string) => void;
  onFolder: (p: string) => void;
  onContract: (p: string) => void;
  hasContract: (p: string) => boolean;
  load: (p: string) => Promise<unknown>;
  dirty: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const selected = selectedPaths ?? (selection ? [selection] : []);
  const entries = useMemo(
    () =>
      Object.fromEntries(
        Object.values(directories).flatMap((d) =>
          d.entries.map((e) => [e.path, e]),
        ),
      ),
    [directories],
  );
  const tree = useTree<OverviewEntry>({
    rootItemId: scope,
    initialState: { expandedItems: expanded },
    state: {
      expandedItems: expanded,
      selectedItems: selected,
    },
    setExpandedItems: setExpanded,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().kind === "directory",
    dataLoader: {
      getItem: (id) =>
        entries[id] ?? {
          path: id,
          name: id.split("/").at(-1) || "Проект",
          kind: "directory",
        },
      getChildren: (id) => directories[id]?.entries.map((e) => e.path) || [],
    },
    onPrimaryAction: (item) => {
      const p = item.getId();
      if (item.getItemData().kind === "unsupported") return;
      if (item.isFolder()) {
        onFolder(p);
        setExpanded((v) =>
          v.includes(p) ? v.filter((x) => x !== p) : [...v, p],
        );
        void load(p);
      } else onFile(p);
    },
    scrollToItem: (item) => {
      const index = tree
        .getItems()
        .findIndex((x) => x.getId() === item.getId());
      virtual.scrollToIndex(index);
    },
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });
  useEffect(() => {
    let active = true,
      next = 0;
    const pending = expanded.filter((p) => !directories[p]);
    // Expanding a subtree is lazy and bounded, including keyboard/expand-all.
    // Preserve the transport ceiling instead of issuing every folder at once.
    void Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (active && next < pending.length) await load(pending[next++]);
      }),
    );
    return () => {
      active = false;
    };
  }, [expanded.join("\0")]);
  useEffect(() => {
    tree.rebuildTree();
  }, [tree, directories, scope]);
  const container = tree.getContainerProps("Файлы проекта");
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el;
      container.ref(el);
    },
    [tree],
  );
  const items = tree.getItems();
  const choose = (
    path: string,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) => {
    let next = [path];
    if (event.shiftKey && anchor.current) {
      const paths = items.map((item) => item.getId());
      const a = paths.indexOf(anchor.current),
        b = paths.indexOf(path);
      if (a >= 0 && b >= 0)
        next = paths.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else if (event.metaKey || event.ctrlKey) {
      next = selected.includes(path)
        ? selected.filter((p) => p !== path)
        : [...selected, path];
      anchor.current = path;
    } else anchor.current = path;
    onSelectedPaths?.(next);
  };
  const menu = (e: OverviewEntry, x: number, y: number) => {
    const paths = selected.includes(e.path) ? selected : [e.path];
    onSelectedPaths?.(paths);
    onContextMenu?.({
      paths,
      x,
      y,
      entry: e,
      parent: e.path.includes("/")
        ? e.path.slice(0, e.path.lastIndexOf("/"))
        : "",
    });
  };
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 32,
    overscan: 10,
    useAnimationFrameWithResizeObserver: true,
  });
  return (
    <div {...container} ref={attach} className="ov-tree-scroll">
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((v) => {
          const item = items[v.index],
            e = item.getItemData(),
            folder = item.isFolder();
          return (
            <div
              {...item.getProps()}
              key={e.path}
              title={e.reason || e.path}
              className={
                "ov-tree-row " +
                (selected.includes(e.path) ? "ov-tree-selected" : "")
              }
              style={{
                position: "absolute",
                top: v.start,
                height: v.size,
                paddingLeft: 10 + item.getItemMeta().level * 15,
              }}
              onClick={(event) => {
                item.setFocused();
                choose(e.path, event);
                if (!event.metaKey && !event.ctrlKey && !event.shiftKey)
                  item.primaryAction();
              }}
              onDoubleClick={() => {
                if (folder) onNavigate?.(e.path);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                item.setFocused();
                menu(e, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "ContextMenu" ||
                  (event.key === "F10" && event.shiftKey)
                ) {
                  event.preventDefault();
                  const r = event.currentTarget.getBoundingClientRect();
                  menu(e, r.x + 20, r.bottom);
                  return;
                }
                if (
                  event.target === event.currentTarget &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  choose(e.path, event);
                  if (!event.shiftKey && !event.metaKey && !event.ctrlKey)
                    item.primaryAction();
                }
              }}
            >
              <span className="ov-chevron">
                {folder ? (
                  item.isExpanded() ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )
                ) : null}
              </span>
              {folder ? (
                item.isExpanded() ? (
                  <FolderOpen size={16} />
                ) : (
                  <Folder size={16} />
                )
              ) : (
                <FileCode2 size={15} />
              )}
              <span className="ov-tree-name">{e.name}</span>
              {dirty.includes(e.path) && (
                <i title="Не сохранено" className="ov-dirty" />
              )}
              {folder && hasContract(e.path) && (
                <button
                  className="ov-contract-action"
                  title={"Контракт " + e.path}
                  aria-label={"Показать контракт папки " + e.path}
                  onClick={(event) => {
                    event.stopPropagation();
                    onContract(e.path);
                  }}
                >
                  <Braces size={14} />
                </button>
              )}
              {folder && hasContract(e.path) && onNavigate && (
                <button
                  className="ov-contract-action"
                  title={"Показать на схеме: " + e.path}
                  aria-label={"Показать папку " + e.path + " на схеме"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onNavigate(e.path);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <Network size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
