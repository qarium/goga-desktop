import { test } from "node:test";
import assert from "node:assert/strict";
import { runSmokeCommand } from "../smoke-command.mjs";
test("smoke terminates its own process group even when SIGTERM is ignored", async () => {
  const start = performance.now();
  await assert.rejects(
    runSmokeCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},50)"],
      { timeout: 150 },
    ),
    /timed out/,
  );
  assert.ok(performance.now() - start < 2000);
});
test("smoke returns real output and fails on nonzero exit, spawn failure and oversized output", async () => {
  assert.deepEqual(
    await runSmokeCommand(
      process.execPath,
      ["-e", "process.stdout.write('ok');process.stderr.write('diagnostic')"],
      { timeout: 1000 },
    ),
    { stdout: "ok", stderr: "diagnostic" },
  );
  await assert.rejects(
    runSmokeCommand(process.execPath, ["-e", "process.exit(7)"], {
      timeout: 1000,
    }),
    /7/,
  );
  await assert.rejects(
    runSmokeCommand("/nonexistent-smoke-command", [], { timeout: 1000 }),
  );
  await assert.rejects(
    runSmokeCommand(
      process.execPath,
      ["-e", "process.stdout.write('a'.repeat(1000))"],
      { timeout: 1000, maxBuffer: 20 },
    ),
    /output/,
  );
});

test("a surviving child prevents success and is stopped with the owned smoke group", async () => {
  const script = `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},50);setTimeout(()=>process.exit(),2000)'],{stdio:'ignore'});process.exit(0);`;
  await assert.rejects(
    runSmokeCommand(process.execPath, ["-e", script], { timeout: 1000 }),
    /descendant/,
  );
});

test("unconfirmed settlement fails and releases child/pipe handles rather than hanging the verifier", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let unref = false;
  child.unref = () => {
    unref = true;
  };
  await assert.rejects(
    runSmokeCommand("synthetic", [], {
      timeout: 1,
      spawnProcess: () => child,
      signalGroup: () => {
        const e = Error("denied");
        e.code = "EPERM";
        throw e;
      },
    }),
    /settlement not confirmed/,
  );
  assert.ok(unref);
  assert.ok(child.stdout.destroyed);
  assert.ok(child.stderr.destroyed);
});
