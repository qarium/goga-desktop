import * as fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { NodeRunner } from "../../src/host/process";
import { GitHistoryReader } from "../../src/host/git-history-reader";

export async function historyFixture(
  cleanup: (() => Promise<unknown>)[],
  format: "sha1" | "sha256" = "sha1",
) {
  const dir = await fs.mkdtemp("/private/tmp/goga-git-history-");
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Автор",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = async (args: string[]) =>
    (
      await runner.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        root,
        env,
      )
    ).stdout;
  await git(["init", "-b", "main", `--object-format=${format}`]);
  const write = async (name: string, value: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), value);
  };
  const commit = async (message = "Изменение") => {
    await git(["add", "."]);
    await git(["commit", "-m", message]);
    return (await git(["rev-parse", "HEAD"])).trim();
  };
  const calls: string[][] = [],
    verify = vi.fn(async () => {});
  const reader = new GitHistoryReader({
    scope: "project",
    root,
    verify,
    git: async (args) => {
      calls.push(args);
      return git(args);
    },
  });
  return { root, dir, home, git, write, commit, calls, verify, reader, runner };
}
