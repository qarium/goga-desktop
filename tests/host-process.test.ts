import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  NodeRunner,
  RunnerShutdownError,
  watchDashboard,
} from "../src/host/process";

it("supports externally owned dashboard deadlines without changing the standalone default", () => {
  vi.useFakeTimers();
  const fixture = () =>
    Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams;
  const standalone = fixture(),
    external = fixture();
  const standaloneFailure = vi.fn(),
    externalFailure = vi.fn();
  const stopStandalone = watchDashboard(standalone, {
    onReady: vi.fn(),
    onFinish: vi.fn(),
    onFailure: standaloneFailure,
  });
  const stopExternal = watchDashboard(external, {
    timeoutMs: null,
    onReady: vi.fn(),
    onFinish: vi.fn(),
    onFailure: externalFailure,
  });
  try {
    vi.advanceTimersByTime(119999);
    expect(standaloneFailure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10001);
    expect(standaloneFailure).toHaveBeenCalledTimes(1);
    expect(externalFailure).not.toHaveBeenCalled();
    external.emit("error", new Error("private details"));
    expect(externalFailure).toHaveBeenCalledTimes(1);
    expect(externalFailure.mock.calls[0][0].message).not.toContain(
      "private details",
    );
  } finally {
    stopStandalone();
    stopExternal();
    vi.useRealTimers();
  }
});

