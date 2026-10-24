import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { TerminalStore } from "../src/host/terminal-store";
import { TerminalCatalog } from "../src/host/terminal-catalog";
import type { ScopeRef } from "../src/shared/context";
import type { TerminalContext } from "../src/shared/terminal";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
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
function owner(scope: ScopeRef): TerminalContext {
  if (typeof scope === "string") return { kind: "primary", projectId: scope };
  const { revision, ...rest } = scope;
  return { kind: "topic", ...rest };
}
async function fixture() {
  const home = await mkdtemp("/private/tmp/goga-terminal-catalog-");
  roots.push(home);
  const store = new TerminalStore(home),
    resolve = vi.fn(async (scope: ScopeRef) => owner(scope));
  const catalog = new TerminalCatalog(store, resolve);
  return { home, store, resolve, catalog };
}
it("reads without creating a tab and initializes console only on explicit first open", async () => {
  const f = await fixture();
  const empty = await f.catalog.read("p");
  expect(empty.tabs).toEqual([]);
  expect(empty.initialized).toBe(false);
  expect((await f.store.load()).projects).toEqual({});
  const state = await f.catalog.change({
    kind: "initialize",
    scope: "p",
    revision: empty.revision,
  });
  expect(state.tabs.map((t) => [t.name, t.scope.kind])).toEqual([
    ["console", "common"],
  ]);
  const again = await f.catalog.change({
    kind: "initialize",
    scope: "p",
    revision: state.revision,
  });
  expect(again.revision).toBe(state.revision);
  expect(again.tabs).toHaveLength(1);
});
it("filters common, primary-bound, A and B tabs and never exposes other project metadata", async () => {
  const f = await fixture();
  let state = await f.catalog.read("p");
  for (const [scope, kind] of [
    ["p", "common"],
    ["p", "context"],
    [a, "context"],
    [b, "context"],
  ] as const)
    state = await f.catalog.change({
      kind: "create",
      scope,
      area: kind,
      revision: state.revision,
    });
  expect((await f.catalog.read("p")).tabs.map((t) => t.name)).toEqual([
    "console",
    "console (1)",
  ]);
  expect((await f.catalog.read(a)).tabs.map((t) => t.name)).toEqual([
    "console",
    "console (2)",
  ]);
  expect((await f.catalog.read(b)).tabs.map((t) => t.name)).toEqual([
    "console",
    "console (3)",
  ]);
  expect((await f.catalog.read("q")).tabs).toEqual([]);
  expect(Object.keys(await f.catalog.read(a)).sort()).toEqual(
    ["context", "initialized", "revision", "selectedId", "tabs"].sort(),
  );
});
it("enforces strict input, host-resolved full owner, CAS and foreign-tab refusal", async () => {
  const f = await fixture();
  const empty = await f.catalog.read(a);
  const created = await f.catalog.change({
    kind: "create",
    scope: a,
    area: "context",
    revision: empty.revision,
  });
  const tabId = created.tabs[0].id;
  await expect(
    f.catalog.change({
      kind: "rename",
      scope: b,
      revision: created.revision,
      tabId,
      name: "wrong",
    }),
  ).rejects.toThrow();
  await expect(
    f.catalog.change({
      kind: "rename",
      scope: a,
      revision: empty.revision,
      tabId,
      name: "stale",
    }),
  ).rejects.toThrow();
  await expect(
    f.catalog.change({
      kind: "rename",
      scope: a,
      revision: created.revision,
      tabId,
      name: "bad",
      cwd: "/evil",
    } as any),
  ).rejects.toThrow();
  f.resolve.mockResolvedValueOnce(owner(b));
  await expect(f.catalog.read(a)).rejects.toThrow();
  expect((await f.catalog.read(a)).tabs[0].name).toBe("console");
});
it("persists per-context selection, names and order, with primary distinct from common", async () => {
  const f = await fixture();
  let state = await f.catalog.read("p");
  state = await f.catalog.change({
    kind: "initialize",
    scope: "p",
    revision: state.revision,
  });
  const common = state.tabs[0].id;
  state = await f.catalog.change({
    kind: "create",
    scope: a,
    area: "context",
    revision: state.revision,
  });
  const topic = state.selectedId!;
  state = await f.catalog.change({
    kind: "rename",
    scope: a,
    revision: state.revision,
    tabId: topic,
    name: "Tests $(not a command)",
  });
  state = await f.catalog.change({
    kind: "move",
    scope: a,
    revision: state.revision,
    tabId: topic,
    direction: "left",
  });
  state = await f.catalog.change({
    kind: "select",
    scope: "p",
    revision: state.revision,
    tabId: common,
  });
  const restored = new TerminalCatalog(new TerminalStore(f.home), f.resolve);
  expect((await restored.read(a)).tabs.map((t) => t.id)).toEqual([
    topic,
    common,
  ]);
  expect((await restored.read(a)).selectedId).toBe(topic);
  expect((await restored.read("p")).selectedId).toBe(common);
});
it("serializes concurrent CAS mutations without losing the winning edit", async () => {
  const f = await fixture();
  const empty = await f.catalog.read("p");
  const requests = ["common", "context"].map((area) =>
    f.catalog.change({
      kind: "create",
      scope: "p",
      revision: empty.revision,
      area,
    } as any),
  );
  const results = await Promise.allSettled(requests);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await f.catalog.read("p")).tabs).toHaveLength(1);
});
it("checks document authority after awaits and before persisting", async () => {
  const f = await fixture();
  const empty = await f.catalog.read("p");
  let valid = true;
  f.resolve.mockImplementationOnce(async (scope) => {
    valid = false;
    return owner(scope);
  });
  await expect(
    f.catalog.change(
      { kind: "create", scope: "p", area: "common", revision: empty.revision },
      () => {
        if (!valid) throw Error("old document");
      },
    ),
  ).rejects.toThrow("old document");
  expect((await f.store.load()).projects).toEqual({});
});
it("keeps reads empty after removal but ensures one common terminal on the next explicit entry", async () => {
  const f = await fixture();
  const empty = await f.catalog.read("p");
  const state = await f.catalog.change({
    kind: "initialize",
    scope: "p",
    revision: empty.revision,
  });
  const tab = state.tabs[0];
  await expect(
    f.catalog.removeTerminatedTab({ ...tab, projectId: "q" }),
  ).rejects.toThrow();
  await f.catalog.removeTerminatedTab(tab);
  const restarted = new TerminalCatalog(new TerminalStore(f.home), f.resolve),
    current = await restarted.read("p");
  const again = await restarted.change({
    kind: "initialize",
    scope: "p",
    revision: current.revision,
  });
  expect(current.tabs).toEqual([]);
  expect(again.tabs).toHaveLength(1);
  expect(again.tabs[0].scope).toEqual({ kind: "common" });
  expect(again.initialized).toBe(true);
});
it("locks a closing tab against metadata edits; removal preserves unrelated concurrent metadata", async () => {
  const f = await fixture();
  const empty = await f.catalog.read("p");
  const initial = await f.catalog.change({
    kind: "initialize",
    scope: "p",
    revision: empty.revision,
  });
  const tab = initial.tabs[0];
  const release = f.catalog.freeze(tab);
  await expect(
    f.catalog.change({
      kind: "rename",
      scope: "p",
      revision: initial.revision,
      tabId: tab.id,
      name: "race",
    }),
  ).rejects.toThrow();
  await f.catalog.change({
    kind: "create",
    scope: "q",
    area: "common",
    revision: initial.revision,
  });
  await f.catalog.removeTerminatedTab(tab);
  release();
  release();
  expect((await f.catalog.read("q")).tabs).toHaveLength(1);
  expect((await f.catalog.read("p")).tabs).toEqual([]);
});
it("resolves an authoritative tab only under matching catalog revision/context, returning a copy", async () => {
  const f = await fixture();
  const empty = await f.catalog.read(a);
  const state = await f.catalog.change({
    kind: "create",
    scope: a,
    area: "context",
    revision: empty.revision,
  });
  const tab = await f.catalog.authorize(a, state.tabs[0].id, state.revision);
  tab.name = "mutated";
  expect((await f.catalog.read(a)).tabs[0].name).toBe("console");
  await expect(
    f.catalog.authorize(b, tab.id, state.revision),
  ).rejects.toThrow();
});

