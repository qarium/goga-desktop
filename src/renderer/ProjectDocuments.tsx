import { ProjectDockerfile } from "./ProjectDockerfile";
import type { TopicContextRef } from "../shared/worktrees";
import { contextRef } from "./topic-context";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
}: {
  project: Project;
  owner?: TopicContextRef;
  tab: string;
  store: SettingsDocuments;
  savedSettingsVersion?: string;
}) {
  const scope = owner ? contextRef(owner) : project.id;
  const scopeKey = documentScopeId(scope);
  const [tools, setTools] = useState<ProjectTool[]>([]),
    [tool, setTool] = useState(""),
    [files, setFiles] = useState<Record<string, string>>({}),
    [expanded, setExpanded] = useState<Record<string, boolean>>({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  const revision = useSyncExternalStore(store.subscribe, () =>
    store.projectRevision(scope),
  );
  const removals = useSyncExternalStore(store.subscribe, store.removalRevision);
  const seenRemovals = useRef(removals);
  useEffect(() => {
    const since = seenRemovals.current;
    seenRemovals.current = removals;
    setFiles((previous) => {
      const retained = Object.entries(previous).filter(([key, path]) => {
        const [projectId, tool] = JSON.parse(key) as [string, string];
        return !store.wasRemovedSince(
          {
            scope: "project",
            projectId,
            ...(owner ? { context: contextRef(owner) } : {}),
            target: { kind: "tool", tool, path },
          },
          since,
        );
      });
      return retained.length === Object.keys(previous).length
        ? previous
        : Object.fromEntries(retained);
    });
  }, [store, removals]);
  const loadKey = JSON.stringify([scopeKey, tab, attempt, revision]);
  const [settled, setSettled] = useState("");
  const read = useReadScope(JSON.stringify([scopeKey, tab, attempt, revision]));
  useEffect(() => {
    if (tab !== "tools") return;
    let current = true;
    setLoading(true);
    setError("");
    read("listProjectTools", scope).then(
      (items) => {
        if (!current) return;
        setTools(items);
        setTool((value) => value || items[0]?.name || "");
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
  }, [scopeKey, tab, attempt, revision]);
  if (tab === "launch") return null;
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
    file = files[JSON.stringify([scopeKey, tool])] ?? "";
  // A selected source is retained even if an uncertain trash attempt removes it
  // from discovery. Catalog loading/errors must never remount its editor.
  const retained = !!file;
  function branch(prefix = "") {
    const entries =
      selected?.entries.filter(
        (entry) =>
          entry.path.slice(0, entry.path.lastIndexOf("/") + 1) === prefix,
      ) ?? [];
    return <ul>{entries.map((entry) => row(entry))}</ul>;
  }
  function row(entry: ProjectToolEntry) {
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
              disabled={!!entry.reason}
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
            {open && <div>{branch(`${entry.path}/`)}</div>}
          </>
        ) : (
          <button
            type="button"
            className={`file-row ${file === entry.path ? "selected" : ""}`}
            aria-label={`Файл ${entry.path}`}
            aria-pressed={file === entry.path}
            disabled={!entry.editable}
            title={entry.reason}
            onClick={() =>
              setFiles((value) => ({
                ...value,
                [JSON.stringify([scopeKey, tool])]: entry.path,
              }))
            }
          >
            <span className="file-mark" aria-hidden="true" />
            <span>
              {name}
              {!entry.editable && (
                <small>
                  {entry.reason ?? "Этот файл недоступен для редактирования"}
                </small>
              )}
            </span>
          </button>
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
              <select value={tool} onChange={(e) => setTool(e.target.value)}>
                {tool && !tools.some((item) => item.name === tool) && (
                  <option value={tool}>{tool}</option>
                )}
                {tools.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <small className="tool-root">.goga/tools/{tool}/</small>
          </div>
          <p className="description tools-description">
            Файлы выбранного инструмента в проекте {project.name}.
          </p>
          {!selected?.entries.length && !retained ? (
            <div className="empty-file">
              <h3>У {tool} пока нет конфигурационных файлов</h3>
              <p>
                Папка .goga/tools/{tool}/ пуста. Файлы автоматически не
                создаются.
              </p>
            </div>
          ) : (
            <div className="master-detail tools-detail">
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
