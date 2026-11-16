// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TopicsWorkspace } from "../src/renderer/TopicsWorkspace";
import {
  indexTopicTableOwners,
  createTopicsStore,
  defaultTopicFilters,
  topicRowActivity,
} from "../src/renderer/topics-model";
import type { RunWithContext } from "../src/renderer/topic-context";
import type { WorktreeRecord } from "../src/shared/worktrees";
import type { TopicBoardSnapshot } from "../src/shared/topics";

const project = { id: "p", name: "Project", path: "/fixture" };
const a = {
  topic: "feature-a",
  branch: "feature/a",
  current: false,
  remote: false,
  todo: "Task A",
  statuses: ["planned"],
  divergence: null,
};
const b = { ...a, topic: "feature-b", branch: "feature/b", todo: "Task B" };
const remote = { ...a, branch: "origin/feature/a", remote: true };
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "r",
  currentBranch: "main",
  currentTopic: null,
  baseRef: "main",
  branches: [],
  dirty: false,
  active: false,
  entries: [
    { ...a, hosts: [a.branch, "main"] },
    { ...b, hosts: [b.branch] },
  ],
  records: [a, { ...a, branch: "main" }, b],
  remoteEntries: [{ ...remote, hosts: [remote.branch] }],
  remoteRecords: [remote],
};
const context: WorktreeRecord = {
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
};
const run = (patch: Partial<RunWithContext> = {}): RunWithContext => ({
  id: "run-a",
  projectId: "p",
  topic: a.topic,
  branch: a.branch,
  context,
  pipeline: "develop",
  kind: "pipeline",
  status: "running",
  startedAt: "2026-10-20T00:00:00Z",
  workflow: null,
  profile: null,
  ...patch,
});
let readBoard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // This suite exercises the existing table; board defaults/behaviour have separate tests.
  localStorage.setItem(
    "goga.desktop.topicsBoard.v1.p",
    JSON.stringify({
      schemaVersion: 1,
      view: "table",
      columns: [],
      statusCategory: {},
    }),
  );
  readBoard = vi.fn(async () => board);
  window.goga = { readTopicTable: readBoard } as any;
});
afterEach(cleanup);
function props(runs: RunWithContext[] = []) {
  const store = createTopicsStore();
  store.years.set(project.id, "2026");
  return {
    project,
    store,
    runs,
    knownContexts: [context],
    onOpenRun: vi.fn(),
    onOpenTopic: vi.fn(),
    onChanged: vi.fn(),
  };
}
const topicA = () =>
  screen.queryAllByRole("button", { name: "Открыть топик feature-a" });
const topicB = () =>
  screen.queryAllByRole("button", { name: "Открыть топик feature-b" });

