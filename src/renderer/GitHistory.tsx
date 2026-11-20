import { t as msg, getLocale } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ScopeRef } from "../shared/context";
import type {
  GitHistoryPage,
  GitCommitDetails as Details,
  GitCommitDiff,
  GitHistoryFile,
} from "../shared/git-history";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { useViewActive } from "./RetainedViews";
import { LoadingState } from "./LoadingBoundary";
import { TopicModal, topicError } from "./TopicsCommon";
import { TooltipButton } from "./RepositoryActions";
import { GitCommitDetails } from "./GitCommitDetails";
import { dismissActiveTopicPopup } from "./TopicPickerPopup";
import "./GitWorkspace.css";
import "./GitHistory.css";
interface Props {
  scope: ScopeRef;
  open: boolean;
  revision: number;
  onClose(): void;
  bodyContainer?: HTMLElement | null;
  disabled?: boolean;
  onOverlayChange?(visible: boolean): void;
}
type Job = "list" | "details" | "files" | "diff";
const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
export function GitHistory(props: Props) {
  useLocale();
  return <HistoryOwner key={documentScopeId(props.scope)} {...props} />;
}
function HistoryOwner({
  scope,
  open,
  revision,
  onClose,
  bodyContainer,
  disabled = false,
  onOverlayChange,
}: Props) {
  useLocale();
  const active = useViewActive() && open;
  const ref = "HEAD";
  const [page, setPage] = useState<GitHistoryPage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null),
    [file, setFile] = useState<GitHistoryFile | null>(null),
    [diff, setDiff] = useState<GitCommitDiff | null>(null);
  const [pending, setPending] = useState<Partial<Record<Job, boolean>>>({}),
    [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false),
    [split, setSplit] = useState(42),
    [linePage, setLinePage] = useState(0);
  const jobs = useRef<Partial<Record<Job, AbortController>>>({}),
    started = useRef(false),
    layout = useRef<HTMLDivElement>(null);
  const requestKey = JSON.stringify(scope),
    freshness = useRef({ revision, requestKey });
  const cancel = (...keys: Job[]) => {
    for (const key of keys) {
      jobs.current[key]?.abort();
      delete jobs.current[key];
    }
    setPending((v) => ({
      ...v,
      ...Object.fromEntries(keys.map((key) => [key, false])),
    }));
  };
  useEffect(
    () => () => {
      for (const job of Object.values(jobs.current)) job?.abort();
    },
    [],
  );
  useEffect(() => {
    if (
      freshness.current.revision !== revision ||
      freshness.current.requestKey !== requestKey
    ) {
      freshness.current = { revision, requestKey };
      cancel("list", "details", "files", "diff");
      if (started.current) setStale(true);
    }
  }, [revision, requestKey]);
  const verifyScope = (received: ScopeRef) => {
    if (JSON.stringify(received) !== requestKey)
      throw Error(msg("git.historyBelongsToAnotherContext"));
  };
  const run = <T,>(
    key: Job,
    load: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
  ) => {
    jobs.current[key]?.abort();
    const controller = new AbortController();
    jobs.current[key] = controller;
    setPending((v) => ({ ...v, [key]: true }));
    void load(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) apply(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          void dismissActiveTopicPopup().catch(() => {});
          setError(topicError(e));
        }
      })
      .finally(() => {
        if (jobs.current[key] === controller) {
          delete jobs.current[key];
          setPending((v) => ({ ...v, [key]: false }));
        }
      });
  };
  const clearFile = () => {
    cancel("diff");
    setFile(null);
    setDiff(null);
    setLinePage(0);
  };
  const clearCommit = () => {
    cancel("details", "files");
    clearFile();
    setSelected(null);
    setDetails(null);
  };
  const loadPage = (target = ref, append = false) => {
    if (disabled || (append && (!page?.tip || page.nextOffset === null)))
      return;
    started.current = true;
    if (!append) {
      cancel("list", "details", "files", "diff");
      clearCommit();
      setPage(null);
      setError(null);
      setStale(false);
    }
    const request = {
      scope,
      ref: target,
      offset: append ? page!.nextOffset! : 0,
      ...(append ? { tip: page!.tip! } : {}),
    };
    run(
      "list",
      (signal) => readWithSignal(signal, "readGitHistory", request),
      (value) => {
        verifyScope(value.scope);
        if (value.ref !== target || (append && value.tip !== page!.tip))
          throw Error(msg("git.theGitHistorySnapshotIsOutOfDateRefreshCommit"));
        setPage(
          append
            ? { ...value, commits: [...page!.commits, ...value.commits] }
            : value,
        );
        setStale(false);
      },
    );
  };
  useEffect(() => {
    if (active && !disabled && (!started.current || stale)) loadPage();
  }, [active, disabled, stale]);
  const chooseCommit = (oid: string, parentIndex = 0, append = false) => {
    if (!page?.tip || disabled) return;
    if (!append) {
      cancel("files");
      clearFile();
      setSelected(oid);
      setDetails(null);
    }
    const request = {
      scope,
      ref,
      tip: page.tip,
      commit: oid,
      parentIndex,
      fileOffset: append ? details!.nextFileOffset! : 0,
    };
    run(
      append ? "files" : "details",
      (signal) => readWithSignal(signal, "readGitCommit", request),
      (value) => {
        verifyScope(value.scope);
        if (
          value.tip !== request.tip ||
          value.ref !== ref ||
          value.commit.oid !== oid ||
          value.parentIndex !== parentIndex
        )
          throw Error(msg("git.theComparisonBelongsToADifferentCommit"));
        setDetails(
          append
            ? { ...value, files: [...details!.files, ...value.files] }
            : value,
        );
      },
    );
  };
  const chooseFile = (value: GitHistoryFile) => {
    if (!details || disabled) return;
    setFile(value);
    setDiff(null);
    setLinePage(0);
    const request = {
      scope,
      ref,
      tip: details.tip,
      commit: details.commit.oid,
      parentIndex: details.parentIndex,
      path: value.path,
      ...(value.originalPath ? { originalPath: value.originalPath } : {}),
    };
    run(
      "diff",
      (signal) => readWithSignal(signal, "readGitCommitDiff", request),
      (result) => {
        verifyScope(result.scope);
        if (
          result.tip !== request.tip ||
          result.commit !== request.commit ||
          result.path !== value.path ||
          result.parent !== details.parent
        )
          throw Error(msg("git.theComparisonBelongsToADifferentFileOrParent"));
        setDiff(result);
      },
    );
  };
  const overlay = useRef(onOverlayChange);
  overlay.current = onOverlayChange;
  useEffect(() => {
    overlay.current?.(active && error !== null);
    return () => overlay.current?.(false);
  }, [active, error]);
  const ui = (
    <section
      className="git-history"
      hidden={!active}
      aria-label={msg("git.commitHistory")}
    >
      <header className="git-workspace-heading">
        <div>
          <h2>{msg("git.commits")}</h2>
          <p>{msg("git.currentGitHistoryReadOnly")}</p>
        </div>
        <div className="git-workspace-heading-actions">
          <span className="git-history-ref" aria-label={msg("git.currentGitState")}>
            <span>
              {page ? (page.currentBranch ?? msg("git.headNoBranch")) : "HEAD"}
            </span>
            {page?.tip && <code>{page.tip.slice(0, 8)}</code>}
          </span>
          <TooltipButton
            label={msg("git.refreshCommitHistory")}
            busy={false}
            tooltipLabel={msg("git.refreshHistory")}
            description={msg("git.rereadLocalHistoryWithoutFetchingOrSwitchingBranches")}
            disabled={disabled || !!pending.list}
            onClick={() => loadPage()}
          >
            <span aria-hidden="true" className="git-history-refresh-icon">
              ↻
            </span>
          </TooltipButton>
          <TooltipButton
            label={msg("git.closeCommitHistory")}
            disabled={false}
            busy={false}
            tooltipLabel={msg("git.closeHistory")}
            description={msg("git.returnToThePreviousSectionAndKeepTheSelectedCommit")}
            onClick={onClose}
          >
            ×
          </TooltipButton>
        </div>
      </header>
      {stale && (
        <div className="git-history-notice">{msg("git.historyMayHaveChangedTheSavedSnapshotIsAvailableUntil")}</div>
      )}
      {disabled && (
        <div className="git-history-notice">{msg("git.contextUnavailableTheSavedViewDoesNotGrantAccessTo")}</div>
      )}
      <div className="git-history-layout" ref={layout}>
        <div
          className="git-history-list-pane"
          style={selected ? { flexBasis: `${split}%`, flexGrow: 0 } : undefined}
        >
          {pending.list && !page ? (
            <LoadingState label={msg("git.loadingCommitHistory")} />
          ) : (
            <div
              className="git-history-list"
              data-testid="git-history-list-scroll"
            >
              <div className="git-history-columns" aria-hidden="true">
                <span>{msg("git.message")}</span>
                <span>{msg("git.author")}</span>
                <span>{msg("git.date")}</span>
                <span>{msg("git.hash")}</span>
              </div>
              {page?.commits.map((commit) => (
                <button
                  type="button"
                  key={commit.oid}
                  className={`git-history-row${selected === commit.oid ? " selected" : ""}`}
                  aria-pressed={selected === commit.oid}
                  disabled={disabled}
                  onClick={() => chooseCommit(commit.oid)}
                >
                  <span className="git-history-subject">
                    <span>{commit.subject || msg("git.noMessage")}</span>
                    {commit.refs.length > 0 && (
                      <small>{commit.refs.map(short).join(" · ")}</small>
                    )}
                  </span>
                  <span className="git-history-author">{commit.author}</span>
                  <time dateTime={commit.authoredAt}>
                    {new Date(commit.authoredAt).toLocaleDateString(getLocale())}
                  </time>
                  <code>{commit.oid.slice(0, 8)}</code>
                </button>
              ))}
              {!page?.commits.length && (
                <div className="git-workspace-empty">
                  {page
                    ? msg("git.noCommitsYet")
                    : msg("git.historyHasNotBeenLoadedSelectRefresh")}
                </div>
              )}
              {page?.nextOffset != null && (
                <button
                  type="button"
                  className="git-history-more"
                  disabled={pending.list || disabled}
                  onClick={() => loadPage(ref, true)}
                >{msg("git.moreCommits")}</button>
              )}
              {pending.list && page && (
                <LoadingState label={msg("git.refreshingCommitHistory")} />
              )}
            </div>
          )}
        </div>
        {selected && (
          <>
            <div
              role="separator"
              tabIndex={0}
              aria-label={msg("git.commitListSize")}
              aria-orientation="horizontal"
              aria-valuemin={25}
              aria-valuemax={70}
              aria-valuenow={split}
              className="git-history-splitter"
              onKeyDown={(e) => {
                if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
                  e.preventDefault();
                  setSplit((n) =>
                    e.key === "Home"
                      ? 25
                      : e.key === "End"
                        ? 70
                        : Math.max(
                            25,
                            Math.min(70, n + (e.key === "ArrowDown" ? 5 : -5)),
                          ),
                  );
                }
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const rect = layout.current?.getBoundingClientRect();
                if (rect?.height)
                  setSplit(
                    Math.max(
                      25,
                      Math.min(
                        70,
                        Math.round(
                          ((e.clientY - rect.top) / rect.height) * 100,
                        ),
                      ),
                    ),
                  );
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
            />
            <GitCommitDetails
              value={details}
              selectedFile={file}
              diff={diff}
              pending={!!pending.details}
              filesPending={!!pending.files}
              diffPending={!!pending.diff}
              linePage={linePage}
              onLinePage={setLinePage}
              onFile={chooseFile}
              onCloseFile={clearFile}
              onParent={(i) => chooseCommit(selected, i)}
              onMoreFiles={() =>
                details && chooseCommit(selected, details.parentIndex, true)
              }
              onClose={clearCommit}
              onError={(e) => setError(topicError(e))}
            />
          </>
        )}
      </div>
      {active && error !== null && (
        <TopicModal
          title={msg("git.couldNotReadHistory")}
          closeLabel={msg("git.dismissHistoryError")}
          onClose={() => setError(null)}
        >
          <pre className="git-history-error">{error}</pre>
        </TopicModal>
      )}
    </section>
  );
  return bodyContainer === undefined
    ? ui
    : bodyContainer
      ? createPortal(ui, bodyContainer)
      : null;
}
