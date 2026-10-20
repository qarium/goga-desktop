// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { BuildForm } from "../src/renderer/BuildForm";
import { App } from "../src/renderer/App";
let api: any;
let emitRuns: (runs: any[]) => void;
const context = {
  revision: "r",
  branch: "main",
  capabilities: [
    "workflow",
    "profile",
    "session-timeout",
    "idle-timeout",
    "wait",
    "max-iterations",
    "review-patience",
    "base-ref",
    "env",
    "add-host",
    "proxy",
    "clean",
    "update",
    "skip-review",
    "no-skip-review",
    "skip-manifest-check",
  ],
  defaults: { skipReview: false, profile: "" },
  branches: ["main"],
  workflows: ["quality"],
  profiles: [{ name: "fast", source: "project" }],
  historyPlan: { path: "plan.md" },
};
const run = {
  id: "b",
  kind: "build",
  projectId: "p",
  pipeline: "Сборка",
  topic: "topic",
  branch: "main",
  status: "exited",
  startedAt: "now",
  workflow: null,
  profile: null,
  build: { planPath: "old.md", clean: false },
  output: { text: "Finished fixture", truncated: false },
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Alpha", path: "/fixture/a" },
      { id: "q", name: "Beta", path: "/fixture/b" },
    ]),
    runs: vi.fn(async () => [run]),
    selectRun: vi.fn(async () => {}),
    onRuns: (cb: typeof emitRuns) => {
      emitRuns = cb;
      return () => {};
    },
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    readTopicBoard: vi.fn(async (projectId) => ({
      projectId,
      year: "2026",
      revision: "v",
      currentBranch: "main",
      currentTopic: null,
      baseRef: "main",
      branches: ["main"],
      dirty: false,
      active: false,
      entries: [],
      records: [],
      remoteEntries: [],
      remoteRecords: [],
    })),
    buildContext: vi.fn(async () => structuredClone(context)),
    readBuildPlan: vi.fn(async (_p, path) => ({
      path,
      text: "# Plan",
      version: "v",
    })),
    discover: vi.fn(async () => ({
      pipelines: [{ id: "verify", name: "Verify" }],
      topics: [{ topic: "main", branch: "main", remote: false }],
      currentBranch: "main",
      workflows: [],
      profiles: [],
      branches: ["main"],
    })),
    preview: vi.fn(async () => ({
      token: "v",
      stages: [{ id: "one", title: "One" }],
      profile: null,
      workflow: null,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "task",
      exists: true,
      version: "v",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    cancelRead: vi.fn(async () => {}),
    launchBuild: vi.fn(async () => ({ ...run, id: "new", status: "running" })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const contextB = {
  projectId: "p",
  year: "2026",
  topic: "feature",
  branch: "feature",
  contextId: "ctx-" + "b".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "a".repeat(64),
  projectPath: "/fixture/a",
  gitCommonDir: "/fixture/a/.git",
  path: "/fixture/home/.goga/desktop/worktrees/feature",
  ownership: "managed",
  storageKind: "linked",
  compatibility: "legacy-linked",
  state: "ready",
};
async function mountContexts(extraRuns: any[] = []) {
  api.ensureTopicContext = vi.fn(async () => contextB);
  api.listTopicContexts = vi.fn(async () => [contextB]);
  api.resolveTopicContext = vi.fn(async () => contextB);
  api.closeRun = vi.fn(async () => true);
  api.stopRun = vi.fn(async () => {});
  api.launch = vi.fn();
  api.readTopicBoard.mockResolvedValue({
    projectId: "p",
    year: "2026",
    revision: "v",
    currentBranch: "main",
    currentTopic: { topic: "main", branch: "main", remote: false },
    baseRef: "main",
    branches: ["main", "feature"],
    dirty: false,
    active: false,
    entries: [
      {
        topic: "main",
        branch: "main",
        remote: false,
        hosts: ["main"],
        statuses: [],
        todo: "",
      },
      {
        topic: "feature",
        branch: "feature",
        remote: false,
        hosts: ["feature"],
        statuses: [],
        todo: "",
      },
    ],
    records: [],
    remoteEntries: [],
    remoteRecords: [],
  });
  api.runs.mockResolvedValue([
    run,
    ...extraRuns,
    {
      ...run,
      id: "ctx-run",
      kind: "pipeline",
      pipeline: "verify",
      topic: "feature",
      branch: "feature",
      context: contextB,
      pipelineDescription: "Actual description",
      status: "running",
    },
  ]);
  render(<App />);
  await screen.findByLabelText("Исполняемый файл");
  await screen.findByRole("button", { name: "Выбрать другой топик" });
}
async function chooseFeature() {
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^feature / }));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
}
it("App selection prepares only the worktree and opens its list, not an arbitrary first run", async () => {
  await mountContexts();
  expect(screen.queryByRole("tab", { name: /verify/ })).toBeNull();
  await chooseFeature();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Совместимость рабочей копии" }),
  ).toBeTruthy();
  expect(screen.getByText("Actual description")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /verify/ })).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.launchBuild).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(
    within(screen.getByRole("menu")).getByText(
      /Прежняя linked-worktree копия доступна только для просмотра/,
    ),
  ).toBeTruthy();
  expect(api.launch).not.toHaveBeenCalled();
});
it("context run tabs open explicitly and closing never calls host close/stop", async () => {
  await mountContexts();
  await chooseFeature();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск verify" }),
  );
  expect(screen.getByRole("tab", { name: /verify/ })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /Закрыть вкладку verify/ }),
  );
  expect(screen.queryByRole("tab", { name: /verify/ })).toBeNull();
  expect(api.closeRun).not.toHaveBeenCalled();
  expect(api.stopRun).not.toHaveBeenCalled();
  expect(
    screen.getByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeTruthy();
});
it("a vanished contextual run returns to its list without silently selecting a legacy sibling", async () => {
  await mountContexts();
  await chooseFeature();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск verify" }),
  );
  await act(async () => emitRuns([run]));
  expect(
    screen.getByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeTruthy();
  expect(screen.queryByText("Повторить сборку")).toBeNull();
});
it("contextual build history cannot repeat through the legacy primary-cwd API", async () => {
  await mountContexts([
    {
      ...run,
      id: "ctx-build",
      topic: "feature",
      branch: "feature",
      context: contextB,
      build: { planPath: "docs/plan.md", clean: false },
    },
  ]);
  await chooseFeature();
  fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск docs/plan.md" }),
  );
  const repeat = screen.getByRole<HTMLButtonElement>("button", {
    name: "Повторить сборку",
  });
  expect(repeat.disabled).toBe(true);
  fireEvent.click(repeat);
  expect(api.launchBuild).not.toHaveBeenCalled();
});

it("a board error is visible in the new header and can be retried", async () => {
  api.readTopicBoard.mockRejectedValueOnce(Error("Доска временно недоступна"));
  await mountContexts();
  expect(await screen.findByText("Доска временно недоступна")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить загрузку топиков" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Доска временно недоступна")).toBeNull(),
  );
});
it("closing a background contextual tab preserves the current project page", async () => {
  await mountContexts();
  await chooseFeature();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск verify" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await screen.findByRole("region", { name: "Контекст недоступен" });
  fireEvent.click(
    screen.getByRole("button", { name: /Закрыть вкладку verify/ }),
  );
  expect(
    screen.getByRole("region", { name: "Контекст недоступен" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeNull();
});
