import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTerminalInspector,
  createIsolatedTerminalInspector,
} from "../src/host/terminal-inspector";
const roots: string[] = [];
const version = JSON.stringify({
  version: 1,
  platform: "darwin",
  arch: process.arch,
});
function fixture() {
  const dir = mkdtempSync("/private/tmp/goga-prepare-unit-");
  roots.push(dir);
  const file = join(dir, "helper");
  writeFileSync(file, "fixture", { mode: 0o700 });
  const execute = vi.fn(() => JSON.stringify({ ok: false }));
  return { file, execute };
}
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("shares one cold preparation and permits readiness after one second without synchronous execution", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const executeAsync = vi.fn(
    () =>
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(version), 1500),
      ),
  );
  const reader = createTerminalInspector(f.file, {
    execute: f.execute,
    executeAsync,
  });
  const a = reader.prepare!(),
    b = reader.prepare!();
  expect(executeAsync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1500);
  await Promise.all([a, b]);
  reader.check!();
  reader.birth(200, 250);
  reader.snapshot(200);
  expect(f.execute.mock.calls.map((c: any) => c[1][0])).toEqual([
    "birth",
    "snapshot",
  ]);
  expect((f.execute.mock.calls as any)[0][2].timeout).toBe(250);
  expect((f.execute.mock.calls as any)[1][2].timeout).toBe(1000);
  await reader.prepare!();
  expect(executeAsync).toHaveBeenCalledTimes(1);
});
it("settles hung readiness at five seconds without retries or marking ready", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const executeAsync = vi.fn(() => new Promise<string>(() => {}));
  const reader = createTerminalInspector(f.file, {
    execute: f.execute,
    executeAsync,
  });
  const failed = expect(reader.prepare!()).rejects.toThrow(/адаптер/);
  await vi.advanceTimersByTimeAsync(5000);
  await failed;
  expect(executeAsync).toHaveBeenCalledTimes(1);
  expect(f.execute).not.toHaveBeenCalled();
});
it("rejects identity replacement during asynchronous readiness", async () => {
  const f = fixture();
  let done!: (s: string) => void;
  const reader = createTerminalInspector(f.file, {
    execute: f.execute,
    executeAsync: () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  });
  const ready = reader.prepare!();
  writeFileSync(f.file, "replaced");
  done(version);
  await expect(ready).rejects.toThrow(/изменился/);
  expect(f.execute).not.toHaveBeenCalled();
});
it.each([
  "bad json",
  JSON.stringify({ version: 2, platform: "darwin", arch: process.arch }),
])(
  "rejects invalid readiness response %s without success cache",
  async (result) => {
    const f = fixture();
    const executeAsync = vi.fn(async () => result);
    const reader = createTerminalInspector(f.file, {
      execute: f.execute,
      executeAsync,
    });
    await expect(reader.prepare!()).rejects.toThrow(/адаптер/);
    expect(executeAsync).toHaveBeenCalledTimes(1);
  },
);
it("shares one total deadline between source and private copy, then cleans failed copy", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const paths: string[] = [];
  const budgets: number[] = [];
  const executeAsync = vi.fn((file: string, _args: string[], options: any) => {
    paths.push(file);
    budgets.push(options.timeout);
    return new Promise<string>((resolve) =>
      setTimeout(() => resolve(version), 3000),
    );
  });
  const reader = createIsolatedTerminalInspector(f.file, {
    execute: f.execute,
    executeAsync,
  });
  const failed = expect(reader.prepare!()).rejects.toThrow(/адаптер/);
  await vi.advanceTimersByTimeAsync(5000);
  await failed;
  expect(budgets).toEqual([5000, 2000]);
  expect(paths).toHaveLength(2);
  expect(() => readdirSync(join(paths[1], ".."))).toThrow();
  reader.dispose();
});
it("disposal during readiness cannot install a late private reader", async () => {
  const f = fixture();
  let done!: (s: string) => void;
  const executeAsync = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        done = resolve;
      }),
  );
  const reader = createIsolatedTerminalInspector(f.file, {
    execute: f.execute,
    executeAsync,
  });
  const pending = reader.prepare!();
  reader.dispose();
  done(version);
  await expect(pending).rejects.toThrow();
  expect(executeAsync).toHaveBeenCalledTimes(1);
  expect(() => reader.check!()).toThrow();
});
it("cleans the private copy if disposed while its shared preparation is pending", async () => {
  const f = fixture();
  let finishCopy!: (s: string) => void;
  let copyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    copyStarted = resolve;
  });
  let retained = "";
  const executeAsync = vi.fn((file: string) => {
    if (file === f.file) return Promise.resolve(version);
    retained = file;
    return new Promise<string>((resolve) => {
      finishCopy = resolve;
      copyStarted();
    });
  });
  const reader = createIsolatedTerminalInspector(f.file, {
    execute: f.execute,
    executeAsync,
  });
  const first = reader.prepare!();
  const second = reader.prepare!();
  const settled = Promise.allSettled([first, second]);
  await started;
  expect(readdirSync(join(retained, ".."))).toEqual(["terminal-inspect"]);
  reader.dispose();
  finishCopy(version);
  expect((await settled).map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(executeAsync).toHaveBeenCalledTimes(2);
  expect(f.execute).not.toHaveBeenCalled();
  expect(() => readdirSync(join(retained, ".."))).toThrow();
  expect(() => reader.check!()).toThrow();
});
