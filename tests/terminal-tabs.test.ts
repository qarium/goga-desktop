import { describe, it, expect } from "vitest";
import {
  visibleTerminalTabs,
  nextTerminalName,
  moveTerminalTab,
  reorderTerminalTab,
  initializeTerminalProject,
  createTerminalTab,
  renameTerminalTab,
  removeTerminalTab,
  selectTerminalTab,
} from "../src/host/terminal-tabs";
import {
  terminalContextKey,
  type TerminalContext,
  type TerminalTab,
  type TerminalProjectTabs,
} from "../src/shared/terminal";
const primary: TerminalContext = { kind: "primary", projectId: "p" };
const a: TerminalContext = {
  kind: "topic",
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: `ctx-${"a".repeat(64)}`,
};
const b: TerminalContext = {
  ...a,
  topic: "b",
  branch: "b",
  contextId: `ctx-${"b".repeat(64)}`,
};
const tabs: TerminalTab[] = [
  { id: "c", projectId: "p", name: "console", scope: { kind: "common" } },
  {
    id: "p",
    projectId: "p",
    name: "console (1)",
    scope: { kind: "context", context: primary },
  },
  {
    id: "a",
    projectId: "p",
    name: "console (2)",
    scope: { kind: "context", context: a },
  },
  {
    id: "b",
    projectId: "p",
    name: "console (3)",
    scope: { kind: "context", context: b },
  },
  { id: "c2", projectId: "p", name: "custom", scope: { kind: "common" } },
];
const state = (): TerminalProjectTabs => ({
  initialized: true,
  tabs: structuredClone(tabs),
  selectedByContext: {
    [terminalContextKey(primary)]: "p",
    [terminalContextKey(a)]: "a",
    [terminalContextKey(b)]: "b",
  },
});
const ids = (t: TerminalTab[]) => t.map((x) => x.id);
describe("common and context terminal tabs", () => {
  it("shows exact scope matrix and excludes a different project", () => {
    expect(ids(visibleTerminalTabs(tabs, primary))).toEqual(["c", "p", "c2"]);
    expect(ids(visibleTerminalTabs(tabs, a))).toEqual(["c", "a", "c2"]);
    expect(ids(visibleTerminalTabs(tabs, b))).toEqual(["c", "b", "c2"]);
    expect(
      visibleTerminalTabs(tabs, { kind: "primary", projectId: "q" }),
    ).toEqual([]);
  });
  it("ensures one common tab on explicit entry when the context has no visible tabs", () => {
    const empty: TerminalProjectTabs = {
      initialized: false,
      tabs: [],
      selectedByContext: {},
    };
    const first = initializeTerminalProject(empty, a, "first");
    expect(first.tabs).toMatchObject([
      { id: "first", name: "console", scope: { kind: "common" } },
    ]);
    expect(initializeTerminalProject(first, b, "second").tabs).toHaveLength(1);
    const closed = removeTerminalTab(first, "first");
    expect(closed).toEqual({
      initialized: true,
      tabs: [],
      selectedByContext: {},
    });
    expect(
      initializeTerminalProject(closed, primary, "third").tabs,
    ).toMatchObject([{ id: "third", scope: { kind: "common" } }]);
  });
  it("creates topic and primary bindings without changing existing scope", () => {
    const start = state();
    const withA = createTerminalTab(start, a, "context", "a2");
    expect(withA.tabs.at(-1)?.scope).toEqual({ kind: "context", context: a });
    const withP = createTerminalTab(withA, primary, "context", "p2");
    expect(withP.tabs.at(-1)?.scope).toEqual({
      kind: "context",
      context: primary,
    });
    const common = createTerminalTab(withP, b, "common", "new-common");
    expect(common.tabs.at(-1)?.scope).toEqual({ kind: "common" });
    expect(start).toEqual(state());
    expect(common.tabs.slice(0, tabs.length)).toEqual(tabs);
  });
  it("uses lowest free automatic name across both scopes", () => {
    expect(nextTerminalName(tabs)).toBe("console (4)");
    expect(nextTerminalName(tabs.filter((t) => t.id !== "p"))).toBe(
      "console (1)",
    );
  });
  it("moves visible neighbors while keeping hidden relative order and positions", () => {
    const moved = moveTerminalTab(tabs, a, "c2", "left");
    expect(ids(moved)).toEqual(["c", "p", "c2", "b", "a"]);
    expect(ids(tabs)).toEqual(["c", "p", "a", "b", "c2"]);
    expect(ids(moveTerminalTab(tabs, primary, "c", "left"))).toEqual(ids(tabs));
    expect(() => moveTerminalTab(tabs, primary, "a", "left")).toThrow();
  });
  it("renames common once, without converting its scope", () => {
    const renamed = renameTerminalTab(state(), "c", "work");
    expect(visibleTerminalTabs(renamed.tabs, a)[0].name).toBe("work");
    expect(visibleTerminalTabs(renamed.tabs, primary)[0].scope).toEqual({
      kind: "common",
    });
    expect(() => renameTerminalTab(state(), "c", "bad\nname")).toThrow();
  });
  it("preserves context selections and refuses hidden tab selection", () => {
    const selected = selectTerminalTab(state(), a, "c");
    expect(selected.selectedByContext[terminalContextKey(a)]).toBe("c");
    expect(selected.selectedByContext[terminalContextKey(primary)]).toBe("p");
    expect(() => selectTerminalTab(state(), b, "a")).toThrow();
  });
  it("metadata removal only affects the target and repairs its selections", () => {
    const closed = removeTerminalTab(state(), "a");
    expect(ids(closed.tabs)).toEqual(["c", "p", "b", "c2"]);
    expect(closed.selectedByContext[terminalContextKey(a)]).toBe("c");
    expect(closed.selectedByContext[terminalContextKey(primary)]).toBe("p");
    expect(() => removeTerminalTab(state(), "missing")).toThrow();
  });
  it("refuses duplicate ids and cross-project creation", () => {
    expect(() => createTerminalTab(state(), a, "common", "c")).toThrow();
    expect(() =>
      createTerminalTab(
        state(),
        { kind: "primary", projectId: "q" },
        "common",
        "q",
      ),
    ).toThrow();
  });
});

