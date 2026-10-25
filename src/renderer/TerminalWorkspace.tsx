import { flushSync } from "react-dom";
import { LoadingState } from "./LoadingBoundary";
import { useViewActive } from "./RetainedViews";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScopeRef } from "../shared/context";
import {
  TERMINAL_SELECTION_STALE,
  type TerminalCatalogChange,
} from "../shared/terminal-catalog";
import { terminalContextKey, type TerminalTab } from "../shared/terminal";
import type {
  TerminalAPI,
  TerminalConfirmation,
  TerminalSessionInfo,
  TerminalWorkspaceSnapshot,
} from "../shared/terminal-control";
import { TerminalSurface } from "./TerminalSurface";
import "./TerminalWorkspace.css";
import { TerminalTabs, terminalArea } from "./TerminalTabs";
import "./ProjectContent.css";
// Presentation-only cache. Every native show and background open remains host-authorized.
// It contains no screen output or process ownership, and disappears on UI reload.
const workspaceCache = new WeakMap<
  TerminalAPI,
  Map<
    string,
    { state: TerminalWorkspaceSnapshot; session?: TerminalSessionInfo }
  >
>();
const ownerKey = (scope: ScopeRef) => {
  if (typeof scope === "string")
    return terminalContextKey({ kind: "primary", projectId: scope });
  const { revision: _, ...identity } = scope;
  return terminalContextKey({ kind: "topic", ...identity });
};
interface Props {
  api: TerminalAPI;
  scope: ScopeRef;
  blocked?: string;
  obscured?: boolean;
  suspendOpen?: boolean;
}
type PendingConfirmation = TerminalConfirmation & { closingTabId?: string };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Операция терминала не выполнена.";
export function TerminalWorkspace(props: Props) {
  const scope = useMemo(() => props.scope, [JSON.stringify(props.scope)]);
  if (props.blocked)
    return (
      <section className="terminal-workspace project-content">
        <p role="alert">{props.blocked}</p>
      </section>
    );
  return <Workspace key={ownerKey(scope)} {...props} scope={scope} />;
}
function Workspace({ api, scope, obscured, suspendOpen }: Props) {
  const viewActive = useViewActive();
  const activeRef = useRef(viewActive);
  activeRef.current = viewActive;
  const needsRead = useRef(false);
  // Ensure a visible tab only on entry, never on close/metadata notifications.
  const ensureOnEntry = useRef(true);
  const wasActive = useRef(viewActive);
  const metadataRead = useRef<Promise<void> | undefined>(undefined);
  const metadataFailed = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const cacheKey = ownerKey(scope);
  const saved = workspaceCache.get(api)?.get(cacheKey);
  const [state, setState] = useState<TerminalWorkspaceSnapshot | undefined>(
    saved?.state,
  );
  const [openedSession, setSession] = useState<TerminalSessionInfo | undefined>(
    saved?.session,
  );
  const [enteringEmpty, setEnteringEmpty] = useState(!saved?.state.tabs.length);
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState("");
  const [presentationFailed, setPresentationFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [closingTabId, setClosingTabId] = useState<string>();
  const closingTarget = useRef<string | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();
  const live = useRef(true),
    reload = useRef<() => Promise<void>>(async () => {});
  const flight = useRef(false),
    ticket = useRef<TerminalConfirmation | undefined>(undefined);
  const [optimisticId, setOptimisticId] = useState<string | null>(null);
  const snapshot = useRef(state);
  const queuedSelection = useRef<string | null>(null);
  const selectionTask = useRef<Promise<boolean> | null>(null);
  const selectedId = optimisticId ?? state?.selectedId;
  const closingSelected =
    closingTabId !== undefined && closingTabId === selectedId;
  const selected = state?.tabs.find((tab) => tab.id === selectedId);
  const session =
    state?.sessions.find((s) => s.tabId === selectedId) ??
    (openedSession?.tabId === selectedId ? openedSession : undefined);
  useEffect(() => {
    // A failed screen cannot poison another tab or a refreshed generation.
    // Metadata revision changes alone deliberately do not reset a real failure.
    if (presentationFailed) {
      setPresentationFailed(false);
      setError("");
    }
  }, [session?.sessionId, session?.generation]);
  useEffect(() => {
    if (!state) return;
    let cache = workspaceCache.get(api);
    if (!cache) workspaceCache.set(api, (cache = new Map()));
    cache.delete(cacheKey);
    cache.set(cacheKey, {
      state,
      session: session?.tabId === state.selectedId ? session : undefined,
    });
    while (cache.size > 32) cache.delete(cache.keys().next().value!);
  }, [api, cacheKey, state, session]);

  useEffect(() => {
    live.current = true;
    let effectCurrent = true;
    let reading: Promise<void> | undefined,
      again = false;
    const read = (): Promise<void> => {
      if (reading) {
        again = true;
        return reading;
      }
      setRefreshing(true);
      const task = async () => {
        do {
          again = false;
          needsRead.current = false;
          try {
            let next = await api.request({ kind: "read", scope });
            if (!effectCurrent || !live.current) return;
            const ensure = activeRef.current && ensureOnEntry.current;
            if (ensure) ensureOnEntry.current = false;
            if (ensure && next.tabs.length === 0) {
              await api.request({
                kind: "initialize",
                scope,
                revision: next.revision,
              });
              if (!effectCurrent || !live.current) return;
              next = await api.request({ kind: "read", scope });
            }
            if (!effectCurrent || !live.current) return;
            if (metadataFailed.current) setError("");
            metadataFailed.current = false;
            snapshot.current = next;
            setState(next);
            setValidated(true);
            const current = next.sessions.find(
              (s) => s.tabId === next.selectedId,
            );
            setSession(current?.state === "starting" ? undefined : current);
          } catch (e) {
            if (!effectCurrent) return;
            if (activeRef.current) ensureOnEntry.current = false;
            metadataFailed.current = true;
            needsRead.current = true;
            if (effectCurrent && live.current) setError(errorText(e));
          }
        } while (again && effectCurrent && live.current && activeRef.current);
        if (again) needsRead.current = true;
      };
      reading = task().finally(() => {
        if (!effectCurrent) return;
        reading = undefined;
        metadataRead.current = undefined;
        if (live.current) {
          setRefreshing(false);
          setEnteringEmpty(false);
        }
      });
      metadataRead.current = reading;
      return reading;
    };
    reload.current = read;
    const off = api.onChanged((change) => {
      // The selecting workspace receives the authoritative revision in its
      // response. All other retained owners must invalidate the shared revision.
      if (
        change &&
        JSON.stringify(change.selectionScope) === JSON.stringify(scope)
      )
        return;
      if (activeRef.current) void read();
      else needsRead.current = true;
    });
    void read();
    return () => {
      effectCurrent = false;
      live.current = false;
      off();
      if (ticket.current)
        void api
          .request({ kind: "cancel", token: ticket.current.token })
          .catch(() => {});
    };
  }, [api, scope]);
  useLayoutEffect(() => {
    const entered = viewActive && !wasActive.current;
    wasActive.current = viewActive;
    if (!entered) return;
    ensureOnEntry.current = true;
    const empty = !snapshot.current?.tabs.length;
    if (empty) setEnteringEmpty(true);
    // Warm, nonempty contexts keep their live screen with no extra request.
    if (empty || needsRead.current) void reload.current();
    else ensureOnEntry.current = false;
  }, [viewActive]);
  useEffect(() => {
    // Existing sessions already own a live screen. Selecting one is presentation,
    // never a request to reopen it. New sessions wait for durable selection.
    if (
      suspendOpen ||
      restarting ||
      (closingTarget.current !== undefined &&
        closingTarget.current === selected?.id) ||
      !validated ||
      optimisticId !== null ||
      (session && session.state !== "starting")
    )
      return;
    let current = true;
    if (selected && state) {
      setOpening(true);
      void api
        .request({
          kind: "open",
          scope,
          revision: state.revision,
          tabId: selected.id,
        })
        .then((value) => {
          if (current && live.current) setSession(value);
        })
        .catch((e) => {
          if (current && live.current) setError(errorText(e));
        })
        .finally(() => {
          if (current && live.current) setOpening(false);
        });
    }
    return () => {
      current = false;
      setOpening(false);
    };
    // A registry rename/order notification is not permission to retry a failed spawn.
  }, [
    api,
    scope,
    selected?.id,
    validated,
    optimisticId,
    restarting,
    suspendOpen,
  ]);
  async function action(
    work: () => Promise<void>,
    backgroundSelection = false,
  ) {
    // Persistence is serialized, but it must not disable/fade the visible controls.
    // Explicit actions wait for the selection revision, not the terminal screen.
    if (!backgroundSelection && selectionTask.current) {
      if (!(await selectionTask.current) || !live.current) return false;
    }
    if (flight.current) return false;
    flight.current = true;
    if (!backgroundSelection) setBusy(true);
    try {
      if (metadataRead.current) await metadataRead.current;
      if (!live.current || metadataFailed.current) return false;
      if (!presentationFailed) setError("");
      await work();
      return true;
    } catch (e) {
      if (live.current) setError(errorText(e));
      return false;
    } finally {
      flight.current = false;
      if (live.current && !backgroundSelection) setBusy(false);
    }
  }
  const target = () => {
    if (!state || !selected) throw Error("Выберите терминал.");
    return { scope, revision: snapshot.current!.revision, tabId: selected.id };
  };
  function selectTab(tabId: string): Promise<boolean> {
    if (!snapshot.current?.tabs.some((tab) => tab.id === tabId))
      return Promise.resolve(false);
    if (flight.current && !selectionTask.current) return Promise.resolve(false);
    // Selection persistence is background metadata, not a screen/input lifecycle.
    queuedSelection.current = tabId;
    setOptimisticId(tabId);
    if (selectionTask.current) return selectionTask.current;
    let persisted = false;
    const task = action(async () => {
      while (queuedSelection.current && live.current) {
        const id = queuedSelection.current;
        queuedSelection.current = null;
        const persist = async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await api.request({
                kind: "select",
                scope,
                revision: snapshot.current!.revision,
                tabId: id,
              });
            } catch (error) {
              if (
                attempt >= 2 ||
                !errorText(error).includes(TERMINAL_SELECTION_STALE)
              )
                throw error;
              // Retry only this harmless preference, never a process/file action.
              // The fresh owner-filtered snapshot and the next host CAS remain mandatory.
              const fresh = await api.request({ kind: "read", scope });
              if (!live.current) throw error;
              snapshot.current = fresh;
            }
          }
        };
        const catalog = await persist();
        if (live.current && snapshot.current) {
          const next = { ...catalog, sessions: snapshot.current.sessions };
          snapshot.current = next;
          setState(next);
        }
      }
    }, true)
      .then((ok) => {
        persisted = ok;
        return ok;
      })
      .finally(() => {
        queuedSelection.current = null;
        selectionTask.current = null;
        if (live.current && persisted) setOptimisticId(null);
      });
    selectionTask.current = task;
    return task;
  }
  async function change(value: TerminalCatalogChange) {
    if (value.kind === "select") return selectTab(value.tabId);
    const capturedRevision = snapshot.current?.revision;
    const pendingSelection = selectionTask.current || metadataRead.current;
    return action(async () => {
      // Rebase only the selection we deliberately waited for. Never rebase an
      // already stale menu/editor capture or bypass the host's revision check.
      await api.request(
        pendingSelection && value.revision === capturedRevision
          ? { ...value, revision: snapshot.current!.revision }
          : value,
      );
      if (live.current) await reload.current();
    });
  }
  async function complete(preview: PendingConfirmation) {
    const restartingSession = preview.kind === "refresh";
    const closingTab = preview.kind === "tab";
    let reconciled = false;
    // Remove the old native presentation before its generation is retired.
    // Closing the dialog must not briefly remount that screen during confirm.
    flushSync(() => {
      if (restartingSession) setRestarting(true);
      if (closingTab) {
        // Closing is an admission guard, never a reason to retry a failed open.
        closingTarget.current = preview.closingTabId;
        setClosingTabId(preview.closingTabId);
      }
      setConfirmation(undefined);
    });
    ticket.current = undefined;
    try {
      const result = await api.request({
        kind: "confirm",
        token: preview.token,
        confirmed: preview.requiresConfirmation,
      });
      if (!live.current) return;
      if (result.session) setSession(result.session);
      await reload.current();
      reconciled = true;
      if (result.status !== "success")
        throw Error(
          result.message ?? "Не все процессы завершены. Вкладка сохранена.",
        );
    } catch (error) {
      // A rejected IPC may have already stopped/removed the session. Reconcile
      // before presenting it again, but keep the original close error visible.
      if (live.current && closingTab && !reconciled) await reload.current();
      // A rejected restart may already have retired the old generation.
      // Keep its screen hidden rather than producing a second presentation error.
      if (live.current && restartingSession) setPresentationFailed(true);
      throw error;
    } finally {
      if (live.current && restartingSession) {
        if (metadataFailed.current) setPresentationFailed(true);
        setRestarting(false);
      }
      if (live.current && closingTab) {
        if (metadataFailed.current && preview.closingTabId === selectedId)
          setPresentationFailed(true);
        closingTarget.current = undefined;
        setClosingTabId(undefined);
      }
    }
  }
  async function prepare(tabId?: string) {
    await action(async () => {
      if (!state) return;
      const result = tabId
        ? await api.request({
            kind: "prepare-close",
            scope,
            revision: snapshot.current!.revision,
            tabId,
          })
        : await api.request({
            kind: "prepare-refresh",
            ...target(),
            ref: {
              sessionId: session!.sessionId,
              generation: session!.generation,
            },
          });
      const preview: PendingConfirmation = { ...result, closingTabId: tabId };
      if (!live.current) {
        await api.request({ kind: "cancel", token: preview.token });
        return;
      }
      if (!preview.requiresConfirmation) {
        await complete(preview);
        return;
      }
      ticket.current = preview;
      setConfirmation(preview);
    });
  }
  const usable = session && selected && session.tabId === selected.id;
  const hidden =
    restarting ||
    closingSelected ||
    !!confirmation ||
    presentationFailed ||
    (!validated && !!error) ||
    obscured;
  return (
    <section
      className="terminal-workspace project-content"
      aria-label="Терминалы проекта"
    >
      <h2 className="terminal-heading">Терминал</h2>
      <TerminalTabs
        scope={scope}
        state={state && { ...state, selectedId: selectedId ?? null }}
        busy={busy}
        locked={!!confirmation}
        refreshDisabled={!usable}
        onChange={change}
        onClose={(id) => void prepare(id)}
        onRefresh={() => void prepare()}
        onError={setError}
      />
      {error && (
        <div role="alert" className="terminal-error">
          {error}
          <button
            type="button"
            aria-label="Закрыть ошибку"
            onClick={() => {
              setError("");
              setPresentationFailed(false);
            }}
          >
            ×
          </button>
        </div>
      )}

      {state && !state.tabs.length && !enteringEmpty && (
        <div className="terminal-empty">
          <h3>Нет открытых терминалов</h3>
          <p>
            Нажмите +, чтобы открыть терминал текущего контекста. Общий терминал
            доступен через стрелку рядом.
          </p>
        </div>
      )}
      {!error &&
        (restarting ||
          closingSelected ||
          (!state && refreshing) ||
          enteringEmpty ||
          opening) && (
          <div className="terminal-session-loading">
            <LoadingState
              label={
                restarting
                  ? "Перезапускаем терминал"
                  : closingSelected
                    ? "Закрываем терминал"
                    : "Открываем терминал"
              }
            />
          </div>
        )}
      {usable &&
        !hidden &&
        session.screen !== "lost" &&
        (session.state === "running" || session.state === "exited") && (
          <TerminalSurface
            api={api}
            enabled={
              validated &&
              !refreshing &&
              !needsRead.current &&
              optimisticId === null
            }
            visible={viewActive}
            scope={scope}
            revision={state!.revision}
            tabId={selected.id}
            session={session}
            onError={(message) => {
              setPresentationFailed(true);
              setError(message);
            }}
          />
        )}
      {confirmation && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Завершить процессы терминала"
          className="terminal-confirmation"
        >
          <h3>
            {confirmation.kind === "tab"
              ? "Закрыть терминал?"
              : "Обновить сессию?"}
          </h3>
          <p>
            В следующих контекстах работают команды. Они получат сигнал
            завершения; оболочки закроются после остановки команд.
          </p>
          <ul>
            {confirmation.sessions.map((s) => (
              <li key={`${s.sessionId}:${s.generation}`}>
                {s.context.kind === "primary" ? "Без топика" : s.context.topic}{" "}
                · команд: {s.jobCount}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const token = confirmation.token;
                ticket.current = undefined;
                setConfirmation(undefined);
                await api.request({ kind: "cancel", token });
              })
            }
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void action(() => complete(confirmation))}
          >
            {confirmation.kind === "tab"
              ? "Завершить и закрыть"
              : "Завершить и обновить"}
          </button>
        </div>
      )}
      <div className="terminal-footer">
        <span>
          {selected ? terminalArea(selected) : "Нет открытых терминалов"}
        </span>
        {selected && (
          <>
            {" "}
            <span className="terminal-status" role="status">
              {error
                ? "Сессия недоступна"
                : !usable
                  ? "Открываем терминал…"
                  : session.screen === "lost"
                    ? "Экран недоступен — обновите сессию"
                    : session.state === "exited"
                      ? `Сессия завершена${session.exitCode === undefined ? "" : ` · код ${session.exitCode}`}`
                      : session.state === "running"
                        ? "Сессия открыта"
                        : "Подождите…"}
            </span>
          </>
        )}
      </div>
    </section>
  );
}
