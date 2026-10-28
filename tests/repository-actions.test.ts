import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { CommandExitError, NodeRunner, type Runner } from "../src/host/process";
import { DesktopStateStore } from "../src/host/desktop-state";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import type { Run } from "../src/shared/types";

async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-repository-actions-");
  fixtureScope().cleanup(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    repo = path.join(root, "primary"),
    remote = path.join(root, "remote.git");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const node = fixtureScope.runner(new NodeRunner(10000, env));
  fixtureScope().cleanup(() => node.dispose());
  const git = async (args: string[], cwd = repo) =>
    (
      await node.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          ...args,
        ],
        cwd,
        env,
      )
    ).stdout.trim();
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "base"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["branch", "alpha"]);
  await git(["init", "--bare", remote]);
  await git(["remote", "add", "origin", remote]);
  await git(["push", "-u", "origin", "main"]);
  let config = "# topics\nbase_ref: main\nupdate:\n  strategy: merge\n";
  let before:
    ((exe: string, args: string[], cwd: string) => Promise<void>) | undefined;
  const calls: { exe: string; args: string[]; cwd: string }[] = [];
  const runner: Runner = {
    command: async (exe, args, cwd, overrides, stdin) => {
      if (!cwd.startsWith(root + path.sep)) throw Error("Outside fixture");
      calls.push({ exe, args: [...args], cwd });
      await before?.(exe, args, cwd);
      if (exe === "FAKE-GOGA") {
        if (args.join(" ") === "config topics")
          return { stdout: config, stderr: "" };
        if (
          args[0] === "topics" &&
          (args.includes("update") || args.includes("propagate"))
        )
          return { stdout: "updated", stderr: "" };
        throw Error("Unexpected mocked Goga command");
      }
      if (exe !== "git" || args.some((a) => /^(https?|ssh|git):\/\//.test(a)))
        throw Error("Network/native execution forbidden");
      return node.command(exe, args, cwd, { ...env, ...overrides }, stdin);
    },
    start: () => {
      throw Error("Real pipelines forbidden");
    },
    kill: () => {
      throw Error("No processes");
    },
    dispose: () => node.dispose(),
  };
  const service = fixtureScope().own(
    new HostService({
      home,
      dataDir: path.join(root, "data"),
      goga: "FAKE-GOGA",
      runner,
    }),
  );
  fixtureScope().cleanup(async () => {
    (service as unknown as { runList: Run[] }).runList = [];
    await service.dispose();
  });
  const project = await service.addProject(repo);
  const owner = await new CloneManager(home, runner).ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "alpha",
    branch: "alpha",
  });
  await fs.writeFile(path.join(owner.path, "topic"), "topic\n");
  await git(["add", "."], owner.path);
  await git(["commit", "-m", "topic"], owner.path);
  calls.length = 0;
  const ref = worktreeContextRef(owner);
  return {
    root,
    home,
    repo,
    remote,
    owner,
    ref,
    project,
    service,
    git,
    calls,
    config: (text: string) => {
      config = text;
    },
    intercept: (fn: typeof before) => {
      before = fn;
    },
    action: (
      action:
        "sync" | "publish" | "update-base" | "propagate" | "update-remote",
      topic = true,
    ) =>
      service.runRepositoryAction({
        projectId: project.id,
        ...(topic ? { context: ref } : {}),
        action,
      }),
  };
}
describe("header repository actions", () => {
  it(
    "syncs dirty topic during a running pipeline by ordinary local push",
    fixtureScope.run(async () => {
      const f = await fixture();
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty\n");
      const result = await f.action("sync");
      expect(result).toMatchObject({
        status: "success",
        projectId: f.project.id,
        contextId: f.ref.contextId,
        action: "sync",
      });
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(await fs.readFile(path.join(f.owner.path, "topic"), "utf8")).toBe(
        "dirty\n",
      );
      expect(
        f.calls.some(
          (c) => c.args.includes("checkout") || c.args.includes("--force"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "publishes same branch from original after clone sync, not clone to server",
    fixtureScope.run(async () => {
      const f = await fixture();
      const result = await f.action("publish");
      expect(result.status).toBe("success");
      const pushes = f.calls.filter((c) => c.args.includes("push"));
      expect(pushes.map((c) => c.cwd)).toEqual([f.owner.path, f.repo]);
      expect(
        pushes.every((c) => c.args.at(-1)?.endsWith(":refs/heads/alpha")),
      ).toBe(true);
      expect(await f.git(["rev-parse", "refs/heads/alpha"], f.remote)).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "retains successful local sync when original origin is absent",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["remote", "remove", "origin"]);
      const result = await f.action("publish");
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/origin/i);
      expect(result.log).toMatch(/синхронизация.*завершена/i);
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "base publish sends dirty current branch without checkout or upstream fallback",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo, "base"), "dirty\n");
      expect((await f.action("publish", false)).status).toBe("success");
      const push = f.calls.find((c) => c.args.includes("push"))!;
      expect(push.cwd).toBe(f.repo);
      expect(push.args.at(-1)).toMatch(/:refs\/heads\/main$/);
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "dirty\n",
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "update-base reads effective config in clone, refreshes original and fetches before native clone update",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "new\n");
      await f.git(["commit", "-am", "advance"]);
      await f.git(["push", "origin", "main"]);
      const next = await f.git(["rev-parse", "HEAD"]);
      await f.git(["reset", "--hard", old]); // Disposable fixture setup only.
      const result = await f.action("update-base");
      expect(result.status).toBe("success");
      expect(await f.git(["rev-parse", "main"])).toBe(next);
      const config = f.calls.findIndex(
        (c) => c.exe === "FAKE-GOGA" && c.args[0] === "config",
      );
      const fetch = f.calls.findIndex(
        (c) => c.cwd === f.repo && c.args.includes("fetch"),
      );
      const cloneFetch = f.calls.findIndex(
        (c) => c.cwd === f.owner.path && c.args.includes("fetch"),
      );
      const update = f.calls.findIndex(
        (c) => c.exe === "FAKE-GOGA" && c.args[0] === "topics",
      );
      expect(config).toBeLessThan(fetch);
      expect(fetch).toBeLessThan(cloneFetch);
      expect(cloneFetch).toBeLessThan(update);
      expect(f.calls[config]).toMatchObject({
        cwd: f.owner.path,
        args: ["config", "topics"],
      });
      expect(f.calls[update].cwd).toBe(f.owner.path);
      expect(f.calls[update].args).not.toContain("--publish");
      expect(f.calls[update].args).toContain("--base-ref");
      expect(f.calls[update].args).not.toContain("--strategy");
      expect(f.calls[update].args.slice(0, 5)).toEqual([
        "topics",
        "--year",
        "2026",
        "update",
        "alpha",
      ]);
      expect(
        await f.git(["rev-parse", "refs/remotes/origin/main"], f.owner.path),
      ).toBe(next);
    }),
    gitIntegrationBudget(15000),
  );
  it.each([
    "base_ref: null",
    "base_ref: ''",
    "base_ref: 42",
    "base_ref: [main]",
    "base_ref: main\nupdate: {strategy: []}",
    "[broken",
  ])(
    "fails closed on invalid effective topics config: %s",
    fixtureScope.run(async (config) => {
      const f = await fixture();
      f.config(config);
      expect((await f.action("update-base")).status).toBe("error");
      expect(
        f.calls.some(
          (c) =>
            c.args.includes("fetch") ||
            c.args.includes("push") ||
            c.args[0] === "topics",
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "missing upstream fails before native update",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "--unset-upstream", "main"]);
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/upstream/i);
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "stale owner rejects without Git mutations",
    fixtureScope.run(async () => {
      const f = await fixture();
      const result = await f.service.runRepositoryAction({
        projectId: f.project.id,
        context: { ...f.ref, revision: "00000000-0000-4000-8000-000000000001" },
        action: "publish",
      });
      expect(result.status).toBe("error");
      expect(
        f.calls.some(
          (c) => c.args.includes("push") || c.args.includes("fetch"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "base sync fast-forwards current branch during active base run",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      const next = await f.git(["rev-parse", "HEAD"]);
      await f.git(["reset", "--hard", old]);
      (f.service as unknown as { runList: Run[] }).runList = [
        { id: "active", projectId: f.project.id, status: "running" } as Run,
      ];
      expect((await f.action("sync", false)).status).toBe("success");
      expect(await f.git(["rev-parse", "HEAD"])).toBe(next);
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "upstream\n",
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "updates non-current base by CAS without touching current original files",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "main"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      const next = await f.git(["rev-parse", "HEAD"]);
      await f.git(["checkout", "-b", "unrelated", old]);
      await f.git(["update-ref", "refs/heads/main", old, next]);
      await fs.writeFile(path.join(f.repo, "base"), "dirty unrelated\n");
      expect((await f.action("update-base")).status).toBe("success");
      expect(await f.git(["rev-parse", "main"])).toBe(next);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
        "unrelated",
      );
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "dirty unrelated\n",
      );
      expect(
        f.calls.some(
          (c) =>
            c.cwd === f.repo &&
            c.args.includes("update-ref") &&
            c.args.includes(old),
        ),
      ).toBe(true);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "non-fast-forward base refuses without native update or destructive rollback",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      await f.git(["reset", "--hard", old]);
      await fs.writeFile(path.join(f.repo, "local-only"), "local\n");
      await f.git(["add", "."]);
      await f.git(["commit", "-m", "divergent"]);
      const head = await f.git(["rev-parse", "HEAD"]);
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/расхожд|разошл/i);
      expect(result.error).toMatch(/вручную/i);
      expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
      expect(
        f.calls.some(
          (c) =>
            c.args[0] === "topics" ||
            c.args.includes("reset") ||
            c.args.includes("--force"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["main^", "refs/tags/v1", "missing"])(
    "rejects unresolved or non-branch base %s without fetch",
    fixtureScope.run(async (base) => {
      const f = await fixture();
      f.config(`base_ref: ${base}`);
      expect((await f.action("update-base")).status).toBe("error");
      expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "rejects tag ambiguity and symbolic base",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["tag", "main"]);
      expect((await f.action("update-base")).status).toBe("error");
      await f.git(["tag", "-d", "main"]);
      await f.git(["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
      f.config("base_ref: alias");
      expect((await f.action("update-base")).status).toBe("error");
      expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["config", "original-fetch", "clone-fetch", "update"])(
    "stops at failing %s phase and preserves partial log",
    fixtureScope.run(async (phase) => {
      const f = await fixture();
      f.intercept(async (exe, args, cwd) => {
        if (
          (phase === "config" && exe === "FAKE-GOGA" && args[0] === "config") ||
          (phase === "original-fetch" &&
            cwd === f.repo &&
            args.includes("fetch")) ||
          (phase === "clone-fetch" &&
            cwd === f.owner.path &&
            args.includes("fetch")) ||
          (phase === "update" && exe === "FAKE-GOGA" && args[0] === "topics")
        )
          throw Error("Synthetic phase failure");
      });
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(result.log).toContain("Synthetic phase failure");
      if (phase !== "update")
        expect(
          f.calls.some((c) => c.exe === "FAKE-GOGA" && c.args[0] === "topics"),
        ).toBe(false);
      if (["clone-fetch", "update"].includes(phase))
        expect(result.log).toMatch(/Базовая ветка main обновлена/);
      if (phase === "config")
        expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "refuses moved endpoint between checks without publishing",
    fixtureScope.run(async () => {
      const f = await fixture();
      let checks = 0;
      f.intercept(async (_exe, args, cwd) => {
        if (
          cwd === f.repo &&
          args.includes("get-url") &&
          args.includes("--push") &&
          ++checks === 1
        )
          await f.git([
            "remote",
            "set-url",
            "origin",
            path.join(f.root, "other.git"),
          ]);
      });
      expect((await f.action("publish", false)).status).toBe("error");
      expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "returns sanitized native failure and output with environment secrets",
    fixtureScope.run(async () => {
      const f = await fixture();
      const settings = await f.service.readProjectSettings(f.project.id);
      await f.service.saveProjectSettings(
        f.project.id,
        {
          ...settings.value,
          env: [
            {
              key: "SYNTHETIC_SECRET",
              value: "fixture-secret-value",
              secret: true,
              runtime: true,
            },
          ],
        },
        settings.version,
      );
      f.intercept(async (exe, args) => {
        if (exe === "FAKE-GOGA" && args[0] === "topics")
          throw Error(
            "failed fixture-secret-value https://u:credential@example.invalid/x?token=tokenvalue",
          );
      });
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toMatch(
        /fixture-secret-value|credential|tokenvalue/,
      );
      expect(result.log).toContain("[скрыто]");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "queued action after shutdown returns error without Git mutation",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.service.dispose();
      f.calls.length = 0;
      expect((await f.action("publish")).status).toBe("error");
      expect(f.calls).toHaveLength(0);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "accepts a quoted literal null branch instead of confusing it with missing config",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "null", "main"]);
      await f.git(["branch", "--set-upstream-to=origin/main", "null"]);
      f.config('base_ref: "null"\nupdate: {strategy: custom-native-strategy}');
      expect((await f.action("update-base")).status).toBe("success");
      expect(
        f.calls.find((c) => c.exe === "FAKE-GOGA" && c.args[0] === "topics")
          ?.args,
      ).not.toContain("--strategy");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "ordinary manual sync remains available during an active topic run",
    fixtureScope.run(async () => {
      const f = await fixture();
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      expect((await f.service.syncTopicContext(f.ref)).status).toBe("synced");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "a failed first push prevents publication entirely",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw Error("fixture local push failure");
      });
      const result = await f.action("publish");
      expect(result.status).toBe("error");
      expect(
        f.calls.filter((c) => c.args.includes("push")).map((c) => c.cwd),
      ).toEqual([f.owner.path]);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "failed publication retains completed local sync",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.repo && args.includes("push"))
          throw Error("fixture server failure");
      });
      const result = await f.action("publish");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/Синхронизация топика завершена/);
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "refresh dirty conflict preserves original changes and does not update topic",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      await f.git(["reset", "--hard", old]);
      await fs.writeFile(path.join(f.repo, "base"), "dirty\n");
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/overwritten by merge|local changes/i);
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "dirty\n",
      );
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "CAS refuses a concurrent non-current base change without overwriting it",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["checkout", "-b", "unrelated"]);
      const concurrent = await f.git(["rev-parse", "HEAD"], f.owner.path);
      await f.git(["fetch", f.owner.path, "alpha"]);
      f.intercept(async (_exe, args, cwd) => {
        if (
          cwd === f.repo &&
          args.includes("update-ref") &&
          args.includes("refs/heads/main")
        )
          await f.git(["update-ref", "refs/heads/main", concurrent]);
      });
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(await f.git(["rev-parse", "main"])).toBe(concurrent);
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "actual Git mutation lock prevents refresh despite active-runs allowance",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo, ".git/index.lock"), "fixture lock");
      expect((await f.action("update-base")).status).toBe("error");
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
      expect(
        await fs.readFile(path.join(f.repo, ".git/index.lock"), "utf8"),
      ).toBe("fixture lock");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "serializes header operations and stops remaining steps after shutdown",
    fixtureScope.run(async () => {
      const f = await fixture();
      let entered!: () => void, release!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.intercept(async (exe, args) => {
        if (exe === "FAKE-GOGA" && args[0] === "config") {
          entered();
          await barrier;
        }
      });
      const first = f.action("update-base");
      await pending;
      const second = f.action("publish");
      await f.service.dispose();
      release();
      expect((await first).status).toBe("error");
      expect((await second).status).toBe("error");
      expect(
        f.calls.some(
          (c) =>
            c.args.includes("push") ||
            c.args.includes("fetch") ||
            c.args[0] === "topics",
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "base sync preserves local commits ahead of upstream as already up-to-date",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo, "base"), "local ahead\n");
      await f.git(["commit", "-am", "ahead"]);
      const head = await f.git(["rev-parse", "HEAD"]);
      expect((await f.action("sync", false)).status).toBe("success");
      expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "manual retry remains available during active run",
    fixtureScope.run(async () => {
      const f = await fixture();
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw Error("temporary");
      });
      expect((await f.service.syncTopicContext(f.ref)).status).toBe("error");
      f.intercept(undefined);
      expect((await f.service.retryContextSync(f.ref)).status).toBe("synced");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "missing clone origin is an error, not an implicit remote configuration write",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["remote", "remove", "origin"], f.owner.path);
      expect((await f.action("publish")).status).toBe("error");
      expect(
        f.calls.some(
          (c) =>
            c.args.includes("push") ||
            (c.args.includes("add") && c.args.includes("origin")),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "quick sync preserves actual cannot-lock-ref diagnostics",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(
        path.join(f.repo, ".git/refs/heads/alpha.lock"),
        "fixture lock",
      );
      const result = await f.action("sync");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(
        /cannot lock ref|unable to create.*alpha.lock/is,
      );
      expect(
        await fs.readFile(
          path.join(f.repo, ".git/refs/heads/alpha.lock"),
          "utf8",
        ),
      ).toBe("fixture lock");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "quick sync diagnostics redact secrets without storing raw output in sync state or journal",
    fixtureScope.run(async () => {
      const f = await fixture();
      const settings = await f.service.readProjectSettings(f.project.id);
      await f.service.saveProjectSettings(
        f.project.id,
        {
          ...settings.value,
          env: [
            {
              key: "SYNTHETIC_SECRET",
              value: "sync-fixture-secret",
              secret: true,
              runtime: true,
            },
          ],
        },
        settings.version,
      );
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw new CommandExitError(
            "generic failed command",
            1,
            "stdout sync-fixture-secret",
            "permission denied sync-fixture-secret https://user:credential@example.invalid/repo?token=tokenvalue",
          );
      });
      const result = await f.action("sync");
      expect(result.status).toBe("error");
      expect(result.log).toContain("permission denied");
      expect(result.log).toContain("stdout [скрыто]");
      expect(JSON.stringify(result)).not.toMatch(
        /sync-fixture-secret|credential|tokenvalue/,
      );
      const state = await f.service.topicSyncStatus(f.ref);
      expect(JSON.stringify(state)).not.toMatch(
        /permission denied|stdout|sync-fixture-secret|credential|tokenvalue/,
      );
      const files = await fs.readdir(path.join(f.home, ".goga/desktop/sync"), {
        recursive: true,
      });
      for (const name of files) {
        const file = path.join(f.home, ".goga/desktop/sync", name);
        if ((await fs.stat(file)).isFile())
          expect(await fs.readFile(file, "utf8")).not.toMatch(
            /permission denied|stdout|sync-fixture-secret|credential|tokenvalue/,
          );
      }
    }),
    gitIntegrationBudget(15000),
  );
});

describe("native topic propagation", () => {
  it(
    "syncs first then invokes exact native propagate in original, allowing dirty files and active runs",
    fixtureScope.run(async () => {
      const f = await fixture();
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty clone\n");
      await fs.writeFile(path.join(f.repo, "base"), "dirty original\n");
      const topicOid = await f.git(["rev-parse", "HEAD"], f.owner.path);
      f.intercept(async (exe, args, cwd) => {
        if (exe === "FAKE-GOGA") {
          expect(cwd).toBe(f.repo);
          expect(await f.git(["rev-parse", "refs/heads/alpha"])).toBe(topicOid);
        }
      });
      const result = await f.action("propagate");
      expect(result).toMatchObject({
        status: "success",
        action: "propagate",
        contextId: f.ref.contextId,
      });
      const native = f.calls.filter((c) => c.exe === "FAKE-GOGA");
      expect(native).toEqual([
        {
          exe: "FAKE-GOGA",
          cwd: f.repo,
          args: ["topics", "--year", "2026", "propagate", "alpha", "-y"],
        },
      ]);
      const pushes = f.calls.filter((c) => c.args.includes("push"));
      expect(pushes.map((c) => c.cwd)).toEqual([f.owner.path]);
      expect(f.calls.indexOf(pushes[0])).toBeLessThan(
        f.calls.indexOf(native[0]),
      );
      expect(
        f.calls.some((c) =>
          c.args.some((arg) =>
            [
              "fetch",
              "merge",
              "checkout",
              "reset",
              "--force",
              "--publish",
            ].includes(arg),
          ),
        ),
      ).toBe(false);
      expect(await fs.readFile(path.join(f.owner.path, "topic"), "utf8")).toBe(
        "dirty clone\n",
      );
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "dirty original\n",
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "rejects primary-only propagation without any command",
    fixtureScope.run(async () => {
      const f = await fixture();
      await expect(f.action("propagate", false)).rejects.toThrow(
        /топик|контекст/i,
      );
      expect(f.calls).toHaveLength(0);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "stops after failed local sync, preserving diagnostics without invoking Goga",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw new CommandExitError(
            "local sync failed",
            1,
            "local output",
            "local diagnostic",
          );
      });
      const result = await f.action("propagate");
      expect(result.status).toBe("error");
      expect(result.log).toContain("local diagnostic");
      expect(f.calls.some((c) => c.exe === "FAKE-GOGA")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "retains synced branch and bounded sanitized partial log on native failure, without fallback",
    fixtureScope.run(async () => {
      const f = await fixture();
      const settings = await f.service.readProjectSettings(f.project.id);
      await f.service.saveProjectSettings(
        f.project.id,
        {
          ...settings.value,
          env: [
            {
              key: "SYNTHETIC_SECRET",
              value: "propagate-fixture-secret",
              secret: true,
              runtime: true,
            },
          ],
        },
        settings.version,
      );
      f.intercept(async (exe) => {
        if (exe === "FAKE-GOGA")
          throw new CommandExitError(
            "native failed propagate-fixture-secret",
            1,
            "native partial output",
            "https://user:credential@example.invalid/path?token=tokenvalue",
          );
      });
      const result = await f.action("propagate");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/Синхронизация топика завершена/);
      expect(result.log).toContain("native partial output");
      expect(result.log.length).toBeLessThanOrEqual(65536);
      expect(JSON.stringify(result)).not.toMatch(
        /propagate-fixture-secret|credential|tokenvalue/,
      );
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
      expect(
        f.calls.filter((c) => c.args.includes("push")).map((c) => c.cwd),
      ).toEqual([f.owner.path]);
      expect(
        f.calls.some(
          (c) => c.args.includes("merge") || c.args.includes("checkout"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "rejects stale captured owner before any mutation or native invocation",
    fixtureScope.run(async () => {
      const f = await fixture();
      const result = await f.service.runRepositoryAction({
        projectId: f.project.id,
        context: { ...f.ref, revision: "00000000-0000-4000-8000-000000000001" },
        action: "propagate",
      });
      expect(result.status).toBe("error");
      expect(
        f.calls.some((c) => c.exe === "FAKE-GOGA" || c.args.includes("push")),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["branch", "settings", "owner"])(
    "rejects changed %s after sync before native invocation",
    fixtureScope.run(async (change) => {
      const f = await fixture();
      let changed = false;
      f.intercept(async (_exe, args, cwd) => {
        if (
          !changed &&
          cwd === f.repo &&
          args.includes("for-each-ref") &&
          args.includes("--format=%(refname)%00%(objectname)%00%(symref)") &&
          args.includes("refs/heads/alpha")
        ) {
          changed = true;
          if (change === "branch")
            await f.git([
              "update-ref",
              "refs/heads/alpha",
              await f.git(["rev-parse", "main"]),
            ]);
          if (change === "settings") {
            const state = new DesktopStateStore(
              f.home,
              path.join(f.root, "data"),
            );
            const settings = await state.read(f.project.id);
            await state.save(
              f.project.id,
              { ...settings.value, executable: "CHANGED-GOGA" },
              settings.version,
            );
          }
          if (change === "owner")
            await f.git(["checkout", "main"], f.owner.path);
        }
      });
      const result = await f.action("propagate");
      expect(changed).toBe(true);
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/Синхронизация топика завершена/);
      expect(f.calls.some((c) => c.exe === "FAKE-GOGA")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
});

it.each([false, true])(
  "updates exact remote topic through original then clone (current original: %s)",
  fixtureScope.run(async (current) => {
    const f = await fixture();
    await f.git(["push", f.repo, "alpha:alpha"], f.owner.path);
    await f.git(["push", "origin", "alpha"]);
    if (current) await f.git(["checkout", "alpha"]);
    (f.service as unknown as { runList: Run[] }).runList = [
      {
        id: "active",
        projectId: f.project.id,
        context: f.ref,
        status: "running",
      } as Run,
    ];
    await fs.writeFile(path.join(f.owner.path, "remote-change"), "new");
    await f.git(["add", "."], f.owner.path);
    await f.git(["commit", "-m", "remote change"], f.owner.path);
    const next = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    await f.git(["reset", "--hard", "HEAD~1"], f.owner.path);
    await fs.writeFile(path.join(f.owner.path, "unrelated-dirty"), "keep");
    f.calls.length = 0;
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe("success");
    expect(await f.git(["rev-parse", "alpha"])).toBe(next);
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(next);
    expect(
      await fs.readFile(path.join(f.owner.path, "unrelated-dirty"), "utf8"),
    ).toBe("keep");
    const fetches = f.calls.filter((c) => c.args.includes("fetch"));
    expect(fetches.map((c) => c.cwd)).toEqual([f.repo, f.owner.path]);
    expect(
      fetches.every(
        (c) =>
          c.args.includes("origin") &&
          c.args.some((a) => a.startsWith("refs/heads/alpha:refs/desktop/")),
      ),
    ).toBe(true);
    expect(
      f.calls.some(
        (c) =>
          c.exe === "FAKE-GOGA" ||
          c.args.includes("push") ||
          c.args.includes("reset"),
      ),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it.each([
  "original-diverged",
  "clone-diverged",
  "overlap",
  "missing-branch",
  "wrong-head",
  "bad-origin",
  "ahead",
])(
  "remote refresh safely handles %s",
  fixtureScope.run(async (mode) => {
    const f = await fixture();
    await f.git(["push", f.repo, "alpha:alpha"], f.owner.path);
    await f.git(["push", "origin", "alpha"]);
    const initial = await f.git(["rev-parse", "alpha"]);
    if (mode === "ahead") {
      await f.git(
        [
          "update-ref",
          "refs/heads/alpha",
          await f.git(["rev-parse", "alpha^"]),
        ],
        f.remote,
      );
      f.calls.length = 0;
      const result = await f.action("update-remote");
      expect(result.status, result.log).toBe("success");
      expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(initial);
      return;
    }
    await fs.writeFile(path.join(f.owner.path, "topic"), "remote update\n");
    await f.git(["add", "."], f.owner.path);
    await f.git(["commit", "-m", "remote"], f.owner.path);
    const remoteOid = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    await f.git(["reset", "--hard", initial], f.owner.path);
    if (mode === "original-diverged" || mode === "clone-diverged") {
      const cwd = mode === "original-diverged" ? f.repo : f.owner.path;
      if (cwd === f.repo) await f.git(["checkout", "alpha"]);
      await fs.writeFile(path.join(cwd, "local"), "local");
      await f.git(["add", "."], cwd);
      await f.git(["commit", "-m", "diverged"], cwd);
    }
    if (mode === "overlap")
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty\n");
    if (mode === "missing-branch") await f.git(["push", f.remote, ":alpha"]);
    if (mode === "wrong-head")
      await f.git(["checkout", "-b", "wrong"], f.owner.path);
    if (mode === "bad-origin")
      await f.git(["remote", "set-url", "origin", f.remote], f.owner.path);
    const before = await f.git(["rev-parse", "HEAD"], f.owner.path);
    f.calls.length = 0;
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe("error");
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(before);
    expect(
      f.calls.some(
        (c) =>
          c.exe === "FAKE-GOGA" ||
          c.args.includes("push") ||
          c.args.includes("reset"),
      ),
    ).toBe(false);
    if (
      [
        "original-diverged",
        "missing-branch",
        "wrong-head",
        "bad-origin",
      ].includes(mode)
    )
      expect(
        f.calls.filter(
          (c) => c.cwd === f.owner.path && c.args.includes("fetch"),
        ),
      ).toHaveLength(0);
    else expect(await f.git(["rev-parse", "alpha"])).toBe(remoteOid);
  }),
  gitIntegrationBudget(15000),
);

it(
  "rejects checkout after captured HEAD before noncurrent CAS",
  fixtureScope.run(async () => {
    const f = await fixture();
    const old = await f.git(["rev-parse", "alpha"]);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    let armed = false,
      switched = false;
    f.intercept(async (_exe, args, cwd) => {
      if (armed && !switched) {
        switched = true;
        await f.git(["checkout", "alpha"]);
      }
      if (cwd === f.repo && args.includes("--symbolic-full-name")) armed = true;
    });
    const result = await f.action("update-remote");
    expect(switched).toBe(true);
    expect(result.status, result.log).toBe("error");
    expect(await f.git(["rev-parse", "alpha"])).toBe(old);
    expect(await f.git(["status", "--porcelain"])).toBe("");
    expect(
      f.calls.some(
        (c) =>
          c.args.includes("update-ref") && c.args.includes("refs/heads/alpha"),
      ),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it.each([false, true])(
  "protects dirty checked-out original during remote refresh (overlap: %s)",
  fixtureScope.run(async (overlap) => {
    const f = await fixture();
    await f.git(["push", f.repo, "alpha:alpha"], f.owner.path);
    await f.git(["checkout", "alpha"]);
    const old = await f.git(["rev-parse", "alpha"]);
    await fs.writeFile(path.join(f.owner.path, "topic"), "remote\n");
    await f.git(["commit", "-am", "remote"], f.owner.path);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    const next = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["reset", "--hard", old], f.owner.path);
    const dirtyFile = overlap ? "topic" : "base";
    await fs.writeFile(path.join(f.repo, dirtyFile), "dirty\n");
    f.calls.length = 0;
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe(overlap ? "error" : "success");
    expect(await f.git(["rev-parse", "alpha"])).toBe(overlap ? old : next);
    expect(await fs.readFile(path.join(f.repo, dirtyFile), "utf8")).toBe(
      "dirty\n",
    );
    if (overlap)
      expect(
        f.calls.some((c) => c.cwd === f.owner.path && c.args.includes("fetch")),
      ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it(
  "keeps clone commits ahead of the updated original without rollback",
  fixtureScope.run(async () => {
    const f = await fixture();
    const original = await f.git(["rev-parse", "alpha"]);
    await f.git(["push", "origin", "alpha"]);
    const clone = await f.git(["rev-parse", "HEAD"], f.owner.path);
    expect(clone).not.toBe(original);
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe("success");
    expect(await f.git(["rev-parse", "alpha"])).toBe(original);
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(clone);
  }),
  gitIntegrationBudget(15000),
);

describe("explicit card propagation", () => {
  const request = (
    f: Awaited<ReturnType<typeof fixture>>,
    context = true,
    branch = "alpha",
    baseRef = "main",
  ) => ({
    projectId: f.project.id,
    action: "propagate" as const,
    ...(context ? { context: f.ref } : {}),
    propagation: {
      year: "2026",
      topic: branch
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
      branch,
      baseRef,
    },
  });
  const mutations = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.calls.filter(
      (c) =>
        c.exe === "FAKE-GOGA" ||
        c.args.includes("push") ||
        c.args.includes("checkout"),
    );
  it(
    "syncs captured clone then invokes exact selected base in original, preserving dirty files and config",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "release"]);
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty\n");
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      const config = await fs.readFile(
        path.join(f.repo, ".git/config"),
        "utf8",
      );
      const result = await f.service.runRepositoryAction(
        request(f, true, "alpha", "release"),
      );
      expect(result.status, result.log).toBe("success");
      expect(
        mutations(f).map((c) => ({
          cwd: c.cwd,
          command: c.exe === "FAKE-GOGA" ? c.args : "push",
        })),
      ).toEqual([
        { cwd: f.owner.path, command: "push" },
        {
          cwd: f.repo,
          command: [
            "topics",
            "--year",
            "2026",
            "propagate",
            "alpha",
            "--base-ref",
            "release",
            "-y",
          ],
        },
      ]);
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(await fs.readFile(path.join(f.repo, ".git/config"), "utf8")).toBe(
        config,
      );
      expect(await fs.readFile(path.join(f.owner.path, "topic"), "utf8")).toBe(
        "dirty\n",
      );
      expect(
        f.calls.some(
          (c) => c.args.includes("--force") || c.args.includes("clone"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "uses an exact normalized own local branch with no clone directly, without creating or switching",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "feature/Beta"]);
      const before = await f.service.listTopicContexts(f.project.id);
      f.calls.length = 0;
      const result = await f.service.runRepositoryAction(
        request(f, false, "feature/Beta"),
      );
      expect(result.status, result.log).toBe("success");
      expect(mutations(f)).toEqual([
        {
          exe: "FAKE-GOGA",
          cwd: f.repo,
          args: [
            "topics",
            "--year",
            "2026",
            "propagate",
            "feature/Beta",
            "--base-ref",
            "main",
            "-y",
          ],
        },
      ]);
      expect(await f.service.listTopicContexts(f.project.id)).toEqual(before);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["year", "topic", "branch"])(
    "rejects a mismatching context %s",
    fixtureScope.run(async (key) => {
      const f = await fixture();
      const value = request(f);
      Object.assign(value.propagation, {
        [key]: key === "year" ? "2025" : "other",
      });
      await expect(f.service.runRepositoryAction(value)).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["ready", "missing", "ambiguous"])(
    "never falls back to primary for a registered %s owner",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      if (mode === "missing")
        await fs.rename(f.owner.path, `${f.owner.path}-removed`);
      if (mode === "ambiguous") {
        const file = path.join(f.home, ".goga/desktop/clones/registry.json");
        const registry = JSON.parse(await fs.readFile(file, "utf8"));
        registry.records.push({
          ...registry.records[0],
          contextId: `ctx-${"b".repeat(64)}`,
          path: `${f.owner.path}-other`,
        });
        await fs.writeFile(file, JSON.stringify(registry));
      }
      const result = await f.service.runRepositoryAction(request(f, false));
      expect(result.status, result.log).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each([
    "alpha",
    "missing",
    "main^",
    "--help",
    "/tmp/main",
    "refs/tags/main",
    "origin/main",
  ])(
    "rejects invalid selected destination %s",
    fixtureScope.run(async (base) => {
      const f = await fixture();
      const parsed = await f.service
        .runRepositoryAction(request(f, true, "alpha", base))
        .catch(() => ({ status: "error" }));
      expect(parsed.status).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each([
    "missing-origin",
    "tag-base",
    "symbolic-base",
    "wrong-topic",
    "missing-source",
  ])(
    "rejects invalid explicit identity or Git inputs: %s",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      await f.git(["branch", "beta"]);
      const value = request(f, false, "beta");
      if (mode === "missing-origin")
        await f.git(["remote", "remove", "origin"]);
      if (mode === "tag-base") await f.git(["tag", "main"]);
      if (mode === "symbolic-base") {
        await f.git(["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
        value.propagation.baseRef = "alias";
      }
      if (mode === "wrong-topic") value.propagation.topic = "wrong";
      if (mode === "missing-source") await f.git(["branch", "-D", "beta"]);
      const result = await f.service.runRepositoryAction(value);
      expect(result.status, result.log).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["source", "base", "owner"])(
    "rechecks %s after validation before no-clone command",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      await f.git(["branch", "beta"]);
      let checks = 0;
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.repo && args.includes("get-url") && ++checks === 1) {
          if (mode === "source" || mode === "base")
            await f
              .git([
                "update-ref",
                `refs/heads/${mode === "source" ? "beta" : "main"}`,
                await f.git(["rev-parse", "HEAD"], f.owner.path),
              ])
              .catch(async () => {
                await f.git(["fetch", f.owner.path, "alpha"]);
                await f.git([
                  "update-ref",
                  `refs/heads/${mode === "source" ? "beta" : "main"}`,
                  await f.git(["rev-parse", "HEAD"], f.owner.path),
                ]);
              });
          else {
            const file = path.join(
              f.home,
              ".goga/desktop/clones/registry.json",
            );
            const registry = JSON.parse(await fs.readFile(file, "utf8"));
            registry.records.push({
              ...registry.records[0],
              contextId: `ctx-${"c".repeat(64)}`,
              topic: "beta",
              branch: "beta",
              path: `${f.owner.path}-beta`,
            });
            await fs.writeFile(file, JSON.stringify(registry));
          }
        }
      });
      const result = await f.service.runRepositoryAction(
        request(f, false, "beta"),
      );
      expect(checks).toBeGreaterThan(0);
      expect(result.status, result.log).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["source", "base", "owner", "origin"])(
    "stops after clone sync if %s changes before native publication",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      let synced = false,
        changed = false;
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push")) synced = true;
        else if (
          synced &&
          !changed &&
          cwd === f.repo &&
          args.includes("for-each-ref") &&
          args.includes("refs/heads/main")
        ) {
          changed = true;
          if (mode === "source")
            await f.git([
              "update-ref",
              "refs/heads/alpha",
              await f.git(["rev-parse", "main"]),
            ]);
          if (mode === "base")
            await f.git([
              "update-ref",
              "refs/heads/main",
              await f.git(["rev-parse", "alpha"]),
            ]);
          if (mode === "owner") await f.git(["checkout", "main"], f.owner.path);
          if (mode === "origin") await f.git(["remote", "remove", "origin"]);
        }
      });
      const result = await f.service.runRepositoryAction(request(f));
      expect(changed).toBe(true);
      expect(result.status, result.log).toBe("error");
      expect(result.log).toContain("Синхронизация топика завершена");
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toEqual([]);
      expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["sync", "native"])(
    "stops on %s failure with sanitized diagnostics and no fallback",
    fixtureScope.run(async (phase) => {
      const f = await fixture();
      f.intercept(async (exe, args) => {
        if (
          (phase === "sync" && args.includes("push")) ||
          (phase === "native" && exe === "FAKE-GOGA")
        )
          throw new CommandExitError(
            "fixture failure",
            1,
            "partial",
            "https://user:credential@example.invalid/?token=secret",
          );
      });
      const result = await f.service.runRepositoryAction(request(f));
      expect(result.status).toBe("error");
      expect(result.log).toContain("partial");
      expect(result.log).not.toMatch(/credential|token=secret/);
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(
        phase === "sync" ? 0 : 1,
      );
      expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
});
