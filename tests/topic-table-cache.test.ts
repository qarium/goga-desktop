import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopicBoardSnapshot } from "../src/shared/topics";
import {
  TopicTableCache,
  type TopicTableScope,
} from "../src/renderer/topic-table-cache";

const A = { projectId: "a", path: "/tmp/a", year: "2026" };
const B = { ...A, projectId: "b", path: "/tmp/b" };
function board(scope: TopicTableScope, generation = "one"): TopicBoardSnapshot {
  return {
    projectId: scope.projectId,
    year: scope.year,
    revision: `display:${generation}`,
    currentBranch: "",
    currentTopic: null,
    baseRef: "",
    branches: [],
    dirty: false,
    active: false,
    entries: [],
    records: [],
    remoteEntries: [],
    remoteRecords: [],
  };
}
function harness() {
  const flights: {
    signal: AbortSignal;
    resolve: (s: TopicBoardSnapshot) => void;
    reject: (e: Error) => void;
  }[] = [];
  const read = vi.fn(
    (signal: AbortSignal, _scope: TopicTableScope) =>
      new Promise<TopicBoardSnapshot>((resolve, reject) => {
        flights.push({ signal, resolve, reject });
      }),
  );
  const cache = new TopicTableCache(read);
  return { cache, flights, read };
}

describe("active project topic table", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("prefetches on selection, not on subscribing to or reopening the section", async () => {
    const { cache, flights, read } = harness();
    const notice = vi.fn();
    const stop = cache.subscribe(A, notice);
    expect(read).not.toHaveBeenCalled();
    cache.activate(A);
    cache.activate({ ...A });
    expect(cache.getSnapshot(A).loading).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const result = board(A);
    const done = cache.refresh(A);
    flights[0]!.resolve(result);
    await done;
    expect(cache.getSnapshot(A)).toMatchObject({
      board: result,
      loading: false,
      error: "",
    });
    expect(notice).toHaveBeenCalled();
    stop();
    cache.subscribe(A, vi.fn());
    cache.activate(A);
    expect(cache.getSnapshot(A).board).toBe(result);
    expect(read).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it("waits a full minute from completion, including slow reads, and joins manual refreshes", async () => {
    const { cache, flights, read } = harness();
    cache.activate(A);
    const done = cache.refresh(A);
    expect(cache.refresh(A)).toBe(done);
    await vi.advanceTimersByTimeAsync(140_000);
    expect(read).toHaveBeenCalledTimes(1);
    flights[0]!.resolve(board(A));
    await done;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    const poll = cache.refresh(A);
    expect(read).toHaveBeenCalledTimes(2);
    flights[1]!.resolve(board(A));
    await poll;
    await vi.advanceTimersByTimeAsync(20_000);
    void cache.refresh(A);
    expect(read).toHaveBeenCalledTimes(3);
    cache.dispose();
  });

  it("keeps last good rows on error, including mismatched project and year; manual retry recovers", async () => {
    const { cache, flights } = harness();
    cache.activate(A);
    const first = cache.refresh(A);
    const good = board(A);
    flights[0]!.resolve(good);
    await first;
    for (const [i, value] of [
      board(B),
      board({ ...A, year: "2025" }),
    ].entries()) {
      const retry = cache.refresh(A);
      flights[i + 1]!.resolve(value);
      await retry;
      expect(cache.getSnapshot(A)).toMatchObject({
        board: good,
        loading: false,
        error: expect.stringMatching(/год|проект/),
      });
    }
    const failure = cache.refresh(A);
    flights[3]!.reject(
      Error(
        "Error invoking remote method 'goga:read-request': Error: Нет связи",
      ),
    );
    await failure;
    expect(cache.getSnapshot(A)).toMatchObject({
      board: good,
      loading: false,
      error: "Нет связи",
    });
    const recovery = cache.refresh(A);
    const newer = board(A, "two");
    flights[4]!.resolve(newer);
    await recovery;
    expect(cache.getSnapshot(A)).toMatchObject({ board: newer, error: "" });
    cache.dispose();
  });

  it("cancels on owner switch; fences late responses even for the same id/year at a new path", async () => {
    const { cache, flights, read } = harness();
    cache.activate(A);
    const obsolete = cache.refresh(A);
    const moved = { ...A, path: "/tmp/moved" };
    cache.activate(moved);
    expect(flights[0]!.signal.aborted).toBe(true);
    const done = cache.refresh(moved);
    flights[0]!.resolve(board(A, "obsolete"));
    await obsolete;
    expect(cache.getSnapshot(A).board).toBeNull();
    expect(cache.getSnapshot(moved).board).toBeNull();
    flights[1]!.resolve(board(moved, "fresh"));
    await done;
    const next = { ...moved, year: "2027" };
    cache.activate(next);
    expect(cache.getSnapshot(next).board).toBeNull();
    expect(cache.getSnapshot(moved).board?.revision).toBe("display:fresh");
    await cache.refresh(A);
    expect(read).toHaveBeenCalledTimes(3);
    cache.dispose();
  });

  it("does no background work when paused; returning immediately displays the previous good list", async () => {
    const { cache, flights, read } = harness();
    cache.activate(A);
    const first = cache.refresh(A);
    const good = board(A);
    flights[0]!.resolve(good);
    await first;
    cache.activate(null);
    await vi.advanceTimersByTimeAsync(600_000);
    cache.invalidate(A);
    await cache.refresh(A);
    expect(read).toHaveBeenCalledTimes(1);
    cache.activate(A);
    expect(cache.getSnapshot(A)).toMatchObject({ board: good, loading: true });
    const late = cache.refresh(A);
    cache.activate(null);
    expect(flights[1]!.signal.aborted).toBe(true);
    flights[1]!.reject(Error("cancelled"));
    await late;
    expect(cache.getSnapshot(A)).toMatchObject({
      board: good,
      loading: false,
      error: "",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("coalesces invalidation during a read into one fresh pass, never exposing its obsolete result", async () => {
    const { cache, flights, read } = harness();
    cache.activate(A);
    const one = cache.refresh(A);
    cache.invalidate(A);
    cache.invalidate(A);
    expect(read).toHaveBeenCalledTimes(1);
    flights[0]!.resolve(board(A, "obsolete"));
    await one;
    expect(cache.getSnapshot(A)).toMatchObject({ loading: true, board: null });
    expect(read).toHaveBeenCalledTimes(2);
    const two = cache.refresh(A);
    flights[1]!.resolve(board(A, "fresh"));
    await two;
    expect(cache.getSnapshot(A).board?.revision).toBe("display:fresh");
    expect(read).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("does not start a queued invalidation after switching projects or disposal", async () => {
    const { cache, flights, read } = harness();
    cache.activate(A);
    const one = cache.refresh(A);
    cache.invalidate(A);
    cache.activate(B);
    const two = cache.refresh(B);
    cache.dispose();
    flights[0]!.resolve(board(A));
    flights[1]!.resolve(board(B));
    await Promise.all([one, two]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.getSnapshot(A).board).toBeNull();
  });

  it("does not query an incomplete year while the user edits it", async () => {
    const { cache, flights, read } = harness();
    cache.activate(A);
    cache.activate({ ...A, year: "202" });
    expect(flights[0]!.signal.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    cache.dispose();
  });
});
