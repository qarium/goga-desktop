import { PopupClose } from "./PopupClose";
import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import type { GitUpdateHandoffCandidate } from "../shared/git-update-handoff";
import { documentScopeId } from "./settings-documents";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { TooltipButton } from "./ActionHint";
export { TooltipButton } from "./ActionHint";
import type { Project } from "../shared/types";
import type { WorktreeRecord } from "../shared/worktrees";
import type { RepositoryActionRequest } from "../shared/repository-actions";
import { contextRef } from "./topic-context";
import { topicSyncUnavailable } from "./topic-sync-controller";
import {
  repositoryActionKey,
  useRepositoryActionController,
} from "./repository-action-controller";
import {
  TopicPickerPopup,
  dismissActiveTopicPopup,
  useNativeTopicPopup,
} from "./TopicPickerPopup";
import "./RepositoryActions.css";
import { ContextOperationProgress } from "./ContextOperationProgress";

export function RepositoryIcon({
  action,
}: {
  action: RepositoryActionRequest["action"];
}) {
  useLocale();
  if (action === "update-remote") return <span aria-hidden="true">↻</span>;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={action === "sync" || action === "propagate" ? "2" : "1.8"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {action === "sync" ? (
        <>
          {/* Lucide refresh-cw: https://github.com/lucide-icons/lucide/blob/main/icons/refresh-cw.svg */}
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </>
      ) : action === "publish" ? (
        <>
          <path d="M7 18H6a4 4 0 0 1-.7-7.94 7 7 0 0 1 13.4 0A4 4 0 0 1 18 18h-1M12 21V11M8 15l4-4 4 4" />
        </>
      ) : action === "propagate" ? (
        <>
          {/* Lucide git-merge: https://github.com/lucide-icons/lucide/blob/main/icons/git-merge.svg */}
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </>
      ) : (
        <path d="M12 3v12M8 11l4 4 4-4M4 16v5h16v-5" />
      )}
    </svg>
  );
}

export function RepositoryActions({
  project,
  selected,
  disabled = false,
  onlySync = false,
  onStarted,
}: {
  project: Project;
  selected: WorktreeRecord | null;
  disabled?: boolean;
  onlySync?: boolean;
  onStarted?: () => void;
}) {
  useLocale();
  const controller = useRepositoryActionController();
  const context = selected ? contextRef(selected) : undefined;
  const request = { projectId: project.id, ...(context ? { context } : {}) };
  const active = controller.busy.get(repositoryActionKey(request));
  const busy = !!active;
  const unavailable = selected
    ? selected.projectId !== project.id
      ? tr("topics.contextBelongsToAnotherProject")
      : topicSyncUnavailable(selected)
    : "";
  const available = typeof window.goga.runRepositoryAction === "function";
  const actions: RepositoryActionRequest["action"][] = onlySync
    ? ["sync"]
    : selected
      ? ["sync", "publish", "update-base", "propagate", "update-remote"]
      : ["sync", "publish"];
  const labels = {
    sync:
      onlySync && selected
        ? tr("topics.syncCommitsTopicYearBranch", { topic: selected.topic, year: selected.year, branch: selected.branch })
        : selected
          ? tr("topics.syncTopic")
          : tr("topics.syncCurrentBranch"),
    publish: selected ? tr("topics.publishTopic") : tr("topics.publishCurrentBranch"),
    "update-remote": tr("topics.updateTopicFromRemote"),
    "update-base": tr("topics.updateFromBase"),
    propagate: tr("topics.propagateToBaseAndPublish"),
  };
  const tooltipLabels = {
    sync: tr("topics.sync"),
    publish: tr("topics.publish"),
    "update-remote": tr("topics.updateFromRemoteTooltip"),
    "update-base": tr("topics.updateFromBase"),
    propagate: tr("topics.propagateTooltip"),
  };
  const descriptions = {
    "update-remote":
      tr("topics.commitsOriginIfPublishedOriginalProjectCopyFast"),
    sync: selected
      ? tr("topics.commitsOnTheMatchingBranchOriginalProjectCopy")
      : tr("topics.updateTheCurrentBranchFromUpstreamFastForward"),
    publish: selected
      ? tr("topics.commitsCopyOriginalProjectOrigin")
      : tr("topics.publishTheCurrentBranchToOrigin"),
    propagate:
      tr("topics.syncTheCopyPropagateTheTopicToBase"),
    "update-base":
      tr("topics.updateBaseFromRemoteIfPublishedFetchThe"),
  };
  const progressLabels: Record<RepositoryActionRequest["action"], string> = {
    sync: tr("topics.syncing"),
    publish: tr("topics.publishing"),
    "update-base": tr("topics.updatingFromBase"),
    propagate: tr("topics.propagatingToBase"),
    "update-remote": tr("topics.updatingFromRemote"),
  };
  return (
    <>
      <div
        className={
          onlySync
            ? "repository-actions repository-actions-row"
            : "repository-actions"
        }
        role="group"
        aria-label={tr("topics.branchActions")}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (
            ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(
              e.key,
            )
          )
            e.stopPropagation();
        }}
      >
        {actions.map((action) => (
          <TooltipButton
            key={action}
            disabled={disabled || busy || !available || !!unavailable}
            label={labels[action]}
            tooltipLabel={tooltipLabels[action]}
            busy={busy}
            description={
              unavailable ||
              (!available
                ? tr("topics.thisActionIsUnavailableInThisHostVersion")
                : busy
                  ? tr("topics.operationInProgress")
                  : disabled
                    ? tr("topics.actionTemporarilyUnavailable")
                    : descriptions[action])
            }
            onClick={() => {
              void controller.run(
                { ...request, action },
                `${project.name} · ${selected ? `${selected.topic} · ${selected.year} · ${selected.branch}` : tr("topics.noTopicOriginalProject")}`,
              );
              onStarted?.();
            }}
          >
            <RepositoryIcon action={action} />
          </TooltipButton>
        ))}
      </div>
      {!onlySync && active && (
        <ContextOperationProgress
          label={`${progressLabels[active.action]} · ${active.label}`}
          message={progressLabels[active.action]}
        />
      )}
    </>
  );
}

