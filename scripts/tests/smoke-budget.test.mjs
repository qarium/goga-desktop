import { test } from "node:test";
import assert from "node:assert/strict";
import { smokeBudget } from "../smoke-budget.mjs";
test("all smoke commands share one deadline rather than each gaining 90 seconds", async () => {
  let now = 0;
  const calls = [];
  const budget = smokeBudget(160000, {
    now: () => now,
    run: async (f, a, o) => {
      calls.push(o.timeout);
      return { stdout: "ok" };
    },
  });
  await budget.run("first", []);
  now = 100000;
  await budget.run("second", []);
  now = 159999;
  await budget.run("third", []);
  assert.deepEqual(calls, [90000, 60000, 1]);
  now = 160000;
  await assert.rejects(budget.run("late", []), /deadline/i);
  assert.equal(calls.length, 3);
});
test("command options cannot override remaining budget and failures are preserved", async () => {
  let timeout;
  const budget = smokeBudget(100, {
    now: () => 0,
    run: async (f, a, o) => {
      timeout = o.timeout;
      throw Error("native failed");
    },
  });
  await assert.rejects(
    budget.run("x", [], { timeout: 999999 }),
    /native failed/,
  );
  assert.equal(timeout, 100);
});
test("cleanup has its own finite total budget after verification has expired", async () => {
  let now = 0;
  const run = async () => ({});
  const work = smokeBudget(160000, { now: () => now, run });
  now = 160001;
  assert.throws(() => work.check(), /deadline/i);
  const cleanup = smokeBudget(20000, { now: () => now, run });
  await cleanup.run("detach", []);
  now += 20000;
  await assert.rejects(cleanup.run("detach-force", []), /deadline/i);
});
test("invalid budgets fail rather than disable timeout", () => {
  for (const value of [0, -1, Infinity, NaN])
    assert.throws(() => smokeBudget(value));
});
