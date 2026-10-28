import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
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
import { NativeGitSequence } from "../src/host/git-native-sequence";
import type { GitMergeContext } from "../src/host/git-merge-safety";
import type { ScopeRef } from "../src/shared/context";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { CloneStore } from "../src/host/clone-store";
import { worktreeContextRef } from "../src/shared/worktrees";
import { isOfflineGitRead } from "../src/host/read-scope";

async function fixture(
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
async function tree(root: string): Promise<string> {
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
async function repositories(f: Awaited<ReturnType<typeof fixture>>) {
  // Project-settings reads retain their existing service-private lock protocol.
  // They must not mutate either repository or the managed clone registry/owners.
  return JSON.stringify([await tree(f.root), await tree(f.manager.store.root)]);
}

it.each(["merge", "apply"] as const)(
  "reads a real paused %s rebase in the exact managed clone, without source/clone/registry mutation",
  fixtureScope.run(async (backend) => {
    const f = await fixture(backend);
    const before = await repositories(f);
    const original = f.runner.command.bind(f.runner);
    vi.spyOn(f.runner, "command").mockImplementation(
      (exe, args, cwd, env, stdin) => {
        expect(exe).toBe("git");
        expect(isOfflineGitRead()).toBe(true);
        expect(
          args.some((arg) =>
            [
              "fetch",
              "update-ref",
              "checkout",
              "add",
              "commit",
              "rebase",
            ].includes(arg),
          ),
        ).toBe(false);
        return original(exe, args, cwd, env, stdin);
      },
    );
    const snapshot = await f.host.readGitWorkspace(f.scope);
    expect(snapshot.root).toBe(f.record.path);
    expect(snapshot.branch).toBeNull();
    expect(snapshot.operation).toBe("rebase");
    expect(snapshot.files.find((file) => file.path === "file.txt")?.kind).toBe(
      "conflict",
    );
    const request = {
      scope: f.scope,
      revision: snapshot.revision,
      path: "file.txt",
    };
    expect((await f.host.readGitDiff(request)).scope).toEqual(f.scope);
    const conflict = await f.host.readGitConflict(request);
    expect(conflict.base.text).toBe("base\n");
    expect(conflict.current.text).toBe("upstream\n");
    expect(conflict.incoming.text).toBe("topic\n");
    expect(await repositories(f)).toBe(before);
  }),
  gitIntegrationBudget(30000),
);

it.each(["merge", "apply"] as const)(
  "reads a native multi-commit %s rebase stopped before its remaining commit",
  fixtureScope.run(async (backend) => {
    const f = await fixture(backend, 1);
    // Public refs prove there is a later source commit; no private counters/patch names.
    expect(
      (
        await f.git(f.record.path, [
          "rev-list",
          "--count",
          "upstream-fixture..feature",
        ])
      ).trim(),
    ).toBe("2");
    const before = await repositories(f),
      snapshot = await f.host.readGitWorkspace(f.scope);
    expect(snapshot.operation).toBe("rebase");
    expect(snapshot.branch).toBeNull();
    const document = await f.host.readGitConflict({
      scope: f.scope,
      revision: snapshot.revision,
      path: "file.txt",
    });
    expect(document.current.text).toBe("upstream\n");
    expect(document.incoming.text).toBe("topic\n");
    expect(await repositories(f)).toBe(before);
  }),
  gitIntegrationBudget(30000),
);

it.each([
  "malformed todo",
  "malformed earlier done",
  "inconsistent counters",
  "ready repository reason",
  "missing current apply patch",
])(
  "separates opaque control drift from physical read ownership: %s",
  fixtureScope.run(async (change) => {
    const f = await fixture(
      change === "missing current apply patch" ? "apply" : "merge",
      0,
      true,
    );
    await f.manager.resolveGitRead(f.scope);
    if (change === "malformed todo")
      await writeFile(
        path.join(f.metadata, "git-rebase-todo"),
        "this-is-not-a-git-command\n",
      );
    if (change === "malformed earlier done")
      await writeFile(
        path.join(f.metadata, "done"),
        "this-is-not-a-git-command\n" +
          (await readFile(path.join(f.metadata, "done"), "utf8")),
      );
    if (change === "inconsistent counters") {
      await writeFile(path.join(f.metadata, "msgnum"), "2\n");
      await writeFile(path.join(f.metadata, "end"), "2\n");
    }
    if (change === "ready repository reason") {
      const row = await f.manager.store.update(
        { ...f.record, reason: "repository", revision: randomUUID() },
        f.record.revision,
      );
      f.scope = worktreeContextRef(row);
    }
    if (change === "missing current apply patch")
      await rm(path.join(f.metadata, "0001"));
    const before = await repositories(f);
    if (change === "ready repository reason") {
      await expect(f.host.readGitWorkspace(f.scope)).rejects.toThrow();
    } else {
      expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
    }
    expect(await repositories(f)).toBe(before);
    if (change !== "ready repository reason") {
      const snapshot = await f.host.readGitWorkspace(f.scope);
      await expect(
        f.host.prepareGitRebaseOperation({
          scope: f.scope,
          revision: snapshot.revision,
          action: "abort",
        }),
      ).rejects.toThrow();
    }
  }),
  gitIntegrationBudget(30000),
);

it(
  "reconcile preserves durable owner revision while ordinary resolution rejects stopped rebase",
  fixtureScope.run(async () => {
    const f = await fixture();
    const registryBefore = await f.manager.store.read();
    const [row] = await f.manager.reconcile(f.project.id);
    expect(row.state).toBe("ready");
    expect(row.reason).toBeUndefined();
    expect(row.revision).toBe(f.scope.revision);
    expect(await f.manager.store.read()).toEqual(registryBefore);
    const before = await repositories(f);
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
    expect(
      (await f.host.readGitWorkspace(worktreeContextRef(row))).operation,
    ).toBe("rebase");
    expect(await repositories(f)).toBe(before);
  }),
  gitIntegrationBudget(30000),
);

it(
  "keeps ordinary resolver, settings, terminal and commit strict while admitting only conflict-save",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.host.readGitWorkspace(f.scope);
    await expect(f.manager.resolve(f.scope)).rejects.toThrow();
    const [row] = await f.manager.list(f.project.id),
      scope = worktreeContextRef(row);
    const snapshot = await f.host.readGitWorkspace(scope);
    const request = { scope, revision: snapshot.revision, path: "file.txt" };
    const doc = await f.host.readGitConflict(request);
    await expect(f.host.resolveTopicContext(scope)).rejects.toThrow();
    await expect(f.host.readProjectSettings(scope)).rejects.toThrow();
    await expect(f.host.prepareTerminalLaunch(scope)).rejects.toThrow();
    await expect(
      f.host.preview({
        projectId: scope.projectId,
        context: scope,
        pipeline: "build",
        workflow: "auto",
        profile: "",
        skips: [],
      }),
    ).rejects.toThrow();
    await expect(
      f.host.prepareGitCommit({
        scope,
        revision: snapshot.revision,
        paths: ["file.txt"],
        message: "not allowed",
      }),
    ).rejects.toThrow();
    const before = await repositories(f);
    const preview = await f.host.prepareGitConflictSave({
      ...request,
      fingerprint: doc.fingerprint,
      resolution: { kind: "text", text: "resolved\n" },
    });
    expect(preview).toMatchObject({
      scope,
      path: "file.txt",
      branch: null,
      hooks: "disabled",
    });
    // Only the service-private lifecycle lock directory may change; neither
    // repository, owner row nor its revision is repaired by the new admission.
    expect(await tree(f.root)).toBe(JSON.parse(before)[0]);
    expect(await f.manager.list(f.project.id)).toEqual([row]);
    await expect(
      f.host.prepareGitMergeOperation({
        scope,
        revision: snapshot.revision,
        action: "abort",
      }),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(30000),
);

it(
  "the read-only registry view neither creates missing roots nor changes existing modes/timestamps and rejects lifecycle writes",
  fixtureScope.run(async () => {
    const base = await mkdtemp("/private/tmp/goga-read-only-store-");
    fixtureScope().cleanup(() => rm(base, { recursive: true, force: true }));
    const missing = new CloneStore(path.join(base, "absent-home"), "read-only");
    await expect(missing.read()).rejects.toThrow();
    expect(await readdir(base)).toEqual([]);
    const emptyHome = path.join(base, "empty-home");
    await mkdir(emptyHome);
    await expect(
      new CloneStore(emptyHome, "read-only").read(),
    ).rejects.toThrow();
    expect(await readdir(emptyHome)).toEqual([]);
    const f = await fixture();
    const store = new CloneStore(f.home, "read-only");
    const before = await tree(f.base),
      doc = await store.read();
    await store.assertOwned(f.record);
    await expect(
      store.withRepositoryLock(f.record.repositoryKey, async () => undefined),
    ).rejects.toThrow();
    await expect(
      store.update({ ...f.record, revision: randomUUID() }, f.record.revision),
    ).rejects.toThrow();
    await expect(store.write(doc.revision, doc.records)).rejects.toThrow();
    await expect(store.reserve(f.record)).rejects.toThrow();
    expect(await tree(f.base)).toBe(before);
    await chmod(store.root, 0o755);
    await expect(store.read()).rejects.toThrow();
    expect((await lstat(store.root)).mode & 0o777).toBe(0o755);
  }),
  gitIntegrationBudget(30000),
);

it.each([
  "missing onto",
  "blob onto",
  "missing stopped",
  "blob stopped",
  "unrelated stopped",
  "unrelated HEAD",
])(
  "reads opaque rebase controls but refuses journal continuation after %s",
  fixtureScope.run(async (change) => {
    const f = await fixture("merge", 0, true);
    await expect(f.manager.resolveGitRead(f.scope)).resolves.toHaveProperty(
      "operationBinding",
    );
    const blob = (
      await f.git(f.record.path, ["rev-parse", "HEAD:file.txt"])
    ).trim();
    const treeId = (
      await f.git(f.record.path, ["rev-parse", "HEAD^{tree}"])
    ).trim();
    const unrelated = (
      await f.git(f.record.path, [
        "commit-tree",
        treeId,
        "-m",
        "unrelated fixture",
      ])
    ).trim();
    const oid = change.startsWith("missing")
      ? "0".repeat(40)
      : change.startsWith("blob")
        ? blob
        : unrelated;
    if (change.endsWith("onto"))
      await writeFile(path.join(f.metadata, "onto"), oid + "\n");
    else if (change.endsWith("HEAD"))
      await writeFile(path.join(f.record.gitCommonDir, "HEAD"), oid + "\n");
    else {
      await writeFile(path.join(f.metadata, "stopped-sha"), oid + "\n");
      await writeFile(
        path.join(f.record.gitCommonDir, "REBASE_HEAD"),
        oid + "\n",
      );
    }
    const before = await repositories(f);
    await expect(f.manager.resolveGitRead(f.scope)).resolves.toHaveProperty(
      "operationBinding",
    );
    expect(await repositories(f)).toBe(before);
    const snap = await f.host.readGitWorkspace(f.scope);
    await expect(
      f.host.prepareGitRebaseOperation({
        scope: f.scope,
        revision: snap.revision,
        action: "abort",
      }),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(30000),
);

it.each([
  "head-name",
  "orig-head",
  "branch-tip",
  "malformed-oid",
  "mismatched-done",
  "missing-stopped",
  "symlink-file",
  "symlink-directory",
  "hardlink",
  "oversize",
  "mixed-merge",
  "mixed-pick",
  "mixed-revert",
  "mixed-sequencer",
  "both-backends",
  "plain-detached",
  "remote-source",
  "remote-push",
] as const)(
  "fails closed without repairing rebase metadata: %s",
  fixtureScope.run(async (change) => {
    const f = await fixture("merge", 0, true);
    await f.manager.resolveGitRead(f.scope);
    const gd = f.record.gitCommonDir,
      head = await readFile(path.join(gd, "HEAD"));
    switch (change) {
      case "head-name":
        await writeFile(
          path.join(f.metadata, "head-name"),
          "refs/heads/other\n",
        );
        break;
      case "orig-head":
        await writeFile(path.join(f.metadata, "orig-head"), head);
        await writeFile(path.join(gd, "ORIG_HEAD"), head);
        break;
      case "branch-tip":
        await f.git(f.record.path, [
          "update-ref",
          "refs/heads/feature",
          head.toString().trim(),
        ]);
        break;
      case "malformed-oid":
        await writeFile(path.join(f.metadata, "orig-head"), "bad\0oid\n");
        break;
      case "mismatched-done":
        await writeFile(
          path.join(f.metadata, "done"),
          `pick ${head.toString().trim()} wrong-commit\n`,
        );
        break;
      case "missing-stopped":
        await rm(path.join(f.metadata, "stopped-sha"));
        break;
      case "symlink-file":
        await rm(path.join(f.metadata, "orig-head"));
        await symlink(
          path.join(gd, "ORIG_HEAD"),
          path.join(f.metadata, "orig-head"),
        );
        break;
      case "symlink-directory":
        await rename(f.metadata, f.metadata + "-saved");
        await symlink(f.metadata + "-saved", f.metadata);
        break;
      case "hardlink":
        await link(
          path.join(f.metadata, "orig-head"),
          path.join(f.metadata, "extra"),
        );
        break;
      case "oversize":
        await writeFile(
          path.join(f.metadata, "patch"),
          // Opaque control snapshot has an 8 MiB budget; no patch parser limit.
          Buffer.alloc(8 * 1024 * 1024 + 1),
        );
        break;
      case "mixed-merge":
        await writeFile(path.join(gd, "MERGE_HEAD"), head);
        break;
      case "mixed-pick":
        await writeFile(path.join(gd, "CHERRY_PICK_HEAD"), head);
        break;
      case "mixed-revert":
        await writeFile(path.join(gd, "REVERT_HEAD"), head);
        break;
      case "mixed-sequencer":
        await mkdir(path.join(gd, "sequencer"));
        break;
      case "both-backends":
        await mkdir(path.join(gd, "rebase-apply"));
        break;
      case "plain-detached":
        await rm(f.metadata, { recursive: true });
        await rm(path.join(gd, "REBASE_HEAD"));
        break;
      case "remote-source":
        await f.git(f.record.path, [
          "remote",
          "set-url",
          "desktop-source",
          path.join(f.base, "wrong-source"),
        ]);
        break;
      case "remote-push":
        await f.git(f.record.path, [
          "remote",
          "set-url",
          "--push",
          "desktop-source",
          f.root,
        ]);
        break;
    }
    const before = await repositories(f);
    const opaque = [
      "head-name",
      "orig-head",
      "branch-tip",
      "malformed-oid",
      "mismatched-done",
      "missing-stopped",
    ].includes(change);
    if (opaque)
      await expect(f.manager.resolveGitRead(f.scope)).resolves.toHaveProperty(
        "operationBinding",
      );
    else await expect(f.manager.resolveGitRead(f.scope)).rejects.toThrow();
    expect(await repositories(f)).toBe(before);
    if (opaque) {
      const snap = await f.host.readGitWorkspace(f.scope);
      await expect(
        f.host.prepareGitRebaseOperation({
          scope: f.scope,
          revision: snap.revision,
          action: "abort",
        }),
      ).rejects.toThrow();
    }
  }),
  gitIntegrationBudget(30000),
);

it.each(["missing-rebasing", "nonempty-rebasing", "applying", "abort-safety"])(
  "does not parse apply controls for display but revokes changed journal state: %s",
  fixtureScope.run(async (change) => {
    const f = await fixture("apply", 0, true);
    await f.manager.resolveGitRead(f.scope);
    if (change === "missing-rebasing")
      await rm(path.join(f.metadata, "rebasing"));
    if (change === "nonempty-rebasing")
      await writeFile(path.join(f.metadata, "rebasing"), "invalid");
    if (change === "applying")
      await writeFile(path.join(f.metadata, "applying"), "");
    if (change === "abort-safety")
      await writeFile(
        path.join(f.metadata, "abort-safety"),
        "0".repeat(40) + "\n",
      );
    await expect(f.manager.resolveGitRead(f.scope)).resolves.toHaveProperty(
      "operationBinding",
    );
    const snap = await f.host.readGitWorkspace(f.scope);
    await expect(
      f.host.prepareGitRebaseOperation({
        scope: f.scope,
        revision: snap.revision,
        action: "abort",
      }),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(30000),
);

it(
  "rejects stale/forged owner dimensions, other record states, missing/replaced clone and source without primary fallback",
  fixtureScope.run(async () => {
    const f = await fixture();
    for (const patch of [
      { projectId: "other" },
      { year: "2025" },
      { topic: "other" },
      { branch: "main" },
      { contextId: "ctx-" + "0".repeat(64) },
      { revision: randomUUID() },
    ])
      await expect(
        f.manager.resolveGitRead({ ...f.scope, ...patch }),
      ).rejects.toThrow();
    let row = await f.manager.store.update(
      {
        ...f.record,
        state: "conflict",
        reason: "repository",
        revision: randomUUID(),
      },
      f.record.revision,
    );
    await expect(
      f.manager.resolveGitRead(worktreeContextRef(row)),
    ).rejects.toThrow();
    row = await f.manager.store.update(
      { ...row, state: "conflict", reason: "branch", revision: randomUUID() },
      row.revision,
    );
    const scope = worktreeContextRef(row),
      snapshot = await f.host.readGitWorkspace(scope);
    const sourceBefore = await tree(f.root);
    await rename(f.record.path, f.record.path + "-saved");
    const request = { scope, revision: snapshot.revision, path: "file.txt" };
    await expect(f.host.readGitWorkspace(scope)).rejects.toThrow();
    await expect(f.host.readGitDiff(request)).rejects.toThrow();
    await expect(f.host.readGitConflict(request)).rejects.toThrow();
    await mkdir(f.record.path);
    await expect(f.host.readGitWorkspace(scope)).rejects.toThrow();
    expect(await tree(f.root)).toBe(sourceBefore);
    await rm(f.record.path, { recursive: true });
    await rename(f.record.path + "-saved", f.record.path);
    await rename(f.root, f.root + "-saved");
    await mkdir(f.root);
    await expect(f.manager.resolveGitRead(scope)).rejects.toThrow();
  }),
  gitIntegrationBudget(30000),
);

it.each(["operation", "HEAD", "owner", "settings", "catalog"])(
  "discards a read when %s changes while Git is reading",
  fixtureScope.run(async (change) => {
    const f = await fixture();
    const original = f.runner.command.bind(f.runner);
    const settings = await f.host.readProjectSettings(f.project.id);
    let triggered = false;
    vi.spyOn(f.runner, "command").mockImplementation(
      async (exe, args, cwd, env, stdin) => {
        const result = await original(exe, args, cwd, env, stdin);
        if (!triggered && args.includes("status")) {
          triggered = true;
          if (change === "operation")
            await writeFile(
              path.join(f.metadata, "done"),
              (await readFile(path.join(f.metadata, "done"), "utf8")) +
                "# changed\n",
            );
          if (change === "HEAD")
            await writeFile(
              path.join(f.record.gitCommonDir, "HEAD"),
              await readFile(path.join(f.metadata, "orig-head")),
            );
          if (change === "owner")
            await f.manager.store.update(
              { ...f.record, revision: randomUUID() },
              f.record.revision,
            );
          if (change === "settings")
            await f.host.saveProjectSettings(
              f.project.id,
              {
                ...settings.value,
                env: [
                  {
                    key: "TEST_CHANGED",
                    value: "yes",
                    secret: false,
                    runtime: false,
                  },
                ],
              },
              settings.version,
            );
          if (change === "catalog") (f.host as any).catalogEpoch++;
        }
        return result;
      },
    );
    await expect(f.host.readGitWorkspace(f.scope)).rejects.toThrow();
    expect(triggered).toBe(true);
  }),
  gitIntegrationBudget(30000),
);

it(
  "does not leak the read admission to nested ordinary settings calls and still redacts secrets",
  fixtureScope.run(async () => {
    const f = await fixture(),
      settings = await f.host.readProjectSettings(f.project.id);
    const secret = "fixture-secret-for-redaction";
    await f.host.saveProjectSettings(
      f.project.id,
      {
        ...settings.value,
        env: [
          {
            key: "FIXTURE_SECRET",
            value: secret,
            secret: true,
            runtime: false,
          },
        ],
      },
      settings.version,
    );
    const original = f.runner.command.bind(f.runner);
    let nested = false;
    vi.spyOn(f.runner, "command").mockImplementation(
      async (exe, args, cwd, env, stdin) => {
        if (!nested && args.includes("status")) {
          nested = true;
          await expect(f.host.readProjectSettings(f.scope)).rejects.toThrow(
            /Клон топика недоступен/,
          );
          throw Error(`synthetic failure ${secret}`);
        }
        return original(exe, args, cwd, env, stdin);
      },
    );
    await expect(f.host.readGitWorkspace(f.scope)).rejects.toThrow(
      "synthetic failure [скрыто]",
    );
    expect(nested).toBe(true);
  }),
  gitIntegrationBudget(30000),
);

it(
  "never executes repository hooks, filters or fsmonitor when reading a rebase",
  fixtureScope.run(async () => {
    const f = await fixture(),
      marker = path.join(f.base, "must-not-exist");
    const hook = path.join(f.base, "hook.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    await f.git(f.record.path, ["config", "core.fsmonitor", hook]);
    await f.git(f.record.path, [
      "config",
      "filter.unsafe.clean",
      `touch '${marker}'; cat`,
    ]);
    await writeFile(
      path.join(f.record.path, ".gitattributes"),
      "file.txt filter=unsafe\n",
    );
    await writeFile(
      path.join(f.metadata, "author-script"),
      `touch '${marker}'\n`,
    );
    await writeFile(
      path.join(f.record.gitCommonDir, "hooks/post-checkout"),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o700 },
    );
    const before = await repositories(f),
      snapshot = await f.host.readGitWorkspace(f.scope);
    await f.host.readGitConflict({
      scope: f.scope,
      path: "file.txt",
      revision: snapshot.revision,
    });
    await expect(lstat(marker)).rejects.toThrow();
    expect(await repositories(f)).toBe(before);
  }),
  gitIntegrationBudget(30000),
);

it(
  "rechecks settings after the final asynchronous owner verification",
  fixtureScope.run(async () => {
    const f = await fixture(),
      settings = await f.host.readProjectSettings(f.project.id);
    const original = f.runner.command.bind(f.runner);
    let effectiveChecks = 0;
    vi.spyOn(f.runner, "command").mockImplementation(
      async (exe, args, cwd, env, stdin) => {
        const result = await original(exe, args, cwd, env, stdin);
        if (args.includes("--git-path") && ++effectiveChecks === 4)
          await f.host.saveProjectSettings(
            f.project.id,
            {
              ...settings.value,
              env: [
                {
                  key: "AFTER_VERIFY",
                  value: "changed",
                  secret: false,
                  runtime: false,
                },
              ],
            },
            settings.version,
          );
        return result;
      },
    );
    await expect(f.host.readGitWorkspace(f.scope)).rejects.toThrow(
      /Настройки проекта изменились/,
    );
    expect(effectiveChecks).toBe(4);
  }),
  gitIntegrationBudget(30000),
);

it(
  "measures bounded snapshot and conflict reads with 10000 synthetic loose objects",
  fixtureScope.run(async () => {
    const f = await fixture(),
      objects = path.join(f.record.gitCommonDir, "objects");
    for (let prefix = 0; prefix < 256; prefix++)
      await mkdir(path.join(objects, prefix.toString(16).padStart(2, "0")), {
        recursive: true,
      });
    for (let offset = 0; offset < 10000; offset += 100)
      await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const body = Buffer.from(`loose-object-fixture-${offset + index}\n`);
          const object = Buffer.concat([
            Buffer.from(`blob ${body.length}\0`),
            body,
          ]);
          const oid = createHash("sha1").update(object).digest("hex");
          await writeFile(
            path.join(objects, oid.slice(0, 2), oid.slice(2)),
            deflateSync(object),
          );
        }),
      );
    const calls = vi.spyOn(f.runner, "command"),
      start = performance.now();
    const snapshot = await f.host.readGitWorkspace(f.scope),
      snapshotEnd = performance.now(),
      snapshotCalls = calls.mock.calls.length;
    await f.host.readGitConflict({
      scope: f.scope,
      path: "file.txt",
      revision: snapshot.revision,
    });
    console.info(
      JSON.stringify({
        benchmark: "rebase-read-10000-loose",
        snapshotMs: Math.round(snapshotEnd - start),
        conflictMs: Math.round(performance.now() - snapshotEnd),
        snapshotCalls,
        conflictCalls: calls.mock.calls.length - snapshotCalls,
      }),
    );
  }),
  gitIntegrationBudget(60000),
);
