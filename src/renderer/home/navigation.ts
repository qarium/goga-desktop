import type { Project } from "../../shared/types";
import {
  worktreeRecordSchema,
  type WorktreeRecord,
  type TopicContextRef,
} from "../../shared/worktrees";
import { contextKey, contextRef } from "../topic-context";
import type { WorkspaceAddress } from "./types";
/** An address saved for display is not permission to adopt another checkout. */
export async function resolveHomeOwner(
  project: Project,
  owner: WorkspaceAddress,
  resolve: (ref: TopicContextRef) => Promise<WorktreeRecord>,
  list: (id: string) => Promise<WorktreeRecord[]>,
  stillCurrent = () => true,
): Promise<WorktreeRecord | null> {
  if (owner.kind === "primary") {
    if (owner.projectId !== project.id)
      throw Error("Проект этой карточки недоступен.");
    return null;
  }
  const ref = owner.ref;
  if (ref.projectId !== project.id)
    throw Error("Рабочая копия принадлежит другому проекту.");
  const validate = (input: WorktreeRecord, expected: TopicContextRef) => {
    const row = worktreeRecordSchema.parse(input);
    if (
      contextKey(row) !== contextKey(ref) ||
      row.revision !== expected.revision ||
      row.projectPath !== project.path ||
      row.state !== "ready" ||
      row.ownership !== "managed" ||
      row.storageKind !== "clone" ||
      row.compatibility === "legacy-linked" ||
      row.deletedAt ||
      row.preparation
    )
      throw Error(
        "Рабочая копия недоступна. Основная папка не выбрана вместо неё.",
      );
    return row;
  };
  try {
    return validate(await resolve(ref), ref);
  } catch (error) {
    if (!stillCurrent()) throw error;
    // Only explicit navigation may refresh a stale address, never the Home render.
    const same = (await list(project.id)).filter(
      (r) => contextKey(r) === contextKey(ref) && !r.deletedAt,
    );
    if (
      !stillCurrent() ||
      same.length !== 1 ||
      same[0].revision === ref.revision
    )
      throw error;
    const next = contextRef(same[0]);
    return validate(await resolve(next), next);
  }
}
