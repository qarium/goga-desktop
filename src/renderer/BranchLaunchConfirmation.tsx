import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
  useLocale();
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
          ? msg("workspace.createATopicInASeparateWorkingCopyAndLaunch")
          : msg("workspace.switchToBranchAndLaunch", { branch: String(branch) })}
      </h2>
      <div id={description}>
        <p>
          {creating ? msg("workspace.newBranch") : msg("workspace.selectedBranch")}:{" "}
          <strong>{branch}</strong>
        </p>
        <p>
          {creating ? msg("workspace.startingBranch") : msg("workspace.currentBranch")}:{" "}
          <strong>{from}</strong>
        </p>
        {saveTask && <p>{msg("workspace.theEditedTaskWillBeSavedBeforeLaunch")}</p>}
        {update && (
          <p>{msg("workspace.beforeLaunchingGogaWillUpdateTheImageByBuildingFrom")}</p>
        )}
        <p>
          {creating
            ? msg("workspace.aSeparateTopicWorkingCopyWillBeCreatedTheOriginal")
            : msg("workspace.afterConfirmationGogaWillPrepareTheBranchAndLaunchThe")}
        </p>
      </div>
      <div className="form-actions">
        <button type="button" ref={cancel} autoFocus onClick={onCancel}>{msg("workspace.cancel")}</button>
        <button type="button" className="primary" onClick={onConfirm}>
          {creating ? msg("workspace.createAndLaunch") : msg("workspace.switchAndLaunch")}
        </button>
      </div>
    </dialog>
  );
}
