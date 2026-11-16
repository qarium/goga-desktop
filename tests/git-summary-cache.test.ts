import { it, expect, vi } from "vitest";
import { GitSummaryCache } from "../src/renderer/git-summary-cache";
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const value = (scope: string, changedFiles: number) => ({
  scope,
  branch: "main",
  changedFiles,
  conflicts: 0,
});
it("bounds concurrent reads, dedupes owners and prioritises the active tab", async () => {
  const calls: string[] = [],
    done: ((v: unknown) => void)[] = [];
  const cache = new GitSummaryCache(
    (_, scope) =>
      new Promise((r) => {
        calls.push(String(scope));
        done.push(r);
      }),
  );
  for (const id of ["a", "b", "c", "d"]) cache.subscribe(id, () => {});
  for (const id of ["a", "a", "b", "c"]) cache.ensure(id, "visible");
  cache.ensure("d", "active-poll");
  await tick();
  expect(calls).toEqual(["a", "b"]);
  done.shift()!(value("a", 3));
  await tick();
  expect(calls).toEqual(["a", "b", "d"]);
  expect(cache.getSnapshot("a").lastGood?.changedFiles).toBe(3);
  cache.dispose();
});
it("retains last confirmed number on failure, never accepts stale generations or wrong owners", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(value("p", 4))
    .mockRejectedValueOnce(Error("ошибка"))
    .mockResolvedValueOnce(value("q", 1));
  const cache = new GitSummaryCache(read);
  cache.subscribe("p", () => {});
  cache.ensure("p", "visible");
  await tick();
  cache.ensure("p", "visible");
  expect(read).toHaveBeenCalledTimes(1);
  cache.ensure("p", "manual");
  await tick();
  expect(cache.getSnapshot("p")).toMatchObject({
    error: "ошибка",
    lastGood: { changedFiles: 4 },
  });
  cache.ensure("p", "manual");
  await tick();
  expect(cache.getSnapshot("p").lastGood?.changedFiles).toBe(4);
  expect(cache.getSnapshot("p").error).toBeTruthy();
  cache.dispose();
});
it("only aborts on last subscriber and a late cancelled result cannot replace a new read", async () => {
  let resolve!: (v: unknown) => void;
  let firstSignal!: AbortSignal;
  const read = vi
    .fn()
    .mockImplementationOnce((signal: AbortSignal) => {
      firstSignal = signal;
      return new Promise((r) => (resolve = r));
    })
    .mockResolvedValueOnce(value("p", 2));
  const cache = new GitSummaryCache(read);
  const off1 = cache.subscribe("p", () => {}),
    off2 = cache.subscribe("p", () => {});
  cache.ensure("p", "visible");
  await tick();
  off1();
  expect(firstSignal.aborted).toBe(false);
  off2();
  expect(firstSignal.aborted).toBe(true);
  cache.subscribe("p", () => {});
  cache.ensure("p", "visible");
  resolve(value("p", 100));
  await tick();
  expect(cache.getSnapshot("p").lastGood?.changedFiles).toBe(2);
  cache.dispose();
});
it("does not exceed the physical bound even if native cancellation is still outstanding", async () => {
  let finishA!: () => void;
  const calls: string[] = [];
  const cache = new GitSummaryCache((signal, scope) => {
    calls.push(String(scope));
    if (scope === "a")
      return {
        result: new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(Error("cancelled"))),
        ),
        settled: new Promise<void>((r) => {
          finishA = r;
        }),
      };
    return new Promise(() => {});
  });
  const off = cache.subscribe("a", () => {});
  cache.ensure("a", "visible");
  for (const p of ["b", "c"]) {
    cache.subscribe(p, () => {});
    cache.ensure(p, "visible");
  }
  off();
  await tick();
  expect(calls).toEqual(["a", "b"]);
  finishA();
  await tick();
  expect(calls).toEqual(["a", "b", "c"]);
  cache.dispose();
});
it("coalesces simultaneous invalidations and immediately drops the old branch number", async () => {
  const read = vi.fn(async () => value("p", 1));
  const cache = new GitSummaryCache(read);
  cache.subscribe("p", () => {});
  await cache.ensure("p", "visible");
  cache.invalidate("p", true);
  cache.invalidate("p");
  cache.invalidate("p");
  expect(cache.getSnapshot("p").lastGood).toBeUndefined();
  await tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(cache.getSnapshot("p").lastGood?.changedFiles).toBe(1);
  cache.dispose();
});
