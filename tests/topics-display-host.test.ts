import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
import { EventEmitter } from "node:events";
import { TerminalSessions } from "../src/host/terminal-sessions";
import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  rename,
  access,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HostService } from "../src/host/service";
import { NodeRunner, type Runner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { withReadScope } from "../src/host/read-scope";
import { topicOperationSchema } from "../src/shared/topics-schema";
const target = { topic: "feature-test", branch: "feature/test", remote: false };
async function fixture(options: { simulateTopicDeletion?: boolean } = {}) {
  const root = await mkdtemp("/private/tmp/goga-display-");
  fixtureScope().cleanup(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"),
    home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const node = fixtureScope.runner(
    new NodeRunner(120000, {
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    }),
  );
  fixtureScope().cleanup(() => node.dispose());
  const git = (...args: string[]) =>
    node.command(
      "git",
      ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
      repo,
    );
  await git("init", "-b", target.branch);
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  const relative = ".goga/history/2026/feature-test/todo.md";
  const task = (cwd = repo) => path.join(cwd, relative);
  await mkdir(path.dirname(task()), { recursive: true });
  await writeFile(task(), "Committed task\n");
  // Deliberately no topics.base_ref, display must not need mutation configuration.
  await git("add", ".");
  await git("commit", "-m", "fixture");
  const rows = [
    {
      ...target,
      current: true,
      statuses: ["todo", "design"],
      todo: "Committed task",
      divergence: null,
      hosts: [target.branch],
    },
  ];
  const boards = new Map<string, typeof rows>();
  const calls: { exe: string; args: string[]; cwd: string }[] = [];
  let beforeCall:
    ((exe: string, args: string[], cwd: string) => void) | undefined;
  let afterCall:
    ((exe: string, args: string[], cwd: string) => Promise<void>) | undefined;
  const runner: Runner = {
    start: node.start.bind(node),
    kill: node.kill.bind(node),
    command: async (exe, args, cwd, env, input) => {
      beforeCall?.(exe, args, cwd);
      calls.push({ exe, args, cwd });
      if (
        options.simulateTopicDeletion &&
        exe !== "git" &&
        args[3] === "delete"
      )
        await node.command("git", ["branch", "-D", target.branch], cwd);
      const boardRows = boards.get(cwd) ?? rows;
      const result =
        exe === "git"
          ? await node.command(exe, args, cwd, env, input)
          : {
              stdout: JSON.stringify(
                args.includes("--per-host")
                  ? boardRows.map(({ hosts: _hosts, ...row }) => row)
                  : boardRows,
              ),
              stderr: "",
            };
      await afterCall?.(exe, args, cwd);
      return result;
    },
  };
  const service = fixtureScope().own(
    new HostService({
      home,
      dataDir: path.join(root, "data"),
      goga: "mock-goga",
      trashItem: async (source) => {
        await rename(source, path.join(root, "trashed-clone"));
      },
      runner,
    }),
  );
  fixtureScope().cleanup(() => service.dispose());
  const project = await service.addProject(repo);
  const manager = new CloneManager(home, runner);
  const identity = {
    projectId: project.id,
    year: "2026",
    topic: target.topic,
    branch: target.branch,
  };
  return {
    root,
    repo,
    home,
    git,
    task,
    rows,
    boards,
    calls,
    service,
    project,
    manager,
    identity,
    beforeCall: (fn: typeof beforeCall) => {
      beforeCall = fn;
    },
    afterCall: (fn: typeof afterCall) => {
      afterCall = fn;
    },
  };
}
it(
  "reads one aggregate local board only and returns display-only statuses without mutation authority",
  fixtureScope.run(async () => {
    const f = await fixture();
    const full = vi.spyOn(f.service, "readTopicBoard");
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(f.calls.filter((c) => c.exe !== "git")).toEqual([
      {
        exe: "mock-goga",
        cwd: f.repo,
        args: ["topics", "--year", "2026", "board", "--json"],
      },
    ]);
    expect(full).not.toHaveBeenCalled();
    expect(table.entries[0]?.statuses).toEqual(["todo", "design"]);
    expect(table.currentTopic).toEqual(target);
    expect(table.revision).toMatch(/^display:/);
    expect(
      topicOperationSchema.safeParse({
        projectId: f.project.id,
        year: "2026",
        expectedRevision: table.revision,
        action: "delete",
        topics: [target.topic],
      }).success,
    ).toBe(false);
    expect(
      f.calls.some((c) => c.args.includes("diff") || c.args.includes("status")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it(
  "reads exactly one aggregate per ready owner and replaces stale primary statuses",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    f.boards.set(owner.path, [{ ...f.rows[0]!, statuses: ["done"] }]);
    f.calls.length = 0;
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(table.entries[0]?.statuses).toEqual(["done"]);
    expect(
      f.calls.filter((c) => c.exe !== "git").map((c) => [c.cwd, c.args]),
    ).toEqual([
      [f.repo, ["topics", "--year", "2026", "board", "--json"]],
      [owner.path, ["topics", "--year", "2026", "board", "--json"]],
    ]);
  }),
  gitIntegrationBudget(15000),
);
it(
  "keeps clone-only inventory with unknown status when local metadata is empty",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    f.rows.length = 0;
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(table.entries).toEqual([
      {
        ...target,
        current: false,
        statuses: [],
        todo: null,
        divergence: null,
        hosts: [target.branch],
      },
    ]);
    expect(table.entries[0]?.statusError).toBeUndefined();
  }),
  gitIntegrationBudget(15000),
);
it.each(["missing", "error"] as const)(
  "never falls back to stale primary statuses for %s owners",
  fixtureScope.run(async (kind) => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    if (kind === "missing")
      await rm(owner.path, { recursive: true, force: true });
    else
      f.afterCall(async (exe, _args, cwd) => {
        if (exe !== "git" && cwd === owner.path)
          throw Error("secret backend error /private/path");
      });
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(table.entries[0]?.statuses).toEqual([]);
    expect(table.entries[0]?.statusError).toBeTruthy();
    expect(table.entries[0]?.statusError).not.toMatch(/secret|private/);
    expect(table.records[0]?.statusError).toBe(table.entries[0]?.statusError);
  }),
  gitIntegrationBudget(15000),
);
it(
  "limits concurrent owner aggregate reads to three without loading full boards",
  fixtureScope.run(async () => {
    const f = await fixture();
    for (let n = 0; n < 4; n++) {
      const topic = `owned-${n}`;
      await f.git("branch", topic);
      const owner = await f.manager.ensure(f.project, {
        ...f.identity,
        topic,
        branch: topic,
      });
      f.boards.set(owner.path, [
        {
          ...f.rows[0]!,
          topic,
          branch: topic,
          hosts: [topic],
          statuses: ["done"],
        },
      ]);
    }
    let active = 0,
      maximum = 0;
    let release!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.afterCall(async (exe, _args, cwd) => {
      if (exe === "git" || cwd === f.repo) return;
      maximum = Math.max(maximum, ++active);
      if (active === 3) release();
      await firstBatch;
      active--;
    });
    f.calls.length = 0;
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(f.calls.filter((c) => c.exe !== "git")).toHaveLength(5);
    expect(
      table.entries.filter((row) => row.topic.startsWith("owned-")),
    ).toHaveLength(4);
  }),
  gitIntegrationBudget(15000),
);
it(
  "reads committed primary task without Goga or full board, ignoring uncommitted primary edits",
  fixtureScope.run(async () => {
    const f = await fixture();
    await writeFile(f.task(), "Uncommitted primary text");
    const full = vi.spyOn(f.service, "readTopicBoard");
    const result = await f.service.readTopicOverview(
      f.project.id,
      "2026",
      target,
    );
    expect(result.text).toBe("Committed task\n");
    expect(result.editable).toBe(false);
    expect(result.version).toMatch(/^[a-f0-9]{64}$/);
    expect(full).not.toHaveBeenCalled();
    expect(f.calls.filter((c) => c.exe !== "git")).toEqual([]);
  }),
  gitIntegrationBudget(15000),
);
it(
  "reads owner working task without Goga and never falls back to primary for missing/stale owners",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity),
      ref = worktreeContextRef(owner);
    await writeFile(f.task(owner.path), "Owner working task\n");
    f.calls.length = 0;
    const result = await f.service.readTopicOverview(ref, "2026", target);
    expect(result.text).toBe("Owner working task\n");
    expect(result.editable).toBe(true);
    expect(f.calls.filter((c) => c.exe !== "git")).toEqual([]);
    await expect(
      f.service.readTopicOverview(
        { ...ref, revision: randomUUID() },
        "2026",
        target,
      ),
    ).rejects.toThrow();
    await expect(
      f.service.readTopicOverview(ref, "2025", target),
    ).rejects.toThrow();
    await expect(
      f.service.readTopicOverview(f.project.id, "2026", target),
    ).rejects.toThrow(/контекст|копи|владел/i);
    await rm(owner.path, { recursive: true, force: true });
    await expect(
      f.service.readTopicOverview(ref, "2026", target),
    ).rejects.toThrow();
    await expect(
      f.service.readTopicOverview(f.project.id, "2026", target),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "rejects task symlinks and changed owner identity during overview",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity),
      ref = worktreeContextRef(owner);
    const task = f.task(owner.path);
    await rm(task);
    await symlink(f.task(), task);
    await expect(
      f.service.readTopicOverview(ref, "2026", target),
    ).rejects.toThrow();
    await rm(task);
    await writeFile(task, "Owner task");
    let changed = false;
    f.afterCall(async (_exe, args, cwd) => {
      if (!changed && cwd === owner.path && args.includes("for-each-ref")) {
        changed = true;
        await rm(owner.path, { recursive: true, force: true });
      }
    });
    await expect(
      f.service.readTopicOverview(ref, "2026", target),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it.each(["table", "overview"] as const)(
  "rejects cancelled %s even when the transport returns data",
  fixtureScope.run(async (kind) => {
    const f = await fixture(),
      controller = new AbortController();
    f.afterCall(async (exe, args) => {
      if (kind === "table" ? exe !== "git" : args.includes("ls-tree"))
        controller.abort();
    });
    await expect(
      withReadScope(controller.signal, () =>
        kind === "table"
          ? f.service.readTopicTable(f.project.id, "2026")
          : f.service.readTopicOverview(f.project.id, "2026", target),
      ),
    ).rejects.toThrow(/отмен/i);
  }),
  gitIntegrationBudget(15000),
);
it(
  "validates table schema and primary-only scope instead of accepting remote or malformed local summaries",
  fixtureScope.run(async () => {
    const f = await fixture();
    f.rows.push({
      ...f.rows[0]!,
      topic: "remote",
      branch: "origin/remote",
      remote: true,
    });
    expect(
      (await f.service.readTopicTable(f.project.id, "2026")).entries,
    ).toHaveLength(1);
    (f.rows[0] as any).statuses = [42];
    await expect(
      f.service.readTopicTable(f.project.id, "2026"),
    ).rejects.toThrow(/JSON|каталог/);
    await expect(
      f.service.readTopicTable(f.identity as any, "2026"),
    ).rejects.toThrow();
    await expect(
      f.service.readTopicTable(f.project.id, "../2026"),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "rejects primary task ref changes and does not read an injected path",
  fixtureScope.run(async () => {
    const f = await fixture();
    let changed = false;
    f.afterCall(async (_exe, args) => {
      if (!changed && args.includes("ls-tree")) {
        changed = true;
        await f.git("commit", "--allow-empty", "-m", "changed");
      }
    });
    await expect(
      f.service.readTopicOverview(f.project.id, "2026", target),
    ).rejects.toThrow(/измен/i);
    await expect(
      f.service.readTopicOverview(f.project.id, "2026", {
        ...target,
        topic: "../secret",
      }),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);

it.each(["table", "overview"] as const)(
  "rejects %s when an owner appears during the read",
  fixtureScope.run(async (kind) => {
    const f = await fixture();
    let appeared = false;
    f.afterCall(async (exe, args) => {
      if (
        !appeared &&
        (kind === "table" ? exe !== "git" : args.includes("ls-tree"))
      ) {
        appeared = true;
        await f.manager.ensure(f.project, f.identity);
      }
    });
    await expect(
      kind === "table"
        ? f.service.readTopicTable(f.project.id, "2026")
        : f.service.readTopicOverview(f.project.id, "2026", target),
    ).rejects.toThrow(/контекст|копи|каталог/i);
  }),
  gitIntegrationBudget(15000),
);

it.each(["ready", "missing"] as const)(
  "blocks primary deletion of a %s managed owner during preparation",
  fixtureScope.run(async (state) => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    if (state === "missing")
      await rm(owner.path, { recursive: true, force: true });
    const board = await f.service.readTopicBoard(f.project.id, "2026");
    await expect(
      f.service.prepareTopicOperation({
        projectId: f.project.id,
        year: "2026",
        expectedRevision: board.revision,
        action: "delete",
        ...(state === "ready" ? { target } : { topics: [target.topic] }),
      }),
    ).rejects.toThrow(/рабоч|контекст|владел/i);
    expect(f.calls.some((c) => c.args.includes("delete"))).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it.each(["before-execute", "during-validation"] as const)(
  "rejects primary deletion when a managed owner appears %s after preparation without invoking delete",
  fixtureScope.run(async (when) => {
    const f = await fixture();
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    const board = await f.service.readTopicBoard(f.project.id, "2026");
    const plan = await f.service.prepareTopicOperation({
      projectId: f.project.id,
      year: "2026",
      expectedRevision: board.revision,
      action: "delete",
      topics: [target.topic],
    });
    if (when === "before-execute")
      await f.manager.ensure(f.project, f.identity);
    else {
      let appeared = false;
      f.afterCall(async (_exe, args) => {
        if (!appeared && args[0] === "worktree") {
          appeared = true;
          await f.manager.ensure(f.project, f.identity);
        }
      });
    }
    f.calls.length = 0;
    await expect(f.service.executeTopicOperation(plan.token)).rejects.toThrow(
      /рабоч|контекст|владел/i,
    );
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    expect((await f.git("branch", "--list", target.branch)).stdout).toContain(
      target.branch,
    );
  }),
  gitIntegrationBudget(15000),
);

it.each(["ready", "missing"] as const)(
  "rejects primary update for an existing %s managed owner",
  fixtureScope.run(async (state) => {
    const f = await fixture();
    await f.git("branch", "base");
    const owner = await f.manager.ensure(f.project, f.identity);
    if (state === "missing")
      await rm(owner.path, { recursive: true, force: true });
    const board = await f.service.readTopicBoard(f.project.id, "2026");
    await expect(
      f.service.prepareTopicOperation({
        projectId: f.project.id,
        year: "2026",
        expectedRevision: board.revision,
        action: "update",
        target,
        baseRef: "base",
      }),
    ).rejects.toThrow(/рабоч|контекст|владел/i);
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("update")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it.each(["before-execute", "during-validation"] as const)(
  "rejects primary update when an owner appears %s after preparation",
  fixtureScope.run(async (when) => {
    const f = await fixture();
    await f.git("branch", "base");
    const board = await f.service.readTopicBoard(f.project.id, "2026");
    const plan = await f.service.prepareTopicOperation({
      projectId: f.project.id,
      year: "2026",
      expectedRevision: board.revision,
      action: "update",
      target,
      baseRef: "base",
    });
    if (when === "before-execute")
      await f.manager.ensure(f.project, f.identity);
    else {
      let appeared = false;
      f.afterCall(async (_exe, args) => {
        if (!appeared && args[0] === "worktree") {
          appeared = true;
          await f.manager.ensure(f.project, f.identity);
        }
      });
    }
    f.calls.length = 0;
    await expect(f.service.executeTopicOperation(plan.token)).rejects.toThrow(
      /рабоч|контекст|владел/i,
    );
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("update")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it(
  "continues to permit primary update when no owner exists",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git("branch", "base");
    const board = await f.service.readTopicBoard(f.project.id, "2026");
    const plan = await f.service.prepareTopicOperation({
      projectId: f.project.id,
      year: "2026",
      expectedRevision: board.revision,
      action: "update",
      target,
      baseRef: "base",
    });
    expect((await f.service.executeTopicOperation(plan.token)).status).toBe(
      "success",
    );
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("update")),
    ).toBe(true);
  }),
  gitIntegrationBudget(15000),
);

it(
  "preserves display divergence and primary placements while stripping task previews",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    f.rows[0]!.todo = "PRIMARY PRIVATE TASK PREVIEW";
    (f.rows[0] as any).divergence = "propagated";
    f.rows[0]!.hosts = [target.branch, "other-host"];
    f.boards.set(owner.path, [
      {
        ...f.rows[0]!,
        todo: "OWNER PRIVATE TASK PREVIEW",
        statuses: ["done"],
        divergence: "need-update" as any,
        hosts: [target.branch, "clone-only-host"],
      },
    ]);
    f.rows.push({
      ...f.rows[0]!,
      topic: "primary-only",
      branch: "primary-only",
    });
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(table.entries[0]).toMatchObject({
      statuses: ["done"],
      todo: null,
      divergence: "need-update",
      hosts: [target.branch, "other-host"],
    });
    expect(table.entries[1]).toMatchObject({
      todo: null,
      divergence: "propagated",
      hosts: [target.branch, "other-host"],
    });
    expect(table.records[0]).toMatchObject({
      todo: null,
      divergence: "need-update",
    });
    expect(JSON.stringify(table)).not.toMatch(
      /PRIVATE TASK PREVIEW|clone-only-host/,
    );
  }),
  gitIntegrationBudget(15000),
);
it(
  "preserves clone-only placements and divergence from its exact owner",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    f.boards.set(owner.path, [
      {
        ...f.rows[0]!,
        divergence: "up-to-date" as any,
        hosts: [target.branch, "local-placement"],
      },
    ]);
    f.rows.length = 0;
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(table.entries[0]).toMatchObject({
      divergence: "up-to-date",
      hosts: [target.branch, "local-placement"],
    });
  }),
  gitIntegrationBudget(15000),
);
it.each(["missing", "ambiguous"] as const)(
  "keeps primary placements but not stale divergence for %s owners",
  fixtureScope.run(async (kind) => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    (f.rows[0] as any).divergence = "propagated";
    f.rows[0]!.hosts = [target.branch, "main"];
    if (kind === "missing")
      await rm(owner.path, { recursive: true, force: true });
    else
      vi.spyOn((f.service as any).clones, "list").mockResolvedValue([
        owner,
        { ...owner, contextId: randomUUID() },
      ]);
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(table.entries[0]).toMatchObject({
      statuses: [],
      divergence: null,
      hosts: [target.branch, "main"],
    });
    expect(table.entries[0]?.statusError).toBeTruthy();
  }),
  gitIntegrationBudget(15000),
);
it(
  "does not degrade a cancelled owner read into a status error",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    const controller = new AbortController();
    f.afterCall(async (exe, _args, cwd) => {
      if (exe !== "git" && cwd === owner.path) controller.abort();
    });
    await expect(
      withReadScope(controller.signal, () =>
        f.service.readTopicTable(f.project.id, "2026"),
      ),
    ).rejects.toThrow(/отмен/i);
  }),
  gitIntegrationBudget(15000),
);

it(
  "marks multiple owners of the same topic and branch unknown without querying an arbitrary owner",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    const duplicate = {
      ...owner,
      contextId:
        owner.contextId.slice(0, -1) +
        (owner.contextId.endsWith("a") ? "b" : "a"),
    };
    vi.spyOn((f.service as any).clones, "list").mockResolvedValue([
      duplicate,
      owner,
    ]);
    f.boards.set(owner.path, [{ ...f.rows[0]!, statuses: ["done"] }]);
    f.calls.length = 0;
    const table = await f.service.readTopicTable(f.project.id, "2026");
    expect(table.entries).toHaveLength(1);
    expect(table.entries[0]?.statuses).toEqual([]);
    expect(table.entries[0]?.statusError).toMatch(/неоднознач/i);
    expect(f.calls.filter((c) => c.exe !== "git")).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "trashes selected owner before primary topic removal and requires an explicit primary switch",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    await f.service.selectTopicContext(worktreeContextRef(owner));
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    expect(plan).toMatchObject({
      clonePath: owner.path,
      aheadCount: 0,
      requiresAheadConfirmation: false,
    });
    const result = await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(result.status).toBe("success");
    expect(result).toMatchObject({
      stage: "clone-trashed",
      cloneRemoved: true,
    });
    expect((await f.git("branch", "--list", target.branch)).stdout).toContain(
      target.branch,
    );
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    await expect(
      f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).rejects.toThrow(/основн|выбран/);
    await f.service.selectTopicContext(null);
    expect(
      await f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({
      status: "success",
      stage: "completed",
      cloneRemoved: true,
    });
    expect((await f.git("branch", "--list", target.branch)).stdout).toBe("");
    await expect(access(owner.path)).rejects.toThrow();
    await expect(
      access(path.join(f.root, "trashed-clone", ".git")),
    ).resolves.toBeUndefined();
    expect((await f.manager.list(f.project.id))[0]?.deletedAt).toBeTruthy();
  }),
  gitIntegrationBudget(15000),
);
it.each(["second-owner", "wrong-stage", "wrong-revision"] as const)(
  "does not widen confirmed context deletion exemption for %s",
  fixtureScope.run(async (fault) => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    const clones = (f.service as any).clones as CloneManager;
    const list = clones.list.bind(clones);
    vi.spyOn(clones, "list").mockImplementation(async (projectId) => {
      const rows = await list(projectId);
      if (fault === "wrong-stage")
        return rows.map((row) => ({ ...row, state: "conflict" as const }));
      if (fault === "wrong-revision")
        return rows.map((row) => ({ ...row, revision: randomUUID() }));
      return [
        ...rows,
        {
          ...owner,
          contextId:
            owner.contextId.slice(0, -1) +
            (owner.contextId.endsWith("a") ? "b" : "a"),
        },
      ];
    });
    f.calls.length = 0;
    const result = await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(result.status).toBe("failed");
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    await expect(access(owner.path)).resolves.toBeUndefined();
    expect((await f.git("branch", "--list", target.branch)).stdout).toContain(
      target.branch,
    );
  }),
  gitIntegrationBudget(15000),
);

it.each(["checked-out", "external-remote"] as const)(
  "checks %s safety before trash",
  fixtureScope.run(async (fault) => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    if (fault === "external-remote") {
      await f.git("switch", "-c", "main");
      f.rows[0]!.current = false;
      await f.git("update-ref", "refs/remotes/origin/" + target.branch, "HEAD");
    }
    if (fault === "checked-out") {
      const choice = await f.service.prepareContextDeletion(
        worktreeContextRef(owner),
      );
      expect(choice).toMatchObject({
        stage: "choose-branch",
        token: "",
        switchBranches: [],
      });
      await expect(
        f.service.deleteContext({
          projectId: f.project.id,
          token: choice.token,
        }),
      ).rejects.toThrow();
    } else {
      await expect(
        f.service.prepareContextDeletion(worktreeContextRef(owner)),
      ).rejects.toThrow();
    }
    await expect(access(owner.path)).resolves.toBeUndefined();
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it(
  "keeps metadata failure recoverable without retrashing and rejects foreign project tokens",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    await expect(
      f.service.deleteContext({ projectId: "foreign", token: plan.token }),
    ).rejects.toThrow();
    expect(
      await f.service.deleteContext({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ cloneRemoved: true });
    const domain = (f.service as any).topicDomain;
    const execute = vi
      .spyOn(domain, "execute")
      .mockRejectedValueOnce(Error("metadata failure"));
    expect(
      await f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ status: "partial", cloneRemoved: true });
    const tombstone = (await f.service.listTopicContexts(f.project.id)).find(
      (r) => r.contextId === owner.contextId,
    )!;
    expect(tombstone.deletedAt).toBeTruthy();
    expect(
      await f.service.contextDeletionRecovery(worktreeContextRef(tombstone)),
    ).toMatchObject({ token: plan.token, stage: "removing-topic" });
    expect(
      await f.service.deleteContext({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ cloneRemoved: true });
    execute.mockRestore();
    expect(
      await f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ status: "success" });
    expect(
      await f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ status: "success" });
    expect(
      f.calls.filter((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "will not remove a primary branch changed after trash",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    await writeFile(path.join(f.repo, "new-primary"), "new work\n");
    await f.git("add", ".");
    await f.git("commit", "-m", "new primary work");
    await f.git("branch", "-f", target.branch, "HEAD");
    const result = await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(result).toMatchObject({ status: "partial", cloneRemoved: true });
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    expect((await f.git("branch", "--list", target.branch)).stdout).toContain(
      target.branch,
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "recovers a lost native deletion acknowledgement without running Goga or trash twice",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    f.afterCall(async (exe, args) => {
      if (exe !== "git" && args.includes("delete"))
        throw Error("lost native acknowledgement");
    });
    expect(
      await f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ status: "partial", cloneRemoved: true });
    expect((await f.git("branch", "--list", target.branch)).stdout).toBe("");
    f.afterCall(async () => {});
    expect(
      await f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ status: "success", cloneRemoved: true });
    expect(
      f.calls.filter((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it.each([false, true])(
  "deletes clone-only topic with explicit ahead consent; newly appearing primary topic blocks finish: %s",
  fixtureScope.run(async (appeared) => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.create(f.project, {
      year: "2026",
      branch: "new-only",
      baseRef: target.branch,
    });
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    expect(plan.requiresAheadConfirmation).toBe(true);
    expect(plan.aheadCount).toBeGreaterThan(0);
    await expect(
      f.service.deleteContext({ projectId: f.project.id, token: plan.token }),
    ).rejects.toThrow(/подтверд/i);
    expect(
      await f.service.deleteContext({
        projectId: f.project.id,
        token: plan.token,
        allowAhead: true,
      }),
    ).toMatchObject({ cloneRemoved: true });
    if (appeared) {
      await mkdir(path.join(f.repo, ".goga/history/2026/new-only"), {
        recursive: true,
      });
      await writeFile(
        path.join(f.repo, ".goga/history/2026/new-only/todo.md"),
        "new independent data\n",
      );
    }
    const result = await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(result.status).toBe(appeared ? "partial" : "success");
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it(
  "rejects a same-slug but differently named primary branch before trash",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    await f.git("branch", "-m", target.branch, target.topic);
    await expect(
      f.service.prepareContextDeletion(worktreeContextRef(owner)),
    ).rejects.toThrow();
    await expect(access(owner.path)).resolves.toBeUndefined();
  }),
  gitIntegrationBudget(15000),
);

it(
  "does not delete newly added primary history files after clone trash",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    await f.git("rm", "-r", ".goga/history");
    await f.git("commit", "-m", "main without topic history");
    const directory = path.join(f.repo, ".goga/history/2026", target.topic);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "existing.md"),
      "previous primary data\n",
    );
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    await writeFile(path.join(directory, "new.md"), "valuable newer data\n");
    expect(
      await f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).toMatchObject({ status: "partial", cloneRemoved: true });
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    await expect(
      access(path.join(directory, "new.md")),
    ).resolves.toBeUndefined();
  }),
  gitIntegrationBudget(15000),
);

it(
  "rechecks pinned primary history after finish board preparation before native deletion",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    const owner = await f.manager.ensure(f.project, f.identity);
    await f.git("switch", "-c", "main");
    f.rows[0]!.current = false;
    await f.git("rm", "-r", ".goga/history");
    await f.git("commit", "-m", "main without topic history");
    const directory = path.join(f.repo, ".goga/history/2026", target.topic);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "existing.md"),
      "confirmed primary data\n",
    );
    const plan = await f.service.prepareContextDeletion(
      worktreeContextRef(owner),
    );
    await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    let injected = false;
    f.afterCall(async (exe, args, cwd) => {
      if (
        !injected &&
        exe !== "git" &&
        cwd === f.repo &&
        args.includes("board")
      ) {
        injected = true;
        await writeFile(
          path.join(directory, "late.md"),
          "new data during finish preparation\n",
        );
      }
    });
    const result = await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(injected).toBe(true);
    expect(result).toMatchObject({ status: "partial", cloneRemoved: true });
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    await expect(
      access(path.join(directory, "late.md")),
    ).resolves.toBeUndefined();
    expect((await f.git("branch", "--list", target.branch)).stdout).toContain(
      target.branch,
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "deletes the selected topic when primary is on its branch: choose, preview, trash, leave, checkout, Goga",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    await f.git("switch", "-c", "main");
    await f.git("rm", ".goga/history/2026/feature-test/todo.md");
    await writeFile(path.join(f.repo, "base-file"), "base branch content");
    await f.git("add", "base-file");
    await f.git("commit", "-m", "different base tree");
    await f.git("switch", "feature/test");
    const owner = await f.manager.ensure(f.project, f.identity),
      ref = worktreeContextRef(owner);
    await f.service.selectTopicContext(ref);
    const choice = await f.service.prepareContextDeletion(ref);
    expect(choice).toMatchObject({
      stage: "choose-branch",
      token: "",
      switchBranches: ["main"],
    });
    const plan = await f.service.prepareContextDeletion(ref, "main");
    expect(plan).toMatchObject({ stage: "prepared", switchBranch: "main" });
    expect((await f.git("branch", "--show-current")).stdout.trim()).toBe(
      "feature/test",
    );
    expect(
      (
        await f.service.deleteContext({
          projectId: f.project.id,
          token: plan.token,
        })
      ).cloneRemoved,
    ).toBe(true);
    expect((await f.git("branch", "--show-current")).stdout.trim()).toBe(
      "feature/test",
    );
    await expect(
      f.service.finishContextDeletion({
        projectId: f.project.id,
        token: plan.token,
      }),
    ).rejects.toThrow(/основн|выбран/);
    await f.service.selectTopicContext(null);
    const result = await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(result).toMatchObject({ status: "success", stage: "completed" });
    expect((await f.git("branch", "--show-current")).stdout.trim()).toBe(
      "main",
    );
    const mutation = f.calls.find(
      (c) => c.exe !== "git" && c.args.includes("delete"),
    );
    expect(mutation?.cwd).toBe(f.repo);
    expect((await f.git("branch", "--list", "feature/test")).stdout).toBe("");
    await expect(
      access(path.join(f.root, "trashed-clone", ".git")),
    ).resolves.toBeUndefined();
  }),
  gitIntegrationBudget(15000),
);
it.each(["delete-ack", "switch-ack"] as const)(
  "keeps an interrupted %s safe without repeating checkout",
  fixtureScope.run(async (fault) => {
    const f = await fixture({ simulateTopicDeletion: true });
    await f.git("branch", "main");
    const owner = await f.manager.ensure(f.project, f.identity),
      ref = worktreeContextRef(owner);
    const plan = await f.service.prepareContextDeletion(ref, "main");
    await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    await f.service.selectTopicContext(null);
    let injected = false;
    f.afterCall(async (exe, args) => {
      if (
        !injected &&
        (fault === "delete-ack"
          ? exe !== "git" && args.includes("delete")
          : exe === "git" && args.includes("switch"))
      ) {
        injected = true;
        throw Error("fixture lost acknowledgement");
      }
    });
    const first = await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(first).toMatchObject({ status: "partial", cloneRemoved: true });
    expect((await f.git("branch", "--show-current")).stdout.trim()).toBe(
      "main",
    );
    const switches = () =>
      f.calls.filter((c) => c.exe === "git" && c.args.includes("switch"))
        .length;
    expect(switches()).toBe(1);
    const second = await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(switches()).toBe(1);
    expect(second.status).toBe(fault === "delete-ack" ? "success" : "partial");
    if (fault === "switch-ack") {
      expect(second.message).toMatch(/ручная проверка/);
      expect(
        f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
      ).toBe(false);
    }
  }),
  gitIntegrationBudget(15000),
);
it(
  "does not adopt new primary history created between checkout and snapshot rebasing",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    await f.git("switch", "-c", "main");
    await f.git("rm", ".goga/history/2026/feature-test/todo.md");
    await f.git("commit", "-m", "base without topic");
    await f.git("switch", "feature/test");
    const owner = await f.manager.ensure(f.project, f.identity),
      ref = worktreeContextRef(owner);
    const plan = await f.service.prepareContextDeletion(ref, "main");
    await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    await f.service.selectTopicContext(null);
    let switched = false,
      injected = false;
    const late = path.join(f.repo, ".goga/history/2026/feature-test/late.md");
    f.afterCall(async (exe, args) => {
      if (exe === "git" && args.includes("switch")) switched = true;
      if (
        switched &&
        !injected &&
        args.includes("--format=%(refname)%00%(objectname)")
      ) {
        injected = true;
        await mkdir(path.dirname(late), { recursive: true });
        await writeFile(late, "late user data");
      }
    });
    const result = await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(injected).toBe(true);
    expect(result.status).toBe("partial");
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    await expect(access(late)).resolves.toBeUndefined();
  }),
  gitIntegrationBudget(15000),
);

async function deletionTerminals(f: Awaited<ReturnType<typeof fixture>>) {
  let busy = false;
  let onStop = async (_cwd: string) => {};
  const stopped: string[] = [];
  const sessions = new TerminalSessions({
    acquire: async (scope) => {
      const lease = await f.service.acquireTerminalContext(scope, {
        accountShell: () => "/bin/zsh",
        inherited: { HOME: f.home },
      });
      lease.launch.activity = { idle: () => !busy, input: () => {} };
      return lease;
    },
    spawn: (launch) => {
      const emitter = new EventEmitter();
      const subscription = (event: string, fn: (...args: any[]) => void) => {
        emitter.on(event, fn);
        return {
          dispose: () => {
            emitter.off(event, fn);
          },
        };
      };
      return {
        cwd: launch.cwd,
        emitter,
        assertReady() {},
        pause() {},
        resume() {},
        write() {},
        resize() {},
        onFault: (fn) => subscription("fault", fn),
        onData: (fn) => subscription("data", fn),
        onExit: (fn) => subscription("exit", fn),
      };
    },
    processes: (pty) => ({
      prepare: () => ({ anchor: {} as any, jobs: busy ? [{} as any] : [] }),
      validate: () => {
        if (busy) throw Error("new job");
      },
      stop: async () => {
        if (busy) throw Error("new job");
        await onStop((pty as any).cwd);
        stopped.push((pty as any).cwd);
        (pty as any).emitter.emit("exit", { exitCode: 0 });
      },
    }),
    prepareScreen: async () =>
      ({
        assertReady() {},
        bind() {},
        output() {},
        exited() {},
        drainAfterHangup() {},
        finishClose() {},
        dispose() {},
        fail() {},
      }) as any,
    removeTab: async () => {
      throw Error("must preserve catalog");
    },
  });
  f.service.setTerminalDeletionController(sessions);
  return {
    sessions,
    stopped,
    onStop: (fn: typeof onStop) => {
      onStop = fn;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}
it(
  "deletes a selected topic with an idle common terminal; keeps primary session and closes only after checks",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    await f.git("branch", "main");
    const owner = await f.manager.ensure(f.project, f.identity);
    const ref = worktreeContextRef(owner);
    await f.service.selectTopicContext(ref);
    const t = await deletionTerminals(f);
    const tab = {
      id: "console",
      projectId: f.project.id,
      name: "console",
      scope: { kind: "common" as const },
    };
    const topicSession = await t.sessions.open(tab, ref);
    const primarySession = await t.sessions.open(tab, f.project.id);
    expect(await f.service.prepareContextDeletion(ref)).toMatchObject({
      stage: "choose-branch",
    });
    const plan = await f.service.prepareContextDeletion(ref, "main");
    expect(t.stopped).toEqual([]);
    const input = { projectId: f.project.id, token: plan.token };
    expect(await f.service.deleteContext(input)).toMatchObject({
      cloneRemoved: true,
    });
    expect(t.stopped).toEqual([owner.path]);
    expect(
      t.sessions.list().find((v) => v.sessionId === topicSession.sessionId)
        ?.state,
    ).toBe("exited");
    await f.service.selectTopicContext(null);
    expect(await f.service.finishContextDeletion(input)).toMatchObject({
      status: "success",
    });
    expect(
      t.sessions.list().find((v) => v.sessionId === primarySession.sessionId)
        ?.state,
    ).toBe("running");
    expect((await f.git("branch", "--show-current")).stdout.trim()).toBe(
      "main",
    );
    expect((await f.git("branch", "--list", target.branch)).stdout).toBe("");
  }),
  gitIntegrationBudget(15000),
);
it(
  "keeps idle shells alive for dirty clones and blocks jobs introduced after preview",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git("branch", "main");
    const owner = await f.manager.ensure(f.project, f.identity);
    const ref = worktreeContextRef(owner);
    const t = await deletionTerminals(f);
    await t.sessions.open(
      {
        id: "console",
        projectId: f.project.id,
        name: "console",
        scope: { kind: "common" },
      },
      ref,
    );
    const plan = await f.service.prepareContextDeletion(ref, "main");
    const input = { projectId: f.project.id, token: plan.token };
    await writeFile(path.join(owner.path, "untracked.txt"), "keep me");
    await expect(f.service.deleteContext(input)).rejects.toThrow();
    expect(t.stopped).toEqual([]);
    await rm(path.join(owner.path, "untracked.txt"));
    t.setBusy(true);
    await expect(f.service.deleteContext(input)).rejects.toThrow(/команд/);
    expect(t.stopped).toEqual([]);
    await expect(access(owner.path)).resolves.toBeUndefined();
  }),
  gitIntegrationBudget(15000),
);

