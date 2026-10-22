import path from "node:path";
import { realpath } from "node:fs/promises";
import type { WorktreeRecord } from "../shared/worktrees";
import { noSymlinks } from "./settings";

type Git = (args: string[], cwd: string) => Promise<string>;
const invalid = () =>
  new Error(
    "Origin копии должен указывать только на исходную локальную папку проекта. Origin отсутствует, изменён или содержит небезопасные настройки; существующий origin не перезаписывался.",
  );

/** Read-only unless an explicitly requested operation opts into legacy migration. */
export async function assertLocalOrigin(
  owner: WorktreeRecord,
  git: Git,
  migrateMissing = false,
): Promise<boolean> {
  const raw = await git(
    ["config", "--local", "--includes", "--null", "--list"],
    owner.path,
  );
  const rows = raw
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const n = row.indexOf("\n");
      return [row.slice(0, n), row.slice(n + 1)];
    })
    .filter(([key]) => key.startsWith("remote.origin."));
  if (!rows.length) {
    if (!migrateMissing) return false;
    // Never replace a custom origin, even when it would prevent synchronization.
    await git(["remote", "add", "origin", owner.projectPath], owner.path);
    return assertLocalOrigin(owner, git);
  }
  if (
    rows.some(
      ([key]) =>
        ![
          "remote.origin.url",
          "remote.origin.pushurl",
          "remote.origin.fetch",
        ].includes(key),
    )
  )
    throw invalid();
  for (const key of ["url", "pushurl", "fetch"]) {
    const values = rows
      .filter(([name]) => name === `remote.origin.${key}`)
      .map(([, value]) => value);
    if (values.length > 1 || (key === "url" && values.length !== 1))
      throw invalid();
    if (
      values.some((value) =>
        key === "fetch"
          ? value !== "+refs/heads/*:refs/remotes/origin/*"
          : value !== owner.projectPath,
      )
    )
      throw invalid();
  }
  await noSymlinks(owner.projectPath);
  await noSymlinks(owner.sourceCommonDir!);
  if (
    !path.isAbsolute(owner.projectPath) ||
    (await realpath(owner.projectPath)) !== owner.projectPath
  )
    throw invalid();
  for (const push of [false, true]) {
    const effective = (
      await git(
        ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "origin"],
        owner.path,
      )
    ).trim();
    if (effective !== owner.projectPath) throw invalid();
  }
  return true;
}
