import { TopicDivergence } from "./TopicDivergence";
import { TopicDeleteDialog } from "./TopicDeleteDialog";
import { TooltipButton } from "./RepositoryActions";
import "./ProjectContent.css";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { ActionReason } from "./ActionReason";
import { Fragment, useCallback, useEffect, useId, useState } from "react";
import type { Project } from "../shared/types";
import type { TopicContextIdentity, WorktreeRecord } from "../shared/worktrees";
import type { RunWithContext } from "./topic-context";
import type {
  TopicBoardRecord,
  TopicBoardSnapshot,
  TopicTarget,
} from "../shared/topics";
import {
  createTopicExplanation,
  defaultTopicFilters,
  filterTopicRows,
  topicRowActivity,
  type TopicCreateDraft,
  type TopicFilters,
  type TopicsStore,
} from "./topics-model";
import {
  TopicModal,
  TopicSwitch,
  TopicConfirmation,
  TopicFeedback,
  topicError,
  useTopicOperation,
} from "./TopicsCommon";
export function TopicsWorkspace({
  project,
  store,
  onOpenTopic,
  onChanged,
  onBusy,
  revision = "",
  runs = [],
  knownContexts = [],
  onOpenRun,
  selectedContext = null,
  onSelectTopic,
  ownerReadState = "confirmed",
  ownerReadError,
  disabled = false,
}: {
  project: Project;
  store: TopicsStore;
  ownerReadState?: "loading" | "error" | "confirmed";
  ownerReadError?: string;
  disabled?: boolean;
  onOpenTopic: (
    target: TopicTarget,
    year: string,
    board: TopicBoardSnapshot,
    host?: TopicBoardRecord,
  ) => void;
  onChanged: () => void;
  onBusy?: (busy: boolean) => void;
  revision?: string;
  runs?: RunWithContext[];
  knownContexts?: WorktreeRecord[];
  onOpenRun?: (id: string) => void;
  selectedContext?: TopicContextIdentity | null;
  onSelectTopic?: (identity: TopicContextIdentity) => void;
}) {
  const [year, setYear] = useState(
    store.years.get(project.id) ?? String(new Date().getFullYear()),
  );
  const [filters, setFilters] = useState(() => ({
    ...defaultTopicFilters(),
    ...store.filters.get(project.id),
    descriptions: false,
    perHost: false,
    remote: false,
  }));
  const [board, setBoard] = useState<TopicBoardSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [picker, setPicker] = useState<"topics" | "hosts" | "statuses" | null>(
    null,
  );
  const [create, setCreate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const markCreateBusy = useCallback(
    (value: boolean) => {
      setCreateBusy(value);
      onBusy?.(value);
    },
    [onBusy],
  );
  const [deleting, setDeleting] = useState<{
    target: TopicTarget;
    owner?: WorktreeRecord;
  } | null>(null);
  const key = JSON.stringify([project.id, year, revision, refresh]);
  const [settled, setSettled] = useState("");
  const read = useReadScope(key);
  const changed = () => {
    setRefresh((n) => n + 1);
    onChanged();
  };
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    if (!/^\d{4}$/.test(year)) {
      setError("Укажите год из четырёх цифр.");
      setLoading(false);
      setSettled(key);
      return;
    }
    read("readTopicTable", project.id, year)
      .then((next) => {
        if (!alive) return;
        if (next.projectId !== project.id || next.year !== year)
          throw Error("Ответ относится к другому проекту или году.");
        setBoard(next);
      })
      .catch((e) => {
        if (alive) setError(topicError(e));
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
          setSettled(key);
        }
      });
    return () => {
      alive = false;
    };
  }, [read, key, project.id, year]);
  function update(patch: Partial<TopicFilters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    store.filters.set(project.id, next);
  }
  const current = (r: TopicTarget) =>
    !!selectedContext &&
    !r.remote &&
    selectedContext.projectId === project.id &&
    selectedContext.year === year &&
    selectedContext.topic === r.topic &&
    selectedContext.branch === r.branch;
  const rows = board
    ? filterTopicRows(
        board,
        { ...filters, onlyActive: false },
        runs,
        knownContexts,
      )
        .filter(
          (row) =>
            !filters.onlyActive ||
            topicRowActivity(board, row, runs, knownContexts, true)
              .activeCount > 0,
        )
        .sort((a, b) => Number(current(b)) - Number(current(a)))
    : [];
  const pending = loading || settled !== key;
  const reasonId = useId();
  const createReasons = pending
    ? []
    : [
        ...(!board || error
          ? [
              !/^\d{4}$/.test(year)
                ? "Укажите год из четырёх цифр"
                : "Не удалось загрузить список топиков",
            ]
          : []),
        ...(!error && board?.active ? ["В проекте работает запуск"] : []),
        ...(createBusy ? ["Выполняется операция с топиками"] : []),
      ];
  const options =
    picker === "topics"
      ? (board?.entries.map((r) => r.topic) ?? [])
      : picker === "hosts"
        ? (board?.entries.flatMap((r) => r.hosts) ?? [])
        : (board?.entries.flatMap((r) => r.statuses) ?? []);
  return (
    <section
      className="topics-workspace project-content"
      aria-label="Топики проекта"
      aria-busy={pending}
    >
      <div className="topics-heading">
        <div>
          <h2>Топики</h2>
          <p className="hint">Задачи и их состояние</p>
        </div>
        <div className="topic-actions">
          {createReasons.length > 0 && (
            <ActionReason id={reasonId} className="topic-create-reason">
              {createReasons.map((text, i) => (
                <Fragment key={text}>
                  {i > 0 && "; "}
                  <span>{text}</span>
                </Fragment>
              ))}
            </ActionReason>
          )}
          <div className="topic-create-action">
            <button
              type="button"
              className="topic-refresh-button"
              aria-label="Обновить список"
              title="Обновить список"
              disabled={pending || createBusy}
              onClick={changed}
            >
              <span aria-hidden="true">↻</span>
            </button>
            <button
              type="button"
              className="primary"
              disabled={pending || createReasons.length > 0}
              aria-describedby={createReasons.length ? reasonId : undefined}
              onClick={() => setCreate(true)}
            >
              Создать топик
            </button>
          </div>
        </div>
      </div>
      <div className="topic-search-row">
        <label>
          Год
          <input
            aria-label="Год"
            inputMode="numeric"
            maxLength={4}
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              store.years.set(project.id, e.target.value);
            }}
          />
        </label>
        <label>
          Поиск топиков
          <input
            type="search"
            placeholder="Часть имени топика"
            value={filters.query}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
      </div>
      <div className="topic-filter-row">
        {(
          [
            ["topics", "Топики"],
            ["statuses", "Статусы"],
            ["hosts", "Размещение"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} disabled={!board} onClick={() => setPicker(key)}>
            {label} · {filters[key].length || "Все"} ▾
          </button>
        ))}
        <TopicSwitch
          checked={filters.onlyActive}
          onChange={() => update({ onlyActive: !filters.onlyActive })}
        >
          Только с активными запусками
        </TopicSwitch>
        <button
          className="quiet"
          onClick={() =>
            update({
              topics: [],
              statuses: [],
              hosts: [],
              query: "",
              onlyActive: false,
            })
          }
        >
          Сбросить фильтры
        </button>
      </div>
      <LoadingBoundary
        pending={pending}
        label="Загружаем топики…"
        error={error}
        onRetry={() => setRefresh((n) => n + 1)}
      >
        <div className="topic-table-wrap">
          <table className="topic-table topic-summary-table">
            <thead>
              <tr>
                <th>Топик</th>
                <th>Ветка</th>
                <th>Относительно base</th>
                <th>Статусы</th>
                <th>Активные запуски</th>
                <th>
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const activity = topicRowActivity(
                  board!,
                  r,
                  runs,
                  knownContexts,
                  true,
                );
                const matchingOwners = knownContexts.filter(
                  (owner) =>
                    !owner.deletedAt &&
                    owner.projectId === project.id &&
                    owner.year === year &&
                    owner.topic === r.topic &&
                    owner.branch === r.branch,
                );
                const target = {
                  topic: r.topic,
                  branch: r.branch,
                  remote: r.remote,
                };
                return (
                  <tr
                    key={JSON.stringify([r.topic, r.branch, r.remote])}
                    className={current(r) ? "topic-current-row" : ""}
                    aria-current={current(r) ? "true" : undefined}
                  >
                    <td>
                      <button
                        className="topic-link"
                        aria-label={`Открыть топик ${r.topic}`}
                        onClick={() => onOpenTopic(target, year, board!, r)}
                      >
                        {r.topic}
                      </button>
                    </td>
                    <td className="topic-branch">
                      <code>{r.branch}</code>
                    </td>
                    <td>
                      <TopicDivergence divergence={r.divergence} />
                    </td>
                    <td>
                      <div className="topic-statuses">
                        {r.statuses.length ? (
                          r.statuses.map((s) => (
                            <span className="topic-status" key={s}>
                              {s}
                            </span>
                          ))
                        ) : (
                          <span className="hint" title={r.statusError}>
                            —
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {activity.activeCount === 1 ? (
                        <TopicRunActivity
                          run={activity.activeRuns[0]!}
                          unverified={activity.unverifiedRunIds.includes(
                            activity.activeRuns[0]!.id,
                          )}
                          onOpenRun={onOpenRun}
                        />
                      ) : activity.activeCount > 1 ? (
                        <details className="topic-activity-choices">
                          <summary>
                            Активных: {activity.activeCount} · выбрать запуск
                          </summary>
                          {activity.activeRuns.map((run) => (
                            <TopicRunActivity
                              key={run.id}
                              run={run}
                              unverified={activity.unverifiedRunIds.includes(
                                run.id,
                              )}
                              onOpenRun={onOpenRun}
                            />
                          ))}
                        </details>
                      ) : (
                        <span className="hint">Нет активного</span>
                      )}
                    </td>
                    <td>
                      <div className="topic-row-actions">
                        {current(r) ? (
                          <span className="topic-selected-label">Текущий</span>
                        ) : (
                          <TooltipButton
                            disabled={disabled || !onSelectTopic || r.remote}
                            label={`Переключиться на топик ${r.topic}`}
                            tooltipLabel="Переключиться"
                            busy={false}
                            description="Открыть контекст топика"
                            onClick={() =>
                              onSelectTopic?.({
                                projectId: project.id,
                                year,
                                topic: r.topic,
                                branch: r.branch,
                              })
                            }
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              aria-hidden="true"
                            >
                              <path d="M4 12h12m-5-5 5 5-5 5M20 4v16" />
                            </svg>
                          </TooltipButton>
                        )}
                        <TooltipButton
                          disabled={
                            disabled ||
                            current(r) ||
                            matchingOwners.length > 1 ||
                            activity.activeCount > 0 ||
                            ownerReadState !== "confirmed"
                          }
                          label={`Удалить топик ${r.topic}`}
                          tooltipLabel="Удалить топик"
                          busy={false}
                          description={
                            matchingOwners.length > 1
                              ? "Выберите нужный рабочий контекст в селекторе топиков"
                              : ownerReadState !== "confirmed"
                                ? ownerReadError ||
                                  "Проверяем контексты топиков"
                                : current(r)
                                  ? "Сначала выберите другой топик"
                                  : activity.activeCount
                                    ? "Сначала завершите запуски топика"
                                    : "Удаление после подтверждения"
                          }
                          buttonClassName="repository-action-button topic-delete-icon"
                          onClick={() =>
                            setDeleting({ target, owner: matchingOwners[0] })
                          }
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
                          </svg>
                        </TooltipButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <p className="topic-empty">
            {filters.onlyActive
              ? "Нет топиков с активными запусками по выбранным условиям."
              : board?.entries.length
                ? "Нет топиков по выбранным условиям."
                : "За этот год топиков пока нет."}
          </p>
        )}
      </LoadingBoundary>
      {picker && (
        <TopicPicker
          kind={picker}
          options={[...new Set(options)].sort()}
          values={filters[picker]}
          onClose={() => setPicker(null)}
          onApply={(values) => {
            update({ [picker]: values });
            setPicker(null);
          }}
        />
      )}
      {create && (
        <TopicCreateLoader
          project={project}
          year={year}
          store={store}
          onClose={() => setCreate(false)}
          onChanged={changed}
          onBusy={markCreateBusy}
        />
      )}
      {deleting && (
        <TopicDeleteDialog
          project={project}
          year={year}
          target={deleting.target}
          owner={deleting.owner}
          current={current(deleting.target)}
          active={
            !!board &&
            topicRowActivity(
              board,
              deleting.target as TopicBoardRecord,
              runs,
              knownContexts,
              true,
            ).activeCount > 0
          }
          onClose={() => setDeleting(null)}
          onChanged={changed}
          onBusy={markCreateBusy}
        />
      )}
    </section>
  );
}

