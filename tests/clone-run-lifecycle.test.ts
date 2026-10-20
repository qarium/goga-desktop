import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { ContextSyncManager } from "../src/host/context-sync";
import { worktreeContextRef } from "../src/shared/worktrees";
import {
  FixtureScope,
  PauseGate,
  gitIntegrationBudget,
  hasRunSyncCall,
} from "./helpers/git-integration";
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
function ownService(service: HostService, owner = scope) {
  owner.cleanup(async () => {
    // close events remove children before their persistence/sync flight settles.
    // stop joins those exact flights, including already-terminal runs.
    await Promise.allSettled(service.runs().map((run) => service.stop(run.id)));
    await service.dispose();
  });
  return owner.own(service);
}
function fixture() {
  const owner = scope;
  return owner.track(createFixture(owner));
}
async function createFixture(scope: FixtureScope) {
  const root = await mkdtemp(
      "/private/tmp/goga-context-ab-research-20261019-impl-runs-",
    ),
    repo = path.join(root, "primary"),
    home = path.join(root, "home");
  scope.cleanup(() => rm(root, { recursive: true, force: true }));
  await mkdir(repo);
  await mkdir(home);
  const node = new NodeRunner();
  scope.cleanup(() => node.dispose());
  scope.cancelOnTimeout(() => node.dispose());
  const native = scope.own(node);
  const git = (...args: string[]) =>
    native.command("git", args, repo, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await mkdir(path.join(repo, ".goga"), { recursive: true });
  await writeFile(path.join(repo, "plan.md"), "# Plan\n");
  await writeFile(
    path.join(repo, ".goga/config.yml"),
    "build:\n  review:\n    skip: true\n",
  );
  await git("add", ".");
  await git("commit", "-m", "synthetic fixture");
  await git("branch", "first");
  await git("branch", "second");
  const children: any[] = [];
  const starts: any[] = [];
  const gate = new PauseGate();
  scope.releaseOnCleanup(() => gate.release());
  const runner = {
    command: async (
      exe: string,
      args: string[],
      cwd: string,
      env?: NodeJS.ProcessEnv,
    ) => {
      if (exe === "git") return native.command(exe, args, cwd, env);
      const value = args.join(" ");
      if (value === "build --help")
        return {
          stdout: "--skip-review --no-skip-review --env --workflow --profile",
          stderr: "",
        };
      if (value === "config build.review.skip")
        return { stdout: "# build.review.skip\nTrue\n", stderr: "" };
      if (value === "history path -f plan.md")
        return { stdout: "plan.md\n", stderr: "" };
      throw Error("unexpected synthetic command " + value);
    },
    start: (exe: string, args: string[], cwd: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      children.push(scope.own(child));
      starts.push({ exe, args, cwd });
      return child as any;
    },
    kill: vi.fn(() => gate.wait()),
  };
  const service = ownService(
    new HostService({
      home,
      dataDir: path.join(root, "data"),
      runner,
    }),
    scope,
  );
  const project = await service.addProject(repo);
  const manager = new CloneManager(home, runner);
  const a = await manager.ensure(project, {
      projectId: project.id,
      year: "2026",
      topic: "first",
      branch: "first",
    }),
    b = await manager.ensure(project, {
      projectId: project.id,
      year: "2026",
      topic: "second",
      branch: "second",
    });
  const request = async (owner: typeof a) => {
    const ref = worktreeContextRef(owner),
      c = await service.buildContext(ref),
      plan = await service.readBuildPlan(ref, "plan.md");
    return {
      projectId: project.id,
      context: ref,
      expectedBranch: c.branch,
      contextRevision: c.revision,
      planPath: plan.path,
      planVersion: plan.version,
      options: {},
      confirmClean: false,
    };
  };
  return {
    root,
    home,
    native,
    service,
    a,
    b,
    request,
    children,
    starts,
    runner,
    pause: () => gate.pause(),
    release: () => gate.release(),
  };
}
it("keeps parallel clone runs independent, and syncs only after actual termination with fixed owner", async () => {
  const after = vi
    .spyOn(ContextSyncManager.prototype, "afterRun")
    .mockResolvedValue({} as any);
  const f = await fixture();
  const r1 = await f.service.launchBuild(await f.request(f.a)),
    r2 = await f.service.launchBuild(await f.request(f.b));
  expect(f.starts.map((x) => x.cwd)).toEqual([f.a.path, f.b.path]);
  await expect(f.service.launchBuild(await f.request(f.a))).rejects.toThrow(
    /уже работает/,
  );
  await f.service.selectTopicContext(worktreeContextRef(f.b));
  f.pause();
  const stop = f.service.stop(r1.id);
  await vi.waitFor(() => expect(f.runner.kill).toHaveBeenCalled());
  expect(after).not.toHaveBeenCalled();
  f.release();
  await stop;
  expect(after).toHaveBeenCalledWith(
    expect.objectContaining({ path: f.a.projectPath }),
    worktreeContextRef(f.a),
    r1.id,
  );
  expect(f.service.runs().find((r) => r.id === r1.id)?.status).toBe("stopped");
  expect(f.service.runs().find((r) => r.id === r2.id)?.status).toBe("running");
  await f.service.stop(r2.id);
  await f.service.dispose();
});
it("requests sync for failing build without rewriting the outcome", async () => {
  const after = vi
    .spyOn(ContextSyncManager.prototype, "afterRun")
    .mockRejectedValue(Error("import failed"));
  const f = await fixture();
  const run = await f.service.launchBuild(await f.request(f.a));
  f.children[0].emit("close", 2);
  await vi.waitFor(
    () => {
      expect(
        hasRunSyncCall(
          after.mock.calls,
          f.a.projectPath,
          worktreeContextRef(f.a),
          run.id,
        ),
      ).toBe(true);
      expect(f.service.runs().find((r) => r.id === run.id)?.status).toBe(
        "failed",
      );
    },
    { timeout: gitIntegrationBudget(1000) },
  );
  const done = f.service.runs().find((r) => r.id === run.id)!;
  expect(done.status).toBe("failed");
  expect(done.error).toContain("кодом 2");
  await f.service.dispose();
});
it("imports commits after successful termination in the actual fixed clone without changing primary checkout", async () => {
  const f = await fixture(),
    native = f.native;
  const before = (
    await native.command("git", ["rev-parse", "HEAD"], f.a.projectPath)
  ).stdout;
  const run = await f.service.launchBuild(await f.request(f.a));
  await writeFile(path.join(f.a.path, "result.txt"), "synthetic result\n");
  await native.command("git", ["add", "result.txt"], f.a.path);
  await native.command(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "synthetic result",
    ],
    f.a.path,
  );
  const oid = (
    await native.command("git", ["rev-parse", "HEAD"], f.a.path)
  ).stdout.trim();
  f.children[0].emit("close", 0);
  await vi.waitFor(
    async () =>
      expect(
        (await f.service.topicSyncStatus(worktreeContextRef(f.a))).status,
      ).toBe("synced"),
    { timeout: gitIntegrationBudget(8000) },
  );
  expect(
    (await f.service.topicSyncStatus(worktreeContextRef(f.a))).importedOid,
  ).toBe(oid);
  expect(
    (await native.command("git", ["rev-parse", "HEAD"], f.a.projectPath))
      .stdout,
  ).toBe(before);
  expect(
    (await native.command("git", ["status", "--porcelain"], f.a.projectPath))
      .stdout,
  ).toBe("");
  await f.service.dispose();
});
it("binds full pipeline preview/task/start to the owner rather than primary", async () => {
  const after = vi
      .spyOn(ContextSyncManager.prototype, "afterRun")
      .mockResolvedValue({} as any),
    f = await fixture(),
    native = f.native;
  // The pipeline fixture now owns actual task data instead of inventing a board-only task.
  await mkdir(path.join(f.a.path, ".goga/history/2026/first"), {
    recursive: true,
  });
  await writeFile(
    path.join(f.a.path, ".goga/history/2026/first/todo.md"),
    "Owner task\n",
  );
  const base = f.runner.command;
  f.runner.command = async (exe, args, cwd, env) => {
    if (exe !== "git" && args.includes("board")) {
      const branch = (
        await native.command("git", ["branch", "--show-current"], cwd)
      ).stdout.trim();
      return {
        stdout: JSON.stringify([
          {
            branch,
            topic: branch,
            current: true,
            remote: false,
            statuses: [],
            todo: "",
          },
        ]),
        stderr: "",
      };
    }
    if (exe !== "git" && args.includes("--list"))
      return {
        stdout:
          "* build\n    name: Owner pipeline\n    description: Owner description\n",
        stderr: "",
      };
    if (exe !== "git" && args.includes("--info"))
      return {
        stdout: "name: Build\n---\n* work:\n    title: Work\n",
        stderr: "",
      };
    return base(exe, args, cwd, env);
  };
  const context = worktreeContextRef(f.a),
    request = {
      projectId: f.a.projectId,
      context,
      pipeline: "build",
      workflow: "none",
      profile: "",
      skips: [],
    },
    preview = await f.service.preview(request),
    task = await f.service.readTopicTask({
      projectId: f.a.projectId,
      context,
      branch: f.a.branch,
      topic: f.a.topic,
    });
  const run = await f.service.launch({
    ...request,
    topic: { mode: "existing", branch: f.a.branch, topic: f.a.topic },
    clean: false,
    expectedBranch: f.a.branch,
    confirmBranchSwitch: false,
    previewToken: preview.token,
    task: task.text,
    taskVersion: task.version,
    confirmEmptyTask: false,
  });
  expect(f.starts[0].cwd).toBe(f.a.path);
  expect(run.context?.contextId).toBe(context.contextId);
  expect(run.pipelineName).toBe("Owner pipeline");
  expect(run.pipelineDescription).toBe("Owner description");
  await f.service.stop(run.id);
  expect(
    hasRunSyncCall(after.mock.calls, f.a.projectPath, context, run.id),
  ).toBe(true);
  await f.service.dispose();
});
it("replays durable terminal sync intent after restart when the first attempt failed before journaling", async () => {
  const after = vi
    .spyOn(ContextSyncManager.prototype, "afterRun")
    .mockRejectedValue(Error("before journal"));
  const f = await fixture(),
    run = await f.service.launchBuild(await f.request(f.a));
  await f.service.stop(run.id);
  expect(f.service.runs()[0].syncPending).toBe(true);
  await expect(f.service.closeRun(run.id, async () => true)).rejects.toThrow(
    /синхронизация/,
  );
  await f.service.dispose();
  after.mockResolvedValue({ status: "synced" } as any);
  const recovered = ownService(
    new HostService({
      home: f.home,
      dataDir: path.join(f.root, "data"),
      runner: f.runner,
    }),
  );
  await recovered.initialize();
  expect(after).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: f.a.projectPath }),
    worktreeContextRef(f.a),
    run.id,
  );
  expect(recovered.runs()[0].syncPending).toBe(false);
  expect(recovered.runs()[0].status).toBe("stopped");
  await recovered.dispose();
});
it("blocks writes, stop, and close for an unreconciled owner after restart", async () => {
  vi.spyOn(ContextSyncManager.prototype, "afterRun").mockResolvedValue(
    {} as any,
  );
  const f = await fixture(),
    run = await f.service.launchBuild(await f.request(f.a));
  const recovered = ownService(
    new HostService({
      home: f.home,
      dataDir: path.join(f.root, "data"),
      runner: f.runner,
    }),
  );
  await recovered.initialize();
  expect(recovered.runs()[0].recovery).toBe("unverified");
  await expect(recovered.stop(run.id)).rejects.toThrow(/не подтверждено/);
  await expect(recovered.closeRun(run.id, async () => true)).rejects.toThrow(
    /не подтверждено/,
  );
  const doc = await recovered.readProjectDocument(worktreeContextRef(f.a), {
    kind: "config",
  });
  await expect(
    recovered.saveProjectDocument(
      worktreeContextRef(f.a),
      { kind: "config" },
      doc.text,
      doc.version,
    ),
  ).rejects.toThrow(/состояние процесса/);
  await recovered.dispose();
  // Simulate the old host being gone; it must not write with an obsolete CAS revision.
  for (const entry of (f.service as any).children.values()) {
    entry.cancel();
    entry.output.dispose();
  }
  (f.service as any).children.clear();
  (f.service as any).disposed = true;
});
