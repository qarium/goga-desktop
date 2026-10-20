import { build } from "esbuild";
await build({
  entryPoints: [
    "src/main/index.ts",
    "src/main/preload.ts",
    "src/main/afm-preload.ts",
    "src/main/acceptance-host.ts",
  ],
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  target: "node22",
  sourcemap: true,
});
