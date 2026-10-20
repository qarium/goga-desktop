import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ContextSyncManager } from "../src/host/context-sync";
import { CloneManager } from "../src/host/clones";
import { CloneStore, managedCloneLocation } from "../src/host/clone-store";
import {
  worktreeContextRef,
  type WorktreeRecord,
} from "../src/shared/worktrees";
import type { Runner } from "../src/host/process";
vi.setConfig({ testTimeout: 30000 });
const exec = promisify(execFile);
// Retained synthetic fixtures only; never read actual HOME/global Git config.
async function fixture() {
  const root = await fs.mkdtemp(
    "/private/tmp/goga-context-ab-research-20261019-impl-sync-",
  );
  const home = path.join(root, "home"),
    repo = path.join(root, "primary");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  const env = {
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
      delete (env as Record<string, string | undefined>)[key];
  const git = async (args: string[], cwd = repo) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env,
      })
    ).stdout.trim();
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "base"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  const project = { id: "fixture", name: "Fixture", path: repo };
  const identity = {
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
  await fs.writeFile(path.join(record.path, "clone-only"), "first\n");
  await git(["add", "."], record.path);
  await git(["commit", "-m", "clone commit"], record.path);
  const calls: { args: string[]; cwd: string }[] = [];
  const runner: Pick<Runner, "command"> = {
    command: async (exe, args, cwd, overrides, stdin) => {
      calls.push({ args, cwd });
      const result = await exec(exe, args, {
        cwd,
        env: { ...env, ...overrides },
      });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  };
  let active = false;
  const deps = { resolve: async () => record, isActive: () => active };
  const manager = new ContextSyncManager(home, runner, deps),
    ref = worktreeContextRef(record);
  return {
    root,
    home,
    repo,
    record,
    project,
    ref,
    runner,
    deps,
    manager,
    calls,
    git,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}
async function workingState(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    head: await f.git(["rev-parse", "HEAD"]),
    branch: await f.git(["symbolic-ref", "HEAD"]),
    index: await fs.readFile(path.join(f.repo, ".git", "index"), "hex"),
    status: await f.git(["status", "--porcelain=v1", "--untracked-files=all"]),
    base: await fs.readFile(path.join(f.repo, "base"), "utf8"),
  };
}
async function repairableFixture() {
  const f = await fixture();
  await f.git(["remote", "add", "desktop-source", f.repo], f.record.path);
  await f.git(
    ["config", "--local", "remote.desktop-source.pushurl", "/dev/null"],
    f.record.path,
  );
  const clones = new CloneManager(f.home, f.runner);
  const deps = {
    resolve: (ref: ReturnType<typeof worktreeContextRef>) =>
      clones.resolve(ref),
    isActive: f.deps.isActive,
  };
  const manager = new ContextSyncManager(f.home, f.runner, deps);
  const journal = path.join(f.home, ".goga/desktop/sync/journal.json");
  const restoreBranch = async () => {
    const rootBefore = await fs.lstat(f.record.path);
    const gitBefore = await fs.lstat(f.record.gitCommonDir);
    await f.git(["checkout", "--detach"], f.record.path);
    expect((await clones.reconcile(f.project.id))[0].state).toBe("conflict");
    await f.git(["checkout", f.record.branch], f.record.path);
    const restored = (await clones.reconcile(f.project.id))[0];
    expect(restored.state).toBe("ready");
    expect(restored.revision).not.toBe(f.ref.revision);
    const rootAfter = await fs.lstat(restored.path);
    const gitAfter = await fs.lstat(restored.gitCommonDir);
    expect([rootAfter.dev, rootAfter.ino, gitAfter.dev, gitAfter.ino]).toEqual([
      rootBefore.dev,
      rootBefore.ino,
      gitBefore.dev,
      gitBefore.ino,
    ]);
    return worktreeContextRef(restored);
  };
  return { ...f, manager, journal, restoreBranch };
}

describe("completed sync revision recovery", () => {
  it("accepts a revision-only refresh after a verified completed import", async () => {
    const f = await fixture();
    const first = await f.manager.request(f.project, f.ref);
    f.record.revision = randomUUID();
    const freshRef = worktreeContextRef(f.record);
    expect(await f.manager.status(f.project, freshRef)).toMatchObject({
      revision: freshRef.revision,
      status: "synced",
      destinationRef: first.destinationRef,
    });
  });
  it("resumes completed history for the same repaired owned clone without retargeting its immutable operation", async () => {
    const f = await repairableFixture();
    const first = await f.manager.request(f.project, f.ref);
    expect(first.status).toBe("synced");
    const original = JSON.parse(await fs.readFile(f.journal, "utf8"))
      .entries[0];
    const freshRef = await f.restoreBranch();
    const restarted = new ContextSyncManager(f.home, f.runner, {
      resolve: (ref) => new CloneManager(f.home, f.runner).resolve(ref),
      isActive: () => false,
    });
    expect(await restarted.status(f.project, freshRef)).toMatchObject({
      revision: freshRef.revision,
      status: "synced",
      importedOid: first.importedOid,
      destinationRef: first.destinationRef,
    });
    expect(await restarted.request(f.project, freshRef)).toMatchObject({
      revision: freshRef.revision,
      status: "synced",
      operationId: first.operationId,
      destinationRef: first.destinationRef,
    });
    const recovered = JSON.parse(await fs.readFile(f.journal, "utf8"))
      .entries[0];
    expect(recovered.owner.revision).toBe(freshRef.revision);
    expect(recovered.operation).toEqual(original.operation);
    await expect(restarted.status(f.project, f.ref)).rejects.toThrow();
    await expect(restarted.request(f.project, f.ref)).rejects.toThrow();
    await expect(restarted.retry(f.project, freshRef)).rejects.toThrow(
      /Нет сохранённой операции/,
    );
    await fs.writeFile(
      path.join(f.record.path, "after-repair"),
      "new commit\n",
    );
    await f.git(["add", "."], f.record.path);
    await f.git(["commit", "-m", "after repair"], f.record.path);
    const next = await restarted.request(f.project, freshRef);
    expect(next.status).toBe("synced");
    expect(next.sourceOid).not.toBe(first.sourceOid);
    expect(next.operationId).not.toBe(first.operationId);
    const updated = JSON.parse(await fs.readFile(f.journal, "utf8")).entries[0];
    expect(updated.operation.owner.revision).toBe(freshRef.revision);
    expect(updated.operation.sourceOid).toBe(next.sourceOid);
  });

  it("does not rebind a failed immutable operation to a repaired owner revision", async () => {
    const f = await repairableFixture();
    const manager = new ContextSyncManager(
      f.home,
      {
        command: async (exe, args, cwd, env, stdin) => {
          if (cwd === f.repo && args.includes("fetch"))
            throw Error("fixture transport failure");
          return f.runner.command(exe, args, cwd, env, stdin);
        },
      },
      {
        resolve: (ref) => new CloneManager(f.home, f.runner).resolve(ref),
        isActive: () => false,
      },
    );
    expect((await manager.request(f.project, f.ref)).status).toBe("error");
    const before = await fs.readFile(f.journal, "utf8");
    const freshRef = await f.restoreBranch();
    await expect(manager.status(f.project, freshRef)).rejects.toThrow();
    await expect(manager.request(f.project, freshRef)).rejects.toThrow();
    await expect(manager.retry(f.project, freshRef)).rejects.toThrow();
    expect(await fs.readFile(f.journal, "utf8")).toBe(before);
  });

  it("does not rebind an outstanding apply confirmation after owner revision recovery", async () => {
    const f = await repairableFixture();
    await f.manager.request(f.project, f.ref);
    const preview = await f.manager.previewApply(f.project, f.ref);
    expect(preview.canApply).toBe(true);
    const before = await fs.readFile(f.journal, "utf8");
    const freshRef = await f.restoreBranch();
    await expect(f.manager.status(f.project, freshRef)).rejects.toThrow();
    await expect(f.manager.request(f.project, freshRef)).rejects.toThrow();
    await expect(f.manager.previewApply(f.project, freshRef)).rejects.toThrow();
    await expect(
      f.manager.apply(f.project, { token: preview.token, confirmed: true }),
    ).rejects.toThrow();
    expect(await fs.readFile(f.journal, "utf8")).toBe(before);
  });
});
describe("immutable context commit import", () => {
  it("imports one immutable clone snapshot to a fresh service ref without changing dirty primary HEAD/index/files or FETCH_HEAD", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "base"), "primary dirty\n");
    await fs.writeFile(path.join(f.repo, "untracked"), "keep\n");
    const before = await workingState(f),
      oid = await f.git(["rev-parse", "HEAD"], f.record.path);
    const result = await f.manager.request(f.project, f.ref);
    expect(result.status).toBe("synced");
    expect(result.importedOid).toBe(oid);
    expect(result.destinationRef).toMatch(/^refs\/desktop\/contexts\//);
    expect(await f.git(["rev-parse", result.destinationRef!])).toBe(oid);
    expect(await workingState(f)).toEqual(before);
    await expect(
      fs.stat(path.join(f.repo, ".git", "FETCH_HEAD")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const fetch = f.calls.find((c) => c.args.includes("fetch"))!;
    expect(fetch.args).toEqual(
      expect.arrayContaining([
        "--atomic",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--refmap=",
        `${oid}:${result.destinationRef}`,
      ]),
    );
    expect(fetch.cwd).toBe(f.repo);
    expect(fetch.args).not.toContain("origin");
  });
});

describe("durable queue and retries", () => {
  it("defers manual and automatic requests until the actual run ends, deduplicates and survives manager restart", async () => {
    const f = await fixture();
    f.setActive(true);
    expect(
      (await f.manager.request(f.project, f.ref, "manual", "run-one")).status,
    ).toBe("waiting");
    expect((await f.manager.afterRun(f.project, f.ref, "run-one")).status).toBe(
      "waiting",
    );
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(0);
    const restarted = new ContextSyncManager(f.home, f.runner, f.deps);
    expect((await restarted.status(f.project, f.ref)).status).toBe("waiting");
    f.setActive(false);
    const results = await Promise.all([
      restarted.afterRun(f.project, f.ref, "run-one"),
      f.manager.request(f.project, f.ref),
    ]);
    expect(results.every((s) => s.status === "synced")).toBe(true);
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
    expect(results[0].waitingRunIds).toEqual([]);
  });
  it("imports the captured OID only and reports commits created after the snapshot as new", async () => {
    const f = await fixture(),
      first = await f.git(["rev-parse", "HEAD"], f.record.path);
    let advanced = false;
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        if (args[1].includes("fetch") && !advanced) {
          advanced = true;
          await fs.writeFile(path.join(f.record.path, "later"), "later");
          await f.git(["add", "."], f.record.path);
          await f.git(["commit", "-m", "later"], f.record.path);
        }
        return f.runner.command(...args);
      },
    };
    const manager = new ContextSyncManager(f.home, runner, f.deps),
      result = await manager.request(f.project, f.ref);
    expect(result.status).toBe("new");
    expect(result.importedOid).toBe(first);
    expect(await f.git(["rev-parse", result.destinationRef!])).toBe(first);
    const latest = await f.git(["rev-parse", "HEAD"], f.record.path);
    expect((await manager.status(f.project, f.ref)).sourceOid).toBe(latest);
    const next = await manager.request(f.project, f.ref);
    expect(next.status).toBe("synced");
    expect(next.importedOid).toBe(latest);
    expect(next.destinationRef).not.toBe(result.destinationRef);
    expect(await f.git(["rev-parse", result.destinationRef!])).toBe(first);
  });
  it("keeps sync failure independent and retries the same immutable operation after restart", async () => {
    const f = await fixture();
    let fail = true;
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        if (args[1].includes("fetch") && fail)
          throw new Error("fixture import failed");
        return f.runner.command(...args);
      },
    };
    const manager = new ContextSyncManager(f.home, runner, f.deps),
      failed = await manager.afterRun(
        f.project,
        f.ref,
        "failed-or-stopped-run",
      );
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/fixture import failed/);
    fail = false;
    await fs.writeFile(path.join(f.record.path, "later"), "later");
    await f.git(["add", "."], f.record.path);
    await f.git(["commit", "-m", "later"], f.record.path);
    const restarted = new ContextSyncManager(f.home, runner, f.deps);
    const retried = await restarted.retry(f.project, f.ref);
    expect(retried.status).toBe("new");
    expect(retried.importedOid).toBe(failed.sourceOid);
    expect(retried.operationId).toBe(failed.operationId);
    expect(retried.destinationRef).toBe(failed.destinationRef);
  });
  it("recovers a durable in-progress import after fetch completed but before result journaling", async () => {
    const f = await fixture();
    let changed = false;
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        const result = await f.runner.command(...args);
        if (args[1].includes("fetch") && !changed) {
          changed = true;
          throw new Error("simulated interrupted result");
        }
        return result;
      },
    };
    const manager = new ContextSyncManager(f.home, runner, f.deps);
    const failed = await manager.request(f.project, f.ref);
    const file = path.join(f.home, ".goga", "desktop", "sync", "journal.json");
    const doc = JSON.parse(await fs.readFile(file, "utf8"));
    doc.entries[0].state.status = "syncing";
    await fs.writeFile(file, JSON.stringify(doc));
    const restarted = new ContextSyncManager(f.home, f.runner, f.deps),
      recovered = await restarted.recover([f.project]);
    expect(recovered[0].status).toBe("synced");
    expect(recovered[0].importedOid).toBe(failed.sourceOid);
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
  });
  it("rejects an owner mismatch before primary import", async () => {
    const f = await fixture();
    const manager = new ContextSyncManager(f.home, f.runner, {
      ...f.deps,
      resolve: async () => ({ ...f.record, revision: randomUUID() }),
    });
    await expect(manager.request(f.project, f.ref)).rejects.toThrow(
      /Контекст|измен/,
    );
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(0);
  });
});

