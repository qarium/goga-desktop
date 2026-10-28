import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
const load = async (name) =>
  parse(
    await readFile(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );
test("diagnostic comparison is manual, read-only, bounded and never substitutes release CI", async () => {
  const w = await load("ci-diagnostics");
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.deepEqual(w.permissions, { contents: "read" });
  const j = w.jobs.measure;
  assert.equal(j["runs-on"], "macos-15");
  assert.equal(j["timeout-minutes"], 10);
  assert.deepEqual(j.strategy.matrix.workers, [1, 2, 3]);
  assert.equal(j.strategy["max-parallel"], 1);
  assert.equal(j.strategy["fail-fast"], false);
  assert.equal(j.env.GOGA_TOPIC_READONLY_CLI, "/nonexistent/disabled");
  assert.equal(j.env.GOGA_TEST_PROFILE, "slow-git");
  assert.ok(j.steps.some((s) => s.run?.includes("--testNamePattern=")));
  const validate = j.steps.find(
    (s) => s.name === "Require exactly the four diagnostic scenarios",
  );
  assert.equal(validate.if, "always()");
  assert.match(validate.run, /numPassedTests !== 4/);
  assert.match(validate.run, /numFailedTests !== 0/);
  assert.match(validate.run, /process.exit\(1\)/);
  for (const s of j.steps) {
    assert.notEqual(s["continue-on-error"], true);
    if (s.uses?.startsWith("actions/checkout@"))
      assert.equal(s.with["persist-credentials"], false);
    if (s.run)
      assert.doesNotMatch(
        s.run,
        /--retry|passWithNoTests|git push|npm run package|gh release/,
      );
  }
  const ci = await load("ci"),
    release = await load("release");
  assert.ok(!JSON.stringify(ci).includes("ci-diagnostics"));
  assert.ok(!JSON.stringify(release).includes("ci-diagnostics"));
});
