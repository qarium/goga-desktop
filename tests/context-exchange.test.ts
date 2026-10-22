import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContextExchangeManager } from "../src/host/context-exchange";
import { CloneManager } from "../src/host/clones";
import { seedLegacyPublication } from "./helpers/legacy-publication";
import { CloneStore, managedCloneLocation } from "../src/host/clone-store";
import {
  worktreeContextRef,
  type WorktreeRecord,
} from "../src/shared/worktrees";
import type { Runner } from "../src/host/process";
import {
  FixtureScope,
  fixtureExecFile as exec,
  gitIntegrationBudget,
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
// Owned, synthetic Git-only fixtures. No external push, native Goga or real HOME.
function fixture() {
  const owner = scope;
  return owner.track(createFixture(owner));
}
async function createFixture(scope: FixtureScope) {
  const root = await fs.mkdtemp(
    "/private/tmp/goga-context-ab-research-20261020-completion-exchange-",
  );
  scope.cleanup(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    repo = path.join(root, "primary"),
    upstream = path.join(root, "upstream.git");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith("GIT_") &&
      ![
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
        "GIT_TERMINAL_PROMPT",
      ].includes(key)
    )
      delete env[key];
  const command = scope.own({ exec }).exec;
  const git = async (args: string[], cwd = repo) =>
    (
      await command("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env,
        signal: scope.signal,
      })
    ).stdout.trim();
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "base"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["init", "--bare", upstream]);
  const project = { id: "fixture", name: "Fixture", path: repo },
    identity = {
      projectId: project.id,
      year: "2026",
      topic: "alpha",
      branch: "goga/2026/alpha",
    };
  const location = managedCloneLocation(
    home,
    project,
    path.join(repo, ".git"),
    identity,
  );
  const record: WorktreeRecord = {
    ...identity,
    ...location,
    revision: randomUUID(),
    storageKind: "clone",
    projectPath: repo,
    sourceCommonDir: path.join(repo, ".git"),
    gitCommonDir: path.join(location.path, ".git"),
    ownership: "managed",
    state: "ready",
  };
  const store = new CloneStore(home);
  await store.reserve(record);
  await git(["init", "-b", "fixture-bootstrap"], record.path);
  await store.claimGit(record);
  await git(["fetch", "--no-tags", repo, "refs/heads/main"], record.path);
  await git(["checkout", "-b", identity.branch, "FETCH_HEAD"], record.path);
  await git(["remote", "add", "desktop-source", repo], record.path);
  await git(
    ["config", "remote.desktop-source.pushurl", "/dev/null"],
    record.path,
  );
  const calls: { args: string[]; cwd: string }[] = [];
  const runner: Pick<Runner, "command"> = {
    command: async (exe, args, cwd, overrides) => {
      calls.push({ args, cwd });
      const r = await command(exe, args, {
        cwd,
        env: { ...env, ...overrides },
        signal: scope.signal,
      });
      return { stdout: r.stdout, stderr: r.stderr };
    },
  };
  let active = false,
    projectActive = false,
    current = record;
  const deps = {
    resolve: async () => current,
    isActive: () => active,
    isProjectActive: () => projectActive,
    nativeEnvironment: () => env,
  };
  const manager = scope.own(new ContextExchangeManager(home, runner, deps)),
    ref = worktreeContextRef(record),
    clones = scope.own(new CloneManager(home, runner));
  return {
    scope,
    root,
    home,
    repo,
    upstream,
    record,
    project,
    ref,
    runner,
    manager,
    clones,
    calls,
    git,
    env,
    deps,
    setActive: (v: boolean) => {
      active = v;
    },
    setProjectActive: (v: boolean) => {
      projectActive = v;
    },
    setRecord: (v: WorktreeRecord) => {
      current = v;
    },
  };
}
async function state(f: Awaited<ReturnType<typeof fixture>>, cwd = f.repo) {
  return {
    head: await f.git(["rev-parse", "HEAD"], cwd),
    branch: await f.git(["symbolic-ref", "HEAD"], cwd),
    index: await fs.readFile(path.join(cwd, ".git/index"), "hex"),
    base: await fs.readFile(path.join(cwd, "base"), "utf8"),
    status: await f.git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    ),
  };
}
describe("immutable incoming base", () => {
  it("imports primary's selected exact OID into a fresh clone service ref without a local base branch", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "base"), "new base\n");
    await f.git(["commit", "-am", "new base"]);
    const before = await state(f),
      cloneBefore = await state(f, f.record.path),
      oid = await f.git(["rev-parse", "main"]);
    const snapshot = await f.manager.captureBase(f.ref, "main");
    expect(snapshot).toMatchObject({
      owner: f.ref,
      baseRef: "main",
      sourceOid: oid,
    });
    expect(snapshot.cloneRef).toMatch(
      /^refs\/desktop\/bases\/ctx-[a-f0-9]{64}\/[a-f0-9-]{36}$/,
    );
    expect(await f.git(["rev-parse", snapshot.cloneRef], f.record.path)).toBe(
      oid,
    );
    expect(await state(f)).toEqual(before);
    expect(await state(f, f.record.path)).toEqual(cloneBefore);
    await expect(
      f.git(["show-ref", "--verify", "refs/heads/main"], f.record.path),
    ).rejects.toThrow();
    await f.manager.verifyBase(snapshot);
    const retry = await f.manager.captureBase(f.ref, "main");
    expect(retry.sourceOid).toBe(oid);
    expect(retry.cloneRef).not.toBe(snapshot.cloneRef);
    expect(
      f.calls.some((c) =>
        c.args.some((v) =>
          ["push", "checkout", "reset", "stash", "clean"].includes(v),
        ),
      ),
    ).toBe(false);
  });
  it("rejects dirty, active, stale owner and changed primary base; retry captures new base", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.record.path, "dirty"), "x");
    await expect(f.manager.captureBase(f.ref, "main")).rejects.toThrow(
      /изменения|чист/i,
    );
    await fs.unlink(path.join(f.record.path, "dirty"));
    f.setActive(true);
    await expect(f.manager.captureBase(f.ref, "main")).rejects.toThrow(
      /занят|актив/i,
    );
    f.setActive(false);
    const snapshot = await f.manager.captureBase(f.ref, "main");
    await fs.writeFile(path.join(f.repo, "base"), "later\n");
    await f.git(["commit", "-am", "later"]);
    await expect(f.manager.verifyBase(snapshot)).rejects.toThrow(
      /измен|устар/i,
    );
    expect((await f.manager.captureBase(f.ref, "main")).sourceOid).not.toBe(
      snapshot.sourceOid,
    );
    f.setRecord({ ...f.record, revision: randomUUID() });
    await expect(f.manager.captureBase(f.ref, "main")).rejects.toThrow(
      /измен|устар/i,
    );
  });
  it("rejects changed service refs and does not silently substitute another selected base", async () => {
    const f = await fixture();
    const snapshot = await f.manager.captureBase(f.ref, "main");
    await expect(
      f.manager.verifyBase({ ...snapshot, baseRef: "HEAD" }),
    ).rejects.toThrow(/измен|устар/i);
    await f.git(["update-ref", "-d", snapshot.cloneRef], f.record.path);
    await expect(f.manager.verifyBase(snapshot)).rejects.toThrow(
      /измен|устар/i,
    );
  });
  it("rejects a local transport URL rewrite before invoking fetch", async () => {
    const f = await fixture();
    await f.git(
      ["config", `url.https://example.invalid/substitute/.insteadOf`, f.repo],
      f.record.path,
    );
    const before = f.calls.length;
    await expect(f.manager.captureBase(f.ref, "main")).rejects.toThrow(
      /снимок|транспорт|измен/i,
    );
    expect(
      f.calls.slice(before).some((call) => call.args.includes("fetch")),
    ).toBe(false);
  });
});