describe("explicit confirmed application", () => {
  it("previews the actual current target and merges only after confirmation, preserving independent primary commits", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "manual"), "manual commit\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "manual primary"]);
    const manual = await f.git(["rev-parse", "HEAD"]);
    const imported = await f.manager.request(f.project, f.ref),
      before = await workingState(f);
    const preview = await f.manager.previewApply(f.project, f.ref);
    expect(preview).toMatchObject({
      canApply: true,
      targetBranch: "main",
      targetOid: manual,
      sourceOid: imported.importedOid,
    });
    expect(preview.files).toContain("clone-only");
    expect(await workingState(f)).toEqual(before);
    await expect(
      f.manager.apply(f.project, {
        token: preview.token,
        confirmed: false as true,
      }),
    ).rejects.toThrow(/подтверж/);
    expect(await workingState(f)).toEqual(before);
    const result = await new ContextSyncManager(f.home, f.runner, f.deps).apply(
      f.project,
      { token: preview.token, confirmed: true },
    );
    expect(result.previousTargetOid).toBe(manual);
    expect(result.targetOid).not.toBe(manual);
    expect(await f.git(["merge-base", manual, "HEAD"])).toBe(manual);
    expect(await fs.readFile(path.join(f.repo, "clone-only"), "utf8")).toBe(
      "first\n",
    );
    expect(await fs.readFile(path.join(f.repo, "manual"), "utf8")).toBe(
      "manual commit\n",
    );
    await expect(
      f.manager.apply(f.project, { token: preview.token, confirmed: true }),
    ).rejects.toThrow(/preview|предпросмотр|использован|устар/i);
    expect((await f.manager.status(f.project, f.ref)).status).toBe("synced");
  });
  it("refuses dirty primary, active owners, in-progress Git operations and detached targets", async () => {
    const f = await fixture();
    await f.manager.request(f.project, f.ref);
    await fs.writeFile(path.join(f.repo, "base"), "dirty");
    expect((await f.manager.previewApply(f.project, f.ref)).canApply).toBe(
      false,
    );
    await fs.writeFile(path.join(f.repo, "base"), "base\n");
    f.setActive(true);
    expect((await f.manager.previewApply(f.project, f.ref)).canApply).toBe(
      false,
    );
    f.setActive(false);
    await fs.writeFile(
      path.join(f.repo, ".git", "MERGE_HEAD"),
      await f.git(["rev-parse", "HEAD"]),
    );
    expect((await f.manager.previewApply(f.project, f.ref)).canApply).toBe(
      false,
    );
    await fs.unlink(path.join(f.repo, ".git", "MERGE_HEAD"));
    await f.git(["checkout", "--detach"]);
    expect((await f.manager.previewApply(f.project, f.ref)).canApply).toBe(
      false,
    );
  });
  it("invalidates preview when target OID, target branch or local cleanliness changes before confirmation", async () => {
    const f = await fixture();
    await f.manager.request(f.project, f.ref);
    const preview = await f.manager.previewApply(f.project, f.ref);
    await fs.writeFile(path.join(f.repo, "manual"), "new");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "manual after preview"]);
    const before = await workingState(f);
    await expect(
      f.manager.apply(f.project, { token: preview.token, confirmed: true }),
    ).rejects.toThrow(/измен|устар/);
    expect(await workingState(f)).toEqual(before);
    const fresh = await f.manager.previewApply(f.project, f.ref);
    await f.git(["checkout", "-b", "other"]);
    const branchState = await workingState(f);
    await expect(
      f.manager.apply(f.project, { token: fresh.token, confirmed: true }),
    ).rejects.toThrow(/измен|устар/);
    expect(await workingState(f)).toEqual(branchState);
  });
  it("preflights merge conflicts without creating a merge operation or changing primary index/files", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "base"), "primary change\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "primary conflict"]);
    await fs.writeFile(path.join(f.record.path, "base"), "clone change\n");
    await f.git(["add", "."], f.record.path);
    await f.git(["commit", "-m", "clone conflict"], f.record.path);
    await f.manager.request(f.project, f.ref);
    const before = await workingState(f),
      preview = await f.manager.previewApply(f.project, f.ref);
    expect(preview.canApply).toBe(false);
    expect(preview.reason).toMatch(/конфликт|предваритель/i);
    expect(await workingState(f)).toEqual(before);
    await expect(
      fs.stat(path.join(f.repo, ".git", "MERGE_HEAD")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      f.manager.apply(f.project, { token: preview.token, confirmed: true }),
    ).rejects.toThrow();
    expect(await workingState(f)).toEqual(before);
  });
});

