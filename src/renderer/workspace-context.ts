import type { Project, Run } from "../shared/types";
import type { WorktreeRecord } from "../shared/worktrees";
import {
  contextKey,
  runsForContext,
  type TopicContextIdentity,
} from "./topic-context";

/** Stable ownership excludes revision: refreshing data must not lose open tabs. */
export function matchesWorkspace(
  ownerProjectId: string,
  owner: TopicContextIdentity | null | undefined,
  projectId: string,
  selected: TopicContextIdentity | null,
): boolean {
  if (ownerProjectId !== projectId) return false;
  if (!owner || !selected) return !owner && !selected;
  return (
    owner.projectId === projectId &&
    selected.projectId === projectId &&
    contextKey(owner) === contextKey(selected)
  );
}

export function runMatchesWorkspace(
  run: Run,
  projectId: string,
  selected: TopicContextIdentity | null,
): boolean {
  if (run.projectId !== projectId) return false;
  return selected ? runsForContext([run], selected).length === 1 : !run.context;
}

/** Display only; the original host-owned path remains untouched. */
export function workspacePath(
  project: Project | undefined,
  owner: WorktreeRecord | null,
) {
  const full = owner ? owner.path : (project?.path ?? "");
  let display =
    full ||
    (owner
      ? "Путь рабочей копии недоступен"
      : "Выберите папку существующего проекта");
  if (owner?.storageKind === "clone" && owner.ownership === "managed")
    display = display.replace(
      /^\/(?:Users|home)\/[^/]+\/(?=\.goga\/desktop\/)/,
      "~/",
    );
  return { full, display };
}

/** UI admission mirrors host policy; it never grants execution authority. */
export function workspaceLaunchBlockReason(
  runs: Run[],
  projectId: string,
  owner: TopicContextIdentity | null,
  kind: "pipeline" | "build",
): string {
  const active = runs.filter(
    (run) =>
      runMatchesWorkspace(run, projectId, owner) &&
      (run.status === "starting" || run.status === "running"),
  );
  if (active.some((run) => run.recovery === "unverified"))
    return "Сначала проверьте состояние процесса после перезапуска.";
  if (kind === "build" && active.some((run) => run.kind === "build"))
    return "В этой рабочей копии уже выполняется сборка.";
  return "";
}