describe("genuine upstream publication policy", () => {
  it("reuses a historical trusted external origin and its private hash-only policy", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    const before = await state(f);
    await seedLegacyPublication(f.record, f.git);
    const prepared = await f.manager.preparePublication(f.ref, {
      action: "publish",
    });
    expect(prepared).toMatchObject({ owner: f.ref, action: "publish" });
    expect(prepared.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await f.git(["remote", "get-url", "--push", "origin"], f.record.path),
    ).toBe(f.upstream);
    const policy = path.join(
        f.record.gitCommonDir,
        "desktop-upstream-policy.json",
      ),
      raw = await fs.readFile(policy, "utf8");
    expect(raw).not.toContain(f.upstream);
    expect(raw).not.toContain("url");
    expect((await fs.stat(policy)).mode & 0o077).toBe(0);
    expect((await f.clones.reconcile(f.project.id))[0].state).toBe("ready");
    await f.manager.verifyPublication(prepared);
    expect(await state(f)).toEqual(before);
    expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
  });
  it("fails before writes for missing or ambiguous primary origin and never substitutes primary transport", async () => {
    const f = await fixture();
    const before = await fs.readFile(
      path.join(f.record.gitCommonDir, "config"),
      "utf8",
    );
    await expect(
      f.manager.preparePublication(f.ref, { action: "publish" }),
    ).rejects.toThrow(/origin|upstream/i);
    await f.git(["remote", "add", "origin", f.upstream]);
    await f.git(["config", "--add", "remote.origin.pushurl", f.upstream]);
    await f.git([
      "config",
      "--add",
      "remote.origin.pushurl",
      "https://example.invalid/other.git",
    ]);
    await expect(
      f.manager.preparePublication(f.ref, { action: "publish" }),
    ).rejects.toThrow(/неоднознач|origin/i);
    expect(
      await fs.readFile(path.join(f.record.gitCommonDir, "config"), "utf8"),
    ).toBe(before);
    expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });
  it("rejects primary and primary common-dir as upstream destinations", async () => {
    for (const common of [false, true]) {
      const f = await fixture();
      await f.git([
        "remote",
        "add",
        "origin",
        common ? f.record.sourceCommonDir! : f.repo,
      ]);
      await expect(
        f.manager.preparePublication(f.ref, { action: "publish" }),
      ).rejects.toThrow(/основн|upstream|origin/i);
      expect(await f.git(["remote"], f.record.path)).toBe("desktop-source");
    }
  });
  it("rejects an arbitrary clone origin without a Desktop policy", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    await f.git(["remote", "add", "origin", f.upstream], f.record.path);
    await expect(
      f.manager.preparePublication(f.ref, { action: "publish" }),
    ).rejects.toThrow(/политик|origin/i);
    expect((await f.clones.reconcile(f.project.id))[0].state).toBe("conflict");
  });
  it("rechecks changed primary, clone and native effective endpoints without exposing secrets", async () => {
    const f = await fixture();
    await f.git([
      "remote",
      "add",
      "origin",
      "https://alice:secret@example.invalid/original.git?token=hidden",
    ]);
    await seedLegacyPublication(f.record, f.git);
    const prepared = await f.manager.preparePublication(f.ref, {
      action: "publish",
    });
    expect(JSON.stringify(prepared)).not.toMatch(/secret|hidden|alice/);
    expect(
      await fs.readFile(
        path.join(f.record.gitCommonDir, "desktop-upstream-policy.json"),
        "utf8",
      ),
    ).not.toMatch(/secret|hidden|alice/);
    await f.git([
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://eve:changed@example.invalid/other.git",
    ]);
    await expect(f.manager.verifyPublication(prepared)).rejects.toThrow(
      /измен|origin|политик/i,
    );
    await f.git(["config", "--unset", "remote.origin.pushurl"]);
    await f.git(
      [
        "config",
        "url.https://evil.invalid/.insteadOf",
        "https://alice:secret@example.invalid/",
      ],
      f.record.path,
    );
    await expect(f.manager.verifyPublication(prepared)).rejects.toThrow(
      /измен|origin|политик/i,
    );
    // Physical ownership remains ready; only native execution uses effective rewrites.
    expect((await f.clones.reconcile(f.project.id))[0].state).toBe("ready");
  });
  it("checks endpoint rewrites under the actual native child environment before enabling origin", async () => {
    const f = await fixture();
    await f.git([
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    const config = path.join(f.home, "native.gitconfig");
    await fs.writeFile(
      config,
      `[url "file://${f.repo}"]\n\tinsteadOf = https://example.invalid/repo.git\n`,
    );
    f.env.GIT_CONFIG_GLOBAL = config;
    await expect(
      f.manager.preparePublication(f.ref, { action: "publish" }),
    ).rejects.toThrow(/origin|основн|upstream/i);
    expect(await f.git(["remote"], f.record.path)).toBe("desktop-source");
  });
  it("prepares genuine non-current base by safe CAS and preserves native propagation's branch-and-push meaning", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    await fs.writeFile(path.join(f.repo, "base"), "advanced\n");
    await f.git(["commit", "-am", "advance"]);
    const before = await state(f),
      cloneBefore = await state(f, f.record.path);
    await seedLegacyPublication(f.record, f.git);
    const prepared = await f.manager.preparePublication(f.ref, {
      action: "propagate",
      baseRef: "main",
    });
    expect(prepared.baseRef).toBe("main");
    expect(prepared.base?.sourceOid).toBe(await f.git(["rev-parse", "main"]));
    expect(await f.git(["rev-parse", "refs/heads/main"], f.record.path)).toBe(
      prepared.base?.sourceOid,
    );
    expect(prepared.details.join(" ")).toMatch(/main/);
    await f.manager.verifyPublication(prepared);
    expect(await state(f)).toEqual(before);
    expect(await state(f, f.record.path)).toEqual(cloneBefore);
    // A harmless native-command stub receives the real branch, never service ref.
    const native = vi.fn(async (baseRef: string) => {
      expect(baseRef).toBe("main");
    });
    await native(prepared.baseRef!);
    expect(native).toHaveBeenCalledOnce();
    expect(
      f.calls.some(
        (c) =>
          c.args.includes("push") ||
          c.args.includes("checkout") ||
          c.args.includes("reset"),
      ),
    ).toBe(false);
  });
  it("refuses divergent clone base instead of resetting or forcing it", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    const tree = await f.git(["rev-parse", "HEAD^{tree}"], f.record.path),
      old = await f.git(["rev-parse", "HEAD"], f.record.path);
    const divergent = (
      await f.scope
        .own({ exec })
        .exec("git", ["commit-tree", tree, "-p", old, "-m", "other"], {
          cwd: f.record.path,
          env: f.env,
          signal: f.scope.signal,
        })
    ).stdout.trim();
    await f.git(["update-ref", "refs/heads/main", divergent], f.record.path);
    await seedLegacyPublication(f.record, f.git);
    await expect(
      f.manager.preparePublication(f.ref, {
        action: "propagate",
        baseRef: "main",
      }),
    ).rejects.toThrow(/расход|diverg|соглас/i);
    expect(await f.git(["rev-parse", "refs/heads/main"], f.record.path)).toBe(
      divergent,
    );
  });
});

