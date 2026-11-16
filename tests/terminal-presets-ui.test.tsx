// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalPresetSettings } from "../src/renderer/TerminalPresetSettings";
import { TerminalTabs } from "../src/renderer/TerminalTabs";
import { RetainedViews } from "../src/renderer/RetainedViews";

const entry = {
  id: "dev",
  revision: "v1",
  name: "Dev-сервер",
  command: "npm run dev",
  env: [{ key: "PORT", value: "4100" }],
};
function setup() {
  let doc: typeof entry | null = {
    ...entry,
    env: entry.env.map((v) => ({ ...v })),
  };
  const call = vi.fn(async (r: any) => {
    if (r.kind === "menu")
      return doc
        ? [{ id: doc.id, revision: doc.revision, name: doc.name }]
        : [];
    if (r.kind === "list")
      return doc
        ? [
            {
              id: doc.id,
              revision: doc.revision,
              name: doc.name,
              command: doc.command,
              envCount: doc.env.length,
            },
          ]
        : [];
    if (r.kind === "read") return structuredClone(doc);
    if (r.kind === "save") {
      doc = { ...r.draft, id: r.id ?? "new", revision: "v2" };
      return structuredClone(doc);
    }
    if (r.kind === "remove") {
      doc = null;
      return null;
    }
    throw Error("unexpected request");
  });
  window.goga = { terminalPresets: call } as any;
  return call;
}
afterEach(cleanup);
it("reveals values only inside an explicit editor and preserves draft on conflict", async () => {
  const call = setup();
  const view = (key: string | null) => (
    <RetainedViews activeKey={key}>
      <TerminalPresetSettings />
    </RetainedViews>
  );
  const ui = render(view("settings"));
  const edit = await screen.findByRole("button", {
    name: "Редактировать Dev-сервер",
  });
  expect(call.mock.calls.map(([r]) => r.kind)).toEqual(["list"]);
  fireEvent.click(edit);
  const name = await screen.findByLabelText("Название вкладки");
  const more = screen.getByRole("button", { name: /Переменные окружения/ });
  if (more.getAttribute("aria-expanded") === "false") fireEvent.click(more);
  const val = screen.getByLabelText("Значение 1") as HTMLInputElement;
  expect(val.value).toBe("4100");
  expect(val.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Показать значение 1" }));
  expect(val.type).toBe("text");
  fireEvent.change(name, { target: { value: "Сервер QA" } });
  fireEvent.change(val, { target: { value: "4200" } });
  call.mockRejectedValueOnce(Error("Конфликт сохранения: пресет изменён."));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /пресет изменён/,
  );
  expect(
    (screen.getByLabelText("Название вкладки") as HTMLInputElement).value,
  ).toBe("Сервер QA");
  ui.rerender(view(null));
  ui.rerender(view("settings"));
  await waitFor(() =>
    expect((screen.getByLabelText("Значение 1") as HTMLInputElement).type).toBe(
      "password",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.queryByDisplayValue("4200")).toBeNull();
});
it("saves literal and empty environment values, validates keys before invoking host and confirms delete", async () => {
  const call = setup();
  render(<TerminalPresetSettings />);
  await screen.findByText("Dev-сервер");
  fireEvent.click(screen.getByRole("button", { name: "Новый пресет" }));
  fireEvent.change(screen.getByLabelText("Название вкладки"), {
    target: { value: "Проверка" },
  });
  fireEvent.change(screen.getByLabelText("Команда"), {
    target: { value: "./check" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Переменные окружения/ }));
  const add = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Добавить переменную" }),
    );
  add();
  fireEvent.change(screen.getByLabelText("Имя переменной 1"), {
    target: { value: "HOME" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("alert");
  expect(call.mock.calls.some(([r]) => r.kind === "save")).toBe(false);
  fireEvent.change(screen.getByLabelText("Имя переменной 1"), {
    target: { value: "PORT" },
  });
  add();
  fireEvent.change(screen.getByLabelText("Имя переменной 2"), {
    target: { value: "LABEL" },
  });
  fireEvent.change(screen.getByLabelText("Значение 2"), {
    target: { value: '  $HOME "test"  ' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("button", { name: "Удалить Проверка" });
  expect(
    call.mock.calls.find(([r]) => r.kind === "save")?.[0].draft.env,
  ).toEqual([
    { key: "PORT", value: "" },
    { key: "LABEL", value: '  $HOME "test"  ' },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Удалить Проверка" }));
  expect(call.mock.calls.some(([r]) => r.kind === "remove")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Удалить пресет" }));
  await screen.findByText("Пресетов пока нет.");
});
it("loads name-only menu on demand; sends launch ID only; preserves plain plus", async () => {
  const call = setup(),
    change = vi.fn(async () => true),
    settings = vi.fn();
  render(
    <TerminalTabs
      scope="p"
      state={{
        revision: "r0",
        context: { kind: "primary", projectId: "p" },
        initialized: true,
        tabs: [],
        selectedId: null,
      }}
      busy={false}
      locked={false}
      refreshDisabled={true}
      onChange={change}
      onClose={() => {}}
      onRefresh={() => {}}
      onError={() => {}}
      onPresetSettings={settings}
    />,
  );
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Добавить терминал" }));
  expect(change).toHaveBeenCalledWith({
    kind: "create",
    area: "context",
    scope: "p",
    revision: "r0",
  });
  const menu = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Выбрать тип терминала" }),
    );
  menu();
  const launch = await screen.findByRole("menuitem", { name: "Dev-сервер" });
  expect(screen.getByRole("menu").textContent).not.toMatch(
    /npm run dev|4100|PORT/,
  );
  expect(call.mock.calls.map(([r]) => r.kind)).toEqual(["menu"]);
  fireEvent.click(launch);
  expect(change).toHaveBeenLastCalledWith({
    kind: "create-from-preset",
    scope: "p",
    revision: "r0",
    presetId: "dev",
    presetRevision: "v1",
    actionId: expect.any(String),
  });
  menu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /Настроить пресеты/ }),
  );
  await waitFor(() => expect(settings).toHaveBeenCalledOnce());
});

it("App deep link opens terminal settings directly and Back presents the same selected topic tab without reopening the process", async () => {
  const { App } = await import("../src/renderer/App");
  const { openFirstProject } = await import("./helpers/open-first-project");
  const { installPrototypeContextFixture, selectPrototypeOwner } =
    await import("./helpers/prototype-context-fixture");
  setup();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  try {
    const project = { id: "p", name: "Alpha", path: "/synthetic/alpha" },
      api: any = window.goga;
    const snapshot = (scope: any) => {
      const context =
        typeof scope === "string"
          ? { kind: "primary", projectId: scope }
          : { kind: "topic", ...scope };
      return {
        initialized: true,
        revision: "test",
        context,
        selectedId: "existing",
        tabs: [
          {
            id: "existing",
            projectId: "p",
            scope: { kind: "context", context },
            name: "Консоль тестирования",
          },
        ],
        sessions: [
          {
            tabId: "existing",
            sessionId: "s1",
            generation: "g1",
            context,
            state: "running",
          },
        ],
      };
    };
    const request = vi.fn(async (r: any) =>
      r.kind === "read" ? snapshot(r.scope) : null,
    );
    Object.assign(api, {
      listSettings: vi.fn(async () => ({ profiles: [] })),
      listProjects: vi.fn(async () => [project]),
      runs: vi.fn(async () => []),
      onRuns: vi.fn(() => () => {}),
      onFocusRun: vi.fn(() => () => {}),
      onViewError: vi.fn(() => () => {}),
      selectRun: vi.fn(async () => {}),
      terminal: { request, onChanged: () => () => {} },
    });
    const fx = installPrototypeContextFixture(api, [
      { ...project, topic: "dev", branch: "topic/dev" },
    ]);
    render(<App />);
    await openFirstProject();
    await selectPrototypeOwner();
    fireEvent.click(await screen.findByRole("button", { name: "Терминал" }));
    const tab = await screen.findByRole("tab", {
      name: "Консоль тестирования — Терминал топика",
    });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(request).toHaveBeenCalledWith({
      kind: "read",
      scope: fx.owner("p"),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Выбрать тип терминала" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Настроить пресеты…" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Пресеты вкладок" }),
    ).toBeTruthy();
    expect(api.listSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
    expect(
      (
        await screen.findByRole("tab", {
          name: "Консоль тестирования — Терминал топика",
        })
      ).getAttribute("aria-selected"),
    ).toBe("true");
    expect(request.mock.calls.map(([r]) => r.kind)).not.toContain("open");
    expect(request.mock.calls.map(([r]) => r.kind)).not.toContain(
      "create-from-preset",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("shows a pre-spawn failure in the selected tab without a native screen or duplicate action; refresh still targets that generation", async () => {
  const { TerminalWorkspace } =
    await import("../src/renderer/TerminalWorkspace");
  const context = { kind: "primary", projectId: "p" };
  const session = {
    context,
    tabId: "qa",
    sessionId: "not-spawned",
    generation: "failed-generation",
    state: "exited",
    presetStatus: "cancelled",
    startupMessage: "Не удалось запустить оболочку для этой вкладки.",
  };
  const data = {
    initialized: true,
    revision: "active",
    context,
    tabs: [
      {
        id: "qa",
        projectId: "p",
        scope: { kind: "context", context },
        name: "QA",
      },
    ],
    selectedId: "qa",
    sessions: [session],
  };
  const request = vi.fn(async (r: any) =>
    r.kind === "read"
      ? data
      : r.kind === "prepare-refresh"
        ? {
            requiresConfirmation: true,
            sessions: [],
            kind: "refresh",
            token: "refresh",
          }
        : null,
  );
  render(
    <TerminalWorkspace
      scope="p"
      api={{ request, onChanged: () => () => {} } as any}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    session.startupMessage,
  );
  expect(screen.queryByLabelText("Экран терминала")).toBeNull();
  expect(
    screen.queryByText(
      /Сессия завершена|Экран недоступен|Автозапуск команды пресета отменён/,
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Обновить сессию" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      kind: "prepare-refresh",
      revision: "active",
      scope: "p",
      tabId: "qa",
      ref: { sessionId: "not-spawned", generation: "failed-generation" },
    }),
  );
  expect(request.mock.calls.map(([r]) => r.kind)).not.toContain("open");
});
