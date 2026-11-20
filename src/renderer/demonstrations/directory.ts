import { t as msg } from "../../shared/i18n";
import { useEffect, useSyncExternalStore } from "react";
import type { ScopeRef } from "../../shared/context";
import {
  demoScopeKey,
  type DemoState,
  type DemoCommand,
} from "../../shared/demonstrations";

export const demoError = (e: unknown) =>
  e instanceof Error
    ? e.message.replace(
        /^Error invoking remote method 'goga:demo-(?:state|execute|frame|next-frame|browser|copy-url|copy-selection|cancel-selection-copy)': (?:Error: )?/,
        "",
      )
    : msg("workspace.couldNotPerformTheDemonstrationOperation");
type Listener = () => void;
export class DemoDirectory {
  state: DemoState | null = null;
  error = "";
  readonly starting = new Map<string, Promise<void>>();
  private issued = 0;
  private reading?: Promise<void>;
  private readonly listeners = new Set<Listener>();
  constructor(readonly bridge: Window["goga"]) {}
  get available() {
    return (
      typeof this.bridge?.demoState === "function" &&
      typeof this.bridge?.demoExecute === "function"
    );
  }
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private notify() {
    for (const fn of this.listeners) fn();
  }
  refresh(afterMutation = false): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (this.reading && !afterMutation) return this.reading;
    const seq = ++this.issued;
    const read = this.bridge.demoState().then(
      (next) => {
        if (seq !== this.issued) return;
        this.state = next;
        this.error = "";
        this.notify();
      },
      (e) => {
        if (seq === this.issued) {
          this.error = demoError(e);
          this.notify();
        }
        throw e;
      },
    );
    this.reading = read;
    const release = () => {
      if (this.reading === read) this.reading = undefined;
    };
    void read.then(release, release);
    return read;
  }
  async execute(cmd: DemoCommand) {
    // Invalidate reads issued before this operation, including focus/menu refreshes.
    ++this.issued;
    this.reading = undefined;
    try {
      await this.bridge.demoExecute(cmd);
    } catch (e) {
      await this.refresh(true).catch(() => {});
      throw e;
    }
    await this.refresh(true);
  }
  showFor(key: string | null) {
    return key === null
      ? undefined
      : this.state?.shows.find((s) => demoScopeKey(s.scope) === key);
  }
  start(scope: ScopeRef, engine?: "system"): Promise<void> {
    const key = demoScopeKey(scope),
      prior = this.starting.get(key);
    if (prior) return prior;
    const op = this.execute({
      action: "open",
      scope,
      ...(engine ? { engine } : {}),
    })
      .then(() => {
        if (!this.showFor(key))
          throw Error(msg("workspace.couldNotConfirmDemonstrationStartup"));
      })
      .finally(() => {
        this.starting.delete(key);
        this.notify();
      });
    this.starting.set(key, op);
    this.notify();
    return op;
  }
}
const stores = new WeakMap<Window["goga"], DemoDirectory>();
export function demoDirectory(bridge = window.goga) {
  let store = stores.get(bridge);
  if (!store) {
    store = new DemoDirectory(bridge);
    stores.set(bridge, store);
  }
  return store;
}
export function useDemoValue<T>(store: DemoDirectory, read: () => T) {
  return useSyncExternalStore(store.subscribe, read);
}
export function useDemoMonitor(
  store: DemoDirectory,
  enabled: boolean,
  viewing: boolean,
) {
  const active = useDemoValue(store, () => !!store.state?.shows.length);
  useEffect(() => {
    if (!enabled || !store.available) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      running = false;
    const poll = async () => {
      if (stopped || running || document.hidden) return;
      clearTimeout(timer);
      running = true;
      try {
        await store.refresh();
      } catch {
        /* The owning view reports the host error. */
      } finally {
        running = false;
        if (!stopped && active && !document.hidden)
          timer = setTimeout(poll, viewing ? 900 : 2200);
      }
    };
    void poll();
    const wake = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [store, enabled, active, viewing]);
}
