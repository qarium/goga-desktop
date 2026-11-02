import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { NotificationCenter } from "../src/host/notifications/store";
import {
  NotificationInputSchema,
  NotificationPageRequestSchema,
  NotificationRecordSchema,
  NotificationSnapshotSchema,
  type NotificationInput,
} from "../src/shared/notifications";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.open).mockReset();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const input = (
  id = "episode-1",
  changes: Partial<NotificationInput> = {},
): NotificationInput => ({
  id,
  runId: "run-1",
  projectId: "project-1",
  pipeline: "build",
  topic: "notifications",
  branch: "feature/notifications",
  stageId: "review",
  kind: "question",
  occurredAt: "2026-11-01T12:00:00.000Z",
  ...changes,
});
const context = {
  projectId: "project-1",
  year: "2026",
  topic: "notifications",
  branch: "feature/notifications",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "123e4567-e89b-42d3-a456-426614174000",
};
async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-notifications-");
  roots.push(root);
  const dataDir = path.join(root, "userData");
  const file = path.join(dataDir, "notifications.json");
  const center = new NotificationCenter(dataDir);
  return { root, dataDir, file, center };
}
async function setup() {
  const result = await fixture();
  await result.center.initialize();
  return result;
}

describe("notification history schemas", () => {
  it("accepts only bounded metadata, with strict identifiers and ownership", () => {
    expect(
      NotificationInputSchema.safeParse(input("x".repeat(256), { context }))
        .success,
    ).toBe(true);
    for (const change of [
      { id: "x".repeat(257) },
      { id: "bad\nidentifier" },
      { runId: "bad\u001b[0m" },
      { occurredAt: "yesterday" },
      { kind: "running" },
      { question: "private body" },
      { context: { ...context, path: "/private/project" } },
      { context: { ...context, projectId: "other" } },
      { context: { ...context, topic: "other" } },
      { context: { ...context, branch: "other" } },
    ])
      expect(
        NotificationInputSchema.safeParse({ ...input(), ...change }).success,
      ).toBe(false);
    expect(
      NotificationRecordSchema.safeParse({
        ...input(),
        sequence: 0,
        readAt: null,
      }).success,
    ).toBe(false);
    expect(NotificationPageRequestSchema.parse({})).toEqual({ limit: 50 });
    expect(NotificationPageRequestSchema.safeParse({ limit: 51 }).success).toBe(
      false,
    );
    expect(
      NotificationPageRequestSchema.safeParse({ beforeSequence: -1 }).success,
    ).toBe(false);
    expect(
      NotificationPageRequestSchema.safeParse({ limit: 1, secret: "no" })
        .success,
    ).toBe(false);
  });

  it("cleans bounded display labels without keeping control characters or payload fields", async () => {
    const { center, file } = await setup();
    const record = await center.add(
      input("clean", {
        pipeline: `\u001b\n${"p".repeat(1200)}\u007f`,
        topic: "top\nic",
        branch: "fea\tture",
      }),
    );
    expect(record?.pipeline.length).toBeLessThanOrEqual(1024);
    expect(record?.pipeline).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(record?.topic).toBe("topic");
    expect(record?.branch).toBe("feature");
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("\\u001b");
    await expect(
      center.add({
        ...input("body"),
        body: "SECRET_FIXTURE",
      } as NotificationInput),
    ).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).not.toContain("SECRET_FIXTURE");
  });
});

