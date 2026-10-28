import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner, CommandExitError, type Runner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { CloneStore } from "../src/host/clone-store";
import { worktreeContextRef } from "../src/shared/worktrees";
import { NativeGitUpdateHandoff } from "../src/host/git-native-update-handoff";
import { installGitFixtureScope } from "./helpers/git-test-scope";
import { gitIntegrationBudget } from "./helpers/git-integration";
const fixtureScope = installGitFixtureScope();
async function fixture(kind: "primary" | "managed", strategy = "merge") {
  const base = await fs.mkdtemp("/private/tmp/goga-handoff-host-"),
    home = path.join(base, "home"),
    source = path.join(base, "source");
  fixtureScope().cleanup(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(home);
  await fs.mkdir(source);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
  const rawNode = new NodeRunner(10000, env);
  fixtureScope().cancelOnTimeout(() => rawNode.dispose());
  const node = fixtureScope().own(rawNode);
  fixtureScope().cleanup(() => node.dispose());
  const git = (root: string, args: string[]) =>
    node.command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        ...args,
      ],
      root,
      env,
    );
  await git(source, ["init", "-b", "main"]);
  await fs.mkdir(path.join(source, ".goga"));
  await fs.writeFile(
    path.join(source, ".goga/config.yml"),
    `topics:\n  base_ref: main\n  update:\n    strategy: ${strategy}\n`,
  );
  await fs.writeFile(path.join(source, "file"), "base\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "base"]);
  await git(source, ["branch", "feature"]);
  await fs.writeFile(path.join(source, "file"), "incoming\n");
  await git(source, ["commit", "-am", "incoming"]);
  let refusal: Error = new CommandExitError(
      "opaque refusal",
      1,
      "",
      "opaque diagnostic",
    ),
    updates = 0;
  let onUpdate: ((cwd: string, args: string[]) => Promise<void>) | undefined;
  const postFailureStatus: string[][] = [];
  const runner: Runner = {
    commandBytes: node.commandBytes.bind(node),
    start: node.start.bind(node),
    kill: node.kill.bind(node),
    command: async (exe, args, cwd, e, input) => {
      if (exe === "git") {
        if (updates && args.includes("--porcelain=v1"))
          postFailureStatus.push([...args]);
        return node.command(exe, args, cwd, e, input);
      }
      if (args[0] === "config")
        return {
          stdout: `base_ref: main\nupdate:\n  strategy: ${strategy}\n`,
          stderr: "",
        };
      if (args.includes("board"))
        return {
          stdout: JSON.stringify(
            args.includes("--remote")
              ? []
              : [
                  {
                    topic: "feature",
                    branch: "feature",
                    current: true,
                    remote: false,
                    todo: "task",
                    statuses: [],
                    divergence: "behind",
                    ...(!args.includes("--per-host")
                      ? { hosts: ["feature"] }
                      : {}),
                  },
                ],
          ),
          stderr: "",
        };
      if (args.includes("update")) {
        updates++;
        await onUpdate?.(cwd, args);
        throw refusal;
      }
      throw Error("unexpected fixture Goga: " + args.join(" "));
    },
  };
  const rawHost = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "fixture-goga",
  });
  fixtureScope().cleanup(() => rawHost.dispose());
  const host = fixtureScope().own(rawHost);
  const project = await host.addProject(source),
    manager = new CloneManager(home, runner);
  const record =
    kind === "managed"
      ? await manager.ensure(project, {
          projectId: project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : null;
  const root = record?.path ?? source,
    scope = record ? worktreeContextRef(record) : project.id;
  if (!record) await git(root, ["checkout", "feature"]);
  await fs.writeFile(path.join(root, "file"), "local\n");
  await git(root, ["commit", "-am", "local"]);
  // Materialize settings so synchronous publication pins refer to a durable owner.
  await host.readProjectSettings(scope);
  const update = async () => {
    const board = await host.readTopicBoard(scope, "2026");
    const plan = await host.prepareTopicOperation({
      projectId: project.id,
      ...(record ? { context: worktreeContextRef(record) } : {}),
      year: "2026",
      expectedRevision: board.revision,
      action: "update",
      target: { topic: "feature", branch: "feature", remote: false },
      baseRef: "main",
    });
    return host.executeTopicOperation(plan.token);
  };
  return {
    host,
    project,
    root,
    scope,
    source,
    git,
    update,
    setUpdate: (fn: typeof onUpdate) => (onUpdate = fn),
    setRefusal: (e: Error) => (refusal = e),
    updates: () => updates,
    postFailureStatus,
  };
}
it.each([
  ["primary", "merge"],
  ["managed", "merge"],
  ["primary", "rebase"],
  ["managed", "rebase"],
] as const)(
  "%s %s card refusal offers a separately confirmed native operation",
  fixtureScope.run(async (kind, strategy) => {
    const f = await fixture(kind, strategy);
    const original = (await f.git(f.root, ["rev-parse", "HEAD"])).stdout;
    const result = await f.update();
    expect(result.status).toBe("failed");
    expect(result.handoff).toBeDefined();
    expect((await f.host.readGitWorkspace(f.scope)).files).toEqual([]);
    const preview = await f.host.prepareGitUpdateHandoff({
      scope: f.scope,
      revision: (await f.host.readGitWorkspace(f.scope)).revision,
      candidateId: result.handoff!.candidateId,
    });
    expect(preview.candidate.scope).toEqual(f.scope);
    expect(preview.publishes).toBe(false);
    expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout).toBe(original);
    const started = await f.host.executeGitUpdateHandoff(preview.token);
    expect(started, started.log).toMatchObject({
      scope: f.scope,
      status: "conflict",
      changed: true,
      conflicts: ["file"],
    });
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe(strategy);
    if (strategy === "rebase") {
      await fs.writeFile(path.join(f.root, "file"), "resolved\n");
      await f.git(f.root, ["add", "file"]);
      const next = await f.host.prepareGitRebaseOperation({
        scope: f.scope,
        action: "continue",
        revision: (await f.host.readGitWorkspace(f.scope)).revision,
      });
      expect(await f.host.executeGitRebaseOperation(next.token)).toMatchObject({
        status: "success",
        native: { outcome: "completed", processSettled: true },
      });
    } else {
      const next = await f.host.prepareGitMergeOperation({
        scope: f.scope,
        action: "abort",
        revision: (await f.host.readGitWorkspace(f.scope)).revision,
      });
      expect(await f.host.executeGitMergeOperation(next.token)).toMatchObject({
        status: "success",
      });
    }
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
    await expect(
      f.host.executeGitUpdateHandoff(preview.token),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(60000),
);
it(
  "ordinary CLI failure is not authority to offer manual Git",
  fixtureScope.run(async () => {
    const f = await fixture("primary");
    f.setRefusal(Error("conflict merge rebase"));
    expect((await f.update()).handoff).toBeUndefined();
    expect(f.updates()).toBe(1);
  }),
  gitIntegrationBudget(60000),
);

it(
  "header update-base captures the clone only after refreshing its original base",
  fixtureScope.run(async () => {
    const f = await fixture("managed");
    const remote = path.join(path.dirname(f.source), "remote.git");
    await f.git(f.source, ["init", "--bare", remote]);
    await f.git(f.source, ["remote", "add", "origin", remote]);
    await f.git(f.source, ["push", "-u", "origin", "main"]);
    const originalBase = (
      await f.git(f.source, ["rev-parse", "HEAD"])
    ).stdout.trim();
    const remoteHead = (
      await f.git(f.source, [
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "remote-only fixture",
      ])
    ).stdout.trim();
    await f.git(f.source, ["push", "origin", `${remoteHead}:refs/heads/main`]);
    expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      originalBase,
    );
    const result = await f.host.runRepositoryAction({
      projectId: f.project.id,
      context: f.scope as Exclude<typeof f.scope, string>,
      action: "update-base",
    });
    expect(result.status).toBe("error");
    expect(result.handoff).toMatchObject({
      scope: f.scope,
      baseRef: "main",
      targetBranch: "feature",
      sourceOid: remoteHead,
    });
    expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      remoteHead,
    );
    expect(result.handoff!.sourceRef).toMatch(
      /^refs\/desktop\/repository-actions\//,
    );
    const preview = await f.host.prepareGitUpdateHandoff({
      scope: f.scope,
      revision: (await f.host.readGitWorkspace(f.scope)).revision,
      candidateId: result.handoff!.candidateId,
    });
    expect((await f.host.executeGitUpdateHandoff(preview.token)).status).toBe(
      "conflict",
    );
  }),
  gitIntegrationBudget(60000),
);
it(
  "a non-current original topic never offers an implicit checkout",
  fixtureScope.run(async () => {
    const f = await fixture("primary");
    await f.git(f.root, ["checkout", "-b", "other"]);
    const result = await f.update();
    expect(result.handoff).toBeUndefined();
    expect(
      (await f.git(f.root, ["branch", "--show-current"])).stdout.trim(),
    ).toBe("other");
  }),
  gitIntegrationBudget(60000),
);
it(
  "changing the pinned source invalidates preparation without starting Git",
  fixtureScope.run(async () => {
    const f = await fixture("primary"),
      result = await f.update();
    expect(result.handoff).toBeDefined();
    await f.git(f.root, ["update-ref", "refs/heads/main", "HEAD"]);
    await expect(
      f.host.prepareGitUpdateHandoff({
        scope: f.scope,
        revision: (await f.host.readGitWorkspace(f.scope)).revision,
        candidateId: result.handoff!.candidateId,
      }),
    ).rejects.toThrow();
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
  }),
  gitIntegrationBudget(60000),
);

it(
  "a real operation already left by Goga is not offered a second START",
  fixtureScope.run(async () => {
    const f = await fixture("primary");
    f.setUpdate(async (root, args) => {
      await f
        .git(root, ["merge", "--no-edit", args[args.indexOf("--base-ref") + 1]])
        .catch(() => {});
    });
    const result = await f.update();
    expect(result.handoff).toBeUndefined();
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("merge");
    expect(f.updates()).toBe(1);
  }),
  gitIntegrationBudget(60000),
);

it(
  "failure diagnostics cannot refresh the index after a handoff candidate has been pinned",
  fixtureScope.run(async () => {
    const f = await fixture("primary");
    const result = await f.update();
    expect(result.handoff).toBeDefined();
    expect(f.postFailureStatus.length).toBeGreaterThan(0);
    for (const args of f.postFailureStatus)
      expect(args).toContain("--no-optional-locks");
  }),
  gitIntegrationBudget(60000),
);

it(
  "managed Goga probes use physical native admission without repeating the display resolver",
  fixtureScope.run(async () => {
    const f = await fixture("managed");
    const head = (await f.git(f.root, ["rev-parse", "HEAD"])).stdout;
    const display = vi.spyOn(CloneManager.prototype, "resolveGitRead");
    const counts: number[][] = [];
    const locks = vi.spyOn(CloneStore.prototype as any, "locked");
    const capture = NativeGitUpdateHandoff.prototype.captureAttempt;
    const failure = NativeGitUpdateHandoff.prototype.afterFailure;
    vi.spyOn(
      NativeGitUpdateHandoff.prototype,
      "captureAttempt",
    ).mockImplementation(async function (
      this: NativeGitUpdateHandoff,
      ...args
    ) {
      const before = display.mock.calls.length;
      const locked = locks.mock.calls.length;
      try {
        return await capture.apply(this, args);
      } finally {
        counts.push([
          display.mock.calls.length - before,
          locks.mock.calls.length - locked,
        ]);
      }
    });
    vi.spyOn(
      NativeGitUpdateHandoff.prototype,
      "afterFailure",
    ).mockImplementation(async function (
      this: NativeGitUpdateHandoff,
      ...args
    ) {
      const before = display.mock.calls.length;
      const locked = locks.mock.calls.length;
      try {
        return await failure.apply(this, args);
      } finally {
        counts.push([
          display.mock.calls.length - before,
          locks.mock.calls.length - locked,
        ]);
      }
    });
    const result = await f.update();
    expect(result.status).toBe("failed");
    expect(result.handoff).toBeDefined();
    expect(counts).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(f.updates()).toBe(1);
    expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await f.host.readGitWorkspace(f.scope)).files).toEqual([]);
  }),
  gitIntegrationBudget(60000),
);
