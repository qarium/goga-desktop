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
  installPrototypeContextFixture(api, [
    { id: "p", path: "/fixture/a", topic: "main", branch: "main" },
    { id: "q", path: "/fixture/b", topic: "main", branch: "main" },
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
it("keeps a clickable launch tab and the same draft across Home, Topics and a run; repeated open has no duplicate", async () => {
  render(<App />);
  await screen.findByRole("heading", { name: "Проект" });
  act(() => focusRun("b"));
  click("Проект");
  const input = await launch();
  fireEvent.change(input, { target: { value: "retained task" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Конвейер" }), {
    target: { value: "other" },
  });
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
    (screen.getByRole("combobox", { name: "Конвейер" }) as HTMLSelectElement)
      .value,
  ).toBe("other");
  click("Топики");
  fireEvent.click(screen.getByRole("tab", { name: /^Новый конвейер · / }));
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  fireEvent.click(screen.getByRole("tab", { name: /Сборка · topic/ }));
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
  render(<App />);
  await screen.findByRole("heading", { name: "Проект" });
  act(() => focusRun("b"));
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
  render(<App />);
  await screen.findByRole("heading", { name: "Проект" });
  act(() => focusRun("b"));
  click("Проект");
  const alpha = await launch();
  fireEvent.change(alpha, { target: { value: "alpha task" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Конвейер" }), {
    target: { value: "other" },
  });
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
    (screen.getByRole("combobox", { name: "Конвейер" }) as HTMLSelectElement)
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
  render(<App />);
  await screen.findByRole("heading", { name: "Проект" });
  act(() => focusRun("b"));
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
  render(<App />);
  await screen.findByRole("heading", { name: "Проект" });
  act(() => focusRun("b"));
  click("Проект");
  await launch();
  let finish!: (v: any) => void;
  api.launch = vi.fn(() => new Promise((r) => (finish = r)));
  click("Запустить");
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
  const owner = await api.ensureTopicContext.mock.results[0].value;
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
  render(<App />);
  await screen.findByRole("heading", { name: "Проект" });
  act(() => focusRun("b"));
  click("Проект");
  await launch();
  let finish!: (v: any) => void;
  api.launch = vi.fn(() => new Promise((r) => (finish = r)));
  click("Запустить");
  await waitFor(() => expect(api.launch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  const beta = await launch();
  fireEvent.change(beta, { target: { value: "new beta task" } });
  await act(async () => finish({ ...run, id: "late-alpha", kind: "pipeline" }));
  expect(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
    beta,
  );
  expect(beta.value).toBe("new beta task");
});
