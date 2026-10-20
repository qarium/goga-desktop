import { useEffect, useId, useRef } from "react";
export function BranchLaunchConfirmation({
  creating,
  branch,
  from,
  update,
  saveTask,
  onCancel,
  onConfirm,
}: {
  creating: boolean;
  branch: string;
  from: string;
  update: boolean;
  saveTask: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const title = useId(),
    description = useId();
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    cancel.current?.focus();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="task-reload-dialog branch-launch-dialog"
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id={title}>
        {creating
          ? "Создать ветку и запустить конвейер?"
          : `Переключиться на ветку «${branch}» и запустить?`}
      </h2>
      <div id={description}>
        <p>
          {creating ? "Новая ветка" : "Выбранная ветка"}:{" "}
          <strong>{branch}</strong>
        </p>
        <p>
          {creating ? "Исходная ветка" : "Текущая ветка"}:{" "}
          <strong>{from}</strong>
        </p>
        {saveTask && <p>Изменённая задача будет сохранена перед запуском.</p>}
        {update && (
          <p>
            Перед запуском Goga обновит образ: выполнит сборку из настроенного
            Dockerfile либо загрузку образа по своей конфигурации.
          </p>
        )}
        <p>После подтверждения Goga подготовит ветку и запустит конвейер.</p>
      </div>
      <div className="form-actions">
        <button type="button" ref={cancel} autoFocus onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          {creating ? "Создать и запустить" : "Переключиться и запустить"}
        </button>
      </div>
    </dialog>
  );
}
