import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createOperationFixture,
  type Scenario,
} from "./helpers/git-operation-fixtures";
import { NativeGitSequence } from "../src/host/git-native-sequence";
import { NativeGitConflictActions } from "../src/host/git-native-conflict-save";
import { GitConflictReader } from "../src/host/git-conflicts";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { createNativeGitCapability } from "../src/host/git-native-context";
import { NodeRunner } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import type { GitConflictActionContext } from "../src/host/git-conflict-actions";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(scenario: Scenario, external = false) {
  const f = await createOperationFixture(scenario, {
    commits: 1,
    conflictAt: [1],
  });
  cleanup.push(f.dispose);
  if (!external) await f.git([f.command, "--abort"]);
  const env = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = (args: string[], stdin?: string) =>
    runner.command("git", args, f.root, env, stdin);
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "p",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  const directory = path.join(f.home, "journal");
  const context: GitConflictActionContext = {
    root: f.root,
    scope: "p",
    ownerKey: "owner",
    verify: async () => {},
    snapshot: () => reader.snapshot(),
    isolatedGit: git,
    git: (args, options) =>
      options?.indexFile
        ? withTrustedGitIndex(options.indexFile, () => git(args, options.stdin))
        : git(args, options?.stdin),
    native: createNativeGitCapability({
      root: f.root,
      runner,
      env,
      journal: new NativeGitJournal({ directory }),
      owner: async () => ({
        scope: "p",
        projectPath: f.root,
        registryRevision: "owner",
      }),
    }),
  };
  const bound = async <T>(
    _scope: unknown,
    fn: (c: GitConflictActionContext) => Promise<T>,
  ) => fn(context);
  const sequence = new NativeGitSequence({
    context: async (_scope, fn) => fn({ ...context, git }),
  });
  const save = new NativeGitConflictActions({ context: bound });
  const conflicts = new GitConflictReader({ context: bound });
  const start = async () =>
    sequence.execute(
      (
        await sequence.prepareStart(
          "p",
          f.command === "rebase"
            ? {
                operation: "rebase",
                source: f.onto,
                backend: scenario === "apply-rebase" ? "apply" : "merge",
              }
            : { operation: f.command, commits: f.sources },
        )
      ).token,
    );
  const resolve = async (kind: "incoming" | "text" = "incoming") => {
    for (const name of await f.conflicts()) {
      const doc = await conflicts.read({
        scope: "p",
        path: name,
        revision: (await reader.snapshot()).revision,
      });
      const p = await save.prepare({
        scope: "p",
        path: name,
        revision: doc.revision,
        fingerprint: doc.fingerprint,
        resolution: kind === "text" ? { kind, text: "resolved\n" } : { kind },
      });
      const result = await save.execute(p.token);
      expect(result, result.log).toMatchObject({
        status: "saved",
        lockRetained: false,
      });
    }
  };
  const record = async () =>
    JSON.parse(
      await fs.readFile(
        path.join(
          directory,
          (await fs.readdir(directory)).find((n) => n.endsWith(".json"))!,
        ),
        "utf8",
      ),
    );
  const prepare = async (action: "continue" | "abort") =>
    sequence.prepare({
      scope: "p",
      operation: f.command,
      action,
      revision: (await reader.snapshot()).revision,
    });
  return {
    ...f,
    gitRaw: git,
    context,
    sequence,
    start,
    resolve,
    record,
    prepare,
  };
}
for (const scenario of [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
] as const) {
  it.each(["continue", "abort"] as const)(
    `${scenario}: native conflict save preserves Desktop %s`,
    async (action) => {
      const f = await fixture(scenario);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      const parent = await f.record();
      await f.resolve();
      expect(await f.record()).toEqual(parent);
      const result = await f.sequence.execute((await f.prepare(action)).token);
      const afterRecord = await f.record();
      const diagnostic =
        result.outcome === "completed"
          ? ""
          : JSON.stringify({
              result,
              afterRecord,
              index: await f.git(["ls-files", "-s", "-z"]),
              files: await Promise.all(
                parent.recovery.files.map(async (x: { path: string }) => ({
                  path: x.path,
                  mode: (
                    await fs.stat(path.join(f.root, x.path)).catch(() => null)
                  )?.mode,
                  data: await fs
                    .readFile(path.join(f.root, x.path), "base64")
                    .catch(() => null),
                })),
              ),
            });
      expect(result, diagnostic).toMatchObject({
        outcome: "completed",
        recovery: "removed",
      });
      expect(await f.conflicts()).toEqual([]);
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      expect(await f.read("ignored")).toBe("preserve ignored\n");
      expect(await f.read("untouched")).toBe("keep\n");
      if (action === "abort")
        expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    },
    30000,
  );
}
it.each(["continue", "abort"] as const)(
  "explicit executable side resolution permits Desktop %s but not a later unrelated chmod",
  async (action) => {
    const f = await fixture("merge-rebase");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const [name] = await f.conflicts();
    const stage = (await f.git(["ls-files", "-u", "-z", "--", name]))
      .split("\0")
      .find((r) => r.includes(" 3\t"))!;
    await f.gitRaw(
      ["update-index", "-z", "--index-info"],
      stage.replace(/^100644/, "100755") + "\0",
    );
    await f.resolve();
    expect((await fs.stat(path.join(f.root, name))).mode & 0o777).toBe(0o755);
    const record = await f.record();
    expect(record.resolvedModes).toContainEqual({ path: name, mode: 0o755 });
    await fs.chmod(path.join(f.root, name), 0o700);
    await expect(f.prepare(action)).rejects.toThrow(/права/);
    await fs.chmod(path.join(f.root, name), 0o755);
    expect(
      await f.sequence.execute((await f.prepare(action)).token),
    ).toMatchObject({ outcome: "completed" });
  },
  30000,
);
it("saving an external stopped operation never enables Desktop continuation", async () => {
  const f = await fixture("merge-rebase", true);
  await f.resolve();
  expect(await f.record()).toMatchObject({
    operation: "resolve",
    state: "completed",
  });
  await expect(f.prepare("continue")).rejects.toThrow(
    /происхождени|внешн|терминал/,
  );
}, 30000);

it.each(["text", "incoming"] as const)(
  "saving %s never adopts a pre-existing external chmod",
  async (kind) => {
    const f = await fixture("merge-rebase");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const [name] = await f.conflicts();
    await fs.chmod(path.join(f.root, name), 0o600);
    await f.resolve(kind);
    expect((await f.record()).resolvedModes).toBeUndefined();
    for (const action of ["continue", "abort"] as const)
      await expect(f.prepare(action)).rejects.toThrow(/права/);
  },
  30000,
);
