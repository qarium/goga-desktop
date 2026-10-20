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
