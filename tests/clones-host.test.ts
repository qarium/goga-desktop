import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CloneManager } from "../src/host/clones";
import { managedCloneLocation } from "../src/host/clone-store";
import { WorktreeManager } from "../src/host/worktrees";
import {
  worktreeContextRef,
  type TopicContextIdentity,
} from "../src/shared/worktrees";
import type { Runner } from "../src/host/process";
const exec = promisify(execFile);
async function setup() {
  const root = await fs.mkdtemp(
    "/private/tmp/goga-context-ab-research-20261019-impl-clones-host-",
  );
  const home = path.join(root, "home"),
    repo = path.join(root, "repo");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith("GIT_") &&
      ![
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_TERMINAL_PROMPT",
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
      ].includes(key)
    )
      delete env[key];
  const git = (args: string[], cwd = repo) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env });
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "README"), "fixture\n");
  await git(["add", "README"]);
  await git(["commit", "-m", "fixture"]);
  await git(["branch", "alpha"]);
  const calls: { args: string[]; cwd: string }[] = [];
  const runner: Pick<Runner, "command"> = {
    command: async (exe, args, cwd, overrides) => {
      calls.push({ args, cwd });
      const { stdout, stderr } = await exec(exe, args, {
        cwd,
        env: { ...env, ...overrides },
      });
      return { stdout, stderr };
    },
  };
  const project = { id: "p", name: "Project", path: repo };
  const identity: TopicContextIdentity = {
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "alpha",
  };
  return {
    root,
    home,
    repo,
    git,
    runner,
    calls,
    project,
    identity,
    manager: new CloneManager(home, runner),
  };
}
describe("standalone owned clone lifecycle", { timeout: 30000 }, () => {
  it("prepares a standalone clone even for primary's checked-out branch and reuses it after restart", async () => {
    const f = await setup();
    const row = await f.manager.ensure(f.project, {
      ...f.identity,
      topic: "main",
      branch: "main",
    });
    expect(row).toMatchObject({
      storageKind: "clone",
      ownership: "managed",
      state: "ready",
      projectPath: f.repo,
      sourceCommonDir: path.join(f.repo, ".git"),
      gitCommonDir: path.join(row.path, ".git"),
    });
    expect(row.path).not.toBe(f.repo);
    expect((await fs.lstat(row.gitCommonDir)).isDirectory()).toBe(true);
    expect((await f.git(["remote", "-v"], row.path)).stdout).not.toContain(
      "origin",
    );
    expect(
      (
        await f.git(["remote", "get-url", "desktop-source"], row.path)
      ).stdout.trim(),
    ).toBe(f.repo);
    expect(
      await fs
        .stat(path.join(row.gitCommonDir, "objects/info/alternates"))
        .catch(() => null),
    ).toBe(null);
    expect(
      await new CloneManager(f.home, f.runner).ensure(f.project, {
        ...f.identity,
        topic: "main",
        branch: "main",
      }),
    ).toEqual(row);
    expect(await f.manager.resolve(worktreeContextRef(row))).toEqual(row);
    expect(f.calls.filter((c) => c.args.includes("clone"))).toHaveLength(1);
  });
  it("deduplicates concurrent creation across instances", async () => {
    const f = await setup();
    const rows = await Promise.all([
      f.manager.ensure(f.project, f.identity),
      new CloneManager(f.home, f.runner).ensure(f.project, f.identity),
    ]);
    expect(rows[0]).toEqual(rows[1]);
    expect(f.calls.filter((c) => c.args.includes("clone"))).toHaveLength(1);
  });
  it("keeps clone object storage independent from source", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    const oid = (await f.git(["rev-parse", "HEAD"])).stdout.trim();
    const sourceObject = path.join(
      f.repo,
      ".git/objects",
      oid.slice(0, 2),
      oid.slice(2),
    );
    const packed = await fs.readdir(
      path.join(row.gitCommonDir, "objects/pack"),
    );
    expect(packed.some((name) => name.endsWith(".pack"))).toBe(true);
    expect((await fs.stat(sourceObject)).nlink).toBe(1);
    for (const file of packed)
      expect(
        (await fs.stat(path.join(row.gitCommonDir, "objects/pack", file)))
          .nlink,
      ).toBe(1);
    await fs.rename(f.repo, `${f.repo}.preserved`);
    expect((await f.git(["cat-file", "-t", oid], row.path)).stdout.trim()).toBe(
      "commit",
    );
  });
  it("creates an empty topic from base without a fake task or any primary mutation", async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.repo, "README"), "primary dirty\n");
    await fs.writeFile(path.join(f.repo, "valuable"), "keep");
    const before = (await f.git(["show-ref"])).stdout;
    const row = await f.manager.create(f.project, {
      year: "2026",
      branch: "Feature/New-Topic",
      baseRef: "main",
    });
    expect(row.topic).toBe("feature-new-topic");
    expect(
      (await f.git(["branch", "--show-current"], row.path)).stdout.trim(),
    ).toBe("Feature/New-Topic");
    expect((await f.git(["show-ref"])).stdout).toBe(before);
    expect(await fs.readFile(path.join(f.repo, "README"), "utf8")).toBe(
      "primary dirty\n",
    );
    expect(
      await fs
        .stat(
          path.join(row.path, ".goga/history/2026/feature-new-topic/todo.md"),
        )
        .catch(() => null),
    ).toBe(null);
    expect((await f.git(["rev-parse", "HEAD"], row.path)).stdout).toBe(
      (await f.git(["rev-parse", "main"])).stdout,
    );
  });
  it("rejects normalized collisions in one year, allows the same owner name in another", async () => {
    const f = await setup();
    const row = await f.manager.create(f.project, {
      year: "2026",
      branch: "New/Thing",
      baseRef: "main",
    });
    await expect(
      f.manager.create(f.project, {
        year: "2026",
        branch: "new-thing",
        baseRef: "main",
      }),
    ).rejects.toThrow(/существ|совпад|коллиз/);
    const other = await f.manager.create(f.project, {
      year: "2025",
      branch: "new-thing",
      baseRef: "main",
    });
    expect(other.path).not.toBe(row.path);
    await expect(
      f.manager.create(f.project, {
        year: "2026",
        branch: "ALPHA",
        baseRef: "main",
      }),
    ).rejects.toThrow(/существ|совпад|коллиз/);
  });
  it("rejects identity/revision/path forgery without returning primary", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await expect(
      f.manager.resolve({ ...worktreeContextRef(row), projectId: "other" }),
    ).rejects.toThrow();
    await expect(
      f.manager.resolve({
        ...worktreeContextRef(row),
        revision: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/ревизи|измен|устар/);
    await expect(
      f.manager.resolve({ ...worktreeContextRef(row), path: f.repo } as never),
    ).rejects.toThrow();
  });
  it("detects wrong branch but never switches it back", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await f.git(["checkout", "--detach"], row.path);
    await expect(f.manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    expect((await f.manager.reconcile(f.project.id))[0]).toMatchObject({
      state: "conflict",
      reason: "branch",
    });
    expect(
      (
        await f.git(["rev-parse", "--abbrev-ref", "HEAD"], row.path)
      ).stdout.trim(),
    ).toBe("HEAD");
  });
  it("does not recreate missing history or adopt an inode-replacement repository after restart", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await fs.rename(row.path, `${row.path}.preserved`);
    expect(
      (await new CloneManager(f.home, f.runner).reconcile(f.project.id))[0]
        .state,
    ).toBe("missing");
    await expect(f.manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    await fs.mkdir(row.path);
    await f.git(["init", "-b", "alpha"], row.path);
    await fs.writeFile(path.join(row.path, "valuable"), "foreign");
    await expect(
      new CloneManager(f.home, f.runner).ensure(f.project, f.identity),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(row.path, "valuable"), "utf8")).toBe(
      "foreign",
    );
    expect(f.calls.filter((c) => c.args.includes("clone"))).toHaveLength(1);
  });
  it("rejects unowned occupied destination without removing it", async () => {
    const f = await setup(),
      loc = managedCloneLocation(
        f.home,
        f.project,
        path.join(f.repo, ".git"),
        f.identity,
      );
    await fs.mkdir(loc.path, { recursive: true });
    await fs.writeFile(path.join(loc.path, "valuable"), "keep");
    await expect(f.manager.ensure(f.project, f.identity)).rejects.toThrow();
    expect(await fs.readFile(path.join(loc.path, "valuable"), "utf8")).toBe(
      "keep",
    );
  });
  it("rejects symlink replacement of .git and external object alternates", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await fs.writeFile(
      path.join(row.gitCommonDir, "objects/info/alternates"),
      path.join(f.repo, ".git/objects"),
    );
    await expect(f.manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    const other = await f.manager.create(f.project, {
      year: "2026",
      branch: "beta",
      baseRef: "main",
    });
    await fs.rename(other.gitCommonDir, `${other.gitCommonDir}.preserved`);
    await fs.symlink(`${other.gitCommonDir}.preserved`, other.gitCommonDir);
    await expect(
      f.manager.resolve(worktreeContextRef(other)),
    ).rejects.toThrow();
  });
  it("recovers a lost successful checkout response without repeating creation", async () => {
    const f = await setup();
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        const result = await f.runner.command(...args);
        if (args[1].includes("checkout")) throw Error("lost response");
        return result;
      },
    };
    const row = await new CloneManager(f.home, runner).ensure(
      f.project,
      f.identity,
    );
    expect(row.state).toBe("ready");
    expect(
      (await new CloneManager(f.home, f.runner).reconcile(f.project.id))[0],
    ).toEqual(row);
    expect(f.calls.filter((c) => c.args.includes("clone"))).toHaveLength(1);
  });
  it("preserves ambiguous incomplete ownership and refuses automatic retry after restart", async () => {
    const f = await setup();
    let attempts = 0;
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        if (args[1].includes("clone")) {
          attempts++;
          throw Error("transport lost");
        }
        return f.runner.command(...args);
      },
    };
    await expect(
      new CloneManager(f.home, runner).ensure(f.project, f.identity),
    ).rejects.toThrow();
    await expect(
      new CloneManager(f.home, runner).ensure(f.project, f.identity),
    ).rejects.toThrow(/неоднознач|провер|подготов/);
    expect(attempts).toBe(1);
    expect(
      (await new CloneManager(f.home, f.runner).reconcile(f.project.id))[0],
    ).toMatchObject({ state: "conflict", preparation: "ambiguous" });
  });
  it("marks legacy linked records explicitly without conversion or deletion", async () => {
    const f = await setup();
    const legacy = await new WorktreeManager(f.home, f.runner).ensure(
      f.project,
      f.identity,
    );
    const file = path.join(f.home, ".goga/desktop/worktrees/registry.json"),
      before = await fs.readFile(file, "utf8");
    expect((await f.manager.reconcile(f.project.id))[0]).toMatchObject({
      contextId: legacy.contextId,
      storageKind: "linked",
      compatibility: "legacy-linked",
    });
    await expect(f.manager.ensure(f.project, f.identity)).rejects.toThrow(
      /legacy|прежн|совмест|миграц/i,
    );
    await expect(
      f.manager.resolve(worktreeContextRef(legacy)),
    ).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect((await fs.lstat(path.join(legacy.path, ".git"))).isFile()).toBe(
      true,
    );
  });
});