it("reorders visible slots atomically without moving hidden tabs or mutating input", () => {
  expect(ids(reorderTerminalTab(tabs, a, "c2", "c"))).toEqual([
    "c2",
    "p",
    "c",
    "b",
    "a",
  ]);
  expect(ids(reorderTerminalTab(tabs, a, "c", "c2"))).toEqual([
    "a",
    "p",
    "c2",
    "b",
    "c",
  ]);
  expect(ids(reorderTerminalTab(tabs, a, "c", "c"))).toEqual(ids(tabs));
  expect(() => reorderTerminalTab(tabs, a, "c", "b")).toThrow();
  expect(() => reorderTerminalTab(tabs, a, "p", "c")).toThrow();
  expect(ids(tabs)).toEqual(["c", "p", "a", "b", "c2"]);
});

it("ensures a common tab for an empty context without touching other contexts", () => {
  const topicOnly = createTerminalTab(
    { initialized: true, tabs: [], selectedByContext: {} },
    a,
    "context",
    "topic-only",
  );
  const result = initializeTerminalProject(topicOnly, primary, "fallback");
  expect(result.tabs[0]).toEqual(topicOnly.tabs[0]);
  expect(result.selectedByContext[terminalContextKey(a)]).toBe("topic-only");
  expect(visibleTerminalTabs(result.tabs, primary).map((t) => t.id)).toEqual([
    "fallback",
  ]);
  expect(result.tabs[1].scope).toEqual({ kind: "common" });
  expect(result.tabs[1].name).toBe("console (1)");
  expect(initializeTerminalProject(topicOnly, a, "unneeded")).toEqual(
    topicOnly,
  );
  expect(initializeTerminalProject(result, b, "duplicate")).toEqual(result);
});
