import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  WorktreeStore,
  managedWorktreeLocation,
} from "../src/host/worktree-store";
import {
  topicContextIdentitySchema,
  topicContextRefSchema,
  type WorktreeRecord,
} from "../src/shared/worktrees";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    homes
      .splice(0)
      .map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});
async function setup() {
  const home = await fs.mkdtemp("/private/tmp/goga-worktree-store-");
  homes.push(home);
  return {
    home,
    store: new WorktreeStore(home),
    file: path.join(home, ".goga/desktop/worktrees/registry.json"),
  };
}
function record(
  home: string,
  changes: Partial<WorktreeRecord> = {},
): WorktreeRecord {
  const identity = {
    projectId: changes.projectId ?? "project",
    year: changes.year ?? "2026",
    topic: changes.topic ?? "hello",
    branch: changes.branch ?? "goga/2026/hello",
  };
  const projectPath = changes.projectPath ?? "/private/tmp/project";
  const gitCommonDir = changes.gitCommonDir ?? `${projectPath}/.git`;
  const location = managedWorktreeLocation(
    home,
    { id: identity.projectId, path: projectPath },
    gitCommonDir,
    identity,
  );
  return {
    ...identity,
    ...location,
    projectPath,
    gitCommonDir,
    ownership: "managed",
    state: "missing",
    revision: "11111111-1111-4111-8111-111111111111",
    ...changes,
  };
}

