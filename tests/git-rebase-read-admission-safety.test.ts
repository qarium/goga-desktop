import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
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
import {
  fixtureScope,
  fixture,
  tree,
  repositories,
} from "./helpers/rebase-read-admission-fixture";
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
