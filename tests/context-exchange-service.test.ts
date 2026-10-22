import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { seedLegacyPublication } from "./helpers/legacy-publication";
import { worktreeContextRef } from "../src/shared/worktrees";
import { FixtureScope, gitIntegrationBudget } from "./helpers/git-integration";
vi.setConfig({ testTimeout: gitIntegrationBudget(30000) });
let scope: FixtureScope;
beforeEach(() => {
  if (scope && !scope.settled)
    throw Error("Previous fixture work has not settled");
  scope = new FixtureScope();
});
afterEach(async () => {
  try {
    await scope.close(gitIntegrationBudget(10000));
  } finally {
    if (scope.settled) vi.restoreAllMocks();
  }
}, gitIntegrationBudget(30000));
function fixture() {
  const owner = scope;
  return owner.track(createFixture(owner));
}
async function createFixture(scope: FixtureScope) {
  const root = await mkdtemp(
      "/private/tmp/goga-context-ab-research-20261020-completion-exchange-service-",
    ),
    repo = path.join(root, "primary"),
    home = path.join(root, "home"),
    upstream = path.join(root, "upstream.git");
  scope.cleanup(() => rm(root, { recursive: true, force: true }));
  for (const d of [repo, home, upstream]) await mkdir(d);
  const native = new NodeRunner(10000, {
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  scope.cleanup(() => native.dispose());
  scope.cancelOnTimeout(() => native.dispose());
  const node = scope.own(native),
    git = (...args: string[]) => node.command("git", args, repo);
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  await git("branch", "alpha");
  await git("branch", "beta");
  await node.command("git", ["init", "--bare"], upstream);
  await git("remote", "add", "origin", upstream);
  const calls: any[] = [];
  const runner = {
    command: async (
      exe: string,
      args: string[],
      cwd: string,
      env?: NodeJS.ProcessEnv,
      stdin?: string,
    ) => {
      if (exe === "git") return node.command(exe, args, cwd, env, stdin);
      calls.push({ args, cwd });
      return { stdout: "", stderr: "" };
    },
    start: vi.fn(),
    kill: vi.fn(),
  };
  const rawService = new HostService({
    home,
    dataDir: path.join(root, "data"),
    runner,
    goga: "fixture-goga",
  });
  scope.cleanup(() => rawService.dispose());
  const service = scope.own(rawService),
    project = await service.addProject(repo),
    manager = new CloneManager(home, runner);
  const a = await manager.ensure(project, {
      projectId: project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    }),
    b = await manager.ensure(project, {
      projectId: project.id,
      year: "2026",
      topic: "beta",
      branch: "beta",
    });
  const tickets = new Map<string, any>();
  const board = async (d: any, year: string) => ({
    projectId: project.id,
    year,
    revision: createHash("sha256")
      .update(await d.git(["show-ref"]))
      .digest("hex"),
    baseRef: "main",
    currentBranch: (await d.git(["branch", "--show-current"])).trim(),
    entries: [],
    records: [],
  });
  (service as any).topicDomain = {
    board,
    prepare: async (d: any, r: any) => {
      if ((await board(d, r.year)).revision !== r.expectedRevision)
        throw Error("stale board");
      const token = randomUUID();
      tickets.set(token, r);
      return {
        token,
        projectId: project.id,
        year: r.year,
        action: r.action,
        title: "Native action",
        details: ["Native confirmation"],
        expiresAt: Date.now() + 60000,
      };
    },
    scopeForToken: (t: string) => tickets.get(t).context,
    execute: async (d: any, t: string) => {
      const r = tickets.get(t);
      await d.goga([
        "topics",
        "--year",
        r.year,
        r.action,
        r.target.branch,
        ...(r.baseRef ? ["--base-ref", r.baseRef] : []),
      ]);
      return {
        projectId: project.id,
        status: "success",
        message: "synthetic native adapter",
      };
    },
  };
  const request = async (action: string) => {
    const ref = worktreeContextRef(a),
      d = await (service as any).topicsContext(ref),
      c = await board(d, "2026");
    return {
      projectId: project.id,
      context: ref,
      year: "2026",
      expectedRevision: c.revision,
      action,
      target: { topic: "alpha", branch: "alpha", remote: false },
      baseRef: "main",
    } as any;
  };
  return { root, repo, home, service, node, git, a, b, request, calls };
}
it("uses an immutable incoming commit in the owner after selector switch without primary mutation", async () => {
  const f = await fixture();
  await writeFile(path.join(f.repo, "manual.txt"), "manual primary commit\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "manual");
  const head = (await f.git("rev-parse", "HEAD")).stdout,
    index = await readFile(path.join(f.repo, ".git/index"));
  const plan = await f.service.prepareTopicOperation(await f.request("update"));
  expect(plan.details.join(" ")).toContain("Выбранная база main");
  await f.service.selectTopicContext(worktreeContextRef(f.b));
  expect((await f.service.executeTopicOperation(plan.token)).status).toBe(
    "success",
  );
  const call = f.calls.find((c) => c.args.includes("update"));
  expect(call.cwd).toBe(f.a.path);
  const pinned = call.args[call.args.indexOf("--base-ref") + 1];
  expect(pinned).toMatch(/^refs\/desktop\/bases\//);
  expect(
    (await f.node.command("git", ["rev-parse", pinned], f.a.path)).stdout,
  ).toBe(head);
  expect((await f.git("rev-parse", "HEAD")).stdout).toBe(head);
  expect(await readFile(path.join(f.repo, ".git/index"))).toEqual(index);
  expect((await f.git("status", "--porcelain")).stdout).toBe("");
  await f.service.dispose();
});
it("rejects a moved selected primary base before the native mutation", async () => {
  const f = await fixture(),
    plan = await f.service.prepareTopicOperation(await f.request("update"));
  await writeFile(path.join(f.repo, "new.txt"), "new");
  await f.git("add", ".");
  await f.git("commit", "-m", "new");
  await expect(f.service.executeTopicOperation(plan.token)).rejects.toThrow(
    /измен|устар/,
  );
  expect(f.calls).toHaveLength(0);
  await f.service.dispose();
});
it("previews the genuine upstream and executes only in the clone after confirmation", async () => {
  const f = await fixture();
  await seedLegacyPublication(f.a, async (args, cwd) =>
    (await f.node.command("git", args, cwd)).stdout.trim(),
  );
  const plan = await f.service.prepareTopicOperation(
    await f.request("publish"),
  );
  expect(plan.details.join(" ")).toContain("origin →");
  expect(f.calls).toHaveLength(0);
  await f.service.executeTopicOperation(plan.token);
  expect(f.calls[0].cwd).toBe(f.a.path);
  expect(f.calls[0].args).toContain("publish");
  await f.service.dispose();
});
it("keeps the original selected ref in propagate confirmation after mapping to a clone branch", async () => {
  const f = await fixture();
  await seedLegacyPublication(f.a, async (args, cwd) =>
    (await f.node.command("git", args, cwd)).stdout.trim(),
  );
  const request = await f.request("propagate");
  request.baseRef = "refs/heads/main";
  const plan = await f.service.prepareTopicOperation(request);
  expect(plan.details.join(" ")).toContain(
    "Выбранная база refs/heads/main: неизменяемый commit",
  );
  expect(plan.details.join(" ")).toContain("База клона main:");
  expect(f.calls).toHaveLength(0);
  await f.service.dispose();
});

it("keeps the new local origin intact when obsolete external publication is requested", async () => {
  const f = await fixture();
  const config = await readFile(path.join(f.a.gitCommonDir, "config"), "utf8");
  await expect(
    f.service.prepareTopicOperation(await f.request("publish")),
  ).rejects.toThrow(/локальн|синхронизац/i);
  expect(await readFile(path.join(f.a.gitCommonDir, "config"), "utf8")).toBe(
    config,
  );
  expect(f.calls).toHaveLength(0);
});
