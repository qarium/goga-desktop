import { afterEach, expect, it, vi } from "vitest";
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
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of clean.splice(0).reverse()) await fn();
});
const target = { topic: "feature-test", branch: "feature/test", remote: false };
async function fixture(options: { simulateTopicDeletion?: boolean } = {}) {
  const root = await mkdtemp("/private/tmp/goga-display-");
  clean.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"),
    home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const node = new NodeRunner(120000, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  clean.push(() => node.dispose());
  const git = (...args: string[]) => node.command("git", args, repo);
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
  let afterCall:
    ((exe: string, args: string[], cwd: string) => Promise<void>) | undefined;
  const runner: Runner = {
    start: node.start.bind(node),
    kill: node.kill.bind(node),
    command: async (exe, args, cwd, env, input) => {
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
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    goga: "mock-goga",
    trashItem: async (source) => {
      await rename(source, path.join(root, "trashed-clone"));
    },
    runner,
  });
  clean.push(() => service.dispose());
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
    afterCall: (fn: typeof afterCall) => {
      afterCall = fn;
    },
  };
}
it("reads one aggregate local board only and returns display-only statuses without mutation authority", async () => {
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
});
it("reads exactly one aggregate per ready owner and replaces stale primary statuses", async () => {
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
});
it("keeps clone-only inventory with unknown status when local metadata is empty", async () => {
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
});
it.each(["missing", "error"] as const)(
  "never falls back to stale primary statuses for %s owners",
  async (kind) => {
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
  },
);
it("limits concurrent owner aggregate reads to three without loading full boards", async () => {
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
});
it("reads committed primary task without Goga or full board, ignoring uncommitted primary edits", async () => {
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
});
it("reads owner working task without Goga and never falls back to primary for missing/stale owners", async () => {
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
});
it("rejects task symlinks and changed owner identity during overview", async () => {
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
});
it.each(["table", "overview"] as const)(
  "rejects cancelled %s even when the transport returns data",
  async (kind) => {
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
  },
);
it("validates table schema and primary-only scope instead of accepting remote or malformed local summaries", async () => {
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
  await expect(f.service.readTopicTable(f.project.id, "2026")).rejects.toThrow(
    /JSON|каталог/,
  );
  await expect(
    f.service.readTopicTable(f.identity as any, "2026"),
  ).rejects.toThrow();
  await expect(
    f.service.readTopicTable(f.project.id, "../2026"),
  ).rejects.toThrow();
});
it("rejects primary task ref changes and does not read an injected path", async () => {
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
});

it.each(["table", "overview"] as const)(
  "rejects %s when an owner appears during the read",
  async (kind) => {
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
  },
);

it.each(["ready", "missing"] as const)(
  "blocks primary deletion of a %s managed owner during preparation",
  async (state) => {
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
  },
);
it.each(["before-execute", "during-validation"] as const)(
  "rejects primary deletion when a managed owner appears %s after preparation without invoking delete",
  async (when) => {
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
  },
);

it.each(["ready", "missing"] as const)(
  "rejects primary update for an existing %s managed owner",
  async (state) => {
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
  },
);
it.each(["before-execute", "during-validation"] as const)(
  "rejects primary update when an owner appears %s after preparation",
  async (when) => {
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
  },
);
it("continues to permit primary update when no owner exists", async () => {
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
});

it("preserves display divergence and primary placements while stripping task previews", async () => {
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
  f.rows.push({ ...f.rows[0]!, topic: "primary-only", branch: "primary-only" });
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
});
it("preserves clone-only placements and divergence from its exact owner", async () => {
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
});
it.each(["missing", "ambiguous"] as const)(
  "keeps primary placements but not stale divergence for %s owners",
  async (kind) => {
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
  },
);
it("does not degrade a cancelled owner read into a status error", async () => {
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
});

it("marks multiple owners of the same topic and branch unknown without querying an arbitrary owner", async () => {
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
});

it("allows confirmed dedicated deletion of exactly its deleting owner while removing the primary topic", async () => {
  const f = await fixture({ simulateTopicDeletion: true });
  const owner = await f.manager.ensure(f.project, f.identity);
  await f.git("switch", "-c", "main");
  f.rows[0]!.current = false;
  const plan = await f.service.prepareContextDeletion(
    worktreeContextRef(owner),
  );
  const result = await f.service.deleteContext({
    projectId: f.project.id,
    token: plan.token,
  });
  expect(result.status).toBe("success");
  expect(result.stage).toBe("completed");
  expect((await f.git("branch", "--list", target.branch)).stdout).toBe("");
  await expect(access(owner.path)).rejects.toThrow();
  await expect(
    access(path.join(f.root, "trashed-clone", ".git")),
  ).resolves.toBeUndefined();
  expect((await f.manager.list(f.project.id))[0]?.deletedAt).toBeTruthy();
});
it.each(["second-owner", "wrong-stage", "wrong-revision"] as const)(
  "does not widen confirmed context deletion exemption for %s",
  async (fault) => {
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
        return rows.map((row) => ({ ...row, state: "ready" as const }));
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
    expect(result.status).toBe("partial");
    expect(
      f.calls.some((c) => c.exe !== "git" && c.args.includes("delete")),
    ).toBe(false);
    await expect(access(owner.path)).resolves.toBeUndefined();
    expect((await f.git("branch", "--list", target.branch)).stdout).toContain(
      target.branch,
    );
  },
);
