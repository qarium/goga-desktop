import { t } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import { useEffect, useId, useRef } from "react";

export function DemoConfirm({
  q,
  cancel,
  submit,
}: {
  q: {
    title: string;
    detail: string;
    submit: string;
    action: "stop" | "handoff" | "switch-port";
  };
  cancel: () => void;
  submit: () => void;
}) {
  useLocale();
  const ref = useRef<HTMLDialogElement>(null),
    title = useId(),
    description = useId();
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    el.querySelector<HTMLButtonElement>("button")?.focus();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      data-testid="demo-dialog"
      className="task-reload-dialog"
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <h2 id={title}>{q.title}</h2>
      <p id={description}>{q.detail}</p>
      <div className="form-actions">
        <button data-testid="demo-cancel" onClick={cancel}>{t("general.cancel")}</button>
        <button
          className={q.action === "stop" ? "danger" : "primary"}
          data-testid="demo-confirm"
          onClick={submit}
        >
          {q.submit}
        </button>
      </div>
    </dialog>
  );
}
