import path from "node:path";
import { realpath } from "node:fs/promises";
import type { TopicOperationRequest } from "../shared/topics";

interface Worktree {
  path: string;
  branch?: string;
}
const invalidInventory = () =>
  Error(
    "Не удалось проверить каталог рабочих копий Git. Операция остановлена.",
  );

// -z preserves spaces, newlines and non-ASCII paths without Git's quoting.
// An empty/truncated/unknown inventory must never mean 'no occupied branches'.
function parseWorktrees(raw: string): Worktree[] {
  if (!raw || !raw.endsWith("\0\0")) throw invalidInventory();
  const result: Worktree[] = [],
    paths = new Set<string>();
  for (const record of raw.slice(0, -2).split("\0\0")) {
    const [first, ...fields] = record.split("\0");
    if (!first?.startsWith("worktree ")) throw invalidInventory();
    const directory = first.slice(9);
    if (!path.isAbsolute(directory) || paths.has(directory))
      throw invalidInventory();
    paths.add(directory);
    const seen = new Set<string>();
    let head = false,
      bare = false,
      detached = false,
      branch: string | undefined;
    for (const field of fields) {
      const space = field.indexOf(" "),
        key = space < 0 ? field : field.slice(0, space),
        value = space < 0 ? "" : field.slice(space + 1);
      if (seen.has(key)) throw invalidInventory();
      seen.add(key);
      if (key === "HEAD") {
        if (
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ||
          /^0+$/.test(value)
        )
          throw invalidInventory();
        head = true;
      } else if (key === "branch") {
        if (
          !value.startsWith("refs/heads/") ||
          value.length <= 11 ||
          /[\x00-\x20\x7f]/.test(value)
        )
          throw invalidInventory();
        branch = value.slice(11);
      } else if (key === "bare" || key === "detached") {
        if (value) throw invalidInventory();
        if (key === "bare") bare = true;
        else detached = true;
      } else if (key !== "locked" && key !== "prunable") {
        throw invalidInventory();
      }
    }
    if (
      bare
        ? head || branch !== undefined || detached
        : !head || (branch !== undefined) === detached
    )
      throw invalidInventory();
    result.push({
      path: directory,
      ...(branch !== undefined ? { branch } : {}),
    });
  }
  return result;
}

/** Read-only safety gate; caller retains the repository mutation lock. */
export async function assertTopicBranchesAvailable(
  git: (args: string[]) => Promise<string>,
  cwd: string,
  branches: string[],
  operation: TopicOperationRequest["action"],
): Promise<void> {
  if (!branches.length) return;
  let inventory: Worktree[], current: string;
  try {
    inventory = parseWorktrees(
      await git(["worktree", "list", "--porcelain", "-z"]),
    );
    current = await realpath(cwd);
  } catch {
    throw invalidInventory();
  }
  const targets = new Set(branches);
  for (const worktree of inventory) {
    if (!worktree.branch || !targets.has(worktree.branch)) continue;
    let owner: string;
    try {
      owner = await realpath(worktree.path);
    } catch {
      throw invalidInventory();
    }
    if (operation !== "delete" && owner === current) continue;
    throw Error(
      `Ветка «${worktree.branch}» открыта ${owner === current ? "в рабочей копии" : "в другой рабочей копии"}. Операция недоступна: сначала переключите эту копию на другой топик.`,
    );
  }
}
