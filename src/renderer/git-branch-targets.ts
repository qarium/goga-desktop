import type { GitBranchInventory, GitBranchRef } from "../shared/git-branches";
/** Display hints only: the host still verifies the selected ref, owner and worktree. */
export function remoteBranchTarget(
  inventory: GitBranchInventory,
  remote: GitBranchRef,
) {
  const locals = inventory.local.filter(
    (local) => local.upstream === remote.ref,
  );
  if (locals.length) return { kind: "tracking" as const, locals };
  // Only origin has an explicit mapping in this flow. Do not guess slash-containing remote names.
  if (remote.ref.startsWith("refs/remotes/origin/")) {
    const name = remote.ref.slice("refs/remotes/origin/".length);
    if (inventory.local.some((local) => local.name === name))
      return { kind: "collision" as const, name };
  }
  return { kind: "create" as const };
}
