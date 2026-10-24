import type { TerminalSessionRef } from "../shared/terminal";

export interface TerminalTransportSource {
  pause(): void;
  resume(): void;
  input(text: string): void;
  resize(cols: number, rows: number): void;
}
/** A prepared screen is not a running process. Bind synchronously after spawn,
 * before subscribing to output. Dispose only before spawn or after observed exit. */
export interface TerminalSessionScreen {
  assertReady(): void;
  bind(source: TerminalTransportSource): void;
  output(text: string): void;
  exited(): void;
  /** A lost renderer cannot use remaining output. Drain only after confirmed HUP,
   * so native EOF/exit is observable; never reconnect those bytes to a parser. */
  drainAfterHangup(): void;
  finishClose(): void;
  fail(): void;
  dispose(): void;
}
export type PrepareTerminalScreen = (
  ref: TerminalSessionRef,
  lost: () => void,
) => Promise<TerminalSessionScreen>;

import { terminalSessionRefSchema } from "../shared/terminal";
import {
  TERMINAL_SOURCE_BYTES,
  type TerminalGrant,
} from "../shared/terminal-screen";
import { FLOW_LIMIT } from "./terminal-flow";
import type { TerminalSurfaceBounds } from "../shared/terminal-control";
export interface TerminalTransportView {
  readonly isLost: boolean;
  whenReady(): Promise<void>;
  attach(
    ref: TerminalSessionRef,
    source: TerminalTransportSource,
  ): TerminalGrant;
  output(ref: TerminalSessionRef, text: string): boolean;
  status(ref: TerminalSessionRef): {
    pendingBytes: number;
    paused: boolean;
    state: string;
  };
  fail(ref: TerminalSessionRef): void;
  exited(ref: TerminalSessionRef): void;
  remove(ref: TerminalSessionRef): void;
  show(
    ref: TerminalSessionRef,
    bounds: TerminalSurfaceBounds,
    interactive?: boolean,
  ): void;
  hide(): void;
  dispose(): void;
}
interface Entry {
  ref: TerminalSessionRef;
  view: TerminalTransportView;
  lost(): void;
  source?: TerminalTransportSource;
  bound: boolean;
  attached: boolean;
  ended: boolean;
  failed: boolean;
  disposed: boolean;
  draining: boolean;
  pending?: string;
}
/** Owns parser lifetimes, never process lifetimes. A failed renderer can be
 * replaced for fresh generations only; old streams stay paused and owned. */
