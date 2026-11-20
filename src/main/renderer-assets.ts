import { t } from "../shared/i18n";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RendererAssets {
  html: string;
  dispose(): Promise<void>;
}

const maxFiles = 16_384;
const maxBytes = 256 * 1024 * 1024;
const changed = () =>
  new Error(
    t("native.assetsChanged"),
  );
const identity = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );

interface AssetTree {
  directories: string[];
  files: { relative: string; bytes: Buffer }[];
  fingerprint: string;
}

async function readTree(
  root: string,
  retainBytes: boolean,
): Promise<AssetTree> {
  const tree: AssetTree = { directories: [], files: [], fingerprint: "" };
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  let entries = 0;
  async function visit(relative: string) {
    if (++entries > maxFiles * 2)
      throw new Error(t("native.assetsTooMany"));
    const filename = path.join(root, relative);
    const stat = await fs.lstat(filename, { bigint: true });
    if (stat.isSymbolicLink())
      throw new Error(
        t("native.assetsNoSymlinks"),
      );
    if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, "directory", identity(stat)]));
      if (relative) tree.directories.push(relative);
      for (const name of (await fs.readdir(filename)).sort())
        await visit(path.join(relative, name));
      return;
    }
    if (!stat.isFile())
      throw new Error(
        t("native.assetsFileTypes"),
      );
    if (++files > maxFiles || stat.size > BigInt(maxBytes - bytes))
      throw new Error(
        t("native.assetsTooLarge"),
      );
    bytes += Number(stat.size);
    // Do not follow a last-moment symlink or block if a file became a FIFO.
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || identity(opened) !== identity(stat))
        throw changed();
      const content = await handle.readFile();
      if (
        content.length !== Number(stat.size) ||
        identity(await handle.stat({ bigint: true })) !== identity(stat)
      )
        throw changed();
      hash.update(
        JSON.stringify([
          relative,
          "file",
          identity(stat),
          createHash("sha256").update(content).digest("hex"),
        ]),
      );
      if (retainBytes) tree.files.push({ relative, bytes: content });
    } finally {
      await handle.close();
    }
  }
  await visit("");
  tree.fingerprint = hash.digest("hex");
  return tree;
}

/** Keep a development window's complete lazy-import graph alive across builds.
 * Packaged ASAR assets are immutable already; never copy snapshots into dist. */
export async function prepareRendererAssets(
  sourceRoot: string,
  packaged: boolean,
): Promise<RendererAssets> {
  const source = path.resolve(sourceRoot);
  if (packaged)
    return { html: path.join(source, "index.html"), dispose: async () => {} };

  const before = await readTree(source, true);
  if (!before.files.some((file) => file.relative === "index.html"))
    throw new Error(t("native.assetsMissing"));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "goga-renderer-"));
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= fs.rm(temporary, { recursive: true, force: true }));
  try {
    await fs.chmod(temporary, 0o700);
    for (const directory of before.directories)
      await fs.mkdir(path.join(temporary, directory), { mode: 0o700 });
    for (const file of before.files)
      await fs.writeFile(path.join(temporary, file.relative), file.bytes, {
        flag: "wx",
        mode: 0o600,
      });
    // A Vite build can remove/rewrite a whole import graph during the copy.
    // Refuse drift rather than opening an apparently ready, partial renderer.
    if (before.fingerprint !== (await readTree(source, false)).fingerprint)
      throw changed();
    return { html: path.join(temporary, "index.html"), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
