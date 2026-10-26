import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  withPrivateGitReadScope,
  withGitPolicyCaptureScope,
} from "./git-private-read-scope";

import { CommandExitError } from "./process";

const LIMIT = 32 * 1024 * 1024;
const stale = () => Error("Снимок Git устарел. Обновите список изменений.");
const stamp = (s: BigIntStats) =>
  [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
async function regular(filename: string) {
  let before: BigIntStats;
  try {
    before = await fs.lstat(filename, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(LIMIT) ||
    (await fs.realpath(path.dirname(filename))) !== path.dirname(filename)
  )
    throw Error("Небезопасный тип, ссылка или размер метаданных Git.");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before))
      throw stale();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (
      size !== Number(before.size) ||
      stamp(await handle.stat({ bigint: true })) !== stamp(before) ||
      stamp(await fs.lstat(filename, { bigint: true })) !== stamp(before)
    )
      throw stale();
    const bytes = buffer.subarray(0, size);
    return {
      bytes,
      identity: `${stamp(before)}:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } finally {
    await handle.close();
  }
}
const configQuote = (value: string) =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\u0008/g, "\\b")}"`;

/** Flatten once: never retain include directives or filter definitions, including
 * names unknown at capture time. Working-tree attributes can name any driver;
 * there is no executable definition for it in this private execution context. */
function privateConfig(raw: string, nativeAttributes: boolean) {
  if (raw && !raw.endsWith("\0")) throw Error("Неполная конфигурация Git.");
  const result: string[] = [];
  for (const row of raw.split("\0").filter(Boolean)) {
    const split = row.indexOf("\n"),
      key = split < 0 ? row : row.slice(0, split),
      value = split < 0 ? null : row.slice(split + 1),
      lower = key.toLowerCase();
    if (
      /^(?:include|includeif|filter)\./.test(lower) ||
      (!nativeAttributes && lower === "core.attributesfile") ||
      [
        "core.worktree",
        "core.bare",
        "core.alternaterefscommand",
        "extensions.worktreeconfig",
      ].includes(lower)
    )
      continue;
    if (lower === "extensions.refstorage" && value !== "files")
      throw Error(
        "Формат ссылок Git пока не поддерживается безопасным чтением.",
      );
    const match = /^([a-z0-9-]+)\.(?:([\s\S]*)\.)?([a-z][a-z0-9-]*)$/i.exec(
      key,
    );
    if (!match) throw Error("Некорректный ключ конфигурации Git.");
    result.push(
      `[${match[1]}${match[2] === undefined ? "" : ` ${configQuote(match[2])}`}]\n${match[3]}${value === null ? "" : ` = ${configQuote(value)}`}\n`,
    );
  }
  return result.join("");
}

/** Git's alternates file uses C-quoted byte paths, not JSON's Unicode escapes. */
function objectPath(filename: string) {
  return `"${[...Buffer.from(filename)]
    .map((byte) =>
      byte === 34 || byte === 92
        ? `\\${String.fromCharCode(byte)}`
        : byte < 32 || byte >= 127
          ? `\\${byte.toString(8).padStart(3, "0")}`
          : String.fromCharCode(byte),
    )
    .join("")}"\n`;
}

export interface PrivateGitRead {
  policy: string;
  git(args: string[]): Promise<string>;
  verify(): Promise<void>;
}

/** Disposable metadata only, not a source clone/worktree. Native Git compares
 * the unchanged working directory with a copied index/refs and uses the audited
 * source object directory solely as a read-only alternate. No object inventory,
 * worktree copy, source lock, configuration edit or real-index refresh occurs. */
export async function withPrivateGitRead<T>(
  root: string,
  safeArgs: string[],
  sourceGit: (args: string[]) => Promise<string>,
  execute: (args: string[]) => Promise<string>,
  read: (context: PrivateGitRead) => Promise<T>,
): Promise<T> {
  const captureGit = (args: string[]) =>
    withGitPolicyCaptureScope(() => sourceGit(args));
  const configArgs = ["config", "--null", "--list", "--includes"];
  const raw = await captureGit(configArgs),
    sources: { filename: string; identity: string }[] = [],
    attributes: Buffer[] = [];
  let nativeAttributes = false;
  // Preserve native system/global text/eol rules without letting an inherited
  // attributes redirect or default HOME re-enter the private process policy.
  for (const variable of ["GIT_ATTR_SYSTEM", "GIT_ATTR_GLOBAL"]) {
    let name: string;
    try {
      name = (await captureGit(["var", variable])).replace(/\n$/, "");
    } catch (error) {
      // Stock older Git has no GIT_ATTR_* var capability. Only this typed usage
      // outcome from our exact var command selects the fallback; cancellation,
      // timeouts and all other command failures must still abort the read.
      if (!(error instanceof CommandExitError) || error.exitCode !== 129)
        throw error;
      nativeAttributes = true;
      sources.length = 0;
      attributes.length = 0;
      break;
    }
    if (!name || name === "/dev/null") continue;
    if (name.includes("\0")) throw Error("Некорректный путь attributes Git.");
    const filename = path.resolve(root, name),
      file = await regular(filename);
    sources.push({ filename, identity: file?.identity ?? "missing" });
    if (file) attributes.push(file.bytes, Buffer.from("\n"));
  }
  // Legacy Git keeps its native configured/default attribute lookup. Without
  // var path discovery these global/system files cannot be byte-pinned: they
  // remain live, like worktree .gitattributes. Filter definitions still cannot
  // enter the immutable private config. A display revision is not permission to
  // write; the independent prepare/execute policy checks are unchanged.
  const config = privateConfig(raw, nativeAttributes);
  const tmp = await fs.realpath(os.tmpdir());
  if (tmp === root || tmp.startsWith(`${root}${path.sep}`))
    throw Error(
      "Небезопасный временный каталог Git: он находится внутри рабочей папки.",
    );
  const temp = await fs.mkdtemp(path.join(tmp, "goga-git-read-")),
    gitdir = path.join(temp, ".git"),
    source = path.join(root, ".git");
  try {
    for (const name of ["objects/info", "refs", "info"])
      await fs.mkdir(path.join(gitdir, name), { recursive: true, mode: 0o700 });
    let count = 0,
      total = 0;
    const copy = async (relative: string, depth = 0): Promise<void> => {
      if (++count > 100000 || depth > 12)
        throw Error("Метаданные Git превышают предел безопасного просмотра.");
      const filename = path.join(source, relative);
      let stat: BigIntStats;
      try {
        stat = await fs.lstat(filename, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (stat.isDirectory()) {
        if ((await fs.realpath(filename)) !== filename) throw stale();
        await fs.mkdir(path.join(gitdir, relative), {
          recursive: true,
          mode: 0o700,
        });
        for (const entry of await fs.readdir(filename))
          await copy(path.join(relative, entry), depth + 1);
      } else {
        const file = await regular(filename);
        if (!file) throw stale();
        total += file.bytes.length;
        if (total > 64 * 1024 * 1024)
          throw Error("Метаданные Git превышают предел безопасного просмотра.");
        await fs.writeFile(path.join(gitdir, relative), file.bytes, {
          mode: 0o600,
          flag: "wx",
        });
        if (relative === "index") {
          // A newly timestamped copy would hide racy-clean source entries:
          // Git compares worktree entry mtimes with the index file's own mtime.
          // Round DOWN to milliseconds so no native racy entry becomes trusted.
          const modified = new Date(Number(stat.mtimeNs / 1000000n));
          await fs.utimes(path.join(gitdir, relative), modified, modified);
        }
      }
    };
    for (const name of [
      "HEAD",
      "index",
      "refs",
      "packed-refs",
      "shallow",
      "info/attributes",
      "info/exclude",
      "info/grafts",
      "info/sparse-checkout",
    ])
      await copy(name);
    await fs.writeFile(path.join(gitdir, "config"), config, { mode: 0o600 });
    const attr = path.join(temp, "attributes");
    await fs.writeFile(attr, Buffer.concat(attributes), { mode: 0o600 });
    await fs.writeFile(
      path.join(gitdir, "objects/info/alternates"),
      objectPath(path.join(source, "objects")),
      { mode: 0o600 },
    );
    return await read({
      policy: createHash("sha256")
        .update(raw)
        .update(nativeAttributes ? "native-attributes" : "pinned-attributes")
        .update(JSON.stringify(sources))
        .digest("hex"),
      git: (args) =>
        withPrivateGitReadScope(
          () =>
            execute([
              ...safeArgs,
              `--git-dir=${gitdir}`,
              `--work-tree=${root}`,
              "-c",
              "core.bare=false",
              ...(nativeAttributes
                ? []
                : ["-c", `core.attributesfile=${attr}`]),
              ...args,
            ]),
          { nativeAttributes },
        ),
      verify: async () => {
        if ((await captureGit(configArgs)) !== raw) throw stale();
        for (const { filename, identity } of sources)
          if (((await regular(filename))?.identity ?? "missing") !== identity)
            throw stale();
      },
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
