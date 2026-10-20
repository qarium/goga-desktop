import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  awaitCommandClose,
  FixtureScope,
  PauseGate,
  gitIntegrationBudget,
  hasRunSyncCall,
} from "./helpers/git-integration";
import type { TopicContextRef } from "../src/shared/worktrees";

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("cleans up a failed assertion before the next fixture restores its spies", async () => {
  const scope = new FixtureScope();
  const trace: string[] = [];
  scope.cleanup(() => {
    trace.push("remove owned root");
  });
  scope.cleanup(() => {
    trace.push("dispose service");
  });
  try {
    throw Error("synthetic failed assertion");
  } catch {
    await scope.close();
  }
  trace.push("restore spies");
  expect(trace).toEqual([
    "dispose service",
    "remove owned root",
    "restore spies",
  ]);
  await scope.close();
  expect(trace).toHaveLength(3);
});

it("releases every paused kill, including one entering after release", async () => {
  const gate = new PauseGate();
  gate.pause();
  const finished: number[] = [];
  const first = gate.wait().then(() => finished.push(1));
  const second = gate.wait().then(() => finished.push(2));
  gate.release();
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toEqual([1, 2]);
  await Promise.all([first, second]);
  const late = gate.wait().then(() => finished.push(3));
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toEqual([1, 2, 3]);
  await late;
});

it("drains delayed operations after unblocking gates and before disposal or mock restoration", async () => {
  const scope = new FixtureScope();
  const gate = new PauseGate();
  gate.pause();
  const trace: string[] = [];
  scope.releaseOnCleanup(() => gate.release());
  scope.cleanup(() => {
    trace.push("disposed");
  });
  const pending = scope.track(
    (async () => {
      await gate.wait();
      await new Promise<void>((resolve) => setImmediate(resolve));
      trace.push("late afterRun");
    })(),
  );
  await scope.close();
  expect(trace).toEqual(["late afterRun", "disposed"]);
  await pending;
});

it("does not let a timed-out fixture start new service work during cleanup", async () => {
  const scope = new FixtureScope();
  const method = vi.fn(async () => 1);
  const service = scope.own({ method });
  expect(await service.method()).toBe(1);
  await scope.close();
  await expect(async () => service.method()).rejects.toThrow(/closed/i);
  expect(method).toHaveBeenCalledTimes(1);
});

it("continues remaining cleanup when disposal fails and reports the error", async () => {
  const scope = new FixtureScope();
  const removed = vi.fn();
  scope.cleanup(removed);
  scope.cleanup(() => {
    throw Error("dispose failure");
  });
  await expect(scope.close()).rejects.toThrow(/cleanup/i);
  expect(removed).toHaveBeenCalledOnce();
});

it("matches synchronization by project, exact context including revision, and run", () => {
  const ref: TopicContextRef = {
    projectId: "p",
    contextId: "a",
    year: "2026",
    topic: "same",
    branch: "main",
    revision: "r1",
  };
  const current = [{ path: "/fixture/current" }, ref, "run-2"];
  for (const foreign of [
    [{ path: "/fixture/old" }, ref, "run-2"],
    [{ path: "/fixture/current" }, { ...ref, contextId: "b" }, "run-2"],
    [{ path: "/fixture/current" }, { ...ref, revision: "r0" }, "run-2"],
    [{ path: "/fixture/current" }, ref, "run-1"],
  ])
    expect(hasRunSyncCall([foreign], "/fixture/current", ref, "run-2")).toBe(
      false,
    );
  expect(hasRunSyncCall([current], "/fixture/current", ref, "run-2")).toBe(
    true,
  );
});

it("keeps default finite budgets and scales only the explicit slow-git profile", () => {
  expect(gitIntegrationBudget(30000, "default")).toBe(30000);
  expect(gitIntegrationBudget(30000, "slow-git")).toBe(90000);
  expect(() => gitIntegrationBudget(30000, "slwo-git")).toThrow(/profile/i);
});

it("lets an already-started service operation finish its nested Git command during teardown", async () => {
  const scope = new FixtureScope();
  const gate = new PauseGate();
  gate.pause();
  scope.releaseOnCleanup(() => gate.release());
  const native = scope.own({ command: async () => "git completed" });
  const service = scope.own({
    operation: async () => {
      await gate.wait();
      return native.command();
    },
  });
  const pending = service.operation();
  await scope.close();
  expect(await pending).toBe("git completed");
});

