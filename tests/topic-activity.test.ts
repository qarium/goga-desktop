import { describe, expect, it } from "vitest";
import {
  defaultTopicFilters,
  filterTopicRows,
} from "../src/renderer/topics-model";
import type { RunWithContext } from "../src/renderer/topic-context";
import type {
  TopicBoardRecord,
  TopicBoardSnapshot,
} from "../src/shared/topics";
import type { WorktreeRecord } from "../src/shared/worktrees";

const row = (
  topic: string,
  branch: string,
  remote = false,
): TopicBoardRecord => ({
  topic,
  branch,
  remote,
  current: false,
  statuses: ["planned"],
  todo: null,
  divergence: null,
});
const a = row("same-topic", "feature/a"),
  b = row("other-topic", "feature/b");
const placement = { ...a, branch: "main", statuses: ["done"] };
const remote = row(a.topic, "origin/feature/a", true);
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "rev",
  currentBranch: "main",
  currentTopic: null,
  baseRef: "main",
  branches: [],
  dirty: false,
  active: false,
  entries: [
    { ...a, hosts: [a.branch, placement.branch] },
    { ...b, hosts: [b.branch] },
  ],
  records: [a, placement, b],
  remoteEntries: [{ ...remote, hosts: [remote.branch] }],
  remoteRecords: [remote],
};
const context = (patch: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  projectId: "p",
  year: "2026",
  topic: a.topic,
  branch: a.branch,
  contextId: "copy-a",
  revision: "r",
  repositoryKey: "repo",
  projectPath: "/fixture",
  gitCommonDir: "/fixture/.git",
  path: "/copies/a",
  ownership: "managed",
  state: "ready",
  ...patch,
});
const run = (patch: Partial<RunWithContext> = {}): RunWithContext => ({
  id: "run-a",
  projectId: "p",
  topic: a.topic,
  branch: a.branch,
  context: context(),
  pipeline: "develop",
  kind: "pipeline",
  status: "running",
  startedAt: "2026-10-20T00:00:00Z",
  workflow: null,
  profile: null,
  ...patch,
});
const active = () => ({ ...defaultTopicFilters(), onlyActive: true });

describe("global topic activity filter", () => {
  it("defaults off and returns zero rows without active runs", () => {
    expect(defaultTopicFilters()).toMatchObject({ onlyActive: false });
    expect(filterTopicRows(board, active(), [], [context()])).toEqual([]);
    expect(
      filterTopicRows(
        board,
        active(),
        [run({ status: "stopped" })],
        [context()],
      ),
    ).toEqual([]);
  });
  it.each(["pipeline", "build"] as const)(
    "counts starting and running %s, not terminal statuses",
    (kind) => {
      for (const status of ["starting", "running"] as const)
        expect(
          filterTopicRows(
            board,
            active(),
            [run({ kind, status })],
            [context()],
          ),
        ).toEqual([board.entries[0]]);
      for (const status of ["stopped", "failed", "exited"] as const)
        expect(
          filterTopicRows(
            board,
            active(),
            [run({ kind, status })],
            [context()],
          ),
        ).toEqual([]);
    },
  );
  it("does not match topic slugs across years, branches, projects or canonical context ids", () => {
    const foreign = [
      context({ year: "2025" }),
      context({ projectId: "another-project" }),
      context({ branch: "another/branch" }),
      context({ contextId: "other-copy" }),
    ];
    for (const owner of foreign)
      expect(
        filterTopicRows(
          board,
          active(),
          [
            run({
              projectId: owner.projectId,
              branch: owner.branch,
              context: owner,
            }),
          ],
          [context()],
        ),
      ).toEqual([]);
    expect(
      filterTopicRows(
        board,
        active(),
        [run({ context: undefined })],
        [context()],
      ),
    ).toEqual([]);
    expect(
      filterTopicRows(
        board,
        active(),
        [run({ branch: "spoof", context: context() })],
        [context()],
      ),
    ).toEqual([]);
  });
  it("uses own logical topic owner for every placement, not the placement branch", () => {
    expect(
      filterTopicRows(
        board,
        { ...active(), perHost: true },
        [run()],
        [context()],
      ),
    ).toEqual([a, placement]);
    const hostContext = context({ branch: "main", contextId: "main-copy" });
    expect(
      filterTopicRows(
        board,
        { ...active(), perHost: true },
        [run({ branch: "main", context: hostContext })],
        [hostContext],
      ),
    ).toEqual([]);
  });
  it("composes all existing filters and remote projection, without inferring a remote-only owner", () => {
    const runs = [run()],
      contexts = [context()];
    expect(
      filterTopicRows(
        board,
        {
          ...active(),
          topics: [a.topic],
          hosts: ["main"],
          statuses: ["planned"],
          query: "SAME",
        },
        runs,
        contexts,
      ),
    ).toHaveLength(1);
    expect(
      filterTopicRows(
        board,
        { ...active(), statuses: ["done"] },
        runs,
        contexts,
      ),
    ).toHaveLength(0);
    expect(
      filterTopicRows(
        board,
        { ...active(), perHost: true, hosts: ["main"], statuses: ["done"] },
        runs,
        contexts,
      ),
    ).toEqual([placement]);
    expect(
      filterTopicRows(board, { ...active(), query: "other" }, runs, contexts),
    ).toEqual([]);
    expect(
      filterTopicRows(board, { ...active(), remote: true }, runs, contexts),
    ).toEqual(board.remoteEntries);
    expect(
      filterTopicRows(
        board,
        { ...active(), remote: true, perHost: true },
        runs,
        contexts,
      ),
    ).toEqual([remote]);
    expect(
      filterTopicRows(
        { ...board, entries: [] },
        { ...active(), remote: true },
        runs,
        contexts,
      ),
    ).toEqual([]);
    expect(
      filterTopicRows({ ...board, year: "2025" }, active(), runs, contexts),
    ).toEqual([]);
  });
  it("deduplicates known owners and stops including a topic after its run stops", () => {
    expect(
      filterTopicRows(board, active(), [run()], [context(), context()]),
    ).toHaveLength(1);
    expect(
      filterTopicRows(
        board,
        active(),
        [run({ status: "stopped" })],
        [context(), context()],
      ),
    ).toHaveLength(0);
  });
});
