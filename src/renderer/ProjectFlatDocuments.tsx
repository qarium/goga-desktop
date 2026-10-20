import type { TopicContextRef } from "../shared/worktrees";
import { contextRef } from "./topic-context";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ProjectWorkflow } from "../shared/project-documents";
import type { Project } from "../shared/types";
import { documentScopeId, type SettingsDocuments } from "./settings-documents";
import { SettingsDocument } from "./SettingsDocument";
import { WorkflowNameInput } from "./WorkflowNameInput";

export function ProjectFlatDocuments({
  kind,
  project,
  owner,
  store,
  savedSettingsVersion,
}: {
  kind: "workflow" | "pipeline" | "profile";
  project: Project;
  owner?: TopicContextRef;
  store: SettingsDocuments;
  savedSettingsVersion?: string;
}) {
  const scope = owner ? contextRef(owner) : project.id;
  const scopeKey = documentScopeId(scope);
  const pipeline = kind === "pipeline";
  const profile = kind === "profile";
  const folder = `.goga/${kind}s`;
  const selection = profile
    ? store.projectProfileState
    : pipeline
      ? store.pipelineState
      : store.workflowState;
  const update = profile
    ? store.updateProjectProfile
    : pipeline
      ? store.updatePipeline
      : store.updateWorkflow;
  const createDraft = profile
    ? store.createProjectProfile
    : pipeline
      ? store.createPipeline
      : store.createWorkflow;
  const state = useSyncExternalStore(store.subscribe, () => selection(scope));
  const revision = useSyncExternalStore(store.subscribe, () =>
    store.projectRevision(scope),
  );
  const [catalog, setCatalog] = useState<ProjectWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const loadKey = JSON.stringify([scopeKey, kind, revision, attempt]);
  const [settled, setSettled] = useState("");
  const read = useReadScope(
    JSON.stringify([scopeKey, kind, revision, attempt]),
  );
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    (profile
      ? read("listProjectProfiles", scope)
      : pipeline
        ? read("listProjectPipelines", scope)
        : read("listProjectWorkflows", scope)
    ).then(
      (items) => {
        if (!current) return;
        setCatalog(items);
        setLoading(false);
        setSettled(loadKey);
      },
      (e) => {
        if (!current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
        setSettled(loadKey);
      },
    );
    return () => {
      current = false;
    };
  }, [scopeKey, kind, revision, attempt]);
  const files: ProjectWorkflow[] = [
    ...catalog,
    ...state.drafts
      .filter(
        (name) =>
          !catalog.some((item) => item.path === `${folder}/${name}.yml`),
      )
      .map((name) => ({
        name,
        path: `${folder}/${name}.yml`,
        editable: true,
      })),
  ];
  const selectedPath = state.selected ? `${folder}/${state.selected}.yml` : "";
  const selected = files.find((item) => item.path === selectedPath);
  // Retain the selected source while a catalog refresh is pending or fails.
  const selectedEntry = state.selected
    ? store.get({
        scope: "project",
        projectId: project.id,
        ...(owner ? { context: contextRef(owner) } : {}),
        target: { kind, name: state.selected },
      })
    : undefined;
  const selectedDraft = selectedEntry?.document || selectedEntry?.error;
  const hasDocuments = files.length > 0 || !!selectedDraft;
  function hasLoadedDraft(file: ProjectWorkflow) {
    // An unsupported sibling may share the catalog name, but not this source.
    return (
      file.path === `${folder}/${file.name}.yml` &&
      !!store.get({
        scope: "project",
        projectId: project.id,
        ...(owner ? { context: contextRef(owner) } : {}),
        target: { kind, name: file.name },
      }).document
    );
  }
  function create() {
    if (loading || error) return;
    try {
      createDraft(scope, state.name, catalog);
      setNameError("");
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <LoadingBoundary
      pending={loading || settled !== loadKey}
      label="Загружаем каталог проекта…"
    >
      <div className="tool-controls workflow-controls">
        <button
          type="button"
          onClick={() => {
            update(scope, { creating: true });
            setNameError("");
          }}
        >
          {profile
            ? "Создать профиль"
            : pipeline
              ? "Создать конвейер"
              : "Создать рабочий процесс"}
        </button>
        <small className="tool-root">{folder}/</small>
      </div>
      {profile && (
        <p className="description">
          Проектный профиль имеет приоритет перед одноимённым глобальным
          (личным). Даже некорректный проектный файл не заменяется глобальным
          автоматически. Глобальные профили остаются в общих настройках; новый
          профиль не назначается по умолчанию.
        </p>
      )}
      {state.creating && (
        <form
          className={`new-profile${pipeline || profile ? "" : " workflow-name-form"}`}
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          {pipeline || profile ? (
            <label>
              {profile ? "Имя профиля" : "Имя конвейера"}
              <input
                value={state.name}
                onChange={(e) => {
                  update(scope, { name: e.target.value });
                  setNameError("");
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : (
            <WorkflowNameInput
              projectId={project.id}
              owner={owner}
              savedSettingsVersion={savedSettingsVersion}
              projectRevision={revision}
              files={catalog}
              drafts={state.drafts}
              value={state.name}
              onChange={(name) => {
                update(scope, { name });
                setNameError("");
              }}
            />
          )}
          <button type="submit" disabled={loading || !!error}>
            Создать черновик
          </button>
          <p className="hint">
            Имя без расширения .yml. Черновик остаётся в памяти до нажатия
            «Сохранить».
          </p>
        </form>
      )}
      {nameError && (
        <p className="error" role="alert">
          {nameError}
        </p>
      )}
      {error && (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <button onClick={() => setAttempt((value) => value + 1)}>
            Повторить загрузку
          </button>
        </div>
      )}
      {!loading && !error && !hasDocuments && (
        <div className="empty-file">
          <h3>
            {profile
              ? "В проекте пока нет профилей"
              : pipeline
                ? "В проекте пока нет конвейеров"
                : "В проекте пока нет рабочих процессов"}
          </h3>
          <p>
            Папка {folder} может отсутствовать. Файлы и папки создаются только
            при сохранении.
          </p>
        </div>
      )}
      {hasDocuments && (
        <div className="master-detail tools-detail">
          <div className="item-list tree-pane">
            <span className="eyebrow">
              {profile
                ? "ПРОФИЛИ"
                : pipeline
                  ? "КОНВЕЙЕРЫ"
                  : "РАБОЧИЕ ПРОЦЕССЫ"}
            </span>
            <nav
              className="file-tree"
              aria-label={
                profile
                  ? "Профили проекта"
                  : pipeline
                    ? "Конвейеры проекта"
                    : "Рабочие процессы проекта"
              }
            >
              <ul>
                {files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`file-row ${selectedPath === file.path ? "selected" : ""}`}
                      aria-label={`Файл ${file.path}`}
                      aria-pressed={selectedPath === file.path}
                      disabled={!file.editable && !hasLoadedDraft(file)}
                      title={file.reason}
                      onClick={() => update(scope, { selected: file.name })}
                    >
                      <span className="file-mark" aria-hidden="true" />
                      <span>
                        {file.path.split("/").pop()}
                        {!file.editable && (
                          <small>
                            {file.reason ??
                              "Файл недоступен для редактирования"}
                          </small>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          {state.selected && (selected?.editable || selectedDraft) ? (
            <SettingsDocument
              store={store}
              source={{
                scope: "project",
                projectId: project.id,
                ...(owner ? { context: contextRef(owner) } : {}),
                target: { kind, name: state.selected },
              }}
              path={`${folder}/${state.selected}.yml`}
              title={`${state.selected}.yml`}
              description={`${selected && !selected.editable ? `Черновик сохранён в памяти. ${selected.reason ?? "Файл недоступен для редактирования"}. Сохранение по-прежнему проверяется на стороне приложения. ` : ""}Исходный ${profile ? "профиль" : pipeline ? "конвейер" : "рабочий процесс"} проекта. Сохраняется только выбранный файл. ${profile ? "При сохранении проверяется YAML mapping; исходный текст не форматируется." : "Проверки Goga выполняются при подготовке запуска."}`}
            />
          ) : (
            <div className="empty-file">
              <h3>
                {profile
                  ? "Выберите профиль"
                  : pipeline
                    ? "Выберите конвейер"
                    : "Выберите рабочий процесс"}
              </h3>
              <p>Выберите существующий файл или создайте пустой черновик.</p>
            </div>
          )}
        </div>
      )}
    </LoadingBoundary>
  );
}
