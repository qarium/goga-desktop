import { selectCatalog } from "./helpers/select-catalog";
import "./helpers/overview-browser-fixture";
// @vitest-environment jsdom
import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  selectPrototypeOwner,
  executionButton,
  openCurrentLaunch,
} from "./helpers/prototype-context-fixture";
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
import { App } from "../src/renderer/App";
let api: any;
let focusRun: (id: string) => void;
let updateRuns: (runs: any[]) => void;
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
    onRuns: (callback: typeof updateRuns) => {
      updateRuns = callback;
      return () => {};
    },
    onFocusRun: (cb: typeof focusRun) => {
      focusRun = cb;
      return () => {};
    },
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
      pipelines: [
        { id: "verify", name: "Verify" },
        { id: "other", name: "Other" },
      ],
      topics: [{ topic: "main", branch: "main", remote: false, current: true }],
      currentBranch: "main",
      workflows: ["quality"],
      profiles: [],
      branches: ["main"],
    })),
    preview: vi.fn(async () => ({
      token: "v",
      stages: [{ id: "one", title: "One" }],
      workflow: null,
      profile: null,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "task",
      exists: true,
      version: "v",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    launchBuild: vi.fn(async () => ({ ...run, id: "new", status: "running" })),
  };
  const fixture = installPrototypeContextFixture(api, [
    { id: "p", path: "/fixture/a", topic: "main", branch: "main" },
    { id: "q", path: "/fixture/b", topic: "main", branch: "main" },
  ]);
  // Navigation between tabs is tested within one explicit owner.
  api.listTopicContexts.mockImplementation(async (id: string) =>
    fixture.records.filter((r) => r.projectId === id),
  );
  api.runs.mockResolvedValue([
    { ...run, topic: fixture.owner("p").topic, context: fixture.owner("p") },
  ]);
  window.goga = api;
});
afterEach(cleanup);
const click = (name: string | RegExp) =>
  fireEvent.click(
    name === "Запустить"
      ? executionButton()
      : screen.getByRole("button", { name }),
  );
