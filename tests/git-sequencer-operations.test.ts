import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { readdirSync, writeFileSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import {
  createOperationFixture,
  type OperationFixture,
} from "./helpers/git-operation-fixtures";
import { NodeRunner, CommandExitError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { GitSequencerOperations } from "../src/host/git-sequencer-operations";
const fixtures: OperationFixture[] = [],
  runners: NodeRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
  for (const f of fixtures.splice(0)) await f.dispose();
});
async function create(
  operation: "cherry-pick" | "revert",
  commits = 3,
  conflictAt = [1, 3],
) {
  const f = await createOperationFixture(operation, { commits, conflictAt });
  fixtures.push(f);
  return f;
}
async function fixture(
  operation: "cherry-pick" | "revert",
  commits = 3,
  conflictAt = [1, 3],
) {
  const f = await create(operation, commits, conflictAt),
    env: NodeJS.ProcessEnv = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = new NodeRunner(10000, env);
  runners.push(runner);
  const git = (a: string[]) => runner.command("git", a, f.root, env);
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "project",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  let owner = "fixture",
    now = Date.now(),
    beforeNative: (() => void) | undefined,
    afterNative: (() => void) | undefined,
    afterPublish: ((step: string) => void) | undefined,
    releaseFault: ((n: string, phase: string) => void) | undefined;
  const context = {
    root: f.root,
    scope: "project",
    get ownerKey() {
      return owner;
    },
    verify: async () => {},
    verifyOwner: async () => {},
    snapshot: () => reader.snapshot(),
    git,
    isolatedGit: git,
  };
  const engine = new GitSequencerOperations({
    context: async (_scope, fn) => fn(context),
    now: () => now,
    beforeNative: () => beforeNative?.(),
    afterNative: () => afterNative?.(),
    afterPublish: (s) => afterPublish?.(s),
    releaseLockFault: (n, p) => releaseFault?.(n, p),
  });
  const prepare = async (action: "abort" | "continue") =>
    engine.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      operation,
      action,
    });
  return {
    ...f,
    reader,
    context,
    engine,
    prepare,
    setOwner: (v: string) => {
      owner = v;
    },
    expire: () => {
      now += 600000;
    },
    before: (fn: () => void) => {
      beforeNative = fn;
    },
    after: (fn: () => void) => {
      afterNative = fn;
    },
    publication: (fn: (step: string) => void) => {
      afterPublish = fn;
    },
    release: (fn: (n: string, p: string) => void) => {
      releaseFault = fn;
    },
  };
}
async function stable(f: OperationFixture) {
  return {
    head: await f.read(".git/HEAD"),
    refs: await f.git(["show-ref"]),
    index: await fs.readFile(path.join(f.root, ".git/index")),
    files: await Promise.all(
      ["file-1", "untouched", "untracked", "ignored"].map((n) => f.read(n)),
    ),
  };
}
for (const op of ["cherry-pick", "revert"] as const) {
  it.each([1, 3])(
    `${op}: abort restores native original tree and branch, preserves unrelated files (%i)`,
    async (count) => {
      const f = await fixture(op, count, count === 1 ? [1] : [1, 3]),
        control = await create(op, count, count === 1 ? [1] : [1, 3]);
      await f.resolve();
      await control.resolve();
      const preview = await f.prepare("abort");
      expect(preview.operation).toBe(op);
      expect(preview.discardedResolutionPaths.length).toBe(1);
      const result = await f.engine.execute(preview.token);
      expect(result.status, result.log).toBe("success");
      expect(result.metadataCleared).toBe(true);
      expect(result.retainedLocks).toEqual([]);
      await control.git([op, "--abort"]);
      expect(await f.git(["rev-parse", "HEAD"])).toBe(
        await control.git(["rev-parse", "HEAD"]),
      );
      expect(await f.git(["ls-files", "--stage"])).toBe(
        await control.git(["ls-files", "--stage"]),
      );
      expect(await f.git(["diff", "HEAD"])).toBe("");
      expect(await f.read("ignored")).toBe("preserve ignored\n");
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      expect(result.recoveryStatus).toBe("retained");
      await expect(f.engine.execute(preview.token)).rejects.toThrow();
    },
  );
  it.each([
    [1, [1]],
    [3, [1]],
    [3, [1, 3]],
  ] as [number, number[]][])(
    `${op}: continuation matches native commits/trees and next conflicts (%i, %j)`,
    async (count, stops) => {
      const f = await fixture(op, count, stops),
        control = await create(op, count, stops);
      for (let i = 0; i < stops.length; i++) {
        await f.resolve();
        await control.resolve();
        const p = await f.prepare("continue");
        expect(p.requiresCommitWarning).toBe(op === "revert" && count === 1);
        const r = await f.engine.execute(p.token);
        let conflict = false;
        try {
          await control.git([op, "--continue"]);
        } catch (e) {
          expect(e).toBeInstanceOf(CommandExitError);
          conflict = true;
        }
        expect(r.status, r.log).toBe(conflict ? "conflict" : "success");
        expect(r.retainedLocks).toEqual([]);
        expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
          await control.git(["rev-parse", "HEAD^{tree}"]),
        );
        expect(await f.git(["ls-files", "--stage"])).toBe(
          await control.git(["ls-files", "--stage"]),
        );
        expect(
          await f.git(["log", `${f.original}..HEAD`, "--format=%an <%ae>%n%B"]),
        ).toBe(
          await control.git([
            "log",
            `${control.original}..HEAD`,
            "--format=%an <%ae>%n%B",
          ]),
        );
      }
      expect((await f.reader.snapshot()).operation).toBe("none");
      expect(await f.read("untracked")).toBe("preserve untracked\n");
    },
  );
  it.each(["owner", "head", "todo", "index", "expired"])(
    `${op}: stale/expired token refuses before native (%s)`,
    async (kind) => {
      const f = await fixture(op);
      await f.resolve();
      const p = await f.prepare("continue");
      if (kind === "owner") f.setOwner("foreign");
      if (kind === "head")
        await f.write(".git/HEAD", "ref: refs/heads/unknown\n");
      if (kind === "todo")
        await f.write(".git/sequencer/todo", "exec unsafe\n");
      if (kind === "index") {
        await f.write("untouched", "other\n");
        await f.git(["add", "untouched"]);
      }
      if (kind === "expired") f.expire();
      let called = false;
      f.before(() => {
        called = true;
      });
      await expect(f.engine.execute(p.token)).rejects.toThrow();
      expect(called).toBe(false);
    },
  );
  it(`${op}: before-native race does not change worktree/index/refs`, async () => {
    const f = await fixture(op);
    await f.resolve();
    const p = await f.prepare("continue");
    f.before(() => writeFileSync(path.join(f.root, "untouched"), "external\n"));
    const old = await stable(f);
    const result = await f.engine.execute(p.token);
    expect(result.status).toBe("error");
    expect(result.mutationStarted).toBe(false);
    const actual = await stable(f);
    expect(actual.index).toEqual(old.index);
    expect(actual.refs).toEqual(old.refs);
    expect(actual.files[1]).toBe("external\n");
  });
  it(`${op}: forged native candidate cannot publish index or branch`, async () => {
    const f = await fixture(op);
    await f.resolve();
    const p = await f.prepare("continue"),
      old = await stable(f);
    f.after(() => {
      const dir = readdirSync(path.join(f.root, ".git")).find((n) =>
        n.startsWith("goga-sequencer-"),
      )!;
      writeFileSync(
        path.join(f.root, ".git", dir, "native", "REVERT_HEAD"),
        "a".repeat(40) + "\n",
      );
    });
    const result = await f.engine.execute(p.token);
    expect(result.status).toBe("uncertain");
    expect(result.indexPublished).toBe(false);
    expect(result.branchPublished).toBe(false);
    expect(result.lockRetained).toBe(true);
    expect((await stable(f)).refs).toBe(old.refs);
  });
}