it("offers the approved accessible switch, run column and useful zero-active empty state", async () => {
  render(<TopicsWorkspace {...props()} />);
  await screen.findByRole("button", { name: "Открыть топик feature-a" });
  const toggle = screen.getByRole("switch", {
    name: "Только с активными запусками",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(
    screen.getByRole("columnheader", { name: "Активные запуски" }),
  ).toBeTruthy();
  expect(screen.getAllByText("Нет активного")).toHaveLength(2);
  fireEvent.click(toggle);
  expect(topicA()).toHaveLength(0);
  expect(topicB()).toHaveLength(0);
  expect(
    screen.getByText(
      "Нет топиков с активными запусками по выбранным условиям.",
    ),
  ).toBeTruthy();
});

it("keeps the board global, composes views/search, resets active too, and refilters after stop without reloading", async () => {
  const initial = props([run({ kind: "build", status: "starting" })]);
  const view = render(<TopicsWorkspace {...initial} />);
  await screen.findByRole("button", { name: "Открыть топик feature-a" });
  expect(topicB()).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("switch", { name: "Только с активными запусками" }),
  );
  expect(topicA()).toHaveLength(1);
  expect(topicB()).toHaveLength(0);
  expect(topicA()).toHaveLength(1);
  fireEvent.change(screen.getByPlaceholderText("Часть имени топика"), {
    target: { value: "feature-b" },
  });
  expect(topicA()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
  expect(
    screen
      .getByRole("switch", { name: "Только с активными запусками" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(topicB()).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("switch", { name: "Только с активными запусками" }),
  );

  expect(topicA()).toHaveLength(1);
  view.rerender(
    <TopicsWorkspace {...initial} runs={[run({ status: "stopped" })]} />,
  );
  expect(topicA()).toHaveLength(0);
  expect(readBoard).toHaveBeenCalledTimes(1);
  expect(initial.onOpenRun).not.toHaveBeenCalled();
  expect(initial.onOpenTopic).not.toHaveBeenCalled();
});

it("opens only the exact run id after an explicit marker click", async () => {
  const initial = props([run()]);
  render(<TopicsWorkspace {...initial} />);
  const topic = await screen.findByRole("button", {
    name: "Открыть топик feature-a",
  });
  const row = within(topic.closest("tr")!);
  expect(initial.onOpenRun).not.toHaveBeenCalled();
  fireEvent.click(row.getByRole("button", { name: /Открыть запуск run-a/ }));
  expect(initial.onOpenRun).toHaveBeenCalledExactlyOnceWith("run-a");
  expect(initial.onOpenTopic).not.toHaveBeenCalled();
});

it("requires an explicit run choice when the same logical topic has multiple active owners", async () => {
  const secondOwner = { ...context, contextId: "copy-b", path: "/copies/b" };
  const secondRun = run({ id: "run-b", kind: "build", context: secondOwner });
  const initial = {
    ...props([run(), secondRun]),
    knownContexts: [context, context, secondOwner],
  };
  render(<TopicsWorkspace {...initial} />);
  const topic = await screen.findByRole("button", {
    name: "Открыть топик feature-a",
  });
  const row = within(topic.closest("tr")!);
  const chooser = row.getByText("Активных: 2 · выбрать запуск");
  fireEvent.click(chooser);
  expect(initial.onOpenRun).not.toHaveBeenCalled();
  expect(
    row.getAllByRole("button", { name: /Открыть запуск run-/ }),
  ).toHaveLength(2);
  fireEvent.click(row.getByRole("button", { name: /Открыть запуск run-b/ }));
  expect(initial.onOpenRun).toHaveBeenCalledExactlyOnceWith("run-b");
});

it("does not call an unverified recovery reservation running", async () => {
  render(<TopicsWorkspace {...props([run({ recovery: "unverified" })])} />);
  const topic = await screen.findByRole("button", {
    name: "Открыть топик feature-a",
  });
  const row = within(topic.closest("tr")!);
  expect(row.getByText(/Требует проверки/)).toBeTruthy();
  expect(row.queryByText(/Работает/)).toBeNull();
  fireEvent.click(
    screen.getByRole("switch", { name: "Только с активными запусками" }),
  );
  expect(topicA()).toHaveLength(1);
});

it("keeps runs and active filtering separate for branches that normalize to the same topic", async () => {
  const twin = { ...a, branch: "feature-a" };
  const twinOwner = {
    ...context,
    branch: twin.branch,
    contextId: "copy-twin",
    path: "/copies/twin",
  };
  const twinRun = run({
    id: "twin-run",
    branch: twin.branch,
    context: twinOwner,
  });
  readBoard.mockResolvedValue({
    ...board,
    entries: [
      { ...a, hosts: [a.branch] },
      { ...twin, hosts: [twin.branch] },
    ],
    records: [a, twin],
  });
  render(
    <TopicsWorkspace
      {...props([twinRun])}
      knownContexts={[context, twinOwner]}
    />,
  );
  const names = await screen.findAllByRole("button", {
    name: "Открыть топик feature-a",
  });
  expect(
    within(names[0]!.closest("tr")!).queryByRole("button", {
      name: /Открыть запуск twin-run/,
    }),
  ).toBeNull();
  expect(
    within(names[1]!.closest("tr")!).getByRole("button", {
      name: /Открыть запуск twin-run/,
    }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("switch", { name: "Только с активными запусками" }),
  );
  expect(
    screen.getAllByRole("button", { name: "Открыть топик feature-a" }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: /Открыть запуск twin-run/ }),
  ).toBeTruthy();
});

it("does not inspect unrelated topic data when changing just the row selection", async () => {
  const probe = vi.fn(() => ["planned"]);
  const second = Object.defineProperty({ ...board.entries[1]! }, "statuses", {
    get: probe,
  });
  readBoard.mockResolvedValue({
    ...board,
    entries: [board.entries[0]!, second],
  });
  render(<TopicsWorkspace {...props()} />);
  const toggle = await screen.findByRole("checkbox", {
    name: "Выбрать топик feature-a",
  });
  probe.mockClear();
  fireEvent.click(toggle);
  expect(screen.getByText("Выбрано: 1")).toBeTruthy();
  expect(probe).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(screen.queryByText("Выбрано: 1")).toBeNull();
  expect(probe).not.toHaveBeenCalled();
});

it("reuses displayed rows of a large table when changing its filter without exposing hidden results to keyboard or selection", async () => {
  const entries = Array.from({ length: 256 }, (_, i) => ({
    ...board.entries[0]!,
    topic: `key-${i}`,
    branch: `b-${i}`,
  }));
  readBoard.mockResolvedValue({ ...board, entries });
  const initial = props();
  const view = render(<TopicsWorkspace {...initial} />);
  const first = await screen.findByRole("button", {
    name: "Открыть топик key-0",
  });
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "key-17" } });
  expect(
    screen.queryByRole("button", { name: "Открыть топик key-0" }),
  ).toBeNull();
  fireEvent.click(screen.getByLabelText("Выбрать топики таблицы"));
  expect(screen.getByText("Выбрано: 11")).toBeTruthy();
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Открыть топик key-0" })).toBe(
    first,
  );
  expect(
    view.container.querySelectorAll("tbody tr:not([hidden])"),
  ).toHaveLength(256);
});