it("persists one CAS-checked reorder, rejects hidden or frozen targets and keeps selection", async () => {
  const f = await fixture();
  let state = await f.catalog.read(a);
  for (let i = 0; i < 3; i++)
    state = await f.catalog.change({
      kind: "create",
      scope: a,
      revision: state.revision,
      area: "context",
    });
  const [first, , last] = state.tabs;
  const save = vi.spyOn(f.store, "save");
  const request = {
    kind: "reorder" as const,
    scope: a,
    revision: state.revision,
    tabId: last.id,
    targetTabId: first.id,
  };
  const unlock = f.catalog.freeze(first);
  await expect(f.catalog.change(request)).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
  unlock();
  const result = await f.catalog.change(request);
  expect(save).toHaveBeenCalledTimes(1);
  expect(result.tabs.map((t) => t.id)).toEqual([
    last.id,
    ...state.tabs.slice(0, 2).map((t) => t.id),
  ]);
  expect(result.selectedId).toBe(last.id);
  expect((await new TerminalCatalog(f.store, f.resolve).read(a)).tabs).toEqual(
    result.tabs,
  );
  await expect(f.catalog.change(request)).rejects.toThrow();
  await expect(
    f.catalog.change({ ...request, scope: b, revision: result.revision }),
  ).rejects.toThrow();
  expect(save).toHaveBeenCalledTimes(1);
});

