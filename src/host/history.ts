import path from "node:path";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  HISTORY_MAX_BYTES,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_DEPTH,
  historyYearSchema,
  historyEntrySchema,
  historyPathSchema,
  type HistoryArtifact,
  type HistoryDocument,
} from "../shared/history";
import { topicTargetSchema } from "../shared/topics-schema";
import type { TopicTarget } from "../shared/topics";
import type { TopicContextRef } from "../shared/worktrees";
import {
  assertReadActive,
  readSignal,
  withReadScope,
  withOfflineGitReadScope,
} from "./read-scope";
import { childEnvironment } from "./process-environment";

const execute = promisify(execFile);
const changed = () =>
  Error(
    "История или её каталог изменились во время чтения. Откройте историю заново.",
  );
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const sameIdentity = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: Stats, b: Stats) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.nlink === b.nlink;
class Unreadable extends Error {}
const binary =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|bz2|xz|7z|rar|tar|zst|woff2?|ttf|otf|eot|mp[34]|m4[av]|mov|avi|webm|wav|ogg|flac|sqlite3?|db|exe|dll|so|dylib|bin|wasm|pyc|class|jar|docx?|xlsx?|pptx?)$/i;
function text(bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Unreadable("Файл не является корректным UTF-8");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value))
    throw new Unreadable(
      "Бинарные данные или управляющие символы не поддерживаются",
    );
  return value;
}
function supported(name: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > HISTORY_MAX_BYTES)
    throw new Unreadable("Файл превышает лимит 1 МиБ");
  if (binary.test(name))
    throw new Unreadable(
      "Бинарный формат доступен только вне просмотрщика истории",
    );
}
function regular(name: string, info: Stats) {
  if (info.isSymbolicLink())
    throw new Unreadable("Символические ссылки не разрешены");
  if (!info.isFile()) throw new Unreadable("Читаются только обычные файлы");
  if (info.nlink !== 1)
    throw new Unreadable("Файлы с жёсткими ссылками не разрешены");
  supported(name, info.size);
}
function document(relativePath: string, value: string): HistoryDocument {
  return {
    relativePath,
    text: value,
    format: /\.(md|markdown)$/i.test(relativePath) ? "markdown" : "text",
  };
}
function entryPath(year: string, entry: string) {
  return `.goga/history/${historyYearSchema.parse(year)}/${historyEntrySchema.parse(entry)}`;
}

/** Cooperative host cancellation, including a 30s budget for direct callers.
 * Filesystem syscalls cannot be interrupted; the generic IPC transport owns the
 * finite response deadline and keeps still-pending physical reads counted. */
