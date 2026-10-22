import type { TopicContextRef } from "../shared/worktrees";
import { contextRef } from "./topic-context";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Project, ProjectSettings as Value } from "../shared/types";
import "../shared/bridge";
import {
  DEFAULT_STARTUP_TIMEOUT_MINUTES,
  MIN_STARTUP_TIMEOUT_MINUTES,
  MAX_STARTUP_TIMEOUT_MINUTES,
  isStartupTimeoutMinutes,
} from "../shared/startup-timeout";
import { SettingsTabs } from "./SettingsDocument";
import { ProjectDocuments } from "./ProjectDocuments";
import {
  createSettingsDocuments,
  documentScopeId,
  type RegistrySettingsDraft,
  type SettingsDocuments,
} from "./settings-documents";
import {
  assertEnvironmentTransport,
  assertEnvironmentValue,
} from "../shared/environment-transport";

export function EnvironmentValueInput({
  value,
  secret,
  label,
  onValue,
  onInvalid,
}: {
  value: string;
  secret: boolean;
  label: string;
  onValue: (value: string) => void;
  onInvalid: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const rejectedNativeInput = useRef(false);
  function valid(next: string) {
    try {
      assertEnvironmentValue(next);
      return true;
    } catch (e) {
      onInvalid(
        `${e instanceof Error ? e.message : "Недопустимое значение."} Ввод отклонён. Исправьте значение или удалите переменную.`,
      );
      return false;
    }
  }
  function replacement(text: string) {
    const element = input.current!;
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? start;
    return {
      next: value.slice(0, start) + text + value.slice(end),
      caret: start + text.length,
    };
  }
  function insert(text: string) {
    rejectedNativeInput.current = false;
    const next = replacement(text);
    if (!valid(text) || !valid(next.next)) return;
    caret.current = next.caret;
    onValue(next.next);
  }
  // React's synthetic onBeforeInput does not cover every native InputEvent.
  useEffect(() => {
    const element = input.current!;
    function beforeInput(event: InputEvent) {
      rejectedNativeInput.current = false;
      const text =
        event.data ??
        event.dataTransfer?.getData("text/plain") ??
        (["insertLineBreak", "insertParagraph"].includes(event.inputType)
          ? "\n"
          : null);
      if (text !== null && (!valid(text) || !valid(replacement(text).next))) {
        event.preventDefault();
        // Some replacement/composition events cannot be canceled. Their next
        // input must restore the controlled draft, never accept sanitized data.
        rejectedNativeInput.current = !event.cancelable;
      }
    }
    element.addEventListener("beforeinput", beforeInput);
    return () => element.removeEventListener("beforeinput", beforeInput);
  });
  useLayoutEffect(() => {
    if (caret.current !== null) {
      input.current?.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });
  return (
    <input
      ref={input}
      aria-label={label}
      type={secret ? "password" : "text"}
      autoComplete="off"
      spellCheck={false}
      value={value}
      onPaste={(event) => {
        event.preventDefault();
        insert(event.clipboardData.getData("text/plain"));
      }}
      onDrop={(event) => {
        event.preventDefault();
        insert(event.dataTransfer.getData("text/plain"));
      }}
      onChange={(event) => {
        if (rejectedNativeInput.current) {
          rejectedNativeInput.current = false;
          event.target.value = value;
          return;
        }
        if (valid(event.target.value)) onValue(event.target.value);
        else event.target.value = value;
      }}
    />
  );
}

export interface ProjectSettingsGuard {
  dirty: boolean;
  busy: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}
export function ProjectSettings({
  project,
  owner,
  onBack,
  onSaved,
  guard,
  onBusy,
  documents,
  embedded = false,
}: {
  owner?: TopicContextRef;
  embedded?: boolean;
  documents?: SettingsDocuments;
  project: Project;
  onBack: () => void;
  onSaved: (version: string) => void;
  guard: MutableRefObject<ProjectSettingsGuard | null>;
  onBusy: (busy: boolean) => void;
}) {
  const scope = owner ? contextRef(owner) : project.id;
  const scopeKey = documentScopeId(scope);
  const [ownDocuments] = useState(createSettingsDocuments);
  const documentStore = documents ?? ownDocuments;
  const documentsBusy = useSyncExternalStore(
    documentStore.subscribe,
    documentStore.busy,
  );
  const [tab, setTab] = useState("launch");
  const projectDocumentRevision = useSyncExternalStore(
    documentStore.subscribe,
    () => documentStore.projectRevision(scope),
  );
  const homeDocumentRevision = useSyncExternalStore(
    documentStore.subscribe,
    documentStore.homeRevision,
  );
  const catalogKey = JSON.stringify([
    scopeKey,
    projectDocumentRevision,
    homeDocumentRevision,
  ]);
  const appliedCatalogKey = useRef(catalogKey);
  const [profileCatalogError, setProfileCatalogError] = useState("");
  const [profileCatalogAttempt, setProfileCatalogAttempt] = useState(0);
  const registryDraft = useSyncExternalStore(documentStore.subscribe, () =>
    documentStore.registryDraft(scope),
  );
  const { doc, value, timeoutDraft, error, inputErrors, notice, saving } =
    registryDraft;
  function setter<K extends keyof RegistrySettingsDraft>(key: K) {
    return (update: SetStateAction<RegistrySettingsDraft[K]>) => {
      documentStore.updateRegistryDraft(scope, (previous) => ({
        ...previous,
        [key]:
          typeof update === "function"
            ? (
                update as (
                  value: RegistrySettingsDraft[K],
                ) => RegistrySettingsDraft[K]
              )(previous[key])
            : update,
      }));
    };
  }
  const setDoc = setter("doc"),
    setValue = setter("value"),
    setTimeoutDraft = setter("timeoutDraft"),
    setError = setter("error"),
    setInputErrors = setter("inputErrors"),
    setNotice = setter("notice"),
    setSaving = setter("saving");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const loadKey = JSON.stringify([scopeKey, attempt]);
  const [settled, setSettled] = useState("");
  const profileLoadKey = JSON.stringify([catalogKey, profileCatalogAttempt]);
  const [profileSettled, setProfileSettled] = useState("");
  const alive = useRef(false);
  const inFlight = useRef(false);
  const savedTimeout = String(
    doc?.value.startupTimeoutMinutes ?? DEFAULT_STARTUP_TIMEOUT_MINUTES,
  );
  const timeoutValid =
    timeoutDraft.trim() !== "" && isStartupTimeoutMinutes(Number(timeoutDraft));
  const dirty =
    !!doc &&
    (timeoutDraft !== savedTimeout ||
      JSON.stringify(value) !== JSON.stringify(doc.value) ||
      Object.keys(inputErrors).length > 0);
  const read = useReadScope(loadKey);
  useEffect(() => {
    alive.current = true;
    let current = true;
    setLoading(true);
    setError("");
    const readBaseVersion = documentStore.registryDraft(scope).doc?.version;
    read("readProjectSettings", scope).then(
      (d) => {
        if (!current) return;
        documentStore.updateRegistryDraft(scope, (previous) => {
          const saved = String(
            previous.doc?.value.startupTimeoutMinutes ??
              DEFAULT_STARTUP_TIMEOUT_MINUTES,
          );
          const hasDraft =
            previous.doc &&
            (previous.doc.version !== readBaseVersion ||
              previous.saving ||
              previous.timeoutDraft !== saved ||
              JSON.stringify(previous.value) !==
                JSON.stringify(previous.doc.value) ||
              Object.keys(previous.inputErrors).length > 0);
          // Refresh catalog metadata, not the stale base version of a dirty draft.
          // Host registry CAS must still reject an overwrite after another scope saved.
          return hasDraft
            ? {
                ...previous,
                doc: { ...previous.doc!, profiles: d.profiles },
              }
            : {
                ...previous,
                doc: d,
                value: d.value,
                inputErrors: {},
                error: "",
                notice: "",
                timeoutDraft: String(
                  d.value.startupTimeoutMinutes ??
                    DEFAULT_STARTUP_TIMEOUT_MINUTES,
                ),
              };
        });
        setLoading(false);
        setSettled(loadKey);
      },
      () => {
        if (!current) return;
        setError("Не удалось загрузить настройки проекта. Повторите попытку.");
        setLoading(false);
        setSettled(loadKey);
      },
    );
    return () => {
      current = false;
      alive.current = false;
      guard.current = null;
    };
  }, [scopeKey, attempt]);
  // Refresh only profile metadata, never value/version or timeout/env drafts.
  useEffect(() => {
    if (!doc || appliedCatalogKey.current === catalogKey) return;
    let current = true;
    setProfileCatalogError("");
    read("readProjectSettings", scope).then(
      (fresh) => {
        if (current) {
          setDoc((previous) =>
            previous ? { ...previous, profiles: fresh.profiles } : previous,
          );
          appliedCatalogKey.current = catalogKey;
          setProfileSettled(profileLoadKey);
        }
      },
      () => {
        if (current) {
          setProfileSettled(profileLoadKey);
          setProfileCatalogError(
            "Не удалось обновить список профилей. Введённые настройки сохранены.",
          );
        }
      },
    );
    return () => {
      current = false;
    };
  }, [scopeKey, catalogKey, !!doc, profileCatalogAttempt]);
  async function save() {
    if (!doc || !value || saving || inFlight.current) return false;
    // A guarded save can originate from another section; show validation there.
    setTab("launch");
    if (Object.keys(inputErrors).length > 0) return false;
    if (!timeoutValid) {
      setError(
        `Тайм-аут запуска: введите целое число от ${MIN_STARTUP_TIMEOUT_MINUTES} до ${MAX_STARTUP_TIMEOUT_MINUTES} минут.`,
      );
      return false;
    }
    try {
      assertEnvironmentTransport(value.env);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Недопустимые переменные окружения.",
      );
      return false;
    }
    if (!dirty) return true;
    inFlight.current = true;
    if (guard.current) guard.current.busy = true;
    setSaving(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await window.goga.saveProjectSettings(
        scope,
        timeoutDraft === savedTimeout
          ? value
          : { ...value, startupTimeoutMinutes: Number(timeoutDraft) },
        doc.version,
      );
      setDoc(next);
      setValue(next.value);
      setTimeoutDraft(
        String(
          next.value.startupTimeoutMinutes ?? DEFAULT_STARTUP_TIMEOUT_MINUTES,
        ),
      );
      if (alive.current && guard.current) guard.current.dirty = false;
      setNotice("Сохранено. Изменения применятся к следующим запускам.");
      if (alive.current) onSaved(next.version);
      return true;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Не удалось сохранить настройки проекта.",
      );
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current && guard.current) guard.current.busy = false;
      setSaving(false);
      if (alive.current) {
        onBusy(false);
      }
    }
  }
  function discard() {
    if (doc && !saving && !inFlight.current) {
      setValue(doc.value);
      setTimeoutDraft(savedTimeout);
      setError("");
      setInputErrors({});
      setNotice("");
      if (guard.current) guard.current.dirty = false;
    }
  }
  guard.current = { dirty, busy: saving || inFlight.current, save, discard };
  function edit(next: Value) {
    if (saving || inFlight.current) return;
    setValue(next);
    setNotice("");
    setError("");
  }
  const missing =
    !!value?.profile && !doc?.profiles.some((p) => p.name === value.profile);
  return (
    <section
      className={`project-settings-panel ${embedded ? "project-home-panel" : ""}`}
      aria-busy={loading || saving}
    >
      <div className="section-heading">
        <div>
          {!embedded && (
            <span className="eyebrow">ПРОЕКТ / {project.name}</span>
          )}
          <h2>{embedded ? "Проект" : "Настройки проекта"}</h2>
        </div>
        {!embedded && (
          <button
            type="button"
            className="quiet"
            disabled={saving || documentsBusy}
            onClick={onBack}
          >
            ← Назад
          </button>
        )}
      </div>
      <SettingsTabs
        label="Разделы настроек проекта"
        tabs={[
          ["launch", "Запуск"],
          ["config", "Конфигурация"],
          ["workflows", "Рабочие процессы"],
          ["pipelines", "Конвейеры"],
          ["image", "Образ"],
          ["tools", "Инструменты"],
          ["profiles", "Профили"],
        ]}
        current={tab}
        onChange={setTab}
        disabled={saving}
      />
      <div hidden={tab !== "launch"}>
        <LoadingBoundary
          pending={
            loading ||
            settled !== loadKey ||
            (!!doc &&
              appliedCatalogKey.current !== catalogKey &&
              profileSettled !== profileLoadKey)
          }
          label="Загружаем настройки…"
        >
          <p className="project-settings-notice">
            Параметры запуска Desktop общие для всех топиков проекта:
            исполняемый файл, профиль по умолчанию, окружение и тайм-аут.
            Профили проверяются в выбранном контексте; проектные файлы ниже
            принадлежат только ему. Уже запущенные процессы не меняются.
          </p>
          {!value ? (
            <button onClick={() => setAttempt((a) => a + 1)}>
              Повторить загрузку
            </button>
          ) : (
            <form
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={saving}>
                <section className="project-settings-section">
                  <div>
                    <h3>Goga</h3>
                    <p className="hint">
                      Свой исполняемый файл для каждого проекта.
                    </p>
                  </div>
                  <div>
                    <label>
                      Исполняемый файл
                      <input
                        value={value.executable}
                        spellCheck={false}
                        onChange={(e) =>
                          edit({ ...value, executable: e.target.value })
                        }
                        aria-describedby="executable-help"
                      />
                    </label>
                    <p className="hint" id="executable-help">
                      Имя из PATH, например goga-2.0, или абсолютный путь. Без
                      аргументов командной строки.
                    </p>
                  </div>
                </section>
                <section className="project-settings-section">
                  <div>
                    <h3>Профиль проекта</h3>
                    <p className="hint">Выберите из существующих профилей.</p>
                  </div>
                  <div>
                    <label>
                      Профиль по умолчанию
                      <select
                        value={value.profile}
                        onChange={(e) =>
                          edit({ ...value, profile: e.target.value })
                        }
                      >
                        <option value="">
                          Автоматически — окружение / рабочий процесс
                        </option>
                        {missing && (
                          <option value={value.profile}>
                            {value.profile} · не найден
                          </option>
                        )}
                        {doc?.profiles.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.name} ·{" "}
                            {p.source === "project" ? "проектный" : "личный"}
                          </option>
                        ))}
                      </select>
                    </label>
                    {profileCatalogError && (
                      <div>
                        <p className="error" role="alert">
                          {profileCatalogError}
                        </p>
                        <button
                          type="button"
                          onClick={() => setProfileCatalogAttempt((a) => a + 1)}
                        >
                          Обновить профили
                        </button>
                      </div>
                    )}
                    {missing && (
                      <p className="error">
                        Сохранённый профиль не найден. Выберите доступный
                        профиль или автоматический режим.
                      </p>
                    )}
                    <p className="hint">
                      Профиль применяется по умолчанию; в форме запуска его
                      можно переопределить. Личные профили редактируются в общих
                      настройках. Проектные — во вкладке «Профили»; они имеют
                      приоритет перед одноимёнными личными.
                    </p>
                  </div>
                </section>
                <section className="project-settings-section">
                  <div>
                    <h3>Ожидание запуска</h3>
                    <p className="hint">
                      Лимит ожидания Dashboard, не всего конвейера.
                    </p>
                  </div>
                  <div>
                    <label>
                      Тайм-аут запуска конвейера
                      <input
                        type="text"
                        inputMode="numeric"
                        value={timeoutDraft}
                        aria-invalid={!timeoutValid}
                        aria-describedby="startup-timeout-help"
                        onChange={(e) => {
                          if (saving || inFlight.current) return;
                          setTimeoutDraft(e.target.value);
                          setNotice("");
                          setError("");
                        }}
                      />
                    </label>
                    <p className="hint" id="startup-timeout-help">
                      От {MIN_STARTUP_TIMEOUT_MINUTES} до{" "}
                      {MAX_STARTUP_TIMEOUT_MINUTES} минут, целое число. По
                      умолчанию — {DEFAULT_STARTUP_TIMEOUT_MINUTES} минут. От
                      запуска процесса Goga после подтверждений до получения
                      ссылки Dashboard и успешного открытия. Включает подготовку
                      и обновление Docker. Только для будущих запусков.
                    </p>
                  </div>
                </section>
                <section className="project-settings-section">
                  <div>
                    <h3>Переменные окружения</h3>
                    <p className="hint">Окружение запуска Goga.</p>
                  </div>
                  <div>
                    <p className="hint">
                      Все переменные получает Goga. Включите «Передавать в
                      runtime», чтобы передать конкретную переменную в окружение
                      выполнения через -e.
                    </p>
                    {value.env.map((row, i) => (
                      <div className="project-env-row" key={i}>
                        <label>
                          Имя
                          <input
                            aria-label={`Имя ${i + 1}`}
                            value={row.key}
                            spellCheck={false}
                            onChange={(e) =>
                              edit({
                                ...value,
                                env: value.env.map((r, n) =>
                                  n === i ? { ...r, key: e.target.value } : r,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Значение
                          <EnvironmentValueInput
                            label={`Значение ${i + 1}`}
                            secret={row.secret}
                            value={row.value}
                            onInvalid={(message) => {
                              if (saving || inFlight.current) return;
                              setInputErrors((errors) => ({
                                ...errors,
                                [i]: message,
                              }));
                              setNotice("");
                            }}
                            onValue={(next) => {
                              if (saving || inFlight.current) return;
                              setInputErrors((errors) => {
                                const remaining = { ...errors };
                                delete remaining[i];
                                return remaining;
                              });
                              edit({
                                ...value,
                                env: value.env.map((r, n) =>
                                  n === i ? { ...r, value: next } : r,
                                ),
                              });
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="quiet"
                          aria-label={`Удалить переменную ${i + 1}`}
                          onClick={() => {
                            if (saving || inFlight.current) return;
                            setInputErrors((errors) =>
                              Object.fromEntries(
                                Object.entries(errors)
                                  .filter(([index]) => Number(index) !== i)
                                  .map(([index, message]) => [
                                    Number(index) > i
                                      ? Number(index) - 1
                                      : Number(index),
                                    message,
                                  ]),
                              ),
                            );
                            edit({
                              ...value,
                              env: value.env.filter((_, n) => n !== i),
                            });
                          }}
                        >
                          ×
                        </button>
                        <div className="project-env-controls">
                          <label className="check-row">
                            <input
                              className="runtime-switch"
                              role="switch"
                              aria-checked={row.secret}
                              aria-label={`Скрывать значение ${i + 1}`}
                              type="checkbox"
                              checked={row.secret}
                              onChange={(e) =>
                                edit({
                                  ...value,
                                  env: value.env.map((r, n) =>
                                    n === i
                                      ? { ...r, secret: e.target.checked }
                                      : r,
                                  ),
                                })
                              }
                            />
                            Скрывать значение
                          </label>
                          <label className="check-row">
                            <input
                              className="runtime-switch"
                              aria-label={`Передавать в runtime ${i + 1}`}
                              role="switch"
                              type="checkbox"
                              checked={row.runtime}
                              aria-checked={row.runtime}
                              onChange={(e) =>
                                edit({
                                  ...value,
                                  env: value.env.map((r, n) =>
                                    n === i
                                      ? { ...r, runtime: e.target.checked }
                                      : r,
                                  ),
                                })
                              }
                            />
                            Передавать в runtime
                          </label>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="quiet"
                      onClick={() =>
                        edit({
                          ...value,
                          env: [
                            ...value.env,
                            {
                              key: "",
                              value: "",
                              secret: false,
                              runtime: false,
                            },
                          ],
                        })
                      }
                    >
                      ＋ Добавить переменную
                    </button>
                    <p className="hint">
                      Значения указываются в одну строку. Служебные переменные
                      нельзя переопределять
                    </p>
                    <p className="hint">
                      Скрытие маскирует значение только на экране. Значения
                      сохраняются без шифрования. Не показывайте их посторонним
                    </p>
                  </div>
                </section>
                <div className="form-actions">
                  <span className="hint">
                    {dirty ? "Есть несохранённые изменения" : "Нет изменений"}
                  </span>
                  <button type="submit" className="primary" disabled={!dirty}>
                    {saving ? "Сохраняем…" : "Сохранить"}
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          {(Object.values(inputErrors)[0] || error) && (
            <p role="alert" className="error">
              {Object.values(inputErrors)[0] || error}
            </p>
          )}
          {notice && (
            <p role="status" className="success">
              {notice}
            </p>
          )}
        </LoadingBoundary>
      </div>
      <ProjectDocuments
        project={project}
        owner={owner}
        tab={tab}
        store={documentStore}
        savedSettingsVersion={doc?.version}
      />
      <p className="memory-note">
        Черновики настроек и YAML сохраняются при переходах в этом окне до его
        закрытия или перезагрузки. На диск записывается только выбранный файл по
        кнопке «Сохранить».
      </p>
    </section>
  );
}

export function ProjectSettingsConfirmation({
  busy,
  onCancel,
  onDiscard,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="task-reload-dialog"
      aria-label="Несохранённые настройки проекта"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2>Сохранить изменения?</h2>
      <p>В настройках проекта есть несохранённые изменения.</p>
      <div className="form-actions">
        <button
          ref={cancel}
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          Отмена
        </button>
        <button type="button" disabled={busy} onClick={onDiscard}>
          Не сохранять и перейти
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={onSave}
        >
          {busy ? "Сохраняем…" : "Сохранить и перейти"}
        </button>
      </div>
    </dialog>
  );
}
