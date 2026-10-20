import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import path from "node:path";
import { withReadScope } from "../src/host/read-scope";
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
async function fixture(task?: string) {
  const root = await fs.mkdtemp("/private/tmp/goga-card49-");
  cleanups.push(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
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
          env: {
            ...env,
            ...overrides,
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
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
  const selectedFiles = async (cwd: string) => {
    const folder = path.dirname(taskAt(cwd));
    try {
      const files = await fs.readdir(folder, { recursive: true });
      const result: Record<string, string> = {};
      for (const name of files.sort()) {
        const file = path.join(folder, name);
        if ((await fs.lstat(file)).isFile())
          result[name] = (await fs.readFile(file)).toString("base64");
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const snapshot = async (cwd = repo) => ({
    selectedFiles: await selectedFiles(cwd),
    projectConfig: await fs.readFile(
      path.join(cwd, ".goga/config.yml"),
      "utf8",
    ),
    head: await git(["rev-parse", "HEAD"], cwd),
    branch: await git(["branch", "--show-current"], cwd),
    index: await fs
      .readFile(path.join(cwd, ".git/index"))
      .then((x) => x.toString("base64")),
    status: await git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    ),
    refs: await git(
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
      cwd,
    ),
    config: await fs.readFile(path.join(cwd, ".git/config"), "utf8"),
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

const target = { topic: "feature-test", branch: "feature/test", remote: false };
async function owned(task?: string) {
  const f = await fixture(task);
  const owner = await f.manager.ensure(f.project, f.identity);
  const ref = worktreeContextRef(owner);
  const read = () => f.service.readTopicDetails(ref, "2026", target);
  const frozen = async () => ({
    primary: await f.snapshot(),
    clone: await f.snapshot(owner.path),
    registry: await fs.readFile(
      path.join(f.home, ".goga/desktop/clones/registry.json"),
      "utf8",
    ),
    directories: await fs.readdir(path.dirname(owner.path)),
  });
  const plan = async (cwd = f.repo) => {
    const file = path.join(cwd, ".goga/history/2026/feature-test/plan.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "# Selected plan\n");
  };
  const noWrites = () => {
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(
      f.calls.filter(
        (c) =>
          c.exe === "git" &&
          c.args.some((a) =>
            [
              "clone",
              "fetch",
              "merge",
              "reset",
              "pull",
              "checkout",
              "add",
              "commit",
              "update-ref",
              "push",
            ].includes(a),
          ),
      ),
    ).toEqual([]);
  };
  return { ...f, owner, ref, read, frozen, plan, noWrites };
}
nativeDescribe(".50 autonomous clone-local reads", { timeout: 30000 }, () => {
  it.each([undefined, "Own clone task\n"])(
    "reads exact ready clone without primary task prerequisite (%s)",
    async (localTask) => {
      const f = await owned();
      await f.writeTask("Untracked primary description\n");
      if (localTask !== undefined) await f.writeTask(localTask, f.owner.path);
      const before = await f.frozen();
      f.calls.splice(0);
      const card = await f.read();
      expect(card).toMatchObject({
        text: localTask ?? "",
        exists: localTask !== undefined,
        editable: true,
      });
      expect(card.catalogState).toBe(
        localTask === undefined ? "missing-local-metadata" : undefined,
      );
      expect(card.version).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        f.service.readTopicTask({
          projectId: f.project.id,
          context: f.ref,
          topic: f.ref.topic,
          branch: f.ref.branch,
        }),
      ).resolves.toMatchObject({
        version: card.version,
        text: localTask ?? "",
        exists: localTask !== undefined,
        ...(localTask === undefined
          ? { catalogState: "missing-local-metadata" }
          : {}),
      });
      await expect(
        f.service.checkTopicContextReadiness(f.ref),
      ).resolves.toMatchObject({ contextId: f.ref.contextId });
      expect(await f.frozen()).toEqual(before);
      f.noWrites();
      expect(f.calls.some((c) => c.cwd === f.repo && c.exe === native)).toBe(
        false,
      );
      expect(
        f.calls.some(
          (c) =>
            c.cwd === f.repo &&
            c.args.some((a) => ["ls-tree", "cat-file"].includes(a)),
        ),
      ).toBe(false);
    },
  );
});

nativeDescribe(
  "clone-local missing data and safety",
  { timeout: 30000 },
  () => {
    it.each([
      "absent",
      "untracked-task",
      "committed-task",
      "untracked-plan",
      "committed-plan",
      "noncurrent-plan",
      "other-year",
    ])(
      "does not substitute %s primary data or lose clone commits",
      async (kind) => {
        const f = await owned();
        await fs.writeFile(path.join(f.owner.path, "unique"), "keep\n");
        await f.git(["add", "unique"], f.owner.path);
        await f.git(["commit", "-m", "unique"], f.owner.path);
        if (kind.includes("task")) await f.writeTask("Primary only\n");
        if (kind.includes("plan")) await f.plan();
        if (kind.startsWith("committed") || kind === "noncurrent-plan") {
          await f.git(["add", "."]);
          await f.git(["commit", "-m", "primary"]);
        }
        if (kind === "noncurrent-plan") {
          await f.git(["checkout", "-b", "other"]);
          await f.writeTask("Other branch dirty\n");
        }
        if (kind === "other-year") {
          const file = path.join(
            f.owner.path,
            ".goga/history/2025/feature-test/plan.md",
          );
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, "# Other year\n");
        }
        const before = await f.frozen();
        f.calls.splice(0);
        await expect(f.read()).resolves.toMatchObject({
          exists: false,
          text: "",
          editable: true,
          catalogState: "missing-local-metadata",
        });
        expect(await f.frozen()).toEqual(before);
        f.noWrites();
        expect(f.calls.some((c) => c.cwd === f.repo && c.exe === native)).toBe(
          false,
        );
      },
    );
    it.each(["working", "committed", "unchanged", "plan-only"])(
      "preserves readable %s clone despite dirty primary",
      async (kind) => {
        const f = await owned(kind === "plan-only" ? undefined : "Baseline\n");
        if (kind === "plan-only") await f.plan(f.owner.path);
        if (["working", "committed"].includes(kind))
          await f.writeTask("Own task\n", f.owner.path);
        if (kind === "committed") {
          await f.git(["add", "."], f.owner.path);
          await f.git(["commit", "-m", "own"], f.owner.path);
        }
        await f.writeTask("Dirty source\n");
        const before = await f.frozen();
        f.calls.splice(0);
        const doc = await f.read();
        expect(doc.text).toBe(
          kind === "plan-only"
            ? ""
            : kind === "unchanged"
              ? "Baseline\n"
              : "Own task\n",
        );
        expect(doc.catalogState).toBeUndefined();
        expect(await f.frozen()).toEqual(before);
        f.noWrites();
      },
    );
    it("keeps primary/remote absence generic and rejects wrong exact year and owner", async () => {
      const f = await owned();
      for (const t of [
        { ...target, topic: "absent", branch: "absent" },
        { ...target, remote: true },
      ])
        await expect(
          f.service.readTopicDetails(f.project.id, "2026", t),
        ).rejects.toThrow("Топик отсутствует. Обновите каталог.");
      await expect(
        f.service.readTopicDetails(f.ref, "2025", target),
      ).rejects.toThrow(/другому контексту/);
      await expect(
        f.service.readTopicDetails(f.ref, "2026", { ...target, remote: true }),
      ).rejects.toThrow(/другому контексту/);
      f.calls.splice(0);
      for (const ref of [
        { ...f.ref, contextId: "ctx-" + "0".repeat(64) },
        { ...f.ref, revision: "00000000-0000-4000-8000-000000000000" },
      ])
        await expect(
          f.service.readTopicDetails(ref, "2026", target),
        ).rejects.toThrow();
      expect(f.calls.some((c) => c.exe === native)).toBe(false);
      f.noWrites();
    });
    it.each([
      "failure",
      "malformed",
      "duplicate",
      "cancel",
      "task",
      "same-text",
      "catalog",
      "owner",
    ])(
      "rejects actual clone %s or late race without misclassifying absence",
      async (kind) => {
        const f = await owned(
          kind === "same-text" || kind === "duplicate" ? "Own\n" : undefined,
        );
        const before = await f.frozen(),
          controller = new AbortController();
        const original = f.runner.command.getMockImplementation()!;
        let reads = 0,
          injected = false;
        f.calls.splice(0);
        f.runner.command.mockImplementation(
          async (...args: Parameters<typeof original>) => {
            if (
              args[0] === native &&
              args[2] === f.owner.path &&
              args[1].includes("--per-host") &&
              !args[1].includes("--remote")
            ) {
              reads++;
              if (kind === "failure") throw Error("Actual native unavailable");
              if (kind === "malformed")
                return { stdout: "not json", stderr: "" };
              const result = await original(...args);
              if (kind === "duplicate")
                return {
                  ...result,
                  stdout: JSON.stringify([
                    ...JSON.parse(result.stdout),
                    ...JSON.parse(result.stdout),
                  ]),
                };
              if (!injected && reads === 2) {
                injected = true;
                if (kind === "cancel") controller.abort();
                if (kind === "task")
                  await f.writeTask("Late clone task\n", f.owner.path);
                if (kind === "same-text") {
                  await fs.writeFile(f.taskAt(f.owner.path) + ".new", "Own\n");
                  await fs.rename(
                    f.taskAt(f.owner.path) + ".new",
                    f.taskAt(f.owner.path),
                  );
                }
                if (kind === "catalog") await f.plan(f.owner.path);
                if (kind === "owner") {
                  const file = path.join(
                      f.home,
                      ".goga/desktop/clones/registry.json",
                    ),
                    registry = JSON.parse(await fs.readFile(file, "utf8"));
                  registry.records.find(
                    (r: any) => r.contextId === f.ref.contextId,
                  ).revision = "00000000-0000-4000-8000-000000000001";
                  await fs.writeFile(file, JSON.stringify(registry));
                }
              }
              return result;
            }
            return original(...args);
          },
        );
        await expect(withReadScope(controller.signal, f.read)).rejects.toThrow(
          kind === "duplicate"
            ? /неоднозначен/
            : kind === "cancel"
              ? /отмен/
              : kind === "failure"
                ? /Goga/
                : kind === "malformed"
                  ? /JSON/
                  : /измен|устарел|подтвержд/i,
        );
        f.noWrites();
        if (["failure", "malformed", "duplicate", "cancel"].includes(kind))
          expect(await f.frozen()).toEqual(before);
      },
    );
    it("preserves already-cancelled read", async () => {
      const f = await owned(),
        controller = new AbortController();
      controller.abort();
      await expect(withReadScope(controller.signal, f.read)).rejects.toThrow(
        /отмен/,
      );
    });
    it("does not consult failing or ambiguous primary catalog", async () => {
      const f = await owned();
      await f.plan();
      const original = f.runner.command.getMockImplementation()!;
      f.runner.command.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          if (args[0] === native && args[2] === f.repo)
            throw Error("Primary catalog must not be consulted");
          return original(...args);
        },
      );
      await expect(f.read()).resolves.toMatchObject({
        catalogState: "missing-local-metadata",
      });
    });
  },
);

nativeDescribe("explicit local task save", { timeout: 30000 }, () => {
  async function prepare(f: Awaited<ReturnType<typeof owned>>, task: string) {
    const doc = await f.read(),
      board = await f.service.readTopicBoard(f.ref, "2026");
    return f.service.prepareTopicOperation({
      projectId: f.project.id,
      context: f.ref,
      year: "2026",
      expectedRevision: board.revision,
      action: "save-task",
      target,
      task,
      taskVersion: doc.version,
    });
  }
  it("creates missing local todo only after confirmation without commit/publication", async () => {
    const f = await owned();
    await f.writeTask("Untracked primary\n");
    const before = await f.frozen();
    f.calls.splice(0);
    const plan = await prepare(f, "Explicit clone input\n");
    expect(await f.frozen()).toEqual(before);
    expect((await f.service.executeTopicOperation(plan.token)).status).toBe(
      "success",
    );
    expect(await fs.readFile(f.taskAt(f.owner.path), "utf8")).toBe(
      "Explicit clone input\n",
    );
    const after = await f.frozen();
    expect(after.primary).toEqual(before.primary);
    expect(after.registry).toEqual(before.registry);
    expect(after.clone.head).toBe(before.clone.head);
    expect(after.clone.index).toBe(before.clone.index);
    expect(after.clone.refs).toBe(before.clone.refs);
    f.noWrites();
    await expect(f.read()).resolves.toMatchObject({
      text: "Explicit clone input\n",
      exists: true,
    });
  });
  it("does not initialize missing local metadata using empty text", async () => {
    const f = await owned(),
      before = await f.frozen();
    await expect(prepare(f, " \n")).rejects.toThrow(/непуст|описание задачи/i);
    expect(await f.frozen()).toEqual(before);
  });
  it.each(["task", "catalog", "owner"])(
    "invalidates confirmation after late %s",
    async (kind) => {
      const f = await owned(),
        plan = await prepare(f, "My input\n");
      if (kind === "task") await f.writeTask("External input\n", f.owner.path);
      if (kind === "catalog") await f.plan(f.owner.path);
      if (kind === "owner") {
        const file = path.join(f.home, ".goga/desktop/clones/registry.json"),
          registry = JSON.parse(await fs.readFile(file, "utf8"));
        registry.records.find(
          (r: any) => r.contextId === f.ref.contextId,
        ).revision = "00000000-0000-4000-8000-000000000001";
        await fs.writeFile(file, JSON.stringify(registry));
      }
      const before = await f.frozen();
      await expect(
        f.service.executeTopicOperation(plan.token),
      ).rejects.toThrow();
      expect(await f.frozen()).toEqual(before);
    },
  );
});

nativeDescribe("synthetic engine owner launch", { timeout: 30000 }, () => {
  async function request(f: Awaited<ReturnType<typeof owned>>, text: string) {
    const original = f.runner.command.getMockImplementation()!;
    f.runner.command.mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (args[0] === native && args[1].includes("--list"))
          return {
            stdout:
              "* build\n    name: Synthetic pipeline\n    description: No native engine\n",
            stderr: "",
          };
        if (args[0] === native && args[1].includes("--info"))
          return {
            stdout: "name: Build\n---\n* work:\n    title: Work\n",
            stderr: "",
          };
        return original(...args);
      },
    );
    const pipeline = {
      projectId: f.project.id,
      context: f.ref,
      pipeline: "build",
      workflow: "none",
      profile: "",
      skips: [],
    };
    const preview = await f.service.preview(pipeline);
    const task = await f.service.readTopicTask({
      projectId: f.project.id,
      context: f.ref,
      branch: f.ref.branch,
      topic: f.ref.topic,
    });
    return {
      ...pipeline,
      topic: {
        mode: "existing" as const,
        branch: f.ref.branch,
        topic: f.ref.topic,
      },
      clean: false,
      expectedBranch: f.ref.branch,
      confirmBranchSwitch: false,
      previewToken: preview.token,
      task: text,
      taskVersion: task.version,
      confirmEmptyTask: true,
    };
  }
  it("rejects forged empty exact-owner launch before writing or starting even when empty confirmation is true", async () => {
    const f = await owned();
    await f.writeTask("Dirty source\n");
    const input = await request(f, " \n"),
      before = await f.frozen();
    await expect(f.service.launch(input)).rejects.toThrow(
      /непуст|описание задачи/i,
    );
    expect(await f.frozen()).toEqual(before);
    expect(f.runner.start).not.toHaveBeenCalled();
  });
  it("launches explicit nonempty local input without native create, commit or primary mutation", async () => {
    const f = await owned();
    await f.writeTask("Dirty source\n");
    const input = await request(f, "Explicit owner launch\n"),
      before = await f.frozen();
    const { EventEmitter } = await import("node:events"),
      { PassThrough } = await import("node:stream");
    const { ContextSyncManager } = await import("../src/host/context-sync");
    vi.spyOn(ContextSyncManager.prototype, "afterRun").mockResolvedValue(
      {} as any,
    );
    f.runner.start.mockImplementation(
      () =>
        Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }) as never,
    );
    const run = await f.service.launch(input);
    expect(run.context?.contextId).toBe(f.ref.contextId);
    expect(f.runner.start).toHaveBeenCalledOnce();
    expect((f.runner.start.mock.calls[0] as unknown[])[2]).toBe(f.owner.path);
    expect(await fs.readFile(f.taskAt(f.owner.path), "utf8")).toBe(input.task);
    const after = await f.frozen();
    expect(after.primary).toEqual(before.primary);
    expect(after.clone.head).toBe(before.clone.head);
    expect(after.clone.index).toBe(before.clone.index);
    expect(after.clone.refs).toBe(before.clone.refs);
    await f.service.stop(run.id);
  });
  it.each(["task", "owner"])(
    "rejects stale %s before an owner launch",
    async (kind) => {
      const f = await owned(),
        input = await request(f, "My input\n");
      if (kind === "task") await f.writeTask("External task\n", f.owner.path);
      else {
        const file = path.join(f.home, ".goga/desktop/clones/registry.json"),
          registry = JSON.parse(await fs.readFile(file, "utf8"));
        registry.records.find(
          (r: any) => r.contextId === f.ref.contextId,
        ).revision = "00000000-0000-4000-8000-000000000001";
        await fs.writeFile(file, JSON.stringify(registry));
      }
      const before = await f.frozen();
      await expect(f.service.launch(input)).rejects.toThrow(/измен|устарел/i);
      expect(await f.frozen()).toEqual(before);
      expect(f.runner.start).not.toHaveBeenCalled();
    },
  );
  it.each(["before-launch", "during-compose"])(
    "rejects missing-catalog confirmation after metadata appears %s before authorized todo write",
    async (kind) => {
      const f = await owned(),
        input = await request(f, "Would overwrite absence\n");
      const { EventEmitter } = await import("node:events"),
        { PassThrough } = await import("node:stream");
      const { ContextSyncManager } = await import("../src/host/context-sync");
      vi.spyOn(ContextSyncManager.prototype, "afterRun").mockResolvedValue(
        {} as any,
      );
      f.runner.start.mockImplementation(
        () =>
          Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          }) as never,
      );
      if (kind === "before-launch") await f.plan(f.owner.path);
      else {
        const original = f.runner.command.getMockImplementation()!;
        f.runner.command.mockImplementation(
          async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (args[0] === native && args[1].includes("--info"))
              await f.plan(f.owner.path);
            return result;
          },
        );
      }
      await expect(f.service.launch(input)).rejects.toThrow(
        /каталог|измен|устарел/i,
      );
      await expect(fs.stat(f.taskAt(f.owner.path))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.runner.start).not.toHaveBeenCalled();
    },
  );
});

