import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
import * as fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { GitBranchActions } from "../src/host/git-branches";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../src/host/git-native-context";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { NativeGitMergeOperations } from "../src/host/git-native-merge";
import { NativeGitSequenceAPI } from "../src/host/git-native-sequence-api";
import { NativeGitUpdateHandoff } from "../src/host/git-native-update-handoff";
import type { GitCommitContext } from "../src/host/git-workspace-actions";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { CommandExitError, NodeRunner } from "../src/host/process";
import {
  createOperationFixture,
  type OperationFixture,
} from "./helpers/git-operation-fixtures";

async function fixture() {
  const f = await createOperationFixture("merge-rebase", {
    commits: 1,
    conflictAt: [1],
  });
  fixtureScope().cleanup(() => f.dispose());
  return f;
}
function desktop(f: OperationFixture, strategy: "merge" | "rebase") {
  const env = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = fixtureScope.runner(new NodeRunner(10000, env));
  fixtureScope().cleanup(() => runner.dispose());
  const native = (args: string[], stdin?: string) =>
    runner.command("git", args, f.root, env, stdin);
  const git: GitCommitContext["git"] = (args, options) =>
    options?.indexFile
      ? withTrustedGitIndex(options.indexFile, () =>
          native(args, options.stdin),
        )
      : native(args, options?.stdin);
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "project",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  let ownerKey = f.root;
  const context = {
    root: f.root,
    scope: "project",
    get ownerKey() {
      return ownerKey;
    },
    verify: async () => {},
    verifyOwner: async () => {},
    git,
    isolatedGit: native,
    native: createNativeGitCapability({
      root: f.root,
      runner,
      env,
      journal: new NativeGitJournal({
        directory: path.join(f.home, "native-journal"),
      }),
      owner: async () => ({
        scope: "project",
        registryRevision: nativeIntent(ownerKey),
        projectPath: f.root,
      }),
    }),
    snapshot: () => reader.snapshot(),
    topicsConfig: async () =>
      `base_ref: main\nupdate:\n  strategy: ${strategy}\n`,
  };
  const handoff = new NativeGitUpdateHandoff({
    context: async (_scope, fn) => fn(context),
  });
  const sequence = new NativeGitSequenceAPI({
    context: async (_scope, fn) => fn({ ...context, git: native }),
  });
  const operation =
    strategy === "rebase"
      ? {
          prepare: sequence.prepareRebase.bind(sequence),
          execute: sequence.executeRebase.bind(sequence),
        }
      : new NativeGitMergeOperations({
          context: async (_scope, fn) => fn({ ...context, git: native }),
        });
  return {
    reader,
    operation,
    changeOwner() {
      ownerKey = "another-owner";
    },
    async start() {
      if (strategy === "merge") {
        const branches = new GitBranchActions({
          context: async (_id, action) =>
            action({
              ...context,
              git: native,
              remoteGit: async () => {
                throw Error("offline fixture");
              },
            }),
        });
        const preview = await branches.prepare({
          projectId: "project",
          revision: (await branches.inventory("project")).revision,
          action: "merge",
          ref: "refs/heads/main",
        });
        expect(await branches.execute(preview.token)).toMatchObject({
          status: "conflict",
        });
        return;
      }
      const attempt = await handoff.captureAttempt(context, {
        sourceRef: "refs/heads/main",
        targetBranch: "topic",
        baseRef: "main",
      });
      const candidate = await handoff.afterFailure(
        context,
        attempt,
        new CommandExitError("isolated fixture refusal", 1),
      );
      expect(candidate).not.toBeNull();
      const preview = await handoff.prepare({
        scope: "project",
        revision: (await reader.snapshot()).revision,
        candidateId: candidate!.candidateId,
      });
      expect(await handoff.execute(preview.token)).toMatchObject({
        status: "conflict",
      });
    },
    async prepare(action: "continue" | "abort") {
      return operation.prepare({
        scope: "project",
        revision: (await reader.snapshot()).revision,
        action,
      });
    },
  };
}

