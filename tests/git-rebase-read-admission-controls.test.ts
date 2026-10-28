import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  rename,
  symlink,
  chmod,
  link,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { NativeGitSequence } from "../src/host/git-native-sequence";
import type { GitMergeContext } from "../src/host/git-merge-safety";
import type { ScopeRef } from "../src/shared/context";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { CloneStore } from "../src/host/clone-store";
import { worktreeContextRef } from "../src/shared/worktrees";
import { isOfflineGitRead } from "../src/host/read-scope";
import {
  fixtureScope,
  fixture,
  tree,
  repositories,
} from "./helpers/rebase-read-admission-fixture";
it.each([
  "malformed todo",
  "malformed earlier done",
  "inconsistent counters",
  "ready repository reason",
  "missing current apply patch",
])(
  "separates opaque control drift from physical read ownership: %s",
  fixtureScope.run(async (change) => {
    const f = await fixture(
      change === "missing current apply patch" ? "apply" : "merge",
      0,
      true,
    );
    await f.manager.resolveGitRead(f.scope);
    if (change === "malformed todo")
      await writeFile(
        path.join(f.metadata, "git-rebase-todo"),
        "this-is-not-a-git-command\n",
      );
    if (change === "malformed earlier done")
      await writeFile(
        path.join(f.metadata, "done"),
        "this-is-not-a-git-command\n" +
          (await readFile(path.join(f.metadata, "done"), "utf8")),
      );
    if (change === "inconsistent counters") {
      await writeFile(path.join(f.metadata, "msgnum"), "2\n");
      await writeFile(path.join(f.metadata, "end"), "2\n");
    }
    if (change === "ready repository reason") {
      const row = await f.manager.store.update(
        { ...f.record, reason: "repository", revision: randomUUID() },
        f.record.revision,
      );
      f.scope = worktreeContextRef(row);
    }
    if (change === "missing current apply patch")
      await rm(path.join(f.metadata, "0001"));
    const before = await repositories(f);
    if (change === "ready repository reason") {
      await expect(f.host.readGitWorkspace(f.scope)).rejects.toThrow();
    } else {
      expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
    }
    expect(await repositories(f)).toBe(before);
    if (change !== "ready repository reason") {
      const snapshot = await f.host.readGitWorkspace(f.scope);
      await expect(
        f.host.prepareGitRebaseOperation({
          scope: f.scope,
          revision: snapshot.revision,
          action: "abort",
        }),
      ).rejects.toThrow();
    }
  }),
  gitIntegrationBudget(30000),
);

it.each(["merge", "apply"] as const)(
  "reads a real paused %s rebase in the exact managed clone, without source/clone/registry mutation",
  fixtureScope.run(async (backend) => {
    const f = await fixture(backend);
    const before = await repositories(f);
    const original = f.runner.command.bind(f.runner);
    vi.spyOn(f.runner, "command").mockImplementation(
      (exe, args, cwd, env, stdin) => {
        expect(exe).toBe("git");
        expect(isOfflineGitRead()).toBe(true);
        expect(
          args.some((arg) =>
            [
              "fetch",
              "update-ref",
              "checkout",
              "add",
              "commit",
              "rebase",
            ].includes(arg),
          ),
        ).toBe(false);
        return original(exe, args, cwd, env, stdin);
      },
    );
    const snapshot = await f.host.readGitWorkspace(f.scope);
    expect(snapshot.root).toBe(f.record.path);
    expect(snapshot.branch).toBeNull();
    expect(snapshot.operation).toBe("rebase");
    expect(snapshot.files.find((file) => file.path === "file.txt")?.kind).toBe(
      "conflict",
    );
    const request = {
      scope: f.scope,
      revision: snapshot.revision,
      path: "file.txt",
    };
    expect((await f.host.readGitDiff(request)).scope).toEqual(f.scope);
    const conflict = await f.host.readGitConflict(request);
    expect(conflict.base.text).toBe("base\n");
    expect(conflict.current.text).toBe("upstream\n");
    expect(conflict.incoming.text).toBe("topic\n");
    expect(await repositories(f)).toBe(before);
  }),
  gitIntegrationBudget(30000),
);

it(
  "measures bounded snapshot and conflict reads with 10000 synthetic loose objects",
  fixtureScope.run(async () => {
    const f = await fixture(),
      objects = path.join(f.record.gitCommonDir, "objects");
    for (let prefix = 0; prefix < 256; prefix++)
      await mkdir(path.join(objects, prefix.toString(16).padStart(2, "0")), {
        recursive: true,
      });
    for (let offset = 0; offset < 10000; offset += 100)
      await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const body = Buffer.from(`loose-object-fixture-${offset + index}\n`);
          const object = Buffer.concat([
            Buffer.from(`blob ${body.length}\0`),
            body,
          ]);
          const oid = createHash("sha1").update(object).digest("hex");
          await writeFile(
            path.join(objects, oid.slice(0, 2), oid.slice(2)),
            deflateSync(object),
          );
        }),
      );
    const calls = vi.spyOn(f.runner, "command"),
      start = performance.now();
    const snapshot = await f.host.readGitWorkspace(f.scope),
      snapshotEnd = performance.now(),
      snapshotCalls = calls.mock.calls.length;
    await f.host.readGitConflict({
      scope: f.scope,
      path: "file.txt",
      revision: snapshot.revision,
    });
    console.info(
      JSON.stringify({
        benchmark: "rebase-read-10000-loose",
        snapshotMs: Math.round(snapshotEnd - start),
        conflictMs: Math.round(performance.now() - snapshotEnd),
        snapshotCalls,
        conflictCalls: calls.mock.calls.length - snapshotCalls,
      }),
    );
  }),
  gitIntegrationBudget(60000),
);

