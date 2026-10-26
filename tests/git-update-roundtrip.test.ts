import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createOperationFixture,
  type OperationFixture,
} from "./helpers/git-operation-fixtures";
import { NodeRunner, CommandExitError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { GitUpdateHandoffCandidates } from "../src/host/git-update-handoff";
import { GitRebaseOperations } from "../src/host/git-rebase-operations";
import { GitMergeOperations } from "../src/host/git-operations";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
import type { GitCommitContext } from "../src/host/git-workspace-actions";
const fixtures: OperationFixture[] = [];
const runners: NodeRunner[] = [];
const artifact = ".goga/history/2026/topic/task.md";
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
  for (const f of fixtures.splice(0)) await f.dispose();
});
async function setup(
  strategy: "merge" | "rebase",
  topicArtifact: boolean,
  futureArtifact = false,
  expectNoCandidate = false,
  followupText = false,
) {
  const f = await createOperationFixture("merge-rebase", {
    commits: 1,
    conflictAt: [1],
  });
  fixtures.push(f);
  await f.git(["rebase", "--abort"]);
  await fs.rm(path.join(f.root, "untracked"));
  if (topicArtifact) {
    await fs.mkdir(path.dirname(path.join(f.root, artifact)), {
      recursive: true,
    });
    await f.write(artifact, "# Topic-only task\n");
    await f.git(["add", "--", artifact]);
    await f.git(
      futureArtifact
        ? ["commit", "-m", "later topic artifact"]
        : ["commit", "--amend", "--no-edit"],
    );
  }
  if (followupText) {
    await f.write(artifact, "# Follow-up topic task\n");
    await f.git(["commit", "-am", "later text edit"]);
  }
  const original = (await f.git(["rev-parse", "HEAD"])).trim();
  const env = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = new NodeRunner(10000, env);
  runners.push(runner);
  const nativeGit = (a: string[], stdin?: string) =>
    runner.command("git", a, f.root, env, stdin);
  const git: GitCommitContext["git"] = (a, options) => {
    const run = () => nativeGit(a, options?.stdin);
    return options?.indexFile
      ? withTrustedGitIndex(options.indexFile, run)
      : run();
  };
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "project",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  const c = {
    root: f.root,
    scope: "project",
    ownerKey: f.root,
    git,
    isolatedGit: nativeGit,
    verify: async () => {},
    verifyOwner: async () => {},
    snapshot: () => reader.snapshot(),
    topicsConfig: async () =>
      `base_ref: main\nupdate:\n  strategy: ${strategy}\n`,
    refTransaction: ((a, input, verify) =>
      runner.gitRefTransaction(a, f.root, env, input, verify)) as NonNullable<
      GitCommitContext["refTransaction"]
    >,
  };
  const handoff = new GitUpdateHandoffCandidates({
    context: async (_scope, fn) => fn(c),
  });
  const rebase = new GitRebaseOperations({
    context: async (_scope, fn) => fn(c),
  });
  const merge = new GitMergeOperations({
    context: async (_scope, fn) => fn(c),
  });
  const beforeIndex = await fs.readFile(path.join(f.root, ".git/index"));
  const attempt = await handoff.capture(c, {
    sourceRef: "refs/heads/main",
    targetBranch: "topic",
    baseRef: "main",
  });
  const candidate = await handoff.afterFailure(
    c,
    attempt,
    new CommandExitError("synthetic refusal; no Goga executable", 1),
  );
  if (expectNoCandidate) {
    expect(candidate).toBeNull();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(
      beforeIndex,
    );
    expect((await reader.snapshot()).operation).toBe("none");
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(original);
    return { ...f, original, reader, rebase, merge };
  }
  expect(candidate).not.toBeNull();
  const preview = await handoff.prepare({
    candidateId: candidate!.candidateId,
    scope: "project",
    revision: (await reader.snapshot()).revision,
  });
  const started = await handoff.execute(preview.token);
  expect(started, started.log).toMatchObject({
    status: "conflict",
    algorithm: strategy,
  });
  return { ...f, original, reader, rebase, merge };
}
for (const strategy of ["merge", "rebase"] as const)
  for (const topicArtifact of [false, true])
    for (const action of ["continue", "abort"] as const)
      it(`${strategy} START → staged resolution → ${action}; topic-only artifact=${topicArtifact}`, async () => {
        const f = await setup(strategy, topicArtifact);
        await f.resolve();
        const engine = strategy === "rebase" ? f.rebase : f.merge;
        const preview = await engine.prepare({
          scope: "project",
          revision: (await f.reader.snapshot()).revision,
          action,
        });
        const result = await engine.execute(preview.token);
        expect(result, result.log).toMatchObject({
          status: "success",
          lockRetained: false,
        });
        expect((await f.reader.snapshot()).operation).toBe("none");
        expect(await f.conflicts()).toEqual([]);
        expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
          "topic\n",
        );
        if (action === "abort")
          expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
        if (topicArtifact) {
          expect(await f.read(artifact)).toBe("# Topic-only task\n");
          expect(await f.git(["show", `HEAD:${artifact}`])).toBe(
            "# Topic-only task\n",
          );
        }
        expect(await f.read("ignored")).toBe("preserve ignored\n");
      }, 20000);

for (const mutation of [
  "staged-addition-edit",
  "unstaged-addition-edit",
  "foreign-staged-addition",
])
  it(`rebase continue rejects ${mutation} without changing the operation`, async () => {
    const f = await setup("rebase", true);
    await f.resolve();
    const name = mutation === "foreign-staged-addition" ? "foreign" : artifact;
    await f.write(name, "unapproved content\n");
    if (mutation !== "unstaged-addition-edit") await f.git(["add", "--", name]);
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    const head = await f.git(["rev-parse", "HEAD"]);
    await expect(
      f.rebase.prepare({
        scope: "project",
        revision: (await f.reader.snapshot()).revision,
        action: "continue",
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(await f.read(name)).toBe("unapproved content\n");
    expect((await f.reader.snapshot()).operation).toBe("rebase");
  }, 20000);

it("later-pick topic additions are ineligible before START because continuation cannot handle them", async () => {
  const f = await setup("rebase", true, true, true);
  expect(await f.read(artifact)).toBe("# Topic-only task\n");
}, 20000);

it("layout eligibility preserves a supported later text edit to the materialized topic artifact", async () => {
  const f = await setup("rebase", true, false, false, true);
  await f.resolve();
  const preview = await f.rebase.prepare({
    scope: "project",
    revision: (await f.reader.snapshot()).revision,
    action: "continue",
  });
  const result = await f.rebase.execute(preview.token);
  expect(result, result.log).toMatchObject({
    status: "success",
    lockRetained: false,
  });
  expect((await f.reader.snapshot()).operation).toBe("none");
  expect(await f.read(artifact)).toBe("# Follow-up topic task\n");
  expect(await f.git(["show", `HEAD:${artifact}`])).toBe(
    "# Follow-up topic task\n",
  );
}, 20000);

it("a changed materialized topic addition invalidates continuation confirmation", async () => {
  const f = await setup("rebase", true);
  await f.resolve();
  const preview = await f.rebase.prepare({
    scope: "project",
    revision: (await f.reader.snapshot()).revision,
    action: "continue",
  });
  await f.write(artifact, "late user edit\n");
  const index = await fs.readFile(path.join(f.root, ".git/index"));
  const head = await f.git(["rev-parse", "HEAD"]);
  await expect(f.rebase.execute(preview.token)).rejects.toThrow();
  expect(await f.read(artifact)).toBe("late user edit\n");
  expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
  expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
}, 20000);
