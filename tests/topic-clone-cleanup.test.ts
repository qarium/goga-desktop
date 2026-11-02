import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  access,
} from "node:fs/promises";
import path from "node:path";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp("/private/tmp/goga-topic-cleanup-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    repo = path.join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  const runner = new NodeRunner();
  cleanups.push(() => runner.dispose());
  const env = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: string[], cwd = repo) =>
    runner
      .command("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd, env)
      .then((r) => r.stdout.trim());
  await git(["init", "-b", "main"]);
  await git(["commit", "--allow-empty", "-m", "initial"]);
  await git(["branch", "alpha"]);
  const manager = new CloneManager(home, runner),
    project = { id: "p", path: repo, name: "Fixture" };
  const row = await manager.ensure(project, {
      projectId: "p",
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    }),
    ref = worktreeContextRef(row);
  return { root, repo, home, runner, git, manager, row, ref };
}
it("prepares cleanup only after branch deletion, preserving pre-delete ahead baseline", async () => {
  const f = await fixture(),
    baseline = await f.manager.captureRemovalBaseline(f.ref);
  await expect(
    f.manager.prepareContextCleanup(
      f.ref,
      { active: false, current: false },
      baseline,
    ),
  ).rejects.toThrow();
  await f.git(["branch", "-D", "alpha"]);
  const plan = await f.manager.prepareContextCleanup(
    f.ref,
    { active: false, current: false },
    baseline,
  );
  expect(plan.schemaVersion).toBe(3);
  expect(plan.flow).toBe("clone-after-topic");
  expect(plan.aheadCount).toBe(0);
  const trash = vi.fn(async (p: string) =>
    rename(p, path.join(f.root, "trash")),
  );
  const r = await f.manager.trashContext(
    plan.token,
    { active: false, current: false },
    { beforeTrash: async () => {}, trashItem: trash },
  );
  expect(r.cloneRemoved).toBe(true);
  const removeTopic = vi.fn(async () => {
    throw Error("must not repeat Goga");
  });
  const finished = await f.manager.finishContextDeletion(
    plan.token,
    removeTopic,
  );
  expect(finished.status).toBe("success");
  expect(removeTopic).not.toHaveBeenCalled();
  expect(trash).toHaveBeenCalledTimes(1);
  await expect(
    access(path.join(f.root, "trash", ".git")),
  ).resolves.toBeUndefined();
});
it("retains a copy whose files changed after the native deletion", async () => {
  const f = await fixture(),
    baseline = await f.manager.captureRemovalBaseline(f.ref);
  await f.git(["branch", "-D", "alpha"]);
  await writeFile(path.join(f.row.path, "valuable.txt"), "keep");
  await expect(
    f.manager.prepareContextCleanup(
      f.ref,
      { active: false, current: false },
      baseline,
    ),
  ).rejects.toThrow();
  await expect(
    access(path.join(f.row.path, "valuable.txt")),
  ).resolves.toBeUndefined();
});
it("retains ahead confirmation instead of granting deletion of unique commits", async () => {
  const f = await fixture();
  await f.git(["commit", "--allow-empty", "-m", "unique"], f.row.path);
  const baseline = await f.manager.captureRemovalBaseline(f.ref);
  expect(baseline.aheadCount).toBe(1);
  await f.git(["branch", "-D", "alpha"]);
  const plan = await f.manager.prepareContextCleanup(
    f.ref,
    { active: false, current: false },
    baseline,
  );
  const trash = vi.fn(async () => {});
  await expect(
    f.manager.trashContext(
      plan.token,
      { active: false, current: false },
      { beforeTrash: async () => {}, trashItem: trash },
    ),
  ).rejects.toThrow(/коммит|подтверд/i);
  expect(trash).not.toHaveBeenCalled();
});
it("cannot prepare or trash an active context", async () => {
  const f = await fixture(),
    baseline = await f.manager.captureRemovalBaseline(f.ref);
  await f.git(["branch", "-D", "alpha"]);
  await expect(
    f.manager.prepareContextCleanup(
      f.ref,
      { active: true, current: false },
      baseline,
    ),
  ).rejects.toThrow(/актив/i);
});