it(
  "preserves the clone when an idle shell exit hook writes a new file",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git("branch", "main");
    const owner = await f.manager.ensure(f.project, f.identity);
    const ref = worktreeContextRef(owner);
    const t = await deletionTerminals(f);
    await t.sessions.open(
      {
        id: "console",
        projectId: f.project.id,
        name: "console",
        scope: { kind: "common" },
      },
      ref,
    );
    const plan = await f.service.prepareContextDeletion(ref, "main");
    t.onStop(async (cwd) => {
      await writeFile(path.join(cwd, "shell-exit.txt"), "do not lose");
    });
    const result = await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(result.status).not.toBe("success");
    expect(result.cloneRemoved).not.toBe(true);
    await expect(
      access(path.join(owner.path, "shell-exit.txt")),
    ).resolves.toBeUndefined();
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it(
  "stops before primary checkout when a terminal becomes busy during checks; retry is not ambiguous",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    await f.git("branch", "main");
    const owner = await f.manager.ensure(f.project, f.identity);
    const ref = worktreeContextRef(owner);
    const t = await deletionTerminals(f);
    await t.sessions.open(
      {
        id: "console",
        projectId: f.project.id,
        name: "console",
        scope: { kind: "common" },
      },
      f.project.id,
    );
    const plan = await f.service.prepareContextDeletion(ref, "main");
    const input = { projectId: f.project.id, token: plan.token };
    expect(await f.service.deleteContext(input)).toMatchObject({
      cloneRemoved: true,
    });
    await f.service.selectTopicContext(null);
    f.afterCall(async (exe, args) => {
      if (exe === "git" && args.includes("read-tree")) t.setBusy(true);
    });
    expect(await f.service.finishContextDeletion(input)).toMatchObject({
      status: "partial",
    });
    expect((await f.git("branch", "--show-current")).stdout.trim()).toBe(
      "feature/test",
    );
    f.afterCall(undefined);
    t.setBusy(false);
    expect(await f.service.finishContextDeletion(input)).toMatchObject({
      status: "success",
    });
    expect(t.stopped).toEqual([]);
  }),
  gitIntegrationBudget(15000),
);