describe("NotificationCenter", () => {
  it("starts empty and reloads durable records, reads and opt-in without replay", async () => {
    const { center, dataDir, file } = await setup();
    const events = vi.fn();
    center.onChanged(events);
    expect(center.snapshot()).toMatchObject({
      revision: 0,
      records: [],
      throughSequence: 0,
      hasMore: false,
      unreadCount: 0,
      byProject: {},
      unreadRunIds: [],
      systemEnabled: false,
    });
    const first = await center.add(input("first", { context }));
    expect(first).toMatchObject({ sequence: 1, readAt: null });
    await center.markRead("first");
    await center.setSystemEnabled(true);
    const second = await center.add(
      input("second", { projectId: "project-2", runId: "run-2" }),
    );
    const reloaded = new NotificationCenter(dataDir);
    const replay = vi.fn();
    reloaded.onChanged(replay);
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(center.snapshot());
    expect(replay).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledTimes(4);
    expect(events.mock.calls[0][1]).toEqual(first);
    expect(events.mock.calls[3][1]).toEqual(second);
    expect(
      NotificationSnapshotSchema.safeParse(reloaded.snapshot()).success,
    ).toBe(true);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dataDir)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(dataDir)).toEqual(["notifications.json"]);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
  });

  it("deduplicates a read episode without restoring unread or changing metadata", async () => {
    const { center } = await setup();
    await center.add(input());
    await center.markRead("episode-1");
    const before = center.snapshot();
    expect(await center.add(input())).toBeNull();
    expect(
      await center.add(
        input("episode-1", { projectId: "other", runId: "other" }),
      ),
    ).toBeNull();
    expect(center.snapshot()).toEqual(before);
    await center.add(input("new-episode"));
    expect(center.snapshot().unreadCount).toBe(1);
  });

  it("paginates newest sequence first while all counts and high watermark cover history", async () => {
    const { center } = await setup();
    for (let i = 1; i <= 55; i++)
      await center.add(
        input(`e-${i}`, {
          projectId: i % 2 ? "odd" : "even",
          runId: `run-${i % 3}`,
        }),
      );
    await center.markRead("e-1");
    const newest = center.snapshot();
    expect(newest.records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 50 }, (_, i) => 55 - i),
    );
    expect(newest).toMatchObject({
      hasMore: true,
      throughSequence: 55,
      unreadCount: 54,
      byProject: { odd: 27, even: 27 },
    });
    expect(new Set(newest.unreadRunIds)).toEqual(
      new Set(["run-0", "run-1", "run-2"]),
    );
    const oldest = center.snapshot(50, newest.records.at(-1)!.sequence);
    expect(oldest.records.map((record) => record.sequence)).toEqual([
      5, 4, 3, 2, 1,
    ]);
    expect(oldest).toMatchObject({
      hasMore: false,
      throughSequence: 55,
      unreadCount: 54,
      byProject: newest.byProject,
    });
    expect(center.snapshot(500).records).toHaveLength(50);
    expect(() => center.snapshot(0)).toThrow();
    expect(() => center.snapshot(1, NaN)).toThrow();
  });

  it("markAllRead never reads later arrivals and is idempotent", async () => {
    const { center } = await setup();
    await center.add(input("seen"));
    const snapshot = center.snapshot();
    const arrival = center.add(input("arrived"));
    const marked = center.markAllRead(snapshot.throughSequence);
    await Promise.all([arrival, marked]);
    expect(center.find("seen")?.readAt).toEqual(expect.any(String));
    expect(center.find("arrived")?.readAt).toBeNull();
    const after = center.snapshot();
    expect(after.unreadCount).toBe(1);
    expect(await center.markRead("missing")).toEqual(after);
    expect(await center.markAllRead(snapshot.throughSequence)).toEqual(after);
    expect(await center.markRead("seen")).toEqual(after);
  });

  it("upgrades one terminal record with a fresh sequence without readAll swallowing it", async () => {
    const { center } = await setup();
    await center.add(input("terminal", { kind: "process-exited" }));
    await center.markRead("terminal");
    const old = center.snapshot();
    const upgraded = await center.add(
      input("terminal", {
        kind: "run-failed",
        occurredAt: "2026-11-01T12:00:01.000Z",
      }),
    );
    await center.markAllRead(old.throughSequence);
    expect(upgraded).toMatchObject({
      id: "terminal",
      sequence: 2,
      kind: "run-failed",
      readAt: null,
    });
    expect(center.snapshot()).toMatchObject({
      unreadCount: 1,
      throughSequence: 2,
      records: [upgraded],
    });
    await center.markRead("terminal");
    const read = center.snapshot();
    expect(
      await center.add(input("terminal", { kind: "run-finished" })),
    ).toBeNull();
    expect(
      await center.add(input("terminal", { kind: "run-failed" })),
    ).toBeNull();
    expect(center.snapshot()).toEqual(read);
  });

  it("compare-and-marks a navigation capture without reading an asynchronously upgraded terminal", async () => {
    const { center } = await setup();
    const captured = await center.add(
      input("terminal", { kind: "process-exited" }),
    );
    const upgrade = center.add(input("terminal", { kind: "run-failed" }));
    const staleRead = center.markRead("terminal", captured!.sequence);
    await Promise.all([upgrade, staleRead]);
    expect(center.find("terminal")).toMatchObject({
      kind: "run-failed",
      readAt: null,
    });
    const current = center.find("terminal")!;
    await center.markRead("terminal", current.sequence);
    expect(center.find("terminal")?.readAt).toEqual(expect.any(String));
  });

  it("does not upgrade terminal metadata belonging to another owner or stage episode", async () => {
    const { center } = await setup();
    await center.add(input("terminal", { kind: "run-finished", context }));
    for (const changes of [
      { runId: "other" },
      { projectId: "other", context: undefined },
      { stageId: "other" },
      { context: { ...context, contextId: `ctx-${"b".repeat(64)}` } },
    ]) {
      expect(
        await center.add(
          input("terminal", { kind: "run-failed", context, ...changes }),
        ),
      ).toBeNull();
    }
    expect(center.find("terminal")?.kind).toBe("run-finished");
  });

  it("returns independent copies and isolates observer exceptions and unsubscribe", async () => {
    const { center } = await setup();
    const bad = center.onChanged(() => {
      throw new Error("observer failure");
    });
    const observed = vi.fn();
    const stop = center.onChanged(observed);
    const added = await center.add(input());
    added!.projectId = "tampered";
    center.find("episode-1")!.readAt = "tampered";
    center.snapshot().records[0].kind = "run-failed";
    expect(center.find("episode-1")).toMatchObject({
      projectId: "project-1",
      kind: "question",
      readAt: null,
    });
    bad();
    stop();
    await center.markRead("episode-1");
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("publishes read changes only after the atomic durable write completes", async () => {
    const { center } = await setup();
    await center.add(input());
    const before = center.snapshot();
    const observed = vi.fn();
    center.onChanged(observed);
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return actual.rename(...args);
    });
    const mark = center.markRead("episode-1");
    await writing;
    expect(center.snapshot()).toEqual(before);
    expect(observed).not.toHaveBeenCalled();
    release();
    await mark;
    expect(center.snapshot().unreadCount).toBe(0);
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("preserves history and read flags on write failure, sanitizes errors and recovers the queue", async () => {
    const { center, file, dataDir } = await setup();
    await center.add(input());
    const before = await fs.readFile(file, "utf8");
    vi.mocked(fs.rename).mockRejectedValueOnce(
      new Error("SECRET_FIXTURE /private/user/token\nunsafe"),
    );
    await expect(center.markRead("episode-1")).rejects.toThrow();
    expect(center.snapshot()).toMatchObject({
      unreadCount: 1,
      error: expect.any(String),
    });
    expect(center.snapshot().error).not.toMatch(
      /SECRET_FIXTURE|token|unsafe|\n/,
    );
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect(await fs.readdir(dataDir)).toEqual(["notifications.json"]);
    await center.markRead("episode-1");
    expect(center.snapshot()).toMatchObject({ unreadCount: 0 });
    expect(center.snapshot().error).toBeUndefined();
    await center.add(input("after-failure"));
    expect(center.snapshot().unreadCount).toBe(1);
  });

  it("resynchronizes an uncertain renamed commit before exposing its read flags on recovery", async () => {
    const { center, dataDir } = await setup();
    await center.add(input());
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let renamed = false;
    let failSync = true;
    let recoverySyncs = 0;
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await actual.rename(...args);
      renamed = true;
    });
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === dataDir && renamed) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (failSync) {
            failSync = false;
            throw new Error("directory sync failed");
          }
          recoverySyncs++;
          return sync();
        };
      }
      return handle;
    });
    await expect(center.markRead("episode-1")).rejects.toThrow();
    expect(center.snapshot().unreadCount).toBe(1);
    const failedRevision = center.snapshot().revision;
    await center.initialize();
    expect(recoverySyncs).toBe(1);
    expect(center.snapshot().unreadCount).toBe(0);
    expect(center.snapshot().revision).toBeGreaterThan(failedRevision);
  });

  it("does not confirm opt-in or publish an addition on failed persistence", async () => {
    const { center } = await setup();
    const observed = vi.fn();
    center.onChanged(observed);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk full"));
    await expect(center.setSystemEnabled(true)).rejects.toThrow();
    expect(center.snapshot().systemEnabled).toBe(false);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk full"));
    await expect(center.add(input())).rejects.toThrow();
    expect(center.find("episode-1")).toBeUndefined();
    expect(observed.mock.calls.every((call) => call[1] === undefined)).toBe(
      true,
    );
    await center.add(input());
    expect(center.find("episode-1")?.sequence).toBe(1);
  });

  it.each([
    "{broken SECRET_FIXTURE",
    JSON.stringify({ schemaVersion: 99 }),
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      systemEnabled: false,
      records: [{ body: "SECRET_FIXTURE" }],
    }),
  ])("never overwrites corrupt or unsupported state %#", async (raw) => {
    const { center, dataDir, file } = await fixture();
    await fs.mkdir(dataDir, { mode: 0o700 });
    await fs.writeFile(file, raw, { mode: 0o600 });
    await expect(center.initialize()).rejects.toThrow();
    expect(center.snapshot().error).toEqual(expect.any(String));
    expect(center.snapshot().error).not.toContain("SECRET_FIXTURE");
    await expect(center.add(input())).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it("refuses duplicate IDs or sequences in persisted history", async () => {
    const { center, dataDir, file } = await setup();
    await center.add(input());
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    for (const duplicate of [
      state.records[0],
      { ...state.records[0], id: "other" },
    ]) {
      const raw = JSON.stringify({
        ...state,
        records: [...state.records, duplicate],
      });
      await fs.writeFile(file, raw);
      await expect(
        new NotificationCenter(dataDir).initialize(),
      ).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });

  it("refuses oversized state without truncating it", async () => {
    const { center, dataDir, file } = await fixture();
    await fs.mkdir(dataDir, { mode: 0o700 });
    const oversized = " ".repeat(16 * 1024 * 1024 + 1);
    await fs.writeFile(file, oversized, { mode: 0o600 });
    await expect(center.initialize()).rejects.toThrow();
    await expect(center.setSystemEnabled(true)).rejects.toThrow();
    expect((await fs.stat(file)).size).toBe(oversized.length);
  });

  it("refuses symbolic link files and directories without changing their target", async () => {
    const { center, root, dataDir, file } = await fixture();
    await fs.mkdir(dataDir, { mode: 0o700 });
    const target = path.join(root, "target.json");
    await fs.writeFile(target, "do not touch");
    await fs.symlink(target, file);
    await expect(center.initialize()).rejects.toThrow();
    await expect(center.add(input())).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("do not touch");
    const other = path.join(root, "other");
    await fs.mkdir(other);
    const linked = path.join(root, "linked");
    await fs.symlink(other, linked);
    await expect(new NotificationCenter(linked).initialize()).rejects.toThrow();
    expect(await fs.readdir(other)).toEqual([]);
  });

  it("refuses a non-regular file and linked inode state", async () => {
    const { center, dataDir, file, root } = await fixture();
    await fs.mkdir(dataDir, { mode: 0o700 });
    await fs.mkdir(file);
    await expect(center.initialize()).rejects.toThrow();
    await fs.rm(file, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        systemEnabled: false,
        records: [],
      }),
      { mode: 0o600 },
    );
    await fs.link(file, path.join(root, "hard-link"));
    await expect(center.initialize()).rejects.toThrow();
    expect((await fs.stat(file)).nlink).toBe(2);
  });

  it("does not overwrite external corruption introduced after initialization", async () => {
    const { center, file } = await setup();
    await center.add(input());
    await fs.writeFile(file, "external-corruption");
    await expect(center.markRead("episode-1")).rejects.toThrow();
    expect(center.snapshot().unreadCount).toBe(1);
    expect(await fs.readFile(file, "utf8")).toBe("external-corruption");
  });

  it("keeps revision monotonic when a failed initialization is repaired", async () => {
    const { center, dataDir, file } = await fixture();
    await fs.mkdir(dataDir, { mode: 0o700 });
    await fs.writeFile(file, "broken");
    await expect(center.initialize()).rejects.toThrow();
    const failed = center.snapshot();
    await fs.unlink(file);
    await center.initialize();
    expect(center.snapshot().revision).toBeGreaterThan(failed.revision);
    expect(center.snapshot().error).toBeUndefined();
    const initialized = center.snapshot().revision;
    await center.add(input());
    expect(center.snapshot().revision).toBeGreaterThan(initialized);
  });

  it("allows no-op read commands to clear a recovered persistence error durably", async () => {
    const { center } = await setup();
    await center.add(input());
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk full"));
    await expect(center.markRead("episode-1")).rejects.toThrow();
    const failed = center.snapshot();
    await center.setSystemEnabled(false);
    expect(center.snapshot().error).toBeUndefined();
    expect(center.snapshot().revision).toBeGreaterThan(failed.revision);
    expect(center.snapshot().unreadCount).toBe(1);
  });

  it("preserves the original read timestamp when retrying an idempotent command after an error", async () => {
    const { center } = await setup();
    await center.add(input());
    await center.markRead("episode-1");
    const readAt = center.find("episode-1")!.readAt;
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk full"));
    await expect(center.setSystemEnabled(true)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await center.markRead("episode-1");
    expect(center.find("episode-1")!.readAt).toBe(readAt);
    expect(center.snapshot().error).toBeUndefined();
  });

  it("refuses a commit beyond 16 MiB without pruning existing records", async () => {
    const { center, dataDir, file } = await fixture();
    await fs.mkdir(dataDir, { mode: 0o700 });
    const record = {
      ...input("sized"),
      pipeline: "p".repeat(1024),
      topic: "t".repeat(1024),
      branch: "b".repeat(256),
      sequence: 1,
      readAt: null,
    };
    const records = Array.from({ length: 6200 }, (_, index) => ({
      ...record,
      id: `sized-${index}`,
      sequence: index + 1,
    }));
    const state = {
      schemaVersion: 1,
      revision: 1,
      systemEnabled: false,
      records,
    };
    // Compute the fill count once rather than repeatedly serializing a near-16MiB array.
    const maxBytes = 16 * 1024 * 1024;
    const initial = JSON.stringify(state);
    const rowBytes =
      Buffer.byteLength(
        JSON.stringify({ ...record, id: "sized-9999", sequence: 9999 }),
      ) + 1;
    const additional = Math.floor(
      (maxBytes - Buffer.byteLength(initial)) / rowBytes,
    );
    for (let index = 0; index < additional; index++) {
      state.records.push({
        ...record,
        id: `sized-${state.records.length}`,
        sequence: state.records.length + 1,
      });
    }
    const raw = JSON.stringify(state);
    expect(maxBytes - Buffer.byteLength(raw)).toBeLessThan(rowBytes);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16 * 1024 * 1024);
    await fs.writeFile(file, raw, { mode: 0o600 });
    await center.initialize();
    await expect(
      center.add(
        input("too-large".repeat(28), {
          pipeline: record.pipeline,
          topic: record.topic,
          branch: record.branch,
        }),
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect(center.snapshot().unreadCount).toBe(records.length);
    expect(center.find("too-large".repeat(28))).toBeUndefined();
  });

  it("refuses an externally substituted symlink before commit", async () => {
    const { center, root, file } = await setup();
    await center.add(input());
    const target = path.join(root, "do-not-touch");
    await fs.writeFile(target, "protected");
    await fs.unlink(file);
    await fs.symlink(target, file);
    await expect(
      center.markAllRead(center.snapshot().throughSequence),
    ).rejects.toThrow();
    expect(center.snapshot().unreadCount).toBe(1);
    expect(await fs.readFile(target, "utf8")).toBe("protected");
  });
});

it("persists a currently viewed arrival as read before publishing any counter", async () => {
  const { center, dataDir } = await setup();
  const counts: number[] = [];
  center.onChanged((s) => counts.push(s.unreadCount));
  const added = await center.add(input("viewed"), () => true);
  expect(added?.readAt).not.toBeNull();
  expect(counts).toEqual([0]);
  expect(center.snapshot()).toMatchObject({
    unreadCount: 0,
    unreadRunIds: [],
    byProject: {},
  });
  const restored = new NotificationCenter(dataDir);
  await restored.initialize();
  expect(restored.find("viewed")?.readAt).toBe(added?.readAt);
});

it("evaluates foreground eligibility when the serialized add executes, not when queued", async () => {
  const { center } = await setup();
  let viewed = true;
  const pending = center.add(input("left-before-save"), () => viewed);
  viewed = false;
  const added = await pending;
  expect(added?.readAt).toBeNull();
  expect(center.snapshot().unreadCount).toBe(1);
});

it("reads the matching owner's full backlog in one publication, not just the visible page", async () => {
  const { center } = await setup();
  for (let i = 0; i < 55; i++) await center.add(input(`mine-${i}`));
  await center.add(input("other", { runId: "other" }));
  const changes = vi.fn();
  center.onChanged(changes);
  await center.markMatchingRead(
    center.snapshot().throughSequence,
    (r) => r.runId === "run-1",
  );
  expect(changes).toHaveBeenCalledTimes(1);
  expect(center.snapshot()).toMatchObject({
    unreadCount: 1,
    unreadRunIds: ["other"],
  });
  expect(center.find("mine-0")?.readAt).not.toBeNull();
  expect(center.find("other")?.readAt).toBeNull();
});

it("does not read a new arrival or terminal upgrade beyond the captured viewing sequence", async () => {
  const { center } = await setup();
  await center.add(input("terminal", { kind: "process-exited" }));
  const bound = center.snapshot().throughSequence;
  await center.add(input("terminal", { kind: "run-failed" }));
  await center.add(input("later"));
  await center.markMatchingRead(bound, () => true);
  expect(center.snapshot().unreadCount).toBe(2);
  expect(center.find("terminal")?.readAt).toBeNull();
});

it("rechecks viewing eligibility when the queued backlog read executes", async () => {
  const { center } = await setup();
  await center.add(input("unseen"));
  let viewed = true;
  const read = center.markMatchingRead(1, () => viewed);
  viewed = false;
  await read;
  expect(center.snapshot().unreadCount).toBe(1);
});

it("keeps unread state and counters when persisting automatic viewing fails", async () => {
  const { center } = await setup();
  await center.add(input("pending"));
  const counts: number[] = [];
  center.onChanged((s) => counts.push(s.unreadCount));
  vi.mocked(fs.rename).mockRejectedValueOnce(Error("Synthetic write failure"));
  await expect(center.markMatchingRead(1, () => true)).rejects.toThrow(
    /историю/,
  );
  expect(center.find("pending")?.readAt).toBeNull();
  expect(counts).toEqual([1]);
  expect(center.snapshot().unreadCount).toBe(1);
});
