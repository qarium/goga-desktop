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
  within,
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
const field = (name: string | RegExp, options?: any) => {
  const region = screen.queryByRole("region", { name: "Новая сборка" });
  return (region ? within(region) : screen).getByLabelText(name, options);
};
const change = (name: string | RegExp, value: string) =>
  fireEvent.change(field(name), { target: { value } });
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
const values: [string | RegExp, string][] = [
  ["План сборки", "docs/custom.md"],
  ["Рабочий процесс", "quality"],
  ["Профиль", "fast"],
  [/^Максимальное время одной сессии/, "1h"],
  ["Максимальное время бездействия", "10m"],
  [/^Пауза при лимите ИИ/, "5m"],
  ["Максимальное число итераций", "7"],
  ["База сравнения", "main"],
  ["Повторные раунды без изменений", "3"],
  ["Имя переменной 1", "TEST"],
  ["Значение переменной 1", "fixture"],
  ["Имя хоста 1", "example.test"],
  ["IP-адрес 1", "127.0.0.1"],
  ["Прокси", "http://localhost:8080"],
];
function checkValues() {
  for (const [label, value] of values)
    expect(
      (
        field(label, {
          selector: "input,select",
        }) as HTMLInputElement
      ).value,
    ).toBe(value);
  expect(
    (field("Очистить состояние предыдущей сборки") as HTMLInputElement).checked,
  ).toBe(true);
}
it("keeps one clickable build tab and all draft values through Home, Topics, runs and repeat entry", async () => {
  await mount();
  await openBuild();
  expect(screen.getAllByRole("tab")[0]).toBe(draftTab());
  document.querySelectorAll("details").forEach((e) => (e.open = true));
  click("Добавить переменную");
  await screen.findByRole("button", { name: "Добавить хост" });
  click("Добавить хост");
  change("Имя переменной 1", "TEST");
  change("Значение переменной 1", "fixture");
  for (const [label, value] of values) {
    if (
      ["Рабочий процесс", "Профиль", "База сравнения"].includes(String(label))
    )
      await waitFor(() => {
        const select = field(label, {
          selector: "input,select",
        }) as HTMLSelectElement;
        expect(select.disabled).toBe(false);
        expect([...select.options].some((o) => o.value === value)).toBe(true);
      });
    change(label, value);
  }
  fireEvent.click(field("Очистить состояние предыдущей сборки"));
  await waitFor(() =>
    expect((executionButton() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Пропустить ревью" }));
  fireEvent.click(field("Разрешить сборку с незакоммиченными контрактами"));
  for (const destination of ["Проект", "Топики", "run"]) {
    if (destination === "run")
      fireEvent.click(screen.getByRole("tab", { name: /Сборка · topic/ }));
    else click(destination);
    expect(draftTab().getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByRole("region", { name: "Новая сборка" })).toBeNull();
    fireEvent.click(draftTab());
    await screen.findByRole("textbox", { name: "План сборки" });
    await waitFor(() => executionButton());
    expect(draftTab().getAttribute("aria-selected")).toBe("true");
    checkValues();
    expect(
      screen
        .getByRole("switch", { name: "Пропустить ревью" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (
        field(
          "Разрешить сборку с незакоммиченными контрактами",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  }
  await openPrototypeLaunch("build");
  checkValues();
  expect(screen.getAllByRole("tab", { name: /^Новая сборка · / })).toHaveLength(
    1,
  );
  expect(document.querySelectorAll(".build-form")).toHaveLength(1);
  expect(api.launchBuild).not.toHaveBeenCalled();
});
it("isolates open state and drafts per project, closes only the target draft and starts fresh on reopening", async () => {
  await mount();
  await openBuild();
  change("План сборки", "alpha.md");
  click(/Beta/);
  expect(screen.queryByRole("tab", { name: /^Новая сборка · / })).toBeNull();
  await openBuild();
  change("План сборки", "beta.md");
  click(/Alpha/);
  fireEvent.click(draftTab());
  await screen.findByRole("textbox", { name: "План сборки" });
  await waitFor(() => executionButton());
  expect((field("План сборки") as HTMLInputElement).value).toBe("alpha.md");
  click(/^Закрыть вкладку Новая сборка · /);
  expect(screen.queryByRole("tab", { name: /^Новая сборка · / })).toBeNull();
  expect(screen.queryByRole("region", { name: "Новая сборка" })).toBeNull();
  expect(document.querySelectorAll(".build-form")).toHaveLength(1); // other project's retained cache
  await openBuild();
  expect((field("План сборки") as HTMLInputElement).value).toBe("plan.md");
  click(/Beta/);
  fireEvent.click(draftTab());
  await screen.findByRole("textbox", { name: "План сборки" });
  await waitFor(() => executionButton());
  expect((field("План сборки") as HTMLInputElement).value).toBe("beta.md");
});
it.each(["Закрыть форму сборки", "Отмена"])(
  "explicit %s closes the draft tab",
  async (name) => {
    await mount();
    await openBuild();
    click(name);
    expect(screen.queryByRole("tab", { name: /^Новая сборка · / })).toBeNull();
    expect(document.querySelector(".build-form")).toBeNull();
  },
);
it("inactive close preserves the current section and respects dirty Home navigation guard", async () => {
  await mount();
  await openBuild();
  click("Проект");
  await screen.findByLabelText("Исполняемый файл");
  change("Исполняемый файл", "/changed");
  click(/^Закрыть вкладку Новая сборка · /);
  await screen.findByRole("heading", { name: "Сохранить изменения?" });
  click("Отмена");
  expect(draftTab()).toBeTruthy();
  expect((field("Исполняемый файл") as HTMLInputElement).value).toBe(
    "/changed",
  );
  click(/^Закрыть вкладку Новая сборка · /);
  click("Не сохранять и перейти");
  expect(screen.queryByRole("tab", { name: /^Новая сборка · / })).toBeNull();
  expect(screen.getByRole("heading", { name: "Проект" })).toBeTruthy();
});
it("guards dirty Home before returning to a draft and keyboard navigates between run and draft tabs", async () => {
  await mount();
  await openBuild();
  click("Проект");
  await screen.findByLabelText("Исполняемый файл");
  change("Исполняемый файл", "/changed");
  fireEvent.click(draftTab());
  await screen.findByRole("heading", { name: "Сохранить изменения?" });
  click("Отмена");
  expect(draftTab().getAttribute("aria-selected")).toBe("false");
  fireEvent.click(draftTab());
  click("Не сохранять и перейти");
  await screen.findByRole("textbox", { name: "План сборки" });
  await waitFor(() => executionButton());
  fireEvent.keyDown(draftTab(), { key: "ArrowLeft" });
  expect(await screen.findByText("Finished fixture")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("tab", { name: /Сборка · topic/ }), {
    key: "ArrowRight",
  });
  await screen.findByRole("textbox", { name: "План сборки" });
  await waitFor(() => executionButton());
  expect(draftTab().getAttribute("aria-selected")).toBe("true");
});
it("disables closing a pending draft and consumes it after a successful owner launch", async () => {
  let resolve: any;
  api.launchBuild.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await mount();
  await openBuild();
  click("Запустить");
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalledTimes(1));
  expect(
    (
      screen.getByRole("button", {
        name: /^Закрыть вкладку Новая сборка · /,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const owner = await api.ensureTopicContext.mock.results[0].value;
  await act(async () =>
    resolve({
      ...run,
      id: "new",
      status: "running",
      topic: owner.topic,
      branch: owner.branch,
      context: owner,
    }),
  );
  await screen.findByRole("heading", { name: "Сборка выполняется" });
  expect(screen.queryByRole("tab", { name: /^Новая сборка · / })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(screen.queryByRole("menuitem", { name: /^Сборка/ })).toBeNull();
  expect(screen.getByText("Сборка уже выполняется")).toBeTruthy();
  expect(
    (screen.getByRole("menuitem", { name: /^Конвейер/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.launchBuild).toHaveBeenCalledTimes(1);
});
