import { applyDirectProof } from "./git-rebase-apply";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { identity, hash, stale, regular } from "./git-conflict-state";
import {
  args,
  run,
  capture,
  raw,
  rawKey,
  stateKey,
  readOperation,
  readTree,
  blob,
  matches,
  type Tree,
  type Entry,
  type RebaseState,
  type GitRebaseOperationContext,
} from "./git-rebase-operations-state";
import { CommandExitError } from "./process";
export const refuse = () =>
  Error(
    "Продолжение поддерживает только resolved linear rebase --merge/--apply: существующие текстовые пути без изменения modes, до следующего конфликта или конца проверенной последовательности, без посторонних staged/unstaged правок, signing/attributes/filters/редакторов/нестандартных сообщений.",
  );
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const treeKey = (t: Tree) =>
  JSON.stringify(
    Object.entries(t).sort(([a], [b]) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    ),
  );
export function sameLayout(...trees: Tree[]) {
  const shape = (t: Tree) =>
    JSON.stringify(
      Object.entries(t)
        .map(([n, e]) => [n, e.mode])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  if (trees.some((t) => shape(t) !== shape(trees[0]))) throw refuse();
}
export function parseStages(value: string): Map<string, Map<number, Entry>> {
  const result = new Map<string, Map<number, Entry>>();
  for (const row of value.split("\0").filter(Boolean)) {
    const m = /^(100644|100755) ([a-f0-9]{40}) ([0123])\t([^\0]+)$/.exec(row);
    if (!m) throw refuse();
    const entries = result.get(m[4]) ?? new Map<number, Entry>();
    if (entries.has(+m[3])) throw refuse();
    entries.set(+m[3], { mode: m[1], oid: m[2] });
    result.set(m[4], entries);
  }
  return result;
}
export function stageText(
  tree: Tree,
  conflicts: Record<string, [Entry, Entry, Entry]> = {},
) {
  return Object.keys(tree)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((n) =>
      conflicts[n]
        ? conflicts[n]
            .map((e, i) => `${e.mode} ${e.oid} ${i + 1}\t${n}\0`)
            .join("")
        : `${tree[n].mode} ${tree[n].oid} 0\t${n}\0`,
    )
    .join("");
}
export interface SourceCommit {
  oid: string;
  parent: string;
  author: string;
  message: string;
  tree: Tree;
}
export async function sourceCommit(
  c: GitRebaseOperationContext,
  oid: string,
): Promise<SourceCommit> {
  const text = await run(c, ["cat-file", "commit", oid]),
    at = text.indexOf("\n\n"),
    header = text.slice(0, at).split("\n"),
    message = text.slice(at + 2);
  const commitBytes = Buffer.from(text);
  if (
    createHash("sha1")
      .update(`commit ${commitBytes.length}\0`)
      .update(commitBytes)
      .digest("hex") !== oid
  )
    throw refuse();
  // Native default edited-message cleanup must be identity-preserving. Refuse
  // comments, trailing whitespace, blank edges and special commit headers.
  if (
    at < 0 ||
    at > 8192 ||
    header.length !== 4 ||
    !/^tree [a-f0-9]{40}$/.test(header[0]) ||
    !/^parent [a-f0-9]{40}$/.test(header[1]) ||
    !/^author .+ <[^<>\r\n]+> [0-9]+ [+-][0-9]{4}$/.test(header[2]) ||
    !header[3].startsWith("committer ") ||
    !message.endsWith("\n") ||
    message.startsWith("\n") ||
    message.endsWith("\n\n") ||
    /[\0\r]/.test(message) ||
    message.split("\n").some((l) => l.startsWith("#") || /[ \t]$/.test(l))
  )
    throw refuse();
  return {
    oid,
    parent: header[1].slice(7),
    author: header[2],
    message,
    tree: await readTree(c, oid),
  };
}
export interface MergeProof {
  tree: Tree;
  conflicts: Record<string, [Entry, Entry, Entry]>;
  bytes: Record<string, Buffer>;
  patchUpperBound: number;
}
/** Content proof only: native merge-file predicts same-path regular text content.
 * It never creates commits, changes todo, publishes objects or runs a sequencer. */
export async function contentProof(
  c: GitRebaseOperationContext,
  ours: Tree,
  base: Tree,
  source: SourceCommit,
  known: ReadonlyMap<string, Buffer> = new Map(),
  backend: "merge" | "apply" = "merge",
): Promise<MergeProof> {
  sameLayout(ours, base, source.tree);
  const tree: Tree = structuredClone(ours),
    conflicts: MergeProof["conflicts"] = Object.create(null),
    bytes: Record<string, Buffer> = Object.create(null);
  const changed = Object.keys(base).filter(
    (n) => !equal(base[n], source.tree[n]),
  );
  if (!changed.length || changed.length > 32) throw refuse();
  const short = (await run(c, ["rev-parse", "--short", source.oid])).trim(),
    subject = (await run(c, ["show", "-s", "--format=%s", source.oid])).replace(
      /\n$/,
      "",
    );
  if (!/^[a-f0-9]+$/.test(short) || /[\0\r\n]/.test(subject)) throw refuse();
  const direct =
    backend === "apply"
      ? await applyDirectProof(c, ours, source, changed, known)
      : null;
  let patchUpperBound = 0;
  for (const name of changed) {
    const o = ours[name],
      b = base[name],
      t = source.tree[name];
    const values = await Promise.allSettled([
      known.has(o.oid) ? Promise.resolve(known.get(o.oid)!) : blob(c, o.oid),
      blob(c, b.oid),
      blob(c, t.oid),
    ]);
    const failed = values.find((v) => v.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const [ov, bv, tv] = values.map(
      (v) => (v as PromiseFulfilledResult<Buffer>).value,
    );
    // A unified patch cannot emit more input lines than both versions contain.
    // Bound every such line as a separate hunk, including an untruncated function
    // context line. This intentionally overestimates native's patch (no replay).
    const lines = [bv, tv].map((v) => {
      let count = 0,
        longest = 0,
        length = 0;
      for (const byte of v) {
        if (byte === 10) {
          count++;
          longest = Math.max(longest, length);
          length = 0;
        } else length++;
      }
      if (length) count++;
      return { count, longest: Math.max(longest, length) };
    });
    patchUpperBound +=
      bv.length +
      tv.length +
      (lines[0].count + lines[1].count) *
        (128 + Math.max(lines[0].longest, lines[1].longest)) +
      16 * Buffer.byteLength(name) +
      1024;
    let result: Buffer,
      conflict = false;
    if (direct) result = direct[name];
    else if (o.oid === b.oid) result = tv;
    else if (o.oid === t.oid || b.oid === t.oid) result = ov;
    else {
      const temp = await fs.mkdtemp("/private/tmp/goga-continue-proof-");
      try {
        for (const [n, v] of [
          ["ours", ov],
          ["base", bv],
          ["theirs", tv],
        ] as const)
          await fs.writeFile(path.join(temp, n), v, {
            mode: 0o600,
            flag: "wx",
          });
        try {
          result = Buffer.from(
            (
              await c.isolatedGit(
                args(c.root, [
                  "-c",
                  "merge.conflictStyle=merge",
                  "merge-file",
                  // Native ORT uses histogram; merge-file otherwise uses Myers.
                  backend === "apply"
                    ? "--diff-algorithm=myers"
                    : "--diff-algorithm=histogram",
                  "--stdout",
                  "-L",
                  "HEAD",
                  "-L",
                  "base",
                  "-L",
                  backend === "apply" ? subject : `${short} (${subject})`,
                  ...["ours", "base", "theirs"].map((n) => path.join(temp, n)),
                ]),
              )
            ).stdout,
          );
        } catch (e) {
          // This valid content-only invocation is also the capability check.
          // Never fall back to a different proof, or relabel cancellation/fatal
          // runner failures as unsupported Git. Nothing live has been written.
          if (e instanceof CommandExitError && e.exitCode === 129)
            throw Error(
              `Git отклонил проверку merge-file --diff-algorithm=${backend === "apply" ? "myers" : "histogram"}; продолжение rebase недоступно в этой конфигурации Git.`,
              { cause: e },
            );
          if (
            !(e instanceof CommandExitError) ||
            e.exitCode === null ||
            e.exitCode < 1 ||
            e.exitCode > 127
          )
            throw e;
          result = Buffer.from(e.stdout);
          conflict = true;
        }
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    }
    if (result.length > 1024 * 1024 || result.includes(0)) throw refuse();
    bytes[name] = result;
    tree[name] = { mode: o.mode, oid: identity(result, 40) };
    if (conflict) conflicts[name] = [b, o, t];
  }
  return { tree, conflicts, bytes, patchUpperBound };
}
export interface ContinueState {
  base: RebaseState;
  key: string;
  current: SourceCommit;
  remaining: SourceCommit[];
  todoLines: string[];
  steps: { source: SourceCommit; proof: MergeProof }[];
  resolved: Tree;
  resultTree: Tree;
  changedBytes: Record<string, Buffer>;
  paths: string[];
  committer: string;
  config: string;
  policy: string;
}
export async function continuationPolicy(
  c: GitRebaseOperationContext,
  backend: "merge" | "apply" = "merge",
) {
  const policy = (
    await c.git(["--no-optional-locks", "config", "--null", "--list"])
  ).stdout;
  for (const row of policy.split("\0").filter(Boolean)) {
    const at = row.indexOf("\n"),
      key = (at < 0 ? row : row.slice(0, at)).toLowerCase(),
      value = at < 0 ? "" : row.slice(at + 1).toLowerCase();
    if (
      /^(filter|include|includeif|merge|rebase|notes|i18n|extensions)\./.test(
        key,
      ) ||
      (backend === "apply" &&
        (/^(format|am|apply|mailinfo|mailmap|diff|log)\./.test(key) ||
          (key === "core.quotepath" && value !== "true"))) ||
      [
        "commit.cleanup",
        "commit.template",
        "core.commentchar",
        "core.commentstring",
        "core.worktree",
        "core.attributesfile",
        "core.alternaterefscommand",
        "core.sparsecheckout",
        "core.sparsecheckoutcone",
      ].includes(key) ||
      (key === "core.autocrlf" && value !== "false") ||
      (key === "core.eol" && !["lf", "native"].includes(value))
    )
      throw refuse();
  }
  // args() supplies safe -c merge/rebase settings itself: these are not user policy.
  const sign = (
    await c.git([
      "config",
      "--type=bool",
      "--default=false",
      "--get",
      "commit.gpgsign",
    ])
  ).stdout;
  if (sign !== "false\n") throw refuse();
  const ident = (await c.git(["var", "GIT_COMMITTER_IDENT"])).stdout,
    m = /^(.+) <([^<>\r\n]+)> [0-9]+ [+-][0-9]{4}\n$/.exec(ident);
  if (!m || Buffer.byteLength(ident) > 4096 || /[\0\r\n]/.test(m[1]))
    throw refuse();
  const quote = (v: string) =>
    `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
  return {
    policy,
    committer: `${m[1]} <${m[2]}>`,
    config: `[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nlogallrefupdates = false\n[user]\nname = ${quote(m[1])}\nemail = ${quote(m[2])}\n`,
  };
}

/** Conservative envelope for the complete proven prefix up to the next conflict.
 * Every intermediate native tree/blob/commit counts, not just the final tree. */
function outputEnvelope(
  s: RebaseState,
  resolved: Tree,
  current: SourceCommit,
  steps: ContinueState["steps"],
  committer: string,
) {
  const dirs = new Map<string, Map<string, string>>([["", new Map()]]);
  for (const [n, e] of Object.entries(resolved)) {
    const parts = n.split("/");
    let parent = "";
    for (let i = 0; i < parts.length; i++) {
      const entries = dirs.get(parent)!;
      entries.set(parts[i], i === parts.length - 1 ? e.mode : "40000");
      if (i < parts.length - 1) {
        parent = parts.slice(0, i + 1).join("/");
        if (!dirs.has(parent)) dirs.set(parent, new Map());
      }
    }
  }
  const treeSizes = [...dirs.values()].map((entries) =>
    [...entries].reduce(
      (sum, [n, mode]) => sum + Buffer.byteLength(n) + mode.length + 22,
      0,
    ),
  );
  // Actual UTF-8 identities, plus ample fixed tree/parent/date/header overhead.
  // The extra 4 KiB also covers zlib framing/expansion below the 2 MiB cap.
  const commitSizes = [current, ...steps.map((s) => s.source)].map(
    (commit) =>
      Buffer.byteLength(commit.message) +
      Buffer.byteLength(commit.author) +
      Buffer.byteLength(committer) +
      512,
  );
  const invalidMetadata = steps.some(({ source, proof }) => {
    const messageSize = Buffer.byteLength(source.message);
    const mergeMessageSize =
      messageSize +
      128 +
      Object.keys(proof.conflicts).reduce(
        (sum, n) => sum + 4 * Buffer.byteLength(n) + 32,
        0,
      );
    return (
      messageSize + 1 > 1024 * 1024 ||
      mergeMessageSize > 1024 * 1024 ||
      proof.patchUpperBound > 1024 * 1024
    );
  });
  if (commitSizes.some((n) => n + 4096 > 2 * 1024 * 1024) || invalidMetadata)
    throw refuse();
  const blobs = steps.flatMap(({ proof }) => Object.values(proof.bytes)),
    objects =
      3 * (steps.length + 1) * dirs.size +
      3 * blobs.length +
      commitSizes.length;
  const bytes =
    3 * (steps.length + 1) * treeSizes.reduce((a, b) => a + b, 0) +
    3 * blobs.reduce((a, b) => a + b.length, 0) +
    commitSizes.reduce((a, b) => a + b, 0) +
    objects * 4096;
  // Bound the peak worktree too, not only the last prefix result.
  const lengths = new Map(
    Object.entries(s.disk.files).map(([n, f]) => [n, f.bytes.length]),
  );
  let projected = [...lengths.values()].reduce((a, b) => a + b, 0);
  for (const { proof } of steps) {
    for (const [n, bytes] of Object.entries(proof.bytes))
      lengths.set(n, bytes.length);
    projected = Math.max(
      projected,
      [...lengths.values()].reduce((a, b) => a + b, 0),
    );
  }
  if (
    objects > 256 ||
    treeSizes.some((n) => n + 4096 > 2 * 1024 * 1024) ||
    bytes > 32 * 1024 * 1024 ||
    projected > 32 * 1024 * 1024
  )
    throw refuse();
}

export async function captureContinue(
  c: GitRebaseOperationContext,
  revision: string,
): Promise<ContinueState> {
  c.assertPublicationOwner?.();
  const s = await capture(c, revision, "continue"),
    op = readOperation(c.root),
    stages = parseStages(s.stages),
    resolved: Tree = Object.create(null);
  if (s.head.length !== 40) throw refuse();
  for (const [n, e] of stages) {
    if (e.size !== 1 || !e.has(0)) throw refuse();
    resolved[n] = e.get(0)!;
  }
  const current = await sourceCommit(c, s.stopped),
    head = await readTree(c, s.head),
    base = await readTree(c, current.parent);
  // Native merge-rebase may already have staged clean topic-only additions
  // alongside the stopped content conflict. Continuing only commits those
  // existing bytes: it must not introduce a new destination or permit add/add,
  // delete/modify, mode changes, or new files in later picks.
  const additions =
    s.backend === "merge"
      ? Object.keys(current.tree).filter((n) => !head[n] && !base[n])
      : [];
  const currentProof = additions.length
    ? {
        ...current,
        tree: Object.fromEntries(
          Object.entries(current.tree).filter(([n]) => !additions.includes(n)),
        ),
      }
    : current;
  sameLayout(head, base, currentProof.tree);
  sameLayout(s.auto, resolved, current.tree, s.originalTree);
  if (
    new Set([
      ...additions,
      ...Object.keys(base).filter((n) => !equal(base[n], current.tree[n])),
    ]).size > 32
  )
    throw refuse();
  for (const n of additions) {
    if (
      current.tree[n].mode !== "100644" ||
      !equal(resolved[n], current.tree[n]) ||
      !matches(s.disk.files[n], current.tree[n])
    )
      throw refuse();
    // Validate bounded, losslessly transported UTF-8; never trust a blob OID
    // alone as proof of supported source bytes.
    await blob(c, current.tree[n].oid);
  }
  const baseline = await contentProof(
      c,
      head,
      base,
      currentProof,
      new Map(),
      s.backend,
    ),
    conflictNames = Object.keys(baseline.conflicts);
  for (const n of additions) baseline.tree[n] = current.tree[n];
  if (
    !conflictNames.length ||
    treeKey(baseline.tree) !== treeKey(s.auto) ||
    treeKey(resolved) === treeKey(head)
  )
    throw refuse();
  if (op.backend === "merge" && op.text("message") !== current.message + "\n")
    throw refuse();
  for (const n of Object.keys(resolved)) {
    if (!matches(s.disk.files[n], resolved[n])) throw refuse();
    if (!baseline.conflicts[n] && !equal(resolved[n], s.auto[n]))
      throw refuse();
    if (baseline.conflicts[n]) await blob(c, resolved[n].oid);
  }
  const todo =
    op.backend === "apply"
      ? op.commands.slice(op.current).map((oid) => `pick ${oid}`)
      : op
          .text("git-rebase-todo")
          .split("\n")
          .filter((l) => l && !l.startsWith("#"));
  if (
    op.backend === "merge" &&
    op.text("git-rebase-todo") !== todo.map((l) => l + "\n").join("")
  )
    throw refuse();
  const remaining: SourceCommit[] = [];
  let parent = current;
  for (const line of todo) {
    const source = await sourceCommit(c, line.split(" ")[1]);
    if (source.parent !== parent.oid) throw refuse();
    sameLayout(parent.tree, source.tree, resolved);
    remaining.push(source);
    parent = source;
  }
  const policy = await continuationPolicy(c, s.backend);
  const steps: ContinueState["steps"] = [],
    known = new Map<string, Buffer>();
  const changedBytes: Record<string, Buffer> = Object.create(null);
  let resultTree = resolved;
  parent = current;
  for (const source of remaining) {
    const proof = await contentProof(
      c,
      resultTree,
      parent.tree,
      source,
      known,
      s.backend,
    );
    const conflict = Object.keys(proof.conflicts).length > 0;
    if (!conflict && treeKey(proof.tree) === treeKey(resultTree))
      throw refuse();
    steps.push({ source, proof });
    outputEnvelope(s, resolved, current, steps, policy.committer);
    Object.assign(changedBytes, proof.bytes);
    for (const [n, bytes] of Object.entries(proof.bytes))
      known.set(proof.tree[n].oid, bytes);
    resultTree = proof.tree;
    parent = source;
    if (conflict) break;
  }
  const paths = [
    ...new Set([...conflictNames, ...Object.keys(changedBytes)]),
  ].sort();
  // Every future destination already exists with exact spelling and mode in the
  // physical inventory. No additions or directories can overwrite ignored data.
  for (const n of paths)
    if (
      !s.disk.files[n] ||
      regular(path.join(c.root, n))?.identity !== s.disk.files[n].identity
    )
      throw stale();
  outputEnvelope(s, resolved, current, steps, policy.committer);
  if (rawKey(raw(c.root)) !== rawKey(s.disk)) throw stale();
  await c.verify();
  return {
    base: s,
    current,
    remaining,
    todoLines: todo,
    steps,
    resolved,
    resultTree,
    changedBytes,
    paths,
    ...policy,
    key: hash(
      JSON.stringify([
        stateKey(s),
        policy,
        treeKey(resolved),
        remaining.map((s) => s.oid),
      ]),
    ),
  };
}
