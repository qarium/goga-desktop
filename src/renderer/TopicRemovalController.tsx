import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
  changed: (projectId: string) => void,
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
          tr("topics.theCopyCleanupControllerIsUnavailableOrThe"),
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
    if (flight.current) throw Error(tr("topics.waitForRemovalToFinish"));
    flight.current = true;
    setBusy(true);
    publish({ plan, projectName });
    try {
      const result = await window.goga.executeTopicRemoval({
        projectId: plan.projectId,
        token: plan.token,
      });
      if (result.projectId !== plan.projectId)
        throw Error(tr("topics.resultBelongsToAnotherProject"));
      publish({ plan, projectName, result });
      if (result.topics.status === "success")
        for (const item of result.cleanup) {
          if (
            item.owner.projectId !== plan.projectId ||
            item.owner.year !== plan.year
          )
            throw Error(tr("topics.cleanupConfirmationBelongsToAnotherContext"));
          if (item.plan.requiresAheadConfirmation)
            copyResult({
              contextId: item.owner.contextId,
              topic: item.owner.topic,
              status: "needs-confirmation",
              reason: tr("topics.commitsOutsideTheOriginalBranchValue1TheCopy", { value1: item.plan.aheadCount ?? tr("launch.notVerified") }),
            });
          else await clean(item, false);
        }
    } catch (e) {
      publish({ ...current.current!, error: topicError(e) });
    } finally {
      flight.current = false;
      setBusy(false);
      latest.current.changed(plan.projectId);
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
      latest.current.changed(item.owner.projectId);
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
        throw Error(tr("topics.theCopyWasNotFoundRefreshTopics"));
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
        topic: previous?.topic ?? tr("topics.copy"),
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
  onClosed,
}: {
  controller: ReturnType<typeof useTopicRemovalController>;
  onClosed?: () => void;
}) {
  useLocale();
  const o = controller.operation;
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  if (!o) return null;
  const close = () => {
    if (controller.busy) return;
    controller.close();
    onClosed?.();
  };
  return (
    <TopicModal
      title={tr("topics.topicRemovalProjectnameYear", { projectName: o.projectName, year: o.plan.year })}
      busy={controller.busy}
      onClose={close}
      className="topic-removal-dialog"
      closeLabel={tr("topics.closeRemovalResult")}
    >
      <div className="topic-removal-body">
        {controller.busy && (
          <p role="status" className="topic-removal-progress">
            <span className="loading-spinner" aria-hidden="true" />
            {o.result
              ? tr("topics.checkingAndCleaningUpWorkingCopies")
              : tr("topics.runningTheGogaCommand")}
          </p>
        )}
        {o.error && (
          <p role="alert" className="error">
            {o.error}{tr("topics.checkTheResultTheCommandWillNotBe")}</p>
        )}
        {o.result && (
          <>
            <section
              className="topic-removal-result"
              aria-label={tr("topics.topicRemoval")}
            >
              <h3>{tr("topics.topicRemoval")}</h3>
              <p
                role={o.result.topics.status === "success" ? "status" : "alert"}
              >
                {o.result.topics.message}
              </p>
            </section>
            <section
              className="topic-removal-result"
              aria-label={tr("topics.workingCopies")}
            >
              <h3>{tr("topics.workingCopies")}</h3>
              {!o.result.copies.length && !controller.busy && (
                <p className="hint">{tr("topics.thereAreNoCopiesToCleanUp")}</p>
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
                        ? tr("topics.copyMovedToTrash")
                        : copy.status === "uncertain"
                          ? tr("topics.workingCopyNeedsVerification")
                          : tr("topics.copyRemainsOnDisk")}
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
                            />{tr("topics.iConfirmTheRemovalOfUnpushedCommits")}{" "}
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
                        >{tr("topics.deleteCopy")}{copy.topic}
                        </button>
                      </>
                    )}
                    {copy.status !== "removed" &&
                      copy.status !== "needs-confirmation" && (
                        <button
                          type="button"
                          disabled={controller.busy}
                          onClick={() => void controller.check(copy.contextId)}
                        >{tr("topics.checkCopy")}{copy.topic}
                        </button>
                      )}
                  </div>
                );
              })}
            </section>
          </>
        )}
      </div>
      <footer className="topic-removal-actions">
        <button type="button" disabled={controller.busy} onClick={close}>{tr("topics.backToTopics")}</button>
      </footer>
    </TopicModal>
  );
}
