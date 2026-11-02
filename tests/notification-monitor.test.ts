import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NotificationMonitor } from "../src/main/notification-monitor";
import {
  NotificationInputSchema,
  type NotificationInput,
} from "../src/shared/notifications";
import type { Run } from "../src/shared/types";

const at = "2026-11-01T12:00:00.000Z";
const owner = {
  projectId: "project-1",
  year: "2026",
  topic: "topic",
  branch: "feature/topic",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "123e4567-e89b-42d3-a456-426614174000",
};
const run = (changes: Partial<Run> = {}): Run => ({
  id: "run-1",
  projectId: "project-1",
  pipeline: "pipeline.yml",
  pipelineName: "Review",
  topic: "topic",
  branch: "feature/topic",
  status: "running",
  kind: "pipeline",
  url: "http://localhost:4123",
  workflow: null,
  profile: null,
  startedAt: at,
  context: { ...owner, path: "/private/project", repositoryKey: "private-key" },
  ...changes,
});
const stage = (
  status = "awaiting_user_input",
  changes: Record<string, unknown> = {},
) => ({
  id: "review",
  status,
  updated_at: at,
  ...changes,
});
const snapshot = (
  stages: unknown[] = [stage()],
  changes: Record<string, unknown> = {},
) => ({
  run_id: "afm-1",
  run_status: "running",
  stages,
  ...changes,
});
const hash = (values: unknown[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
const response = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), init);
const monitors: NotificationMonitor[] = [];
class FakeSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  close = vi.fn();
  message(data: unknown) {
    this.onmessage?.({ data });
  }
}
function fixture(
  fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(snapshot([]))),
) {
  const records: NotificationInput[] = [];
  const add = vi.fn(async (input: NotificationInput) => {
    records.push(input);
  });
  const errors = vi.fn<(runId: string, message: string | null) => void>();
  const sockets: FakeSocket[] = [];
  const socket = vi.fn((_url: string): WebSocket => {
    const value = new FakeSocket();
    sockets.push(value);
    return value as unknown as WebSocket;
  });
  const monitor = new NotificationMonitor({
    add,
    onError: errors,
    fetch: fetcher,
    socket,
  });
  monitors.push(monitor);
  return { monitor, fetcher, records, add, errors, sockets, socket };
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => {
  for (const value of monitors.splice(0)) value.dispose();
  vi.useRealTimers();
});

