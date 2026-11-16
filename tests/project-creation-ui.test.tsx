// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import { ProjectCreationDialog } from "../src/renderer/ProjectCreation";
import { App } from "../src/renderer/App";
import {
  readWorkspaceSelection,
  writeWorkspaceSelection,
} from "../src/renderer/topic-display-cache";
import type { ProjectCreationProgress } from "../src/shared/project-creation";
vi.mock("../src/renderer/overview/ProjectOverview", () => ({
  ProjectOverview: ({ project }: any) => <div>Обзор {project?.name}</div>,
}));
let api: any, progress: (value: ProjectCreationProgress) => void;
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  Element.prototype.scrollIntoView = vi.fn();
  api = {
    createProject: vi.fn(async () => ({
      status: "success",
      project: { id: "new", name: "fresh", path: "/synthetic/fresh" },
    })),
    cancelProjectCreation: vi.fn(async () => true),
    chooseProjectLocation: vi.fn(async () => "/synthetic"),
    onProjectCreation: vi.fn((cb: any) => {
      progress = cb;
      return () => {};
    }),
    listProjects: vi.fn(async () => []),
    chooseProject: vi.fn(async () => null),
    runs: vi.fn(async () => []),
    onRuns: vi.fn(() => () => {}),
    onFocusRun: vi.fn(() => () => {}),
    onViewError: vi.fn(() => () => {}),
    selectRun: vi.fn(async () => {}),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    reportOverviewCloseState: vi.fn(async () => {}),
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
const savedOwner = {
  projectId: "new",
  year: "2026",
  topic: "old-topic",
  branch: "old-topic",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "c".repeat(64),
  projectPath: "/synthetic/fresh",
  gitCommonDir: "/synthetic/fresh/.git",
  path: "/synthetic/copy",
  storageKind: "clone" as const,
  ownership: "managed" as const,
  state: "ready" as const,
};
it("restores a saved context delivered after opening an existing project during initial loading", async () => {
  const project = { id: "new", name: "fresh", path: "/synthetic/fresh" };
  writeWorkspaceSelection(project, savedOwner);
  let finish!: (value: any) => void;
  api.listProjects.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  api.chooseProject.mockResolvedValueOnce(project);
  api.resolveTopicContext = vi.fn(async () => savedOwner);
  render(<App />);
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Добавить проект" }));
  fireEvent.click(await screen.findByRole("menuitem", {name:"Открыть существующий…"}));
  await screen.findByRole("heading", { name: "fresh" });
  await act(async () => finish([project]));
  await waitFor(() => expect(api.resolveTopicContext).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("heading", { name: "fresh" })).toBeTruthy();
});
it("starts a newly created project without resurrecting a cached topic at the same path", async () => {
  const project = { id: "new", name: "fresh", path: "/synthetic/fresh" };
  writeWorkspaceSelection(project, savedOwner);
  let finish!: (value: any) => void;
  api.listProjects.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  api.resolveTopicContext = vi.fn(async () => savedOwner);
  render(<App />);
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", {name:"Добавить проект"}));
  fireEvent.click(await screen.findByRole("menuitem",{name:"Создать новый…"}));
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  await screen.findByRole("heading", { name: "fresh" });
  await act(async () => finish([]));
  await waitFor(() => expect(readWorkspaceSelection(project)).toBeNull());
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
});
it("opens the registered project and displays a dismissible cleanup warning", async () => {
  api.createProject.mockResolvedValueOnce({
    status: "success",
    project: { id: "new", name: "fresh", path: "/synthetic/fresh" },
    warning: "Проект создан. Временная папка сохранена.",
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Место для вашей следующей идеи" });
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", {name:"Добавить проект"}));
  fireEvent.click(await screen.findByRole("menuitem",{name:"Создать новый…"}));
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  expect(await screen.findByRole("heading", { name: "fresh" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(
    "Временная папка сохранена",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть сообщение о создании" }),
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "fresh" })).toBeTruthy();
});
it("does not lose or deselect a created project when the initial project list arrives late", async () => {
  let finish!: (value: any) => void;
  api.listProjects.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", {name:"Добавить проект"}));
  fireEvent.click(await screen.findByRole("menuitem",{name:"Создать новый…"}));
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  expect(await screen.findByRole("heading", { name: "fresh" })).toBeTruthy();
  await act(async () =>
    finish([{ id: "old", name: "Earlier project", path: "/synthetic/old" }]),
  );
  expect(screen.getByRole("heading", { name: "fresh" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Earlier project" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "fresh" })).toBeTruthy();
});
it("associates an occupied destination with the name field and offers opening it", async () => {
  const callbacks = form();
  api.createProject.mockResolvedValueOnce({
    status: "error",
    message: "Это имя уже занято.",
    field: "name",
  });
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  expect(await screen.findByText("Это имя уже занято.")).toBeTruthy();
  expect(
    screen
      .getByRole("textbox", { name: "Имя папки проекта" })
      .getAttribute("aria-invalid"),
  ).toBe("true");
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть существующий проект…" }),
  );
  expect(callbacks.onOpenExisting).toHaveBeenCalledTimes(1);
});
it("can recover the completed result after transport failure during registration", async () => {
  let reject!: (error: Error) => void;
  api.createProject.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const callbacks = form();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  const id = api.createProject.mock.calls[0][0].id;
  act(() => progress({ id, stage: "registering", canCancel: false }));
  await act(async () => reject(Error("response lost")));
  const done = {
    status: "success",
    project: { id: "new", name: "fresh", path: "/synthetic/fresh" },
  };
  api.cancelProjectCreation.mockResolvedValueOnce(done);
  fireEvent.click(screen.getByRole("button", { name: "Проверить результат" }));
  await waitFor(() =>
    expect(callbacks.onSuccess).toHaveBeenCalledWith(done.project),
  );
  expect(api.createProject).toHaveBeenCalledTimes(1);
});
const change = (name: string, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
function form() {
  const callbacks = {
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    onOpenExisting: vi.fn(),
  };
  render(<ProjectCreationDialog {...callbacks} />);
  return callbacks;
}
async function fill() {
  await screen.findByRole("textbox", { name: "Имя папки проекта" });
  change("Имя папки проекта", "fresh");
  fireEvent.click(
    screen.getByRole("button", { name: "Выбрать расположение проекта" }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Расположение",
        }) as HTMLInputElement
      ).value,
    ).toBe("/synthetic"),
  );
}
it("starts with Git checked and retains separate drafts across modes", async () => {
  form();
  expect(
    (
      screen.getByRole("checkbox", {
        name: /Инициализировать Git/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  await fill();
  fireEvent.click(screen.getByRole("tab", { name: /Из Git-репозитория/ }));
  change("Адрес репозитория", "git@example.com:team/imported.git");
  expect(
    (
      screen.getByRole("textbox", {
        name: "Имя папки проекта",
      }) as HTMLInputElement
    ).value,
  ).toBe("imported");
  change("Имя папки проекта", "manual");
  change("Адрес репозитория", "https://example.com/another.git");
  expect(
    (
      screen.getByRole("textbox", {
        name: "Имя папки проекта",
      }) as HTMLInputElement
    ).value,
  ).toBe("manual");
  fireEvent.click(screen.getByRole("tab", { name: /С нуля/ }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Имя папки проекта",
      }) as HTMLInputElement
    ).value,
  ).toBe("fresh");
});
it("validates locally before invoking host and supports no-Git creation", async () => {
  const callbacks = form();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  expect(api.createProject).not.toHaveBeenCalled();
  expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  await fill();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Инициализировать Git/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  await waitFor(() =>
    expect(callbacks.onSuccess).toHaveBeenCalledWith({
      id: "new",
      name: "fresh",
      path: "/synthetic/fresh",
    }),
  );
  expect(api.createProject).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "empty",
      git: false,
      name: "fresh",
      parent: "/synthetic",
    }),
  );
});
it("retains all input after errors and retries with a fresh attempt id", async () => {
  const callbacks = form();
  api.createProject.mockResolvedValueOnce({
    status: "error",
    message: "Папка уже существует.",
  });
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  expect(await screen.findByText("Папка уже существует.")).toBeTruthy();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Имя папки проекта",
      }) as HTMLInputElement
    ).value,
  ).toBe("fresh");
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledTimes(1));
  expect(api.createProject.mock.calls[0][0].id).not.toBe(
    api.createProject.mock.calls[1][0].id,
  );
});
it("renders host stages, ignores other attempts, and waits for actual cancellation", async () => {
  let resolve!: (value: any) => void;
  const settled = new Promise((r) => (resolve = r));
  api.createProject.mockImplementation(() => settled);
  api.cancelProjectCreation.mockImplementation(() => settled);
  const callbacks = form();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  const id = api.createProject.mock.calls[0][0].id;
  act(() => progress({ id: "other", stage: "cloning", canCancel: true }));
  expect(screen.queryByText("Получаем файлы репозитория…")).toBeNull();
  act(() => progress({ id, stage: "git", canCancel: true }));
  expect(screen.getByRole("status").textContent).toMatch(/Git/);
  fireEvent.click(screen.getByRole("button", { name: "Отменить создание" }));
  expect(api.cancelProjectCreation).toHaveBeenCalledWith(id);
  expect(
    screen.queryByRole("textbox", { name: "Имя папки проекта" }),
  ).toBeNull();
  expect(callbacks.onClose).not.toHaveBeenCalled();
  await act(async () => resolve({ status: "cancelled" }));
  expect(screen.getByRole("status").textContent).toMatch(/отменено/);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Имя папки проекта",
      }) as HTMLInputElement
    ).value,
  ).toBe("fresh");
  expect(callbacks.onSuccess).not.toHaveBeenCalled();
  act(() => progress({ id, stage: "registering", canCancel: false }));
  expect(screen.queryByLabelText("Ход создания проекта")).toBeNull();
});
it("recovers from a lost creation response by cancelling and reading the settled result", async () => {
  api.createProject.mockRejectedValueOnce(Error("IPC connection interrupted"));
  api.cancelProjectCreation.mockResolvedValueOnce({ status: "cancelled" });
  const callbacks = form();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  await screen.findByText(/Результат создания не подтверждён/);
  fireEvent.click(screen.getByRole("button", { name: "Отменить создание" }));
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Имя папки проекта" }),
    ).toBeTruthy(),
  );
  expect(callbacks.onSuccess).not.toHaveBeenCalled();
  expect(api.createProject).toHaveBeenCalledTimes(1);
});
it("disables cancellation during publication and exposes retained files after failure", async () => {
  let resolve!: (v: any) => void;
  api.createProject.mockImplementation(() => new Promise((r) => (resolve = r)));
  form();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  const id = api.createProject.mock.calls[0][0].id;
  act(() => progress({ id, stage: "registering", canCancel: false }));
  expect(
    (
      screen.getByRole("button", {
        name: "Отменить создание",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () =>
    resolve({
      status: "error",
      message: "Не добавлен в список.",
      retainedPath: "/synthetic/fresh",
    }),
  );
  expect(screen.getByText("Сохранённая папка:")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть существующий проект…" }),
  );
});
it("keeps existing opening available in the app menu and opens a created project in Overview", async () => {
  render(<App />);
  await screen.findByRole("heading", { name: "Место для вашей следующей идеи" });
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Добавить проект" }));
  const menu = await screen.findByRole("menu", { name: "Добавить проект" });
  expect(
    within(menu).getByRole("menuitem", { name: "Открыть существующий…" }),
  ).toBeTruthy();
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Создать новый…" }),
  );
  await screen.findByRole("dialog", { name: "Новый проект" });
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Создать проект" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByRole("button", { name: "fresh" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Обзор" }).getAttribute("aria-pressed"),
  ).toBe("true");
});
