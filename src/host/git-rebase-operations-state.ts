import {
  readApplyOperation,
  validateApplyMetadata,
} from "./git-rebase-apply-state";
import { contentProof } from "./git-rebase-continue-state";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitCommitContext } from "./git-workspace-actions";
import {
  assertStoppedRebaseOwnership,
  directory,
  hash,
  identity,
  metadata,
  regular,
  safe,
  stale,
  stat,
  type File,
  type StoppedRebaseConflictBinding,
} from "./git-conflict-state";
import { gitFilePathSchema } from "../shared/git-workspace";
import { readRebaseBinding } from "./git-rebase-read-binding";
import { CommandExitError } from "./process";

export interface GitRebaseOperationContext extends GitCommitContext {
  readonly stoppedRebase?: StoppedRebaseConflictBinding;
  /** Physical owner/settings/catalog check, allowing only the intended operation change. */
  verifyOwner(): Promise<void>;
  /** Narrow final check for a newly stopped continuation of the captured owner. */
  verifyNextRebase?(): Promise<void>;
  /** Captured physical owner/catalog/settings pins; no re-admission. */
  assertPublicationOwner?(): void;
  /** Host capability: no ambient Git config, attributes, namespace or editor. */
  isolatedGit(args: string[]): Promise<{ stdout: string; stderr: string }>;
}
export const unsupported = () =>
  Error(
    "Неподдерживаемое состояние rebase: отмена требует подтверждённого исходного конфликта без посторонних правок, продолжение — разрешённый линейный rebase --merge/--apply в установленных пределах. Для --apply требуется отдельно подтверждённая последовательность патчей.",
  );
export const args = (
  root: string,
  command: string[],
  gitdir = path.join(root, ".git"),
) => [
  ...safe,
  `--git-dir=${gitdir}`,
  `--work-tree=${root}`,
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "rerere.enabled=false",
  "-c",
  "rerere.autoupdate=false",
  "-c",
  "rebase.autoStash=false",
  "-c",
  "rebase.updateRefs=false",
  ...command,
];
export const run = async (c: GitRebaseOperationContext, command: string[]) =>
  (await c.isolatedGit(args(c.root, command))).stdout;
const oid = (value: string) => {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw unsupported();
  return value;
};
export interface Entry {
  mode: string;
  oid: string;
}
export type Tree = Record<string, Entry>;
export interface RawState {
  paths: [string, string][];
  files: Record<string, File>;
  metadata: string;
  index: File;
}
/** Bounded no-follow inventory includes ignored and untracked files. Directories
 * are identity-pinned, not mtime-pinned (native checkout changes parent mtimes). */
export function raw(
  root: string,
  ignoredLocks: readonly string[] = [],
): RawState {
  const paths: [string, string][] = [
    [root, directory(root)],
    [path.join(root, ".git"), directory(path.join(root, ".git"))],
  ];
  const files: Record<string, File> = Object.create(null);
  let count = 0,
    bytes = 0;
  const visit = (dir: string, prefix: string, depth: number) => {
    if (depth > 24) throw unsupported();
    for (const n of readdirSync(dir).sort()) {
      if (!prefix && n === ".git") continue;
      if (
        n.toLowerCase() === ".git" ||
        n.toLowerCase() === ".gitattributes" ||
        ++count > 10000
      )
        throw unsupported();
      const name = prefix ? `${prefix}/${n}` : n;
      gitFilePathSchema.parse(name);
      const filename = path.join(root, name),
        s = stat(filename)!;
      if (s.isDirectory()) {
        paths.push([filename, directory(filename)]);
        visit(filename, name, depth + 1);
      } else {
        const f = regular(filename, 1024 * 1024)!;
        bytes += f.bytes.length;
        if (bytes > 32 * 1024 * 1024) throw unsupported();
        files[name] = f;
      }
    }
  };
  visit(root, "", 0);
  const index = regular(path.join(root, ".git/index"));
  if (!index) throw stale();
  const ignored = new Set(ignoredLocks.map((n) => path.join(root, ".git", n)));
  const captured: [string, string][] = JSON.parse(metadata(root));
  // This operation's admission rejects bisect too. Keep its absence pinned
  // through native execution and final publication, including primary owners.
  const bisect = path.join(root, ".git/BISECT_START");
  captured.push([bisect, regular(bisect)?.identity ?? "missing"]);
  return {
    paths,
    files,
    index,
    metadata: JSON.stringify(captured.filter(([n]) => !ignored.has(n))),
  };
}
export const rawKey = (s: RawState) =>
  hash(
    JSON.stringify([
      s.paths,
      Object.entries(s.files).map(([n, f]) => [n, f.identity]),
      s.index.identity,
      s.metadata,
    ]),
  );
