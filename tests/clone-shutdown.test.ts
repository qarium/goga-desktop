import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CloneManager } from "../src/host/clones";
import { NodeRunner, RunnerShutdownError } from "../src/host/process";
import { ContextExchangeManager } from "../src/host/context-exchange";
import { seedLegacyPublication } from "./helpers/legacy-publication";
import { worktreeContextRef } from "../src/shared/worktrees";
const execute = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-clone-shutdown48-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "primary"),
    home = path.join(root, "home");
  await fs.mkdir(repo);
  await fs.mkdir(home);
  const env = {
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
        env: { ...process.env, ...env },
      })
    ).stdout;
  await git(["init", "-b", "feature/test"]);
  await fs.writeFile(path.join(repo, "README"), "Synthetic shutdown fixture\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  const native = new NodeRunner(10000, env);
  cleanups.push(() => native.dispose());
  const runner = {
    command: vi.fn(
      (
        exe: string,
        args: string[],
        cwd: string,
        overrides?: NodeJS.ProcessEnv,
      ) => {
        if (exe !== "git" || !cwd.startsWith(root + "/"))
          throw Error("Only fixture Git validation is allowed");
        return native.command(exe, args, cwd, overrides);
      },
    ),
  };
  const project = { id: "p", name: "Fixture", path: repo };
  const manager = new CloneManager(home, runner);
  const owner = await manager.ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "feature-test",
    branch: "feature/test",
  });
  const ref = worktreeContextRef(owner);
  const registry = path.join(home, ".goga/desktop/clones/registry.json");
  const bytes = () => fs.readFile(registry, "utf8");
  const record = async () =>
    JSON.parse(await bytes()).records.find(
      (row: any) => row.contextId === owner.contextId,
    );
  const snapshot = async () =>
    Promise.all(
      [repo, owner.path].map(async (cwd) => ({
        head: await git(["rev-parse", "HEAD"], cwd),
        branch: await git(["branch", "--show-current"], cwd),
        index: (await fs.readFile(path.join(cwd, ".git/index"))).toString(
          "base64",
        ),
        status: await git(
          ["status", "--porcelain=v1", "--untracked-files=all"],
          cwd,
        ),
      })),
    );
  const fresh = () => {
    const live = new NodeRunner(10000, env);
    cleanups.push(() => live.dispose());
    return new CloneManager(home, live);
  };
  return {
    root,
    repo,
    home,
    env,
    git,
    native,
    runner,
    manager,
    owner,
    ref,
    bytes,
    record,
    snapshot,
    fresh,
  };
}
describe(
  "shutdown never fabricates persisted clone conflicts",
  { timeout: 30000 },
  () => {
    for (const operation of ["resolve", "reconcile"] as const)
      for (const phase of ["interrupted", "closing"] as const)
        it(`${operation} propagates ${phase} shutdown without changing registry bytes/revision or captured ref`, async () => {
          const f = await fixture();
          const before = await f.bytes(),
            files = await f.snapshot();
          const reached = deferred(),
            release = deferred();
          const original = f.runner.command.getMockImplementation()!;
          const start = vi.spyOn(f.native, "start");
          let armed = true;
          let heldChild: ReturnType<NodeRunner["start"]> | undefined;
          f.runner.command.mockImplementation(
            async (...args: Parameters<typeof original>) => {
              if (
                armed &&
                args[2] === f.owner.path &&
                args[1].includes("--absolute-git-dir")
              ) {
                armed = false;
                if (phase === "closing") {
                  reached.resolve();
                  await release.promise;
                  return original(...args);
                }
                const pending = f.native.command(
                  process.execPath,
                  [
                    "-e",
                    "process.stdout.write('holding validation');setInterval(()=>{},1000)",
                  ],
                  f.owner.path,
                );
                heldChild =
                  start.mock.results[start.mock.results.length - 1].value;
                heldChild!.stdout.once("data", reached.resolve);
                return pending;
              }
              return original(...args);
            },
          );
          const pending =
            operation === "resolve"
              ? f.manager.resolve(f.ref)
              : f.manager.reconcile("p");
          const outcome = pending.then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await reached.promise;
          await f.native.dispose();
          release.resolve();
          const result = await outcome;
          expect.soft(result).toMatchObject({
            error: {
              name: "RunnerShutdownError",
              code: "RUNNER_SHUTDOWN",
              phase,
            },
          });
          expect.soft(await f.bytes()).toBe(before);
          expect.soft((await f.record()).revision).toBe(f.ref.revision);
          expect.soft(await f.snapshot()).toEqual(files);
          const restarted = await f
            .fresh()
            .resolve(f.ref)
            .then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
          expect.soft(restarted).toMatchObject({
            value: {
              state: "ready",
              contextId: f.ref.contextId,
              revision: f.ref.revision,
            },
          });
          const heldPid = heldChild?.pid;
          if (heldPid) expect(() => process.kill(-heldPid, 0)).toThrow();
        });
    it.each(["branch", "remote", "missing"])(
      "keeps genuine %s changes fail-closed and persists their new physical state",
      async (kind) => {
        const f = await fixture();
        if (kind === "branch") {
          await f.git(["checkout", "-b", "other"], f.owner.path);
        }
        if (kind === "remote")
          await f.git(
            [
              "remote",
              "set-url",
              "desktop-source",
              path.join(f.root, "different-source"),
            ],
            f.owner.path,
          );
        if (kind === "missing")
          await fs.rename(f.owner.path, f.owner.path + ".saved");
        await expect(f.manager.resolve(f.ref)).rejects.toThrow();
        const row = await f.record();
        expect(row.revision).not.toBe(f.ref.revision);
        expect(row.state).toBe(kind === "missing" ? "missing" : "conflict");
        expect(row.reason).toBe(
          kind === "branch"
            ? "branch"
            : kind === "missing"
              ? "missing"
              : "repository",
        );
        await expect(f.fresh().resolve(f.ref)).rejects.toThrow(
          /ревизи|изменён/i,
        );
      },
    );
    it("does not ignore a genuine command failure observed before runner close", async () => {
      const f = await fixture();
      const original = f.runner.command.getMockImplementation()!;
      let armed = true;
      f.runner.command.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          if (
            armed &&
            args[2] === f.owner.path &&
            args[1].includes("--absolute-git-dir")
          ) {
            armed = false;
            try {
              await f.native.command(
                process.execPath,
                ["-e", "process.exit(7)"],
                f.owner.path,
              );
            } catch (error) {
              await f.native.dispose();
              throw error;
            }
          }
          return original(...args);
        },
      );
      const error = await f.manager.resolve(f.ref).catch((error) => error);
      expect(error.code).not.toBe("RUNNER_SHUTDOWN");
      const row = await f.record();
      expect(row.state).toBe("conflict");
      expect(row.reason).toBe("ownership");
      expect(row.revision).not.toBe(f.ref.revision);
    });
  },
);
it.each(["same-text", "same-code"])(
  "does not trust arbitrary %s lookalike errors as typed lifecycle cancellation",
  { timeout: 30000 },
  async (kind) => {
    const f = await fixture();
    const original = f.runner.command.getMockImplementation()!;
    let armed = true;
    f.runner.command.mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (
          armed &&
          args[2] === f.owner.path &&
          args[1].includes("--absolute-git-dir")
        ) {
          armed = false;
          const error = Error("Приложение завершает работу");
          if (kind === "same-code")
            Object.assign(error, {
              name: "RunnerShutdownError",
              code: "RUNNER_SHUTDOWN",
              phase: "closing",
            });
          throw error;
        }
        return original(...args);
      },
    );
    await expect(f.manager.resolve(f.ref)).rejects.toThrow();
    const row = await f.record();
    expect(row.state).toBe("conflict");
    expect(row.reason).toBe("ownership");
    expect(row.revision).not.toBe(f.ref.revision);
  },
);