describe("NotificationMonitor eligibility and host lifecycle", () => {
  it("observes only Host-owned active pipeline dashboard URLs", async () => {
    const f = fixture();
    const rejected: Partial<Run>[] = [
      { kind: "build" },
      { status: "starting" },
      { status: "exited" },
      { dashboardOpened: false },
      { recovery: "confirmed" },
      { recovery: "unverified" },
      { url: undefined },
      ...[
        "http://localhost:4123/path",
        "http://localhost:4123/?token=x",
        "http://localhost:4123/#x",
        "http://user@localhost:4123",
        "http://127.1:4123",
        "http://0x7f000001:4123",
        "https://localhost:4123",
        "http://example.test:4123",
        "http://localhost:65536",
      ].map((url) => ({ url })),
    ];
    f.monitor.reconcile(
      rejected.map((value, i) => run({ ...value, id: `rejected-${i}` })),
    );
    await settle();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.socket).not.toHaveBeenCalled();
    f.monitor.reconcile([run(), run({ id: "v6", url: "http://[::1]:4124/" })]);
    await settle();
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:4123/api/status",
      "http://[::1]:4124/api/status",
    ]);
    expect(f.socket.mock.calls.map(([url]) => url)).toEqual([
      "ws://localhost:4123/ws",
      "ws://[::1]:4124/ws",
    ]);
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
  });

  it("does not replay initial terminal runs and records observed starting/running terminal transitions", async () => {
    const f = fixture();
    f.monitor.reconcile([
      run({ id: "old", status: "failed" }),
      run({ status: "starting", url: undefined }),
    ]);
    expect(f.records).toEqual([]);
    f.monitor.reconcile([
      run({ id: "old", status: "failed" }),
      run({ status: "failed", endedAt: at }),
    ]);
    await settle();
    expect(f.records).toEqual([
      expect.objectContaining({
        id: hash(["run-1", "terminal"]),
        kind: "run-failed",
        occurredAt: at,
      }),
    ]);
    expect(f.records[0]).not.toHaveProperty("stageId");
    f.monitor.reconcile([run({ status: "failed" })]);
    await settle();
    expect(f.records).toHaveLength(1);
  });

  it("ignores stopped, build and recovered lifecycle transitions", async () => {
    const f = fixture();
    f.monitor.reconcile([
      run({ id: "stopped" }),
      run({ id: "build", kind: "build" }),
      run({ id: "recovered", recovery: "confirmed" }),
    ]);
    await settle();
    f.monitor.reconcile([
      run({ id: "stopped", status: "stopped" }),
      run({ id: "build", kind: "build", status: "failed" }),
      run({ id: "recovered", recovery: "confirmed", status: "failed" }),
    ]);
    await settle();
    expect(f.records).toEqual([]);
  });

  it("records process-exited without inferring pipeline success and honors Host errors", async () => {
    const f = fixture();
    f.monitor.reconcile([run(), run({ id: "error" })]);
    await settle();
    f.monitor.reconcile([
      run({ status: "exited" }),
      run({ id: "error", status: "exited", error: "secret local path" }),
    ]);
    await settle();
    expect(f.records.map((value) => value.kind)).toEqual([
      "process-exited",
      "run-failed",
    ]);
    expect(JSON.stringify(f.records)).not.toContain("secret");
  });
});

