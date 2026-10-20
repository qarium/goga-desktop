import { LoadingBoundary } from "./LoadingBoundary";
import { isDeletableDocument } from "../shared/document-deletion";
import { DocumentDeleteConfirmation } from "./DocumentDeleteConfirmation";
import { useEffect, useSyncExternalStore } from "react";
import { YamlEditor } from "./YamlEditor";
import {
  documentKey,
  type DocumentSource,
  type SettingsDocuments,
} from "./settings-documents";
export function SettingsDocument({
  store,
  source,
  path,
  title,
  description,
}: {
  store: SettingsDocuments;
  source: DocumentSource;
  path: string;
  title: string;
  description: string;
}) {
  const pipeline =
    source.scope === "project" && source.target.kind === "pipeline";
  const workflow =
    source.scope === "project" && source.target.kind === "workflow";
  const draft = useSyncExternalStore(store.subscribe, () => store.get(source));
  const key = documentKey(source);
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
  return (
    <section className="editor-pane" aria-label={title} aria-busy={draft.busy}>
      <LoadingBoundary
        pending={draft.busy && !draft.saving && !draft.deleting}
        label="Загружаем документ…"
      >
        <div className="editor-heading">
          <div>
            <h3>{title}</h3>
            <p className="context-path">{path}</p>
          </div>
          <small className="format">{workflow ? "YAML / Jinja" : "YAML"}</small>
        </div>
        <p className="description">{description}</p>
        {draft.deletion && (
          <DocumentDeleteConfirmation
            deletion={draft.deletion}
            dirty={!!draft.document && draft.text !== draft.document.text}
            busy={!!draft.deleting}
            onCancel={() => store.cancelDeletion(source)}
            onConfirm={() => void store.delete(source, draft.deletion!)}
          />
        )}
        {!draft.document ? (
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
        ) : (
          <>
            {draft.document.exists === false && (
              <p className="hint">
                Файл отсутствует и будет создан только после нажатия
                «Сохранить».
              </p>
            )}
            <YamlEditor
              key={documentKey(source)}
              value={draft.text}
              onChange={(text) => store.edit(source, text)}
              readOnly={draft.busy}
            />
            <p className="hint">
              {workflow
                ? "Исходный YAML / Jinja сохраняется без рендеринга, подстановок и проверки структуры. Goga проверяет рабочий процесс после рендеринга в контексте профиля и конвейера. Перед записью проверяются внешние изменения файла; запись атомарная."
                : pipeline
                  ? "Исходный YAML конвейера сохраняется без рендеринга, подстановок и проверки структуры: заголовок, разделитель --- и тело остаются исходным текстом. Сохранение не гарантирует возможность запуска. Перед записью проверяются внешние изменения файла; запись атомарная."
                  : "Исходный YAML сохраняет комментарии и неизвестные поля. Перед записью проверяются структура и внешние изменения файла; запись атомарная."}
            </p>
            <div className="savebar">
              <span
                className={
                  draft.text !== draft.document.text
                    ? "draft-status"
                    : "saved-status"
                }
              >
                {draft.text !== draft.document.text
                  ? "Есть несохранённый черновик"
                  : "Нет изменений"}
              </span>
              <div className="document-save-actions">
                {deleteButton}
                <div className="document-save-primary-actions">
                  <button
                    disabled={draft.busy}
                    onClick={() => store.discard(source)}
                  >
                    Скрыть без сохранения
                  </button>
                  <button
                    className="primary"
                    disabled={draft.busy}
                    onClick={() => void store.save(source)}
                  >
                    {draft.busy ? "Сохраняем…" : "Сохранить"}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
        {draft.error && (
          <p className="error" role="alert">
            {draft.error}
          </p>
        )}
        {draft.error && !draft.document && (
          <button type="button" onClick={() => void store.open(source)}>
            Повторить загрузку
          </button>
        )}
        {draft.notice && (
          <p className="success" role="status">
            {draft.notice}
          </p>
        )}
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