for (const op of ["cherry-pick", "revert"] as const) {
  it.each(["config", "alternate", "owner-ref", "message", "stopped-marker"])(
    `${op}: rejects forged candidate authority (%s) before publication`,
    async (kind) => {
      const f = await fixture(op);
      await f.resolve();
      const p = await f.prepare("continue");
      f.after(() => {
        const dir = readdirSync(path.join(f.root, ".git")).find((n) =>
            n.startsWith("goga-sequencer-"),
          )!,
          base = path.join(f.root, ".git", dir, "native");
        if (kind === "config")
          writeFileSync(
            path.join(base, "config"),
            "[core]\nrepositoryformatversion=0\n[include]\npath=/nonexistent/foreign\n",
          );
        if (kind === "alternate")
          writeFileSync(
            path.join(base, "objects/info/alternates"),
            "/nonexistent/foreign\n",
          );
        if (kind === "owner-ref")
          writeFileSync(
            path.join(base, "refs/heads", f.branch),
            f.sources[0] + "\n",
          );
        if (kind === "message")
          writeFileSync(path.join(base, "MERGE_MSG"), "unconfirmed\n");
        if (kind === "stopped-marker")
          writeFileSync(
            path.join(
              base,
              op === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD",
            ),
            f.sources[0] + "\n",
          );
      });
      const r = await f.engine.execute(p.token);
      expect(r.status, r.log).toBe("uncertain");
      expect(r.indexPublished).toBe(false);
      expect(r.branchPublished).toBe(false);
      expect(r.publishedObjectCount).toBe(0);
    },
  );
  it.each(["index", "branch", "metadata"])(
    `${op}: reports partial publication and retains recovery (%s)`,
    async (step) => {
      const f = await fixture(op);
      await f.resolve();
      const p = await f.prepare("continue");
      f.publication((s) => {
        if (s === step) throw Error("fixture publication failure");
      });
      const r = await f.engine.execute(p.token);
      expect(r.status).toBe("uncertain");
      expect(r.recoveryStatus).toBe("retained");
      expect(r.lockRetained).toBe(true);
      expect(r.indexPublished).toBe(true);
      expect(r.branchPublished).toBe(step !== "index");
      await expect(f.engine.execute(p.token)).rejects.toThrow();
    },
  );
  it(`${op}: native cancellation cannot become a verified conflict`, async () => {
    const f = await fixture(op);
    await f.resolve();
    const p = await f.prepare("continue"),
      original = f.context.isolatedGit;
    f.context.isolatedGit = async (a) => {
      if (a.includes(op) && a.includes("--continue")) {
        try {
          await original(a);
        } catch {
          /* Lose even a conflict response. */
        }
        throw Error("lost native response");
      }
      return original(a);
    };
    const r = await f.engine.execute(p.token);
    expect(r.status).toBe("uncertain");
    expect(r.indexPublished).toBe(false);
    expect(r.lockRetained).toBe(true);
  });
  it(`${op}: abort at the second conflict retains the original baseline`, async () => {
    const f = await fixture(op);
    await f.resolve();
    const first = await f.engine.execute((await f.prepare("continue")).token);
    expect(first.status, first.log).toBe("conflict");
    await f.resolve();
    const p = await f.prepare("abort");
    expect(p.original).toBe(f.original);
    const r = await f.engine.execute(p.token);
    expect(r.status, r.log).toBe("success");
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    expect(await f.git(["diff", "HEAD"])).toBe("");
  });
}
it.each(["cherry-pick", "revert"] as const)(
  "%s: abort needs neither commit identity nor signing",
  async (op) => {
    const f = await fixture(op);
    await f.git(["config", "--unset", "user.name"]);
    await f.git(["config", "--unset", "user.email"]);
    await f.git(["config", "commit.gpgsign", "true"]);
    const p = await f.prepare("abort");
    const r = await f.engine.execute(p.token);
    expect(r.status, r.log).toBe("success");
  },
);
it("revert: does not silently replace configured reference messages", async () => {
  const f = await fixture("revert");
  await f.resolve();
  await f.git(["config", "revert.reference", "true"]);
  await expect(f.prepare("continue")).rejects.toThrow();
});
it("recovery parent alias never qualifies as verified retained backup", async () => {
  const f = await fixture("cherry-pick");
  await f.resolve();
  const p = await f.prepare("continue");
  f.after(() => {
    const dir = readdirSync(path.join(f.root, ".git")).find((n) =>
        n.startsWith("goga-sequencer-"),
      )!,
      recovery = path.join(f.root, ".git", dir);
    renameSync(
      path.join(recovery, "backup"),
      path.join(recovery, "backup-old"),
    );
    symlinkSync(
      path.join(recovery, "backup-old"),
      path.join(recovery, "backup"),
    );
  });
  const r = await f.engine.execute(p.token);
  expect(r.status).toBe("uncertain");
  expect(r.recoveryStatus).toBe("unverified");
  expect(r.recoveryPath).toBeUndefined();
  expect(r.indexPublished).toBe(false);
});
it("backup corruption after native prevents every live publication", async () => {
  const f = await fixture("cherry-pick");
  await f.resolve();
  const p = await f.prepare("continue");
  f.after(() => {
    const dir = readdirSync(path.join(f.root, ".git")).find((n) =>
      n.startsWith("goga-sequencer-"),
    )!;
    writeFileSync(
      path.join(f.root, ".git", dir, "backup", "index"),
      "corrupted backup",
    );
  });
  const r = await f.engine.execute(p.token);
  expect(r.status).toBe("uncertain");
  expect(r.indexPublished).toBe(false);
  expect(r.branchPublished).toBe(false);
  expect(r.publishedObjectCount).toBe(0);
  expect(r.recoveryStatus).toBe("unverified");
});
it.each(["cherry-pick", "revert"] as const)(
  "%s: repeated edits of one multiline file match native continuation",
  async (op) => {
    const f = await fixture(op),
      control = await create(op, 3, [1, 3]);
    const seed = async (x: OperationFixture) => {
      await x.git([op, "--abort"]);
      const lines = Array.from({ length: 180 }, (_, i) => `line ${i}`);
      await x.write("file-1", lines.join("\n") + "\n");
      await x.git(["commit", "-am", "multiline base"]);
      const branch = (await x.git(["symbolic-ref", "--short", "HEAD"])).trim();
      await x.git(["checkout", "-b", "multiline-source"]);
      const sources: string[] = [];
      for (const i of [5, 70, 140]) {
        lines[i] = "incoming " + i;
        await x.write("file-1", lines.join("\n") + "\n");
        await x.git(["commit", "-am", "change " + i]);
        sources.push((await x.git(["rev-parse", "HEAD"])).trim());
      }
      await x.git(["checkout", branch]);
      if (op === "revert")
        await x.git(["merge", "--ff-only", "multiline-source"]);
      else for (const i of [5, 70, 140]) lines[i] = "line " + i;
      const conflict = op === "revert" ? 140 : 5;
      lines[conflict] = "local";
      await x.write("file-1", lines.join("\n") + "\n");
      await x.git(["commit", "-am", "multiline local"]);
      await expect(
        x.git([op, ...(op === "revert" ? [...sources].reverse() : sources)]),
      ).rejects.toBeInstanceOf(CommandExitError);
      lines[conflict] = "resolved";
      await x.write("file-1", lines.join("\n") + "\n");
      await x.git(["add", "file-1"]);
    };
    await seed(f);
    await seed(control);
    const p = await f.prepare("continue"),
      r = await f.engine.execute(p.token);
    expect(r.status, r.log).toBe("success");
    await control.git([op, "--continue"]);
    expect(await f.read("file-1")).toBe(await control.read("file-1"));
    expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await control.git(["rev-parse", "HEAD^{tree}"]),
    );
  },
);
it("single revert originally started with --no-commit creates the explicitly confirmed commit", async () => {
  const f = await fixture("revert", 1, [1]);
  await f.git(["revert", "--abort"]);
  await expect(
    f.git(["revert", "--no-commit", ...f.sources]),
  ).rejects.toBeInstanceOf(CommandExitError);
  await f.resolve();
  const p = await f.prepare("continue");
  expect(p.requiresCommitWarning).toBe(true);
  const r = await f.engine.execute(p.token);
  expect(r.status, r.log).toBe("success");
  expect(
    (await f.git(["rev-list", "--count", `${f.original}..HEAD`])).trim(),
  ).toBe("1");
});