describe("snapshot, journal and restart safety", () => {
  it("deduplicates a repeated automatic completion event even after later clone commits appear", async () => {
    const f = await fixture(),
      first = await f.manager.afterRun(f.project, f.ref, "completed-run");
    await fs.writeFile(
      path.join(f.record.path, "post-run"),
      "new later commit",
    );
    await f.git(["add", "."], f.record.path);
    await f.git(["commit", "-m", "not part of completed run"], f.record.path);
    const repeated = await new ContextSyncManager(
      f.home,
      f.runner,
      f.deps,
    ).afterRun(f.project, f.ref, "completed-run");
    expect(repeated.status).toBe("new");
    expect(repeated.importedOid).toBe(first.importedOid);
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
  });
  it("never overwrites a competing journal revision during the fetch", async () => {
    const f = await fixture();
    const file = path.join(f.home, ".goga", "desktop", "sync", "journal.json");
    let competing = "";
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        const result = await f.runner.command(...args);
        if (args[1].includes("fetch")) {
          const doc = JSON.parse(await fs.readFile(file, "utf8"));
          doc.revision = randomUUID();
          competing = JSON.stringify(doc);
          await fs.writeFile(file, competing);
        }
        return result;
      },
    };
    await expect(
      new ContextSyncManager(f.home, runner, f.deps).request(f.project, f.ref),
    ).rejects.toThrow(/журнал|измен/);
    expect(await fs.readFile(file, "utf8")).toBe(competing);
  });
  it("recovers an abandoned operation lock only when its recorded process is gone", async () => {
    const f = await fixture();
    await f.manager.status(f.project, f.ref);
    const lock = path.join(
      f.home,
      ".goga",
      "desktop",
      "sync",
      "operation.lock",
    );
    await fs.writeFile(
      lock,
      JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
      { mode: 0o600 },
    );
    await expect(f.manager.recover([f.project])).rejects.toThrow(
      /ещё работает/,
    );
    await fs.unlink(lock);
    await fs.writeFile(
      lock,
      JSON.stringify({ pid: 2147483647, nonce: randomUUID() }),
      { mode: 0o600 },
    );
    expect(await f.manager.recover([f.project])).toEqual([]);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("recovers an apply result journal interrupted after a successful merge without merging a second time", async () => {
    const f = await fixture();
    await f.manager.request(f.project, f.ref);
    const preview = await f.manager.previewApply(f.project, f.ref);
    let merged = false;
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        const result = await f.runner.command(...args);
        if (args[1].includes("merge") && !merged) {
          merged = true;
          throw new Error("result channel interrupted");
        }
        return result;
      },
    };
    await expect(
      new ContextSyncManager(f.home, runner, f.deps).apply(f.project, {
        token: preview.token,
        confirmed: true,
      }),
    ).rejects.toThrow(/не завершено/);
    const mergedOid = await f.git(["rev-parse", "HEAD"]);
    const recovered = new ContextSyncManager(f.home, f.runner, f.deps);
    await recovered.recover([f.project]);
    const doc = JSON.parse(
      await fs.readFile(
        path.join(f.home, ".goga", "desktop", "sync", "journal.json"),
        "utf8",
      ),
    );
    expect(doc.entries[0].apply.phase).toBe("applied");
    expect(doc.entries[0].apply.resultOid).toBe(mergedOid);
    expect(await f.git(["rev-parse", "HEAD"])).toBe(mergedOid);
    await expect(
      recovered.apply(f.project, { token: preview.token, confirmed: true }),
    ).rejects.toThrow(/использован|устар/);
  });
});

