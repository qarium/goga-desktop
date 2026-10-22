import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { CommandExitError, NodeRunner, type Runner } from "../src/host/process";
import { DesktopStateStore } from "../src/host/desktop-state";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import type { Run } from "../src/shared/types";

vi.setConfig({ testTimeout: 15000 });
const services: HostService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    (service as unknown as { runList: Run[] }).runList = [];
    await service.dispose();
  }
});
async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-repository-actions-");
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
  const node = new NodeRunner(10000, env);
  const git = async (args: string[], cwd = repo) =>
    (
      await node.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
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
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    goga: "FAKE-GOGA",
    runner,
  });
  services.push(service);
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
      action: "sync" | "publish" | "update-base" | "propagate",
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
  it("syncs dirty topic during a running pipeline by ordinary local push", async () => {
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
  });
  it("publishes same branch from original after clone sync, not clone to server", async () => {
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
  });
  it("retains successful local sync when original origin is absent", async () => {
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
  });
  it("base publish sends dirty current branch without checkout or upstream fallback", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "base"), "dirty\n");
    expect((await f.action("publish", false)).status).toBe("success");
    const push = f.calls.find((c) => c.args.includes("push"))!;
    expect(push.cwd).toBe(f.repo);
    expect(push.args.at(-1)).toMatch(/:refs\/heads\/main$/);
    expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
      "dirty\n",
    );
  });
  it("update-base reads effective config in clone, refreshes original and fetches before native clone update", async () => {
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
  });
  it.each([
    "base_ref: null",
    "base_ref: ''",
    "base_ref: 42",
    "base_ref: [main]",
    "base_ref: main\nupdate: {strategy: []}",
    "[broken",
  ])("fails closed on invalid effective topics config: %s", async (config) => {
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
  });
  it("missing upstream fails before native update", async () => {
    const f = await fixture();
    await f.git(["branch", "--unset-upstream", "main"]);
    const result = await f.action("update-base");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/upstream/i);
    expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
  });
  it("stale owner rejects without Git mutations", async () => {
    const f = await fixture();
    const result = await f.service.runRepositoryAction({
      projectId: f.project.id,
      context: { ...f.ref, revision: "00000000-0000-4000-8000-000000000001" },
      action: "publish",
    });
    expect(result.status).toBe("error");
    expect(
      f.calls.some((c) => c.args.includes("push") || c.args.includes("fetch")),
    ).toBe(false);
  });
  it("base sync fast-forwards current branch during active base run", async () => {
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
  });
  it("updates non-current base by CAS without touching current original files", async () => {
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
    expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("unrelated");
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
  });
  it("non-fast-forward base refuses without native update or destructive rollback", async () => {
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
  });
  it.each(["main^", "refs/tags/v1", "missing"])(
    "rejects unresolved or non-branch base %s without fetch",
    async (base) => {
      const f = await fixture();
      f.config(`base_ref: ${base}`);
      expect((await f.action("update-base")).status).toBe("error");
      expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    },
  );
  it("rejects tag ambiguity and symbolic base", async () => {
    const f = await fixture();
    await f.git(["tag", "main"]);
    expect((await f.action("update-base")).status).toBe("error");
    await f.git(["tag", "-d", "main"]);
    await f.git(["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    f.config("base_ref: alias");
    expect((await f.action("update-base")).status).toBe("error");
    expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });
  it.each(["config", "original-fetch", "clone-fetch", "update"])(
    "stops at failing %s phase and preserves partial log",
    async (phase) => {
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
    },
  );
  it("refuses moved endpoint between checks without publishing", async () => {
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
  });
  it("returns sanitized native failure and output with environment secrets", async () => {
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
  });
  it("queued action after shutdown returns error without Git mutation", async () => {
    const f = await fixture();
    await f.service.dispose();
    f.calls.length = 0;
    expect((await f.action("publish")).status).toBe("error");
    expect(f.calls).toHaveLength(0);
  });
  it("accepts a quoted literal null branch instead of confusing it with missing config", async () => {
    const f = await fixture();
    await f.git(["branch", "null", "main"]);
    await f.git(["branch", "--set-upstream-to=origin/main", "null"]);
    f.config('base_ref: "null"\nupdate: {strategy: custom-native-strategy}');
    expect((await f.action("update-base")).status).toBe("success");
    expect(
      f.calls.find((c) => c.exe === "FAKE-GOGA" && c.args[0] === "topics")
        ?.args,
    ).not.toContain("--strategy");
  });
  it("ordinary manual sync remains available during an active topic run", async () => {
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
  });
  it("a failed first push prevents publication entirely", async () => {
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
  });
  it("failed publication retains completed local sync", async () => {
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
  });
  it("refresh dirty conflict preserves original changes and does not update topic", async () => {
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
  });
  it("CAS refuses a concurrent non-current base change without overwriting it", async () => {
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
  });
  it("actual Git mutation lock prevents refresh despite active-runs allowance", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, ".git/index.lock"), "fixture lock");
    expect((await f.action("update-base")).status).toBe("error");
    expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
    expect(
      await fs.readFile(path.join(f.repo, ".git/index.lock"), "utf8"),
    ).toBe("fixture lock");
  });
  it("serializes header operations and stops remaining steps after shutdown", async () => {
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
  });
  it("base sync preserves local commits ahead of upstream as already up-to-date", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "base"), "local ahead\n");
    await f.git(["commit", "-am", "ahead"]);
    const head = await f.git(["rev-parse", "HEAD"]);
    expect((await f.action("sync", false)).status).toBe("success");
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
  });
  it("manual retry remains available during active run", async () => {
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
  });
  it("missing clone origin is an error, not an implicit remote configuration write", async () => {
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
  });
  it("quick sync preserves actual cannot-lock-ref diagnostics", async () => {
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
  });
  it("quick sync diagnostics redact secrets without storing raw output in sync state or journal", async () => {
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
  });
});

describe("native topic propagation", () => {
  it("syncs first then invokes exact native propagate in original, allowing dirty files and active runs", async () => {
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
    expect(f.calls.indexOf(pushes[0])).toBeLessThan(f.calls.indexOf(native[0]));
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
  });
  it("rejects primary-only propagation without any command", async () => {
    const f = await fixture();
    await expect(f.action("propagate", false)).rejects.toThrow(
      /топик|контекст/i,
    );
    expect(f.calls).toHaveLength(0);
  });
  it("stops after failed local sync, preserving diagnostics without invoking Goga", async () => {
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
  });
  it("retains synced branch and bounded sanitized partial log on native failure, without fallback", async () => {
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
  });
  it("rejects stale captured owner before any mutation or native invocation", async () => {
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
  });
  it.each(["branch", "settings", "owner"])(
    "rejects changed %s after sync before native invocation",
    async (change) => {
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
    },
  );
});
