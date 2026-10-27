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
const pins = new Set([
  "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
]);
test("CI and release use pinned actions, read-only builds and explicit native-test disable", async () => {
  for (const name of ["ci", "release"]) {
    const w = await load(name);
    assert.deepEqual(w.permissions, { contents: "read" });
    for (const [id, j] of Object.entries(w.jobs)) {
      assert.ok(j["timeout-minutes"] > 0 && j["timeout-minutes"] <= 60);
      for (const s of j.steps)
        if (s.uses) {
          assert.ok(pins.has(s.uses), s.uses);
          if (s.uses.startsWith("actions/checkout@"))
            assert.equal(s.with["persist-credentials"], false);
        }
      if (id !== "publish") {
        assert.notEqual(j.permissions?.contents, "write");
        if (id !== "verify-ci")
          assert.equal(j.env.GOGA_TOPIC_READONLY_CLI, "/nonexistent/disabled");
        const commands = j.steps.map((s) => s.run ?? "").join("\n");
        const required =
          id === "verify-ci"
            ? [
                "scripts/verify-release-ci.mjs",
                "scripts/release-version.mjs --check",
                "git merge-base --is-ancestor",
              ]
            : id === "tests"
              ? [
                  "npm ci",
                  "--testTimeout=15000",
                  "--maxWorkers=1",
                  "scripts/test-summary.mjs",
                ]
              : [
                  "npm ci",
                  "npm run test:release",
                  "npm run typecheck",
                  "npm run build",
                ];
        for (const command of required)
          assert.ok(commands.includes(command), `${name}: ${command}`);
      }
    }
  }
});
test("release gates native two-architecture builds and narrowly scoped publisher", async () => {
  const w = await load("release");
  assert.deepEqual(w.on.push.tags, ["v*"]);
  assert.equal(w.concurrency["cancel-in-progress"], false);
  assert.deepEqual(w.jobs.build.strategy.matrix.include, [
    { arch: "arm64", runner: "macos-15", testProfile: "default" },
    { arch: "x64", runner: "macos-15-intel", testProfile: "slow-git" },
  ]);
  assert.equal(w.jobs.publish.needs, "build");
  assert.deepEqual(w.jobs.publish.permissions, {
    contents: "write",
    actions: "read",
  });
  const commands = w.jobs.build.steps.map((s) => s.run ?? "").join("\n");
  assert.ok(commands.includes("git merge-base --is-ancestor"));
  assert.ok(commands.includes("origin/main"));
  assert.ok(commands.includes("uname -m"));
  assert.ok(commands.includes("process.arch"));
  assert.ok(
    commands.indexOf("release-version.mjs --check") <
      commands.indexOf("npm ci"),
  );
  assert.ok(
    commands.indexOf("npm run release:version") <
      commands.indexOf("npm run build"),
  );
  assert.ok(commands.includes("scripts/verify-dmg.mjs"));
  for (const j of Object.values(w.jobs))
    for (const s of j.steps)
      if (s.run)
        assert.ok(
          !s.run.includes("${{ github.ref"),
          "Tag must be passed via env, not shell interpolation",
        );
});
test("packaging keeps adhoc-only settings and architecture-qualified names", async () => {
  const p = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(p.build.artifactName, "Goga-Desktop-${version}-${arch}.${ext}");
  assert.equal(p.build.mac.identity, null);
  assert.equal(p.build.mac.notarize, false);
  assert.equal(p.build.afterPack, "scripts/sign-local.mjs");
  assert.ok(
    p.build.mac.target.some(
      (t) =>
        t.target === "dmg" &&
        t.arch.includes("arm64") &&
        t.arch.includes("x64"),
    ),
  );
  assert.ok(
    p.build.dmg.contents.some(
      (c) => c.type === "link" && c.path === "/Applications",
    ),
  );
  assert.ok(
    p.scripts["package:release"].includes("CSC_IDENTITY_AUTO_DISCOVERY=false"),
  );
});

// Intel must be exercised on main/PR before choosing another release tag.
test("CI exercises both native architectures with scoped Intel test budgets", async () => {
  const expected = [
    { arch: "arm64", runner: "macos-15", testProfile: "default" },
    { arch: "x64", runner: "macos-15-intel", testProfile: "slow-git" },
  ];
  for (const name of ["ci"]) {
    const workflow = await load(name);
    const job = workflow.jobs.tests;
    assert.ok(job.strategy?.matrix?.include, "Native test matrix is required");
    assert.deepEqual(job.strategy.matrix.include, expected);
    assert.equal(job.strategy["fail-fast"], false);
    assert.equal(job["runs-on"], "${{ matrix.runner }}");
    assert.equal(job["timeout-minutes"], 60);
    assert.equal(job.env.GOGA_TEST_PROFILE, "${{ matrix.testProfile }}");
    assert.equal(job.env.EXPECTED_ARCH, "${{ matrix.arch }}");
    const commands = job.steps.map((step) => step.run ?? "").join("\n");
    assert.ok(commands.includes("process.arch !== process.env.EXPECTED_ARCH"));
    assert.ok(
      commands.includes("--reporter=verbose"),
      "Per-test progress must be visible",
    );
    assert.ok(commands.includes("--reporter=json"));
    assert.ok(
      !/--(?:retry|bail|isolate=false)|continue-on-error/.test(commands),
    );
    assert.notEqual(job["continue-on-error"], true);
    for (const step of job.steps)
      assert.notEqual(step["continue-on-error"], true);
  }
});

