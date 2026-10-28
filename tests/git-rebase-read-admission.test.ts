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