/** Observable Git contract, not private metadata bytes or committer timestamp. */
async function observable(f: OperationFixture) {
  const parents = (await f.git(["show", "-s", "--format=%P", "HEAD"]))
    .trim()
    .split(" ")
    .filter(Boolean);
  return {
    commit: await f.git([
      "show",
      "-s",
      "--format=%T%x00%an%x00%ae%x00%aI%x00%B",
      "HEAD",
    ]),
    parents: await Promise.all(
      parents.map((oid) => f.git(["rev-parse", `${oid}^{tree}`])),
    ),
    branch: await f.git(["symbolic-ref", "HEAD"]),
    index: await f.git(["ls-files", "--stage", "-z"]),
    status: await f.git(["status", "--porcelain=v2", "-z"]),
    conflicts: await f.conflicts(),
    files: await Promise.all(
      ["file-1", "untouched", "ignored", "untracked"].map((name) =>
        f.read(name),
      ),
    ),
  };
}

for (const strategy of ["merge", "rebase"] as const) {
  for (const action of ["continue", "abort"] as const) {
    it(
      `managed ${strategy} ${action} matches native Git and preserves unrelated bytes`,
      fixtureScope.run(async () => {
        const f = await fixture(),
          control = await fixture();
        for (const repo of [f, control]) {
          await repo.git(["rebase", "--abort"]);
          // START policy requires no untracked files. Reintroduce them after stop.
          await fs.unlink(path.join(repo.root, "untracked"));
        }
        const app = desktop(f, strategy);
        await app.start();
        await expect(
          control.git(
            strategy === "merge"
              ? ["merge", "--no-edit", control.onto]
              : ["rebase", "--merge", control.onto],
          ),
        ).rejects.toMatchObject({ exitCode: 1 });
        for (const repo of [f, control]) {
          await repo.write("untracked", "preserve untracked\n");
          await repo.resolve();
        }
        const preview = await app.prepare(action);
        const result = await app.operation.execute(preview.token);
        expect(result, result.log).toMatchObject({ status: "success" });
        await control.git([strategy, `--${action}`]);
        expect(await observable(f)).toEqual(await observable(control));
        await expect(app.operation.execute(preview.token)).rejects.toThrow();
      }),
      gitIntegrationBudget(30000),
    );
  }
}

it(
  "rejects a changed physical owner before continuing a managed operation",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git(["rebase", "--abort"]);
    await fs.unlink(path.join(f.root, "untracked"));
    const app = desktop(f, "rebase");
    await app.start();
    await f.resolve();
    const preview = await app.prepare("continue");
    const head = await f.git(["rev-parse", "HEAD"]),
      index = await f.git(["ls-files", "--stage", "-z"]);
    app.changeOwner();
    await expect(app.operation.execute(preview.token)).rejects.toThrow();
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
  }),
  gitIntegrationBudget(15000),
);

it(
  "does not grant continuation to an external operation just because its files look familiar",
  fixtureScope.run(async () => {
    const f = await fixture(),
      app = desktop(f, "rebase");
    await f.resolve();
    const head = await f.git(["rev-parse", "HEAD"]),
      index = await f.git(["ls-files", "--stage", "-z"]);
    await expect(app.prepare("continue")).rejects.toThrow(
      /происхождени|внешн|терминал/i,
    );
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
  }),
  gitIntegrationBudget(15000),
);

it(
  "native merge/abort preserves pre-existing unrelated unstaged, ignored and untracked files",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git(["rebase", "--abort"]);
    await f.write("untouched", "local edit before merge\n");
    await expect(f.git(["merge", "--no-edit", f.onto])).rejects.toMatchObject({
      exitCode: 1,
    });
    await f.resolve();
    await f.git(["merge", "--abort"]);
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    expect(await f.read("untouched")).toBe("local edit before merge\n");
    expect(await f.read("ignored")).toBe("preserve ignored\n");
    expect(await f.read("untracked")).toBe("preserve untracked\n");
    expect(await f.git(["diff", "--cached"])).toBe("");
  }),
  gitIntegrationBudget(15000),
);

it(
  "does not continue external exec: disabling hooks alone does not make it safe",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git(["rebase", "--abort"]);
    await fs.unlink(path.join(f.root, "untracked"));
    const marker = path.join(f.home, "exec-was-run");
    await expect(
      f.git([
        "rebase",
        "--merge",
        "--exec",
        `printf test > '${marker}'`,
        "main",
      ]),
    ).rejects.toMatchObject({ exitCode: 1 });
    await f.resolve();
    const app = desktop(f, "rebase");
    await expect(app.prepare("continue")).rejects.toThrow();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Positive control in the synthetic HOME: native continuation really executes it.
    await f.git(["rebase", "--continue"]);
    expect(await fs.readFile(marker, "utf8")).toBe("test");
  }),
  gitIntegrationBudget(15000),
);
