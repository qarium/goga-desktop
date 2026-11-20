import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
  useLocale();
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
          ? msg("project.deleteDraft")
          : msg("project.moveFileToTrash")}
      </h2>
      <div id={description}>
        <p>{deletion.ticket.name}</p>
        <p className="context-path">{deletion.ticket.relativePath}</p>
        <p>
          {deletion.memoryOnly
            ? msg("project.onlyTheInMemoryDraftWillBeDeletedFilesOn")
            : msg("project.theSavedVersionOfTheFileWillBeMovedTo")}
        </p>
        {!deletion.memoryOnly && deletion.ticket.profileFallback && (
          <p className="hint">{msg("project.theGlobalPersonalProfileWithTheSameNameWillApply")}</p>
        )}
        {dirty && (
          <p className="hint">{msg("project.unsavedChangesWillBeLost")}</p>
        )}
      </div>
      <div className="form-actions">
        <button
          ref={cancel}
          autoFocus
          type="button"
          disabled={busy}
          onClick={onCancel}
        >{msg("project.cancel")}</button>
        <button
          className="danger"
          data-confirm-delete
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy
            ? msg("project.moving")
            : deletion.memoryOnly
              ? msg("project.deleteDraft2")
              : msg("project.moveToTrash")}
        </button>
      </div>
    </dialog>
  );
}