export function assertPaths(s: RawState) {
  for (const [p, id] of s.paths) if (directory(p) !== id) throw stale();
}
export async function readTree(
  c: GitRebaseOperationContext,
  object: string,
): Promise<Tree> {
  const rows = (await run(c, ["ls-tree", "-r", "-z", oid(object)]))
      .split("\0")
      .filter(Boolean),
    result: Tree = Object.create(null);
  if (rows.length > 4096) throw unsupported();
  for (const row of rows) {
    const m =
      /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([\s\S]+)$/.exec(
        row,
      );
    if (!m) throw unsupported();
    const name = gitFilePathSchema.parse(m[3]);
    if (name.split("/").some((part) => part.toLowerCase() === ".gitattributes"))
      throw Error(
        "Attributes в текущем или ORIGINAL дереве пока не поддерживаются безопасной отменой.",
      );
    result[name] = { mode: m[1], oid: m[2] };
  }
  return result;
}
export async function blob(c: GitRebaseOperationContext, object: string) {
  const b = Buffer.from(await run(c, ["cat-file", "blob", oid(object)]));
  // Runner text transport is not a binary capability. Never accept a lossy decode.
  if (
    b.length > 1024 * 1024 ||
    identity(b, object.length) !== object ||
    b.includes(0)
  )
    throw unsupported();
  return b;
}
const same = (a?: Entry, b?: Entry) => JSON.stringify(a) === JSON.stringify(b);
export const matches = (file: File | undefined, entry: Entry | undefined) =>
  !entry
    ? !file
    : !!file &&
      identity(file.bytes, entry.oid.length) === entry.oid &&
      file.mode === (entry.mode === "100755" ? 0o755 : 0o644);
export interface RebaseState {
  backend: "merge" | "apply";
  root: string;
  owner: string;
  scope: string;
  revision: string;
  branch: string;
  head: string;
  original: string;
  stopped: string;
  proof: string;
  ownership: string;
  policy: string;
  stages: string;
  disk: RawState;
  auto: Tree;
  originalTree: Tree;
  operationFiles: Record<string, File>;
  operationDirectory: string;
  resolutionPaths: string[];
}
export const stateKey = (s: RebaseState) =>
  hash(
    JSON.stringify([
      s.root,
      s.owner,
      s.scope,
      s.revision,
      s.branch,
      s.head,
      s.original,
      s.stopped,
      s.proof,
      s.ownership,
      s.policy,
      s.stages,
      rawKey(s.disk),
    ]),
  );

/** Resolve existing components physically, not by guessed case folding. A new
 * component has no filesystem identity to inspect: this slice admits ASCII only
 * and conservatively rejects future file/directory spelling ambiguities. */
export function assertOriginalTargets(s: RebaseState) {
  const directories = new Map(s.disk.paths);
  const future = new Map<string, { spelling: string; directory: boolean }>();
  for (const name of Object.keys(s.originalTree)) {
    const parts = name.split("/");
    let parent = s.root,
      parentKey = directories.get(s.root)!;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i],
        candidate = path.join(parent, part),
        relative = parts.slice(0, i + 1).join("/"),
        isDirectory = i < parts.length - 1;
      const info = stat(candidate);
      if (info) {
        if (isDirectory) {
          const expected = directories.get(candidate);
          if (!expected || directory(candidate) !== expected)
            throw Error(
              "ORIGINAL каталог имеет неподтверждённый физический alias. Отмена запрещена.",
            );
          parentKey = expected;
        } else if (
          !s.auto[name] ||
          !s.disk.files[name] ||
          regular(candidate)?.identity !== s.disk.files[name].identity
        ) {
          throw Error(
            "ORIGINAL файл пересекается с пользовательским файлом или физическим alias. Отмена запрещена.",
          );
        }
      } else {
        if (/[^\x00-\x7f]/.test(part))
          throw Error(
            "Новые non-ASCII компоненты ORIGINAL пока не поддерживаются: без записи нельзя подтвердить отсутствие Unicode aliases.",
          );
        const key = `${parentKey}\0${part.toLowerCase()}`,
          previous = future.get(key);
        if (
          previous &&
          (previous.spelling !== relative || previous.directory !== isDirectory)
        )
          throw Error(
            "Неоднозначные будущие ORIGINAL пути (file/directory/case aliases). Отмена запрещена.",
          );
        future.set(key, { spelling: relative, directory: isDirectory });
        parentKey = `future:${key}`;
      }
      parent = candidate;
    }
  }
}

