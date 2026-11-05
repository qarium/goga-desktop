import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { noSymlinks } from "./settings";
import { gitLiteralPaths } from "./git-native-client";

import { scopeRefSchema } from "../shared/context";
import type { GitCommitPreview } from "../shared/git-commit";
import type {
  GitCommitAdmissionState,
  GitCommitContext,
} from "./git-workspace-actions";
import type { PrivateGitRead } from "./git-private-read";
import type { NativeGitClient } from "./git-native-client";
import {
  captureNativeGitState,
  nativeGitPhysicalIdentity,
  fingerprintNativeGitControls,
  readNativeGitObservation,
  type NativeGitState,
  type NativeGitOwner,
  type NativeGitObservation,
} from "./git-native-state";
import {
  captureNativeIndexRecovery,
  readNativeGitBlobBodies,
  readNativeGitBlobStates,
  type NativeGitBlobDeclaration,
} from "./git-native-recovery";
import { CommandExitError } from "./process";

export interface ContentWitness {
  readonly path: string;
  readonly kind: "missing" | "file" | "directory";
  readonly identity: string;
  readonly sha256: string | null;
  readonly names: readonly string[] | null;
}
export interface CommitProtectedDigest {
  readonly path: string;
  readonly mode: number | null;
  readonly sha256: string | null;
}
const stale = () => Error("Источники подтверждения Git изменились.");
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.nlink].join(":");
const stamp = (s: BigIntStats) =>
  [identity(s), s.size, s.mtimeNs, s.ctimeNs].join(":");
const stat = async (filename: string) =>
  fs.lstat(filename, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

/** Bounded no-follow read. Stat identity detects races; only bytes prove content.
 * Missing paths retain the identities of existing ancestors, not just ENOENT. */
async function witness(
  filename: string,
  remaining: number,
): Promise<ContentWitness> {
  if (
    !path.isAbsolute(filename) ||
    path.resolve(filename) !== filename ||
    filename.includes("\0")
  )
    throw stale();
  await noSymlinks(filename);
  const before = await stat(filename);
  if (!before) {
    let parent = path.dirname(filename),
      parents = "";
    while (parent !== path.dirname(parent)) {
      const info = await stat(parent);
      if (info) {
        if (!info.isDirectory()) throw stale();
        parents += `${parent}:${[info.dev, info.ino, info.mode].join(":")};`;
      }
      parent = path.dirname(parent);
    }
    if (await stat(filename)) throw stale();
    return {
      path: filename,
      kind: "missing",
      identity: parents,
      sha256: null,
      names: null,
    };
  }
  if (before.isDirectory()) {
    const names = (await fs.readdir(filename)).sort();
    if (
      names.length > 100000 ||
      stamp(before) !== stamp((await stat(filename))!)
    )
      throw stale();
    await noSymlinks(filename);
    return {
      path: filename,
      kind: "directory",
      identity: identity(before),
      sha256: null,
      names,
    };
  }
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > BigInt(Math.min(32 * 1024 * 1024, remaining))
  )
    throw stale();
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before))
      throw stale();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await stat(filename);
    if (
      size !== Number(before.size) ||
      !after ||
      stamp(after) !== stamp(before) ||
      stamp(await handle.stat({ bigint: true })) !== stamp(before)
    )
      throw stale();
    await noSymlinks(filename);
    return {
      path: filename,
      kind: "file",
      identity: stamp(before),
      sha256: sha(bytes.subarray(0, size)),
      names: null,
    };
  } finally {
    await handle.close();
  }
}