/** Same-origin native overlay stays above Electron's pipeline WebContentsView. */
export function RepositoryOperationPopup({
  anchor,
  onHandoff,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  onHandoff?: (candidate: GitUpdateHandoffCandidate) => void;
}) {
  useLocale();
  const nativePopup = useNativeTopicPopup();
  const controller = useRepositoryActionController();
  const failure = controller.failures[0];
  const [ready, setReady] = useState<{
    failure: typeof failure;
    modal: boolean;
  }>();
  useEffect(() => {
    let alive = true;
    if (failure)
      void dismissActiveTopicPopup()
        .then(() => {
          if (alive)
            setReady({
              failure,
              modal: !!document.querySelector(".topic-dialog[open]"),
            });
        })
        .catch(() => {
          if (alive)
            setReady({
              failure,
              modal: !!document.querySelector(".topic-dialog[open]"),
            });
        });
    return () => {
      alive = false;
    };
  }, [failure]);
  if (!failure || ready?.failure !== failure) return null;
  const candidate = failure.result.handoff;
  const handoff =
    candidate &&
    onHandoff &&
    failure.result.status === "error" &&
    documentScopeId(candidate.scope) === documentScopeId(failure.scope)
      ? () => {
          onHandoff(candidate);
          if (ready.modal || !nativePopup) controller.close();
        }
      : undefined;
  if (ready.modal)
    return (
      <RepositoryFailureDialog
        label={failure.label}
        log={failure.result.log}
        error={failure.result.error || tr("topics.operationWasNotCompleted")}
        onClose={controller.close}
        onHandoff={handoff}
      />
    );
  return (
    <TopicPickerPopup
      anchor={anchor}
      onClose={controller.close}
      label={tr("topics.operationFailed")}
    >
      <OperationFailure
        label={failure.label}
        log={failure.result.log}
        error={failure.result.error || tr("topics.operationWasNotCompleted")}
        onClose={controller.close}
        onHandoff={handoff}
      />
    </TopicPickerPopup>
  );
}
/** Native dialog joins the top layer above an open topic card. A body portal
 * alone would be inert behind that modal in the browser fallback. */
function RepositoryFailureDialog(props: {
  label: string;
  log: string;
  error: string;
  onClose: () => void;
  onHandoff?: () => void;
}) {
  useLocale();
  const node = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = node.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return createPortal(
    <dialog
      ref={node}
      className="repository-operation-dialog"
      aria-label={tr("topics.operationFailed")}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <OperationFailure {...props} nested />
    </dialog>,
    document.body,
  );
}
function OperationFailure({
  label,
  log,
  error,
  onClose,
  nested = false,
  onHandoff,
}: {
  label: string;
  log: string;
  error: string;
  onClose: () => void;
  nested?: boolean;
  onHandoff?: () => void;
}) {
  useLocale();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    button.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <section
      className="repository-operation-popup"
      role={nested ? undefined : "dialog"}
      aria-label={nested ? undefined : tr("topics.operationFailed")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <h2>{tr("topics.operationFailed")}</h2>
          <p>{label}</p>
        </div>
        <PopupClose label={tr("topics.closePopup")} onClick={onClose} buttonRef={button} />
      </header>
      <pre aria-label={tr("topics.operationLog")}>{log}</pre>
      {onHandoff && (
        <button type="button" onClick={onHandoff}>{tr("topics.resolveConflictManually")}</button>
      )}
      <p className="repository-operation-error" role="alert">
        {error}
      </p>
    </section>
  );
}
