import type { BuildRepeatPreparation } from "../shared/build-repeat";
import { BuildRepeatNotice } from "./BuildRepeatNotice";
import type { TopicContextRef } from "../shared/worktrees";
import { contextRef, contextRequestKey, draftKey } from "./topic-context";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { ActionReason } from "./ActionReason";
import { useEffect, useId, useRef, useState } from "react";
import type { Project, Run } from "../shared/types";
import type {
  BuildContext,
  BuildOptions,
  BuildPlanDocument,
  BuildPlanErrorCode,
  BuildFileList,
  BuildRequest,
} from "../shared/build";
import { buildPlanProblem, validateBuildOptions } from "../shared/build";
import "../shared/bridge";
import { EnvironmentValueInput } from "./ProjectSettings";
import { SearchablePicker } from "./SearchablePicker";
import { SplitLaunchButton } from "./SplitLaunchButton";
import { TopicModal, TopicSwitch } from "./TopicsCommon";
import "./BuildForm.css";

type Draft = {
  path: string | null;
  workflow: string;
  profile: string;
  sessionTimeout: string;
  idleTimeout: string;
  wait: string;
  maxIterations: string;
  reviewPatience: string;
  baseRef: string;
  skipReview?: boolean;
  env: { key: string; value: string }[];
  addHost: { host: string; ip: string }[];
  proxy: string;
  clean: boolean;
  update: boolean;
  skipManifestCheck: boolean;
};
const initial = (): Draft => ({
  path: null,
  workflow: "",
  profile: "__project__",
  sessionTimeout: "",
  idleTimeout: "",
  wait: "",
  maxIterations: "",
  reviewPatience: "",
  baseRef: "",
  env: [],
  addHost: [],
  proxy: "",
  clean: false,
  update: false,
  skipManifestCheck: false,
});
function repeatDraft(seed: BuildRepeatPreparation): Draft {
  const o = seed.options;
  return {
    ...initial(),
    path: seed.planPath,
    workflow: o.workflow ?? "",
    profile: o.profile ?? "__project__",
    sessionTimeout: o.sessionTimeout ?? "",
    idleTimeout: o.idleTimeout ?? "",
    wait: o.wait ?? "",
    maxIterations: o.maxIterations?.toString() ?? "",
    reviewPatience: o.reviewPatience?.toString() ?? "",
    baseRef: o.baseRef ?? "",
    skipReview: o.skipReview,
    env: seed.requiredEnvKeys.map((key) => ({ key, value: "" })),
    addHost: (o.addHost ?? []).map((entry) => ({ ...entry })),
    clean: o.clean ?? false,
    update: o.update ?? false,
    skipManifestCheck: o.skipManifestCheck ?? false,
  };
}
export function createBuildDrafts() {
  return new Map<string, Draft>();
}
const errorText = (e: unknown) =>
  e instanceof Error
    ? e.message.replace(
        /^Error invoking remote method 'goga:[a-z-]+': (?:Error: )?/,
        "",
      )
    : "Не удалось выполнить действие";