it("indexes exact activity without admitting orphaned, stale, repository-mismatched or remote-only owners", () => {
  const twin = { ...context, contextId: "twin", state: "conflict" as const };
  const unknown = { ...context, repositoryKey: "other" };
  const previousYear = { ...context, year: "2025" };
  const remoteOnly = { ...context, branch: remote.branch };
  const owners = [context, context, previousYear, twin, remoteOnly];
  const runs = [
    run(),
    run({ id: "twin", context: twin }),
    run({ id: "wrong-repository", context: unknown }),
    run({ id: "wrong-project", projectId: "another" }),
    run({ id: "wrong-context", context: { ...context, contextId: "orphan" } }),
    run({ id: "wrong-year", context: previousYear }),
    run({ id: "no-context", context: undefined }),
    run({ id: "remote-only", branch: remote.branch, context: remoteOnly }),
    run({ id: "finished", status: "exited" }),
  ];
  const lookup = indexTopicTableOwners(board, runs, owners);
  expect(lookup(a).owners).toEqual([context, context, twin]); // duplicated owner is ambiguous for choosing/deleting
  expect(lookup(a).activity).toEqual(
    topicRowActivity(board, a, runs, owners, true),
  );
  expect(lookup(a).activity.activeRuns.map((r) => r.id)).toEqual([
    "run-a",
    "twin",
  ]);
  expect(lookup(a).activity.unverifiedRunIds).toEqual(["twin"]);
  expect(lookup(remote).activity.activeCount).toBe(0);
});

it("does not pre-mount filtered rows when opening a large table with a restored query", async () => {
  const entries = Array.from({ length: 256 }, (_, i) => ({
    ...board.entries[0]!,
    topic: `key-${i}`,
    branch: `b-${i}`,
  }));
  readBoard.mockResolvedValue({ ...board, entries });
  const initial = props();
  initial.store.filters.set(project.id, {
    ...defaultTopicFilters(),
    query: "key-255",
  });
  const view = render(<TopicsWorkspace {...initial} />);
  await screen.findByRole("button", { name: "Открыть топик key-255" });
  expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
});