describe("durable owner binding", () => {
  it("refuses recovery if persisted source/destination paths differ from the freshly resolved owner", async () => {
    const f = await fixture();
    const failing: Pick<Runner, "command"> = {
      command: async (...args) => {
        if (args[1].includes("fetch")) throw new Error("transport failure");
        return f.runner.command(...args);
      },
    };
    await new ContextSyncManager(f.home, failing, f.deps).request(
      f.project,
      f.ref,
    );
    const file = path.join(f.home, ".goga", "desktop", "sync", "journal.json"),
      doc = JSON.parse(await fs.readFile(file, "utf8"));
    doc.entries[0].owner.path = f.repo;
    doc.entries[0].operation.owner.path = f.repo;
    await fs.writeFile(file, JSON.stringify(doc));
    const result = await f.manager.retry(f.project, f.ref);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Контекст|владел|измен/);
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(0);
  });
  it("refuses apply when a persisted preview is transplanted into another context entry", async () => {
    const f = await fixture();
    await f.manager.request(f.project, f.ref);
    const preview = await f.manager.previewApply(f.project, f.ref);
    const file = path.join(f.home, ".goga", "desktop", "sync", "journal.json"),
      doc = JSON.parse(await fs.readFile(file, "utf8"));
    doc.entries[0].owner.path = f.repo;
    await fs.writeFile(file, JSON.stringify(doc));
    const before = await workingState(f);
    await expect(
      f.manager.apply(f.project, { token: preview.token, confirmed: true }),
    ).rejects.toThrow(/Контекст|измен/);
    expect(await workingState(f)).toEqual(before);
  });
});

