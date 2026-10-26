import * as fs from "node:fs/promises";
import path from "node:path";
import {
  directory,
  regular,
  safe,
  stale,
  type File,
} from "./git-conflict-state";
import {
  blob,
  run,
  type GitRebaseOperationContext,
  type Tree,
} from "./git-rebase-operations-state";
import {
  readApplyOperation,
  validateApplyMetadata,
  refuseApply,
} from "./git-rebase-apply-state";
import type { ContinueState, SourceCommit } from "./git-rebase-continue-state";
import { CommandExitError } from "./process";

/** Predict Git-am's first (direct patch) attempt on bounded private text inputs.
 * No repository is initialized, no live index/objects/refs/worktree are written.
 * A failed direct application falls back to native three-way content proof. */
export async function applyDirectProof(
  c: GitRebaseOperationContext,
  ours: Tree,
  source: SourceCommit,
  changed: string[],
  known: ReadonlyMap<string, Buffer>,
): Promise<Record<string, Buffer> | null> {
  const patch = await run(c, [
    "-c",
    "diff.algorithm=myers",
    "diff-tree",
    "--no-commit-id",
    "-p",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    source.parent,
    source.oid,
  ]);
  if (!patch || Buffer.byteLength(patch) > 1024 * 1024) throw refuseApply();
  const temp = await fs.mkdtemp("/private/tmp/goga-apply-proof-");
  try {
    await fs.chmod(temp, 0o700);
    const work = path.join(temp, "work");
    await fs.mkdir(work, { mode: 0o700 });
    for (const n of changed) {
      await fs.mkdir(path.dirname(path.join(work, n)), {
        recursive: true,
        mode: 0o700,
      });
      const bytes = known.get(ours[n].oid) ?? (await blob(c, ours[n].oid));
      await fs.writeFile(path.join(work, n), bytes, {
        flag: "wx",
        mode: ours[n].mode === "100755" ? 0o755 : 0o644,
      });
    }
    const patchFile = path.join(temp, "input.patch");
    await fs.writeFile(patchFile, patch, { flag: "wx", mode: 0o600 });
    try {
      await c.isolatedGit([
        ...safe,
        `--git-dir=${path.join(temp, "no-repository")}`,
        `--work-tree=${work}`,
        "-C",
        work,
        "-c",
        "core.attributesFile=/dev/null",
        "apply",
        "--no-index",
        "--whitespace=nowarn",
        "--",
        patchFile,
      ]);
    } catch (e) {
      if (e instanceof CommandExitError && e.exitCode === 1) return null;
      throw e;
    }
    const result: Record<string, Buffer> = Object.create(null);
    for (const n of changed) {
      const file = regular(path.join(work, n), 1024 * 1024);
      if (
        !file ||
        file.bytes.includes(0) ||
        !Buffer.from(file.bytes.toString("utf8")).equals(file.bytes) ||
        file.mode !== (ours[n].mode === "100755" ? 0o755 : 0o644)
      )
        throw refuseApply();
      result[n] = file.bytes;
    }
    return result;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** Apply-specific postcondition. Native data is revalidated against source
 * commits and the proven prefix before the shared engine publishes anything. */
export async function verifyApplyNext(
  c: GitRebaseOperationContext,
  s: ContinueState,
  native: string,
  actualCommits: SourceCommit[],
): Promise<Map<string, File>> {
  const op = readApplyOperation(c.root, native),
    old = s.base.operationFiles;
  await validateApplyMetadata(c, op);
  const oldText = (n: string) =>
    old[`rebase-apply/${n}`]?.bytes.toString("utf8") ?? "";
  if (
    op.current !== Number(oldText("next")) + s.steps.length ||
    op.total !== Number(oldText("last"))
  )
    throw stale();
  const changing = new Set([
    "next",
    "abort-safety",
    "original-commit",
    "author-script",
    "final-commit",
    "patch",
    "patch-merge-index",
    "rewritten",
  ]);
  for (const [n, f] of Object.entries(old)) {
    if (!n.startsWith("rebase-apply/") || changing.has(n.slice(13))) continue;
    if (!op.files[n]?.bytes.equals(f.bytes)) throw stale();
  }
  const completed = [
    s.current,
    ...s.steps
      .filter((v) => !Object.keys(v.proof.conflicts).length)
      .map((v) => v.source),
  ];
  const expected =
    oldText("rewritten") +
    completed
      .map((source, i) => `${source.oid} ${actualCommits[i].oid}\n`)
      .join("");
  if (
    op.text("rewritten") !== expected ||
    op.text("original-commit") !== `${s.steps.at(-1)!.source.oid}\n` ||
    regular(path.join(native, "HEAD"))?.bytes.toString() !==
      `${actualCommits.at(-1)!.oid}\n` ||
    regular(
      path.join(native, `refs/heads/${s.base.branch}`),
    )?.bytes.toString() !== `${s.base.original}\n`
  )
    throw stale();
  directory(native);
  return new Map(Object.entries(op.files).filter(([n]) => n !== "ORIG_HEAD"));
}
