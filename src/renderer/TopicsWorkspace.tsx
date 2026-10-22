import { useReadScope } from "./read-request";
import { LoadingBoundary, LoadingState } from "./LoadingBoundary";
import { ActionReason } from "./ActionReason";
import { Fragment, useEffect, useId, useRef, useState } from "react";
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
  ownTopicTarget,
  topicPlacements,
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
  selectedContext,
}: {
  project: Project;
  store: TopicsStore;
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
}) {
  const [year, setYear] = useState(
      store.years.get(project.id) ?? String(new Date().getFullYear()),
    ),
    [filters, setFilters] = useState<TopicFilters>(
      store.filters.get(project.id) ?? defaultTopicFilters(),
    );
  const [board, setBoard] = useState<TopicBoardSnapshot | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [create, setCreate] = useState(false),
    [picker, setPicker] = useState<"topics" | "hosts" | "statuses" | null>(
      null,
    ),
    [selected, setSelected] = useState<string[]>([]),
    [bulk, setBulk] = useState(false);
  const loadKey = JSON.stringify([project.id, year, refresh, revision]);
  const [settled, setSettled] = useState("");
  const epoch = useRef(0);
  const changed = () => {
    setRefresh((n) => n + 1);
    setSelected([]);
    onChanged();
  };
  const read = useReadScope(
    JSON.stringify([project.id, year, refresh, revision]),
  );
  const operation = useTopicOperation(`${project.id}/${year}`, changed, onBusy);
  useEffect(() => {
    const id = ++epoch.current;
    setLoading(true);
    setError("");
    setBoard((previous) =>
      previous?.year === year && previous.projectId === project.id
        ? previous
        : null,
    );
    if (board?.projectId !== project.id || board?.year !== year)
      setSelected([]);
    if (!/^\d{4}$/.test(year)) {
      setError("Укажите год из четырёх цифр.");
      setLoading(false);
      setSettled(loadKey);
      return;
    }
    read("readTopicBoard", project.id, year)
      .then(
        (next) => {
          if (id === epoch.current) {
            setBoard(next);
            setSelected((values) =>
              values.filter((t) =>
                [...next.records, ...next.remoteRecords].some(
                  (r) => r.topic === t,
                ),
              ),
            );
          }
        },
        (e) => {
          if (id === epoch.current) setError(topicError(e));
        },
      )
      .finally(() => {
        if (id === epoch.current) {
          setLoading(false);
          setSettled(loadKey);
        }
      });
    return () => {
      epoch.current++;
    };
  }, [project.id, year, refresh, revision]);
  function update(patch: Partial<TopicFilters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    store.filters.set(project.id, next);
    setSelected([]);
  }
  const rows = board
    ? filterTopicRows(board, filters, runs, knownContexts)
    : [];
  const source = board
    ? filters.remote
      ? board.remoteRecords
      : board.records
    : [];
  const options =
    picker === "topics"
      ? [...new Set(source.map((r) => r.topic))]
      : picker === "hosts"
        ? [...new Set(source.map((r) => r.branch))]
        : [...new Set(source.flatMap((r) => r.statuses))];
  const boardLoading = loading || settled !== loadKey;
  const blocked = boardLoading || !!board?.active;
  const deleteBlocked = boardLoading || !!board?.active || !!error;
  const createReasonId = useId();
  // Explain the existing guard only after this project's board has settled.
  // A refresh must not present the retained snapshot's reasons as current.
  const createReasons = boardLoading
    ? []
    : [
        ...(!board
          ? [
              !/^\d{4}$/.test(year)
                ? "укажите год из четырёх цифр"
                : error
                  ? "не удалось загрузить список топиков"
                  : "список топиков не загружен",
            ]
          : []),
        ...(board?.active ? ["в проекте работает запуск"] : []),
        ...(operation.busy ? ["выполняется операция с топиками"] : []),
      ];
  const createReasonTexts = createReasons.map(
    (reason) => reason[0].toUpperCase() + reason.slice(1),
  );
  return (
    <section
      className="topics-workspace"
      aria-label="Топики проекта"
      aria-busy={boardLoading}
    >
      <div className="topics-heading">
        <div>
          <h2>Топики</h2>
          <p className="hint">Задачи и их состояние в ветках проекта</p>
        </div>
        <div className="topic-actions">
          {createReasons.length > 0 && (
            <ActionReason id={createReasonId} className="topic-create-reason">
              {createReasonTexts.map((text, index) => (
                <Fragment key={text}>
                  {index > 0 && "; "}
                  <span>{text}</span>
                </Fragment>
              ))}
              {board && error && (
                <>
                  . По последней успешной загрузке; обновить список топиков не
                  удалось.
                </>
              )}
            </ActionReason>
          )}
          <div className="topic-create-action">
            <button
              type="button"
              className="topic-refresh-button"
              title="Обновить список"
              aria-label="Обновить список"
              disabled={loading || operation.busy}
              onClick={() => {
                setRefresh((n) => n + 1);
                onChanged();
              }}
            >
              <span aria-hidden="true">↻</span>
            </button>
            <button
              type="button"
              className="primary"
              disabled={!board || blocked || operation.busy}
              aria-describedby={
                createReasons.length > 0 ? createReasonId : undefined
              }
              onClick={() => setCreate(true)}
            >
              Создать топик
            </button>
          </div>
        </div>
      </div>
      <LoadingBoundary pending={boardLoading} label="Загружаем топики…">
        <div className="topic-search-row">
          <label>
            Год
            <input
              aria-label="Год"
              type="text"
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
        <div className="topic-switches">
          <TopicSwitch
            checked={filters.descriptions}
            onChange={() => update({ descriptions: !filters.descriptions })}
          >
            Описания задач
          </TopicSwitch>
          <TopicSwitch
            checked={filters.perHost}
            onChange={() => update({ perHost: !filters.perHost })}
          >
            Состояния по веткам
          </TopicSwitch>
          <TopicSwitch
            checked={filters.remote}
            onChange={() => update({ remote: !filters.remote })}
          >
            Только удалённые ветки
          </TopicSwitch>
          <TopicSwitch
            checked={!!filters.onlyActive}
            onChange={() => update({ onlyActive: !filters.onlyActive })}
          >
            Только с активными запусками
          </TopicSwitch>
        </div>
        <p className="hint">
          {filters.perHost
            ? "Один топик может быть в нескольких ветках: каждая строка показывает задачу и статусы именно в указанной ветке."
            : "Одна строка на топик: задача и статусы в собственной ветке."}{" "}
          {filters.remote &&
            "Используются известные удалённые ветки; обновление с сервера не выполняется."}
        </p>
        <div className="topic-filter-row">
          {(
            [
              ["topics", "Топики"],
              ["hosts", "Ветки размещения"],
              ["statuses", "Статусы"],
            ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              disabled={!board}
              onClick={() => setPicker(key)}
            >
              {label} · {filters[key].length || "Все"} ▾
            </button>
          ))}
          <button
            type="button"
            className="quiet"
            onClick={() =>
              update({
                topics: [],
                hosts: [],
                statuses: [],
                query: "",
                onlyActive: false,
              })
            }
          >
            Сбросить фильтры
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {error && (
          <button onClick={() => setRefresh((n) => n + 1)}>
            Повторить загрузку
          </button>
        )}
        {board && (
          <>
            <div className="topic-selection">
              <span>
                {rows.length} строк · выбрано топиков: {selected.length}
              </span>
              {selected.length > 0 && (
                <>
                  <button type="button" onClick={() => setSelected([])}>
                    Снять выбор
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={
                      deleteBlocked ||
                      operation.busy ||
                      selected.includes(board.currentTopic?.topic ?? "")
                    }
                    onClick={() => {
                      setBulk(true);
                      void operation.prepare({
                        projectId: project.id,
                        year,
                        expectedRevision: board.revision,
                        action: "delete",
                        topics: selected,
                      });
                    }}
                  >
                    Удалить выбранные…
                  </button>
                </>
              )}
            </div>
            <div className="topic-table-wrap">
              <table className="topic-table">
                <thead>
                  <tr>
                    <th className="topic-select-cell">
                      <input
                        type="checkbox"
                        aria-label="Выбрать все показанные топики"
                        checked={
                          rows.length > 0 &&
                          rows.every((r) => selected.includes(r.topic))
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...new Set(rows.map((r) => r.topic))]
                              : [],
                          )
                        }
                      />
                    </th>
                    <th>Топик</th>
                    <th>
                      {filters.perHost
                        ? "Ветка размещения"
                        : "Собственная ветка"}
                    </th>
                    <th>Статусы</th>
                    <th>Запуск</th>
                    <th>
                      <span className="sr-only">Расположение</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const marker =
                      selectedContext ??
                      (board.currentTopic
                        ? {
                            projectId: board.projectId,
                            year: board.year,
                            topic: board.currentTopic.topic,
                            branch: board.currentTopic.branch,
                          }
                        : null);
                    const ownTarget = ownTopicTarget(board, r.topic);
                    const current = Boolean(
                      marker &&
                      !r.remote &&
                      marker.projectId === board.projectId &&
                      marker.year === board.year &&
                      marker.topic === r.topic &&
                      ownTarget &&
                      !ownTarget.remote &&
                      marker.branch === ownTarget.branch &&
                      (!filters.perHost || r.branch === marker.branch),
                    );
                    const activity = topicRowActivity(
                      board,
                      r,
                      runs,
                      knownContexts,
                    );
                    return (
                      <Fragment key={`${r.topic}/${r.branch}/${r.remote}/${i}`}>
                        <tr
                          className={current ? "topic-current-row" : ""}
                          aria-current={current ? "true" : undefined}
                        >
                          <td className="topic-select-cell">
                            <input
                              type="checkbox"
                              aria-label={`Выбрать топик ${r.topic} в ${r.branch}`}
                              checked={selected.includes(r.topic)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...new Set([...selected, r.topic])]
                                    : selected.filter((t) => t !== r.topic),
                                )
                              }
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="topic-link"
                              aria-label={`Открыть топик ${r.topic}`}
                              onClick={() =>
                                onOpenTopic(
                                  ownTopicTarget(board, r.topic) ?? r,
                                  year,
                                  board,
                                  r,
                                )
                              }
                            >
                              {r.topic}
                            </button>
                            {current && (
                              <span className="sr-only">
                                Текущий топик проекта
                              </span>
                            )}
                            {filters.descriptions && (
                              <p className="topic-description">
                                {r.todo || "Задача не задана"}
                              </p>
                            )}
                          </td>
                          <td className="topic-branch">
                            {r.branch}
                            {r.remote && <small>Удалённая ветка</small>}
                            {r.divergence && <small>{r.divergence}</small>}
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
                                <span className="hint">Без статуса</span>
                              )}
                            </div>
                          </td>
                          <td className="topic-activity-cell">
                            {activity.activeCount ? (
                              activity.activeCount === 1 ? (
                                <TopicRunActivity
                                  run={activity.activeRuns[0]!}
                                  unverified={activity.unverifiedRunIds.includes(
                                    activity.activeRuns[0]!.id,
                                  )}
                                  onOpenRun={onOpenRun}
                                />
                              ) : (
                                <details className="topic-activity-choices">
                                  <summary>
                                    Активных: {activity.activeCount} · выбрать
                                    запуск
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
                              )
                            ) : (
                              <span className="hint">Нет активного</span>
                            )}
                          </td>
                          <td>
                            <details className="topic-placements">
                              <summary>Где находится</summary>
                              <p className="hint">
                                Все известные размещения этого топика,
                                независимо от фильтров. Просмотр не переключает
                                ветку.
                              </p>
                              {topicPlacements(board, r.topic).map((p) => (
                                <div key={`${p.branch}/${p.remote}`}>
                                  <strong>{p.branch}</strong>
                                  <span>
                                    {p.statuses.join(" · ") || "Без статуса"}
                                  </span>
                                  {filters.descriptions && (
                                    <small>
                                      {p.todo || "Задача не задана"}
                                    </small>
                                  )}
                                </div>
                              ))}
                            </details>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <p className="topic-empty">
                {filters.onlyActive
                  ? "Нет топиков с активными запусками по выбранным условиям."
                  : board.entries.length || board.remoteEntries.length
                    ? "Нет топиков по выбранным условиям."
                    : "За этот год топиков пока нет."}
              </p>
            )}
          </>
        )}
        {board?.active && (
          <p className="topic-warning">
            В проекте работает запуск. Просмотр доступен, изменения топиков —
            после его завершения.
          </p>
        )}
        {board?.dirty && (
          <p className="hint">
            Есть незакоммиченные изменения. Переключение ветки и обновление
            текущего топика требуют чистой рабочей копии. Удаление других
            топиков доступно после подтверждения.
          </p>
        )}
      </LoadingBoundary>
      {picker && (
        <TopicPicker
          kind={picker}
          options={options.sort()}
          values={filters[picker]}
          onClose={() => setPicker(null)}
          onApply={(values) => {
            update({ [picker]: values });
            setPicker(null);
          }}
        />
      )}
      {create && board && (
        <TopicCreate
          project={project}
          board={board}
          store={store}
          onClose={() => setCreate(false)}
          onChanged={changed}
          onBusy={onBusy}
        />
      )}
      {bulk && (
        <TopicModal
          title="Удалить выбранные топики"
          busy={operation.busy}
          onClose={() => {
            setBulk(false);
            operation.cancel();
          }}
        >
          {operation.plan ? (
            <TopicConfirmation operation={operation} />
          ) : operation.busy ? (
            <LoadingState label="Проверяем последствия удаления…" />
          ) : null}
          <TopicFeedback operation={operation} />
        </TopicModal>
      )}
    </section>
  );
}

function TopicRunActivity({
  run,
  unverified,
  onOpenRun,
  selectedContext,
}: {
  run: RunWithContext;
  unverified: boolean;
  onOpenRun?: (id: string) => void;
  selectedContext?: TopicContextIdentity | null;
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
