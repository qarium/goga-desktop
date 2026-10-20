import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ContextRunsStore } from "../src/host/context-runs-store";
import type { Run } from "../src/shared/types";

async function setup() {
  const root = await fs.mkdtemp(
    "/private/tmp/goga-context-ab-research-20261019-impl-clones-runs-",
  );
  const home = path.join(root, "home");
  await fs.mkdir(home);
  return {
    root,
    home,
    store: new ContextRunsStore(home),
    file: path.join(home, ".goga/desktop/context-runs.json"),
  };
}
function run(changes: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    projectId: "p",
    pipeline: "build",
    kind: "build",
    topic: "alpha",
    branch: "alpha",
    status: "running",
    workflow: null,
    profile: null,
    startedAt: "2026-10-20T12:00:00.000Z",
    context: {
      projectId: "p",
      year: "2026",
      topic: "alpha",
      branch: "alpha",
      contextId: `ctx-${"a".repeat(64)}`,
      revision: "11111111-1111-4111-8111-111111111111",
      path: "/private/tmp/clone-a",
      repositoryKey: "b".repeat(64),
    },
    build: {
      planPath: "docs/plan.md",
      planVersion: "c".repeat(64),
      clean: false,
      update: false,
      skipReview: false,
      skipManifestCheck: false,
    },
    ...changes,
  };
}
describe("private context run journal", () => {
  it("restores starting/running owners as unverified without inventing termination or touching any PID", async () => {
    const f = await setup();
    await f.store.save([run(), run({ id: "run-2", status: "starting" })]);
    const loaded = await new ContextRunsStore(f.home).load();
    expect(loaded).toMatchObject([
      {
        id: "run-1",
        status: "running",
        recovery: "unverified",
        context: run().context,
      },
      { id: "run-2", status: "starting", recovery: "unverified" },
    ]);
    expect(loaded.every((r) => r.endedAt === undefined)).toBe(true);
  });
  it("retains completed history and reflects a closed tab in the next snapshot", async () => {
    const f = await setup();
    const finished = run({
      status: "exited",
      endedAt: "2026-10-20T13:00:00.000Z",
    });
    await f.store.save([finished]);
    expect(await new ContextRunsStore(f.home).load()).toEqual([finished]);
    await f.store.save([]);
    expect(await new ContextRunsStore(f.home).load()).toEqual([]);
  });
  it("never serializes env, proxy, raw build request, argv, output, URLs or arbitrary error strings", async () => {
    const f = await setup();
    const unsafe = {
      ...run(),
      env: [{ key: "TOKEN", value: "never-persist-secret" }],
      proxy: "http://user:never-persist-secret@host",
      request: {
        options: { env: [{ key: "TOKEN", value: "never-persist-secret" }] },
      },
      argv: ["never-persist-secret"],
      secrets: ["never-persist-secret"],
      output: { text: "never-persist-secret", truncated: false },
      url: "http://user:never-persist-secret@host",
      error: "never-persist-secret",
      build: { ...run().build, options: { proxy: "never-persist-secret" } },
    } as Run;
    await f.store.save([unsafe]);
    const raw = await fs.readFile(f.file, "utf8");
    expect(raw).not.toContain("never-persist-secret");
    const [restored] = await new ContextRunsStore(f.home).load();
    expect(restored.build).toEqual(run().build);
    expect(restored.output).toBeUndefined();
    expect(restored.url).toBeUndefined();
    expect(restored.error).toBeUndefined();
    expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(f.file))).mode & 0o777).toBe(0o700);
  });
  it("rejects owner/path/revision mutation even after a run was closed", async () => {
    const f = await setup(),
      initial = run();
    await f.store.save([initial]);
    await expect(
      f.store.save([
        {
          ...initial,
          context: { ...initial.context!, path: "/private/tmp/clone-b" },
        },
      ]),
    ).rejects.toThrow(/владел|контекст|измен/);
    await expect(
      f.store.save([
        {
          ...initial,
          context: {
            ...initial.context!,
            revision: "22222222-2222-4222-8222-222222222222",
          },
        },
      ]),
    ).rejects.toThrow(/владел|контекст|измен/);
    await f.store.save([]);
    await expect(
      f.store.save([{ ...initial, projectId: "other", context: undefined }]),
    ).rejects.toThrow(/владел|контекст|измен/);
  });
  it("rejects internally inconsistent context owners and duplicate run IDs without changing persisted bytes", async () => {
    const f = await setup();
    await f.store.save([run()]);
    const before = await fs.readFile(f.file, "utf8");
    await expect(f.store.save([run({ projectId: "other" })])).rejects.toThrow();
    await expect(f.store.save([run(), run()])).rejects.toThrow();
    expect(await fs.readFile(f.file, "utf8")).toBe(before);
  });
  it("rejects stale independent writers and a disappeared known journal", async () => {
    const f = await setup();
    await f.store.save([run()]);
    const other = new ContextRunsStore(f.home);
    await other.load();
    await f.store.save([
      run({ status: "exited", endedAt: "2026-10-20T13:00:00.000Z" }),
    ]);
    await expect(other.save([])).rejects.toThrow(/измен/);
    await fs.rename(f.file, `${f.file}.preserved`);
    await expect(f.store.save([])).rejects.toThrow();
  });
  it.each([".goga", ".goga/desktop", ".goga/desktop/context-runs.json"])(
    "rejects symlinks at %s without changing target",
    async (relative) => {
      const f = await setup(),
        target = path.join(f.root, "foreign");
      await fs.mkdir(target);
      const file = path.join(f.home, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.symlink(target, file);
      await expect(f.store.load()).rejects.toThrow();
      expect(await fs.readdir(target)).toEqual([]);
    },
  );
  it("rejects directory replacement and corrupt data instead of discarding history", async () => {
    const f = await setup();
    await f.store.save([run()]);
    await fs.rename(path.dirname(f.file), `${path.dirname(f.file)}.preserved`);
    await fs.mkdir(path.dirname(f.file));
    await expect(f.store.load()).rejects.toThrow();
    const second = await setup();
    await fs.mkdir(path.dirname(second.file), { recursive: true });
    await fs.writeFile(second.file, '{"schemaVersion":1,"runs":[]}', {
      mode: 0o600,
    });
    await expect(second.store.load()).rejects.toThrow();
  });
});

