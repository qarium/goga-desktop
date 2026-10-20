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
        <h2 id={titleId}>
          {resetForm ? "Сбросить форму?" : "Перечитать задачу?"}
        </h2>
        <button
          type="button"
          className="quiet"
          aria-label="Закрыть подтверждение"
          onClick={onCancel}
        >
          ✕
        </button>
      </div>
      <p id={descriptionId}>
        {resetForm
          ? "Несохранённый текст и параметры запуска будут сброшены после успешной проверки каталога, задачи и состава стадий. Выбранные проект и существующий топик сохранятся. Отменить это действие нельзя."
          : "Несохранённые изменения будут сброшены после успешного чтения задачи. Отменить это действие нельзя."}
      </p>
      <div className="form-actions">
        <button ref={cancel} type="button" autoFocus onClick={onCancel}>
          Отмена
        </button>
        <button type="button" onClick={onConfirm}>
          {resetForm ? "Сбросить изменения" : "Перечитать и сбросить"}
        </button>
      </div>
    </dialog>
  );
}
