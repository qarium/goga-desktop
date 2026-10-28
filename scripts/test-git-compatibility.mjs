import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Additional lower-version coverage; never replaces any full CI shard.
export const compatibilityFiles = Object.freeze([
  "tests/git-native-contract.test.ts",
  "tests/git-native-branches.test.ts",
  "tests/git-native-sequence.test.ts",
  "tests/git-native-commit.test.ts",
  "tests/git-native-discard.test.ts",
  "tests/git-native-conflict-save.test.ts",
]);
export function runGitCompatibility({ run = spawnSync, shard } = {}) {
  let files = compatibilityFiles;
  if (shard !== undefined) {
    const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
    if (!match) throw Error("Invalid compatibility subgroup");
    const index = Number(match[1]),
      count = Number(match[2]);
    if (index > count || count > compatibilityFiles.length)
      throw Error("Invalid compatibility subgroup");
    files = compatibilityFiles.filter(
      (_file, position) => position % count === index - 1,
    );
  }
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const version = run("git", ["--version"], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });
  if (version.status !== 0 || version.stdout?.trim() !== "git version 2.45.2")
    throw Error(
      "Compatibility requires exactly Git 2.45.2 on PATH; tests were not started.",
    );
  const result = run(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      ...files,
      "--maxWorkers=3",
      "--testTimeout=15000",
      "--reporter=verbose",
      "--reporter=json",
      "--outputFile=work/git-compatibility.json",
    ],
    {
      cwd,
      stdio: "inherit",
      timeout: 30 * 60 * 1000,
      env: { ...process.env, GOGA_TOPIC_READONLY_CLI: "/nonexistent/disabled" },
    },
  );
  return Number.isInteger(result.status) ? result.status : 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runGitCompatibility({
      shard: process.env.GOGA_COMPAT_SHARD,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