it.each(["operation", "HEAD", "owner", "settings", "catalog"])(
  "discards a read when %s changes while Git is reading",
  fixtureScope.run(async (change) => {
    const f = await fixture();
    const original = f.runner.command.bind(f.runner);
    const settings = await f.host.readProjectSettings(f.project.id);
    let triggered = false;
    vi.spyOn(f.runner, "command").mockImplementation(
      async (exe, args, cwd, env, stdin) => {
        const result = await original(exe, args, cwd, env, stdin);
        if (!triggered && args.includes("status")) {
          triggered = true;
          if (change === "operation")
            await writeFile(
              path.join(f.metadata, "done"),
              (await readFile(path.join(f.metadata, "done"), "utf8")) +
                "# changed\n",
            );
          if (change === "HEAD")
            await writeFile(
              path.join(f.record.gitCommonDir, "HEAD"),
              await readFile(path.join(f.metadata, "orig-head")),
            );
          if (change === "owner")
            await f.manager.store.update(
              { ...f.record, revision: randomUUID() },
              f.record.revision,
            );
          if (change === "settings")
            await f.host.saveProjectSettings(
              f.project.id,
              {
                ...settings.value,
                env: [
                  {
                    key: "TEST_CHANGED",
                    value: "yes",
                    secret: false,
                    runtime: false,
                  },
                ],
              },
              settings.version,
            );
          if (change === "catalog") (f.host as any).catalogEpoch++;
        }
        return result;
      },
    );
    await expect(f.host.readGitWorkspace(f.scope)).rejects.toThrow();
    expect(triggered).toBe(true);
  }),
  gitIntegrationBudget(30000),
);

it(
  "rejects stale/forged owner dimensions, other record states, missing/replaced clone and source without primary fallback",
  fixtureScope.run(async () => {
    const f = await fixture();
    for (const patch of [
      { projectId: "other" },
      { year: "2025" },
      { topic: "other" },
      { branch: "main" },
      { contextId: "ctx-" + "0".repeat(64) },
      { revision: randomUUID() },
    ])
      await expect(
        f.manager.resolveGitRead({ ...f.scope, ...patch }),
      ).rejects.toThrow();
    let row = await f.manager.store.update(
      {
        ...f.record,
        state: "conflict",
        reason: "repository",
        revision: randomUUID(),
      },
      f.record.revision,
    );
    await expect(
      f.manager.resolveGitRead(worktreeContextRef(row)),
    ).rejects.toThrow();
    row = await f.manager.store.update(
      { ...row, state: "conflict", reason: "branch", revision: randomUUID() },
      row.revision,
    );
    const scope = worktreeContextRef(row),
      snapshot = await f.host.readGitWorkspace(scope);
    const sourceBefore = await tree(f.root);
    await rename(f.record.path, f.record.path + "-saved");
    const request = { scope, revision: snapshot.revision, path: "file.txt" };
    await expect(f.host.readGitWorkspace(scope)).rejects.toThrow();
    await expect(f.host.readGitDiff(request)).rejects.toThrow();
    await expect(f.host.readGitConflict(request)).rejects.toThrow();
    await mkdir(f.record.path);
    await expect(f.host.readGitWorkspace(scope)).rejects.toThrow();
    expect(await tree(f.root)).toBe(sourceBefore);
    await rm(f.record.path, { recursive: true });
    await rename(f.record.path + "-saved", f.record.path);
    await rename(f.root, f.root + "-saved");
    await mkdir(f.root);
    await expect(f.manager.resolveGitRead(scope)).rejects.toThrow();
  }),
  gitIntegrationBudget(30000),
);

it(
  "the read-only registry view neither creates missing roots nor changes existing modes/timestamps and rejects lifecycle writes",
  fixtureScope.run(async () => {
    const base = await mkdtemp("/private/tmp/goga-read-only-store-");
    fixtureScope().cleanup(() => rm(base, { recursive: true, force: true }));
    const missing = new CloneStore(path.join(base, "absent-home"), "read-only");
    await expect(missing.read()).rejects.toThrow();
    expect(await readdir(base)).toEqual([]);
    const emptyHome = path.join(base, "empty-home");
    await mkdir(emptyHome);
    await expect(
      new CloneStore(emptyHome, "read-only").read(),
    ).rejects.toThrow();
    expect(await readdir(emptyHome)).toEqual([]);
    const f = await fixture();
    const store = new CloneStore(f.home, "read-only");
    const before = await tree(f.base),
      doc = await store.read();
    await store.assertOwned(f.record);
    await expect(
      store.withRepositoryLock(f.record.repositoryKey, async () => undefined),
    ).rejects.toThrow();
    await expect(
      store.update({ ...f.record, revision: randomUUID() }, f.record.revision),
    ).rejects.toThrow();
    await expect(store.write(doc.revision, doc.records)).rejects.toThrow();
    await expect(store.reserve(f.record)).rejects.toThrow();
    expect(await tree(f.base)).toBe(before);
    await chmod(store.root, 0o755);
    await expect(store.read()).rejects.toThrow();
    expect((await lstat(store.root)).mode & 0o777).toBe(0o755);
  }),
  gitIntegrationBudget(30000),
);
