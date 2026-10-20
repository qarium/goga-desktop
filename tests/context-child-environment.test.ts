import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { NodeRunner } from "../src/host/process";
const redirects = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];
afterEach(() => vi.unstubAllEnvs());
it("keeps the actual child in its explicit root despite inherited or runner Git redirects", async () => {
  const root = await mkdtemp(
    "/private/tmp/goga-context-ab-research-20261019-impl-env-",
  );
  const owned = root + "/owned";
  await mkdir(owned);
  for (const key of redirects) vi.stubEnv(key, root + "/foreign");
  const runner = new NodeRunner(5000, {
    GIT_DIR: root + "/another",
    FIXTURE_ORDINARY: "retained",
  });
  const result = await runner.command(
    process.execPath,
    [
      "-e",
      `console.log(JSON.stringify({cwd:process.cwd(),keys:${JSON.stringify(redirects)}.filter(k=>process.env[k]!==undefined),ordinary:process.env.FIXTURE_ORDINARY}))`,
    ],
    owned,
  );
  const actual = JSON.parse(result.stdout);
  expect(actual).toEqual({ cwd: owned, keys: [], ordinary: "retained" });
  expect(process.env.GIT_DIR).toBe(root + "/foreign");
  await runner.dispose();
});
it("does not inherit Git config injection from Desktop while preserving explicit controlled runner config", async () => {
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "/foreign");
  const runner = new NodeRunner(5000);
  const result = await runner.command(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify(Object.keys(process.env).filter(k=>/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k))))",
    ],
    "/private/tmp",
  );
  expect(JSON.parse(result.stdout)).toEqual([]);
  await runner.dispose();
});
