import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import "./TopicsBoard.css";
import "./WorkspaceLeaveDialog.css";

type Props = {
  files: readonly string[];
  launching?: boolean;
  busy?: boolean;
  failure?: { path: string; message: string };
  onStay: () => void;
  onKeep: () => void;
  onSave: (remember: boolean) => void;
  onReveal?: () => void;
};

function fileCount(n: number) {
  const category = new Intl.PluralRules("ru").select(n);
  return (
    n +
    " " +
    (category === "one" ? "файл" : category === "few" ? "файла" : "файлов")
  );
}

export function WorkspaceLeaveDialog({
  files,
  launching,
  busy,
  failure,
  onStay,
  onKeep,
  onSave,
  onReveal,
}: Props) {
  const node = useRef<HTMLDialogElement>(null),
    safe = useRef<HTMLButtonElement>(null);
  const title = useId(),
    description = useId(),
    fileList = useId();
  const [expanded, setExpanded] = useState(false),
    [remember, setRemember] = useState(false);
  useLayoutEffect(() => {
    const el = node.current!,
      previous = document.activeElement;
    if (el.showModal) el.showModal();
    else el.open = true;
    safe.current?.focus();
    return () => {
      el.close?.();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest("[inert],[hidden]")
      )
        previous.focus();
    };
  }, []);
  useEffect(() => {
    if (failure) safe.current?.focus();
  }, [failure]);
  const paths = failure ? (failure.path ? [failure.path] : []) : files;
  return (
    <dialog
      ref={node}
      aria-modal="true"
      className="task-reload-dialog workspace-leave-dialog"
      aria-labelledby={title}
      aria-describedby={description}
      onKeyDown={(e) => {
        // Escape belongs to the dialog, not to a retained expanded editor.
        // Leave its native default action (cancel) intact.
        if (e.key === "Escape") e.stopPropagation();
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onStay();
      }}
    >
      <div className="workspace-leave-content">
        <h2 id={title}>
          {failure ? "Переход приостановлен" : "Сохранить правки?"}
        </h2>
        {!failure && launching && (
          <p>При запуске конвейер прочитает сохранённые версии файлов.</p>
        )}
        <div className="workspace-leave-files">
          {paths.length > 1 && (
            <p className="hint">{fileCount(paths.length)} с правками</p>
          )}
          <ul
            hidden={!paths.length}
            id={fileList}
            aria-label="Файлы с правками"
          >
            {(expanded ? paths : paths.slice(0, 3)).map((path, i) => {
              const pos = path.lastIndexOf("/") + 1;
              return (
                <li key={i}>
                  <FileText size={14} aria-hidden="true" />
                  <span>
                    <span>{path.slice(0, pos)}</span>
                    <strong>{path.slice(pos)}</strong>
                  </span>
                </li>
              );
            })}
          </ul>
          {paths.length > 3 && (
            <button
              className="workspace-leave-more"
              type="button"
              aria-expanded={expanded}
              aria-controls={fileList}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded
                ? "Свернуть список"
                : "Ещё " + fileCount(paths.length - 3)}
            </button>
          )}
        </div>
        {failure ? (
          <p id={description} role="alert" className="error">
            {failure.message}
          </p>
        ) : (
          <>
            <p id={description} className="hint">
              {remember
                ? "Автосохранение включится после «Сохранить и продолжить»."
                : "Без сохранения правки останутся в редакторе."}
            </p>
            <label className="workspace-leave-remember">
              <input
                type="checkbox"
                className="desktop-compact-checkbox"
                checked={remember}
                disabled={busy}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Больше не спрашивать и сохранять автоматически
            </label>
          </>
        )}
        <footer className="workspace-leave-actions">
          {failure ? (
            <button
              type="button"
              className="primary"
              ref={safe}
              onClick={failure.path && onReveal ? onReveal : onStay}
            >
              {onReveal && failure.path ? "К файлу" : "Остаться"}
            </button>
          ) : (
            <>
              <button
                ref={safe}
                className="quiet"
                type="button"
                disabled={busy}
                onClick={onStay}
              >
                Остаться
              </button>
              <button type="button" disabled={busy} onClick={onKeep}>
                Без сохранения
              </button>
              <button
                type="button"
                disabled={busy}
                className="primary"
                onClick={() => onSave(remember)}
              >
                {busy ? "Сохраняем…" : "Сохранить и продолжить"}
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}
