import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { scopeRefSchema } from "../shared/context";
import { noSymlinks } from "./settings";
import { gitLiteralPaths } from "./git-native-client";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .nullable();
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => path.isAbsolute(p) && path.resolve(p) === p && !p.includes("\0"),
  );
const ownerSchema = z
  .object({
    scope: scopeRefSchema,
    registryRevision: z.string().min(1).max(256),
    projectPath: absolute,
  })
  .strict();
const fileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    mode: z.number().int().min(0).max(0o777).nullable(),
    checksum: hash.nullable(),
    data: z
      .string()
      .max(12 * 1024 * 1024)
      .nullable(),
  })
  .strict();
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    root: absolute,
    physicalRoot: z.string().min(1).max(256),
    physicalGit: z.string().min(1).max(256),
    owner: ownerSchema,
    head: oid,
    headRef: z
      .string()
      .regex(/^refs\/heads\/[^\0\r\n]+$/)
      .max(2048)
      .nullable(),
    index: hash,
    indexData: z.string().max(12 * 1024 * 1024),
    indexRecovery: z
      .object({
        flags: z.string().max(12 * 1024 * 1024),
        objects: z
          .array(
            z
              .object({
                oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
                checksum: hash,
                data: z.string().max(12 * 1024 * 1024),
              })
              .strict(),
          )
          .max(12288),
      })
      .strict()
      .optional(),
    refs: hash,
    status: hash,
    policyFingerprint: hash,
    controlFingerprint: hash,
    files: z.array(fileSchema).max(4096),
    revision: hash,
  })
  .strict();
export type NativeGitState = z.infer<typeof stateSchema>;
export type NativeGitOwner = z.infer<typeof ownerSchema>;
export interface NativeGitObservation {
  head: string | null;
  headRef?: string | null;
  index: Buffer;
  refs: Buffer;
  status: Buffer;
  policyFingerprint: string;
  controlFingerprint: string;
}
interface Options {
  root: string;
  /** Host computes ALL protected user paths and potential write destinations,
   * including ignored/untracked collisions. This is not a whole-repo backup. */
  paths: readonly string[];
  owner(): Promise<NativeGitOwner>;
  /** Existing admitted public Git reader + effective policy/control digest.
   * Must reject unsafe config/attributes/object stores before running Git.
   * This module neither grants Git admission nor parses sequencer formats. */
  observe(): Promise<NativeGitObservation>;
  indexRecovery?(
    index: Buffer,
  ): Promise<NonNullable<NativeGitState["indexRecovery"]>>;
  maxBytes?: number;
}
const TOTAL = 32 * 1024 * 1024,
  FILE = 8 * 1024 * 1024;
const stale = () =>
  Error(
    "Состояние или владелец Git изменились. Требуется новое подтверждение.",
  );
