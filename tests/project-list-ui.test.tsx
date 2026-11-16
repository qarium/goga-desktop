// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
  act,
} from "@testing-library/react";
import { openFirstProject } from "./helpers/open-first-project";
import { App } from "../src/renderer/App";
const primary = { id: "p", name: "Первый", path: "/synthetic/first" };
const other = { id: "q", name: "Второй", path: "/synthetic/second" };
vi.mock("../src/renderer/overview/ProjectOverview", () => ({
  ProjectOverview: ({ onCloseState }: any) => (
    <div>
      <button onClick={() => onCloseState(["notes.md"], false)}>
        Изменить тестовый файл
      </button>
      <button onClick={() => onCloseState([], true)}>
        Запись тестового файла
      </button>
      <button onClick={() => onCloseState([], false)}>
        Закончить тестовую запись
      </button>
    </div>
  ),
}));
let api: any;
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [primary, other]),
    chooseProject: vi.fn(async () => primary),
    removeProject: vi.fn(async () => [other]),
    runs: vi.fn(async () => []),
    onRuns: vi.fn(() => () => {}),
    onFocusRun: vi.fn(() => () => {}),
    onViewError: vi.fn(() => () => {}),
    selectRun: vi.fn(async () => {}),
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    reportOverviewCloseState: vi.fn(async () => {}),
  };
  window.goga = api;
});
afterEach(cleanup);
async function openMenu(name = primary.name) {
  const button = await screen.findByRole("button", { name });
  fireEvent.contextMenu(button, { clientX: 100, clientY: 220 });
  return screen.findByRole("menu", { name: "Действия с проектом" });
}
async function openConfirmation(name = primary.name) {
  const menu = await openMenu(name);
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Убрать из списка…" }),
  );
  return screen.findByRole("dialog", { name: "Убрать проект из списка?" });
}
it("uses the application context menu and confirmation without deleting files", async () => {
  render(<App />);
  await openFirstProject();
  const dialog = await openConfirmation();
  expect(dialog.textContent).toContain(primary.path);
  expect(dialog.textContent).toContain(
    "Файлы, настройки, копии топиков и история запусков останутся",
  );
  expect(api.removeProject).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const confirmed = await openConfirmation();
  fireEvent.click(
    within(confirmed).getByRole("button", { name: "Убрать из списка" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: primary.name })).toBeNull(),
  );
  expect(api.removeProject).toHaveBeenCalledExactlyOnceWith({
    id: primary.id,
    path: primary.path,
  });
  expect(await screen.findByRole("heading", { name: other.name })).toBeTruthy();
});
it("supports keyboard invocation, Escape focus return and clicking outside", async () => {
  render(<App />);
  const trigger = await screen.findByRole("button", { name: primary.name });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
  let menu = await screen.findByRole("menu");
  const item = within(menu).getAllByRole("menuitem").find(item => !(item as HTMLButtonElement).disabled)!;
  await waitFor(() => expect(document.activeElement).toBe(item));
  expect(menu.className).toContain("project-list-menu");
  fireEvent.keyDown(item, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  menu = await openMenu();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});
it("removes an unselected project without switching the current project", async () => {
  api.removeProject.mockResolvedValue([primary]);
  render(<App />);
  await openFirstProject();
  const dialog = await openConfirmation(other.name);
  expect(screen.getByRole("heading", { name: primary.name })).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Убрать из списка" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: other.name })).toBeNull(),
  );
  expect(screen.getByRole("heading", { name: primary.name })).toBeTruthy();
});
it("keeps failures readable, guards duplicate execution, and permits retry", async () => {
  api.removeProject.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:remove-project': Error: Сначала закройте терминалы этого проекта.",
    ),
  );
  render(<App />);
  await openFirstProject();
  let dialog = await openConfirmation();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Убрать из списка" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveProperty(
    "textContent",
    "Сначала закройте терминалы этого проекта.",
  );
  expect(screen.getByRole("button", { name: primary.name })).toBeTruthy();
  let resolve!: (value: any) => void;
  api.removeProject.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const submit = within(dialog).getByRole("button", {
    name: "Убрать из списка",
  });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(api.removeProject).toHaveBeenCalledTimes(2);
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Убираем…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => resolve([other]));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("shows the empty state after the last project and allows adding it again", async () => {
  api.listProjects.mockResolvedValue([primary]);
  api.removeProject.mockResolvedValue([]);
  render(<App />);
  await openFirstProject();
  const dialog = await openConfirmation();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Убрать из списка" }),
  );
  expect(await screen.findByText("Место для вашей следующей идеи")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "Добавить проект" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Открыть существующий…" }));
  expect(
    await screen.findByRole("heading", { name: primary.name }),
  ).toBeTruthy();
});
it("warns before discarding dirty retained overview files, including an inactive project", async () => {
  render(<App />);
  await openFirstProject();
  fireEvent.click(
    await screen.findByRole("button", { name: "Изменить тестовый файл" }),
  );
  fireEvent.click(screen.getByRole("button", { name: other.name }));
  const dialog = await openConfirmation(primary.name);
  expect(dialog.textContent).toContain("Несохранённые файлы Обзора");
  expect(dialog.textContent).toContain("notes.md");
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  expect(api.removeProject).not.toHaveBeenCalled();
});
it("does not unregister a project during an overview file write", async () => {
  render(<App />);
  await openFirstProject();
  fireEvent.click(
    await screen.findByRole("button", { name: "Запись тестового файла" }),
  );
  const dialog = await openConfirmation();
  expect(dialog.textContent).toContain(
    "Дождитесь завершения файловой операции",
  );
  const submit = within(dialog).getByRole("button", {
    name: "Убрать из списка",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(submit);
  expect(api.removeProject).not.toHaveBeenCalled();
});

it.each(["blur", "resize"])(
  "dismisses the DOM menu on window %s",
  async (event) => {
    render(<App />);
    await openMenu();
    fireEvent(window, new Event(event));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  },
);
it("dismisses the DOM menu when keyboard focus moves outside", async () => {
  render(<App />);
  await openMenu();
  act(() => within(screen.getByRole("complementary")).getByRole("button", { name: "Добавить проект" }).focus());
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
const historicalRun = {
  id: "historic",
  projectId: "p",
  pipeline: "editor",
  topic: "topic",
  branch: "main",
  status: "exited",
  startedAt: "2026-11-12T10:00:00.000Z",
  output: "done",
};
it("does not navigate into an unregistered project via a retained run event", async () => {
  api.runs.mockResolvedValue([historicalRun]);
  render(<App />);
  await openFirstProject();
  const dialog = await openConfirmation();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Убрать из списка" }),
  );
  await screen.findByRole("heading", { name: other.name });
  act(() => api.onFocusRun.mock.calls[0][0](historicalRun.id));
  expect(await screen.findByText(/Проект убран из списка/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: other.name })).toBeTruthy();
});
it("does not acknowledge an orphan notification as a viewed run", async () => {
  api.runs.mockResolvedValue([historicalRun]);
  api.onOpenNotification = vi.fn(() => () => {});
  api.prepareNotificationOpen = vi.fn(async () => ({
    ticket: "saved-ticket",
    run: historicalRun,
  }));
  api.completeNotificationOpen = vi.fn(async () => {});
  render(<App />);
  await openFirstProject();
  const dialog = await openConfirmation();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Убрать из списка" }),
  );
  await screen.findByRole("heading", { name: other.name });
  await act(async () => {
    api.onOpenNotification.mock.calls[0][0]("notification");
  });
  expect(await screen.findByText(/Проект убран из списка/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: other.name })).toBeTruthy();
  expect(api.completeNotificationOpen).not.toHaveBeenCalled();
});