describe("managed worktree registry", () => {
  it("rejects renderer-supplied paths and ownership rather than stripping them from identity/ref", () => {
    const identity = {
      projectId: "p",
      year: "2026",
      topic: "alpha",
      branch: "goga/2026/alpha",
    };
    const ref = {
      ...identity,
      contextId: `ctx-${"a".repeat(64)}`,
      revision: "11111111-1111-4111-8111-111111111111",
    };
    expect(topicContextIdentitySchema.safeParse(identity).success).toBe(true);
    expect(topicContextRefSchema.safeParse(ref).success).toBe(true);
    expect(
      topicContextIdentitySchema.safeParse({ ...identity, path: "/outside" })
        .success,
    ).toBe(false);
    expect(
      topicContextRefSchema.safeParse({ ...ref, ownership: "managed" }).success,
    ).toBe(false);
  });
  it("uses canonical project, repository, year and full topic identity rather than readable slugs as keys", async () => {
    const { home } = await setup();
    const a = record(home);
    const variants = [
      record(home, { projectPath: "/private/tmp/other/project" }),
      record(home, { projectId: "another-project" }),
      record(home, { year: "2025" }),
      record(home, { topic: "Hello" }),
      record(home, { branch: "goga/2026/other" }),
      record(home, { gitCommonDir: "/private/tmp/different/.git" }),
    ];
    expect(new Set([a, ...variants].map((r) => r.path)).size).toBe(
      variants.length + 1,
    );
    expect(new Set([a, ...variants].map((r) => r.contextId)).size).toBe(
      variants.length + 1,
    );
    expect(a.path).toContain("/.goga/desktop/worktrees/project-");
    expect(a.path).toContain("/2026/hello-");
  });
  it.each(["../../escape", "a/b", "Топик 🌻", "x".repeat(1000), "a b", "a-b"])(
    "keeps unsafe/Unicode/long label %s inside bounded ASCII path segments",
    async (topic) => {
      const { home } = await setup();
      const value = record(home, { topic });
      const relative = path.relative(
        path.join(home, ".goga/desktop/worktrees"),
        value.path,
      );
      expect(relative.startsWith("..")).toBe(false);
      expect(relative.split(path.sep)).toHaveLength(3);
      expect(
        relative
          .split(path.sep)
          .every((part) => /^[a-zA-Z0-9_-]+$/.test(part) && part.length < 160),
      ).toBe(true);
    },
  );
  it("does not change existing Goga home directory permissions", async () => {
    const { home, store } = await setup();
    const gogaHome = path.join(home, ".goga");
    await fs.mkdir(gogaHome, { mode: 0o750 });
    await fs.chmod(gogaHome, 0o750);
    await store.read();
    expect((await fs.stat(gogaHome)).mode & 0o777).toBe(0o750);
  });
  it("initializes privately and atomically, round-trips records with CAS", async () => {
    const { home, store, file } = await setup();
    const initial = await store.read();
    expect(initial.records).toEqual([]);
    const row = record(home);
    const next = await store.write(initial.revision, [row]);
    expect(next.revision).not.toBe(initial.revision);
    expect((await new WorktreeStore(home).read()).records).toEqual([row]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(store.write(initial.revision, [])).rejects.toThrow(
      /измен|ревизи/,
    );
    expect((await store.read()).records).toEqual([row]);
  });
  it("serializes record CAS from independent instances without losing unrelated records", async () => {
    const { home, store } = await setup();
    const other = new WorktreeStore(home);
    const a = record(home);
    const b = record(home, { projectId: "b" });
    await Promise.all([store.update(a, undefined), other.update(b, undefined)]);
    expect((await store.read()).records).toHaveLength(2);
    await expect(
      other.update(
        {
          ...a,
          state: "ready",
          revision: "22222222-2222-4222-8222-222222222222",
        },
        "stale",
      ),
    ).rejects.toThrow(/измен|ревизи/);
  });
  it("rejects immutable identity/path edits and duplicate context IDs", async () => {
    const { home, store } = await setup();
    const row = record(home);
    const initial = await store.read();
    await expect(store.write(initial.revision, [row, row])).rejects.toThrow();
    await store.update(row, undefined);
    await expect(
      store.update({ ...row, topic: "different" }, row.revision),
    ).rejects.toThrow();
    await expect(
      store.update({ ...row, path: "/private/tmp/unowned" }, row.revision),
    ).rejects.toThrow();
  });
  it("requires a fresh record revision for a readiness transition", async () => {
    const { home, store } = await setup();
    const row = record(home);
    await store.update(row, undefined);
    await expect(
      store.update({ ...row, state: "ready" }, row.revision),
    ).rejects.toThrow(/ревизи|измен/);
    expect((await store.read()).records[0].state).toBe("missing");
  });
  it("preserves historical primary contexts sharing a path but not managed ownership", async () => {
    const { home, store } = await setup();
    const first = record(home);
    const a = {
      ...first,
      path: first.projectPath,
      ownership: "primary" as const,
      state: "conflict" as const,
    };
    const second = record(home, { topic: "other", branch: "goga/2026/other" });
    const b = {
      ...second,
      path: second.projectPath,
      ownership: "primary" as const,
      state: "ready" as const,
    };
    await store.update(a, undefined);
    await store.update(b, undefined);
    expect((await store.read()).records).toHaveLength(2);
  });
  it("fails closed on corrupt JSON without overwriting it", async () => {
    const { store, file } = await setup();
    await store.read();
    for (const raw of [
      "broken",
      "{}",
      JSON.stringify({ schemaVersion: 2, revision: "a", records: [] }),
    ]) {
      await fs.writeFile(file, raw, { mode: 0o600 });
      await expect(store.read()).rejects.toThrow(/поврежд|недопуст|несовмест/);
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });
  it("does not silently reinitialize an established registry that disappeared", async () => {
    const { store, file } = await setup();
    await store.read();
    await fs.unlink(file);
    await expect(store.read()).rejects.toThrow();
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not clobber an unexpected initial registry installed at the atomic link", async () => {
    const { store, file } = await setup();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.link).mockImplementationOnce(async (source, target) => {
      await actual.writeFile(target, "external-state", { mode: 0o600 });
      return actual.link(source, target);
    });
    await expect(store.read()).rejects.toThrow(/измен/);
    expect(await fs.readFile(file, "utf8")).toBe("external-state");
    expect(await fs.readdir(path.dirname(file))).toEqual(["registry.json"]);
  });
  it.each([
    ".goga",
    ".goga/desktop",
    ".goga/desktop/worktrees",
    ".goga/desktop/worktrees/registry.json",
  ])("rejects symlink at %s", async (relative) => {
    const { home, store } = await setup();
    const target = path.join(home, relative);
    const external = path.join(home, "external");
    await fs.mkdir(external);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(external, target);
    await expect(store.read()).rejects.toThrow();
    expect(await fs.readdir(external)).toEqual([]);
  });
  it.each([".goga", ".goga/desktop", ".goga/desktop/worktrees"])(
    "rejects a real directory replacement of trusted %s, not only symlinks",
    async (relative) => {
      const { home, store } = await setup();
      await store.read();
      const root = path.join(home, relative);
      await fs.rename(root, `${root}.saved`);
      await fs.mkdir(root);
      await expect(store.read()).rejects.toThrow();
      expect(await fs.readdir(root)).toEqual([]);
    },
  );
  it("never guesses that an abandoned repository lock is stale", async () => {
    const { home, store } = await setup();
    const key = record(home).repositoryKey;
    await store.read();
    const lock = path.join(
      home,
      ".goga/desktop/worktrees",
      `.repository-${key}.lock`,
    );
    await fs.writeFile(lock, "other owner", { mode: 0o600 });
    await expect(
      store.withRepositoryLock(key, async () => true),
    ).rejects.toThrow(/занят/);
    expect(await fs.readFile(lock, "utf8")).toBe("other owner");
  });
});
