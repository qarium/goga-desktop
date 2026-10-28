import { chmodSync, writeFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStateStore } from "../src/host/desktop-state";
import * as ownedLocks from "../src/host/owned-lock";
import { withReadScope } from "../src/host/read-scope";
import { gitIntegrationBudget } from "./helpers/git-integration";
import {
  fixture,
  fixtureScope,
  request,
  retainedNativeRecovery,
  tree,
} from "./helpers/rebase-conflict-save-fixture";
describe("detached rebase publication recovery", () => {
  let f: Awaited<ReturnType<typeof fixture>>,
    req: Awaited<ReturnType<typeof request>>,
    token: string;
  beforeEach(
    fixtureScope.run(async () => {
      f = await fixture();
      req = await request(f);
    }),
    gitIntegrationBudget(30000),
  );
  beforeEach(
    fixtureScope.run(async () => {
      token = (
        await f.host.prepareGitConflictSave({
          ...req,
          resolution: { kind: "text", text: "resolved\n" },
        })
      ).token;
    }),
    gitIntegrationBudget(30000),
  );
  it.each([
    ["beforePublishWork", "uncertain", false, false, true],
    ["afterPublishWork", "uncertain", true, false, true],
    ["afterPublishIndex", "uncertain", true, true, true],
  ] as const)(
    "preserves recovery semantics for a race at %s",
    fixtureScope.run(
      async (hook, status, worktreePublished, indexPublished, lockRetained) => {
        const metadata = path.join(f.metadata, "done"),
          old = await readFile(metadata, "utf8");
        const oldWork = await readFile(path.join(f.record.path, "file.txt")),
          oldIndex = await readFile(path.join(f.record.gitCommonDir, "index"));
        (f.host as any).gitConflictActions.options[hook] = () =>
          writeFileSync(metadata, old + "# external change\n");
        const result = await f.host.executeGitConflictSave(token);
        expect(result).toMatchObject({
          status,
          worktreePublished,
          indexPublished,
          lockRetained,
        });
        expect(result.recoveryPath).toBeTruthy();
        await retainedNativeRecovery(f, result, status);
        expect(await readFile(path.join(f.record.path, "file.txt"))).toEqual(
          worktreePublished ? Buffer.from("resolved\n") : oldWork,
        );
        if (!indexPublished)
          expect(
            await readFile(path.join(f.record.gitCommonDir, "index")),
          ).toEqual(oldIndex);
        expect(await readFile(metadata, "utf8")).toBe(
          old + "# external change\n",
        );
        await expect(f.host.executeGitConflictSave(token)).rejects.toThrow();
      },
    ),
    gitIntegrationBudget(45000),
  );
});

