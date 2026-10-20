import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HostService } from "../src/host/service";
import { NodeRunner, type Runner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { taskPath } from "../src/host/topic-task";
import type { Run } from "../src/shared/types";

vi.setConfig({ testTimeout: 30000 });
const services: HostService[] = [];
const runs = (service: HostService) => service as unknown as { runList: Run[] };
afterEach(async () => {
  for (const service of services.splice(0)) {
    runs(service).runList = [];
    await service.dispose();
  }
});
// Real HostService/CloneManager/Git. Retained disposable HOME/repositories only.
// No native adapter: every non-Git command fails. Only run-state is injected.
async function fixture(withTask = true) {
  const root = await fs.mkdtemp("/private/tmp/goga-clone-local-exchange-050-");
  const home = path.join(root, "home"),
    repo = path.join(root, "primary");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Synthetic Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const node = new NodeRunner(10000, env);
  const git = async (args: string[], cwd = repo) =>
    (
      await node.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        cwd,
        env,
      )
    ).stdout.trim();
  const write = async (cwd: string, name: string, text: string) => {
    const file = path.join(cwd, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const task = taskPath("alpha", "2026");
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Synthetic Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await write(repo, "base.txt", "base\n");
  await write(repo, "unrelated.txt", "old unrelated\n");
  await write(repo, ".gitignore", "ignored-local.txt\n");
  if (withTask) await write(repo, task, "committed selected task\n");
  await git(["add", "."]);
  await git(["commit", "-m", "synthetic base"]);
  await git(["branch", "alpha"]);
  const calls: { args: string[]; cwd: string }[] = [];
  const runner: Runner = {
    command: async (exe, args, cwd, overrides, stdin) => {
      if (exe !== "git" || !cwd.startsWith(root + path.sep))
        throw new Error("Non-fixture/native execution forbidden");
      if (
        args.some((a) => /^(?:https?|ssh|git):\/\//.test(a)) ||
        args.includes("push")
      )
        throw new Error("External transport forbidden");
      calls.push({ args: [...args], cwd });
      return node.command(exe, args, cwd, { ...env, ...overrides }, stdin);
    },
    start: () => {
      throw new Error("Native start forbidden");
    },
    kill: () => {
      throw new Error("No child should exist");
    },
    dispose: () => node.dispose(),
  };
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    runner,
    goga: "FORBIDDEN-NATIVE",
  });
  services.push(service);
  const project = await service.addProject(repo),
    clones = new CloneManager(home, runner);
  const owner = await clones.ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "alpha",
    branch: "alpha",
  });
  await write(owner.path, "clone-only.txt", "unique clone commit\n");
  await git(["add", "."], owner.path);
  await git(["commit", "-m", "synthetic unique clone commit"], owner.path);
  const ref = worktreeContextRef(owner),
    cloneOid = await git(["rev-parse", "HEAD"], owner.path);
  calls.length = 0;
  return {
    root,
    home,
    repo,
    git,
    write,
    task,
    calls,
    owner,
    ref,
    cloneOid,
    project,
    service,
    clones,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(f: Fixture, cwd = f.repo) {
  const files: Record<string, { hash: string; mode: number }> = {};
  const walk = async (dir: string) => {
    for (const name of (await fs.readdir(dir)).sort()) {
      if (dir === cwd && name === ".git") continue;
      const file = path.join(dir, name),
        stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(file);
      else
        files[path.relative(cwd, file)] = {
          hash: createHash("sha256")
            .update(
              stat.isSymbolicLink()
                ? await fs.readlink(file)
                : await fs.readFile(file),
            )
            .digest("hex"),
          mode: stat.mode,
        };
    }
  };
  await walk(cwd);
  return {
    head: await f.git(["rev-parse", "HEAD"], cwd),
    branch: await f.git(["symbolic-ref", "HEAD"], cwd),
    index: (await fs.readFile(path.join(cwd, ".git/index"))).toString("hex"),
    status: await f.git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    ),
    refs: await f.git(
      [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/tags",
        "refs/remotes",
      ],
      cwd,
    ),
    files,
  };
}
const destinationRefs = (f: Fixture) =>
  f.git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/desktop/contexts",
  ]);
