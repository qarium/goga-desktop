import { t } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
  useLocale();
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
      <div className="terminal-preset-menu-title">{t("general.presets")}</div>
      {error ? (
        <>
          <small className="terminal-preset-menu-note" role="alert">
            {error}
          </small>
          <button
            type="button"
            role="menuitem"
            onClick={() => retry((v) => v + 1)}
          >{t("general.retryLoading")}</button>
        </>
      ) : !items ? (
        <small className="terminal-preset-menu-note" role="status">{t("general.loadingPresets")}</small>
      ) : !items.length ? (
        <small className="terminal-preset-menu-note">{t("general.noPresetsYet2")}</small>
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
        <Settings2 size={16} aria-hidden="true" />{t("general.managePresets")}</button>
    </>
  );
}
