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
vi.mock("../src/renderer/TerminalSurface", () => ({
  TerminalSurface: ({ tabId, enabled }: any) => (
    <div data-testid="screen" data-enabled={enabled}>
      {tabId}
    </div>
  ),
}));
afterEach(cleanup);
function fixture() {
  let selected = "a",
    revision = 0;
  let finish!: () => void, fail!: (e: Error) => void;
  let gate = Promise.resolve();
  const state = () => ({
    initialized: true,
    revision: String(revision),
    context: { kind: "primary", projectId: "p" },
    selectedId: selected,
    tabs: ["a", "b", "c"].map((id) => ({
      id,
      name: id,
      projectId: "p",
      scope: { kind: "common" },
    })),
    sessions: ["a", "b", "c"].map((id) => ({
      tabId: id,
      sessionId: "s" + id,
      generation: "g",
      state: "running",
      context: { kind: "primary", projectId: "p" },
    })),
  });
  const request = vi.fn(async (r: any): Promise<any> => {
    if (r.kind === "read") return state();
    if (r.kind === "select") {
      await gate;
      if (r.revision !== String(revision)) throw Error("stale revision");
      selected = r.tabId;
      revision++;
      return state();
    }
    if (r.kind === "open")
      return state().sessions.find((s) => s.tabId === r.tabId);
    throw Error(r.kind);
  });
  return {
    api: { request, onChanged: () => () => {} } as any,
    request,
    delay: () => {
      gate = new Promise<void>((ok, no) => {
        finish = ok;
        fail = no;
      });
    },
    release: () => finish(),
    reject: () => fail(Error("select failed")),
  };
}
it("switches an existing screen immediately while selection persists, without open/loading", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  expect(f.request.mock.calls.some(([r]) => r.kind === "open")).toBe(false);
  f.delay();
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  expect(screen.getByTestId("screen").textContent).toBe("b");
  expect(screen.getByTestId("screen").getAttribute("data-enabled")).toBe(
    "false",
  );
  expect(screen.queryByText(/Открываем терминал/)).toBeNull();
  await act(async () => f.release());
  await waitFor(() =>
    expect(screen.getByTestId("screen").getAttribute("data-enabled")).toBe(
      "true",
    ),
  );
  expect(f.request.mock.calls.some(([r]) => r.kind === "open")).toBe(false);
});
it("rapid selection keeps the latest screen and serializes persistence with fresh revisions", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  f.delay();
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  fireEvent.click(screen.getByRole("tab", { name: "c — Общий терминал" }));
  expect(screen.getByTestId("screen").textContent).toBe("c");
  await act(async () => f.release());
  await waitFor(() =>
    expect(screen.getByTestId("screen").getAttribute("data-enabled")).toBe(
      "true",
    ),
  );
  expect(screen.getByTestId("screen").textContent).toBe("c");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    f.request.mock.calls
      .filter(([r]) => r.kind === "select")
      .map(([r]) => [r.tabId, r.revision]),
  ).toEqual([
    ["b", "0"],
    ["c", "1"],
  ]);
});
it("failed background persistence preserves the visible live tab and reports the unsaved choice", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  f.delay();
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  await act(async () => f.reject());
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(
    screen
      .getByRole("tab", { name: "b — Общий терминал" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByText(/Открываем терминал/)).toBeNull();
  expect(f.request.mock.calls.some(([r]) => r.kind === "open")).toBe(false);
  expect(screen.getByTestId("screen").textContent).toBe("b");
});
it("returning to a starting session observes its failure instead of retaining a phantom starting state", async () => {
  let selected = "a",
    revision = 0,
    starting = true,
    notify = () => {};
  let reject!: (e: Error) => void;
  const opening = new Promise<any>((_, no) => (reject = no));
  const sessions = () => [
    {
      tabId: "b",
      sessionId: "sb",
      generation: "g",
      state: "running",
      context: { kind: "primary", projectId: "p" },
    },
    ...(starting
      ? [
          {
            tabId: "a",
            sessionId: "sa",
            generation: "g",
            state: "starting",
            context: { kind: "primary", projectId: "p" },
          },
        ]
      : []),
  ];
  const snapshot = () => ({
    initialized: true,
    revision: String(revision),
    context: { kind: "primary", projectId: "p" },
    selectedId: selected,
    tabs: ["a", "b"].map((id) => ({
      id,
      name: id,
      projectId: "p",
      scope: { kind: "common" },
    })),
    sessions: sessions(),
  });
  const request = vi.fn(async (r: any): Promise<any> => {
    if (r.kind === "read") return snapshot();
    if (r.kind === "select") {
      selected = r.tabId;
      revision++;
      return snapshot();
    }
    if (r.kind === "open") return opening;
    throw Error(r.kind);
  });
  render(
    <TerminalWorkspace
      api={
        {
          request,
          onChanged: (fn: any) => {
            notify = fn;
            return () => {};
          },
        } as any
      }
      scope="p"
    />,
  );
  await screen.findByRole("tab", { name: "a — Общий терминал" });
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open", tabId: "a" }),
    ),
  );
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  await waitFor(() =>
    expect(screen.getByTestId("screen").getAttribute("data-enabled")).toBe(
      "true",
    ),
  );
  fireEvent.click(screen.getByRole("tab", { name: "a — Общий терминал" }));
  await waitFor(() =>
    expect(request.mock.calls.filter(([r]) => r.kind === "open")).toHaveLength(
      2,
    ),
  );
  await act(async () => {
    starting = false;
    reject(Error("shell failed"));
    notify();
  });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "shell failed",
  );
  expect(screen.queryByText(/Подождите…|Открываем терминал/)).toBeNull();
  expect(request.mock.calls.filter(([r]) => r.kind === "open")).toHaveLength(2);
});

