import { useContextDeletionExecutor } from "./ContextDeletionController";
import type { DeletionPreview } from "./context-deletion-flow";
import { useEffect, useId, useRef, useState } from "react";
import type { TopicContextRef } from "../shared/worktrees";
import { contextRef, contextRequestKey } from "./topic-context";
import { useReadScope } from "./read-request";
type Plan = DeletionPreview;
export function ContextDeletionAction({
  owner,
  current,
  active,
  onDeleted,
  autoPrepare = false,
  onBusy,
  onCancel,
}: {
  owner: TopicContextRef;
  current: boolean;
  active: boolean;
  onDeleted: () => void;
  autoPrepare?: boolean;
  onBusy?: (value: boolean) => void;
  onCancel?: () => void;
}) {
  const executor = useContextDeletionExecutor();
  const [allowAhead, setAllowAhead] = useState(false);
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
  const [switchBranch, setSwitchBranch] = useState("");
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
  const reason = active
    ? "Недоступно во время активного запуска в этой рабочей копии."
    : "";
  const needsAheadConfirmation =
    plan?.stage === "prepared" && plan.requiresAheadConfirmation;
  async function prepare(branch?: string) {
    if (reason || flight.current || recoveryLoading || recoveryFailed) return;
    if (plan && !branch) {
      setConfirmationOpen(true);
      return;
    }
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = branch
        ? await read("prepareContextDeletion", contextRef(owner), branch)
        : await read("prepareContextDeletion", contextRef(owner));
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
  const autoStarted = useRef(false);
  useEffect(() => {
    if (
      autoPrepare &&
      !autoStarted.current &&
      !recoveryLoading &&
      !recoveryFailed
    ) {
      autoStarted.current = true;
      void prepare();
    }
  }, [autoPrepare, recoveryLoading, recoveryFailed]);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  async function execute() {
    if (
      !plan ||
      plan.stage === "choose-branch" ||
      reason ||
      flight.current ||
      (needsAheadConfirmation && !allowAhead)
    )
      return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!executor)
        throw Error(
          "Контроллер удаления недоступен. Откройте карточку заново.",
        );
      const result = await executor(owner, plan, allowAhead);
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
          {(!autoPrepare || !confirmationOpen) && (
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
          )}
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
              {plan.stage === "choose-branch" && (
                <label>
                  Перейти в ветку
                  <select
                    aria-label="Перейти в ветку"
                    value={switchBranch}
                    disabled={busy}
                    onChange={(e) => setSwitchBranch(e.target.value)}
                  >
                    <option value="">Выберите локальную ветку</option>
                    {plan.switchBranches?.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {plan.stage === "choose-branch" &&
                !plan.switchBranches?.length && (
                  <p className="hint">
                    Нет другой локальной ветки. Создайте её в основной папке и
                    откройте подтверждение заново.
                  </p>
                )}
              <ul>
                {plan.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
              <p className="hint">
                Основная папка проекта не удаляется. Перед выполнением повторно
                проверяются запуски, локальные изменения и состав коммитов.
              </p>
              {plan.clonePath && (
                <p className="hint">
                  В Корзину: <code>{plan.clonePath}</code>
                </p>
              )}
              {needsAheadConfirmation && (
                <label className="topic-warning">
                  <input
                    type="checkbox"
                    checked={allowAhead}
                    disabled={busy}
                    onChange={(e) => setAllowAhead(e.target.checked)}
                  />
                  В клоне есть коммиты, не переданные в исходный проект
                  {plan.aheadCount !== undefined ? ` (${plan.aheadCount})` : ""}
                  . Всё равно удалить клон вместе с его Git-историей.
                </label>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmationOpen(false);
                    onCancel?.();
                  }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={
                    busy ||
                    (plan.stage === "choose-branch" && !switchBranch) ||
                    !!reason ||
                    (!!needsAheadConfirmation && !allowAhead)
                  }
                  onClick={() =>
                    plan.stage === "choose-branch"
                      ? void prepare(switchBranch)
                      : void execute()
                  }
                >
                  {plan.stage === "choose-branch"
                    ? "Проверить выбранную ветку"
                    : retry
                      ? "Повторить удаление"
                      : "Подтвердить удаление"}
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
