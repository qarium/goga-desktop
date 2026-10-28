import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeGitOperationResult } from "../shared/git-native-operation";

type Deferred = {
  initial: NativeGitOperationResult;
  finish(): Promise<NativeGitOperationResult>;
};
const boundary = new AsyncLocalStorage<Deferred[]>();
const message =
  "Завершающая проверка Git или освобождение контекста не подтверждены. Материалы восстановления сохранены; автоматический повтор запрещён.";

/** Host-only completion scope. Nested handoffs share the OUTERMOST lease, so an
 * inner successful command cannot discard recovery before its caller returns. */
export function deferNativeGitRecovery(
  finish: Deferred["finish"],
  initial: NativeGitOperationResult,
) {
  const active = boundary.getStore();
  if (!active) throw Error("Не определена граница завершения операции Git.");
  active.push({ finish, initial: structuredClone(initial) });
}
type Result = Record<string, unknown>;
function native(value: Result): Result {
  return value.native && typeof value.native === "object"
    ? (value.native as Result)
    : value;
}
function uncertain<T extends object>(
  value: T,
  proof?: NativeGitOperationResult,
): T {
  const result = { ...value } as Result;
  if ("status" in result) result.status = "uncertain";
  if ("outcome" in result) result.outcome = "uncertain";
  if (result.native && typeof result.native === "object")
    result.native = { ...result.native, outcome: "uncertain" };
  if (proof?.recoveryPath) result.recoveryPath = proof.recoveryPath;
  if ("message" in result) result.message = message;
  return result as T;
}
export async function withNativeGitCompletion<T extends object>(
  action: () => Promise<T>,
): Promise<T> {
  if (boundary.getStore()) return action();
  return boundary.run([], async () => {
    const pending = boundary.getStore()!;
    let value: T;
    try {
      value = await action();
    } catch (error) {
      // No returned/sanitized response: never expose raw child output from the
      // throwing context, and NEVER finalize its persisted recovery/fence.
      if (pending.length) throw Error(message);
      throw error;
    }
    const result = value as Result,
      proof = native(result);
    if (!pending.length) {
      // Journal persistence can fail before it hands us a finalizer.
      return ["completed", "rejected"].includes(String(proof.outcome)) &&
        proof.recovery !== "removed"
        ? uncertain(value)
        : value;
    }
    // A single journaled write per boundary. Unexpected composition must not
    // clear recovery or silently authorize a second write.
    const deferred = pending[0],
      initial = deferred.initial;
    if (
      pending.length !== 1 ||
      result.status === "uncertain" ||
      proof.outcome === "uncertain" ||
      result.lockRetained === true ||
      (proof.operationId !== initial.operationId &&
        result.recoveryPath !== initial.recoveryPath)
    )
      return uncertain(value, initial);
    let finished: NativeGitOperationResult;
    try {
      finished = await deferred.finish();
    } catch {
      return uncertain(value, initial);
    }
    const next = { ...result };
    if (proof.operationId === initial.operationId) {
      const updated = { ...proof, ...finished };
      if (!finished.recoveryPath) delete updated.recoveryPath;
      if (proof === result) Object.assign(next, updated);
      else next.native = updated;
    }
    if (
      finished.outcome === "uncertain" ||
      finished.recovery !== "removed" ||
      !finished.processSettled ||
      !finished.verifiedUnrelatedData
    )
      return uncertain(next, initial) as T;
    if (next.recoveryPath === initial.recoveryPath) delete next.recoveryPath;
    return next as T;
  });
}
