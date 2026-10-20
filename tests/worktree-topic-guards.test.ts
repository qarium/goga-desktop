import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { TopicsDomain, type TopicsContext } from "../src/host/topics";
import type { TopicOperationRequest } from "../src/shared/topics";
import { assertTopicBranchesAvailable as nativeGuard } from "../src/host/worktree-topic-guards";

// No subprocesses, repositories, or real fixture writes in this suite.
const filesystem = vi.hoisted(() => ({
  aliases: new Map<string, string>(),
  missing: new Set<string>(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  realpath: async (value: string) => {
    if (filesystem.missing.has(value)) throw Error("mock missing path");
    return filesystem.aliases.get(value) ?? value;
  },
  lstat: async (value: string) => {
    if (/\/\.goga\/history\/2026\/[^/]+$/.test(value))
      throw Object.assign(new Error("missing mock directory"), {
        code: "ENOENT",
      });
    return {
      isSymbolicLink: () => false,
      isDirectory: () => true,
      isFile: () => false,
    };
  },
}));
vi.mock("../src/host/topic-task", async (original) => ({
  ...(await original<typeof import("../src/host/topic-task")>()),
  guardedProject: async () => {},
  readWorkingTask: async () => ({ text: "", exists: false }),
}));
afterEach(() => {
  filesystem.aliases.clear();
  filesystem.missing.clear();
});

type Operation = TopicOperationRequest["action"];

function fixture() {
  const cwd = "/mock/primary",
    root = "/mock";
  const refs = [
    { name: "main", remote: false },
    { name: "Feature", remote: false },
  ];
  const worktrees = [{ cwd, branch: "main" }];
  const state = { dirty: false };
  const mutations: string[][] = [];
  const callback = vi.fn(
    async (_branches: string[], _operation: Operation) => {},
  );
  const oid = "a".repeat(40);
  const git = vi.fn(async (args: string[]) => {
    if (args[0] === "worktree") {
      expect(args).toEqual(["worktree", "list", "--porcelain", "-z"]);
      return worktrees
        .map(
          (w) =>
            `worktree ${w.cwd}\0HEAD ${oid}\0branch refs/heads/${w.branch}\0\0`,
        )
        .join("");
    }
    if (args[0] === "for-each-ref")
      return refs
        .map(
          (ref) =>
            `refs/${ref.remote ? "remotes" : "heads"}/${ref.name}\0${oid}\0`,
        )
        .join("\n");
    if (args[0] === "branch") return "main\n";
    if (args[0] === "status") return state.dirty ? " M tracked.txt\0" : "";
    if (["diff", "ls-files", "config", "check-ref-format"].includes(args[0]!))
      return "";
    if (args[0] === "rev-parse") return oid + "\n";
    if (args[0] === "ls-tree") return ".goga/history/2026/feature/todo.md\0";
    throw Error(`Unexpected mock Git read: ${args.join(" ")}`);
  });
  const context: TopicsContext & {
    assertBranchesAvailable: (
      branches: string[],
      operation: Operation,
    ) => Promise<void>;
  } = {
    project: { id: "fixture", path: cwd, name: "Fixture" },
    git,
    goga: async (args: string[]) => {
      if (!args.includes("board")) {
        mutations.push(args);
        return "ok";
      }
      return JSON.stringify(
        args.includes("--remote")
          ? []
          : ["main", "feature"].map((name) => ({
              topic: name,
              branch: name === "feature" ? "Feature" : name,
              current: name === "main",
              remote: false,
              todo: name,
              statuses: ["todo"],
              divergence: null,
              ...(!args.includes("--per-host")
                ? { hosts: [name === "feature" ? "Feature" : name] }
                : {}),
            })),
      );
    },
    fingerprint: async () => "fixture",
    baseRef: async () => "main",
    active: () => false,
    assertBranchesAvailable: callback,
  };
  const domain = new TopicsDomain();
  const request = async (
    extra: Partial<TopicOperationRequest>,
  ): Promise<TopicOperationRequest> => ({
    projectId: "fixture",
    year: "2026",
    expectedRevision: (await domain.board(context, "2026")).revision,
    action: "delete",
    topics: ["feature"],
    ...extra,
  });
  return {
    root,
    cwd,
    git,
    state,
    refs,
    worktrees,
    context,
    callback,
    mutations,
    domain,
    request,
  };
}

it.each([
  [
    "create",
    {
      action: "create",
      branch: "fresh",
      baseRef: "main",
      task: "real task",
      switch: false,
    },
    ["fresh"],
  ],
  ["delete", { action: "delete", topics: ["feature"] }, ["Feature"]],
  [
    "update",
    {
      action: "update",
      target: { topic: "feature", branch: "Feature", remote: false },
      baseRef: "refs/heads/main",
    },
    ["Feature"],
  ],
  [
    "switch",
    {
      action: "switch",
      target: { topic: "feature", branch: "Feature", remote: false },
    },
    ["Feature"],
  ],
  [
    "propagate",
    {
      action: "propagate",
      target: { topic: "main", branch: "main", remote: false },
      baseRef: "Feature",
    },
    ["Feature"],
  ],
] as const)(
  "guards affected branches of %s before preparing CLI commands",
  async (operation, input, branches) => {
    const f = fixture();
    f.callback.mockRejectedValue(
      new Error("Ветка открыта в другой рабочей копии"),
    );
    await expect(
      f.domain.prepare(
        f.context,
        await f.request(input as Partial<TopicOperationRequest>),
      ),
    ).rejects.toThrow(/другой рабочей копии/);
    expect(f.callback).toHaveBeenCalledWith([...branches], operation);
    expect(f.mutations).toEqual([]);
  },
);

it("rechecks worktree occupancy after confirmation without relying on topic revision changes", async () => {
  const f = fixture();
  const plan = await f.domain.prepare(
    f.context,
    await f.request({ action: "delete", topics: ["feature"] }),
  );
  f.callback.mockRejectedValue(new Error("Ветка открыта после подтверждения"));
  await expect(f.domain.execute(f.context, plan.token)).rejects.toThrow(
    /после подтверждения/,
  );
  expect(f.callback).toHaveBeenCalledTimes(2);
  expect(f.mutations).toEqual([]);
});

it("keeps checkout-free delete-other semantics when the sole current worktree is dirty", async () => {
  const f = fixture();
  f.state.dirty = true;
  const plan = await f.domain.prepare(
    f.context,
    await f.request({ action: "delete", topics: ["feature"] }),
  );
  expect((await f.domain.execute(f.context, plan.token)).status).toBe(
    "success",
  );
  expect(f.callback).toHaveBeenCalledWith(["Feature"], "delete");
});

it.each(["delete", "update", "switch", "create", "propagate"] as const)(
  "rejects %s with foreign checked-out branch in a mock inventory",
  async (operation) => {
    const f = fixture();
    f.worktrees.push({
      cwd: path.join(f.root, "external with\nnewline"),
      branch: "Feature",
    });
    await expect(
      nativeGuard(f.context.git, f.cwd, ["Feature"], operation),
    ).rejects.toThrow(/рабочей копии/);
  },
);

it("never exempts primary checked-out branch from deletion", async () => {
  const f = fixture();
  f.worktrees.push({ cwd: "/mock/external", branch: "Feature" });
  await expect(
    nativeGuard(f.context.git, "/mock/external", ["main"], "delete"),
  ).rejects.toThrow(/рабочей копии/);
  await expect(
    nativeGuard(f.context.git, f.cwd, ["main"], "delete"),
  ).rejects.toThrow(/рабочей копии/);
});

it("permits own-current update and unoccupied branches without imposing new dirty rules", async () => {
  const f = fixture();
  f.state.dirty = true;
  await expect(
    nativeGuard(f.context.git, f.cwd, ["main"], "update"),
  ).resolves.toBeUndefined();
  await expect(
    nativeGuard(f.context.git, f.cwd, ["Feature"], "delete"),
  ).resolves.toBeUndefined();
  await expect(
    nativeGuard(f.context.git, f.cwd, ["fresh"], "create"),
  ).resolves.toBeUndefined();
});

it("canonicalizes cwd aliases before allowing own-current update", async () => {
  const f = fixture();
  filesystem.aliases.set("/mock/alias", f.cwd);
  await expect(
    nativeGuard(f.context.git, "/mock/alias", ["main"], "update"),
  ).resolves.toBeUndefined();
});

it("fails closed when the matching registered owner is no longer accessible", async () => {
  const f = fixture();
  f.worktrees.push({ cwd: "/mock/missing", branch: "Feature" });
  filesystem.missing.add("/mock/missing");
  await expect(
    nativeGuard(f.context.git, f.cwd, ["Feature"], "delete"),
  ).rejects.toThrow(/каталог|рабочи/i);
});

it("accepts detached/bare/locked/prunable records without mistaking them for branch owners", async () => {
  const f = fixture();
  const raw = `worktree /mock/bare\0bare\0\0worktree /mock/detached\0HEAD ${"a".repeat(64)}\0detached\0locked owner reason\0prunable missing path\0\0`;
  await expect(
    nativeGuard(async () => raw, f.cwd, ["Feature"], "delete"),
  ).resolves.toBeUndefined();
});

it("preserves domain compatibility for legacy contexts without the optional callback", async () => {
  const f = fixture();
  const { assertBranchesAvailable: _ignored, ...legacy } = f.context;
  const plan = await f.domain.prepare(
    legacy,
    await f.request({ action: "delete", topics: ["feature"] }),
  );
  expect((await f.domain.execute(legacy, plan.token)).status).toBe("success");
});

it("fails closed when Git worktree inventory cannot be read", async () => {
  const f = fixture();
  await expect(
    nativeGuard(
      async () => {
        throw Error("permission denied");
      },
      f.cwd,
      ["Feature"],
      "delete",
    ),
  ).rejects.toThrow(/каталог|рабочи/i);
});

it.each([
  "",
  "worktree /mock/one\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/main\n\n",
  "HEAD " + "a".repeat(40) + "\0branch refs/heads/main\0\0",
  "worktree relative\0HEAD " + "a".repeat(40) + "\0branch refs/heads/main\0\0",
  "worktree /mock/one\0branch refs/heads/main\0\0",
  "worktree /mock/one\0HEAD invalid\0branch refs/heads/main\0\0",
  "worktree /mock/one\0HEAD " +
    "a".repeat(40) +
    "\0branch refs/heads/main\0branch refs/heads/Feature\0\0",
  "worktree /mock/one\0HEAD " +
    "a".repeat(40) +
    "\0branch refs/remotes/origin/main\0\0",
  "worktree /mock/one\0HEAD " +
    "a".repeat(40) +
    "\0branch refs/heads/main\0unknown unexpected\0\0",
] as const)("fails closed on malformed worktree inventory %j", async (raw) => {
  const f = fixture();
  await expect(
    nativeGuard(async () => raw, f.cwd, ["Feature"], "delete"),
  ).rejects.toThrow(/каталог|рабочи/i);
});

it("blocks foreign worktree added to mocked inventory after prepare without destructive CLI call", async () => {
  const f = fixture();
  f.context.assertBranchesAvailable = (branches, operation) =>
    nativeGuard(f.context.git, f.cwd, branches, operation);
  const plan = await f.domain.prepare(
    f.context,
    await f.request({ action: "delete", topics: ["feature"] }),
  );
  f.worktrees.push({ cwd: "/mock/late", branch: "Feature" });
  await expect(f.domain.execute(f.context, plan.token)).rejects.toThrow(
    /рабочей копии/,
  );
  expect(f.mutations).toEqual([]);
});

it.each([false, true])(
  "preserves origin base alias resolution, literal local wins=%s",
  async (literal) => {
    const f = fixture();
    f.refs.push({ name: "origin/Feature", remote: true });
    if (literal) f.refs.push({ name: "origin/Feature", remote: false });
    await f.domain.prepare(
      f.context,
      await f.request({
        action: "propagate",
        target: { topic: "main", branch: "main", remote: false },
        baseRef: "origin/Feature",
      }),
    );
    expect(f.callback).toHaveBeenCalledWith(
      [literal ? "origin/Feature" : "Feature"],
      "propagate",
    );
  },
);
