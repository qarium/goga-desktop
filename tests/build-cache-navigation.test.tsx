// @vitest-environment jsdom
import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  executionButton,
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
} from "@testing-library/react";
import { BuildForm } from "../src/renderer/BuildForm";
import { App } from "../src/renderer/App";
let api: any;
let focusRun: (id: string) => void;
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
    onRuns: () => () => {},
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
  installPrototypeContextFixture(api, [
    { id: "p", path: "/fixture/a", topic: "main", branch: "main" },
    { id: "q", path: "/fixture/b", topic: "main", branch: "main" },
  ]);
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const click = (name: string | RegExp) =>
  fireEvent.click(
    name === "Запустить"
      ? executionButton()
      : screen.getByRole("button", { name }),
  );
const change = (name: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
const draftTab = () => screen.getByRole("tab", { name: /^Новая сборка · / });
async function openBuild() {
  await openPrototypeLaunch("build");
  await screen.findByRole("textbox", { name: "План сборки" });
  await waitFor(() => executionButton());
}
async function mount() {
  render(<App />);
  await screen.findByLabelText("Исполняемый файл");
  act(() => focusRun("b"));
  click("Проект");
}

const project = { id: "p", name: "Alpha", path: "/fixture/a" };
const build = (props = {}) => (
  <BuildForm
    project={project}
    onCancel={() => {}}
    onLaunched={() => {}}
    {...props}
  />
);
const advance = async (ms = 200) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const flush = async () => {
  await advance(200);
  await advance(1);
};
const deferred = () => {
  let resolve!: (v: any) => void, reject!: (e: Error) => void;
  const promise = new Promise<any>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const noLoader = () =>
  expect(document.querySelector(".build-form .loading-state")).toBeNull();
it.each(["ready", "missing", "context-error", "plan-error", "empty"])(
  "navigation keeps settled %s data without a new read or loader",
  async (mode) => {
    vi.useFakeTimers();
    if (mode === "missing")
      api.readBuildPlan.mockRejectedValue(Error("[build-plan:missing]"));
    if (mode === "context-error")
      api.buildContext.mockRejectedValue(Error("context unavailable"));
    if (mode === "plan-error")
      api.readBuildPlan.mockRejectedValue(Error("[build-plan:outside]"));
    if (mode === "empty")
      api.buildContext.mockResolvedValue({
        ...context,
        historyPlan: { path: "" },
      });
    const view = render(build({ revision: "v1" }));
    await flush();
    noLoader();
    const body = document.querySelector(".build-form")!.textContent;
    const counts = [
      api.buildContext.mock.calls.length,
      api.readBuildPlan.mock.calls.length,
    ];
    for (let i = 0; i < 3; i++) {
      view.rerender(build({ revision: "v1", suspended: true }));
      await advance(1000);
      view.rerender(build({ revision: "v1" }));
      noLoader();
      await flush();
      noLoader();
      expect(document.querySelector(".build-form")!.textContent).toBe(body);
      expect([
        api.buildContext.mock.calls.length,
        api.readBuildPlan.mock.calls.length,
      ]).toEqual(counts);
    }
  },
);
it("defers a hidden revision until return and never exposes the previous ready frame", async () => {
  vi.useFakeTimers();
  const view = render(build({ revision: "v1" }));
  await flush();
  const input = screen.getByRole("textbox", { name: "План сборки" });
  const counts = [
    api.buildContext.mock.calls.length,
    api.readBuildPlan.mock.calls.length,
  ];
  view.rerender(build({ revision: "v1", suspended: true }));
  view.rerender(build({ revision: "v2", suspended: true }));
  await advance(1000);
  expect([
    api.buildContext.mock.calls.length,
    api.readBuildPlan.mock.calls.length,
  ]).toEqual(counts);
  view.rerender(build({ revision: "v2" }));
  expect(screen.queryByRole("textbox", { name: "План сборки" })).toBeNull();
  await flush();
  expect(api.buildContext).toHaveBeenCalledTimes(counts[0] + 1);
  expect(api.readBuildPlan.mock.calls.length).toBeGreaterThan(counts[1]);
  expect(screen.getByRole("textbox", { name: "План сборки" })).toBe(input);
  noLoader();
});
it.each(["context", "plan"])(
  "leaving during pending %s keeps the same bounded attempt",
  async (stage) => {
    vi.useFakeTimers();
    const d = deferred();
    api[
      stage === "context" ? "buildContext" : "readBuildPlan"
    ].mockReturnValueOnce(d.promise);
    const view = render(build({ revision: "v1" }));
    await flush();
    view.rerender(build({ revision: "v1", suspended: true }));
    expect(api.cancelRead).not.toHaveBeenCalled();
    await act(async () =>
      d.resolve(
        stage === "context"
          ? context
          : { path: "plan.md", text: "ready", version: "v" },
      ),
    );
    await advance(1);
    view.rerender(build({ revision: "v1" }));
    noLoader();
    await flush();
    expect(api.buildContext).toHaveBeenCalledTimes(1);
    expect(api.readBuildPlan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "План сборки" })).toBeTruthy();
  },
);
it("returning before a pending attempt finishes shows the existing loader, not a new attempt", async () => {
  vi.useFakeTimers();
  const d = deferred();
  api.buildContext.mockReturnValueOnce(d.promise);
  const view = render(build());
  await flush();
  view.rerender(build({ suspended: true }));
  view.rerender(build());
  await flush();
  expect(api.buildContext).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".build-form .loading-state")).toBeTruthy();
  await act(async () => d.resolve(context));
  await advance(1);
  noLoader();
});
it("hidden pending timeout is retained as an error; explicit retry alone starts a fresh attempt", async () => {
  vi.useFakeTimers();
  api.buildContext.mockReturnValueOnce(new Promise(() => {}));
  const view = render(build());
  await flush();
  view.rerender(build({ suspended: true }));
  await advance(300001);
  view.rerender(build());
  noLoader();
  expect(screen.getByRole("alert").textContent).toContain(
    "Превышено время ожидания",
  );
  expect(api.buildContext).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await flush();
  noLoader();
  expect(api.buildContext).toHaveBeenCalledTimes(2);
});
it("hidden revision invalidates a late old response only when returning to the new semantic context", async () => {
  vi.useFakeTimers();
  const old = deferred(),
    fresh = deferred();
  api.buildContext
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const view = render(build({ revision: "old" }));
  await flush();
  view.rerender(build({ revision: "old", suspended: true }));
  view.rerender(build({ revision: "new", suspended: true }));
  await advance(1000);
  expect(api.buildContext).toHaveBeenCalledTimes(1);
  view.rerender(build({ revision: "new" }));
  await flush();
  await act(async () =>
    old.resolve({ ...context, historyPlan: { path: "stale.md" } }),
  );
  expect(screen.queryByRole("textbox", { name: "План сборки" })).toBeNull();
  await act(async () =>
    fresh.resolve({ ...context, historyPlan: { path: "fresh.md" } }),
  );
  await advance(1);
  expect(
    (screen.getByRole("textbox", { name: "План сборки" }) as HTMLInputElement)
      .value,
  ).toBe("fresh.md");
});
it("real path/workflow/profile/env/revision and explicit refresh still read the needed data", async () => {
  vi.useFakeTimers();
  const view = render(build({ revision: "v1" }));
  await flush();
  const initialContext = api.buildContext.mock.calls.length,
    initialPlan = api.readBuildPlan.mock.calls.length;
  fireEvent.change(screen.getByRole("textbox", { name: "План сборки" }), {
    target: { value: "custom.md" },
  });
  await flush();
  expect(api.buildContext).toHaveBeenCalledTimes(initialContext);
  expect(api.readBuildPlan.mock.calls.length).toBeGreaterThan(initialPlan);
  for (const [label, value] of [
    ["Рабочий процесс", "quality"],
    ["Профиль", "fast"],
  ]) {
    const count = api.buildContext.mock.calls.length;
    fireEvent.change(screen.getByRole("combobox", { name: label }), {
      target: { value },
    });
    await flush();
    expect(api.buildContext).toHaveBeenCalledTimes(count + 1);
  }
  document.querySelectorAll("details").forEach((e) => (e.open = true));
  fireEvent.click(screen.getByRole("button", { name: "Добавить переменную" }));
  await flush();
  const count = api.buildContext.mock.calls.length;
  fireEvent.change(screen.getByLabelText("Имя переменной 1"), {
    target: { value: "TEST" },
  });
  fireEvent.change(screen.getByLabelText("Значение переменной 1"), {
    target: { value: "value" },
  });
  await flush();
  expect(api.buildContext.mock.calls.length).toBeGreaterThan(count);
  const revisionCount = api.buildContext.mock.calls.length;
  view.rerender(build({ revision: "v2" }));
  await flush();
  expect(api.buildContext).toHaveBeenCalledTimes(revisionCount + 1);
  fireEvent.click(screen.getByRole("button", { name: "Обновить данные" }));
  await flush();
  expect(api.buildContext).toHaveBeenCalledTimes(revisionCount + 2);
});
it("App navigation through Project, Topics, launch, runs and settings does not reread the ready build", async () => {
  await mount();
  await openBuild();
  const input = screen.getByRole("textbox", { name: "План сборки" });
  const counts = [
    api.buildContext.mock.calls.length,
    api.readBuildPlan.mock.calls.length,
  ];
  for (const section of ["Проект", "Топики", "launch", "run", "settings"]) {
    if (section === "launch") {
      await openPrototypeLaunch();
      await screen.findByRole("textbox", { name: "Что нужно сделать?" });
    } else if (section === "run")
      fireEvent.click(screen.getByRole("tab", { name: /Сборка · topic/ }));
    else if (section === "settings") {
      click(/Настройки$/);
      click(/Назад/);
    } else click(section);
    fireEvent.click(draftTab());
    noLoader();
    expect(screen.getByRole("textbox", { name: "План сборки" })).toBe(input);
    await act(async () => new Promise((r) => setTimeout(r, 220)));
    expect([
      api.buildContext.mock.calls.length,
      api.readBuildPlan.mock.calls.length,
    ]).toEqual(counts);
  }
  click("Проект");
  expect(
    screen.getByRole("heading", { name: "Проект", level: 2 }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Главная" })).toBeNull();
});
it("two projects retain their own ready snapshots and do not inherit each other's revision", async () => {
  await mount();
  await openBuild();
  const alpha = screen.getByRole("textbox", { name: "План сборки" });
  click(/Beta/);
  await openBuild();
  const beta = screen.getByRole("textbox", { name: "План сборки" });
  const counts = [
    api.buildContext.mock.calls.length,
    api.readBuildPlan.mock.calls.length,
  ];
  click(/Alpha/);
  fireEvent.click(draftTab());
  noLoader();
  expect(screen.getByRole("textbox", { name: "План сборки" })).toBe(alpha);
  click(/Beta/);
  fireEvent.click(draftTab());
  noLoader();
  expect(screen.getByRole("textbox", { name: "План сборки" })).toBe(beta);
  await act(async () => new Promise((r) => setTimeout(r, 220)));
  expect([
    api.buildContext.mock.calls.length,
    api.readBuildPlan.mock.calls.length,
  ]).toEqual(counts);
});
it("leaving never cancels an actual build and revokes navigation consent for its late result", async () => {
  vi.useFakeTimers();
  const pending = deferred(),
    launched = vi.fn();
  api.launchBuild.mockReturnValueOnce(pending.promise);
  const view = render(build({ onLaunched: launched }));
  await flush();
  fireEvent.click(executionButton());
  await advance(1);
  expect(api.launchBuild).toHaveBeenCalledOnce();
  view.rerender(build({ suspended: true, onLaunched: launched }));
  view.rerender(build({ onLaunched: launched }));
  expect(api.cancelRead).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ ...run, id: "done" }));
  expect(launched).toHaveBeenCalledWith(
    expect.objectContaining({ id: "done" }),
    true,
  );
  expect(api.buildContext).toHaveBeenCalledTimes(1);
  expect(api.readBuildPlan).toHaveBeenCalledTimes(1);
});
it("a retained hidden launch button cannot start a build", async () => {
  vi.useFakeTimers();
  const view = render(build());
  await flush();
  const button = executionButton();
  view.rerender(build({ suspended: true }));
  fireEvent.click(button);
  expect(api.launchBuild).not.toHaveBeenCalled();
});
