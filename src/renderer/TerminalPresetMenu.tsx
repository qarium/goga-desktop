import { useEffect, useState } from "react";
import { Settings2, SquareTerminal } from "lucide-react";
import type { TerminalPresetMenuItem } from "../shared/terminal-presets";
import { preparationErrorMessage } from "./preparation-error";

/** Mounted only inside the add menu. Never asks for commands or environment. */
export function TerminalPresetMenu({
  onLaunch,
  onSettings,
  disabled,
}: {
  onLaunch: (preset: TerminalPresetMenuItem) => void;
  onSettings: () => void;
  disabled: boolean;
}) {
  const read = window.goga?.terminalPresets;
  const [items, setItems] = useState<TerminalPresetMenuItem[]>(),
    [error, setError] = useState(""),
    [attempt, retry] = useState(0);
  useEffect(() => {
    if (!read) return;
    let current = true;
    setError("");
    setItems(undefined);
    read({ kind: "menu" }).then(
      (v) => {
        if (current) setItems(v);
      },
      (e) => {
        if (current) setError(preparationErrorMessage(e));
      },
    );
    return () => {
      current = false;
    };
  }, [read, attempt]);
  if (!read) return null;
  return (
    <>
      <div className="terminal-menu-divider" role="separator" />
      <div className="terminal-preset-menu-title">Пресеты</div>
      {error ? (
        <>
          <small className="terminal-preset-menu-note" role="alert">
            {error}
          </small>
          <button
            type="button"
            role="menuitem"
            onClick={() => retry((v) => v + 1)}
          >
            Повторить загрузку
          </button>
        </>
      ) : !items ? (
        <small className="terminal-preset-menu-note" role="status">
          Загружаем пресеты…
        </small>
      ) : !items.length ? (
        <small className="terminal-preset-menu-note">Пока нет пресетов</small>
      ) : (
        items.map((p) => (
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            key={p.id}
            onClick={() => onLaunch(p)}
          >
            <SquareTerminal size={16} aria-hidden="true" />
            <span>{p.name}</span>
          </button>
        ))
      )}
      <div className="terminal-menu-divider" role="separator" />
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onSettings}
      >
        <Settings2 size={16} aria-hidden="true" />
        Настроить пресеты…
      </button>
    </>
  );
}
