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
import { RetainedViews } from "../src/renderer/RetainedViews";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("refreshes another project's revision before show/select, without rereading the selecting project", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  let revision = 0,
    active = "",
    resolveRead!: () => void;
  let delayed = false;
  const listeners = new Set<Function>();
  const selected: Record<string, string> = { p: "p1", q: "q1" };
  const proven = new Set<string>();
  const snapshot = (scope: string) => ({
    revision: String(revision),
    initialized: true,
    context: { kind: "primary", projectId: scope },
    selectedId: selected[scope],
    tabs: [1, 2].map((n) => ({
      id: scope + n,
      name: scope + n,
      projectId: scope,
      scope: { kind: "common" },
    })),
    sessions: [1, 2].map((n) => ({
      tabId: scope + n,
      sessionId: scope + n,
      generation: "g",
      state: "running",
      context: { kind: "primary", projectId: scope },
    })),
  });
  const request = vi.fn(async (r: any): Promise<any> => {
    if (r.kind === "read") {
      if (r.scope === "p" && delayed)
        await new Promise<void>((yes) => {
          resolveRead = yes;
        });
      return snapshot(r.scope);
    }
    if (r.kind === "hide") {
      active = "";
      return null;
    }
    if (r.kind === "activate") return active === r.scope && proven.has(r.tabId);
    if (r.kind === "show") {
      if (r.revision !== String(revision)) throw Error("stale show");
      proven.add(r.tabId);
      active = r.scope;
      return null;
    }
    if (r.kind === "select") {
      if (r.revision !== String(revision)) throw Error("stale select");
      selected[r.scope] = r.tabId;
      revision++;
      listeners.forEach((fn) => fn({ selectionScope: r.scope }));
      return snapshot(r.scope);
    }
    throw Error(r.kind);
  });
  const api = {
    request,
    onChanged: (fn: Function) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as any;
  const view = (scope: string) => (
    <RetainedViews activeKey={scope}>
      <TerminalWorkspace api={api} scope={scope} />
    </RetainedViews>
  );
  const ui = render(view("p"));
  await waitFor(() => expect(proven.has("p1")).toBe(true));
  ui.rerender(view("q"));
  await waitFor(() => expect(proven.has("q1")).toBe(true));
  request.mockClear();
  fireEvent.click(screen.getByRole("tab", { name: "q2 — Общий терминал" }));
  await waitFor(() => expect(proven.has("q2")).toBe(true));
  expect(request.mock.calls.some(([r]) => r.kind === "read")).toBe(false);
  delayed = true;
  ui.rerender(view("p"));
  await waitFor(() => expect(resolveRead).toBeDefined());
  // An unrelated render during the delayed refresh must not authorize the old revision.
  fireEvent.click(
    screen.getByRole("button", { name: "Выбрать тип терминала" }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "p2 — Общий терминал" }));
  expect(
    request.mock.calls.filter(([r]) => r.kind === "select" && r.scope === "p"),
  ).toHaveLength(0);
  await act(async () => {
    delayed = false;
    resolveRead();
  });
  await waitFor(() => expect(proven.has("p2")).toBe(true));
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "select", scope: "p", revision: "1" }),
  );
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "show",
      scope: "p",
      revision: "2",
      tabId: "p2",
    }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
