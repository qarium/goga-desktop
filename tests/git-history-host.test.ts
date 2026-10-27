import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { isOfflineGitRead, withReadScope } from "../src/host/read-scope";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { historyFixture } from "./helpers/git-history-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of cleanup.splice(0).reverse()) await run();
});
async function fixture() {
  const f = await historyFixture(cleanup);
  await f.write("a", "initial\n");
  const oid = await f.commit();
  await f.git(["branch", "feature"]);
  const host = new HostService({
    home: f.home,
    dataDir: path.join(f.dir, "data"),
    runner: f.runner,
    goga: "/nonexistent-fixture-goga",
  });
  cleanup.push(() => host.dispose());
  const project = await host.addProject(f.root);
  return { ...f, host, project, oid };
}
it("reads all history views offline without workspace status, board or branch write admission", async () => {
  const f = await fixture();
  const snapshot = vi.spyOn(GitWorkspaceReader.prototype, "snapshot");
  const branches = vi.spyOn(f.host, "readGitBranches");
  const native = f.runner.command.bind(f.runner);
  const calls = vi
    .spyOn(f.runner, "command")
    .mockImplementation((exe, args, cwd, env, stdin) => {
      expect(exe).toBe("git");
      expect(isOfflineGitRead()).toBe(true);
      expect(
        args.some((a) => ["status", "board", "fetch", "checkout"].includes(a)),
      ).toBe(false);
      return native(exe, args, cwd, env, stdin);
    });
  const scope = f.project.id;
  expect((await f.host.readGitHistoryRefs(scope)).local).toHaveLength(2);
  expect(
    (await f.host.readGitHistory({ scope, ref: "HEAD", offset: 0 })).tip,
  ).toBe(f.oid);
  const request = {
    scope,
    ref: "HEAD",
    tip: f.oid,
    commit: f.oid,
    parentIndex: 0,
  };
  expect(
    (await f.host.readGitCommit({ ...request, fileOffset: 0 })).files[0].path,
  ).toBe("a");
  expect(
    (await f.host.readGitCommitDiff({ ...request, path: "a" })).part.text,
  ).toContain("+initial");
  expect(calls).toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  expect(branches).not.toHaveBeenCalled();
});
it("reads only the admitted clone and refuses stale or missing owners without primary fallback", async () => {
  const f = await fixture();
  const clone = await new CloneManager(f.home, f.runner).ensure(f.project, {
    projectId: f.project.id,
    year: "2026",
    topic: "feature",
    branch: "feature",
  });
  const scope = worktreeContextRef(clone);
  await fs.writeFile(path.join(clone.path, "a"), "clone only\n");
  await f.runner.command(
    "git",
    ["-c", "core.hooksPath=/dev/null", "commit", "-am", "clone commit"],
    clone.path,
  );
  const request = { scope, ref: "HEAD", offset: 0 };
  const page = await f.host.readGitHistory(request);
  expect(page.tip).not.toBe(f.oid);
  expect(page.scope).toEqual(scope);
  for (const patch of [
    { contextId: `ctx-${"a".repeat(64)}` },
    { revision: "00000000-0000-4000-8000-000000000000" },
    { root: f.root },
  ])
    await expect(
      f.host.readGitHistory({ ...request, scope: { ...scope, ...patch } }),
    ).rejects.toThrow();
  await fs.rm(clone.path, { recursive: true, force: true });
  await expect(f.host.readGitHistory(request)).rejects.toThrow();
});
it("rejects a late result if settings change while Git is reading", async () => {
  const f = await fixture();
  const settings = await f.host.readProjectSettings(f.project.id);
  const native = f.runner.command.bind(f.runner);
  let changed = false;
  vi.spyOn(f.runner, "command").mockImplementation(
    async (exe, args, cwd, env, stdin) => {
      const result = await native(exe, args, cwd, env, stdin);
      if (!changed && args.includes("log")) {
        changed = true;
        await f.host.saveProjectSettings(
          f.project.id,
          {
            ...settings.value,
            env: [
              {
                key: "FIXTURE",
                value: "changed",
                secret: false,
                runtime: false,
              },
            ],
          },
          settings.version,
        );
      }
      return result;
    },
  );
  await expect(
    f.host.readGitHistory({ scope: f.project.id, ref: "HEAD", offset: 0 }),
  ).rejects.toThrow(/Настройки проекта изменились/);
});
it("redacts configured environment values in history failures and honours cancellation", async () => {
  const f = await fixture();
  const settings = await f.host.readProjectSettings(f.project.id);
  await f.host.saveProjectSettings(
    f.project.id,
    {
      ...settings.value,
      env: [
        {
          key: "FIXTURE",
          value: "synthetic-secret-12345",
          secret: true,
          runtime: false,
        },
      ],
    },
    settings.version,
  );
  const native = f.runner.command.bind(f.runner);
  const spy = vi
    .spyOn(f.runner, "command")
    .mockImplementation(async (exe, args, cwd, env, stdin) => {
      if (args.includes("log"))
        throw Error("synthetic-secret-12345 in failure");
      return native(exe, args, cwd, env, stdin);
    });
  const request = { scope: f.project.id, ref: "HEAD", offset: 0 };
  await expect(f.host.readGitHistory(request)).rejects.toThrow(
    "[скрыто] in failure",
  );
  spy.mockClear();
  const abort = new AbortController();
  abort.abort();
  await expect(
    withReadScope(abort.signal, () => f.host.readGitHistory(request)),
  ).rejects.toThrow(/отмен/i);
  expect(spy).not.toHaveBeenCalled();
  spy.mockImplementation(async (exe, args, cwd, env, stdin) => {
    const result = await native(exe, args, cwd, env, stdin);
    if (args.includes("log")) active.abort();
    return result;
  });
  const active = new AbortController();
  await expect(
    withReadScope(active.signal, () => f.host.readGitHistory(request)),
  ).rejects.toThrow(/отмен/i);
});
