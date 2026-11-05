import { installGitFixtureScope } from "./git-test-scope";
import * as fs from "node:fs/promises";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import { NodeRunner, type ByteCommandResult } from "../../src/host/process";
import { nativeGitIndex } from "../../src/host/git-index-scope";
import { GitWorkspaceReader } from "../../src/host/git-workspace-reader";
import { GitCommitCoordinator } from "../../src/host/git-commit-coordinator";
import { NativeGitWorkspaceActions } from "../../src/host/git-native-commit";
import { NativeGitJournal } from "../../src/host/git-native-journal";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../../src/host/git-native-context";

export function installNativeCommitFixture() {
  const fixtureScope = installGitFixtureScope();
  async function fixture(
    unborn = false,
    format = "sha1",
    deadline?: number,
    globalConfig?: string,
    prototype = false,
  ) {
    const dir = await fs.mkdtemp("/private/tmp/goga-native-commit-");
    fixtureScope().cleanup(() => fs.rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, "repo"),
      home = path.join(dir, "home"),
      directory = path.join(home, "journal");
    await fs.mkdir(root);
    await fs.mkdir(home);
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig
        ? path.join(home, ".gitconfig")
        : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (globalConfig)
      await fs.writeFile(path.join(home, ".gitconfig"), globalConfig);
    const runner = fixtureScope.runner(new NodeRunner(deadline, env));
    const privateIndexes = new Set<string>();
    fixtureScope().cleanup(async () => {
      await runner.dispose();
      // Faults below are injected after the test child has settled. Production
      // correctly retains unknown-outcome metadata; fixtures can remove their own.
      for (const folder of privateIndexes)
        await fs.rm(folder, { recursive: true, force: true });
    });
    const git = (args: string[], stdin?: string) =>
      runner.command("git", args, root, env, stdin);
    const write = (name: string, data: string | Buffer) =>
      fs.writeFile(path.join(root, name), data);
    await git(["init", "-b", "main", `--object-format=${format}`]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    if (!unborn) {
      await write("selected", "base\n");
      await write("other", "base\n");
      await git(["add", "."]);
      await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "base"]);
    }
    const reader = new GitWorkspaceReader({
      root,
      scope: "project",
      verify: async () => {},
      git: async (args) => (await git(args)).stdout,
    });
    const external = new AsyncResource("native-commit-fixture-external");
    const commands: string[][] = [];
    const nativeReads: string[][] = [];
    const sourceReads: string[][] = [];
    let afterNativeRead:
      ((args: readonly string[]) => Promise<void>) | undefined;
    let fault:
      | ((
          command: string,
          result: ByteCommandResult,
        ) => Promise<ByteCommandResult>)
      | undefined;
    let before: ((command: string) => Promise<void>) | undefined;
    let owner = "initial",
      now = 1000;
    let afterContext: (() => void) | undefined;
    const journal = new NativeGitJournal({ directory });
    const context = {
      root,
      scope: "project",
      ownerKey: "owner",
      verify: async () => {},
      snapshot: () => reader.snapshot(),
      git: (args: string[], options?: { stdin?: string }) => {
        sourceReads.push([...args]);
        return git(args, options?.stdin);
      },
      native: createNativeGitCapability({
        root,
        env,
        journal,
        owner: async () => ({
          scope: "project",
          projectPath: root,
          registryRevision: nativeIntent(owner),
        }),
        runner: {
          commandBytes: async (input) => {
            if (nativeGitIndex())
              privateIndexes.add(path.dirname(nativeGitIndex()!));
            const candidate = [
              "commit",
              "add",
              "update-index",
              "update-ref",
            ].find((c) => input.args.includes(c));
            const command =
              candidate === "update-index" && !nativeGitIndex()
                ? "publish-index"
                : candidate === "update-ref" && !nativeGitIndex()
                  ? "publish-ref"
                  : candidate;
            if (command) {
              commands.push([...input.args]);
              if (before)
                await external.runInAsyncScope(before, undefined, command);
            }
            const result = await runner.commandBytes(input);
            nativeReads.push([...input.args]);
            if (afterNativeRead)
              await external.runInAsyncScope(
                afterNativeRead,
                undefined,
                input.args,
              );
            return command && fault
              ? external.runInAsyncScope(fault, undefined, command, result)
              : result;
          },
        },
      }),
    };
    const actions = new (
      prototype ? GitCommitCoordinator : NativeGitWorkspaceActions
    )({
      now: () => now,
      context: async (_scope, fn) => {
        const result = await fn(context);
        afterContext?.();
        return result;
      },
    });
    const prepare = async (paths = ["selected"], message = "Selected files") =>
      actions.prepare({
        scope: "project",
        revision: (await reader.snapshot()).revision,
        paths,
        message,
      });
    const head = async () => (await git(["rev-parse", "HEAD"])).stdout.trim();
    return {
      root,
      home,
      dir,
      index: () => fs.readFile(path.join(root, ".git/index")),
      setNow: (value: number) => {
        now = value;
      },
      directory,
      journal,
      git,
      write,
      reader,
      actions,
      prepare,
      head,
      commands,
      nativeReads,
      sourceReads,
      setAfterNativeRead: (fn: typeof afterNativeRead) =>
        (afterNativeRead = fn),
      setAfterContext: (fn: typeof afterContext) => (afterContext = fn),
      context,
      setFault: (fn: typeof fault) => (fault = fn),
      setBefore: (fn: typeof before) => (before = fn),
      setOwner: (v: string) => (owner = v),
    };
  }
  return { fixtureScope, fixture };
}