describe("AFM snapshot normalization", () => {
  it("records initial attention stages, ignores unknown states and strips raw payload and private context", async () => {
    const states = [
      "awaiting_user_input",
      "awaiting_approval",
      "failed",
      "hook_failed",
      "paused",
      "awaiting_assistants",
      "awaiting_assistants",
      "done",
      "new_future_state",
    ];
    const f = fixture(
      vi.fn<typeof fetch>().mockResolvedValue(
        response(
          snapshot(
            states.map((status, i) =>
              stage(status, {
                id: `stage-${i}`,
                awaiting_assistants_blocked: i === 5,
                question: "SECRET",
                agent_messages: ["SECRET"],
              }),
            ),
            { events: ["SECRET"] },
          ),
        ),
      ),
    );
    f.monitor.reconcile([
      run({ pipelineName: "Re\u0000view\u202e" + "x".repeat(1100) }),
    ]);
    await settle();
    expect(f.records.map((value) => value.kind)).toEqual([
      "question",
      "approval",
      "stage-failed",
      "stage-failed",
      "paused",
      "assistant-decision",
    ]);
    for (const value of f.records) {
      expect(NotificationInputSchema.safeParse(value).success).toBe(true);
      expect(value.context).toEqual(owner);
      expect(value.pipeline.length).toBe(1024);
      expect(value.pipeline).not.toMatch(/[\u0000\u202e]/);
    }
    expect(JSON.stringify(f.records)).not.toMatch(
      /SECRET|private\/project|private-key|events|question":/,
    );
  });

  it("uses AFM run/stage/kind/update identity, normalized timestamps and no duplicate poll events", async () => {
    const f = fixture(
      vi.fn<typeof fetch>().mockImplementation(async () =>
        response(
          snapshot([
            stage("awaiting_user_input", {
              updated_at: "2026-11-01T15:00:00+03:00",
            }),
          ]),
        ),
      ),
    );
    f.monitor.reconcile([run()]);
    await settle();
    expect(f.records[0]).toMatchObject({
      id: hash(["run-1", "afm-1", "review", "question", at]),
      occurredAt: at,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.records).toHaveLength(1);
    f.fetcher.mockResolvedValue(
      response(
        snapshot([
          stage("awaiting_user_input", { updated_at: "2026-11-01T12:01:00Z" }),
        ]),
      ),
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.records).toHaveLength(2);
  });

  it("rejects malformed stage identities and timestamps without treating unknown data as success", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(
            snapshot(
              [
                stage("awaiting_user_input", { id: "bad\nidentifier" }),
                stage("paused", { updated_at: "not-a-date" }),
                stage("paused", { updated_at: "2026-02-30T12:00:00Z" }),
                stage("failed", { id: "x".repeat(257) }),
                stage("unknown"),
                { status: "awaiting_user_input", updated_at: at },
              ],
              { run_status: "unknown", events: [{ type: "run_finished" }] },
            ),
          ),
        ),
    );
    f.monitor.reconcile([run()]);
    await settle();
    expect(f.records).toEqual([]);
  });

  it("coalesces successful snapshot and later Host exit with identical owner metadata and terminal id", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(
            snapshot([stage("done")], { run_status: "finished", ended_at: at }),
          ),
        ),
    );
    f.monitor.reconcile([run()]);
    await settle();
    f.monitor.reconcile([run({ status: "exited", endedAt: at })]);
    await settle();
    expect(f.records.map((value) => value.kind)).toEqual([
      "run-finished",
      "process-exited",
    ]);
    const [finished, exited] = f.records;
    expect(finished.id).toBe(hash(["run-1", "terminal"]));
    expect({ ...finished, kind: exited.kind }).toEqual(exited);
    expect(finished).not.toHaveProperty("stageId");
  });

  it.each(["failed", "interrupted"])(
    "maps terminal AFM %s to run-failed",
    async (status) => {
      const f = fixture(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response(snapshot([], { run_status: status, ended_at: at })),
          ),
      );
      f.monitor.reconcile([run()]);
      await settle();
      expect(f.records.map((value) => value.kind)).toEqual(["run-failed"]);
    },
  );

  it.each([
    snapshot([], { run_status: "finished", ended_at: at }),
    snapshot([stage("unknown")], { run_status: "finished", ended_at: at }),
    snapshot([stage("running")], { run_status: "finished", ended_at: at }),
    snapshot([stage("done")], { run_status: "unknown", ended_at: at }),
  ])(
    "never infers successful completion from an incomplete or unknown snapshot",
    async (body) => {
      const f = fixture(
        vi.fn<typeof fetch>().mockResolvedValue(response(body)),
      );
      f.monitor.reconcile([run()]);
      await settle();
      expect(f.records).toEqual([]);
    },
  );

  it("does not record success while the Host reports an error", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(
            snapshot([stage("done")], { run_status: "finished", ended_at: at }),
          ),
        ),
    );
    f.monitor.reconcile([run({ error: "private error" })]);
    await settle();
    expect(f.records).toEqual([]);
  });

  it.each([
    [{ ended_at: undefined }, at],
    [{ ended_at: "invalid" }, at],
    [{ ended_at: undefined, stages: [] }, at],
  ])(
    "uses a valid fallback timestamp for optional terminal ended_at",
    async (changes, expected) => {
      const f = fixture(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response(
              snapshot([stage("done")], { run_status: "failed", ...changes }),
            ),
          ),
      );
      f.monitor.reconcile([run()]);
      await settle();
      expect(f.records).toEqual([
        expect.objectContaining({ kind: "run-failed", occurredAt: expected }),
      ]);
    },
  );

  it("prefers the latest valid stage update over wall time for a terminal fallback", async () => {
    const f = fixture(
      vi.fn<typeof fetch>().mockResolvedValue(
        response(
          snapshot(
            [
              stage("done", { updated_at: "2026-10-31T23:59:00Z" }),
              stage("done", {
                id: "other",
                updated_at: "2026-11-01T10:30:00+03:00",
              }),
            ],
            { run_status: "finished" },
          ),
        ),
      ),
    );
    f.monitor.reconcile([run()]);
    await settle();
    expect(f.records[0]).toMatchObject({
      kind: "run-finished",
      occurredAt: "2026-11-01T07:30:00.000Z",
    });
  });

  it("pins the first AFM run id and permanently stops a changed origin with a generic warning", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response(snapshot([]))),
    );
    f.monitor.reconcile([run()]);
    await settle();
    f.fetcher.mockResolvedValue(
      response(snapshot([stage()], { run_id: "unrelated-secret-run" })),
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.records).toEqual([]);
    expect(f.errors).toHaveBeenLastCalledWith("run-1", expect.any(String));
    expect(JSON.stringify(f.errors.mock.calls)).not.toContain(
      "unrelated-secret-run",
    );
    f.monitor.reconcile([run()]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.sockets[0].close).toHaveBeenCalled();
  });
});

