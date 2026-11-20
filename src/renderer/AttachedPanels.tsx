import { HintButton } from "./ActionHint";
import { PopupClose } from "./PopupClose";
import { t as msg, getLocale } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { RunActionButton } from "./RunActionButton";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Cable, RefreshCw, X } from "lucide-react";
import type { AttachedDashboard } from "../shared/attached-dashboard";
import type { ScopeRef } from "../shared/context";
import { preparationErrorMessage } from "./preparation-error";

export function useAttachedPanels() {
  const [panels, setPanels] = useState<AttachedDashboard[]>([]);
  useEffect(() => {
    const api = window.goga;
    if (!api.listAttachedDashboards) return;
    let alive = true,
      received = false;
    const off = api.onAttachedDashboards?.((rows) => {
      received = true;
      if (alive) setPanels(rows);
    });
    void api
      .listAttachedDashboards()
      .then((rows) => {
        if (alive && !received) setPanels(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return panels;
}
type AttachedResult =
  | { kind: "managed"; id: string }
  | { kind: "attached"; panel: AttachedDashboard };
export function AttachPanelDialog({
  scope,
  ownerLabel,
  onClose,
  onOpen,
}: {
  scope: ScopeRef;
  ownerLabel: string;
  onClose: () => void;
  onOpen: (result: AttachedResult) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null),
    field = useRef<HTMLInputElement>(null),
    pending = useRef<string | null>(null);
  const [url, setURL] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useLayoutEffect(() => {
    const d = dialog.current!;
    d.showModal();
    field.current?.focus();
    return () => {
      d.close();
      const key = pending.current;
      pending.current = null;
      if (key) void window.goga.cancelDashboardAttach?.(key).catch(() => {});
    };
  }, []);
  async function submit() {
    if (!url.trim() || pending.current || !window.goga.attachDashboard) return;
    const key = crypto.randomUUID();
    pending.current = key;
    setBusy(true);
    setError("");
    try {
      const r = await window.goga.attachDashboard(scope, url, key);
      if (pending.current !== key) return;
      pending.current = null;
      onOpen(r);
    } catch (e) {
      if (pending.current === key) {
        setBusy(false);
        setError(preparationErrorMessage(e));
        pending.current = null;
        requestAnimationFrame(() => field.current?.focus());
      }
    }
  }
  return (
    <dialog
      className="attach-panel-dialog"
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="attach-panel-title"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header>
          <Cable size={22} />
          <PopupClose label={msg("workspace.close")} onClick={onClose} />
        </header>
        <h2 id="attach-panel-title">{msg("workspace.attachPipeline")}</h2>
        <p>{msg("workspace.pasteTheURLAfter")}<code>dashboard:</code>{msg("workspace.fromTheRunningPipelineSOutputThePortMustBe")}</p>
        <label>{msg("workspace.panelURL")}<input
            ref={field}
            value={url}
            maxLength={160}
            autoComplete="off"
            spellCheck={false}
            placeholder="http://localhost:52456"
            disabled={busy}
            onChange={(e) => setURL(e.currentTarget.value)}
          />
        </label>
        <p className="hint">{msg("workspace.thePanelWillAppearHere")}{ownerLabel}{msg("workspace.attachingDoesNotGrantControlOverTheProcessClosingThe")}</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>{msg("workspace.cancel")}</button>
          <button className="primary" disabled={busy || !url.trim()}>
            {busy ? msg("workspace.connecting") : msg("workspace.connect")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
export function AttachedPanelCard({
  row,
  onOpen,
  label,
  error,
  onDetach,
}: {
  row: AttachedDashboard;
  onOpen: () => void;
  label?: string;
  error?: string;
  onDetach?: () => void;
}) {
  useLocale();
  const status =
    row.status &&
    (
      {
        running: msg("workspace.running"),
        finished: msg("workspace.completed"),
        failed: msg("workspace.failed"),
        interrupted: msg("workspace.interrupted"),
        paused: msg("workspace.paused"),
      } as Record<string, string>
    )[row.status];
  return (
    <article className="context-run-row" data-attached-panel={row.id}>
      <div className="context-run-main">
        <div className="context-run-identity">
          <small>
            <Cable size={13} />{msg("workspace.attachedViaURL")}{label && " · " + label}
          </small>
          <strong>{row.name}</strong>
          {row.description && (
            <p className="context-run-description">{row.description}</p>
          )}
          {row.startedAt && (
            <time dateTime={row.startedAt}>{msg("workspace.started")}{new Date(row.startedAt).toLocaleString(getLocale())}
            </time>
          )}
        </div>
        <div className="context-run-actions">
          <span
            className="context-run-status"
            title={msg("workspace.panelStatusAtLastCheck")}
          >
            {error ? msg("workspace.panelUnavailable") : status || msg("workspace.connected")}
          </span>
          <button onClick={onOpen} aria-label={msg("workspace.openPanel", { name: String(row.name) })}>{msg("workspace.openPanel2")}</button>
          {onDetach && (
            <HintButton
              hint={msg("workspace.disconnectPanelWithoutStoppingTheProcess")}
              aria-label={msg("workspace.disconnectPanel", { name: String(row.name) })}
              onClick={onDetach}
            >
              <X size={14} />
            </HintButton>
          )}
        </div>
      </div>
    </article>
  );
}
export function PanelRefreshButton({
  busy,
  onClick,
}: {
  busy: boolean;
  onClick: () => void;
}) {
  useLocale();
  return (
    <RunActionButton
      className="dashboard-refresh-button"
      aria-busy={busy}
      disabled={busy}
      label={msg("workspace.refreshPanel")}
      title={msg("workspace.refreshThePanelF5RCtrlRWithoutRestartingThe")}
      onClick={onClick}
    >
      <RefreshCw size={15} aria-hidden="true" />
    </RunActionButton>
  );
}
