import { createHash } from "node:crypto";
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { WorktreeRecord } from "../../src/shared/worktrees";

/** Reconstruct historical on-disk trust for regression tests; never a production migration. */
export async function seedLegacyPublication(
  owner: WorktreeRecord,
  git: (args: string[], cwd: string) => Promise<string>,
  effectiveGit = git,
) {
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const source: Record<string, string> = {};
  for (const key of ["url", "pushurl", "fetch"]) {
    try {
      source[key] = (
        await git(
          ["config", "--local", "--get", `remote.origin.${key}`],
          owner.projectPath,
        )
      ).trim();
    } catch {
      /* Optional old config. */
    }
  }
  const remotes = (await git(["remote"], owner.path)).trim().split("\n");
  if (remotes.includes("origin"))
    await git(["remote", "remove", "origin"], owner.path);
  const clone = {
    url: source.url,
    ...(source.pushurl ? { pushurl: source.pushurl } : {}),
    fetch: "+refs/heads/*:refs/remotes/origin/*",
  };
  for (const [key, value] of Object.entries(clone))
    await git(["config", "--local", `remote.origin.${key}`, value], owner.path);
  const endpoints = [];
  for (const push of [false, true]) {
    const value = (
      await effectiveGit(
        ["remote", "get-url", ...(push ? ["--push"] : []), "origin"],
        owner.projectPath,
      )
    ).trim();
    endpoints.push(
      path.isAbsolute(value)
        ? `file:${await realpath(value)}`
        : new URL(value).toString(),
    );
  }
  await writeFile(
    path.join(owner.gitCommonDir, "desktop-upstream-policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      contextId: owner.contextId,
      ownerHash: hash(
        JSON.stringify([
          owner.contextId,
          owner.path,
          owner.projectPath,
          owner.gitCommonDir,
          owner.sourceCommonDir,
          await readFile(
            path.join(owner.gitCommonDir, "desktop-owner.json"),
            "utf8",
          ),
        ]),
      ),
      primaryHash: hash(JSON.stringify(source)),
      cloneHash: hash(JSON.stringify(clone)),
      endpointsHash: hash(JSON.stringify(endpoints)),
    }),
    { mode: 0o600 },
  );
}
