// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalWorkspace } from "../src/renderer/TerminalWorkspace";
const surfaceProbe = vi.hoisted(() => ({ fail: (_message: string) => {} }));
vi.mock("../src/renderer/TerminalSurface", () => ({
  TerminalSurface: ({ tabId, onError }: any) => {
    surfaceProbe.fail = onError;
    return <div data-testid="terminal-screen">{tabId}</div>;
  },
}));

afterEach(cleanup);
function fixture(initialized = true) {
  let selected: string | null = "t";
  let tabs: any[] = [
    { id: "t", projectId: "p", name: "console", scope: { kind: "common" } },
  ];
  let listener = () => {};
  const sessions = new Map<string, any>();
  const snapshot = (scope: any) => ({
    revision: "v",
    context:
      typeof scope === "string"
        ? { kind: "primary", projectId: scope }
        : { kind: "topic", ...scope },
    initialized,
    tabs: [...tabs],
    selectedId: selected,
    sessions: [...sessions.values()],
  });
  const request = vi.fn(async (r: any): Promise<any> => {
    if (r.kind === "read") return snapshot(r.scope);
    if (r.kind === "initialize") {
      initialized = true;
      tabs = [
        { id: "t", projectId: "p", name: "console", scope: { kind: "common" } },
      ];
      selected = "t";
      return snapshot(r.scope);
    }
    if (r.kind === "open") {
      const value = {
        sessionId: `s-${r.tabId}`,
        generation: "g",
        tabId: r.tabId,
        state: "running",
        context: snapshot(r.scope).context,
      };
      sessions.set(r.tabId, value);
      return value;
    }
    if (r.kind === "create") {
      const id = `t${tabs.length}`;
      tabs.push({
        id,
        projectId: "p",
        name: `console (${tabs.length})`,
        scope:
          r.area === "common"
            ? { kind: "common" }
            : { kind: "context", context: snapshot(r.scope).context },
      });
      selected = id;
    }
    if (r.kind === "select") selected = r.tabId;
    if (r.kind === "rename")
      tabs = tabs.map((t) => (t.id === r.tabId ? { ...t, name: r.name } : t));
    if (r.kind === "prepare-close" || r.kind === "prepare-refresh")
      return {
        token: "ticket",
        kind: r.kind === "prepare-close" ? "tab" : "refresh",
        requiresConfirmation: true,
        sessions: [
          {
            tabId: r.tabId,
            sessionId: "s",
            generation: "g",
            context: { kind: "primary", projectId: "p" },
            state: "running",
            jobCount: 1,
          },
        ],
      };
    if (r.kind === "confirm") {
      tabs = [];
      selected = null;
      return { status: "success", completed: [], remaining: [] };
    }
    return snapshot(r.scope);
  });
  const api = {
    request,
    onChanged: (fn: () => void) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
  } as any;
  return {
    api,
    request,
    notify: () => listener(),
    empty: () => {
      tabs = [];
      selected = null;
    },
  };
}
it("lazily opens only the selected tab and exposes its common area", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  expect(
    await screen.findByRole("tab", { name: /console — Общий/ }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open", scope: "p", tabId: "t" }),
    ),
  );
  expect(f.request.mock.calls.filter(([r]) => r.kind === "open")).toHaveLength(
    1,
  );
});
it("offers distinct common and primary-bound creation, then rename without changing scope", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab");
  fireEvent.click(
    screen.getByRole("button", { name: "Выбрать тип терминала" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Терминал проекта" }));
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create", area: "context" }),
    ),
  );
  await screen.findByRole("tab", { name: /console \(1\)/ });
  fireEvent.contextMenu(
    screen
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true")!,
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Переименовать терминал" }),
  );
  fireEvent.change(screen.getByLabelText("Имя терминала"), {
    target: { value: "Сборка" },
  });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(
    await screen.findByRole("tab", { name: /Сборка — Терминал проекта/ }),
  ).toBeTruthy();
});
it("confirmation hides the surface; cancel sends no stop or refresh", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть терминал console" }),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.queryByTestId("terminal-screen")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith({ kind: "cancel", token: "ticket" }),
  );
  expect(f.request).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "confirm" }),
  );
});
it("closing the last tab stays empty, including after remount", async () => {
  const f = fixture();
  const view = render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab");
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть терминал console" }),
  );
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Завершить и закрыть" }));
  await screen.findByRole("heading", { name: "Нет открытых терминалов" });
  view.unmount();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("heading", { name: "Нет открытых терминалов" });
  expect(f.request).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "initialize" }),
  );
});
it("initializes the first console only on first entry", async () => {
  const f = fixture(false);
  f.empty();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab", { name: /console/ });
  expect(
    f.request.mock.calls.filter(([r]) => r.kind === "initialize"),
  ).toHaveLength(1);
});
it("unavailable context neither reads nor opens a fallback primary session", async () => {
  const f = fixture();
  render(
    <TerminalWorkspace api={f.api} scope="p" blocked="Копия недоступна" />,
  );
  expect(screen.getByText("Копия недоступна")).toBeTruthy();
  expect(f.request).not.toHaveBeenCalled();
});
it("refresh sends only the session identity and a failed close retains the tab without retrying commands", async () => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (r: any) =>
    r.kind === "confirm"
      ? {
          status: "partial",
          completed: [],
          remaining: [{ sessionId: "s", generation: "g" }],
          message: "Команда не завершилась",
        }
      : original(r),
  );
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  fireEvent.click(screen.getByRole("button", { name: "Обновить сессию" }));
  await screen.findByRole("dialog");
  expect(f.request).toHaveBeenCalledWith({
    kind: "prepare-refresh",
    scope: "p",
    revision: "v",
    tabId: "t",
    ref: { sessionId: "s-t", generation: "g" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Завершить и обновить" }));
  await screen.findByText("Команда не завершилась");
  expect(screen.getByRole("tab", { name: /console/ })).toBeTruthy();
  expect(f.request.mock.calls.filter(([r]) => r.kind === "open")).toHaveLength(
    1,
  );
});
it("context changes replace visible tabs only, reject late UI replies and never close background sessions", async () => {
  const f = fixture();
  let finish!: (value: any) => void;
  const a = {
    projectId: "p",
    topic: "a",
    year: "2026",
    branch: "a",
    contextId: "a",
    revision: "r",
  };
  const b = { ...a, topic: "b", branch: "b", contextId: "b" };
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (r: any) => {
    if (r.kind === "read")
      return {
        revision: "v",
        initialized: true,
        context:
          typeof r.scope === "string"
            ? { kind: "primary", projectId: "p" }
            : { kind: "topic", ...r.scope },
        selectedId: typeof r.scope === "string" ? "primary" : r.scope.topic,
        tabs: [
          {
            id: "common",
            projectId: "p",
            name: "Общая",
            scope: { kind: "common" },
          },
          {
            id: typeof r.scope === "string" ? "primary" : r.scope.topic,
            projectId: "p",
            name: typeof r.scope === "string" ? "Основная" : r.scope.topic,
            scope: {
              kind: "context",
              context:
                typeof r.scope === "string"
                  ? { kind: "primary", projectId: "p" }
                  : { kind: "topic", ...r.scope },
            },
          },
        ],
        sessions: [],
      };
    if (r.kind === "open" && r.scope.contextId === "a")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return original(r);
  });
  const view = render(<TerminalWorkspace api={f.api} scope={a} />);
  await screen.findByRole("tab", { name: /a — Терминал топика/ });
  await waitFor(() => expect(finish).toBeDefined());
  view.rerender(<TerminalWorkspace api={f.api} scope={b} />);
  await screen.findByRole("tab", { name: /b — Терминал топика/ });
  finish({ sessionId: "old", generation: "old", tabId: "a", state: "running" });
  expect(await screen.findByTestId("terminal-screen")).toHaveProperty(
    "textContent",
    "b",
  );
  expect(screen.queryByRole("tab", { name: /a —/ })).toBeNull();
  view.rerender(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab", { name: /Основная — Терминал проекта/ });
  expect(screen.getByRole("tab", { name: /Общая — Общий/ })).toBeTruthy();
  expect(
    f.request.mock.calls.some(([r]) =>
      ["prepare-close", "confirm", "prepare-refresh"].includes(r.kind),
    ),
  ).toBe(false);
});

it("supports manual keyboard tab navigation without opening a session until activation", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab");
  fireEvent.click(
    screen.getByRole("button", { name: "Выбрать тип терминала" }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Общий терминал" }),
  );
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0]);
  const opened = f.request.mock.calls.filter(([r]) => r.kind === "open").length;
  tabs[1].focus();
  fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
  expect(document.activeElement).toBe(tabs[0]);
  expect(f.request.mock.calls.filter(([r]) => r.kind === "open")).toHaveLength(
    opened,
  );
  fireEvent.keyDown(tabs[0], { key: "End" });
  expect(document.activeElement).toBe(tabs[1]);
  fireEvent.keyDown(tabs[1], { key: "Home" });
  expect(document.activeElement).toBe(tabs[0]);
  fireEvent.click(tabs[0]);
  await waitFor(() =>
    expect(tabs[0].getAttribute("aria-selected")).toBe("true"),
  );
});

