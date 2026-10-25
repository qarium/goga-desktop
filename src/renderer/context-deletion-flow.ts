import type { TopicContextRef } from "../shared/worktrees";
import type {
  ContextDeletionPreview,
  ContextDeletionResult,
} from "../shared/context-deletion";
export type DeletionPreview = ContextDeletionPreview;
export type DeletionResult = ContextDeletionResult;
export interface DeletionAPI {
  deleteContext(input: {
    projectId: string;
    token: string;
    allowAhead?: true;
  }): Promise<DeletionResult>;
  finishContextDeletion(input: {
    projectId: string;
    token: string;
  }): Promise<DeletionResult>;
}
export async function performContextDeletion(
  owner: TopicContextRef,
  plan: DeletionPreview,
  allowAhead: boolean,
  api: DeletionAPI,
  leave: (owner: TopicContextRef) => Promise<void>,
  progress?: (line: string, cloneRemoved: boolean) => void,
): Promise<DeletionResult> {
  if (plan.contextId !== owner.contextId)
    throw Error("Подтверждение другого контекста.");
  if (
    plan.stage === "prepared" &&
    plan.requiresAheadConfirmation &&
    !allowAhead
  )
    throw Error("Подтвердите удаление клона с непереданными коммитами.");
  progress?.("Проверяем состояние и перемещаем клон в Корзину…", false);
  const result = await api.deleteContext({
    projectId: owner.projectId,
    token: plan.token,
    ...(allowAhead ? { allowAhead: true as const } : {}),
  });
  if (!result.cloneRemoved) return result;
  progress?.("Клон перемещён в Корзину. Переключаем контекст…", true);
  await leave(owner);
  if (result.status !== "success") return result;
  progress?.("Контекст переключён. Удаляем топик в основном проекте…", true);
  return api.finishContextDeletion({
    projectId: owner.projectId,
    token: plan.token,
  });
}