describe(
  "clone migration and publication boundaries",
  { timeout: 30000 },
  () => {
    it("requires a matching legacy record for explicit migration and preserves it after cloning", async () => {
      const f = await setup();
      await expect(
        f.manager.migrateLegacy(f.project, f.identity),
      ).rejects.toThrow(/legacy|прежн|миграц/i);
      const legacy = await new WorktreeManager(f.home, f.runner).ensure(
        f.project,
        f.identity,
      );
      const legacyFile = path.join(
        f.home,
        ".goga/desktop/worktrees/registry.json",
      );
      const before = await fs.readFile(legacyFile, "utf8");
      const clone = await f.manager.migrateLegacy(f.project, f.identity);
      expect(clone.storageKind).toBe("clone");
      expect(clone.path).not.toBe(legacy.path);
      expect(await fs.readFile(legacyFile, "utf8")).toBe(before);
      expect((await fs.lstat(path.join(legacy.path, ".git"))).isFile()).toBe(
        true,
      );
    });
    it("makes desktop-source fetch-only so a plain push cannot modify primary refs", async () => {
      const f = await setup(),
        row = await f.manager.ensure(f.project, f.identity);
      expect(
        (
          await f.git(
            ["remote", "get-url", "--push", "desktop-source"],
            row.path,
          )
        ).stdout.trim(),
      ).toBe("/dev/null");
      await fs.writeFile(path.join(row.path, "commit-only-in-clone"), "owned");
      await f.git(["add", "commit-only-in-clone"], row.path);
      await f.git(["commit", "-m", "unique clone commit"], row.path);
      const primaryBefore = (await f.git(["show-ref"])).stdout;
      await expect(
        f.git(["push", "desktop-source", "alpha"], row.path),
      ).rejects.toThrow();
      expect((await f.git(["show-ref"])).stdout).toBe(primaryBefore);
    });
    it("does not publish a clone as ready when checkout fails before touching the index", async () => {
      const f = await setup();
      const runner: Pick<Runner, "command"> = {
        command: async (...args) => {
          if (args[1].includes("checkout")) throw Error("not run");
          return f.runner.command(...args);
        },
      };
      await expect(
        new CloneManager(f.home, runner).ensure(f.project, f.identity),
      ).rejects.toThrow(/неоднознач/);
      expect((await f.manager.reconcile(f.project.id))[0]).toMatchObject({
        state: "conflict",
        preparation: "ambiguous",
      });
    });
  },
);

