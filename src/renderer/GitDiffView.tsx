import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useMemo } from "react";
import type { GitDiffPart } from "../shared/git-workspace";
const DIFF_PAGE_SIZE = 500;
export function PageControls({
  total,
  page,
  size,
  label,
  previous,
  next,
  onPage,
}: {
  total: number;
  page: number;
  size: number;
  label: string;
  previous: string;
  next: string;
  onPage(page: number): void;
}) {
  useLocale();
  if (total <= size) return null;
  return (
    <div className="git-page-controls">
      <span>
        {msg("git.pageRange", { label, start: page * size + 1, end: Math.min((page + 1) * size, total), total })}
      </span>
      <div>
        <button
          type="button"
          aria-label={previous}
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          ←
        </button>
        <button
          type="button"
          aria-label={next}
          disabled={(page + 1) * size >= total}
          onClick={() => onPage(page + 1)}
        >
          →
        </button>
      </div>
    </div>
  );
}
export function GitDiffView({
  part,
  page,
  onPage,
}: {
  part: GitDiffPart;
  page: number;
  onPage(page: number): void;
}) {
  useLocale();
  // The host byte limit alone doesn't bound DOM size: 1 MiB may contain a
  // million empty lines. Page the complete content; never silently truncate.
  const lines = useMemo(
    () =>
      part.kind === "patch" || part.kind === "text"
        ? part.text.split("\n")
        : [],
    [part],
  );
  const visiblePage = Math.min(
    page,
    Math.max(0, Math.ceil(lines.length / DIFF_PAGE_SIZE) - 1),
  );
  const start = visiblePage * DIFF_PAGE_SIZE;
  if (part.kind === "empty")
    return (
      <div className="git-workspace-empty">{msg("git.noChangesInThisVersion")}</div>
    );
  if (part.kind === "binary" || part.kind === "unavailable")
    return (
      <div className="git-workspace-empty">
        {part.text ||
          (part.kind === "binary"
            ? msg("git.binaryFileTextComparisonIsUnavailable")
            : msg("git.contentPreviewUnavailable"))}
      </div>
    );
  return (
    <>
      <PageControls
        total={lines.length}
        page={visiblePage}
        size={DIFF_PAGE_SIZE}
        label={msg("git.lines")}
        previous={msg("git.previousLines")}
        next={msg("git.nextLines")}
        onPage={onPage}
      />
      <pre
        className="git-diff-code"
        aria-label={part.kind === "patch" ? msg("git.fileDiff") : msg("git.newFile")}
      >
        {lines.slice(start, start + DIFF_PAGE_SIZE).map((line, i) => (
          <span
            key={start + i}
            className={
              part.kind === "patch"
                ? line.startsWith("+")
                  ? "added"
                  : line.startsWith("-")
                    ? "removed"
                    : line.startsWith("@@")
                      ? "hunk"
                      : ""
                : ""
            }
          >
            {line || "\u00a0"}
          </span>
        ))}
      </pre>
    </>
  );
}
