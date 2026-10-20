import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync("work", { recursive: true });
await build({
  entryPoints: ["scripts/smoke-host.ts"],
  outfile: "work/smoke-host.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
});
const result = spawnSync(process.execPath, ["work/smoke-host.cjs"], {
  stdio: "inherit",
  env: process.env,
});
process.exitCode = result.status ?? 1;
