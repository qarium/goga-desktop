import { useEffect, useId, useRef } from "react";

export function TaskReloadConfirmation({
  onCancel,
  onConfirm,
  resetForm = false,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  resetForm?: boolean;
}) {
  return (
    <ReloadConfirmation
      title={resetForm ? "Сбросить форму?" : "Перечитать задачу?"}
      description={
        resetForm
          ? "Несохранённый текст и параметры запуска будут сброшены после успешной проверки каталога, задачи и состава стадий. Выбранные проект и существующий топик сохранятся. Отменить это действие нельзя."
          : "Несохранённые изменения будут сброшены после успешного чтения задачи. Отменить это действие нельзя."
      }
      confirmLabel={resetForm ? "Сбросить изменения" : "Перечитать и сбросить"}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function ReloadConfirmation({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="task-reload-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
    >
      <div className="section-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="quiet"
          aria-label="Закрыть подтверждение"
          onClick={onCancel}
        >
          ✕
        </button>
      </div>
      <p id={descriptionId}>{description}</p>
      <div className="form-actions">
        <button ref={cancel} type="button" autoFocus onClick={onCancel}>
          Отмена
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
