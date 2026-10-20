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
} from "@testing-library/react";
import { App } from "../src/renderer/App";
import type { Run } from "../src/shared/types";

const project = {
  id: "p",
  name: "Fixture project",
  path: "/tmp/output-ui-fixture",
};
const makeRun = (patch: Partial<Run> = {}): Run => ({
  id: "a",
  projectId: "p",
  pipeline: "build",
  topic: "topic-a",
  branch: "main",
  workflow: null,
  profile: null,
  startedAt: "2026-01-01T00:00:00Z",
  status: "starting",
  dashboardOpened: false,
  startupTimeoutMs: 600_000,
  output: { text: "actual stdout\nactual stderr", truncated: false },
  ...patch,
});
let api: any;
let publish: (runs: Run[]) => void;
let viewError: (error: { id: string; error: string }) => void;
beforeEach(() => {
  api = {
    listProjects: vi.fn(async () => [project]),
    runs: vi.fn(async () => []),
    onRuns: vi.fn((cb) => {
      publish = cb;
      return () => {};
    }),
    onFocusRun: vi.fn(() => () => {}),
    onViewError: vi.fn((cb) => {
      viewError = cb;
      return () => {};
    }),
    selectRun: vi.fn(async () => {}),
    stopRun: vi.fn(async () => {}),
    closeRun: vi.fn(async () => false),
    listSettings: vi.fn(async () => ({ profiles: [] })),
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function open(runs: Run[] = [makeRun()]) {
  api.runs.mockResolvedValue(runs);
  render(<App />);
  fireEvent.click(await screen.findByRole("tab", { name: /topic-a/ }));
}
const ready = (patch: Partial<Run> = {}) =>
  makeRun({
    status: "running",
    dashboardOpened: true,
    url: "http://127.0.0.1:1234/run",
    ...patch,
  });
const statusButton = () =>
  screen.getByRole("button", { name: "Работает — показ журнала вывода" });

it("shows real plain text output and live activity before browser opening, without timer or fake progress", async () => {
  const timer = vi.spyOn(globalThis, "setInterval");
  const text =
    "<img src=x onerror=alert(1)>\n\u001b[31mraw text\nactual stderr";
  await open([makeRun({ update: true, output: { text, truncated: false } })]);
  expect(screen.getByRole("heading", { name: "Готовим запуск" })).toBeTruthy();
  expect(screen.getByText("Вывод")).toBeTruthy();
  expect(screen.getByLabelText("Строки вывода запуска").textContent).toBe(text);
  expect(screen.getByLabelText("Строки вывода запуска").tagName).toBe("PRE");
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText(/Запуск с обновлением образа/)).toBeTruthy();
  expect(
    screen.getByText("До открытия Dashboard — не более 10 мин"),
  ).toBeTruthy();
  expect(screen.getByText("Вывод обновляется")).toBeTruthy();
  expect(document.querySelector(".run-output-spinner")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/\d\d:\d\d|\d+%/)).toBeNull();
  // Testing Library uses its own 50 ms polling interval while finding a tab.
  expect(
    timer.mock.calls.filter(
      ([callback]) =>
        typeof callback !== "function" ||
        callback.name !== "checkRealTimersCallback",
    ),
  ).toHaveLength(0);
  expect(api.selectRun).toHaveBeenLastCalledWith(null);
});

it("waits for the actual browser-open acknowledgement, then defaults to Dashboard while capturing output", async () => {
  await open();
  act(() => publish([makeRun({ url: "http://127.0.0.1:1234/run" })]));
  expect(screen.getByText("Вывод")).toBeTruthy();
  expect(api.selectRun).not.toHaveBeenCalledWith("a");
  act(() => publish([ready()]));
  expect(screen.getByLabelText("Встроенная панель конвейера")).toBeTruthy();
  expect(screen.queryByText("Вывод")).toBeNull();
  expect(api.selectRun).toHaveBeenLastCalledWith("a");
  const calls = api.selectRun.mock.calls.length;
  act(() =>
    publish([ready({ output: { text: "later live line", truncated: false } })]),
  );
  expect(api.selectRun).toHaveBeenCalledTimes(calls);
  fireEvent.click(statusButton());
  expect(screen.getByLabelText("Строки вывода запуска").textContent).toBe(
    "later live line",
  );
});

it("toggles only retained view selection with clicks, Enter and Space, with no switch or back control", async () => {
  await open([ready()]);
  const user = userEvent.setup();
  const button = statusButton();
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.querySelector("svg")).toBeTruthy();
  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(api.selectRun).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole("button", { name: /Назад|Вернуться/ })).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  button.focus();
  await user.keyboard("{Enter}");
  expect(api.selectRun).toHaveBeenLastCalledWith("a");
  await user.keyboard(" ");
  expect(api.selectRun).toHaveBeenLastCalledWith(null);
  fireEvent.click(button);
  await user.dblClick(button);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(api.selectRun).toHaveBeenLastCalledWith("a");
  expect(api.stopRun).not.toHaveBeenCalled();
});

