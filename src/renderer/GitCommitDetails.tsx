import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import type {
  GitCommitDetails as Details,
  GitCommitDiff,
  GitHistoryFile,
} from "../shared/git-history";
import { GitDiffView } from "./GitDiffView";
import { LoadingState } from "./LoadingBoundary";
import { TooltipButton } from "./RepositoryActions";
export function GitCommitDetails({
  value,
  selectedFile,
  diff,
  pending,
  diffPending,
  filesPending,
  linePage,
  onLinePage,
  onFile,
  onCloseFile,
  onParent,
  onMoreFiles,
  onClose,
  onError,
}: {
  value: Details | null;
  selectedFile: GitHistoryFile | null;
  diff: GitCommitDiff | null;
  pending: boolean;
  diffPending: boolean;
  filesPending: boolean;
  linePage: number;
  onLinePage(page: number): void;
  onFile(file: GitHistoryFile): void;
  onCloseFile(): void;
  onParent(index: number): void;
  onMoreFiles(): void;
  onClose(): void;
  onError(error: unknown): void;
}) {
  useLocale();
  return (
    <section className="git-history-details" aria-label={msg("git.commitDetails")}>
      <header className="git-history-detail-heading">
        <span>{msg("git.commitDetails")}</span>
        {value && (
          <TooltipButton
            disabled={false}
            busy={false}
            tooltipLabel={msg("git.viewCommit")}
            description={msg("git.readOnlyFilesAndTheWorkingBranchWillNotChange")}
            label={msg("git.copyFullCommitHash")}
            buttonClassName="git-history-oid"
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(value.commit.oid);
                } catch (error) {
                  onError(error);
                }
              })();
            }}
          >
            {value.commit.oid.slice(0, 8)}
          </TooltipButton>
        )}
        {value &&
          (value.commit.parents.length > 1 ? (
            <select
              aria-label={msg("git.parentToCompareAgainst")}
              value={value.parentIndex}
              onChange={(e) => onParent(Number(e.target.value))}
            >
              {value.commit.parents.map((oid, index) => (
                <option value={index} key={`${index}-${oid}`}>{msg("git.parent")}{index + 1} · {oid.slice(0, 8)}
                </option>
              ))}
            </select>
          ) : (
            <small>
              {value.parent
                ? msg("git.compareWithParent", { value1: String(value.parent.slice(0, 8)) })
                : msg("git.initialCommit")}
            </small>
          ))}
        <TooltipButton
          disabled={false}
          busy={false}
          tooltipLabel={msg("git.viewCommit")}
          description={msg("git.readOnlyFilesAndTheWorkingBranchWillNotChange")}
          label={msg("git.closeCommitDetails")}
          buttonClassName="git-history-close"
          onClick={onClose}
        >
          ×
        </TooltipButton>
      </header>
      {pending ? (
        <LoadingState label={msg("git.loadingCommitDetails")} />
      ) : !value ? (
        <div className="git-workspace-empty">{msg("git.couldNotLoadDetailsSelectTheCommitAgain")}</div>
      ) : (
        <>
          <details className="git-history-message">
            <summary>{value.commit.subject || msg("git.noMessage")}</summary>
            <pre>{value.message}</pre>
          </details>
          <div className="git-history-detail-content">
            <aside className="git-history-files" aria-label={msg("git.commitFiles")}>
              {!value.files.length && (
                <p className="hint">{msg("git.noChangesInThisComparison")}</p>
              )}
              {value.files.map((file) => (
                <button
                  type="button"
                  aria-label={msg("git.file", { path: String(file.path) })}
                  key={file.path}
                  className={selectedFile?.path === file.path ? "active" : ""}
                  onClick={() => onFile(file)}
                >
                  <span className="git-file-status">{file.status}</span>
                  <span
                    className="git-file-name"
                    title={
                      file.originalPath
                        ? `${file.originalPath} → ${file.path}`
                        : file.path
                    }
                  >
                    {file.path}
                  </span>
                  <small>
                    {file.additions === null
                      ? "binary"
                      : `+${file.additions} −${file.deletions}`}
                  </small>
                </button>
              ))}
              {value.nextFileOffset !== null && (
                <button
                  type="button"
                  disabled={filesPending}
                  onClick={onMoreFiles}
                >
                  {filesPending ? "…" : msg("git.moreFiles")}
                </button>
              )}
            </aside>
            <section
              className="git-history-file-pane"
              aria-label={msg("git.commitFileDiff")}
            >
              {selectedFile && (
                <div className="git-history-file-heading">
                  <span className="git-history-file-badge">
                    <span>{selectedFile.path}</span>
                    <TooltipButton
                      disabled={false}
                      busy={false}
                      tooltipLabel={msg("git.viewCommit")}
                      description={msg("git.readOnlyFilesAndTheWorkingBranchWillNotChange")}
                      label={msg("git.closeFile", { path: String(selectedFile.path) })}
                      onClick={onCloseFile}
                    >
                      ×
                    </TooltipButton>
                  </span>
                </div>
              )}
              <div
                className="git-history-diff"
                data-testid="git-history-diff-scroll"
              >
                {diffPending ? (
                  <LoadingState label={msg("git.loadingCommitDiff")} />
                ) : diff ? (
                  <GitDiffView
                    part={diff.part}
                    page={linePage}
                    onPage={onLinePage}
                  />
                ) : (
                  <div className="git-workspace-empty">
                    {selectedFile
                      ? msg("git.couldNotLoadTheComparisonSelectTheFileAgain")
                      : msg("git.selectAFileToViewChanges")}
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </section>
  );
}