describe("transport budgets and generation fences", () => {
  it.each(["removed", "url", "disposed", "ended"])(
    "ignores a late response after %s",
    async (reason) => {
      const late = deferred<Response>();
      const f = fixture(
        vi
          .fn<typeof fetch>()
          .mockReturnValueOnce(late.promise)
          .mockImplementation(async () => response(snapshot([]))),
      );
      f.monitor.reconcile([run()]);
      if (reason === "removed") f.monitor.reconcile([]);
      if (reason === "url")
        f.monitor.reconcile([run({ url: "http://localhost:5123" })]);
      if (reason === "disposed") f.monitor.dispose();
      if (reason === "ended") f.monitor.reconcile([run({ status: "exited" })]);
      late.resolve(response(snapshot([stage()])));
      await settle();
      expect(f.records.filter((value) => value.stageId)).toEqual([]);
      if (reason !== "url") expect(f.sockets[0].close).toHaveBeenCalled();
    },
  );

  it("keeps polling single-flight, bounds the deadline and does not queue WS or poll requests", async () => {
    const late = deferred<Response>();
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(late.promise)
        .mockImplementation(async () => response(snapshot([]))),
    );
    f.monitor.reconcile([run()]);
    const signal = f.fetcher.mock.calls[0][1]?.signal;
    for (let i = 0; i < 100; i++)
      f.sockets[0].message(JSON.stringify({ type: "stage_status_changed" }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    late.resolve(response(snapshot([stage()])));
    await settle();
    expect(f.records).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("caps declared and streamed response payloads at 2 MiB", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          response(snapshot([stage()]), {
            headers: { "content-length": String(2 * 1024 * 1024 + 1) },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
                controller.close();
              },
            }),
          ),
        ),
    );
    f.monitor.reconcile([run()]);
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.records).toEqual([]);
    expect(f.errors.mock.calls.filter(([, message]) => message)).toHaveLength(
      2,
    );
  });

  it("rejects redirects and invalid JSON, redacts transport errors and recovers on the next poll", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("SECRET /private/token"))
        .mockResolvedValueOnce(
          new Response("{}", {
            status: 302,
            headers: { location: "http://external.test" },
          }),
        )
        .mockResolvedValueOnce(new Response("not json SECRET"))
        .mockResolvedValueOnce(response(snapshot([stage()]))),
    );
    f.monitor.reconcile([run()]);
    await settle();
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.records).toHaveLength(1);
    expect(JSON.stringify(f.errors.mock.calls)).not.toMatch(
      /SECRET|private|external/,
    );
    expect(f.errors).toHaveBeenLastCalledWith("run-1", null);
    expect(
      f.fetcher.mock.calls.every(
        ([url]) => url === "http://localhost:4123/api/status",
      ),
    ).toBe(true);
  });

  it("contains persistence failures without leaking their message and retries a stage next poll", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response(snapshot([stage()]))),
    );
    f.add.mockRejectedValueOnce(new Error("SECRET"));
    f.monitor.reconcile([run()]);
    await settle();
    expect(f.records).toEqual([]);
    expect(f.errors).toHaveBeenCalledWith("run-1", expect.any(String));
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.records).toHaveLength(1);
    expect(JSON.stringify(f.errors.mock.calls)).not.toContain("SECRET");
  });

  it("uses significant bounded WS messages only as a coalesced snapshot wake-up", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response(snapshot([]))),
    );
    f.monitor.reconcile([run()]);
    await settle();
    for (const type of [
      "script_output",
      "agent_action",
      "mesh_message",
      "stage_updated",
      "unknown",
    ])
      f.sockets[0].message(JSON.stringify({ type }));
    f.sockets[0].message("not JSON");
    f.sockets[0].message(new Uint8Array(10));
    f.sockets[0].message(
      JSON.stringify({ type: "ask_user", payload: "x".repeat(65536) }),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++)
      f.sockets[0].message(
        JSON.stringify({
          type: "stage_status_changed",
          data: "SECRET",
          timestamp: at,
        }),
      );
    await vi.advanceTimersByTimeAsync(200);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.records).toEqual([]);
  });

  it("detaches and closes a failed socket before reconnecting and ignores stale callbacks", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response(snapshot([]))),
    );
    f.monitor.reconcile([run()]);
    await settle();
    const old = f.sockets[0],
      staleMessage = old.onmessage;
    old.onerror?.({});
    expect(old.close).toHaveBeenCalled();
    expect(old.onmessage).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    staleMessage?.({ data: JSON.stringify({ type: "ask_user" }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("reconnects with bounded backoff and cancels socket/poll timers on dispose", async () => {
    const f = fixture();
    f.monitor.reconcile([run()]);
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = f.socket.mock.calls.length;
      f.sockets.at(-1)!.onclose?.({});
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.socket).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.socket).toHaveBeenCalledTimes(count + 1);
    }
    f.monitor.dispose();
    const polls = f.fetcher.mock.calls.length,
      connections = f.socket.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.fetcher).toHaveBeenCalledTimes(polls);
    expect(f.socket).toHaveBeenCalledTimes(connections);
  });
});

