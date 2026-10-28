import { afterEach, expect, it, vi } from "vitest";
import { ByteCommandError, NodeRunner } from "../src/host/process";
import { withReadScope } from "../src/host/read-scope";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
const runners: NodeRunner[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runner of runners.splice(0)) await runner.dispose();
});
function runner(timeout = 3000) {
  const r = new NodeRunner(timeout);
  runners.push(r);
  expect(r.commandBytes, "byte-safe native process capability").toBeTypeOf(
    "function",
  );
  return r;
}
function run(
  r: NodeRunner,
  code: string,
  stdin?: Buffer,
  maxOutputBytes?: number,
) {
  return r.commandBytes({
    executable: process.execPath,
    args: ["-e", code],
    cwd: process.cwd(),
    stdin,
    maxOutputBytes,
  });
}
it("preserves arbitrary bytes including NUL and invalid UTF-8 without a shell", async () => {
  const input = Buffer.from([0, 255, 195, 169, 10, 13]);
  const result = await run(
    runner(),
    "process.stdin.pipe(process.stdout)",
    input,
  );
  expect(result).toMatchObject({
    exitCode: 0,
    signal: null,
    processSettled: true,
  });
  expect(result.stdout).toEqual(input);
  expect(result.stderr).toEqual(Buffer.alloc(0));
});
it("preserves nonzero exit without stderr and actual signal rather than inventing success", async () => {
  const r = runner();
  expect(await run(r, "process.exit(7)")).toMatchObject({
    exitCode: 7,
    signal: null,
    processSettled: true,
  });
  expect(await run(r, "process.kill(process.pid, 'SIGTERM')")).toMatchObject({
    exitCode: null,
    signal: "SIGTERM",
    processSettled: true,
  });
});
it.each(["stdout", "stderr"])(
  "bounds %s in bytes and drains before rejection",
  async (stream) => {
    await expect(
      run(
        runner(),
        `process.${stream}.write(Buffer.alloc(4096)); setInterval(()=>{},100)`,
        undefined,
        1024,
      ),
    ).rejects.toMatchObject({ reason: "output-limit", processSettled: true });
  },
);
it("reports a spawn failure with no process and no leaked diagnostics", async () => {
  await expect(
    runner().commandBytes({
      executable: "/nonexistent/git-fixture",
      args: [],
      cwd: process.cwd(),
    }),
  ).rejects.toMatchObject({ reason: "spawn", processSettled: true });
});
it("sanitizes a synchronous spawn rejection before any process exists", async () => {
  const r = runner();
  vi.spyOn(r, "start").mockImplementationOnce(() => {
    throw Error("SECRET fixture spawn error");
  });
  await expect(run(r, "not executed")).rejects.toMatchObject({
    reason: "spawn",
    processSettled: true,
  });
});
it("waits for process termination on deadline instead of leaving a live command", async () => {
  await expect(
    run(runner(200), "setInterval(()=>{},100)"),
  ).rejects.toMatchObject({ reason: "timeout", processSettled: true });
});
it("does not admit a command after shutdown", async () => {
  const r = runner();
  await r.dispose();
  await expect(run(r, "process.exit(0)")).rejects.toMatchObject({
    code: "RUNNER_SHUTDOWN",
  });
});
it("shutdown interrupts an admitted native command and drains it", async () => {
  const r = runner();
  const pending = run(r, "setInterval(()=>{},100)");
  const assertion = expect(pending).rejects.toMatchObject({
    reason: "shutdown",
    processSettled: true,
  });
  await r.dispose();
  await assertion;
});
it("read cancellation stays scoped and never cancels another native command", async () => {
  const r = runner(),
    controller = new AbortController();
  const pending = withReadScope(controller.signal, () =>
    run(r, "setInterval(()=>{},100)"),
  );
  const assertion = expect(pending).rejects.toMatchObject({
    reason: "aborted",
    processSettled: true,
  });
  const other = run(r, "process.stdout.write('other')");
  controller.abort();
  await assertion;
  expect((await other).stdout.toString()).toBe("other");
});
it("does not report success while a child in the managed process group survives", async () => {
  const r = runner();
  await expect(
    run(
      r,
      `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},2000)'], {stdio:'ignore'}).unref(); setTimeout(()=>process.exit(0),50);`,
    ),
  ).rejects.toMatchObject({ reason: "descendants", processSettled: true });
});
it("reports unconfirmed termination honestly instead of releasing as settled", async () => {
  const r = runner(10);
  vi.spyOn(r, "kill").mockRejectedValueOnce(Error("fixture cannot prove stop"));
  await expect(run(r, "setTimeout(()=>{},100)")).rejects.toMatchObject({
    reason: "process-unsettled",
    processSettled: false,
  });
});
it("ignores late output and duplicate close callbacks after a settled result", async () => {
  const r = runner();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
  }) as unknown as ChildProcessWithoutNullStreams;
  vi.spyOn(r, "start").mockReturnValueOnce(child);
  const pending = run(r, "not executed");
  child.stdout.emit("data", Buffer.from("before"));
  child.emit("close", 0, null);
  const result = await pending;
  child.stdout.emit("data", Buffer.from("late"));
  child.emit("close", 1, null);
  child.emit("error", Error("late"));
  expect(result.stdout.toString()).toBe("before");
  expect(result.exitCode).toBe(0);
});

