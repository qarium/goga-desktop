import type { GitUpdateHandoffCandidate } from "../shared/git-update-handoff";
import { SearchablePicker } from "./SearchablePicker";
import { HistoryArtifacts } from "./ProjectHistory";
import { TopicDivergence } from "./TopicDivergence";
import { useEffect, useId, useRef, useState } from "react";
import type { Project } from "../shared/types";
import type {
  TopicBoardSnapshot,
  TopicDetails,
  TopicTarget,
} from "../shared/topics";
import type { WorktreeRecord } from "../shared/worktrees";
import {
  contextRef,
  contextRunActivity,
  type RunWithContext,
} from "./topic-context";
import { useReadScope } from "./read-request";
import {
  TopicModal,
  TopicConfirmation,
  TopicFeedback,
  topicError,
  useTopicOperation,
} from "./TopicsCommon";
import { LoadingBoundary } from "./LoadingBoundary";
import { TopicDeleteDialog } from "./TopicDeleteDialog";
import { TopicTaskText } from "./TopicTaskText";
import { topicPlacements } from "./topics-model";
import {
  repositoryActionKey,
  useRepositoryActionController,
} from "./repository-action-controller";

function TopicOverviewView({
  project,
  year,
  target: source,
  board: initialBoard,
  owner,
  deletionOwner,
  ownerReadState = "confirmed",
  ownerReadError,
  selectedContextId,
  showArtifacts = false,
  runs = [],
  onClose,
  onChanged,
  onBusy,
  onHandoff,
}: {
  project: Project;
  year: string;
  target: TopicTarget;
  board: TopicBoardSnapshot | null;
  owner?: WorktreeRecord;
  deletionOwner?: WorktreeRecord;
  ownerReadState?: "loading" | "error" | "confirmed";
  ownerReadError?: string;
  selectedContextId?: string;
  showArtifacts?: boolean;
  runs?: RunWithContext[];
  onClose: () => void;
  onChanged: () => void;
  onBusy?: (v: boolean) => void;
  onHandoff?: (candidate: GitUpdateHandoffCandidate) => void;
}) {
  const target = {
    topic: source.topic,
    branch: source.branch,
    remote: source.remote,
  };
  const key = JSON.stringify([
    project.id,
    year,
    target,
    owner?.contextId,
    owner?.revision,
  ]);
  const scope = owner ? contextRef(owner) : project.id;
  const read = useReadScope(key);
  const id = useId();
  type Tab = "task" | "artifacts" | "placements";
  const [tab, setTab] = useState<Tab>("task");
  const tabs: [Tab, string][] = [
    ["task", "Задача"],
    ...(showArtifacts ? [["artifacts", "Артефакты"] as [Tab, string]] : []),
    ["placements", "Размещение по веткам"],
  ];
  const [task, setTask] = useState<TopicDetails | null>(null),
    [taskError, setTaskError] = useState("");
  const [taskLoading, setTaskLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  const [board, setBoard] = useState<TopicBoardSnapshot | null>(null),
    [boardError, setBoardError] = useState("");
  const [displayBoard, setDisplayBoard] = useState<TopicBoardSnapshot | null>(
    null,
  );
  const [displayError, setDisplayError] = useState("");
  const [destination, setDestination] = useState("");
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const publication = useRepositoryActionController();
  const publicationScope = {
    projectId: project.id,
    ...(owner ? { context: contextRef(owner) } : {}),
  };
  const publicationBusy = publication.busy.has(
    repositoryActionKey(publicationScope),
  );
  const [branches, setBranches] = useState<string[] | null>(null),
    [branchesLoading, setBranchesLoading] = useState(false),
    [branchesError, setBranchesError] = useState("");
  const branchesFlight = useRef<Promise<void> | null>(null);
  const [boardLoading, setBoardLoading] = useState(false),
    [base, setBase] = useState("");
  const [deleting, setDeleting] = useState(false),
    [preparing, setPreparing] = useState(false),
    [actionError, setActionError] = useState("");
  const mounted = useRef(true),
    boardFlight = useRef<Promise<TopicBoardSnapshot> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ownerMismatch =
    !!owner &&
    (owner.projectId !== project.id ||
      owner.year !== year ||
      owner.topic !== target.topic ||
      owner.branch !== target.branch ||
      target.remote);
  const ownershipError = ownerMismatch
    ? "Контекст относится к другому топику."
    : ownerReadState === "error"
      ? ownerReadError || "Не удалось проверить контекст топика."
      : "";
  const waitingOwner = !owner && ownerReadState === "loading";
  const changed = () => {
    setAttempt((n) => n + 1);
    setBoard(null);
    setDisplayBoard(null);
    onChanged();
  };
  const operation = useTopicOperation(key, changed);
  const busy = preparing || operation.busy || publicationBusy;
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  useEffect(() => {
    let alive = true;
    setTaskLoading(true);
    setTaskError("");
    setTask(null);
    if (ownershipError) {
      setTaskLoading(false);
      return;
    }
    if (waitingOwner) return;
    read("readTopicOverview", scope, year, target)
      .then((value) => {
        if (!alive) return;
        if (
          value.projectId !== project.id ||
          value.year !== year ||
          value.target.topic !== target.topic ||
          value.target.branch !== target.branch ||
          value.target.remote !== target.remote
        )
          throw Error("Задача относится к другому топику.");
        setTask(value);
      })
      .catch((e) => {
        if (alive) setTaskError(topicError(e));
      })
      .finally(() => {
        if (alive) setTaskLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [read, key, attempt, ownershipError, waitingOwner]);
  async function loadBoard(force = false) {
    if (!force && board) return board;
    if (boardFlight.current) return boardFlight.current;
    setBoardLoading(true);
    setBoardError("");
    const flight = read("readTopicBoard", scope, year).then((value) => {
      if (value.projectId !== project.id || value.year !== year)
        throw Error("Размещения относятся к другому проекту или году.");
      if (mounted.current) setBoard(value);
      return value;
    });
    boardFlight.current = flight;
    try {
      return await flight;
    } catch (e) {
      if (mounted.current) setBoardError(topicError(e));
      throw e;
    } finally {
      if (boardFlight.current === flight) boardFlight.current = null;
      if (mounted.current) setBoardLoading(false);
    }
  }
  useEffect(() => {
    if (tab === "placements" && !ownershipError && !waitingOwner && !board)
      void loadBoard().catch(() => {});
  }, [tab, ownershipError, waitingOwner, attempt]);
  async function loadBranches() {
    if (branches || branchesFlight.current) return;
    setBranchesLoading(true);
    setBranchesError("");
    // Update captures its base from the original repository, not the clone's
    // stale local/remote branch inventory. This read is display-only.
    const flight = read("readProjectBranches", project.id)
      .then((value) => {
        if (value.projectId !== project.id)
          throw Error("Список веток относится к другому проекту.");
        if (mounted.current) {
          setBranches(value.branches);
          setLocalBranches(value.localBranches);
        }
      })
      .catch((e) => {
        if (mounted.current) setBranchesError(topicError(e));
      })
      .finally(() => {
        branchesFlight.current = null;
        if (mounted.current) setBranchesLoading(false);
      });
    branchesFlight.current = flight;
    await flight;
  }
  const unavailable =
    ownershipError ||
    (waitingOwner
      ? "Проверяем контекст топика…"
      : target.remote
        ? "Для изменения удалённого топика сначала переключитесь на него."
        : "");
  const displayRow = (value: TopicBoardSnapshot | null) =>
    value?.projectId === project.id && value.year === year
      ? [...value.entries, ...value.remoteEntries].find(
          (r) =>
            r.topic === target.topic &&
            r.branch === target.branch &&
            r.remote === target.remote,
        )
      : undefined;
  const initialRow = attempt === 0 ? displayRow(initialBoard) : undefined;
  const summary = displayRow(board) ?? displayRow(displayBoard) ?? initialRow;
  useEffect(() => {
    let alive = true;
    setDisplayError("");
    if (initialRow || ownershipError || waitingOwner) return;
    // A selector can open the card without a table. Read only display metadata;
    // mutation-capable/per-host boards remain lazy until an explicit action.
    read("readTopicTable", project.id, year)
      .then((value) => {
        if (!alive) return;
        if (value.projectId !== project.id || value.year !== year)
          throw Error("Состояние относится к другому проекту или году.");
        setDisplayBoard(value);
      })
      .catch((e) => {
        if (alive) setDisplayError(topicError(e));
      });
    return () => {
      alive = false;
    };
  }, [read, key, attempt, !!initialRow, ownershipError, waitingOwner]);
  const statuses = summary?.statuses ?? [];
  async function update() {
    if (!base || busy || unavailable) return;
    setPreparing(true);
    setActionError("");
    try {
      const fresh = await loadBoard(true);
      if (!mounted.current) return;
      await operation.prepare({
        projectId: project.id,
        ...(owner ? { context: contextRef(owner) } : {}),
        year,
        target,
        action: "update",
        baseRef: base,
        publish: false,
        expectedRevision: fresh.revision,
      });
    } catch (e) {
      if (mounted.current) setActionError(topicError(e));
    } finally {
      if (mounted.current) setPreparing(false);
    }
  }
  async function publish() {
    if (
      !destination ||
      busy ||
      unavailable ||
      operation.plan ||
      typeof window.goga.runRepositoryAction !== "function"
    )
      return;
    await publication.run(
      {
        ...publicationScope,
        action: "propagate",
        propagation: {
          year,
          topic: target.topic,
          branch: target.branch,
          baseRef: destination,
        },
      },
      `${project.name} · ${target.topic} · ${year} · ${target.branch} → ${destination}`,
    );
    if (mounted.current) changed();
  }
  const placements = board ? topicPlacements(board, target.topic) : [];
  return (
    <>
      <TopicModal
        title={target.topic}
        className={
          showArtifacts
            ? "topic-overview topic-overview-with-artifacts"
            : "topic-overview"
        }
        busy={busy}
        onClose={onClose}
      >
        <div className="topic-overview-meta">
          <span>Топик / {year}</span>
          <div className="topic-statuses">
            {statuses.map((status) => (
              <span className="topic-status" key={status}>
                {status}
              </span>
            ))}
            <span
              title={displayError || summary?.statusError}
              aria-label="Относительно base"
            >
              <TopicDivergence divergence={summary?.divergence ?? null} />
            </span>
          </div>
        </div>
        <div
          className="topic-overview-tabs"
          role="tablist"
          aria-label="Информация о топике"
        >
          {tabs.map(([value, label]) => (
            <button
              key={value}
              id={`${id}-${value}`}
              role="tab"
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? tabs[0]![0]
                    : event.key === "End"
                      ? tabs[tabs.length - 1]![0]
                      : tabs[
                          (tabs.findIndex(([value]) => value === tab) +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            tabs.length) %
                            tabs.length
                        ]![0];
                setTab(next);
                document.getElementById(`${id}-${next}`)?.focus();
              }}
              aria-controls={`${id}-panel`}
              onClick={() => {
                setTab(value);
                if (value === "placements" && !ownershipError && !waitingOwner)
                  void loadBoard().catch(() => {});
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="topic-overview-body"
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${tab}`}
        >
          {operation.plan ? (
            <TopicConfirmation operation={operation} />
          ) : tab === "task" ? (
            <LoadingBoundary
              pending={taskLoading || waitingOwner}
              label="Загружаем задачу…"
              error={ownershipError || taskError}
              onRetry={() => {
                setAttempt((n) => n + 1);
                if (ownershipError) onChanged();
              }}
            >
              {task?.exists && task.text.trim() ? (
                <TopicTaskText text={task.text} />
              ) : (
                <p className="topic-empty">Задача не задана</p>
              )}
            </LoadingBoundary>
          ) : tab === "placements" ? (
            <LoadingBoundary
              pending={boardLoading}
              label="Загружаем размещение…"
              error={ownershipError || boardError}
              onRetry={() => void loadBoard(true).catch(() => {})}
            >
              <table className="topic-placement-table">
                <thead>
                  <tr>
                    <th>Ветка</th>
                    <th>Статусы</th>
                  </tr>
                </thead>
                <tbody>
                  {placements.map((row) => (
                    <tr key={JSON.stringify([row.branch, row.remote])}>
                      <td>
                        <code>{row.branch}</code>
                        {row.remote && <small>Удалённая ветка</small>}
                      </td>
                      <td>
                        <div className="topic-statuses">
                          {row.statuses.length
                            ? row.statuses.map((s) => (
                                <span className="topic-status" key={s}>
                                  {s}
                                </span>
                              ))
                            : "—"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!boardLoading && !placements.length && (
                <p className="topic-empty">Размещения не найдены</p>
              )}
            </LoadingBoundary>
          ) : null}
          {showArtifacts && (
            <div hidden={tab !== "artifacts" || !!operation.plan}>
              <LoadingBoundary
                pending={waitingOwner}
                error={ownershipError}
                label="Загружаем артефакты…"
                onRetry={onChanged}
              >
                <HistoryArtifacts
                  scope={scope}
                  year={year}
                  entry={target.topic}
                  target={target}
                  active={
                    tab === "artifacts" &&
                    !operation.plan &&
                    !waitingOwner &&
                    !ownershipError
                  }
                  refreshKey={attempt}
                />
              </LoadingBoundary>
            </div>
          )}
          <TopicFeedback
            operation={operation}
            handoffScope={scope}
            onHandoff={onHandoff}
          />
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
        </div>
        <footer className="topic-overview-footer">
          <div className="topic-exchange-controls">
            <div className="topic-update-controls">
              <SearchablePicker
                className="topic-branch-picker"
                hideLabel
                label="Из ветки"
                placeholder="Из ветки"
                emptyLabel="Из ветки"
                searchLabel="Найти ветку для обновления"
                searchPlaceholder="Название ветки"
                listLabel="Ветки для обновления"
                entries={(branches ?? []).filter(
                  (branch) => branch !== target.branch,
                )}
                value={base}
                disabled={busy || !!unavailable}
                loading={branchesLoading}
                onOpen={() => void loadBranches()}
                onChange={setBase}
              />
              <button
                type="button"
                disabled={!base || busy || !!unavailable || !!operation.plan}
                onClick={() => void update()}
              >
                Обновить
              </button>
            </div>
            <div className="topic-update-controls">
              <SearchablePicker
                className="topic-branch-picker"
                hideLabel
                label="В ветку"
                placeholder="В ветку"
                emptyLabel="В ветку"
                searchLabel="Найти ветку для публикации"
                searchPlaceholder="Название ветки"
                listLabel="Ветки для публикации"
                entries={localBranches.filter(
                  (branch) => branch !== target.branch,
                )}
                value={destination}
                disabled={busy || !!unavailable || !!operation.plan}
                loading={branchesLoading}
                onOpen={() => void loadBranches()}
                onChange={setDestination}
              />
              <button
                type="button"
                disabled={
                  !destination ||
                  busy ||
                  !!unavailable ||
                  !!operation.plan ||
                  typeof window.goga.runRepositoryAction !== "function"
                }
                onClick={() => void publish()}
              >
                {publicationBusy ? "Публикуем…" : "Опубликовать"}
              </button>
            </div>
          </div>
          <button
            type="button"
            className="danger"
            disabled={busy || !!unavailable || !!operation.plan}
            onClick={() => setDeleting(true)}
          >
            Удалить топик…
          </button>
          {unavailable && (
            <p className="hint topic-overview-reason">{unavailable}</p>
          )}
          {branchesError && (
            <p role="alert" className="error topic-overview-reason">
              {branchesError}
            </p>
          )}
        </footer>
      </TopicModal>
      {deleting && (
        <TopicDeleteDialog
          project={project}
          year={year}
          target={target}
          owner={deletionOwner ?? owner}
          current={!!owner && owner.contextId === selectedContextId}
          active={!!owner && contextRunActivity(runs, owner).activeCount > 0}
          onClose={() => setDeleting(false)}
          onChanged={() => {
            changed();
            onClose();
          }}
          onBusy={onBusy}
        />
      )}
    </>
  );
}

export function TopicOverview(props: Parameters<typeof TopicOverviewView>[0]) {
  return (
    <TopicOverviewView
      key={JSON.stringify([
        props.project.id,
        props.year,
        props.target.topic,
        props.target.branch,
        props.target.remote,
        props.owner?.contextId,
        props.owner?.revision,
        props.showArtifacts,
      ])}
      {...props}
    />
  );
}
