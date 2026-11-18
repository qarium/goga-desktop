import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { ContextRunsStore } from "../src/host/context-runs-store";
import type { Run } from "../src/shared/types";
import type { Runner } from "../src/host/process";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const fixtures: Array<{ root: string; service: HostService }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    (f.service as any).runList = [];
    (f.service as any).children.clear();
    await f.service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
const owner = {
  projectId: "p",
  year: "2026",
  topic: "alpha",
  branch: "feature/alpha",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "11111111-1111-4111-8111-111111111111",
};
const otherOwner = { ...owner, contextId: `ctx-${"b".repeat(64)}` };
function run(id: string, changes: Partial<Run> = {}): Run {
  return {
    id,
    projectId: "p",
    pipeline: "editor",
    topic: "",
    branch: "main",
    status: "exited",
    startedAt: "2026-11-17T12:00:00.000Z",
    workflow: null,
    profile: null,
    ...changes,
  };
}
const owned = (id: string, changes: Partial<Run> = {}) =>
  run(id, {
    topic: owner.topic,
    branch: owner.branch,
    context: owner,
    ...changes,
  });
async function fixture(rows: Run[]) {
  const root = await mkdtemp("/private/tmp/goga-run-history-"),
    home = path.join(root, "home");
  await mkdir(home);
  const command = vi.fn(async () => {
    throw Error("No command permitted");
  });
  const start = vi.fn(() => {
    throw Error("No process permitted");
  });
  const kill = vi.fn(async () => {
    throw Error("No signal permitted");
  });
  const dispose = vi.fn(async () => {});
  const runner = { command, start, kill, dispose } as unknown as Runner;
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    runner,
    projectCreationRunner: runner,
  });
  fixtures.push({ root, service });
  (service as any).runList = structuredClone(rows);
  const store = (service as any).runStore as ContextRunsStore;
  await (service as any).persistRuns();
  return { root, home, service, store, command, start, kill };
}
it("clears only confirmed completed pipeline IDs in the exact owner, without filesystem context or process operations", async () => {
  const f = await fixture([
    owned("done"),
    owned("newer"),
    owned("other-copy", { context: otherOwner }),
    run("primary"),
    run("foreign", { projectId: "q" }),
    owned("build", { kind: "build" }),
  ]);
  const result = await f.service.clearRunHistory({
    scope: { ...owner, revision: "22222222-2222-4222-8222-222222222222" },
    kind: "pipeline",
    runIds: ["done"],
  });
  expect(result).toEqual({ removedRunIds: ["done"], retained: [] });
  expect(f.service.runs().map((r) => r.id)).toEqual([
    "newer",
    "other-copy",
    "primary",
    "foreign",
    "build",
  ]);
  expect((await new ContextRunsStore(f.home).load()).map((r) => r.id)).toEqual([
    "newer",
    "other-copy",
    "primary",
    "foreign",
    "build",
  ]);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.kill).not.toHaveBeenCalled();
});
it("rejects mixed foreign-owner or wrong-kind batches before changing any record", async () => {
  const f = await fixture([
    owned("done"),
    owned("other-copy", { context: otherOwner }),
    run("primary"),
    owned("build", { kind: "build" }),
  ]);
  for (const id of ["other-copy", "primary", "build"])
    await expect(
      f.service.clearRunHistory({
        scope: owner,
        kind: "pipeline",
        runIds: ["done", id],
      }),
    ).rejects.toThrow();
  expect(f.service.runs()).toHaveLength(4);
  expect(await new ContextRunsStore(f.home).load()).toHaveLength(4);
});
it("retains active, unverified, pending-sync and in-flight records without stopping anything", async () => {
  const f = await fixture([
    run("done"),
    run("active", { status: "running" }),
    run("unknown", { recovery: "unverified" }),
    run("pending", { syncPending: true }),
    run("busy"),
  ]);
  (f.service as any).closeFlights.set("busy", Promise.resolve(false));
  const result = await f.service.clearRunHistory({
    scope: "p",
    kind: "pipeline",
    runIds: ["done", "active", "unknown", "pending", "busy"],
  });
  expect(result.removedRunIds).toEqual(["done"]);
  expect(result.retained).toEqual([
    { id: "active", reason: "active" },
    { id: "unknown", reason: "unverified" },
    { id: "pending", reason: "pending-sync" },
    { id: "busy", reason: "busy" },
  ]);
  expect(f.kill).not.toHaveBeenCalled();
  expect(f.command).not.toHaveBeenCalled();
});
it("retains an actual child even when its displayed status was terminal", async () => {
  const f = await fixture([run("child")]);
  (f.service as any).children.set("child", {});
  expect(
    await f.service.clearRunHistory({
      scope: "p",
      kind: "pipeline",
      runIds: ["child"],
    }),
  ).toEqual({
    removedRunIds: [],
    retained: [{ id: "child", reason: "active" }],
  });
  expect(f.kill).not.toHaveBeenCalled();
});
it("keeps state intact when persistence fails, then allows a retry and an idempotent repeated clear", async () => {
  const f = await fixture([run("done")]);
  const before = await readFile(
    path.join(f.home, ".goga/desktop/context-runs.json"),
    "utf8",
  );
  const clear = vi
    .spyOn(f.store, "clearCompleted")
    .mockRejectedValueOnce(Error("synthetic persistence failure"));
  const request = { scope: "p", kind: "pipeline" as const, runIds: ["done"] };
  await expect(f.service.clearRunHistory(request)).rejects.toThrow(
    "synthetic persistence failure",
  );
  expect(f.service.runs().map((r) => r.id)).toEqual(["done"]);
  expect(
    await readFile(
      path.join(f.home, ".goga/desktop/context-runs.json"),
      "utf8",
    ),
  ).toBe(before);
  clear.mockRestore();
  expect((await f.service.clearRunHistory(request)).removedRunIds).toEqual([
    "done",
  ]);
  expect(await f.service.clearRunHistory(request)).toEqual({
    removedRunIds: [],
    retained: [],
  });
});
it("preserves later arrivals and ignores stale snapshots after a delayed durable clear", async () => {
  const f = await fixture([run("done"), run("live", { status: "running" })]);
  const original = f.store.clearCompleted.bind(f.store);
  let release!: () => void, entered!: () => void;
  const inClear = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.store, "clearCompleted").mockImplementationOnce(
    async (...args) => {
      entered();
      await pause;
      return original(...args);
    },
  );
  const clearing = f.service.clearRunHistory({
    scope: "p",
    kind: "pipeline",
    runIds: ["done"],
  });
  await inClear;
  (f.service as any).runList.push(run("arrived"));
  (f.service as any).emitRuns();
  release();
  expect((await clearing).removedRunIds).toEqual(["done"]);
  await (f.service as any).runSaveTail;
  expect(f.service.runs().map((r) => r.id)).toEqual(["live", "arrived"]);
  expect((await new ContextRunsStore(f.home).load()).map((r) => r.id)).toEqual([
    "live",
    "arrived",
  ]);
});