describe("terminal retry and warning lifecycle regressions", () => {
  it("retries a rejected Host terminal once on a timer without requiring a new transition", async () => {
    const f = fixture();
    f.add.mockRejectedValueOnce(
      new Error("SECRET store temporarily unavailable"),
    );
    f.monitor.reconcile([run({ status: "starting", url: undefined })]);
    f.monitor.reconcile([run({ status: "failed", endedAt: at })]);
    await settle();
    f.monitor.reconcile([run({ status: "failed", endedAt: at })]);
    expect(f.add).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.add).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.add).toHaveBeenCalledTimes(2);
    expect(f.records).toEqual([
      expect.objectContaining({
        id: hash(["run-1", "terminal"]),
        kind: "run-failed",
      }),
    ]);
    expect(f.add.mock.calls[0][0]).toEqual(f.add.mock.calls[1][0]);
    expect(f.errors).toHaveBeenLastCalledWith("run-1", null);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.add).toHaveBeenCalledTimes(2);
  });

  it("keeps only one retry timer per pending terminal and caps backoff at 30 seconds", async () => {
    const f = fixture();
    f.add.mockRejectedValue(new Error("store unavailable"));
    f.monitor.reconcile([run({ status: "starting", url: undefined })]);
    f.monitor.reconcile([run({ status: "failed" })]);
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = f.add.mock.calls.length;
      for (let i = 0; i < 20; i++)
        f.monitor.reconcile([run({ status: "failed" })]);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.add).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.add).toHaveBeenCalledTimes(count + 1);
    }
  });

  it.each([
    "removed",
    "disposed",
    "owner",
    "url",
    "active",
    "recovery",
    "build",
  ])("drops pending terminal retry when %s", async (reason) => {
    const f = fixture();
    f.add.mockRejectedValue(new Error("store unavailable"));
    f.monitor.reconcile([run({ status: "starting", url: undefined })]);
    f.monitor.reconcile([run({ status: "failed" })]);
    await settle();
    if (reason === "removed") f.monitor.reconcile([]);
    if (reason === "disposed") f.monitor.dispose();
    if (reason === "owner")
      f.monitor.reconcile([
        run({ status: "failed", projectId: "other", context: undefined }),
      ]);
    if (reason === "url")
      f.monitor.reconcile([
        run({ status: "failed", url: "http://localhost:5123" }),
      ]);
    if (reason === "active")
      f.monitor.reconcile([run({ status: "starting", url: undefined })]);
    if (reason === "recovery")
      f.monitor.reconcile([run({ status: "failed", recovery: "confirmed" })]);
    if (reason === "build")
      f.monitor.reconcile([run({ status: "failed", kind: "build" })]);
    expect(f.errors).toHaveBeenLastCalledWith("run-1", null);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.add).toHaveBeenCalledTimes(1);
  });

  it.each(["removed", "disposed", "stopped", "replacement"])(
    "clears an observer warning when %s",
    async (reason) => {
      const f = fixture(
        vi.fn<typeof fetch>().mockRejectedValue(new Error("transport offline")),
      );
      f.monitor.reconcile([run()]);
      await settle();
      expect(f.errors).toHaveBeenLastCalledWith("run-1", expect.any(String));
      if (reason === "removed") f.monitor.reconcile([]);
      if (reason === "disposed") f.monitor.dispose();
      if (reason === "stopped")
        f.monitor.reconcile([run({ status: "stopped" })]);
      if (reason === "replacement")
        f.monitor.reconcile([
          run({ status: "starting", url: "http://localhost:5123" }),
        ]);
      expect(f.errors).toHaveBeenLastCalledWith("run-1", null);
    },
  );

  it.each(["snapshot", "terminal"])(
    "does not let an old %s add rejection overwrite a replacement observer warning",
    async (source) => {
      const pending = deferred<void>();
      const f = fixture(
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(response(snapshot([stage()])))
          .mockRejectedValue(new Error("new observer offline")),
      );
      f.add.mockReturnValueOnce(pending.promise);
      if (source === "snapshot") {
        f.monitor.reconcile([run()]);
        await settle();
      } else {
        f.monitor.reconcile([run({ status: "starting", url: undefined })]);
        f.monitor.reconcile([run({ status: "failed" })]);
        await settle();
      }
      expect(f.add).toHaveBeenCalledTimes(1);
      f.fetcher
        .mockReset()
        .mockRejectedValue(new Error("new observer offline"));
      f.monitor.reconcile([run({ url: "http://localhost:5123" })]);
      await settle();
      const calls = [...f.errors.mock.calls];
      expect(calls.at(-1)?.[1]).toEqual(expect.any(String));
      pending.reject(new Error("SECRET old generation"));
      await settle();
      expect(f.errors.mock.calls).toEqual(calls);
      expect(f.add).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["snapshot", "terminal"])(
    "does not report an old %s add rejection after dispose",
    async (source) => {
      const pending = deferred<void>();
      const f = fixture(
        vi.fn<typeof fetch>().mockResolvedValue(response(snapshot([stage()]))),
      );
      f.add.mockReturnValueOnce(pending.promise);
      if (source === "snapshot") f.monitor.reconcile([run()]);
      else {
        f.monitor.reconcile([run({ status: "starting", url: undefined })]);
        f.monitor.reconcile([run({ status: "failed" })]);
      }
      await settle();
      expect(f.add).toHaveBeenCalledTimes(1);
      f.monitor.dispose();
      const calls = [...f.errors.mock.calls];
      pending.reject(new Error("old generation"));
      await settle();
      expect(f.errors.mock.calls).toEqual(calls);
      expect(f.errors).toHaveBeenLastCalledWith("run-1", null);
    },
  );

  it("does not clear the replacement warning when an old terminal add succeeds late", async () => {
    const pending = deferred<void>();
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("new observer offline")),
    );
    f.add.mockReturnValueOnce(pending.promise);
    f.monitor.reconcile([run({ status: "starting", url: undefined })]);
    f.monitor.reconcile([run({ status: "failed" })]);
    await settle();
    f.monitor.reconcile([run({ url: "http://localhost:5123" })]);
    await settle();
    const calls = [...f.errors.mock.calls];
    pending.resolve();
    await settle();
    expect(f.errors.mock.calls).toEqual(calls);
  });
});