describe("recoverable owned-clone deletion", { timeout: 30000 }, () => {
  it("archives every local ref, annotated tag and reflog-only tip before metadata removal and trash", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await fs.writeFile(path.join(row.path, "unique"), "unique committed bytes");
    await f.git(["add", "unique"], row.path);
    await f.git(["commit", "-m", "unique"], row.path);
    const unique = (await f.git(["rev-parse", "HEAD"], row.path)).stdout.trim();
    await f.git(["branch", "other-local-branch"], row.path);
    await f.git(["tag", "-a", "local-tag", "-m", "annotation"], row.path);
    const tag = (
      await f.git(["rev-parse", "refs/tags/local-tag"], row.path)
    ).stdout.trim();
    await f.git(["checkout", "--detach"], row.path);
    await fs.writeFile(path.join(row.path, "reflog-only"), "retained");
    await f.git(["add", "reflog-only"], row.path);
    await f.git(["commit", "-m", "reflog-only"], row.path);
    const reflogOnly = (
      await f.git(["rev-parse", "HEAD"], row.path)
    ).stdout.trim();
    await f.git(["checkout", "alpha"], row.path);
    const head = (await f.git(["rev-parse", "HEAD"])).stdout;
    const index = await fs.readFile(path.join(f.repo, ".git/index"));
    const plan = await f.manager.prepareDeletion(worktreeContextRef(row), {
      active: false,
      current: false,
    });
    const trash = path.join(f.root, "trash-preserved");
    let metadata = false;
    const result = await f.manager.executeDeletion(
      plan.token,
      { active: false, current: false },
      {
        removeTopic: async () => {
          const archive = (
            await f.git([
              "for-each-ref",
              "--format=%(objectname)",
              "refs/desktop/archive/",
            ])
          ).stdout;
          expect(archive).toContain(unique);
          expect(archive).toContain(tag);
          expect(archive).toContain(reflogOnly);
          expect(await fs.readFile(path.join(row.path, "unique"), "utf8")).toBe(
            "unique committed bytes",
          );
          metadata = true;
        },
        trashItem: async (source) => {
          expect(metadata).toBe(true);
          expect(source).toBe(row.path);
          await fs.rename(source, trash);
        },
      },
    );
    expect(result.status).toBe("success");
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await fs.readFile(path.join(f.repo, ".git/index"))).toEqual(index);
    expect((await f.git(["cat-file", "-t", reflogOnly])).stdout.trim()).toBe(
      "commit",
    );
    expect(
      (await f.manager.reconcile(f.project.id)).find(
        (r) => r.contextId === row.contextId,
      )?.state,
    ).toBe("missing");
    expect(await fs.readFile(path.join(trash, "unique"), "utf8")).toBe(
      "unique committed bytes",
    );
  });
  it("blocks dirty, staged, untracked, valuable ignored, active and current owners before archive or trash", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity),
      ref = worktreeContextRef(row);
    await expect(
      f.manager.prepareDeletion(ref, { active: true, current: false }),
    ).rejects.toThrow();
    await expect(
      f.manager.prepareDeletion(ref, { active: false, current: true }),
    ).rejects.toThrow();
    await fs.appendFile(
      path.join(row.gitCommonDir, "info/exclude"),
      "\nvaluable-ignored\n",
    );
    await fs.writeFile(path.join(row.path, "valuable-ignored"), "keep ignored");
    await expect(
      f.manager.prepareDeletion(ref, { active: false, current: false }),
    ).rejects.toThrow(/локальн|измен|файл/);
    expect(
      (await f.git(["for-each-ref", "refs/desktop/archive/"])).stdout,
    ).toBe("");
  });
  it("rejects a stale confirmation after new commits without touching primary refs", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    const plan = await f.manager.prepareDeletion(worktreeContextRef(row), {
      active: false,
      current: false,
    });
    await fs.writeFile(path.join(row.path, "after-confirmation"), "new");
    await f.git(["add", "after-confirmation"], row.path);
    await f.git(["commit", "-m", "new"], row.path);
    let trashCalled = false;
    await expect(
      f.manager.executeDeletion(
        plan.token,
        { active: false, current: false },
        {
          trashItem: async () => {
            trashCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/устар|измен/);
    expect(trashCalled).toBe(false);
    expect(
      (await f.git(["for-each-ref", "refs/desktop/archive/"])).stdout,
    ).toBe("");
  });
  it("persists partial stages and resumes after restart without deleting unique commits", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await fs.writeFile(path.join(row.path, "unique"), "keep");
    await f.git(["add", "unique"], row.path);
    await f.git(["commit", "-m", "keep"], row.path);
    const plan = await f.manager.prepareDeletion(worktreeContextRef(row), {
      active: false,
      current: false,
    });
    const partial = await f.manager.executeDeletion(
      plan.token,
      { active: false, current: false },
      {
        removeTopic: async () => {
          throw Error("metadata failure");
        },
        trashItem: async () => {
          throw Error("must not reach");
        },
      },
    );
    expect(partial.status).toBe("partial");
    const restarted = new CloneManager(f.home, f.runner);
    expect((await restarted.deletionRecovery(f.project.id))[0]).toMatchObject({
      token: plan.token,
      stage: "removing-topic",
    });
    expect(await fs.readFile(path.join(row.path, "unique"), "utf8")).toBe(
      "keep",
    );
    const result = await restarted.executeDeletion(
      plan.token,
      { active: false, current: false },
      {
        removeTopic: async () => {},
        trashItem: async (source) => {
          await fs.rename(source, path.join(f.root, "trash-preserved"));
        },
      },
    );
    expect(result.status).toBe("success");
    expect(await restarted.deletionRecovery(f.project.id)).toEqual([]);
  });
  it("reports an ambiguous trash result as partial and leaves its durable journal for recovery", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    const plan = await f.manager.prepareDeletion(worktreeContextRef(row), {
      active: false,
      current: false,
    });
    const result = await f.manager.executeDeletion(
      plan.token,
      { active: false, current: false },
      {
        trashItem: async (source) => {
          await fs.rename(source, path.join(f.root, "trash-preserved"));
          throw Error("result lost");
        },
      },
    );
    expect(result).toMatchObject({ status: "partial", stage: "trashing" });
    expect(
      (
        await new CloneManager(f.home, f.runner).deletionRecovery(f.project.id)
      )[0],
    ).toMatchObject({ stage: "trashing" });
    expect(
      (await f.git(["for-each-ref", "refs/desktop/archive/"])).stdout,
    ).not.toBe("");
  });
});

