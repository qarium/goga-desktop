import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { observeDashboard } from "./helpers/dashboard-process";

function fixture(dispose: () => Promise<void>) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  return {
    child,
    runner: { start: vi.fn(() => child), dispose: vi.fn(dispose) },
  };
}

it("does not finish a dashboard fixture until process cleanup settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(() => gate);
  let finished = false;
  const flight = observeDashboard("fixture", 1000, f.runner).then((result) => {
    finished = true;
    return result;
  });
  try {
    f.child.emit("close", 7);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.runner.dispose).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
  } finally {
    release();
    await flight;
  }
  expect(finished).toBe(true);
});

it("propagates a termination failure instead of leaking an unhandled rejection", async () => {
  const error = Error("controlled process group termination failure");
  const rejected = Promise.reject(error);
  // Observe the intentionally injected rejection even in the RED implementation.
  void rejected.catch(() => {});
  const f = fixture(() => rejected);
  const assertion = expect(
    observeDashboard("fixture", 1000, f.runner),
  ).rejects.toBe(error);
  f.child.emit("close", 7);
  await assertion;
});

it("cleans up the runner even when process creation fails", async () => {
  const error = Error("controlled spawn failure");
  const f = fixture(async () => {});
  f.runner.start.mockImplementation(() => {
    throw error;
  });
  await expect(observeDashboard("fixture", 1000, f.runner)).rejects.toBe(error);
  expect(f.runner.dispose).toHaveBeenCalledOnce();
});
