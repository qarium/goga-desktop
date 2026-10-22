// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopicContextPicker } from "../src/renderer/TopicContextPicker";
import { contextRef } from "../src/renderer/topic-context";
import type { TopicBoardSnapshot } from "../src/shared/topics";
import type { WorktreeRecord } from "../src/shared/worktrees";
const project = { id: "p", name: "Fixture", path: "/fixture/project" };
const row = (topic: string) => ({
  topic,
  branch: topic,
  remote: false,
  current: topic === "a",
  statuses: [],
  hosts: [],
  todo: null,
  divergence: null,
});
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "board",
  currentBranch: "a",
  currentTopic: row("a"),
  baseRef: "main",
  branches: ["a", "b"],
  dirty: false,
  active: false,
  entries: [row("a"), row("b")],
  records: [],
  remoteEntries: [],
  remoteRecords: [],
};
const record = (
  topic = "a",
  overrides: Partial<WorktreeRecord> = {},
): WorktreeRecord => ({
  projectId: "p",
  year: "2026",
  topic,
  branch: topic,
  contextId: "ctx-" + (topic === "b" ? "b" : "a").repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "f".repeat(64),
  projectPath: project.path,
  gitCommonDir: `/fixture/${topic}/.git`,
  path: `/fixture/${topic}`,
  storageKind: "clone",
  state: "ready",
  ownership: "managed",
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let api: any;
beforeEach(() => {
  vi.useFakeTimers();
  api = {
    readTopicBoard: vi.fn(async () => board),
    ensureTopicContext: vi.fn(),
    createTopicContext: vi.fn(),
    resolveTopicContext: vi.fn(async (ref: WorktreeRecord) =>
      record(ref.topic, ref),
    ),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function mount() {
  const onSelect = vi.fn(),
    onCreated = vi.fn(),
    onTransitionIntent = vi.fn();
  render(
    <TopicContextPicker
      project={project}
      board={board}
      selected={null}
      onSelect={onSelect}
      onCreated={onCreated}
      onTransitionIntent={onTransitionIntent}
      onClear={vi.fn()}
      onOpenCard={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  return { onSelect, onCreated, onTransitionIntent };
}
const retry = () =>
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
const choose = (topic = "a") =>
  fireEvent.click(screen.getByRole("row", { name: new RegExp(`^${topic} `) }));
function create() {
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "fresh" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Создать «fresh» и подготовить конвейер",
    }),
  );
}
it.each([
  ["ensure", "pending"],
  ["ensure", "completed"],
  ["create", "pending"],
  ["create", "completed"],
] as const)(
  "reconciles a %s flight on retry after UI timeout while host is %s without a second write",
  async (kind, timing) => {
    const pending = deferred<WorktreeRecord>(),
      clone = record(kind === "create" ? "fresh" : "a");
    const writer =
      kind === "create" ? api.createTopicContext : api.ensureTopicContext;
    writer.mockReturnValue(pending.promise);
    const view = mount();
    if (kind === "create") create();
    else choose();
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(screen.getByRole("alert")).toBeTruthy();
    if (timing === "completed") {
      await act(async () => pending.resolve(clone));
      expect(view.onSelect).not.toHaveBeenCalled();
      expect(view.onCreated).not.toHaveBeenCalled();
    }
    retry();
    if (timing === "pending") await act(async () => pending.resolve(clone));
    else await act(async () => {});
    expect(writer).toHaveBeenCalledTimes(1);
    expect(api.resolveTopicContext).toHaveBeenCalledExactlyOnceWith(
      contextRef(clone),
    );
    expect(
      kind === "create" ? view.onCreated : view.onSelect,
    ).toHaveBeenCalledExactlyOnceWith(clone);
    expect(screen.queryByRole("grid")).toBeNull();
  },
);
it.each([
  { contextId: "ctx-" + "c".repeat(64) },
  { revision: "00000000-0000-4000-8000-000000000002" },
  { projectId: "q" },
  { year: "2025" },
  { topic: "other" },
  { branch: "other" },
  { state: "missing" as const },
  { preparation: "pending" as const },
  { deletedAt: "2026-10-20T00:00:00Z" },
  { ownership: "external" as const },
  { storageKind: "linked" as const },
  { compatibility: "legacy-linked" as const },
])(
  "retains a completed preparation after a failed exact reconciliation and never recreates it: %j",
  async (change) => {
    const pending = deferred<WorktreeRecord>(),
      clone = record();
    api.ensureTopicContext.mockReturnValue(pending.promise);
    api.resolveTopicContext.mockResolvedValueOnce(record("a", change));
    const view = mount();
    choose();
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    await act(async () => pending.resolve(clone));
    retry();
    await act(async () => {});
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    expect(api.resolveTopicContext).toHaveBeenCalledExactlyOnceWith(
      contextRef(clone),
    );
    retry();
    await act(async () => {});
    expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(clone);
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    expect(api.resolveTopicContext).toHaveBeenCalledTimes(2);
  },
);
it("fails closed on a corrupt cached owner reference rather than resolving or recreating", async () => {
  const pending = deferred<WorktreeRecord>();
  api.ensureTopicContext.mockReturnValue(pending.promise);
  const view = mount();
  choose();
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  await act(async () =>
    pending.resolve(record("a", { contextId: "not-a-host-ref" })),
  );
  retry();
  await act(async () => {});
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(view.onSelect).not.toHaveBeenCalled();
});
it("does not let a late reconciled A replace a subsequently intended pending B", async () => {
  const a = deferred<WorktreeRecord>(),
    b = deferred<WorktreeRecord>(),
    resolution = deferred<WorktreeRecord>();
  api.ensureTopicContext.mockImplementation((identity: WorktreeRecord) =>
    identity.topic === "a" ? a.promise : b.promise,
  );
  api.resolveTopicContext.mockReturnValue(resolution.promise);
  const view = mount();
  choose();
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  await act(async () => a.resolve(record()));
  retry();
  await act(async () => {});
  choose("b");
  await act(async () => resolution.resolve(record()));
  expect(view.onSelect).not.toHaveBeenCalled();
  await act(async () => b.resolve(record("b")));
  expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(record("b"));
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(2);
});