describe("shared Host and AFM terminal retry regressions", () => {
  it("retries an AFM failure after Host exits without downgrading it to process-exited", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(snapshot([], { run_status: "failed", ended_at: at })),
        ),
    );
    f.add.mockRejectedValueOnce(new Error("temporary store failure"));
    f.monitor.reconcile([run()]);
    await settle();
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.add.mock.calls[0][0].kind).toBe("run-failed");
    f.monitor.reconcile([run({ status: "exited", endedAt: at })]);
    await settle();
    expect(f.add).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.records).toEqual([
      expect.objectContaining({
        kind: "run-failed",
        id: hash(["run-1", "terminal"]),
      }),
    ]);
    expect(f.add).toHaveBeenCalledTimes(2);
  });

  it("keeps an AFM terminal retry while Host is still running across reconciles", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(snapshot([], { run_status: "failed", ended_at: at })),
        ),
    );
    f.add.mockRejectedValueOnce(new Error("temporary store failure"));
    f.monitor.reconcile([run()]);
    await settle();
    for (let i = 0; i < 20; i++) f.monitor.reconcile([run()]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.records.map((value) => value.kind)).toEqual(["run-failed"]);
    expect(f.add).toHaveBeenCalledTimes(2);
  });

  it("retains an in-flight AFM failure target when Host exits before add rejects", async () => {
    const pending = deferred<void>();
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(snapshot([], { run_status: "failed", ended_at: at })),
        ),
    );
    f.add.mockReturnValueOnce(pending.promise);
    f.monitor.reconcile([run()]);
    await settle();
    f.monitor.reconcile([run({ status: "exited", endedAt: at })]);
    await settle();
    expect(f.add).toHaveBeenCalledTimes(1);
    pending.reject(new Error("store rejected after Host exit"));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.records.map((value) => value.kind)).toEqual(["run-failed"]);
    expect(f.add).toHaveBeenCalledTimes(2);
  });

  it.each(["reject", "resolve"])(
    "preserves a Host severity upgrade while the weaker AFM add will %s",
    async (outcome) => {
      const pending = deferred<void>();
      const f = fixture(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response(
              snapshot([stage("done")], {
                run_status: "finished",
                ended_at: at,
              }),
            ),
          ),
      );
      f.add.mockReturnValueOnce(pending.promise);
      f.monitor.reconcile([run()]);
      await settle();
      expect(f.add.mock.calls[0][0].kind).toBe("run-finished");
      f.monitor.reconcile([run({ status: "failed", endedAt: at })]);
      await settle();
      expect(f.add).toHaveBeenCalledTimes(1);
      if (outcome === "reject")
        pending.reject(new Error("store rejected weak event"));
      else pending.resolve();
      await settle();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.records.map((value) => value.kind)).toEqual(["run-failed"]);
      expect(f.add).toHaveBeenCalledTimes(2);
      expect(f.add.mock.calls[0][0].id).toBe(f.add.mock.calls[1][0].id);
    },
  );

  it("keeps a previously observed AFM failure pending while a stopped Host run still exists", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(snapshot([], { run_status: "failed", ended_at: at })),
        ),
    );
    f.add.mockRejectedValueOnce(new Error("temporary store failure"));
    f.monitor.reconcile([run()]);
    await settle();
    f.monitor.reconcile([run({ status: "stopped", endedAt: at })]);
    await settle();
    expect(f.add).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.records.map((value) => value.kind)).toEqual(["run-failed"]);
  });

  it("retains pending AFM success rather than downgrading it to a Host process exit", async () => {
    const f = fixture(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(
            snapshot([stage("done")], { run_status: "finished", ended_at: at }),
          ),
        ),
    );
    f.add.mockRejectedValueOnce(new Error("temporary store failure"));
    f.monitor.reconcile([run()]);
    await settle();
    f.monitor.reconcile([run({ status: "exited", endedAt: at })]);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.records.map((value) => value.kind)).toEqual(["run-finished"]);
    expect(f.add).toHaveBeenCalledTimes(2);
  });
});