function preparedCommand(
  r: NodeRunner,
  verifyPrepared: (active: () => void) => Promise<void>,
  reply = "start: ok\nprepare: ok\n",
) {
  return r.commandBytes({
    executable: process.execPath,
    args: [
      "-e",
      `process.stdin.once('data', () => { process.stdout.write(${JSON.stringify(reply)}); process.stdin.once('data', b => { process.stdout.write(b.toString().trim()+': ok\\n'); process.stdin.resume(); }); });`,
      "--",
      "update-ref",
      "--stdin",
    ],
    cwd: process.cwd(),
    stdin: Buffer.from(`start\nverify HEAD ${"a".repeat(40)}\nprepare\n`),
    verifyPrepared,
  });
}
it("commits a prepared native transaction only after verification", async () => {
  const verify = vi.fn(async (active: () => void) => {
    active();
  });
  const result = await preparedCommand(runner(), verify);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ exitCode: 0, processSettled: true });
  expect(result.stdout.toString()).toBe("start: ok\nprepare: ok\ncommit: ok\n");
});
it("aborts a prepared transaction when verification rejects", async () => {
  await expect(
    preparedCommand(runner(), async () => {
      throw Error("stale");
    }),
  ).rejects.toMatchObject({
    reason: "verification",
    processSettled: true,
    stdout: Buffer.from("start: ok\nprepare: ok\nabort: ok\n"),
  });
});
it("does not call verification after malformed native preparation", async () => {
  const verify = vi.fn(async () => {});
  await expect(
    preparedCommand(runner(), verify, "wrong\n"),
  ).rejects.toMatchObject({ reason: "protocol", processSettled: true });
  expect(verify).not.toHaveBeenCalled();
});
it("does not commit after a verification outlives its transaction deadline", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active: (() => void) | undefined;
  const pending = preparedCommand(runner(300), async (check) => {
    active = check;
    await gate;
  });
  await expect(pending).rejects.toMatchObject({
    reason: "timeout",
    processSettled: true,
  });
  expect(active).toBeTypeOf("function");
  expect(() => active!()).toThrow();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
});
it("rejects arbitrary stdin commands for a prepared transaction", async () => {
  await expect(
    runner().commandBytes({
      executable: process.execPath,
      args: ["update-ref", "--stdin"],
      cwd: process.cwd(),
      stdin: Buffer.from("start\ndelete HEAD\nprepare\n"),
      verifyPrepared: async () => {},
    }),
  ).rejects.toThrow("транзакция");
});

it("drains nested commands before releasing a timed out prepared transaction", async () => {
  const outer = runner(500),
    inner = runner(3000);
  let nestedSettled = false;
  let nested: Promise<unknown> | undefined;
  const killedAfterNested: boolean[] = [];
  const kill = outer.kill.bind(outer);
  vi.spyOn(outer, "kill").mockImplementation(async (child) => {
    killedAfterNested.push(nestedSettled);
    await kill(child);
  });
  try {
    await expect(
      preparedCommand(outer, async () => {
        nested = run(
          inner,
          "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),180)); setInterval(()=>{},100)",
        ).finally(() => {
          nestedSettled = true;
        });
        await nested;
      }),
    ).rejects.toMatchObject({ reason: "timeout", processSettled: true });
    expect(nestedSettled).toBe(true);
    expect(killedAfterNested).toEqual([true]);
  } finally {
    await nested?.catch(() => {});
  }
});
it("preserves unknown nested process settlement when verification rejects", async () => {
  await expect(
    preparedCommand(runner(), async () => {
      throw new ByteCommandError(
        "process-unsettled",
        false,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    }),
  ).rejects.toMatchObject({ processSettled: false });
});
it("prevents delayed verification from starting commands after its deadline", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = runner();
  const start = vi.spyOn(inner, "start");
  let late!: Promise<unknown>;
  await expect(
    preparedCommand(runner(300), async () => {
      await gate;
      late = run(inner, "process.stdout.write('late')").catch((e) => e);
      await late;
    }),
  ).rejects.toMatchObject({ reason: "timeout" });
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await late;
  expect(start).not.toHaveBeenCalled();
});

it.each([false, true])(
  "drains nested commands before shutdown releases the prepared lock (same runner %s)",
  async (same) => {
    const outer = runner(5000),
      inner = same ? outer : runner(5000);
    let nestedSettled = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const start = outer.start.bind(outer);
    let parent: ChildProcessWithoutNullStreams;
    vi.spyOn(outer, "start").mockImplementation((...args) => {
      const child = start(...args);
      if (args[1].includes("update-ref")) parent = child;
      return child;
    });
    const kill = outer.kill.bind(outer),
      order: boolean[] = [];
    vi.spyOn(outer, "kill").mockImplementation(async (child) => {
      if (child === parent) order.push(nestedSettled);
      await kill(child);
    });
    const pending = preparedCommand(outer, async () => {
      const nested = run(
        inner,
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),180)); setInterval(()=>{},100)",
      ).finally(() => {
        nestedSettled = true;
      });
      started();
      await nested;
    });
    const observed = pending.catch((e) => e);
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await outer.dispose();
    expect(await observed).toMatchObject({
      reason: "shutdown",
      processSettled: true,
    });
    expect(order).toEqual([true]);
  },
);
