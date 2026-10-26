import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  gitSequencerOperationRequestSchema,
  type GitSequencerOperationRequest,
} from "../shared/git-sequencer-operations";
import {
  directory,
  hash,
  identity,
  regular,
  stale,
  stat,
  type File,
} from "./git-conflict-state";
import {
  args,
  blob,
  matches,
  raw,
  rawKey,
  readTree,
  run,
  type GitRebaseOperationContext,
  type RawState,
  type Tree,
  type Entry,
} from "./git-rebase-operations-state";
import {
  parseStages,
  sameLayout,
  sourceCommit,
  treeKey,
  type SourceCommit,
} from "./git-rebase-continue-state";
import { CommandExitError } from "./process";

export type GitSequencerContext = GitRebaseOperationContext;
export const unsupportedSequencer = () =>
  Error(
    "Неподдерживаемое состояние cherry-pick/revert. Требуется подтверждённая линейная операция без нестандартных opts, mainline, посторонних правок или смешанных маркеров.",
  );
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const oid = (value: string) => {
  if (!/^[a-f0-9]{40}\n$/.test(value)) throw unsupportedSequencer();
  return value.slice(0, -1);
};
interface SequencerMetadata {
  files: Record<string, File>;
  directoryIdentity: string | null;
  branch: string;
  stopped: string;
  auto: string;
  original: string | null;
  safety: string | null;
  todo: { short: string; subject: string }[];
}
/** Exact, bounded metadata only. No ORIG_HEAD baseline, shell evaluation or
 * inferred opts. Abbreviated native todo OIDs are resolved below as commits. */