const metadata = [
  "HEAD",
  "index",
  "refs",
  "packed-refs",
  "shallow",
  "info/attributes",
  "info/exclude",
  "info/grafts",
  "info/sparse-checkout",
  "config",
  "config.worktree",
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
];
export async function readCommitSources(
  root: string,
  protectedPaths: readonly string[],
  externalAttributes: readonly string[] = [],
): Promise<readonly ContentWitness[]> {
  if (protectedPaths.length) gitLiteralPaths(protectedPaths);
  if (protectedPaths.length > 4096) throw stale();
  const files = new Set(metadata.map((name) => path.join(root, ".git", name)));
  files.add(path.join(root, ".gitattributes"));
  for (const name of protectedPaths) {
    if (name.split("/").some((part) => part.toLowerCase() === ".git"))
      throw stale();
    let directory = path.dirname(name);
    while (directory !== ".") {
      files.add(path.join(root, directory, ".gitattributes"));
      directory = path.dirname(directory);
    }
  }
  for (const file of externalAttributes) files.add(file);
  const result: ContentWitness[] = [];
  let total = 0;
  const visit = async (filename: string, depth: number) => {
    if (depth > 16 || result.length >= 100000) throw stale();
    const value = await witness(filename, 64 * 1024 * 1024 - total);
    if (value.kind === "file") total += Number(value.identity.split(":")[4]);
    result.push(value);
    if (value.kind === "directory")
      for (const name of value.names!)
        await visit(path.join(filename, name), depth + 1);
  };
  for (const file of [...files].sort()) await visit(file, 0);
  return result;
}
export function assertCommitSources(
  expected: readonly ContentWitness[],
  current: readonly ContentWitness[],
) {
  if (JSON.stringify(expected) !== JSON.stringify(current)) throw stale();
}
export async function readCommitProtectedFiles(
  root: string,
  paths: readonly string[],
): Promise<readonly CommitProtectedDigest[]> {
  if (paths.length) gitLiteralPaths(paths);
  let total = 0;
  const result: CommitProtectedDigest[] = [];
  for (const name of [...paths].sort()) {
    let parent = path.dirname(name);
    while (parent !== ".") {
      if (await stat(path.join(root, parent, ".git"))) throw stale();
      parent = path.dirname(parent);
    }
    const value = await witness(
      path.join(root, name),
      Math.min(8 * 1024 * 1024, 32 * 1024 * 1024 - total),
    );
    if (value.kind === "directory") throw stale();
    if (value.kind === "file") total += Number(value.identity.split(":")[4]);
    result.push({
      path: name,
      mode:
        value.kind === "file"
          ? Number(value.identity.split(":")[2]) & 0o777
          : null,
      sha256: value.sha256,
    });
  }
  return result;
}

export type CommitPhase =
  | "admit"
  | "attempt-ready"
  | "before-commit"
  | "publish-prepared"
  | "index-prepared"
  | "result";
export interface CommitBaseline {
  readonly preview: GitCommitPreview;
  readonly admission: GitCommitAdmissionState;
  readonly recovery: Readonly<NativeGitState>;
  readonly sources: readonly ContentWitness[];
  readonly protectedFiles: readonly CommitProtectedDigest[];
  readonly indexTuples: Buffer;
  readonly indexFlags: Buffer;
  readonly refs: Buffer;
  readonly rawStatus: Buffer;
  readonly expectedObjects: readonly NativeGitBlobDeclaration[];
  readonly storageIdentity: string;
}
export interface CommitFreshProof {
  readonly phase: CommitPhase;
  readonly baselineRevision: string;
  readonly owner: NativeGitOwner;
  readonly physicalRoot: string;
  readonly physicalGit: string;
  readonly head: string | null;
  readonly headRef: string | null;
  readonly indexTuples: Buffer;
  readonly indexFlags: Buffer;
  readonly refs: Buffer;
  readonly rawStatus: Buffer;
  readonly policyFingerprint: string;
  readonly controlFingerprint: string;
  readonly files: readonly CommitProtectedDigest[];
  readonly sourceSeal: string;
}
export interface ExpectedCommitState {
  phase: CommitPhase;
  baseline: CommitBaseline;
  candidate: string | null;
  index: "original" | "selected-published";
}
const proofs = new WeakMap<CommitFreshProof, string>();
export const commitOwnerIdentity = (owner: NativeGitOwner) =>
  jsonDigest([
    scopeRefSchema.parse(owner.scope),
    owner.registryRevision,
    owner.projectPath,
  ]);
