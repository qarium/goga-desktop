import { hash } from "./git-conflict-state";
import {
  continuationPolicy,
  treeKey,
  type SourceCommit,
} from "./git-rebase-continue-state";
import { type Tree } from "./git-rebase-operations-state";
import {
  captureSequencer,
  sequencerStateKey,
  sequencerContentProof,
  unsupportedSequencer,
  type GitSequencerContext,
  type SequencerState,
  type SequencerContentProof,
} from "./git-sequencer-state";
import type { GitSequencerOperationRequest } from "../shared/git-sequencer-operations";
export interface SequencerPlan {
  state: SequencerState;
  key: string;
  policy: string;
  config: string;
  committer: string;
  commits: { source: SourceCommit; tree: Tree }[];
  next?: {
    source: SourceCommit;
    proof: SequencerContentProof;
    remaining: SourceCommit[];
  };
  tree: Tree;
}
/** Predict a bounded native prefix; do not create commits or replay a sequencer. */
export async function planSequencer(
  c: GitSequencerContext,
  r: GitSequencerOperationRequest,
): Promise<SequencerPlan> {
  const state = await captureSequencer(c, r);
  const policy =
    r.action === "continue"
      ? await continuationPolicy(c)
      : {
          policy: "",
          committer: "",
          config:
            "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nlogallrefupdates = false\n",
        };
  for (const row of policy.policy.split("\0").filter(Boolean)) {
    const key = row.split("\n", 1)[0].toLowerCase();
    if (/^(revert|sequencer|cherry-pick)\./.test(key))
      throw unsupportedSequencer();
  }
  const commits: SequencerPlan["commits"] = [],
    known = new Map<string, Buffer>(),
    generated: Buffer[] = [];
  let next: SequencerPlan["next"],
    tree = state.originalTree;
  if (r.action === "continue") {
    tree = state.resolved;
    commits.push({ source: state.current, tree });
    for (const [n, e] of Object.entries(tree))
      known.set(e.oid, state.disk.files[n].bytes);
    for (const [i, source] of state.remaining.entries()) {
      const proof = await sequencerContentProof(
        c,
        state.operation,
        tree,
        source,
        known,
      );
      for (const [n, b] of Object.entries(proof.bytes)) {
        known.set(proof.tree[n].oid, b);
        generated.push(b);
      }
      if (Object.keys(proof.conflicts).length) {
        next = { source, proof, remaining: state.remaining.slice(i) };
        tree = proof.tree;
        break;
      }
      if (treeKey(proof.tree) === treeKey(tree))
        throw Error(
          "Пустой шаг последовательности: автоматический skip не выполняется.",
        );
      tree = proof.tree;
      commits.push({ source, tree });
    }
  }
  // Bound potential native output before allowing worktree writes. All paths are
  // existing text paths; no checkout of arbitrary future names or rename policy.
  const dirs = new Map<string, Map<string, string>>([["", new Map()]]);
  for (const [name, entry] of Object.entries(tree)) {
    const parts = name.split("/");
    let parent = "";
    for (let i = 0; i < parts.length; i++) {
      dirs
        .get(parent)!
        .set(parts[i], i === parts.length - 1 ? entry.mode : "40000");
      if (i < parts.length - 1) {
        parent = parts.slice(0, i + 1).join("/");
        if (!dirs.has(parent)) dirs.set(parent, new Map());
      }
    }
  }
  const treeSizes = [...dirs.values()].map((entries) =>
    [...entries].reduce(
      (n, [name, mode]) => n + Buffer.byteLength(name) + mode.length + 22,
      0,
    ),
  );
  const allSources = [state.current, ...state.remaining];
  const commitSizes = commits.map(
    ({ source }) =>
      Buffer.byteLength(source.message) +
      Buffer.byteLength(source.author) +
      Buffer.byteLength(policy.committer) +
      8192,
  );
  const objects =
    3 * (commits.length + (next ? 1 : 0)) * dirs.size +
    3 * generated.length +
    commits.length;
  const bytes =
    3 *
      (commits.length + (next ? 1 : 0)) *
      treeSizes.reduce((a, b) => a + b, 0) +
    3 * generated.reduce((n, b) => n + b.length, 0) +
    commitSizes.reduce((a, b) => a + b, 0) +
    objects * 4096;
  const projected =
    [...known.values()].reduce((n, b) => n + b.length, 0) +
    Object.entries(state.disk.files)
      .filter(([name]) => !state.auto[name])
      .reduce((n, [, f]) => n + f.bytes.length, 0);
  if (
    allSources.length + state.completed.length > 128 ||
    bytes > 32 * 1024 * 1024 ||
    projected > 32 * 1024 * 1024 ||
    objects > 256 ||
    treeSizes.some((n) => n + 4096 > 2 * 1024 * 1024) ||
    allSources.some((s) => Buffer.byteLength(s.message) > 64 * 1024)
  )
    throw unsupportedSequencer();
  return {
    state,
    policy: policy.policy,
    config: policy.config,
    committer: policy.committer,
    commits,
    next,
    tree,
    key: hash(
      JSON.stringify([
        sequencerStateKey(state),
        policy,
        commits,
        next?.source.oid,
        treeKey(tree),
      ]),
    ),
  };
}
