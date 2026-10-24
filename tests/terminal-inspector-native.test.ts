import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { beforeAll, afterAll, it } from "vitest";
let dir: string, binary: string;
const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
beforeAll(() => {
  dir = mkdtempSync("/private/tmp/goga-terminal-inspector-unit-");
  binary = join(dir, "fixture");
  execFileSync(
    "/usr/bin/clang",
    [
      "-Wall",
      "-Wextra",
      "-Werror",
      resolve("tests/native/terminal-inspect-fixture.c"),
      "-o",
      binary,
    ],
    {
      env: { ...env, TMPDIR: dir, HOME: dir },
      timeout: 10000,
      killSignal: "SIGTERM",
      stdio: "pipe",
    },
  );
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it.each([
  "birth-transition",
  "identity-changes",
  "terminal-changes",
  "latest-status",
  "invalid-arguments",
  "snapshot-bound",
])("production C reader: %s (mock OS only)", (name) => {
  const started = performance.now();
  try {
    execFileSync(binary, [name], {
      env,
      timeout: 1000,
      killSignal: "SIGTERM",
      stdio: "pipe",
    });
  } catch (error) {
    const result = error as { code?: string; stderr?: Buffer };
    // Synthetic fixture emits only this entry marker. Distinguish loader delay
    // from execution without raising the budget or masking an assertion failure.
    const entered =
      result.stderr?.toString().includes("fixture-entered") ?? false;
    throw new Error(
      `C fixture ${name}: entered=${entered}; timeout=${result.code === "ETIMEDOUT"}; elapsedMs=${Math.round(performance.now() - started)}`,
    );
  }
});
