import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
import { gitIntegrationBudget } from "./helpers/git-integration";
import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createOperationFixture,
  type Scenario,
} from "./helpers/git-operation-fixtures";
import { NativeGitSequence } from "../src/host/git-native-sequence";
import { NativeGitJournal } from "../src/host/git-native-journal";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../src/host/git-native-context";
import { NodeRunner, ByteCommandError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
async function fixture(
  scenario: Scenario,
  external = false,
  commits = 3,
  conflictAt = [1, 3],
) {
  const f = await createOperationFixture(scenario, { commits, conflictAt });
  fixtureScope().cleanup(f.dispose);
  if (!external) await f.git([f.command, "--abort"]);
  const env = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = fixtureScope.runner(new NodeRunner(10000, env));
  fixtureScope().cleanup(() => runner.dispose());
  const directory = path.join(f.home, "journal");
  let owner = "owner",
    fault: (() => Promise<void>) | undefined;
  const calls: string[][] = [];
  let initialIntent: string | undefined;
  const git = (args: string[], stdin?: string) =>
    runner.command("git", args, f.root, env, stdin);
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "p",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  const context = {
    scope: "p",
    root: f.root,
    ownerKey: "owner",
    verify: async () => {},
    git,
    snapshot: () => reader.snapshot(),
    native: createNativeGitCapability({
      root: f.root,
      env,
      journal: new NativeGitJournal({ directory }),
      owner: async () => ({
        scope: "p",
        projectPath: f.root,
        registryRevision: nativeIntent(owner),
      }),
      runner: {
        commandBytes: async (request) => {
          if (
            request.cwd === f.root &&
            request.args.includes(f.command) &&
            !request.args.includes("--edit-todo")
          ) {
            const [name] = (await fs.readdir(directory)).filter((n) =>
              n.endsWith(".json"),
            );
            const record = JSON.parse(
              await fs.readFile(path.join(directory, name), "utf8"),
            );
            expect(record).toMatchObject({
              state: "running",
              recovery: expect.any(Object),
              intentDetails: expect.any(String),
            });
            const details = JSON.parse(record.intentDetails);
            expect(record.intentFingerprint).toBe(nativeIntent(details));
            if (!calls.length) {
              initialIntent = record.intentDetails;
              expect(details[3]).toEqual({
                policy: "local-write",
                command: f.command,
                args: request.args.slice(
                  request.args.lastIndexOf(f.command) + 1,
                ),
              });
            } else expect(record.intentDetails).toBe(initialIntent);
            calls.push([...request.args]);
            await fault?.();
          }
          return runner.commandBytes(request);
        },
      },
    }),
  };
  let afterContext: (() => void) | undefined;
  const engine = () => {
    context.native.journal = new NativeGitJournal({ directory });
    return new NativeGitSequence({
      context: async (_scope, fn) => {
        const result = await fn(context);
        afterContext?.();
        return result;
      },
    });
  };
  const operations = engine();
  const prepare = (action: "continue" | "abort", service = operations) =>
    reader.snapshot().then((s) =>
      service.prepare({
        scope: "p",
        operation: f.command,
        action,
        revision: s.revision,
      }),
    );
  const start = async () => {
    const preview = await operations.prepareStart(
      "p",
      f.command === "rebase"
        ? {
            operation: "rebase",
            source: f.onto,
            backend: scenario === "apply-rebase" ? "apply" : "merge",
          }
        : { operation: f.command, commits: f.sources },
    );
    return operations.execute(preview.token);
  };
  return {
    ...f,
    afterContext: (fn: () => void) => {
      afterContext = fn;
    },
    context,
    reader,
    operations,
    prepare,
    start,
    engine,
    directory,
    calls,
    owner: () => {
      owner = "changed";
    },
    fault: (fn: () => Promise<void>) => {
      fault = fn;
    },
  };
}
for (const scenario of [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
] as const) {
  it(
    `${scenario}: native continuation crosses multiple stops and clean intermediate commits`,
    fixtureScope.run(async () => {
      const f = await fixture(scenario);
      const control = await createOperationFixture(scenario, {
        commits: 3,
        conflictAt: [1, 3],
      });
      fixtureScope().cleanup(control.dispose);
      for (let stop = 0; stop < 2; stop++) {
        await control.resolve();
        try {
          await control.git([control.command, "--continue"]);
        } catch (error) {
          if (stop !== 0) throw error;
        }
      }
      expect(await control.conflicts()).toEqual([]);
      expect(await f.start()).toMatchObject({
        outcome: "conflicts",
        processSettled: true,
      });
      await f.resolve();
      expect(
        await f.operations.execute((await f.prepare("continue")).token),
      ).toMatchObject({ outcome: "conflicts", processSettled: true });
      expect(await f.read("ignored")).toBe("preserve ignored\n");
      const resumed = f.engine();
      await f.resolve();
      const preview = await f.prepare("continue", resumed);
      const completed = await resumed.execute(preview.token);
      expect(completed, JSON.stringify(completed)).toMatchObject({
        outcome: "completed",
        recovery: "removed",
      });
      expect((await f.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(
        f.branch,
      );
      expect(await f.conflicts()).toEqual([]);
      expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
        await control.git(["rev-parse", "HEAD^{tree}"]),
      );
      const metadata = ["log", "-3", "--format=%an%x00%ae%x00%aI%x00%B%x00"];
      expect(await f.git(metadata)).toBe(await control.git(metadata));
      expect(await f.read("untouched")).toBe("keep\n");
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      await expect(resumed.execute(preview.token)).rejects.toThrow();
      expect(f.calls.filter((a) => a.includes("--continue"))).toHaveLength(2);
    }),
    gitIntegrationBudget(30000),
  );
  it(
    `${scenario}: native abort after staged resolution restores original branch/index without fake locks`,
    fixtureScope.run(async () => {
      const f = await fixture(scenario);
      const index = await f.git(["ls-files", "--stage", "-z"]);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      await f.resolve();
      expect(
        await f.operations.execute((await f.prepare("abort")).token),
      ).toMatchObject({ outcome: "completed" });
      expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
      expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      expect(await f.read("ignored")).toBe("preserve ignored\n");
      await expect(
        fs.stat(path.join(f.root, ".git/HEAD.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }),
    gitIntegrationBudget(15000),
  );
  it(
    `${scenario}: never adopts an external operation`,
    fixtureScope.run(async () => {
      const f = await fixture(scenario, true);
      const head = await f.git(["rev-parse", "HEAD"]);
      for (const action of ["continue", "abort"] as const)
        await expect(f.prepare(action)).rejects.toThrow(
          /происхождени|внешн|терминал/i,
        );
      expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
      expect(f.calls).toHaveLength(0);
    }),
    gitIntegrationBudget(15000),
  );
}
it(
  "rejects changed opaque rebase controls without executing injected exec",
  fixtureScope.run(async () => {
    const f = await fixture("merge-rebase");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const marker = path.join(f.root, "must-not-run");
    await fs.appendFile(
      path.join(f.root, ".git/rebase-merge/git-rebase-todo"),
      `exec touch ${marker}\n`,
    );
    await expect(f.prepare("continue")).rejects.toThrow();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);
it(
  "refuses late unrelated staged and unstaged edits instead of discarding them on abort",
  fixtureScope.run(async () => {
    const f = await fixture("merge-rebase");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.write("untouched", "new draft\n");
    await expect(f.prepare("abort")).rejects.toThrow();
    await f.git(["add", "untouched"]);
    await expect(f.prepare("abort")).rejects.toThrow();
    expect(await f.read("untouched")).toBe("new draft\n");
  }),
  gitIntegrationBudget(15000),
);
it(
  "checks owner again after preview before any native attempt",
  fixtureScope.run(async () => {
    const f = await fixture("cherry-pick");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const p = await f.prepare("abort");
    f.owner();
    await expect(f.operations.execute(p.token)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);
it(
  "retains original recovery and blocks replay after an unsettled process",
  fixtureScope.run(async () => {
    const f = await fixture("revert");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const p = await f.prepare("continue");
    f.fault(async () => {
      throw new ByteCommandError(
        "process-unsettled",
        false,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    });
    expect(await f.operations.execute(p.token)).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
    });
    await expect(f.prepare("continue")).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);

it(
  "does not overwrite an untracked replacement of an originally tracked conflict on abort",
  fixtureScope.run(async () => {
    const f = await fixture("merge-rebase");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const [name] = await f.conflicts();
    await f.git(["rm", "--", name]);
    await f.write(name, "new untracked draft\n");
    await expect(f.prepare("abort")).rejects.toThrow();
    expect(await f.read(name)).toBe("new untracked draft\n");
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "requires explicit signing support rather than silently executing a signer or disabling signing",
  fixtureScope.run(async () => {
    const f = await fixture("cherry-pick");
    await f.git(["config", "commit.gpgsign", "true"]);
    await f.git(["config", "gpg.program", "/usr/bin/false"]);
    await expect(f.start()).rejects.toThrow(/подпис|sign/i);
    expect(f.calls).toHaveLength(0);
    expect((await f.git(["config", "commit.gpgsign"])).trim()).toBe("true");
  }),
  gitIntegrationBudget(15000),
);

for (const scenario of [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
] as const) {
  it(
    `${scenario}: single operation completes with an explicit revert commit warning`,
    fixtureScope.run(async () => {
      const f = await fixture(scenario, false, 1, [1]);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      if (f.command === "rebase")
        expect(
          (
            await fs.stat(
              path.join(
                f.root,
                scenario === "apply-rebase"
                  ? ".git/rebase-apply"
                  : ".git/rebase-merge",
              ),
            )
          ).isDirectory(),
        ).toBe(true);
      await f.resolve();
      const p = await f.prepare("continue");
      expect(p.requiresCommitWarning).toBe(scenario === "revert");
      expect(await f.operations.execute(p.token)).toMatchObject({
        outcome: "completed",
        recovery: "removed",
      });
      expect((await f.git(["rev-parse", "HEAD"])).trim()).not.toBe(f.original);
      expect((await f.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(
        f.branch,
      );
    }),
    gitIntegrationBudget(15000),
  );
}
it(
  "refuses branch/ref drift since the durable checkpoint",
  fixtureScope.run(async () => {
    const f = await fixture("merge-rebase");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.git(["update-ref", "refs/heads/topic", "HEAD"]);
    await expect(f.prepare("abort")).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);
it(
  "refuses config drift without starting a second process",
  fixtureScope.run(async () => {
    const f = await fixture("cherry-pick");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.git(["config", "user.name", "Changed identity"]);
    await expect(f.prepare("abort")).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);
it(
  "refuses a newly ignored file after confirmation, keeping its bytes",
  fixtureScope.run(async () => {
    const f = await fixture("revert");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    // Removing/recreating an existing ignored path changes the captured snapshot.
    await fs.rm(path.join(f.root, "ignored"));
    const p = await f.prepare("abort");
    await f.write("ignored", "late ignored bytes\n");
    await expect(f.operations.execute(p.token)).rejects.toThrow();
    expect(await f.read("ignored")).toBe("late ignored bytes\n");
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);
it(
  "does not remove a foreign Git lock or retry a refused native write",
  fixtureScope.run(async () => {
    const f = await fixture("cherry-pick");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const p = await f.prepare("abort");
    const lock = path.join(f.root, ".git/index.lock");
    await fs.writeFile(lock, "foreign owner");
    await expect(f.operations.execute(p.token)).rejects.toThrow();
    expect(await fs.readFile(lock, "utf8")).toBe("foreign owner");
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);
it(
  "native continuation does not invoke repository hooks",
  fixtureScope.run(async () => {
    const f = await fixture("merge-rebase");
    const marker = path.join(f.home, "hook-ran");
    for (const name of [
      "pre-rebase",
      "pre-commit",
      "commit-msg",
      "post-rewrite",
      "post-commit",
    ])
      await fs.writeFile(
        path.join(f.root, ".git/hooks", name),
        `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
        { mode: 0o700 },
      );
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    expect(
      await f.operations.execute((await f.prepare("continue")).token),
    ).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    expect(
      await f.operations.execute((await f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed" });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }),
  gitIntegrationBudget(15000),
);

for (const scenario of [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
] as const) {
  it(
    `${scenario}: abort preserves the original snapshot after an unstaged manual resolution`,
    fixtureScope.run(async () => {
      const f = await fixture(scenario, false, 1, [1]);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      for (const p of await f.conflicts())
        await f.write(p, "manual, not staged\n");
      expect(
        await f.operations.execute((await f.prepare("abort")).token),
      ).toMatchObject({ outcome: "completed", recovery: "removed" });
      expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
      expect(await f.read("ignored")).toBe("preserve ignored\n");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    `${scenario}: native start may complete cleanly instead of predicting a conflict`,
    fixtureScope.run(async () => {
      const f = await fixture(scenario);
      const p = await f.operations.prepareStart(
        "p",
        f.command === "rebase"
          ? {
              operation: "rebase",
              source: f.sources[0],
              backend: scenario === "apply-rebase" ? "apply" : "merge",
            }
          : { operation: f.command, commits: [f.sources[1]] },
      );
      expect(await f.operations.execute(p.token)).toMatchObject({
        outcome: "completed",
        recovery: "removed",
      });
      expect((await f.reader.snapshot()).operation).toBe("none");
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      expect(await f.read("ignored")).toBe("preserve ignored\n");
      expect(f.calls).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
}

it(
  "refuses an ignored file occupying a future checkout destination, including case aliases",
  fixtureScope.run(async () => {
    const f = await fixture("cherry-pick", false, 1, [1]);
    const insensitive = await fs.stat(path.join(f.root, "IGNORED")).then(
      () => true,
      () => false,
    );
    const target = insensitive ? "IGNORED" : "ignored";
    await f.git(["checkout", "-b", "future"]);
    await fs.rm(path.join(f.root, "ignored"));
    await f.write(target, "incoming\n");
    await f.git(["add", "-f", "--", target]);
    await f.git(["commit", "-m", "new destination"]);
    const source = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git(["checkout", f.branch]);
    await f.write("ignored", "local ignored draft\n");
    await expect(
      f.operations.prepareStart("p", {
        operation: "cherry-pick",
        commits: [source],
      }),
    ).rejects.toThrow();
    expect(await f.read("ignored")).toBe("local ignored draft\n");
    expect(f.calls).toHaveLength(0);
  }),
  gitIntegrationBudget(15000),
);

it.each([
  ["notes.rewriteRef", "refs/notes/test"],
  ["merge.verifySignatures", "true"],
])(
  "rejects unconfirmed side effects from %s before a native attempt",
  fixtureScope.run(async (key, value) => {
    const f = await fixture("merge-rebase");
    await f.git(["config", key, value]);
    await expect(f.start()).rejects.toThrow(/notes|подпис/);
    expect(f.calls).toHaveLength(0);
  }),
  gitIntegrationBudget(15000),
);
it(
  "host-only merge start records a native conflict without a predicted replay tree",
  fixtureScope.run(async () => {
    const f = await fixture("merge-rebase", false, 1, [1]);
    const preview = await f.operations.prepareStart("p", {
      operation: "merge",
      source: f.onto,
    } as any);
    expect(await f.operations.execute(preview.token)).toMatchObject({
      outcome: "conflicts",
      processSettled: true,
      verifiedUnrelatedData: true,
      recovery: "retained",
    });
    expect((await f.reader.snapshot()).operation).toBe("merge");
  }),
  gitIntegrationBudget(15000),
);

it.each(["merge-rebase", "apply-rebase", "cherry-pick", "revert"] as const)(
  "N8 %s abort retains its recovery through outer context release",
  fixtureScope.run(async (scenario) => {
    const f = await fixture(scenario);
    await f.start();
    const p = await f.prepare("abort");
    f.afterContext(() => {
      throw Error("outer-owner-release");
    });
    await expect(f.operations.execute(p.token)).rejects.toThrow();
    const name = (await fs.readdir(f.directory)).find((n) =>
      n.endsWith(".json"),
    )!;
    const record = JSON.parse(
      await fs.readFile(path.join(f.directory, name), "utf8"),
    );
    expect(record.recovery).not.toBeNull();
    await expect(
      f.context.native.journal.assertAdmission(f.root, record.recovery.owner),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
