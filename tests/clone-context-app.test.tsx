import "./helpers/overview-browser-fixture";
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
    readTopicOverview: vi.fn(),
    prepareTopicOperation: vi.fn(),
    executeTopicOperation: vi.fn(),
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
  api.readTopicTable = vi.fn((id: string) => api.readTopicBoard(id));
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
  storageKind: "clone",
  state: "ready",
};
async function mountContexts(
  extraRuns: any[] = [],
  active = false,
  inventory?: Promise<any[]>,
) {
  api.ensureTopicContext = vi.fn(async () => contextB);
  api.listTopicContexts = vi.fn(() => inventory ?? Promise.resolve([contextB]));
  api.resolveTopicContext = vi.fn(async () => contextB);
  api.checkTopicContextReadiness = vi.fn(async (ref) => ({
    ...contextB,
    ...ref,
  }));
  api.closeRun = vi.fn(async () => true);
  api.stopRun = vi.fn(async () => {});
  api.launch = vi.fn(async (r) => ({
    ...run,
    id: "launched",
    pipeline: r.pipeline,
    topic: r.topic.topic,
    branch: r.topic.branch,
    context: r.context,
    kind: "pipeline",
    status: "running",
  }));
  api.discover.mockImplementation(async (scope: any) => ({
    pipelines: [{ id: "verify", name: "Verify" }],
    topics: [],
    currentBranch: scope.branch,
    workflows: [],
    profiles: [],
    branches: ["main"],
  }));
  api.checkoutBranch.mockImplementation(async (scope: any) => scope.branch);
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
      status: active ? "running" : "exited",
    },
  ]);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByLabelText("Исполняемый файл");
  await screen.findByRole("button", { name: "Выбрать другой топик" });
}
async function chooseFeature() {
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^feature / }));
  await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
  await screen.findByRole("button", {
    name: "Открыть карточку топика feature",
  });
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
}

it("opens a full clone-bound preparation without intermediate blocker or a second selector", async () => {
  await mountContexts();
  await chooseFeature();
  expect(screen.queryByText("Промежуточный этап")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Конвейер/ }));
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  expect(api.discover).toHaveBeenCalledWith(
    expect.objectContaining({ contextId: contextB.contextId }),
  );
  expect(screen.queryByText("Существующий")).toBeNull();
  fireEvent.change(task, { target: { value: "Owned draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  fireEvent.click(
    screen.getByRole("tab", { name: "Новый конвейер · feature" }),
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Что нужно сделать?",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Owned draft");
  fireEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  await waitFor(() => expect(api.launch).toHaveBeenCalled());
  expect(api.launch.mock.calls[0][0].context.contextId).toBe(
    contextB.contextId,
  );
  expect(screen.getByRole("tab", { name: /verify/ })).toBeTruthy();
});
it("keeps historical output accessible without recreating a missing clone", async () => {
  await mountContexts();
  await chooseFeature();
  api.listTopicContexts.mockResolvedValue([]);
  // Selecting history uses its recorded owner and must not ensure a clone again.
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск verify" }),
  );
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).toHaveBeenCalledExactlyOnceWith({
    projectId: contextB.projectId,
    year: contextB.year,
    topic: contextB.topic,
    branch: contextB.branch,
    contextId: contextB.contextId,
    revision: contextB.revision,
  });
  expect(screen.getByText("Finished fixture")).toBeTruthy();
});

