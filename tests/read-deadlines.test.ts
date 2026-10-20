import { afterEach, it, expect, vi } from "vitest";
import { ReadCoordinator, READ_BUDGETS } from "../src/shared/read-deadlines";
afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve!: (v: string) => void, reject!: (e: Error) => void;
  const promise = new Promise<string>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
it("bounds unanswered reads, permits a fresh retry, and ignores late success/error", async () => {
  vi.useFakeTimers();
  const c = new ReadCoordinator(),
    a = deferred(),
    b = deferred(),
    cancel = vi.fn();
  let failure = "";
  void c
    .run("key", 30, () => a.promise, cancel)
    .catch((e) => (failure = e.message));
  await vi.advanceTimersByTimeAsync(30);
  expect(failure).toContain("Превышено время ожидания");
  expect(cancel).toHaveBeenCalledOnce();
  const retry = c.run("key", 30, () => b.promise, cancel);
  b.resolve("fresh");
  expect(await retry).toBe("fresh");
  a.resolve("stale");
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledTimes(1);
  const late = deferred();
  void c.run("error", 30, () => late.promise, cancel).catch(() => {});
  await vi.advanceTimersByTimeAsync(30);
  late.reject(Error("late"));
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
it("aborts one scope without blocking a new attempt and clears listeners/timers", async () => {
  vi.useFakeTimers();
  const c = new ReadCoordinator(),
    controller = new AbortController(),
    cancel = vi.fn();
  let failure = "";
  void c
    .run("key", 100, () => new Promise(() => {}), cancel, controller.signal)
    .catch((e) => (failure = e.message));
  controller.abort();
  await Promise.resolve();
  expect(failure).toContain("отменено");
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(await c.run("key", 100, async () => "new", cancel)).toBe("new");
});
it("never creates unbounded hanging reads: two per key and 64 overall", async () => {
  vi.useFakeTimers();
  const c = new ReadCoordinator(),
    send = vi.fn(() => new Promise<string>(() => {}));
  for (let i = 0; i < 2; i++) {
    void c.run("same", 1, send, () => {}).catch(() => {});
    await vi.advanceTimersByTimeAsync(1);
  }
  await expect(c.run("same", 1, send, () => {})).rejects.toThrow(
    /предыдущих чтений/,
  );
  expect(send).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 62; i++)
    void c.run("different" + i, 1, send, () => {}).catch(() => {});
  await expect(c.run("overflow", 1, send, () => {})).rejects.toThrow(
    /предыдущих чтений/,
  );
  expect(send).toHaveBeenCalledTimes(64);
});
it("sets budgets by real read type, not a short global loading timer", () => {
  expect(READ_BUDGETS.discover).toBe(300000);
  expect(READ_BUDGETS.preview).toBe(300000);
  expect(READ_BUDGETS.readBuildPlan).toBe(30000);
  expect(READ_BUDGETS.listSettings).toBe(30000);
  expect("launch" in READ_BUDGETS).toBe(false);
  expect("launchBuild" in READ_BUDGETS).toBe(false);
  expect("saveProjectDocument" in READ_BUDGETS).toBe(false);
});
it.each([undefined, null, 0, ""])(
  "never converts a falsy rejection %s into successful empty data",
  async (error) => {
    const coordinator = new ReadCoordinator();
    await expect(
      coordinator.run(
        "falsy",
        100,
        () => Promise.reject(error),
        () => {},
      ),
    ).rejects.toBe(error);
  },
);
