import type {
  TopicBoardRecord,
  TopicBoardSnapshot,
  TopicTarget,
} from "../shared/topics";
import type { WorktreeRecord } from "../shared/worktrees";
import {
  contextKey,
  ownedContext,
  isActiveRun,
  runsForContext,
  type RunWithContext,
} from "./topic-context";
export interface TopicFilters {
  query: string;
  topics: string[];
  hosts: string[];
  statuses: string[];
  descriptions: boolean;
  perHost: boolean;
  remote: boolean;
  onlyActive: boolean;
}
export const defaultTopicFilters = (): TopicFilters => ({
  query: "",
  topics: [],
  hosts: [],
  statuses: [],
  descriptions: true,
  perHost: false,
  remote: false,
  onlyActive: false,
});
export function filterTopicRows(
  board: TopicBoardSnapshot,
  filters: TopicFilters,
  runs: RunWithContext[] = [],
  knownContexts: WorktreeRecord[] = [],
): TopicBoardRecord[] {
  const source = filters.perHost
    ? filters.remote
      ? board.remoteRecords
      : board.records
    : filters.remote
      ? board.remoteEntries
      : board.entries;
  return source
    .filter(
      (row) =>
        row.topic
          .toLocaleLowerCase()
          .includes(filters.query.toLocaleLowerCase()) &&
        (!filters.topics.length || filters.topics.includes(row.topic)) &&
        (!filters.hosts.length ||
          (filters.perHost
            ? filters.hosts.includes(row.branch)
            : "hosts" in row &&
              (row.hosts as string[]).some((host) =>
                filters.hosts.includes(host),
              ))) &&
        (!filters.statuses.length ||
          row.statuses.some((status) => filters.statuses.includes(status))) &&
        (!filters.onlyActive ||
          topicRowActivity(board, row, runs, knownContexts).activeCount > 0),
    )
    .sort((a, b) => {
      const current = board.currentTopic?.topic;
      return (
        Number(b.topic === current) - Number(a.topic === current) ||
        (a.topic === current && b.topic === current
          ? Number(b.branch === board.currentBranch) -
            Number(a.branch === board.currentBranch)
          : 0)
      );
    });
}
export function topicPlacements(board: TopicBoardSnapshot, topic: string) {
  return [
    ...new Map(
      [...board.records, ...board.remoteRecords]
        .filter((r) => r.topic === topic)
        .map((r) => [JSON.stringify([r.branch, r.remote]), r]),
    ).values(),
  ].sort((a, b) => a.branch.localeCompare(b.branch));
}
export function ownTopicTarget(
  board: TopicBoardSnapshot,
  topic: string,
): TopicTarget | null {
  return (
    board.entries.find((r) => r.topic === topic) ??
    board.remoteEntries.find((r) => r.topic === topic) ??
    null
  );
}

export interface TopicRowActivity {
  activeCount: number;
  activeRuns: RunWithContext[];
  unverifiedRunIds: string[];
}

/** A placement is not an execution owner. Only the board's local own entry can
 * prove the logical owner, including when viewing known remote placements. */
export function topicRowActivity(
  board: TopicBoardSnapshot,
  row: TopicBoardRecord,
  runs: RunWithContext[] = [],
  knownContexts: WorktreeRecord[] = [],
  exactOwner = false,
): TopicRowActivity {
  const result: TopicRowActivity = {
    activeCount: 0,
    activeRuns: [],
    unverifiedRunIds: [],
  };
  const owner = exactOwner
    ? board.entries.find(
        (entry) =>
          !entry.remote &&
          entry.topic === row.topic &&
          entry.branch === row.branch,
      )
    : ownTopicTarget(board, row.topic);
  if (!owner || owner.remote) return result;
  const contexts = new Map(
    knownContexts
      .filter(
        (record) =>
          record.projectId === board.projectId &&
          record.year === board.year &&
          record.topic === owner.topic &&
          record.branch === owner.branch,
      )
      .map((record) => [contextKey(record), record]),
  );
  return collectActivity(contexts.values(), (owner) =>
    runsForContext(runs, owner).filter(isActiveRun),
  );
}

