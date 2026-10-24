import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/types";
import type {
  HistoryPrunePreview,
  HistoryPruneResult,
} from "../shared/history";
import { readWithSignal } from "./read-request";
import { LoadingState } from "./LoadingBoundary";
import { TopicModal } from "./TopicsCommon";

export function HistoryPrune({
  project,
  year,
  onClose,
  onChanged,
}: {
  project: Project;
  year: string;
  onClose(): void;
  onChanged(): void;
}) {
  const [preview, setPreview] = useState<HistoryPrunePreview>();
  const [result, setResult] = useState<HistoryPruneResult>();
  const [pending, setPending] = useState(true);
  const live = useRef(true),
    applying = useRef(false);
  useEffect(() => {
    live.current = true;
    let current = true;
    const abort = new AbortController();
    readWithSignal(abort.signal, "prepareHistoryPrune", project.id, year)
      .then((p) => {
        if (current) {
          if (p.projectId !== project.id || p.year !== year)
            throw Error("Предпросмотр относится к другому проекту или году.");
          setPreview(p);
        }
      })
      .catch((e) => {
        if (current)
          setResult({
            status: "error",
            changed: false,
            error: e.message,
            log: e.message,
          });
      })
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
      live.current = false;
      abort.abort();
    };
  }, [project.id, year]);
  const confirm = async () => {
    if (!preview?.token || applying.current || pending || result) return;
    applying.current = true;
    setPending(true);
    try {
      const r = await window.goga.pruneHistory(project.id, preview.token);
      // Writes cannot be cancelled on navigation. Always invalidate their original catalog.
      if (r.changed) onChanged();
      if (live.current) setResult(r);
    } catch (e) {
      onChanged();
      const message = e instanceof Error ? e.message : String(e);
      if (live.current)
        setResult({
          status: "error",
          changed: true,
          error: message,
          log: message,
        });
    } finally {
      if (live.current) setPending(false);
    }
  };
  const error = result?.error || preview?.error;
  return (
    <TopicModal
      title={`Очистка истории · ${year}`}
      className="history-prune-dialog"
      busy={applying.current && pending}
      onClose={onClose}
    >
      <p className="context-path">
        {project.name} · Без топика · .goga/history/{year}
      </p>
      {pending ? (
        <LoadingState
          label={
            applying.current
              ? "Очищаем историю…"
              : "Готовим предпросмотр очистки…"
          }
        />
      ) : (
        <>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : result?.status === "ok" ? (
            <h3>Очистка завершена</h3>
          ) : preview?.entries.length ? (
            <>
              <p>
                Будут удалены записи без соответствующей локальной или
                remote-tracking ветки:
              </p>
              <ul className="history-prune-entries">
                {preview.entries.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <p className="history-prune-warning">
                Записи и все их артефакты будут удалены безвозвратно, не в
                корзину. Другие годы и ветки не изменятся.
              </p>
              <p className="hint">
                Используется локальный список веток, без обращения к remote. Не
                изменяйте историю и ветки во время очистки.
              </p>
            </>
          ) : (
            <>
              <h3>Нет записей для очистки</h3>
              <p>
                У всех записей есть соответствующая ветка. Ничего не удалено.
              </p>
            </>
          )}
          {(result?.log || preview?.log) && (
            <details open={!!error}>
              <summary>Журнал операции</summary>
              <pre className="history-prune-log">
                {[preview?.log, result?.log].filter(Boolean).join("\n")}
              </pre>
            </details>
          )}
        </>
      )}
      {!pending &&
        !result &&
        preview?.status === "ready" &&
        !!preview.token && (
          <div className="form-actions">
            <button type="button" autoFocus onClick={onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void confirm()}
            >
              Удалить записи
            </button>
          </div>
        )}
    </TopicModal>
  );
}