describe("non-blocking status and detached import", () => {
  it.each([0, 350])(
    "reports the durable syncing state before releasing import, with %sms delayed status Git",
    async (statusDelayMs) => {
      const f = await fixture();
      let reached!: () => void, release!: () => void;
      let importBlocked = false,
        readingStatus = false,
        delayApplied = false;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner: Pick<Runner, "command"> = {
        command: async (...args) => {
          if (args[1].includes("fetch")) {
            importBlocked = true;
            reached();
            await gate;
            importBlocked = false;
          } else if (readingStatus && !delayApplied) {
            delayApplied = true;
            await new Promise((resolve) => setTimeout(resolve, statusDelayMs));
          }
          return f.runner.command(...args);
        },
      };
      const manager = new ContextSyncManager(f.home, runner, f.deps);
      const flight = manager.request(f.project, f.ref);
      // Observe both outcomes immediately, even if setup fails before the gate.
      void flight.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      let statusFlight: ReturnType<typeof manager.status> | undefined;
      try {
        await started;
        expect(importBlocked).toBe(true);
        readingStatus = true;
        const status = await Promise.race([
          (statusFlight = manager.status(f.project, f.ref)),
          // A finite deadlock guard, not a 300ms performance requirement for native Git.
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error("Status did not complete while import was blocked"),
                ),
              10000,
            );
          }),
        ]);
        expect(status.status).toBe("syncing");
        expect(importBlocked).toBe(true);
        expect(delayApplied).toBe(true);
      } finally {
        clearTimeout(timer);
        release();
        await Promise.all([flight, statusFlight]);
      }
    },
  );
  it("imports into a detached primary without changing its detached HEAD or files", async () => {
    const f = await fixture();
    await f.git(["checkout", "--detach"]);
    const before = await f.git(["rev-parse", "HEAD"]);
    const result = await f.manager.request(f.project, f.ref);
    expect(result.status).toBe("synced");
    expect(await f.git(["rev-parse", "HEAD"])).toBe(before);
    expect(await f.git(["branch", "--show-current"])).toBe("");
  });
  it("does not retarget a failed immutable retry when a duplicate completion arrives after later commits", async () => {
    const f = await fixture();
    let fail = true;
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        if (args[1].includes("fetch") && fail) throw new Error("offline");
        return f.runner.command(...args);
      },
    };
    const manager = new ContextSyncManager(f.home, runner, f.deps),
      failed = await manager.afterRun(f.project, f.ref, "run");
    await fs.writeFile(path.join(f.record.path, "later"), "later");
    await f.git(["add", "."], f.record.path);
    await f.git(["commit", "-m", "later"], f.record.path);
    await manager.afterRun(f.project, f.ref, "run");
    fail = false;
    const retried = await manager.retry(f.project, f.ref);
    expect(retried.status).toBe("new");
    expect(retried.importedOid).toBe(failed.sourceOid);
  });
});

