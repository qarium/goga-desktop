import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import {
  verifiedNativeSequenceResult,
  nativeSequenceDiagnostics,
} from "./git-native-sequence-result";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import type { GitWorkspaceSnapshot } from "../shared/git-workspace";
import {
  gitSequencerOperationRequestSchema,
  gitSequencerOperationTokenSchema,
  type GitSequencerOperationPreview,
} from "../shared/git-sequencer-operations";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { TopicModal, topicError } from "./TopicsCommon";
import { LoadingState } from "./LoadingBoundary";
type Action = "continue" | "abort";
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const text = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\0"));
const recoveryPath = text.refine((v) => v.startsWith("/"));
const previewSchema = z.object({
  scope: scopeRefSchema,
  token: gitSequencerOperationTokenSchema,
  root: text,
  operation: z.enum(["cherry-pick", "revert"]),
  current: oid,
  requiresCommitWarning: z.boolean(),
  action: z.enum(["continue", "abort"]),
  branch: text.refine((v) => !/[\x00-\x20\x7f]/.test(v)),
  head: oid,
  original: oid,
  paths: z.array(text),
  discardedResolutionPaths: z.array(text),
  hooks: z.literal("disabled"),
  effects: text,
  expiresAt: z.number().finite(),
});
const resultSchema = z.object({
  scope: scopeRefSchema,
  operation: z.enum(["cherry-pick", "revert"]),
  action: z.enum(["continue", "abort"]),
  status: z.enum(["success", "conflict", "error", "uncertain"]),
  changed: z.boolean(),
  mutationStarted: z.boolean(),
  worktreeRestored: z.boolean(),
  indexPublished: z.boolean(),

  metadataCleared: z.boolean(),
  objectsPublished: z.boolean(),
  publishedObjectCount: z.number().int().nonnegative(),
  branchPublished: z.boolean(),
  metadataPublished: z.boolean(),
  worktreeUpdated: z.boolean(),
  recoveryStatus: z.enum(["not-created", "retained", "missing", "unverified"]),
  recoveryPath: recoveryPath.optional(),
  lastKnownRecoveryPath: recoveryPath.optional(),
  lockRetained: z.boolean(),
  retainedLocks: z.array(text),
  uncheckedLocks: z.array(text),
  message: z.string(),
  log: z.string(),
});
/** A host status alone does not authorize discarding drafts or claiming completion. */
function verifiedResult(
  value: unknown,
  submitted: GitSequencerOperationPreview,
): boolean {
  if (value && typeof value === "object" && "native" in value)
    return verifiedNativeSequenceResult(value, submitted);
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return false;
  const v = parsed.data;
  if (
    documentScopeId(v.scope) !== documentScopeId(submitted.scope) ||
    v.action !== submitted.action ||
    v.operation !== submitted.operation ||
    !v.changed ||
    !v.mutationStarted ||
    !v.indexPublished ||
    v.lockRetained ||
    v.retainedLocks.length ||
    v.uncheckedLocks.length ||
    v.recoveryStatus !== "retained" ||
    !v.recoveryPath ||
    (v.lastKnownRecoveryPath !== undefined &&
      v.lastKnownRecoveryPath !== v.recoveryPath)
  )
    return false;
  if (!v.branchPublished || !v.metadataPublished) return false;
  if (v.action === "abort")
    return (
      v.status === "success" &&
      v.worktreeRestored &&
      v.metadataCleared &&
      !v.worktreeUpdated &&
      !v.objectsPublished &&
      v.publishedObjectCount === 0
    );
  return (
    !v.worktreeRestored &&
    v.worktreeUpdated === true &&
    v.objectsPublished === true &&
    v.publishedObjectCount !== undefined &&
    ((v.status === "success" && v.metadataCleared) ||
      (v.status === "conflict" && !v.metadataCleared))
  );
}
/** Even malformed replies retain each observable fact, without treating omissions as false. */
function diagnostics(value: unknown, verified: boolean): string {
  if (value && typeof value === "object" && "native" in value)
    return nativeSequenceDiagnostics(value, verified);
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const bool = (field: string) =>
    v[field] === true ? msg("git.yes") : v[field] === false ? msg("git.no") : msg("git.unconfirmed");
  const str = (field: string) =>
    typeof v[field] === "string" ? (v[field] as string) : msg("git.unconfirmed");
  const locks = (field: string) => {
    const entries = v[field];
    if (!Array.isArray(entries)) return msg("git.notChecked");
    const observed = entries.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (observed.length !== entries.length)
      return msg("git.observedNamesTheListIsIncompleteOrUnverifiedAndPresence", { value1: String(observed.length ? observed.join(", ") : msg("git.notReceived")) });
    return observed.length ? observed.join(", ") : msg("git.no");
  };
  const recoveryVerified =
    v.recoveryStatus === "retained" &&
    recoveryPath.safeParse(v.recoveryPath).success &&
    (v.lastKnownRecoveryPath === undefined ||
      v.lastKnownRecoveryPath === v.recoveryPath);
  const recovery = recoveryVerified
    ? msg("git.verifiedRecoveryFiles", { value1: String(str("recoveryPath")) })
    : v.recoveryStatus === "missing"
      ? msg("git.recoveryFilesAreMissingTheirIntegrityIsUnconfirmed")
      : v.recoveryStatus === "unverified"
        ? msg("git.presenceOwnershipOrIntegrityOfRecoveryFilesWereNotVerified")
        : v.recoveryStatus === "not-created"
          ? msg("git.noRecoveryFilesWereCreated")
          : msg("git.recoveryStateIsUnconfirmed");
  return [
    verified
      ? v.status === "conflict"
        ? msg("git.anotherConflictOccurredTheOperationIsNotFinishedTheUpdated")
        : v.action === "abort"
          ? msg("git.abortConfirmed")
          : msg("git.completionConfirmed")
      : msg("git.theResultIsUnconfirmedCheckTheGitStateTheResponse"),
    msg("git.hostReport", { value1: String(str("status")), value2: String(str("message")) }),
    typeof v.log === "string" && v.log,
    msg("git.changesWriteStartedWorkingDirectoryRestoredWorkingDirectoryUpdatedObject2", { value1: String(bool("changed")), value2: String(bool("mutationStarted")), value3: String(bool("worktreeRestored")), value4: String(bool("worktreeUpdated")), value5: String(bool("objectsPublished")), value6: String(typeof v.publishedObjectCount === "number" && Number.isSafeInteger(v.publishedObjectCount) && v.publishedObjectCount >= 0 ? v.publishedObjectCount : msg("git.unconfirmed")), value7: String(bool("indexPublished")), value8: String(bool("branchPublished")), value9: String(bool("metadataPublished")), value10: String(bool("metadataCleared")) }),
    msg("git.anUnfinishedObjectPublicationStepDoesNotMeanNothingWas"),
    recovery,
    typeof v.lastKnownRecoveryPath === "string" &&
      msg("git.lastKnownPathIntegrityUnconfirmed", { lastKnownRecoveryPath: String(v.lastKnownRecoveryPath) }),
    !recoveryVerified &&
      typeof v.recoveryPath === "string" &&
      msg("git.observedRecoveryPathIntegrityUnconfirmed", { recoveryPath: String(v.recoveryPath) }),
    msg("git.lockRetainedRetainedLocksUnverifiedLocksTheirPresenceAndOwnership", { value1: String(bool("lockRetained")), value2: String(locks("retainedLocks")), value3: String(locks("uncheckedLocks")) }),
    msg("git.originalReflogsAreNotAppendedToTheRecoveryLogIs"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
interface Options {
  scope: ScopeRef;
  snapshot: GitWorkspaceSnapshot | null;
  visible: boolean;
  ready: boolean;
  blocked: boolean;
  unresolved: boolean;
  freshness: string;
  readVersion: number;
  getIssuedReadVersion(): number;
  onSucceeded(scope: ScopeRef): void;
}
/** The retained owner, not its visibility, owns the non-cancellable write. */
export function useGitSequencerOperation(options: Options) {
  const [displayOperation, setDisplayOperation] = useState<
    "cherry-pick" | "revert"
  >("cherry-pick");
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<GitSequencerOperationPreview | null>(
    null,
  );
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [result, setResult] = useState("");
  const [rereadAfter, setRereadAfter] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true),
    flight = useRef<"prepare" | "execute" | null>(null),
    read = useRef<AbortController | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const bound = useRef<{ freshness: string; read: number } | null>(null);
  const supported =
    typeof window.goga.prepareGitSequencerOperation === "function" &&
    typeof window.goga.executeGitSequencerOperation === "function";
  const needsRefresh =
    rereadAfter !== null && options.readVersion <= rereadAfter;
  const available = () => {
    const o = latest.current;
    return (
      supported &&
      o.visible &&
      o.ready &&
      !o.blocked &&
      (o.snapshot?.operation === "cherry-pick" ||
        o.snapshot?.operation === "revert") &&
      oid.safeParse(o.snapshot.head).success &&
      documentScopeId(o.snapshot.scope) === documentScopeId(o.scope)
    );
  };
  const close = () => {
    read.current?.abort();
    read.current = null;
    if (flight.current === "prepare") {
      flight.current = null;
      setPending(null);
    }
    bound.current = null;
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
  async function prepare(next: Action) {
    if (
      flight.current ||
      !available() ||
      needsRefresh ||
      (next === "continue" && latest.current.unresolved)
    )
      return;
    const issued = latest.current,
      snapshot = issued.snapshot!,
      issuedRead = issued.getIssuedReadVersion();
    const request = {
      scope: issued.scope,
      revision: snapshot.revision,
      action: next,
      operation: snapshot.operation,
    };
    const parsedRequest = gitSequencerOperationRequestSchema.safeParse(request);
    if (!parsedRequest.success) return;
    flight.current = "prepare";
    setPending("prepare");
    setAction(next);
    setDisplayOperation(snapshot.operation as "cherry-pick" | "revert");
    setPreview(null);
    setResult("");
    setExpired(false);
    const controller = new AbortController();
    read.current = controller;
    try {
      const raw = await readWithSignal(
        controller.signal,
        "prepareGitSequencerOperation",
        parsedRequest.data,
      );
      if (
        !alive.current ||
        controller.signal.aborted ||
        issued.freshness !== latest.current.freshness ||
        issuedRead !== latest.current.getIssuedReadVersion() ||
        !available()
      )
        return;
      const checked = previewSchema.safeParse(raw);
      if (!checked.success)
        throw Error(
          msg("git.gitConfirmationContainsUnverifiedFieldsRefreshChangesAndCheckAgain"),
        );
      const value = checked.data;
      if (
        documentScopeId(value.scope) !== documentScopeId(issued.scope) ||
        value.root !== snapshot.root ||
        value.head !== snapshot.head ||
        value.action !== next ||
        value.operation !== snapshot.operation ||
        value.expiresAt <= Date.now() ||
        (typeof issued.scope !== "string"
          ? value.branch !== issued.scope.branch
          : snapshot.branch !== null && value.branch !== snapshot.branch)
      )
        throw Error(
          msg("git.confirmationIsOutdatedOrBelongsToADifferentContextState"),
        );
      bound.current = { freshness: issued.freshness, read: issuedRead };
      setPreview(value);
    } catch (error) {
      if (
        alive.current &&
        !controller.signal.aborted &&
        issued.freshness === latest.current.freshness &&
        available()
      ) {
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
  const validConfirmation = () =>
    !!preview &&
    available() &&
    !needsRefresh &&
    bound.current?.freshness === latest.current.freshness &&
    bound.current.read === latest.current.getIssuedReadVersion() &&
    preview.expiresAt > Date.now() &&
    preview.operation === latest.current.snapshot?.operation &&
    (preview.action === "abort" || !latest.current.unresolved);
  async function execute() {
    if (flight.current || !validConfirmation() || !preview) return;
    const submitted = preview;
    // Consume authorization before awaiting, including stale event closures.
    bound.current = null;
    flight.current = "execute";
    setPending("execute");
    setPreview(null);
    setAction(null);
    try {
      // Writes deliberately have no renderer cancellation, timeout, or retry.
      const value = await window.goga.executeGitSequencerOperation(
        submitted.token,
      );
      if (
        !alive.current ||
        documentScopeId(latest.current.scope) !==
          documentScopeId(submitted.scope)
      )
        return;
      // Fence ALL already-issued reads, including a reply queued in this React batch.
      setRereadAfter(latest.current.getIssuedReadVersion());
      // Identity must be proven before displaying even diagnostic data. A reply
      // for another owner/action must not leak its paths, messages, or journal.
      const identity = z
        .object({
          scope: scopeRefSchema,
          operation: z.enum(["cherry-pick", "revert"]),
          action: z.enum(["continue", "abort"]),
        })
        .safeParse(value);
      if (
        !identity.success ||
        documentScopeId(identity.data.scope) !==
          documentScopeId(submitted.scope) ||
        identity.data.action !== submitted.action ||
        identity.data.operation !== submitted.operation
      )
        throw Error(
          msg("git.theResultBelongsToAnotherContextOrActionItsData"),
        );
      const verified = verifiedResult(value, submitted);
      setResult(diagnostics(value, verified));
      if (verified) latest.current.onSucceeded(submitted.scope);
    } catch (error) {
      if (
        alive.current &&
        documentScopeId(latest.current.scope) ===
          documentScopeId(submitted.scope)
      ) {
        setRereadAfter(latest.current.getIssuedReadVersion());
        setResult(
          msg("git.resultUnconfirmedCheckTheGitStateTheOperationMayHave", { value1: String(topicError(error)) }),
        );
      }
    } finally {
      flight.current = null;
      if (alive.current) setPending(null);
    }
  }
  return {
    supported,
    displayOperation,
    operation:
      options.snapshot?.operation === "revert" ? "revert" : "cherry-pick",
    pending,
    preview,
    action,
    result,
    expired,
    needsRefresh,
    locked: !!pending || !!action,
    modalOpen: !!action || !!result,
    canStart: available() && !pending && !action && !result && !needsRefresh,
    canExecute: !pending && validConfirmation(),
    prepare,
    execute,
    close,
    closeResult: () => setResult(""),
  };
}
type SequencerState = ReturnType<typeof useGitSequencerOperation>;
export function GitSequencerOperationFooter({
  sequencer,
  unresolved,
}: {
  sequencer: SequencerState;
  unresolved: boolean;
}) {
  useLocale();
  if (!sequencer.supported)
    return (
      <p>{msg("git.continuingAndAbortingThisOperationAreUnavailableWithThisConnection")}</p>
    );
  return (
    <div className="git-merge-operation-footer">
      <p role={sequencer.pending === "execute" ? "status" : undefined}>
        {sequencer.pending === "execute"
          ? msg("git.gitOperationInProgressYouCanCloseTheViewWriting")
          : sequencer.needsRefresh
            ? msg("git.refreshChangesAndCheckTheGitStateFirstANew")
            : unresolved
              ? msg("git.resolveAndSaveEachFileFirstConflictsOrUnsavedDrafts")
              : msg("git.savingAFileAndContinuingAnOperationAreSeparateActions")}
      </p>
      <div>
        <button
          type="button"
          className="danger"
          disabled={!sequencer.canStart}
          onClick={() => void sequencer.prepare("abort")}
        >{msg("git.abort")}{sequencer.operation}…
        </button>
        <button
          type="button"
          className="primary"
          disabled={!sequencer.canStart || unresolved}
          onClick={() => void sequencer.prepare("continue")}
        >{msg("git.continue2")}{sequencer.operation}…
        </button>
      </div>
    </div>
  );
}
export function GitSequencerOperationDialogs({
  sequencer: s,
}: {
  sequencer: SequencerState;
}) {
  useLocale();
  const escape = (e: React.KeyboardEvent, close: () => void) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const p = s.preview,
    operation = s.displayOperation,
    label =
      s.action === "continue"
        ? msg("git.continue3", { operation: String(operation) })
        : msg("git.abort2", { operation: String(operation) });
  return (
    <>
      {s.action && (
        <div onKeyDown={(e) => escape(e, s.close)}>
          <TopicModal
            title={label + (s.action === "abort" ? "?" : "")}
            closeLabel={msg("git.closeConfirmation", { operation: String(operation) })}
            className="git-merge-operation-modal"
            onClose={s.close}
          >
            <div className="git-merge-operation-form">
              {s.pending === "prepare" ? (
                <LoadingState label={msg("git.checkingGitOperation2")} />
              ) : (
                <>
                  <div className="git-merge-operation-details">
                    {s.action === "abort" && (
                      <p className="git-conflict-warning">{msg("git.theSpecifiedOriginalCommitAndTreeWillBeRestoredSaved")}</p>
                    )}
                    {p && (
                      <>
                        <dl>
                          <dt>{msg("git.context")}</dt>
                          <dd>
                            {typeof p.scope === "string"
                              ? msg("git.originalFolder", { scope: String(p.scope) })
                              : `${p.scope.projectId} / ${p.scope.year} / ${p.scope.topic} · ${p.scope.contextId}`}
                          </dd>
                          <dt>{msg("git.workingDirectory")}</dt>
                          <dd>{p.root}</dd>
                          <dt>{msg("git.branch2")}</dt>
                          <dd>{p.branch}</dd>
                          <dt>HEAD</dt>
                          <dd>{p.head}</dd>
                          <dt>{msg("git.originalCommitToRestore")}</dt>
                          <dd>{p.original}</dd>
                          <dt>{msg("git.currentOperationCommit")}</dt>
                          <dd>{p.current}</dd>
                        </dl>
                        {p.requiresCommitWarning && (
                          <p className="git-conflict-warning">{msg("git.aCommitWillBeCreatedTheOriginalNoCommitSetting")}</p>
                        )}
                        <p>{p.effects}</p>
                        {p.action === "abort" &&
                          !!p.discardedResolutionPaths?.length && (
                            <section
                              aria-label={msg("git.resolutionsToDiscard")}
                              className="git-conflict-warning"
                            >
                              <strong>{msg("git.resolutionsInTheseFilesWillBeDiscarded")}</strong>
                              <ul>
                                {p.discardedResolutionPaths.map((n) => (
                                  <li key={n}>
                                    <code>{n}</code>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          )}
                        <strong>{msg("git.affectedPaths")}{p.paths.length}</strong>
                        <ul>
                          {p.paths.map((n) => (
                            <li key={n}>
                              <code>{n}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <p>{msg("git.verifiedLinearSequencesAndExistingTextFilesAreSupportedWithin")}</p>
                    <p>{msg("git.originalReflogsAreNotAppendedToRecoveryFilesAreKept2")}</p>
                  </div>
                  <div className="git-merge-operation-confirm">
                    <p className="hint">{msg("git.gitHooksAreDisabledNothingIsPushedToTheServer")}</p>
                    {!p && (
                      <p>
                        {s.expired
                          ? msg("git.confirmationExpiredCheckTheOperationAgain")
                          : msg("git.confirmationUnavailableCloseThisDialogAndRefreshChanges")}
                      </p>
                    )}
                    <div className="git-branch-dialog-actions">
                      <button type="button" onClick={s.close}>{msg("git.cancel")}</button>
                      {s.expired && (
                        <button
                          type="button"
                          onClick={() => void s.prepare(s.action!)}
                        >{msg("git.checkAgain")}</button>
                      )}
                      <button
                        type="button"
                        className={
                          s.action === "continue" ? "primary" : "danger"
                        }
                        disabled={!s.canExecute}
                        onClick={() => void s.execute()}
                      >
                        {label}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </TopicModal>
        </div>
      )}
      {!!s.result && (
        <div onKeyDown={(e) => escape(e, s.closeResult)}>
          <TopicModal
            title={msg("git.result2", { operation: String(operation) })}
            closeLabel={msg("git.closeResult", { operation: String(operation) })}
            className="git-workspace-error"
            onClose={s.closeResult}
          >
            <pre>{s.result}</pre>
          </TopicModal>
        </div>
      )}
    </>
  );
}
