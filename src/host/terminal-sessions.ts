import { TerminalAdmissionClosedError } from "./terminal-errors";
import type { PreparedShutdown } from "./shutdown";
import {
  TerminalStartupError,
  type TerminalStartupPhase,
} from "./terminal-errors";
import {
  TerminalCloseCoordinator,
  type TerminalCloseRequest,
  type TerminalClosePreview,
  type TerminalCloseResult,
  type TerminalCloseTarget,
} from "./terminal-close";
import {
  TerminalStopError,
  type TerminalProcessControl,
  type TerminalProcessPlan,
} from "./terminal-processes";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import { randomUUID } from "node:crypto";
import {
  terminalContextKey,
  terminalTabMatches,
  terminalTabSchema,
  terminalInputSchema,
  terminalResizeSchema,
  type TerminalContext,
  type TerminalTab,
} from "../shared/terminal";
import type {
  PrepareTerminalScreen,
  TerminalSessionScreen,
} from "./terminal-transport";
import type { TerminalLaunch } from "./terminal-environment";
export interface TerminalLease {
  launch: TerminalLaunch;
  release(): void;
}
export interface TerminalPty {
  assertReady(): void;
  onFault(listener: () => void): { dispose(): void };
  pause(): void;
  resume(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
}
export interface TerminalSessionView {
  sessionId: string;
  generation: string;
  tabId: string;
  context: TerminalContext;
  state: "starting" | "running" | "stopping" | "exited";
  exitCode?: number;
  screen?: "lost";
}
export type TerminalSessionRef = Pick<
  TerminalSessionView,
  "sessionId" | "generation"
>;
export interface TerminalSessionDependencies {
  acquire(scope: ScopeRef): Promise<TerminalLease>;
  /** Shared cold native readiness. No shell exists while this promise is pending. */
  prepareNative?(): Promise<void>;
  spawn(launch: TerminalLaunch): TerminalPty;
  /** Must bind to the OS identity captured at spawn, not rediscover a PID on close. */
  processes(pty: TerminalPty): TerminalProcessControl;
  /** Persist removal under the host's registry lock/CAS before discarding completed sessions. */
  removeTab(tab: TerminalTab): Promise<void>;
  prepareScreen: PrepareTerminalScreen;
}
interface Entry {
  key: string;
  tab: TerminalTab;
  scope: ScopeRef;
  view: TerminalSessionView;
  opening?: Promise<TerminalSessionView>;
  lease?: TerminalLease;
  pty?: TerminalPty;
  screen?: TerminalSessionScreen;
  control?: TerminalProcessControl;
  subscriptions: { dispose(): void }[];
  cancelled: boolean;
  rootValid: boolean;
  transportFailed?: boolean;
  pendingSize?: { cols: number; rows: number };
}
function selection(tab: TerminalTab, scope: ScopeRef) {
  const parsedTab = terminalTabSchema.safeParse(tab),
    parsedScope = scopeRefSchema.safeParse(scope);
  if (!parsedTab.success || !parsedScope.success)
    throw Error("Недопустимая вкладка терминала.");
  let context: TerminalContext;
  if (typeof parsedScope.data === "string")
    context = { kind: "primary", projectId: parsedScope.data };
  else {
    const { revision: _, ...owner } = parsedScope.data;
    context = { kind: "topic", ...owner };
  }
  if (!terminalTabMatches(parsedTab.data, context))
    throw Error("Эта вкладка недоступна в выбранном контексте.");
  return {
    tab: parsedTab.data,
    scope: parsedScope.data,
    context,
    key: JSON.stringify([parsedTab.data.id, terminalContextKey(context)]),
  };
}
/** Host-only state machine. Switching views does not write commands, stop or recreate PTYs. */
export class TerminalSessions {
  private entries = new Map<string, Entry>();
  private closing = new Set<{
    projectId?: string;
    tabId?: string;
    key?: string;
  }>();
  private closed = false;
  private shutdown = false;
  private listeners = new Set<() => void>();
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* UI delivery must not alter process ownership. */
      }
    }
  }
  private coordinator: TerminalCloseCoordinator;
  constructor(private dependencies: TerminalSessionDependencies) {
    this.coordinator = new TerminalCloseCoordinator({
      targets: (request) => this.closeTargets(request),
      report: (request) =>
        request.kind === "refresh"
          ? [...this.entries.values()]
              .filter((e) => e.view.sessionId === request.ref.sessionId)
              .map((e) => structuredClone(e.view))
          : this.closeEntries(request).map((e) => structuredClone(e.view)),
      freeze: (request) => this.freeze(request),
      stop: (ref, plan) => this.stop(ref, plan),
      complete: (request) => this.completeClose(request),
    });
  }
  private admissionClosed(selected: ReturnType<typeof selection>) {
    return (
      this.closed ||
      this.shutdown ||
      [...this.closing].some(
        (lock) =>
          !lock.projectId ||
          (lock.projectId === selected.tab.projectId &&
            lock.tabId === selected.tab.id &&
            (!lock.key || lock.key === selected.key)),
      )
    );
  }
  private assertOpen(selected: ReturnType<typeof selection>) {
    if (this.admissionClosed(selected))
      throw new TerminalAdmissionClosedError();
  }
  async open(tab: TerminalTab, scope: ScopeRef): Promise<TerminalSessionView> {
    const selected = selection(tab, scope);
    this.assertOpen(selected);
    const current = this.entries.get(selected.key);
    if (!current) return this.start(selected);
    if (current.view.state === "stopping")
      throw Error("Сессия останавливается.");
    if (current.opening) return current.opening;
    return this.verifyExisting(selected, current);
  }
  /** Revalidate a known screen without any path capable of spawning a PTY. */
  async verifyPresentation(
    tab: TerminalTab,
    scope: ScopeRef,
    ref: TerminalSessionRef,
  ): Promise<void> {
    const selected = selection(tab, scope),
      current = this.entries.get(selected.key);
    if (
      !current ||
      current.view.sessionId !== ref.sessionId ||
      current.view.generation !== ref.generation ||
      !["running", "exited"].includes(current.view.state) ||
      current.view.screen === "lost"
    )
      throw Error("Сессия изменилась или недоступна.");
    await this.verifyExisting(selected, current);
    if (
      this.entries.get(selected.key) !== current ||
      current.view.sessionId !== ref.sessionId ||
      current.view.generation !== ref.generation ||
      !["running", "exited"].includes(current.view.state) ||
      current.view.screen === "lost"
    )
      throw Error("Сессия изменилась или недоступна.");
  }
  private async verifyExisting(
    selected: ReturnType<typeof selection>,
    current: Entry,
  ): Promise<TerminalSessionView> {
    this.assertOpen(selected);
    if (current.transportFailed && current.view.state !== "exited")
      throw Error(
        "Терминальный транспорт недоступен. Требуется безопасное обновление сессии.",
      );
    if (current.view.state === "running") {
      try {
        await current.lease!.launch.verifyRoot();
        current.rootValid = true;
      } catch {
        current.rootValid = false;
        throw Error(
          "Рабочая папка терминала недоступна или заменена. Обновите сессию.",
        );
      }
      // An exit or refresh may have happened during the asynchronous check.
      if (this.entries.get(selected.key) !== current)
        throw Error("Сессия изменилась.");
    }
    this.assertOpen(selected);
    current.scope = selected.scope;
    return structuredClone(current.view);
  }
  list(): TerminalSessionView[] {
    return [...this.entries.values()].map((entry) =>
      structuredClone(entry.view),
    );
  }
  prepareClose(request: TerminalCloseRequest): TerminalClosePreview {
    if (this.shutdown) throw Error("Приложение готовится к выходу.");
    return this.coordinator.prepare(request);
  }
  cancelClose(token: string): void {
    this.coordinator.cancel(token);
  }
  async confirmClose(
    token: string,
    confirmed: boolean,
  ): Promise<TerminalCloseResult> {
    if (this.shutdown) throw Error("Приложение готовится к выходу.");
    return this.coordinator.confirm(token, confirmed);
  }
  /** Host-only gate held through the entire app-wide confirmation/stop sequence. */
  async prepareShutdown(): Promise<PreparedShutdown> {
    if (this.shutdown || this.closed || this.closing.size)
      throw Error("Дождитесь завершения текущей операции терминала.");
    this.shutdown = true;
    let used = false,
      released = false;
    try {
      const preview = this.coordinator.prepare({
        kind: "exit",
        deferDisposal: true,
      });
      const assertLease = () => {
        if (released) throw Error("Подготовка к выходу уже завершена.");
      };
      const identity = (view: TerminalSessionView) =>
        `terminal:${view.sessionId}:${view.generation}`;
      return {
        items: preview.sessions
          .filter((view) => view.state !== "exited")
          .map((view) => ({
            id: identity(view),
            label: `${this.find(view).tab.name} — ${view.context.kind === "primary" ? "Без топика" : view.context.topic}`,
          })),
        requiresConfirmation: preview.requiresConfirmation,
        validate: () => {
          assertLease();
          this.coordinator.validate(preview.token);
        },
        stop: async () => {
          assertLease();
          used = true;
          const result = await this.coordinator.confirm(preview.token, true);
          if (result.status !== "success") throw Error(result.message);
        },
        remaining: () =>
          this.list()
            .filter((view) => view.state !== "exited")
            .map(identity),
        release: () => {
          if (released) return;
          released = true;
          this.shutdown = false;
          if (!used) this.coordinator.cancel(preview.token);
          this.flushSizes();
        },
      };
    } catch (error) {
      this.shutdown = false;
      throw error;
    }
  }
  finalizeShutdown(): void {
    if (!this.shutdown || this.list().some((view) => view.state !== "exited"))
      throw Error("Сначала требуется безопасно завершить сессии терминала.");
    for (const entry of this.entries.values()) entry.screen?.dispose();
    this.closed = true;
  }
  private closeEntries(request: TerminalCloseRequest): Entry[] {
    if (request.kind === "exit") return [...this.entries.values()];
    if (request.kind === "refresh") {
      const entry = this.find(request.ref);
      if (selection(entry.tab, request.scope).key !== entry.key)
        throw Error("Обновление другого контекста запрещено.");
      return [entry];
    }
    if (request.kind !== "tab") throw Error("Недопустимая операция терминала.");
    const parsed = terminalTabSchema.safeParse(request.tab);
    if (!parsed.success) throw Error("Недопустимая вкладка терминала.");
    return [...this.entries.values()].filter(
      (e) =>
        e.tab.projectId === parsed.data.projectId &&
        e.tab.id === parsed.data.id,
    );
  }
  private closeTargets(request: TerminalCloseRequest): TerminalCloseTarget[] {
    return this.closeEntries(request).map((e) => ({
      view: structuredClone(e.view),
      control: e.control,
    }));
  }
  private freeze(request: TerminalCloseRequest): () => void {
    if (this.closed) throw Error("Приложение завершает работу.");
    const entries = this.closeEntries(request);
    const lock =
      request.kind === "exit"
        ? {}
        : request.kind === "tab"
          ? { projectId: request.tab.projectId, tabId: request.tab.id }
          : {
              projectId: entries[0]!.tab.projectId,
              tabId: entries[0]!.tab.id,
              key: entries[0]!.key,
            };
    if (
      [...this.closing].some(
        (other) =>
          !other.projectId ||
          !("projectId" in lock) ||
          (other.projectId === lock.projectId &&
            other.tabId === lock.tabId &&
            (!other.key || !("key" in lock) || other.key === lock.key)),
      )
    )
      throw Error("Операция завершения уже выполняется.");
    this.closing.add(lock);
    return () => {
      this.closing.delete(lock);
      this.flushSizes();
    };
  }
  private async stop(ref: TerminalSessionRef, plan: TerminalProcessPlan) {
    const entry = this.find(ref);
    if (entry.view.state === "exited") return;
    if (entry.view.state !== "running" || !entry.control)
      throw new TerminalStopError("uncertain");
    entry.view.state = "stopping";
    this.changed();
    try {
      await entry.control.stop(plan, () => entry.screen?.drainAfterHangup());
      if ((entry.view.state as string) !== "exited")
        throw new TerminalStopError("uncertain");
    } finally {
      try {
        entry.screen?.finishClose();
      } catch {
        this.loseScreen(entry);
      }
      if ((entry.view.state as string) !== "exited")
        entry.view.state = "running";
      this.changed();
    }
  }
  private async completeClose(
    request: TerminalCloseRequest,
  ): Promise<TerminalSessionView | undefined> {
    const entries = this.closeEntries(request);
    if (entries.some((e) => e.view.state !== "exited"))
      throw new TerminalStopError("uncertain");
    if (request.kind === "refresh")
      return this.start(selection(entries[0]!.tab, request.scope), entries[0]);
    // Keep the operation freeze across persistence: no new context can spawn into a closing tab.
    // A failed store write keeps completed screens instead of silently restarting the visible tab.
    if (request.kind === "tab") {
      await this.dependencies.removeTab(request.tab);
      for (const entry of entries) {
        entry.screen?.dispose();
        this.entries.delete(entry.key);
      }
    }
    if (request.kind === "exit" && !request.deferDisposal) {
      this.closed = true;
      for (const entry of entries) entry.screen?.dispose();
    }
    this.changed();
    return undefined;
  }
  private start(
    selected: ReturnType<typeof selection>,
    previous?: Entry,
  ): Promise<TerminalSessionView> {
    const entry: Entry = {
      ...selected,
      view: {
        sessionId: previous?.view.sessionId ?? randomUUID(),
        generation: randomUUID(),
        tabId: selected.tab.id,
        context: selected.context,
        state: "starting",
      },
      subscriptions: [],
      cancelled: false,
      rootValid: true,
    };
    this.entries.set(entry.key, entry);
    this.changed();
    const opening = async () => {
      let phase: TerminalStartupPhase = "context";
      try {
        entry.lease = await this.dependencies.acquire(entry.scope);
        if (
          terminalContextKey(entry.lease.launch.context) !==
          terminalContextKey(entry.view.context)
        )
          throw Error();
        phase = "root";
        await entry.lease.launch.verifyRoot();
        if (entry.cancelled) throw Error();
        if (this.dependencies.prepareNative) {
          phase = "native-preflight";
          await this.dependencies.prepareNative();
          if (entry.cancelled) throw Error();
        }
        phase = "screen";
        entry.screen = await this.dependencies.prepareScreen(
          this.ref(entry),
          () => this.loseScreen(entry),
        );
        // Native readiness and renderer startup may take seconds. Re-check the pinned root
        // after waiting, then perform the readiness check and spawn without yielding.
        phase = "revalidate";
        await entry.lease.launch.verifyRoot();
        if (entry.cancelled) throw Error();
        phase = "screen-ready";
        entry.screen.assertReady();
        // Adapter spawn and subscription registration are synchronous, with asynchronous events.
        phase = "spawn";
        entry.pty = this.dependencies.spawn(entry.lease.launch);
        entry.view.state = "running";
        entry.subscriptions.push(
          entry.pty.onExit((event) => {
            entry.view.state = "exited";
            entry.view.exitCode = event.exitCode;
            this.release(entry);
            try {
              entry.screen?.exited();
            } catch {
              this.loseScreen(entry);
            }
            for (const subscription of entry.subscriptions.splice(0))
              subscription.dispose();
            this.changed();
          }),
        );
        phase = "processes";
        entry.control = this.dependencies.processes(entry.pty);
        entry.subscriptions.push(
          entry.pty.onFault(() => this.loseScreen(entry)),
        );
        phase = "native-ready";
        entry.pty.assertReady();
        phase = "screen-bind";
        entry.screen.bind({
          pause: () => entry.pty!.pause(),
          resume: () => entry.pty!.resume(),
          input: (text) => this.write(this.ref(entry), text),
          resize: (cols, rows) => this.resize(this.ref(entry), cols, rows),
        });
        previous?.screen?.dispose();
        phase = "output-subscribe";
        entry.subscriptions.push(
          entry.pty.onData((data) => {
            if (
              this.entries.get(entry.key) === entry &&
              entry.view.state !== "exited"
            )
              try {
                entry.screen!.output(data);
              } catch {
                this.loseScreen(entry);
              }
          }),
        );

        this.changed();
        return structuredClone(entry.view);
      } catch (error) {
        if (error instanceof TerminalStartupError) phase = error.phase;
        if (entry.pty) {
          // Spawn succeeded: retain ownership until an observed exit, even if transport setup failed.
          this.loseScreen(entry);
          previous?.screen?.dispose();
          throw new TerminalStartupError(phase, true);
        }
        entry.screen?.dispose();
        this.release(entry);
        if (this.entries.get(entry.key) === entry) {
          if (previous) this.entries.set(entry.key, previous);
          else this.entries.delete(entry.key);
        }
        throw new TerminalStartupError(phase, false, entry.cancelled);
      } finally {
        entry.opening = undefined;
        this.changed();
      }
    };
    entry.opening = opening();
    return entry.opening;
  }
  private loseScreen(entry: Entry): void {
    if (this.entries.get(entry.key) !== entry || entry.transportFailed) return;
    entry.transportFailed = true;
    entry.view.screen = "lost";
    try {
      entry.pty?.pause();
    } catch {
      /* Ownership is retained even if native I/O fails. */
    }
    try {
      entry.screen?.fail();
    } catch {
      /* Never leak native diagnostics or restart. */
    }
    this.changed();
  }
  cancelOpen(tab: TerminalTab, scope: ScopeRef): void {
    const entry = this.entries.get(selection(tab, scope).key);
    if (!entry) return;
    if (entry.view.state !== "starting")
      throw Error("Сессия уже запущена; требуется безопасное завершение.");
    entry.cancelled = true;
  }
  write(ref: TerminalSessionRef, data: string): void {
    if (
      !terminalInputSchema.safeParse({ ...this.validatedRef(ref), text: data })
        .success
    )
      throw Error("Недопустимый ввод терминала.");
    this.running(ref).pty!.write(data);
  }
  resize(ref: TerminalSessionRef, cols: number, rows: number): void {
    if (
      !terminalResizeSchema.safeParse({ ...this.validatedRef(ref), cols, rows })
        .success
    )
      throw Error("Недопустимый размер терминала.");
    const entry = this.find(ref);
    if (
      this.admissionClosed(selection(entry.tab, entry.scope)) &&
      (entry.view.state === "running" || entry.view.state === "stopping") &&
      entry.rootValid &&
      !entry.transportFailed
    ) {
      entry.pendingSize = { cols, rows };
      return;
    }
    this.running(ref).pty!.resize(cols, rows);
  }
  private validatedRef(ref: TerminalSessionRef): TerminalSessionRef {
    return { sessionId: ref?.sessionId, generation: ref?.generation };
  }
  private find(ref: TerminalSessionRef): Entry {
    const entry = [...this.entries.values()].find(
      (e) =>
        e.view.sessionId === ref?.sessionId &&
        e.view.generation === ref?.generation,
    );
    if (!entry) throw Error("Сессия терминала устарела или отсутствует.");
    return entry;
  }
  private flushSizes(): void {
    for (const entry of this.entries.values()) {
      if (
        !entry.pendingSize ||
        this.admissionClosed(selection(entry.tab, entry.scope))
      )
        continue;
      const size = entry.pendingSize;
      entry.pendingSize = undefined;
      if (
        entry.view.state !== "running" ||
        !entry.rootValid ||
        entry.transportFailed
      )
        continue;
      try {
        entry.pty!.resize(size.cols, size.rows);
      } catch {
        this.loseScreen(entry);
      }
    }
  }
  /** Switching a granted live screen uses the same in-memory lease as input. */
  assertPresentation(ref: TerminalSessionRef): void {
    const entry = this.find(ref);
    this.assertOpen(selection(entry.tab, entry.scope));
    if (
      entry.view.screen === "lost" ||
      !["running", "exited"].includes(entry.view.state) ||
      (entry.view.state === "running" &&
        (!entry.rootValid || entry.transportFailed))
    )
      throw Error("Терминал недоступен.");
  }
  private running(ref: TerminalSessionRef) {
    const entry = this.find(ref);
    this.assertOpen(selection(entry.tab, entry.scope));
    if (
      entry.view.state !== "running" ||
      !entry.rootValid ||
      entry.transportFailed
    )
      throw Error("Терминал недоступен для ввода.");
    return entry;
  }
  private ref(entry: Entry): TerminalSessionRef {
    return {
      sessionId: entry.view.sessionId,
      generation: entry.view.generation,
    };
  }
  private release(entry: Entry) {
    const lease = entry.lease;
    entry.lease = undefined;
    lease?.release();
  }
}
