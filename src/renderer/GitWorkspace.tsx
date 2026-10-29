import { GitDiffView as DiffPart, PageControls } from "./GitDiffView";
import { useGitSummary } from "./useGitSummary";
import {
  useGitSequencerOperation,
  GitSequencerOperationFooter,
  GitSequencerOperationDialogs,
} from "./GitSequencerOperation";
import {
  GitRebaseOperationDialogs,
  GitRebaseOperationFooter,
  useGitRebaseOperation,
} from "./GitRebaseOperation";
import { contextKey } from "./topic-context";
import {
  GitMergeOperationDialogs,
  GitMergeOperationFooter,
  useGitMergeOperation,
} from "./GitMergeOperation";
import { GitBranchPicker } from "./GitBranchPicker";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { scopeProjectId, type ScopeRef } from "../shared/context";
import { useGitConflicts } from "./useGitConflicts";
import {
  GitConflictEditor,
  GitConflictFooter,
  GitConflictDialogs,
} from "./GitConflictEditor";
import type {
  GitWorkspaceSnapshot,
  GitWorkspaceDiff,
} from "../shared/git-workspace";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { useViewActive } from "./RetainedViews";
import { LoadingState } from "./LoadingBoundary";
import { TopicModal, topicError } from "./TopicsCommon";
import { TooltipButton } from "./RepositoryActions";
import { GitCommitFooter, useGitCommit } from "./GitCommit";
import { GitDiscardFooter, useGitDiscard } from "./GitDiscard";
import "./GitWorkspace.css";
export interface GitWorkspaceProps {
  scope: ScopeRef;
  open: boolean;
  bodyContainer: HTMLElement | null;
  onOpen(): void;
  onClose(): void;
  historyOpen?: boolean;
  onHistoryOpen?(): void;
  onHistoryClose?(): void;
  onCurrentBranchChanged?(scope: ScopeRef): void;
  onChanged?(projectId: string, scope?: ScopeRef): void;
  onOverlayChange?(projectId: string, visible: boolean, owner?: string): void;
  onBranchBusyChange?(projectId: string, busy: boolean, owner?: string): void;
  revision: number;
  disabled?: boolean;
}
/** App retains this owner; the key also protects consumers that replace scope in place. */
export function GitWorkspace(props: GitWorkspaceProps) {
  const scope = props.scope;
  // Freshness is not ownership: keep drafts when the same context is refreshed.
  const key =
    typeof scope === "string"
      ? JSON.stringify([scope])
      : JSON.stringify([
          scope.projectId,
          scope.year,
          scope.topic,
          scope.branch,
          scope.contextId,
        ]);
  return <GitWorkspaceOwner key={key} {...props} />;
}
const operations: Record<GitWorkspaceSnapshot["operation"], string> = {
  none: "",
  merge: "Незавершённое слияние",
  rebase: "Незавершённый rebase",
  "cherry-pick": "Незавершённый cherry-pick",
  revert: "Незавершённый revert",
  unknown: "Незавершённая операция Git",
};
const FILE_PAGE_SIZE = 200;
function GitWorkspaceOwner({
  scope,
  open,
  bodyContainer,
  onOpen,
  onClose,
  historyOpen = false,
  onHistoryOpen,
  onHistoryClose,
  revision,
  onChanged,
  onCurrentBranchChanged,
  onOverlayChange,
  onBranchBusyChange,
  disabled = false,
}: GitWorkspaceProps) {
  const active = useViewActive();
  const summarySupported = typeof window.goga.readGitSummary === "function";
  const owner = documentScopeId(scope);
  const [snapshot, setSnapshot] = useState<GitWorkspaceSnapshot | null>(null);
  const [snapshotPending, setSnapshotPending] = useState(true);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [file, setFile] = useState("");
  const [filePage, setFilePage] = useState(0);
  const [linePages, setLinePages] = useState<Record<string, number>>({});
  const [side, setSide] = useState<"unstaged" | "staged">("unstaged");
  const [diff, setDiff] = useState<GitWorkspaceDiff | null>(null);
  const [diffPending, setDiffPending] = useState(false);
  const [diffFailed, setDiffFailed] = useState(false);
  const [failure, setFailure] = useState("");
  const [showFailure, setShowFailure] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [branchPending, setBranchPending] = useState(false);
  const [branchOverlay, setBranchOverlay] = useState(false);
  // Synchronous start ordering is independent of React's batched renders.
  const issuedReadVersion = useRef(0);
  const [readVersion, setReadVersion] = useState(0);
  const commit = useGitCommit(scope, () => {
    setRefresh((n) => n + 1);
    onChanged?.(scopeProjectId(scope), scope);
  });
  const discardRefreshRequested = useRef<number | null>(null);
  const discard = useGitDiscard(scope, (paths) => {
    commit.removePaths(paths);
    setRefresh((n) => n + 1);
    onChanged?.(scopeProjectId(scope), scope);
  });
  const snapshotConflict =
    snapshot?.files.some(
      (entry) => entry.path === file && entry.kind === "conflict",
    ) ?? false;
  const conflictState = useGitConflicts({
    scope,
    snapshot,
    file,
    visible: active && open && !disabled,
    enabled:
      active &&
      open &&
      !disabled &&
      !snapshotPending &&
      !snapshotFailed &&
      snapshotConflict,
    onSaved: (issuedScope) => {
      setRefresh((n) => n + 1);
      onChanged?.(scopeProjectId(issuedScope), issuedScope);
    },
  });
  const merge = useGitMergeOperation({
    scope,
    snapshot,
    visible: active && open && !disabled,
    ready: !snapshotPending && !snapshotFailed,
    blocked:
      branchPending ||
      discard.locked ||
      !!commit.pending ||
      !!commit.preview ||
      conflictState.locked ||
      conflictState.modalOpen,
    unresolved:
      !!snapshot?.files.some((entry) => entry.kind === "conflict") ||
      conflictState.retainedPaths.length > 0,
    freshness: JSON.stringify([
      owner,
      revision,
      refresh,
      snapshot?.revision,
      readVersion,
    ]),
    readVersion,
    getIssuedReadVersion: () => issuedReadVersion.current,
    onSucceeded: (issuedScope) => {
      conflictState.clearCompletedOperation();
      setRefresh((n) => n + 1);
      onChanged?.(scopeProjectId(issuedScope), issuedScope);
    },
  });
  const rebase = useGitRebaseOperation({
    scope,
    snapshot,
    visible: active && open && !disabled,
    ready: !snapshotPending && !snapshotFailed,
    blocked:
      branchPending ||
      discard.locked ||
      !!commit.pending ||
      !!commit.preview ||
      conflictState.locked ||
      conflictState.modalOpen ||
      merge.locked ||
      merge.modalOpen,
    unresolved:
      !!snapshot?.files.some((entry) => entry.kind === "conflict") ||
      conflictState.retainedPaths.length > 0,
    freshness: JSON.stringify([
      owner,
      revision,
      refresh,
      snapshot?.revision,
      readVersion,
    ]),
    readVersion,
    getIssuedReadVersion: () => issuedReadVersion.current,
    onSucceeded: (issuedScope) => {
      conflictState.clearCompletedOperation();
      setRefresh((n) => n + 1);
      onChanged?.(scopeProjectId(issuedScope), issuedScope);
    },
  });
  const sequencer = useGitSequencerOperation({
    scope,
    snapshot,
    visible: active && open && !disabled,
    ready: !snapshotPending && !snapshotFailed,
    blocked:
      branchPending ||
      discard.locked ||
      !!commit.pending ||
      !!commit.preview ||
      conflictState.locked ||
      conflictState.modalOpen ||
      merge.locked ||
      merge.modalOpen ||
      rebase.locked ||
      rebase.modalOpen,
    unresolved:
      !!snapshot?.files.some((entry) => entry.kind === "conflict") ||
      conflictState.retainedPaths.length > 0,
    freshness: JSON.stringify([
      owner,
      revision,
      refresh,
      snapshot?.revision,
      readVersion,
    ]),
    readVersion,
    getIssuedReadVersion: () => issuedReadVersion.current,
    onSucceeded: (issuedScope) => {
      conflictState.clearCompletedOperation();
      setRefresh((n) => n + 1);
      onChanged?.(scopeProjectId(issuedScope), issuedScope);
    },
  });
  const rebaseMutationBlocked =
    rebase.locked ||
    rebase.needsRefresh ||
    sequencer.locked ||
    sequencer.needsRefresh;
  const conflictPresentation = {
    ...conflictState,
    locked:
      conflictState.locked ||
      merge.locked ||
      rebaseMutationBlocked ||
      discard.locked,
  };
  const stableOwner = typeof scope === "string" ? scope : contextKey(scope);
  const projectId = scopeProjectId(scope);
  const presentation = useRef({ onOverlayChange, onBranchBusyChange });
  presentation.current = { onOverlayChange, onBranchBusyChange };
  const overlay =
    active &&
    (branchOverlay ||
      (open &&
        (discard.modalOpen ||
          rebase.modalOpen ||
          sequencer.modalOpen ||
          merge.modalOpen ||
          conflictState.modalOpen ||
          !!commit.preview ||
          !!commit.result ||
          showFailure)));
  const busy =
    branchPending ||
    !!rebase.pending ||
    !!sequencer.pending ||
    !!merge.pending ||
    !!conflictState.pending ||
    !!commit.pending ||
    !!discard.pending;
  useLayoutEffect(() => {
    presentation.current.onOverlayChange?.(projectId, overlay, stableOwner);
    return () =>
      presentation.current.onOverlayChange?.(projectId, false, stableOwner);
  }, [projectId, stableOwner, overlay]);
  useEffect(() => {
    presentation.current.onBranchBusyChange?.(projectId, busy, stableOwner);
    return () =>
      presentation.current.onBranchBusyChange?.(projectId, false, stableOwner);
  }, [projectId, stableOwner, busy]);
  const summary = useGitSummary(
    scope,
    summarySupported && active && !disabled && !busy,
    revision + refresh,
  );
  const observedBranch = useRef<{ branch: string | null } | null>(null);
  const currentBranch = summarySupported
    ? summary.value?.branch
    : snapshot?.branch;
  useEffect(() => {
    if (currentBranch === undefined) return;
    const previous = observedBranch.current;
    observedBranch.current = { branch: currentBranch };
    if (previous && previous.branch !== currentBranch)
      onCurrentBranchChanged?.(scope);
  }, [currentBranch, scope, onCurrentBranchChanged]);
  const isConflict =
    snapshotConflict || (!!conflictState.entry && !conflictState.entry.saved);
  const requested = useRef<{ revision: number; refresh: number } | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const scroll = useRef<Record<string, number>>({});
  const preview = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active || disabled || (summarySupported && !open)) return;
    if (
      !open &&
      requested.current?.revision === revision &&
      requested.current.refresh === refresh
    )
      return;
    requested.current = { revision, refresh };
    const controller = new AbortController();
    const requestReadVersion = ++issuedReadVersion.current;
    setSnapshotPending(true);
    setSnapshotFailed(false);
    setShowFailure(false);
    void readWithSignal(controller.signal, "readGitWorkspace", scopeRef.current)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (documentScopeId(value.scope) !== owner)
          throw Error("Ответ Git относится к другому контексту.");
        setSnapshot(value);
        if (open) commit.initializeSelection(value);
        setReadVersion(requestReadVersion);
        if (
          discardRefreshRequested.current !== null &&
          requestReadVersion > discardRefreshRequested.current
        ) {
          discard.manualRefresh();
          discardRefreshRequested.current = null;
        }
        setFile((current) =>
          value.files.some((f) => f.path === current) ||
          conflictState.hasRetained(current)
            ? current
            : "",
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSnapshotFailed(true);
        setFailure(topicError(error));
        setShowFailure(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSnapshotPending(false);
      });
    return () => controller.abort();
  }, [active, disabled, open, owner, revision, refresh, summarySupported]);
  useEffect(() => {
    if (
      !active ||
      !open ||
      disabled ||
      !snapshot ||
      snapshotPending ||
      snapshotFailed ||
      !file ||
      isConflict
    )
      return;
    const controller = new AbortController();
    setDiffPending(true);
    setDiffFailed(false);
    void readWithSignal(controller.signal, "readGitDiff", {
      scope: scopeRef.current,
      path: file,
      revision: snapshot.revision,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          documentScopeId(value.scope) !== owner ||
          value.path !== file ||
          value.revision !== snapshot.revision
        )
          throw Error("Ответ Git устарел. Обновите изменения.");
        setDiff(value);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setDiffFailed(true);
        setFailure(topicError(error));
        setShowFailure(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiffPending(false);
      });
    return () => controller.abort();
  }, [
    active,
    open,
    disabled,
    owner,
    file,
    snapshot,
    snapshotPending,
    snapshotFailed,
    isConflict,
  ]);
  useEffect(() => {
    if (active && open) closeButton.current?.focus({ preventScroll: true });
  }, [active, open]);
  useEffect(() => {
    if (preview.current)
      preview.current.scrollTop =
        scroll.current[JSON.stringify([file, side])] ?? 0;
  }, [open, active, file, side, diff]);
  const conflicts =
    snapshot?.files.filter((f) => f.kind === "conflict").length ?? 0;
  const branch = summarySupported
    ? summary.value
      ? (summary.value.branch ?? "HEAD (без ветки)")
      : typeof scope === "string"
        ? "—"
        : scope.branch
    : (snapshot?.branch ??
      (snapshot?.head
        ? `HEAD · ${snapshot.head.slice(0, 8)}`
        : typeof scope === "string"
          ? "—"
          : scope.branch));
  const currentDiff =
    diff?.path === file && diff.revision === snapshot?.revision ? diff : null;
  const files = [
    ...(snapshot?.files ?? []),
    ...conflictState.retainedPaths
      .filter((path) => !snapshot?.files.some((entry) => entry.path === path))
      .map((path) => ({
        path,
        kind: "conflict" as const,
        indexStatus: "U",
        worktreeStatus: "U",
        submodule: false,
        originalPath: undefined,
      })),
  ];
  const visibleFilePage = Math.min(
    filePage,
    Math.max(0, Math.ceil(files.length / FILE_PAGE_SIZE) - 1),
  );
  const fileStart = visibleFilePage * FILE_PAGE_SIZE;
  const linePageKey = JSON.stringify([file, side]);
  const body = active && open;
  return (
    <>
      <div className="git-workspace-controls">
        {typeof scope === "string" &&
        typeof window.goga.readGitBranches === "function" ? (
          <GitBranchPicker
            projectId={scope}
            onOverlayChange={(_id, visible) => setBranchOverlay(visible)}
            onBusyChange={(busy) => {
              setBranchPending(busy);
            }}
            branch={branch}
            operation={
              !snapshotPending && !snapshotFailed
                ? snapshot?.operation
                : undefined
            }
            onShowChanges={onOpen}
            revision={revision + refresh}
            disabled={
              disabled ||
              !!discard.pending ||
              !!discard.preview ||
              !!commit.pending ||
              !!commit.preview ||
              conflictState.locked ||
              merge.locked ||
              merge.modalOpen ||
              rebase.locked ||
              sequencer.locked ||
              rebase.modalOpen
            }
            mutationBlockedReason={
              rebase.needsRefresh || sequencer.needsRefresh
                ? "Обновите изменения Git перед изменением веток."
                : discard.uncertain
                  ? "Проверьте состояние прежней отмены в Изменениях."
                  : undefined
            }
            onChanged={(id) => {
              setRefresh((n) => n + 1);
              onChanged?.(id);
            }}
          />
        ) : (
          <span
            className="git-workspace-branch"
            title={branch}
            aria-label={`Ветка: ${branch}`}
          >
            <span aria-hidden="true">⑂</span> {branch}
          </span>
        )}
        <TooltipButton
          buttonClassName={`git-workspace-trigger${(summarySupported ? summary.value?.conflicts : conflicts) ? " has-conflicts" : ""}`}
          disabled={disabled}
          busy={false}
          tabProps={{ "aria-pressed": open }}
          label={
            summarySupported
              ? `Изменения, ${summary.error ? "не удалось обновить данные" : summary.value ? `файлов: ${summary.value.changedFiles}${summary.value.conflicts ? `, конфликтов: ${summary.value.conflicts}` : ""}` : "проверяем данные"}`
              : conflicts
                ? `Конфликты · ${conflicts}`
                : "Изменения"
          }
          tooltipLabel="Изменения рабочей папки"
          description={
            summarySupported
              ? summary.error
                ? "Не удалось обновить данные. Количество изменений неизвестно. Откройте раздел для диагностики."
                : summary.value
                  ? `Изменённых файлов: ${summary.value.changedFiles}. Конфликтов: ${summary.value.conflicts}. Счётчик обновляется автоматически.`
                  : "Проверяем изменения. Раздел можно открыть, не дожидаясь счётчика."
              : "Посмотреть изменения выбранного контекста"
          }
          tooltipEnabled={active}
          onClick={() => (open ? onClose() : onOpen())}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 3H3v12a2 2 0 0 0 2 2h1M16 3H9v18h12V8zM16 3v5h5" />
          </svg>
          <span>
            {!summarySupported && conflicts ? "Конфликты" : "Изменения"}
          </span>
          <span
            className={`git-changes-count${(summarySupported ? summary.error || !summary.value || summary.value.changedFiles === 0 : !snapshot || snapshotFailed || snapshot.files.length === 0) ? " quiet" : ""}`}
            aria-hidden="true"
          >
            {summarySupported
              ? summary.error
                ? "—"
                : (summary.value?.changedFiles ?? "…")
              : snapshotFailed
                ? "—"
                : (snapshot?.files.length ?? "…")}
          </span>
          {(summarySupported
            ? summary.error || !!summary.value?.conflicts
            : !!conflicts) && (
            <span className="git-changes-warning" aria-hidden="true">
              ⚠
            </span>
          )}
        </TooltipButton>
        {onHistoryOpen && (
          <TooltipButton
            buttonClassName="git-workspace-trigger"
            disabled={disabled}
            busy={false}
            tabProps={{ "aria-pressed": historyOpen }}
            label="Коммиты"
            tooltipLabel="История коммитов"
            description="Посмотреть коммиты, файлы и различия. Без переключения рабочей ветки."
            tooltipEnabled={active}
            onClick={() => (historyOpen ? onHistoryClose?.() : onHistoryOpen())}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6M12 7v5l3 2" />
            </svg>
            <span>Коммиты</span>
          </TooltipButton>
        )}
      </div>
      {bodyContainer &&
        active &&
        createPortal(
          <section
            className={`git-workspace${isConflict ? " git-workspace-conflicts" : ""}`}
            aria-label="Изменения Git"
            hidden={!body}
            inert={!body}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !showFailure &&
                !discard.modalOpen &&
                !commit.preview &&
                !commit.result &&
                !conflictState.modalOpen &&
                !merge.modalOpen &&
                !(rebase.modalOpen || sequencer.modalOpen)
              ) {
                event.stopPropagation();
                event.preventDefault();
                closeRef.current();
              }
            }}
          >
            <header className="git-workspace-heading">
              <div>
                <h2>Изменения</h2>
                <p>Рабочая папка и подготовленные изменения</p>
              </div>
              <div className="git-workspace-heading-actions">
                <TooltipButton
                  label="Обновить изменения"
                  tooltipLabel="Обновить изменения"
                  description="Перечитать состояние локальной рабочей папки и индекса"
                  busy={snapshotPending}
                  disabled={
                    snapshotPending ||
                    !!discard.pending ||
                    !!discard.preview ||
                    !!commit.pending ||
                    conflictState.locked ||
                    merge.locked ||
                    rebase.locked ||
                    sequencer.locked
                  }
                  onClick={() => {
                    commit.manualRefresh();
                    if (discard.uncertain)
                      discardRefreshRequested.current =
                        issuedReadVersion.current;
                    setRefresh((n) => n + 1);
                  }}
                  buttonClassName="icon-button"
                >
                  ↻
                </TooltipButton>
                <button
                  ref={closeButton}
                  type="button"
                  className="icon-button"
                  aria-label="Закрыть изменения"
                  onClick={onClose}
                >
                  ×
                </button>
              </div>
            </header>
            {snapshot?.operation !== undefined &&
              snapshot.operation !== "none" && (
                <div className="git-workspace-notice" role="note">
                  {operations[snapshot.operation]}.{" "}
                  {conflicts ? `Конфликтов: ${conflicts}. ` : ""}Закрытие
                  просмотра не отменяет операцию. Каждый разрешённый файл
                  сохраняется отдельно.
                  {snapshot.operation !== "merge" &&
                    (snapshot.operation !== "rebase" || !rebase.supported) &&
                    (!["cherry-pick", "revert"].includes(snapshot.operation) ||
                      !sequencer.supported) &&
                    " Продолжение и отмена этой операции здесь не поддерживаются."}
                </div>
              )}
            <div className="git-workspace-content">
              {disabled ? (
                <div className="git-workspace-empty">
                  Выбранный контекст недоступен. Основная папка не используется
                  вместо него.
                </div>
              ) : snapshotPending ? (
                <LoadingState label="Загрузка изменений" />
              ) : snapshotFailed ? (
                <div className="git-workspace-empty">
                  Не удалось загрузить изменения. Можно обновить список или
                  закрыть просмотр.
                </div>
              ) : !files.length ? (
                <div className="git-workspace-empty">
                  <strong>Нет изменений для просмотра</strong>
                  <span>
                    Изменений обычных файлов не найдено. Рабочие копии
                    подмодулей не проверяются.
                  </span>
                </div>
              ) : (
                <>
                  <nav
                    className="git-workspace-files"
                    aria-label="Изменённые файлы"
                  >
                    <PageControls
                      total={files.length}
                      page={visibleFilePage}
                      size={FILE_PAGE_SIZE}
                      label="Файлы"
                      previous="Предыдущие файлы"
                      next="Следующие файлы"
                      onPage={setFilePage}
                    />
                    {files
                      .slice(fileStart, fileStart + FILE_PAGE_SIZE)
                      .map((entry) => (
                        <div className="git-file-row" key={entry.path}>
                          {(commit.supported || discard.supported) &&
                            !isConflict && (
                              <input
                                type="checkbox"
                                aria-label={`Выбрать файл: ${entry.path}`}
                                checked={commit.paths.includes(entry.path)}
                                disabled={
                                  discard.locked ||
                                  !!commit.pending ||
                                  !!commit.preview ||
                                  entry.kind === "conflict" ||
                                  entry.submodule ||
                                  snapshot?.operation !== "none"
                                }
                                onChange={() => commit.toggle(entry.path)}
                              />
                            )}
                          <button
                            type="button"
                            key={entry.path}
                            aria-label={entry.path}
                            disabled={
                              conflictState.locked ||
                              merge.locked ||
                              rebase.locked ||
                              sequencer.locked
                            }
                            aria-pressed={file === entry.path}
                            className={file === entry.path ? "active" : ""}
                            onClick={() => {
                              setFile(entry.path);
                              setSide(
                                entry.worktreeStatus === "." &&
                                  entry.indexStatus !== "."
                                  ? "staged"
                                  : "unstaged",
                              );
                            }}
                          >
                            <span
                              className={`git-file-status${entry.kind === "conflict" ? " conflict" : ""}`}
                              title={`Индекс: ${entry.indexStatus}; рабочая папка: ${entry.worktreeStatus}`}
                            >
                              {entry.kind === "untracked"
                                ? "?"
                                : entry.kind === "conflict"
                                  ? "!"
                                  : entry.indexStatus !== "."
                                    ? entry.indexStatus
                                    : entry.worktreeStatus}
                            </span>
                            <span
                              className="git-file-name"
                              title={
                                entry.originalPath
                                  ? `${entry.originalPath} → ${entry.path}`
                                  : entry.path
                              }
                            >
                              {entry.path}
                              {entry.originalPath && (
                                <small>из {entry.originalPath}</small>
                              )}
                            </span>
                          </button>
                          {isConflict && file === entry.path && (
                            <button
                              type="button"
                              className="git-file-close"
                              aria-label={`Закрыть файл: ${entry.path}`}
                              title="Закрыть файл"
                              disabled={
                                conflictState.locked ||
                                merge.locked ||
                                rebase.locked ||
                                sequencer.locked
                              }
                              onClick={() => setFile("")}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                  </nav>
                  {isConflict ? (
                    <GitConflictEditor
                      key={file}
                      conflicts={conflictPresentation}
                    />
                  ) : (
                    <div className="git-workspace-file">
                      <div className="git-workspace-file-heading">
                        <strong title={file}>{file || "Выберите файл"}</strong>
                        <div
                          className="git-diff-tabs"
                          aria-label="Версия изменений"
                        >
                          <button
                            type="button"
                            disabled={!file}
                            aria-pressed={side === "unstaged"}
                            onClick={() => setSide("unstaged")}
                          >
                            Рабочая папка
                          </button>
                          <button
                            type="button"
                            disabled={!file}
                            aria-pressed={side === "staged"}
                            onClick={() => setSide("staged")}
                          >
                            Подготовлено
                          </button>
                        </div>
                      </div>
                      <div
                        className="git-diff-preview"
                        ref={preview}
                        onScroll={(event) => {
                          scroll.current[JSON.stringify([file, side])] =
                            event.currentTarget.scrollTop;
                        }}
                      >
                        {!file ? (
                          <div className="git-workspace-empty">
                            Выберите файл слева для просмотра изменений.
                          </div>
                        ) : diffPending ? (
                          <LoadingState label="Загрузка различий" />
                        ) : diffFailed ? (
                          <div className="git-workspace-empty">
                            Не удалось прочитать файл. Обновите изменения.
                          </div>
                        ) : currentDiff ? (
                          <DiffPart
                            part={currentDiff[side]}
                            page={linePages[linePageKey] ?? 0}
                            onPage={(page) => {
                              setLinePages((pages) => ({
                                ...pages,
                                [linePageKey]: page,
                              }));
                              if (preview.current)
                                preview.current.scrollTop = 0;
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <footer className="git-workspace-footer">
              {isConflict ? (
                <GitConflictFooter
                  conflicts={conflictPresentation}
                  disabled={
                    disabled ||
                    snapshotPending ||
                    snapshotFailed ||
                    branchPending ||
                    merge.locked ||
                    rebaseMutationBlocked
                  }
                />
              ) : snapshot?.operation !== "none" ? null : commit.supported ? (
                <GitCommitFooter
                  commit={commit}
                  snapshot={snapshot}
                  disabled={
                    discard.locked ||
                    disabled ||
                    snapshotPending ||
                    snapshotFailed ||
                    branchPending ||
                    merge.locked ||
                    rebaseMutationBlocked
                  }
                  visible={body}
                />
              ) : (
                "Просмотр не изменяет файлы, индекс, ветки и удалённый репозиторий."
              )}
              {discard.supported &&
                !isConflict &&
                snapshot?.operation === "none" && (
                  <GitDiscardFooter
                    discard={discard}
                    snapshot={snapshot}
                    selectedPaths={commit.paths}
                    disabled={
                      disabled ||
                      snapshotPending ||
                      snapshotFailed ||
                      branchPending ||
                      !!commit.pending ||
                      !!commit.preview ||
                      commit.uncertain ||
                      conflictState.locked ||
                      merge.locked ||
                      rebaseMutationBlocked
                    }
                    visible={body}
                    ready={!snapshotPending && !snapshotFailed}
                  />
                )}
              {snapshot?.operation === "merge" && (
                <GitMergeOperationFooter
                  merge={{
                    ...merge,
                    canStart:
                      merge.canStart &&
                      !rebaseMutationBlocked &&
                      !(rebase.modalOpen || sequencer.modalOpen),
                    canExecute:
                      merge.canExecute &&
                      !rebaseMutationBlocked &&
                      !(rebase.modalOpen || sequencer.modalOpen),
                  }}
                  unresolved={
                    conflicts > 0 || conflictState.retainedPaths.length > 0
                  }
                />
              )}
              {(snapshot?.operation === "cherry-pick" ||
                snapshot?.operation === "revert") && (
                <GitSequencerOperationFooter
                  sequencer={sequencer}
                  unresolved={
                    conflicts > 0 || conflictState.retainedPaths.length > 0
                  }
                />
              )}
              {snapshot?.operation === "rebase" && (
                <GitRebaseOperationFooter
                  rebase={rebase}
                  unresolved={
                    conflicts > 0 || conflictState.retainedPaths.length > 0
                  }
                />
              )}
            </footer>
            {body && <GitRebaseOperationDialogs rebase={rebase} />}
            {body && <GitSequencerOperationDialogs sequencer={sequencer} />}
            {body && <GitMergeOperationDialogs merge={merge} />}
            {body && <GitConflictDialogs conflicts={conflictState} />}
            {body && showFailure && (
              <TopicModal
                title="Не удалось прочитать изменения"
                closeLabel="Закрыть ошибку Git"
                className="git-workspace-error"
                onClose={() => setShowFailure(false)}
              >
                <pre>{failure}</pre>
              </TopicModal>
            )}
          </section>,
          bodyContainer,
        )}
    </>
  );
}
