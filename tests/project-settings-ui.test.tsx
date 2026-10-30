import { openCatalog, selectCatalog } from "./helpers/select-catalog";
import "./helpers/overview-browser-fixture";
import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  openCurrentLaunch,
  executionButton,
} from "./helpers/prototype-context-fixture";
import { retainedButton } from "./loading-test-helpers";
// @vitest-environment jsdom
import React from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
const project = { id: "p", name: "Project Alpha", path: "/tmp/alpha" };
const other = { id: "q", name: "Project Beta", path: "/tmp/beta" };
const settings = {
  value: {
    executable: "goga",
    profile: "fast",
    env: [
      { key: "TOKEN", value: "private-value", secret: true, runtime: false },
    ],
  },
  version: "v1",
  profiles: [{ name: "fast", source: "project" }],
};
const discovery = {
  projectSettings: { version: "v1", profile: "fast", executable: "goga" },
  pipelines: [
    { id: "build", name: "Build", description: "", project: true },
    { id: "review", name: "Review", description: "", project: true },
  ],
  topics: [
    {
      topic: "topic",
      branch: "main",
      current: true,
      remote: false,
      todo: "",
      statuses: [],
    },
  ],
  branches: ["main"],
  currentBranch: "main",
  workflows: ["quality"],
  profiles: settings.profiles,
};
let api: any;
let focusRun: (id: string) => void;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [project, other]),
    runs: vi.fn(async () => []),
    onRuns: vi.fn(() => () => {}),
    onFocusRun: vi.fn((cb) => {
      focusRun = cb;
      return () => {};
    }),
    onViewError: vi.fn(() => () => {}),
    selectRun: vi.fn(async () => {}),
    closeRun: vi.fn(async () => true),
    chooseProject: vi.fn(async () => null),
    readProjectSettings: vi.fn(async () => structuredClone(settings)),
    saveProjectSettings: vi.fn(async (_id, value) => ({
      ...settings,
      value,
      version: "v2",
    })),
    discover: vi.fn(async () => structuredClone(discovery)),
    preview: vi.fn(async () => ({
      token: "preview",
      stages: [
        { id: "a", title: "Stage A" },
        { id: "b", title: "Stage B" },
      ],
      workflow: null,
      profile: "fast",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    readTopicTask: vi.fn(async () => ({
      text: "original",
      exists: true,
      version: "task1",
      path: "todo.md",
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    launch: vi.fn(),
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  installPrototypeContextFixture(api, [
    { ...project, topic: "topic", branch: "main" },
    { ...other, topic: "topic", branch: "main" },
  ]);
  window.goga = api;
});
afterEach(cleanup);
async function openSettings() {
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  return screen.findByLabelText("Исполняемый файл");
}
it("opens during an active run and returns to the same native run without reload", async () => {
  api.runs.mockResolvedValue([
    {
      id: "run",
      projectId: "p",
      pipeline: "build",
      topic: "topic",
      branch: "main",
      status: "running",
      url: "http://localhost:1234",
      startedAt: "now",
      workflow: null,
      profile: null,
    },
  ]);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByRole("heading", { name: "Проект" });
  act(() => focusRun("run"));
  await screen.findByRole("tab", { name: "build · topic · main" });
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith("run"));
  await openSettings();
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(api.selectRun).toHaveBeenLastCalledWith(null);
  act(() => focusRun("run"));
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith("run"));
  expect(api.launch).not.toHaveBeenCalled();
});
it("masks persisted secret values and keeps independent secret/runtime choices", async () => {
  render(<App />);
  await openSettings();
  expect((screen.getByLabelText("Значение 1") as HTMLInputElement).type).toBe(
    "password",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "＋ Добавить переменную" }),
  );
  expect(
    (screen.getByLabelText("Скрывать значение 2") as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (screen.getByLabelText("Передавать в runtime 2") as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Передавать в runtime 1") as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.click(screen.getByLabelText("Передавать в runtime 2"));
  expect(
    (screen.getByLabelText("Передавать в runtime 2") as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("Имя 2"), {
    target: { value: "PLAIN" },
  });
  fireEvent.change(screen.getByLabelText("Значение 2"), {
    target: { value: "visible" },
  });
  fireEvent.click(screen.getByLabelText("Передавать в runtime 2"));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectSettings).toHaveBeenCalledWith(
      "p",
      {
        ...settings.value,
        env: [
          ...settings.value.env,
          { key: "PLAIN", value: "visible", secret: false, runtime: true },
        ],
      },
      "v1",
    ),
  );
});
it("guards every exit, keeps Cancel focused, and preserves edits on save failure", async () => {
  render(<App />);
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "goga-next" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Project Beta/ }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Отмена" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("goga-next");
  api.saveProjectSettings.mockRejectedValueOnce(
    Error("Conflict: reload required"),
  );
  await openCurrentLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить и перейти" }));
  expect(await screen.findByText("Conflict: reload required")).toBeTruthy();
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("goga-next");
});
it("retries loading and shows a missing saved profile without replacing it", async () => {
  api.readProjectSettings
    .mockRejectedValueOnce(Error("Read failed"))
    .mockResolvedValue({
      ...settings,
      value: { ...settings.value, profile: "missing" },
    });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Повторить загрузку" }),
  );
  expect(
    (
      (await screen.findByLabelText(
        "Профиль по умолчанию",
      )) as HTMLSelectElement
    ).value,
  ).toBe("missing");
  expect(
    screen.getByRole("option", { name: /missing.*не найден/ }),
  ).toBeTruthy();
});
it("preserves launch composition and task draft, then refreshes discovery and preview after save", async () => {
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /Stage B/ });
  selectCatalog(screen.getByLabelText("Рабочий процесс"), "file:quality");
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ workflow: "file:quality" }),
    ),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /Stage B/ }));
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "keep my draft" },
  });
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "goga-next" },
  });
  api.discover.mockResolvedValue({
    ...discovery,
    projectSettings: { ...discovery.projectSettings, version: "v2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  await openPrototypeLaunch();
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workflow: "file:quality",
        skips: ["b"],
        profile: "",
      }),
    ),
  );
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("keep my draft");
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByLabelText("Рабочий процесс") as HTMLButtonElement).value,
  ).toBe("file:quality");
  openCatalog(screen.getByRole("combobox", { name: "Профиль" }));
  expect(
    screen.getByRole("option", { name: /По умолчанию проекта.*fast/ }),
  ).toBeTruthy();
  selectCatalog(screen.getByLabelText("Профиль"), "__auto__");
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: "", profileMode: "auto" }),
    ),
  );
});
it("guards notification focus and disables navigation and edits while save is pending", async () => {
  api.runs.mockResolvedValue([
    {
      id: "run",
      projectId: "q",
      pipeline: "build",
      topic: "topic",
      branch: "main",
      status: "running",
      url: "http://localhost:4321",
      dashboardOpened: true,
      startedAt: "now",
      workflow: null,
      profile: null,
    },
  ]);
  let resolve!: (value: any) => void;
  api.saveProjectSettings.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<App />);
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "next" },
  });
  act(() => focusRun("run"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).closest(
      "fieldset",
    )?.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Project Beta/ }));
  act(() => focusRun("run"));
  expect(screen.getByRole("heading", { name: "Project Alpha" })).toBeTruthy();
  await act(async () =>
    resolve({
      ...settings,
      value: { ...settings.value, executable: "next" },
      version: "v2",
    }),
  );
});
it("finishes save-and-navigate without leaving the shell disabled", async () => {
  render(<App />);
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "next" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Project Beta/ }));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить и перейти" }));
  await screen.findByRole("heading", { name: "Project Beta" });
  expect(
    (screen.getByRole("button", { name: /Project Alpha/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /Project Alpha/ }));
  await screen.findByRole("heading", { name: "Project Alpha" });
});
it("ignores a late read from another project and keeps general settings separate", async () => {
  let first!: (value: any) => void;
  api.readProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        first = r;
      }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  api.readProjectSettings.mockResolvedValueOnce({
    ...settings,
    value: { ...settings.value, executable: "beta-goga" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Project Beta/ }));
  await openSettings();
  await act(async () => first(settings));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("beta-goga");
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  expect(
    await screen.findByRole("heading", { name: "Общие настройки" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Исполняемый файл")).toBeNull();
});
it("blocks stale launch and composition edits until refreshed project settings arrive", async () => {
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /Stage B/ });
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "draft survives" },
  });
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "next" },
  });
  let resolve!: (value: any) => void;
  api.discover.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  await openPrototypeLaunch();
  expect(
    (retainedButton("Сохранить и запустить") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Рабочий процесс") as HTMLButtonElement).closest(
      "fieldset",
    )?.disabled,
  ).toBe(true);
  await act(async () =>
    resolve({
      ...discovery,
      projectSettings: { ...discovery.projectSettings, version: "v2" },
    }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Рабочий процесс") as HTMLButtonElement).closest(
        "fieldset",
      )?.disabled,
    ).toBe(false),
  );
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("draft survives");
  expect(api.launch).not.toHaveBeenCalled();
});
it.each([
  "Топики",
  "Настройки",
  "Добавить проект",
  "Запустить конвейер через меню",
  /Project Beta/,
])("asks before leaving dirty settings via %s", async (name) => {
  render(<App />);
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "unsaved" },
  });
  if (name === "Запустить конвейер через меню") await openCurrentLaunch();
  else fireEvent.click(screen.getByRole("button", { name }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
  expect(api.chooseProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("unsaved");
});
it("waits for explicit discard before showing a notification-selected native run", async () => {
  api.runs.mockResolvedValue([
    {
      id: "run",
      projectId: "q",
      pipeline: "build",
      topic: "topic",
      branch: "main",
      status: "running",
      url: "http://localhost:4321",
      dashboardOpened: true,
      startedAt: "now",
      workflow: null,
      profile: null,
    },
  ]);
  render(<App />);
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "unsaved" },
  });
  api.selectRun.mockClear();
  act(() => focusRun("run"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(api.selectRun).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Не сохранять и перейти" }),
  );
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith("run"));
  expect(screen.getByRole("heading", { name: "Project Beta" })).toBeTruthy();
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
});
it("offers a keyboard-accessible runtime toggle independently of Secret", async () => {
  const user = userEvent.setup();
  render(<App />);
  await openSettings();
  const runtime = screen.getByRole("switch", {
    name: "Передавать в runtime 1",
  });
  expect(runtime.getAttribute("aria-checked")).toBe("false");
  runtime.focus();
  await user.keyboard(" ");
  expect(runtime.getAttribute("aria-checked")).toBe("true");
  expect(
    (
      screen.getByRole("switch", {
        name: "Скрывать значение 1",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect((screen.getByLabelText("Значение 1") as HTMLInputElement).type).toBe(
    "password",
  );
});
it("keeps input and blocks launch when refreshed discovery fails, then retries without rereading task", async () => {
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /Stage B/ });
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "important draft" },
  });
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "next" },
  });
  api.discover.mockRejectedValueOnce(Error("Catalog unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByText(
    "Сохранено. Изменения применятся к следующим запускам.",
  );
  await openPrototypeLaunch();
  expect(await screen.findByText("Catalog unavailable")).toBeTruthy();
  expect(
    (retainedButton("Сохранить и запустить") as HTMLButtonElement).disabled,
  ).toBe(true);
  api.discover.mockResolvedValue({
    ...discovery,
    projectSettings: { ...discovery.projectSettings, version: "v2" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить обновление каталога" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Catalog unavailable")).toBeNull(),
  );
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("important draft");
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
});