function validatePaths(paths: readonly string[]) {
  if (paths.length > 4096 || new Set(paths).size !== paths.length)
    throw stale();
  if (paths.length) gitLiteralPaths(paths);
  if (
    paths.some(
      (p) =>
        p.length > 4096 || p.split("/").some((s) => s.toLowerCase() === ".git"),
    )
  )
    throw stale();
}
function revision(s: Omit<NativeGitState, "revision">) {
  return digest(JSON.stringify(stateSchema.omit({ revision: true }).parse(s)));
}
export function validateNativeGitState(value: unknown): NativeGitState {
  const state = stateSchema.parse(value);
  validatePaths(state.files.map((f) => f.path));
  const index = Buffer.from(state.indexData, "base64");
  if (
    index.length > 8 * 1024 * 1024 ||
    index.toString("base64") !== state.indexData ||
    digest(index) !== state.index
  )
    throw stale();
  let bytes = 0;
  if (state.indexRecovery) {
    const recovery = state.indexRecovery;
    const flags = Buffer.from(recovery.flags, "base64");
    if (flags.length > FILE || flags.toString("base64") !== recovery.flags)
      throw stale();
    const required = new Set<string>(),
      protectedPaths = new Set(state.files.map((f) => f.path));
    for (const row of new TextDecoder("utf-8", { fatal: true })
      .decode(index)
      .split("\0")
      .filter(Boolean)) {
      const m = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t([\s\S]+)$/.exec(
        row,
      );
      if (!m) throw stale();
      if (protectedPaths.has(m[3])) required.add(m[2]);
    }
    const seen = new Set<string>();
    for (const object of recovery.objects) {
      const data = Buffer.from(object.data, "base64");
      if (
        seen.has(object.oid) ||
        !required.has(object.oid) ||
        data.length > FILE ||
        data.toString("base64") !== object.data ||
        (bytes += data.length) > TOTAL ||
        digest(data) !== object.checksum ||
        createHash(object.oid.length === 40 ? "sha1" : "sha256")
          .update(`blob ${data.length}\0`)
          .update(data)
          .digest("hex") !== object.oid
      )
        throw stale();
      seen.add(object.oid);
    }
    if (seen.size !== required.size) throw stale();
  }
  for (const file of state.files) {
    if (file.data === null) {
      if (file.checksum !== null || file.mode !== null) throw stale();
    } else {
      const data = Buffer.from(file.data, "base64");
      if (
        data.toString("base64") !== file.data ||
        data.length > FILE ||
        (bytes += data.length) > TOTAL ||
        digest(data) !== file.checksum ||
        file.mode === null
      )
        throw stale();
    }
  }
  const { revision: expected, ...body } = state;
  if (revision(body) !== expected) throw stale();
  return state;
}
export function nativeGitRepositoryKey(
  s: Pick<NativeGitState, "root" | "physicalRoot" | "physicalGit">,
) {
  return digest(JSON.stringify([s.root, s.physicalRoot, s.physicalGit]));
}
export function nativeGitOwnerKey(
  s: Pick<NativeGitState, "root" | "physicalRoot" | "physicalGit" | "owner">,
) {
  return digest(JSON.stringify([nativeGitRepositoryKey(s), s.owner]));
}
export function assertNativeGitState(
  expected: NativeGitState,
  current: NativeGitState,
) {
  const a = validateNativeGitState(expected),
    b = validateNativeGitState(current);
  if (a.revision !== b.revision) throw stale();
}
export async function nativeGitPhysicalIdentity(root: string) {
  absolute.parse(root);
  const inspect = async (p: string) => {
    await noSymlinks(p);
    const stat = await fs.lstat(p, { bigint: true });
    if (!stat.isDirectory() || (await fs.realpath(p)) !== p) throw stale();
    // Directory contents/mtime are not evidence of repository ownership.
    return [stat.dev, stat.ino, stat.mode].join(":");
  };
  return {
    physicalRoot: await inspect(root),
    physicalGit: await inspect(path.join(root, ".git")),
  };
}
async function fileSnapshot(root: string, relative: string, remaining: number) {
  const filename = path.join(root, relative);
  try {
    await noSymlinks(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR")
      return { path: relative, data: null, checksum: null, mode: null };
    throw error;
  }
  let handle;
  try {
    handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? ""))
      return { path: relative, data: null, checksum: null, mode: null };
    throw e;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(Math.min(FILE, remaining))
    )
      throw Error(
        "Небезопасный файл или превышен предел защитного снимка Git.",
      );
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await noSymlinks(filename);
    const visible = await fs.lstat(filename, { bigint: true });
    const fingerprint = (s: typeof before) =>
      [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
    if (
      offset !== Number(before.size) ||
      fingerprint(before) !== fingerprint(after) ||
      fingerprint(before) !== fingerprint(visible)
    )
      throw stale();
    const data = buffer.subarray(0, offset);
    return {
      path: relative,
      data: data.toString("base64"),
      checksum: digest(data),
      mode: Number(before.mode & 0o777n),
    };
  } finally {
    await handle.close();
  }
}
export async function captureNativeGitState(
  options: Options,
): Promise<NativeGitState> {
  const paths = [...options.paths].sort();
  validatePaths(paths);
  const limit = options.maxBytes ?? TOTAL;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOTAL) throw stale();
  const observe = async () => {
    const owner = ownerSchema.parse(await options.owner()),
      identity = await nativeGitPhysicalIdentity(options.root);
    const o = await options.observe();
    if (
      ![o.index, o.refs, o.status].every(Buffer.isBuffer) ||
      o.index.length + o.refs.length + o.status.length > 8 * 1024 * 1024
    )
      throw stale();
    return {
      owner,
      ...identity,
      head: oid.parse(o.head),
      headRef: o.headRef ?? null,
      index: digest(o.index),
      indexData: o.index.toString("base64"),
      ...(options.indexRecovery
        ? { indexRecovery: await options.indexRecovery(o.index) }
        : {}),
      refs: digest(o.refs),
      status: digest(o.status),
      policyFingerprint: hash.parse(o.policyFingerprint),
      controlFingerprint: hash.parse(o.controlFingerprint),
    };
  };
  const before = await observe();
  const files: NativeGitState["files"] = [];
  let remaining =
    limit -
    (before.indexRecovery?.objects.reduce(
      (n, o) => n + Buffer.byteLength(o.data, "base64"),
      0,
    ) ?? 0);
  if (remaining < 0) throw stale();
  for (const p of paths) {
    const file = await fileSnapshot(options.root, p, remaining);
    if (file.data !== null) remaining -= Buffer.byteLength(file.data, "base64");
    files.push(file);
  }
  // Recheck public state/admission and user bytes; no promise to exclude an
  // arbitrary external writer after the last check.
  if (JSON.stringify(before) !== JSON.stringify(await observe())) throw stale();
  for (const file of files)
    if (
      JSON.stringify(file) !==
      JSON.stringify(await fileSnapshot(options.root, file.path, limit))
    )
      throw stale();
  if (
    JSON.stringify({
      physicalRoot: before.physicalRoot,
      physicalGit: before.physicalGit,
    }) !== JSON.stringify(await nativeGitPhysicalIdentity(options.root))
  )
    throw stale();
  const body = {
    schemaVersion: 1 as const,
    root: options.root,
    ...before,
    files,
  };
  return validateNativeGitState({ ...body, revision: revision(body) });
}