function collectActivity(
  contexts: Iterable<WorktreeRecord>,
  runsOf: (context: WorktreeRecord) => readonly RunWithContext[],
): TopicRowActivity {
  const active = new Map<string, RunWithContext>();
  const unverified = new Set<string>();
  for (const record of contexts) {
    for (const run of runsOf(record)) {
      if (
        run.context?.repositoryKey &&
        run.context.repositoryKey !== record.repositoryKey
      )
        continue;
      active.set(run.id, run);
      if (run.recovery === "unverified" || record.state !== "ready")
        unverified.add(run.id);
    }
  }
  return {
    activeCount: active.size,
    activeRuns: [...active.values()],
    unverifiedRunIds: [...unverified],
  };
}

const emptyActivity: TopicRowActivity = {
  activeCount: 0,
  activeRuns: [],
  unverifiedRunIds: [],
};
const noOwners: WorktreeRecord[] = [];
const emptyExactRow = { owners: noOwners, activity: emptyActivity };

/** The table and board use exact owners. Group only runs with a validated
 * host-issued context and preserve the old repository and ambiguity checks. */
export function indexTopicTableOwners(
  board: TopicBoardSnapshot | null,
  runs: RunWithContext[],
  knownContexts: WorktreeRecord[],
) {
  type Entry = { owners: WorktreeRecord[]; activity: TopicRowActivity };
  const byTarget = new Map<string, Entry>();
  const key = (r: Pick<TopicTarget, "topic" | "branch">) =>
    JSON.stringify([r.topic, r.branch]);
  if (board && knownContexts.length) {
    for (const owner of knownContexts) {
      if (owner.projectId !== board.projectId || owner.year !== board.year)
        continue;
      const k = key(owner);
      let entry = byTarget.get(k);
      if (!entry)
        byTarget.set(k, (entry = { owners: [], activity: emptyActivity }));
      entry.owners.push(owner);
    }
    if (byTarget.size && runs.length) {
      const byOwner = new Map<string, RunWithContext[]>();
      for (const run of runs) {
        if (!isActiveRun(run)) continue;
        const owner = ownedContext(run);
        if (
          !owner ||
          owner.projectId !== board.projectId ||
          owner.year !== board.year
        )
          continue;
        const k = contextKey(owner);
        let bucket = byOwner.get(k);
        if (!bucket) byOwner.set(k, (bucket = []));
        bucket.push(run);
      }
      if (byOwner.size) {
        // Placements alone never prove ownership.
        const localTargets = new Set(
          board.entries.filter((row) => !row.remote).map(key),
        );
        for (const [target, entry] of byTarget) {
          if (!localTargets.has(target)) continue;
          const unique = new Map(entry.owners.map((o) => [contextKey(o), o]));
          entry.activity = collectActivity(
            unique.values(),
            (o) => byOwner.get(contextKey(o)) ?? [],
          );
        }
      }
    }
  }
  return (row: TopicTarget) =>
    (byTarget.size && byTarget.get(key(row))) || emptyExactRow;
}

export interface TopicTextDraft {
  text: string;
  original: string;
  version: string;
}
export interface TopicCreateDraft {
  branch: string;
  task: string;
  baseRef: string;
  publish: boolean;
  switch: boolean;
  commit: string;
}
export function createTopicsStore() {
  return {
    filters: new Map<string, TopicFilters>(),
    years: new Map<string, string>(),
    tasks: new Map<string, TopicTextDraft>(),
    creates: new Map<string, TopicCreateDraft>(),
  };
}
export type TopicsStore = ReturnType<typeof createTopicsStore>;
export const topicDraftKey = (
  projectId: string,
  year: string,
  target: TopicTarget,
) =>
  JSON.stringify([projectId, year, target.topic, target.branch, target.remote]);
export const createTopicExplanation = (
  publish: boolean,
  switchAfter: boolean,
) =>
  publish
    ? switchAfter
      ? "Сначала создадим топик с коммитом задачи и опубликуем ветку на origin, затем отдельно переключимся. Если переключение не удастся, опубликованный топик останется."
      : "Создадим топик с коммитом задачи и опубликуем ветку на origin. Текущая ветка не изменится."
    : switchAfter
      ? "После создания переключимся на новый топик. Задачу можно оставить пустой; введённый текст останется незакоммиченным."
      : "Создадим топик локально с коммитом задачи. Вы останетесь на текущей ветке; публикации не будет.";