async function launch() {
  await openPrototypeLaunch();
  return (await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  })) as HTMLTextAreaElement;
}
async function mountReadyOwner() {
  const records = await api.listTopicContexts("p");
  let resolveInventory!: (value: unknown) => void;
  api.listTopicContexts.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveInventory = resolve;
      }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByRole("heading", { name: "Проект" });
  await waitFor(() => expect(resolveInventory).toBeTypeOf("function"));
  await act(async () => {
    resolveInventory(records);
  });
  // This test exercises navigation within a ready owner, not historical missing
  // clones. A heading alone does not mean the asynchronous inventory is ready:
  // focusing earlier intentionally records a read-only missing history owner.
  await selectPrototypeOwner();
  act(() => focusRun("b"));
}
it("keeps a clickable launch tab and the same draft across Home, Topics and a run; repeated open has no duplicate", async () => {
  await mountReadyOwner();
  click("Проект");
  const input = await launch();
  fireEvent.change(input, { target: { value: "retained task" } });
  selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "other");
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  click("Проект");
  const tab = screen.getByRole("tab", { name: /^Новый конвейер · / });
  expect(tab.getAttribute("aria-selected")).toBe("false");
  fireEvent.click(tab);
  expect(
    await screen.findByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBe(input);
  expect(input.value).toBe("retained task");
  expect(
    (screen.getByRole("combobox", { name: "Конвейер" }) as HTMLButtonElement)
      .value,
  ).toBe("other");
  click("Топики");
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  fireEvent.click(screen.getByRole("tab", { name: /Сборка · main/ }));
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  await openPrototypeLaunch();
  expect(
    screen.getAllByRole("tab", { name: /^Новый конвейер · / }),
  ).toHaveLength(1);
  expect(input.value).toBe("retained task");
  expect(api.discover).toHaveBeenCalledTimes(1);
});
it("both preparation tabs coexist, navigate by keyboard, and close independently", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  await openPrototypeLaunch("build");
  await screen.findByRole("textbox", { name: "План сборки" });
  const build = screen.getByRole("tab", { name: /^Новая сборка · / }),
    pipeline = screen.getByRole("tab", { name: /^Новый конвейер · / });
  fireEvent.keyDown(build, { key: "ArrowRight" });
  expect(document.activeElement).toBe(pipeline);
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  click(/^Закрыть вкладку Новая сборка · /);
  expect(screen.queryByRole("tab", { name: /^Новая сборка · / })).toBeNull();
  expect(screen.getByRole("tab", { name: /^Новый конвейер · / })).toBe(
    pipeline,
  );
  click(/^Закрыть вкладку Новый конвейер · /);
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(await screen.findByRole("heading", { name: "Проект" })).toBeTruthy();
});
it("isolates full launch preparation values and DOM between projects", async () => {
  await mountReadyOwner();
  click("Проект");
  const alpha = await launch();
  fireEvent.change(alpha, { target: { value: "alpha task" } });
  selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "other");
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  const beta = await launch();
  fireEvent.change(beta, { target: { value: "beta task" } });
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  expect(
    await screen.findByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBe(alpha);
  expect(alpha.value).toBe("alpha task");
  expect(screen.queryByRole("radio", { name: "Существующий" })).toBeNull();
  expect(api.discover.mock.calls[0][0]).toEqual(
    expect.objectContaining({ projectId: "p", topic: "main", branch: "main" }),
  );
  expect(
    (screen.getByRole("combobox", { name: "Конвейер" }) as HTMLButtonElement)
      .value,
  ).toBe("other");
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  expect(
    await screen.findByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBe(beta);
  expect(beta.value).toBe("beta task");
});

it("closing an inactive launch tab respects the dirty Home settings guard", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  click("Проект");
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Исполняемый файл" }),
    { target: { value: "changed" } },
  );
  click(/^Закрыть вкладку Новый конвейер · /);
  expect(
    screen.getByRole("heading", { name: "Сохранить изменения?" }),
  ).toBeTruthy();
  click("Отмена");
  expect(screen.getByRole("tab", { name: /^Новый конвейер · / })).toBeTruthy();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Исполняемый файл",
      }) as HTMLInputElement
    ).value,
  ).toBe("changed");
});
it("blocks closing while pending and closes the preparation after successful start", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (v: any) => void;
  api.launch = vi.fn(() => new Promise((r) => (finish = r)));
  click("Запустить");
  expect(
    screen.getByRole("status", { name: "Подготавливаем запуск…" }),
  ).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Конвейер" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
  expect(
    within(document.querySelector(".launch-panel")!).queryByRole("button", {
      name: "Запустить",
    }),
  ).toBeNull();
  await waitFor(() => expect(api.launch).toHaveBeenCalled());
  expect(
    (
      screen.getByRole("button", {
        name: /^Закрыть вкладку Новый конвейер · /,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Закрыть форму" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const owner = (await api.listTopicContexts("p"))[0];
  await act(async () =>
    finish({
      ...run,
      id: "pipeline",
      kind: "pipeline",
      pipeline: "pipeline",
      topic: owner.topic,
      branch: owner.branch,
      context: owner,
    }),
  );
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(
    screen
      .getByRole("tab", { name: "pipeline · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});
it("a late launch from another project never steals the current preparation or draft", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (v: any) => void;
  api.launch = vi.fn(() => new Promise((r) => (finish = r)));
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  const beta = await launch();
  fireEvent.change(beta, { target: { value: "new beta task" } });
  const owner = (await api.listTopicContexts("p"))[0];
  await act(async () =>
    finish({
      ...run,
      id: "late-alpha",
      kind: "pipeline",
      pipeline: "alpha-result",
      context: owner,
      topic: owner.topic,
      branch: owner.branch,
    }),
  );
  expect(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
    beta,
  );
  expect(beta.value).toBe("new beta task");
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(
    screen
      .getByRole("tab", { name: "alpha-result · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(
    within(document.querySelector(".project-actions")!).getByRole("button", {
      name: "Запустить",
    }),
  );
  expect(screen.getByRole("menuitem", { name: /^Конвейер/ })).toHaveProperty(
    "disabled",
    false,
  );
});

async function completePipeline(
  finish: (value: any) => void,
  id = "pipeline-result",
) {
  const owner = (await api.listTopicContexts("p"))[0];
  await act(async () =>
    finish({
      ...run,
      id,
      kind: "pipeline",
      pipeline: id,
      context: owner,
      topic: owner.topic,
      branch: owner.branch,
    }),
  );
}

it("publishes into the originating tab after navigating to Topics without taking focus", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  click("Топики");
  await screen.findByRole("heading", { name: "Топики" });
  await completePipeline(finish);
  expect(screen.getByRole("heading", { name: "Топики" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(
    screen
      .getByRole("tab", { name: "pipeline-result · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("false");
  fireEvent.click(
    screen.getByRole("tab", { name: "pipeline-result · main · main" }),
  );
  expect(
    screen
      .getByRole("tab", { name: "pipeline-result · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("continues the captured exact-owner launch after navigation during checkout validation", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let branch!: (value: string) => void, finish!: (value: any) => void;
  api.checkoutBranch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        branch = resolve;
      }),
  );
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(branch).toBeTypeOf("function"));
  click("Топики");
  await act(async () => branch("main"));
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0].context).toEqual(
    expect.objectContaining({ projectId: "p", topic: "main", branch: "main" }),
  );
  await completePipeline(finish);
  expect(screen.getByRole("heading", { name: "Топики" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
});

it("returns to the same preparation loader while its request is pending", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  click("Топики");
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  expect(
    screen.getByRole("status", { name: "Подготавливаем запуск…" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  await completePipeline(finish);
  expect(
    screen
      .getByRole("tab", { name: "pipeline-result · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("keeps a late launch failure and its edited task in the original preparation", async () => {
  await mountReadyOwner();
  click("Проект");
  const task = await launch();
  fireEvent.change(task, { target: { value: "important original task" } });
  let fail!: (error: Error) => void;
  api.launch = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  fireEvent.click(executionButton("Сохранить и запустить"));
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  click("Топики");
  await act(async () => fail(new Error("Synthetic launch failed")));
  expect(screen.getByRole("heading", { name: "Топики" })).toBeTruthy();
  expect(
    screen
      .queryAllByRole("alert")
      .some((node) => node.textContent?.includes("Synthetic launch failed")),
  ).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  expect(await screen.findByText("Synthetic launch failed")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
    task,
  );
  expect(task.value).toBe("important original task");
});

it("keeps the selected topic when another topic's pending launch succeeds", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(
    screen
      .getAllByRole("row")
      .find((row) => row.getAttribute("aria-label")?.startsWith("Без топика"))!,
  );
  click("Топики");
  await completePipeline(finish);
  expect(
    screen.getByRole("button", { name: "Без топика" }).textContent,
  ).toContain("Без топика");
  expect(screen.getByRole("heading", { name: "Топики" })).toBeTruthy();
  await selectPrototypeOwner();
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(
    screen.getByRole("tab", { name: "pipeline-result · main · main" }),
  ).toBeTruthy();
});

it("replaces a successful no-topic preparation with its run instead of leaving the draft open", async () => {
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Alpha" });
  await openCurrentLaunch();
  const form = await screen.findByRole("heading", {
    name: "Запустить конвейер",
  });
  await waitFor(() =>
    expect(
      within(form.closest(".launch-panel")!).getByRole("button", {
        name: "Запустить",
      }),
    ).toHaveProperty("disabled", false),
  );
  let finish!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  await act(async () =>
    finish({
      ...run,
      id: "primary-result",
      kind: "pipeline",
      pipeline: "primary-result",
      topic: null,
    }),
  );
  expect(screen.queryByRole("tab", { name: "Новый запуск" })).toBeNull();
  expect(
    screen
      .getByRole("tab", { name: "primary-result · Без топика · main" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("an early run event cannot leave the submitted preparation behind as a false stale draft", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  const owner = (await api.listTopicContexts("p"))[0];
  const launched = {
    ...run,
    id: "event-first",
    kind: "pipeline",
    pipeline: "event-first",
    status: "running",
    context: owner,
    topic: owner.topic,
    branch: owner.branch,
  };
  act(() => updateRuns([launched]));
  expect(
    screen.getByRole("status", { name: "Подготавливаем запуск…" }),
  ).toBeTruthy();
  await act(async () => finish(launched));
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(
    screen
      .getByRole("tab", { name: "event-first · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

async function prepareNewTopic() {
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Alpha" });
  await openCurrentLaunch();
  const mode = await screen.findByRole("radio", { name: "Создать новый" });
  fireEvent.click(mode);
  fireEvent.change(screen.getByRole("textbox", { name: "Имя нового топика" }), {
    target: { value: "fresh-topic" },
  });
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  fireEvent.change(task, { target: { value: "new topic task" } });
  await waitFor(() =>
    expect(executionButton()).toHaveProperty("disabled", false),
  );
  return task as HTMLTextAreaElement;
}

it("keeps the originating loader until its created clone is resolved, including leave and return", async () => {
  await prepareNewTopic();
  let finish!: (value: any) => void, resolveOwner!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  api.resolveTopicContext.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOwner = resolve;
      }),
  );
  click("Запустить");
  click("Создать и запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  const original = (await api.listTopicContexts("p"))[0];
  const created = {
    ...original,
    topic: "fresh-topic",
    branch: "fresh-topic",
    contextId: "ctx-" + "f".repeat(64),
    path: "/fixture/checked-copies/fresh",
  };
  await act(async () =>
    finish({
      ...run,
      id: "new-topic-run",
      kind: "pipeline",
      pipeline: "new-topic-run",
      context: created,
      topic: created.topic,
      branch: created.branch,
    }),
  );
  await waitFor(() => expect(resolveOwner).toBeTypeOf("function"));
  expect(
    screen.getByRole("status", { name: "Подготавливаем запуск…" }),
  ).toBeTruthy();
  click("Топики");
  fireEvent.click(screen.getByRole("tab", { name: "Новый запуск" }));
  expect(
    screen.getByRole("status", { name: "Подготавливаем запуск…" }),
  ).toBeTruthy();
  await act(async () => resolveOwner(created));
  expect(screen.queryByRole("tab", { name: "Новый запуск" })).toBeNull();
  expect(
    screen
      .getByRole("tab", { name: "new-topic-run · fresh-topic · fresh-topic" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика fresh-topic" }),
  ).toBeTruthy();
});

it("retains a new-topic launch error and draft through its background catalog refresh", async () => {
  const task = await prepareNewTopic();
  let fail!: (error: Error) => void;
  api.launch = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  click("Запустить");
  click("Создать и запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  click("Топики");
  await act(async () => fail(new Error("Synthetic new-topic failure")));
  fireEvent.click(screen.getByRole("tab", { name: "Новый запуск" }));
  await waitFor(() =>
    expect(executionButton()).toHaveProperty("disabled", false),
  );
  expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
    task,
  );
  expect(task.value).toBe("new topic task");
  expect(screen.getByRole("alert").textContent).toContain(
    "Synthetic new-topic failure",
  );
});

it("does not reactivate a completed launch over a newer topic transition that is still verifying", async () => {
  const original = (await api.listTopicContexts("p"))[0];
  const otherProject = await api.listTopicContexts("q");
  const nextOwner = {
    ...original,
    topic: "second-topic",
    branch: "second-topic",
    contextId: "ctx-" + "d".repeat(64),
    path: "/fixture/checked-copies/second",
  };
  api.listTopicContexts.mockImplementation(async (id: string) =>
    id === "p" ? [original, nextOwner] : otherProject,
  );
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (value: any) => void, verify!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  api.resolveTopicContext.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        verify = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(
    screen.getByRole("row", { name: /^second-topic second-topic / }),
  );
  await waitFor(() => expect(verify).toBeTypeOf("function"));
  await completePipeline(finish);
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(
    screen
      .getByRole("tab", { name: "pipeline-result · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("false");
  await act(async () => verify(nextOwner));
  expect(
    screen.getByRole("button", {
      name: "Открыть карточку топика second-topic",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("tab", { name: "pipeline-result · main · main" }),
  ).toBeNull();
});

it("an explicit return to the originating preparation after topic navigation adopts its pending result", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(
    screen
      .getAllByRole("row")
      .find((row) => row.getAttribute("aria-label")?.startsWith("Без топика"))!,
  );
  await selectPrototypeOwner();
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  expect(
    screen.getByRole("status", { name: "Подготавливаем запуск…" }),
  ).toBeTruthy();
  await completePipeline(finish);
  expect(
    screen
      .getByRole("tab", { name: "pipeline-result · main · main" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("keeps a background created-owner verification failure attached to its run, not another project's form", async () => {
  await prepareNewTopic();
  let finish!: (value: any) => void, failOwner!: (error: Error) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  api.resolveTopicContext.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        failOwner = reject;
      }),
  );
  click("Запустить");
  click("Создать и запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  const original = (await api.listTopicContexts("p"))[0];
  const created = {
    ...original,
    topic: "fresh-topic",
    branch: "fresh-topic",
    contextId: "ctx-" + "f".repeat(64),
    path: "/fixture/checked-copies/fresh",
  };
  await act(async () =>
    finish({
      ...run,
      id: "owner-failed-run",
      kind: "pipeline",
      pipeline: "owner-failed-run",
      context: created,
      topic: created.topic,
      branch: created.branch,
    }),
  );
  await waitFor(() => expect(failOwner).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  const beta = await launch();
  fireEvent.change(beta, { target: { value: "unrelated beta task" } });
  await act(async () =>
    failOwner(new Error("Synthetic owner verification failed")),
  );
  expect(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy();
  expect(screen.queryByText("Synthetic owner verification failed")).toBeNull();
  expect(beta.value).toBe("unrelated beta task");
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  expect(
    await screen.findByText("Synthetic owner verification failed"),
  ).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Новый запуск" })).toBeNull();
  expect(
    screen
      .getByRole("tab", {
        name: "owner-failed-run · fresh-topic · fresh-topic",
      })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("defers only the originating result presentation while a topic card is open and resumes when it closes", async () => {
  await mountReadyOwner();
  click("Проект");
  await launch();
  let finish!: (value: any) => void;
  api.launch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть карточку топика main" }),
  );
  const card = await screen.findByRole("dialog");
  await completePipeline(finish);
  expect(screen.getByRole("dialog")).toBe(card);
  fireEvent.click(
    within(card).getByRole("button", { name: "Закрыть карточку" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("tab", { name: "pipeline-result · main · main" })
        .getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(screen.queryByRole("tab", { name: /^Новый конвейер · / })).toBeNull();
  expect(api.launch).toHaveBeenCalledTimes(1);
});