it("matches prototype hierarchy: heading, adjacent add control and compact actions menu", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  expect(screen.getByRole("heading", { name: "Терминал" })).toBeTruthy();
  const tabs = screen.getByRole("tablist", { name: "Вкладки терминала" });
  expect(
    tabs.nextElementSibling?.contains(
      screen.getByRole("button", { name: "Добавить терминал" }),
    ),
  ).toBe(true);
  expect(
    tabs.nextElementSibling?.contains(
      screen.getByRole("button", { name: "Выбрать тип терминала" }),
    ),
  ).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Переименовать терминал" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Действия с вкладкой" }),
  ).toBeNull();
  const menu = screen.getByRole("tab");
  fireEvent.contextMenu(menu);
  expect(
    screen.getByRole("menu", { name: "Действия с вкладкой" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("terminal-screen")).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: "Переименовать терминал" }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(menu);
  expect(await screen.findByTestId("terminal-screen")).toBeTruthy();
  expect(f.request.mock.calls.filter(([r]) => r.kind === "open")).toHaveLength(
    1,
  );
});

it("lays the terminal out as a full-height flex section inside the actual App scroll area", async () => {
  const { readFileSync } = await import("node:fs");
  const style = document.createElement("style");
  style.textContent = readFileSync(
    "src/renderer/TerminalWorkspace.css",
    "utf8",
  );
  document.head.append(style);
  const host = document.createElement("div");
  host.className = "scroll-area";
  document.body.append(host);
  try {
    const f = fixture();
    render(<TerminalWorkspace api={f.api} scope="p" />, { container: host });
    await screen.findByRole("heading", { name: "Терминал" });
    expect(getComputedStyle(host).display).toBe("flex");
    expect(getComputedStyle(host).flexDirection).toBe("column");
  } finally {
    style.remove();
    host.remove();
  }
});

