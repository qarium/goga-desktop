import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Info,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { Project } from "../shared/types";
import type { TopicContextRef } from "../shared/worktrees";
import type {
  SpecificationCatalog,
  SpecificationDocument,
} from "../shared/project-specifications";
import { readTimeoutMessage } from "../shared/read-deadlines";
import { contextRef } from "./topic-context";
import { useReadScope } from "./read-request";
import { useViewActive } from "./RetainedViews";
import { preparationErrorMessage } from "./preparation-error";
import { HistoryMarkdown } from "./HistoryMarkdown";
import { HistoryDocument } from "./HistoryDocument";
import { HistoryViewport } from "./HistoryViewport";
import { LoadingBoundary } from "./LoadingBoundary";
import {
  buildTree,
  visibleRows,
  searchFiles,
  parents,
  type SpecificationNode,
} from "./project-specifications-tree";
import {
  createSpecificationsState,
  specificationOwnerKey,
  type SpecificationsStateStore,
  type SpecificationViewState,
} from "./project-specifications-state";
import "./ProjectHistory.css";
import "./ProjectSpecifications.css";

type ReadState<T> = {
  key: string;
  authority: string;
  pending: boolean;
  value?: T;
  error?: string;
  generation: number;
};
const initialRead = <T,>(): ReadState<T> => ({
  key: "",
  authority: "",
  pending: false,
  generation: 0,
});
function readError(error: unknown): string {
  const message = preparationErrorMessage(error).replace(
    /^Error invoking remote method 'goga:(?:list-project-specifications|read-project-specification)': (?:Error: )?/,
    "",
  );
  return message === readTimeoutMessage(30000)
    ? "Не удалось прочитать спецификации за 30 секунд. Повторите загрузку."
    : message;
}