function integer(s: string, name: string) {
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)))
    throw Error(name + ": введите целое число");
  return Number(s);
}
export function BuildForm({
  project,
  owner,
  onLaunched,
  onCancel,
  drafts: provided,
  draftId,
  revision = "",
  suspended = false,
  blocked = false,
  onBusyChange,
  seed,
}: {
  project: Project;
  seed?: BuildRepeatPreparation;
  owner?: TopicContextRef;
  onLaunched: (run: Run, stale?: boolean) => void;
  onCancel: () => void;
  drafts?: Map<string, Draft>;
  /** UI storage identity only; never changes the execution owner. */
  draftId?: string;
  revision?: string;
  suspended?: boolean;
  blocked?: boolean | string;
  onBusyChange?: (projectId: string, busy: boolean) => void;
}) {
  const scope = owner ? contextRef(owner) : project.id;
  const ownerKey = owner ? contextRequestKey(owner) : project.id;
  const storageKey = draftId ?? (owner ? draftKey(owner, "build") : project.id);
  const local = useRef(createBuildDrafts()),
    drafts = provided ?? local.current;
  const [draft, setDraft] = useState<Draft>(() =>
    seed ? repeatDraft(seed) : (drafts.get(storageKey) ?? initial()),
  );
  const [repeatReviewed, setRepeatReviewed] = useState(false);
  const repeatOwnerError =
    seed &&
    (seed.projectId !== project.id ||
      (seed.context
        ? !owner || contextRequestKey(seed.context) !== ownerKey
        : !!owner))
      ? "Параметры повторной сборки принадлежат другому владельцу. Подготовьте повтор заново."
      : "";
  const repeatEnvValues = new Map(
    draft.env.map((entry) => [entry.key, entry.value]),
  );
  const missingEnvKeys =
    seed?.requiredEnvKeys.filter(
      (key) => !repeatEnvValues.has(key) || repeatEnvValues.get(key) === "",
    ) ?? [];
  const missingProxy = !!seed?.requiresProxy && !draft.proxy;
  const repeatIncomplete =
    !!seed &&
    (!repeatReviewed ||
      missingEnvKeys.length > 0 ||
      missingProxy ||
      !!repeatOwnerError);
  const [context, setContext] = useState<BuildContext | null>(null),
    [contextError, setContextError] = useState("");
  const [attempt, setAttempt] = useState(0),
    [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<BuildPlanDocument | null>(null),
    [planError, setPlanError] = useState(""),
    [planLoading, setPlanLoading] = useState(false);
  const reasonId = useId();
  const planInputId = useId();
  const [planFailure, setPlanFailure] = useState<{
    projectId: string;
    path: string;
    code: BuildPlanErrorCode;
  } | null>(null);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  function removeRowErrors(prefixes: string[], index: number) {
    setInputErrors((previous) =>
      Object.fromEntries(
        Object.entries(previous).flatMap(([key, value]) => {
          const prefix = prefixes.find((p) => key.startsWith(p));
          if (!prefix) return [[key, value]];
          const row = Number(key.slice(prefix.length));
          return row === index
            ? []
            : [[prefix + (row > index ? row - 1 : row), value]];
        }),
      ),
    );
  }
  function clearInput(key: string) {
    setInputErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [chooser, setChooser] = useState(false),
    [preview, setPreview] = useState(false);
  useEffect(() => {
    onBusyChange?.(storageKey, busy);
    return () => onBusyChange?.(storageKey, false);
  }, [storageKey, busy, onBusyChange]);
  const [confirmation, setConfirmation] = useState<BuildRequest | null>(null);
  const epoch = useRef(0),
    flight = useRef(false),
    alive = useRef(false),
    current = useRef({ suspended, projectId: project.id });
  current.current = { suspended, projectId: project.id };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  function edit(p: Partial<Draft>) {
    setRepeatReviewed(false);
    setDraft((d) => {
      const next = { ...d, ...p };
      drafts.set(storageKey, next);
      return next;
    });
    setError("");
  }
  // Visibility is not a data identity. Continue an in-flight snapshot on leave,
  // and consume revisions received while hidden only when this form is shown.
  const revisionSnapshot = useRef(revision);
  if (!suspended) revisionSnapshot.current = revision;
  const dataRevision = revisionSnapshot.current;
  useEffect(() => {
    if (!suspended) return;
    epoch.current++;
    setConfirmation(null);
    setChooser(false);
    setPreview(false);
  }, [suspended]);
  const contextKey = JSON.stringify([
    ownerKey,
    dataRevision,
    attempt,
    draft.workflow,
    draft.profile,
    draft.env,
  ]);
  const planKey = JSON.stringify([
    ownerKey,
    draft.path,
    dataRevision,
    attempt,
    context?.historyPlan.path,
  ]);
  const [contextSettled, setContextSettled] = useState("");
  const [planSettled, setPlanSettled] = useState("");
  const [contextReadFailed, setContextReadFailed] = useState(false);
  const readContext = useReadScope(contextKey);
  const readPlan = useReadScope(planKey);
  useEffect(() => {
    let valid = true;
    epoch.current++;
    setConfirmation(null);
    setChooser(false);
    setPreview(false);
    setLoading(true);
    setContextError("");
    setContextReadFailed(false);
    setContext(null);
    try {
      validateBuildOptions({ env: draft.env });
    } catch (e) {
      setContextError(errorText(e));
      setLoading(false);
      setContextSettled(contextKey);
      return;
    }
    const timer = window.setTimeout(() => {
      readContext("buildContext", scope, {
        ...(draft.workflow ? { workflow: draft.workflow } : {}),
        env: draft.env,
        ...(draft.profile !== "__project__" ? { profile: draft.profile } : {}),
      }).then(
        (c) => {
          if (!valid) return;
          setContext(c);
          setContextSettled(contextKey);
          setLoading(false);
          setDraft((d) => {
            if (d.path !== null) return d;
            const next = { ...d, path: c.historyPlan.path };
            drafts.set(storageKey, next);
            return next;
          });
        },
        (e) => {
          if (valid) {
            setContextError(errorText(e));
            setContextReadFailed(true);
            setContextSettled(contextKey);
            setLoading(false);
          }
        },
      );
    }, 180);
    return () => {
      valid = false;
      window.clearTimeout(timer);
    };
  }, [
    ownerKey,
    dataRevision,
    attempt,
    draft.workflow,
    draft.profile,
    JSON.stringify(draft.env),
  ]);
  useEffect(() => {
    let valid = true;
    setPlan(null);
    setPlanError("");
    setPlanFailure(null);
    setPreview(false);
    if (draft.path === null || !draft.path.trim()) {
      setPlanLoading(false);
      setPlanSettled(planKey);
      return;
    }
    setPlanLoading(true);
    readPlan("readBuildPlan", scope, draft.path).then(
      (p) => {
        if (valid) {
          setPlan(p);
          setPlanLoading(false);
          setPlanSettled(planKey);
        }
      },
      (e) => {
        if (valid) {
          const problem = buildPlanProblem(
            e,
            draft.path === context?.historyPlan.path,
          );
          setPlanError(problem.message);
          setPlanFailure({
            projectId: project.id,
            path: draft.path!,
            code: problem.code,
          });
          setPlanLoading(false);
          setPlanSettled(planKey);
        }
      },
    );
    return () => {
      valid = false;
    };
  }, [ownerKey, draft.path, dataRevision, attempt, context?.historyPlan.path]);
  const formLoading =
    !suspended &&
    (loading ||
      contextSettled !== contextKey ||
      (!contextReadFailed && (planLoading || planSettled !== planKey)));
  const planMessage =
    planError ||
    (!plan &&
    !planLoading &&
    (!draft.path || draft.path === context?.historyPlan.path)
      ? context?.historyPlan.error
      : "");
  const missingPlan =
    planMessage?.includes("ещё не создан") ||
    planMessage?.startsWith("Файл плана не найден");
  const skip = draft.skipReview ?? context?.defaults.skipReview ?? false;
  const unsupported = (flag: string) =>
    !!context && !context.capabilities.includes(flag);
  const selectionError =
    context &&
    ((draft.workflow && unsupported("workflow")) ||
      ((draft.profile === "__project__"
        ? context.defaults.profile
        : draft.profile) &&
        unsupported("profile")))
      ? "Выбранная версия Goga не поддерживает рабочий процесс или профиль сборки. Выбор не будет проигнорирован. Выберите поддерживаемую версию в разделе «Проект» или автоматический режим."
      : "";
  const reviewError =
    draft.skipReview === undefined ? context?.defaults.reviewError : "";
  const disabled =
    repeatIncomplete ||
    busy ||
    suspended ||
    contextSettled !== contextKey ||
    planSettled !== planKey ||
    !!blocked ||
    loading ||
    planLoading ||
    !plan ||
    !!contextError ||
    !context ||
    !!selectionError ||
    !!reviewError ||
    Object.keys(inputErrors).length > 0;
  const showMissingReason =
    planFailure?.code === "missing" &&
    planFailure.projectId === project.id &&
    planFailure.path === draft.path &&
    !plan &&
    !suspended &&
    !busy &&
    !blocked &&
    !loading &&
    !planLoading &&
    !contextError &&
    !!context &&
    !selectionError &&
    !reviewError &&
    Object.keys(inputErrors).length === 0;
  function options(update: boolean): BuildOptions {
    const o: BuildOptions = {
      clean: draft.clean,
      update: update || draft.update,
      skipManifestCheck: draft.skipManifestCheck,
    };
    if (draft.workflow) o.workflow = draft.workflow;
    if (draft.profile !== "__project__") o.profile = draft.profile;
    for (const k of ["sessionTimeout", "idleTimeout", "wait", "proxy"] as const)
      if (draft[k]) o[k] = draft[k];
    if (draft.maxIterations)
      o.maxIterations = integer(
        draft.maxIterations,
        "Максимальное число итераций",
      );
    if (!skip) {
      if (draft.reviewPatience)
        o.reviewPatience = integer(draft.reviewPatience, "Повторные раунды");
      if (draft.baseRef) o.baseRef = draft.baseRef;
    }
    if (draft.skipReview !== undefined) o.skipReview = draft.skipReview;
    if (draft.env.length) o.env = draft.env.map((x) => ({ ...x }));
    if (draft.addHost.length) o.addHost = draft.addHost.map((x) => ({ ...x }));
    validateBuildOptions(o);
    for (const [flag, value] of [
      ["workflow", o.workflow],
      ["profile", o.profile],
      ["session-timeout", o.sessionTimeout],
      ["idle-timeout", o.idleTimeout],
      ["wait", o.wait],
      ["max-iterations", o.maxIterations],
      ["review-patience", o.reviewPatience],
      ["base-ref", o.baseRef],
      ["env", o.env?.length],
      ["add-host", o.addHost?.length],
      ["proxy", o.proxy],
      ["clean", o.clean],
      ["update", o.update],
      ["skip-manifest-check", o.skipManifestCheck],
      ["skip-review", o.skipReview === true],
      ["no-skip-review", o.skipReview === false],
    ] as const)
      if (
        value !== undefined &&
        value !== false &&
        value !== "" &&
        unsupported(flag)
      )
        throw Error(
          "Выбранная версия Goga не поддерживает параметр «" + flag + "».",
        );
    return o;
  }
  async function execute(request: BuildRequest) {
    if (
      flight.current ||
      disabled ||
      !alive.current ||
      current.current.suspended ||
      current.current.projectId !== request.projectId
    )
      return;
    flight.current = true;
    setBusy(true);
    setConfirmation(null);
    setError("");
    const generation = epoch.current;
    try {
      const run = await window.goga.launchBuild(request);
      onLaunched(
        run,
        !alive.current ||
          current.current.suspended ||
          current.current.projectId !== project.id ||
          epoch.current !== generation,
      );
    } catch (e) {
      if (alive.current) {
        let s = errorText(e);
        for (const v of [...draft.env.map((x) => x.value), draft.proxy])
          if (v) s = s.split(v).join("[скрыто]");
        setError(s);
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function start(update: boolean) {
    if (disabled || !plan || !context) return;
    try {
      const request: BuildRequest = {
        projectId: project.id,
        ...(owner ? { context: contextRef(owner) } : {}),
        expectedBranch: context.branch,
        contextRevision: context.revision,
        planPath: plan.path,
        planVersion: plan.version,
        options: options(update),
        confirmClean: false,
        ...(seed
          ? {
              repeat: {
                sourceRunId: seed.sourceRunId,
                acknowledged: true as const,
              },
            }
          : {}),
      };
      if (request.options.clean) setConfirmation(request);
      else void execute(request);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section
      className="build-form"
      aria-label="Новая сборка"
      aria-busy={formLoading || busy}
    >
      <div className="section-heading">
        <div>
          <h2>Запустить сборку</h2>
          <p className="hint">
            Выполнить план разработки в текущей ветке проекта.
          </p>
        </div>
        <button
          type="button"
          aria-label="Закрыть форму сборки"
          disabled={busy}
          onClick={onCancel}
        >
          ×
        </button>
      </div>
      <LoadingBoundary
        pending={formLoading}
        label="Загружаем параметры сборки…"
        error={contextReadFailed ? contextError : undefined}
        onRetry={() => setAttempt((n) => n + 1)}
      >
        {!contextReadFailed &&
          (contextError || error || Object.values(inputErrors)[0]) && (
            <p className="error" role="alert">
              {contextError || error || Object.values(inputErrors)[0]}
            </p>
          )}
        <fieldset disabled={busy || suspended}>
          {seed && (
            <BuildRepeatNotice
              preparation={seed}
              missingEnvKeys={missingEnvKeys}
              missingProxy={missingProxy}
              reviewed={repeatReviewed}
              onReview={setRepeatReviewed}
              ownerError={repeatOwnerError}
            />
          )}
          <label htmlFor={planInputId}>План сборки</label>
          <div className="build-plan-row">
            <input
              id={planInputId}
              value={draft.path ?? ""}
              onChange={(e) => edit({ path: e.target.value })}
              placeholder={
                loading ? "Получаем путь из истории…" : "Путь внутри проекта"
              }
            />
            <button type="button" onClick={() => setChooser(true)}>
              Выбрать файл…
            </button>
          </div>
          <p className="hint">
            Другой файл можно выбрать только внутри этого проекта. Путь из
            истории не создаёт план автоматически.
          </p>
          {planLoading ? (
            <p role="status">Проверяем план…</p>
          ) : planMessage ? (
            <p
              role={missingPlan ? "status" : "alert"}
              className={missingPlan ? "hint build-plan-empty" : "error"}
            >
              {planMessage}
            </p>
          ) : plan ? (
            <p className="hint" role="status">
              План доступен
            </p>
          ) : null}
          <div className="build-inline-actions">
            <button
              type="button"
              disabled={!plan}
              onClick={() => setPreview(true)}
            >
              Посмотреть план
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                edit({ path: null });
                setAttempt((n) => n + 1);
              }}
            >
              План из истории
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => setAttempt((n) => n + 1)}
            >
              Обновить данные
            </button>
          </div>
          <div className="build-grid">
            <SearchablePicker
              label="Рабочий процесс"
              placeholder="Выберите рабочий процесс"
              emptyLabel="Нет рабочих процессов"
              searchLabel="Поиск рабочего процесса"
              searchPlaceholder="Найти рабочий процесс…"
              listLabel="Рабочие процессы"
              value={draft.workflow}
              disabled={busy || suspended || loading}
              onChange={(value) => edit({ workflow: value })}
              entries={[
                { value: "", label: "Из конфигурации" },
                ...(draft.workflow &&
                !context?.workflows.includes(draft.workflow)
                  ? [
                      {
                        value: draft.workflow,
                        label: `${draft.workflow} · недоступен`,
                      },
                    ]
                  : []),
                ...(context?.workflows.map((w) => ({
                  value: w,
                  label: w,
                  disabled: unsupported("workflow"),
                })) ?? []),
              ]}
            />
            <SearchablePicker
              label="Профиль"
              placeholder="Выберите профиль"
              emptyLabel="Нет профилей"
              searchLabel="Поиск профиля"
              searchPlaceholder="Найти профиль…"
              listLabel="Профили"
              value={draft.profile}
              disabled={busy || suspended || loading}
              onChange={(value) => edit({ profile: value })}
              entries={[
                {
                  value: "__project__",
                  label:
                    "Из настроек проекта" +
                    (context?.defaults.profile
                      ? " · " + context.defaults.profile
                      : ""),
                },
                { value: "", label: "Автоматически" },
                ...(draft.profile !== "__project__" &&
                draft.profile &&
                !context?.profiles.some((p) => p.name === draft.profile)
                  ? [
                      {
                        value: draft.profile,
                        label: `${draft.profile} · недоступен`,
                      },
                    ]
                  : []),
                ...(context?.profiles.map((p) => ({
                  value: p.name,
                  label: p.name,
                  disabled: unsupported("profile"),
                })) ?? []),
              ]}
            />
          </div>
          {(unsupported("workflow") || unsupported("profile")) && (
            <p className="hint">
              Выбор рабочего процесса и профиля требует версии Goga с поддержкой
              этих параметров сборки.
            </p>
          )}
          {selectionError && (
            <p role="alert" className="error">
              {selectionError}
            </p>
          )}
          <details className="build-group">
            <summary>
              Выполнение <span>· лимиты и ожидание</span>
            </summary>
            <div className="build-group-body">
              <div className="build-grid">
                <label>
                  Максимальное время одной сессии
                  <input
                    value={draft.sessionTimeout}
                    onChange={(e) => edit({ sessionTimeout: e.target.value })}
                    placeholder="Из конфигурации · например 1h30m"
                  />
                  <small>
                    Отдельно для каждой сессии выполнения задач и ревью, не
                    общий лимит сборки.
                  </small>
                </label>
                <label>
                  Максимальное время бездействия
                  <input
                    value={draft.idleTimeout}
                    onChange={(e) => edit({ idleTimeout: e.target.value })}
                    placeholder="Из конфигурации · например 10m"
                  />
                </label>
                <label>
                  Пауза при лимите ИИ
                  <input
                    value={draft.wait}
                    onChange={(e) => edit({ wait: e.target.value })}
                    placeholder="Из конфигурации · например 5m"
                  />
                  <small>
                    Ожидание перед повторной попыткой при ограничении
                    использования ИИ-провайдером.
                  </small>
                </label>
                <label>
                  Максимальное число итераций
                  <input
                    inputMode="numeric"
                    value={draft.maxIterations}
                    onChange={(e) => edit({ maxIterations: e.target.value })}
                    placeholder="Из конфигурации"
                  />
                </label>
              </div>
            </div>
          </details>
          <details className="build-group" open>
            <summary>
              Ревью <span>· {skip ? "пропустить" : "выполнять"}</span>
            </summary>
            <div className="build-group-body">
              <div className="build-review-choice">
                <TopicSwitch
                  checked={skip}
                  disabled={loading}
                  onChange={() => edit({ skipReview: !skip })}
                >
                  Пропустить ревью
                </TopicSwitch>
                {draft.skipReview !== undefined && (
                  <button
                    type="button"
                    className="build-inherit"
                    onClick={() => edit({ skipReview: undefined })}
                  >
                    Использовать настройку проекта
                  </button>
                )}
              </div>
              {reviewError && (
                <p role="alert" className="error">
                  {reviewError}
                </p>
              )}
              <div className="build-grid">
                <div className="build-catalog-field">
                  <SearchablePicker
                    label="База сравнения"
                    placeholder="Выберите базу сравнения"
                    emptyLabel="Нет доступных веток"
                    searchLabel="Поиск базы сравнения"
                    searchPlaceholder="Найти ветку…"
                    listLabel="Базы сравнения"
                    disabled={skip || busy || suspended || loading}
                    value={draft.baseRef}
                    onChange={(value) => edit({ baseRef: value })}
                    entries={[
                      { value: "", label: "Из конфигурации проекта" },
                      ...(draft.baseRef &&
                      !context?.branches.includes(draft.baseRef)
                        ? [
                            {
                              value: draft.baseRef,
                              label: `${draft.baseRef} · недоступна`,
                            },
                          ]
                        : []),
                      ...(context?.branches ?? []),
                    ]}
                  />
                  <small>
                    Ветка, относительно которой сравниваются изменения. Список
                    без fetch.
                  </small>
                </div>
                <label>
                  Повторные раунды без изменений
                  <input
                    disabled={skip}
                    inputMode="numeric"
                    aria-label="Повторные раунды без изменений"
                    value={draft.reviewPatience}
                    onChange={(e) => edit({ reviewPatience: e.target.value })}
                    placeholder="Из конфигурации"
                  />
                  <small>
                    После этого числа раундов внешнее ревью завершается.
                  </small>
                </label>
              </div>
            </div>
          </details>
          <details className="build-group" open={seed ? true : undefined}>
            <summary>
              Окружение <span>· переменные и сеть</span>
            </summary>
            <div className="build-group-body build-environment">
              <section className="build-environment-block">
                <h3>Переменные окружения</h3>
                <p className="hint">
                  Дополнения для этой сборки. Значения скрыты на экране и не
                  входят в сводку запуска.
                </p>
                {draft.env.map((row, i) => (
                  <div className="build-pair" key={i}>
                    <label>
                      Имя переменной {i + 1}
                      <EnvironmentValueInput
                        secret={false}
                        label={"Имя переменной " + (i + 1)}
                        value={row.key}
                        onInvalid={(message) =>
                          setInputErrors((prev) => ({
                            ...prev,
                            ["key" + i]: message,
                          }))
                        }
                        onValue={(value) => {
                          clearInput("key" + i);
                          edit({
                            env: draft.env.map((x, n) =>
                              n === i ? { ...x, key: value } : x,
                            ),
                          });
                        }}
                      />
                    </label>
                    <label>
                      Значение переменной {i + 1}
                      <EnvironmentValueInput
                        secret
                        label={"Значение переменной " + (i + 1)}
                        value={row.value}
                        onInvalid={(message) =>
                          setInputErrors((prev) => ({
                            ...prev,
                            ["env" + i]: message,
                          }))
                        }
                        onValue={(value) => {
                          clearInput("env" + i);
                          edit({
                            env: draft.env.map((x, n) =>
                              n === i ? { ...x, value } : x,
                            ),
                          });
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={"Удалить переменную " + (i + 1)}
                      onClick={() => {
                        removeRowErrors(["env", "key"], i);
                        edit({ env: draft.env.filter((_, n) => n !== i) });
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    edit({ env: [...draft.env, { key: "", value: "" }] })
                  }
                >
                  Добавить переменную
                </button>
              </section>
              <section className="build-environment-block">
                <h3>Дополнительные хосты</h3>
                {draft.addHost.map((row, i) => (
                  <div className="build-pair" key={i}>
                    <label>
                      Имя хоста {i + 1}
                      <EnvironmentValueInput
                        secret={false}
                        label={"Имя хоста " + (i + 1)}
                        value={row.host}
                        onInvalid={(message) =>
                          setInputErrors((prev) => ({
                            ...prev,
                            ["host" + i]: message,
                          }))
                        }
                        onValue={(value) => {
                          clearInput("host" + i);
                          edit({
                            addHost: draft.addHost.map((x, n) =>
                              n === i ? { ...x, host: value } : x,
                            ),
                          });
                        }}
                      />
                    </label>
                    <label>
                      IP-адрес {i + 1}
                      <EnvironmentValueInput
                        secret={false}
                        label={"IP-адрес " + (i + 1)}
                        value={row.ip}
                        onInvalid={(message) =>
                          setInputErrors((prev) => ({
                            ...prev,
                            ["ip" + i]: message,
                          }))
                        }
                        onValue={(value) => {
                          clearInput("ip" + i);
                          edit({
                            addHost: draft.addHost.map((x, n) =>
                              n === i ? { ...x, ip: value } : x,
                            ),
                          });
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={"Удалить хост " + (i + 1)}
                      onClick={() => {
                        removeRowErrors(["host", "ip"], i);
                        edit({
                          addHost: draft.addHost.filter((_, n) => n !== i),
                        });
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    edit({ addHost: [...draft.addHost, { host: "", ip: "" }] })
                  }
                >
                  Добавить хост
                </button>
              </section>
              <label className="build-proxy">
                Прокси
                <EnvironmentValueInput
                  secret
                  label="Прокси"
                  value={draft.proxy}
                  onInvalid={(message) =>
                    setInputErrors((prev) => ({ ...prev, proxy: message }))
                  }
                  onValue={(value) => {
                    clearInput("proxy");
                    edit({ proxy: value });
                  }}
                />
                <small>
                  HTTP/HTTPS URL. Учётные данные не показываются в сводке.
                </small>
              </label>
            </div>
          </details>
          <details className="build-group">
            <summary>
              Дополнительно <span>· контракты</span>
            </summary>
            <div className="build-group-body">
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.skipManifestCheck}
                  onChange={(e) =>
                    edit({ skipManifestCheck: e.target.checked })
                  }
                />
                Разрешить сборку с незакоммиченными контрактами
              </label>
              <p className="hint">
                Отключает проверку незакоммиченных CODEMANIFEST, а не проверку
                несохранённого редактора.
              </p>
            </div>
          </details>
          <div className="build-clean">
            {seed && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.update}
                  onChange={(event) => edit({ update: event.target.checked })}
                />
                Обновить образ перед сборкой
              </label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={draft.clean}
                onChange={(e) => edit({ clean: e.target.checked })}
              />
              Очистить состояние предыдущей сборки
            </label>
            <p className="hint">
              Начать заново, не продолжая предыдущую сборку. Перед запуском
              потребуется подтверждение.
            </p>
          </div>
          <div className="build-footer">
            <button type="button" onClick={onCancel}>
              Отмена
            </button>
            <span className="hint">Параметры только для этого запуска</span>
            <div className="build-launch-action">
              {showMissingReason && (
                <ActionReason id={reasonId} className="build-launch-reason">
                  План не найден. Выберите файл плана
                </ActionReason>
              )}
              <SplitLaunchButton
                disabled={disabled}
                busy={busy}
                dirty={false}
                context={draft}
                onLaunch={start}
                describedBy={showMissingReason ? reasonId : undefined}
              />
            </div>
          </div>
          {blocked && (
            <p className="hint">
              {typeof blocked === "string"
                ? blocked
                : "В этой рабочей копии уже выполняется сборка."}
            </p>
          )}
        </fieldset>
      </LoadingBoundary>
      {chooser && (
        <BuildFileChooser
          project={project}
          owner={owner}
          onClose={() => setChooser(false)}
          onSelect={(p) => {
            edit({ path: p });
            setChooser(false);
          }}
        />
      )}
      {preview && plan && (
        <TopicModal title="План сборки" onClose={() => setPreview(false)}>
          <p className="hint">{plan.path}</p>
          <pre className="build-plan-preview">{plan.text}</pre>
        </TopicModal>
      )}
      {confirmation && (
        <BuildCleanConfirmation
          onCancel={() => setConfirmation(null)}
          onConfirm={() =>
            void execute({ ...confirmation, confirmClean: true })
          }
        />
      )}
    </section>
  );
}
export function BuildCleanConfirmation({
  onCancel,
  onConfirm,
  busy = false,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <TopicModal
      title="Очистить состояние предыдущей сборки?"
      onClose={onCancel}
      busy={busy}
    >
      <p>
        Goga удалит сохранённое состояние предыдущей сборки для текущей ветки.
        Продолжить её с этого состояния уже не получится.
      </p>
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={onConfirm}
        >
          Очистить и запустить
        </button>
      </div>
    </TopicModal>
  );
}
function BuildFileChooser({
  project,
  owner,
  onSelect,
  onClose,
}: {
  project: Project;
  owner?: TopicContextRef;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [directory, setDirectory] = useState(""),
    [list, setList] = useState<BuildFileList | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const ownerKey = owner ? contextRequestKey(owner) : project.id;
  const scope = owner ? contextRef(owner) : project.id;
  const loadKey = JSON.stringify([ownerKey, directory, attempt]);
  const [settled, setSettled] = useState("");
  const read = useReadScope(loadKey);
  useEffect(() => {
    let alive = true;
    setList(null);
    setError("");
    read("listBuildFiles", scope, directory).then(
      (l) => {
        if (alive) {
          setList(l);
          setSettled(loadKey);
        }
      },
      (e) => {
        if (alive) {
          setError(buildPlanProblem(e).message);
          setSettled(loadKey);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [ownerKey, directory, attempt]);
  return (
    <TopicModal title="Выбрать план в проекте" onClose={onClose}>
      <LoadingBoundary pending={settled !== loadKey} label="Загружаем файлы…">
        <p className="hint">Только файлы текущего проекта</p>
        <div className="build-file-toolbar">
          <button
            type="button"
            disabled={!directory}
            onClick={() => setDirectory("")}
          >
            Корень проекта
          </button>
          <button
            type="button"
            disabled={!directory}
            onClick={() =>
              setDirectory(directory.split("/").slice(0, -1).join("/"))
            }
          >
            Назад
          </button>
        </div>
        <p className="build-file-location">
          {directory || "/ · " + project.name}
        </p>
        {error ? (
          <>
            <p className="error" role="alert">
              {error}
            </p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </button>
          </>
        ) : !list ? (
          <p role="status">Загружаем файлы…</p>
        ) : (
          <div className="build-file-list">
            {list.entries.map((e) => (
              <button
                type="button"
                key={e.path}
                aria-label={
                  (e.directory ? "Открыть папку " : "Выбрать ") + e.name
                }
                onClick={() =>
                  e.directory ? setDirectory(e.path) : onSelect(e.path)
                }
              >
                <span aria-hidden="true">{e.directory ? "▱" : "▤"}</span>
                <span>{e.name}</span>
                {e.directory && <span>›</span>}
              </button>
            ))}
            {list.entries.length === 0 && (
              <p className="hint">Нет доступных файлов</p>
            )}
          </div>
        )}
      </LoadingBoundary>
      <div className="form-actions">
        <button type="button" onClick={onClose}>
          Отмена
        </button>
      </div>
    </TopicModal>
  );
}
