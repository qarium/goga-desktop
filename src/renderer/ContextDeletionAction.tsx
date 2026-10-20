import { useEffect, useId, useRef, useState } from "react";
import type { TopicContextRef } from "../shared/worktrees";
import { contextRef, contextRequestKey } from "./topic-context";
import { useReadScope } from "./read-request";
interface Plan {
  token: string;
  contextId: string;
  stage: string;
  details: string[];
}
export function ContextDeletionAction({
  owner,
  current,
  active,
  onDeleted,
}: {
  owner: TopicContextRef;
  current: boolean;
  active: boolean;
  onDeleted: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false),
    [retry, setRetry] = useState(false);
  const recoveryAvailable =
    typeof window.goga.contextDeletionRecovery === "function";
  const [recoveryLoading, setRecoveryLoading] = useState(recoveryAvailable),
    [recoveryFailed, setRecoveryFailed] = useState(false),
    [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const read = useReadScope(contextRequestKey(owner));
  const reasonId = useId();
  const flight = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!recoveryAvailable) return;
    let alive = true;
    setRecoveryLoading(true);
    setRecoveryFailed(false);
    read("contextDeletionRecovery", contextRef(owner))
      .then((recovered) => {
        if (!alive) return;
        if (recovered) {
          if (recovered.contextId !== owner.contextId)
            throw Error("Журнал удаления относится к другой рабочей копии.");
          setPlan(recovered);
          setRetry(true);
          setConfirmationOpen(true);
        }
      })
      .catch((e) => {
        if (alive) {
          setRecoveryFailed(true);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (alive) setRecoveryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [read, recoveryAvailable, recoveryAttempt]);
  const reason = current
    ? "Текущий топик удалить нельзя. Сначала выберите другой."
    : active
      ? "Недоступно во время активного запуска в этой рабочей копии."
      : "";
  async function prepare() {
    if (reason || flight.current || recoveryLoading || recoveryFailed) return;
    if (plan) {
      setConfirmationOpen(true);
      return;
    }
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await read("prepareContextDeletion", contextRef(owner));
      if (mounted.current) {
        setPlan(next);
        setConfirmationOpen(true);
        setRetry(false);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function execute() {
    if (!plan || reason || flight.current) return;
    const token = plan.token;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await window.goga.deleteContext({
        projectId: owner.projectId,
        token,
      });
      if (!mounted.current) return;
      if (result.status !== "success") {
        setRetry(true);
        if (result.stage)
          setPlan((previous) =>
            previous ? { ...previous, stage: result.stage! } : previous,
          );
        setError(
          `${result.message}${result.stage ? ` · этап: ${result.stage}` : ""}`,
        );
        return;
      }
      setPlan(null);
      setConfirmationOpen(false);
      setCompleted(true);
      onDeleted();
    } catch (e) {
      if (mounted.current) {
        setRetry(true);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="topic-card-section"
      aria-label="Удаление топика и копии"
    >
      {completed ? (
        <p role="status">Топик и копия удалены</p>
      ) : (
        <>
          {reason && (
            <p className="topic-action-reason" id={reasonId}>
              {reason}
            </p>
          )}
          <button
            type="button"
            className="danger"
            aria-describedby={reason ? reasonId : undefined}
            disabled={busy || !!reason || recoveryLoading || recoveryFailed}
            onClick={() => void prepare()}
          >
            {recoveryLoading
              ? "Проверяем незавершённое удаление…"
              : plan
                ? "Продолжить удаление…"
                : "Удалить топик и копию…"}
          </button>
          {recoveryFailed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError("");
                setRecoveryAttempt((n) => n + 1);
              }}
            >
              Проверить незавершённое удаление
            </button>
          )}
          {plan && confirmationOpen && (
            <div
              className="topic-confirmation"
              role="region"
              aria-label="Подтверждение удаления топика и копии"
            >
              <h3>
                {retry
                  ? "Продолжить незавершённое удаление?"
                  : "Удалить топик вместе с его автономным клоном?"}
              </h3>
              {retry && (
                <p className="topic-warning">
                  Незавершённая операция · этап: {plan.stage}. Повтор использует
                  прежний подтверждённый план, не создаёт новую операцию.
                </p>
              )}
              <ul>
                {plan.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
              <p className="hint">
                Основная папка проекта не удаляется. Перед выполнением повторно
                проверяются запуски, локальные изменения и сохранность коммитов.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmationOpen(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || !!reason}
                  onClick={() => void execute()}
                >
                  {retry ? "Повторить удаление" : "Подтвердить удаление"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
