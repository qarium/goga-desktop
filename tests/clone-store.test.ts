import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CloneStore, managedCloneLocation } from "../src/host/clone-store";
import type { WorktreeRecord } from "../src/shared/worktrees";

async function setup() {
  const root = await fs.mkdtemp(
    "/private/tmp/goga-context-ab-research-20261019-impl-clones-store-",
  );
  const home = path.join(root, "home");
  await fs.mkdir(home);
  await fs.mkdir(path.join(root, "source/.git"), { recursive: true });
  return { root, home, store: new CloneStore(home) };
}
function record(
  home: string,
  changes: Partial<WorktreeRecord> = {},
): WorktreeRecord {
  const identity = {
    projectId: changes.projectId ?? "p",
    year: changes.year ?? "2026",
    topic: changes.topic ?? "alpha",
    branch: changes.branch ?? "alpha",
  };
  const projectPath = path.join(path.dirname(home), "source");
  const sourceCommonDir = path.join(projectPath, ".git");
  const location = managedCloneLocation(
    home,
    { id: identity.projectId, path: projectPath },
    sourceCommonDir,
    identity,
  );
  return {
    projectId: identity.projectId,
    year: identity.year,
    topic: identity.topic,
    branch: identity.branch,
    ...location,
    projectPath,
    sourceCommonDir,
    gitCommonDir: path.join(location.path, ".git"),
    storageKind: "clone",
    ownership: "managed",
    state: "missing",
    preparation: "pending",
    revision: randomUUID(),
    ...changes,
  };
}
describe("owned clone registry", () => {
  it("keeps clone identities bounded and distinct by canonical project/year/full identity", async () => {
    const { home } = await setup();
    const rows = [
      record(home),
      record(home, { topic: "Alpha" }),
      record(home, { year: "2025" }),
      record(home, { topic: "../../alpha" }),
    ];
    expect(new Set(rows.map((r) => r.contextId)).size).toBe(4);
    for (const row of rows)
      expect(
        path
          .relative(path.join(home, ".goga/desktop/clones"), row.path)
          .startsWith(".."),
      ).toBe(false);
  });
  it("persists independent clone registry with CAS and leaves legacy files untouched", async () => {
    const { home, store } = await setup();
    const legacy = path.join(home, ".goga/desktop/worktrees/registry.json");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, "legacy", { mode: 0o600 });
    const row = record(home);
    await store.update(row, undefined);
    expect((await new CloneStore(home).read()).records).toEqual([row]);
    await expect(
      store.update(
        { ...row, revision: randomUUID() },
        "00000000-0000-4000-8000-000000000000",
      ),
    ).rejects.toThrow(/измен/);
    expect(await fs.readFile(legacy, "utf8")).toBe("legacy");
    expect(
      (await fs.stat(path.join(store.root, "registry.json"))).mode & 0o777,
    ).toBe(0o600);
  });
  it("rejects foreign paths, clone-to-primary ownership and mutable identity", async () => {
    const { home, store } = await setup();
    const row = record(home);
    await expect(
      store.update({ ...row, path: row.projectPath }, undefined),
    ).rejects.toThrow();
    await expect(
      store.update({ ...row, ownership: "primary" }, undefined),
    ).rejects.toThrow();
    await store.update(row, undefined);
    await expect(
      store.update(
        {
          ...row,
          sourceCommonDir: "/private/tmp/foreign/.git",
          revision: randomUUID(),
        },
        row.revision,
      ),
    ).rejects.toThrow();
  });
  it("pins owned root and git directory inodes instead of adopting replacement directories", async () => {
    const { home, store } = await setup();
    const row = record(home);
    await store.reserve(row);
    await fs.mkdir(row.gitCommonDir);
    await store.claimGit(row);
    await store.assertOwned(row);
    await fs.rename(row.path, `${row.path}.preserved`);
    await fs.mkdir(row.path);
    await fs.mkdir(row.gitCommonDir);
    await expect(new CloneStore(home).assertOwned(row)).rejects.toThrow();
    expect(await fs.readdir(`${row.path}.preserved`)).toContain(".git");
  });
  it.each([".goga", ".goga/desktop", ".goga/desktop/clones"])(
    "rejects symlink at %s",
    async (relative) => {
      const { root, home, store } = await setup();
      const target = path.join(root, "foreign");
      await fs.mkdir(target);
      await fs.mkdir(path.dirname(path.join(home, relative)), {
        recursive: true,
      });
      await fs.symlink(target, path.join(home, relative));
      await expect(store.read()).rejects.toThrow();
      expect(await fs.readdir(target)).toEqual([]);
    },
  );
});

describe("irreversible clone history tombstones", () => {
  it("does not clear confirmed deletedAt or turn it back into a ready execution record", async () => {
    const { home, store } = await setup();
    const row = record(home, {
      preparation: undefined,
      deletedAt: "2026-10-20T12:00:00.000Z",
    });
    await store.update(row, undefined);
    await expect(
      store.update(
        { ...row, deletedAt: undefined, revision: randomUUID() },
        row.revision,
      ),
    ).rejects.toThrow();
    await expect(
      store.update(
        { ...row, state: "ready", revision: randomUUID() },
        row.revision,
      ),
    ).rejects.toThrow();
  });
});

describe("new clone lock restart recovery", () => {
  it("recovers versioned dead PID registry and repository locks without dropping records", async () => {
    const { home, store } = await setup(),
      row = record(home);
    await store.update(row, undefined);
    const owner = JSON.stringify({
      schemaVersion: 1,
      pid: 2147483647,
      nonce: randomUUID(),
    });
    await fs.writeFile(path.join(store.root, ".registry.lock"), owner, {
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(store.root, `.repository-${row.repositoryKey}.lock`),
      owner,
      { mode: 0o600 },
    );
    const restarted = new CloneStore(home);
    expect((await restarted.read()).records).toEqual([row]);
    expect(
      await restarted.withRepositoryLock(
        row.repositoryKey,
        async () => "recovered",
      ),
    ).toBe("recovered");
  }, 10000);
});