function noMutation(f: Fixture) {
  expect(
    f.calls.filter(({ args }) =>
      args.some((a) =>
        [
          "merge",
          "reset",
          "stash",
          "clean",
          "commit",
          "checkout",
          "switch",
          "rebase",
          "cherry-pick",
          "push",
          "--force",
          "-f",
        ].includes(a),
      ),
    ),
  ).toEqual([]);
  for (const call of f.calls.filter(({ args }) => args.includes("fetch"))) {
    expect(call.cwd).toBe(f.repo);
    expect(call.args).toContain(f.owner.path);
    expect(call.args).toContain("--no-write-fetch-head");
    expect(call.args.some((a) => /^\+/.test(a))).toBe(false);
  }
}
async function synced(f: Fixture) {
  const state = await f.service.syncTopicContext(f.ref);
  expect(state.status, state.error).toBe("synced");
  expect(state.importedOid).toBe(f.cloneOid);
  return state;
}
async function allowedPreview(f: Fixture) {
  await synced(f);
  const preview = await f.service.prepareContextApply(f.ref);
  expect(preview.canApply, preview.reason).toBe(true);
  return preview;
}
const apply = (f: Fixture, token: string, confirmed = true) =>
  f.service.applyContext({
    projectId: f.project.id,
    token,
    confirmed: confirmed as true,
  });
function activeRun(f: Fixture, owner: "clone" | "primary") {
  runs(f.service).runList = [
    {
      id: "synthetic-active",
      projectId: f.project.id,
      status: "running",
      ...(owner === "clone" ? { context: f.ref } : {}),
    } as Run,
  ];
}
async function unchanged(
  f: Fixture,
  primary: Awaited<ReturnType<typeof snapshot>>,
  clone: Awaited<ReturnType<typeof snapshot>>,
) {
  expect(await snapshot(f)).toEqual(primary);
  expect(await snapshot(f, f.owner.path)).toEqual(clone);
  noMutation(f);
}

describe("clone-local exchange: sync is not apply", () => {
  it.each([
    "unstaged-task",
    "staged-task",
    "untracked-task",
    "committed-divergent-primary",
  ])(
    "imports commits with %s and unrelated dirty files without changing either checkout",
    async (mode) => {
      const f = await fixture(mode !== "untracked-task");
      await f.write(f.repo, f.task, "primary-only selected task\n");
      if (mode === "staged-task" || mode === "committed-divergent-primary")
        await f.git(["add", f.task]);
      if (mode === "committed-divergent-primary")
        await f.git(["commit", "-m", "synthetic divergent primary"]);
      await f.write(f.repo, "unrelated.txt", "staged unrelated\n");
      await f.git(["add", "unrelated.txt"]);
      await f.write(f.repo, "unrelated.txt", "unstaged after staging\n");
      for (const cwd of [f.repo, f.owner.path]) {
        await f.write(cwd, "untracked/precious.txt", "precious untracked\n");
        await f.write(cwd, "ignored-local.txt", "precious ignored\n");
      }
      await f.write(f.owner.path, "unrelated.txt", "clone unsaved tracked\n");
      const before = await snapshot(f),
        cloneBefore = await snapshot(f, f.owner.path);
      expect(await destinationRefs(f)).toBe("");
      const state = await synced(f);
      expect(state.destinationRef).toMatch(
        new RegExp(`^refs/desktop/contexts/${f.ref.contextId}/[a-f0-9-]{36}$`),
      );
      expect(await f.git(["rev-parse", state.destinationRef!])).toBe(
        f.cloneOid,
      );
      expect(
        await f.git(["show", `${state.destinationRef}:clone-only.txt`]),
      ).toBe("unique clone commit");
      expect(await destinationRefs(f)).toBe(
        `${state.destinationRef} ${f.cloneOid}`,
      );
      await unchanged(f, before, cloneBefore);
      await expect(
        fs.stat(path.join(f.repo, "clone-only.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await f.service.topicSyncStatus(f.ref)).status).toBe("synced");
      expect((await f.service.syncTopicContext(f.ref)).destinationRef).toBe(
        state.destinationRef,
      );
      await unchanged(f, before, cloneBefore);
    },
  );
  it("queues active-owner sync and later imports without applying", async () => {
    const f = await fixture(),
      before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path);
    activeRun(f, "clone");
    expect((await f.service.syncTopicContext(f.ref)).status).toBe("waiting");
    expect(await destinationRefs(f)).toBe("");
    runs(f.service).runList = [];
    await synced(f);
    await unchanged(f, before, cloneBefore);
  });
  it("rejects mismatched and stale owner refs before importing", async () => {
    const f = await fixture(),
      before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path);
    for (const ref of [
      { ...f.ref, revision: randomUUID() },
      { ...f.ref, topic: "other" },
      { ...f.ref, branch: "other" },
    ]) {
      await expect(f.service.syncTopicContext(ref)).rejects.toThrow();
      await expect(f.service.prepareContextApply(ref)).rejects.toThrow();
    }
    expect(await destinationRefs(f)).toBe("");
    await unchanged(f, before, cloneBefore);
  });
  it("does not create an apply preview without a prior explicit sync", async () => {
    const f = await fixture(),
      before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path);
    await expect(f.service.prepareContextApply(f.ref)).rejects.toThrow(
      /синхронизируйте/i,
    );
    expect(await destinationRefs(f)).toBe("");
    await unchanged(f, before, cloneBefore);
  });
});

