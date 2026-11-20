import { PopupClose } from "./PopupClose";
import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useId, useRef, useState } from "react";

export function DocumentRenameDialog({
  original,
  suffix,
  rename,
  onClose,
}: {
  original: string;
  suffix: string;
  rename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(original),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const locked = useRef(false),
    title = useId(),
    hint = useId();
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    input.current?.focus();
    // In a tool filename select only the stem; the extension remains editable.
    input.current?.setSelectionRange(
      0,
      !suffix && original.lastIndexOf(".") > 0
        ? original.lastIndexOf(".")
        : original.length,
    );
    return () => node.close();
  }, []);
  const close = () => {
    if (!locked.current) onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="task-reload-dialog document-rename-dialog"
      aria-labelledby={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (locked.current || !name || name === original) return;
          locked.current = true;
          setBusy(true);
          setError("");
          try {
            await rename(name);
            onClose();
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
          } finally {
            locked.current = false;
            setBusy(false);
          }
        }}
      >
        <div className="document-rename-heading">
          <h2 id={title}>{msg("project.renameFile")}</h2>
          <PopupClose label={msg("project.closeRenameDialog")} onClick={close} disabled={busy} />
        </div>
        <label>{msg("project.newName")}<span className="document-rename-name">
            <input
              ref={input}
              value={name}
              disabled={busy}
              aria-label={msg("project.newName")}
              aria-describedby={hint}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
            />
            {suffix && <code>{suffix}</code>}
          </span>
        </label>
        <p id={hint} className="hint">{msg("project.fileContentsWillNotChangeUpdateReferencesToTheOld")}</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={close} disabled={busy}>{msg("project.cancel")}</button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !name || name === original}
          >
            {busy ? msg("project.renaming") : msg("project.rename")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
