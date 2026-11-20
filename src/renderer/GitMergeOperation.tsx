import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useRef, useState } from "react";
import type { ScopeRef } from "../shared/context";
import {
  gitMergeOperationRequestSchema,
  gitMergeOperationTokenSchema,
  type GitMergeOperationPreview,
} from "../shared/git-operations";
import type { GitWorkspaceSnapshot } from "../shared/git-workspace";
import {
  nativeSequenceDiagnostics,
  verifiedNativeSequenceResult,
} from "./git-native-sequence-result";
import {
  formatGitDiagnostics,
  hasGitDiagnostics,
} from "./git-operation-diagnostics";
import { LoadingState } from "./LoadingBoundary";
import { readWithSignal } from "./read-request";
import { documentScopeId } from "./settings-documents";
import { TopicModal, topicError } from "./TopicsCommon";
type Action = "continue" | "abort";
const validMessage = (message: string) =>
  !!message.trim() && message.length <= 16384 && !message.includes("\0");
interface Options {
  scope: ScopeRef;
  snapshot: GitWorkspaceSnapshot | null;
  visible: boolean;
  ready: boolean;
  blocked: boolean;
  unresolved: boolean;
  freshness: string;
  /** Issued sequence of the last successfully accepted workspace read. */
  readVersion: number;
  /** Synchronous owner-local sequence of ALL started workspace reads. */
  getIssuedReadVersion(): number;
  onSucceeded(scope: ScopeRef): void;
}
/** The retained stable owner owns drafts and writes; only reads follow visibility. */
export function useGitMergeOperation(options: Options) {
  const [draft, setDraft] = useState<string | undefined>();
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<GitMergeOperationPreview | null>(null);
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [result, setResult] = useState("");
  const [rereadAfter, setRereadAfter] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true),
    flight = useRef<"prepare" | "execute" | null>(null);
  const read = useRef<AbortController | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const boundFreshness = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const supported =
    typeof window.goga.prepareGitMergeOperation === "function" &&
    typeof window.goga.executeGitMergeOperation === "function";
  const needsRefresh =
    rereadAfter !== null && options.readVersion <= rereadAfter;
  const available = () => {
    const current = latest.current;
    return (
      supported &&
      current.visible &&
      current.ready &&
      !current.blocked &&
      current.snapshot?.operation === "merge" &&
      documentScopeId(current.snapshot.scope) === documentScopeId(current.scope)
    );
  };
  const close = () => {
    read.current?.abort();
    setAction(null);
    setPreview(null);
    setExpired(false);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, []);
  useEffect(() => {
    close();
  }, [options.freshness, options.visible, options.ready, options.blocked]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        setPreview(null);
        setExpired(true);
      },
      Math.max(0, preview.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  async function prepare(nextAction: Action) {
    if (
      flight.current ||
      !available() ||
      needsRefresh ||
      (nextAction === "continue" && latest.current.unresolved)
    )
      return;
    const issued = latest.current,
      snapshot = issued.snapshot!;
    const message = draftRef.current;
    const request =
      nextAction === "abort"
        ? {
            scope: issued.scope,
            revision: snapshot.revision,
            action: nextAction,
          }
        : {
            scope: issued.scope,
            revision: snapshot.revision,
            action: nextAction,
            ...(message !== undefined ? { message } : {}),
          };
    if (!gitMergeOperationRequestSchema.safeParse(request).success) {
      // A retained empty/oversize message must remain reachable for editing.
      // Opening this form grants no token and performs no read or write.
      if (
        nextAction === "continue" &&
        message !== undefined &&
        !validMessage(message)
      ) {
        setAction(nextAction);
        setPreview(null);
        setExpired(false);
      }
      return;
    }
    flight.current = "prepare";
    setPending("prepare");
    setAction(nextAction);
    setPreview(null);
    setResult("");
    setExpired(false);
    const controller = new AbortController();
    read.current = controller;
    try {
      const value = await readWithSignal(
        controller.signal,
        "prepareGitMergeOperation",
        request,
      );
      if (
        !alive.current ||
        controller.signal.aborted ||
        issued.freshness !== latest.current.freshness ||
        !available()
      )
        return;
      if (
        documentScopeId(value.scope) !== documentScopeId(issued.scope) ||
        value.action !== nextAction ||
        value.operation !== "merge" ||
        value.root !== snapshot.root ||
        value.branch !== snapshot.branch ||
        value.head !== snapshot.head ||
        !/^[a-f0-9]{40,64}$/.test(value.sourceOid) ||
        value.hooks !== "disabled" ||
        !gitMergeOperationTokenSchema.safeParse(value.token).success ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= Date.now() ||
        (nextAction === "continue" &&
          (!validMessage(value.message) ||
            (message !== undefined && value.message !== message)))
      )
        throw Error(
          msg("git.confirmationIsOutdatedOrBelongsToADifferentContextState"),
        );
      boundFreshness.current = issued.freshness;
      if (nextAction === "continue") {
        setDraft(value.message);
        draftRef.current = value.message;
      }
      setPreview(value);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) {
        setAction(null);
        setPreview(null);
        setResult(topicError(error));
      }
    } finally {
      if (read.current === controller) {
        read.current = null;
        flight.current = null;
        if (alive.current) setPending(null);
      }
    }
  }
  async function execute() {
    if (
      flight.current ||
      !preview ||
      !available() ||
      needsRefresh ||
      boundFreshness.current !== latest.current.freshness ||
      preview.expiresAt <= Date.now() ||
      (preview.action === "continue" &&
        (latest.current.unresolved ||
          !validMessage(draftRef.current ?? "") ||
          draftRef.current !== preview.message))
    )
      return;
    const submitted = preview,
      issuedScope = preview.scope;
    flight.current = "execute";
    setPending("execute");
    setPreview(null);
    setAction(null);
    try {
      // No renderer timeout, cancellation, or automatic retry is allowed for writes.
      const value = await window.goga.executeGitMergeOperation(submitted.token);
      if (!alive.current) return;
      // Fence every read already started, including replies queued in this
      // React batch. Only a successful read started AFTER this result qualifies.
      setRereadAfter(latest.current.getIssuedReadVersion());
      if (
        documentScopeId(value.scope) !== documentScopeId(issuedScope) ||
        value.operation !== "merge" ||
        value.action !== submitted.action
      )
        throw Error(msg("git.theResultBelongsToAnotherContextOrAction"));
      const verified = verifiedNativeSequenceResult(value, {
        scope: issuedScope,
        operation: "merge",
        action: submitted.action,
        head: submitted.head,
        original: submitted.head,
      });
      if (
        verified &&
        value.status === "success" &&
        !value.lockRetained &&
        !value.retainedLocks?.length &&
        !value.uncheckedLocks?.length &&
        !value.recoveryUnverified
      ) {
        setDraft(undefined);
        draftRef.current = undefined;
        latest.current.onSucceeded(issuedScope);
      }
      if (!verified)
        setResult(
          [nativeSequenceDiagnostics(value, false), formatGitDiagnostics(value)]
            .filter(Boolean)
            .join("\n\n"),
        );
      else if (hasGitDiagnostics(value)) setResult(formatGitDiagnostics(value));
    } catch (error) {
      if (alive.current) {
        setRereadAfter(latest.current.getIssuedReadVersion());
        setResult(
          msg("git.checkTheGitStateTheResponseDoesNotConfirmThat2", { value1: String(topicError(error)) }),
        );
      }
    } finally {
      flight.current = null;
      if (alive.current) setPending(null);
    }
  }
  return {
    supported,
    pending,
    preview,
    draft,
    action,
    result,
    needsRefresh,
    expired,
    locked: !!pending || !!action,
    modalOpen: !!action || !!result,
    canStart: available() && !pending && !action && !result && !needsRefresh,
    canExecute:
      !!preview &&
      !pending &&
      available() &&
      !needsRefresh &&
      boundFreshness.current === options.freshness &&
      preview.expiresAt > Date.now() &&
      (preview.action === "abort" ||
        (!options.unresolved &&
          validMessage(draft ?? "") &&
          draft === preview.message)),
    messageValid: validMessage(draft ?? ""),
    prepare,
    execute,
    close,
    closeResult: () => setResult(""),
    edit: (message: string) => {
      if (flight.current) return;
      setDraft(message);
      draftRef.current = message;
      setPreview(null);
      setExpired(false);
    },
  };
}
type MergeState = ReturnType<typeof useGitMergeOperation>;
export function GitMergeOperationFooter({
  merge,
  unresolved,
}: {
  merge: MergeState;
  unresolved: boolean;
}) {
  useLocale();
  if (!merge.supported)
    return (
      <p>{msg("git.continuingAndAbortingAMergeAreUnavailableWithThisConnection")}</p>
    );
  return (
    <div className="git-merge-operation-footer">
      <p role={merge.pending === "execute" ? "status" : undefined}>
        {merge.pending === "execute"
          ? msg("git.mergeInProgressYouCanCloseThisViewTheWrite")
          : merge.needsRefresh
            ? msg("git.refreshChangesAndCheckTheGitStateFirstANew")
            : unresolved
              ? msg("git.resolveAndSaveEachFileFirstConflictsOrUnsavedDrafts")
              : msg("git.savingAFileAndFinishingAMergeAreSeparateActions")}
      </p>
      <div>
        <button
          type="button"
          className="danger"
          disabled={!merge.canStart}
          onClick={() => void merge.prepare("abort")}
        >{msg("git.abortMerge2")}</button>
        <button
          type="button"
          className="primary"
          disabled={!merge.canStart || unresolved}
          onClick={() => void merge.prepare("continue")}
        >{msg("git.finishMerge")}</button>
      </div>
    </div>
  );
}
export function GitMergeOperationDialogs({ merge }: { merge: MergeState }) {
  useLocale();
  const closeOnEscape = (event: React.KeyboardEvent, close: () => void) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  return (
    <>
      {merge.action && (
        <div onKeyDown={(event) => closeOnEscape(event, merge.close)}>
          <TopicModal
            title={
              merge.action === "continue"
                ? msg("git.finishMerge2")
                : msg("git.abortMerge")
            }
            closeLabel={msg("git.closeMergeConfirmation")}
            className="git-merge-operation-modal"
            onClose={merge.close}
          >
            <div className="git-merge-operation-form">
              {merge.pending === "prepare" ? (
                <LoadingState label={msg("git.checkingMerge")} />
              ) : (
                <>
                  <div className="git-merge-operation-details">
                    {merge.action === "abort" && (
                      <p className="git-conflict-warning">{msg("git.manualConflictResolutionsWillBeLostUnrelatedChangesMustBe")}</p>
                    )}
                    {merge.preview && (
                      <>
                        <dl>
                          <dt>{msg("git.context")}</dt>
                          <dd
                            title={
                              typeof merge.preview.scope === "string"
                                ? merge.preview.scope
                                : merge.preview.scope.contextId
                            }
                          >
                            {typeof merge.preview.scope === "string"
                              ? msg("git.originalFolder", { scope: String(merge.preview.scope) })
                              : `${merge.preview.scope.projectId} / ${merge.preview.scope.year} / ${merge.preview.scope.topic} · ${merge.preview.scope.contextId.slice(0, 12)}…`}
                          </dd>
                          <dt>{msg("git.workingDirectory")}</dt>
                          <dd>{merge.preview.root}</dd>
                          <dt>{msg("git.branch2")}</dt>
                          <dd>{merge.preview.branch}</dd>
                          <dt>HEAD</dt>
                          <dd>{merge.preview.head}</dd>
                          <dt>{msg("git.incomingCommit")}</dt>
                          <dd>{merge.preview.sourceOid}</dd>
                          {merge.action === "continue" && (
                            <>
                              <dt>{msg("git.author")}</dt>
                              <dd>{merge.preview.author ?? msg("git.unknown")}</dd>
                              <dt>{msg("git.committer")}</dt>
                              <dd>
                                {merge.preview.committer ?? msg("git.unknown")}
                              </dd>
                              <dt>{msg("git.signing")}</dt>
                              <dd>
                                {merge.preview.signing
                                  ? msg("git.fromGitConfiguration")
                                  : msg("git.notConfigured")}
                              </dd>
                            </>
                          )}
                        </dl>
                        <p>{merge.preview.effects}</p>
                        <strong>{msg("git.affectedPaths")}{merge.preview.paths.length}
                        </strong>
                        <ul>
                          {merge.preview.paths.map((path) => (
                            <li key={path}>
                              <code>{path}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <p>{msg("git.unsupportedStrategiesOrUnverifiedMergeStateMayBeRejectedWithout")}</p>
                  </div>
                  <div className="git-merge-operation-confirm">
                    <p className="hint">{msg("git.gitHooksAreDisabledNothingIsPushedToTheServer")}</p>
                    {merge.action === "continue" && (
                      <label>{msg("git.mergeCommitMessage")}<textarea
                          aria-label={msg("git.mergeCommitMessage")}
                          rows={4}
                          value={merge.draft ?? ""}
                          onChange={(event) => merge.edit(event.target.value)}
                        />
                      </label>
                    )}
                    {!merge.preview && (
                      <p>
                        {merge.expired
                          ? msg("git.confirmationExpiredCheckTheOperationAgain")
                          : msg("git.theMessageChangedCheckItAgainBeforeWriting")}
                      </p>
                    )}
                    <div className="git-branch-dialog-actions">
                      <button type="button" onClick={merge.close}>{msg("git.cancel")}</button>
                      {!merge.preview && (
                        <button
                          type="button"
                          disabled={
                            merge.action === "continue" && !merge.messageValid
                          }
                          onClick={() => void merge.prepare(merge.action!)}
                        >
                          {merge.action === "continue"
                            ? msg("git.checkMessage")
                            : msg("git.checkAbort")}
                        </button>
                      )}
                      <button
                        type="button"
                        className={
                          merge.action === "continue" ? "primary" : "danger"
                        }
                        disabled={!merge.canExecute}
                        onClick={() => void merge.execute()}
                      >
                        {merge.action === "continue"
                          ? msg("git.createMergeCommit")
                          : msg("git.abortMerge3")}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </TopicModal>
        </div>
      )}
      {!!merge.result && (
        <div onKeyDown={(event) => closeOnEscape(event, merge.closeResult)}>
          <TopicModal
            title={msg("git.mergeResult")}
            closeLabel={msg("git.closeMergeResult")}
            className="git-workspace-error"
            onClose={merge.closeResult}
          >
            <pre>{merge.result}</pre>
          </TopicModal>
        </div>
      )}
    </>
  );
}
