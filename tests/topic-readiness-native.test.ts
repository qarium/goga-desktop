import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { HostService } from "../src/host/service";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
const execute = promisify(execFile);
const native =
  process.env.GOGA_TOPIC_READONLY_CLI ??
  path.join(homedir(), ".local/bin/goga");
const nativeDescribe = describe.skipIf(!existsSync(native));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export async function fixture(task?: string) {
  const root = await fs.mkdtemp("/private/tmp/goga-readiness47-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "primary"),
    home = path.join(root, "home");
  await fs.mkdir(repo);
  await fs.mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = async (args: string[], cwd = repo) =>
    (
      await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env,
      })
    ).stdout;
  const relative = ".goga/history/2026/feature-test/todo.md";
  const taskAt = (cwd = repo) => path.join(cwd, relative);
  const writeTask = async (text: string, cwd = repo) => {
    await fs.mkdir(path.dirname(taskAt(cwd)), { recursive: true });
    await fs.writeFile(taskAt(cwd), text);
  };
  await git(["init", "-b", "feature/test"]);
  await fs.mkdir(path.join(repo, ".goga"));
  await fs.writeFile(path.join(repo, ".goga/config.yml"), "language: python\n");
  if (task !== undefined) await writeTask(task);
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  const calls: { exe: string; args: string[]; cwd: string }[] = [];
  const runner = {
    command: vi.fn(
      async (exe: string, args: string[], cwd: string, overrides = {}) => {
        calls.push({ exe, args, cwd });
        if (
          exe === native &&
          (JSON.stringify(args.slice(0, 5)) !==
            JSON.stringify(["topics", "--year", "2026", "board", "--json"]) ||
            args.slice(5).some((a) => !["--per-host", "--remote"].includes(a)))
        )
          throw Error("Only native read-only board is allowlisted");
        return execute(exe, args, {
          cwd,
          env: { ...env, ...overrides },
          maxBuffer: 2 * 1024 * 1024,
        });
      },
    ),
    start: vi.fn(() => {
      throw Error("No pipeline execution allowed");
    }),
    kill: vi.fn(),
  };
  const service = new HostService({
    home,
    dataDir: path.join(home, "data"),
    runner: runner as any,
    goga: native,
  });
  cleanups.push(() => service.dispose());
  const project = await service.addProject(repo);
  const identity = {
    projectId: project.id,
    year: "2026",
    topic: "feature-test",
    branch: "feature/test",
  };
  const manager = new CloneManager(home, runner);
  const snapshot = async (cwd = repo) => ({
    head: await git(["rev-parse", "HEAD"], cwd),
    branch: await git(["branch", "--show-current"], cwd),
    index: await fs
      .readFile(path.join(cwd, ".git/index"))
      .then((x) => x.toString("base64")),
    status: await git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    ),
    task: await fs
      .readFile(taskAt(cwd))
      .then((x) => x.toString("base64"))
      .catch(() => null),
  });
  return {
    root,
    repo,
    home,
    git,
    relative,
    taskAt,
    writeTask,
    calls,
    runner,
    service,
    project,
    identity,
    manager,
    snapshot,
  };
}
nativeDescribe(
  "autonomous selected-topic readiness with unchanged native read-only catalog",
  { timeout: 30000 },
  () => {
    it("admits fresh untracked selected task without requiring a commit or creating a clone", async () => {
      const f = await fixture();
      await f.writeTask("Uncommitted selected task\n");
      const rows = JSON.parse(
        (
          await f.runner.command(
            native,
            ["topics", "--year", "2026", "board", "--json", "--per-host"],
            f.repo,
          )
        ).stdout,
      );
      expect(
        rows.filter(
          (r: any) => r.branch === "feature/test" && r.topic === "feature-test",
        ),
      ).toHaveLength(1);
      const before = await f.snapshot();
      await expect(
        f.service.checkTopicContextReadiness(f.identity),
      ).resolves.toBeNull();
      expect(await f.snapshot()).toEqual(before);
      expect(f.calls.some((c) => c.args.includes("clone"))).toBe(false);
      expect(f.runner.start).not.toHaveBeenCalled();
    });
    it("admits existing ready empty catalog clone with an honest missing-local task", async () => {
      const f = await fixture();
      const owner = await f.manager.ensure(f.project, f.identity);
      await f.writeTask("Uncommitted selected task\n");
      const primary = await f.snapshot(),
        clone = await f.snapshot(owner.path);
      await expect(
        (f.service as any).checkTopicContextReadiness(
          worktreeContextRef(owner),
        ),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      await expect(
        f.service.readTopicTask({
          ...f.identity,
          context: worktreeContextRef(owner),
        }),
      ).resolves.toMatchObject({
        exists: false,
        text: "",
        catalogState: "missing-local-metadata",
      });
      expect(await f.snapshot()).toEqual(primary);
      expect(await f.snapshot(owner.path)).toEqual(clone);
      expect(
        (await f.service.resolveTopicContext(worktreeContextRef(owner))).state,
      ).toBe("ready");
    });
    it("keeps existing clone after source commit without refresh or losing unique commits", async () => {
      const f = await fixture();
      const owner = await f.manager.ensure(f.project, f.identity);
      await fs.writeFile(path.join(owner.path, "unique"), "keep\n");
      await f.git(["add", "unique"], owner.path);
      await f.git(["commit", "-m", "unique"], owner.path);
      await f.writeTask("Committed selected task\n");
      await f.git(["add", f.relative]);
      await f.git(["commit", "-m", "task"]);
      const before = await f.snapshot(owner.path);
      await expect(
        (f.service as any).checkTopicContextReadiness(
          worktreeContextRef(owner),
        ),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      expect(await f.snapshot(owner.path)).toEqual(before);
      expect(await fs.readFile(path.join(owner.path, "unique"), "utf8")).toBe(
        "keep\n",
      );
      expect(
        f.calls.filter(
          (c) =>
            c.cwd === owner.path &&
            c.args.some((a) => ["fetch", "merge", "reset", "pull"].includes(a)),
        ),
      ).toEqual([]);
    });
    it("allows committed source in fresh clone, exact slash branch/year and unrelated dirty files", async () => {
      const f = await fixture("Committed selected task\n");
      await fs.writeFile(path.join(f.repo, "unrelated"), "dirty\n");
      const before = await f.snapshot();
      const owner = await f.service.ensureTopicContext(f.identity);
      expect(
        (
          await (f.service as any).checkTopicContextReadiness(
            worktreeContextRef(owner),
          )
        ).contextId,
      ).toBe(owner.contextId);
      expect(
        (
          await f.service.readTopicTask({
            ...f.identity,
            context: worktreeContextRef(owner),
          })
        ).text,
      ).toBe("Committed selected task\n");
      expect(await f.snapshot()).toEqual(before);
      expect(f.runner.start).not.toHaveBeenCalled();
    });
  },
);

nativeDescribe(
  "selected task changes and clone authority",
  { timeout: 30000 },
  () => {
    it("ignores a primary edit and keeps both original and clone-own tasks", async () => {
      const f = await fixture("Base task\n");
      const owner = await f.manager.ensure(f.project, f.identity);
      await f.writeTask("Primary uncommitted task\n");
      await expect(
        (f.service as any).checkTopicContextReadiness(
          worktreeContextRef(owner),
        ),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      await f.writeTask("Clone independent edit\n", owner.path);
      const before = await f.snapshot(owner.path);
      expect(
        (
          await (f.service as any).checkTopicContextReadiness(
            worktreeContextRef(owner),
          )
        ).contextId,
      ).toBe(owner.contextId);
      expect(await f.snapshot(owner.path)).toEqual(before);
    });
    it("preserves a clone-own task commit despite source conflicts", async () => {
      const f = await fixture("Base task\n");
      const owner = await f.manager.ensure(f.project, f.identity);
      await f.writeTask("Clone independently committed task\n", owner.path);
      await f.git(["add", f.relative], owner.path);
      await f.git(["commit", "-m", "clone task"], owner.path);
      await f.writeTask("Source committed task\n");
      await f.git(["add", f.relative]);
      await f.git(["commit", "-m", "source task"]);
      const before = await f.snapshot(owner.path);
      await (f.service as any).checkTopicContextReadiness(
        worktreeContextRef(owner),
      );
      expect(await f.snapshot(owner.path)).toEqual(before);
    });
    it("preserves old unchanged task and unique unrelated clone commit", async () => {
      const f = await fixture("Base task\n");
      const owner = await f.manager.ensure(f.project, f.identity);
      await fs.writeFile(path.join(owner.path, "unique"), "keep\n");
      await f.git(["add", "unique"], owner.path);
      await f.git(["commit", "-m", "unique"], owner.path);
      await f.writeTask("New source committed task\n");
      await f.git(["add", f.relative]);
      await f.git(["commit", "-m", "source task"]);
      const before = await f.snapshot(owner.path);
      await expect(
        (f.service as any).checkTopicContextReadiness(
          worktreeContextRef(owner),
        ),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      expect(await f.snapshot(owner.path)).toEqual(before);
    });
    it("keeps empty clone task independent from nonempty uncommitted source", async () => {
      const f = await fixture("");
      const owner = await f.manager.ensure(f.project, f.identity);
      await f.writeTask("Do not lose this task\n");
      await expect(
        (f.service as any).checkTopicContextReadiness(
          worktreeContextRef(owner),
        ),
      ).resolves.toMatchObject({ contextId: owner.contextId });
    });
    it("does not attribute another branch's dirty working task to selected branch", async () => {
      const f = await fixture("Selected committed task\n");
      await f.git(["checkout", "-b", "other"]);
      await f.writeTask("Other branch edit\n");
      const before = await f.snapshot();
      const owner = await f.service.ensureTopicContext(f.identity);
      await (f.service as any).checkTopicContextReadiness(
        worktreeContextRef(owner),
      );
      expect(await f.snapshot()).toEqual(before);
    });
    it("admits missing selected data distinctly from ambiguity", async () => {
      const f = await fixture();
      const owner = await f.manager.ensure(f.project, f.identity);
      await expect(
        (f.service as any).checkTopicContextReadiness(
          worktreeContextRef(owner),
        ),
      ).resolves.toMatchObject({ contextId: owner.contextId });
    });
    for (const unsafe of ["symlink", "hardlink", "size", "utf8"] as const)
      it(`rejects unsafe clone task: ${unsafe}`, async () => {
        const f = await fixture();
        const owner = await f.manager.ensure(f.project, f.identity);
        await f.writeTask("Task\n", owner.path);
        f.calls.splice(0);
        if (unsafe === "symlink") {
          await fs.unlink(f.taskAt(owner.path));
          await fs.symlink(
            path.join(f.repo, ".goga/config.yml"),
            f.taskAt(owner.path),
          );
        }
        if (unsafe === "hardlink") {
          await fs.unlink(f.taskAt(owner.path));
          await fs.link(
            path.join(f.repo, ".goga/config.yml"),
            f.taskAt(owner.path),
          );
        }
        if (unsafe === "size")
          await fs.writeFile(f.taskAt(owner.path), "x".repeat(400001));
        if (unsafe === "utf8")
          await fs.writeFile(f.taskAt(owner.path), Buffer.from([0xff]));
        await expect(
          f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
        ).rejects.toThrow();
        expect(f.calls.some((c) => c.args.includes("clone"))).toBe(false);
      });
  },
);
nativeDescribe(
  "readiness identity and late-change safety",
  { timeout: 30000 },
  () => {
    it("accepts intentional committed empty task without inventing a description", async () => {
      const f = await fixture("");
      const owner = await f.manager.ensure(f.project, f.identity);
      await expect(
        f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      expect(
        (
          await f.service.readTopicTask({
            ...f.identity,
            context: worktreeContextRef(owner),
          })
        ).text,
      ).toBe("");
    });
    it("accepts an authored clone-only task without requiring a primary branch", async () => {
      const f = await fixture();
      const identity = {
        ...f.identity,
        branch: "clone/only",
        topic: "clone-only",
      };
      const owner = await f.manager.create(f.project, {
        year: "2026",
        branch: identity.branch,
        baseRef: "feature/test",
      });
      const file = path.join(
        owner.path,
        ".goga/history/2026/clone-only/todo.md",
      );
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "Clone-only authored task\n");
      await expect(
        f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      expect(
        (
          await f.service.readTopicTask({
            ...identity,
            context: worktreeContextRef(owner),
          })
        ).text,
      ).toBe("Clone-only authored task\n");
      await f.git(["add", ".goga/history/2026/clone-only/todo.md"], owner.path);
      await f.git(["commit", "-m", "own task"], owner.path);
      await expect(
        f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      expect(
        await f.git([
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/clone/only",
        ]),
      ).toBe("");
    });
    it("rechecks clone task after native clone catalog returns and fails on a late edit", async () => {
      const f = await fixture("Base task\n");
      const owner = await f.manager.ensure(f.project, f.identity);
      const original = f.runner.command.getMockImplementation()!;
      let changed = false;
      f.runner.command.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          const result = await original(...args);
          if (args[0] === native && args[2] === owner.path && !changed) {
            changed = true;
            await f.writeTask("Late clone task\n", owner.path);
          }
          return result;
        },
      );
      await expect(
        f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
      ).rejects.toThrow(/изменил.*провер|изменил.*чтен/i);
    });
    it("distinguishes duplicate native owners from missing metadata", async () => {
      const f = await fixture("Base task\n");
      const owner = await f.manager.ensure(f.project, f.identity);
      const original = f.runner.command.getMockImplementation()!;
      f.runner.command.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          const result = await original(...args);
          if (args[0] === native && args[2] === owner.path) {
            const rows = JSON.parse(result.stdout);
            return { ...result, stdout: JSON.stringify([...rows, ...rows]) };
          }
          return result;
        },
      );
      await expect(
        f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
      ).rejects.toThrow(/неоднозначен/i);
    });
  },
);
it.skipIf(!existsSync(native))(
  "keeps clone task authoritative even if source tracking ref advanced",
  { timeout: 30000 },
  async () => {
    const f = await fixture("Old task\n");
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.writeTask("New committed source task\n");
    await f.git(["add", f.relative]);
    await f.git(["commit", "-m", "new task"]);
    // Build a test-only descendant object and tracking ref without any source refresh.
    await f.writeTask("New committed source task\n", owner.path);
    await f.git(["add", f.relative], owner.path);
    const tree = (await f.git(["write-tree"], owner.path)).trim();
    const descendant = (
      await f.git(
        ["commit-tree", tree, "-p", "HEAD", "-m", "tracking descendant"],
        owner.path,
      )
    ).trim();
    await f.git(
      ["update-ref", "refs/remotes/desktop-source/feature/test", descendant],
      owner.path,
    );
    await f.git(["read-tree", "HEAD"], owner.path);
    await f.writeTask("Old task\n", owner.path);
    const before = await f.snapshot(owner.path);
    await expect(
      f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
    ).resolves.toMatchObject({ contextId: owner.contextId });
    expect(await f.snapshot(owner.path)).toEqual(before);
  },
);
it.skipIf(!existsSync(native))(
  "rejects same-text clone replacement during the readiness snapshot",
  { timeout: 30000 },
  async () => {
    const f = await fixture("Base task\n");
    const owner = await f.manager.ensure(f.project, f.identity);
    const original = f.runner.command.getMockImplementation()!;
    let replaced = false;
    f.runner.command.mockImplementation(
      async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (args[0] === native && args[2] === owner.path && !replaced) {
          replaced = true;
          await fs.writeFile(f.taskAt(owner.path) + ".new", "Base task\n");
          await fs.rename(f.taskAt(owner.path) + ".new", f.taskAt(owner.path));
        }
        return result;
      },
    );
    await expect(
      f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
    ).rejects.toThrow(/изменил.*провер|изменил.*чтен/i);
  },
);
it.skipIf(!existsSync(native))(
  "defensively checks the inherited exact clone owner when an internal task read omits context",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.writeTask("Uncommitted selected task\n");
    await expect(
      (f.service as any).snapshot(worktreeContextRef(owner), () =>
        f.service.readTopicTask({
          projectId: f.project.id,
          topic: f.identity.topic,
          branch: f.identity.branch,
        }),
      ),
    ).resolves.toMatchObject({
      exists: false,
      text: "",
      catalogState: "missing-local-metadata",
    });
  },
);