describe("apply host lookup and merge identity", () => {
  it("looks up the durable token owner without accepting caller-controlled paths", async () => {
    const f = await fixture();
    await f.manager.request(f.project, f.ref);
    const preview = await f.manager.previewApply(f.project, f.ref);
    expect(
      await new ContextSyncManager(f.home, f.runner, f.deps).applyProjectId(
        preview.token,
      ),
    ).toBe(f.project.id);
    await expect(f.manager.applyProjectId(randomUUID())).rejects.toThrow(
      /предпросмотр|устар/i,
    );
  });
  it("uses normal Git identity from the isolated fixture HOME for an explicit non-fast-forward merge", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.home, ".gitconfig"),
      "[user]\n name = Desktop Fixture\n email = desktop-fixture@example.invalid\n",
    );
    await fs.writeFile(path.join(f.repo, "manual"), "manual");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "diverge"]);
    await f.manager.request(f.project, f.ref);
    const runner: Pick<Runner, "command"> = {
      command: async (exe, args, cwd, env, stdin) =>
        f.runner.command(
          exe,
          args,
          cwd,
          args.includes("merge")
            ? {
                ...env,
                GIT_AUTHOR_NAME: undefined,
                GIT_AUTHOR_EMAIL: undefined,
                GIT_COMMITTER_NAME: undefined,
                GIT_COMMITTER_EMAIL: undefined,
              }
            : env,
          stdin,
        ),
    };
    const manager = new ContextSyncManager(f.home, runner, f.deps),
      preview = await manager.previewApply(f.project, f.ref);
    const result = await manager.apply(f.project, {
      token: preview.token,
      confirmed: true,
    });
    expect(
      await f.git(["show", "--format=%ce", "--no-patch", result.targetOid]),
    ).toBe("desktop-fixture@example.invalid");
  });
});

