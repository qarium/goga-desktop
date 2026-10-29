import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
const fixture = async (t) => {
  const root = await mkdtemp("/private/tmp/goga-release-step-");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
test("release phase runner records duration and uses fixed bounded commands", async (t) => {
  const api = await import("../release-step.mjs").catch(() => ({}));
  assert.equal(typeof api.runReleaseStep, "function");
  const root = await fixture(t),
    calls = [];
  let time = 10;
  await api.runReleaseStep("package", {
    root,
    arch: "arm64",
    now: () => time,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      time = 30;
      return { stdout: "done", stderr: "" };
    },
    write: () => {},
  });
  assert.deepEqual(calls[0].args, ["run", "package:release", "--", "--arm64"]);
  assert.equal(calls[0].file, "npm");
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.timeout, 240000);
  const events = (
    await readFile(root + "/work/release-report/phases.jsonl", "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    events.map((e) => e.status),
    ["running", "success"],
  );
  assert.equal(events[1].durationMs, 20);
});
test("failed or interrupted commands remain failures and produce a bounded phase report", async (t) => {
  const { runReleaseStep } = await import("../release-step.mjs");
  const root = await fixture(t);
  await assert.rejects(
    runReleaseStep("build", {
      root,
      arch: "x64",
      run: async () => {
        throw Error("native compiler failed");
      },
      write: () => {},
    }),
    /native compiler failed/,
  );
  const events = (
    await readFile(root + "/work/release-report/phases.jsonl", "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.at(-1).status, "failed");
  assert.ok(events.at(-1).durationMs >= 0);
  assert.deepEqual(Object.keys(events.at(-1)).sort(), [
    "arch",
    "durationMs",
    "phase",
    "status",
  ]);
});
test("invalid phase and architecture never start a command", async (t) => {
  const { runReleaseStep } = await import("../release-step.mjs");
  const root = await fixture(t);
  let calls = 0;
  const run = async () => {
    calls++;
  };
  for (const [phase, arch] of [
    ["publish", "arm64"],
    ["build;bad", "x64"],
    ["install", "unknown"],
  ])
    await assert.rejects(
      runReleaseStep(phase, { root, arch, run, write: () => {} }),
    );
  assert.equal(calls, 0);
});