test("every native architecture runs all four independent CI shards", async () => {
  for (const name of ["ci"]) {
    const w = await load(name);
    const j = w.jobs.tests;
    assert.ok(j, `${name}: independent test job required`);
    assert.deepEqual(j.strategy.matrix.arch, ["arm64", "x64"]);
    assert.deepEqual(j.strategy.matrix.shard, [1, 2, 3, 4]);
    assert.equal(j.strategy["fail-fast"], false);
    assert.equal(j.env.TEST_SHARD, "${{ matrix.shard }}/4");
    const step = j.steps.find((s) => s.id === "tests");
    assert.ok(step);
    assert.match(step.run, /--shard="\$TEST_SHARD"/);
    assert.match(step.run, /--maxWorkers=1/);
    assert.doesNotMatch(step.run, /--(?:exclude|retry|bail|passWithNoTests)/);
    const report = j.steps.find((s) => s.name === "Exact skipped test report");
    assert.equal(report.if, "always()");
    assert.equal(report.env.TEST_OUTCOME, "${{ steps.tests.outcome }}");
    const build = w.jobs[name === "ci" ? "check" : "build"];
    assert.ok(!build.steps.some((s) => (s.run ?? "").includes("npm test --")));
    assert.equal(build.needs, "tests");
    if (name === "ci") {
      assert.equal(build.if, "always()");
      const gate = build.steps[0];
      assert.equal(gate.env.TEST_RESULT, "${{ needs.tests.result }}");
      assert.match(gate.run, /"\$TEST_RESULT" != success/);
      assert.match(gate.run, /exit 1/);
    }
  }
});

test("Vitest shards partition every discovered test file exactly once", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  // `vitest list --filesOnly` intentionally bypasses sharding. Exercise the
  // configured sequencer used by the real runner against discovered specs.
  const p = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createVitest } from 'vitest/node';
    const groups = [];
    let all;
    for (let index = 1; index <= 4; index++) {
      const ctx = await createVitest({ watch: false, shard: index + '/4' });
      try {
        const specs = await ctx.globTestSpecifications();
        all = specs.map(s => s.moduleId);
        const sequencer = new ctx.config.sequence.sequencer(ctx);
        groups.push((await sequencer.shard(specs)).map(s => s.moduleId));
      } finally { await ctx.close(); }
    }
    console.log(JSON.stringify({ all, shards: groups }));
  `,
    ],
    { cwd, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(p.status, 0, p.stderr);
  const { all, shards } = JSON.parse(p.stdout);
  assert.ok(all.length > 0);
  assert.ok(shards.every((files) => files.length > 0));
  const combined = shards.flat();
  assert.equal(
    new Set(combined).size,
    combined.length,
    "No duplicates between shards",
  );
  assert.deepEqual(
    combined.sort(),
    all.sort(),
    "No omitted test files, including future additions",
  );
});

test("release reuses successful exact-commit CI and never reruns the full suite", async () => {
  const w = await load("release");
  assert.equal(w.jobs.tests, undefined);
  const gate = w.jobs["verify-ci"];
  assert.ok(gate);
  assert.deepEqual(gate.permissions, { contents: "read", actions: "read" });
  const gateCommands = gate.steps.map((s) => s.run ?? "").join("\n");
  assert.ok(gateCommands.includes("node scripts/verify-release-ci.mjs"));
  assert.ok(gateCommands.includes("git merge-base --is-ancestor"));
  assert.equal(w.jobs.build.needs, "verify-ci");
  const all = Object.values(w.jobs)
    .flatMap((j) => j.steps.map((s) => s.run ?? ""))
    .join("\n");
  assert.doesNotMatch(all, /npm test|vitest run|--shard/);
  assert.match(all, /npm run test:release/);
  assert.match(all, /verify-dmg\.mjs.*--ui/);
  const steps = w.jobs.publish.steps;
  const check = steps.findIndex((s) =>
    (s.run ?? "").includes("verify-release-ci.mjs"),
  );
  const publish = steps.findIndex((s) =>
    (s.run ?? "").includes("publish-release.mjs publish"),
  );
  assert.ok(
    check >= 0 && check < publish,
    "Recheck CI before creating the release",
  );
  assert.equal(w.jobs.publish.permissions.actions, "read");
});
