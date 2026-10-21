import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { CloneManager } from "../src/host/clones";
import {
  worktreeContextRef,
  type WorktreeRecord,
} from "../src/shared/worktrees";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup() {
  const dir = await mkdtemp("/private/tmp/goga-context-service-unit-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"),
    home = path.join(dir, "home");
  await mkdir(repo);
  await mkdir(home);
  const runner = {
    command: vi.fn(async () => ({ stdout: repo, stderr: "" })),
    start: vi.fn(),
    kill: vi.fn(),
  };
  const service = new HostService({
    home,
    dataDir: path.join(home, "data"),
    runner: runner as any,
  });
  cleanup.push(() => service.dispose());
  const project = { id: "p", name: "Fixture", path: repo };
  vi.spyOn(service, "listProjects").mockResolvedValue([project]);
  const identity = {
    projectId: project.id,
    year: "2026",
    topic: "feature",
    branch: "feature",
  };
  const record: WorktreeRecord = {
    ...identity,
    contextId: "ctx-" + "a".repeat(64),
    revision: "00000000-0000-4000-8000-000000000001",
    repositoryKey: "b".repeat(64),
    projectPath: repo,
    gitCommonDir: repo,
    path: path.join(home, ".goga/desktop/clones/fixture"),
    ownership: "managed",
    state: "ready",
    storageKind: "clone",
    sourceCommonDir: path.join(repo, ".git"),
  };
  const board = {
    projectId: project.id,
    year: "2026",
    revision: "v",
    entries: [{ topic: "feature", branch: "feature", remote: false }],
    records: [],
    remoteEntries: [],
    remoteRecords: [],
  };
  vi.spyOn(service, "readTopicBoard").mockResolvedValue(board as any);
  const ensure = vi
    .spyOn(CloneManager.prototype, "ensure")
    .mockResolvedValue(record);
  vi.spyOn(CloneManager.prototype, "resolve").mockResolvedValue(record);
  const reconcile = vi
    .spyOn(CloneManager.prototype, "reconcile")
    .mockResolvedValue([record]);
  return {
    service,
    project,
    repo,
    runner,
    identity,
    record,
    ensure,
    reconcile,
  };
}
it("host verifies registered project and current Goga topic identity before ensuring copy", async () => {
  const f = await setup();
  expect(await f.service.ensureTopicContext(f.identity)).toEqual(f.record);
  expect(f.ensure).toHaveBeenCalledWith(f.project, f.identity);
  expect(f.project.path).toBe(f.repo);
  expect(
    await f.service.resolveTopicContext(worktreeContextRef(f.record)),
  ).toEqual(f.record);
  expect(await f.service.listTopicContexts("p")).toEqual([f.record]);
  expect(f.runner.start).not.toHaveBeenCalled();
});
it("unknown project, absent topic/year and manual cwd are rejected before manager writes", async () => {
  const f = await setup();
  for (const identity of [
    { ...f.identity, projectId: "other" },
    { ...f.identity, topic: "not-in-catalog" },
    { ...f.identity, year: "2025" },
    { ...f.identity, path: "/elsewhere" },
  ])
    await expect(
      f.service.ensureTopicContext(identity as any),
    ).rejects.toThrow();
  expect(f.ensure).not.toHaveBeenCalled();
  expect(f.runner.start).not.toHaveBeenCalled();
});
it("host ref cannot cross registered projects or silently change project root", async () => {
  const f = await setup();
  await expect(
    f.service.resolveTopicContext({
      ...worktreeContextRef(f.record),
      projectId: "other",
    }),
  ).rejects.toThrow();
  vi.spyOn(CloneManager.prototype, "resolve").mockResolvedValue({
    ...f.record,
    projectPath: "/different",
  });
  await expect(
    f.service.resolveTopicContext(worktreeContextRef(f.record)),
  ).rejects.toThrow(/папка/);
});
it("duplicate physical preparation joins one promise and never starts a process", async () => {
  const f = await setup();
  let finish!: (r: WorktreeRecord) => void;
  f.ensure.mockReturnValue(new Promise((r) => (finish = r)));
  const a = f.service.ensureTopicContext(f.identity),
    b = f.service.ensureTopicContext({ ...f.identity });
  expect(a).toBe(b);
  await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledTimes(1));
  finish(f.record);
  expect(await a).toEqual(f.record);
  expect(f.runner.start).not.toHaveBeenCalled();
});
it("primary source writer reservation remains protected while preparing clones", async () => {
  const f = await setup();
  (f.service as any).activeKeys.set(f.repo, new Set(["running"]));
  await expect(f.service.ensureTopicContext(f.identity)).rejects.toThrow(
    /активного запуска/,
  );
  expect(f.ensure).not.toHaveBeenCalled();
});
it("reconciliation never silently assigns records from a prior project folder", async () => {
  const f = await setup();
  f.reconcile.mockResolvedValue([{ ...f.record, projectPath: "/prior" }]);
  await expect(f.service.listTopicContexts("p")).rejects.toThrow(
    /прежней папке/,
  );
});
