import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { spawnSync } from "node:child_process";
const load = async (name) =>
  parse(
    await readFile(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );
const pins = new Set([
  "actions/cache@5a3ec84eff668545956fd18022155c47e93e2684",
  "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
]);
test("CI and release use pinned actions, read-only builds and explicit native-test disable", async () => {
  for (const name of ["ci", "intel-tests", "release"]) {
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
      if (id !== "publish" && id !== "complete") {
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
            : id === "git-compatibility"
              ? [
                  "npm ci",
                  "node scripts/test-git-compatibility.mjs",
                  "scripts/test-summary.mjs",
                ]
              : ["tests", "workspace-tests", "remaining-tests"].includes(id)
                ? [
                    "npm ci",
                    "--testTimeout=15000",
                    name === "ci" ? "--maxWorkers=3" : "--maxWorkers=1",
                    "scripts/test-summary.mjs",
                  ]
                : name === "release" && id === "build"
                  ? [
                      "scripts/release-step.mjs install",
                      "scripts/release-step.mjs build",
                    ]
                  : ["npm ci", "npm run build"];
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
    {
      arch: "arm64",
      runner: "macos-15",
    },
    {
      arch: "x64",
      runner: "macos-15-intel",
    },
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
      commands.indexOf("scripts/release-step.mjs install"),
  );
  assert.ok(
    commands.indexOf("npm run release:version") <
      commands.indexOf("scripts/release-step.mjs build"),
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

test("automatic CI is ARM-only; full Intel is manual and cannot gate a release", async () => {
  const arm = await load("ci"),
    intel = await load("intel-tests");
  assert.deepEqual(Object.keys(intel.on), ["workflow_dispatch"]);
  assert.deepEqual(arm.on.push.branches, ["main"]);
  assert.ok(Object.hasOwn(arm.on, "pull_request"));
  assert.equal(arm.jobs.tests["runs-on"], "macos-15");
  assert.equal(arm.jobs.check["runs-on"], "macos-15");
  assert.deepEqual(arm.jobs.check.needs, ["git-compatibility"]);
  assert.equal(arm.jobs.check.if, "${{ !cancelled() }}");
  for (const command of [
    "npm run test:release",
    "npm run typecheck",
    "npm run build",
  ])
    assert.ok(arm.jobs.check.steps.some((s) => s.run === command));
  assert.equal(intel.jobs.tests["runs-on"], "macos-15-intel");
  assert.equal(intel.jobs.tests.env.EXPECTED_ARCH, "x64");
  assert.equal(intel.jobs.tests.env.GOGA_TEST_PROFILE, "slow-git");
  assert.equal(intel.jobs.tests.env.GOGA_CI_DOMAIN, undefined);
  assert.deepEqual(
    intel.jobs.tests.strategy.matrix.shard,
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(intel.jobs.check["runs-on"], "macos-15-intel");
  assert.deepEqual(arm.jobs.complete.needs, [
    "tests",
    "workspace-tests",
    "remaining-tests",
    "git-compatibility",
    "check",
  ]);
  assert.equal(arm.jobs.complete.if, "always()");
  const gate = arm.jobs.complete.steps[0];
  assert.equal(gate.env.RESULTS, "${{ toJSON(needs) }}");
  assert.match(gate.run, /result !== 'success'/);
  assert.match(gate.run, /exit\(1\)/);
  assert.ok(!JSON.stringify(arm).includes("macos-15-intel"));
});
test("domain matrix covers eight areas and complete numbered subgroups", async () => {
  const w = await load("ci"),
    j = w.jobs.tests;
  const manifest = JSON.parse(
    await readFile(new URL("../ci-test-domains.json", import.meta.url), "utf8"),
  );
  const matrix = [
    j,
    w.jobs["workspace-tests"],
    w.jobs["remaining-tests"],
  ].flatMap((job) => job.strategy.matrix.include);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(manifest).map((domain) => [
        domain,
        matrix.filter((row) => row.domain === domain).length,
      ]),
    ),
    {
      "git-workspace": 1,
      "git-conflicts": 4,
      "git-safety": 1,
      topics: 1,
      terminal: 1,
      launches: 1,
      documents: 1,
      shell: 1,
    },
  );
  assert.deepEqual(
    [...new Set(matrix.map((row) => row.domain))].sort(),
    Object.keys(manifest).sort(),
  );
  for (const domain of Object.keys(manifest)) {
    const rows = matrix.filter((row) => row.domain === domain),
      count = rows[0].count;
    assert.ok(rows.every((row) => row.count === count));
    assert.deepEqual(
      rows.map((row) => row.shard).sort((a, b) => a - b),
      Array.from({ length: count }, (_, i) => i + 1),
    );
  }
  assert.equal(j.env.GOGA_CI_DOMAIN, "${{ matrix.domain }}");
  assert.equal(j.env.TEST_SHARD, "${{ matrix.shard }}/${{ matrix.count }}");
  for (const [name, id] of [
    ["ci", "tests"],
    ["ci", "workspace-tests"],
    ["ci", "remaining-tests"],
    ["intel-tests", "tests"],
  ]) {
    const job = (await load(name)).jobs[id];
    assert.equal(job.strategy["fail-fast"], false);
    assert.notEqual(job["continue-on-error"], true);
    const commands = job.steps.map((s) => s.run ?? "").join("\n");
    for (const expected of [
      name === "ci" ? "--maxWorkers=3" : "--maxWorkers=1",
      "--testTimeout=15000",
      "--reporter=verbose",
      "--reporter=json",
      '--shard="$TEST_SHARD"',
    ])
      assert.ok(commands.includes(expected));
    assert.doesNotMatch(commands, /--(?:exclude|retry|bail|passWithNoTests)/);
    const report = job.steps.find(
      (s) => s.name === "Exact skipped test report",
    );
    assert.equal(report.if, "always()");
    assert.equal(report.env.TEST_OUTCOME, "${{ steps.tests.outcome }}");
    for (const step of job.steps)
      assert.notEqual(step["continue-on-error"], true);
  }
});

test("Vitest shards partition every discovered test file exactly once", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  // `vitest list --filesOnly` intentionally bypasses sharding. Exercise the
  // configured sequencer used by the real runner against discovered specs.
  for (const count of [4, 8]) {
    const p = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { createVitest } from 'vitest/node';
    const groups = [];
    let all;
    for (let index = 1; index <= ${count}; index++) {
      const ctx = await createVitest({ watch: false, shard: index + '/${count}' });
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
  }
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
  assert.doesNotMatch(all, /npm run test:release|npm run typecheck/);
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

test("lower Git compatibility is isolated, checksummed and required in addition to all domains", async () => {
  const workflow = await load("ci");
  const j = workflow.jobs["git-compatibility"];
  assert.ok(j, "Additional lower-Git job required");
  assert.equal(j.strategy, undefined);
  assert.equal(j.env.GOGA_COMPAT_SHARD, undefined);
  assert.equal(j["runs-on"], "macos-15");
  assert.equal(j.env.GOGA_TEST_PROFILE, "slow-git");
  assert.notEqual(j["continue-on-error"], true);
  const commands =
    j.steps.map((s) => s.run ?? "").join("\n") +
    (await readFile(new URL("../build-ci-git.sh", import.meta.url), "utf8"));
  assert.match(commands, /git-2\.45\.2\.tar\.xz/);
  assert.match(
    commands,
    /51bfe87eb1c02fed1484051875365eeab229831d30d0cec5d89a14f9e40e9adb/,
  );
  assert.match(commands, /shasum -a 256 -c/);
  assert.match(commands, /\$RUNNER_TEMP/);
  assert.doesNotMatch(
    commands,
    /sudo|brew (?:install|unlink|link)|--retry|continue-on-error/,
  );
  assert.match(commands, /node scripts\/test-git-compatibility\.mjs/);
  assert.ok(workflow.jobs.complete.needs.includes("git-compatibility"));
  const report = j.steps.find((s) => s.name === "Compatibility test report");
  assert.equal(report.if, "always()");
  assert.match(report.run, /test-summary.mjs work\/git-compatibility.json/);
});

test("both native releases use only bounded packaged viability smoke, with no repeated regression or types", async () => {
  const w = await load("release"),
    steps = w.jobs.build.steps;
  const commands = steps.map((s) => s.run ?? "").join("\n");
  assert.doesNotMatch(
    commands,
    /npm (?:test|run (?:test:release|typecheck))|vitest|--shard/,
  );
  assert.equal(w.jobs.build.env.GOGA_TEST_PROFILE, undefined);
  assert.equal(w.jobs.build["timeout-minutes"], 15);
  for (const phase of ["install", "build", "package"])
    assert.ok(commands.includes("node scripts/release-step.mjs " + phase));
  const smoke = steps.find((s) => (s.run ?? "").includes("verify-dmg.mjs"));
  assert.equal(smoke.if, undefined);
  assert.equal(smoke["timeout-minutes"], 4);
  assert.match(smoke.run, /--ui/);
  const diagnostics = steps.find(
    (s) => s.name === "Upload release diagnostics",
  );
  assert.equal(diagnostics.if, "always()");
  assert.equal(diagnostics.with.name, "release-diagnostics-${{ matrix.arch }}");
  assert.equal(diagnostics.with.path, "work/release-report/");
  const cache = steps.find((s) => s.name === "Cache verified tool downloads");
  assert.ok(cache.with.key.includes("runner.arch"));
  assert.ok(cache.with.key.includes("package-lock.json"));
  assert.ok(cache.with.key.includes("steps.toolchain.outputs.key"));
  assert.match(cache.with.path, /downloads\/electron/);
  assert.match(cache.with.path, /home\/\.electron-gyp/);
  assert.doesNotMatch(cache.with.path, /node_modules|app\.asar|release-report/);
  for (const name of ["verify-ci", "publish"])
    assert.ok(!w.jobs[name].steps.some((s) => s.with?.cache === "npm"));
});

test("expensive domains start before short domains without skipping checks on a failed dependency", async () => {
  const w = await load("ci"),
    priority = w.jobs.tests,
    remaining = w.jobs["remaining-tests"];
  assert.equal(priority.needs, undefined);
  assert.deepEqual(
    priority.strategy.matrix.include.map((row) => row.domain),
    [
      "git-conflicts",
      "git-conflicts",
      "git-conflicts",
      "git-conflicts",
      "topics",
    ],
  );
  assert.equal(priority.env.GOGA_TEST_PROFILE, "slow-git");
  assert.equal(w.jobs["git-compatibility"].needs, undefined);
  assert.deepEqual(w.jobs["workspace-tests"].needs, ["git-compatibility"]);
  assert.equal(w.jobs["workspace-tests"].if, "${{ !cancelled() }}");
  assert.equal(w.jobs["workspace-tests"].env.GOGA_TEST_PROFILE, "slow-git");
  assert.deepEqual(w.jobs["workspace-tests"].strategy.matrix.include, [
    { domain: "git-workspace", shard: 1, count: 1 },
  ]);
  assert.deepEqual(remaining.needs, ["check"]);
  assert.equal(remaining.if, "${{ !cancelled() }}");
  assert.equal(remaining.env.GOGA_TEST_PROFILE, "default");
  for (const job of [
    priority,
    remaining,
    w.jobs["workspace-tests"],
    w.jobs["git-compatibility"],
    w.jobs.check,
  ]) {
    assert.equal(job["timeout-minutes"], 15);
    assert.notEqual(job["continue-on-error"], true);
  }
});


test("manual release validation cannot publish and still requires exact-commit CI", async () => {
  const w = await load("release");
  assert.equal(w.on.workflow_dispatch.inputs.validation_tag.required, true);
  assert.equal(w.on.workflow_dispatch.inputs.validation_tag.type, "string");
  assert.equal(w.env.RELEASE_TAG, "${{ github.event_name == 'workflow_dispatch' && inputs.validation_tag || github.ref_name }}");
  assert.equal(w.jobs.publish.if, "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}");
  assert.equal(w.jobs.build.needs, "verify-ci");
  for (const name of ["verify-ci", "build"]) {
    const job = w.jobs[name];
    assert.equal(job.steps.find(s => s.uses?.startsWith("actions/checkout@")).with.ref, "${{ github.sha }}");
    assert.equal(job.permissions?.contents ?? w.permissions.contents, "read");
  }
  assert.ok(w.jobs["verify-ci"].steps.some(s => s.run === "node scripts/verify-release-ci.mjs"));
  assert.ok(w.jobs.publish.steps.some(s => s.run === "node scripts/verify-release-ci.mjs"));
});

test("release admission permits only real tags or non-publishing main validation", async () => {
  const w = await load("release");
  const sha = "a".repeat(40);
  for (const name of ["verify-ci", "build"]) {
    const admission = w.jobs[name].steps.find(s => s.run?.includes("git merge-base --is-ancestor")).run;
    const fakeGit = `git() {
      case "$*" in
        "rev-parse HEAD") printf '%s\\n' "$GITHUB_SHA";;
        "rev-parse $RELEASE_TAG^{commit}") printf '%s\\n' "$TAG_SHA";;
        "merge-base --is-ancestor $GITHUB_SHA origin/main") test "$MAIN_ANCESTRY" = yes;;
        *) return 88;;
      esac
    }
`;
    const run = (event, ref, extra = {}) => spawnSync("/bin/bash", ["-e", "-c", fakeGit + admission], {
      env: {PATH: process.env.PATH, RELEASE_TAG: "v0.1.51", GITHUB_SHA: sha, TAG_SHA: sha,
        MAIN_ANCESTRY: "yes", GITHUB_EVENT_NAME: event, GITHUB_REF: ref, ...extra},
      cwd: new URL("../..", import.meta.url), encoding: "utf8",
    }).status;
    assert.equal(run("push", "refs/tags/v0.1.51"), 0, name);
    assert.equal(run("workflow_dispatch", "refs/heads/main"), 0, name);
    assert.notEqual(run("workflow_dispatch", "refs/heads/other"), 0, name);
    assert.notEqual(run("workflow_dispatch", "refs/tags/v0.1.51"), 0, name);
    assert.notEqual(run("push", "refs/heads/main"), 0, name);
    assert.notEqual(run("pull_request", "refs/heads/main"), 0, name);
    assert.notEqual(run("push", "refs/tags/v0.1.51", {TAG_SHA: "b".repeat(40)}), 0, name);
    assert.notEqual(run("workflow_dispatch", "refs/heads/main", {MAIN_ANCESTRY: "no"}), 0, name);
    assert.notEqual(run("workflow_dispatch", "refs/heads/main", {RELEASE_TAG: "main"}), 0, name);
  }
});

test("release cache uses runtime environment, not unsupported runner context in job env", async () => {
  const w = await load("release");
  for (const job of Object.values(w.jobs))
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), /\$\{\{[^}]*\brunner\./);
  const steps = w.jobs.build.steps;
  const setup = steps.findIndex(s => s.run?.includes('ELECTRON_BUILDER_CACHE=$RUNNER_TEMP/goga-release-builder-cache'));
  const cache = steps.findIndex(s => s.uses?.startsWith("actions/cache@"));
  assert.ok(setup >= 0 && setup < cache);
  assert.ok(steps[setup].run.includes('>> "$GITHUB_ENV"'));
  assert.ok(steps[cache].with.path.includes('${{ env.ELECTRON_BUILDER_CACHE }}'));
});
