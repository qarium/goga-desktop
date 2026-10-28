import { afterEach, beforeEach, vi } from "vitest";
import { FixtureScope, gitIntegrationBudget } from "./git-integration";

/** One synthetic repository lifetime per test. A timed-out body is still a
 * pending promise: drain it before removing files or restoring shared spies. */
export function installGitFixtureScope() {
  let scope: FixtureScope;
  beforeEach(() => {
    if (scope && !scope.settled)
      throw Error("Previous Git fixture has not settled");
    scope = new FixtureScope();
  });
  afterEach(async () => {
    try {
      await scope.close(gitIntegrationBudget(10000));
    } finally {
      if (scope.settled) vi.restoreAllMocks();
    }
  }, gitIntegrationBudget(15000));
  return Object.assign(() => scope, {
    runner<T extends { dispose(): Promise<void> }>(runner: T): T {
      scope.cancelOnTimeout(() => runner.dispose());
      return scope.own(runner);
    },
    run<A extends unknown[], R>(body: (...args: A) => R | Promise<R>) {
      return (...args: A) =>
        scope.track(Promise.resolve().then(() => body(...args)));
    },
  });
}
