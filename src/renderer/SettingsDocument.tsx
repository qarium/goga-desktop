import { HintButton } from "./ActionHint";
import { t } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { DocumentRenameDialog } from "./DocumentRenameDialog";
import { Maximize2, Minimize2, RefreshCw, Pencil } from "lucide-react";
import { useProjectDocumentExpansion } from "./useProjectDocumentExpansion";
import { ProjectDocumentStatus } from "./ProjectDocumentStatus";
import { useDocumentSaveStatus } from "./useDocumentSaveStatus";
import "./ProjectDocumentExpansion.css";
import "./WorkspaceTabs.css";
import { useViewActive } from "./RetainedViews";
import { useSettingsEditorViewport } from "./useSettingsEditorViewport";
import { LoadingBoundary } from "./LoadingBoundary";
import { isDeletableDocument } from "../shared/document-deletion";
import { ReloadConfirmation } from "./TaskReloadConfirmation";
import { DocumentDeleteConfirmation } from "./DocumentDeleteConfirmation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { YamlEditor } from "./YamlEditor";
import {
  documentKey,
  type DocumentSource,
  type DocumentDraft,
  type SettingsDocuments,
} from "./settings-documents";

export function SettingsDocument({
  store,
  source,
  path,
  title,
  description,
  saveDisabled = false,
  postSaveRefresh = false,
}: {
  store: SettingsDocuments;
  source: DocumentSource;
  path: string;
  title: string;
  description: string;
  saveDisabled?: boolean;
  postSaveRefresh?: boolean;
}) {
  useLocale();
  const dockerfile =
    source.scope === "project" && source.target.kind === "dockerfile";
  const pipeline =
    source.scope === "project" && source.target.kind === "pipeline";
  const workflow =
    source.scope === "project" && source.target.kind === "workflow";
  const saveHelp = dockerfile
    ? t("general.theDockerfileIsSavedAsSourceTextDesktopChecks")
    : workflow
      ? t("general.yamlJinjaIsSavedAsWrittenWithoutRenderingSubstitution")
      : pipeline
        ? t("general.pipelineYamlIsSavedAsWrittenIncludingTheHeader")
        : t("general.theSourceYamlRetainsCommentsAndUnrecognizedFieldsDesktop");
  const format = (
    <small
      className="format"
      title={source.scope === "project" ? saveHelp : undefined}
    >
      {dockerfile ? "Dockerfile" : workflow ? "YAML / Jinja" : "YAML"}
    </small>
  );
  const draft = useSyncExternalStore(store.subscribe, () => store.get(source));
  const key = documentKey(source);
  const active = useViewActive();
  const project = source.scope === "project";
  const dirty = !!draft.document && draft.text !== draft.document.text;
  const [reloadConsent, setReloadConsent] = useState<DocumentDraft | null>(
    null,
  );
  useEffect(() => {
    setReloadConsent(null);
  }, [key, active]);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  useEffect(() => {
    setRenameKey(null);
  }, [key, active]);
  const renamable =
    source.scope === "project" &&
    isDeletableDocument(source) &&
    draft.document?.exists &&
    !draft.memoryOnly;
  const status = useDocumentSaveStatus(draft, project && active, key);
  // One automatic attempt per selected source. Busy/error updates and retained
  // view activation must not retry a failed read or reopen a deleted selection.
  const reveal = useRef({
    store,
    key,
    revision: store.removalRevision(),
    attempted: false,
  });
  if (reveal.current.store !== store || reveal.current.key !== key)
    reveal.current = {
      store,
      key,
      revision: store.removalRevision(),
      attempted: false,
    };
  useEffect(() => {
    if (!active || source.scope !== "project" || reveal.current.attempted)
      return;
    reveal.current.attempted = true;
    if (
      draft.document ||
      draft.busy ||
      draft.error ||
      store.wasRemovedSince(source, reveal.current.revision)
    )
      return;
    void store.open(source);
  }, [store, key, active]);
  const editorKey = store.editorIdentity(source);
  const pane = useRef<HTMLElement>(null);
  const expansion = useProjectDocumentExpansion(
    pane,
    active && source.scope === "project" && draft.document ? editorKey : null,
  );
  const editorHeight = useSettingsEditorViewport(
    pane,
    !expansion.expanded &&
      !!draft.document &&
      (!draft.busy || !!draft.saving || !!draft.deleting || !!draft.reloading || !!draft.renaming),
    key,
  );
  useEffect(() => () => store.cancelDeletion(source), [store, key]);
  const deleteButton = isDeletableDocument(source) ? (
    <button
      className="danger"
      type="button"
      disabled={draft.busy || !!draft.deletion}
      onClick={() => void store.prepareDeletion(source)}
    >
      {draft.memoryOnly ? t("general.deleteDraft") : t("general.delete")}
    </button>
  ) : null;
  const feedback = (
    <>
      {(draft.error || draft.reloadError) && (
        <p className="error" role="alert">
          {draft.reloadError || draft.error}
        </p>
      )}
      {draft.error && !draft.document && (
        <button type="button" onClick={() => void store.open(source)}>{t("general.retryLoading")}</button>
      )}
      {project && status.tone === "warning" && status.detail && (
        <p className="hint document-save-warning">{status.detail}</p>
      )}
      {draft.notice && !project && (
        <p className="success" role="status">
          {draft.notice}
        </p>
      )}
    </>
  );
  return (
    <section
      ref={pane}
      className={[
        "editor-pane",
        project ? "project-document-pane" : "",
        expansion.expanded ? "project-document-expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={title}
      aria-busy={draft.busy}
      style={
        editorHeight === undefined
          ? undefined
          : ({
              "--settings-editor-height": `${editorHeight}px`,
              "--settings-editor-min-height": "0px",
            } as CSSProperties)
      }
    >
      <LoadingBoundary
        pending={
          draft.busy &&
          !draft.saving &&
          !draft.deleting &&
          !draft.reloading &&
          !draft.renaming
        }
        label={t("general.loadingDocument")}
      >
        <div
          className={
            project
              ? "editor-heading project-document-heading"
              : "editor-heading"
          }
        >
          <div className="document-heading-details">
            <h3>{title}</h3>
            <p className="context-path" title={path}>
              {path}
            </p>
          </div>
          {project ? (
            <div className="document-heading-tools">
              {active && draft.document && (
                <ProjectDocumentStatus
                  status={status}
                  expanded={expansion.expanded}
                />
              )}
              {format}
              {renamable && (
                <HintButton
                  type="button"
                  className="document-heading-icon"
                  aria-label={t("general.renameFile")}
                  hint={t("general.renameFile")}
                  disabled={draft.busy || !!draft.deletion}
                  onClick={() => setRenameKey(key)}
                >
                  <Pencil size={16} aria-hidden />
                </HintButton>
              )}
              {draft.document && !draft.memoryOnly && (
                <HintButton
                  type="button"
                  className="document-heading-icon"
                  aria-label={t("general.reloadFromDisk")}
                  aria-busy={!!draft.reloading}
                  hint={
                    draft.reloading
                      ? t("general.readingFileFromDisk")
                      : t("general.reloadFromDisk")
                  }
                  disabled={draft.busy || !!draft.deletion}
                  onClick={() =>
                    dirty ? setReloadConsent(draft) : void store.reload(source)
                  }
                >
                  <RefreshCw size={16} aria-hidden />
                </HintButton>
              )}
              <HintButton
                type="button"
                className="document-size-toggle document-heading-icon"
                disabled={!draft.document}
                style={{ visibility: draft.document ? undefined : "hidden" }}
                aria-expanded={expansion.expanded}
                aria-label={
                  expansion.expanded
                    ? t("general.collapseDocument")
                    : t("general.expandDocument")
                }
                hint={
                  expansion.expanded
                    ? t("general.collapseDocumentEsc")
                    : t("general.expandToWorkspace")
                }
                onClick={expansion.toggle}
              >
                {expansion.expanded ? (
                  <Minimize2 size={16} aria-hidden />
                ) : (
                  <Maximize2 size={16} aria-hidden />
                )}
              </HintButton>
            </div>
          ) : (
            format
          )}
        </div>
        <p className="description">{description}</p>
        {active && renamable && renameKey === key && (
          <DocumentRenameDialog
            key={key}
            original={
              source.target.kind === "tool"
                ? source.target.path.split("/").pop()!
                : source.target.name
            }
            suffix={source.target.kind === "tool" ? "" : ".yml"}
            rename={(name) => store.rename(source, name)}
            onClose={() =>
              setRenameKey((current) => (current === key ? null : current))
            }
          />
        )}
        {active && reloadConsent === draft && (
          <ReloadConfirmation
            destructive
            title={t("general.reloadFileFromDisk")}
            description={t("general.unsavedEditsInWillBeReplacedByTheVersion", { path })}
            confirmLabel={t("general.loadFromDisk")}
            onCancel={() => setReloadConsent(null)}
            onConfirm={() => {
              setReloadConsent(null);
              void store.reload(source, draft);
            }}
          />
        )}
        {draft.deletion && (
          <DocumentDeleteConfirmation
            deletion={draft.deletion}
            dirty={dirty}
            busy={!!draft.deleting}
            onCancel={() => store.cancelDeletion(source)}
            onConfirm={() => void store.delete(source, draft.deletion!)}
          />
        )}
        {!draft.document ? (
          source.scope === "home" ? (
            <div className="privacy-note">
              <h3>{t("general.contentsAreHidden")}</h3>
              <p className="hint">{t("general.thisFileMayContainSecretEnvironmentVariablesOpenThe")}</p>
              <div className="document-reveal-actions">
                <button
                  disabled={draft.busy}
                  onClick={() => void store.open(source)}
                >
                  {draft.busy ? t("general.reading") : t("general.openEditor")}
                </button>
                {deleteButton}
              </div>
            </div>
          ) : null
        ) : (
          <>
            {!project && draft.document.exists === false && (
              <p className="hint">{t("general.thisFileDoesNotExistYetChooseSaveTo")}</p>
            )}
            <YamlEditor
              key={editorKey}
              language={dockerfile ? "dockerfile" : "yaml"}
              label={dockerfile ? "Dockerfile" : "YAML"}
              value={draft.text}
              onChange={(text) => store.edit(source, text)}
              readOnly={draft.busy && !draft.reloading}
              onView={(view) => {
                expansion.editor.current = view;
              }}
            />
            <div className="document-editor-footer">
              {!project && <p className="hint">{saveHelp}</p>}
              <div className="savebar">
                {!project && (
                  <span className={dirty ? "draft-status" : "saved-status"}>
                    {dirty ? t("general.unsavedDraft") : t("general.noChanges")}
                  </span>
                )}
                <div className="document-save-actions">
                  {deleteButton}
                  <div className="document-save-primary-actions">
                    <button
                      disabled={draft.busy}
                      onClick={() =>
                        source.scope === "project"
                          ? store.reset(source)
                          : store.discard(source)
                      }
                    >
                      {source.scope === "project"
                        ? t("general.discardChanges")
                        : t("general.hideWithoutSaving")}
                    </button>
                    <button
                      className="primary"
                      data-post-save-refresh={
                        (postSaveRefresh && !draft.busy) || undefined
                      }
                      disabled={draft.busy || saveDisabled}
                      onClick={() => void store.save(source)}
                    >
                      {!project && draft.busy ? t("general.saving") : t("general.save")}
                    </button>
                  </div>
                </div>
              </div>
              {feedback}
            </div>
          </>
        )}
        {!draft.document && feedback}
      </LoadingBoundary>
    </section>
  );
}
export function SettingsTabs({
  label,
  tabs,
  current,
  onChange,
  disabled = false,
  workspace = false,
}: {
  label: string;
  tabs: readonly (readonly [string, string])[];
  current: string;
  onChange: (tab: string) => void;
  disabled?: boolean;
  workspace?: boolean;
}) {
  return (
    <nav data-settings-tabs="" className={workspace ? "workspace-section-tabs" : "section-tabs"} aria-label={label}>
      {tabs.map(([id, title]) => {
        const selected = current === id;
        const button = (
          <button
            key={id}
            type="button"
            disabled={disabled}
            aria-current={selected ? "page" : undefined}
            className={workspace ? "workspace-tab-select" : selected ? "selected" : ""}
            onClick={() => onChange(id)}
          >
            {title}
          </button>
        );
        return workspace ? (
          <span key={id} className="workspace-tab" data-selected={selected}>{button}</span>
        ) : button;
      })}
    </nav>
  );
}
