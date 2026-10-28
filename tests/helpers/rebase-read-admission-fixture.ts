import { gitIntegrationBudget } from "./git-integration";
import { installGitFixtureScope } from "./git-test-scope";
import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  rename,
  symlink,
  chmod,
  link,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { NativeGitSequence } from "../../src/host/git-native-sequence";
import type { GitMergeContext } from "../../src/host/git-merge-safety";
import type { ScopeRef } from "../../src/shared/context";
import { HostService } from "../../src/host/service";
import { NodeRunner } from "../../src/host/process";
import { CloneManager } from "../../src/host/clones";
import { CloneStore } from "../../src/host/clone-store";
import { worktreeContextRef } from "../../src/shared/worktrees";
import { isOfflineGitRead } from "../../src/host/read-scope";
export const fixtureScope = installGitFixtureScope();

export async function fixture(
  backend: "merge" | "apply" = "merge",
  remainingCommits = 0,
  controlled = false,
) {
  const base = await mkdtemp("/private/tmp/goga-rebase-read-");
  fixtureScope().cleanup(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    root = path.join(base, "source");
  await mkdir(home);
  await mkdir(root);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const runner = fixtureScope.runner(new NodeRunner(10000, env));
  fixtureScope().cleanup(() => runner.dispose());
  const git = async (cwd: string, args: string[]) =>
    (
      await runner.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        cwd,
        env,
      )
    ).stdout;
  await git(root, ["init", "-b", "main"]);
  await writeFile(path.join(root, "file.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  await git(root, ["branch", "feature"]);
  const host = fixtureScope().own(
    new HostService({
      home,
      dataDir: path.join(base, "data"),
      runner,
      goga: "/nonexistent-fixture-goga",
    }),
  );
  fixtureScope().cleanup(() => host.dispose());
  const project = await host.addProject(root),
    manager = new CloneManager(home, runner);
  const record = await manager.ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "feature",
    branch: "feature",
  });
  await git(record.path, ["checkout", "-b", "upstream-fixture"]);
  await writeFile(path.join(record.path, "file.txt"), "upstream\n");
  await git(record.path, ["commit", "-am", "upstream"]);
  await git(record.path, ["checkout", "feature"]);
  await writeFile(path.join(record.path, "file.txt"), "topic\n");
  await git(record.path, ["commit", "-am", "topic"]);
  for (let index = 0; index < remainingCommits; index++) {
    const name = `later-${index}.txt`;
    await writeFile(path.join(record.path, name), `later ${index}\n`);
    await git(record.path, ["add", "--", name]);
    await git(record.path, ["commit", "-m", `later ${index}`]);
  }
  if (controlled) {
    const engine = new NativeGitSequence({
      context: (scope, action) =>
        (
          host as unknown as {
            gitNativeSequenceContext<T>(
              scope: ScopeRef,
              action: (c: GitMergeContext) => Promise<T>,
            ): Promise<T>;
          }
        ).gitNativeSequenceContext(scope, action),
    });
    const preview = await engine.prepareStart(worktreeContextRef(record), {
      operation: "rebase",
      backend,
      source: (
        await git(record.path, ["rev-parse", "upstream-fixture"])
      ).trim(),
    });
    expect(await engine.execute(preview.token)).toMatchObject({
      outcome: "conflicts",
    });
  } else {
    await expect(
      git(record.path, ["rebase", `--${backend}`, "upstream-fixture"]),
    ).rejects.toThrow();
  }
  expect(await git(record.path, ["ls-files", "-u"])).not.toBe("");
  expect(
    (await git(record.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
  ).toBe("HEAD");
  return {
    base,
    home,
    root,
    runner,
    git,
    host,
    project,
    manager,
    record,
    scope: worktreeContextRef(record),
    metadata: path.join(record.gitCommonDir, `rebase-${backend}`),
  };
}

export async function tree(root: string): Promise<string> {
  const result: unknown[] = [];
  async function visit(file: string) {
    const s = await lstat(file, { bigint: true });
    result.push([
      file,
      String(s.mode),
      String(s.ino),
      String(s.mtimeNs),
      String(s.ctimeNs),
      s.isFile()
        ? createHash("sha256")
            .update(await readFile(file))
            .digest("hex")
        : "directory",
    ]);
    if (s.isDirectory())
      for (const name of (await readdir(file)).sort())
        await visit(path.join(file, name));
  }
  await visit(root);
  return JSON.stringify(result);
}

export async function repositories(f: Awaited<ReturnType<typeof fixture>>) {
  // Project-settings reads retain their existing service-private lock protocol.
  // They must not mutate either repository or the managed clone registry/owners.
  return JSON.stringify([await tree(f.root), await tree(f.manager.store.root)]);
}
