import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { CloneManager } from "../../src/host/clones";
import { DesktopStateStore } from "../../src/host/desktop-state";
import { NodeRunner } from "../../src/host/process";
import { HostService } from "../../src/host/service";
import { worktreeContextRef } from "../../src/shared/worktrees";
import { installGitFixtureScope } from "./git-test-scope";
export const fixtureScope = installGitFixtureScope();

export async function fixture(
  backend: "merge" | "apply" = "merge",
  remainingCommits = 0,
) {
  const base = await mkdtemp("/private/tmp/goga-rebase-save-");
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
  // Use the production finite deadline, including nested prepared-ref checks.
  const rawRunner = new NodeRunner(undefined, env);
  fixtureScope().cancelOnTimeout(() => rawRunner.dispose());
  const runner = fixtureScope().own(rawRunner);
  fixtureScope().cleanup(() => runner.dispose());
  const git = async (cwd: string, args: string[], stdin?: string) =>
    (
      await runner.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          ...args,
        ],
        cwd,
        env,
        stdin,
      )
    ).stdout;
  await git(root, ["init", "-b", "main"]);
  for (const name of ["file.txt", "second.txt", "other.txt"])
    await writeFile(path.join(root, name), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  await git(root, ["branch", "feature"]);
  const rawHost = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent-fixture-goga",
  });
  fixtureScope().cleanup(() => rawHost.dispose());
  const host = fixtureScope().own(rawHost);
  const project = await host.addProject(root),
    manager = new CloneManager(home, runner);
  const record = await manager.ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "feature",
    branch: "feature",
  });
  await git(record.path, ["checkout", "-b", "upstream-fixture"]);
  for (const name of ["file.txt", "second.txt"])
    await writeFile(path.join(record.path, name), "upstream\n");
  await git(record.path, ["commit", "-am", "upstream"]);
  await git(record.path, ["checkout", "feature"]);
  for (const name of ["file.txt", "second.txt"])
    await writeFile(path.join(record.path, name), "topic\n");
  await git(record.path, ["commit", "-am", "topic"]);
  for (let index = 0; index < remainingCommits; index++) {
    const name = `later-${index}.txt`;
    await writeFile(path.join(record.path, name), `later ${index}\n`);
    await git(record.path, ["add", "--", name]);
    await git(record.path, ["commit", "-m", `later ${index}`]);
  }
  await expect(
    git(record.path, ["rebase", `--${backend}`, "upstream-fixture"]),
  ).rejects.toThrow();
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

export async function request(
  f: Awaited<ReturnType<typeof fixture>>,
  name = "file.txt",
) {
  const snapshot = await f.host.readGitWorkspace(f.scope);
  const req = { scope: f.scope, revision: snapshot.revision, path: name };
  const doc = await f.host.readGitConflict(req);
  return { ...req, fingerprint: doc.fingerprint };
}

export async function stable(f: Awaited<ReturnType<typeof fixture>>) {
  return JSON.stringify(
    await Promise.all([
      tree(f.root),
      tree(f.metadata),
      tree(path.join(f.record.gitCommonDir, "HEAD")),
      tree(path.join(f.record.gitCommonDir, "refs")),
      tree(path.join(f.record.gitCommonDir, "ORIG_HEAD")),
      tree(path.join(f.record.gitCommonDir, "REBASE_HEAD")),
      tree(path.join(f.manager.store.root, "registry.json")),
    ]),
  );
}

