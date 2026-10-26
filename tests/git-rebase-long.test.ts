import { afterEach, expect, it } from "vitest";
import {
  createOperationFixture,
  type OperationFixture,
} from "./helpers/git-operation-fixtures";
import { GitRebaseOperations } from "../src/host/git-rebase-operations";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { NodeRunner } from "../src/host/process";
import * as fs from "node:fs/promises";
import path from "node:path";

const fixtures: OperationFixture[] = [];
const runners: NodeRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
  for (const f of fixtures.splice(0)) await f.dispose();
});
async function fixture(conflictAt = [1, 3]) {
  const f = await createOperationFixture("merge-rebase", {
    commits: 4,
    conflictAt,
  });
  fixtures.push(f);
  const env = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = new NodeRunner(10000, env);
  runners.push(runner);
  const git = (args: string[]) => runner.command("git", args, f.root, env);
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "project",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  const engine = new GitRebaseOperations({
    context: async (_scope, fn) =>
      fn({
        root: f.root,
        scope: "project",
        ownerKey: f.root,
        verify: async () => {},
        verifyOwner: async () => {},
        snapshot: () => reader.snapshot(),
        git,
        isolatedGit: git,
      }),
  });
  const prepare = async (action: "continue" | "abort") =>
    engine.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      action,
    });
  return { ...f, engine, prepare, reader };
}
it.each([
  { stops: [1] },
  { stops: [1, 3] },
  { stops: [1, 2, 4] },
  { stops: [4] },
])(
  "continues four linear picks with stops at $stops until exact native-control result",
  async ({ stops }) => {
    const f = await fixture(stops);
    const control = await createOperationFixture("merge-rebase", {
      commits: 4,
      conflictAt: stops,
    });
    fixtures.push(control);
    let count = 0;
    while ((await f.conflicts()).length) {
      await f.resolve();
      await control.resolve();
      const p = await f.prepare("continue");
      expect(p.effects).not.toContain("один оставшийся");
      const r = await f.engine.execute(p.token);
      count++;
      expect(r, r.log).toMatchObject({
        status: count < stops.length ? "conflict" : "success",
        lockRetained: false,
        indexPublished: true,
        headPublished: true,
        objectsPublished: true,
      });
      try {
        await control.git(["rebase", "--continue"]);
      } catch (e) {
        expect(e).toMatchObject({ exitCode: 1 });
        expect(r.status).toBe("conflict");
      }
      expect(await f.git(["ls-files", "--stage", "-z"])).toBe(
        await control.git(["ls-files", "--stage", "-z"]),
      );
      expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
        await control.git(["rev-parse", "HEAD^{tree}"]),
      );
      const fields = [
        "log",
        "--reverse",
        "--format=%an <%ae>%n%aI%n%B",
        `${f.onto}..HEAD`,
      ];
      expect(await f.git(fields)).toBe(await control.git(fields));
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      expect(await f.read("ignored")).toBe("preserve ignored\n");
      expect(count).toBeLessThanOrEqual(stops.length);
    }
    expect(count).toBe(stops.length);
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(
      (await f.git(["rev-list", "--count", `${f.onto}..HEAD`])).trim(),
    ).toBe("4");
  },
);
it.each([false, true])(
  "aborts a long rebase after manual conflict resolution (staged=%s)",
  async (staged) => {
    const f = await fixture();
    if (staged) await f.resolve();
    else await f.write("file-1", "manual resolution\n");
    const p = await f.prepare("abort");
    expect(p.effects).toMatch(/решени/i);
    expect(p.discardedResolutionPaths).toEqual(["file-1"]);
    const r = await f.engine.execute(p.token);
    expect(r, r.log).toMatchObject({
      status: "success",
      lockRetained: false,
      worktreeRestored: true,
      metadataCleared: true,
    });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    expect(await f.git(["diff", "HEAD"])).toBe("");
    expect(await f.read("untracked")).toBe("preserve untracked\n");
  },
);
it("rejects changed abort input without overwriting a late unrelated edit", async () => {
  const f = await fixture();
  await f.resolve();
  const p = await f.prepare("abort");
  await f.write("untouched", "late external edit\n");
  await expect(f.engine.execute(p.token)).rejects.toThrow();
  expect(await f.read("untouched")).toBe("late external edit\n");
  expect(await f.read("file-1")).toBe("resolved file-1\n");
});
it("does not discard a permission change disguised as a conflict resolution", async () => {
  const f = await fixture();
  await f.resolve();
  const name = path.join(f.root, "file-1");
  await fs.chmod(name, 0o640);
  await expect(f.prepare("abort")).rejects.toThrow();
  expect((await fs.stat(name)).mode & 0o777).toBe(0o640);
  expect(await f.read("file-1")).toBe("resolved file-1\n");
});
it("proves successive clean merges on the same path using intermediate content before native writes", async () => {
  async function setup() {
    const f = await fixture([1]);
    await f.git(["rebase", "--abort"]);
    await f.git(["checkout", "-b", "repeated", "main^"]);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    await f.write("file-2", lines.join("\n") + "\n");
    await f.git(["commit", "-am", "long base"]);
    await f.git(["checkout", "-b", "repeated-upstream"]);
    await f.write("file-1", "upstream\n");
    const ours = [...lines];
    ours[29] = "upstream last line";
    await f.write("file-2", ours.join("\n") + "\n");
    await f.git(["commit", "-am", "upstream"]);
    await f.git(["checkout", "repeated"]);
    await f.write("file-1", "source\n");
    await f.git(["commit", "-am", "first"]);
    lines[0] = "topic first line";
    await f.write("file-2", lines.join("\n") + "\n");
    await f.git(["commit", "-am", "second"]);
    lines[15] = "topic middle line";
    await f.write("file-2", lines.join("\n") + "\n");
    await f.git(["commit", "-am", "third"]);
    await f.write("file-3", "fourth\n");
    await f.git(["commit", "-am", "fourth"]);
    await expect(
      f.git(["rebase", "--merge", "repeated-upstream"]),
    ).rejects.toMatchObject({ exitCode: 1 });
    await f.resolve();
    return f;
  }
  const f = await setup(),
    control = await setup();
  const result = await f.engine.execute((await f.prepare("continue")).token);
  expect(result, result.log).toMatchObject({
    status: "success",
    lockRetained: false,
  });
  await control.git(["rebase", "--continue"]);
  expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
    await control.git(["rev-parse", "HEAD^{tree}"]),
  );
  const content = await f.read("file-2");
  for (const text of [
    "topic first line",
    "topic middle line",
    "upstream last line",
  ])
    expect(content).toContain(text);
});
it.each(["todo", "index", "policy"])(
  "consumes long continuation token after stale %s without changing worktree",
  async (kind) => {
    const f = await fixture();
    await f.resolve();
    const p = await f.prepare("continue");
    if (kind === "todo")
      await f.write(
        ".git/rebase-merge/git-rebase-todo",
        (await f.read(".git/rebase-merge/git-rebase-todo")) + "# changed\n",
      );
    else if (kind === "policy")
      await f.git(["config", "core.autocrlf", "true"]);
    else {
      await f.write("untouched", "external\n");
      await f.git(["add", "untouched"]);
    }
    const head = await f.read(".git/HEAD"),
      content = await f.read("file-1");
    await expect(f.engine.execute(p.token)).rejects.toThrow();
    expect(await f.read(".git/HEAD")).toBe(head);
    expect(await f.read("file-1")).toBe(content);
    await expect(f.engine.execute(p.token)).rejects.toThrow();
  },
);