describe("verification before marking synced", () => {
  it("keeps the import in error when the destination OID is not the immutable snapshot", async () => {
    const f = await fixture(),
      base = await f.git(["rev-parse", "HEAD"]);
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        const result = await f.runner.command(...args);
        if (args[1].includes("fetch")) {
          const spec = args[1].at(-1)!,
            ref = spec.slice(spec.indexOf(":") + 1);
          await f.git(["update-ref", ref, base]);
        }
        return result;
      },
    };
    const result = await new ContextSyncManager(f.home, runner, f.deps).request(
      f.project,
      f.ref,
    );
    expect(result.status).toBe("error");
    expect(result.importedOid).toBeUndefined();
    expect(result.error).toMatch(/OID/);
  });
  it("does not overwrite manual primary changes introduced concurrently with the import", async () => {
    const f = await fixture();
    const runner: Pick<Runner, "command"> = {
      command: async (...args) => {
        const result = await f.runner.command(...args);
        if (args[1].includes("fetch"))
          await fs.writeFile(
            path.join(f.repo, "base"),
            "external manual change\n",
          );
        return result;
      },
    };
    const result = await new ContextSyncManager(f.home, runner, f.deps).request(
      f.project,
      f.ref,
    );
    expect(result.status).toBe("error");
    expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
      "external manual change\n",
    );
    expect((await f.git(["show-ref"])).includes(result.destinationRef!)).toBe(
      true,
    );
  });
});