export async function changeFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  change: string,
) {
  const gd = f.record.gitCommonDir;
  if (change === "operation")
    await writeFile(
      path.join(f.metadata, "done"),
      (await readFile(path.join(f.metadata, "done"), "utf8")) + "# changed\n",
    );
  if (change === "HEAD")
    await writeFile(
      path.join(gd, "HEAD"),
      await readFile(path.join(f.metadata, "orig-head")),
    );
  if (change === "ref")
    await writeFile(
      path.join(gd, "refs/heads/feature"),
      await readFile(path.join(gd, "HEAD")),
    );
  if (change === "config")
    await f.git(f.record.path, ["config", "core.eol", "crlf"]);
  if (change === "remote")
    await f.git(f.record.path, [
      "config",
      "remote.desktop-source.url",
      "/nonexistent-fixture-source",
    ]);
  if (change === "index") {
    await writeFile(path.join(f.record.path, "other.txt"), "changed stage\n");
    await f.git(f.record.path, ["add", "--", "other.txt"]);
  }
  if (change === "content")
    await writeFile(path.join(f.record.path, "file.txt"), "new working edit\n");
  if (change === "revision")
    await f.manager.store.update(
      { ...f.record, revision: randomUUID() },
      f.record.revision,
    );
  if (change === "owner")
    await writeFile(path.join(gd, "desktop-owner.json"), "{}\n");
  if (change === "owner pair") {
    const ownerFile = path.join(
      f.manager.store.root,
      `.owner-${f.scope.contextId}.json`,
    );
    const owner = JSON.parse(await readFile(ownerFile, "utf8")),
      nonce = randomUUID();
    await writeFile(ownerFile, JSON.stringify({ ...owner, nonce }));
    await writeFile(
      path.join(gd, "desktop-owner.json"),
      JSON.stringify({ contextId: f.scope.contextId, nonce }),
    );
  }
  if (change === "registry")
    await rm(path.join(f.manager.store.root, "registry.json"));
  if (change === "source") {
    await rename(f.root, f.root + "-moved");
    await mkdir(f.root);
    await writeFile(path.join(f.root, "sentinel"), "untouched\n");
  }
  if (change === "source topology")
    await writeFile(
      path.join(f.root, ".git/commondir"),
      "/nonexistent-fixture-common\n",
    );
  if (change === "plain detached") {
    await rm(f.metadata, { recursive: true });
    await rm(path.join(gd, "REBASE_HEAD"));
  }
  if (change === "wrong reason")
    await f.manager.store.update(
      {
        ...f.record,
        state: "conflict",
        reason: "repository",
        revision: randomUUID(),
      },
      f.record.revision,
    );
  if (change === "wrong branch")
    await writeFile(path.join(f.metadata, "head-name"), "refs/heads/main\n");
  if (change === "malformed")
    await writeFile(
      path.join(f.metadata, "git-rebase-todo"),
      "exec forbidden\n",
    );
  if (change === "mixed")
    await writeFile(
      path.join(gd, "MERGE_HEAD"),
      await readFile(path.join(gd, "HEAD")),
    );
  if (change === "symlink") {
    await rename(
      path.join(f.record.path, "file.txt"),
      path.join(f.record.path, "original.txt"),
    );
    await symlink("original.txt", path.join(f.record.path, "file.txt"));
  }
  if (change === "hardlink")
    await link(
      path.join(f.record.path, "file.txt"),
      path.join(f.record.path, "linked.txt"),
    );
  if (change === "metadata link") {
    await rename(f.metadata, f.metadata + "-original");
    await symlink(f.metadata + "-original", f.metadata);
  }
  if (change === "settings") {
    const store = new DesktopStateStore(f.home, path.join(f.base, "data")),
      doc = await store.read(f.project.id);
    await store.save(
      f.project.id,
      {
        ...doc.value,
        env: [{ key: "CHANGED", value: "yes", secret: false, runtime: false }],
      },
      doc.version,
    );
  }
}

export const races = [
  "operation",
  "HEAD",
  "ref",
  "config",
  "remote",
  "index",
  "content",
  "revision",
  "owner",
  "owner pair",
  "registry",
  "source",
  "source topology",
  "settings",
];

export async function retainedNativeRecovery(
  f: Awaited<ReturnType<typeof fixture>>,
  result: { recoveryPath?: string },
  state: string,
) {
  expect(result.recoveryPath).toBeTruthy();
  const record = JSON.parse(await readFile(result.recoveryPath!, "utf8"));
  expect(record).toMatchObject({ state, recovery: expect.any(Object) });
  // The old private journal directory is gone. Verify durable recovery and the
  // actual write fence instead of asserting an artificial index/HEAD pin.
  await expect(
    (f.host as any).nativeGitJournal.assertAdmission(
      f.record.path,
      record.recovery.owner,
    ),
  ).rejects.toThrow();
}