it("uses concise types, dismisses add on tab activation, and shows the shared tooltip", async () => {
  const { api } = fixture();
  const { container } = render(<TerminalWorkspace api={api} scope="p" />);
  const tab = await screen.findByRole("tab", {
    name: "console — Общий терминал",
  });
  await screen.findByTestId("terminal-screen");
  expect(
    container.querySelector(".terminal-footer")?.textContent,
  ).not.toContain("console");
  fireEvent.click(
    screen.getByRole("button", { name: "Выбрать тип терминала" }),
  );
  expect(screen.getByRole("menuitem", { name: "Общий терминал" })).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: "Терминал проекта" }),
  ).toBeTruthy();
  fireEvent.click(tab);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.mouseEnter(tab.parentElement!);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toBe("console: Общий терминал");
  expect(tab.hasAttribute("title")).toBe(false);
});

it("treats activation of the already selected console as a presentation-only no-op", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  const surface = await screen.findByTestId("terminal-screen");
  f.request.mockClear();
  fireEvent.click(
    screen.getByRole("button", { name: "Выбрать тип терминала" }),
  );
  fireEvent.click(
    screen.getByRole("tab", { name: "console — Общий терминал" }),
  );
  expect(screen.getByTestId("terminal-screen")).toBe(surface);
  expect(f.request).not.toHaveBeenCalled();
});
it("keeps the same console surface mounted while the actions menu opens and closes", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  const surface = await screen.findByTestId("terminal-screen");
  f.request.mockClear();
  fireEvent.contextMenu(
    screen
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true")!,
  );
  expect(screen.getByTestId("terminal-screen")).toBe(surface);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.getByTestId("terminal-screen")).toBe(surface);
  expect(f.request).not.toHaveBeenCalled();
});
it("restores cached console immediately while host revalidation is pending on returning to a project", async () => {
  const f = fixture();
  const view = render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  view.unmount();
  f.request.mockImplementation(() => new Promise(() => {}));
  render(<TerminalWorkspace api={f.api} scope="p" />);
  expect(screen.getByTestId("terminal-screen")).toBeTruthy();
  expect(screen.queryByText("Загружаем вкладки…")).toBeNull();
  expect(screen.queryByText("Открываем терминал…")).toBeNull();
});
it("does not expose a cached console when renewed host authorization fails", async () => {
  const f = fixture();
  const view = render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  view.unmount();
  f.request.mockRejectedValue(new Error("Контекст недоступен"));
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByText("Контекст недоступен");
  expect(screen.queryByTestId("terminal-screen")).toBeNull();
});

