import { HintButton } from "./ActionHint";
import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { SearchablePicker } from "./SearchablePicker";
import { HistoryEntryPicker } from "./HistoryEntryPicker";
import { HistoryPrune } from "./HistoryPrune";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../shared/bridge";
import type { ScopeRef } from "../shared/context";
import type { Project } from "../shared/types";
import type { TopicTarget } from "../shared/topics";
import type { TopicContextRef } from "../shared/worktrees";
import { contextKey, contextRef } from "./topic-context";
import { useReadScope } from "./read-request";
import { useViewActive } from "./RetainedViews";
import { LoadingBoundary } from "./LoadingBoundary";
import { HistoryMarkdown } from "./HistoryMarkdown";
import { HistoryDocument } from "./HistoryDocument";
import { HistoryViewport } from "./HistoryViewport";
import {
  HistoryScrollPane,
  type HistoryScrollPositions,
} from "./HistoryScrollPane";
import "./ProjectHistory.css";

type Method =
  | "listHistoryYears"
  | "listHistoryEntries"
  | "listHistoryArtifacts"
  | "readHistoryArtifact";
/** Each result belongs to the complete request identity, not just its filename. */
function useHistoryRead<M extends Method>(
  method: M,
  args: Parameters<DesktopAPI[M]>,
  active: boolean,
  refreshKey?: number,
) {
  type Result = Awaited<ReturnType<DesktopAPI[M]>>;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([method, args, active, attempt, refreshKey]);
  const read = useReadScope(key);
  const [state, setState] = useState<{
    request?: typeof read;
    data?: Result;
    error?: string;
  }>({});
  useEffect(() => {
    if (!active) {
      setState({ request: read });
      return;
    }
    let live = true;
    read(method, ...args).then(
      (data) => {
        if (live) setState({ request: read, data });
      },
      (error) => {
        if (live)
          setState({
            request: read,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [key, read, active]);
  return {
    data: state.request === read ? state.data : undefined,
    error: state.request === read ? state.error : undefined,
    pending: active && state.request !== read,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function ProjectHistory({
  project,
  owner,
}: {
  project: Project;
  owner?: TopicContextRef;
}) {
  useLocale();
  const active = useViewActive();
  const scope = owner ? contextRef(owner) : project.id;
  const scopeKey = typeof scope === "string" ? scope : contextKey(scope);
  const [refresh, setRefresh] = useState(0);
  const [prune, setPrune] = useState<{ scopeKey: string; year: string } | null>(
    null,
  );
  const years = useHistoryRead("listHistoryYears", [scope], active, refresh);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const availableYears = years.data ?? [];
  const year = availableYears.includes(choices[scopeKey]!)
    ? choices[scopeKey]!
    : (availableYears[0] ?? "");
  const entries = useHistoryRead(
    "listHistoryEntries",
    [scope, year],
    active && !!year && !!years.data,
    refresh,
  );
  const entryKey = JSON.stringify([scopeKey, year]);
  const availableEntries = entries.data ?? [];
  const entry = availableEntries.includes(choices[entryKey]!)
    ? choices[entryKey]!
    : "";
  useEffect(() => {
    setPrune(null);
  }, [scopeKey, choices[scopeKey], active]);
  useEffect(() => {
    if (
      entries.data &&
      choices[entryKey] &&
      !entries.data.includes(choices[entryKey])
    )
      setChoices((old) => {
        const next = { ...old };
        delete next[entryKey];
        return next;
      });
  }, [entries.data, entryKey, choices]);
  const invalidate = () => {
    // A fresh catalog decides which selection still exists; do not choose another entry.
    setRefresh((value) => value + 1);
  };
  return (
    <section className="history-view" aria-label={msg("project.projectHistory")}>
      <LoadingBoundary
        pending={years.pending}
        error={years.error}
        onRetry={years.retry}
        label={msg("project.loadingHistory")}
      >
        {!availableYears.length ? (
          <div className="empty-file">
            <h3>{msg("project.historyIsEmpty")}</h3>
            <p>{msg("project.entriesFromGogaHistoryForTheSelectedProjectOrTopic")}</p>
          </div>
        ) : (
          <>
            <div className="tool-controls history-controls">
              <SearchablePicker
                key={JSON.stringify([scopeKey, active])}
                className="history-year-picker"
                label={msg("project.year")}
                entries={availableYears}
                value={year}
                disabled={!active}
                placeholder={msg("project.selectAYear")}
                emptyLabel={msg("project.noYears")}
                searchLabel={msg("project.findAYear")}
                searchPlaceholder={msg("project.year")}
                listLabel={msg("project.historyYears")}
                onChange={(value) =>
                  setChoices((old) => ({ ...old, [scopeKey]: value }))
                }
              />
              <HistoryEntryPicker
                key={JSON.stringify([entryKey, active])}
                entries={availableEntries}
                value={entry}
                disabled={
                  !active ||
                  !availableEntries.length ||
                  entries.pending ||
                  !!entries.error
                }
                onChange={(value) =>
                  setChoices((old) => ({ ...old, [entryKey]: value }))
                }
              />
              {!owner && (
                <button
                  type="button"
                  className="history-prune-trigger"
                  disabled={entries.pending || !!entries.error || !active}
                  onClick={() => {
                    setPrune({ scopeKey, year });
                  }}
                >{msg("project.clearHistory2")}</button>
              )}
              <span className="history-readonly">{msg("project.readOnly")}</span>
            </div>
            <LoadingBoundary
              pending={entries.pending}
              error={entries.error}
              onRetry={entries.retry}
              label={msg("project.loadingHistoryEntries")}
            >
              {!availableEntries.length ? (
                <div className="empty-file">
                  <h3>{msg("project.noHistoryForYear", { year })}</h3>
                  <p>{msg("project.chooseAnotherYear")}</p>
                </div>
              ) : !entry ? (
                <div className="empty-file">
                  <h3>{msg("project.selectAHistoryEntry")}</h3>
                  <p>{msg("project.thenSelectAFileToView")}</p>
                </div>
              ) : null}
            </LoadingBoundary>
          </>
        )}
      </LoadingBoundary>
      {/* Keep selection and folder state mounted during refreshes of the catalogs. */}
      <div
        hidden={
          !entry ||
          years.pending ||
          !!years.error ||
          entries.pending ||
          !!entries.error
        }
      >
        <HistoryArtifacts
          scope={scope}
          year={year}
          entry={entry}
          active={active && !!entry && !!entries.data && !!years.data}
          refreshKey={refresh}
        />
      </div>
      {prune && prune.scopeKey === scopeKey && active && !owner && (
        <HistoryPrune
          key={JSON.stringify([prune.scopeKey, prune.year])}
          project={project}
          year={prune.year}
          onClose={() => setPrune(null)}
          onChanged={invalidate}
        />
      )}
    </section>
  );
}

export function HistoryArtifacts({
  scope,
  year,
  entry,
  target,
  active: enabled = true,
  refreshKey,
}: {
  scope: ScopeRef;
  year: string;
  entry: string;
  target?: TopicTarget;
  active?: boolean;
  refreshKey?: number;
}) {
  useLocale();
  const active = useViewActive() && enabled;
  const key = JSON.stringify([
    typeof scope === "string" ? scope : contextKey(scope),
    year,
    entry,
    target,
  ]);
  const tree = useHistoryRead(
    "listHistoryArtifacts",
    [scope, year, entry, target],
    active,
    refreshKey,
  );
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scrollPositions = useRef<HistoryScrollPositions>(new Map());
  const files = tree.data ?? [];
  const current = selection[key];
  const file = files.find(
    (item) => item.kind === "file" && item.path === current,
  );
  const [linkError, setLinkError] = useState<{
    key: string;
    text: string;
  } | null>(null);
  const choose = useCallback(
    (path: string) => {
      if (!files.some((item) => item.kind === "file" && item.path === path)) {
        setLinkError({ key, text: msg("project.fileWasNotFoundInThisEntry", { path: String(path) }) });
        return;
      }
      setLinkError(null);
      setSelection((old) => ({ ...old, [key]: path }));
      const parents = path.split("/").slice(0, -1);
      setExpanded((old) => ({
        ...old,
        ...Object.fromEntries(
          parents.map((_, i) => [
            JSON.stringify([key, parents.slice(0, i + 1).join("/")]),
            true,
          ]),
        ),
      }));
    },
    [key, tree.data],
  );
  const doc = useHistoryRead(
    "readHistoryArtifact",
    [scope, year, entry, file?.path ?? "", target],
    active && !!tree.data && !!file?.readable,
  );
  const relative = `.goga/history/${year}/${entry}/${file?.path ?? ""}`;
  const mismatch =
    doc.data && doc.data.relativePath !== relative
      ? msg("project.theFileBelongsToAnotherHistoryEntryReloadIt")
      : undefined;
  function branch(prefix = "") {
    return (
      <ul>
        {files
          .filter(
            (item) =>
              item.path.slice(0, item.path.lastIndexOf("/") + 1) === prefix,
          )
          .map((item) => {
            const folderKey = JSON.stringify([key, item.path]);
            const open =
              expanded[folderKey] ?? !!file?.path.startsWith(item.path + "/");
            return (
              <li key={item.path}>
                {item.kind === "directory" ? (
                  <>
                    <HintButton
                      type="button"
                      className="folder-row"
                      aria-label={msg("project.folder", { path: String(item.path) })}
                      aria-expanded={open}
                      disabled={!!item.reason}
                      hint={item.reason}
                      onClick={() =>
                        setExpanded((old) => ({ ...old, [folderKey]: !open }))
                      }
                    >
                      <span className="chevron" aria-hidden="true">
                        {open ? "⌄" : "›"}
                      </span>
                      <span className="folder-mark" aria-hidden="true" />
                      <span>{item.path.split("/").pop()}</span>
                    </HintButton>
                    {open && <div>{branch(item.path + "/")}</div>}
                  </>
                ) : (
                  <button
                    type="button"
                    className={`file-row ${file?.path === item.path ? "selected" : ""}`}
                    aria-label={msg("project.file2", { path: String(item.path) })}
                    aria-pressed={file?.path === item.path}
                    onClick={() => choose(item.path)}
                  >
                    <span className="file-mark" aria-hidden="true" />
                    <span>{item.path.split("/").pop()}</span>
                  </button>
                )}
              </li>
            );
          })}
      </ul>
    );
  }
  return (
    <div className="history-artifacts">
      <LoadingBoundary
        pending={tree.pending}
        error={tree.error}
        onRetry={tree.retry}
        label={msg("project.loadingArtifacts")}
      >
        <p className="history-root">
          .goga/history/{year}/{entry}/
        </p>
        {!files.length ? (
          <div className="empty-file">
            <h3>{msg("project.noArtifactsYet")}</h3>
            <p>{msg("project.thereAreNoFilesToViewInThisEntry")}</p>
          </div>
        ) : (
          <HistoryViewport active={active}>
            <div className="item-list tree-pane">
              <span className="eyebrow">{msg("project.artifacts")}</span>
              <HistoryScrollPane
                positionKey={JSON.stringify([key, "tree"])}
                positions={scrollPositions.current}
                active={active && !!tree.data}
                label={msg("project.scrollFileList")}
              >
                <nav className="file-tree" aria-label={msg("project.historyEntryFiles")}>
                  {branch()}
                </nav>
              </HistoryScrollPane>
            </div>
            {file ? (
              <HistoryDocument
                identity={JSON.stringify([key, "document", file.path])}
                positions={scrollPositions.current}
                active={active}
                ready={
                  active &&
                  !!tree.data &&
                  !doc.pending &&
                  !doc.error &&
                  !mismatch
                }
                readable={file.readable}
                title={file.path.split("/").pop()!}
                format={
                  doc.data?.format === "markdown"
                    ? "MARKDOWN"
                    : file.readable
                      ? msg("project.text")
                      : msg("project.file3")
                }
                contextLabel={`${year} / ${entry} / ${file.path}`}
              >
                {linkError?.key === key && (
                  <p role="alert" className="error">
                    {linkError.text}
                  </p>
                )}
                {!file.readable ? (
                  <div className="empty-file">
                    <h3>{msg("project.previewUnavailable")}</h3>
                    <p>
                      {file.reason ||
                        msg("project.thisFormatDoesNotSupportTextPreviews")}
                    </p>
                  </div>
                ) : (
                  <LoadingBoundary
                    pending={doc.pending}
                    error={doc.error || mismatch}
                    onRetry={doc.retry}
                    label={msg("project.loadingFile")}
                  >
                    {doc.data && !mismatch && (
                      <div className="history-preview">
                        {doc.data.text === "" ? (
                          <p className="history-empty">{msg("project.fileIsEmpty")}</p>
                        ) : doc.data.format === "markdown" ? (
                          <HistoryMarkdown
                            text={doc.data.text}
                            path={file.path}
                            onFile={choose}
                          />
                        ) : (
                          <pre className="history-plain">{doc.data.text}</pre>
                        )}
                      </div>
                    )}
                  </LoadingBoundary>
                )}
              </HistoryDocument>
            ) : (
              <div className="history-document">
                <div className="empty-file">
                  <h3>{msg("project.selectAFile")}</h3>
                  <p>
                    {current
                      ? msg("project.theSelectedFileIsNoLongerAvailableSelectAnotherFile")
                      : msg("project.selectAnArtifactOnTheLeftToViewIt")}
                  </p>
                </div>
              </div>
            )}
          </HistoryViewport>
        )}
      </LoadingBoundary>
    </div>
  );
}
