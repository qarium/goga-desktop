import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import path from "node:path";
import { CommandExitError } from "../../src/host/process";

export type Scenario =
  "merge-rebase" | "apply-rebase" | "cherry-pick" | "revert";
export interface OperationFixture {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  original: string;
  onto: string;
  branch: string;
  sources: string[];
  command: "rebase" | "cherry-pick" | "revert";
  git(args: string[]): Promise<string>;
  write(name: string, value: string): Promise<void>;
  read(name: string): Promise<string>;
  conflicts(): Promise<string[]>;
  resolve(): Promise<string[]>;
  dispose(): Promise<void>;
}

/** Independent synthetic repository, never a clone of user data. No inherited
 * Git config/env, external editor, hooks or transport. Every child is awaited
 * before removing only this fixture's private root. */
export async function createOperationFixture(
  scenario: Scenario,
  options: { commits: number; conflictAt: number[] },
): Promise<OperationFixture> {
  const { commits, conflictAt } = options;
  if (
    !Number.isInteger(commits) ||
    commits < 1 ||
    commits > 128 ||
    !conflictAt.length ||
    conflictAt.some((n) => !Number.isInteger(n) || n < 1 || n > commits)
  )
    throw Error("Invalid operation fixture sequence");
  const base = await fs.mkdtemp("/private/tmp/goga-operation-fixture-");
  const root = path.join(base, "repo"),
    home = path.join(base, "home");
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const dispose = async () => {
    closed = true;
    await Promise.allSettled([...pending]);
    await fs.rm(base, { recursive: true, force: true });
  };
  try {
    await fs.mkdir(root);
    await fs.mkdir(home);
    const env: NodeJS.ProcessEnv = {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: home,
      TMPDIR: base,
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_EDITOR: ":",
      GIT_SEQUENCE_EDITOR: "/usr/bin/false",
      GIT_AUTHOR_DATE: "2020-01-02T03:04:05+0000",
      GIT_COMMITTER_DATE: "2020-01-02T03:04:05+0000",
    };
    const exec = promisify(execFile);
    const git = async (args: string[]) => {
      if (closed) throw Error("Operation fixture closed");
      const call = exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "protocol.allow=never",
          ...args,
        ],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      pending.add(call);
      try {
        return (await call).stdout;
      } catch (error) {
        const e = error as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        throw new CommandExitError(
          e.message,
          typeof e.code === "number" ? e.code : null,
          e.stdout,
          e.stderr,
        );
      } finally {
        pending.delete(call);
      }
    };
    const write = (name: string, value: string) =>
      fs.writeFile(path.join(root, name), value);
    const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Fixture Author"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    for (let n = 1; n <= commits; n++) await write(`file-${n}`, "base\n");
    await write("untouched", "keep\n");
    await write(".gitignore", "ignored\n");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await git(["checkout", "-b", "topic"]);
    const sources: string[] = [];
    for (let n = 1; n <= commits; n++) {
      await write(`file-${n}`, `change ${n}\n`);
      await git(["commit", "-am", `change ${n}`]);
      sources.push((await git(["rev-parse", "HEAD"])).trim());
    }
    if (scenario === "revert") sources.reverse();
    else await git(["checkout", "main"]);
    for (const n of conflictAt) {
      const file = scenario === "revert" ? commits + 1 - n : n;
      await write(`file-${file}`, `upstream ${file}\n`);
    }
    await git(["commit", "-am", "upstream"]);
    const onto = (await git(["rev-parse", "HEAD"])).trim();
    const rebase = scenario.endsWith("rebase");
    if (rebase) await git(["checkout", "topic"]);
    const original = (await git(["rev-parse", "HEAD"])).trim();
    const branch = (await git(["symbolic-ref", "--short", "HEAD"])).trim();
    const command = rebase ? "rebase" : (scenario as "cherry-pick" | "revert");
    const conflicts = async () =>
      (await git(["diff", "--name-only", "--diff-filter=U", "-z"]))
        .split("\0")
        .filter(Boolean);
    try {
      await git(
        rebase
          ? [
              "rebase",
              scenario === "merge-rebase" ? "--merge" : "--apply",
              "main",
            ]
          : [command, ...sources],
      );
      throw Error("Fixture did not stop at a conflict");
    } catch (error) {
      if (
        !(error instanceof CommandExitError) ||
        error.exitCode !== 1 ||
        !(await conflicts()).length
      )
        throw error;
    }
    await write("ignored", "preserve ignored\n");
    await write("untracked", "preserve untracked\n");
    return {
      root,
      home,
      env,
      original,
      onto,
      branch,
      sources,
      command,
      git,
      write,
      read,
      conflicts,
      dispose,
      async resolve() {
        const names = await conflicts();
        for (const name of names) await write(name, `resolved ${name}\n`);
        if (names.length) await git(["add", "--", ...names]);
        return names;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