it("returns to a retained workspace without read/open or recreating its screen", async () => {
  const { RetainedViews } = await import("../src/renderer/RetainedViews");
  const f = fixture();
  const view = (key: string) => (
    <RetainedViews activeKey={key}>
      {key === "p" ? (
        <TerminalWorkspace api={f.api} scope="p" />
      ) : (
        <p>Other project</p>
      )}
    </RetainedViews>
  );
  const ui = render(view("p"));
  const surface = await screen.findByTestId("terminal-screen");
  f.request.mockClear();
  ui.rerender(view("other"));
  ui.rerender(view("p"));
  expect(screen.getByTestId("terminal-screen")).toBe(surface);
  expect(
    f.request.mock.calls.filter(([r]: any) =>
      ["read", "open"].includes(r.kind),
    ),
  ).toEqual([]);
});

it("defers hidden workspace metadata reads until activation instead of queueing Git checks", async () => {
  const { RetainedViews } = await import("../src/renderer/RetainedViews");
  const f = fixture();
  const view = (key: string) => (
    <RetainedViews activeKey={key}>
      {key === "p" ? <TerminalWorkspace api={f.api} scope="p" /> : <p>Other</p>}
    </RetainedViews>
  );
  const ui = render(view("p"));
  await screen.findByTestId("terminal-screen");
  ui.rerender(view("other"));
  f.request.mockClear();
  f.notify();
  f.notify();
  f.notify();
  expect(f.request).not.toHaveBeenCalled();
  ui.rerender(view("p"));
  await waitFor(() =>
    expect(
      f.request.mock.calls.filter(([r]: any) => r.kind === "read"),
    ).toHaveLength(1),
  );
});