/** A refusal only. Native Git owns lock creation/removal; Desktop never removes
 * any of these locks. The command itself still handles races after inspection. */
export async function assertNoNativeGitLocks(root: string) {
  const git = path.join(root, ".git");
  for (const name of [
    "HEAD.lock",
    "index.lock",
    "packed-refs.lock",
    "config.lock",
    "shallow.lock",
  ]) {
    try {
      await fs.lstat(path.join(git, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    throw Error("Git занят: обнаружена чужая блокировка.");
  }
  let count = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    await noSymlinks(dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (depth > 16) throw stale();
    for (const e of entries) {
      if (
        ++count > 100000 ||
        e.name.endsWith(".lock") ||
        e.isSymbolicLink() ||
        (!e.isFile() && !e.isDirectory())
      )
        throw stale();
      if (e.isDirectory()) await visit(path.join(dir, e.name), depth + 1);
    }
  };
  await visit(path.join(git, "refs"), 0);
}

/** Public CLI adapter. Call ONLY inside the host's validated Git policy scope;
 * observing state does not validate executable filters/config by itself. */
export async function readNativeGitObservation(
  client: Pick<
    Awaited<
      ReturnType<typeof import("./git-native-client").createNativeGitClient>
    >,
    "run"
  >,
  evidence: Pick<
    NativeGitObservation,
    "policyFingerprint" | "controlFingerprint" | "headRef"
  >,
  admittedStatus?: () => Promise<Buffer>,
): Promise<NativeGitObservation> {
  const headResult = await client.run({
    policy: "local-read",
    command: "rev-parse",
    args: ["--verify", "--quiet", "HEAD"],
  });
  let head: string | null;
  if (
    headResult.exitCode === 1 &&
    !headResult.stdout.length &&
    !headResult.stderr.length &&
    headResult.processSettled &&
    headResult.signal === null
  )
    head = null;
  else {
    if (
      headResult.exitCode !== 0 ||
      !headResult.processSettled ||
      headResult.signal !== null
    )
      throw stale();
    const raw = headResult.stdout.toString("utf8");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/.test(raw)) throw stale();
    head = raw.slice(0, -1);
  }
  const read = async (
    command: "ls-files" | "for-each-ref" | "status",
    args: string[],
  ) => {
    const result = await client.run({ policy: "local-read", command, args });
    if (
      result.exitCode !== 0 ||
      !result.processSettled ||
      result.signal !== null
    )
      throw stale();
    return result.stdout;
  };
  return {
    head,
    headRef: evidence.headRef ?? null,
    index: await read("ls-files", ["--stage", "-z"]),
    refs: await read("for-each-ref", [
      "--sort=refname",
      "--format=%(refname)%00%(objectname)%00%(symref)%00",
    ]),
    status: admittedStatus
      ? await admittedStatus()
      : await read("status", [
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=all",
        ]),
    policyFingerprint: hash.parse(evidence.policyFingerprint),
    controlFingerprint: hash.parse(evidence.controlFingerprint),
  };
}

/** Opaque provenance seal, never a parser or a backup to install into .git.
 * Native Git may change its file formats. We only detect post-stop changes.
 * Unknown/external operations do not become trusted just by obtaining a seal. */
export async function fingerprintNativeGitControls(
  root: string,
): Promise<string> {
  const initial = await nativeGitPhysicalIdentity(root);
  const scan = async () => {
    const rows: unknown[] = [];
    let bytes = 0,
      count = 0;
    const visit = async (relative: string, depth: number): Promise<void> => {
      if (depth > 16 || ++count > 4096) throw stale();
      const file = path.join(root, relative);
      await noSymlinks(file);
      let info;
      try {
        info = await fs.lstat(file, { bigint: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          rows.push([relative, "missing"]);
          return;
        }
        throw e;
      }
      if (info.isDirectory()) {
        const names = (await fs.readdir(file)).sort();
        rows.push([relative, "directory", names]);
        for (const name of names)
          await visit(path.join(relative, name), depth + 1);
      } else {
        const captured = await fileSnapshot(root, relative, FILE - bytes);
        if (captured.data !== null)
          bytes += Buffer.byteLength(captured.data, "base64");
        rows.push([relative, captured.mode, captured.checksum]);
      }
    };
    for (const name of [
      "MERGE_HEAD",
      "MERGE_MSG",
      "MERGE_MODE",
      "MERGE_AUTOSTASH",
      "AUTO_MERGE",
      "ORIG_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ])
      await visit(path.join(".git", name), 0);
    return digest(JSON.stringify(rows));
  };
  const before = await scan();
  if (
    before !== (await scan()) ||
    JSON.stringify(initial) !==
      JSON.stringify(await nativeGitPhysicalIdentity(root))
  )
    throw stale();
  return before;
}