const launchedRun = {
  id: "late-run",
  projectId: "p",
  pipeline: "build",
  topic: "topic",
  branch: "main",
  status: "running",
  url: "http://localhost:4321",
  dashboardOpened: true,
  startedAt: "now",
  workflow: null,
  profile: null,
};
async function launchThenEditSettings() {
  let resolve!: (value: any) => void;
  api.launch.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /Stage B/ });
  fireEvent.click(executionButton());
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "keep these settings" },
  });
  return resolve;
}
it("guards a late launch completion before leaving dirty project settings", async () => {
  const resolve = await launchThenEditSettings();
  api.selectRun.mockClear();
  await act(async () => resolve(launchedRun));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("keep these settings");
  expect(api.selectRun).not.toHaveBeenCalledWith("late-run");
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("keep these settings");
  act(() => focusRun("late-run"));
  fireEvent.click(
    screen.getByRole("button", { name: "Не сохранять и перейти" }),
  );
  expect(
    await screen.findByRole("tab", { name: "build · topic · main" }),
  ).toBeTruthy();
});
it("selects a late launched run only after explicit permission to discard settings", async () => {
  const resolve = await launchThenEditSettings();
  await act(async () => resolve(launchedRun));
  fireEvent.click(
    await screen.findByRole("button", { name: "Не сохранять и перейти" }),
  );
  await waitFor(() =>
    expect(api.selectRun).toHaveBeenLastCalledWith("late-run"),
  );
  expect(screen.queryByLabelText("Исполняемый файл")).toBeNull();
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
});
it("registers late launch without interrupting pending settings save or leaving stale busy state", async () => {
  const resolveLaunch = await launchThenEditSettings();
  let resolveSave!: (value: any) => void;
  api.saveProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolveSave = r;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await act(async () => resolveLaunch(launchedRun));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("keep these settings");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.selectRun).not.toHaveBeenCalledWith("late-run");
  await act(async () =>
    resolveSave({
      ...settings,
      value: { ...settings.value, executable: "keep these settings" },
      version: "v2",
    }),
  );
  expect(
    (screen.getByRole("button", { name: /Project Beta/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  act(() => focusRun("late-run"));
  await screen.findByRole("tab", { name: "build · topic · main" });
  await waitFor(() =>
    expect(api.selectRun).toHaveBeenLastCalledWith("late-run"),
  );
  fireEvent.click(screen.getByRole("button", { name: /Project Beta/ }));
  expect(
    await screen.findByRole("heading", { name: "Project Beta" }),
  ).toBeTruthy();
});

it("guards a late native project choice without discarding settings edits", async () => {
  let resolve!: (value: any) => void;
  api.chooseProject.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Добавить проект" }),
  );
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "unsaved-goga" },
  });
  const added = { id: "new", name: "New project", path: "/tmp/new" };
  await act(async () => resolve(added));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("unsaved-goga");
  expect(await screen.findByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.getByRole("button", { name: /New project/ })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Project Alpha" })).toBeTruthy();
});
it("registers a late native project choice without interrupting a pending save", async () => {
  let resolveChoice!: (value: any) => void;
  let resolveSave!: (value: any) => void;
  api.chooseProject.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolveChoice = r;
      }),
  );
  api.saveProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolveSave = r;
      }),
  );
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Добавить проект" }),
  );
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "saved-goga" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await act(async () =>
    resolveChoice({ id: "new", name: "New project", path: "/tmp/new" }),
  );
  expect(screen.getByRole("heading", { name: "Project Alpha" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () =>
    resolveSave({
      ...settings,
      value: { ...settings.value, executable: "saved-goga" },
      version: "v2",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /New project/ }));
  expect(
    await screen.findByRole("heading", { name: "New project" }),
  ).toBeTruthy();
});
it("recovers an initial failed catalog after fixing the executable without inventing an old selection", async () => {
  api.discover.mockRejectedValueOnce(Error("Executable not found"));
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByText("Executable not found");
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "fixed-goga" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByText(
    "Сохранено. Изменения применятся к следующим запускам.",
  );
  await openPrototypeLaunch();
  expect(
    ((await screen.findByLabelText("Конвейер")) as HTMLButtonElement).value,
  ).toBe("build");
  expect(await screen.findByRole("checkbox", { name: /Stage B/ })).toBeTruthy();
  expect(screen.queryByText("Executable not found")).toBeNull();
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ pipeline: "build" }),
    ),
  );
});
it("publishes replacement pipelines while retaining a missing selection and draft until explicit reselection", async () => {
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /Stage B/ });
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "keep draft" },
  });
  await openSettings();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "different-goga" },
  });
  api.discover.mockResolvedValue({
    ...discovery,
    pipelines: [
      {
        id: "new-pipeline",
        name: "New pipeline",
        description: "",
        project: true,
      },
    ],
    projectSettings: { ...discovery.projectSettings, version: "v2" },
  });
  api.preview.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByText(
    "Сохранено. Изменения применятся к следующим запускам.",
  );
  await openPrototypeLaunch();
  openCatalog(await screen.findByRole("combobox", { name: "Конвейер" }));
  expect(
    await screen.findByRole("option", { name: "new-pipeline · проектный" }),
  ).toBeTruthy();
  expect((screen.getByLabelText("Конвейер") as HTMLButtonElement).value).toBe(
    "build",
  );
  expect(screen.getByRole("option", { name: /build.*не найден/ })).toBeTruthy();
  expect(
    (retainedButton("Сохранить и запустить") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(api.preview).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("keep draft");
  selectCatalog(screen.getByLabelText("Конвейер"), "new-pipeline");
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ pipeline: "new-pipeline" }),
    ),
  );
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("keep draft");
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "rejects multiline paste before native sanitation (secret=%s), preserves draft and blocks save/navigation",
  async (secret) => {
    const user = userEvent.setup();
    render(<App />);
    await openSettings();
    if (!secret) fireEvent.click(screen.getByLabelText("Скрывать значение 1"));
    const input = screen.getByLabelText("Значение 1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "unsaved-draft" } });
    input.focus();
    input.setSelectionRange(0, input.value.length);
    await user.paste("pasted-private\nsecond-line");
    expect(input.value).toBe("unsaved-draft");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toContain("pasted-private");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(api.saveProjectSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(alert.textContent);
    fireEvent.click(screen.getByLabelText("Передавать в runtime 1"));
    await openCurrentLaunch();
    fireEvent.click(
      screen.getByRole("button", { name: "Сохранить и перейти" }),
    );
    expect(api.saveProjectSettings).not.toHaveBeenCalled();
    expect(input.value).toBe("unsaved-draft");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.change(input, { target: { value: "corrected" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.saveProjectSettings).toHaveBeenCalledTimes(1),
    );
    expect(api.saveProjectSettings.mock.calls[0][1].env[0].value).toBe(
      "corrected",
    );
    expect(settings.value.env[0].value).toBe("private-value");
  },
);

it.each(["\n", "\r", "\r\n", "\0", "\ud800", "\udfff"])(
  "rejects unsafe paste fragment %j without disclosing or changing data",
  async (fragment) => {
    const user = userEvent.setup();
    render(<App />);
    await openSettings();
    const input = screen.getByLabelText("Значение 1") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(2, 4);
    await user.paste(`sensitive${fragment}payload`);
    expect(input.value).toBe("private-value");
    expect(screen.getByRole("alert").textContent).not.toContain("sensitive");
    fireEvent.submit(input.closest("form")!);
    expect(api.saveProjectSettings).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "guards native beforeinput and drop for secret=%s",
  async (secret) => {
    render(<App />);
    await openSettings();
    if (!secret) fireEvent.click(screen.getByLabelText("Скрывать значение 1"));
    const input = screen.getByLabelText("Значение 1") as HTMLInputElement;
    for (const bad of ["x\ny", "x\ry", "x\r\ny", "x\0y", "x\ud800y"]) {
      const before = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: bad,
      });
      fireEvent(input, before);
      expect(before.defaultPrevented).toBe(true);
      expect(input.value).toBe("private-value");
      expect(screen.getByRole("alert").textContent).not.toContain(bad);
      expect(
        fireEvent.drop(input, { dataTransfer: { getData: () => bad } }),
      ).toBe(false);
      expect(input.value).toBe("private-value");
    }
    const lineBreak = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertLineBreak",
      data: null,
    });
    fireEvent(input, lineBreak);
    expect(lineBreak.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(api.saveProjectSettings).not.toHaveBeenCalled();
  },
);

