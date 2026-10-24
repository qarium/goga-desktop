import { expect, it, vi } from "vitest";
import { NodeRunner } from "../src/host/process";
it("failed cleanup waits for every owned stop, then permits retry instead of leaving runner closed", async () => {
  const runner = new NodeRunner();
  const one = {} as any,
    two = {} as any;
  (runner as any).children.add(one);
  (runner as any).children.add(two);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const kill = vi.spyOn(runner, "kill").mockImplementation(async (child) => {
    if (child === one) throw Error("synthetic failure");
    await waiting;
  });
  let settled = false;
  const attempt = runner.dispose().catch(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  finish();
  await attempt;
  expect((runner as any).closing).toBe(false);
  expect((runner as any).children.has(one)).toBe(true);
  kill.mockRestore();
  (runner as any).children.clear();
  expect(
    (
      await runner.command(
        process.execPath,
        ["-e", "process.stdout.write('alive')"],
        "/private/tmp",
      )
    ).stdout,
  ).toBe("alive");
  await runner.dispose();
  expect(() => runner.start(process.execPath, [], "/private/tmp")).toThrow();
});