it("plus directly creates a context terminal without opening a type menu", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab");
  fireEvent.click(screen.getByRole("button", { name: "Добавить терминал" }));
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create", area: "context", scope: "p" }),
    ),
  );
  expect(screen.queryByRole("menu")).toBeNull();
});
it("renames inline and cancels with Escape without hiding or reopening the screen", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  const surface = await screen.findByTestId("terminal-screen");
  f.request.mockClear();
  fireEvent.doubleClick(screen.getByRole("tab"));
  const input = screen.getByRole("textbox", { name: "Имя терминала" });
  expect(input.closest(".terminal-tab")).toBeTruthy();
  expect(screen.getByTestId("terminal-screen")).toBe(surface);
  fireEvent.change(input, { target: { value: "work" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(f.request).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByRole("tab"));
  const next = screen.getByRole("textbox");
  fireEvent.change(next, { target: { value: "work" } });
  fireEvent.submit(next.closest("form")!);
  await screen.findByRole("tab", { name: /work — Общий/ });
  expect(screen.getByTestId("terminal-screen")).toBe(surface);
  expect(
    f.request.mock.calls.filter(([r]: any) => r.kind === "open"),
  ).toHaveLength(0);
});
it("opens a context menu on an inactive tab without selecting it or reloading its session", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab");
  fireEvent.click(screen.getByRole("button", { name: "Добавить терминал" }));
  await screen.findByRole("tab", { name: /console \(1\)/ });
  const surface = await screen.findByTestId("terminal-screen");
  f.request.mockClear();
  fireEvent.contextMenu(
    screen.getByRole("tab", { name: "console — Общий терминал" }),
  );
  expect(
    screen.getByRole("menu", { name: "Действия с вкладкой" }),
  ).toBeTruthy();
  expect(screen.getByTestId("terminal-screen")).toBe(surface);
  expect(f.request).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Переименовать терминал" }),
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "old" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rename", tabId: "t", name: "old" }),
    ),
  );
});

it("drag sends one captured-revision reorder and ignores external drops", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab");
  fireEvent.click(screen.getByRole("button", { name: "Добавить терминал" }));
  await screen.findByRole("tab", { name: /console \(1\)/ });
  const nodes = screen
    .getAllByRole("tab")
    .map((t) => t.closest(".terminal-tab")!);
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  f.request.mockClear();
  fireEvent.drop(nodes[0], { dataTransfer: transfer });
  expect(f.request).not.toHaveBeenCalled();
  fireEvent.dragStart(nodes[1], { dataTransfer: transfer });
  fireEvent.dragOver(nodes[0], { dataTransfer: transfer });
  fireEvent.drop(nodes[0], { dataTransfer: transfer });
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith({
      kind: "reorder",
      scope: "p",
      revision: "v",
      tabId: "t1",
      targetTabId: "t",
    }),
  );
  expect(
    f.request.mock.calls.filter(([r]: any) => r.kind === "reorder"),
  ).toHaveLength(1);
  expect(
    f.request.mock.calls.some(([r]: any) =>
      ["open", "select", "move"].includes(r.kind),
    ),
  ).toBe(false);
});
it("failed rename retains the inline draft; F2 and Escape never send a command", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation((r: any) =>
    r.kind === "rename" ? Promise.reject(Error("stale name")) : original(r),
  );
  fireEvent.keyDown(screen.getByRole("tab"), { key: "F2" });
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "kept" } });
  fireEvent.submit(input.closest("form")!);
  await screen.findByText("stale name");
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("kept");
});
it("uses the topics refresh glyph rather than the synchronization arrows for session refresh", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByRole("tab", { name: /console — Общий/ });
  const button = screen.getByRole("button", { name: "Обновить сессию" });
  expect(button.textContent).toBe("↻");
  expect(button.querySelector("svg")).toBeNull();
  expect(button.querySelector('[aria-hidden="true"]')?.textContent).toBe("↻");
});

it("does not erase a failed metadata refresh or mutate stale cached tabs", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  f.request.mockRejectedValue(Error("Metadata unavailable"));
  act(() => f.notify());
  await screen.findByText("Metadata unavailable");
  expect(screen.getByTestId("terminal-screen")).toBeTruthy();
  f.request.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Добавить терминал" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain(
    "Metadata unavailable",
  );
  expect(f.request).not.toHaveBeenCalled();
});