export function ProjectSpecifications({
  project,
  owner,
  refreshRevision = 0,
  stateStore,
}: {
  project: Project;
  owner?: TopicContextRef;
  refreshRevision?: number;
  stateStore?: SpecificationsStateStore;
}) {
  const active = useViewActive();
  const scope = owner ? contextRef(owner) : project.id;
  const ownerKey = specificationOwnerKey(scope);
  const authority = JSON.stringify([ownerKey, owner?.revision ?? ""]);
  const [ownStore] = useState(createSpecificationsState);
  const store = stateStore ?? ownStore;
  const [local, setLocal] = useState(() => ({
    key: ownerKey,
    value: store.get(scope),
  }));
  const view = local.key === ownerKey ? local.value : store.get(scope);
  const update = (
    change: (value: SpecificationViewState) => SpecificationViewState,
  ) => {
    const next = change(store.get(scope));
    store.set(scope, next);
    setLocal({ key: ownerKey, value: next });
  };
  const [attempt, setAttempt] = useState(0),
    [documentAttempt, setDocumentAttempt] = useState(0),
    [linkError, setLinkError] = useState("");
  const [catalogState, setCatalog] =
    useState<ReadState<SpecificationCatalog>>(initialRead);
  const [documentState, setDocument] =
    useState<ReadState<SpecificationDocument>>(initialRead);
  const generation = useRef(0);
  const catalogKey = JSON.stringify([
    authority,
    refreshRevision,
    attempt,
    active,
  ]);
  const readCatalog = useReadScope(catalogKey);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const nextGeneration = ++generation.current;
    setCatalog((previous) => ({
      key: catalogKey,
      authority,
      pending: true,
      generation: nextGeneration,
      value: previous.authority === authority ? previous.value : undefined,
    }));
    readCatalog("listProjectSpecifications", scope).then(
      (value) => {
        if (!current) return;
        setCatalog({
          key: catalogKey,
          authority,
          pending: false,
          value,
          generation: nextGeneration,
        });
        if (!store.get(scope).initialized) {
          update((state) => ({
            ...state,
            initialized: true,
            selected: value.paths.includes("README.md") ? "README.md" : null,
            expanded: new Set(),
          }));
        }
      },
      (error) => {
        if (current)
          setCatalog((previous) => ({
            ...previous,
            key: catalogKey,
            authority,
            pending: false,
            error: readError(error),
          }));
      },
    );
    return () => {
      current = false;
    };
  }, [catalogKey, readCatalog, active]);
  const catalog =
    catalogState.authority === authority ? catalogState.value : undefined;
  const catalogPending =
    active && (catalogState.key !== catalogKey || catalogState.pending);
  const catalogError =
    catalogState.key === catalogKey ? catalogState.error : undefined;
  const catalogReady = active && !catalogPending && !!catalog;
  const tree = useMemo(() => buildTree(catalog?.paths ?? []), [catalog]);
  const selected = view.selected;
  const documentKey = JSON.stringify([
    authority,
    selected,
    catalogKey,
    catalogState.generation,
    documentAttempt,
    active,
  ]);
  const readDocument = useReadScope(documentKey);
  useEffect(() => {
    if (!catalogReady || !catalog?.exists || !selected) return;
    let current = true;
    setDocument((previous) => ({
      key: documentKey,
      authority,
      pending: true,
      generation: 0,
      value:
        previous.authority === authority && previous.value?.path === selected
          ? previous.value
          : undefined,
    }));
    readDocument("readProjectSpecification", scope, selected)
      .then((value) => {
        if (value.path !== selected)
          throw Error(
            "Получен документ другой спецификации. Повторите загрузку.",
          );
        if (current)
          setDocument({
            key: documentKey,
            authority,
            pending: false,
            value,
            generation: 0,
          });
      })
      .catch((error) => {
        if (current)
          setDocument((previous) => ({
            ...previous,
            pending: false,
            error: readError(error),
          }));
      });
    return () => {
      current = false;
    };
  }, [documentKey, readDocument, catalogReady]);
  const document =
    documentState.authority === authority &&
    documentState.value?.path === selected
      ? documentState.value
      : undefined;
  const documentPending =
    active &&
    !!selected &&
    !!catalog?.exists &&
    (catalogPending ||
      documentState.key !== documentKey ||
      documentState.pending);
  const documentError =
    documentState.key === documentKey ? documentState.error : undefined;
  const readable = !!document?.exists;
  const panesVisible =
    !!catalog?.exists && (tree.files.length > 0 || !!selected);
  const searching = !!view.query.trim();
  const rows = visibleRows(tree, view.expanded),
    results = searchFiles(tree, view.query);
  const treeRoot = useRef<HTMLDivElement>(null),
    reveal = useRef(false);
  const treePositionKey = searching ? "search" : "tree";
  useLayoutEffect(() => {
    if (!active || !panesVisible || !treeRoot.current) return;
    const saved = view.treePositions.get(treePositionKey) ?? {
      top: 0,
      left: 0,
    };
    treeRoot.current.scrollTop = saved.top;
    treeRoot.current.scrollLeft = saved.left;
  }, [ownerKey, active, panesVisible, searching]);
  useLayoutEffect(() => {
    if (!reveal.current || !active || searching) return;
    reveal.current = false;
    const row = [
      ...(treeRoot.current?.querySelectorAll<HTMLElement>("[data-path]") ?? []),
    ].find((node) => node.dataset.path === selected);
    row
      ?.querySelector<HTMLElement>(".spec-name")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected, view.expanded, active, searching]);
  useEffect(() => {
    setLinkError("");
  }, [authority, selected]);
  function choose(path: string) {
    if (!tree.nodes.has(path) || tree.nodes.get(path)?.kind !== "file") {
      setLinkError(
        `Документ «${path}» не найден в .goga/usages. Обновите спецификации.`,
      );
      return;
    }
    reveal.current = true;
    update((state) => ({
      ...state,
      selected: path,
      initialized: true,
      query: "",
      expanded: new Set([...state.expanded, ...parents(path)]),
    }));
    setLinkError("");
  }
  function toggle(path: string, expanded?: boolean) {
    update((state) => {
      const next = new Set(state.expanded);
      if (expanded ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return { ...state, expanded: next };
    });
  }
  function keyNav(
    event: KeyboardEvent<HTMLButtonElement>,
    row: SpecificationNode,
  ) {
    const buttons = [
        ...(treeRoot.current?.querySelectorAll<HTMLButtonElement>(
          "[role=treeitem]",
        ) ?? []),
      ],
      index = rows.findIndex((item) => item.path === row.path);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? buttons[0] : buttons.at(-1))?.focus();
    } else if (event.key === "ArrowRight" && row.kind === "directory") {
      event.preventDefault();
      if (!view.expanded.has(row.path)) toggle(row.path, true);
      else buttons[index + 1]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.kind === "directory" && view.expanded.has(row.path))
        toggle(row.path, false);
      else
        buttons.find((button) => button.dataset.path === row.parent)?.focus();
    }
  }
  return (
    <section className="specifications-view" aria-label="Спецификации проекта">
      <div className="spec-section-toolbar">
        <div>
          <code>.goga/usages/</code>
          <span>Спецификации выбранной рабочей области</span>
        </div>
        <div>
          <span className="spec-readonly">Только просмотр</span>
          <button
            type="button"
            className="quiet spec-icon"
            disabled={catalogPending || documentPending}
            aria-label="Обновить спецификации"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <LoadingBoundary
        pending={catalogPending}
        background={!!catalog}
        label="Загружаем спецификации…"
        error={catalog ? catalogError : undefined}
        onRetry={() => setAttempt((value) => value + 1)}
      >
        {catalogError && !catalog && (
          <div className="spec-state" role="alert">
            <Info size={28} />
            <h3>Не удалось загрузить спецификации</h3>
            <p>{catalogError}</p>
            <button
              type="button"
              aria-label="Повторить загрузку"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Повторить
            </button>
          </div>
        )}
        {catalogError && catalog && (
          <p className="spec-refresh-error">
            Спецификации не обновлены. Ниже показана предыдущая версия.
          </p>
        )}
        {!catalogPending && catalog && !catalog.exists ? (
          <div className="spec-state">
            <FolderOpen size={32} />
            <h3>Спецификаций пока нет</h3>
            <p>Папка .goga/usages ещё не создана в этой рабочей области.</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Обновить
            </button>
          </div>
        ) : catalog && !panesVisible ? (
          <div className="spec-state">
            <FolderOpen size={32} />
            <h3>Markdown-файлы не найдены</h3>
            <p>
              В .goga/usages пока нет файлов .md, в том числе во вложенных
              папках.
            </p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Обновить
            </button>
          </div>
        ) : null}
        {catalog?.skippedUnsupported ? (
          <p className="spec-unsupported">
            Ссылки и специальные файлы не открываются:{" "}
            {catalog.skippedUnsupported}.
          </p>
        ) : null}
        <div hidden={!panesVisible}>
          <HistoryViewport active={active && panesVisible}>
            <div className="item-list tree-pane spec-tree">
              <div className="spec-tree-heading">
                <span className="eyebrow">ФАЙЛЫ</span>
                <div>
                  <button
                    type="button"
                    className="quiet spec-icon"
                    aria-label="Раскрыть все папки"
                    onClick={() =>
                      update((state) => ({
                        ...state,
                        expanded: new Set(
                          [...tree.nodes.values()]
                            .filter((row) => row.kind === "directory")
                            .map((row) => row.path),
                        ),
                      }))
                    }
                  >
                    <ChevronsUpDown size={15} />
                  </button>
                  <button
                    type="button"
                    className="quiet spec-icon"
                    aria-label="Свернуть все папки"
                    onClick={() =>
                      update((state) => ({ ...state, expanded: new Set() }))
                    }
                  >
                    <ChevronsDownUp size={15} />
                  </button>
                </div>
              </div>
              <div className="spec-search">
                <Search size={15} />
                <input
                  aria-label="Найти спецификацию"
                  placeholder="Имя файла или путь…"
                  value={view.query}
                  onChange={(event) =>
                    update((state) => ({ ...state, query: event.target.value }))
                  }
                />
                {view.query && (
                  <button
                    type="button"
                    className="quiet spec-icon"
                    aria-label="Очистить поиск"
                    onClick={() => {
                      reveal.current = true;
                      update((state) => ({ ...state, query: "" }));
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <div
                className="history-scroll-region"
                role="region"
                aria-label="Дерево спецификаций"
                tabIndex={0}
                ref={treeRoot}
                onScroll={(event) => {
                  if (active && panesVisible)
                    view.treePositions.set(treePositionKey, {
                      top: event.currentTarget.scrollTop,
                      left: event.currentTarget.scrollLeft,
                    });
                }}
              >
                {searching ? (
                  <div
                    className="spec-results"
                    role="list"
                    aria-label="Результаты поиска"
                  >
                    {results.length ? (
                      results.map((row) => (
                        <button
                          key={row.path}
                          type="button"
                          role="listitem"
                          className={selected === row.path ? "selected" : ""}
                          onClick={() => choose(row.path)}
                        >
                          <FileText size={16} />
                          <span>
                            {row.name}
                            <small>{row.path}</small>
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="spec-no-results">Ничего не найдено</p>
                    )}
                  </div>
                ) : (
                  <div
                    className="spec-tree-rows"
                    role="tree"
                    aria-label="Файлы спецификаций"
                  >
                    {rows.map((row) => (
                      <button
                        key={row.path}
                        type="button"
                        role="treeitem"
                        data-path={row.path}
                        aria-level={row.depth + 1}
                        aria-expanded={
                          row.kind === "directory"
                            ? view.expanded.has(row.path)
                            : undefined
                        }
                        aria-selected={
                          row.kind === "file"
                            ? selected === row.path
                            : undefined
                        }
                        aria-label={`${row.kind === "file" ? "Файл" : "Папка"} ${row.path}`}
                        title={row.path}
                        className={`spec-tree-row ${row.kind === "file" && selected === row.path ? "selected" : ""}`}
                        style={{ paddingLeft: 8 + row.depth * 16 }}
                        onKeyDown={(event) => keyNav(event, row)}
                        onClick={() =>
                          row.kind === "file"
                            ? choose(row.path)
                            : toggle(row.path)
                        }
                      >
                        {row.kind === "directory" ? (
                          <>
                            {view.expanded.has(row.path) ? (
                              <ChevronDown size={13} />
                            ) : (
                              <ChevronRight size={13} />
                            )}
                            <Folder size={16} />
                          </>
                        ) : (
                          <>
                            <span className="spec-chevron-spacer" />
                            <FileText size={16} />
                          </>
                        )}
                        <span className="spec-name">{row.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="spec-tree-footer">
                {searching
                  ? `${results.length} найдено`
                  : `${tree.files.length} документов`}
              </div>
            </div>
            {selected ? (
              <HistoryDocument
                identity={`${ownerKey}:${selected}`}
                active={active && panesVisible}
                ready={active && !documentPending && !catalogPending}
                readable={readable}
                positions={view.documentPositions}
                title={selected.split("/").at(-1)!}
                format="MARKDOWN"
                contextLabel={`.goga/usages/${selected}`}
              >
                <p className="spec-document-path">.goga/usages/{selected}</p>
                {linkError && (
                  <div className="spec-link-error" role="alert">
                    <span>{linkError}</span>
                    <button
                      type="button"
                      className="quiet spec-icon"
                      aria-label="Закрыть сообщение"
                      onClick={() => setLinkError("")}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <LoadingBoundary
                  pending={documentPending}
                  background={!!document}
                  label="Загружаем документ…"
                  error={documentError}
                  onRetry={() => setDocumentAttempt((value) => value + 1)}
                >
                  {documentError && document && (
                    <p className="spec-refresh-error">
                      Документ не обновлён. Ниже показана предыдущая версия.
                    </p>
                  )}
                  {document?.exists ? (
                    <div className="history-preview">
                      {document.text === "" ? (
                        <p className="history-empty">Файл пуст</p>
                      ) : (
                        <HistoryMarkdown
                          text={document.text}
                          path={selected}
                          onFile={choose}
                        />
                      )}
                    </div>
                  ) : !documentPending && !documentError ? (
                    <div className="spec-state spec-file-missing">
                      <FileText size={30} />
                      <h3>Файл больше недоступен</h3>
                      <p>
                        Он мог быть удалён или перемещён. Выберите другой
                        документ слева.
                      </p>
                    </div>
                  ) : null}
                </LoadingBoundary>
              </HistoryDocument>
            ) : (
              <div className="spec-state">
                <FileText size={30} />
                <h3>Выберите Markdown-файл</h3>
                <p>Документы находятся в дереве слева.</p>
              </div>
            )}
          </HistoryViewport>
        </div>
      </LoadingBoundary>
    </section>
  );
}
