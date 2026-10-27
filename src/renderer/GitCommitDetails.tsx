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
  return (
    <section className="git-history-details" aria-label="Детали коммита">
      <header className="git-history-detail-heading">
        <span>Детали коммита</span>
        {value && (
          <TooltipButton
            disabled={false}
            busy={false}
            tooltipLabel="Просмотр коммита"
            description="Только просмотр: файлы и рабочая ветка не изменяются."
            label="Скопировать полный хеш коммита"
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
              aria-label="Родитель для сравнения"
              value={value.parentIndex}
              onChange={(e) => onParent(Number(e.target.value))}
            >
              {value.commit.parents.map((oid, index) => (
                <option value={index} key={`${index}-${oid}`}>
                  Родитель {index + 1} · {oid.slice(0, 8)}
                </option>
              ))}
            </select>
          ) : (
            <small>
              {value.parent
                ? `С родителем ${value.parent.slice(0, 8)}`
                : "Начальный коммит"}
            </small>
          ))}
        <TooltipButton
          disabled={false}
          busy={false}
          tooltipLabel="Просмотр коммита"
          description="Только просмотр: файлы и рабочая ветка не изменяются."
          label="Закрыть детали коммита"
          buttonClassName="git-history-close"
          onClick={onClose}
        >
          ×
        </TooltipButton>
      </header>
      {pending ? (
        <LoadingState label="Загрузка деталей коммита" />
      ) : !value ? (
        <div className="git-workspace-empty">
          Не удалось загрузить детали. Выберите коммит ещё раз.
        </div>
      ) : (
        <>
          <details className="git-history-message">
            <summary>{value.commit.subject || "Без сообщения"}</summary>
            <pre>{value.message}</pre>
          </details>
          <div className="git-history-detail-content">
            <aside className="git-history-files" aria-label="Файлы коммита">
              {!value.files.length && (
                <p className="hint">В этом сравнении изменений нет.</p>
              )}
              {value.files.map((file) => (
                <button
                  type="button"
                  aria-label={`Файл ${file.path}`}
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
                  {filesPending ? "…" : "Ещё файлы"}
                </button>
              )}
            </aside>
            <section
              className="git-history-file-pane"
              aria-label="Сравнение файла коммита"
            >
              {selectedFile && (
                <div className="git-history-file-heading">
                  <span className="git-history-file-badge">
                    <span>{selectedFile.path}</span>
                    <TooltipButton
                      disabled={false}
                      busy={false}
                      tooltipLabel="Просмотр коммита"
                      description="Только просмотр: файлы и рабочая ветка не изменяются."
                      label={`Закрыть файл ${selectedFile.path}`}
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
                  <LoadingState label="Загрузка различий коммита" />
                ) : diff ? (
                  <GitDiffView
                    part={diff.part}
                    page={linePage}
                    onPage={onLinePage}
                  />
                ) : (
                  <div className="git-workspace-empty">
                    {selectedFile
                      ? "Сравнение не загружено. Выберите файл ещё раз."
                      : "Выберите файл для просмотра изменений."}
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
