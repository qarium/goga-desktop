import { createHash } from "node:crypto";
import {
  constants,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  readdirSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import { gitFilePathSchema } from "../shared/git-workspace";
import { CommandExitError } from "./process";
/** Host-only proof minted after physical owner and stopped linear rebase validation.
 * It is never part of an IPC request and never grants ordinary detached admission. */
export interface StoppedRebaseConflictBinding {
  readonly kind: "stopped-linear-rebase";
  readonly proof: string;
  readonly head: string;
  readonly ownership: readonly (readonly [string, string])[];
}
export interface ConflictStateContext {
  readonly stoppedRebase?: StoppedRebaseConflictBinding;
  scope: ScopeRef;
  root: string;
  ownerKey: string;
  verify(): Promise<void>;
  git(args: string[]): Promise<{ stdout: string; stderr: string }>;
}
const LIMIT = 1024 * 1024;
export const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export const stale = () =>
  Error(
    "Предпросмотр конфликта Git устарел или изменился владелец. Обновите его и подтвердите заново.",
  );
export const safe = [
  "--no-pager",
  "--literal-pathspecs",
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.preloadIndex=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "diff.external=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "color.ui=false",
];
export function stat(file: string): BigIntStats | null {
  try {
    return lstatSync(file, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
const stamp = (s: BigIntStats | null) =>
  s
    ? [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":")
    : "missing";
export const directory = (file: string) => {
  const s = stat(file);
  if (!s?.isDirectory() || s.isSymbolicLink() || realpathSync(file) !== file)
    throw stale();
  return `${s.dev}:${s.ino}:${s.mode}`;
};
export interface File {
  bytes: Buffer;
  identity: string;
  mode: number;
}
export function regular(file: string, limit = 32 * LIMIT): File | null {
  const s = stat(file);
  if (!s) return null;
  if (!s.isFile() || s.nlink !== 1n || s.size > BigInt(limit))
    throw Error("Небезопасный тип, ссылка или размер файла Git.");
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(s)) throw stale();
    const buffer = Buffer.alloc(Number(s.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, size);
      if (!n) break;
      size += n;
    }
    if (
      size !== Number(s.size) ||
      stamp(fstatSync(fd, { bigint: true })) !== stamp(s) ||
      stamp(stat(file)) !== stamp(s)
    )
      throw stale();
    const bytes = buffer.subarray(0, size);
    return {
      bytes,
      identity: `${stamp(s)}:${hash(bytes)}`,
      mode: Number(s.mode & 0o777n),
    };
  } finally {
    closeSync(fd);
  }
}
export function parents(root: string, name: string) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw stale();
  const rows: [string, string][] = [
    [root, directory(root)],
    [path.join(root, ".git"), directory(path.join(root, ".git"))],
  ];
  let current = root;
  for (const part of name.split("/").slice(0, -1)) {
    current = path.join(current, part);
    rows.push([current, directory(current)]);
    if (stat(path.join(current, ".git")))
      throw Error("Вложенный репозиторий не поддерживается.");
  }
  return rows;
}
export function assertParents(rows: [string, string][]) {
  for (const [p, id] of rows) if (directory(p) !== id) throw stale();
}
const operationNames = [
  "HEAD",
  "config",
  "config.worktree",
  "packed-refs",
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "AUTO_MERGE",
  "ORIG_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "refs",
  "info",
  "shallow",
];
export function metadata(root: string, name?: string) {
  const rows: [string, string][] = [];
  let count = 0;
  function visit(file: string, depth: number) {
    if (++count > 10000 || depth > 16)
      throw Error("Слишком много метаданных Git.");
    const s = stat(file);
    if (!s) {
      rows.push([file, "missing"]);
      return;
    }
    if (s.isDirectory()) {
      rows.push([file, directory(file)]);
      for (const child of readdirSync(file).sort())
        visit(path.join(file, child), depth + 1);
    } else rows.push([file, regular(file)!.identity]);
  }
  for (const name of operationNames) visit(path.join(root, ".git", name), 0);
  if (name) {
    let current = root;
    visit(path.join(current, ".gitattributes"), 0);
    for (const part of name.split("/").slice(0, -1)) {
      current = path.join(current, part);
      visit(path.join(current, ".gitattributes"), 0);
    }
  }
  return JSON.stringify(rows);
}
/** Pin both physical ownership credentials, not just a currently-valid nonce pair. */
export function assertStoppedRebaseOwnership(
  binding?: StoppedRebaseConflictBinding,
) {
  if (!binding) return;
  if (binding.ownership.length !== 2) throw stale();
  for (const [file, expected] of binding.ownership) {
    const parent = directory(path.dirname(file));
    if (
      regular(file, 4096)?.identity !== expected ||
      directory(path.dirname(file)) !== parent
    )
      throw stale();
  }
}
export interface Disk {
  parents: [string, string][];
  work: File | null;
  index: File;
  metadata: string;
}
export function disk(root: string, name: string): Disk {
  const p = parents(root, name),
    index = regular(path.join(root, ".git/index"));
  if (!index) throw stale();
  const work = regular(path.join(root, name), LIMIT);
  assertParents(p);
  return { parents: p, work, index, metadata: metadata(root, name) };
}
export const diskKey = (s: Disk) =>
  JSON.stringify([
    s.parents,
    s.work?.identity ?? "missing",
    s.index.identity,
    s.metadata,
  ]);
export interface Policy {
  raw: string;
  attrs: string;
  values: Record<string, string>;
  autocrlf: string;
  eol: string;
  safecrlf: string;
  filemode: string;
}
export interface State {
  root: string;
  owner: string;
  scope: string;
  revision: string;
  head: string | null;
  branch: string | null;
  operation: string;
  stoppedRebase?: StoppedRebaseConflictBinding;
  disk: Disk;
  policy: Policy;
  stages: string;
}

export const stateKey = (s: State) =>
  JSON.stringify({ ...s, disk: diskKey(s.disk) });
export const stateFingerprint = (s: State) => hash(stateKey(s));
export const identity = (bytes: Buffer, length: number) =>
  createHash(length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
export function git(c: ConflictStateContext, args: string[]) {
  return c.git([
    ...safe,
    `--git-dir=${path.join(c.root, ".git")}`,
    `--work-tree=${c.root}`,
    ...args,
  ]);
}
/** No status/diff/add/hash-with-path here: any of those may execute a filter
 * installed after a filter-name enumeration. Audit raw topology before using Git. */
function auditTopology(root: string, name: string) {
  const ps = parents(root, name),
    gd = path.join(root, ".git");
  if (readdirSync(gd).some((n) => n.toLowerCase().startsWith("sharedindex.")))
    throw Error("Git split-index пока не поддерживается.");
  for (const n of [
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ])
    if (stat(path.join(gd, n)))
      throw Error("Внешнее хранилище объектов Git не поддерживается.");
  let count = 0;
  function visit(file: string, depth: number) {
    if (++count > 100000 || depth > 12)
      throw Error("Слишком много метаданных Git.");
    const s = stat(file);
    if (!s) return;
    if (
      s.isSymbolicLink() ||
      (!s.isDirectory() && (!s.isFile() || s.nlink !== 1n))
    )
      throw Error("Небезопасная ссылка в метаданных Git.");
    if (s.isDirectory()) {
      directory(file);
      for (const child of readdirSync(file))
        visit(path.join(file, child), depth + 1);
    }
  }
  directory(path.join(gd, "objects"));
  visit(path.join(gd, "objects"), 0);
  visit(path.join(gd, "info"), 0);
  assertParents(ps);
}
function operation(root: string) {
  const has = (n: string) => !!stat(path.join(root, ".git", n));
  if (has("rebase-merge") || has("rebase-apply/rebasing")) return "rebase";
  if (has("rebase-apply")) return "unknown";
  if (has("MERGE_HEAD")) return "merge";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  return has("sequencer") || has("REBASE_HEAD") ? "unknown" : "none";
}
export interface Stage {
  mode: string;
  oid: string;
}
export function parseStages(raw: string, name: string): (Stage | null)[] {
  if (!raw || !raw.endsWith("\0") || Buffer.byteLength(raw) > 32768)
    throw Error("Файл не является неразрешённым конфликтом Git.");
  const rows: (Stage | null)[] = [null, null, null];
  for (const row of raw.slice(0, -1).split("\0")) {
    const m =
      /^(100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([\s\S]+)$/.exec(
        row,
      );
    if (!m || m[4] !== name || rows[Number(m[3]) - 1]) throw stale();
    rows[Number(m[3]) - 1] = { mode: m[1], oid: m[2] };
  }
  return rows;
}
export async function capture(
  c: ConflictStateContext,
  name: string,
  revision: string,
): Promise<State> {
  gitFilePathSchema.parse(name);
  await c.verify();
  assertStoppedRebaseOwnership(c.stoppedRebase);
  auditTopology(c.root, name);
  const owner = c.ownerKey,
    root = c.root,
    scope = JSON.stringify(c.scope),
    initial = disk(root, name);
  const rawHead = regular(path.join(root, ".git/HEAD"))?.bytes.toString("utf8");
  if (!rawHead) throw stale();
  const reference =
    /^ref: (refs\/heads\/[^\0\r\n]+)\n?$/.exec(rawHead)?.[1] ?? null;
  if (!reference && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(rawHead))
    throw stale();
  const branch = reference?.slice("refs/heads/".length) ?? null;
  if (
    reference &&
    (await git(c, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() !==
      reference
  )
    throw stale();
  if (
    typeof c.scope !== "string" &&
    branch !== c.scope.branch &&
    !(branch === null && c.stoppedRebase?.kind === "stopped-linear-rebase")
  )
    throw stale();
  let head: string | null = null;
  try {
    head = (
      await git(c, ["rev-parse", "--verify", "--quiet", "HEAD"])
    ).stdout.trim();
  } catch (e) {
    if (!(e instanceof CommandExitError) || e.exitCode !== 1 || !reference)
      throw e;
  }
  if (head !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
    throw stale();
  const p = await policy(c, name),
    stages = (
      await git(c, ["ls-files", "--unmerged", "--stage", "-z", "--", name])
    ).stdout;
  parseStages(stages, name);
  const op = operation(root);
  const stoppedRebase = c.stoppedRebase;
  if (
    stoppedRebase &&
    (typeof c.scope === "string" ||
      branch !== null ||
      op !== "rebase" ||
      head !== stoppedRebase.head ||
      !/^[a-f0-9]{64}$/.test(stoppedRebase.proof))
  )
    throw stale();
  await c.verify();
  assertStoppedRebaseOwnership(stoppedRebase);
  auditTopology(root, name);
  const final = disk(root, name);
  if (
    c.root !== root ||
    c.ownerKey !== owner ||
    JSON.stringify(c.scope) !== scope ||
    diskKey(initial) !== diskKey(final)
  )
    throw stale();
  return {
    root,
    owner,
    scope,
    revision,
    head,
    branch,
    operation: op,
    ...(stoppedRebase ? { stoppedRebase } : {}),
    disk: final,
    policy: p,
    stages,
  };
}
/** The display revision is a bound read nonce, not a fresh whole-worktree status
 * CAS. Mutation freshness is the stronger raw selected-path/head/op/config state. */
export async function readGitConflictSaveFingerprint(
  c: ConflictStateContext,
  request: { path: string; revision: string },
  expected: {
    index: string;
    work: string;
    stages: (Stage | null)[];
    head: string | null;
    branch: string | null;
    operation: string;
  },
) {
  const state = await capture(c, request.path, request.revision);
  if (
    state.disk.index.identity !== expected.index ||
    (state.disk.work?.identity ?? "missing") !== expected.work ||
    JSON.stringify(parseStages(state.stages, request.path)) !==
      JSON.stringify(expected.stages) ||
    state.head !== expected.head ||
    state.branch !== expected.branch ||
    state.operation !== expected.operation
  )
    throw stale();
  return stateFingerprint(state);
}
export async function policy(
  c: ConflictStateContext,
  name: string,
): Promise<Policy> {
  const raw = (await git(c, ["config", "--null", "--list"])).stdout;
  const names = [
    "filter",
    "working-tree-encoding",
    "ident",
    "text",
    "eol",
    "crlf",
  ];
  const attrs = (await git(c, ["check-attr", "-z", ...names, "--", name]))
    .stdout;
  const parts = attrs.split("\0"),
    values: Record<string, string> = {};
  if (parts.length !== names.length * 3 + 1 || parts.at(-1) !== "")
    throw stale();
  for (let i = 0; i < names.length; i++) {
    if (parts[i * 3] !== name || parts[i * 3 + 1] !== names[i]) throw stale();
    values[names[i]] = parts[i * 3 + 2];
  }
  const config = async (key: string, fallback: string) =>
    (await git(c, ["config", `--default=${fallback}`, "--get", key])).stdout
      .trim()
      .toLowerCase();
  const autocrlf = await config("core.autocrlf", "false"),
    eol = await config("core.eol", "native"),
    safecrlf = await config("core.safecrlf", "false"),
    filemode = await config("core.filemode", "true");
  return { raw, attrs, values, autocrlf, eol, safecrlf, filemode };
}

export function assertPolicySupported(p: Policy) {
  for (const attr of ["filter", "working-tree-encoding", "ident"])
    if (!["unspecified", "unset"].includes(p.values[attr]))
      throw Error(
        "Внешний фильтр (filter), ident и working-tree-encoding пока не поддерживаются.",
      );
  if (
    !["true", "false", "input"].includes(p.autocrlf) ||
    !["lf", "crlf", "native"].includes(p.eol) ||
    !["true", "false", "warn"].includes(p.safecrlf) ||
    !["true", "false"].includes(p.filemode) ||
    !["set", "unset", "unspecified", "auto"].includes(p.values.text) ||
    !["lf", "crlf", "unspecified", "unset"].includes(p.values.eol) ||
    !["set", "unset", "unspecified", "input"].includes(p.values.crlf)
  )
    throw Error("Неподдерживаемые параметры нормализации текста Git.");
}