export function readSequencerMetadata(
  root: string,
  operation: "cherry-pick" | "revert",
  gd = path.join(root, ".git"),
): SequencerMetadata {
  const files: Record<string, File> = Object.create(null);
  directory(root);
  directory(gd);
  const marker =
    operation === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD";
  for (const n of [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "REBASE_HEAD",
    "BISECT_START",
    operation === "cherry-pick" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD",
  ])
    if (stat(path.join(gd, n))) throw unsupportedSequencer();
  for (const n of ["HEAD", marker, "AUTO_MERGE", "MERGE_MSG"]) {
    const file = regular(path.join(gd, n), 1024 * 1024);
    if (!file) throw unsupportedSequencer();
    files[n] = file;
  }
  const text = (n: string) => files[n].bytes.toString("utf8");
  const branch = /^ref: refs\/heads\/([^\0\r\n]+)\n$/.exec(text("HEAD"))?.[1];
  if (!branch) throw unsupportedSequencer();
  const stopped = oid(text(marker)),
    auto = oid(text("AUTO_MERGE"));
  const base = path.join(gd, "sequencer");
  let directoryIdentity: string | null = null,
    original: string | null = null,
    safety: string | null = null;
  const todo: SequencerMetadata["todo"] = [];
  if (stat(base)) {
    directoryIdentity = directory(base);
    const names = readdirSync(base).sort();
    if (!equal(names, ["abort-safety", "head", "todo"]))
      throw unsupportedSequencer();
    for (const n of names)
      files["sequencer/" + n] = regular(path.join(base, n), 1024 * 1024)!;
    original = oid(text("sequencer/head"));
    safety = oid(text("sequencer/abort-safety"));
    const todoText = text("sequencer/todo");
    if (!todoText.endsWith("\n")) throw unsupportedSequencer();
    const command = operation === "cherry-pick" ? "pick" : "revert";
    for (const line of todoText.slice(0, -1).split("\n")) {
      const m = /^(pick|revert) ([a-f0-9]{7,40}) ([^\0\r\n]*)$/.exec(line);
      if (!m || m[1] !== command) throw unsupportedSequencer();
      todo.push({ short: m[2], subject: m[3] });
    }
    if (!todo.length || todo.length > 128) throw unsupportedSequencer();
  }
  return {
    files,
    directoryIdentity,
    branch,
    stopped,
    auto,
    original,
    safety,
    todo,
  };
}
export interface SequencerState {
  root: string;
  owner: string;
  scope: string;
  revision: string;
  operation: "cherry-pick" | "revert";
  action: "continue" | "abort";
  branch: string;
  head: string;
  original: string;
  current: SourceCommit;
  remaining: SourceCommit[];
  completed: SourceCommit[];
  conflictPaths: string[];
  discardedResolutionPaths: string[];
  requiresCommitWarning: boolean;
  resolved: Tree;
  auto: Tree;
  originalTree: Tree;
  disk: RawState;
  stages: string;
  policy: string;
  metadata: SequencerMetadata;
}
export function sequencerStateKey(s: SequencerState): string {
  return hash(
    JSON.stringify([
      s.root,
      s.owner,
      s.scope,
      s.revision,
      s.operation,
      s.action,
      s.branch,
      s.head,
      s.original,
      s.current,
      s.remaining,
      s.completed,
      s.stages,
      s.policy,
      rawKey(s.disk),
      s.metadata.directoryIdentity,
      Object.entries(s.metadata.files).map(([n, f]) => [n, f.identity]),
      s.conflictPaths,
      s.discardedResolutionPaths,
      s.requiresCommitWarning,
      treeKey(s.resolved),
    ]),
  );
}
export function quoteSequencerPath(name: string) {
  const bytes = Buffer.from(name);
  if ([...bytes].every((b) => b >= 32 && b < 127 && b !== 34 && b !== 92))
    return name;
  const escapes: Record<number, string> = {
    7: "\\a",
    8: "\\b",
    9: "\\t",
    10: "\\n",
    11: "\\v",
    12: "\\f",
    13: "\\r",
    34: '\\"',
    92: "\\\\",
  };
  return (
    '"' +
    [...bytes]
      .map(
        (b) =>
          escapes[b] ??
          (b >= 32 && b < 127
            ? String.fromCharCode(b)
            : "\\" + b.toString(8).padStart(3, "0")),
      )
      .join("") +
    '"'
  );
}
export interface SequencerContentProof {
  tree: Tree;
  conflicts: Record<string, [Entry, Entry, Entry]>;
  bytes: Record<string, Buffer>;
}
/** Revert explicitly swaps source and parent. A matching source OID/message is
 * not proof of an inverse effect. Native merge-file predicts text only; it never
 * receives a worktree destination, changes an index or executes a sequencer. */