export async function withHistoryRead<T>(action: () => Promise<T>): Promise<T> {
  assertReadActive();
  const controller = new AbortController(),
    parent = readSignal();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 30000);
  if (parent?.aborted) abort();
  try {
    return await withOfflineGitReadScope(() =>
      withReadScope(controller.signal, async () => {
        assertReadActive();
        const result = await action();
        assertReadActive();
        return result;
      }),
    );
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

/** Per-operation identities only. No filesystem or document cache survives a read. */
class FilesystemRead {
  private identities = new Map<string, { info?: Stats; contents: boolean }>();
  constructor(readonly root: string) {}
  async stat(file: string, contents = false): Promise<Stats | undefined> {
    assertReadActive();
    let info: Stats | undefined;
    try {
      info = await lstat(file);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    assertReadActive();
    const prior = this.identities.get(file);
    if (
      prior &&
      (!prior.info !== !info ||
        (prior.info &&
          info &&
          !(prior.contents || !info.isDirectory()
            ? sameFile(prior.info, info)
            : sameIdentity(prior.info, info))))
    )
      throw changed();
    this.identities.set(file, {
      info,
      contents: contents || !!prior?.contents,
    });
    return info;
  }
  async directories(relative: string, allowMissing = true): Promise<boolean> {
    if (!path.isAbsolute(this.root) || path.resolve(this.root) !== this.root)
      throw Error("Недопустимый канонический путь проекта");
    const destination = path.join(this.root, relative);
    let cursor = path.parse(destination).root;
    for (const part of destination.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      const info = await this.stat(cursor);
      if (!info && allowMissing && cursor.startsWith(this.root + path.sep))
        return false;
      if (!info?.isDirectory() || info.isSymbolicLink())
        throw Error(
          "Ожидался обычный каталог истории; символические ссылки запрещены",
        );
    }
    if ((await realpath(this.root)) !== this.root) throw changed();
    assertReadActive();
    return true;
  }
  async verify(destination?: string) {
    for (const [file, prior] of this.identities) {
      // During one file read verify its own ancestry; a final full pass also
      // verifies all earlier siblings. This keeps filesystem IO linear in tree size.
      if (
        destination &&
        file !== destination &&
        !destination.startsWith(file + path.sep)
      )
        continue;
      assertReadActive();
      let current: Stats | undefined;
      try {
        current = await lstat(file);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (
        !current !== !prior.info ||
        (current &&
          prior.info &&
          !(prior.contents || !current.isDirectory()
            ? sameFile(current, prior.info)
            : sameIdentity(current, prior.info)))
      )
        throw changed();
    }
    assertReadActive();
  }
  async children(relative: string): Promise<string[]> {
    const folder = path.join(this.root, relative);
    await this.stat(folder, true);
    await this.verify(folder);
    const handle = await opendir(folder);
    const names: string[] = [];
    try {
      for await (const child of handle) {
        assertReadActive();
        if (names.length >= HISTORY_MAX_ENTRIES)
          throw Error("Каталог истории превышает лимит 2048 элементов");
        names.push(child.name);
      }
    } finally {
      if ((handle as { path?: string }).path)
        await handle.close().catch(() => {});
    }
    await this.verify(folder);
    return names.sort();
  }
  async read(relative: string): Promise<string> {
    if (!(await this.directories(path.dirname(relative))))
      throw Error("Файл истории не найден");
    const file = path.join(this.root, relative),
      initial = await this.stat(file);
    if (!initial) throw Error("Файл истории не найден");
    regular(relative, initial);
    await this.verify(file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      assertReadActive();
      const actual = await handle.stat();
      if (!sameFile(initial, actual)) throw changed();
      regular(relative, actual);
      const bytes = Buffer.alloc(
        Math.min(actual.size + 1, HISTORY_MAX_BYTES + 1),
      );
      let length = 0;
      while (length < bytes.length) {
        assertReadActive();
        const next = await handle.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      assertReadActive();
      const after = await handle.stat();
      await this.verify(file);
      if (!sameFile(actual, after) || length !== actual.size) throw changed();
      supported(relative, length);
      return text(bytes.subarray(0, length));
    } finally {
      await handle.close();
    }
  }
}
async function directoryNames(root: string, relative: string, years: boolean) {
  const fs = new FilesystemRead(root);
  if (!(await fs.directories(relative))) {
    await fs.verify();
    return [];
  }
  const names: string[] = [];
  for (const name of await fs.children(relative)) {
    if (
      !(years ? historyYearSchema : historyEntrySchema).safeParse(name).success
    )
      continue;
    const info = await fs.stat(path.join(root, relative, name));
    if (info?.isDirectory() && !info.isSymbolicLink()) names.push(name);
  }
  await fs.verify();
  return years ? names.sort().reverse() : names.sort();
}
export const listHistoryYears = (root: string) =>
  withHistoryRead(() => directoryNames(root, ".goga/history", true));
export const listHistoryEntries = (root: string, year: string) =>
  withHistoryRead(() =>
    directoryNames(
      root,
      `.goga/history/${historyYearSchema.parse(year)}`,
      false,
    ),
  );

async function workingArtifacts(
  fs: FilesystemRead,
  base: string,
): Promise<HistoryArtifact[]> {
  if (!(await fs.directories(base))) {
    await fs.verify();
    return [];
  }
  const result: HistoryArtifact[] = [];
  let visited = 0;
  const visit = async (relative: string, prefix: string) => {
    for (const name of await fs.children(relative)) {
      assertReadActive();
      if (++visited > HISTORY_MAX_ENTRIES)
        throw Error("История превышает лимит 2048 элементов");
      if (!historyEntrySchema.safeParse(name).success) continue;
      const artifactPath = prefix ? `${prefix}/${name}` : name;
      if (artifactPath.split("/").length > HISTORY_MAX_DEPTH)
        throw Error("Глубина истории превышает лимит 16");
      const item = `${relative}/${name}`,
        info = await fs.stat(path.join(fs.root, item));
      if (!info) throw changed();
      if (info.isDirectory() && !info.isSymbolicLink()) {
        result.push({ path: artifactPath, kind: "directory", readable: false });
        await fs.directories(item, false);
        await visit(item, artifactPath);
      } else {
        let reason: string | undefined;
        try {
          // Tree enumeration is metadata-only. Decode only an explicitly opened file.
          regular(item, info);
        } catch (error) {
          if (!(error instanceof Unreadable)) throw error;
          reason = error.message;
        }
        result.push({
          path: artifactPath,
          kind: "file",
          readable: !reason,
          ...(reason ? { reason } : {}),
          ...(info.isFile() ? { size: info.size } : {}),
        });
      }
    }
  };
  await visit(base, "");
  await fs.verify();
  return result.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

export interface HistoryTopicSource {
  projectId: string;
  owner?: TopicContextRef;
  target: TopicTarget;
  gitEnv?: NodeJS.ProcessEnv;
}
interface TreeEntry {
  name: string;
  mode: string;
  kind: string;
  oid: string;
  size: number;
}
class CommittedRead {
  constructor(
    readonly root: string,
    readonly env?: NodeJS.ProcessEnv,
  ) {}
  async git(args: string[], maxBuffer = HISTORY_MAX_BYTES): Promise<Buffer> {
    assertReadActive();
    try {
      const { stdout } = await execute(
        "git",
        [
          "--no-optional-locks",
          "--no-replace-objects",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        {
          cwd: this.root,
          // Object reads in partial clones must never lazily fetch missing
          // promisor objects (network + writes). Deny every transport as a
          // fallback for older Git versions that ignore GIT_NO_LAZY_FETCH.
          // Apply last so inherited or explicitly supplied env cannot enable it.
          env: childEnvironment(
            process.env,
            {},
            {
              ...this.env,
              GIT_NO_LAZY_FETCH: "1",
              GIT_ALLOW_PROTOCOL: "",
            },
          ),
          encoding: "buffer",
          maxBuffer,
          timeout: 30000,
          signal: readSignal(),
          killSignal: "SIGKILL",
        },
      );
      assertReadActive();
      return stdout;
    } catch (error) {
      assertReadActive();
      // Git stderr can include arbitrary repository contents or local paths.
      throw Error(
        "Не удалось прочитать историю Git: ветка отсутствует, ответ слишком велик или превышен срок чтения.",
      );
    }
  }
  async stamp(target: TopicTarget) {
    const full = `${target.remote ? "refs/remotes/" : "refs/heads/"}${target.branch}`;
    await this.git(["check-ref-format", full]);
    const raw = text(
      await this.git([
        "for-each-ref",
        "--format=%(refname) %(objectname) %(symref)",
        full,
      ]),
    );
    const matches = raw
      .split("\n")
      .filter((line) => line.split(" ")[0] === full);
    const [, commit, symbolic] = matches[0]?.split(" ") ?? [];
    if (
      matches.length !== 1 ||
      !commit ||
      !/^[a-f0-9]{40,64}$/.test(commit) ||
      symbolic
    )
      throw Error("Ветка отсутствует или неоднозначна. Обновите каталог.");
    const current = text(await this.git(["branch", "--show-current"])).trim();
    const head = text(
      await this.git(["rev-parse", "--verify", "HEAD^{commit}"]),
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw changed();
    return { commit, current, head };
  }
  async tree(object: string, relative?: string): Promise<TreeEntry[]> {
    const bytes = await this.git([
      "ls-tree",
      "-l",
      "-z",
      object,
      ...(relative ? ["--", relative] : []),
    ]);
    // ls-tree is NUL framed, unlike text documents; decode UTF-8 without control filtering.
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw Error("Некорректные имена файлов в дереве Git");
    }
    if (!raw) return [];
    const rows = raw.split("\0");
    if (rows.pop() !== "" || rows.length > HISTORY_MAX_ENTRIES)
      throw Error("Дерево Git превышает лимит 2048 элементов");
    const result = rows.map((row) => {
      const match =
        /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64}) +(-|\d+)\t(.+)$/.exec(
          row,
        );
      if (!match) throw Error("Некорректное дерево истории Git");
      return {
        mode: match[1]!,
        kind: match[2]!,
        oid: match[3]!,
        size: match[4] === "-" ? 0 : Number(match[4]),
        name: match[5]!,
      };
    });
    if (new Set(result.map((row) => row.name)).size !== result.length)
      throw Error("Неоднозначное дерево Git");
    return result;
  }
  async locate(
    commit: string,
    relative: string,
    directory: boolean,
  ): Promise<TreeEntry | undefined> {
    const parts = relative.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("/"),
        rows = await this.tree(commit, name);
      if (rows.length === 0) return undefined;
      if (rows.length !== 1 || rows[0]!.name !== name) throw changed();
      const node = rows[0]!;
      if (i < parts.length || directory) {
        if (node.mode !== "040000" || node.kind !== "tree")
          throw Error("Ссылки и нестандартные каталоги Git запрещены");
      } else this.regular(node);
      if (i === parts.length) return node;
    }
    return undefined;
  }
  regular(node: TreeEntry) {
    if (!["100644", "100755"].includes(node.mode) || node.kind !== "blob")
      throw new Unreadable("Ссылки и нестандартные объекты Git запрещены");
    supported(node.name, node.size);
  }
  async blob(node: TreeEntry) {
    this.regular(node);
    const bytes = await this.git(
      ["cat-file", "blob", node.oid],
      HISTORY_MAX_BYTES + 1,
    );
    if (bytes.length !== node.size) throw changed();
    return text(bytes);
  }
  async artifacts(commit: string, base: string): Promise<HistoryArtifact[]> {
    const entry = await this.locate(commit, base, true);
    if (!entry) return [];
    const result: HistoryArtifact[] = [];
    let visited = 0;
    const visit = async (oid: string, prefix: string) => {
      for (const node of await this.tree(oid)) {
        assertReadActive();
        if (++visited > HISTORY_MAX_ENTRIES)
          throw Error("История превышает лимит 2048 элементов");
        if (!historyEntrySchema.safeParse(node.name).success) continue;
        const name = prefix ? `${prefix}/${node.name}` : node.name;
        if (name.split("/").length > HISTORY_MAX_DEPTH)
          throw Error("Глубина истории превышает лимит 16");
        if (node.mode === "040000" && node.kind === "tree") {
          result.push({ path: name, kind: "directory", readable: false });
          await visit(node.oid, name);
        } else {
          let reason: string | undefined;
          try {
            // Do not spawn a blob read for every entry in the tree.
            this.regular(node);
          } catch (error) {
            if (!(error instanceof Unreadable)) throw error;
            reason = error.message;
          }
          result.push({
            path: name,
            kind: "file",
            readable: !reason,
            ...(reason ? { reason } : {}),
            ...(node.kind === "blob" ? { size: node.size } : {}),
          });
        }
      }
    };
    await visit(entry.oid, "");
    return result.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }
}
async function readEntry<T>(
  root: string,
  year: string,
  entry: string,
  source: HistoryTopicSource | undefined,
  working: (fs: FilesystemRead, base: string) => Promise<T>,
  committed: (git: CommittedRead, commit: string, base: string) => Promise<T>,
) {
  const base = entryPath(year, entry),
    fs = new FilesystemRead(root);
  await fs.directories("", false);
  if (!source) {
    const result = await working(fs, base);
    await fs.verify();
    return result;
  }
  const target = topicTargetSchema.parse(source.target);
  if (
    target.topic !== entry ||
    (source.owner &&
      (source.owner.projectId !== source.projectId ||
        source.owner.year !== year ||
        source.owner.topic !== entry ||
        source.owner.branch !== target.branch ||
        target.remote))
  )
    throw Error("История относится к другому контексту топика.");
  const git = new CommittedRead(root, source.gitEnv),
    before = await git.stamp(target);
  if (
    source.owner &&
    (before.current !== target.branch ||
      target.branch
        .toLowerCase()
        .replace(/[^\x00-\x7f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") !== entry)
  )
    throw changed();
  const result = source.owner
    ? await working(fs, base)
    : await committed(git, before.commit, base);
  if (JSON.stringify(before) !== JSON.stringify(await git.stamp(target)))
    throw changed();
  await fs.verify();
  assertReadActive();
  return result;
}
export function listHistoryArtifacts(
  root: string,
  year: string,
  entry: string,
  source?: HistoryTopicSource,
) {
  return withHistoryRead(() =>
    readEntry(
      root,
      year,
      entry,
      source,
      workingArtifacts,
      (git, commit, base) => git.artifacts(commit, base),
    ),
  );
}
export function readHistoryArtifact(
  root: string,
  year: string,
  entry: string,
  artifact: string,
  source?: HistoryTopicSource,
) {
  return withHistoryRead(async () => {
    const relative = historyPathSchema.parse(artifact);
    return readEntry(
      root,
      year,
      entry,
      source,
      async (fs, base) =>
        document(`${base}/${relative}`, await fs.read(`${base}/${relative}`)),
      async (git, commit, base) => {
        const full = `${base}/${relative}`,
          node = await git.locate(commit, full, false);
        if (!node) throw Error("Файл истории не найден в выбранной ветке");
        return document(full, await git.blob(node));
      },
    );
  });
}
