import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useState } from "react";
import type { Project } from "../shared/types";
import type { TopicTarget } from "../shared/topics";
import type { WorktreeRecord } from "../shared/worktrees";
import { ContextDeletionAction } from "./ContextDeletionAction";
import { contextRef } from "./topic-context";
import { useReadScope } from "./read-request";
import { LoadingState } from "./LoadingBoundary";
import { TopicsRemovalDialog } from "./TopicsRemovalDialog";
import {
  TopicModal,
  TopicConfirmation,
  TopicFeedback,
  topicError,
  useTopicOperation,
} from "./TopicsCommon";

/** A saved deletion keeps its original protocol; a new deletion is topic-first. */
export function TopicRemovalEntry(
  props: Parameters<typeof TopicDeleteDialog>[0],
) {
  useLocale();
  const owner = props.owner;
  const read = useReadScope(
    JSON.stringify(["removal-entry", owner?.contextId, owner?.revision]),
  );
  const [legacy, setLegacy] = useState<boolean | null>(owner ? null : false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!owner) return;
    let alive = true;
    setLegacy(null);
    setError("");
    read("contextDeletionRecovery", contextRef(owner))
      .then((plan) => {
        if (plan && plan.contextId !== owner.contextId)
          throw Error(tr("topics.theRemovalLogBelongsToAnotherCopy"));
        if (alive) setLegacy(!!plan);
      })
      .catch((e) => {
        if (alive) setError(topicError(e));
      });
    return () => {
      alive = false;
    };
  }, [read, owner, attempt]);
  if (legacy === null)
    return (
      <TopicModal title={tr("topics.checkingRemoval")} onClose={props.onClose}>
        {error ? (
          <>
            <p role="alert" className="error">
              {error}
            </p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>{tr("topics.checkAgain")}</button>
          </>
        ) : (
          <LoadingState label={tr("topics.checkingPreviousConfirmation")} />
        )}
      </TopicModal>
    );
  return legacy ? (
    <TopicDeleteDialog {...props} />
  ) : (
    <TopicsRemovalDialog
      project={props.project}
      year={props.year}
      action="delete"
      topics={[props.target.topic]}
      onClose={props.onClose}
      onChanged={props.onChanged}
      onBusy={props.onBusy}
    />
  );
}

/** Both entrypoints share the existing host preview/token flow; clicking a trash icon never executes. */
export function TopicDeleteDialog({
  project,
  year,
  target,
  owner,
  current,
  active,
  onClose,
  onChanged,
  onBusy,
}: {
  project: Project;
  year: string;
  target: TopicTarget;
  owner?: WorktreeRecord;
  current: boolean;
  active: boolean;
  onClose: () => void;
  onChanged: () => void;
  onBusy?: (v: boolean) => void;
}) {
  useLocale();
  const key = JSON.stringify([
    "delete",
    project.id,
    year,
    target.topic,
    target.branch,
    owner?.contextId,
    owner?.revision,
  ]);
  const read = useReadScope(key);
  const [checking, setChecking] = useState(!owner),
    [error, setError] = useState("");
  const [ownerBusy, setOwnerBusy] = useState(false);
  const operation = useTopicOperation(key, onChanged);
  const reason = active
    ? tr("topics.finishTheTopicSRunsFirst")
    : !owner && current
      ? tr("topics.selectAnotherTopicFirst")
      : "";
  useEffect(() => {
    let alive = true;
    if (owner || reason) {
      setChecking(false);
      return;
    }
    setChecking(true);
    read("readTopicBoard", project.id, year)
      .then(async (fresh) => {
        if (!alive) return;
        if (fresh.projectId !== project.id || fresh.year !== year)
          throw Error(tr("topics.theCatalogBelongsToAnotherProjectOrYear"));
        await operation.prepare({
          projectId: project.id,
          year,
          expectedRevision: fresh.revision,
          action: "delete",
          target,
        });
      })
      .catch((e) => {
        if (alive) setError(topicError(e));
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [key, read, reason]);
  const busy = checking || ownerBusy || operation.busy;
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  return (
    <TopicModal
      title={tr("topics.deleteTopicTopic", { topic: target.topic })}
      busy={busy}
      onClose={onClose}
    >
      {owner ? (
        <ContextDeletionAction
          key={key}
          owner={contextRef(owner)}
          current={current}
          active={active}
          autoPrepare
          onCancel={onClose}
          onBusy={setOwnerBusy}
          onDeleted={() => {
            onChanged();
            onClose();
          }}
        />
      ) : (
        <>
          {reason && <p className="hint">{reason}</p>}
          {checking && <LoadingState label={tr("topics.checkingWhatWillBeDeleted")} />}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {operation.plan && (
            <TopicConfirmation
              operation={{
                ...operation,
                cancel: () => {
                  operation.cancel();
                  onClose();
                },
              }}
              onSuccess={onClose}
            />
          )}
          <TopicFeedback operation={operation} />
        </>
      )}
    </TopicModal>
  );
}