it(
  "checks primary terminal readiness in the same synchronous turn as each mutation spawn",
  fixtureScope.run(async () => {
    const f = await fixture({ simulateTopicDeletion: true });
    await f.git("branch", "main");
    const owner = await f.manager.ensure(f.project, f.identity);
    const ref = worktreeContextRef(owner);
    const t = await deletionTerminals(f);
    await t.sessions.open(
      {
        id: "console",
        projectId: f.project.id,
        name: "console",
        scope: { kind: "common" },
      },
      f.project.id,
    );
    const plan = await f.service.prepareContextDeletion(ref, "main");
    const input = { projectId: f.project.id, token: plan.token };
    expect(await f.service.deleteContext(input)).toMatchObject({
      cloneRemoved: true,
    });
    await f.service.selectTopicContext(null);
    let fresh = false;
    const original = t.sessions.prepareContextDeletion.bind(t.sessions);
    vi.spyOn(t.sessions, "prepareContextDeletion").mockImplementation(
      (scope) => {
        const gate = original(scope);
        return {
          ...gate,
          validate: () => {
            gate.validate();
            fresh = true;
            queueMicrotask(() => {
              fresh = false;
            });
          },
        };
      },
    );
    const mutations: string[] = [];
    f.beforeCall((exe, args) => {
      if (
        (exe === "git" && args.includes("switch")) ||
        (exe !== "git" && args.includes("delete"))
      ) {
        expect(fresh).toBe(true);
        mutations.push(exe === "git" ? "checkout" : "delete");
      }
    });
    expect(await f.service.finishContextDeletion(input)).toMatchObject({
      status: "success",
    });
    expect(mutations).toEqual(["checkout", "delete"]);
  }),
  gitIntegrationBudget(15000),
);

