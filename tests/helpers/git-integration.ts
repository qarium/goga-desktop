import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import type { TopicContextRef } from "../../src/shared/worktrees";

/** Opt-in only in the five Git-heavy suites measured on the native Intel runner. */
export function gitIntegrationBudget(
  baseMs: number,
  profile = process.env.GOGA_TEST_PROFILE ?? "default",
): number {
  if (profile !== "default" && profile !== "slow-git")
    throw Error(`Unknown Git integration test profile: ${profile}`);
  return baseMs * (profile === "slow-git" ? 3 : 1);
}

const activeScope = new AsyncLocalStorage<FixtureScope>();

/** Owns only synthetic fixture work; close it BEFORE restoring prototype mocks. */
export class FixtureScope {
  private cleanups: (() => unknown | Promise<unknown>)[] = [];
  private releases: (() => void)[] = [];
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private closed?: Promise<void>;
  private controller = new AbortController();
  private cancellations: (() => unknown | Promise<unknown>)[] = [];
  private cancelling?: Promise<PromiseSettledResult<unknown>[]>;
  settled = false;
  get signal() {
    return this.controller.signal;
  }
  cancelOnTimeout(action: () => unknown | Promise<unknown>) {
    this.cancellations.push(action);
  }

  cleanup(action: () => unknown | Promise<unknown>) {
    this.cleanups.push(action);
  }
  releaseOnCleanup(action: () => void) {
    this.releases.push(action);
  }
  track<T>(promise: Promise<T>): Promise<T> {
    if (this.settled) {
      // The caller already constructed this promise; observe rejection even
      // though a closed fixture must never adopt it or start new owned work.
      void promise.catch(() => {});
      throw Error("Test fixture is closed");
    }
    this.pending.add(promise);
    // Observe rejection immediately without changing the promise's result.
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  own<T extends object>(value: T): T {
    return new Proxy(value, {
      get: (target, key) => {
        const member = Reflect.get(target, key);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (
            this.settled ||
            this.signal.aborted ||
            (this.closing && activeScope.getStore() !== this)
          )
            throw Error("Test fixture is closed");
          const result = activeScope.run(this, () =>
            Reflect.apply(member, target, args),
          );
          return result instanceof Promise ? this.track(result) : result;
        };
      },
    });
  }
  close(timeoutMs = 10000): Promise<void> {
    return (this.closed ??= this.boundedFinish(timeoutMs));
  }
  private async boundedFinish(timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = this.finish().finally(async () => {
      await this.cancelling;
      this.settled = true;
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(Error("Fixture work did not settle before cleanup deadline")),
        timeoutMs,
      );
    });
    try {
      await Promise.race([finished, timeout]);
    } catch (error) {
      if (!this.settled) {
        // Install the cancellation barrier before abort synchronously rejects
        // commands, otherwise their drain could race ahead to root removal.
        this.cancelling = Promise.allSettled(
          this.cancellations.map((cancel) => Promise.resolve().then(cancel)),
        );
        this.controller.abort();
        // Give abortable children a bounded chance to release locks. If they do
        // not, retain their roots and fail closed instead of starting a new fixture.
        let grace: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([finished, this.cancelling]),
            new Promise<void>((resolve) => {
              grace = setTimeout(resolve, Math.min(timeoutMs, 2000));
            }),
          ]);
        } finally {
          clearTimeout(grace);
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private async finish() {
    this.closing = true;
    const errors: unknown[] = [];
    for (const release of this.releases.splice(0)) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }
    // A delayed operation may spawn another tracked operation before settling.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      await this.cancelling;
      try {
        await activeScope.run(this, cleanup);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Fixture cleanup failed");
  }
}

/** Opening is persistent: concurrent and not-yet-entered synthetic kills cannot lose it. */
export class PauseGate {
  private waiters = new Set<() => void>();
  private paused = false;
  pause() {
    this.paused = true;
  }
  async wait() {
    if (this.paused)
      await new Promise<void>((resolve) => this.waiters.add(resolve));
  }
  release() {
    this.paused = false;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

export function hasRunSyncCall(
  calls: readonly unknown[][],
  projectPath: string,
  ref: TopicContextRef,
  runId: string,
): boolean {
  return calls.some(
    ([project, owner, id]) =>
      (project as { path?: string } | undefined)?.path === projectPath &&
      id === runId &&
      (Object.keys(ref) as (keyof TopicContextRef)[]).every(
        (key) => (owner as TopicContextRef | undefined)?.[key] === ref[key],
      ),
  );
}

/** execFile's AbortError callback is not proof that the child has exited. */
export async function awaitCommandClose<T>(
  command: Promise<T> & {
    child: { once(event: string, listener: () => void): unknown };
  },
): Promise<T> {
  const closed = new Promise<void>((resolve) =>
    command.child.once("close", resolve),
  );
  try {
    return await command;
  } finally {
    await closed;
  }
}

const exec = promisify(execFile);
/** Test-only Git fixture transport, preserving errors until real child close. */
export function fixtureExecFile(
  file: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, "encoding">,
): Promise<{ stdout: string; stderr: string }> {
  return awaitCommandClose(exec(file, args, { ...options, encoding: "utf8" }));
}
