import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  access,
  symlink,
  readFile,
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

it("explicit whole-copy consent moves modified, ignored, untracked and ahead data together, without walking it", async () => {
  const f = await fixture();
  await f.git(["commit", "--allow-empty", "-m", "copy-only"], f.row.path);
  await writeFile(path.join(f.row.path, ".gitignore"), "ignored\n");
  await writeFile(path.join(f.row.path, "tracked"), "one");
  await f.git(["add", ".gitignore", "tracked"], f.row.path);
  await f.git(["commit", "-m", "tracked"], f.row.path);
  await writeFile(path.join(f.row.path, "tracked"), "two");
  await writeFile(path.join(f.row.path, "ignored"), "ignored");
  await writeFile(path.join(f.row.path, "untracked"), "new");
  const outside = path.join(f.root, "elsewhere");
  await writeFile(outside, "not part of the copy");
  await symlink(outside, path.join(f.row.path, "link"));
  const blocked = vi.spyOn(f.runner, "command");
  const baseline = await f.manager.captureWholeCopyIdentity(f.ref);
  await expect(
    f.manager.prepareContextCleanup(
      f.ref,
      { active: false, current: false },
      baseline,
      true,
    ),
  ).rejects.toThrow();
  await f.git(["branch", "-D", "alpha"]);
  const plan = await f.manager.prepareContextCleanup(
    f.ref,
    { active: false, current: false },
    baseline,
    true,
  );
  expect(plan).toMatchObject({ schemaVersion: 4, flow: "clone-after-topic" });
  const trash = vi.fn(async (dir: string) =>
    rename(dir, path.join(f.root, "trash")),
  );
  const callbacks = { beforeTrash: async () => {}, trashItem: trash };
  await expect(
    f.manager.trashContext(
      plan.token,
      { active: true, current: false },
      callbacks,
    ),
  ).rejects.toThrow();
  expect(trash).not.toHaveBeenCalled();
  await writeFile(path.join(f.row.path, "late"), "part of this copy too");
  const restart = new CloneManager(f.home, f.runner);
  expect(
    (
      await restart.trashContext(
        plan.token,
        { active: false, current: true },
        callbacks,
      )
    ).cloneRemoved,
  ).toBe(true);
  const remove = vi.fn(async () => {});
  expect((await restart.finishContextDeletion(plan.token, remove)).status).toBe(
    "success",
  );
  await restart.trashContext(
    plan.token,
    { active: false, current: false },
    callbacks,
  );
  expect(trash).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(await readFile(outside, "utf8")).toBe("not part of the copy");
  expect(await readFile(path.join(f.root, "trash", "late"), "utf8")).toBe(
    "part of this copy too",
  );
  expect(
    blocked.mock.calls.some(([, args]) =>
      args.some((arg) =>
        ["rev-list", "reflog", "status", "ls-files"].includes(arg),
      ),
    ),
  ).toBe(false);
});
it("does not move a substitute at the selected whole-copy path", async () => {
  const f = await fixture();
  const baseline = await f.manager.captureWholeCopyIdentity(f.ref);
  await f.git(["branch", "-D", "alpha"]);
  const plan = await f.manager.prepareContextCleanup(
    f.ref,
    { active: false, current: false },
    baseline,
    true,
  );
  await rename(f.row.path, f.row.path + ".original");
  await symlink(f.row.path + ".original", f.row.path);
  const trash = vi.fn(async () => {});
  await expect(
    f.manager.trashContext(
      plan.token,
      { active: false, current: false },
      { beforeTrash: async () => {}, trashItem: trash },
    ),
  ).rejects.toThrow();
  expect(trash).not.toHaveBeenCalled();
  await expect(access(f.row.path + ".original/.git")).resolves.toBeUndefined();
});

it("whole-copy consent does not break a separate registered Git worktree", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "other-worktree");
  await f.git(["worktree", "add", "-b", "independent", outside], f.row.path);
  await expect(f.manager.captureWholeCopyIdentity(f.ref)).rejects.toThrow(
    outside,
  );
  expect(await f.git(["branch", "--show-current"], outside)).toBe(
    "independent",
  );
});
it("missing unlocked worktrees do not block whole-copy cleanup or require pruning", async () => {
  const f = await fixture(),
    outside = path.join(f.root, "old-temporary-worktree");
  await f.git(["worktree", "add", "--detach", outside], f.row.path);
  await rm(outside, { recursive: true });
  const baseline = await f.manager.captureWholeCopyIdentity(f.ref);
  // Preparation is read-only: the stale registration remains until the clone
  // itself is moved to Trash after successful topic removal.
  expect(
    await readFile(
      path.join(
        f.row.gitCommonDir,
        "worktrees",
        "old-temporary-worktree",
        "gitdir",
      ),
      "utf8",
    ),
  ).toContain(outside);
  await f.git(["branch", "-D", "alpha"]);
  const plan = await f.manager.prepareContextCleanup(
    f.ref,
    { active: false, current: false },
    baseline,
    true,
  );
  const trash = vi.fn(async (p: string) =>
    rename(p, path.join(f.root, "trash")),
  );
  const result = await f.manager.trashContext(
    plan.token,
    { active: false, current: false },
    { beforeTrash: async () => {}, trashItem: trash },
  );
  expect(result.cloneRemoved).toBe(true);
  expect(trash).toHaveBeenCalledOnce();
});
it("missing locked worktrees are retained instead of treating an offline folder as stale", async () => {
  const f = await fixture(),
    outside = path.join(f.root, "offline-worktree");
  await f.git(["worktree", "add", "--detach", outside], f.row.path);
  await f.git(["worktree", "lock", outside], f.row.path);
  await rm(outside, { recursive: true });
  await expect(f.manager.captureWholeCopyIdentity(f.ref)).rejects.toThrow();
});
it("a surviving folder is protected even when its worktree git file was removed", async () => {
  const f = await fixture(),
    outside = path.join(f.root, "valuable-worktree");
  await f.git(["worktree", "add", "--detach", outside], f.row.path);
  await rm(path.join(outside, ".git"));
  await writeFile(path.join(outside, "valuable.txt"), "keep");
  await expect(f.manager.captureWholeCopyIdentity(f.ref)).rejects.toThrow();
  expect(await readFile(path.join(outside, "valuable.txt"), "utf8")).toBe(
    "keep",
  );
});
it("a missing worktree restored after confirmation prevents trashing its common git dir", async () => {
  const f = await fixture(),
    outside = path.join(f.root, "restored-worktree");
  await f.git(["worktree", "add", "--detach", outside], f.row.path);
  await rm(outside, { recursive: true });
  const baseline = await f.manager.captureWholeCopyIdentity(f.ref);
  await f.git(["branch", "-D", "alpha"]);
  const plan = await f.manager.prepareContextCleanup(
    f.ref,
    { active: false, current: false },
    baseline,
    true,
  );
  await mkdir(outside);
  const trash = vi.fn(async () => {});
  await expect(
    f.manager.trashContext(
      plan.token,
      { active: false, current: false },
      { beforeTrash: async () => {}, trashItem: trash },
    ),
  ).rejects.toThrow();
  expect(trash).not.toHaveBeenCalled();
});
it("rejects consent when the managed git dir addresses an outside worktree", async () => {
  const f = await fixture(),
    outside = path.join(f.root, "outside");
  await mkdir(outside);
  await f.git(["config", "core.worktree", outside], f.row.path);
  await expect(f.manager.captureWholeCopyIdentity(f.ref)).rejects.toThrow();
});