async function approvedPolicyFixture() {
  const f = await fixture();
  const upstream = path.join(f.root, "upstream.git");
  await f.git(["init", "--bare", upstream]);
  await f.git(["remote", "add", "origin", upstream]);
  const exchange = new ContextExchangeManager(f.home, f.runner, {
    resolve: (ref) => f.manager.resolve(ref),
    isActive: () => false,
    nativeEnvironment: () => f.env,
  });
  await seedLegacyPublication(f.owner, async (args, cwd) =>
    (await f.git(args, cwd)).trim(),
  );
  // Fixture setup only: no publication execution or push is permitted.
  await exchange.preparePublication(f.ref, { action: "publish" });
  expect(await f.manager.resolve(f.ref)).toMatchObject({ state: "ready" });
  const physical = async () => ({
    files: await f.snapshot(),
    configs: await Promise.all(
      [f.repo, f.owner.path].map((cwd) =>
        fs.readFile(path.join(cwd, ".git/config"), "utf8"),
      ),
    ),
    owner: await fs.readFile(
      path.join(f.owner.gitCommonDir, "desktop-owner.json"),
      "utf8",
    ),
    policy: await fs.readFile(
      path.join(f.owner.gitCommonDir, "desktop-upstream-policy.json"),
      "utf8",
    ),
  });
  const noPush = () =>
    expect(
      f.runner.command.mock.calls.every(([, args]) => !args.includes("push")),
    ).toBe(true);
  return { ...f, physical, noPush };
}
function isSourceOriginConfig(args: string[], cwd: string, source: string) {
  return (
    cwd === source &&
    ["config", "--local", "--includes", "--null", "--list"].every((arg) =>
      args.includes(arg),
    )
  );
}
describe("approved origin physical policy shutdown propagation", () => {
  it.each(["closing", "interrupted"] as const)(
    "propagates real %s cancellation from source origin config without invalidating the exact owner",
    { timeout: 30000 },
    async (phase) => {
      const f = await approvedPolicyFixture();
      const before = await f.bytes(),
        physical = await f.physical();
      const reached = deferred(),
        release = deferred();
      const original = f.runner.command.getMockImplementation()!;
      const start = vi.spyOn(f.native, "start");
      let armed = true;
      let heldChild: ReturnType<NodeRunner["start"]> | undefined;
      f.runner.command.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          if (armed && isSourceOriginConfig(args[1], args[2], f.repo)) {
            armed = false;
            if (phase === "closing") {
              reached.resolve();
              await release.promise;
              return original(...args);
            }
            const pending = f.native.command(
              process.execPath,
              [
                "-e",
                "process.stdout.write('holding source origin config');setInterval(()=>{},1000)",
              ],
              f.repo,
            );
            heldChild = start.mock.results[start.mock.results.length - 1].value;
            heldChild!.stdout.once("data", reached.resolve);
            return pending;
          }
          return original(...args);
        },
      );
      const outcome = f.manager.resolve(f.ref).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await reached.promise;
      await f.native.dispose();
      release.resolve();
      const result = await outcome;
      expect.soft(result).toMatchObject({
        error: {
          name: "RunnerShutdownError",
          code: "RUNNER_SHUTDOWN",
          phase,
        },
      });
      expect
        .soft("error" in result && result.error)
        .toBeInstanceOf(RunnerShutdownError);
      expect.soft(armed).toBe(false);
      expect.soft(await f.bytes()).toBe(before);
      expect.soft((await f.record()).revision).toBe(f.ref.revision);
      expect.soft(await f.physical()).toEqual(physical);
      const restarted = await f
        .fresh()
        .resolve(f.ref)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      expect.soft(restarted).toMatchObject({
        value: {
          state: "ready",
          contextId: f.ref.contextId,
          revision: f.ref.revision,
        },
      });
      const heldPid = heldChild?.pid;
      if (heldPid) expect(() => process.kill(-heldPid, 0)).toThrow();
      f.noPush();
    },
  );
  it.each(["changed-policy", "same-text", "same-code"])(
    "keeps genuine policy failure or %s forgery fail-closed",
    { timeout: 30000 },
    async (kind) => {
      const f = await approvedPolicyFixture();
      if (kind === "changed-policy")
        await f.git([
          "remote",
          "set-url",
          "origin",
          path.join(f.root, "other.git"),
        ]);
      const physical = await f.physical();
      const original = f.runner.command.getMockImplementation()!;
      let armed = kind !== "changed-policy";
      f.runner.command.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          if (armed && isSourceOriginConfig(args[1], args[2], f.repo)) {
            armed = false;
            const error = Error(new RunnerShutdownError("closing").message);
            if (kind === "same-code")
              Object.assign(error, {
                name: "RunnerShutdownError",
                code: "RUNNER_SHUTDOWN",
                phase: "closing",
              });
            throw error;
          }
          return original(...args);
        },
      );
      const error = await f.manager.resolve(f.ref).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RunnerShutdownError);
      const row = await f.record();
      expect(row.state).toBe("conflict");
      expect(row.reason).toBe("ownership");
      expect(row.revision).not.toBe(f.ref.revision);
      expect(armed).toBe(false);
      expect(await f.physical()).toEqual(physical);
      await expect(f.fresh().resolve(f.ref)).rejects.toThrow(/ревизи|изменён/i);
      f.noPush();
    },
  );
});