describe("publication guard continuity", () => {
  it("shows the actual push endpoint with credentials, user and query masked", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", "https://fetch.invalid/repo.git"]);
    await f.git([
      "config",
      "remote.origin.pushurl",
      "ssh://alice:secret@push.example.invalid/namespace/repo.git?token=hidden",
    ]);
    await seedLegacyPublication(f.record, f.git);
    const prepared = await f.manager.preparePublication(f.ref, {
      action: "publish",
    });
    expect(prepared.details.join(" ")).toContain(
      "ssh://push.example.invalid/namespace/repo.git",
    );
    expect(JSON.stringify(prepared)).not.toMatch(/alice|secret|hidden|token=/);
  });

  it("allows policy reuse but rejects changed clone pushurl and changed owner revision before native execution", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    await seedLegacyPublication(f.record, f.git);
    const snapshot = await f.manager.preparePublication(f.ref, {
      action: "update",
    });
    const before = await fs.readFile(
      path.join(f.record.gitCommonDir, "config"),
      "utf8",
    );
    await f.manager.verifyPublication(snapshot);
    await f.manager.preparePublication(f.ref, { action: "publish" });
    expect(
      await fs.readFile(path.join(f.record.gitCommonDir, "config"), "utf8"),
    ).toBe(before);
    f.setRecord({ ...f.record, revision: randomUUID() });
    await expect(f.manager.verifyPublication(snapshot)).rejects.toThrow(
      /измен|устар/i,
    );
    f.setRecord(f.record);
    await f.git(["config", "remote.origin.pushurl", f.repo], f.record.path);
    await expect(f.manager.verifyPublication(snapshot)).rejects.toThrow(
      /origin|политик/i,
    );
    expect((await f.clones.reconcile(f.project.id))[0].state).toBe("conflict");
  });
  it("rejects copied policy from another clone and unsafe origin options", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    await seedLegacyPublication(f.record, f.git);
    await f.manager.preparePublication(f.ref, { action: "publish" });
    const file = path.join(
        f.record.gitCommonDir,
        "desktop-upstream-policy.json",
      ),
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...raw, contextId: "another" }));
    await expect(
      f.manager.preparePublication(f.ref, { action: "publish" }),
    ).rejects.toThrow(/origin|политик/i);
    const other = await fixture();
    await other.git(["remote", "add", "origin", other.upstream]);
    await other.git(["config", "remote.origin.mirror", "true"]);
    await expect(
      other.manager.preparePublication(other.ref, { action: "publish" }),
    ).rejects.toThrow(/origin|политик/i);
    expect(await other.git(["remote"], other.record.path)).toBe(
      "desktop-source",
    );
  });
  it("rejects a source/clone rewrite mismatch without enabling origin", async () => {
    const f = await fixture();
    await f.git([
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    await f.git(
      [
        "config",
        "url.https://different.invalid/.pushInsteadOf",
        "https://example.invalid/",
      ],
      f.record.path,
    );
    await expect(
      f.manager.preparePublication(f.ref, { action: "publish" }),
    ).rejects.toThrow(/origin|политик/i);
    expect(await f.git(["remote"], f.record.path)).toBe("desktop-source");
    await expect(
      fs.stat(path.join(f.record.gitCommonDir, "desktop-upstream-policy.json")),
    ).rejects.toThrow();
  });
  it("fast-forwards an existing clone base with CAS; stale base/active project invalidates confirmation", async () => {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    await f.git(["branch", "main"], f.record.path);
    await fs.writeFile(path.join(f.repo, "base"), "newer\n");
    await f.git(["commit", "-am", "newer"]);
    await seedLegacyPublication(f.record, f.git);
    const snapshot = await f.manager.preparePublication(f.ref, {
      action: "propagate",
      baseRef: "main",
    });
    expect(snapshot.details.join(" ")).toContain("fast-forward");
    f.setProjectActive(true);
    await expect(f.manager.verifyPublication(snapshot)).rejects.toThrow(
      /занят|актив/i,
    );
    f.setProjectActive(false);
    await fs.writeFile(path.join(f.repo, "base"), "latest\n");
    await f.git(["commit", "-am", "latest"]);
    await expect(f.manager.verifyPublication(snapshot)).rejects.toThrow(
      /измен|устар/i,
    );
  });
});

