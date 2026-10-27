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
    <section className="history-view" aria-label="История проекта">
      <LoadingBoundary
        pending={years.pending}
        error={years.error}
        onRetry={years.retry}
        label="Загружаем историю…"
      >
        {!availableYears.length ? (
          <div className="empty-file">
            <h3>История пока пуста</h3>
            <p>
              Здесь появятся записи из .goga/history выбранного проекта или
              топика.
            </p>
          </div>
        ) : (
          <>
            <div className="tool-controls history-controls">
              <SearchablePicker
                key={JSON.stringify([scopeKey, active])}
                className="history-year-picker"
                label="Год"
                entries={availableYears}
                value={year}
                disabled={!active}
                placeholder="Выберите год"
                emptyLabel="Нет годов"
                searchLabel="Найти год"
                searchPlaceholder="Год"
                listLabel="Годы истории"
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
                >
                  Очистить историю…
                </button>
              )}
              <span className="history-readonly">Только просмотр</span>
            </div>
            <LoadingBoundary
              pending={entries.pending}
              error={entries.error}
              onRetry={entries.retry}
              label="Загружаем записи истории…"
            >
              {!availableEntries.length ? (
                <div className="empty-file">
                  <h3>За {year} год записей нет</h3>
                  <p>Выберите другой год.</p>
                </div>
              ) : !entry ? (
                <div className="empty-file">
                  <h3>Выберите запись истории</h3>
                  <p>Затем выберите файл для просмотра.</p>
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
        setLinkError({ key, text: `Файл «${path}» не найден в этой записи.` });
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
      ? "Файл относится к другой записи истории. Повторите загрузку."
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
                    <button
                      type="button"
                      className="folder-row"
                      aria-label={`Папка ${item.path}`}
                      aria-expanded={open}
                      disabled={!!item.reason}
                      title={item.reason}
                      onClick={() =>
                        setExpanded((old) => ({ ...old, [folderKey]: !open }))
                      }
                    >
                      <span className="chevron" aria-hidden="true">
                        {open ? "⌄" : "›"}
                      </span>
                      <span className="folder-mark" aria-hidden="true" />
                      <span>{item.path.split("/").pop()}</span>
                    </button>
                    {open && <div>{branch(item.path + "/")}</div>}
                  </>
                ) : (
                  <button
                    type="button"
                    className={`file-row ${file?.path === item.path ? "selected" : ""}`}
                    aria-label={`Файл ${item.path}`}
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
        label="Загружаем артефакты…"
      >
        <p className="history-root">
          .goga/history/{year}/{entry}/
        </p>
        {!files.length ? (
          <div className="empty-file">
            <h3>Артефактов пока нет</h3>
            <p>В этой записи нет файлов для просмотра.</p>
          </div>
        ) : (
          <HistoryViewport active={active}>
            <div className="item-list tree-pane">
              <span className="eyebrow">АРТЕФАКТЫ</span>
              <HistoryScrollPane
                positionKey={JSON.stringify([key, "tree"])}
                positions={scrollPositions.current}
                active={active && !!tree.data}
                label="Прокрутка списка файлов"
              >
                <nav className="file-tree" aria-label="Файлы записи истории">
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
                      ? "ТЕКСТ"
                      : "ФАЙЛ"
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
                    <h3>Предпросмотр недоступен</h3>
                    <p>
                      {file.reason ||
                        "Этот формат не поддерживает текстовый просмотр."}
                    </p>
                  </div>
                ) : (
                  <LoadingBoundary
                    pending={doc.pending}
                    error={doc.error || mismatch}
                    onRetry={doc.retry}
                    label="Загружаем файл…"
                  >
                    {doc.data && !mismatch && (
                      <div className="history-preview">
                        {doc.data.text === "" ? (
                          <p className="history-empty">Файл пуст</p>
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
                  <h3>Выберите файл</h3>
                  <p>
                    {current
                      ? "Выбранный файл больше недоступен. Выберите другой файл."
                      : "Выберите артефакт в списке слева для просмотра."}
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
