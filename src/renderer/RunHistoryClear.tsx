import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { ScopeRef } from "../shared/context";
import type {
  ClearRunHistoryRequest,
  ClearRunHistoryResult,
} from "../shared/run-history";
import type { RunKind, RunWithContext } from "./topic-context";
import { TopicModal } from "./TopicsCommon";
import { preparationErrorMessage } from "./preparation-error";
import { useViewActive } from "./RetainedViews";

export function RunHistoryClear({
  scope,
  kind,
  runs,
  label,
  clear,
}: {
  scope: ScopeRef;
  kind: RunKind;
  runs: RunWithContext[];
  label: string;
  clear: (request: ClearRunHistoryRequest) => Promise<ClearRunHistoryResult>;
}) {
  const [confirmedIds, setConfirmedIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const active = useViewActive(),
    mounted = useRef(false),
    flight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) setConfirmedIds(null);
  }, [active]);
  const eligible = runs.filter(
    (run) =>
      ["exited", "failed", "stopped"].includes(run.status) &&
      !run.syncPending &&
      run.recovery !== "unverified",
  );
  async function submit() {
    if (!confirmedIds?.length || flight.current) return;
    flight.current = true;
    const runIds = confirmedIds;
    setConfirmedIds(null);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await clear({ scope, kind, runIds });
      if (!mounted.current) return;
      setMessage(
        `Удалено записей: ${result.removedRunIds.length}.` +
          (result.retained.length
            ? ` Сохранено записей: ${result.retained.length} — завершение или синхронизация ещё не подтверждены.`
            : ""),
      );
    } catch (failure) {
      if (mounted.current) setError(preparationErrorMessage(failure));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={busy || !eligible.length}
        title={
          !eligible.length &&
          runs.some((run) => run.syncPending || run.recovery === "unverified")
            ? "Часть записей ещё нужна для подтверждения процесса или завершения синхронизации."
            : !eligible.length
              ? "Нет завершённых записей для очистки."
              : "Удалить завершённые записи выбранного раздела."
        }
        onClick={() => {
          setError("");
          setMessage("");
          setConfirmedIds(eligible.map((run) => run.id));
        }}
      >
        <Trash2 size={16} aria-hidden="true" />
        Очистить историю…
      </button>
      {(busy || error || message) && (
        <span
          className="run-history-feedback"
          role={error ? "alert" : "status"}
        >
          {busy ? (
            <>
              <span className="loading-spinner" aria-hidden="true" />
              Очищаем историю…
            </>
          ) : (
            error || message
          )}
        </span>
      )}
      {confirmedIds && (
        <TopicModal
          title={`Очистить историю ${kind === "pipeline" ? "конвейеров" : "сборок"}?`}
          className="run-history-clear-dialog"
          onClose={() => setConfirmedIds(null)}
          closeLabel="Закрыть подтверждение очистки"
        >
          <div className="run-history-clear-body">
            <p className="hint">{label}</p>
            <p>
              <strong>Записей к удалению: {confirmedIds.length}</strong>
            </p>
            <p>
              Удаляются только завершённые записи истории Desktop. Файлы проекта
              и исходные журналы Goga не изменятся.
            </p>
            <p className="hint">
              Активные запуски и подключённые панели останутся.
            </p>
          </div>
          <footer className="form-actions">
            <button type="button" onClick={() => setConfirmedIds(null)}>
              Отмена
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void submit()}
            >
              Очистить историю
            </button>
          </footer>
        </TopicModal>
      )}
    </>
  );
}
