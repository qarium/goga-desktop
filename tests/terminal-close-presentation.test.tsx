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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function fixture(requiresConfirmation: boolean, second = true) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    width: 600,
    height: 300,
  } as DOMRect);
  let tabs = ["a", ...(second ? ["b"] : [])].map((id) => ({
    id,
    name: id,
    projectId: "p",
    scope: { kind: "common" },
  }));
  let selectedId: string | null = "a",
    closing = "",
    listener = () => {},
    target = "a",
    readError = "";
  let sessions = tabs.map((t) => ({
    tabId: t.id,
    sessionId: `s-${t.id}`,
    generation: "g",
    state: "running",
    context: { kind: "primary", projectId: "p" },
  }));
  let settle!: (value: any) => void, reject!: (error: Error) => void;
  const duringClose: any[] = [];
  const request = vi.fn(async (r: any): Promise<any> => {
    if (r.kind === "read") {
      if (readError) throw Error(readError);
      return structuredClone({
        revision: "v",
        initialized: true,
        tabs,
        selectedId,
        sessions,
        context: { kind: "primary", projectId: "p" },
      });
    }
    if (r.kind === "activate" || r.kind === "show") {
      if (closing === r.tabId) {
        duringClose.push(r);
        throw Error("Вкладка терминала недоступна или данные устарели.");
      }
      return r.kind === "activate" ? true : null;
    }
    if (r.kind === "prepare-close") {
      target = r.tabId;
      return {
        token: "ticket",
        kind: "tab",
        requiresConfirmation,
        sessions: sessions
          .filter((s) => s.tabId === target)
          .map((s) => ({ ...s, jobCount: requiresConfirmation ? 1 : 0 })),
      };
    }
    if (r.kind === "confirm") {
      closing = target;
      return new Promise((resolve, fail) => {
        settle = resolve;
        reject = fail;
      });
    }
    if (r.kind === "hide" || r.kind === "cancel") return null;
    throw Error(`Unexpected request: ${r.kind}`);
  });
  return {
    api: {
      request,
      onChanged: (fn: () => void) => {
        listener = fn;
        return () => {
          listener = () => {};
        };
      },
    } as any,
    request,
    duringClose,
    stage(state: string) {
      sessions = sessions.map((s) =>
        s.tabId === target ? { ...s, state } : s,
      );
      listener();
    },
    async start(tabId = "a") {
      await screen.findByLabelText("Экран терминала");
      fireEvent.click(
        screen.getByRole("button", { name: `Закрыть терминал ${tabId}` }),
      );
      if (requiresConfirmation)
        fireEvent.click(
          await screen.findByRole("button", { name: "Завершить и закрыть" }),
        );
      await waitFor(() => expect(settle).toBeDefined());
    },
    success() {
      tabs = tabs.filter((t) => t.id !== target);
      sessions = sessions.filter((s) => s.tabId !== target);
      if (selectedId === target) selectedId = tabs[0]?.id ?? null;
      closing = "";
      settle({ status: "success", completed: [], remaining: [] });
    },
    fail(mode: "partial" | "reject" | "unreadable") {
      closing = "";
      if (mode === "unreadable")
        readError = "Не удалось прочитать состояние терминалов";
      if (mode === "partial")
        settle({
          status: "partial",
          completed: [],
          remaining: [],
          message: "Команда не завершилась",
        });
      else reject(Error("Не удалось закрыть терминал"));
    },
  };
}
it.each([false, true])(
  "does not present the retiring session while close is pending (confirmation=%s)",
  async (required) => {
    const f = fixture(required);
    render(<TerminalWorkspace api={f.api} scope="p" />);
    await f.start();
    await act(async () => f.stage("stopping"));
    await act(async () => f.stage("exited"));
    expect(f.duringClose).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Экран терминала")).toBeNull();
    await act(async () => f.success());
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "b — Общий терминал" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(await screen.findByLabelText("Экран терминала")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.request.mock.calls.some(([r]) => r.kind === "open")).toBe(false);
  },
);
it("closes the last tab without re-showing or reopening its exited session", async () => {
  const f = fixture(false, false);
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await f.start();
  await act(async () => f.stage("stopping"));
  await act(async () => f.stage("exited"));
  expect(f.duringClose).toEqual([]);
  await act(async () => f.success());
  await screen.findByRole("heading", { name: "Нет открытых терминалов" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.queryByRole("status", { name: /Закрываем|Открываем|Перезапускаем/ }),
  ).toBeNull();
  expect(f.request.mock.calls.some(([r]) => r.kind === "open")).toBe(false);
});
it("closing a background tab leaves the selected terminal mounted", async () => {
  const f = fixture(false);
  render(<TerminalWorkspace api={f.api} scope="p" />);
  const surface = await screen.findByLabelText("Экран терминала");
  await f.start("b");
  await act(async () => f.stage("stopping"));
  await act(async () => f.stage("exited"));
  expect(screen.getByLabelText("Экран терминала")).toBe(surface);
  expect(
    screen.queryByRole("status", { name: /Закрываем|Открываем|Перезапускаем/ }),
  ).toBeNull();
  await act(async () => f.success());
  expect(screen.getByLabelText("Экран терминала")).toBe(surface);
  expect(screen.queryByRole("alert")).toBeNull();
});
it.each(["partial", "reject", "unreadable"] as const)(
  "keeps a real close failure visible and ends loading: %s",
  async (mode) => {
    const f = fixture(false);
    render(<TerminalWorkspace api={f.api} scope="p" />);
    await f.start();
    await act(async () => f.fail(mode));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      mode === "partial"
        ? "Команда не завершилась"
        : "Не удалось закрыть терминал",
    );
    expect(
      screen.queryByRole("status", {
        name: /Закрываем|Открываем|Перезапускаем/,
      }),
    ).toBeNull();
    expect(
      screen.getByRole("tab", { name: "a — Общий терминал" }),
    ).toBeTruthy();
    if (mode === "unreadable")
      expect(screen.queryByLabelText("Экран терминала")).toBeNull();
    else expect(await screen.findByLabelText("Экран терминала")).toBeTruthy();
    await act(async () => {});
    expect(screen.getByRole("alert")).toBe(alert);
  },
);

it("does not retry a previously failed startup when closing that tab fails", async () => {
  const f = fixture(false, false);
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (r: any) => {
    if (r.kind === "open") throw Error("Оболочка недоступна");
    const result = await original(r);
    return r.kind === "read" ? { ...result, sessions: [] } : result;
  });
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByText("Оболочка недоступна");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть терминал a" }));
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm" }),
    ),
  );
  await act(async () => f.fail("reject"));
  await screen.findByText("Не удалось закрыть терминал");
  expect(f.request.mock.calls.filter(([r]) => r.kind === "open")).toHaveLength(
    1,
  );
  expect(
    screen.queryByRole("status", { name: /Закрываем|Открываем/ }),
  ).toBeNull();
});
