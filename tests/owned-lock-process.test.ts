import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { acquireOwnedLock } from "../src/host/owned-lock";
let root: string, bundle: string;
beforeAll(async () => {
  root = await mkdtemp("/private/tmp/goga-atomic-lock-process-");
  bundle = path.join(root, "lock.cjs");
  await build({
    entryPoints: ["src/host/owned-lock.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it.each(["opened", "written", "linked", "admitted"])(
  "survives creator exit at %s without an empty authoritative lock",
  async (phase) => {
    const folder = await mkdtemp(path.join(root, "case-")),
      file = path.join(folder, ".lock");
    const script = `
    const fs = require('node:fs/promises');
    const originalOpen = fs.open, originalLink = fs.link;
    fs.open = async (...args) => {
      const h = await originalOpen(...args);
      if (args[1] & require('node:fs').constants.O_CREAT) {
        if (${JSON.stringify(phase)} === 'opened') process.exit(23);
        const write = h.writeFile.bind(h);
        h.writeFile = async (...a) => { await write(...a); if (${JSON.stringify(phase)} === 'written') process.exit(23); };
      }
      return h;
    };
    fs.link = async (...args) => { await originalLink(...args); if (${JSON.stringify(phase)} === 'linked') process.exit(23); };
    require(${JSON.stringify(bundle)}).acquireOwnedLock(${JSON.stringify(file)}).then(() => process.exit(23)).catch(e => { console.error(e); process.exit(24); });
  `;
    const child = spawnSync(process.execPath, ["-e", script], {
      env: { PATH: "/usr/bin:/bin", HOME: folder },
      timeout: 10000,
      encoding: "utf8",
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(23);
    const raw = await readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (phase === "opened" || phase === "written") expect(raw).toBeNull();
    else
      expect(JSON.parse(raw!)).toMatchObject({
        schemaVersion: 1,
        pid: child.pid,
      });
    const next = await acquireOwnedLock(file, { attempts: 1 });
    await next.release();
    expect(await readFile(file).catch(() => null)).toBeNull();
    // Pre-publication crash may leave a private candidate; it is not an admission lock.
    if (phase === "linked" || phase === "admitted")
      expect(await readdir(folder)).toEqual([]);
  },
);
