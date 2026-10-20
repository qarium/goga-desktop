import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeManager } from "../src/host/worktrees";
import {
  WorktreeStore,
  managedWorktreeLocation,
} from "../src/host/worktree-store";
import type { Runner } from "../src/host/process";
import { withReadScope } from "../src/host/read-scope";
import { readCancelledMessage } from "../src/shared/read-deadlines";
import {
  worktreeContextRef,
  type TopicContextIdentity,
  type WorktreeRecord,
} from "../src/shared/worktrees";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await fs.mkdtemp("/private/tmp/goga-worktree-host-");
  roots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (args: string[], cwd = repo) =>
    exec("git", args, { cwd, env });
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "README"), "fixture\n");
  await git(["add", "README"]);
  await git(["commit", "-m", "Fixture"]);
  await git(["branch", "goga/2026/alpha"]);
  const calls: string[][] = [];
  const runner: Pick<Runner, "command"> = {
    command: async (exe, args, cwd, overrides) => {
      calls.push(args);
      const result = await exec(exe, args, {
        cwd,
        env: { ...env, ...overrides },
      });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  };
  const project = { id: "p", name: "Project", path: repo };
  const identity: TopicContextIdentity = {
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "goga/2026/alpha",
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
    manager: new WorktreeManager(home, runner),
  };
}

