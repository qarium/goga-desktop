import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Cable,
  Copy,
  Check,
  ExternalLink,
  Link,
  Maximize2,
  Minimize2,
  RefreshCw,
  Settings,
  UserRoundPlus,
} from "lucide-react";
import type { DemoCommand } from "../../shared/demonstrations";
import { DemoFrame } from "./DemoFrame";
import { DemoConfirm } from "./DemoConfirm";
import { DemoTabs } from "./DemoTabs";
import { demoError, type DemoDirectory, useDemoValue } from "./directory";
import "./Demonstration.css";

type Transfer = Extract<DemoCommand, { action: "handoff" | "switch-port" }>;
type Question = {
  cmd: Transfer;
  title: string;
  detail: string;
  submit: string;
  action: "handoff" | "switch-port";
};
function isCurrent(store: DemoDirectory, cmd: Transfer) {
  const s = store.state;
  if (!s || store.error || !s.shows.some((v) => v.showId === cmd.showId))
    return false;
  return cmd.action === "handoff"
    ? s.access.owner === cmd.showId &&
        s.access.phase === "connected" &&
        s.access.connectionId === cmd.connectionId
    : s.access.owner === cmd.fromShowId && s.access.owner !== cmd.showId;
}
function PageAddress({
  value,
  busy,
  go,
  copy,
  copyAvailable,
  onCopyError,
}: {
  value: string | null;
  busy: boolean;
  go: (url: string) => Promise<void>;
  copy: () => Promise<void>;
  copyAvailable: boolean;
  onCopyError: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    input = useRef<HTMLInputElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    id = useId(),
    flight = useRef(false),
    [copying, setCopying] = useState(false),
    [copied, setCopied] = useState(false),
    copyFlight = useRef(false),
    copyAlive = useRef(false),
    copyGeneration = useRef(0),
    copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    copyAlive.current = true;
    return () => {
      copyAlive.current = false;
    };
  }, []);
  useEffect(() => {
    ++copyGeneration.current;
    setCopied(false);
    return () => {
      ++copyGeneration.current;
      clearTimeout(copyTimer.current);
    };
  }, [value]);
  async function copyAddress() {
    if (busy || !value || !copyAvailable || copyFlight.current) return;
    const generation = copyGeneration.current;
    copyFlight.current = true;
    setCopying(true);
    setCopied(false);
    clearTimeout(copyTimer.current);
    onCopyError(null);
    try {
      await copy();
      if (generation !== copyGeneration.current) return;
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      if (generation === copyGeneration.current) onCopyError(error);
    } finally {
      copyFlight.current = false;
      if (copyAlive.current) setCopying(false);
    }
  }
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  // A draft is local to this input/show/tab. With no draft, render the host URL
  // directly: there is no second "last known URL" to go stale on Escape.
  async function submit(url: string) {
    if (busy || flight.current) return;
    flight.current = true;
    try {
      await go(url.trim());
    } finally {
      flight.current = false;
      setDraft(null);
      setOpen(false);
    }
  }
  return (
    <div className={"demo-page-address" + (open ? " is-open" : "")}>
      <button
        ref={toggle}
        type="button"
        className="demo-tool demo-address-open"
        aria-label="Показать адрес страницы"
        title="Показать адрес страницы"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <Link size={14} aria-hidden />
      </button>
      <div className="demo-address-field" id={id}>
        <input
          ref={input}
          type="text"
          inputMode="url"
          className="demo-page-url"
          data-testid="demo-url"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          aria-label="Адрес страницы"
          title="Адрес страницы. Enter — перейти, Escape — отменить ввод."
          placeholder="Введите http:// или https://"
          value={draft ?? value ?? ""}
          readOnly={busy}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape" && (draft !== null || open)) {
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
              setOpen(false);
              if (open) toggle.current?.focus();
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(e.currentTarget.value);
            }
          }}
        />
        <span className="demo-address-copy">
          <button
            type="button"
            className="demo-tool"
            aria-label="Скопировать адрес страницы"
            title={copied ? "Скопировано" : "Скопировать адрес страницы"}
            disabled={busy || copying || !value || !copyAvailable}
            aria-busy={copying}
            onClick={() => void copyAddress()}
          >
            {copied ? (
              <Check size={14} aria-hidden />
            ) : (
              <Copy size={14} aria-hidden />
            )}
          </button>
          <span className="demo-copy-feedback" role="status">
            {copied ? "Скопировано" : ""}
          </span>
        </span>
      </div>
    </div>
  );
}
function Expanded({
  children,
  close,
  id,
}: {
  children: ReactNode;
  close: () => void;
  id: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      className="demo-full"
      id={id}
      ref={ref}
      aria-label="Развёрнутый показ"
      data-testid="demo-expanded"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {children}
    </dialog>
  );
}