nativeDescribe("fresh autonomous preparation", { timeout: 30000 }, () => {
  it("prepares a clone from an untracked source task without requiring a commit or copying that task", async () => {
    const f = await fixture();
    await f.writeTask("Primary untracked task must stay primary\n");
    const before = await f.snapshot();
    await expect(
      f.service.checkTopicContextReadiness(f.identity),
    ).resolves.toBeNull();
    const owner = await f.service.ensureTopicContext(f.identity),
      ref = worktreeContextRef(owner);
    expect(owner.state).toBe("ready");
    await expect(
      f.service.readTopicTask({
        projectId: f.project.id,
        context: ref,
        branch: ref.branch,
        topic: ref.topic,
      }),
    ).resolves.toMatchObject({
      exists: false,
      text: "",
      catalogState: "missing-local-metadata",
    });
    expect(await f.snapshot()).toEqual(before);
    expect(f.runner.start).not.toHaveBeenCalled();
  });
});

nativeDescribe(
  "remote catalog projection isolation",
  { timeout: 30000 },
  () => {
    async function remoteOnly() {
      const f = await fixture("Remote-only committed task\n");
      await f.git(["update-ref", "refs/remotes/origin/feature/test", "HEAD"]);
      await f.git(["checkout", "-b", "main"]);
      await f.git(["branch", "-D", "feature/test"]);
      const remoteTarget = {
        topic: "feature-test",
        branch: "origin/feature/test",
        remote: true,
      };
      expect(
        await f.git([
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/feature/test",
        ]),
      ).toBe("");
      const board = await f.service.readTopicBoard(f.project.id, "2026");
      expect(board.records).toContainEqual(
        expect.objectContaining(remoteTarget),
      );
      expect(board.remoteRecords).toContainEqual(
        expect.objectContaining(remoteTarget),
      );
      return { ...f, remoteTarget };
    }
    it("reads a remote-only real ref once even when both native projections contain its row", async () => {
      const f = await remoteOnly(),
        before = await f.snapshot();
      f.calls.splice(0);
      const doc = await f.service.readTopicDetails(
        f.project.id,
        "2026",
        f.remoteTarget,
      );
      expect(doc).toMatchObject({
        text: "Remote-only committed task\n",
        exists: true,
        editable: false,
        target: f.remoteTarget,
      });
      expect(doc.catalogState).toBeUndefined();
      expect(await f.snapshot()).toEqual(before);
      expect(f.runner.start).not.toHaveBeenCalled();
      expect(
        f.calls.filter(
          (c) =>
            c.exe === "git" &&
            c.args.some((a) =>
              [
                "clone",
                "fetch",
                "merge",
                "reset",
                "pull",
                "checkout",
                "add",
                "commit",
                "update-ref",
                "push",
              ].includes(a),
            ),
        ),
      ).toEqual([]);
    });
    it("still rejects duplicate exact rows inside the selected remote projection", async () => {
      const f = await remoteOnly(),
        original = f.runner.command.getMockImplementation()!;
      f.runner.command.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          const result = await original(...args);
          if (
            args[0] === native &&
            args[1].includes("--remote") &&
            args[1].includes("--per-host")
          ) {
            const rows = JSON.parse(result.stdout);
            return { ...result, stdout: JSON.stringify([...rows, ...rows]) };
          }
          return result;
        },
      );
      await expect(
        f.service.readTopicDetails(f.project.id, "2026", f.remoteTarget),
      ).rejects.toThrow(/неоднозначен/);
    });
  },
);
