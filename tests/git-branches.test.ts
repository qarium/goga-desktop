import { createNativeGitCapability } from "../src/host/git-native-context";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { NodeRunner } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import {
  GitBranchActions,
  type GitBranchContext,
} from "../src/host/git-branches";
import type { GitBranchRequest } from "../src/shared/git-branches";
vi.setConfig({ testTimeout: 30000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(unborn = false) {
  const dir = await fs.mkdtemp("/private/tmp/goga-branches-");
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = new NodeRunner(15000, env);
  cleanup.push(() => runner.dispose());
  const git = (args: string[], cwd = root) =>
    runner.command(
      "git",
      ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
      cwd,
      env,
    );
  const write = (name: string, text: string) =>
    fs.writeFile(path.join(root, name), text);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  if (!unborn) {
    await write("base", "base\n");
    await git(["add", "."]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "base"]);
  }
  let ownerKey = "owner",
    now = 1000,
    intercept: ((args: string[], online: boolean) => Promise<void>) | undefined;
  const calls: { args: string[]; online: boolean }[] = [];
  const reader = new GitWorkspaceReader({
    root,
    scope: "project",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  const ctx: GitBranchContext = {
    native: createNativeGitCapability({
      root,
      env,
      journal: new NativeGitJournal({
        directory: path.join(dir, "journal"),
        now: () => now,
      }),
      owner: async () => ({
        scope: "project",
        registryRevision: ownerKey,
        projectPath: root,
      }),
      runner: {
        commandBytes: async (command) => {
          const args = [...command.args];
          calls.push({ args, online: command.args.includes("fetch") });
          await intercept?.(args, command.args.includes("fetch"));
          return runner.commandBytes(command);
        },
      },
    }),

    scope: "project",
    root,
    ownerKey,
    verify: async () => {},
    snapshot: () => reader.snapshot(),
    git: async (args) => {
      calls.push({ args, online: false });
      await intercept?.(args, false);
      return git(args);
    },
    remoteGit: async (args) => {
      calls.push({ args, online: true });
      await intercept?.(args, true);
      return git(args);
    },
  };
  const actions = new GitBranchActions({
    context: async (_id, fn) => fn({ ...ctx, ownerKey }),
    now: () => now,
  });
  const prepare = async (
    request:
      | Omit<
          Extract<GitBranchRequest, { action: "create" }>,
          "projectId" | "revision"
        >
      | Omit<
          Exclude<GitBranchRequest, { action: "create" }>,
          "projectId" | "revision"
        >,
  ) =>
    actions.prepare({
      ...request,
      projectId: "project",
      revision: (await actions.inventory("project")).revision,
    } as GitBranchRequest);
  const head = async () => (await git(["rev-parse", "HEAD"])).stdout.trim();
  const remote = async () => {
    const target = path.join(dir, "remote.git");
    await fs.mkdir(target);
    await git(["init", "--bare"], target);
    await git(["remote", "add", "origin", target]);
    await git(["push", "origin", "main"]);
    await git(["fetch", "origin"]);
    return target;
  };
  return {
    dir,
    root,
    git,
    write,
    reader,
    ctx,
    actions,
    prepare,
    head,
    remote,
    calls,
    setOwner: (v: string) => {
      ownerKey = v;
    },
    setNow: (v: number) => {
      now = v;
    },
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}
describe("primary Git branches", () => {
  it("lists exact local and remote refs separately, excludes symbolic HEAD, supports unborn and detached", async () => {
    const f = await fixture();
    await f.git(["update-ref", "refs/remotes/origin/main", await f.head()]);
    await f.git([
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    const inventory = await f.actions.inventory("project");
    expect(inventory.local).toEqual([
      expect.objectContaining({
        ref: "refs/heads/main",
        name: "main",
        oid: await f.head(),
      }),
    ]);
    expect(inventory.remote.map((r) => r.ref)).toEqual([
      "refs/remotes/origin/main",
    ]);
    await f.git(["checkout", "--detach"]);
    expect((await f.actions.inventory("project")).branch).toBeNull();
    const u = await fixture(true);
    expect(await u.actions.inventory("project")).toMatchObject({
      head: null,
      branch: "main",
      local: [],
    });
  });
  it("creates at captured HEAD without switching a dirty working copy", async () => {
    const f = await fixture();
    await f.write("new", "dirty");
    const h = await f.head();
    const p = await f.prepare({
      action: "create",
      name: "feature/a",
      switch: false,
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
      changed: true,
    });
    expect(
      (await f.git(["rev-parse", "refs/heads/feature/a"])).stdout.trim(),
    ).toBe(h);
    expect((await f.reader.snapshot()).branch).toBe("main");
    expect(await fs.readFile(path.join(f.root, "new"), "utf8")).toBe("dirty");
  });
  it("switches local branches without hooks and keeps selected exact target protected by native ref lock", async () => {
    const f = await fixture();
    await f.git(["branch", "other"]);
    const marker = path.join(f.dir, "hook-ran");
    await fs.writeFile(
      path.join(f.root, ".git/hooks/post-checkout"),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o755 },
    );
    let locked = false;
    f.intercept(async (args) => {
      if (args.includes("switch"))
        locked = await fs
          .stat(path.join(f.root, ".git/refs/heads/other.lock"))
          .then(
            () => true,
            () => false,
          );
    });
    const p = await f.prepare({
      action: "switch-local",
      ref: "refs/heads/other",
    } as any);
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(locked).toBe(true);
    expect((await f.reader.snapshot()).branch).toBe("other");
    await expect(fs.stat(marker)).rejects.toThrow();
  });
  it("refuses dirty checkouts but not branch creation and rejects invalid names with Git", async () => {
    const f = await fixture();
    await f.git(["branch", "other"]);
    await f.write("new", "dirty");
    await expect(
      f.prepare({ action: "switch-local", ref: "refs/heads/other" } as any),
    ).rejects.toThrow(/изменен|изменён|чист/i);
    await expect(
      f.prepare({ action: "create", name: "bad..name", switch: false }),
    ).rejects.toThrow();
  });
  it("consumes one-use tokens and rejects newly dirty, stale HEAD, owner, target, config, expiry and forged topic contexts", async () => {
    const f = await fixture();
    await f.git(["branch", "other"]);
    const p = await f.prepare({
      action: "switch-local",
      ref: "refs/heads/other",
    } as any);
    await f.write("new", "dirty");
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    await expect(f.actions.execute(p.token)).rejects.toThrow();
    await fs.rm(path.join(f.root, "new"));
    const expired = await f.prepare({
      action: "create",
      name: "expired",
      switch: false,
    });
    f.setNow(301001);
    await expect(f.actions.execute(expired.token)).rejects.toThrow();
    f.setNow(1000);
    const owner = await f.prepare({
      action: "create",
      name: "owned",
      switch: false,
    });
    f.setOwner("other");
    expect(await f.actions.execute(owner.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    f.setOwner("owner");
    const config = await f.prepare({
      action: "create",
      name: "config",
      switch: false,
    });
    await f.git(["config", "test.changed", "yes"]);
    expect(await f.actions.execute(config.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    const head = await f.prepare({
      action: "create",
      name: "oldhead",
      switch: false,
    });
    await f.git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "advance",
    ]);
    expect(await f.actions.execute(head.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    await expect(
      f.actions.inventory({ projectId: "project" } as any),
    ).rejects.toThrow();
    f.ctx.scope = { projectId: "project" } as any;
    await expect(f.actions.inventory("project")).rejects.toThrow();
  });
});
describe("branch remote operations and safety", () => {
  it("fetches origin explicitly without checkout, pruning, force, tags or FETCH_HEAD replacement", async () => {
    const f = await fixture();
    await f.remote();
    await f.git(["update-ref", "refs/remotes/origin/kept", await f.head()]);
    await fs.writeFile(path.join(f.root, ".git/FETCH_HEAD"), "sentinel\n");
    await f.write("dirty", "preserved");
    const before = await fs.readFile(path.join(f.root, ".git/index")),
      head = await f.head();
    const p = await f.prepare({ action: "fetch" });
    expect(p.remote).toBe("origin");
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(await f.head()).toBe(head);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(before);
    expect(await fs.readFile(path.join(f.root, "dirty"), "utf8")).toBe(
      "preserved",
    );
    expect(
      await fs.readFile(path.join(f.root, ".git/FETCH_HEAD"), "utf8"),
    ).toBe("sentinel\n");
    expect(
      (await f.actions.inventory("project")).remote.map((r) => r.name),
    ).toContain("origin/kept");
    const args = f.calls.find((c) => c.online)!.args;
    expect(args).toEqual(
      expect.arrayContaining([
        "fetch",
        "--no-tags",
        "--no-prune",
        "--no-write-fetch-head",
      ]),
    );
    expect(args).not.toContain("--force");
    expect(args.some((a) => a.startsWith("+refs/"))).toBe(false);
  });
  it("creates a tracking local branch from the selected remote OID and refuses local collisions", async () => {
    const f = await fixture();
    await f.remote();
    await f.git(["update-ref", "refs/remotes/origin/feature", await f.head()]);
    const p = await f.prepare({
      action: "switch-remote",
      ref: "refs/remotes/origin/feature",
    } as any);
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect((await f.reader.snapshot()).branch).toBe("feature");
    expect(
      (await f.git(["config", "branch.feature.remote"])).stdout.trim(),
    ).toBe("origin");
    expect(
      (await f.git(["config", "branch.feature.merge"])).stdout.trim(),
    ).toBe("refs/heads/feature");
    await expect(
      f.prepare({
        action: "switch-remote",
        ref: "refs/remotes/origin/main",
      } as any),
    ).rejects.toThrow(/локальн/i);
  });
  it("rejects stale remote endpoint/target and ambiguous refspec mapping without a network call", async () => {
    const f = await fixture();
    await f.remote();
    const p = await f.prepare({ action: "fetch" });
    await f.git([
      "remote",
      "set-url",
      "origin",
      path.join(f.dir, "replacement.git"),
    ]);
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(f.calls.filter((c) => c.online)).toHaveLength(0);
    await f.git([
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/custom/*",
    ]);
    await expect(f.prepare({ action: "fetch" })).rejects.toThrow(
      /refspec|неоднознач/i,
    );
    await f.git([
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    await f.git(["branch", "other"]);
    const target = await f.prepare({
      action: "switch-local",
      ref: "refs/heads/other",
    } as any);
    await f.git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "advance",
    ]);
    await f.git(["branch", "-f", "other", "HEAD"]);
    expect(await f.actions.execute(target.token)).toMatchObject({
      status: "error",
      changed: false,
    });
  });
  it("pull fetches configured upstream freshly, allows nonoverlap dirt and fast-forwards only", async () => {
    const f = await fixture();
    const remote = await f.remote();
    await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
    const contributor = path.join(f.dir, "contributor");
    await f.git(["clone", "--branch", "main", remote, contributor]);
    await f.git(["config", "user.name", "Fixture"], contributor);
    await f.git(
      ["config", "user.email", "fixture@example.invalid"],
      contributor,
    );
    await fs.writeFile(path.join(contributor, "incoming"), "remote\n");
    await f.git(["add", "."], contributor);
    await f.git(
      ["-c", "core.hooksPath=/dev/null", "commit", "-m", "remote"],
      contributor,
    );
    await f.git(["push", "origin", "main"], contributor);
    await f.write("local-only", "dirty");
    const p = await f.prepare({ action: "pull" });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(await fs.readFile(path.join(f.root, "local-only"), "utf8")).toBe(
      "dirty",
    );
    expect(await fs.readFile(path.join(f.root, "incoming"), "utf8")).toBe(
      "remote\n",
    );
    await f.git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "ahead",
    ]);
    const ahead = await f.head();
    const aheadP = await f.prepare({ action: "pull" });
    expect(await f.actions.execute(aheadP.token)).toMatchObject({
      status: "success",
    });
    expect(await f.head()).toBe(ahead);
    await f.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        "divergence",
      ],
      contributor,
    );
    await f.git(["push", "origin", "main"], contributor);
    const diverged = await f.prepare({ action: "pull" });
    const result = await f.actions.execute(diverged.token);
    expect(result.status).not.toBe("success");
    expect(await f.head()).toBe(ahead);
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(result.changed).toBe(true);
  });
  it("blocks ongoing operations, external filters, occupied worktrees and hardlinked metadata", async () => {
    const f = await fixture();
    await f.git(["branch", "other"]);
    const worktree = path.join(f.dir, "other");
    await f.git(["worktree", "add", worktree, "other"]);
    await expect(
      f.prepare({ action: "switch-local", ref: "refs/heads/other" } as any),
    ).rejects.toThrow(/другой рабочей копии/);
    await f.git(["config", "filter.bad.smudge", "touch /not-executed"]);
    await expect(
      f.prepare({ action: "create", name: "filtered", switch: true }),
    ).rejects.toThrow(/фильтр/);
    await fs.writeFile(
      path.join(f.root, ".git/MERGE_HEAD"),
      (await f.head()) + "\n",
    );
    await expect(
      f.prepare({ action: "create", name: "blocked", switch: false }),
    ).rejects.toThrow(/операцию Git/);
    await fs.rm(path.join(f.root, ".git/MERGE_HEAD"));
    await fs.link(path.join(f.root, ".git/config"), path.join(f.dir, "linked"));
    await expect(
      f.prepare({ action: "create", name: "unsafe", switch: false }),
    ).rejects.toThrow(/метаданн/);
  });
  it("reports a lost result after native create-and-switch honestly and consumes token", async () => {
    const f = await fixture();
    const p = await f.prepare({
      action: "create",
      name: "partial",
      switch: true,
    });
    f.intercept(async (args) => {
      if (args.includes("switch")) {
        await f.git(args); // Native command completed, then transport lost its result.
        throw Error("simulated lost native result");
      }
    });
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({ status: "uncertain", changed: true });
    expect(
      (await f.git(["rev-parse", "refs/heads/partial"])).stdout.trim(),
    ).toBe(await f.head());
    expect((await f.reader.snapshot()).branch).toBe("partial");
    await expect(f.actions.execute(p.token)).rejects.toThrow();
  });
});
describe("branch mutation boundary regressions", () => {
  it("uses the captured target while a cooperative competing ref writer is blocked", async () => {
    const f = await fixture();
    const selected = await f.head();
    await f.git(["branch", "selected"]);
    await f.git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "new head",
    ]);
    const newer = await f.head();
    const p = await f.prepare({
      action: "switch-local",
      ref: "refs/heads/selected",
    } as any);
    let blocked = false;
    f.intercept(async (args) => {
      if (args.includes("switch")) {
        try {
          await f.git(["update-ref", "refs/heads/selected", newer, selected]);
        } catch {
          blocked = true;
        }
      }
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(blocked).toBe(true);
    expect(await f.head()).toBe(selected);
  });
  it("rejects creation in an unborn repository and creates from detached HEAD", async () => {
    const u = await fixture(true);
    await expect(
      u.prepare({ action: "create", name: "new", switch: false }),
    ).rejects.toThrow(/первый коммит/);
    const f = await fixture();
    await f.git(["checkout", "--detach"]);
    const p = await f.prepare({
      action: "create",
      name: "detached-copy",
      switch: true,
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect((await f.reader.snapshot()).branch).toBe("detached-copy");
  });
  it("never silently ignores tracked assume-unchanged or sparse index flags during checkout", async () => {
    const f = await fixture();
    await f.git(["branch", "other"]);
    await f.git(["update-index", "--assume-unchanged", "base"]);
    await f.write("base", "hidden dirty\n");
    await expect(
      f.prepare({ action: "switch-local", ref: "refs/heads/other" } as any),
    ).rejects.toThrow(/индекс|скрыт|sparse/i);
  });
  it("refuses unexpected remote transport helpers and disables repository fetch options", async () => {
    const f = await fixture();
    await f.remote();
    await f.git(["config", "remote.origin.url", "ext::not-permitted"]);
    await expect(f.prepare({ action: "fetch" })).rejects.toThrow(/адрес/);
    expect(f.calls.filter((c) => c.online)).toHaveLength(0);
    await f.git([
      "config",
      "remote.origin.url",
      path.join(f.dir, "remote.git"),
    ]);
    await f.git(["config", "fetch.prune", "true"]);
    await f.git(["config", "fetch.pruneTags", "true"]);
    await f.git(["config", "fetch.recurseSubmodules", "true"]);
    const p = await f.prepare({ action: "fetch" });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    const args = f.calls.find((c) => c.online)!.args;
    expect(args).toContain("fetch.pruneTags=false");
    expect(args).toContain("--no-recurse-submodules");
  });
  it("revalidates the worktree after fetch before fast-forwarding and redacts remote endpoint logs", async () => {
    const f = await fixture();
    await f.remote();
    await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
    const p = await f.prepare({ action: "pull" });
    f.intercept(async (_args, online) => {
      if (online) await f.write("new-arrival", "external");
    });
    const before = await f.head();
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "uncertain",
      changed: true,
    });
    expect(await f.head()).toBe(before);
    expect(f.calls.some((c) => c.args.includes("merge"))).toBe(false);
    f.intercept(undefined);
    expect(await fs.readFile(path.join(f.root, "new-arrival"), "utf8")).toBe(
      "external",
    );
    await expect(f.prepare({ action: "fetch" })).rejects.toThrow(/Журнал/);
    // Redaction is a separate scenario: an uncertain repository must not be
    // made writable again just to test a second transport failure.
    const redaction = await fixture();
    await redaction.remote();
    await redaction.git([
      "remote",
      "set-url",
      "origin",
      "https://user:password@example.invalid/repo?token=secret",
    ]);
    const q = await redaction.prepare({ action: "fetch" });
    redaction.intercept(async (args, online) => {
      if (online) throw Error(`fetch failed ${args.at(-2)}`);
    });
    const result = await redaction.actions.execute(q.token);
    expect(result.log).not.toContain("password");
    expect(result.log).not.toContain("secret");
    expect(result.message).not.toContain("password");
  });
  it("fails closed on symlinked metadata and existing native locks without removing them", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.root, ".git/index.lock"),
      "owned by another",
    );
    await expect(
      f.prepare({ action: "create", name: "locked", switch: false }),
    ).rejects.toThrow(/занят/);
    expect(
      await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
    ).toBe("owned by another");
    await fs.rm(path.join(f.root, ".git/index.lock"));
    await fs.symlink(
      path.join(f.dir, "outside"),
      path.join(f.root, ".git/ORIG_HEAD"),
    );
    await expect(
      f.prepare({ action: "create", name: "symlink", switch: false }),
    ).rejects.toThrow(/метаданн/);
  });
});
it("keeps configuration fixed throughout the single native create-and-switch command", async () => {
  const f = await fixture();
  const p = await f.prepare({
    action: "create",
    name: "two-step",
    switch: true,
  });
  let blocked = false;
  f.intercept(async (args) => {
    if (args.includes("switch")) {
      try {
        await f.git(["config", "filter.injected.smudge", "false"]);
      } catch {
        blocked = true;
      }
    }
  });
  const result = await f.actions.execute(p.token);
  expect(result).toMatchObject({ status: "success", changed: true });
  expect(blocked).toBe(true);
  expect((await f.reader.snapshot()).branch).toBe("two-step");
  await expect(
    f.git(["config", "--get", "filter.injected.smudge"]),
  ).rejects.toThrow();
  expect(f.calls.filter((c) => c.args.includes("switch"))).toHaveLength(1);
});

it("holds the native config lock during checkout so a cooperative config writer cannot install filters", async () => {
  const f = await fixture();
  await f.git(["branch", "other"]);
  const p = await f.prepare({
    action: "switch-local",
    ref: "refs/heads/other",
  } as any);
  let blocked = false;
  f.intercept(async (args) => {
    if (args.includes("switch")) {
      try {
        await f.git(["config", "filter.concurrent.smudge", "false"]);
      } catch {
        blocked = true;
      }
    }
  });
  expect(await f.actions.execute(p.token)).toMatchObject({ status: "success" });
  expect(blocked).toBe(true);
  await expect(
    fs.stat(path.join(f.root, ".git/config.lock")),
  ).rejects.toThrow();
});
it("holds local config fixed during explicit fetch and the fast-forward merge", async () => {
  const f = await fixture();
  await f.remote();
  await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
  const p = await f.prepare({ action: "pull" });
  const protectedCommands: boolean[] = [];
  f.intercept(async (args, online) => {
    if (online || args.includes("merge"))
      protectedCommands.push(
        await fs.stat(path.join(f.root, ".git/config.lock")).then(
          () => true,
          () => false,
        ),
      );
  });
  expect(await f.actions.execute(p.token)).toMatchObject({ status: "success" });
  expect(protectedCommands).toEqual([true, true]);
});
it("does not report a successful pull when HEAD ownership changed during the native merge", async () => {
  const f = await fixture();
  await f.remote();
  await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
  await f.git(["branch", "other"]);
  const p = await f.prepare({ action: "pull" });
  f.intercept(async (args) => {
    if (args.includes("merge"))
      await f.git(["-c", "core.hooksPath=/dev/null", "switch", "other"]);
  });
  expect(await f.actions.execute(p.token)).toMatchObject({
    status: "uncertain",
    changed: true,
  });
  expect((await f.reader.snapshot()).branch).toBe("other");
});
describe("spec-review regressions", () => {
  it("neutralizes branch mergeOptions squash and verifies the exact fast-forward HEAD", async () => {
    const f = await fixture();
    const remote = await f.remote();
    await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
    const before = await f.head(),
      contributor = path.join(f.dir, "contributor");
    await f.git(["clone", "--branch", "main", remote, contributor]);
    await f.git(["config", "user.name", "Fixture"], contributor);
    await f.git(
      ["config", "user.email", "fixture@example.invalid"],
      contributor,
    );
    await fs.writeFile(path.join(contributor, "remote-new"), "new\n");
    await f.git(["add", "."], contributor);
    await f.git(
      ["-c", "core.hooksPath=/dev/null", "commit", "-m", "remote new"],
      contributor,
    );
    const target = (
      await f.git(["rev-parse", "HEAD"], contributor)
    ).stdout.trim();
    await f.git(["push", "origin", "main"], contributor);
    await f.git(["config", "branch.main.mergeOptions", "--squash"]);
    const p = await f.prepare({ action: "pull" });
    const result = await f.actions.execute(p.token);
    expect(result.status).toBe("success");
    const after = await f.reader.snapshot();
    expect(after.head).toBe(target);
    expect(after.head).not.toBe(before);
    expect(after.files).toEqual([]);
    const merge = f.calls.find((c) => c.args.includes("merge"))!.args;
    expect(merge).toEqual(
      expect.arrayContaining([
        "branch.main.mergeOptions=",
        "--ff-only",
        "--no-squash",
        "--no-autostash",
      ]),
    );
  });
  it("previews the exact upstream source separately from the local pull destination", async () => {
    const f = await fixture();
    await f.remote();
    await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
    const p = await f.prepare({ action: "pull" });
    expect(p).toMatchObject({
      sourceRef: "refs/remotes/origin/main",
      toRef: "refs/heads/main",
      toOid: await f.head(),
    });
  });
  it("refuses checkout and pull for an ignored dirty gitlink without scanning the submodule, but permits create-only and fetch", async () => {
    const f = await fixture(),
      sub = path.join(f.root, "sub");
    await fs.mkdir(sub);
    await f.git(["init", "-b", "main"], sub);
    await fs.writeFile(path.join(sub, "file"), "base\n");
    await f.git(["add", "."], sub);
    await f.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "nested",
      ],
      sub,
    );
    const subHead = (await f.git(["rev-parse", "HEAD"], sub)).stdout.trim();
    await f.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${subHead},sub`,
    ]);
    await f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "gitlink"]);
    await f.git(["branch", "other"]);
    await f.remote();
    await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
    await fs.writeFile(path.join(sub, "file"), "hidden dirty\n");
    expect((await f.reader.snapshot()).files).toEqual([]);
    await expect(
      f.prepare({ action: "switch-local", ref: "refs/heads/other" } as any),
    ).rejects.toThrow(/подмодул|gitlink/i);
    await expect(
      f.prepare({ action: "create", name: "switched", switch: true }),
    ).rejects.toThrow(/подмодул|gitlink/i);
    await expect(f.prepare({ action: "pull" })).rejects.toThrow(
      /подмодул|gitlink/i,
    );
    const created = await f.prepare({
      action: "create",
      name: "allowed",
      switch: false,
    });
    expect(await f.actions.execute(created.token)).toMatchObject({
      status: "success",
    });
    const fetched = await f.prepare({ action: "fetch" });
    expect(await f.actions.execute(fetched.token)).toMatchObject({
      status: "success",
    });
    expect(f.calls.some((c) => c.args.some((arg) => arg === "submodule"))).toBe(
      false,
    );
    expect(await fs.readFile(path.join(sub, "file"), "utf8")).toBe(
      "hidden dirty\n",
    );
  });
  it("refuses a target-only gitlink before checkout", async () => {
    const f = await fixture();
    await f.git(["branch", "plain"]);
    await f.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${await f.head()},sub`,
    ]);
    await f.git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "target gitlink",
    ]);
    await f.git(["branch", "with-sub"]);
    await f.git(["switch", "plain"]);
    expect((await f.reader.snapshot()).files).toEqual([]);
    await expect(
      f.prepare({ action: "switch-local", ref: "refs/heads/with-sub" } as any),
    ).rejects.toThrow(/подмодул|gitlink/i);
  });
});
it("refuses pull over an ignored local obstruction without overwriting bytes or HEAD, and reports the completed fetch", async () => {
  const f = await fixture();
  await f.write(".gitignore", "incoming\n");
  await f.git(["add", ".gitignore"]);
  await f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "ignore"]);
  const remote = await f.remote();
  await f.git(["branch", "--set-upstream-to=origin/main", "main"]);
  const before = await f.head(),
    contributor = path.join(f.dir, "contributor");
  await f.git(["clone", "--branch", "main", remote, contributor]);
  await f.git(["config", "user.name", "Fixture"], contributor);
  await f.git(["config", "user.email", "fixture@example.invalid"], contributor);
  await fs.writeFile(
    path.join(contributor, "incoming"),
    "remote tracked data\n",
  );
  await f.git(["add", "-f", "incoming"], contributor);
  await f.git(
    ["-c", "core.hooksPath=/dev/null", "commit", "-m", "track incoming"],
    contributor,
  );
  const target = (
    await f.git(["rev-parse", "HEAD"], contributor)
  ).stdout.trim();
  await f.git(["push", "origin", "main"], contributor);
  const valuable = Buffer.from([0, 1, 2, 255, 10, 97, 98, 99]);
  await fs.writeFile(path.join(f.root, "incoming"), valuable);
  await f.git([
    "config",
    "branch.main.mergeOptions",
    "--overwrite-ignore --squash",
  ]);
  expect((await f.actions.inventory("project")).dirty).toBe(false);
  const p = await f.prepare({ action: "pull" });
  const result = await f.actions.execute(p.token);
  expect(await fs.readFile(path.join(f.root, "incoming"))).toEqual(valuable);
  expect(await f.head()).toBe(before);
  expect((await f.reader.snapshot()).branch).toBe("main");
  expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe("");
  expect(
    (await f.git(["rev-parse", "refs/remotes/origin/main"])).stdout.trim(),
  ).toBe(target);
  expect(result).toMatchObject({ status: "uncertain", changed: true });
  expect(result.log).toMatch(/incoming|overwritten/i);
  const merge = f.calls.find((c) => c.args.includes("merge"))!.args;
  expect(merge).toEqual(
    expect.arrayContaining([
      "branch.main.mergeOptions=",
      "--ff-only",
      "--no-squash",
      "--no-autostash",
      "--no-overwrite-ignore",
    ]),
  );
  await expect(f.actions.execute(p.token)).rejects.toThrow();
});
