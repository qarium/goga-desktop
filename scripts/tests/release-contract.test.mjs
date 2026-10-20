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
        assert.equal(j.env.GOGA_TOPIC_READONLY_CLI, "/nonexistent/disabled");
        const commands = j.steps.map((s) => s.run ?? "").join("\n");
        for (const command of [
          "npm ci",
          "npm run test:release",
          "--testTimeout=15000",
          "--maxWorkers=1",
          "scripts/test-summary.mjs",
          "npm run typecheck",
          "npm run build",
        ])
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
    { arch: "arm64", runner: "macos-15" },
    { arch: "x64", runner: "macos-15-intel" },
  ]);
  assert.equal(w.jobs.publish.needs, "build");
  assert.deepEqual(w.jobs.publish.permissions, { contents: "write" });
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
