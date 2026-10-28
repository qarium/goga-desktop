import path from "node:path";
import type { WorktreeRecord } from "../shared/worktrees";
import { auditMetadata, stat } from "./git-merge-safety";
import { nativeIntent } from "./git-native-context";
import { fingerprintNativeGitControls } from "./git-native-state";
import { noSymlinks } from "./settings";
const unavailable = () =>
  Error("Не удалось подтвердить физический контекст остановленного rebase.");
/** Display/conflict-file identity only, NEVER permission to replay a sequence.
 * Git controls are opaque and sealed. Only the native journal can authorize
 * continuation; a changed todo/author-script/patch is not interpreted here. */
export async function readRebaseBinding(
  owner: Pick<WorktreeRecord, "path" | "gitCommonDir" | "branch">,
  git: (args: string[]) => Promise<string>,
): Promise<string> {
  await noSymlinks(owner.path);
  await noSymlinks(owner.gitCommonDir);
  await auditMetadata(owner.path);
  for (const name of [
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "info/grafts",
  ])
    if (await stat(path.join(owner.gitCommonDir, name))) throw unavailable();
  const observe = async () => {
    const merge = await stat(path.join(owner.gitCommonDir, "rebase-merge")),
      apply = await stat(path.join(owner.gitCommonDir, "rebase-apply"));
    if (!!merge === !!apply || !(merge ?? apply)?.isDirectory())
      throw unavailable();
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "sequencer",
      "BISECT_START",
    ])
      if (await stat(path.join(owner.gitCommonDir, name))) throw unavailable();
    const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const originalBranch = (
      await git([
        "rev-parse",
        "--verify",
        `refs/heads/${owner.branch}^{commit}`,
      ])
    ).trim();
    if (
      branch !== "HEAD" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(originalBranch)
    )
      throw unavailable();
    return nativeIntent([
      owner,
      head,
      originalBranch,
      await fingerprintNativeGitControls(owner.path),
    ]);
  };
  const before = await observe();
  if (before !== (await observe())) throw unavailable();
  return before;
}
