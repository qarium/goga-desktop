import { t as msg } from "../shared/i18n";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import type { GitWorkspaceSummary } from "../shared/git-workspace";
import { documentScopeId } from "./settings-documents";
import { readWithSettlement } from "./read-request";
import { preparationErrorMessage } from "./preparation-error";

const summarySchema = z
  .object({
    scope: scopeRefSchema,
    repository: z.literal("missing").optional(),
    branch: z.string().nullable(),
    changedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    conflicts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((s) => s.conflicts <= s.changedFiles)
  .refine(
    (s) =>
      s.repository !== "missing" ||
      (typeof s.scope === "string" &&
        s.branch === null &&
        s.changedFiles === 0 &&
        s.conflicts === 0),
  );

export interface GitSummaryState {
  lastGood?: GitWorkspaceSummary;
  checkedAt?: number;
  loading: boolean;
  stale: boolean;
  error?: string;
}
type Reason = "visible" | "focus" | "manual" | "active-poll";
type Reader = (
  signal: AbortSignal,
  scope: ScopeRef,
) => Promise<unknown> | { result: Promise<unknown>; settled: Promise<void> };
type Job = {
  generation: number;
  done: Promise<void>;
  resolve: () => void;
  foreground: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};
type Entry = {
  scope: ScopeRef;
  state: GitSummaryState;
  generation: number;
  listeners: Set<() => void>;
  flight?: Job;
  queued?: Job;
};
const EMPTY: GitSummaryState = Object.freeze({ loading: false, stale: true });
const FRESH_MS = 30000;
/** Display-only, shared by all subscribers of one Desktop bridge; never used to authorize a write. */
export class GitSummaryCache {
  private readonly entries = new Map<string, Entry>();
  private active = 0;
  constructor(
    private readonly read: Reader = (signal, scope) =>
      readWithSettlement(signal, "readGitSummary", scope),
  ) {}
  private entry(scope: ScopeRef) {
    const key = documentScopeId(scope);
    let entry = this.entries.get(key);
    if (!entry)
      entry = { scope, state: EMPTY, generation: 0, listeners: new Set() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }
  private trim() {
    const idle = [...this.entries].filter(
      ([, e]) => !e.listeners.size && !e.queued && !e.flight,
    );
    for (const [key] of idle.slice(0, Math.max(0, idle.length - 64)))
      this.entries.delete(key);
  }
  private publish(e: Entry, state: GitSummaryState) {
    e.state = state;
    e.listeners.forEach((fn) => fn());
  }
  getSnapshot(scope: ScopeRef) {
    return this.entries.get(documentScopeId(scope))?.state ?? EMPTY;
  }
  subscribe(scope: ScopeRef, fn: () => void) {
    const e = this.entry(scope);
    e.listeners.add(fn);
    return () => {
      e.listeners.delete(fn);
      if (!e.listeners.size) {
        this.cancel(e);
        this.trim();
      }
    };
  }
  private cancel(e: Entry) {
    if (!e.flight && !e.queued) return;
    e.generation++;
    clearTimeout(e.queued?.timer);
    e.queued?.resolve();
    e.queued = undefined;
    e.flight?.controller.abort();
    this.publish(e, { ...e.state, loading: false, stale: true });
  }
  invalidate(scope: ScopeRef, discardPrevious = false) {
    const e = this.entries.get(documentScopeId(scope));
    if (!e) return;
    this.cancel(e);
    this.publish(e, discardPrevious ? EMPTY : { ...e.state, stale: true });
    // A single workspace action can invalidate several related views synchronously.
    // Drop old data immediately, but start at most one follow-up request.
    if (e.listeners.size)
      queueMicrotask(() => {
        if (e.listeners.size && e.state.stale)
          void this.ensure(e.scope, "visible");
      });
  }
  invalidateAll() {
    for (const e of [...this.entries.values()]) this.invalidate(e.scope);
  }
  ensure(scope: ScopeRef, reason: Reason): Promise<void> {
    const e = this.entry(scope);
    if (!e.listeners.size) {
      this.trim();
      return Promise.resolve();
    }
    const foreground = reason === "active-poll";
    if (e.queued) {
      if (foreground) e.queued.foreground = true;
      return e.queued.done;
    }
    if (e.flight && e.flight.generation === e.generation) return e.flight.done;
    if (
      !foreground &&
      reason !== "manual" &&
      !e.state.stale &&
      e.state.checkedAt !== undefined &&
      Date.now() - e.state.checkedAt < FRESH_MS
    )
      return Promise.resolve();
    let resolve!: () => void;
    const done = new Promise<void>((ok) => {
      resolve = ok;
    });
    e.queued = {
      generation: e.generation,
      foreground,
      done,
      resolve,
      controller: new AbortController(),
    };
    const job = e.queued;
    // A broken transport may ignore cancellation; don't leave waiting cards in a perpetual loader.
    job.timer = setTimeout(() => {
      if (e.queued !== job) return;
      e.queued = undefined;
      job.resolve();
      this.publish(e, {
        ...e.state,
        stale: true,
        loading: false,
        error: msg("git.previousGitReadsAreStillRunningTryAgainLater"),
      });
      this.trim();
    }, FRESH_MS);
    this.publish(e, { ...e.state, loading: true });
    this.drain();
    return done;
  }
  private drain() {
    while (this.active < 2) {
      const ready = [...this.entries.values()].filter(
        (e) => e.queued && !e.flight,
      );
      const e = ready.find((e) => e.queued?.foreground) ?? ready[0];
      if (!e) break;
      const job = e.queued!;
      clearTimeout(job.timer);
      e.queued = undefined;
      e.flight = job;
      this.active++;
      void this.run(e, job);
    }
  }
  private async run(e: Entry, job: Job) {
    let physical: Promise<void> | undefined;
    try {
      const request = this.read(job.controller.signal, e.scope);
      physical = "settled" in request ? request.settled : undefined;
      const value = summarySchema.parse(
        await ("result" in request ? request.result : request),
      );
      if (documentScopeId(value.scope) !== documentScopeId(e.scope))
        throw Error(msg("git.theSummaryBelongsToAnotherWorkspace"));
      if (job.generation === e.generation && !job.controller.signal.aborted)
        this.publish(e, {
          lastGood: value,
          checkedAt: Date.now(),
          loading: false,
          stale: false,
        });
    } catch (error) {
      if (job.generation === e.generation && !job.controller.signal.aborted)
        this.publish(e, {
          ...e.state,
          loading: false,
          stale: true,
          error: preparationErrorMessage(error),
        });
    } finally {
      e.flight = undefined;
      job.resolve();
      const release = () => {
        this.active--;
        this.drain();
        this.trim();
      };
      if (physical) void physical.then(release, release);
      else release();
    }
  }
  dispose() {
    for (const e of this.entries.values()) {
      e.listeners.clear();
      this.cancel(e);
    }
    this.entries.clear();
  }
}
const caches = new WeakMap<object, GitSummaryCache>();
export function gitSummaryCacheFor(bridge: object) {
  let cache = caches.get(bridge);
  if (!cache) {
    cache = new GitSummaryCache();
    caches.set(bridge, cache);
  }
  return cache;
}