it("deduplicates an automatic run completion that originally needed no new import", async () => {
  const f = await fixture();
  const first = await f.manager.request(f.project, f.ref);
  await f.manager.afterRun(f.project, f.ref, "no-new-commits");
  await fs.writeFile(
    path.join(f.record.path, "later"),
    "outside completed run",
  );
  await f.git(["add", "."], f.record.path);
  await f.git(["commit", "-m", "later"], f.record.path);
  const result = await f.manager.afterRun(f.project, f.ref, "no-new-commits");
  expect(result.importedOid).toBe(first.importedOid);
  expect(result.status).toBe("new");
  expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
});

it("repairs an externally missing service ref with a new immutable ref rather than claiming it is synced", async () => {
  const f = await fixture(),
    first = await f.manager.request(f.project, f.ref);
  await f.git(["update-ref", "-d", first.destinationRef!]);
  expect((await f.manager.status(f.project, f.ref)).status).toBe("new");
  const repaired = await f.manager.request(f.project, f.ref);
  expect(repaired.status).toBe("synced");
  expect(repaired.importedOid).toBe(first.importedOid);
  expect(repaired.destinationRef).not.toBe(first.destinationRef);
});

it("supports explicit target branch names containing equals without applying configured squash options", async () => {
  const f = await fixture();
  await f.git(["checkout", "-b", "base=main"]);
  await f.git(["config", "branch.base=main.mergeOptions", "--squash"]);
  await fs.writeFile(path.join(f.repo, "manual"), "manual");
  await f.git(["add", "."]);
  await f.git(["commit", "-m", "diverge"]);
  await f.manager.request(f.project, f.ref);
  const preview = await f.manager.previewApply(f.project, f.ref);
  expect(preview.targetBranch).toBe("base=main");
  const result = await f.manager.apply(f.project, {
    token: preview.token,
    confirmed: true,
  });
  expect(
    (
      await f.git(["show", "--format=%P", "--no-patch", result.targetOid])
    ).split(" "),
  ).toHaveLength(2);
});
