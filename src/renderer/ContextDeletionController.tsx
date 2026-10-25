import { createContext, useContext, useRef, useState } from "react";
import type { TopicContextRef } from "../shared/worktrees";
import { TopicModal } from "./TopicsCommon";
import { LoadingState } from "./LoadingBoundary";
import {
  performContextDeletion,
  type DeletionPreview,
  type DeletionResult,
} from "./context-deletion-flow";
export type ContextDeletionExecutor = (
  owner: TopicContextRef,
  plan: DeletionPreview,
  allowAhead: boolean,
) => Promise<DeletionResult>;
const ExecutorContext = createContext<ContextDeletionExecutor | null>(null);
export const useContextDeletionExecutor = () => useContext(ExecutorContext);
export const ContextDeletionProvider = ExecutorContext.Provider;
interface Operation {
  owner: TopicContextRef;
  plan: DeletionPreview;
  allowAhead: boolean;
  log: string[];
  error?: string;
}
export function useContextDeletionController(
  leave: (owner: TopicContextRef) => Promise<void>,
  changed: () => void,
) {
  const latest = useRef({ leave, changed });
  latest.current = { leave, changed };
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const lastOperation = useRef<Operation | null>(null);
  const update = (value: Operation | null) => {
    lastOperation.current = value;
    setOperation(value);
  };
  const execute: ContextDeletionExecutor = async (owner, plan, allowAhead) => {
    if (flight.current) throw Error("Дождитесь завершения удаления.");
    flight.current = true;
    setBusy(true);
    const previous =
      lastOperation.current?.plan.token === plan.token
        ? lastOperation.current
        : null;
    let removed = !!previous;
    const log: string[] = previous
      ? [...previous.log, "Повторяем незавершённую операцию…"]
      : [];
    const item = () => ({ owner, plan, allowAhead, log: [...log] });
    try {
      const result = await performContextDeletion(
        owner,
        plan,
        allowAhead,
        window.goga,
        (ref) => latest.current.leave(ref),
        (line, cloneRemoved) => {
          removed ||= cloneRemoved;
          log.push(line);
          if (removed) update(item());
        },
      );
      if (removed) {
        if (result.status === "success") {
          update(null);
          latest.current.changed();
        } else update({ ...item(), error: result.message });
      }
      return result;
    } catch (error) {
      if (removed)
        update({
          ...item(),
          error:
            error instanceof Error ? error.message : "Удаление не завершено.",
        });
      throw error;
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return { execute, busy, operation, close: () => update(null) };
}
export function ContextDeletionPopup({
  controller,
}: {
  controller: ReturnType<typeof useContextDeletionController>;
}) {
  const operation = controller.operation;
  if (!operation) return null;
  return (
    <TopicModal
      title={`Удаление топика ${operation.owner.topic}`}
      busy={controller.busy}
      onClose={controller.close}
    >
      <div className="topic-operation-log">
        <pre>{operation.log.join("\n")}</pre>
        {controller.busy && <LoadingState label="Удаляем топик" />}
        {operation.error && (
          <p role="alert" className="error">
            {operation.error}
          </p>
        )}
        {!controller.busy && (
          <button
            type="button"
            onClick={() =>
              void controller
                .execute(operation.owner, operation.plan, operation.allowAhead)
                .catch(() => {})
            }
          >
            Продолжить удаление
          </button>
        )}
      </div>
    </TopicModal>
  );
}
