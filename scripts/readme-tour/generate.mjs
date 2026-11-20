// Regenerate documentation media only; never start the Desktop host.
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    "ui-locale": { type: "string", default: "en" },
    "caption-locale": { type: "string", default: "en" },
    output: { type: "string", default: path.resolve(here, "../../guides/media") },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: node scripts/readme-tour/generate.mjs [--ui-locale en|ru] [--caption-locale en] [--output DIR]\nUses python3 with Pillow (override with PYTHON). No real projects or pipeline runs.");
} else {
  const python = process.env.PYTHON || "python3";
  function run(bin, args) {
    const result = spawnSync(bin, args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Tour step failed: ${path.basename(bin)} (status ${result.status ?? result.signal})`);
  }

  const captionLocale = values["caption-locale"];
  if (!/^[a-zA-Z0-9_-]+$/.test(captionLocale)) throw new Error("Invalid caption locale");
  await access(path.join(here, "captions", captionLocale + ".json")).catch(() => {
    throw new Error("No caption pack for: " + captionLocale);
  });
  run(python, ["-c", "from PIL import Image, ImageDraw, ImageFont"]);
  const temp = await mkdtemp(path.join(tmpdir(), "goga-readme-tour-"));
  const frames = path.join(temp, "frames");
  const rendered = path.join(temp, "rendered");
  try {
    await mkdir(frames);
    await mkdir(rendered);
    run(process.execPath, [path.join(here, "capture.mjs"), "--output", frames, "--ui-locale", values["ui-locale"]]);
    run(python, [path.join(here, "render.py"), "--frames", frames, "--output", rendered, "--locale", values["caption-locale"]]);
    await mkdir(values.output, { recursive: true });
    for (const file of ["desktop-tour.gif", "desktop-tour-poster.png"])
      await copyFile(path.join(rendered, file), path.join(values.output, file));
    console.log("Wrote desktop-tour.gif and desktop-tour-poster.png.");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