/** Metadata-only projection: no original blob contents, checkout, or filters. */
async function assertProjectedBounds(
  c: GitRebaseOperationContext,
  s: RebaseState,
) {
  const sizes = new Map<string, number>();
  for (const row of (await run(c, ["ls-tree", "-r", "-l", "-z", s.original]))
    .split("\0")
    .filter(Boolean)) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?) +([0-9]+)\t([\s\S]+)$/.exec(
        row,
      );
    if (!match) throw unsupported();
    const name = gitFilePathSchema.parse(match[4]),
      size = Number(match[3]),
      expected = s.originalTree[name];
    if (
      !expected ||
      expected.mode !== match[1] ||
      expected.oid !== match[2] ||
      sizes.has(name) ||
      !Number.isSafeInteger(size) ||
      size > 1024 * 1024
    )
      throw Error(
        "Будущее ORIGINAL дерево превышает поддерживаемый предел файла 1 МиБ или изменилось.",
      );
    sizes.set(name, size);
  }
  if (sizes.size !== Object.keys(s.originalTree).length) throw stale();
  const directories = new Set(
    s.disk.paths
      .map(([p]) => path.relative(s.root, p))
      .filter((p) => p && p !== ".git"),
  );
  const files = new Map(
    Object.entries(s.disk.files)
      .filter(([n]) => !s.auto[n])
      .map(([n, f]) => [n, f.bytes.length]),
  );
  for (const [name, size] of sizes) {
    const parts = name.split("/");
    if (parts.length - 1 > 24)
      throw Error(
        "Будущее ORIGINAL дерево превышает поддерживаемую глубину 24 каталогов.",
      );
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join("/"));
    files.set(name, size);
  }
  if (
    directories.size + files.size > 10000 ||
    [...files.values()].reduce((a, b) => a + b, 0) > 32 * 1024 * 1024
  )
    throw Error(
      "Будущее ORIGINAL дерево вместе с сохраняемыми файлами превышает предел 10000 записей или 32 МиБ.",
    );
}
export function readOperation(root: string) {
  if (stat(path.join(root, ".git/rebase-apply")))
    return readApplyOperation(root);
  const gd = path.join(root, ".git"),
    base = path.join(gd, "rebase-merge");
  if (!stat(base) || stat(path.join(gd, "rebase-apply"))) throw unsupported();
  const directoryIdentity = directory(base),
    files: Record<string, File> = Object.create(null);
  const required = [
    "head-name",
    "orig-head",
    "onto",
    "stopped-sha",
    "msgnum",
    "end",
    "done",
    "git-rebase-todo",
    "git-rebase-todo.backup",
    "author-script",
    "message",
    "patch",
    "interactive",
    "drop_redundant_commits",
    "no-reschedule-failed-exec",
  ];
  const allowed = new Set([...required, "rewritten-list"]);
  for (const n of readdirSync(base)) {
    if (!allowed.has(n)) throw unsupported();
    files[`rebase-merge/${n}`] = regular(path.join(base, n), 1024 * 1024)!;
  }
  if (required.some((n) => !files[`rebase-merge/${n}`])) throw unsupported();
  const text = (n: string) => files[`rebase-merge/${n}`].bytes.toString("utf8");
  for (const n of [
    "interactive",
    "drop_redundant_commits",
    "no-reschedule-failed-exec",
  ])
    if (text(n) !== "") throw unsupported();
  const picks = (value: string) =>
    value
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const m = /^pick ([a-f0-9]{40}(?:[a-f0-9]{24})?)(?: [^\0\r]*)?$/.exec(
          l,
        );
        if (!m) throw unsupported();
        return m[1];
      });
  const commands = [...picks(text("done")), ...picks(text("git-rebase-todo"))];
  if (
    JSON.stringify(picks(text("git-rebase-todo.backup"))) !==
      JSON.stringify(commands) ||
    commands.length > 128
  )
    throw unsupported();
  const branch = /^refs\/heads\/([^\0\r\n]+)\n$/.exec(text("head-name"))?.[1];
  if (!branch) throw unsupported();
  for (const n of ["AUTO_MERGE", "REBASE_HEAD", "MERGE_MSG", "ORIG_HEAD"]) {
    const f = regular(path.join(gd, n));
    if (!f) throw unsupported();
    files[n] = f;
  }
  return {
    backend: "merge" as const,
    files,
    directoryIdentity,
    text,
    branch,
    commands,
  };
}
/** Proof of the native baseline and explicit conflict-resolution destinations.
 * Only ordinary same-path three-stage content conflicts are admitted. Other
 * files must be trivial native three-way outcomes; complex/rename cases refuse. */
