import type {
  TopicBoardRecord,
  TopicBoardSnapshot,
  TopicTarget,
} from "../shared/topics";
import type { WorktreeRecord } from "../shared/worktrees";
import {
  contextKey,
  contextRunActivity,
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
): TopicRowActivity {
  const result: TopicRowActivity = {
    activeCount: 0,
    activeRuns: [],
    unverifiedRunIds: [],
  };
  const owner = ownTopicTarget(board, row.topic);
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
  const active = new Map<string, RunWithContext>();
  const unverified = new Set<string>();
  for (const record of contexts.values()) {
    if (!contextRunActivity(runs, record).activeCount) continue;
    for (const run of runsForContext(runs, record).filter(isActiveRun)) {
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
  result.activeRuns = [...active.values()];
  result.activeCount = result.activeRuns.length;
  result.unverifiedRunIds = [...unverified];
  return result;
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
