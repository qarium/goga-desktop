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
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <h2 id="attach-panel-title">Подключить конвейер</h2>
        <p>
          Вставьте адрес после <code>dashboard:</code> из вывода работающего
          конвейера. Порт должен быть доступен с этого компьютера.
        </p>
        <label>
          Адрес панели
          <input
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
        <p className="hint">
          Панель появится здесь: {ownerLabel}. Подключение не передаёт
          управление процессом; закрытие вкладки его не остановит.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" disabled={busy || !url.trim()}>
            {busy ? "Подключаем…" : "Подключить"}
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
  const status =
    row.status &&
    (
      {
        running: "Выполняется",
        finished: "Завершён",
        failed: "Ошибка",
        interrupted: "Прерван",
        paused: "Приостановлен",
      } as Record<string, string>
    )[row.status];
  return (
    <article className="context-run-row" data-attached-panel={row.id}>
      <div className="context-run-main">
        <div className="context-run-identity">
          <small>
            <Cable size={13} /> Подключён по URL{label && " · " + label}
          </small>
          <strong>{row.name}</strong>
          {row.description && (
            <p className="context-run-description">{row.description}</p>
          )}
          {row.startedAt && (
            <time dateTime={row.startedAt}>
              Старт: {new Date(row.startedAt).toLocaleString("ru-RU")}
            </time>
          )}
        </div>
        <div className="context-run-actions">
          <span
            className="context-run-status"
            title="Состояние при последней проверке панели"
          >
            {error ? "Панель недоступна" : status || "Подключено"}
          </span>
          <button onClick={onOpen} aria-label={`Открыть панель ${row.name}`}>
            Открыть панель →
          </button>
          {onDetach && (
            <button
              title="Отключить панель, не останавливая процесс"
              aria-label={`Отключить панель ${row.name}`}
              onClick={onDetach}
            >
              <X size={14} />
            </button>
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
  return (
    <button
      type="button"
      className="dashboard-refresh-button"
      aria-busy={busy}
      disabled={busy}
      aria-label="Обновить страницу панели"
      title="Обновить страницу панели (F5 / ⌘R / Ctrl+R), не перезапуская конвейер"
      onClick={onClick}
    >
      <RefreshCw size={15} />
    </button>
  );
}
