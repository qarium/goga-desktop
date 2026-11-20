import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { nativeResultSchema } from "./git-native-sequence-result";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import { gitFilePathSchema, gitRevisionSchema } from "../shared/git-workspace";
import {
  gitUpdateHandoffRequestSchema,
  gitUpdateHandoffTokenSchema,
  gitUpdateStrategySchema,
  type GitUpdateHandoffCandidate,
  type GitUpdateHandoffPreview,
} from "../shared/git-update-handoff";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { TopicModal, topicError } from "./TopicsCommon";
const text = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\0"));
const rootSchema = text.refine((v) => v.startsWith("/"));
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const algorithmSchema = z.enum(["merge", "rebase"]);
const candidateSchema = z.object({
  candidateId: gitUpdateHandoffTokenSchema,
  scope: scopeRefSchema,
  root: rootSchema,
  targetBranch: text,
  targetHead: oid,
  sourceRef: text,
  sourceOid: oid,
  baseRef: text,
  strategy: gitUpdateStrategySchema,
  algorithm: algorithmSchema,
  backend: z.enum(["merge", "apply"]).optional(),
  conflicts: z.array(gitFilePathSchema),
  expiresAt: z.number().finite(),
});
const previewSchema = z.object({
  token: gitUpdateHandoffTokenSchema,
  candidate: candidateSchema,
  hooks: z.literal("disabled"),
  publishes: z.literal(false),
  effects: text,
  expiresAt: z.number().finite(),
});
const identitySchema = z.object({
  scope: scopeRefSchema,
  root: rootSchema,
  algorithm: algorithmSchema,
});
const resultSchema = identitySchema.extend({
  status: z.enum(["success", "conflict", "error", "uncertain"]),
  native: nativeResultSchema.optional(),
  lockRetained: z.boolean().optional(),
  retainedLocks: z.array(z.string()).optional(),
  uncheckedLocks: z.array(z.string()).optional(),
  changed: z.boolean(),
  conflicts: z.array(gitFilePathSchema),
  message: z.string(),
  log: z.string(),
});
function candidateKey(c: GitUpdateHandoffCandidate) {
  return JSON.stringify([
    documentScopeId(c.scope),
    c.candidateId,
    c.root,
    c.targetBranch,
    c.targetHead,
    c.sourceRef,
    c.sourceOid,
    c.baseRef,
    c.strategy,
    c.algorithm,
    c.backend,
    c.conflicts,
    c.expiresAt,
  ]);
}
interface Props {
  autoPrepare?: boolean;
  candidate: GitUpdateHandoffCandidate;
  onClose(): void;
  onChanged(scope: ScopeRef): void;
}
/** Each exact candidate owns its reads, confirmation and non-cancellable write. */
export function GitUpdateHandoff(props: Props) {
  useLocale();
  return <HandoffConfirmation key={candidateKey(props.candidate)} {...props} />;
}
function HandoffConfirmation({
  candidate,
  onClose,
  onChanged,
  autoPrepare = false,
}: Props) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [preview, setPreview] = useState<GitUpdateHandoffPreview | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState("");
  const alive = useRef(true),
    dismissed = useRef(false),
    flight = useRef(false);
  const read = useRef<AbortController | null>(null);
  const callbacks = useRef({ onClose, onChanged });
  callbacks.current = { onClose, onChanged };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timeout = setTimeout(
      () => {
        setPreview(null);
        setError(
          msg("git.confirmationExpiredCloseThisDialogAndCheckTheStateAgain"),
        );
      },
      Math.max(
        0,
        Math.min(preview.expiresAt, candidate.expiresAt) - Date.now(),
      ),
    );
    return () => clearTimeout(timeout);
  }, [preview, candidate.expiresAt]);
  const current = () => alive.current && !dismissed.current;
  function close() {
    dismissed.current = true;
    read.current?.abort();
    setClosed(true);
    callbacks.current.onClose();
  }
  async function prepare() {
    if (flight.current || !current()) return;
    flight.current = true;
    setOpen(true);
    setPending("prepare");
    const controller = new AbortController();
    read.current = controller;
    try {
      if (
        !candidateSchema.safeParse(candidate).success ||
        candidate.expiresAt <= Date.now()
      )
        throw Error(msg("git.theProposalIsOutOfDateOrContainsUnverifiedFields"));
      const raw = await readWithSignal(
        controller.signal,
        "readGitWorkspace",
        candidate.scope,
      );
      if (!current() || controller.signal.aborted) return;
      const snapshot = z
        .object({
          scope: scopeRefSchema,
          root: rootSchema,
          revision: gitRevisionSchema,
          head: oid,
          branch: text,
          operation: z.literal("none"),
        })
        .safeParse(raw);
      if (
        !snapshot.success ||
        documentScopeId(snapshot.data.scope) !==
          documentScopeId(candidate.scope) ||
        snapshot.data.root !== candidate.root ||
        snapshot.data.head !== candidate.targetHead ||
        snapshot.data.branch !== candidate.targetBranch
      )
        throw Error(
          msg("git.theGitStateIsOutOfDateOrBelongsTo"),
        );
      const request = gitUpdateHandoffRequestSchema.parse({
        scope: candidate.scope,
        revision: snapshot.data.revision,
        candidateId: candidate.candidateId,
      });
      const response = await readWithSignal(
        controller.signal,
        "prepareGitUpdateHandoff",
        request,
      );
      if (!current() || controller.signal.aborted) return;
      const checked = previewSchema.safeParse(response);
      if (
        !checked.success ||
        candidateKey(checked.data.candidate) !== candidateKey(candidate) ||
        checked.data.expiresAt <= Date.now() ||
        candidate.expiresAt <= Date.now()
      )
        throw Error(
          msg("git.confirmationIsOutOfDateOrBelongsToADifferent"),
        );
      setPreview(checked.data);
    } catch (e) {
      if (current() && !controller.signal.aborted) setError(topicError(e));
    } finally {
      if (read.current === controller) read.current = null;
      flight.current = false;
      if (current()) setPending(null);
    }
  }
  async function execute() {
    if (
      !preview ||
      flight.current ||
      !current() ||
      preview.expiresAt <= Date.now() ||
      candidate.expiresAt <= Date.now()
    )
      return;
    const submitted = preview;
    // Consume the single authorization before awaiting. Never cancel or retry writes.
    flight.current = true;
    setPreview(null);
    setPending("execute");
    try {
      const value = await window.goga.executeGitUpdateHandoff(submitted.token);
      if (!current()) return;
      const identity = identitySchema.safeParse(value);
      if (
        !identity.success ||
        documentScopeId(identity.data.scope) !==
          documentScopeId(candidate.scope) ||
        identity.data.root !== candidate.root ||
        identity.data.algorithm !== candidate.algorithm
      )
        throw Error(
          msg("git.theResultBelongsToAnotherContextWorkingDirectoryOrAlgorithm"),
        );
      const checked = resultSchema.safeParse(value);
      const n = checked.success ? checked.data.native : undefined;
      const verified =
        checked.success &&
        checked.data.changed &&
        (n
          ? n.processSettled &&
            n.verifiedUnrelatedData &&
            n.signal === null &&
            n.beforeHead === candidate.targetHead &&
            !!n.afterHead &&
            checked.data.lockRetained === false &&
            checked.data.retainedLocks?.length === 0 &&
            checked.data.uncheckedLocks?.length === 0 &&
            JSON.stringify(n.conflicts) ===
              JSON.stringify(checked.data.conflicts) &&
            (checked.data.status === "success"
              ? n.outcome === "completed" &&
                n.exitCode === 0 &&
                !n.conflicts.length &&
                n.recovery === "removed" &&
                !n.recoveryPath
              : checked.data.status === "conflict" &&
                n.outcome === "conflicts" &&
                n.exitCode === 1 &&
                n.conflicts.length > 0 &&
                n.recovery === "retained" &&
                !!n.recoveryPath)
          : checked.data.status === "conflict" &&
            checked.data.conflicts.length > 0);
      const diagnostics = value as unknown as Record<string, unknown>;
      setReport(
        [
          verified
            ? n?.outcome === "completed"
              ? msg("git.theLocalGitOperationFinishedPublicationAndCompletionOfThe")
              : msg("git.conflictConfirmedResolveFilesInTheConflictEditorTheOperation")
            : msg("git.resultUnconfirmedCheckTheGitStateChangesMayHaveBeen"),
          typeof diagnostics.message === "string"
            ? diagnostics.message
            : msg("git.noMessageReceived"),
          n?.recoveryPath ? msg("git.recoveryFiles", { recoveryPath: String(n.recoveryPath) }) : "",
          typeof diagnostics.log === "string"
            ? diagnostics.log
            : msg("git.noLogReceived"),
        ].join("\n\n"),
      );
      if (verified) callbacks.current.onChanged(candidate.scope);
    } catch (e) {
      if (current())
        setError(
          msg("git.resultUnconfirmedCheckTheGitStateTheOperationMayHave2", { value1: String(topicError(e)) }),
        );
    } finally {
      flight.current = false;
      if (current()) setPending(null);
    }
  }
  useEffect(() => {
    let active = true;
    if (autoPrepare)
      void Promise.resolve().then(() => {
        if (active) void prepare();
      });
    return () => {
      active = false;
    };
  }, [autoPrepare]);
  if (closed) return null;
  const p = preview?.candidate;
  return (
    <>
      {!autoPrepare && (
        <button type="button" disabled={open} onClick={() => void prepare()}>
          {candidate.conflicts.length
            ? msg("git.resolveConflictManually")
            : msg("git.updateUsingGit")}
        </button>
      )}
      {open && (
        <div
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <TopicModal
            title={msg("git.switchToManualConflictResolution")}
            closeLabel={msg("git.closeTransitionConfirmation")}
            className="git-merge-operation-modal"
            onClose={close}
          >
            <div className="git-merge-operation-form">
              {pending === "prepare" && (
                <p role="status">{msg("git.checkingGitState")}</p>
              )}
              {pending === "execute" && (
                <p role="status">{msg("git.creatingConflictYouCanCloseThisViewWritingContinues")}</p>
              )}
              {error && <pre role="alert">{error}</pre>}
              {report && <pre role="status">{report}</pre>}
              {p && (
                <>
                  <div className="git-merge-operation-details">
                    <dl>
                      <dt>{msg("git.context")}</dt>
                      <dd>
                        {typeof p.scope === "string"
                          ? p.scope
                          : `${p.scope.projectId} / ${p.scope.year} / ${p.scope.topic} · ${p.scope.contextId}`}
                      </dd>
                      <dt>{msg("git.workingDirectory")}</dt>
                      <dd>{p.root}</dd>
                      <dt>{msg("git.targetBranch")}</dt>
                      <dd>{p.targetBranch}</dd>
                      <dt>{msg("git.currentHEAD")}</dt>
                      <dd>{p.targetHead}</dd>
                      <dt>{msg("git.source")}</dt>
                      <dd>{p.sourceRef}</dd>
                      <dt>{msg("git.sourceCommit")}</dt>
                      <dd>{p.sourceOid}</dd>
                      <dt>{msg("git.baseBranch")}</dt>
                      <dd>{p.baseRef}</dd>
                      <dt>{msg("git.updateStrategy")}</dt>
                      <dd>{p.strategy}</dd>
                      <dt>{msg("git.algorithm")}</dt>
                      <dd>{p.algorithm}</dd>
                    </dl>
                    <p className="git-conflict-warning">{preview.effects}</p>
                    <p>{msg("git.updateEffect", { algorithm: p.algorithm })}</p>
                    <ul>
                      {p.conflicts.map((path) => (
                        <li key={path}>
                          <code>{path}</code>
                        </li>
                      ))}
                    </ul>
                    <p className="hint">{msg("git.gitHooksAreDisabledNothingIsPushedToTheServer")}</p>
                  </div>
                  <div className="git-merge-operation-confirm">
                    <div className="git-branch-dialog-actions">
                      <button type="button" onClick={close}>{msg("git.cancel")}</button>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void execute()}
                      >
                        {candidate.conflicts.length
                          ? msg("git.confirmTransitionToConflict")
                          : msg("git.startLocalUpdate")}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </TopicModal>
        </div>
      )}
    </>
  );
}
