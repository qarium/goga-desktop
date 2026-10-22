import { useId } from "react";
import type { TopicContextIdentity, WorktreeRecord } from "../shared/worktrees";
import { contextRef } from "./topic-context";
import { RepositoryActions } from "./RepositoryActions";
import {
  topicSyncLabel,
  topicSyncPending,
  topicSyncUnavailable,
  useTopicSync,
} from "./topic-sync-controller";

/** Sibling of transition, not a selection action. Its owner is always this row. */
export function TopicQuickSync({
  identity,
  record,
  onStarted,
}: {
  identity: TopicContextIdentity;
  record?: WorktreeRecord;
  onStarted?: () => void;
}) {
  if (typeof window.goga.runRepositoryAction === "function" && record)
    return (
      <RepositoryActions
        project={{
          id: record.projectId,
          name: record.projectPath.split("/").pop() || "Проект",
          path: record.projectPath,
        }}
        selected={record}
        onlySync
        onStarted={onStarted}
      />
    );
  return <LegacyTopicQuickSync identity={identity} record={record} />;
}
function LegacyTopicQuickSync({
  identity,
  record,
}: {
  identity: TopicContextIdentity;
  record?: WorktreeRecord;
}) {
  const id = useId();
  const reason = topicSyncUnavailable(record);
  const available =
    !reason &&
    typeof window.goga.syncTopicContext === "function" &&
    typeof window.goga.topicSyncStatus === "function";
  const sync = useTopicSync(available && record ? contextRef(record) : null);
  const label = `Синхронизировать коммиты · ${identity.topic}/${identity.year}/${identity.branch}`;
  const retry = sync.state?.status === "error" || sync.failedAction;
  const error = sync.error || sync.state?.error;
  const pending = topicSyncPending(sync);
  const unavailable =
    reason ||
    (!available ? "Синхронизация недоступна в этой версии хоста." : "");
  const status = available ? topicSyncLabel(sync) : unavailable;
  const idle =
    !available ||
    (!pending && !error && (!sync.state || sync.state.status === "new"));
  const compact =
    error || sync.state?.status === "error"
      ? "Ошибка"
      : sync.busy || sync.state?.status === "syncing"
        ? "Синхронизация…"
        : sync.state?.status === "waiting"
          ? "В очереди"
          : "Готово";
  return (
    <div
      className="topic-quick-sync"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Enter/Space keep native button activation, but never reach row/search navigation.
        if (
          ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(
            event.key,
          )
        )
          event.stopPropagation();
      }}
    >
      <button
        type="button"
        className="topic-quick-sync-button"
        aria-label={label}
        title={`${label} — ${unavailable || (retry ? "Повторить синхронизацию" : status)}`}
        aria-describedby={id}
        disabled={!available || pending}
        onClick={() => void sync.sync()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2" />
        </svg>
      </button>
      <span
        id={id}
        className={`topic-quick-sync-status${idle ? " sr-only" : ""}`}
        role={error ? "alert" : "status"}
        aria-live={error ? "assertive" : "polite"}
      >
        {!idle && <span aria-hidden="true">{compact}</span>}
        <span className="sr-only">
          {status}
          {error && ` · ${error}`}
        </span>
      </span>
    </div>
  );
}
