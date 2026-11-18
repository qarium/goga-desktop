import type { TopicBoardSnapshot } from "../shared/topics";
import { preparationErrorMessage } from "./preparation-error";
import { readWithSignal } from "./read-request";

export type TopicTableScope = Readonly<{
  projectId: string;
  path: string;
  year: string;
}>;
export interface TopicTableState {
  board: TopicBoardSnapshot | null;
  loading: boolean;
  /** Passive timer reads need not suspend actions on a confirmed table. */
  polling: boolean;
  error: string;
}
type Reader = (
  signal: AbortSignal,
  scope: TopicTableScope,
) => Promise<TopicBoardSnapshot>;
type Flight = {
  controller: AbortController;
  done: Promise<void>;
  invalidated: boolean;
};
type Active = {
  key: string;
  scope: TopicTableScope;
  flight?: Flight;
  timer?: ReturnType<typeof setTimeout>;
};

const EMPTY: TopicTableState = Object.freeze({
  board: null,
  loading: false,
  polling: false,
  error: "",
});
const keyOf = ({ projectId, path, year }: TopicTableScope) =>
  JSON.stringify([projectId, path, year]);
const POLL_MS = 60_000;
const MAX_IDLE_SNAPSHOTS = 16;

/** In-memory display tables, never deletion/checkout authority. Subscribing is
 * passive: App alone owns which project/year is allowed to start host work. */
export class TopicTableCache {
  private readonly states = new Map<string, TopicTableState>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private active: Active | null = null;

  constructor(
    private readonly read: Reader = (signal, { projectId, year }) =>
      readWithSignal(signal, "readTopicTable", projectId, year),
  ) {}

  getSnapshot(scope: TopicTableScope) {
    return this.states.get(keyOf(scope)) ?? EMPTY;
  }

  subscribe(scope: TopicTableScope, listener: () => void) {
    const key = keyOf(scope);
    const set = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
      this.trim();
    };
  }

  activate(scope: TopicTableScope | null) {
    const next =
      scope && scope.projectId && scope.path && /^\d{4}$/.test(scope.year)
        ? { key: keyOf(scope), scope }
        : null;
    if (next?.key === this.active?.key) return;
    const previous = this.active;
    this.active = next;
    if (previous) {
      clearTimeout(previous.timer);
      if (previous.flight) {
        previous.flight.controller.abort();
        this.publish(previous.key, {
          ...this.getSnapshot(previous.scope),
          loading: false,
          polling: false,
        });
      }
    }
    if (next) void this.start(next);
    this.trim();
  }

  refresh(scope: TopicTableScope): Promise<void> {
    const active = this.active;
    return active?.key === keyOf(scope)
      ? this.start(active)
      : Promise.resolve();
  }

  invalidate(scope: TopicTableScope) {
    const active = this.active;
    if (!active || active.key !== keyOf(scope)) return;
    if (active.flight) {
      active.flight.invalidated = true;
      const snapshot = this.getSnapshot(scope);
      if (snapshot.polling)
        this.publish(active.key, { ...snapshot, polling: false });
    } else void this.start(active);
  }

  private start(active: Active, polling = false): Promise<void> {
    if (active.flight) return active.flight.done;
    clearTimeout(active.timer);
    let resolve!: () => void;
    const flight: Flight = {
      controller: new AbortController(),
      done: new Promise<void>((r) => {
        resolve = r;
      }),
      invalidated: false,
    };
    active.flight = flight;
    this.publish(active.key, {
      ...this.getSnapshot(active.scope),
      loading: true,
      polling,
    });
    void this.load(active, flight).finally(resolve);
    return flight.done;
  }

  private async load(active: Active, flight: Flight) {
    let next: TopicTableState;
    try {
      const board = await this.read(flight.controller.signal, active.scope);
      if (
        board.projectId !== active.scope.projectId ||
        board.year !== active.scope.year
      )
        throw Error("Ответ относится к другому проекту или году.");
      next = { board, loading: false, polling: false, error: "" };
    } catch (error) {
      next = {
        ...this.getSnapshot(active.scope),
        loading: false,
        polling: false,
        error: preparationErrorMessage(error),
      };
    }
    // The former owner may have become active again while an old IPC was
    // settling. Object identity, not project equality, fences that response.
    if (this.active !== active) return;
    active.flight = undefined;
    if (flight.invalidated) {
      // The operation happened after this read began: discard its result and
      // run precisely one fresh pass, even for a burst of invalidations.
      void this.start(active);
      return;
    }
    active.timer = setTimeout(() => {
      if (this.active === active) void this.start(active, true);
    }, POLL_MS);
    this.publish(active.key, next);
  }

  private publish(key: string, state: TopicTableState) {
    this.states.delete(key);
    this.states.set(key, state);
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  private trim() {
    const idle = [...this.states.keys()].filter(
      (key) => key !== this.active?.key && !this.listeners.has(key),
    );
    for (const key of idle.slice(
      0,
      Math.max(0, idle.length - MAX_IDLE_SNAPSHOTS),
    ))
      this.states.delete(key);
  }

  dispose() {
    this.listeners.clear();
    this.activate(null);
    this.states.clear();
  }
}