describe("lifecycle cleanup preserves completed conflict-save facts", () => {
  const secret = "private-cleanup-fixture-value";
  let f: Awaited<ReturnType<typeof fixture>>,
    req: Awaited<ReturnType<typeof request>>,
    token: string;
  beforeEach(
    fixtureScope.run(async () => {
      f = await fixture("merge", 1);
      const store = new DesktopStateStore(f.home, path.join(f.base, "data")),
        settings = await store.read(f.project.id);
      await store.save(
        f.project.id,
        {
          ...settings.value,
          env: [
            {
              key: "CLEANUP_SECRET",
              value: secret,
              secret: true,
              runtime: false,
            },
          ],
        },
        settings.version,
      );
      req = await request(f);
    }),
    gitIntegrationBudget(30000),
  );
  beforeEach(
    fixtureScope.run(async () => {
      token = (
        await f.host.prepareGitConflictSave({
          ...req,
          resolution: { kind: "text", text: "saved before cleanup\n" },
        })
      ).token;
    }),
    gitIntegrationBudget(30000),
  );
  function failAfterRelease(after?: () => void) {
    const acquire = ownedLocks.acquireOwnedLock;
    let releases = 0;
    vi.spyOn(ownedLocks, "acquireOwnedLock").mockImplementation(
      async (file, options) => {
        const lock = await acquire(file, options);
        if (!path.basename(file).startsWith(".repository-")) return lock;
        return {
          release: async () => {
            await lock.release();
            releases++;
            after?.();
            // Unlink may succeed before a subsequent directory fsync fails.
            throw Error(`CLEANUP_FAILED ${secret}`);
          },
        };
      },
    );
    return () => releases;
  }
  it(
    "retains uncertain native recovery and exact publication facts after EACCES releasing the lifecycle lock",
    fixtureScope.run(async () => {
      const index = await readFile(path.join(f.record.gitCommonDir, "index"));
      (f.host as any).gitConflictActions.options.afterPublishWork = () =>
        chmodSync(f.manager.store.root, 0o500);
      try {
        const result = await f.host.executeGitConflictSave(token);
        expect(result).toMatchObject({
          status: "uncertain",
          worktreePublished: true,
          indexPublished: false,
          lockRetained: true,
        });
        expect(result.recoveryPath).toBeTruthy();
        expect(result.log).toMatch(/блокировки/);
        expect(
          await readFile(path.join(f.record.path, "file.txt"), "utf8"),
        ).toBe("saved before cleanup\n");
        expect(
          await readFile(path.join(f.record.gitCommonDir, "index")),
        ).toEqual(index);
        await retainedNativeRecovery(f, result, "uncertain");
        await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
          /использовано/,
        );
      } finally {
        chmodSync(f.manager.store.root, 0o700);
      }
    }),
    gitIntegrationBudget(45000),
  );
  it(
    "downgrades saved to uncertain after lifecycle cleanup failure and retains the native write fence",
    fixtureScope.run(async () => {
      const releases = failAfterRelease();
      const result = await f.host.executeGitConflictSave(token);
      expect(result).toMatchObject({
        status: "uncertain",
        worktreePublished: true,
        indexPublished: true,
        lockRetained: true,
      });
      expect(result.recoveryPath).toBeTruthy();
      expect(result.log).toMatch(/блокировки/);
      expect(result.log).toContain("CLEANUP_FAILED");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
        "saved before cleanup\n",
      );
      await expect(
        lstat(
          path.join(
            f.manager.store.root,
            `.repository-${f.record.repositoryKey}.lock`,
          ),
        ),
      ).rejects.toThrow();
      await retainedNativeRecovery(f, result, "completed");
      await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
        /использовано/,
      );
      expect(releases()).toBe(1);
    }),
    gitIntegrationBudget(45000),
  );
  it(
    "preserves no-publication facts and both diagnostics without retry after native and lifecycle failures",
    fixtureScope.run(async () => {
      const releases = failAfterRelease(),
        work = await readFile(path.join(f.record.path, "file.txt")),
        index = await readFile(path.join(f.record.gitCommonDir, "index"));
      (f.host as any).gitConflictActions.options.beforePublishWork = () => {
        throw Error(`ACTION_FAILED ${secret}`);
      };
      const result = await f.host.executeGitConflictSave(token);
      expect(result).toMatchObject({
        status: "uncertain",
        worktreePublished: false,
        indexPublished: false,
        lockRetained: true,
      });
      // The prepared native transport deliberately replaces callback exceptions
      // with its safe verification failure; the lifecycle diagnostic stays visible.
      expect(result.log).toContain("verification");
      expect(result.log).toContain("CLEANUP_FAILED");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.recoveryPath).toBeTruthy();
      expect(await readFile(path.join(f.record.path, "file.txt"))).toEqual(
        work,
      );
      expect(await readFile(path.join(f.record.gitCommonDir, "index"))).toEqual(
        index,
      );
      await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
        /использовано/,
      );
      expect(releases()).toBe(1);
    }),
    gitIntegrationBudget(45000),
  );
  it(
    "rejects canceled prepare after cleanup failure instead of issuing an apparently successful preview",
    fixtureScope.run(async () => {
      const controller = new AbortController();
      const releases = failAfterRelease(() => controller.abort()),
        before = await tree(f.record.path);
      const error = await withReadScope(controller.signal, () =>
        f.host.prepareGitConflictSave({
          ...req,
          resolution: { kind: "current" },
        }),
      ).then(
        () => {
          throw Error("unexpected preview");
        },
        (e: Error) => e,
      );
      expect(error.message).toContain("CLEANUP_FAILED");
      expect(error.message).not.toContain(secret);
      expect(await tree(f.record.path)).toBe(before);
      expect(releases()).toBe(1);
    }),
    gitIntegrationBudget(45000),
  );
  it(
    "preserves and redacts action and cleanup errors when execute failed before producing a result",
    fixtureScope.run(async () => {
      const releases = failAfterRelease(),
        before = await tree(f.record.path),
        command = f.runner.command.bind(f.runner);
      vi.spyOn(f.runner, "command").mockImplementation(
        (exe, args, cwd, env, stdin) => {
          if (args.includes("check-attr"))
            throw Error(`ACTION_FAILED ${secret}`);
          return command(exe, args, cwd, env, stdin);
        },
      );
      const error = await f.host.executeGitConflictSave(token).then(
        () => {
          throw Error("unexpected result");
        },
        (e: Error) => e,
      );
      expect(error.message).toContain("ACTION_FAILED");
      expect(error.message).toContain("CLEANUP_FAILED");
      expect(error.message).not.toContain(secret);
      expect(await tree(f.record.path)).toBe(before);
      await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
        /использовано/,
      );
      expect(releases()).toBe(1);
    }),
    gitIntegrationBudget(45000),
  );
});
