import { chmod, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CloneStore } from "../src/host/clone-store";
import { gitIntegrationBudget } from "./helpers/git-integration";
import {
  changeFixture,
  fixture,
  fixtureScope,
  races,
  request,
  tree,
} from "./helpers/rebase-conflict-save-fixture";
it.each(races)(
  "rejects %s changes between prepare and execute without publication",
  fixtureScope.run(async (change) => {
    const f = await fixture(),
      req = await request(f);
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "incoming" },
    });
    await changeFixture(f, change);
    const clone = await tree(f.record.path),
      source = await tree(f.root);
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
    expect(await tree(f.record.path)).toBe(clone);
    expect(await tree(f.root)).toBe(source);
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(45000),
);

it.each(["settings", "revision", "operation", "remote", "source topology"])(
  "rejects a late %s race during native pre-publication verification",
  fixtureScope.run(async (change) => {
    const f = await fixture(),
      req = await request(f);
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "current" },
    });
    const beforeIndex = await readFile(
        path.join(f.record.gitCommonDir, "index"),
      ),
      beforeWork = await readFile(path.join(f.record.path, "file.txt"));
    // The old --git-path text probe now runs only in final owner validation.
    // Inject at the native byte transport's first read instead: same safety
    // invariant (race during preparation, before any publication), new seam.
    const original = f.runner.commandBytes.bind(f.runner);
    let triggered = false;
    vi.spyOn(f.runner, "commandBytes").mockImplementation(async (command) => {
      const result = await original(command);
      if (!triggered && command.args.includes("rev-parse")) {
        triggered = true;
        await changeFixture(f, change);
      }
      return result;
    });
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
    expect(triggered).toBe(true);
    expect(await readFile(path.join(f.record.gitCommonDir, "index"))).toEqual(
      beforeIndex,
    );
    expect(await readFile(path.join(f.record.path, "file.txt"))).toEqual(
      beforeWork,
    );
  }),
  gitIntegrationBudget(45000),
);

it.each(["clones", "desktop"])(
  "never repairs %s root permissions between admission and lifecycle lock",
  fixtureScope.run(async (which) => {
    const f = await fixture(),
      req = await request(f);
    const target =
      which === "clones"
        ? f.manager.store.root
        : path.dirname(f.manager.store.root);
    const before = await tree(f.record.path),
      original = CloneStore.prototype.withRepositoryLock;
    let triggered = false;
    vi.spyOn(CloneStore.prototype, "withRepositoryLock").mockImplementation(
      async function (this: CloneStore, key, fn, ...rest) {
        if (!triggered && this.root === f.manager.store.root) {
          triggered = true;
          await chmod(target, 0o755);
        }
        return original.call(this, key, fn, ...rest);
      },
    );
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "current" },
      }),
    ).rejects.toThrow();
    expect(triggered).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    expect(await tree(f.record.path)).toBe(before);
  }),
  gitIntegrationBudget(45000),
);
