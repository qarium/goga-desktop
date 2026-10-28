import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { verifiedNativeSequenceResult } from "../src/renderer/git-native-sequence-result";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { NativeGitSequence } from "../src/host/git-native-sequence";
import type { GitMergeContext } from "../src/host/git-merge-safety";
import type { ScopeRef } from "../src/shared/context";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture(
  kind: "primary" | "clone",
  op: "rebase" | "cherry-pick" | "revert",
  backend: "merge" | "apply" = "merge",
  external = false,
) {
  const base = await fs.mkdtemp("/private/tmp/goga-native-sequence-host-");
  cleanup.push(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    source = path.join(base, "source");
  await fs.mkdir(home);
  await fs.mkdir(source);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_ALLOW_PROTOCOL: "file",
  };
  let runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const gitAt = async (cwd: string, args: string[]) =>
    (
      await runner.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        cwd,
        env,
      )
    ).stdout.trim();
  await gitAt(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, "file"), "base\n");
  await gitAt(source, ["add", "."]);
  await gitAt(source, ["commit", "-m", "base"]);
  await gitAt(source, ["branch", "feature"]);
  const options = {
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent/disabled",
  };
  let host = new HostService(options);
  cleanup.push(() => host.dispose());
  const project = await host.addProject(source);
  const record =
    kind === "clone"
      ? await new CloneManager(home, runner).ensure(project, {
          projectId: project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : null;
  const root = record?.path ?? source,
    scope: ScopeRef = record ? worktreeContextRef(record) : project.id,
    branch = record?.branch ?? "main";
  const git = (a: string[]) => gitAt(root, a);
  await git(["checkout", "-b", "incoming"]);
  await fs.writeFile(path.join(root, "file"), "incoming\n");
  await git(["commit", "-am", "incoming"]);
  const incoming = await git(["rev-parse", "HEAD"]);
  await git(["checkout", branch]);
  if (op === "revert") await git(["merge", "--ff-only", "incoming"]);
  await fs.writeFile(path.join(root, "file"), "local\n");
  await git(["commit", "-am", "local"]);
  const original = await git(["rev-parse", "HEAD"]);
  const engine = () =>
    new NativeGitSequence({
      context: (s, fn) =>
        (
          host as unknown as {
            gitNativeSequenceContext<T>(
              s: ScopeRef,
              fn: (c: GitMergeContext) => Promise<T>,
            ): Promise<T>;
          }
        ).gitNativeSequenceContext(s, fn),
    });
  if (external)
    await expect(
      git([op, ...(op === "rebase" ? [`--${backend}`, incoming] : [incoming])]),
    ).rejects.toThrow();
  else {
    const e = engine();
    const p = await e.prepareStart(
      scope,
      op === "rebase"
        ? { operation: op, source: incoming, backend }
        : { operation: op, commits: [incoming] },
    );
    expect(await e.execute(p.token)).toMatchObject({
      outcome: "conflicts",
      processSettled: true,
    });
  }
  const prepare = async (action: "continue" | "abort") => {
    const revision = (await host.readGitWorkspace(scope)).revision;
    return op === "rebase"
      ? host.prepareGitRebaseOperation({ scope, action, revision })
      : host.prepareGitSequencerOperation({
          scope,
          action,
          revision,
          operation: op,
        });
  };
  const execute = (token: string) =>
    op === "rebase"
      ? host.executeGitRebaseOperation(token)
      : host.executeGitSequencerOperation(token);
  return {
    base,
    home,
    source,
    root,
    scope,
    record,
    project,
    runner,
    git,
    original,
    branch,
    prepare,
    execute,
    get host() {
      return host;
    },
    async restart() {
      await host.dispose();
      runner = new NodeRunner(10000, env);
      host = new HostService({ ...options, runner });
    },
  };
}
for (const kind of ["primary", "clone"] as const)
  for (const [op, backend] of [
    ["rebase", "merge"],
    ["rebase", "apply"],
    ["cherry-pick", "merge"],
    ["revert", "merge"],
  ] as const)
    for (const action of ["continue", "abort"] as const) {
      it(
        `native Host/API ${kind} ${op}/${backend} ${action} after restart`,
        async () => {
          const started = Date.now();
          const mark = (phase: string) => {
            if (process.env.GOGA_N7_TIMINGS)
              console.info(
                "N7 TIMING",
                kind,
                op,
                backend,
                action,
                phase,
                Date.now() - started,
              );
          };
          const f = await fixture(kind, op, backend);
          mark("fixture");
          await f.restart();
          mark("restart");
          if (action === "continue") {
            const revision = (await f.host.readGitWorkspace(f.scope)).revision;
            const conflict = await f.host.readGitConflict({
              scope: f.scope,
              revision,
              path: "file",
            });
            mark("read");
            const save = await f.host.prepareGitConflictSave({
              scope: f.scope,
              revision,
              path: "file",
              fingerprint: conflict.fingerprint,
              resolution: { kind: "text", text: "resolved\n" },
            });
            mark("prepare-save");
            expect(
              await f.host.executeGitConflictSave(save.token),
            ).toMatchObject({
              status: "saved",
              worktreePublished: true,
              indexPublished: true,
            });
          }
          mark("saved");
          const p = await f.prepare(action);
          mark("prepare-continue");
          expect(p).toMatchObject({
            root: f.root,
            scope: f.scope,
            branch: f.branch,
            original: f.original,
            hooks: "disabled",
          });
          const result = await f.execute(p.token);
          mark("complete");
          expect(result).toMatchObject({
            status: "success",
            native: {
              outcome: "completed",
              processSettled: true,
              verifiedUnrelatedData: true,
              recovery: "removed",
            },
          });
          expect(
            verifiedNativeSequenceResult(result, { ...p, operation: op }),
          ).toBe(true);
          expect(result).not.toHaveProperty("objectsPublished");
          expect((await f.host.readGitWorkspace(f.scope)).operation).toBe(
            "none",
          );
          expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
            f.branch,
          );
          if (action === "abort")
            expect(await f.git(["rev-parse", "HEAD"])).toBe(f.original);
          await expect(f.execute(p.token)).rejects.toThrow();
          // Includes a full read + preview + save + continuation roundtrip now.
          // Measured 13–14 s through saved, before continuation; individual process
          // deadlines remain unchanged. Only these two composed clone cases grow.
        },
        kind === "clone" && op === "rebase" && action === "continue"
          ? 30000
          : undefined,
      );
    }