it(
  "reads branch choices with one Git command, no board or clone traversal, and no cross-read cache",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git("branch", "release");
    await f.git("update-ref", "refs/remotes/origin/release", "HEAD");
    await f.git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/release",
    );
    const reconcile = vi.spyOn(CloneManager.prototype, "reconcile");
    const list = vi.spyOn(CloneManager.prototype, "list");
    const full = vi.spyOn(f.service, "readTopicBoard");
    f.calls.length = 0;
    const first = await f.service.readProjectBranches(f.project.id);
    expect(first).toEqual({
      projectId: f.project.id,
      branches: ["feature/test", "release", "origin/release"],
      localBranches: ["feature/test", "release"],
    });
    expect(f.calls).toEqual([
      {
        exe: "git",
        cwd: f.repo,
        args: [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(symref)",
          "refs/heads",
          "refs/remotes",
        ],
      },
    ]);
    expect(full).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    await f.git("branch", "new-branch");
    expect(
      (await f.service.readProjectBranches(f.project.id)).localBranches,
    ).toContain("new-branch");
    expect(first).not.toHaveProperty("revision");
    await expect(f.service.readProjectBranches("unknown")).rejects.toThrow(
      /Неизвестный проект/,
    );
    await expect(
      f.service.readProjectBranches({ projectId: f.project.id } as any),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);

