import { HintButton } from "./ActionHint";
import type { MessageKey } from "../shared/locale-packs.generated";
import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import {
  formatGitDiagnostics,
  hasGitDiagnostics,
} from "./git-operation-diagnostics";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { GitMergeConfirmation, GitMergeSource } from "./GitMergeDialogs";
import type {
  GitBranchInventory,
  GitBranchPreview,
  GitBranchRequest,
} from "../shared/git-branches";
import { TopicPickerPopup, dismissActiveTopicPopup } from "./TopicPickerPopup";
import { TopicModal, topicError } from "./TopicsCommon";
import { LoadingState } from "./LoadingBoundary";
import { readWithSignal } from "./read-request";
import { useViewActive } from "./RetainedViews";
import "./GitBranchPicker.css";
import { useGitBranchMenu } from "./useGitBranchMenu";
import { remoteBranchTarget } from "./git-branch-targets";
const labels = {
  create: "git.createBranch",
  "switch-local": "git.switchBranch",
  "switch-remote": "git.createTrackingBranch",
  fetch: "git.fetchBranchesFromRemote",
  pull: "git.pullCurrentBranch",
  merge: "git.confirmMerge",
  "abort-merge": "git.abortMerge",
} as const satisfies Record<GitBranchRequest["action"], MessageKey>;
const short = (ref: string | null) =>
  ref?.replace(/^refs\/(heads|remotes)\//, "") ?? "—";
interface Props {
  projectId: string;
  branch: string;
  revision: number;
  disabled?: boolean;
  mutationBlockedReason?: string;
  onChanged(projectId: string, change?: "references-only"): void;
  onOverlayChange?(projectId: string, visible: boolean): void;
  onBusyChange?(busy: boolean): void;
  onShowChanges?(): void;
  operation?: GitBranchInventory["operation"];
  abortContainer?: HTMLElement | null;
}
/** Instance belongs to one retained primary project, never the current selector. */
export function GitBranchPicker(props: Props) {
  useLocale();
  return <BranchOwner key={props.projectId} {...props} />;
}
function BranchOwner({
  projectId,
  branch,
  revision,
  disabled = false,
  mutationBlockedReason,
  onChanged,
  onOverlayChange,
  onBusyChange,
  onShowChanges,
  operation,
  abortContainer,
}: Props) {
  useLocale();
  const active = useViewActive();
  const [open, setOpen] = useState(false),
    [group, setGroup] = useState<"local" | "remote">("local"),
    [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false),
    [merging, setMerging] = useState(false),
    [name, setName] = useState(""),
    [switchTo, setSwitchTo] = useState(true);
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null),
    [preview, setPreview] = useState<GitBranchPreview | null>(null);
  const [result, setResult] = useState(""),
    [resultConflict, setResultConflict] = useState(false),
    [attempt, setAttempt] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const alive = useRef(true),
    flight = useRef(false),
    preparing = useRef<AbortController | null>(null);
  const done = useRef(onChanged);
  done.current = onChanged;
  const available = useRef(active && !disabled && !mutationBlockedReason);
  available.current = active && !disabled && !mutationBlockedReason;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      preparing.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active || disabled) {
      setOpen(false);
      setCreating(false);
      setMerging(false);
      setPreview(null);
      preparing.current?.abort();
    }
  }, [active, disabled]);
  useEffect(() => {
    if (mutationBlockedReason) {
      setCreating(false);
      setMerging(false);
      setPreview(null);
      preparing.current?.abort();
    }
  }, [mutationBlockedReason]);
  const menuState = useGitBranchMenu({
    projectId,
    active,
    open,
    disabled,
    blocked: mutationBlockedReason,
    revision,
    attempt,
    flight,
    onChanged,
  });
  const { inventory, setInventory, loading, fetching, newRefs } = menuState;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const presentation = useRef({ onOverlayChange, onBusyChange });
  presentation.current = { onOverlayChange, onBusyChange };
  const modalVisible =
    active &&
    (creating || merging || pending === "prepare" || !!preview || !!result);
  useLayoutEffect(() => {
    presentation.current.onOverlayChange?.(projectId, modalVisible);
    return () => presentation.current.onOverlayChange?.(projectId, false);
  }, [projectId, modalVisible]);
  useEffect(() => {
    presentation.current.onBusyChange?.(!!pending || fetching);
    return () => presentation.current.onBusyChange?.(false);
  }, [pending, fetching]);
  const ready =
    !!inventory &&
    !loading &&
    !fetching &&
    !menuState.stale &&
    !menuState.reviewRequired &&
    !pending &&
    !disabled &&
    !mutationBlockedReason;
  const mutable = ready && inventory.operation === "none";
  function closeResult() {
    setResult("");
    setResultConflict(false);
  }
  async function hideMenu() {
    setOpen(false);
    await dismissActiveTopicPopup();
  }
  async function prepare(input: GitBranchRequest | "abort-merge") {
    if (flight.current || !available.current) return;
    flight.current = true;
    setPending("prepare");
    setCreating(false);
    setMerging(false);
    setResult("");
    setResultConflict(false);
    const controller = new AbortController();
    preparing.current = controller;
    try {
      await hideMenu();
      if (controller.signal.aborted) return;
      // The workspace abort action can be opened with the branch menu closed.
      // Read a fresh owner-bound revision instead of reusing an old menu snapshot.
      let request: GitBranchRequest;
      if (input === "abort-merge") {
        const current = await readWithSignal(
          controller.signal,
          "readGitBranches",
          projectId,
        );
        if (controller.signal.aborted || !alive.current) return;
        if (current.projectId !== projectId)
          throw Error(msg("git.theBranchListBelongsToAnotherProject"));
        request = {
          projectId,
          revision: current.revision,
          action: "abort-merge",
        };
      } else request = input;
      const value = await readWithSignal(
        controller.signal,
        "prepareGitBranch",
        request,
      );
      if (!alive.current || controller.signal.aborted) return;
      if (value.projectId !== projectId || value.action !== request.action)
        throw Error(msg("git.theConfirmationBelongsToAnotherOperation"));
      setPreview(value);
    } catch (error) {
      if (alive.current && !controller.signal.aborted)
        setResult(topicError(error));
    } finally {
      flight.current = false;
      if (preparing.current === controller) preparing.current = null;
      if (alive.current) setPending(null);
    }
  }
  async function execute() {
    if (flight.current || !preview || !available.current) return;
    const submitted = preview;
    flight.current = true;
    setPreview(null);
    setPending("execute");
    try {
      const value = await window.goga.executeGitBranch(submitted.token);
      if (!alive.current) return;
      if (value.projectId !== projectId || value.action !== submitted.action)
        throw Error(
          msg("git.theResultBelongsToAnotherOperationCheckTheGitState"),
        );
      if (hasGitDiagnostics(value)) {
        setResultConflict(value.status === "conflict");
        setResult(formatGitDiagnostics(value));
      }
    } catch (error) {
      if (alive.current)
        setResult(
          msg("git.checkTheGitStateTheResponseDoesNotConfirmThat", { value1: String(topicError(error)) }),
        );
    } finally {
      flight.current = false;
      // Also refresh after refusal: fetch or a native operation may be partially applied.
      done.current(projectId);
      if (alive.current) {
        setPending(null);
        setInventory(null);
        setAttempt((n) => n + 1);
      }
    }
  }
  const basicRequest = inventory
    ? { projectId, revision: inventory.revision }
    : null;
  const rows = (inventory?.[group] ?? []).filter((row) =>
    row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="git-branch-picker">
      <button
        ref={anchor}
        type="button"
        className="git-workspace-trigger git-branch-trigger"
        aria-label={msg("git.branch", { branch: String(branch) })}
        title={branch}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled || !!pending}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={{ flexShrink: 0 }}
        >
          <path d="M6 3v12" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span>{branch}</span>
      </button>
      {pending === "execute" && (
        <span className="git-branch-running" role="status">{msg("git.gitOperation")}</span>
      )}
      {active &&
        operation === "merge" &&
        abortContainer &&
        createPortal(
          <button
            type="button"
            className="danger"
            disabled={disabled || !!pending || !!mutationBlockedReason}
            onClick={() => void prepare("abort-merge")}
          >{msg("git.abortMerge2")}</button>,
          abortContainer,
        )}
      {active && open && (
        <TopicPickerPopup
          anchor={anchor}
          onClose={() => setOpen(false)}
          label={msg("git.selectBranch")}
          domPortal
          width={376}
        >
          <div
            ref={menu}
            className="git-branch-menu"
            role="dialog"
            aria-label={msg("git.selectBranch")}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                anchor.current?.focus();
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    ".git-branch-list button:not(:disabled)",
                  ),
                ];
                if (!buttons.length) return;
                const index = buttons.indexOf(
                  event.target as HTMLButtonElement,
                );
                const next =
                  event.key === "ArrowDown"
                    ? (index + 1) % buttons.length
                    : index <= 0
                      ? buttons.length - 1
                      : index - 1;
                event.preventDefault();
                buttons[next]?.focus();
              }
            }}
          >
            <div
              className="git-branch-groups"
              role="tablist"
              aria-label={msg("git.branchSource")}
            >
              {(
                [
                  ["local", msg("git.local")],
                  ["remote", msg("git.remote")],
                ] as const
              ).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  role="tab"
                  aria-selected={group === key}
                  onClick={() => {
                    setGroup(key);
                    setQuery("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="git-branch-searchbar">
              <input
                type="search"
                aria-label={msg("git.findABranch")}
                placeholder={msg("git.findABranch")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
              <HintButton
                type="button"
                className="git-branch-refresh"
                aria-label={msg("git.fetchFromOrigin")}
                hint={msg("git.fetchFromOrigin")}
                aria-busy={fetching}
                disabled={
                  fetching ||
                  !!pending ||
                  disabled ||
                  !!mutationBlockedReason ||
                  menuState.reviewRequired ||
                  !inventory ||
                  inventory.operation !== "none"
                }
                onClick={() => void menuState.update()}
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                  focusable="false"
                  className={
                    fetching ? "git-branch-refresh-spinning" : undefined
                  }
                />
              </HintButton>
            </div>
            {fetching && (
              <p className="hint" role="status">{msg("git.fetchingBranchesFromOrigin")}</p>
            )}
            {menuState.error && (
              <div className="git-branch-refresh-error" role="alert">
                <pre>{menuState.error}</pre>
                <button type="button" onClick={() => setOpen(false)}>{msg("git.closeMenu")}</button>
              </div>
            )}
            {menuState.stale && (
              <p className="hint">{msg("git.showingThePreviousListRefreshTheStateBeforeSwitching")}</p>
            )}
            {(menuState.reviewRequired || menuState.stale) && (
              <button
                type="button"
                disabled={fetching}
                onClick={() => void menuState.checkState()}
              >{msg("git.checkState")}</button>
            )}
            {menuState.notice && (
              <p className="hint" role="status">
                {menuState.notice}
              </p>
            )}
            {!!newRefs.length &&
              (group !== "remote" ||
                newRefs.some((ref) => !rows.some((r) => r.ref === ref))) && (
                <p className="hint">{msg("git.newBranchesAreHiddenByTheCurrentTabOrSearch")}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setGroup("remote");
                      setQuery("");
                    }}
                  >{msg("git.showNewBranches")}</button>
                </p>
              )}
            {loading && !inventory ? (
              <LoadingState label={msg("git.loadingBranches")} />
            ) : (
              <div
                className="git-branch-list"
                role="tabpanel"
                aria-label={
                  group === "local" ? msg("git.localBranches") : msg("git.remoteBranches")
                }
              >
                {rows.map((row) => {
                  const target =
                    group === "remote" && inventory
                      ? remoteBranchTarget(inventory, row)
                      : null;
                  const choices =
                    target?.kind === "tracking" ? target.locals : [row];
                  const collision =
                    target?.kind === "collision" ? target.name : null;
                  return (
                    <div key={row.ref} className="git-branch-row">
                      {choices.length > 1 && <p>{row.name}</p>}
                      {choices.map((choice) => {
                        const local =
                          group === "local" || target?.kind === "tracking";
                        const current =
                          local && choice.name === inventory?.branch;
                        return (
                          <button
                            key={choice.ref}
                            type="button"
                            aria-label={
                              choices.length > 1
                                ? msg("git.switchTo", { name: String(choice.name) })
                                : row.name
                            }
                            disabled={
                              !mutable ||
                              inventory?.dirty ||
                              choice.checkedOut ||
                              current ||
                              !!collision
                            }
                            onClick={() =>
                              basicRequest &&
                              void prepare({
                                ...basicRequest,
                                action: local
                                  ? "switch-local"
                                  : "switch-remote",
                                ref: choice.ref,
                              })
                            }
                          >
                            <span>
                              {choices.length > 1 ? choice.name : row.name}{" "}
                              {newRefs.includes(row.ref) && (
                                <small className="git-branch-new">{msg("git.new")}</small>
                              )}
                            </span>
                            <small>
                              {current
                                ? msg("git.current")
                                : choice.checkedOut
                                  ? msg("git.checkedOutInAnotherWorkingCopy")
                                  : collision
                                    ? msg("git.aLocalBranchNamedAlreadyExistsWithADifferentUpstream", { collision: String(collision) })
                                    : local
                                      ? msg("git.switch", { value1: String(target?.kind === "tracking" ? msg("git.to", { name: String(choice.name) }) : "") })
                                      : msg("git.createLocalBranchAndSwitch")}
                            </small>
                          </button>
                        );
                      })}
                      {collision && (
                        <button
                          type="button"
                          onClick={() => {
                            setGroup("local");
                            setQuery(collision);
                          }}
                        >{msg("git.showLocalBranch")}{collision}
                        </button>
                      )}
                    </div>
                  );
                })}
                {!rows.length && <p className="hint">{msg("git.noBranchesFound")}</p>}
              </div>
            )}
            {mutationBlockedReason && (
              <p className="hint" role="status">
                {mutationBlockedReason}
              </p>
            )}
            {inventory?.operation !== "none" && inventory && (
              <p className="hint">{msg("git.finishTheCurrentGitOperationBeforeChangingBranches")}</p>
            )}
            {inventory?.dirty && (
              <p className="hint">{msg("git.commitYourChangesBeforeSwitchingYouCanCreateABranch")}</p>
            )}
            <div className="git-branch-menu-actions">
              {ready && inventory?.operation === "merge" && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void prepare("abort-merge")}
                >{msg("git.abortMerge2")}</button>
              )}
              {group === "local" ? (
                <>
                  <button
                    type="button"
                    disabled={!mutable || !inventory?.head}
                    onClick={async () => {
                      try {
                        await hideMenu();
                        if (!alive.current || !available.current) return;
                        setSwitchTo(!inventory?.dirty);
                        setCreating(true);
                      } catch (e) {
                        setResult(topicError(e));
                      }
                    }}
                  >{msg("git.createBranch2")}</button>
                  <button
                    type="button"
                    disabled={!mutable || !inventory?.branch || !inventory.head}
                    onClick={async () => {
                      try {
                        await hideMenu();
                        if (alive.current && available.current)
                          setMerging(true);
                      } catch (e) {
                        if (alive.current) setResult(topicError(e));
                      }
                    }}
                  >{msg("git.mergeBranchIntoCurrent")}</button>
                  <button
                    type="button"
                    disabled={
                      !mutable || !inventory?.branch || !inventory?.upstream
                    }
                    onClick={() =>
                      basicRequest &&
                      void prepare({ ...basicRequest, action: "pull" })
                    }
                  >{msg("git.pullCurrentBranch")}</button>
                  <small>{msg("git.fastForwardOnlyFromTheConfiguredUpstream")}</small>
                </>
              ) : (
                <>
                  <small>{msg("git.fromOriginWorkingFilesAndTheCurrentBranchWillNot")}</small>
                </>
              )}
            </div>
          </div>
        </TopicPickerPopup>
      )}
      {active && merging && inventory && (
        <GitMergeSource
          inventory={inventory}
          onClose={() => setMerging(false)}
          onSelect={(ref) =>
            basicRequest &&
            void prepare({ ...basicRequest, action: "merge", ref })
          }
        />
      )}
      {active && creating && (
        <TopicModal title={msg("git.createBranch")} onClose={() => setCreating(false)}>
          <form
            className="git-branch-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (basicRequest)
                void prepare({
                  ...basicRequest,
                  action: "create",
                  name,
                  switch: switchTo && !inventory?.dirty,
                });
            }}
          >
            <label>{msg("git.branchName")}<input
                autoFocus
                aria-label={msg("git.branchName")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={1024}
              />
            </label>
            <label className="git-branch-check">
              <input
                type="checkbox"
                checked={switchTo && !inventory?.dirty}
                disabled={inventory?.dirty}
                onChange={(event) => setSwitchTo(event.target.checked)}
              />{msg("git.switchToNewBranch")}</label>
            <p className="hint">{msg("git.createBranchFromHead", { head: inventory?.head?.slice(0, 8) ?? "" })}</p>
            {inventory?.dirty && (
              <p className="hint">{msg("git.thereAreUncommittedChangesTheBranchWillBeCreatedWithout")}</p>
            )}
            <div className="git-branch-dialog-actions">
              <button type="button" onClick={() => setCreating(false)}>{msg("git.cancel")}</button>
              <button type="submit" className="primary" disabled={!name.trim()}>{msg("git.continue")}</button>
            </div>
          </form>
        </TopicModal>
      )}
      {active && pending === "prepare" && (
        <TopicModal
          title={msg("git.checkingGitOperation")}
          onClose={() => {
            preparing.current?.abort();
            setPending(null);
          }}
        >
          <LoadingState label={msg("git.checkingGitOperation2")} />
        </TopicModal>
      )}
      {active &&
        preview &&
        (preview.action === "merge" || preview.action === "abort-merge") && (
          <GitMergeConfirmation
            preview={preview}
            onClose={() => setPreview(null)}
            onConfirm={() => void execute()}
          />
        )}
      {active &&
        preview &&
        preview.action !== "merge" &&
        preview.action !== "abort-merge" && (
          <TopicModal
            title={msg(labels[preview.action])}
            onClose={() => setPreview(null)}
          >
            <div className="git-branch-form">
              <p className="context-path">{preview.root}</p>
              <dl className="git-branch-summary">
                <dt>{msg("git.currentBranch")}</dt>
                <dd>
                  {short(preview.fromRef)} ·{" "}
                  {preview.fromOid?.slice(0, 8) ?? "—"}
                </dd>
                {preview.action === "pull" ? (
                  <>
                    <dt>{msg("git.source")}</dt>
                    <dd>{short(preview.sourceRef)}</dd>
                    <dt>{msg("git.lastKnownCommit")}</dt>
                    <dd>{preview.toOid?.slice(0, 8) ?? msg("git.notFetchedYet")}</dd>
                  </>
                ) : (
                  preview.toRef && (
                    <>
                      <dt>{msg("git.targetBranch")}</dt>
                      <dd>
                        {short(preview.toRef)}{" "}
                        {preview.toOid && `· ${preview.toOid.slice(0, 8)}`}
                      </dd>
                    </>
                  )
                )}
                {preview.remote && (
                  <>
                    <dt>{msg("git.remoteRepository")}</dt>
                    <dd>{preview.remote}</dd>
                  </>
                )}
              </dl>
              <p>
                {preview.action === "fetch"
                  ? msg("git.theOriginBranchListWillBeRefreshedWorkingFilesWill")
                  : preview.action === "pull"
                    ? msg("git.fetchUpstreamAndFastForwardOnlyIfTheBranchesHave")
                    : preview.switchesBranch
                      ? msg("git.switchingChangesFilesInTheOriginalProjectFolderUncommittedChanges")
                      : msg("git.theBranchWillBeCreatedWithoutChangingWorkingFiles")}
              </p>
              <p className="hint">{msg("git.noForceStashOrResetGitHooksAreDisabled")}</p>
              <div className="git-branch-dialog-actions">
                <button type="button" onClick={() => setPreview(null)}>{msg("git.cancel")}</button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void execute()}
                >{msg("git.confirm")}</button>
              </div>
            </div>
          </TopicModal>
        )}
      {active && result && (
        <TopicModal
          title={
            resultConflict
              ? msg("git.mergePausedConflicts")
              : msg("git.gitOperationResult")
          }
          onClose={closeResult}
        >
          <pre className="git-branch-log">{result}</pre>
          <div className="git-branch-dialog-actions">
            {resultConflict && onShowChanges && (
              <button
                type="button"
                onClick={() => {
                  closeResult();
                  onShowChanges();
                }}
              >{msg("git.viewConflicts")}</button>
            )}
            <button type="button" onClick={closeResult}>{msg("git.close")}</button>
          </div>
        </TopicModal>
      )}
    </div>
  );
}