it.each(["primary", "clone"] as const)(
  "external %s rebase remains readable but has no continuation authority",
  async (kind) => {
    const f = await fixture(kind, "rebase", "merge", true);
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
    await expect(f.prepare("abort")).rejects.toThrow(/журнал|происхождение/i);
  },
);
it("clone owner drift revokes a prepared native operation without fallback", async () => {
  const f = await fixture("clone", "rebase");
  const p = await f.prepare("abort");
  const settings = await f.host.readProjectSettings(f.project.id);
  await f.host.saveProjectSettings(
    f.project.id,
    {
      ...settings.value,
      env: [{ key: "CHANGED", value: "yes", secret: false, runtime: false }],
    },
    settings.version,
  );
  await expect(f.execute(p.token)).rejects.toThrow();
  expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
});
it("opaque rebase controls affect authority, not physical clone display admission", async () => {
  const f = await fixture("clone", "rebase");
  await fs.writeFile(
    path.join(f.root, ".git/rebase-merge/head-name"),
    "opaque-future-format\n",
  );
  expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
  await expect(f.prepare("abort")).rejects.toThrow(/журнал|происхождение/i);
});
it("lifecycle cleanup failure preserves completed native facts but not a success claim", async () => {
  const f = await fixture("clone", "rebase");
  const p = await f.prepare("abort");
  const { vi } = await import("vitest"),
    locks = await import("../src/host/owned-lock");
  const acquire = locks.acquireOwnedLock;
  const spy = vi
    .spyOn(locks, "acquireOwnedLock")
    .mockImplementation(async (file, options) => {
      const lock = await acquire(file, options);
      return {
        ...lock,
        release: async () => {
          await lock.release();
          if (file.includes(".repository-"))
            throw Error("fixture cleanup failure");
        },
      };
    });
  try {
    const r = await f.execute(p.token);
    expect(r).toMatchObject({
      status: "uncertain",
      native: { processSettled: true, afterHead: f.original },
    });
    expect(r.log).toContain("fixture cleanup failure");
  } finally {
    spy.mockRestore();
  }
});
it("a coherent clone credential replacement cannot reuse native provenance", async () => {
  const f = await fixture("clone", "rebase");
  const p = await f.prepare("abort");
  const manager = new CloneManager(f.home, f.runner);
  const ownerFile = path.join(
    manager.store.root,
    `.owner-${f.record!.contextId}.json`,
  );
  const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
  const { randomUUID } = await import("node:crypto");
  const nonce = randomUUID();
  await fs.writeFile(ownerFile, JSON.stringify({ ...owner, nonce }));
  await fs.writeFile(
    path.join(f.root, ".git/desktop-owner.json"),
    JSON.stringify({ contextId: f.record!.contextId, nonce }),
  );
  await expect(f.execute(p.token)).rejects.toThrow();
  expect(await f.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
});
it("replacement of the physical source Git directory revokes clone provenance", async () => {
  const f = await fixture("clone", "rebase");
  const p = await f.prepare("abort");
  const gd = path.join(f.source, ".git"),
    saved = path.join(f.base, "saved-source-git");
  await fs.rename(gd, saved);
  await fs.cp(saved, gd, { recursive: true });
  await expect(f.execute(p.token)).rejects.toThrow();
  expect(await f.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
});
it("ordinary clone resolution during a stopped native rebase does not rewrite its durable owner", async () => {
  const f = await fixture("clone", "rebase");
  const manager = new CloneManager(f.home, f.runner);
  const before = await manager.store.read();
  await expect(
    manager.resolve(f.scope as Exclude<ScopeRef, string>),
  ).rejects.toThrow();
  expect(await manager.store.read()).toEqual(before);
  const p = await f.prepare("abort");
  expect(await f.execute(p.token)).toMatchObject({ status: "success" });
});
