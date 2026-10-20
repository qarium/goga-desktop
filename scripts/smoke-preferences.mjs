import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import electron from "electron";
const root = path.resolve("work/preferences-native-" + Date.now());
mkdirSync(root, { recursive: true });
// Use the exact production preload built by npm run build, not a test substitute.
copyFileSync(
  "dist-electron/afm-preload.cjs",
  path.join(root, "afm-preload.cjs"),
);
const entry = path.join(root, "smoke.cjs");
await build({
  entryPoints: ["scripts/smoke-preferences.ts"],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  target: "node22",
});
const env = { ...process.env, GOGA_PREFERENCE_SMOKE_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [entry], { stdio: "inherit", env });
console.log("Native preference check:", root);
process.exitCode = result.status ?? 1;