export function DemoPanel({
  store,
  showId,
  onSettings,
}: {
  store: DemoDirectory;
  showId: string;
  onSettings: () => void;
}) {
  const snap = useDemoValue(store, () => store.state),
    failure = useDemoValue(store, () => store.error);
  const [q, setQ] = useState<Question | null>(null),
    [expanded, setExpanded] = useState(false),
    [busy, setBusy] = useState(""),
    [notice, notify] = useState({ text: "", bad: false });
  const alive = useRef(false),
    inFlight = useRef(false),
    expandedId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const show = snap?.shows.find((s) => s.showId === showId),
    owned = snap?.access.owner === showId,
    phase = owned ? snap!.access.phase : "off";
  const owner = snap?.shows.find((s) => s.showId === snap.access.owner);
  useEffect(() => {
    if (q && !isCurrent(store, q.cmd)) setQ(null);
  }, [snap, failure, q, store]);
  async function act(cmd: DemoCommand | { action: "browser"; showId: string }) {
    if (
      !alive.current ||
      inFlight.current ||
      store.error ||
      !store.state?.shows.some((s) => s.showId === showId)
    )
      return;
    if (
      (cmd.action === "tab-select" || cmd.action === "tab-close") &&
      !store.state?.shows
        .find((s) => s.showId === showId)
        ?.tabs?.some((tab) => tab.tabId === cmd.tabId)
    )
      return;
    if (
      (cmd.action === "handoff" || cmd.action === "switch-port") &&
      !isCurrent(store, cmd)
    ) {
      setQ(null);
      return;
    }
    inFlight.current = true;
    setBusy(cmd.action);
    setQ(null);
    notify({ text: "", bad: false });
    try {
      if (cmd.action === "browser") await store.bridge.demoOpenBrowser(showId);
      else await store.execute(cmd);
      if (alive.current)
        notify({
          text:
            cmd.action === "browser"
              ? "Показ открыт в основном браузере."
              : cmd.action === "reload"
                ? "Страница обновлена."
                : "",
          bad: false,
        });
    } catch (e) {
      if (alive.current) notify({ text: demoError(e), bad: true });
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy("");
    }
  }
  if (!show || !snap) return null;
  const disabled = !!busy || !!failure;
  const status =
    phase === "connected"
      ? "Агент подключён"
      : phase === "connecting"
        ? "Агент подключается…"
        : phase === "waiting"
          ? "Ожидаем агента"
          : owner
            ? "Порт привязан к показу «" + owner.label + "»"
            : "Порт не привязан";
  const shortStatus =
    phase === "connected"
      ? "Агент"
      : phase === "connecting"
        ? "Подключение"
        : phase === "waiting"
          ? "Ожидание"
          : owner
            ? "Другой показ"
            : "Свободен";
  const info = (
    <div className="demo-connection-info">
      <span
        className="demo-access"
        role="status"
        data-phase={phase}
        aria-live="polite"
        aria-label={status}
        title={status}
      >
        <i
          aria-hidden
          className={
            "status-dot " +
            (phase === "connected" ? "running" : owned ? "starting" : "")
          }
        />
        <span className="demo-access-label" aria-hidden>
          {shortStatus}
        </span>
      </span>
    </div>
  );
  function switchPort() {
    if (!show || !snap || owned) return;
    const cmd = {
      action: "switch-port" as const,
      showId,
      fromShowId: snap.access.owner,
    };
    if (!cmd.fromShowId) {
      void act(cmd);
      return;
    }
    if (owner)
      setQ({
        cmd,
        action: cmd.action,
        title: "Переключить порт на этот показ?",
        detail:
          "Порт " +
          snap.port +
          " перейдёт от показа «" +
          owner.label +
          "» к показу «" +
          show.label +
          "». Агент прежнего показа отключится. Обе страницы останутся открытыми.",
        submit: "Переключить порт",
      });
  }
  const location = (
    <PageAddress
      key={JSON.stringify([showId, show.activeTabId ?? null])}
      value={show.url}
      busy={disabled}
      copyAvailable={
        !!show.activeTabId && typeof store.bridge.demoCopyURL === "function"
      }
      copy={() => store.bridge.demoCopyURL(showId, show.activeTabId!)}
      onCopyError={(error) =>
        notify(
          error === null
            ? { text: "", bad: false }
            : { text: demoError(error), bad: true },
        )
      }
      go={(url) => act({ action: "navigate", showId, url })}
    />
  );
  const tabs = (
    <DemoTabs
      key={showId}
      tabs={show.tabs ?? []}
      activeTabId={show.activeTabId}
      disabled={disabled}
      select={(tabId) => void act({ action: "tab-select", showId, tabId })}
      close={(tabId) => void act({ action: "tab-close", showId, tabId })}
      create={() => void act({ action: "tab-create", showId })}
    />
  );
  const frame = (
    <DemoFrame
      showId={showId}
      tabId={show.activeTabId}
      disabled={disabled}
      onError={(text) => notify({ text, bad: true })}
    />
  );
  const toolbar = (
    <header className="demo-bar" role="toolbar" aria-label="Управление показом">
      {info}
      {tabs}
      {location}
      <div className="demo-actions">
        <button
          className="demo-tool"
          aria-label="Обновить страницу"
          title="Обновить страницу. Несохранённый ввод может быть потерян."
          disabled={disabled}
          onClick={() => void act({ action: "reload", showId })}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
        {!owned && (
          <button
            className="demo-tool"
            aria-label={
              owner ? "Переключить порт сюда" : "Подключить порт к этому показу"
            }
            title={
              owner ? "Переключить порт сюда" : "Подключить порт к этому показу"
            }
            disabled={disabled || (!!snap.access.owner && !owner)}
            onClick={switchPort}
          >
            <Cable size={14} aria-hidden />
          </button>
        )}
        {phase === "connected" && (
          <button
            className="demo-tool"
            aria-label="Передать управление"
            title="Передать управление"
            disabled={disabled || !snap.access.connectionId}
            onClick={() => {
              if (snap.access.connectionId)
                setQ({
                  cmd: {
                    action: "handoff",
                    showId,
                    connectionId: snap.access.connectionId,
                  },
                  action: "handoff",
                  title: "Передать управление другому агенту?",
                  detail:
                    "Текущий агент отключится. Следующий клиент на этом порту получит управление автоматически. Страница останется открытой.",
                  submit: "Отключить и ждать нового",
                });
            }}
          >
            <UserRoundPlus size={14} aria-hidden />
          </button>
        )}
        <button
          className="demo-tool"
          data-testid={expanded ? "demo-collapse" : undefined}
          aria-label={expanded ? "Свернуть показ" : "Развернуть показ"}
          title={expanded ? "Свернуть показ" : "Развернуть показ"}
          aria-expanded={expanded}
          aria-controls="cdp-demo-section"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <Minimize2 size={14} aria-hidden />
          ) : (
            <Maximize2 size={14} aria-hidden />
          )}
        </button>
      </div>
    </header>
  );
  const feedback = (
    <span
      role={failure || notice.bad ? "alert" : "status"}
      data-error={!!failure || notice.bad}
    >
      {failure ||
        notice.text ||
        (busy === "navigate"
          ? "Переходим по адресу…"
          : !owned
            ? owner
              ? "Порт привязан к показу «" +
                owner.label +
                "». Этой страницей можно управлять вручную."
              : "Порт свободен. Подключите его для управления агентом."
            : phase === "waiting"
              ? "Первый клиент на этом порту автоматически получит управление."
              : "Выделяйте текст мышью; ⌘C/Ctrl+C — копировать. Shift+Tab — к управлению.")}
    </span>
  );
  const content = (
    <>
      {toolbar}
      {frame}
      <footer className="demo-foot demo-foot-controls">
        {feedback}
        <div className="demo-utils">
          <button
            className="demo-action"
            onClick={() => {
              setExpanded(false);
              onSettings();
            }}
          >
            <Settings size={14} aria-hidden /> Настройки порта
          </button>
          <button
            className="demo-action"
            disabled={disabled}
            onClick={() => void act({ action: "browser", showId })}
          >
            <ExternalLink size={14} aria-hidden /> Открыть в браузере
          </button>
        </div>
      </footer>
    </>
  );
  return (
    <section
      className="demo-workspace"
      role="tabpanel"
      id="cdp-demo-section"
      aria-labelledby="cdp-demo-tab"
    >
      {expanded ? (
        <Expanded id={expandedId} close={() => setExpanded(false)}>
          {content}
        </Expanded>
      ) : (
        content
      )}
      {q && isCurrent(store, q.cmd) && (
        <DemoConfirm
          q={q}
          cancel={() => setQ(null)}
          submit={() => void act(q.cmd)}
        />
      )}
    </section>
  );
}
