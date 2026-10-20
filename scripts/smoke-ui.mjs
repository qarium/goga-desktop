import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import electron from "electron";
const root = path.resolve("work/ui-smoke-" + Date.now());
mkdirSync(root, { recursive: true });
await build({
  entryPoints: ["scripts/smoke-ui.ts", "scripts/smoke-ui-preload.ts"],
  outdir: root,
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  outExtension: { ".js": ".cjs" },
});
const env = { ...process.env, GOGA_UI_SMOKE_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [path.join(root, "smoke-ui.cjs")], {
  stdio: "inherit",
  env,
});
process.exitCode = result.status ?? 1;