export async function sequencerContentProof(
  c: GitSequencerContext,
  operation: "cherry-pick" | "revert",
  head: Tree,
  source: SourceCommit,
  known: ReadonlyMap<string, Buffer> = new Map(),
): Promise<SequencerContentProof> {
  const parent = await readTree(c, source.parent),
    base = operation === "revert" ? source.tree : parent,
    incoming = operation === "revert" ? parent : source.tree;
  sameLayout(head, base, incoming);
  const tree = structuredClone(head),
    conflicts: SequencerContentProof["conflicts"] = Object.create(null);
  const changed = Object.keys(base).filter((n) => !equal(base[n], incoming[n]));
  if (!changed.length || changed.length > 32) throw unsupportedSequencer();
  const short = (await run(c, ["rev-parse", "--short", source.oid])).trim(),
    subject = (await run(c, ["show", "-s", "--format=%s", source.oid])).replace(
      /\n$/,
      "",
    );
  if (!/^[a-f0-9]+$/.test(short) || /[\0\r\n]/.test(subject))
    throw unsupportedSequencer();
  const bytes: Record<string, Buffer> = Object.create(null);
  for (const n of changed) {
    const o = head[n],
      b = base[n],
      t = incoming[n];
    let result: Buffer;
    if (o.oid === b.oid) result = await blob(c, t.oid);
    else if (o.oid === t.oid || b.oid === t.oid)
      result = await (known.has(o.oid)
        ? Promise.resolve(known.get(o.oid)!)
        : blob(c, o.oid));
    else {
      const values = await Promise.all([
          known.has(o.oid)
            ? Promise.resolve(known.get(o.oid)!)
            : blob(c, o.oid),
          blob(c, b.oid),
          blob(c, t.oid),
        ]),
        temp = await fs.mkdtemp("/private/tmp/goga-sequencer-proof-");
      try {
        await fs.chmod(temp, 0o700);
        for (const [i, name] of ["ours", "base", "theirs"].entries())
          await fs.writeFile(path.join(temp, name), values[i], {
            flag: "wx",
            mode: 0o600,
          });
        try {
          result = Buffer.from(
            (
              await c.isolatedGit(
                args(c.root, [
                  "-c",
                  "merge.conflictStyle=merge",
                  "merge-file",
                  "--diff-algorithm=histogram",
                  "--stdout",
                  "-L",
                  "HEAD",
                  "-L",
                  "base",
                  "-L",
                  `${operation === "revert" ? "parent of " : ""}${short} (${subject})`,
                  ...["ours", "base", "theirs"].map((name) =>
                    path.join(temp, name),
                  ),
                ]),
              )
            ).stdout,
          );
        } catch (e) {
          if (
            !(e instanceof CommandExitError) ||
            e.exitCode === null ||
            e.exitCode < 1 ||
            e.exitCode > 127 ||
            typeof e.stdout !== "string"
          )
            throw e;
          result = Buffer.from(e.stdout);
          conflicts[n] = [b, o, t];
        }
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    }
    if (
      result.length > 1024 * 1024 ||
      result.includes(0) ||
      !Buffer.from(result.toString("utf8")).equals(result)
    )
      throw unsupportedSequencer();
    bytes[n] = result;
    tree[n] = { mode: o.mode, oid: identity(result, 40) };
  }
  return { tree, conflicts, bytes };
}
export async function captureSequencer(
  c: GitSequencerContext,
  input: GitSequencerOperationRequest,
): Promise<SequencerState> {
  const request = gitSequencerOperationRequestSchema.parse(input);
  if (!equal(request.scope, c.scope)) throw stale();
  await c.verify();
  const owner = c.ownerKey,
    ownerRoot = c.root,
    ownerScope = JSON.stringify(c.scope),
    disk = raw(c.root),
    op = readSequencerMetadata(c.root, request.operation),
    ref = `refs/heads/${op.branch}`;
  if (typeof c.scope !== "string" && c.scope.branch !== op.branch)
    throw stale();
  await run(c, ["check-ref-format", ref]);
  const gd = path.join(c.root, ".git");
  directory(path.dirname(path.join(gd, ref)));
  const direct = regular(path.join(gd, ref));
  if (direct) oid(direct.bytes.toString());
  for (const n of [
    "index.lock",
    "HEAD.lock",
    "config.lock",
    "packed-refs.lock",
    ref + ".lock",
  ])
    if (stat(path.join(gd, n)))
      throw Error("Репозиторий занят другой операцией Git.");
  if (
    stat(path.join(gd, "config.worktree")) ||
    stat(path.join(gd, "info/attributes"))
  )
    throw unsupportedSequencer();
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
      value = (at < 0 ? "" : row.slice(at + 1)).toLowerCase();
    if (
      /^(filter|include|includeif|merge|rebase|sequencer|extensions)\./.test(
        key,
      ) ||
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
      throw unsupportedSequencer();
  }
  const snapshot = await c.snapshot();
  const head = oid(await run(c, ["rev-parse", "--verify", ref]));
  if (
    snapshot.root !== c.root ||
    !equal(snapshot.scope, c.scope) ||
    snapshot.revision !== request.revision ||
    snapshot.head !== head ||
    snapshot.branch !== op.branch ||
    snapshot.operation !== request.operation
  )
    throw stale();
  if (op.safety !== null && op.safety !== head) throw unsupportedSequencer();
  const original = op.original ?? head,
    current = await sourceCommit(c, op.stopped),
    remaining: SourceCommit[] = [],
    completed: SourceCommit[] = [];
  if (op.todo.length) {
    for (const [i, entry] of op.todo.entries()) {
      const resolved = oid(
        await run(c, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${entry.short}^{commit}`,
        ]),
      );
      if (
        !resolved.startsWith(entry.short) ||
        (i === 0 && resolved !== current.oid)
      )
        throw unsupportedSequencer();
      const source = i === 0 ? current : await sourceCommit(c, resolved);
      const subject = (
        await run(c, ["show", "-s", "--format=%s", resolved])
      ).replace(/\n$/, "");
      if (subject !== entry.subject) throw unsupportedSequencer();
      if (i) remaining.push(source);
    }
  }
  if (
    new Set([current, ...remaining].map((s) => s.oid)).size !==
    1 + remaining.length
  )
    throw unsupportedSequencer();
  // Sequencer's own abort baseline, pinned with current abort-safety. Completed
  // history must be a finite ordinary parent chain rooted in that exact commit.
  if (original !== head) {
    const ids = (
      await run(c, [
        "rev-list",
        "--first-parent",
        "--reverse",
        "--max-count=129",
        `${original}..${head}`,
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (!ids.length || ids.length > 128) throw unsupportedSequencer();
    let previous = original;
    for (const id of ids) {
      const commit = await sourceCommit(c, id);
      if (commit.parent !== previous) throw unsupportedSequencer();
      completed.push(commit);
      previous = id;
    }
    if (previous !== head) throw unsupportedSequencer();
  }
  // A native todo does not retain completed commands. For an imported linear
  // cherry-pick, prove the completed prefix against the source ancestry rather
  // than treating any ancestor in sequencer/head as an authorized abort target.
  // Revert records the reverted OID in each canonical commit message.
  const completedSources: SourceCommit[] = [];
  if (request.operation === "cherry-pick") {
    let sourceParent = current.parent;
    for (let i = completed.length - 1; i >= 0; i--) {
      const source = await sourceCommit(c, sourceParent);
      completedSources.unshift(source);
      sourceParent = source.parent;
    }
  } else {
    for (const commit of completed) {
      const sourceOID = /\n\nThis reverts commit ([a-f0-9]{40})\.\n$/.exec(
        commit.message,
      )?.[1];
      if (!sourceOID) throw unsupportedSequencer();
      completedSources.push(await sourceCommit(c, sourceOID));
    }
  }
  let precedingTree = await readTree(c, original);
  for (const [i, commit] of completed.entries()) {
    const source = completedSources[i];
    const subject = (
      await run(c, ["show", "-s", "--format=%s", source.oid])
    ).replace(/\n$/, "");
    const expected =
      request.operation === "cherry-pick"
        ? source.message
        : `Revert "${subject}"\n\nThis reverts commit ${source.oid}.\n`;
    if (
      commit.message !== expected ||
      (request.operation === "cherry-pick" && commit.author !== source.author)
    )
      throw unsupportedSequencer();
    const proof = await sequencerContentProof(
      c,
      request.operation,
      precedingTree,
      source,
    );
    sameLayout(commit.tree, proof.tree);
    for (const [name, entry] of Object.entries(proof.tree)) {
      if (!proof.conflicts[name] && !equal(entry, commit.tree[name]))
        throw unsupportedSequencer();
      await blob(c, commit.tree[name].oid);
    }
    precedingTree = commit.tree;
  }
  const sources = [...completedSources, current, ...remaining];
  for (let i = 1; i < sources.length; i++) {
    if (
      request.operation === "cherry-pick"
        ? sources[i].parent !== sources[i - 1].oid
        : sources[i - 1].parent !== sources[i].oid
    )
      throw unsupportedSequencer();
  }
  const headTree = await readTree(c, head),
    originalTree = await readTree(c, original),
    auto = await readTree(c, op.auto),
    proof = await sequencerContentProof(
      c,
      request.operation,
      headTree,
      current,
    );
  sameLayout(originalTree, headTree, auto);
  if (treeKey(proof.tree) !== treeKey(auto)) throw unsupportedSequencer();
  const conflictPaths = Object.keys(proof.conflicts).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  if (!conflictPaths.length) throw unsupportedSequencer();
  const subject = (
    await run(c, ["show", "-s", "--format=%s", current.oid])
  ).replace(/\n$/, "");
  const expectedMessage =
    (request.operation === "cherry-pick"
      ? current.message
      : `Revert "${subject}"\n\nThis reverts commit ${current.oid}.\n`) +
    `\n# Conflicts:\n${conflictPaths.map((n) => "#\t" + quoteSequencerPath(n) + "\n").join("")}`;
  if (!op.files.MERGE_MSG.bytes.equals(Buffer.from(expectedMessage)))
    throw unsupportedSequencer();
  const stages = await run(c, ["ls-files", "--stage", "-z"]),
    entries = parseStages(stages),
    resolved: Tree = Object.create(null),
    discardedResolutionPaths: string[] = [];
  if (entries.size !== Object.keys(auto).length) throw unsupportedSequencer();
  if (
    (await run(c, ["ls-files", "-v", "-z"]))
      .split("\0")
      .some((row) => /^[a-zS] /.test(row))
  )
    throw unsupportedSequencer();
  for (const [name, expected] of Object.entries(auto)) {
    const e = entries.get(name),
      file = disk.files[name],
      conflict = proof.conflicts[name];
    if (!e || !file) throw unsupportedSequencer();
    if (e.size === 1 && e.has(0)) {
      const entry = e.get(0)!;
      if (
        !matches(file, entry) ||
        entry.mode !== expected.mode ||
        (!conflict && !equal(entry, expected))
      )
        throw unsupportedSequencer();
      // Verify even staged solution blobs, never trust lossy text or an absent object.
      await blob(c, entry.oid);
      resolved[name] = entry;
      if (conflict) discardedResolutionPaths.push(name);
    } else {
      if (
        !conflict ||
        e.size !== 3 ||
        conflict.some((x, i) => !equal(x, e.get(i + 1)))
      )
        throw unsupportedSequencer();
      if (request.action === "continue")
        throw Error("Сначала разрешите и сохраните все конфликты.");
      if (
        file.mode !== (expected.mode === "100755" ? 0o755 : 0o644) ||
        file.bytes.includes(0) ||
        !Buffer.from(file.bytes.toString("utf8")).equals(file.bytes)
      )
        throw unsupportedSequencer();
      if (!matches(file, expected)) discardedResolutionPaths.push(name);
    }
  }
  if (request.action === "continue" && treeKey(resolved) === treeKey(headTree))
    throw Error(
      "Пустой результат операции: автоматический пропуск коммита не выполняется.",
    );
  // Original tree blobs must be readable without filters and within text limits.
  let originalBytes = Object.entries(disk.files)
    .filter(([name]) => !auto[name])
    .reduce((sum, [, file]) => sum + file.bytes.length, 0);
  for (const e of Object.values(originalTree)) {
    originalBytes += (await blob(c, e.oid)).length;
    if (originalBytes > 32 * 1024 * 1024) throw unsupportedSequencer();
  }
  await c.verifyOwner();
  await c.verify();
  if (
    c.ownerKey !== owner ||
    c.root !== ownerRoot ||
    JSON.stringify(c.scope) !== ownerScope ||
    rawKey(raw(c.root)) !== rawKey(disk)
  )
    throw stale();
  return {
    root: c.root,
    owner,
    scope: JSON.stringify(c.scope),
    revision: request.revision,
    operation: request.operation,
    action: request.action,
    branch: op.branch,
    head,
    original,
    current,
    remaining,
    completed,
    conflictPaths,
    discardedResolutionPaths: discardedResolutionPaths.sort(),
    requiresCommitWarning:
      request.operation === "revert" && !op.directoryIdentity,
    resolved,
    auto,
    originalTree,
    disk,
    stages,
    policy,
    metadata: op,
  };
}
