import { useViewActive } from "./RetainedViews";
import { useReadScope } from "./read-request";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  TopicOperationPlan,
  TopicOperationRequest,
  TopicOperationResult,
} from "../shared/topics";
import "./Topics.css";
/** Remove only known card-read transport envelopes; retain the host's reason. */
export function topicError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(
    /^Error invoking remote method 'goga:(?:read-request|read-topic-details|read-topic-board)': (?:Error: )?/,
    "",
  );
}
export function TopicModal({
  title,
  className = "",
  children,
  busy = false,
  onClose,
}: {
  title: string;
  className?: string;
  children: ReactNode;
  busy?: boolean;
  onClose: () => void;
}) {
  const active = useViewActive();
  const node = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    if (!active) return;
    const el = node.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => {
      el.close();
      previous?.focus();
    };
  }, [active]);
  return (
    <dialog
      ref={node}
      className={`topic-dialog ${className}`}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть карточку"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function TopicSwitch({
  children,
  checked,
  onChange,
  disabled = false,
}: {
  children: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="topic-switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
    >
      <span aria-hidden="true" />
      {children}
    </button>
  );
}
export function useTopicOperation(
  scope: string,
  onChanged: () => void,
  onBusy?: (busy: boolean) => void,
) {
  const [plan, setPlan] = useState<TopicOperationPlan | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<TopicOperationResult | null>(null);
  const read = useReadScope(scope);
  const epoch = useRef(0),
    inFlight = useRef(false),
    callbacks = useRef({ onChanged, onBusy });
  callbacks.current = { onChanged, onBusy };
  useEffect(() => {
    epoch.current++;
    inFlight.current = false;
    setBusy(false);
    setPlan(null);
    setError("");
    setResult(null);
    return () => {
      epoch.current++;
      callbacks.current.onBusy?.(false);
    };
  }, [scope]);
  function mark(value: boolean) {
    inFlight.current = value;
    setBusy(value);
    callbacks.current.onBusy?.(value);
  }
  async function prepare(request: TopicOperationRequest) {
    if (inFlight.current) return;
    const id = epoch.current;
    mark(true);
    setError("");
    setResult(null);
    try {
      const next = await read("prepareTopicOperation", request);
      if (id === epoch.current) setPlan(next);
    } catch (e) {
      if (id === epoch.current) setError(topicError(e));
    } finally {
      if (id === epoch.current) mark(false);
    }
  }
  async function execute(onSuccess?: () => void) {
    if (!plan || inFlight.current) return;
    const id = epoch.current;
    mark(true);
    setError("");
    try {
      const next = await window.goga.executeTopicOperation(plan.token);
      if (id !== epoch.current) return;
      setPlan(null);
      setResult(next);
      if (next.status === "success") onSuccess?.();
      callbacks.current.onChanged();
    } catch (e) {
      if (id === epoch.current) {
        setPlan(null);
        setError(topicError(e));
      }
    } finally {
      if (id === epoch.current) mark(false);
    }
  }
  return {
    plan,
    busy,
    error,
    result,
    prepare,
    execute,
    cancel: () => {
      if (!inFlight.current) setPlan(null);
    },
  };
}
export function TopicConfirmation({
  operation,
  onSuccess,
}: {
  operation: ReturnType<typeof useTopicOperation>;
  onSuccess?: () => void;
}) {
  const plan = operation.plan!;
  return (
    <section className="topic-confirm">
      <h3>{plan.title}</h3>
      <ul>
        {plan.details.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      <p className="hint">
        Подтверждение действует 5 минут. Перед выполнением повторно проверим
        состояние проекта.
      </p>
      <div className="form-actions">
        <button
          type="button"
          autoFocus
          disabled={operation.busy}
          onClick={operation.cancel}
        >
          Отмена
        </button>
        <button
          type="button"
          className={plan.action === "delete" ? "danger" : "primary"}
          disabled={operation.busy}
          onClick={() => void operation.execute(onSuccess)}
        >
          {operation.busy
            ? "Выполняем…"
            : plan.action === "delete"
              ? "Удалить без корзины"
              : "Подтвердить"}
        </button>
      </div>
    </section>
  );
}
export function TopicFeedback({
  operation,
}: {
  operation: ReturnType<typeof useTopicOperation>;
}) {
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (operation.error || operation.result)
      notice.current?.scrollIntoView?.({ block: "nearest" });
  }, [operation.error, operation.result]);
  if (!operation.error && !operation.result) return null;
  return (
    <div ref={notice} className="topic-feedback">
      {operation.error && (
        <p role="alert" className="error">
          {operation.error}
        </p>
      )}
      {operation.result && (
        <p
          role="status"
          className={
            operation.result.status === "success" ? "hint" : "topic-warning"
          }
        >
          {operation.result.message}
        </p>
      )}
    </div>
  );
}
