import { afterEach, describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { TerminalStore } from "../src/host/terminal-store";
import {
  createTerminalTab,
  initializeTerminalProject,
} from "../src/host/terminal-tabs";
import type { TerminalContext } from "../src/shared/terminal";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-terminal-store-");
  roots.push(root);
  const home = path.join(root, "home");
  await fs.mkdir(home);
  return {
    root,
    home,
    file: path.join(home, ".goga/desktop/terminals.json"),
    store: new TerminalStore(home),
  };
}
const primary: TerminalContext = { kind: "primary", projectId: "p" };
const topic: TerminalContext = {
  kind: "topic",
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: `ctx-${"a".repeat(64)}`,
};
async function populated(store: TerminalStore) {
  const r = await store.load();
  let p = initializeTerminalProject(
    { initialized: false, tabs: [], selectedByContext: {} },
    primary,
    "c",
  );
  p = createTerminalTab(p, primary, "context", "p");
  p = createTerminalTab(p, topic, "context", "a");
  r.projects.p = p;
  return r;
}
describe("private terminal tab registry", () => {
  it("loads empty metadata without commands, processes or automatic sessions", async () => {
    const f = await fixture();
    const v = await f.store.load();
    expect(v).toMatchObject({ schemaVersion: 1, projects: {} });
    expect(Object.keys(v).sort()).toEqual([
      "projects",
      "revision",
      "schemaVersion",
    ]);
  });
  it("round-trips common, primary and topic bindings, names, order and selections", async () => {
    const f = await fixture();
    const value = await populated(f.store);
    const saved = await f.store.save(value);
    expect(saved.revision).not.toBe(value.revision);
    expect(await new TerminalStore(f.home).load()).toEqual(saved);
    expect(saved.projects.p.tabs.map((t) => t.scope.kind)).toEqual([
      "common",
      "context",
      "context",
    ]);
    expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
  });
  it("retains explicit empty state rather than recreating console after restart", async () => {
    const f = await fixture(),
      r = await f.store.load();
    r.projects.p = { initialized: true, tabs: [], selectedByContext: {} };
    await f.store.save(r);
    expect((await new TerminalStore(f.home).load()).projects.p).toEqual(
      r.projects.p,
    );
  });
  it("rejects stale and concurrent writers without losing the winning snapshot", async () => {
    const f = await fixture();
    const first = await populated(f.store),
      other = new TerminalStore(f.home),
      second = await other.load();
    second.projects.q = { initialized: true, tabs: [], selectedByContext: {} };
    const outcomes = await Promise.allSettled([
      f.store.save(first),
      other.save(second),
    ]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
    const winning = outcomes.find((x) => x.status === "fulfilled");
    if (winning?.status !== "fulfilled") throw Error("missing winner");
    expect(await new TerminalStore(f.home).load()).toEqual(winning.value);
  });
  it("never overwrites corrupt or unsupported state", async () => {
    const f = await fixture();
    await f.store.load();
    await fs.writeFile(f.file, '{"schemaVersion":999,"secret":"synthetic"}', {
      mode: 0o600,
    });
    await expect(f.store.load()).rejects.toThrow();
    const raw = await fs.readFile(f.file, "utf8");
    await expect(
      f.store.save({
        schemaVersion: 1,
        revision: "00000000-0000-4000-8000-000000000000",
        projects: {},
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(f.file, "utf8")).toBe(raw);
  });
  it("rejects secrets and runtime fields without touching the saved document", async () => {
    const f = await fixture();
    const saved = await f.store.save(await populated(f.store));
    const raw = await fs.readFile(f.file, "utf8");
    for (const field of ["env", "pid", "output", "command"]) {
      const bad = structuredClone(saved);
      Object.assign(bad.projects.p.tabs[0], { [field]: "synthetic-secret" });
      await expect(f.store.save(bad)).rejects.toThrow();
    }
    expect(await fs.readFile(f.file, "utf8")).toBe(raw);
  });
  it("does not follow a state-file symlink", async () => {
    const f = await fixture();
    await f.store.load();
    const outside = path.join(f.root, "outside");
    await fs.writeFile(outside, "keep", { mode: 0o600 });
    await fs.symlink(outside, f.file);
    await expect(f.store.load()).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("keep");
  });
  it("does not create state through a symlinked ancestor", async () => {
    const f = await fixture(),
      outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.home, ".goga"));
    await expect(f.store.load()).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("rejects public permissions and multiple hardlinks", async () => {
    const f = await fixture();
    await f.store.save(await populated(f.store));
    await fs.chmod(f.file, 0o644);
    await expect(f.store.load()).rejects.toThrow();
    await fs.chmod(f.file, 0o600);
    await fs.link(f.file, path.join(f.root, "hardlink"));
    await expect(f.store.load()).rejects.toThrow();
  });
  it("does not silently recreate a registry deleted after a successful read", async () => {
    const f = await fixture();
    const saved = await f.store.save(await populated(f.store));
    await fs.unlink(f.file);
    await expect(f.store.save(saved)).rejects.toThrow();
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves files on failed write and permits a later valid operation", async () => {
    const f = await fixture();
    const saved = await f.store.save(await populated(f.store)),
      backup = f.file + ".backup";
    await fs.rename(f.file, backup);
    await fs.mkdir(f.file);
    await expect(f.store.save(saved)).rejects.toThrow();
    await fs.rmdir(f.file);
    await fs.rename(backup, f.file);
    const next = await f.store.save(saved);
    expect(await f.store.load()).toEqual(next);
    expect(
      (await fs.readdir(path.dirname(f.file))).filter((x) =>
        x.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });
});
