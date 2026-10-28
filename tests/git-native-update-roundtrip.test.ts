import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createOperationFixture } from "./helpers/git-operation-fixtures";
import { NodeRunner, CommandExitError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { createNativeGitCapability } from "../src/host/git-native-context";
import { NativeGitUpdateHandoff } from "../src/host/git-native-update-handoff";
import { NativeGitSequence } from "../src/host/git-native-sequence";
import { NativeGitMergeOperations } from "../src/host/git-native-merge";
const artifact = ".goga/history/2026/topic/task.md";
async function setup(
  strategy: "merge" | "rebase",
  topicArtifact = false,
  laterArtifact = false,
  laterText = false,
) {
  const f = await createOperationFixture("merge-rebase", {
    commits: 1,
    conflictAt: [1],
  });
  fixtureScope().cleanup(f.dispose);
  await f.git(["rebase", "--abort"]);
  await fs.rm(path.join(f.root, "untracked"));
  if (topicArtifact) {
    await fs.mkdir(path.dirname(path.join(f.root, artifact)), {
      recursive: true,
    });
    await f.write(artifact, "# Topic-only task\n");
    await f.git(["add", "--", artifact]);
    await f.git(
      laterArtifact
        ? ["commit", "-m", "later topic artifact"]
        : ["commit", "--amend", "--no-edit"],
    );
  }
  if (laterText) {
    await f.write(artifact, "# Follow-up topic task\n");
    await f.git(["commit", "-am", "later text edit"]);
  }
  const original = (await f.git(["rev-parse", "HEAD"])).trim();
  const originalIndex = await f.git(["ls-files", "--stage", "-z"]);
  const env = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = fixtureScope.runner(new NodeRunner(10000, env));
  fixtureScope().cleanup(() => runner.dispose());
  const git = (a: string[], stdin?: string) =>
    runner.command("git", a, f.root, env, stdin);
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "p",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  const c = {
    root: f.root,
    scope: "p",
    ownerKey: "fixture",
    verify: async () => {},
    snapshot: () => reader.snapshot(),
    git: (a: string[], o?: { stdin?: string }) => git(a, o?.stdin),
    topicsConfig: async () =>
      `base_ref: main\nupdate:\n  strategy: ${strategy}\n`,
    native: createNativeGitCapability({
      root: f.root,
      runner,
      env,
      journal: new NativeGitJournal({
        directory: path.join(f.home, "journal"),
      }),
      owner: async () => ({
        scope: "p",
        registryRevision: "fixture",
        projectPath: f.root,
      }),
    }),
  };
  const handoff = new NativeGitUpdateHandoff({
    context: async (_s, fn) => fn(c),
  });
  const ctx = { ...c, git };
  const sequence = new NativeGitSequence({
    context: async (_s, fn) => fn(ctx),
  });
  const merge = new NativeGitMergeOperations({
    context: async (_s, fn) => fn(ctx),
  });
  const attempt = await handoff.captureAttempt(c, {
    targetBranch: "topic",
    sourceRef: "refs/heads/main",
    baseRef: "main",
  });
  const candidate = await handoff.afterFailure(
    c,
    attempt,
    new CommandExitError("synthetic refusal; no Goga executable", 1),
  );
  expect(candidate).toMatchObject({ conflicts: [], algorithm: strategy });
  const preview = await handoff.prepare({
    scope: "p",
    candidateId: candidate!.candidateId,
    revision: (await reader.snapshot()).revision,
  });
  expect(await handoff.execute(preview.token)).toMatchObject({
    status: "conflict",
    native: { outcome: "conflicts", recovery: "retained" },
  });
  const prepare = async (action: "continue" | "abort") => {
    const request = {
      scope: "p",
      revision: (await reader.snapshot()).revision,
      action,
    };
    return strategy === "rebase"
      ? sequence.prepare({ ...request, operation: "rebase" })
      : merge.prepare(request);
  };
  const execute = (token: string) =>
    strategy === "rebase" ? sequence.execute(token) : merge.execute(token);
  return { ...f, original, originalIndex, reader, prepare, execute };
}
for (const strategy of ["merge", "rebase"] as const)
  for (const topicArtifact of [false, true])
    for (const action of ["continue", "abort"] as const)
      it(
        `native Goga ${strategy} START → staged resolution → ${action}; topic-only artifact=${topicArtifact}`,
        fixtureScope.run(async () => {
          const f = await setup(strategy, topicArtifact);
          await f.resolve();
          const result = await f.execute((await f.prepare(action)).token);
          expect(result).toMatchObject(
            strategy === "rebase"
              ? { outcome: "completed", recovery: "removed" }
              : { status: "success" },
          );
          expect((await f.reader.snapshot()).operation).toBe("none");
          expect(await f.conflicts()).toEqual([]);
          expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
            "topic\n",
          );
          if (action === "abort") {
            expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(
              f.original,
            );
            expect(await f.git(["ls-files", "--stage", "-z"])).toBe(
              f.originalIndex,
            );
          }
          if (topicArtifact) {
            expect(await f.read(artifact)).toBe("# Topic-only task\n");
            expect(await f.git(["show", `HEAD:${artifact}`])).toBe(
              "# Topic-only task\n",
            );
          }
          expect(await f.read("ignored")).toBe("preserve ignored\n");
        }),
        gitIntegrationBudget(15000),
      );
