import { useEffect, useRef, useState } from "react";
import type { WorktreeRecord } from "../shared/worktrees";
import { TopicModal } from "./TopicsCommon";
/** Migration is an explicit new owned clone, never conversion or removal. */
export function ContextMigration({
  record,
  onMigrated,
}: {
  record: WorktreeRecord;
  onMigrated: (record: WorktreeRecord) => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const flight = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function migrate() {
    if (flight.current || !confirm) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await window.goga.migrateTopicContext({
        projectId: record.projectId,
        year: record.year,
        topic: record.topic,
        branch: record.branch,
      });
      if (!mounted.current) return;
      if (next.storageKind !== "clone" || next.state !== "ready")
        throw Error(
          "Автономный клон пока не готов. Прежняя копия не изменена.",
        );
      setConfirm(false);
      onMigrated(next);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="context-compatibility"
      aria-label="Совместимость рабочей копии"
    >
      <p className="topic-warning">
        Это прежняя linked-worktree копия. История доступна; новые запуски
        требуют автономного клона.
      </p>
      <button
        type="button"
        disabled={busy || typeof window.goga.migrateTopicContext !== "function"}
        onClick={() => setConfirm(true)}
      >
        Создать автономный клон…
      </button>
      {confirm && (
        <TopicModal
          title="Создать отдельный автономный клон?"
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <p>
            Будет создан отдельный автономный клон топика {record.topic}. Старая
            linked-копия останется без изменений: без конвертации, удаления и
            переноса незакоммиченных файлов.
          </p>
          <p className="hint">
            В случае ошибки прежний контекст и черновики сохраняются. После
            неопределённого результата повтор сначала проверяет фактическое
            состояние.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void migrate()}
            >
              Подтвердить создание клона
            </button>
          </div>
        </TopicModal>
      )}
    </section>
  );
}
