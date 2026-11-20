import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { ContextDeletionAction } from "./ContextDeletionAction";
import type { WorktreeRecord } from "../shared/worktrees";
import {
  contextRef,
  contextRequestKey,
  contextRunActivity,
  type RunWithContext,
} from "./topic-context";
import { TopicSyncActions } from "./TopicSyncActions";
import { topicSyncUnavailable } from "./topic-sync-controller";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { useEffect, useId, useState } from "react";
import type { Project, Run } from "../shared/types";
import type {
  TopicAction,
  TopicBoardRecord,
  TopicBoardSnapshot,
  TopicDetails,
  TopicTarget,
} from "../shared/topics";
import {
  topicDraftKey,
  topicPlacements,
  type TopicsStore,
} from "./topics-model";
import {
  TopicModal,
  TopicSwitch,
  TopicConfirmation,
  TopicFeedback,
  useTopicOperation,
  topicError,
} from "./TopicsCommon";
export type TopicCardContext =
  | { kind: "topic" }
  | { kind: "current" }
  | {
      kind: "preparation";
      text: string;
      newTopic?: boolean;
      edit?: (text: string) => void;
    }
  | { kind: "run"; run: Run };
export function TopicCard({
  project,
  year,
  target: sourceTarget,
  board: initialBoard,
  store,
  context,
  host,
  onClose,
  onChanged,
  onPrepare,
  minimal = false,
  owner: providedOwner,
  contextRequired = false,
  ownerReadState = "confirmed",
  ownerReadError,
  selectedContextId,
  runs = [],
  onBusy,
}: {
  project: Project;
  year: string;
  target: TopicTarget;
  board: TopicBoardSnapshot | null;
  store: TopicsStore;
  context: TopicCardContext;
  host?: TopicBoardRecord;
  onClose: () => void;
  onChanged: () => void;
  onPrepare: (target: TopicTarget, year: string, text?: string) => void;
  onBusy?: (busy: boolean) => void;
  minimal?: boolean;
  owner?: WorktreeRecord;
  deletionOwner?: WorktreeRecord;
  contextRequired?: boolean;
  ownerReadState?: "loading" | "error" | "confirmed";
  ownerReadError?: string;
  onContextPrepared?: (record: WorktreeRecord) => void;
  selectedContextId?: string;
  runs?: RunWithContext[];
}) {
  useLocale();
  // Board rows carry display-only fields; IPC accepts only the exact identity.
  const target: TopicTarget = {
    topic: sourceTarget.topic,
    branch: sourceTarget.branch,
    remote: sourceTarget.remote,
  };
  const candidateOwner = providedOwner;
  const owner =
    candidateOwner &&
    candidateOwner.projectId === project.id &&
    candidateOwner.year === year &&
    candidateOwner.topic === target.topic &&
    candidateOwner.branch === target.branch
      ? candidateOwner
      : undefined;
  // A remote-only board card is an explicit read of the project's Git catalog,
  // never a substitute execution root for a missing local clone.
  const catalogReadOnly =
    contextRequired &&
    !owner &&
    target.remote &&
    (context.kind === "topic" || context.kind === "current");
  const missingOwner =
    contextRequired && !owner && context.kind !== "run" && !catalogReadOnly;
  const key = owner
      ? JSON.stringify([
          topicDraftKey(project.id, year, target),
          contextRequestKey(owner),
        ])
      : topicDraftKey(project.id, year, target),
    historical = context.kind === "run";
  const [board, setBoard] = useState(initialBoard),
    [details, setDetails] = useState<TopicDetails | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(
      !historical && !(context.kind === "preparation" && context.newTopic),
    ),
    [refresh, setRefresh] = useState(0),
    [, render] = useState(0),
    [base, setBase] = useState(initialBoard?.baseRef ?? ""),
    [publish, setPublish] = useState(false),
    [deleted, setDeleted] = useState(false);
  const [preparationText, setPreparationText] = useState(
    context.kind === "preparation" ? context.text : "",
  );
  const operation = useTopicOperation(
    key,
    () => {
      setRefresh((n) => n + 1);
      onChanged();
    },
    onBusy,
  );
  const loadKey = JSON.stringify([key, refresh]);
  const [settled, setSettled] = useState("");
  const cardLoading =
    loading ||
    (!historical &&
      !deleted &&
      !(context.kind === "preparation" && context.newTopic) &&
      settled !== loadKey);
  const read = useReadScope(loadKey);
  useEffect(() => {
    if (
      missingOwner ||
      historical ||
      deleted ||
      (context.kind === "preparation" && context.newTopic)
    ) {
      setLoading(false);
      setSettled(loadKey);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    Promise.all([
      read(
        "readTopicDetails",
        owner ? contextRef(owner) : project.id,
        year,
        target,
      ),
      read("readTopicBoard", owner ? contextRef(owner) : project.id, year),
    ])
      .then(
        ([doc, nextBoard]) => {
          if (!alive) return;
          setDetails(doc);
          setBoard(nextBoard);
          setBase((previous) => previous || nextBoard.baseRef);
          const draft = store.tasks.get(key);
          if (!draft || draft.text === draft.original)
            store.tasks.set(key, {
              text: doc.text,
              original: doc.text,
              version: doc.version,
            });
          render((n) => n + 1);
        },
        (e) => {
          if (alive) setError(topicError(e));
        },
      )
      .finally(() => {
        if (alive) {
          setLoading(false);
          setSettled(loadKey);
        }
      });
    return () => {
      alive = false;
    };
  }, [key, refresh, historical, deleted, missingOwner]);
  const missingMetadata =
    !!owner && details?.catalogState === "missing-local-metadata";
  const draft = store.tasks.get(key),
    dirty = !!draft && draft.text !== draft.original;
  const current =
    board?.currentTopic?.topic === target.topic &&
    board.currentTopic.branch === target.branch &&
    !target.remote;
  const ownerActive = owner
    ? contextRunActivity(runs, owner).activeCount > 0
    : !!board?.active;
  const readOnly =
    catalogReadOnly ||
    historical ||
    context.kind === "preparation" ||
    !details?.editable ||
    ownerActive;
  const isOwn =
    target.topic ===
    (target.remote
      ? target.branch.slice(target.branch.indexOf("/") + 1)
      : target.branch
    )
      .toLowerCase()
      .replace(/[^\x00-\x7f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const actionReason = (action: TopicAction): string => {
    if (catalogReadOnly)
      return tr("topics.remoteTopicOpenedForViewingOnlySelectA");
    if (missingOwner) return tr("topics.anIndependentCloneHasNotBeenPrepared");
    if (operation.busy) return tr("topics.waitForTheCurrentOperationToFinish");
    if (loading) return tr("topics.waitForTheCardToLoad");
    if (!board || error || !details)
      return tr("topics.theCardCouldNotBeLoadedOpenIt");
    if (deleted) return tr("topics.topicDeleted");
    if (missingMetadata)
      return tr("topics.firstCreateATaskInThisCopyTopic");
    if (ownerActive) return tr("topics.unavailableWhileARunIsActive");
    if (!isOwn) return tr("topics.thisBranchHasNoTopicOfItsOwn");
    if (action === "switch" && current) return tr("topics.youAreAlreadyInThisTopic");
    // Deletion resolves the whole topic, including its origin twin.
    if (
      action === "delete" &&
      target.topic ===
        board.currentBranch
          .toLowerCase()
          .replace(/[^\x00-\x7f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
    )
      return tr("topics.theCurrentTopicCannotBeDeleted");
    if (dirty) return tr("topics.saveTheTaskDraftFirst");
    if (target.remote && ["update", "publish", "propagate"].includes(action))
      return tr("topics.selectALocalTopicBranchForThisAction");
    if (
      ["update", "propagate"].includes(action) &&
      base === board.currentBranch
    )
      return tr("topics.theBaseBranchIsCurrentlyCheckedOutSwitch");
    if (
      board.dirty &&
      (action === "switch" ||
        (action === "update" &&
          !target.remote &&
          target.branch === board.currentBranch))
    )
      return tr("topics.unavailableWhileTheWorkingCopyHasUncommittedChanges");
    return "";
  };
  const ownRecord =
    board &&
    [
      ...board.entries,
      ...board.remoteEntries,
      ...board.records,
      ...board.remoteRecords,
    ].find(
      (row) =>
        row.topic === target.topic &&
        row.branch === target.branch &&
        row.remote === target.remote,
    );
  const currentYear = String(new Date().getFullYear());
  async function prepare(action: TopicAction) {
    if (!board || missingOwner || catalogReadOnly) return;
    if (action === "save-task" && missingMetadata && !draft?.text.trim())
      return;
    await operation.prepare({
      projectId: project.id,
      ...(owner ? { context: contextRef(owner) } : {}),
      year,
      expectedRevision: board.revision,
      action,
      target,
      ...(action === "save-task"
        ? { task: draft?.text, taskVersion: draft?.version }
        : {}),
      ...(action === "update" || action === "propagate"
        ? { baseRef: base }
        : {}),
      ...(action === "update" ? { publish } : {}),
    });
  }
  const commonReasonId = useId();
  const cardActions = [
    ...(!minimal ? [["switch", tr("topics.switchToTopic")] as const] : []),
    ["update", tr("topics.updateFromBase2")],
    ["publish", tr("topics.publish2")],
    ...(!owner || owner.storageKind === "clone"
      ? [
          [
            "propagate",
            owner ? tr("topics.propagateToBaseAndPublish2") : tr("topics.propagateToBase"),
          ] as const,
        ]
      : []),
    ...(!owner ? [["delete", tr("topics.deleteTopic")] as const] : []),
  ] as readonly (readonly [TopicAction, string])[];
  const commonReasons = new Map<string, string[]>();
  if (minimal)
    for (const [action, label] of cardActions) {
      const reason = actionReason(action);
      if (reason)
        commonReasons.set(reason, [
          ...(commonReasons.get(reason) ?? []),
          label.replace(/…$/, ""),
        ]);
    }
  const snapshot = historical ? context.run.taskSnapshot : undefined;
  return (
    <TopicModal
      title={target.topic || tr("topics.branchWithoutItsOwnTopic")}
      onClose={onClose}
      busy={operation.busy}
    >
      {missingOwner && (
        <section
          className="topic-card-section"
          aria-label={tr("topics.topicContextUnavailable")}
        >
          <p>{tr("topics.thisTopicSIndependentCloneIsUnverifiedThe")}</p>
        </section>
      )}
      {!missingOwner && (
        <LoadingBoundary pending={cardLoading} label={tr("topics.loadingTopic")}>
          {!cardLoading && <TopicFeedback operation={operation} />}
          {operation.plan ? (
            <TopicConfirmation
              operation={operation}
              onSuccess={() => {
                if (operation.plan?.action === "save-task")
                  store.tasks.delete(key);
                if (operation.plan?.action === "delete") setDeleted(true);
              }}
            />
          ) : error ? (
            <div className="topic-card-state">
              <div role="alert">
                <h3>{tr("topics.couldNotLoadTopic")}</h3>
                <p className="error">{error}</p>
              </div>
              {dirty && (
                <p className="hint">{tr("topics.yourUnsavedDraftRemainsInMemory")}</p>
              )}
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  setError("");
                  setRefresh((n) => n + 1);
                }}
              >{tr("launch.retryLoading")}</button>
            </div>
          ) : (
            <>
              <div className="topic-card-context">
                <strong>
                  {historical
                    ? tr("topics.topicForThisRun")
                    : context.kind === "preparation"
                      ? tr("topics.selectedForANewRun")
                      : context.kind === "current"
                        ? tr("topics.currentProjectContext")
                        : tr("topics.projectTopic")}
                </strong>
                <span>
                  {year} · {target.branch}
                </span>
                <small>
                  {historical
                    ? tr("topics.snapshotFromTheStartOfTheRunThe")
                    : current
                      ? tr("topics.thisIsTheCurrentProjectBranchSOwn")
                      : tr("topics.currentProjectBranchValue1ViewingDoesNotSwitch", { value1: board?.currentBranch || tr("launch.checking2") })}
                </small>
              </div>
              {host && host.branch !== target.branch && (
                <p className="hint">{tr("topics.selectedAndTargetBranches", { selected: host.branch, target: target.branch })}
                </p>
              )}
              {!historical && ownRecord && (
                <dl className="topic-facts">
                  <dt>{tr("topics.statusesOnTheTopicBranch")}</dt>
                  <dd>{ownRecord.statuses.join(" · ") || tr("topics.noStatus")}</dd>
                  <dt>{tr("topics.relativeToBase")}</dt>
                  <dd>{ownRecord.divergence || tr("topics.noData")}</dd>
                </dl>
              )}
              <section className="topic-card-section">
                <h3>{historical ? tr("topics.taskAtLaunch") : tr("topics.task")}</h3>
                {!historical && missingMetadata && (
                  <p className="hint" role="status">{tr("topics.thisCopyDoesNotHaveTopicDataYet")}</p>
                )}
                {historical ? (
                  <>
                    {snapshot ? (
                      <pre className="topic-task-preview">
                        {snapshot.text || tr("topics.theTaskWasEmpty")}
                      </pre>
                    ) : (
                      <p className="hint">{tr("topics.noTaskSnapshotIsAvailableForThisRun")}</p>
                    )}
                  </>
                ) : context.kind === "preparation" ? (
                  <>
                    {context.edit ? (
                      <label>{tr("topics.launchTask")}<textarea
                          rows={7}
                          value={preparationText}
                          onChange={(e) => {
                            setPreparationText(e.target.value);
                            context.edit?.(e.target.value);
                          }}
                        />
                      </label>
                    ) : (
                      <pre className="topic-task-preview">
                        {preparationText || tr("topics.noTaskYet")}
                      </pre>
                    )}
                    <p className="hint">{tr("topics.thisIsADraftFromTheLaunchForm")}</p>
                  </>
                ) : draft ? (
                  <>
                    <label className={readOnly ? "sr-only" : ""}>
                      {readOnly ? tr("topics.savedTask") : tr("topics.topicTask")}
                      {!readOnly && (
                        <textarea
                          rows={7}
                          value={draft.text}
                          disabled={operation.busy || loading}
                          onChange={(e) => {
                            store.tasks.set(key, {
                              ...draft,
                              text: e.target.value,
                            });
                            render((n) => n + 1);
                          }}
                        />
                      )}
                    </label>
                    {readOnly && (
                      <pre className="topic-task-preview">
                        {(catalogReadOnly ? details?.text : draft.text) ||
                          (missingMetadata
                            ? tr("topics.theLocalTaskFileIsMissing")
                            : tr("topics.noTaskSpecified"))}
                      </pre>
                    )}
                    {details?.reason && (
                      <p className="hint">{details.reason}</p>
                    )}
                    {dirty && (
                      <p className="topic-warning">{tr("topics.anUnsavedDraftWillStayInMemoryWhen")}</p>
                    )}
                    {!readOnly && (
                      <button
                        type="button"
                        disabled={
                          !dirty ||
                          operation.busy ||
                          loading ||
                          !!error ||
                          (missingMetadata && !draft.text.trim())
                        }
                        onClick={() => void prepare("save-task")}
                      >
                        {missingMetadata
                          ? tr("topics.createTaskInThisCopy")
                          : tr("topics.saveTask")}
                      </button>
                    )}
                    {draft.version !== details?.version && dirty && (
                      <p role="alert" className="topic-warning">{tr("topics.theSavedTaskHasChangedYourDraftWas")}</p>
                    )}
                  </>
                ) : null}
              </section>
              {!historical && board && (
                <>
                  <details className="topic-card-section">
                    <summary>{tr("topics.locations")}</summary>
                    <p className="hint">{tr("topics.allKnownLocationsNoBranchesAreSwitched")}</p>
                    {topicPlacements(board, target.topic).map((p) => (
                      <div
                        className="topic-placement"
                        key={`${p.branch}/${p.remote}`}
                      >
                        <strong>{p.branch}</strong>
                        <span>{p.statuses.join(" · ") || tr("topics.noStatus")}</span>
                        <small>{p.todo || tr("topics.noTaskSpecified")}</small>
                      </div>
                    ))}
                  </details>
                  {!deleted && (
                    <section className="topic-card-section">
                      <h3>{tr("topics.topicActions")}</h3>
                      {!minimal && board.active && (
                        <p className="topic-warning">{tr("topics.onlyViewingAndDraftsAreAvailableDuringAn")}</p>
                      )}
                      {board.dirty && (
                        <p className="hint">{tr("topics.uncommittedChangesWillNotBeIncludedInPublishing")}</p>
                      )}
                      {!isOwn && (
                        <p className="hint">{tr("topics.thisBranchHasNoTopicOfItsOwn2")}</p>
                      )}
                      {!minimal && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="primary"
                            disabled={
                              operation.busy ||
                              loading ||
                              board.active ||
                              !!error ||
                              target.remote ||
                              year !== currentYear ||
                              !isOwn
                            }
                            onClick={() =>
                              onPrepare(
                                target,
                                year,
                                context.kind === "preparation"
                                  ? preparationText
                                  : draft?.text,
                              )
                            }
                          >{tr("topics.prepareRun")}</button>
                          {(target.remote || year !== currentYear) && (
                            <p className="hint">{tr("topics.youCanPrepareARunForALocal")}</p>
                          )}
                        </>
                      )}
                      <div className="topic-operation-fields">
                        <label>{tr("topics.baseBranch")}<input
                            value={base}
                            onChange={(e) => setBase(e.target.value)}
                            disabled={operation.busy}
                            list="topic-card-bases"
                          />
                          <datalist id="topic-card-bases">
                            {board.branches.map((b) => (
                              <option key={b} value={b} />
                            ))}
                          </datalist>
                        </label>
                        <TopicSwitch
                          checked={publish}
                          onChange={() => setPublish((v) => !v)}
                          disabled={!!actionReason("update")}
                        >{tr("topics.publishAfterUpdate")}</TopicSwitch>
                      </div>
                      {minimal && commonReasons.size > 0 && (
                        <div
                          className="topic-action-reason topic-common-reasons"
                          id={commonReasonId}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <rect x="5" y="10" width="14" height="11" rx="2" />
                            <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
                          </svg>
                          <div>
                            {[...commonReasons].map(([reason, labels]) => (
                              <p key={reason}>
                                {labels.length === cardActions.length ? null : (
                                  <strong>{labels.join(" / ")}: </strong>
                                )}
                                {reason}
                              </p>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="topic-operation-grid">
                        {cardActions.map(([action, label]) => {
                          const reason = actionReason(action);
                          return (
                            <div className="topic-action" key={action}>
                              <button
                                type="button"
                                className={
                                  action === "delete" ? "danger" : undefined
                                }
                                disabled={!!reason}
                                aria-describedby={
                                  reason
                                    ? minimal
                                      ? commonReasonId
                                      : `topic-action-${action}-reason`
                                    : undefined
                                }
                                onClick={() => void prepare(action)}
                              >
                                {label}
                              </button>
                              {!minimal && reason && (
                                <p
                                  className="topic-action-reason"
                                  id={`topic-action-${action}-reason`}
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.7"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                    focusable="false"
                                  >
                                    <rect
                                      x="5"
                                      y="10"
                                      width="14"
                                      height="11"
                                      rx="2"
                                    />
                                    <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
                                  </svg>
                                  <span>{reason}</span>
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <p className="hint">
                        {!minimal &&
                          tr("topics.preparingARunOnlyFillsInTheForm")}{tr("topics.allChangesRequireConfirmation")}{" "}
                        {owner?.storageKind === "clone"
                          ? tr("topics.applyToBaseIsLocalOnlyPropagateTo")
                          : !owner &&
                            tr("topics.propagatingToBaseIncludesPublishingTheBaseBranch")}
                      </p>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </LoadingBoundary>
      )}
      {!historical &&
        (owner && !topicSyncUnavailable(owner) ? (
          <TopicSyncActions
            key={contextRequestKey(owner)}
            owner={contextRef(owner)}
            onChanged={onChanged}
          />
        ) : (
          <section
            className="topic-card-section topic-sync"
            aria-label={tr("topics.transferChanges")}
          >
            <h3>{tr("topics.transferChanges")}</h3>
            <p role={ownerReadState === "error" && !owner ? "alert" : "status"}>
              {!owner && ownerReadState === "loading"
                ? tr("topics.checkingForAWorkingCopy")
                : !owner && ownerReadState === "error"
                  ? tr("topics.couldNotVerifyTheWorkingCopyItsAbsence")
                  : providedOwner && !owner
                    ? tr("topics.theWorkingCopyContextCouldNotBeVerified")
                    : topicSyncUnavailable(owner)}
            </p>
            {!owner && ownerReadState === "error" && ownerReadError && (
              <p className="error">{ownerReadError}</p>
            )}
            <div className="form-actions">
              <button type="button" disabled>{tr("topics.sync")}</button>
              <button type="button" disabled>{tr("topics.applyToBase")}</button>
            </div>
          </section>
        ))}
      {owner?.storageKind === "clone" && !historical && (
        <ContextDeletionAction
          key={`delete-${contextRequestKey(owner)}`}
          owner={contextRef(owner)}
          current={selectedContextId === owner.contextId}
          active={contextRunActivity(runs, owner).activeCount > 0}
          onDeleted={() => {
            setDeleted(true);
            onChanged();
          }}
        />
      )}
    </TopicModal>
  );
}