export function assertCommitFreshProof(
  original: NativeGitState,
  proof: CommitFreshProof,
  phase: CommitPhase,
  unchanged: boolean,
) {
  if (
    proofs.get(proof) !== jsonDigest(proof) ||
    proof.phase !== phase ||
    proof.baselineRevision !== original.revision ||
    commitOwnerIdentity(proof.owner) !== commitOwnerIdentity(original.owner) ||
    proof.physicalRoot !== original.physicalRoot ||
    proof.physicalGit !== original.physicalGit ||
    proof.headRef !== original.headRef ||
    proof.policyFingerprint !== original.policyFingerprint ||
    proof.controlFingerprint !== original.controlFingerprint ||
    JSON.stringify(proof.files) !==
      JSON.stringify(
        original.files.map((file) => ({
          path: file.path,
          mode: file.mode,
          sha256: file.checksum,
        })),
      ) ||
    (unchanged &&
      (proof.head !== original.head ||
        sha(proof.indexTuples) !== original.index ||
        sha(proof.refs) !== original.refs ||
        sha(proof.rawStatus) !== original.status ||
        proof.indexFlags.toString("base64") !== original.indexRecovery?.flags))
  )
    throw stale();
}
const jsonDigest = (value: unknown) => sha(JSON.stringify(value));
const decode = (bytes: Buffer) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
export function commitEntries(raw: Buffer | string, tree = false) {
  const rows = typeof raw === "string" ? raw : decode(raw);
  if (rows && !rows.endsWith("\0")) throw stale();
  const map = new Map<string, string>();
  for (const row of rows.split("\0").filter(Boolean)) {
    const match = (
      tree
        ? /^(\d{6}) (?:blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/
        : /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/
    ).exec(row);
    if (!match || map.has(match[3])) throw stale();
    map.set(match[3], `${match[1]} ${match[2]}`);
  }
  return map;
}
export const commitOutside = (
  map: ReadonlyMap<string, string>,
  selected: readonly string[],
) =>
  JSON.stringify(
    [...map]
      .filter(([name]) => !selected.includes(name))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
const objectDeclarations = (
  recovery: NonNullable<NativeGitState["indexRecovery"]>,
) =>
  recovery.objects.map((object) => ({
    oid: object.oid,
    type: "blob" as const,
    size: Buffer.byteLength(object.data, "base64"),
    sha256: object.checksum,
  }));
const statusArgs = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--untracked-files=all",
];
function checkStatus(
  raw: Buffer,
  head: string | null,
  headRef: string | null,
  paths: readonly string[],
) {
  const rows = decode(raw).split("\0");
  if (rows.pop() !== "") throw stale();
  let oid = false,
    branch = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.startsWith("# branch.oid ")) {
      if (oid || row.slice(13) !== (head ?? "(initial)")) throw stale();
      oid = true;
    } else if (row.startsWith("# branch.head ")) {
      if (branch || row.slice(14) !== (headRef?.slice(11) ?? "(detached)"))
        throw stale();
      branch = true;
    } else if (/^# branch\.(upstream|ab) /.test(row)) continue;
    else {
      let name: string;
      if (row.startsWith("1 ")) {
        const m =
          /^1 [A-Z.]{2} [N.SCMU?]{4} \d{6} \d{6} \d{6} [a-f0-9]+ [a-f0-9]+ ([\s\S]+)$/.exec(
            row,
          );
        if (!m || row.slice(2, 4).includes("U")) throw stale();
        name = m[1];
      } else if (row.startsWith("2 ")) {
        const m =
          /^2 [A-Z.]{2} [N.SCMU?]{4} \d{6} \d{6} \d{6} [a-f0-9]+ [a-f0-9]+ [RC]\d+ ([\s\S]+)$/.exec(
            row,
          );
        if (!m || !paths.includes(rows[++i])) throw stale();
        name = m[1];
      } else if (row.startsWith("? ")) name = row.slice(2);
      else throw stale();
      if (!paths.includes(name)) throw stale();
    }
  }
  if (!oid || !branch) throw stale();
}

/** Preserve the existing topology audit: object names/types, never an inventory
 * of blob contents or a requirement that harmless unreachable objects vanish. */
export async function auditCommitMetadata(
  root: string,
  allowedLocks: readonly string[] = [],
) {
  await nativeGitPhysicalIdentity(root);
  const git = path.join(root, ".git");
  if (
    (await fs.readdir(git)).some((name) =>
      name.toLowerCase().startsWith("sharedindex."),
    )
  )
    throw stale();
  for (const name of [
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ])
    if (await stat(path.join(git, name))) throw stale();
  for (const name of [
    "HEAD.lock",
    "index.lock",
    "packed-refs.lock",
    "config.lock",
    "shallow.lock",
  ]) {
    const info = await stat(path.join(git, name));
    if (
      info &&
      (!allowedLocks.includes(name) || !info.isFile() || info.nlink !== 1n)
    )
      throw stale();
  }
  let count = 0;
  const visit = async (name: string, depth: number, writable: boolean) => {
    const filename = path.join(git, name),
      info = await stat(filename);
    if (!info) return;
    if (
      !info.isDirectory() ||
      (await fs.realpath(filename)) !== filename ||
      depth > 8
    )
      throw stale();
    for (const entry of await fs.readdir(filename, { withFileTypes: true })) {
      if (
        ++count > 100000 ||
        entry.isSymbolicLink() ||
        (!entry.isFile() && !entry.isDirectory())
      )
        throw stale();
      const relative = path.join(name, entry.name);
      if (entry.name.endsWith(".lock") && !allowedLocks.includes(relative))
        throw stale();
      if (entry.isDirectory()) await visit(relative, depth + 1, writable);
      else if (writable && (await stat(path.join(git, relative)))?.nlink !== 1n)
        throw stale();
    }
  };
  for (const name of [
    "refs",
    "objects",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "logs",
  ])
    await visit(name, 0, name === "logs");
  const message = await stat(path.join(git, "COMMIT_EDITMSG"));
  if (message && (!message.isFile() || message.nlink !== 1n)) throw stale();
}

