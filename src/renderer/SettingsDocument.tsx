import { DocumentRenameDialog } from "./DocumentRenameDialog";
import { Maximize2, Minimize2, RefreshCw, Pencil } from "lucide-react";
import { useProjectDocumentExpansion } from "./useProjectDocumentExpansion";
import { ProjectDocumentStatus } from "./ProjectDocumentStatus";
import { useDocumentSaveStatus } from "./useDocumentSaveStatus";
import "./ProjectDocumentExpansion.css";
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
const missingFileHint =
  "Файл отсутствует и будет создан только после нажатия «Сохранить».";

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
  const dockerfile =
    source.scope === "project" && source.target.kind === "dockerfile";
  const pipeline =
    source.scope === "project" && source.target.kind === "pipeline";
  const workflow =
    source.scope === "project" && source.target.kind === "workflow";
  const saveHelp = dockerfile
    ? "Dockerfile сохраняется как исходный текст без проверки YAML и преобразований. Перед атомарной записью проверяются файл и конфигурация."
    : workflow
      ? "Исходный YAML / Jinja сохраняется без рендеринга, подстановок и проверки структуры. Goga проверяет рабочий процесс после рендеринга в контексте профиля и конвейера. Перед записью проверяются внешние изменения файла; запись атомарная."
      : pipeline
        ? "Исходный YAML конвейера сохраняется без рендеринга, подстановок и проверки структуры: заголовок, разделитель --- и тело остаются исходным текстом. Сохранение не гарантирует возможность запуска. Перед записью проверяются внешние изменения файла; запись атомарная."
        : "Исходный YAML сохраняет комментарии и неизвестные поля. Перед записью проверяются структура и внешние изменения файла; запись атомарная.";
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
      {draft.memoryOnly ? "Удалить черновик" : "Удалить"}
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
        <button type="button" onClick={() => void store.open(source)}>
          Повторить загрузку
        </button>
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
        label="Загружаем документ…"
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
                <button
                  type="button"
                  className="document-heading-icon"
                  aria-label="Переименовать файл"
                  title="Переименовать файл"
                  disabled={draft.busy || !!draft.deletion}
                  onClick={() => setRenameKey(key)}
                >
                  <Pencil size={16} aria-hidden />
                </button>
              )}
              {draft.document && !draft.memoryOnly && (
                <button
                  type="button"
                  className="document-heading-icon"
                  aria-label="Обновить с диска"
                  aria-busy={!!draft.reloading}
                  title={
                    draft.reloading
                      ? "Читаем файл с диска…"
                      : "Обновить с диска"
                  }
                  disabled={draft.busy || !!draft.deletion}
                  onClick={() =>
                    dirty ? setReloadConsent(draft) : void store.reload(source)
                  }
                >
                  <RefreshCw size={16} aria-hidden />
                </button>
              )}
              <button
                type="button"
                className="document-size-toggle document-heading-icon"
                disabled={!draft.document}
                style={{ visibility: draft.document ? undefined : "hidden" }}
                aria-expanded={expansion.expanded}
                aria-label={
                  expansion.expanded
                    ? "Свернуть документ"
                    : "Развернуть документ"
                }
                title={
                  expansion.expanded
                    ? "Свернуть документ (Esc)"
                    : "Развернуть на рабочую область"
                }
                onClick={expansion.toggle}
              >
                {expansion.expanded ? (
                  <Minimize2 size={16} aria-hidden />
                ) : (
                  <Maximize2 size={16} aria-hidden />
                )}
              </button>
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
            title="Обновить файл с диска?"
            description={`Несохранённые изменения в «${path}» будут заменены версией с диска. Если файл не удастся прочитать, черновик останется в редакторе.`}
            confirmLabel="Загрузить с диска"
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
              <h3>Содержимое пока скрыто</h3>
              <p className="hint">
                Файл может содержать секретные переменные окружения. Открывайте
                редактор только там, где экран не виден посторонним. Значения не
                отправляются в телеметрию.
              </p>
              <div className="document-reveal-actions">
                <button
                  disabled={draft.busy}
                  onClick={() => void store.open(source)}
                >
                  {draft.busy ? "Читаем…" : "Открыть редактор"}
                </button>
                {deleteButton}
              </div>
            </div>
          ) : null
        ) : (
          <>
            {!project && draft.document.exists === false && (
              <p className="hint">{missingFileHint}</p>
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
                    {dirty ? "Есть несохранённый черновик" : "Нет изменений"}
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
                        ? "Отменить изменения"
                        : "Скрыть без сохранения"}
                    </button>
                    <button
                      className="primary"
                      data-post-save-refresh={
                        (postSaveRefresh && !draft.busy) || undefined
                      }
                      disabled={draft.busy || saveDisabled}
                      onClick={() => void store.save(source)}
                    >
                      {!project && draft.busy ? "Сохраняем…" : "Сохранить"}
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
}: {
  label: string;
  tabs: readonly (readonly [string, string])[];
  current: string;
  onChange: (tab: string) => void;
  disabled?: boolean;
}) {
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map(([id, title]) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          aria-current={current === id ? "page" : undefined}
          className={current === id ? "selected" : ""}
          onClick={() => onChange(id)}
        >
          {title}
        </button>
      ))}
    </nav>
  );
}