it("prepares with the real locking CloneManager resolver and an owner-bound native environment callback", async () => {
  const f = await fixture();
  await f.git(["remote", "add", "origin", f.upstream]);
  await seedLegacyPublication(f.record, f.git);
  const manager = f.scope.own(
    new ContextExchangeManager(f.home, f.runner, {
      ...f.deps,
      resolve: (ref) => f.clones.resolve(ref),
      nativeEnvironment: async (ref) => {
        await f.clones.resolve(ref);
        return f.env;
      },
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "real CloneManager exchange exceeded its finite Git budget (possible nested lock deadlock)",
          ),
        ),
      gitIntegrationBudget(10000),
    );
  });
  try {
    const snapshot = await Promise.race([
      f.scope.track(
        manager.preparePublication(f.ref, {
          action: "propagate",
          baseRef: "main",
        }),
      ),
      deadline,
    ]);
    await manager.verifyPublication(snapshot);
  } finally {
    clearTimeout(timer);
  }
});

it("never overwrites a collided service ref, even when Git could fast-forward it", async () => {
  const f = await fixture();
  const old = await f.git(["rev-parse", "HEAD"], f.record.path);
  await fs.writeFile(path.join(f.repo, "base"), "advanced collision\n");
  await f.git(["commit", "-am", "advance"]);
  let collided: string | undefined;
  const runner: Pick<Runner, "command"> = {
    command: async (exe, args, cwd, env, stdin) => {
      const destination =
        args
          .find((value) => /:refs\/desktop\/bases\//.test(value))
          ?.split(":")[1] ||
        (args.includes("update-ref")
          ? args.find((value) => value.startsWith("refs/desktop/bases/"))
          : undefined);
      if (!collided && destination) {
        collided = destination;
        await f.git(["update-ref", destination, old], f.record.path);
      }
      return f.runner.command(exe, args, cwd, env, stdin);
    },
  };
  const manager = f.scope.own(
    new ContextExchangeManager(f.home, runner, f.deps),
  );
  await expect(manager.captureBase(f.ref, "main")).rejects.toThrow(
    /снимок|измен/i,
  );
  expect(collided).toBeDefined();
  expect(await f.git(["rev-parse", collided!], f.record.path)).toBe(old);
});

it("rejects non-Git local upstreams instead of enabling an unusable publication destination", async () => {
  const f = await fixture(),
    directory = path.join(f.root, "not-a-repository");
  await fs.mkdir(directory);
  await f.git(["remote", "add", "origin", directory]);
  await expect(
    f.manager.preparePublication(f.ref, { action: "publish" }),
  ).rejects.toThrow(/origin|upstream/i);
  expect(await f.git(["remote"], f.record.path)).toBe("desktop-source");
});

it("canonicalizes case-insensitive file URLs and rejects disguised primary push destinations", async () => {
  const f = await fixture();
  await f.git(["remote", "add", "origin", f.upstream]);
  await f.git(["config", "remote.origin.pushurl", `FILE://${f.repo}/.git`]);
  await expect(
    f.manager.preparePublication(f.ref, { action: "publish" }),
  ).rejects.toThrow(/origin|upstream/i);
  expect(await f.git(["remote"], f.record.path)).toBe("desktop-source");
});

it("preserves tracked, staged and untracked dirty bytes for commits-only publish and propagate", async () => {
  for (const action of ["publish", "propagate"] as const) {
    const f = await fixture();
    await f.git(["remote", "add", "origin", f.upstream]);
    await fs.writeFile(path.join(f.record.path, "base"), "staged\n");
    await f.git(["add", "base"], f.record.path);
    await fs.writeFile(path.join(f.record.path, "base"), "working\n");
    await fs.writeFile(path.join(f.record.path, "untracked"), "untracked\n");
    const before = await state(f, f.record.path),
      primaryBefore = await state(f);
    await seedLegacyPublication(f.record, f.git);
    const snapshot = await f.manager.preparePublication(f.ref, {
      action,
      ...(action === "propagate" ? { baseRef: "main" } : {}),
    });
    await f.manager.verifyPublication(snapshot);
    expect(await state(f, f.record.path)).toEqual(before);
    expect(await state(f)).toEqual(primaryBefore);
    expect(
      await fs.readFile(path.join(f.record.path, "untracked"), "utf8"),
    ).toBe("untracked\n");
    await expect(f.manager.captureBase(f.ref, "main")).rejects.toThrow(
      /изменения|чист/i,
    );
    await expect(
      f.manager.preparePublication(f.ref, { action: "update" }),
    ).rejects.toThrow(/изменения|чист/i);
  }
});

describe("physical origin policy versus final native environment", () => {
  it("keeps a verified clone ready when project-native Git config rewrites its genuine origin alias", async () => {
    const f = await fixture();
    const alias = "https://alias.invalid/repo.git",
      genuine = "https://example.invalid/genuine.git";
    await f.git(["remote", "add", "origin", alias]);
    const config = path.join(f.home, "project-native.gitconfig");
    await fs.writeFile(config, `[url "${genuine}"]\n\tinsteadOf = ${alias}\n`);
    await seedLegacyPublication(f.record, f.git, async (args, cwd) =>
      (
        await f.runner.command("git", args, cwd, {
          ...f.env,
          GIT_CONFIG_GLOBAL: config,
        })
      ).stdout.trim(),
    );
    const manager = f.scope.own(
      new ContextExchangeManager(f.home, f.runner, {
        ...f.deps,
        resolve: (ref) => f.clones.resolve(ref),
        nativeEnvironment: async (ref) => {
          await f.clones.resolve(ref);
          return { ...f.env, GIT_CONFIG_GLOBAL: config };
        },
      }),
    );
    const prepared = await manager.preparePublication(f.ref, {
      action: "publish",
    });
    expect(prepared.details.join(" ")).toContain(genuine);
    expect(await f.clones.resolve(f.ref)).toMatchObject({
      state: "ready",
      revision: f.ref.revision,
    });
    await manager.verifyPublication(prepared);
    expect((await f.clones.reconcile(f.project.id))[0]).toMatchObject({
      state: "ready",
      revision: f.ref.revision,
    });
  });
  it("refuses execution when final native rewrites change or redirect origin to primary despite an intact physical policy", async () => {
    const f = await fixture();
    const alias = "https://alias.invalid/repo.git",
      genuine = "https://example.invalid/genuine.git";
    await f.git(["remote", "add", "origin", alias]);
    const config = path.join(f.home, "project-native.gitconfig");
    await fs.writeFile(config, `[url "${genuine}"]\n\tinsteadOf = ${alias}\n`);
    await seedLegacyPublication(f.record, f.git, async (args, cwd) =>
      (
        await f.runner.command("git", args, cwd, {
          ...f.env,
          GIT_CONFIG_GLOBAL: config,
        })
      ).stdout.trim(),
    );
    const manager = f.scope.own(
      new ContextExchangeManager(f.home, f.runner, {
        ...f.deps,
        resolve: (ref) => f.clones.resolve(ref),
        nativeEnvironment: async (ref) => {
          await f.clones.resolve(ref);
          return { ...f.env, GIT_CONFIG_GLOBAL: config };
        },
      }),
    );
    const prepared = await manager.preparePublication(f.ref, {
      action: "publish",
    });
    for (const destination of [
      "https://example.invalid/changed.git",
      `file://${f.repo}`,
    ]) {
      await fs.writeFile(
        config,
        `[url "${destination}"]\n\tinsteadOf = ${alias}\n`,
      );
      expect(await f.clones.resolve(f.ref)).toMatchObject({
        state: "ready",
        revision: f.ref.revision,
      });
      await expect(manager.verifyPublication(prepared)).rejects.toThrow(
        /origin|политик|измен/i,
      );
    }
    expect(f.calls.some((call) => call.args.includes("push"))).toBe(false);
    await f.git([
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/raw-changed.git",
    ]);
    await expect(f.clones.resolve(f.ref)).rejects.toThrow(
      /недоступ|конфликт|измен/i,
    );
  });
});

describe("local origin publication boundary", () => {
  it.each([false, true])(
    "does not enable an external upstream when local origin exists=%s",
    async (hasOrigin) => {
      const f = await fixture();
      await f.git(["remote", "add", "origin", f.upstream]);
      if (hasOrigin)
        await f.git(["remote", "add", "origin", f.repo], f.record.path);
      const before = await fs.readFile(
        path.join(f.record.gitCommonDir, "config"),
        "utf8",
      );
      await expect(
        f.manager.preparePublication(f.ref, { action: "publish" }),
      ).rejects.toThrow(/локальн.*origin|origin.*локальн|синхронизац/i);
      expect(
        await fs.readFile(path.join(f.record.gitCommonDir, "config"), "utf8"),
      ).toBe(before);
      expect(
        f.calls.some(
          (call) => call.args.includes("push") || call.args.includes("fetch"),
        ),
      ).toBe(false);
      expect((await f.clones.reconcile(f.project.id))[0].state).toBe("ready");
    },
  );
});