async function objectStorageIdentity(root: string) {
  const rows = [];
  for (const name of ["objects", "objects/info", "objects/pack"]) {
    const filename = path.join(root, ".git", name);
    await noSymlinks(filename);
    const info = await stat(filename);
    if (info && !info.isDirectory()) throw stale();
    rows.push([name, info ? [info.dev, info.ino, info.mode].join(":") : null]);
  }
  return jsonDigest(rows);
}

interface ProofReaderOptions {
  context: GitCommitContext;
  client: NativeGitClient;
  paths: readonly string[];
  privateRead<T>(read: (policy: PrivateGitRead) => Promise<T>): Promise<T>;
  sourceGit(args: string[]): Promise<string>;
}
/** Host-scoped reader. It owns phase order and closes every read-set after
 * private-directory cleanup; no fresh proof can be synthesized by spreading a
 * recovery snapshot. Expected bodies are declarations, not cached authority. */
export class CommitProofReader {
  private phase = -1;
  private candidate: string | null = null;
  private baseline: CommitBaseline | undefined;
  private candidateObjects: readonly NativeGitBlobDeclaration[] = [];
  private headTree: ReadonlyMap<string, string> | undefined;
  constructor(private readonly options: ProofReaderOptions) {}
  originalHeadTree(): ReadonlyMap<string, string> {
    if (!this.headTree) throw stale();
    return this.headTree;
  }
  private async native(
    command: "rev-parse" | "ls-files" | "for-each-ref" | "ls-tree",
    args: string[],
  ) {
    const r = await this.options.client.run({
      policy: "local-read",
      command,
      args,
    });
    if (r.exitCode !== 0 || !r.processSettled || r.signal !== null)
      throw stale();
    return r.stdout;
  }
  private async headRef() {
    try {
      return (
        await this.options.sourceGit([
          "symbolic-ref",
          "--quiet",
          "--no-recurse",
          "HEAD",
        ])
      ).trim();
    } catch (error) {
      if (error instanceof CommandExitError && error.exitCode === 1)
        return null;
      throw error;
    }
  }
  private async attributes(
    policy: PrivateGitRead,
    selected: readonly string[],
  ) {
    return policy.git(["check-attr", "-z", "--all", "--", ...selected]);
  }
  private policy(
    raw: string,
    attributes: string,
    flags: Buffer,
    selected: readonly string[],
  ) {
    return jsonDigest([
      raw,
      attributes,
      decode(flags)
        .split("\0")
        .filter((row) => row && !selected.includes(row.slice(2))),
    ]);
  }
  async captureBaseline(
    preview: GitCommitPreview,
    admission: GitCommitAdmissionState,
  ): Promise<CommitBaseline> {
    const o = this.options;
    const storageIdentity = await objectStorageIdentity(o.context.root);
    let recovery: NativeGitState["indexRecovery"];
    let latest: NativeGitObservation | undefined,
      sources: readonly ContentWitness[] = [];
    const state = await captureNativeGitState({
      root: o.context.root,
      paths: o.paths,
      owner: () => o.context.native!.owner(),
      indexRecovery: async (index, flags) => {
        if (!recovery)
          return (recovery = await captureNativeIndexRecovery(
            o.client,
            index,
            o.paths,
            { flags, freshBatch: true },
          ));
        await readNativeGitBlobBodies(o.client, objectDeclarations(recovery));
        return recovery;
      },
      observe: async () => {
        await auditCommitMetadata(o.context.root);
        const observed = await o.privateRead(async (policy) => {
          if (!policy.sources || !policy.verifySources) throw stale();
          const flags = await this.native("ls-files", ["-v", "-z"]),
            attrs = await this.attributes(policy, preview.paths);
          const observation = await readNativeGitObservation(
            o.client,
            {
              headRef: await this.headRef(),
              policyFingerprint: this.policy(
                policy.configuration,
                attrs,
                flags,
                preview.paths,
              ),
              controlFingerprint: await fingerprintNativeGitControls(
                o.context.root,
              ),
            },
            async () => Buffer.from(await policy.git(statusArgs)),
          );
          if (
            policy.nativeAttributes &&
            attrs !== (await this.attributes(policy, preview.paths))
          )
            throw stale();
          return { policy, observation: { ...observation, indexFlags: flags } };
        });
        await observed.policy.verify();
        await observed.policy.verifySources!();
        await auditCommitMetadata(o.context.root);
        sources = observed.policy.sources!;
        latest = observed.observation;
        return latest;
      },
    });
    const baseline: CommitBaseline = {
      preview: structuredClone(preview),
      admission: structuredClone(admission),
      recovery: state,
      sources,
      protectedFiles: state.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        sha256: file.checksum,
      })),
      indexTuples: Buffer.from(latest!.index),
      indexFlags: Buffer.from(latest!.indexFlags!),
      refs: Buffer.from(latest!.refs),
      rawStatus: Buffer.from(latest!.status),
      expectedObjects: objectDeclarations(recovery!),
      storageIdentity,
    };
    await this.closeBaseline(baseline);
    return baseline;
  }
  async closeBaseline(baseline: CommitBaseline) {
    if (
      (await objectStorageIdentity(this.options.context.root)) !==
      baseline.storageIdentity
    )
      throw stale();
    const o = this.options,
      extras = baseline.sources
        .filter((source) => !source.path.startsWith(`${o.context.root}/`))
        .map((source) => source.path);
    assertCommitSources(
      baseline.sources,
      await readCommitSources(o.context.root, o.paths, extras),
    );
    if (
      JSON.stringify(
        await readCommitProtectedFiles(o.context.root, o.paths),
      ) !== JSON.stringify(baseline.protectedFiles)
    )
      throw stale();
    await readNativeGitBlobBodies(o.client, baseline.expectedObjects);
    const physical = await nativeGitPhysicalIdentity(o.context.root);
    if (
      physical.physicalGit !== baseline.recovery.physicalGit ||
      physical.physicalRoot !== baseline.recovery.physicalRoot
    )
      throw stale();
  }
  async setCandidateObjects(
    candidate: string,
    tuples: Buffer,
    selected: readonly string[],
  ) {
    if (
      this.phase !== 2 ||
      this.candidate !== null ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate)
    )
      throw stale();
    this.candidate = candidate;
    this.candidateObjects = objectDeclarations(
      await captureNativeIndexRecovery(this.options.client, tuples, selected, {
        flags: Buffer.alloc(0),
        freshBatch: true,
      }),
    );
  }
  async prove(
    expected: ExpectedCommitState,
    readback?: () => Promise<void>,
  ): Promise<CommitFreshProof> {
    const phases: CommitPhase[] = [
        "admit",
        "attempt-ready",
        "before-commit",
        "publish-prepared",
        "index-prepared",
        "result",
      ],
      next = phases.indexOf(expected.phase);
    if (
      (next !== this.phase + 1 &&
        !(next === 5 && this.phase >= 0 && this.phase < 5)) ||
      expected.candidate !== (next >= 3 ? this.candidate : null) ||
      (next === 4 && !expected.candidate) ||
      (expected.index === "selected-published" && next !== 5)
    )
      throw stale();
    if (this.baseline && this.baseline !== expected.baseline) throw stale();
    this.baseline = expected.baseline;
    this.phase = next;
    const o = this.options,
      b = expected.baseline,
      original = b.recovery,
      published = next >= 4 && expected.candidate !== null;
    const allowed =
      next >= 1 && next <= 4
        ? [
            "config.lock",
            ...(next >= 3
              ? [
                  "HEAD.lock",
                  ...(original.headRef ? [`${original.headRef}.lock`] : []),
                ]
              : []),
          ]
        : [];
    // Physical admission stays early; authoritative owner closes the first
    // observation below, rather than being reused from before its awaits.
    const physical = await nativeGitPhysicalIdentity(o.context.root);
    if (
      physical.physicalRoot !== original.physicalRoot ||
      physical.physicalGit !== original.physicalGit
    )
      throw stale();
    await auditCommitMetadata(o.context.root, allowed);
    if ((await objectStorageIdentity(o.context.root)) !== b.storageIdentity)
      throw stale();
    const objectStates = [
      b.expectedObjects,
      ...(next >= 3 ? [this.candidateObjects] : []),
    ];
    const initialFiles = await readCommitProtectedFiles(
      o.context.root,
      o.paths,
    );
    if (JSON.stringify(initialFiles) !== JSON.stringify(b.protectedFiles))
      throw stale();
    const read = await o.privateRead(async (policy) => {
      if (!policy.sources || !policy.verifySources) throw stale();
      const branchPath = original.headRef
        ? path.join(o.context.root, ".git", original.headRef)
        : null;
      const headPath = path.join(o.context.root, ".git/HEAD");
      const expectedNewDirectory = (source: ContentWitness) =>
        published &&
        branchPath?.startsWith(`${source.path}/`) &&
        !b.sources.some((old) => old.path === source.path);
      const normalize = (sources: readonly ContentWitness[]) =>
        sources
          .filter(
            (source) =>
              !allowed.some(
                (name) =>
                  source.path === path.join(o.context.root, ".git", name),
              ) &&
              !(
                expected.index === "selected-published" &&
                source.path === path.join(o.context.root, ".git/index")
              ) &&
              !(
                published &&
                (source.path === branchPath ||
                  (!original.headRef && source.path === headPath) ||
                  expectedNewDirectory(source))
              ),
          )
          .map((source) => ({
            ...source,
            // Directory membership, dev/ino/mode bind authority. APFS nlink also
            // counts files, so our native lock changes it without changing owner.
            identity:
              source.kind === "directory"
                ? source.identity.split(":").slice(0, 3).join(":")
                : source.identity,
            names:
              source.names?.filter(
                (name) =>
                  !allowed.some(
                    (lock) =>
                      path.join(o.context.root, ".git", lock) ===
                      path.join(source.path, name),
                  ) &&
                  !(
                    published &&
                    branchPath &&
                    (path.join(source.path, name) === branchPath ||
                      (branchPath.startsWith(
                        `${path.join(source.path, name)}/`,
                      ) &&
                        !b.sources.some(
                          (old) => old.path === path.join(source.path, name),
                        )))
                  ),
              ) ?? null,
          }));
      assertCommitSources(normalize(b.sources), normalize(policy.sources));
      const rawStatus = Buffer.from(await policy.git(statusArgs));
      await readNativeGitBlobStates(o.client, objectStates);
      const indexTuples =
        expected.index === "original"
          ? Buffer.from(b.indexTuples)
          : await this.native("ls-files", ["--stage", "-z"]);
      const indexFlags =
        expected.index === "original"
          ? Buffer.from(b.indexFlags)
          : await this.native("ls-files", ["-v", "-z"]);
      const head = published
        ? decode(await this.native("rev-parse", ["--verify", "HEAD"])).trim()
        : original.head;
      const headRef = published ? await this.headRef() : original.headRef;
      const refs = published
        ? await this.native("for-each-ref", [
            "--sort=refname",
            "--format=%(refname)%00%(objectname)%00%(symref)%00",
          ])
        : Buffer.from(b.refs);
      if (
        head !== (published ? expected.candidate : original.head) ||
        headRef !== original.headRef
      )
        throw stale();
      const headFile = policy.sources.find(
        (source) => source.path === path.join(o.context.root, ".git/HEAD"),
      );
      if (headFile?.sha256 !== sha(headRef ? `ref: ${headRef}\n` : `${head}\n`))
        throw stale();
      if (
        published &&
        headRef &&
        policy.sources.find(
          (source) =>
            source.path === path.join(o.context.root, ".git", headRef),
        )?.sha256 !== sha(`${head}\n`)
      )
        throw stale();
      const refsExceptCurrent = (bytes: Buffer) =>
        decode(bytes)
          .split("\n")
          .filter(
            (row) =>
              !original.headRef || !row.startsWith(`${original.headRef}\0`),
          )
          .join("\n");
      if (refsExceptCurrent(refs) !== refsExceptCurrent(b.refs)) throw stale();
      const attrs = await this.attributes(policy, b.preview.paths),
        policyFingerprint = this.policy(
          policy.configuration,
          attrs,
          indexFlags,
          b.preview.paths,
        );
      if (policyFingerprint !== original.policyFingerprint) throw stale();
      if ([0, 2, 3].includes(next))
        for (const [variable, identity] of [
          ["GIT_AUTHOR_IDENT", b.preview.author],
          ["GIT_COMMITTER_IDENT", b.preview.committer],
        ]) {
          const raw = await o.sourceGit(["var", variable]);
          if (/^(.+ <[^<>\n]+>) \d+ [+-]\d{4}\n?$/.exec(raw)?.[1] !== identity)
            throw stale();
        }
      const headTree =
        next === 0
          ? original.head
            ? commitEntries(
                await this.native("ls-tree", [
                  "-r",
                  "-z",
                  "--full-tree",
                  original.head,
                ]),
                true,
              )
            : new Map<string, string>()
          : undefined;
      await readback?.();
      if (!published) {
        if (!rawStatus.equals(b.rawStatus)) throw stale();
      } else checkStatus(rawStatus, head, headRef, o.paths);
      if (expected.index === "selected-published") {
        const entries = commitEntries(indexTuples);
        if (
          commitOutside(entries, b.preview.paths) !==
          commitOutside(commitEntries(b.indexTuples), b.preview.paths)
        )
          throw stale();
        for (const name of b.preview.paths)
          if (
            entries.get(name) !==
            (b.admission.blobs[name] === null
              ? undefined
              : `${b.admission.modes[name]} ${b.admission.blobs[name]}`)
          )
            throw stale();
      }
      return {
        policy,
        headTree,
        rawStatus,
        indexTuples,
        indexFlags,
        head,
        headRef,
        refs,
        policyFingerprint,
        attrs,
      };
    });
    // One authoritative owner read AFTER the first observation/readback and
    // its private cleanup, BEFORE every closing byte and status observation.
    const owner = await o.context.native!.owner();
    if (commitOwnerIdentity(owner) !== commitOwnerIdentity(original.owner))
      throw stale();
    // Two independent private observations, as in the legacy capture. Never run
    // live source status: a late filter definition must not execute. The second
    // scope sees paths created during the first cleanup or owner await, including
    // paths outside the original protected closure. This is a finite read-set,
    // not a claim of atomicity against a writer after its last status observation.
    const closing = await o.privateRead(async (policy) => {
      if (
        !policy.sources ||
        !policy.verifySources ||
        policy.policy !== read.policy.policy
      )
        throw stale();
      assertCommitSources(read.policy.sources!, policy.sources);
      if (!read.rawStatus.equals(Buffer.from(await policy.git(statusArgs))))
        throw stale();
      return policy;
    });
    // Close metadata and protected bodies after BOTH private cleanup awaits.
    await readNativeGitBlobStates(o.client, objectStates);
    if (
      read.policy.nativeAttributes &&
      read.attrs !==
        (await o.sourceGit([
          "check-attr",
          "-z",
          "--all",
          "--",
          ...b.preview.paths,
        ]))
    )
      throw stale();
    await read.policy.verify();
    const files = await readCommitProtectedFiles(o.context.root, o.paths);
    if (JSON.stringify(files) !== JSON.stringify(initialFiles)) throw stale();
    await read.policy.verifySources!();
    await closing.verifySources!();
    const controlFingerprint = await fingerprintNativeGitControls(
      o.context.root,
    );
    if (
      controlFingerprint !== original.controlFingerprint ||
      JSON.stringify(physical) !==
        JSON.stringify(await nativeGitPhysicalIdentity(o.context.root))
    )
      throw stale();
    await auditCommitMetadata(o.context.root, allowed);
    if ((await objectStorageIdentity(o.context.root)) !== b.storageIdentity)
      throw stale();
    const proof: CommitFreshProof = Object.freeze({
      phase: expected.phase,
      baselineRevision: original.revision,
      owner,
      ...physical,
      head: read.head,
      headRef: read.headRef,
      indexTuples: read.indexTuples,
      indexFlags: read.indexFlags,
      refs: read.refs,
      rawStatus: read.rawStatus,
      policyFingerprint: read.policyFingerprint,
      controlFingerprint,
      files,
      sourceSeal: jsonDigest(read.policy.sources),
    });
    if (next === 0) this.headTree = read.headTree;
    proofs.set(proof, jsonDigest(proof));
    assertCommitFreshProof(original, proof, expected.phase, !published);
    return proof;
  }
}
