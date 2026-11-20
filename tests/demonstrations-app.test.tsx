// @vitest-environment jsdom
import "./helpers/overview-browser-fixture";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
import { openFirstProject } from "./helpers/open-first-project";
import {
  installPrototypeContextFixture,
  selectPrototypeOwner,
} from "./helpers/prototype-context-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function fixture() {
  const shows: any[] = [],
    access = { owner: null, phase: "off", connectionId: null };
  const api: any = {
    listProjects: async () => [{ id: "p", path: "/fixture/a", name: "Alpha" }],
    runs: async () => [],
    onRuns: () => () => {},
    onViewError: () => () => {},
    onFocusRun: () => () => {},
    selectRun: async () => {},
    listSettings: async () => ({ profiles: [] }),
    readProjectSettings: async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    }),
    demoState: vi.fn(async () =>
      structuredClone({ port: 45123, shows, access }),
    ),
    demoExecute: vi.fn(async (c: any) => {
      if (c.action === "open")
        shows.push({
          scope: c.scope,
          showId: "show-" + shows.length,
          label: "Показ",
          url: null,
        });
      if (c.action === "stop")
        shows.splice(
          shows.findIndex((s) => s.showId === c.showId),
          1,
        );
    }),
    demoFrame: vi.fn(() => new Promise(() => {})),
    demoOpenBrowser: vi.fn(async () => {}),
  };
  installPrototypeContextFixture(api, [
    { id: "p", path: "/fixture/a", topic: "topic-a", branch: "topic-a" },
  ]);
  window.goga = api;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  return { api, shows };
}
it("starts only from the native launch menu; selecting a topic never borrows the primary show; background close keeps the current view", async () => {
  const { api, shows } = fixture();
  render(<App />);
  await openFirstProject();
  await act(async () => {});
  const tab = () => screen.queryByRole("tab", { name: "Демонстрация" });
  const openMenu = () =>
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  const launch = async () => {
    openMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /^Начать демонстрацию/ }),
    );
    await screen.findByRole("tab", { name: "Демонстрация" });
  };
  expect(tab()).toBeNull();
  api.demoExecute.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:demo-execute': Error: Порт уже занят",
    ),
  );
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /^Начать демонстрацию/ }),
  );
  const failure = await screen.findByRole("dialog", {
    name: "Не удалось выполнить операцию",
  });
  expect(within(failure).getByRole("alert").textContent).toBe("Порт уже занят");
  expect(tab()).toBeNull();
  expect(
    within(failure).queryByRole("button", {
      name: "Запустить в системном браузере",
    }),
  ).toBeNull();
  fireEvent.click(
    within(failure).getByRole("button", { name: "Закрыть сообщение" }),
  );
  api.demoExecute.mockClear();
  await launch();
  expect(api.demoExecute).toHaveBeenCalledWith({ action: "open", scope: "p" });
  expect(tab()?.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Обзор" }));
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /^Открыть демонстрацию/ }),
  );
  await waitFor(() =>
    expect(tab()?.getAttribute("aria-selected")).toBe("true"),
  );
  expect(api.demoExecute).toHaveBeenCalledTimes(1);
  await selectPrototypeOwner();
  await waitFor(() => expect(tab()).toBeNull());
  await launch();
  const cmd = api.demoExecute.mock.calls.at(-1)[0];
  expect(cmd.action).toBe("open");
  expect(cmd.scope).toMatchObject({
    projectId: "p",
    topic: "topic-a",
    branch: "topic-a",
  });
  expect(cmd.scope.contextId).toBeTruthy();
  expect(cmd.scope.revision).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Обзор" }));
  const close = () =>
    screen.getByRole("button", { name: "Закрыть вкладку Демонстрация" });
  fireEvent.click(close());
  let d = screen.getByRole("dialog", { name: "Завершить показ?" });
  fireEvent.click(within(d).getByRole("button", { name: "Отмена" }));
  expect(api.demoExecute).toHaveBeenCalledTimes(2);
  fireEvent.click(close());
  d = screen.getByRole("dialog", { name: "Завершить показ?" });
  fireEvent.click(within(d).getByRole("button", { name: "Завершить показ" }));
  await waitFor(() => expect(tab()).toBeNull());
  expect(api.demoExecute).toHaveBeenLastCalledWith({
    action: "stop",
    showId: "show-1",
  });
  expect(shows.map((s) => s.scope)).toEqual(["p"]);
  expect(
    screen.getByRole("button", { name: "Обзор" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

it.each([undefined, "unverified"])(
  "permits a demonstration for a registered non-Git folder during a pipeline while preserving existing recovery guard %s",
  async (recovery) => {
    const { api } = fixture();
    api.runs = async () => [
      {
        id: "live",
        kind: "pipeline",
        recovery,
        projectId: "p",
        pipeline: "test",
        topic: "",
        branch: "main",
        status: "running",
        startedAt: "now",
        output: { text: "", truncated: false },
      },
    ];
    api.readGitWorkspace = vi.fn();
    api.readGitSummary = vi.fn(async (scope: string) => ({
      scope,
      branch: null,
      changedFiles: 0,
      conflicts: 0,
      repository: "missing",
    }));
    render(<App />);
    await openFirstProject();
    await screen.findByText("Git не инициализирован");
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    const menu = screen.getByRole("menu");
    expect(
      (
        within(menu).getByRole("menuitem", {
          name: /^Конвейер/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(recovery === "unverified");
    expect(
      (
        within(menu).getByRole("menuitem", {
          name: /^Сборка/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(recovery === "unverified");
    fireEvent.click(
      await within(menu).findByRole("menuitem", {
        name: /^Начать демонстрацию/,
      }),
    );
    await screen.findByRole("tab", { name: "Демонстрация" });
    expect(api.demoExecute).toHaveBeenCalledWith({
      action: "open",
      scope: "p",
    });
  },
);

it("offers a one-time system launch only after embedded startup failure and never changes the preference", async () => {
  const { api } = fixture();
  render(<App />);
  await openFirstProject();
  api.demoExecute.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:demo-execute': Error: [GOGA_DEMO_EMBEDDED_START] Не удалось запустить встроенный Chromium: нет связи.",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /^Начать демонстрацию/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Не удалось выполнить операцию",
  });
  expect(api.demoExecute).toHaveBeenCalledTimes(1);
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Запустить в системном браузере",
    }),
  );
  await screen.findByRole("tab", { name: "Демонстрация" });
  expect(api.demoExecute.mock.calls.map(([cmd]: [unknown]) => cmd)).toEqual([
    { action: "open", scope: "p" },
    { action: "open", scope: "p", engine: "system" },
  ]);
});