describe("managed Git worktrees", () => {
  it("creates once under managed root, verifies a git-file worktree and reuses across restarts", async () => {
    const { manager, project, identity, home, git, calls } = await setup();
    const result = await manager.ensure(project, identity);
    expect(result).toMatchObject({
      ...identity,
      ownership: "managed",
      state: "ready",
    });
    expect((await fs.lstat(path.join(result.path, ".git"))).isFile()).toBe(
      true,
    );
    expect(
      (await git(["branch", "--show-current"], result.path)).stdout.trim(),
    ).toBe(identity.branch);
    const next = await new WorktreeManager(home, manager.runner).ensure(
      project,
      identity,
    );
    expect(next).toEqual(result);
    expect(calls.filter((args) => args.includes("add"))).toHaveLength(1);
    expect(await manager.resolve(worktreeContextRef(result))).toEqual(result);
    expect(Object.keys(worktreeContextRef(result)).sort()).toEqual([
      "branch",
      "contextId",
      "projectId",
      "revision",
      "topic",
      "year",
    ]);
    await expect(
      manager.resolve({
        ...worktreeContextRef(result),
        path: "/outside",
      } as never),
    ).rejects.toThrow();
  });
  it("serializes concurrent ensures across manager instances into one git add", async () => {
    const { home, runner, manager, project, identity, calls } = await setup();
    const result = await Promise.all([
      manager.ensure(project, identity),
      new WorktreeManager(home, runner).ensure(project, identity),
      manager.ensure(project, identity),
    ]);
    expect(new Set(result.map((r) => r.contextId))).toHaveLength(1);
    expect(new Set(result.map((r) => r.path))).toHaveLength(1);
    expect(calls.filter((args) => args.includes("add"))).toHaveLength(1);
  });
  it("queues slow concurrent preparations in the same process rather than expiring the ownership lock", async () => {
    const { home, runner, project, identity, calls } = await setup();
    const slow: Pick<Runner, "command"> = {
      command: async (...args) => {
        if (args[1].includes("add"))
          await new Promise((resolve) => setTimeout(resolve, 2300));
        return runner.command(...args);
      },
    };
    const rows = await Promise.all([
      new WorktreeManager(home, slow).ensure(project, identity),
      new WorktreeManager(home, slow).ensure(project, identity),
    ]);
    expect(rows[0]).toEqual(rows[1]);
    expect(calls.filter((args) => args.includes("add"))).toHaveLength(1);
  });
  it("prepares independent managed contexts in a shared repository without changing primary", async () => {
    const { manager, project, identity, git, repo } = await setup();
    await git(["branch", "goga/2025/beta"]);
    const [a, b] = await Promise.all([
      manager.ensure(project, identity),
      manager.ensure(project, {
        ...identity,
        year: "2025",
        topic: "beta",
        branch: "goga/2025/beta",
      }),
    ]);
    expect(a.contextId).not.toBe(b.contextId);
    expect(a.path).not.toBe(b.path);
    expect((await git(["branch", "--show-current"], repo)).stdout.trim()).toBe(
      "main",
    );
    expect(await manager.reconcile(project.id)).toHaveLength(2);
    expect((await manager.list()).every((r) => r.state === "ready")).toBe(true);
  });
  it("explicitly recreates a verified removed managed copy with a new revision, not a new identity", async () => {
    const { manager, project, identity, git } = await setup();
    const before = await manager.ensure(project, identity);
    await git(["worktree", "remove", before.path]);
    const after = await manager.ensure(project, identity);
    expect(after.contextId).toBe(before.contextId);
    expect(after.path).toBe(before.path);
    expect(after.revision).not.toBe(before.revision);
    await expect(manager.resolve(worktreeContextRef(before))).rejects.toThrow(
      /ревизи|устар|измен/,
    );
  });
  it("reuses verified primary without claiming managed ownership", async () => {
    const { manager, project, identity, repo, calls } = await setup();
    const row = await manager.ensure(project, {
      ...identity,
      topic: "main",
      branch: "main",
    });
    expect(row).toMatchObject({
      path: repo,
      ownership: "primary",
      state: "ready",
    });
    expect(calls.some((args) => args.includes("add"))).toBe(false);
    expect((await manager.list(project.id))[0].ownership).toBe("primary");
  });
  it("rejects a branch checked out externally without force or ownership adoption", async () => {
    const { root, git, manager, project, identity, calls } = await setup();
    const external = path.join(root, "external");
    await git(["worktree", "add", "--", external, identity.branch]);
    await expect(manager.ensure(project, identity)).rejects.toThrow(
      /друг|внешн|занят|конфликт/,
    );
    expect(await manager.list()).toEqual([]);
    expect(calls.some((args) => args.includes("--force"))).toBe(false);
    expect(await fs.readFile(path.join(external, "README"), "utf8")).toBe(
      "fixture\n",
    );
  });
  it("rejects existing unowned destination directories without removing their contents", async () => {
    const { home, repo, manager, project, identity } = await setup();
    const location = managedWorktreeLocation(
      home,
      project,
      path.join(repo, ".git"),
      identity,
    );
    await fs.mkdir(location.path, { recursive: true });
    await fs.writeFile(path.join(location.path, "valuable"), "keep");
    await expect(manager.ensure(project, identity)).rejects.toThrow(
      /принадлеж|занят|каталог|конфликт/,
    );
    expect(
      await fs.readFile(path.join(location.path, "valuable"), "utf8"),
    ).toBe("keep");
    expect(await manager.list()).toEqual([]);
  });
  it("rejects stale revisions and context/project identity forgery", async () => {
    const { manager, project, identity } = await setup();
    const row = await manager.ensure(project, identity);
    await expect(
      manager.resolve({ ...worktreeContextRef(row), projectId: "other" }),
    ).rejects.toThrow();
    await expect(
      manager.resolve({ ...worktreeContextRef(row), topic: "other" }),
    ).rejects.toThrow();
    await expect(
      manager.resolve({
        ...worktreeContextRef(row),
        revision: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/измен|ревизи|устар/);
  });
  it("revalidates actual branch on resolve, marks conflict and never switches it back", async () => {
    const { manager, project, identity, git } = await setup();
    const row = await manager.ensure(project, identity);
    await git(["checkout", "--detach"], row.path);
    await expect(manager.resolve(worktreeContextRef(row))).rejects.toThrow(
      /ветк|конфликт|недоступ/,
    );
    const current = (await manager.list())[0];
    expect(current.state).toBe("conflict");
    expect(current.revision).not.toBe(row.revision);
    expect(
      (
        await git(["rev-parse", "--abbrev-ref", "HEAD"], row.path)
      ).stdout.trim(),
    ).toBe("HEAD");
  });
  it("revalidates common directory and git registration, not just a folder with .git", async () => {
    const { manager, project, identity, root, git } = await setup();
    const row = await manager.ensure(project, identity);
    await git(["worktree", "remove", row.path]);
    await fs.mkdir(row.path);
    await git(["init", "-b", identity.branch], row.path);
    await fs.writeFile(path.join(row.path, "valuable"), "foreign repository");
    await expect(manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    expect((await manager.reconcile())[0].state).toBe("conflict");
    expect(await fs.readFile(path.join(row.path, "valuable"), "utf8")).toBe(
      "foreign repository",
    );
    expect(root.startsWith("/private/tmp/")).toBe(true);
  });
  it("rejects a .git symlink even when it points at the correct existing git-file", async () => {
    const { manager, project, identity, root } = await setup();
    const row = await manager.ensure(project, identity);
    const gitFile = path.join(row.path, ".git");
    const moved = path.join(root, "external-git-file");
    await fs.rename(gitFile, moved);
    await fs.symlink(moved, gitFile);
    await expect(manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    expect((await manager.list())[0].state).toBe("conflict");
    expect((await fs.lstat(gitFile)).isSymbolicLink()).toBe(true);
  });
  it("returns missing history without recreating a removed copy", async () => {
    const { manager, project, identity, git, calls } = await setup();
    const row = await manager.ensure(project, identity);
    await git(["worktree", "remove", row.path]);
    const history = await manager.reconcile(project.id);
    expect(history[0]).toMatchObject({
      contextId: row.contextId,
      state: "missing",
    });
    expect(history[0].revision).not.toBe(row.revision);
    await expect(manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    expect(calls.filter((args) => args.includes("add"))).toHaveLength(1);
  });
  it("reconciles a successful add whose result was lost rather than repeating it", async () => {
    const { home, runner, project, identity, calls } = await setup();
    const ambiguous: Pick<Runner, "command"> = {
      command: async (...args) => {
        const result = await runner.command(...args);
        if (args[1].includes("add"))
          throw new Error("result lost after Git completed");
        return result;
      },
    };
    const manager = new WorktreeManager(home, ambiguous);
    const row = await manager.ensure(project, identity);
    expect(row.state).toBe("ready");
    expect((await manager.ensure(project, identity)).contextId).toBe(
      row.contextId,
    );
    expect(calls.filter((args) => args.includes("add"))).toHaveLength(1);
  });
  it("preserves an ambiguous incomplete attempt and refuses blind retries after restart", async () => {
    const { home, runner, project, identity } = await setup();
    let attempts = 0;
    const ambiguous: Pick<Runner, "command"> = {
      command: async (...args) => {
        if (args[1].includes("add")) {
          attempts++;
          throw new Error("timed out");
        }
        return runner.command(...args);
      },
    };
    await expect(
      new WorktreeManager(home, ambiguous).ensure(project, identity),
    ).rejects.toThrow();
    await expect(
      new WorktreeManager(home, ambiguous).ensure(project, identity),
    ).rejects.toThrow(/неоднознач|провер|подготов/);
    expect(attempts).toBe(1);
    expect((await new WorktreeStore(home).read()).records[0]).toMatchObject({
      state: "conflict",
      preparation: "ambiguous",
    });
  });
  it.each(["root", "leaf"])(
    "fails closed on %s symlink without touching target",
    async (kind) => {
      const { home, repo, root, manager, project, identity } = await setup();
      const external = path.join(root, "foreign");
      await fs.mkdir(external);
      const location = managedWorktreeLocation(
        home,
        project,
        path.join(repo, ".git"),
        identity,
      );
      const target =
        kind === "root"
          ? path.join(home, ".goga/desktop/worktrees")
          : location.path;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(external, target);
      await expect(manager.ensure(project, identity)).rejects.toThrow();
      expect(await fs.readdir(external)).toEqual([]);
    },
  );
  it("does not run git with option-like or malformed branch identities", async () => {
    const { manager, project, identity, calls } = await setup();
    await expect(
      manager.ensure(project, { ...identity, branch: "--force" }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

// This regression deliberately uses no Git repository and never invokes Git.
// It remains runnable when fixture repository mutations are not authorized.
describe("worktree resolver filesystem race (fake runner only)", () => {
  it("does not publish ready when the managed root is replaced during the last command", async () => {
    const root = await fs.mkdtemp("/private/tmp/goga-worktree-fake-");
    roots.push(root);
    await fs.appendFile(
      "/private/tmp/worktrees-foundation-temp-paths.log",
      `${root} (non-Git fake directories only)\n`,
    );
    const home = path.join(root, "home");
    const repo = path.join(root, "source-files");
    const metadata = path.join(root, "synthetic-metadata");
    await Promise.all([home, repo, metadata].map((dir) => fs.mkdir(dir)));
    const project = { id: "fake", name: "Fake", path: repo };
    const identity = {
      projectId: "fake",
      year: "2026",
      topic: "alpha",
      branch: "goga/2026/alpha",
    };
    const location = managedWorktreeLocation(home, project, metadata, identity);
    await fs.mkdir(location.path, { recursive: true });
    const row = {
      ...identity,
      ...location,
      projectPath: repo,
      gitCommonDir: metadata,
      ownership: "managed" as const,
      state: "ready" as const,
      revision: "11111111-1111-4111-8111-111111111111",
    };
    const managedRoot = path.join(home, ".goga/desktop/worktrees");
    let swapped = false;
    const runner: Pick<Runner, "command"> = {
      command: async (_exe, args, cwd) => {
        let stdout: string;
        if (args.includes("--show-toplevel")) stdout = cwd;
        else if (
          args.includes("--git-common-dir") ||
          args.includes("--absolute-git-dir")
        )
          stdout = metadata;
        else if (args.includes("list"))
          stdout = `worktree ${repo}\0branch refs/heads/main\0\0worktree ${row.path}\0branch refs/heads/${row.branch}\0\0`;
        else if (args.includes("symbolic-ref")) {
          await fs.rename(managedRoot, `${managedRoot}.saved`);
          await fs.mkdir(managedRoot);
          swapped = true;
          stdout = `refs/heads/${row.branch}`;
        } else throw new Error("Unexpected fake command");
        return { stdout: `${stdout}\n`, stderr: "" };
      },
    };
    const manager = new WorktreeManager(home, runner);
    await manager.store.update(row, undefined);
    await expect(manager.resolve(worktreeContextRef(row))).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await fs.readdir(managedRoot)).toEqual([]);
  });
});

// Pure in-memory regression coverage: no fixture directories or native Git.
describe("mock-only cancellation safety", () => {
  function fixture() {
    const root = process.cwd();
    const runner: Pick<Runner, "command"> = {
      command: vi.fn(async () => {
        throw Error("Native Git must not run in this test");
      }),
    };
    const manager = new WorktreeManager(root, runner);
    const internals = manager as unknown as {
      repository(project: unknown): Promise<unknown>;
      validate(
        record: unknown,
      ): Promise<{ state: "ready" | "conflict"; reason?: "path" }>;
      refresh(record: WorktreeRecord): Promise<WorktreeRecord>;
    };
    const row: WorktreeRecord = {
      projectId: "mock",
      year: "2026",
      topic: "alpha",
      branch: "alpha",
      contextId: `ctx-${"a".repeat(64)}`,
      revision: "11111111-1111-4111-8111-111111111111",
      repositoryKey: "b".repeat(64),
      projectPath: root,
      gitCommonDir: root,
      path: root,
      ownership: "primary",
      state: "ready",
    };
    vi.spyOn(manager.store, "assertRoot").mockResolvedValue();
    const update = vi
      .spyOn(manager.store, "update")
      .mockImplementation(async (record) => record);
    const controller = new AbortController();
    return { manager, internals, row, controller, update, runner };
  }
  afterEach(() => vi.restoreAllMocks());
  it("does not persist a false conflict when Git validation is cancelled", async () => {
    const f = fixture();
    vi.spyOn(f.internals, "repository").mockImplementation(async () => {
      f.controller.abort();
      throw Error(readCancelledMessage);
    });
    await expect(
      withReadScope(f.controller.signal, () => f.internals.refresh(f.row)),
    ).rejects.toThrow(readCancelledMessage);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.runner.command).not.toHaveBeenCalled();
  });
  it("does not persist conflict results cancelled immediately after validation", async () => {
    const f = fixture();
    vi.spyOn(f.internals, "validate").mockImplementation(async () => {
      f.controller.abort();
      return { state: "conflict", reason: "path" };
    });
    await expect(
      withReadScope(f.controller.signal, () => f.internals.refresh(f.row)),
    ).rejects.toThrow(readCancelledMessage);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.runner.command).not.toHaveBeenCalled();
  });
  it("does not return unchanged ready results cancelled immediately after validation", async () => {
    const f = fixture();
    vi.spyOn(f.internals, "validate").mockImplementation(async () => {
      f.controller.abort();
      return { state: "ready" };
    });
    await expect(
      withReadScope(f.controller.signal, () => f.internals.refresh(f.row)),
    ).rejects.toThrow(readCancelledMessage);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.runner.command).not.toHaveBeenCalled();
  });
});
