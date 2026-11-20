import { HintButton } from "./ActionHint";
import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { Trash2 } from "lucide-react";
import { TopicsRemovalDialog } from "./TopicsRemovalDialog";
import { LayoutGrid, List } from "lucide-react";
import { TopicsBoard } from "./TopicsBoard";
import { useTopicsBoard } from "./useTopicsBoard";
import { TopicTableCache } from "./topic-table-cache";
import { useTopicTableYear } from "./use-topic-table-cache";
import { useViewActive } from "./RetainedViews";
import {
  topicSelectionKey,
  columnChecked,
  toggleColumn,
} from "./topics-board-model";
import { TopicDivergence } from "./TopicDivergence";
import { TopicDeleteDialog } from "./TopicDeleteDialog";
import { TooltipButton } from "./RepositoryActions";
import "./ProjectContent.css";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { ActionReason } from "./ActionReason";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Project } from "../shared/types";
import type { TopicContextIdentity, WorktreeRecord } from "../shared/worktrees";
import { contextRunActivity, type RunWithContext } from "./topic-context";
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
  indexTopicTableOwners,
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
const emptyRuns: RunWithContext[] = [];
const emptyOwners: WorktreeRecord[] = [];
const LARGE_TABLE_ROWS = 200;

export function TopicsWorkspace({
  project,
  store,
  tableCache,
  onRefreshRelated,
  onOpenTopic,
  onChanged,
  onBusy,
  revision = "",
  runs = emptyRuns,
  knownContexts = emptyOwners,
  onOpenRun,
  selectedContext = null,
  onSelectTopic,
  ownerReadState = "confirmed",
  ownerReadError,
  disabled = false,
}: {
  project: Project;
  store: TopicsStore;
  tableCache?: TopicTableCache;
  onRefreshRelated?: () => void;
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
  useLocale();
  const year = useTopicTableYear(store, project.id);
  const scope = useMemo(
    () => ({ projectId: project.id, path: project.path, year }),
    [project.id, project.path, year],
  );
  const cache = useMemo(
    () => tableCache ?? new TopicTableCache(),
    [tableCache],
  );
  const visible = useViewActive();
  const subscribe = useCallback(
    (listener: () => void) =>
      visible ? cache.subscribe(scope, listener) : () => {},
    [cache, scope, visible],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    cache.getSnapshot(scope),
  );
  const { board, loading, polling } = snapshot;
  const validYear = /^\d{4}$/.test(year);
  const error = !validYear
    ? tr("topics.enterAFourDigitYear")
    : loading && !polling
      ? ""
      : snapshot.error;
  const cold = !board && !error;
  // Standalone consumers own their cache for as long as the view is visible;
  // the application always supplies its own, already active project reader.
  useEffect(() => {
    if (tableCache || !visible) return;
    cache.activate(scope);
    return () => cache.activate(null);
  }, [cache, scope, tableCache, visible]);
  const previous = useRef({ scope, revision });
  useEffect(() => {
    if (
      !tableCache &&
      previous.current.scope === scope &&
      previous.current.revision !== revision
    )
      cache.invalidate(scope);
    previous.current = { scope, revision };
  }, [cache, scope, tableCache, revision]);
  const [filters, setFilters] = useState(() => ({
    ...defaultTopicFilters(),
    ...store.filters.get(project.id),
    descriptions: false,
    perHost: false,
    remote: false,
  }));
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
  const [removing, setRemoving] = useState<{
    action: "delete" | "clear";
    topics: string[];
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    target: TopicTarget;
    owner?: WorktreeRecord;
  } | null>(null);
  const refreshTable = () => {
    if (!loading) onRefreshRelated?.();
    void cache.refresh(scope);
  };
  const changed = () => {
    if (!tableCache) cache.invalidate(scope);
    onChanged();
  };
  function update(patch: Partial<TopicFilters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    store.filters.set(project.id, next);
  }
  const current = useCallback(
    (r: TopicTarget) =>
      !!selectedContext &&
      !r.remote &&
      selectedContext.projectId === project.id &&
      selectedContext.year === year &&
      selectedContext.topic === r.topic &&
      selectedContext.branch === r.branch,
    [selectedContext, project.id, year],
  );
  const exactRow = useMemo(
    () => indexTopicTableOwners(board, runs, knownContexts),
    [board, runs, knownContexts],
  );
  const rows = useMemo(
    () =>
      board
        ? filterTopicRows(board, { ...filters, onlyActive: false })
            .filter(
              (row) =>
                !filters.onlyActive || exactRow(row).activity.activeCount > 0,
            )
            .sort((a, b) => Number(current(b)) - Number(current(a)))
        : [],
    [board, filters, current, exactRow],
  );
  const boardUI = useTopicsBoard(project.id, year, board);
  // Reuse a bounded, already displayed native table for live text filtering.
  // No extra rows are mounted on first paint (including a restored filter).
  // Hidden text/controls leave find, Tab order and the accessibility tree.
  const fullTable = useRef<{
    board: TopicBoardSnapshot;
    rows: TopicBoardRecord[];
    current: typeof current;
  } | null>(null);
  const retainable =
    boardUI.preferences.view === "table" &&
    !!board &&
    board.entries.length >= LARGE_TABLE_ROWS &&
    board.entries.length <= 2000;
  useLayoutEffect(() => {
    if (
      !retainable ||
      fullTable.current?.board !== board ||
      fullTable.current.current !== current
    )
      fullTable.current = null;
    if (retainable && board && rows.length === board.entries.length)
      fullTable.current = { board, rows, current };
  }, [retainable, rows, board, current]);
  const tableRows =
    retainable &&
    fullTable.current?.board === board &&
    fullTable.current.current === current
      ? fullTable.current.rows
      : rows;
  const visibleRows = useMemo(
    () => (tableRows === rows ? null : new Set(rows)),
    [rows, tableRows],
  );
  const actionsFor = useCallback(
    (r: TopicBoardRecord, hidden = false) => {
      const { activity, owners: matchingOwners } = exactRow(r);
      const target = { topic: r.topic, branch: r.branch, remote: r.remote };
      return (
        <div className="topic-row-actions">
          {current(r) ? (
            <span className="topic-selected-label">{tr("topics.current")}</span>
          ) : (
            <TooltipButton
              tooltipEnabled={!hidden}
              disabled={disabled || !onSelectTopic || r.remote}
              label={tr("topics.switchToTopicTopic", { topic: r.topic })}
              tooltipLabel={tr("topics.switch")}
              busy={false}
              description={tr("topics.openTopicContext")}
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
            tooltipEnabled={!hidden}
            disabled={
              disabled ||
              matchingOwners.length > 1 ||
              (!matchingOwners.length && current(r)) ||
              activity.activeCount > 0 ||
              ownerReadState !== "confirmed"
            }
            label={tr("topics.deleteTopicTopic", { topic: r.topic })}
            tooltipLabel={tr("topics.deleteTopic2")}
            busy={false}
            description={
              matchingOwners.length > 1
                ? tr("topics.chooseTheWorkingContextInTheTopicPicker")
                : ownerReadState !== "confirmed"
                  ? ownerReadError || tr("topics.checkingTopicContexts")
                  : activity.activeCount
                    ? tr("topics.finishTheTopicSRunsFirst2")
                    : tr("topics.removalRequiresConfirmation")
            }
            buttonClassName="repository-action-button topic-delete-icon"
            onClick={() =>
              setRemoving({ action: "delete", topics: [target.topic] })
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
      );
    },
    [
      exactRow,
      current,
      project.id,
      year,
      onSelectTopic,
      disabled,
      ownerReadState,
      ownerReadError,
    ],
  );
  const activityFor = useCallback(
    (r: TopicBoardRecord) => {
      const { activity } = exactRow(r);
      return (
        <>
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
              <summary>{tr("topics.active")}{activity.activeCount}{tr("topics.selectRun")}</summary>
              {activity.activeRuns.map((run) => (
                <TopicRunActivity
                  key={run.id}
                  run={run}
                  unverified={activity.unverifiedRunIds.includes(run.id)}
                  onOpenRun={onOpenRun}
                />
              ))}
            </details>
          ) : (
            <span className="hint">{tr("topics.noneActive")}</span>
          )}
        </>
      );
    },
    [exactRow, onOpenRun],
  );
  const openRow = useCallback(
    (r: TopicBoardRecord) => {
      if (board)
        onOpenTopic(
          { topic: r.topic, branch: r.branch, remote: r.remote },
          year,
          board,
          r,
        );
    },
    [board, year, onOpenTopic],
  );
  const visibleKeys = useMemo(
    () => rows.map((r) => topicSelectionKey(project.id, year, r.topic)),
    [rows, project.id, year],
  );
  const tableKeys = useMemo(
    () => tableRows.map((r) => topicSelectionKey(project.id, year, r.topic)),
    [tableRows, project.id, year],
  );
  const visibleSet = useMemo(() => new Set(visibleKeys), [visibleKeys]);
  const hiddenSelection = [...boardUI.selected].filter(
    (key) => !visibleSet.has(key),
  ).length;
  const pending = cold || (loading && !polling);
  const pendingDeletions = knownContexts.filter(
    (owner) => owner.projectId === project.id && owner.deletedAt,
  );
  const reasonId = useId();
  const createReasons = pending
    ? []
    : [
        ...(!board || error
          ? [
              !/^\d{4}$/.test(year)
                ? tr("topics.enterAFourDigitYear2")
                : tr("topics.couldNotLoadTopics"),
            ]
          : []),
        ...(!error && board?.active ? [tr("topics.aRunIsActiveInTheProject")] : []),
        ...(createBusy ? [tr("topics.topicOperationInProgress")] : []),
      ];
  const options = !picker
    ? []
    : picker === "topics"
      ? (board?.entries.map((r) => r.topic) ?? [])
      : picker === "hosts"
        ? (board?.entries.flatMap((r) => r.hosts) ?? [])
        : (board?.entries.flatMap((r) => r.statuses) ?? []);
  return (
    <section
      className="topics-workspace project-content"
      data-retain-layout={
        boardUI.preferences.view === "table" &&
        tableRows.length >= LARGE_TABLE_ROWS &&
        !cold &&
        !picker &&
        !create &&
        !deleting &&
        !removing
          ? ""
          : undefined
      }
      aria-label={tr("topics.projectTopics")}
      aria-busy={pending}
    >
      <div className="topics-heading">
        <div>
          <h2>{tr("topics.topics")}</h2>
          <p className="hint">{tr("topics.tasksAndTheirStatus")}</p>
        </div>
        <div className="topic-actions">
          <div
            className="topic-view-switch"
            role="group"
            aria-label={tr("topics.topicView")}
          >
            <button
              type="button"
              aria-pressed={boardUI.preferences.view === "table"}
              onClick={() =>
                boardUI.onPreferences({ ...boardUI.preferences, view: "table" })
              }
            >
              <List />{tr("topics.table")}</button>
            <button
              type="button"
              aria-pressed={boardUI.preferences.view === "board"}
              onClick={() =>
                boardUI.onPreferences({ ...boardUI.preferences, view: "board" })
              }
            >
              <LayoutGrid />{tr("topics.board")}</button>
          </div>
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
            <HintButton
              type="button"
              className="topic-refresh-button"
              aria-label={tr("topics.refreshList")}
              hint={tr("topics.refreshList")}
              disabled={!validYear || cold || loading || createBusy}
              onClick={refreshTable}
            >
              {loading && board ? (
                <span role="status" aria-label={tr("topics.refreshingTopics")}>
                  <span className="loading-spinner" aria-hidden="true" />
                </span>
              ) : (
                <span aria-hidden="true">↻</span>
              )}
            </HintButton>
            <button
              type="button"
              className="primary"
              disabled={pending || createReasons.length > 0}
              aria-describedby={createReasons.length ? reasonId : undefined}
              onClick={() => setCreate(true)}
            >{tr("topics.createTopic")}</button>
          </div>
        </div>
      </div>
      <div className="topic-search-row">
        <label>{tr("topics.year")}<input
            aria-label={tr("topics.year")}
            inputMode="numeric"
            maxLength={4}
            value={year}
            onChange={(e) => store.setYear(project.id, e.target.value)}
          />
        </label>
        <label>{tr("topics.searchTopics")}<input
            type="search"
            placeholder={tr("topics.partOfTopicName")}
            value={filters.query}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
      </div>
      <div className="topic-filter-row">
        {(
          [
            ["topics", tr("topics.topics")],
            ["statuses", tr("topics.statuses")],
            ["hosts", tr("topics.location")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            data-active={filters[key].length > 0}
            disabled={!board}
            onClick={() => setPicker(key)}
          >
            {label} · {filters[key].length || tr("topics.all")} ▾
          </button>
        ))}
        <TopicSwitch
          checked={filters.onlyActive}
          onChange={() => update({ onlyActive: !filters.onlyActive })}
        >{tr("topics.onlyWithActiveRuns")}</TopicSwitch>
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
        >{tr("topics.resetFilters")}</button>
        <div className="topic-filter-clear">
          <button
            type="button"
            disabled={
              pending || createBusy || !board || ownerReadState !== "confirmed"
            }
            onClick={() => setRemoving({ action: "clear", topics: [] })}
          >
            <Trash2 size={14} />{tr("topics.clearTopics2")}</button>
        </div>
      </div>
      {boardUI.error && (
        <p role="alert" className="error">
          {boardUI.error}
        </p>
      )}
      {boardUI.selected.size > 0 && (
        <div className="topic-selection">
          <span>{tr("topics.selected")}{boardUI.selected.size}
            {hiddenSelection > 0
              ? tr("topics.hiddenByFiltersHiddenselection", { hiddenSelection: hiddenSelection })
              : ""}
          </span>
          <button type="button" onClick={() => boardUI.onSelection(new Set())}>{tr("topics.clearSelection")}</button>
          <button
            type="button"
            className="danger"
            disabled={pending || createBusy || ownerReadState !== "confirmed"}
            onClick={() =>
              setRemoving({
                action: "delete",
                topics: [...boardUI.selected].map(
                  (key) => (JSON.parse(key) as string[])[2]!,
                ),
              })
            }
          >
            <Trash2 />{tr("topics.deleteSelectedTopics")}</button>
        </div>
      )}
      <LoadingBoundary
        pending={cold}
        background={!!board && !!error}
        label={tr("topics.loadingTopics")}
        error={
          board && error
            ? tr("topics.showingTheLastLoadedListCouldNotRefresh", { error: error })
            : error
        }
        onRetry={validYear ? refreshTable : undefined}
      >
        {boardUI.preferences.view === "board" ? (
          <TopicsBoard
            key={JSON.stringify([
              project.id,
              project.path,
              year,
              boardUI.version,
            ])}
            projectId={project.id}
            year={year}
            rows={rows}
            allRows={board?.entries ?? []}
            preferences={boardUI.preferences}
            onPreferences={boardUI.onPreferences}
            selected={boardUI.selected}
            onSelection={boardUI.onSelection}
            onOpen={openRow}
            renderActions={actionsFor}
            renderMeta={(r) =>
              exactRow(r).activity.activeCount ? (
                activityFor(r)
              ) : (
                <span>
                  {exactRow(r).owners.some((owner) => !owner.deletedAt)
                    ? tr("topics.workingCopy")
                    : tr("topics.originalProject")}
                </span>
              )
            }
          />
        ) : (
          <div className="topic-table-wrap">
            <table className="topic-table topic-summary-table">
              <thead>
                <tr>
                  <th className="topic-table-checkbox">
                    <input
                      type="checkbox"
                      aria-label={tr("topics.selectTopicsInTheTable")}
                      checked={columnChecked(visibleKeys, boardUI.selected)}
                      disabled={!visibleKeys.length}
                      onChange={() =>
                        boardUI.onSelection(
                          toggleColumn(visibleKeys, boardUI.selected),
                        )
                      }
                    />
                  </th>
                  <th className="topic-table-topic">{tr("topics.topic2")}</th>
                  <th className="topic-table-branch">{tr("topics.branch")}</th>
                  <th className="topic-table-divergence">{tr("topics.relativeToBase2")}</th>
                  <th className="topic-table-statuses">{tr("topics.statuses")}</th>
                  <th className="topic-table-activity">{tr("topics.activeRuns")}</th>
                  <th className="topic-table-actions">
                    <span className="sr-only">{tr("topics.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, i) => (
                  <TopicTableRow
                    key={JSON.stringify([r.topic, r.branch, r.remote])}
                    r={r}
                    current={current(r)}
                    hidden={visibleRows !== null && !visibleRows.has(r)}
                    selectionKey={tableKeys[i]!}
                    checked={boardUI.selected.has(tableKeys[i]!)}
                    openRow={openRow}
                    toggleOne={boardUI.toggleOne}
                    activityFor={activityFor}
                    actionsFor={actionsFor}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!rows.length && (
          <p className="topic-empty">
            {filters.onlyActive
              ? tr("topics.noTopicsWithActiveRunsMatchTheseFilters")
              : board?.entries.length
                ? tr("topics.noTopicsMatchTheseFilters")
                : tr("topics.noTopicsForThisYearYet")}
          </p>
        )}
      </LoadingBoundary>
      {pendingDeletions.length > 0 && (
        <section
          className="topic-card-section"
          aria-label={tr("topics.unfinishedRemovals")}
        >
          <h3>{tr("topics.unfinishedRemovals")}</h3>
          <p className="hint">{tr("topics.theCopyHasAlreadyBeenRemovedContinueThe")}</p>
          {pendingDeletions.map((owner) => (
            <button
              key={owner.contextId}
              type="button"
              disabled={
                disabled || createBusy || ownerReadState !== "confirmed"
              }
              onClick={() =>
                setDeleting({
                  target: {
                    topic: owner.topic,
                    branch: owner.branch,
                    remote: false,
                  },
                  owner,
                })
              }
            >{tr("topics.continueRemoval")}{owner.topic} · {owner.year}
            </button>
          ))}
        </section>
      )}
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
      {removing && (
        <TopicsRemovalDialog
          key={JSON.stringify([project.id, year, removing])}
          project={project}
          year={year}
          action={removing.action}
          topics={removing.topics}
          onClose={() => setRemoving(null)}
          onChanged={changed}
          onBusy={markCreateBusy}
        />
      )}
      {deleting && (
        <TopicDeleteDialog
          project={project}
          year={deleting.owner?.year ?? year}
          target={deleting.target}
          owner={deleting.owner}
          current={current(deleting.target)}
          active={
            deleting.owner
              ? contextRunActivity(runs, deleting.owner).activeCount > 0
              : !!board &&
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

const TopicTableRow = memo(function TopicTableRow({
  r,
  hidden,
  current,
  selectionKey,
  checked,
  openRow,
  toggleOne,
  activityFor,
  actionsFor,
}: {
  r: TopicBoardRecord;
  hidden: boolean;
  current: boolean;
  selectionKey: string;
  checked: boolean;
  openRow: (r: TopicBoardRecord) => void;
  toggleOne: (key: string) => void;
  activityFor: (r: TopicBoardRecord) => ReactNode;
  actionsFor: (r: TopicBoardRecord, hidden: boolean) => ReactNode;
}) {
  useLocale();
  return (
    <tr
      hidden={hidden}
      className={current ? "topic-current-row" : ""}
      aria-current={current ? "true" : undefined}
    >
      <td className="topic-table-checkbox">
        <input
          type="checkbox"
          aria-label={tr("topics.selectTopicTopic", { topic: r.topic })}
          checked={checked}
          onChange={() => toggleOne(selectionKey)}
        />
      </td>
      <td>
        <button
          className="topic-link"
          aria-label={tr("topics.openTopicTopic", { topic: r.topic })}
          onClick={() => openRow(r)}
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
      <td>{!hidden && activityFor(r)}</td>
      <td>{actionsFor(r, hidden)}</td>
    </tr>
  );
});

function TopicCreateLoader(props: {
  project: Project;
  year: string;
  store: TopicsStore;
  onClose: () => void;
  onChanged: () => void;
  onBusy?: (v: boolean) => void;
}) {
  useLocale();
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
            tr("topics.creationSettingsBelongToAnotherProjectOrYear"),
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
    <TopicModal title={tr("topics.createTopic")} onClose={props.onClose}>
      <LoadingBoundary
        pending={!error}
        label={tr("topics.checkingCreationSettings")}
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
  useLocale();
  const status = unverified
    ? tr("topics.needsReview")
    : run.status === "starting"
      ? tr("launch.starting")
      : tr("topics.running");
  const kind = run.kind === "build" ? tr("launch.build") : tr("launch.pipeline");
  return (
    <button
      type="button"
      className={`topic-link topic-run-activity${unverified ? " topic-run-unverified" : ""}`}
      aria-label={tr("topics.openRunIdKindStatus", { id: run.id, kind: kind, status: status })}
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
  useLocale();
  const [query, setQuery] = useState(""),
    [chosen, setChosen] = useState(values);
  const title =
      kind === "topics"
        ? tr("topics.topics")
        : kind === "hosts"
          ? tr("topics.branchesHostingTheTopic")
          : tr("topics.statuses"),
    search =
      kind === "topics"
        ? tr("topics.findTopic")
        : kind === "hosts"
          ? tr("topics.findBranch")
          : tr("topics.findStatus");
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
      <p className="hint">{tr("topics.searchOnlyFiltersTheAvailableOptionsOptionsWithin")}</p>
      <div className="form-actions">
        <button type="button" onClick={() => setChosen([])}>{tr("topics.all")}</button>
        <button type="button" onClick={onClose}>{tr("launch.cancel")}</button>
        <button
          type="button"
          className="primary"
          onClick={() => onApply(chosen)}
        >{tr("topics.apply")}</button>
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
  useLocale();
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
    <TopicModal title={tr("topics.createTopic")} busy={operation.busy} onClose={onClose}>
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
              <label>{tr("topics.branchTopicName")}<input
                  autoFocus
                  required
                  autoComplete="off"
                  placeholder="feature/my-topic"
                  value={draft.branch}
                  onChange={(e) => edit({ branch: e.target.value })}
                />
              </label>
              <p className="hint">{tr("topics.theTopicNameWillBeDerivedFromThe")}</p>
              <label>{tr("topics.task")}<textarea
                  rows={5}
                  required={draft.publish || !draft.switch}
                  value={draft.task}
                  onChange={(e) => edit({ task: e.target.value })}
                />
              </label>
              <label>{tr("topics.baseBranch")}<input
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
              <h3>{tr("topics.afterCreation")}</h3>
              <div className="topic-create-switches">
                <TopicSwitch
                  checked={draft.publish}
                  onChange={() => edit({ publish: !draft.publish })}
                >{tr("topics.publish")}</TopicSwitch>
                <TopicSwitch
                  checked={draft.switch}
                  onChange={() => edit({ switch: !draft.switch })}
                >{tr("topics.switchToNewTopic")}</TopicSwitch>
              </div>
              {draft.publish && (
                <label>{tr("topics.commitMessageOptional")}<input
                    value={draft.commit}
                    onChange={(e) => edit({ commit: e.target.value })}
                    placeholder={tr("launch.fromProjectSettings")}
                  />
                </label>
              )}
              <p className="topic-warning" aria-live="polite">
                {createTopicExplanation(draft.publish, draft.switch)}
              </p>
              <div className="form-actions">
                <button type="button" onClick={onClose}>{tr("launch.cancel")}</button>
                <button type="submit" className="primary">
                  {operation.busy ? tr("topics.checking") : tr("topics.continue")}
                </button>
              </div>
            </fieldset>
          </form>
        )
      )}
    </TopicModal>
  );
}