it.each(["paste", "drop"])(
  "preserves valid %s bytes and selection replacement without shell escaping",
  async (kind) => {
    const user = userEvent.setup();
    render(<App />);
    await openSettings();
    const input = screen.getByLabelText("Значение 1") as HTMLInputElement;
    const inserted = "\\n\t'\" 🙂 $HOME; $(echo nope) ";
    input.focus();
    input.setSelectionRange(2, 5);
    if (kind === "paste") await user.paste(inserted);
    else
      expect(
        fireEvent.drop(input, { dataTransfer: { getData: () => inserted } }),
      ).toBe(false);
    const expected = `pr${inserted}te-value`;
    expect(input.value).toBe(expected);
    expect(input.selectionStart).toBe(2 + inserted.length);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.saveProjectSettings).toHaveBeenCalledTimes(1),
    );
    expect(api.saveProjectSettings.mock.calls[0][1].env[0].value).toBe(
      expected,
    );
  },
);

it("validates runtime transport before IPC and keeps oversized draft editable", async () => {
  render(<App />);
  await openSettings();
  const input = screen.getByLabelText("Значение 1") as HTMLInputElement;
  const oversized = "x".repeat(50000);
  fireEvent.change(input, { target: { value: oversized } });
  fireEvent.click(screen.getByLabelText("Передавать в runtime 1"));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
  expect(input.value).toBe(oversized);
  expect(screen.getByRole("alert").textContent).not.toContain(oversized);
  fireEvent.change(input, { target: { value: "fixed" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(api.saveProjectSettings).toHaveBeenCalledTimes(1));
});

it("restores the prior draft if an invalid beforeinput cannot be canceled", async () => {
  render(<App />);
  await openSettings();
  const input = screen.getByLabelText("Значение 1") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "unsaved" } });
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: false,
      inputType: "insertReplacementText",
      data: "secret\nvalue",
    }),
  );
  fireEvent.input(input, { target: { value: "secretvalue" } });
  expect(input.value).toBe("unsaved");
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "!",
    }),
  );
  fireEvent.input(input, { target: { value: "unsaved!" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(api.saveProjectSettings).toHaveBeenCalledTimes(1));
  expect(api.saveProjectSettings.mock.calls[0][1].env[0].value).toBe(
    "unsaved!",
  );
});

it("keeps rejected-input errors attached to their row when earlier rows are removed", async () => {
  const user = userEvent.setup();
  render(<App />);
  await openSettings();
  fireEvent.click(
    screen.getByRole("button", { name: "＋ Добавить переменную" }),
  );
  fireEvent.change(screen.getByLabelText("Имя 2"), {
    target: { value: "OTHER" },
  });
  const input = screen.getByLabelText("Значение 2") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "keep" } });
  input.focus();
  await user.paste("secret\nvalue");
  fireEvent.click(screen.getByRole("button", { name: "Удалить переменную 1" }));
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "goga-new" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Значение 1") as HTMLInputElement).value).toBe(
    "keep",
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить переменную 1" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(api.saveProjectSettings).toHaveBeenCalledTimes(1));
});
it("reveals launch validation errors when guarded save is requested from another settings section", async () => {
  render(<App />);
  await openSettings();
  fireEvent.paste(screen.getByLabelText("Значение 1"), {
    clipboardData: { getData: () => "invalid\nvalue" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  await openCurrentLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить и перейти" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Исполняемый файл" }),
  ).toBeTruthy();
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
});