it("does not mark the tab strip or reset controls busy while saving selection", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".terminal-tabs-row button",
    ),
  ];
  const before = buttons.map((b) => [b.disabled, b.getAttribute("aria-busy")]);
  f.delay();
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  expect(buttons.map((b) => [b.disabled, b.getAttribute("aria-busy")])).toEqual(
    before,
  );
  await act(async () => f.release());
  expect(buttons.map((b) => [b.disabled, b.getAttribute("aria-busy")])).toEqual(
    before,
  );
});

it("reset clicked while selection persists waits for its revision and keeps the clicked session", async () => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (r: any) =>
    r.kind === "prepare-refresh"
      ? {
          token: "token",
          kind: "refresh",
          requiresConfirmation: true,
          sessions: [],
        }
      : original(r),
  );
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  f.delay();
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  fireEvent.click(screen.getByRole("button", { name: "Обновить сессию" }));
  expect(f.request.mock.calls.some(([r]) => r.kind === "prepare-refresh")).toBe(
    false,
  );
  await act(async () => f.release());
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prepare-refresh",
        tabId: "b",
        revision: "1",
        ref: { sessionId: "sb", generation: "g" },
      }),
    ),
  );
});

it("adding during a selection uses the persisted revision without dropping the click", async () => {
  const f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (r: any) =>
    r.kind === "create" ? {} : original(r),
  );
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  f.delay();
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  fireEvent.click(screen.getByRole("button", { name: "Добавить терминал" }));
  expect(f.request.mock.calls.some(([r]) => r.kind === "create")).toBe(false);
  await act(async () => f.release());
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create", revision: "1" }),
    ),
  );
});

it("a failed selection cancels the queued reset without touching any session", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  f.delay();
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  fireEvent.click(screen.getByRole("button", { name: "Обновить сессию" }));
  await act(async () => f.reject());
  expect(f.request.mock.calls.some(([r]) => r.kind === "prepare-refresh")).toBe(
    false,
  );
  expect(screen.getByRole("alert").textContent).toContain("select failed");
});

it("retries only a selection CAS conflict with a fresh revision while keeping the screen", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  const original = f.request.getMockImplementation()!;
  let selects = 0;
  f.request.mockImplementation(async (r: any) => {
    if (r.kind === "select") {
      if (++selects === 1)
        throw Error(
          "Error invoking remote method: TERMINAL_SELECTION_REVISION_CHANGED",
        );
      expect(r.revision).toBe("fresh");
      return {
        ...(await original({ kind: "read" })),
        revision: "saved",
        selectedId: r.tabId,
      };
    }
    return { ...(await original(r)), revision: "fresh" };
  });
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  expect(screen.getByTestId("screen").textContent).toBe("b");
  await waitFor(() => expect(selects).toBe(2));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("screen").textContent).toBe("b");
});

it("bounds selection conflict retries and leaves the chosen live console visible", async () => {
  const f = fixture();
  render(<TerminalWorkspace api={f.api} scope="p" />);
  await screen.findByTestId("screen");
  const original = f.request.getMockImplementation()!;
  f.request.mockClear();
  f.request.mockImplementation(async (r: any) => {
    if (r.kind === "select") throw Error("TERMINAL_SELECTION_REVISION_CHANGED");
    return original(r);
  });
  fireEvent.click(screen.getByRole("tab", { name: "b — Общий терминал" }));
  await screen.findByRole("alert");
  expect(
    f.request.mock.calls.filter(([r]) => r.kind === "select"),
  ).toHaveLength(3);
  expect(f.request.mock.calls.filter(([r]) => r.kind === "read")).toHaveLength(
    2,
  );
  expect(screen.getByTestId("screen").textContent).toBe("b");
});