describe(
  "deletion journal/registry crash boundaries",
  { timeout: 30000 },
  () => {
    it("recovers after the deleting registry revision was committed but its acknowledgement was lost", async () => {
      const f = await setup(),
        row = await f.manager.ensure(f.project, f.identity);
      const plan = await f.manager.prepareDeletion(worktreeContextRef(row), {
        active: false,
        current: false,
      });
      const actual = f.manager.store.update.bind(f.manager.store);
      vi.spyOn(f.manager.store, "update").mockImplementation(
        async (...args) => {
          const result = await actual(...args);
          if (args[0].state === "deleting")
            throw Error("result lost after durable registry commit");
          return result;
        },
      );
      await f.manager
        .executeDeletion(
          plan.token,
          { active: false, current: false },
          { trashItem: async () => {} },
        )
        .catch(() => {});
      const restarted = new CloneManager(f.home, f.runner);
      const result = await restarted.executeDeletion(
        plan.token,
        { active: false, current: false },
        {
          trashItem: async (source) => {
            await fs.rename(source, path.join(f.root, "trash-preserved"));
          },
        },
      );
      expect(result.status).toBe("success");
    });
    it("recovers a successful trash move acknowledged before a lost tombstone update result", async () => {
      const f = await setup(),
        row = await f.manager.ensure(f.project, f.identity);
      const plan = await f.manager.prepareDeletion(worktreeContextRef(row), {
        active: false,
        current: false,
      });
      const actual = f.manager.store.update.bind(f.manager.store);
      vi.spyOn(f.manager.store, "update").mockImplementation(
        async (...args) => {
          const result = await actual(...args);
          if (args[0].state === "missing")
            throw Error("tombstone acknowledgement lost");
          return result;
        },
      );
      const result = await f.manager.executeDeletion(
        plan.token,
        { active: false, current: false },
        {
          trashItem: async (source) => {
            await fs.rename(source, path.join(f.root, "trash-preserved"));
          },
        },
      );
      expect(result.status).toBe("partial");
      const restarted = new CloneManager(f.home, f.runner);
      const recovered = await restarted.executeDeletion(
        plan.token,
        { active: false, current: false },
        {
          trashItem: async () => {
            throw Error("must not trash twice");
          },
        },
      );
      expect(recovered.status).toBe("success");
      expect(await restarted.deletionRecovery(f.project.id)).toEqual([]);
    });
  },
);

