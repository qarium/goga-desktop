import { expect, it } from "vitest";
import {
  filterTopicRows,
  topicPlacements,
  defaultTopicFilters,
} from "../src/renderer/topics-model";
import type { TopicBoardSnapshot } from "../src/shared/topics";
const row = (
  topic: string,
  branch: string,
  statuses: string[],
  remote = false,
) => ({
  topic,
  branch,
  statuses,
  remote,
  current: branch === "feature/a",
  todo: branch,
  divergence: null,
});
const a = row("feature-a", "feature/a", ["planned"]),
  host = row("feature-a", "main", ["done"]),
  b = row("feature-b", "feature/b", ["tool.ready"]);
const snap: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "r",
  currentBranch: "feature/a",
  currentTopic: a,
  baseRef: "main",
  branches: [],
  dirty: false,
  active: false,
  entries: [
    { ...b, hosts: ["feature/b"] },
    { ...a, hosts: ["feature/a", "main"] },
  ],
  records: [b, host, a],
  remoteEntries: [
    {
      ...a,
      branch: "origin/feature/a",
      remote: true,
      hosts: ["origin/feature/a"],
    },
  ],
  remoteRecords: [row("feature-a", "origin/feature/a", ["published"], true)],
};
it("defaults descriptions on, per-host and remote off", () => {
  expect(defaultTopicFilters()).toMatchObject({
    descriptions: true,
    perHost: false,
    remote: false,
    query: "",
  });
});
it("prioritizes current OWN topic after filters, not merged current-host rows", () => {
  expect(
    filterTopicRows(snap, defaultTopicFilters()).map((r) => r.topic),
  ).toEqual(["feature-a", "feature-b"]);
  expect(
    filterTopicRows(snap, { ...defaultTopicFilters(), query: "FEATURE-B" }).map(
      (r) => r.topic,
    ),
  ).toEqual(["feature-b"]);
  expect(
    filterTopicRows(snap, { ...defaultTopicFilters(), statuses: ["done"] }),
  ).toEqual([]);
});
it("composes AND groups, OR inside groups; instant substring only names", () => {
  expect(
    filterTopicRows(snap, {
      ...defaultTopicFilters(),
      topics: ["feature-a", "feature-b"],
      hosts: ["main"],
      statuses: ["planned", "unknown"],
      query: "ure-a",
    }),
  ).toHaveLength(1);
  expect(
    filterTopicRows(snap, { ...defaultTopicFilters(), query: "main" }),
  ).toHaveLength(0);
});
it("per-host is flat exact row task and status; own current branch wins only when included", () => {
  const f = { ...defaultTopicFilters(), perHost: true };
  expect(filterTopicRows(snap, f).map((r) => r.branch)).toEqual([
    "feature/a",
    "main",
    "feature/b",
  ]);
  expect(
    filterTopicRows(snap, { ...f, hosts: ["main"], statuses: ["done"] }).map(
      (r) => r.todo,
    ),
  ).toEqual(["main"]);
  expect(
    filterTopicRows(snap, { ...f, hosts: ["main"], statuses: ["planned"] }),
  ).toHaveLength(0);
});
it("remote switches projection and placements ignore board filters and include known remotes", () => {
  expect(
    filterTopicRows(snap, { ...defaultTopicFilters(), remote: true })[0]
      ?.branch,
  ).toEqual("origin/feature/a");
  expect(topicPlacements(snap, "feature-a").map((r) => r.branch)).toEqual([
    "feature/a",
    "main",
    "origin/feature/a",
  ]);
});