async function plannedFixture(task?: string) {
  const f = await fixture(task);
  const plan = path.join(f.repo, ".goga/history/2026/feature-test/plan.md");
  await fs.mkdir(path.dirname(plan), { recursive: true });
  await fs.writeFile(plan, "# Committed plan without mandatory todo\n");
  await f.git(["add", ".goga/history/2026/feature-test/plan.md"]);
  await f.git(["commit", "-m", "fixture plan"]);
  return f;
}
async function nativeRows(
  f: Awaited<ReturnType<typeof fixture>>,
  cwd = f.repo,
) {
  return JSON.parse(
    (
      await f.runner.command(
        native,
        ["topics", "--year", "2026", "board", "--json", "--per-host"],
        cwd,
      )
    ).stdout,
  );
}
nativeDescribe("catalog-known optional task data", { timeout: 30000 }, () => {
  it("allows fresh plan-only identity after exact native source catalog confirmation", async () => {
    const f = await plannedFixture();
    const before = await f.snapshot();
    expect(
      (await nativeRows(f)).filter(
        (r: any) =>
          r.branch === f.identity.branch && r.topic === f.identity.topic,
      ),
    ).toEqual([expect.objectContaining({ todo: null, statuses: ["planned"] })]);
    f.calls.splice(0);
    await expect(
      f.service.checkTopicContextReadiness(f.identity),
    ).resolves.toBeNull();
    expect(
      f.calls.some(
        (c) =>
          c.exe === native && c.cwd === f.repo && c.args.includes("--per-host"),
      ),
    ).toBe(true);
    expect(f.calls.some((c) => c.args.includes("clone"))).toBe(false);
    expect(await f.snapshot()).toEqual(before);
    const owner = await f.service.ensureTopicContext(f.identity);
    const ref = worktreeContextRef(owner);
    await expect(
      f.service.checkTopicContextReadiness(ref),
    ).resolves.toMatchObject({ contextId: owner.contextId });
    await expect(
      f.service.readTopicTask({
        projectId: f.project.id,
        context: ref,
        branch: ref.branch,
        topic: ref.topic,
      }),
    ).resolves.toMatchObject({ text: "", exists: false });
    expect(await f.snapshot()).toEqual(before);
    expect(f.runner.start).not.toHaveBeenCalled();
  });
  it("allows exact ready plan-only clone and defensive exists:false empty task without mutating either root", async () => {
    const f = await plannedFixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    const ref = worktreeContextRef(owner);
    expect(
      (await nativeRows(f, owner.path)).filter(
        (r: any) => r.branch === ref.branch && r.topic === ref.topic,
      ),
    ).toHaveLength(1);
    const before = {
      primary: await f.snapshot(),
      clone: await f.snapshot(owner.path),
    };
    await expect(
      f.service.checkTopicContextReadiness(ref),
    ).resolves.toMatchObject({ contextId: owner.contextId });
    await expect(
      f.service.readTopicTask({
        projectId: f.project.id,
        context: ref,
        branch: ref.branch,
        topic: ref.topic,
      }),
    ).resolves.toMatchObject({ text: "", exists: false, path: f.relative });
    expect({
      primary: await f.snapshot(),
      clone: await f.snapshot(owner.path),
    }).toEqual(before);
    expect(f.runner.start).not.toHaveBeenCalled();
  });
  it("admits exact plan-only clone without importing nonempty uncommitted source", async () => {
    const f = await plannedFixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.writeTask("Do not replace this uncommitted description\n");
    const before = {
      primary: await f.snapshot(),
      clone: await f.snapshot(owner.path),
    };
    await expect(
      f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
    ).resolves.toMatchObject({ contextId: owner.contextId });
    await expect(
      f.service.readTopicTask({
        projectId: f.project.id,
        context: worktreeContextRef(owner),
        branch: owner.branch,
        topic: owner.topic,
      }),
    ).resolves.toMatchObject({ exists: false, text: "" });
    expect({
      primary: await f.snapshot(),
      clone: await f.snapshot(owner.path),
    }).toEqual(before);
  });
  it("preserves absent clone todo and unique clone commit after source task commit", async () => {
    const f = await plannedFixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    await fs.writeFile(path.join(owner.path, "unique"), "keep\n");
    await f.git(["add", "unique"], owner.path);
    await f.git(["commit", "-m", "unique unrelated"], owner.path);
    await f.writeTask("New committed source description\n");
    await f.git(["add", f.relative]);
    await f.git(["commit", "-m", "source task"]);
    const before = await f.snapshot(owner.path);
    await expect(
      f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
    ).resolves.toMatchObject({ contextId: owner.contextId });
    expect(await f.snapshot(owner.path)).toEqual(before);
    expect(await fs.readFile(path.join(owner.path, "unique"), "utf8")).toBe(
      "keep\n",
    );
  });
  it("does not permit optional task absence for an unknown source catalog", async () => {
    const f = await fixture();
    await expect(
      f.service.checkTopicContextReadiness(f.identity),
    ).rejects.toThrow(/не найден/i);
    expect(f.calls.some((c) => c.exe === native && c.cwd === f.repo)).toBe(
      true,
    );
  });
  it("fails closed on ambiguous actual source catalog rows for an optional task", async () => {
    const f = await plannedFixture();
    const original = f.runner.command.getMockImplementation()!;
    f.runner.command.mockImplementation(
      async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (args[0] === native && args[2] === f.repo) {
          const rows = JSON.parse(result.stdout);
          return { ...result, stdout: JSON.stringify([...rows, ...rows]) };
        }
        return result;
      },
    );
    await expect(
      f.service.checkTopicContextReadiness(f.identity),
    ).rejects.toThrow(/неоднозначен/i);
  });
  it("allows source task appearance during optional-task catalog confirmation without importing it", async () => {
    const f = await plannedFixture();
    const original = f.runner.command.getMockImplementation()!;
    let changed = false;
    f.runner.command.mockImplementation(
      async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (args[0] === native && args[2] === f.repo && !changed) {
          changed = true;
          await f.writeTask("Late uncommitted source task\n");
        }
        return result;
      },
    );
    await expect(
      f.service.checkTopicContextReadiness(f.identity),
    ).resolves.toBeNull();
    expect(f.calls.some((c) => c.args.includes("clone"))).toBe(false);
  });
  it.each(["working", "committed", "source-empty"])(
    "preserves catalog-known clone-authored %s task deletion",
    async (kind) => {
      const f = await plannedFixture("Original committed task\n");
      const owner = await f.manager.ensure(f.project, f.identity);
      await fs.unlink(f.taskAt(owner.path));
      if (kind === "committed") {
        await f.git(["add", "-u", f.relative], owner.path);
        await f.git(["commit", "-m", "own task deletion"], owner.path);
      }
      if (kind === "source-empty") await f.writeTask("");
      const before = {
        primary: await f.snapshot(),
        clone: await f.snapshot(owner.path),
      };
      await expect(
        f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
      ).resolves.toMatchObject({ contextId: owner.contextId });
      await expect(
        f.service.readTopicTask({
          projectId: f.project.id,
          context: worktreeContextRef(owner),
          branch: owner.branch,
          topic: owner.topic,
        }),
      ).resolves.toMatchObject({ exists: false, text: "" });
      expect({
        primary: await f.snapshot(),
        clone: await f.snapshot(owner.path),
      }).toEqual(before);
    },
  );
  it("preserves clone-owned deletion against nonempty uncommitted source", async () => {
    const f = await plannedFixture("Original committed task\n");
    const owner = await f.manager.ensure(f.project, f.identity);
    await fs.unlink(f.taskAt(owner.path));
    await f.writeTask("Nonempty uncommitted source task\n");
    await expect(
      f.service.checkTopicContextReadiness(worktreeContextRef(owner)),
    ).resolves.toMatchObject({ contextId: owner.contextId });
  });
});