it(
  "branch choices fail cleanly on Git errors, empty repositories and cancelled reads",
  fixtureScope.run(async () => {
    const f = await fixture();
    f.beforeCall((exe, args) => {
      if (exe === "git" && args[0] === "for-each-ref")
        throw Error("Git unavailable");
    });
    await expect(f.service.readProjectBranches(f.project.id)).rejects.toThrow(
      "Git unavailable",
    );
    f.beforeCall(undefined);
    const abort = new AbortController();
    f.afterCall(async () => abort.abort());
    await expect(
      withReadScope(abort.signal, () =>
        f.service.readProjectBranches(f.project.id),
      ),
    ).rejects.toThrow(/отмен/);
    f.afterCall(undefined);
    // A fresh repository without commits is valid and has no branch refs.
    await f.git("update-ref", "-d", "refs/heads/feature/test");
    expect(await f.service.readProjectBranches(f.project.id)).toEqual({
      projectId: f.project.id,
      branches: [],
      localBranches: [],
    });
  }),
  gitIntegrationBudget(15000),
);

it(
  "branch choices ignore clone-only refs even with a ready clone",
  fixtureScope.run(async () => {
    const f = await fixture();
    const owner = await f.manager.ensure(f.project, f.identity);
    const node = fixtureScope.runner(new NodeRunner());
    fixtureScope().cleanup(() => node.dispose());
    await node.command("git", ["branch", "only-in-clone"], owner.path);
    f.calls.length = 0;
    const result = await f.service.readProjectBranches(f.project.id);
    expect(result.branches).not.toContain("only-in-clone");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.cwd).toBe(f.repo);
  }),
  gitIntegrationBudget(15000),
);

it(
  "measures full-board versus branch-only reads on temporary Git data (Goga stub has zero delay)",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.manager.ensure(f.project, f.identity);
    const report: Record<string, unknown[]> = { board: [], branches: [] };
    for (let i = 0; i < 5; i++)
      for (const method of ["board", "branches"] as const) {
        f.calls.length = 0;
        const start = performance.now();
        if (method === "board")
          await f.service.readTopicBoard(f.project.id, "2026");
        else await f.service.readProjectBranches(f.project.id);
        report[method].push({
          ms: Math.round((performance.now() - start) * 10) / 10,
          git: f.calls.filter((c) => c.exe === "git").length,
          goga: f.calls.filter((c) => c.exe !== "git").length,
          cloneCalls: f.calls.filter((c) => c.cwd !== f.repo).length,
        });
      }
    console.log("BRANCH_READ_BENCHMARK", JSON.stringify(report));
    expect(report.branches).toHaveLength(5);
  }),
  gitIntegrationBudget(30000),
);