it("observes an early close when the dashboard deadline is externally owned", () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const failure = vi.fn();
  const stop = watchDashboard(child, {
    timeoutMs: null,
    onReady: vi.fn(),
    onFinish: vi.fn(),
    onFailure: failure,
  });
  try {
    child.emit("close", 5);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][0].message).toContain("код 5");
  } finally {
    stop();
  }
});
it("captures argv without shell interpretation and rejects failed commands without leaking output", async () => {
  const r = new NodeRunner();
  expect(
    (
      await r.command(
        process.execPath,
        [
          "-e",
          "process.stdout.write(process.argv[1])",
          "$(touch /tmp/not-created)",
        ],
        process.cwd(),
      )
    ).stdout,
  ).toBe("$(touch /tmp/not-created)");
  await expect(
    r.command(
      process.execPath,
      ["-e", 'console.error("SECRET=oops");process.exit(1)'],
      process.cwd(),
    ),
  ).rejects.not.toThrow("SECRET");
});
it("accepts actual status-shaped HTTP readiness only then publishes URL", async () => {
  const runner = new NodeRunner();
  const child = runner.start(
    process.execPath,
    [
      "-e",
      `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({flow_name:'fixture',stages:[]}))}).listen(0,'127.0.0.1',function(){console.log('  dashboard: http://127.0.0.1:'+this.address().port)})`,
    ],
    process.cwd(),
  );
  const ready = new Promise<string>((resolve, reject) => {
    watchDashboard(child, {
      timeoutMs: 3000,
      onReady: resolve,
      onFinish: () => reject(new Error("early exit")),
      onFailure: reject,
    });
  });
  expect(await ready).toMatch(/^http:\/\/127.0.0.1:/);
  runner.kill(child);
});
it("rejects exit before ready and timeout, does not publish generic localhost URL", async () => {
  const runner = new NodeRunner();
  for (const script of [
    'console.log("server http://localhost:1234")',
    "setInterval(()=>{},1000)",
  ]) {
    const c = runner.start(process.execPath, ["-e", script], process.cwd());
    const result = await new Promise<string>((resolve) =>
      watchDashboard(c, {
        timeoutMs: 100,
        onReady: () => resolve("bad"),
        onFailure: (e) => resolve(e.message),
        onFinish: () => resolve("bad"),
      }),
    );
    expect(result).not.toBe("bad");
    runner.kill(c);
  }
});
it("never follows a redirect or treats a generic JSON service as AFM", async () => {
  const runner = new NodeRunner();
  for (const response of [
    `s.writeHead(302,{location:'http://localhost:1/api/status'});s.end()`,
    `s.end(JSON.stringify({ok:true}))`,
  ]) {
    const child = runner.start(
      process.execPath,
      [
        "-e",
        `require('http').createServer((q,s)=>{${response}}).listen(0,'127.0.0.1',function(){console.log('dashboard: http://127.0.0.1:'+this.address().port)})`,
      ],
      process.cwd(),
    );
    const result = await new Promise<string>((resolve) =>
      watchDashboard(child, {
        timeoutMs: 250,
        onReady: () => resolve("bad"),
        onFinish: () => resolve("bad"),
        onFailure: (e) => resolve(e.message),
      }),
    );
    expect(result).not.toBe("bad");
    await runner.kill(child);
  }
});
it("disposes long-running metadata processes and propagates explicit home", async () => {
  const runner = new NodeRunner(5000, { HOME: "/private/tmp/fixture-home" });
  expect(
    (
      await runner.command(
        process.execPath,
        ["-e", "process.stdout.write(process.env.HOME)"],
        process.cwd(),
      )
    ).stdout,
  ).toBe("/private/tmp/fixture-home");
  const pending = runner.command(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.cwd(),
  );
  const assertion = expect(pending).rejects.toThrow();
  await runner.dispose();
  await assertion;
  expect(() => runner.start("no", [], process.cwd())).toThrow(/завершает/);
});
it("kills descendants even after launcher has already exited", async () => {
  const runner = new NodeRunner();
  const child = runner.start(
    process.execPath,
    [
      "-e",
      `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setTimeout(()=>process.exit(0),100)`,
    ],
    process.cwd(),
  );
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(child.exitCode).toBe(0);
  try {
    await runner.kill(child);
    expect(() => process.kill(-child.pid!, 0)).toThrow();
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
});
it("identifies unsupported profile CLI without exposing arbitrary stderr", async () => {
  const runner = new NodeRunner();
  await expect(
    runner.command(
      process.execPath,
      [
        "-e",
        `console.error('Error: No such option: --profile\\nSECRET=private');process.exit(2)`,
      ],
      process.cwd(),
    ),
  ).rejects.toThrow(/версия Goga.*--profile/);
});
it("merges per-call env without mutating parent or leaking across calls", async () => {
  const r = new NodeRunner(5000, { BASE_FIXTURE: "base" });
  const original = process.env.DESKTOP_CANARY;
  const script =
    "process.stdout.write(JSON.stringify([process.env.DESKTOP_CANARY,process.env.BASE_FIXTURE]))";
  const a = await r.command(process.execPath, ["-e", script], process.cwd(), {
    DESKTOP_CANARY: "not-secret=a b",
  });
  const b = await r.command(process.execPath, ["-e", script], process.cwd(), {
    DESKTOP_CANARY: "",
  });
  expect(JSON.parse(a.stdout)).toEqual(["not-secret=a b", "base"]);
  expect(JSON.parse(b.stdout)).toEqual(["", "base"]);
  expect(process.env.DESKTOP_CANARY).toBe(original);
});
it("delivers optional command stdin as complete UTF-8 without changing default EOF", async () => {
  const r = new NodeRunner();
  const text = "Задача 🙂\n".repeat(20000);
  try {
    expect(
      (
        await r.command(
          process.execPath,
          ["-e", "process.stdin.pipe(process.stdout)"],
          process.cwd(),
          {},
          text,
        )
      ).stdout,
    ).toBe(text);
    expect(
      (
        await r.command(
          process.execPath,
          ["-e", "process.stdin.pipe(process.stdout)"],
          process.cwd(),
        )
      ).stdout,
    ).toBe("");
  } finally {
    await r.dispose();
  }
});

const shutdownCleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of shutdownCleanup.splice(0).reverse()) await cleanup();
});
async function shutdownProcessFixture(timeout = 5000) {
  const root = await mkdtemp("/private/tmp/goga-runner-shutdown48-");
  const runner = new NodeRunner(timeout);
  shutdownCleanup.push(() => rm(root, { recursive: true, force: true }));
  shutdownCleanup.push(() => runner.dispose());
  return { root, runner };
}
it("classifies start and command admission after dispose as typed shutdown", async () => {
  const { root, runner } = await shutdownProcessFixture();
  await runner.dispose();
  const error = await runner
    .command(process.execPath, ["-e", "process.exit(0)"], root)
    .catch((error) => error);
  expect(error).toMatchObject({
    name: "RunnerShutdownError",
    code: "RUNNER_SHUTDOWN",
    phase: "closing",
  });
  expect(error).toBeInstanceOf(RunnerShutdownError);
  let startError: unknown;
  try {
    runner.start(process.execPath, ["-e", "process.exit(0)"], root);
  } catch (error) {
    startError = error;
  }
  expect(startError).toBeInstanceOf(RunnerShutdownError);
  expect(startError).toMatchObject({
    name: "RunnerShutdownError",
    code: "RUNNER_SHUTDOWN",
    phase: "closing",
  });
});
it.each([false, true])(
  "classifies a pending command interrupted by dispose even when SIGTERM exits zero=%s",
  async (exitZero) => {
    const { root, runner } = await shutdownProcessFixture();
    const start = vi.spyOn(runner, "start");
    const pending = runner.command(
      process.execPath,
      [
        "-e",
        `${exitZero ? "process.on('SIGTERM',()=>{process.stdout.write('partial');process.exit(0)});" : ""}process.stdout.write('holding');setInterval(()=>{},1000)`,
      ],
      root,
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const child = start.mock.results[0].value;
    await new Promise<void>((resolve) =>
      child.stdout.once("data", () => resolve()),
    );
    await runner.dispose();
    const result = await outcome;
    expect(result).toMatchObject({
      error: {
        name: "RunnerShutdownError",
        code: "RUNNER_SHUTDOWN",
        phase: "interrupted",
      },
    });
    if (exitZero) expect(child.exitCode).toBe(0);
    expect(() => process.kill(-child.pid!, 0)).toThrow();
  },
);
it("keeps completed command results and genuine timeout failures distinct from shutdown", async () => {
  const { root, runner } = await shutdownProcessFixture(150);
  const completed = await runner.command(
    process.execPath,
    ["-e", "process.stdout.write('complete')"],
    root,
  );
  const timeout = await runner
    .command(process.execPath, ["-e", "setInterval(()=>{},1000)"], root)
    .catch((error) => error);
  expect(timeout.message).toContain("не ответила вовремя");
  expect(timeout.code).not.toBe("RUNNER_SHUTDOWN");
  await runner.dispose();
  expect(completed).toEqual({ stdout: "complete", stderr: "" });
});
it.each([0, 7])(
  "distinguishes a pending open command from an observed genuine launcher failure, exit=%s",
  async (exitCode) => {
    const { root, runner } = await shutdownProcessFixture();
    const start = vi.spyOn(runner, "start");
    const pending = runner.command(
      process.execPath,
      [
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setTimeout(()=>process.exit(${exitCode}),80)`,
      ],
      root,
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const child = start.mock.results[0].value;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode).toBe(exitCode);
    await runner.dispose();
    const result = await outcome;
    if (exitCode === 0)
      expect(result).toMatchObject({
        error: { code: "RUNNER_SHUTDOWN", phase: "interrupted" },
      });
    else {
      expect(result).toHaveProperty("error");
      expect((result as any).error).not.toBeInstanceOf(RunnerShutdownError);
      expect((result as any).error.message).toContain("кодом 7");
    }
    expect(() => process.kill(-child.pid!, 0)).toThrow();
  },
);
