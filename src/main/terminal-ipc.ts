import { randomUUID } from "node:crypto";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { ScopeRef } from "../shared/context";
import type { TerminalCatalog } from "../host/terminal-catalog";
import type {
  TerminalSessions,
  TerminalSessionView,
} from "../host/terminal-sessions";
import {
  terminalContextKey,
  type TerminalContext,
  type TerminalSessionRef,
} from "../shared/terminal";
import {
  terminalControlEnvelopeSchema,
  type TerminalControlRequest,
  type TerminalSurfaceBounds,
} from "../shared/terminal-control";
import { TERMINAL_CONTROL_SCOPES } from "../shared/operation-scopes";
import { validShellSender } from "./security";
interface Dependencies {
  window: BrowserWindow;
  shellURL: string;
  catalog: TerminalCatalog;
  sessions: Pick<
    TerminalSessions,
    | "open"
    | "verifyPresentation"
    | "assertPresentation"
    | "list"
    | "onChanged"
    | "prepareClose"
    | "cancelClose"
    | "confirmClose"
  >;
  surface: {
    show(ref: TerminalSessionRef, bounds: TerminalSurfaceBounds): void;
    preview?(ref: TerminalSessionRef, bounds: TerminalSurfaceBounds): void;
    hide(): void;
  };
  now?: () => number;
}
type TargetRequest = Extract<
  TerminalControlRequest,
  { kind: "prepare-close" | "prepare-refresh" }
>;
interface Ticket {
  hostToken: string;
  request: TargetRequest;
  epoch: number;
  expires: number;
  required: boolean;
}
/** Control messages contain IDs only. Terminal bytes have a separate renderer/IPC capability.
 * A reload revokes document tickets and late replies, never signals an already-started PTY.
 */
