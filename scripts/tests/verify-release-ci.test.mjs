import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseCI } from "../verify-release-ci.mjs";
const repository = "qarium/goga-desktop",
  sha = "a".repeat(40),
  token = "synthetic-token";
const run = (overrides = {}) => ({
  id: 21,
  run_attempt: 1,
  workflow_id: 7,
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: sha,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
  ...overrides,
});
function fixture({
  runs = [run()],
  detail = runs[0],
  latest = runs,
  status = 200,
  error,
} = {}) {
  const calls = [];
  let listings = 0;
  const transport = async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.ok(options.signal);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (error) throw error;
    const body = url.includes("/workflows/")
      ? {
          total_count: (listings++ ? latest : runs).length,
          workflow_runs: listings === 1 ? runs : latest,
        }
      : detail;
    return { ok: status === 200, status, json: async () => body };
  };
  return { calls, options: { repository, sha, token, transport } };
}
test("accepts only the exact successful main CI commit via read-only bounded requests", async () => {
  const f = fixture();
  const result = await verifyReleaseCI(f.options);
  assert.deepEqual(result, { runId: 21, attempt: 1, sha });
  assert.ok(f.calls[0].includes(`head_sha=${sha}`));
  assert.ok(f.calls[0].includes("event=push"));
  assert.ok(f.calls[0].includes("branch=main"));
});
for (const patch of [
  { head_sha: "b".repeat(40) },
  { event: "pull_request" },
  { head_branch: "feature" },
  { path: ".github/workflows/release.yml" },
  { repository: { full_name: "other/repo" } },
  { head_repository: { full_name: "fork/repo" } },
  { status: "in_progress", conclusion: null },
  { conclusion: "failure" },
  { conclusion: "cancelled" },
  { conclusion: "skipped" },
  { conclusion: "neutral" },
  { id: "21" },
  { run_attempt: 0 },
])
  test(`rejects nonqualifying CI ${JSON.stringify(patch)}`, async () => {
    await assert.rejects(
      verifyReleaseCI(fixture({ runs: [run(patch)] }).options),
    );
  });
test("does not use an old success when a newer run is pending", async () => {
  await assert.rejects(
    verifyReleaseCI(
      fixture({
        runs: [run(), run({ id: 22, status: "queued", conclusion: null })],
      }).options,
    ),
    /not successful|не завершён/,
  );
});
test("missing CI is not permission to run or publish a release", async () => {
  await assert.rejects(
    verifyReleaseCI(fixture({ runs: [] }).options),
    /No CI|не найден/,
  );
});
test("detects rerun/failure after listing", async () => {
  await assert.rejects(
    verifyReleaseCI(
      fixture({
        detail: run({
          run_attempt: 2,
          status: "in_progress",
          conclusion: null,
        }),
      }).options,
    ),
  );
});
test("detects a new run started during verification", async () => {
  await assert.rejects(
    verifyReleaseCI(
      fixture({ latest: [run({ id: 22, status: "queued", conclusion: null })] })
        .options,
    ),
  );
});
for (const status of [401, 403, 404, 429, 500])
  test(`API ${status} blocks release`, async () => {
    await assert.rejects(
      verifyReleaseCI(fixture({ status }).options),
      new RegExp(String(status)),
    );
  });
test("network failures are sanitized and block release", async () => {
  await assert.rejects(
    verifyReleaseCI(fixture({ error: Error(token) }).options),
    (e) => !e.message.includes(token),
  );
});
test("invalid inputs make no API calls", async () => {
  for (const patch of [
    { repository: "fork/repo" },
    { sha: "main" },
    { token: "" },
  ]) {
    const f = fixture();
    await assert.rejects(verifyReleaseCI({ ...f.options, ...patch }));
    assert.equal(f.calls.length, 0);
  }
});
test("invalid API structure blocks release", async () => {
  await assert.rejects(
    verifyReleaseCI({
      repository,
      sha,
      token,
      transport: async () => ({ ok: true, json: async () => ({}) }),
    }),
  );
});

test("selects latest successful run regardless of API ordering", async () => {
  const newest = run({ id: 22, run_attempt: 2 });
  const f = fixture({
    runs: [run({ conclusion: "failure" }), newest],
    detail: newest,
  });
  assert.equal((await verifyReleaseCI(f.options)).runId, 22);
});
test("rejects an incomplete listing instead of accepting a possibly stale success", async () => {
  await assert.rejects(
    verifyReleaseCI({
      repository,
      sha,
      token,
      transport: async () => ({
        ok: true,
        json: async () => ({ total_count: 101, workflow_runs: [run()] }),
      }),
    }),
    /incomplete/,
  );
});
test("a completed rerun during the gate still requires a fresh verification", async () => {
  await assert.rejects(
    verifyReleaseCI(fixture({ detail: run({ run_attempt: 2 }) }).options),
    /changed/,
  );
});
