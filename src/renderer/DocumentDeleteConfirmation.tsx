import { useViewActive } from "./RetainedViews";
import { useEffect, useId, useRef } from "react";
import type { DocumentDeletion } from "./settings-documents";
export function DocumentDeleteConfirmation({
  deletion,
  dirty,
  busy,
  onCancel,
  onConfirm,
}: {
  deletion: DocumentDeletion;
  dirty: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const active = useViewActive();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    if (!active) return;
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, [active]);
  return (
    <dialog
      ref={dialog}
      className="task-reload-dialog"
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={title}>
        {deletion.memoryOnly
          ? "Удалить черновик?"
          : "Переместить файл в корзину?"}
      </h2>
      <div id={description}>
        <p>{deletion.ticket.name}</p>
        <p className="context-path">{deletion.ticket.relativePath}</p>
        <p>
          {deletion.memoryOnly
            ? "Будет удалён только черновик в памяти. Файлы на диске не изменятся."
            : "В корзину будет перемещена сохранённая версия файла."}
        </p>
        {!deletion.memoryOnly && deletion.ticket.profileFallback && (
          <p className="hint">
            После удаления снова будет применяться одноимённый глобальный
            (личный) профиль. Его содержимое не изменится.
          </p>
        )}
        {dirty && (
          <p className="hint">Несохранённые изменения будут потеряны.</p>
        )}
      </div>
      <div className="form-actions">
        <button
          ref={cancel}
          autoFocus
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Отмена
        </button>
        <button
          className="danger"
          data-confirm-delete
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy
            ? "Перемещаем…"
            : deletion.memoryOnly
              ? "Удалить черновик"
              : "Переместить в корзину"}
        </button>
      </div>
    </dialog>
  );
}