it.each([
  "staged-addition-edit",
  "unstaged-addition-edit",
  "foreign-staged-addition",
])(
  "native Goga rebase continue rejects %s without changing the operation",
  fixtureScope.run(async (mutation) => {
    const f = await setup("rebase", true);
    await f.resolve();
    const name = mutation === "foreign-staged-addition" ? "foreign" : artifact;
    await f.write(name, "unapproved content\n");
    if (mutation !== "unstaged-addition-edit") await f.git(["add", "--", name]);
    const index = await fs.readFile(path.join(f.root, ".git/index")),
      head = await f.git(["rev-parse", "HEAD"]);
    await expect(f.prepare("continue")).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(await f.read(name)).toBe("unapproved content\n");
    expect((await f.reader.snapshot()).operation).toBe("rebase");
  }),
  gitIntegrationBudget(15000),
);
it(
  "native Goga rebase supports later-pick topic additions through a separately confirmed continuation",
  fixtureScope.run(async () => {
    const f = await setup("rebase", true, true);
    await f.resolve();
    expect(await f.execute((await f.prepare("continue")).token)).toMatchObject({
      outcome: "completed",
    });
    expect(await f.read(artifact)).toBe("# Topic-only task\n");
    expect(await f.git(["show", `HEAD:${artifact}`])).toBe(
      "# Topic-only task\n",
    );
    expect((await f.reader.snapshot()).operation).toBe("none");
  }),
  gitIntegrationBudget(15000),
);
it(
  "native Goga rebase preserves a supported later text edit to the materialized topic artifact",
  fixtureScope.run(async () => {
    const f = await setup("rebase", true, false, true);
    await f.resolve();
    expect(await f.execute((await f.prepare("continue")).token)).toMatchObject({
      outcome: "completed",
    });
    expect(await f.read(artifact)).toBe("# Follow-up topic task\n");
    expect(await f.git(["show", `HEAD:${artifact}`])).toBe(
      "# Follow-up topic task\n",
    );
    expect((await f.reader.snapshot()).operation).toBe("none");
  }),
  gitIntegrationBudget(15000),
);
it(
  "native Goga changed materialized topic addition invalidates continuation confirmation",
  fixtureScope.run(async () => {
    const f = await setup("rebase", true);
    await f.resolve();
    const preview = await f.prepare("continue");
    await f.write(artifact, "late user edit\n");
    const index = await fs.readFile(path.join(f.root, ".git/index")),
      head = await f.git(["rev-parse", "HEAD"]);
    await expect(f.execute(preview.token)).rejects.toThrow();
    expect(await f.read(artifact)).toBe("late user edit\n");
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
  }),
  gitIntegrationBudget(15000),
);
