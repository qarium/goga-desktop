import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import {
  compatibilityFiles,
  runGitCompatibility,
} from "../test-git-compatibility.mjs";

test("compatibility covers native reads, branches, sequence, commit, discard and conflict save", async () => {
  assert.deepEqual(compatibilityFiles, [
    "tests/git-native-contract.test.ts",
    "tests/git-native-branches.test.ts",
    "tests/git-native-sequence.test.ts",
    "tests/git-native-commit.test.ts",
    "tests/git-native-discard.test.ts",
    "tests/git-native-conflict-save.test.ts",
  ]);
  for (const file of compatibilityFiles)
    await access(new URL(`../../${file}`, import.meta.url));
});
test("compatibility refuses a missing or wrong exact Git version without executing tests", () => {
  for (const version of [
    "git version 2.55.0",
    "git version 2.45.2-extra",
    "",
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        runGitCompatibility({
          run: () => {
            calls++;
            return { status: 0, stdout: version };
          },
        }),
      /2\.45\.2/,
    );
    assert.equal(calls, 1);
  }
});
test("compatibility runs all selected files once and propagates failures", () => {
  const calls = [];
  const code = runGitCompatibility({
    run: (executable, args, options) => {
      calls.push({ executable, args, options });
      return calls.length === 1
        ? { status: 0, stdout: "git version 2.45.2\n" }
        : { status: 7 };
    },
  });
  assert.equal(code, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].executable, process.execPath);
  assert.deepEqual(calls[1].args.slice(2, 8), compatibilityFiles);
  const args = calls[1].args.join(" ");
  assert.match(args, /--maxWorkers=4/);
  assert.match(args, /--testTimeout=15000/);
  assert.doesNotMatch(
    args,
    /--(?:exclude|retry|bail|passWithNoTests|shard)| -t /,
  );
  assert.equal(
    calls[1].options.env.GOGA_TOPIC_READONLY_CLI,
    "/nonexistent/disabled",
  );
  assert.equal(
    runGitCompatibility({
      run: (_e, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "git version 2.45.2" }
          : { status: null, signal: "SIGTERM" },
    }),
    1,
  );
});

test("compatibility subgroups retain the same six files exactly once and reject malformed input", () => {
  const selected = [];
  for (const shard of ["1/3", "2/3", "3/3"]) {
    runGitCompatibility({
      shard,
      run: (_file, args) => {
        if (args[0] === "--version")
          return { status: 0, stdout: "git version 2.45.2" };
        selected.push(...args.filter((a) => a.startsWith("tests/")));
        return { status: 0 };
      },
    });
  }
  assert.deepEqual(selected.sort(), [...compatibilityFiles].sort());
  for (const shard of ["0/3", "4/3", "1/0", "1/7", "bad"]) {
    let calls = 0;
    assert.throws(() =>
      runGitCompatibility({
        shard,
        run: () => {
          calls++;
          return { status: 0, stdout: "git version 2.45.2" };
        },
      }),
    );
    assert.equal(calls, 0);
  }
});