describe("run snapshot capture", () => {
  it("captures a value snapshot at save invocation, not after the caller mutates owner objects", async () => {
    const f = await setup(),
      initial = run();
    const pending = f.store.save([initial]);
    initial.context!.path = "/private/tmp/mutated-after-save";
    await pending;
    expect((await new ContextRunsStore(f.home).load())[0].context?.path).toBe(
      "/private/tmp/clone-a",
    );
  });
  it("does not resurrect a completed outcome from a stale active snapshot", async () => {
    const f = await setup();
    await f.store.save([
      run({ status: "exited", endedAt: "2026-10-20T13:00:00.000Z" }),
    ]);
    await expect(f.store.save([run()])).rejects.toThrow(
      /заверш|состояни|измен/,
    );
    expect((await new ContextRunsStore(f.home).load())[0].status).toBe(
      "exited",
    );
  });
  it("never guesses that a leftover journal lock is stale", async () => {
    const f = await setup();
    await f.store.load();
    const lock = path.join(path.dirname(f.file), ".context-runs.lock");
    await fs.writeFile(lock, "previous process", { mode: 0o600 });
    await expect(f.store.save([run()])).rejects.toThrow(/занят/);
    expect(await fs.readFile(lock, "utf8")).toBe("previous process");
  });
});

describe("run task owner binding", () => {
  it("rejects a task snapshot recorded for a different topic/year than its context", async () => {
    const f = await setup();
    await expect(
      f.store.save([
        run({
          taskSnapshot: {
            text: "owner B bytes",
            year: "2025",
            topic: "beta",
            branch: "beta",
          },
        }),
      ]),
    ).rejects.toThrow(/владел|контекст|измен/);
    expect(await f.store.load()).toEqual([]);
  });
});

describe("run journal lock restart recovery", () => {
  it("recovers a versioned definitely dead owner lock and retains active owner status", async () => {
    const f = await setup();
    await f.store.save([run()]);
    await fs.writeFile(
      path.join(path.dirname(f.file), ".context-runs.lock"),
      JSON.stringify({
        schemaVersion: 1,
        pid: 2147483647,
        nonce: "11111111-1111-4111-8111-111111111111",
      }),
      { mode: 0o600 },
    );
    expect((await new ContextRunsStore(f.home).load())[0]).toMatchObject({
      status: "running",
      recovery: "unverified",
    });
  }, 10000);
});

describe("durable terminal synchronization intent", () => {
  it("persists mutable syncPending atomically with terminal status without changing the recorded owner", async () => {
    const f = await setup();
    const finished = {
      ...run({ status: "failed", endedAt: "2026-10-20T13:00:00.000Z" }),
      syncPending: true,
    };
    await f.store.save([finished]);
    expect((await new ContextRunsStore(f.home).load())[0]).toMatchObject({
      status: "failed",
      syncPending: true,
      context: run().context,
    });
    await f.store.save([{ ...finished, syncPending: false }]);
    expect((await new ContextRunsStore(f.home).load())[0]).toMatchObject({
      status: "failed",
      syncPending: false,
    });
  });
});

it("keeps the .43 identity hash compatible for history without repeat/process additions", async () => {
  const f = await setup(),
    row = run({ status: "exited", endedAt: "2026-10-20T13:00:00.000Z" });
  await f.store.save([row]);
  const doc = JSON.parse(await fs.readFile(f.file, "utf8"));
  doc.bindings[0].hash = createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.projectId,
        row.context ?? null,
        row.kind ?? null,
        row.pipeline,
        row.pipelineName ?? null,
        row.pipelineDescription ?? null,
        row.topic,
        row.branch,
        row.workflow,
        row.profile,
        row.startedAt,
        row.build ?? null,
        row.taskSnapshot ?? null,
        row.startupTimeoutMs ?? null,
        row.update ?? null,
      ]),
    )
    .digest("hex");
  doc.revision = randomUUID();
  await fs.writeFile(f.file, JSON.stringify(doc), { mode: 0o600 });
  const restored = new ContextRunsStore(f.home);
  const rows = await restored.load();
  expect(rows[0].id).toBe(row.id);
  await restored.save(rows);
});
