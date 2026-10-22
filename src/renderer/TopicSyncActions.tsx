import { useEffect, useRef, useState } from "react";
import type { TopicContextRef } from "../shared/worktrees";
import type { ContextApplyPreview } from "../shared/context-sync";
import { contextRef, contextRequestKey } from "./topic-context";
import {
  assertSyncOwner,
  topicSyncLabel,
  topicSyncPending,
  useTopicSync,
} from "./topic-sync-controller";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** Import is not merge, publish, or a replacement for the recorded run outcome. */
export function TopicSyncActions({
  owner,
  onChanged,
}: {
  owner: TopicContextRef;
  onChanged: () => void;
}) {
  const key = contextRequestKey(owner);
  const sync = useTopicSync(owner);
  const scope = useRef({ key, api: window.goga });
  if (scope.current.key !== key || scope.current.api !== window.goga)
    scope.current = { key, api: window.goga };
  const currentScope = scope.current;
  const [local, setLocal] = useState<{
    scope: typeof currentScope;
    error: string;
    notice: string;
    busy: boolean;
    preview: ContextApplyPreview | null;
  }>({
    scope: currentScope,
    error: "",
    notice: "",
    busy: false,
    preview: null,
  });
  const mounted = useRef(false);
  const flight = useRef<typeof currentScope | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Key-tagged local state cannot leak an old preview or callback across owners/revisions.
  const view =
    local.scope === currentScope
      ? local
      : {
          scope: currentScope,
          error: "",
          notice: "",
          busy: false,
          preview: null,
        };
  const preview = view.preview;
  const busy = view.busy || sync.busy;
  const error = view.error || sync.error;
  const notice = view.notice;
  async function act(kind: "sync" | "preview" | "apply") {
    if (kind === "sync") {
      await sync.sync();
      return;
    }
    if (flight.current === currentScope) return;
    const confirmed = preview;
    if (kind === "apply" && !confirmed?.canApply) return;
    flight.current = currentScope;
    const operationScope = scope.current;
    const current = () => mounted.current && scope.current === operationScope;
    setLocal({
      scope: operationScope,
      error: "",
      notice: "",
      busy: true,
      preview,
    });
    try {
      if (kind === "preview") {
        const next = await window.goga.prepareContextApply(contextRef(owner));
        if (!current()) return;
        assertSyncOwner(owner, next);
        setLocal({
          scope: operationScope,
          error: "",
          notice: "",
          busy: false,
          preview: next,
        });
      } else if (confirmed) {
        assertSyncOwner(owner, confirmed);
        await window.goga.applyContext({
          projectId: confirmed.projectId,
          token: confirmed.token,
          confirmed: true,
        });
        if (current()) {
          setLocal({
            scope: operationScope,
            error: "",
            notice: "Коммиты применены в базовую ветку.",
            busy: false,
            preview: null,
          });
          onChanged();
        }
      }
    } catch (error) {
      if (current())
        setLocal({
          scope: operationScope,
          error: message(error),
          notice: "",
          busy: false,
          preview: kind === "apply" ? null : preview,
        });
    } finally {
      if (flight.current === operationScope) flight.current = null;
    }
  }
  return (
    <section
      className="topic-card-section topic-sync"
      aria-label="Перенос изменений"
    >
      <h3>Перенос изменений</h3>
      <p role="status">
        <strong>Синхронизация: </strong>
        <span>{topicSyncLabel(sync)}</span>
      </p>
      <p className="hint">
        Push в origin копии — в ветку {owner.branch} исходного локального
        проекта, без переключения ветки и слияния. Незакоммиченные файлы не
        отправляются и не мешают синхронизации. Публикация на удалённый сервер
        не выполняется.
      </p>
      {(error || sync.state?.error) && (
        <p className="error" role="alert">
          {error || sync.state?.error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="form-actions">
        <button
          type="button"
          disabled={busy || topicSyncPending(sync)}
          onClick={() => void act("sync")}
        >
          {sync.state?.status === "error" || sync.failedAction
            ? "Повторить синхронизацию"
            : "Синхронизировать"}
        </button>
        {error && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void sync.refresh()}
          >
            Обновить статус
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("preview")}
        >
          Применить в базу…
        </button>
      </div>
      {preview && (
        <div
          className="topic-confirmation"
          role="region"
          aria-label="Подтверждение применения в базу"
        >
          <h3>Применить коммиты в базовую ветку?</h3>
          <p>
            Целевая ветка: <strong>{preview.targetBranch}</strong>
          </p>
          <p className="hint">
            Будут проверены локальные изменения, конфликты и активные операции.
            Основная папка не переключается автоматически.
          </p>
          <details>
            <summary>Коммиты и цель</summary>
            <p>Источник: {preview.sourceOid}</p>
            <p>Текущий коммит базы: {preview.targetOid}</p>
          </details>
          <ul>
            {preview.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          {preview.reason && <p className="topic-warning">{preview.reason}</p>}
          <div className="form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setLocal({ ...view, preview: null })}
            >
              Отмена
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !preview.canApply}
              onClick={() => void act("apply")}
            >
              Подтвердить применение
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