it("does not publish removal or lose the original journal when atomic replacement fails", async () => {
  const f = await fixture([run("done")]);
  const file = path.join(f.home, ".goga/desktop/context-runs.json");
  const before = await readFile(file, "utf8");
  const event = vi.fn();
  f.service.on("runs", event);
  vi.mocked(filesystem.rename).mockRejectedValueOnce(
    Error("synthetic rename failure"),
  );
  await expect(
    f.service.clearRunHistory({
      scope: "p",
      kind: "pipeline",
      runIds: ["done"],
    }),
  ).rejects.toThrow("synthetic rename failure");
  expect(f.service.runs().map((r) => r.id)).toEqual(["done"]);
  expect(event).not.toHaveBeenCalled();
  expect(await readFile(file, "utf8")).toBe(before);
  expect(
    (
      await f.service.clearRunHistory({
        scope: "p",
        kind: "pipeline",
        runIds: ["done"],
      })
    ).removedRunIds,
  ).toEqual(["done"]);
});

it("refuses removal when a real child appears after the confirmation was inspected", async () => {
  const f = await fixture([run("done")]);
  const before = await readFile(
    path.join(f.home, ".goga/desktop/context-runs.json"),
    "utf8",
  );
  const original = f.store.clearCompleted.bind(f.store);
  vi.spyOn(f.store, "clearCompleted").mockImplementationOnce(
    async (...args) => {
      (f.service as any).children.set("done", {});
      return original(...args);
    },
  );
  await expect(
    f.service.clearRunHistory({
      scope: "p",
      kind: "pipeline",
      runIds: ["done"],
    }),
  ).rejects.toThrow(/изменилось/);
  expect(f.service.runs().map((r) => r.id)).toEqual(["done"]);
  expect(
    await readFile(
      path.join(f.home, ".goga/desktop/context-runs.json"),
      "utf8",
    ),
  ).toBe(before);
  expect(f.kill).not.toHaveBeenCalled();
});

