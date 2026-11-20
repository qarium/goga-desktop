import { HintButton } from "./ActionHint";
import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useViewActive } from "./RetainedViews";
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
  useLocale();
  const viewActive = useViewActive();
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
  // A refreshed catalog may update in place, but never reuse another owner or kind.
  const identity = JSON.stringify([scopeKey, kind]);
  const [catalogState, setCatalog] = useState<{
    revision: number;
    loadKey: string;
    identity: string;
    items: ProjectWorkflow[];
    removalRevision: number;
  }>();
  const catalogLoaded = catalogState?.identity === identity;
  const catalog = !catalogLoaded
    ? []
    : catalogState.revision === revision
      ? catalogState.items
      : catalogState.items.filter(
          (file) =>
            file.path !== `${folder}/${file.name}.yml` ||
            !store.wasRemovedSince(
              {
                scope: "project",
                projectId: project.id,
                ...(owner ? { context: contextRef(owner) } : {}),
                target: { kind, name: file.name },
              },
              catalogState.removalRevision,
            ),
        );
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
    if (!viewActive) return;
    let current = true;
    const removalRevision = store.removalRevision();
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
        setCatalog({ loadKey, revision, identity, items, removalRevision });
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
  }, [scopeKey, kind, revision, attempt, viewActive]);
  const refreshing = loading || settled !== loadKey;
  const postSaveRefresh =
    viewActive &&
    refreshing &&
    !error &&
    catalogLoaded &&
    catalogState.loadKey === settled &&
    store.onlyDocumentSavesSince(scope, catalogState.revision);
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
    if (refreshing || error) return;
    try {
      createDraft(scope, state.name, catalog);
      setNameError("");
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <LoadingBoundary
      pending={refreshing && !catalogLoaded}
      label={msg("project.loadingProjectCatalog")}
    >
      <div className="tool-controls workflow-controls">
        <button
          type="button"
          data-post-save-refresh={postSaveRefresh || undefined}
          disabled={refreshing || !!error}
          onClick={() => {
            if (refreshing || error) return;
            update(scope, { creating: true });
            setNameError("");
          }}
        >
          {profile
            ? msg("project.createProfile")
            : pipeline
              ? msg("project.createPipeline")
              : msg("project.createWorkflow")}
        </button>
        <small className="tool-root">{folder}/</small>
      </div>
      {profile && (
        <p className="description">{msg("project.aProjectProfileTakesPrecedenceOverAGlobalPersonalProfile")}</p>
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
              {profile ? msg("project.profileName") : msg("project.pipelineName")}
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
          <button
            type="submit"
            data-post-save-refresh={postSaveRefresh || undefined}
            disabled={refreshing || !!error}
          >{msg("project.createDraft")}</button>
          <p className="hint">{msg("project.enterTheNameWithoutTheYmlExtensionTheDraftStays")}</p>
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
          <button onClick={() => setAttempt((value) => value + 1)}>{msg("project.retryLoading")}</button>
        </div>
      )}
      {catalogLoaded && !error && !hasDocuments && (
        <div className="empty-file">
          <h3>
            {profile
              ? msg("project.noProfilesInThisProjectYet")
              : pipeline
                ? msg("project.noPipelinesInThisProjectYet")
                : msg("project.noWorkflowsInThisProjectYet")}
          </h3>
          <p>{msg("project.catalogFolderMayNotExist", { folder })}</p>
        </div>
      )}
      {hasDocuments && (
        <div className="master-detail tools-detail">
          <div className="item-list tree-pane">
            <span className="eyebrow">
              {profile
                ? msg("project.profiles2")
                : pipeline
                  ? msg("project.pipelines2")
                  : msg("project.workflows2")}
            </span>
            <nav
              className="file-tree"
              aria-label={
                profile
                  ? msg("project.projectProfiles")
                  : pipeline
                    ? msg("project.projectPipelines")
                    : msg("project.projectWorkflows")
              }
            >
              <ul>
                {files.map((file) => (
                  <li key={file.path}>
                    <HintButton
                      type="button"
                      className={`file-row ${selectedPath === file.path ? "selected" : ""}`}
                      aria-label={msg("project.file2", { path: String(file.path) })}
                      aria-pressed={selectedPath === file.path}
                      disabled={!file.editable && !hasLoadedDraft(file)}
                      hint={file.reason}
                      onClick={() => update(scope, { selected: file.name })}
                    >
                      <span className="file-mark" aria-hidden="true" />
                      <span>
                        {file.path.split("/").pop()}
                        {!file.editable && (
                          <small>
                            {file.reason ??
                              msg("project.thisFileCannotBeEdited2")}
                          </small>
                        )}
                      </span>
                    </HintButton>
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
              description={msg("project.projectSourceOnlyTheSelectedFileIsSaved", { value1: String(selected && !selected.editable ? msg("project.theDraftIsKeptInMemoryTheApplicationStillValidates", { value1: String(selected.reason ?? msg("project.thisFileCannotBeEdited2")) }) : ""), value2: String(profile ? msg("project.profile") : pipeline ? msg("project.pipeline") : msg("project.workflow")), value3: String(profile ? msg("project.savingChecksTheYAMLMappingWithoutReformattingTheSource") : msg("project.gogaValidatesThisWhenPreparingARun")) })}
            />
          ) : (
            <div className="empty-file">
              <h3>
                {profile
                  ? msg("project.chooseAProfile")
                  : pipeline
                    ? msg("project.chooseAPipeline")
                    : msg("project.chooseAWorkflow")}
              </h3>
              <p>{msg("project.selectAnExistingFileOrCreateAnEmptyDraft")}</p>
            </div>
          )}
        </div>
      )}
    </LoadingBoundary>
  );
}