export class TerminalTransport {
  private entries = new Map<string, Entry>();
  private used = new Set<string>();
  private views = new Set<TerminalTransportView>();
  private current?: TerminalTransportView;
  constructor(
    private create: (
      lost: (ref: TerminalSessionRef) => void,
    ) => TerminalTransportView,
  ) {}
  private key(ref: TerminalSessionRef) {
    return JSON.stringify([ref.sessionId, ref.generation]);
  }
  prepare: PrepareTerminalScreen = async (raw, lost) => {
    const ref = terminalSessionRefSchema.parse(raw),
      key = this.key(ref);
    if (
      this.used.has(key) ||
      [...this.entries.values()].some(
        (e) => e.ref.sessionId === ref.sessionId && !e.ended,
      )
    )
      throw Error(
        "Экран сессии уже существует; нужна подтверждённая новая сессия.",
      );
    this.used.add(key);
    if (!this.current || this.current.isLost) {
      this.current = this.create((ref) => {
        const entry = this.entries.get(this.key(ref));
        if (entry) this.fail(entry);
      });
      this.views.add(this.current);
    }
    const entry: Entry = {
      ref,
      view: this.current,
      lost,
      bound: false,
      attached: false,
      ended: false,
      failed: false,
      disposed: false,
      draining: false,
    };
    this.entries.set(key, entry);
    try {
      await entry.view.whenReady();
      this.assertReady(entry);
    } catch {
      this.remove(entry);
      throw Error("Экран терминала недоступен.");
    }
    return {
      assertReady: () => this.assertReady(entry),
      bind: (source) => this.bind(entry, source),
      output: (text) => this.output(entry, text),
      exited: () => {
        if (entry.disposed || entry.ended) return;
        entry.ended = true;
        if (entry.attached) entry.view.exited(ref);
      },
      drainAfterHangup: () => {
        if (
          entry.disposed ||
          entry.ended ||
          !entry.bound ||
          !entry.failed ||
          entry.draining
        )
          return;
        entry.draining = true;
        entry.pending = undefined;
        entry.source!.resume();
      },
      finishClose: () => {
        if (!entry.draining) return;
        entry.draining = false;
        if (!entry.disposed && !entry.ended) entry.source!.pause();
      },
      fail: () => this.fail(entry),
      dispose: () => this.remove(entry),
    };
  };
  private assertReady(entry: Entry) {
    if (entry.disposed || entry.failed || entry.view.isLost)
      throw Error("Экран терминала утрачен; требуется обновление сессии.");
  }
  private bind(entry: Entry, source: TerminalTransportSource) {
    this.assertReady(entry);
    if (entry.bound || entry.ended) throw Error("Экран сессии уже подключён.");
    // Only a successfully spawned replacement retires its old completed screen.
    for (const other of [...this.entries.values()]) {
      if (other !== entry && other.ref.sessionId === entry.ref.sessionId) {
        if (!other.ended) throw Error("Предыдущая сессия ещё работает.");
        this.remove(other);
      }
    }
    entry.source = source;
    entry.bound = true;
    try {
      entry.view.attach(entry.ref, {
        pause: () => {
          if (!entry.draining) source.pause();
        },
        resume: () => this.resume(entry),
        input: (text) => {
          this.assertReady(entry);
          if (!entry.ended) source.input(text);
        },
        resize: (cols, rows) => {
          this.assertReady(entry);
          if (!entry.ended) source.resize(cols, rows);
        },
      });
      entry.attached = true;
      this.assertReady(entry);
    } catch {
      this.fail(entry);
      throw Error("Терминальный транспорт недоступен.");
    }
  }
  private output(entry: Entry, text: string) {
    if (entry.disposed || !entry.bound || entry.ended)
      throw Error("Терминальный поток уже закрыт.");
    if (entry.draining) return;
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > TERMINAL_SOURCE_BYTES ||
      entry.pending !== undefined
    ) {
      this.fail(entry);
      throw Error("Терминальный поток нарушил ограничение буфера.");
    }
    try {
      if (!this.offer(entry, text)) {
        entry.pending = text;
        entry.source!.pause();
      }
    } catch {
      this.fail(entry);
      throw Error("Терминальный транспорт недоступен.");
    }
  }
  private offer(entry: Entry, text: string): boolean {
    // Reserve one refused source event plus the native adapter's queued tail.
    // Total flow + retained + native payload stays <=1 MiB after renderer loss.
    if (
      entry.view.status(entry.ref).pendingBytes + Buffer.byteLength(text) >
      FLOW_LIMIT - 2 * TERMINAL_SOURCE_BYTES
    )
      return false;
    return entry.view.output(entry.ref, text);
  }
  private resume(entry: Entry) {
    if (entry.disposed || entry.failed || entry.view.isLost) return;
    if (entry.pending !== undefined) {
      const text = entry.pending;
      entry.pending = undefined;
      if (!this.offer(entry, text)) {
        entry.pending = text;
        return;
      }
    }
    if (!entry.ended && !entry.view.status(entry.ref).paused)
      entry.source!.resume();
  }
  private fail(entry: Entry) {
    if (entry.disposed || entry.failed) return;
    entry.failed = true;
    try {
      entry.source?.pause();
    } catch {
      /* Preserve process ownership. */
    }
    if (entry.attached) {
      try {
        entry.view.fail(entry.ref);
      } catch {
        /* Renderer may already be gone. */
      }
    }
    entry.lost();
  }
  private remove(entry: Entry) {
    if (entry.disposed) return;
    if (entry.bound && !entry.ended)
      throw Error("Нельзя удалить экран работающей сессии.");
    entry.disposed = true;
    entry.pending = undefined;
    this.entries.delete(this.key(entry.ref));
    if (entry.attached) entry.view.remove(entry.ref);
    if (
      entry.view.isLost &&
      ![...this.entries.values()].some((e) => e.view === entry.view)
    ) {
      entry.view.dispose();
      this.views.delete(entry.view);
      if (this.current === entry.view) this.current = undefined;
    }
  }
  hide(): void {
    for (const view of this.views) view.hide();
  }
  preview(ref: TerminalSessionRef, bounds: TerminalSurfaceBounds): void {
    this.show(ref, bounds, false);
  }
  show(
    ref: TerminalSessionRef,
    bounds: TerminalSurfaceBounds,
    interactive = true,
  ): void {
    try {
      const entry = this.entries.get(this.key(ref));
      if (!entry || !entry.bound) throw Error("Экран сессии отсутствует.");
      this.assertReady(entry);
      for (const view of this.views) if (view !== entry.view) view.hide();
      entry.view.show(ref, bounds, interactive);
    } catch (error) {
      this.hide();
      throw error;
    }
  }
}
