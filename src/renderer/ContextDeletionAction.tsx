import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useContextDeletionExecutor } from "./ContextDeletionController";
import type { DeletionPreview } from "./context-deletion-flow";
import { useEffect, useId, useRef, useState } from "react";
import type { TopicContextRef } from "../shared/worktrees";
import { contextRef, contextRequestKey } from "./topic-context";
import { useReadScope } from "./read-request";
type Plan = DeletionPreview;
export function ContextDeletionAction({
  owner,
  current,
  active,
  onDeleted,
  autoPrepare = false,
  onBusy,
  onCancel,
}: {
  owner: TopicContextRef;
  current: boolean;
  active: boolean;
  onDeleted: () => void;
  autoPrepare?: boolean;
  onBusy?: (value: boolean) => void;
  onCancel?: () => void;
}) {
  useLocale();
  const executor = useContextDeletionExecutor();
  const [allowAhead, setAllowAhead] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false),
    [retry, setRetry] = useState(false);
  const recoveryAvailable =
    typeof window.goga.contextDeletionRecovery === "function";
  const [recoveryLoading, setRecoveryLoading] = useState(recoveryAvailable),
    [recoveryFailed, setRecoveryFailed] = useState(false),
    [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const read = useReadScope(contextRequestKey(owner));
  const reasonId = useId();
  const [switchBranch, setSwitchBranch] = useState("");
  const flight = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!recoveryAvailable) return;
    let alive = true;
    setRecoveryLoading(true);
    setRecoveryFailed(false);
    read("contextDeletionRecovery", contextRef(owner))
      .then((recovered) => {
        if (!alive) return;
        if (recovered) {
          if (recovered.contextId !== owner.contextId)
            throw Error(msg("workspace.theDeletionLogBelongsToAnotherWorkingCopy"));
          setPlan(recovered);
          setRetry(true);
          setConfirmationOpen(true);
        }
      })
      .catch((e) => {
        if (alive) {
          setRecoveryFailed(true);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (alive) setRecoveryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [read, recoveryAvailable, recoveryAttempt]);
  const reason = active
    ? msg("workspace.unavailableWhileARunIsActiveInThisWorkingCopy")
    : "";
  const needsAheadConfirmation =
    plan?.stage === "prepared" && plan.requiresAheadConfirmation;
  async function prepare(branch?: string) {
    if (reason || flight.current || recoveryLoading || recoveryFailed) return;
    if (plan && !branch) {
      setConfirmationOpen(true);
      return;
    }
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = branch
        ? await read("prepareContextDeletion", contextRef(owner), branch)
        : await read("prepareContextDeletion", contextRef(owner));
      if (mounted.current) {
        setPlan(next);
        setConfirmationOpen(true);
        setRetry(false);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const autoStarted = useRef(false);
  useEffect(() => {
    if (
      autoPrepare &&
      !autoStarted.current &&
      !recoveryLoading &&
      !recoveryFailed
    ) {
      autoStarted.current = true;
      void prepare();
    }
  }, [autoPrepare, recoveryLoading, recoveryFailed]);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  async function execute() {
    if (
      !plan ||
      plan.stage === "choose-branch" ||
      reason ||
      flight.current ||
      (needsAheadConfirmation && !allowAhead)
    )
      return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!executor)
        throw Error(
          msg("workspace.theDeletionControllerIsUnavailableReopenTheTopicCard"),
        );
      const result = await executor(owner, plan, allowAhead);
      if (!mounted.current) return;
      if (result.status !== "success") {
        setRetry(true);
        if (result.stage)
          setPlan((previous) =>
            previous ? { ...previous, stage: result.stage! } : previous,
          );
        setError(
          `${result.message}${result.stage ? msg("workspace.step", { stage: String(result.stage) }) : ""}`,
        );
        return;
      }
      setPlan(null);
      setConfirmationOpen(false);
      setCompleted(true);
      onDeleted();
    } catch (e) {
      if (mounted.current) {
        setRetry(true);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="topic-card-section"
      aria-label={msg("workspace.deleteTopicAndWorkingCopy")}
    >
      {completed ? (
        <p role="status">{msg("workspace.topicAndWorkingCopyDeleted")}</p>
      ) : (
        <>
          {reason && (
            <p className="topic-action-reason" id={reasonId}>
              {reason}
            </p>
          )}
          {(!autoPrepare || !confirmationOpen) && (
            <button
              type="button"
              className="danger"
              aria-describedby={reason ? reasonId : undefined}
              disabled={busy || !!reason || recoveryLoading || recoveryFailed}
              onClick={() => void prepare()}
            >
              {recoveryLoading
                ? msg("workspace.checkingUnfinishedDeletion")
                : plan
                  ? msg("workspace.resumeDeletion")
                  : msg("workspace.deleteTopicAndWorkingCopy2")}
            </button>
          )}
          {recoveryFailed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError("");
                setRecoveryAttempt((n) => n + 1);
              }}
            >{msg("workspace.checkUnfinishedDeletion")}</button>
          )}
          {plan && confirmationOpen && (
            <div
              className="topic-confirmation"
              role="region"
              aria-label={msg("workspace.confirmTopicAndWorkingCopyDeletion")}
            >
              <h3>
                {retry
                  ? msg("workspace.resumeUnfinishedDeletion")
                  : msg("workspace.deleteTheTopicAndItsStandaloneClone")}
              </h3>
              {retry && (
                <p className="topic-warning">{msg("workspace.unfinishedOperationStep")}{plan.stage}{msg("workspace.retryingUsesTheOriginalConfirmedPlanRatherThanCreatingA")}</p>
              )}
              {plan.stage === "choose-branch" && (
                <label>{msg("workspace.switchToBranch")}<select
                    aria-label={msg("workspace.switchToBranch")}
                    value={switchBranch}
                    disabled={busy}
                    onChange={(e) => setSwitchBranch(e.target.value)}
                  >
                    <option value="">{msg("workspace.selectALocalBranch")}</option>
                    {plan.switchBranches?.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {plan.stage === "choose-branch" &&
                !plan.switchBranches?.length && (
                  <p className="hint">{msg("workspace.noOtherLocalBranchIsAvailableCreateOneInThe")}</p>
                )}
              <ul>
                {plan.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
              <p className="hint">{msg("workspace.theOriginalProjectFolderWillNotBeDeletedRunsLocal")}</p>
              {plan.clonePath && (
                <p className="hint">{msg("workspace.moveToTrash")}<code>{plan.clonePath}</code>
                </p>
              )}
              {needsAheadConfirmation && (
                <label className="topic-warning">
                  <input
                    type="checkbox"
                    checked={allowAhead}
                    disabled={busy}
                    onChange={(e) => setAllowAhead(e.target.checked)}
                  />{msg("workspace.theCloneContainsCommitsNotTransferredToTheOriginalProject")}{plan.aheadCount !== undefined ? ` (${plan.aheadCount})` : ""}{msg("workspace.deleteTheCloneAndItsGitHistoryAnyway")}</label>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmationOpen(false);
                    onCancel?.();
                  }}
                >{msg("workspace.cancel")}</button>
                <button
                  type="button"
                  className="danger"
                  disabled={
                    busy ||
                    (plan.stage === "choose-branch" && !switchBranch) ||
                    !!reason ||
                    (!!needsAheadConfirmation && !allowAhead)
                  }
                  onClick={() =>
                    plan.stage === "choose-branch"
                      ? void prepare(switchBranch)
                      : void execute()
                  }
                >
                  {plan.stage === "choose-branch"
                    ? msg("workspace.checkSelectedBranch")
                    : retry
                      ? msg("workspace.retryDeletion")
                      : msg("workspace.confirmDeletion")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