it("selection reports a retryable revision conflict but keeps owner, frozen-tab and CAS checks", async () => {
  const f = await fixture();
  const initial = await f.catalog.read("p");
  const p = await f.catalog.change({
    kind: "initialize",
    scope: "p",
    revision: initial.revision,
  });
  const q = await f.catalog.change({
    kind: "initialize",
    scope: "q",
    revision: p.revision,
  });
  const renamed = await f.catalog.change({
    kind: "rename",
    scope: "p",
    revision: q.revision,
    tabId: p.tabs[0].id,
    name: "kept name",
  });
  await expect(
    f.catalog.change({
      kind: "select",
      scope: "p",
      revision: p.revision,
      tabId: p.tabs[0].id,
    }),
  ).rejects.toThrow("TERMINAL_SELECTION_REVISION_CHANGED");
  const chosen = await f.catalog.change({
    kind: "select",
    scope: "p",
    revision: renamed.revision,
    tabId: p.tabs[0].id,
  });
  expect(chosen.tabs[0].name).toBe("kept name");
  expect(chosen.selectedId).toBe(p.tabs[0].id);
  expect((await f.catalog.read("q")).tabs).toEqual(q.tabs);
  await expect(
    f.catalog.change({
      kind: "select",
      scope: "q",
      revision: renamed.revision,
      tabId: p.tabs[0].id,
    }),
  ).rejects.toThrow();
  const release = f.catalog.freeze(chosen.tabs[0]);
  await expect(
    f.catalog.change({
      kind: "select",
      scope: "p",
      revision: p.revision,
      tabId: p.tabs[0].id,
    }),
  ).rejects.toThrow();
  release();
  await expect(
    f.catalog.change({
      kind: "rename",
      scope: "p",
      revision: p.revision,
      tabId: p.tabs[0].id,
      name: "overwrite",
    }),
  ).rejects.toThrow();
});

it("ensures only one common tab across competing empty-context entries", async () => {
  const f = await fixture();
  const initial = await f.catalog.read(a);
  const topicOnly = await f.catalog.change({
    kind: "create",
    scope: a,
    area: "context",
    revision: initial.revision,
  });
  const [primary, other] = await Promise.all([
    f.catalog.change({
      kind: "initialize",
      scope: "p",
      revision: topicOnly.revision,
    }),
    f.catalog.change({
      kind: "initialize",
      scope: b,
      revision: topicOnly.revision,
    }),
  ]);
  expect(primary.tabs).toHaveLength(1);
  expect(primary.tabs[0].scope).toEqual({ kind: "common" });
  expect(other.tabs).toEqual(primary.tabs);
  const original = await f.catalog.read(a);
  expect(original.selectedId).toBe(topicOnly.selectedId);
  expect(original.tabs[0]).toEqual(topicOnly.tabs[0]);
  expect(original.tabs).toHaveLength(2);
});
it("still rejects a stale initialization that would write into an empty context", async () => {
  const f = await fixture();
  const initial = await f.catalog.read(a);
  await f.catalog.change({
    kind: "create",
    scope: a,
    area: "context",
    revision: initial.revision,
  });
  await expect(
    f.catalog.change({
      kind: "initialize",
      scope: "p",
      revision: initial.revision,
    }),
  ).rejects.toThrow();
  expect((await f.catalog.read("p")).tabs).toEqual([]);
});
