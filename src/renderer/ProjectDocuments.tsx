import { ProjectSpecifications } from "./ProjectSpecifications";
import type { SpecificationsStateStore } from "./project-specifications-state";
import { useViewActive } from "./RetainedViews";
import { ProjectHistory } from "./ProjectHistory";
import { ProjectDockerfile } from "./ProjectDockerfile";
import type { TopicContextRef } from "../shared/worktrees";
import { contextKey, contextRef } from "./topic-context";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  ProjectTool,
  ProjectToolEntry,
} from "../shared/project-documents";
import type { Project } from "../shared/types";
import { ProjectFlatDocuments } from "./ProjectFlatDocuments";
import { ProjectWorkflows } from "./ProjectWorkflows";
import { SettingsDocument } from "./SettingsDocument";
import { documentScopeId, type SettingsDocuments } from "./settings-documents";
export function ProjectDocuments({
  project,
  owner,
  tab,
  store,
  savedSettingsVersion,
  specificationsState,
}: {
  project: Project;
  owner?: TopicContextRef;
  tab: string;
  store: SettingsDocuments;
  savedSettingsVersion?: string;
  specificationsState?: SpecificationsStateStore;
}) {
  const viewActive = useViewActive();
  const scope = owner ? contextRef(owner) : project.id;
  const scopeKey = documentScopeId(scope);
  const [tools, setTools] = useState<ProjectTool[]>([]),
    [selectedTools, setSelectedTools] = useState<Record<string, string>>({}),
    [expanded, setExpanded] = useState<Record<string, boolean>>({}),
    [error, setError] = useState(""),
    [nameErrors, setNameErrors] = useState<Record<string, string>>({}),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  const revision = useSyncExternalStore(store.subscribe, () =>
    store.projectRevision(scope),
  );
  const tool = selectedTools[scopeKey] ?? "";
  const state = useSyncExternalStore(store.subscribe, () =>
    store.toolState(scope, tool),
  );
  // A primitive snapshot stays stable between store changes even though the
  // helper derives a fresh array; exact owner/revision boundaries remain intact.
  const loadedSnapshot = useSyncExternalStore(store.subscribe, () =>
    JSON.stringify(store.loadedToolFiles(scope)),
  );
  const loadedFiles: { tool: string; path: string }[] =
    JSON.parse(loadedSnapshot);
  const availableTools = [
    ...new Set([
      ...tools.map((item) => item.name),
      ...loadedFiles.map((item) => item.tool),
    ]),
  ];
  const loadedPaths = loadedFiles
    .filter((item) => item.tool === tool)
    .map((item) => item.path);
  const formKey = JSON.stringify([scopeKey, tool]);
  const nameError = nameErrors[formKey] ?? "";
  const clearNameError = () =>
    setNameErrors((previous) => ({ ...previous, [formKey]: "" }));
  const loadKey = JSON.stringify([scopeKey, tab, attempt, revision]);
  const [settled, setSettled] = useState("");
  const read = useReadScope(JSON.stringify([scopeKey, tab, attempt, revision]));
  useEffect(() => {
    if (!viewActive || tab !== "tools") return;
    let current = true;
    setLoading(true);
    setError("");
    read("listProjectTools", scope).then(
      (items) => {
        if (!current) return;
        setTools(items);
        setSelectedTools((previous) => ({
          ...previous,
          [scopeKey]: previous[scopeKey] || items[0]?.name || "",
        }));
        setLoading(false);
        setSettled(loadKey);
      },
      (e) => {
        if (current) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
          setSettled(loadKey);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [scopeKey, tab, attempt, revision, viewActive]);
  if (tab === "launch") return null;
  if (tab === "specifications")
    return <ProjectSpecifications project={project} owner={owner} refreshRevision={revision} stateStore={specificationsState}/>;
  if (tab === "history")
    return (
      <ProjectHistory
        key={owner ? contextKey(owner) : project.id}
        project={project}
        owner={owner}
      />
    );
  if (tab === "image")
    return (
      <ProjectDockerfile
        key={scopeKey}
        project={project}
        owner={owner}
        store={store}
      />
    );
  if (tab === "workflows")
    return (
      <ProjectWorkflows
        key={scopeKey}
        project={project}
        owner={owner}
        store={store}
        savedSettingsVersion={savedSettingsVersion}
      />
    );
  if (tab === "profiles")
    return (
      <ProjectFlatDocuments
        key={scopeKey}
        project={project}
        owner={owner}
        store={store}
        kind="profile"
      />
    );
  if (tab === "pipelines")
    return (
      <ProjectFlatDocuments
        key={scopeKey}
        project={project}
        owner={owner}
        store={store}
        kind="pipeline"
      />
    );
  if (tab === "config")
    return (
      <SettingsDocument
        store={store}
        source={{
          scope: "project",
          projectId: project.id,
          ...(owner ? { context: contextRef(owner) } : {}),
          target: { kind: "config" },
        }}
        path=".goga/config.yml"
        title="Конфигурация проекта"
        description="Это проектный файл Goga, не параметры запуска Desktop. Секция tools задаёт версии установки; файлы инструментов — в отдельном разделе."
      />
    );
  const selected = tools.find((item) => item.name === tool),
    file = state.selected;
  const entries: ProjectToolEntry[] = [
    ...(selected?.entries ?? []),
    ...[...new Set([...state.drafts, ...loadedPaths])]
      .filter((path) => !selected?.entries.some((entry) => entry.path === path))
      .map((path) => ({ path, kind: "file" as const, editable: true })),
  ];
  // A catalog refresh can remove the parent as well as the leaf. Keep the
  // in-memory path navigable without granting Save authority to create folders.
  for (const path of [...state.drafts, ...loadedPaths]) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (!entries.some((entry) => entry.path === parent))
        entries.push({ path: parent, kind: "directory", editable: false });
    }
  }
  const catalogReady = !loading && settled === loadKey && !error && !!selected;
  function create() {
    if (!catalogReady) return;
    try {
      store.createToolFile(scope, tool, state.name, tools);
      const parents = state.name.split("/").slice(0, -1);
      setExpanded((previous) => {
        const next = { ...previous };
        for (let index = 1; index <= parents.length; index++)
          next[
            JSON.stringify([scopeKey, tool, parents.slice(0, index).join("/")])
          ] = true;
        return next;
      });
      clearNameError();
    } catch (e) {
      setNameErrors((previous) => ({
        ...previous,
        [formKey]: e instanceof Error ? e.message : String(e),
      }));
    }
  }
  // A selected source is retained even if an uncertain trash attempt removes it
  // from discovery. Catalog loading/errors must never remount its editor.
  const retained = !!file || loadedFiles.length > 0;
  const hasLoadedDescendants = (path: string) =>
    loadedPaths.some((loaded) => loaded.startsWith(`${path}/`));
  function branch(prefix = "", heldOnly = false) {
    const children = entries.filter(
      (entry) =>
        entry.path.slice(0, entry.path.lastIndexOf("/") + 1) === prefix &&
        (!heldOnly ||
          loadedPaths.includes(entry.path) ||
          hasLoadedDescendants(entry.path)),
    );
    return <ul>{children.map((entry) => row(entry, heldOnly))}</ul>;
  }
  // Every exact loaded source has an open action independently of the live
  // catalog kind. Directory collisions retain their folder row and children.
  function sourceAction(entry: ProjectToolEntry, heldOnly = false) {
    const memorySource = entry.kind === "directory";
    return (
      <button
        type="button"
        className={`file-row ${file === entry.path ? "selected" : ""}`}
        aria-label={`${memorySource ? "Исходник в памяти" : "Файл"} ${entry.path}`}
        aria-pressed={file === entry.path}
        disabled={
          (!entry.editable || heldOnly) && !loadedPaths.includes(entry.path)
        }
        title={
          memorySource
            ? "Открыть исходник в памяти без чтения пути на диске"
            : entry.reason
        }
        onClick={() => store.updateTool(scope, tool, { selected: entry.path })}
      >
        <span className="file-mark" aria-hidden="true" />
        <span>
          {memorySource ? "Исходник в памяти" : entry.path.split("/").pop()}
          {!memorySource && !entry.editable && (
            <small>
              {entry.reason ?? "Этот файл недоступен для редактирования"}
            </small>
          )}
        </span>
      </button>
    );
  }
  function row(entry: ProjectToolEntry, heldOnly = false) {
    const name = entry.path.split("/").pop(),
      key = JSON.stringify([scopeKey, tool, entry.path]),
      open = expanded[key] === true;
    return (
      <li key={entry.path}>
        {entry.kind === "directory" ? (
          <>
            <button
              type="button"
              className="folder-row"
              aria-label={`Папка ${entry.path}`}
              aria-expanded={open}
              disabled={!!entry.reason && !hasLoadedDescendants(entry.path)}
              title={entry.reason}
              onClick={() =>
                setExpanded((value) => ({ ...value, [key]: !open }))
              }
            >
              <span className="chevron" aria-hidden="true">
                {open ? "⌄" : "›"}
              </span>
              <span className="folder-mark" aria-hidden="true" />
              <span>
                {name}
                {entry.reason && <small>{entry.reason}</small>}
              </span>
            </button>
            {loadedPaths.includes(entry.path) && sourceAction(entry, heldOnly)}
            {open && (
              <div>{branch(`${entry.path}/`, heldOnly || !!entry.reason)}</div>
            )}
          </>
        ) : (
          <>
            {sourceAction(entry, heldOnly)}
            {hasLoadedDescendants(entry.path) && (
              <>
                {/* A live file/symlink stays a file. This separate branch exposes
                  only exact cached descendants, never a filesystem directory. */}
                <button
                  type="button"
                  className="folder-row"
                  aria-label={`Черновики в ${entry.path}`}
                  aria-expanded={open}
                  title="Открыть сохранённые в памяти черновики"
                  onClick={() =>
                    setExpanded((value) => ({ ...value, [key]: !open }))
                  }
                >
                  <span className="chevron" aria-hidden="true">
                    {open ? "⌄" : "›"}
                  </span>
                  <span>Черновики в памяти</span>
                </button>
                {open && <div>{branch(`${entry.path}/`, true)}</div>}
              </>
            )}
          </>
        )}
      </li>
    );
  }
  return (
    <LoadingBoundary
      pending={loading || settled !== loadKey}
      label="Загружаем инструменты…"
    >
      {error && (
        <>
          <p className="error" role="alert">
            {error}
          </p>
          <button onClick={() => setAttempt((value) => value + 1)}>
            Повторить загрузку
          </button>
        </>
      )}
      {!loading && !error && !tools.length && !retained && (
        <div className="empty-file">
          <h3>В проекте пока нет инструментов</h3>
          <p>
            Здесь отображаются существующие папки .goga/tools. Файлы
            автоматически не создаются.
          </p>
        </div>
      )}
      {(tools.length > 0 || retained) && (
        <>
          <div className="tool-controls">
            <label>
              Инструмент
              <select
                value={availableTools.includes(tool) ? tool : ""}
                onChange={(e) =>
                  setSelectedTools((previous) => ({
                    ...previous,
                    [scopeKey]: e.target.value,
                  }))
                }
              >
                {!availableTools.includes(tool) && (
                  <option value="" disabled>
                    Выберите инструмент
                  </option>
                )}
                {availableTools.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!catalogReady}
              onClick={() => {
                store.updateTool(scope, tool, { creating: true });
                clearNameError();
              }}
            >
              Создать файл
            </button>
            <small className="tool-root">.goga/tools/{tool}/</small>
          </div>
          {!file && (
            <p className="description tools-description">
              Файлы выбранного инструмента в проекте {project.name}.
            </p>
          )}
          {state.creating && (
            <form
              className="new-profile"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <label>
                Имя файла
                <input
                  value={state.name}
                  onChange={(e) => {
                    store.updateTool(scope, tool, { name: e.target.value });
                    clearNameError();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button type="submit" disabled={!catalogReady}>
                Создать черновик
              </button>
              <p className="hint">
                Имя с расширением .yml или .yaml; путь — только внутри
                существующих папок инструмента. Черновик остаётся в памяти до
                нажатия «Сохранить».
              </p>
            </form>
          )}
          {nameError && (
            <p className="error" role="alert">
              {nameError}
            </p>
          )}
          {!entries.length && !retained ? (
            <div className="empty-file">
              <h3>У {tool} пока нет конфигурационных файлов</h3>
              <p>
                Папка .goga/tools/{tool}/ пуста. Файлы автоматически не
                создаются.
              </p>
            </div>
          ) : (
            <div className="master-detail tools-detail tool-files-detail">
              <div className="item-list tree-pane">
                <span className="eyebrow">ФАЙЛЫ · {tool}</span>
                <nav
                  className="file-tree"
                  aria-label={`Файлы инструмента ${tool}`}
                >
                  {branch()}
                </nav>
              </div>
              {file ? (
                <SettingsDocument
                  store={store}
                  source={{
                    scope: "project",
                    projectId: project.id,
                    ...(owner ? { context: contextRef(owner) } : {}),
                    target: { kind: "tool", tool, path: file },
                  }}
                  path={`.goga/tools/${tool}/${file}`}
                  title={file.split("/").pop()!}
                  description={`YAML инструмента ${tool}. Сохраняется только выбранный файл.`}
                />
              ) : (
                <div className="empty-file">
                  <h3>Выберите файл</h3>
                  <p>
                    Раскройте папку и выберите доступный YAML-файл. Остальные
                    форматы показаны с причиной недоступности.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </LoadingBoundary>
  );
}
