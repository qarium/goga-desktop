/** Explicit diagnostic only; reads AFM source, writes exclusively under Desktop/work. */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const source = process.env.AFM_NOTIFICATION_SOURCE;
if (!source || !path.isAbsolute(source))
  throw Error(
    "Set AFM_NOTIFICATION_SOURCE to the absolute read-only AFM hook .ts file.",
  );
const root = path.resolve("work/notification-fixture-" + Date.now());
fs.mkdirSync(path.join(root, "app"), { recursive: true });
await build({
  entryPoints: ["scripts/notification-fixture/renderer.tsx"],
  outfile: root + "/app/fixture.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  nodePaths: [path.resolve("node_modules")],
  plugins: [
    {
      name: "observe-real-notification",
      setup(b) {
        b.onResolve({ filter: /^afm-notification-hook$/ }, () => ({
          path: source,
        }));
        b.onLoad({ filter: /use-desktop-notifications\.ts$/ }, async (args) => {
          const original = fs.readFileSync(args.path, "utf8");
          const target = "n = new Notification(title, { body, icon, tag })";
          if (!original.includes(target))
            throw Error(
              "AFM hook changed: review diagnostic instrumentation first.",
            );
          return {
            loader: "ts",
            contents: original.replace(
              target,
              `(window as any).recordNotification({kind:'constructor',title,hidden:document.hidden,permission:Notification.permission}); n = new Notification(title, { body, icon, tag }); for(const kind of ['show','error','click','close']) n.addEventListener(kind,()=> (window as any).recordNotification({kind:'browser-'+kind,title}));`,
            ),
          };
        });
      },
    },
  ],
});
await build({
  entryPoints: ["scripts/notification-fixture/main.ts"],
  outfile: root + "/app/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
fs.copyFileSync("dist-electron/afm-preload.cjs", root + "/app/afm-preload.cjs");
fs.writeFileSync(
  root + "/app/package.json",
  JSON.stringify({
    name: "goga-notification-test",
    version: "0.0.1",
    main: "main.cjs",
    author: "Goga Desktop",
    description: "Isolated notification diagnostic",
    license: "UNLICENSED",
  }),
);
fs.writeFileSync(
  root + "/builder.json",
  JSON.stringify({
    appId: "local.goga.desktop.notification-fixture",
    productName: "Goga Notification Test",
    directories: { app: root + "/app", output: root + "/bundle" },
    files: ["**/*"],
    electronVersion: "44.8.0",
    electronDist: path.resolve("node_modules/electron/dist"),
    afterPack: path.resolve("scripts/sign-local.mjs"),
    mac: { identity: null, notarize: false, target: ["dir"] },
  }),
);
console.log(root);