function TopicCreateLoader(props: {
  project: Project;
  year: string;
  store: TopicsStore;
  onClose: () => void;
  onChanged: () => void;
  onBusy?: (v: boolean) => void;
}) {
  const read = useReadScope(
    JSON.stringify(["create", props.project.id, props.year]),
  );
  const [board, setBoard] = useState<TopicBoardSnapshot | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    read("readTopicBoard", props.project.id, props.year)
      .then((b) => {
        if (b.projectId !== props.project.id || b.year !== props.year)
          throw Error(
            "Параметры создания относятся к другому проекту или году.",
          );
        if (alive) setBoard(b);
      })
      .catch((e) => {
        if (alive) setError(topicError(e));
      });
    return () => {
      alive = false;
    };
  }, [read, props.project.id, props.year]);
  return board ? (
    <TopicCreate {...props} board={board} />
  ) : (
    <TopicModal title="Создать топик" onClose={props.onClose}>
      <LoadingBoundary
        pending={!error}
        label="Проверяем параметры создания…"
        error={error}
      >
        {null}
      </LoadingBoundary>
    </TopicModal>
  );
}

function TopicRunActivity({
  run,
  unverified,
  onOpenRun,
}: {
  run: RunWithContext;
  unverified: boolean;
  onOpenRun?: (id: string) => void;
}) {
  const status = unverified
    ? "Требует проверки"
    : run.status === "starting"
      ? "Запускается"
      : "Работает";
  const kind = run.kind === "build" ? "Сборка" : "Конвейер";
  return (
    <button
      type="button"
      className={`topic-link topic-run-activity${unverified ? " topic-run-unverified" : ""}`}
      aria-label={`Открыть запуск ${run.id} · ${kind} · ${status}`}
      title={`${kind} · ${run.id}`}
      disabled={!onOpenRun}
      onClick={() => onOpenRun?.(run.id)}
    >
      <span aria-hidden="true">●</span> {status} →<small>{kind}</small>
    </button>
  );
}
function TopicPicker({
  kind,
  options,
  values,
  onApply,
  onClose,
}: {
  kind: "topics" | "hosts" | "statuses";
  options: string[];
  values: string[];
  onApply: (next: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [chosen, setChosen] = useState(values);
  const title =
      kind === "topics"
        ? "Топики"
        : kind === "hosts"
          ? "Ветки размещения"
          : "Статусы",
    search =
      kind === "topics"
        ? "Найти топик"
        : kind === "hosts"
          ? "Найти ветку"
          : "Найти статус";
  return (
    <TopicModal title={title} onClose={onClose}>
      <label>
        {search}
        <input
          type="search"
          aria-label={search}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="topic-picker-options">
        {[...new Set([...options, ...values])]
          .filter((s) =>
            s.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )
          .map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={chosen.includes(s)}
                onChange={(e) =>
                  setChosen(
                    e.target.checked
                      ? [...chosen, s]
                      : chosen.filter((x) => x !== s),
                  )
                }
              />
              {s}
            </label>
          ))}
      </div>
      <p className="hint">
        Поиск меняет только список вариантов. Внутри группы действует «или»,
        между группами — «и».
      </p>
      <div className="form-actions">
        <button type="button" onClick={() => setChosen([])}>
          Все
        </button>
        <button type="button" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => onApply(chosen)}
        >
          Применить
        </button>
      </div>
    </TopicModal>
  );
}
function TopicCreate({
  project,
  board,
  store,
  onClose,
  onChanged,
  onBusy,
}: {
  project: Project;
  board: TopicBoardSnapshot;
  store: TopicsStore;
  onClose: () => void;
  onChanged: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const key = JSON.stringify([project.id, board.year]);
  const [draft, setDraft] = useState<TopicCreateDraft>(
    store.creates.get(key) ?? {
      branch: "",
      task: "",
      baseRef: board.baseRef,
      publish: true,
      switch: false,
      commit: "",
    },
  );
  const [done, setDone] = useState(false);
  const operation = useTopicOperation(key, onChanged, onBusy);
  function edit(patch: Partial<TopicCreateDraft>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    store.creates.set(key, next);
  }
  return (
    <TopicModal title="Создать топик" busy={operation.busy} onClose={onClose}>
      <TopicFeedback operation={operation} />
      {operation.plan ? (
        <TopicConfirmation
          operation={operation}
          onSuccess={() => {
            store.creates.delete(key);
            setDone(true);
          }}
        />
      ) : (
        !done && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void operation.prepare({
                projectId: project.id,
                year: board.year,
                expectedRevision: board.revision,
                action: "create",
                ...draft,
                commit: draft.publish ? draft.commit : undefined,
              });
            }}
          >
            <fieldset disabled={operation.busy || board.active}>
              <label>
                Имя ветки / топика
                <input
                  autoFocus
                  required
                  autoComplete="off"
                  placeholder="feature/my-topic"
                  value={draft.branch}
                  onChange={(e) => edit({ branch: e.target.value })}
                />
              </label>
              <p className="hint">
                Имя топика будет получено из имени ветки по правилам Goga.
              </p>
              <label>
                Задача
                <textarea
                  rows={5}
                  required={draft.publish || !draft.switch}
                  value={draft.task}
                  onChange={(e) => edit({ task: e.target.value })}
                />
              </label>
              <label>
                Базовая ветка
                <input
                  required
                  list="topic-create-bases"
                  value={draft.baseRef}
                  onChange={(e) => edit({ baseRef: e.target.value })}
                />
                <datalist id="topic-create-bases">
                  {board.branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </label>
              <h3>После создания</h3>
              <div className="topic-create-switches">
                <TopicSwitch
                  checked={draft.publish}
                  onChange={() => edit({ publish: !draft.publish })}
                >
                  Опубликовать
                </TopicSwitch>
                <TopicSwitch
                  checked={draft.switch}
                  onChange={() => edit({ switch: !draft.switch })}
                >
                  Переключиться на новый топик
                </TopicSwitch>
              </div>
              {draft.publish && (
                <label>
                  Сообщение коммита · необязательно
                  <input
                    value={draft.commit}
                    onChange={(e) => edit({ commit: e.target.value })}
                    placeholder="Из настроек проекта"
                  />
                </label>
              )}
              <p className="topic-warning" aria-live="polite">
                {createTopicExplanation(draft.publish, draft.switch)}
              </p>
              <div className="form-actions">
                <button type="button" onClick={onClose}>
                  Отмена
                </button>
                <button type="submit" className="primary">
                  {operation.busy ? "Проверяем…" : "Продолжить"}
                </button>
              </div>
            </fieldset>
          </form>
        )
      )}
    </TopicModal>
  );
}
