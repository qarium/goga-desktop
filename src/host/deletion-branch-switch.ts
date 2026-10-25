import path from "node:path";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { assertTopicBranchesAvailable } from "./worktree-topic-guards";
type Git = (args: string[]) => Promise<string>;
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const deletionSwitchSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    fromHead: oid,
    toHead: oid,
    state: z.enum(["pending", "switching", "applied"]),
  })
  .strict();
export type DeletionSwitch = z.infer<typeof deletionSwitchSchema>;
const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
export async function deletionSwitchBranches(git: Git, topic: string) {
  return (await git(["for-each-ref", "--format=%(refname)", "refs/heads"]))
    .trim()
    .split("\n")
    .filter((x) => x.startsWith("refs/heads/"))
    .map((x) => x.slice(11))
    .filter((x) => normalize(x) !== topic);
}
async function clean(git: Git) {
  if (
    (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .length
  )
    throw Error(
      "В основной папке есть незакоммиченные изменения. Сохраните их перед переключением; ничего не сбрасывается.",
    );
}
export async function prepareDeletionSwitch(
  git: Git,
  root: string,
  from: string,
  to: string,
): Promise<DeletionSwitch> {
  if (!to || to.startsWith("-") || normalize(from) === normalize(to))
    throw Error("Выберите другую локальную ветку.");
  await git(["check-ref-format", "--branch", to]);
  const plan: DeletionSwitch = {
    from,
    to,
    fromHead: oid.parse(
      (
        await git(["rev-parse", "--verify", `refs/heads/${from}^{commit}`])
      ).trim(),
    ),
    toHead: oid.parse(
      (
        await git(["rev-parse", "--verify", `refs/heads/${to}^{commit}`])
      ).trim(),
    ),
    state: "pending",
  };
  await verifyDeletionSwitch(git, root, plan);
  return plan;
}
export async function verifyDeletionSwitch(
  git: Git,
  root: string,
  plan: DeletionSwitch,
) {
  if (plan.state !== "pending")
    throw Error(
      "Состояние переключения требует проверки; автоматический повтор запрещён.",
    );
  if (
    (await git(["branch", "--show-current"])).trim() !== plan.from ||
    (
      await git(["rev-parse", "--verify", `refs/heads/${plan.from}^{commit}`])
    ).trim() !== plan.fromHead ||
    (
      await git(["rev-parse", "--verify", `refs/heads/${plan.to}^{commit}`])
    ).trim() !== plan.toHead
  )
    throw Error(
      "Ветки изменились после выбора. Обновите подтверждение удаления.",
    );
  await clean(git);
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
  ]) {
    const file = (await git(["rev-parse", "--git-path", name])).trim();
    let exists = true;
    try {
      await lstat(path.resolve(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists)
      throw Error(
        "В основной папке не завершена операция Git. Сначала завершите её; удаление не начато.",
      );
  }
  await assertTopicBranchesAvailable(git, root, [plan.to], "delete");
  const files = new Set(
    (await git(["ls-tree", "-r", "--name-only", "-z", `refs/heads/${plan.to}`]))
      .split("\0")
      .filter(Boolean),
  );
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join("/"));
  }
  const ignored = (
    await git([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ])
  )
    .split("\0")
    .filter(Boolean);
  for (const raw of ignored) {
    const name = raw.replace(/\/$/, ""),
      parts = name.split("/");
    if (
      directories.has(name) ||
      parts.some((_, i) => files.has(parts.slice(0, i + 1).join("/")))
    )
      throw Error(
        "В основной папке есть ignored-файлы, которые перекрываются с выбранной веткой. Переключение остановлено; файлы сохранены.",
      );
  }
  // -n is a read-only checkout feasibility check: no index or worktree writes.
  await git(["read-tree", "-n", "-m", "-u", "HEAD", `refs/heads/${plan.to}`]);
}
export async function executeDeletionSwitch(
  git: Git,
  root: string,
  plan: DeletionSwitch,
  beforeSwitch?: () => void,
) {
  await verifyDeletionSwitch(git, root, plan);
  beforeSwitch?.();
  await git([
    "switch",
    "--no-guess",
    "--no-overwrite-ignore",
    "--no-recurse-submodules",
    plan.to,
  ]);
  await verifyAppliedDeletionSwitch(git, plan);
}
export async function verifyAppliedDeletionSwitch(
  git: Git,
  plan: DeletionSwitch,
) {
  if (
    (await git(["branch", "--show-current"])).trim() !== plan.to ||
    (await git(["rev-parse", "HEAD"])).trim() !== plan.toHead
  )
    throw Error(
      "Результат переключения ветки изменился. Удаление остановлено.",
    );
  await clean(git);
}
