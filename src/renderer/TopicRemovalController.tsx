import { createContext, useContext, useRef, useState } from "react";
import type {
  TopicRemovalPreview,
  TopicRemovalResult,
  TopicCloneCleanupResult,
} from "../shared/topic-removal";
import type { ContextDeletionExecutor } from "./ContextDeletionController";
import { TopicModal, topicError } from "./TopicsCommon";
import { worktreeContextRef } from "../shared/worktrees";
export type TopicRemovalExecutor = (
  plan: TopicRemovalPreview,
  projectName: string,
) => Promise<void>;
const Context = createContext<TopicRemovalExecutor | null>(null);
export const TopicRemovalProvider = Context.Provider;
export const useTopicRemovalExecutor = () => useContext(Context);
interface Operation {
  plan: TopicRemovalPreview;
  projectName: string;
  result?: TopicRemovalResult;
  error?: string;
}
export function useTopicRemovalController(
  executor: ContextDeletionExecutor | null,
  changed: () => void,
) {
  const [operation, setOperation] = useState<Operation | null>(null),
    [busy, setBusy] = useState(false);
  const flight = useRef(false),
    current = useRef<Operation | null>(null),
    latest = useRef({ executor, changed });
  latest.current = { executor, changed };
  const publish = (value: Operation | null) => {
    current.current = value;
    setOperation(value);
  };
  const copyResult = (copy: TopicCloneCleanupResult) => {
    const o = current.current;
    if (!o?.result) return;
    publish({
      ...o,
      result: {
        ...o.result,
        copies: [
          ...o.result.copies.filter((c) => c.contextId !== copy.contextId),
          copy,
        ],
      },
    });
  };
  const clean = async (
    item: NonNullable<Operation["result"]>["cleanup"][number],
    allowAhead: boolean,
  ) => {
    try {
      if (
        item.plan.purpose !== "clone-after-topic" ||
        item.plan.contextId !== item.owner.contextId ||
        !latest.current.executor
      )
        throw Error(
          "Контроллер очистки копии недоступен или подтверждение другого контекста.",
        );
      const r = await latest.current.executor(
        item.owner,
        item.plan,
        allowAhead,
      );
      if (r.stage) item.plan = { ...item.plan, stage: r.stage };
      copyResult({
        contextId: item.owner.contextId,
        topic: item.owner.topic,
        status:
          r.status === "success" && r.cloneRemoved
            ? "removed"
            : r.cloneRemoved
              ? "uncertain"
              : "kept",
        reason: r.message,
      });
    } catch (e) {
      copyResult({
        contextId: item.owner.contextId,
        topic: item.owner.topic,
        status: "kept",
        reason: topicError(e),
      });
    }
  };
  const execute: TopicRemovalExecutor = async (plan, projectName) => {
    if (flight.current) throw Error("Дождитесь завершения удаления.");
    flight.current = true;
    setBusy(true);
    publish({ plan, projectName });
    try {
      const result = await window.goga.executeTopicRemoval({
        projectId: plan.projectId,
        token: plan.token,
      });
      if (result.projectId !== plan.projectId)
        throw Error("Результат другого проекта.");
      publish({ plan, projectName, result });
      if (result.topics.status === "success")
        for (const item of result.cleanup) {
          if (
            item.owner.projectId !== plan.projectId ||
            item.owner.year !== plan.year
          )
            throw Error("Подтверждение очистки другого контекста.");
          if (item.plan.requiresAheadConfirmation)
            copyResult({
              contextId: item.owner.contextId,
              topic: item.owner.topic,
              status: "needs-confirmation",
              reason: `Коммитов вне исходной ветки: ${item.plan.aheadCount ?? "не подтверждено"}. Копия сохранена до отдельного согласия.`,
            });
          else await clean(item, false);
        }
    } catch (e) {
      publish({ ...current.current!, error: topicError(e) });
    } finally {
      flight.current = false;
      setBusy(false);
      latest.current.changed();
    }
  };
  const cleanup = async (contextId: string, allowAhead: boolean) => {
    const item = current.current?.result?.cleanup.find(
      (c) => c.owner.contextId === contextId,
    );
    if (!item || flight.current) return;
    if (item.plan.requiresAheadConfirmation && !allowAhead) return;
    flight.current = true;
    setBusy(true);
    try {
      await clean(item, allowAhead);
    } finally {
      flight.current = false;
      setBusy(false);
      latest.current.changed();
    }
  };
  const check = async (contextId: string) => {
    const o = current.current;
    if (!o?.result || o.result.topics.status !== "success" || flight.current)
      return;
    flight.current = true;
    setBusy(true);
    try {
      const owners = await window.goga.listTopicContexts(o.plan.projectId),
        row = owners.find((r) => r.contextId === contextId);
      const previous = o.result.cleanup.find(
        (c) => c.owner.contextId === contextId,
      )?.owner;
      if (!row && !previous)
        throw Error("Копия больше не найдена. Обновите топики.");
      const owner = row ? worktreeContextRef(row) : previous!,
        plan = await window.goga.prepareTopicCloneCleanup({ owner });
      const next = current.current!;
      publish({
        ...next,
        result: {
          ...next.result!,
          cleanup: [
            ...next.result!.cleanup.filter(
              (c) => c.owner.contextId !== contextId,
            ),
            { owner, plan },
          ],
        },
      });
      copyResult({
        contextId,
        topic: owner.topic,
        status: "needs-confirmation",
        reason: plan.details.join("\n"),
      });
    } catch (e) {
      const previous = o.result.copies.find((c) => c.contextId === contextId);
      copyResult({
        contextId,
        topic: previous?.topic ?? "Копия",
        status: "kept",
        reason: topicError(e),
      });
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return {
    operation,
    busy,
    execute,
    cleanup,
    check,
    close: () => {
      if (!flight.current) publish(null);
    },
  };
}
export function TopicRemovalPopup({
  controller,
}: {
  controller: ReturnType<typeof useTopicRemovalController>;
}) {
  const o = controller.operation;
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  if (!o) return null;
  return (
    <TopicModal
      title={`Удаление топиков · ${o.projectName} · ${o.plan.year}`}
      busy={controller.busy}
      onClose={controller.close}
      closeLabel="Закрыть результат удаления"
    >
      {controller.busy && (
        <p role="status">
          {o.result
            ? "Проверяем и очищаем рабочие копии…"
            : "Выполняем команду Goga…"}
        </p>
      )}
      {o.error && (
        <p role="alert" className="error">
          {o.error} Результат требует проверки; команда автоматически не
          повторяется.
        </p>
      )}
      {o.result && (
        <>
          <section
            className="topic-removal-result"
            aria-label="Удаление топиков"
          >
            <h3>Удаление топиков</h3>
            <p role={o.result.topics.status === "success" ? "status" : "alert"}>
              {o.result.topics.message}
            </p>
          </section>
          <section className="topic-removal-result" aria-label="Рабочие копии">
            <h3>Рабочие копии</h3>
            {!o.result.copies.length && !controller.busy && (
              <p className="hint">Нет копий, требующих очистки.</p>
            )}
            {o.result.copies.map((copy) => {
              const pending = o.result!.cleanup.find(
                (c) => c.owner.contextId === copy.contextId,
              );
              const needsAck = !!pending?.plan.requiresAheadConfirmation;
              const ackKey = JSON.stringify([
                o.plan.token,
                copy.contextId,
                pending?.plan.token,
              ]);
              return (
                <div className="topic-removal-copy" key={copy.contextId}>
                  <strong>{copy.topic}</strong>
                  <span
                    className={
                      copy.status === "removed" ? "topic-success" : "hint"
                    }
                  >
                    {copy.status === "removed"
                      ? "Копия в Корзине"
                      : "Копия сохранена / требует проверки"}
                  </span>
                  <p className="hint">{copy.reason}</p>
                  {copy.status === "needs-confirmation" && pending && (
                    <>
                      {needsAck && (
                        <label className="topic-confirm-check">
                          <input
                            type="checkbox"
                            checked={!!acks[ackKey]}
                            onChange={(e) =>
                              setAcks({ ...acks, [ackKey]: e.target.checked })
                            }
                          />
                          Подтверждаю удаление непереданных коммитов{" "}
                          {copy.topic}
                        </label>
                      )}
                      <button
                        type="button"
                        disabled={
                          controller.busy || (needsAck && !acks[ackKey])
                        }
                        onClick={() =>
                          void controller.cleanup(
                            copy.contextId,
                            !!acks[ackKey],
                          )
                        }
                      >
                        Удалить копию {copy.topic}
                      </button>
                    </>
                  )}
                  {copy.status !== "removed" &&
                    copy.status !== "needs-confirmation" && (
                      <button
                        type="button"
                        disabled={controller.busy}
                        onClick={() => void controller.check(copy.contextId)}
                      >
                        Проверить копию {copy.topic}
                      </button>
                    )}
                </div>
              );
            })}
          </section>
        </>
      )}
      <footer>
        <button
          type="button"
          disabled={controller.busy}
          onClick={controller.close}
        >
          К топикам
        </button>
      </footer>
    </TopicModal>
  );
}
