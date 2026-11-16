import { describe, it, expect, vi } from "vitest";
import { createHomeVisits } from "../src/renderer/home/visits-store";
const primary = (projectId: string) => ({
  kind: "primary" as const,
  projectId,
});
const visit = (id: string) => ({
  kind: "section" as const,
  section: "overview" as const,
  owner: primary(id),
});
function memory() {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: vi.fn((_key: string, s: string) => {
      value = s;
    }),
  };
}
describe("home visits", () => {
  it("deduplicates committed project visits, never persists draft keys, and prunes removed registrations", () => {
    const storage = memory(),
      store = createHomeVisits(storage);
    store.remember(visit("a"));
    store.remember(visit("b"));
    store.remember({
      kind: "draft",
      owner: primary("a"),
      key: "private-key",
      draftKind: "pipeline",
    });
    expect(store.getSnapshot().map((v) => v.projectId)).toEqual(["a", "b"]);
    expect(store.getSnapshot()[0].target.kind).toBe("draft");
    expect(storage.getItem()).not.toContain("private-key");
    const restored = createHomeVisits(storage);
    expect(restored.getSnapshot()[0]).toMatchObject({
      target: { kind: "section", section: "overview" },
      previousSessionOnly: true,
    });
    restored.remember(visit("a"));
    expect(restored.getSnapshot()[0].previousSessionOnly).toBeUndefined();
    store.retain(["b"]);
    expect(
      createHomeVisits(storage)
        .getSnapshot()
        .map((v) => v.projectId),
    ).toEqual(["b"]);
  });
  it("does not silently overwrite invalid storage, repeated identical visits don't churn the disk", () => {
    const storage = memory();
    storage.setItem("", "future");
    storage.setItem.mockClear();
    const store = createHomeVisits(storage);
    store.remember(visit("a"));
    expect(storage.getItem()).toBe("future");
    expect(store.getSnapshot()).toHaveLength(1);
    const good = memory(),
      s = createHomeVisits(good);
    s.remember(visit("a"));
    s.remember(visit("a"));
    expect(good.setItem).toHaveBeenCalledTimes(1);
  });
});

it("rewrites only the exact completed preparation without touching visit order, time, or a newer target", () => {
  const store = createHomeVisits(memory()),
    a = primary("a"),
    draft = { kind: "draft", owner: a, draftKind: "build", key: "k" } as const,
    run = { kind: "run", owner: a, runId: "r" } as const;
  store.remember(draft);
  store.remember(visit("b"));
  const before = store.getSnapshot();
  store.replaceDraft({ ...draft, draftKind: "pipeline" }, run);
  store.replaceDraft({ ...draft, key: "other" }, run);
  store.replaceDraft(draft, { ...run, owner: primary("b") });
  expect(store.getSnapshot()).toBe(before);
  store.replaceDraft(draft, run);
  expect(store.getSnapshot()).toEqual([
    before[0],
    { ...before[1], target: run },
  ]);
  store.remember(visit("a"));
  const section = store.getSnapshot();
  store.replaceDraft(draft, run);
  expect(store.getSnapshot()).toBe(section);
});
