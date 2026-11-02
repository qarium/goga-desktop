import { tmpdir } from "node:os";
import { installGitFixtureScope } from "./git-test-scope";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../../src/host/service";
import {
  ByteCommandError,
  CommandExitError,
  NodeRunner,
  type Runner,
} from "../../src/host/process";
import { DesktopStateStore } from "../../src/host/desktop-state";
import { CloneManager } from "../../src/host/clones";
import { worktreeContextRef } from "../../src/shared/worktrees";
import type { Run } from "../../src/shared/types";

export async function repositoryActionsFixture(
  fixtureScope: ReturnType<typeof installGitFixtureScope>,
) {
  const root = await fs.mkdtemp("/private/tmp/goga-repository-actions-");
  fixtureScope().cleanup(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    repo = path.join(root, "primary"),
    remote = path.join(root, "remote.git");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const node = fixtureScope.runner(new NodeRunner(10000, env));
  fixtureScope().cleanup(() => node.dispose());
  const git = async (args: string[], cwd = repo) =>
    (
      await node.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          ...args,
        ],
        cwd,
        env,
      )
    ).stdout.trim();
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "base"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["branch", "alpha"]);
  await git(["init", "--bare", remote]);
  await git(["remote", "add", "origin", remote]);
  await git(["push", "-u", "origin", "main"]);
  let config = "# topics\nbase_ref: main\nupdate:\n  strategy: merge\n";
  let before:
    ((exe: string, args: string[], cwd: string) => Promise<void>) | undefined;
  const calls: { exe: string; args: string[]; cwd: string }[] = [];
  const runner: Runner = {
    commandBytes: async (command) => {
      const witnessPrefix = path.join(
        await fs.realpath(tmpdir()),
        "goga-native-witness-",
      );
      const witness =
        command.cwd.startsWith(witnessPrefix) &&
        (await fs.realpath(command.cwd)) === command.cwd;
      if (
        (!command.cwd.startsWith(root + path.sep) && !witness) ||
        !path.isAbsolute(command.executable)
      )
        throw Error("Outside native fixture");
      calls.push({
        exe: command.executable,
        args: [...command.args],
        cwd: command.cwd,
      });
      await before?.(command.executable, [...command.args], command.cwd);
      return node.commandBytes({ ...command, env: { ...env, ...command.env } });
    },
    command: async (exe, args, cwd, overrides, stdin) => {
      if (!cwd.startsWith(root + path.sep)) throw Error("Outside fixture");
      calls.push({ exe, args: [...args], cwd });
      await before?.(exe, args, cwd);
      if (exe === "FAKE-GOGA") {
        if (args.join(" ") === "config topics")
          return { stdout: config, stderr: "" };
        if (
          args[0] === "topics" &&
          (args.includes("update") || args.includes("propagate"))
        )
          return { stdout: "updated", stderr: "" };
        throw Error("Unexpected mocked Goga command");
      }
      if (exe !== "git" || args.some((a) => /^(https?|ssh|git):\/\//.test(a)))
        throw Error("Network/native execution forbidden");
      return node.command(exe, args, cwd, { ...env, ...overrides }, stdin);
    },
    start: () => {
      throw Error("Real pipelines forbidden");
    },
    kill: () => {
      throw Error("No processes");
    },
    dispose: () => node.dispose(),
  };
  const service = fixtureScope().own(
    new HostService({
      home,
      dataDir: path.join(root, "data"),
      goga: "FAKE-GOGA",
      runner,
    }),
  );
  fixtureScope().cleanup(async () => {
    (service as unknown as { runList: Run[] }).runList = [];
    await service.dispose();
  });
  const project = await service.addProject(repo);
  const owner = await new CloneManager(home, runner).ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "alpha",
    branch: "alpha",
  });
  await fs.writeFile(path.join(owner.path, "topic"), "topic\n");
  await git(["add", "."], owner.path);
  await git(["commit", "-m", "topic"], owner.path);
  calls.length = 0;
  const ref = worktreeContextRef(owner);
  return {
    root,
    home,
    repo,
    remote,
    owner,
    ref,
    project,
    service,
    git,
    calls,
    config: (text: string) => {
      config = text;
    },
    intercept: (fn: typeof before) => {
      before = fn;
    },
    action: (
      action:
        "sync" | "publish" | "update-base" | "propagate" | "update-remote",
      topic = true,
    ) =>
      service.runRepositoryAction({
        projectId: project.id,
        ...(topic ? { context: ref } : {}),
        action,
      }),
  };
}