it("keeps each run's output and log preference isolated and hides the native view in settings", async () => {
  const other = ready({
    id: "b",
    topic: "topic-b",
    output: { text: "run B only", truncated: false },
  });
  await open([ready(), other]);
  fireEvent.click(statusButton());
  fireEvent.click(screen.getByRole("tab", { name: /topic-b/ }));
  expect(statusButton().getAttribute("aria-pressed")).toBe("false");
  expect(api.selectRun).toHaveBeenLastCalledWith("b");
  fireEvent.click(statusButton());
  expect(screen.getByLabelText("Строки вывода запуска").textContent).toBe(
    "run B only",
  );
  fireEvent.click(screen.getByRole("tab", { name: /topic-a/ }));
  expect(statusButton().getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Строки вывода запуска").textContent).toBe(
    "actual stdout\nactual stderr",
  );
  fireEvent.click(statusButton());
  fireEvent.click(screen.getByRole("button", { name: "⚙ Настройки" }));
  expect(api.selectRun).toHaveBeenLastCalledWith(null);
});

it.each([
  ["failed", "Подготовка завершилась с ошибкой"],
  ["failed", "Время запуска истекло. Dashboard не открылся."],
  ["exited", undefined],
  ["stopped", undefined],
] as const)(
  "preserves output after %s (%s), hiding even an old Dashboard",
  async (status, error) => {
    await open([ready()]);
    act(() => publish([ready({ status, error })]));
    expect(screen.getByText("Вывод")).toBeTruthy();
    expect(
      screen.getByLabelText("Строки вывода запуска").textContent,
    ).toContain("actual stderr");
    expect(screen.getByText("Вывод сохранён")).toBeTruthy();
    if (error) expect(screen.getByText(error)).toBeTruthy();
    expect(api.selectRun).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("button", { name: "Остановить" })).toBeNull();
  },
);

it("keeps output on native view error and uses the existing stop IPC without local process controls", async () => {
  await open([ready()]);
  act(() => viewError({ id: "a", error: "Browser load failed" }));
  expect(screen.getByText("Browser load failed")).toBeTruthy();
  expect(screen.getByText("Вывод")).toBeTruthy();
  expect(api.selectRun).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
  expect(api.stopRun).toHaveBeenCalledExactlyOnceWith("a");
});

it("shows honest truncation and secret limitations, empty activity, and the configured budget", async () => {
  await open([
    makeRun({
      startupTimeoutMs: 120_000,
      output: { text: "", truncated: true },
    }),
  ]);
  expect(
    screen.getByText("До открытия Dashboard — не более 2 мин"),
  ).toBeTruthy();
  expect(screen.getByText(/Часть вывода удалена или скрыта/)).toBeTruthy();
  expect(screen.getByText(/Неизвестные секреты могут остаться/)).toBeTruthy();
  expect(screen.getByText(/Новых сообщений пока нет/)).toBeTruthy();
});