async function baseline(
  c: GitRebaseOperationContext,
  s: RebaseState,
  headTree: Tree,
  sourceTree: Tree,
  baseTree: Tree,
) {
  const stages = new Map<string, Map<number, Entry>>();
  for (const row of s.stages.split("\0").filter(Boolean)) {
    const m =
      /^(100644|100755) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0123])\t([\s\S]+)$/.exec(
        row,
      );
    if (!m) throw unsupported();
    const n = gitFilePathSchema.parse(m[4]),
      map = stages.get(n) ?? new Map();
    if (map.has(Number(m[3]))) throw unsupported();
    map.set(Number(m[3]), { mode: m[1], oid: m[2] });
    stages.set(n, map);
  }
  const names = new Set([
    ...Object.keys(s.auto),
    ...stages.keys(),
    ...Object.keys(headTree),
    ...Object.keys(sourceTree),
    ...Object.keys(baseTree),
  ]);
  let conflictCount = 0;
  const short = (await run(c, ["rev-parse", "--short", s.stopped])).trim();
  const subject = (
    await run(c, ["show", "-s", "--format=%s", s.stopped])
  ).replace(/\n$/, "");
  if (!/^[a-f0-9]+$/.test(short) || /[\0\r\n]/.test(subject))
    throw unsupported();
  for (const n of names) {
    const entries = stages.get(n),
      a = s.auto[n],
      ours = headTree[n],
      theirs = sourceTree[n],
      base = baseTree[n];
    const nontrivial =
      !same(ours, base) && !same(theirs, base) && !same(ours, theirs);
    if (nontrivial || (entries?.size === 3 && !entries.has(0))) {
      if (
        !base ||
        !ours ||
        !theirs ||
        !a ||
        new Set([base.mode, ours.mode, theirs.mode, a.mode]).size !== 1
      )
        throw unsupported();
      const unmerged =
        entries?.size === 3 &&
        !entries.has(0) &&
        same(entries.get(1), base) &&
        same(entries.get(2), ours) &&
        same(entries.get(3), theirs);
      const resolved =
        entries?.size === 1 &&
        entries.has(0) &&
        entries.get(0)!.mode === a.mode;
      if (!unmerged && !resolved) throw unsupported();
      const file = s.disk.files[n];
      if (
        !file ||
        file.mode !== (a.mode === "100755" ? 0o755 : 0o644) ||
        file.bytes.length > 1024 * 1024 ||
        file.bytes.includes(0) ||
        !Buffer.from(file.bytes.toString("utf8")).equals(file.bytes)
      )
        throw unsupported();
      if (resolved) await blob(c, entries!.get(0)!.oid);
      // merge-file is Git's native content merge, never shell or an external driver.
      // Temporary inputs are not a clone/worktree and never touch source metadata.
      const temp = await fs.mkdtemp(
        path.join(os.tmpdir(), "goga-rebase-baseline-"),
      );
      try {
        await fs.chmod(temp, 0o700);
        for (const [name, e] of [
          ["ours", ours],
          ["base", base],
          ["theirs", theirs],
        ] as const)
          await fs.writeFile(path.join(temp, name), await blob(c, e.oid), {
            mode: 0o600,
            flag: "wx",
          });
        let merged: string,
          conflict = false;
        try {
          merged = (
            await c.isolatedGit(
              args(c.root, [
                "-c",
                "merge.conflictStyle=merge",
                "merge-file",
                s.backend === "apply"
                  ? "--diff-algorithm=myers"
                  : "--diff-algorithm=histogram",
                "--stdout",
                "-L",
                "HEAD",
                "-L",
                "base",
                "-L",
                s.backend === "apply" ? subject : `${short} (${subject})`,
                path.join(temp, "ours"),
                path.join(temp, "base"),
                path.join(temp, "theirs"),
              ]),
            )
          ).stdout;
        } catch (e) {
          if (
            !(e instanceof CommandExitError) ||
            e.exitCode === null ||
            e.exitCode < 1 ||
            e.exitCode > 127
          )
            throw e;
          merged = e.stdout;
          conflict = true;
        }
        if (!conflict || identity(Buffer.from(merged), a.oid.length) !== a.oid)
          throw Error(
            "Исходный native conflict baseline не подтверждён. Отмена запрещена.",
          );
        conflictCount++;
        if (resolved || !matches(file, a)) s.resolutionPaths.push(n);
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    } else {
      if (!same(ours, base) && !same(theirs, base) && !same(ours, theirs))
        throw Error(
          "Неподтверждённый нетривиальный исходный baseline. Отмена запрещена.",
        );
      const expected = same(ours, base) ? theirs : ours;
      if (
        !matches(s.disk.files[n], a) ||
        !same(a, expected) ||
        (a ? entries?.size !== 1 || !same(entries.get(0), a) : !!entries)
      )
        throw Error(
          "Индекс или исходный baseline изменён; сохранность посторонних правок не подтверждена.",
        );
    }
  }
  if (!conflictCount) throw unsupported();
  // The current slice pins existing directories through publication. A native
  // checkout which removes their last tracked file is therefore refused before
  // mutation, rather than producing an inevitable partially-completed abort.
  const originalNames = Object.keys(s.originalTree);
  for (const n of Object.keys(s.auto)) {
    const parts = n.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (!originalNames.some((value) => value.startsWith(`${parent}/`)))
        throw Error(
          "Удаление существующего каталога при отмене пока не поддерживается.",
        );
    }
  }
  // Refuse D/F transitions, including empty untracked directories: a raw file
  // inventory alone cannot prove that deleting a directory is authorized.
  for (const n of Object.keys(s.originalTree)) {
    if (stat(path.join(c.root, n))?.isDirectory())
      throw Error(
        "ORIGINAL файл пересекается с пользовательским каталогом. Отмена запрещена.",
      );
    for (const a of Object.keys(s.auto))
      if (n.startsWith(`${a}/`) || a.startsWith(`${n}/`)) throw unsupported();
  }
  // ORIGINAL may introduce files from later commits, not present in this conflict.
  for (const n of Object.keys(s.originalTree))
    for (const other of Object.keys(s.disk.files))
      if (
        !s.auto[other] &&
        (other === n || other.startsWith(`${n}/`) || n.startsWith(`${other}/`))
      )
        throw Error(
          "ORIGINAL дерево пересекается с неотслеживаемыми/игнорируемыми данными. Отмена запрещена.",
        );
}
export async function capture(
  c: GitRebaseOperationContext,
  revision: string,
  action: "abort" | "continue" = "abort",
): Promise<RebaseState> {
  await c.verify();
  assertStoppedRebaseOwnership(c.stoppedRebase);
  const disk = raw(c.root),
    op = readOperation(c.root),
    gd = path.join(c.root, ".git"),
    ref = `refs/heads/${op.branch}`;
  if (typeof c.scope !== "string" && c.scope.branch !== op.branch)
    throw stale();
  await run(c, ["check-ref-format", ref]);
  for (const n of [
    "index.lock",
    "HEAD.lock",
    "config.lock",
    "packed-refs.lock",
    `${ref}.lock`,
  ])
    if (stat(path.join(gd, n)))
      throw Error("Репозиторий занят другой операцией Git.");
  // Ref must be direct, not an alias to a same-OID external branch. Packed owner
  // refs are supported only with an existing ordinary parent directory.
  directory(path.dirname(path.join(gd, ref)));
  const ownerRef = regular(path.join(gd, ref));
  if (
    ownerRef &&
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n$/.test(ownerRef.bytes.toString())
  )
    throw unsupported();
  if (
    stat(path.join(gd, "config.worktree")) ||
    stat(path.join(gd, "info/attributes"))
  )
    throw unsupported();
  const policy = await run(c, [
    "config",
    "--local",
    "--no-includes",
    "--null",
    "--list",
  ]);
  for (const row of policy.split("\0").filter(Boolean)) {
    const at = row.indexOf("\n"),
      key = (at < 0 ? row : row.slice(0, at)).toLowerCase(),
      value = at < 0 ? "" : row.slice(at + 1).toLowerCase();
    if (
      /^(filter|include|includeif|merge|rebase|extensions)\./.test(key) ||
      (op.backend === "apply" &&
        /^(format|am|apply|mailinfo|mailmap|diff|log|i18n)\./.test(key)) ||
      (op.backend === "apply" &&
        key === "core.quotepath" &&
        value !== "true") ||
      [
        "core.attributesfile",
        "core.worktree",
        "core.alternaterefscommand",
        "core.sparsecheckout",
        "core.sparsecheckoutcone",
      ].includes(key) ||
      (key === "core.autocrlf" && value !== "false") ||
      (key === "core.eol" && !["lf", "native"].includes(value))
    )
      throw Error(
        "Неподдерживаемая конфигурация/filters/attributes безопасной отмены rebase.",
      );
  }
  const proof = await readRebaseBinding(
    { path: c.root, gitCommonDir: gd, branch: op.branch },
    (a) => run(c, a),
  );
  const head = oid(regular(path.join(gd, "HEAD"))!.bytes.toString().trim()),
    original = oid(op.text("orig-head").trim()),
    stopped = oid(op.text("stopped-sha").trim());
  if (op.commands.at(-1) !== original) throw unsupported();
  let previous: string | undefined;
  for (const commit of op.commands) {
    const parents = (
      await run(c, ["rev-list", "--parents", "--max-count=1", commit])
    )
      .trim()
      .split(" ");
    if (
      parents.length !== 2 ||
      parents[0] !== commit ||
      (previous && parents[1] !== previous)
    )
      throw unsupported();
    previous = commit;
  }
  const commit = await run(c, ["cat-file", "commit", stopped]),
    author = /^author (.+) <([^<>\r\n]+)> ([0-9]+) ([+-][0-9]{4})$/m.exec(
      commit,
    );
  if (!author) throw unsupported();
  const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const expected = `GIT_AUTHOR_NAME=${quote(author[1])}\nGIT_AUTHOR_EMAIL=${quote(author[2])}\nGIT_AUTHOR_DATE=${quote(`@${author[3]} ${author[4]}`)}\n`;
  if (op.backend === "merge" && op.text("author-script") !== expected)
    throw Error("Неподтверждённый author-script: отмена не выполнялась.");
  const apply =
    op.backend === "apply" ? await validateApplyMetadata(c, op) : undefined;
  const auto = apply
      ? (
          await contentProof(
            c,
            await readTree(c, head),
            apply.base,
            apply.source,
            new Map(),
            "apply",
          )
        ).tree
      : await readTree(c, oid(op.files.AUTO_MERGE.bytes.toString().trim())),
    originalTree = await readTree(c, original),
    headTree = await readTree(c, head),
    sourceTree = await readTree(c, stopped);
  const parent = /^parent ([a-f0-9]+)$/m.exec(commit)?.[1];
  if (!parent) throw unsupported();
  const baseTree = await readTree(c, parent);
  const stages = await run(c, ["ls-files", "--stage", "-z"]);
  if (
    (await run(c, ["ls-files", "-v", "-z"]))
      .split("\0")
      .some((r) => /^[a-zS] /.test(r))
  )
    throw unsupported();
  const snapshot = await c.snapshot();
  if (
    snapshot.revision !== revision ||
    snapshot.head !== head ||
    snapshot.branch !== null ||
    snapshot.operation !== "rebase"
  )
    throw stale();
  const state: RebaseState = {
    backend: op.backend,
    root: c.root,
    owner: c.ownerKey,
    scope: JSON.stringify(c.scope),
    revision,
    branch: op.branch,
    head,
    original,
    stopped,
    proof,
    ownership: JSON.stringify(c.stoppedRebase?.ownership ?? []),
    policy,
    stages,
    disk,
    auto,
    originalTree,
    operationFiles: op.files,
    operationDirectory: op.directoryIdentity,
    resolutionPaths: [],
  };
  if (action === "abort") {
    assertOriginalTargets(state);
    await assertProjectedBounds(c, state);
    await baseline(c, state, headTree, sourceTree, baseTree);
  }
  await c.verify();
  assertStoppedRebaseOwnership(c.stoppedRebase);
  if (
    rawKey(raw(c.root)) !== rawKey(disk) ||
    c.ownerKey !== state.owner ||
    JSON.stringify(c.scope) !== state.scope
  )
    throw stale();
  return state;
}
