import { useMemo, useSyncExternalStore } from "react";
import type { DesktopAPI } from "../shared/bridge";
import type { ContextSyncState } from "../shared/context-sync";
import type { TopicContextRef, WorktreeRecord } from "../shared/worktrees";
import { contextRef, contextRequestKey } from "./topic-context";
import { readRequest } from "./read-request";

export const contextSyncLabels = {
  // Host `new` is also the default before any import; it does not prove newly authored commits.
  new: "Ещё не синхронизировано",
  waiting: "Ожидает завершения запуска",
  syncing: "Синхронизация…",
  synced: "Синхронизировано",
  error: "Ошибка синхронизации",
};
export interface TopicSyncSnapshot {
  state: ContextSyncState | null;
  error: string;
  busy: boolean;
  checking: boolean;
  failedAction: boolean;
}
const empty: TopicSyncSnapshot = {
  state: null,
  error: "",
  busy: false,
  checking: false,
  failedAction: false,
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function assertSyncOwner(
  owner: TopicContextRef,
  value: Pick<ContextSyncState, "projectId" | "contextId" | "revision">,
) {
  if (
    !value ||
    value.projectId !== owner.projectId ||
    value.contextId !== owner.contextId ||
    value.revision !== owner.revision
  )
    throw Error(
      "Ответ синхронизации относится к другой рабочей копии или её ревизии.",
    );
}
/** Eligibility is host-issued inventory only. Never ensure, restore, or guess a copy. */
export function topicSyncUnavailable(record?: WorktreeRecord | null): string {
  if (!record) return "Рабочая копия ещё не создана. Переносить пока нечего";
  if (
    record.compatibility === "legacy-linked" ||
    record.storageKind === "linked"
  )
    return "Рабочая копия прежнего формата. Для переноса нужен подтверждённый автономный клон.";
  if (record.deletedAt || record.state === "missing")
    return "Рабочая копия недоступна. Её отсутствие не означает, что она не создавалась.";
  if (record.state !== "ready")
    return "Рабочая копия не прошла проверку. Перенос недоступен.";
  if (record.preparation)
    return "Подготовка рабочей копии не завершена. Перенос недоступен.";
  if (record.storageKind !== "clone" || record.ownership !== "managed")
    return "Автономный управляемый клон не подтверждён. Перенос недоступен.";
  return "";
}
export function topicSyncLabel(snapshot: TopicSyncSnapshot): string {
  if (snapshot.busy) return contextSyncLabels.syncing;
  if (snapshot.error)
    return snapshot.failedAction
      ? contextSyncLabels.error
      : "Статус недоступен";
  return snapshot.state
    ? contextSyncLabels[snapshot.state.status]
    : "Читаем состояние синхронизации…";
}
export function topicSyncPending(snapshot: TopicSyncSnapshot): boolean {
  return (
    snapshot.busy ||
    snapshot.state?.status === "syncing" ||
    snapshot.state?.status === "waiting"
  );
}

class ObsoleteSyncRead extends Error {}
interface QueuedSyncRead {
  current: () => boolean;
  invoke: () => Promise<ContextSyncState>;
  resolve: (state: ContextSyncState) => void;
  reject: (error: unknown) => void;
}
/** Status inventory must not consume the global read budget needed by other UI.
 * Slots follow readRequest settlement, including its existing deadline semantics;
 * no detached timer or UI cancellation releases a dispatched slot early.
 */
class TopicSyncReadScheduler {
  private active = 0;
  private queue: QueuedSyncRead[] = [];
  read(
    current: () => boolean,
    invoke: () => Promise<ContextSyncState>,
  ): Promise<ContextSyncState> {
    return new Promise((resolve, reject) => {
      this.queue.push({ current, invoke, resolve, reject });
      this.drain();
    });
  }
  prune() {
    this.queue = this.queue.filter((job) => {
      if (job.current()) return true;
      job.reject(new ObsoleteSyncRead("Чтение состояния больше не требуется."));
      return false;
    });
    this.drain();
  }
  private drain() {
    while (this.active < 4 && this.queue.length) {
      const job = this.queue.shift()!;
      if (!job.current()) {
        job.reject(
          new ObsoleteSyncRead("Чтение состояния больше не требуется."),
        );
        continue;
      }
      this.active++;
      let pending: Promise<ContextSyncState>;
      try {
        pending = job.invoke();
      } catch (error) {
        pending = Promise.reject(error);
      }
      void pending.then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
const readSchedulers = new WeakMap<DesktopAPI, TopicSyncReadScheduler>();
function readSchedulerFor(api: DesktopAPI) {
  let scheduler = readSchedulers.get(api);
  if (!scheduler) {
    scheduler = new TopicSyncReadScheduler();
    readSchedulers.set(api, scheduler);
  }
  return scheduler;
}

/** One controller per exact host-issued ref and API. Component closures never own import state. */
class TopicSyncController {
  private snapshot: TopicSyncSnapshot = empty;
  private listeners = new Set<() => void>();
  private generation = 0;
  private readFlight: Promise<void> | null = null;
  private writeFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private api: DesktopAPI,
    private owner: TopicContextRef,
  ) {}
  getSnapshot = () => this.snapshot;
  private readStatus(generation: number, explicitRetry = false) {
    return readSchedulerFor(this.api).read(
      () =>
        (this.listeners.size > 0 ||
          (explicitRetry && this.writeFlight !== null)) &&
        generation === this.generation &&
        window.goga === this.api,
      () => readRequest("topicSyncStatus", this.owner),
    );
  }
  private update(next: Partial<TopicSyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.listeners.size)
      this.timer = setTimeout(() => void this.refresh(), 3000);
  }
  subscribe = (listener: () => void) => {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first) {
      // A reopened surface must read durable host state, not show a cached check mark.
      this.update({
        state: null,
        error: "",
        checking: true,
        failedAction: false,
      });
      if (!this.writeFlight) void this.refresh(true);
    } else {
      // A newly opened card also refreshes while another surface is observing.
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        // Invalidate reads only. Imports are physically alive and remain deduplicated.
        if (!this.writeFlight) this.generation++;
        readSchedulerFor(this.api).prune();
      }
    };
  };
  refresh = (fresh = false): Promise<void> => {
    if (this.writeFlight) return this.writeFlight;
    if (this.readFlight && !fresh) return this.readFlight;
    const generation = ++this.generation;
    readSchedulerFor(this.api).prune();
    this.update({ checking: true });
    const flight = (async () => {
      try {
        // Keep existing global read deadlines and physical-call guard behind a
        // small shared status queue; stale queued owners never reach the bridge.
        const next = await this.readStatus(generation);
        if (generation !== this.generation) return;
        assertSyncOwner(this.owner, next);
        this.update({ state: next, error: "", failedAction: false });
      } catch (error) {
        if (
          generation === this.generation &&
          !(error instanceof ObsoleteSyncRead)
        )
          this.update({ error: message(error), failedAction: false });
      } finally {
        if (generation === this.generation) this.update({ checking: false });
      }
    })();
    this.readFlight = flight;
    void flight.finally(() => {
      if (this.readFlight === flight) this.readFlight = null;
      if (generation === this.generation) this.schedule();
    });
    return flight;
  };
  sync = (): Promise<void> => {
    if (this.writeFlight) return this.writeFlight;
    if (topicSyncPending(this.snapshot)) return Promise.resolve();
    clearTimeout(this.timer);
    const failedAction = this.snapshot.failedAction;
    let retry = this.snapshot.state?.status === "error";
    const generation = ++this.generation;
    readSchedulerFor(this.api).prune();
    this.update({
      busy: true,
      checking: false,
      error: "",
      failedAction: false,
    });
    const flight = (async () => {
      try {
        // Defer dispatch so even a synchronous bridge throw cannot wedge writeFlight.
        await Promise.resolve();
        if (failedAction) {
          if (window.goga !== this.api) return;
          // This read continues an explicit retry, not background observation.
          // Closing the popup never cancels the captured-owner import intent.
          const persisted = await this.readStatus(generation, true);
          if (generation !== this.generation) return;
          assertSyncOwner(this.owner, persisted);
          this.update({ state: persisted });
          // Transport/pre-journal failures are not recorded imports to retry.
          retry = persisted.status === "error";
          if (persisted.status === "waiting" || persisted.status === "syncing")
            return;
        }
        const next = await (retry
          ? this.api.retryContextSync(this.owner)
          : this.api.syncTopicContext(this.owner));
        assertSyncOwner(this.owner, next);
        if (generation === this.generation)
          this.update({ state: next, error: "" });
      } catch (error) {
        if (
          generation === this.generation &&
          !(error instanceof ObsoleteSyncRead)
        )
          this.update({ error: message(error), failedAction: true });
      } finally {
        this.writeFlight = null;
        if (generation === this.generation) this.update({ busy: false });
        this.schedule();
      }
    })();
    this.writeFlight = flight;
    return flight;
  };
}
const controllers = new WeakMap<DesktopAPI, Map<string, TopicSyncController>>();
function controllerFor(api: DesktopAPI, owner: TopicContextRef) {
  let refs = controllers.get(api);
  if (!refs) {
    refs = new Map();
    controllers.set(api, refs);
  }
  const key = contextRequestKey(owner);
  let controller = refs.get(key);
  if (!controller) {
    controller = new TopicSyncController(api, contextRef(owner));
    refs.set(key, controller);
  }
  return controller;
}
const inactive = {
  subscribe: () => () => {},
  getSnapshot: () => empty,
  refresh: async () => {},
  sync: async () => {},
};
export function useTopicSync(owner: TopicContextRef | null) {
  const api = window.goga;
  const key = owner ? contextRequestKey(owner) : "";
  const controller = useMemo(
    () => (owner ? controllerFor(api, owner) : inactive),
    [api, key],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { ...snapshot, sync: controller.sync, refresh: controller.refresh };
}
