import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../test-summary.mjs", import.meta.url));
test("summary enumerates exact skipped tests and separates todo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "goga-summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "report.json");
  await writeFile(
    file,
    JSON.stringify({
      numPassedTests: 1,
      numFailedTests: 0,
      testResults: [
        {
          name: "tests/native.test.ts",
          assertionResults: [
            { fullName: "native test A", status: "pending" },
            { fullName: "future <test>", status: "todo" },
            { fullName: "passing", status: "passed" },
          ],
        },
      ],
    }),
  );
  const p = spawnSync(process.execPath, [script, file], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /native.test.ts: native test A \(pending\)/);
  assert.match(p.stdout, /future &lt;test&gt;/);
  assert.doesNotMatch(p.stdout, /passing/);
  assert.match(p.stdout, /skipped\/todo: 2/);
});
test("missing report fails rather than pretending all passed", () => {
  const p = spawnSync(process.execPath, [script, "/nonexistent/report.json"]);
  assert.notEqual(p.status, 0);
});

test("missing report writes an actionable incomplete summary without false totals", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "goga-summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "summary.md");
  const p = spawnSync(
    process.execPath,
    [script, path.join(dir, "missing.json")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        TEST_OUTCOME: "cancelled",
        TEST_SHARD: "2/4",
      },
    },
  );
  assert.notEqual(p.status, 0);
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(summary, "utf8");
  assert.match(text, /Test verification incomplete/);
  assert.match(text, /cancelled/);
  assert.match(text, /2\/4/);
  assert.match(text, /timeout|cancel/i);
  assert.doesNotMatch(text, /Passed:|No skipped tests|ENOENT/);
  assert.doesNotMatch(p.stderr, /node:internal|ENOENT/);
});

test("invalid report is incomplete, not a successful empty report", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "goga-summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const content of ["{", "{}"]) {
    const file = path.join(dir, "report.json");
    await writeFile(file, content);
    const p = spawnSync(process.execPath, [script, file], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    assert.notEqual(p.status, 0);
    assert.match(p.stdout, /Test verification incomplete/);
    assert.doesNotMatch(p.stdout, /Passed:|No skipped tests/);
  }
});

test("failed tests remain failures, and cancelled steps reject a stale report", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "goga-summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "report.json");
  await writeFile(
    file,
    JSON.stringify({
      numPassedTests: 1,
      numFailedTests: 1,
      success: false,
      testResults: [
        {
          name: "tests/failure.test.ts",
          assertionResults: [{ fullName: "failed", status: "failed" }],
        },
      ],
    }),
  );
  for (const outcome of ["failure", "cancelled", "skipped"]) {
    const p = spawnSync(process.execPath, [script, file], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", TEST_OUTCOME: outcome },
    });
    assert.notEqual(p.status, 0);
    if (outcome === "failure") assert.match(p.stdout, /failed: 1/);
    else {
      assert.match(p.stdout, /Test verification incomplete/);
      assert.doesNotMatch(p.stdout, /Passed:/);
    }
  }
});
