import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createOperationFixture,
  type OperationFixture,
} from "./helpers/git-operation-fixtures";
import { NodeRunner, CommandExitError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import {
  captureSequencer,
  sequencerStateKey,
} from "../src/host/git-sequencer-state";
import {
  gitSequencerOperationRequestSchema,
  gitSequencerOperationTokenSchema,
} from "../src/shared/git-sequencer-operations";
const fixtures: OperationFixture[] = [],
  runners: NodeRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
  for (const f of fixtures.splice(0)) await f.dispose();
});
async function fixture(operation: "cherry-pick" | "revert", commits = 3) {
  const f = await createOperationFixture(operation, {
    commits,
    conflictAt: commits === 1 ? [1] : [1, 3],
  });
  fixtures.push(f);
  const env: NodeJS.ProcessEnv = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = new NodeRunner(10000, env);
  runners.push(runner);
  const commands: string[][] = [];
  const git = async (a: string[]) => {
    commands.push(a);
    return runner.command("git", a, f.root, env);
  };
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "project",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  let owner = "owner",
    verifyFault: (() => Promise<void>) | undefined;
  const context = {
    root: f.root,
    scope: "project",
    get ownerKey() {
      return owner;
    },
    verify: async () => {
      await verifyFault?.();
    },
    verifyOwner: async () => {},
    snapshot: () => reader.snapshot(),
    git,
    isolatedGit: git,
  };
  const capture = async (action: "continue" | "abort" = "abort") =>
    captureSequencer(context, {
      scope: "project",
      revision: (await reader.snapshot()).revision,
      operation,
      action,
    });
  return {
    ...f,
    operation,
    context,
    reader,
    capture,
    commands,
    setOwner: (v: string) => {
      owner = v;
    },
    setVerify: (fn: () => Promise<void>) => {
      verifyFault = fn;
    },
  };
}
async function disk(f: OperationFixture) {
  const walk = async (dir: string): Promise<unknown[]> =>
    Promise.all(
      (await fs.readdir(dir)).sort().map(async (n) => {
        const p = path.join(dir, n),
          s = await fs.lstat(p);
        return [
          n,
          s.isDirectory()
            ? await walk(p)
            : s.isSymbolicLink()
              ? await fs.readlink(p)
              : (await fs.readFile(p)).toString("base64"),
        ];
      }),
    );
  return walk(f.root);
}
it("uses a strict operation-specific request and token contract", () => {
  const v = {
    scope: "project",
    revision: "a".repeat(64),
    operation: "revert",
    action: "continue",
  };
  expect(gitSequencerOperationRequestSchema.parse(v)).toEqual(v);
  for (const extra of [
    { root: "/tmp/other" },
    { gitDir: "/tmp/other" },
    { command: "reset" },
    { skip: true },
    { operation: "merge" },
    { action: "skip" },
    { revision: "bad" },
  ])
    expect(
      gitSequencerOperationRequestSchema.safeParse({ ...v, ...extra }).success,
    ).toBe(false);
  expect(
    gitSequencerOperationTokenSchema.safeParse("b".repeat(64)).success,
  ).toBe(true);
  expect(
    gitSequencerOperationTokenSchema.safeParse({
      token: "b".repeat(64),
      force: true,
    }).success,
  ).toBe(false);
});
for (const operation of ["cherry-pick", "revert"] as const) {
  it.each([1, 3])(
    `${operation}: captures native baseline, type, todo and conflict paths read-only (%i)`,
    async (commits) => {
      const f = await fixture(operation, commits),
        before = await disk(f),
        s = await f.capture();
      expect(s.operation).toBe(operation);
      expect(s.original).toBe(f.original);
      expect(s.head).toBe(f.original);
      expect(s.branch).toBe(f.branch);
      expect(s.current.oid).toBe(f.sources[0]);
      expect(s.remaining.map((x) => x.oid)).toEqual(f.sources.slice(1));
      expect(s.conflictPaths).toEqual([
        operation === "revert" ? `file-${commits}` : "file-1",
      ]);
      expect(s.requiresCommitWarning).toBe(
        operation === "revert" && commits === 1,
      );
      expect(await disk(f)).toEqual(before);
    },
  );
  it(`${operation}: continue requires resolved staging, abort admits manual and staged solutions`, async () => {
    const f = await fixture(operation),
      names = await f.conflicts();
    await expect(f.capture("continue")).rejects.toThrow(/конфликт/i);
    await f.write(names[0], "manual solution\n");
    expect((await f.capture()).discardedResolutionPaths).toEqual(names);
    await f.resolve();
    const s = await f.capture("continue");
    expect(s.discardedResolutionPaths).toEqual(names);
    expect(s.resolved[names[0]]).toBeDefined();
  });
  it(`${operation}: second conflict keeps sequence baseline instead of current HEAD or ORIG_HEAD`, async () => {
    const f = await fixture(operation);
    await f.resolve();
    await expect(f.git([operation, "--continue"])).rejects.toBeInstanceOf(
      CommandExitError,
    );
    await f.write(".git/ORIG_HEAD", f.sources[0] + "\n");
    const s = await f.capture();
    expect(s.original).toBe(f.original);
    expect(s.head).not.toBe(f.original);
    expect(s.current.oid).toBe(f.sources[2]);
    expect(s.remaining).toEqual([]);
    expect(s.completed.map((x) => x.parent)).toEqual([
      f.original,
      s.completed[0].oid,
    ]);
  });
  it.each([
    "wrong-type",
    "mixed-marker",
    "missing-marker",
    "missing-auto",
    "missing-message",
    "foreign-operation",
    "todo-type",
    "todo-source",
    "todo-command",
    "head",
    "abort-safety",
    "opts",
    "unknown-file",
    "symlink",
    "hardlink",
  ])(
    `${operation}: refuses invalid operation metadata (%s) before writing`,
    async (variant) => {
      const f = await fixture(operation);
      const marker =
        operation === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD";
      let expected = operation;
      if (variant === "wrong-type")
        expected = operation === "revert" ? "cherry-pick" : "revert";
      if (variant === "mixed-marker")
        await f.write(
          ".git/" +
            (operation === "revert" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD"),
          f.sources[0] + "\n",
        );
      if (variant === "missing-marker")
        await fs.unlink(path.join(f.root, ".git", marker));
      if (variant === "missing-auto")
        await fs.unlink(path.join(f.root, ".git/AUTO_MERGE"));
      if (variant === "missing-message")
        await fs.unlink(path.join(f.root, ".git/MERGE_MSG"));
      if (variant === "foreign-operation")
        await fs.mkdir(path.join(f.root, ".git/rebase-merge"));
      if (variant === "todo-type")
        await f.write(
          ".git/sequencer/todo",
          (await f.read(".git/sequencer/todo")).replace(
            /^(pick|revert)/,
            operation === "revert" ? "pick" : "revert",
          ),
        );
      if (variant === "todo-source")
        await f.write(
          ".git/sequencer/todo",
          (await f.read(".git/sequencer/todo")).replace(
            f.sources[0].slice(0, 7),
            f.sources[1],
          ),
        );
      if (variant === "todo-command")
        await f.write(".git/sequencer/todo", "exec echo unsafe\n");
      if (variant === "head")
        await f.write(".git/sequencer/head", f.sources[0] + "\n");
      if (variant === "abort-safety")
        await f.write(".git/sequencer/abort-safety", f.sources[0] + "\n");
      if (variant === "opts")
        await f.write(".git/sequencer/opts", "[options]\n\tno-commit = true\n");
      if (variant === "unknown-file")
        await f.write(".git/sequencer/unsafe", "unexpected");
      if (variant === "symlink") {
        await fs.unlink(path.join(f.root, ".git", marker));
        await fs.symlink(
          path.join(f.root, ".git/sequencer/head"),
          path.join(f.root, ".git", marker),
        );
      }
      if (variant === "hardlink") {
        await fs.unlink(path.join(f.root, ".git", marker));
        await fs.link(
          path.join(f.root, ".git/sequencer/head"),
          path.join(f.root, ".git", marker),
        );
      }
      const before = await disk(f);
      await expect(
        captureSequencer(f.context, {
          scope: "project",
          revision: await f.reader.snapshot().then(
            (s) => s.revision,
            (error) => {
              if (variant !== "symlink") throw error;
              return "a".repeat(64);
            },
          ),
          operation: expected,
          action: "abort",
        }),
      ).rejects.toThrow();
      expect(await disk(f)).toEqual(before);
    },
  );
  it.each(["staged", "unstaged", "mode"])(
    `${operation}: rejects unrelated tracked edits (%s)`,
    async (variant) => {
      const f = await fixture(operation);
      await f.write("untouched", "foreign\n");
      if (variant === "staged") await f.git(["add", "untouched"]);
      if (variant === "mode")
        await fs.chmod(path.join(f.root, "untouched"), 0o755);
      const before = await disk(f);
      await expect(f.capture()).rejects.toThrow();
      expect(await disk(f)).toEqual(before);
    },
  );
  it(`${operation}: changed revision, owner and source inputs cannot reuse the same state key`, async () => {
    const f = await fixture(operation),
      revision = (await f.reader.snapshot()).revision,
      s = await f.capture();
    f.setOwner("changed");
    expect(sequencerStateKey(await f.capture())).not.toBe(sequencerStateKey(s));
    await f.write("untracked", "new\n");
    await expect(
      captureSequencer(f.context, {
        scope: "project",
        revision,
        operation,
        action: "abort",
      }),
    ).rejects.toThrow();
  });
}

it("single revert --no-commit is indistinguishable and must carry the explicit commit warning", async () => {
  const f = await fixture("revert", 1);
  await f.git(["revert", "--abort"]);
  await expect(
    f.git(["revert", "--no-commit", ...f.sources]),
  ).rejects.toBeInstanceOf(CommandExitError);
  await f.resolve();
  const before = await disk(f),
    s = await f.capture("continue");
  expect(s.requiresCommitWarning).toBe(true);
  expect(s.original).toBe(f.original);
  expect(await disk(f)).toEqual(before);
});
it.each(["cherry-pick", "revert"] as const)(
  "%s: refuses a sequencer explicitly configured with --no-commit",
  async (operation) => {
    const f = await fixture(operation);
    await f.git([operation, "--abort"]);
    await expect(
      f.git([operation, "--no-commit", ...f.sources]),
    ).rejects.toBeInstanceOf(CommandExitError);
    const before = await disk(f);
    await expect(f.capture()).rejects.toThrow();
    expect(await disk(f)).toEqual(before);
  },
);
it("single cherry-pick --no-commit has no stopped-commit authority", async () => {
  const f = await fixture("cherry-pick", 1);
  await f.git(["cherry-pick", "--abort"]);
  await expect(
    f.git(["cherry-pick", "--no-commit", ...f.sources]),
  ).rejects.toBeInstanceOf(CommandExitError);
  await expect(f.capture()).rejects.toThrow();
});
for (const operation of ["cherry-pick", "revert"] as const) {
  it.each([
    "wrong-auto",
    "message",
    "unstaged-solution",
    "solution-mode",
    "foreign-stages",
    "empty",
    "owner-race",
    "scope-race",
    "head-race",
    "todo-race",
  ])(
    `${operation}: rejects content or ownership mismatch (%s) without writing`,
    async (variant) => {
      const f = await fixture(operation),
        names = await f.resolve();
      if (variant === "wrong-auto")
        await f.write(
          ".git/AUTO_MERGE",
          await f.git(["rev-parse", "HEAD^{tree}"]),
        );
      if (variant === "message")
        await f.write(".git/MERGE_MSG", "arbitrary message\n");
      if (variant === "unstaged-solution")
        await f.write(names[0], "new unstaged solution\n");
      if (variant === "solution-mode") {
        await fs.chmod(path.join(f.root, names[0]), 0o755);
        await f.git(["add", "--", names[0]]);
      }
      if (variant === "foreign-stages") {
        await f.write("untouched", "foreign staged\n");
        await f.git(["add", "untouched"]);
      }
      if (variant === "empty") {
        await f.write(names[0], await f.git(["show", `HEAD:${names[0]}`]));
        await f.git(["add", "--", names[0]]);
      }
      let changed = false;
      f.setVerify(async () => {
        if (changed) return;
        changed = true;
        // The first verification precedes capture; mutate only during its final check.
        f.setVerify(async () => {
          if (variant === "owner-race") f.setOwner("different");
          if (variant === "scope-race") f.context.scope = "different";
          if (variant === "head-race")
            await f.write(".git/HEAD", "ref: refs/heads/other\n");
          if (variant === "todo-race")
            await f.write(".git/sequencer/todo", "exec unexpected\n");
        });
      });
      const before = await disk(f);
      await expect(f.capture("continue")).rejects.toThrow();
      if (!variant.endsWith("-race")) expect(await disk(f)).toEqual(before);
    },
  );
  it(`${operation}: command cancellation during proof is not a conflict`, async () => {
    const f = await fixture(operation),
      before = await disk(f),
      cancel = Error("cancelled"),
      original = f.context.isolatedGit;
    f.context.isolatedGit = async (a) => {
      if (a.includes("merge-file")) throw cancel;
      return original(a);
    };
    await expect(f.capture()).rejects.toBe(cancel);
    expect(await disk(f)).toEqual(before);
  });
  it(`${operation}: conflict marker tree cannot hide the wrong forward/inverse source`, async () => {
    const f = await fixture(operation);
    const wrong = await f.git(["rev-parse", `${f.sources[0]}^{tree}`]);
    await f.write(".git/AUTO_MERGE", wrong);
    const before = await disk(f);
    await expect(f.capture()).rejects.toThrow();
    expect(await disk(f)).toEqual(before);
  });
}
