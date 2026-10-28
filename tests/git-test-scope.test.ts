import { expect, it, vi } from "vitest";
import { installGitFixtureScope } from "./helpers/git-test-scope";
import type { FixtureScope } from "./helpers/git-integration";

const current = installGitFixtureScope();
const service = { read: () => "original" };
const events: string[] = [];
let previous: FixtureScope;

it("drains the complete pending scenario before cleanup and restores spies only afterwards", () => {
  previous = current();
  vi.spyOn(service, "read").mockReturnValue("fixture");
  current().cleanup(() => {
    expect(service.read()).toBe("fixture");
    events.push("cleanup");
  });
  // Deliberately leave tracked work for afterEach, as a timed-out body would.
  void current().track(
    (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(service.read()).toBe("fixture");
      events.push("body settled");
    })(),
  );
});

it("starts the next scenario with a new scope only after the previous one settled", () => {
  expect(previous.settled).toBe(true);
  expect(current()).not.toBe(previous);
  expect(current().settled).toBe(false);
  expect(events).toEqual(["body settled", "cleanup"]);
  expect(service.read()).toBe("original");
});
