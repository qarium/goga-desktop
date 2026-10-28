import { installGitFixtureScope } from "./git-test-scope";
import path from "node:path";
import {
  createOperationFixture,
  type Scenario,
} from "./git-operation-fixtures";
import {
  NativeGitSequence,
  type NativeSequenceStart,
} from "../../src/host/git-native-sequence";
import { NativeGitJournal } from "../../src/host/git-native-journal";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../../src/host/git-native-context";
import { NodeRunner, type ByteCommandResult } from "../../src/host/process";
import { GitWorkspaceReader } from "../../src/host/git-workspace-reader";

export const nativeSequenceScope = installGitFixtureScope();

/** All writes/commands target disposable synthetic repositories and HOME. */
export async function nativeSequenceFixture(
  scenario: Scenario,
  commits = 3,
  conflictAt = [1, 3],
) {
  const f = await createOperationFixture(scenario, { commits, conflictAt });
  nativeSequenceScope().cleanup(f.dispose);
  await f.git([f.command, "--abort"]);
  const env: NodeJS.ProcessEnv = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = nativeSequenceScope.runner(new NodeRunner(10000, env));
  nativeSequenceScope().cleanup(() => runner.dispose());
  const directory = path.join(f.home, "regression-journal");
  const calls: string[][] = [];
  let afterCommand: (() => Promise<void>) | undefined;
  let verifyHook: (() => Promise<void>) | undefined;
  let resultHook:
    ((result: ByteCommandResult) => ByteCommandResult) | undefined;
  const git = (args: string[], stdin?: string) =>
    runner.command("git", args, f.root, env, stdin);
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "regression",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  const context = {
    root: f.root,
    scope: "regression",
    ownerKey: "regression-owner",
    verify: async () => {
      await verifyHook?.();
    },
    git,
    snapshot: () => reader.snapshot(),
    native: createNativeGitCapability({
      root: f.root,
      env,
      journal: new NativeGitJournal({ directory }),
      owner: async () => ({
        scope: "regression",
        projectPath: f.root,
        registryRevision: nativeIntent("owner"),
      }),
      runner: {
        commandBytes: async (request) => {
          if (
            request.cwd === f.root &&
            request.args.includes(f.command) &&
            !request.args.includes("--edit-todo")
          )
            calls.push([...request.args]);
          const output = await runner.commandBytes(request);
          if (
            request.cwd === f.root &&
            request.args.includes(f.command) &&
            !request.args.includes("--edit-todo")
          ) {
            await afterCommand?.();
            return resultHook?.(output) ?? output;
          }
          return output;
        },
      },
    }),
  };
  const restart = () => {
    context.native.journal = new NativeGitJournal({ directory });
    return new NativeGitSequence({
      context: async (_scope, fn) => fn(context),
    });
  };
  const engine = restart();
  const prepare = async (action: "continue" | "abort", target = engine) =>
    target.prepare({
      scope: "regression",
      operation: f.command,
      action,
      revision: (await reader.snapshot()).revision,
    });
  const start = async (input?: NativeSequenceStart) => {
    const descriptor =
      input ??
      (f.command === "rebase"
        ? {
            operation: f.command,
            source: f.onto,
            backend:
              scenario === "apply-rebase"
                ? ("apply" as const)
                : ("merge" as const),
          }
        : { operation: f.command, commits: f.sources });
    return engine.execute(
      (await engine.prepareStart("regression", descriptor)).token,
    );
  };
  return {
    ...f,
    env,
    gitInput: git,
    engine,
    reader,
    prepare,
    start,
    restart,
    calls,
    directory,
    verify: (fn: () => Promise<void>) => {
      verifyHook = fn;
    },
    nativeResult: (fn: (result: ByteCommandResult) => ByteCommandResult) => {
      resultHook = fn;
    },
    afterNative: (fn: () => Promise<void>) => {
      afterCommand = fn;
    },
  };
}