async function failDirectoryConfirmationAfterRename(
  root: string,
  failure: "open" | "sync",
) {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let committed = false;
  vi.mocked(filesystem.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args);
    committed = true;
  });
  vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
    if (committed && String(args[0]) === root) {
      committed = false;
      if (failure === "open") throw Error("SECRET: directory open failed");
      const handle = await actual.open(...args);
      vi.spyOn(handle, "sync").mockRejectedValueOnce(
        Error("SECRET: directory sync failed"),
      );
      return handle;
    }
    return actual.open(...args);
  });
}

it.each(["open", "sync"] as const)(
  "reports committed clear after directory %s failure, updates memory, and allows retry and later writes",
  async (failure) => {
    const f = await fixture([run("done"), run("live", { status: "running" })]);
    await failDirectoryConfirmationAfterRename(f.store.root, failure);
    const event = vi.fn();
    f.service.on("runs", event);
    const request = { scope: "p", kind: "pipeline" as const, runIds: ["done"] };
    const error = await f.service
      .clearRunHistory(request)
      .catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "Очистка истории записана, но подтверждение сохранения на диске не завершено. Повторите проверку истории.",
    );
    expect(error.removedRunIds).toEqual(["done"]);
    expect(f.service.runs().map((r) => r.id)).toEqual(["live"]);
    expect(event).toHaveBeenCalledTimes(1);
    expect(
      (await new ContextRunsStore(f.home).load()).map((r) => r.id),
    ).toEqual(["live"]);
    expect(await f.service.clearRunHistory(request)).toEqual({
      removedRunIds: [],
      retained: [],
    });
    (f.service as any).runList.push(run("arrived"));
    (f.service as any).emitRuns();
    await (f.service as any).runSaveTail;
    expect(
      (await new ContextRunsStore(f.home).load()).map((r) => r.id),
    ).toEqual(["live", "arrived"]);
    expect(f.kill).not.toHaveBeenCalled();
  },
);

it("does not deadlock normal journal writes after a committed save loses its directory confirmation", async () => {
  const f = await fixture([run("first")]);
  await failDirectoryConfirmationAfterRename(f.store.root, "sync");
  await expect(f.store.save([run("first"), run("second")])).rejects.toThrow();
  await expect(
    f.store.save([run("first"), run("second"), run("third")]),
  ).resolves.toBeUndefined();
  expect((await new ContextRunsStore(f.home).load()).map((r) => r.id)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

it("publishes committed removal even when the journal lock reports a later release failure", async () => {
  const f = await fixture([run("done"), run("live", { status: "running" })]);
  const original = (f.store as any).locked.bind(f.store);
  vi.spyOn(f.store as any, "locked").mockImplementationOnce(
    async (action: any) => {
      await original(action);
      throw Error("SECRET: lock release failed after commit");
    },
  );
  const request = { scope: "p", kind: "pipeline" as const, runIds: ["done"] };
  const error = await f.service
    .clearRunHistory(request)
    .catch((value) => value);
  expect(error.message).toBe(
    "Очистка истории записана, но подтверждение сохранения на диске не завершено. Повторите проверку истории.",
  );
  expect(error.removedRunIds).toEqual(["done"]);
  expect(f.service.runs().map((row) => row.id)).toEqual(["live"]);
  expect(await f.service.clearRunHistory(request)).toEqual({
    removedRunIds: [],
    retained: [],
  });
  expect(f.kill).not.toHaveBeenCalled();
});