describe("source repository binding", { timeout: 30000 }, () => {
  it("rejects replacement of the primary Git identity at the same pathname after restart", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await fs.rename(
      path.join(f.repo, ".git"),
      path.join(f.repo, ".git.preserved"),
    );
    await f.git(["init", "-b", "main"]);
    await expect(
      new CloneManager(f.home, f.runner).resolve(worktreeContextRef(row)),
    ).rejects.toThrow();
    expect(
      (await f.git(["cat-file", "-t", "HEAD"], row.path)).stdout.trim(),
    ).toBe("commit");
  });
});

describe("clone metadata isolation", { timeout: 30000 }, () => {
  it("rejects an index hardlinked to primary even though both roots and Git directories still match", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await fs.rename(
      path.join(row.gitCommonDir, "index"),
      path.join(row.gitCommonDir, "index.preserved"),
    );
    await fs.link(
      path.join(f.repo, ".git/index"),
      path.join(row.gitCommonDir, "index"),
    );
    await expect(f.manager.resolve(worktreeContextRef(row))).rejects.toThrow();
  });
});

describe("completed clone deletion tombstone", { timeout: 30000 }, () => {
  it("marks confirmed trash with deletedAt across restarts and never reuses the historical context identity", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    const plan = await f.manager.prepareDeletion(worktreeContextRef(row), {
      active: false,
      current: false,
    });
    const result = await f.manager.executeDeletion(
      plan.token,
      { active: false, current: false },
      {
        trashItem: async (source) => {
          await fs.rename(source, path.join(f.root, "trash-preserved"));
        },
      },
    );
    expect(result.status).toBe("success");
    const restarted = new CloneManager(f.home, f.runner);
    const tombstone = (await restarted.reconcile(f.project.id)).find(
      (r) => r.contextId === row.contextId,
    );
    expect(tombstone).toMatchObject({
      state: "missing",
      deletedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await expect(restarted.ensure(f.project, f.identity)).rejects.toThrow(
      /удалён|новая идентичност/,
    );
    await expect(
      restarted.create(f.project, {
        year: f.identity.year,
        branch: f.identity.branch,
        baseRef: "main",
      }),
    ).rejects.toThrow(/удалён|новая идентичност/);
    expect(
      (await f.git(["for-each-ref", "refs/desktop/archive/"])).stdout,
    ).not.toBe("");
  });
});

describe("owned clone repair revision stability", { timeout: 30000 }, () => {
  it("clears a former branch conflict and resolves the repaired revision without repeated invalidation", async () => {
    const f = await setup(),
      row = await f.manager.ensure(f.project, f.identity);
    await f.git(["checkout", "--detach"], row.path);
    await expect(f.manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    expect((await f.manager.reconcile(f.project.id))[0].reason).toBe("branch");
    await f.git(["checkout", "alpha"], row.path);
    const repaired = (await f.manager.reconcile(f.project.id))[0];
    expect(repaired.state).toBe("ready");
    expect(repaired.reason).toBeUndefined();
    expect(await f.manager.resolve(worktreeContextRef(repaired))).toEqual(
      repaired,
    );
    expect(await f.manager.resolve(worktreeContextRef(repaired))).toEqual(
      repaired,
    );
  });
});