it("allows owned service disposal to call the tracked native runner before removing its root", async () => {
  const scope = new FixtureScope();
  const trace: string[] = [];
  const native = scope.own({
    command: async () => {
      trace.push("cleanup git");
    },
  });
  scope.cleanup(() => {
    trace.push("remove root");
  });
  scope.cleanup(async () => {
    await native.command();
    trace.push("disposed");
  });
  await scope.close();
  expect(trace).toEqual(["cleanup git", "disposed", "remove root"]);
});

it("bounds an uncooperative pending operation without deleting its still-owned root", async () => {
  const scope = new FixtureScope();
  const remove = vi.fn();
  scope.cleanup(remove);
  scope.track(new Promise<void>(() => {}));
  const result = await Promise.race([
    scope.close(5).then(
      () => "success",
      (error) => error.message,
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("still pending"), 100),
    ),
  ]);
  expect(result).toMatch(/did not settle/i);
  expect(remove).not.toHaveBeenCalled();
});

it("cancels an owned delayed command on deadline and settles before cleanup", async () => {
  const scope = new FixtureScope();
  const trace: string[] = [];
  const pending = scope.track(
    new Promise<void>((_, reject) => {
      scope.signal.addEventListener("abort", () => {
        trace.push("aborted");
        reject(Error("cancelled"));
      });
    }),
  );
  scope.cancelOnTimeout(() => {
    trace.push("native disposed");
  });
  scope.cleanup(() => {
    trace.push("remove root");
  });
  await expect(scope.close(5)).rejects.toThrow(/did not settle/);
  await expect(pending).rejects.toThrow("cancelled");
  expect(scope.settled).toBe(true);
  expect(trace[0]).toBe("aborted");
  expect(trace).toContain("native disposed");
  expect(trace).toContain("remove root");
});

it("rejects a deferred callback inheriting a settled scope's async context", async () => {
  const scope = new FixtureScope();
  const trigger = deferredValue<void>();
  const command = vi.fn(async () => "late command");
  const native = scope.own({ command });
  let deferred!: Promise<unknown>;
  scope
    .own({
      schedule() {
        deferred = trigger.promise.then(() => native.command());
      },
    })
    .schedule();
  await scope.close();
  trigger.resolve();
  await expect(deferred).rejects.toThrow(/closed/i);
  expect(command).not.toHaveBeenCalled();
});

it("rejects tracking from a deferred callback inheriting a settled scope", async () => {
  const scope = new FixtureScope();
  const trigger = deferredValue<void>();
  let deferred!: Promise<unknown>;
  scope
    .own({
      schedule() {
        deferred = trigger.promise.then(() => scope.track(Promise.resolve(1)));
      },
    })
    .schedule();
  await scope.close();
  trigger.resolve();
  await expect(deferred).rejects.toThrow(/closed/i);
});

it("retains fixture ownership until delayed timeout cancellation has actually settled", async () => {
  vi.useFakeTimers();
  const scope = new FixtureScope();
  const cancelled = deferredValue<void>();
  const removeRoot = vi.fn();
  const restoreMocks = vi.fn();
  try {
    scope.track(
      new Promise<void>((_, reject) => {
        scope.signal.addEventListener("abort", () =>
          reject(Error("command aborted")),
        );
      }),
    );
    scope.cancelOnTimeout(() => cancelled.promise);
    scope.cleanup(removeRoot);
    const closed = scope.close(5).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect((await closed).message).toMatch(/did not settle/i);
    if (scope.settled) restoreMocks();
    expect(scope.settled).toBe(false);
    expect(removeRoot).not.toHaveBeenCalled();
    expect(restoreMocks).not.toHaveBeenCalled();
    cancelled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(scope.settled).toBe(true);
    expect(removeRoot).toHaveBeenCalledOnce();
  } finally {
    cancelled.resolve();
    vi.useRealTimers();
  }
});

it("keeps an aborted exec command pending until its child emits close", async () => {
  const child = new EventEmitter();
  const completion = deferredValue<{
    stdout: string;
    stderr: string;
  }>();
  const command = Object.assign(completion.promise, { child });
  const error = Object.assign(Error("aborted before close"), {
    name: "AbortError",
  });
  let settled = false;
  const pending = awaitCommandClose(command).then(
    () => {
      settled = true;
      return undefined;
    },
    (reason) => {
      settled = true;
      return reason;
    },
  );
  completion.reject(error);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  child.emit("close", null, "SIGTERM");
  expect(await pending).toBe(error);
});