describe("clone-local exchange: explicit apply protections", () => {
  it.each(["tracked", "untracked", "staged"])(
    "blocks preview and execution with %s primary changes without loss",
    async (kind) => {
      const f = await fixture(),
        preview = await allowedPreview(f);
      await f.write(
        f.repo,
        kind === "untracked" ? "precious-new.txt" : f.task,
        "precious primary edit\n",
      );
      if (kind === "staged") await f.git(["add", f.task]);
      const before = await snapshot(f),
        cloneBefore = await snapshot(f, f.owner.path),
        blocked = await f.service.prepareContextApply(f.ref);
      expect(blocked.canApply).toBe(false);
      expect(blocked.reason).toMatch(/локальн.*изменени/i);
      await expect(apply(f, preview.token)).rejects.toThrow(
        /локальн.*изменени/i,
      );
      await expect(apply(f, blocked.token)).rejects.toThrow(
        /устарел|использован/i,
      );
      await unchanged(f, before, cloneBefore);
    },
  );
  it("invalidates a preview after a new primary commit", async () => {
    const f = await fixture(),
      preview = await allowedPreview(f);
    await f.write(f.repo, "new-primary.txt", "must survive stale apply\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "synthetic primary after preview"]);
    const before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path);
    await expect(apply(f, preview.token)).rejects.toThrow(/измен|устар/i);
    await unchanged(f, before, cloneBefore);
  });
  it("reports conflicts without modifying either checkout or creating MERGE_HEAD", async () => {
    const f = await fixture();
    await f.write(f.repo, "base.txt", "primary conflict\n");
    await f.git(["commit", "-am", "synthetic primary conflict"]);
    await f.write(f.owner.path, "base.txt", "clone conflict\n");
    await f.git(["commit", "-am", "synthetic clone conflict"], f.owner.path);
    f.cloneOid = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await synced(f);
    const before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path),
      preview = await f.service.prepareContextApply(f.ref);
    expect(preview.canApply).toBe(false);
    expect(preview.reason).toMatch(/конфликт/i);
    await expect(apply(f, preview.token)).rejects.toThrow(
      /устарел|использован/i,
    );
    await expect(
      fs.stat(path.join(f.repo, ".git/MERGE_HEAD")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await unchanged(f, before, cloneBefore);
  });
  it.each(["clone", "primary"] as const)(
    "blocks preview and execution while %s run is active",
    async (owner) => {
      const f = await fixture(),
        preview = await allowedPreview(f);
      activeRun(f, owner);
      const before = await snapshot(f),
        cloneBefore = await snapshot(f, f.owner.path),
        blocked = await f.service.prepareContextApply(f.ref);
      expect(blocked.canApply).toBe(false);
      expect(blocked.reason).toMatch(/активн/i);
      await expect(apply(f, preview.token)).rejects.toThrow(/активн/i);
      await unchanged(f, before, cloneBefore);
    },
  );
  it("rejects a changed service ref at preview and execution", async () => {
    const f = await fixture(),
      preview = await allowedPreview(f),
      state = await f.service.topicSyncStatus(f.ref);
    await f.git([
      "update-ref",
      state.destinationRef!,
      preview.targetOid,
      preview.sourceOid,
    ]);
    const before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path),
      blocked = await f.service.prepareContextApply(f.ref);
    expect(blocked.canApply).toBe(false);
    expect(blocked.reason).toMatch(/ссылк.*измен/i);
    await expect(apply(f, preview.token)).rejects.toThrow(/измен/i);
    expect(await f.git(["rev-parse", state.destinationRef!])).toBe(
      preview.targetOid,
    );
    await unchanged(f, before, cloneBefore);
  });
  it("invalidates the preview after newer clone sync, retaining both imported commits", async () => {
    const f = await fixture(),
      preview = await allowedPreview(f),
      first = await f.service.topicSyncStatus(f.ref);
    await f.write(
      f.owner.path,
      "second-clone.txt",
      "second unique clone commit\n",
    );
    await f.git(["add", "."], f.owner.path);
    await f.git(
      ["commit", "-m", "synthetic second clone commit"],
      f.owner.path,
    );
    f.cloneOid = await f.git(["rev-parse", "HEAD"], f.owner.path);
    const second = await synced(f);
    const before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path);
    await expect(apply(f, preview.token)).rejects.toThrow(/измен|устар/i);
    expect(second.destinationRef).not.toBe(first.destinationRef);
    expect(await f.git(["rev-parse", first.destinationRef!])).toBe(
      first.importedOid,
    );
    expect(await f.git(["rev-parse", second.destinationRef!])).toBe(
      second.importedOid,
    );
    await unchanged(f, before, cloneBefore);
  });
  it("rejects a preview after exact-owner registry revision refresh", async () => {
    const f = await fixture(),
      preview = await allowedPreview(f);
    await f.git(["checkout", "--detach"], f.owner.path);
    expect((await f.clones.reconcile(f.project.id))[0].state).toBe("conflict");
    await f.git(["checkout", f.owner.branch], f.owner.path);
    const restored = (await f.clones.reconcile(f.project.id))[0];
    expect(restored.state).toBe("ready");
    expect(restored.revision).not.toBe(f.ref.revision);
    const before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path);
    await expect(apply(f, preview.token)).rejects.toThrow();
    await expect(f.service.prepareContextApply(f.ref)).rejects.toThrow();
    await unchanged(f, before, cloneBefore);
  });
  it("requires matching explicit confirmation and applies the safe previewed commit only once", async () => {
    const f = await fixture(),
      preview = await allowedPreview(f),
      before = await snapshot(f),
      cloneBefore = await snapshot(f, f.owner.path);
    expect(preview.files).toEqual(["clone-only.txt"]);
    await expect(apply(f, preview.token, false)).rejects.toThrow(
      /подтверждени/i,
    );
    await expect(
      f.service.applyContext({
        projectId: "another-project",
        token: preview.token,
        confirmed: true,
      }),
    ).rejects.toThrow(/другого проекта/i);
    await unchanged(f, before, cloneBefore);
    const result = await apply(f, preview.token);
    expect(result).toMatchObject({
      contextId: f.ref.contextId,
      previousTargetOid: before.head,
      sourceOid: f.cloneOid,
      targetOid: f.cloneOid,
      targetBranch: "main",
    });
    const after = await snapshot(f);
    expect(after.head).toBe(f.cloneOid);
    expect(after.branch).toBe(before.branch);
    expect(after.status).toBe("");
    expect(await fs.readFile(path.join(f.repo, "clone-only.txt"), "utf8")).toBe(
      "unique clone commit\n",
    );
    for (const [file, value] of Object.entries(before.files))
      expect(after.files[file]).toEqual(value);
    expect(await snapshot(f, f.owner.path)).toEqual(cloneBefore);
    await expect(apply(f, preview.token)).rejects.toThrow(
      /устарел|использован/i,
    );
    const merges = f.calls.filter(({ args }) => args.includes("merge"));
    expect(merges).toHaveLength(1);
    expect(merges[0].cwd).toBe(f.repo);
    expect(merges[0].args).toContain("--no-autostash");
    expect(merges[0].args).toContain(f.cloneOid);
    expect(
      f.calls.some(({ args }) =>
        args.some((a) =>
          ["reset", "stash", "clean", "push", "--force"].includes(a),
        ),
      ),
    ).toBe(false);
  });
});
