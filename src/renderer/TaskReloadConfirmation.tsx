import { PopupClose } from "./PopupClose";
import { t } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
  useLocale();
  return (
    <ReloadConfirmation
      title={resetForm ? t("general.resetForm") : t("general.reloadTask")}
      description={
        resetForm
          ? t("general.unsavedTextAndLaunchOptionsWillBeResetAfter")
          : t("general.unsavedEditsWillBeDiscardedAfterTheTaskHas")
      }
      destructive
      confirmLabel={resetForm ? t("general.resetChanges") : t("general.reloadAndDiscard")}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function ReloadConfirmation({
  title,
  description,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useLocale();
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
        <PopupClose label={t("general.closeConfirmation")} onClick={onCancel} />
      </div>
      <p id={descriptionId}>{description}</p>
      <div className="form-actions">
        <button ref={cancel} type="button" autoFocus onClick={onCancel}>{t("general.cancel")}</button>
        <button type="button" className={destructive ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