it("retains a topic screen across freshness revisions and ignores the old pending read", async () => {
  const f = fixture();
  const owner = {
    projectId: "p",
    year: "2026",
    topic: "a",
    branch: "a",
    contextId: `ctx-${"a".repeat(64)}`,
    revision: crypto.randomUUID(),
  };
  const ui = render(<TerminalWorkspace api={f.api} scope={owner} />);
  const terminal = await screen.findByTestId("terminal-screen");
  const original = f.request.getMockImplementation()!;
  const oldSnapshot = await original({ kind: "read", scope: owner });
  let release!: (value: any) => void;
  f.request.mockClear();
  f.request.mockImplementation((r: any) =>
    r.kind === "read" && r.scope.revision === owner.revision
      ? new Promise((yes) => {
          release = yes;
        })
      : original(r),
  );
  act(() => f.notify());
  await waitFor(() => expect(release).toBeDefined());
  ui.rerender(
    <TerminalWorkspace
      api={f.api}
      scope={{ ...owner, revision: crypto.randomUUID() }}
    />,
  );
  expect(screen.getByTestId("terminal-screen")).toBe(terminal);
  await act(async () => {});
  await act(async () =>
    release({
      ...oldSnapshot,
      tabs: oldSnapshot.tabs.map((t: any) => ({ ...t, name: "obsolete" })),
    }),
  );
  expect(screen.getByTestId("terminal-screen")).toBe(terminal);
  expect(screen.queryByText("obsolete")).toBeNull();
  expect(f.request.mock.calls.some(([r]) => r.kind === "open")).toBe(false);
});

it("a failure belongs to its session generation and cannot hide a replacement", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  const current = await f.request({ kind: "read", scope: "p" });
  act(() => surfaceProbe.fail("Screen unavailable"));
  expect(screen.queryByTestId("terminal-screen")).toBeNull();
  f.request.mockResolvedValue({
    ...current,
    sessions: current.sessions.map((s: any) => ({
      ...s,
      generation: "replacement",
    })),
  });
  act(() => f.notify());
  await screen.findByTestId("terminal-screen");
  expect(screen.queryByText("Screen unavailable")).toBeNull();
});

it.each([false, true])("refresh hides the retired screen behind a loader and settles (failure=%s)", async (fail) => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  let finish!: () => void;
  let replacement: any;
  f.request.mockImplementation(async (r: any) => {
    if (r.kind === "confirm") {
      await new Promise<void>(resolve => { finish = resolve; });
      if (fail) throw Error("Restart failed");
      replacement = { sessionId: "new", generation: "new-g", tabId: "t", state: "running", context: { kind: "primary", projectId: "p" } };
      return { status: "success", session: replacement, completed: [], remaining: [] };
    }
    const result = await original(r);
    return r.kind === "read" && replacement ? { ...result, sessions: [replacement] } : result;
  });
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("terminal-screen");
  fireEvent.click(screen.getByRole("button", { name: "Обновить сессию" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Завершить и обновить" }));
  await screen.findByRole("status", { name: "Перезапускаем терминал" });
  expect(screen.queryByTestId("terminal-screen")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole("status", { name: "Перезапускаем терминал" })).toBeNull());
  if (fail) {
    expect(await screen.findByText("Restart failed")).toBeTruthy();
    expect(screen.queryByTestId("terminal-screen")).toBeNull();
  }
  else expect(await screen.findByTestId("terminal-screen")).toBeTruthy();
});

it.each([false, true])("initial terminal loading covers metadata and spawn, settles on failure=%s", async (fail) => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  let releaseRead!: () => void;
  let releaseOpen!: () => void;
  f.request.mockImplementation(async (r: any) => {
    if (r.kind === "read") await new Promise<void>(resolve => { releaseRead = resolve; });
    if (r.kind === "open") {
      await new Promise<void>(resolve => { releaseOpen = resolve; });
      if (fail) throw Error("Shell failed");
    }
    return original(r);
  });
  render(<TerminalWorkspace api={f.api} scope="p" />);
  expect(await screen.findByRole("status", { name: "Открываем терминал" })).toBeTruthy();
  expect(screen.queryByText("Загружаем вкладки…")).toBeNull();
  await act(async () => releaseRead());
  await waitFor(() => expect(releaseOpen).toBeTypeOf("function"));
  expect(screen.getByRole("status", { name: "Открываем терминал" })).toBeTruthy();
  expect(screen.queryByTestId("terminal-screen")).toBeNull();
  await act(async () => releaseOpen());
  await waitFor(() => expect(screen.queryByRole("status", { name: "Открываем терминал" })).toBeNull());
  if (fail) expect(await screen.findByText("Shell failed")).toBeTruthy();
  else expect(await screen.findByTestId("terminal-screen")).toBeTruthy();
});
