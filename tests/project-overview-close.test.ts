import { expect, it, vi } from "vitest";
import { OverviewExitGuard } from "../src/main/overview-close";
it("does not permit exit while a file write is busy and cancels dirty exit by default", async () => {
  const confirm = vi.fn(async () => false);
  const guard = new OverviewExitGuard(confirm);
  guard.update(["main.go"], true);
  expect(await guard.beforeClose()).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  guard.update(["main.go"], false);
  expect(await guard.beforeClose()).toBe(false);
  expect(confirm).toHaveBeenCalledWith(["main.go"]);
});
it("requires explicit consent and refuses changed state after consent", async () => {
  const guard = new OverviewExitGuard(async () => true);
  guard.update(["a"], false);
  expect(await guard.beforeClose()).toBe(true);
  expect(() => guard.validate()).not.toThrow();
  guard.update(["a", "b"], false);
  expect(() => guard.validate()).toThrow();
});
it("does not consume consent if state changes while the dialog is open", async () => {
  let resolve!: (v: boolean) => void;
  const guard = new OverviewExitGuard(() => new Promise((r) => (resolve = r)));
  guard.update(["a"], false);
  const p = guard.beforeClose();
  guard.update(["a", "b"], false);
  resolve(true);
  expect(await p).toBe(false);
});