export function registerTerminalIPC(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  d: Dependencies,
): () => void {
  const channel = "goga:terminal-request",
    tickets = new Map<string, Ticket>();
  // Presentation proofs belong to this shell document, never to a renderer cache.
  // A granted live session keeps its input lease while hidden, including across
  // project switches. Activation checks exact owner/ref and live admission in
  // memory; only a never-presented session requires full initial authorization.
  const presented = new Map<string, number>();
  const presentationKey = (request: {
    scope: ScopeRef;
    tabId: string;
    ref: TerminalSessionRef;
  }) =>
    JSON.stringify([
      terminalContextKey(contextOf(request)),
      request.tabId,
      request.ref,
    ]);
  let presentation = 0;
  let epoch = 0,
    disposed = false;
  let documentId: string | undefined;
  const now = d.now ?? (() => performance.now());
  const denied = () => Error("Терминал: запрос запрещён или устарел.");
  const valid = (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => {
    if (disposed || d.window.isDestroyed()) return false;
    const wc = d.window.webContents;
    return (
      !disposed &&
      !d.window.isDestroyed() &&
      !wc.isDestroyed() &&
      event.sender === wc &&
      event.senderFrame === wc.mainFrame &&
      wc.getURL() === d.shellURL &&
      validShellSender(
        event.sender.id,
        wc.id,
        event.senderFrame?.url ?? "",
        d.shellURL,
        event.senderFrame?.parent === null,
      )
    );
  };
  const notify = (selectionScope?: ScopeRef) => {
    const wc = d.window.webContents;
    if (
      !disposed &&
      documentId &&
      !d.window.isDestroyed() &&
      !wc.isDestroyed() &&
      wc.getURL() === d.shellURL &&
      wc.mainFrame.url === d.shellURL
    ) {
      try {
        wc.send("goga:terminal-changed", {
          documentId,
          ...(selectionScope !== undefined ? { selectionScope } : {}),
        });
      } catch {
        /* Reload/close delivery race; no process effects. */
      }
    }
  };
  const unsubscribe = d.sessions.onChanged(() => notify());
  const cancel = (ticket: Ticket) => {
    try {
      d.sessions.cancelClose(ticket.hostToken);
    } catch {
      /* Already consumed/expired is not a reason to stop anything. */
    }
  };
  const invalidate = () => {
    epoch++;
    presented.clear();
    documentId = undefined;
    for (const ticket of tickets.values()) cancel(ticket);
    tickets.clear();
    d.surface.hide();
  };
  const navigation = (
    _event: unknown,
    _url: string,
    _inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame) invalidate();
  };
  const contextOf = (request: { scope: ScopeRef }): TerminalContext => {
    if (typeof request.scope === "string")
      return { kind: "primary", projectId: request.scope };
    const { revision: _, ...identity } = request.scope;
    return { kind: "topic", ...identity };
  };
  const ownedSession = (
    request: Extract<
      TerminalControlRequest,
      { kind: "show" | "preview" | "activate" | "prepare-refresh" }
    >,
  ): TerminalSessionView => {
    const session = d.sessions
      .list()
      .find(
        (s) =>
          s.sessionId === request.ref.sessionId &&
          s.generation === request.ref.generation &&
          s.tabId === request.tabId &&
          terminalContextKey(s.context) ===
            terminalContextKey(contextOf(request)),
      );
    if (!session) throw denied();
    return session;
  };
  const take = (token: string): Ticket => {
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket) throw denied();
    if (ticket.epoch !== epoch || ticket.expires <= now()) {
      cancel(ticket);
      throw denied();
    }
    return ticket;
  };
  ipc.handle("goga:terminal-connect", (event, ...args) => {
    if (!valid(event) || args.length) throw denied();
    documentId ??= randomUUID();
    return documentId;
  });
  ipc.handle(channel, async (event, raw, ...extra) => {
    if (!valid(event) || extra.length) throw denied();
    const sender = { sender: event.sender, senderFrame: event.senderFrame };
    const captured = epoch,
      guard = () => {
        if (captured !== epoch || !valid(sender)) throw denied();
      };
    const parsed = terminalControlEnvelopeSchema.safeParse(raw);
    if (
      !parsed.success ||
      !documentId ||
      parsed.data.documentId !== documentId ||
      !Object.hasOwn(TERMINAL_CONTROL_SCOPES, parsed.data.request.kind)
    )
      throw denied();
    const request = parsed.data.request;
    const showOrder =
      request.kind === "show" ||
      request.kind === "preview" ||
      request.kind === "activate" ||
      request.kind === "hide"
        ? ++presentation
        : presentation;
    if (
      ["initialize", "create", "rename", "select", "move", "reorder"].includes(
        request.kind,
      )
    ) {
      const result = await d.catalog.change(
        request as Extract<
          TerminalControlRequest,
          {
            kind:
              | "initialize"
              | "create"
              | "rename"
              | "select"
              | "move"
              | "reorder";
          }
        >,
        guard,
      );
      guard();
      notify(request.kind === "select" ? request.scope : undefined);
      return result;
    }
    if (request.kind === "read") {
      const state = await d.catalog.read(request.scope, guard);
      guard();
      const ids = new Set(state.tabs.map((t) => t.id));
      const sessions = d.sessions
        .list()
        .filter(
          (s) =>
            ids.has(s.tabId) &&
            terminalContextKey(s.context) === terminalContextKey(state.context),
        );
      return { ...state, sessions };
    }
    if (request.kind === "preview") {
      if (!presented.has(presentationKey(request))) {
        d.surface.hide();
        return null;
      }
      const session = ownedSession(request);
      if (
        session.screen === "lost" ||
        !["running", "exited"].includes(session.state)
      )
        return null;
      guard();
      d.surface.preview?.(request.ref, request.bounds);
      return null;
    }
    if (request.kind === "activate") {
      if (!presented.has(presentationKey(request))) return false;
      ownedSession(request);
      d.sessions.assertPresentation(request.ref);
      guard();
      d.surface.show(request.ref, request.bounds);
      return true;
    }
    if (request.kind === "hide") {
      d.surface.hide();
      return null;
    }
    if (request.kind === "cancel") {
      cancel(take(request.token));
      return null;
    }
    if (request.kind === "confirm") {
      const ticket = take(request.token);
      let release: (() => void) | undefined,
        submitted = false;
      try {
        if (ticket.required && request.confirmed !== true) throw denied();
        const tab = await d.catalog.authorize(
          ticket.request.scope,
          ticket.request.tabId,
          ticket.request.revision,
          guard,
        );
        guard();
        if (ticket.request.kind === "prepare-refresh")
          ownedSession(ticket.request);
        release = d.catalog.freeze(tab);
        submitted = true;
        const result = await d.sessions.confirmClose(
          ticket.hostToken,
          request.confirmed,
        );
        guard();
        return result;
      } finally {
        if (!submitted) cancel(ticket);
        release?.();
      }
    }
    if (
      request.kind === "open" ||
      request.kind === "show" ||
      request.kind === "prepare-close" ||
      request.kind === "prepare-refresh"
    ) {
      const tab = await d.catalog
        .authorize(request.scope, request.tabId, request.revision, guard)
        .catch((error) => {
          if (request.kind === "show") {
            const key = presentationKey(request);
            if ((presented.get(key) ?? Infinity) <= showOrder)
              presented.delete(key);
            if (showOrder === presentation) d.surface.hide();
          }
          throw error;
        });
      guard();
      if (request.kind === "open") {
        const session = await d.sessions.open(tab, request.scope);
        guard();
        return session;
      }
      if (request.kind === "show") {
        if (showOrder !== presentation) return null;
        ownedSession(request);
        try {
          await d.sessions.verifyPresentation(tab, request.scope, request.ref);
          guard();
        } catch (error) {
          const key = presentationKey(request);
          if ((presented.get(key) ?? Infinity) <= showOrder)
            presented.delete(key);
          if (showOrder === presentation) d.surface.hide();
          throw error;
        }
        if (showOrder !== presentation) return null;
        ownedSession(request);
        guard();
        d.surface.show(request.ref, request.bounds);
        presented.set(presentationKey(request), showOrder);
        return null;
      }
      if (request.kind === "prepare-refresh") ownedSession(request);
      const preview = d.sessions.prepareClose(
        request.kind === "prepare-close"
          ? { kind: "tab", tab }
          : { kind: "refresh", ref: request.ref, scope: request.scope },
      );
      for (const [key, ticket] of tickets)
        if (ticket.expires <= now()) {
          cancel(ticket);
          tickets.delete(key);
        }
      if (tickets.size >= 128) {
        const key = tickets.keys().next().value!;
        cancel(tickets.get(key)!);
        tickets.delete(key);
      }
      const token = randomUUID();
      tickets.set(token, {
        hostToken: preview.token,
        request,
        epoch: captured,
        expires: now() + 60000,
        required: preview.requiresConfirmation,
      });
      return { ...preview, token };
    }
    throw denied();
  });
  d.window.webContents.on("did-start-navigation", navigation);
  d.window.webContents.on("render-process-gone", invalidate);
  const dispose = () => {
    if (disposed) return;
    invalidate();
    disposed = true;
    ipc.removeHandler(channel);
    ipc.removeHandler("goga:terminal-connect");
    unsubscribe();
    d.window.webContents.removeListener("did-start-navigation", navigation);
    d.window.webContents.removeListener("render-process-gone", invalidate);
    d.window.removeListener("closed", dispose);
  };
  d.window.on("closed", dispose);
  return dispose;
}