it("does not steal scroll or keyboard focus when more output arrives; follows only at the bottom", async () => {
  await open();
  const output = screen.getByLabelText("Строки вывода запуска");
  const scroll = output.parentElement!;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  scroll.scrollTop = 100;
  fireEvent.scroll(scroll);
  const stop = screen.getByRole("button", { name: "Остановить" });
  stop.focus();
  act(() =>
    publish([makeRun({ output: { text: "second line", truncated: false } })]),
  );
  expect(scroll.scrollTop).toBe(100);
  expect(document.activeElement).toBe(stop);
  scroll.scrollTop = 800;
  fireEvent.scroll(scroll);
  Object.defineProperty(scroll, "scrollHeight", { value: 1200 });
  act(() =>
    publish([makeRun({ output: { text: "third line", truncated: false } })]),
  );
  expect(scroll.scrollTop).toBe(1200);
});

it("keeps a failed startup visibly failed while its process still needs stopping", async () => {
  await open([
    makeRun({ error: "Время запуска истекло. Остановка процесса не удалась." }),
  ]);
  expect(
    screen.getByRole("heading", { name: "Не удалось запустить" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Остановить" })).toBeTruthy();
  expect(document.querySelector(".run-output-spinner")).toBeNull();
  expect(screen.queryByText(/Dashboard откроется автоматически/)).toBeNull();
});
it("shows unverified recovery honestly instead of a live dashboard, spinner or effective stop control", async () => {
  const run = makeRun({
    status: "running",
    url: "http://127.0.0.1:1234",
    dashboardOpened: true,
    recovery: "unverified",
  } as any);
  await open([run]);
  expect(
    screen.getByRole("heading", {
      name: "Состояние процесса не подтверждено после перезапуска",
    }),
  ).toBeTruthy();
  expect(screen.getByText("Вывод сохранён")).toBeTruthy();
  expect(document.querySelector(".run-output-spinner")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Остановить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.selectRun).not.toHaveBeenCalledWith(run.id);
});

it("reports pending synchronization and history persistence failures separately from run outcome", async () => {
  await open([
    makeRun({
      status: "exited",
      syncPending: true,
      persistenceError: "History write unavailable",
    } as any),
  ]);
  expect(
    screen.getByRole("heading", { name: "Процесс завершён" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/Синхронизация коммитов ожидает выполнения/),
  ).toBeTruthy();
  expect(screen.getByText(/History write unavailable/)).toBeTruthy();
});

it("shows confirmed recovery without reconstructed stream or Dashboard and leaves stop usable", async () => {
  await open([
    ready({
      recovery: "confirmed",
      output: { text: "last saved line", truncated: false },
    }),
  ]);
  expect(
    screen.getByRole("heading", {
      name: "Процесс подтверждён после перезапуска",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(/Исходный вывод и Dashboard не восстановлены/),
  ).toBeTruthy();
  expect(screen.getByText("Вывод сохранён")).toBeTruthy();
  expect(screen.getByLabelText("Строки вывода запуска").textContent).toBe(
    "last saved line",
  );
  expect(document.querySelector(".run-output-spinner")).toBeNull();
  expect(screen.queryByText(/До открытия Dashboard/)).toBeNull();
  expect(screen.queryByText(/Dashboard откроется автоматически/)).toBeNull();
  expect(screen.queryByText("Вывод обновляется")).toBeNull();
  expect(screen.queryByLabelText("Встроенная панель конвейера")).toBeNull();
  expect(api.selectRun).not.toHaveBeenCalledWith("a");
  const stop = screen.getByRole("button", {
    name: "Остановить",
  }) as HTMLButtonElement;
  expect(stop.disabled).toBe(false);
  fireEvent.click(stop);
  expect(api.stopRun).toHaveBeenCalledExactlyOnceWith("a");
});
it("does not tell locked legacy unknown processes to close their record or pretend they are terminal", async () => {
  await open([
    makeRun({
      recovery: "unverified",
      status: "running",
      recoveryMessage:
        "У старой записи нет достаточных данных о владении. Проверка не может безопасно освободить рабочую копию.",
    }),
  ]);
  expect(
    screen.getByRole("heading", {
      name: "Состояние процесса не подтверждено после перезапуска",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(/У старой записи нет достаточных данных о владении/),
  ).toBeTruthy();
  expect(screen.queryByText(/закройте запись/i)).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Процесс завершён" }),
  ).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Остановить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