it("quick create makes an empty clone-owned topic and opens a blank draft, not a run", async () => {
  await mountContexts();
  const created = {
    ...contextB,
    topic: "new-topic",
    branch: "new-topic",
    contextId: "ctx-" + "c".repeat(64),
  };
  api.createTopicContext = vi.fn(async () => created);
  api.readTopicTask.mockResolvedValue({
    text: "",
    version: "missing",
    exists: false,
    path: "todo.md",
  });
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Найти топик" }), {
    target: { value: "new-topic" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Создать «new-topic» и подготовить конвейер",
    }),
  );
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  expect((task as HTMLTextAreaElement).value).toBe("");
  expect(api.createTopicContext).toHaveBeenCalledWith({
    projectId: "p",
    year: "2026",
    branch: "new-topic",
    baseRef: "main",
  });
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.launchBuild).not.toHaveBeenCalled();
});
it("keeps two context drafts independent and restores selector ownership without reloading on tab switches", async () => {
  const main = {
    ...contextB,
    topic: "main",
    branch: "main",
    contextId: "ctx-" + "a".repeat(64),
  };
  await mountContexts();
  api.listTopicContexts.mockResolvedValue([main, contextB]);
  api.resolveTopicContext.mockImplementation(async (ref: any) =>
    ref.contextId === main.contextId ? main : contextB,
  );
  api.ensureTopicContext.mockImplementation(async (identity: any) =>
    identity.topic === "main" ? main : contextB,
  );
  await chooseFeature();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Конвейер/ }));
  const taskA = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  fireEvent.change(taskA, { target: { value: "Task A retained" } });
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^main / }));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Конвейер/ }));
  const taskB = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  fireEvent.change(taskB, { target: { value: "Task B retained" } });
  const calls = api.discover.mock.calls.length;
  expect(
    screen.queryByRole("tab", { name: "Новый конвейер · feature" }),
  ).toBeNull();
  await chooseFeature();
  fireEvent.click(
    screen.getByRole("tab", { name: "Новый конвейер · feature" }),
  );
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature" }),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Что нужно сделать?",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Task A retained");
  expect(
    screen.queryByRole("tab", { name: "Новый конвейер · main" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^main / }));
  await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
  await screen.findByRole("button", { name: "Открыть карточку топика main" });
  fireEvent.click(screen.getByRole("tab", { name: "Новый конвейер · main" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Что нужно сделать?",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Task B retained");
  expect(api.discover.mock.calls.length).toBe(calls);
});
it("shows a separate zero activity badge and keeps another clone activity out of the count", async () => {
  const other = {
    ...contextB,
    topic: "other",
    branch: "other",
    contextId: "ctx-" + "d".repeat(64),
  };
  await mountContexts([
    {
      ...run,
      id: "other-active",
      status: "starting",
      topic: other.topic,
      branch: other.branch,
      context: other,
    },
  ]);
  await chooseFeature();
  expect(
    screen
      .getByRole("button", { name: "Запуски" })
      .querySelector(".context-active-count")?.textContent,
  ).toBe("0");
});

it("App does not read primary topic details when the asynchronous clone inventory is still pending", async () => {
  await mountContexts([], false, new Promise(() => {}));
  api.readTopicDetails = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  const card = await screen.findByRole("button", {
    name: "Открыть топик main",
  });
  const boardReads = api.readTopicBoard.mock.calls.length;
  fireEvent.click(card);
  const overview = await screen.findByRole("dialog", { name: "main" });
  expect(
    within(overview).getByRole("status", { name: "Загружаем задачу…" }),
  ).toBeTruthy();
  expect(
    within(overview).getByRole("button", { name: "Удалить топик…" }),
  ).toHaveProperty("disabled", true);
  expect(api.readTopicOverview).not.toHaveBeenCalled();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
  expect(api.readTopicBoard.mock.calls.length).toBe(boardReads);
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
});
it("App does not fall back to primary topic details after clone inventory failure", async () => {
  const unavailable = Promise.reject(Error("Inventory error"));
  void unavailable.catch(() => {});
  await mountContexts([], false, unavailable);
  api.readTopicDetails = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  const card = await screen.findByRole("button", {
    name: "Открыть топик main",
  });
  const boardReads = api.readTopicBoard.mock.calls.length;
  fireEvent.click(card);
  const overview = await screen.findByRole("dialog", { name: "main" });
  expect(within(overview).getByRole("alert").textContent).toBe(
    "Inventory error",
  );
  expect(
    within(overview).getByRole("button", { name: "Удалить топик…" }),
  ).toHaveProperty("disabled", true);
  expect(api.readTopicOverview).not.toHaveBeenCalled();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
  expect(api.readTopicBoard.mock.calls.length).toBe(boardReads);
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
});

it("retains selected topic, preparation tab and dirty draft across sidebar collapse", async () => {
  await mountContexts();
  await chooseFeature();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Конвейер/ }));
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  fireEvent.change(task, { target: { value: "Unsaved owned draft" } });
  const tab = screen.getByRole("tab", { name: "Новый конвейер · feature" });
  const beforeDiscover = api.discover.mock.calls.length;
  for (const name of ["Свернуть боковую панель", "Развернуть боковую панель"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(
      screen.getByRole("button", { name: "Открыть карточку топика feature" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Новый конвейер · feature" })).toBe(
      tab,
    );
    expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
      task,
    );
    expect((task as HTMLTextAreaElement).value).toBe("Unsaved owned draft");
    expect(api.discover.mock.calls.length).toBe(beforeDiscover);
    expect(api.launch).not.toHaveBeenCalled();
  }
});
