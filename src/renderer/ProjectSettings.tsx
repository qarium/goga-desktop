import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { createSpecificationsState, type SpecificationsStateStore } from "./project-specifications-state";
import { saveProjectSettingsReconciled } from "./project-settings-save";
import { preparationErrorMessage } from "./preparation-error";
import "./ProjectContent.css";
import { RetainedViews, useViewActive } from "./RetainedViews";
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
  useLocale();
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const rejectedNativeInput = useRef(false);
  function valid(next: string) {
    try {
      assertEnvironmentValue(next);
      return true;
    } catch (e) {
      onInvalid(
        msg("project.inputRejectedCorrectTheValueOrRemoveTheVariable", { value1: String(e instanceof Error ? e.message : msg("project.invalidValue")) }),
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
  specificationsState,
  selectedTab,
  onTabChange,
  embedded = false,
}: {
  owner?: TopicContextRef;
  embedded?: boolean;
  documents?: SettingsDocuments;
  specificationsState?: SpecificationsStateStore;
  selectedTab?: string;
  onTabChange?: (tab: string) => void;
  project: Project;
  onBack: () => void;
  onSaved: (version: string) => void;
  guard: MutableRefObject<ProjectSettingsGuard | null>;
  onBusy: (busy: boolean) => void;
}) {
  useLocale();
  const viewActive = useViewActive();
  const scope = owner ? contextRef(owner) : project.id;
  const scopeKey = documentScopeId(scope);
  const [ownSpecifications] = useState(createSpecificationsState);
  const [ownDocuments] = useState(createSettingsDocuments);
  const documentStore = documents ?? ownDocuments;
  const documentsBusy = useSyncExternalStore(
    documentStore.subscribe,
    documentStore.busy,
  );
  const [localTab, setLocalTab] = useState("launch");
  const tab = selectedTab ?? localTab;
  const setTab = (next: string) => { setLocalTab(next); onTabChange?.(next); };
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
        setError(msg("project.couldNotLoadProjectSettingsTryAgain"));
        setLoading(false);
        setSettled(loadKey);
      },
    );
    return () => {
      current = false;
      alive.current = false;
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
            msg("project.couldNotRefreshTheProfilesListYourEntriesHaveBeen"),
          );
        }
      },
    );
    return () => {
      current = false;
    };
  }, [scopeKey, catalogKey, !!doc, profileCatalogAttempt]);
  async function save() {
    if (!doc || !value || saving || inFlight.current || registryDraft.conflict)
      return false;
    // A guarded save can originate from another section; show validation there.
    setTab("launch");
    if (Object.keys(inputErrors).length > 0) return false;
    if (!timeoutValid) {
      setError(
        msg("project.startupTimeoutEnterAWholeNumberBetweenAndMinutes", { MIN_STARTUP_TIMEOUT_MINUTES: String(MIN_STARTUP_TIMEOUT_MINUTES), MAX_STARTUP_TIMEOUT_MINUTES: String(MAX_STARTUP_TIMEOUT_MINUTES) }),
      );
      return false;
    }
    try {
      assertEnvironmentTransport(value.env);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : msg("project.invalidEnvironmentVariables"),
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
      const result = await saveProjectSettingsReconciled(
        window.goga,
        scope,
        doc,
        timeoutDraft === savedTimeout
          ? value
          : { ...value, startupTimeoutMinutes: Number(timeoutDraft) },
      );
      if (result.conflict) {
        documentStore.updateRegistryDraft(scope, (previous) => ({
          ...previous,
          doc: result.document,
          value: result.conflict!.mine,
          timeoutDraft: String(
            result.conflict!.mine.startupTimeoutMinutes ??
              DEFAULT_STARTUP_TIMEOUT_MINUTES,
          ),
          conflict: result.conflict,
          error: msg("project.theSameSettingsChangedInTwoPlacesChooseWhichValues", { value1: String(result.conflict.fields.join(", ")) }),
        }));
        return false;
      }
      const next = result.document;
      setDoc(next);
      setValue(next.value);
      setTimeoutDraft(
        String(
          next.value.startupTimeoutMinutes ?? DEFAULT_STARTUP_TIMEOUT_MINUTES,
        ),
      );
      if (alive.current && guard.current) guard.current.dirty = false;
      setNotice(msg("project.savedChangesApplyToFutureRuns"));
      if (alive.current) onSaved(next.version);
      return true;
    } catch (e) {
      setError(
        preparationErrorMessage(e) || msg("project.couldNotSaveProjectSettings"),
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
      documentStore.updateRegistryDraft(scope, (previous) => ({
        ...previous,
        conflict: undefined,
      }));
      if (guard.current) guard.current.dirty = false;
    }
  }
  useLayoutEffect(() => {
    if (!viewActive) return;
    const current = { dirty, busy: saving || inFlight.current, save, discard };
    guard.current = current;
    return () => {
      if (guard.current === current) guard.current = null;
    };
  });
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
      className={`project-settings-panel ${embedded ? "project-home-panel project-content" : ""}`}
      aria-busy={loading || saving}
    >
      <div className="section-heading">
        <div>
          {!embedded && (
            <span className="eyebrow">{msg("project.project")}{project.name}</span>
          )}
          <h2>{embedded ? msg("project.project2") : msg("project.projectSettings")}</h2>
        </div>
        {!embedded && (
          <button
            type="button"
            className="quiet"
            disabled={saving || documentsBusy}
            onClick={onBack}
          >{msg("project.back")}</button>
        )}
      </div>
      <SettingsTabs
        workspace
        label={msg("project.projectSettingsSections")}
        tabs={[
          ["launch", msg("project.launch")],
          ["config", msg("project.configuration")],
          ["workflows", msg("project.workflows")],
          ["pipelines", msg("project.pipelines")],
          ["image", msg("project.image")],
          ["specifications", msg("project.usages")],
          ["history", msg("project.history")],
          ["tools", msg("project.tools")],
          ["profiles", msg("project.profiles")],
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
          label={msg("project.loadingSettings")}
        >
          <p className="project-settings-notice">{msg("project.desktopLaunchSettingsAreSharedByAllTopicsInThis")}</p>
          {!value ? (
            <button onClick={() => setAttempt((a) => a + 1)}>{msg("project.retryLoading")}</button>
          ) : (
            <form
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={saving || !!registryDraft.conflict}>
                <section className="project-settings-section">
                  <div>
                    <h3>Goga</h3>
                    <p className="hint">{msg("project.useASeparateExecutableForEachProject")}</p>
                  </div>
                  <div>
                    <label>{msg("project.executable")}<input
                        value={value.executable}
                        spellCheck={false}
                        onChange={(e) =>
                          edit({ ...value, executable: e.target.value })
                        }
                        aria-describedby="executable-help"
                      />
                    </label>
                    <p className="hint" id="executable-help">{msg("project.enterANameOnYourPATHSuchAsGoga2")}</p>
                  </div>
                </section>
                <section className="project-settings-section">
                  <div>
                    <h3>{msg("project.projectProfile")}</h3>
                    <p className="hint">{msg("project.chooseAnExistingProfile")}</p>
                  </div>
                  <div>
                    <label>{msg("project.defaultProfile")}<select
                        value={value.profile}
                        onChange={(e) =>
                          edit({ ...value, profile: e.target.value })
                        }
                      >
                        <option value="">{msg("project.automaticEnvironmentWorkflow")}</option>
                        {missing && (
                          <option value={value.profile}>
                            {value.profile}{msg("project.notFound")}</option>
                        )}
                        {doc?.profiles.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.name} ·{" "}
                            {p.source === "project" ? msg("project.project3") : msg("project.personal")}
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
                        >{msg("project.refreshProfiles")}</button>
                      </div>
                    )}
                    {missing && (
                      <p className="error">{msg("project.theSavedProfileWasNotFoundChooseAnAvailableProfile")}</p>
                    )}
                    <p className="hint">{msg("project.thisIsTheDefaultProfileYouCanOverrideItIn")}</p>
                  </div>
                </section>
                <section className="project-settings-section">
                  <div>
                    <h3>{msg("project.startupTimeout")}</h3>
                    <p className="hint">{msg("project.timeLimitForOpeningTheDashboardNotForTheEntire")}</p>
                  </div>
                  <div>
                    <label>{msg("project.pipelineStartupTimeout")}<input
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
                    <p className="hint" id="startup-timeout-help">{msg("project.startupTimeoutHelp", { min: MIN_STARTUP_TIMEOUT_MINUTES, max: MAX_STARTUP_TIMEOUT_MINUTES, defaultMinutes: DEFAULT_STARTUP_TIMEOUT_MINUTES })}</p>
                  </div>
                </section>
                <section className="project-settings-section">
                  <div>
                    <h3>{msg("project.environmentVariables")}</h3>
                    <p className="hint">{msg("project.environmentForLaunchingGoga")}</p>
                  </div>
                  <div>
                    <p className="hint">{msg("project.gogaReceivesAllVariablesEnablePassToRuntimeToPass")}</p>
                    {value.env.map((row, i) => (
                      <div className="project-env-row" key={i}>
                        <label>{msg("project.name")}<input
                            aria-label={msg("project.name2", { value1: String(i + 1) })}
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
                        <label>{msg("project.value")}<EnvironmentValueInput
                            label={msg("project.value2", { value1: String(i + 1) })}
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
                          aria-label={msg("project.removeVariable", { value1: String(i + 1) })}
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
                              aria-label={msg("project.hideValue", { value1: String(i + 1) })}
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
                            />{msg("project.hideValue2")}</label>
                          <label className="check-row">
                            <input
                              className="runtime-switch"
                              aria-label={msg("project.passToRuntime", { value1: String(i + 1) })}
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
                            />{msg("project.passToRuntime2")}</label>
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
                              runtime: true,
                            },
                          ],
                        })
                      }
                    >{msg("project.addVariable")}</button>
                    <p className="hint">{msg("project.valuesMustFitOnASingleLineReservedVariablesCannot")}</p>
                    <p className="hint">{msg("project.hidingAValueOnlyMasksItOnScreenValuesAre")}</p>
                  </div>
                </section>
                <div className="form-actions">
                  <span className="hint">
                    {dirty ? msg("project.unsavedChanges") : msg("project.noChanges")}
                  </span>
                  <button type="submit" className="primary" disabled={!dirty}>
                    {saving ? msg("project.saving") : msg("project.save")}
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
          {registryDraft.conflict && (
            <div
              className="form-actions"
              aria-label={msg("project.resolveSettingsConflict")}
            >
              {(
                [
                  ["mine", msg("project.keepMyValues")],
                  ["current", msg("project.useCurrentValues")],
                ] as const
              ).map(([choice, label]) => (
                <button
                  key={choice}
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    const next = registryDraft.conflict![choice];
                    documentStore.updateRegistryDraft(scope, (previous) => ({
                      ...previous,
                      value: next,
                      timeoutDraft: String(
                        next.startupTimeoutMinutes ??
                          DEFAULT_STARTUP_TIMEOUT_MINUTES,
                      ),
                      conflict: undefined,
                      error: "",
                      notice:
                        msg("project.valuesSelectedReviewYourSettingsAndSaveChanges"),
                    }));
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {notice && (
            <p role="status" className="success">
              {notice}
            </p>
          )}
        </LoadingBoundary>
      </div>
      <RetainedViews activeKey={tab === "launch" ? null : tab}>
        <ProjectDocuments
          project={project}
          owner={owner}
          tab={tab}
          store={documentStore}
          specificationsState={specificationsState ?? ownSpecifications}
          savedSettingsVersion={doc?.version}
        />
      </RetainedViews>
      {tab !== "history" && tab !== "specifications" && (
        <p className="memory-note">{msg("project.unsavedEditsStayInThisWindowUntilItIsClosed")}</p>
      )}
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
  useLocale();
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
      className="task-reload-dialog project-settings-confirmation"
      aria-label={msg("project.unsavedProjectSettings")}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2>{msg("project.saveChanges")}</h2>
      <p>{msg("project.yourProjectSettingsHaveUnsavedChanges")}</p>
      <div className="form-actions">
        <button
          ref={cancel}
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >{msg("project.cancel")}</button>
        <button type="button" disabled={busy} onClick={onDiscard}>{msg("project.continueWithoutSaving")}</button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={onSave}
        >
          {busy ? msg("project.saving") : msg("project.saveAndContinue")}
        </button>
      </div>
    </dialog>
  );
}
