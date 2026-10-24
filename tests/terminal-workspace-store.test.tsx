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
import { mkdtemp, rm } from "node:fs/promises";
import { TerminalCatalog } from "../src/host/terminal-catalog";
import { TerminalStore } from "../src/host/terminal-store";
import { RetainedViews } from "../src/renderer/RetainedViews";
import { TerminalWorkspace } from "../src/renderer/TerminalWorkspace";
import type { ScopeRef } from "../src/shared/context";
import type { TerminalContext } from "../src/shared/terminal";
vi.mock("../src/renderer/TerminalSurface", () => ({
  TerminalSurface: () => <div>test surface</div>,
}));
const homes: string[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
const a = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
};
const b = { ...a, topic: "b", branch: "b", contextId: `ctx-${"b".repeat(64)}` };
const owner = async (scope: ScopeRef): Promise<TerminalContext> => {
  if (typeof scope === "string") return { kind: "primary", projectId: scope };
  const { revision: _, ...rest } = scope;
  return { kind: "topic", ...rest };
};
function apiFor(catalog: TerminalCatalog) {
  const request = vi.fn(async (r: any): Promise<any> => {
    if (r.kind === "read")
      return { ...(await catalog.read(r.scope)), sessions: [] };
    if (r.kind === "open")
      return {
        sessionId: r.tabId,
        generation: crypto.randomUUID(),
        tabId: r.tabId,
        state: "running",
        context: await owner(r.scope),
      };
    return catalog.change(r);
  });
  return { request, onChanged: () => () => {} } as any;
}
const names = () => screen.getAllByRole("tab").map((t) => t.textContent);
it("persists UI reorder/name/selection with real catalog and store across a fresh instance, preserving context filtering", async () => {
  const home = await mkdtemp("/private/tmp/goga-terminal-ui-store-");
  homes.push(home);
  const catalog = new TerminalCatalog(new TerminalStore(home), owner);
  for (const [scope, area, name] of [
    ["p", "common", "C"],
    ["p", "context", "P"],
    [a, "context", "A"],
    [b, "context", "B"],
    ["q", "common", "Q"],
  ] as const) {
    const state = await catalog.read(scope);
    const created = await catalog.change({
      kind: "create",
      scope,
      area,
      revision: state.revision,
    });
    await catalog.change({
      kind: "rename",
      scope,
      revision: created.revision,
      tabId: created.selectedId!,
      name,
    });
  }
  const api = apiFor(catalog),
    view = render(<TerminalWorkspace api={api} scope={a} />);
  await waitFor(() => expect(names()).toEqual(["C", "A"]));
  fireEvent.contextMenu(
    screen
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true")!,
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Переместить терминал влево" }),
  );
  await waitFor(() => expect(names()).toEqual(["A", "C"]));
  fireEvent.contextMenu(
    screen
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true")!,
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Переименовать терминал" }),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Topic tools" },
  });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await waitFor(() => expect(names()).toEqual(["Topic tools", "C"]));
  const opened = api.request.mock.calls.filter(([r]: any) => r.kind === "open");
  expect(opened).toHaveLength(1);
  view.unmount();
  const restored = new TerminalCatalog(new TerminalStore(home), owner),
    fresh = apiFor(restored);
  expect(fresh.request).not.toHaveBeenCalled();
  const next = render(<TerminalWorkspace api={fresh} scope={a} />);
  await waitFor(() => expect(names()).toEqual(["Topic tools", "C"]));
  expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe(
    "true",
  );
  await waitFor(() =>
    expect(
      fresh.request.mock.calls.filter(([r]: any) => r.kind === "open"),
    ).toHaveLength(1),
  );
  next.rerender(<TerminalWorkspace api={fresh} scope={b} />);
  await waitFor(() => expect(names()).toEqual(["C", "B"]));
  next.rerender(<TerminalWorkspace api={fresh} scope="p" />);
  await waitFor(() => expect(names()).toEqual(["P", "C"]));
  expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe(
    "true",
  );
  expect((await restored.read("q")).tabs.map((t) => t.name)).toEqual(["Q"]);
});

it("switches from a topic-only console to a new common console in primary without replacing the topic session", async () => {
  const home = await mkdtemp("/private/tmp/goga-terminal-empty-context-");
  homes.push(home);
  const catalog = new TerminalCatalog(new TerminalStore(home), owner);
  const initial = await catalog.read(a);
  const topic = await catalog.change({
    kind: "create",
    scope: a,
    revision: initial.revision,
    area: "context",
  });
  const api = apiFor(catalog);
  const pane = (scope: ScopeRef) => (
    <RetainedViews activeKey={typeof scope === "string" ? scope : scope.topic}>
      <TerminalWorkspace api={api} scope={scope} />
    </RetainedViews>
  );
  const view = render(pane(a));
  await screen.findByRole("tab", { name: /console — Терминал топика/ });
  await screen.findByText("test surface");
  expect(
    api.request.mock.calls.filter(([r]: any) => r.kind === "initialize"),
  ).toHaveLength(0);
  view.rerender(pane("p"));
  await screen.findByRole("tab", { name: /console \(1\) — Общий терминал/ });
  await screen.findByText("test surface");
  const primary = await catalog.read("p");
  expect(primary.tabs).toHaveLength(1);
  expect(primary.tabs[0].scope).toEqual({ kind: "common" });
  expect((await catalog.read(a)).selectedId).toBe(topic.selectedId);
  view.rerender(pane(a));
  expect(
    screen
      .getByRole("tab", { name: /console — Терминал топика/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByText("test surface")).toBeTruthy();
  expect(
    api.request.mock.calls.filter(
      ([r]: any) =>
        r.kind === "open" &&
        typeof r.scope !== "string" &&
        r.scope.topic === "a",
    ),
  ).toHaveLength(1);
  view.rerender(pane(b));
  await screen.findByRole("tab", { name: /console \(1\) — Общий терминал/ });
  expect((await catalog.read(b)).tabs[0].id).toBe(primary.tabs[0].id);
  expect(
    api.request.mock.calls.filter(([r]: any) => r.kind === "initialize"),
  ).toHaveLength(1);
});
