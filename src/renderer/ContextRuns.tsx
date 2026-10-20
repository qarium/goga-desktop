import { useState } from "react";
import type { Pipeline, Run } from "../shared/types";
import {
  relativeRunPlanPath,
  runsForContext,
  type RunKind,
  type RunWithContext,
  type TopicContextIdentity,
} from "./topic-context";
import "./ContextRuns.css";

export interface ContextRunsProps {
  runs: RunWithContext[];
  context: TopicContextIdentity | null;
  onOpen: (runId: string) => void;
  pipelines?: Pipeline[];
  contextLabel?: string;
  unavailableReason?: string;
  primaryProjectId?: string;
}
const statusLabels: Record<Run["status"], string> = {
  starting: "Запускается",
  running: "Выполняется",
  exited: "Завершён",
  failed: "Ошибка",
  stopped: "Остановлен",
};

/** Contextual history is inert until the user explicitly opens a record. */
export function ContextRuns({
  runs,
  context,
  onOpen,
  pipelines = [],
  contextLabel,
  unavailableReason,
  primaryProjectId,
}: ContextRunsProps) {
  const [filter, setFilter] = useState<RunKind>("pipeline");
  const scoped =
    !context && primaryProjectId
      ? runs.filter((run) => run.projectId === primaryProjectId && !run.context)
      : runsForContext(runs, context);
  const pipelineCount = scoped.filter((run) => run.kind !== "build").length;
  const filtered = scoped.filter((run) => (run.kind ?? "pipeline") === filter);
  return (
    <section className="context-runs" aria-label="Запуски выбранного топика">
      <h2>Запуски</h2>
      {contextLabel && (
        <p className="context-run-hint">Топик: {contextLabel}</p>
      )}
      {unavailableReason && (
        <p className="context-run-hint" role="status">
          {unavailableReason}
        </p>
      )}
      <div className="context-run-filters" aria-label="Тип запусков">
        <button
          type="button"
          aria-label={`Конвейеры: ${pipelineCount}`}
          aria-pressed={filter === "pipeline"}
          onClick={() => setFilter("pipeline")}
        >
          Конвейеры <span className="context-counter">{pipelineCount}</span>
        </button>
        <button
          type="button"
          aria-pressed={filter === "build"}
          onClick={() => setFilter("build")}
        >
          Сборка
        </button>
      </div>
      {!context && !contextLabel && (
        <p className="context-run-hint">
          Выберите топик, чтобы посмотреть его запуски.
        </p>
      )}
      <>
        {filter === "build" && (
          <p className="context-run-hint">
            Одна активная сборка в этой рабочей копии. Завершённые сборки
            остаются в истории.
          </p>
        )}
        {filtered.length === 0 && (
          <p className="context-run-hint">
            {filter === "build"
              ? "Сборка ещё не запускалась."
              : "Конвейеры ещё не запускались."}
          </p>
        )}
        <div className="context-run-list">
          {filtered.map((run) => {
            const isBuild = run.kind === "build";
            const pipeline = pipelines.find((item) => item.id === run.pipeline);
            const name = isBuild
              ? (relativeRunPlanPath(run.build?.planPath, run.context?.path) ??
                "План не указан")
              : run.pipelineName?.trim() || pipeline?.name || run.pipeline;
            const description =
              run.pipelineDescription ?? pipeline?.description;
            const timestamp = new Date(run.startedAt);
            const hasTime = Number.isFinite(timestamp.getTime());
            return (
              <article key={run.id} className="context-run-row">
                <div className="context-run-main">
                  <div className="context-run-identity">
                    <small>{isBuild ? "Сборка" : "Конвейер"}</small>
                    <strong>{name}</strong>
                    {!isBuild && description?.trim() && (
                      <p className="context-run-description">{description}</p>
                    )}
                    {hasTime && (
                      <time dateTime={run.startedAt}>
                        {timestamp.toLocaleString("ru-RU")}
                      </time>
                    )}
                  </div>
                  <div className="context-run-actions">
                    <span className={`context-run-status is-${run.status}`}>
                      {run.recovery === "unverified"
                        ? "Состояние процесса не подтверждено после перезапуска"
                        : statusLabels[run.status]}
                    </span>
                    <button
                      type="button"
                      aria-label={`Открыть запуск ${name}`}
                      onClick={() => onOpen(run.id)}
                    >
                      Открыть запуск →
                    </button>
                  </div>
                </div>
                {run.syncPending && (
                  <p className="context-run-hint" role="status">
                    Синхронизация коммитов ожидает выполнения; результат запуска
                    не изменён.
                  </p>
                )}
                {run.persistenceError && (
                  <p className="error" role="alert">
                    Не удалось полностью сохранить историю:{" "}
                    {run.persistenceError}
                  </p>
                )}
                <details className="context-run-technical">
                  <summary>Технические сведения</summary>
                  <dl>
                    <dt>Идентификатор запуска</dt>
                    <dd>{run.id}</dd>
                    {run.context?.path && (
                      <>
                        <dt>Папка рабочей копии</dt>
                        <dd>{run.context.path}</dd>
                      </>
                    )}
                    {isBuild &&
                      run.build?.planPath &&
                      run.build.planPath !== name && (
                        <>
                          <dt>Путь плана в записи</dt>
                          <dd>{run.build.planPath}</dd>
                        </>
                      )}
                  </dl>
                </details>
              </article>
            );
          })}
        </div>
      </>
    </section>
  );
}
