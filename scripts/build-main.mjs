import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { buildTerminalNative } from "./terminal-native-build.mjs";
import { build } from "esbuild";
await mkdir("dist-electron/assets", { recursive: true });
await copyFile("resources/icon.png", "dist-electron/assets/icon.png");
await build({
  entryPoints: [
    "src/main/index.ts",
    "src/main/preload.ts",
    "src/main/afm-preload.ts",
    "src/main/terminal-preload.ts",
    "src/main/terminal-bootstrap.ts",
    "src/main/acceptance-host.ts",
  ],
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "node-pty"],
  target: "node22",
  sourcemap: true,
});

await build({
  entryPoints: ["src/terminal/entry.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: "dist/terminal/terminal.js",
  target: "chrome120",
});
await mkdir("dist/terminal", { recursive: true });
const html = await readFile("src/terminal/terminal.html", "utf8");
await writeFile(
  "dist/terminal/index.html",
  html.replace('src="./entry.ts"', 'src="./terminal.js"'),
);
await buildTerminalNative();
